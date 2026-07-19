import type {
	ApplicableEvaluation,
	Assumption,
	ColumnIR,
	EvidenceView,
	JsonValue,
	LogicalIdentity,
	ModelIR,
	ObservationRequest,
	PhysicalOperation,
	ProofClaimDraft,
	ProofObligation,
	RecognitionContext,
	RecognitionResult,
	ResourceAddress,
	RuleEvaluation,
	TableIR,
	TransitionFragment,
	TransitionRule,
	TrustRoot,
} from '@dbsp/types';
import type { NamingPlugin } from '../../naming-plugin.js';
import { identityNaming } from '../../naming-plugin.js';
import {
	ATTACH_LOGICAL_IDENTITY_OPERATION_KIND,
	LOGICAL_IDENTITY_ADOPTION_RULE_ID,
	LOGICAL_IDENTITY_CARRIER_OBSERVATION,
	PG_RULE_PACK_ARTIFACT,
} from '../constants.js';
import { assumptionId } from '../ids.js';
import { stableJson } from '../stable-json.js';

export type IdentityAdoptionAsserter = Exclude<
	TrustRoot,
	{ readonly kind: 'pack' }
>;

export interface LogicalIdentityAdoptionMatch {
	readonly schema?: string;
	readonly database?: string;
	readonly table: string;
	readonly column?: string;
	readonly logicalId: string;
	readonly carrierKind: 'postgresql-side-table';
	readonly authenticated: false;
	readonly selectionBasis: string;
}

type ResolvedLogicalIdentityAdoptionMatch = LogicalIdentityAdoptionMatch & {
	readonly schema: string;
	readonly database: string;
};

export interface LogicalIdentityAdoptionRuleOptions {
	readonly naming?: NamingPlugin;
	readonly asserter?: IdentityAdoptionAsserter;
	readonly selectionBasis?: string;
}

const DEFAULT_ASSERTER: IdentityAdoptionAsserter = {
	kind: 'policy',
	policyId: 'dbsp.logical-identity-adoption',
};

const DEFAULT_SELECTION_BASIS =
	'operator selected an existing physical object with the same table/column name during baseline identity adoption';

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function resourceForMatch(
	match: Pick<
		LogicalIdentityAdoptionMatch,
		'schema' | 'database' | 'table' | 'column'
	>,
	database = match.database ?? 'model',
): ResourceAddress {
	const table: ResourceAddress = {
		engine: 'postgresql',
		database,
		kind: 'table',
		name: match.table,
		...(match.schema ? { schema: match.schema } : {}),
	};
	return match.column
		? {
				...table,
				kind: 'column',
				name: match.column,
				qualifiedBy: [match.table],
			}
		: table;
}

function carrierSupported(identity: LogicalIdentity): boolean {
	const carrier = (
		identity as { readonly carrier?: LogicalIdentity['carrier'] }
	).carrier;
	if (!carrier) {
		return false;
	}
	return (
		carrier.kind === 'postgresql-side-table' && carrier.authenticated === false
	);
}

function withoutTableLogicalIdentity(table: TableIR): TableIR {
	const { logicalIdentity: _logicalIdentity, ...rest } = table;
	return rest;
}

function withoutColumnLogicalIdentity(column: ColumnIR): ColumnIR {
	const { logicalIdentity: _logicalIdentity, ...rest } = column;
	return rest;
}

function sameExceptTableLogicalIdentity(
	desired: TableIR,
	current: TableIR,
): boolean {
	return (
		stableJson(withoutTableLogicalIdentity(desired)) ===
		stableJson(withoutTableLogicalIdentity(current))
	);
}

function sameExceptColumnLogicalIdentity(
	desired: ColumnIR,
	current: ColumnIR,
): boolean {
	return (
		stableJson(withoutColumnLogicalIdentity(desired)) ===
		stableJson(withoutColumnLogicalIdentity(current))
	);
}

function hasUnadoptedTableLogicalIdentityChange(
	desiredTable: TableIR,
	currentTable: TableIR,
): boolean {
	return (
		stableJson(desiredTable.logicalIdentity ?? null) !==
		stableJson(currentTable.logicalIdentity ?? null)
	);
}

function requestDetail(match: LogicalIdentityAdoptionMatch) {
	return {
		table: match.table,
		column: match.column ?? null,
		schema: match.schema ?? null,
		logicalId: match.logicalId,
		carrierKind: match.carrierKind,
		authenticated: match.authenticated,
		expected: 'adoptable',
	};
}

