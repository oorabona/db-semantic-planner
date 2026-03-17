// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WizardFilesStep } from './WizardFilesStep';

// Mock Tauri fs
const mockReadDir = vi.fn();
vi.mock('@tauri-apps/plugin-fs', () => ({
	readDir: (...args: unknown[]) => mockReadDir(...args),
}));

// Mock Tauri path
vi.mock('@tauri-apps/api/path', () => ({
	join: vi.fn((...args: string[]) => Promise.resolve(args.join('/'))),
}));

const defaultProps = {
	folderPath: '/home/user/project',
	files: [] as string[],
	schemaSelection: 'skip' as const,
	onToggleFile: vi.fn(),
	onSetFiles: vi.fn(),
	onSchemaSelectionChange: vi.fn(),
};

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe('WizardFilesStep', () => {
	// ── Scanner ──

	it('shows scanning state initially', () => {
		mockReadDir.mockReturnValue(new Promise(() => {})); // never resolves
		render(<WizardFilesStep {...defaultProps} />);
		expect(screen.getByText('Scanning folder...')).toBeDefined();
	});

	it('shows empty state when no supported files found', async () => {
		mockReadDir.mockResolvedValue([]);
		render(<WizardFilesStep {...defaultProps} />);

		await waitFor(() => {
			expect(screen.getByText(/No .dbsp or .sql files found/)).toBeDefined();
		});
	});

	it('discovers and displays supported files', async () => {
		mockReadDir.mockResolvedValue([
			{ name: 'main.dbsp', isDirectory: false },
			{ name: 'query.sql', isDirectory: false },
			{ name: 'readme.md', isDirectory: false },
		]);

		render(<WizardFilesStep {...defaultProps} />);

		await waitFor(() => {
			expect(screen.getByTestId('file-list')).toBeDefined();
		});

		// Only supported files shown
		expect(screen.getByText('main.dbsp')).toBeDefined();
		expect(screen.getByText('query.sql')).toBeDefined();
		expect(screen.queryByText('readme.md')).toBeNull();
	});

	it('calls onSetFiles with all discovered files (SC-13)', async () => {
		mockReadDir.mockResolvedValue([
			{ name: 'main.dbsp', isDirectory: false },
			{ name: 'test.assert.dbsp', isDirectory: false },
		]);

		render(<WizardFilesStep {...defaultProps} />);

		await waitFor(() => {
			expect(defaultProps.onSetFiles).toHaveBeenCalledWith([
				'main.dbsp',
				'test.assert.dbsp',
			]);
		});
	});

	it('skips directories in SKIP_DIRS set (SC-15)', async () => {
		mockReadDir.mockImplementation(async (dir: string) => {
			if (dir === '/home/user/project') {
				return [
					{ name: 'node_modules', isDirectory: true },
					{ name: 'src', isDirectory: true },
					{ name: 'main.dbsp', isDirectory: false },
				];
			}
			if (dir.endsWith('/src')) {
				return [{ name: 'inner.dbsp', isDirectory: false }];
			}
			return [];
		});

		render(<WizardFilesStep {...defaultProps} />);

		await waitFor(() => {
			expect(defaultProps.onSetFiles).toHaveBeenCalled();
		});

		const files = defaultProps.onSetFiles.mock.calls[0]![0] as string[];
		expect(files).toContain('main.dbsp');
		expect(files).toContain('src/inner.dbsp');
		// node_modules should have been skipped
		expect(files.every((f: string) => !f.includes('node_modules'))).toBe(true);
	});

	it('does not re-scan on re-render', async () => {
		mockReadDir.mockResolvedValue([]);
		const { rerender } = render(<WizardFilesStep {...defaultProps} />);

		await waitFor(() => {
			expect(screen.getByText(/No .dbsp or .sql files found/)).toBeDefined();
		});

		rerender(<WizardFilesStep {...defaultProps} />);
		// readDir called only once (first mount)
		expect(mockReadDir).toHaveBeenCalledTimes(1);
	});

	// ── File toggle ──

	it('calls onToggleFile when checkbox is clicked', async () => {
		mockReadDir.mockResolvedValue([{ name: 'main.dbsp', isDirectory: false }]);

		render(<WizardFilesStep {...defaultProps} files={['main.dbsp']} />);

		await waitFor(() => {
			expect(screen.getByTestId('file-list')).toBeDefined();
		});

		const checkbox = screen.getByRole('checkbox');
		fireEvent.click(checkbox);
		expect(defaultProps.onToggleFile).toHaveBeenCalledWith('main.dbsp');
	});

	// ── Schema selection ──

	it('shows schema selection radio buttons', async () => {
		mockReadDir.mockResolvedValue([]);
		render(<WizardFilesStep {...defaultProps} />);

		await waitFor(() => {
			expect(screen.getByTestId('schema-selection')).toBeDefined();
		});

		const radios = screen.getAllByRole('radio');
		expect(radios).toHaveLength(3);
	});

	it('calls onSchemaSelectionChange when radio is clicked', async () => {
		mockReadDir.mockResolvedValue([]);
		render(<WizardFilesStep {...defaultProps} />);

		await waitFor(() => {
			expect(screen.getByTestId('schema-selection')).toBeDefined();
		});

		const generateRadio = screen.getByText(
			'Generate from database introspection',
		);
		fireEvent.click(generateRadio);
		expect(defaultProps.onSchemaSelectionChange).toHaveBeenCalledWith(
			'generate',
		);
	});

	// ── No folder path ──

	it('does not scan when folderPath is empty', () => {
		mockReadDir.mockResolvedValue([]);
		render(<WizardFilesStep {...defaultProps} folderPath="" />);
		expect(mockReadDir).not.toHaveBeenCalled();
	});
});
