import type {
	ApplicableAssessment,
	ApplyPolicy,
	ApplyResult,
	CompareOutcome,
	ModelIR,
	ObservationContext,
	OutcomeReason,
	PhysicalOperation,
	PlanAssessment,
	ProofObligation,
	ResourceAddress,
	SemanticArtifactRef,
	StepJournal,
	TransitionCandidate,
	TransitionLessor,
} from '@dbsp/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestTransitionLessor } from './__fixtures__/transition-lessor.js';
import { claimId, semanticArtifactId } from './ids.js';
import type { PackRegistry } from './registry.js';

const mocks = vi.hoisted(() => ({
	artifact: {
		id: 'dbsp.test.staged-orchestrator' as SemanticArtifactRef['id'],
		version: '0.1.0',
	},
	apply: vi.fn(),
	chooseReadyCandidate: vi.fn(),
	compare: vi.fn(),
	preflightStagedComposition: vi.fn(),
	projectCompareToSingleCandidate: vi.fn(),
	prove: vi.fn(),
}));

vi.mock('./comparator.js', () => ({
	createComparator: () => ({
		artifact: mocks.artifact,
		compare: mocks.compare,
	}),
}));

vi.mock('./prover.js', () => ({
	createProver: () => ({
		artifact: mocks.artifact,
		prove: mocks.prove,
	}),
}));

vi.mock('./applier.js', () => ({
	createApplier: () => ({
		artifact: mocks.artifact,
		apply: mocks.apply,
	}),
}));

vi.mock('./staging.js', () => ({
	chooseReadyCandidate: mocks.chooseReadyCandidate,
	preflightStagedComposition: mocks.preflightStagedComposition,
	projectCompareToSingleCandidate: mocks.projectCompareToSingleCandidate,
}));

import { createStagedTransitionOrchestrator } from './staged-orchestrator.js';

const artifact: SemanticArtifactRef = {
	id: semanticArtifactId('dbsp.test.staged-orchestrator'),
	version: '0.1.0',
};

const resource: ResourceAddress = {
	engine: 'postgresql',
	database: 'test',
	schema: 'public',
	kind: 'table',
	name: 'events',
};

const desired = {} as ModelIR;

const target: TransitionLessor = createTestTransitionLessor(async () => ({
	query: async () => ({ rows: [] }),
	release: () => undefined,
}));

const policy: ApplyPolicy = { accepts: [] };

const persister = { persist: async (): Promise<void> => undefined };

function context(label: string): ObservationContext {
	return {
		engine: 'postgresql',
		engineVersion: '18',
		databaseId: label,
		capabilities: [],
		privileges: [],
		sessionConfiguration: {},
		extensions: {},
	};
}

function operation(ref: string): PhysicalOperation {
	return {
		ref,
		operationKind: { artifact, name: 'MockOperation' },
		payload: { ref },
	};
}

function obligation(ref: string): ProofObligation {
	return {
		proposition: {
			kind: `mock.${ref}.ready`,
			scope: [resource],
			detail: { ref },
		},
		scope: [resource],
		dischargeableBy: [
			{
				kind: `mock.${ref}.ready`,
				scope: [resource],
				detail: { ref },
			},
		],
	};
}

function candidate(ref: string): TransitionCandidate<{ readonly ref: string }> {
	const ready = obligation(ref);
	return {
		rule: { id: `mock.${ref}`, pack: artifact },
		match: { ref },
		requiredObservations: ready.dischargeableBy ?? [],
		obligations: [ready],
		selectionRationale: {
			chosen: { id: `mock.${ref}`, pack: artifact },
			overRules: [],
			why: 'test candidate',
		},
	};
}

function transitionsFor(
	ref: string,
): Extract<CompareOutcome, { readonly kind: 'transitions' }> {
	const entry = candidate(ref);
	return {
		kind: 'transitions',
		candidates: [entry],
		obligations: entry.obligations,
	};
}

function unknownCompare(): Extract<
	CompareOutcome,
	{ readonly kind: 'unknown' }
> {
	const pending = obligation('check-deparse');
	return {
		kind: 'unknown',
		recognitions: [
			{
				rule: { id: 'mock.check', pack: artifact },
				desired,
				current: {} as ModelIR,
				obligations: [pending],
			},
		],
		obligations: [pending],
	};
}

