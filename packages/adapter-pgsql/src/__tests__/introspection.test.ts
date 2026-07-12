/**
 * Introspection Unit Tests (ADAPTER-006)
 *
 * Tests introspect() with mock pg.Pool returning controlled result sets.
 */

import { createOrm, exists } from '@dbsp/core';
import type { Pool, QueryResult } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { type DetectedHierarchy, introspect } from '../introspection.js';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

// ============================================================================
// Mock Pool Factory
// ============================================================================

type QueryRows = Record<string, unknown>[];

function createMockPool(queries: QueryRows[]): Pool {
	let callIndex = 0;
	return {
		query: vi.fn().mockImplementation(() => {
			const rows = queries[callIndex++] ?? [];
			return Promise.resolve({ rows, rowCount: rows.length } as QueryResult);
		}),
	} as unknown as Pool;
}

// ============================================================================
// Helpers
// ============================================================================

/** Standard columns result for a "users" + "posts" schema */
const usersPostsColumns = [
	{
		table_name: 'users',
		column_name: 'id',
		data_type: 'integer',
		udt_name: 'int4',
		is_nullable: 'NO',
		column_default: null,
	},
	{
		table_name: 'users',
		column_name: 'name',
		data_type: 'character varying',
		udt_name: 'varchar',
		is_nullable: 'NO',
		column_default: null,
	},
	{
		table_name: 'users',
		column_name: 'email',
		data_type: 'character varying',
		udt_name: 'varchar',
		is_nullable: 'YES',
		column_default: null,
	},
	{
		table_name: 'posts',
		column_name: 'id',
		data_type: 'integer',
		udt_name: 'int4',
		is_nullable: 'NO',
		column_default: null,
	},
	{
		table_name: 'posts',
		column_name: 'title',
		data_type: 'text',
		udt_name: 'text',
		is_nullable: 'NO',
		column_default: null,
	},
	{
		table_name: 'posts',
		column_name: 'author_id',
		data_type: 'integer',
		udt_name: 'int4',
		is_nullable: 'NO',
		column_default: null,
	},
];

const usersPostsPKs = [
	{ table_name: 'users', column_name: 'id' },
	{ table_name: 'posts', column_name: 'id' },
];

const usersPostsFKs = [
	{
		constraint_name: 'posts_author_id_fkey',
		source_table: 'posts',
		source_column: 'author_id',
		target_table: 'users',
		target_column: 'id',
		delete_rule: 'CASCADE',
	},
];

// ============================================================================
// Tests
// ============================================================================

