/**
 * DX-003: Filter Helpers Tests
 *
 * Tests for Drizzle-like filter helper functions.
 */

import { describe, expect, it } from 'vitest';

import {
	and,
	coalesce,
	col,
	distinct,
	eq,
	exists,
	gt,
	gte,
	inArray,
	isDistinctField,
	isNotNull,
	isNull,
	isSqlRaw,
	like,
	lt,
	lte,
	neq,
	not,
	notExists,
	or,
	rangeContainedBy,
	rangeContains,
	rangeOverlaps,
	raw,
	relationColumn,
	SQL_RAW_MARKER,
	sql,
} from './filters.js';

// ============================================================================
// Feature 1: Comparison Operators
// ============================================================================

describe('Feature 1: Comparison Operators', () => {
	describe('Scenario 1.1: eq() creates comparison intent', () => {
		it('should return WhereComparisonIntent with eq operator', () => {
			const result = eq('status', 'active');

			expect(result).toEqual({
				kind: 'comparison',
				field: 'status',
				operator: 'eq',
				value: 'active',
			});
		});

		it('should handle numeric values', () => {
			const result = eq('id', 42);

			expect(result.value).toBe(42);
		});

		it('should handle null values', () => {
			const result = eq('deletedAt', null);

			expect(result.value).toBeNull();
		});
	});

	describe('Scenario 1.2: Other comparison operators', () => {
		it('neq() should return neq operator', () => {
			const result = neq('status', 'deleted');

			expect(result).toEqual({
				kind: 'comparison',
				field: 'status',
				operator: 'neq',
				value: 'deleted',
			});
		});

		it('gt() should return gt operator', () => {
			const result = gt('age', 18);

			expect(result).toEqual({
				kind: 'comparison',
				field: 'age',
				operator: 'gt',
				value: 18,
			});
		});

		it('gte() should return gte operator', () => {
			const result = gte('age', 18);

			expect(result).toEqual({
				kind: 'comparison',
				field: 'age',
				operator: 'gte',
				value: 18,
			});
		});

		it('lt() should return lt operator', () => {
			const result = lt('price', 100);

			expect(result).toEqual({
				kind: 'comparison',
				field: 'price',
				operator: 'lt',
				value: 100,
			});
		});

		it('lte() should return lte operator', () => {
			const result = lte('price', 100);

			expect(result).toEqual({
				kind: 'comparison',
				field: 'price',
				operator: 'lte',
				value: 100,
			});
		});
	});
});

// ============================================================================
// Feature 2: String Operators
// ============================================================================

describe('Feature 2: String Operators', () => {
	describe('Scenario 1.3: like() creates like intent', () => {
		it('should return WhereLikeIntent', () => {
			const result = like('name', '%john%');

			expect(result).toEqual({
				kind: 'like',
				field: 'name',
				pattern: '%john%',
			});
		});

		it('should support caseInsensitive option', () => {
			const result = like('email', '%@EXAMPLE.COM', true);

			expect(result).toEqual({
				kind: 'like',
				field: 'email',
				pattern: '%@EXAMPLE.COM',
				caseInsensitive: true,
			});
		});

		it('should not include caseInsensitive when not specified', () => {
			const result = like('name', '%test%');

			expect(result).not.toHaveProperty('caseInsensitive');
		});
	});
});

// ============================================================================
// Feature 3: Array Operators
// ============================================================================

describe('Feature 3: Array Operators', () => {
	describe('Scenario 1.5: inArray() creates in intent', () => {
		it('should return WhereInIntent', () => {
			const result = inArray('status', ['active', 'pending']);

			expect(result).toEqual({
				kind: 'in',
				field: 'status',
				values: ['active', 'pending'],
			});
		});

		it('should handle numeric arrays', () => {
			const result = inArray('id', [1, 2, 3]);

			expect(result.values).toEqual([1, 2, 3]);
		});

		it('should handle empty arrays', () => {
			const result = inArray('id', []);

			expect(result.values).toEqual([]);
		});
	});
});

// ============================================================================
// Feature 4: Null Operators
// ============================================================================

