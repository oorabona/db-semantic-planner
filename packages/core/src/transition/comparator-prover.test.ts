import type {
	Assumption,
	CapabilityDescriptor,
	ColumnIR,
	EvidenceObservation,
	ModelIR,
	ObservationContext,
	ObservationIssuer,
	ObservationRequest,
	OperationEffectAssessment,
	PhysicalOperation,
	ProofClaim,
	ProofObligation,
	ResourceAddress,
	SemanticArtifactRef,
	TableIR,
	TransitionCandidate,
	TransitionConnectionPool,
	TransitionFragment,
	TransitionRule,
} from '@dbsp/types';
import { describe, expect, it, vi } from 'vitest';
import { createComparator } from './comparator.js';
import {
	assumptionId,
	claimId,
	evidenceId,
	semanticArtifactId,
} from './ids.js';
import { isMintedInProcessPlan } from './minting.js';
import { createProver } from './prover.js';
import type { RegisteredOperationSemantics } from './registry.js';
import { createPackRegistry } from './registry.js';
import { validateTransitionRelationalInvariants } from './validation.js';

const ruleArtifact: SemanticArtifactRef = {
	id: semanticArtifactId('dbsp.mock.rules'),
	version: '0.1.0',
};
const otherRuleArtifact: SemanticArtifactRef = {
	id: semanticArtifactId('dbsp.mock.other-rules'),
	version: '0.1.0',
};
const operationArtifact: SemanticArtifactRef = {
	id: semanticArtifactId('dbsp.mock.operations'),
	version: '0.1.0',
};
const issuerArtifact: SemanticArtifactRef = {
	id: semanticArtifactId('dbsp.mock.issuer'),
	version: '0.1.0',
};

const context: ObservationContext = {
	engine: 'postgresql',
	engineVersion: '18',
	databaseId: 'test',
	capabilities: ['mock'],
	privileges: [],
	sessionConfiguration: {},
	extensions: {},
};

function proofTarget(): TransitionConnectionPool {
	return {
		connect: async () => ({
			query: async () => ({ rows: [] }),
			release: vi.fn(),
		}),
	};
}

function column(nullable: boolean, name = 'age'): ColumnIR {
	return { name, type: 'integer', nullable };
}

function table(nullable: boolean, columns = [column(nullable)]): TableIR {
	return {
		name: 'users',
		columns,
		foreignKeys: [],
		indexes: [],
	};
}

function modelFromTable(users: TableIR): ModelIR {
	const tables = new Map<string, TableIR>([['users', users]]);
	return {
		tables,
		relations: new Map(),
		getTable: (name) => tables.get(name),
		getRelation: () => undefined,
		getRelationsFrom: () => [],
		getRelationsTo: () => [],
		isAmbiguous: () => ({ ambiguous: false, options: [] }),
	};
}

function model(nullable: boolean): ModelIR {
	return modelFromTable(table(nullable));
}

function columnResource(name = 'age'): ResourceAddress {
	return {
		engine: 'postgresql',
		database: 'test',
		kind: 'column',
		name,
		qualifiedBy: ['users'],
	};
}

function tableResource(): ResourceAddress {
	return {
		engine: 'postgresql',
		database: 'test',
		kind: 'table',
		name: 'users',
	};
}

function externalAssumption(overrides: Partial<Assumption> = {}): Assumption {
	return {
		id: assumptionId('mock.external-ddl-exclusion'),
		class: 'external-ddl-exclusion',
		asserter: { kind: 'pack', artifact: ruleArtifact },
		statement: 'no concurrent DDL',
		scope: [tableResource(), columnResource()],
		...overrides,
	};
}

function operationAssumption(): Assumption {
	return {
		id: assumptionId('mock.operation-pack-semantics'),
		class: 'operation-pack-semantics',
		asserter: { kind: 'pack', artifact: operationArtifact },
		statement: 'mock operation semantics are correct',
		scope: [columnResource()],
	};
}