describe('introspect', () => {
	it('should discover tables and columns', async () => {
		const pool = createMockPool([usersPostsColumns, usersPostsPKs, []]);
		const result = await introspect(pool);

		expect(result.tables.size).toBe(2);
		const users = result.tables.get('users');
		expect(users).toBeDefined();
		expect(users!.columns).toHaveLength(3);
		expect(users!.primaryKey).toBe('id');
		expect(users!.columns[0]!.name).toBe('id');
		expect(users!.columns[0]!.type).toBe('integer');
	});

	it('should map column types correctly', async () => {
		const columns = [
			{
				table_name: 't',
				column_name: 'a',
				data_type: 'integer',
				udt_name: 'int4',
				is_nullable: 'NO',
				column_default: null,
			},
			{
				table_name: 't',
				column_name: 'b',
				data_type: 'boolean',
				udt_name: 'bool',
				is_nullable: 'YES',
				column_default: null,
			},
			{
				table_name: 't',
				column_name: 'c',
				data_type: 'timestamp with time zone',
				udt_name: 'timestamptz',
				is_nullable: 'NO',
				column_default: null,
			},
			{
				table_name: 't',
				column_name: 'd',
				data_type: 'USER-DEFINED',
				udt_name: 'uuid',
				is_nullable: 'NO',
				column_default: null,
			},
			{
				table_name: 't',
				column_name: 'e',
				data_type: 'USER-DEFINED',
				udt_name: 'jsonb',
				is_nullable: 'NO',
				column_default: null,
			},
			{
				table_name: 't',
				column_name: 'f',
				data_type: 'bigint',
				udt_name: 'int8',
				is_nullable: 'NO',
				column_default: null,
			},
			{
				table_name: 't',
				column_name: 'g',
				data_type: 'text',
				udt_name: 'text',
				is_nullable: 'NO',
				column_default: null,
			},
			{
				table_name: 't',
				column_name: 'h',
				data_type: 'date',
				udt_name: 'date',
				is_nullable: 'NO',
				column_default: null,
			},
		];
		const pks = [{ table_name: 't', column_name: 'a' }];
		const pool = createMockPool([columns, pks, []]);
		const result = await introspect(pool);

		const table = result.tables.get('t')!;
		expect(table.columns[0]!.type).toBe('integer');
		expect(table.columns[1]!.type).toBe('boolean');
		expect(table.columns[1]!.nullable).toBe(true);
		expect(table.columns[2]!.type).toBe('datetime');
		expect(table.columns[3]!.type).toBe('uuid');
		expect(table.columns[4]!.type).toBe('jsonb');
		expect(table.columns[5]!.type).toBe('bigint');
		expect(table.columns[6]!.type).toBe('text');
		expect(table.columns[7]!.type).toBe('date');
	});

	it('should source originalDbType from format_type catalog rows', async () => {
		const columns = [
			{
				table_name: 'metrics',
				column_name: 'id',
				data_type: 'integer',
				udt_name: 'int4',
				is_nullable: 'NO',
				column_default: null,
			},
			{
				table_name: 'metrics',
				column_name: 'label',
				data_type: 'character varying',
				udt_name: 'varchar',
				is_nullable: 'NO',
				column_default: null,
			},
			{
				table_name: 'metrics',
				column_name: 'captured_at',
				data_type: 'timestamp with time zone',
				udt_name: 'timestamptz',
				is_nullable: 'NO',
				column_default: null,
			},
			{
				table_name: 'metrics',
				column_name: 'embedding',
				data_type: 'USER-DEFINED',
				udt_name: 'vector',
				is_nullable: 'NO',
				column_default: null,
			},
			{
				table_name: 'metrics',
				column_name: 'state',
				data_type: 'USER-DEFINED',
				udt_name: 'status',
				is_nullable: 'NO',
				column_default: null,
			},
		];
		const pks = [{ table_name: 'metrics', column_name: 'id' }];
		const formattedColumnTypes = [
			{
				table_name: 'metrics',
				column_name: 'label',
				db_type: 'character varying(120)',
				type_schema: 'pg_catalog',
			},
			{
				table_name: 'metrics',
				column_name: 'captured_at',
				db_type: 'timestamp(3) with time zone',
				type_schema: 'pg_catalog',
			},
			{
				table_name: 'metrics',
				column_name: 'embedding',
				db_type: 'vector(768)',
				type_schema: 'public',
			},
			{
				table_name: 'metrics',
				column_name: 'state',
				db_type: 'status',
				type_schema: 'tenant_1',
			},
		];
		const pool = createMockPool([
			columns,
			pks,
			[],
			[],
			[],
			[],
			[],
			[],
			[],
			[],
			[],
			[],
			[],
			formattedColumnTypes,
		]);

		const result = await introspect(pool, { schema: 'tenant_1' });
		const table = result.tables.get('metrics')!;

		expect(
			table.columns.map((column) => ({
				name: column.name,
				type: column.type,
				originalDbType: column.originalDbType,
				originalDbTypeSchema: column.originalDbTypeSchema,
				originalDbTypeSchemaScope: column.originalDbTypeSchemaScope,
			})),
		).toEqual([
			{
				name: 'id',
				type: 'integer',
				originalDbType: 'int4',
				originalDbTypeSchema: undefined,
				originalDbTypeSchemaScope: undefined,
			},
			{
				name: 'label',
				type: 'string',
				originalDbType: 'character varying(120)',
				originalDbTypeSchema: undefined,
				originalDbTypeSchemaScope: undefined,
			},
			{
				name: 'captured_at',
				type: 'datetime',
				originalDbType: 'timestamp(3) with time zone',
				originalDbTypeSchema: undefined,
				originalDbTypeSchemaScope: undefined,
			},
			{
				name: 'embedding',
				type: 'string',
				originalDbType: 'vector(768)',
				originalDbTypeSchema: 'public',
				originalDbTypeSchemaScope: 'absolute',
			},
			{
				name: 'state',
				type: 'string',
				originalDbType: 'status',
				originalDbTypeSchema: 'tenant_1',
				originalDbTypeSchemaScope: 'target',
			},
		]);

		const mockQuery = pool.query as ReturnType<typeof vi.fn>;
		const formatTypeCalls = mockQuery.mock.calls
			.filter((call) =>
				String(call[0]).includes('format_type(a.atttypid, a.atttypmod)'),
			)
			.map((call) => ({
				sql: String(call[0]).replace(/\s+/g, ' ').trim(),
				params: call[1],
			}));
		expect(formatTypeCalls).toEqual([
			{
				sql: "SELECT c.relname AS table_name, a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS db_type, tn.nspname AS type_schema FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace JOIN pg_catalog.pg_type t ON t.oid = a.atttypid JOIN pg_catalog.pg_namespace tn ON tn.oid = t.typnamespace WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f') AND a.attnum > 0 AND NOT a.attisdropped AND ( a.atttypmod <> -1 OR t.typcategory = 'A' OR t.typnamespace <> 'pg_catalog'::regnamespace )",
				params: ['tenant_1'],
			},
		]);
	});

	it('should populate enum schema from catalog rows', async () => {
		const pool = createMockPool([
			[],
			[],
			[],
			[],
			[],
			[
				{
					name: 'status',
					schema: 'tenant_1',
					values: ['active', 'inactive'],
				},
			],
			[],
			[],
			[],
			[],
			[],
			[],
			[],
			[],
		]);

		const result = await introspect(pool, { schema: 'tenant_1' });

		expect(result.enums?.get('status')).toEqual({
			name: 'status',
			schema: 'tenant_1',
			values: ['active', 'inactive'],
		});
	});

	it('should infer bidirectional relations from FK', async () => {
		const pool = createMockPool([
			usersPostsColumns,
			usersPostsPKs,
			usersPostsFKs,
		]);
		const result = await introspect(pool);

		// belongsTo: posts.author → users
		const belongsTo = result.relations.get('posts.author');
		expect(belongsTo).toBeDefined();
		expect(belongsTo!.type).toBe('belongsTo');
		expect(belongsTo!.source).toBe('posts');
		expect(belongsTo!.target).toBe('users');
		expect(belongsTo!.foreignKey).toBe('author_id');
		expect(belongsTo!.cardinality).toBe('one');

		// hasMany: users.posts → posts
		const hasMany = result.relations.get('users.posts');
		expect(hasMany).toBeDefined();
		expect(hasMany!.type).toBe('hasMany');
		expect(hasMany!.source).toBe('users');
		expect(hasMany!.target).toBe('posts');
		expect(hasMany!.cardinality).toBe('many');
	});

	it('should preserve composite referenced non-id keys in relations and SQL correlation', async () => {
		const columns = [
			{
				table_name: 'orders',
				column_name: 'id',
				data_type: 'integer',
				udt_name: 'int4',
				is_nullable: 'NO',
				column_default: null,
			},
			{
				table_name: 'orders',
				column_name: 'order_id',
				data_type: 'integer',
				udt_name: 'int4',
				is_nullable: 'NO',
				column_default: null,
			},
			{
				table_name: 'orders',
				column_name: 'tenant_id',
				data_type: 'integer',
				udt_name: 'int4',
				is_nullable: 'NO',
				column_default: null,
			},
			{
				table_name: 'order_items',
				column_name: 'id',
				data_type: 'integer',
				udt_name: 'int4',
				is_nullable: 'NO',
				column_default: null,
			},
			{
				table_name: 'order_items',
				column_name: 'order_id',
				data_type: 'integer',
				udt_name: 'int4',
				is_nullable: 'NO',
				column_default: null,
			},
			{
				table_name: 'order_items',
				column_name: 'tenant_id',
				data_type: 'integer',
				udt_name: 'int4',
				is_nullable: 'NO',
				column_default: null,
			},
		];
		const pks = [
			{ table_name: 'orders', column_name: 'id' },
			{ table_name: 'order_items', column_name: 'id' },
		];
		const fks = [
			{
				constraint_name: 'order_items_order_ref_fkey',
				source_table: 'order_items',
				source_column: 'order_id',
				target_table: 'orders',
				target_column: 'order_id',
				delete_rule: 'NO ACTION',
				update_rule: 'NO ACTION',
				is_deferrable: 'NO',
				initially_deferred: 'NO',
			},
			{
				constraint_name: 'order_items_order_ref_fkey',
				source_table: 'order_items',
				source_column: 'tenant_id',
				target_table: 'orders',
				target_column: 'tenant_id',
				delete_rule: 'NO ACTION',
				update_rule: 'NO ACTION',
				is_deferrable: 'NO',
				initially_deferred: 'NO',
			},
		];
		const pool = createMockPool([columns, pks, fks]);
		const result = await introspect(pool);

		expect(result.relations.get('order_items.order')).toMatchObject({
			type: 'belongsTo',
			source: 'order_items',
			target: 'orders',
			foreignKey: ['order_id', 'tenant_id'],
			targetKey: ['order_id', 'tenant_id'],
		});
		expect(result.relations.get('orders.order_items')).toMatchObject({
			type: 'hasMany',
			source: 'orders',
			target: 'order_items',
			foreignKey: ['order_id', 'tenant_id'],
			sourceKey: ['order_id', 'tenant_id'],
		});

		const adapter = createPgsqlCompileOnlyAdapter({ model: result });
		const orm = createOrm({ model: result, adapter });
		const { sql } = (orm as any)
			.select('orders')
			.where(exists('order_items'))
			.dump();

		expect(sql).toMatch(/EXISTS/i);
		expect(sql).toMatch(
			/orders\.order_id\s*=\s*order_items_exists_\d+\.order_id\s+AND\s+orders\.tenant_id\s*=\s*order_items_exists_\d+\.tenant_id/i,
		);
		expect(sql).not.toMatch(
			/orders\.id\s*=\s*order_items_exists_\d+\.order_id/i,
		);
	});

	it('should detect adjacency hierarchy (self-referential FK)', async () => {
		const columns = [
			{
				table_name: 'categories',
				column_name: 'id',
				data_type: 'integer',
				udt_name: 'int4',
				is_nullable: 'NO',
				column_default: null,
			},
			{
				table_name: 'categories',
				column_name: 'name',
				data_type: 'text',
				udt_name: 'text',
				is_nullable: 'NO',
				column_default: null,
			},
			{
				table_name: 'categories',
				column_name: 'parent_id',
				data_type: 'integer',
				udt_name: 'int4',
				is_nullable: 'YES',
				column_default: null,
			},
		];
		const pks = [{ table_name: 'categories', column_name: 'id' }];
		const fks = [
			{
				constraint_name: 'categories_parent_id_fkey',
				source_table: 'categories',
				source_column: 'parent_id',
				target_table: 'categories',
				target_column: 'id',
				delete_rule: 'SET NULL',
			},
		];

		const pool = createMockPool([columns, pks, fks]);
		const result = await introspect(pool);

		expect(result.hierarchies).toHaveLength(1);
		expect(result.hierarchies[0]!.type).toBe('adjacency');
		expect(result.hierarchies[0]!.nodeTable).toBe('categories');
		expect(result.hierarchies[0]!.parentColumn).toBe('parent_id');
		expect(result.hierarchies[0]!.nodeIdColumn).toBe('id');
	});

	it('should detect edge-table hierarchy', async () => {
		const columns = [
			{
				table_name: 'nodes',
				column_name: 'id',
				data_type: 'integer',
				udt_name: 'int4',
				is_nullable: 'NO',
				column_default: null,
			},
			{
				table_name: 'edges',
				column_name: 'id',
				data_type: 'integer',
				udt_name: 'int4',
				is_nullable: 'NO',
				column_default: null,
			},
			{
				table_name: 'edges',
				column_name: 'parent_id',
				data_type: 'integer',
				udt_name: 'int4',
				is_nullable: 'NO',
				column_default: null,
			},
			{
				table_name: 'edges',
				column_name: 'child_id',
				data_type: 'integer',
				udt_name: 'int4',
				is_nullable: 'NO',
				column_default: null,
			},
		];
		const pks = [
			{ table_name: 'nodes', column_name: 'id' },
			{ table_name: 'edges', column_name: 'id' },
		];
		const fks = [
			{
				constraint_name: 'edges_parent_id_fkey',
				source_table: 'edges',
				source_column: 'parent_id',
				target_table: 'nodes',
				target_column: 'id',
				delete_rule: 'CASCADE',
			},
			{
				constraint_name: 'edges_child_id_fkey',
				source_table: 'edges',
				source_column: 'child_id',
				target_table: 'nodes',
				target_column: 'id',
				delete_rule: 'CASCADE',
			},
		];

		const pool = createMockPool([columns, pks, fks]);
		const result = await introspect(pool);

		const edgeHierarchy = result.hierarchies.find(
			(h: DetectedHierarchy) => h.type === 'edge-table',
		);
		expect(edgeHierarchy).toBeDefined();
		expect(edgeHierarchy!.nodeTable).toBe('nodes');
		expect(edgeHierarchy!.edgeTable).toBe('edges');
		expect(edgeHierarchy!.parentColumn).toBe('parent_id');
		expect(edgeHierarchy!.childColumn).toBe('child_id');
	});

	it('should apply include filter', async () => {
		const pool = createMockPool([
			usersPostsColumns,
			usersPostsPKs,
			usersPostsFKs,
		]);
		const result = await introspect(pool, { include: ['users'] });

		expect(result.tables.size).toBe(1);
		expect(result.tables.has('users')).toBe(true);
		expect(result.tables.has('posts')).toBe(false);
	});

	it('should apply exclude filter', async () => {
		const pool = createMockPool([
			usersPostsColumns,
			usersPostsPKs,
			usersPostsFKs,
		]);
		const result = await introspect(pool, { exclude: ['posts'] });

		expect(result.tables.size).toBe(1);
		expect(result.tables.has('users')).toBe(true);
	});

	it('should apply glob pattern in exclude', async () => {
		const pool = createMockPool([
			usersPostsColumns,
			usersPostsPKs,
			usersPostsFKs,
		]);
		const result = await introspect(pool, { exclude: ['post*'] });

		expect(result.tables.size).toBe(1);
		expect(result.tables.has('users')).toBe(true);
	});

	it('should warn about tables without primary key', async () => {
		const columns = [
			{
				table_name: 'logs',
				column_name: 'message',
				data_type: 'text',
				udt_name: 'text',
				is_nullable: 'NO',
				column_default: null,
			},
		];
		const pool = createMockPool([columns, [], []]);
		const result = await introspect(pool);

		expect(result.warnings).toContain('Table "logs" has no primary key');
	});

	it('should pass schema to queries', async () => {
		const pool = createMockPool([[], [], [], []]);
		await introspect(pool, { schema: 'tenant_1' });

		const mockQuery = pool.query as ReturnType<typeof vi.fn>;
		// 14 queries total: columns, PKs, FKs, indexes, unique columns, enums,
		// comments, checks, partitions, extensions, sequences, rls state, policies,
		// formatted column types
		// Note: extensions query has no schema param (queries all extensions globally)
		expect(mockQuery).toHaveBeenCalledTimes(14);
		// All parameterized queries (those with a second arg) should pass 'tenant_1'
		for (const call of mockQuery.mock.calls) {
			if (call[1] !== undefined) {
				expect(call[1]).toEqual(['tenant_1']);
			}
		}
		const uniqueConstraintQuery = mockQuery.mock.calls.find((call) =>
			String(call[0]).includes('array_length(c.conkey, 1) = 1'),
		);
		expect(uniqueConstraintQuery?.[0]).toContain(
			'c.conname AS constraint_name',
		);
		expect(uniqueConstraintQuery?.[0]).toContain("c.contype = 'u'");
	});

	it('should handle FK onDelete rules', async () => {
		const pool = createMockPool([
			usersPostsColumns,
			usersPostsPKs,
			usersPostsFKs,
		]);
		const result = await introspect(pool);

		const posts = result.tables.get('posts')!;
		expect(posts.foreignKeys).toHaveLength(1);
		expect(posts.foreignKeys[0]!.onDelete).toBe('CASCADE');
	});

	it('should include FK NOT VALID state from pg_constraint', async () => {
		const fks = [
			{
				constraint_name: 'fk_posts_author_id',
				source_table: 'posts',
				source_column: 'author_id',
				target_schema: 'public',
				target_table: 'users',
				target_column: 'id',
				delete_rule: 'NO ACTION',
				update_rule: 'NO ACTION',
				is_deferrable: 'NO',
				initially_deferred: 'NO',
				not_valid: true,
			},
		];
		const pool = createMockPool([usersPostsColumns, usersPostsPKs, fks]);

		const result = await introspect(pool);

		const posts = result.tables.get('posts')!;
		expect(posts.foreignKeys).toHaveLength(1);
		expect(posts.foreignKeys[0]!.notValid).toBe(true);
	});

	it('should include column defaults', async () => {
		const columns = [
			{
				table_name: 't',
				column_name: 'id',
				data_type: 'integer',
				udt_name: 'int4',
				is_nullable: 'NO',
				column_default: "nextval('t_id_seq')",
			},
			{
				table_name: 't',
				column_name: 'active',
				data_type: 'boolean',
				udt_name: 'bool',
				is_nullable: 'NO',
				column_default: 'true',
			},
		];
		const pks = [{ table_name: 't', column_name: 'id' }];
		const pool = createMockPool([columns, pks, []]);
		const result = await introspect(pool);

		const table = result.tables.get('t')!;
		// C5 fix: introspected defaults are stored as { sql } to be emitted verbatim by formatDefaultValue
		expect((table.columns[0]!.default as { sql: string }).sql).toContain(
			'nextval',
		);
		expect((table.columns[1]!.default as { sql: string }).sql).toBe('true');
	});

	it('should include introspectedAt timestamp', async () => {
		const pool = createMockPool([[], [], []]);
		const before = new Date();
		const result = await introspect(pool);
		const after = new Date();

		expect(result.introspectedAt.getTime()).toBeGreaterThanOrEqual(
			before.getTime(),
		);
		expect(result.introspectedAt.getTime()).toBeLessThanOrEqual(
			after.getTime(),
		);
	});

	it('should exclude FK relations when target table is filtered out', async () => {
		const pool = createMockPool([
			usersPostsColumns,
			usersPostsPKs,
			usersPostsFKs,
		]);
		const result = await introspect(pool, { include: ['users'] });

		// No relations since posts is excluded
		expect(result.relations.size).toBe(0);
		// No FKs on users table pointing to excluded tables
		const users = result.tables.get('users')!;
		expect(users.foreignKeys).toHaveLength(0);
	});

	it('should discover indexes on tables', async () => {
		const indexes = [
			{
				index_name: 'idx_posts_title',
				table_name: 'posts',
				columns: ['title'],
				is_unique: false,
			},
			{
				index_name: 'idx_users_email',
				table_name: 'users',
				columns: ['email'],
				is_unique: true,
			},
		];
		const pool = createMockPool([
			usersPostsColumns,
			usersPostsPKs,
			usersPostsFKs,
			indexes,
		]);
		const result = await introspect(pool);

		const posts = result.tables.get('posts')!;
		expect(posts.indexes).toHaveLength(1);
		expect(posts.indexes[0]!.name).toBe('idx_posts_title');
		expect(posts.indexes[0]!.columns).toEqual(['title']);
		expect(posts.indexes[0]!.unique).toBeUndefined();

		const users = result.tables.get('users')!;
		expect(users.indexes).toHaveLength(1);
		expect(users.indexes[0]!.name).toBe('idx_users_email');
		expect(users.indexes[0]!.columns).toEqual(['email']);
		expect(users.indexes[0]!.unique).toBe(true);
	});

	it('should return empty indexes when none exist', async () => {
		const pool = createMockPool([
			usersPostsColumns,
			usersPostsPKs,
			usersPostsFKs,
			[], // no indexes
		]);
		const result = await introspect(pool);

		const users = result.tables.get('users')!;
		expect(users.indexes).toHaveLength(0);
		const posts = result.tables.get('posts')!;
		expect(posts.indexes).toHaveLength(0);
	});

	it('should map single-column unique constraints to column unique', async () => {
		const uniqueColumns = [
			{
				table_name: 'users',
				column_name: 'email',
				constraint_name: 'users_email_custom_uq',
			},
		];
		const pool = createMockPool([
			usersPostsColumns,
			usersPostsPKs,
			usersPostsFKs,
			[], // no user-defined indexes
			uniqueColumns,
		]);
		const result = await introspect(pool);

		const users = result.tables.get('users')!;
		const email = users.columns.find((col) => col.name === 'email')!;
		const name = users.columns.find((col) => col.name === 'name')!;
		expect(email.unique).toBe(true);
		expect(email.uniqueConstraintName).toBe('users_email_custom_uq');
		expect(name.unique).toBeUndefined();

		const posts = result.tables.get('posts')!;
		const title = posts.columns.find((col) => col.name === 'title')!;
		expect(title.unique).toBeUndefined();
	});

	it('should discover composite indexes', async () => {
		const indexes = [
			{
				index_name: 'idx_posts_author_title',
				table_name: 'posts',
				columns: ['author_id', 'title'],
				is_unique: false,
			},
		];
		const pool = createMockPool([
			usersPostsColumns,
			usersPostsPKs,
			usersPostsFKs,
			indexes,
		]);
		const result = await introspect(pool);

		const posts = result.tables.get('posts')!;
		expect(posts.indexes).toHaveLength(1);
		expect(posts.indexes[0]!.columns).toEqual(['author_id', 'title']);
	});

	it('should map NULLS NOT DISTINCT from unique index introspection', async () => {
		const indexes = [
			{
				index_name: 'idx_users_email_unique',
				table_name: 'users',
				columns: ['email'],
				include_columns: null,
				expressions_text: null,
				opclass_names: null,
				opclass_cols: null,
				is_unique: true,
				nulls_not_distinct: true,
				method: 'btree',
				predicate: null,
				reloptions: null,
			},
			{
				index_name: 'idx_posts_title',
				table_name: 'posts',
				columns: ['title'],
				include_columns: null,
				expressions_text: null,
				opclass_names: null,
				opclass_cols: null,
				is_unique: false,
				nulls_not_distinct: true,
				method: 'btree',
				predicate: null,
				reloptions: null,
			},
		];
		const pool = createMockPool([
			usersPostsColumns,
			usersPostsPKs,
			usersPostsFKs,
			indexes,
		]);
		const result = await introspect(pool);

		const users = result.tables.get('users')!;
		expect(users.indexes[0]!.unique).toBe(true);
		expect(users.indexes[0]!.nullsNotDistinct).toBe(true);

		const posts = result.tables.get('posts')!;
		expect(posts.indexes[0]!.unique).toBeUndefined();
		expect(posts.indexes[0]!.nullsNotDistinct).toBeUndefined();
	});

	it('should map INCLUDE columns from index introspection', async () => {
		const indexes = [
			{
				index_name: 'idx_users_email_inc',
				table_name: 'users',
				columns: ['email'],
				include_columns: ['name', 'id'],
				expressions_text: null,
				opclass_names: null,
				opclass_cols: null,
				is_unique: false,
				method: 'btree',
				predicate: null,
				reloptions: null,
			},
		];
		const pool = createMockPool([
			usersPostsColumns,
			usersPostsPKs,
			usersPostsFKs,
			indexes,
		]);
		const result = await introspect(pool);

		const users = result.tables.get('users')!;
		const idx = users.indexes[0]!;
		expect(idx.name).toBe('idx_users_email_inc');
		expect(idx.columns).toEqual(['email']);
		expect(idx.include).toEqual(['name', 'id']);
		expect(idx.expressions).toBeUndefined();
		expect(idx.opclass).toBeUndefined();
	});

	it('should map expression index entries from introspection', async () => {
		const indexes = [
			{
				index_name: 'idx_users_lower_email',
				table_name: 'users',
				// expression-only index: columns array is empty (attnum=0 entries filtered out)
				columns: [],
				include_columns: null,
				expressions_text: 'lower(email)',
				opclass_names: null,
				opclass_cols: null,
				is_unique: false,
				method: 'btree',
				predicate: null,
				reloptions: null,
			},
		];
		const pool = createMockPool([
			usersPostsColumns,
			usersPostsPKs,
			usersPostsFKs,
			indexes,
		]);
		const result = await introspect(pool);

		const users = result.tables.get('users')!;
		const idx = users.indexes[0]!;
		expect(idx.name).toBe('idx_users_lower_email');
		expect(idx.expressions).toEqual(['lower(email)']);
	});

	it('should parse multi-expression index entries with nested parentheses', async () => {
		const indexes = [
			{
				index_name: 'idx_multi_expr',
				table_name: 'users',
				columns: [],
				include_columns: null,
				// pg_get_expr serialises multiple expressions comma-separated
				expressions_text: 'lower(email), coalesce(name, id::text)',
				opclass_names: null,
				opclass_cols: null,
				is_unique: false,
				method: 'btree',
				predicate: null,
				reloptions: null,
			},
		];
		const pool = createMockPool([
			usersPostsColumns,
			usersPostsPKs,
			usersPostsFKs,
			indexes,
		]);
		const result = await introspect(pool);

		const users = result.tables.get('users')!;
		const idx = users.indexes[0]!;
		expect(idx.expressions).toEqual([
			'lower(email)',
			'coalesce(name, id::text)',
		]);
	});

	it('should map non-default opclass overrides from introspection', async () => {
		const indexes = [
			{
				index_name: 'idx_users_name_text_ops',
				table_name: 'users',
				columns: ['name', 'email'],
				include_columns: null,
				expressions_text: null,
				// only 'name' column has a non-default opclass
				opclass_names: ['text_pattern_ops'],
				opclass_cols: ['name'],
				is_unique: false,
				method: 'btree',
				predicate: null,
				reloptions: null,
			},
		];
		const pool = createMockPool([
			usersPostsColumns,
			usersPostsPKs,
			usersPostsFKs,
			indexes,
		]);
		const result = await introspect(pool);

		const users = result.tables.get('users')!;
		const idx = users.indexes[0]!;
		expect(idx.opclass).toEqual({ name: 'text_pattern_ops' });
	});

	it('should omit include/expressions/opclass when absent', async () => {
		const indexes = [
			{
				index_name: 'idx_plain',
				table_name: 'users',
				columns: ['email'],
				include_columns: null,
				expressions_text: null,
				opclass_names: null,
				opclass_cols: null,
				is_unique: false,
				method: 'btree',
				predicate: null,
				reloptions: null,
			},
		];
		const pool = createMockPool([
			usersPostsColumns,
			usersPostsPKs,
			usersPostsFKs,
			indexes,
		]);
		const result = await introspect(pool);

		const users = result.tables.get('users')!;
		const idx = users.indexes[0]!;
		expect(idx.include).toBeUndefined();
		expect(idx.expressions).toBeUndefined();
		expect(idx.opclass).toBeUndefined();
	});
});

