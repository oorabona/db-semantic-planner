import { describe, expect, it } from 'vitest';
import type {
	IncludeIntent,
	OrderByIntent,
	QueryIntent,
	SelectAllIntent,
	SelectFieldsIntent,
	SelectIntent,
	WhereAndIntent,
	WhereComparisonIntent,
	WhereExistsIntent,
	WhereInIntent,
	WhereIntent,
	WhereLikeIntent,
	WhereNotExistsIntent,
	WhereNotIntent,
	WhereNullIntent,
	WhereOrIntent,
	WhereRelationFilterIntent,
} from './intent-ast.js';
import {
	isSelectAll,
	isSelectFields,
	isWhereAnd,
	isWhereComparison,
	isWhereExists,
	isWhereIn,
	isWhereLike,
	isWhereLogical,
	isWhereNot,
	isWhereNotExists,
	isWhereNull,
	isWhereOr,
	isWhereRelationBased,
	isWhereRelationFilter,
} from './intent-ast.js';

describe('IntentAST', () => {
	describe('SelectIntent', () => {
		it('should represent select all', () => {
			const select: SelectAllIntent = { type: 'all' };

			expect(select.type).toBe('all');
			expect(isSelectAll(select)).toBe(true);
			expect(isSelectFields(select)).toBe(false);
		});

		it('should represent select fields', () => {
			const select: SelectFieldsIntent = {
				type: 'fields',
				fields: ['id', 'name', 'email'],
			};

			expect(select.type).toBe('fields');
			expect(select.fields).toEqual(['id', 'name', 'email']);
			expect(isSelectAll(select)).toBe(false);
			expect(isSelectFields(select)).toBe(true);
		});

		it('should discriminate between select types', () => {
			const selectAll: SelectIntent = { type: 'all' };
			const selectFields: SelectIntent = { type: 'fields', fields: ['id'] };

			// Type narrowing works correctly
			if (isSelectAll(selectAll)) {
				expect(selectAll.type).toBe('all');
			}
			if (isSelectFields(selectFields)) {
				expect(selectFields.fields).toEqual(['id']);
			}
		});
	});

	describe('WhereIntent - Comparison', () => {
		it('should represent eq comparison', () => {
			const where: WhereComparisonIntent = {
				kind: 'comparison',
				field: 'status',
				operator: 'eq',
				value: 'active',
			};

			expect(where.kind).toBe('comparison');
			expect(where.operator).toBe('eq');
			expect(isWhereComparison(where)).toBe(true);
		});

		it('should represent numeric comparisons', () => {
			const gt: WhereComparisonIntent = {
				kind: 'comparison',
				field: 'age',
				operator: 'gt',
				value: 18,
			};
			const lte: WhereComparisonIntent = {
				kind: 'comparison',
				field: 'price',
				operator: 'lte',
				value: 100.5,
			};

			expect(gt.operator).toBe('gt');
			expect(lte.operator).toBe('lte');
		});
	});

	describe('WhereIntent - Like', () => {
		it('should represent like pattern', () => {
			const where: WhereLikeIntent = {
				kind: 'like',
				field: 'name',
				pattern: '%john%',
			};

			expect(where.kind).toBe('like');
			expect(where.pattern).toBe('%john%');
			expect(isWhereLike(where)).toBe(true);
		});

		it('should support case-insensitive matching', () => {
			const where: WhereLikeIntent = {
				kind: 'like',
				field: 'email',
				pattern: '%@example.com',
				caseInsensitive: true,
			};

			expect(where.caseInsensitive).toBe(true);
		});
	});

	describe('WhereIntent - In', () => {
		it('should represent in array', () => {
			const where: WhereInIntent = {
				kind: 'in',
				field: 'status',
				values: ['active', 'pending', 'review'],
			};

			expect(where.kind).toBe('in');
			expect(where.values).toHaveLength(3);
			expect(isWhereIn(where)).toBe(true);
		});

		it('should support numeric values', () => {
			const where: WhereInIntent = {
				kind: 'in',
				field: 'id',
				values: [1, 2, 3, 4, 5],
			};

			expect(where.values).toEqual([1, 2, 3, 4, 5]);
		});
	});

	describe('WhereIntent - Null', () => {
		it('should represent isNull', () => {
			const where: WhereNullIntent = {
				kind: 'null',
				field: 'deletedAt',
				operator: 'isNull',
			};

			expect(where.kind).toBe('null');
			expect(where.operator).toBe('isNull');
			expect(isWhereNull(where)).toBe(true);
		});

		it('should represent isNotNull', () => {
			const where: WhereNullIntent = {
				kind: 'null',
				field: 'verifiedAt',
				operator: 'isNotNull',
			};

			expect(where.operator).toBe('isNotNull');
		});
	});

	describe('WhereIntent - Logical', () => {
		it('should represent AND conditions', () => {
			const where: WhereAndIntent = {
				kind: 'and',
				conditions: [
					{
						kind: 'comparison',
						field: 'status',
						operator: 'eq',
						value: 'active',
					},
					{ kind: 'comparison', field: 'age', operator: 'gte', value: 18 },
				],
			};

			expect(where.kind).toBe('and');
			expect(where.conditions).toHaveLength(2);
			expect(isWhereAnd(where)).toBe(true);
			expect(isWhereLogical(where)).toBe(true);
		});

		it('should represent OR conditions', () => {
			const where: WhereOrIntent = {
				kind: 'or',
				conditions: [
					{ kind: 'comparison', field: 'role', operator: 'eq', value: 'admin' },
					{
						kind: 'comparison',
						field: 'role',
						operator: 'eq',
						value: 'moderator',
					},
				],
			};

			expect(where.kind).toBe('or');
			expect(isWhereOr(where)).toBe(true);
			expect(isWhereLogical(where)).toBe(true);
		});

		it('should represent NOT condition', () => {
			const where: WhereNotIntent = {
				kind: 'not',
				condition: {
					kind: 'comparison',
					field: 'banned',
					operator: 'eq',
					value: true,
				},
			};

			expect(where.kind).toBe('not');
			expect(isWhereNot(where)).toBe(true);
			expect(isWhereLogical(where)).toBe(true);
		});

		it('should support nested logical conditions', () => {
			const where: WhereAndIntent = {
				kind: 'and',
				conditions: [
					{ kind: 'comparison', field: 'active', operator: 'eq', value: true },
					{
						kind: 'or',
						conditions: [
							{
								kind: 'comparison',
								field: 'role',
								operator: 'eq',
								value: 'admin',
							},
							{
								kind: 'comparison',
								field: 'role',
								operator: 'eq',
								value: 'mod',
							},
						],
					},
				],
			};

			expect(where.conditions[1]?.kind).toBe('or');
		});
	});

	describe('WhereIntent - Relation (EXISTS)', () => {
		it('should represent exists filter', () => {
			const where: WhereExistsIntent = {
				kind: 'exists',
				relation: 'posts',
			};

			expect(where.kind).toBe('exists');
			expect(where.relation).toBe('posts');
			expect(isWhereExists(where)).toBe(true);
			expect(isWhereRelationBased(where)).toBe(true);
		});

		it('should represent exists with nested where', () => {
			// Q1 golden test case: Find users who have at least one published post
			const where: WhereExistsIntent = {
				kind: 'exists',
				relation: 'posts',
				where: {
					kind: 'comparison',
					field: 'status',
					operator: 'eq',
					value: 'published',
				},
			};

			expect(where.where).toBeDefined();
			expect((where.where as WhereComparisonIntent).field).toBe('status');
		});

		it('should represent notExists filter', () => {
			const where: WhereNotExistsIntent = {
				kind: 'notExists',
				relation: 'orders',
			};

			expect(where.kind).toBe('notExists');
			expect(isWhereNotExists(where)).toBe(true);
			expect(isWhereRelationBased(where)).toBe(true);
		});
	});

	describe('WhereIntent - RelationFilter', () => {
		it('should represent relationFilter with some mode', () => {
			const where: WhereRelationFilterIntent = {
				kind: 'relationFilter',
				relation: 'posts',
				where: {
					kind: 'comparison',
					field: 'views',
					operator: 'gt',
					value: 1000,
				},
				mode: 'some',
			};

			expect(where.kind).toBe('relationFilter');
			expect(where.mode).toBe('some');
			expect(isWhereRelationFilter(where)).toBe(true);
			expect(isWhereRelationBased(where)).toBe(true);
		});

		it('should represent relationFilter with every mode', () => {
			const where: WhereRelationFilterIntent = {
				kind: 'relationFilter',
				relation: 'comments',
				where: {
					kind: 'comparison',
					field: 'approved',
					operator: 'eq',
					value: true,
				},
				mode: 'every',
			};

			expect(where.mode).toBe('every');
		});

		it('should represent relationFilter with none mode', () => {
			const where: WhereRelationFilterIntent = {
				kind: 'relationFilter',
				relation: 'reports',
				where: {
					kind: 'comparison',
					field: 'resolved',
					operator: 'eq',
					value: false,
				},
				mode: 'none',
			};

			expect(where.mode).toBe('none');
		});
	});

	describe('IncludeIntent', () => {
		it('should represent basic include', () => {
			const include: IncludeIntent = {
				relation: 'posts',
			};

			expect(include.relation).toBe('posts');
		});

		it('should represent include with select', () => {
			const include: IncludeIntent = {
				relation: 'posts',
				select: { type: 'fields', fields: ['id', 'title'] },
			};

			expect(include.select?.type).toBe('fields');
		});

		it('should represent include with where', () => {
			const include: IncludeIntent = {
				relation: 'posts',
				where: {
					kind: 'comparison',
					field: 'status',
					operator: 'eq',
					value: 'published',
				},
			};

			expect(include.where?.kind).toBe('comparison');
		});

		it('should represent nested includes', () => {
			const include: IncludeIntent = {
				relation: 'posts',
				include: [
					{ relation: 'comments' },
					{
						relation: 'tags',
						select: { type: 'fields', fields: ['name'] },
					},
				],
			};

			expect(include.include).toHaveLength(2);
			expect(include.include?.[0]?.relation).toBe('comments');
			expect(include.include?.[1]?.relation).toBe('tags');
		});

		it('should support via for disambiguation', () => {
			const include: IncludeIntent = {
				relation: 'users',
				via: 'author', // When user has both 'author' and 'editor' relations
			};

			expect(include.via).toBe('author');
		});
	});

	describe('OrderByIntent', () => {
		it('should represent ascending sort', () => {
			const orderBy: OrderByIntent = {
				field: 'createdAt',
				direction: 'asc',
			};

			expect(orderBy.direction).toBe('asc');
		});

		it('should represent descending sort', () => {
			const orderBy: OrderByIntent = {
				field: 'updatedAt',
				direction: 'desc',
			};

			expect(orderBy.direction).toBe('desc');
		});

		it('should support nulls position', () => {
			const orderBy: OrderByIntent = {
				field: 'completedAt',
				direction: 'asc',
				nulls: 'last',
			};

			expect(orderBy.nulls).toBe('last');
		});
	});

	describe('QueryIntent', () => {
		it('should represent minimal select query', () => {
			const query: QueryIntent = {
				type: 'select',
				from: 'users',
			};

			expect(query.type).toBe('select');
			expect(query.from).toBe('users');
		});

		it('should represent full select query', () => {
			const query: QueryIntent = {
				type: 'select',
				from: 'users',
				select: { type: 'fields', fields: ['id', 'name', 'email'] },
				where: {
					kind: 'and',
					conditions: [
						{
							kind: 'comparison',
							field: 'active',
							operator: 'eq',
							value: true,
						},
						{ kind: 'null', field: 'deletedAt', operator: 'isNull' },
					],
				},
				include: [
					{
						relation: 'posts',
						where: {
							kind: 'comparison',
							field: 'status',
							operator: 'eq',
							value: 'published',
						},
					},
				],
				orderBy: [
					{ field: 'createdAt', direction: 'desc' },
					{ field: 'name', direction: 'asc' },
				],
				limit: 10,
				offset: 20,
			};

			expect(query.select?.type).toBe('fields');
			expect(query.where?.kind).toBe('and');
			expect(query.include).toHaveLength(1);
			expect(query.orderBy).toHaveLength(2);
			expect(query.limit).toBe(10);
			expect(query.offset).toBe(20);
		});

		it('should represent Q1 golden test query: users with published posts', () => {
			// Q1: Find users who have at least one published post
			// Expected: EXISTS subquery strategy (no row explosion)
			const query: QueryIntent = {
				type: 'select',
				from: 'users',
				select: { type: 'fields', fields: ['id', 'name'] },
				where: {
					kind: 'exists',
					relation: 'posts',
					where: {
						kind: 'comparison',
						field: 'status',
						operator: 'eq',
						value: 'published',
					},
				},
			};

			expect(query.from).toBe('users');
			expect(query.where?.kind).toBe('exists');
			expect((query.where as WhereExistsIntent).relation).toBe('posts');
		});
	});

	describe('Type Guards', () => {
		it('should correctly identify all where intent kinds', () => {
			const intents: WhereIntent[] = [
				{ kind: 'comparison', field: 'a', operator: 'eq', value: 1 },
				{ kind: 'like', field: 'b', pattern: '%x%' },
				{ kind: 'in', field: 'c', values: [1, 2] },
				{ kind: 'null', field: 'd', operator: 'isNull' },
				{ kind: 'and', conditions: [] },
				{ kind: 'or', conditions: [] },
				{
					kind: 'not',
					condition: { kind: 'null', field: 'e', operator: 'isNull' },
				},
				{ kind: 'exists', relation: 'posts' },
				{ kind: 'notExists', relation: 'comments' },
				{
					kind: 'relationFilter',
					relation: 'tags',
					where: { kind: 'comparison', field: 'f', operator: 'eq', value: 'x' },
					mode: 'some',
				},
			];

			expect(isWhereComparison(intents[0]!)).toBe(true);
			expect(isWhereLike(intents[1]!)).toBe(true);
			expect(isWhereIn(intents[2]!)).toBe(true);
			expect(isWhereNull(intents[3]!)).toBe(true);
			expect(isWhereAnd(intents[4]!)).toBe(true);
			expect(isWhereOr(intents[5]!)).toBe(true);
			expect(isWhereNot(intents[6]!)).toBe(true);
			expect(isWhereExists(intents[7]!)).toBe(true);
			expect(isWhereNotExists(intents[8]!)).toBe(true);
			expect(isWhereRelationFilter(intents[9]!)).toBe(true);
		});

		it('should correctly identify logical vs non-logical intents', () => {
			const logical: WhereIntent[] = [
				{ kind: 'and', conditions: [] },
				{ kind: 'or', conditions: [] },
				{
					kind: 'not',
					condition: { kind: 'null', field: 'x', operator: 'isNull' },
				},
			];
			const nonLogical: WhereIntent[] = [
				{ kind: 'comparison', field: 'a', operator: 'eq', value: 1 },
				{ kind: 'exists', relation: 'posts' },
			];

			for (const intent of logical) {
				expect(isWhereLogical(intent)).toBe(true);
			}
			for (const intent of nonLogical) {
				expect(isWhereLogical(intent)).toBe(false);
			}
		});

		it('should correctly identify relation-based intents', () => {
			const relationBased: WhereIntent[] = [
				{ kind: 'exists', relation: 'posts' },
				{ kind: 'notExists', relation: 'comments' },
				{
					kind: 'relationFilter',
					relation: 'tags',
					where: { kind: 'comparison', field: 'f', operator: 'eq', value: 'x' },
					mode: 'some',
				},
			];
			const nonRelation: WhereIntent[] = [
				{ kind: 'comparison', field: 'a', operator: 'eq', value: 1 },
				{ kind: 'and', conditions: [] },
			];

			for (const intent of relationBased) {
				expect(isWhereRelationBased(intent)).toBe(true);
			}
			for (const intent of nonRelation) {
				expect(isWhereRelationBased(intent)).toBe(false);
			}
		});
	});
});