function claimWithConclusion(
	conclusion:
		| 'established'
		| 'established-under-assumptions'
		| 'undischarged'
		| 'refuted',
	assumes: ProofClaim['assumes'] = [],
): ProofClaim {
	return {
		id: claimId(`mock.${conclusion}`),
		proposition: { kind: `mock.${conclusion}`, scope: [columnResource()] },
		scope: [columnResource()],
		supportedBy: [],
		assumes,
		semantics: [operationArtifact],
		derivedBy: {
			semantics: operationArtifact,
			inputs: [],
			proposition: { kind: `mock.${conclusion}`, scope: [columnResource()] },
			conclusion,
		},
	} as ProofClaim;
}

function operation(): PhysicalOperation {
	return {
		ref: 'op:set-not-null',
		operationKind: {
			artifact: operationArtifact,
			name: 'SetNotNull',
		},
		payload: { table: 'users', column: 'age' },
	};
}

function obligation(appliesTo = operation().ref): ProofObligation {
	const request = {
		kind: 'mock.column.exists',
		scope: [columnResource()],
		detail: { table: 'users', column: 'age' },
	};
	return {
		proposition: {
			kind: request.kind,
			scope: request.scope,
			detail: request.detail,
		},
		scope: request.scope,
		appliesTo,
		dischargeableBy: [request],
	};
}

function baseFragment(evaluation: {
	readonly obligations: readonly ProofObligation[];
	readonly assumptions: readonly Assumption[];
}): TransitionFragment {
	return {
		generatedBy: { id: 'mock.set-not-null', pack: ruleArtifact },
		operations: [operation()],
		obligations: evaluation.obligations.map((item) => ({
			...item,
			appliesTo: operation().ref,
		})),
		assumptions: [...evaluation.assumptions, externalAssumption()],
		guards: [
			{
				appliesTo: operation().ref,
				predicate: {
					kind: 'NO_NULLS',
					scope: [columnResource()],
				},
				protocol: {
					kind: 'lock-and-check',
					onFailureLeaves: [],
					binding: {
						kind: 'external-ddl-exclusion',
						assumption: externalAssumption().id,
						scope: [tableResource(), columnResource()],
					},
				},
				phase: 'before-operation',
			},
		],
		selectionRationale: {
			chosen: { id: 'mock.set-not-null', pack: ruleArtifact },
			overRules: [],
			why: 'mock',
		},
	};
}

type RuleOptions = {
	readonly support?: TransitionRule['support'];
	readonly requiredObservations?: TransitionRule<{
		readonly table: string;
		readonly column: string;
	}>['requiredObservations'];
	readonly evaluate?: TransitionRule<{
		readonly table: string;
		readonly column: string;
	}>['evaluate'];
	readonly generateCandidate?: TransitionRule<{
		readonly table: string;
		readonly column: string;
	}>['generateCandidate'];
};

function rule(options: RuleOptions = {}): TransitionRule<{
	readonly table: string;
	readonly column: string;
}> {
	return {
		id: 'mock.set-not-null',
		artifact: ruleArtifact,
		support: options.support ?? {
			engine: 'postgresql',
			versions: [{ min: '18' }],
			requiredCapabilities: ['mock'],
		},
		recognize(desired, current) {
			const desiredColumn = desired.getTable('users')?.columns[0];
			const currentColumn = current.getTable('users')?.columns[0];
			return desiredColumn?.nullable === false &&
				currentColumn?.nullable === true
				? {
						recognized: true,
						match: { table: 'users', column: desiredColumn.name },
					}
				: { recognized: false };
		},
		requiredObservations:
			options.requiredObservations ??
			(() => obligation().dischargeableBy ?? []),
		evaluate:
			options.evaluate ??
			(() => ({
				outcome: 'applicable',
				obligations: [obligation()],
				assumptions: [],
			})),
		generateCandidate:
			options.generateCandidate ??
			((_match, evaluation) => baseFragment(evaluation)),
	};
}

function semantics(
	restsOn: readonly Assumption[] = [operationAssumption()],
	operationKind: PhysicalOperation['operationKind'] = operation().operationKind,
): RegisteredOperationSemantics {
	return {
		artifact: operationKind.artifact,
		operationKind,
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
			restsOn,
		}),
		buildFingerprints: () => ({
			expectedBefore: {
				algorithm: 'mock',
				semanticModel: operationArtifact,
				includedFacts: [{ key: 'nullable', value: 'true' }],
				excludedOrUnknownFacts: [],
				digest: 'before',
			},
			expectedAfter: {
				algorithm: 'mock',
				semanticModel: operationArtifact,
				includedFacts: [{ key: 'nullable', value: 'false' }],
				excludedOrUnknownFacts: [],
				digest: 'after',
			},
		}),
	};
}

