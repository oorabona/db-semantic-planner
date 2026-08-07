import { createHash } from 'node:crypto';
import type {
	ApplyPolicy,
	Assumption,
	DurableIntentRecord,
	FingerprintManifest,
	ObservationContext,
	OperationEffectAssessment,
	PhysicalOperation,
	ProvenPlanShape,
	SemanticArtifactRef,
	StepJournal,
	TransactionalCompletionRecord,
	TransitionJournalEvent,
	TransitionRunJournal,
	TransitionRunMetadata,
} from '@dbsp/types';
import { describe, expect, it, vi } from 'vitest';
import { createTestTransitionLessor } from './__fixtures__/transition-lessor.js';
import { createExecutionContract } from './execution-contract.js';
import { claimId, evidenceId, semanticArtifactId } from './ids.js';
import { transitionPlanDigest } from './plan-digest.js';
import type { OperationObservation, OperationRuntime } from './registry.js';
import { createPackRegistry } from './registry.js';
import {
	loadVerifiedRecoveryJournal,
	type ResumeTransitionInput,
	resumeTransitionRun,
} from './resume.js';
import { stableJson } from './stable-json.js';
import { TRANSITION_LESSOR_REJECTION } from './transition-lessor.js';

const artifact: SemanticArtifactRef = {
	id: semanticArtifactId('dbsp.mock.resume.operations'),
	version: '0.1.0',
};

const context: ObservationContext = {
	engine: 'postgresql',
	engineVersion: '18',
	databaseId: 'resume-db',
	capabilities: [],
	privileges: [],
	targetSchema: 'tenant',
	sessionConfiguration: {},
	extensions: {},
};

const operation: PhysicalOperation = {
	ref: 'op',
	operationKind: { artifact, name: 'Mock' },
	payload: {},
};

const operationB: PhysicalOperation = {
	ref: 'op:b',
	operationKind: { artifact, name: 'MockB' },
	payload: {},
};

function digest(value: unknown): string {
	return createHash('sha256').update(stableJson(value)).digest('hex');
}

function fingerprint(value: string): FingerprintManifest {
	return {
		algorithm: 'mock',
		semanticModel: artifact,
		includedFacts: [],
		excludedOrUnknownFacts: [],
		digest: value,
	};
}

function assumption(): Assumption {
	return {
		id: 'mock.operation-pack-semantics' as Assumption['id'],
		class: 'operation-pack-semantics',
		asserter: { kind: 'pack', artifact },
		statement: 'mock operation semantics are correct',
		scope: [
			{
				engine: 'postgresql',
				database: 'resume-db',
				schema: 'tenant',
				kind: 'table',
				name: 'users',
			},
		],
	};
}

function planShape(twoSteps = false): ProvenPlanShape {
	const baseAssumption = assumption();
	const step = {
		stepId: 'step:op',
		segmentId: 'segment:0',
		operation,
		expectedBefore: fingerprint('before'),
		expectedAfter: fingerprint('after'),
		requiredClaims: [],
		establishesClaims: [],
		invalidatesClaims: [],
		guards: [],
		restsOnAssumptions: [baseAssumption.id],
		selectionRationale: {
			chosen: { id: 'mock.rule', pack: artifact },
			overRules: [],
			why: 'test',
		},
	} satisfies ProvenPlanShape['steps'][number];
	const second = {
		...step,
		stepId: 'step:op:b',
		operation: operationB,
		expectedBefore: fingerprint('op:b:before'),
		expectedAfter: fingerprint('op:b:after'),
		selectionRationale: {
			chosen: { id: 'mock.rule.b', pack: artifact },
			overRules: [],
			why: 'test',
		},
	} satisfies ProvenPlanShape['steps'][number];
	return {
		observations: [
			{
				role: 'evidence',
				id: evidenceId('mock.resume.context'),
				issuer: artifact,
				request: { kind: 'mock.context', scope: [] },
				result: { value: { ok: true } },
				context,
				stability: 'externally-mutable',
				takenAt: new Date().toISOString(),
				scope: [],
				source: 'system-catalog',
				validity: { invalidatedBy: [] },
			},
		],
		claims: [
			{
				id: claimId('mock.resume.claim'),
				proposition: { kind: 'mock.resume.claim', scope: [] },
				scope: [],
				supportedBy: [evidenceId('mock.resume.context')],
				assumes: [],
				semantics: [artifact],
				derivedBy: {
					semantics: artifact,
					inputs: [evidenceId('mock.resume.context')],
					proposition: { kind: 'mock.resume.claim', scope: [] },
					conclusion: 'established',
				},
			},
		],
		assumptions: [baseAssumption],
		preconditions: [],
		segments: [
			{
				segmentId: 'segment:0',
				stepIds: twoSteps ? ['step:op', 'step:op:b'] : ['step:op'],
				transaction: 'joins-current',
				commitBoundaryBefore: false,
				commitBoundaryAfter: false,
			},
		],
		steps: twoSteps ? [step, second] : [step],
		postconditions: [],
	};
}

