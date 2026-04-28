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

	describe('schema() - column type variations', () => {
		it('should handle all string-like types', () => {
			const db = schema({
				t: {
					a: 'string',
					b: 'text',
					c: 'uuid',
				},
			});

			const table = db.model.getTable('t');
			expect(table?.columns.find((c) => c.name === 'a')?.type).toBe('string');
			expect(table?.columns.find((c) => c.name === 'b')?.type).toBe('text');
			expect(table?.columns.find((c) => c.name === 'c')?.type).toBe('uuid');
		});

		it('should handle numeric types', () => {
			const db = schema({
				t: {
					a: 'number',
					b: 'integer',
					c: 'decimal',
					d: 'bigint',
				},
			});

			const table = db.model.getTable('t');
			expect(table?.columns.find((c) => c.name === 'a')?.type).toBe('number');
			expect(table?.columns.find((c) => c.name === 'b')?.type).toBe('integer');
			expect(table?.columns.find((c) => c.name === 'c')?.type).toBe('decimal');
			expect(table?.columns.find((c) => c.name === 'd')?.type).toBe('bigint');
		});

		it('should handle date/time types', () => {
			const db = schema({
				t: {
					a: 'date',
					b: 'time',
					c: 'datetime',
					d: 'timestamp',
				},
			});

			const table = db.model.getTable('t');
			expect(table?.columns.find((c) => c.name === 'a')?.type).toBe('date');
			expect(table?.columns.find((c) => c.name === 'b')?.type).toBe('time');
			expect(table?.columns.find((c) => c.name === 'c')?.type).toBe('datetime');
			expect(table?.columns.find((c) => c.name === 'd')?.type).toBe(
				'timestamp',
			);
		});

		it('should handle json types', () => {
			const db = schema({
				t: {
					a: 'json',
					b: 'jsonb',
				},
			});

			const table = db.model.getTable('t');
			expect(table?.columns.find((c) => c.name === 'a')?.type).toBe('json');
			expect(table?.columns.find((c) => c.name === 'b')?.type).toBe('jsonb');
		});
	});

	describe('schema() - relation types', () => {
		it('should infer hasMany inverse from belongsTo FK', () => {
			const db = schema({
				users: { id: 'uuid' },
				posts: {
					id: 'uuid',
					authorId: ref('users', { as: 'author', inverse: 'posts' }),
				},
			});

			const relationsFromUsers = db.model.getRelationsFrom('users');
			const hasManyRel = relationsFromUsers.find((r) => r.name === 'posts');
			expect(hasManyRel?.type).toBe('hasMany');
			expect(hasManyRel?.cardinality).toBe('many');
		});

		it('should infer hasOne inverse from unique FK', () => {
			const db = schema({
				users: { id: 'uuid' },
				profiles: {
					id: 'uuid',
					userId: ref('users', {
						unique: true,
						as: 'user',
						inverse: 'profile',
					}),
				},
			});

			const relationsFromUsers = db.model.getRelationsFrom('users');
			const hasOneRel = relationsFromUsers.find((r) => r.name === 'profile');
			expect(hasOneRel?.type).toBe('hasOne');
			expect(hasOneRel?.cardinality).toBe('one');
		});

		it('should derive relation name from column name (strip Id)', () => {
			const db = schema({
				users: { id: 'uuid' },
				posts: { id: 'uuid', authorId: ref('users') },
			});

			const relations = db.model.getRelationsFrom('posts');
			expect(relations[0]?.name).toBe('author');
		});

		it('should derive relation name from _id suffix', () => {
			const db = schema({
				users: { id: 'uuid' },
				posts: { id: 'uuid', author_id: ref('users') },
			});

			const relations = db.model.getRelationsFrom('posts');
			expect(relations[0]?.name).toBe('author');
		});

		it('should use column name as-is when no Id/_id suffix', () => {
			const db = schema({
				users: { id: 'uuid' },
				posts: { id: 'uuid', creator: ref('users') },
			});

			const relations = db.model.getRelationsFrom('posts');
			expect(relations[0]?.name).toBe('creator');
		});

		it('should use inverse option for inverse relation name', () => {
			const db = schema({
				users: { id: 'uuid' },
				posts: {
					id: 'uuid',
					authorId: ref('users', { as: 'author', inverse: 'writings' }),
				},
			});

			const relationsFromUsers = db.model.getRelationsFrom('users');
			const inverseRel = relationsFromUsers.find((r) => r.target === 'posts');
			expect(inverseRel?.name).toBe('writings');
		});

		it('should generate default inverse name when no inverse option', () => {
			const db = schema({
				users: { id: 'uuid' },
				posts: { id: 'uuid', authorId: ref('users') },
			});

			const relationsFromUsers = db.model.getRelationsFrom('users');
			const inverseRel = relationsFromUsers.find((r) => r.target === 'posts');
			// Default pattern: {localRelation}_{sourceTable}
			expect(inverseRel?.name).toBe('author_posts');
		});
	});

	describe('schema() - self-referential relations', () => {
		it('should generate 4 relations for self-ref with roles', () => {
			const db = schema({
				categories: {
					id: 'uuid',
					parentId: ref('categories', {
						nullable: true,
						roles: {
							parent: 'parent',
							children: 'children',
							ancestors: 'allAncestors',
							descendants: 'allDescendants',
						},
					}),
				},
			});

			const relations = db.model.getRelationsFrom('categories');
			const names = relations.map((r) => r.name).sort();
			expect(names).toContain('parent');
			expect(names).toContain('children');
			expect(names).toContain('allAncestors');
			expect(names).toContain('allDescendants');
		});

		it('should use default ancestors/descendants names', () => {
			const db = schema({
				categories: {
					id: 'uuid',
					parentId: ref('categories', {
						nullable: true,
						roles: {
							parent: 'parent',
							children: 'children',
						},
					}),
				},
			});

			const relations = db.model.getRelationsFrom('categories');
			const names = relations.map((r) => r.name);
			expect(names).toContain('ancestors');
			expect(names).toContain('descendants');
		});

		it('should mark parent as belongsTo', () => {
			const db = schema({
				categories: {
					id: 'uuid',
					parentId: ref('categories', {
						nullable: true,
						roles: { parent: 'parent', children: 'children' },
					}),
				},
			});

			const parentRel = db.model.getRelation('categories.parent');
			expect(parentRel?.type).toBe('belongsTo');
			expect(parentRel?.cardinality).toBe('one');
			expect(parentRel?.optionality).toBe('optional'); // nullable
		});

		it('should mark children as hasMany', () => {
			const db = schema({
				categories: {
					id: 'uuid',
					parentId: ref('categories', {
						nullable: true,
						roles: { parent: 'parent', children: 'children' },
					}),
				},
			});

			const childrenRel = db.model.getRelation('categories.children');
			expect(childrenRel?.type).toBe('hasMany');
			expect(childrenRel?.cardinality).toBe('many');
		});
	});

	describe('schema() - multi-FK validation', () => {
		it('should throw when multiple FKs to same table lack as option', () => {
			expect(() =>
				schema({
					users: { id: 'uuid' },
					messages: {
						id: 'uuid',
						senderId: ref('users'),
						receiverId: ref('users'),
					},
				}),
			).toThrow(SchemaValidationError);
		});

		it('should accept multiple FKs with explicit as option', () => {
			expect(() =>
				schema({
					users: { id: 'uuid' },
					messages: {
						id: 'uuid',
						senderId: ref('users', { as: 'sender', inverse: 'sent' }),
						receiverId: ref('users', { as: 'receiver', inverse: 'received' }),
					},
				}),
			).not.toThrow();
		});
	});

	describe('schema() - duplicate relation names', () => {
		it('should throw on duplicate relation names', () => {
			expect(() =>
				schema({
					users: { id: 'uuid' },
					posts: {
						id: 'uuid',
						createdBy: ref('users', { as: 'author' }),
						updatedBy: ref('users', { as: 'author', inverse: 'updatedPosts' }),
					},
				}),
			).toThrow(SchemaValidationError);
		});
	});

	describe('schema() - roles on non-self-ref', () => {
		it('should throw when roles used on non-self-referential FK', () => {
			expect(() =>
				schema({
					users: { id: 'uuid' },
					posts: {
						id: 'uuid',
						authorId: ref('users', {
							roles: { parent: 'parent', children: 'children' },
						}),
					},
				}),
			).toThrow(SchemaValidationError);
		});
	});

	describe('schema() - PK inference', () => {
		it('should infer id column as PK when no explicit PK', () => {
			const db = schema({
				users: { id: 'uuid', name: 'text' },
			});

			const table = db.model.getTable('users');
			expect(table?.primaryKey).toBe('id');
		});

		it('should use composite PK when multiple columns marked', () => {
			const db = schema({
				orderItems: {
					orderId: { type: 'uuid', primaryKey: true },
					productId: { type: 'uuid', primaryKey: true },
					quantity: 'integer',
				},
			});

			const table = db.model.getTable('orderItems');
			expect(table?.primaryKey).toEqual(['orderId', 'productId']);
		});

		it('should infer PK from FK columns when no id and no explicit PK', () => {
			const db = schema({
				users: { id: 'uuid' },
				userRoles: {
					userId: ref('users'),
					role: 'text',
				},
			});

			const table = db.model.getTable('userRoles');
			// PK should be inferred from FK column
			expect(table?.primaryKey).toBeDefined();
		});
	});

	describe('schema() - FK target PK type inference', () => {
		it('should derive FK column type from target PK type (integer)', () => {
			const db = schema({
				users: { id: { type: 'integer', primaryKey: true }, name: 'text' },
				posts: { id: 'uuid', authorId: ref('users') },
			});

			const table = db.model.getTable('posts');
			const fkCol = table?.columns.find((c) => c.name === 'authorId');
			expect(fkCol?.type).toBe('integer');
		});

		it('should derive FK column type from target with uuid PK', () => {
			const db = schema({
				users: { id: { type: 'uuid', primaryKey: true }, name: 'text' },
				posts: { id: 'uuid', authorId: ref('users') },
			});

			const table = db.model.getTable('posts');
			const fkCol = table?.columns.find((c) => c.name === 'authorId');
			expect(fkCol?.type).toBe('uuid');
		});
	});

	describe('schema() - composite FK in constraints', () => {
		it('should throw when composite FK lacks columns option', () => {
			expect(() =>
				schema(
					{
						orders: { orderId: 'uuid' },
						items: { itemId: 'uuid' },
					},
					{
						items: {
							foreignKeys: [ref('orders', {})],
						},
					},
				),
			).toThrow(SchemaValidationError);
		});

		it('should use default id for references when not specified', () => {
			const db = schema(
				{
					orders: { id: 'uuid', code: 'text' },
					items: { itemId: 'uuid', orderId: 'uuid' },
				},
				{
					items: {
						foreignKeys: [ref('orders', { columns: ['orderId'] })],
					},
				},
			);

			const table = db.model.getTable('items');
			const compositeFk = table?.foreignKeys.find(
				(fk) =>
					fk.columns.includes('orderId') && fk.references.table === 'orders',
			);
			expect(compositeFk?.references.columns).toEqual(['id']);
		});
	});

	describe('schema() - onUpdate option', () => {
		it('should accept onUpdate CASCADE', () => {
			const r = ref('users', { onUpdate: 'CASCADE' });
			expect(r.options.onUpdate).toBe('CASCADE');
		});
	});

	describe('SchemaValidationError', () => {
		it('should expose table and column properties', () => {
			const err = new SchemaValidationError('test', 'users', 'email');
			expect(err.message).toBe('test');
			expect(err.table).toBe('users');
			expect(err.column).toBe('email');
			expect(err.name).toBe('SchemaValidationError');
		});

		it('should handle missing table and column', () => {
			const err = new SchemaValidationError('test');
			expect(err.table).toBeUndefined();
			expect(err.column).toBeUndefined();
		});
	});

	// ======================================================================
	// Additional branch coverage
	// ======================================================================

	describe('getTargetPkType fallback branches', () => {
		it('should derive FK column type from target id when target uses implicit-id PK', () => {
			// Renamed (was: 'should fall back to uuid when target table does not exist').
			// Original test relied on a target table with no PK and no 'id' column — that
			// schema is now correctly rejected by the post-build FK target gate
			// (validateFkTargets) because 'tags.id' did not exist. The test now verifies
			// that the implicit-id-PK convention resolves cleanly: with `id: 'uuid'` on
			// the target, the FK source's type resolves to 'uuid' through the PK chain.
			const db = schema({
				tags: { id: 'uuid', name: 'text' }, // implicit PK via 'id' convention
				posts: { id: 'uuid', tagId: ref('tags') },
			});

			const table = db.model.getTable('posts');
			const fkCol = table?.columns.find((c) => c.name === 'tagId');
			expect(fkCol?.type).toBe('uuid');
		});

		it('should derive FK type from id column when no explicit primaryKey', () => {
			const db = schema({
				users: { id: 'integer', name: 'text' }, // 'id' short-form, no explicit primaryKey:true
				posts: { id: 'uuid', authorId: ref('users') },
			});

			const table = db.model.getTable('posts');
			const fkCol = table?.columns.find((c) => c.name === 'authorId');
			// getTargetPkType: no column with primaryKey:true, but 'id' in targetDef → uses id's type
			expect(fkCol?.type).toBe('integer');
		});

		it('should derive FK type from id column when id is a ref (branch: isRef guard)', () => {
			// When 'id' in target is itself a ref, getTargetPkType should skip it and fall back to uuid
			// This is an unusual schema but exercises the isRef guard on idDef
			const db = schema({
				parents: { id: 'uuid' },
				children: {
					id: ref('parents'),
					extra: 'text',
				},
				grandchildren: { id: 'uuid', childExtra: ref('children') },
			});

			const table = db.model.getTable('grandchildren');
			const fkCol = table?.columns.find((c) => c.name === 'childExtra');
			// 'children' has id which isRef → skip → fallback uuid
			expect(fkCol?.type).toBe('uuid');
		});
	});

	describe('buildTables PK inference — no PK, no FK, no id', () => {
		it('should omit primaryKey when table has no id, no explicit PK, and no FK', () => {
			const db = schema({
				logs: { message: 'text', level: 'integer' },
			});

			const table = db.model.getTable('logs');
			expect(table?.primaryKey).toBeUndefined();
		});

		it('should infer composite PK from multiple FK columns', () => {
			const db = schema({
				users: { id: 'uuid' },
				roles: { id: 'uuid' },
				userRoles: {
					userId: ref('users'),
					roleId: ref('roles'),
				},
			});

			const table = db.model.getTable('userRoles');
			// Multiple FK columns → composite PK
			expect(table?.primaryKey).toEqual(['userId', 'roleId']);
		});
	});

	describe('column options — autoIncrement, default, nullable on ref', () => {
		it('should propagate autoIncrement on regular column', () => {
			const db = schema({
				counters: {
					id: { type: 'integer', primaryKey: true, autoIncrement: true },
					name: 'text',
				},
			});

			const table = db.model.getTable('counters');
			const idCol = table?.columns.find((c) => c.name === 'id');
			expect(idCol?.autoIncrement).toBe(true);
		});

		it('should propagate default value on regular column', () => {
			const db = schema({
				items: {
					id: 'uuid',
					status: { type: 'text', default: 'active' },
				},
			});

			const table = db.model.getTable('items');
			const statusCol = table?.columns.find((c) => c.name === 'status');
			expect(statusCol?.default).toBe('active');
		});

		it('should propagate nullable and unique on ref column', () => {
			const db = schema({
				users: { id: 'uuid' },
				profiles: {
					id: 'uuid',
					userId: ref('users', { nullable: true, unique: true }),
				},
			});

			const table = db.model.getTable('profiles');
			const fkCol = table?.columns.find((c) => c.name === 'userId');
			expect(fkCol?.nullable).toBe(true);
			expect(fkCol?.unique).toBe(true);
		});
	});

	describe('FK onDelete propagation', () => {
		it('should propagate onDelete from ref to ForeignKeyIR', () => {
			const db = schema({
				users: { id: 'uuid' },
				posts: {
					id: 'uuid',
					authorId: ref('users', { onDelete: 'CASCADE' }),
				},
			});

			const table = db.model.getTable('posts');
			const fk = table?.foreignKeys[0];
			expect(fk?.onDelete).toBe('CASCADE');
		});

		it('should omit onDelete when not specified', () => {
			const db = schema({
				users: { id: 'uuid' },
				posts: { id: 'uuid', authorId: ref('users') },
			});

			const table = db.model.getTable('posts');
			const fk = table?.foreignKeys[0];
			expect(fk?.onDelete).toBeUndefined();
		});
	});

	describe('composite FK in constraints — onDelete and references', () => {
		it('should propagate onDelete on composite FK', () => {
			const db = schema(
				{
					orders: {
						orderId: { type: 'uuid', primaryKey: true },
						region: { type: 'text', primaryKey: true },
					},
					items: {
						id: 'uuid',
						orderId: 'uuid',
						region: 'text',
					},
				},
				{
					items: {
						foreignKeys: [
							ref('orders', {
								columns: ['orderId', 'region'],
								references: ['orderId', 'region'],
								onDelete: 'SET NULL',
							}),
						],
					},
				},
			);

			const table = db.model.getTable('items');
			const compositeFk = table?.foreignKeys.find(
				(fk) => fk.columns.length === 2,
			);
			expect(compositeFk?.onDelete).toBe('SET NULL');
		});

		it('should default composite FK references to id when not specified', () => {
			const db = schema(
				{
					orders: { id: 'uuid' },
					items: { id: 'uuid', orderId: 'uuid' },
				},
				{
					items: {
						foreignKeys: [ref('orders', { columns: ['orderId'] })],
					},
				},
			);

			const table = db.model.getTable('items');
			const compositeFk = table?.foreignKeys.find(
				(fk) =>
					fk.columns.includes('orderId') && fk.references.table === 'orders',
			);
			expect(compositeFk?.references.columns).toEqual(['id']);
		});
	});

	describe('schema() - composite index with auto-generated name', () => {
		it('should generate index name from columns when no name given', () => {
			const db = schema(
				{
					events: { id: 'uuid', date: 'date', type: 'text' },
				},
				{
					events: {
						indexes: [{ columns: ['date', 'type'] }],
					},
				},
			);

			const table = db.model.getTable('events');
			const idx = table?.indexes.find(
				(i) => i.columns.includes('date') && i.columns.includes('type'),
			);
			expect(idx?.name).toBe('idx_events_date_type');
			expect(idx?.unique).toBe(false);
		});

		it('should respect unique flag on composite index', () => {
			const db = schema(
				{
					events: { id: 'uuid', date: 'date', type: 'text' },
				},
				{
					events: {
						indexes: [{ columns: ['date', 'type'], unique: true }],
					},
				},
			);

			const table = db.model.getTable('events');
			const idx = table?.indexes.find((i) => i.columns.includes('date'));
			expect(idx?.unique).toBe(true);
		});
	});

	describe('self-referential with non-nullable FK', () => {
		it('should mark parent relation as required when FK is not nullable', () => {
			const db = schema({
				nodes: {
					id: 'uuid',
					parentId: ref('nodes', {
						roles: { parent: 'parentNode', children: 'childNodes' },
					}),
				},
			});

			const parentRel = db.model.getRelation('nodes.parentNode');
			expect(parentRel?.optionality).toBe('required'); // Not nullable → required
		});
	});

	describe('pseudoColumns generation for self-ref', () => {
		it('should generate pseudoColumns with correct pkColumn', () => {
			const db = schema({
				categories: {
					catId: { type: 'uuid', primaryKey: true },
					parentCatId: ref('categories', {
						references: ['catId'], // target PK is 'catId', not the default 'id'
						nullable: true,
						roles: { parent: 'parent', children: 'children' },
					}),
				},
			});

			const table = db.model.getTable('categories');
			expect(table?.pseudoColumns).toBeDefined();
			expect(table?.pseudoColumns?.length).toBeGreaterThan(0);
		});

		it('should use array first element as pkColumn when composite PK', () => {
			// Edge case: self-ref table with composite PK — pkColumn takes first element.
			// `a` is also marked `unique: true` so the FK can independently target it
			// (PG strict semantics: a single column from a composite PK is not unique
			// alone — it needs an explicit UNIQUE constraint). The composite PK shape
			// is preserved for the pseudoColumn-from-composite-PK behavior under test.
			const db = schema({
				nodes: {
					a: { type: 'uuid', primaryKey: true, unique: true },
					b: { type: 'uuid', primaryKey: true },
					parentA: ref('nodes', {
						references: ['a'], // target the unique-and-PK-member column
						nullable: true,
						roles: { parent: 'up', children: 'down' },
					}),
				},
			});

			const table = db.model.getTable('nodes');
			expect(table?.pseudoColumns).toBeDefined();
		});
	});

	describe('column-level index: true', () => {
		it('should create index for column with index: true', () => {
			const db = schema({
				users: {
					id: 'uuid',
					email: { type: 'text', index: true },
				},
			});

			const table = db.model.getTable('users');
			const idx = table?.indexes.find((i) => i.columns.includes('email'));
			expect(idx?.name).toBe('idx_users_email');
			expect(idx?.unique).toBe(false);
		});
	});

	describe('isRef edge cases', () => {
		it('should return false for short-form string column', () => {
			expect(isRef('uuid')).toBe(false);
		});

		it('should return false for long-form column object', () => {
			expect(isRef({ type: 'text', nullable: true })).toBe(false);
		});

		it('should return false for object without __brand', () => {
			expect(isRef({ target: 'users' })).toBe(false);
		});

		it('should return false for null-like values', () => {
			expect(isRef(null)).toBe(false);
		});
	});

	describe('getSchemaFromDb', () => {
		it('should create schema from introspected model', async () => {
			const { getSchemaFromDb } = await import('./schema.js');

			const mockModel = {
				tables: new Map([
					[
						'users',
						{
							name: 'users',
							columns: [
								{ name: 'id', type: 'uuid', nullable: false },
								{ name: 'email', type: 'text', nullable: false },
							],
							primaryKey: 'id',
							foreignKeys: [],
							indexes: [],
						},
					],
				]),
				relations: new Map(),
				getTable: (name) => mockModel.tables.get(name),
				getRelation: () => undefined,
				getRelationsFrom: () => [],
				introspectedAt: new Date('2026-01-01'),
			};

			const adapter = {
				introspect: async () => mockModel,
				dbCasing: 'snake_case',
			};

			const result = await getSchemaFromDb(adapter);
			expect(result.definition).toBeDefined();
			expect(result.model).toBeDefined();
			expect(result.tableNames).toContain('users');
			expect(result.dbCasing).toBe('snake_case');
			expect(result.introspectedAt).toBeDefined();
		});

		it('should handle FK columns via introspection', async () => {
			const { getSchemaFromDb } = await import('./schema.js');

			const mockModel = {
				tables: new Map([
					[
						'users',
						{
							name: 'users',
							columns: [{ name: 'id', type: 'uuid', nullable: false }],
							primaryKey: 'id',
							foreignKeys: [],
							indexes: [],
						},
					],
					[
						'posts',
						{
							name: 'posts',
							columns: [
								{ name: 'id', type: 'uuid', nullable: false },
								{
									name: 'authorId',
									type: 'uuid',
									nullable: true,
									unique: false,
								},
							],
							primaryKey: 'id',
							foreignKeys: [
								{
									columns: ['authorId'],
									references: { table: 'users', columns: ['id'] },
								},
							],
							indexes: [],
						},
					],
				]),
				relations: new Map(),
				getTable: (name) => mockModel.tables.get(name),
				getRelation: () => undefined,
				getRelationsFrom: () => [],
			};

			const adapter = { introspect: async () => mockModel };

			const result = await getSchemaFromDb(adapter);
			// FK column should be a ref definition
			const postsDef = result.definition.posts;
			expect(postsDef).toBeDefined();
		});

		it('should pass options to adapter introspect', async () => {
			const { getSchemaFromDb } = await import('./schema.js');
			let capturedOptions: unknown;

			const adapter = {
				introspect: async (opts) => {
					capturedOptions = opts;
					return {
						tables: new Map(),
						relations: new Map(),
						getTable: () => undefined,
						getRelation: () => undefined,
						getRelationsFrom: () => [],
					};
				},
			};

			await getSchemaFromDb(adapter, {
				schema: 'tenant_1',
				tables: ['users', 'posts'],
				exclude: ['_migrations'],
			});

			expect(capturedOptions.schema).toBe('tenant_1');
			expect(capturedOptions.include).toEqual(['users', 'posts']);
			expect(capturedOptions.exclude).toEqual(['_migrations']);
		});

		it('should not set dbCasing or introspectedAt when not provided', async () => {
			const { getSchemaFromDb } = await import('./schema.js');

			const adapter = {
				introspect: async () => ({
					tables: new Map(),
					relations: new Map(),
					getTable: () => undefined,
					getRelation: () => undefined,
					getRelationsFrom: () => [],
				}),
			};

			const result = await getSchemaFromDb(adapter);
			expect(result.dbCasing).toBeUndefined();
			expect(result.introspectedAt).toBeUndefined();
		});
	});

	describe('columnTypeToJsType branches', () => {
		it('should cover integer/bigint/decimal → number via getSchemaFromDb', async () => {
			const { getSchemaFromDb } = await import('./schema.js');

			const mockModel = {
				tables: new Map([
					[
						'nums',
						{
							name: 'nums',
							columns: [
								{ name: 'a', type: 'integer', nullable: false },
								{ name: 'b', type: 'bigint', nullable: false },
								{ name: 'c', type: 'decimal', nullable: false },
							],
							primaryKey: 'a',
							foreignKeys: [],
							indexes: [],
						},
					],
				]),
				relations: new Map(),
				getTable: (name) => mockModel.tables.get(name),
				getRelation: () => undefined,
				getRelationsFrom: () => [],
			};

			const adapter = { introspect: async () => mockModel };
			const result = await getSchemaFromDb(adapter);

			// integer, bigint, decimal → 'number'
			expect(result.definition.nums.a).toBe('number');
			expect(result.definition.nums.b).toBe('number');
			expect(result.definition.nums.c).toBe('number');
		});

		it('should cover text/uuid → string and default passthrough', async () => {
			const { getSchemaFromDb } = await import('./schema.js');

			const mockModel = {
				tables: new Map([
					[
						'strings',
						{
							name: 'strings',
							columns: [
								{ name: 'a', type: 'text', nullable: false },
								{ name: 'b', type: 'uuid', nullable: false },
								{ name: 'c', type: 'boolean', nullable: false },
								{ name: 'd', type: 'json', nullable: false },
							],
							primaryKey: 'a',
							foreignKeys: [],
							indexes: [],
						},
					],
				]),
				relations: new Map(),
				getTable: (name) => mockModel.tables.get(name),
				getRelation: () => undefined,
				getRelationsFrom: () => [],
			};

			const adapter = { introspect: async () => mockModel };
			const result = await getSchemaFromDb(adapter);

			// text, uuid → 'string'; boolean, json → passthrough
			expect(result.definition.strings.a).toBe('string');
			expect(result.definition.strings.b).toBe('string');
			expect(result.definition.strings.c).toBe('boolean');
			expect(result.definition.strings.d).toBe('json');
		});
	});
});
