/**
 * Unit tests for catalog helper methods on PgsqlAdapter:
 *   - listIndexes (with namePattern option)
 *   - indexExists
 *   - storageSize
 *
 * Uses a mock pg Pool to avoid requiring a live database.
 */

import { createOrm, schema } from '@dbsp/core';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
	createPgsqlAdapter,
	createPgsqlCompileOnlyAdapter,
} from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Mock pool factory
// ---------------------------------------------------------------------------

function makeMockPool(rows: Record<string, unknown>[] = []): Pool {
	return {
		query: vi.fn().mockResolvedValue({ rows }),
	} as unknown as Pool;
}

/** The single catalog query call. */
function catalogCall(pool: Pool): [string, unknown[]] {
	const spy = pool.query as ReturnType<typeof vi.fn>;
	return spy.mock.calls[0] as [string, unknown[]];
}

describe('#762 physical names through public ORM helpers', () => {
	it('resolves declared table, columns, and indexes while preserving undeclared catalog indexes', async () => {
		const helperSchema = schema(
			{
				userProfiles: {
					id: { type: 'integer', primaryKey: true },
					displayName: 'string',
				},
			},
			{
				userProfiles: {
					indexes: [
						{ name: 'userProfilesDisplayNameIdx', columns: ['displayName'] },
					],
				},
			},
		);
		const pool = {
			query: vi.fn(async (sql: string) => ({
				rows: sql.includes('SELECT EXISTS') ? [{ exists: true }] : [],
			})),
		} as unknown as Pool;
		const adapter = createPgsqlAdapter(pool, {
			dbCasing: 'snake_case',
			model: helperSchema.model,
		});
		const orm = createOrm({ schema: helperSchema, adapter });
		const helpers = orm.tables.userProfiles!;

		await helpers.truncate();
		await helpers.indexes.create({
			name: 'userProfilesDisplayNameIdx',
			columns: ['displayName'],
		});
		await helpers.indexes.list();
		await helpers.indexes.exists('userProfilesDisplayNameIdx');
		await helpers.indexes.exists('runtime_managed_idx');
		await helpers.indexes.drop('userProfilesDisplayNameIdx');
		await helpers.alterColumn('displayName', { setNotNull: true });
		await orm.ddl.dropIndex('userProfilesDisplayNameIdx');

		const calls = (pool.query as ReturnType<typeof vi.fn>).mock.calls;
		const sql = calls.map(([statement]) => String(statement)).join('\n');
		expect(sql).toContain('TRUNCATE "public"."user_profiles"');
		expect(sql).toContain('ON "public"."user_profiles" ("display_name")');
		expect(sql).toContain('ALTER COLUMN "display_name" SET NOT NULL');
		expect(sql).toContain(
			'DROP INDEX "public"."user_profiles_display_name_idx"',
		);
		expect(calls[2]![1]).toEqual(['user_profiles', 'public']);
		expect(calls[3]![1]).toEqual([
			'user_profiles_display_name_idx',
			'user_profiles',
			'public',
		]);
		expect(calls[4]![1]).toEqual([
			'runtime_managed_idx',
			'user_profiles',
			'public',
		]);
	});

	it('refuses a declared helper column absent from the physical inventory', () => {
		const model = schema({ userProfiles: { id: 'integer' } }).model;
		const adapter = createPgsqlCompileOnlyAdapter({
			dbCasing: 'snake_case',
			model,
		});
		expect(() =>
			adapter.generateAlterColumn('userProfiles', 'public', 'missingColumn', {
				setNotNull: true,
			}),
		).toThrow(
			'Declared column "userProfiles.missingColumn" is missing from the physical inventory',
		);
	});

	it('refuses a malformed logical model with the physical-model error', () => {
		const malformed = {
			tables: new Map([
				[
					'users',
					{ name: 'users', columns: [], primaryKey: { columns: ['id'] } },
				],
			]),
			relations: new Map(),
			getTable: () => undefined,
			getRelation: () => undefined,
		} as never;
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() =>
			adapter.compile({ rootTable: 'users', decisions: [] } as never, {
				model: malformed,
			}),
		).toThrow('primaryKey.map is not a function');
	});
});

// ===========================================================================
// listIndexes - namePattern filter
// ===========================================================================

