import type {
	ApplicableAssessment,
	ApplyGuard,
	ApplyPolicy,
	Assumption,
	DurableIntentRecord,
	EvidenceObservation,
	FingerprintManifest,
	ObservationContext,
	OperationEffectAssessment,
	PhysicalOperation,
	ProvenPlanShape,
	ResourceAddress,
	SemanticArtifactRef,
	StepJournal,
	TransitionConnectionPool,
} from '@dbsp/types';
import { describe, expect, it, vi } from 'vitest';
import { createApplier } from './applier.js';
import { claimId, evidenceId, semanticArtifactId } from './ids.js';
import type { InProcessProvenPlan } from './index.js';
import { mintInProcessPlan } from './minting.js';
import type {
	OperationObservation,
	OperationRuntime,
	TransitionExecutionClient,
} from './registry.js';
import { createPackRegistry } from './registry.js';

const operationArtifact: SemanticArtifactRef = {
	id: semanticArtifactId('dbsp.mock.operations'),
	version: '0.1.0',
};

const context: ObservationContext = {
	engine: 'postgresql',
	engineVersion: '18',
	databaseId: 'test',
	capabilities: [],
	privileges: [],
	sessionConfiguration: {},
	extensions: {},
};

const operation: PhysicalOperation = {
	ref: 'op',
	operationKind: {
		artifact: operationArtifact,
		name: 'Mock',
	},
	payload: {},
};

const operationA: PhysicalOperation = {
	ref: 'op:a',
	operationKind: {
		artifact: operationArtifact,
		name: 'CommitMarker',
	},
	payload: {},
};

const operationB: PhysicalOperation = {
	ref: 'op:b',
	operationKind: {
		artifact: operationArtifact,
		name: 'UseMarker',
	},
	payload: {},
};

function tableResource(): ResourceAddress {
	return {
		engine: 'postgresql',
		database: 'test',
		kind: 'table',
		name: 'users',
	};
}

function columnResource(): ResourceAddress {
	return {
		engine: 'postgresql',
		database: 'test',
		kind: 'column',
		name: 'age',
		qualifiedBy: ['users'],
	};
}

function operationAssumption(overrides: Partial<Assumption> = {}): Assumption {
	return {
		id: 'mock.operation-pack-semantics' as Assumption['id'],
		class: 'operation-pack-semantics',
		asserter: { kind: 'pack', artifact: operationArtifact },
		statement: 'mock operation semantics are correct',
		scope: [columnResource()],
		...overrides,
	};
}

function userAttestedNativeDefaultAssumption(
	overrides: Partial<Assumption> = {},
): Assumption {
	return {
		id: 'mock.user-attested-native-default' as Assumption['id'],
		class: 'user-attested-native-default',
		asserter: { kind: 'human', identity: 'schema-author' },
		statement:
			'Schema author attests this native SQL column default is unchanged.',
		scope: [columnResource()],
		...overrides,
	};
}

function executionTarget(): TransitionConnectionPool {
	return {
		connect: async () => ({
			query: async () => ({ rows: [] }),
			release: vi.fn(),
		}),
	};
}

function fingerprint(digest: string): FingerprintManifest {
	return {
		algorithm: 'mock',
		semanticModel: operationArtifact,
		includedFacts: [],
		excludedOrUnknownFacts: [],
		digest,
	};
}

function fingerprintWithRelkind(
	digest: string,
	relkind: string,
): FingerprintManifest {
	return {
		...fingerprint(digest),
		includedFacts: [{ key: 'pg_class.relkind', value: relkind }],
	};
}

function evidence(): EvidenceObservation {
	const request = {
		kind: 'mock.before',
		scope: [],
	};
	return {
		role: 'evidence',
		id: evidenceId('mock.before'),
		issuer: operationArtifact,
		request,
		result: { value: { claims: [{ kind: request.kind, holds: true }] } },
		context,
		stability: 'lock-protected',
		takenAt: new Date().toISOString(),
		scope: [],
		source: 'system-catalog',
		validity: { invalidatedBy: [] },
	};
}

function identityClaim(): ProvenPlanShape['claims'][number] {
	return {
		id: claimId('mock.identity'),
		proposition: { kind: 'mock.identity', scope: [columnResource()] },
		scope: [columnResource()],
		supportedBy: [evidenceId('mock.before')],
		assumes: [],
		semantics: [operationArtifact],
		derivedBy: {
			semantics: operationArtifact,
			inputs: [evidenceId('mock.before')],
			proposition: { kind: 'mock.identity', scope: [columnResource()] },
			conclusion: 'established',
		},
	};
}

function claimWithConclusion(
	conclusion:
		| 'established'
		| 'established-under-assumptions'
		| 'undischarged'
		| 'refuted',
	assumes: ProvenPlanShape['claims'][number]['assumes'] = [],
): ProvenPlanShape['claims'][number] {
	const base = {
		id: claimId(`mock.${conclusion}`),
		proposition: { kind: `mock.${conclusion}`, scope: [columnResource()] },
		scope: [columnResource()],
		supportedBy: [evidenceId(`mock.${conclusion}`)],
		assumes,
		semantics: [operationArtifact],
		derivedBy: {
			semantics: operationArtifact,
			inputs: [evidenceId(`mock.${conclusion}`)],
			proposition: {
				kind: `mock.${conclusion}`,
				scope: [columnResource()],
			},
			conclusion,
		},
	};
	return base as ProvenPlanShape['claims'][number];
}

function planShape(overrides: Partial<ProvenPlanShape> = {}): ProvenPlanShape {
	const assumption = operationAssumption();
	return {
		observations: [evidence()],
		claims: [],
		assumptions: [assumption],
		preconditions: [],
		segments: [
			{
				segmentId: 'segment:0',
				stepIds: ['step:op'],
				transaction: 'joins-current',
				commitBoundaryBefore: false,
				commitBoundaryAfter: false,
			},
		],
		steps: [
			{
				stepId: 'step:op',
				segmentId: 'segment:0',
				operation,
				expectedBefore: fingerprint('before'),
				expectedAfter: fingerprint('after'),
				requiredClaims: [],
				establishesClaims: [],
				invalidatesClaims: [],
				guards: [],
				restsOnAssumptions: [assumption.id],
				selectionRationale: {
					chosen: { id: 'mock.rule', pack: operationArtifact },
					overRules: [],
					why: 'test',
				},
			},
		],
		postconditions: [],
		...overrides,
	};
}

function plan(overrides: Partial<ProvenPlanShape> = {}): InProcessProvenPlan {
	return mintInProcessPlan(planShape(overrides));
}

