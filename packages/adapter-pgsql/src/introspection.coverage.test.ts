// @ts-nocheck — coverage test: runtime assertions on AST nodes
/**
 * Coverage tests for introspection.ts
 *
 * Mocks pg.Pool to return synthetic catalog data and exercises:
 * - Column type mapping (all PostgreSQL types → ColumnType)
 * - Table filtering (include/exclude glob patterns)
 * - FK grouping (composite FKs)
 * - Index grouping (unique/non-unique, existing/new table bucket)
 * - Hierarchy detection (adjacency + edge-table)
 * - Relation inference (belongsTo / hasMany, filtered/unfiltered)
 * - deriveRelationName (suffixes: _id, Id, raw)
 * - mapDeleteRule (CASCADE, SET NULL, RESTRICT, NO ACTION)
 * - Warnings for tables without PK
 * - matchGlob (exact match, wildcard)
 * - Self-referential FK as adjacency hierarchy
 * - Edge-table hierarchy detection
 * - Composite PK → nodeIdColumn fallback
 */

import { describe, expect, it, vi } from 'vitest';
import { introspect } from './introspection.js';

// ---------------------------------------------------------------------------
// Mock Pool
// ---------------------------------------------------------------------------

type QueryResult<T> = { rows: T[] };

function createMockPool(
	columns: QueryResult<any>,
	pks: QueryResult<any>,
	fks: QueryResult<any>,
	indexes: QueryResult<any>,
	enums: QueryResult<any> = { rows: [] },
	comments: QueryResult<any> = { rows: [] },
	checks: QueryResult<any> = { rows: [] },
	extensions: QueryResult<any> = { rows: [] },
	sequences: QueryResult<any> = { rows: [] },
	partitions: QueryResult<any> = { rows: [] },
	rlsState: QueryResult<any> = { rows: [] },
	policies: QueryResult<any> = { rows: [] },
) {
	return {
		query: vi
			.fn()
			.mockResolvedValueOnce(columns) // columns
			.mockResolvedValueOnce(pks) // PKs
			.mockResolvedValueOnce(fks) // FKs
			.mockResolvedValueOnce(indexes) // indexes
			.mockResolvedValueOnce(enums) // ENUM types
			.mockResolvedValueOnce(comments) // comments (pg_description)
			.mockResolvedValueOnce(checks) // CHECK constraints
			.mockResolvedValueOnce(partitions) // partition configs (pg_partitioned_table)
			.mockResolvedValueOnce(extensions) // extensions (pg_extension)
			.mockResolvedValueOnce(sequences) // sequences (pg_sequences)
			.mockResolvedValueOnce(rlsState) // RLS enabled state per table
			.mockResolvedValueOnce(policies), // RLS policies
	} as any;
}

