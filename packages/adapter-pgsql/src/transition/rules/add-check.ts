import { checkDelta } from '@dbsp/core';
import type {
	ApplicableEvaluation,
	Assumption,
	EvidenceView,
	JsonValue,
	ModelIR,
	ObservationContext,
	ObservationRequest,
	PhysicalOperation,
	ProofClaimDraft,
	ProofObligation,
	RecognitionContext,
	RecognitionResult,
	RequiredEnumLabelIR,
	ResourceAddress,
	RuleEvaluation,
	TransitionFragment,
	TransitionFragmentComposition,
	TransitionRule,
	VendorValidatedExpression,
} from '@dbsp/types';
import type { NamingPlugin } from '../../naming-plugin.js';
import { identityNaming } from '../../naming-plugin.js';
import { validateIdentifier } from '../../validate.js';
import { pgEnumLabelVisibleFact } from '../composition-facts.js';
import {
	ADD_CHECK_RULE_ID,
	ALTER_AUTHORITY_OBSERVATION,
	ALTER_TABLE_ADD_CHECK_CAPABILITY,
	ALTER_TABLE_ADD_CHECK_MIN_SERVER_VERSION_NUM,
	ALTER_TABLE_ADD_CHECK_OPERATION_KIND,
	CHECK_CONSTRAINT_ABSENT_OBSERVATION,
	CHECK_ROWS_SATISFY_GUARD,
	ENGINE_VERSION_OBSERVATION,
	EXPRESSION_DEPARSE_OBSERVATION,
	PG_RULE_PACK_ARTIFACT,
	TABLE_CHECK_CONSTRAINTS_OBSERVATION,
} from '../constants.js';
import { tableCheckDeparseEvidenceFor } from '../deparse-evidence.js';
import { assumptionId } from '../ids.js';
import type { CheckSet } from '../operations/alter-table-add-check.js';

export interface AddCheckMatch {
	readonly schema?: string;
	readonly database?: string;
	readonly table: string;
	readonly constraint: string;
	readonly expression: string;
	readonly requiresEnumLabels?: readonly RequiredEnumLabelIR[];
	readonly assumptions?: readonly Assumption[];
}

type ResolvedAddCheckMatch = AddCheckMatch & {
	readonly schema: string;
	readonly database: string;
};

type AddCheckApplicableEvaluation = ApplicableEvaluation & {
	readonly catalogChecks: readonly CheckSet[];
	readonly expression: VendorValidatedExpression;
	readonly predicate: VendorValidatedExpression;
};

export interface AddCheckRuleOptions {
	readonly naming?: NamingPlugin;
}

const PARTITIONED_TABLE_UNSUPPORTED_DETAIL =
	'partitioned tables are not yet supported by the ADD CHECK transition';

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function resourceForMatch(
	match: Pick<AddCheckMatch, 'schema' | 'database' | 'table' | 'constraint'>,
	kind: 'table' | 'check-constraint',
	database = match.database ?? 'model',
): ResourceAddress {
	const base: ResourceAddress = {
		engine: 'postgresql',
		database,
		kind,
		name: kind === 'table' ? match.table : match.constraint,
	};
	const qualified =
		kind === 'check-constraint'
			? { ...base, qualifiedBy: [match.table] }
			: base;
	return match.schema ? { ...qualified, schema: match.schema } : qualified;
}

function requestDetail(match: AddCheckMatch) {
	return {
		table: match.table,
		constraint: match.constraint,
		schema: match.schema ?? null,
	};
}

function tableChecksRequest(match: AddCheckMatch): ObservationRequest {
	return {
		kind: TABLE_CHECK_CONSTRAINTS_OBSERVATION,
		scope: [resourceForMatch(match, 'table')],
		detail: requestDetail(match),
	};
}

function alterAuthorityRequest(match: AddCheckMatch): ObservationRequest {
	return {
		kind: ALTER_AUTHORITY_OBSERVATION,
		scope: [resourceForMatch(match, 'table')],
		detail: requestDetail(match),
	};
}

