/**
 * Unit tests for query-executor pagination helpers.
 * Tests the pure functions: isSelectStatement, wrapWithLimit, executePaginated, handleFetchMore.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// We test internal helpers by importing the module and spying on pg Pool

// ── isSelectStatement (internal, test via handleExecuteSQL behavior) ─

// Since isSelectStatement is not exported, we test it indirectly
// through handleExecuteSQL: SELECT/WITH → paginated, others → direct.

describe('query-executor', () => {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let handleExecuteSQL: any;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let handleFetchMore: any;

	beforeEach(async () => {
		// Fresh import to reset pageStore counter
		vi.resetModules();
		const mod = await import('./query-executor.js');
		handleExecuteSQL = mod.handleExecuteSQL;
		handleFetchMore = mod.handleFetchMore;
	});

	function createMockPool(
		rows: Record<string, unknown>[],
		fields?: Array<{ name: string }>,
	) {
		return {
			query: vi.fn().mockResolvedValue({
				rows,
				fields: fields ?? Object.keys(rows[0] ?? {}).map((n) => ({ name: n })),
				rowCount: rows.length,
			}),
		};
	}

	describe('handleExecuteSQL — SELECT pagination', () => {
		it('wraps SELECT with LIMIT N+1', async () => {
			const rows = Array.from({ length: 5 }, (_, i) => ({
				id: i,
				name: `r${i}`,
			}));
			const pool = createMockPool(rows);

			const result = await handleExecuteSQL(
				{ connectionId: 'c1', sql: 'SELECT * FROM users', maxRows: 10 },
				() => pool,
			);

			// Should wrap: SELECT * FROM (SELECT * FROM users) AS _q LIMIT 11
			const sql = pool.query.mock.calls[0][0] as string;
			expect(sql).toContain('LIMIT 11');
			expect(sql).toContain('AS _q');
			expect(result.rows).toHaveLength(5);
			expect(result.truncated).toBeFalsy();
			expect(result.cursorId).toBeUndefined();
		});

		it('detects truncation when rows > maxRows', async () => {
			// Return maxRows + 1 rows to trigger truncation
			const rows = Array.from({ length: 4 }, (_, i) => ({ id: i }));
			const pool = createMockPool(rows);

			const result = await handleExecuteSQL(
				{ connectionId: 'c1', sql: 'SELECT 1', maxRows: 3 },
				() => pool,
			);

			expect(result.rows).toHaveLength(3); // sliced to maxRows
			expect(result.truncated).toBe(true);
			expect(result.cursorId).toBeDefined();
		});

		it('wraps WITH (CTE) queries', async () => {
			const pool = createMockPool([{ x: 1 }]);

			await handleExecuteSQL(
				{
					connectionId: 'c1',
					sql: 'WITH cte AS (SELECT 1) SELECT * FROM cte',
					maxRows: 100,
				},
				() => pool,
			);

			const sql = pool.query.mock.calls[0][0] as string;
			expect(sql).toContain('LIMIT 101');
		});

		it('does NOT wrap non-SELECT statements', async () => {
			const pool = createMockPool([]);

			await handleExecuteSQL(
				{ connectionId: 'c1', sql: 'INSERT INTO users VALUES (1)' },
				() => pool,
			);

			const sql = pool.query.mock.calls[0][0] as string;
			expect(sql).not.toContain('LIMIT');
			expect(sql).toBe('INSERT INTO users VALUES (1)');
		});

		it('defaults maxRows to 1000', async () => {
			const pool = createMockPool([{ id: 1 }]);

			await handleExecuteSQL(
				{ connectionId: 'c1', sql: 'SELECT 1' },
				() => pool,
			);

			const sql = pool.query.mock.calls[0][0] as string;
			expect(sql).toContain('LIMIT 1001');
		});
	});

	describe('handleFetchMore', () => {
		it('loads next page via OFFSET', async () => {
			// First query triggers cursor creation
			const allRows = Array.from({ length: 6 }, (_, i) => ({ id: i }));
			const pool = createMockPool(allRows.slice(0, 4)); // 4 rows → 3 + hasMore

			const first = await handleExecuteSQL(
				{ connectionId: 'c1', sql: 'SELECT * FROM t', maxRows: 3 },
				() => pool,
			);

			expect(first.cursorId).toBeDefined();

			// fetchMore uses the cursor
			const page2Pool = createMockPool(allRows.slice(3, 6));
			const second = await handleFetchMore(
				{ cursorId: first.cursorId },
				() => page2Pool,
			);

			const sql = page2Pool.query.mock.calls[0][0] as string;
			expect(sql).toContain('OFFSET 3');
			expect(second.rows).toHaveLength(3);
		});

		it('throws for unknown cursor', async () => {
			await expect(
				handleFetchMore({ cursorId: 'nonexistent' }, () => ({})),
			).rejects.toThrow('Unknown or expired cursor');
		});

		it('cleans up cursor when no more rows', async () => {
			// Create cursor
			const pool = createMockPool(
				Array.from({ length: 4 }, (_, i) => ({ id: i })),
			);
			const first = await handleExecuteSQL(
				{ connectionId: 'c1', sql: 'SELECT 1', maxRows: 3 },
				() => pool,
			);

			// Fetch more — return exactly maxRows (no more)
			const pool2 = createMockPool([{ id: 10 }, { id: 11 }]);
			const second = await handleFetchMore(
				{ cursorId: first.cursorId },
				() => pool2,
			);

			expect(second.truncated).toBeFalsy();
			expect(second.cursorId).toBeUndefined();

			// Cursor should be gone now
			await expect(
				handleFetchMore({ cursorId: first.cursorId! }, () => pool2),
			).rejects.toThrow('Unknown or expired cursor');
		});
	});

	describe('pageStore TTL + max-entries (F002)', () => {
		afterEach(() => {
			vi.useRealTimers();
		});

		it('evicts expired cursors on cleanup', async () => {
			// Create a cursor
			const pool = createMockPool(
				Array.from({ length: 4 }, (_, i) => ({ id: i })),
			);
			const first = await handleExecuteSQL(
				{ connectionId: 'c1', sql: 'SELECT * FROM t', maxRows: 3 },
				() => pool,
			);
			expect(first.cursorId).toBeDefined();

			// Advance time past TTL (10 min)
			vi.useFakeTimers();
			vi.advanceTimersByTime(11 * 60 * 1000);

			// Next fetchMore should fail — cursor expired during cleanup
			const pool2 = createMockPool([{ id: 10 }]);
			await expect(
				handleFetchMore({ cursorId: first.cursorId }, () => pool2),
			).rejects.toThrow('Unknown or expired cursor');
		});

		it('evicts oldest cursors when exceeding MAX_CURSORS', async () => {
			// Create 52 cursors (> MAX_CURSORS of 50)
			const cursorIds: string[] = [];
			for (let i = 0; i < 52; i++) {
				const pool = createMockPool(
					Array.from({ length: 4 }, (_, j) => ({ id: j + i * 10 })),
				);
				const result = await handleExecuteSQL(
					{ connectionId: 'c1', sql: `SELECT * FROM t${i}`, maxRows: 3 },
					() => pool,
				);
				if (result.cursorId) cursorIds.push(result.cursorId);
			}

			// First 2 cursors should be evicted (oldest)
			const pool2 = createMockPool([{ id: 1 }]);
			await expect(
				handleFetchMore({ cursorId: cursorIds[0] }, () => pool2),
			).rejects.toThrow('Unknown or expired cursor');

			// Last cursor should still work
			const lastCursor = cursorIds[cursorIds.length - 1];
			const pool3 = createMockPool([{ id: 99 }]);
			const result = await handleFetchMore(
				{ cursorId: lastCursor },
				() => pool3,
			);
			expect(result.rows).toHaveLength(1);
		});
	});

	describe('keyset pagination (OOS2)', () => {
		it('uses OFFSET for small offsets even with id column', async () => {
			// Create cursor with id column
			const pool = createMockPool(
				Array.from({ length: 4 }, (_, i) => ({ id: i + 1, name: `r${i}` })),
			);
			const first = await handleExecuteSQL(
				{ connectionId: 'c1', sql: 'SELECT * FROM users', maxRows: 3 },
				() => pool,
			);
			expect(first.cursorId).toBeDefined();

			// fetchMore at offset 3 (< 5000 threshold) — should use OFFSET
			const pool2 = createMockPool([
				{ id: 4, name: 'r3' },
				{ id: 5, name: 'r4' },
			]);
			await handleFetchMore({ cursorId: first.cursorId }, () => pool2);

			const sql = pool2.query.mock.calls[0][0] as string;
			expect(sql).toContain('OFFSET');
			expect(sql).not.toContain('WHERE');
		});

		it('switches to keyset for large offsets with id column', async () => {
			// Create cursor and simulate large offset by calling fetchMore many times
			const pool = createMockPool(
				Array.from({ length: 6001 }, (_, i) => ({ id: i + 1, name: `r${i}` })),
			);
			const first = await handleExecuteSQL(
				{ connectionId: 'c1', sql: 'SELECT * FROM users', maxRows: 6000 },
				() => pool,
			);
			expect(first.cursorId).toBeDefined();
			// offset is now 6000 (> 5000 threshold)

			// fetchMore should use keyset: WHERE "id" > lastValue ORDER BY "id"
			const pool2 = createMockPool([
				{ id: 6001, name: 'r6000' },
				{ id: 6002, name: 'r6001' },
			]);
			await handleFetchMore({ cursorId: first.cursorId }, () => pool2);

			const sql = pool2.query.mock.calls[0][0] as string;
			expect(sql).toContain('WHERE "id" >');
			expect(sql).toContain('ORDER BY "id"');
			expect(sql).not.toContain('OFFSET');
		});

		it('falls back to OFFSET when no id column exists', async () => {
			// No id column — just name
			const pool = createMockPool(
				Array.from({ length: 6001 }, (_, i) => ({ name: `r${i}`, value: i })),
				[{ name: 'name' }, { name: 'value' }],
			);
			const first = await handleExecuteSQL(
				{ connectionId: 'c1', sql: 'SELECT * FROM items', maxRows: 6000 },
				() => pool,
			);
			expect(first.cursorId).toBeDefined();

			// fetchMore should use OFFSET (no keyset column available)
			const pool2 = createMockPool([{ name: 'r6000', value: 6000 }]);
			await handleFetchMore({ cursorId: first.cursorId }, () => pool2);

			const sql = pool2.query.mock.calls[0][0] as string;
			expect(sql).toContain('OFFSET');
			expect(sql).not.toContain('WHERE');
		});
	});
});
