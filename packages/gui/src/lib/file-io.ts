import { ask, open as openDialog, save } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import type { TabLanguage } from '@/stores/editor-store';

const DIALOG_FILTERS = [
	{ name: 'DBSP files', extensions: ['dbsp'] },
	{ name: 'SQL files', extensions: ['sql'] },
	{ name: 'All Files', extensions: ['*'] },
];

/** Determine the tab language from a file path */
export function languageFromPath(filePath: string): TabLanguage {
	if (filePath.endsWith('.assert.dbsp') || filePath.endsWith('.dbsp'))
		return 'nql';
	if (filePath.endsWith('.sql')) return 'sql';
	return 'sql';
}

/** Extract filename from a full path */
export function filenameFromPath(filePath: string): string {
	return filePath.split(/[/\\]/).pop() ?? filePath;
}

/**
 * Show native "Open File" dialog, read the selected file.
 * Returns null if user cancelled.
 */
export async function openFile(): Promise<{
	filePath: string;
	content: string;
	language: TabLanguage;
} | null> {
	const selected = await openDialog({
		title: 'Open File',
		filters: DIALOG_FILTERS,
		multiple: false,
	});
	if (!selected) return null;

	const content = await readTextFile(selected);
	return {
		filePath: selected,
		content,
		language: languageFromPath(selected),
	};
}

/**
 * Write content to an existing file path.
 * Throws on permission error.
 */
export async function saveFile(
	filePath: string,
	content: string,
): Promise<void> {
	await writeTextFile(filePath, content);
}

/**
 * Show native "Save As" dialog, write content to the chosen path.
 * Returns the chosen path or null if user cancelled.
 */
export async function saveFileAs(
	content: string,
	defaultName?: string,
): Promise<string | null> {
	const path = await save({
		title: 'Save As',
		defaultPath: defaultName,
		filters: DIALOG_FILTERS,
	});
	if (!path) return null;

	await writeTextFile(path, content);
	return path;
}

/**
 * Show a "Save changes?" confirm dialog for unsaved tabs.
 * Returns 'save' | 'discard' | 'cancel'.
 */
export async function confirmUnsavedChanges(
	filename: string,
): Promise<'save' | 'discard' | 'cancel'> {
	const result = await ask(`Save changes to "${filename}"?`, {
		title: 'Unsaved Changes',
		kind: 'warning',
	});
	// ask() returns true (Yes/Save), false (No/Discard), or null (Cancel)
	if (result === true) return 'save';
	if (result === false) return 'discard';
	return 'cancel';
}
