/**
 * Zustand store for query results management.
 * Tracks results, compiled SQL, plan, params, and active results tab.
 */

import { create } from 'zustand';
import { sidecarApi } from '@/lib/ipc';

export type ResultsTab =
	| 'results'
	| 'sql'
	| 'plan'
	| 'params'
	| 'assertions'
	| 'schema-diff'
	| 'history'
	| 'logs';

export interface QueryResult {
	/** Column names from the result set */
	readonly columns: string[];
	/** Row data as array of record objects */
	readonly rows: ReadonlyArray<Record<string, unknown>>;
	/** Execution time in milliseconds */
	readonly durationMs: number;
	/** Total row count if truncated (from server) */
	readonly totalRows?: number | undefined;
	/** Whether the result was truncated by maxRows */
	readonly truncated?: boolean | undefined;
	/** Cursor ID for fetching more rows */
	readonly cursorId?: string | undefined;
	/** Compiled SQL (from NQL execution) */
	readonly sql?: string | undefined;
	/** Query parameters */
	readonly params?: ReadonlyArray<unknown> | undefined;
	/** Plan report (from NQL execution) */
	readonly plan?: unknown | undefined;
}

export interface ResultsState {
	/** Current query result (null = no result yet) */
	result: QueryResult | null;
	/** Active tab in results panel */
	activeTab: ResultsTab;
	/** Whether a query is currently executing */
	executing: boolean;
	/** Whether a fetchMore is in progress */
	fetchingMore: boolean;
	/** Error message from last execution */
	error: string | null;

	// Actions
	setResult: (result: QueryResult) => void;
	appendRows: (
		rows: ReadonlyArray<Record<string, unknown>>,
		truncated?: boolean,
		cursorId?: string,
	) => void;
	setActiveTab: (tab: ResultsTab) => void;
	setExecuting: (executing: boolean) => void;
	setFetchingMore: (fetchingMore: boolean) => void;
	setError: (error: string | null) => void;
	clear: () => void;
}

export const useResultsStore = create<ResultsState>((set) => ({
	result: null,
	activeTab: 'results',
	executing: false,
	fetchingMore: false,
	error: null,

	setResult: (result) =>
		set({ result, error: null, executing: false, fetchingMore: false }),

	appendRows: (rows, truncated, cursorId) =>
		set((state) => {
			if (!state.result) return state;
			return {
				result: {
					...state.result,
					rows: [...state.result.rows, ...rows],
					cursorId,
					truncated: truncated ?? false,
				},
				fetchingMore: false,
			};
		}),

	setActiveTab: (activeTab) => set({ activeTab }),
	setExecuting: (executing) => set({ executing, error: null }),
	setFetchingMore: (fetchingMore) => set({ fetchingMore }),
	setError: (error) => set({ error, executing: false, fetchingMore: false }),
	clear: () =>
		set({
			result: null,
			error: null,
			executing: false,
			fetchingMore: false,
			activeTab: 'results',
		}),
}));

/**
 * Shared fetchMore logic — used by both StatusBar (button) and DataTable (infinite scroll).
 * Returns early if no cursor or already fetching.
 */
export async function triggerFetchMore(): Promise<void> {
	const { result, fetchingMore, appendRows, setFetchingMore, setError } =
		useResultsStore.getState();
	if (!result?.cursorId || fetchingMore) return;
	setFetchingMore(true);
	try {
		const raw = (await sidecarApi.fetchMore({
			cursorId: result.cursorId,
		})) as unknown as Record<string, unknown>;
		const rows = (raw.rows ?? []) as Record<string, unknown>[];
		appendRows(
			rows,
			raw.truncated as boolean | undefined,
			raw.cursorId as string | undefined,
		);
	} catch (err) {
		setError(err instanceof Error ? err.message : 'Failed to fetch more rows');
	}
}
