/**
 * Tests for FILTER (WHERE ...) clause support on aggregate expressions.
 *
 * Covers: COUNT, SUM, AVG, MIN, MAX with FILTER clause
 * at the handler level (unit) and the full compiler pipeline (integration).
 */

import { describe, expect, it } from 'vitest';
import { columnRef, eqExpr, normalizeSQL } from '../ast-helpers.js';
import { compilePlan, type SimplifiedPlanReport } from '../compiler.js';
import {
	avgHandler,
	countDistinctHandler,
	countHandler,
	genericAggregateHandler,
	maxHandler,
	minHandler,
	sumHandler,
} from '../handlers/expression/aggregate.js';
import type { CompilerContext, CompilerDecision } from '../handlers/types.js';
import { createCompilerState } from '../handlers/types.js';
import { identityNaming } from '../naming-plugin.js';

// ============================================================================
// Helpers
// ============================================================================

function makeCtx(overrides: Partial<CompilerContext> = {}): CompilerContext {
	return {
		naming: identityNaming,
		rootTable: 'orders',
		maxRecursiveDepth: 100,
		...overrides,
	} as CompilerContext;
}

/** Build a pre-compiled filterWhere node: "status" = $1 */
function makeFilterWhere(): import('@pgsql/types').Node {
	const col = columnRef('status', 'orders', undefined, identityNaming);
	return eqExpr(col, { ParamRef: { number: 1 } });
}

// ============================================================================
// Handler-level unit tests (filterWhere injected directly)
// ============================================================================

describe('aggregate handler: FILTER (WHERE ...) injection', () => {
	const ctx = makeCtx();

	it('countHandler: COUNT(*) FILTER (WHERE ...) produces agg_filter', () => {
		const state = createCompilerState();
		const filterWhere = makeFilterWhere();
		const decision = {
			type: 'count',
			column: '*',
			filterWhere,
		} as unknown as CompilerDecision;

		const node = countHandler.compile(decision, ctx, state);

		expect(node).toHaveProperty('FuncCall');
		const fc = (node as { FuncCall: Record<string, unknown> }).FuncCall;
		expect(fc.agg_star).toBe(true);
		expect(fc.agg_filter).toBe(filterWhere);
	});

	it('countHandler: COUNT(column) FILTER (WHERE ...) produces agg_filter', () => {
		const state = createCompilerState();
		const filterWhere = makeFilterWhere();
		const decision = {
			type: 'count',
			column: 'id',
			filterWhere,
		} as unknown as CompilerDecision;

		const node = countHandler.compile(decision, ctx, state);

		const fc = (node as { FuncCall: Record<string, unknown> }).FuncCall;
		expect(fc.agg_star).toBeUndefined();
		expect(fc.agg_filter).toBe(filterWhere);
	});

	it('sumHandler: SUM(column) FILTER (WHERE ...) produces agg_filter', () => {
		const state = createCompilerState();
		const filterWhere = makeFilterWhere();
		const decision = {
			type: 'sum',
			column: 'amount',
			filterWhere,
		} as unknown as CompilerDecision;

		const node = sumHandler.compile(decision, ctx, state);

		const fc = (node as { FuncCall: Record<string, unknown> }).FuncCall;
		expect(fc.agg_filter).toBe(filterWhere);
	});

	it('avgHandler: AVG(column) FILTER (WHERE ...) produces agg_filter', () => {
		const state = createCompilerState();
		const filterWhere = makeFilterWhere();
		const decision = {
			type: 'avg',
			column: 'price',
			filterWhere,
		} as unknown as CompilerDecision;

		const node = avgHandler.compile(decision, ctx, state);

		const fc = (node as { FuncCall: Record<string, unknown> }).FuncCall;
		expect(fc.agg_filter).toBe(filterWhere);
	});

	it('minHandler: MIN(column) FILTER (WHERE ...) produces agg_filter', () => {
		const state = createCompilerState();
		const filterWhere = makeFilterWhere();
		const decision = {
			type: 'min',
			column: 'price',
			filterWhere,
		} as unknown as CompilerDecision;

		const node = minHandler.compile(decision, ctx, state);

		const fc = (node as { FuncCall: Record<string, unknown> }).FuncCall;
		expect(fc.agg_filter).toBe(filterWhere);
	});

	it('maxHandler: MAX(column) FILTER (WHERE ...) produces agg_filter', () => {
		const state = createCompilerState();
		const filterWhere = makeFilterWhere();
		const decision = {
			type: 'max',
			column: 'price',
			filterWhere,
		} as unknown as CompilerDecision;

		const node = maxHandler.compile(decision, ctx, state);

		const fc = (node as { FuncCall: Record<string, unknown> }).FuncCall;
		expect(fc.agg_filter).toBe(filterWhere);
	});

	it('genericAggregateHandler: FILTER (WHERE ...) produces agg_filter', () => {
		const state = createCompilerState();
		const filterWhere = makeFilterWhere();
		const decision = {
			type: 'aggregate',
			function: 'sum',
			column: 'revenue',
			filterWhere,
		} as unknown as CompilerDecision;

		const node = genericAggregateHandler.compile(decision, ctx, state);

		const fc = (node as { FuncCall: Record<string, unknown> }).FuncCall;
		expect(fc.agg_filter).toBe(filterWhere);
	});

	it('countDistinctHandler: COUNT(DISTINCT col) FILTER (WHERE ...) produces agg_filter', () => {
		const state = createCompilerState();
		const filterWhere = makeFilterWhere();
		const decision = {
			type: 'countDistinct',
			column: 'user_id',
			filterWhere,
		} as unknown as CompilerDecision;

		const node = countDistinctHandler.compile(decision, ctx, state);

		const fc = (node as { FuncCall: Record<string, unknown> }).FuncCall;
		expect(fc.agg_star).toBeUndefined();
		expect(fc.agg_filter).toBe(filterWhere);
	});

	it('countHandler: COUNT(*) without filter does NOT produce agg_filter', () => {
		const state = createCompilerState();
		const decision = { type: 'count', column: '*' } as CompilerDecision;

		const node = countHandler.compile(decision, ctx, state);

		const fc = (node as { FuncCall: Record<string, unknown> }).FuncCall;
		expect(fc.agg_filter).toBeUndefined();
	});
});

