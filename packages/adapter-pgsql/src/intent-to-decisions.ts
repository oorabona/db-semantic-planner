/**
 * Intent to Decisions Converter
 *
 * Converts core's QueryIntent into Decision[] format for the pgsql compiler.
 * This bridges the gap between the planner output and SQL compilation.
 */

import type {
	ColumnListInput,
	OrderByIntent,
	QueryIntent,
	SelectIntent,
	WhereIntent,
} from '@dbsp/types';
import { isParamIntent } from '@dbsp/types';
import {
	getTrustedNqlRelationFilterFields,
	type Mutable,
} from '@dbsp/types/internal';
import type { PlanDecision } from './compiler.js';
import type { RangeValue } from './handlers/types.js';
import { resolveWhereOperator } from './handlers/where/operator-resolver.js';
import { EXPRESSION_HANDLERS } from './select-expression-handlers.js';

export class UnknownSelectExpressionKindError extends Error {
	readonly code = 'ERR_ADAPTER_UNKNOWN_SELECT_EXPRESSION_KIND';

	constructor(readonly kind: string) {
		super(`Unknown SELECT expression kind: ${kind}`);
		this.name = 'UnknownSelectExpressionKindError';
	}
}

// ============================================================================
// Main Converter
// ============================================================================

/**
 * Convert a QueryIntent into Decision[] for the pgsql compiler.
 *
 * @param intent - The QueryIntent from core's planner
 * @param rootTable - The root table name (from plan.rootTable)
 * @returns Array of decisions the compiler can process
 */
export function intentToDecisions(
	intent: QueryIntent,
	rootTable: string,
): PlanDecision[] {
	const decisions: PlanDecision[] = [];

	// 1. SELECT clause
	if (intent.select) {
		decisions.push(...convertSelect(intent.select, rootTable));
	} else {
		// Default to SELECT *
		decisions.push({ type: 'select', column: '*', table: rootTable });
	}

	// 2. WHERE clause
	if (intent.where) {
		decisions.push(...convertWhere(intent.where, rootTable));
	}

	// 3. ORDER BY clause
	if (intent.orderBy && intent.orderBy.length > 0) {
		for (const order of intent.orderBy) {
			decisions.push(convertOrderBy(order, rootTable));
		}
	}

	// 4. GROUP BY clause
	if (intent.groupBy && intent.groupBy.length > 0) {
		for (const col of intent.groupBy) {
			decisions.push({ type: 'groupBy', column: col, table: rootTable });
		}
	}

	// 5. HAVING clause
	if (intent.having) {
		const havingDecisions = convertWhere(intent.having, rootTable);
		for (const d of havingDecisions) {
			decisions.push({ ...d, type: 'having' });
		}
	}

	// 6. DISTINCT / DISTINCT ON
	if (intent.distinctOn && intent.distinctOn.length > 0) {
		decisions.push({ type: 'distinctOn', columns: intent.distinctOn });
	} else if (intent.distinct) {
		decisions.push({ type: 'distinct' });
	}

	// 7. LIMIT
	if (intent.limit !== undefined) {
		decisions.push({ type: 'limit', limit: intent.limit });
	}

	// 8. OFFSET
	if (intent.offset !== undefined) {
		decisions.push({ type: 'offset', offset: intent.offset });
	}

	return decisions;
}

// ============================================================================
// SELECT Conversion
// ============================================================================

/**
 * Apply a filter condition to a decision if a filter intent is present.
 */
function applyFilterCondition(
	decision: Mutable<PlanDecision>,
	filter: WhereIntent | undefined,
	rootTable: string,
): void {
	if (filter) {
		const filterDecision = convertWhereCondition(filter, rootTable);
		if (filterDecision) decision.filterCondition = filterDecision;
	}
}