// ---------------------------------------------------------------------------
// Column type mapping
// ---------------------------------------------------------------------------
describe('introspection — column type mapping', () => {
	it('maps uuid UDT type', async () => {
		const pool = createMockPool(
			{
				rows: [
					{
						table_name: 't',
						column_name: 'c',
						data_type: 'USER-DEFINED',
						udt_name: 'uuid',
						is_nullable: 'NO',
						column_default: null,
					},
				],
			},
			{ rows: [{ table_name: 't', column_name: 'c' }] },
			{ rows: [] },
			{ rows: [] },
		);
		const model = await introspect(pool);
		expect(model.getTable('t')?.columns[0]?.type).toBe('uuid');
	});

	it('maps jsonb UDT type', async () => {
		const pool = createMockPool(
			{
				rows: [
					{
						table_name: 't',
						column_name: 'c',
						data_type: 'USER-DEFINED',
						udt_name: 'jsonb',
						is_nullable: 'NO',
						column_default: null,
					},
				],
			},
			{ rows: [{ table_name: 't', column_name: 'c' }] },
			{ rows: [] },
			{ rows: [] },
		);
		const model = await introspect(pool);
		expect(model.getTable('t')?.columns[0]?.type).toBe('jsonb');
	});

	it('maps json UDT type', async () => {
		const pool = createMockPool(
			{
				rows: [
					{
						table_name: 't',
						column_name: 'c',
						data_type: 'USER-DEFINED',
						udt_name: 'json',
						is_nullable: 'NO',
						column_default: null,
					},
				],
			},
			{ rows: [{ table_name: 't', column_name: 'c' }] },
			{ rows: [] },
			{ rows: [] },
		);
		const model = await introspect(pool);
		expect(model.getTable('t')?.columns[0]?.type).toBe('json');
	});

	it('maps int4range UDT type', async () => {
		const pool = createMockPool(
			{
				rows: [
					{
						table_name: 't',
						column_name: 'c',
						data_type: 'USER-DEFINED',
						udt_name: 'int4range',
						is_nullable: 'NO',
						column_default: null,
					},
				],
			},
			{ rows: [{ table_name: 't', column_name: 'c' }] },
			{ rows: [] },
			{ rows: [] },
		);
		const model = await introspect(pool);
		expect(model.getTable('t')?.columns[0]?.type).toBe('int4range');
	});

	it('maps int8range UDT type', async () => {
		const pool = createMockPool(
			{
				rows: [
					{
						table_name: 't',
						column_name: 'c',
						data_type: 'USER-DEFINED',
						udt_name: 'int8range',
						is_nullable: 'NO',
						column_default: null,
					},
				],
			},
			{ rows: [{ table_name: 't', column_name: 'c' }] },
			{ rows: [] },
			{ rows: [] },
		);
		const model = await introspect(pool);
		expect(model.getTable('t')?.columns[0]?.type).toBe('int8range');
	});

	it('maps numrange UDT type', async () => {
		const pool = createMockPool(
			{
				rows: [
					{
						table_name: 't',
						column_name: 'c',
						data_type: 'USER-DEFINED',
						udt_name: 'numrange',
						is_nullable: 'NO',
						column_default: null,
					},
				],
			},
			{ rows: [{ table_name: 't', column_name: 'c' }] },
			{ rows: [] },
			{ rows: [] },
		);
		const model = await introspect(pool);
		expect(model.getTable('t')?.columns[0]?.type).toBe('numrange');
	});

	it('maps daterange UDT type', async () => {
		const pool = createMockPool(
			{
				rows: [
					{
						table_name: 't',
						column_name: 'c',
						data_type: 'USER-DEFINED',
						udt_name: 'daterange',
						is_nullable: 'NO',
						column_default: null,
					},
				],
			},
			{ rows: [{ table_name: 't', column_name: 'c' }] },
			{ rows: [] },
			{ rows: [] },
		);
		const model = await introspect(pool);
		expect(model.getTable('t')?.columns[0]?.type).toBe('daterange');
	});

	it('maps tsrange UDT type', async () => {
		const pool = createMockPool(
			{
				rows: [
					{
						table_name: 't',
						column_name: 'c',
						data_type: 'USER-DEFINED',
						udt_name: 'tsrange',
						is_nullable: 'NO',
						column_default: null,
					},
				],
			},
			{ rows: [{ table_name: 't', column_name: 'c' }] },
			{ rows: [] },
			{ rows: [] },
		);
		const model = await introspect(pool);
		expect(model.getTable('t')?.columns[0]?.type).toBe('tsrange');
	});

	it('maps tstzrange UDT type', async () => {
		const pool = createMockPool(
			{
				rows: [
					{
						table_name: 't',
						column_name: 'c',
						data_type: 'USER-DEFINED',
						udt_name: 'tstzrange',
						is_nullable: 'NO',
						column_default: null,
					},
				],
			},
			{ rows: [{ table_name: 't', column_name: 'c' }] },
			{ rows: [] },
			{ rows: [] },
		);
		const model = await introspect(pool);
		expect(model.getTable('t')?.columns[0]?.type).toBe('tstzrange');
	});

	it('maps integer data_type', async () => {
		const pool = createMockPool(
			{
				rows: [
					{
						table_name: 't',
						column_name: 'c',
						data_type: 'integer',
						udt_name: 'int4',
						is_nullable: 'NO',
						column_default: null,
					},
				],
			},
			{ rows: [{ table_name: 't', column_name: 'c' }] },
			{ rows: [] },
			{ rows: [] },
		);
		const model = await introspect(pool);
		expect(model.getTable('t')?.columns[0]?.type).toBe('integer');
	});

	it('maps smallint data_type to integer', async () => {
		const pool = createMockPool(
			{
				rows: [
					{
						table_name: 't',
						column_name: 'c',
						data_type: 'smallint',
						udt_name: 'int2',
						is_nullable: 'NO',
						column_default: null,
					},
				],
			},
			{ rows: [{ table_name: 't', column_name: 'c' }] },
			{ rows: [] },
			{ rows: [] },
		);
		const model = await introspect(pool);
		expect(model.getTable('t')?.columns[0]?.type).toBe('integer');
	});

	it('maps bigint data_type', async () => {
		const pool = createMockPool(
			{
				rows: [
					{
						table_name: 't',
						column_name: 'c',
						data_type: 'bigint',
						udt_name: 'int8',
						is_nullable: 'NO',
						column_default: null,
					},
				],
			},
			{ rows: [{ table_name: 't', column_name: 'c' }] },
			{ rows: [] },
			{ rows: [] },
		);
		const model = await introspect(pool);
		expect(model.getTable('t')?.columns[0]?.type).toBe('bigint');
	});

	it('maps numeric/decimal data_type', async () => {
		const pool = createMockPool(
			{
				rows: [
					{
						table_name: 't',
						column_name: 'a',
						data_type: 'numeric',
						udt_name: 'numeric',
						is_nullable: 'NO',
						column_default: null,
					},
					{
						table_name: 't',
						column_name: 'b',
						data_type: 'decimal',
						udt_name: 'numeric',
						is_nullable: 'NO',
						column_default: null,
					},
					{
						table_name: 't',
						column_name: 'c',
						data_type: 'real',
						udt_name: 'float4',
						is_nullable: 'NO',
						column_default: null,
					},
					{
						table_name: 't',
						column_name: 'd',
						data_type: 'double precision',
						udt_name: 'float8',
						is_nullable: 'NO',
						column_default: null,
					},
				],
			},
			{ rows: [{ table_name: 't', column_name: 'a' }] },
			{ rows: [] },
			{ rows: [] },
		);
		const model = await introspect(pool);
		const table = model.getTable('t');
		expect(table?.columns.find((c) => c.name === 'a')?.type).toBe('decimal');
		expect(table?.columns.find((c) => c.name === 'b')?.type).toBe('decimal');
		expect(table?.columns.find((c) => c.name === 'c')?.type).toBe('decimal');
		expect(table?.columns.find((c) => c.name === 'd')?.type).toBe('decimal');
	});

	it('maps boolean data_type', async () => {
		const pool = createMockPool(
			{
				rows: [
					{
						table_name: 't',
						column_name: 'c',
						data_type: 'boolean',
						udt_name: 'bool',
						is_nullable: 'NO',
						column_default: null,
					},
				],
			},
			{ rows: [{ table_name: 't', column_name: 'c' }] },
			{ rows: [] },
			{ rows: [] },
		);
		const model = await introspect(pool);
		expect(model.getTable('t')?.columns[0]?.type).toBe('boolean');
	});

	it('maps character varying / varchar / char data_types to string', async () => {
		const pool = createMockPool(
			{
				rows: [
					{
						table_name: 't',
						column_name: 'a',
						data_type: 'character varying',
						udt_name: 'varchar',
						is_nullable: 'NO',
						column_default: null,
					},
					{
						table_name: 't',
						column_name: 'b',
						data_type: 'character',
						udt_name: 'bpchar',
						is_nullable: 'NO',
						column_default: null,
					},
					{
						table_name: 't',
						column_name: 'c',
						data_type: 'varchar',
						udt_name: 'varchar',
						is_nullable: 'NO',
						column_default: null,
					},
					{
						table_name: 't',
						column_name: 'd',
						data_type: 'char',
						udt_name: 'bpchar',
						is_nullable: 'NO',
						column_default: null,
					},
				],
			},
			{ rows: [{ table_name: 't', column_name: 'a' }] },
			{ rows: [] },
			{ rows: [] },
		);
		const model = await introspect(pool);
		const table = model.getTable('t');
		for (const col of table!.columns) {
			expect(col.type).toBe('string');
		}
	});

	it('maps text data_type', async () => {
		const pool = createMockPool(
			{
				rows: [
					{
						table_name: 't',
						column_name: 'c',
						data_type: 'text',
						udt_name: 'text',
						is_nullable: 'NO',
						column_default: null,
					},
				],
			},
			{ rows: [{ table_name: 't', column_name: 'c' }] },
			{ rows: [] },
			{ rows: [] },
		);
		const model = await introspect(pool);
		expect(model.getTable('t')?.columns[0]?.type).toBe('text');
	});

	it('maps date data_type', async () => {
		const pool = createMockPool(
			{
				rows: [
					{
						table_name: 't',
						column_name: 'c',
						data_type: 'date',
						udt_name: 'date',
						is_nullable: 'NO',
						column_default: null,
					},
				],
			},
			{ rows: [{ table_name: 't', column_name: 'c' }] },
			{ rows: [] },
			{ rows: [] },
		);
		const model = await introspect(pool);
		expect(model.getTable('t')?.columns[0]?.type).toBe('date');
	});

	it('maps time types', async () => {
		const pool = createMockPool(
			{
				rows: [
					{
						table_name: 't',
						column_name: 'a',
						data_type: 'time without time zone',
						udt_name: 'time',
						is_nullable: 'NO',
						column_default: null,
					},
					{
						table_name: 't',
						column_name: 'b',
						data_type: 'time with time zone',
						udt_name: 'timetz',
						is_nullable: 'NO',
						column_default: null,
					},
				],
			},
			{ rows: [{ table_name: 't', column_name: 'a' }] },
			{ rows: [] },
			{ rows: [] },
		);
		const model = await introspect(pool);
		const table = model.getTable('t');
		expect(table?.columns.find((c) => c.name === 'a')?.type).toBe('time');
		expect(table?.columns.find((c) => c.name === 'b')?.type).toBe('time');
	});

	it('maps timestamp without time zone', async () => {
		const pool = createMockPool(
			{
				rows: [
					{
						table_name: 't',
						column_name: 'c',
						data_type: 'timestamp without time zone',
						udt_name: 'timestamp',
						is_nullable: 'NO',
						column_default: null,
					},
				],
			},
			{ rows: [{ table_name: 't', column_name: 'c' }] },
			{ rows: [] },
			{ rows: [] },
		);
		const model = await introspect(pool);
		expect(model.getTable('t')?.columns[0]?.type).toBe('timestamp');
	});

	it('maps timestamp with time zone to datetime', async () => {
		const pool = createMockPool(
			{
				rows: [
					{
						table_name: 't',
						column_name: 'c',
						data_type: 'timestamp with time zone',
						udt_name: 'timestamptz',
						is_nullable: 'NO',
						column_default: null,
					},
				],
			},
			{ rows: [{ table_name: 't', column_name: 'c' }] },
			{ rows: [] },
			{ rows: [] },
		);
		const model = await introspect(pool);
		expect(model.getTable('t')?.columns[0]?.type).toBe('datetime');
	});

	it('maps json data_type fallback', async () => {
		const pool = createMockPool(
			{
				rows: [
					{
						table_name: 't',
						column_name: 'c',
						data_type: 'json',
						udt_name: 'other',
						is_nullable: 'NO',
						column_default: null,
					},
				],
			},
			{ rows: [{ table_name: 't', column_name: 'c' }] },
			{ rows: [] },
			{ rows: [] },
		);
		const model = await introspect(pool);
		expect(model.getTable('t')?.columns[0]?.type).toBe('json');
	});

	it('maps jsonb data_type fallback', async () => {
		const pool = createMockPool(
			{
				rows: [
					{
						table_name: 't',
						column_name: 'c',
						data_type: 'jsonb',
						udt_name: 'other',
						is_nullable: 'NO',
						column_default: null,
					},
				],
			},
			{ rows: [{ table_name: 't', column_name: 'c' }] },
			{ rows: [] },
			{ rows: [] },
		);
		const model = await introspect(pool);
		expect(model.getTable('t')?.columns[0]?.type).toBe('jsonb');
	});

	it('maps uuid data_type fallback', async () => {
		const pool = createMockPool(
			{
				rows: [
					{
						table_name: 't',
						column_name: 'c',
						data_type: 'uuid',
						udt_name: 'other',
						is_nullable: 'NO',
						column_default: null,
					},
				],
			},
			{ rows: [{ table_name: 't', column_name: 'c' }] },
			{ rows: [] },
			{ rows: [] },
		);
		const model = await introspect(pool);
		expect(model.getTable('t')?.columns[0]?.type).toBe('uuid');
	});

	it('maps unknown data_type to string fallback', async () => {
		const pool = createMockPool(
			{
				rows: [
					{
						table_name: 't',
						column_name: 'c',
						data_type: 'citext',
						udt_name: 'citext',
						is_nullable: 'NO',
						column_default: null,
					},
				],
			},
			{ rows: [{ table_name: 't', column_name: 'c' }] },
			{ rows: [] },
			{ rows: [] },
		);
		const model = await introspect(pool);
		expect(model.getTable('t')?.columns[0]?.type).toBe('string');
	});
});