function issuer(
	holds = true,
	mapRequest: (request: ObservationRequest) => ObservationRequest = (request) =>
		request,
): ObservationIssuer {
	return {
		artifact: issuerArtifact,
		execute: async (request, _target, ctx): Promise<EvidenceObservation> => {
			const evidenceRequest = mapRequest(request);
			return {
				role: 'evidence',
				id: evidenceId(`mock.evidence.${evidenceRequest.kind}`),
				issuer: issuerArtifact,
				request: evidenceRequest,
				result: {
					value: {
						claims: [{ kind: evidenceRequest.kind, holds }],
					},
				},
				context: ctx,
				stability: 'externally-mutable',
				takenAt: new Date().toISOString(),
				scope: evidenceRequest.scope,
				source: 'system-catalog',
				validity: { invalidatedBy: [] },
			};
		},
	};
}

function emptyIssuer(): ObservationIssuer {
	return {
		artifact: issuerArtifact,
		execute: async (request, _target, ctx): Promise<EvidenceObservation> => ({
			role: 'evidence',
			id: evidenceId(`mock.evidence.empty.${request.kind}`),
			issuer: issuerArtifact,
			request,
			result: { value: {} },
			context: ctx,
			stability: 'externally-mutable',
			takenAt: new Date().toISOString(),
			scope: request.scope,
			source: 'system-catalog',
			validity: { invalidatedBy: [] },
		}),
	};
}

function registry(
	options: {
		readonly rules?: readonly TransitionRule[];
		readonly semantics?: RegisteredOperationSemantics;
		readonly issuer?: ObservationIssuer;
		readonly capabilityDescriptors?: readonly CapabilityDescriptor[];
	} = {},
) {
	return createPackRegistry([
		{
			rules: options.rules ?? [rule()],
			operationSemantics: [options.semantics ?? semantics()],
			issuer: options.issuer ?? issuer(),
			capabilityDescriptors: options.capabilityDescriptors,
		},
	]);
}

function validCompare(): Extract<
	ReturnType<ReturnType<typeof createComparator>['compare']>,
	{ readonly kind: 'transitions' }
> {
	const compare = createComparator(registry()).compare(
		model(false),
		model(true),
	);
	if (compare.kind !== 'transitions') {
		throw new Error(`expected transitions, got ${compare.kind}`);
	}
	return compare;
}

describe('createComparator', () => {
	it('returns no-drift only when the full model is equal', () => {
		const compare = createComparator(registry()).compare(
			model(false),
			model(false),
		);
		expect(compare.kind).toBe('no-drift');
	});

	it('recognizes a nullable true to false column transition as a candidate', () => {
		const compare = createComparator(registry()).compare(
			model(false),
			model(true),
		);
		expect(compare.kind).toBe('transitions');
		if (compare.kind === 'transitions') {
			expect(compare.candidates).toHaveLength(1);
			expect(compare.candidates[0]?.rule.id).toBe('mock.set-not-null');
		}
	});

	it('returns unsupported when a non-column table dimension changed', () => {
		const desired = modelFromTable({ ...table(true), primaryKey: 'age' });
		const current = model(true);
		const compare = createComparator(registry()).compare(desired, current);
		expect(compare.kind).toBe('unsupported');
	});

	it('returns unsupported when a recognized column change has a sibling diff', () => {
		const desired = modelFromTable({
			...table(false),
			comment: 'changed too',
		});
		const current = model(true);
		const compare = createComparator(registry()).compare(desired, current);
		expect(compare.kind).toBe('unsupported');
	});

	it('returns uncomposable when two recognized column changes are present', async () => {
		const desired = modelFromTable(
			table(false, [column(false, 'age'), column(false, 'height')]),
		);
		const current = modelFromTable(
			table(true, [column(true, 'age'), column(true, 'height')]),
		);
		const customRegistry = registry();
		const compare = createComparator(customRegistry).compare(desired, current);

		expect(compare.kind).toBe('uncomposable');
		if (compare.kind !== 'uncomposable') {
			return;
		}
		expect(compare.detail).toMatch(
			/multi-change composition is not yet supported/i,
		);
		expect(compare.candidates.map((candidate) => candidate.match)).toEqual([
			{ table: 'users', column: 'age' },
			{ table: 'users', column: 'height' },
		]);

		const outcome = await createProver(customRegistry).prove(
			compare,
			proofTarget(),
			context,
		);

		expect(outcome.kind).toBe('blocked');
		if (outcome.kind === 'blocked') {
			expect(outcome.assessment.reasons[0]?.code).toBe('uncomposable');
			expect(outcome.assessment.reasons[0]?.detail).toMatch(
				/multi-change composition is not yet supported/i,
			);
		}
	});
});

