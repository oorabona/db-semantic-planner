// @ts-nocheck — coverage test: runtime assertions on AST nodes
/**
 * Coverage tests for table-ref-factory.ts
 *
 * Focuses on edge cases and branches not covered by table-ref.test.ts
 */

import { describe, expect, it } from 'vitest';
import { ModelIRImpl } from '../model-impl.js';
import type { TableIR } from '../model-ir.js';
import {
	BRAND,
	COLUMN_META,
	RELATION_META,
	RELATION_PATH,
	TABLE_META,
} from './table-ref.js';
import {
	createAllColumns,
	createColumnRef,
	createRelationRef,
	createTableRef,
	createTablesProxy,
} from './table-ref-factory.js';

describe('table-ref-factory coverage', () => {
	describe('createColumnRef', () => {
		it('should create column ref with table and column metadata', () => {
			const ref = createColumnRef('users', 'email');
			expect(ref[TABLE_META]).toBe('users');
			expect(ref[COLUMN_META]).toBe('email');
			expect(ref[BRAND]).toBe('ColumnRef');
		});

		it('should create column ref with relation path', () => {
			const ref = createColumnRef('posts', 'title', ['author']);
			expect(ref[TABLE_META]).toBe('posts');
			expect(ref[COLUMN_META]).toBe('title');
			expect(ref[RELATION_PATH]).toEqual(['author']);
		});

		it('should create column ref with empty relation path', () => {
			const ref = createColumnRef('users', 'email', []);
			expect(ref[RELATION_PATH]).toBeUndefined();
		});

		it('should support as() method for aliasing', () => {
			const ref = createColumnRef('users', 'email') as {
				as: (alias: string) => unknown;
			};
			const aliased = ref.as('userEmail');
			expect(aliased).toHaveProperty('_alias', 'userEmail');
		});

		it('should validate alias format', () => {
			const ref = createColumnRef('users', 'email') as {
				as: (alias: string) => unknown;
			};
			// Valid aliases
			expect(() => ref.as('validAlias')).not.toThrow();
			expect(() => ref.as('_underscore')).not.toThrow();
			expect(() => ref.as('camelCase123')).not.toThrow();

			// Invalid aliases
			expect(() => ref.as('123invalid')).toThrow(/Invalid alias/);
			expect(() => ref.as('with-dash')).toThrow(/Invalid alias/);
			expect(() => ref.as('with space')).toThrow(/Invalid alias/);
			expect(() => ref.as('with.dot')).toThrow(/Invalid alias/);
		});
	});

	describe('createAllColumns', () => {
		it('should create AllColumns marker', () => {
			const ref = createAllColumns('users');
			expect(ref[TABLE_META]).toBe('users');
			expect(ref[BRAND]).toBe('AllColumns');
		});
	});

	describe('createRelationRef', () => {
		const tables = new Map<string, TableIR>([
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
			[
				'posts',
				{
					name: 'posts',
					columns: [
						{ name: 'id', type: 'uuid', nullable: false },
						{ name: 'title', type: 'text', nullable: false },
						{ name: 'authorId', type: 'uuid', nullable: false },
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
		]);

		const relations = new Map([
			[
				'posts.author',
				{
					name: 'author',
					source: 'posts',
					target: 'users',
					type: 'belongsTo',
					foreignKey: 'authorId',
					joinDefault: 'auto',
					includeDefault: 'auto',
					cardinality: 'one',
					optionality: 'required',
				},
			],
		]);

		const model = new ModelIRImpl(tables, relations);

		it('should create relation ref with metadata', () => {
			const ref = createRelationRef('posts', 'belongsTo', model);
			expect(ref[BRAND]).toBe('RelationRef');
			expect(ref[RELATION_META]).toEqual({
				target: 'posts',
				type: 'belongsTo',
			});
		});

		it('should build relation path from relationName and parentPath', () => {
			const ref = createRelationRef('posts', 'hasMany', model, 'posts', [
				'author',
			]);
			expect(ref[RELATION_PATH]).toEqual(['author', 'posts']);
		});

		it('should handle wildcard (*) access', () => {
			const ref = createRelationRef('posts', 'hasMany', model);
			const wildcard = (ref as unknown as Record<string, unknown>)['*'];
			expect(wildcard[TABLE_META]).toBe('posts');
			expect(wildcard[BRAND]).toBe('AllColumns');
		});

		it('should handle column access via Proxy', () => {
			const ref = createRelationRef('posts', 'hasMany', model);
			const column = (ref as unknown as Record<string, unknown>).title;
			expect(column[TABLE_META]).toBe('posts');
			expect(column[COLUMN_META]).toBe('title');
		});

		it('should handle nested relation access', () => {
			const ref = createRelationRef('posts', 'hasMany', model);
			const nested = (ref as unknown as Record<string, unknown>).author;
			expect(nested[BRAND]).toBe('RelationRef');
		});

		it('should return undefined for non-existent properties', () => {
			const ref = createRelationRef('posts', 'hasMany', model);
			const result = (ref as unknown as Record<string, unknown>)
				.nonExistentColumn;
			expect(result).toBeUndefined();
		});

		it('should support has() trap for columns', () => {
			const ref = createRelationRef('posts', 'hasMany', model);
			expect('title' in ref).toBe(true);
			expect('nonExistent' in ref).toBe(false);
		});

		it('should support has() trap for wildcard', () => {
			const ref = createRelationRef('posts', 'hasMany', model);
			expect('*' in ref).toBe(true);
		});

		it('should support has() trap for symbols', () => {
			const ref = createRelationRef('posts', 'hasMany', model);
			expect(BRAND in ref).toBe(true);
			expect(Symbol('other') in ref).toBe(false);
		});

		it('should support ownKeys() trap', () => {
			const ref = createRelationRef('posts', 'hasMany', model);
			const keys = Reflect.ownKeys(ref);
			expect(keys).toContain('*');
			expect(keys).toContain('id');
			expect(keys).toContain('title');
			expect(keys).toContain('authorId');
		});

		it('should support getOwnPropertyDescriptor() trap', () => {
			const ref = createRelationRef('posts', 'hasMany', model);
			const desc = Object.getOwnPropertyDescriptor(ref, 'title');
			expect(desc).toBeDefined();
			expect(desc?.enumerable).toBe(true);
			expect(desc?.configurable).toBe(true);
		});

		it('should handle inverse relations', () => {
			const ref = createRelationRef('users', 'belongsTo', model);
			// Access posts via inverse relation
			const posts = (ref as unknown as Record<string, unknown>).posts;
			expect(posts[BRAND]).toBe('RelationRef');
		});
	});

	describe('createTableRef', () => {
		const tables = new Map<string, TableIR>([
			[
				'users',
				{
					name: 'users',
					columns: [
						{ name: 'id', type: 'uuid', nullable: false },
						{ name: 'email', type: 'text', nullable: false },
						{ name: 'constructor', type: 'text', nullable: false }, // Reserved word
					],
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
						{ name: 'title', type: 'text', nullable: false },
						{ name: 'authorId', type: 'uuid', nullable: false },
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
		]);

		const relations = new Map([
			[
				'posts.author',
				{
					name: 'author',
					source: 'posts',
					target: 'users',
					type: 'belongsTo',
					foreignKey: 'authorId',
					joinDefault: 'auto',
					includeDefault: 'auto',
					cardinality: 'one',
					optionality: 'required',
				},
			],
		]);

		const model = new ModelIRImpl(tables, relations);

		it('should create table ref with metadata', () => {
			const ref = createTableRef('users', model);
			expect(ref[TABLE_META]).toBe('users');
			expect(ref[BRAND]).toBe('TableRef');
		});

		it('should throw if table does not exist', () => {
			expect(() => createTableRef('nonExistent', model)).toThrow(
				/Table "nonExistent" not found/,
			);
		});

		it('should handle wildcard (*) access', () => {
			const ref = createTableRef('users', model);
			const wildcard = (ref as unknown as Record<string, unknown>)['*'];
			expect(wildcard[TABLE_META]).toBe('users');
			expect(wildcard[BRAND]).toBe('AllColumns');
		});

		it('should handle column access', () => {
			const ref = createTableRef('users', model);
			const column = (ref as unknown as Record<string, unknown>).email;
			expect(column[TABLE_META]).toBe('users');
			expect(column[COLUMN_META]).toBe('email');
		});

		it('should handle relation access', () => {
			const ref = createTableRef('posts', model);
			const relation = (ref as unknown as Record<string, unknown>).author;
			expect(relation[BRAND]).toBe('RelationRef');
		});

		it('should handle reserved word column names', () => {
			// Create a table with a non-built-in reserved word
			const tablesWithReserved = new Map<string, TableIR>([
				[
					'test',
					{
						name: 'test',
						columns: [
							{ name: 'id', type: 'uuid', nullable: false },
							{ name: 'class', type: 'text', nullable: false }, // Reserved word but not built-in
						],
						primaryKey: 'id',
						foreignKeys: [],
						indexes: [],
					},
				],
			]);

			const modelWithReserved = new ModelIRImpl(tablesWithReserved, new Map());
			const ref = createTableRef('test', modelWithReserved);

			// Accessing reserved word should work and warn
			const column = (ref as unknown as Record<string, unknown>).class;
			expect(column[COLUMN_META]).toBe('class');
		});

		it('should return undefined for non-existent properties', () => {
			const ref = createTableRef('users', model);
			const result = (ref as unknown as Record<string, unknown>).nonExistent;
			expect(result).toBeUndefined();
		});

		it('should support has() trap for columns', () => {
			const ref = createTableRef('users', model);
			expect('email' in ref).toBe(true);
			expect('nonExistent' in ref).toBe(false);
		});

		it('should support has() trap for wildcard', () => {
			const ref = createTableRef('users', model);
			expect('*' in ref).toBe(true);
		});

		it('should support has() trap for symbols', () => {
			const ref = createTableRef('users', model);
			expect(BRAND in ref).toBe(true);
			expect(Symbol('other') in ref).toBe(false);
		});

		it('should support ownKeys() trap', () => {
			const ref = createTableRef('users', model);
			const keys = Reflect.ownKeys(ref);
			expect(keys).toContain('*');
			expect(keys).toContain('id');
			expect(keys).toContain('email');
		});

		it('should support getOwnPropertyDescriptor() trap', () => {
			const ref = createTableRef('users', model);
			const desc = Object.getOwnPropertyDescriptor(ref, 'email');
			expect(desc).toBeDefined();
			expect(desc?.enumerable).toBe(true);
			expect(desc?.configurable).toBe(true);
		});

		it('should handle inverse relations', () => {
			const ref = createTableRef('users', model);
			// posts should be available as inverse relation
			const posts = (ref as unknown as Record<string, unknown>).posts;
			expect(posts[BRAND]).toBe('RelationRef');
		});

		it('should skip self-referential inverse relations', () => {
			// Create a self-referential table
			const selfRefTables = new Map<string, TableIR>([
				[
					'categories',
					{
						name: 'categories',
						columns: [
							{ name: 'id', type: 'uuid', nullable: false },
							{ name: 'parentId', type: 'uuid', nullable: true },
						],
						primaryKey: 'id',
						foreignKeys: [
							{
								columns: ['parentId'],
								references: { table: 'categories', columns: ['id'] },
							},
						],
						indexes: [],
					},
				],
			]);

			const selfRefRelations = new Map([
				[
					'categories.parent',
					{
						name: 'parent',
						source: 'categories',
						target: 'categories',
						type: 'belongsTo',
						foreignKey: 'parentId',
						joinDefault: 'auto',
						includeDefault: 'auto',
						cardinality: 'one',
						optionality: 'optional',
					},
				],
			]);

			const selfRefModel = new ModelIRImpl(selfRefTables, selfRefRelations);
			const ref = createTableRef('categories', selfRefModel);

			// Should have direct relation
			const parent = (ref as unknown as Record<string, unknown>).parent;
			expect(parent[BRAND]).toBe('RelationRef');
		});
	});

	describe('createTablesProxy', () => {
		const tables = new Map<string, TableIR>([
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
					columns: [{ name: 'id', type: 'uuid', nullable: false }],
					primaryKey: 'id',
					foreignKeys: [],
					indexes: [],
				},
			],
		]);

		const model = new ModelIRImpl(tables, new Map());

		it('should create tables proxy', () => {
			const proxy = createTablesProxy(model, ['users', 'posts']);
			expect(proxy).toBeDefined();
		});

		it('should return TableRef for valid table names', () => {
			const proxy = createTablesProxy(model, ['users', 'posts']);
			const users = (proxy as unknown as Record<string, unknown>).users;
			expect(users[BRAND]).toBe('TableRef');
			expect(users[TABLE_META]).toBe('users');
		});

		it('should cache TableRef instances', () => {
			const proxy = createTablesProxy(model, ['users', 'posts']);
			const users1 = (proxy as unknown as Record<string, unknown>).users;
			const users2 = (proxy as unknown as Record<string, unknown>).users;
			expect(users1).toBe(users2); // Same instance
		});

		it('should return undefined for non-existent tables', () => {
			const proxy = createTablesProxy(model, ['users', 'posts']);
			const result = (proxy as unknown as Record<string, unknown>).nonExistent;
			expect(result).toBeUndefined();
		});

		it('should return undefined for symbols', () => {
			const proxy = createTablesProxy(model, ['users', 'posts']);
			const result = (proxy as unknown as Record<symbol, unknown>)[
				Symbol('test')
			];
			expect(result).toBeUndefined();
		});

		it('should support has() trap', () => {
			const proxy = createTablesProxy(model, ['users', 'posts']);
			expect('users' in proxy).toBe(true);
			expect('posts' in proxy).toBe(true);
			expect('nonExistent' in proxy).toBe(false);
		});

		it('should return false for has() with symbols', () => {
			const proxy = createTablesProxy(model, ['users', 'posts']);
			expect(Symbol('test') in proxy).toBe(false);
		});

		it('should support ownKeys() trap', () => {
			const proxy = createTablesProxy(model, ['users', 'posts']);
			const keys = Reflect.ownKeys(proxy);
			expect(keys).toEqual(['users', 'posts']);
		});

		it('should support getOwnPropertyDescriptor() trap', () => {
			const proxy = createTablesProxy(model, ['users', 'posts']);
			const desc = Object.getOwnPropertyDescriptor(proxy, 'users');
			expect(desc).toBeDefined();
			expect(desc?.enumerable).toBe(true);
			expect(desc?.configurable).toBe(true);
		});

		it('should create TableRef in getOwnPropertyDescriptor if not cached', () => {
			const proxy = createTablesProxy(model, ['users', 'posts']);
			// First call should create and cache
			const desc1 = Object.getOwnPropertyDescriptor(proxy, 'users');
			expect(desc1?.value[BRAND]).toBe('TableRef');
			// Second call should return cached
			const desc2 = Object.getOwnPropertyDescriptor(proxy, 'users');
			expect(desc1?.value).toBe(desc2?.value);
		});

		it('should return undefined for getOwnPropertyDescriptor on non-existent', () => {
			const proxy = createTablesProxy(model, ['users', 'posts']);
			const desc = Object.getOwnPropertyDescriptor(proxy, 'nonExistent');
			expect(desc).toBeUndefined();
		});
	});
});
