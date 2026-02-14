import { beforeEach, describe, expect, it } from 'vitest';
import type { RunAssertionsResult } from '@/lib/ipc';
import {
	getSummary,
	hasParseErrors,
	isAllPassed,
	useAssertionStore,
} from './assertion-store';

// ── Mock data ───────────────────────────────────────────────────────

const mockResult: RunAssertionsResult = {
	summary: {
		total: 3,
		passed: 2,
		failed: 1,
		skipped: 0,
		results: [
			{
				queryIndex: 0,
				query: 'users',
				querySuccess: true,
				assertions: [
					{
						type: 'sql.equals',
						expected: 'SELECT',
						actual: 'SELECT "id", "name" FROM "users"',
						passed: true,
						message: undefined,
					},
					{
						type: 'success',
						expected: true,
						actual: true,
						passed: true,
						message: undefined,
					},
				],
				passed: true,
			},
			{
				queryIndex: 1,
				query: 'users | where active = true',
				querySuccess: true,
				assertions: [
					{
						type: 'intent.table',
						expected: 'orders',
						actual: 'users',
						passed: false,
						message: 'Expected table "orders" but got "users"',
					},
				],
				passed: false,
			},
		],
	},
	queryResults: [
		{ query: 'users', success: true, sql: 'SELECT "id", "name" FROM "users"' },
		{
			query: 'users | where active = true',
			success: true,
			sql: 'SELECT "id", "name" FROM "users" WHERE "active" = $1',
		},
	],
	parseErrors: [],
};

const mockResultAllPassed: RunAssertionsResult = {
	summary: {
		total: 2,
		passed: 2,
		failed: 0,
		skipped: 0,
		results: [],
	},
	queryResults: [],
	parseErrors: [],
};

const mockResultWithParseErrors: RunAssertionsResult = {
	summary: { total: 0, passed: 0, failed: 0, skipped: 0, results: [] },
	queryResults: [],
	parseErrors: [{ line: 1, message: 'Unknown assertion type: "bad.type"' }],
};

// ── Store tests ─────────────────────────────────────────────────────

beforeEach(() => {
	useAssertionStore.getState().clear();
});

describe('useAssertionStore', () => {
	it('starts with empty state', () => {
		const state = useAssertionStore.getState();
		expect(state.result).toBeNull();
		expect(state.running).toBe(false);
		expect(state.error).toBeNull();
		expect(state.assertTabId).toBeNull();
		expect(state.dbspTabId).toBeNull();
	});

	it('setRunning marks running and stores tab IDs', () => {
		useAssertionStore.getState().setRunning('assert-tab-1', 'dbsp-tab-1');
		const state = useAssertionStore.getState();
		expect(state.running).toBe(true);
		expect(state.assertTabId).toBe('assert-tab-1');
		expect(state.dbspTabId).toBe('dbsp-tab-1');
		expect(state.error).toBeNull();
	});

	it('setResult stores result and clears running', () => {
		useAssertionStore.getState().setRunning('a', 'b');
		useAssertionStore.getState().setResult(mockResult);
		const state = useAssertionStore.getState();
		expect(state.result).toBe(mockResult);
		expect(state.running).toBe(false);
		expect(state.error).toBeNull();
	});

	it('setError stores error and clears running + result', () => {
		useAssertionStore.getState().setRunning('a', 'b');
		useAssertionStore.getState().setResult(mockResult);
		useAssertionStore.getState().setError('Connection refused');
		const state = useAssertionStore.getState();
		expect(state.error).toBe('Connection refused');
		expect(state.running).toBe(false);
		expect(state.result).toBeNull();
	});

	it('clear resets all state', () => {
		useAssertionStore.getState().setRunning('a', 'b');
		useAssertionStore.getState().setResult(mockResult);
		useAssertionStore.getState().clear();
		const state = useAssertionStore.getState();
		expect(state.result).toBeNull();
		expect(state.running).toBe(false);
		expect(state.error).toBeNull();
		expect(state.assertTabId).toBeNull();
		expect(state.dbspTabId).toBeNull();
	});
});

// ── Derived helpers ─────────────────────────────────────────────────

describe('getSummary', () => {
	it('returns null when no result', () => {
		expect(getSummary({ result: null } as never)).toBeNull();
	});

	it('returns summary from result', () => {
		expect(getSummary({ result: mockResult } as never)).toBe(
			mockResult.summary,
		);
	});
});

describe('hasParseErrors', () => {
	it('returns false when no result', () => {
		expect(hasParseErrors({ result: null } as never)).toBe(false);
	});

	it('returns false when no parse errors', () => {
		expect(hasParseErrors({ result: mockResult } as never)).toBe(false);
	});

	it('returns true when parse errors exist', () => {
		expect(hasParseErrors({ result: mockResultWithParseErrors } as never)).toBe(
			true,
		);
	});
});

describe('isAllPassed', () => {
	it('returns false when no result', () => {
		expect(isAllPassed({ result: null } as never)).toBe(false);
	});

	it('returns false when failures exist', () => {
		expect(isAllPassed({ result: mockResult } as never)).toBe(false);
	});

	it('returns true when all pass', () => {
		expect(isAllPassed({ result: mockResultAllPassed } as never)).toBe(true);
	});
});
