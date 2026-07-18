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
	ExecutionCoordinator,
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

function firstSegmentForbidsTransactionPlan(): InProcessProvenPlan {
	const base = multiSegmentPlanShape();
	return mintInProcessPlan({
		...base,
		segments: [
			{
				...base.segments[0]!,
				transaction: 'forbids-transaction',
				commitBoundaryAfter: true,
			},
			base.segments[1]!,
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
		predicate: {
			kind: `mock.guard.${phase}`,
			target: columnResource(),
			scope: [columnResource()],
		},
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
		readonly observeContext?: OperationRuntime['observeContext'];
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
			restsOn: [operationAssumption()],
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
		observeContext:
			options.observeContext ??
			vi.fn(async () => {
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
		readonly transactionMode?:
			| 'multi-segment'
			| 'single-segment'
			| 'forbid-a'
			| 'forbid-b';
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
					: options.transactionMode === 'forbid-a' && candidate.ref === 'op:a'
						? {
								transaction: 'forbids-transaction' as const,
								commitBoundary: 'after' as const,
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
				restsOn: [operationAssumption()],
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

function sharedCoordinator(log: string[]): ExecutionCoordinator {
	let nextClientId = 0;
	const clientId = (client: TransitionExecutionClient): number =>
		(client.opaqueClient as { readonly id: number }).id;
	const record = (event: string) => {
		log.push(event);
	};
	return {
		transactionDomain: 'mock.shared-transaction-domain',
		checkout: vi.fn(async () => {
			nextClientId += 1;
			record(`coordinator:checkout:${nextClientId}`);
			return { opaqueClient: { id: nextClientId } };
		}),
		release: vi.fn(async (client) => {
			record(`coordinator:release:${clientId(client)}`);
		}),
		begin: vi.fn(async (client) => {
			record(`coordinator:begin:${clientId(client)}`);
		}),
		setLockTimeout: vi.fn(async (client) => {
			record(`coordinator:lock-timeout:${clientId(client)}`);
		}),
		commit: vi.fn(async (client) => {
			record(`coordinator:commit:${clientId(client)}`);
		}),
		rollback: vi.fn(async (client) => {
			record(`coordinator:rollback:${clientId(client)}`);
		}),
		isLockTimeout: () => false,
	};
}

function runtimeForOperation(
	targetOperation: PhysicalOperation,
	writeObservedJournal: (journal: StepJournal) => void,
	log: string[],
): OperationRuntime {
	const base = multiSegmentRuntime(writeObservedJournal, {
		log,
		transactionMode: 'single-segment',
	});
	return {
		...base,
		operationKind: targetOperation.operationKind,
		supportsOperation: (candidate) =>
			candidate.operationKind.artifact.id ===
				targetOperation.operationKind.artifact.id &&
			candidate.operationKind.artifact.version ===
				targetOperation.operationKind.artifact.version &&
			candidate.operationKind.name === targetOperation.operationKind.name,
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

	it('blocks apply when the live context database differs from the proof context', async () => {
		const observed: StepJournal[] = [];
		const executeOperation = vi.fn(
			async () => ({ kind: 'completed' }) as const,
		);
		const rt = runtime(
			(journal) => {
				observed.push(journal);
			},
			{
				executeOperation,
				observeContext: vi.fn(async () => ({
					...context,
					databaseId: 'other-db',
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

		expect(result.assessment.reasons[0]?.code).toBe('context-mismatch');
		expect(result.journals[0]?.outcome).toBe('context-mismatch');
		expect(executeOperation).not.toHaveBeenCalled();
		expect(observed[0]?.outcome).toBe('context-mismatch');
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

	it('executes compatible coordinator-owned runtimes in one transaction', async () => {
		const observed: StepJournal[] = [];
		const log: string[] = [];
		const coordinator = sharedCoordinator(log);
		const rtA = runtimeForOperation(
			operationA,
			(journal) => {
				observed.push(journal);
			},
			log,
		);
		const rtB = runtimeForOperation(
			operationB,
			(journal) => {
				observed.push(journal);
			},
			log,
		);
		const registry = createPackRegistry([
			{
				rules: [],
				operationSemantics: [rtA, rtB],
				issuer: {
					artifact: operationArtifact,
					execute: async () => evidence(),
				},
				executionCoordinator: coordinator,
				transactionDomain: coordinator.transactionDomain,
			},
		]);

		const result = await createApplier(registry).apply(
			{ plan: multiStepSingleSegmentPlan(), assessment: assessment() },
			acceptsOperationPolicy(),
			executionTarget(),
		);

		expect(result.assessment.lifecycle).toBe('completed');
		expect(result.journals.map((journal) => journal.intent.stepId)).toEqual([
			'step:op:a',
			'step:op:b',
		]);
		expect(
			log.filter((entry) => entry.startsWith('coordinator:checkout')),
		).toEqual(['coordinator:checkout:1']);
		expect(log).toContain('coordinator:begin:1');
		expect(log).toContain('execute:op:a:1');
		expect(log).toContain('execute:op:b:1');
		expect(log).toContain('coordinator:commit:1');
		expect(log).not.toContain('checkout:1');
		expect(rtA.checkout).not.toHaveBeenCalled();
		expect(rtB.checkout).not.toHaveBeenCalled();
		expect(observed.map((journal) => journal.outcome)).toEqual([
			'completed',
			'completed',
		]);
	});

	it('rejects cross-runtime transactional segments without a shared coordinator before checkout', async () => {
		const observed: StepJournal[] = [];
		const log: string[] = [];
		const rtA = runtimeForOperation(
			operationA,
			(journal) => {
				observed.push(journal);
			},
			log,
		);
		const rtB = runtimeForOperation(
			operationB,
			(journal) => {
				observed.push(journal);
			},
			log,
		);
		const registry = createPackRegistry([
			{
				rules: [],
				operationSemantics: [rtA, rtB],
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
			code: 'uncomposable',
		});
		expect(result.assessment.reasons[0]?.detail).toMatch(
			/shared transaction coordinator/,
		);
		expect(rtA.checkout).not.toHaveBeenCalled();
		expect(rtB.checkout).not.toHaveBeenCalled();
		expect(log).not.toContain('checkout:1');
		expect(observed).toEqual([]);
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
		expect(result.assessment.reasons[0]?.code).toBe(
			'operation-failed-not-applied',
		);
		expect(result.journals.map((journal) => journal.intent.stepId)).toEqual([
			'step:op:a',
			'step:op:b',
		]);
		expect(result.journals.map((journal) => journal.outcome)).toEqual([
			'completed',
			'operation-failed-not-applied',
		]);
		expect(log).toContain('commit:1');
		expect(log).toContain('rollback:2');
		expect(log).not.toContain('rollback:1');
		expect(log).not.toContain('commit:2');
		expect(observed.map((journal) => journal.outcome)).toEqual([
			'completed',
			'operation-failed-not-applied',
		]);
	});

	it('reports a later segment setup failure as not applied after an earlier segment committed', async () => {
		const observed: StepJournal[] = [];
		const log: string[] = [];
		const baseRuntime = multiSegmentRuntime(
			(journal) => {
				observed.push(journal);
			},
			{ log },
		);
		const rt: OperationRuntime = {
			...baseRuntime,
			begin: vi.fn(async (client) => {
				const id = (client.opaqueClient as { readonly id: number }).id;
				log.push(`begin:${id}`);
				if (id === 2) {
					throw new Error('begin failed before op:b');
				}
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
			{ plan: multiSegmentPlan(), assessment: assessment() },
			acceptsOperationPolicy(),
			executionTarget(),
		);

		expect(result.assessment.decision).toBe('blocked');
		expect(result.assessment.lifecycle).toBe('partially-applied');
		expect(result.assessment.continuation).toBe('resume-possible');
		expect(result.assessment.reasons[0]).toMatchObject({
			code: 'operation-failed-not-applied',
			stepId: 'step:op:b',
			operationRef: 'op:b',
		});
		expect(result.assessment.reasons[0]?.detail).toContain(
			'begin failed before op:b',
		);
		expect(result.journals.map((journal) => journal.intent.stepId)).toEqual([
			'step:op:a',
			'step:op:b',
		]);
		expect(result.journals.map((journal) => journal.outcome)).toEqual([
			'completed',
			'operation-failed-not-applied',
		]);
		expect(result.journals[1]?.outcome).not.toBe('partially-applied');
		expect(observed.map((journal) => journal.outcome)).toEqual([
			'completed',
			'operation-failed-not-applied',
		]);
		expect(log).toContain('commit:1');
		expect(log).toContain('begin:2');
		expect(log.some((entry) => entry.startsWith('intent:step:op:b'))).toBe(
			false,
		);
		expect(log).not.toContain('execute:op:b:2');
	});

	it('rolls back the whole transactional segment on a pre-commit postcondition mismatch', async () => {
		const observed: StepJournal[] = [];
		const log: string[] = [];
		const afterContexts: string[] = [];
		const contextFor = (ref: string): ObservationContext => ({
			...context,
			capabilities: [ref],
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
							afterContexts.push(
								`${candidate.ref}:${ctx.capabilities.join(',')}`,
							);
						}
						return {
							observations: [
								{
									...evidence(),
									id: evidenceId(`mock.${candidate.ref}.${phase}`),
									context: ctx,
								},
							],
							fingerprint: fingerprint(
								candidate.ref === 'op:b' && phase === 'after'
									? 'op:b:wrong-after'
									: `${candidate.ref}:${phase}`,
							),
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
		expect(result.assessment.lifecycle).toBe('planned');
		expect(result.assessment.reasons[0]).toMatchObject({
			code: 'operation-failed-not-applied',
			stepId: 'step:op:b',
			operationRef: 'op:b',
		});
		expect(result.journals.map((journal) => journal.intent.stepId)).toEqual([
			'step:op:b',
		]);
		expect(result.journals.map((journal) => journal.outcome)).toEqual([
			'operation-failed-not-applied',
		]);
		expect(observed.map((journal) => journal.intent.stepId)).toEqual([
			'step:op:b',
		]);
		expect(afterContexts).toEqual(['op:a:op:a', 'op:b:op:b']);
		expect(log).toContain('completion:step:op:a:1');
		expect(log).toContain('rollback:1');
		expect(log).not.toContain('commit:1');
	});

	it('rolls back step A when step B fails in the same transactional segment', async () => {
		const observed: StepJournal[] = [];
		const log: string[] = [];
		const rt = multiSegmentRuntime(
			(journal) => {
				observed.push(journal);
			},
			{ log, failB: true, transactionMode: 'single-segment' },
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
		expect(result.assessment.lifecycle).toBe('planned');
		expect(result.assessment.reasons[0]).toMatchObject({
			code: 'operation-failed-not-applied',
			stepId: 'step:op:b',
			operationRef: 'op:b',
		});
		expect(result.journals.map((journal) => journal.intent.stepId)).toEqual([
			'step:op:b',
		]);
		expect(result.journals[0]?.outcome).toBe('operation-failed-not-applied');
		expect(observed.map((journal) => journal.intent.stepId)).toEqual([
			'step:op:b',
		]);
		expect(log).toContain('completion:step:op:a:1');
		expect(log).toContain('rollback:1');
		expect(log).not.toContain('commit:1');
	});

	it('rolls back step A when step B guard fails in the same transactional segment', async () => {
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
			checkGuard: vi.fn(async (_client, candidate, checkedGuard) => ({
				passed: !(
					candidate.ref === 'op:b' && checkedGuard.phase === 'before-operation'
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
		const base = multiStepSingleSegmentPlan() as ProvenPlanShape;
		const guarded = mintInProcessPlan({
			...base,
			claims: [identityClaim()],
			steps: base.steps.map((step) =>
				step.operation.ref === 'op:b'
					? {
							...step,
							requiredClaims: [claimId('mock.identity')],
							guards: [guardFor('op:b', 'before-operation')],
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
		expect(result.assessment.lifecycle).toBe('planned');
		expect(result.assessment.reasons[0]).toMatchObject({
			code: 'guard-failed',
			stepId: 'step:op:b',
			operationRef: 'op:b',
		});
		expect(result.journals.map((journal) => journal.intent.stepId)).toEqual([
			'step:op:b',
		]);
		expect(result.journals[0]?.outcome).toBe('guard-failed');
		expect(observed.map((journal) => journal.intent.stepId)).toEqual([
			'step:op:b',
		]);
		expect(log).toContain('completion:step:op:a:1');
		expect(log).toContain('rollback:1');
		expect(log).not.toContain('commit:1');
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

	it('persists a not-applied journal when a transactional operation error rolls back', async () => {
		const observed: StepJournal[] = [];
		const rt = runtime((journal) => {
			observed.push(journal);
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
		const result = await createApplier(registry).apply(
			{ plan: plan(), assessment: assessment() },
			acceptsOperationPolicy(),
			executionTarget(),
		);

		expect(result.assessment.lifecycle).toBe('planned');
		expect(result.assessment.reasons[0]?.code).toBe(
			'operation-failed-not-applied',
		);
		expect(result.journals[0]?.outcome).toBe('operation-failed-not-applied');
		expect(observed[0]?.outcome).toBe('operation-failed-not-applied');
		expect(rt.rollback).toHaveBeenCalledOnce();
	});

	it('reports unknown-step-result when rollback outcome is uncertain', async () => {
		const observed: StepJournal[] = [];
		const rt: OperationRuntime = {
			...runtime((journal) => {
				observed.push(journal);
			}),
			rollback: vi.fn(async () => {
				throw new Error('rollback failed');
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

		expect(result.assessment.lifecycle).toBe('outcome-unknown');
		expect(result.assessment.reasons[0]?.code).toBe('unknown-step-result');
		expect(result.journals[0]?.outcome).toBe('unknown-step-result');
		expect(observed[0]?.outcome).toBe('unknown-step-result');
	});

	it('reports unknown-step-result when commit outcome is uncertain', async () => {
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
			commit: vi.fn(async () => {
				throw new Error('connection lost during commit');
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

		expect(result.assessment.lifecycle).toBe('outcome-unknown');
		expect(result.assessment.continuation).toBe('human-intervention-required');
		expect(result.assessment.reasons[0]).toMatchObject({
			code: 'unknown-step-result',
			stepId: 'step:op',
		});
		expect(result.assessment.reasons[0]?.detail).toContain(
			'commit outcome uncertain',
		);
		expect(result.journals[0]?.outcome).toBe('unknown-step-result');
		expect(observed[0]?.outcome).toBe('unknown-step-result');
	});

	it('keeps a committed segment completed when the post-commit observed journal write fails', async () => {
		const rt: OperationRuntime = {
			...runtime(() => undefined, {
				executeOperation: vi.fn(async () => ({ kind: 'completed' })),
			}),
			writeObservedJournal: vi.fn(async () => {
				throw new Error('journal unavailable');
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
		expect(result.assessment.reasons[0]).toMatchObject({
			code: 'proven-applicable',
		});
		expect(result.assessment.reasons[0]?.detail).toContain(
			'observed journal write failed',
		);
		expect(result.journals[0]?.outcome).toBe('completed');
	});

	it('keeps all journals for a committed multi-step segment when a post-commit observed journal write fails', async () => {
		const observed: StepJournal[] = [];
		const log: string[] = [];
		const rt = multiSegmentRuntime(
			(journal) => {
				if (journal.intent.stepId === 'step:op:a') {
					throw new Error('journal unavailable');
				}
				observed.push(journal);
			},
			{ log, transactionMode: 'single-segment' },
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

		expect(result.assessment.lifecycle).toBe('completed');
		expect(result.assessment.reasons[0]?.detail).toContain(
			'observed journal write failed',
		);
		expect(result.journals.map((journal) => journal.intent.stepId)).toEqual([
			'step:op:a',
			'step:op:b',
		]);
		expect(result.journals.map((journal) => journal.outcome)).toEqual([
			'completed',
			'completed',
		]);
		expect(observed.map((journal) => journal.intent.stepId)).toEqual([
			'step:op:b',
		]);
	});

	it('continues to later segments when a post-commit observed journal write fails', async () => {
		const observed: StepJournal[] = [];
		const log: string[] = [];
		const rt = multiSegmentRuntime(
			(journal) => {
				if (journal.intent.stepId === 'step:op:a') {
					throw new Error('journal unavailable');
				}
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
		expect(result.assessment.continuation).toBe('none');
		expect(result.assessment.reasons[0]?.detail).toContain(
			'observed journal write failed',
		);
		expect(result.journals.map((journal) => journal.intent.stepId)).toEqual([
			'step:op:a',
			'step:op:b',
		]);
		expect(result.journals.map((journal) => journal.outcome)).toEqual([
			'completed',
			'completed',
		]);
		expect(observed.map((journal) => journal.intent.stepId)).toEqual([
			'step:op:b',
		]);
		expect(log).toContain('execute:op:b:2');
		expect(log).toContain('commit:2');
	});

	it('orders observed journal write warnings chronologically across prior and terminal outcomes', async () => {
		const log: string[] = [];
		const baseRuntime = multiSegmentRuntime(
			(journal) => {
				throw new Error(`journal unavailable for ${journal.intent.stepId}`);
			},
			{ log },
		);
		const rt: OperationRuntime = {
			...baseRuntime,
			effectsOf: (candidate): OperationEffectAssessment => {
				const base = baseRuntime.effectsOf(candidate);
				if (candidate.ref !== 'op:b') {
					return base;
				}
				return {
					...base,
					effects: {
						...base.effects,
						execution: {
							...base.effects.execution,
							commitBoundary: 'after',
							postconditionVisibility: 'after-commit',
						},
					},
				};
			},
			observeOperation: vi.fn(
				async (
					_client,
					candidate,
					_context,
					phase,
				): Promise<OperationObservation> => ({
					observations: [evidence()],
					fingerprint: fingerprint(
						candidate.ref === 'op:b' && phase === 'after'
							? 'op:b:wrong-after'
							: `${candidate.ref}:${phase}`,
					),
				}),
			),
		};
		const base = multiSegmentPlanShape();
		const afterCommitSecondSegment = mintInProcessPlan({
			...base,
			segments: [
				base.segments[0]!,
				{
					...base.segments[1]!,
					commitBoundaryAfter: true,
				},
			],
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

		const result = await createApplier(registry).apply(
			{ plan: afterCommitSecondSegment, assessment: assessment() },
			acceptsOperationPolicy(),
			executionTarget(),
		);

		const detail = result.assessment.reasons[0]?.detail ?? '';
		const priorWarning =
			'observed journal write failed after outcome was decided: journal unavailable for step:op:a';
		const terminalWarning =
			'observed journal write failed after outcome was decided: journal unavailable for step:op:b';
		expect(result.assessment.lifecycle).toBe('partially-applied');
		expect(result.journals.map((journal) => journal.intent.stepId)).toEqual([
			'step:op:a',
			'step:op:b',
		]);
		expect(result.journals.map((journal) => journal.outcome)).toEqual([
			'completed',
			'partially-applied',
		]);
		expect(detail).toContain(priorWarning);
		expect(detail).toContain(terminalWarning);
		expect(detail.indexOf(priorWarning)).toBeLessThan(
			detail.indexOf(terminalWarning),
		);
		expect(log).toContain('commit:1');
		expect(log).toContain('commit:2');
	});

	it('continues to later segments when a nontransactional completed journal write fails', async () => {
		const observed: StepJournal[] = [];
		const log: string[] = [];
		const rt = multiSegmentRuntime(
			(journal) => {
				if (journal.intent.stepId === 'step:op:a') {
					throw new Error('journal unavailable');
				}
				observed.push(journal);
			},
			{ log, transactionMode: 'forbid-a' },
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
			{ plan: firstSegmentForbidsTransactionPlan(), assessment: assessment() },
			acceptsOperationPolicy(),
			executionTarget(),
		);

		expect(result.assessment.lifecycle).toBe('completed');
		expect(result.assessment.continuation).toBe('none');
		expect(result.assessment.reasons[0]?.detail).toContain(
			'observed journal write failed',
		);
		expect(result.journals.map((journal) => journal.intent.stepId)).toEqual([
			'step:op:a',
			'step:op:b',
		]);
		expect(result.journals.map((journal) => journal.outcome)).toEqual([
			'completed',
			'completed',
		]);
		expect(observed.map((journal) => journal.intent.stepId)).toEqual([
			'step:op:b',
		]);
		expect(log).toContain('execute:op:a:1');
		expect(log).toContain('execute:op:b:2');
		expect(log).toContain('commit:2');
	});

	it('observes after-commit postconditions only after committing their own segment', async () => {
		const observed: StepJournal[] = [];
		const log: string[] = [];
		const baseRuntime = runtime(
			(journal) => {
				observed.push(journal);
			},
			{
				log,
				executeOperation: vi.fn(async () => ({ kind: 'completed' })),
			},
		);
		const rt: OperationRuntime = {
			...baseRuntime,
			effectsOf: (candidate): OperationEffectAssessment => {
				const base = baseRuntime.effectsOf(candidate);
				return {
					...base,
					effects: {
						...base.effects,
						execution: {
							transaction: 'joins-current',
							commitBoundary: 'after',
							postconditionVisibility: 'after-commit',
						},
					},
				};
			},
		};
		const basePlan = planShape();
		const afterCommitPlan = mintInProcessPlan({
			...basePlan,
			segments: [
				{
					...basePlan.segments[0]!,
					commitBoundaryAfter: true,
				},
			],
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

		const result = await createApplier(registry).apply(
			{ plan: afterCommitPlan, assessment: assessment() },
			acceptsOperationPolicy(),
			executionTarget(),
		);

		expect(result.assessment.lifecycle).toBe('completed');
		expect(result.journals[0]?.outcome).toBe('completed');
		expect(log.indexOf('commit')).toBeLessThan(log.indexOf('observe:after'));
		expect(observed[0]?.outcome).toBe('completed');
	});

	it('rejects after-commit postcondition operations coalesced in an atomic multi-step segment', async () => {
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
						execution: {
							transaction: 'joins-current',
							commitBoundary: 'after',
							postconditionVisibility: 'after-commit',
						},
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

	it('reports unaccepted assumptions at the step closure that depends on them', async () => {
		const operation = operationAssumption();
		const blastRadius = operationAssumption({
			id: 'mock.user-blast-radius' as Assumption['id'],
			class: 'user-blast-radius',
			asserter: { kind: 'human', identity: 'schema-owner' },
			statement: 'schema owner accepts the blast radius for this step',
			scope: [tableResource()],
		});
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
			{ restsOnAssumptions: [operation.id, blastRadius.id] },
			{ assumptions: [operation, blastRadius] },
		);

		const denied = await createApplier(registry).apply(
			{ plan: scopedPlan, assessment: assessment() },
			acceptsOperationPolicy(),
			executionTarget(),
		);

		expect(denied.assessment.reasons[0]).toMatchObject({
			code: 'uncomposable',
			assumption: blastRadius.id,
			fragments: [scopedPlan.steps[0]?.selectionRationale.chosen],
		});
		expect(rt.checkout).not.toHaveBeenCalled();

		const accepted = await createApplier(registry).apply(
			{ plan: scopedPlan, assessment: assessment() },
			{
				accepts: [
					{ class: 'operation-pack-semantics' },
					{
						class: 'user-blast-radius',
						fromTrustRoot: blastRadius.asserter,
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

	it('keeps a transactional before-operation guard failure classified after rollback clears the intent journal', async () => {
		const observed: StepJournal[] = [];
		const durableIntentRows = new Set<string>();
		const log: string[] = [];
		const executeOperation = vi.fn(async () => ({ kind: 'completed' }));
		const baseRuntime = runtime(
			(journal) => {
				observed.push(journal);
			},
			{
				log,
				executeOperation,
				checkGuard: vi.fn(async () => ({
					passed: false,
					observations: [],
					recovery: [],
				})),
			},
		);
		const rt: OperationRuntime = {
			...baseRuntime,
			writeIntentJournal: vi.fn(async (_client, recordValue) => {
				log.push(`intent:${recordValue.stepId}`);
				durableIntentRows.add(recordValue.stepId);
			}),
			rollback: vi.fn(async () => {
				log.push('rollback-clears-intent');
				durableIntentRows.clear();
			}),
			writeObservedJournal: vi.fn(async (_client, journal) => {
				log.push(`observed:${journal.outcome}`);
				expect(durableIntentRows.has(journal.intent.stepId)).toBe(false);
				expect(journal.intent.run?.runId).toBe(journal.intent.runId);
				observed.push(journal);
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
		expect(log).toContain('rollback-clears-intent');
		expect(log.indexOf('rollback-clears-intent')).toBeLessThan(
			log.indexOf('observed:guard-failed'),
		);
		expect(durableIntentRows.size).toBe(0);
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

	it('surfaces nontransactional runtime partial recovery artefacts as resume-possible', async () => {
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
		const baseRuntime = runtime(
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
		const rt: OperationRuntime = {
			...baseRuntime,
			effectsOf: (): OperationEffectAssessment => ({
				effects: {
					reads: [],
					writes: [],
					locks: [],
					invalidates: [],
					contextMutations: [],
					externalEffects: { accountedFor: [], couldNotAccountFor: [] },
					execution: {
						transaction: 'forbids-transaction',
						commitBoundary: 'after',
					},
				},
				restsOn: [operationAssumption()],
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
		const basePlan = planShape();
		const nonTransactionalPlan = mintInProcessPlan({
			...basePlan,
			segments: [
				{
					...basePlan.segments[0]!,
					transaction: 'forbids-transaction',
					commitBoundaryAfter: true,
				},
			],
		});

		const result = await createApplier(registry).apply(
			{ plan: nonTransactionalPlan, assessment: assessment() },
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
