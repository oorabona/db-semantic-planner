import type {
	Assumption,
	CollationRef,
	EquivalenceCapability,
	EquivalenceContext,
	EquivalenceResult,
	EvidenceObservation,
	ExpressionEquivalenceCategory,
	ExpressionValue,
	JsonValue,
	ObservationContext,
	ObservationRequest,
	ProofClaimDraft,
	ProofObligation,
	TypeRef,
} from '@dbsp/types';
import {
	EXPRESSION_DEPARSE_OBSERVATION,
	PG_DEPARSE_ARTIFACT,
	PG_EQUIVALENCE_ARTIFACT,
} from './constants.js';
import { matchLiveObservationContext } from './context-match.js';
import { stableJson } from './stable-json.js';

const TYPE_ALIASES = new Map<string, string>([
	['int2', 'smallint'],
	['smallint', 'smallint'],
	['int4', 'integer'],
	['integer', 'integer'],
	['int8', 'bigint'],
	['bigint', 'bigint'],
	['varchar', 'character varying'],
	['character varying', 'character varying'],
	['bpchar', 'character'],
	['character', 'character'],
	['bool', 'boolean'],
	['boolean', 'boolean'],
	['timestamptz', 'timestamp with time zone'],
	['timestamp with time zone', 'timestamp with time zone'],
	['timestamp', 'timestamp without time zone'],
	['timestamp without time zone', 'timestamp without time zone'],
	['text', 'text'],
	['uuid', 'uuid'],
	['json', 'json'],
	['jsonb', 'jsonb'],
	['date', 'date'],
	['time', 'time without time zone'],
	['time without time zone', 'time without time zone'],
	['timetz', 'time with time zone'],
	['time with time zone', 'time with time zone'],
	['numeric', 'numeric'],
	['decimal', 'numeric'],
	['float4', 'real'],
	['real', 'real'],
	['float8', 'double precision'],
	['double precision', 'double precision'],
]);

