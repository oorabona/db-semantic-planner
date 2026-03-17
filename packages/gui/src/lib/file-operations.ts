/**
 * File rename/move operations with validation.
 *
 * Pure validation + Tauri fs wrappers for rename/move.
 */
import { isSupportedFile } from './drag-drop';

// ── Validation ──────────────────────────────────────────────────

export interface RenameValidation {
	readonly valid: boolean;
	readonly error?: string;
}

/**
 * Validate a new filename for an in-place rename.
 * Rules:
 * - Must not be empty
 * - Must not contain path separators
 * - Must end with a supported extension (.dbsp, .sql)
 * - Must differ from current name
 */
export function validateRename(
	currentName: string,
	newName: string,
): RenameValidation {
	const trimmed = newName.trim();
	if (trimmed.length === 0) {
		return { valid: false, error: 'Filename cannot be empty' };
	}
	if (trimmed.includes('/') || trimmed.includes('\\')) {
		return { valid: false, error: 'Filename cannot contain path separators' };
	}
	if (!isSupportedFile(trimmed)) {
		return { valid: false, error: 'File must end with .dbsp or .sql' };
	}
	if (trimmed === currentName.trim()) {
		return { valid: false, error: 'Name is unchanged' };
	}
	return { valid: true };
}

/**
 * Compute the new relative path after renaming a file in place.
 * Replaces only the filename portion.
 */
export function computeRenamedPath(
	oldRelativePath: string,
	newName: string,
): string {
	const lastSlash = oldRelativePath.lastIndexOf('/');
	if (lastSlash === -1) return newName;
	return `${oldRelativePath.slice(0, lastSlash + 1)}${newName}`;
}

/**
 * Extract the filename from a relative path.
 */
export function extractFilename(relativePath: string): string {
	const lastSlash = relativePath.lastIndexOf('/');
	return lastSlash === -1 ? relativePath : relativePath.slice(lastSlash + 1);
}