function convertSelect(
	select: SelectIntent,
	rootTable: string,
): PlanDecision[] {
	// Handle different SelectIntent types using discriminator
	const selectType = 'type' in select ? select.type : undefined;

	// SelectAllIntent: { all: true }
	if ('all' in select && select.all === true) {
		return [{ type: 'select', column: '*', table: rootTable }];
	}

	// SelectFieldsIntent: { type: 'fields', fields: string[] }
	if (selectType === 'fields' && 'fields' in select) {
		return (select.fields as readonly string[]).map((field) => ({
			type: 'select' as const,
			column: field,
			table: rootTable,
		}));
	}

	// SelectWithExpressionsIntent: { type: 'expressions', columns: ExpressionIntent[] }
	if (selectType === 'expressions' && 'columns' in select) {
		const decisions: PlanDecision[] = [];
		const columns = select.columns as readonly unknown[];

		for (const exprUnknown of columns) {
			const expr = exprUnknown as Record<string, unknown>;
			const kind =
				typeof expr.kind === 'string' ? expr.kind : String(expr.kind);
			const handler = EXPRESSION_HANDLERS[kind];
			if (!handler) {
				throw new UnknownSelectExpressionKindError(kind);
			}
			handler(
				expr,
				rootTable,
				decisions,
				(decision, filter, table) =>
					applyFilterCondition(decision, filter, table),
				(condition, table) => convertWhereCondition(condition, table),
			);
		}

		return decisions;
	}

	if ('aggregates' in select) {
		// SelectAggregateIntent
		const decisions: PlanDecision[] = [];

		// Add non-aggregate fields
		if (select.fields) {
			for (const field of select.fields) {
				decisions.push({ type: 'select', column: field, table: rootTable });
			}
		}

		// Add aggregates
		for (const agg of select.aggregates) {
			const aggDecision: Mutable<PlanDecision> = {
				type: 'selectFunction',
				function:
					agg.function === 'count' && agg.field === '*'
						? 'count'
						: agg.function,
				column: agg.field ?? '*',
				table: rootTable,
			};
			if (agg.as) {
				aggDecision.alias = agg.as;
			}
			if (agg.distinct === true) {
				aggDecision.distinct = true;
			}
			applyFilterCondition(aggDecision, agg.filter, rootTable);
			decisions.push(aggDecision);
		}

		return decisions;
	}

	// Default: SELECT *
	return [{ type: 'select', column: '*', table: rootTable }];
}

// ============================================================================
// WHERE Conversion
// ============================================================================

/**
 * Convert a WhereIntent (kind-discriminated union) into PlanDecisions.
 * WhereIntent uses 'kind' as the discriminator field.
 */
function convertWhere(where: WhereIntent, rootTable: string): PlanDecision[] {
	const decision = convertWhereCondition(where, rootTable);
	return decision ? [decision] : [];
}

/**
 * Convert a single WhereIntent condition to a PlanDecision.
 * Handles the kind-based discriminated union.
 */
/**
 * Flat view of all possible WhereIntent properties.
 * WhereIntent is a discriminated union — each variant contributes a subset.
 * This interface avoids double casts by exposing every variant's fields as optional.
 */
interface FlatWhereFields {
	readonly kind: string;
	readonly field?: string;
	readonly operator?: string;
	readonly value?: unknown;
	readonly values?: readonly unknown[];
	readonly pattern?: string;
	readonly caseInsensitive?: boolean;
	readonly not?: boolean;
	readonly conditions?: readonly WhereIntent[];
	readonly condition?: WhereIntent;
	readonly relation?: string | readonly string[];
	readonly targetTable?: string;
	readonly sourceColumn?: ColumnListInput;
	readonly targetColumn?: ColumnListInput;
	readonly where?: WhereIntent;
	readonly mode?: string;
	readonly subquery?: QueryIntent;
	// Legacy numeric range bounds (not on WhereRangeIntent but produced by NQL)
	readonly gte?: unknown;
	readonly lte?: unknown;
	readonly gt?: unknown;
	readonly lt?: unknown;
	// JSON-related fields
	readonly jsonPath?: readonly string[];
	readonly jsonMode?: string;
	readonly reversed?: boolean;
	readonly key?: string;
	// LIKE escape character
	readonly escape?: string;
	// Custom expression WHERE (kind: 'expression')
	readonly expr?: unknown;
}

// ============================================================================
// Where condition handlers — one per WhereIntent.kind
// ============================================================================

/**
 * Guard: throw a clear error when a subquery (IN or scalar) carries modifiers
 * that the current compilation path silently drops, which would produce SQL
 * that matches MORE rows than the caller intended (silent filter broadening).
 *
 * Per-field classification (QueryIntent):
 *
 * FAITHFULLY COMPILED — leave:
 *   from, where, limit (IN + scalar only), orderBy field-based (IN + scalar)
 *   select.type:'fields' (IN: exactly 1 field; scalar: first field)
 *   select.type:'aggregate' (scalar only — aggregate + selectColumn)
 *
 * PROPAGATE — wired through in convertSubquery:
 *   limit, orderBy (scalar path — previously missing, fixed here)
 *
 * REJECT — throw:
 *   groupBy, having, offset, distinct, distinctOn, include, joins
 *   existsWrap, lock, batchValuesSource — not representable in a subquery context
 *   select.type:'aggregate' on IN path (silently ignored → wrong projection)
 *   select.type:'expressions' on both paths (expressions not emitted)
 *   select.type:'all' on IN path (SELECT * in ANY subquery is invalid SQL)
 *   select:undefined on IN path (must specify exactly one column)
 *   select.type:'fields' with 0 fields on IN path (no column to match against)
 *   orderBy with expression-based entries on both paths (.field is never → undefined)
 *   limit (rawExists path only) — buildSubqueryFromIntent does not emit limitCount
 */
