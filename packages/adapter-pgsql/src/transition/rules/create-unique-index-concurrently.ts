import { defaultIndexName, indexDelta } from '@dbsp/core';
import type {
	ApplicableEvaluation,
	Assumption,
	EvidenceView,
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
import { validateIdentifier } from '../../validate.js';
import {
	ALTER_AUTHORITY_OBSERVATION,
	CREATE_UNIQUE_INDEX_CONCURRENTLY_CAPABILITY,
	CREATE_UNIQUE_INDEX_CONCURRENTLY_MIN_SERVER_VERSION_NUM,
	CREATE_UNIQUE_INDEX_CONCURRENTLY_OPERATION_KIND,
	CREATE_UNIQUE_INDEX_CONCURRENTLY_RULE_ID,
	ENGINE_VERSION_OBSERVATION,
	INDEX_ABSENT_OBSERVATION,
	NO_DUPLICATES_FOR_UNIQUE_INDEX_BUILD_GUARD,
	PG_RULE_PACK_ARTIFACT,
	TABLE_INDEXES_OBSERVATION,
} from '../constants.js';
import { assumptionId } from '../ids.js';
import {
	type IndexSet,
	invalidIndexArtefact,
} from '../operations/create-unique-index-concurrently.js';
import { stableJson } from '../stable-json.js';

export interface CreateUniqueIndexConcurrentlyMatch {
	readonly schema?: string;
	readonly database?: string;
	readonly table: string;
	readonly index: string;
	readonly columns: readonly string[];
	readonly assumptions?: readonly Assumption[];
}

type ResolvedCreateUniqueIndexConcurrentlyMatch =
	CreateUniqueIndexConcurrentlyMatch & {
		readonly schema: string;
		readonly database: string;
	};

type CreateUniqueIndexConcurrentlyApplicableEvaluation =
	ApplicableEvaluation & {
		readonly catalogIndexes: readonly IndexSet[];
	};

export interface CreateUniqueIndexConcurrentlyRuleOptions {
	readonly naming?: NamingPlugin;
}

const PARTITIONED_TABLE_UNSUPPORTED_DETAIL =
	'partitioned tables are not yet supported by the CREATE UNIQUE INDEX CONCURRENTLY transition';

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function resourceForMatch(
	match: Pick<
		CreateUniqueIndexConcurrentlyMatch,
		'schema' | 'database' | 'table' | 'index'
	>,
	kind: 'table' | 'index',
	database = match.database ?? 'model',
): ResourceAddress {
	const base: ResourceAddress = {
		engine: 'postgresql',
		database,
		kind,
		name: kind === 'table' ? match.table : match.index,
	};
	const qualified =
		kind === 'index' ? { ...base, qualifiedBy: [match.table] } : base;
	return match.schema ? { ...qualified, schema: match.schema } : qualified;
}

function columnResourceForMatch(
	match: Pick<
		CreateUniqueIndexConcurrentlyMatch,
		'schema' | 'database' | 'table'
	>,
	column: string,
	database = match.database ?? 'model',
): ResourceAddress {
	const resource: ResourceAddress = {
		engine: 'postgresql',
		database,
		kind: 'column',
		name: column,
		qualifiedBy: [match.table],
	};
	return match.schema ? { ...resource, schema: match.schema } : resource;
}

function requestDetail(match: CreateUniqueIndexConcurrentlyMatch) {
	return {
		table: match.table,
		index: match.index,
		columns: match.columns,
		schema: match.schema ?? null,
	};
}

function tableIndexesRequest(
	match: CreateUniqueIndexConcurrentlyMatch,
): ObservationRequest {
	return {
		kind: TABLE_INDEXES_OBSERVATION,
		scope: [resourceForMatch(match, 'table')],
		detail: requestDetail(match),
	};
}

function columnExistsRequest(
	match: CreateUniqueIndexConcurrentlyMatch,
	column: string,
): ObservationRequest {
	return {
		kind: 'postgresql.column.exists',
		scope: [columnResourceForMatch(match, column)],
		detail: {
			table: match.table,
			column,
			schema: match.schema ?? null,
		},
	};
}

function alterAuthorityRequest(
	match: CreateUniqueIndexConcurrentlyMatch,
): ObservationRequest {
	return {
		kind: ALTER_AUTHORITY_OBSERVATION,
		scope: [resourceForMatch(match, 'table')],
		detail: requestDetail(match),
	};
}

function engineVersionRequest(
	match: CreateUniqueIndexConcurrentlyMatch,
): ObservationRequest {
	return {
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
			minServerVersionNum:
				CREATE_UNIQUE_INDEX_CONCURRENTLY_MIN_SERVER_VERSION_NUM,
		},
	};
}

