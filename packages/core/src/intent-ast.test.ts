import { describe, expect, it } from 'vitest';
import type {
	AggregateIntent,
	DeleteIntent,
	IncludeIntent,
	InsertIntent,
	MutationIntent,
	OrderByIntent,
	QueryIntent,
	SelectAggregateIntent,
	SelectAllIntent,
	SelectFieldsIntent,
	SelectIntent,
	UpdateIntent,
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
	// Window Functions (P3-A)
	WindowIntent,
} from './intent-ast.js';
import {
	isAggregateWindowFunction,
	isDeleteIntent,
	isInsertIntent,
	isMutationIntent,
	isRankingWindowFunction,
	isSelectAggregate,
	isSelectAll,
	isSelectFields,
	isUpdateIntent,
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
	// Window Functions (P3-A)
	isWindowIntent,
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

			const [i0, i1, i2, i3, i4, i5, i6, i7, i8, i9] = intents;
			expect(isWhereComparison(i0!)).toBe(true);
			expect(isWhereLike(i1!)).toBe(true);
			expect(isWhereIn(i2!)).toBe(true);
			expect(isWhereNull(i3!)).toBe(true);
			expect(isWhereAnd(i4!)).toBe(true);
			expect(isWhereOr(i5!)).toBe(true);
			expect(isWhereNot(i6!)).toBe(true);
			expect(isWhereExists(i7!)).toBe(true);
			expect(isWhereNotExists(i8!)).toBe(true);
			expect(isWhereRelationFilter(i9!)).toBe(true);
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

	describe('AggregateIntent', () => {
		it('should represent count aggregate', () => {
			const agg: AggregateIntent = { function: 'count' };

			expect(agg.function).toBe('count');
			expect(agg.field).toBeUndefined();
		});

		it('should represent count with field', () => {
			const agg: AggregateIntent = { function: 'count', field: 'id' };

			expect(agg.function).toBe('count');
			expect(agg.field).toBe('id');
		});

		it('should represent sum aggregate', () => {
			const agg: AggregateIntent = { function: 'sum', field: 'price' };

			expect(agg.function).toBe('sum');
			expect(agg.field).toBe('price');
		});

		it('should represent avg aggregate', () => {
			const agg: AggregateIntent = { function: 'avg', field: 'rating' };

			expect(agg.function).toBe('avg');
			expect(agg.field).toBe('rating');
		});

		it('should represent min/max aggregates', () => {
			const min: AggregateIntent = { function: 'min', field: 'price' };
			const max: AggregateIntent = { function: 'max', field: 'price' };

			expect(min.function).toBe('min');
			expect(max.function).toBe('max');
		});

		it('should support alias', () => {
			const agg: AggregateIntent = {
				function: 'count',
				as: 'total_count',
			};

			expect(agg.as).toBe('total_count');
		});
	});

	describe('SelectAggregateIntent', () => {
		it('should represent aggregate select', () => {
			const select: SelectAggregateIntent = {
				type: 'aggregate',
				aggregates: [{ function: 'count' }],
			};

			expect(select.type).toBe('aggregate');
			expect(select.aggregates).toHaveLength(1);
			expect(isSelectAggregate(select)).toBe(true);
			expect(isSelectAll(select)).toBe(false);
			expect(isSelectFields(select)).toBe(false);
		});

		it('should support multiple aggregates', () => {
			const select: SelectAggregateIntent = {
				type: 'aggregate',
				aggregates: [
					{ function: 'count' },
					{ function: 'sum', field: 'price' },
					{ function: 'avg', field: 'rating' },
				],
			};

			expect(select.aggregates).toHaveLength(3);
		});

		it('should support fields with aggregates (for GROUP BY)', () => {
			const select: SelectAggregateIntent = {
				type: 'aggregate',
				aggregates: [{ function: 'count' }],
				fields: ['category_id', 'status'],
			};

			expect(select.fields).toEqual(['category_id', 'status']);
		});

		it('should discriminate from other select types', () => {
			const selectAgg: SelectIntent = {
				type: 'aggregate',
				aggregates: [{ function: 'count' }],
			};
			const selectAll: SelectIntent = { type: 'all' };
			const selectFields: SelectIntent = { type: 'fields', fields: ['id'] };

			expect(isSelectAggregate(selectAgg)).toBe(true);
			expect(isSelectAggregate(selectAll)).toBe(false);
			expect(isSelectAggregate(selectFields)).toBe(false);
		});
	});

	describe('QueryIntent - GroupBy', () => {
		it('should support groupBy field', () => {
			const query: QueryIntent = {
				type: 'select',
				from: 'products',
				groupBy: ['category_id'],
			};

			expect(query.groupBy).toEqual(['category_id']);
		});

		it('should support multiple groupBy fields', () => {
			const query: QueryIntent = {
				type: 'select',
				from: 'products',
				groupBy: ['category_id', 'status'],
			};

			expect(query.groupBy).toHaveLength(2);
		});

		it('should combine aggregate select with groupBy', () => {
			const query: QueryIntent = {
				type: 'select',
				from: 'products',
				select: {
					type: 'aggregate',
					aggregates: [{ function: 'count' }],
					fields: ['category_id'],
				},
				groupBy: ['category_id'],
			};

			expect(query.groupBy).toEqual(['category_id']);
			expect(query.select?.type).toBe('aggregate');
		});
	});

	// =========================================================================
	// Mutation Intents (DX-010)
	// =========================================================================

	describe('InsertIntent', () => {
		it('should represent single row insert', () => {
			const insert: InsertIntent = {
				type: 'insert',
				table: 'users',
				values: [{ name: 'Alice', email: 'alice@test.com' }],
			};

			expect(insert.type).toBe('insert');
			expect(insert.table).toBe('users');
			expect(insert.values).toHaveLength(1);
			expect(insert.values[0]).toEqual({
				name: 'Alice',
				email: 'alice@test.com',
			});
		});

		it('should represent bulk insert', () => {
			const insert: InsertIntent = {
				type: 'insert',
				table: 'users',
				values: [{ name: 'Alice' }, { name: 'Bob' }, { name: 'Charlie' }],
			};

			expect(insert.values).toHaveLength(3);
		});

		it('should be identified by type guard', () => {
			const insert: MutationIntent = {
				type: 'insert',
				table: 'users',
				values: [{ name: 'Test' }],
			};

			expect(isInsertIntent(insert)).toBe(true);
			expect(isUpdateIntent(insert)).toBe(false);
			expect(isDeleteIntent(insert)).toBe(false);
			expect(isMutationIntent(insert)).toBe(true);
		});
	});

	describe('UpdateIntent', () => {
		it('should represent update with where clause', () => {
			const update: UpdateIntent = {
				type: 'update',
				table: 'users',
				set: { name: 'Bob', active: true },
				where: {
					kind: 'comparison',
					field: 'id',
					operator: 'eq',
					value: 1,
				},
			};

			expect(update.type).toBe('update');
			expect(update.table).toBe('users');
			expect(update.set).toEqual({ name: 'Bob', active: true });
			expect(update.where?.kind).toBe('comparison');
		});

		it('should support allowAll for full-table updates', () => {
			const update: UpdateIntent = {
				type: 'update',
				table: 'users',
				set: { active: false },
				allowAll: true,
			};

			expect(update.allowAll).toBe(true);
			expect(update.where).toBeUndefined();
		});

		it('should be identified by type guard', () => {
			const update: MutationIntent = {
				type: 'update',
				table: 'users',
				set: { name: 'Test' },
			};

			expect(isUpdateIntent(update)).toBe(true);
			expect(isInsertIntent(update)).toBe(false);
			expect(isDeleteIntent(update)).toBe(false);
			expect(isMutationIntent(update)).toBe(true);
		});
	});

	describe('DeleteIntent', () => {
		it('should represent delete with where clause', () => {
			const del: DeleteIntent = {
				type: 'delete',
				table: 'users',
				where: {
					kind: 'comparison',
					field: 'id',
					operator: 'eq',
					value: 1,
				},
			};

			expect(del.type).toBe('delete');
			expect(del.table).toBe('users');
			expect(del.where?.kind).toBe('comparison');
		});

		it('should support allowAll for full-table deletes', () => {
			const del: DeleteIntent = {
				type: 'delete',
				table: 'users',
				allowAll: true,
			};

			expect(del.allowAll).toBe(true);
			expect(del.where).toBeUndefined();
		});

		it('should support cascade: true for all relations', () => {
			const del: DeleteIntent = {
				type: 'delete',
				table: 'users',
				where: { kind: 'comparison', field: 'id', operator: 'eq', value: 1 },
				cascade: true,
			};

			expect(del.cascade).toBe(true);
		});

		it('should support cascade with specific relations', () => {
			const del: DeleteIntent = {
				type: 'delete',
				table: 'users',
				where: { kind: 'comparison', field: 'id', operator: 'eq', value: 1 },
				cascade: ['posts', 'comments'],
			};

			expect(del.cascade).toEqual(['posts', 'comments']);
		});

		it('should be identified by type guard', () => {
			const del: MutationIntent = {
				type: 'delete',
				table: 'users',
			};

			expect(isDeleteIntent(del)).toBe(true);
			expect(isInsertIntent(del)).toBe(false);
			expect(isUpdateIntent(del)).toBe(false);
			expect(isMutationIntent(del)).toBe(true);
		});
	});

	describe('MutationIntent type guard', () => {
		it('should identify all mutation types', () => {
			const insert: MutationIntent = {
				type: 'insert',
				table: 'users',
				values: [{}],
			};
			const update: MutationIntent = {
				type: 'update',
				table: 'users',
				set: {},
			};
			const del: MutationIntent = { type: 'delete', table: 'users' };

			expect(isMutationIntent(insert)).toBe(true);
			expect(isMutationIntent(update)).toBe(true);
			expect(isMutationIntent(del)).toBe(true);
		});

		it('should not identify query intents as mutations', () => {
			const query: QueryIntent = { type: 'select', from: 'users' };

			expect(isMutationIntent(query as any)).toBe(false);
		});
	});

	// =========================================================================
	// Window Intent Tests (P3-A)
	// =========================================================================

	describe('WindowIntent', () => {
		it('should represent row_number window function', () => {
			const window: WindowIntent = {
				kind: 'window',
				function: 'row_number',
				alias: 'rn',
				over: {
					orderBy: [{ field: 'created_at', direction: 'desc' }],
				},
			};

			expect(window.kind).toBe('window');
			expect(window.function).toBe('row_number');
			expect(window.alias).toBe('rn');
			expect(window.over.orderBy).toHaveLength(1);
			expect(isWindowIntent(window)).toBe(true);
		});

		it('should represent rank window function with partition', () => {
			const window: WindowIntent = {
				kind: 'window',
				function: 'rank',
				alias: 'category_rank',
				over: {
					partitionBy: ['category_id'],
					orderBy: [{ field: 'sales', direction: 'desc' }],
				},
			};

			expect(window.function).toBe('rank');
			expect(window.over.partitionBy).toEqual(['category_id']);
			expect(isWindowIntent(window)).toBe(true);
		});

		it('should represent aggregate window function with field', () => {
			const window: WindowIntent = {
				kind: 'window',
				function: 'sum',
				field: 'amount',
				alias: 'running_total',
				over: {
					partitionBy: ['account_id'],
					orderBy: [{ field: 'date', direction: 'asc' }],
				},
			};

			expect(window.function).toBe('sum');
			expect(window.field).toBe('amount');
			expect(window.alias).toBe('running_total');
			expect(isWindowIntent(window)).toBe(true);
		});

		it('should support empty partitionBy (window over entire result)', () => {
			const window: WindowIntent = {
				kind: 'window',
				function: 'row_number',
				alias: 'global_rn',
				over: {
					partitionBy: [],
					orderBy: [{ field: 'id' }],
				},
			};

			expect(window.over.partitionBy).toEqual([]);
			expect(isWindowIntent(window)).toBe(true);
		});

		it('should support orderBy without direction (defaults to asc)', () => {
			const window: WindowIntent = {
				kind: 'window',
				function: 'dense_rank',
				alias: 'rank',
				over: {
					orderBy: [{ field: 'score' }],
				},
			};

			expect(window.over.orderBy?.[0]!.direction).toBeUndefined();
			expect(isWindowIntent(window)).toBe(true);
		});

		it('should support multiple orderBy fields', () => {
			const window: WindowIntent = {
				kind: 'window',
				function: 'row_number',
				alias: 'rn',
				over: {
					orderBy: [
						{ field: 'category_id', direction: 'asc' },
						{ field: 'price', direction: 'desc' },
					],
				},
			};

			expect(window.over.orderBy).toHaveLength(2);
			expect(isWindowIntent(window)).toBe(true);
		});
	});

	describe('Window function type guards', () => {
		it('isWindowIntent should return true for window intents', () => {
			const window: WindowIntent = {
				kind: 'window',
				function: 'row_number',
				alias: 'rn',
				over: {},
			};

			expect(isWindowIntent(window)).toBe(true);
		});

		it('isWindowIntent should return false for non-window objects', () => {
			expect(isWindowIntent(null)).toBe(false);
			expect(isWindowIntent(undefined)).toBe(false);
			expect(isWindowIntent({})).toBe(false);
			expect(isWindowIntent({ kind: 'comparison' })).toBe(false);
			expect(isWindowIntent({ type: 'select' })).toBe(false);
		});

		it('isAggregateWindowFunction should identify aggregate functions', () => {
			expect(isAggregateWindowFunction('sum')).toBe(true);
			expect(isAggregateWindowFunction('avg')).toBe(true);
			expect(isAggregateWindowFunction('count')).toBe(true);
			expect(isAggregateWindowFunction('min')).toBe(true);
			expect(isAggregateWindowFunction('max')).toBe(true);
			expect(isAggregateWindowFunction('lag')).toBe(true);
			expect(isAggregateWindowFunction('lead')).toBe(true);
		});

		it('isAggregateWindowFunction should return false for ranking functions', () => {
			expect(isAggregateWindowFunction('row_number')).toBe(false);
			expect(isAggregateWindowFunction('rank')).toBe(false);
			expect(isAggregateWindowFunction('dense_rank')).toBe(false);
		});

		it('isRankingWindowFunction should identify ranking functions', () => {
			expect(isRankingWindowFunction('row_number')).toBe(true);
			expect(isRankingWindowFunction('rank')).toBe(true);
			expect(isRankingWindowFunction('dense_rank')).toBe(true);
		});

		it('isRankingWindowFunction should return false for aggregate functions', () => {
			expect(isRankingWindowFunction('sum')).toBe(false);
			expect(isRankingWindowFunction('avg')).toBe(false);
			expect(isRankingWindowFunction('lag')).toBe(false);
		});
	});
});