describe('Feature 4: Null Operators', () => {
	describe('Scenario 1.4: isNull and isNotNull', () => {
		it('isNull() should return WhereNullIntent with isNull operator', () => {
			const result = isNull('deletedAt');

			expect(result).toEqual({
				kind: 'null',
				field: 'deletedAt',
				operator: 'isNull',
			});
		});

		it('isNotNull() should return WhereNullIntent with isNotNull operator', () => {
			const result = isNotNull('email');

			expect(result).toEqual({
				kind: 'null',
				field: 'email',
				operator: 'isNotNull',
			});
		});
	});
});

// ============================================================================
// Feature 4.5: Range Operators (PostgreSQL)
// ============================================================================

describe('Feature 4.5: Range Operators (PostgreSQL)', () => {
	describe('rangeOverlaps() creates range intent with overlaps operator', () => {
		it('should return WhereRangeIntent with overlaps operator', () => {
			const result = rangeOverlaps('dates', {
				lower: '2025-01-15',
				upper: '2025-01-20',
			});

			expect(result).toEqual({
				kind: 'range',
				field: 'dates',
				operator: 'overlaps',
				value: { lower: '2025-01-15', upper: '2025-01-20' },
			});
		});

		it('should support custom bounds', () => {
			const result = rangeOverlaps('period', {
				lower: 10,
				upper: 20,
				bounds: '[]',
			});

			expect(result).toEqual({
				kind: 'range',
				field: 'period',
				operator: 'overlaps',
				value: { lower: 10, upper: 20, bounds: '[]' },
			});
		});
	});

	describe('rangeContains() creates range intent with contains operator', () => {
		it('should return WhereRangeIntent with contains for scalar value', () => {
			const result = rangeContains('salary_range', 50000);

			expect(result).toEqual({
				kind: 'range',
				field: 'salary_range',
				operator: 'contains',
				value: 50000,
			});
		});

		it('should return WhereRangeIntent with contains for range value', () => {
			const result = rangeContains('date_range', {
				lower: '2025-01-01',
				upper: '2025-01-05',
			});

			expect(result).toEqual({
				kind: 'range',
				field: 'date_range',
				operator: 'contains',
				value: { lower: '2025-01-01', upper: '2025-01-05' },
			});
		});
	});

	describe('rangeContainedBy() creates range intent with containedBy operator', () => {
		it('should return WhereRangeIntent with containedBy operator', () => {
			const result = rangeContainedBy('event_dates', {
				lower: '2025-01-01',
				upper: '2025-12-31',
			});

			expect(result).toEqual({
				kind: 'range',
				field: 'event_dates',
				operator: 'containedBy',
				value: { lower: '2025-01-01', upper: '2025-12-31' },
			});
		});
	});
});

// ============================================================================
// Feature 5: Logical Operators
// ============================================================================

describe('Feature 5: Logical Operators', () => {
	describe('Scenario 1.6: and() combines conditions', () => {
		it('should return WhereAndIntent with variadic args', () => {
			const result = and(eq('a', 1), gt('b', 2));

			expect(result).toEqual({
				kind: 'and',
				conditions: [
					{ kind: 'comparison', field: 'a', operator: 'eq', value: 1 },
					{ kind: 'comparison', field: 'b', operator: 'gt', value: 2 },
				],
			});
		});

		it('should accept array form', () => {
			const conditions = [eq('a', 1), gt('b', 2)];
			const result = and(conditions);

			expect(result.kind).toBe('and');
			expect(result.conditions).toHaveLength(2);
		});

		it('should handle single condition', () => {
			const result = and(eq('a', 1));

			expect(result.conditions).toHaveLength(1);
		});
	});

	describe('Scenario 1.7: or() combines conditions', () => {
		it('should return WhereOrIntent with variadic args', () => {
			const result = or(eq('status', 'active'), eq('status', 'pending'));

			expect(result).toEqual({
				kind: 'or',
				conditions: [
					{
						kind: 'comparison',
						field: 'status',
						operator: 'eq',
						value: 'active',
					},
					{
						kind: 'comparison',
						field: 'status',
						operator: 'eq',
						value: 'pending',
					},
				],
			});
		});

		it('should accept array form', () => {
			const conditions = [eq('a', 1), eq('a', 2)];
			const result = or(conditions);

			expect(result.kind).toBe('or');
			expect(result.conditions).toHaveLength(2);
		});
	});

	describe('Scenario 1.8: not() negates condition', () => {
		it('should return WhereNotIntent', () => {
			const result = not(eq('deleted', true));

			expect(result).toEqual({
				kind: 'not',
				condition: {
					kind: 'comparison',
					field: 'deleted',
					operator: 'eq',
					value: true,
				},
			});
		});

		it('should handle nested logical conditions', () => {
			const result = not(and(eq('a', 1), eq('b', 2)));

			expect(result.kind).toBe('not');
			expect(result.condition.kind).toBe('and');
		});
	});
});

