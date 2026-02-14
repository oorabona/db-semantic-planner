/**
 * Zustand store for assertion results management.
 * Tracks assertion run results, loading state, and errors.
 */
import { create } from 'zustand';
import type { RunAssertionsResult, RunAssertionsSummary } from '@/lib/ipc';

// ── Store ───────────────────────────────────────────────────────────

export interface AssertionState {
	/** Latest assertion run result (null = never run) */
	result: RunAssertionsResult | null;
	/** Whether assertions are currently running */
	running: boolean;
	/** Error message from last run attempt */
	error: string | null;
	/** Tab ID of the .assert.dbsp file that was last run */
	assertTabId: string | null;
	/** Tab ID of the paired .dbsp file */
	dbspTabId: string | null;

	// ── Actions ──
	setRunning: (assertTabId: string, dbspTabId: string) => void;
	setResult: (result: RunAssertionsResult) => void;
	setError: (error: string) => void;
	clear: () => void;
}

export const useAssertionStore = create<AssertionState>((set) => ({
	result: null,
	running: false,
	error: null,
	assertTabId: null,
	dbspTabId: null,

	setRunning: (assertTabId, dbspTabId) =>
		set({ running: true, error: null, assertTabId, dbspTabId }),

	setResult: (result) => set({ result, running: false, error: null }),

	setError: (error) => set({ error, running: false, result: null }),

	clear: () =>
		set({
			result: null,
			running: false,
			error: null,
			assertTabId: null,
			dbspTabId: null,
		}),
}));

// ── Derived helpers ─────────────────────────────────────────────────

export function getSummary(state: AssertionState): RunAssertionsSummary | null {
	return state.result?.summary ?? null;
}

export function hasParseErrors(state: AssertionState): boolean {
	return (state.result?.parseErrors.length ?? 0) > 0;
}

export function isAllPassed(state: AssertionState): boolean {
	const summary = state.result?.summary;
	if (!summary) return false;
	return summary.failed === 0 && summary.total > 0;
}