function json(value: unknown): JsonValue {
	return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function normalizeName(value: string): string {
	return value.trim().replace(/\s+/g, ' ');
}

type NormalizedIdentifier = {
	readonly value: string;
	readonly quoted: boolean;
};

const UNQUOTED_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const UNQUOTED_MULTIWORD_TYPE_RE =
	/^[A-Za-z_][A-Za-z0-9_$]*(?:\s+[A-Za-z_][A-Za-z0-9_$]*)*$/;

function unquoteIdentifier(value: string): string | undefined {
	if (!value.startsWith('"') || !value.endsWith('"') || value.length < 2) {
		return undefined;
	}
	let result = '';
	for (let index = 1; index < value.length - 1; index++) {
		const ch = value[index];
		if (ch !== '"') {
			result += ch;
			continue;
		}
		if (value[index + 1] !== '"') {
			return undefined;
		}
		result += '"';
		index += 1;
	}
	return result.length > 0 ? result : undefined;
}

function normalizeIdentifier(
	value: string | undefined,
	options: { readonly allowMultiword?: boolean } = {},
): NormalizedIdentifier | undefined {
	const trimmed = value?.trim();
	if (!trimmed) {
		return undefined;
	}
	const unquoted = unquoteIdentifier(trimmed);
	if (unquoted !== undefined) {
		return { value: unquoted, quoted: true };
	}
	if (trimmed.includes('"')) {
		return undefined;
	}
	const pattern = options.allowMultiword
		? UNQUOTED_MULTIWORD_TYPE_RE
		: UNQUOTED_IDENTIFIER_RE;
	if (!pattern.test(trimmed)) {
		return undefined;
	}
	return {
		value: trimmed.toLowerCase().replace(/\s+/g, ' '),
		quoted: false,
	};
}

function normalizeSchema(
	value: string | undefined,
): NormalizedIdentifier | undefined {
	return normalizeIdentifier(value);
}

function schemaKey(
	value: NormalizedIdentifier | undefined,
): string | undefined {
	return value?.value;
}

function typeProposition(
	left: TypeRef,
	right: TypeRef,
	detail: Record<string, unknown> = {},
) {
	return {
		kind: 'postgresql.equivalence.type',
		scope: [],
		detail: json({ left, right, ...detail }),
	};
}

function expressionProposition(
	left: ExpressionValue,
	right: ExpressionValue,
	category: ExpressionEquivalenceCategory,
	detail: Record<string, unknown> = {},
) {
	return {
		kind: 'postgresql.equivalence.expression',
		scope: [],
		detail: json({ left, right, category, ...detail }),
	};
}

function collationProposition(
	left: CollationRef,
	right: CollationRef,
	detail: Record<string, unknown> = {},
) {
	return {
		kind: 'postgresql.equivalence.collation',
		scope: [],
		detail: json({ left, right, ...detail }),
	};
}

function draft<TConclusion extends ProofClaimDraft['conclusion']>(
	conclusion: TConclusion,
	proposition: ProofClaimDraft['proposition'],
): ProofClaimDraft<TConclusion> {
	return {
		proposition,
		scope: proposition.scope,
		semantics: PG_EQUIVALENCE_ARTIFACT,
		conclusion,
	};
}

function equivalent(
	proposition: ProofClaimDraft<'established'>['proposition'],
	assumptions: readonly Assumption[] = [],
): EquivalenceResult {
	if (assumptions.length === 0) {
		return { kind: 'equivalent', claim: draft('established', proposition) };
	}
	return {
		kind: 'equivalent',
		claim: {
			...draft('established-under-assumptions', proposition),
			assumes: assumptions.map((assumption) => assumption.id),
		},
		assumptions,
	};
}

function different(
	proposition: ProofClaimDraft<'refuted'>['proposition'],
): EquivalenceResult {
	return { kind: 'different', claim: draft('refuted', proposition) };
}

function unknown(obligation: ProofObligation): EquivalenceResult {
	return { kind: 'unknown', obligations: [obligation] };
}

function unresolvedTypeIdentityObligation(
	left: TypeRef,
	right: TypeRef,
	reason: string,
): ProofObligation {
	const proposition = {
		kind: 'postgresql.equivalence.type.identity-unresolved',
		scope: [],
		detail: json({ left, right, reason }),
	};
	return {
		proposition,
		scope: [],
	};
}

function unresolvedExpressionObligation(
	left: ExpressionValue,
	right: ExpressionValue,
	category: ExpressionEquivalenceCategory,
	reason: string,
	extra: Record<string, unknown> = {},
): ProofObligation {
	const proposition = {
		kind: 'postgresql.equivalence.expression.unknown',
		scope: [],
		detail: json({ left, right, category, reason, ...extra }),
	};
	return {
		proposition,
		scope: [],
	};
}

function deparseExpressionObligation(
	left: ExpressionValue,
	right: ExpressionValue,
	category: ExpressionEquivalenceCategory,
	reason: string,
): ProofObligation {
	return {
		proposition: {
			kind: 'postgresql.equivalence.expression.deparse-required',
			scope: [],
			detail: json({
				left,
				right,
				category,
				reason,
				observationKind: EXPRESSION_DEPARSE_OBSERVATION,
			}),
		},
		scope: [],
	};
}

function unresolvedCollationObligation(
	left: CollationRef,
	right: CollationRef,
	reason: string,
): ProofObligation {
	const proposition = {
		kind: 'postgresql.equivalence.collation.identity-unresolved',
		scope: [],
		detail: json({ left, right, reason }),
	};
	return {
		proposition,
		scope: [],
	};
}

function sameArtifact(
	left: { readonly id: string; readonly version: string },
	right: { readonly id: string; readonly version: string },
): boolean {
	return left.id === right.id && left.version === right.version;
}

type NormalizedType = {
	readonly canonicalName: string;
	readonly schema?: string;
	readonly isBuiltin: boolean;
	readonly modifiers: readonly string[];
	readonly arrayDepth: number;
	readonly rawName: string;
};

function resolvedCustomSchema(
	ref: TypeRef,
	context: EquivalenceContext,
	normalizedSchema: NormalizedIdentifier | undefined,
): NormalizedIdentifier | undefined {
	if (ref.schemaScope === 'target') {
		return context.targetSchema
			? normalizeSchema(context.targetSchema)
			: undefined;
	}
	if (normalizedSchema) {
		return normalizedSchema;
	}
	if (context.searchPath && context.searchPath.length === 1) {
		return normalizeSchema(context.searchPath[0]);
	}
	return undefined;
}

function normalizeType(
	ref: TypeRef,
	context: EquivalenceContext,
): NormalizedType | undefined {
	const normalizedName = normalizeIdentifier(ref.name, {
		allowMultiword: true,
	});
	if (!normalizedName) {
		return undefined;
	}
	const rawName = normalizedName.value;
	const normalizedSchema = normalizeSchema(ref.schema);
	if (ref.schema && !normalizedSchema) {
		return undefined;
	}
	const aliased = normalizedName.quoted ? undefined : TYPE_ALIASES.get(rawName);
	const isTargetScoped = ref.schemaScope === 'target';
	const isExplicitPgCatalog =
		!isTargetScoped && normalizedSchema?.value === 'pg_catalog';
	const isUnqualified = normalizedSchema === undefined && !isTargetScoped;
	const isBuiltinAlias =
		!normalizedName.quoted &&
		aliased !== undefined &&
		(isExplicitPgCatalog || isUnqualified);
	const isBuiltin =
		!normalizedName.quoted && (isBuiltinAlias || isExplicitPgCatalog);
	const schema = isBuiltin
		? 'pg_catalog'
		: resolvedCustomSchema(ref, context, normalizedSchema);
	return {
		canonicalName: isBuiltinAlias ? aliased : rawName,
		...(schema
			? { schema: typeof schema === 'string' ? schema : schema.value }
			: {}),
		isBuiltin,
		modifiers: ref.modifiers.map((modifier) => normalizeName(modifier)),
		arrayDepth: ref.arrayDepth,
		rawName,
	};
}

function sameStringArray(
	left: readonly string[],
	right: readonly string[],
): boolean {
	return (
		left.length === right.length &&
		left.every((value, index) => value === right[index])
	);
}

function compareType(
	left: TypeRef,
	right: TypeRef,
	context: EquivalenceContext,
): EquivalenceResult {
	const proposition = typeProposition(left, right, {
		method: 'static-pg-alias-table',
	});
	if (stableJson(left) === stableJson(right)) {
		return equivalent(proposition);
	}
	if (left.arrayDepth !== right.arrayDepth) {
		return different(typeProposition(left, right, { field: 'arrayDepth' }));
	}
	const leftCatalog = left.catalog;
	const rightCatalog = right.catalog;
	if (
		leftCatalog?.oid &&
		rightCatalog?.oid &&
		leftCatalog.oid !== rightCatalog.oid
	) {
		return different(typeProposition(left, right, { field: 'catalog.oid' }));
	}

	const normalizedLeft = normalizeType(left, context);
	const normalizedRight = normalizeType(right, context);
	if (!normalizedLeft || !normalizedRight) {
		return unknown(
			unresolvedTypeIdentityObligation(
				left,
				right,
				'type identifier quoting or spelling is not resolved by static context',
			),
		);
	}
	if (
		(left.schemaScope === 'target' && !normalizedLeft.schema) ||
		(right.schemaScope === 'target' && !normalizedRight.schema)
	) {
		return unknown(
			unresolvedTypeIdentityObligation(
				left,
				right,
				'target-scoped type identity requires an explicit target schema',
			),
		);
	}
	if (!sameStringArray(normalizedLeft.modifiers, normalizedRight.modifiers)) {
		return different(typeProposition(left, right, { field: 'modifiers' }));
	}
	if (normalizedLeft.isBuiltin && normalizedRight.isBuiltin) {
		return normalizedLeft.canonicalName === normalizedRight.canonicalName
			? equivalent(proposition)
			: different(typeProposition(left, right, { field: 'name' }));
	}
	if (normalizedLeft.canonicalName !== normalizedRight.canonicalName) {
		return different(typeProposition(left, right, { field: 'name' }));
	}
	if (normalizedLeft.schema === normalizedRight.schema) {
		return equivalent(proposition);
	}
	if (!normalizedLeft.schema || !normalizedRight.schema) {
		return unknown(
			unresolvedTypeIdentityObligation(
				left,
				right,
				'unqualified non-built-in type identity is not resolved by static context',
			),
		);
	}
	return different(typeProposition(left, right, { field: 'schema' }));
}

type GuardedExpressionComparison =
	| {
			readonly kind: 'portable';
			readonly left: Extract<ExpressionValue, { readonly kind: 'portable' }>;
			readonly right: Extract<ExpressionValue, { readonly kind: 'portable' }>;
	  }
	| {
			readonly kind: 'vendor-validated';
			readonly left: Extract<
				ExpressionValue,
				{ readonly kind: 'vendor-validated' }
			>;
			readonly right: Extract<
				ExpressionValue,
				{ readonly kind: 'vendor-validated' }
			>;
	  }
	| {
			readonly kind: 'unsafe-native';
			readonly left: Extract<
				ExpressionValue,
				{ readonly kind: 'unsafe-native' }
			>;
			readonly right: Extract<
				ExpressionValue,
				{ readonly kind: 'unsafe-native' }
			>;
	  }
	| { readonly kind: 'unknown'; readonly reason: string };

type DeparseEvidenceOutcome = {
	readonly surface: string;
	readonly leftCanonical: string;
	readonly rightCanonical: string;
};

type DeparseEvidenceLookup =
	| { readonly kind: 'found'; readonly evidence: DeparseEvidenceOutcome }
	| { readonly kind: 'conflict'; readonly reason: string }
	| { readonly kind: 'missing' };

type DeparseBoundEquivalenceContext = EquivalenceContext & {
	readonly deparseRequest?: ObservationRequest;
	readonly proofObservationContext?: ObservationContext;
};

function expressionCategory(
	value: ExpressionValue,
): ExpressionEquivalenceCategory | undefined {
	return value.kind === 'portable' ? undefined : value.category;
}

function guardExpressionComparison(
	left: ExpressionValue,
	right: ExpressionValue,
	category: ExpressionEquivalenceCategory,
): GuardedExpressionComparison {
	const leftCategory = expressionCategory(left);
	const rightCategory = expressionCategory(right);
	if (leftCategory !== undefined && leftCategory !== category) {
		return {
			kind: 'unknown',
			reason: 'left expression category does not match requested category',
		};
	}
	if (rightCategory !== undefined && rightCategory !== category) {
		return {
			kind: 'unknown',
			reason: 'right expression category does not match requested category',
		};
	}
	if (left.kind === 'unresolvable' || right.kind === 'unresolvable') {
		return {
			kind: 'unknown',
			reason:
				'unresolvable expression has no comparable SQL text or portable AST',
		};
	}

	if (left.kind === 'unsafe-native' || right.kind === 'unsafe-native') {
		if (left.kind === 'unsafe-native' && right.kind === 'unsafe-native') {
			return { kind: 'unsafe-native', left, right };
		}
		return {
			kind: 'unknown',
			reason:
				'mixed unsafe native expression kinds are not comparable by static equality',
		};
	}
	if (left.kind !== right.kind) {
		return {
			kind: 'unknown',
			reason: 'mixed expression kinds require a vendor deparse observation',
		};
	}
	if (left.kind === 'portable') {
		if (right.kind !== 'portable') {
			return {
				kind: 'unknown',
				reason: 'mixed expression kinds are not comparable by static equality',
			};
		}
		return { kind: 'portable', left, right };
	}
	if (left.kind === 'vendor-validated') {
		if (right.kind !== 'vendor-validated') {
			return {
				kind: 'unknown',
				reason: 'mixed expression kinds are not comparable by static equality',
			};
		}
		if (!sameArtifact(left.validatedBy, right.validatedBy)) {
			return {
				kind: 'unknown',
				reason: 'vendor-validated expressions have different trust roots',
			};
		}
		return { kind: 'vendor-validated', left, right };
	}
	return {
		kind: 'unknown',
		reason: 'unsafe native expression comparison cannot carry its assumption',
	};
}

function attestationForUnsafeNativeEquivalence(
	left: Extract<ExpressionValue, { readonly kind: 'unsafe-native' }>,
	right: Extract<ExpressionValue, { readonly kind: 'unsafe-native' }>,
): Assumption | undefined {
	if (left.assumption !== right.assumption) {
		return undefined;
	}
	const attestations = [left.attestation, right.attestation].filter(
		(attestation): attestation is Assumption => attestation !== undefined,
	);
	if (attestations.length === 0) {
		return undefined;
	}
	const [first, ...rest] = attestations;
	if (!first || first.id !== left.assumption) {
		return undefined;
	}
	if (
		rest.some((attestation) => stableJson(attestation) !== stableJson(first))
	) {
		return undefined;
	}
	return first;
}

function sameExpressionValue(left: unknown, right: ExpressionValue): boolean {
	return stableJson(left) === stableJson(right);
}

function equivalenceObservationContextMatches(
	observation: EvidenceObservation,
	context: EquivalenceContext,
): boolean {
	const expected = (context as DeparseBoundEquivalenceContext)
		.proofObservationContext;
	if (!expected) {
		return false;
	}
	return matchLiveObservationContext({
		expected,
		actual: observation.context,
		label: 'deparse evidence observation context',
	}).ok;
}

function boundDeparseRequest(
	context: EquivalenceContext,
): ObservationRequest | undefined {
	const request = (context as DeparseBoundEquivalenceContext).deparseRequest;
	if (
		!request ||
		request.kind !== EXPRESSION_DEPARSE_OBSERVATION ||
		!Array.isArray(request.scope)
	) {
		return undefined;
	}
	return request;
}

function sameBoundDeparseRequest(
	expected: ObservationRequest,
	issued: ObservationRequest,
): boolean {
	return (
		expected.kind === issued.kind &&
		stableJson(expected.scope) === stableJson(issued.scope) &&
		stableJson(expected.detail) === stableJson(issued.detail)
	);
}

function sameDeparseTargetDetail(
	left: Record<string, unknown>,
	right: Record<string, unknown>,
): boolean {
	const leftTarget = { ...left };
	const rightTarget = { ...right };
	delete leftTarget.left;
	delete leftTarget.right;
	delete rightTarget.left;
	delete rightTarget.right;
	return stableJson(leftTarget) === stableJson(rightTarget);
}

function deparseClaimHolds(
	observation: EvidenceObservation,
	matchingDetail: Record<string, unknown>,
): readonly boolean[] {
	const value = observation.result.value;
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return [];
	}
	const claims = (value as { readonly claims?: unknown }).claims;
	if (!Array.isArray(claims)) {
		return [];
	}
	const holds: boolean[] = [];
	for (const claim of claims) {
		if (!claim || typeof claim !== 'object' || Array.isArray(claim)) {
			continue;
		}
		const typed = claim as {
			readonly kind?: unknown;
			readonly holds?: unknown;
			readonly detail?: unknown;
		};
		if (
			typed.kind !== EXPRESSION_DEPARSE_OBSERVATION ||
			typeof typed.holds !== 'boolean' ||
			!typed.detail ||
			typeof typed.detail !== 'object' ||
			Array.isArray(typed.detail) ||
			!sameDeparseTargetDetail(
				matchingDetail,
				typed.detail as Record<string, unknown>,
			)
		) {
			continue;
		}
		holds.push(typed.holds);
	}
	return holds;
}