// ============================================================================
// Feature 6: Relation Operators
// ============================================================================

describe('Feature 6: Relation Operators', () => {
	describe('Scenario 1.9: exists() creates exists intent', () => {
		it('should return WhereExistsIntent without where', () => {
			const result = exists('posts');

			expect(result).toEqual({
				kind: 'exists',
				relation: 'posts',
			});
		});

		it('should return WhereExistsIntent with where', () => {
			const result = exists('posts', { where: eq('published', true) });

			expect(result).toEqual({
				kind: 'exists',
				relation: 'posts',
				where: {
					kind: 'comparison',
					field: 'published',
					operator: 'eq',
					value: true,
				},
			});
		});

		it('should not include where when undefined', () => {
			const result = exists('posts');

			expect(result).not.toHaveProperty('where');
		});
	});

	describe('Scenario 1.10: notExists() creates notExists intent', () => {
		it('should return WhereNotExistsIntent without where', () => {
			const result = notExists('comments');

			expect(result).toEqual({
				kind: 'notExists',
				relation: 'comments',
			});
		});

		it('should return WhereNotExistsIntent with where', () => {
			const result = notExists('comments', { where: eq('spam', true) });

			expect(result).toEqual({
				kind: 'notExists',
				relation: 'comments',
				where: {
					kind: 'comparison',
					field: 'spam',
					operator: 'eq',
					value: true,
				},
			});
		});
	});
});

// ============================================================================
// Feature 7: Composition
// ============================================================================

describe('Feature 7: Composition', () => {
	it('should support deeply nested conditions', () => {
		const result = and(
			eq('status', 'active'),
			or(gt('age', 18), and(eq('role', 'admin'), isNotNull('verifiedAt'))),
		);

		expect(result.kind).toBe('and');
		expect(result.conditions).toHaveLength(2);
		expect(result.conditions[1]!.kind).toBe('or');
	});

	it('should support exists with complex where', () => {
		const result = exists('posts', {
			where: and(eq('published', true), gt('views', 100)),
		});

		expect(result.kind).toBe('exists');
		expect(result.where?.kind).toBe('and');
	});
});

// ============================================================================
// Feature 8: Expression Helpers
// ============================================================================