function requiredObservationsFor(
	match: CreateUniqueIndexConcurrentlyMatch,
): readonly ObservationRequest[] {
	return [
		tableIndexesRequest(match),
		...match.columns.map((column) => columnExistsRequest(match, column)),
		alterAuthorityRequest(match),
		engineVersionRequest(match),
	];
}

function obligationFor(
	request: ObservationRequest,
	appliesTo?: string,
): ProofObligation {
	const proposition =
		request.detail === undefined
			? { kind: request.kind, scope: request.scope }
			: { kind: request.kind, scope: request.scope, detail: request.detail };
	const obligation: ProofObligation = {
		proposition,
		scope: request.scope,
		dischargeableBy: [request],
	};
	return appliesTo ? { ...obligation, appliesTo } : obligation;
}

function absentObligation(
	match: CreateUniqueIndexConcurrentlyMatch,
	request: ObservationRequest,
): ProofObligation {
	const scope = [resourceForMatch(match, 'index')];
	return {
		proposition: {
			kind: INDEX_ABSENT_OBSERVATION,
			scope,
			detail: requestDetail(match),
		},
		scope,
		dischargeableBy: [request],
	};
}

function evaluationObligations(
	match: CreateUniqueIndexConcurrentlyMatch,
	evidence: EvidenceView,
): readonly ProofObligation[] {
	const requests = requiredObservationsFor(match).map((request) => {
		return evidence.normalizeRequest(request);
	});
	const indexRequest =
		requests.find((request) => request.kind === TABLE_INDEXES_OBSERVATION) ??
		tableIndexesRequest(match);
	return [
		...requests.map((request) => obligationFor(request)),
		absentObligation(match, indexRequest),
	];
}

function claimHolds(
	evidence: EvidenceView,
	target: ObservationRequest | ProofObligation,
): boolean | undefined {
	const result = evidence.claimHolds(target);
	if (result.conclusion === 'established') {
		return true;
	}
	return result.conclusion === 'refuted' ? false : undefined;
}

function relkind(
	evidence: EvidenceView,
	request: ObservationRequest,
): string | undefined {
	for (const observation of evidence.observationsFor(request)) {
		const value = observation.result.value;
		if (isRecord(value) && typeof value.relkind === 'string') {
			return value.relkind;
		}
	}
	return undefined;
}

function indexSetEntry(value: unknown): IndexSet | undefined {
	if (!isRecord(value) || typeof value.name !== 'string') {
		return undefined;
	}
	return {
		name: value.name,
		oid: typeof value.oid === 'string' ? value.oid : null,
		columns: Array.isArray(value.columns)
			? value.columns.filter((item): item is string => typeof item === 'string')
			: [],
		unique: value.unique === true,
		valid: value.valid === true,
		ready: value.ready === true,
		method: typeof value.method === 'string' ? value.method : null,
		predicate: typeof value.predicate === 'string' ? value.predicate : null,
		expressions: Array.isArray(value.expressions)
			? value.expressions.filter(
					(item): item is string => typeof item === 'string',
				)
			: [],
		include: Array.isArray(value.include)
			? value.include.filter((item): item is string => typeof item === 'string')
			: [],
		opclass: isRecord(value.opclass)
			? Object.fromEntries(
					Object.entries(value.opclass).filter(
						(entry): entry is [string, string] => typeof entry[1] === 'string',
					),
				)
			: {},
		collation: isRecord(value.collation)
			? Object.fromEntries(
					Object.entries(value.collation).filter(
						(entry): entry is [string, string] => typeof entry[1] === 'string',
					),
				)
			: {},
		options: isRecord(value.options)
			? Object.fromEntries(
					Object.entries(value.options).filter(
						(entry): entry is [string, string] => typeof entry[1] === 'string',
					),
				)
			: {},
		with: isRecord(value.with)
			? Object.fromEntries(
					Object.entries(value.with).filter(
						(entry): entry is [string, string] => typeof entry[1] === 'string',
					),
				)
			: {},
		nullsNotDistinct: value.nullsNotDistinct === true,
	};
}

