/**
 * Tests for WHERE Handlers (Block 2)
 */

import { deparseSync } from 'pgsql-deparser';
import { beforeEach, describe, expect, it } from 'vitest';
import {
	type CompilerContext,
	clearHandlers,
	createCompilerState,
	createWhereDispatcher,
	type Decision,
} from '../handlers/index.js';
import {
	registerAllWhereHandlers,
	registerSimpleWhereHandlers,
} from '../handlers/where/index.js';
import { identityNaming } from '../naming-plugin.js';

// Helper to compile a decision to SQL
function compileToSql(
	decision: Decision,
	ctx?: Partial<CompilerContext>,
): { sql: string; params: unknown[] } {
	const fullCtx: CompilerContext = {
		naming: identityNaming,
		rootTable: 'users',
		maxRecursiveDepth: 100,
		...ctx,
	};
	const state = createCompilerState();
	const dispatcher = createWhereDispatcher();
	const node = dispatcher(decision, fullCtx, state);
	// Deparse just the where clause node directly
	const sql = deparseSync([{ SelectStmt: { whereClause: node } }])
		.replace(/^SELECT\s+WHERE\s+/i, '')
		.trim();
	return { sql, params: state.parameters };
}

describe('WHERE Handlers', () => {
	beforeEach(() => {
		clearHandlers();
		registerSimpleWhereHandlers();
	});

	describe('Comparison Operators', () => {
		it('compiles equality (=)', () => {
			const result = compileToSql({
				type: 'comparison',
				column: 'id',
				operator: '=',
				value: 42,
			});
			expect(result.sql).toBe('users.id = $1');
			expect(result.params).toEqual([42]);
		});

		it('compiles not-equal (!=)', () => {
			const result = compileToSql({
				type: 'comparison',
				column: 'status',
				operator: '!=',
				value: 'deleted',
			});
			expect(result.sql).toBe('users.status <> $1');
			expect(result.params).toEqual(['deleted']);
		});

		it('compiles less-than (<)', () => {
			const result = compileToSql({
				type: 'comparison',
				column: 'age',
				operator: '<',
				value: 18,
			});
			expect(result.sql).toBe('users.age < $1');
			expect(result.params).toEqual([18]);
		});

		it('compiles less-than-or-equal (<=)', () => {
			const result = compileToSql({
				type: 'comparison',
				column: 'score',
				operator: '<=',
				value: 100,
			});
			expect(result.sql).toBe('users.score <= $1');
			expect(result.params).toEqual([100]);
		});

		it('compiles greater-than (>)', () => {
			const result = compileToSql({
				type: 'comparison',
				column: 'views',
				operator: '>',
				value: 1000,
			});
			expect(result.sql).toBe('users.views > $1');
			expect(result.params).toEqual([1000]);
		});

		it('compiles greater-than-or-equal (>=)', () => {
			const result = compileToSql({
				type: 'comparison',
				column: 'rating',
				operator: '>=',
				value: 4.5,
			});
			expect(result.sql).toBe('users.rating >= $1');
			expect(result.params).toEqual([4.5]);
		});

		it('uses currentAlias when provided', () => {
			const result = compileToSql(
				{
					type: 'comparison',
					column: 'name',
					operator: '=',
					value: 'test',
				},
				{ currentAlias: 'u' },
			);
			expect(result.sql).toBe('u.name = $1');
		});
	});

	describe('Pattern Operators', () => {
		it('compiles LIKE', () => {
			const result = compileToSql({
				type: 'pattern',
				column: 'name',
				operator: 'like',
				value: '%john%',
			});
			expect(result.sql).toBe('users.name LIKE $1');
			expect(result.params).toEqual(['%john%']);
		});

		it('compiles ILIKE (case-insensitive)', () => {
			const result = compileToSql({
				type: 'pattern',
				column: 'email',
				operator: 'ilike',
				value: '%@example.com',
			});
			expect(result.sql).toBe('users.email ILIKE $1');
			expect(result.params).toEqual(['%@example.com']);
		});
	});

	describe('Null Operators', () => {
		it('compiles IS NULL', () => {
			const result = compileToSql({
				type: 'null',
				column: 'deleted_at',
				operator: 'isNull',
			});
			expect(result.sql).toBe('users.deleted_at IS NULL');
			expect(result.params).toEqual([]);
		});

		it('compiles IS NOT NULL', () => {
			const result = compileToSql({
				type: 'null',
				column: 'email',
				operator: 'isNotNull',
			});
			expect(result.sql).toBe('users.email IS NOT NULL');
			expect(result.params).toEqual([]);
		});
	});

	describe('Collection Operators', () => {
		it('compiles IN with array', () => {
			const result = compileToSql({
				type: 'collection',
				column: 'status',
				operator: 'in',
				value: ['active', 'pending', 'review'],
			});
			// Note: deparser quotes function names as identifiers
			expect(result.sql).toBe('users.status = "any"($1)');
			expect(result.params).toEqual([['active', 'pending', 'review']]);
		});

		it('compiles NOT IN with array', () => {
			const result = compileToSql({
				type: 'collection',
				column: 'role',
				operator: 'notIn',
				value: ['banned', 'suspended'],
			});
			expect(result.sql).toBe('users.role <> "all"($1)');
			expect(result.params).toEqual([['banned', 'suspended']]);
		});

		it('returns false for empty IN', () => {
			const result = compileToSql({
				type: 'collection',
				column: 'status',
				operator: 'in',
				value: [],
			});
			expect(result.sql).toBe('false');
			expect(result.params).toEqual([]);
		});

		it('returns true for empty NOT IN', () => {
			const result = compileToSql({
				type: 'collection',
				column: 'status',
				operator: 'notIn',
				value: [],
			});
			expect(result.sql).toBe('true');
			expect(result.params).toEqual([]);
		});
	});

	describe('Logical Operators', () => {
		it('compiles AND with multiple conditions', () => {
			const result = compileToSql({
				type: 'logical',
				operator: 'and',
				conditions: [
					{ type: 'comparison', column: 'active', operator: '=', value: true },
					{ type: 'comparison', column: 'age', operator: '>=', value: 18 },
				],
			});
			// Note: deparser adds newlines for multiple conditions
			expect(result.sql).toContain('users.active = $1');
			expect(result.sql).toContain('AND');
			expect(result.sql).toContain('users.age >= $2');
			expect(result.params).toEqual([true, 18]);
		});

		it('compiles OR with multiple conditions', () => {
			const result = compileToSql({
				type: 'logical',
				operator: 'or',
				conditions: [
					{ type: 'comparison', column: 'role', operator: '=', value: 'admin' },
					{
						type: 'comparison',
						column: 'role',
						operator: '=',
						value: 'moderator',
					},
				],
			});
			expect(result.sql).toContain('users.role = $1');
			expect(result.sql).toContain('OR');
			expect(result.sql).toContain('users.role = $2');
			expect(result.params).toEqual(['admin', 'moderator']);
		});

		it('compiles NOT', () => {
			const result = compileToSql({
				type: 'logical',
				operator: 'not',
				conditions: [
					{ type: 'comparison', column: 'banned', operator: '=', value: true },
				],
			});
			expect(result.sql).toContain('NOT');
			expect(result.sql).toContain('users.banned = $1');
			expect(result.params).toEqual([true]);
		});

		it('returns true for empty AND', () => {
			const result = compileToSql({
				type: 'logical',
				operator: 'and',
				conditions: [],
			});
			expect(result.sql).toBe('true');
		});

		it('returns false for empty OR', () => {
			const result = compileToSql({
				type: 'logical',
				operator: 'or',
				conditions: [],
			});
			expect(result.sql).toBe('false');
		});

		it('unwraps single-condition AND', () => {
			const result = compileToSql({
				type: 'logical',
				operator: 'and',
				conditions: [
					{ type: 'comparison', column: 'id', operator: '=', value: 1 },
				],
			});
			expect(result.sql).toBe('users.id = $1');
		});

		it('compiles nested logical operators', () => {
			const result = compileToSql({
				type: 'logical',
				operator: 'and',
				conditions: [
					{ type: 'comparison', column: 'active', operator: '=', value: true },
					{
						type: 'logical',
						operator: 'or',
						conditions: [
							{
								type: 'comparison',
								column: 'role',
								operator: '=',
								value: 'admin',
							},
							{ type: 'comparison', column: 'level', operator: '>=', value: 5 },
						],
					},
				],
			});
			expect(result.sql).toContain('users.active = $1');
			expect(result.sql).toContain('AND');
			expect(result.sql).toContain('users.role = $2');
			expect(result.sql).toContain('OR');
			expect(result.sql).toContain('users.level >= $3');
			expect(result.params).toEqual([true, 'admin', 5]);
		});
	});

	describe('Parameter Indexing', () => {
		it('increments parameter index correctly', () => {
			const result = compileToSql({
				type: 'logical',
				operator: 'and',
				conditions: [
					{ type: 'comparison', column: 'a', operator: '=', value: 1 },
					{ type: 'comparison', column: 'b', operator: '=', value: 2 },
					{ type: 'comparison', column: 'c', operator: '=', value: 3 },
				],
			});
			expect(result.sql).toContain('$1');
			expect(result.sql).toContain('$2');
			expect(result.sql).toContain('$3');
			expect(result.params).toEqual([1, 2, 3]);
		});
	});
});