describe('Feature 8: Expression Helpers', () => {
	describe('Scenario 8.1: coalesce() creates ExpressionSpec with coalesce intent', () => {
		it('should return ExpressionSpec wrapping CoalesceExpressionIntent', () => {
			const result = coalesce(['name_fr', 'name_en', 'name'], 'displayName');

			expect(result).toEqual({
				__expr: true,
				intent: {
					kind: 'coalesce',
					fields: ['name_fr', 'name_en', 'name'],
					as: 'displayName',
				},
			});
		});

		it('should handle single field', () => {
			const result = coalesce(['name'], 'displayName');

			expect(result).toEqual({
				__expr: true,
				intent: {
					kind: 'coalesce',
					fields: ['name'],
					as: 'displayName',
				},
			});
		});

		it('should throw on empty fields array', () => {
			expect(() => coalesce([], 'displayName')).toThrow(
				'coalesce() requires at least one field',
			);
		});

		it('should throw on empty alias', () => {
			expect(() => coalesce(['name'], '')).toThrow(
				'coalesce() requires a non-empty alias',
			);
		});

		it('should throw on whitespace-only alias', () => {
			expect(() => coalesce(['name'], '   ')).toThrow(
				'coalesce() requires a non-empty alias',
			);
		});
	});

	describe('Scenario 8.2: raw() creates ExpressionSpec with raw intent', () => {
		it('should return ExpressionSpec wrapping RawExpressionIntent', () => {
			const result = raw("CONCAT(first_name, ' ', last_name)", 'fullName');

			expect(result).toEqual({
				__expr: true,
				intent: {
					kind: 'raw',
					sql: "CONCAT(first_name, ' ', last_name)",
					as: 'fullName',
				},
			});
		});

		it('should handle complex SQL expressions', () => {
			const result = raw(
				'CASE WHEN status = 1 THEN active ELSE inactive END',
				'statusLabel',
			);

			expect(result.__expr).toBe(true);
			expect(result.intent.kind).toBe('raw');
			if (result.intent.kind === 'raw') {
				expect(result.intent.sql).toContain('CASE WHEN');
				expect(result.intent.as).toBe('statusLabel');
			}
		});

		it('should throw on empty alias', () => {
			expect(() => raw('SELECT 1', '')).toThrow(
				'raw() requires a non-empty alias',
			);
		});

		it('should throw on whitespace-only alias', () => {
			expect(() => raw('SELECT 1', '  ')).toThrow(
				'raw() requires a non-empty alias',
			);
		});

		it('should allow empty SQL (edge case for validation elsewhere)', () => {
			// Empty SQL is technically allowed - validation happens during compilation
			const result = raw('', 'emptyExpr');

			expect(result).toEqual({
				__expr: true,
				intent: {
					kind: 'raw',
					sql: '',
					as: 'emptyExpr',
				},
			});
		});
	});

	describe('Scenario 8.3: col() creates ExpressionSpec with columnAlias intent', () => {
		it('should return ExpressionSpec wrapping ColumnAliasIntent', () => {
			const result = col('name', 'userName');

			expect(result).toEqual({
				__expr: true,
				intent: {
					kind: 'columnAlias',
					column: 'name',
					alias: 'userName',
				},
			});
		});

		it('should handle column names with underscore', () => {
			const result = col('first_name', 'firstName');

			expect(result.__expr).toBe(true);
			expect(result.intent.kind).toBe('columnAlias');
			if (result.intent.kind === 'columnAlias') {
				expect(result.intent.column).toBe('first_name');
				expect(result.intent.alias).toBe('firstName');
			}
		});

		it('should throw on empty column name', () => {
			expect(() => col('', 'alias')).toThrow(
				'col() requires a non-empty column name',
			);
		});

		it('should throw on whitespace-only column name', () => {
			expect(() => col('  ', 'alias')).toThrow(
				'col() requires a non-empty column name',
			);
		});

		it('should throw on empty alias', () => {
			expect(() => col('name', '')).toThrow('col() requires a non-empty alias');
		});

		it('should throw on whitespace-only alias', () => {
			expect(() => col('name', '  ')).toThrow(
				'col() requires a non-empty alias',
			);
		});
	});
});

// ============================================================================
// DX-034: distinct() Helper
// ============================================================================

describe('DX-034: distinct() helper', () => {
	describe('distinct()', () => {
		it('should create a DistinctField object', () => {
			const result = distinct('customerId');

			expect(result).toEqual({
				field: 'customerId',
				distinct: true,
			});
		});

		it('should be recognized by isDistinctField type guard', () => {
			const result = distinct('customerId');

			expect(isDistinctField(result)).toBe(true);
		});

		it('should reject non-DistinctField objects', () => {
			expect(isDistinctField('customerId')).toBe(false);
			expect(isDistinctField({ field: 'customerId' })).toBe(false);
			expect(isDistinctField({ distinct: true })).toBe(false);
			expect(isDistinctField(null)).toBe(false);
			expect(isDistinctField(undefined)).toBe(false);
			expect(isDistinctField({ field: 'customerId', distinct: false })).toBe(
				false,
			);
		});
	});
});

// ============================================================================
// relationColumn() Helper - Auto-JOIN relation columns
// ============================================================================