describe('introspect [P1-T2]: OnDeleteAction SET DEFAULT round-trip', () => {
	it('preserves SET DEFAULT FK action through introspect → ForeignKeyIR', async () => {
		const columns = [
			{
				table_name: 'orders',
				column_name: 'id',
				data_type: 'integer',
				udt_name: 'int4',
				is_nullable: 'NO',
				column_default: null,
			},
			{
				table_name: 'orders',
				column_name: 'status_id',
				data_type: 'integer',
				udt_name: 'int4',
				is_nullable: 'YES',
				column_default: '1',
			},
			{
				table_name: 'statuses',
				column_name: 'id',
				data_type: 'integer',
				udt_name: 'int4',
				is_nullable: 'NO',
				column_default: null,
			},
		];
		const pks = [
			{ table_name: 'orders', column_name: 'id' },
			{ table_name: 'statuses', column_name: 'id' },
		];
		const fks = [
			{
				constraint_name: 'orders_status_id_fkey',
				source_table: 'orders',
				source_column: 'status_id',
				target_table: 'statuses',
				target_column: 'id',
				delete_rule: 'SET DEFAULT',
				update_rule: 'NO ACTION',
				is_deferrable: 'NO',
				initially_deferred: 'NO',
			},
		];

		const pool = createMockPool([columns, pks, fks]);
		const result = await introspect(pool);

		const orders = result.tables.get('orders')!;
		expect(orders).toBeDefined();
		expect(orders.foreignKeys).toHaveLength(1);

		const fk = orders.foreignKeys[0]!;
		expect(fk.columns).toEqual(['status_id']);
		expect(fk.references.table).toBe('statuses');
		// The critical assertion: SET DEFAULT must round-trip correctly
		expect(fk.onDelete).toBe('SET DEFAULT');
	});

	it('maps NO ACTION FK (default) and omits onDelete field', async () => {
		const columns = [
			{
				table_name: 'posts',
				column_name: 'id',
				data_type: 'integer',
				udt_name: 'int4',
				is_nullable: 'NO',
				column_default: null,
			},
			{
				table_name: 'posts',
				column_name: 'user_id',
				data_type: 'integer',
				udt_name: 'int4',
				is_nullable: 'NO',
				column_default: null,
			},
			{
				table_name: 'users',
				column_name: 'id',
				data_type: 'integer',
				udt_name: 'int4',
				is_nullable: 'NO',
				column_default: null,
			},
		];
		const pks = [
			{ table_name: 'posts', column_name: 'id' },
			{ table_name: 'users', column_name: 'id' },
		];
		const fks = [
			{
				constraint_name: 'posts_user_id_fkey',
				source_table: 'posts',
				source_column: 'user_id',
				target_table: 'users',
				target_column: 'id',
				delete_rule: 'NO ACTION',
				update_rule: 'NO ACTION',
				is_deferrable: 'NO',
				initially_deferred: 'NO',
			},
		];

		const pool = createMockPool([columns, pks, fks]);
		const result = await introspect(pool);

		const posts = result.tables.get('posts')!;
		const fk = posts.foreignKeys[0]!;
		// buildTableIR omits onDelete when it is 'NO ACTION' (default)
		expect(fk.onDelete).toBeUndefined();
	});

	it('keeps same-named foreign key constraints on different source tables distinct', async () => {
		const columns = [
			{
				table_name: 'users',
				column_name: 'id',
				data_type: 'integer',
				udt_name: 'int4',
				is_nullable: 'NO',
				column_default: null,
			},
			{
				table_name: 'posts',
				column_name: 'id',
				data_type: 'integer',
				udt_name: 'int4',
				is_nullable: 'NO',
				column_default: null,
			},
			{
				table_name: 'posts',
				column_name: 'owner_id',
				data_type: 'integer',
				udt_name: 'int4',
				is_nullable: 'NO',
				column_default: null,
			},
			{
				table_name: 'comments',
				column_name: 'id',
				data_type: 'integer',
				udt_name: 'int4',
				is_nullable: 'NO',
				column_default: null,
			},
			{
				table_name: 'comments',
				column_name: 'owner_id',
				data_type: 'integer',
				udt_name: 'int4',
				is_nullable: 'NO',
				column_default: null,
			},
		];
		const pks = [
			{ table_name: 'users', column_name: 'id' },
			{ table_name: 'posts', column_name: 'id' },
			{ table_name: 'comments', column_name: 'id' },
		];
		const fks = [
			{
				constraint_name: 'owner_id_fkey',
				source_table: 'posts',
				source_column: 'owner_id',
				target_schema: 'public',
				target_table: 'users',
				target_column: 'id',
				delete_rule: 'NO ACTION',
				update_rule: 'NO ACTION',
				is_deferrable: 'NO',
				initially_deferred: 'NO',
			},
			{
				constraint_name: 'owner_id_fkey',
				source_table: 'comments',
				source_column: 'owner_id',
				target_schema: 'public',
				target_table: 'users',
				target_column: 'id',
				delete_rule: 'NO ACTION',
				update_rule: 'NO ACTION',
				is_deferrable: 'NO',
				initially_deferred: 'NO',
			},
		];

		const pool = createMockPool([columns, pks, fks]);
		const result = await introspect(pool);

		const postsFk = result.tables.get('posts')?.foreignKeys[0];
		const commentsFk = result.tables.get('comments')?.foreignKeys[0];

		expect(result.tables.get('posts')?.foreignKeys).toHaveLength(1);
		expect(result.tables.get('comments')?.foreignKeys).toHaveLength(1);
		expect(postsFk?.columns).toEqual(['owner_id']);
		expect(postsFk?.references).toEqual({
			table: 'users',
			columns: ['id'],
		});
		expect(commentsFk?.columns).toEqual(['owner_id']);
		expect(commentsFk?.references).toEqual({
			table: 'users',
			columns: ['id'],
		});
	});
});

