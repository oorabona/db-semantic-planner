/**
 * Intent to Decisions Converter
 *
 * Converts core's QueryIntent into Decision[] format for the pgsql compiler.
 * This bridges the gap between the planner output and SQL compilation.
 */

import type {
	OrderByIntent,
	QueryIntent,
	SelectIntent,
	WhereIntent,
} from '@dbsp/types';
import { isSubqueryRef } from '@dbsp/types';
import type { Mutable } from '@dbsp/types/internal';
import type { PlanDecision } from './compiler.js';
import type { RangeValue } from './handlers/types.js';
import { EXPRESSION_HANDLERS } from './select-expression-handlers.js';

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
			const handler = EXPRESSION_HANDLERS[expr.kind as string];
			if (handler) {
				handler(
					expr,
					rootTable,
					decisions,
					applyFilterCondition,
					convertWhereCondition,
				);
			}
			// else: unknown kind (e.g., pseudoColumn) — intentional no-op
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
	readonly relation?: string;
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
function assertNoUnsupportedSubqueryModifiers(
	subquery: QueryIntent,
	context: 'IN' | 'scalar' | 'rawExists',
): void {
	const unsupported: string[] = [];

	// Structural modifiers already guarded in the previous pass
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

	// Additional structural modifiers that have no path through buildScalarSubquery
	if (subquery.existsWrap) unsupported.push('existsWrap');
	if (subquery.lock) unsupported.push('lock');
	if (subquery.batchValuesSource) unsupported.push('batchValuesSource');

	// rawExists-specific: buildSubqueryFromIntent does not emit LIMIT (unlike
	// scalar subqueries where limit IS propagated).  A rawExists(subquery.limit(0))
	// silently compiles as an unrestricted existence check — producing a result
	// broader than the caller intended (limit(0) should always be FALSE).
	if (context === 'rawExists') {
		if (subquery.limit != null) unsupported.push('LIMIT');
	}

	// Expression-based orderBy entries: OrderByExpressionIntent has field:never,
	// so convertIn's `o.field` yields undefined → columnRef(undefined,...) produces
	// broken SQL. Reject whenever any entry uses an expression.
	if (subquery.orderBy && subquery.orderBy.length > 0) {
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
		} else if (select.type === 'fields') {
			if (!select.fields || select.fields.length === 0) {
				// Empty fields list falls back to '*' — same problem as 'all'.
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
			}
		}
	}

	// Scalar-subquery-specific SELECT validation
	if (context === 'scalar') {
		const select = subquery.select as
			| { type?: string; fields?: readonly string[] }
			| undefined;
		if (select?.type === 'expressions') {
			// SelectWithExpressionsIntent is not emitted by buildScalarSubquery.
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
 * Recursively walk a WhereIntent looking for a SubqueryRefIntent
 * (`{ kind: 'ref', column }` produced by `outerRef()`). Used to detect
 * correlated subqueries inside rawExists/rawNotExists, which the current
 * pipeline does not support — we throw rather than emit broken SQL.
 */
function containsOuterRef(where: unknown): boolean {
	if (!where || typeof where !== 'object') return false;
	const w = where as Record<string, unknown>;
	if (isSubqueryRef(w)) return true;
	for (const value of Object.values(w)) {
		if (Array.isArray(value)) {
			for (const item of value) {
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
	// Convert SubqueryRefIntent { kind: 'ref', column } to FieldRef so that
	// compileValueOrFieldRef() treats it as a column reference, not a parameter.
	const resolvedValue = isSubqueryRef(rawValue)
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

/** Handle kind: 'exists' | 'notExists' | 'relationFilter' — correlated EXISTS / NOT EXISTS */
function convertExistsLike(
	cond: FlatWhereFields,
	operator: 'exists' | 'notExists',
): PlanDecision {
	const targetTable = cond.relation as string;
	const subDecisions: PlanDecision[] = cond.where
		? convertWhere(cond.where as WhereIntent, targetTable)
		: [];
	const base: PlanDecision = { type: 'where', operator, targetTable };
	return subDecisions.length > 0 ? { ...base, conditions: subDecisions } : base;
}

/** Handle kind: 'subquery' — field OP (SELECT col FROM table WHERE ...) */
function convertSubquery(cond: FlatWhereFields): PlanDecision | null {
	const field = cond.field as string;
	const operator = cond.operator as string;
	const subquery = cond.subquery as QueryIntent | undefined;
	if (!subquery || !field) return null;

	assertNoUnsupportedSubqueryModifiers(subquery, 'scalar');

	const targetTable = subquery.from;
	let selectColumn = '*';
	let aggregate: string | undefined;

	const select = subquery.select as SelectIntent | undefined;
	if (select) {
		if ('type' in select && select.type === 'aggregate') {
			const agg = select.aggregates?.[0];
			if (agg) {
				aggregate = agg.function;
				selectColumn = agg.field ?? '*';
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
		gt: '>',
		gte: '>=',
		lt: '<',
		lte: '<=',
	};
	return {
		type: 'where',
		column: field,
		operator: 'scalarSubquery',
		targetTable,
		selectColumn,
		subqueryOperator: opMap[operator] ?? '=',
		...(aggregate && { aggregate }),
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
			return convertExistsLike(cond, mode === 'none' ? 'notExists' : 'exists');
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
			// Guard: reject subquery modifiers that buildSubqueryFromIntent silently
			// drops — limit, offset, groupBy, having, joins, include, distinct,
			// distinctOn are not emitted by buildSubqueryFromIntent (it only emits
			// from/select/where).  Silently dropping them changes which rows match
			// (e.g. rawExists(subquery.limit(0)) must always be FALSE but without the
			// guard compiles as an unrestricted existence check — silent broadening).
			assertNoUnsupportedSubqueryModifiers(sub, 'rawExists');
			// Correlated subqueries (outerRef inside the inner WHERE) are NOT yet
			// supported on the rawExists/rawNotExists path: buildSubqueryFromIntent
			// builds a fresh WhereCompilerCtx with no outerAlias, so SubqueryRefIntent
			// values fall back to being parameterized as $N (an object literal!) which
			// produces wrong SQL at best and a runtime error at worst. Detect this
			// case at decision-time and throw a clear "not yet supported" error so
			// callers don't get silently-broken queries.
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
		case 'jsonContains':
			return {
				type: 'where',
				column: cond.field as string,
				operator: cond.reversed ? 'jsonContainedBy' : 'jsonContains',
				value: cond.value,
				table: rootTable,
			};
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
