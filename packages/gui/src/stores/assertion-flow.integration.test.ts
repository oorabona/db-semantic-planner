/**
 * Integration tests for the assertion flow:
 *   open .assert.dbsp → run assertions → display results
 *
 * Tests cross-store coordination between:
 *   - editor-store (tabs, file pairing)
 *   - assertion-store (run state, results)
 *   - results-store (active tab switching)
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
	MAX_ASSERTION_COUNT,
	validateAssertionContent,
	validateDbspContent,
	withTimeout,
} from '@/lib/assertion-limits';
import type { RunAssertionsResult } from '@/lib/ipc';
import { useAssertionStore } from './assertion-store';
import { useEditorStore } from './editor-store';
import { useResultsStore } from './results-store';

// ── Fixtures ──────────────────────────────────────────────────────

const mockAssertContent = `--- query: 1
sql.equals: SELECT "id", "name" FROM "users"
success: true`;

const mockDbspContent = 'users';

const mockResult: RunAssertionsResult = {
	summary: {
		total: 2,
		passed: 2,
		failed: 0,
		skipped: 0,
		results: [
			{
				queryIndex: 0,
				query: 'users',
				querySuccess: true,
				assertions: [
					{
						type: 'sql.equals',
						expected: 'SELECT "id", "name" FROM "users"',
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
		],
	},
	queryResults: [
		{ query: 'users', success: true, sql: 'SELECT "id", "name" FROM "users"' },
	],
	parseErrors: [],
};

const mockFailedResult: RunAssertionsResult = {
	summary: {
		total: 2,
		passed: 1,
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
						expected: 'SELECT * FROM "users"',
						actual: 'SELECT "id", "name" FROM "users"',
						passed: false,
						message:
							'Expected SQL "SELECT * FROM "users"" but got "SELECT "id", "name" FROM "users""',
					},
				],
				passed: false,
			},
		],
	},
	queryResults: [
		{ query: 'users', success: true, sql: 'SELECT "id", "name" FROM "users"' },
	],
	parseErrors: [],
};

// ── Reset all stores between tests ───────────────────────────────

beforeEach(() => {
	useAssertionStore.getState().clear();
	useResultsStore.getState().clear();
	// Clear editor store tabs
	const { tabs, closeTab } = useEditorStore.getState();
	for (const tab of tabs) {
		closeTab(tab.id);
	}
});

// ── Integration: file pairing ────────────────────────────────────

describe('file pairing (.assert.dbsp ↔ .dbsp)', () => {
	it('editor store can host both assert and dbsp tabs simultaneously', () => {
		const { addTab, findTabByFilePath } = useEditorStore.getState();
		addTab('assert', mockAssertContent, '/project/test.assert.dbsp');
		addTab('nql', mockDbspContent, '/project/test.dbsp');

		const assertTab = findTabByFilePath('/project/test.assert.dbsp');
		const dbspTab = findTabByFilePath('/project/test.dbsp');

		expect(assertTab).toBeDefined();
		expect(dbspTab).toBeDefined();
		expect(assertTab?.language).toBe('assert');
		expect(dbspTab?.language).toBe('nql');
	});

	it('findTabByFilePath returns undefined for missing paired file', () => {
		const { addTab, findTabByFilePath } = useEditorStore.getState();
		addTab('assert', mockAssertContent, '/project/test.assert.dbsp');

		const dbspTab = findTabByFilePath('/project/test.dbsp');
		expect(dbspTab).toBeUndefined();
	});

	it('assert tab content is accessible by tab ID for assertion run', () => {
		const { addTab } = useEditorStore.getState();
		const tabId = addTab(
			'assert',
			mockAssertContent,
			'/project/test.assert.dbsp',
		);

		const state = useEditorStore.getState();
		const tab = state.tabs.find((t) => t.id === tabId);

		expect(tab?.content).toBe(mockAssertContent);
		expect(tab?.language).toBe('assert');
	});

	it('opening assert tab sets it as active', () => {
		const { addTab } = useEditorStore.getState();
		const assertId = addTab(
			'assert',
			mockAssertContent,
			'/project/test.assert.dbsp',
		);

		expect(useEditorStore.getState().activeTabId).toBe(assertId);
	});

	it('.dbsp file path derived from .assert.dbsp by suffix replacement', () => {
		// Simulates the path derivation logic from App.tsx
		const assertPath = '/project/test.assert.dbsp';
		const dbspPath = assertPath.replace('.assert.dbsp', '.dbsp');
		expect(dbspPath).toBe('/project/test.dbsp');
	});

	it('derivation handles nested paths correctly', () => {
		const assertPath = '/project/schemas/blog/queries.assert.dbsp';
		const dbspPath = assertPath.replace('.assert.dbsp', '.dbsp');
		expect(dbspPath).toBe('/project/schemas/blog/queries.dbsp');
	});
});

// ── Integration: assertion run state machine ─────────────────────

describe('assertion run flow (store transitions)', () => {
	it('full success flow: idle → running → result', () => {
		const { addTab } = useEditorStore.getState();
		const assertTabId = addTab(
			'assert',
			mockAssertContent,
			'/project/test.assert.dbsp',
		);
		const dbspTabId = addTab('nql', mockDbspContent, '/project/test.dbsp');

		// Phase 1: Start running
		useAssertionStore.getState().setRunning(assertTabId, dbspTabId);

		let state = useAssertionStore.getState();
		expect(state.running).toBe(true);
		expect(state.assertTabId).toBe(assertTabId);
		expect(state.dbspTabId).toBe(dbspTabId);
		expect(state.result).toBeNull();
		expect(state.error).toBeNull();

		// Phase 2: Receive result
		useAssertionStore.getState().setResult(mockResult);

		state = useAssertionStore.getState();
		expect(state.running).toBe(false);
		expect(state.result).toBe(mockResult);
		expect(state.error).toBeNull();
		// Tab IDs preserved after result
		expect(state.assertTabId).toBe(assertTabId);
		expect(state.dbspTabId).toBe(dbspTabId);
	});

	it('error flow: idle → running → error', () => {
		const { addTab } = useEditorStore.getState();
		const assertTabId = addTab(
			'assert',
			mockAssertContent,
			'/project/test.assert.dbsp',
		);

		useAssertionStore.getState().setRunning(assertTabId, assertTabId);
		useAssertionStore.getState().setError('Connection refused');

		const state = useAssertionStore.getState();
		expect(state.running).toBe(false);
		expect(state.error).toBe('Connection refused');
		expect(state.result).toBeNull();
	});

	it('re-run replaces previous result', () => {
		const { addTab } = useEditorStore.getState();
		const id = addTab('assert', mockAssertContent, '/project/test.assert.dbsp');

		// First run: success
		useAssertionStore.getState().setRunning(id, id);
		useAssertionStore.getState().setResult(mockResult);
		expect(useAssertionStore.getState().result?.summary.failed).toBe(0);

		// Second run: failure
		useAssertionStore.getState().setRunning(id, id);
		useAssertionStore.getState().setResult(mockFailedResult);
		expect(useAssertionStore.getState().result?.summary.failed).toBe(1);
	});
});

// ── Integration: results panel activation ────────────────────────

describe('results panel coordination', () => {
	it('assertion run switches results tab to assertions', () => {
		// Simulate: results panel starts on "results" tab
		expect(useResultsStore.getState().activeTab).toBe('results');

		// When assertion run starts, App.tsx sets activeTab to "assertions"
		useResultsStore.getState().setActiveTab('assertions');

		expect(useResultsStore.getState().activeTab).toBe('assertions');
	});

	it('results tab returns to results after clearing assertions', () => {
		useResultsStore.getState().setActiveTab('assertions');
		useAssertionStore.getState().clear();
		useResultsStore.getState().setActiveTab('results');

		expect(useResultsStore.getState().activeTab).toBe('results');
		expect(useAssertionStore.getState().result).toBeNull();
	});

	it('query execution does not interfere with assertion state', () => {
		// Set assertion result
		useAssertionStore.getState().setRunning('a', 'b');
		useAssertionStore.getState().setResult(mockResult);

		// Run a normal query (different store)
		useResultsStore.getState().setExecuting(true);
		useResultsStore.getState().setResult({
			columns: ['id'],
			rows: [{ id: 1 }],
			durationMs: 10,
		});

		// Assertion state unchanged
		expect(useAssertionStore.getState().result).toBe(mockResult);
		expect(useAssertionStore.getState().running).toBe(false);
	});
});

// ── Integration: cross-store consistency ─────────────────────────

describe('cross-store consistency', () => {
	it('closing assert tab preserves assertion results', () => {
		const { addTab, closeTab } = useEditorStore.getState();
		const tabId = addTab(
			'assert',
			mockAssertContent,
			'/project/test.assert.dbsp',
		);

		useAssertionStore.getState().setRunning(tabId, tabId);
		useAssertionStore.getState().setResult(mockResult);

		// Close the tab
		closeTab(tabId);

		// Results still available (user can see them even if tab closed)
		expect(useAssertionStore.getState().result).toBe(mockResult);
		expect(useAssertionStore.getState().assertTabId).toBe(tabId);
	});

	it('duplicate tab detection prevents double-open', () => {
		const { addTab, findTabByFilePath, setActiveTab } =
			useEditorStore.getState();
		const id1 = addTab(
			'assert',
			mockAssertContent,
			'/project/test.assert.dbsp',
		);
		addTab('nql', 'other', '/project/other.dbsp');

		// Simulate SC-26: re-open same file → focus existing
		const existing = findTabByFilePath('/project/test.assert.dbsp');
		if (existing) {
			setActiveTab(existing.id);
		}

		expect(useEditorStore.getState().activeTabId).toBe(id1);
		expect(useEditorStore.getState().tabs).toHaveLength(2);
	});

	it('all stores can be independently cleared', () => {
		// Populate all stores
		useEditorStore
			.getState()
			.addTab('assert', mockAssertContent, '/project/test.assert.dbsp');
		useAssertionStore.getState().setRunning('a', 'b');
		useAssertionStore.getState().setResult(mockResult);
		useResultsStore.getState().setActiveTab('assertions');

		// Clear assertion store
		useAssertionStore.getState().clear();

		// Editor and results stores unaffected
		expect(useEditorStore.getState().tabs).toHaveLength(1);
		expect(useResultsStore.getState().activeTab).toBe('assertions');
		expect(useAssertionStore.getState().result).toBeNull();
	});
});

// ── Edge cases: resource limits & timeouts (F005, F006, F007) ────

describe('edge cases: empty and oversized files', () => {
	it('empty .assert.dbsp content is rejected by validation', () => {
		const result = validateAssertionContent('');
		expect(result).not.toBeNull();
		expect(result!.message).toBe('Assertion file is empty.');
	});

	it('whitespace-only .assert.dbsp content is rejected', () => {
		const result = validateAssertionContent('   \n  \t  ');
		expect(result).not.toBeNull();
		expect(result!.message).toBe('Assertion file is empty.');
	});

	it('empty .dbsp content is rejected by validation', () => {
		const result = validateDbspContent('');
		expect(result).not.toBeNull();
		expect(result!.message).toBe('Query file is empty.');
	});

	it('file with too many assertion blocks is rejected', () => {
		const blocks = Array.from(
			{ length: MAX_ASSERTION_COUNT + 1 },
			(_, i) => `--- query: ${i + 1}\nsql.equals: SELECT ${i + 1}`,
		).join('\n');
		const result = validateAssertionContent(blocks);
		expect(result).not.toBeNull();
		expect(result!.message).toContain('Too many assertion blocks');
	});

	it('valid content passes validation', () => {
		expect(validateAssertionContent(mockAssertContent)).toBeNull();
		expect(validateDbspContent(mockDbspContent)).toBeNull();
	});
});

describe('edge cases: timeout handling (F006)', () => {
	it('withTimeout resolves for fast operations', async () => {
		const result = await withTimeout(Promise.resolve('ok'), 1000, 'test');
		expect(result).toBe('ok');
	});

	it('withTimeout rejects for slow operations', async () => {
		const slow = new Promise<string>(() => {});
		await expect(withTimeout(slow, 10, 'assertion run')).rejects.toThrow(
			'assertion run timed out after 0.01s',
		);
	});

	it('withTimeout propagates original error', async () => {
		const failing = Promise.reject(new Error('DB connection lost'));
		await expect(withTimeout(failing, 1000, 'test')).rejects.toThrow(
			'DB connection lost',
		);
	});
});

describe('edge cases: mid-run disconnect (F007)', () => {
	it('error during assertion run transitions to error state', () => {
		const { addTab } = useEditorStore.getState();
		const id = addTab('assert', mockAssertContent, '/project/test.assert.dbsp');

		// Start running
		useAssertionStore.getState().setRunning(id, id);
		expect(useAssertionStore.getState().running).toBe(true);

		// Simulate mid-run disconnect / sidecar crash
		useAssertionStore.getState().setError('Engine restarting');

		const state = useAssertionStore.getState();
		expect(state.running).toBe(false);
		expect(state.error).toBe('Engine restarting');
		expect(state.result).toBeNull();
	});

	it('results tab remains on assertions after error', () => {
		useResultsStore.getState().setActiveTab('assertions');
		useAssertionStore.getState().setError('Connection timeout');

		// Tab stays on assertions so user sees the error
		expect(useResultsStore.getState().activeTab).toBe('assertions');
	});

	it('new run after error replaces error state', () => {
		const { addTab } = useEditorStore.getState();
		const id = addTab('assert', mockAssertContent, '/project/test.assert.dbsp');

		// Error state
		useAssertionStore.getState().setRunning(id, id);
		useAssertionStore.getState().setError('Timeout');
		expect(useAssertionStore.getState().error).toBe('Timeout');

		// Re-run clears error
		useAssertionStore.getState().setRunning(id, id);
		expect(useAssertionStore.getState().running).toBe(true);
		expect(useAssertionStore.getState().error).toBeNull();

		// Success
		useAssertionStore.getState().setResult(mockResult);
		expect(useAssertionStore.getState().result).toBe(mockResult);
		expect(useAssertionStore.getState().error).toBeNull();
	});
});
