import type {
	Assumption,
	CapabilityDescriptor,
	CheckConstraintIR,
	ColumnIR,
	CompareOutcome,
	EnumIR,
	EvidenceObservation,
	ModelIR,
	ObservationContext,
	ObservationIssuer,
	ObservationRequest,
	OperationEffectAssessment,
	PhysicalOperation,
	ProofClaim,
	ProofObligation,
	RelationIR,
	ResourceAddress,
	RulePrecedenceFact,
	SemanticArtifactRef,
	SequenceIR,
	TableIR,
	TransitionCandidate,
	TransitionConnectionPool,
	TransitionFragment,
	TransitionRule,
} from '@dbsp/types';
import { describe, expect, it, vi } from 'vitest';
import { checkDelta } from './check-delta.js';
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
const compositionOperationArtifact: SemanticArtifactRef = {
	id: semanticArtifactId('dbsp.mock.composition.operations'),
	version: '0.1.0',
};
const compositionRuleArtifact: SemanticArtifactRef = {
	id: semanticArtifactId('dbsp.mock.composition.rules'),
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

type ProverOutcome = Awaited<
	ReturnType<ReturnType<typeof createProver>['prove']>
>;

function proofTarget(): TransitionConnectionPool {
	return {
		connect: async () => ({
			query: async () => ({ rows: [] }),
			release: vi.fn(),
		}),
	};
}

function expectBlockedReason(outcome: ProverOutcome, code: string) {
	expect(outcome.kind).toBe('blocked');
	expect(outcome).not.toHaveProperty('plan');
	if (outcome.kind === 'blocked') {
		expect(outcome.assessment.reasons[0]?.code).toBe(code);
	}
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

function check(
	name: string,
	expression: string,
	overrides: Partial<CheckConstraintIR> = {},
): CheckConstraintIR {
	return { name, expression, ...overrides };
}

function tableWithChecks(
	checkConstraints: readonly CheckConstraintIR[],
	nullable = false,
): TableIR {
	return {
		...table(nullable),
		checkConstraints,
	};
}

function modelFromTable(users: TableIR): ModelIR {
	return modelFromTables([users]);
}

function modelFromTables(
	modelTables: readonly TableIR[],
	externalTables: Iterable<string> = [],
	extras: {
		readonly extensions?: readonly string[];
		readonly sequences?: ReadonlyMap<string, SequenceIR>;
	} = {},
): ModelIR {
	const tables = new Map<string, TableIR>();
	for (const table of modelTables) {
		tables.set(table.name, table);
	}
	return {
		tables,
		externalTables: new Set(externalTables),
		relations: new Map(),
		...(extras.extensions !== undefined
			? { extensions: extras.extensions }
			: {}),
		...(extras.sequences !== undefined ? { sequences: extras.sequences } : {}),
		getTable: (name) => tables.get(name),
		getRelation: () => undefined,
		getRelationsFrom: () => [],
		getRelationsTo: () => [],
		isAmbiguous: () => ({ ambiguous: false, options: [] }),
	};
}

function exactReintrospectedCheckModel(expression: string): ModelIR {
	const users: TableIR = {
		name: 'users',
		columns: [
			{
				name: 'age',
				type: 'integer',
				nullable: true,
				originalDbType: 'int4',
			},
		],
		foreignKeys: [],
		indexes: [],
		checkConstraints: [{ name: 'users_age_check', expression }],
	};
	return modelFromTables([users]);
}

function model(nullable: boolean): ModelIR {
	return modelFromTable(table(nullable));
}

function sequence(
	name: string,
	overrides: Partial<SequenceIR> = {},
): SequenceIR {
	return { name, ...overrides };
}

function sequenceMap(
	sequences: readonly SequenceIR[],
): ReadonlyMap<string, SequenceIR> {
	return new Map(sequences.map((entry) => [entry.name, entry]));
}

function relation(name = 'posts'): RelationIR {
	return {
		name,
		type: 'hasMany',
		source: 'users',
		target: name,
		cardinality: 'many',
		optionality: 'optional',
		includeStrategy: 'auto',
		filterStrategy: 'auto',
		joinDefault: 'auto',
	};
}

function relationMap(
	relations: readonly RelationIR[],
): ReadonlyMap<string, RelationIR> {
	return new Map(
		relations.map((entry) => [`${entry.source}.${entry.name}`, entry]),
	);
}

function modelFromTablesWithOptionalCollections(
	modelTables: readonly TableIR[],
	options: {
		readonly relations?: ReadonlyMap<string, RelationIR>;
		readonly omitRelations?: boolean;
		readonly enums?: ReadonlyMap<string, EnumIR>;
		readonly extensions?: readonly string[];
		readonly sequences?: ReadonlyMap<string, SequenceIR>;
	} = {},
): ModelIR {
	const tables = new Map<string, TableIR>();
	for (const table of modelTables) {
		tables.set(table.name, table);
	}
	const relations = options.relations;
	return {
		tables,
		...(options.omitRelations
			? {}
			: { relations: relations ?? new Map<string, RelationIR>() }),
		...(options.enums !== undefined ? { enums: options.enums } : {}),
		...(options.extensions !== undefined
			? { extensions: options.extensions }
			: {}),
		...(options.sequences !== undefined
			? { sequences: options.sequences }
			: {}),
		getTable: (name: string) => tables.get(name),
		getRelation: (qualifiedName: string) => relations?.get(qualifiedName),
		getRelationsFrom: (sourceTable: string) =>
			[...(relations?.values() ?? [])].filter(
				(entry) => entry.source === sourceTable,
			),
		getRelationsTo: (targetTable: string) =>
			[...(relations?.values() ?? [])].filter(
				(entry) => entry.target === targetTable,
			),
		isAmbiguous: () => ({ ambiguous: false, options: [] }),
	} as ModelIR;
}

function enumDef(values: readonly string[], name = 'status'): EnumIR {
	return { name, values };
}

function modelFromEnums(enums: readonly EnumIR[]): ModelIR {
	const enumMap = new Map<string, EnumIR>(
		enums.map((entry) => [entry.name, entry]),
	);
	return {
		tables: new Map(),
		relations: new Map(),
		enums: enumMap,
		getTable: () => undefined,
		getRelation: () => undefined,
		getRelationsFrom: () => [],
		getRelationsTo: () => [],
		isAmbiguous: () => ({ ambiguous: false, options: [] }),
	};
}

function modelWithTableAndEnums(
	users: TableIR,
	enums: readonly EnumIR[],
): ModelIR {
	const tables = new Map<string, TableIR>([['users', users]]);
	const enumMap = new Map<string, EnumIR>(
		enums.map((entry) => [entry.name, entry]),
	);
	return {
		tables,
		relations: new Map(),
		enums: enumMap,
		getTable: (name) => tables.get(name),
		getRelation: () => undefined,
		getRelationsFrom: () => [],
		getRelationsTo: () => [],
		isAmbiguous: () => ({ ambiguous: false, options: [] }),
	};
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

function enumResource(name = 'status'): ResourceAddress {
	return {
		engine: 'postgresql',
		database: 'test',
		kind: 'type',
		name,
		qualifiedBy: ['enum'],
	};
}

function checkResource(name = 'users_age_check'): ResourceAddress {
	return {
		engine: 'postgresql',
		database: 'model',
		kind: 'check-constraint',
		name,
		qualifiedBy: ['users'],
	};
}

function compositionMarkerResource(): ResourceAddress {
	return {
		engine: 'postgresql',
		database: 'test',
		kind: 'table',
		name: 'composition_marker',
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

function compositionOperationAssumption(): Assumption {
	return {
		id: assumptionId('mock.composition.operation-pack-semantics'),
		class: 'operation-pack-semantics',
		asserter: { kind: 'pack', artifact: compositionOperationArtifact },
		statement: 'mock composition operation semantics are correct',
		scope: [compositionMarkerResource()],
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

function obligationForRequest(request: ObservationRequest): ProofObligation {
	return {
		proposition: {
			kind: request.kind,
			scope: request.scope,
			detail: request.detail,
		},
		scope: request.scope,
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

function namedSetNotNullRule(id: string): TransitionRule<{
	readonly table: string;
	readonly column: string;
}> {
	const base = rule({
		generateCandidate: (_match, evaluation) => {
			const fragment = baseFragment(evaluation);
			return {
				...fragment,
				generatedBy: { id, pack: ruleArtifact },
				selectionRationale: {
					chosen: { id, pack: ruleArtifact },
					overRules: [],
					why: `mock ${id}`,
				},
			};
		},
	});
	return { ...base, id };
}

function enumRule(): TransitionRule<{
	readonly type: string;
	readonly label: string;
	readonly after?: string;
}> {
	return {
		id: 'mock.enum-add',
		artifact: ruleArtifact,
		support: {
			engine: 'postgresql',
			versions: [{ min: '18' }],
			requiredCapabilities: ['mock'],
		},
		recognize(desired, current) {
			const desiredEnum = desired.enums?.get('status');
			const currentEnum = current.enums?.get('status');
			if (!desiredEnum || !currentEnum) {
				return { recognized: false };
			}
			const currentValues = new Set(currentEnum.values);
			const added = desiredEnum.values.filter(
				(value) => !currentValues.has(value),
			);
			if (added.length !== 1) {
				return { recognized: false };
			}
			const label = added[0];
			if (!label) {
				return { recognized: false };
			}
			const withoutLabel = desiredEnum.values.filter(
				(value) => value !== label,
			);
			if (JSON.stringify(withoutLabel) !== JSON.stringify(currentEnum.values)) {
				return { recognized: false };
			}
			const index = desiredEnum.values.indexOf(label);
			if (index <= 0) {
				return { recognized: false };
			}
			const after =
				index === desiredEnum.values.length - 1
					? undefined
					: desiredEnum.values[index - 1];
			return after === undefined
				? {
						recognized: true,
						match: { type: 'status', label },
					}
				: {
						recognized: true,
						match: { type: 'status', label, after },
					};
		},
		requiredObservations: () => [],
		evaluate: () => ({
			outcome: 'applicable',
			obligations: [],
			assumptions: [],
		}),
		generateCandidate: () => ({
			generatedBy: { id: 'mock.enum-add', pack: ruleArtifact },
			operations: [
				{
					ref: 'op:enum-add',
					operationKind: { artifact: operationArtifact, name: 'EnumAdd' },
					payload: { type: 'status', label: 'pending' },
				},
			],
			obligations: [],
			assumptions: [],
			guards: [],
			selectionRationale: {
				chosen: { id: 'mock.enum-add', pack: ruleArtifact },
				overRules: [],
				why: 'mock enum add',
			},
		}),
	};
}

function checkRule(): TransitionRule<{
	readonly table: string;
	readonly constraint: string;
}> {
	return {
		id: 'mock.add-check',
		artifact: ruleArtifact,
		support: {
			engine: 'postgresql',
			versions: [{ min: '18' }],
			requiredCapabilities: ['mock'],
		},
		recognize(desired, current) {
			const desiredTable = desired.getTable('users');
			const currentTable = current.getTable('users');
			const desiredChecks = desiredTable?.checkConstraints ?? [];
			const currentNames = new Set(
				(currentTable?.checkConstraints ?? []).map((entry) => entry.name),
			);
			const added = desiredChecks.filter(
				(entry) => !currentNames.has(entry.name),
			);
			return added.length === 1 && added[0]
				? {
						recognized: true,
						match: { table: 'users', constraint: added[0].name },
					}
				: { recognized: false };
		},
		requiredObservations: () => [],
		evaluate: () => ({
			outcome: 'applicable',
			obligations: [],
			assumptions: [],
		}),
		generateCandidate: () => ({
			generatedBy: { id: 'mock.add-check', pack: ruleArtifact },
			operations: [
				{
					ref: 'op:add-check',
					operationKind: { artifact: operationArtifact, name: 'AddCheck' },
					payload: { table: 'users', constraint: 'users_age_check' },
				},
			],
			obligations: [],
			assumptions: [],
			guards: [],
			selectionRationale: {
				chosen: { id: 'mock.add-check', pack: ruleArtifact },
				overRules: [],
				why: 'mock add check',
			},
		}),
	};
}

function checkDeparseRequest(
	constraint = 'users_age_check',
): ObservationRequest {
	return {
		kind: 'mock.check.deparse',
		scope: [checkResource(constraint)],
		detail: { table: 'users', constraint },
	};
}

function claimHolds(
	evidence: readonly EvidenceObservation[],
	request: ObservationRequest,
): boolean | undefined {
	const observation = evidence.find(
		(item) =>
			item.request.kind === request.kind &&
			JSON.stringify(item.request.scope) === JSON.stringify(request.scope) &&
			JSON.stringify(item.request.detail) === JSON.stringify(request.detail),
	);
	const value = observation?.result.value;
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}
	const claims = (value as { readonly claims?: unknown }).claims;
	if (!Array.isArray(claims)) {
		return undefined;
	}
	for (const claim of claims) {
		if (!claim || typeof claim !== 'object' || Array.isArray(claim)) {
			continue;
		}
		const entry = claim as {
			readonly kind?: unknown;
			readonly holds?: unknown;
		};
		if (entry.kind === request.kind && typeof entry.holds === 'boolean') {
			return entry.holds;
		}
	}
	return undefined;
}

function checkEquivalenceRule(): TransitionRule<{
	readonly constraint: string;
}> {
	return {
		...checkRule(),
		id: 'mock.check-equivalence',
		recognize(desired, current, recognitionContext) {
			const desiredCheck = desired
				.getTable('users')
				?.checkConstraints?.find((entry) => entry.name === 'users_age_check');
			const currentCheck = current
				.getTable('users')
				?.checkConstraints?.find((entry) => entry.name === 'users_age_check');
			if (
				!desiredCheck ||
				!currentCheck ||
				desiredCheck.expression === currentCheck.expression
			) {
				return { recognized: false };
			}
			const request = checkDeparseRequest(desiredCheck.name);
			const holds = claimHolds(recognitionContext?.evidence ?? [], request);
			if (holds === true) {
				return {
					recognized: 'no-drift',
					claimDraft: {
						proposition: {
							kind: 'dbsp.model.no-drift',
							scope: [checkResource(desiredCheck.name)],
							detail: request.detail,
						},
						scope: [checkResource(desiredCheck.name)],
						semantics: ruleArtifact,
						conclusion: 'established',
					},
				};
			}
			if (holds === false) {
				return {
					recognized: 'unsupported',
					changes: [checkResource(desiredCheck.name)],
					detail: 'mocked CHECK deparse evidence was different',
				};
			}
			return {
				recognized: 'unknown',
				obligations: [obligationForRequest(request)],
			};
		},
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
		readonly comparatorNameNormalizer?: {
			normalizeCurrentIdentifier(identifier: string): string;
		};
		readonly rulePrecedence?: readonly RulePrecedenceFact[];
	} = {},
) {
	return createPackRegistry([
		{
			rules: options.rules ?? [rule()],
			operationSemantics: [options.semantics ?? semantics()],
			issuer: options.issuer ?? issuer(),
			capabilityDescriptors: options.capabilityDescriptors,
			comparatorNameNormalizer: options.comparatorNameNormalizer,
			rulePrecedence: options.rulePrecedence,
		},
	]);
}

type CompositionMode = 'dependent' | 'cycle' | 'disconnected' | 'invalidates';

function compositionOperation(ref: 'op:a' | 'op:b'): PhysicalOperation {
	return {
		ref,
		operationKind: {
			artifact: compositionOperationArtifact,
			name: ref === 'op:a' ? 'CommitMarker' : 'UseMarker',
		},
		payload: { ref },
	};
}

function compositionRequest(opRef: 'op:a' | 'op:b'): ObservationRequest {
	return {
		kind: `mock.composition.${opRef}.ready`,
		scope: [compositionMarkerResource()],
		detail: { opRef },
	};
}

function compositionObligation(opRef: 'op:a' | 'op:b'): ProofObligation {
	const request = compositionRequest(opRef);
	return {
		proposition: {
			kind: request.kind,
			scope: request.scope,
			detail: request.detail,
		},
		scope: request.scope,
		appliesTo: opRef,
		dischargeableBy: [request],
	};
}

function compositionFact() {
	return {
		kind: 'mock.composition.marker-ready',
		resource: compositionMarkerResource(),
		detail: { marker: 'composition_marker' },
	};
}

function compositionDeclarations(
	opRef: 'op:a' | 'op:b',
	mode: CompositionMode,
): TransitionFragment['composition'] {
	if (mode === 'dependent' || mode === 'invalidates') {
		return opRef === 'op:a'
			? {
					produces: [
						{
							opRef,
							fact: compositionFact(),
							available: 'after-commit',
						},
					],
				}
			: {
					requires: [
						{
							opRef,
							fact: compositionFact(),
							needs: 'producer-after-commit',
						},
					],
				};
	}
	if (mode === 'cycle') {
		return {
			order: [
				opRef === 'op:a'
					? {
							before: 'op:a',
							after: 'op:b',
							reason: 'test cycle first edge',
						}
					: {
							before: 'op:b',
							after: 'op:a',
							reason: 'test cycle second edge',
						},
			],
		};
	}
	return undefined;
}

function compositionRule(
	opRef: 'op:a' | 'op:b',
	mode: CompositionMode = 'dependent',
	recognizedColumn?: 'age' | 'height',
): TransitionRule<{
	readonly opRef: 'op:a' | 'op:b';
}> {
	const id = opRef === 'op:a' ? 'mock.compose.a' : 'mock.compose.b';
	return {
		id,
		artifact: compositionRuleArtifact,
		support: {
			engine: 'postgresql',
			versions: [{ min: '18' }],
			requiredCapabilities: ['mock'],
		},
		recognize: (desired, current) => {
			if (!recognizedColumn) {
				return { recognized: false };
			}
			const desiredColumn = desired.getTable('users')?.columns[0];
			const currentColumn = current.getTable('users')?.columns[0];
			return desiredColumn?.name === recognizedColumn &&
				desiredColumn.nullable === false &&
				currentColumn?.nullable === true
				? { recognized: true, match: { opRef } }
				: { recognized: false };
		},
		requiredObservations: () => [compositionRequest(opRef)],
		evaluate: () => ({
			outcome: 'applicable',
			obligations: [compositionObligation(opRef)],
			assumptions: [],
		}),
		generateCandidate: (_match, evaluation) => ({
			generatedBy: { id, pack: compositionRuleArtifact },
			operations: [compositionOperation(opRef)],
			composition: compositionDeclarations(opRef, mode),
			obligations: evaluation.obligations,
			assumptions: [],
			guards: [],
			selectionRationale: {
				chosen: { id, pack: compositionRuleArtifact },
				overRules: [],
				why: 'test-only composition fixture',
			},
		}),
	};
}

function compositionCandidate(
	rule: TransitionRule<{ readonly opRef: 'op:a' | 'op:b' }>,
	opRef: 'op:a' | 'op:b',
): TransitionCandidate<{ readonly opRef: 'op:a' | 'op:b' }> {
	const requiredObservations = rule.requiredObservations({ opRef });
	return {
		rule: { id: rule.id, pack: rule.artifact },
		match: { opRef },
		requiredObservations,
		obligations: [compositionObligation(opRef)],
		selectionRationale: {
			chosen: { id: rule.id, pack: rule.artifact },
			overRules: [],
			why: 'manual test compare',
		},
	};
}

function compositionCompare(
	ruleA = compositionRule('op:a'),
	ruleB = compositionRule('op:b'),
): Extract<CompareOutcome, { readonly kind: 'transitions' }> {
	const candidates = [
		compositionCandidate(ruleA, 'op:a'),
		compositionCandidate(ruleB, 'op:b'),
	];
	return {
		kind: 'transitions',
		candidates,
		obligations: candidates.flatMap((candidate) => [...candidate.obligations]),
	};
}

function compositionSemantics(
	mode: CompositionMode = 'dependent',
): RegisteredOperationSemantics {
	const marker = { kind: 'table', name: 'composition_marker' };
	const consumer = { kind: 'table', name: 'composition_consumer' };
	const unrelated = { kind: 'table', name: 'composition_unrelated' };
	return {
		artifact: compositionOperationArtifact,
		supportsOperation: (operation) =>
			operation.operationKind.artifact.id === compositionOperationArtifact.id &&
			operation.operationKind.artifact.version ===
				compositionOperationArtifact.version,
		effectsOf: (operation): OperationEffectAssessment => {
			const isA = operation.ref === 'op:a';
			const cycleReads = isA ? [consumer] : [marker];
			const dependentReads = isA
				? []
				: [mode === 'disconnected' ? unrelated : marker];
			return {
				effects: {
					reads: mode === 'cycle' ? cycleReads : dependentReads,
					writes: isA ? [marker] : [consumer],
					locks: [],
					invalidates:
						isA && mode === 'invalidates'
							? [
									{
										proposition: compositionRequest('op:b').kind,
										scope: marker,
									},
								]
							: [],
					contextMutations: [],
					externalEffects: { accountedFor: [], couldNotAccountFor: [] },
					execution: isA
						? { transaction: 'requires-new', commitBoundary: 'after' }
						: { transaction: 'joins-current', commitBoundary: 'none' },
				},
				restsOn: [compositionOperationAssumption()],
			};
		},
		buildFingerprints: (operation) => ({
			expectedBefore: {
				algorithm: 'mock',
				semanticModel: compositionOperationArtifact,
				includedFacts: [{ key: 'op', value: `${operation.ref}:before` }],
				excludedOrUnknownFacts: [],
				digest: `${operation.ref}:before`,
			},
			expectedAfter: {
				algorithm: 'mock',
				semanticModel: compositionOperationArtifact,
				includedFacts: [{ key: 'op', value: `${operation.ref}:after` }],
				excludedOrUnknownFacts: [],
				digest: `${operation.ref}:after`,
			},
		}),
	};
}

function compositionIssuer(): ObservationIssuer {
	return {
		artifact: compositionRuleArtifact,
		execute: async (request, _target, ctx): Promise<EvidenceObservation> => ({
			role: 'evidence',
			id: evidenceId(`mock.evidence.${request.kind}`),
			issuer: compositionRuleArtifact,
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
		}),
	};
}

function compositionRegistry(mode: CompositionMode = 'dependent') {
	const ruleA = compositionRule('op:a', mode);
	const ruleB = compositionRule('op:b', mode);
	return {
		ruleA,
		ruleB,
		registry: createPackRegistry([
			{
				rules: [ruleA, ruleB],
				operationSemantics: [compositionSemantics(mode)],
				issuer: compositionIssuer(),
			},
		]),
	};
}

function recognizedCompositionRegistry(mode: CompositionMode = 'dependent') {
	const ruleA = compositionRule('op:a', mode, 'age');
	const ruleB = compositionRule('op:b', mode, 'height');
	return {
		ruleA,
		ruleB,
		registry: createPackRegistry([
			{
				rules: [ruleA, ruleB],
				operationSemantics: [compositionSemantics(mode)],
				issuer: compositionIssuer(),
			},
		]),
	};
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

	it('uses declared precedence only within a same-group recognition set', async () => {
		const slow = namedSetNotNullRule('mock.set-not-null.slow');
		const fast = namedSetNotNullRule('mock.set-not-null.fast');
		const customRegistry = registry({
			rules: [slow, fast],
			rulePrecedence: [
				{
					higher: { id: fast.id, pack: fast.artifact },
					lower: { id: slow.id, pack: slow.artifact },
					reason: 'fast rule has the narrower guard protocol',
				},
			],
		});

		const compare = createComparator(customRegistry).compare(
			model(false),
			model(true),
		);

		expect(compare.kind).toBe('transitions');
		if (compare.kind !== 'transitions') {
			return;
		}
		expect(compare.candidates).toHaveLength(1);
		expect(compare.candidates[0]?.rule.id).toBe(fast.id);
		expect(compare.candidates[0]?.selectionRationale.overRules).toEqual([
			{ id: slow.id, pack: slow.artifact },
		]);
		expect(compare.candidates[0]?.selectionRationale.why).toContain(
			'fast rule has the narrower guard protocol',
		);

		const outcome = await createProver(customRegistry).prove(
			compare,
			proofTarget(),
			context,
		);
		expect(outcome.kind).toBe('proven');
		if (outcome.kind !== 'proven') {
			return;
		}
		expect(outcome.plan.steps).toHaveLength(1);
		expect(outcome.plan.steps[0]?.selectionRationale.chosen.id).toBe(fast.id);
		expect(outcome.plan.steps[0]?.selectionRationale.overRules).toEqual([
			{ id: slow.id, pack: slow.artifact },
		]);
		expect(outcome.plan.steps[0]?.selectionRationale.why).toContain(
			'fast rule has the narrower guard protocol',
		);
	});

	it('fails closed for same-group recognitions without declared precedence', async () => {
		const slow = namedSetNotNullRule('mock.set-not-null.slow');
		const fast = namedSetNotNullRule('mock.set-not-null.fast');
		const customRegistry = registry({ rules: [slow, fast] });

		const compare = createComparator(customRegistry).compare(
			model(false),
			model(true),
		);

		expect(compare.kind).toBe('ambiguous');
		if (compare.kind !== 'ambiguous') {
			return;
		}
		expect(compare.candidates).toEqual([
			{ id: slow.id, pack: slow.artifact },
			{ id: fast.id, pack: fast.artifact },
		]);

		const outcome = await createProver(customRegistry).prove(
			compare,
			proofTarget(),
			context,
		);
		expectBlockedReason(outcome, 'ambiguous-rule');
	});

	it('keeps different-group recognitions for composition instead of using precedence across them', async () => {
		const { registry: customRegistry } = recognizedCompositionRegistry();
		const compare = createComparator(customRegistry).compare(
			modelFromTable(
				table(false, [column(false, 'age'), column(false, 'height')]),
			),
			modelFromTable(
				table(true, [column(true, 'age'), column(true, 'height')]),
			),
		);

		expect(compare.kind).toBe('transitions');
		if (compare.kind !== 'transitions') {
			return;
		}
		expect(compare.candidates.map((candidate) => candidate.rule.id)).toEqual([
			'mock.compose.a',
			'mock.compose.b',
		]);

		const outcome = await createProver(customRegistry).prove(
			compare,
			proofTarget(),
			context,
		);

		expect(outcome.kind).toBe('proven');
		if (outcome.kind !== 'proven') {
			return;
		}
		expect(outcome.plan.steps.map((step) => step.operation.ref)).toEqual([
			'op:a',
			'op:b',
		]);
		expect(outcome.plan.segments).toMatchObject([
			{
				stepIds: ['step:op:a'],
				commitBoundaryAfter: true,
			},
			{
				stepIds: ['step:op:b'],
				commitBoundaryBefore: true,
			},
		]);
	});

	it('ignores CHECK requiresEnumLabels metadata in physical comparison and check delta fingerprints', () => {
		const desiredCheck = check('users_status_check', "status <> 'archived'", {
			requiresEnumLabels: [
				{ schema: 'tenant', type: 'status', label: 'archived' },
			],
		});
		const currentCheck = check('users_status_check', "status <> 'archived'");

		expect(checkDelta([desiredCheck], [currentCheck])).toEqual({
			kind: 'none',
		});
		const compare = createComparator(registry()).compare(
			modelFromTable(tableWithChecks([desiredCheck])),
			modelFromTable(tableWithChecks([currentCheck])),
		);
		expect(compare.kind).toBe('no-drift');
	});

	it('ignores current-only tables marked external', () => {
		const externalAuditLog: TableIR = {
			name: 'external_audit_log',
			columns: [column(false, 'id')],
			foreignKeys: [],
			indexes: [],
		};
		const compare = createComparator(registry()).compare(
			model(false),
			modelFromTables(
				[table(false), externalAuditLog],
				[externalAuditLog.name],
			),
		);

		expect(compare.kind).toBe('no-drift');
	});

	it('compares desired-managed tables even when current marks them external', () => {
		const compare = createComparator(registry()).compare(
			model(false),
			modelFromTables([table(true)], ['users']),
		);

		expect(compare.kind).toBe('transitions');
		if (compare.kind === 'transitions') {
			expect(compare.candidates[0]?.rule.id).toBe('mock.set-not-null');
		}
	});

	it('ignores current extensions when desired declares no managed extensions', () => {
		const compare = createComparator(registry()).compare(
			modelFromTables([]),
			modelFromTables([], [], {
				extensions: ['pg_ivm', 'citus', 'timescaledb', 'postgis', 'vector'],
			}),
		);

		expect(compare.kind).toBe('no-drift');
	});

	it('surfaces current extensions when desired explicitly manages an empty extension set', () => {
		const compare = createComparator(registry()).compare(
			modelFromTables([], [], { extensions: [] }),
			modelFromTables([], [], { extensions: ['vector'] }),
		);

		expect(compare.kind).toBe('unsupported');
	});

	it('ignores current extensions outside the desired managed extension set', () => {
		const compare = createComparator(registry()).compare(
			modelFromTables([], [], { extensions: ['vector'] }),
			modelFromTables([], [], { extensions: ['citus', 'vector'] }),
		);

		expect(compare.kind).toBe('no-drift');
	});

	it('surfaces a missing desired extension as unsupported drift', () => {
		const compare = createComparator(registry()).compare(
			modelFromTables([], [], { extensions: ['vector'] }),
			modelFromTables([], [], { extensions: [] }),
		);

		expect(compare.kind).toBe('unsupported');
	});

	it('ignores current sequences when desired declares no managed sequences', () => {
		const compare = createComparator(registry()).compare(
			modelFromTables([]),
			modelFromTables([], [], {
				sequences: sequenceMap([sequence('audit_id'), sequence('event_id')]),
			}),
		);

		expect(compare.kind).toBe('no-drift');
	});

	it('surfaces current sequences when desired explicitly manages an empty sequence set', () => {
		const compare = createComparator(registry()).compare(
			modelFromTables([], [], { sequences: sequenceMap([]) }),
			modelFromTables([], [], {
				sequences: sequenceMap([sequence('audit_id')]),
			}),
		);

		expect(compare.kind).toBe('unsupported');
	});

	it('ignores current sequences outside the desired managed sequence set', () => {
		const compare = createComparator(registry()).compare(
			modelFromTables([], [], {
				sequences: sequenceMap([sequence('audit_id')]),
			}),
			modelFromTables([], [], {
				sequences: sequenceMap([sequence('event_id'), sequence('audit_id')]),
			}),
		);

		expect(compare.kind).toBe('no-drift');
	});

	it('surfaces a missing desired sequence as unsupported drift', () => {
		const compare = createComparator(registry()).compare(
			modelFromTables([], [], {
				sequences: sequenceMap([sequence('audit_id')]),
			}),
			modelFromTables([], [], { sequences: sequenceMap([]) }),
		);

		expect(compare.kind).toBe('unsupported');
	});

	it('ignores undefined model-level collections while routing CHECK equivalence', () => {
		const customRegistry = registry({
			rules: [checkRule(), checkEquivalenceRule()],
		});
		const compare = createComparator(customRegistry).compare(
			modelFromTablesWithOptionalCollections(
				[tableWithChecks([check('users_age_check', 'age > 0')])],
				{ omitRelations: true },
			),
			modelFromTablesWithOptionalCollections(
				[tableWithChecks([check('users_age_check', 'CHECK ((age > 0))')])],
				{
					relations: relationMap([relation('posts')]),
					enums: new Map(),
					extensions: ['vector'],
					sequences: sequenceMap([]),
				},
			),
		);

		expect(compare.kind).toBe('unknown');
		if (compare.kind !== 'unknown') {
			return;
		}
		expect(compare.recognitions[0]?.rule.id).toBe('mock.check-equivalence');
	});

	it('surfaces current enums and relations when desired explicitly manages empty collections', () => {
		const compare = createComparator(registry({ rules: [enumRule()] })).compare(
			modelFromTablesWithOptionalCollections([], {
				enums: new Map(),
				relations: new Map(),
			}),
			modelFromTablesWithOptionalCollections([], {
				enums: new Map([['status', enumDef(['active'])]]),
				relations: relationMap([relation('posts')]),
			}),
		);

		expect(compare.kind).toBe('unsupported');
		if (compare.kind === 'unsupported') {
			expect(compare.changes).toContainEqual(
				expect.objectContaining({
					kind: 'type',
					name: 'status',
					qualifiedBy: ['enum'],
				}),
			);
			expect(compare.changes).toContainEqual(
				expect.objectContaining({
					database: 'model',
					kind: 'schema',
					name: 'model',
				}),
			);
		}
	});

	it('ignores current enum and relation siblings outside non-empty desired managed sets', () => {
		const usersPosts = relation('posts');
		const compare = createComparator(registry({ rules: [enumRule()] })).compare(
			modelFromTablesWithOptionalCollections([], {
				enums: new Map([['status', enumDef(['active'])]]),
				relations: relationMap([usersPosts]),
			}),
			modelFromTablesWithOptionalCollections([], {
				enums: new Map([
					['status', enumDef(['active'])],
					['priority', enumDef(['low'], 'priority')],
				]),
				relations: relationMap([usersPosts, relation('comments')]),
			}),
		);

		expect(compare.kind).toBe('no-drift');
	});

	it('ignores unmanaged enum and sequence normalization collisions', () => {
		const compare = createComparator(
			registry({
				comparatorNameNormalizer: {
					normalizeCurrentIdentifier: (identifier) => identifier.toLowerCase(),
				},
			}),
		).compare(
			modelFromTablesWithOptionalCollections([]),
			modelFromTablesWithOptionalCollections([], {
				enums: new Map([
					['Status', enumDef(['active'], 'Status')],
					['status', enumDef(['inactive'], 'status')],
				]),
				sequences: sequenceMap([sequence('Audit_ID'), sequence('audit_id')]),
			}),
		);

		expect(compare.kind).toBe('no-drift');
	});

	it('surfaces enum name-normalization collisions as unsupported drift', () => {
		const compare = createComparator(
			registry({
				rules: [enumRule()],
				comparatorNameNormalizer: {
					normalizeCurrentIdentifier: (identifier) => identifier.toLowerCase(),
				},
			}),
		).compare(
			modelFromEnums([enumDef(['active'], 'status')]),
			modelFromEnums([
				enumDef(['active'], 'Status'),
				enumDef(['inactive'], 'status'),
			]),
		);

		expect(compare.kind).toBe('unsupported');
		if (compare.kind === 'unsupported') {
			expect(compare.changes).toContainEqual(
				expect.objectContaining({
					kind: 'type',
					name: 'status',
					qualifiedBy: ['enum'],
				}),
			);
		}
	});

	it('surfaces sequence name-normalization collisions as unsupported drift', () => {
		const compare = createComparator(
			registry({
				comparatorNameNormalizer: {
					normalizeCurrentIdentifier: (identifier) => identifier.toLowerCase(),
				},
			}),
		).compare(
			modelFromTables([], [], {
				sequences: sequenceMap([sequence('audit_id')]),
			}),
			modelFromTables([], [], {
				sequences: sequenceMap([sequence('Audit_ID'), sequence('audit_id')]),
			}),
		);

		expect(compare.kind).toBe('unsupported');
		if (compare.kind === 'unsupported') {
			expect(compare.changes).toContainEqual(
				expect.objectContaining({
					kind: 'sequence',
					name: 'audit_id',
				}),
			);
		}
	});

	it('keeps non-external current-only tables unsupported', () => {
		const unmanagedTable: TableIR = {
			name: 'audit_log',
			columns: [column(false, 'id')],
			foreignKeys: [],
			indexes: [],
		};
		const compare = createComparator(registry()).compare(
			model(false),
			modelFromTables([table(false), unmanagedTable]),
		);

		expect(compare.kind).toBe('unsupported');
		if (compare.kind === 'unsupported') {
			expect(compare.changes).toContainEqual(
				expect.objectContaining({
					kind: 'table',
					name: unmanagedTable.name,
				}),
			);
		}
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

	it('recognizes exactly one added CHECK as one transition candidate', () => {
		const customRegistry = registry({ rules: [checkRule()] });
		const compare = createComparator(customRegistry).compare(
			modelFromTable(
				tableWithChecks([
					check('users_age_check', 'CHECK ((age > 0))'),
					check('users_height_check', 'CHECK ((height > 0))'),
				]),
			),
			modelFromTable(
				tableWithChecks([check('users_age_check', 'CHECK ((age > 0))')]),
			),
		);

		expect(compare.kind).toBe('transitions');
		if (compare.kind !== 'transitions') {
			return;
		}
		expect(compare.candidates).toHaveLength(1);
		expect(compare.candidates[0]?.rule.id).toBe('mock.add-check');
		expect(compare.candidates[0]?.match).toEqual({
			table: 'users',
			constraint: 'users_height_check',
		});
	});

	it('blocks unsupported CHECK shapes before recognition', () => {
		const customRegistry = registry({ rules: [checkRule()] });
		const cases = [
			[
				modelFromTable(tableWithChecks([])),
				modelFromTable(
					tableWithChecks([check('users_age_check', 'CHECK ((age > 0))')]),
				),
			],
			[
				modelFromTable(
					tableWithChecks([
						check('users_height_check', 'CHECK ((height > 0))'),
					]),
				),
				modelFromTable(
					tableWithChecks([check('users_age_check', 'CHECK ((age > 0))')]),
				),
			],
			[
				modelFromTable(
					tableWithChecks([
						check('users_age_check', 'CHECK ((age > 0))'),
						check('users_height_check', 'CHECK ((height > 0))'),
					]),
				),
				modelFromTable(tableWithChecks([])),
			],
			[
				modelFromTable(
					tableWithChecks([
						check('users_age_check', 'CHECK ((age > 0)) NOT VALID'),
					]),
				),
				modelFromTable(tableWithChecks([])),
			],
			[
				modelFromTable(
					tableWithChecks([
						check('users_age_check', 'CHECK ((age > 0))', {
							notValid: true,
						}),
					]),
				),
				modelFromTable(tableWithChecks([])),
			],
			[
				modelFromTable(
					tableWithChecks([
						check('users_age_check', 'CHECK ((age > 0)) NO INHERIT'),
					]),
				),
				modelFromTable(tableWithChecks([])),
			],
		] as const;

		for (const [desired, current] of cases) {
			const compare = createComparator(customRegistry).compare(
				desired,
				current,
			);
			expect(compare.kind).toBe('unsupported');
		}
	});

	it('keeps same-name CHECK expression mismatch on an evidence path, not add-check', async () => {
		const request: ObservationRequest = {
			kind: 'mock.check.deparse',
			scope: [
				{
					engine: 'postgresql',
					database: 'model',
					kind: 'check-constraint',
					name: 'users_age_check',
					qualifiedBy: ['users'],
				},
			],
			detail: { table: 'users', constraint: 'users_age_check' },
		};
		const equivalenceRule: TransitionRule<{ readonly constraint: string }> = {
			...checkRule(),
			id: 'mock.check-equivalence',
			recognize(desired, current) {
				const desiredCheck = desired
					.getTable('users')
					?.checkConstraints?.find((entry) => entry.name === 'users_age_check');
				const currentCheck = current
					.getTable('users')
					?.checkConstraints?.find((entry) => entry.name === 'users_age_check');
				if (
					desiredCheck &&
					currentCheck &&
					desiredCheck.expression !== currentCheck.expression
				) {
					return {
						recognized: 'unknown',
						obligations: [obligationForRequest(request)],
					};
				}
				return { recognized: false };
			},
		};
		const customRegistry = registry({ rules: [checkRule(), equivalenceRule] });
		const compare = createComparator(customRegistry).compare(
			modelFromTable(
				tableWithChecks([check('users_age_check', 'CHECK ((age > 0))')]),
			),
			modelFromTable(
				tableWithChecks([check('users_age_check', 'CHECK ((age >= 0))')]),
			),
		);

		expect(compare.kind).toBe('unknown');
		if (compare.kind !== 'unknown') {
			return;
		}
		expect(compare.recognitions[0]?.rule.id).toBe('mock.check-equivalence');

		const outcome = await createProver(
			registry({
				rules: [checkRule(), equivalenceRule],
				issuer: emptyIssuer(),
			}),
		).prove(compare, proofTarget(), context);
		expect(outcome.kind).toBe('blocked');
	});

	it('proves a non-canonical same-name CHECK as no-drift when deparse evidence matches', async () => {
		const customRegistry = registry({
			rules: [checkRule(), checkEquivalenceRule()],
			issuer: issuer(true),
		});
		const compare = createComparator(customRegistry).compare(
			modelFromTable(tableWithChecks([check('users_age_check', 'age > 0')])),
			modelFromTable(
				tableWithChecks([check('users_age_check', 'CHECK ((age > 0))')]),
			),
		);

		expect(compare.kind).toBe('unknown');
		if (compare.kind !== 'unknown') {
			return;
		}
		expect(compare.obligations[0]?.proposition.kind).toBe('mock.check.deparse');
		expect(compare.recognitions[0]?.rule.id).toBe('mock.check-equivalence');

		const outcome = await createProver(customRegistry).prove(
			compare,
			proofTarget(),
			context,
		);

		expect(outcome.kind).toBe('no-drift');
	});

	it('routes the exact re-introspected CHECK expression shape through deparse equivalence', async () => {
		const customRegistry = registry({
			rules: [checkRule(), checkEquivalenceRule()],
			issuer: issuer(true),
		});
		const compare = createComparator(customRegistry).compare(
			exactReintrospectedCheckModel('age > 0'),
			exactReintrospectedCheckModel('CHECK ((age > 0))'),
		);

		expect(compare.kind).toBe('unknown');
		if (compare.kind !== 'unknown') {
			return;
		}
		expect(compare.obligations[0]?.proposition.kind).toBe('mock.check.deparse');
		expect(compare.recognitions[0]?.rule.id).toBe('mock.check-equivalence');

		const outcome = await createProver(customRegistry).prove(
			compare,
			proofTarget(),
			context,
		);

		expect(outcome.kind).toBe('no-drift');
	});

	it('blocks the exact re-introspected CHECK expression shape when deparse evidence differs', async () => {
		const customRegistry = registry({
			rules: [checkRule(), checkEquivalenceRule()],
			issuer: issuer(false),
		});
		const compare = createComparator(customRegistry).compare(
			exactReintrospectedCheckModel('age > 0'),
			exactReintrospectedCheckModel('CHECK ((age > 0))'),
		);

		expect(compare.kind).toBe('unknown');
		if (compare.kind !== 'unknown') {
			return;
		}

		const outcome = await createProver(customRegistry).prove(
			compare,
			proofTarget(),
			context,
		);

		expect(outcome.kind).toBe('blocked');
		if (outcome.kind === 'blocked') {
			expect(outcome.assessment.reasons[0]).toMatchObject({
				code: 'unsupported-transition',
				changes: [checkResource()],
			});
		}
	});

	it('blocks a same-name CHECK when deparse evidence differs', async () => {
		const customRegistry = registry({
			rules: [checkRule(), checkEquivalenceRule()],
			issuer: issuer(false),
		});
		const compare = createComparator(customRegistry).compare(
			modelFromTable(tableWithChecks([check('users_age_check', 'age > 0')])),
			modelFromTable(
				tableWithChecks([check('users_age_check', 'CHECK ((age >= 0))')]),
			),
		);

		expect(compare.kind).toBe('unknown');
		if (compare.kind !== 'unknown') {
			return;
		}

		const outcome = await createProver(customRegistry).prove(
			compare,
			proofTarget(),
			context,
		);

		expect(outcome.kind).toBe('blocked');
		if (outcome.kind === 'blocked') {
			expect(outcome.assessment.reasons[0]).toMatchObject({
				code: 'unsupported-transition',
				changes: [checkResource()],
			});
		}
	});

	it('does not add a schema-level hidden diff for a pending CHECK deparse mismatch', () => {
		const customRegistry = registry({ rules: [rule()] });
		const compare = createComparator(customRegistry).compare(
			modelFromTable(tableWithChecks([check('users_age_check', 'age > 0')])),
			modelFromTable(
				tableWithChecks([check('users_age_check', 'CHECK ((age > 0))')]),
			),
		);

		expect(compare.kind).toBe('unsupported');
		if (compare.kind !== 'unsupported') {
			return;
		}
		expect(compare.changes).toContainEqual(checkResource());
		expect(compare.changes).not.toContainEqual(
			expect.objectContaining({
				database: 'model',
				kind: 'schema',
				name: 'model',
			}),
		);
	});

	it('keeps schema-level hidden diffs when a pending CHECK deparse has a non-check sibling diff', () => {
		const customRegistry = registry({
			rules: [checkRule(), checkEquivalenceRule()],
			issuer: issuer(true),
		});
		const desired = exactReintrospectedCheckModel('age > 0');
		const users = desired.getTable('users');
		if (!users) {
			throw new Error('missing users table');
		}
		const compare = createComparator(customRegistry).compare(
			modelFromTable({ ...users, comment: 'changed too' }),
			exactReintrospectedCheckModel('CHECK ((age > 0))'),
		);

		expect(compare.kind).toBe('unsupported');
		if (compare.kind !== 'unsupported') {
			return;
		}
		expect(compare.changes).toContainEqual(
			expect.objectContaining({
				database: 'model',
				kind: 'schema',
				name: 'model',
			}),
		);
	});

	it('fails closed for CHECK add plus a column change without composition declarations', async () => {
		const customRegistry = createPackRegistry([
			{
				rules: [rule(), checkRule()],
				operationSemantics: [
					semantics(),
					semantics([operationAssumption()], {
						artifact: operationArtifact,
						name: 'AddCheck',
					}),
				],
				issuer: issuer(),
			},
		]);
		const compare = createComparator(customRegistry).compare(
			modelFromTable({
				...table(false),
				checkConstraints: [check('users_age_check', 'CHECK ((age > 0))')],
			}),
			model(true),
		);

		expect(compare.kind).toBe('transitions');
		if (compare.kind !== 'transitions') {
			return;
		}
		expect(compare.candidates.map((candidate) => candidate.rule.id)).toEqual([
			'mock.set-not-null',
			'mock.add-check',
		]);

		const outcome = await createProver(customRegistry).prove(
			compare,
			proofTarget(),
			context,
		);

		expectBlockedReason(outcome, 'uncomposable');
		if (outcome.kind === 'blocked') {
			expect(outcome.assessment.reasons[0]?.detail).toMatch(
				/ambiguous|unordered/i,
			);
		}
	});

	it('returns transitions when two recognized column changes are present', () => {
		const desired = modelFromTable(
			table(false, [column(false, 'age'), column(false, 'height')]),
		);
		const current = modelFromTable(
			table(true, [column(true, 'age'), column(true, 'height')]),
		);
		const customRegistry = registry();
		const compare = createComparator(customRegistry).compare(desired, current);

		expect(compare.kind).toBe('transitions');
		if (compare.kind !== 'transitions') {
			return;
		}
		expect(compare.candidates.map((candidate) => candidate.match)).toEqual([
			{ table: 'users', column: 'age' },
			{ table: 'users', column: 'height' },
		]);
	});

	it('recognizes one added enum label as a transition candidate', () => {
		const customRegistry = registry({ rules: [enumRule()] });
		const compare = createComparator(customRegistry).compare(
			modelFromEnums([enumDef(['active', 'pending'])]),
			modelFromEnums([enumDef(['active'])]),
		);

		expect(compare.kind).toBe('transitions');
		if (compare.kind !== 'transitions') {
			return;
		}
		expect(compare.candidates).toHaveLength(1);
		expect(compare.candidates[0]?.rule.id).toBe('mock.enum-add');
		expect(compare.candidates[0]?.match).toEqual({
			type: 'status',
			label: 'pending',
		});
	});

	it('treats an unchanged enum with unspecified desired schema as no-drift', () => {
		const customRegistry = registry({ rules: [enumRule()] });
		const compare = createComparator(customRegistry).compare(
			modelFromEnums([enumDef(['active', 'pending'])]),
			modelFromEnums([{ ...enumDef(['active', 'pending']), schema: 'tenant' }]),
		);

		expect(compare.kind).toBe('no-drift');
		if (compare.kind === 'transitions') {
			expect(compare.candidates).toHaveLength(0);
		}
	});

	it('surfaces explicit enum schema drift as unsupported', () => {
		const customRegistry = registry({ rules: [enumRule()] });
		const compare = createComparator(customRegistry).compare(
			modelFromEnums([
				{ ...enumDef(['active', 'pending']), schema: 'desired' },
			]),
			modelFromEnums([
				{ ...enumDef(['active', 'pending']), schema: 'current' },
			]),
		);

		expect(compare.kind).toBe('unsupported');
		if (compare.kind === 'unsupported') {
			expect(compare.changes).toContainEqual(
				expect.objectContaining({
					kind: 'type',
					name: 'status',
					qualifiedBy: ['enum'],
					schema: 'desired',
				}),
			);
		}
	});

	it('blocks removed, renamed, and reordered enum labels as unsupported', () => {
		const customRegistry = registry({ rules: [enumRule()] });
		const removed = createComparator(customRegistry).compare(
			modelFromEnums([enumDef(['active'])]),
			modelFromEnums([enumDef(['active', 'pending'])]),
		);
		const renamed = createComparator(customRegistry).compare(
			modelFromEnums([enumDef(['active', 'queued'])]),
			modelFromEnums([enumDef(['active', 'pending'])]),
		);
		const reordered = createComparator(customRegistry).compare(
			modelFromEnums([enumDef(['pending', 'active'])]),
			modelFromEnums([enumDef(['active', 'pending'])]),
		);

		for (const compare of [removed, renamed, reordered]) {
			expect(compare.kind).toBe('unsupported');
			if (compare.kind === 'unsupported') {
				expect(compare.changes[0]).toMatchObject({
					kind: 'type',
					name: 'status',
					qualifiedBy: ['enum'],
				});
			}
		}
	});

	it('fails closed for enum-add plus a column change without composition declarations', async () => {
		const customRegistry = createPackRegistry([
			{
				rules: [rule(), enumRule()],
				operationSemantics: [
					semantics(),
					semantics([operationAssumption()], {
						artifact: operationArtifact,
						name: 'EnumAdd',
					}),
				],
				issuer: issuer(),
			},
		]);
		const compare = createComparator(customRegistry).compare(
			modelWithTableAndEnums(table(false), [enumDef(['active', 'pending'])]),
			modelWithTableAndEnums(table(true), [enumDef(['active'])]),
		);

		expect(compare.kind).toBe('transitions');
		if (compare.kind !== 'transitions') {
			return;
		}
		expect(compare.candidates.map((candidate) => candidate.rule.id)).toEqual([
			'mock.set-not-null',
			'mock.enum-add',
		]);

		const outcome = await createProver(customRegistry).prove(
			compare,
			proofTarget(),
			context,
		);

		expectBlockedReason(outcome, 'uncomposable');
		if (outcome.kind === 'blocked') {
			expect(outcome.assessment.reasons[0]?.detail).toMatch(
				/ambiguous|unordered/i,
			);
		}
	});

	it('blocks mixed recognized and retryable unknown changes before observation', async () => {
		const ageRule: TransitionRule<{
			readonly table: string;
			readonly column: string;
		}> = {
			...rule(),
			recognize(desired, current) {
				const desiredColumn = desired.getTable('users')?.columns[0];
				const currentColumn = current.getTable('users')?.columns[0];
				return desiredColumn?.name === 'age' &&
					desiredColumn.nullable === false &&
					currentColumn?.nullable === true
					? {
							recognized: true,
							match: { table: 'users', column: desiredColumn.name },
						}
					: { recognized: false };
			},
		};
		const heightRecognitionRequest: ObservationRequest = {
			kind: 'mock.height.recognition',
			scope: [columnResource('height')],
			detail: { table: 'users', column: 'height' },
		};
		const heightRule: TransitionRule<{
			readonly table: string;
			readonly column: string;
		}> = {
			...rule(),
			id: 'mock.height-retry',
			recognize(desired, current, recognitionContext) {
				const desiredColumn = desired.getTable('users')?.columns[0];
				const currentColumn = current.getTable('users')?.columns[0];
				if (
					desiredColumn?.name !== 'height' ||
					desiredColumn.nullable !== false ||
					currentColumn?.nullable !== true
				) {
					return { recognized: false };
				}
				if ((recognitionContext?.evidence ?? []).length > 0) {
					return {
						recognized: true,
						match: { table: 'users', column: desiredColumn.name },
					};
				}
				return {
					recognized: 'unknown',
					obligations: [
						{
							proposition: {
								kind: heightRecognitionRequest.kind,
								scope: heightRecognitionRequest.scope,
								detail: heightRecognitionRequest.detail,
							},
							scope: heightRecognitionRequest.scope,
							dischargeableBy: [heightRecognitionRequest],
						},
					],
				};
			},
			requiredObservations: () => [heightRecognitionRequest],
			generateCandidate: (_match, evaluation) => {
				const fragment = baseFragment(evaluation);
				return {
					...fragment,
					generatedBy: { id: 'mock.height-retry', pack: ruleArtifact },
					selectionRationale: {
						chosen: { id: 'mock.height-retry', pack: ruleArtifact },
						overRules: [],
						why: 'mock retryable recognition',
					},
				};
			},
		};
		const readContext = vi.fn(async () => context);
		const execute = vi.fn(issuer().execute);
		const customRegistry = registry({
			rules: [ageRule, heightRule],
			issuer: {
				artifact: issuerArtifact,
				readContext,
				execute,
			},
		});
		const compare = createComparator(customRegistry).compare(
			modelFromTable(
				table(false, [column(false, 'age'), column(false, 'height')]),
			),
			modelFromTable(
				table(true, [column(true, 'age'), column(true, 'height')]),
			),
		);

		expect(compare.kind).toBe('uncomposable');
		if (compare.kind !== 'uncomposable') {
			return;
		}
		expect(compare.candidates).toHaveLength(1);
		expect(compare.recognitions).toHaveLength(1);
		expect(compare.detail).toMatch(/whole diff/i);
		const connect = vi.fn(proofTarget().connect);
		const target: TransitionConnectionPool = { connect };
		const outcome = await createProver(customRegistry).prove(
			compare,
			target,
			context,
		);

		expect(outcome.kind).toBe('blocked');
		expect(outcome).not.toHaveProperty('plan');
		expect(readContext).not.toHaveBeenCalled();
		expect(execute).not.toHaveBeenCalled();
		expect(connect).not.toHaveBeenCalled();
		if (outcome.kind === 'blocked') {
			expect(outcome.assessment.reasons[0]?.code).toBe('uncomposable');
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

	it('validates declared rule precedence facts at registration', () => {
		const fast = namedSetNotNullRule('mock.set-not-null.fast');
		const slow = namedSetNotNullRule('mock.set-not-null.slow');
		const fallback = namedSetNotNullRule('mock.set-not-null.fallback');
		const basePack = {
			rules: [fast, slow, fallback],
			operationSemantics: [],
			issuer: issuer(),
		};
		const fastRef = { id: fast.id, pack: fast.artifact };
		const slowRef = { id: slow.id, pack: slow.artifact };
		const fallbackRef = { id: fallback.id, pack: fallback.artifact };

		expect(() =>
			createPackRegistry([
				{
					...basePack,
					rulePrecedence: [
						{
							higher: fastRef,
							lower: { id: 'mock.missing', pack: ruleArtifact },
							reason: 'missing lower rule',
						},
					],
				},
			]),
		).toThrow(/did not resolve/);

		expect(() =>
			createPackRegistry([
				{
					...basePack,
					rulePrecedence: [
						{ higher: fastRef, lower: slowRef, reason: 'first' },
						{ higher: fastRef, lower: slowRef, reason: 'duplicate' },
					],
				},
			]),
		).toThrow(/duplicate rule precedence/);

		expect(() =>
			createPackRegistry([
				{
					...basePack,
					rulePrecedence: [
						{ higher: fastRef, lower: slowRef, reason: 'fast wins' },
						{ higher: slowRef, lower: fastRef, reason: 'slow wins' },
					],
				},
			]),
		).toThrow(/conflicting rule precedence/);

		expect(() =>
			createPackRegistry([
				{
					...basePack,
					rulePrecedence: [
						{ higher: fastRef, lower: slowRef, reason: 'fast wins' },
						{
							higher: slowRef,
							lower: fallbackRef,
							reason: 'slow beats fallback',
						},
						{
							higher: fallbackRef,
							lower: fastRef,
							reason: 'fallback beats fast',
						},
					],
				},
			]),
		).toThrow(/cyclic rule precedence/);
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

	it('proves dependency-ordered candidates into one composed plan', async () => {
		const { registry: customRegistry, ruleA, ruleB } = compositionRegistry();
		const release = vi.fn();
		const connect = vi.fn(async () => ({
			query: async () => ({ rows: [] }),
			release,
		}));
		const outcome = await createProver(customRegistry).prove(
			compositionCompare(ruleA, ruleB),
			{ connect },
			context,
		);

		expect(outcome.kind).toBe('proven');
		expect(connect).toHaveBeenCalledOnce();
		expect(release).toHaveBeenCalledOnce();
		if (outcome.kind !== 'proven') {
			return;
		}
		expect(outcome.plan.steps.map((step) => step.operation.ref)).toEqual([
			'op:a',
			'op:b',
		]);
		expect(outcome.plan.steps[1]?.requiredClaims).toHaveLength(1);
		expect(outcome.plan.segments).toMatchObject([
			{
				stepIds: ['step:op:a'],
				commitBoundaryAfter: true,
			},
			{
				stepIds: ['step:op:b'],
				commitBoundaryBefore: true,
			},
		]);
	});

	it('fails closed on cyclic multi-operation composition validation', async () => {
		const {
			registry: customRegistry,
			ruleA,
			ruleB,
		} = compositionRegistry('cycle');
		const outcome = await createProver(customRegistry).prove(
			compositionCompare(ruleA, ruleB),
			proofTarget(),
			context,
		);

		expectBlockedReason(outcome, 'uncomposable');
		if (outcome.kind === 'blocked') {
			expect(outcome.assessment.reasons[0]?.detail).toMatch(/cycle/i);
		}
	});

	it('fails closed on disconnected multi-operation composition validation', async () => {
		const {
			registry: customRegistry,
			ruleA,
			ruleB,
		} = compositionRegistry('disconnected');
		const outcome = await createProver(customRegistry).prove(
			compositionCompare(ruleA, ruleB),
			proofTarget(),
			context,
		);

		expectBlockedReason(outcome, 'uncomposable');
		if (outcome.kind === 'blocked') {
			expect(outcome.assessment.reasons[0]?.detail).toMatch(
				/ambiguous|unordered/i,
			);
		}
	});

	it('fails closed when multi-candidate observation evidence conflicts', async () => {
		const ruleA = compositionRule('op:a');
		const ruleB = compositionRule('op:b');
		const execute = vi.fn(
			async (
				request: ObservationRequest,
				_target,
				ctx,
			): Promise<EvidenceObservation> => ({
				role: 'evidence',
				id: evidenceId('mock.evidence.duplicate-composition'),
				issuer: compositionRuleArtifact,
				request,
				result: {
					value: {
						claims: [
							{
								kind: request.kind,
								holds: true,
							},
						],
					},
				},
				context: ctx,
				stability: 'externally-mutable',
				takenAt: '2026-01-01T00:00:00.000Z',
				scope: request.scope,
				source: 'system-catalog',
				validity: { invalidatedBy: [] },
			}),
		);
		const customRegistry = createPackRegistry([
			{
				rules: [ruleA, ruleB],
				operationSemantics: [compositionSemantics()],
				issuer: {
					artifact: compositionRuleArtifact,
					execute,
				},
			},
		]);
		const connect = vi.fn(proofTarget().connect);

		const outcome = await createProver(customRegistry).prove(
			compositionCompare(ruleA, ruleB),
			{ connect },
			context,
		);

		expectBlockedReason(outcome, 'context-mismatch');
		expect(connect).toHaveBeenCalledOnce();
		expect(execute).toHaveBeenCalledTimes(2);
		if (outcome.kind === 'blocked') {
			expect(outcome.assessment.reasons[0]).toMatchObject({
				fact: {
					value: expect.stringMatching(/duplicate observation id/i),
				},
			});
		}
	});

	it('fails closed when an earlier composed step invalidates a later required claim', async () => {
		const {
			registry: customRegistry,
			ruleA,
			ruleB,
		} = compositionRegistry('invalidates');
		const outcome = await createProver(customRegistry).prove(
			compositionCompare(ruleA, ruleB),
			proofTarget(),
			context,
		);

		expectBlockedReason(outcome, 'uncomposable');
		if (outcome.kind === 'blocked') {
			expect(outcome.assessment.reasons[0]?.detail).toMatch(/invalidated/i);
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

	it('fails closed before duplicate operation refs in a multi-candidate composition', async () => {
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
		expectBlockedReason(outcome, 'uncomposable');
		if (outcome.kind === 'blocked') {
			expect(outcome.assessment.reasons[0]?.detail).toMatch(
				/duplicate operation ref/i,
			);
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