describe('introspect: cross-schema foreign keys', () => {
	it('keeps cross-schema FK targets outside tableNames and sets references.schema', async () => {
		const columns = [
			{
				table_name: 'invoices',
				column_name: 'id',
				data_type: 'integer',
				udt_name: 'int4',
				is_nullable: 'NO',
				column_default: null,
			},
			{
				table_name: 'invoices',
				column_name: 'customer_id',
				data_type: 'integer',
				udt_name: 'int4',
				is_nullable: 'NO',
				column_default: null,
			},
		];
		const pks = [{ table_name: 'invoices', column_name: 'id' }];
		const fks = [
			{
				constraint_name: 'invoices_customer_id_fkey',
				source_table: 'invoices',
				source_column: 'customer_id',
				target_schema: 'auth',
				target_table: 'customers',
				target_column: 'id',
				delete_rule: 'SET NULL',
				update_rule: 'CASCADE',
				is_deferrable: 'YES',
				initially_deferred: 'YES',
			},
		];

		const pool = createMockPool([columns, pks, fks]);
		const result = await introspect(pool, { schema: 'billing' });

		const invoices = result.tables.get('invoices')!;
		expect(invoices.foreignKeys).toHaveLength(1);
		const fk = invoices.foreignKeys[0]!;
		expect(fk.columns).toEqual(['customer_id']);
		expect(fk.references).toEqual({
			schema: 'auth',
			table: 'customers',
			columns: ['id'],
		});
		expect(fk.onDelete).toBe('SET NULL');
		expect(fk.onUpdate).toBe('CASCADE');
		expect(fk.deferred).toBe(true);
	});

	it('does not infer relations from a cross-schema FK to a same-named local table', async () => {
		const columns = [
			{
				table_name: 'invoices',
				column_name: 'id',
				data_type: 'integer',
				udt_name: 'int4',
				is_nullable: 'NO',
				column_default: null,
			},
			{
				table_name: 'invoices',
				column_name: 'customer_id',
				data_type: 'integer',
				udt_name: 'int4',
				is_nullable: 'NO',
				column_default: null,
			},
			{
				table_name: 'customers',
				column_name: 'id',
				data_type: 'integer',
				udt_name: 'int4',
				is_nullable: 'NO',
				column_default: null,
			},
		];
		const pks = [
			{ table_name: 'invoices', column_name: 'id' },
			{ table_name: 'customers', column_name: 'id' },
		];
		const fks = [
			{
				constraint_name: 'invoices_customer_id_fkey',
				source_table: 'invoices',
				source_column: 'customer_id',
				target_schema: 'auth',
				target_table: 'customers',
				target_column: 'id',
				delete_rule: 'NO ACTION',
				update_rule: 'NO ACTION',
				is_deferrable: 'NO',
				initially_deferred: 'NO',
			},
		];

		const pool = createMockPool([columns, pks, fks]);
		const result = await introspect(pool, { schema: 'billing' });

		const fk = result.tables.get('invoices')?.foreignKeys[0];
		expect(fk?.references).toEqual({
			schema: 'auth',
			table: 'customers',
			columns: ['id'],
		});
		expect(result.relations.get('invoices.customer')).toBeUndefined();
		expect(result.relations.get('customers.invoices')).toBeUndefined();
		expect(result.relations.size).toBe(0);
	});

	it('does not detect a same-name cross-schema FK as adjacency hierarchy', async () => {
		const columns = [
			{
				table_name: 'accounts',
				column_name: 'id',
				data_type: 'integer',
				udt_name: 'int4',
				is_nullable: 'NO',
				column_default: null,
			},
			{
				table_name: 'accounts',
				column_name: 'parent_id',
				data_type: 'integer',
				udt_name: 'int4',
				is_nullable: 'YES',
				column_default: null,
			},
		];
		const pks = [{ table_name: 'accounts', column_name: 'id' }];
		const fks = [
			{
				constraint_name: 'accounts_parent_id_fkey',
				source_table: 'accounts',
				source_column: 'parent_id',
				target_schema: 'auth',
				target_table: 'accounts',
				target_column: 'id',
				delete_rule: 'NO ACTION',
				update_rule: 'NO ACTION',
				is_deferrable: 'NO',
				initially_deferred: 'NO',
			},
		];

		const pool = createMockPool([columns, pks, fks]);
		const result = await introspect(pool, { schema: 'billing' });

		const fk = result.tables.get('accounts')?.foreignKeys[0];
		expect(fk?.references.schema).toBe('auth');
		expect(result.hierarchies.find((h) => h.type === 'adjacency')).toBe(
			undefined,
		);
	});

	it('does not detect an edge-table hierarchy from cross-schema FKs to same-named local tables', async () => {
		const columns = [
			{
				table_name: 'nodes',
				column_name: 'id',
				data_type: 'integer',
				udt_name: 'int4',
				is_nullable: 'NO',
				column_default: null,
			},
			{
				table_name: 'edges',
				column_name: 'id',
				data_type: 'integer',
				udt_name: 'int4',
				is_nullable: 'NO',
				column_default: null,
			},
			{
				table_name: 'edges',
				column_name: 'parent_id',
				data_type: 'integer',
				udt_name: 'int4',
				is_nullable: 'NO',
				column_default: null,
			},
			{
				table_name: 'edges',
				column_name: 'child_id',
				data_type: 'integer',
				udt_name: 'int4',
				is_nullable: 'NO',
				column_default: null,
			},
		];
		const pks = [
			{ table_name: 'nodes', column_name: 'id' },
			{ table_name: 'edges', column_name: 'id' },
		];
		const fks = [
			{
				constraint_name: 'edges_parent_id_fkey',
				source_table: 'edges',
				source_column: 'parent_id',
				target_schema: 'graph',
				target_table: 'nodes',
				target_column: 'id',
				delete_rule: 'CASCADE',
				update_rule: 'NO ACTION',
				is_deferrable: 'NO',
				initially_deferred: 'NO',
			},
			{
				constraint_name: 'edges_child_id_fkey',
				source_table: 'edges',
				source_column: 'child_id',
				target_schema: 'graph',
				target_table: 'nodes',
				target_column: 'id',
				delete_rule: 'CASCADE',
				update_rule: 'NO ACTION',
				is_deferrable: 'NO',
				initially_deferred: 'NO',
			},
		];

		const pool = createMockPool([columns, pks, fks]);
		const result = await introspect(pool, { schema: 'billing' });

		expect(result.tables.get('edges')?.foreignKeys).toHaveLength(2);
		expect(
			result.hierarchies.find((h) => h.type === 'edge-table'),
		).toBeUndefined();
	});

	it('omits references.schema for same-schema FK targets', async () => {
		const columns = [
			{
				table_name: 'invoices',
				column_name: 'id',
				data_type: 'integer',
				udt_name: 'int4',
				is_nullable: 'NO',
				column_default: null,
			},
			{
				table_name: 'invoices',
				column_name: 'customer_id',
				data_type: 'integer',
				udt_name: 'int4',
				is_nullable: 'NO',
				column_default: null,
			},
			{
				table_name: 'customers',
				column_name: 'id',
				data_type: 'integer',
				udt_name: 'int4',
				is_nullable: 'NO',
				column_default: null,
			},
		];
		const pks = [
			{ table_name: 'invoices', column_name: 'id' },
			{ table_name: 'customers', column_name: 'id' },
		];
		const fks = [
			{
				constraint_name: 'invoices_customer_id_fkey',
				source_table: 'invoices',
				source_column: 'customer_id',
				target_schema: 'billing',
				target_table: 'customers',
				target_column: 'id',
				delete_rule: 'NO ACTION',
				update_rule: 'NO ACTION',
				is_deferrable: 'YES',
				initially_deferred: 'NO',
			},
		];

		const pool = createMockPool([columns, pks, fks]);
		const result = await introspect(pool, { schema: 'billing' });

		const invoices = result.tables.get('invoices')!;
		expect(invoices.foreignKeys).toHaveLength(1);
		const fk = invoices.foreignKeys[0]!;
		expect(fk.references.table).toBe('customers');
		expect(fk.references.columns).toEqual(['id']);
		expect(fk.references.schema).toBeUndefined();
		expect(fk.deferred).toBeUndefined();
	});

	it('skips same-schema FK targets that are absent from tableNames', async () => {
		const columns = [
			{
				table_name: 'invoices',
				column_name: 'id',
				data_type: 'integer',
				udt_name: 'int4',
				is_nullable: 'NO',
				column_default: null,
			},
			{
				table_name: 'invoices',
				column_name: 'customer_id',
				data_type: 'integer',
				udt_name: 'int4',
				is_nullable: 'NO',
				column_default: null,
			},
		];
		const pks = [{ table_name: 'invoices', column_name: 'id' }];
		const fks = [
			{
				constraint_name: 'invoices_customer_id_fkey',
				source_table: 'invoices',
				source_column: 'customer_id',
				target_schema: 'billing',
				target_table: 'customers',
				target_column: 'id',
				delete_rule: 'NO ACTION',
				update_rule: 'NO ACTION',
				is_deferrable: 'NO',
				initially_deferred: 'NO',
			},
		];

		const pool = createMockPool([columns, pks, fks]);
		const result = await introspect(pool, { schema: 'billing' });

		expect(result.tables.get('invoices')!.foreignKeys).toHaveLength(0);
	});
});
