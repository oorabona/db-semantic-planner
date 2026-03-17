import { describe, expect, it, vi } from 'vitest';
import { MENU_IDS, onMenuEvent, setMenuItemEnabled } from './menu';

// Mock Tauri APIs
vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn(),
}));
vi.mock('@tauri-apps/api/event', () => ({
	listen: vi.fn(),
}));

describe('MENU_IDS', () => {
	it('should contain all File menu items', () => {
		// Arrange & Act — verify enum completeness
		const fileIds = Object.keys(MENU_IDS).filter((k) => k.startsWith('FILE_'));

		// Assert
		expect(fileIds).toHaveLength(11);
		expect(MENU_IDS.FILE_NEW_QUERY_SQL).toBe('file.new_query_sql');
		expect(MENU_IDS.FILE_NEW_QUERY_NQL).toBe('file.new_query_nql');
		expect(MENU_IDS.FILE_SAVE).toBe('file.save');
		expect(MENU_IDS.FILE_PREFERENCES).toBe('file.preferences');
	});

	it('should contain all Edit menu items', () => {
		const editIds = Object.keys(MENU_IDS).filter((k) => k.startsWith('EDIT_'));
		expect(editIds).toHaveLength(3);
	});

	it('should contain all View menu items', () => {
		const viewIds = Object.keys(MENU_IDS).filter((k) => k.startsWith('VIEW_'));
		expect(viewIds).toHaveLength(6);
	});

	it('should contain all Connection menu items', () => {
		const connIds = Object.keys(MENU_IDS).filter((k) =>
			k.startsWith('CONNECTION_'),
		);
		expect(connIds).toHaveLength(3);
	});

	it('should contain all Help menu items', () => {
		const helpIds = Object.keys(MENU_IDS).filter((k) => k.startsWith('HELP_'));
		expect(helpIds).toHaveLength(4);
	});

	it('should have unique id values (no duplicates)', () => {
		const values = Object.values(MENU_IDS);
		const unique = new Set(values);
		expect(unique.size).toBe(values.length);
	});
});

describe('setMenuItemEnabled', () => {
	it('should invoke update_menu_item with correct args', async () => {
		// Arrange
		const { invoke } = await import('@tauri-apps/api/core');

		// Act
		await setMenuItemEnabled(MENU_IDS.FILE_SAVE, true);

		// Assert
		expect(invoke).toHaveBeenCalledWith('update_menu_item', {
			id: 'file.save',
			enabled: true,
		});
	});

	it('should pass enabled=false to disable a menu item', async () => {
		const { invoke } = await import('@tauri-apps/api/core');

		await setMenuItemEnabled(MENU_IDS.CONNECTION_DISCONNECT, false);

		expect(invoke).toHaveBeenCalledWith('update_menu_item', {
			id: 'connection.disconnect',
			enabled: false,
		});
	});
});

describe('onMenuEvent', () => {
	it('should register a listener for menu-event', async () => {
		// Arrange
		const { listen } = await import('@tauri-apps/api/event');
		const mockUnlisten = vi.fn();
		vi.mocked(listen).mockResolvedValue(mockUnlisten);

		// Act
		const handler = vi.fn();
		const unlisten = await onMenuEvent(handler);

		// Assert
		expect(listen).toHaveBeenCalledWith('menu-event', expect.any(Function));
		expect(unlisten).toBe(mockUnlisten);
	});

	it('should forward event payload to handler', async () => {
		// Arrange
		const { listen } = await import('@tauri-apps/api/event');
		let capturedCallback: ((event: { payload: string }) => void) | undefined;
		vi.mocked(listen).mockImplementation(async (_event, cb) => {
			capturedCallback = cb as (event: { payload: string }) => void;
			return (() => {}) as () => void;
		});

		const handler = vi.fn();
		await onMenuEvent(handler);

		// Act — simulate a menu event from Rust
		capturedCallback?.({ payload: 'file.save' });

		// Assert
		expect(handler).toHaveBeenCalledWith('file.save');
	});
});