function deparseRequest(match: AddCheckMatch): ObservationRequest {
	return {
		kind: EXPRESSION_DEPARSE_OBSERVATION,
		scope: [resourceForMatch(match, 'table')],
		detail: {
			surface: 'table-check',
			category: 'predicate',
			table: match.table,
			constraint: match.constraint,
			schema: match.schema ?? null,
			expression: match.expression,
		},
	};
}

function engineVersionRequest(match: AddCheckMatch): ObservationRequest {
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
			minServerVersionNum: ALTER_TABLE_ADD_CHECK_MIN_SERVER_VERSION_NUM,
		},
	};
}

function requiredObservationsFor(
	match: AddCheckMatch,
): readonly ObservationRequest[] {
	return [
		tableChecksRequest(match),
		alterAuthorityRequest(match),
		engineVersionRequest(match),
		deparseRequest(match),
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

function absentObligation(
	match: AddCheckMatch,
	request: ObservationRequest,
): ProofObligation {
	const scope = [resourceForMatch(match, 'check-constraint')];
	return {
		proposition: {
			kind: CHECK_CONSTRAINT_ABSENT_OBSERVATION,
			scope,
			detail: requestDetail(match),
		},
		scope,
		dischargeableBy: [request],
	};
}

function evaluationObligations(
	match: AddCheckMatch,
	evidence: EvidenceView,
): readonly ProofObligation[] {
	const requests = requiredObservationsFor(match).map((request) => {
		return evidence.normalizeRequest(request);
	});
	const tableRequest =
		requests.find(
			(request) => request.kind === TABLE_CHECK_CONSTRAINTS_OBSERVATION,
		) ?? tableChecksRequest(match);
	return [
		...requests.map((request) => obligationFor(request)),
		absentObligation(match, tableRequest),
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

function checksFromEvidence(
	evidence: EvidenceView,
	request: ObservationRequest,
): readonly CheckSet[] | undefined {
	for (const observation of evidence.observationsFor(request)) {
		const value = observation.result.value;
		if (!isRecord(value) || !Array.isArray(value.checks)) {
			continue;
		}
		const checks: CheckSet[] = [];
		for (const entry of value.checks) {
			if (!isRecord(entry)) {
				return undefined;
			}
			const predicate =
				typeof entry.predicate === 'string'
					? entry.predicate
					: typeof entry.predicateExpression === 'string'
						? entry.predicateExpression
						: undefined;
			if (
				typeof entry.name !== 'string' ||
				!(entry.oid === null || typeof entry.oid === 'string') ||
				typeof entry.expression !== 'string' ||
				typeof predicate !== 'string' ||
				typeof entry.notValid !== 'boolean'
			) {
				return undefined;
			}
			if (
				entry.notValid ||
				/\bNOT\s+VALID\b/iu.test(entry.expression) ||
				/\bNO\s+INHERIT\b/iu.test(entry.expression)
			) {
				return undefined;
			}
			checks.push({
				name: entry.name,
				oid: entry.oid,
				expression: entry.expression,
				predicate,
				notValid: entry.notValid,
			});
		}
		return checks.sort((left, right) => left.name.localeCompare(right.name));
	}
	return undefined;
}

function operationRef(match: AddCheckMatch): string {
	return `postgresql:add-check:${JSON.stringify([
		match.schema ?? null,
		match.table,
		match.constraint,
	])}`;
}

function enumLabelCompositionFact(
	match: AddCheckMatch,
	required: RequiredEnumLabelIR,
	naming: NamingPlugin,
	context?: ObservationContext,
	database = match.database ?? 'model',
) {
	const schema = required.schema ?? match.schema ?? context?.targetSchema;
	if (!schema) {
		throw new Error(
			'add-check enum-label composition requires an explicit enum schema',
		);
	}
	const type = naming.toDatabase(required.type);
	return pgEnumLabelVisibleFact({
		database,
		schema,
		type,
		label: required.label,
	});
}

function compositionForRequiredEnumLabels(
	match: AddCheckMatch,
	naming: NamingPlugin,
	context?: ObservationContext,
): TransitionFragmentComposition | undefined {
	if (!match.requiresEnumLabels || match.requiresEnumLabels.length === 0) {
		return undefined;
	}
	const opRef = operationRef(match);
	return {
		requires: match.requiresEnumLabels.map((required) => ({
			opRef,
			fact: enumLabelCompositionFact(match, required, naming, context),
			needs: 'producer-after-commit',
		})),
	};
}

function operationFor(
	match: ResolvedAddCheckMatch,
	evaluation: AddCheckApplicableEvaluation,
): PhysicalOperation {
	const target: CheckSet = {
		name: match.constraint,
		oid: null,
		expression: evaluation.expression.text,
		predicate: evaluation.predicate.text,
		notValid: false,
	};
	const expectedAfter = [...evaluation.catalogChecks, target].sort(
		(left, right) => left.name.localeCompare(right.name),
	);
	return {
		ref: operationRef(match),
		operationKind: ALTER_TABLE_ADD_CHECK_OPERATION_KIND,
		payload: {
			schema: match.schema,
			table: match.table,
			constraint: match.constraint,
			expression: evaluation.expression,
			predicate: evaluation.predicate,
			expectedBefore: evaluation.catalogChecks,
			expectedAfter,
		} as unknown as JsonValue,
	};
}

function externalDdlAssumption(match: ResolvedAddCheckMatch): Assumption {
	return {
		id: assumptionId(
			`dbsp.postgresql.external-ddl-exclusion:${JSON.stringify([
				match.database,
				match.schema,
				match.table,
				match.constraint,
			])}`,
		),
		class: 'external-ddl-exclusion',
		asserter: { kind: 'pack', artifact: PG_RULE_PACK_ARTIFACT },
		statement:
			'No concurrent DDL renames, replaces, adds, drops, or changes the table CHECK constraint while the add-check lock is acquired and checked.',
		scope: [
			resourceForMatch(match, 'table', match.database),
			resourceForMatch(match, 'check-constraint', match.database),
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
	match: AddCheckMatch,
	evaluation: ApplicableEvaluation,
): ResolvedAddCheckMatch {
	const schema = match.schema ?? schemaFromEvaluation(evaluation);
	if (!schema) {
		throw new Error('add-check requires an explicit target schema');
	}
	const database = match.database ?? databaseFromEvaluation(evaluation);
	if (!database) {
		throw new Error('add-check requires a live database identity');
	}
	return { ...match, schema, database };
}

function noDriftClaim(match: AddCheckMatch): ProofClaimDraft<'established'> {
	return {
		proposition: {
			kind: 'dbsp.model.no-drift',
			scope: [
				resourceForMatch(match, 'table'),
				resourceForMatch(match, 'check-constraint'),
			],
			detail: requestDetail(match),
		},
		scope: [
			resourceForMatch(match, 'table'),
			resourceForMatch(match, 'check-constraint'),
		],
		semantics: PG_RULE_PACK_ARTIFACT,
		conclusion: 'established',
	};
}

function unsupportedRecognition(
	match: AddCheckMatch,
	detail: string,
): RecognitionResult<AddCheckMatch> {
	return {
		recognized: 'unsupported',
		changes: [resourceForMatch(match, 'check-constraint')],
		detail,
	};
}

export function createAddCheckRule(
	options: AddCheckRuleOptions = {},
): TransitionRule<AddCheckMatch> {
	const naming = options.naming ?? identityNaming;
	return {
		id: ADD_CHECK_RULE_ID,
		artifact: PG_RULE_PACK_ARTIFACT,
		support: {
			engine: 'postgresql',
			versions: [{ min: '18' }],
			requiredCapabilities: [ALTER_TABLE_ADD_CHECK_CAPABILITY],
		},
		recognize(
			desired: ModelIR,
			current: ModelIR,
			context?: RecognitionContext,
		): RecognitionResult<AddCheckMatch> {
			for (const desiredTable of desired.tables.values()) {
				const currentTable = current.getTable(desiredTable.name);
				if (!currentTable) {
					continue;
				}
				const delta = checkDelta(
					desiredTable.checkConstraints,
					currentTable.checkConstraints,
				);
				if (delta.kind === 'none' || delta.kind === 'unsupported') {
					continue;
				}
				const table = naming.toDatabase(desiredTable.name);
				const schema = context?.context.targetSchema;
				const baseMatch = {
					table,
					...(schema ? { schema } : {}),
				};
				if (delta.kind === 'add-check') {
					const constraint = naming.toDatabase(delta.check.name);
					const desiredCheck = desiredTable.checkConstraints?.find(
						(candidate) => candidate.name === delta.check.name,
					);
					validateIdentifier(table, 'table');
					validateIdentifier(constraint, 'alias');
					return {
						recognized: true,
						match: {
							...baseMatch,
							constraint,
							expression: delta.check.expression,
							...(desiredCheck?.requiresEnumLabels
								? {
										requiresEnumLabels: desiredCheck.requiresEnumLabels,
									}
								: {}),
						},
					};
				}

				const constraint = naming.toDatabase(delta.desired.name);
				const desiredCheck = desiredTable.checkConstraints?.find(
					(candidate) => candidate.name === delta.desired.name,
				);
				const match: AddCheckMatch = {
					...baseMatch,
					constraint,
					expression: delta.desired.expression,
					...(desiredCheck?.requiresEnumLabels
						? {
								requiresEnumLabels: desiredCheck.requiresEnumLabels,
							}
						: {}),
				};
				const request = deparseRequest(match);
				const observed = context?.evidence
					? tableCheckDeparseEvidenceFor({
							evidence: context.evidence,
							request,
						})
					: { kind: 'missing' as const };
				if (observed.kind !== 'found') {
					return {
						recognized: 'unknown',
						obligations: [obligationFor(request, 'table-check')],
					};
				}
				if (observed.evidence.equivalentToCatalog === true) {
					return { recognized: 'no-drift', claimDraft: noDriftClaim(match) };
				}
				return unsupportedRecognition(
					match,
					'observed CHECK expressions with the same name are not PostgreSQL-deparse equivalent',
				);
			}
			return { recognized: false };
		},
		requiredObservations: requiredObservationsFor,
		declareComposition(
			match: AddCheckMatch,
			context: ObservationContext,
		): TransitionFragmentComposition | undefined {
			return compositionForRequiredEnumLabels(match, naming, context);
		},
		evaluate(match: AddCheckMatch, evidence: EvidenceView): RuleEvaluation {
			const obligations = evaluationObligations(match, evidence);
			const requests = obligations.flatMap((obligation) => [
				...(obligation.dischargeableBy ?? []),
			]);
			const requestFor = (kind: string) =>
				requests.find((request) => request.kind === kind);
			const obligationForKind = (kind: string) =>
				obligations.find((obligation) => obligation.proposition.kind === kind);
			const tableRequest = requestFor(TABLE_CHECK_CONSTRAINTS_OBSERVATION);
			const authorityRequest = requestFor(ALTER_AUTHORITY_OBSERVATION);
			const versionRequest = requestFor(ENGINE_VERSION_OBSERVATION);
			const deparseRequest = requestFor(EXPRESSION_DEPARSE_OBSERVATION);
			const absentConstraintObligation = obligationForKind(
				CHECK_CONSTRAINT_ABSENT_OBSERVATION,
			);
			const deparse = deparseRequest
				? tableCheckDeparseEvidenceFor({
						evidence,
						request: deparseRequest,
					})
				: { kind: 'missing' as const };
			const tableExists = tableRequest
				? claimHolds(evidence, tableRequest)
				: undefined;
			const targetAbsent = absentConstraintObligation
				? claimHolds(evidence, absentConstraintObligation)
				: undefined;
			const hasAlterAuthority = authorityRequest
				? claimHolds(evidence, authorityRequest)
				: undefined;
			const versionSupported = versionRequest
				? claimHolds(evidence, versionRequest)
				: undefined;
			const checks = tableRequest
				? checksFromEvidence(evidence, tableRequest)
				: undefined;
			if (
				tableExists === undefined ||
				targetAbsent === undefined ||
				hasAlterAuthority === undefined ||
				versionSupported === undefined ||
				deparse.kind !== 'found' ||
				!checks
			) {
				return { outcome: 'blocked', obligations, assumptions: [] };
			}
			if (
				tableRequest &&
				tableExists &&
				relkind(evidence, tableRequest) !== 'r'
			) {
				return {
					outcome: 'inapplicable',
					obligations: [
						{
							proposition: {
								kind: TABLE_CHECK_CONSTRAINTS_OBSERVATION,
								scope: tableRequest.scope,
								detail: PARTITIONED_TABLE_UNSUPPORTED_DETAIL,
							},
							scope: tableRequest.scope,
							dischargeableBy: [tableRequest],
						},
					],
					assumptions: [],
				};
			}
			if (
				!tableExists ||
				!targetAbsent ||
				!hasAlterAuthority ||
				!versionSupported
			) {
				return { outcome: 'inapplicable', obligations, assumptions: [] };
			}
			const applicable: AddCheckApplicableEvaluation = {
				outcome: 'applicable',
				obligations,
				assumptions: match.assumptions ?? [],
				catalogChecks: checks,
				expression: deparse.evidence.expression,
				predicate: deparse.evidence.predicate,
			};
			return applicable;
		},
		generateCandidate(
			match: AddCheckMatch,
			evaluation: ApplicableEvaluation,
		): TransitionFragment {
			const resolvedMatch = matchForOperation(match, evaluation);
			const addCheckEvaluation = evaluation as AddCheckApplicableEvaluation;
			const operation = operationFor(resolvedMatch, addCheckEvaluation);
			const externalAssumption = externalDdlAssumption(resolvedMatch);
			const table = resourceForMatch(
				resolvedMatch,
				'table',
				resolvedMatch.database,
			);
			const check = resourceForMatch(
				resolvedMatch,
				'check-constraint',
				resolvedMatch.database,
			);
			const composition = compositionForRequiredEnumLabels(
				resolvedMatch,
				naming,
			);
			return {
				generatedBy: { id: ADD_CHECK_RULE_ID, pack: PG_RULE_PACK_ARTIFACT },
				operations: [operation],
				...(composition ? { composition } : {}),
				obligations: evaluation.obligations.map((obligation) => ({
					...obligation,
					appliesTo: operation.ref,
				})),
				assumptions: [...evaluation.assumptions, externalAssumption],
				guards: [
					{
						appliesTo: operation.ref,
						predicate: {
							kind: CHECK_ROWS_SATISFY_GUARD,
							target: check,
							scope: [check],
							detail: {
								schema: resolvedMatch.schema,
								table: resolvedMatch.table,
								constraint: resolvedMatch.constraint,
							},
						},
						protocol: {
							kind: 'lock-and-check',
							onFailureLeaves: [],
							binding: {
								kind: 'external-ddl-exclusion',
								assumption: externalAssumption.id,
								scope: [table, check],
							},
						},
						phase: 'before-operation',
					},
				],
				selectionRationale: {
					chosen: { id: ADD_CHECK_RULE_ID, pack: PG_RULE_PACK_ARTIFACT },
					overRules: [],
					why: 'desired table adds one validated PostgreSQL CHECK constraint',
				},
			};
		},
	};
}
