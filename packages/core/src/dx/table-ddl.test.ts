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
import type {
	Adapter,
	AlterColumnOptions,
	CreateIndexOptions,
	DropIndexOptions,
	TruncateOptions,
	VacuumOptions,
} from '../adapter.js';
import { createOrmInstance, wrapTablesProxyWithDDL } from './orm-instance.js';
import { createMockAdapter } from './test-utils.js';

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
		(table: string, schemaName: string, options?: TruncateOptions) => {
			const parts = [`${schemaName}.${table}`];
			if (options?.restartIdentity) parts.push('RESTART IDENTITY');
			if (options?.cascade) parts.push('CASCADE');
			return `TRUNCATE ${parts[0]}${parts.length > 1 ? ` ${parts.slice(1).join(' ')}` : ''}`;
		},
	);
	const generateVacuum = vi.fn(
		(table: string, schemaName: string, options?: VacuumOptions) => {
			const mods: string[] = [];
			if (options?.full) mods.push('FULL');
			if (options?.analyze) mods.push('ANALYZE');
			const mod = mods.length > 0 ? ` ${mods.join(' ')}` : '';
			return `VACUUM${mod} ${schemaName}.${table}`;
		},
	);
	const generateAlterColumn = vi.fn(
		(
			table: string,
			schemaName: string,
			column: string,
			options: AlterColumnOptions,
		) => {
			const tbl = `${schemaName}.${table}`;
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
				clauses.push(
					`ALTER COLUMN ${column} SET DEFAULT ${options.setDefault}`,
				);
			if (clauses.length === 0)
				throw new Error('At least one alteration option must be specified');
			return `ALTER TABLE ${tbl} ${clauses.join(', ')}`;
		},
	);
	const generateCreateIndex = vi.fn(
		(table: string, schemaName: string, options: CreateIndexOptions) => {
			const tbl = `${schemaName}.${table}`;
			const parts: string[] = ['CREATE'];
			if (options.unique) parts.push('UNIQUE');
			parts.push('INDEX');
			if (options.concurrently) parts.push('CONCURRENTLY');
			if (options.ifNotExists) parts.push('IF NOT EXISTS');
			parts.push(String(options.name));
			parts.push('ON');
			parts.push(tbl);
			if (options.method) parts.push(`USING ${options.method}`);
			const cols = options.columns
				.map((column) =>
					typeof column === 'string' ? column : column.expression,
				)
				.join(', ');
			parts.push(`(${cols})`);
			if (options.unique && options.nullsNotDistinct) {
				parts.push('NULLS NOT DISTINCT');
			}
			return parts.join(' ');
		},
	);
	const generateDropIndex = vi.fn(
		(name: string, schemaName: string, options?: DropIndexOptions) => {
			const parts: string[] = ['DROP INDEX'];
			if (options?.concurrently) parts.push('CONCURRENTLY');
			if (options?.ifExists) parts.push('IF EXISTS');
			parts.push(`${schemaName}.${name}`);
			if (options?.cascade) parts.push('CASCADE');
			return parts.join(' ');
		},
	);
	const fakeIndexRows = [
		{
			name: 'idx_a',
			definition: 'CREATE INDEX ...',
			unique: false,
			method: 'btree',
		},
	];
	const listIndexes = vi.fn().mockResolvedValue(fakeIndexRows);
	const indexExists = vi.fn().mockResolvedValue(true);
	const storageSize = vi.fn().mockResolvedValue(4096);

	const adapter: Adapter = {
		...createMockAdapter(),
		executeDDL,
		executeRaw,
		generateTruncate,
		generateVacuum,
		generateAlterColumn,
		generateCreateIndex,
		generateDropIndex,
		listIndexes,
		indexExists,
		storageSize,
		inTransaction: false,
		dbCasing: 'snake_case' as const,
	};
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
		indexExists,
		storageSize,
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
		expect(proxy.nonexistent).toBeUndefined();
	});

	it('adds truncate/vacuum/alterColumn/indexes to each table', () => {
		const { adapter } = makeDDLAdapter();
		const base: Record<string, object> = { users: {} };
		const proxy = wrapTablesProxyWithDDL(base, adapter, undefined) as {
			users: Record<string, unknown>;
		};
		const users = proxy.users;
		expect(typeof users.truncate).toBe('function');
		expect(typeof users.vacuum).toBe('function');
		expect(typeof users.alterColumn).toBe('function');
		expect(typeof users.indexes).toBe('object');
	});

	it('returns same augmented object on repeated access (cache)', () => {
		const { adapter } = makeDDLAdapter();
		const base: Record<string, object> = { users: {} };
		const proxy = wrapTablesProxyWithDDL(base, adapter, undefined) as Record<
			string,
			unknown
		>;
		expect(proxy.users).toBe(proxy.users);
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
	type TableProxy = {
		users: { truncate(options?: TruncateOptions): Promise<void> };
	};

	it('delegates to adapter.generateTruncate and calls executeDDL with result', async () => {
		const { adapter, executeDDL, generateTruncate } = makeDDLAdapter();
		const proxy = wrapTablesProxyWithDDL(
			{ users: {} },
			adapter,
			undefined,
		) as TableProxy;
		await proxy.users.truncate();
		expect(generateTruncate).toHaveBeenCalledWith('users', 'public', undefined);
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
		await proxy.users.truncate({
			cascade: true,
			restartIdentity: true,
		});
		expect(generateTruncate).toHaveBeenCalledWith('users', 'public', {
			cascade: true,
			restartIdentity: true,
		});
	});

	it('passes schema to adapter.generateTruncate', async () => {
		const { adapter, generateTruncate } = makeDDLAdapter();
		const proxy = wrapTablesProxyWithDDL(
			{ users: {} },
			adapter,
			'tenant_42',
		) as TableProxy;
		await proxy.users.truncate();
		expect(generateTruncate).toHaveBeenCalledWith(
			'users',
			'tenant_42',
			undefined,
		);
	});

	it('throws when adapter has no executeDDL', async () => {
		const proxy = wrapTablesProxyWithDDL(
			{ users: {} },
			undefined,
			undefined,
		) as TableProxy;
		await expect(proxy.users.truncate()).rejects.toThrow(
			'executeDDL() requires an adapter',
		);
	});
});

