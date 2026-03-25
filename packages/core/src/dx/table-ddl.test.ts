/**
 * Unit tests for table-scoped DDL methods (DDL-TABLE-001)
 *
 * Tests the wrapTablesProxyWithDDL helper and DDL adapter delegation.
 * After F-001 refactor: core delegates SQL generation to adapter.generate*() methods.
 * Exact SQL strings are tested in ddl-table-ops.test.ts (adapter tests).
 *
 * Pure unit tests — no database connection required.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Adapter } from '../adapter.js';
import { createOrmInstance, wrapTablesProxyWithDDL } from './orm-instance.js';

// -----------------------------------------------------------------------
// Minimal mock adapter with executeDDL + generate* spies
// -----------------------------------------------------------------------
function makeDDLAdapter() {
	const executeDDL = vi.fn().mockResolvedValue(undefined);
	const executeRaw = vi.fn().mockResolvedValue([]);
	// generate* mocks return recognisable sentinel strings so tests can assert
	// both that the right method was called with the right args and that
	// executeDDL received the generated SQL.
	const generateTruncate = vi.fn(
		(table: string, schema?: string, options?: Record<string, unknown>) => {
			const parts = [schema ? `${schema}.${table}` : table];
			if (options?.restartIdentity) parts.push('RESTART IDENTITY');
			if (options?.cascade) parts.push('CASCADE');
			return `TRUNCATE ${parts[0]}${parts.length > 1 ? ' ' + parts.slice(1).join(' ') : ''}`;
		},
	);
	const generateVacuum = vi.fn(
		(table: string, _schema?: string, options?: Record<string, unknown>) => {
			const mods: string[] = [];
			if (options?.full) mods.push('FULL');
			if (options?.analyze) mods.push('ANALYZE');
			const mod = mods.length > 0 ? ` ${mods.join(' ')}` : '';
			return `VACUUM${mod} ${table}`;
		},
	);
	const generateAlterColumn = vi.fn(
		(table: string, column: string, options: Record<string, unknown>, schema?: string) => {
			const tbl = schema ? `${schema}.${table}` : table;
			const clauses: string[] = [];
			if (options.type !== undefined)
				clauses.push(`ALTER COLUMN ${column} TYPE ${options.type}`);
			if (options.setNotNull === true)
				clauses.push(`ALTER COLUMN ${column} SET NOT NULL`);
			if (options.setNotNull === false)
				clauses.push(`ALTER COLUMN ${column} DROP NOT NULL`);
			if (options.dropDefault === true)
				clauses.push(`ALTER COLUMN ${column} DROP DEFAULT`);
			if (options.setDefault !== undefined)
				clauses.push(`ALTER COLUMN ${column} SET DEFAULT ${options.setDefault}`);
			if (clauses.length === 0)
				throw new Error('At least one alteration option must be specified');
			return `ALTER TABLE ${tbl} ${clauses.join(', ')}`;
		},
	);
	const generateCreateIndex = vi.fn(
		(table: string, options: Record<string, unknown>, schema?: string) => {
			const tbl = schema ? `${schema}.${table}` : table;
			const parts: string[] = ['CREATE'];
			if (options.unique) parts.push('UNIQUE');
			parts.push('INDEX');
			if (options.concurrently) parts.push('CONCURRENTLY');
			if (options.ifNotExists) parts.push('IF NOT EXISTS');
			parts.push(String(options.name));
			parts.push('ON');
			parts.push(tbl);
			if (options.method) parts.push(`USING ${options.method}`);
			const cols = (options.columns as string[]).join(', ');
			parts.push(`(${cols})`);
			return parts.join(' ');
		},
	);
	const generateDropIndex = vi.fn(
		(name: string, options?: Record<string, unknown>) => {
			const parts: string[] = ['DROP INDEX'];
			if (options?.concurrently) parts.push('CONCURRENTLY');
			if (options?.ifExists) parts.push('IF EXISTS');
			const sc = options?.schema as string | undefined;
			parts.push(sc ? `${sc}.${name}` : name);
			if (options?.cascade) parts.push('CASCADE');
			return parts.join(' ');
		},
	);
	const fakeIndexRows = [
		{ name: 'idx_a', definition: 'CREATE INDEX ...', unique: false, method: 'btree' },
	];
	const listIndexes = vi.fn().mockResolvedValue(fakeIndexRows);

	const adapter = {
		executeDDL,
		executeRaw,
		generateTruncate,
		generateVacuum,
		generateAlterColumn,
		generateCreateIndex,
		generateDropIndex,
		listIndexes,
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
	return {
		adapter,
		executeDDL,
		executeRaw,
		generateTruncate,
		generateVacuum,
		generateAlterColumn,
		generateCreateIndex,
		generateDropIndex,
		listIndexes,
	};
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

	it('delegates to adapter.generateTruncate and calls executeDDL with result', async () => {
		const { adapter, executeDDL, generateTruncate } = makeDDLAdapter();
		const proxy = wrapTablesProxyWithDDL(
			{ users: {} },
			adapter,
			undefined,
		) as TableProxy;
		await (proxy['users']['truncate'] as () => Promise<void>)();
		expect(generateTruncate).toHaveBeenCalledWith('users', undefined, undefined);
		expect(executeDDL).toHaveBeenCalledWith(
			expect.stringContaining('TRUNCATE'),
		);
	});

	it('passes options to adapter.generateTruncate', async () => {
		const { adapter, generateTruncate } = makeDDLAdapter();
		const proxy = wrapTablesProxyWithDDL(
			{ users: {} },
			adapter,
			undefined,
		) as TableProxy;
		await (proxy['users']['truncate'] as (o: unknown) => Promise<void>)({
			cascade: true,
			restartIdentity: true,
		});
		expect(generateTruncate).toHaveBeenCalledWith(
			'users',
			undefined,
			{ cascade: true, restartIdentity: true },
		);
	});

	it('passes schema to adapter.generateTruncate', async () => {
		const { adapter, generateTruncate } = makeDDLAdapter();
		const proxy = wrapTablesProxyWithDDL(
			{ users: {} },
			adapter,
			'tenant_42',
		) as TableProxy;
		await (proxy['users']['truncate'] as () => Promise<void>)();
		expect(generateTruncate).toHaveBeenCalledWith('users', 'tenant_42', undefined);
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

	it('delegates to adapter.generateVacuum and calls executeDDL', async () => {
		const { adapter, executeDDL, generateVacuum } = makeDDLAdapter();
		const proxy = wrapTablesProxyWithDDL(
			{ logs: {} },
			adapter,
			undefined,
		) as TableProxy;
		await (proxy['logs']['vacuum'] as () => Promise<void>)();
		expect(generateVacuum).toHaveBeenCalledWith('logs', undefined, undefined);
		expect(executeDDL).toHaveBeenCalledWith(expect.stringContaining('VACUUM'));
	});

	it('passes options to adapter.generateVacuum', async () => {
		const { adapter, generateVacuum } = makeDDLAdapter();
		const proxy = wrapTablesProxyWithDDL(
			{ logs: {} },
			adapter,
			undefined,
		) as TableProxy;
		await (proxy['logs']['vacuum'] as (o: unknown) => Promise<void>)({
			full: true,
			analyze: true,
		});
		expect(generateVacuum).toHaveBeenCalledWith(
			'logs',
			undefined,
			{ full: true, analyze: true },
		);
	});

	it('throws when inTransaction=true', async () => {
		const { adapter } = makeDDLAdapter();
		(adapter as Record<string, unknown>).inTransaction = true;
		const proxy = wrapTablesProxyWithDDL(
			{ logs: {} },
			adapter,
			undefined,
		) as TableProxy;
		await expect(
			(proxy['logs']['vacuum'] as () => Promise<void>)(),
		).rejects.toThrow('VACUUM cannot run inside a transaction block');
	});
});

// -----------------------------------------------------------------------
// alterColumn
// -----------------------------------------------------------------------

describe('orm.tables.X.alterColumn()', () => {
	type TableProxy = Record<string, Record<string, unknown>>;
	type AlterFn = (col: string, opts: unknown) => Promise<void>;

	it('delegates to adapter.generateAlterColumn and calls executeDDL', async () => {
		const { adapter, executeDDL, generateAlterColumn } = makeDDLAdapter();
		const proxy = wrapTablesProxyWithDDL(
			{ users: {} },
			adapter,
			undefined,
		) as TableProxy;
		await (proxy['users']['alterColumn'] as AlterFn)('email', {
			type: 'VARCHAR(255)',
		});
		expect(generateAlterColumn).toHaveBeenCalledWith(
			'users',
			'email',
			{ type: 'VARCHAR(255)' },
			undefined,
		);
		expect(executeDDL).toHaveBeenCalledWith(
			expect.stringContaining('ALTER TABLE'),
		);
	});

	it('passes schema to adapter.generateAlterColumn', async () => {
		const { adapter, generateAlterColumn } = makeDDLAdapter();
		const proxy = wrapTablesProxyWithDDL(
			{ users: {} },
			adapter,
			'myschema',
		) as TableProxy;
		await (proxy['users']['alterColumn'] as AlterFn)('email', {
			setNotNull: true,
		});
		expect(generateAlterColumn).toHaveBeenCalledWith(
			'users',
			'email',
			{ setNotNull: true },
			'myschema',
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
	function getIndexes(
		adapter: Adapter<unknown>,
		schema?: string,
	): { proxy: IndexProxy; result: ReturnType<typeof makeDDLAdapter> } {
		// Re-use same adapter instance so we can access spies
		const result = { adapter } as unknown as ReturnType<typeof makeDDLAdapter>;
		const proxy = wrapTablesProxyWithDDL(
			{ users: {} },
			adapter,
			schema,
		) as Record<string, Record<string, unknown>>;
		return { proxy: proxy['users']['indexes'] as IndexProxy, result };
	}

	it('delegates to adapter.generateCreateIndex and calls executeDDL', async () => {
		const { adapter, executeDDL, generateCreateIndex } = makeDDLAdapter();
		const idxProxy = wrapTablesProxyWithDDL(
			{ users: {} },
			adapter,
			undefined,
		) as Record<string, Record<string, Record<string, unknown>>>;
		await (idxProxy['users']['indexes']['create'] as (o: unknown) => Promise<void>)({
			name: 'idx_users_email',
			columns: ['email'],
		});
		expect(generateCreateIndex).toHaveBeenCalledWith(
			'users',
			{ name: 'idx_users_email', columns: ['email'] },
			undefined,
		);
		expect(executeDDL).toHaveBeenCalledWith(
			expect.stringContaining('CREATE INDEX'),
		);
	});

	it('passes schema to adapter.generateCreateIndex', async () => {
		const { adapter, generateCreateIndex } = makeDDLAdapter();
		const idxProxy = wrapTablesProxyWithDDL(
			{ users: {} },
			adapter,
			'public',
		) as Record<string, Record<string, Record<string, unknown>>>;
		await (idxProxy['users']['indexes']['create'] as (o: unknown) => Promise<void>)({
			name: 'idx_x',
			columns: ['id'],
		});
		expect(generateCreateIndex).toHaveBeenCalledWith(
			'users',
			{ name: 'idx_x', columns: ['id'] },
			'public',
		);
	});

	it('throws when CONCURRENTLY inside transaction', async () => {
		const { adapter } = makeDDLAdapter();
		(adapter as Record<string, unknown>).inTransaction = true;
		const idxProxy = wrapTablesProxyWithDDL(
			{ users: {} },
			adapter,
			undefined,
		) as Record<string, Record<string, Record<string, unknown>>>;
		await expect(
			(idxProxy['users']['indexes']['create'] as (o: unknown) => Promise<void>)({
				name: 'idx_x',
				columns: ['id'],
				concurrently: true,
			}),
		).rejects.toThrow('CREATE INDEX CONCURRENTLY cannot run inside a transaction');
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

	it('delegates to adapter.generateDropIndex and calls executeDDL', async () => {
		const { adapter, executeDDL, generateDropIndex } = makeDDLAdapter();
		await getIndexes(adapter).drop('idx_users_email');
		expect(generateDropIndex).toHaveBeenCalledWith('idx_users_email', undefined);
		expect(executeDDL).toHaveBeenCalledWith(
			expect.stringContaining('DROP INDEX'),
		);
	});

	it('passes options to adapter.generateDropIndex', async () => {
		const { adapter, generateDropIndex } = makeDDLAdapter();
		await getIndexes(adapter).drop('idx_users_email', {
			concurrently: true,
			ifExists: true,
			cascade: true,
		});
		expect(generateDropIndex).toHaveBeenCalledWith(
			'idx_users_email',
			{ concurrently: true, ifExists: true, cascade: true },
		);
	});

	it('throws when CONCURRENTLY inside transaction', async () => {
		const { adapter } = makeDDLAdapter();
		(adapter as Record<string, unknown>).inTransaction = true;
		await expect(
			getIndexes(adapter).drop('idx_users_email', { concurrently: true }),
		).rejects.toThrow('DROP INDEX CONCURRENTLY cannot run inside a transaction');
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

	it('delegates to adapter.listIndexes', async () => {
		const { adapter, listIndexes } = makeDDLAdapter();
		const result = await getIndexes(adapter).list();
		expect(listIndexes).toHaveBeenCalledWith('users', undefined);
		expect(result).toEqual([
			{ name: 'idx_a', definition: 'CREATE INDEX ...', unique: false, method: 'btree' },
		]);
	});

	it('passes schema to adapter.listIndexes', async () => {
		const { adapter, listIndexes } = makeDDLAdapter();
		await getIndexes(adapter, 'tenant_42').list();
		expect(listIndexes).toHaveBeenCalledWith('users', 'tenant_42');
	});

	it('throws when no adapter', async () => {
		await expect(getIndexes(undefined).list()).rejects.toThrow(
			'indexes.list() requires an adapter',
		);
	});
});

// -----------------------------------------------------------------------
// orm.ddl.dropIndex (F-005)
// -----------------------------------------------------------------------

describe('orm.ddl.dropIndex()', () => {
	it('delegates to adapter.generateDropIndex and calls executeDDL', async () => {
		const { adapter, executeDDL, generateDropIndex } = makeDDLAdapter();
		const orm = createOrmInstance(
			{ tables: {} } as never,
			false,
			{},
			adapter,
			undefined,
		);
		await orm.ddl.dropIndex('idx_foo', { ifExists: true });
		expect(generateDropIndex).toHaveBeenCalledWith('idx_foo', { ifExists: true });
		expect(executeDDL).toHaveBeenCalledWith(
			expect.stringContaining('DROP INDEX'),
		);
	});

	it('throws when adapter has no executeDDL', async () => {
		const orm = createOrmInstance(
			{ tables: {} } as never,
			false,
			{},
			undefined,
			undefined,
		);
		await expect(orm.ddl.dropIndex('idx_foo')).rejects.toThrow(
			'executeDDL() requires an adapter',
		);
	});
});