describe('relationColumn() helper', () => {
	describe('relationColumn()', () => {
		it('should return ExpressionSpec wrapping RelationColumnIntent', () => {
			const result = relationColumn('category', 'name', 'categoryName');

			expect(result).toEqual({
				__expr: true,
				intent: {
					kind: 'relationColumn',
					relation: 'category',
					column: 'name',
					as: 'categoryName',
				},
			});
		});

		it('should handle multi-level relation paths', () => {
			const result = relationColumn(
				'category.parent',
				'name',
				'parentCategoryName',
			);

			expect(result.__expr).toBe(true);
			expect(result.intent.kind).toBe('relationColumn');
			if (result.intent.kind === 'relationColumn') {
				expect(result.intent.relation).toBe('category.parent');
				expect(result.intent.column).toBe('name');
				expect(result.intent.as).toBe('parentCategoryName');
			}
		});

		it('should handle snake_case column names', () => {
			const result = relationColumn('author', 'first_name', 'authorFirstName');

			if (result.intent.kind === 'relationColumn') {
				expect(result.intent.column).toBe('first_name');
				expect(result.intent.as).toBe('authorFirstName');
			}
		});

		it('should throw on empty relation', () => {
			expect(() => relationColumn('', 'name', 'alias')).toThrow(
				'relationColumn() requires a non-empty relation path',
			);
		});

		it('should throw on whitespace-only relation', () => {
			expect(() => relationColumn('  ', 'name', 'alias')).toThrow(
				'relationColumn() requires a non-empty relation path',
			);
		});

		it('should throw on empty column', () => {
			expect(() => relationColumn('category', '', 'alias')).toThrow(
				'relationColumn() requires a non-empty column name',
			);
		});

		it('should throw on whitespace-only column', () => {
			expect(() => relationColumn('category', '  ', 'alias')).toThrow(
				'relationColumn() requires a non-empty column name',
			);
		});

		it('should throw on empty alias', () => {
			expect(() => relationColumn('category', 'name', '')).toThrow(
				'relationColumn() requires a non-empty alias',
			);
		});

		it('should throw on whitespace-only alias', () => {
			expect(() => relationColumn('category', 'name', '  ')).toThrow(
				'relationColumn() requires a non-empty alias',
			);
		});
	});
});

// ============================================================================
// DX-040: Type-Safe Filter Tests with ColumnRef
// ============================================================================

import { ref, schema } from './schema.js';

describe('Type-safe filters with ColumnRef (DX-040)', () => {
	// Create a test schema with typed tables
	const testSchema = schema({
		users: {
			id: 'integer',
			name: 'string',
			age: 'integer',
			email: 'string',
			active: 'boolean',
			score: { type: 'decimal', nullable: true },
		},
		posts: {
			id: 'integer',
			title: 'string',
			authorId: ref('users'),
		},
	});

	const { users, posts } = testSchema.tables;

	describe('eq() with ColumnRef', () => {
		it('should accept ColumnRef and extract column name', () => {
			const result = eq(users.name, 'John');

			expect(result).toEqual({
				kind: 'comparison',
				field: 'name',
				operator: 'eq',
				value: 'John',
			});
		});

		it('should work with number columns', () => {
			const result = eq(users.age, 25);

			expect(result).toEqual({
				kind: 'comparison',
				field: 'age',
				operator: 'eq',
				value: 25,
			});
		});

		it('should work with boolean columns', () => {
			const result = eq(users.active, true);

			expect(result).toEqual({
				kind: 'comparison',
				field: 'active',
				operator: 'eq',
				value: true,
			});
		});
	});

	describe('gt/gte/lt/lte with ColumnRef', () => {
		it('gt() should accept ColumnRef', () => {
			const result = gt(users.age, 18);

			expect(result).toEqual({
				kind: 'comparison',
				field: 'age',
				operator: 'gt',
				value: 18,
			});
		});

		it('gte() should accept ColumnRef', () => {
			const result = gte(users.age, 18);

			expect(result).toEqual({
				kind: 'comparison',
				field: 'age',
				operator: 'gte',
				value: 18,
			});
		});

		it('lt() should accept ColumnRef', () => {
			const result = lt(users.age, 65);

			expect(result).toEqual({
				kind: 'comparison',
				field: 'age',
				operator: 'lt',
				value: 65,
			});
		});

		it('lte() should accept ColumnRef', () => {
			const result = lte(users.age, 65);

			expect(result).toEqual({
				kind: 'comparison',
				field: 'age',
				operator: 'lte',
				value: 65,
			});
		});
	});

	describe('like() with ColumnRef', () => {
		it('should accept ColumnRef for string columns', () => {
			const result = like(users.name, '%John%');

			expect(result).toEqual({
				kind: 'like',
				field: 'name',
				pattern: '%John%',
			});
		});

		it('should support case-insensitive option', () => {
			const result = like(users.email, '%@EXAMPLE.COM', true);

			expect(result).toEqual({
				kind: 'like',
				field: 'email',
				pattern: '%@EXAMPLE.COM',
				caseInsensitive: true,
			});
		});
	});

	describe('isNull/isNotNull with ColumnRef', () => {
		it('isNull() should accept ColumnRef', () => {
			const result = isNull(users.score);

			expect(result).toEqual({
				kind: 'null',
				field: 'score',
				operator: 'isNull',
			});
		});

		it('isNotNull() should accept ColumnRef', () => {
			const result = isNotNull(users.email);

			expect(result).toEqual({
				kind: 'null',
				field: 'email',
				operator: 'isNotNull',
			});
		});
	});

	describe('inArray with ColumnRef', () => {
		it('should accept ColumnRef and array of matching type', () => {
			const result = inArray(users.name, ['Alice', 'Bob', 'Charlie']);

			expect(result).toEqual({
				kind: 'in',
				field: 'name',
				values: ['Alice', 'Bob', 'Charlie'],
			});
		});

		it('should work with number arrays', () => {
			const result = inArray(users.age, [18, 21, 25]);

			expect(result).toEqual({
				kind: 'in',
				field: 'age',
				values: [18, 21, 25],
			});
		});
	});

	describe('combined with and/or', () => {
		it('should work in and() combination', () => {
			const result = and(
				eq(users.active, true),
				gt(users.age, 18),
				like(users.name, '%John%'),
			);

			expect(result.kind).toBe('and');
			expect(result.conditions).toHaveLength(3);
		});

		it('should work in or() combination', () => {
			const result = or(eq(users.name, 'Alice'), eq(users.name, 'Bob'));

			expect(result.kind).toBe('or');
			expect(result.conditions).toHaveLength(2);
		});
	});

	describe('backward compatibility', () => {
		it('should still work with string field names', () => {
			// These should continue to work exactly as before
			expect(eq('name', 'John')).toEqual({
				kind: 'comparison',
				field: 'name',
				operator: 'eq',
				value: 'John',
			});

			expect(gt('age', 18)).toEqual({
				kind: 'comparison',
				field: 'age',
				operator: 'gt',
				value: 18,
			});

			expect(like('name', '%John%')).toEqual({
				kind: 'like',
				field: 'name',
				pattern: '%John%',
			});

			expect(isNull('deletedAt')).toEqual({
				kind: 'null',
				field: 'deletedAt',
				operator: 'isNull',
			});
		});
	});
});

