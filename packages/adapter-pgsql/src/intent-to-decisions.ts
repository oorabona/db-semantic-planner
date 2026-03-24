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
/** @deprecated Use compileWhereIntent instead */
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
/** @deprecated Use compileWhereIntent instead */
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

/** @deprecated Use compileWhereIntent instead */
export function convertWhereCondition(
	condition: WhereIntent,
	rootTable: string,
): PlanDecision | null {
	const cond = condition as FlatWhereFields;
	const kind = cond.kind;

	switch (kind) {
		// Comparison: { kind: 'comparison', field: 'name', operator: 'eq', value: 'John' }
		case 'comparison': {
			// Convert SubqueryRefIntent { kind: 'ref', column } to FieldRef { kind: 'fieldRef', scope: 'outer', column }
			// so that compileValueOrFieldRef() treats it as a column reference, not a parameter.
			const rawValue = cond.value;
			const resolvedValue = isSubqueryRef(rawValue)
				? { kind: 'fieldRef' as const, scope: 'outer' as const, column: rawValue.column }
				: rawValue;
			const result: Mutable<PlanDecision> = {
				type: 'where',
				column: cond.field as string,
				operator: cond.operator as string,
				value: resolvedValue,
				table: rootTable,
			};
			// Propagate JSON access metadata
			if (cond.jsonPath) result.jsonPath = cond.jsonPath;
			if (cond.jsonMode) result.jsonMode = cond.jsonMode as 'json' | 'text';
			return result;
		}

		// LIKE: { kind: 'like', field: 'name', pattern: '%john%' }
		case 'like': {
			const likeDecision: Mutable<PlanDecision> = {
				type: 'where',
				column: cond.field as string,
				operator: cond.caseInsensitive ? 'ilike' : 'like',
				value: cond.pattern,
				table: rootTable,
			};
			if (cond.escape !== undefined) {
				likeDecision.escape = cond.escape;
			}
			return likeDecision;
		}

		// IN: { kind: 'in', field: 'id', values: [1, 2, 3] } or { kind: 'in', field: 'id', subquery: {...} }
		case 'in': {
			const rawSubquery = cond.subquery;
			const result: Mutable<PlanDecision> = {
				type: 'where',
				column: cond.field as string,
				operator: cond.not ? 'notIn' : 'in',
				value: rawSubquery ? undefined : cond.values,
				table: rootTable,
			};
			if (rawSubquery) {
				// Convert subquery's inner where from WhereIntent → PlanDecision
				const convertedSubquery: Record<string, unknown> = {
					...rawSubquery,
				};
				if (rawSubquery.where) {
					const innerWhere = convertWhereCondition(
						rawSubquery.where,
						rawSubquery.from,
					);
					if (innerWhere) {
						convertedSubquery.where = innerWhere;
					}
				}
				result.subquery = convertedSubquery as NonNullable<
					PlanDecision['subquery']
				>;
			}
			return result;
		}

		// NULL: { kind: 'null', field: 'deleted_at', operator: 'isNull' | 'isNotNull' }
		case 'null':
			return {
				type: 'where',
				column: cond.field as string,
				operator: cond.operator as string, // 'isNull' or 'isNotNull'
				table: rootTable,
			};

		// Range: { kind: 'range', field: 'age', gte: 18, lte: 65 }
		// Also handles PostgreSQL range operators: contains (@>), containedBy (<@), overlaps (&&)
		case 'range': {
			// Check for PostgreSQL range operators first
			const rangeOperator = cond.operator as string | undefined;
			if (
				rangeOperator === 'contains' ||
				rangeOperator === 'containedBy' ||
				rangeOperator === 'overlaps'
			) {
				return {
					type: 'where',
					column: cond.field as string,
					operator: rangeOperator,
					value: cond.value,
					table: rootTable,
				};
			}

			// NQL BETWEEN produces { operator: 'between', value: { lower, upper } }
			if (rangeOperator === 'between') {
				const rangeVal = cond.value as RangeValue;
				return {
					type: 'where',
					column: cond.field as string,
					operator: 'between',
					value: [rangeVal.lower, rangeVal.upper],
					table: rootTable,
				};
			}

			// Convert numeric range to a comparison or between
			if (cond.gte !== undefined && cond.lte !== undefined) {
				return {
					type: 'where',
					column: cond.field as string,
					operator: 'between',
					value: [cond.gte, cond.lte],
					table: rootTable,
				};
			} else if (cond.gte !== undefined) {
				return {
					type: 'where',
					column: cond.field as string,
					operator: 'gte',
					value: cond.gte,
					table: rootTable,
				};
			} else if (cond.gt !== undefined) {
				return {
					type: 'where',
					column: cond.field as string,
					operator: 'gt',
					value: cond.gt,
					table: rootTable,
				};
			} else if (cond.lte !== undefined) {
				return {
					type: 'where',
					column: cond.field as string,
					operator: 'lte',
					value: cond.lte,
					table: rootTable,
				};
			} else if (cond.lt !== undefined) {
				return {
					type: 'where',
					column: cond.field as string,
					operator: 'lt',
					value: cond.lt,
					table: rootTable,
				};
			}
			return null;
		}

		// AND: { kind: 'and', conditions: [...] }
		case 'and': {
			const conditions = cond.conditions as WhereIntent[];
			const subDecisions: PlanDecision[] = [];
			for (const sub of conditions) {
				const subDecision = convertWhereCondition(sub, rootTable);
				if (subDecision) {
					subDecisions.push(subDecision);
				}
			}
			if (subDecisions.length > 0) {
				return {
					type: 'whereAnd',
					conditions: subDecisions,
				};
			}
			return null;
		}

		// OR: { kind: 'or', conditions: [...] }
		case 'or': {
			const conditions = cond.conditions as WhereIntent[];
			const subDecisions: PlanDecision[] = [];
			for (const sub of conditions) {
				const subDecision = convertWhereCondition(sub, rootTable);
				if (subDecision) {
					subDecisions.push(subDecision);
				}
			}
			if (subDecisions.length > 0) {
				return {
					type: 'whereOr',
					conditions: subDecisions,
				};
			}
			return null;
		}

		// NOT: { kind: 'not', condition: ... }
		case 'not': {
			const subDecision = convertWhereCondition(
				cond.condition as WhereIntent,
				rootTable,
			);
			if (subDecision) {
				return {
					type: 'whereNot',
					conditions: [subDecision],
				};
			}
			return null;
		}

		// EXISTS: { kind: 'exists', relation: 'posts', where?: ... }
		case 'exists': {
			const subDecisions: PlanDecision[] = [];
			const targetTable = cond.relation as string;

			if (cond.where) {
				subDecisions.push(
					...convertWhere(cond.where as WhereIntent, targetTable),
				);
			}

			const result: PlanDecision = {
				type: 'where',
				operator: 'exists',
				targetTable,
			};
			if (subDecisions.length > 0) {
				return { ...result, conditions: subDecisions };
			}
			return result;
		}

		// NOT EXISTS: { kind: 'notExists', relation: 'posts', where?: ... }
		case 'notExists': {
			const subDecisions: PlanDecision[] = [];
			const targetTable = cond.relation as string;

			if (cond.where) {
				subDecisions.push(
					...convertWhere(cond.where as WhereIntent, targetTable),
				);
			}

			const result: PlanDecision = {
				type: 'where',
				operator: 'notExists',
				targetTable,
			};
			if (subDecisions.length > 0) {
				return { ...result, conditions: subDecisions };
			}
			return result;
		}

		// Relation filter: { kind: 'relationFilter', relation: 'posts', where: ..., mode: 'some' }
		case 'relationFilter': {
			const targetTable = cond.relation as string;
			const mode = (cond.mode as string) || 'some';
			const subDecisions: PlanDecision[] = [];

			if (cond.where) {
				subDecisions.push(
					...convertWhere(cond.where as WhereIntent, targetTable),
				);
			}

			// Relation filter is typically converted to EXISTS/NOT EXISTS
			const result: PlanDecision = {
				type: 'where',
				operator: mode === 'none' ? 'notExists' : 'exists',
				targetTable,
			};
			if (subDecisions.length > 0) {
				return { ...result, conditions: subDecisions };
			}
			return result;
		}

		// Subquery scalar comparison: { kind: 'subquery', field, operator, subquery }
		// WHERE field OP (SELECT ... FROM ...)
		case 'subquery': {
			const field = cond.field as string;
			const operator = cond.operator as string; // eq, neq, gt, gte, lt, lte
			const subquery = cond.subquery as QueryIntent | undefined;

			if (!subquery || !field) {
				return null;
			}

			// Extract subquery parts
			const targetTable = subquery.from;
			let selectColumn = '*';
			let aggregate: string | undefined;

			// Parse select to extract column and aggregate
			const select = subquery.select as SelectIntent | undefined;
			if (select) {
				if ('type' in select && select.type === 'aggregate') {
					// SelectAggregateIntent
					const agg = select.aggregates?.[0];
					if (agg) {
						aggregate = agg.function;
						selectColumn = agg.field ?? '*';
					}
				} else if ('fields' in select && select.fields?.length) {
					// SelectFieldsIntent
					selectColumn = select.fields[0]!;
				}
			}

			// Convert inner WHERE if present
			const subConditions: PlanDecision[] = [];
			if (subquery.where) {
				const innerWhere = convertWhereCondition(
					subquery.where as WhereIntent,
					targetTable,
				);
				if (innerWhere) {
					subConditions.push(innerWhere);
				}
			}

			// Map operator to SQL symbol for subqueryOperator
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
			};
		}

		// JSON containment: col @> $1 or col <@ $1
		case 'jsonContains':
			return {
				type: 'where',
				column: cond.field as string,
				operator: cond.reversed ? 'jsonContainedBy' : 'jsonContains',
				value: cond.value,
				table: rootTable,
			};

		// ANY: { kind: 'any', field: 'id', values: [1, 2, 3] }
		// Compiles to: "col" = ANY($1::type[])
		case 'any':
			return {
				type: 'where',
				column: cond.field as string,
				operator: 'any',
				values: cond.values as readonly unknown[],
				table: rootTable,
			};

		// JSON key existence: col ? $1
		case 'jsonExists':
			return {
				type: 'where',
				column: cond.field as string,
				operator: 'jsonExists',
				value: cond.key,
				table: rootTable,
			};

		// Custom expression: { kind: 'expression', expr, operator, value }
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
			// Unknown condition type
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
