/**
 * Pure unit tests for batch.ts parsing/logic — no mocks, no database.
 *
 * Tests mapEventsToBatchResult (pure function that maps EngineEvent[] to BatchResult)
 * covering all event patterns: NQL errors, NQL success, DB execution, dot commands, and fallbacks.
 */

import { describe, expect, it } from 'vitest';
import { mapEventsToBatchResult } from './batch.js';
import type { EngineEvent } from './engine/engine-types.js';
import type { ExecutionResult, QueryResult } from './types.js';

// ---------------------------------------------------------------------------
// Helpers: Build typed EngineEvent objects without touching the DB
// ---------------------------------------------------------------------------

function queryResultEvent(
	overrides: Partial<QueryResult> = {},
): EngineEvent & { type: 'query-result' } {
	return {
		type: 'query-result',
		result: {
			sql: 'SELECT 1',
			params: [],
			...overrides,
		},
	};
}

function executionResultEvent(
	overrides: Partial<ExecutionResult> = {},
	queryOverrides: Partial<QueryResult> = {},
): EngineEvent & { type: 'execution-result' } {
	return {
		type: 'execution-result',
		result: {
			rows: [],
			columns: [],
			rowCount: 0,
			executionTimeMs: 1,
			...overrides,
		},
		query: {
			sql: 'SELECT 1',
			params: [],
			...queryOverrides,
		},
	};
}

function infoEvent(message: string): EngineEvent & { type: 'info' } {
	return { type: 'info', message };
}

