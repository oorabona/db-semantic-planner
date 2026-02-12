// @ts-nocheck — coverage test: runtime assertions on AST nodes
/**
 * Coverage tests for schema.ts
 *
 * Focuses on edge cases and branches not covered by schema.test.ts
 */

import { describe, expect, it } from 'vitest';
import { isRef, ref, SchemaValidationError, schema } from './schema.js';

describe('schema coverage', () => {
	describe('ref()', () => {
		it('should create ref with no options', () => {
			const result = ref('users');
			expect(result.__brand).toBe('ref');
			expect(result.target).toBe('users');
			expect(result.options).toEqual({});
		});

		it('should create ref with nullable option', () => {
			const result = ref('users', { nullable: true });
			expect(result.options).toEqual({ nullable: true });
		});

		it('should create ref with unique option', () => {
			const result = ref('users', { unique: true });
			expect(result.options).toEqual({ unique: true });
		});

		it('should create ref with onDelete option', () => {
			const result = ref('users', { onDelete: 'CASCADE' });
			expect(result.options).toEqual({ onDelete: 'CASCADE' });
		});

		it('should create ref with onUpdate option', () => {
			const result = ref('users', { onUpdate: 'CASCADE' });
			expect(result.options).toEqual({ onUpdate: 'CASCADE' });
		});

		it('should create ref with as option', () => {
			const result = ref('users', { as: 'author' });
			expect(result.options).toEqual({ as: 'author' });
		});

		it('should create ref with inverse option', () => {
			const result = ref('users', { inverse: 'writings' });
			expect(result.options).toEqual({ inverse: 'writings' });
		});

		it('should create ref with roles for self-referential', () => {
			const result = ref('categories', {
				roles: { parent: 'parent', children: 'children' },
			});
			expect(result.options.roles).toEqual({
				parent: 'parent',
				children: 'children',
			});
		});

		it('should create ref with composite columns option', () => {
			const result = ref('orders', {
				columns: ['orderId', 'productId'],
				references: ['orderId', 'productId'],
			});
			expect(result.options.columns).toEqual(['orderId', 'productId']);
			expect(result.options.references).toEqual(['orderId', 'productId']);
		});

		it('should create ref with all options combined', () => {
			const result = ref('users', {
				nullable: true,
				unique: false,
				onDelete: 'SET NULL',
				onUpdate: 'CASCADE',
				as: 'author',
				inverse: 'writings',
			});
			expect(result.options).toEqual({
				nullable: true,
				unique: false,
				onDelete: 'SET NULL',
				onUpdate: 'CASCADE',
				as: 'author',
				inverse: 'writings',
			});
		});
	});

	describe('isRef()', () => {
		it('should return true for ref definitions', () => {
			const result = ref('users');
			expect(isRef(result)).toBe(true);
		});

		it('should return false for string column type', () => {
			expect(isRef('text')).toBe(false);
		});

		it('should return false for object without __brand', () => {
			expect(isRef({ type: 'text' })).toBe(false);
		});

		it('should return false for object with wrong __brand', () => {
			expect(isRef({ __brand: 'wrong', target: 'users' } as never)).toBe(false);
		});

		it('should return false for null', () => {
			expect(isRef(null as never)).toBe(false);
		});

		it('should return false for primitives', () => {
			expect(isRef(42 as never)).toBe(false);
		});
	});

	describe('schema() - column definitions', () => {
		it('should handle short-form column types', () => {
			const db = schema({
				users: {
					id: 'uuid',
					email: 'text',
					age: 'integer',
					active: 'boolean',
				},
			});

			const table = db.model.getTable('users');
			expect(table?.columns).toHaveLength(4);
			expect(table?.columns.find((c) => c.name === 'id')?.type).toBe('uuid');
			// text maps to text in ModelIR, not string
			expect(table?.columns.find((c) => c.name === 'email')?.type).toBe('text');
			expect(table?.columns.find((c) => c.name === 'age')?.type).toBe(
				'integer',
			);
			expect(table?.columns.find((c) => c.name === 'active')?.type).toBe(
				'boolean',
			);
		});

		it('should handle long-form column with nullable', () => {
			const db = schema({
				users: {
					id: 'uuid',
					email: { type: 'text', nullable: true },
				},
			});

			const table = db.model.getTable('users');
			expect(table?.columns.find((c) => c.name === 'email')?.nullable).toBe(
				true,
			);
		});

		it('should handle long-form column with unique', () => {
			const db = schema({
				users: {
					id: 'uuid',
					email: { type: 'text', unique: true },
				},
			});

			const table = db.model.getTable('users');
			expect(table?.columns.find((c) => c.name === 'email')?.unique).toBe(true);
		});

		it('should handle long-form column with primaryKey', () => {
			const db = schema({
				users: {
					id: { type: 'uuid', primaryKey: true },
					email: 'text',
				},
			});

			const table = db.model.getTable('users');
			// primaryKey is a string, not an array
			expect(table?.primaryKey).toBe('id');
		});

		it('should handle long-form column with autoIncrement', () => {
			const db = schema({
				users: {
					id: { type: 'integer', autoIncrement: true },
					email: 'text',
				},
			});

			const table = db.model.getTable('users');
			expect(table?.columns.find((c) => c.name === 'id')?.autoIncrement).toBe(
				true,
			);
		});

		it('should handle long-form column with default', () => {
			const db = schema({
				users: {
					id: 'uuid',
					status: { type: 'text', default: 'active' },
				},
			});

			const table = db.model.getTable('users');
			expect(table?.columns.find((c) => c.name === 'status')?.default).toBe(
				'active',
			);
		});

		it('should handle long-form column with index', () => {
			const db = schema({
				users: {
					id: 'uuid',
					email: { type: 'text', index: true },
				},
			});

			const table = db.model.getTable('users');
			expect(table?.indexes).toHaveLength(1);
			expect(table?.indexes[0]?.columns).toEqual(['email']);
		});
	});

	describe('schema() - ref definitions', () => {
		it('should create foreign key from ref', () => {
			const db = schema({
				users: { id: 'uuid' },
				posts: { id: 'uuid', authorId: ref('users') },
			});

			const table = db.model.getTable('posts');
			expect(table?.foreignKeys).toHaveLength(1);
			expect(table?.foreignKeys[0]?.references.table).toBe('users');
		});

		it('should create relation from ref', () => {
			const db = schema({
				users: { id: 'uuid' },
				posts: { id: 'uuid', authorId: ref('users') },
			});

			const relations = db.model.getRelationsFrom('posts');
			expect(relations).toHaveLength(1);
			expect(relations[0]?.name).toBe('author');
			expect(relations[0]?.target).toBe('users');
		});

		it('should use "as" option for relation name', () => {
			const db = schema({
				users: { id: 'uuid' },
				posts: { id: 'uuid', createdById: ref('users', { as: 'creator' }) },
			});

			const relations = db.model.getRelationsFrom('posts');
			expect(relations[0]?.name).toBe('creator');
		});

		it('should handle nullable refs', () => {
			const db = schema({
				users: { id: 'uuid' },
				posts: { id: 'uuid', authorId: ref('users', { nullable: true }) },
			});

			const table = db.model.getTable('posts');
			expect(table?.columns.find((c) => c.name === 'authorId')?.nullable).toBe(
				true,
			);
		});

		it('should handle unique refs (1:1 relation)', () => {
			const db = schema({
				users: { id: 'uuid' },
				profiles: { id: 'uuid', userId: ref('users', { unique: true }) },
			});

			const table = db.model.getTable('profiles');
			expect(table?.columns.find((c) => c.name === 'userId')?.unique).toBe(
				true,
			);
		});

		it('should handle onDelete CASCADE', () => {
			const db = schema({
				users: { id: 'uuid' },
				posts: { id: 'uuid', authorId: ref('users', { onDelete: 'CASCADE' }) },
			});

			const table = db.model.getTable('posts');
			expect(table?.foreignKeys[0]?.onDelete).toBe('CASCADE');
		});

		it('should handle onDelete SET NULL', () => {
			const db = schema({
				users: { id: 'uuid' },
				posts: {
					id: 'uuid',
					authorId: ref('users', { nullable: true, onDelete: 'SET NULL' }),
				},
			});

			const table = db.model.getTable('posts');
			expect(table?.foreignKeys[0]?.onDelete).toBe('SET NULL');
		});

		it('should handle onDelete RESTRICT', () => {
			const db = schema({
				users: { id: 'uuid' },
				posts: {
					id: 'uuid',
					authorId: ref('users', { onDelete: 'RESTRICT' }),
				},
			});

			const table = db.model.getTable('posts');
			expect(table?.foreignKeys[0]?.onDelete).toBe('RESTRICT');
		});

		it('should handle onDelete NO ACTION', () => {
			const db = schema({
				users: { id: 'uuid' },
				posts: {
					id: 'uuid',
					authorId: ref('users', { onDelete: 'NO ACTION' }),
				},
			});

			const table = db.model.getTable('posts');
			expect(table?.foreignKeys[0]?.onDelete).toBe('NO ACTION');
		});
	});

	describe('schema() - self-referential relations', () => {
		it('should require roles for self-refs', () => {
			expect(() =>
				schema({
					categories: {
						id: 'uuid',
						parentId: ref('categories'), // Missing roles
					},
				}),
			).toThrow(SchemaValidationError);
		});

		it('should accept roles for self-refs', () => {
			const db = schema({
				categories: {
					id: 'uuid',
					parentId: ref('categories', {
						roles: { parent: 'parent', children: 'children' },
					}),
				},
			});

			const table = db.model.getTable('categories');
			expect(table?.foreignKeys).toHaveLength(1);
		});

		it('should use default ancestors/descendants names if not provided', () => {
			const db = schema({
				nodes: {
					id: 'uuid',
					parentId: ref('nodes', {
						roles: { parent: 'parent', children: 'children' },
					}),
				},
			});

			const table = db.model.getTable('nodes');
			// Default ancestors/descendants should be added by the builder
			expect(table?.pseudoColumns).toBeDefined();
		});
	});

	describe('schema() - constraints', () => {
		it('should handle composite indexes', () => {
			const db = schema(
				{
					users: { id: 'uuid', email: 'text', name: 'text' },
				},
				{
					users: {
						indexes: [{ columns: ['email', 'name'], unique: true }],
					},
				},
			);

			const table = db.model.getTable('users');
			expect(table?.indexes).toHaveLength(1);
			expect(table?.indexes[0]?.columns).toEqual(['email', 'name']);
			expect(table?.indexes[0]?.unique).toBe(true);
		});

		it('should handle composite indexes with custom name', () => {
			const db = schema(
				{
					users: { id: 'uuid', email: 'text', name: 'text' },
				},
				{
					users: {
						indexes: [
							{ columns: ['email', 'name'], unique: true, name: 'custom_idx' },
						],
					},
				},
			);

			const table = db.model.getTable('users');
			expect(table?.indexes[0]?.name).toBe('custom_idx');
		});

		it('should handle composite foreign keys', () => {
			const db = schema(
				{
					orders: { orderId: 'uuid', productId: 'uuid' },
					orderItems: {
						orderId: 'uuid',
						productId: 'uuid',
						quantity: 'integer',
					},
				},
				{
					orderItems: {
						foreignKeys: [
							ref('orders', {
								columns: ['orderId', 'productId'],
								references: ['orderId', 'productId'],
							}),
						],
					},
				},
			);

			const table = db.model.getTable('orderItems');
			expect(table?.foreignKeys).toHaveLength(1);
			expect(table?.foreignKeys[0]?.columns).toEqual(['orderId', 'productId']);
			expect(table?.foreignKeys[0]?.references.columns).toEqual([
				'orderId',
				'productId',
			]);
		});
	});

	describe('schema() - default filters', () => {
		it('should accept default filters for existing tables', () => {
			const db = schema(
				{
					users: { id: 'uuid', deletedAt: 'timestamp' },
				},
				undefined,
				{
					defaultFilters: {
						users: { field: 'deletedAt', op: 'isNull' },
					},
				},
			);

			expect(db.defaultFilters).toBeDefined();
			expect(db.defaultFilters?.users).toBeDefined();
		});

		it('should throw if default filter references non-existent table', () => {
			expect(() =>
				schema(
					{
						users: { id: 'uuid' },
					},
					undefined,
					{
						defaultFilters: {
							products: { field: 'deletedAt', op: 'isNull' }, // Non-existent
						},
					},
				),
			).toThrow(SchemaValidationError);
		});

		it('should allow multiple default filters', () => {
			const db = schema(
				{
					users: { id: 'uuid', deletedAt: 'timestamp' },
					posts: { id: 'uuid', deletedAt: 'timestamp' },
				},
				undefined,
				{
					defaultFilters: {
						users: { field: 'deletedAt', op: 'isNull' },
						posts: { field: 'deletedAt', op: 'isNull' },
					},
				},
			);

			expect(db.defaultFilters?.users).toBeDefined();
			expect(db.defaultFilters?.posts).toBeDefined();
		});
	});

	describe('schema() - validation errors', () => {
		it('should throw if ref points to non-existent table', () => {
			expect(() =>
				schema({
					posts: { id: 'uuid', authorId: ref('users') }, // users doesn't exist
				}),
			).toThrow(SchemaValidationError);
		});

		it('should include table and column info in SchemaValidationError', () => {
			try {
				schema({
					posts: { id: 'uuid', authorId: ref('users') },
				});
			} catch (error) {
				expect(error).toBeInstanceOf(SchemaValidationError);
				if (error instanceof SchemaValidationError) {
					expect(error.table).toBe('posts');
					expect(error.column).toBe('authorId');
				}
			}
		});
	});

	describe('schema() - tables proxy', () => {
		it('should create tables proxy', () => {
			const db = schema({
				users: { id: 'uuid', email: 'text' },
			});

			expect(db.tables).toBeDefined();
			expect(db.tables.users).toBeDefined();
		});

		it('should include tableNames array', () => {
			const db = schema({
				users: { id: 'uuid' },
				posts: { id: 'uuid' },
			});

			expect(db.tableNames).toEqual(['users', 'posts']);
		});
	});
});