export function assertNoUnsupportedSubqueryModifiers(
	subquery: QueryIntent,
	context: 'IN' | 'scalar' | 'scalar-direct' | 'rawExists',
): void {
	const unsupported: string[] = [];

	// Structural modifiers silently dropped on ALL subquery paths.
	if (subquery.groupBy && subquery.groupBy.length > 0)
		unsupported.push('GROUP BY');
	if (subquery.having) unsupported.push('HAVING');
	if (subquery.offset != null) unsupported.push('OFFSET');
	if (subquery.distinct) unsupported.push('DISTINCT');
	if (subquery.distinctOn && subquery.distinctOn.length > 0)
		unsupported.push('DISTINCT ON');
	if (subquery.include && subquery.include.length > 0)
		unsupported.push('include (relation hydration)');
	if (subquery.joins && subquery.joins.length > 0) unsupported.push('joins');

	// Additional structural modifiers that have no path through buildSubqueryFromIntent.
	if (subquery.existsWrap) unsupported.push('existsWrap');
	if (subquery.lock) unsupported.push('lock');
	if (subquery.batchValuesSource) unsupported.push('batchValuesSource');

	// rawExists and scalar-direct: buildSubqueryFromIntent emits ONLY
	// SELECT/FROM/WHERE — it does NOT emit sortClause or limitCount.
	// The decisions-path scalar context allows limit/orderBy because convertSubquery
	// faithfully propagates them via buildScalarSubquery; the direct path cannot.
	if (context === 'rawExists' || context === 'scalar-direct') {
		if (subquery.limit != null) unsupported.push('LIMIT');
	}

	// rawExists and scalar-direct: buildSubqueryFromIntent also drops orderBy
	// entirely (no sortClause emitted), so both field-based and expression-based
	// ORDER BY produce silently wrong results on the direct path.
	// The decisions-path scalar context allows field-orderBy because that path
	// emits it; the direct path cannot.
	if (context === 'rawExists' || context === 'scalar-direct') {
		if (subquery.orderBy && subquery.orderBy.length > 0) {
			unsupported.push('ORDER BY');
		}
	} else if (subquery.orderBy && subquery.orderBy.length > 0) {
		// On the decisions / IN path: only expression-based orderBy is unsupported
		// (field references are faithfully emitted there).
		const hasExpressionSort = subquery.orderBy.some(
			(o) => !('field' in o) || (o as { field?: unknown }).field == null,
		);
		if (hasExpressionSort)
			unsupported.push(
				'orderBy with expression (only field-based ORDER BY is supported)',
			);
	}

	// IN-subquery-specific SELECT validation
	if (context === 'IN') {
		const select = subquery.select as
			| { type?: string; fields?: readonly string[] }
			| undefined;
		if (!select) {
			// No select clause — would compile to SELECT * which is invalid inside
			// an ANY subquery (PostgreSQL requires a single column expression).
			unsupported.push(
				'missing select (IN subquery must project exactly one named column)',
			);
		} else if (select.type === 'aggregate') {
			// Aggregate SELECT is silently ignored in the IN path (only fields are
			// extracted); use a scalar subquery comparison instead.
			unsupported.push(
				'aggregate SELECT (use a scalar subquery comparison instead)',
			);
		} else if (select.type === 'expressions') {
			// SelectWithExpressionsIntent is not emitted by buildScalarSubquery.
			unsupported.push('expressions SELECT (not supported in IN subquery)');
		} else if (select.type === 'all') {
			// SELECT * inside ANY(...) is rejected by PostgreSQL (cannot compare
			// a row value to a scalar lhs).
			unsupported.push(
				'SELECT * / all (IN subquery must project exactly one named column)',
			);
		} else if (
			select.type === 'fields' ||
			Array.isArray(select.fields) ||
			// Also catch the typeless `{ fields: undefined | null }` shape: the
			// `fields` key is present (triggering isSelectWithFields in the compiler)
			// but the value is not a non-empty array.  Without this branch,
			// `{ fields: undefined }` falls through all checks and the compiler
			// silently falls back to SELECT *, producing wrong SQL.
			// Guard: `in` operator crashes on primitives; a string select like 'id'
			// is a valid single-column selector — only check for the `fields` key on
			// actual objects.
			(typeof select === 'object' &&
				select !== null &&
				'fields' in (select as object))
		) {
			// Both the typed shape `{ type: 'fields', fields: [...] }` and the
			// typeless shape `{ fields: [...] }` (no `type` property) are accepted
			// by the compiler via `isSelectWithFields`.  The guard must cover both
			// so that a typeless multi-field select (or a typeless select with
			// undefined/empty fields) is caught here rather than silently falling
			// back to SELECT * in the compiler.
			if (!select.fields || select.fields.length === 0) {
				// undefined, null, or empty fields list falls back to '*' in the
				// compiler — same problem as 'all'.
				unsupported.push(
					'empty fields list (IN subquery must project exactly one named column)',
				);
			} else if (select.fields.length > 1) {
				// Multi-field projection is silently truncated to fields[0] — the
				// extra columns are dropped without error, producing incorrect SQL
				// (the IN matches only the first column, silently ignoring the rest).
				unsupported.push(
					`multi-field projection [${select.fields.join(', ')}] (IN subquery must project exactly one named column — use a single field)`,
				);
			} else if (typeof select.fields[0] !== 'string') {
				// A single-element fields array whose element is not a string (e.g.
				// an object, number, or null) bypasses the length checks above and
				// produces `selectColumn = <object>` after lowering — which compiles
				// as a broken column reference or falls back to SELECT *.
				// Explicitly reject any non-string element so the caller gets a clear
				// error instead of invalid SQL.
				unsupported.push(
					`non-string field element ${JSON.stringify(select.fields[0])} (IN subquery fields must contain a plain column name string)`,
				);
			}
		}
	}

	// Scalar SELECT validation — applies to both the decisions path ('scalar') and
	// the direct compile-where path ('scalar-direct').  buildSubqueryFromIntent
	// (used by the direct path) emits only fields[0] from a multi-field list,
	// silently truncating the projection; expressions SELECT is not emitted at all.
	// 'scalar-direct' must be at least as strict as 'scalar' on projection checks.
	const isScalarContext = context === 'scalar' || context === 'scalar-direct';
	if (isScalarContext) {
		const select = subquery.select as
			| {
					type?: string;
					fields?: readonly string[];
					aggregates?: readonly unknown[];
			  }
			| undefined;
		if (select?.type === 'expressions') {
			// SelectWithExpressionsIntent is not emitted by buildScalarSubquery or
			// buildSubqueryFromIntent — dropped on both scalar paths.
			unsupported.push('expressions SELECT (not supported in scalar subquery)');
		} else if (
			select?.type === 'fields' &&
			select.fields != null &&
			select.fields.length > 1
		) {
			// Multi-field projection is silently truncated to fields[0] —
			// the extra columns are dropped without error, producing incorrect SQL
			// (the scalar comparison uses only the first column).
			unsupported.push(
				`multi-field projection [${select.fields.join(', ')}] (scalar subquery must project exactly one column — use a single field)`,
			);
		} else if (
			select?.type === 'aggregate' &&
			select.aggregates != null &&
			select.aggregates.length > 1
		) {
			// DEFECT 3 FIX: a scalar subquery must project exactly ONE column.
			// The decisions path takes only aggregates[0] — extra aggregates are
			// silently dropped. The direct compile-where path (buildSubqueryFromIntent)
			// emits ALL aggregates as separate ResTarget nodes, producing a multi-column
			// scalar subquery that PostgreSQL rejects at runtime.
			// Reject early on both paths so callers get a clear error.
			unsupported.push(
				`multi-aggregate projection (scalar subquery must project exactly one column — use a single aggregate)`,
			);
		}
	}

	if (unsupported.length > 0) {
		const label =
			context === 'IN'
				? 'IN'
				: context === 'rawExists'
					? 'rawExists'
					: 'scalar';
		throw new Error(
			`${label} subquery with ${unsupported.join(', ')} is not supported — ` +
				'it would silently change which rows match; restructure the query or use a CTE.',
		);
	}
}