function errorEvent(message: string): EngineEvent & { type: 'error' } {
	return { type: 'error', message };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('mapEventsToBatchResult', () => {
	// -----------------------------------------------------------------------
	// 1. NQL compilation error
	// -----------------------------------------------------------------------
	describe('NQL compilation error', () => {
		it('returns success=false with the error message when query-result has .error', () => {
			const events: EngineEvent[] = [
				queryResultEvent({ error: 'Unknown table "foo"' }),
			];

			const result = mapEventsToBatchResult('from foo', events, 'json');

			expect(result.success).toBe(false);
			expect(result.error).toBe('Unknown table "foo"');
			expect(result.output).toBe('Unknown table "foo"');
			expect(result.type).toBe('query');
			expect(result.query).toBe('from foo');
		});

		it('does not include sql or params on compilation error', () => {
			const events: EngineEvent[] = [
				queryResultEvent({ error: 'Parse error at line 1' }),
			];

			const result = mapEventsToBatchResult('bad query', events, 'json');

			expect(result.sql).toBeUndefined();
			expect(result.params).toBeUndefined();
		});
	});

	// -----------------------------------------------------------------------
	// 2. NQL success without DB execution
	// -----------------------------------------------------------------------
	describe('NQL success without execution (compile-only)', () => {
		it('returns success=true with sql and params', () => {
			const events: EngineEvent[] = [
				queryResultEvent({
					sql: 'SELECT "id", "name" FROM "users"',
					params: [],
					plan: {
						strategy: 'SINGLE_TABLE',
						rootTable: 'users',
						tables: ['users'],
						decisions: [],
						warnings: [],
						cteCount: 0,
						planningTimeMs: 1,
					},
				}),
			];

			const result = mapEventsToBatchResult(
				'from users select id, name',
				events,
				'json',
			);

			expect(result.success).toBe(true);
			expect(result.sql).toBe('SELECT "id", "name" FROM "users"');
			expect(result.params).toEqual([]);
			expect(result.type).toBe('query');
			expect(result.dbSuccess).toBeUndefined();
		});

		it('output includes strategy label and SQL', () => {
			const events: EngineEvent[] = [
				queryResultEvent({
					sql: 'SELECT * FROM "users"',
					params: [],
					plan: {
						strategy: 'SINGLE_TABLE',
						rootTable: 'users',
						tables: ['users'],
						decisions: [],
						warnings: [],
						cteCount: 0,
						planningTimeMs: 0,
					},
				}),
			];

			const result = mapEventsToBatchResult('from users', events, 'json');

			expect(result.output).toContain('[SINGLE_TABLE]');
			expect(result.output).toContain('SQL:');
			expect(result.output).toContain('SELECT * FROM "users"');
		});

		it('defaults strategy label to QUERY when plan is undefined', () => {
			const events: EngineEvent[] = [
				queryResultEvent({ sql: 'SELECT 1', params: [] }),
			];

			const result = mapEventsToBatchResult('SELECT 1', events, 'json');

			expect(result.output).toContain('[QUERY]');
		});
	});

	// -----------------------------------------------------------------------
	// 3. NQL success + DB execution success
	// -----------------------------------------------------------------------
	describe('NQL success + DB execution success', () => {
		it('returns dbSuccess=true with rows and rowCount', () => {
			const events: EngineEvent[] = [
				queryResultEvent({
					sql: 'SELECT "id" FROM "users"',
					params: [],
				}),
				executionResultEvent({
					rows: [{ id: 1 }, { id: 2 }],
					columns: ['id'],
					rowCount: 2,
					executionTimeMs: 5,
				}),
			];

			const result = mapEventsToBatchResult(
				'from users select id',
				events,
				'json',
			);

			expect(result.success).toBe(true);
			expect(result.dbSuccess).toBe(true);
			expect(result.rowCount).toBe(2);
			expect(result.rows).toEqual([{ id: 1 }, { id: 2 }]);
			expect(result.columns).toEqual(['id']);
		});

		it('output includes row count', () => {
			const events: EngineEvent[] = [
				queryResultEvent({ sql: 'SELECT 1', params: [] }),
				executionResultEvent({
					rows: [{ '?column?': 1 }],
					columns: ['?column?'],
					rowCount: 1,
					executionTimeMs: 0,
				}),
			];

			const result = mapEventsToBatchResult('SELECT 1', events, 'json');

			expect(result.output).toContain('Rows: 1');
		});
	});

	// -----------------------------------------------------------------------
	// 4. NQL success + DB execution error
	// -----------------------------------------------------------------------
	describe('NQL success + DB execution error', () => {
		it('returns dbSuccess=false with prefixed error message', () => {
			const events: EngineEvent[] = [
				queryResultEvent({
					sql: 'SELECT "id" FROM "nonexistent"',
					params: [],
				}),
				executionResultEvent({
					error: 'relation "nonexistent" does not exist',
					rows: [],
					columns: [],
					rowCount: 0,
					executionTimeMs: 0,
				}),
			];

			const result = mapEventsToBatchResult(
				'from nonexistent select id',
				events,
				'json',
			);

			// C1 fix: success must be false when DB execution fails (not just dbSuccess)
			expect(result.success).toBe(false);
			expect(result.dbSuccess).toBe(false);
			expect(result.error).toBe(
				'Database error: relation "nonexistent" does not exist',
			);
		});

		it('output shows error icon for DB failures', () => {
			const events: EngineEvent[] = [
				queryResultEvent({ sql: 'BAD SQL', params: [] }),
				executionResultEvent({
					error: 'syntax error',
					rows: [],
					columns: [],
					rowCount: 0,
					executionTimeMs: 0,
				}),
			];

			const result = mapEventsToBatchResult('BAD SQL', events, 'json');

			expect(result.output).toContain('Error: Database error: syntax error');
		});
	});

	// -----------------------------------------------------------------------
	// 5. Dot command error
	// -----------------------------------------------------------------------
	describe('dot command error', () => {
		it('returns success=false with type command', () => {
			const events: EngineEvent[] = [errorEvent('Unknown command: .foo')];

			const result = mapEventsToBatchResult('.foo', events, 'json');

			expect(result.success).toBe(false);
			expect(result.error).toBe('Unknown command: .foo');
			expect(result.output).toBe('Unknown command: .foo');
			expect(result.type).toBe('command');
		});
	});

	// -----------------------------------------------------------------------
	// 6. Dot command info
	// -----------------------------------------------------------------------
	describe('dot command info', () => {
		it('returns success=true with info message', () => {
			const events: EngineEvent[] = [infoEvent('EXPLAIN mode: ON')];

			const result = mapEventsToBatchResult('.explain', events, 'json');

			expect(result.success).toBe(true);
			expect(result.output).toBe('EXPLAIN mode: ON');
			expect(result.type).toBe('command');
		});
	});

	// -----------------------------------------------------------------------
	// 7. Fallback: no matching events
	// -----------------------------------------------------------------------
	describe('fallback — unrecognized events', () => {
		it('returns success=true with empty output and type command', () => {
			const events: EngineEvent[] = [{ type: 'clear' }];

			const result = mapEventsToBatchResult('.clear', events, 'json');

			expect(result.success).toBe(true);
			expect(result.output).toBe('');
			expect(result.type).toBe('command');
		});

		it('handles completely empty event list', () => {
			const result = mapEventsToBatchResult('.noop', [], 'json');

			expect(result.success).toBe(true);
			expect(result.output).toBe('');
			expect(result.type).toBe('command');
		});
	});

	// -----------------------------------------------------------------------
	// 8. Mutation type detection
	// -----------------------------------------------------------------------
	describe('mutation type detection', () => {
		it('returns type mutation when intent.type is insert', () => {
			const events: EngineEvent[] = [
				queryResultEvent({
					sql: 'INSERT INTO "users" ("name") VALUES ($1)',
					params: ['Alice'],
					intent: {
						type: 'insert',
						table: 'users',
						with: [],
						hasWhere: false,
						hasGroupBy: false,
						hasOrderBy: false,
						ctes: [],
					},
				}),
			];

			const result = mapEventsToBatchResult(
				'into users set name = "Alice"',
				events,
				'json',
			);

			expect(result.type).toBe('mutation');
		});

		it('returns type mutation when intent.type is update', () => {
			const events: EngineEvent[] = [
				queryResultEvent({
					sql: 'UPDATE "users" SET "name" = $1',
					params: ['Bob'],
					intent: {
						type: 'update',
						table: 'users',
						with: [],
						hasWhere: false,
						hasGroupBy: false,
						hasOrderBy: false,
						ctes: [],
					},
				}),
			];

			const result = mapEventsToBatchResult(
				'update users set name = "Bob"',
				events,
				'json',
			);

			expect(result.type).toBe('mutation');
		});

		it('returns type mutation when intent.type is delete', () => {
			const events: EngineEvent[] = [
				queryResultEvent({
					sql: 'DELETE FROM "users" WHERE "id" = $1',
					params: [1],
					intent: {
						type: 'delete',
						table: 'users',
						with: [],
						hasWhere: true,
						hasGroupBy: false,
						hasOrderBy: false,
						ctes: [],
					},
				}),
			];

			const result = mapEventsToBatchResult(
				'delete users where id = 1',
				events,
				'json',
			);

			expect(result.type).toBe('mutation');
		});

		it('returns type query when intent.type is query', () => {
			const events: EngineEvent[] = [
				queryResultEvent({
					sql: 'SELECT * FROM "users"',
					params: [],
					intent: {
						type: 'query',
						table: 'users',
						with: [],
						hasWhere: false,
						hasGroupBy: false,
						hasOrderBy: false,
						ctes: [],
					},
				}),
			];

			const result = mapEventsToBatchResult('from users', events, 'json');

			expect(result.type).toBe('query');
		});

		it('returns type query when intent is absent', () => {
			const events: EngineEvent[] = [
				queryResultEvent({ sql: 'SELECT 1', params: [] }),
			];

			const result = mapEventsToBatchResult('SELECT 1', events, 'json');

			expect(result.type).toBe('query');
		});
	});

	// -----------------------------------------------------------------------
	// 9. Parameters formatting
	// -----------------------------------------------------------------------
	describe('parameters formatting in output', () => {
		it('includes Parameters line when params are non-empty', () => {
			const events: EngineEvent[] = [
				queryResultEvent({
					sql: 'SELECT * FROM "users" WHERE "id" = $1',
					params: [42],
				}),
			];

			const result = mapEventsToBatchResult(
				'from users where id = 42',
				events,
				'json',
			);

			expect(result.output).toContain('Parameters: [42]');
		});

		it('omits Parameters line when params are empty', () => {
			const events: EngineEvent[] = [
				queryResultEvent({ sql: 'SELECT 1', params: [] }),
			];

			const result = mapEventsToBatchResult('SELECT 1', events, 'json');

			expect(result.output).not.toContain('Parameters');
		});

		it('formats string parameters with JSON quoting', () => {
			const events: EngineEvent[] = [
				queryResultEvent({
					sql: 'SELECT * FROM "users" WHERE "name" = $1',
					params: ['Alice'],
				}),
			];

			const result = mapEventsToBatchResult(
				'from users where name = "Alice"',
				events,
				'json',
			);

			expect(result.output).toContain('Parameters: ["Alice"]');
		});

		it('formats multiple parameters separated by commas', () => {
			const events: EngineEvent[] = [
				queryResultEvent({
					sql: 'SELECT * FROM "users" WHERE "id" = $1 AND "name" = $2',
					params: [1, 'Bob'],
				}),
			];

			const result = mapEventsToBatchResult(
				'from users where id = 1 and name = "Bob"',
				events,
				'json',
			);

			expect(result.output).toContain('Parameters: [1, "Bob"]');
		});
	});

	// -----------------------------------------------------------------------
	// 10. Intent summary propagation
	// -----------------------------------------------------------------------
	describe('intent summary propagation', () => {
		it('includes intent on the result when present in query-result', () => {
			const intent = {
				type: 'query' as const,
				table: 'users',
				with: ['posts'],
				hasWhere: true,
				hasGroupBy: false,
				hasOrderBy: true,
				ctes: [],
			};
			const events: EngineEvent[] = [
				queryResultEvent({
					sql: 'SELECT * FROM "users"',
					params: [],
					intent,
				}),
			];

			const result = mapEventsToBatchResult(
				'from users with posts where id = 1 order by name',
				events,
				'json',
			);

			expect(result.intent).toEqual(intent);
		});

		it('does not include intent when absent from query-result', () => {
			const events: EngineEvent[] = [
				queryResultEvent({ sql: 'SELECT 1', params: [] }),
			];

			const result = mapEventsToBatchResult('SELECT 1', events, 'json');

			expect(result.intent).toBeUndefined();
		});
	});

	// -----------------------------------------------------------------------
	// 11. Event priority: query-result takes precedence over info/error
	// -----------------------------------------------------------------------
	describe('event priority', () => {
		it('query-result takes precedence over error event', () => {
			const events: EngineEvent[] = [
				queryResultEvent({ sql: 'SELECT 1', params: [] }),
				errorEvent('spurious error'),
			];

			const result = mapEventsToBatchResult('SELECT 1', events, 'json');

			// query-result path should win
			expect(result.success).toBe(true);
			expect(result.sql).toBe('SELECT 1');
			expect(result.type).toBe('query');
		});

		it('error event takes precedence over info event (no query-result)', () => {
			const events: EngineEvent[] = [
				infoEvent('some info'),
				errorEvent('command failed'),
			];

			const result = mapEventsToBatchResult('.broken', events, 'json');

			expect(result.success).toBe(false);
			expect(result.error).toBe('command failed');
			expect(result.type).toBe('command');
		});
	});
});
