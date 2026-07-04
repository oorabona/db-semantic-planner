// @ts-nocheck — coverage test: runtime assertions on AST nodes
/**
 * Coverage tests for table-ref-factory.ts
 *
 * Focuses on edge cases and branches not covered by table-ref.test.ts
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelIRImpl } from '../model-impl.js';
import type { TableIR } from '../model-ir.js';
import { resetLogger, setLogger, silentLogger } from './logger.js';
import { createOrm } from './orm.js';
import { schema } from './schema.js';
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
import { createMockAdapter } from './test-utils.js';

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

	describe('reserved-word warning: module-level dedup + suppression (#159)', () => {
		afterEach(() => {
			// resetLogger() also clears the module-level warnedReservedWords Set.
			resetLogger();
		});

		function reservedWordModel(tableName: string): ModelIRImpl {
			const tables = new Map<string, TableIR>([
				[
					tableName,
					{
						name: tableName,
						columns: [
							{ name: 'id', type: 'uuid', nullable: false },
							{ name: 'class', type: 'text', nullable: false }, // Reserved word, not a built-in
						],
						primaryKey: 'id',
						foreignKeys: [],
						indexes: [],
					},
				],
			]);
			return new ModelIRImpl(tables, new Map());
		}

		it('warns once per table.column across multiple createTableRef() calls (simulating multiple createOrm() instances)', () => {
			const warnSpy = vi.fn();
			setLogger({ warn: warnSpy });
			const model = reservedWordModel('dedup_test');

			// First "ORM instance"
			const ref1 = createTableRef('dedup_test', model);
			void (ref1 as Record<string, unknown>).class;
			expect(warnSpy).toHaveBeenCalledTimes(1);

			// Second "ORM instance" — a brand new Proxy/object, same table.column.
			// Before #159 the dedup Set lived inside createTableRef, so this
			// used to re-warn (the "prints twice" symptom); now it must not.
			const ref2 = createTableRef('dedup_test', model);
			void (ref2 as Record<string, unknown>).class;
			expect(warnSpy).toHaveBeenCalledTimes(1);
		});

		it('resetLogger() clears the dedup set for test isolation', () => {
			const warnSpy = vi.fn();
			setLogger({ warn: warnSpy });
			const model = reservedWordModel('dedup_reset');

			const ref1 = createTableRef('dedup_reset', model);
			void (ref1 as Record<string, unknown>).class;
			expect(warnSpy).toHaveBeenCalledTimes(1);

			resetLogger();
			setLogger({ warn: warnSpy }); // resetLogger() reverts to defaultLogger

			const ref2 = createTableRef('dedup_reset', model);
			void (ref2 as Record<string, unknown>).class;
			expect(warnSpy).toHaveBeenCalledTimes(2); // warned again — dedup was cleared
		});

		it('createTableRef() suppress param suppresses the reserved-word warning', () => {
			const warnSpy = vi.fn();
			setLogger({ warn: warnSpy });
			const model = reservedWordModel('dedup_suppress');

			const ref = createTableRef('dedup_suppress', model, ['dx']);
			void (ref as Record<string, unknown>).class;

			expect(warnSpy).not.toHaveBeenCalled();
		});

		it('threads suppressDxWarnings from createOrm() through a schema-provided tables proxy', () => {
			// This exercises the step-back-flagged path: createOrm() reuses
			// schemaObj.tables verbatim UNLESS suppressDxWarnings is set, in
			// which case it must rebuild via createTablesProxy so the option
			// actually reaches createTableRef.
			const warnSpy = vi.fn();
			setLogger({ warn: warnSpy });

			const reservedSchema = schema({
				widgets: {
					id: { type: 'uuid', primaryKey: true },
					class: 'string',
				},
			});

			const orm = createOrm({
				schema: reservedSchema,
				adapter: createMockAdapter(),
				suppressDxWarnings: true,
			});

			// orm.tables.widgets augments the TableRef with DDL methods via
			// Object.assign, which enumerates own keys (including `class`)
			// and would trigger the reserved-word warning if not suppressed.
			void orm.tables.widgets;

			expect(warnSpy).not.toHaveBeenCalled();
		});

		describe('suppressed access must NOT poison the dedup for later, non-suppressed callers', () => {
			it('per-instance suppress (createTableRef) then an unsuppressed createTableRef() still warns', () => {
				const warnSpy = vi.fn();
				setLogger({ warn: warnSpy });
				const model = reservedWordModel('poison_suppress_param');

				// First "ORM instance" — suppressed, must NOT warn AND must NOT
				// consume the dedup slot.
				const suppressedRef = createTableRef('poison_suppress_param', model, [
					'dx',
				]);
				void (suppressedRef as Record<string, unknown>).class;
				expect(warnSpy).not.toHaveBeenCalled();

				// Second "ORM instance" — no suppression — must still warn.
				const unsuppressedRef = createTableRef('poison_suppress_param', model);
				void (unsuppressedRef as Record<string, unknown>).class;
				expect(warnSpy).toHaveBeenCalledTimes(1);
			});

			it('createOrm({ suppressDxWarnings: true }) then a plain createOrm() still warns', () => {
				const warnSpy = vi.fn();
				setLogger({ warn: warnSpy });

				const reservedSchema = schema({
					gadgets: {
						id: { type: 'uuid', primaryKey: true },
						class: 'string',
					},
				});

				const suppressedOrm = createOrm({
					schema: reservedSchema,
					adapter: createMockAdapter(),
					suppressDxWarnings: true,
				});
				void suppressedOrm.tables.gadgets;
				expect(warnSpy).not.toHaveBeenCalled();

				const plainOrm = createOrm({
					schema: reservedSchema,
					adapter: createMockAdapter(),
				});
				void plainOrm.tables.gadgets;
				expect(warnSpy).toHaveBeenCalledTimes(1);
			});

			it('DBSP_SUPPRESS_DX_WARNINGS env gate then an unsuppressed access still warns', () => {
				const ENV_KEY = 'DBSP_SUPPRESS_DX_WARNINGS';
				const originalEnv = process.env[ENV_KEY];

				const warnSpy = vi.fn();
				setLogger({ warn: warnSpy });
				const model = reservedWordModel('poison_env');

				try {
					process.env[ENV_KEY] = '1';
					const ref1 = createTableRef('poison_env', model);
					void (ref1 as Record<string, unknown>).class;
					expect(warnSpy).not.toHaveBeenCalled();

					delete process.env[ENV_KEY];
					const ref2 = createTableRef('poison_env', model);
					void (ref2 as Record<string, unknown>).class;
					expect(warnSpy).toHaveBeenCalledTimes(1);
				} finally {
					if (originalEnv === undefined) {
						delete process.env[ENV_KEY];
					} else {
						process.env[ENV_KEY] = originalEnv;
					}
				}
			});

			it('a global silentLogger then a real logger installed later still warns', () => {
				const model = reservedWordModel('poison_silent');

				setLogger(silentLogger);
				const ref1 = createTableRef('poison_silent', model);
				void (ref1 as Record<string, unknown>).class;
				// Nothing to assert on silentLogger itself — the point is that
				// the dedup slot must NOT be consumed by this suppressed access.

				const warnSpy = vi.fn();
				setLogger({ warn: warnSpy });
				const ref2 = createTableRef('poison_silent', model);
				void (ref2 as Record<string, unknown>).class;
				expect(warnSpy).toHaveBeenCalledTimes(1);
			});
		});
	});
});