/**
 * Type predicate for a genuine `outerRef()` node.
 *
 * `SubqueryRefIntent` (kind:'ref', column) and `RefExpressionIntent`
 * (kind:'ref', column) are structurally identical.  `outerRef()` adds an
 * `outer: true` discriminator so we can distinguish the two without touching
 * the @dbsp/types package.  `isSubqueryRef` cannot be used here because it
 * only checks `kind === 'ref'` — matching inner `ref()` nodes too.
 *
 * @internal — exported for use in plan-decision-extractor.ts only.
 */
export function isOuterRef(value: unknown): boolean {
	if (typeof value !== 'object' || value === null) return false;
	const v = value as Record<string, unknown>;
	return v.kind === 'ref' && v.outer === true;
}

/**
 * Recursively walk a WhereIntent looking for a genuine `outerRef()` node
 * (discriminated by `{ kind: 'ref', outer: true }` — set by `outerRef()` in
 * subquery-builder.ts).  Used to detect correlated subqueries inside
 * rawExists/rawNotExists, which the current pipeline does not support — we
 * throw rather than emit broken SQL.
 *
 * NOTE: we do NOT use `isSubqueryRef` here because that predicate only checks
 * `kind === 'ref'`, which also matches inner `ref()` column references
 * (RefExpressionIntent) used in expression-based WHERE conditions such as
 * `ref('a').gt(ref('b'))`.  Those inner refs must NOT trigger the correlated
 * subquery guard.
 */