function indexesFromEvidence(
	evidence: EvidenceView,
	request: ObservationRequest,
): readonly IndexSet[] | undefined {
	for (const observation of evidence.observationsFor(request)) {
		const value = observation.result.value;
		if (!isRecord(value) || !Array.isArray(value.indexes)) {
			continue;
		}
		const indexes: IndexSet[] = [];
		for (const entry of value.indexes) {
			const index = indexSetEntry(entry);
			if (!index) {
				return undefined;
			}
			indexes.push(index);
		}
		return indexes.sort((left, right) => left.name.localeCompare(right.name));
	}
	return undefined;
}

function indexHasUnsupportedShape(index: IndexSet): boolean {
	return (
		index.unique !== true ||
		index.method !== 'btree' ||
		index.predicate !== null ||
		index.expressions.length > 0 ||
		index.include.length > 0 ||
		Object.keys(index.opclass).length > 0 ||
		Object.keys(index.collation).length > 0 ||
		Object.keys(index.options).length > 0 ||
		Object.keys(index.with).length > 0 ||
		index.nullsNotDistinct === true ||
		index.columns.length === 0
	);
}

function existingValidEquivalent(
	indexes: readonly IndexSet[],
	match: CreateUniqueIndexConcurrentlyMatch,
): boolean {
	return indexes.some(
		(index) =>
			index.name !== match.index &&
			index.valid &&
			index.ready &&
			!indexHasUnsupportedShape(index) &&
			stableJson(index.columns) === stableJson(match.columns),
	);
}

function targetConflict(
	indexes: readonly IndexSet[],
	match: CreateUniqueIndexConcurrentlyMatch,
): boolean {
	return indexes.some((index) => index.name === match.index);
}

function operationRef(match: CreateUniqueIndexConcurrentlyMatch): string {
	return `postgresql:create-unique-index-concurrently:${JSON.stringify([
		match.schema ?? null,
		match.table,
		match.index,
	])}`;
}

function operationFor(
	match: ResolvedCreateUniqueIndexConcurrentlyMatch,
): PhysicalOperation {
	return {
		ref: operationRef(match),
		operationKind: CREATE_UNIQUE_INDEX_CONCURRENTLY_OPERATION_KIND,
		payload: {
			schema: match.schema,
			table: match.table,
			index: match.index,
			columns: match.columns,
		} as unknown as JsonValue,
	};
}