function deparseEvidenceFor(
	left: ExpressionValue,
	right: ExpressionValue,
	category: ExpressionEquivalenceCategory,
	context: EquivalenceContext,
	evidence: readonly EvidenceObservation[] | undefined,
): DeparseEvidenceLookup {
	const matching: DeparseEvidenceOutcome[] = [];
	const matchingClaims: boolean[] = [];
	let matchingDetail: Record<string, unknown> | undefined;
	let matchingScope: string | undefined;
	const expectedRequest = boundDeparseRequest(context);
	for (const observation of evidence ?? []) {
		if (
			observation.source !== 'vendor-deparser' ||
			observation.request.kind !== EXPRESSION_DEPARSE_OBSERVATION ||
			!equivalenceObservationContextMatches(observation, context)
		) {
			continue;
		}
		const detail = observation.request.detail;
		if (
			!detail ||
			typeof detail !== 'object' ||
			Array.isArray(detail) ||
			(detail as { readonly category?: unknown }).category !== category ||
			!sameExpressionValue(
				(detail as { readonly left?: unknown }).left,
				left,
			) ||
			!sameExpressionValue(
				(detail as { readonly right?: unknown }).right,
				right,
			)
		) {
			continue;
		}
		if (
			expectedRequest &&
			!sameBoundDeparseRequest(expectedRequest, observation.request)
		) {
			continue;
		}
		const detailRecord = detail as Record<string, unknown>;
		if (
			matchingDetail &&
			(matchingScope !== stableJson(observation.request.scope) ||
				!sameDeparseTargetDetail(matchingDetail, detailRecord))
		) {
			return {
				kind: 'conflict',
				reason:
					'multiple deparse evidence scopes/details match the same expression pair',
			};
		}
		const value = observation.result.value;
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			continue;
		}
		const result = value as {
			readonly ok?: unknown;
			readonly surface?: unknown;
			readonly leftCanonical?: unknown;
			readonly rightCanonical?: unknown;
		};
		if (
			result.ok !== true ||
			typeof result.surface !== 'string' ||
			typeof result.leftCanonical !== 'string' ||
			typeof result.rightCanonical !== 'string'
		) {
			continue;
		}
		matchingClaims.push(...deparseClaimHolds(observation, detailRecord));
		matchingDetail = detailRecord;
		matchingScope = stableJson(observation.request.scope);
		matching.push({
			surface: result.surface,
			leftCanonical: result.leftCanonical,
			rightCanonical: result.rightCanonical,
		});
	}
	if (matching.length === 0) {
		return { kind: 'missing' };
	}
	if (matchingClaims.includes(true) && matchingClaims.includes(false)) {
		return {
			kind: 'conflict',
			reason: 'deparse evidence contains conflicting boolean claims',
		};
	}
	const [first, ...rest] = matching;
	if (!first) {
		return { kind: 'missing' };
	}
	const firstEquivalent = first.leftCanonical === first.rightCanonical;
	if (
		rest.some((candidate) => {
			const candidateEquivalent =
				candidate.leftCanonical === candidate.rightCanonical;
			return candidateEquivalent !== firstEquivalent;
		})
	) {
		return {
			kind: 'conflict',
			reason: 'deparse evidence contains both equivalent and different results',
		};
	}
	if (rest.some((candidate) => stableJson(candidate) !== stableJson(first))) {
		return {
			kind: 'conflict',
			reason: 'deparse evidence contains inconsistent canonical forms',
		};
	}
	return { kind: 'found', evidence: first };
}