export function containsOuterRef(where: unknown): boolean {
	if (!where || typeof where !== 'object') return false;
	const w = where as Record<string, unknown>;
	if (isParamIntent(w)) return false;
	if (isOuterRef(w)) return true;
	for (const value of Object.values(w)) {
		if (Array.isArray(value)) {
			for (let i = 0; i < value.length; i++) {
				const item = value[i];
				if (containsOuterRef(item)) return true;
			}
		} else if (typeof value === 'object' && value !== null) {
			if (containsOuterRef(value)) return true;
		}
	}
	return false;
}

/** Handle kind: 'comparison' — field OP value */
function convertComparison(
	cond: FlatWhereFields,
	rootTable: string,
): PlanDecision {
	const rawValue = cond.value;
	// Convert a genuine outerRef() node { kind: 'ref', outer: true, column } to a
	// FieldRef so that compileValueOrFieldRef() treats it as a column reference,
	// not a parameter.  We use isOuterRef() (checks outer:true) rather than
	// isSubqueryRef() (only checks kind:'ref') so that an ExpressionRef.intent
	// like { kind: 'ref', column } from ref() is NOT misidentified as an outer
	// reference.
	const resolvedValue = isOuterRef(rawValue)
		? {
				kind: 'fieldRef' as const,
				scope: 'outer' as const,
				column: (rawValue as { column: string }).column,
			}
		: rawValue;
	const result: Mutable<PlanDecision> = {
		type: 'where',
		column: cond.field as string,
		operator: cond.operator as string,
		value: resolvedValue,
		table: rootTable,
	};
	if (cond.jsonPath) result.jsonPath = cond.jsonPath;
	if (cond.jsonMode) result.jsonMode = cond.jsonMode as 'json' | 'text';
	return result;
}

/** Handle kind: 'like' — field LIKE/ILIKE pattern */
function convertLike(cond: FlatWhereFields, rootTable: string): PlanDecision {
	const result: Mutable<PlanDecision> = {
		type: 'where',
		column: cond.field as string,
		operator: cond.caseInsensitive ? 'ilike' : 'like',
		value: cond.pattern,
		table: rootTable,
	};
	if (cond.escape !== undefined) result.escape = cond.escape;
	return result;
}

/** Handle kind: 'in' — field IN (values) or field IN (subquery) */
function convertIn(cond: FlatWhereFields, rootTable: string): PlanDecision {
	const rawSubquery = cond.subquery;

	// When a subquery is present, build the inSubquery Decision shape directly.
	// We cannot rely on normalizeToDecision's `case 'in'` branch because that
	// function short-circuits via early-return when `column` is already set.
	if (rawSubquery) {
		// Early validation at lowering time (defense-in-depth before emission chokepoint).
		assertNoUnsupportedSubqueryModifiers(rawSubquery, 'IN');
		const selectField = rawSubquery.select;
		const selectColumn: string =
			selectField &&
			'fields' in selectField &&
			Array.isArray(selectField.fields)
				? (selectField.fields[0] ?? '*')
				: '*';
		const subConditions = rawSubquery.where
			? (() => {
					const converted = convertWhereCondition(
						rawSubquery.where!,
						rawSubquery.from,
					);
					return converted ? [converted] : [];
				})()
			: [];
		// Propagate limit and orderBy from QueryIntent (e.g. from NQL `| limit N | order by col`).
		// PlanDecision.orderBy entries use { field, direction: 'asc'|'desc' } (lowercase).
		// mapToHandlerDecision converts field → column and uppercases direction for handlers.
		const rawLimit = rawSubquery.limit;
		const rawOrderBy = rawSubquery.orderBy as
			| readonly { field: string; direction?: string }[]
			| undefined;
		return {
			type: 'where',
			column: cond.field as string,
			operator: cond.not ? 'notInSubquery' : 'inSubquery',
			targetTable: rawSubquery.from,
			selectColumn,
			conditions: subConditions,
			table: rootTable,
			// Provenance: original QueryIntent for validation in buildPredicateSubquerySelect
			subqueryIntent: rawSubquery,
			...(rawLimit != null && { limit: rawLimit }),
			...(rawOrderBy && {
				orderBy: rawOrderBy.map((o) => ({
					field: o.field,
					direction: (o.direction?.toLowerCase() ?? 'asc') as 'asc' | 'desc',
				})),
			}),
		} as unknown as PlanDecision;
	}

	return {
		type: 'where',
		column: cond.field as string,
		operator: cond.not ? 'notIn' : 'in',
		value: cond.values,
		table: rootTable,
	};
}

