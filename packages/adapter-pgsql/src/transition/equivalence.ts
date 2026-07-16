import type {
	CollationRef,
	EquivalenceCapability,
	EquivalenceContext,
	EquivalenceResult,
	ExpressionEquivalenceCategory,
	ExpressionValue,
	JsonValue,
	ProofClaimDraft,
	ProofObligation,
	TypeRef,
} from '@dbsp/types';
import { PG_EQUIVALENCE_ARTIFACT } from './constants.js';
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
): EquivalenceResult {
	return { kind: 'equivalent', claim: draft('established', proposition) };
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
): ProofObligation {
	const proposition = {
		kind: 'postgresql.equivalence.expression.unknown',
		scope: [],
		detail: json({ left, right, category, reason }),
	};
	return {
		proposition,
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
	if (ref.schemaScope === 'target' && context.targetSchema) {
		return normalizeSchema(context.targetSchema);
	}
	if (ref.schemaScope === 'target' && context.searchPath?.length === 1) {
		return normalizeSchema(context.searchPath[0]);
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
	| { readonly kind: 'unknown'; readonly reason: string };

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

	// Future assumption-carrying equivalence can extend this branch.
	if (left.kind === 'unsafe-native' || right.kind === 'unsafe-native') {
		return {
			kind: 'unknown',
			reason: 'unsafe native expression comparison cannot carry its assumption',
		};
	}
	if (left.kind !== right.kind) {
		return {
			kind: 'unknown',
			reason: 'mixed expression kinds are not comparable by static equality',
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

function compareExpression(
	left: ExpressionValue,
	right: ExpressionValue,
	category: ExpressionEquivalenceCategory,
): EquivalenceResult {
	const guarded = guardExpressionComparison(left, right, category);
	if (guarded.kind === 'unknown') {
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
