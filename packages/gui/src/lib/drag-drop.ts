// ── Drag & Drop validation ───────────────────────────────────────
//
// Validates files dropped from the OS file manager onto the app window.
// Pure logic — no Tauri/DOM dependencies.

export const SUPPORTED_EXTENSIONS = ['.dbsp', '.sql'] as const;

export function isSupportedFile(path: string): boolean {
	return SUPPORTED_EXTENSIONS.some((ext) => path.endsWith(ext));
}

export function findContainingRoot(
	filePath: string,
	roots: readonly string[],
): string | null {
	for (const root of roots) {
		const prefix = root.endsWith('/') ? root : `${root}/`;
		if (filePath.startsWith(prefix)) return root;
	}
	return null;
}

export function relativeTo(filePath: string, root: string): string {
	const prefix = root.endsWith('/') ? root : `${root}/`;
	return filePath.slice(prefix.length);
}

// ── Result type ──────────────────────────────────────────────────

export interface DropResult {
	/** Relative paths of accepted files (pass to addFile) */
	readonly accepted: readonly string[];
	/** Absolute paths of files outside all project roots */
	readonly outsideRoots: readonly string[];
}

// ── Main validation ──────────────────────────────────────────────

export function validateDroppedFiles(
	droppedPaths: readonly string[],
	roots: readonly string[],
	existingFiles: readonly string[],
): DropResult {
	const existing = new Set(existingFiles);
	const accepted: string[] = [];
	const outsideRoots: string[] = [];
	const seen = new Set<string>();

	for (const absPath of droppedPaths) {
		// SC-10: unsupported extensions silently ignored
		if (!isSupportedFile(absPath)) continue;

		// SC-11: files outside all roots → rejected with toast
		const root = findContainingRoot(absPath, roots);
		if (!root) {
			outsideRoots.push(absPath);
			continue;
		}

		// SC-12: dedup against existing files and within this batch
		const relPath = relativeTo(absPath, root);
		if (existing.has(relPath) || seen.has(relPath)) continue;

		seen.add(relPath);
		accepted.push(relPath);
	}

	return { accepted, outsideRoots };
}