function compareExpression(
	left: ExpressionValue,
	right: ExpressionValue,
	category: ExpressionEquivalenceCategory,
	context: EquivalenceContext,
	evidence?: readonly EvidenceObservation[],
): EquivalenceResult {
	const guarded = guardExpressionComparison(left, right, category);
	if (guarded.kind === 'unknown') {
		if (left.kind === 'unresolvable' || right.kind === 'unresolvable') {
			return unknown(
				unresolvedExpressionObligation(left, right, category, guarded.reason),
			);
		}
		const observed = deparseEvidenceFor(
			left,
			right,
			category,
			context,
			evidence,
		);
		if (observed.kind === 'conflict') {
			return unknown(
				unresolvedExpressionObligation(left, right, category, observed.reason),
			);
		}
		if (observed.kind === 'found') {
			const deparse = observed.evidence;
			const detail = {
				method: 'vendor-deparser',
				surface: deparse.surface,
				leftCanonical: deparse.leftCanonical,
				rightCanonical: deparse.rightCanonical,
				validatedBy: PG_DEPARSE_ARTIFACT,
			};
			return deparse.leftCanonical === deparse.rightCanonical
				? equivalent(expressionProposition(left, right, category, detail))
				: different(expressionProposition(left, right, category, detail));
		}
		if (
			(left.kind === 'portable' && right.kind === 'vendor-validated') ||
			(left.kind === 'vendor-validated' && right.kind === 'portable')
		) {
			return unknown(
				deparseExpressionObligation(left, right, category, guarded.reason),
			);
		}
		return unknown(
			unresolvedExpressionObligation(left, right, category, guarded.reason),
		);
	}
	if (guarded.kind === 'portable') {
		if (stableJson(guarded.left.ast) === stableJson(guarded.right.ast)) {
			return equivalent(
				expressionProposition(left, right, category, {
					method: 'exact',
				}),
			);
		}
		return unknown(
			unresolvedExpressionObligation(
				left,
				right,
				category,
				'portable expression ASTs are not exactly equal',
			),
		);
	}
	if (guarded.kind === 'unsafe-native') {
		const method =
			guarded.left.text === guarded.right.text
				? 'exact'
				: guarded.left.text.trim() === guarded.right.text.trim()
					? 'trim-exact'
					: undefined;
		if (!method) {
			return unknown(
				unresolvedExpressionObligation(
					left,
					right,
					category,
					'static unsafe native expression comparison only accepts exact trimmed text matches',
				),
			);
		}
		const assumption = attestationForUnsafeNativeEquivalence(
			guarded.left,
			guarded.right,
		);
		if (!assumption) {
			return unknown(
				unresolvedExpressionObligation(
					left,
					right,
					category,
					'unsafe native expression comparison requires a matching author attestation',
				),
			);
		}
		return equivalent(
			expressionProposition(left, right, category, { method }),
			[assumption],
		);
	}
	if (guarded.left.text === guarded.right.text) {
		return equivalent(
			expressionProposition(left, right, category, { method: 'exact' }),
		);
	}
	if (guarded.left.text.trim() === guarded.right.text.trim()) {
		return equivalent(
			expressionProposition(left, right, category, { method: 'trim-exact' }),
		);
	}
	return unknown(
		unresolvedExpressionObligation(
			left,
			right,
			category,
			'static expression comparison only accepts exact trimmed text matches',
		),
	);
}

