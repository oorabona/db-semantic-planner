/**
 * Schema Loader for MCP Server
 *
 * Loads dbsp schema files with security measures to prevent path traversal attacks.
 *
 * NOTE: Similar code exists in packages/cli/src/utils/schema-loader.ts
 * This MCP version has additional security features required for network-exposed services:
 * - Path traversal protection (validatePath)
 * - Allowed roots restriction (allowedRoots)
 * - Typed error codes (SchemaLoadError.code)
 * The CLI version is intentionally simpler as it runs locally with user trust.
 * See ARCH-004 for analysis of this intentional duplication.
 */

import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ResolvedSchema } from '@dbsp/core';
import { sanitizeErrorMessage, sanitizePath } from './format-error.js';
import {
	_resetWarnFlagForTests as _pvResetWarnFlag,
	hasParentSegment,
	isPathContained,
	validateAllowedRoots,
} from './path-validator.js';

/**
 * Options for schema loading with security constraints.
 */
export interface SchemaLoaderOptions {
	/**
	 * Path to the schema file (TypeScript or JavaScript).
	 */
	schemaPath: string;

	/**
	 * Optional list of allowed root directories.
	 * If provided, the schema path must resolve to a location within one of these roots.
	 * Provides defense against path traversal attacks.
	 */
	allowedRoots?: string[];
}

/**
 * Result of schema loading.
 */
export interface SchemaLoaderResult {
	/**
	 * The loaded and validated schema.
	 */
	schema: ResolvedSchema;

	/**
	 * The resolved absolute path to the schema file.
	 */
	resolvedPath: string;

	/**
	 * The canonical allowed roots used during path validation.
	 * Consumers can use this to log how many roots were checked without
	 * re-running validation. Empty array means cwd was used as the default root.
	 */
	canonicalRoots: string[];
}

/**
 * Error thrown when schema loading fails.
 */
export class SchemaLoadError extends Error {
	constructor(
		message: string,
		public readonly code:
			| 'PATH_TRAVERSAL'
			| 'NOT_FOUND'
			| 'INVALID_SCHEMA'
			| 'LOAD_FAILED',
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = 'SchemaLoadError';
	}
}

export type ValidatePathResult = {
	resolvedPath: string;
	canonicalRoots: string[];
};

/**
 * Validates that a path is safe (no path traversal) and within the allowed roots.
 *
 * @param schemaPath - The path to validate
 * @param allowedRoots - Optional list of allowed root directories (defaults to cwd)
 * @returns `{ resolvedPath, canonicalRoots }` — the resolved absolute path and the
 *   canonical roots used for containment checks
 * @throws SchemaLoadError if path traversal or out-of-bounds access is detected
 */
export function validatePath(
	schemaPath: string,
	allowedRoots?: string[],
): ValidatePathResult {
	// 1. Decode URL-encoded characters ONCE before any check so that
	//    '%2e%2e/etc' is correctly caught by the '..' guard below.
	//    On URIError (malformed percent-sequence, e.g. '100%dir'), fall back to
	//    the raw input: a malformed sequence cannot be a URL-encoded '..' anyway.
	let decodedPath: string;
	try {
		decodedPath = decodeURIComponent(schemaPath);
	} catch {
		// Malformed percent-sequence — not a URL-encoded traversal; use raw input.
		decodedPath = schemaPath;
	}

	// 2a. Backslash-form '..' — Windows traversal pattern. Reject unconditionally:
	//     on POSIX, backslash is a literal char so '..\\foo' cannot be a legitimate
	//     POSIX path that should be allowed through any root check.
	if (decodedPath.includes('..\\') || decodedPath === '..') {
		throw new SchemaLoadError(
			`Suspicious path pattern detected`,
			'PATH_TRAVERSAL',
		);
	}

	// 2b. POSIX '..' segment — uses segment-based detection (hasParentSegment) so that
	//     legitimate POSIX names like '/var/..backup' are NOT rejected (M-R3e/f fix).
	//     A '..' that STILL resolves within an allowed root is legitimate
	//     (e.g. '/tmp/a/../b/schema.js' with allowedRoot='/tmp').
	if (hasParentSegment(decodedPath)) {
		const canonicalRootsForEarlyCheck = validateAllowedRoots(
			allowedRoots,
			SchemaLoadError,
		);
		const normalizedEarly = normalize(decodedPath);
		const resolvedEarly = isAbsolute(normalizedEarly)
			? normalizedEarly
			: resolve(process.cwd(), normalizedEarly);
		if (!isPathContained(canonicalRootsForEarlyCheck, resolvedEarly)) {
			throw new SchemaLoadError(
				`Suspicious path pattern detected`,
				'PATH_TRAVERSAL',
			);
		}
		// Path has '..' but resolves within allowed roots — return early with resolved path.
		return {
			resolvedPath: existsSync(resolvedEarly)
				? realpathSync(resolvedEarly)
				: resolvedEarly,
			canonicalRoots: canonicalRootsForEarlyCheck,
		};
	}

	// 3. Canonicalize roots — handles default-to-cwd warn-once and segment-based
	//    '..' rejection (fixes M-R3e/f: substring check falsely rejected /var/..backup).
	const canonicalRoots = validateAllowedRoots(allowedRoots, SchemaLoadError);

	// 4. Normalize and resolve the user path to an absolute form.
	const normalizedPath = normalize(decodedPath);
	const resolvedPath = isAbsolute(normalizedPath)
		? normalizedPath
		: resolve(process.cwd(), normalizedPath);

	// 5. Unified containment check — symlink-aware for both existing and non-existent
	//    paths (fixes M-R3g: symlinked root + non-existent file caused false positive).
	//    This replaces the old split into two separate existsSync branches.
	if (!isPathContained(canonicalRoots, resolvedPath)) {
		throw new SchemaLoadError(
			sanitizeErrorMessage(
				`Schema path resolves outside allowed directories (checked against ${canonicalRoots.length} root(s))`,
				{ resolved: resolvedPath },
			),
			'PATH_TRAVERSAL',
		);
	}

	// 6. Return the canonical resolved path for downstream.
	//    For existing files: use realpathSync (resolves all symlinks for TOCTOU defence).
	//    For non-existent: return the lexically resolved path (no realpath possible).
	const finalResolved = existsSync(resolvedPath)
		? realpathSync(resolvedPath)
		: resolvedPath;
	return { resolvedPath: finalResolved, canonicalRoots };
}

