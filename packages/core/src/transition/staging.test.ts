import type {
	ApplicableEvaluation,
	Assumption,
	CompareOutcome,
	EnumIR,
	ModelIR,
	ObservationIssuer,
	ObservationRequest,
	OperationEffectAssessment,
	PhysicalOperation,
	ProofObligation,
	SemanticArtifactRef,
	TransitionCandidate,
	TransitionFragmentComposition,
	TransitionRule,
} from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { assumptionId, evidenceId, semanticArtifactId } from './ids.js';
import { createProver } from './prover.js';
import type { RegisteredOperationSemantics } from './registry.js';
import { createPackRegistry } from './registry.js';
import {
	chooseReadyCandidate,
	preflightStagedComposition,
	projectCompareToSingleCandidate,
} from './staging.js';

const ruleArtifact: SemanticArtifactRef = {
	id: semanticArtifactId('dbsp.mock.staging.rules'),
	version: '0.1.0',
};
const operationArtifact: SemanticArtifactRef = {
	id: semanticArtifactId('dbsp.mock.staging.operations'),
	version: '0.1.0',
};

const context = {
	engine: 'postgresql',
	engineVersion: '18',
	databaseId: 'test',
	capabilities: ['mock'],
	privileges: [],
	sessionConfiguration: {},
	extensions: {},
};

const enumLabelFact = {
	kind: 'postgresql.enum-label.visible',
	resource: {
		engine: 'postgresql',
		database: 'model',
		schema: 'tenant',
		kind: 'type',
		name: 'status',
		qualifiedBy: ['enum'],
	},
	detail: { schema: 'tenant', type: 'status', label: 'pending' },
} as const;

function model(labels: readonly string[]): ModelIR {
	const status: EnumIR = {
		name: 'status',
		schema: 'tenant',
		values: labels,
	};
	const enums = new Map([['status', status]]);
	return {
		tables: new Map(),
		relations: new Map(),
		enums,
		getTable: () => undefined,
		getRelation: () => undefined,
		getRelationsFrom: () => [],
		getRelationsTo: () => [],
		isAmbiguous: () => ({ ambiguous: false, options: [] }),
	};
}

function operation(ref: string): PhysicalOperation {
	return {
		ref,
		operationKind: {
			artifact: operationArtifact,
			name: 'MockOperation',
		},
		payload: { ref },
	};
}

function operationAssumption(ref: string): Assumption {
	return {
		id: assumptionId(`dbsp.mock.staging.operation:${ref}`),
		class: 'operation-pack-semantics',
		asserter: { kind: 'pack', artifact: operationArtifact },
		statement: 'mock operation semantics are correct',
		scope: [],
	};
}

function observationRequest(opRef: string): ObservationRequest {
	return {
		kind: `mock.staging.${opRef}.ready`,
		scope: [enumLabelFact.resource],
		detail: { opRef },
	};
}

function obligationForRequest(
	request: ObservationRequest,
	appliesTo?: string,
): ProofObligation {
	const obligation: ProofObligation = {
		proposition: {
			kind: request.kind,
			scope: request.scope,
			detail: request.detail,
		},
		scope: request.scope,
		dischargeableBy: [request],
	};
	return appliesTo ? { ...obligation, appliesTo } : obligation;
}

function rule(
	id: string,
	opRef: string,
	composition: TransitionFragmentComposition | undefined,
): TransitionRule<{ readonly opRef: string }> {
	return {
		id,
		artifact: ruleArtifact,
		support: {
			engine: 'postgresql',
			versions: [{ min: '18' }],
			requiredCapabilities: ['mock'],
		},
		recognize: () => ({ recognized: false }),
		requiredObservations: (match) => [observationRequest(match.opRef)],
		declareComposition: () => composition,
		evaluate: (match): ApplicableEvaluation => ({
			outcome: 'applicable',
			obligations: [obligationForRequest(observationRequest(match.opRef))],
			assumptions: [],
		}),
		generateCandidate: (_match, evaluation) => ({
			generatedBy: { id, pack: ruleArtifact },
			operations: [operation(opRef)],
			...(composition ? { composition } : {}),
			obligations: evaluation.obligations.map((obligation) => ({
				...obligation,
				appliesTo: opRef,
			})),
			assumptions: evaluation.assumptions,
			guards: [],
			selectionRationale: {
				chosen: { id, pack: ruleArtifact },
				overRules: [],
				why: 'test-only staged transition rule',
			},
		}),
	};
}

function producerRule(id = 'mock.enum.add', opRef = 'op:enum') {
	return rule(id, opRef, {
		produces: [
			{
				opRef,
				fact: enumLabelFact,
				available: 'after-commit',
			},
		],
	});
}