/** Handle kind: 'null' — IS NULL / IS NOT NULL */
function convertNull(cond: FlatWhereFields, rootTable: string): PlanDecision {
	return {
		type: 'where',
		column: cond.field as string,
		operator: cond.operator as string,
		table: rootTable,
	};
}

/** Handle kind: 'range' — BETWEEN, gte/lte/gt/lt, or PG range operators (@>, <@, &&) */
function convertRange(
	cond: FlatWhereFields,
	rootTable: string,
): PlanDecision | null {
	const rangeOperator = cond.operator as string | undefined;
	const col = cond.field as string;

	// PostgreSQL range type operators: @>, <@, &&
	if (
		rangeOperator === 'contains' ||
		rangeOperator === 'containedBy' ||
		rangeOperator === 'overlaps'
	) {
		return {
			type: 'where',
			column: col,
			operator: rangeOperator,
			value: cond.value,
			table: rootTable,
		};
	}

	// NQL BETWEEN: { operator: 'between', value: { lower, upper } }
	if (rangeOperator === 'between') {
		const rangeVal = cond.value as RangeValue;
		return {
			type: 'where',
			column: col,
			operator: 'between',
			value: [rangeVal.lower, rangeVal.upper],
			table: rootTable,
		};
	}

	// Numeric bounds — convert to BETWEEN or single-side comparison
	if (cond.gte !== undefined && cond.lte !== undefined) {
		return {
			type: 'where',
			column: col,
			operator: 'between',
			value: [cond.gte, cond.lte],
			table: rootTable,
		};
	}
	if (cond.gte !== undefined) {
		return {
			type: 'where',
			column: col,
			operator: 'gte',
			value: cond.gte,
			table: rootTable,
		};
	}
	if (cond.gt !== undefined) {
		return {
			type: 'where',
			column: col,
			operator: 'gt',
			value: cond.gt,
			table: rootTable,
		};
	}
	if (cond.lte !== undefined) {
		return {
			type: 'where',
			column: col,
			operator: 'lte',
			value: cond.lte,
			table: rootTable,
		};
	}
	if (cond.lt !== undefined) {
		return {
			type: 'where',
			column: col,
			operator: 'lt',
			value: cond.lt,
			table: rootTable,
		};
	}
	return null;
}

/** Handle kind: 'and' | 'or' — logical group of sub-conditions */
function convertLogicalGroup(
	cond: FlatWhereFields,
	rootTable: string,
	decisionType: 'whereAnd' | 'whereOr',
): PlanDecision | null {
	const subDecisions: PlanDecision[] = [];
	for (const sub of cond.conditions as WhereIntent[]) {
		const subDecision = convertWhereCondition(sub, rootTable);
		if (subDecision) subDecisions.push(subDecision);
	}
	if (subDecisions.length === 0) return null;
	return { type: decisionType, conditions: subDecisions };
}

/** Handle kind: 'not' — NOT (condition) */
function convertNot(
	cond: FlatWhereFields,
	rootTable: string,
): PlanDecision | null {
	const subDecision = convertWhereCondition(
		cond.condition as WhereIntent,
		rootTable,
	);
	if (!subDecision) return null;
	return { type: 'whereNot', conditions: [subDecision] };
}

function formatRelationName(relation: string | readonly string[]): string {
	return typeof relation === 'string' ? relation : relation.join('.');
}

/** Handle kind: 'exists' | 'notExists' | 'relationFilter' — correlated EXISTS / NOT EXISTS / EVERY */
function convertExistsLike(
	cond: FlatWhereFields,
	operator: 'exists' | 'notExists' | 'every',
): PlanDecision {
	const rawRelation = cond.relation as string | readonly string[];
	const preResolved = getTrustedNqlRelationFilterFields(cond);
	const trustedRelation = preResolved?.relation;
	const relationName =
		trustedRelation !== undefined
			? formatRelationName(trustedRelation)
			: formatRelationName(rawRelation);
	const targetTable = preResolved?.targetTable ?? rawRelation;
	// For 'every', pass the raw conditions un-negated — everyHandler wraps them in
	// NOT internally.  When conditions is empty/undefined, everyHandler returns the
	// vacuous-true literal (TRUE) instead of emitting a subquery.
	const subDecisions: PlanDecision[] = cond.where
		? convertWhere(cond.where as WhereIntent, targetTable as string)
		: [];
	const isPreResolved = preResolved !== undefined;
	const base: PlanDecision = {
		type: 'where',
		operator,
		targetTable: targetTable as string,
		...(preResolved !== undefined && {
			sourceColumn: preResolved.sourceColumn,
		}),
		...(preResolved !== undefined && {
			targetColumn: preResolved.targetColumn,
		}),
		...(isPreResolved && { relationName }),
	};
	return subDecisions.length > 0 ? { ...base, conditions: subDecisions } : base;
}

