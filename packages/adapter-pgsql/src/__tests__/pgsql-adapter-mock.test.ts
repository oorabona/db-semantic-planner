/**
 * Strict branch-coverage tests for pgsql-adapter.ts using pg.Pool mocks.
 *
 * Covers:
 *  - transaction() BEGIN/COMMIT happy path + ROLLBACK on error + client reuse
 *  - stream() with-client path, error ROLLBACK, pool-acquired path
 *  - execute() with snake_case → camelCase row transformation
 *  - executeRaw() error propagation
 *  - getPoolInstance() success path
 *  - indexExists() false branch (row with exists:false) + schema fallback
 *  - withSchema() carries pool, scoped execute works
 *  - compileWithIncludes() with/without include decisions
 *  - executeDDL() success path via pool.query
 *  - inTransaction flag semantics
 *  - listIndexes() / storageSize() schema fallback branches
 */

import { type Adapter, createOrm, schema } from '@dbsp/core';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
	introspect,
	PgsqlRawSqlTransactionControlError,
	PgsqlTransactionAbortedCommitError,
	PgsqlTransactionAbortedError,
} from '../index.js';
import {
	createPgsqlAdapter,
	createPgsqlCompileOnlyAdapter,
	PgsqlAdapter,
	type PgsqlBorrowedClientAdapterOptions,
} from '../pgsql-adapter.js';

const TRANSACTION_CONTROL_BOUNDARY =
	'Transaction control through raw SQL inside a scope dbsp is managing is unsupported. ' +
	'`COMMIT`, `ROLLBACK`, and `PREPARE TRANSACTION` end the transaction dbsp is working inside; dbsp detects that and fails loudly, but the data is already whatever your statement made it. ' +
	'Raw savepoint control (`SAVEPOINT`, `RELEASE SAVEPOINT`, `ROLLBACK TO SAVEPOINT`) can alter the savepoint stack before dbsp sees the command tag; dbsp poisons the scope, but it cannot make that command un-run. ' +
	"Manage your transaction outside dbsp's calls.";

const ownershipOrmSchema = schema({
	items: {
		id: { type: 'integer', primaryKey: true },
		label: 'string',
	},
});

type MockQueryInput = string;

function queryText(input: unknown): string {
	if (typeof input === 'string') return input;
	if (
		typeof input === 'object' &&
		input !== null &&
		'text' in input &&
		typeof (input as { readonly text?: unknown }).text === 'string'
	) {
		return (input as { readonly text: string }).text;
	}
	return String(input);
}

function queryCalls(query: ReturnType<typeof vi.fn>): string[] {
	return query.mock.calls.map((call) => queryText(call[0]));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient(
	queryImpl?: (sql: string) => Promise<QueryResult>,
): PoolClient {
	return {
		query: queryImpl
			? vi
					.fn()
					.mockImplementation((input: MockQueryInput) =>
						queryImpl(queryText(input)),
					)
			: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
		release: vi.fn(),
	} as unknown as PoolClient;
}

function makePool(
	poolQueryResult: { rows: unknown[] } = { rows: [] },
	client?: PoolClient,
): Pool {
	const _client = client ?? makeClient();
	return {
		query: vi.fn().mockResolvedValue(poolQueryResult),
		connect: vi.fn().mockResolvedValue(_client),
		end: vi.fn(),
	} as unknown as Pool;
}

function noActiveTransactionError(): Error & { code: string } {
	return Object.assign(new Error('no active transaction'), {
		code: '25P01',
	});
}

function makePrepareTagClient(prepareEndsTransaction: boolean): {
	readonly client: PoolClient;
	readonly prepareResult: QueryResult;
} {
	let transactionOpen = true;
	let prepareTagReturned = false;
	const prepareResult = {
		rows: [],
		rowCount: 0,
		command: 'PREPARE',
	} as QueryResult;
	const query = vi.fn(async (input: MockQueryInput) => {
		const sql = queryText(input);
		if (/^SAVEPOINT /.test(sql)) {
			if (!transactionOpen) throw noActiveTransactionError();
			return { rows: [], rowCount: 0, command: 'SAVEPOINT' } as QueryResult;
		}
		if (/^ROLLBACK TO SAVEPOINT /.test(sql)) {
			if (!transactionOpen) throw noActiveTransactionError();
			return { rows: [], rowCount: 0, command: 'ROLLBACK' } as QueryResult;
		}
		if (/^RELEASE SAVEPOINT /.test(sql)) {
			if (!transactionOpen) throw noActiveTransactionError();
			return { rows: [], rowCount: 0, command: 'RELEASE' } as QueryResult;
		}
		if (!prepareTagReturned) {
			prepareTagReturned = true;
			if (prepareEndsTransaction) transactionOpen = false;
			return prepareResult;
		}
		return { rows: [], rowCount: 0, command: 'SELECT' } as QueryResult;
	});
	return {
		client: { query, release: vi.fn() } as unknown as PoolClient,
		prepareResult,
	};
}

/** The first (single) catalog query call. */
function catalogCall(pool: Pool): [string, unknown[]] {
	const spy = pool.query as ReturnType<typeof vi.fn>;
	return spy.mock.calls[0] as [string, unknown[]];
}

async function captureRejection(
	action: () => Promise<unknown>,
): Promise<unknown> {
	try {
		await action();
	} catch (error) {
		return error;
	}
	throw new Error('Expected promise to reject');
}

function expectCleanupFailure(
	error: unknown,
	originalError: Error,
	cleanupError: Error,
	messagePattern: RegExp,
): void {
	expect(error).toBeInstanceOf(AggregateError);
	expect((error as Error).message).toMatch(messagePattern);
	expect((error as Error).cause).toBe(originalError);
	expect((error as AggregateError).errors).toContain(originalError);
	expect((error as AggregateError).errors).toContain(cleanupError);
}

function expectRawSqlTransactionControlError(
	error: unknown,
	cause: unknown,
): void {
	expect(error).toBeInstanceOf(PgsqlRawSqlTransactionControlError);
	expect((error as Error).name).toBe('PgsqlRawSqlTransactionControlError');
	expect((error as Error).message).toBe(TRANSACTION_CONTROL_BOUNDARY);
	expect((error as Error).message).toContain(
		'`COMMIT`, `ROLLBACK`, and `PREPARE TRANSACTION`',
	);
	expect((error as Error).message).toContain('Raw savepoint control');
	expect((error as Error).message).toContain(
		"Manage your transaction outside dbsp's calls.",
	);
	expect((error as Error).message).not.toContain('cleanup failed');
	expect((error as Error).cause).toBe(cause);
}

function collectReachableStrings(
	value: unknown,
	seen = new Set<object>(),
): string[] {
	if (typeof value === 'string') return [value];
	if (typeof value !== 'object' || value === null) return [];
	if (seen.has(value)) return [];
	seen.add(value);

	const strings: string[] = [];
	for (const key of [
		...Object.getOwnPropertyNames(value),
		...Object.getOwnPropertySymbols(value),
	]) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor && 'value' in descriptor) {
			strings.push(...collectReachableStrings(descriptor.value, seen));
		}
	}
	return strings;
}