function compareCollation(
	left: CollationRef,
	right: CollationRef,
): EquivalenceResult {
	const proposition = collationProposition(left, right, {
		method: 'static-pg-collation-table',
	});
	if (stableJson(left) === stableJson(right)) {
		return equivalent(proposition);
	}
	if (left.isDefault !== right.isDefault) {
		return different(collationProposition(left, right, { field: 'default' }));
	}
	const leftOid = left.catalog?.oid;
	const rightOid = right.catalog?.oid;
	if (leftOid && rightOid && leftOid !== rightOid) {
		return different(collationProposition(left, right, { field: 'oid' }));
	}
	const leftName = normalizeIdentifier(left.name);
	const rightName = normalizeIdentifier(right.name);
	if ((left.name && !leftName) || (right.name && !rightName)) {
		return unknown(
			unresolvedCollationObligation(
				left,
				right,
				'collation identifier quoting or spelling is not resolved by static context',
			),
		);
	}
	if (leftName?.value !== rightName?.value) {
		return different(collationProposition(left, right, { field: 'name' }));
	}
	const leftSchema = normalizeSchema(left.schema);
	const rightSchema = normalizeSchema(right.schema);
	if ((left.schema && !leftSchema) || (right.schema && !rightSchema)) {
		return unknown(
			unresolvedCollationObligation(
				left,
				right,
				'collation schema quoting or spelling is not resolved by static context',
			),
		);
	}
	const leftSchemaKey = schemaKey(leftSchema);
	const rightSchemaKey = schemaKey(rightSchema);
	if (
		leftSchemaKey === rightSchemaKey ||
		(!leftSchemaKey && rightSchemaKey === 'pg_catalog') ||
		(leftSchemaKey === 'pg_catalog' && !rightSchemaKey)
	) {
		return equivalent(proposition);
	}
	return unknown(
		unresolvedCollationObligation(
			left,
			right,
			'unqualified collation identity is not resolved by static context',
		),
	);
}

export function createPgEquivalenceCapability(): EquivalenceCapability {
	return {
		artifact: PG_EQUIVALENCE_ARTIFACT,
		compareType,
		compareExpression,
		compareCollation,
	};
}
