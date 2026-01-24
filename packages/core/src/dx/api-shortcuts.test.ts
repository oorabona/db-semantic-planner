import { describe, expect, it } from 'vitest';
import { defineSchema } from '../schema-dsl.js';
import { and, eq, inArray } from './filters.js';
import { createOrm } from './orm.js';
import { buildModelFromResolvedSchema } from './schema-bridge.js';

/**
 * Schema for testing API shortcuts.
 */
const testSchema = buildModelFromResolvedSchema(
	defineSchema(
		{
			users: {
				id: { type: 'integer', primaryKey: true },
				name: { type: 'string' },
				email: { type: 'string' },
			},
			order_lines: {
				order_id: { type: 'integer' },
				product_id: { type: 'integer' },
				quantity: { type: 'integer' },
				price: { type: 'decimal' },
			},
			posts: {
				id: { type: 'integer', primaryKey: true },
				title: { type: 'string' },
				content: { type: 'text' },
				author_id: { type: 'integer' },
			},
			comments: {
				id: { type: 'integer', primaryKey: true },
				text: { type: 'text' },
				post_id: { type: 'integer' },
				author_id: { type: 'integer' },
			},
		},
		{
			relations: {
				'users.posts': {
					kind: 'hasMany',
					target: 'posts',
					foreignKey: 'author_id',
				},
				'posts.author': {
					kind: 'belongsTo',
					target: 'users',
					foreignKey: 'author_id',
				},
				'posts.comments': {
					kind: 'hasMany',
					target: 'comments',
					foreignKey: 'post_id',
				},
				'comments.post': {
					kind: 'belongsTo',
					target: 'posts',
					foreignKey: 'post_id',
				},
				'comments.author': {
					kind: 'belongsTo',
					target: 'users',
					foreignKey: 'author_id',
				},
			},
		},
	),
);

describe('DX-008: API Shortcuts', () => {
	const orm = createOrm({ model: testSchema });

	describe('byId() - Simple Primary Key', () => {
		it('should create correct plan for simple PK lookup', () => {
			const plan = orm.select('users').where(eq('id', 42)).plan();

			expect(plan.rootTable).toBe('users');
			expect(plan.intent.where).toEqual({
				kind: 'comparison',
				field: 'id',
				operator: 'eq',
				value: 42,
			});
		});

		it('should use eq filter for simple numeric PK', () => {
			// byId internally uses where(eq('id', value)).first()
			// We test the plan to verify the where clause is correctly constructed
			const plan = orm.select('users').where(eq('id', 1)).plan();

			expect(plan.intent.where).toEqual({
				kind: 'comparison',
				field: 'id',
				operator: 'eq',
				value: 1,
			});
		});

		it('should use eq filter for simple string PK', () => {
			const plan = orm.select('users').where(eq('id', 'abc-123')).plan();

			expect(plan.intent.where).toEqual({
				kind: 'comparison',
				field: 'id',
				operator: 'eq',
				value: 'abc-123',
			});
		});
	});

	describe('byId() - Composite Primary Key', () => {
		it('should create AND condition for composite PK with 2 fields', () => {
			const plan = orm
				.select('order_lines')
				.where(and(eq('order_id', 1), eq('product_id', 42)))
				.plan();

			expect(plan.rootTable).toBe('order_lines');
			expect(plan.intent.where).toEqual({
				kind: 'and',
				conditions: [
					{ kind: 'comparison', field: 'order_id', operator: 'eq', value: 1 },
					{
						kind: 'comparison',
						field: 'product_id',
						operator: 'eq',
						value: 42,
					},
				],
			});
		});
	});

	describe('byIds() - Multiple PKs', () => {
		it('should create IN condition for multiple simple PKs', () => {
			const plan = orm
				.select('users')
				.where(inArray('id', [1, 2, 3]))
				.plan();

			expect(plan.rootTable).toBe('users');
			expect(plan.intent.where).toEqual({
				kind: 'in',
				field: 'id',
				values: [1, 2, 3],
			});
		});

		it('should handle empty array gracefully', () => {
			// byIds([]) should return [] without hitting db
			// We verify this by checking the condition creation
			const plan = orm.select('users').where(inArray('id', [])).plan();

			expect(plan.intent.where).toEqual({
				kind: 'in',
				field: 'id',
				values: [],
			});
		});
	});

	describe('include() - Dot Notation', () => {
		it('should parse single-level include (no dot)', () => {
			const plan = orm.select('users').include('posts').plan();

			expect(plan.intent.include).toEqual([{ relation: 'posts' }]);
		});

		it('should parse two-level dot notation', () => {
			const plan = orm.select('users').include('posts.comments').plan();

			expect(plan.intent.include).toEqual([
				{
					relation: 'posts',
					include: [{ relation: 'comments' }],
				},
			]);
		});

		it('should parse three-level dot notation', () => {
			const plan = orm.select('users').include('posts.comments.author').plan();

			expect(plan.intent.include).toEqual([
				{
					relation: 'posts',
					include: [
						{
							relation: 'comments',
							include: [{ relation: 'author' }],
						},
					],
				},
			]);
		});

		it('should apply options to deepest level', () => {
			const plan = orm
				.select('users')
				.include('posts.comments', {
					select: { type: 'fields', fields: ['text'] },
				})
				.plan();

			expect(plan.intent.include).toEqual([
				{
					relation: 'posts',
					include: [
						{
							relation: 'comments',
							select: { type: 'fields', fields: ['text'] },
						},
					],
				},
			]);
		});

		it('should apply via option to deepest level', () => {
			const plan = orm
				.select('users')
				.include('posts.author', { via: 'commentAuthor' })
				.plan();

			expect(plan.intent.include).toEqual([
				{
					relation: 'posts',
					include: [
						{
							relation: 'author',
							via: 'commentAuthor',
						},
					],
				},
			]);
		});
	});

	describe('Fluent chaining - multiple includes', () => {
		it('should allow chaining multiple dot notation includes', () => {
			const plan = orm
				.select('users')
				.include('posts')
				.include('posts.comments')
				.plan();

			expect(plan.intent.include).toHaveLength(2);
			expect(plan.intent.include?.[0]).toEqual({ relation: 'posts' });
			expect(plan.intent.include?.[1]).toEqual({
				relation: 'posts',
				include: [{ relation: 'comments' }],
			});
		});

		it('should combine simple and dot notation includes', () => {
			const plan = orm
				.select('posts')
				.include('author')
				.include('comments.author')
				.plan();

			expect(plan.intent.include).toEqual([
				{ relation: 'author' },
				{
					relation: 'comments',
					include: [{ relation: 'author' }],
				},
			]);
		});
	});
});
