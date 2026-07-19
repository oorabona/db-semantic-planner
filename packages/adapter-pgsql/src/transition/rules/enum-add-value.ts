import { enumAddDelta, resolveEnumSchemaForComparison } from '@dbsp/core';
import type {
	ApplicableEvaluation,
	Assumption,
	EvidenceView,
	JsonValue,
	ModelIR,
	ObservationContext,
	ObservationRequest,
	PhysicalOperation,
	ProofObligation,
	RecognitionContext,
	RecognitionResult,
	ResourceAddress,
	RuleEvaluation,
	TransitionCompositionFact,
	TransitionFragment,
	TransitionFragmentComposition,
	TransitionRule,
} from '@dbsp/types';
import type { NamingPlugin } from '../../naming-plugin.js';
import { identityNaming } from '../../naming-plugin.js';
import { pgEnumLabelVisibleFact } from '../composition-facts.js';
import {
	ALTER_TYPE_ADD_VALUE_CAPABILITY,
	ALTER_TYPE_ADD_VALUE_MIN_SERVER_VERSION_NUM,
	ALTER_TYPE_ADD_VALUE_OPERATION_KIND,
	ALTER_TYPE_AUTHORITY_OBSERVATION,
	ENGINE_VERSION_OBSERVATION,
	ENUM_ADD_VALUE_RULE_ID,
	ENUM_LABEL_VISIBLE_OBSERVATION,
	ENUM_TYPE_EXISTS_OBSERVATION,
	PG_RULE_PACK_ARTIFACT,
} from '../constants.js';
import { assumptionId } from '../ids.js';
import { validatePgEnumLabel } from '../operations/alter-type-add-value.js';

export interface EnumAddValueMatch {
	readonly schema?: string;
	readonly database?: string;
	readonly type: string;
	readonly label: string;
	readonly after?: string;
	readonly expectedBefore: readonly string[];
	readonly expectedAfter: readonly string[];
	readonly assumptions?: readonly Assumption[];
}

type ResolvedEnumAddValueMatch = EnumAddValueMatch & {
	readonly schema: string;
	readonly database: string;
};

export interface EnumAddValueRuleOptions {
	readonly naming?: NamingPlugin;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function resourceForMatch(
	match: Pick<EnumAddValueMatch, 'schema' | 'database' | 'type'>,
	database = match.database ?? 'model',
): ResourceAddress {
	const base: ResourceAddress = {
		engine: 'postgresql',
		database,
		kind: 'type',
		name: match.type,
		qualifiedBy: ['enum'],
	};
	return match.schema ? { ...base, schema: match.schema } : base;
}

function requestDetail(match: Pick<EnumAddValueMatch, 'schema' | 'type'>) {
	return {
		type: match.type,
		schema: match.schema ?? null,
	};
}

function enumTypeExistsRequest(match: EnumAddValueMatch): ObservationRequest {
	return {
		kind: ENUM_TYPE_EXISTS_OBSERVATION,
		scope: [resourceForMatch(match)],
		detail: requestDetail(match),
	};
}

function alterAuthorityRequest(match: EnumAddValueMatch): ObservationRequest {
	return {
		kind: ALTER_TYPE_AUTHORITY_OBSERVATION,
		scope: [resourceForMatch(match)],
		detail: requestDetail(match),
	};
}

function engineVersionRequest(match: EnumAddValueMatch): ObservationRequest {
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
			minServerVersionNum: ALTER_TYPE_ADD_VALUE_MIN_SERVER_VERSION_NUM,
		},
	};
}