/** Handle kind: 'subquery' — field OP (SELECT col FROM table WHERE ...) */
function convertSubquery(cond: FlatWhereFields): PlanDecision | null {
	const field = cond.field as string;
	const operator = cond.operator as string;
	const subquery = cond.subquery as QueryIntent | undefined;
	if (!subquery || !field) return null;

	// Early validation at lowering time (defense-in-depth before emission chokepoint).
	assertNoUnsupportedSubqueryModifiers(subquery, 'scalar');

	// DEFECT 2 FIX (decisions path): detect outerRef() inside a scalar subquery's WHERE.
	// Correlated scalar subqueries are not yet supported — the decisions path lowers the
	// inner WHERE to Decision[] without forwarding the outer alias, so outerRef() nodes
	// bind to the inner alias instead of the outer query, producing wrong SQL silently.
	// Throw here (before emitting the decision) instead of producing broken SQL.
	if (subquery.where && containsOuterRef(subquery.where)) {
		throw new Error(
			'scalar subquery with correlated outerRef() is not yet supported — ' +
				'use exists("relation", { where: ... }) when a schema relation exists, ' +
				'or restructure the query to avoid the correlation.',
		);
	}

	const targetTable = subquery.from;
	let selectColumn = '*';
	let aggregate: string | undefined;
	let aggregateDistinct: boolean | undefined;

	const select = subquery.select as SelectIntent | undefined;
	if (select) {
		if ('type' in select && select.type === 'aggregate') {
			const agg = select.aggregates?.[0];
			if (agg) {
				aggregate = agg.function;
				selectColumn = agg.field ?? '*';
				aggregateDistinct = agg.distinct === true ? true : undefined;
			}
		} else if ('fields' in select && select.fields?.length) {
			selectColumn = select.fields[0]!;
		}
	}

	const subConditions: PlanDecision[] = [];
	if (subquery.where) {
		const innerWhere = convertWhereCondition(
			subquery.where as WhereIntent,
			targetTable,
		);
		if (innerWhere) subConditions.push(innerWhere);
	}

	// Propagate limit and orderBy into the decision so buildScalarSubquery emits them.
	// (Previously these were silently dropped from scalar subqueries.)
	// PlanDecision.orderBy entries use { field, direction: 'asc'|'desc' } (lowercase).
	// mapToHandlerDecision converts field → column and uppercases direction for handlers.
	const rawLimit = subquery.limit;
	const rawOrderBy = subquery.orderBy as
		| readonly { field: string; direction?: string }[]
		| undefined;

	const opMap: Record<string, string> = {
		eq: '=',
		neq: '!=',
		isDistinctFrom: 'isDistinctFrom',
		gt: '>',
		gte: '>=',
		lt: '<',
		lte: '<=',
	};
	const subqueryOperator = resolveWhereOperator(operator, opMap);
	return {
		type: 'where',
		column: field,
		operator: 'scalarSubquery',
		targetTable,
		selectColumn,
		subqueryOperator,
		// Provenance: original QueryIntent for validation in buildPredicateSubquerySelect
		subqueryIntent: subquery,
		...(aggregate && { aggregate }),
		...(aggregateDistinct && { aggregateDistinct }),
		...(subConditions.length > 0 && { conditions: subConditions }),
		...(rawLimit != null && { limit: rawLimit }),
		...(rawOrderBy &&
			rawOrderBy.length > 0 && {
				orderBy: rawOrderBy.map((o) => ({
					field: o.field,
					direction: (o.direction?.toLowerCase() ?? 'asc') as 'asc' | 'desc',
				})),
			}),
	} as unknown as PlanDecision;
}

// ============================================================================
// Main dispatcher — routes each WhereIntent.kind to its dedicated handler
// ============================================================================

