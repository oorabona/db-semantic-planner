/**
 * Proof tests for Commit 3 -- Query-builder correctness
 * Covers FIND-016 through FIND-020.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Adapter, Dump, TransactionOptions } from '../adapter.js';
import { createHookManager } from './hooks.js';
import { createOrm } from './orm.js';
import { ref, schema } from './schema.js';
import { createMockAdapter } from './test-utils.js';

const ambiguousSchema = schema({
	users: { id: { type: 'integer', primaryKey: true }, name: 'string' },
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: 'string',
		authorId: ref('users', { as: 'author', inverse: 'authoredPosts' }),
		reviewerId: ref('users', { as: 'reviewer', inverse: 'reviewedPosts' }),
	},
});

const simpleSchema = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		active: 'boolean',
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: 'string',
		authorId: ref('users', { as: 'author', inverse: 'posts' }),
	},
});

function createSpyAdapter(executeResult: unknown[] = []) {
	const base = createMockAdapter();
	const compileSpy = vi.fn((_plan: unknown, _opts?: unknown) => ({
		sql: 'SELECT * FROM "users"',
		parameters: [] as readonly unknown[],
	}));
	const compileWithIncludesSpy = vi.fn((_plan: unknown, _opts?: unknown) => ({
		main: {
			sql: 'SELECT * FROM "users"',
			parameters: [] as readonly unknown[],
		},
		subqueryIncludes: [],
	}));
	const executeSpy = vi.fn(() => Promise.resolve([...executeResult]));
	const createDumpSpy = vi.fn(
		(
			_plan: unknown,
			compiled: { sql: string; parameters: readonly unknown[] },
		) =>
			({
				sql: compiled.sql,
				params: compiled.parameters,
				plan: {},
			}) as unknown as Dump,
	);
	const adapter = {
		...base,
		capabilities: {
			...base.capabilities,
			supportsStreaming: true,
		},
		compile: compileSpy,
		compileWithIncludes: compileWithIncludesSpy,
		execute: executeSpy,
		createDump: createDumpSpy,
		withSchema: (_schemaName: string) => adapter,
		stream: vi.fn(async function* (_compiled: unknown, _opts?: unknown) {
			for (const row of executeResult) yield row;
		}),
	} as unknown as Adapter;
	return adapter;
}

describe('FIND-016: exists() respects lenient-mode ambiguity resolution', () => {
	it('all() auto-resolves ambiguous relation in lenient mode', () => {
		const orm = createOrm({
			adapter: createSpyAdapter(),
			schema: ambiguousSchema,
			strictMode: false,
		});
		expect(() => orm.select('users').include('posts').plan()).not.toThrow();
	});
	it('exists() auto-resolves in lenient mode (REGRESSION GATE)', async () => {
		const orm = createOrm({
			adapter: createSpyAdapter([{ exists: true }]),
			schema: ambiguousSchema,
			strictMode: false,
		});
		await expect(orm.select('users').include('posts').exists()).resolves.toBe(
			true,
		);
	});
	it('existsDump() does not throw in lenient mode (REGRESSION GATE)', () => {
		const orm = createOrm({
			adapter: createSpyAdapter(),
			schema: ambiguousSchema,
			strictMode: false,
		});
		expect(() =>
			orm.select('users').include('posts').existsDump(),
		).not.toThrow();
	});
	it('existsDump() returns a Dump (planWithAmbiguityHandling smoke test)', () => {
		// existsDump() uses planWithAmbiguityHandling — verify it produces a Dump
		// without throwing. The plan field is the adapter's mock object.
		const adapter = createSpyAdapter();
		const orm = createOrm({
			adapter,
			schema: ambiguousSchema,
			strictMode: false,
		});
		const dump = orm.select('users').existsDump();
		expect(dump).toBeDefined();
		expect(typeof dump.sql).toBe('string');
		// plan field present (mock returns {})
		expect(dump.plan).toBeDefined();
	});
	it('exists() resolves for a simple (non-include) query in strict mode', async () => {
		// exists() strips includes before planning, so include-based ambiguity
		// is never presented to the planner from this path. A basic exists() in
		// strict mode must still work.
		const orm = createOrm({
			adapter: createSpyAdapter([{ exists: true }]),
			schema: ambiguousSchema,
			strictMode: true,
		});
		await expect(orm.select('users').exists()).resolves.toBe(true);
	});
});

describe('FIND-017: stream() compiles SQL AFTER beforeQuery hooks run', () => {
	it('compile() NOT called at stream() creation -- only on first next() (REGRESSION GATE)', async () => {
		const rows = [{ id: 1, name: 'Alice', active: true }];
		const adapter = createSpyAdapter(rows);
		const hookManager = createHookManager().beforeQuery((ctx) => ({
			...ctx,
			intent: {
				...ctx.intent,
				where: {
					kind: 'comparison',
					field: 'active',
					operator: 'eq',
					value: true,
				},
			},
		}));
		const orm = createOrm({
			adapter,
			schema: simpleSchema,
			hooks: hookManager,
		});
		const compileSpy = (
			adapter as unknown as { compile: ReturnType<typeof vi.fn> }
		).compile;
		expect(compileSpy).toHaveBeenCalledTimes(0);
		const iterator = orm.select('users').stream();
		expect(compileSpy).toHaveBeenCalledTimes(0);
		await iterator.next();
		expect(compileSpy).toHaveBeenCalledTimes(1);
	});
	it('stream() refuses before calling adapter.stream when streaming is unsupported', async () => {
		const base = createMockAdapter();
		const streamSpy = vi.fn(
			// biome-ignore lint/correctness/useYield: core must refuse before the adapter is reached, so this never gets far enough to yield
			async function* () {
				throw new Error('adapter stream should not be called');
			},
		);
		const adapter = {
			...base,
			stream: streamSpy,
		} as unknown as Adapter;
		const orm = createOrm({ adapter, schema: simpleSchema });
		const iterator = orm.select('users').stream();

		let error: unknown;
		try {
			await iterator.next();
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain('supportsStreaming: false');
		expect((error as Error).message).not.toContain('managedTransactions');
		expect(streamSpy).not.toHaveBeenCalled();
	});
	it('transaction() rejects non-empty options unless the adapter declares support', async () => {
		const baseAdapter = createSpyAdapter();
		let transactionAdapter: Adapter;
		const transactionSpy = vi.fn(
			async (fn: (txAdapter: Adapter) => Promise<unknown>) => {
				return fn(transactionAdapter);
			},
		);
		transactionAdapter = {
			...baseAdapter,
			capabilities: {
				...baseAdapter.capabilities,
				supportsTransactions: true,
			},
			transaction: transactionSpy,
			withSchema: (_schemaName: string) => transactionAdapter,
		} as unknown as Adapter;
		const orm = createOrm({
			adapter: transactionAdapter,
			schema: simpleSchema,
		});

		await expect(
			orm.transaction(async () => 'ok', { readOnly: true }),
		).rejects.toThrow('does not support transaction options');
		expect(transactionSpy).not.toHaveBeenCalled();

		await expect(
			orm.transaction(async () => 'ok', {
				signal: new AbortController().signal,
			}),
		).rejects.toThrow('does not support transaction options');
		expect(transactionSpy).not.toHaveBeenCalled();

		const allUndefinedOptions = {
			isolationLevel: undefined,
			readOnly: undefined,
			lockTimeoutMs: undefined,
			statementTimeoutMs: undefined,
			signal: undefined,
		} as unknown as TransactionOptions;

		await expect(
			orm.transaction(async () => 'ok', allUndefinedOptions),
		).resolves.toBe('ok');
		expect(transactionSpy).toHaveBeenCalledWith(
			expect.any(Function),
			allUndefinedOptions,
		);
	});
	it('transaction() and stream() delegate when the adapter declares both capabilities', async () => {
		const baseAdapter = createSpyAdapter([{ id: 1 }]);
		let capableAdapter: Adapter;
		const transactionSpy = vi.fn(
			async (
				fn: (txAdapter: Adapter) => Promise<unknown>,
				_options?: TransactionOptions,
			) => {
				return fn(capableAdapter);
			},
		);
		capableAdapter = {
			...baseAdapter,
			capabilities: {
				...baseAdapter.capabilities,
				supportsStreaming: true,
				supportsTransactions: true,
				supportsTransactionOptions: true,
			},
			transaction: transactionSpy,
			withSchema: (_schemaName: string) => capableAdapter,
		} as unknown as Adapter;
		const orm = createOrm({ adapter: capableAdapter, schema: simpleSchema });

		const transactionOptions = {
			isolationLevel: 'repeatable read',
			readOnly: true,
		} satisfies TransactionOptions;

		await expect(
			orm.transaction(async () => {
				return 'ok';
			}, transactionOptions),
		).resolves.toBe('ok');

		const collected: unknown[] = [];
		for await (const row of orm.select('users').stream()) collected.push(row);

		expect(collected).toEqual([{ id: 1 }]);
		expect(transactionSpy).toHaveBeenCalledWith(
			expect.any(Function),
			transactionOptions,
		);
		expect(capableAdapter.stream).toHaveBeenCalledTimes(1);
	});
	it('stream() without hooks yields all rows', async () => {
		const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
		const adapter = createSpyAdapter(rows);
		const orm = createOrm({ adapter, schema: simpleSchema });
		const collected: unknown[] = [];
		for await (const row of orm.select('users').stream()) collected.push(row);
		expect(collected).toHaveLength(3);
	});
	it('onStart callback fires on first next()', async () => {
		const adapter = createSpyAdapter([{ id: 1 }]);
		const orm = createOrm({ adapter, schema: simpleSchema });
		let capturedDump: Dump | null = null;
		const iterator = orm.select('users').stream({
			onStart: (d) => {
				capturedDump = d;
			},
		});
		await iterator.next();
		expect(capturedDump).not.toBeNull();
		expect(typeof capturedDump!.sql).toBe('string');
	});
});

describe('FIND-018: paginate() count query uses full query state', () => {
	it('count query executed -- two execute calls', async () => {
		const rows = Array.from({ length: 5 }, (_, i) => ({ id: i + 1 }));
		const adapter = createSpyAdapter(rows);
		const orm = createOrm({ adapter, schema: simpleSchema });
		let idx = 0;
		(adapter as unknown as { execute: ReturnType<typeof vi.fn> }).execute =
			vi.fn(() => {
				idx++;
				return idx === 1
					? Promise.resolve(rows)
					: Promise.resolve([{ _count: 50 }]);
			});
		const result = await orm
			.select('users')
			.paginate({ page: 1, perPage: 5, withCount: true });
		expect(result.pagination.total).toBe(50);
		expect(
			(adapter as unknown as { execute: ReturnType<typeof vi.fn> }).execute,
		).toHaveBeenCalledTimes(2);
	});
	it('count uses full intent -- two compileWithIncludes calls', async () => {
		const rows = [{ id: 1 }];
		const adapter = createSpyAdapter(rows);
		const orm = createOrm({ adapter, schema: simpleSchema });
		const cwis = (
			adapter as unknown as { compileWithIncludes: ReturnType<typeof vi.fn> }
		).compileWithIncludes;
		let idx = 0;
		(adapter as unknown as { execute: ReturnType<typeof vi.fn> }).execute =
			vi.fn(async () => {
				idx++;
				return idx === 1 ? rows : [{ _count: 10 }];
			});
		await orm
			.select('users')
			.where({ active: true })
			.paginate({ page: 1, perPage: 5, withCount: true });
		expect(cwis).toHaveBeenCalledTimes(2);
	});
	it('withCount: false -- single execute, no total', async () => {
		const adapter = createSpyAdapter([{ id: 1 }]);
		const orm = createOrm({ adapter, schema: simpleSchema });
		const executeSpy = (
			adapter as unknown as { execute: ReturnType<typeof vi.fn> }
		).execute;
		const result = await orm
			.select('users')
			.paginate({ page: 1, perPage: 10, withCount: false });
		expect(executeSpy).toHaveBeenCalledTimes(1);
		expect(result.pagination.total).toBeUndefined();
	});
});

describe('M-1 regression: paginate() count wraps GROUP BY as subquery', () => {
	it('groupBy query: compile() called for base, executeRaw() called with wrapped SQL', async () => {
		// Setup: spy adapter that records the count SQL
		const adapter = createSpyAdapter([{ id: 1 }]);
		let executeRawCallCount = 0;
		let countSql = '';
		(adapter as unknown as { execute: ReturnType<typeof vi.fn> }).execute =
			vi.fn(async () => [{ id: 1 }, { id: 2 }]);
		(
			adapter as unknown as { executeRaw: ReturnType<typeof vi.fn> }
		).executeRaw = vi.fn(async (sql: string) => {
			executeRawCallCount++;
			countSql = sql;
			return [{ _count: 3 }]; // 3 distinct groups
		});

		const orm = createOrm({ adapter, schema: simpleSchema });
		const result = await orm
			.select('users')
			.groupBy(['active'])
			.paginate({ page: 1, perPage: 10, withCount: true });

		// The count should be 3 (from the subquery-wrapped count), not the first group count
		expect(result.pagination.total).toBe(3);
		// The count SQL must wrap the base query as a subquery (not a plain GROUP BY count)
		// Format: SELECT COUNT(*) AS "_count" FROM (base_sql) _count_subq
		expect(countSql).toMatch(/^SELECT COUNT\(\*\) AS "_count" FROM \(/);
		expect(countSql).toMatch(/\) _count_subq$/);
		expect(executeRawCallCount).toBe(1);
	});
});

describe('FIND-019: cursorPaginate buildCursor with field-based orderBy', () => {
	it('string orderBy field encoded in cursor (positive path)', async () => {
		const rows = [{ id: 11 }, { id: 12 }];
		const adapter = createSpyAdapter(rows);
		const orm = createOrm({ adapter, schema: simpleSchema });
		const cursor = Buffer.from(JSON.stringify({ id: 10 }), 'utf-8').toString(
			'base64',
		);
		const result = await orm
			.select('users')
			.orderBy('id')
			.cursorPaginate({ cursor, limit: 2, direction: 'forward' });
		expect(result.data).toHaveLength(2);
		if (result.prevCursor) {
			const decoded = JSON.parse(
				Buffer.from(result.prevCursor, 'base64').toString('utf-8'),
			);
			expect(decoded).toHaveProperty('id');
		}
	});
	it('empty result set: no cursor built, no throw', async () => {
		const adapter = createSpyAdapter([]);
		const orm = createOrm({ adapter, schema: simpleSchema });
		const result = await orm
			.select('users')
			.orderBy('id')
			.cursorPaginate({ limit: 5 });
		expect(result.data).toHaveLength(0);
		expect(result.nextCursor).toBeNull();
		expect(result.prevCursor).toBeNull();
	});
	it('L-3: limit=0 returns empty page without throwing (hasNextPage=true when rows exist)', async () => {
		// DB returns 1 row (limit+1 = 0+1 = 1) — the "extra" row proves there IS a next page.
		// The caller gets data=[], hasNextPage=true.
		const adapter = createSpyAdapter([{ id: 1 }]);
		const orm = createOrm({ adapter, schema: simpleSchema });
		const result = await orm
			.select('users')
			.orderBy('id')
			.cursorPaginate({ limit: 0 });
		expect(result.data).toEqual([]);
		expect(result.hasNextPage).toBe(true);
	});
	it('L-3: limit=0 with empty DB returns empty page with hasNextPage=false', async () => {
		const adapter = createSpyAdapter([]);
		const orm = createOrm({ adapter, schema: simpleSchema });
		const result = await orm
			.select('users')
			.orderBy('id')
			.cursorPaginate({ limit: 0 });
		expect(result.data).toEqual([]);
		expect(result.hasNextPage).toBe(false);
	});
});

describe('FIND-020: backward cursor inverts ORDER BY and reverses result', () => {
	it('backward+asc: reversed to ASC for caller (REGRESSION GATE)', async () => {
		const dbRows = [{ id: 49 }, { id: 48 }, { id: 47 }, { id: 46 }, { id: 45 }];
		const adapter = createSpyAdapter(dbRows);
		const orm = createOrm({ adapter, schema: simpleSchema });
		const cursor = Buffer.from(JSON.stringify({ id: 50 }), 'utf-8').toString(
			'base64',
		);
		const result = await orm
			.select('users')
			.orderBy('id', 'asc')
			.cursorPaginate({ cursor, limit: 5, direction: 'backward' });
		expect(result.data).toHaveLength(5);
		const ids = result.data.map((r) => (r as { id: number }).id);
		expect(ids).toEqual([45, 46, 47, 48, 49]);
	});
	it('backward+desc: reversed to DESC for caller', async () => {
		const dbRows = [{ id: 51 }, { id: 52 }, { id: 53 }, { id: 54 }, { id: 55 }];
		const adapter = createSpyAdapter(dbRows);
		const orm = createOrm({ adapter, schema: simpleSchema });
		const cursor = Buffer.from(JSON.stringify({ id: 50 }), 'utf-8').toString(
			'base64',
		);
		const result = await orm
			.select('users')
			.orderBy('id', 'desc')
			.cursorPaginate({ cursor, limit: 5, direction: 'backward' });
		const ids = result.data.map((r) => (r as { id: number }).id);
		expect(ids).toEqual([55, 54, 53, 52, 51]);
	});
	it('backward with extra row (hasMore=true): slice-then-reverse', async () => {
		const dbRows = [
			{ id: 49 },
			{ id: 48 },
			{ id: 47 },
			{ id: 46 },
			{ id: 45 },
			{ id: 44 },
		];
		const adapter = createSpyAdapter(dbRows);
		const orm = createOrm({ adapter, schema: simpleSchema });
		const cursor = Buffer.from(JSON.stringify({ id: 50 }), 'utf-8').toString(
			'base64',
		);
		const result = await orm
			.select('users')
			.orderBy('id', 'asc')
			.cursorPaginate({ cursor, limit: 5, direction: 'backward' });
		expect(result.data).toHaveLength(5);
		const ids = result.data.map((r) => (r as { id: number }).id);
		expect(ids).toEqual([45, 46, 47, 48, 49]);
		expect(result.hasPrevPage).toBe(true);
	});
	it('forward cursor: rows unchanged (control)', async () => {
		const rows = [{ id: 51 }, { id: 52 }, { id: 53 }];
		const adapter = createSpyAdapter(rows);
		const orm = createOrm({ adapter, schema: simpleSchema });
		const cursor = Buffer.from(JSON.stringify({ id: 50 }), 'utf-8').toString(
			'base64',
		);
		const result = await orm
			.select('users')
			.orderBy('id', 'asc')
			.cursorPaginate({ cursor, limit: 3, direction: 'forward' });
		const ids = result.data.map((r) => (r as { id: number }).id);
		expect(ids).toEqual([51, 52, 53]);
	});
});

describe('M-1 regression: backward cursorPaginate returns correct nextCursor/prevCursor', () => {
	it('backward page with hasMore=true: nextCursor encodes highest row, prevCursor encodes lowest row', async () => {
		// ASC sort, cursor=50 (backward), limit=4.
		// DB returns limit+1=5 rows (inverted ORDER BY DESC): [49,48,47,46,45].
		// hasMore=true (5 > 4), sliced=[49,48,47,46], data (reversed)=[46,47,48,49].
		// nextCursor MUST encode row 49 (highest/forward-most).
		// prevCursor MUST encode row 46 (lowest/backward-most).
		// The pre-fix bug had these two swapped.
		const dbRows = [{ id: 49 }, { id: 48 }, { id: 47 }, { id: 46 }, { id: 45 }]; // 5 rows for limit=4
		const adapter = createSpyAdapter(dbRows);
		const orm = createOrm({ adapter, schema: simpleSchema });
		const cursor50 = Buffer.from(JSON.stringify({ id: 50 }), 'utf-8').toString(
			'base64',
		);
		const result = await orm
			.select('users')
			.orderBy('id', 'asc')
			.cursorPaginate({ cursor: cursor50, limit: 4, direction: 'backward' });

		expect(result.data).toHaveLength(4);
		expect(result.hasPrevPage).toBe(true);

		// nextCursor must encode the highest id in data (49) — forward re-entry point
		expect(result.nextCursor).not.toBeNull();
		const nextDecoded = JSON.parse(
			Buffer.from(result.nextCursor!, 'base64').toString('utf-8'),
		) as { id: number };
		expect(nextDecoded.id).toBe(49);

		// prevCursor must encode the lowest id in data (46) — backward extension point
		expect(result.prevCursor).not.toBeNull();
		const prevDecoded = JSON.parse(
			Buffer.from(result.prevCursor!, 'base64').toString('utf-8'),
		) as { id: number };
		expect(prevDecoded.id).toBe(46);
	});

	it('backward page with hasMore=true: nextCursor > prevCursor (no inversion)', async () => {
		// Secondary regression gate: after the swap fix, nextCursor must always encode
		// a value >= prevCursor for ASC sort. If they are swapped, nextDecoded.id < prevDecoded.id.
		const dbRows = [{ id: 44 }, { id: 43 }, { id: 42 }, { id: 41 }, { id: 40 }]; // 5 rows for limit=4
		const adapter = createSpyAdapter(dbRows);
		const orm = createOrm({ adapter, schema: simpleSchema });
		const cursor45 = Buffer.from(JSON.stringify({ id: 45 }), 'utf-8').toString(
			'base64',
		);
		const result = await orm
			.select('users')
			.orderBy('id', 'asc')
			.cursorPaginate({ cursor: cursor45, limit: 4, direction: 'backward' });

		expect(result.nextCursor).not.toBeNull();
		expect(result.prevCursor).not.toBeNull();
		const nextId = (
			JSON.parse(
				Buffer.from(result.nextCursor!, 'base64').toString('utf-8'),
			) as { id: number }
		).id;
		const prevId = (
			JSON.parse(
				Buffer.from(result.prevCursor!, 'base64').toString('utf-8'),
			) as { id: number }
		).id;
		// For ASC sort, nextCursor (forward-most) must be >= prevCursor (backward-most)
		expect(nextId).toBeGreaterThanOrEqual(prevId);
	});

	it('forward-then-backward round-trip: prevCursor from forward page encodes first row', async () => {
		// Forward page: data=[51,52,53], hasMore=true (extra row 54 present)
		const forwardDbRows = [{ id: 51 }, { id: 52 }, { id: 53 }, { id: 54 }]; // 4 rows for limit=3
		const adapter = createSpyAdapter(forwardDbRows);
		const orm = createOrm({ adapter, schema: simpleSchema });
		const cursor50 = Buffer.from(JSON.stringify({ id: 50 }), 'utf-8').toString(
			'base64',
		);
		const forwardResult = await orm
			.select('users')
			.orderBy('id', 'asc')
			.cursorPaginate({ cursor: cursor50, limit: 3, direction: 'forward' });

		// prevCursor should encode the first row of the forward page (51)
		expect(forwardResult.prevCursor).not.toBeNull();
		const prevDecoded = JSON.parse(
			Buffer.from(forwardResult.prevCursor!, 'base64').toString('utf-8'),
		) as { id: number };
		expect(prevDecoded.id).toBe(51);
	});
});
