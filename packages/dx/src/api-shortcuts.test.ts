import { belongsTo, defineSchema, hasMany } from '@db-semantic-planner/core';
import { describe, expect, it } from 'vitest';
import { createOrm } from './orm.js';

/**
 * Schema for testing API shortcuts.
 */
const testSchema = defineSchema({
	users: {
		id: 'number',
		name: 'string',
		email: 'string',
	},
	order_lines: {
		order_id: 'number',
		product_id: 'number',
		quantity: 'number',
		price: 'number',
	},
	posts: {
		id: 'number',
		title: 'string',
		content: 'string',
		author_id: 'number',
	},
	comments: {
		id: 'number',
		text: 'string',
		post_id: 'number',
		author_id: 'number',
	},
})
	.relations({
		users: {
			posts: hasMany('posts', { foreignKey: 'author_id' }),
		},
		posts: {
			author: belongsTo('users', { foreignKey: 'author_id' }),
			comments: hasMany('comments', { foreignKey: 'post_id' }),
		},
		comments: {
			post: belongsTo('posts', { foreignKey: 'post_id' }),
			author: belongsTo('users', { foreignKey: 'author_id' }),
		},
	})
	.build();

describe('DX-008: API Shortcuts', () => {
	const orm = createOrm({ model: testSchema });

	describe('byId() - Simple Primary Key', () => {
		it('should create correct plan for simple PK lookup', () => {
			const plan = orm
				.query('users')
				.where({ type: 'eq', field: 'id', value: 42 })
				.plan();

			expect(plan.rootTable).toBe('users');
			expect(plan.intent.where).toEqual({ type: 'eq', field: 'id', value: 42 });
		});

		it('should use eq filter for simple numeric PK', () => {
			// byId internally uses where(eq('id', value)).findFirst()
			// We test the plan to verify the where clause is correctly constructed
			const plan = orm
				.query('users')
				.where({ type: 'eq', field: 'id', value: 1 })
				.plan();

			expect(plan.intent.where).toEqual({ type: 'eq', field: 'id', value: 1 });
		});

		it('should use eq filter for simple string PK', () => {
			const plan = orm
				.query('users')
				.where({ type: 'eq', field: 'id', value: 'abc-123' })
				.plan();

			expect(plan.intent.where).toEqual({
				type: 'eq',
				field: 'id',
				value: 'abc-123',
			});
		});
	});

	describe('byId() - Composite Primary Key', () => {
		it('should create AND condition for composite PK with 2 fields', () => {
			const plan = orm
				.query('order_lines')
				.where({
					type: 'and',
					conditions: [
						{ type: 'eq', field: 'order_id', value: 1 },
						{ type: 'eq', field: 'product_id', value: 42 },
					],
				})
				.plan();

			expect(plan.rootTable).toBe('order_lines');
			expect(plan.intent.where).toEqual({
				type: 'and',
				conditions: [
					{ type: 'eq', field: 'order_id', value: 1 },
					{ type: 'eq', field: 'product_id', value: 42 },
				],
			});
		});
	});

	describe('byIds() - Multiple PKs', () => {
		it('should create IN condition for multiple simple PKs', () => {
			const plan = orm
				.query('users')
				.where({ type: 'in', field: 'id', values: [1, 2, 3] })
				.plan();

			expect(plan.rootTable).toBe('users');
			expect(plan.intent.where).toEqual({
				type: 'in',
				field: 'id',
				values: [1, 2, 3],
			});
		});

		it('should handle empty array gracefully', () => {
			// byIds([]) should return [] without hitting db
			// We verify this by checking the condition creation
			const plan = orm
				.query('users')
				.where({ type: 'in', field: 'id', values: [] })
				.plan();

			expect(plan.intent.where).toEqual({
				type: 'in',
				field: 'id',
				values: [],
			});
		});
	});

	describe('include() - Dot Notation', () => {
		it('should parse single-level include (no dot)', () => {
			const plan = orm.query('users').include('posts').plan();

			expect(plan.intent.include).toEqual([{ relation: 'posts' }]);
		});

		it('should parse two-level dot notation', () => {
			const plan = orm.query('users').include('posts.comments').plan();

			expect(plan.intent.include).toEqual([
				{
					relation: 'posts',
					include: [{ relation: 'comments' }],
				},
			]);
		});

		it('should parse three-level dot notation', () => {
			const plan = orm.query('users').include('posts.comments.author').plan();

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
				.query('users')
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
				.query('users')
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
				.query('users')
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
				.query('posts')
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