function run(plan: ProvenPlanShape): TransitionRunMetadata {
	return {
		runId: 'run:resume',
		planDigest: transitionPlanDigest(plan),
		targetContextDigest: digest(context),
		databaseId: context.databaseId,
		coreVersion: '0.1.0',
		startedAt: new Date().toISOString(),
	};
}

function intent(
	step: ProvenPlanShape['steps'][number],
	runMetadata: TransitionRunMetadata,
): DurableIntentRecord {
	return {
		runId: runMetadata.runId,
		run: runMetadata,
		stepId: step.stepId,
		operation: step.operation,
		recordedAt: new Date().toISOString(),
	};
}

function completion(
	step: ProvenPlanShape['steps'][number],
	runMetadata: TransitionRunMetadata,
): TransactionalCompletionRecord {
	return {
		runId: runMetadata.runId,
		stepId: step.stepId,
		committedWithDdl: true,
		recordedAt: new Date().toISOString(),
	};
}

function event(
	seq: number,
	eventName: TransitionJournalEvent['event'],
	step: ProvenPlanShape['steps'][number],
	runMetadata: TransitionRunMetadata,
	record: TransitionJournalEvent['record'],
): TransitionJournalEvent {
	return {
		runId: runMetadata.runId,
		seq,
		event: eventName,
		stepId: step.stepId,
		operationRef: step.operation.ref,
		operationKind: step.operation.operationKind,
		recordedAt: new Date().toISOString(),
		record,
	};
}

function completedJournal(
	step: ProvenPlanShape['steps'][number],
	runMetadata: TransitionRunMetadata,
): StepJournal {
	return {
		intent: intent(step, runMetadata),
		outcome: 'completed',
		transactionalCompletion: completion(step, runMetadata),
		observedOutcome: {
			stepId: step.stepId,
			observations: [],
			recordedAt: new Date().toISOString(),
		},
	};
}

function runtime(options: {
	readonly after?: string | Error;
	readonly before?: string | Error;
	readonly transaction?: 'joins-current' | 'forbids-transaction';
	readonly observed?: StepJournal[];
	readonly observeContext?: OperationRuntime['observeContext'];
	readonly writeObservedJournal?: OperationRuntime['writeObservedJournal'];
}): OperationRuntime {
	const observe = (
		phase: 'before' | 'after',
	): Promise<OperationObservation> => {
		const configured = phase === 'after' ? options.after : options.before;
		if (configured instanceof Error) {
			throw configured;
		}
		return Promise.resolve({
			observations: [],
			fingerprint: fingerprint(
				configured ?? (phase === 'after' ? 'after' : 'before'),
			),
		});
	};
	return {
		artifact,
		supportsOperation: (candidate) =>
			candidate.operationKind.artifact.id === artifact.id,
		effectsOf: (): OperationEffectAssessment => ({
			effects: {
				reads: [],
				writes: [],
				locks: [],
				invalidates: [],
				contextMutations: [],
				externalEffects: { accountedFor: [], couldNotAccountFor: [] },
				execution: {
					transaction: options.transaction ?? 'joins-current',
					commitBoundary: 'none',
				},
			},
			restsOn: [assumption()],
		}),
		buildFingerprints: () => ({
			expectedBefore: fingerprint('before'),
			expectedAfter: fingerprint('after'),
		}),
		writeIntentJournal: vi.fn(),
		begin: vi.fn(),
		setLockTimeout: vi.fn(),
		acquireLocks: vi.fn(),
		observeContext: options.observeContext ?? vi.fn(async () => context),
		observeOperation: vi.fn((_client, _operation, _context, phase) =>
			observe(phase),
		),
		checkGuard: vi.fn(async () => ({
			passed: true,
			observations: [],
			recovery: [],
		})),
		executeOperation: vi.fn(async () => ({ kind: 'completed' }) as const),
		writeCompletionJournal: vi.fn(),
		commit: vi.fn(),
		rollback: vi.fn(),
		writeObservedJournal:
			options.writeObservedJournal ??
			vi.fn(async (_client, journal) => {
				options.observed?.push(journal);
			}),
		isLockTimeout: () => false,
	};
}

const policy: ApplyPolicy = {
	accepts: [{ class: 'operation-pack-semantics' }],
};

async function resumeWith(
	plan: ProvenPlanShape,
	events: readonly TransitionJournalEvent[],
	rt: OperationRuntime,
	options: {
		readonly readContext?: ResumeTransitionInput['readContext'];
		readonly loadCurrent?: (
			runId: string,
		) => Promise<TransitionRunJournal & { readonly plan: ProvenPlanShape }>;
		readonly target?: ResumeTransitionInput['target'];
		readonly registry?: ReturnType<typeof createPackRegistry>;
		readonly admitRecovery?: ResumeTransitionInput['admitRecovery'];
	} = {},
) {
	const registry =
		options.registry ??
		createPackRegistry([
			{
				rules: [],
				operationSemantics: [rt],
				issuer: { artifact, execute: vi.fn() },
			},
		]);
	const runMetadata = run(plan);
	const loadCurrent =
		options.loadCurrent ?? (async () => ({ run: runMetadata, plan, events }));
	const loaded = await loadVerifiedRecoveryJournal(
		runMetadata.runId,
		transitionPlanDigest(plan),
		loadCurrent,
	);
	if (!loaded.ok) throw new Error(loaded.detail);
	return resumeTransitionRun(registry, {
		journal: loaded.journal,
		readContext: options.readContext ?? (async () => context),
		policy,
		target:
			options.target ??
			createTestTransitionLessor(async () => ({
				query: async () => ({ rows: [] }),
				release: vi.fn(),
			})),
		...(options.admitRecovery ? { admitRecovery: options.admitRecovery } : {}),
	});
}