/**
 * Load a schema from a TypeScript or JavaScript file.
 *
 * Security measures:
 * - Path normalization to prevent traversal
 * - Optional allowlist of root directories
 * - Symlink resolution to detect escape attempts
 *
 * @param options - Schema loader options
 * @returns The loaded schema and resolved path
 * @throws SchemaLoadError on validation or loading errors
 */
export async function loadSchema(
	options: SchemaLoaderOptions,
): Promise<SchemaLoaderResult> {
	const { schemaPath, allowedRoots } = options;

	// Validate and resolve path with security checks.
	// validatePath also canonicalizes allowedRoots — reuse the result to avoid
	// independent re-resolution that could diverge under refactoring (S-B guard).
	const { resolvedPath, canonicalRoots } = validatePath(
		schemaPath,
		allowedRoots,
	);

	// Check if file exists
	if (!existsSync(resolvedPath)) {
		throw new SchemaLoadError(
			`Schema file not found: ${sanitizePath(resolvedPath, 'basename')}`,
			'NOT_FOUND',
		);
	}

	try {
		// TOCTOU mitigation (M11): re-resolve symlinks immediately before import and
		// re-check containment so a symlink swap between validatePath and import() is caught.
		const canonicalPath = realpathSync(resolvedPath);

		// Re-check containment using the SAME canonical roots that validatePath already
		// computed — this ensures the two checks are always consistent (S-B).
		const rootsToCheck: string[] =
			canonicalRoots.length > 0 ? canonicalRoots : [process.cwd()];

		const stillWithin = isPathContained(rootsToCheck, canonicalPath);

		if (!stillWithin) {
			throw new SchemaLoadError(
				`Schema path escaped allowed directories after symlink resolution: <schema-file>`,
				'PATH_TRAVERSAL',
			);
		}

		// Convert canonical real-path to file URL for dynamic import
		const fileUrl = pathToFileURL(canonicalPath).href;
		const module = await import(fileUrl);

		// Look for schema export (named 'schema' or default)
		const schema = module.schema ?? module.default;

		if (!schema) {
			throw new SchemaLoadError(
				`Schema file must export 'schema' or default export: <schema-file>`,
				'INVALID_SCHEMA',
			);
		}

		// Validate schema structure
		validateResolvedSchema(schema);

		return {
			schema: schema as ResolvedSchema,
			resolvedPath: canonicalPath,
			canonicalRoots,
		};
	} catch (error) {
		if (error instanceof SchemaLoadError) {
			throw error;
		}

		const rawMessage = error instanceof Error ? error.message : String(error);

		// Sanitize the error message via the canonical helper (M-C + Copilot R5 structural).
		// sanitizeErrorMessage replaces all occurrences of resolved path and parent dir,
		// then caps the message length to prevent oversized error strings.
		const message = sanitizeErrorMessage(rawMessage, {
			resolved: resolvedPath,
			parent: dirname(resolvedPath),
		});

		// Provide helpful error for TypeScript files
		if (
			resolvedPath.endsWith('.ts') &&
			rawMessage.includes('Cannot find module')
		) {
			throw new SchemaLoadError(
				`Failed to load TypeScript schema. Make sure 'tsx' is installed:\n` +
					`  pnpm add -D tsx\n\n` +
					`Then run the MCP server via tsx:\n` +
					`  pnpm tsx node_modules/.bin/dbsp-mcp --schema ./schema.ts\n\n` +
					`Original error: ${message}`,
				'LOAD_FAILED',
			);
		}

		throw new SchemaLoadError(
			`Failed to load schema: ${message}`,
			'LOAD_FAILED',
			{ cause: error },
		);
	}
}

