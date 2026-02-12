// @ts-nocheck — coverage test: runtime assertions
/**
 * Coverage tests for batch.ts — targets uncovered branches not in batch.test.ts or batch.errors.test.ts.
 *
 * Focus: mapEventsToBatchResult edge cases (setOperation intent type, output modes),
 * executeBatch init/assertion paths, and runBatchMode output/exit-code paths.
 */

import { describe, expect, it, vi } from 'vitest';
import { mapEventsToBatchResult } from './batch.js';
import type { EngineEvent } from './engine/engine-types.js';
import type { ExecutionResult, QueryResult } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
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
		query: { sql: 'SELECT 1', params: [] },
	};
}

// ---------------------------------------------------------------------------
// mapEventsToBatchResult — uncovered branches
// ---------------------------------------------------------------------------

describe('mapEventsToBatchResult — coverage', () => {
	describe('setOperation intent type → query', () => {
		it('treats setOperation intent as query type (not mutation)', () => {
			const events: EngineEvent[] = [
				queryResultEvent({
					sql: 'SELECT 1 UNION SELECT 2',
					params: [],
					intent: {
						type: 'setOperation',
						table: 'users',
						with: [],
						hasWhere: false,
						hasGroupBy: false,
						hasOrderBy: false,
						ctes: [],
					},
				}),
			];

			const result = mapEventsToBatchResult('from users union from posts', events, 'json');

			expect(result.type).toBe('query');
			expect(result.success).toBe(true);
		});
	});

	describe('upsert intent type → mutation', () => {
		it('treats upsert intent as mutation type', () => {
			const events: EngineEvent[] = [
				queryResultEvent({
					sql: 'INSERT INTO "users" ("id") VALUES ($1) ON CONFLICT DO UPDATE',
					params: [1],
					intent: {
						type: 'upsert',
						table: 'users',
						with: [],
						hasWhere: false,
						hasGroupBy: false,
						hasOrderBy: false,
						ctes: [],
					},
				}),
			];

			const result = mapEventsToBatchResult('upsert users set id = 1', events, 'json');

			expect(result.type).toBe('mutation');
		});
	});

	describe('output modes (table/csv)', () => {
		it('passes table output mode to formatOutput in execution result', () => {
			const events: EngineEvent[] = [
				queryResultEvent({
					sql: 'SELECT "id" FROM "users"',
					params: [],
				}),
				executionResultEvent({
					rows: [{ id: 1 }],
					columns: ['id'],
					rowCount: 1,
					executionTimeMs: 1,
				}),
			];

			const result = mapEventsToBatchResult('from users', events, 'table');

			expect(result.dbSuccess).toBe(true);
			expect(result.output).toContain('Rows: 1');
		});

		it('passes csv output mode to formatOutput in execution result', () => {
			const events: EngineEvent[] = [
				queryResultEvent({
					sql: 'SELECT "id" FROM "users"',
					params: [],
				}),
				executionResultEvent({
					rows: [{ id: 1 }],
					columns: ['id'],
					rowCount: 1,
					executionTimeMs: 1,
				}),
			];

			const result = mapEventsToBatchResult('from users', events, 'csv');

			expect(result.dbSuccess).toBe(true);
			expect(result.output).toContain('Rows: 1');
		});
	});

	describe('query-result without plan (strategy fallback)', () => {
		it('uses QUERY as default label when plan is undefined', () => {
			const events: EngineEvent[] = [
				queryResultEvent({
					sql: 'SELECT 1',
					params: [],
					plan: undefined,
				}),
			];

			const result = mapEventsToBatchResult('SELECT 1', events, 'json');

			expect(result.output).toContain('[QUERY]');
		});
	});

	describe('execution with DB error includes error icon in output', () => {
		it('sets output to error icon + DB error message', () => {
			const events: EngineEvent[] = [
				queryResultEvent({ sql: 'DROP TABLE x', params: [] }),
				executionResultEvent({
					error: 'permission denied',
					rows: [],
					columns: [],
					rowCount: 0,
					executionTimeMs: 0,
				}),
			];

			const result = mapEventsToBatchResult('DROP TABLE x', events, 'json');

			expect(result.dbSuccess).toBe(false);
			expect(result.error).toBe('Database error: permission denied');
			expect(result.output).toContain('Error: Database error: permission denied');
		});
	});

	describe('intent is not spread onto result when absent', () => {
		it('result has no intent key when query-result lacks intent', () => {
			const events: EngineEvent[] = [
				queryResultEvent({ sql: 'SELECT 1', params: [] }),
			];

			const result = mapEventsToBatchResult('SELECT 1', events, 'json');

			expect('intent' in result).toBe(false);
		});
	});

	describe('state-change events', () => {
		it('state-change event alone → fallback (no query-result, no info, no error)', () => {
			const events: EngineEvent[] = [
				{
					type: 'state-change',
					state: {
						mode: 'natural',
						execMode: false,
						connected: false,
						explainMode: false,
						parseMode: false,
						aliasingMode: 'always',
						includeStrategy: 'auto',
						dialect: 'postgresql',
						outputMode: 'json',
						outputLayout: 'compact',
						planVerbosity: 'normal',
						inTransaction: false,
					},
				},
			];

			const result = mapEventsToBatchResult('.output json', events, 'json');

			expect(result.success).toBe(true);
			expect(result.output).toBe('');
			expect(result.type).toBe('command');
		});
	});

	describe('show-panel and show-history events', () => {
		it('show-panel event alone → fallback', () => {
			const events: EngineEvent[] = [{ type: 'show-panel', view: 'sql' }];
			const result = mapEventsToBatchResult('.sql', events, 'json');
			expect(result.success).toBe(true);
			expect(result.type).toBe('command');
		});

		it('show-history event alone → fallback', () => {
			const events: EngineEvent[] = [{ type: 'show-history' }];
			const result = mapEventsToBatchResult('.history', events, 'json');
			expect(result.success).toBe(true);
			expect(result.type).toBe('command');
		});
	});
});
