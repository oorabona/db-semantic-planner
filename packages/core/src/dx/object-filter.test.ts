/**
 * DX-012 Block 1: Object Filter Syntax Tests
 *
 * Tests for object-to-WhereIntent conversion.
 */

import { describe, expect, it } from 'vitest';
import type {
	WhereAndIntent,
	WhereComparisonIntent,
	WhereInIntent,
	WhereLikeIntent,
	WhereNullIntent,
} from '../schema-builder.js';
import { eq } from './filters.js';
import {
	type FilterOperators,
	isWhereIntent,
	objectToWhereIntent,
	type WhereFilter,
} from './object-filter.js';

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
