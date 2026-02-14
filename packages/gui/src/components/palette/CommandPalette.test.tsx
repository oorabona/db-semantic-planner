// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commandRegistry } from '@/lib/commands';
import { CommandPalette, type ProjectFile } from './CommandPalette';

// Mock Tauri APIs
vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn(),
}));
vi.mock('@tauri-apps/api/event', () => ({
	listen: vi.fn().mockResolvedValue(() => {}),
}));

/** Open the palette via command registry (simulates Tauri accelerator → menu event path) */
function openPalette() {
	act(() => {
		commandRegistry.execute('view.command_palette');
	});
}

beforeEach(() => {
	// cmdk uses ResizeObserver internally; jsdom doesn't provide it
	if (!globalThis.ResizeObserver) {
		globalThis.ResizeObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		} as unknown as typeof ResizeObserver;
	}
	// cmdk calls scrollIntoView on items; jsdom doesn't provide it
	if (!Element.prototype.scrollIntoView) {
		Element.prototype.scrollIntoView = () => {};
	}
	// Clean up DOM between tests
	document.body.textContent = '';
	// Reset command registry singleton to avoid test leakage
	commandRegistry._reset();
});

afterEach(() => {
	cleanup();
});

describe('CommandPalette', () => {
	describe('keyboard shortcut (via command registry)', () => {
		it('should open via command registry execute', () => {
			// Arrange
			render(<CommandPalette />);

			// Act — simulate Ctrl+K via Tauri accelerator → command registry
			openPalette();

			// Assert — palette input should be visible
			expect(screen.getByPlaceholderText('Type a command...')).toBeTruthy();
		});

		it('should toggle closed on second execute', () => {
			render(<CommandPalette />);

			// Open
			openPalette();
			expect(screen.getByPlaceholderText('Type a command...')).toBeTruthy();

			// Close
			openPalette();
			expect(screen.queryByPlaceholderText('Type a command...')).toBeNull();
		});
	});

	describe('standalone mode (no files)', () => {
		it('should show "Type a command..." placeholder when no files', () => {
			render(<CommandPalette />);
			openPalette();

			expect(screen.getByPlaceholderText('Type a command...')).toBeTruthy();
		});

		it('should display registered commands', () => {
			// Arrange — register a command
			commandRegistry.register({
				id: 'test.palette.cmd',
				label: 'Test Palette Action',
				category: 'file',
				handler: vi.fn(),
			});

			// Act
			render(<CommandPalette />);
			openPalette();

			// Assert
			expect(screen.getByText('Test Palette Action')).toBeTruthy();
		});
	});

	describe('project mode (with files)', () => {
		const files: ProjectFile[] = [
			{ path: 'queries/users.dbsp', name: 'users.dbsp' },
			{ path: 'queries/reports.dbsp', name: 'reports.dbsp' },
		];

		it('should show file search placeholder when files provided', () => {
			render(<CommandPalette files={files} />);
			openPalette();

			expect(
				screen.getByPlaceholderText('Search files... (type > for commands)'),
			).toBeTruthy();
		});

		it('should display project files', () => {
			render(<CommandPalette files={files} />);
			openPalette();

			expect(screen.getByText('users.dbsp')).toBeTruthy();
			expect(screen.getByText('reports.dbsp')).toBeTruthy();
		});

		it('should call onFileSelect when a file is selected', () => {
			const onFileSelect = vi.fn();
			render(<CommandPalette files={files} onFileSelect={onFileSelect} />);
			openPalette();

			// Click on a file
			fireEvent.click(screen.getByText('users.dbsp'));

			expect(onFileSelect).toHaveBeenCalledWith(files[0]);
		});
	});

	describe('command mode (> prefix)', () => {
		it('should switch to command mode when > is typed', () => {
			// Arrange
			commandRegistry.register({
				id: 'test.cmd.mode',
				label: 'Command Mode Action',
				category: 'edit',
				handler: vi.fn(),
			});

			const files: ProjectFile[] = [{ path: 'test.dbsp', name: 'test.dbsp' }];

			// Act
			render(<CommandPalette files={files} />);
			openPalette();

			const input = screen.getByPlaceholderText(
				'Search files... (type > for commands)',
			);
			fireEvent.change(input, { target: { value: '>' } });

			// Assert — should show commands, not files
			expect(screen.getByText('Command Mode Action')).toBeTruthy();
		});
	});

	describe('command execution', () => {
		it('should execute command and close palette on select', () => {
			const handler = vi.fn();
			commandRegistry.register({
				id: 'test.exec.close',
				label: 'Exec And Close',
				category: 'file',
				handler,
			});

			render(<CommandPalette />);
			openPalette();

			fireEvent.click(screen.getByText('Exec And Close'));

			expect(handler).toHaveBeenCalledOnce();
			// Palette should close
			expect(screen.queryByPlaceholderText('Type a command...')).toBeNull();
		});
	});
});