export function convertWhereCondition(
	condition: WhereIntent,
	rootTable: string,
): PlanDecision | null {
	const cond = condition as FlatWhereFields;

	switch (cond.kind) {
		case 'comparison':
			return convertComparison(cond, rootTable);
		case 'like':
			return convertLike(cond, rootTable);
		case 'in':
			return convertIn(cond, rootTable);
		case 'null':
			return convertNull(cond, rootTable);
		case 'range':
			return convertRange(cond, rootTable);
		case 'and':
			return convertLogicalGroup(cond, rootTable, 'whereAnd');
		case 'or':
			return convertLogicalGroup(cond, rootTable, 'whereOr');
		case 'not':
			return convertNot(cond, rootTable);
		case 'exists':
			return convertExistsLike(cond, 'exists');
		case 'notExists':
			return convertExistsLike(cond, 'notExists');
		case 'relationFilter': {
			const mode = (cond.mode as string) || 'some';
			// mode:'every' must route to everyHandler (NOT EXISTS WHERE NOT cond).
			// Passing 'exists' here was Bug #1 — it silently dropped the universal-
			// quantifier semantics and routed to the plain EXISTS handler instead.
			const operator =
				mode === 'none'
					? ('notExists' as const)
					: mode === 'every'
						? ('every' as const)
						: ('exists' as const);
			return convertExistsLike(cond, operator);
		}
		case 'subquery':
			return convertSubquery(cond);
		case 'rawExists':
		case 'rawNotExists': {
			const sub = (cond as unknown as { subquery: QueryIntent | undefined })
				.subquery;
			if (!sub) {
				// Defensive: malformed intent (rawExists called without a subquery).
				// Returning null causes the WHERE filter to be dropped — same as any
				// other unrecognized kind. Better to fail loudly so the bug surfaces.
				throw new Error(
					`${cond.kind}: missing subquery — pass the result of subquery(table).select(...) or a builder with buildIntent()`,
				);
			}
			// Early validation at lowering time (defense-in-depth before emission chokepoint).
			assertNoUnsupportedSubqueryModifiers(sub, 'rawExists');
			// Correlated subqueries (outerRef inside the inner WHERE) are NOT yet
			// supported on the rawExists/rawNotExists path.
			if (sub.where && containsOuterRef(sub.where)) {
				throw new Error(
					`${cond.kind}: correlated subqueries (outerRef inside the inner WHERE) are not yet supported. ` +
						'Workaround: use exists("relation", { where: ... }) when a schema relation exists, or wait for the rawExists correlation pipeline (tracked in TODO).',
				);
			}
			return {
				type: 'where',
				operator: cond.kind,
				// Reuse expressionIntent (already present on PlanDecision) to carry the
				// inner QueryIntent; the rawExistsHandler discriminates by operator name.
				expressionIntent: sub,
				table: rootTable,
			};
		}
		case 'jsonContains': {
			return {
				type: 'where',
				column: cond.field as string,
				operator: cond.reversed ? 'jsonContainedBy' : 'jsonContains',
				value: cond.value,
				table: rootTable,
			};
		}
		case 'any':
			return {
				type: 'where',
				column: cond.field as string,
				operator: 'any',
				values: cond.values as readonly unknown[],
				table: rootTable,
			};
		case 'jsonExists':
			return {
				type: 'where',
				column: cond.field as string,
				operator: 'jsonExists',
				value: cond.key,
				table: rootTable,
			};
		case 'expression':
			return {
				type: 'where',
				operator: 'expression',
				expressionIntent: cond.expr,
				value: cond.value,
				subqueryOperator: cond.operator as string,
				table: rootTable,
			};
		default:
			return null;
	}
}

// ============================================================================
// ORDER BY Conversion
// ============================================================================

function convertOrderBy(order: OrderByIntent, rootTable: string): PlanDecision {
	// Convert lowercase direction to uppercase
	const direction: 'ASC' | 'DESC' = order.direction === 'desc' ? 'DESC' : 'ASC';

	// Convert lowercase nulls to uppercase if present
	const nulls: 'FIRST' | 'LAST' | undefined = order.nulls
		? order.nulls === 'first'
			? 'FIRST'
			: 'LAST'
		: undefined;

	// Expression-based ORDER BY (e.g. rawDistance('vector', qv))
	if (order.expression) {
		const base: PlanDecision = {
			type: 'orderBy',
			expressionIntent: order.expression,
			direction,
			table: rootTable,
		};
		if (nulls) {
			return { ...base, nulls };
		}
		return base;
	}

	const decision: PlanDecision = {
		type: 'orderBy',
		direction,
		table: rootTable,
		// field is optional in OrderByIntent after expression extension (exactOptionalPropertyTypes)
		...(order.field ? { column: order.field } : {}),
	};

	// Only add nulls if defined (exactOptionalPropertyTypes)
	if (nulls) {
		return { ...decision, nulls };
	}

	return decision;
}

// ============================================================================
// CASE expression helpers
// ============================================================================

/**
 * Convert a CASE WHEN condition (ExpressionIntent) to a PlanDecision
 * that compileCondition can handle.
 */