function carrierStateRequest(
	match: LogicalIdentityAdoptionMatch,
): ObservationRequest {
	return {
		kind: LOGICAL_IDENTITY_CARRIER_OBSERVATION,
		scope: [resourceForMatch(match)],
		detail: requestDetail(match),
	};
}

function requiredObservationsFor(
	match: LogicalIdentityAdoptionMatch,
): readonly ObservationRequest[] {
	return [carrierStateRequest(match)];
}

function obligationFor(request: ObservationRequest): ProofObligation {
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
	return {
		proposition,
		scope: request.scope,
		dischargeableBy: [request],
	};
}

function evaluationObligations(
	match: LogicalIdentityAdoptionMatch,
	evidence: EvidenceView,
): readonly ProofObligation[] {
	return requiredObservationsFor(match).map((request) => {
		return obligationFor(evidence.normalizeRequest(request));
	});
}

function claimHolds(
	evidence: EvidenceView,
	request: ObservationRequest,
): boolean | undefined {
	const result = evidence.claimHolds(request);
	if (result.conclusion === 'established') {
		return true;
	}
	return result.conclusion === 'refuted' ? false : undefined;
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
	match: LogicalIdentityAdoptionMatch,
	evaluation: ApplicableEvaluation,
): ResolvedLogicalIdentityAdoptionMatch {
	const schema = match.schema ?? schemaFromEvaluation(evaluation);
	if (!schema) {
		throw new Error(
			'logical identity adoption requires an explicit target schema',
		);
	}
	const database = match.database ?? databaseFromEvaluation(evaluation);
	if (!database) {
		throw new Error(
			'logical identity adoption requires a live database identity',
		);
	}
	return { ...match, schema, database };
}

function operationRef(match: LogicalIdentityAdoptionMatch): string {
	return `postgresql:logical-identity-adopt:${JSON.stringify([
		match.schema ?? null,
		match.table,
		match.column ?? null,
		match.logicalId,
	])}`;
}

function operationFor(
	match: ResolvedLogicalIdentityAdoptionMatch,
): PhysicalOperation {
	const payload = {
		schema: match.schema,
		table: match.table,
		...(match.column ? { column: match.column } : {}),
		logicalId: match.logicalId,
		carrierKind: match.carrierKind,
		authenticated: match.authenticated,
	};
	return {
		ref: operationRef(match),
		operationKind: ATTACH_LOGICAL_IDENTITY_OPERATION_KIND,
		payload: payload as unknown as JsonValue,
	};
}

function baselineIdentityAssumption(
	match: ResolvedLogicalIdentityAdoptionMatch,
	asserter: IdentityAdoptionAsserter,
): Assumption {
	const target = resourceForMatch(match, match.database);
	return {
		id: assumptionId(
			`dbsp.baseline-identity-attachment:${JSON.stringify([
				match.database,
				match.schema,
				match.table,
				match.column ?? null,
				match.logicalId,
			])}`,
		),
		class: 'baseline-identity-attachment',
		asserter,
		statement:
			`Logical id ${JSON.stringify(match.logicalId)} truly belongs to ` +
			`${match.schema}.${match.table}${
				match.column ? `.${match.column}` : ''
			} via carrier ${match.carrierKind} ` +
			`(authenticated:${match.authenticated}); selection basis: ${match.selectionBasis}.`,
		scope: [target],
	};
}

function identityClaimDraft(
	match: ResolvedLogicalIdentityAdoptionMatch,
	assumption: Assumption,
): ProofClaimDraft<'established-under-assumptions'> {
	const scope = [resourceForMatch(match, match.database)];
	return {
		proposition: {
			kind: 'dbsp.logical-identity.attached',
			scope,
			detail: {
				logicalId: match.logicalId,
				carrierKind: match.carrierKind,
				authenticated: match.authenticated,
				table: match.table,
				column: match.column ?? null,
				schema: match.schema,
			},
		},
		scope,
		assumes: [assumption.id],
		semantics: PG_RULE_PACK_ARTIFACT,
		conclusion: 'established-under-assumptions',
	};
}

function recognitionForTable(
	desiredTable: TableIR,
	currentTable: TableIR,
	naming: NamingPlugin,
	selectionBasis: string,
): LogicalIdentityAdoptionMatch | undefined {
	const identity = desiredTable.logicalIdentity;
	if (
		!identity ||
		currentTable.logicalIdentity ||
		!carrierSupported(identity)
	) {
		return undefined;
	}
	if (!sameExceptTableLogicalIdentity(desiredTable, currentTable)) {
		return undefined;
	}
	return {
		table: naming.toDatabase(desiredTable.name),
		logicalId: identity.id,
		carrierKind: 'postgresql-side-table',
		authenticated: false,
		selectionBasis,
	};
}

