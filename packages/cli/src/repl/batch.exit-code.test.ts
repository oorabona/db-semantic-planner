// @ts-nocheck — integration-style unit tests; typed mocks via vi.hoisted
/**
 * Regression tests for batch.ts Commit-2 findings:
 *
 * S-class:
 *   CODEX-6  — assertion-present batch ignores query failures for exit code
 *   EH-3     — process.exit in executeBatch kills test runners (library-safe split)
 *
 * M-class:
 *   CODEX-4  — continuation lines inflate results (synthetic success result)
 *   CODEX-5  — .exit/.quit do not terminate the batch loop
 *   CC-5+EH-6 — fragile string-match for init-error detection
 *   EH-11    — plain-text error in --json mode goes to stderr
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';


// ---------------------------------------------------------------------------
// Shared mock infrastructure (mirrors batch.coverage.test.ts pattern)
// ---------------------------------------------------------------------------

const {
	mockEngineInstance,
	mockReplEngineCtorArgs,
	mockReadFileSync,
	mockParseAssertionFile,
	mockValidateAssertionBlocks,
	mockRunAssertions,
} = vi.hoisted(() => {
	const instance = {
		init: vi.fn().mockResolvedValue(undefined),
		destroy: vi.fn().mockResolvedValue(undefined),
		submit: vi.fn().mockResolvedValue(undefined),
		on: vi.fn().mockReturnValue(vi.fn()),
		getState: vi.fn().mockReturnValue({ outputMode: 'json' }),
	};
	return {
		mockEngineInstance: instance,
		mockReplEngineCtorArgs: [] as unknown[][],
		mockReadFileSync: vi.fn().mockReturnValue(''),
		mockParseAssertionFile: vi.fn().mockReturnValue({ blocks: [], errors: [] }),
		mockValidateAssertionBlocks: vi.fn().mockReturnValue([]),
		mockRunAssertions: vi.fn().mockReturnValue({
			total: 0,
			passed: 0,
			failed: 0,
			skipped: 0,
			results: [],
		}),
	};
});

vi.mock('./engine/repl-engine.js', async (importOriginal) => {
	const original = await importOriginal();
	class MockReplEngine {
		constructor(...args) {
			mockReplEngineCtorArgs.push(args);
			Object.assign(this, mockEngineInstance);
		}
	}
	return {
		...original,
		ReplEngine: MockReplEngine,
	};
});

vi.mock('node:fs', () => ({
	readFileSync: mockReadFileSync,
}));

vi.mock('./assertion-parser.js', () => ({
	parseAssertionFile: mockParseAssertionFile,
	validateAssertionBlocks: mockValidateAssertionBlocks,
}));

vi.mock('./assertion-runner.js', () => ({
	runAssertions: mockRunAssertions,
}));

// Must import after vi.mock calls
const { executeBatch, runBatchMode } = await import('./batch.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSchema() {
	return {
		definition: { users: {} },
		model: {
			tables: new Map([
				['users', { name: 'users', columns: [], primaryKey: 'id' }],
			]),
			relations: new Map(),
		},
		tableNames: ['users'],
	};
}

function makeOptions(overrides = {}) {
	return {
		queries: ['from users'],
		schema: makeSchema(),
		schemaPath: 'test.schema.ts',
		format: 'text' as const,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// S-class: CODEX-6 — assertion-present batch ignores query failures
// ---------------------------------------------------------------------------

describe('[CODEX-6] exit code: assertions present + query failure → exit 1', () => {
	let processExitSpy: ReturnType<typeof vi.spyOn>;
	let consoleLogSpy: ReturnType<typeof vi.spyOn>;
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		mockReplEngineCtorArgs.length = 0;
		mockEngineInstance.init.mockResolvedValue(undefined);
		mockEngineInstance.destroy.mockResolvedValue(undefined);
		mockEngineInstance.on.mockReturnValue(vi.fn());
		mockEngineInstance.getState.mockReturnValue({ outputMode: 'json' });
		consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('PROCESS_EXIT');
		});
	});

	afterEach(() => {
		consoleLogSpy.mockRestore();
		consoleErrorSpy.mockRestore();
		processExitSpy.mockRestore();
	});

	it('exits with 1 when 1 query fails and 0 assertions fail (assertions present)', async () => {
		// The query emits a query-result with error → success=false
		let callIdx = 0;
		let storedCb: ((event: unknown) => void) | undefined;
		mockEngineInstance.on.mockImplementation((cb) => {
			callIdx++;
			if (callIdx > 1) storedCb = cb;
			return vi.fn();
		});
		mockEngineInstance.submit.mockImplementation(async () => {
			storedCb?.({
				type: 'query-result',
				result: { sql: '', params: [], error: 'Unknown table' },
			});
		});

		mockReadFileSync.mockReturnValue('valid');
		mockParseAssertionFile.mockReturnValue({
			blocks: [{ queryIndex: 0, assertions: [] }],
			errors: [],
		});
		mockValidateAssertionBlocks.mockReturnValue([]);
		mockRunAssertions.mockReturnValue({
			total: 1,
			passed: 1,
			failed: 0, // all assertions PASS
			skipped: 0,
			results: [],
		});

		try {
			await runBatchMode(
				makeOptions({ format: 'json', assertFile: '/path/to/file.assert.dbsp' }),
			);
		} catch (e) {
			expect(e.message).toBe('PROCESS_EXIT');
		}

		// Must exit 1 even though assertions all passed — query failed
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('exits with 1 when 1 query fails, 1 assertion fails, assertions present', async () => {
		let callIdx = 0;
		let storedCb: ((event: unknown) => void) | undefined;
		mockEngineInstance.on.mockImplementation((cb) => {
			callIdx++;
			if (callIdx > 1) storedCb = cb;
			return vi.fn();
		});
		mockEngineInstance.submit.mockImplementation(async () => {
			storedCb?.({
				type: 'query-result',
				result: { sql: '', params: [], error: 'Bad query' },
			});
		});

		mockReadFileSync.mockReturnValue('valid');
		mockParseAssertionFile.mockReturnValue({
			blocks: [{ queryIndex: 0, assertions: [] }],
			errors: [],
		});
		mockValidateAssertionBlocks.mockReturnValue([]);
		mockRunAssertions.mockReturnValue({
			total: 1,
			passed: 0,
			failed: 1,
			skipped: 0,
			results: [],
		});

		try {
			await runBatchMode(
				makeOptions({ format: 'json', assertFile: '/path/to/file.assert.dbsp' }),
			);
		} catch (e) {
			expect(e.message).toBe('PROCESS_EXIT');
		}

		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('does NOT exit when all queries succeed and all assertions pass', async () => {
		let callIdx = 0;
		let storedCb: ((event: unknown) => void) | undefined;
		mockEngineInstance.on.mockImplementation((cb) => {
			callIdx++;
			if (callIdx > 1) storedCb = cb;
			return vi.fn();
		});
		mockEngineInstance.submit.mockImplementation(async () => {
			storedCb?.({ type: 'query-result', result: { sql: 'SELECT 1', params: [] } });
		});

		mockReadFileSync.mockReturnValue('valid');
		mockParseAssertionFile.mockReturnValue({
			blocks: [{ queryIndex: 0, assertions: [] }],
			errors: [],
		});
		mockValidateAssertionBlocks.mockReturnValue([]);
		mockRunAssertions.mockReturnValue({
			total: 1,
			passed: 1,
			failed: 0,
			skipped: 0,
			results: [],
		});

		await runBatchMode(
			makeOptions({ format: 'json', assertFile: '/path/to/file.assert.dbsp' }),
		);

		expect(processExitSpy).not.toHaveBeenCalled();
	});

	it('considers dbSuccess=false as a failure for exit code', async () => {
		let callIdx = 0;
		let storedCb: ((event: unknown) => void) | undefined;
		mockEngineInstance.on.mockImplementation((cb) => {
			callIdx++;
			if (callIdx > 1) storedCb = cb;
			return vi.fn();
		});
		mockEngineInstance.submit.mockImplementation(async () => {
			// Query compiles OK but DB execution fails
			storedCb?.({ type: 'query-result', result: { sql: 'SELECT 1', params: [] } });
			storedCb?.({
				type: 'execution-result',
				result: {
					error: 'DB error',
					rows: [],
					columns: [],
					rowCount: 0,
					executionTimeMs: 0,
				},
				query: { sql: 'SELECT 1', params: [] },
			});
		});

		try {
			await runBatchMode(makeOptions({ format: 'json' }));
		} catch (e) {
			expect(e.message).toBe('PROCESS_EXIT');
		}

		// dbSuccess=false → hasFailedQueries=true → exit 1
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});
});

// ---------------------------------------------------------------------------
// S-class: EH-3 — executeBatch is library-safe (no process.exit inside it)
// ---------------------------------------------------------------------------

describe('[EH-3] executeBatch is library-safe — no process.exit', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockReplEngineCtorArgs.length = 0;
		mockEngineInstance.init.mockResolvedValue(undefined);
		mockEngineInstance.destroy.mockResolvedValue(undefined);
		mockEngineInstance.on.mockReturnValue(vi.fn());
		mockEngineInstance.getState.mockReturnValue({ outputMode: 'json' });
	});

	it('throws an Error when init rejects — does not call process.exit', async () => {
		const processExitSpy = vi
			.spyOn(process, 'exit')
			.mockImplementation(() => {
				throw new Error('unexpected exit');
			});

		mockEngineInstance.init.mockRejectedValue(new Error('Init failed hard'));

		// executeBatch should throw, not call process.exit
		await expect(executeBatch(makeOptions())).rejects.toThrow('Init failed hard');

		expect(processExitSpy).not.toHaveBeenCalled();
		processExitSpy.mockRestore();
	});

	it('calls engine.destroy() (pool cleanup) even when submit throws', async () => {
		let callIdx = 0;
		mockEngineInstance.on.mockImplementation(() => {
			callIdx++;
			return vi.fn();
		});
		mockEngineInstance.submit.mockRejectedValue(new Error('submit error'));

		await expect(executeBatch(makeOptions())).rejects.toThrow('submit error');

		// destroy must be called even on failure (finally block)
		expect(mockEngineInstance.destroy).toHaveBeenCalledTimes(1);
	});

	it('throws when DB connection fails — no process.exit', async () => {
		const processExitSpy = vi
			.spyOn(process, 'exit')
			.mockImplementation(() => {
				throw new Error('unexpected exit');
			});

		// Emit init-error event
		mockEngineInstance.on.mockImplementation((cb) => {
			cb({
				type: 'init-error',
				message: 'Connection failed: ECONNREFUSED',
			});
			return vi.fn();
		});

		await expect(
			executeBatch(makeOptions({ databaseUrl: 'postgres://localhost/bad' })),
		).rejects.toThrow('Database connection failed');

		expect(processExitSpy).not.toHaveBeenCalled();
		expect(mockEngineInstance.destroy).toHaveBeenCalledTimes(1);
		processExitSpy.mockRestore();
	});
});

// ---------------------------------------------------------------------------
// M-class: CODEX-4 — continuation lines do not inflate results
// ---------------------------------------------------------------------------

describe('[CODEX-4] continuation lines do not inflate results', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockReplEngineCtorArgs.length = 0;
		mockEngineInstance.init.mockResolvedValue(undefined);
		mockEngineInstance.destroy.mockResolvedValue(undefined);
		mockEngineInstance.getState.mockReturnValue({ outputMode: 'json' });
	});

	it('3-line input where line 1 is continuation → 2 results not 3', async () => {
		// Line 'from users \\' is a backslash-continuation line.
		// The engine accumulates it without emitting any events.
		// Lines 2 and 3 emit query-result events.
		let callIdx = 0;
		let storedCb: ((event: unknown) => void) | undefined;
		mockEngineInstance.on.mockImplementation((cb) => {
			callIdx++;
			if (callIdx > 1) storedCb = cb;
			return vi.fn();
		});

		mockEngineInstance.submit.mockImplementation(async (query) => {
			if (query === 'from users \\') {
				// Continuation line: no events emitted (engine accumulates internally)
			} else {
				storedCb?.({
					type: 'query-result',
					result: { sql: 'SELECT 1', params: [] },
				});
			}
		});

		const result = await executeBatch(
			makeOptions({
				queries: ['from users \\', 'where id = 1', 'from posts'],
			}),
		);

		// 'from users \\' emits 0 events → skipped (no synthetic result)
		// 'where id = 1' and 'from posts' each emit 1 event → 2 results
		expect(result.results).toHaveLength(2);
		expect(result.results[0]!.query).toBe('where id = 1');
		expect(result.results[1]!.query).toBe('from posts');
	});

	it('blank line emits no events → skipped, not counted as result', async () => {
		let callIdx = 0;
		let storedCb: ((event: unknown) => void) | undefined;
		mockEngineInstance.on.mockImplementation((cb) => {
			callIdx++;
			if (callIdx > 1) storedCb = cb;
			return vi.fn();
		});
		mockEngineInstance.submit.mockImplementation(async (query) => {
			const trimmed = (query ?? '').trim();
			if (trimmed.length > 0 && !trimmed.startsWith('#')) {
				storedCb?.({
					type: 'query-result',
					result: { sql: 'SELECT 1', params: [] },
				});
			}
			// blank/comment → engine returns early with no events
		});

		const result = await executeBatch(
			makeOptions({ queries: ['from users', '', 'from posts'] }),
		);

		// '' emits no events → skipped → 2 results
		expect(result.results).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// M-class: CODEX-5 — .exit/.quit terminates the batch loop
// ---------------------------------------------------------------------------

describe('[CODEX-5] .exit/.quit terminates batch loop', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockReplEngineCtorArgs.length = 0;
		mockEngineInstance.init.mockResolvedValue(undefined);
		mockEngineInstance.destroy.mockResolvedValue(undefined);
		mockEngineInstance.getState.mockReturnValue({ outputMode: 'json' });
	});

	it('SELECT 1 → .exit → SELECT 2: second SELECT never runs', async () => {
		let callIdx = 0;
		let storedCb: ((event: unknown) => void) | undefined;
		mockEngineInstance.on.mockImplementation((cb) => {
			callIdx++;
			if (callIdx > 1) storedCb = cb;
			return vi.fn();
		});
		mockEngineInstance.submit.mockImplementation(async (query) => {
			if (query === 'SELECT 1') {
				storedCb?.({
					type: 'query-result',
					result: { sql: 'SELECT 1', params: [] },
				});
			} else if (query === '.exit') {
				storedCb?.({ type: 'info', message: 'Bye' });
				storedCb?.({ type: 'exit' });
			}
			// 'SELECT 2' should never be submitted
		});

		const result = await executeBatch(
			makeOptions({ queries: ['SELECT 1', '.exit', 'SELECT 2'] }),
		);

		// SELECT 2 must never have been submitted
		expect(mockEngineInstance.submit).not.toHaveBeenCalledWith('SELECT 2');
		// Results: SELECT 1 + .exit = 2 (no SELECT 2)
		expect(result.results).toHaveLength(2);
	});

	it('.quit also terminates the batch loop', async () => {
		let callIdx = 0;
		let storedCb: ((event: unknown) => void) | undefined;
		mockEngineInstance.on.mockImplementation((cb) => {
			callIdx++;
			if (callIdx > 1) storedCb = cb;
			return vi.fn();
		});
		mockEngineInstance.submit.mockImplementation(async (query) => {
			if (query === '.quit') {
				storedCb?.({ type: 'exit' });
			} else {
				storedCb?.({
					type: 'query-result',
					result: { sql: 'SELECT 1', params: [] },
				});
			}
		});

		const result = await executeBatch(
			makeOptions({ queries: ['.quit', 'SELECT 1'] }),
		);

		expect(mockEngineInstance.submit).not.toHaveBeenCalledWith('SELECT 1');
		expect(result.results).toHaveLength(1); // .quit result only
	});
});

// ---------------------------------------------------------------------------
// M-class: CC-5+EH-6 — typed sentinel for init-error (no substring matching)
// ---------------------------------------------------------------------------

describe('[CC-5+EH-6] init-error detection uses sentinel prefix, not substring', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockReplEngineCtorArgs.length = 0;
		mockEngineInstance.init.mockResolvedValue(undefined);
		mockEngineInstance.destroy.mockResolvedValue(undefined);
		mockEngineInstance.getState.mockReturnValue({ outputMode: 'json' });
	});

	it('detects init failure via init-error event', async () => {
		mockEngineInstance.on.mockImplementation((cb) => {
			cb({
				type: 'init-error',
				message: 'Connection failed: ECONNREFUSED',
			});
			return vi.fn();
		});

		await expect(
			executeBatch(makeOptions({ databaseUrl: 'postgres://localhost/bad' })),
		).rejects.toThrow('Database connection failed');
	});
});

// ---------------------------------------------------------------------------
// M-class: EH-11 — --json mode errors go to stdout as JSON, not plain stderr
// ---------------------------------------------------------------------------

describe('[EH-11] --json mode: errors go to stdout as JSON', () => {
	let consoleLogSpy: ReturnType<typeof vi.spyOn>;
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
	let processExitSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		mockReplEngineCtorArgs.length = 0;
		mockEngineInstance.getState.mockReturnValue({ outputMode: 'json' });
		consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('PROCESS_EXIT');
		});
	});

	afterEach(() => {
		consoleLogSpy.mockRestore();
		consoleErrorSpy.mockRestore();
		processExitSpy.mockRestore();
	});

	it('emits JSON error to stdout when executeBatch throws and format=json', async () => {
		mockEngineInstance.init.mockRejectedValue(new Error('catastrophic failure'));

		try {
			await runBatchMode(makeOptions({ format: 'json' }));
		} catch {
			// process.exit throws PROCESS_EXIT
		}

		// stderr must be empty
		expect(consoleErrorSpy).not.toHaveBeenCalled();

		// stdout must have JSON with error and status fields
		const allLogCalls = consoleLogSpy.mock.calls.flat();
		const jsonCall = allLogCalls.find((c) => {
			try {
				JSON.parse(c);
				return true;
			} catch {
				return false;
			}
		});
		expect(jsonCall).toBeDefined();
		const parsed = JSON.parse(jsonCall);
		expect(parsed).toHaveProperty('error');
		expect(parsed).toHaveProperty('status', 'error');
		expect(parsed.error).toContain('catastrophic failure');
	});

	it('emits plain text to stderr when executeBatch throws and format=text', async () => {
		mockEngineInstance.init.mockRejectedValue(new Error('init failure'));

		try {
			await runBatchMode(makeOptions({ format: 'text' }));
		} catch {
			// process.exit throws
		}

		// stderr must have the error message
		expect(consoleErrorSpy).toHaveBeenCalled();
		const errCalls = consoleErrorSpy.mock.calls.flat().join(' ');
		expect(errCalls).toContain('init failure');

		// stdout must NOT have a JSON error envelope
		const logCalls = consoleLogSpy.mock.calls.flat().join(' ');
		expect(logCalls).not.toContain('"status"');
	});
});