// ============================================================================
// UPSERT-RAW: sql() raw SQL set expression
// ============================================================================

describe('sql() — raw SQL set expression', () => {
	describe('sql()', () => {
		it('returns an object with SQL_RAW_MARKER and sql properties', () => {
			const expr = sql('now()');
			expect(expr[SQL_RAW_MARKER]).toBe(true);
			expect(expr.sql).toBe('now()');
		});

		it('accepts multi-token SQL fragments', () => {
			const expr = sql('excluded.count + 1');
			expect(expr.sql).toBe('excluded.count + 1');
		});

		it('accepts SQL function calls', () => {
			const expr = sql('gen_random_uuid()');
			expect(expr.sql).toBe('gen_random_uuid()');
		});

		it('throws on empty string', () => {
			expect(() => sql('')).toThrow('sql() requires a non-empty SQL fragment');
		});

		it('throws on whitespace-only string', () => {
			expect(() => sql('   ')).toThrow(
				'sql() requires a non-empty SQL fragment',
			);
		});
	});

	describe('isSqlRaw()', () => {
		it('returns true for sql() results', () => {
			expect(isSqlRaw(sql('now()'))).toBe(true);
		});

		it('returns false for plain strings', () => {
			expect(isSqlRaw('now()')).toBe(false);
		});

		it('returns false for numbers', () => {
			expect(isSqlRaw(42)).toBe(false);
		});

		it('returns false for null', () => {
			expect(isSqlRaw(null)).toBe(false);
		});

		it('returns false for plain objects without marker', () => {
			expect(isSqlRaw({ sql: 'now()' })).toBe(false);
		});

		it('returns false for objects with wrong marker value', () => {
			const fake = { [SQL_RAW_MARKER]: false, sql: 'now()' };
			expect(isSqlRaw(fake)).toBe(false);
		});

		it('returns true for object with correct marker', () => {
			const expr = { [SQL_RAW_MARKER]: true as const, sql: 'now()' };
			expect(isSqlRaw(expr)).toBe(true);
		});
	});
});