// -----------------------------------------------------------------------
// vacuum
// -----------------------------------------------------------------------

describe('orm.tables.X.vacuum()', () => {
	type TableProxy = {
		logs: { vacuum(options?: VacuumOptions): Promise<void> };
	};

	it('delegates to adapter.generateVacuum and calls executeDDL', async () => {
		const { adapter, executeDDL, generateVacuum } = makeDDLAdapter();
		const proxy = wrapTablesProxyWithDDL(
			{ logs: {} },
			adapter,
			undefined,
		) as TableProxy;
		await proxy.logs.vacuum();
		expect(generateVacuum).toHaveBeenCalledWith('logs', 'public', undefined);
		expect(executeDDL).toHaveBeenCalledWith(expect.stringContaining('VACUUM'));
	});

	it('passes options to adapter.generateVacuum', async () => {
		const { adapter, generateVacuum } = makeDDLAdapter();
		const proxy = wrapTablesProxyWithDDL(
			{ logs: {} },
			adapter,
			undefined,
		) as TableProxy;
		await proxy.logs.vacuum({
			full: true,
			analyze: true,
		});
		expect(generateVacuum).toHaveBeenCalledWith('logs', 'public', {
			full: true,
			analyze: true,
		});
	});

	it('throws when inTransaction=true', async () => {
		const { adapter } = makeDDLAdapter();
		Object.defineProperty(adapter, 'inTransaction', { value: true });
		const proxy = wrapTablesProxyWithDDL(
			{ logs: {} },
			adapter,
			undefined,
		) as TableProxy;
		await expect(proxy.logs.vacuum()).rejects.toThrow(
			'VACUUM cannot run inside a transaction block',
		);
	});
});

