// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionFormData } from '@/components/connection/ConnectionDialog';
import { NewProjectWizard } from './NewProjectWizard';

// Mock Tauri dialog (used by WizardNameStep)
vi.mock('@tauri-apps/plugin-dialog', () => ({
	open: vi.fn(),
}));

// Mock ConnectionDialog to avoid deep dependency tree
vi.mock('@/components/connection/ConnectionDialog', () => ({
	ConnectionDialog: ({ open }: { open: boolean }) =>
		open ? <div data-testid="connection-dialog">ConnectionDialog</div> : null,
}));

const defaultProps = {
	open: true,
	onClose: vi.fn(),
	onCreate: vi.fn(),
	onDiscover: vi.fn().mockResolvedValue({ databases: [] }),
	onListSchemas: vi.fn().mockResolvedValue({ schemas: [] }),
	onTestConnection: vi.fn(),
};

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe('NewProjectWizard', () => {
	// ── Visibility ──

	it('renders nothing when open=false', () => {
		render(<NewProjectWizard {...defaultProps} open={false} />);
		expect(screen.queryByTestId('new-project-wizard')).toBeNull();
	});

	it('renders the wizard overlay when open=true', () => {
		render(<NewProjectWizard {...defaultProps} />);
		expect(screen.getByTestId('new-project-wizard')).toBeDefined();
	});

	// ── Step indicators ──

	it('shows all 4 step indicators in sidebar', () => {
		render(<NewProjectWizard {...defaultProps} />);
		expect(screen.getByTestId('step-indicator-0')).toBeDefined();
		expect(screen.getByTestId('step-indicator-1')).toBeDefined();
		expect(screen.getByTestId('step-indicator-2')).toBeDefined();
		expect(screen.getByTestId('step-indicator-3')).toBeDefined();
	});

	// ── Introduction step (step 0) ──

	it('starts at introduction step', () => {
		render(<NewProjectWizard {...defaultProps} />);
		expect(screen.getByText('Welcome to Project Mode')).toBeDefined();
	});

	it('shows Next button on intro step', () => {
		render(<NewProjectWizard {...defaultProps} />);
		expect(screen.getByTestId('wizard-next')).toBeDefined();
	});

	it('does not show Back button on first step', () => {
		render(<NewProjectWizard {...defaultProps} />);
		expect(screen.queryByTestId('wizard-back')).toBeNull();
	});

	// ── Navigation ──

	it('advances to Name step on Next click', () => {
		render(<NewProjectWizard {...defaultProps} />);
		fireEvent.click(screen.getByTestId('wizard-next'));
		expect(
			screen.getByRole('heading', { name: 'Name & Location' }),
		).toBeDefined();
	});

	it('shows Back button from step 1 onwards', () => {
		render(<NewProjectWizard {...defaultProps} />);
		fireEvent.click(screen.getByTestId('wizard-next')); // → step 1
		expect(screen.getByTestId('wizard-back')).toBeDefined();
	});

	it('disables Next on step 1 when name/folder are empty', () => {
		render(<NewProjectWizard {...defaultProps} />);
		fireEvent.click(screen.getByTestId('wizard-next')); // → step 1
		const nextBtn = screen.getByTestId('wizard-next');
		expect(nextBtn.hasAttribute('disabled')).toBe(true);
	});

	it('enables Next on step 1 when name and folder are filled', () => {
		render(<NewProjectWizard {...defaultProps} />);
		fireEvent.click(screen.getByTestId('wizard-next')); // → step 1

		const nameInput = screen.getByPlaceholderText('my-project');
		const folderInput = screen.getByPlaceholderText('/path/to/project');

		fireEvent.change(nameInput, { target: { value: 'test-project' } });
		fireEvent.change(folderInput, { target: { value: '/home/user/proj' } });

		const nextBtn = screen.getByTestId('wizard-next');
		expect(nextBtn.hasAttribute('disabled')).toBe(false);
	});

	// ── Full wizard flow ──

	it('completes full wizard flow to Create Project', () => {
		render(<NewProjectWizard {...defaultProps} />);

		// Step 0 → 1
		fireEvent.click(screen.getByTestId('wizard-next'));

		// Fill step 1
		fireEvent.change(screen.getByPlaceholderText('my-project'), {
			target: { value: 'demo-project' },
		});
		fireEvent.change(screen.getByPlaceholderText('/path/to/project'), {
			target: { value: '/home/user/demo' },
		});

		// Step 1 → 2
		fireEvent.click(screen.getByTestId('wizard-next'));
		expect(screen.getByRole('heading', { name: 'Connections' })).toBeDefined();

		// Step 2 → 3 (skip adding connections)
		fireEvent.click(screen.getByTestId('wizard-next'));
		expect(screen.getByRole('heading', { name: 'Options' })).toBeDefined();

		// Verify summary on step 3
		expect(screen.getByTestId('summary-name').textContent).toBe('demo-project');
		expect(screen.getByTestId('summary-folder').textContent).toBe(
			'/home/user/demo',
		);
		expect(screen.getByTestId('summary-connections').textContent).toBe('0');

		// Create Project button visible
		const createBtn = screen.getByTestId('wizard-create');
		expect(createBtn).toBeDefined();

		// Click Create
		fireEvent.click(createBtn);
		expect(defaultProps.onCreate).toHaveBeenCalledWith({
			name: 'demo-project',
			folderPath: '/home/user/demo',
			connections: [],
			generateSchema: false,
		});
	});

	// ── Cancel ──

	it('calls onClose when Cancel is clicked', () => {
		render(<NewProjectWizard {...defaultProps} />);
		fireEvent.click(screen.getByText('Cancel'));
		expect(defaultProps.onClose).toHaveBeenCalled();
	});

	// ── Creating state ──

	it('disables buttons when creating', () => {
		render(<NewProjectWizard {...defaultProps} creating={true} />);

		// Navigate to last step first
		fireEvent.click(screen.getByTestId('wizard-next')); // → 1
		fireEvent.change(screen.getByPlaceholderText('my-project'), {
			target: { value: 'x' },
		});
		fireEvent.change(screen.getByPlaceholderText('/path/to/project'), {
			target: { value: '/x' },
		});
		fireEvent.click(screen.getByTestId('wizard-next')); // → 2
		fireEvent.click(screen.getByTestId('wizard-next')); // → 3

		const createBtn = screen.getByTestId('wizard-create');
		expect(createBtn.hasAttribute('disabled')).toBe(true);
		expect(createBtn.textContent).toBe('Creating...');
	});

	// ── Connections step ──

	it('shows zero connections warning on step 2', () => {
		render(<NewProjectWizard {...defaultProps} />);
		fireEvent.click(screen.getByTestId('wizard-next')); // → 1
		fireEvent.change(screen.getByPlaceholderText('my-project'), {
			target: { value: 'x' },
		});
		fireEvent.change(screen.getByPlaceholderText('/path/to/project'), {
			target: { value: '/x' },
		});
		fireEvent.click(screen.getByTestId('wizard-next')); // → 2

		expect(screen.getByTestId('zero-connections-warning')).toBeDefined();
	});

	it('shows Add Connection button on step 2', () => {
		render(<NewProjectWizard {...defaultProps} />);
		fireEvent.click(screen.getByTestId('wizard-next')); // → 1
		fireEvent.change(screen.getByPlaceholderText('my-project'), {
			target: { value: 'x' },
		});
		fireEvent.change(screen.getByPlaceholderText('/path/to/project'), {
			target: { value: '/x' },
		});
		fireEvent.click(screen.getByTestId('wizard-next')); // → 2

		expect(screen.getByTestId('add-connection')).toBeDefined();
	});

	// ── Options step ──

	it('disables schema generation checkbox when no connections', () => {
		render(<NewProjectWizard {...defaultProps} />);
		// Navigate to step 3
		fireEvent.click(screen.getByTestId('wizard-next')); // → 1
		fireEvent.change(screen.getByPlaceholderText('my-project'), {
			target: { value: 'x' },
		});
		fireEvent.change(screen.getByPlaceholderText('/path/to/project'), {
			target: { value: '/x' },
		});
		fireEvent.click(screen.getByTestId('wizard-next')); // → 2
		fireEvent.click(screen.getByTestId('wizard-next')); // → 3

		const checkbox = screen.getByTestId('generate-schema-checkbox');
		expect(checkbox.hasAttribute('disabled')).toBe(true);
	});

	// ── Initial connection (Convert to Project flow) ──

	it('pre-populates connection when initialConnection is provided', () => {
		const initial: ConnectionFormData = {
			name: 'My Dev DB',
			type: 'postgresql',
			host: 'localhost',
			port: 5432,
			database: 'devdb',
			user: 'dev',
			password: 'pass',
			schema: 'public',
			sslMode: 'disable',
		};

		render(<NewProjectWizard {...defaultProps} initialConnection={initial} />);

		// Navigate to step 2 (connections)
		fireEvent.click(screen.getByTestId('wizard-next')); // → 1
		fireEvent.change(screen.getByPlaceholderText('my-project'), {
			target: { value: 'x' },
		});
		fireEvent.change(screen.getByPlaceholderText('/path/to/project'), {
			target: { value: '/x' },
		});
		fireEvent.click(screen.getByTestId('wizard-next')); // → 2

		// Should NOT see zero connections warning
		expect(screen.queryByTestId('zero-connections-warning')).toBeNull();
		// Should see connection info
		expect(screen.getByText('My Dev DB')).toBeDefined();
	});
});
