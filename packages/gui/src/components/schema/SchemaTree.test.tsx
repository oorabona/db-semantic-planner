// @vitest-environment jsdom
/**
 * Tests for SchemaTree — Edit Schema button visibility + click behavior.
 * Covers Block 9 exit criterion: "Edit Schema" button in schema tree header.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────

vi.mock('@/hooks/useSchema', () => ({
	useSchema: vi.fn(),
}));

vi.mock('@/stores/schema-store', () => ({
	useSchemaStore: vi.fn(),
	getFilteredTables: vi.fn(),
}));

vi.mock('@/stores/sidecar-store', () => ({
	useSidecarStore: vi.fn(),
}));

import { useSchema } from '@/hooks/useSchema';
import { getFilteredTables, useSchemaStore } from '@/stores/schema-store';
import { useSidecarStore } from '@/stores/sidecar-store';
import { SchemaTree } from './SchemaTree';

const MOCK_SCHEMA = {
	tables: [{ name: 'users', columns: [], indexes: [], constraints: [] }],
	warnings: [],
};

describe('SchemaTree', () => {
	afterEach(cleanup);

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(useSchema).mockReturnValue({
			schema: MOCK_SCHEMA as any,
			loading: false,
			error: null,
			refresh: vi.fn(),
		});
		// SchemaStore is used by both SchemaTree (searchFilter) and TableNode (expanded, toggleExpanded)
		const mockStoreState = {
			searchFilter: '',
			expanded: new Set<string>(),
			toggleExpanded: vi.fn(),
		};
		vi.mocked(useSchemaStore).mockImplementation((selector: any) =>
			selector(mockStoreState),
		);
		vi.mocked(getFilteredTables).mockReturnValue(MOCK_SCHEMA.tables as any);
		// Sidecar store: return status/error per selector
		vi.mocked(useSidecarStore).mockImplementation((selector: any) =>
			selector({ status: 'ready', error: null }),
		);
	});

	it('renders table count when schema is loaded', () => {
		render(<SchemaTree onConnect={vi.fn()} />);
		expect(screen.getByText('1 table')).toBeDefined();
	});

	it('does not show Edit Schema button when schemaEditable is false', () => {
		render(<SchemaTree onConnect={vi.fn()} schemaEditable={false} />);
		expect(screen.queryByTestId('edit-schema-btn')).toBeNull();
	});

	it('does not show Edit Schema button when schemaEditable is undefined', () => {
		render(<SchemaTree onConnect={vi.fn()} />);
		expect(screen.queryByTestId('edit-schema-btn')).toBeNull();
	});

	it('shows Edit Schema button when schemaEditable is true', () => {
		render(
			<SchemaTree
				onConnect={vi.fn()}
				schemaEditable={true}
				onEditSchema={vi.fn()}
			/>,
		);
		expect(screen.getByTestId('edit-schema-btn')).toBeDefined();
	});

	it('calls onEditSchema when Edit Schema button is clicked', () => {
		const onEditSchema = vi.fn();
		render(
			<SchemaTree
				onConnect={vi.fn()}
				schemaEditable={true}
				onEditSchema={onEditSchema}
			/>,
		);

		fireEvent.click(screen.getByTestId('edit-schema-btn'));
		expect(onEditSchema).toHaveBeenCalledOnce();
	});

	it('shows Connect button when no schema is loaded', () => {
		vi.mocked(useSchema).mockReturnValue({
			schema: null,
			loading: false,
			error: null,
			refresh: vi.fn(),
		});

		render(<SchemaTree onConnect={vi.fn()} />);
		expect(screen.getByText('Connect')).toBeDefined();
	});

	it('shows loading spinner when loading', () => {
		vi.mocked(useSchema).mockReturnValue({
			schema: null,
			loading: true,
			error: null,
			refresh: vi.fn(),
		});

		render(<SchemaTree onConnect={vi.fn()} />);
		expect(screen.getByText('Loading schema...')).toBeDefined();
	});

	it('shows sidecar error when sidecar failed', () => {
		vi.mocked(useSidecarStore).mockImplementation((selector: any) => {
			const state = { status: 'stopped', error: 'Binary not found' };
			return selector(state);
		});

		render(<SchemaTree onConnect={vi.fn()} />);
		expect(screen.getByText('Sidecar failed to start')).toBeDefined();
	});

	it('shows sidecar booting when status is spawning', () => {
		vi.mocked(useSidecarStore).mockImplementation((selector: any) => {
			const state = { status: 'spawning', error: null };
			return selector(state);
		});

		render(<SchemaTree onConnect={vi.fn()} />);
		expect(screen.getByText('Starting sidecar...')).toBeDefined();
	});
});
