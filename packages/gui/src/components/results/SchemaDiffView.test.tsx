// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SchemaDiffChange, SchemaDiffResult } from '@/lib/ipc';

// ── Store mock ──────────────────────────────────────────────────

const mockState = {
	diff: null as SchemaDiffResult | null,
	loading: false,
	error: null as string | null,
	applying: false,
	applyError: null as string | null,
	appliedCount: null as number | null,
	setLoading: vi.fn(),
	setDiff: vi.fn(),
	setError: vi.fn(),
	clear: vi.fn(),
	setApplying: vi.fn(),
	setApplyDone: vi.fn(),
	setApplyError: vi.fn(),
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

vi.mock('./SqlPreviewPanel', () => ({
	SqlPreviewPanel: ({
		upSQL,
		downSQL,
	}: {
		upSQL: readonly string[];
		downSQL: readonly string[];
	}) => (
		<div data-testid="sql-preview-panel">
			UP: {upSQL.length}, DOWN: {downSQL.length}
		</div>
	),
}));

vi.mock('./ApplyConfirmDialog', () => ({
	ApplyConfirmDialog: ({
		open,
		onConfirm,
		onCancel,
		hasDestructive,
		applying,
	}: {
		open: boolean;
		onConfirm: () => void;
		onCancel: () => void;
		statements: readonly string[];
		hasDestructive: boolean;
		applying: boolean;
	}) =>
		open ? (
			<div data-testid="apply-confirm-dialog">
				<span data-testid="dialog-destructive">{String(hasDestructive)}</span>
				<span data-testid="dialog-applying">{String(applying)}</span>
				<button type="button" data-testid="dialog-confirm" onClick={onConfirm}>
					Confirm
				</button>
				<button type="button" data-testid="dialog-cancel" onClick={onCancel}>
					Cancel
				</button>
			</div>
		) : null,
}));

vi.mock('./SideBySideChange', () => ({
	SideBySideChange: ({ change }: { change: SchemaDiffChange }) => {
		const meta = change.meta as Record<string, unknown> | undefined;
		return (
			<div data-testid="side-by-side-change" data-change-kind={change.kind}>
				{meta?.fromType != null && (
					<span data-testid="sbs-old-type">{String(meta.fromType)}</span>
				)}
				{meta?.toType != null && (
					<span data-testid="sbs-new-type">{String(meta.toType)}</span>
				)}
				{meta?.oldNullable != null && (
					<span data-testid="sbs-old-nullable">
						{meta.oldNullable ? 'NULLABLE' : 'NOT NULL'}
					</span>
				)}
				{meta?.nullable != null && (
					<span data-testid="sbs-new-nullable">
						{meta.nullable ? 'NULLABLE' : 'NOT NULL'}
					</span>
				)}
			</div>
		);
	},
}));

vi.mock('@/lib/ipc', () => ({
	sidecarApi: {
		schemaApply: vi.fn(),
	},
}));

import { SchemaDiffView } from './SchemaDiffView';

afterEach(() => {
	cleanup();
	mockState.diff = null;
	mockState.loading = false;
	mockState.error = null;
	mockState.applying = false;
	mockState.applyError = null;
	mockState.appliedCount = null;
	vi.clearAllMocks();
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
			meta: { fromType: 'int', toType: 'bigint' },
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
	upSQL: [
		'CREATE TABLE "orders" ("id" serial PRIMARY KEY);',
		'ALTER TABLE "users" ADD COLUMN "email" text;',
	],
	downSQL: ['DROP TABLE "orders";', 'ALTER TABLE "users" DROP COLUMN "email";'],
	warnings: [],
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

	it('keeps canonicalization fallback visible with affected-surface details', () => {
		mockState.diff = {
			...mockDiff,
			warnings: [
				{
					kind: 'column_default',
					table: 'jobs',
					name: 'state',
					outcome: 'unavailable',
					comparison: 'raw',
					message: 'Could not canonicalize this column default.',
				},
			],
		};
		render(<SchemaDiffView />);

		expect(screen.getByTestId('comparison-degraded-notice')).toBeDefined();
		expect(screen.getByText('Comparison degraded')).toBeDefined();
		expect(screen.getByText(/column default jobs\.state/)).toBeDefined();
		expect(
			screen.getByText(/Could not canonicalize this column default/),
		).toBeDefined();
		fireEvent.click(screen.getByTestId('apply-btn'));
		expect(screen.getByTestId('apply-confirm-dialog')).toBeDefined();
	});

	it('labels a degraded partial-index predicate as an index surface', () => {
		mockState.diff = {
			...mockDiff,
			warnings: [
				{
					kind: 'index_predicate',
					table: 'jobs',
					name: 'idx_jobs_pending',
					outcome: 'unavailable',
					comparison: 'raw',
					message: 'Could not canonicalize this partial-index predicate.',
				},
			],
		};
		render(<SchemaDiffView />);

		expect(
			screen.getByText(/partial-index predicate jobs\.idx_jobs_pending/),
		).toBeDefined();
		expect(
			screen.queryByText(/CHECK constraint jobs\.idx_jobs_pending/),
		).toBeNull();
	});

	it('shows an unpaired default without inferring its cause', () => {
		mockState.diff = {
			...mockDiff,
			warnings: [
				{
					kind: 'column_default',
					table: 'jobs',
					name: 'state',
					outcome: 'unavailable',
					comparison: 'unpaired',
					side: 'desired',
					message:
						'Column default jobs.state had no database default counterpart to compare against.',
				},
			],
		};
		render(<SchemaDiffView />);

		expect(screen.getByTestId('comparison-pairing-notice')).toBeDefined();
		expect(screen.queryByTestId('comparison-degraded-notice')).toBeNull();
		expect(
			screen.getByText(
				'1 column default had no counterpart to compare against.',
			),
		).toBeDefined();
	});

	// ── SC-24: Grouping by table ────────────────────────────────

	it('renders change groups by table name', () => {
		mockState.diff = mockDiff;
		render(<SchemaDiffView />);
		// Groups are now by table: orders, legacy, users
		expect(screen.getByTestId('diff-group-orders')).toBeDefined();
		expect(screen.getByTestId('diff-group-legacy')).toBeDefined();
		expect(screen.getByTestId('diff-group-users')).toBeDefined();
	});

	it('shows group change counts per table in headers', () => {
		mockState.diff = mockDiff;
		render(<SchemaDiffView />);
		// orders has: create_table + create_index + add_foreign_key = 3
		const ordersBtn = screen.getByTestId('diff-group-orders');
		expect(ordersBtn.textContent).toContain('(3)');
		// users has: add_column + alter_column_type = 2
		const usersBtn = screen.getByTestId('diff-group-users');
		expect(usersBtn.textContent).toContain('(2)');
		// legacy has: drop_table = 1
		const legacyBtn = screen.getByTestId('diff-group-legacy');
		expect(legacyBtn.textContent).toContain('(1)');
	});

	it('shows entity names in changes', () => {
		mockState.diff = mockDiff;
		render(<SchemaDiffView />);
		// "orders" appears in group header + as entity name in change rows
		expect(screen.getAllByText('orders').length).toBeGreaterThanOrEqual(2);
		// "legacy" appears in group header + as entity name
		expect(screen.getAllByText('legacy').length).toBeGreaterThanOrEqual(2);
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

		// Orders group is expanded by default
		expect(screen.getByText('New table "orders"')).toBeDefined();

		// Click to collapse
		fireEvent.click(screen.getByTestId('diff-group-orders'));
		expect(screen.queryByText('New table "orders"')).toBeNull();

		// Click to expand again
		fireEvent.click(screen.getByTestId('diff-group-orders'));
		expect(screen.getByText('New table "orders"')).toBeDefined();
	});

	// ── Block 5: Toolbar, SQL Preview, Apply ────────────────────

	it('shows toolbar with SQL toggle and Apply button when changes exist', () => {
		mockState.diff = mockDiff;
		render(<SchemaDiffView />);
		expect(screen.getByTestId('diff-toolbar')).toBeDefined();
		expect(screen.getByTestId('toggle-sql-preview')).toBeDefined();
		expect(screen.getByTestId('apply-btn')).toBeDefined();
	});

	it('does not show toolbar when no changes', () => {
		mockState.diff = {
			...mockDiff,
			changes: [],
		};
		render(<SchemaDiffView />);
		expect(screen.queryByTestId('diff-toolbar')).toBeNull();
	});

	it('toggles SQL preview panel on button click', () => {
		mockState.diff = mockDiff;
		render(<SchemaDiffView />);

		// SQL preview not visible initially
		expect(screen.queryByTestId('sql-preview-panel')).toBeNull();

		// Click to show
		fireEvent.click(screen.getByTestId('toggle-sql-preview'));
		expect(screen.getByTestId('sql-preview-panel')).toBeDefined();

		// Click to hide
		fireEvent.click(screen.getByTestId('toggle-sql-preview'));
		expect(screen.queryByTestId('sql-preview-panel')).toBeNull();
	});

	it('opens apply confirmation dialog on Apply click', () => {
		mockState.diff = mockDiff;
		render(<SchemaDiffView />);

		// Dialog not visible initially
		expect(screen.queryByTestId('apply-confirm-dialog')).toBeNull();

		// Click Apply
		fireEvent.click(screen.getByTestId('apply-btn'));
		expect(screen.getByTestId('apply-confirm-dialog')).toBeDefined();
	});

	it('passes hasDestructive to confirmation dialog', () => {
		mockState.diff = mockDiff;
		render(<SchemaDiffView />);

		fireEvent.click(screen.getByTestId('apply-btn'));
		expect(screen.getByTestId('dialog-destructive').textContent).toBe('true');
	});

	it('closes confirmation dialog on cancel', () => {
		mockState.diff = mockDiff;
		render(<SchemaDiffView />);

		fireEvent.click(screen.getByTestId('apply-btn'));
		expect(screen.getByTestId('apply-confirm-dialog')).toBeDefined();

		fireEvent.click(screen.getByTestId('dialog-cancel'));
		expect(screen.queryByTestId('apply-confirm-dialog')).toBeNull();
	});

	it('shows apply error when applyError is set', () => {
		mockState.diff = mockDiff;
		mockState.applyError = 'column "email" already exists';
		render(<SchemaDiffView />);
		expect(screen.getByTestId('apply-error')).toBeDefined();
		expect(screen.getByTestId('apply-error').textContent).toContain(
			'column "email" already exists',
		);
	});

	it('disables Apply button when applying is true', () => {
		mockState.diff = mockDiff;
		mockState.applying = true;
		render(<SchemaDiffView />);
		const applyBtn = screen.getByTestId('apply-btn');
		expect(applyBtn.getAttribute('disabled')).not.toBeNull();
		expect(applyBtn.textContent).toContain('Applying...');
	});

	// ── Block 6: Side-by-side toggle ────────────────────────────

	it('shows side-by-side toggle button in toolbar', () => {
		mockState.diff = mockDiff;
		render(<SchemaDiffView />);
		expect(screen.getByTestId('toggle-side-by-side')).toBeDefined();
		expect(screen.getByTestId('toggle-side-by-side').textContent).toContain(
			'Diff',
		);
	});

	it('does not show SideBySideChange by default', () => {
		mockState.diff = mockDiff;
		render(<SchemaDiffView />);
		expect(screen.queryByTestId('side-by-side-change')).toBeNull();
	});

	it('shows SideBySideChange for alter_* changes when toggled on', () => {
		mockState.diff = mockDiff;
		render(<SchemaDiffView />);

		// Toggle side-by-side on
		fireEvent.click(screen.getByTestId('toggle-side-by-side'));

		// alter_column_type in users group should now render SideBySideChange
		const sbsElements = screen.getAllByTestId('side-by-side-change');
		expect(sbsElements).toHaveLength(1);
		expect(sbsElements[0]?.getAttribute('data-change-kind')).toBe(
			'alter_column_type',
		);
	});

	it('hides SideBySideChange when toggled off again', () => {
		mockState.diff = mockDiff;
		render(<SchemaDiffView />);

		// Toggle on
		fireEvent.click(screen.getByTestId('toggle-side-by-side'));
		expect(screen.getAllByTestId('side-by-side-change').length).toBe(1);

		// Toggle off
		fireEvent.click(screen.getByTestId('toggle-side-by-side'));
		expect(screen.queryByTestId('side-by-side-change')).toBeNull();
	});

	it('does not render SideBySideChange for non-alter changes', () => {
		mockState.diff = {
			...mockDiff,
			changes: [
				{
					kind: 'add_column',
					table: 'users',
					column: 'email',
					destructive: false,
					details: 'Add column',
				},
				{
					kind: 'drop_table',
					table: 'legacy',
					destructive: true,
					details: 'Drop table',
				},
			],
		};
		render(<SchemaDiffView />);

		// Toggle side-by-side on
		fireEvent.click(screen.getByTestId('toggle-side-by-side'));

		// No alter_* changes => no SideBySideChange
		expect(screen.queryByTestId('side-by-side-change')).toBeNull();
	});

	// ── SC-23: Side-by-side for column type changes ─────────────

	it('SC-23: shows old/new types in SideBySideChange for alter_column_type', () => {
		mockState.diff = {
			...mockDiff,
			changes: [
				{
					kind: 'alter_column_type',
					table: 'users',
					column: 'age',
					destructive: false,
					details: 'Change type from int to bigint',
					meta: { fromType: 'int', toType: 'bigint' },
				},
			],
		};
		render(<SchemaDiffView />);

		// Toggle side-by-side on
		fireEvent.click(screen.getByTestId('toggle-side-by-side'));

		expect(screen.getByTestId('sbs-old-type').textContent).toBe('int');
		expect(screen.getByTestId('sbs-new-type').textContent).toBe('bigint');
	});

	it('SC-23: shows old/new nullable in SideBySideChange for alter_column_nullable', () => {
		mockState.diff = {
			...mockDiff,
			changes: [
				{
					kind: 'alter_column_nullable',
					table: 'users',
					column: 'name',
					destructive: false,
					details: 'Change nullable from true to false',
					meta: { oldNullable: true, nullable: false },
				},
			],
		};
		render(<SchemaDiffView />);

		// Toggle side-by-side on
		fireEvent.click(screen.getByTestId('toggle-side-by-side'));

		expect(screen.getByTestId('sbs-old-nullable').textContent).toBe('NULLABLE');
		expect(screen.getByTestId('sbs-new-nullable').textContent).toBe('NOT NULL');
	});

	// ── SC-24: Visual polish (colors, table grouping) ───────────

	it('SC-24: destructive changes styled with red', () => {
		mockState.diff = mockDiff;
		render(<SchemaDiffView />);
		// drop_table is in the legacy group
		const destructiveLabel = screen.getByText('destructive');
		expect(destructiveLabel.className).toContain('text-red-600');
	});

	it('SC-24: additive change names styled with green', () => {
		mockState.diff = {
			...mockDiff,
			changes: [
				{
					kind: 'create_table',
					table: 'orders',
					destructive: false,
					details: 'New table',
				},
			],
		};
		render(<SchemaDiffView />);

		// "orders" appears in both group header and entity name — find the one with font-mono (entity)
		const allOrders = screen.getAllByText('orders');
		const entityName = allOrders.find((el) =>
			el.className.includes('font-mono'),
		);
		expect(entityName).toBeDefined();
		expect(entityName!.className).toContain('text-green-600');
	});

	it('SC-24: alteration change names styled with yellow', () => {
		mockState.diff = {
			...mockDiff,
			changes: [
				{
					kind: 'alter_column_type',
					table: 'users',
					column: 'age',
					destructive: false,
					details: 'Change type',
					meta: { fromType: 'int', toType: 'bigint' },
				},
			],
		};
		render(<SchemaDiffView />);

		// The entity name "users.age" should have yellow styling
		const entityName = screen.getByText('users.age');
		expect(entityName.className).toContain('text-yellow-600');
	});

	it('SC-24: drop change names styled with red', () => {
		mockState.diff = {
			...mockDiff,
			changes: [
				{
					kind: 'drop_table',
					table: 'legacy',
					destructive: true,
					details: 'Drop table',
				},
			],
		};
		render(<SchemaDiffView />);

		// "legacy" appears in both group header and entity name — find the one with font-mono (entity)
		const allLegacy = screen.getAllByText('legacy');
		const entityName = allLegacy.find((el) =>
			el.className.includes('font-mono'),
		);
		expect(entityName).toBeDefined();
		expect(entityName!.className).toContain('text-red-600');
	});

	it('SC-24: mixed changes grouped by table, not by type', () => {
		mockState.diff = {
			...mockDiff,
			changes: [
				{
					kind: 'add_column',
					table: 'products',
					column: 'price',
					destructive: false,
					details: 'Add column price',
				},
				{
					kind: 'alter_column_type',
					table: 'products',
					column: 'name',
					destructive: false,
					details: 'Change name type',
					meta: { fromType: 'varchar(50)', toType: 'varchar(255)' },
				},
				{
					kind: 'drop_column',
					table: 'products',
					column: 'sku',
					destructive: true,
					details: 'Drop column sku',
				},
			],
		};
		render(<SchemaDiffView />);

		// All three changes should be in a single "products" group
		const productsGroup = screen.getByTestId('diff-group-products');
		expect(productsGroup).toBeDefined();
		expect(productsGroup.textContent).toContain('(3)');

		// No "Columns" or "Tables" groups (old by-type grouping)
		expect(screen.queryByTestId('diff-group-columns')).toBeNull();
		expect(screen.queryByTestId('diff-group-tables')).toBeNull();
	});

	it('SC-23+SC-24: multiple alter_* changes each get side-by-side', () => {
		mockState.diff = {
			...mockDiff,
			changes: [
				{
					kind: 'alter_column_type',
					table: 'users',
					column: 'age',
					destructive: false,
					details: 'Change type',
					meta: { fromType: 'int', toType: 'bigint' },
				},
				{
					kind: 'alter_column_nullable',
					table: 'users',
					column: 'name',
					destructive: false,
					details: 'Change nullable',
					meta: { oldNullable: true, nullable: false },
				},
			],
		};
		render(<SchemaDiffView />);

		// Toggle on
		fireEvent.click(screen.getByTestId('toggle-side-by-side'));

		// Both alter_* changes should render SideBySideChange
		const sbsElements = screen.getAllByTestId('side-by-side-change');
		expect(sbsElements.length).toBe(2);
	});
});
