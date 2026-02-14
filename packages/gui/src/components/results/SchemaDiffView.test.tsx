// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SchemaDiffResult } from '@/lib/ipc';

// ── Store mock ──────────────────────────────────────────────────

const mockState = {
	diff: null as SchemaDiffResult | null,
	loading: false,
	error: null as string | null,
};

vi.mock('@/stores/schema-diff-store', () => ({
	useSchemaDiffStore: (selector: (s: typeof mockState) => unknown) =>
		selector(mockState),
}));

vi.mock('./SchemaDiffSummary', () => ({
	SchemaDiffSummary: ({ totalChanges }: { totalChanges: number }) => (
		<div data-testid="schema-diff-summary-bar">{totalChanges} changes</div>
	),
}));

import { SchemaDiffView } from './SchemaDiffView';

afterEach(() => {
	cleanup();
	mockState.diff = null;
	mockState.loading = false;
	mockState.error = null;
});

// ── Fixtures ────────────────────────────────────────────────────

const mockDiff: SchemaDiffResult = {
	changes: [
		{
			kind: 'create_table',
			table: 'orders',
			destructive: false,
			details: 'New table "orders"',
		},
		{
			kind: 'drop_table',
			table: 'legacy',
			destructive: true,
			details: 'Drop table "legacy"',
		},
		{
			kind: 'add_column',
			table: 'users',
			column: 'email',
			destructive: false,
			details: 'Add column "email" varchar(255)',
		},
		{
			kind: 'alter_column_type',
			table: 'users',
			column: 'age',
			destructive: false,
			details: 'Change type from int to bigint',
		},
		{
			kind: 'create_index',
			table: 'orders',
			destructive: false,
			details: 'Create index on "orders"("created_at")',
		},
		{
			kind: 'add_foreign_key',
			table: 'orders',
			destructive: false,
			details: 'Add FK orders.user_id -> users.id',
		},
	],
	hasDestructive: true,
	summary: {
		tables: { added: 1, dropped: 1 },
		columns: { added: 1, dropped: 0, altered: 1 },
		indexes: { added: 1, dropped: 0 },
		constraints: { added: 1, dropped: 0, altered: 0 },
	},
};

// ── Tests ───────────────────────────────────────────────────────

describe('SchemaDiffView', () => {
	it('shows loading state', () => {
		mockState.loading = true;
		render(<SchemaDiffView />);
		expect(screen.getByText('Computing schema diff...')).toBeDefined();
	});

	it('shows error state', () => {
		mockState.error = 'Connection failed';
		render(<SchemaDiffView />);
		expect(screen.getByText('Connection failed')).toBeDefined();
	});

	it('shows empty state when no diff', () => {
		render(<SchemaDiffView />);
		expect(screen.getByTestId('schema-diff-empty')).toBeDefined();
		expect(
			screen.getByText(
				'No schema diff available. Use Compare Schema with Database.',
			),
		).toBeDefined();
	});

	it('renders summary bar when diff exists', () => {
		mockState.diff = mockDiff;
		render(<SchemaDiffView />);
		expect(screen.getByTestId('schema-diff-summary-bar')).toBeDefined();
	});

	it('renders change groups', () => {
		mockState.diff = mockDiff;
		render(<SchemaDiffView />);
		expect(screen.getByTestId('diff-group-tables')).toBeDefined();
		expect(screen.getByTestId('diff-group-columns')).toBeDefined();
		expect(screen.getByTestId('diff-group-indexes')).toBeDefined();
		expect(screen.getByTestId('diff-group-constraints')).toBeDefined();
	});

	it('shows group change counts in headers', () => {
		mockState.diff = mockDiff;
		render(<SchemaDiffView />);
		// Tables group header: "Tables (2)"
		const tablesBtn = screen.getByTestId('diff-group-tables');
		expect(tablesBtn.textContent).toContain('(2)');
		const indexesBtn = screen.getByTestId('diff-group-indexes');
		expect(indexesBtn.textContent).toContain('(1)');
	});

	it('shows entity names in changes', () => {
		mockState.diff = mockDiff;
		render(<SchemaDiffView />);
		// "orders" appears in both Tables and Constraints groups
		expect(screen.getAllByText('orders').length).toBeGreaterThanOrEqual(1);
		expect(screen.getByText('legacy')).toBeDefined();
		expect(screen.getByText('users.email')).toBeDefined();
		expect(screen.getByText('users.age')).toBeDefined();
	});

	it('shows change details', () => {
		mockState.diff = mockDiff;
		render(<SchemaDiffView />);
		expect(screen.getByText('New table "orders"')).toBeDefined();
		expect(screen.getByText('Add column "email" varchar(255)')).toBeDefined();
	});

	it('shows destructive label on destructive changes', () => {
		mockState.diff = mockDiff;
		render(<SchemaDiffView />);
		expect(screen.getByText('destructive')).toBeDefined();
	});

	it('toggles group collapse on click', () => {
		mockState.diff = mockDiff;
		render(<SchemaDiffView />);

		// Tables group is expanded by default
		expect(screen.getByText('New table "orders"')).toBeDefined();

		// Click to collapse
		fireEvent.click(screen.getByTestId('diff-group-tables'));
		expect(screen.queryByText('New table "orders"')).toBeNull();

		// Click to expand again
		fireEvent.click(screen.getByTestId('diff-group-tables'));
		expect(screen.getByText('New table "orders"')).toBeDefined();
	});
});
