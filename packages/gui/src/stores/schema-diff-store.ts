/**
 * Zustand store for schema diff results management.
 * Tracks diff results, loading state, errors, and apply state.
 */
import { create } from 'zustand';
import type { SchemaDiffResult } from '@/lib/ipc';

// ── Store ───────────────────────────────────────────────────────────

export interface StoredSchemaDiff {
	/** Connection the comparison was run against. */
	readonly connectionId: string;
	/** Result returned for that connection. */
	readonly result: SchemaDiffResult;
}

export interface SchemaDiffState {
	/** Latest diff result (null = never run) */
	diff: StoredSchemaDiff | null;
	/** Whether diff is currently running */
	loading: boolean;
	/** Error message from last run */
	error: string | null;
	/** Identity of the most recently started comparison. */
	requestId: number;
	/** Whether apply is currently running */
	applying: boolean;
	/** Error message from last apply */
	applyError: string | null;
	/** Count of applied statements (last apply) */
	appliedCount: number | null;

	// ── Actions ──
	/** Starts a comparison and returns its identity. */
	startComparison: () => number;
	/** Completes the current comparison; ignores an older request. */
	setDiff: (
		requestId: number,
		connectionId: string,
		diff: SchemaDiffResult,
	) => void;
	/** Fails the current comparison; ignores an older request. */
	setError: (requestId: number, error: string) => void;
	clear: () => void;
	setApplying: () => void;
	setApplyDone: (count: number) => void;
	setApplyError: (error: string) => void;
}

export const useSchemaDiffStore = create<SchemaDiffState>((set) => ({
	diff: null,
	loading: false,
	error: null,
	requestId: 0,
	applying: false,
	applyError: null,
	appliedCount: null,

	startComparison: () => {
		let requestId = 0;
		set((state) => {
			requestId = state.requestId + 1;
			return { requestId, loading: true, error: null };
		});
		return requestId;
	},
	setDiff: (requestId, connectionId, result) =>
		set((state) =>
			state.requestId === requestId
				? {
						diff: { connectionId, result },
						loading: false,
						error: null,
					}
				: state,
		),
	setError: (requestId, error) =>
		set((state) =>
			state.requestId === requestId
				? { error, loading: false, diff: null }
				: state,
		),
	clear: () =>
		set((state) => ({
			diff: null,
			loading: false,
			error: null,
			requestId: state.requestId + 1,
			applying: false,
			applyError: null,
			appliedCount: null,
		})),
	setApplying: () =>
		set({ applying: true, applyError: null, appliedCount: null }),
	setApplyDone: (count) => set({ applying: false, appliedCount: count }),
	setApplyError: (error) => set({ applying: false, applyError: error }),
}));