/**
 * Validate that the loaded object has the expected ResolvedSchema structure.
 *
 * This performs a structural duck-type check mirroring the valibot validator at
 * packages/core/src/dx/schema-bridge.ts:911 (ResolvedSchemaValidation).
 * TODO: once @dbsp/core exports ResolvedSchemaValidation publicly, delegate to it
 * via v.safeParse(ResolvedSchemaValidation, schema) instead of this local check.
 *
 * Note: 'defaultFilters' is a valid field on ResolvedSchema but is not part of the
 * valibot validator — this gap is intentional (leave validation of that field for a
 * future public-export ticket).
 */

/**
 * Returns true only for plain objects (Object.prototype or null proto).
 * Rejects Date, Map, Set, RegExp, Array, and other class instances that
 * pass typeof === 'object' but are not valid schema field values (M-D).
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
	if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
	const proto = Object.getPrototypeOf(v) as unknown;
	return proto === Object.prototype || proto === null;
}

/** @internal Test-only: reset the warn-once flag between test runs. */
export function _resetWarnFlagForTests(): void {
	// Delegate to path-validator where the flag now lives.
	_pvResetWarnFlag();
}

export function validateResolvedSchema(schema: unknown): void {
	// Arrays are not valid schemas even though typeof [] === 'object'
	if (Array.isArray(schema)) {
		throw new SchemaLoadError(
			`Invalid schema: expected object, got array. Did you export an array instead of a schema?`,
			'INVALID_SCHEMA',
		);
	}

	if (!schema || typeof schema !== 'object') {
		throw new SchemaLoadError(
			`Invalid schema: expected object, got ${schema === null ? 'null' : typeof schema}`,
			'INVALID_SCHEMA',
		);
	}

	const obj = schema as Record<string, unknown>;

	// Required field: tables must be a plain object (M-D: isPlainObject rejects
	// Date, Map, Set, RegExp etc. that pass typeof === 'object')
	if (!isPlainObject(obj.tables)) {
		throw new SchemaLoadError(
			`Invalid schema: 'tables' must be a plain object (got ${obj.tables === null ? 'null' : Array.isArray(obj.tables) ? 'array' : typeof obj.tables === 'object' ? Object.prototype.toString.call(obj.tables) : typeof obj.tables})`,
			'INVALID_SCHEMA',
		);
	}

	// Required field: relations must be a plain object
	if (!isPlainObject(obj.relations)) {
		throw new SchemaLoadError(
			`Invalid schema: 'relations' must be a plain object (got ${obj.relations === null ? 'null' : Array.isArray(obj.relations) ? 'array' : typeof obj.relations === 'object' ? Object.prototype.toString.call(obj.relations) : typeof obj.relations}). ` +
				`Did you forget to call defineSchema()?`,
			'INVALID_SCHEMA',
		);
	}

	// Required field: hints must be a plain object (may be empty {}).
	// defineSchema() always populates this — missing means the schema was not
	// built via the public API and is therefore invalid.
	if (!isPlainObject(obj.hints)) {
		throw new SchemaLoadError(
			`Invalid schema: 'hints' is required and must be a plain object (defineSchema() should populate this)`,
			'INVALID_SCHEMA',
		);
	}

	// Required field: conventions must be a plain object.
	// defineSchema() always populates this — missing means the schema was not
	// built via the public API and is therefore invalid.
	if (!isPlainObject(obj.conventions)) {
		throw new SchemaLoadError(
			`Invalid schema: 'conventions' is required and must be a plain object (defineSchema() should populate this)`,
			'INVALID_SCHEMA',
		);
	}

	// Required field: indexes must be a plain object.
	// defineSchema() always populates this — missing means the schema was not
	// built via the public API and is therefore invalid.
	//
	// Validates: tables, relations, hints, conventions, indexes (matches the
	// ResolvedSchemaValidation valibot schema in @dbsp/core).
	// Not validated (intentional gap until @dbsp/core exports its validator):
	// 'defaultFilters' field.
	if (!isPlainObject(obj.indexes)) {
		throw new SchemaLoadError(
			`Invalid schema: 'indexes' is required and must be a plain object (defineSchema() should populate this)`,
			'INVALID_SCHEMA',
		);
	}
}