function consumerRule() {
	return consumerRuleWithNeed('producer-after-commit');
}

function consumerRuleWithNeed(
	needs: NonNullable<
		TransitionFragmentComposition['requires']
	>[number]['needs'],
) {
	return rule('mock.check.add', 'op:check', {
		requires: [
			{
				opRef: 'op:check',
				fact: enumLabelFact,
				needs,
			},
		],
	});
}

function candidate(
	rule: TransitionRule<{ readonly opRef: string }>,
	opRef: string,
): TransitionCandidate<{ readonly opRef: string }> {
	const requiredObservations = rule.requiredObservations({ opRef });
	return {
		rule: { id: rule.id, pack: rule.artifact },
		match: { opRef },
		requiredObservations,
		obligations: requiredObservations.map((request) =>
			obligationForRequest(request),
		),
		selectionRationale: {
			chosen: { id: rule.id, pack: rule.artifact },
			overRules: [],
			why: 'manual staged transition candidate',
		},
	};
}

function compare(
	candidates: readonly TransitionCandidate[],
): Extract<CompareOutcome, { readonly kind: 'transitions' }> {
	return {
		kind: 'transitions',
		candidates,
		obligations: candidates.flatMap((entry) => [...entry.obligations]),
	};
}

function registry(rules: readonly TransitionRule[]) {
	const semantics: RegisteredOperationSemantics = {
		artifact: operationArtifact,
		operationKind: { artifact: operationArtifact, name: 'MockOperation' },
		supportsOperation: () => true,
		effectsOf: (op): OperationEffectAssessment => ({
			effects: {
				reads: [],
				writes: [],
				locks: [],
				invalidates: [],
				contextMutations: [],
				externalEffects: {
					accountedFor: [],
					couldNotAccountFor: [],
				},
				execution: {
					transaction: 'joins-current',
					commitBoundary: 'none',
				},
			},
			restsOn: [operationAssumption(op.ref)],
		}),
		buildFingerprints: () => ({
			expectedBefore: {
				algorithm: 'mock',
				semanticModel: operationArtifact,
				includedFacts: [],
				excludedOrUnknownFacts: [],
				digest: 'before',
			},
			expectedAfter: {
				algorithm: 'mock',
				semanticModel: operationArtifact,
				includedFacts: [],
				excludedOrUnknownFacts: [],
				digest: 'after',
			},
		}),
	};
	const issuer: ObservationIssuer = {
		artifact: ruleArtifact,
		execute: async (request) => ({
			role: 'evidence',
			id: evidenceId(`mock.staging.${request.kind}`),
			issuer: ruleArtifact,
			request,
			result: {
				value: { claims: [{ kind: request.kind, holds: true }] },
			},
			context,
			stability: 'connection-constant',
			takenAt: new Date().toISOString(),
			scope: request.scope,
			source: 'system-catalog',
			validity: { invalidatedBy: ['mock-change'] },
		}),
	};
	return createPackRegistry([
		{
			rules,
			operationSemantics: [semantics],
			issuer,
			compositionFactKinds: [enumLabelFact.kind],
			satisfiesCompositionFact: (fact, current) => {
				if (fact.kind !== enumLabelFact.kind) {
					return false;
				}
				return (
					current.enums?.get('status')?.values.includes('pending') ?? false
				);
			},
		},
	]);
}

function proofTarget() {
	return {
		connect: async () => ({
			query: async () => ({ rows: [] }),
			release: () => undefined,
		}),
	};
}