function multiSegmentPlanShape(): ProvenPlanShape {
	const assumption = operationAssumption();
	return {
		observations: [evidence()],
		claims: [],
		assumptions: [assumption],
		preconditions: [],
		segments: [
			{
				segmentId: 'segment:0',
				stepIds: ['step:op:a'],
				transaction: 'requires-new',
				commitBoundaryBefore: false,
				commitBoundaryAfter: true,
			},
			{
				segmentId: 'segment:1',
				stepIds: ['step:op:b'],
				transaction: 'joins-current',
				commitBoundaryBefore: true,
				commitBoundaryAfter: false,
			},
		],
		steps: [
			{
				stepId: 'step:op:a',
				segmentId: 'segment:0',
				operation: operationA,
				expectedBefore: fingerprint('op:a:before'),
				expectedAfter: fingerprint('op:a:after'),
				requiredClaims: [],
				establishesClaims: [],
				invalidatesClaims: [],
				guards: [],
				restsOnAssumptions: [assumption.id],
				selectionRationale: {
					chosen: { id: 'mock.rule.a', pack: operationArtifact },
					overRules: [],
					why: 'test',
				},
			},
			{
				stepId: 'step:op:b',
				segmentId: 'segment:1',
				operation: operationB,
				expectedBefore: fingerprint('op:b:before'),
				expectedAfter: fingerprint('op:b:after'),
				requiredClaims: [],
				establishesClaims: [],
				invalidatesClaims: [],
				guards: [],
				restsOnAssumptions: [assumption.id],
				selectionRationale: {
					chosen: { id: 'mock.rule.b', pack: operationArtifact },
					overRules: [],
					why: 'test',
				},
			},
		],
		postconditions: [],
	};
}

function multiSegmentPlan(): InProcessProvenPlan {
	return mintInProcessPlan(multiSegmentPlanShape());
}

function multiStepSingleSegmentPlan(): InProcessProvenPlan {
	const base = multiSegmentPlanShape();
	return mintInProcessPlan({
		...base,
		segments: [
			{
				segmentId: 'segment:0',
				stepIds: ['step:op:a', 'step:op:b'],
				transaction: 'joins-current',
				commitBoundaryBefore: false,
				commitBoundaryAfter: false,
			},
		],
		steps: base.steps.map((step) => ({ ...step, segmentId: 'segment:0' })),
	});
}

function forbidsTransactionPlan(): InProcessProvenPlan {
	const base = multiSegmentPlanShape();
	return mintInProcessPlan({
		...base,
		segments: [
			base.segments[0]!,
			{
				segmentId: 'segment:1',
				stepIds: ['step:op:b'],
				transaction: 'forbids-transaction',
				commitBoundaryBefore: true,
				commitBoundaryAfter: true,
			},
		],
	});
}

function assessment(): ApplicableAssessment {
	return {
		decision: 'applicable',
		assurance: 'established',
		lifecycle: 'planned',
		continuation: 'none',
		reasons: [
			{
				code: 'proven-applicable',
				claim: claimId('mock.claim'),
				scope: [],
			},
		],
	};
}

function acceptsOperationPolicy(): ApplyPolicy {
	return {
		accepts: [{ class: 'operation-pack-semantics' }],
	};
}

function guard(phase: ApplyGuard['phase']): ApplyGuard {
	return guardFor(operation.ref, phase);
}

function guardFor(
	operationRef: string,
	phase: ApplyGuard['phase'],
): ApplyGuard {
	return {
		appliesTo: operationRef,
		predicate: { kind: `mock.guard.${phase}`, scope: [columnResource()] },
		protocol: {
			kind: 'lock-and-check',
			onFailureLeaves: [],
			binding: {
				kind: 'stable-identity',
				bound: [columnResource()],
				identityClaim: claimId('mock.identity'),
			},
		},
		phase,
	};
}

function planWithStep(
	stepOverrides: Partial<ProvenPlanShape['steps'][number]>,
	planOverrides: Partial<ProvenPlanShape> = {},
): InProcessProvenPlan {
	const base = plan() as ProvenPlanShape;
	return plan({
		...planOverrides,
		steps: [{ ...base.steps[0]!, ...stepOverrides }],
	});
}

function runtime(
	writeObservedJournal: (journal: StepJournal) => void,
	options: {
		readonly log?: string[];
		readonly checkGuard?: OperationRuntime['checkGuard'];
		readonly executeOperation?: OperationRuntime['executeOperation'];
		readonly observeOperation?: OperationRuntime['observeOperation'];
		readonly buildFingerprints?: OperationRuntime['buildFingerprints'];
	} = {},
): OperationRuntime {
	const client: TransitionExecutionClient = { opaqueClient: {} };
	const record = (event: string) => {
		options.log?.push(event);
	};
	return {
		artifact: operationArtifact,
		operationKind: operation.operationKind,
		effectsOf: (): OperationEffectAssessment => ({
			effects: {
				reads: [],
				writes: [],
				locks: [],
				invalidates: [],
				contextMutations: [],
				externalEffects: { accountedFor: [], couldNotAccountFor: [] },
				execution: { transaction: 'joins-current', commitBoundary: 'none' },
			},
			restsOn: [],
		}),
		buildFingerprints:
			options.buildFingerprints ??
			(() => ({
				expectedBefore: fingerprint('before'),
				expectedAfter: fingerprint('after'),
			})),
		checkout: vi.fn(async () => {
			record('checkout');
			return client;
		}),
		release: vi.fn(),
		writeIntentJournal: vi.fn(async (_client, _record: DurableIntentRecord) => {
			record('intent');
		}),
		begin: vi.fn(async () => {
			record('begin');
		}),
		setLockTimeout: vi.fn(async () => {
			record('lock-timeout');
		}),
		acquireLocks: vi.fn(async () => {
			record('lock');
		}),
		observeContext: vi.fn(async () => {
			record('context');
			return context;
		}),
		observeOperation:
			options.observeOperation ??
			vi.fn(
				async (
					_client,
					_operation,
					_context,
					phase,
				): Promise<OperationObservation> => {
					record(`observe:${phase}`);
					return {
						observations: [evidence()],
						fingerprint: fingerprint(phase === 'after' ? 'after' : 'before'),
					};
				},
			),
		checkGuard:
			options.checkGuard ??
			vi.fn(async () => {
				record('guard');
				return {
					passed: true,
					observations: [],
					recovery: [],
				};
			}),
		executeOperation:
			options.executeOperation ??
			vi.fn(async () => {
				record('execute');
				throw new Error('execution failed');
			}),
		writeCompletionJournal: vi.fn(async () => {
			record('completion');
		}),
		commit: vi.fn(async () => {
			record('commit');
		}),
		rollback: vi.fn(async () => {
			record('rollback');
		}),
		writeObservedJournal: vi.fn(async (_client, journal) => {
			record(`observed:${journal.outcome}`);
			writeObservedJournal(journal);
		}),
		isLockTimeout: () => false,
	};
}