function requiredObservationsFor(
	match: EnumAddValueMatch,
): readonly ObservationRequest[] {
	return [
		enumTypeExistsRequest(match),
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

function evaluationObligations(
	match: EnumAddValueMatch,
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

function operationRef(match: EnumAddValueMatch): string {
	return `postgresql:enum-add-value:${JSON.stringify([
		match.schema ?? null,
		match.type,
		match.label,
		enumAddPositionIdentity(match),
	])}`;
}

function enumAddPositionIdentity(
	match: Pick<EnumAddValueMatch, 'after' | 'expectedBefore'>,
) {
	const appendedAfter =
		match.expectedBefore.length > 0
			? match.expectedBefore[match.expectedBefore.length - 1]
			: null;
	return match.after === undefined
		? {
				mode: 'append',
				after: appendedAfter,
			}
		: { mode: 'after', after: match.after };
}

function operationFor(match: ResolvedEnumAddValueMatch): PhysicalOperation {
	const payload =
		match.after !== undefined
			? {
					schema: match.schema,
					type: match.type,
					label: match.label,
					after: match.after,
					expectedBefore: match.expectedBefore,
					expectedAfter: match.expectedAfter,
				}
			: {
					schema: match.schema,
					type: match.type,
					label: match.label,
					expectedBefore: match.expectedBefore,
					expectedAfter: match.expectedAfter,
				};
	return {
		ref: operationRef(match),
		operationKind: ALTER_TYPE_ADD_VALUE_OPERATION_KIND,
		payload: payload as unknown as JsonValue,
	};
}

function externalDdlAssumption(match: ResolvedEnumAddValueMatch): Assumption {
	const database = match.database ?? 'model';
	return {
		id: assumptionId(
			`dbsp.postgresql.external-ddl-exclusion:${JSON.stringify([
				database,
				match.schema,
				match.type,
			])}`,
		),
		class: 'external-ddl-exclusion',
		asserter: { kind: 'pack', artifact: PG_RULE_PACK_ARTIFACT },
		statement:
			'No concurrent DDL renames, replaces, or changes the enum type while the enum-add lock is acquired and checked.',
		scope: [resourceForMatch(match, database)],
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
	match: EnumAddValueMatch,
	evaluation: ApplicableEvaluation,
): ResolvedEnumAddValueMatch {
	const schema = match.schema ?? schemaFromEvaluation(evaluation);
	if (!schema) {
		throw new Error('enum-add-value requires an explicit target schema');
	}
	const database = match.database ?? databaseFromEvaluation(evaluation);
	if (!database) {
		throw new Error('enum-add-value requires a live database identity');
	}
	return { ...match, schema, database };
}

function compositionFact(params: {
	readonly match: Pick<
		EnumAddValueMatch,
		'schema' | 'database' | 'type' | 'label'
	>;
	readonly context?: ObservationContext;
}) {
	const schema = params.match.schema ?? params.context?.targetSchema;
	if (!schema) {
		throw new Error(
			'enum-add-value composition requires an explicit enum schema',
		);
	}
	return pgEnumLabelVisibleFact({
		database: params.match.database ?? 'model',
		schema,
		type: params.match.type,
		label: params.match.label,
	});
}

function compositionForMatch(
	match: EnumAddValueMatch,
	context?: ObservationContext,
): TransitionFragmentComposition {
	return {
		produces: [
			{
				opRef: operationRef(match),
				fact: compositionFact({
					match,
					...(context ? { context } : {}),
				}),
				available: 'after-commit',
			},
		],
	};
}

function stringDetail(
	detail: JsonValue | undefined,
	key: string,
): string | undefined {
	if (!isRecord(detail)) {
		return undefined;
	}
	const value = detail[key];
	return typeof value === 'string' ? value : undefined;
}

export function satisfiesPgEnumLabelVisibleCompositionFact(
	fact: TransitionCompositionFact,
	current: ModelIR,
	_context: ObservationContext,
): boolean {
	if (fact.kind !== ENUM_LABEL_VISIBLE_OBSERVATION) {
		return false;
	}
	if (
		fact.resource.kind !== 'type' ||
		!(fact.resource.qualifiedBy?.includes('enum') ?? false)
	) {
		return false;
	}
	const label = stringDetail(fact.detail, 'label');
	const type = stringDetail(fact.detail, 'type') ?? fact.resource.name;
	const detailSchema = stringDetail(fact.detail, 'schema');
	const resourceSchema = fact.resource.schema;
	if (!label || !type || !detailSchema || !resourceSchema) {
		return false;
	}
	if (detailSchema !== resourceSchema) {
		return false;
	}
	for (const [key, enumDef] of current.enums ?? new Map()) {
		if (key !== type && enumDef.name !== type) {
			continue;
		}
		if (enumDef.schema !== detailSchema) {
			continue;
		}
		if (enumDef.values.includes(label)) {
			return true;
		}
	}
	return false;
}

export function createEnumAddValueRule(
	options: EnumAddValueRuleOptions = {},
): TransitionRule<EnumAddValueMatch> {
	const naming = options.naming ?? identityNaming;
	return {
		id: ENUM_ADD_VALUE_RULE_ID,
		artifact: PG_RULE_PACK_ARTIFACT,
		support: {
			engine: 'postgresql',
			versions: [{ min: '12' }],
			requiredCapabilities: [ALTER_TYPE_ADD_VALUE_CAPABILITY],
		},
		recognize(
			desired: ModelIR,
			current: ModelIR,
			context?: RecognitionContext,
		): RecognitionResult<EnumAddValueMatch> {
			for (const desiredEnum of desired.enums?.values() ?? []) {
				const currentEnum = current.enums?.get(desiredEnum.name);
				if (!currentEnum) {
					continue;
				}
				const targetSchema = context?.context.targetSchema;
				const resolvedDesiredEnum = resolveEnumSchemaForComparison(
					desiredEnum,
					targetSchema,
				);
				const resolvedCurrentEnum = resolveEnumSchemaForComparison(
					currentEnum,
					targetSchema,
				);
				const delta = enumAddDelta(resolvedDesiredEnum, resolvedCurrentEnum);
				if (delta.kind !== 'add-label') {
					continue;
				}
				validatePgEnumLabel(delta.label, 'enum value');
				if (delta.after !== undefined) {
					validatePgEnumLabel(delta.after, 'enum AFTER position');
				}
				const type = naming.toDatabase(desiredEnum.name);
				const schema = resolvedDesiredEnum.schema ?? resolvedCurrentEnum.schema;
				return {
					recognized: true,
					match: {
						type,
						label: delta.label,
						...(delta.after !== undefined ? { after: delta.after } : {}),
						expectedBefore: currentEnum.values,
						expectedAfter: desiredEnum.values,
						...(schema ? { schema } : {}),
					},
				};
			}
			return { recognized: false };
		},
		requiredObservations: requiredObservationsFor,
		declareComposition(
			match: EnumAddValueMatch,
			context: ObservationContext,
		): TransitionFragmentComposition {
			return compositionForMatch(match, context);
		},
		evaluate(match: EnumAddValueMatch, evidence: EvidenceView): RuleEvaluation {
			const obligations = evaluationObligations(match, evidence);
			const requests = obligations.flatMap((obligation) => [
				...(obligation.dischargeableBy ?? []),
			]);
			const requestFor = (kind: string) =>
				requests.find((request) => request.kind === kind);
			const existsRequest = requestFor(ENUM_TYPE_EXISTS_OBSERVATION);
			const authorityRequest = requestFor(ALTER_TYPE_AUTHORITY_OBSERVATION);
			const versionRequest = requestFor(ENGINE_VERSION_OBSERVATION);
			const exists = existsRequest
				? claimHolds(evidence, existsRequest)
				: undefined;
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
			return {
				outcome: 'applicable',
				obligations,
				assumptions: match.assumptions ?? [],
			};
		},
		generateCandidate(
			match: EnumAddValueMatch,
			evaluation: ApplicableEvaluation,
		): TransitionFragment {
			const resolvedMatch = matchForOperation(match, evaluation);
			const operation = operationFor(resolvedMatch);
			const externalAssumption = externalDdlAssumption(resolvedMatch);
			return {
				generatedBy: {
					id: ENUM_ADD_VALUE_RULE_ID,
					pack: PG_RULE_PACK_ARTIFACT,
				},
				operations: [operation],
				composition: compositionForMatch(resolvedMatch),
				obligations: evaluation.obligations.map((obligation) => ({
					...obligation,
					appliesTo: operation.ref,
				})),
				assumptions: [...evaluation.assumptions, externalAssumption],
				guards: [
					{
						appliesTo: operation.ref,
						predicate: {
							kind: ENUM_TYPE_EXISTS_OBSERVATION,
							target: resourceForMatch(resolvedMatch, resolvedMatch.database),
							scope: [resourceForMatch(resolvedMatch, resolvedMatch.database)],
							detail: {
								schema: resolvedMatch.schema,
								type: resolvedMatch.type,
							},
						},
						protocol: {
							kind: 'engine-validated',
							onFailureLeaves: [],
							binding: {
								kind: 'external-ddl-exclusion',
								assumption: externalAssumption.id,
								scope: [
									resourceForMatch(resolvedMatch, resolvedMatch.database),
								],
							},
						},
						phase: 'before-operation',
					},
				],
				selectionRationale: {
					chosen: {
						id: ENUM_ADD_VALUE_RULE_ID,
						pack: PG_RULE_PACK_ARTIFACT,
					},
					overRules: [],
					why: 'desired enum type adds one PostgreSQL enum label',
				},
			};
		},
	};
}
