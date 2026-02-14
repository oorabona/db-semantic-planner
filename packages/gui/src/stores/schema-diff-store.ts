/**
 * Zustand store for schema diff results management.
 * Tracks diff results, loading state, and errors.
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

	// ── Actions ──
	setLoading: () => void;
	setDiff: (diff: SchemaDiffResult) => void;
	setError: (error: string) => void;
	clear: () => void;
}

export const useSchemaDiffStore = create<SchemaDiffState>((set) => ({
	diff: null,
	loading: false,
	error: null,

	setLoading: () => set({ loading: true, error: null }),
	setDiff: (diff) => set({ diff, loading: false, error: null }),
	setError: (error) => set({ error, loading: false, diff: null }),
	clear: () => set({ diff: null, loading: false, error: null }),
}));
