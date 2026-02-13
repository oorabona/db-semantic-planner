/**
 * Zustand store for query results management.
 * Tracks results, compiled SQL, plan, params, and active results tab.
 */
import { create } from 'zustand';

export type ResultsTab = 'results' | 'sql' | 'plan' | 'params';

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
	/** Error message from last execution */
	error: string | null;

	// Actions
	setResult: (result: QueryResult) => void;
	appendRows: (rows: ReadonlyArray<Record<string, unknown>>, totalRows?: number, cursorId?: string) => void;
	setActiveTab: (tab: ResultsTab) => void;
	setExecuting: (executing: boolean) => void;
	setError: (error: string | null) => void;
	clear: () => void;
}

export const useResultsStore = create<ResultsState>((set) => ({
	result: null,
	activeTab: 'results',
	executing: false,
	error: null,

	setResult: (result) => set({ result, error: null, executing: false }),

	appendRows: (rows, totalRows, cursorId) =>
		set((state) => {
			if (!state.result) return state;
			return {
				result: {
					...state.result,
					rows: [...state.result.rows, ...rows],
					totalRows: totalRows ?? state.result.totalRows,
					cursorId,
					truncated: cursorId != null,
				},
			};
		}),

	setActiveTab: (activeTab) => set({ activeTab }),
	setExecuting: (executing) => set({ executing, error: null }),
	setError: (error) => set({ error, executing: false }),
	clear: () => set({ result: null, error: null, executing: false, activeTab: 'results' }),
}));