describe('createProver', () => {
	it('resolves two operations in one pack by operation name', () => {
		const setNotNullOperation = operation();
		const validateOperation: PhysicalOperation = {
			...operation(),
			ref: 'op:validate',
			operationKind: {
				artifact: operationArtifact,
				name: 'ValidateConstraint',
			},
		};
		const setNotNullRuntime = semantics(
			[operationAssumption()],
			setNotNullOperation.operationKind,
		);
		const validateRuntime = semantics(
			[operationAssumption()],
			validateOperation.operationKind,
		);
		const customRegistry = createPackRegistry([
			{
				rules: [],
				operationSemantics: [validateRuntime, setNotNullRuntime],
				issuer: issuer(),
			},
		]);

		const setNotNullResolution =
			customRegistry.resolveOperation(setNotNullOperation);
		const validateResolution =
			customRegistry.resolveOperation(validateOperation);

		expect(setNotNullResolution.ok).toBe(true);
		if (setNotNullResolution.ok) {
			expect(setNotNullResolution.semantics).toBe(setNotNullRuntime);
		}
		expect(validateResolution.ok).toBe(true);
		if (validateResolution.ok) {
			expect(validateResolution.semantics).toBe(validateRuntime);
		}
	});

	it('reports ambiguous operation runtimes instead of taking the first match', () => {
		const firstRuntime = semantics();
		const secondRuntime = semantics();
		const customRegistry = createPackRegistry([
			{
				rules: [],
				operationSemantics: [firstRuntime, secondRuntime],
				issuer: issuer(),
			},
		]);

		const resolution = customRegistry.resolveOperation(operation());

		expect(resolution.ok).toBe(false);
		if (!resolution.ok) {
			expect(resolution.detail).toContain('ambiguous operation runtime');
		}
	});

	it('rejects duplicate rule registrations', () => {
		expect(() =>
			createPackRegistry([
				{
					rules: [rule()],
					operationSemantics: [],
					issuer: {
						artifact: {
							id: semanticArtifactId('dbsp.mock.issuer.one'),
							version: '0.1.0',
						},
						execute: issuer().execute,
					},
				},
				{
					rules: [rule()],
					operationSemantics: [],
					issuer: {
						artifact: {
							id: semanticArtifactId('dbsp.mock.issuer.two'),
							version: '0.1.0',
						},
						execute: issuer().execute,
					},
				},
			]),
		).toThrow(/duplicate transition rule registration/);
	});

	it('rejects duplicate issuer registrations', () => {
		expect(() =>
			createPackRegistry([
				{
					rules: [],
					operationSemantics: [],
					issuer: issuer(),
				},
				{
					rules: [],
					operationSemantics: [],
					issuer: issuer(),
				},
			]),
		).toThrow(/duplicate transition issuer registration/);
	});

	it('calls evaluate and mints a frozen InProcessProvenPlan on the valid single-step path', async () => {
		const evaluate = vi.fn(rule().evaluate);
		const outcome = await createProver(
			registry({ rules: [rule({ evaluate })] }),
		).prove(validCompare(), proofTarget(), context);
		expect(evaluate).toHaveBeenCalledOnce();
		expect(outcome.kind).toBe('proven');
		if (outcome.kind === 'proven') {
			expect(isMintedInProcessPlan(outcome.plan)).toBe(true);
			expect(Object.isFrozen(outcome.plan)).toBe(true);
			expect(Object.isFrozen(outcome.plan.steps)).toBe(true);
			expect(Object.isFrozen(outcome.plan.steps[0])).toBe(true);
			expect(outcome.plan.steps).toHaveLength(1);
			expect(outcome.plan.steps[0]?.guards[0]?.predicate.kind).toBe('NO_NULLS');
			expect(outcome.plan.steps[0]?.restsOnAssumptions).toContain(
				operationAssumption().id,
			);
			expect(outcome.plan.steps[0]?.restsOnAssumptions).toContain(
				externalAssumption().id,
			);
			expect(() => {
				(outcome.plan.steps[0] as { operation: PhysicalOperation }).operation =
					{
						...outcome.plan.steps[0]!.operation,
						ref: 'changed',
					};
			}).toThrow(TypeError);
		}
	});

	it('refuses a forged compare result that drops required observations', async () => {
		const execute = vi.fn(issuer().execute);
		const compare = validCompare();
		const candidate = compare.candidates[0] as TransitionCandidate;
		const forged: typeof compare = {
			...compare,
			candidates: [
				{
					...candidate,
					requiredObservations: candidate.requiredObservations.slice(1),
					obligations: [],
				},
			],
			obligations: [],
		};

		const outcome = await createProver(
			registry({
				issuer: {
					artifact: issuerArtifact,
					execute,
				},
			}),
		).prove(forged, proofTarget(), context);

		expect(outcome.kind).toBe('blocked');
		expect(execute).not.toHaveBeenCalled();
		if (outcome.kind === 'blocked') {
			expect(outcome.assessment.reasons[0]?.code).toBe('uncomposable');
		}
	});

	it('does not generate a fragment when evaluate blocks', async () => {
		const generateCandidate = vi.fn(rule().generateCandidate);
		const outcome = await createProver(
			registry({
				rules: [
					rule({
						evaluate: () => ({
							outcome: 'blocked',
							obligations: [obligation()],
							assumptions: [],
						}),
						generateCandidate,
					}),
				],
			}),
		).prove(validCompare(), proofTarget(), context);
		expect(outcome.kind).toBe('blocked');
		expect(generateCandidate).not.toHaveBeenCalled();
	});

	it('does not generate a fragment when evaluate returns inapplicable', async () => {
		const generateCandidate = vi.fn(rule().generateCandidate);
		const outcome = await createProver(
			registry({
				rules: [
					rule({
						evaluate: () => ({
							outcome: 'inapplicable',
							obligations: [obligation()],
							assumptions: [],
						}),
						generateCandidate,
					}),
				],
				issuer: issuer(false),
			}),
		).prove(validCompare(), proofTarget(), context);
		expect(outcome.kind).toBe('inapplicable');
		expect(generateCandidate).not.toHaveBeenCalled();
	});

	it('returns inapplicable for a refuted required claim before minting a plan', async () => {
		const outcome = await createProver(
			registry({ issuer: issuer(false) }),
		).prove(validCompare(), proofTarget(), context);

		expect(outcome.kind).toBe('inapplicable');
		if (outcome.kind === 'inapplicable') {
			expect(outcome.assessment.decision).toBe('inapplicable');
			expect(outcome.assessment.reasons[0]?.code).toBe('proven-inapplicable');
			expect(outcome.claim?.derivedBy.conclusion).toBe('refuted');
		}
	});

	it('stays blocked for an undischarged required claim before minting a plan', async () => {
		const outcome = await createProver(
			registry({ issuer: emptyIssuer() }),
		).prove(validCompare(), proofTarget(), context);

		expect(outcome.kind).toBe('blocked');
		if (outcome.kind === 'blocked') {
			expect(outcome.assessment.reasons[0]?.code).toBe('insufficient-evidence');
		}
	});

	it('uses the candidate rule pack issuer instead of the first registry issuer', async () => {
		const wrongExecute = vi.fn(issuer(false).execute);
		const correctExecute = vi.fn(issuer(true).execute);
		const customRegistry = createPackRegistry([
			{
				rules: [],
				operationSemantics: [],
				issuer: {
					artifact: otherRuleArtifact,
					execute: wrongExecute,
				},
			},
			{
				rules: [rule()],
				operationSemantics: [semantics()],
				issuer: {
					artifact: issuerArtifact,
					execute: correctExecute,
				},
			},
		]);
		const compare = createComparator(customRegistry).compare(
			model(false),
			model(true),
		);
		if (compare.kind !== 'transitions') {
			throw new Error(`expected transitions, got ${compare.kind}`);
		}

		const outcome = await createProver(customRegistry).prove(
			compare,
			proofTarget(),
			context,
		);

		expect(outcome.kind).toBe('proven');
		expect(wrongExecute).not.toHaveBeenCalled();
		expect(correctExecute).toHaveBeenCalled();
	});

	it('enforces RuleSupport before issuing observations', async () => {
		const execute = vi.fn(issuer().execute);
		const outcome = await createProver(
			registry({
				rules: [
					rule({
						support: {
							engine: 'postgresql',
							versions: [{ min: '19' }],
							requiredCapabilities: ['mock'],
						},
					}),
				],
				issuer: { artifact: issuerArtifact, execute },
			}),
		).prove(validCompare(), proofTarget(), context);
		expect(outcome.kind).toBe('inapplicable');
		expect(execute).not.toHaveBeenCalled();
	});

	it('derives required capabilities from pack descriptors before issuing observations', async () => {
		const capabilityDescriptors: readonly CapabilityDescriptor[] = [
			{
				id: 'mock',
				predicate: { kind: 'minServerVersionNum', minServerVersionNum: 180000 },
			},
		];
		const execute = vi.fn(issuer().execute);
		const readContext = vi
			.fn()
			.mockResolvedValueOnce({
				...context,
				engineVersion: '170000',
				capabilities: [],
			})
			.mockResolvedValueOnce({
				...context,
				engineVersion: '180000',
				capabilities: [],
			});
		const customRegistry = registry({
			rules: [
				rule({
					support: {
						engine: 'postgresql',
						versions: [{ min: '17' }],
						requiredCapabilities: ['mock'],
					},
				}),
			],
			issuer: { artifact: issuerArtifact, readContext, execute },
			capabilityDescriptors,
		});
		const compare = createComparator(customRegistry).compare(
			model(false),
			model(true),
		);
		if (compare.kind !== 'transitions') {
			throw new Error(`expected transitions, got ${compare.kind}`);
		}

		const oldServer = await createProver(customRegistry).prove(
			compare,
			proofTarget(),
			context,
		);
		const supportedServer = await createProver(customRegistry).prove(
			compare,
			proofTarget(),
			context,
		);

		expect(oldServer.kind).toBe('inapplicable');
		if (oldServer.kind === 'inapplicable') {
			expect(oldServer.assessment.reasons[0]).toMatchObject({
				code: 'context-mismatch',
				fact: {
					key: 'context.capability.mock.available',
					value: 'false',
				},
			});
		}
		expect(supportedServer.kind).toBe('proven');
		expect(execute).toHaveBeenCalled();
	});

	it('merges descriptor-derived capabilities with incoming context capabilities', () => {
		const customRegistry = registry({
			capabilityDescriptors: [
				{
					id: 'mock',
					predicate: {
						kind: 'minServerVersionNum',
						minServerVersionNum: 180000,
					},
				},
			],
		});

		const derived = customRegistry.contextWithDerivedCapabilities({
			...context,
			engineVersion: '180000',
			capabilities: ['external-pack-capability'],
		});

		expect(derived.capabilities).toEqual(['external-pack-capability', 'mock']);
	});

	it('refuses scope/detail mismatched evidence for an obligation', async () => {
		const badIssuer = issuer(true, (request) => ({
			...request,
			scope: [columnResource('height')],
			detail: { table: 'users', column: 'height' },
		}));
		const outcome = await createProver(registry({ issuer: badIssuer })).prove(
			validCompare(),
			proofTarget(),
			context,
		);
		expect(outcome.kind).toBe('blocked');
		if (outcome.kind === 'blocked') {
			expect(outcome.assessment.reasons[0]?.code).toBe('insufficient-evidence');
		}
	});

	it('refuses a dangling guard operation ref', async () => {
		const outcome = await createProver(
			registry({
				rules: [
					rule({
						generateCandidate: (_match, evaluation) => {
							const fragment = baseFragment(evaluation);
							return {
								...fragment,
								guards: [{ ...fragment.guards[0]!, appliesTo: 'missing' }],
							};
						},
					}),
				],
			}),
		).prove(validCompare(), proofTarget(), context);
		expect(outcome.kind).toBe('blocked');
		if (outcome.kind === 'blocked') {
			expect(outcome.assessment.reasons[0]?.code).toBe('uncomposable');
		}
	});

	it('refuses a proof obligation without an operation binding', async () => {
		const outcome = await createProver(
			registry({
				rules: [
					rule({
						generateCandidate: (_match, evaluation) => {
							const fragment = baseFragment(evaluation);
							const { appliesTo: _appliesTo, ...unbound } =
								fragment.obligations[0]!;
							return {
								...fragment,
								obligations: [unbound],
							};
						},
					}),
				],
			}),
		).prove(validCompare(), proofTarget(), context);
		expect(outcome.kind).toBe('blocked');
		if (outcome.kind === 'blocked') {
			expect(outcome.assessment.reasons[0]?.code).toBe('uncomposable');
		}
	});

	it('issues proof observations sequentially on one checked-out client context', async () => {
		const requests = ['one', 'two', 'three'].map(
			(suffix): ObservationRequest => ({
				kind: `mock.column.exists.${suffix}`,
				scope: [columnResource()],
				detail: { table: 'users', column: 'age', suffix },
			}),
		);
		let inFlight = 0;
		let maxInFlight = 0;
		const release = vi.fn();
		const client = {
			query: async () => ({ rows: [] }),
			release,
		};
		const target: TransitionConnectionPool = {
			connect: vi.fn(async () => client),
		};
		const execute = vi.fn(
			async (
				request: ObservationRequest,
				issuedTarget: unknown,
				ctx: ObservationContext,
			): Promise<EvidenceObservation> => {
				expect(issuedTarget).toBe(client);
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise((resolve) => setTimeout(resolve, 0));
				inFlight -= 1;
				return {
					role: 'evidence',
					id: evidenceId(`mock.evidence.${request.kind}`),
					issuer: issuerArtifact,
					request,
					result: {
						value: { claims: [{ kind: request.kind, holds: true }] },
					},
					context: ctx,
					stability: 'externally-mutable',
					takenAt: new Date().toISOString(),
					scope: request.scope,
					source: 'system-catalog',
					validity: { invalidatedBy: [] },
				};
			},
		);
		const customRegistry = registry({
			rules: [
				rule({
					requiredObservations: () => requests,
					evaluate: (_match, evidenceItems) => ({
						outcome: 'applicable',
						obligations: evidenceItems.map((item) => ({
							proposition: {
								kind: item.request.kind,
								scope: item.request.scope,
								detail: item.request.detail,
							},
							scope: item.request.scope,
							dischargeableBy: [item.request],
						})),
						assumptions: [],
					}),
				}),
			],
			issuer: {
				artifact: issuerArtifact,
				readContext: async (contextTarget, ctx) => {
					expect(contextTarget).toBe(client);
					return { ...ctx, effectiveRole: 'proof_role' };
				},
				execute,
			},
		});
		const compare = createComparator(customRegistry).compare(
			model(false),
			model(true),
		);
		if (compare.kind !== 'transitions') {
			throw new Error(`expected transitions, got ${compare.kind}`);
		}
		const outcome = await createProver(customRegistry).prove(
			compare,
			target,
			context,
		);

		expect(outcome.kind).toBe('proven');
		expect(target.connect).toHaveBeenCalledOnce();
		expect(release).toHaveBeenCalledOnce();
		expect(maxInFlight).toBe(1);
		expect(execute.mock.calls.map(([request]) => request.kind)).toEqual(
			requests.map((request) => request.kind),
		);
		if (outcome.kind === 'proven') {
			expect(outcome.plan.observations[0]?.context.effectiveRole).toBe(
				'proof_role',
			);
		}
	});

	it('refuses a missing external-ddl-exclusion assumption', async () => {
		const outcome = await createProver(
			registry({
				rules: [
					rule({
						generateCandidate: (_match, evaluation) => ({
							...baseFragment(evaluation),
							assumptions: [],
						}),
					}),
				],
			}),
		).prove(validCompare(), proofTarget(), context);
		expect(outcome.kind).toBe('blocked');
		if (outcome.kind === 'blocked') {
			expect(outcome.assessment.reasons[0]?.code).toBe('uncomposable');
		}
	});

	it('refuses conflicting duplicate assumption ids', async () => {
		const conflicting = {
			...externalAssumption(),
			statement: 'different content',
		};
		const outcome = await createProver(
			registry({
				rules: [
					rule({
						evaluate: () => ({
							outcome: 'applicable',
							obligations: [obligation()],
							assumptions: [conflicting],
						}),
					}),
				],
			}),
		).prove(validCompare(), proofTarget(), context);
		expect(outcome.kind).toBe('blocked');
	});

	it('refuses a stable-identity guard with no established identity claim', async () => {
		const outcome = await createProver(
			registry({
				rules: [
					rule({
						generateCandidate: (_match, evaluation) => {
							const fragment = baseFragment(evaluation);
							return {
								...fragment,
								guards: [
									{
										...fragment.guards[0]!,
										protocol: {
											kind: 'lock-and-check',
											onFailureLeaves: [],
											binding: {
												kind: 'stable-identity',
												bound: [columnResource()],
												identityClaim: claimId('missing-identity'),
											},
										},
									},
								],
							};
						},
					}),
				],
			}),
		).prove(validCompare(), proofTarget(), context);
		expect(outcome.kind).toBe('blocked');
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
	] as const)('refuses a forged %s claim at the fragment mint boundary', (_label, forgedClaim, expectedDetail) => {
		const fragment = baseFragment({ obligations: [], assumptions: [] });
		const result = validateTransitionRelationalInvariants({
			kind: 'fragment',
			fragment: {
				...fragment,
				guards: [
					{
						...fragment.guards[0]!,
						protocol: {
							kind: 'lock-and-check',
							onFailureLeaves: [],
							binding: {
								kind: 'stable-identity',
								bound: [columnResource()],
								identityClaim: forgedClaim.id,
							},
						},
					},
				],
			},
			claims: [forgedClaim],
			assumptions: [operationAssumption(), externalAssumption()],
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.detail).toMatch(expectedDetail);
		}
	});

	it('refuses multi-candidate composition in this slice', async () => {
		const compare = validCompare();
		const candidate = compare.candidates[0] as TransitionCandidate;
		const bad: typeof compare = {
			...compare,
			candidates: [candidate, candidate],
		};
		const outcome = await createProver(registry()).prove(
			bad,
			proofTarget(),
			context,
		);
		expect(outcome.kind).toBe('blocked');
		if (outcome.kind === 'blocked') {
			expect(outcome.assessment.reasons[0]?.code).toBe('uncomposable');
		}
	});

	it('refuses an undischarged durable obligation', async () => {
		const outcome = await createProver(
			registry({ issuer: emptyIssuer() }),
		).prove(validCompare(), proofTarget(), context);
		expect(outcome.kind).toBe('blocked');
		if (outcome.kind === 'blocked') {
			expect(outcome.assessment.reasons[0]?.code).toBe('insufficient-evidence');
		}
	});

	it('refuses a missing operation-pack-semantics assumption', async () => {
		const outcome = await createProver(
			registry({ semantics: semantics([]) }),
		).prove(validCompare(), proofTarget(), context);
		expect(outcome.kind).toBe('blocked');
		if (outcome.kind === 'blocked') {
			expect(outcome.assessment.reasons[0]?.code).toBe('uncomposable');
		}
	});

	it('blocks an unresolved rule candidate', async () => {
		const compare = validCompare();
		const bad: typeof compare = {
			...compare,
			candidates: [
				{
					...compare.candidates[0]!,
					rule: { id: 'missing', pack: otherRuleArtifact },
				},
			],
		};
		const outcome = await createProver(registry()).prove(
			bad,
			proofTarget(),
			context,
		);
		expect(outcome.kind).toBe('blocked');
	});
});
