/**
 * Resource limits for assertion runner.
 * Prevents accidental processing of enormous files or unbounded runs.
 */

// ── Constants ────────────────────────────────────────────────────

/** Maximum .assert.dbsp file size in bytes (512 KB). */
export const MAX_ASSERT_FILE_SIZE = 512 * 1024;

/** Maximum .dbsp schema file size in bytes (512 KB). */
export const MAX_DBSP_FILE_SIZE = 512 * 1024;

/** Maximum number of assertion blocks (--- query: N) per file. */
export const MAX_ASSERTION_COUNT = 200;

/** Query execution timeout in milliseconds (30 seconds). */
export const ASSERTION_TIMEOUT_MS = 30_000;

// ── Validators ───────────────────────────────────────────────────

export interface ValidationError {
	readonly message: string;
}

/**
 * Validate assertion file content against resource limits.
 * Returns null if valid, or a ValidationError describing the issue.
 */
export function validateAssertionContent(
	content: string,
): ValidationError | null {
	const size = new TextEncoder().encode(content).byteLength;
	if (size > MAX_ASSERT_FILE_SIZE) {
		return {
			message: `Assertion file too large (${formatBytes(size)}). Maximum: ${formatBytes(MAX_ASSERT_FILE_SIZE)}.`,
		};
	}

	if (content.trim().length === 0) {
		return { message: 'Assertion file is empty.' };
	}

	const assertionCount = countAssertionBlocks(content);
	if (assertionCount > MAX_ASSERTION_COUNT) {
		return {
			message: `Too many assertion blocks (${assertionCount}). Maximum: ${MAX_ASSERTION_COUNT}.`,
		};
	}

	return null;
}

/**
 * Validate .dbsp schema file content against resource limits.
 * Returns null if valid, or a ValidationError describing the issue.
 */
export function validateDbspContent(content: string): ValidationError | null {
	const size = new TextEncoder().encode(content).byteLength;
	if (size > MAX_DBSP_FILE_SIZE) {
		return {
			message: `Query file too large (${formatBytes(size)}). Maximum: ${formatBytes(MAX_DBSP_FILE_SIZE)}.`,
		};
	}

	if (content.trim().length === 0) {
		return { message: 'Query file is empty.' };
	}

	return null;
}

/**
 * Wrap a promise with a timeout. Rejects with a descriptive error on timeout.
 */
export function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	label: string,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`${label} timed out after ${ms / 1000}s`)),
			ms,
		);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

// ── Helpers ──────────────────────────────────────────────────────

/** Count assertion blocks in content (lines starting with `---`). */
export function countAssertionBlocks(content: string): number {
	let count = 0;
	for (const line of content.split('\n')) {
		if (line.trimStart().startsWith('---')) {
			count++;
		}
	}
	return count;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const kb = bytes / 1024;
	if (kb < 1024) return `${kb.toFixed(1)} KB`;
	const mb = kb / 1024;
	return `${mb.toFixed(1)} MB`;
}
