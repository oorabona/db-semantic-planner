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
} from '@dbsp/core';
import type { PlanDecision } from './compiler.js';

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

	// 6. DISTINCT
	if (intent.distinct) {
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

function convertSelect(
	select: SelectIntent,
	rootTable: string,
): PlanDecision[] {
	// Handle different SelectIntent types
	if ('all' in select && select.all === true) {
		// SelectAllIntent
		return [{ type: 'select', column: '*', table: rootTable }];
	}

	if ('columns' in select && Array.isArray(select.columns)) {
		// SelectFieldsIntent - array of column names
		return select.columns.map((col: string) => ({
			type: 'select' as const,
			column: col,
			table: rootTable,
		}));
	}

	if ('expressions' in select && Array.isArray(select.expressions)) {
		// SelectWithExpressionsIntent
		const decisions: PlanDecision[] = [];

		for (const expr of select.expressions) {
			if (expr.kind === 'column') {
				decisions.push({
					type: 'select',
					column: expr.column,
					alias: expr.as,
					table: rootTable,
				});
			} else if (expr.kind === 'columnAlias') {
				decisions.push({
					type: 'select',
					column: expr.column,
					alias: expr.alias,
					table: rootTable,
				});
			} else if (expr.kind === 'aggregate') {
				// Aggregate expressions
				if (expr.function === 'count' && !expr.field) {
					decisions.push({
						type: 'selectFunction',
						function: 'count',
						column: '*',
						alias: expr.as,
						table: rootTable,
					});
				} else if (expr.function === 'count' && expr.distinct && expr.field) {
					decisions.push({
						type: 'selectFunction',
						function: 'countDistinct',
						column: expr.field,
						alias: expr.as,
						table: rootTable,
					});
				} else {
					decisions.push({
						type: 'selectFunction',
						function: expr.function,
						column: expr.field,
						alias: expr.as,
						table: rootTable,
					});
				}
			} else if (expr.kind === 'coalesce') {
				// COALESCE expression - use first field as primary
				decisions.push({
					type: 'selectFunction',
					function: 'coalesce',
					args: expr.fields,
					alias: expr.as,
					table: rootTable,
				});
			} else if (expr.kind === 'raw') {
				// Raw SQL expression
				decisions.push({
					type: 'selectFunction',
					function: 'raw',
					args: [expr.sql],
					alias: expr.as,
					table: rootTable,
				});
			}
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
			const aggDecision: PlanDecision = {
				type: 'selectFunction',
				function:
					agg.function === 'count' && agg.field === '*'
						? 'count'
						: agg.function,
				column: agg.field ?? '*',
				table: rootTable,
			};
			if (agg.as) {
				(aggDecision as { alias: string }).alias = agg.as;
			}
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
function convertWhereCondition(
	condition: WhereIntent,
	rootTable: string,
): PlanDecision | null {
	const cond = condition as unknown as Record<string, unknown>;
	const kind = cond.kind as string;

	switch (kind) {
		// Comparison: { kind: 'comparison', field: 'name', operator: 'eq', value: 'John' }
		case 'comparison':
			return {
				type: 'where',
				column: cond.field as string,
				operator: cond.operator as string,
				value: cond.value,
				table: rootTable,
			};

		// LIKE: { kind: 'like', field: 'name', pattern: '%john%' }
		case 'like':
			return {
				type: 'where',
				column: cond.field as string,
				operator: cond.caseInsensitive ? 'ilike' : 'like',
				value: cond.pattern,
				table: rootTable,
			};

		// IN: { kind: 'in', field: 'id', values: [1, 2, 3] }
		case 'in':
			return {
				type: 'where',
				column: cond.field as string,
				operator: cond.not ? 'notIn' : 'in',
				value: cond.values,
				table: rootTable,
			};

		// NULL: { kind: 'null', field: 'deleted_at', isNull: true }
		case 'null':
			return {
				type: 'where',
				column: cond.field as string,
				operator: cond.isNull ? 'isNull' : 'isNotNull',
				table: rootTable,
			};

		// Range: { kind: 'range', field: 'age', gte: 18, lte: 65 }
		case 'range': {
			// Convert range to a comparison or between
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

		// Subquery: { kind: 'subquery', ... }
		case 'subquery':
			// TODO: Handle subquery conditions
			return null;

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

	const decision: PlanDecision = {
		type: 'orderBy',
		column: order.field,
		direction,
		table: rootTable,
	};

	// Only add nulls if defined (exactOptionalPropertyTypes)
	if (nulls) {
		return { ...decision, nulls };
	}

	return decision;
}
