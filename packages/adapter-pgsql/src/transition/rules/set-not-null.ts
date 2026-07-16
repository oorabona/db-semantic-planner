import type {
	ApplicableEvaluation,
	Assumption,
	ColumnIR,
	EvidenceObservation,
	JsonValue,
	ModelIR,
	ObservationRequest,
	PhysicalOperation,
	ProofObligation,
	RecognitionContext,
	RecognitionResult,
	ResourceAddress,
	RuleEvaluation,
	TransitionFragment,
	TransitionRule,
} from '@dbsp/types';
import type { NamingPlugin } from '../../naming-plugin.js';
import { identityNaming } from '../../naming-plugin.js';
import {
	columnShapeFromColumn,
	compareSetNotNullColumnShape,
	expectedColumnShapeFor,
	type SetNotNullColumnShapeExpectation,
} from '../column-shape.js';
import {
	ALTER_AUTHORITY_OBSERVATION,
	ALTER_COLUMN_SET_NOT_NULL_CAPABILITY,
	ALTER_COLUMN_SET_NOT_NULL_MIN_SERVER_VERSION_NUM,
	ALTER_COLUMN_SET_NOT_NULL_OPERATION_KIND,
	COLUMN_EXISTS_OBSERVATION,
	ENGINE_VERSION_OBSERVATION,
	NO_NULLS_GUARD,
	PG_OPERATION_PACK_ARTIFACT,
	PG_RULE_PACK_ARTIFACT,
	SET_NOT_NULL_RELATION_KIND_SUPPORTED_OBSERVATION,
	SET_NOT_NULL_RULE_ID,
} from '../constants.js';
import { createPgEquivalenceCapability } from '../equivalence.js';
import { assumptionId } from '../ids.js';
import { stableJson } from '../stable-json.js';

export {
	columnWithoutNullable,
	expectedColumnShapeFor,
} from '../column-shape.js';

export interface SetNotNullMatch {
	readonly schema?: string;
	readonly database?: string;
	readonly table: string;
	readonly column: string;
	readonly expectedColumnShape: SetNotNullColumnShapeExpectation;
}

type ResolvedSetNotNullMatch = SetNotNullMatch & {
	readonly schema: string;
	readonly database: string;
};

const PARTITIONED_TABLE_UNSUPPORTED_DETAIL =
	'partitioned tables are not yet supported by the SET NOT NULL transition';

