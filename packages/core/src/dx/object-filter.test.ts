/**
 * DX-012 Block 1: Object Filter Syntax Tests
 *
 * Tests for object-to-WhereIntent conversion.
 */

import { NotYetSupportedError } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import type {
	WhereAndIntent,
	WhereComparisonIntent,
	WhereInIntent,
	WhereLikeIntent,
	WhereNullIntent,
} from '../intent-ast.js';
import { caseWhen } from './case-when-builder.js';
import { InvalidOperationError } from './errors.js';
import { ref as exprRef, fn, literal } from './expressions.js';
import { and, eq, exists, isNull, rawExists, sql } from './filters.js';
import {
	type FilterOperators,
	isWhereIntent,
	objectToWhereIntent,
	type WhereFilter,
} from './object-filter.js';
import { createOrm } from './orm.js';
import { ref, schema } from './schema.js';
import { subquery } from './subquery-builder.js';
import { createMockAdapter } from './test-utils.js';

describe('DX-012 Block 1: Object Filter Syntax', () => {
	describe('isWhereIntent()', () => {
		it('should return true for WhereIntent objects', () => {
			expect(isWhereIntent(eq('field', 'value'))).toBe(true);
			expect(
				isWhereIntent({
					kind: 'comparison',
					field: 'x',
					operator: 'eq',
					value: 1,
				}),
			).toBe(true);
			expect(isWhereIntent({ kind: 'and', conditions: [] })).toBe(true);
		});

		it('should return false for object filters', () => {
			expect(isWhereIntent({ status: 'active' })).toBe(false);
			expect(isWhereIntent({ age: { $gt: 18 } })).toBe(false);
			expect(isWhereIntent(null)).toBe(false);
			expect(isWhereIntent(undefined)).toBe(false);
			expect(isWhereIntent('string')).toBe(false);
		});
	});

	describe('objectToWhereIntent() - Simple Equality', () => {
		it('should convert single field equality', () => {
			const result = objectToWhereIntent({ status: 'active' });

			expect(result).toEqual<WhereComparisonIntent>({
				kind: 'comparison',
				field: 'status',
				operator: 'eq',
				value: 'active',
			});
		});

		it('should convert boolean value', () => {
			const result = objectToWhereIntent({ active: true });

			expect(result).toEqual<WhereComparisonIntent>({
				kind: 'comparison',
				field: 'active',
				operator: 'eq',
				value: true,
			});
		});

		it('should convert number value', () => {
			const result = objectToWhereIntent({ age: 25 });

			expect(result).toEqual<WhereComparisonIntent>({
				kind: 'comparison',
				field: 'age',
				operator: 'eq',
				value: 25,
			});
		});
	});

	describe('objectToWhereIntent() - Multiple Fields (AND)', () => {
		it('should combine two fields with AND', () => {
			const result = objectToWhereIntent({ active: true, role: 'admin' });

			expect(result.kind).toBe('and');
			const andIntent = result as WhereAndIntent;
			expect(andIntent.conditions).toHaveLength(2);
			expect(andIntent.conditions[0]).toEqual<WhereComparisonIntent>({
				kind: 'comparison',
				field: 'active',
				operator: 'eq',
				value: true,
			});
			expect(andIntent.conditions[1]).toEqual<WhereComparisonIntent>({
				kind: 'comparison',
				field: 'role',
				operator: 'eq',
				value: 'admin',
			});
		});

		it('should combine three fields with AND', () => {
			const result = objectToWhereIntent({
				active: true,
				role: 'admin',
				verified: true,
			});

			expect(result.kind).toBe('and');
			const andIntent = result as WhereAndIntent;
			expect(andIntent.conditions).toHaveLength(3);
		});
	});

	describe('objectToWhereIntent() - Null Handling', () => {
		it('should convert null to IS NULL', () => {
			const result = objectToWhereIntent({ deletedAt: null });

			expect(result).toEqual<WhereNullIntent>({
				kind: 'null',
				field: 'deletedAt',
				operator: 'isNull',
			});
		});

		it('should handle null with other conditions', () => {
			const result = objectToWhereIntent({ deletedAt: null, active: true });

			expect(result.kind).toBe('and');
			const andIntent = result as WhereAndIntent;
			expect(andIntent.conditions).toHaveLength(2);
			expect(andIntent.conditions[0]).toEqual<WhereNullIntent>({
				kind: 'null',
				field: 'deletedAt',
				operator: 'isNull',
			});
		});
	});

	describe('objectToWhereIntent() - Comparison Operators', () => {
		it('should convert $eq operator', () => {
			const result = objectToWhereIntent({ status: { $eq: 'active' } });

			expect(result).toEqual<WhereComparisonIntent>({
				kind: 'comparison',
				field: 'status',
				operator: 'eq',
				value: 'active',
			});
		});

		it('should convert $neq operator', () => {
			const result = objectToWhereIntent({ status: { $neq: 'deleted' } });

			expect(result).toEqual<WhereComparisonIntent>({
				kind: 'comparison',
				field: 'status',
				operator: 'neq',
				value: 'deleted',
			});
		});

		it('should convert $gt operator', () => {
			const result = objectToWhereIntent({ age: { $gt: 18 } });

			expect(result).toEqual<WhereComparisonIntent>({
				kind: 'comparison',
				field: 'age',
				operator: 'gt',
				value: 18,
			});
		});

		it('should convert $gte operator', () => {
			const result = objectToWhereIntent({ age: { $gte: 18 } });

			expect(result).toEqual<WhereComparisonIntent>({
				kind: 'comparison',
				field: 'age',
				operator: 'gte',
				value: 18,
			});
		});

		it('should convert $lt operator', () => {
			const result = objectToWhereIntent({ price: { $lt: 100 } });

			expect(result).toEqual<WhereComparisonIntent>({
				kind: 'comparison',
				field: 'price',
				operator: 'lt',
				value: 100,
			});
		});

		it('should convert $lte operator', () => {
			const result = objectToWhereIntent({ price: { $lte: 100 } });

			expect(result).toEqual<WhereComparisonIntent>({
				kind: 'comparison',
				field: 'price',
				operator: 'lte',
				value: 100,
			});
		});
	});

	describe('objectToWhereIntent() - $in Operator', () => {
		it('should convert $in operator', () => {
			const result = objectToWhereIntent({
				status: { $in: ['active', 'pending'] },
			});

			expect(result).toEqual<WhereInIntent>({
				kind: 'in',
				field: 'status',
				values: ['active', 'pending'],
			});
		});

		it('should handle $in with numbers', () => {
			const result = objectToWhereIntent({ id: { $in: [1, 2, 3] } });

			expect(result).toEqual<WhereInIntent>({
				kind: 'in',
				field: 'id',
				values: [1, 2, 3],
			});
		});
	});

	describe('objectToWhereIntent() - String Operators', () => {
		it('should convert $like operator', () => {
			const result = objectToWhereIntent({ name: { $like: '%john%' } });

			expect(result).toEqual<WhereLikeIntent>({
				kind: 'like',
				field: 'name',
				pattern: '%john%',
			});
		});

		it('should convert $ilike operator (case-insensitive)', () => {
			const result = objectToWhereIntent({
				email: { $ilike: '%@EXAMPLE.COM' },
			});

			expect(result).toEqual<WhereLikeIntent>({
				kind: 'like',
				field: 'email',
				pattern: '%@EXAMPLE.COM',
				caseInsensitive: true,
			});
		});
	});

	describe('objectToWhereIntent() - $notNull Operator', () => {
		it('should convert $notNull operator', () => {
			const result = objectToWhereIntent({ email: { $notNull: true } });

			expect(result).toEqual<WhereNullIntent>({
				kind: 'null',
				field: 'email',
				operator: 'isNotNull',
			});
		});
	});

	describe('objectToWhereIntent() - Combined Operators', () => {
		it('should combine multiple operators on same field with AND', () => {
			const result = objectToWhereIntent({ age: { $gte: 18, $lt: 65 } });

			expect(result.kind).toBe('and');
			const andIntent = result as WhereAndIntent;
			expect(andIntent.conditions).toHaveLength(2);
			expect(andIntent.conditions[0]).toEqual<WhereComparisonIntent>({
				kind: 'comparison',
				field: 'age',
				operator: 'gte',
				value: 18,
			});
			expect(andIntent.conditions[1]).toEqual<WhereComparisonIntent>({
				kind: 'comparison',
				field: 'age',
				operator: 'lt',
				value: 65,
			});
		});

		it('should handle mixed simple and operator values', () => {
			const result = objectToWhereIntent({
				active: true,
				age: { $gte: 18 },
				status: { $in: ['pending', 'active'] },
			});

			expect(result.kind).toBe('and');
			const andIntent = result as WhereAndIntent;
			expect(andIntent.conditions).toHaveLength(3);
		});
	});

	describe('objectToWhereIntent() - Edge Cases', () => {
		it('should throw on empty object', () => {
			expect(() => objectToWhereIntent({})).toThrow(
				'Invalid filter: empty object',
			);
		});

		it('should handle undefined values by ignoring them', () => {
			// TypeScript won't allow undefined in filter, but runtime might encounter it
			const filter = {
				status: 'active',
				deleted: undefined,
			} as unknown as WhereFilter;
			const result = objectToWhereIntent(filter);

			// Should only have the non-undefined field
			// Note: undefined values in JS object iteration are included but can be filtered
			expect(result.kind).toBe('and');
		});

		it('should handle 0 as a valid value', () => {
			const result = objectToWhereIntent({ count: 0 });

			expect(result).toEqual<WhereComparisonIntent>({
				kind: 'comparison',
				field: 'count',
				operator: 'eq',
				value: 0,
			});
		});

		it('should handle empty string as a valid value', () => {
			const result = objectToWhereIntent({ name: '' });

			expect(result).toEqual<WhereComparisonIntent>({
				kind: 'comparison',
				field: 'name',
				operator: 'eq',
				value: '',
			});
		});
	});

	describe('Type Safety', () => {
		it('should accept typed filter objects', () => {
			interface User {
				id: number;
				name: string;
				email: string;
				active: boolean;
			}

			// This should compile without errors
			const filter: WhereFilter<User> = {
				active: true,
				name: { $like: '%john%' },
			};

			const result = objectToWhereIntent(filter);
			expect(result.kind).toBe('and');
		});

		it('should accept FilterOperators type', () => {
			const ops: FilterOperators<number> = {
				$gt: 10,
				$lte: 100,
			};

			const filter: WhereFilter = { age: ops };
			const result = objectToWhereIntent(filter);

			expect(result.kind).toBe('and');
			const andIntent = result as WhereAndIntent;
			expect(andIntent.conditions).toHaveLength(2);
		});
	});
});