function applicableAssessment(lifecycle = 'planned'): ApplicableAssessment {
	return {
		decision: 'applicable',
		assurance: 'established',
		lifecycle: lifecycle as ApplicableAssessment['lifecycle'],
		continuation: 'none',
		reasons: [
			{
				code: 'proven-applicable',
				claim: claimId('dbsp.test.staged-orchestrator.claim'),
				scope: [],
			},
		],
	};
}

function blockedAssessment(detail: string): PlanAssessment {
	return {
		decision: 'blocked',
		assurance: 'unproven',
		lifecycle: 'planned',
		continuation: 'replan-required',
		reasons: [
			{
				code: 'insufficient-evidence',
				obligation: obligation('convergence'),
				scope: [resource],
				detail,
			},
		],
	};
}

function completedJournal(ref: string): StepJournal {
	const op = operation(ref);
	return {
		intent: {
			stepId: `step:${ref}`,
			operation: op,
			recordedAt: '2026-07-17T00:00:00.000Z',
		},
		outcome: 'completed',
		transactionalCompletion: {
			stepId: `step:${ref}`,
			committedWithDdl: true,
			recordedAt: '2026-07-17T00:00:01.000Z',
		},
	};
}

function completedApplyResult(ref: string): ApplyResult {
	return {
		assessment: applicableAssessment('completed'),
		journals: [completedJournal(ref)],
		observations: [],
	};
}

function provenOutcome(ref: string) {
	return {
		kind: 'proven',
		plan: {
			observations: [],
			claims: [],
			assumptions: [],
			preconditions: [],
			segments: [],
			steps: [],
			postconditions: [],
		},
		assessment: applicableAssessment(),
		ref,
	};
}

async function runConvergenceScenario(convergenceProof: unknown) {
	const first = transitionsFor('enum-add');
	const second = transitionsFor('add-check');
	const unknown = unknownCompare();
	const convergenceContext = context('after-apply-convergence');
	const loadCurrent = vi
		.fn()
		.mockResolvedValueOnce({} as ModelIR)
		.mockResolvedValueOnce({} as ModelIR)
		.mockResolvedValueOnce({} as ModelIR);
	const readContext = vi
		.fn()
		.mockResolvedValueOnce(context('before-enum-add'))
		.mockResolvedValueOnce(context('before-add-check'))
		.mockResolvedValueOnce(convergenceContext);

	mocks.compare
		.mockReturnValueOnce(first)
		.mockReturnValueOnce(second)
		.mockReturnValueOnce(unknown);
	mocks.prove
		.mockResolvedValueOnce(provenOutcome('enum-add'))
		.mockResolvedValueOnce(provenOutcome('add-check'))
		.mockResolvedValueOnce(convergenceProof);
	mocks.apply
		.mockResolvedValueOnce(completedApplyResult('enum-add'))
		.mockResolvedValueOnce(completedApplyResult('add-check'));

	const result = await createStagedTransitionOrchestrator(
		{} as PackRegistry,
		persister,
	).applyStagedTransition({
		desired,
		loadCurrent,
		readContext,
		target,
		policy,
	});

	return { convergenceContext, result, unknown };
}

