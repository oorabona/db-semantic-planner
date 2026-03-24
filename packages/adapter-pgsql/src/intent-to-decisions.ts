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
import type { Mutable } from '@dbsp/types/internal';
import type { PlanDecision } from './compiler.js';
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

	// 2. WHERE clause — emitted as whereRaw so the compiler compiles
	// the WhereIntent directly via compileWhereIntent (no PlanDecision conversion).
	if (intent.where) {
		decisions.push({ type: 'whereRaw', expressionIntent: intent.where, table: rootTable });
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

	// 5. HAVING clause — emitted as havingRaw so the compiler compiles
	// the WhereIntent directly via compileWhereIntent (no PlanDecision conversion).
	if (intent.having) {
		decisions.push({ type: 'havingRaw', expressionIntent: intent.having, table: rootTable });
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
 * Stores the raw WhereIntent as a whereRaw decision; compiled via compileWhereIntent.
 */
function applyFilterCondition(
	decision: Mutable<PlanDecision>,
	filter: WhereIntent | undefined,
	_rootTable: string,
): void {
	if (filter) {
		// Store the raw WhereIntent as a whereRaw decision in filterCondition.
		// compileFilterCondition in compiler.ts handles this via compileWhereIntent.
		(decision as Record<string, unknown>).filterCondition = {
			type: 'whereRaw',
			expressionIntent: filter,
		};
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
					// Wrap WhereIntent as whereRaw — compiler handles via compileWhereIntent
					(condition: import('@dbsp/types').WhereIntent, _table: string) =>
						({ type: 'whereRaw', expressionIntent: condition }) as import('./compiler.js').PlanDecision,
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