// ---------------------------------------------------------------------------
// Nullable and column_default
// ---------------------------------------------------------------------------
describe('introspection — nullable and defaults', () => {
	it('marks nullable column as nullable: true', async () => {
		const pool = createMockPool(
			{
				rows: [
					{
						table_name: 't',
						column_name: 'c',
						data_type: 'text',
						udt_name: 'text',
						is_nullable: 'YES',
						column_default: null,
					},
				],
			},
			{ rows: [{ table_name: 't', column_name: 'c' }] },
			{ rows: [] },
			{ rows: [] },
		);
		const model = await introspect(pool);
		expect(model.getTable('t')?.columns[0]?.nullable).toBe(true);
	});

	it('marks non-nullable column as nullable: false', async () => {
		const pool = createMockPool(
			{
				rows: [
					{
						table_name: 't',
						column_name: 'c',
						data_type: 'text',
						udt_name: 'text',
						is_nullable: 'NO',
						column_default: null,
					},
				],
			},
			{ rows: [{ table_name: 't', column_name: 'c' }] },
			{ rows: [] },
			{ rows: [] },
		);
		const model = await introspect(pool);
		expect(model.getTable('t')?.columns[0]?.nullable).toBe(false);
	});

	it('includes column_default when present', async () => {
		const pool = createMockPool(
			{
				rows: [
					{
						table_name: 't',
						column_name: 'c',
						data_type: 'text',
						udt_name: 'text',
						is_nullable: 'NO',
						column_default: "'active'",
					},
				],
			},
			{ rows: [{ table_name: 't', column_name: 'c' }] },
			{ rows: [] },
			{ rows: [] },
		);
		const model = await introspect(pool);
		// C5 fix: introspected defaults stored as { sql } for verbatim DDL emission
		expect(model.getTable('t')?.columns[0]?.default).toStrictEqual({
			sql: "'active'",
		});
	});

	it('omits default when column_default is null', async () => {
		const pool = createMockPool(
			{
				rows: [
					{
						table_name: 't',
						column_name: 'c',
						data_type: 'text',
						udt_name: 'text',
						is_nullable: 'NO',
						column_default: null,
					},
				],
			},
			{ rows: [{ table_name: 't', column_name: 'c' }] },
			{ rows: [] },
			{ rows: [] },
		);
		const model = await introspect(pool);
		expect(model.getTable('t')?.columns[0]?.default).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Table filtering (include/exclude)
// ---------------------------------------------------------------------------
describe('introspection — table filtering', () => {
	const mkColumns = (tables: string[]) => ({
		rows: tables.map((t) => ({
			table_name: t,
			column_name: 'id',
			data_type: 'integer',
			udt_name: 'int4',
			is_nullable: 'NO',
			column_default: null,
		})),
	});
	const mkPks = (tables: string[]) => ({
		rows: tables.map((t) => ({ table_name: t, column_name: 'id' })),
	});

	it('include filters tables by exact match', async () => {
		const pool = createMockPool(
			mkColumns(['users', 'posts', 'comments']),
			mkPks(['users', 'posts', 'comments']),
			{ rows: [] },
			{ rows: [] },
		);
		const model = await introspect(pool, { include: ['users'] });
		expect(model.getTable('users')).toBeDefined();
		expect(model.getTable('posts')).toBeUndefined();
	});

	it('include filters tables by glob', async () => {
		const pool = createMockPool(
			mkColumns(['user_accounts', 'user_profiles', 'posts']),
			mkPks(['user_accounts', 'user_profiles', 'posts']),
			{ rows: [] },
			{ rows: [] },
		);
		const model = await introspect(pool, { include: ['user_*'] });
		expect(model.getTable('user_accounts')).toBeDefined();
		expect(model.getTable('user_profiles')).toBeDefined();
		expect(model.getTable('posts')).toBeUndefined();
	});

	it('exclude filters tables by exact match', async () => {
		const pool = createMockPool(
			mkColumns(['users', 'migrations']),
			mkPks(['users', 'migrations']),
			{ rows: [] },
			{ rows: [] },
		);
		const model = await introspect(pool, { exclude: ['migrations'] });
		expect(model.getTable('users')).toBeDefined();
		expect(model.getTable('migrations')).toBeUndefined();
	});

	it('exclude filters tables by glob', async () => {
		const pool = createMockPool(
			mkColumns(['users', 'schema_migrations', 'schema_versions']),
			mkPks(['users', 'schema_migrations', 'schema_versions']),
			{ rows: [] },
			{ rows: [] },
		);
		const model = await introspect(pool, { exclude: ['schema_*'] });
		expect(model.getTable('users')).toBeDefined();
		expect(model.getTable('schema_migrations')).toBeUndefined();
	});

	it('include + exclude: include applied first, then exclude', async () => {
		const pool = createMockPool(
			mkColumns(['user_data', 'user_temp', 'other']),
			mkPks(['user_data', 'user_temp', 'other']),
			{ rows: [] },
			{ rows: [] },
		);
		const model = await introspect(pool, {
			include: ['user_*'],
			exclude: ['*_temp'],
		});
		expect(model.getTable('user_data')).toBeDefined();
		expect(model.getTable('user_temp')).toBeUndefined();
		expect(model.getTable('other')).toBeUndefined();
	});

	it('empty include array does not filter', async () => {
		const pool = createMockPool(
			mkColumns(['a', 'b']),
			mkPks(['a', 'b']),
			{ rows: [] },
			{ rows: [] },
		);
		const model = await introspect(pool, { include: [] });
		expect(model.getTable('a')).toBeDefined();
		expect(model.getTable('b')).toBeDefined();
	});

	it('empty exclude array does not filter', async () => {
		const pool = createMockPool(
			mkColumns(['a', 'b']),
			mkPks(['a', 'b']),
			{ rows: [] },
			{ rows: [] },
		);
		const model = await introspect(pool, { exclude: [] });
		expect(model.getTable('a')).toBeDefined();
		expect(model.getTable('b')).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// FK handling and mapDeleteRule
// ---------------------------------------------------------------------------
describe('introspection — FK handling and delete rules', () => {
	it('maps CASCADE delete rule', async () => {
		const pool = createMockPool(
			{
				rows: [
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
						column_name: 'author_id',
						data_type: 'integer',
						udt_name: 'int4',
						is_nullable: 'NO',
						column_default: null,
					},
				],
			},
			{
				rows: [
					{ table_name: 'users', column_name: 'id' },
					{ table_name: 'posts', column_name: 'id' },
				],
			},
			{
				rows: [
					{
						constraint_name: 'fk1',
						source_table: 'posts',
						source_column: 'author_id',
						target_table: 'users',
						target_column: 'id',
						delete_rule: 'CASCADE',
					},
				],
			},
			{ rows: [] },
		);
		const model = await introspect(pool);
		const table = model.getTable('posts');
		expect(table?.foreignKeys[0]?.onDelete).toBe('CASCADE');
	});

	it('maps SET NULL delete rule', async () => {
		const pool = createMockPool(
			{
				rows: [
					{
						table_name: 'a',
						column_name: 'id',
						data_type: 'integer',
						udt_name: 'int4',
						is_nullable: 'NO',
						column_default: null,
					},
					{
						table_name: 'b',
						column_name: 'id',
						data_type: 'integer',
						udt_name: 'int4',
						is_nullable: 'NO',
						column_default: null,
					},
					{
						table_name: 'b',
						column_name: 'a_id',
						data_type: 'integer',
						udt_name: 'int4',
						is_nullable: 'YES',
						column_default: null,
					},
				],
			},
			{
				rows: [
					{ table_name: 'a', column_name: 'id' },
					{ table_name: 'b', column_name: 'id' },
				],
			},
			{
				rows: [
					{
						constraint_name: 'fk1',
						source_table: 'b',
						source_column: 'a_id',
						target_table: 'a',
						target_column: 'id',
						delete_rule: 'SET NULL',
					},
				],
			},
			{ rows: [] },
		);
		const model = await introspect(pool);
		expect(model.getTable('b')?.foreignKeys[0]?.onDelete).toBe('SET NULL');
	});

	it('maps RESTRICT delete rule', async () => {
		const pool = createMockPool(
			{
				rows: [
					{
						table_name: 'a',
						column_name: 'id',
						data_type: 'integer',
						udt_name: 'int4',
						is_nullable: 'NO',
						column_default: null,
					},
					{
						table_name: 'b',
						column_name: 'id',
						data_type: 'integer',
						udt_name: 'int4',
						is_nullable: 'NO',
						column_default: null,
					},
					{
						table_name: 'b',
						column_name: 'a_id',
						data_type: 'integer',
						udt_name: 'int4',
						is_nullable: 'NO',
						column_default: null,
					},
				],
			},
			{
				rows: [
					{ table_name: 'a', column_name: 'id' },
					{ table_name: 'b', column_name: 'id' },
				],
			},
			{
				rows: [
					{
						constraint_name: 'fk1',
						source_table: 'b',
						source_column: 'a_id',
						target_table: 'a',
						target_column: 'id',
						delete_rule: 'RESTRICT',
					},
				],
			},
			{ rows: [] },
		);
		const model = await introspect(pool);
		expect(model.getTable('b')?.foreignKeys[0]?.onDelete).toBe('RESTRICT');
	});

	it('maps unknown delete rule to NO ACTION', async () => {
		const pool = createMockPool(
			{
				rows: [
					{
						table_name: 'a',
						column_name: 'id',
						data_type: 'integer',
						udt_name: 'int4',
						is_nullable: 'NO',
						column_default: null,
					},
					{
						table_name: 'b',
						column_name: 'id',
						data_type: 'integer',
						udt_name: 'int4',
						is_nullable: 'NO',
						column_default: null,
					},
					{
						table_name: 'b',
						column_name: 'a_id',
						data_type: 'integer',
						udt_name: 'int4',
						is_nullable: 'NO',
						column_default: null,
					},
				],
			},
			{
				rows: [
					{ table_name: 'a', column_name: 'id' },
					{ table_name: 'b', column_name: 'id' },
				],
			},
			{
				rows: [
					{
						constraint_name: 'fk1',
						source_table: 'b',
						source_column: 'a_id',
						target_table: 'a',
						target_column: 'id',
						delete_rule: 'NO ACTION',
					},
				],
			},
			{ rows: [] },
		);
		const model = await introspect(pool);
		// NO ACTION is the default — omitted from ForeignKeyIR when it's the default
		expect(model.getTable('b')?.foreignKeys[0]?.onDelete).toBeUndefined();
	});

	it('handles composite FK (multi-column)', async () => {
		const pool = createMockPool(
			{
				rows: [
					{
						table_name: 'parent',
						column_name: 'a',
						data_type: 'integer',
						udt_name: 'int4',
						is_nullable: 'NO',
						column_default: null,
					},
					{
						table_name: 'parent',
						column_name: 'b',
						data_type: 'integer',
						udt_name: 'int4',
						is_nullable: 'NO',
						column_default: null,
					},
					{
						table_name: 'child',
						column_name: 'id',
						data_type: 'integer',
						udt_name: 'int4',
						is_nullable: 'NO',
						column_default: null,
					},
					{
						table_name: 'child',
						column_name: 'pa',
						data_type: 'integer',
						udt_name: 'int4',
						is_nullable: 'NO',
						column_default: null,
					},
					{
						table_name: 'child',
						column_name: 'pb',
						data_type: 'integer',
						udt_name: 'int4',
						is_nullable: 'NO',
						column_default: null,
					},
				],
			},
			{
				rows: [
					{ table_name: 'parent', column_name: 'a' },
					{ table_name: 'parent', column_name: 'b' },
					{ table_name: 'child', column_name: 'id' },
				],
			},
			{
				rows: [
					{
						constraint_name: 'fk_comp',
						source_table: 'child',
						source_column: 'pa',
						target_table: 'parent',
						target_column: 'a',
						delete_rule: 'CASCADE',
					},
					{
						constraint_name: 'fk_comp',
						source_table: 'child',
						source_column: 'pb',
						target_table: 'parent',
						target_column: 'b',
						delete_rule: 'CASCADE',
					},
				],
			},
			{ rows: [] },
		);
		const model = await introspect(pool);
		const fk = model.getTable('child')?.foreignKeys[0];
		expect(fk?.columns).toEqual(['pa', 'pb']);
		expect(fk?.references.columns).toEqual(['a', 'b']);
	});

	it('excludes FK to filtered-out target table', async () => {
		const pool = createMockPool(
			{
				rows: [
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
						column_name: 'user_id',
						data_type: 'integer',
						udt_name: 'int4',
						is_nullable: 'NO',
						column_default: null,
					},
				],
			},
			{
				rows: [
					{ table_name: 'users', column_name: 'id' },
					{ table_name: 'posts', column_name: 'id' },
				],
			},
			{
				rows: [
					{
						constraint_name: 'fk1',
						source_table: 'posts',
						source_column: 'user_id',
						target_table: 'users',
						target_column: 'id',
						delete_rule: 'CASCADE',
					},
				],
			},
			{ rows: [] },
		);
		// Exclude the target table (users) — FK should not appear on posts
		const model = await introspect(pool, { exclude: ['users'] });
		expect(model.getTable('posts')?.foreignKeys).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Index grouping
// ---------------------------------------------------------------------------
describe('introspection — indexes', () => {
	it('groups unique and non-unique indexes by table', async () => {
		const pool = createMockPool(
			{
				rows: [
					{
						table_name: 't',
						column_name: 'id',
						data_type: 'integer',
						udt_name: 'int4',
						is_nullable: 'NO',
						column_default: null,
					},
				],
			},
			{ rows: [{ table_name: 't', column_name: 'id' }] },
			{ rows: [] },
			{
				rows: [
					{
						index_name: 'idx_a',
						table_name: 't',
						columns: ['id'],
						is_unique: true,
					},
					{
						index_name: 'idx_b',
						table_name: 't',
						columns: ['id'],
						is_unique: false,
					},
				],
			},
		);
		const model = await introspect(pool);
		const table = model.getTable('t');
		expect(table?.indexes).toHaveLength(2);
		expect(table?.indexes[0]?.unique).toBe(true);
		expect(table?.indexes[1]?.unique).toBeUndefined();
	});

	it('adds indexes to the right table when multiple tables exist', async () => {
		const pool = createMockPool(
			{
				rows: [
					{
						table_name: 'a',
						column_name: 'id',
						data_type: 'integer',
						udt_name: 'int4',
						is_nullable: 'NO',
						column_default: null,
					},
					{
						table_name: 'b',
						column_name: 'id',
						data_type: 'integer',
						udt_name: 'int4',
						is_nullable: 'NO',
						column_default: null,
					},
				],
			},
			{
				rows: [
					{ table_name: 'a', column_name: 'id' },
					{ table_name: 'b', column_name: 'id' },
				],
			},
			{ rows: [] },
			{
				rows: [
					{
						index_name: 'idx_a1',
						table_name: 'a',
						columns: ['id'],
						is_unique: false,
					},
					{
						index_name: 'idx_b1',
						table_name: 'b',
						columns: ['id'],
						is_unique: true,
					},
				],
			},
		);
		const model = await introspect(pool);
		expect(model.getTable('a')?.indexes).toHaveLength(1);
		expect(model.getTable('b')?.indexes).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Warnings and PK handling
// ---------------------------------------------------------------------------
describe('introspection — warnings and PK', () => {
	it('warns when table has no primary key', async () => {
		const pool = createMockPool(
			{
				rows: [
					{
						table_name: 't',
						column_name: 'c',
						data_type: 'text',
						udt_name: 'text',
						is_nullable: 'NO',
						column_default: null,
					},
				],
			},
			{ rows: [] }, // No PKs
			{ rows: [] },
			{ rows: [] },
		);
		const model = await introspect(pool);
		expect(model.warnings).toContainEqual('Table "t" has no primary key');
	});

	it('handles composite primary key (multiple columns)', async () => {
		const pool = createMockPool(
			{
				rows: [
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
						data_type: 'integer',
						udt_name: 'int4',
						is_nullable: 'NO',
						column_default: null,
					},
				],
			},
			{
				rows: [
					{ table_name: 't', column_name: 'a' },
					{ table_name: 't', column_name: 'b' },
				],
			},
			{ rows: [] },
			{ rows: [] },
		);
		const model = await introspect(pool);
		const table = model.getTable('t');
		expect(table?.primaryKey).toEqual(['a', 'b']);
	});

	it('handles single primary key', async () => {
		const pool = createMockPool(
			{
				rows: [
					{
						table_name: 't',
						column_name: 'id',
						data_type: 'integer',
						udt_name: 'int4',
						is_nullable: 'NO',
						column_default: null,
					},
				],
			},
			{ rows: [{ table_name: 't', column_name: 'id' }] },
			{ rows: [] },
			{ rows: [] },
		);
		const model = await introspect(pool);
		expect(model.getTable('t')?.primaryKey).toBe('id');
	});
});

// ---------------------------------------------------------------------------
// Relation inference: deriveRelationName
// ---------------------------------------------------------------------------
describe('introspection — relation inference', () => {
	it('derives relation name from _id suffix (author_id → author)', async () => {
		const pool = createMockPool(
			{
				rows: [
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
						column_name: 'author_id',
						data_type: 'integer',
						udt_name: 'int4',
						is_nullable: 'NO',
						column_default: null,
					},
				],
			},
			{
				rows: [
					{ table_name: 'users', column_name: 'id' },
					{ table_name: 'posts', column_name: 'id' },
				],
			},
			{
				rows: [
					{
						constraint_name: 'fk1',
						source_table: 'posts',
						source_column: 'author_id',
						target_table: 'users',
						target_column: 'id',
						delete_rule: 'NO ACTION',
					},
				],
			},
			{ rows: [] },
		);
		const model = await introspect(pool);
		const relations = model.getRelationsFrom('posts');
		expect(
			relations.some((r) => r.name === 'author' && r.type === 'belongsTo'),
		).toBe(true);
	});

	it('derives relation name from Id suffix (authorId → author)', async () => {
		const pool = createMockPool(
			{
				rows: [
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
						column_name: 'authorId',
						data_type: 'integer',
						udt_name: 'int4',
						is_nullable: 'NO',
						column_default: null,
					},
				],
			},
			{
				rows: [
					{ table_name: 'users', column_name: 'id' },
					{ table_name: 'posts', column_name: 'id' },
				],
			},
			{
				rows: [
					{
						constraint_name: 'fk1',
						source_table: 'posts',
						source_column: 'authorId',
						target_table: 'users',
						target_column: 'id',
						delete_rule: 'NO ACTION',
					},
				],
			},
			{ rows: [] },
		);
		const model = await introspect(pool);
		const relations = model.getRelationsFrom('posts');
		expect(
			relations.some((r) => r.name === 'author' && r.type === 'belongsTo'),
		).toBe(true);
	});

	it('uses raw FK column name when no _id or Id suffix', async () => {
		const pool = createMockPool(
			{
				rows: [
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
						column_name: 'owner',
						data_type: 'integer',
						udt_name: 'int4',
						is_nullable: 'NO',
						column_default: null,
					},
				],
			},
			{
				rows: [
					{ table_name: 'users', column_name: 'id' },
					{ table_name: 'posts', column_name: 'id' },
				],
			},
			{
				rows: [
					{
						constraint_name: 'fk1',
						source_table: 'posts',
						source_column: 'owner',
						target_table: 'users',
						target_column: 'id',
						delete_rule: 'NO ACTION',
					},
				],
			},
			{ rows: [] },
		);
		const model = await introspect(pool);
		const relations = model.getRelationsFrom('posts');
		expect(
			relations.some((r) => r.name === 'owner' && r.type === 'belongsTo'),
		).toBe(true);
	});

	it('creates hasMany relation from target → source', async () => {
		const pool = createMockPool(
			{
				rows: [
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
						column_name: 'user_id',
						data_type: 'integer',
						udt_name: 'int4',
						is_nullable: 'NO',
						column_default: null,
					},
				],
			},
			{
				rows: [
					{ table_name: 'users', column_name: 'id' },
					{ table_name: 'posts', column_name: 'id' },
				],
			},
			{
				rows: [
					{
						constraint_name: 'fk1',
						source_table: 'posts',
						source_column: 'user_id',
						target_table: 'users',
						target_column: 'id',
						delete_rule: 'NO ACTION',
					},
				],
			},
			{ rows: [] },
		);
		const model = await introspect(pool);
		const relations = model.getRelationsFrom('users');
		expect(
			relations.some((r) => r.name === 'posts' && r.type === 'hasMany'),
		).toBe(true);
	});

	it('skips relation inference for tables not in filtered set', async () => {
		const pool = createMockPool(
			{
				rows: [
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
						column_name: 'user_id',
						data_type: 'integer',
						udt_name: 'int4',
						is_nullable: 'NO',
						column_default: null,
					},
				],
			},
			{
				rows: [
					{ table_name: 'users', column_name: 'id' },
					{ table_name: 'posts', column_name: 'id' },
				],
			},
			{
				rows: [
					{
						constraint_name: 'fk1',
						source_table: 'posts',
						source_column: 'user_id',
						target_table: 'users',
						target_column: 'id',
						delete_rule: 'NO ACTION',
					},
				],
			},
			{ rows: [] },
		);
		const model = await introspect(pool, { include: ['posts'] });
		const relations = model.getRelationsFrom('posts');
		// users is filtered out, so no belongsTo relation
		expect(relations.some((r) => r.type === 'belongsTo')).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Hierarchy detection
// ---------------------------------------------------------------------------
describe('introspection — hierarchy detection', () => {
	it('detects adjacency hierarchy (self-referential FK)', async () => {
		const pool = createMockPool(
			{
				rows: [
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
						column_name: 'parent_id',
						data_type: 'integer',
						udt_name: 'int4',
						is_nullable: 'YES',
						column_default: null,
					},
				],
			},
			{ rows: [{ table_name: 'categories', column_name: 'id' }] },
			{
				rows: [
					{
						constraint_name: 'fk_self',
						source_table: 'categories',
						source_column: 'parent_id',
						target_table: 'categories',
						target_column: 'id',
						delete_rule: 'NO ACTION',
					},
				],
			},
			{ rows: [] },
		);
		const model = await introspect(pool);
		expect(model.hierarchies).toHaveLength(1);
		expect(model.hierarchies[0]?.type).toBe('adjacency');
		expect(model.hierarchies[0]?.nodeTable).toBe('categories');
		expect(model.hierarchies[0]?.parentColumn).toBe('parent_id');
		expect(model.hierarchies[0]?.nodeIdColumn).toBe('id');
	});

	it('detects edge-table hierarchy (2+ FKs to same target)', async () => {
		const pool = createMockPool(
			{
				rows: [
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
				],
			},
			{
				rows: [
					{ table_name: 'nodes', column_name: 'id' },
					{ table_name: 'edges', column_name: 'id' },
				],
			},
			{
				rows: [
					{
						constraint_name: 'fk_parent',
						source_table: 'edges',
						source_column: 'parent_id',
						target_table: 'nodes',
						target_column: 'id',
						delete_rule: 'CASCADE',
					},
					{
						constraint_name: 'fk_child',
						source_table: 'edges',
						source_column: 'child_id',
						target_table: 'nodes',
						target_column: 'id',
						delete_rule: 'CASCADE',
					},
				],
			},
			{ rows: [] },
		);
		const model = await introspect(pool);
		const edgeHierarchy = model.hierarchies.find(
			(h) => h.type === 'edge-table',
		);
		expect(edgeHierarchy).toBeDefined();
		expect(edgeHierarchy?.nodeTable).toBe('nodes');
		expect(edgeHierarchy?.edgeTable).toBe('edges');
	});

	it('uses composite PK first element as nodeIdColumn for edge-table', async () => {
		const pool = createMockPool(
			{
				rows: [
					{
						table_name: 'nodes',
						column_name: 'a',
						data_type: 'integer',
						udt_name: 'int4',
						is_nullable: 'NO',
						column_default: null,
					},
					{
						table_name: 'nodes',
						column_name: 'b',
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
						column_name: 'p',
						data_type: 'integer',
						udt_name: 'int4',
						is_nullable: 'NO',
						column_default: null,
					},
					{
						table_name: 'edges',
						column_name: 'c',
						data_type: 'integer',
						udt_name: 'int4',
						is_nullable: 'NO',
						column_default: null,
					},
				],
			},
			{
				rows: [
					{ table_name: 'nodes', column_name: 'a' },
					{ table_name: 'nodes', column_name: 'b' },
					{ table_name: 'edges', column_name: 'id' },
				],
			},
			{
				rows: [
					{
						constraint_name: 'fk_p',
						source_table: 'edges',
						source_column: 'p',
						target_table: 'nodes',
						target_column: 'a',
						delete_rule: 'CASCADE',
					},
					{
						constraint_name: 'fk_c',
						source_table: 'edges',
						source_column: 'c',
						target_table: 'nodes',
						target_column: 'a',
						delete_rule: 'CASCADE',
					},
				],
			},
			{ rows: [] },
		);
		const model = await introspect(pool);
		const edgeHierarchy = model.hierarchies.find(
			(h) => h.type === 'edge-table',
		);
		expect(edgeHierarchy?.nodeIdColumn).toBe('a');
	});

	it('uses DEFAULT_PK_COLUMN when adjacency table has no PK', async () => {
		const pool = createMockPool(
			{
				rows: [
					{
						table_name: 't',
						column_name: 'val',
						data_type: 'integer',
						udt_name: 'int4',
						is_nullable: 'NO',
						column_default: null,
					},
					{
						table_name: 't',
						column_name: 'parent',
						data_type: 'integer',
						udt_name: 'int4',
						is_nullable: 'YES',
						column_default: null,
					},
				],
			},
			{ rows: [] }, // no PK
			{
				rows: [
					{
						constraint_name: 'fk_self',
						source_table: 't',
						source_column: 'parent',
						target_table: 't',
						target_column: 'val',
						delete_rule: 'NO ACTION',
					},
				],
			},
			{ rows: [] },
		);
		const model = await introspect(pool);
		const adj = model.hierarchies.find((h) => h.type === 'adjacency');
		expect(adj?.nodeIdColumn).toBe('id'); // DEFAULT_PK_COLUMN
	});

	it('sets introspectedAt date and default schema', async () => {
		const pool = createMockPool(
			{ rows: [] },
			{ rows: [] },
			{ rows: [] },
			{ rows: [] },
		);
		const before = new Date();
		const model = await introspect(pool);
		const after = new Date();
		expect(model.introspectedAt.getTime()).toBeGreaterThanOrEqual(
			before.getTime(),
		);
		expect(model.introspectedAt.getTime()).toBeLessThanOrEqual(after.getTime());
		// Default schema = 'public' (passed to queries); 12 queries: columns, PKs, FKs, indexes, enums, comments, checks, partitions, extensions, sequences, rls state, policies
		expect(pool.query).toHaveBeenCalledTimes(12);
		expect(pool.query.mock.calls[0][1]).toEqual(['public']);
	});

	it('uses custom schema name', async () => {
		const pool = createMockPool(
			{ rows: [] },
			{ rows: [] },
			{ rows: [] },
			{ rows: [] },
		);
		await introspect(pool, { schema: 'my_schema' });
		expect(pool.query.mock.calls[0][1]).toEqual(['my_schema']);
	});
});

// ---------------------------------------------------------------------------
// INTRO-INDEXES regression: index SQL query must contain $1 and no JS comments
// ---------------------------------------------------------------------------
describe('introspection — query SQL integrity (INTRO-INDEXES)', () => {
	it('index query contains $1 parameter placeholder (not a bare keyword)', async () => {
		const pool = createMockPool(
			{ rows: [] },
			{ rows: [] },
			{ rows: [] },
			{ rows: [] },
		);
		await introspect(pool);
		// 4th query (index 3) is the index catalog query
		const indexQuerySql: string = pool.query.mock.calls[3][0];
		expect(indexQuerySql).toContain('$1');
	});

	it('index query does not contain embedded JS-style // comments (INTRO-INDEXES bug)', async () => {
		const pool = createMockPool(
			{ rows: [] },
			{ rows: [] },
			{ rows: [] },
			{ rows: [] },
		);
		await introspect(pool);
		// 4th query (index 3) is the index catalog query
		const indexQuerySql: string = pool.query.mock.calls[3][0];
		// JS // comments inside a template literal become literal text in the SQL string,
		// which PostgreSQL rejects with "syntax error at or near ..."
		expect(indexQuerySql).not.toContain('// ');
	});

	it('index query WHERE clause binds schema via $1 (not bare text)', async () => {
		const pool = createMockPool(
			{ rows: [] },
			{ rows: [] },
			{ rows: [] },
			{ rows: [] },
		);
		await introspect(pool);
		const indexQuerySql: string = pool.query.mock.calls[3][0];
		// Must have: WHERE n.nspname = $1
		expect(indexQuerySql).toMatch(/WHERE\s+n\.nspname\s*=\s*\$1/);
	});

	it('index query reads PG15 nulls-not-distinct metadata without a direct column reference', async () => {
		const pool = createMockPool(
			{ rows: [] },
			{ rows: [] },
			{ rows: [] },
			{ rows: [] },
		);
		await introspect(pool);
		const indexQuerySql: string = pool.query.mock.calls[3][0];

		expect(indexQuerySql).toContain("to_jsonb(ix) ->> 'indnullsnotdistinct'");
		expect(indexQuerySql).not.toContain('ix.indnullsnotdistinct');
	});
});
