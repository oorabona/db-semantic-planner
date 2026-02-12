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

	describe('WHERE condition variants', () => {
		it('converts comparison with JSON metadata', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				where: {
					kind: 'comparison' as const,
					field: 'metadata',
					operator: 'eq' as const,
					value: { status: 'active' },
					jsonPath: ['status'],
					jsonMode: 'text',
				},
			};
			const decisions = intentToDecisions(intent, 'users');
			const whereDecision = decisions.find((d) => d.type === 'where');
			expect(whereDecision?.jsonPath).toEqual(['status']);
			expect(whereDecision?.jsonMode).toBe('text');
		});

		it('converts LIKE case-sensitive', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				where: {
					kind: 'like' as const,
					field: 'name',
					pattern: '%John%',
					caseInsensitive: false,
				},
			};
			const decisions = intentToDecisions(intent, 'users');
			expect(decisions).toContainEqual({
				type: 'where',
				column: 'name',
				operator: 'like',
				value: '%John%',
				table: 'users',
			});
		});

		it('converts ILIKE case-insensitive', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				where: {
					kind: 'like' as const,
					field: 'email',
					pattern: '%@example.com',
					caseInsensitive: true,
				},
			};
			const decisions = intentToDecisions(intent, 'users');
			expect(decisions).toContainEqual({
				type: 'where',
				column: 'email',
				operator: 'ilike',
				value: '%@example.com',
				table: 'users',
			});
		});

		it('converts IN with values array', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				where: { kind: 'in' as const, field: 'id', values: [1, 2, 3] },
			};
			const decisions = intentToDecisions(intent, 'users');
			expect(decisions).toContainEqual({
				type: 'where',
				column: 'id',
				operator: 'in',
				value: [1, 2, 3],
				table: 'users',
			});
		});

		it('converts NOT IN with values', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				where: { kind: 'in' as const, field: 'id', values: [1, 2], not: true },
			};
			const decisions = intentToDecisions(intent, 'users');
			expect(decisions).toContainEqual({
				type: 'where',
				column: 'id',
				operator: 'notIn',
				value: [1, 2],
				table: 'users',
			});
		});

		it('converts IN with subquery', () => {
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
						where: {
							kind: 'comparison' as const,
							field: 'active',
							operator: 'eq' as const,
							value: true,
						},
					},
				},
			};
			const decisions = intentToDecisions(intent, 'users');
			const whereDecision = decisions.find((d) => d.type === 'where');
			expect(whereDecision?.subquery).toBeDefined();
			expect(whereDecision?.subquery?.where).toBeDefined();
		});

		it('converts NULL check isNull', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				where: {
					kind: 'null' as const,
					field: 'deleted_at',
					operator: 'isNull',
				},
			};
			const decisions = intentToDecisions(intent, 'users');
			expect(decisions).toContainEqual({
				type: 'where',
				column: 'deleted_at',
				operator: 'isNull',
				table: 'users',
			});
		});

		it('converts NULL check isNotNull', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				where: {
					kind: 'null' as const,
					field: 'email',
					operator: 'isNotNull',
				},
			};
			const decisions = intentToDecisions(intent, 'users');
			expect(decisions).toContainEqual({
				type: 'where',
				column: 'email',
				operator: 'isNotNull',
				table: 'users',
			});
		});

		it('converts range with PostgreSQL contains operator', () => {
			const intent = {
				type: 'select' as const,
				from: 'events',
				where: {
					kind: 'range' as const,
					field: 'period',
					operator: 'contains',
					value: '2024-01-15',
				},
			};
			const decisions = intentToDecisions(intent, 'users');
			expect(decisions).toContainEqual({
				type: 'where',
				column: 'period',
				operator: 'contains',
				value: '2024-01-15',
				table: 'users',
			});
		});

		it('converts range with containedBy operator', () => {
			const intent = {
				type: 'select' as const,
				from: 'events',
				where: {
					kind: 'range' as const,
					field: 'period',
					operator: 'containedBy',
					value: '[2024-01-01,2024-12-31)',
				},
			};
			const decisions = intentToDecisions(intent, 'users');
			expect(decisions).toContainEqual({
				type: 'where',
				column: 'period',
				operator: 'containedBy',
				value: '[2024-01-01,2024-12-31)',
				table: 'users',
			});
		});

		it('converts range with overlaps operator', () => {
			const intent = {
				type: 'select' as const,
				from: 'bookings',
				where: {
					kind: 'range' as const,
					field: 'dates',
					operator: 'overlaps',
					value: '[2024-06-01,2024-06-15)',
				},
			};
			const decisions = intentToDecisions(intent, 'users');
			expect(decisions).toContainEqual({
				type: 'where',
				column: 'dates',
				operator: 'overlaps',
				value: '[2024-06-01,2024-06-15)',
				table: 'users',
			});
		});

		it('converts range with BETWEEN operator', () => {
			const intent = {
				type: 'select' as const,
				from: 'products',
				where: {
					kind: 'range' as const,
					field: 'price',
					operator: 'between',
					value: { lower: 10, upper: 50 },
				},
			};
			const decisions = intentToDecisions(intent, 'products');
			expect(decisions).toContainEqual({
				type: 'where',
				column: 'price',
				operator: 'between',
				value: [10, 50],
				table: 'products',
			});
		});

		it('converts numeric range gte + lte to BETWEEN', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				where: { kind: 'range' as const, field: 'age', gte: 18, lte: 65 },
			};
			const decisions = intentToDecisions(intent, 'users');
			expect(decisions).toContainEqual({
				type: 'where',
				column: 'age',
				operator: 'between',
				value: [18, 65],
				table: 'users',
			});
		});

		it('converts numeric range gte only', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				where: { kind: 'range' as const, field: 'age', gte: 21 },
			};
			const decisions = intentToDecisions(intent, 'users');
			expect(decisions).toContainEqual({
				type: 'where',
				column: 'age',
				operator: 'gte',
				value: 21,
				table: 'users',
			});
		});

		it('converts numeric range gt only', () => {
			const intent = {
				type: 'select' as const,
				from: 'products',
				where: { kind: 'range' as const, field: 'stock', gt: 0 },
			};
			const decisions = intentToDecisions(intent, 'products');
			expect(decisions).toContainEqual({
				type: 'where',
				column: 'stock',
				operator: 'gt',
				value: 0,
				table: 'products',
			});
		});

		it('converts numeric range lte only', () => {
			const intent = {
				type: 'select' as const,
				from: 'orders',
				where: { kind: 'range' as const, field: 'total', lte: 1000 },
			};
			const decisions = intentToDecisions(intent, 'orders');
			expect(decisions).toContainEqual({
				type: 'where',
				column: 'total',
				operator: 'lte',
				value: 1000,
				table: 'orders',
			});
		});

		it('converts numeric range lt only', () => {
			const intent = {
				type: 'select' as const,
				from: 'products',
				where: { kind: 'range' as const, field: 'price', lt: 100 },
			};
			const decisions = intentToDecisions(intent, 'products');
			expect(decisions).toContainEqual({
				type: 'where',
				column: 'price',
				operator: 'lt',
				value: 100,
				table: 'products',
			});
		});

		it('converts AND with multiple conditions', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				where: {
					kind: 'and' as const,
					conditions: [
						{
							kind: 'comparison' as const,
							field: 'age',
							operator: 'gte',
							value: 18,
						},
						{
							kind: 'comparison' as const,
							field: 'active',
							operator: 'eq',
							value: true,
						},
					],
				},
			};
			const decisions = intentToDecisions(intent, 'users');
			const andDecision = decisions.find((d) => d.type === 'whereAnd');
			expect(andDecision?.conditions).toHaveLength(2);
		});

		it('converts OR with multiple conditions', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				where: {
					kind: 'or' as const,
					conditions: [
						{
							kind: 'comparison' as const,
							field: 'role',
							operator: 'eq',
							value: 'admin',
						},
						{
							kind: 'comparison' as const,
							field: 'role',
							operator: 'eq',
							value: 'owner',
						},
					],
				},
			};
			const decisions = intentToDecisions(intent, 'users');
			const orDecision = decisions.find((d) => d.type === 'whereOr');
			expect(orDecision?.conditions).toHaveLength(2);
		});

		it('converts NOT with nested condition', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				where: {
					kind: 'not' as const,
					condition: {
						kind: 'comparison' as const,
						field: 'status',
						operator: 'eq',
						value: 'deleted',
					},
				},
			};
			const decisions = intentToDecisions(intent, 'users');
			const notDecision = decisions.find((d) => d.type === 'whereNot');
			expect(notDecision?.conditions).toHaveLength(1);
		});

		it('converts EXISTS without WHERE', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				where: { kind: 'exists' as const, relation: 'orders' },
			};
			const decisions = intentToDecisions(intent, 'users');
			const existsDecision = decisions.find((d) => d.operator === 'exists');
			expect(existsDecision?.targetTable).toBe('orders');
			expect(existsDecision?.conditions).toBeUndefined();
		});

		it('converts EXISTS with WHERE conditions', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				where: {
					kind: 'exists' as const,
					relation: 'orders',
					where: {
						kind: 'comparison' as const,
						field: 'status',
						operator: 'eq',
						value: 'paid',
					},
				},
			};
			const decisions = intentToDecisions(intent, 'users');
			const existsDecision = decisions.find((d) => d.operator === 'exists');
			expect(existsDecision?.conditions).toHaveLength(1);
		});

		it('converts NOT EXISTS without WHERE', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				where: { kind: 'notExists' as const, relation: 'posts' },
			};
			const decisions = intentToDecisions(intent, 'users');
			const notExistsDecision = decisions.find(
				(d) => d.operator === 'notExists',
			);
			expect(notExistsDecision?.targetTable).toBe('posts');
		});

		it('converts NOT EXISTS with WHERE conditions', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				where: {
					kind: 'notExists' as const,
					relation: 'orders',
					where: {
						kind: 'comparison' as const,
						field: 'refunded',
						operator: 'eq',
						value: true,
					},
				},
			};
			const decisions = intentToDecisions(intent, 'users');
			const notExistsDecision = decisions.find(
				(d) => d.operator === 'notExists',
			);
			expect(notExistsDecision?.conditions).toHaveLength(1);
		});

		it('converts relationFilter mode=some to EXISTS', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				where: {
					kind: 'relationFilter' as const,
					relation: 'posts',
					mode: 'some',
					where: {
						kind: 'comparison' as const,
						field: 'published',
						operator: 'eq',
						value: true,
					},
				},
			};
			const decisions = intentToDecisions(intent, 'users');
			const decision = decisions.find((d) => d.operator === 'exists');
			expect(decision).toBeDefined();
		});

		it('converts relationFilter mode=none to NOT EXISTS', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				where: {
					kind: 'relationFilter' as const,
					relation: 'orders',
					mode: 'none',
					where: {
						kind: 'comparison' as const,
						field: 'status',
						operator: 'eq',
						value: 'cancelled',
					},
				},
			};
			const decisions = intentToDecisions(intent, 'users');
			const decision = decisions.find((d) => d.operator === 'notExists');
			expect(decision).toBeDefined();
		});

		it('converts jsonContains forward', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				where: {
					kind: 'jsonContains' as const,
					field: 'tags',
					value: ['premium', 'verified'],
					reversed: false,
				},
			};
			const decisions = intentToDecisions(intent, 'users');
			expect(decisions).toContainEqual({
				type: 'where',
				column: 'tags',
				operator: 'jsonContains',
				value: ['premium', 'verified'],
				table: 'users',
			});
		});

		it('converts jsonContains reversed (containedBy)', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				where: {
					kind: 'jsonContains' as const,
					field: 'tags',
					value: { admin: true },
					reversed: true,
				},
			};
			const decisions = intentToDecisions(intent, 'users');
			expect(decisions).toContainEqual({
				type: 'where',
				column: 'tags',
				operator: 'jsonContainedBy',
				value: { admin: true },
				table: 'users',
			});
		});

		it('converts jsonExists', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				where: {
					kind: 'jsonExists' as const,
					field: 'metadata',
					key: 'profile',
				},
			};
			const decisions = intentToDecisions(intent, 'users');
			expect(decisions).toContainEqual({
				type: 'where',
				column: 'metadata',
				operator: 'jsonExists',
				value: 'profile',
				table: 'users',
			});
		});

		it('returns null for unknown WHERE kind', () => {
			const intent = {
				type: 'select' as const,
				from: 'users',
				where: { kind: 'unknownConditionType' as const },
			};
			const decisions = intentToDecisions(intent, 'users');
			// Unknown conditions are skipped
			expect(decisions.filter((d) => d.type === 'where')).toHaveLength(0);
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

		it('converts HAVING clause', () => {
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
			const havingDecision = decisions.find((d) => d.type === 'having');
			expect(havingDecision).toBeDefined();
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
			const where = decisions.find((d) => d.type === 'where');
			expect(where?.operator).toBe('scalarSubquery');
			expect(where?.aggregate).toBe('avg');
			expect(where?.selectColumn).toBe('salary');
			expect(where?.subqueryOperator).toBe('>');
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
			const where = decisions.find((d) => d.type === 'where');
			expect(where?.selectColumn).toBe('max_budget');
			expect(where?.subqueryOperator).toBe('<=');
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
			const where = decisions.find((d) => d.type === 'where');
			expect(where?.conditions).toHaveLength(1);
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
			expect(decisions.filter((d) => d.type === 'where')).toHaveLength(0);
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
			expect(decisions.filter((d) => d.type === 'where')).toHaveLength(0);
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
			const where = decisions.find((d) => d.type === 'where');
			expect(where?.subqueryOperator).toBe('=');
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
			const where = decisions.find((d) => d.type === 'where');
			expect(where?.subqueryOperator).toBe('!=');
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
			const where = decisions.find((d) => d.type === 'where');
			expect(where?.selectColumn).toBe('*');
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
			const whereDecision = decisions.find((d) => d.type === 'where');
			expect(whereDecision?.subquery).toBeDefined();
			expect(whereDecision?.subquery?.where).toBeUndefined();
		});
	});

	describe('relationFilter without where', () => {
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
			const decision = decisions.find((d) => d.operator === 'exists');
			expect(decision).toBeDefined();
			expect(decision?.conditions).toBeUndefined();
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
			const decision = decisions.find((d) => d.operator === 'exists');
			expect(decision).toBeDefined();
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