describe('PgsqlAdapter.listIndexes()', () => {
	it('queries pg_indexes without LIKE clause when options omitted', async () => {
		const pool = makeMockPool([
			{
				indexname: 'idx_users_email',
				indexdef: 'CREATE INDEX idx_users_email ON users USING btree (email)',
			},
		]);
		const adapter = createPgsqlAdapter(pool);
		const result = await adapter.listIndexes('users');

		const [sql, params] = catalogCall(pool);
		expect(sql).not.toContain('LIKE');
		// No explicit/adapter schema → the schema is resolved search_path-aware in
		// the same query (COALESCE + to_regclass), so it is not passed as a param.
		expect(params).toEqual(['users', null]);
		expect(sql).toContain('to_regclass');
		expect(result).toHaveLength(1);
		expect(result[0]!.name).toBe('idx_users_email');
		expect(result[0]!.unique).toBe(false);
		expect(result[0]!.method).toBe('btree');
	});

	it('adds LIKE $3 clause when namePattern is provided', async () => {
		const pool = makeMockPool([]);
		const adapter = createPgsqlAdapter(pool);
		await adapter.listIndexes('users', 'myschema', { namePattern: 'idx_vec%' });

		const [sql, params] = catalogCall(pool);
		expect(sql).toContain('LIKE $3');
		expect(params).toEqual(['users', 'myschema', 'idx_vec%']);
	});

	it('uses adapter schemaName when schema arg is omitted', async () => {
		const pool = makeMockPool([]);
		const adapter = createPgsqlAdapter(pool, { schemaName: 'tenant_42' });
		await adapter.listIndexes('orders');

		const [, params] = catalogCall(pool);
		expect(params[1]).toBe('tenant_42');
	});

	it('detects UNIQUE indexes correctly', async () => {
		const pool = makeMockPool([
			{
				indexname: 'idx_unique',
				indexdef: 'CREATE UNIQUE INDEX idx_unique ON users USING btree (email)',
			},
		]);
		const adapter = createPgsqlAdapter(pool);
		const result = await adapter.listIndexes('users');
		expect(result[0]!.unique).toBe(true);
		expect(result[0]!.method).toBe('btree');
	});
});

// ===========================================================================
// indexExists
// ===========================================================================

describe('PgsqlAdapter.indexExists()', () => {
	it('returns true when EXISTS query returns true', async () => {
		const pool = makeMockPool([{ exists: true }]);
		const adapter = createPgsqlAdapter(pool);
		const result = await adapter.indexExists('idx_users_email', 'users');

		expect(result).toBe(true);
		const [sql, params] = catalogCall(pool);
		expect(sql).toContain('pg_indexes');
		expect(sql).toContain('EXISTS');
		expect(params).toEqual(['idx_users_email', 'users', null]);
	});

	it('returns false when index does not exist', async () => {
		const pool = makeMockPool([{ exists: false }]);
		const adapter = createPgsqlAdapter(pool);
		expect(await adapter.indexExists('idx_missing', 'users')).toBe(false);
	});

	it('uses provided schema in params', async () => {
		const pool = makeMockPool([{ exists: true }]);
		const adapter = createPgsqlAdapter(pool);
		await adapter.indexExists('idx_foo', 'users', 'tenant_42');

		const [, params] = catalogCall(pool);
		expect(params).toEqual(['idx_foo', 'users', 'tenant_42']);
	});

	it('falls back to adapter schemaName when schema arg omitted', async () => {
		const pool = makeMockPool([{ exists: false }]);
		const adapter = createPgsqlAdapter(pool, { schemaName: 'myschema' });
		await adapter.indexExists('idx_foo', 'orders');

		const [, params] = catalogCall(pool);
		expect(params[2]).toBe('myschema');
	});

	it('returns false when query returns no rows', async () => {
		const pool = makeMockPool([]);
		const adapter = createPgsqlAdapter(pool);
		expect(await adapter.indexExists('idx_ghost', 'users')).toBe(false);
	});
});

// ===========================================================================
// storageSize
// ===========================================================================

describe('PgsqlAdapter.storageSize()', () => {
	it('returns the size as a number', async () => {
		const pool = makeMockPool([{ size: '8192' }]);
		const adapter = createPgsqlAdapter(pool);
		const result = await adapter.storageSize('users');

		expect(result).toBe(8192);
		const [sql, params] = catalogCall(pool);
		expect(sql).toContain('pg_total_relation_size');
		expect(sql).toContain('$1::regclass');
		expect(params[0]).toBe('"users"');
	});

	it('uses the provided schema in the qualified identifier param', async () => {
		const pool = makeMockPool([{ size: '4096' }]);
		const adapter = createPgsqlAdapter(pool);
		await adapter.storageSize('orders', 'tenant_42');

		const [, params] = catalogCall(pool);
		expect(params[0]).toBe('"tenant_42"."orders"');
	});

	it('falls back to adapter schemaName', async () => {
		const pool = makeMockPool([{ size: '0' }]);
		const adapter = createPgsqlAdapter(pool, { schemaName: 'myschema' });
		await adapter.storageSize('logs');

		const [, params] = catalogCall(pool);
		expect(params[0]).toBe('"myschema"."logs"');
	});

	it('returns 0 when query returns no rows', async () => {
		const pool = makeMockPool([]);
		const adapter = createPgsqlAdapter(pool);
		expect(await adapter.storageSize('empty')).toBe(0);
	});

	it('throws on compile-only adapter', async () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		await expect(adapter.storageSize('users')).rejects.toThrow(
			'constructed without a connection',
		);
	});
});