export interface SetNotNullRuleOptions {
	readonly naming?: NamingPlugin;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function sameRequest(
	left: ObservationRequest,
	right: ObservationRequest,
): boolean {
	return (
		left.kind === right.kind &&
		stableJson(left.scope) === stableJson(right.scope) &&
		stableJson(left.detail) === stableJson(right.detail)
	);
}

function sameLogicalDetail(
	requested: ObservationRequest,
	issued: ObservationRequest,
): boolean {
	if (requested.kind !== issued.kind) {
		return false;
	}
	if (!isRecord(requested.detail) || !isRecord(issued.detail)) {
		return stableJson(requested.detail) === stableJson(issued.detail);
	}
	if (
		'minServerVersionNum' in requested.detail ||
		'minServerVersionNum' in issued.detail
	) {
		return (
			requested.detail.minServerVersionNum === issued.detail.minServerVersionNum
		);
	}
	return (
		requested.detail.table === issued.detail.table &&
		requested.detail.column === issued.detail.column &&
		(requested.detail.schema == null ||
			requested.detail.schema === issued.detail.schema)
	);
}

function isPureNullabilityTightening(
	desired: ColumnIR,
	current: ColumnIR,
	physicalName: string,
	context: RecognitionContext | undefined,
): RecognitionResult<{
	readonly expectedColumnShape: SetNotNullColumnShapeExpectation;
}> {
	const expectedColumnShape = expectedColumnShapeFor(desired, physicalName);
	const comparison = compareSetNotNullColumnShape(
		expectedColumnShape,
		columnShapeFromColumn(current, physicalName),
		context?.equivalence ?? createPgEquivalenceCapability(),
		context?.context ?? { engine: 'postgresql' },
		context?.evidence,
	);
	if (comparison.kind === 'equivalent') {
		return {
			recognized: true,
			match: { expectedColumnShape },
			claimDrafts: comparison.claimDrafts,
		};
	}
	if (comparison.kind === 'unknown') {
		return { recognized: 'unknown', obligations: comparison.obligations };
	}
	return { recognized: false };
}

function resourceForMatch(
	match: SetNotNullMatch,
	kind: 'table' | 'column',
	database = match.database ?? 'model',
): ResourceAddress {
	const base: ResourceAddress = {
		engine: 'postgresql',
		database,
		kind,
		name: kind === 'table' ? match.table : match.column,
	};
	const qualified =
		kind === 'column' ? { ...base, qualifiedBy: [match.table] } : base;
	return match.schema ? { ...qualified, schema: match.schema } : qualified;
}

function requestDetail(match: SetNotNullMatch) {
	return {
		table: match.table,
		column: match.column,
		schema: match.schema ?? null,
	};
}

function requiredObservationsFor(
	match: SetNotNullMatch,
): readonly ObservationRequest[] {
	return [
		{
			kind: COLUMN_EXISTS_OBSERVATION,
			scope: [resourceForMatch(match, 'column')],
			detail: requestDetail(match),
		},
		{
			kind: ALTER_AUTHORITY_OBSERVATION,
			scope: [resourceForMatch(match, 'table')],
			detail: requestDetail(match),
		},
		{
			kind: ENGINE_VERSION_OBSERVATION,
			scope: [
				{
					engine: 'postgresql',
					database: match.database ?? 'model',
					kind: 'engine',
					name: 'postgresql',
				},
			],
			detail: {
				minServerVersionNum: ALTER_COLUMN_SET_NOT_NULL_MIN_SERVER_VERSION_NUM,
			},
		},
	];
}

function obligationFor(
	request: ObservationRequest,
	appliesTo?: string,
): ProofObligation {
	const proposition =
		request.detail === undefined
			? {
					kind: request.kind,
					scope: request.scope,
				}
			: {
					kind: request.kind,
					scope: request.scope,
					detail: request.detail,
				};
	const obligation: ProofObligation = {
		proposition,
		scope: request.scope,
		dischargeableBy: [request],
	};
	return appliesTo ? { ...obligation, appliesTo } : obligation;
}

function externalDdlAssumption(match: SetNotNullMatch): Assumption {
	const database = match.database ?? 'model';
	return {
		id: assumptionId(
			`dbsp.postgresql.external-ddl-exclusion:${JSON.stringify([
				database,
				match.schema ?? null,
				match.table,
				match.column,
			])}`,
		),
		class: 'external-ddl-exclusion',
		asserter: { kind: 'pack', artifact: PG_RULE_PACK_ARTIFACT },
		statement:
			'No concurrent DDL renames or replaces the table or column while the set-not-null lock is acquired and checked.',
		scope: [
			resourceForMatch(match, 'table', database),
			resourceForMatch(match, 'column', database),
		],
	};
}

function claimHolds(
	evidence: readonly EvidenceObservation[],
	request: ObservationRequest,
): boolean | undefined {
	for (const observation of evidence) {
		if (!sameRequest(observation.request, request)) {
			continue;
		}
		const value = observation.result.value;
		if (!isRecord(value) || !Array.isArray(value.claims)) {
			continue;
		}
		for (const claim of value.claims) {
			if (!isRecord(claim)) {
				continue;
			}
			if (claim.kind === request.kind && typeof claim.holds === 'boolean') {
				return claim.holds;
			}
		}
	}
	return undefined;
}

function relationKind(
	evidence: readonly EvidenceObservation[],
	request: ObservationRequest,
): string | undefined {
	for (const observation of evidence) {
		if (!sameRequest(observation.request, request)) {
			continue;
		}
		const value = observation.result.value;
		if (isRecord(value) && typeof value.relkind === 'string') {
			return value.relkind;
		}
	}
	return undefined;
}

function partitionedTableUnsupportedObligation(
	match: SetNotNullMatch,
	columnRequest: ObservationRequest,
): ProofObligation {
	const database =
		columnRequest.scope.find((resource) => resource.database)?.database ??
		match.database ??
		'model';
	const schema =
		columnRequest.scope.find((resource) => resource.schema)?.schema ??
		match.schema;
	const scopedMatch: SetNotNullMatch = schema
		? { ...match, schema, database }
		: { ...match, database };
	const scope = [
		resourceForMatch(scopedMatch, 'table', database),
		resourceForMatch(scopedMatch, 'column', database),
	];
	return {
		proposition: {
			kind: SET_NOT_NULL_RELATION_KIND_SUPPORTED_OBSERVATION,
			scope,
			detail: PARTITIONED_TABLE_UNSUPPORTED_DETAIL,
		},
		scope,
		dischargeableBy: [columnRequest],
	};
}

function evaluationObligations(
	match: SetNotNullMatch,
	evidence: readonly EvidenceObservation[],
): readonly ProofObligation[] {
	return requiredObservationsFor(match).map((request) => {
		const normalized =
			evidence.find((observation) =>
				sameLogicalDetail(request, observation.request),
			)?.request ?? request;
		return obligationFor(normalized);
	});
}

function operationRef(match: SetNotNullMatch): string {
	return `postgresql:set-not-null:${JSON.stringify([
		match.schema ?? null,
		match.table,
		match.column,
	])}`;
}

function operationFor(match: SetNotNullMatch): PhysicalOperation {
	const payload = match.schema
		? {
				schema: match.schema,
				table: match.table,
				column: match.column,
				expectedColumnShape: match.expectedColumnShape,
			}
		: {
				table: match.table,
				column: match.column,
				expectedColumnShape: match.expectedColumnShape,
			};
	return {
		ref: operationRef(match),
		operationKind: ALTER_COLUMN_SET_NOT_NULL_OPERATION_KIND,
		payload: payload as unknown as JsonValue,
	};
}

function schemaFromEvaluation(
	evaluation: ApplicableEvaluation,
): string | undefined {
	for (const obligation of evaluation.obligations) {
		for (const request of obligation.dischargeableBy ?? []) {
			if (
				isRecord(request.detail) &&
				typeof request.detail.schema === 'string'
			) {
				return request.detail.schema;
			}
		}
		for (const resource of obligation.scope) {
			if (resource.schema) {
				return resource.schema;
			}
		}
	}
	return undefined;
}

function databaseFromEvaluation(
	evaluation: ApplicableEvaluation,
): string | undefined {
	for (const obligation of evaluation.obligations) {
		for (const request of obligation.dischargeableBy ?? []) {
			for (const resource of request.scope) {
				if (resource.database && resource.database !== 'model') {
					return resource.database;
				}
			}
		}
		for (const resource of obligation.scope) {
			if (resource.database && resource.database !== 'model') {
				return resource.database;
			}
		}
	}
	return undefined;
}

function matchForOperation(
	match: SetNotNullMatch,
	evaluation: ApplicableEvaluation,
): ResolvedSetNotNullMatch {
	const schema = match.schema ?? schemaFromEvaluation(evaluation);
	if (!schema) {
		throw new Error('set-not-null requires an explicit target schema');
	}
	const database = match.database ?? databaseFromEvaluation(evaluation);
	if (!database) {
		throw new Error('set-not-null requires a live database identity');
	}
	return { ...match, schema, database };
}

export function createSetNotNullRule(
	options: SetNotNullRuleOptions = {},
): TransitionRule<SetNotNullMatch> {
	const naming = options.naming ?? identityNaming;
	return {
		id: SET_NOT_NULL_RULE_ID,
		artifact: PG_RULE_PACK_ARTIFACT,
		support: {
			engine: 'postgresql',
			versions: [{ min: '18' }],
			requiredCapabilities: [ALTER_COLUMN_SET_NOT_NULL_CAPABILITY],
		},
		recognize(
			desired: ModelIR,
			current: ModelIR,
			context?: RecognitionContext,
		): RecognitionResult<SetNotNullMatch> {
			for (const desiredTable of desired.tables.values()) {
				const currentTable = current.getTable(desiredTable.name);
				if (!currentTable) {
					continue;
				}
				for (const desiredColumn of desiredTable.columns) {
					const currentColumn = currentTable.columns.find(
						(column) => column.name === desiredColumn.name,
					);
					if (!currentColumn) {
						continue;
					}
					const physicalColumn = naming.toDatabase(desiredColumn.name);
					const nullabilityTightening = isPureNullabilityTightening(
						desiredColumn,
						currentColumn,
						physicalColumn,
						context,
					);
					if (nullabilityTightening.recognized === 'unknown') {
						return nullabilityTightening;
					}
					if (nullabilityTightening.recognized) {
						const recognized = {
							recognized: true,
							match: {
								table: naming.toDatabase(desiredTable.name),
								column: physicalColumn,
								expectedColumnShape:
									nullabilityTightening.match.expectedColumnShape,
							},
						};
						return nullabilityTightening.claimDrafts
							? {
									...recognized,
									claimDrafts: nullabilityTightening.claimDrafts,
								}
							: recognized;
					}
				}
			}
			return { recognized: false };
		},
		requiredObservations: requiredObservationsFor,
		evaluate(
			match: SetNotNullMatch,
			evidence: readonly EvidenceObservation[],
		): RuleEvaluation {
			const obligations = evaluationObligations(match, evidence);
			const requests = obligations.flatMap((obligation) => [
				...(obligation.dischargeableBy ?? []),
			]);
			const requestFor = (kind: string) =>
				requests.find((request) => request.kind === kind);
			const existsRequest = requestFor(COLUMN_EXISTS_OBSERVATION);
			const authorityRequest = requestFor(ALTER_AUTHORITY_OBSERVATION);
			const versionRequest = requestFor(ENGINE_VERSION_OBSERVATION);
			const exists = existsRequest
				? claimHolds(evidence, existsRequest)
				: undefined;
			if (
				existsRequest &&
				exists === true &&
				relationKind(evidence, existsRequest) === 'p'
			) {
				return {
					outcome: 'inapplicable',
					obligations: [
						partitionedTableUnsupportedObligation(match, existsRequest),
					],
					assumptions: [],
				};
			}
			const hasAlterAuthority = authorityRequest
				? claimHolds(evidence, authorityRequest)
				: undefined;
			const versionSupported = versionRequest
				? claimHolds(evidence, versionRequest)
				: undefined;
			if (
				exists === undefined ||
				hasAlterAuthority === undefined ||
				versionSupported === undefined
			) {
				return { outcome: 'blocked', obligations, assumptions: [] };
			}
			if (!exists || !hasAlterAuthority || !versionSupported) {
				return { outcome: 'inapplicable', obligations, assumptions: [] };
			}
			return { outcome: 'applicable', obligations, assumptions: [] };
		},
		generateCandidate(
			match: SetNotNullMatch,
			evaluation: ApplicableEvaluation,
		): TransitionFragment {
			const resolvedMatch = matchForOperation(match, evaluation);
			const operation = operationFor(resolvedMatch);
			const externalAssumption = externalDdlAssumption(resolvedMatch);
			const database = resolvedMatch.database;
			return {
				generatedBy: { id: SET_NOT_NULL_RULE_ID, pack: PG_RULE_PACK_ARTIFACT },
				operations: [operation],
				obligations: evaluation.obligations.map((obligation) => ({
					...obligation,
					appliesTo: operation.ref,
				})),
				assumptions: [...evaluation.assumptions, externalAssumption],
				guards: [
					{
						appliesTo: operation.ref,
						predicate: {
							kind: NO_NULLS_GUARD,
							scope: [resourceForMatch(resolvedMatch, 'column', database)],
							detail: requestDetail(resolvedMatch),
						},
						protocol: {
							kind: 'lock-and-check',
							onFailureLeaves: [],
							binding: {
								kind: 'external-ddl-exclusion',
								assumption: externalAssumption.id,
								scope: [
									resourceForMatch(resolvedMatch, 'table', database),
									resourceForMatch(resolvedMatch, 'column', database),
								],
							},
						},
						phase: 'before-operation',
					},
				],
				selectionRationale: {
					chosen: { id: SET_NOT_NULL_RULE_ID, pack: PG_RULE_PACK_ARTIFACT },
					overRules: [],
					why: 'desired column is NOT NULL and current column is nullable',
				},
			};
		},
	};
}

export { PG_OPERATION_PACK_ARTIFACT };
