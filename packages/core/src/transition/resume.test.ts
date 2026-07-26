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
	TransitionRunMetadata,
} from '@dbsp/types';
import { describe, expect, it, vi } from 'vitest';
import { createTestTransitionLessor } from './__fixtures__/transition-lessor.js';
import { claimId, evidenceId, semanticArtifactId } from './ids.js';
import type { OperationObservation, OperationRuntime } from './registry.js';
import { createPackRegistry } from './registry.js';
import { type ResumeTransitionInput, resumeTransitionRun } from './resume.js';
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
		planDigest: digest(plan),
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
		executeOperation: vi.fn(async () => ({ kind: 'completed' })),
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
		readonly loadCurrent?: ResumeTransitionInput['loadCurrent'];
		readonly target?: ResumeTransitionInput['target'];
		readonly registry?: ReturnType<typeof createPackRegistry>;
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
	return resumeTransitionRun(registry, {
		runId: runMetadata.runId,
		loadCurrent,
		readContext: options.readContext ?? (async () => context),
		policy,
		target:
			options.target ??
			createTestTransitionLessor(async () => ({
				query: async () => ({ rows: [] }),
				release: vi.fn(),
			})),
	});
}

describe('resumeTransitionRun', () => {
	it('reports an unstarted journal as planned when its target is unusable', async () => {
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
		expect(result.assessment.continuation).toBe('human-intervention-required');
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

	it('releases the completed-step observation when its journal write rejects', async () => {
		const plan = planShape();
		const runMetadata = run(plan);
		const step = plan.steps[0]!;
		const release = vi.fn();
		const failure = new Error('journal unavailable');

		await expect(
			resumeWith(
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
			),
		).rejects.toBe(failure);
		expect(release).toHaveBeenCalledOnce();
		expect(release.mock.calls[0]?.[0]).toBeTruthy();
	});

	it('releases the transactional completion observation when its journal write rejects', async () => {
		const plan = planShape();
		const runMetadata = run(plan);
		const step = plan.steps[0]!;
		const release = vi.fn();
		const failure = new Error('journal unavailable');
		let acquisitions = 0;

		await expect(
			resumeWith(
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
			),
		).rejects.toBe(failure);
		expect(release).toHaveBeenCalledOnce();
		expect(release.mock.calls[0]?.[0]).toBeTruthy();
	});

	it('releases the non-atomic completion observation when its journal write rejects', async () => {
		const base = planShape();
		const plan: ProvenPlanShape = {
			...base,
			segments: [{ ...base.segments[0]!, transaction: 'forbids-transaction' }],
		};
		const runMetadata = run(plan);
		const step = plan.steps[0]!;
		const release = vi.fn();
		const failure = new Error('journal unavailable');

		await expect(
			resumeWith(
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
			),
		).rejects.toBe(failure);
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

	it('fails closed on non-atomic intent without confirmable completion', async () => {
		const base = planShape();
		const plan: ProvenPlanShape = {
			...base,
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
		const result = await resumeWith(plan, [], runtime({}), {
			readContext: async () => ({
				...context,
				databaseId: 'other-db',
			}),
		});

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

		const result = await resumeWith(tampered, [], runtime({}));

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

		const result = await resumeWith(tampered, [], runtime({}));

		expect(result.assessment.reasons[0]).toMatchObject({
			code: 'context-mismatch',
		});
		expect(result.assessment.reasons[0]?.detail).toContain('step order');
	});

	it('rejects journal events with mismatched embedded record identity', async () => {
		const plan = planShape(true);
		const runMetadata = run(plan);
		const first = plan.steps[0]!;
		const second = plan.steps[1]!;

		const result = await resumeWith(
			plan,
			[event(1, 'intent', second, runMetadata, intent(first, runMetadata))],
			runtime({}),
		);

		expect(result.assessment.reasons[0]).toMatchObject({
			code: 'context-mismatch',
		});
		expect(result.assessment.reasons[0]?.detail).toContain('embeds record');
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
			code: 'context-mismatch',
		});
		expect(result.assessment.reasons[0]?.detail).toContain(assumptionB.id);
	});
});