/**
 * Tests for Complex WHERE Handlers (Block 3)
 */
describe('Complex WHERE Handlers (EXISTS)', () => {
	beforeEach(() => {
		clearHandlers();
		registerAllWhereHandlers();
	});

	describe('EXISTS operator', () => {
		it('compiles basic EXISTS subquery', () => {
			const result = compileToSql({
				type: 'exists',
				operator: 'exists',
				relation: 'orders',
				targetTable: 'orders',
				sourceColumn: 'id',
				targetColumn: 'user_id',
			});
			// EXISTS (SELECT 1 FROM orders AS orders_exists_0 WHERE orders_exists_0.user_id = users.id)
			expect(result.sql).toContain('EXISTS');
			expect(result.sql).toContain('SELECT 1');
			expect(result.sql).toContain('orders');
			expect(result.sql).toContain('user_id');
			expect(result.params).toEqual([]);
		});

		it('compiles EXISTS with "some" alias', () => {
			const result = compileToSql({
				type: 'exists',
				operator: 'some',
				relation: 'posts',
				targetTable: 'posts',
				sourceColumn: 'id',
				targetColumn: 'author_id',
			});
			expect(result.sql).toContain('EXISTS');
			expect(result.sql).toContain('posts');
		});

		it('compiles EXISTS with nested conditions', () => {
			const result = compileToSql({
				type: 'exists',
				operator: 'exists',
				relation: 'orders',
				targetTable: 'orders',
				sourceColumn: 'id',
				targetColumn: 'user_id',
				conditions: [
					{
						type: 'comparison',
						column: 'status',
						operator: '=',
						value: 'completed',
					},
				],
			});
			// Nested condition should be ANDed with correlation
			expect(result.sql).toContain('EXISTS');
			expect(result.sql).toContain('status');
			expect(result.sql).toContain('$1');
			expect(result.params).toEqual(['completed']);
		});
	});

	describe('NOT EXISTS operator', () => {
		it('compiles NOT EXISTS subquery', () => {
			const result = compileToSql({
				type: 'exists',
				operator: 'notExists',
				relation: 'orders',
				targetTable: 'orders',
				sourceColumn: 'id',
				targetColumn: 'user_id',
			});
			// NOT EXISTS (SELECT 1 FROM orders ...)
			expect(result.sql).toContain('NOT');
			expect(result.sql).toContain('EXISTS');
			expect(result.sql).toContain('SELECT 1');
		});

		it('compiles NOT EXISTS with "none" alias', () => {
			const result = compileToSql({
				type: 'exists',
				operator: 'none',
				relation: 'bans',
				targetTable: 'bans',
				sourceColumn: 'id',
				targetColumn: 'user_id',
			});
			expect(result.sql).toContain('NOT');
			expect(result.sql).toContain('EXISTS');
			expect(result.sql).toContain('bans');
		});
	});

	describe('EVERY operator', () => {
		it('returns true for empty conditions (vacuous truth)', () => {
			const result = compileToSql({
				type: 'exists',
				operator: 'every',
				relation: 'items',
				targetTable: 'items',
				sourceColumn: 'id',
				targetColumn: 'order_id',
				conditions: [],
			});
			expect(result.sql).toBe('true');
		});

		it('compiles EVERY as NOT EXISTS (WHERE NOT condition)', () => {
			const result = compileToSql({
				type: 'exists',
				operator: 'every',
				relation: 'items',
				targetTable: 'items',
				sourceColumn: 'id',
				targetColumn: 'order_id',
				conditions: [
					{ type: 'comparison', column: 'shipped', operator: '=', value: true },
				],
			});
			// EVERY(shipped=true) = NOT EXISTS(SELECT 1 ... WHERE NOT (shipped=true))
			// So we should see NOT EXISTS and the condition
			expect(result.sql).toContain('NOT');
			expect(result.sql).toContain('EXISTS');
			expect(result.sql).toContain('shipped');
			expect(result.params).toEqual([true]);
		});
	});
});
