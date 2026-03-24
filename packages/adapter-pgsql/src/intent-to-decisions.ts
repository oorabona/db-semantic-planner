/**
 * Intent to Decisions — SELECT and clause compilers.
 *
 * Converts core's QueryIntent fields into PlanDecision[] for the pgsql compiler.
 * Two focused exports replace the old monolithic intentToDecisions:
 *
 *   convertSelectIntent  — SELECT-list decisions only
 *   buildClauseDecisions — ORDER BY, GROUP BY, DISTINCT, LIMIT, OFFSET decisions only
 *
 * WHERE and HAVING are compiled directly via compileWhereIntent (compile-where.ts).
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

/**
 * Convert a SelectIntent into SELECT-list PlanDecision[].
 *
 * Handles all SelectIntent variants:
 *   - SelectAllIntent             → { type: 'select', column: '*' }
 *   - SelectFieldsIntent          → one { type: 'select' } per field
 *   - SelectWithExpressionsIntent → handler-dispatched selectCustomExpression / etc.
 *   - SelectAggregateIntent       → selectFunction decisions
 *
 * @param select    - The SelectIntent from QueryIntent.select (may be undefined)
 * @param rootTable - The root table alias for column references
 */
export function convertSelectIntent(
	select: SelectIntent | undefined,
	rootTable: string,
): PlanDecision[] {
	if (!select) {
		return [{ type: 'select', column: '*', table: rootTable }];
	}

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
					(condition: import('@dbsp/types').WhereIntent, _table: string) =>
						({
							type: 'whereRaw',
							expressionIntent: condition,
						}) as import('./compiler.js').PlanDecision,
				);
			}
			// else: unknown kind (e.g., pseudoColumn) — intentional no-op
		}

		return decisions;
	}

	// SelectAggregateIntent: { aggregates: [...] }
	if ('aggregates' in select) {
		const decisions: PlanDecision[] = [];

		if (select.fields) {
			for (const field of select.fields) {
				decisions.push({ type: 'select', column: field, table: rootTable });
			}
		}

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
// buildClauseDecisions — ORDER BY, GROUP BY, DISTINCT, LIMIT, OFFSET
// ============================================================================

/**
 * Build PlanDecision[] for all non-SELECT, non-WHERE clauses from a QueryIntent:
 * ORDER BY, GROUP BY, DISTINCT / DISTINCT ON, LIMIT, OFFSET.
 *
 * WHERE and HAVING are intentionally excluded — they are compiled directly via
 * compileWhereIntent in adapter-compiler-select.ts.
 *
 * @param intent    - The QueryIntent containing clause fields
 * @param rootTable - The root table name
 */
export function buildClauseDecisions(
	intent: QueryIntent,
	rootTable: string,
): PlanDecision[] {
	const decisions: PlanDecision[] = [];

	// ORDER BY
	if (intent.orderBy && intent.orderBy.length > 0) {
		for (const order of intent.orderBy) {
			decisions.push(buildOrderByDecision(order, rootTable));
		}
	}

	// GROUP BY
	if (intent.groupBy && intent.groupBy.length > 0) {
		for (const col of intent.groupBy) {
			decisions.push({ type: 'groupBy', column: col, table: rootTable });
		}
	}

	// DISTINCT / DISTINCT ON
	if (intent.distinctOn && intent.distinctOn.length > 0) {
		decisions.push({ type: 'distinctOn', columns: intent.distinctOn });
	} else if (intent.distinct) {
		decisions.push({ type: 'distinct' });
	}

	// LIMIT
	if (intent.limit !== undefined) {
		decisions.push({ type: 'limit', limit: intent.limit });
	}

	// OFFSET
	if (intent.offset !== undefined) {
		decisions.push({ type: 'offset', offset: intent.offset });
	}

	return decisions;
}

function buildOrderByDecision(
	order: OrderByIntent,
	rootTable: string,
): PlanDecision {
	const direction: 'ASC' | 'DESC' = order.direction === 'desc' ? 'DESC' : 'ASC';

	const nulls: 'FIRST' | 'LAST' | undefined = order.nulls
		? order.nulls === 'first'
			? 'FIRST'
			: 'LAST'
		: undefined;

	if (order.expression) {
		const base: PlanDecision = {
			type: 'orderBy',
			expressionIntent: order.expression,
			direction,
			table: rootTable,
		};
		return nulls ? { ...base, nulls } : base;
	}

	const decision: PlanDecision = {
		type: 'orderBy',
		direction,
		table: rootTable,
		...(order.field ? { column: order.field } : {}),
	};

	return nulls ? { ...decision, nulls } : decision;
}

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