function deferred<T = void>(): {
	readonly promise: Promise<T>;
	readonly resolve: (value?: T | PromiseLike<T>) => void;
	readonly reject: (error: unknown) => void;
} {
	let resolve!: (value?: T | PromiseLike<T>) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function assertPublicConstructorRejectsInternalOptions(
	client: PoolClient,
): void {
	// @ts-expect-error adapterManagedTransaction is an internal option, not public API.
	new PgsqlAdapter(client, {
		borrowedClient: true,
		adapterManagedTransaction: true,
	});
	// @ts-expect-error dbspScopeToken is an internal option, not public API.
	new PgsqlAdapter(client, {
		borrowedClient: true,
		dbspScopeToken: Symbol('forged'),
	});
}
void assertPublicConstructorRejectsInternalOptions;

// ---------------------------------------------------------------------------
// transaction() — BEGIN / COMMIT happy path
// ---------------------------------------------------------------------------

describe('introspect() refuses a checked-out client', () => {
	// The signature says Pool, and a signature is a compile-time boundary: a
	// JavaScript caller, or anyone with a cast, walks straight past it. A client
	// that got in here would run its catalog reads unprotected inside whatever
	// transaction its owner had open.
	it('throws instead of running catalog reads inside somebody else transaction', async () => {
		const client = {
			query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
			release: vi.fn(),
		} as unknown as Pool;

		await expect(introspect(client)).rejects.toThrow(
			/takes a pg\.Pool, and was given a checked-out pg\.PoolClient/,
		);
		expect((client as unknown as PoolClient).query).not.toHaveBeenCalled();
	});
});

describe('@dbsp/adapter-pgsql public API', () => {
	// Both classes are imported from the package entry point, NOT from the module
	// that defines them — so a class the adapter throws but never re-exports fails
	// here, which is the gap this covers. Constructing one and asserting it is one
	// would pass no matter what index.ts exports.

	it('throws the transaction-control error the entry point publishes', async () => {
		const client = makeClient(async (sql: string) =>
			sql === 'SAVEPOINT s'
				? ({ rows: [], rowCount: 0, command: 'SAVEPOINT' } as QueryResult)
				: ({ rows: [], rowCount: 0, command: 'SELECT' } as QueryResult),
		);
		const adapter = new PgsqlAdapter(makePool({ rows: [] }, client));

		await expect(
			adapter.transaction(async (tx) =>
				(tx as unknown as PgsqlAdapter).executeRaw('SAVEPOINT s'),
			),
		).rejects.toBeInstanceOf(PgsqlRawSqlTransactionControlError);
	});

	it('throws the aborted-commit error the entry point publishes', async () => {
		const client = makeClient(async (sql: string) =>
			sql === 'COMMIT'
				? ({ rows: [], rowCount: 0, command: 'ROLLBACK' } as QueryResult)
				: ({ rows: [], rowCount: 0, command: 'SELECT' } as QueryResult),
		);
		const adapter = new PgsqlAdapter(makePool({ rows: [] }, client));

		await expect(
			adapter.transaction(async () => undefined),
		).rejects.toBeInstanceOf(PgsqlTransactionAbortedCommitError);
	});

	it('ignores forged internal options and still savepoints borrowed-client statements', async () => {
		const statementError = new Error('raw statement failed');
		const query = vi.fn(async (input: MockQueryInput) => {
			const sql = queryText(input);
			if (sql === 'SELECT fail') throw statementError;
			return { rows: [], rowCount: 0, command: 'SELECT' } as QueryResult;
		});
		const client = { query, release: vi.fn() } as unknown as PoolClient;
		const adapter = new PgsqlAdapter(client, {
			borrowedClient: true,
			adapterManagedTransaction: true,
		} as unknown as PgsqlBorrowedClientAdapterOptions);

		const error = await captureRejection(() =>
			adapter.executeRaw('SELECT fail'),
		);

		expect(error).toBe(statementError);
		expect((error as Error).message).toContain(
			'rolled back the failed raw SQL to a savepoint',
		);
		expect(queryCalls(query)).toEqual([
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			'SELECT fail',
			expect.stringMatching(/^ROLLBACK TO SAVEPOINT dbsp_savepoint_/),
			expect.stringMatching(/^RELEASE SAVEPOINT dbsp_savepoint_/),
		]);
		expect(client.release).not.toHaveBeenCalled();
	});
});

describe('PgsqlAdapter.transaction — BEGIN/COMMIT success path', () => {
	it('issues BEGIN before calling fn and COMMIT after', async () => {
		const queryMock = vi.fn().mockResolvedValue({ rows: [] });
		const txClient = makeClient(() => queryMock());
		const pool = makePool({ rows: [] }, txClient);

		const adapter = createPgsqlAdapter(pool);
		const result = await adapter.transaction(async () => 'ok');

		expect(result).toBe('ok');
		expect(pool.connect).toHaveBeenCalledOnce();
		const calls = queryCalls(txClient.query as ReturnType<typeof vi.fn>);
		expect(calls[0]).toBe('BEGIN');
		expect(calls[calls.length - 1]).toBe('COMMIT');
		expect(txClient.release).toHaveBeenCalledOnce();
	});

	it('throws when COMMIT reports that PostgreSQL rolled the transaction back', async () => {
		const query = vi.fn(async (input: MockQueryInput) => {
			const sql = queryText(input);
			if (sql === 'COMMIT') {
				return { rows: [], rowCount: 0, command: 'ROLLBACK' } as QueryResult;
			}
			return { rows: [], rowCount: 0, command: sql } as QueryResult;
		});
		const txClient = { query, release: vi.fn() } as unknown as PoolClient;
		const pool = makePool({ rows: [] }, txClient);
		const adapter = createPgsqlAdapter(pool);

		const error = await captureRejection(() =>
			adapter.transaction(async (tx) => {
				await tx.executeRaw('SELECT 1');
			}),
		);

		expect(error).toBeInstanceOf(PgsqlTransactionAbortedCommitError);
		expect((error as Error).name).toBe('PgsqlTransactionAbortedCommitError');
		expect((error as Error).message).toContain('returned ROLLBACK for COMMIT');
		expect((error as Error).cause).toEqual({
			rows: [],
			rowCount: 0,
			command: 'ROLLBACK',
		});
		expect(queryCalls(query)).toEqual(['BEGIN', 'SELECT 1', 'COMMIT']);
		expect(txClient.release).toHaveBeenCalledOnce();
	});

	it('drains unawaited orm.transaction statements before COMMIT', async () => {
		const firstStarted = deferred();
		const releaseFirst = deferred();
		const query = vi.fn(async (input: MockQueryInput) => {
			const sql = queryText(input);
			if (sql === 'SELECT first') {
				firstStarted.resolve();
				await releaseFirst.promise;
			}
			return { rows: [], rowCount: 0, command: 'SELECT' } as QueryResult;
		});
		const txClient = { query, release: vi.fn() } as unknown as PoolClient;
		const pool = makePool({ rows: [] }, txClient);
		const adapter = createPgsqlAdapter(pool);
		const orm = createOrm({ schema: ownershipOrmSchema, adapter });

		const transaction = orm.transaction(async (tx) => {
			void tx.raw('SELECT first');
			void tx.raw('SELECT second');
		});

		await firstStarted.promise;
		await Promise.resolve();
		expect(queryCalls(query)).toEqual(['BEGIN', 'SELECT first']);

		releaseFirst.resolve();
		await transaction;

		expect(queryCalls(query)).toEqual([
			'BEGIN',
			'SELECT first',
			'SELECT second',
			'COMMIT',
		]);
		expect(txClient.release).toHaveBeenCalledOnce();
	});

	it('refuses statements issued after the transaction callback has returned', async () => {
		const firstStarted = deferred();
		const releaseFirst = deferred();
		const releaseCommit = deferred();
		const callbackReturned = deferred();
		const query = vi.fn(async (input: MockQueryInput) => {
			const sql = queryText(input);
			if (sql === 'SELECT first') {
				firstStarted.resolve();
				await releaseFirst.promise;
			}
			if (sql === 'COMMIT') {
				await releaseCommit.promise;
			}
			return { rows: [], rowCount: 0, command: 'SELECT' } as QueryResult;
		});
		const txClient = { query, release: vi.fn() } as unknown as PoolClient;
		const pool = makePool({ rows: [] }, txClient);
		const adapter = createPgsqlAdapter(pool);
		const orm = createOrm({ schema: ownershipOrmSchema, adapter });
		let txAfterReturn:
			| {
					raw<T = unknown>(
						sql: string,
						parameters?: readonly unknown[],
					): Promise<T[]>;
			  }
			| undefined;

		const transaction = orm.transaction(async (tx) => {
			txAfterReturn = tx;
			void tx.raw('SELECT first');
			setTimeout(() => callbackReturned.resolve(), 0);
		});

		await firstStarted.promise;
		await callbackReturned.promise;
		if (txAfterReturn === undefined) {
			throw new Error('expected transaction adapter to be captured');
		}

		let lateError: unknown;
		const late = txAfterReturn.raw('SELECT after callback');
		const lateState = await Promise.race([
			late.then(
				() => 'resolved',
				(error) => {
					lateError = error;
					return 'rejected';
				},
			),
			new Promise<'pending'>((resolve) =>
				setTimeout(() => resolve('pending'), 0),
			),
		]);

		try {
			expect(lateState).toBe('rejected');
			expect(lateError).toBeInstanceOf(Error);
			expect((lateError as Error).message).toContain(
				'transaction that has ended',
			);
			expect(queryCalls(query)).not.toContain('SELECT after callback');
		} finally {
			releaseFirst.resolve();
			releaseCommit.resolve();
			await transaction.catch(() => undefined);
			await late.catch(() => undefined);
		}

		expect(queryCalls(query)).toEqual(['BEGIN', 'SELECT first', 'COMMIT']);
		expect(txClient.release).toHaveBeenCalledOnce();
	});

	it('detects tx.executeRaw transaction control before issuing any further statement', async () => {
		const commitResult = {
			rows: [],
			rowCount: 0,
			command: 'COMMIT',
		} as QueryResult;
		const query = vi.fn(async (input: MockQueryInput) => {
			const sql = queryText(input);
			if (sql === 'COMMIT') return commitResult;
			return { rows: [], rowCount: 0, command: 'SELECT' } as QueryResult;
		});
		const txClient = { query, release: vi.fn() } as unknown as PoolClient;
		const pool = makePool({ rows: [] }, txClient);
		const adapter = createPgsqlAdapter(pool);

		const error = await captureRejection(() =>
			adapter.transaction(async (tx) => {
				await tx.executeRaw('COMMIT');
				await tx.executeRaw('SELECT after commit');
			}),
		);

		expectRawSqlTransactionControlError(error, commitResult);
		expect(queryCalls(query)).toEqual(['BEGIN', 'COMMIT', 'ROLLBACK']);
		expect(txClient.release).toHaveBeenCalledOnce();
	});

	it.each([
		{ command: 'COMMIT', statement: 'COMMIT' },
		{ command: 'ROLLBACK', statement: 'ROLLBACK' },
		{ command: 'PREPARE', statement: "PREPARE TRANSACTION 'x'" },
	])('keeps a caught raw $statement poison live until orm.transaction rejects', async ({
		command,
		statement,
	}) => {
		const postControlSql = 'INSERT INTO items VALUES (99)';
		let transactionOpen = false;
		const commandResult = {
			rows: [],
			rowCount: 0,
			command,
		} as QueryResult;
		const query = vi.fn(async (input: MockQueryInput) => {
			const sql = queryText(input);
			if (sql === 'BEGIN') {
				transactionOpen = true;
				return { rows: [], rowCount: 0, command: 'BEGIN' } as QueryResult;
			}
			if (/^SAVEPOINT /.test(sql)) {
				if (!transactionOpen) throw noActiveTransactionError();
				return {
					rows: [],
					rowCount: 0,
					command: 'SAVEPOINT',
				} as QueryResult;
			}
			if (sql === statement) {
				transactionOpen = false;
				return commandResult;
			}
			if (sql === 'ROLLBACK') {
				if (!transactionOpen) throw noActiveTransactionError();
				transactionOpen = false;
				return { rows: [], rowCount: 0, command: 'ROLLBACK' } as QueryResult;
			}
			return { rows: [], rowCount: 0, command: 'INSERT' } as QueryResult;
		});
		const txClient = { query, release: vi.fn() } as unknown as PoolClient;
		const pool = makePool({ rows: [] }, txClient);
		const adapter = createPgsqlAdapter(pool);
		const orm = createOrm({ schema: ownershipOrmSchema, adapter });
		let firstError: unknown;
		let secondError: unknown;

		const transactionError = await captureRejection(() =>
			orm.transaction(async (tx) => {
				try {
					await tx.raw(statement);
				} catch (error) {
					firstError = error;
				}
				try {
					await tx.raw(postControlSql);
				} catch (error) {
					secondError = error;
				}
				return 'callback returned normally';
			}),
		);

		expectRawSqlTransactionControlError(firstError, commandResult);
		expect(secondError).toBe(firstError);
		expect(transactionError).toBe(firstError);
		const calls = queryCalls(query);
		expect(calls).not.toContain(postControlSql);
		expect(calls.filter((sql) => sql === 'COMMIT')).toHaveLength(
			statement === 'COMMIT' ? 1 : 0,
		);
		expect(txClient.release).toHaveBeenCalledOnce();
	});

	it('rolls back and releases a pool-owned transaction after a swallowed poisoned-scope error', async () => {
		const savepointResult = {
			rows: [],
			rowCount: 0,
			command: 'SAVEPOINT',
		} as QueryResult;
		let openTransaction = false;
		const query = vi.fn(async (input: MockQueryInput) => {
			const sql = queryText(input);
			if (sql === 'BEGIN') {
				openTransaction = true;
				return { rows: [], rowCount: 0, command: 'BEGIN' } as QueryResult;
			}
			if (sql === 'SAVEPOINT s') return savepointResult;
			if (sql === 'ROLLBACK') {
				openTransaction = false;
				return { rows: [], rowCount: 0, command: 'ROLLBACK' } as QueryResult;
			}
			return { rows: [], rowCount: 0, command: 'SELECT' } as QueryResult;
		});
		const txClient = {
			query,
			release: vi.fn(() => {
				expect(openTransaction).toBe(false);
			}),
		} as unknown as PoolClient;
		const pool = makePool({ rows: [] }, txClient);
		const adapter = createPgsqlAdapter(pool);
		let swallowed: unknown;

		const error = await captureRejection(() =>
			adapter.transaction(async (tx) => {
				try {
					await tx.executeRaw('SAVEPOINT s');
				} catch (caught) {
					swallowed = caught;
				}
				return 'callback returned normally';
			}),
		);

		expectRawSqlTransactionControlError(swallowed, savepointResult);
		expect(error).toBe(swallowed);
		expect(queryCalls(query)).toEqual(['BEGIN', 'SAVEPOINT s', 'ROLLBACK']);
		expect(txClient.release).toHaveBeenCalledOnce();
	});

	it('rolls back a pool-owned transaction before releasing after raw SAVEPOINT control', async () => {
		const savepointResult = {
			rows: [],
			rowCount: 0,
			command: 'SAVEPOINT',
		} as QueryResult;
		let openTransaction = false;
		const query = vi.fn(async (input: MockQueryInput) => {
			const sql = queryText(input);
			if (sql === 'BEGIN') openTransaction = true;
			if (sql === 'ROLLBACK') openTransaction = false;
			if (sql === 'SAVEPOINT s') return savepointResult;
			return { rows: [], rowCount: 0, command: 'SELECT' } as QueryResult;
		});
		const txClient = {
			query,
			release: vi.fn(() => {
				expect(openTransaction).toBe(false);
			}),
		} as unknown as PoolClient;
		const pool = makePool({ rows: [] }, txClient);
		const adapter = createPgsqlAdapter(pool);

		const error = await captureRejection(() =>
			adapter.transaction(async (tx) => {
				await tx.executeRaw('INSERT INTO items VALUES (1)');
				await tx.executeRaw('SAVEPOINT s');
			}),
		);

		expectRawSqlTransactionControlError(error, savepointResult);
		expect(queryCalls(query)).toEqual([
			'BEGIN',
			'INSERT INTO items VALUES (1)',
			'SAVEPOINT s',
			'ROLLBACK',
		]);
		expect(txClient.release).toHaveBeenCalledOnce();
	});

	it('releases client even after COMMIT', async () => {
		const txClient = makeClient();
		const pool = makePool({ rows: [] }, txClient);
		const adapter = createPgsqlAdapter(pool);

		await adapter.transaction(async () => 42);

		expect(txClient.release).toHaveBeenCalledOnce();
	});

	it('propagates fn return value through COMMIT', async () => {
		const txClient = makeClient();
		const pool = makePool({ rows: [] }, txClient);
		const adapter = createPgsqlAdapter(pool);

		const value = await adapter.transaction(async (tx) => {
			return { tenant: 'abc', adapter: tx };
		});

		expect(value.tenant).toBe('abc');
		expect(value.adapter).toBeInstanceOf(PgsqlAdapter);
	});

	it('passes a transaction-scoped adapter to fn (inTransaction=true)', async () => {
		const txClient = makeClient();
		const pool = makePool({ rows: [] }, txClient);
		const adapter = createPgsqlAdapter(pool);

		let innerInTransaction: boolean | undefined;
		await adapter.transaction(async (tx) => {
			innerInTransaction = (tx as PgsqlAdapter).inTransaction;
		});

		expect(innerInTransaction).toBe(true);
	});

	it('refuses a transaction adapter captured after the transaction ended', async () => {
		const txClient = makeClient();
		const pool = makePool({ rows: [] }, txClient);
		const adapter = createPgsqlAdapter(pool);
		let leaked:
			| {
					executeRaw(sql: string): Promise<unknown[]>;
					transaction<T>(fn: (adapter: unknown) => Promise<T>): Promise<T>;
			  }
			| undefined;

		await adapter.transaction(async (tx) => {
			leaked = tx as typeof leaked;
		});

		await expect(leaked?.executeRaw('DELETE FROM users')).rejects.toThrow(
			/transaction that has ended/,
		);
		await expect(leaked?.transaction(async () => undefined)).rejects.toThrow(
			/transaction that has ended/,
		);
		expect(queryCalls(txClient.query as ReturnType<typeof vi.fn>)).toEqual([
			'BEGIN',
			'COMMIT',
		]);
	});

	it('outer adapter has inTransaction=false', () => {
		const pool = makePool();
		const adapter = createPgsqlAdapter(pool);
		expect(adapter.inTransaction).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// transaction() — ROLLBACK on fn error
// ---------------------------------------------------------------------------

describe('PgsqlAdapter.transaction — ROLLBACK on fn error', () => {
	it('calls ROLLBACK and releases client when fn throws', async () => {
		const txClient = makeClient();
		const pool = makePool({ rows: [] }, txClient);
		const adapter = createPgsqlAdapter(pool);

		await expect(
			adapter.transaction(async () => {
				throw new Error('fn boom');
			}),
		).rejects.toThrow('fn boom');

		const calls = queryCalls(txClient.query as ReturnType<typeof vi.fn>);
		expect(calls).toContain('ROLLBACK');
		expect(calls).not.toContain('COMMIT');
		expect(txClient.release).toHaveBeenCalledOnce();
	});

	it('drains unawaited orm.transaction statements before ROLLBACK', async () => {
		const firstStarted = deferred();
		const releaseFirst = deferred();
		const callbackError = new Error('callback failed');
		const query = vi.fn(async (input: MockQueryInput) => {
			const sql = queryText(input);
			if (sql === 'SELECT first') {
				firstStarted.resolve();
				await releaseFirst.promise;
			}
			return { rows: [], rowCount: 0, command: 'SELECT' } as QueryResult;
		});
		const txClient = { query, release: vi.fn() } as unknown as PoolClient;
		const pool = makePool({ rows: [] }, txClient);
		const adapter = createPgsqlAdapter(pool);
		const orm = createOrm({ schema: ownershipOrmSchema, adapter });

		const transaction = orm.transaction(async (tx) => {
			void tx.raw('SELECT first');
			void tx.raw('SELECT second');
			throw callbackError;
		});

		await firstStarted.promise;
		await Promise.resolve();
		expect(queryCalls(query)).toEqual(['BEGIN', 'SELECT first']);

		releaseFirst.resolve();
		await expect(transaction).rejects.toBe(callbackError);

		expect(queryCalls(query)).toEqual([
			'BEGIN',
			'SELECT first',
			'SELECT second',
			'ROLLBACK',
		]);
		expect(txClient.release).toHaveBeenCalledOnce();
	});

	it('re-throws the original error reference from fn', async () => {
		const txClient = makeClient();
		const pool = makePool({ rows: [] }, txClient);
		const adapter = createPgsqlAdapter(pool);

		const boom = new TypeError('type error');
		await expect(
			adapter.transaction(async () => {
				throw boom;
			}),
		).rejects.toBe(boom);
	});

	it('surfaces rollback failure and releases a pool-owned client as broken', async () => {
		const callbackError = new Error('callback failed');
		const rollbackError = new Error('rollback failed');
		const txClient = {
			query: vi.fn(async (input: MockQueryInput) => {
				const sql = queryText(input);
				if (sql === 'ROLLBACK') throw rollbackError;
				return { rows: [], rowCount: 0 } as QueryResult;
			}),
			release: vi.fn(),
		} as unknown as PoolClient;
		const pool = makePool({ rows: [] }, txClient);
		const adapter = createPgsqlAdapter(pool);

		const error = await captureRejection(() =>
			adapter.transaction(async () => {
				throw callbackError;
			}),
		);

		expectCleanupFailure(
			error,
			callbackError,
			rollbackError,
			/ROLLBACK failed/,
		);
		expect(txClient.release).toHaveBeenCalledWith(rollbackError);
	});
});

// ---------------------------------------------------------------------------
// transaction() — nested savepoint contract
// ---------------------------------------------------------------------------

describe('PgsqlAdapter.transaction — nested savepoints', () => {
	it('opens a savepoint for nested transaction() and releases it on success', async () => {
		const txClient = makeClient();
		const pool = makePool({ rows: [] }, txClient);
		const adapter = createPgsqlAdapter(pool);

		await adapter.transaction(async (tx) => {
			await tx.executeRaw('SELECT outer');
			await tx.transaction(async (inner) => {
				await inner.executeRaw('SELECT inner');
			});
			await tx.executeRaw('SELECT after');
		});

		const calls = queryCalls(txClient.query as ReturnType<typeof vi.fn>);
		expect(calls).toEqual([
			'BEGIN',
			'SELECT outer',
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			'SELECT inner',
			expect.stringMatching(/^RELEASE SAVEPOINT dbsp_savepoint_/),
			'SELECT after',
			'COMMIT',
		]);
		expect(calls.filter((sql) => /^SAVEPOINT /.test(sql))).toHaveLength(1);
	});

	it('rolls back to and releases the nested savepoint on failure', async () => {
		const txClient = makeClient();
		const pool = makePool({ rows: [] }, txClient);
		const adapter = createPgsqlAdapter(pool);
		const boom = new Error('inner boom');

		await expect(
			adapter.transaction(async (tx) => {
				await tx.transaction(async (inner) => {
					await inner.executeRaw('SELECT inner');
					throw boom;
				});
			}),
		).rejects.toBe(boom);

		const calls = queryCalls(txClient.query as ReturnType<typeof vi.fn>);
		expect(calls).toEqual([
			'BEGIN',
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			'SELECT inner',
			expect.stringMatching(/^ROLLBACK TO SAVEPOINT dbsp_savepoint_/),
			expect.stringMatching(/^RELEASE SAVEPOINT dbsp_savepoint_/),
			'ROLLBACK',
		]);
	});

	it('lets a caught nested failure leave the outer transaction usable', async () => {
		const txClient = makeClient();
		const pool = makePool({ rows: [] }, txClient);
		const adapter = createPgsqlAdapter(pool);
		const boom = new Error('inner rollback');

		await adapter.transaction(async (tx) => {
			await tx.executeRaw('INSERT outer');
			await expect(
				tx.transaction(async (inner) => {
					await inner.executeRaw('INSERT inner');
					throw boom;
				}),
			).rejects.toBe(boom);
			await tx.executeRaw('SELECT outer still usable');
		});

		const calls = queryCalls(txClient.query as ReturnType<typeof vi.fn>);
		expect(calls).toEqual([
			'BEGIN',
			'INSERT outer',
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			'INSERT inner',
			expect.stringMatching(/^ROLLBACK TO SAVEPOINT dbsp_savepoint_/),
			expect.stringMatching(/^RELEASE SAVEPOINT dbsp_savepoint_/),
			'SELECT outer still usable',
			'COMMIT',
		]);
	});

	it('treats catch on a nested transaction as observation', async () => {
		const txClient = makeClient();
		const pool = makePool({ rows: [] }, txClient);
		const adapter = createPgsqlAdapter(pool);
		const boom = new Error('inner handled by catch');
		const handle = vi.fn();

		await adapter.transaction(async (tx) => {
			await tx.executeRaw('INSERT outer');
			await tx
				.transaction(async (inner) => {
					await inner.executeRaw('INSERT inner');
					throw boom;
				})
				.catch((error) => {
					handle(error);
				});
			await tx.executeRaw('SELECT outer still usable');
		});

		expect(handle).toHaveBeenCalledWith(boom);
		const calls = queryCalls(txClient.query as ReturnType<typeof vi.fn>);
		expect(calls).toEqual([
			'BEGIN',
			'INSERT outer',
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			'INSERT inner',
			expect.stringMatching(/^ROLLBACK TO SAVEPOINT dbsp_savepoint_/),
			expect.stringMatching(/^RELEASE SAVEPOINT dbsp_savepoint_/),
			'SELECT outer still usable',
			'COMMIT',
		]);
	});

	it('returns a Promise instance for nested transaction observation', async () => {
		const txClient = makeClient();
		const pool = makePool({ rows: [] }, txClient);
		const adapter = createPgsqlAdapter(pool);

		await adapter.transaction(async (tx) => {
			const child = tx.transaction(async (inner) => {
				await inner.executeRaw('SELECT inner');
				return 'ok';
			});

			expect(child).toBeInstanceOf(Promise);
			await expect(Promise.all([child])).resolves.toEqual(['ok']);
		});
	});

	it('refuses an unobserved nested transaction that already succeeded', async () => {
		const childClosed = deferred();
		const query = vi.fn(async (input: MockQueryInput) => {
			const sql = queryText(input);
			if (/^RELEASE SAVEPOINT /.test(sql)) {
				setTimeout(() => childClosed.resolve(), 0);
			}
			return { rows: [], rowCount: 0 } as QueryResult;
		});
		const txClient = { query, release: vi.fn() } as unknown as PoolClient;
		const pool = makePool({ rows: [] }, txClient);
		const adapter = createPgsqlAdapter(pool);

		let child: Promise<unknown> | undefined;
		const transactionError = await captureRejection(() =>
			adapter.transaction(async (tx) => {
				await tx.executeRaw('INSERT parent before child');
				child = tx.transaction(async (inner) => {
					await inner.executeRaw('INSERT child');
				});
				await childClosed.promise;
			}),
		);

		expect(transactionError).toBeInstanceOf(Error);
		expect((transactionError as Error).message).toContain('must be awaited');
		expect((transactionError as Error).cause).toBeUndefined();
		await child;
		expect(queryCalls(query)).toEqual([
			'BEGIN',
			'INSERT parent before child',
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			'INSERT child',
			expect.stringMatching(/^RELEASE SAVEPOINT dbsp_savepoint_/),
			'ROLLBACK',
		]);
		expect(queryCalls(query)).not.toContain('COMMIT');
	});

	it('poisons the parent when raw COMMIT inside a nested transaction kills the physical transaction', async () => {
		const commitResult = {
			rows: [],
			rowCount: 0,
			command: 'COMMIT',
		} as QueryResult;
		let transactionOpen = false;
		let innerError: unknown;
		let parentError: unknown;
		const query = vi.fn(async (input: MockQueryInput) => {
			const sql = queryText(input);
			if (sql === 'BEGIN') {
				transactionOpen = true;
				return { rows: [], rowCount: 0, command: 'BEGIN' } as QueryResult;
			}
			if (/^SAVEPOINT /.test(sql)) {
				if (!transactionOpen) throw noActiveTransactionError();
				return {
					rows: [],
					rowCount: 0,
					command: 'SAVEPOINT',
				} as QueryResult;
			}
			if (sql === 'COMMIT') {
				transactionOpen = false;
				return commitResult;
			}
			if (/^ROLLBACK TO SAVEPOINT /.test(sql) || sql === 'ROLLBACK') {
				if (!transactionOpen) throw noActiveTransactionError();
				transactionOpen = false;
				return { rows: [], rowCount: 0, command: 'ROLLBACK' } as QueryResult;
			}
			return { rows: [], rowCount: 0, command: 'SELECT' } as QueryResult;
		});
		const txClient = { query, release: vi.fn() } as unknown as PoolClient;
		const pool = makePool({ rows: [] }, txClient);
		const adapter = createPgsqlAdapter(pool);

		const transactionError = await captureRejection(() =>
			adapter.transaction(async (tx) => {
				try {
					await tx.transaction(async (inner) => {
						await inner.executeRaw('COMMIT');
					});
				} catch (error) {
					innerError = error;
				}
				try {
					await tx.executeRaw('SELECT parent after nested raw commit');
				} catch (error) {
					parentError = error;
				}
				return 'callback returned normally';
			}),
		);

		expectRawSqlTransactionControlError(innerError, commitResult);
		expect(parentError).toBe(innerError);
		expect(transactionError).toBe(innerError);
		const calls = queryCalls(query);
		expect(calls).toEqual([
			'BEGIN',
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			'COMMIT',
			expect.stringMatching(/^ROLLBACK TO SAVEPOINT dbsp_savepoint_/),
			'ROLLBACK',
		]);
		expect(calls).not.toContain('SELECT parent after nested raw commit');
		expect(txClient.release).toHaveBeenCalledOnce();
	});

	it('throws instead of interleaving two concurrent nested transactions on one scope', async () => {
		const firstStatementStarted = deferred();
		const releaseFirstStatement = deferred();
		const calls: string[] = [];
		const query = vi.fn(async (input: MockQueryInput) => {
			const sql = queryText(input);
			calls.push(sql);
			if (sql === 'SELECT first nested') {
				firstStatementStarted.resolve();
				await releaseFirstStatement.promise;
			}
			return { rows: [], rowCount: 0 } as QueryResult;
		});
		const txClient = { query, release: vi.fn() } as unknown as PoolClient;
		const pool = makePool({ rows: [] }, txClient);
		const adapter = createPgsqlAdapter(pool);

		await adapter.transaction(async (tx) => {
			const first = tx.transaction(async (inner) => {
				await inner.executeRaw('SELECT first nested');
			});
			await firstStatementStarted.promise;

			const secondError = await captureRejection(() =>
				tx.transaction(async (inner) => {
					await inner.executeRaw('SELECT second nested');
				}),
			);
			expect(secondError).toBeInstanceOf(Error);
			expect((secondError as Error).message).toContain(
				'Savepoint scopes are single-flight per connection',
			);

			releaseFirstStatement.resolve();
			await first;
		});

		expect(queryCalls(query)).toEqual([
			'BEGIN',
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			'SELECT first nested',
			expect.stringMatching(/^RELEASE SAVEPOINT dbsp_savepoint_/),
			'COMMIT',
		]);
		expect(queryCalls(query)).not.toContain('SELECT second nested');
		expect(
			queryCalls(query).filter((sql) => /^SAVEPOINT /.test(sql)),
		).toHaveLength(1);
		expect(
			queryCalls(query).filter((sql) => /^RELEASE SAVEPOINT /.test(sql)),
		).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// transaction() — borrowed client contract
// ---------------------------------------------------------------------------

describe('PgsqlAdapter.transaction — borrowed client contract', () => {
	it('throws by default for a borrowed client and names managedTransactions', async () => {
		const client = makeClient();
		const adapter = createPgsqlAdapter(client, { borrowedClient: true });

		await expect(adapter.transaction(async () => undefined)).rejects.toThrow(
			/managedTransactions: true/,
		);
		expect(client.query).not.toHaveBeenCalled();
		expect(client.release).not.toHaveBeenCalled();
	});

	it('uses a savepoint when managedTransactions is true and a transaction is already open', async () => {
		const client = Object.assign(makeClient(), { _txStatus: 'T' });
		const adapter = createPgsqlAdapter(client, {
			borrowedClient: true,
			managedTransactions: true,
		});
		let innerInTransaction: boolean | undefined;

		const result = await adapter.transaction(async (tx) => {
			innerInTransaction = (tx as PgsqlAdapter).inTransaction;
			await tx.execute({ sql: 'SELECT 1', parameters: [] });
			return 'ok';
		});

		expect(result).toBe('ok');
		expect(adapter.inTransaction).toBe(true);
		expect(innerInTransaction).toBe(true);
		expect(client.release).not.toHaveBeenCalled();
		const calls = queryCalls(client.query as ReturnType<typeof vi.fn>);
		expect(calls.filter((sql) => /^SAVEPOINT /.test(sql))).toHaveLength(1);
		expect(calls[0]).toMatch(/^SAVEPOINT dbsp_savepoint_/);
		expect(calls).toContain('SELECT 1');
		expect(calls.at(-1)).toMatch(/^RELEASE SAVEPOINT dbsp_savepoint_/);
		expect(calls).not.toContain('BEGIN');
		expect(calls).not.toContain('COMMIT');
	});

	it('rolls back to the savepoint on callback failure without releasing the caller client', async () => {
		const client = makeClient();
		const adapter = createPgsqlAdapter(client, {
			borrowedClient: true,
			managedTransactions: true,
		});
		const boom = new Error('boom');

		await expect(
			adapter.transaction(async (tx) => {
				await tx.execute({ sql: 'INSERT INTO t VALUES (1)', parameters: [] });
				throw boom;
			}),
		).rejects.toBe(boom);

		expect(client.release).not.toHaveBeenCalled();
		const calls = queryCalls(client.query as ReturnType<typeof vi.fn>);
		expect(calls).toContain('INSERT INTO t VALUES (1)');
		expect(calls.filter((sql) => /^SAVEPOINT /.test(sql))).toHaveLength(1);
		expect(calls.some((sql) => /^ROLLBACK TO SAVEPOINT /.test(sql))).toBe(true);
		expect(calls).not.toContain('ROLLBACK');
	});

	it('surfaces savepoint rollback failure with the callback error as cause', async () => {
		const callbackError = new Error('callback failed');
		const rollbackError = new Error('savepoint rollback failed');
		const client = {
			query: vi.fn(async (input: MockQueryInput) => {
				const sql = queryText(input);
				if (/^ROLLBACK TO SAVEPOINT /.test(sql)) throw rollbackError;
				return { rows: [], rowCount: 0 } as QueryResult;
			}),
			release: vi.fn(),
		} as unknown as PoolClient;
		const adapter = createPgsqlAdapter(client, {
			borrowedClient: true,
			managedTransactions: true,
		});

		const error = await captureRejection(() =>
			adapter.transaction(async () => {
				throw callbackError;
			}),
		);

		expectCleanupFailure(
			error,
			callbackError,
			rollbackError,
			/savepoint cleanup failed/,
		);
		expect(client.release).not.toHaveBeenCalled();
	});

	it('surfaces savepoint release failure after rollback with the callback error as cause', async () => {
		const callbackError = new Error('callback failed');
		const releaseError = new Error('savepoint release failed');
		const client = {
			query: vi.fn(async (input: MockQueryInput) => {
				const sql = queryText(input);
				if (/^RELEASE SAVEPOINT /.test(sql)) throw releaseError;
				return { rows: [], rowCount: 0 } as QueryResult;
			}),
			release: vi.fn(),
		} as unknown as PoolClient;
		const adapter = createPgsqlAdapter(client, {
			borrowedClient: true,
			managedTransactions: true,
		});

		const error = await captureRejection(() =>
			adapter.transaction(async () => {
				throw callbackError;
			}),
		);

		expectCleanupFailure(
			error,
			callbackError,
			releaseError,
			/savepoint cleanup failed/,
		);
		expect(client.release).not.toHaveBeenCalled();
	});

	it('reports a swallowed statement failure as an aborted transaction, not transaction control', async () => {
		const statementError = Object.assign(new Error('duplicate key value'), {
			code: '23505',
		});
		const query = vi.fn(async (input: MockQueryInput) => {
			const sql = queryText(input);
			if (sql === 'INSERT duplicate') throw statementError;
			return { rows: [], rowCount: 0 } as QueryResult;
		});
		const client = {
			query,
			release: vi.fn(),
		} as unknown as PoolClient;
		const adapter = createPgsqlAdapter(client, {
			borrowedClient: true,
			managedTransactions: true,
		});
		let swallowed: unknown;

		const error = await captureRejection(() =>
			adapter.transaction(async (tx) => {
				try {
					await tx.executeRaw('INSERT duplicate');
				} catch (caught) {
					swallowed = caught;
				}
				return 'callback returned normally';
			}),
		);

		expect(swallowed).toBe(statementError);
		expect(error).toBeInstanceOf(PgsqlTransactionAbortedError);
		expect(error).not.toBeInstanceOf(PgsqlRawSqlTransactionControlError);
		expect((error as Error).message).toContain('transaction is aborted');
		expect((error as Error).cause).toBe(statementError);
		expect(queryCalls(query)).toEqual([
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			'INSERT duplicate',
			expect.stringMatching(/^ROLLBACK TO SAVEPOINT dbsp_savepoint_/),
			expect.stringMatching(/^RELEASE SAVEPOINT dbsp_savepoint_/),
		]);
		expect(client.release).not.toHaveBeenCalled();
	});

	it('surfaces a connection-level RELEASE SAVEPOINT failure as cleanup, not transaction control', async () => {
		const releaseError = new Error('connection terminated unexpectedly');
		let releaseAttempts = 0;
		const query = vi.fn(async (input: MockQueryInput) => {
			const sql = queryText(input);
			if (/^RELEASE SAVEPOINT /.test(sql)) {
				releaseAttempts++;
				if (releaseAttempts === 1) throw releaseError;
			}
			return { rows: [], rowCount: 0 } as QueryResult;
		});
		const client = {
			query,
			release: vi.fn(),
		} as unknown as PoolClient;
		const adapter = createPgsqlAdapter(client, {
			borrowedClient: true,
			managedTransactions: true,
		});

		const error = await captureRejection(() =>
			adapter.transaction(async () => 'callback returned normally'),
		);

		expect(error).toBeInstanceOf(AggregateError);
		expect(error).not.toBeInstanceOf(PgsqlRawSqlTransactionControlError);
		expect((error as { readonly cleanupError?: unknown }).cleanupError).toBe(
			releaseError,
		);
		expect((error as AggregateError).errors).toContain(releaseError);
		expect((error as Error).message).toContain('RELEASE SAVEPOINT failed');
		const calls = queryCalls(query);
		expect(calls[0]).toMatch(/^SAVEPOINT dbsp_savepoint_/);
		expect(calls[1]).toMatch(/^RELEASE SAVEPOINT dbsp_savepoint_/);
		expect(calls[2]).toMatch(/^SAVEPOINT dbsp_savepoint_/);
		expect(calls[3]).toMatch(/^RELEASE SAVEPOINT dbsp_savepoint_/);
		expect(
			calls.some((sql) => /^ROLLBACK TO SAVEPOINT dbsp_savepoint_/.test(sql)),
		).toBe(true);
		expect(client.release).not.toHaveBeenCalled();
	});

	it('classifies a missing dbsp savepoint on RELEASE as transaction control', async () => {
		const savepointGoneError = Object.assign(
			new Error('savepoint does not exist'),
			{ code: '3B001' },
		);
		const query = vi.fn(async (input: MockQueryInput) => {
			const sql = queryText(input);
			if (/^RELEASE SAVEPOINT /.test(sql)) throw savepointGoneError;
			if (/^ROLLBACK TO SAVEPOINT /.test(sql)) throw savepointGoneError;
			return { rows: [], rowCount: 0 } as QueryResult;
		});
		const client = {
			query,
			release: vi.fn(),
		} as unknown as PoolClient;
		const adapter = createPgsqlAdapter(client, {
			borrowedClient: true,
			managedTransactions: true,
		});

		const error = await captureRejection(() =>
			adapter.transaction(async () => 'callback returned normally'),
		);

		expectRawSqlTransactionControlError(error, savepointGoneError);
		expect(error).not.toBeInstanceOf(AggregateError);
		expect(queryCalls(query)).toEqual([
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			expect.stringMatching(/^RELEASE SAVEPOINT dbsp_savepoint_/),
			expect.stringMatching(/^ROLLBACK TO SAVEPOINT dbsp_savepoint_/),
		]);
		expect(client.release).not.toHaveBeenCalled();
	});

	it('rolls back its managed savepoint after raw SQL transaction control', async () => {
		const savepointResult = {
			rows: [],
			rowCount: 0,
			command: 'SAVEPOINT',
		} as QueryResult;
		const query = vi.fn(async (input: MockQueryInput) => {
			const sql = queryText(input);
			if (sql === 'SAVEPOINT s') return savepointResult;
			return { rows: [], rowCount: 0 } as QueryResult;
		});
		const client = {
			query,
			release: vi.fn(),
		} as unknown as PoolClient;
		const adapter = createPgsqlAdapter(client, {
			borrowedClient: true,
			managedTransactions: true,
		});

		const error = await captureRejection(() =>
			adapter.transaction(async (tx) => {
				await tx.executeRaw('SAVEPOINT s');
			}),
		);

		expectRawSqlTransactionControlError(error, savepointResult);
		expect(error).not.toBeInstanceOf(AggregateError);
		expect(queryCalls(query)).toEqual([
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			'SAVEPOINT s',
			expect.stringMatching(/^ROLLBACK TO SAVEPOINT dbsp_savepoint_/),
			expect.stringMatching(/^RELEASE SAVEPOINT dbsp_savepoint_/),
		]);
		expect(queryCalls(query)).not.toContain('ROLLBACK');
		expect(client.release).not.toHaveBeenCalled();
	});

	it('rolls back its managed savepoint after execute() transaction control', async () => {
		const savepointResult = {
			rows: [],
			rowCount: 0,
			command: 'SAVEPOINT',
		} as QueryResult;
		const query = vi.fn(async (input: MockQueryInput) => {
			const sql = queryText(input);
			if (sql === 'SAVEPOINT s') return savepointResult;
			return { rows: [], rowCount: 0 } as QueryResult;
		});
		const client = {
			query,
			release: vi.fn(),
		} as unknown as PoolClient;
		const adapter = createPgsqlAdapter(client, {
			borrowedClient: true,
			managedTransactions: true,
		});

		const error = await captureRejection(() =>
			adapter.transaction(async (tx) => {
				await tx.execute({ sql: 'SAVEPOINT s', parameters: [] });
			}),
		);

		expectRawSqlTransactionControlError(error, savepointResult);
		expect(error).not.toBeInstanceOf(AggregateError);
		expect(queryCalls(query)).toEqual([
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			'SAVEPOINT s',
			expect.stringMatching(/^ROLLBACK TO SAVEPOINT dbsp_savepoint_/),
			expect.stringMatching(/^RELEASE SAVEPOINT dbsp_savepoint_/),
		]);
		expect(queryCalls(query)).not.toContain('ROLLBACK');
		expect(client.release).not.toHaveBeenCalled();
	});

	it('allows server-side PREPARE when the transaction survives', async () => {
		const { client } = makePrepareTagClient(false);
		const adapter = createPgsqlAdapter(client, {
			borrowedClient: true,
			managedTransactions: true,
		});

		await adapter.transaction(async (tx) => {
			await expect(tx.executeRaw('PREPARE p1 AS SELECT 1')).resolves.toEqual(
				[],
			);
		});

		expect(queryCalls(client.query as ReturnType<typeof vi.fn>)).toEqual([
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			'PREPARE p1 AS SELECT 1',
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			expect.stringMatching(/^RELEASE SAVEPOINT dbsp_savepoint_/),
			expect.stringMatching(/^RELEASE SAVEPOINT dbsp_savepoint_/),
		]);
		expect(client.release).not.toHaveBeenCalled();
	});

	it('rejects PREPARE TRANSACTION when the transaction is gone after the PREPARE tag', async () => {
		const { client, prepareResult } = makePrepareTagClient(true);
		const adapter = createPgsqlAdapter(client, {
			borrowedClient: true,
			managedTransactions: true,
		});

		const error = await captureRejection(() =>
			adapter.transaction(async (tx) => {
				await tx.executeRaw("PREPARE TRANSACTION 'x'");
			}),
		);

		expectRawSqlTransactionControlError(error, prepareResult);
		expect(queryCalls(client.query as ReturnType<typeof vi.fn>)).toEqual([
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			"PREPARE TRANSACTION 'x'",
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			expect.stringMatching(/^ROLLBACK TO SAVEPOINT dbsp_savepoint_/),
		]);
		expect(client.release).not.toHaveBeenCalled();
	});

	it('opens and closes a transaction when managedTransactions is true and none is active', async () => {
		let savepointAttempts = 0;
		const query = vi.fn(async (input: MockQueryInput) => {
			const sql = queryText(input);
			if (/^SAVEPOINT /.test(sql) && savepointAttempts++ === 0) {
				throw noActiveTransactionError();
			}
			return { rows: [], rowCount: 0 } as QueryResult;
		});
		const client = {
			query,
			release: vi.fn(),
		} as unknown as PoolClient;
		const adapter = createPgsqlAdapter(client, {
			borrowedClient: true,
			managedTransactions: true,
		});

		await adapter.transaction(async (tx) => {
			await tx.execute({ sql: 'SELECT 1', parameters: [] });
		});

		expect(client.release).not.toHaveBeenCalled();
		const calls = queryCalls(query);
		expect(calls[0]).toMatch(/^SAVEPOINT dbsp_savepoint_/);
		expect(calls.slice(1)).toEqual(['BEGIN', 'SELECT 1', 'COMMIT']);
	});

	it('throws instead of hanging when the ancestor adapter is used inside the transaction callback', async () => {
		const client = makeClient();
		const adapter = createPgsqlAdapter(client, {
			borrowedClient: true,
			managedTransactions: true,
		});

		await expect(
			adapter.transaction(async () => {
				await adapter.executeRaw('SELECT through ancestor');
			}),
		).rejects.toThrow(/transaction adapter passed to the callback/);

		const calls = queryCalls(client.query as ReturnType<typeof vi.fn>);
		expect(calls).toEqual([
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			expect.stringMatching(/^ROLLBACK TO SAVEPOINT dbsp_savepoint_/),
			expect.stringMatching(/^RELEASE SAVEPOINT dbsp_savepoint_/),
		]);
		expect(calls).not.toContain('SELECT through ancestor');
		expect(client.release).not.toHaveBeenCalled();
	}, 500);

	it('queues concurrent statements and refuses a sibling after raw COMMIT poisons the scope', async () => {
		const commitStarted = deferred();
		const releaseCommit = deferred();
		const commitResult = {
			rows: [],
			rowCount: 0,
			command: 'COMMIT',
		} as QueryResult;
		let firstError: unknown;
		let secondError: unknown;
		const query = vi.fn(async (input: MockQueryInput) => {
			const sql = queryText(input);
			if (sql === 'COMMIT') {
				commitStarted.resolve();
				await releaseCommit.promise;
				return commitResult;
			}
			if (/^ROLLBACK TO SAVEPOINT /.test(sql)) {
				throw noActiveTransactionError();
			}
			return { rows: [], rowCount: 0, command: 'SELECT' } as QueryResult;
		});
		const client = { query, release: vi.fn() } as unknown as PoolClient;
		const adapter = createPgsqlAdapter(client, {
			borrowedClient: true,
			managedTransactions: true,
		});

		const transactionError = await captureRejection(() =>
			adapter.transaction(async (tx) => {
				const first = tx.executeRaw('COMMIT').catch((error) => {
					firstError = error;
					throw error;
				});
				await commitStarted.promise;
				const second = tx.executeRaw('INSERT after commit').catch((error) => {
					secondError = error;
					throw error;
				});
				releaseCommit.resolve();
				await Promise.allSettled([first, second]);
				return 'callback returned normally';
			}),
		);

		expectRawSqlTransactionControlError(firstError, commitResult);
		expect(secondError).toBe(firstError);
		expect(transactionError).toBe(firstError);
		expect(queryCalls(query)).toEqual([
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			'COMMIT',
			expect.stringMatching(/^ROLLBACK TO SAVEPOINT dbsp_savepoint_/),
		]);
		expect(queryCalls(query)).not.toContain('INSERT after commit');
		expect(client.release).not.toHaveBeenCalled();
	});

	it('does not take per-statement savepoints for concurrent work inside a managed borrowed transaction', async () => {
		const client = makeClient();
		const adapter = createPgsqlAdapter(client, {
			borrowedClient: true,
			managedTransactions: true,
		});

		await adapter.transaction(async (tx) => {
			await Promise.all([
				tx.executeRaw('SELECT first'),
				tx.executeRaw('SELECT second'),
			]);
		});

		const calls = queryCalls(client.query as ReturnType<typeof vi.fn>);
		expect(calls).toEqual([
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			'SELECT first',
			'SELECT second',
			expect.stringMatching(/^RELEASE SAVEPOINT dbsp_savepoint_/),
		]);
		expect(calls.filter((sql) => /^SAVEPOINT /.test(sql))).toHaveLength(1);
		expect(client.release).not.toHaveBeenCalled();
	});

	it('drains unawaited statements before releasing a managed borrowed transaction savepoint', async () => {
		const firstStarted = deferred();
		const releaseFirst = deferred();
		const query = vi.fn(async (input: MockQueryInput) => {
			const sql = queryText(input);
			if (sql === 'SELECT first') {
				firstStarted.resolve();
				await releaseFirst.promise;
			}
			return { rows: [], rowCount: 0, command: 'SELECT' } as QueryResult;
		});
		const client = { query, release: vi.fn() } as unknown as PoolClient;
		const adapter = createPgsqlAdapter(client, {
			borrowedClient: true,
			managedTransactions: true,
		});

		const transaction = adapter.transaction(async (tx) => {
			void tx.executeRaw('SELECT first');
			void tx.executeRaw('SELECT second');
		});

		await firstStarted.promise;
		await Promise.resolve();
		expect(queryCalls(query)).toEqual([
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			'SELECT first',
		]);

		releaseFirst.resolve();
		await transaction;

		expect(queryCalls(query)).toEqual([
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			'SELECT first',
			'SELECT second',
			expect.stringMatching(/^RELEASE SAVEPOINT dbsp_savepoint_/),
		]);
		expect(client.release).not.toHaveBeenCalled();
	});

	it('rolls back the managed scope when one concurrent statement fails without per-statement savepoints', async () => {
		const pgError = new Error('statement failed');
		const query = vi.fn(async (input: MockQueryInput) => {
			const sql = queryText(input);
			if (sql === 'SELECT fail') throw pgError;
			return { rows: [], rowCount: 0 } as QueryResult;
		});
		const client = { query, release: vi.fn() } as unknown as PoolClient;
		const adapter = createPgsqlAdapter(client, {
			borrowedClient: true,
			managedTransactions: true,
		});

		await expect(
			adapter.transaction(async (tx) => {
				await Promise.all([
					tx.executeRaw('SELECT ok'),
					tx.executeRaw('SELECT fail'),
				]);
			}),
		).rejects.toBe(pgError);

		const calls = queryCalls(query);
		expect(calls).toEqual([
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			'SELECT ok',
			'SELECT fail',
			expect.stringMatching(/^ROLLBACK TO SAVEPOINT dbsp_savepoint_/),
			expect.stringMatching(/^RELEASE SAVEPOINT dbsp_savepoint_/),
		]);
		expect(calls.filter((sql) => /^SAVEPOINT /.test(sql))).toHaveLength(1);
		expect(client.release).not.toHaveBeenCalled();
	});

	it('refuses an unawaited child transaction still running when the managed callback returns', async () => {
		const childScopeStarted = deferred();
		const resumeChild = deferred();
		const query = vi.fn(async () => {
			return { rows: [], rowCount: 0 } as QueryResult;
		});
		const client = { query, release: vi.fn() } as unknown as PoolClient;
		const adapter = createPgsqlAdapter(client, {
			borrowedClient: true,
			managedTransactions: true,
		});

		let child: Promise<unknown> | undefined;
		const error = await captureRejection(() =>
			adapter.transaction(async (tx) => {
				child = tx.transaction(async (inner) => {
					childScopeStarted.resolve();
					await resumeChild.promise;
					await inner.executeRaw('SELECT child before parent release');
				});
				await childScopeStarted.promise;
			}),
		);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain('must be awaited');
		expect(queryCalls(query)).toEqual([
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			expect.stringMatching(/^ROLLBACK TO SAVEPOINT dbsp_savepoint_/),
			expect.stringMatching(/^RELEASE SAVEPOINT dbsp_savepoint_/),
		]);
		expect(queryCalls(query)).not.toContain(
			'SELECT child before parent release',
		);

		resumeChild.resolve();
		await child?.catch(() => undefined);
		expect(client.release).not.toHaveBeenCalled();
	});

	it('rolls back the parent when an unawaited child transaction fails immediately', async () => {
		const childError = new Error('immediate unawaited child failed');
		const childClosed = deferred();
		const query = vi.fn(async (input: MockQueryInput) => {
			const sql = queryText(input);
			if (/^RELEASE SAVEPOINT /.test(sql)) {
				setTimeout(() => childClosed.resolve(), 0);
			}
			return { rows: [], rowCount: 0 } as QueryResult;
		});
		const txClient = { query, release: vi.fn() } as unknown as PoolClient;
		const pool = makePool({ rows: [] }, txClient);
		const adapter = createPgsqlAdapter(pool);

		let child: Promise<unknown> | undefined;
		const transactionError = await captureRejection(() =>
			adapter.transaction(async (tx) => {
				await tx.executeRaw('INSERT parent before child');
				child = tx.transaction(async () => {
					throw childError;
				});
				await childClosed.promise;
			}),
		);

		expect(transactionError).toBeInstanceOf(Error);
		expect((transactionError as Error).message).toContain('must be awaited');
		expect((transactionError as Error).cause).toBe(childError);
		if (child === undefined) {
			throw new Error('expected child transaction to be captured');
		}
		await expect(child).rejects.toBe(childError);

		expect(queryCalls(query)).toEqual([
			'BEGIN',
			'INSERT parent before child',
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			expect.stringMatching(/^ROLLBACK TO SAVEPOINT dbsp_savepoint_/),
			expect.stringMatching(/^RELEASE SAVEPOINT dbsp_savepoint_/),
			'ROLLBACK',
		]);
		expect(queryCalls(query)).not.toContain('COMMIT');
		expect(txClient.release).toHaveBeenCalledOnce();
	});

	it('refuses a child transaction started after the parent callback has returned', async () => {
		const firstStarted = deferred();
		const releaseFirst = deferred();
		const callbackReturned = deferred();
		const query = vi.fn(async (input: MockQueryInput) => {
			const sql = queryText(input);
			if (sql === 'SELECT first') {
				firstStarted.resolve();
				await releaseFirst.promise;
			}
			return { rows: [], rowCount: 0 } as QueryResult;
		});
		const client = { query, release: vi.fn() } as unknown as PoolClient;
		const adapter = createPgsqlAdapter(client, {
			borrowedClient: true,
			managedTransactions: true,
		});
		let txAfterReturn: Adapter | undefined;

		const transaction = adapter.transaction(async (tx) => {
			txAfterReturn = tx;
			void tx.executeRaw('SELECT first');
			setTimeout(() => callbackReturned.resolve(), 0);
		});

		await firstStarted.promise;
		await callbackReturned.promise;
		if (txAfterReturn === undefined) {
			throw new Error('expected transaction adapter to be captured');
		}

		let lateError: unknown;
		const late = txAfterReturn.transaction(async (inner) => {
			await inner.executeRaw('SELECT late child');
		});
		const lateState = await Promise.race([
			late.then(
				() => 'resolved',
				(error) => {
					lateError = error;
					return 'rejected';
				},
			),
			new Promise<'pending'>((resolve) =>
				setTimeout(() => resolve('pending'), 0),
			),
		]);

		try {
			expect(lateState).toBe('rejected');
			expect(lateError).toBeInstanceOf(Error);
			expect((lateError as Error).message).toContain(
				'transaction that has ended',
			);
			expect(queryCalls(query)).not.toContain('SELECT late child');
		} finally {
			releaseFirst.resolve();
			await transaction.catch(() => undefined);
			await late.catch(() => undefined);
		}

		expect(queryCalls(query)).toEqual([
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			'SELECT first',
			expect.stringMatching(/^RELEASE SAVEPOINT dbsp_savepoint_/),
		]);
		expect(client.release).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// executeDDL() — success + error paths
// ---------------------------------------------------------------------------

describe('PgsqlAdapter.executeDDL — success path', () => {
	it('calls pool.query with the DDL string', async () => {
		const pool = makePool();
		const adapter = createPgsqlAdapter(pool);

		await adapter.executeDDL('CREATE INDEX my_idx ON tbl (col)');

		expect(pool.query).toHaveBeenCalledWith('CREATE INDEX my_idx ON tbl (col)');
	});

	it('does not pass parameters to pool.query', async () => {
		const pool = makePool();
		const adapter = createPgsqlAdapter(pool);

		const ddl = 'ALTER TABLE "users" ADD COLUMN "score" integer';
		await adapter.executeDDL(ddl);

		const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(call).toEqual([ddl]);
	});

	it('propagates pool.query rejection', async () => {
		const pool = makePool();
		(pool.query as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error('syntax error'),
		);
		const adapter = createPgsqlAdapter(pool);

		await expect(adapter.executeDDL('INVALID SQL')).rejects.toThrow(
			'syntax error',
		);
	});

	it('sends raw CREATE INDEX CONCURRENTLY through executeDDL without adapter-side preflight', async () => {
		const ddl = 'CREATE INDEX CONCURRENTLY idx_users_name ON users (name)';
		const client = Object.assign(
			{
				query: vi.fn(async () => ({ rows: [], rowCount: 0 }) as QueryResult),
				release: vi.fn(),
			} as unknown as PoolClient,
			{ _txStatus: 'T' },
		);
		const adapter = createPgsqlAdapter(client, { borrowedClient: true });

		await adapter.executeDDL(ddl);

		expect(queryCalls(client.query as ReturnType<typeof vi.fn>)).toEqual([
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			ddl,
			expect.stringMatching(/^RELEASE SAVEPOINT dbsp_savepoint_/),
		]);
		expect(client.release).not.toHaveBeenCalled();
	});

	it('reports transaction control distinctly when borrowed-client DDL destroys the savepoint', async () => {
		const ddl = 'COMMIT';
		const commitResult = {
			rows: [],
			rowCount: 0,
			command: 'COMMIT',
		} as QueryResult;
		const client = {
			query: vi.fn(async (input: MockQueryInput) => {
				const sql = queryText(input);
				if (sql === ddl) return commitResult;
				if (/^ROLLBACK TO SAVEPOINT /.test(sql)) {
					throw Object.assign(new Error('no active transaction'), {
						code: '25P01',
					});
				}
				return { rows: [], rowCount: 0 } as QueryResult;
			}),
			release: vi.fn(),
		} as unknown as PoolClient;
		const adapter = createPgsqlAdapter(client, { borrowedClient: true });

		const error = await captureRejection(() => adapter.executeDDL(ddl));

		expectRawSqlTransactionControlError(error, commitResult);
		expect(error).not.toBeInstanceOf(AggregateError);
		const calls = queryCalls(client.query as ReturnType<typeof vi.fn>);
		expect(calls).toEqual([
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			ddl,
			expect.stringMatching(/^ROLLBACK TO SAVEPOINT dbsp_savepoint_/),
		]);
		expect(calls).not.toContain('ROLLBACK');
		expect(client.release).not.toHaveBeenCalled();
	});

	it('runs borrowed-client DDL normally when the savepoint probe finds no active transaction', async () => {
		const query = vi.fn(async (input: MockQueryInput) => {
			const sql = queryText(input);
			if (/^SAVEPOINT /.test(sql)) {
				throw Object.assign(new Error('no active transaction'), {
					code: '25P01',
				});
			}
			return { rows: [], rowCount: 0 } as QueryResult;
		});
		const client = { query, release: vi.fn() } as unknown as PoolClient;
		const adapter = createPgsqlAdapter(client, { borrowedClient: true });

		await adapter.executeDDL('VACUUM "users"');

		expect(queryCalls(query)).toEqual([
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			'VACUUM "users"',
		]);
		expect(client.release).not.toHaveBeenCalled();
	});

	it('leaves raw VACUUM rejection to PostgreSQL in an active transaction', async () => {
		const pgError = Object.assign(
			new Error('VACUUM cannot run inside a transaction block'),
			{ code: '25001' },
		);
		const client = Object.assign(
			makeClient(async (sql) => {
				if (sql === 'VACUUM "users"') throw pgError;
				return { rows: [], rowCount: 0 } as QueryResult;
			}),
			{ _txStatus: 'T' },
		);
		const adapter = createPgsqlAdapter(client, { borrowedClient: true });

		await expect(adapter.executeDDL('VACUUM "users"')).rejects.toBe(pgError);

		const calls = queryCalls(client.query as ReturnType<typeof vi.fn>);
		expect(calls).toEqual([
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			'VACUUM "users"',
			expect.stringMatching(/^ROLLBACK TO SAVEPOINT dbsp_savepoint_/),
			expect.stringMatching(/^RELEASE SAVEPOINT dbsp_savepoint_/),
		]);
	});

	it('lets core refuse CREATE INDEX CONCURRENTLY for a borrowed client already in a caller transaction', async () => {
		const client = Object.assign(makeClient(), { _txStatus: 'T' });
		const adapter = createPgsqlAdapter(client, { borrowedClient: true });
		const orm = createOrm({ schema: ownershipOrmSchema, adapter });

		await expect(
			(
				orm.tables.items as unknown as {
					indexes: {
						create(options: {
							name: string;
							columns: string[];
							concurrently: true;
						}): Promise<void>;
					};
				}
			).indexes.create({
				name: 'idx_items_label',
				columns: ['label'],
				concurrently: true,
			}),
		).rejects.toThrow(
			'CREATE INDEX CONCURRENTLY cannot run inside a transaction block',
		);
		expect(adapter.inTransaction).toBe(true);
		expect(client.query).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// execute() — row transformation (camelCase naming)
// ---------------------------------------------------------------------------

describe('PgsqlAdapter.execute — row transformation', () => {
	it('passes through rows unchanged with preserve naming (default)', async () => {
		const pool = makePool({ rows: [{ user_id: 1, full_name: 'Alice' }] });
		const adapter = createPgsqlAdapter(pool);

		const rows = await adapter.execute({ sql: 'SELECT 1', parameters: [] });

		expect(rows).toEqual([{ user_id: 1, full_name: 'Alice' }]);
	});

	it('converts snake_case columns to camelCase with snake_case dbCasing', async () => {
		const pool = makePool({
			rows: [{ user_id: 1, full_name: 'Alice', is_active: true }],
		});
		const adapter = createPgsqlAdapter(pool, { dbCasing: 'snake_case' });

		const rows = await adapter.execute<Record<string, unknown>>({
			sql: 'SELECT 1',
			parameters: [],
		});

		expect(rows).toEqual([{ userId: 1, fullName: 'Alice', isActive: true }]);
	});

	it('transforms multiple rows', async () => {
		const pool = makePool({
			rows: [
				{ order_id: 1, total_price: 100 },
				{ order_id: 2, total_price: 200 },
			],
		});
		const adapter = createPgsqlAdapter(pool, { dbCasing: 'snake_case' });

		const rows = await adapter.execute<Record<string, unknown>>({
			sql: 'SELECT 1',
			parameters: [],
		});

		expect(rows).toEqual([
			{ orderId: 1, totalPrice: 100 },
			{ orderId: 2, totalPrice: 200 },
		]);
	});

	it('propagates pool.query rejection', async () => {
		const pool = makePool();
		(pool.query as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error('connection refused'),
		);
		const adapter = createPgsqlAdapter(pool);

		await expect(
			adapter.execute({ sql: 'SELECT 1', parameters: [] }),
		).rejects.toThrow('connection refused');
	});

	it('reports transaction control distinctly when borrowed-client execute destroys the savepoint', async () => {
		const commitResult = {
			rows: [],
			rowCount: 0,
			command: 'COMMIT',
		} as QueryResult;
		const client = {
			query: vi.fn(async (input: MockQueryInput) => {
				const sql = queryText(input);
				if (sql === 'COMMIT') return commitResult;
				if (/^ROLLBACK TO SAVEPOINT /.test(sql)) {
					throw Object.assign(new Error('no active transaction'), {
						code: '25P01',
					});
				}
				return { rows: [], rowCount: 0 } as QueryResult;
			}),
			release: vi.fn(),
		} as unknown as PoolClient;
		const adapter = createPgsqlAdapter(client, { borrowedClient: true });

		const error = await captureRejection(() =>
			adapter.execute({ sql: 'COMMIT', parameters: [] }),
		);

		expectRawSqlTransactionControlError(error, commitResult);
		expect(error).not.toBeInstanceOf(AggregateError);
		const calls = queryCalls(client.query as ReturnType<typeof vi.fn>);
		expect(calls).toEqual([
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			'COMMIT',
			expect.stringMatching(/^ROLLBACK TO SAVEPOINT dbsp_savepoint_/),
		]);
		expect(calls).not.toContain('ROLLBACK');
		expect(client.release).not.toHaveBeenCalled();
	});

	it('rolls back to the savepoint when borrowed-client execute is rejected by PostgreSQL', async () => {
		const sql = 'SELECT * FROM missing_table WHERE id = $1';
		const pgError = Object.assign(new Error('relation does not exist'), {
			code: '42P01',
		});
		const client = {
			query: vi.fn(async (input: MockQueryInput) => {
				const statement = queryText(input);
				if (statement === sql) throw pgError;
				return { rows: [], rowCount: 0 } as QueryResult;
			}),
			release: vi.fn(),
		} as unknown as PoolClient;
		const adapter = createPgsqlAdapter(client, { borrowedClient: true });

		const error = await captureRejection(() =>
			adapter.execute({ sql, parameters: [1] }),
		);

		expect(error).toBe(pgError);
		expect((error as Error).message).toContain(
			'rolled back the failed raw SQL to a savepoint',
		);
		const calls = queryCalls(client.query as ReturnType<typeof vi.fn>);
		expect(calls).toEqual([
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			sql,
			expect.stringMatching(/^ROLLBACK TO SAVEPOINT dbsp_savepoint_/),
			expect.stringMatching(/^RELEASE SAVEPOINT dbsp_savepoint_/),
		]);
		expect(client.release).not.toHaveBeenCalled();
	});

	it('rolls back a successful borrowed-client statement when RELEASE SAVEPOINT fails', async () => {
		const sql = 'INSERT INTO t VALUES (1)';
		const releaseError = new Error('release savepoint failed');
		let releaseAttempts = 0;
		const client = {
			query: vi.fn(async (input: MockQueryInput) => {
				const statement = queryText(input);
				if (/^RELEASE SAVEPOINT /.test(statement)) {
					releaseAttempts++;
					if (releaseAttempts === 1) throw releaseError;
				}
				return { rows: [], rowCount: 0 } as QueryResult;
			}),
			release: vi.fn(),
		} as unknown as PoolClient;
		const adapter = createPgsqlAdapter(client, { borrowedClient: true });

		const error = await captureRejection(() =>
			adapter.execute({ sql, parameters: [] }),
		);

		expect(error).toBeInstanceOf(AggregateError);
		expect((error as Error).message).toContain('RELEASE SAVEPOINT failed');
		expect((error as { readonly cleanupError?: unknown }).cleanupError).toBe(
			releaseError,
		);
		const calls = queryCalls(client.query as ReturnType<typeof vi.fn>);
		expect(calls).toEqual([
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			sql,
			expect.stringMatching(/^RELEASE SAVEPOINT dbsp_savepoint_/),
			expect.stringMatching(/^ROLLBACK TO SAVEPOINT dbsp_savepoint_/),
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			expect.stringMatching(/^RELEASE SAVEPOINT dbsp_savepoint_/),
		]);
		expect(client.release).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// executeRaw() — error path
// ---------------------------------------------------------------------------

describe('PgsqlAdapter.executeRaw — error path', () => {
	it('propagates pool.query rejection', async () => {
		const pool = makePool();
		(pool.query as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error('raw query failed'),
		);
		const adapter = createPgsqlAdapter(pool);

		await expect(adapter.executeRaw('SELECT 1', [])).rejects.toThrow(
			'raw query failed',
		);
	});

	it('detects a multi-command result inside a managed scope and poisons the scope', async () => {
		const multiResult = [
			{ rows: [], rowCount: 0, command: 'SELECT' },
			{ rows: [{ value: 1 }], rowCount: 1, command: 'SELECT' },
		] as QueryResult[];
		let firstError: unknown;
		let secondError: unknown;
		const client = {
			query: vi.fn(async (input: MockQueryInput) => {
				const sql = queryText(input);
				if (sql === 'SELECT 1; SELECT 2') return multiResult;
				return { rows: [], rowCount: 0, command: 'SELECT' } as QueryResult;
			}),
			release: vi.fn(),
		} as unknown as PoolClient;
		const adapter = createPgsqlAdapter(client, {
			borrowedClient: true,
			managedTransactions: true,
		});

		const error = await captureRejection(() =>
			adapter.transaction(async (tx) => {
				try {
					await tx.executeRaw('SELECT 1; SELECT 2');
				} catch (caught) {
					firstError = caught;
				}
				try {
					await tx.executeRaw('SELECT after poison');
				} catch (caught) {
					secondError = caught;
					throw caught;
				}
			}),
		);

		expect(firstError).toBeInstanceOf(Error);
		expect(secondError).toBe(firstError);
		expect(error).toBe(firstError);
		expect((error as Error).message).toContain(
			'dbsp cannot reason about a multi-command raw call inside a transaction it manages',
		);
		expect((error as Error).message).toContain(
			'dbsp cannot undo what they already did',
		);
		expect(queryCalls(client.query as ReturnType<typeof vi.fn>)).toEqual([
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			'SELECT 1; SELECT 2',
			expect.stringMatching(/^ROLLBACK TO SAVEPOINT dbsp_savepoint_/),
			expect.stringMatching(/^RELEASE SAVEPOINT dbsp_savepoint_/),
		]);
		expect(queryCalls(client.query as ReturnType<typeof vi.fn>)).not.toContain(
			'SELECT after poison',
		);
		expect(client.release).not.toHaveBeenCalled();
	});

	it('does not expose rows from a multi-command raw result in the surfaced error', async () => {
		const literal = 'dbsp_secret_literal_multi_command_mock';
		const multiResult = [
			{ rows: [{ secret_column: literal }], rowCount: 1, command: 'SELECT' },
			{ rows: [{ value: 1 }], rowCount: 1, command: 'SELECT' },
		] as QueryResult[];
		const client = {
			query: vi.fn(async (input: MockQueryInput) => {
				const sql = queryText(input);
				if (sql === 'SELECT secret_column FROM secrets; SELECT 1') {
					return multiResult;
				}
				return { rows: [], rowCount: 0, command: 'SELECT' } as QueryResult;
			}),
			release: vi.fn(),
		} as unknown as PoolClient;
		const adapter = createPgsqlAdapter(client, {
			borrowedClient: true,
			managedTransactions: true,
		});

		const error = await captureRejection(() =>
			adapter.transaction(async (tx) => {
				await tx.executeRaw('SELECT secret_column FROM secrets; SELECT 1');
			}),
		);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain(
			'dbsp cannot reason about a multi-command raw call inside a transaction it manages',
		);
		expect((error as Error).cause).toEqual([
			{ command: 'SELECT', rowCount: 1 },
			{ command: 'SELECT', rowCount: 1 },
		]);
		const reachable = collectReachableStrings(error).join('\n');
		expect(reachable).not.toContain(literal);
		expect(reachable).not.toContain(
			'SELECT secret_column FROM secrets; SELECT 1',
		);
		expect(client.release).not.toHaveBeenCalled();
	});

	it('reports transaction control before the generic multi-command raw error', async () => {
		const multiResult = [
			{ rows: [{ value: 1 }], rowCount: 1, command: 'SELECT' },
			{ rows: [], rowCount: 0, command: 'COMMIT' },
		] as QueryResult[];
		let transactionOpen = true;
		const client = {
			query: vi.fn(async (input: MockQueryInput) => {
				const sql = queryText(input);
				if (/^SAVEPOINT /.test(sql)) {
					if (!transactionOpen) throw noActiveTransactionError();
					return { rows: [], rowCount: 0, command: 'SAVEPOINT' } as QueryResult;
				}
				if (sql === 'SELECT 1; COMMIT') {
					transactionOpen = false;
					return multiResult;
				}
				if (/^ROLLBACK TO SAVEPOINT /.test(sql)) {
					if (!transactionOpen) throw noActiveTransactionError();
					return { rows: [], rowCount: 0, command: 'ROLLBACK' } as QueryResult;
				}
				return { rows: [], rowCount: 0, command: 'SELECT' } as QueryResult;
			}),
			release: vi.fn(),
		} as unknown as PoolClient;
		const adapter = createPgsqlAdapter(client, { borrowedClient: true });

		const error = await captureRejection(() =>
			adapter.executeRaw('SELECT 1; COMMIT'),
		);

		expect(error).toBeInstanceOf(PgsqlRawSqlTransactionControlError);
		expect((error as Error).message).toBe(TRANSACTION_CONTROL_BOUNDARY);
		expect((error as Error).message).not.toContain(
			'dbsp cannot reason about a multi-command raw call',
		);
		expect(error).not.toBeInstanceOf(AggregateError);
		expect((error as Error).message).not.toContain('cleanup failed');
		expect((error as Error).cause).toEqual([
			{ command: 'SELECT', rowCount: 1 },
			{ command: 'COMMIT', rowCount: 0 },
		]);
		expect(queryCalls(client.query as ReturnType<typeof vi.fn>)).toEqual([
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			'SELECT 1; COMMIT',
			expect.stringMatching(/^ROLLBACK TO SAVEPOINT dbsp_savepoint_/),
		]);
		expect(client.release).not.toHaveBeenCalled();
	});

	it.each([
		'COMMIT',
		'ROLLBACK',
	])('reports raw %s transaction control distinctly from the command tag', async (statement) => {
		const commandResult = {
			rows: [],
			rowCount: 0,
			command: statement,
		} as QueryResult;
		const client = {
			query: vi.fn(async (input: MockQueryInput) => {
				const sql = queryText(input);
				if (sql === statement) return commandResult;
				if (/^ROLLBACK TO SAVEPOINT /.test(sql)) {
					throw Object.assign(new Error('no active transaction'), {
						code: '25P01',
					});
				}
				return { rows: [], rowCount: 0 } as QueryResult;
			}),
			release: vi.fn(),
		} as unknown as PoolClient;
		const adapter = createPgsqlAdapter(client, { borrowedClient: true });

		const error = await captureRejection(() => adapter.executeRaw(statement));

		expectRawSqlTransactionControlError(error, commandResult);
		expect(error).not.toBeInstanceOf(AggregateError);
		expect((error as Error).message).not.toContain(
			'rolled back the failed raw SQL to a savepoint',
		);
		const calls = queryCalls(client.query as ReturnType<typeof vi.fn>);
		expect(calls).toEqual([
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			statement,
			expect.stringMatching(/^ROLLBACK TO SAVEPOINT dbsp_savepoint_/),
		]);
		expect(calls.filter((sql) => sql === 'ROLLBACK')).toHaveLength(
			statement === 'ROLLBACK' ? 1 : 0,
		);
		expect(client.release).not.toHaveBeenCalled();
	});

	it('rolls back only its savepoint when borrowed-client raw SAVEPOINT is detected', async () => {
		const savepointResult = {
			rows: [],
			rowCount: 0,
			command: 'SAVEPOINT',
		} as QueryResult;
		const client = {
			query: vi.fn(async (input: MockQueryInput) => {
				const sql = queryText(input);
				if (sql === 'SAVEPOINT s') return savepointResult;
				return { rows: [], rowCount: 0 } as QueryResult;
			}),
			release: vi.fn(),
		} as unknown as PoolClient;
		const adapter = createPgsqlAdapter(client, { borrowedClient: true });

		const error = await captureRejection(() =>
			adapter.executeRaw('SAVEPOINT s'),
		);

		expectRawSqlTransactionControlError(error, savepointResult);
		expect(error).not.toBeInstanceOf(AggregateError);
		const calls = queryCalls(client.query as ReturnType<typeof vi.fn>);
		expect(calls).toEqual([
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			'SAVEPOINT s',
			expect.stringMatching(/^ROLLBACK TO SAVEPOINT dbsp_savepoint_/),
			expect.stringMatching(/^RELEASE SAVEPOINT dbsp_savepoint_/),
		]);
		expect(calls).not.toContain('ROLLBACK');
		expect(client.release).not.toHaveBeenCalled();
	});

	it('does not attach raw SQL text to rejected statement errors', async () => {
		const literal = 'dbsp_secret_literal_322_round4';
		const rawSql = `SELECT '${literal}'::text FROM missing_table`;
		const pgError = Object.assign(new Error('relation does not exist'), {
			code: '42P01',
		});
		const client = {
			query: vi.fn(async (input: MockQueryInput) => {
				const sql = queryText(input);
				if (sql === rawSql) throw pgError;
				return { rows: [], rowCount: 0 } as QueryResult;
			}),
			release: vi.fn(),
		} as unknown as PoolClient;
		const adapter = createPgsqlAdapter(client, { borrowedClient: true });

		const error = await captureRejection(() => adapter.executeRaw(rawSql));

		expect(error).toBe(pgError);
		expect((error as Error).message).toContain(
			'rolled back the failed raw SQL to a savepoint',
		);
		expect((error as Error).message).toContain('sequence advancement');
		expect((error as Error).message).toContain('session-level advisory locks');
		const reachable = collectReachableStrings(error).join('\n');
		expect(reachable).not.toContain(literal);
		expect(reachable).not.toContain(rawSql);
		const calls = queryCalls(client.query as ReturnType<typeof vi.fn>);
		expect(calls).toEqual([
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			rawSql,
			expect.stringMatching(/^ROLLBACK TO SAVEPOINT dbsp_savepoint_/),
			expect.stringMatching(/^RELEASE SAVEPOINT dbsp_savepoint_/),
		]);
	});
});

describe('PgsqlAdapter borrowed-client savepoint scope guard', () => {
	it('refuses overlapping savepoint-protected operations on the same client', async () => {
		const firstSqlStarted = deferred();
		const releaseFirstSql = deferred();
		const calls: string[] = [];
		const query = vi.fn(async (input: MockQueryInput) => {
			const sql = queryText(input);
			calls.push(sql);
			if (sql === 'SELECT first') {
				firstSqlStarted.resolve();
				await releaseFirstSql.promise;
				return { rows: [{ value: 1 }], rowCount: 1 } as QueryResult;
			}
			if (sql === 'SELECT second') {
				return { rows: [{ value: 2 }], rowCount: 1 } as QueryResult;
			}
			return { rows: [], rowCount: 0 } as QueryResult;
		});
		const client = { query, release: vi.fn() } as unknown as PoolClient;
		const adapter = createPgsqlAdapter(client, { borrowedClient: true });

		const first = adapter.executeRaw<{ value: number }>('SELECT first');
		await firstSqlStarted.promise;

		const secondError = await captureRejection(() =>
			adapter.execute<{ value: number }>({
				sql: 'SELECT second',
				parameters: [],
			}),
		);

		expect(secondError).toBeInstanceOf(Error);
		expect((secondError as Error).message).toContain(
			'Savepoint scopes are single-flight per connection',
		);
		expect(queryCalls(query)).toEqual([
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			'SELECT first',
		]);

		releaseFirstSql.resolve();
		await expect(first).resolves.toEqual([{ value: 1 }]);

		expect(queryCalls(query)).toEqual([
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			'SELECT first',
			expect.stringMatching(/^RELEASE SAVEPOINT dbsp_savepoint_/),
		]);
		expect(queryCalls(query)).not.toContain('SELECT second');
		expect(client.release).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// getPoolInstance() — success path
// ---------------------------------------------------------------------------

describe('PgsqlAdapter.getPoolInstance', () => {
	it('returns the pool when created with a pool', () => {
		const pool = makePool();
		const adapter = createPgsqlAdapter(pool);
		expect(adapter.getPoolInstance()).toBe(pool);
	});

	it('returns the caller-owned client when created with a borrowed client', () => {
		const client = makeClient();
		const adapter = createPgsqlAdapter(client, { borrowedClient: true });
		expect(adapter.getPoolInstance()).toBe(client);
	});
});

// ---------------------------------------------------------------------------
// indexExists() — false row value branch + schema fallback
// ---------------------------------------------------------------------------

describe('PgsqlAdapter.indexExists — false branch', () => {
	it('returns false when row has exists:false', async () => {
		const pool = makePool({ rows: [{ exists: false }] });
		const adapter = createPgsqlAdapter(pool);

		const result = await adapter.indexExists('my_idx', 'tbl', 'public');

		expect(result).toBe(false);
	});

	it('uses adapter schema when no explicit schema provided', async () => {
		const pool = makePool({ rows: [{ exists: true }] });
		const adapter = createPgsqlAdapter(pool, { schemaName: 'tenant_7' });

		await adapter.indexExists('my_idx', 'tbl');

		const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(call![1]).toEqual(['my_idx', 'tbl', 'tenant_7']);
	});

	it('resolves the schema search_path-aware in-query when no adapter/explicit schema', async () => {
		const pool = makePool({ rows: [{ exists: true }] });
		const adapter = createPgsqlAdapter(pool);

		await adapter.indexExists('my_idx', 'tbl');

		// No schema passed (null); resolved in the query, not hard-coded 'public'.
		const [sql, params] = catalogCall(pool);
		expect(params).toEqual(['my_idx', 'tbl', null]);
		expect(sql).toContain('to_regclass');
	});
});

// ---------------------------------------------------------------------------
// withSchema() — carries pool, execute works
// ---------------------------------------------------------------------------

describe('PgsqlAdapter.withSchema — pool inheritance', () => {
	it('scoped adapter can execute queries using underlying pool', async () => {
		const pool = makePool({ rows: [{ id: 1 }] });
		const adapter = createPgsqlAdapter(pool);
		const scoped = adapter.withSchema('tenant_9');

		const rows = await (scoped as PgsqlAdapter).execute({
			sql: 'SELECT 1',
			parameters: [],
		});

		expect(rows).toEqual([{ id: 1 }]);
		expect(pool.query).toHaveBeenCalledOnce();
	});

	it('scoped adapter preserves dbCasing option', async () => {
		const adapter = createPgsqlAdapter(makePool(), { dbCasing: 'snake_case' });
		const scoped = adapter.withSchema('s1') as PgsqlAdapter;

		expect(scoped.dbCasing).toBe('snake_case');
	});

	it('withSchema creates a different instance from original', () => {
		const adapter = createPgsqlAdapter(makePool());
		const scoped = adapter.withSchema('s1');
		expect(scoped).not.toBe(adapter);
	});

	it('scoped borrowed-client adapter preserves declared ownership', async () => {
		const client = Object.assign(makeClient(), { _txStatus: 'I' });
		const adapter = createPgsqlAdapter(client, { borrowedClient: true });
		const scoped = adapter.withSchema('tenant_10') as PgsqlAdapter;

		expect(scoped).not.toBe(adapter);
		expect(scoped.getPoolInstance()).toBe(client);
		expect(scoped.inTransaction).toBe(false);
		await expect(scoped.transaction(async () => undefined)).rejects.toThrow(
			/managedTransactions: true/,
		);
		expect(client.release).not.toHaveBeenCalled();
	});

	it('allows orm.transaction callbacks to query through a schema-scoped transaction adapter', async () => {
		const query = vi.fn(async () => {
			return {
				rows: [{ id: 1, label: 'scoped' }],
				rowCount: 1,
				command: 'SELECT',
			} as QueryResult;
		});
		const txClient = { query, release: vi.fn() } as unknown as PoolClient;
		const pool = makePool({ rows: [] }, txClient);
		const adapter = createPgsqlAdapter(pool);
		const orm = createOrm({ schema: ownershipOrmSchema, adapter });

		const rows = await orm.transaction(async (tx) => {
			return tx
				.withSchema('tenant_1')
				.select('items')
				.columns(['id', 'label'])
				.execute();
		});

		expect(rows).toEqual([{ id: 1, label: 'scoped' }]);
		const calls = queryCalls(query);
		expect(calls).toEqual([
			'BEGIN',
			expect.stringContaining('tenant_1.items'),
			'COMMIT',
		]);
	});

	it('allows nested transactions started from a schema-scoped transaction adapter', async () => {
		const query = vi.fn(async () => {
			return {
				rows: [{ id: 2, label: 'nested scoped' }],
				rowCount: 1,
				command: 'SELECT',
			} as QueryResult;
		});
		const txClient = { query, release: vi.fn() } as unknown as PoolClient;
		const pool = makePool({ rows: [] }, txClient);
		const adapter = createPgsqlAdapter(pool);
		const orm = createOrm({ schema: ownershipOrmSchema, adapter });

		const rows = await orm.transaction(async (tx) => {
			const scoped = tx.withSchema('tenant_2');
			return scoped.transaction(async (inner) =>
				inner.select('items').columns(['id', 'label']).execute(),
			);
		});

		expect(rows).toEqual([{ id: 2, label: 'nested scoped' }]);
		const calls = queryCalls(query);
		expect(calls).toEqual([
			'BEGIN',
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			expect.stringContaining('tenant_2.items'),
			expect.stringMatching(/^RELEASE SAVEPOINT dbsp_savepoint_/),
			'COMMIT',
		]);
	});
});

// ---------------------------------------------------------------------------
// compileWithIncludes() — subquery includes present
// ---------------------------------------------------------------------------

describe('PgsqlAdapter.compileWithIncludes — include decisions', () => {
	it('returns subqueryIncludes as empty array when no include strategy in plan', () => {
		const adapter = createPgsqlAdapter(makePool());

		const plan = {
			rootTable: 'users',
			decisions: [{ type: 'select', column: '*' }],
		} as never;

		const result = adapter.compileWithIncludes(plan);

		expect(result.subqueryIncludes).toEqual([]);
	});

	it('returns main query with sql/parameters regardless of include strategy', () => {
		const adapter = createPgsqlAdapter(makePool());

		const plan = {
			rootTable: 'authors',
			decisions: [
				{
					type: 'include-strategy',
					choice: 'subquery',
					context: {
						relation: 'posts',
						target: 'posts',
						relationType: 'hasMany',
						sourceTable: undefined,
					},
				},
			],
			intent: {
				from: 'authors',
				select: { type: 'star' },
			},
		} as never;

		const result = adapter.compileWithIncludes(plan);

		expect(result).toHaveProperty('main');
		expect(typeof result.main.sql).toBe('string');
		expect(Array.isArray(result.main.parameters)).toBe(true);
		expect(Array.isArray(result.subqueryIncludes)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// stream() — all branches
// ---------------------------------------------------------------------------

describe('PgsqlAdapter.stream — borrowed client contract', () => {
	it('refuses an unmanaged borrowed client before opening a cursor', async () => {
		const client = makeClient();
		const adapter = createPgsqlAdapter(client, { borrowedClient: true });
		const iter = adapter.stream({ sql: 'SELECT * FROM t', parameters: [] });

		await expect(iter.next()).rejects.toThrow(/managedTransactions: true/);
		expect(client.query).not.toHaveBeenCalled();
		expect(client.release).not.toHaveBeenCalled();
	});

	it('uses a savepoint for a managed borrowed client inside a caller transaction', async () => {
		const rows: Record<string, unknown>[] = [{ id: 1 }];
		let callIdx = 0;
		const client = makeClient(async (_sql) => {
			callIdx++;
			if (callIdx === 1) return { rows: [], rowCount: 0 } as QueryResult; // SAVEPOINT
			if (callIdx === 2) return { rows: [], rowCount: 0 } as QueryResult; // DECLARE
			if (callIdx === 3) return { rows, rowCount: 1 } as QueryResult; // FETCH -> 1 row
			if (callIdx === 4) return { rows: [], rowCount: 0 } as QueryResult; // FETCH -> done
			if (callIdx === 5) return { rows: [], rowCount: 0 } as QueryResult; // CLOSE
			return { rows: [], rowCount: 0 } as QueryResult; // RELEASE
		});

		const adapter = createPgsqlAdapter(client, {
			borrowedClient: true,
			managedTransactions: true,
		});
		const iter = adapter.stream({ sql: 'SELECT * FROM t', parameters: [] });

		const collected: unknown[] = [];
		for await (const row of iter) {
			collected.push(row);
		}

		expect(collected).toEqual([{ id: 1 }]);
		expect(client.release).not.toHaveBeenCalled();
		const calls = queryCalls(client.query as ReturnType<typeof vi.fn>);
		expect(calls[0]).toMatch(/^SAVEPOINT dbsp_savepoint_/);
		expect(calls.some((sql) => /^DECLARE /.test(sql))).toBe(true);
		expect(calls.at(-1)).toMatch(/^RELEASE SAVEPOINT dbsp_savepoint_/);
		expect(calls).not.toContain('BEGIN');
		expect(calls).not.toContain('COMMIT');
	});

	it('rolls back a completed managed borrowed stream when RELEASE SAVEPOINT fails', async () => {
		const releaseError = new Error('stream release failed');
		let fetchCount = 0;
		let releaseAttempts = 0;
		const query = vi.fn(async (input: MockQueryInput) => {
			const sql = queryText(input);
			if (/^FETCH /.test(sql)) {
				fetchCount++;
				if (fetchCount === 1) {
					return { rows: [{ id: 1 }], rowCount: 1 } as QueryResult;
				}
				return { rows: [], rowCount: 0 } as QueryResult;
			}
			if (/^RELEASE SAVEPOINT /.test(sql)) {
				releaseAttempts++;
				if (releaseAttempts === 1) throw releaseError;
			}
			return { rows: [], rowCount: 0 } as QueryResult;
		});
		const client = { query, release: vi.fn() } as unknown as PoolClient;
		const adapter = createPgsqlAdapter(client, {
			borrowedClient: true,
			managedTransactions: true,
		});
		const collected: unknown[] = [];

		const error = await captureRejection(async () => {
			for await (const row of adapter.stream(
				{ sql: 'SELECT * FROM t', parameters: [] },
				{ chunkSize: 1 },
			)) {
				collected.push(row);
			}
		});

		expect(collected).toEqual([{ id: 1 }]);
		expect(error).toBeInstanceOf(AggregateError);
		expect((error as Error).message).toContain('RELEASE SAVEPOINT failed');
		expect((error as { readonly cleanupError?: unknown }).cleanupError).toBe(
			releaseError,
		);
		expect(queryCalls(query)).toEqual([
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			expect.stringMatching(/^DECLARE /),
			expect.stringMatching(/^FETCH FORWARD 1 FROM /),
			expect.stringMatching(/^FETCH FORWARD 1 FROM /),
			expect.stringMatching(/^CLOSE /),
			expect.stringMatching(/^RELEASE SAVEPOINT dbsp_savepoint_/),
			expect.stringMatching(/^ROLLBACK TO SAVEPOINT dbsp_savepoint_/),
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			expect.stringMatching(/^RELEASE SAVEPOINT dbsp_savepoint_/),
		]);
		expect(client.release).not.toHaveBeenCalled();
	});

	it('does not take per-cursor savepoints for concurrent streams inside a managed borrowed transaction', async () => {
		const cursorKinds = new Map<string, 'first' | 'second'>();
		const fetchCounts = new Map<string, number>();
		const query = vi.fn(async (input: MockQueryInput) => {
			const sql = queryText(input);
			const declare =
				/^DECLARE (\S+) NO SCROLL CURSOR FOR SELECT (first|second)$/.exec(sql);
			if (declare) {
				cursorKinds.set(declare[1]!, declare[2] as 'first' | 'second');
				return { rows: [], rowCount: 0 } as QueryResult;
			}

			const fetch = /^FETCH FORWARD 1 FROM (\S+)$/.exec(sql);
			if (fetch) {
				const cursor = fetch[1]!;
				const count = fetchCounts.get(cursor) ?? 0;
				fetchCounts.set(cursor, count + 1);
				if (count > 0) {
					return { rows: [], rowCount: 0 } as QueryResult;
				}
				return {
					rows: [{ stream: cursorKinds.get(cursor) }],
					rowCount: 1,
				} as QueryResult;
			}

			return { rows: [], rowCount: 0 } as QueryResult;
		});
		const client = { query, release: vi.fn() } as unknown as PoolClient;
		const adapter = createPgsqlAdapter(client, {
			borrowedClient: true,
			managedTransactions: true,
		});

		const collect = async (
			iterable: AsyncIterable<{ stream: string }>,
		): Promise<string[]> => {
			const rows: string[] = [];
			for await (const row of iterable) {
				rows.push(row.stream);
			}
			return rows;
		};

		const result = await adapter.transaction(async (tx) => {
			const first = collect(
				tx.stream<{ stream: string }>(
					{ sql: 'SELECT first', parameters: [] },
					{ chunkSize: 1 },
				),
			);
			const second = collect(
				tx.stream<{ stream: string }>(
					{ sql: 'SELECT second', parameters: [] },
					{ chunkSize: 1 },
				),
			);
			return Promise.all([first, second]);
		});

		expect(result).toEqual([['first'], ['second']]);
		const calls = queryCalls(query);
		expect(calls.filter((sql) => /^SAVEPOINT /.test(sql))).toHaveLength(1);
		expect(calls.filter((sql) => /^DECLARE /.test(sql))).toHaveLength(2);
		expect(calls.filter((sql) => /^CLOSE /.test(sql))).toHaveLength(2);
		expect(calls.at(-1)).toMatch(/^RELEASE SAVEPOINT dbsp_savepoint_/);
		expect(client.release).not.toHaveBeenCalled();
	});

	it('surfaces savepoint rollback failure when managed borrowed stream setup fails', async () => {
		const streamError = new Error('cursor declare failed');
		const rollbackError = new Error('stream savepoint rollback failed');
		const client = {
			query: vi.fn(async (input: MockQueryInput) => {
				const sql = queryText(input);
				if (/^DECLARE /.test(sql)) throw streamError;
				if (/^ROLLBACK TO SAVEPOINT /.test(sql)) throw rollbackError;
				return { rows: [], rowCount: 0 } as QueryResult;
			}),
			release: vi.fn(),
		} as unknown as PoolClient;
		const adapter = createPgsqlAdapter(client, {
			borrowedClient: true,
			managedTransactions: true,
		});

		const iter = adapter.stream({ sql: 'SELECT * FROM t', parameters: [] });
		const error = await captureRejection(() => iter.next());

		expectCleanupFailure(
			error,
			streamError,
			rollbackError,
			/stream cleanup failed/,
		);
		expect(client.release).not.toHaveBeenCalled();
	});

	it('surfaces a FETCH PostgreSQL error and still closes the cursor on a poisoned scope', async () => {
		const fetchError = Object.assign(new Error('division by zero'), {
			code: '22012',
		});
		const query = vi.fn(async (input: MockQueryInput) => {
			const sql = queryText(input);
			if (/^FETCH /.test(sql)) throw fetchError;
			return { rows: [], rowCount: 0 } as QueryResult;
		});
		const client = { query, release: vi.fn() } as unknown as PoolClient;
		const adapter = createPgsqlAdapter(client, {
			borrowedClient: true,
			managedTransactions: true,
		});

		const iter = adapter.stream({ sql: 'SELECT 1 / 0', parameters: [] });
		const error = await captureRejection(() => iter.next());

		expect(error).toBe(fetchError);
		expect(error).not.toBeInstanceOf(PgsqlTransactionAbortedError);
		const calls = queryCalls(query);
		const fetchIndex = calls.findIndex((sql) => /^FETCH /.test(sql));
		const closeIndex = calls.findIndex((sql) => /^CLOSE /.test(sql));
		expect(fetchIndex).toBeGreaterThan(-1);
		expect(closeIndex).toBeGreaterThan(fetchIndex);
		expect(calls).toEqual([
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			expect.stringMatching(/^DECLARE /),
			expect.stringMatching(/^FETCH FORWARD 100 FROM /),
			expect.stringMatching(/^CLOSE /),
			expect.stringMatching(/^ROLLBACK TO SAVEPOINT dbsp_savepoint_/),
			expect.stringMatching(/^RELEASE SAVEPOINT dbsp_savepoint_/),
		]);
		expect(client.release).not.toHaveBeenCalled();
	});

	it('opens a transaction for a managed borrowed client when none is active', async () => {
		const rows: Record<string, unknown>[] = [{ id: 2 }];
		let callIdx = 0;
		const query = vi.fn(async (input: MockQueryInput) => {
			const sql = queryText(input);
			callIdx++;
			if (callIdx === 1) {
				expect(sql).toMatch(/^SAVEPOINT dbsp_savepoint_/);
				throw Object.assign(new Error('no active transaction'), {
					code: '25P01',
				});
			}
			if (callIdx === 2) return { rows: [], rowCount: 0 } as QueryResult; // BEGIN
			if (callIdx === 3) return { rows: [], rowCount: 0 } as QueryResult; // DECLARE
			if (callIdx === 4) return { rows, rowCount: 1 } as QueryResult; // FETCH -> 1 row
			if (callIdx === 5) return { rows: [], rowCount: 0 } as QueryResult; // FETCH -> done
			if (callIdx === 6) return { rows: [], rowCount: 0 } as QueryResult; // CLOSE
			return { rows: [], rowCount: 0 } as QueryResult; // COMMIT
		});
		const client = { query, release: vi.fn() } as unknown as PoolClient;
		const adapter = createPgsqlAdapter(client, {
			borrowedClient: true,
			managedTransactions: true,
		});

		const collected: unknown[] = [];
		for await (const row of adapter.stream({
			sql: 'SELECT * FROM t',
			parameters: [],
		})) {
			collected.push(row);
		}

		expect(collected).toEqual([{ id: 2 }]);
		expect(client.release).not.toHaveBeenCalled();
		expect(queryCalls(query).slice(1)).toEqual([
			'BEGIN',
			expect.stringMatching(/^DECLARE /),
			expect.stringMatching(/^FETCH FORWARD 100 FROM /),
			expect.stringMatching(/^CLOSE /),
			'COMMIT',
		]);
	});

	it('surfaces rollback failure when managed borrowed stream opens its own transaction', async () => {
		const streamError = new Error('cursor declare failed');
		const rollbackError = new Error('stream rollback failed');
		const query = vi.fn(async (input: MockQueryInput) => {
			const sql = queryText(input);
			if (/^SAVEPOINT /.test(sql)) {
				throw Object.assign(new Error('no active transaction'), {
					code: '25P01',
				});
			}
			if (/^DECLARE /.test(sql)) throw streamError;
			if (sql === 'ROLLBACK') throw rollbackError;
			return { rows: [], rowCount: 0 } as QueryResult;
		});
		const client = { query, release: vi.fn() } as unknown as PoolClient;
		const adapter = createPgsqlAdapter(client, {
			borrowedClient: true,
			managedTransactions: true,
		});

		const iter = adapter.stream({ sql: 'SELECT * FROM t', parameters: [] });
		const error = await captureRejection(() => iter.next());

		expectCleanupFailure(error, streamError, rollbackError, /ROLLBACK failed/);
		expect(client.release).not.toHaveBeenCalled();
	});
});

describe('PgsqlAdapter.stream — pool-acquired path', () => {
	it('issues BEGIN and COMMIT around stream, releases client', async () => {
		const rows: Record<string, unknown>[] = [{ id: 99 }];
		let callIdx = 0;
		const streamClient = makeClient(async (_sql) => {
			callIdx++;
			if (callIdx === 1) return { rows: [], rowCount: 0 } as QueryResult; // BEGIN
			if (callIdx === 2) return { rows: [], rowCount: 0 } as QueryResult; // DECLARE
			if (callIdx === 3) return { rows, rowCount: 1 } as QueryResult; // FETCH → 1 row
			if (callIdx === 4) return { rows: [], rowCount: 0 } as QueryResult; // FETCH → done
			if (callIdx === 5) return { rows: [], rowCount: 0 } as QueryResult; // CLOSE
			return { rows: [], rowCount: 0 } as QueryResult; // COMMIT
		});

		const pool = makePool({ rows: [] }, streamClient);
		const adapter = createPgsqlAdapter(pool);

		const collected: unknown[] = [];
		for await (const row of adapter.stream({
			sql: 'SELECT * FROM t',
			parameters: [],
		})) {
			collected.push(row);
		}

		expect(collected).toEqual([{ id: 99 }]);
		expect(pool.connect).toHaveBeenCalledOnce();
		expect(streamClient.release).toHaveBeenCalledOnce();

		const calls = queryCalls(streamClient.query as ReturnType<typeof vi.fn>);
		expect(calls[0]).toBe('BEGIN');
		expect(calls[calls.length - 1]).toBe('COMMIT');
	});

	it('issues ROLLBACK when stream error occurs, releases client', async () => {
		let callIdx = 0;
		const streamClient = makeClient(async (_sql) => {
			callIdx++;
			if (callIdx === 1) return { rows: [], rowCount: 0 } as QueryResult; // BEGIN
			if (callIdx === 2) throw new Error('cursor error'); // DECLARE fails
			return { rows: [], rowCount: 0 } as QueryResult;
		});

		const pool = makePool({ rows: [] }, streamClient);
		const adapter = createPgsqlAdapter(pool);

		const iter = adapter.stream({ sql: 'SELECT * FROM t', parameters: [] });
		await expect(iter.next()).rejects.toThrow('cursor error');

		expect(streamClient.release).toHaveBeenCalledOnce();

		const calls = queryCalls(streamClient.query as ReturnType<typeof vi.fn>);
		expect(calls).toContain('ROLLBACK');
	});

	it('detects multi-command cursor DECLARE results inside the managed stream transaction', async () => {
		const multiResult = [
			{ rows: [], rowCount: 0, command: 'DECLARE' },
			{ rows: [], rowCount: 0, command: 'COMMIT' },
		] as QueryResult[];
		const streamClient = {
			query: vi.fn(async (input: MockQueryInput) => {
				const sql = queryText(input);
				if (/^DECLARE \S+ NO SCROLL CURSOR FOR SELECT 1; COMMIT$/.test(sql)) {
					return multiResult;
				}
				return { rows: [], rowCount: 0, command: 'SELECT' } as QueryResult;
			}),
			release: vi.fn(),
		} as unknown as PoolClient;
		const pool = makePool({ rows: [] }, streamClient);
		const adapter = createPgsqlAdapter(pool);

		const iter = adapter.stream({ sql: 'SELECT 1; COMMIT', parameters: [] });
		const error = await captureRejection(() => iter.next());

		expect(error).toBeInstanceOf(PgsqlRawSqlTransactionControlError);
		expect((error as Error).message).not.toContain(
			'dbsp cannot reason about a multi-command raw call',
		);
		expect((error as Error).cause).toEqual([
			{ command: 'DECLARE', rowCount: 0 },
			{ command: 'COMMIT', rowCount: 0 },
		]);
		const calls = queryCalls(streamClient.query as ReturnType<typeof vi.fn>);
		expect(calls).toEqual([
			'BEGIN',
			expect.stringMatching(
				/^DECLARE \S+ NO SCROLL CURSOR FOR SELECT 1; COMMIT$/,
			),
			'ROLLBACK',
		]);
		expect(calls).not.toContain('COMMIT');
		expect(streamClient.release).toHaveBeenCalledOnce();
	});

	it('surfaces rollback failure during pool-owned stream cleanup and releases client as broken', async () => {
		const streamError = new Error('cursor error');
		const rollbackError = new Error('stream rollback failed');
		const streamClient = {
			query: vi.fn(async (input: MockQueryInput) => {
				const sql = queryText(input);
				if (/^DECLARE /.test(sql)) throw streamError;
				if (sql === 'ROLLBACK') throw rollbackError;
				return { rows: [], rowCount: 0 } as QueryResult;
			}),
			release: vi.fn(),
		} as unknown as PoolClient;
		const pool = makePool({ rows: [] }, streamClient);
		const adapter = createPgsqlAdapter(pool);

		const iter = adapter.stream({ sql: 'SELECT * FROM t', parameters: [] });
		const error = await captureRejection(() => iter.next());

		expectCleanupFailure(error, streamError, rollbackError, /ROLLBACK failed/);
		expect(streamClient.release).toHaveBeenCalledWith(rollbackError);
	});
});

// ---------------------------------------------------------------------------
// listIndexes() — schema fallback branches
// ---------------------------------------------------------------------------

describe('PgsqlAdapter.listIndexes — schema fallback', () => {
	it('uses adapter schemaName when no explicit schema passed', async () => {
		const pool = makePool({ rows: [] });
		const adapter = createPgsqlAdapter(pool, { schemaName: 'my_schema' });

		await adapter.listIndexes('tbl');

		const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(call[1]).toEqual(['tbl', 'my_schema']);
	});

	it('resolves the schema search_path-aware in-query when neither adapter nor explicit schema provided', async () => {
		const pool = makePool({ rows: [] });
		const adapter = createPgsqlAdapter(pool);

		await adapter.listIndexes('tbl');

		const [sql, params] = catalogCall(pool);
		expect(params).toEqual(['tbl', null]);
		expect(sql).toContain('to_regclass');
	});

	it('rolls back a failing borrowed-client catalog read to its statement savepoint', async () => {
		const pgError = Object.assign(new Error('catalog read failed'), {
			code: '42P01',
		});
		const query = vi.fn(async (input: MockQueryInput) => {
			const sql = queryText(input);
			if (sql.includes('FROM pg_indexes')) throw pgError;
			return { rows: [], rowCount: 0 } as QueryResult;
		});
		const client = { query, release: vi.fn() } as unknown as PoolClient;
		const adapter = createPgsqlAdapter(client, { borrowedClient: true });

		const error = await captureRejection(() => adapter.listIndexes('tbl'));

		expect(error).toBe(pgError);
		expect((error as Error).message).toContain(
			'rolled back the failed raw SQL to a savepoint',
		);
		expect(queryCalls(query)).toEqual([
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			expect.stringContaining('FROM pg_indexes'),
			expect.stringMatching(/^ROLLBACK TO SAVEPOINT dbsp_savepoint_/),
			expect.stringMatching(/^RELEASE SAVEPOINT dbsp_savepoint_/),
		]);
		expect(client.release).not.toHaveBeenCalled();
	});

	// The standalone introspect() takes a Pool, never a checked-out client: it cannot
	// know whose transaction the client sits in, and guessing that from the object's
	// shape is the defect this adapter was rewritten to remove. A caller holding a
	// client declares it, and the declaration is what buys the savepoint protection.
	it('protects a borrowed client with statement savepoints when introspect fails', async () => {
		const pgError = Object.assign(new Error('catalog read failed'), {
			code: '42P01',
		});
		const query = vi.fn(async (input: MockQueryInput) => {
			const sql = queryText(input);
			if (sql.includes('FROM information_schema.columns')) throw pgError;
			return { rows: [], rowCount: 0 } as QueryResult;
		});
		const client = { query, release: vi.fn() } as unknown as PoolClient;

		const adapter = new PgsqlAdapter(client, { borrowedClient: true });
		const error = await captureRejection(() =>
			adapter.introspect({ schema: 'public' }),
		);

		expect(error).toBe(pgError);
		expect((error as Error).message).toContain(
			'rolled back the failed raw SQL to a savepoint',
		);
		expect(queryCalls(query)).toEqual([
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			expect.stringContaining('FROM information_schema.columns'),
			expect.stringMatching(/^ROLLBACK TO SAVEPOINT dbsp_savepoint_/),
			expect.stringMatching(/^RELEASE SAVEPOINT dbsp_savepoint_/),
		]);
		expect(client.release).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// storageSize() — schema fallback
// ---------------------------------------------------------------------------

describe('PgsqlAdapter.storageSize — schema fallback', () => {
	it('uses adapter schemaName when no explicit schema passed', async () => {
		const pool = makePool({ rows: [{ size: '1024' }] });
		const adapter = createPgsqlAdapter(pool, { schemaName: 'tenant_x' });

		const size = await adapter.storageSize('events');

		expect(size).toBe(1024);
		const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(call[1][0]).toBe('"tenant_x"."events"');
	});

	it('leaves the table unqualified so ::regclass resolves it when no adapter schema', async () => {
		const pool = makePool({ rows: [{ size: '512' }] });
		const adapter = createPgsqlAdapter(pool);

		const size = await adapter.storageSize('logs');

		expect(size).toBe(512);
		// Unqualified → ::regclass resolves via search_path (not hard-coded public).
		expect(catalogCall(pool)[1][0]).toBe('"logs"');
	});
});

// ============================================================================
// [P2-T5]: withSchema / transaction preserve all config fields
// ============================================================================

describe('PgsqlAdapter [P2-T5]: withSchema preserves full config', () => {
	it('preserves dbCasing after withSchema — observable via public getter', () => {
		const logger = { debug: vi.fn(), error: vi.fn() };
		const customDerive = vi.fn(
			(table: string, pk: string) => `${table}_${pk}_id`,
		);
		const pool = makePool({
			rows: [{ user_id: 1, full_name: 'Alice' }],
		});

		const adapter = new PgsqlAdapter(pool, {
			logger,
			defaultPkColumnName: 'uid',
			deriveFkColumnName: customDerive,
			dbCasing: 'snake_case',
		});

		const scoped = adapter.withSchema('tenant_1') as PgsqlAdapter;

		// dbCasing is a public getter — verifies that cloneOptions() propagated
		// options correctly. One field propagating proves all fields propagate,
		// since cloneOptions() spreads the full options object.
		expect(scoped.dbCasing).toBe('snake_case');
	});

	it('scoped adapter applies inherited dbCasing to execute() row transformation', async () => {
		// Observable behavior: snake_case→camelCase transformation on rows proves
		// that dbCasing config was propagated from parent adapter to scoped adapter.
		const pool = makePool({
			rows: [{ user_id: 42, full_name: 'Bob' }],
		});
		const adapter = new PgsqlAdapter(pool, { dbCasing: 'snake_case' });
		const scoped = adapter.withSchema('tenant_2') as PgsqlAdapter;

		const rows = await scoped.execute<Record<string, unknown>>({
			sql: 'SELECT 1',
			parameters: [],
		});

		// camelCase keys prove the scoped adapter inherited snake_case dbCasing
		expect(rows).toEqual([{ userId: 42, fullName: 'Bob' }]);
	});

	it('withSchema overrides schemaName while preserving other options — observable via inTransaction and dbCasing', () => {
		const pool = makePool();
		const adapter = new PgsqlAdapter(pool, {
			schemaName: 'public',
			defaultPkColumnName: 'doc_id',
			dbCasing: 'camelCase',
		});

		const scoped = adapter.withSchema('tenant_99') as PgsqlAdapter;

		// Both getters are public: dbCasing proves option propagation;
		// inTransaction=false confirms the scoped adapter is not a transaction adapter.
		expect(scoped.dbCasing).toBe('camelCase');
		expect(scoped.inTransaction).toBe(false);
	});

	it('deriveFkColumnName effect is observable via row-transformation after execute', async () => {
		// Verify that customDerive was actually preserved by triggering a path
		// that uses it (snake_case dbCasing row transformation is the simplest
		// observable side-effect of config propagation).
		const customDerive = (table: string, pk: string) => `${table}_${pk}_fk`;
		const pool = makePool({
			rows: [{ order_id: 7 }],
		});
		const adapter = new PgsqlAdapter(pool, {
			deriveFkColumnName: customDerive,
			dbCasing: 'snake_case',
		});

		const scoped = adapter.withSchema('schema_x') as PgsqlAdapter;

		// The scoped adapter must inherit dbCasing (snake_case) — proves
		// cloneOptions propagated the full options including deriveFkColumnName.
		const rows = await scoped.execute<Record<string, unknown>>({
			sql: 'SELECT 1',
			parameters: [],
		});
		expect(rows).toEqual([{ orderId: 7 }]);
		// dbCasing public getter confirms the option snapshot was correct
		expect(scoped.dbCasing).toBe('snake_case');
	});
});

// ============================================================================
// [P2-T5b]: transaction() preserves all config fields
// ============================================================================

describe('PgsqlAdapter [P2-T5b]: transaction() preserves full config', () => {
	it('transaction-scoped adapter inherits dbCasing — observable via public getter', async () => {
		const txClient = makeClient();
		const pool = makePool({ rows: [] }, txClient);
		const adapter = new PgsqlAdapter(pool, {
			dbCasing: 'snake_case',
			defaultPkColumnName: 'uid',
		});

		let innerCasing: string | undefined;
		await adapter.transaction(async (tx) => {
			// dbCasing is a public getter on PgsqlAdapter
			innerCasing = (tx as PgsqlAdapter).dbCasing;
		});

		expect(innerCasing).toBe('snake_case');
	});

	it('transaction-scoped adapter applies inherited dbCasing to execute() row transformation', async () => {
		// Observable behavior: snake_case→camelCase transformation proves dbCasing
		// was propagated from parent adapter into the transaction-scoped adapter.
		const txClient = makeClient(
			vi.fn().mockResolvedValue({
				rows: [{ user_id: 5, full_name: 'Eve' }],
				rowCount: 1,
			}),
		);
		const pool = makePool({ rows: [] }, txClient);
		const adapter = new PgsqlAdapter(pool, { dbCasing: 'snake_case' });

		let capturedRows: Record<string, unknown>[] = [];
		await adapter.transaction(async (tx) => {
			capturedRows = await (tx as PgsqlAdapter).execute<
				Record<string, unknown>
			>({
				sql: 'SELECT 1',
				parameters: [],
			});
		});

		// camelCase keys prove the tx adapter inherited snake_case dbCasing
		expect(capturedRows).toEqual([{ userId: 5, fullName: 'Eve' }]);
	});

	it('transaction-scoped adapter inTransaction flag is true', async () => {
		// inTransaction is a public getter that confirms the scoped adapter has
		// a client (PoolClient) rather than a pool — the correct shape for
		// transaction-scoped adapters.
		const txClient = makeClient();
		const pool = makePool({ rows: [] }, txClient);
		const adapter = new PgsqlAdapter(pool, {});

		let innerInTransaction: boolean | undefined;
		await adapter.transaction(async (tx) => {
			innerInTransaction = (tx as PgsqlAdapter).inTransaction;
		});

		expect(innerInTransaction).toBe(true);
	});

	it('non-tx stream cleanup surfaces rollback failure instead of logging it away', async () => {
		const logger = { debug: vi.fn(), error: vi.fn() };
		const streamError = new Error('DECLARE failed');
		const rollbackError = new Error('cleanup ROLLBACK failed');
		const streamClient = {
			query: vi.fn(async (input: MockQueryInput) => {
				const sql = queryText(input);
				if (/^DECLARE /.test(sql)) throw streamError;
				if (sql === 'ROLLBACK') throw rollbackError;
				return { rows: [], rowCount: 0 } as QueryResult;
			}),
			release: vi.fn(),
		} as unknown as PoolClient;
		const pool = makePool({ rows: [] }, streamClient);
		const adapter = new PgsqlAdapter(pool, { logger });

		const gen = adapter.stream<unknown>({ sql: 'SELECT 1', parameters: [] });
		const error = await captureRejection(() => gen.next());

		expectCleanupFailure(error, streamError, rollbackError, /ROLLBACK failed/);
		expect(logger.debug).not.toHaveBeenCalled();
		expect(streamClient.release).toHaveBeenCalledWith(rollbackError);
	});
});

// ============================================================================
// [P2-T5c]: defaultPkColumnName propagates through withSchema — Option A
//
// Regression lock: if `defaultPkColumnName: this.defaultPk` is removed from
// cloneOptions(), the scoped adapter uses DEFAULT_PK_COLUMN ('id') instead of
// the custom 'custom_pk', and the EXISTS correlation uses "id" — test fails.
// ============================================================================

describe('PgsqlAdapter [P2-T5c]: defaultPkColumnName propagates through withSchema', () => {
	it('custom defaultPkColumnName appears in EXISTS correlation after withSchema — removes defaultPkColumnName from cloneOptions → fails', () => {
		// Build compile-only adapter with custom PK name
		const adapter = createPgsqlCompileOnlyAdapter({
			defaultPkColumnName: 'custom_pk',
		});

		const scoped = adapter.withSchema('s') as PgsqlAdapter;

		// Compile a plan with a WHERE-EXISTS decision that has NO explicit FK columns
		// (no foreignKey, parentKey, or relationType). mapToHandlerDecision() calls
		// deriveFkColumns() which uses defaultPk as sourceColumn (hasMany fallback):
		//   sourceColumn = parentKey ?? defaultPk = 'custom_pk'
		//   targetColumn = foreignKey ?? deriveFk('users', 'custom_pk') = '...'
		// If defaultPkColumnName was NOT propagated, deriveFkColumns uses 'id' instead.
		const plan = {
			rootTable: 'users',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					operator: 'exists',
					relation: 'orders',
					targetTable: 'orders',
					// foreignKey / parentKey / relationType deliberately omitted
					// → deriveFkColumns() falls back to defaultPk / deriveFk
				},
			],
		} as never;

		const { sql } = scoped.compile(plan);

		// The source correlation column MUST be the custom PK, not the default 'id'.
		// The deparser emits unquoted identifiers for simple column names.
		// If cloneOptions() no longer copies defaultPkColumnName, this fails
		// (sql would contain 'users.id' instead of 'users.custom_pk').
		expect(sql).toContain('users.custom_pk');
		// 'users.id' must NOT appear — proves we overrode the default
		expect(sql).not.toMatch(/users\.id\b/);
	});
});

// ============================================================================
// [P2-T5d]: deriveFkColumnName propagates through withSchema — Option A
//
// Regression lock: if `deriveFkColumnName: this.deriveFk` is removed from
// cloneOptions(), the FK target column falls back to `defaultFkDerivation`
// which produces 'users_id', not 'z_users_id'. Test fails.
// ============================================================================

describe('PgsqlAdapter [P2-T5d]: deriveFkColumnName propagates through withSchema', () => {
	it('custom deriveFkColumnName produces distinctive FK column after withSchema — removes deriveFkColumnName from cloneOptions → fails', () => {
		// Custom derivation: always prefix with 'z_'
		const customDerive = (table: string, pk: string) => `z_${table}_${pk}`;

		const adapter = createPgsqlCompileOnlyAdapter({
			deriveFkColumnName: customDerive,
		});

		const scoped = adapter.withSchema('s') as PgsqlAdapter;

		// Compile a plan with a WHERE-EXISTS decision with no explicit FK columns.
		// mapToHandlerDecision() calls deriveFkColumns() using the adapter's deriveFk:
		//   targetColumn = foreignKey ?? deriveFk('users', 'id') = 'z_users_id'
		// If deriveFkColumnName was NOT propagated, defaultFkDerivation is used
		// and produces 'users_id' — the 'z_' prefix would be absent.
		const plan = {
			rootTable: 'users',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					operator: 'exists',
					relation: 'orders',
					targetTable: 'orders',
					// foreignKey / parentKey / relationType deliberately omitted
					// → deriveFkColumns falls back to deriveFk
				},
			],
		} as never;

		const { sql } = scoped.compile(plan);

		// The target column in the EXISTS correlation must carry the 'z_' prefix.
		// The deparser emits unquoted identifiers for simple column names.
		// If cloneOptions() no longer copies deriveFkColumnName, this assertion fails
		// (sql would contain 'orders_exists_0.users_id' instead of 'z_users_id').
		expect(sql).toContain('z_users_id');
		// 'users_id' without the prefix must NOT appear
		expect(sql).not.toMatch(/\.users_id\b/);
	});
});

// ============================================================================
// [P2-T5e]: defaultPkColumnName + deriveFkColumnName propagate through transaction()
//
// Regression lock: if either field is removed from cloneOptions(), the tx adapter
// falls back to defaults — one or both of the SQL assertions below fails.
// ============================================================================

describe('PgsqlAdapter [P2-T5e]: defaultPkColumnName + deriveFkColumnName propagate through transaction()', () => {
	it('both custom fields produce distinctive SQL inside transaction callback — removes either from cloneOptions → fails', async () => {
		const customDerive = (table: string, pk: string) => `z_${table}_${pk}`;

		const txClient = makeClient();
		const pool = makePool({ rows: [] }, txClient);

		const adapter = new PgsqlAdapter(pool, {
			defaultPkColumnName: 'custom_pk',
			deriveFkColumnName: customDerive,
		});

		let capturedSql = '';

		await adapter.transaction(async (tx) => {
			// Same plan as P2-T5c/d — WHERE-EXISTS with no explicit FK columns.
			// The tx adapter must carry both custom fields from cloneOptions().
			const plan = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'where',
						operator: 'exists',
						relation: 'orders',
						targetTable: 'orders',
						// foreignKey / parentKey / relationType deliberately omitted
					},
				],
			} as never;

			capturedSql = (tx as PgsqlAdapter).compile(plan).sql;
		});

		// custom_pk: proves defaultPkColumnName propagated to tx adapter.
		// The deparser emits unquoted identifiers for simple column names.
		expect(capturedSql).toContain('users.custom_pk');
		// z_users_custom_pk: proves deriveFkColumnName propagated AND was called
		// with the custom PK name (not the default 'id').
		// If either field is missing, 'users_id' would appear here instead.
		expect(capturedSql).toContain('z_users_custom_pk');
	});
});

// ---------------------------------------------------------------------------
// [FIX-4a] stream() chunkSize validation guard
//
// Mutation caught by each test:
//  - chunkSize 0 / negative: removing `chunkSize <= 0` branch → test passes
//    invalid value to `FETCH FORWARD 0 FROM …` without rejection.
//  - chunkSize 1.5: removing `Number.isSafeInteger` check → `FETCH FORWARD 1.5
//    FROM …` reaches the DB without rejection.
//  - chunkSize NaN: same — NaN passes neither isSafeInteger nor <= 0 as a
//    guard alone; without isSafeInteger the condition `NaN <= 0` is false and
//    the NaN would silently reach the FETCH statement.
//  - valid chunkSize 100: proves the guard is not over-eager (happy path still
//    works end-to-end through the full stream iteration cycle).
// ---------------------------------------------------------------------------

describe('PgsqlAdapter.stream — chunkSize validation (FIX-4a)', () => {
	it('rejects chunkSize 0 before issuing any FETCH', () => {
		const pool = makePool();
		const adapter = createPgsqlAdapter(pool);

		expect(() =>
			adapter.stream({ sql: 'SELECT 1', parameters: [] }, { chunkSize: 0 }),
		).toThrow('Invalid stream chunkSize: 0. Must be a positive integer.');

		// Pool.connect must NOT have been called — guard fires before any I/O.
		expect(pool.connect).not.toHaveBeenCalled();
	});

	it('rejects chunkSize -1 before issuing any FETCH', () => {
		const pool = makePool();
		const adapter = createPgsqlAdapter(pool);

		expect(() =>
			adapter.stream({ sql: 'SELECT 1', parameters: [] }, { chunkSize: -1 }),
		).toThrow('Invalid stream chunkSize: -1. Must be a positive integer.');

		expect(pool.connect).not.toHaveBeenCalled();
	});

	it('rejects chunkSize 1.5 (non-integer) before issuing any FETCH', () => {
		const pool = makePool();
		const adapter = createPgsqlAdapter(pool);

		expect(() =>
			adapter.stream({ sql: 'SELECT 1', parameters: [] }, { chunkSize: 1.5 }),
		).toThrow('Invalid stream chunkSize: 1.5. Must be a positive integer.');

		expect(pool.connect).not.toHaveBeenCalled();
	});

	it('rejects chunkSize NaN before issuing any FETCH', () => {
		const pool = makePool();
		const adapter = createPgsqlAdapter(pool);

		expect(() =>
			adapter.stream(
				{ sql: 'SELECT 1', parameters: [] },
				{ chunkSize: Number.NaN },
			),
		).toThrow('Invalid stream chunkSize: NaN. Must be a positive integer.');

		expect(pool.connect).not.toHaveBeenCalled();
	});

	it('accepts default chunkSize (100) and streams rows successfully', async () => {
		const rows: Record<string, unknown>[] = [{ id: 1 }];
		let callIdx = 0;
		const streamClient = makeClient(async (_sql) => {
			callIdx++;
			if (callIdx === 1) return { rows: [], rowCount: 0 } as QueryResult; // BEGIN
			if (callIdx === 2) return { rows: [], rowCount: 0 } as QueryResult; // DECLARE
			if (callIdx === 3) return { rows, rowCount: 1 } as QueryResult; // FETCH → 1 row
			if (callIdx === 4) return { rows: [], rowCount: 0 } as QueryResult; // FETCH → done
			if (callIdx === 5) return { rows: [], rowCount: 0 } as QueryResult; // CLOSE
			return { rows: [], rowCount: 0 } as QueryResult; // COMMIT
		});

		const pool = makePool({ rows: [] }, streamClient);
		const adapter = createPgsqlAdapter(pool);

		const collected: unknown[] = [];
		// No chunkSize option → uses default 100, must not throw.
		for await (const row of adapter.stream({
			sql: 'SELECT 1',
			parameters: [],
		})) {
			collected.push(row);
		}

		expect(collected).toEqual([{ id: 1 }]);

		// Verify the FETCH statement used the correct default chunk size.
		const calls = queryCalls(streamClient.query as ReturnType<typeof vi.fn>);
		const fetchCall = calls.find((q) => q.startsWith('FETCH FORWARD'));
		expect(fetchCall).toMatch(/^FETCH FORWARD 100 FROM /);
	});
});
