import { beforeEach, describe, expect, it } from 'vitest';
import { useResultsStore, type QueryResult } from './results-store.js';

const SAMPLE_RESULT: QueryResult = {
	columns: ['id', 'name', 'active'],
	rows: [
		{ id: 1, name: 'Alice', active: true },
		{ id: 2, name: 'Bob', active: false },
	],
	durationMs: 12.5,
};

describe('useResultsStore', () => {
	beforeEach(() => {
		useResultsStore.setState({
			result: null,
			activeTab: 'results',
			executing: false,
			error: null,
		});
	});

	describe('setResult', () => {
		it('stores result and clears error/executing', () => {
			useResultsStore.getState().setExecuting(true);
			useResultsStore.getState().setError('old error');
			useResultsStore.getState().setResult(SAMPLE_RESULT);

			const state = useResultsStore.getState();
			expect(state.result).toEqual(SAMPLE_RESULT);
			expect(state.executing).toBe(false);
			expect(state.error).toBeNull();
		});
	});

	describe('appendRows', () => {
		it('appends rows to existing result', () => {
			useResultsStore.getState().setResult(SAMPLE_RESULT);
			useResultsStore.getState().appendRows(
				[{ id: 3, name: 'Charlie', active: true }],
				100,
				'cursor-123',
			);

			const state = useResultsStore.getState();
			expect(state.result!.rows).toHaveLength(3);
			expect(state.result!.rows[2]).toEqual({ id: 3, name: 'Charlie', active: true });
			expect(state.result!.totalRows).toBe(100);
			expect(state.result!.cursorId).toBe('cursor-123');
			expect(state.result!.truncated).toBe(true);
		});

		it('does nothing when no result exists', () => {
			useResultsStore.getState().appendRows([{ id: 1 }]);
			expect(useResultsStore.getState().result).toBeNull();
		});

		it('clears truncated when no cursorId', () => {
			useResultsStore.getState().setResult({
				...SAMPLE_RESULT,
				truncated: true,
				cursorId: 'old',
			});
			useResultsStore.getState().appendRows(
				[{ id: 3, name: 'Charlie', active: true }],
				3,
				undefined,
			);
			expect(useResultsStore.getState().result!.truncated).toBe(false);
		});
	});

	describe('setActiveTab', () => {
		it('switches active tab', () => {
			useResultsStore.getState().setActiveTab('sql');
			expect(useResultsStore.getState().activeTab).toBe('sql');
		});
	});

	describe('setExecuting', () => {
		it('sets executing and clears error', () => {
			useResultsStore.getState().setError('some error');
			useResultsStore.getState().setExecuting(true);

			const state = useResultsStore.getState();
			expect(state.executing).toBe(true);
			expect(state.error).toBeNull();
		});
	});

	describe('setError', () => {
		it('sets error and clears executing', () => {
			useResultsStore.getState().setExecuting(true);
			useResultsStore.getState().setError('Query failed');

			const state = useResultsStore.getState();
			expect(state.error).toBe('Query failed');
			expect(state.executing).toBe(false);
		});

		it('clears error when set to null', () => {
			useResultsStore.getState().setError('error');
			useResultsStore.getState().setError(null);
			expect(useResultsStore.getState().error).toBeNull();
		});
	});

	describe('clear', () => {
		it('resets all state', () => {
			useResultsStore.getState().setResult(SAMPLE_RESULT);
			useResultsStore.getState().setActiveTab('sql');
			useResultsStore.getState().clear();

			const state = useResultsStore.getState();
			expect(state.result).toBeNull();
			expect(state.activeTab).toBe('results');
			expect(state.executing).toBe(false);
			expect(state.error).toBeNull();
		});
	});
});