// -----------------------------------------------------------------------
// alterColumn
// -----------------------------------------------------------------------

describe('orm.tables.X.alterColumn()', () => {
	type TableProxy = {
		users: {
			alterColumn(column: string, options: AlterColumnOptions): Promise<void>;
		};
	};

	it('delegates to adapter.generateAlterColumn and calls executeDDL', async () => {
		const { adapter, executeDDL, generateAlterColumn } = makeDDLAdapter();
		const proxy = wrapTablesProxyWithDDL(
			{ users: {} },
			adapter,
			undefined,
		) as TableProxy;
		await proxy.users.alterColumn('email', {
			type: 'VARCHAR(255)',
		});
		expect(generateAlterColumn).toHaveBeenCalledWith(
			'users',
			'public',
			'email',
			{ type: 'VARCHAR(255)' },
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
		await proxy.users.alterColumn('email', {
			setNotNull: true,
		});
		expect(generateAlterColumn).toHaveBeenCalledWith(
			'users',
			'myschema',
			'email',
			{ setNotNull: true },
		);
	});

	it('throws when no alteration option specified', async () => {
		const { adapter } = makeDDLAdapter();
		const proxy = wrapTablesProxyWithDDL(
			{ users: {} },
			adapter,
			undefined,
		) as TableProxy;
		await expect(proxy.users.alterColumn('email', {})).rejects.toThrow(
			'At least one alteration option must be specified',
		);
	});
});

// -----------------------------------------------------------------------
// indexes.create
// -----------------------------------------------------------------------

describe('orm.tables.X.indexes.create()', () => {
	type IndexProxy = {
		users: { indexes: { create(options: CreateIndexOptions): Promise<void> } };
	};

	it('delegates to adapter.generateCreateIndex and calls executeDDL', async () => {
		const { adapter, executeDDL, generateCreateIndex } = makeDDLAdapter();
		const idxProxy = wrapTablesProxyWithDDL(
			{ users: {} },
			adapter,
			undefined,
		) as IndexProxy;
		await idxProxy.users.indexes.create({
			name: 'idx_users_email',
			columns: ['email'],
		});
		expect(generateCreateIndex).toHaveBeenCalledWith('users', 'public', {
			name: 'idx_users_email',
			columns: ['email'],
		});
		expect(executeDDL).toHaveBeenCalledWith(
			expect.stringContaining('CREATE INDEX'),
		);
	});

	it('forwards nullsNotDistinct to adapter SQL generation', async () => {
		const { adapter, executeDDL, generateCreateIndex } = makeDDLAdapter();
		const idxProxy = wrapTablesProxyWithDDL(
			{ users: {} },
			adapter,
			undefined,
		) as IndexProxy;

		await idxProxy.users.indexes.create({
			name: 'uk_users_email_nulls',
			columns: ['email'],
			unique: true,
			nullsNotDistinct: true,
		});

		expect(generateCreateIndex).toHaveBeenCalledWith('users', 'public', {
			name: 'uk_users_email_nulls',
			columns: ['email'],
			unique: true,
			nullsNotDistinct: true,
		});
		expect(executeDDL).toHaveBeenCalledWith(
			'CREATE UNIQUE INDEX uk_users_email_nulls ON public.users (email) NULLS NOT DISTINCT',
		);
	});

	it('passes schema to adapter.generateCreateIndex', async () => {
		const { adapter, generateCreateIndex } = makeDDLAdapter();
		const idxProxy = wrapTablesProxyWithDDL(
			{ users: {} },
			adapter,
			'public',
		) as IndexProxy;
		await idxProxy.users.indexes.create({
			name: 'idx_x',
			columns: ['id'],
		});
		expect(generateCreateIndex).toHaveBeenCalledWith('users', 'public', {
			name: 'idx_x',
			columns: ['id'],
		});
	});

	it('throws when CONCURRENTLY inside transaction', async () => {
		const { adapter } = makeDDLAdapter();
		Object.defineProperty(adapter, 'inTransaction', { value: true });
		const idxProxy = wrapTablesProxyWithDDL(
			{ users: {} },
			adapter,
			undefined,
		) as IndexProxy;
		await expect(
			idxProxy.users.indexes.create({
				name: 'idx_x',
				columns: ['id'],
				concurrently: true,
			}),
		).rejects.toThrow(
			'CREATE INDEX CONCURRENTLY cannot run inside a transaction',
		);
	});

	it('refuses CONCURRENTLY when adapter omits inTransaction', async () => {
		const { adapter, executeDDL, generateCreateIndex } = makeDDLAdapter();
		Reflect.deleteProperty(adapter, 'inTransaction');
		const idxProxy = wrapTablesProxyWithDDL(
			{ users: {} },
			adapter,
			undefined,
		) as IndexProxy;

		await expect(
			idxProxy.users.indexes.create({
				name: 'idx_x',
				columns: ['id'],
				concurrently: true,
			}),
		).rejects.toThrow('inTransaction: boolean');
		expect(generateCreateIndex).not.toHaveBeenCalled();
		expect(executeDDL).not.toHaveBeenCalled();
	});
});

// -----------------------------------------------------------------------
// indexes.drop
// -----------------------------------------------------------------------

describe('orm.tables.X.indexes.drop()', () => {
	type IndexProxy = {
		drop(name: string, options?: DropIndexOptions): Promise<void>;
	};
	function getIndexes(adapter: Adapter<unknown>): IndexProxy {
		const proxy = wrapTablesProxyWithDDL({ users: {} }, adapter, undefined) as {
			users: { indexes: IndexProxy };
		};
		return proxy.users.indexes;
	}

	function getScopedIndexes(
		adapter: Adapter<unknown>,
		schema: string,
	): IndexProxy {
		const proxy = wrapTablesProxyWithDDL({ users: {} }, adapter, schema) as {
			users: { indexes: IndexProxy };
		};
		return proxy.users.indexes;
	}

	it('delegates to adapter.generateDropIndex and calls executeDDL', async () => {
		const { adapter, executeDDL, generateDropIndex } = makeDDLAdapter();
		await getIndexes(adapter).drop('idx_users_email');
		expect(generateDropIndex).toHaveBeenCalledWith(
			'idx_users_email',
			'public',
			undefined,
		);
		expect(executeDDL).toHaveBeenCalledWith(
			expect.stringContaining('DROP INDEX'),
		);
	});

	it('passes the ORM schema scope to the adapter', async () => {
		const { adapter, generateDropIndex } = makeDDLAdapter();
		await getScopedIndexes(adapter, 'tenant_7').drop('idx_users_email');
		expect(generateDropIndex).toHaveBeenCalledWith(
			'idx_users_email',
			'tenant_7',
			undefined,
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
			'public',
			{
				concurrently: true,
				ifExists: true,
				cascade: true,
			},
		);
	});

	it('throws when CONCURRENTLY inside transaction', async () => {
		const { adapter } = makeDDLAdapter();
		Object.defineProperty(adapter, 'inTransaction', { value: true });
		await expect(
			getIndexes(adapter).drop('idx_users_email', { concurrently: true }),
		).rejects.toThrow(
			'DROP INDEX CONCURRENTLY cannot run inside a transaction',
		);
	});

	it('refuses CONCURRENTLY when adapter omits inTransaction', async () => {
		const { adapter, executeDDL, generateDropIndex } = makeDDLAdapter();
		Reflect.deleteProperty(adapter, 'inTransaction');

		await expect(
			getIndexes(adapter).drop('idx_users_email', { concurrently: true }),
		).rejects.toThrow('inTransaction: boolean');
		expect(generateDropIndex).not.toHaveBeenCalled();
		expect(executeDDL).not.toHaveBeenCalled();
	});
});

// -----------------------------------------------------------------------
// indexes.list
// -----------------------------------------------------------------------

describe('orm.tables.X.indexes.list()', () => {
	type IndexProxy = {
		list(options?: { namePattern?: string }): Promise<unknown>;
		exists(name: string): Promise<boolean>;
	};
	function getIndexes(
		adapter: Adapter<unknown> | undefined,
		schemaName?: string,
	): IndexProxy {
		const proxy = wrapTablesProxyWithDDL(
			{ users: {} },
			adapter,
			schemaName,
		) as { users: { indexes: IndexProxy } };
		return proxy.users.indexes;
	}

	it('delegates to adapter.listIndexes', async () => {
		const { adapter, listIndexes } = makeDDLAdapter();
		const result = await getIndexes(adapter).list();
		expect(listIndexes).toHaveBeenCalledWith('users', undefined, undefined);
		expect(result).toEqual([
			{
				name: 'idx_a',
				definition: 'CREATE INDEX ...',
				unique: false,
				method: 'btree',
			},
		]);
	});

	it('passes schema to adapter.listIndexes', async () => {
		const { adapter, listIndexes } = makeDDLAdapter();
		await getIndexes(adapter, 'tenant_42').list();
		expect(listIndexes).toHaveBeenCalledWith('users', 'tenant_42', undefined);
	});

	it('passes namePattern option to adapter.listIndexes', async () => {
		const { adapter, listIndexes } = makeDDLAdapter();
		await getIndexes(adapter).list({ namePattern: 'idx_vec%' });
		expect(listIndexes).toHaveBeenCalledWith('users', undefined, {
			namePattern: 'idx_vec%',
		});
	});

	it('passes schema and namePattern together', async () => {
		const { adapter, listIndexes } = makeDDLAdapter();
		await getIndexes(adapter, 'myschema').list({ namePattern: 'idx_%' });
		expect(listIndexes).toHaveBeenCalledWith('users', 'myschema', {
			namePattern: 'idx_%',
		});
	});

	it('throws when no adapter', async () => {
		await expect(getIndexes(undefined).list()).rejects.toThrow(
			'indexes.list() requires an adapter',
		);
	});
});

// -----------------------------------------------------------------------
// indexes.exists
// -----------------------------------------------------------------------

describe('orm.tables.X.indexes.exists()', () => {
	type IndexProxy = { exists(name: string): Promise<boolean> };
	function getIndexes(
		adapter: Adapter<unknown> | undefined,
		schemaName?: string,
	): IndexProxy {
		const proxy = wrapTablesProxyWithDDL(
			{ users: {} },
			adapter,
			schemaName,
		) as { users: { indexes: IndexProxy } };
		return proxy.users.indexes;
	}

	it('delegates to adapter.indexExists with correct args', async () => {
		const { adapter, indexExists } = makeDDLAdapter();
		const result = await getIndexes(adapter).exists('idx_users_email');
		expect(indexExists).toHaveBeenCalledWith(
			'idx_users_email',
			'users',
			undefined,
		);
		expect(result).toBe(true);
	});

	it('passes schema to adapter.indexExists', async () => {
		const { adapter, indexExists } = makeDDLAdapter();
		await getIndexes(adapter, 'tenant_42').exists('idx_foo');
		expect(indexExists).toHaveBeenCalledWith('idx_foo', 'users', 'tenant_42');
	});

	it('throws when no adapter', async () => {
		await expect(getIndexes(undefined).exists('idx_foo')).rejects.toThrow(
			'indexes.exists() requires an adapter',
		);
	});

	it('throws when adapter does not implement indexExists', async () => {
		const { adapter } = makeDDLAdapter();
		Reflect.deleteProperty(adapter, 'indexExists');
		await expect(getIndexes(adapter).exists('idx_foo')).rejects.toThrow(
			'indexes.exists() requires an adapter that implements indexExists()',
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
		expect(generateDropIndex).toHaveBeenCalledWith('idx_foo', 'public', {
			ifExists: true,
		});
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

	// The table-scoped `.indexes.drop()` refuses this. The global shortcut is the
	// same statement reaching the same database, and it must refuse it too — going
	// there to be told so aborts the transaction the caller was in.
	it('refuses DROP INDEX CONCURRENTLY inside a transaction', async () => {
		const { adapter, executeDDL, generateDropIndex } = makeDDLAdapter();
		Object.defineProperty(adapter, 'inTransaction', { value: true });
		const orm = createOrmInstance(
			{ tables: {} } as never,
			false,
			{},
			adapter,
			undefined,
		);

		await expect(
			orm.ddl.dropIndex('idx_foo', { concurrently: true }),
		).rejects.toThrow(
			'DROP INDEX CONCURRENTLY cannot run inside a transaction',
		);
		expect(generateDropIndex).not.toHaveBeenCalled();
		expect(executeDDL).not.toHaveBeenCalled();
	});

	it('refuses DROP INDEX CONCURRENTLY when adapter omits inTransaction', async () => {
		const { adapter, executeDDL, generateDropIndex } = makeDDLAdapter();
		Reflect.deleteProperty(adapter, 'inTransaction');
		const orm = createOrmInstance(
			{ tables: {} } as never,
			false,
			{},
			adapter,
			undefined,
		);

		await expect(
			orm.ddl.dropIndex('idx_foo', { concurrently: true }),
		).rejects.toThrow('inTransaction: boolean');
		expect(generateDropIndex).not.toHaveBeenCalled();
		expect(executeDDL).not.toHaveBeenCalled();
	});

	// withSchema('tenant') must reach the adapter. Passing only the caller's options
	// leaves PostgreSQL to resolve the bare name through search_path — which, in a
	// multi-tenant database, can drop an index belonging to a different tenant.
	it('passes the ORM schema scope to the adapter', async () => {
		const { adapter, generateDropIndex } = makeDDLAdapter();
		const orm = createOrmInstance(
			{ tables: {} } as never,
			false,
			{},
			adapter,
			'tenant_7',
		);

		await orm.ddl.dropIndex('idx_foo', { ifExists: true });

		expect(generateDropIndex).toHaveBeenCalledWith('idx_foo', 'tenant_7', {
			ifExists: true,
		});
	});

	it('ignores a legacy schema option at runtime and keeps ORM scope', async () => {
		const { adapter, generateDropIndex } = makeDDLAdapter();
		const orm = createOrmInstance(
			{ tables: {} } as never,
			false,
			{},
			adapter,
			'tenant_7',
		);

		await orm.ddl.dropIndex('idx_foo', { schema: 'other' } as never);

		expect(generateDropIndex).toHaveBeenCalledWith(
			'idx_foo',
			'tenant_7',
			undefined,
		);
	});
});

// -----------------------------------------------------------------------
// storageSize
// -----------------------------------------------------------------------

describe('orm.tables.X.storageSize()', () => {
	type TableDDLProxy = { storageSize(): Promise<number> };
	function getTable(
		adapter: Adapter<unknown> | undefined,
		schemaName?: string,
	): TableDDLProxy {
		const proxy = wrapTablesProxyWithDDL(
			{ users: {} },
			adapter,
			schemaName,
		) as { users: TableDDLProxy };
		return proxy.users;
	}

	it('delegates to adapter.storageSize with correct args', async () => {
		const { adapter, storageSize } = makeDDLAdapter();
		const result = await getTable(adapter).storageSize();
		expect(storageSize).toHaveBeenCalledWith('users', undefined);
		expect(result).toBe(4096);
	});

	it('passes schema to adapter.storageSize', async () => {
		const { adapter, storageSize } = makeDDLAdapter();
		await getTable(adapter, 'tenant_42').storageSize();
		expect(storageSize).toHaveBeenCalledWith('users', 'tenant_42');
	});

	it('throws when no adapter', async () => {
		await expect(getTable(undefined).storageSize()).rejects.toThrow(
			'storageSize() requires an adapter',
		);
	});

	it('throws when adapter does not implement storageSize', async () => {
		const { adapter } = makeDDLAdapter();
		Reflect.deleteProperty(adapter, 'storageSize');
		await expect(getTable(adapter).storageSize()).rejects.toThrow(
			'storageSize() requires an adapter that implements storageSize()',
		);
	});
});