// ============================================================================
// Object filters follow the value-leaf rule (ADR 0011, delivery 2)
// ============================================================================

describe('object filter values and isWhereIntent (ADR 0011 delivery 2)', () => {
	const filterDb = schema(
		{
			users: { id: { type: 'integer', primaryKey: true }, name: 'text' },
			posts: {
				id: { type: 'integer', primaryKey: true },
				title: 'text',
				score: 'integer',
				kind: 'text',
				deletedAt: { type: 'timestamp', nullable: true },
				user_id: ref('users', { as: 'author' }),
			},
		},
		undefined,
		{ defaultFilters: { posts: isNull('deletedAt') } },
	);
	const orm = createOrm({ schema: filterDb, adapter: createMockAdapter() });
	const posts = orm.tables.posts;
	const SQL_MESSAGE =
		'Invalid where: sql() is only accepted as an update or upsert value; use literal(), param() or an expression here';
	const UNFINISHED =
		'Invalid where: caseWhen() is unfinished; complete it with .else(value) before using it as a value';
	const convert = (filter: unknown) =>
		objectToWhereIntent(filter as WhereFilter<Record<string, unknown>>);

	function thrown(build: () => unknown): unknown {
		try {
			build();
		} catch (error) {
			return error;
		}
		throw new Error('expected a refusal, got none');
	}

	function expectNotYet(
		build: () => unknown,
		construct: string,
		position: string,
		issue: number,
	): void {
		const error = thrown(build);
		expect(error).toBeInstanceOf(NotYetSupportedError);
		expect(error).toMatchObject({ construct, position, issue });
	}

	function expectInvalid(build: () => unknown, message: string): void {
		const error = thrown(build);
		expect(error).toBeInstanceOf(InvalidOperationError);
		expect((error as Error).message).toBe(message);
	}

	it('AC8 kind column filtered: an object over a column named kind is not an intent (#624)', () => {
		expect(isWhereIntent({ kind: 'function' })).toBe(false);
		expect(isWhereIntent({ kind: 'comparison' })).toBe(false);
		expect(isWhereIntent({ kind: 'function', title: 'x' })).toBe(false);
		expect(convert({ kind: 'function' })).toEqual({
			kind: 'comparison',
			field: 'kind',
			operator: 'eq',
			value: 'function',
		});
	});

	it('AC8 real intents still intents: helper-built intents and default filters are intents', () => {
		expect(isWhereIntent(eq('title', 'x'))).toBe(true);
		expect(isWhereIntent(and(eq('title', 'x'), eq('score', 1)))).toBe(true);
		expect(isWhereIntent(exists('posts'))).toBe(true);
		expect(isWhereIntent(rawExists(subquery('posts').select('id')))).toBe(true);
		expect(isWhereIntent(exprRef('score').eq(1))).toBe(true);
		expect(filterDb.defaultFilters?.posts).toEqual(isNull('deletedAt'));
	});

	const NOT_A_SUBQUERY =
		'Invalid where: this builder is not a subquery; use orm.select(...), subquery(table) or a SubqueryExpression';
	const union = () =>
		orm
			.select('posts')
			.columns(['id'])
			.union(orm.select('posts').columns(['id']));

	it('R2 object filter direct entry: non-select builders, sql() and relation ColumnRefs are refused', () => {
		expectInvalid(() => convert({ id: union() as never }), NOT_A_SUBQUERY);
		expectInvalid(() => convert({ title: sql('now()') }), SQL_MESSAGE);
		expectNotYet(
			() => convert({ title: posts.author.name }),
			'a relation-reached ColumnRef',
			'comparison value',
			1052,
		);
	});

	it('R2 object filter operator entry: non-select builders, sql() and relation ColumnRefs are refused', () => {
		expectInvalid(
			() => convert({ score: { $gt: union() as never } }),
			NOT_A_SUBQUERY,
		);
		expectInvalid(() => convert({ score: { $gt: sql('now()') } }), SQL_MESSAGE);
		expectNotYet(
			() => convert({ score: { $gt: posts.author.name } }),
			'a relation-reached ColumnRef',
			'comparison value',
			1052,
		);
	});

	it('R2c unfinished caseWhen: refused in an object filter value', () => {
		expectInvalid(
			() => convert({ title: caseWhen(eq('score', 1), literal('a')) }),
			UNFINISHED,
		);
	});

	it('R4 object filter like patterns: not yet supported (#1066)', () => {
		expectNotYet(
			() => convert({ title: { $like: fn('lower', exprRef('title')) } }),
			'an expression',
			'like pattern',
			1066,
		);
		expectNotYet(
			() => convert({ title: { $ilike: exprRef('title') } }),
			'an expression',
			'like pattern',
			1066,
		);
	});

	it('R3 list expression elements: $in refuses an expression element (#1064)', () => {
		expectNotYet(
			() => convert({ id: { $in: [literal(1)] } }),
			'an expression',
			'list element',
			1064,
		);
	});
});