describe('staged transition orchestrator convergence', () => {
	beforeEach(() => {
		mocks.apply.mockReset();
		mocks.chooseReadyCandidate.mockReset();
		mocks.compare.mockReset();
		mocks.preflightStagedComposition.mockReset();
		mocks.projectCompareToSingleCandidate.mockReset();
		mocks.prove.mockReset();

		mocks.preflightStagedComposition.mockImplementation(
			(_registry: unknown, input: { readonly compare: CompareOutcome }) => {
				if (input.compare.kind !== 'transitions') {
					throw new Error('test preflight expected transitions');
				}
				const ready = input.compare.candidates[0];
				if (!ready) {
					throw new Error('test preflight expected a candidate');
				}
				return {
					kind: 'provable-in-stages',
					ready: [{ candidate: ready, opRefs: [(ready.match as any).ref] }],
					pending: [],
				};
			},
		);
		mocks.chooseReadyCandidate.mockImplementation(
			(preflight: { readonly ready: readonly unknown[] }) => preflight.ready[0],
		);
		mocks.projectCompareToSingleCandidate.mockImplementation(
			(
				_compare: CompareOutcome,
				entry: { readonly candidate: TransitionCandidate },
			) => ({
				kind: 'transitions',
				candidates: [entry.candidate],
				obligations: entry.candidate.obligations,
			}),
		);
	});

	it('reports convergence before validating an unused target', async () => {
		const readContext = vi.fn(async () => context('converged'));
		const loadCurrent = vi.fn(async () => desired);
		const checkedOutClient = {
			connect: vi.fn(),
			query: vi.fn(),
			release: vi.fn(),
		};
		mocks.compare.mockReturnValue({ kind: 'no-drift' });

		const result = await createStagedTransitionOrchestrator(
			{} as PackRegistry,
			persister,
		).applyStagedTransition({
			desired,
			loadCurrent,
			readContext,
			target: checkedOutClient as never,
			policy,
		});

		expect(result.assessment).toMatchObject({
			decision: 'applicable',
			lifecycle: 'completed',
			continuation: 'none',
		});
		expect(checkedOutClient.connect).not.toHaveBeenCalled();
		expect(readContext).toHaveBeenCalledOnce();
		expect(loadCurrent).toHaveBeenCalledOnce();
	});

	it('leaves unrelated prover failures as exceptions', async () => {
		mocks.compare.mockReturnValue(transitionsFor('enum-add'));
		const failure = new Error('prover failed');
		mocks.prove.mockRejectedValue(failure);

		await expect(
			createStagedTransitionOrchestrator(
				{} as PackRegistry,
				persister,
			).applyStagedTransition({
				desired,
				loadCurrent: async () => desired,
				readContext: async () => context('prover-failure'),
				target,
				policy,
			}),
		).rejects.toBe(failure);
	});

	it('returns applicable when post-apply unknown convergence is proven no-drift', async () => {
		const noDriftProof = {
			kind: 'no-drift',
			claim: {},
			assessment: applicableAssessment(),
		};

		const { convergenceContext, result, unknown } =
			await runConvergenceScenario(noDriftProof);

		expect(result.assessment).toMatchObject({
			decision: 'applicable',
			lifecycle: 'completed',
			continuation: 'none',
		});
		expect(
			result.journals.map((journal) => journal.intent.operation.ref),
		).toEqual(['enum-add', 'add-check']);
		expect(mocks.prove).toHaveBeenCalledTimes(3);
		expect(mocks.prove.mock.calls[2]?.[0]).toBe(unknown);
		expect(mocks.prove.mock.calls[2]?.[2]).toBe(convergenceContext);
	});

	it('aggregates a blocked post-apply unknown convergence proof as resume-possible partial work', async () => {
		const { result } = await runConvergenceScenario({
			kind: 'blocked',
			assessment: blockedAssessment('still missing convergence evidence'),
		});

		expect(result.assessment).toMatchObject({
			decision: 'blocked',
			assurance: 'unproven',
			lifecycle: 'partially-applied',
			continuation: 'resume-possible',
		});
		expect(result.assessment.reasons[0]).toMatchObject({
			code: 'insufficient-evidence',
			detail: 'still missing convergence evidence',
		} satisfies Partial<OutcomeReason>);
		expect(result.journals.map((journal) => journal.outcome)).toEqual([
			'completed',
			'completed',
		]);
	});

	it('fails closed when post-apply unknown convergence proves remaining executable work', async () => {
		const { result } = await runConvergenceScenario(
			provenOutcome('remaining-work'),
		);

		expect(result.assessment).toMatchObject({
			decision: 'blocked',
			assurance: 'unproven',
			lifecycle: 'partially-applied',
			continuation: 'resume-possible',
		});
		expect(result.assessment.reasons[0]).toMatchObject({
			code: 'unsupported-transition',
			detail:
				'post-apply convergence proof returned an executable plan for remaining drift; staged transition orchestration did not recognize a stageable transition candidate',
		});
		expect(mocks.apply).toHaveBeenCalledTimes(2);
	});
});