function multiSegmentRuntime(
	writeObservedJournal: (journal: StepJournal) => void,
	options: {
		readonly log: string[];
		readonly failB?: boolean;
		readonly transactionMode?: 'multi-segment' | 'single-segment' | 'forbid-b';
		readonly observeContext?: OperationRuntime['observeContext'];
		readonly observeOperation?: OperationRuntime['observeOperation'];
	},
): OperationRuntime {
	let nextClientId = 0;
	const clientId = (client: TransitionExecutionClient): number =>
		(client.opaqueClient as { readonly id: number }).id;
	const record = (event: string) => {
		options.log.push(event);
	};
	return {
		artifact: operationArtifact,
		supportsOperation: (candidate) =>
			candidate.operationKind.artifact.id === operationArtifact.id &&
			candidate.operationKind.artifact.version === operationArtifact.version,
		effectsOf: (candidate): OperationEffectAssessment => {
			const execution =
				options.transactionMode === 'single-segment'
					? {
							transaction: 'joins-current' as const,
							commitBoundary: 'none' as const,
						}
					: options.transactionMode === 'forbid-b' && candidate.ref === 'op:b'
						? {
								transaction: 'forbids-transaction' as const,
								commitBoundary: 'after' as const,
							}
						: candidate.ref === 'op:a'
							? {
									transaction: 'requires-new' as const,
									commitBoundary: 'after' as const,
								}
							: {
									transaction: 'joins-current' as const,
									commitBoundary: 'none' as const,
								};
			return {
				effects: {
					reads:
						candidate.ref === 'op:b'
							? [{ kind: 'table', name: 'composition_marker' }]
							: [],
					writes:
						candidate.ref === 'op:a'
							? [{ kind: 'table', name: 'composition_marker' }]
							: [{ kind: 'table', name: 'composition_consumer' }],
					locks: [],
					invalidates: [],
					contextMutations: [],
					externalEffects: { accountedFor: [], couldNotAccountFor: [] },
					execution,
				},
				restsOn: [],
			};
		},
		buildFingerprints: (candidate) => ({
			expectedBefore: fingerprint(`${candidate.ref}:before`),
			expectedAfter: fingerprint(`${candidate.ref}:after`),
		}),
		checkout: vi.fn(async () => {
			nextClientId += 1;
			record(`checkout:${nextClientId}`);
			return { opaqueClient: { id: nextClientId } };
		}),
		release: vi.fn(async (client) => {
			record(`release:${clientId(client)}`);
		}),
		writeIntentJournal: vi.fn(async (client, recordValue) => {
			record(`intent:${recordValue.stepId}:${clientId(client)}`);
		}),
		begin: vi.fn(async (client) => {
			record(`begin:${clientId(client)}`);
		}),
		setLockTimeout: vi.fn(async () => undefined),
		acquireLocks: vi.fn(async () => undefined),
		observeContext: options.observeContext ?? vi.fn(async () => context),
		observeOperation:
			options.observeOperation ??
			vi.fn(
				async (
					_client,
					candidate,
					_context,
					phase,
				): Promise<OperationObservation> => {
					record(`observe:${candidate.ref}:${phase}`);
					return {
						observations: [evidence()],
						fingerprint: fingerprint(`${candidate.ref}:${phase}`),
					};
				},
			),
		checkGuard: vi.fn(async () => ({
			passed: true,
			observations: [],
			recovery: [],
		})),
		executeOperation: vi.fn(async (client, candidate) => {
			record(`execute:${candidate.ref}:${clientId(client)}`);
			if (options.failB && candidate.ref === 'op:b') {
				throw new Error('forced op:b failure');
			}
			return { kind: 'completed' };
		}),
		writeCompletionJournal: vi.fn(async (client, _operation, recordValue) => {
			record(`completion:${recordValue.stepId}:${clientId(client)}`);
		}),
		commit: vi.fn(async (client) => {
			record(`commit:${clientId(client)}`);
		}),
		rollback: vi.fn(async (client) => {
			record(`rollback:${clientId(client)}`);
		}),
		writeObservedJournal: vi.fn(async (client, journal) => {
			record(
				`observed:${journal.intent.stepId}:${journal.outcome}:${clientId(client)}`,
			);
			writeObservedJournal(journal);
		}),
		isLockTimeout: () => false,
	};
}