describe('staged composition preflight', () => {
	it('orders enum-label producers before CHECK consumers and projects one provable candidate', async () => {
		const enumRule = producerRule();
		const checkRule = consumerRule();
		const reg = registry([enumRule, checkRule]);
		const diff = compare([
			candidate(enumRule, 'op:enum'),
			candidate(checkRule, 'op:check'),
		]);

		const preflight = preflightStagedComposition(reg, {
			compare: diff,
			current: model(['active']),
			context,
		});

		expect(preflight.kind).toBe('provable-in-stages');
		if (preflight.kind !== 'provable-in-stages') {
			return;
		}
		expect(preflight.ready.map((entry) => entry.candidate.rule.id)).toEqual([
			'mock.enum.add',
		]);
		expect(preflight.pending.map((entry) => entry.candidate.rule.id)).toEqual([
			'mock.check.add',
		]);

		const projected = projectCompareToSingleCandidate(
			diff,
			chooseReadyCandidate(preflight),
		);
		expect(projected.candidates).toHaveLength(1);

		const outcome = await createProver(reg).prove(
			projected,
			proofTarget(),
			context,
		);
		expect(outcome.kind).toBe('proven');
	});

	it('stages after-commit facts even when the consumer asks for before-operation availability', () => {
		const enumRule = producerRule();
		const checkRule = consumerRuleWithNeed('producer-before-operation');
		const reg = registry([enumRule, checkRule]);
		const diff = compare([
			candidate(enumRule, 'op:enum'),
			candidate(checkRule, 'op:check'),
		]);

		const preflight = preflightStagedComposition(reg, {
			compare: diff,
			current: model(['active']),
			context,
		});

		expect(preflight.kind).toBe('provable-in-stages');
		if (preflight.kind !== 'provable-in-stages') {
			return;
		}
		expect(preflight.ready.map((entry) => entry.candidate.rule.id)).toEqual([
			'mock.enum.add',
		]);
		expect(preflight.pending.map((entry) => entry.candidate.rule.id)).toEqual([
			'mock.check.add',
		]);
	});

	it('treats a declared requirement as ready once the committed model satisfies it', () => {
		const checkRule = consumerRule();
		const reg = registry([checkRule]);
		const diff = compare([candidate(checkRule, 'op:check')]);

		const preflight = preflightStagedComposition(reg, {
			compare: diff,
			current: model(['active', 'pending']),
			context,
		});

		expect(preflight.kind).toBe('provable-in-stages');
		if (preflight.kind !== 'provable-in-stages') {
			return;
		}
		expect(preflight.ready).toHaveLength(1);
		expect(preflight.pending).toHaveLength(0);
	});

	it('fails closed when a required enum label has no producer and is not committed', () => {
		const checkRule = consumerRule();
		const reg = registry([checkRule]);
		const diff = compare([candidate(checkRule, 'op:check')]);

		const preflight = preflightStagedComposition(reg, {
			compare: diff,
			current: model(['active']),
			context,
		});

		expect(preflight.kind).toBe('unsupported-transition');
		if (preflight.kind === 'unsupported-transition') {
			expect(preflight.assessment.reasons[0]).toMatchObject({
				code: 'unsupported-transition',
			});
			expect(preflight.assessment.reasons[0]?.detail).toMatch(
				/unsatisfied composition requirement/,
			);
		}
	});

	it('blocks direct proof when a required composition fact is neither committed nor produced', async () => {
		const checkRule = consumerRule();
		const reg = registry([checkRule]);
		const diff = compare([candidate(checkRule, 'op:check')]);

		const outcome = await createProver(reg).prove(diff, proofTarget(), context);

		expect(outcome.kind).toBe('blocked');
		if (outcome.kind === 'blocked') {
			expect(outcome.assessment.reasons[0]).toMatchObject({
				code: 'unsupported-transition',
			});
			expect(outcome.assessment.reasons[0]?.detail).toMatch(
				/unsatisfied composition requirement/,
			);
		}
	});

	it('fails closed when a requirement has ambiguous producers', () => {
		const producerA = producerRule('mock.enum.add.a', 'op:enum:a');
		const producerB = producerRule('mock.enum.add.b', 'op:enum:b');
		const checkRule = consumerRule();
		const reg = registry([producerA, producerB, checkRule]);
		const diff = compare([
			candidate(producerA, 'op:enum:a'),
			candidate(producerB, 'op:enum:b'),
			candidate(checkRule, 'op:check'),
		]);

		const preflight = preflightStagedComposition(reg, {
			compare: diff,
			current: model(['active']),
			context,
		});

		expect(preflight.kind).toBe('unsupported-transition');
		if (preflight.kind === 'unsupported-transition') {
			expect(preflight.assessment.reasons[0]?.code).toBe('ambiguous-rule');
			expect(preflight.assessment.reasons[0]?.detail).toMatch(
				/ambiguous composition requirement/,
			);
		}
	});

	it('fails closed for multi-candidate compares without declared dependencies', () => {
		const first = rule('mock.first', 'op:first', undefined);
		const second = rule('mock.second', 'op:second', undefined);
		const reg = registry([first, second]);
		const diff = compare([
			candidate(first, 'op:first'),
			candidate(second, 'op:second'),
		]);

		const preflight = preflightStagedComposition(reg, {
			compare: diff,
			current: model(['active']),
			context,
		});

		expect(preflight.kind).toBe('unsupported-transition');
		if (preflight.kind === 'unsupported-transition') {
			expect(preflight.assessment.reasons[0]?.detail).toMatch(
				/no declared composition dependency/,
			);
		}
	});
});
