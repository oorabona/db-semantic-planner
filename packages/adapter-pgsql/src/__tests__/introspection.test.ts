/**
 * Introspection Unit Tests (ADAPTER-006)
 *
 * Tests introspect() with mock pg.Pool returning controlled result sets.
 */

import type { Pool, QueryResult } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { type DetectedHierarchy, introspect } from '../introspection.js';

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
		// 10 queries total: columns, PKs, FKs, indexes, enums, comments, checks, partitions, extensions, sequences
		// Note: extensions query has no schema param (queries all extensions globally)
		expect(mockQuery).toHaveBeenCalledTimes(10);
		// All parameterized queries (those with a second arg) should pass 'tenant_1'
		for (const call of mockQuery.mock.calls) {
			if (call[1] !== undefined) {
				expect(call[1]).toEqual(['tenant_1']);
			}
		}
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
		expect(table.columns[0]!.default).toContain('nextval');
		expect(table.columns[1]!.default).toBe('true');
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
});
