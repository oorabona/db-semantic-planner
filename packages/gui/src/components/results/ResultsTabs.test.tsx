// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// ── Store mocks ──────────────────────────────────────────────────

const mockResultsState = {
	activeTab: 'sql' as string,
	result: null as { sql?: string; plan?: unknown; params?: unknown[] } | null,
	setActiveTab: vi.fn(),
};

vi.mock('@/stores/results-store', () => ({
	useResultsStore: (selector: (s: typeof mockResultsState) => unknown) =>
		selector(mockResultsState),
}));

const mockConnectionState = {
	profiles: [] as Array<{ id: string }>,
};

vi.mock('@/stores/connection-store', () => ({
	useConnectionStore: (selector: (s: typeof mockConnectionState) => unknown) =>
		selector(mockConnectionState),
}));

vi.mock('@/stores/assertion-store', () => ({
	useAssertionStore: (selector: (s: { result: null }) => unknown) =>
		selector({ result: null }),
}));

vi.mock('@/stores/schema-diff-store', () => ({
	useSchemaDiffStore: (selector: (s: { diff: null }) => unknown) =>
		selector({ diff: null }),
}));

import { ResultsTabs } from './ResultsTabs';

afterEach(() => {
	cleanup();
	mockResultsState.activeTab = 'sql';
	mockResultsState.result = null;
	mockConnectionState.profiles = [];
	mockResultsState.setActiveTab.mockClear();
});

// ── F007: Plan-only mode (Results tab disabled) ────────────────

describe('ResultsTabs — F007 plan-only mode', () => {
	it('disables Results tab when no profiles and no result', () => {
		mockConnectionState.profiles = [];
		mockResultsState.result = null;

		render(<ResultsTabs />);
		const resultsBtn = screen.getByText('Results').closest('button')!;
		expect(resultsBtn.disabled).toBe(true);
		expect(resultsBtn.title).toBe('No connection — plan-only mode');
	});

	it('enables Results tab when profiles exist', () => {
		mockConnectionState.profiles = [{ id: 'p1' }];
		mockResultsState.result = null;

		render(<ResultsTabs />);
		const resultsBtn = screen.getByText('Results').closest('button')!;
		expect(resultsBtn.disabled).toBe(false);
	});

	it('enables Results tab when result exists even without profiles', () => {
		mockConnectionState.profiles = [];
		mockResultsState.result = { sql: 'SELECT 1' };

		render(<ResultsTabs />);
		const resultsBtn = screen.getByText('Results').closest('button')!;
		expect(resultsBtn.disabled).toBe(false);
	});

	it('does not show plan-only tooltip when profiles exist', () => {
		mockConnectionState.profiles = [{ id: 'p1' }];

		render(<ResultsTabs />);
		const resultsBtn = screen.getByText('Results').closest('button')!;
		expect(resultsBtn.title).toBe('');
	});
});
