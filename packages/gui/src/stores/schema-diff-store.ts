/**
 * Zustand store for schema diff results management.
 * Tracks diff results, loading state, errors, and apply state.
 */
import { create } from 'zustand';
import type { SchemaDiffResult } from '@/lib/ipc';

// ── Store ───────────────────────────────────────────────────────────

export interface SchemaDiffState {
	/** Latest diff result (null = never run) */
	diff: SchemaDiffResult | null;
	/** Whether diff is currently running */
	loading: boolean;
	/** Error message from last run */
	error: string | null;
	/** Whether apply is currently running */
	applying: boolean;
	/** Error message from last apply */
	applyError: string | null;
	/** Count of applied statements (last apply) */
	appliedCount: number | null;

	// ── Actions ──
	setLoading: () => void;
	setDiff: (diff: SchemaDiffResult) => void;
	setError: (error: string) => void;
	clear: () => void;
	setApplying: () => void;
	setApplyDone: (count: number) => void;
	setApplyError: (error: string) => void;
}

export const useSchemaDiffStore = create<SchemaDiffState>((set) => ({
	diff: null,
	loading: false,
	error: null,
	applying: false,
	applyError: null,
	appliedCount: null,

	setLoading: () => set({ loading: true, error: null }),
	setDiff: (diff) => set({ diff, loading: false, error: null }),
	setError: (error) => set({ error, loading: false, diff: null }),
	clear: () =>
		set({
			diff: null,
			loading: false,
			error: null,
			applying: false,
			applyError: null,
			appliedCount: null,
		}),
	setApplying: () =>
		set({ applying: true, applyError: null, appliedCount: null }),
	setApplyDone: (count) => set({ applying: false, appliedCount: count }),
	setApplyError: (error) => set({ applying: false, applyError: error }),
}));