// ============================================================================
// Full compiler pipeline tests (filterCondition → SQL via compilePlan)
// ============================================================================

describe('compilePlan: FILTER (WHERE ...) clause in aggregates', () => {
	it('COUNT(*) FILTER (WHERE active = $1) produces FILTER clause in SQL', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'users',
			decisions: [
				{
					type: 'selectFunction',
					function: 'count',
					column: '*',
					alias: 'active_count',
					filterCondition: {
						type: 'where',
						column: 'active',
						operator: '=',
						value: true,
						paramIndex: 1,
					},
				},
			],
		};

		const result = compilePlan(plan);
		const normalized = normalizeSQL(result.sql);

		expect(normalized).toEqual(
			'select count(*) filter (where users.active = $1) as active_count from users',
		);
		expect(result.parameters).toEqual([true]);
	});

	it('SUM(amount) FILTER (WHERE status = $1) produces FILTER clause in SQL', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{
					type: 'selectFunction',
					function: 'sum',
					column: 'amount',
					alias: 'pending_total',
					filterCondition: {
						type: 'where',
						column: 'status',
						operator: '=',
						value: 'pending',
						paramIndex: 1,
					},
				},
			],
		};

		const result = compilePlan(plan);
		const normalized = normalizeSQL(result.sql);

		expect(normalized).toEqual(
			'select sum(orders.amount) filter (where orders.status = $1) as pending_total from orders',
		);
		expect(result.parameters).toEqual(['pending']);
	});

	it('AVG(price) FILTER (WHERE category = $1) produces FILTER clause in SQL', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'products',
			decisions: [
				{
					type: 'selectFunction',
					function: 'avg',
					column: 'price',
					alias: 'avg_electronics',
					filterCondition: {
						type: 'where',
						column: 'category',
						operator: '=',
						value: 'electronics',
						paramIndex: 1,
					},
				},
			],
		};

		const result = compilePlan(plan);
		const normalized = normalizeSQL(result.sql);

		expect(normalized).toEqual(
			'select avg(products.price) filter (where products.category = $1) as avg_electronics from products',
		);
		expect(result.parameters).toEqual(['electronics']);
	});

	it('COUNT(*) without filterCondition still works (backward compat)', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'users',
			decisions: [
				{
					type: 'selectFunction',
					function: 'count',
					column: '*',
					alias: 'total',
				},
			],
		};

		const result = compilePlan(plan);
		const normalized = normalizeSQL(result.sql);

		expect(normalized).toContain('count');
		expect(normalized).not.toContain('filter');
	});

	it('multiple aggregates: mixed with and without FILTER', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{
					type: 'selectFunction',
					function: 'count',
					column: '*',
					alias: 'total_orders',
				},
				{
					type: 'selectFunction',
					function: 'count',
					column: '*',
					alias: 'pending_orders',
					filterCondition: {
						type: 'where',
						column: 'status',
						operator: '=',
						value: 'pending',
						paramIndex: 1,
					},
				},
				{
					type: 'selectFunction',
					function: 'sum',
					column: 'amount',
					alias: 'total_amount',
				},
			],
		};

		const result = compilePlan(plan);
		const normalized = normalizeSQL(result.sql);

		expect(normalized).toEqual(
			'select count(*) as total_orders, count(*) filter (where orders.status = $1) as pending_orders, sum(orders.amount) as total_amount from orders',
		);
		expect(result.parameters).toEqual(['pending']);
	});
});
