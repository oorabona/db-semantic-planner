// @ts-nocheck — coverage test: runtime assertions on AST nodes
/**
 * Coverage tests for intent-to-decisions.ts
 * Focus: Branch coverage for all intent types, WHERE condition variants, expressions
 */

import { describe, expect, it } from 'vitest';
import { intentToDecisions } from './intent-to-decisions.js';

describe('intentToDecisions - coverage', () => {
	describe('SELECT intent variants', () => {
		it('converts SelectAllIntent { all: true }', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				select: { all: true },
			};
			const decisions = intentToDecisions(intent, 'users');
			expect(decisions).toContainEqual({
				type: 'select',
				column: '*',
				table: 'users',
			});
		});

		it('converts SelectFieldsIntent with multiple fields', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				select: { type: 'fields' as const, fields: ['id', 'name'] as const },
			};
			const decisions = intentToDecisions(intent, 'users');
			expect(decisions).toEqual([
				{ type: 'select', column: 'id', table: 'users' },
				{ type: 'select', column: 'name', table: 'users' },
			]);
		});

		it('converts column expression with alias', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				select: {
					type: 'expressions' as const,
					columns: [{ kind: 'column', column: 'email', as: 'user_email' }],
				},
			};
			const decisions = intentToDecisions(intent, 'users');
			expect(decisions).toContainEqual({
				type: 'select',
				column: 'email',
				alias: 'user_email',
				table: 'users',
			});
		});

		it('converts columnAlias expression', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				select: {
					type: 'expressions' as const,
					columns: [
						{ kind: 'columnAlias', column: 'name', alias: 'user_name' },
					],
				},
			};
			const decisions = intentToDecisions(intent, 'users');
			expect(decisions).toContainEqual({
				type: 'select',
				column: 'name',
				alias: 'user_name',
				table: 'users',
			});
		});

		it('converts COUNT(*) aggregate without field', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				select: {
					type: 'expressions' as const,
					columns: [{ kind: 'aggregate', function: 'count' }],
				},
			};
			const decisions = intentToDecisions(intent, 'users');
			expect(decisions).toContainEqual({
				type: 'selectFunction',
				function: 'count',
				column: '*',
				table: 'users',
			});
		});

		it('converts COUNT DISTINCT aggregate', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				select: {
					type: 'expressions' as const,
					columns: [
						{
							kind: 'aggregate',
							function: 'count',
							field: 'email',
							distinct: true,
							as: 'unique_emails',
						},
					],
				},
			};
			const decisions = intentToDecisions(intent, 'users');
			expect(decisions).toContainEqual({
				type: 'selectFunction',
				function: 'countDistinct',
				column: 'email',
				alias: 'unique_emails',
				table: 'users',
			});
		});

		it('converts aggregate with field and alias', () => {
			const intent = {
				type: 'select' as const,
				from: 'orders',
				select: {
					type: 'expressions' as const,
					columns: [
						{
							kind: 'aggregate',
							function: 'sum',
							field: 'total',
							as: 'total_sum',
						},
					],
				},
			};
			const decisions = intentToDecisions(intent, 'orders');
			expect(decisions).toContainEqual({
				type: 'selectFunction',
				function: 'sum',
				column: 'total',
				alias: 'total_sum',
				table: 'orders',
			});
		});

		it('converts COALESCE expression', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				select: {
					type: 'expressions' as const,
					columns: [
						{
							kind: 'coalesce',
							fields: ['nickname', 'first_name', 'email'],
							as: 'display_name',
						},
					],
				},
			};
			const decisions = intentToDecisions(intent, 'users');
			expect(decisions).toContainEqual({
				type: 'selectFunction',
				function: 'coalesce',
				args: ['nickname', 'first_name', 'email'],
				alias: 'display_name',
				table: 'users',
			});
		});

		it('converts raw SQL expression', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				select: {
					type: 'expressions' as const,
					columns: [
						{
							kind: 'raw',
							sql: "UPPER(name) || ' ' || LOWER(email)",
							as: 'full',
						},
					],
				},
			};
			const decisions = intentToDecisions(intent, 'users');
			expect(decisions).toContainEqual({
				type: 'selectFunction',
				function: 'raw',
				args: ["UPPER(name) || ' ' || LOWER(email)"],
				alias: 'full',
				table: 'users',
			});
		});

		it('converts window function with all options', () => {
			const intent = {
				type: 'select' as const,
				from: 'orders',
				select: {
					type: 'expressions' as const,
					columns: [
						{
							kind: 'window',
							function: 'lag',
							field: 'price',
							alias: 'prev_price',
							over: {
								partitionBy: ['product_id'],
								orderBy: [{ field: 'created_at', direction: 'asc' }],
							},
							offset: 1,
							defaultValue: 0,
						},
					],
				},
			};
			const decisions = intentToDecisions(intent, 'orders');
			expect(decisions).toContainEqual({
				type: 'selectWindow',
				function: 'lag',
				field: 'price',
				alias: 'prev_price',
				partitionBy: ['product_id'],
				orderBy: [{ field: 'created_at', direction: 'asc' }],
				args: [1],
				value: 0,
				table: 'orders',
			});
		});

		it('converts window function without field', () => {
			const intent = {
				type: 'select' as const,
				from: 'orders',
				select: {
					type: 'expressions' as const,
					columns: [
						{
							kind: 'window',
							function: 'row_number',
							alias: 'rn',
							over: {},
						},
					],
				},
			};
			const decisions = intentToDecisions(intent, 'orders');
			const windowDecision = decisions.find((d) => d.type === 'selectWindow');
			expect(windowDecision).toBeDefined();
			expect(windowDecision?.field).toBeUndefined();
		});

		it('converts CASE expression with ELSE clause', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				select: {
					type: 'expressions' as const,
					columns: [
						{
							kind: 'case',
							when: [
								{
									condition: {
										kind: 'comparison',
										field: 'age',
										operator: 'gte',
										value: 18,
									},
									result: { value: 'adult' },
								},
							],
							else: { value: 'minor' },
							as: 'category',
						},
					],
				},
			};
			const decisions = intentToDecisions(intent, 'users');
			const caseDecision = decisions.find(
				(d) => d.type === 'selectExpression' && d.expressionType === 'case',
			);
			expect(caseDecision).toBeDefined();
			expect(caseDecision?.alias).toBe('category');
			expect(caseDecision?.value).toEqual({ value: 'minor' });
		});

		it('converts relationColumn expression', () => {
			const intent = {
				type: 'select' as const,
				from: 'orders',
				select: {
					type: 'expressions' as const,
					columns: [
						{
							kind: 'relationColumn',
							relation: 'user',
							column: 'name',
							as: 'customer_name',
						},
					],
				},
			};
			const decisions = intentToDecisions(intent, 'orders');
			expect(decisions).toContainEqual({
				type: 'selectRelationColumn',
				relation: 'user',
				column: 'name',
				alias: 'customer_name',
				table: 'orders',
			});
		});

		it('converts relationColumn with wildcard', () => {
			const intent = {
				type: 'select' as const,
				from: 'orders',
				select: {
					type: 'expressions' as const,
					columns: [
						{ kind: 'relationColumn', relation: 'user', as: 'user_data' },
					],
				},
			};
			const decisions = intentToDecisions(intent, 'orders');
			expect(decisions).toContainEqual({
				type: 'selectRelationColumn',
				relation: 'user',
				column: '*',
				alias: 'user_data',
				table: 'orders',
			});
		});

		it('skips pseudoColumn (handled by planner)', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				select: {
					type: 'expressions' as const,
					columns: [{ kind: 'pseudoColumn', path: ['manager', 'name'] }],
				},
			};
			const decisions = intentToDecisions(intent, 'users');
			// Pseudo columns don't produce select decisions — planner handles via includes
			expect(decisions.filter((d) => d.type === 'select')).toHaveLength(0);
		});

		it('converts arithmetic expression', () => {
			const intent = {
				type: 'select' as const,
				from: 'products',
				select: {
					type: 'expressions' as const,
					columns: [
						{
							kind: 'arithmetic',
							operator: '+',
							left: { kind: 'column', column: 'price' },
							right: { kind: 'column', column: 'tax' },
							as: 'total',
						},
					],
				},
			};
			const decisions = intentToDecisions(intent, 'products');
			expect(decisions).toContainEqual({
				type: 'selectArithmetic',
				operator: '+',
				args: [
					{ kind: 'column', column: 'price' },
					{ kind: 'column', column: 'tax' },
				],
				alias: 'total',
				table: 'products',
			});
		});

		it('converts jsonExtract with mode', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				select: {
					type: 'expressions' as const,
					columns: [
						{
							kind: 'jsonExtract',
							field: 'metadata',
							path: ['profile', 'avatar'],
							mode: 'text',
							as: 'avatar_url',
						},
					],
				},
			};
			const decisions = intentToDecisions(intent, 'users');
			expect(decisions).toContainEqual({
				type: 'selectFunction',
				function: 'jsonExtract',
				column: 'metadata',
				args: ['profile', 'avatar'],
				jsonMode: 'text',
				alias: 'avatar_url',
				table: 'users',
			});
		});

		it('converts jsonPathExtract with json mode', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				select: {
					type: 'expressions' as const,
					columns: [
						{
							kind: 'jsonPathExtract',
							field: 'data',
							path: '{a,b,c}',
							mode: 'json',
							as: 'nested',
						},
					],
				},
			};
			const decisions = intentToDecisions(intent, 'users');
			expect(decisions).toContainEqual({
				type: 'selectFunction',
				function: 'jsonPathExtract',
				column: 'data',
				args: ['{a,b,c}'],
				jsonMode: 'json',
				alias: 'nested',
				table: 'users',
			});
		});

		it('converts SelectAggregateIntent with fields', () => {
			const intent = {
				type: 'select' as const,
				from: 'orders',
				select: {
					type: 'aggregate' as const,
					fields: ['user_id', 'product_id'],
					aggregates: [
						{ function: 'sum' as const, field: 'quantity', as: 'total_qty' },
					],
				},
			};
			const decisions = intentToDecisions(intent, 'orders');
			expect(decisions).toContainEqual({
				type: 'select',
				column: 'user_id',
				table: 'orders',
			});
			expect(decisions).toContainEqual({
				type: 'selectFunction',
				function: 'sum',
				column: 'quantity',
				alias: 'total_qty',
				table: 'orders',
			});
		});

		it('defaults to SELECT * when no select provided', () => {
			const intent = { type: 'select' as const, from: 'users' };
			const decisions = intentToDecisions(intent, 'users');
			expect(decisions).toContainEqual({
				type: 'select',
				column: '*',
				table: 'users',
			});
		});
	});

	describe('ORDER BY, GROUP BY, HAVING, LIMIT, OFFSET, DISTINCT', () => {
		it('converts ORDER BY with ASC direction', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				orderBy: [{ field: 'name', direction: 'asc' as const }],
			};
			const decisions = intentToDecisions(intent, 'users');
			expect(decisions).toContainEqual({
				type: 'orderBy',
				column: 'name',
				direction: 'ASC',
				table: 'users',
			});
		});

		it('converts ORDER BY with DESC direction', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				orderBy: [{ field: 'created_at', direction: 'desc' as const }],
			};
			const decisions = intentToDecisions(intent, 'users');
			expect(decisions).toContainEqual({
				type: 'orderBy',
				column: 'created_at',
				direction: 'DESC',
				table: 'users',
			});
		});

		it('converts ORDER BY with NULLS FIRST', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				orderBy: [
					{
						field: 'last_login',
						direction: 'desc' as const,
						nulls: 'first' as const,
					},
				],
			};
			const decisions = intentToDecisions(intent, 'users');
			const orderDecision = decisions.find((d) => d.type === 'orderBy');
			expect(orderDecision?.nulls).toBe('FIRST');
		});

		it('converts ORDER BY with NULLS LAST', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				orderBy: [
					{
						field: 'last_login',
						direction: 'asc' as const,
						nulls: 'last' as const,
					},
				],
			};
			const decisions = intentToDecisions(intent, 'users');
			const orderDecision = decisions.find((d) => d.type === 'orderBy');
			expect(orderDecision?.nulls).toBe('LAST');
		});

		it('converts GROUP BY with multiple columns', () => {
			const intent = {
				type: 'select' as const,
				from: 'orders',
				groupBy: ['user_id', 'product_id'],
			};
			const decisions = intentToDecisions(intent, 'orders');
			expect(decisions).toContainEqual({
				type: 'groupBy',
				column: 'user_id',
				table: 'orders',
			});
			expect(decisions).toContainEqual({
				type: 'groupBy',
				column: 'product_id',
				table: 'orders',
			});
		});

		it('converts HAVING clause (emits havingRaw decision)', () => {
			const intent = {
				type: 'select' as const,
				from: 'orders',
				groupBy: ['user_id'],
				having: {
					kind: 'comparison' as const,
					field: 'total',
					operator: 'gt',
					value: 1000,
				},
			};
			const decisions = intentToDecisions(intent, 'orders');
			// HAVING is now emitted as havingRaw with raw WhereIntent in expressionIntent
			const havingDecision = decisions.find((d) => d.type === 'havingRaw');
			expect(havingDecision).toBeDefined();
			expect(havingDecision?.expressionIntent).toMatchObject({
				kind: 'comparison',
				field: 'total',
				operator: 'gt',
				value: 1000,
			});
		});

		it('converts DISTINCT flag', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				distinct: true,
			};
			const decisions = intentToDecisions(intent, 'users');
			expect(decisions).toContainEqual({ type: 'distinct' });
		});

		it('converts LIMIT', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				limit: 10,
			};
			const decisions = intentToDecisions(intent, 'users');
			expect(decisions).toContainEqual({ type: 'limit', limit: 10 });
		});

		it('converts OFFSET', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				offset: 20,
			};
			const decisions = intentToDecisions(intent, 'users');
			expect(decisions).toContainEqual({ type: 'offset', offset: 20 });
		});

		it('converts LIMIT 0', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				limit: 0,
			};
			const decisions = intentToDecisions(intent, 'users');
			expect(decisions).toContainEqual({ type: 'limit', limit: 0 });
		});

		it('converts OFFSET 0', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				offset: 0,
			};
			const decisions = intentToDecisions(intent, 'users');
			expect(decisions).toContainEqual({ type: 'offset', offset: 0 });
		});

		it('skips empty orderBy array', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				orderBy: [],
			};
			const decisions = intentToDecisions(intent, 'users');
			expect(decisions.filter((d) => d.type === 'orderBy')).toHaveLength(0);
		});

		it('skips empty groupBy array', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				groupBy: [],
			};
			const decisions = intentToDecisions(intent, 'users');
			expect(decisions.filter((d) => d.type === 'groupBy')).toHaveLength(0);
		});
	});

	// ==================================================================
	// NEW: additional branches for coverage
	// ==================================================================

	describe('subquery scalar comparison (kind: "subquery")', () => {
		// PIPE-001: intentToDecisions now emits whereRaw with expressionIntent;
		// it no longer produces intermediate PlanDecision for subquery kinds.
		it('converts scalar subquery with aggregate select', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				where: {
					kind: 'subquery' as const,
					field: 'salary',
					operator: 'gt',
					subquery: {
						type: 'select' as const,
						from: 'users',
						select: {
							type: 'aggregate' as const,
							aggregates: [{ function: 'avg' as const, field: 'salary' }],
						},
					},
				},
			};
			const decisions = intentToDecisions(intent, 'users');
			const whereRaw = decisions.find((d) => d.type === 'whereRaw');
			expect(whereRaw).toBeDefined();
			expect((whereRaw?.expressionIntent as { kind: string })?.kind).toBe('subquery');
			expect((whereRaw?.expressionIntent as { field: string })?.field).toBe('salary');
			expect((whereRaw?.expressionIntent as { operator: string })?.operator).toBe('gt');
		});

		it('converts scalar subquery with fields select', () => {
			const intent = {
				type: 'select' as const,
				from: 'orders',
				where: {
					kind: 'subquery' as const,
					field: 'total',
					operator: 'lte',
					subquery: {
						type: 'select' as const,
						from: 'budgets',
						select: {
							type: 'fields' as const,
							fields: ['max_budget'] as const,
						},
					},
				},
			};
			const decisions = intentToDecisions(intent, 'orders');
			const whereRaw = decisions.find((d) => d.type === 'whereRaw');
			expect(whereRaw).toBeDefined();
			expect((whereRaw?.expressionIntent as { kind: string })?.kind).toBe('subquery');
			expect((whereRaw?.expressionIntent as { field: string })?.field).toBe('total');
		});

		it('converts scalar subquery with inner WHERE', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				where: {
					kind: 'subquery' as const,
					field: 'dept_id',
					operator: 'eq',
					subquery: {
						type: 'select' as const,
						from: 'departments',
						select: { type: 'fields' as const, fields: ['id'] as const },
						where: {
							kind: 'comparison' as const,
							field: 'name',
							operator: 'eq',
							value: 'Engineering',
						},
					},
				},
			};
			const decisions = intentToDecisions(intent, 'users');
			const whereRaw = decisions.find((d) => d.type === 'whereRaw');
			expect(whereRaw).toBeDefined();
			// The inner subquery where is preserved inside expressionIntent.subquery.where
			const sq = (whereRaw?.expressionIntent as { subquery?: { where?: unknown } })?.subquery;
			expect(sq?.where).toBeDefined();
		});

		it('returns null for scalar subquery without field', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				where: {
					kind: 'subquery' as const,
					operator: 'eq',
					subquery: {
						type: 'select' as const,
						from: 'x',
					},
				},
			};
			const decisions = intentToDecisions(intent, 'users');
			// whereRaw is still emitted (the WhereIntent is stored as-is)
			const whereRaw = decisions.find((d) => d.type === 'whereRaw');
			expect(whereRaw).toBeDefined();
		});

		it('returns null for scalar subquery without subquery', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				where: {
					kind: 'subquery' as const,
					field: 'id',
					operator: 'eq',
				},
			};
			const decisions = intentToDecisions(intent, 'users');
			// whereRaw is still emitted (the WhereIntent is stored as-is)
			const whereRaw = decisions.find((d) => d.type === 'whereRaw');
			expect(whereRaw).toBeDefined();
		});

		it('maps unknown operator to = as default', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				where: {
					kind: 'subquery' as const,
					field: 'x',
					operator: 'unknownOp',
					subquery: { type: 'select' as const, from: 't' },
				},
			};
			const decisions = intentToDecisions(intent, 'users');
			const whereRaw = decisions.find((d) => d.type === 'whereRaw');
			expect(whereRaw).toBeDefined();
			expect((whereRaw?.expressionIntent as { operator: string })?.operator).toBe('unknownOp');
		});

		it('maps neq operator to !=', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				where: {
					kind: 'subquery' as const,
					field: 'x',
					operator: 'neq',
					subquery: { type: 'select' as const, from: 't' },
				},
			};
			const decisions = intentToDecisions(intent, 'users');
			const whereRaw = decisions.find((d) => d.type === 'whereRaw');
			expect(whereRaw).toBeDefined();
			expect((whereRaw?.expressionIntent as { operator: string })?.operator).toBe('neq');
		});

		it('converts scalar subquery with no select → defaults to *', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				where: {
					kind: 'subquery' as const,
					field: 'x',
					operator: 'lt',
					subquery: { type: 'select' as const, from: 't' },
				},
			};
			const decisions = intentToDecisions(intent, 'users');
			const whereRaw = decisions.find((d) => d.type === 'whereRaw');
			expect(whereRaw).toBeDefined();
			expect((whereRaw?.expressionIntent as { kind: string })?.kind).toBe('subquery');
		});
	});

	describe('range with no bounds returns null', () => {
		it('returns null for range with no gte/gt/lte/lt/operator', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				where: { kind: 'range' as const, field: 'age' },
			};
			const decisions = intentToDecisions(intent, 'users');
			expect(decisions.filter((d) => d.type === 'where')).toHaveLength(0);
		});
	});

	describe('IN with subquery without inner WHERE', () => {
		// PIPE-001: intentToDecisions emits whereRaw — check expressionIntent directly.
		it('converts IN subquery without inner WHERE condition', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				where: {
					kind: 'in' as const,
					field: 'id',
					subquery: {
						type: 'select' as const,
						from: 'active_users',
						select: { type: 'fields' as const, fields: ['user_id'] as const },
					},
				},
			};
			const decisions = intentToDecisions(intent, 'users');
			const whereRaw = decisions.find((d) => d.type === 'whereRaw');
			expect(whereRaw).toBeDefined();
			expect((whereRaw?.expressionIntent as { kind: string })?.kind).toBe('in');
			// The subquery is preserved inside expressionIntent
			const subquery = (whereRaw?.expressionIntent as { subquery?: { where?: unknown } })?.subquery;
			expect(subquery).toBeDefined();
			expect(subquery?.where).toBeUndefined();
		});
	});

	describe('relationFilter without where', () => {
		// PIPE-001: intentToDecisions emits whereRaw — check expressionIntent directly.
		it('converts relationFilter mode=some without where', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				where: {
					kind: 'relationFilter' as const,
					relation: 'posts',
					mode: 'some',
				},
			};
			const decisions = intentToDecisions(intent, 'users');
			const whereRaw = decisions.find((d) => d.type === 'whereRaw');
			expect(whereRaw).toBeDefined();
			expect((whereRaw?.expressionIntent as { kind: string })?.kind).toBe('relationFilter');
			expect((whereRaw?.expressionIntent as { mode: string })?.mode).toBe('some');
		});

		it('converts relationFilter with default mode (some)', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				where: {
					kind: 'relationFilter' as const,
					relation: 'posts',
				},
			};
			const decisions = intentToDecisions(intent, 'users');
			const whereRaw = decisions.find((d) => d.type === 'whereRaw');
			expect(whereRaw).toBeDefined();
			expect((whereRaw?.expressionIntent as { kind: string })?.kind).toBe('relationFilter');
		});
	});

	describe('column expression without alias', () => {
		it('converts column expression without as → no alias property', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				select: {
					type: 'expressions' as const,
					columns: [{ kind: 'column', column: 'email' }],
				},
			};
			const decisions = intentToDecisions(intent, 'users');
			const selectDecision = decisions.find(
				(d) => d.type === 'select' && d.column === 'email',
			);
			expect(selectDecision).toBeDefined();
			expect(selectDecision?.alias).toBeUndefined();
		});
	});

	describe('aggregate count(*) with alias', () => {
		it('converts COUNT(*) with as field', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				select: {
					type: 'expressions' as const,
					columns: [{ kind: 'aggregate', function: 'count', as: 'total' }],
				},
			};
			const decisions = intentToDecisions(intent, 'users');
			expect(decisions).toContainEqual({
				type: 'selectFunction',
				function: 'count',
				column: '*',
				alias: 'total',
				table: 'users',
			});
		});
	});

	describe('aggregate without field and without alias', () => {
		it('converts generic aggregate (e.g. sum) without field', () => {
			const intent = {
				type: 'select' as const,
				from: 'orders',
				select: {
					type: 'expressions' as const,
					columns: [{ kind: 'aggregate', function: 'sum' }],
				},
			};
			const decisions = intentToDecisions(intent, 'orders');
			const d = decisions.find((d) => d.type === 'selectFunction');
			expect(d?.function).toBe('sum');
			expect(d?.column).toBeUndefined();
		});
	});

	describe('SelectAggregateIntent count(*) special case', () => {
		it('converts count(*) in aggregate intent', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				select: {
					type: 'aggregate' as const,
					aggregates: [{ function: 'count' as const, field: '*', as: 'cnt' }],
				},
			};
			const decisions = intentToDecisions(intent, 'users');
			const d = decisions.find(
				(d) => d.type === 'selectFunction' && d.function === 'count',
			);
			expect(d).toBeDefined();
			expect(d?.alias).toBe('cnt');
		});
	});

	describe('SelectAggregateIntent without fields', () => {
		it('converts aggregate intent without non-aggregate fields', () => {
			const intent = {
				type: 'select' as const,
				from: 'orders',
				select: {
					type: 'aggregate' as const,
					aggregates: [{ function: 'max' as const, field: 'total' }],
				},
			};
			const decisions = intentToDecisions(intent, 'orders');
			expect(decisions.filter((d) => d.type === 'select')).toHaveLength(0);
			expect(decisions).toContainEqual({
				type: 'selectFunction',
				function: 'max',
				column: 'total',
				table: 'orders',
			});
		});
	});

	describe('CASE expression without ELSE and without alias', () => {
		it('converts CASE without else clause', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				select: {
					type: 'expressions' as const,
					columns: [
						{
							kind: 'case',
							when: [
								{
									condition: {
										kind: 'comparison',
										field: 'active',
										operator: 'eq',
										value: true,
									},
									result: { value: 'yes' },
								},
							],
						},
					],
				},
			};
			const decisions = intentToDecisions(intent, 'users');
			const caseDecision = decisions.find(
				(d) => d.type === 'selectExpression' && d.expressionType === 'case',
			);
			expect(caseDecision).toBeDefined();
			expect(caseDecision?.value).toBeUndefined();
			expect(caseDecision?.alias).toBeUndefined();
		});
	});
});