describe('createApplier', () => {
	it('refuses an unminted plain plan before authorization, checkout, or DDL', async () => {
		const rt = runtime(() => undefined);
		const registry = createPackRegistry([
			{
				rules: [],
				operationSemantics: [rt],
				issuer: {
					artifact: operationArtifact,
					execute: async () => evidence(),
				},
			},
		]);
		const connect = vi.fn(async () => ({
			query: async () => ({ rows: [] }),
			release: vi.fn(),
		}));
		const target: TransitionConnectionPool = { connect };

		const result = await createApplier(registry).apply(
			{ plan: planShape(), assessment: assessment() } as Parameters<
				ReturnType<typeof createApplier>['apply']
			>[0],
			acceptsOperationPolicy(),
			target,
		);

		expect(result.assessment.reasons[0]).toMatchObject({
			code: 'context-mismatch',
			fact: {
				key: 'proven-plan',
				value:
					'plan was not minted by prove() in this process; applying a serialized plan is a separate, not-yet-available API (roadmap: identity & adoption)',
			},
		});
		expect(connect).not.toHaveBeenCalled();
		expect(rt.checkout).not.toHaveBeenCalled();
		expect(rt.writeIntentJournal).not.toHaveBeenCalled();
		expect(rt.acquireLocks).not.toHaveBeenCalled();
		expect(rt.executeOperation).not.toHaveBeenCalled();
	});

	it('lets a genuinely minted plan pass the capability gate', async () => {
		const observed: StepJournal[] = [];
		const rt = runtime(
			(journal) => {
				observed.push(journal);
			},
			{
				executeOperation: vi.fn(async () => ({ kind: 'completed' })),
			},
		);
		const registry = createPackRegistry([
			{
				rules: [],
				operationSemantics: [rt],
				issuer: {
					artifact: operationArtifact,
					execute: async () => evidence(),
				},
			},
		]);

		const result = await createApplier(registry).apply(
			{ plan: plan(), assessment: assessment() },
			acceptsOperationPolicy(),
			executionTarget(),
		);

		expect(result.assessment.lifecycle).toBe('completed');
		expect(result.journals[0]?.outcome).toBe('completed');
		expect(observed[0]?.outcome).toBe('completed');
		expect(rt.checkout).toHaveBeenCalledOnce();
	});

	it('derives the completed assessment from the minted plan instead of the caller assessment', async () => {
		const observed: StepJournal[] = [];
		const rt = runtime(
			(journal) => {
				observed.push(journal);
			},
			{
				executeOperation: vi.fn(async () => ({ kind: 'completed' })),
			},
		);
		const registry = createPackRegistry([
			{
				rules: [],
				operationSemantics: [rt],
				issuer: {
					artifact: operationArtifact,
					execute: async () => evidence(),
				},
			},
		]);
		const forgedAssessment: ApplicableAssessment = {
			...assessment(),
			assurance: 'established',
			reasons: [
				{
					code: 'proven-applicable',
					claim: claimId('forged.established'),
					scope: [],
				},
			],
		};

		const result = await createApplier(registry).apply(
			{ plan: plan(), assessment: forgedAssessment },
			acceptsOperationPolicy(),
			executionTarget(),
		);

		expect(result.assessment.lifecycle).toBe('completed');
		expect(result.assessment.assurance).toBe('accepted-under-assumptions');
		expect(result.assessment.reasons[0]).toMatchObject({
			code: 'proven-applicable',
			claim: claimId('dbsp.transition.claim.plan'),
		});
		expect(observed[0]?.outcome).toBe('completed');
	});

	it('dispatches commit-boundary segments in separate transactions', async () => {
		const observed: StepJournal[] = [];
		const log: string[] = [];
		const rt = multiSegmentRuntime(
			(journal) => {
				observed.push(journal);
			},
			{ log },
		);
		const registry = createPackRegistry([
			{
				rules: [],
				operationSemantics: [rt],
				issuer: {
					artifact: operationArtifact,
					execute: async () => evidence(),
				},
			},
		]);

		const result = await createApplier(registry).apply(
			{ plan: multiSegmentPlan(), assessment: assessment() },
			acceptsOperationPolicy(),
			executionTarget(),
		);

		expect(result.assessment.lifecycle).toBe('completed');
		expect(result.journals.map((journal) => journal.intent.stepId)).toEqual([
			'step:op:a',
			'step:op:b',
		]);
		expect(observed.map((journal) => journal.outcome)).toEqual([
			'completed',
			'completed',
		]);
		expect(log.filter((entry) => entry.startsWith('checkout:'))).toEqual([
			'checkout:1',
			'checkout:2',
		]);
		expect(log.indexOf('commit:1')).toBeLessThan(log.indexOf('begin:2'));
		expect(log).toContain('execute:op:a:1');
		expect(log).toContain('execute:op:b:2');
		expect(log).toContain('commit:2');
	});

	it('keeps an earlier committed segment when a later segment fails', async () => {
		const observed: StepJournal[] = [];
		const log: string[] = [];
		const rt = multiSegmentRuntime(
			(journal) => {
				observed.push(journal);
			},
			{ log, failB: true },
		);
		const registry = createPackRegistry([
			{
				rules: [],
				operationSemantics: [rt],
				issuer: {
					artifact: operationArtifact,
					execute: async () => evidence(),
				},
			},
		]);

		const result = await createApplier(registry).apply(
			{ plan: multiSegmentPlan(), assessment: assessment() },
			acceptsOperationPolicy(),
			executionTarget(),
		);

		expect(result.assessment.decision).toBe('blocked');
		expect(result.assessment.lifecycle).toBe('partially-applied');
		expect(result.assessment.continuation).toBe('resume-possible');
		expect(result.assessment.reasons[0]?.code).toBe('partially-applied');
		expect(result.journals.map((journal) => journal.intent.stepId)).toEqual([
			'step:op:a',
			'step:op:b',
		]);
		expect(result.journals.map((journal) => journal.outcome)).toEqual([
			'completed',
			'partially-applied',
		]);
		expect(log).toContain('commit:1');
		expect(log).toContain('rollback:2');
		expect(log).not.toContain('rollback:1');
		expect(log).not.toContain('commit:2');
		expect(observed.map((journal) => journal.outcome)).toEqual([
			'completed',
			'partially-applied',
		]);
	});

	it('attributes committed multi-step after-observation failures to the observed step and journals the segment', async () => {
		const observed: StepJournal[] = [];
		const log: string[] = [];
		const afterContexts: string[] = [];
		const contextFor = (ref: string): ObservationContext => ({
			...context,
			databaseId: ref,
			sessionConfiguration: { step: ref },
		});
		const rt = multiSegmentRuntime(
			(journal) => {
				observed.push(journal);
			},
			{
				log,
				transactionMode: 'single-segment',
				observeContext: vi.fn(async (_client, candidate) =>
					contextFor(candidate.ref),
				),
				observeOperation: vi.fn(
					async (
						_client,
						candidate,
						ctx,
						phase,
					): Promise<OperationObservation> => {
						if (phase === 'after') {
							afterContexts.push(`${candidate.ref}:${ctx.databaseId}`);
						}
						if (candidate.ref === 'op:a' && phase === 'after') {
							throw new Error('forced op:a after failure');
						}
						return {
							observations: [
								{
									...evidence(),
									id: evidenceId(`mock.${candidate.ref}.${phase}`),
									context: ctx,
								},
							],
							fingerprint: fingerprint(`${candidate.ref}:${phase}`),
						};
					},
				),
			},
		);
		const registry = createPackRegistry([
			{
				rules: [],
				operationSemantics: [rt],
				issuer: {
					artifact: operationArtifact,
					execute: async () => evidence(),
				},
			},
		]);

		const result = await createApplier(registry).apply(
			{ plan: multiStepSingleSegmentPlan(), assessment: assessment() },
			acceptsOperationPolicy(),
			executionTarget(),
		);

		expect(result.assessment.decision).toBe('blocked');
		expect(result.assessment.reasons[0]).toMatchObject({
			code: 'partially-applied',
			stepId: 'step:op:a',
			operationRef: 'op:a',
		});
		expect(result.journals.map((journal) => journal.intent.stepId)).toEqual([
			'step:op:a',
			'step:op:b',
		]);
		expect(result.journals.map((journal) => journal.outcome)).toEqual([
			'partially-applied',
			'completed',
		]);
		expect(observed.map((journal) => journal.intent.stepId)).toEqual([
			'step:op:a',
			'step:op:b',
		]);
		expect(afterContexts).toEqual(['op:a:op:a', 'op:b:op:b']);
	});

	it('reports a forbids-transaction failure after an earlier committed segment as resumable partial work', async () => {
		const observed: StepJournal[] = [];
		const log: string[] = [];
		const rt = multiSegmentRuntime(
			(journal) => {
				observed.push(journal);
			},
			{ log, failB: true, transactionMode: 'forbid-b' },
		);
		const registry = createPackRegistry([
			{
				rules: [],
				operationSemantics: [rt],
				issuer: {
					artifact: operationArtifact,
					execute: async () => evidence(),
				},
			},
		]);

		const result = await createApplier(registry).apply(
			{ plan: forbidsTransactionPlan(), assessment: assessment() },
			acceptsOperationPolicy(),
			executionTarget(),
		);

		expect(result.assessment.decision).toBe('blocked');
		expect(result.assessment.lifecycle).toBe('partially-applied');
		expect(result.assessment.lifecycle).not.toBe('outcome-unknown');
		expect(result.assessment.continuation).toBe('resume-possible');
		expect(result.assessment.reasons[0]?.code).toBe('partially-applied');
		expect(result.journals.map((journal) => journal.intent.stepId)).toEqual([
			'step:op:a',
			'step:op:b',
		]);
		expect(result.journals.map((journal) => journal.outcome)).toEqual([
			'completed',
			'partially-applied',
		]);
		expect(observed.map((journal) => journal.outcome)).toEqual([
			'completed',
			'partially-applied',
		]);
		expect(log).toContain('commit:1');
		expect(log).not.toContain('rollback:1');
		expect(log).not.toContain('rollback:2');
	});

	it('reports a forbids-transaction after-guard failure after execution as partially applied', async () => {
		const observed: StepJournal[] = [];
		const log: string[] = [];
		const baseRuntime = multiSegmentRuntime(
			(journal) => {
				observed.push(journal);
			},
			{ log, transactionMode: 'forbid-b' },
		);
		const rt: OperationRuntime = {
			...baseRuntime,
			checkGuard: vi.fn(async (_client, candidate, checkedGuard) => ({
				passed: !(
					candidate.ref === 'op:b' && checkedGuard.phase === 'after-operation'
				),
				observations: [],
				recovery: [],
			})),
		};
		const registry = createPackRegistry([
			{
				rules: [],
				operationSemantics: [rt],
				issuer: {
					artifact: operationArtifact,
					execute: async () => evidence(),
				},
			},
		]);
		const base = forbidsTransactionPlan() as ProvenPlanShape;
		const guarded = mintInProcessPlan({
			...base,
			claims: [identityClaim()],
			steps: base.steps.map((step) =>
				step.operation.ref === 'op:b'
					? {
							...step,
							requiredClaims: [claimId('mock.identity')],
							guards: [guardFor('op:b', 'after-operation')],
						}
					: step,
			),
		});

		const result = await createApplier(registry).apply(
			{ plan: guarded, assessment: assessment() },
			acceptsOperationPolicy(),
			executionTarget(),
		);

		expect(result.assessment.decision).toBe('blocked');
		expect(result.assessment.lifecycle).toBe('partially-applied');
		expect(result.assessment.continuation).toBe('resume-possible');
		expect(result.assessment.reasons[0]?.code).toBe('guard-failed');
		expect(result.journals.map((journal) => journal.intent.stepId)).toEqual([
			'step:op:a',
			'step:op:b',
		]);
		expect(result.journals.map((journal) => journal.outcome)).toEqual([
			'completed',
			'partially-applied',
		]);
		expect(observed.map((journal) => journal.outcome)).toEqual([
			'completed',
			'partially-applied',
		]);
		expect(log).toContain('execute:op:b:2');
		expect(log).toContain('commit:1');
		expect(log).not.toContain('rollback:2');
	});

	it('persists an unknown-step-result journal on the generic error path', async () => {
		const observed: StepJournal[] = [];
		const registry = createPackRegistry([
			{
				rules: [],
				operationSemantics: [
					runtime((journal) => {
						observed.push(journal);
					}),
				],
				issuer: {
					artifact: operationArtifact,
					execute: async () => evidence(),
				},
			},
		]);
		const result = await createApplier(registry).apply(
			{ plan: plan(), assessment: assessment() },
			acceptsOperationPolicy(),
			executionTarget(),
		);

		expect(result.assessment.reasons[0]?.code).toBe('unknown-step-result');
		expect(result.journals[0]?.outcome).toBe('unknown-step-result');
		expect(observed[0]?.outcome).toBe('unknown-step-result');
	});

	it('diagnoses a minted plan with broken guard references before checkout', async () => {
		const rt = runtime(() => undefined);
		const registry = createPackRegistry([
			{
				rules: [],
				operationSemantics: [rt],
				issuer: {
					artifact: operationArtifact,
					execute: async () => evidence(),
				},
			},
		]);
		const tampered = planWithStep({
			guards: [{ ...guard('before-operation'), appliesTo: 'missing' }],
		});

		await expect(
			createApplier(registry).apply(
				{ plan: tampered, assessment: assessment() },
				acceptsOperationPolicy(),
				executionTarget(),
			),
		).rejects.toThrow(
			/internal error: minted proven plan violated relational invariants/,
		);

		expect(rt.checkout).not.toHaveBeenCalled();
	});

	it('diagnoses a minted plan that coalesces across a required commit boundary before checkout', async () => {
		const observed: StepJournal[] = [];
		const log: string[] = [];
		const baseRuntime = multiSegmentRuntime(
			(journal) => {
				observed.push(journal);
			},
			{ log, transactionMode: 'single-segment' },
		);
		const rt: OperationRuntime = {
			...baseRuntime,
			effectsOf: (candidate): OperationEffectAssessment => {
				const base = baseRuntime.effectsOf(candidate);
				return {
					...base,
					effects: {
						...base.effects,
						execution:
							candidate.ref === 'op:a'
								? {
										transaction: 'joins-current',
										commitBoundary: 'after',
									}
								: base.effects.execution,
					},
				};
			},
		};
		const registry = createPackRegistry([
			{
				rules: [],
				operationSemantics: [rt],
				issuer: {
					artifact: operationArtifact,
					execute: async () => evidence(),
				},
			},
		]);

		await expect(
			createApplier(registry).apply(
				{ plan: multiStepSingleSegmentPlan(), assessment: assessment() },
				acceptsOperationPolicy(),
				executionTarget(),
			),
		).rejects.toThrow(
			/internal error: minted proven plan violated relational invariants/,
		);

		expect(rt.checkout).not.toHaveBeenCalled();
		expect(observed).toEqual([]);
	});

	it.each([
		'refuted',
		'undischarged',
	] as const)('diagnoses a minted plan with a %s required claim before checkout', async (conclusion) => {
		const rt = runtime(() => undefined);
		const registry = createPackRegistry([
			{
				rules: [],
				operationSemantics: [rt],
				issuer: {
					artifact: operationArtifact,
					execute: async () => evidence(),
				},
			},
		]);
		const forgedClaim = claimWithConclusion(conclusion);
		const tampered = planWithStep(
			{ requiredClaims: [forgedClaim.id] },
			{ claims: [forgedClaim] },
		);

		await expect(
			createApplier(registry).apply(
				{ plan: tampered, assessment: assessment() },
				acceptsOperationPolicy(),
				executionTarget(),
			),
		).rejects.toThrow(
			/internal error: minted proven plan violated relational invariants/,
		);

		expect(rt.checkout).not.toHaveBeenCalled();
	});

	it.each([
		[
			'established-under-assumptions with empty assumes',
			claimWithConclusion('established-under-assumptions', []),
			/must list at least one assumption/,
		],
		[
			'established with non-empty assumes',
			claimWithConclusion('established', [operationAssumption().id]),
			/must not assume/,
		],
	] as const)('diagnoses a minted plan with a malformed %s required claim before checkout', async (_label, forgedClaim, expectedDetail) => {
		const rt = runtime(() => undefined);
		const registry = createPackRegistry([
			{
				rules: [],
				operationSemantics: [rt],
				issuer: {
					artifact: operationArtifact,
					execute: async () => evidence(),
				},
			},
		]);
		const tampered = planWithStep(
			{ requiredClaims: [forgedClaim.id] },
			{ claims: [forgedClaim] },
		);

		await expect(
			createApplier(registry).apply(
				{ plan: tampered, assessment: assessment() },
				acceptsOperationPolicy(),
				executionTarget(),
			),
		).rejects.toThrow(expectedDetail);

		expect(rt.checkout).not.toHaveBeenCalled();
	});

	it('diagnoses a minted plan with a claim citing a missing observation before checkout', async () => {
		const rt = runtime(() => undefined);
		const registry = createPackRegistry([
			{
				rules: [],
				operationSemantics: [rt],
				issuer: {
					artifact: operationArtifact,
					execute: async () => evidence(),
				},
			},
		]);
		const forgedClaim = claimWithConclusion('established');
		const tampered = planWithStep(
			{ requiredClaims: [forgedClaim.id] },
			{ claims: [forgedClaim] },
		);

		await expect(
			createApplier(registry).apply(
				{ plan: tampered, assessment: assessment() },
				acceptsOperationPolicy(),
				executionTarget(),
			),
		).rejects.toThrow(
			/internal error: minted proven plan violated relational invariants/,
		);

		expect(rt.checkout).not.toHaveBeenCalled();
	});

	it('diagnoses duplicate claim ids on an already-minted plan before checkout', async () => {
		const rt = runtime(() => undefined);
		const registry = createPackRegistry([
			{
				rules: [],
				operationSemantics: [rt],
				issuer: {
					artifact: operationArtifact,
					execute: async () => evidence(),
				},
			},
		]);
		const duplicateClaim = identityClaim();
		const tampered = plan({
			claims: [duplicateClaim, duplicateClaim],
		});

		await expect(
			createApplier(registry).apply(
				{ plan: tampered, assessment: assessment() },
				acceptsOperationPolicy(),
				executionTarget(),
			),
		).rejects.toThrow(
			/internal error: minted proven plan violated relational invariants/,
		);

		expect(rt.checkout).not.toHaveBeenCalled();
	});

	it('diagnoses duplicate observation ids on an already-minted plan before checkout', async () => {
		const rt = runtime(() => undefined);
		const registry = createPackRegistry([
			{
				rules: [],
				operationSemantics: [rt],
				issuer: {
					artifact: operationArtifact,
					execute: async () => evidence(),
				},
			},
		]);
		const duplicate = evidence();
		const tampered = plan({
			observations: [duplicate, duplicate],
		});

		await expect(
			createApplier(registry).apply(
				{ plan: tampered, assessment: assessment() },
				acceptsOperationPolicy(),
				executionTarget(),
			),
		).rejects.toThrow(
			/internal error: minted proven plan violated relational invariants/,
		);

		expect(rt.checkout).not.toHaveBeenCalled();
	});

	it('diagnoses a minted plan missing the operation-pack assumption before checkout', async () => {
		const rt = runtime(() => undefined);
		const registry = createPackRegistry([
			{
				rules: [],
				operationSemantics: [rt],
				issuer: {
					artifact: operationArtifact,
					execute: async () => evidence(),
				},
			},
		]);
		const base = plan() as ProvenPlanShape;
		const tampered = plan({
			assumptions: [],
			steps: [{ ...base.steps[0]!, restsOnAssumptions: [] }],
		});

		await expect(
			createApplier(registry).apply(
				{ plan: tampered, assessment: assessment() },
				acceptsOperationPolicy(),
				executionTarget(),
			),
		).rejects.toThrow(
			/internal error: minted proven plan violated relational invariants/,
		);

		expect(rt.checkout).not.toHaveBeenCalled();
	});

	it('default-denies a global assumption under a narrow scoped policy', async () => {
		const globalAssumption = operationAssumption({ scope: [] });
		const rt = runtime(() => undefined);
		const registry = createPackRegistry([
			{
				rules: [],
				operationSemantics: [rt],
				issuer: {
					artifact: operationArtifact,
					execute: async () => evidence(),
				},
			},
		]);
		const scopedPolicy: ApplyPolicy = {
			accepts: [
				{
					class: 'operation-pack-semantics',
					withinScope: [{ within: tableResource() }],
				},
			],
		};
		const scopedPlan = planWithStep(
			{ restsOnAssumptions: [globalAssumption.id] },
			{ assumptions: [globalAssumption] },
		);

		const result = await createApplier(registry).apply(
			{ plan: scopedPlan, assessment: assessment() },
			scopedPolicy,
			executionTarget(),
		);

		expect(result.assessment.reasons[0]?.code).toBe('uncomposable');
		expect(rt.checkout).not.toHaveBeenCalled();
	});

	it('matches a child column resource within its parent table scope', async () => {
		const scopedAssumption = operationAssumption({ scope: [columnResource()] });
		const observed: StepJournal[] = [];
		const rt = runtime(
			(journal) => {
				observed.push(journal);
			},
			{
				executeOperation: vi.fn(async () => ({ kind: 'completed' })),
			},
		);
		const registry = createPackRegistry([
			{
				rules: [],
				operationSemantics: [rt],
				issuer: {
					artifact: operationArtifact,
					execute: async () => evidence(),
				},
			},
		]);
		const scopedPlan = planWithStep(
			{ restsOnAssumptions: [scopedAssumption.id] },
			{ assumptions: [scopedAssumption] },
		);

		const result = await createApplier(registry).apply(
			{ plan: scopedPlan, assessment: assessment() },
			{
				accepts: [
					{
						class: 'operation-pack-semantics',
						withinScope: [{ within: tableResource() }],
					},
				],
			},
			executionTarget(),
		);

		expect(result.assessment.lifecycle).toBe('completed');
		expect(observed[0]?.outcome).toBe('completed');
	});

	it('requires policy acceptance for user-attested native default assumptions', async () => {
		const operation = operationAssumption();
		const nativeDefault = userAttestedNativeDefaultAssumption();
		const rt = runtime(() => undefined, {
			executeOperation: vi.fn(async () => ({ kind: 'completed' })),
		});
		const registry = createPackRegistry([
			{
				rules: [],
				operationSemantics: [rt],
				issuer: {
					artifact: operationArtifact,
					execute: async () => evidence(),
				},
			},
		]);
		const scopedPlan = planWithStep(
			{ restsOnAssumptions: [operation.id, nativeDefault.id] },
			{ assumptions: [operation, nativeDefault] },
		);

		const denied = await createApplier(registry).apply(
			{ plan: scopedPlan, assessment: assessment() },
			acceptsOperationPolicy(),
			executionTarget(),
		);

		expect(denied.assessment.reasons[0]).toMatchObject({
			code: 'uncomposable',
			assumption: nativeDefault.id,
		});
		expect(rt.checkout).not.toHaveBeenCalled();

		const accepted = await createApplier(registry).apply(
			{ plan: scopedPlan, assessment: assessment() },
			{
				accepts: [
					{ class: 'operation-pack-semantics' },
					{
						class: 'user-attested-native-default',
						fromTrustRoot: nativeDefault.asserter,
						withinScope: [{ within: tableResource() }],
					},
				],
			},
			executionTarget(),
		);

		expect(accepted.assessment.lifecycle).toBe('completed');
	});

	it('returns an ApplyResult when checkout fails', async () => {
		const rt: OperationRuntime = {
			...runtime(() => undefined),
			checkout: vi.fn(async () => {
				throw new Error('checkout failed');
			}),
		};
		const registry = createPackRegistry([
			{
				rules: [],
				operationSemantics: [rt],
				issuer: {
					artifact: operationArtifact,
					execute: async () => evidence(),
				},
			},
		]);

		const result = await createApplier(registry).apply(
			{ plan: plan(), assessment: assessment() },
			acceptsOperationPolicy(),
			executionTarget(),
		);

		expect(result.assessment.reasons[0]?.code).toBe('unknown-step-result');
		expect(result.journals[0]?.intent.stepId).toBe('step:op');
		expect(rt.release).not.toHaveBeenCalled();
	});

	it('does not let release failure mask a completed result', async () => {
		const observed: StepJournal[] = [];
		const rt: OperationRuntime = {
			...runtime(
				(journal) => {
					observed.push(journal);
				},
				{
					executeOperation: vi.fn(async () => ({ kind: 'completed' })),
				},
			),
			release: vi.fn(() => {
				throw new Error('release failed');
			}),
		};
		const registry = createPackRegistry([
			{
				rules: [],
				operationSemantics: [rt],
				issuer: {
					artifact: operationArtifact,
					execute: async () => evidence(),
				},
			},
		]);

		const result = await createApplier(registry).apply(
			{ plan: plan(), assessment: assessment() },
			acceptsOperationPolicy(),
			executionTarget(),
		);

		expect(result.assessment.lifecycle).toBe('completed');
		expect(observed[0]?.outcome).toBe('completed');
		expect(rt.release).toHaveBeenCalledOnce();
	});

	it('uses the operation pack issuer for apply-time observations', async () => {
		const wrongExecute = vi.fn(async () => evidence());
		const correctExecute = vi.fn(async () => evidence());
		const observed: StepJournal[] = [];
		const rt = runtime(
			(journal) => {
				observed.push(journal);
			},
			{
				executeOperation: vi.fn(async () => ({ kind: 'completed' })),
				observeOperation: vi.fn(
					async (_client, _operation, ctx, phase, observationIssuer) => ({
						observations: [
							await observationIssuer.execute(
								{ kind: `mock.${phase}`, scope: [] },
								{},
								ctx,
							),
						],
						fingerprint: fingerprint(phase === 'after' ? 'after' : 'before'),
					}),
				),
			},
		);
		const registry = createPackRegistry([
			{
				rules: [],
				operationSemantics: [],
				issuer: {
					artifact: {
						id: semanticArtifactId('dbsp.mock.wrong-issuer'),
						version: '0.1.0',
					},
					execute: wrongExecute,
				},
			},
			{
				rules: [],
				operationSemantics: [rt],
				issuer: {
					artifact: operationArtifact,
					execute: correctExecute,
				},
			},
		]);

		const result = await createApplier(registry).apply(
			{ plan: plan(), assessment: assessment() },
			acceptsOperationPolicy(),
			executionTarget(),
		);

		expect(result.assessment.lifecycle).toBe('completed');
		expect(observed[0]?.outcome).toBe('completed');
		expect(wrongExecute).not.toHaveBeenCalled();
		expect(correctExecute).toHaveBeenCalledTimes(2);
	});

	it('journals a known context-mismatch when expectedBefore changes before DDL', async () => {
		const observed: StepJournal[] = [];
		const executeOperation = vi.fn(async () => ({ kind: 'completed' }));
		const rt = runtime(
			(journal) => {
				observed.push(journal);
			},
			{
				executeOperation,
				buildFingerprints: () => ({
					expectedBefore: fingerprint('changed-before'),
					expectedAfter: fingerprint('after'),
				}),
			},
		);
		const registry = createPackRegistry([
			{
				rules: [],
				operationSemantics: [rt],
				issuer: {
					artifact: operationArtifact,
					execute: async () => evidence(),
				},
			},
		]);

		const result = await createApplier(registry).apply(
			{ plan: plan(), assessment: assessment() },
			acceptsOperationPolicy(),
			executionTarget(),
		);

		expect(result.assessment.reasons[0]?.code).toBe('context-mismatch');
		expect(result.journals[0]?.outcome).toBe('context-mismatch');
		expect(observed[0]?.outcome).toBe('context-mismatch');
		expect(executeOperation).not.toHaveBeenCalled();
		expect(rt.rollback).toHaveBeenCalledOnce();
	});

	it('blocks before DDL when a relkind fingerprint fact drifts at apply time', async () => {
		const observed: StepJournal[] = [];
		const executeOperation = vi.fn(async () => ({ kind: 'completed' }));
		const rt = runtime(
			(journal) => {
				observed.push(journal);
			},
			{
				executeOperation,
				buildFingerprints: () => ({
					expectedBefore: fingerprintWithRelkind('relkind:p', 'p'),
					expectedAfter: fingerprint('after'),
				}),
			},
		);
		const registry = createPackRegistry([
			{
				rules: [],
				operationSemantics: [rt],
				issuer: {
					artifact: operationArtifact,
					execute: async () => evidence(),
				},
			},
		]);
		const relkindAnchoredPlan = planWithStep({
			expectedBefore: fingerprintWithRelkind('relkind:r', 'r'),
		});

		const result = await createApplier(registry).apply(
			{ plan: relkindAnchoredPlan, assessment: assessment() },
			acceptsOperationPolicy(),
			executionTarget(),
		);

		expect(result.assessment.decision).toBe('blocked');
		expect(result.assessment.reasons[0]?.code).toBe('context-mismatch');
		expect(result.journals[0]?.outcome).toBe('context-mismatch');
		expect(observed[0]?.outcome).toBe('context-mismatch');
		expect(executeOperation).not.toHaveBeenCalled();
	});

	it('treats a volatile before-operation guard failure as guard-failed, not inapplicable', async () => {
		const observed: StepJournal[] = [];
		const executeOperation = vi.fn(async () => ({ kind: 'completed' }));
		const rt = runtime(
			(journal) => {
				observed.push(journal);
			},
			{
				executeOperation,
				checkGuard: vi.fn(async () => ({
					passed: false,
					observations: [],
					recovery: [],
				})),
			},
		);
		const registry = createPackRegistry([
			{
				rules: [],
				operationSemantics: [rt],
				issuer: {
					artifact: operationArtifact,
					execute: async () => evidence(),
				},
			},
		]);
		const guarded = planWithStep(
			{
				guards: [guard('before-operation')],
				requiredClaims: [claimId('mock.identity')],
			},
			{ claims: [identityClaim()] },
		);

		const result = await createApplier(registry).apply(
			{ plan: guarded, assessment: assessment() },
			acceptsOperationPolicy(),
			executionTarget(),
		);

		expect(result.assessment.decision).toBe('blocked');
		expect(result.assessment.reasons[0]?.code).toBe('guard-failed');
		expect(result.journals[0]?.outcome).toBe('guard-failed');
		expect(observed[0]?.outcome).toBe('guard-failed');
		expect(executeOperation).not.toHaveBeenCalled();
	});

	it('journals a runtime engine guard failure as guard-failed', async () => {
		const observed: StepJournal[] = [];
		const duringGuard = guard('during-operation');
		const rt = runtime(
			(journal) => {
				observed.push(journal);
			},
			{
				executeOperation: vi.fn(async () => ({
					kind: 'guard-failed',
					guard: duringGuard,
					recovery: [],
				})),
			},
		);
		const registry = createPackRegistry([
			{
				rules: [],
				operationSemantics: [rt],
				issuer: {
					artifact: operationArtifact,
					execute: async () => evidence(),
				},
			},
		]);
		const guarded = planWithStep(
			{
				guards: [duringGuard],
				requiredClaims: [claimId('mock.identity')],
			},
			{ claims: [identityClaim()] },
		);

		const result = await createApplier(registry).apply(
			{ plan: guarded, assessment: assessment() },
			acceptsOperationPolicy(),
			executionTarget(),
		);

		expect(result.assessment.decision).toBe('blocked');
		expect(result.assessment.lifecycle).toBe('planned');
		expect(result.assessment.reasons[0]).toMatchObject({
			code: 'guard-failed',
			operationRef: operation.ref,
		});
		expect(result.journals[0]?.outcome).toBe('guard-failed');
		expect(observed[0]?.outcome).toBe('guard-failed');
	});

	it('surfaces runtime partial recovery artefacts as resume-possible', async () => {
		const observed: StepJournal[] = [];
		const recovery = [
			{
				kind: 'invalid-index',
				resource: {
					engine: 'postgresql',
					database: 'test',
					schema: 'public',
					kind: 'index',
					name: 'idx_users_email',
					qualifiedBy: ['users'],
				},
			},
		];
		const rt = runtime(
			(journal) => {
				observed.push(journal);
			},
			{
				executeOperation: vi.fn(async () => ({
					kind: 'partially-applied',
					recovery,
					detail: 'invalid index cleanup did not remove the target index',
				})),
			},
		);
		const registry = createPackRegistry([
			{
				rules: [],
				operationSemantics: [rt],
				issuer: {
					artifact: operationArtifact,
					execute: async () => evidence(),
				},
			},
		]);

		const result = await createApplier(registry).apply(
			{ plan: plan(), assessment: assessment() },
			acceptsOperationPolicy(),
			executionTarget(),
		);

		expect(result.assessment.decision).toBe('blocked');
		expect(result.assessment.lifecycle).toBe('partially-applied');
		expect(result.assessment.continuation).toBe('resume-possible');
		expect(result.assessment.reasons[0]).toMatchObject({
			code: 'partially-applied',
			recovery,
		});
		expect(result.journals[0]).toMatchObject({
			outcome: 'partially-applied',
			recovery,
		});
		expect(observed[0]).toMatchObject({
			outcome: 'partially-applied',
			recovery,
		});
	});

	it('runs after-operation guards after the operation executes', async () => {
		const log: string[] = [];
		const rt = runtime(() => undefined, {
			log,
			executeOperation: vi.fn(async () => {
				log.push('execute');
				return { kind: 'completed' };
			}),
			checkGuard: vi.fn(async (_client, _operation, checkedGuard) => {
				log.push(`guard:${checkedGuard.phase}`);
				return { passed: true, observations: [], recovery: [] };
			}),
		});
		const registry = createPackRegistry([
			{
				rules: [],
				operationSemantics: [rt],
				issuer: {
					artifact: operationArtifact,
					execute: async () => evidence(),
				},
			},
		]);
		const phasedPlan = planWithStep(
			{
				guards: [guard('before-operation'), guard('after-operation')],
				requiredClaims: [claimId('mock.identity')],
			},
			{ claims: [identityClaim()] },
		);

		const result = await createApplier(registry).apply(
			{ plan: phasedPlan, assessment: assessment() },
			acceptsOperationPolicy(),
			executionTarget(),
		);

		expect(result.assessment.lifecycle).toBe('completed');
		expect(log.indexOf('guard:before-operation')).toBeLessThan(
			log.indexOf('execute'),
		);
		expect(log.indexOf('guard:after-operation')).toBeGreaterThan(
			log.indexOf('execute'),
		);
	});
});
