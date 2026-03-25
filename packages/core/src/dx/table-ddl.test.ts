/**
 * Unit tests for table-scoped DDL methods (DDL-TABLE-001)
 *
 * Tests the wrapTablesProxyWithDDL helper and DDL method SQL generation.
 * Pure unit tests — no database connection required.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Adapter } from '../adapter.js';
import { wrapTablesProxyWithDDL } from './orm-instance.js';

// -----------------------------------------------------------------------
// Minimal mock adapter with executeDDL spy
// -----------------------------------------------------------------------
function makeDDLAdapter() {
	const executeDDL = vi.fn().mockResolvedValue(undefined);
	const executeRaw = vi.fn().mockResolvedValue([]);
	const adapter = {
		executeDDL,
		executeRaw,
		compile: vi.fn(),
		execute: vi.fn(),
		executeOne: vi.fn(),
		executeOneOrThrow: vi.fn(),
		stream: vi.fn(),
		introspect: vi.fn(),
		transaction: vi.fn(),
		withSchema: vi.fn().mockReturnThis(),
		validateIdentifier: vi.fn(),
		generateDDL: vi.fn(),
		dbCasing: 'snake_case' as const,
	} as unknown as Adapter<unknown>;
	return { adapter, executeDDL, executeRaw };
}

// -----------------------------------------------------------------------
// wrapTablesProxyWithDDL — basic proxy behaviour
// -----------------------------------------------------------------------

describe('wrapTablesProxyWithDDL', () => {
	it('returns undefined for unknown table', () => {
		const { adapter } = makeDDLAdapter();
		const proxy = wrapTablesProxyWithDDL({}, adapter, undefined) as Record<
			string,
			unknown
		>;
		expect(proxy['nonexistent']).toBeUndefined();
	});

	it('adds truncate/vacuum/alterColumn/indexes to each table', () => {
		const { adapter } = makeDDLAdapter();
		const base: Record<string, object> = { users: {} };
		const proxy = wrapTablesProxyWithDDL(base, adapter, undefined) as Record<
			string,
			Record<string, unknown>
		>;
		const users = proxy['users'];
		expect(typeof users['truncate']).toBe('function');
		expect(typeof users['vacuum']).toBe('function');
		expect(typeof users['alterColumn']).toBe('function');
		expect(typeof users['indexes']).toBe('object');
	});

	it('returns same augmented object on repeated access (cache)', () => {
		const { adapter } = makeDDLAdapter();
		const base: Record<string, object> = { users: {} };
		const proxy = wrapTablesProxyWithDDL(base, adapter, undefined) as Record<
			string,
			unknown
		>;
		expect(proxy['users']).toBe(proxy['users']);
	});

	it('passes through Symbol properties from target', () => {
		const { adapter } = makeDDLAdapter();
		const sym = Symbol('test');
		const base = { [sym]: 42 } as unknown as object;
		const proxy = wrapTablesProxyWithDDL(base, adapter, undefined) as Record<
			symbol,
			unknown
		>;
		expect(proxy[sym]).toBe(42);
	});
});

// -----------------------------------------------------------------------
// truncate
// -----------------------------------------------------------------------

describe('orm.tables.X.truncate()', () => {
	type TableProxy = Record<string, Record<string, unknown>>;

	it('generates TRUNCATE "users"', async () => {
		const { adapter, executeDDL } = makeDDLAdapter();
		const proxy = wrapTablesProxyWithDDL(
			{ users: {} },
			adapter,
			undefined,
		) as TableProxy;
		await (proxy['users']['truncate'] as () => Promise<void>)();
		expect(executeDDL).toHaveBeenCalledWith('TRUNCATE "users"');
	});

	it('appends RESTART IDENTITY CASCADE', async () => {
		const { adapter, executeDDL } = makeDDLAdapter();
		const proxy = wrapTablesProxyWithDDL(
			{ users: {} },
			adapter,
			undefined,
		) as TableProxy;
		await (proxy['users']['truncate'] as (o: unknown) => Promise<void>)({
			cascade: true,
			restartIdentity: true,
		});
		expect(executeDDL).toHaveBeenCalledWith(
			'TRUNCATE "users" RESTART IDENTITY CASCADE',
		);
	});

	it('uses schema-qualified table', async () => {
		const { adapter, executeDDL } = makeDDLAdapter();
		const proxy = wrapTablesProxyWithDDL(
			{ users: {} },
			adapter,
			'tenant_42',
		) as TableProxy;
		await (proxy['users']['truncate'] as () => Promise<void>)();
		expect(executeDDL).toHaveBeenCalledWith('TRUNCATE "tenant_42"."users"');
	});

	it('throws when adapter has no executeDDL', async () => {
		const proxy = wrapTablesProxyWithDDL(
			{ users: {} },
			undefined,
			undefined,
		) as TableProxy;
		await expect(
			(proxy['users']['truncate'] as () => Promise<void>)(),
		).rejects.toThrow('executeDDL() requires an adapter');
	});
});

// -----------------------------------------------------------------------
// vacuum
// -----------------------------------------------------------------------

describe('orm.tables.X.vacuum()', () => {
	type TableProxy = Record<string, Record<string, unknown>>;

	it('generates plain VACUUM "logs"', async () => {
		const { adapter, executeDDL } = makeDDLAdapter();
		const proxy = wrapTablesProxyWithDDL(
			{ logs: {} },
			adapter,
			undefined,
		) as TableProxy;
		await (proxy['logs']['vacuum'] as () => Promise<void>)();
		expect(executeDDL).toHaveBeenCalledWith('VACUUM "logs"');
	});

	it('generates VACUUM (FULL, ANALYZE)', async () => {
		const { adapter, executeDDL } = makeDDLAdapter();
		const proxy = wrapTablesProxyWithDDL(
			{ logs: {} },
			adapter,
			undefined,
		) as TableProxy;
		await (proxy['logs']['vacuum'] as (o: unknown) => Promise<void>)({
			full: true,
			analyze: true,
		});
		expect(executeDDL).toHaveBeenCalledWith('VACUUM (FULL, ANALYZE) "logs"');
	});

	it('generates VACUUM (FULL) when only full=true', async () => {
		const { adapter, executeDDL } = makeDDLAdapter();
		const proxy = wrapTablesProxyWithDDL(
			{ logs: {} },
			adapter,
			undefined,
		) as TableProxy;
		await (proxy['logs']['vacuum'] as (o: unknown) => Promise<void>)({
			full: true,
		});
		expect(executeDDL).toHaveBeenCalledWith('VACUUM (FULL) "logs"');
	});
});

// -----------------------------------------------------------------------
// alterColumn
// -----------------------------------------------------------------------

describe('orm.tables.X.alterColumn()', () => {
	type TableProxy = Record<string, Record<string, unknown>>;
	type AlterFn = (col: string, opts: unknown) => Promise<void>;

	it('generates ALTER COLUMN ... TYPE', async () => {
		const { adapter, executeDDL } = makeDDLAdapter();
		const proxy = wrapTablesProxyWithDDL(
			{ users: {} },
			adapter,
			undefined,
		) as TableProxy;
		await (proxy['users']['alterColumn'] as AlterFn)('email', {
			type: 'VARCHAR(255)',
		});
		expect(executeDDL).toHaveBeenCalledWith(
			'ALTER TABLE "users" ALTER COLUMN "email" TYPE VARCHAR(255)',
		);
	});

	it('generates TYPE ... USING ...', async () => {
		const { adapter, executeDDL } = makeDDLAdapter();
		const proxy = wrapTablesProxyWithDDL(
			{ users: {} },
			adapter,
			undefined,
		) as TableProxy;
		await (proxy['users']['alterColumn'] as AlterFn)('score', {
			type: 'integer',
			using: 'score::integer',
		});
		expect(executeDDL).toHaveBeenCalledWith(
			'ALTER TABLE "users" ALTER COLUMN "score" TYPE integer USING score::integer',
		);
	});

	it('generates SET NOT NULL', async () => {
		const { adapter, executeDDL } = makeDDLAdapter();
		const proxy = wrapTablesProxyWithDDL(
			{ users: {} },
			adapter,
			undefined,
		) as TableProxy;
		await (proxy['users']['alterColumn'] as AlterFn)('email', {
			setNotNull: true,
		});
		expect(executeDDL).toHaveBeenCalledWith(
			'ALTER TABLE "users" ALTER COLUMN "email" SET NOT NULL',
		);
	});

	it('generates DROP NOT NULL', async () => {
		const { adapter, executeDDL } = makeDDLAdapter();
		const proxy = wrapTablesProxyWithDDL(
			{ users: {} },
			adapter,
			undefined,
		) as TableProxy;
		await (proxy['users']['alterColumn'] as AlterFn)('email', {
			setNotNull: false,
		});
		expect(executeDDL).toHaveBeenCalledWith(
			'ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL',
		);
	});

	it('generates DROP DEFAULT', async () => {
		const { adapter, executeDDL } = makeDDLAdapter();
		const proxy = wrapTablesProxyWithDDL(
			{ users: {} },
			adapter,
			undefined,
		) as TableProxy;
		await (proxy['users']['alterColumn'] as AlterFn)('created_at', {
			dropDefault: true,
		});
		expect(executeDDL).toHaveBeenCalledWith(
			'ALTER TABLE "users" ALTER COLUMN "created_at" DROP DEFAULT',
		);
	});

	it('generates SET DEFAULT', async () => {
		const { adapter, executeDDL } = makeDDLAdapter();
		const proxy = wrapTablesProxyWithDDL(
			{ users: {} },
			adapter,
			undefined,
		) as TableProxy;
		await (proxy['users']['alterColumn'] as AlterFn)('active', {
			setDefault: 'true',
		});
		expect(executeDDL).toHaveBeenCalledWith(
			'ALTER TABLE "users" ALTER COLUMN "active" SET DEFAULT true',
		);
	});

	it('throws when no alteration option specified', async () => {
		const { adapter } = makeDDLAdapter();
		const proxy = wrapTablesProxyWithDDL(
			{ users: {} },
			adapter,
			undefined,
		) as TableProxy;
		await expect(
			(proxy['users']['alterColumn'] as AlterFn)('email', {}),
		).rejects.toThrow('At least one alteration option must be specified');
	});
});

// -----------------------------------------------------------------------
// indexes.create
// -----------------------------------------------------------------------

describe('orm.tables.X.indexes.create()', () => {
	type IndexProxy = Record<string, (o: unknown) => Promise<void>>;
	function getIndexes(adapter: Adapter<unknown>, schema?: string): IndexProxy {
		const proxy = wrapTablesProxyWithDDL(
			{ users: {} },
			adapter,
			schema,
		) as Record<string, Record<string, unknown>>;
		return proxy['users']['indexes'] as IndexProxy;
	}

	it('generates CREATE INDEX', async () => {
		const { adapter, executeDDL } = makeDDLAdapter();
		await getIndexes(adapter).create({
			name: 'idx_users_email',
			columns: ['email'],
		});
		expect(executeDDL).toHaveBeenCalledWith(
			'CREATE INDEX "idx_users_email" ON "users" ("email")',
		);
	});

	it('generates CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS', async () => {
		const { adapter, executeDDL } = makeDDLAdapter();
		await getIndexes(adapter).create({
			name: 'idx_users_email',
			columns: ['email'],
			unique: true,
			concurrently: true,
			ifNotExists: true,
		});
		expect(executeDDL).toHaveBeenCalledWith(
			'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "idx_users_email" ON "users" ("email")',
		);
	});

	it('generates CREATE INDEX USING gin', async () => {
		const { adapter, executeDDL } = makeDDLAdapter();
		await getIndexes(adapter).create({
			name: 'idx_fts',
			columns: ['name'],
			method: 'gin',
		});
		expect(executeDDL).toHaveBeenCalledWith(
			'CREATE INDEX "idx_fts" ON "users" USING gin ("name")',
		);
	});

	it('generates expression column index', async () => {
		const { adapter, executeDDL } = makeDDLAdapter();
		await getIndexes(adapter).create({
			name: 'idx_lower_email',
			columns: [{ expression: 'lower(email)' }],
		});
		expect(executeDDL).toHaveBeenCalledWith(
			'CREATE INDEX "idx_lower_email" ON "users" ((lower(email)))',
		);
	});

	it('generates INCLUDE + WHERE clause', async () => {
		const { adapter, executeDDL } = makeDDLAdapter();
		await getIndexes(adapter).create({
			name: 'idx_users_active',
			columns: ['email'],
			include: ['id', 'name'],
			where: 'active = true',
		});
		expect(executeDDL).toHaveBeenCalledWith(
			'CREATE INDEX "idx_users_active" ON "users" ("email") INCLUDE ("id", "name") WHERE active = true',
		);
	});

	it('uses schema-qualified table', async () => {
		const { adapter, executeDDL } = makeDDLAdapter();
		await getIndexes(adapter, 'public').create({
			name: 'idx_x',
			columns: ['id'],
		});
		expect(executeDDL).toHaveBeenCalledWith(
			'CREATE INDEX "idx_x" ON "public"."users" ("id")',
		);
	});
});

// -----------------------------------------------------------------------
// indexes.drop
// -----------------------------------------------------------------------

describe('orm.tables.X.indexes.drop()', () => {
	type IndexProxy = { drop: (n: string, o?: unknown) => Promise<void> };
	function getIndexes(adapter: Adapter<unknown>): IndexProxy {
		const proxy = wrapTablesProxyWithDDL(
			{ users: {} },
			adapter,
			undefined,
		) as Record<string, Record<string, unknown>>;
		return proxy['users']['indexes'] as IndexProxy;
	}

	it('generates DROP INDEX "idx_name"', async () => {
		const { adapter, executeDDL } = makeDDLAdapter();
		await getIndexes(adapter).drop('idx_users_email');
		expect(executeDDL).toHaveBeenCalledWith('DROP INDEX "idx_users_email"');
	});

	it('generates DROP INDEX CONCURRENTLY IF EXISTS ... CASCADE', async () => {
		const { adapter, executeDDL } = makeDDLAdapter();
		await getIndexes(adapter).drop('idx_users_email', {
			concurrently: true,
			ifExists: true,
			cascade: true,
		});
		expect(executeDDL).toHaveBeenCalledWith(
			'DROP INDEX CONCURRENTLY IF EXISTS "idx_users_email" CASCADE',
		);
	});

	it('uses explicit schema option', async () => {
		const { adapter, executeDDL } = makeDDLAdapter();
		await getIndexes(adapter).drop('idx_users_email', { schema: 'public' });
		expect(executeDDL).toHaveBeenCalledWith(
			'DROP INDEX "public"."idx_users_email"',
		);
	});
});

// -----------------------------------------------------------------------
// indexes.list
// -----------------------------------------------------------------------

describe('orm.tables.X.indexes.list()', () => {
	type IndexProxy = { list: () => Promise<unknown> };
	function getIndexes(
		adapter: Adapter<unknown> | undefined,
		schemaName?: string,
	): IndexProxy {
		const proxy = wrapTablesProxyWithDDL(
			{ users: {} },
			adapter,
			schemaName,
		) as Record<string, Record<string, unknown>>;
		return proxy['users']['indexes'] as IndexProxy;
	}

	it('returns rows from executeRaw', async () => {
		const { adapter, executeRaw } = makeDDLAdapter();
		const fakeRows = [
			{
				name: 'idx_a',
				definition: 'CREATE INDEX ...',
				unique: false,
				method: 'btree',
			},
		];
		executeRaw.mockResolvedValue(fakeRows);
		const result = await getIndexes(adapter).list();
		expect(result).toEqual(fakeRows);
		expect(executeRaw).toHaveBeenCalled();
	});

	it('throws when no adapter', async () => {
		await expect(getIndexes(undefined).list()).rejects.toThrow(
			'indexes.list() requires an adapter',
		);
	});
});
