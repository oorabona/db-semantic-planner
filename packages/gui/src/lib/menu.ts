import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/** Menu item IDs matching the Rust-side menu builder in lib.rs */
export const MENU_IDS = {
	// File
	FILE_NEW_PROJECT: 'file.new_project',
	FILE_NEW_QUERY: 'file.new_query',
	FILE_OPEN_FILE: 'file.open_file',
	FILE_OPEN_FOLDER: 'file.open_folder',
	FILE_RECENT_PROJECTS: 'file.recent_projects',
	FILE_SAVE: 'file.save',
	FILE_SAVE_AS: 'file.save_as',
	FILE_EXPORT_CSV: 'file.export_csv',
	FILE_CLOSE_TAB: 'file.close_tab',
	FILE_PREFERENCES: 'file.preferences',
	// Edit
	EDIT_FIND: 'edit.find',
	EDIT_REPLACE: 'edit.replace',
	EDIT_FORMAT: 'edit.format',
	// View
	VIEW_COMMAND_PALETTE: 'view.command_palette',
	VIEW_TOGGLE_SIDEBAR: 'view.toggle_sidebar',
	VIEW_TOGGLE_RESULTS: 'view.toggle_results',
	VIEW_ZOOM_IN: 'view.zoom_in',
	VIEW_ZOOM_OUT: 'view.zoom_out',
	VIEW_ZOOM_RESET: 'view.zoom_reset',
	// Connection
	CONNECTION_NEW: 'connection.new',
	CONNECTION_DISCONNECT: 'connection.disconnect',
	CONNECTION_MANAGE: 'connection.manage',
	// Help
	HELP_SHORTCUTS: 'help.shortcuts',
	HELP_DOCS: 'help.docs',
	HELP_ABOUT: 'help.about',
	HELP_UPDATES: 'help.updates',
} as const;

export type MenuId = (typeof MENU_IDS)[keyof typeof MENU_IDS];

/**
 * Enable or disable a native menu item by its id.
 * Calls the Rust `update_menu_item` command via Tauri IPC.
 */
export async function setMenuItemEnabled(
	id: MenuId,
	enabled: boolean,
): Promise<void> {
	await invoke('update_menu_item', { id, enabled });
}

/**
 * Listen for menu events emitted from the Rust menu handler.
 * Returns an unlisten function.
 */
export function onMenuEvent(
	handler: (menuId: string) => void,
): Promise<UnlistenFn> {
	return listen<string>('menu-event', (event) => {
		handler(event.payload);
	});
}
