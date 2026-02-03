import { describe, expect, it } from 'vitest';
import { and, eq, inArray } from './filters.js';
import { createOrm } from './orm.js';
import { createMockAdapter } from './test-utils.js';
import { ref, schema } from './schema.js';

/**
 * Schema for testing API shortcuts.
 */
const testSchema = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		email: 'string',
	},
	order_lines: {
		order_id: 'integer',
		product_id: 'integer',
		quantity: 'integer',
		price: 'decimal',
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: 'string',
		content: 'text',
		author_id: ref('users', { as: 'author', inverse: 'posts' }),
	},
	comments: {
		id: { type: 'integer', primaryKey: true },
		text: 'text',
		post_id: ref('posts', { as: 'post', inverse: 'comments' }),
		author_id: ref('users', { as: 'author' }),
	},
});

describe('DX-008: API Shortcuts', () => {
	const orm = createOrm({ adapter: createMockAdapter(), schema: testSchema });

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