function recognitionForColumn(
	desiredTable: TableIR,
	currentTable: TableIR,
	desiredColumn: ColumnIR,
	currentColumn: ColumnIR,
	naming: NamingPlugin,
	selectionBasis: string,
): LogicalIdentityAdoptionMatch | undefined {
	const identity = desiredColumn.logicalIdentity;
	if (
		!identity ||
		currentColumn.logicalIdentity ||
		!carrierSupported(identity) ||
		hasUnadoptedTableLogicalIdentityChange(desiredTable, currentTable)
	) {
		return undefined;
	}
	if (!sameExceptColumnLogicalIdentity(desiredColumn, currentColumn)) {
		return undefined;
	}
	return {
		table: naming.toDatabase(desiredTable.name),
		column: naming.toDatabase(desiredColumn.name),
		logicalId: identity.id,
		carrierKind: 'postgresql-side-table',
		authenticated: false,
		selectionBasis,
	};
}

export function createLogicalIdentityAdoptionRule(
	options: LogicalIdentityAdoptionRuleOptions = {},
): TransitionRule<LogicalIdentityAdoptionMatch> {
	const naming = options.naming ?? identityNaming;
	const asserter = options.asserter ?? DEFAULT_ASSERTER;
	const selectionBasis = options.selectionBasis ?? DEFAULT_SELECTION_BASIS;
	return {
		id: LOGICAL_IDENTITY_ADOPTION_RULE_ID,
		artifact: PG_RULE_PACK_ARTIFACT,
		support: {
			engine: 'postgresql',
			versions: [],
			requiredCapabilities: [],
		},
		consumesColumnFields: ['logicalIdentity'],
		recognize(
			desired: ModelIR,
			current: ModelIR,
			_context?: RecognitionContext,
		): RecognitionResult<LogicalIdentityAdoptionMatch> {
			for (const desiredTable of desired.tables.values()) {
				const currentTable = current.getTable(desiredTable.name);
				if (!currentTable) {
					continue;
				}
				const tableMatch = recognitionForTable(
					desiredTable,
					currentTable,
					naming,
					selectionBasis,
				);
				if (tableMatch) {
					return { recognized: true, match: tableMatch };
				}
				for (const desiredColumn of desiredTable.columns) {
					const currentColumn = currentTable.columns.find(
						(column) => column.name === desiredColumn.name,
					);
					if (!currentColumn) {
						continue;
					}
					const columnMatch = recognitionForColumn(
						desiredTable,
						currentTable,
						desiredColumn,
						currentColumn,
						naming,
						selectionBasis,
					);
					if (columnMatch) {
						return { recognized: true, match: columnMatch };
					}
				}
			}
			return { recognized: false };
		},
		requiredObservations: requiredObservationsFor,
		evaluate(
			match: LogicalIdentityAdoptionMatch,
			evidence: EvidenceView,
		): RuleEvaluation {
			const obligations = evaluationObligations(match, evidence);
			const request = obligations.flatMap((obligation) => [
				...(obligation.dischargeableBy ?? []),
			])[0];
			const adoptable = request ? claimHolds(evidence, request) : undefined;
			if (adoptable === undefined) {
				return { outcome: 'blocked', obligations, assumptions: [] };
			}
			if (!adoptable) {
				return { outcome: 'inapplicable', obligations, assumptions: [] };
			}
			return { outcome: 'applicable', obligations, assumptions: [] };
		},
		generateCandidate(
			match: LogicalIdentityAdoptionMatch,
			evaluation: ApplicableEvaluation,
		): TransitionFragment {
			const resolvedMatch = matchForOperation(match, evaluation);
			const operation = operationFor(resolvedMatch);
			const baseline = baselineIdentityAssumption(resolvedMatch, asserter);
			return {
				generatedBy: {
					id: LOGICAL_IDENTITY_ADOPTION_RULE_ID,
					pack: PG_RULE_PACK_ARTIFACT,
				},
				operations: [operation],
				obligations: evaluation.obligations.map((obligation) => ({
					...obligation,
					appliesTo: operation.ref,
				})),
				claimDrafts: [identityClaimDraft(resolvedMatch, baseline)],
				assumptions: [baseline],
				guards: [],
				selectionRationale: {
					chosen: {
						id: LOGICAL_IDENTITY_ADOPTION_RULE_ID,
						pack: PG_RULE_PACK_ARTIFACT,
					},
					overRules: [],
					why: 'desired object carries a logical identity and the same physical current object has no carrier binding',
				},
			};
		},
	};
}