function externalDdlAssumption(
	match: ResolvedCreateUniqueIndexConcurrentlyMatch,
): Assumption {
	return {
		id: assumptionId(
			`dbsp.postgresql.external-ddl-exclusion:${JSON.stringify([
				match.database,
				match.schema,
				match.table,
				match.index,
			])}`,
		),
		class: 'external-ddl-exclusion',
		asserter: { kind: 'pack', artifact: PG_RULE_PACK_ARTIFACT },
		statement:
			'No concurrent DDL renames, replaces, adds, drops, or changes the target table, columns, or indexes while CREATE UNIQUE INDEX CONCURRENTLY is planned and executed.',
		scope: [
			resourceForMatch(match, 'table', match.database),
			resourceForMatch(match, 'index', match.database),
			...match.columns.map((column) =>
				columnResourceForMatch(match, column, match.database),
			),
		],
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
	match: CreateUniqueIndexConcurrentlyMatch,
	evaluation: ApplicableEvaluation,
): ResolvedCreateUniqueIndexConcurrentlyMatch {
	const schema = match.schema ?? schemaFromEvaluation(evaluation);
	if (!schema) {
		throw new Error(
			'create-unique-index-concurrently requires an explicit target schema',
		);
	}
	const database = match.database ?? databaseFromEvaluation(evaluation);
	if (!database) {
		throw new Error(
			'create-unique-index-concurrently requires a live database identity',
		);
	}
	return { ...match, schema, database };
}

function unsupportedRecognition(
	match: CreateUniqueIndexConcurrentlyMatch,
	detail: string,
): RecognitionResult<CreateUniqueIndexConcurrentlyMatch> {
	return {
		recognized: 'unsupported',
		changes: [resourceForMatch(match, 'index')],
		detail,
	};
}

export function createCreateUniqueIndexConcurrentlyRule(
	options: CreateUniqueIndexConcurrentlyRuleOptions = {},
): TransitionRule<CreateUniqueIndexConcurrentlyMatch> {
	const naming = options.naming ?? identityNaming;
	return {
		id: CREATE_UNIQUE_INDEX_CONCURRENTLY_RULE_ID,
		artifact: PG_RULE_PACK_ARTIFACT,
		support: {
			engine: 'postgresql',
			versions: [{ min: '12' }],
			requiredCapabilities: [CREATE_UNIQUE_INDEX_CONCURRENTLY_CAPABILITY],
		},
		recognize(
			desired: ModelIR,
			current: ModelIR,
			context?: RecognitionContext,
		): RecognitionResult<CreateUniqueIndexConcurrentlyMatch> {
			for (const desiredTable of desired.tables.values()) {
				const currentTable = current.getTable(desiredTable.name);
				if (!currentTable) {
					continue;
				}
				const delta = indexDelta(
					desiredTable.name,
					desiredTable.indexes,
					currentTable.indexes,
				);
				if (delta.kind === 'none') {
					continue;
				}
				const table = naming.toDatabase(desiredTable.name);
				const schema = context?.context.targetSchema;
				const baseMatch = { table, ...(schema ? { schema } : {}) };
				if (delta.kind === 'unsupported') {
					return unsupportedRecognition(
						{
							...baseMatch,
							index: 'unsupported-index',
							columns: [],
						},
						'index transition shape is outside the CREATE UNIQUE INDEX CONCURRENTLY first slice',
					);
				}
				const columns = delta.index.columns.map((column) =>
					naming.toDatabase(column),
				);
				const missingColumn = delta.index.columns.find(
					(column) =>
						!desiredTable.columns.some(
							(candidate) => candidate.name === column,
						) ||
						!currentTable.columns.some(
							(candidate) => candidate.name === column,
						),
				);
				const index = naming.toDatabase(
					delta.index.name ??
						defaultIndexName(desiredTable.name, {
							columns: delta.index.columns,
						}),
				);
				const match: CreateUniqueIndexConcurrentlyMatch = {
					...baseMatch,
					index,
					columns,
				};
				if (missingColumn) {
					return unsupportedRecognition(
						match,
						'target index references a column that is not present on both sides of the comparison',
					);
				}
				validateIdentifier(table, 'table');
				validateIdentifier(index, 'alias');
				for (const column of columns) {
					validateIdentifier(column, 'column');
				}
				return {
					recognized: true,
					match,
				};
			}
			return { recognized: false };
		},
		requiredObservations: requiredObservationsFor,
		evaluate(
			match: CreateUniqueIndexConcurrentlyMatch,
			evidence: EvidenceView,
		): RuleEvaluation {
			const obligations = evaluationObligations(match, evidence);
			const requests = obligations.flatMap((obligation) => [
				...(obligation.dischargeableBy ?? []),
			]);
			const requestsForKind = (kind: string) =>
				requests.filter((request) => request.kind === kind);
			const obligationForKind = (kind: string) =>
				obligations.find((obligation) => obligation.proposition.kind === kind);
			const indexRequest = requestsForKind(TABLE_INDEXES_OBSERVATION)[0];
			const authorityRequest = requestsForKind(ALTER_AUTHORITY_OBSERVATION)[0];
			const versionRequest = requestsForKind(ENGINE_VERSION_OBSERVATION)[0];
			const columnRequests = requestsForKind('postgresql.column.exists');
			const absentIndexObligation = obligationForKind(INDEX_ABSENT_OBSERVATION);
			const tableExists = indexRequest
				? claimHolds(evidence, indexRequest)
				: undefined;
			const targetAbsent = absentIndexObligation
				? claimHolds(evidence, absentIndexObligation)
				: undefined;
			const hasAlterAuthority = authorityRequest
				? claimHolds(evidence, authorityRequest)
				: undefined;
			const versionSupported = versionRequest
				? claimHolds(evidence, versionRequest)
				: undefined;
			const columnsExist = columnRequests.map((request) =>
				claimHolds(evidence, request),
			);
			const indexes = indexRequest
				? indexesFromEvidence(evidence, indexRequest)
				: undefined;
			if (
				tableExists === undefined ||
				targetAbsent === undefined ||
				hasAlterAuthority === undefined ||
				versionSupported === undefined ||
				columnsExist.some((value) => value === undefined) ||
				!indexes
			) {
				return { outcome: 'blocked', obligations, assumptions: [] };
			}
			if (
				indexRequest &&
				tableExists &&
				relkind(evidence, indexRequest) !== 'r'
			) {
				return {
					outcome: 'inapplicable',
					obligations: [
						{
							proposition: {
								kind: TABLE_INDEXES_OBSERVATION,
								scope: indexRequest.scope,
								detail: PARTITIONED_TABLE_UNSUPPORTED_DETAIL,
							},
							scope: indexRequest.scope,
							dischargeableBy: [indexRequest],
						},
					],
					assumptions: [],
				};
			}
			if (
				!tableExists ||
				!targetAbsent ||
				!hasAlterAuthority ||
				!versionSupported ||
				columnsExist.some((value) => value !== true) ||
				existingValidEquivalent(indexes, match) ||
				targetConflict(indexes, match)
			) {
				return { outcome: 'inapplicable', obligations, assumptions: [] };
			}
			const applicable: CreateUniqueIndexConcurrentlyApplicableEvaluation = {
				outcome: 'applicable',
				obligations,
				assumptions: match.assumptions ?? [],
				catalogIndexes: indexes,
			};
			return applicable;
		},
		generateCandidate(
			match: CreateUniqueIndexConcurrentlyMatch,
			evaluation: ApplicableEvaluation,
		): TransitionFragment {
			const resolvedMatch = matchForOperation(match, evaluation);
			const operation = operationFor(resolvedMatch);
			const externalAssumption = externalDdlAssumption(resolvedMatch);
			const table = resourceForMatch(
				resolvedMatch,
				'table',
				resolvedMatch.database,
			);
			const index = resourceForMatch(
				resolvedMatch,
				'index',
				resolvedMatch.database,
			);
			const guardArtefact = invalidIndexArtefact(
				{
					schema: resolvedMatch.schema,
					table: resolvedMatch.table,
					index: resolvedMatch.index,
					columns: resolvedMatch.columns,
				},
				{
					engine: 'postgresql',
					engineVersion: '',
					databaseId: resolvedMatch.database,
					capabilities: [],
					privileges: [],
					sessionConfiguration: {},
					extensions: {},
				},
			);
			return {
				generatedBy: {
					id: CREATE_UNIQUE_INDEX_CONCURRENTLY_RULE_ID,
					pack: PG_RULE_PACK_ARTIFACT,
				},
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
							kind: NO_DUPLICATES_FOR_UNIQUE_INDEX_BUILD_GUARD,
							target: index,
							scope: [index],
							detail: {
								schema: resolvedMatch.schema,
								table: resolvedMatch.table,
								index: resolvedMatch.index,
								columns: resolvedMatch.columns,
							},
						},
						protocol: {
							kind: 'engine-validated',
							onFailureLeaves: [guardArtefact],
							binding: {
								kind: 'external-ddl-exclusion',
								assumption: externalAssumption.id,
								scope: [
									table,
									index,
									...resolvedMatch.columns.map((column) =>
										columnResourceForMatch(
											resolvedMatch,
											column,
											resolvedMatch.database,
										),
									),
								],
							},
						},
						phase: 'during-operation',
					},
				],
				selectionRationale: {
					chosen: {
						id: CREATE_UNIQUE_INDEX_CONCURRENTLY_RULE_ID,
						pack: PG_RULE_PACK_ARTIFACT,
					},
					overRules: [],
					why: 'desired table adds one plain UNIQUE btree index supported by PostgreSQL CREATE INDEX CONCURRENTLY',
				},
			};
		},
	};
}
