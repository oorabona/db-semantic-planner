// @ts-nocheck — coverage test: runtime assertions
/**
 * Coverage tests for ReplEngine — targets UNCOVERED branches only.
 *
 * The existing repl-engine.test.ts covers basic state, dot commands (.exit, .quit,
 * .clear, .help, .history, .aliasing, .strategy, .dialect, .show, .close, .layout, .plan),
 * listener subscribe/unsubscribe, empty/comment input, raw SQL in sql mode,
 * and NQL query compilation with plan structure.
 *
 * This file exclusively covers:
 * - Backslash continuation (multiline) buffer
 * - init() connection success & failure
 * - destroy() with active connection
 * - Accessor methods (getCompletionProvider, getSchema, getSchemaPath, getDatabaseName)
 * - .dialect without argument (info display)
 * - .dialect change that resets incompatible strategy
 * - .table config commands (all sub-commands, valid/invalid, reset)
 * - processDotCommand stateChange propagation (mode, execEnabled, schemaName, explainMode, parseMode, outputMode, inTransaction)
 * - processDotCommand error path
 * - Empty query error message difference (natural vs sql mode)
 * - Raw SQL execution when execMode + connected
 * - Raw SQL warnings (mode escape, compile-only)
 * - NQL bang suffix (mutation dry-run vs execute)
 * - NQL explainMode (EXPLAIN prefix)
 * - NQL execution path
 * - NQL error handling (enhanceErrorWithSuggestion)
 * - isInsideStringLiteral edge cases (empty, single char)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineEvent } from './engine-types.js';
import { isInsideStringLiteral, ReplEngine } from './repl-engine.js';

// ---------------------------------------------------------------------------
// Mocks — vi.mock factories are hoisted, so they cannot reference top-level vars.
// We use vi.hoisted() to create mock objects that are available at hoist time.
// ---------------------------------------------------------------------------

const {
	mockConnection,
	mockCreateDbConnection,
	mockGetDatabaseName,
	mockConfig,
	mockCompileNqlToSql,
} = vi.hoisted(() => {
	const conn = {
		executeRaw: vi.fn().mockResolvedValue({
			rows: [{ id: 1 }],
			columns: ['id'],
			rowCount: 1,
			executionTimeMs: 5,
		}),
		ping: vi.fn().mockResolvedValue(true),
		close: vi.fn().mockResolvedValue(undefined),
		getPool: vi.fn(),
		beginTransaction: vi.fn().mockImplementation(async () => {
			conn.inTransaction = true;
		}),
		commitTransaction: vi.fn().mockImplementation(async () => {
			conn.inTransaction = false;
		}),
		rollbackTransaction: vi.fn().mockImplementation(async () => {
			conn.inTransaction = false;
		}),
		inTransaction: false,
	};
	return {
		mockConnection: conn,
		mockCreateDbConnection: vi.fn().mockResolvedValue(conn),
		mockGetDatabaseName: vi.fn().mockReturnValue('testdb'),
		mockConfig: {
			getTable: vi.fn().mockReturnValue({
				borderStyle: 'all',
				overflow: 'wrap',
				headerFormatter: 'capitalCase',
				padding: 1,
			}),
			updateTable: vi.fn(),
			resetTable: vi.fn(),
		},
		mockCompileNqlToSql: vi.fn().mockResolvedValue({
			sql: 'SELECT "id", "name" FROM "users"',
			params: [],
			intentType: 'query',
			intent: {
				type: 'query',
				table: 'users',
				with: [],
				hasWhere: false,
				hasGroupBy: false,
				hasOrderBy: false,
				ctes: [],
			},
			planReport: {
				rootTable: 'users',
				decisions: [],
				warnings: [],
				ctes: [],
				metadata: {
					planningTimeMs: 1,
					relationsAnalyzed: 0,
					isAmbiguous: false,
				},
			},
		}),
	};
});

vi.mock('../db-connection.js', () => ({
	createDbConnection: mockCreateDbConnection,
	getDatabaseName: mockGetDatabaseName,
}));

vi.mock('../../config.js', async (importOriginal) => {
	const original = await importOriginal();
	return {
		...original,
		config: mockConfig,
	};
});

vi.mock('../nql-executor.js', () => ({
	compileNqlToSql: mockCompileNqlToSql,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestSchema() {
	const model = {
		tables: new Map([
			[
				'users',
				{
					name: 'users',
					columns: [
						{ name: 'id', type: 'integer', nullable: false },
						{ name: 'name', type: 'text', nullable: false },
					],
					primaryKey: ['id'],
				},
			],
		]),
		relations: new Map(),
	};
	return {
		model: model as any,
		tableNames: ['users'],
		schemaPath: 'test.schema.ts',
	};
}

function createEngine(overrides = {}) {
	return new ReplEngine({
		schema: createTestSchema() as any,
		schemaPath: 'test.schema.ts',
		...overrides,
	});
}

function collectEvents(engine: ReplEngine): EngineEvent[] {
	const events: EngineEvent[] = [];
	engine.on((e) => events.push(e));
	return events;
}

function findEvent(events: EngineEvent[], type: string) {
	return events.find((e) => e.type === type);
}

function findEvents(events: EngineEvent[], type: string) {
	return events.filter((e) => e.type === type);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ReplEngine — coverage', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Reset mutable mock state
		mockConnection.inTransaction = false;
		// Restore default implementations after clearAllMocks
		mockConnection.executeRaw.mockResolvedValue({
			rows: [{ id: 1 }],
			columns: ['id'],
			rowCount: 1,
			executionTimeMs: 5,
		});
		mockConnection.beginTransaction.mockImplementation(async () => {
			mockConnection.inTransaction = true;
		});
		mockConnection.commitTransaction.mockImplementation(async () => {
			mockConnection.inTransaction = false;
		});
		mockConnection.rollbackTransaction.mockImplementation(async () => {
			mockConnection.inTransaction = false;
		});
		mockConnection.close.mockResolvedValue(undefined);
		mockCreateDbConnection.mockResolvedValue(mockConnection);
		mockGetDatabaseName.mockReturnValue('testdb');
		mockCompileNqlToSql.mockResolvedValue({
			sql: 'SELECT "id", "name" FROM "users"',
			params: [],
			intentType: 'query',
			intent: {
				type: 'query',
				table: 'users',
				with: [],
				hasWhere: false,
				hasGroupBy: false,
				hasOrderBy: false,
				ctes: [],
			},
			planReport: {
				rootTable: 'users',
				decisions: [],
				warnings: [],
				ctes: [],
				metadata: {
					planningTimeMs: 1,
					relationsAnalyzed: 0,
					isAmbiguous: false,
				},
			},
		});
	});

	// =========================================================================
	// Backslash continuation (multiline input buffer)
	// =========================================================================

	describe('backslash continuation', () => {
		it('accumulates lines ending with backslash', async () => {
			const engine = createEngine();
			const events = collectEvents(engine);

			// First line with continuation — should NOT produce output yet
			await engine.submit('users \\');
			expect(events).toHaveLength(0);

			// Second line without backslash — should merge and process
			await engine.submit('where id = 1');
			expect(events.length).toBeGreaterThan(0);
			expect(findEvent(events, 'query-result')).toBeDefined();
		});

		it('accumulates multiple continuation lines', async () => {
			const engine = createEngine();
			const events = collectEvents(engine);

			await engine.submit('users \\');
			expect(events).toHaveLength(0);

			await engine.submit('where \\');
			expect(events).toHaveLength(0);

			await engine.submit('id = 1');
			expect(events.length).toBeGreaterThan(0);
		});

		it('flushes continuation buffer on empty line', async () => {
			const engine = createEngine();
			const events = collectEvents(engine);

			await engine.submit('users \\');
			expect(events).toHaveLength(0);

			// Empty line flushes the buffer
			await engine.submit('');
			expect(events).toHaveLength(0);

			// Next input should NOT merge with the flushed buffer
			await engine.submit('users');
			const qr = findEvent(events, 'query-result');
			expect(qr).toBeDefined();
		});

		it('flushes continuation buffer on comment line', async () => {
			const engine = createEngine();
			const events = collectEvents(engine);

			await engine.submit('users \\');
			await engine.submit('# comment resets');
			expect(events).toHaveLength(0);

			// This should process independently
			await engine.submit('users');
			expect(findEvent(events, 'query-result')).toBeDefined();
		});

		it('continuation works with dot commands', async () => {
			const engine = createEngine();
			const events = collectEvents(engine);

			await engine.submit('.strategy \\');
			await engine.submit('cte');

			expect(engine.getState().includeStrategy).toBe('cte');
		});
	});

	// =========================================================================
	// init() — connection lifecycle
	// =========================================================================

	describe('init()', () => {
		it('connects when databaseUrl is provided', async () => {
			const engine = createEngine({ databaseUrl: 'postgres://localhost/test' });
			const events = collectEvents(engine);

			await engine.init();

			expect(mockCreateDbConnection).toHaveBeenCalledWith(
				'postgres://localhost/test',
			);
			expect(engine.getState().connected).toBe(true);
			const info = events.find(
				(e) => e.type === 'info' && e.message.includes('Connected'),
			);
			expect(info).toBeDefined();
			expect(events.some((e) => e.type === 'state-change')).toBe(true);
		});

		it('skips connection when databaseUrl is not provided', async () => {
			const engine = createEngine();
			const events = collectEvents(engine);

			await engine.init();

			expect(engine.getState().connected).toBe(false);
			expect(events).toHaveLength(0);
		});

		it('emits init-error (typed) when connection fails', async () => {
			mockCreateDbConnection.mockRejectedValueOnce(new Error('ECONNREFUSED'));

			const engine = createEngine({ databaseUrl: 'postgres://localhost/bad' });
			const events = collectEvents(engine);

			await engine.init();

			expect(engine.getState().connected).toBe(false);
			const err = events.find(
				(e) =>
					e.type === 'init-error' &&
					e.message.includes('Connection failed: ECONNREFUSED'),
			);
			expect(err).toBeDefined();
		});

		it('emits state-change after connection failure (EH-9)', async () => {
			mockCreateDbConnection.mockRejectedValueOnce(new Error('ECONNREFUSED'));

			const engine = createEngine({ databaseUrl: 'postgres://localhost/bad' });
			const events = collectEvents(engine);

			await engine.init();

			// emitStateChange() must be called in the catch block so consumers
			// see connected: false via a state-change event, not just an init-error.
			const stateChange = events.find(
				(e) => e.type === 'state-change' && e.state.connected === false,
			);
			expect(stateChange).toBeDefined();
		});

		it('emits init-error with string error when connection fails with non-Error', async () => {
			mockCreateDbConnection.mockRejectedValueOnce('string error');

			const engine = createEngine({ databaseUrl: 'postgres://localhost/bad' });
			const events = collectEvents(engine);

			await engine.init();

			const err = events.find(
				(e) => e.type === 'init-error' && e.message.includes('string error'),
			);
			expect(err).toBeDefined();
		});
	});

	// =========================================================================
	// destroy() with active connection
	// =========================================================================

	describe('destroy()', () => {
		it('closes active connection and resets state', async () => {
			const engine = createEngine({ databaseUrl: 'postgres://localhost/test' });
			await engine.init();
			expect(engine.getState().connected).toBe(true);

			await engine.destroy();

			expect(mockConnection.close).toHaveBeenCalled();
			expect(engine.getState().connected).toBe(false);
		});
	});

	// =========================================================================
	// Accessor methods
	// =========================================================================

	describe('accessor methods', () => {
		it('getCompletionProvider returns a CompletionProvider', () => {
			const engine = createEngine();
			const provider = engine.getCompletionProvider();
			expect(provider).toBeDefined();
		});

		it('getSchema returns the loaded schema', () => {
			const engine = createEngine();
			const schema = engine.getSchema();
			expect(schema.tableNames).toEqual(['users']);
		});

		it('getSchemaPath returns the schema path', () => {
			const engine = createEngine();
			expect(engine.getSchemaPath()).toBe('test.schema.ts');
		});

		it('getDatabaseName returns name when URL is provided', () => {
			const engine = createEngine({ databaseUrl: 'postgres://localhost/mydb' });
			expect(engine.getDatabaseName()).toBe('testdb');
		});

		it('getDatabaseName returns undefined when no URL', () => {
			const engine = createEngine();
			expect(engine.getDatabaseName()).toBeUndefined();
		});
	});

	// =========================================================================
	// .dialect — uncovered branches
	// =========================================================================

	describe('.dialect uncovered branches', () => {
		it('shows dialect info without argument', async () => {
			const engine = createEngine();
			const events = collectEvents(engine);

			await engine.submit('.dialect');

			const info = events.find(
				(e) => e.type === 'info' && e.message.includes('SQL Dialect'),
			);
			expect(info).toBeDefined();
		});

		it('resets strategy when switching to dialect that lacks current strategy', async () => {
			const engine = createEngine();

			// Set strategy to lateral (PostgreSQL-only)
			await engine.submit('.strategy lateral');
			expect(engine.getState().includeStrategy).toBe('lateral');

			const events = collectEvents(engine);

			// Switch to sqlite which doesn't support lateral
			await engine.submit('.dialect sqlite');

			expect(engine.getState().dialect).toBe('sqlite');
			expect(engine.getState().includeStrategy).toBe('join');
			const info = events.find(
				(e) => e.type === 'info' && e.message.includes('Strategy reset'),
			);
			expect(info).toBeDefined();
		});

		it('keeps strategy when switching to compatible dialect', async () => {
			const engine = createEngine();

			// Set strategy to cte (available in all dialects)
			await engine.submit('.strategy cte');
			expect(engine.getState().includeStrategy).toBe('cte');

			await engine.submit('.dialect mysql');

			expect(engine.getState().dialect).toBe('mysql');
			expect(engine.getState().includeStrategy).toBe('cte');
		});
	});

	// =========================================================================
	// .table config — all sub-commands
	// =========================================================================

	describe('.table config', () => {
		it('shows table config without sub-argument', async () => {
			const engine = createEngine();
			const events = collectEvents(engine);

			await engine.submit('.table');

			const info = events.find(
				(e) => e.type === 'info' && e.message.includes('Table Configuration'),
			);
			expect(info).toBeDefined();
		});

		it('resets table config with .table reset', async () => {
			const engine = createEngine();
			const events = collectEvents(engine);

			await engine.submit('.table reset');

			expect(mockConfig.resetTable).toHaveBeenCalled();
			const info = events.find(
				(e) => e.type === 'info' && e.message.includes('reset to defaults'),
			);
			expect(info).toBeDefined();
		});

		// --- borders ---
		it('shows borders value without argument', async () => {
			const engine = createEngine();
			const events = collectEvents(engine);

			await engine.submit('.table borders');

			const info = events.find(
				(e) => e.type === 'info' && e.message.includes('Current:'),
			);
			expect(info).toBeDefined();
		});

		it('sets valid border style', async () => {
			const engine = createEngine();
			const events = collectEvents(engine);

			await engine.submit('.table borders none');

			expect(mockConfig.updateTable).toHaveBeenCalledWith({
				borderStyle: 'none',
			});
			const info = events.find(
				(e) => e.type === 'info' && e.message.includes('borders = none'),
			);
			expect(info).toBeDefined();
		});

		it('accepts .table border (singular alias)', async () => {
			const engine = createEngine();
			const events = collectEvents(engine);

			await engine.submit('.table border outline');

			expect(mockConfig.updateTable).toHaveBeenCalledWith({
				borderStyle: 'outline',
			});
		});

		it('rejects invalid border style', async () => {
			const engine = createEngine();
			const events = collectEvents(engine);

			await engine.submit('.table borders invalid');

			expect(findEvent(events, 'error')).toBeDefined();
		});

		// --- overflow ---
		it('shows overflow value without argument', async () => {
			const engine = createEngine();
			const events = collectEvents(engine);

			await engine.submit('.table overflow');

			const info = events.find(
				(e) => e.type === 'info' && e.message.includes('Current:'),
			);
			expect(info).toBeDefined();
		});

		it('sets valid overflow style', async () => {
			const engine = createEngine();

			await engine.submit('.table overflow truncate');

			expect(mockConfig.updateTable).toHaveBeenCalledWith({
				overflow: 'truncate',
			});
		});

		it('rejects invalid overflow style', async () => {
			const engine = createEngine();
			const events = collectEvents(engine);

			await engine.submit('.table overflow bad');

			expect(findEvent(events, 'error')).toBeDefined();
		});

		// --- headers ---
		it('shows headers value without argument', async () => {
			const engine = createEngine();
			const events = collectEvents(engine);

			await engine.submit('.table headers');

			const info = events.find(
				(e) => e.type === 'info' && e.message.includes('Current:'),
			);
			expect(info).toBeDefined();
		});

		it('sets valid header formatter', async () => {
			const engine = createEngine();

			await engine.submit('.table headers none');

			expect(mockConfig.updateTable).toHaveBeenCalledWith({
				headerFormatter: 'none',
			});
		});

		it('accepts .table header (singular alias)', async () => {
			const engine = createEngine();

			await engine.submit('.table header none');

			expect(mockConfig.updateTable).toHaveBeenCalledWith({
				headerFormatter: 'none',
			});
		});

		it('rejects invalid header formatter', async () => {
			const engine = createEngine();
			const events = collectEvents(engine);

			await engine.submit('.table headers bad');

			expect(findEvent(events, 'error')).toBeDefined();
		});

		// --- padding ---
		it('shows padding value without argument', async () => {
			const engine = createEngine();
			const events = collectEvents(engine);

			await engine.submit('.table padding');

			const info = events.find(
				(e) => e.type === 'info' && e.message.includes('Current:'),
			);
			expect(info).toBeDefined();
		});

		it('sets valid padding', async () => {
			const engine = createEngine();
			const events = collectEvents(engine);

			await engine.submit('.table padding 2');

			expect(mockConfig.updateTable).toHaveBeenCalledWith({ padding: 2 });
			const info = events.find(
				(e) => e.type === 'info' && e.message.includes('padding = 2'),
			);
			expect(info).toBeDefined();
		});

		it('rejects invalid padding value', async () => {
			const engine = createEngine();
			const events = collectEvents(engine);

			await engine.submit('.table padding 99');

			expect(findEvent(events, 'error')).toBeDefined();
		});

		// --- unknown option ---
		it('rejects unknown table option', async () => {
			const engine = createEngine();
			const events = collectEvents(engine);

			await engine.submit('.table unknownoption');

			const err = events.find(
				(e) => e.type === 'error' && e.message.includes('Unknown option'),
			);
			expect(err).toBeDefined();
		});
	});

	// =========================================================================
	// processDotCommand stateChange propagation
	// =========================================================================

	describe('delegated dot-command state changes', () => {
		it('applies mode change from .sql', async () => {
			const engine = createEngine();
			const events = collectEvents(engine);

			await engine.submit('.sql');

			expect(engine.getState().mode).toBe('sql');
			expect(events.some((e) => e.type === 'state-change')).toBe(true);
		});

		it('applies mode change from .natural', async () => {
			const engine = createEngine();
			await engine.submit('.sql');
			expect(engine.getState().mode).toBe('sql');

			await engine.submit('.natural');
			expect(engine.getState().mode).toBe('natural');
		});

		it('applies execEnabled from .exec on', async () => {
			const engine = createEngine({
				databaseUrl: 'postgres://localhost/test',
			});
			await engine.init();

			await engine.submit('.exec on');

			expect(engine.getState().execMode).toBe(true);
		});

		it('applies execEnabled from .exec off', async () => {
			const engine = createEngine({ initialExecMode: true });

			await engine.submit('.exec off');

			expect(engine.getState().execMode).toBe(false);
		});

		it('toggles exec mode with .exec (no arg)', async () => {
			const engine = createEngine({
				databaseUrl: 'postgres://localhost/test',
			});
			await engine.init();
			expect(engine.getState().execMode).toBe(false);

			await engine.submit('.exec');

			expect(engine.getState().execMode).toBe(true);
		});

		it('returns error for .exec on without connection', async () => {
			const engine = createEngine();
			const events = collectEvents(engine);

			await engine.submit('.exec on');

			expect(engine.getState().execMode).toBe(false);
			const info = events.find(
				(e) =>
					e.type === 'info' && e.message.includes('No database connection'),
			);
			expect(info).toBeDefined();
		});

		it('applies schemaName from .use', async () => {
			const engine = createEngine();

			await engine.submit('.use tenant_42');

			expect(engine.getState().schemaName).toBe('tenant_42');
		});

		it('clears schemaName from .use without argument', async () => {
			const engine = createEngine({ initialSchemaName: 'tenant_1' });
			expect(engine.getState().schemaName).toBe('tenant_1');

			await engine.submit('.use');

			expect(engine.getState().schemaName).toBeUndefined();
		});

		it('applies explainMode from .explain on', async () => {
			const engine = createEngine();

			await engine.submit('.explain on');

			expect(engine.getState().explainMode).toBe(true);
		});

		it('applies explainMode from .explain off', async () => {
			const engine = createEngine();
			await engine.submit('.explain on');

			await engine.submit('.explain off');

			expect(engine.getState().explainMode).toBe(false);
		});

		it('applies parseMode from .parse on', async () => {
			const engine = createEngine();

			await engine.submit('.parse on');

			expect(engine.getState().parseMode).toBe(true);
		});

		it('applies parseMode from .parse off', async () => {
			const engine = createEngine({ initialParseMode: true });

			await engine.submit('.parse off');

			expect(engine.getState().parseMode).toBe(false);
		});

		it('applies outputMode from .output table', async () => {
			const engine = createEngine();

			await engine.submit('.output table');

			expect(engine.getState().outputMode).toBe('table');
		});

		it('applies outputMode from .output csv', async () => {
			const engine = createEngine();

			await engine.submit('.output csv');

			expect(engine.getState().outputMode).toBe('csv');
		});

		it('applies inTransaction from .begin', async () => {
			const engine = createEngine({ databaseUrl: 'postgres://localhost/test' });
			await engine.init();

			await engine.submit('.begin');

			expect(engine.getState().inTransaction).toBe(true);
		});

		it('clears inTransaction from .commit', async () => {
			const engine = createEngine({ databaseUrl: 'postgres://localhost/test' });
			await engine.init();
			await engine.submit('.begin');
			expect(engine.getState().inTransaction).toBe(true);

			await engine.submit('.commit');

			expect(engine.getState().inTransaction).toBe(false);
		});

		it('clears inTransaction from .rollback', async () => {
			const engine = createEngine({ databaseUrl: 'postgres://localhost/test' });
			await engine.init();
			await engine.submit('.begin');

			await engine.submit('.rollback');

			expect(engine.getState().inTransaction).toBe(false);
		});
	});

	// =========================================================================
	// processDotCommand error output path
	// =========================================================================

	describe('delegated dot-command error output', () => {
		it('emits error event when dot command result has error field', async () => {
			// .dump on a connected engine with executeRaw throwing triggers the
			// catch block in processDotCommand which sets error on the result
			const engine = createEngine({
				databaseUrl: 'postgres://localhost/test',
			});
			await engine.init();

			mockConnection.executeRaw.mockRejectedValueOnce(
				new Error('relation does not exist'),
			);

			const events = collectEvents(engine);
			await engine.submit('.dump users /tmp/out.csv');

			const err = findEvent(events, 'error');
			expect(err).toBeDefined();
			if (err?.type === 'error') {
				expect(err.message).toContain('Dump failed');
			}
		});

		it('emits info event when dot command result has no error', async () => {
			const engine = createEngine();
			const events = collectEvents(engine);

			// .begin without connection returns output without error field
			await engine.submit('.begin');

			const info = events.find(
				(e) =>
					e.type === 'info' && e.message.includes('No database connection'),
			);
			expect(info).toBeDefined();
		});
	});

	// =========================================================================
	// Empty query — mode-specific error messages
	// =========================================================================

	describe('empty query error messages', () => {
		it('emits natural-mode error for empty content in natural mode', async () => {
			const engine = createEngine();
			const events = collectEvents(engine);

			// "!" in natural mode escapes to raw SQL, but content is empty
			await engine.submit('!');

			const err = events.find(
				(e) => e.type === 'error' && e.message.includes('! for raw SQL'),
			);
			expect(err).toBeDefined();
		});

		it('emits sql-mode error for empty content in sql mode', async () => {
			const engine = createEngine();
			await engine.submit('.sql');

			const events = collectEvents(engine);
			// "!" in SQL mode escapes to natural query, but content is empty
			await engine.submit('!');

			const err = events.find(
				(e) => e.type === 'error' && e.message.includes('! for natural query'),
			);
			expect(err).toBeDefined();
		});
	});

	// =========================================================================
	// Raw SQL — execution and warnings
	// =========================================================================

	describe('raw SQL handling', () => {
		it('includes compile-only warning when not in exec mode', async () => {
			const engine = createEngine();
			await engine.submit('.sql');

			const events = collectEvents(engine);
			await engine.submit('SELECT 1');

			const qr = findEvent(events, 'query-result');
			expect(qr).toBeDefined();
			if (qr?.type === 'query-result') {
				const warnings = qr.result.plan?.warnings ?? [];
				expect(warnings.some((w) => w.message.includes('compile-only'))).toBe(
					true,
				);
			}
		});

		it('executes raw SQL when execMode + connected', async () => {
			const engine = createEngine({ databaseUrl: 'postgres://localhost/test' });
			await engine.init();
			await engine.submit('.exec on');
			await engine.submit('.sql');

			const events = collectEvents(engine);
			await engine.submit('SELECT 1');

			expect(mockConnection.executeRaw).toHaveBeenCalledWith('SELECT 1', []);
			const execResult = findEvent(events, 'execution-result');
			expect(execResult).toBeDefined();
		});

		it('does not execute when connected but exec mode off', async () => {
			const engine = createEngine({ databaseUrl: 'postgres://localhost/test' });
			await engine.init();
			await engine.submit('.sql');
			mockConnection.executeRaw.mockClear();

			const events = collectEvents(engine);
			await engine.submit('SELECT 1');

			expect(mockConnection.executeRaw).not.toHaveBeenCalled();
			expect(findEvent(events, 'execution-result')).toBeUndefined();
		});

		it('includes mode warning for escaped SQL (! in natural mode)', async () => {
			const engine = createEngine();
			const events = collectEvents(engine);

			await engine.submit('!SELECT 1');

			const qr = findEvent(events, 'query-result');
			expect(qr).toBeDefined();
			if (qr?.type === 'query-result') {
				expect(qr.result.plan?.strategy).toBe('RAW_SQL');
			}
		});

		it('EH-1: emits query-result with error on executeRaw failure — session continues', async () => {
			// Regression: handleRawSql had no try/catch; DB errors caused unhandled rejection.
			const engine = createEngine({ databaseUrl: 'postgres://localhost/test' });
			await engine.init();
			await engine.submit('.exec on');
			await engine.submit('.sql');

			mockConnection.executeRaw.mockRejectedValueOnce(
				new Error('column "x" does not exist'),
			);

			const events = collectEvents(engine);
			await engine.submit('SELECT x FROM users');

			// Must not throw — session continues.
			// The first query-result carries the SQL preview (before execution attempt).
			// The second query-result carries the error from the failed executeRaw.
			const queryResults = findEvents(events, 'query-result');
			expect(queryResults.length).toBeGreaterThanOrEqual(1);

			const errorResult = queryResults.find(
				(e) =>
					e.type === 'query-result' &&
					e.result.error?.includes('column "x" does not exist'),
			);
			expect(errorResult).toBeDefined();
			expect(findEvent(events, 'execution-result')).toBeUndefined();

			// Session continues: subsequent queries still work.
			const after = collectEvents(engine);
			await engine.submit('SELECT 1');
			expect(findEvent(after, 'query-result')).toBeDefined();
		});
	});

	// =========================================================================
	// NQL — explainMode
	// =========================================================================

	describe('NQL explainMode', () => {
		it('prepends EXPLAIN to SQL when explainMode is on', async () => {
			const engine = createEngine();
			await engine.submit('.explain on');
			expect(engine.getState().explainMode).toBe(true);

			const events = collectEvents(engine);
			await engine.submit('users');

			const qr = findEvent(events, 'query-result');
			expect(qr).toBeDefined();
			if (qr?.type === 'query-result') {
				expect(qr.result.sql).toMatch(/^EXPLAIN /);
			}
		});

		it('does not prepend EXPLAIN when explainMode is off', async () => {
			const engine = createEngine();
			const events = collectEvents(engine);

			await engine.submit('users');

			const qr = findEvent(events, 'query-result');
			if (qr?.type === 'query-result') {
				expect(qr.result.sql).not.toMatch(/^EXPLAIN /);
			}
		});
	});

	// =========================================================================
	// NQL — execution path
	// =========================================================================

	describe('NQL execution', () => {
		it('executes NQL query when execMode + connected', async () => {
			const engine = createEngine({ databaseUrl: 'postgres://localhost/test' });
			await engine.init();
			await engine.submit('.exec on');
			mockConnection.executeRaw.mockClear();

			const events = collectEvents(engine);
			await engine.submit('users');

			expect(mockConnection.executeRaw).toHaveBeenCalled();
			const execResult = findEvent(events, 'execution-result');
			expect(execResult).toBeDefined();
		});

		it('does not execute NQL when exec off', async () => {
			const engine = createEngine({ databaseUrl: 'postgres://localhost/test' });
			await engine.init();
			mockConnection.executeRaw.mockClear();

			const events = collectEvents(engine);
			await engine.submit('users');

			expect(mockConnection.executeRaw).not.toHaveBeenCalled();
			expect(findEvent(events, 'execution-result')).toBeUndefined();
		});

		it('does not execute NQL when not connected', async () => {
			const engine = createEngine({ initialExecMode: true });
			mockConnection.executeRaw.mockClear();

			const events = collectEvents(engine);
			await engine.submit('users');

			expect(mockConnection.executeRaw).not.toHaveBeenCalled();
			expect(findEvent(events, 'execution-result')).toBeUndefined();
		});
	});

	// =========================================================================
	// NQL — error handling
	// =========================================================================

	describe('NQL error handling', () => {
		it('emits query-result with error on NQL compile failure', async () => {
			mockCompileNqlToSql.mockRejectedValueOnce(
				new Error('Unknown table: nonexistent_table_xyz'),
			);

			const engine = createEngine();
			const events = collectEvents(engine);

			await engine.submit('nonexistent_table_xyz');

			const qr = findEvent(events, 'query-result');
			expect(qr).toBeDefined();
			if (qr?.type === 'query-result') {
				expect(qr.result.error).toBeDefined();
				expect(qr.result.sql).toBe('');
			}
		});

		it('handles non-Error thrown from NQL compiler', async () => {
			mockCompileNqlToSql.mockRejectedValueOnce('raw string error');

			const engine = createEngine();
			const events = collectEvents(engine);

			await engine.submit('some_query');

			const qr = findEvent(events, 'query-result');
			expect(qr).toBeDefined();
			if (qr?.type === 'query-result') {
				expect(qr.result.error).toBeDefined();
				expect(qr.result.sql).toBe('');
			}
		});
	});

	// =========================================================================
	// NQL — bang suffix (mutation dry-run vs execute) + CC-4 regression
	// =========================================================================

	describe('NQL bang suffix', () => {
		it('strips ! suffix and passes NQL without it to compiler', async () => {
			// Verifies handleNql strips '!' before calling compileNqlToSql.
			const engine = createEngine();
			mockCompileNqlToSql.mockResolvedValueOnce({
				sql: 'UPDATE "users" SET "status" = $1',
				params: ['active'],
				intentType: 'update',
				intent: { type: 'update', table: 'users' },
				planReport: {
					rootTable: 'users',
					decisions: [],
					warnings: [],
					ctes: [],
					metadata: {
						planningTimeMs: 1,
						relationsAnalyzed: 0,
						isAmbiguous: false,
					},
				},
			});

			await engine.submit("users | update set status = 'active'!");

			// Compiler must be called WITHOUT the trailing '!'
			expect(mockCompileNqlToSql).toHaveBeenCalledWith(
				"users | update set status = 'active'",
				expect.anything(),
				expect.anything(),
			);
		});

		it('CC-4 regression: mutation ending with quoted value + ! is NOT dry-run', async () => {
			// Regression for isInsideStringLiteral off-by-one: a closing quote at
			// length-2 (penultimate char, right before '!') must correctly end the string
			// so hasBangSuffix=true and the mutation is executed, not silently dropped.
			const engine = createEngine({ databaseUrl: 'postgres://localhost/test' });
			await engine.init();
			await engine.submit('.exec on');
			mockCompileNqlToSql.mockResolvedValueOnce({
				sql: 'UPDATE "users" SET "status" = $1',
				params: ['active'],
				intentType: 'update',
				intent: { type: 'update', table: 'users' },
				planReport: {
					rootTable: 'users',
					decisions: [],
					warnings: [],
					ctes: [],
					metadata: {
						planningTimeMs: 1,
						relationsAnalyzed: 0,
						isAmbiguous: false,
					},
				},
			});
			mockConnection.executeRaw.mockClear();

			const events = collectEvents(engine);
			await engine.submit("users | update set status = 'active'!");

			// The mutation must execute — not be treated as dry-run.
			// If isInsideStringLiteral had an off-by-one, hasBangSuffix would be false
			// → isDryRun=true → executeRaw would NOT be called.
			expect(mockConnection.executeRaw).toHaveBeenCalled();
			const qr = findEvent(events, 'query-result');
			expect(qr).toBeDefined();
			if (qr?.type === 'query-result') {
				expect(qr.result.plan?.strategy).not.toContain('DRY-RUN');
			}
		});
	});

	// =========================================================================
	// NQL — schema options pass-through
	// =========================================================================

	describe('NQL schema options', () => {
		it('passes schemaName to NQL compilation', async () => {
			const engine = createEngine({ initialSchemaName: 'myschema' });

			await engine.submit('users');

			expect(mockCompileNqlToSql).toHaveBeenCalledWith(
				'users',
				expect.anything(),
				expect.objectContaining({ schemaName: 'myschema' }),
			);
		});

		it('passes dbCasing to NQL compilation', async () => {
			const engine = createEngine({ dbCasing: 'camelCase' });

			await engine.submit('users');

			expect(mockCompileNqlToSql).toHaveBeenCalledWith(
				'users',
				expect.anything(),
				expect.objectContaining({ dbCasing: 'camelCase' }),
			);
		});

		it('passes empty options when no schema/casing set', async () => {
			const engine = createEngine();

			await engine.submit('users');

			expect(mockCompileNqlToSql).toHaveBeenCalledWith(
				'users',
				expect.anything(),
				expect.objectContaining({}),
			);
		});
	});

	// =========================================================================
	// .strategy — .strategy without arg already tested, test edge: no dialect
	// =========================================================================

	describe('.strategy — additional coverage', () => {
		it('emits info with strategy details when no arg given', async () => {
			const engine = createEngine();
			const events = collectEvents(engine);

			await engine.submit('.strategy');

			const info = events.find(
				(e) => e.type === 'info' && e.message.includes('Include Strategy'),
			);
			expect(info).toBeDefined();
			if (info?.type === 'info') {
				expect(info.message).toContain('AUTO');
				expect(info.message).toContain('postgresql');
			}
		});
	});

	// =========================================================================
	// Multiple listeners
	// =========================================================================

	describe('multiple listeners', () => {
		it('delivers events to all listeners', async () => {
			const engine = createEngine();
			const events1: EngineEvent[] = [];
			const events2: EngineEvent[] = [];

			engine.on((e) => events1.push(e));
			engine.on((e) => events2.push(e));

			await engine.submit('.clear');

			expect(events1.some((e) => e.type === 'clear')).toBe(true);
			expect(events2.some((e) => e.type === 'clear')).toBe(true);
		});

		it('unsubscribe only removes targeted listener', async () => {
			const engine = createEngine();
			const events1: EngineEvent[] = [];
			const events2: EngineEvent[] = [];

			const unsub1 = engine.on((e) => events1.push(e));
			engine.on((e) => events2.push(e));

			unsub1();
			await engine.submit('.clear');

			expect(events1).toHaveLength(0);
			expect(events2.some((e) => e.type === 'clear')).toBe(true);
		});
	});

	// =========================================================================
	// Layout — additional valid values
	// =========================================================================

	describe('.layout — additional values', () => {
		it('changes layout to results', async () => {
			const engine = createEngine();
			const events = collectEvents(engine);

			await engine.submit('.layout results');

			expect(engine.getState().outputLayout).toBe('results');
			expect(events).toContainEqual({
				type: 'layout-change',
				layout: 'results',
			});
		});

		it('changes layout to sql', async () => {
			const engine = createEngine();

			await engine.submit('.layout sql');

			expect(engine.getState().outputLayout).toBe('sql');
		});

		it('changes layout to full', async () => {
			const engine = createEngine();
			await engine.submit('.layout compact');
			expect(engine.getState().outputLayout).toBe('compact');

			await engine.submit('.layout full');

			expect(engine.getState().outputLayout).toBe('full');
		});
	});

	// =========================================================================
	// Plan verbosity — edge: .plan normal (explicit reset to default)
	// =========================================================================

	describe('.plan — additional coverage', () => {
		it('sets plan verbosity to normal explicitly', async () => {
			const engine = createEngine();
			await engine.submit('.plan verbose');

			await engine.submit('.plan normal');

			expect(engine.getState().planVerbosity).toBe('normal');
		});
	});

	// =========================================================================
	// Raw SQL with mode escape in sql mode
	// =========================================================================

	describe('mode escape in sql mode', () => {
		it('handles ! escape in sql mode to process as NQL', async () => {
			const engine = createEngine();
			await engine.submit('.sql');

			const events = collectEvents(engine);
			await engine.submit('!users');

			// In sql mode, ! escapes to natural (NQL) query
			const qr = findEvent(events, 'query-result');
			expect(qr).toBeDefined();
			if (qr?.type === 'query-result' && !qr.result.error) {
				expect(qr.result.plan?.strategy).toBe('NQL v2');
			}
		});
	});
});

// ---------------------------------------------------------------------------
// isInsideStringLiteral — edge cases
// ---------------------------------------------------------------------------

describe('isInsideStringLiteral — edge cases', () => {
	it('returns false for empty string', () => {
		expect(isInsideStringLiteral('')).toBe(false);
	});

	it('returns false for single character (not a quote)', () => {
		expect(isInsideStringLiteral('a')).toBe(false);
	});

	it('returns false for single quote alone', () => {
		expect(isInsideStringLiteral("'")).toBe(false);
	});

	it('returns true for open string with content', () => {
		expect(isInsideStringLiteral("'abc")).toBe(true);
	});

	it('returns true for string where last char is closing quote', () => {
		// The function checks if the position of the last char is inside a string.
		// For "'abc'", the last char IS the closing quote — the loop only processes
		// up to length-2, so the closing quote is never toggled. Result: true.
		expect(isInsideStringLiteral("'abc'")).toBe(true);
	});

	it('returns true for two single quotes (empty string literal)', () => {
		// "''" has length 2. Loop processes only index 0: opens string (inString=true).
		// Index 1 (the second quote, the "last char") is never processed.
		expect(isInsideStringLiteral("''")).toBe(true);
	});

	it('handles consecutive escaped quotes inside string', () => {
		// 'a''b' — the '' is an escaped quote, string is closed by final '
		expect(isInsideStringLiteral("'a''b'x")).toBe(false);
	});

	it('returns true when last char is inside deeply nested escaped quotes', () => {
		// 'a''b — opens with ', escaped '' keeps us in string, b is still inside
		expect(isInsideStringLiteral("'a''b")).toBe(true);
	});

	// CC-4 regression: mutations ending with 'val'! must NOT be treated as dry-run.
	// The closing quote is at length-2 (penultimate char); loop must correctly toggle
	// inString to false before returning, so hasBangSuffix=true in handleNql.
	it("CC-4 regression: 'val'! returns false (closing quote at length-2)", () => {
		// Minimal: 'v'! — the closing ' is the penultimate char, ! is at length-1.
		expect(isInsideStringLiteral("'v'!")).toBe(false);
	});

	it('CC-4 regression: NQL update with quoted value followed by ! is not inside string', () => {
		// Full NQL mutation input as passed to isInsideStringLiteral
		expect(isInsideStringLiteral("users | update set status = 'active'!")).toBe(
			false,
		);
	});
});