describe('resumeTransitionRun', () => {
	it('mutation: comparing recovery to targetContextDigest rejects a moved target even after physical-target admission', async () => {
		const base = planShape();
		const plan = {
			...base,
			executionContract: createExecutionContract([
				{
					kind: 'postgresql.physical-target',
					mode: 'must-match',
					systemIdentifier: 'cluster-1',
					databaseOid: '5',
					namespaces: [{ name: 'tenant', oid: '2200' }],
				},
			]),
		};
		const movedContext: ObservationContext = {
			...context,
			sessionConfiguration: { changed: 'after-attempt' },
		};
		const admitRecovery = vi.fn(async (_target, contract) => {
			expect(contract.requirements).toHaveLength(1);
			return { ok: true as const, context: movedContext };
		});

		const runMetadata = run(plan);
		const step = plan.steps[0]!;
		const result = await resumeWith(
			plan,
			[event(1, 'intent', step, runMetadata, intent(step, runMetadata))],
			runtime({ observeContext: vi.fn(async () => movedContext) }),
			{
				admitRecovery,
				readContext: async () => {
					throw new Error('legacy context reader must not be used');
				},
			},
		);

		expect(result.assessment.reasons[0]?.code).toBe('resume-required');
		expect(admitRecovery).toHaveBeenCalledOnce();
	});

	// The loader boundary owns durable-row failures so resume never performs a
	// second read after the externally reviewed snapshot was established.
	it('reports a loader refusal from the load-and-verify boundary', async () => {
		const plan = planShape();
		await expect(
			loadVerifiedRecoveryJournal(
				run(plan).runId,
				transitionPlanDigest(plan),
				async () => {
					throw new Error(
						'dbsp transition run plan row is invalid and non-resumable',
					);
				},
			),
		).resolves.toMatchObject({ ok: false, code: 'load-failed' });
	});

	it('reports a serialization refusal from the load-and-verify boundary', async () => {
		const plan = planShape();
		const runMetadata = run(plan);
		(plan as ProvenPlanShape & { cycle?: unknown }).cycle = plan;

		await expect(
			loadVerifiedRecoveryJournal(
				runMetadata.runId,
				runMetadata.planDigest,
				async () => ({ run: runMetadata, plan, events: [] }),
			),
		).resolves.toMatchObject({ ok: false, code: 'load-failed' });
	});

	it('uses one frozen journal when an alternating loader offers a replacement', async () => {
		const first = planShape();
		const replacement = {
			...first,
			steps: first.steps.map((step) => ({
				...step,
				stepId: `${step.stepId}:replacement`,
			})),
		} as ProvenPlanShape;
		const runMetadata = run(first);
		const loadCurrent = vi.fn(async () => ({
			run: runMetadata,
			plan: loadCurrent.mock.calls.length === 1 ? first : replacement,
			events: [],
		}));
		const loaded = await loadVerifiedRecoveryJournal(
			runMetadata.runId,
			transitionPlanDigest(first),
			loadCurrent,
		);
		expect(loaded).toMatchObject({ ok: true });
		if (!loaded.ok) return;
		const result = await resumeTransitionRun(
			createPackRegistry([
				{
					rules: [],
					operationSemantics: [runtime({})],
					issuer: { artifact, execute: vi.fn() },
				},
			]),
			{
				journal: loaded.journal,
				readContext: vi.fn(async () => context),
				target: createTestTransitionLessor(async () => ({
					query: async () => ({ rows: [] }),
					release: vi.fn(),
				})),
			},
		);
		expect(result.assessment.reasons[0]?.code).toBe('resume-required');
		expect(loadCurrent).toHaveBeenCalledOnce();
		expect(loaded.journal.plan).toEqual(first);
	});

	it('snapshots loader-owned evidence before the loader can mutate it', async () => {
		const mutable = planShape();
		const runMetadata = run(mutable);
		const loaded = await loadVerifiedRecoveryJournal(
			runMetadata.runId,
			transitionPlanDigest(mutable),
			async () => ({
				run: runMetadata,
				plan: mutable,
				events: [],
				authorizations: [],
			}),
		);
		if (!loaded.ok) throw new Error(loaded.detail);
		(mutable as unknown as { steps: unknown[] }).steps = [];
		expect(loaded.journal.plan.steps).toHaveLength(1);
		expect(Object.isFrozen(loaded.journal.authorizations)).toBe(true);
	});

	it('returns a pristine assumed run before policy, target admission, reads, or writes', async () => {
		const plan = planShape();
		const runMetadata = run(plan);
		const loaded = await loadVerifiedRecoveryJournal(
			runMetadata.runId,
			transitionPlanDigest(plan),
			async () => ({ run: runMetadata, plan, events: [], authorizations: [] }),
		);
		if (!loaded.ok) throw new Error(loaded.detail);
		const readContext = vi.fn(async () => context);
		const acquire = vi.fn();
		const result = await resumeTransitionRun(
			createPackRegistry([
				{
					rules: [],
					operationSemantics: [runtime({})],
					issuer: { artifact, execute: vi.fn() },
				},
			]),
			{ journal: loaded.journal, readContext, target: { acquire } as never },
		);
		expect(result.assessment.reasons[0]?.code).toBe('resume-required');
		expect(readContext).not.toHaveBeenCalled();
		expect(acquire).not.toHaveBeenCalled();
	});

	it('blocks rather than rejecting when a pack supportsOperation throws', async () => {
		const plan = planShape();
		const runMetadata = run(plan);
		const step = plan.steps[0]!;
		const failure = new Error('operation support lookup failed');
		const rt: OperationRuntime = {
			...runtime({}),
			supportsOperation: () => {
				throw failure;
			},
		};

		await expect(
			resumeWith(
				plan,
				[
					event(1, 'intent', step, runMetadata, intent(step, runMetadata)),
					event(
						2,
						'observed',
						step,
						runMetadata,
						completedJournal(step, runMetadata),
					),
				],
				rt,
			),
		).resolves.toMatchObject({
			assessment: {
				decision: 'blocked',
				lifecycle: 'outcome-unknown',
				continuation: 'replan-required',
				reasons: [
					{
						code: 'context-mismatch',
						detail: expect.stringContaining(failure.message),
					},
				],
			},
		});
	});

	it('blocks rather than rejecting when the returned context throws on access', async () => {
		const plan = planShape();
		const runMetadata = run(plan);
		const step = plan.steps[0]!;
		const failure = new Error('context databaseId is unavailable');

		await expect(
			resumeWith(
				plan,
				[event(1, 'intent', step, runMetadata, intent(step, runMetadata))],
				runtime({}),
				{
					readContext: async () => {
						const unreadable = { ...context };
						Object.defineProperty(unreadable, 'databaseId', {
							enumerable: true,
							get: () => {
								throw failure;
							},
						});
						return unreadable;
					},
				},
			),
		).resolves.toMatchObject({
			assessment: {
				decision: 'blocked',
				lifecycle: 'outcome-unknown',
				continuation: 'replan-required',
				reasons: [
					{
						code: 'context-mismatch',
						detail: expect.stringContaining(failure.message),
					},
				],
			},
		});
	});

	// The durable plan is trusted only because this check exists: a stored plan
	// that does not round-trip byte-for-byte under stableJson must never be
	// resumed from. Everything the persistence seam guarantees rests here.
	it('refuses a loaded plan whose digest does not match the recorded run', async () => {
		const plan = planShape();
		const runMetadata = run(plan);
		const tampered: ProvenPlanShape = {
			...plan,
			steps: plan.steps.map((step, index) =>
				index === 0 ? { ...step, stepId: `${step.stepId}-tampered` } : step,
			),
		};

		await expect(
			loadVerifiedRecoveryJournal(
				runMetadata.runId,
				transitionPlanDigest(plan),
				async () => ({ run: runMetadata, plan: tampered, events: [] }),
			),
		).resolves.toMatchObject({ ok: false, code: 'plan-digest-mismatch' });
	});

	it.each([
		{},
		{ observations: [], claims: [], assumptions: [] },
	])('blocks a corrupt loaded plan instead of throwing', async (corruptPlan) => {
		const runMetadata = run(corruptPlan as unknown as ProvenPlanShape);

		await expect(
			loadVerifiedRecoveryJournal(
				runMetadata.runId,
				transitionPlanDigest(corruptPlan as unknown as ProvenPlanShape),
				async () =>
					({ run: runMetadata, plan: corruptPlan, events: [] }) as never,
			),
		).resolves.toMatchObject({ ok: false, code: 'plan-invalid' });
	});

	it('uses an immutable snapshot when a loader-owned plan mutates after loading', async () => {
		const mutablePlan = planShape();
		const runMetadata = run(mutablePlan);
		const result = await resumeWith(mutablePlan, [], runtime({}), {
			loadCurrent: async () => ({
				run: runMetadata,
				plan: mutablePlan,
				events: [],
			}),
			readContext: async () => {
				(mutablePlan as unknown as { steps: unknown[] }).steps = [];
				return context;
			},
		});

		expect(result.assessment.reasons[0]?.code).toBe('resume-required');
	});

	it('reports an unstarted journal as planned without inspecting an unusable target', async () => {
		const plan = planShape();
		const runMetadata = run(plan);
		const result = await resumeWith(plan, [], runtime({}), {
			loadCurrent: async () => ({
				run: runMetadata,
				plan,
				events: [],
			}),
			target: { acquire: vi.fn() } as never,
		});

		expect(result.assessment.lifecycle).toBe('planned');
		expect(result.assessment.continuation).toBe('resume-possible');
	});

	it('rejects a forged lessor whose acquisition has no release()', async () => {
		const plan = planShape();
		const runMetadata = run(plan);
		const step = plan.steps[0]!;
		const journal = completedJournal(step, runMetadata);
		const target = {
			acquire: vi.fn(async () => ({ query: vi.fn() })),
		};
		Object.defineProperty(target, Symbol.for('dbsp.transition.lessor'), {
			value: { protocolVersion: 1 },
		});

		const result = await resumeWith(
			plan,
			[
				event(1, 'intent', step, runMetadata, journal.intent),
				event(2, 'observed', step, runMetadata, journal),
			],
			runtime({ after: 'after' }),
			{ target: target as never },
		);

		expect(result.assessment.reasons[0]?.detail).toContain(
			'must acquire a lease exposing query() and release()',
		);
		expect(target.acquire).toHaveBeenCalledOnce();
	});

	it('validates durable journals before reporting an unusable target as outcome-unknown', async () => {
		const plan = planShape();
		const runMetadata = run(plan);
		const step = plan.steps[0]!;
		const journal = completedJournal(step, runMetadata);
		const loadCurrent = vi.fn(async () => ({
			run: runMetadata,
			plan,
			events: [
				event(1, 'intent', step, runMetadata, journal.intent),
				event(2, 'observed', step, runMetadata, journal),
			],
		}));
		const target = {
			connect: vi.fn(),
			query: vi.fn(),
			release: vi.fn(),
		};
		const readContext = vi.fn();

		const result = await resumeWith(plan, [], runtime({}), {
			loadCurrent,
			readContext,
			target: target as never,
		});

		expect(result.assessment.reasons[0]).toMatchObject({
			code: 'context-mismatch',
			fact: {
				key: 'transition-lessor',
				value: TRANSITION_LESSOR_REJECTION,
			},
		});
		expect(result.assessment.lifecycle).toBe('outcome-unknown');
		expect(result.assessment.continuation).toBe('human-intervention-required');
		expect(result.journals).toEqual([]);
		expect(loadCurrent).toHaveBeenCalledWith(runMetadata.runId);
		expect(readContext).not.toHaveBeenCalled();
		expect(target.connect).not.toHaveBeenCalled();
	});

	it('re-observes an observed completed step before accepting completion', async () => {
		const plan = planShape();
		const runMetadata = run(plan);
		const step = plan.steps[0]!;
		const journal = completedJournal(step, runMetadata);

		const result = await resumeWith(
			plan,
			[
				event(1, 'intent', step, runMetadata, journal.intent),
				event(2, 'observed', step, runMetadata, journal),
			],
			runtime({ after: 'after' }),
		);

		expect(result.assessment.lifecycle).toBe('completed');
		expect(result.journals[0]?.outcome).toBe('completed');
	});

	it('re-observes completion without observed and writes the observed journal', async () => {
		const plan = planShape();
		const runMetadata = run(plan);
		const step = plan.steps[0]!;
		const observed: StepJournal[] = [];

		const result = await resumeWith(
			plan,
			[
				event(1, 'intent', step, runMetadata, intent(step, runMetadata)),
				event(
					2,
					'completion',
					step,
					runMetadata,
					completion(step, runMetadata),
				),
			],
			runtime({ after: 'after', observed }),
		);

		expect(result.assessment.lifecycle).toBe('completed');
		expect(observed[0]?.outcome).toBe('completed');
	});

	it('blocks and releases the completed-step observation when its journal write rejects', async () => {
		const plan = planShape();
		const runMetadata = run(plan);
		const step = plan.steps[0]!;
		const release = vi.fn();
		const failure = new Error('journal unavailable');

		const result = await resumeWith(
			plan,
			[
				event(1, 'intent', step, runMetadata, intent(step, runMetadata)),
				event(
					2,
					'completion',
					step,
					runMetadata,
					completion(step, runMetadata),
				),
			],
			runtime({
				writeObservedJournal: vi.fn(async () => {
					throw failure;
				}),
			}),
			{
				target: createTestTransitionLessor(async () => ({
					query: async () => ({ rows: [] }),
					release,
				})),
			},
		);
		expect(result.assessment).toMatchObject({
			decision: 'blocked',
			lifecycle: 'outcome-unknown',
			continuation: 'replan-required',
			reasons: [{ code: 'context-mismatch' }],
		});
		expect(result.assessment.reasons[0]?.detail).toContain(failure.message);
		expect(release).toHaveBeenCalledOnce();
		expect(release.mock.calls[0]?.[0]).toBeTruthy();
	});

	it('preserves a reconciled prefix when a later journal write rejects', async () => {
		const base = planShape(true);
		const plan: ProvenPlanShape = {
			...base,
			steps: base.steps.map((step, index) =>
				index === 1 ? { ...step, expectedAfter: fingerprint('after') } : step,
			),
		};
		const runMetadata = run(plan);
		const [first, second] = plan.steps;
		if (!first || !second) {
			throw new Error('two-step test plan was not created');
		}
		const failure = new Error('second journal unavailable');
		let writes = 0;

		const result = await resumeWith(
			plan,
			[
				event(1, 'intent', first, runMetadata, intent(first, runMetadata)),
				event(
					2,
					'completion',
					first,
					runMetadata,
					completion(first, runMetadata),
				),
				event(3, 'intent', second, runMetadata, intent(second, runMetadata)),
				event(
					4,
					'completion',
					second,
					runMetadata,
					completion(second, runMetadata),
				),
			],
			runtime({
				writeObservedJournal: vi.fn(async () => {
					writes += 1;
					if (writes === 2) {
						throw failure;
					}
				}),
			}),
		);

		expect(result.assessment.decision).toBe('blocked');
		expect(result.journals).toHaveLength(1);
		expect(result.journals[0]?.intent.stepId).toBe(first.stepId);
	});

	it('blocks and releases the transactional completion observation when its journal write rejects', async () => {
		const plan = planShape();
		const runMetadata = run(plan);
		const step = plan.steps[0]!;
		const release = vi.fn();
		const failure = new Error('journal unavailable');
		let acquisitions = 0;

		const result = await resumeWith(
			plan,
			[event(1, 'intent', step, runMetadata, intent(step, runMetadata))],
			runtime({
				before: 'drifted-before',
				writeObservedJournal: vi.fn(async () => {
					throw failure;
				}),
			}),
			{
				target: createTestTransitionLessor(async () => {
					acquisitions += 1;
					if (acquisitions === 1) {
						throw new Error('before observation unavailable');
					}
					return { query: async () => ({ rows: [] }), release };
				}),
			},
		);
		expect(result.assessment).toMatchObject({
			decision: 'blocked',
			lifecycle: 'outcome-unknown',
			continuation: 'replan-required',
			reasons: [{ code: 'context-mismatch' }],
		});
		expect(result.assessment.reasons[0]?.detail).toContain(failure.message);
		expect(release).toHaveBeenCalledOnce();
		expect(release.mock.calls[0]?.[0]).toBeTruthy();
	});

	it('blocks and releases the non-atomic completion observation when its journal write rejects', async () => {
		const base = planShape();
		const plan: ProvenPlanShape = {
			...base,
			segments: [{ ...base.segments[0]!, transaction: 'forbids-transaction' }],
		};
		const runMetadata = run(plan);
		const step = plan.steps[0]!;
		const release = vi.fn();
		const failure = new Error('journal unavailable');

		const result = await resumeWith(
			plan,
			[event(1, 'intent', step, runMetadata, intent(step, runMetadata))],
			runtime({
				transaction: 'forbids-transaction',
				writeObservedJournal: vi.fn(async () => {
					throw failure;
				}),
			}),
			{
				target: createTestTransitionLessor(async () => ({
					query: async () => ({ rows: [] }),
					release,
				})),
			},
		);
		expect(result.assessment).toMatchObject({
			decision: 'blocked',
			lifecycle: 'outcome-unknown',
			continuation: 'replan-required',
			reasons: [{ code: 'context-mismatch' }],
		});
		expect(result.assessment.reasons[0]?.detail).toContain(failure.message);
		expect(release).toHaveBeenCalledOnce();
		expect(release.mock.calls[0]?.[0]).toBeTruthy();
	});

	it('releases a fingerprint mismatch once without an error', async () => {
		const plan = planShape();
		const runMetadata = run(plan);
		const step = plan.steps[0]!;
		const release = vi.fn();

		const result = await resumeWith(
			plan,
			[
				event(1, 'intent', step, runMetadata, intent(step, runMetadata)),
				event(
					2,
					'observed',
					step,
					runMetadata,
					completedJournal(step, runMetadata),
				),
			],
			runtime({ after: 'drifted-after' }),
			{
				target: createTestTransitionLessor(async () => ({
					query: async () => ({ rows: [] }),
					release,
				})),
			},
		);

		expect(result.assessment.lifecycle).toBe('outcome-unknown');
		expect(release).toHaveBeenCalledOnce();
		expect(release).toHaveBeenCalledWith();
	});

	it('releases a successful completion observation once without an error', async () => {
		const plan = planShape();
		const runMetadata = run(plan);
		const step = plan.steps[0]!;
		const release = vi.fn();

		const result = await resumeWith(
			plan,
			[
				event(1, 'intent', step, runMetadata, intent(step, runMetadata)),
				event(
					2,
					'completion',
					step,
					runMetadata,
					completion(step, runMetadata),
				),
			],
			runtime({}),
			{
				target: createTestTransitionLessor(async () => ({
					query: async () => ({ rows: [] }),
					release,
				})),
			},
		);

		expect(result.assessment.lifecycle).toBe('completed');
		expect(release).toHaveBeenCalledOnce();
		expect(release).toHaveBeenCalledWith();
	});

	it('reports observation failures as unknown after releasing the lease with the error', async () => {
		const plan = planShape();
		const runMetadata = run(plan);
		const step = plan.steps[0]!;
		const release = vi.fn();
		const failure = new Error('observation unavailable');

		const result = await resumeWith(
			plan,
			[
				event(1, 'intent', step, runMetadata, intent(step, runMetadata)),
				event(
					2,
					'observed',
					step,
					runMetadata,
					completedJournal(step, runMetadata),
				),
			],
			runtime({ after: failure }),
			{
				target: createTestTransitionLessor(async () => ({
					query: async () => ({ rows: [] }),
					release,
				})),
			},
		);

		expect(result.assessment.reasons[0]?.detail).toBe(failure.message);
		expect(release).toHaveBeenCalledOnce();
		expect(release.mock.calls[0]?.[0]).toBe(failure);
	});

	it('does not acquire a lease when the operation runtime is missing', async () => {
		const plan = planShape();
		const runMetadata = run(plan);
		const step = plan.steps[0]!;
		let acquisitions = 0;
		const missingRuntime = { ...runtime({}), release: vi.fn() };

		const result = await resumeWith(
			plan,
			[
				event(1, 'intent', step, runMetadata, intent(step, runMetadata)),
				event(
					2,
					'observed',
					step,
					runMetadata,
					completedJournal(step, runMetadata),
				),
			],
			missingRuntime,
			{
				target: createTestTransitionLessor(async () => {
					acquisitions += 1;
					return { query: async () => ({ rows: [] }), release: vi.fn() };
				}),
			},
		);

		expect(result.assessment.reasons[0]?.detail).toBe(
			'operation runtime missing',
		);
		expect(acquisitions).toBe(0);
	});

	it('does not acquire a lease when the operation observation issuer is missing', async () => {
		const plan = planShape();
		const runMetadata = run(plan);
		const step = plan.steps[0]!;
		let acquisitions = 0;
		const rt = runtime({});
		const registry = createPackRegistry([
			{
				rules: [],
				operationSemantics: [rt],
				issuer: { artifact, execute: vi.fn() },
			},
		]);
		vi.spyOn(registry, 'resolveIssuer').mockReturnValue(undefined);

		const result = await resumeWith(
			plan,
			[
				event(1, 'intent', step, runMetadata, intent(step, runMetadata)),
				event(
					2,
					'observed',
					step,
					runMetadata,
					completedJournal(step, runMetadata),
				),
			],
			rt,
			{
				registry,
				target: createTestTransitionLessor(async () => {
					acquisitions += 1;
					return { query: async () => ({ rows: [] }), release: vi.fn() };
				}),
			},
		);

		expect(result.assessment.reasons[0]?.detail).toBe(
			'operation observation issuer missing',
		);
		expect(acquisitions).toBe(0);
	});

	it('classifies a transactional intent without completion as not committed when expectedBefore still matches', async () => {
		const plan = planShape();
		const runMetadata = run(plan);
		const step = plan.steps[0]!;

		const result = await resumeWith(
			plan,
			[event(1, 'intent', step, runMetadata, intent(step, runMetadata))],
			runtime({ before: 'before' }),
		);

		expect(result.assessment.reasons[0]).toMatchObject({
			code: 'resume-required',
			stepId: 'step:op',
		});
		expect(result.assessment.decision).toBe('blocked');
	});

	it('reports an unknown non-atomic outcome despite an unaccepted execution-admission assumption', async () => {
		const base = planShape();
		const plan: ProvenPlanShape = {
			...base,
			assumptions: [
				...base.assumptions,
				{
					id: 'mock.non-transactional-segment' as Assumption['id'],
					class: 'non-transactional-segment',
					asserter: { kind: 'pack', artifact },
					statement:
						'The plan contains a segment that must execute outside a transaction block.',
					scope: base.assumptions[0]!.scope,
				},
			],
			segments: [
				{
					...base.segments[0]!,
					transaction: 'forbids-transaction',
				},
			],
		};
		const runMetadata = run(plan);
		const step = plan.steps[0]!;

		const result = await resumeWith(
			plan,
			[event(1, 'intent', step, runMetadata, intent(step, runMetadata))],
			runtime({
				transaction: 'forbids-transaction',
				after: new Error('after unknown'),
				before: 'drifted-before',
			}),
		);

		expect(result.assessment.lifecycle).toBe('outcome-unknown');
		expect(result.assessment.continuation).toBe('human-intervention-required');
		expect(result.assessment.reasons[0]?.code).toBe('unknown-step-result');
	});

	it('reports guard-timeout after prior completion as partially applied', async () => {
		const plan = planShape(true);
		const runMetadata = run(plan);
		const first = plan.steps[0]!;
		const second = plan.steps[1]!;
		const firstJournal = completedJournal(first, runMetadata);
		const timeoutJournal: StepJournal = {
			intent: intent(second, runMetadata),
			outcome: 'guard-timeout',
			observedOutcome: {
				stepId: second.stepId,
				observations: [],
				recordedAt: new Date().toISOString(),
			},
		};

		const result = await resumeWith(
			plan,
			[
				event(1, 'intent', first, runMetadata, firstJournal.intent),
				event(2, 'observed', first, runMetadata, firstJournal),
				event(3, 'intent', second, runMetadata, timeoutJournal.intent),
				event(4, 'observed', second, runMetadata, timeoutJournal),
			],
			runtime({ after: 'after' }),
		);

		expect(result.assessment.lifecycle).toBe('partially-applied');
		expect(result.assessment.continuation).toBe('resume-possible');
		expect(result.assessment.reasons[0]?.code).toBe('guard-timeout');
	});

	it('produces resume-required when completed prefix leaves known remaining work', async () => {
		const plan = planShape(true);
		const runMetadata = run(plan);
		const first = plan.steps[0]!;
		const firstJournal = completedJournal(first, runMetadata);

		const result = await resumeWith(
			plan,
			[
				event(1, 'intent', first, runMetadata, firstJournal.intent),
				event(2, 'observed', first, runMetadata, firstJournal),
			],
			runtime({ after: 'after' }),
		);

		expect(result.assessment.lifecycle).toBe('partially-applied');
		expect(result.assessment.reasons[0]).toMatchObject({
			code: 'resume-required',
			stepId: 'step:op:b',
		});
	});

	it('fails closed when readContext does not match run metadata', async () => {
		const plan = planShape();
		const runMetadata = run(plan);
		const step = plan.steps[0]!;
		const result = await resumeWith(
			plan,
			[event(1, 'intent', step, runMetadata, intent(step, runMetadata))],
			runtime({}),
			{
				readContext: async () => ({
					...context,
					databaseId: 'other-db',
				}),
			},
		);

		expect(result.assessment.reasons[0]).toMatchObject({
			code: 'context-mismatch',
		});
		expect(result.assessment.reasons[0]?.detail).toContain('databaseId');
	});

	it('fails closed when loaded plan evidence context does not match the run proof context', async () => {
		const base = planShape();
		const tampered: ProvenPlanShape = {
			...base,
			observations: base.observations.map((observation) =>
				observation.role === 'evidence'
					? {
							...observation,
							context: {
								...context,
								databaseId: 'other-db',
								targetSchema: 'other',
							},
						}
					: observation,
			),
		};

		const runMetadata = run(tampered);
		const step = tampered.steps[0]!;
		const result = await resumeWith(
			tampered,
			[event(1, 'intent', step, runMetadata, intent(step, runMetadata))],
			runtime({}),
		);

		expect(result.assessment.reasons[0]).toMatchObject({
			code: 'context-mismatch',
		});
		expect(result.assessment.reasons[0]?.detail).toContain(
			'loaded plan evidence context',
		);
	});

	it('blocks reconciliation when a step runtime observes a foreign context', async () => {
		const plan = planShape();
		const runMetadata = run(plan);
		const step = plan.steps[0]!;
		const journal = completedJournal(step, runMetadata);

		const result = await resumeWith(
			plan,
			[
				event(1, 'intent', step, runMetadata, journal.intent),
				event(2, 'observed', step, runMetadata, journal),
			],
			runtime({
				after: 'after',
				observeContext: vi.fn(async () => ({
					...context,
					databaseId: 'other-db',
					targetSchema: 'other',
				})),
			}),
		);

		expect(result.assessment.decision).toBe('blocked');
		expect(result.assessment.reasons[0]).toMatchObject({
			code: 'unknown-step-result',
			stepId: 'step:op',
		});
		expect(result.assessment.reasons[0]?.detail).toContain('databaseId');
		expect(result.journals).toEqual([]);
	});

	it('rejects a plan whose step order differs from segment execution order', async () => {
		const base = planShape(true);
		const tampered: ProvenPlanShape = {
			...base,
			segments: [
				{
					...base.segments[0]!,
					stepIds: ['step:op:b', 'step:op'],
				},
			],
		};

		await expect(
			loadVerifiedRecoveryJournal(
				run(tampered).runId,
				transitionPlanDigest(tampered),
				async () => ({ run: run(tampered), plan: tampered, events: [] }),
			),
		).resolves.toMatchObject({ ok: false, code: 'plan-invalid' });
	});

	it('rejects journal events with mismatched embedded record identity', async () => {
		const plan = planShape(true);
		const runMetadata = run(plan);
		const first = plan.steps[0]!;
		const second = plan.steps[1]!;

		await expect(
			loadVerifiedRecoveryJournal(
				runMetadata.runId,
				transitionPlanDigest(plan),
				async () => ({
					run: runMetadata,
					plan,
					events: [
						event(1, 'intent', second, runMetadata, intent(first, runMetadata)),
					],
				}),
			),
		).resolves.toMatchObject({ ok: false, code: 'event-invalid' });
	});

	it('requires each step exact operation-pack-semantics assumption during resume validation', async () => {
		const assumptionA = assumption();
		const assumptionB: Assumption = {
			...assumptionA,
			id: 'mock.operation-pack-semantics.b' as Assumption['id'],
			statement: 'mock operation semantics are correct for op:b',
		};
		const base = planShape(true);
		const tampered: ProvenPlanShape = {
			...base,
			assumptions: [assumptionA, assumptionB],
			steps: base.steps.map((step) => ({
				...step,
				restsOnAssumptions: [assumptionA.id],
			})),
		};
		const baseRuntime = runtime({});
		const rt: OperationRuntime = {
			...baseRuntime,
			effectsOf: (candidate): OperationEffectAssessment => {
				const effects = baseRuntime.effectsOf(candidate, context);
				return {
					...effects,
					restsOn: [candidate.ref === 'op:b' ? assumptionB : assumptionA],
				};
			},
		};

		const result = await resumeWith(tampered, [], rt);
		expect(result.assessment.reasons[0]).toMatchObject({
			code: 'resume-required',
		});
	});
});
