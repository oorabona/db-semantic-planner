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
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ResolvedSchema } from '@dbsp/core';

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

/**
 * Validates that a path is safe (no path traversal).
 *
 * @param schemaPath - The path to validate
 * @param allowedRoots - Optional list of allowed root directories
 * @returns The resolved absolute path if valid
 * @throws SchemaLoadError if path traversal is detected
 */
let _cwdWarnEmitted = false;

export function validatePath(
	schemaPath: string,
	allowedRoots?: string[],
): string {
	// Normalize and resolve to absolute path
	const normalizedPath = normalize(schemaPath);
	const resolvedPath = isAbsolute(normalizedPath)
		? normalizedPath
		: resolve(process.cwd(), normalizedPath);

	// Reject unconditionally if the original input contains '..' — regardless of whether
	// the resolved path exists. A legitimate path like '..backup/schema.js' inside an
	// allowed root is accepted below after containment re-check; the early exit here only
	// fires when the relative escape (relativePath === '..' or starts with '../') fails.
	if (schemaPath.includes('..')) {
		// Compute the relative path from cwd to detect actual escapes
		const relFromCwd = relative(process.cwd(), resolvedPath);
		if (
			relFromCwd === '..' ||
			relFromCwd.startsWith(`..${sep}`) ||
			isAbsolute(relFromCwd)
		) {
			throw new SchemaLoadError(
				`Suspicious path pattern detected: ${schemaPath}`,
				'PATH_TRAVERSAL',
			);
		}
	}

	// Validate each allowedRoots entry: reject if it contains '..' post-normalize
	// (prevents sneaking out via a crafted root path)
	const effectiveRoots: string[] | undefined = allowedRoots?.map((root) => {
		const normalizedRoot = normalize(root);
		if (normalizedRoot.includes('..')) {
			throw new SchemaLoadError(
				`Invalid allowedRoot contains path traversal: ${root}`,
				'PATH_TRAVERSAL',
			);
		}
		return isAbsolute(normalizedRoot)
			? normalizedRoot
			: resolve(process.cwd(), normalizedRoot);
	});

	// Default allowedRoots to [cwd] when not provided; warn ONCE per invocation
	let rootsToCheck: string[];
	if (!effectiveRoots || effectiveRoots.length === 0) {
		if (!_cwdWarnEmitted) {
			process.stderr.write(
				'[dbsp-mcp] Warning: no --allowed-root specified, defaulting to cwd\n',
			);
			_cwdWarnEmitted = true;
		}
		rootsToCheck = [process.cwd()];
	} else {
		rootsToCheck = effectiveRoots;
	}

	// If file exists, resolve symlinks and verify the real path
	if (existsSync(resolvedPath)) {
		const realPath = realpathSync(resolvedPath);

		const isWithinAllowedRoot = rootsToCheck.some((root) => {
			// Resolve symlinks for root as well
			const realRoot = existsSync(root) ? realpathSync(root) : root;
			// Use path.relative to check containment (secure against path traversal)
			const relativePath = relative(realRoot, realPath);
			// Path is within root if relative path doesn't start with '..' and isn't absolute.
			// relativePath === '' means schemaPath IS the root itself — excluded (not a file in the root).
			return (
				relativePath !== '' &&
				relativePath !== '..' &&
				!relativePath.startsWith(`..${sep}`) &&
				!isAbsolute(relativePath)
			);
		});

		if (!isWithinAllowedRoot) {
			throw new SchemaLoadError(
				`Schema path resolves outside allowed directories: ${realPath}. ` +
					`Allowed roots: ${rootsToCheck.join(', ')}`,
				'PATH_TRAVERSAL',
			);
		}

		return realPath;
	}

	// File doesn't exist yet - just return resolved path for error handling
	return resolvedPath;
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

	// Validate and resolve path with security checks
	const resolvedPath = validatePath(schemaPath, allowedRoots);

	// Check if file exists
	if (!existsSync(resolvedPath)) {
		throw new SchemaLoadError(
			`Schema file not found: ${resolvedPath}`,
			'NOT_FOUND',
		);
	}

	try {
		// TOCTOU mitigation (M11): re-resolve symlinks immediately before import and
		// re-check containment so a symlink swap between validatePath and import() is caught.
		const canonicalPath = realpathSync(resolvedPath);

		// Re-check containment: canonical path must still be within the same roots
		// that validatePath already verified. If a symlink was swapped, it may now
		// point outside the allowed root.
		const rootsToCheck: string[] =
			allowedRoots && allowedRoots.length > 0
				? allowedRoots.map((root) =>
						isAbsolute(normalize(root))
							? normalize(root)
							: resolve(process.cwd(), root),
					)
				: [process.cwd()];

		const stillWithin = rootsToCheck.some((root) => {
			const realRoot = existsSync(root) ? realpathSync(root) : root;
			const rel = relative(realRoot, canonicalPath);
			return (
				rel !== '' &&
				rel !== '..' &&
				!rel.startsWith(`..${sep}`) &&
				!isAbsolute(rel)
			);
		});

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
		};
	} catch (error) {
		if (error instanceof SchemaLoadError) {
			throw error;
		}

		const rawMessage = error instanceof Error ? error.message : String(error);
		const message = rawMessage
			.replace(resolvedPath, '<schema-file>')
			.slice(0, 500);

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
 * Validate that the loaded object has the expected schema structure.
 */
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

	// Required field: tables must be a non-array object
	if (
		obj.tables === undefined ||
		obj.tables === null ||
		typeof obj.tables !== 'object' ||
		Array.isArray(obj.tables)
	) {
		throw new SchemaLoadError(
			`Invalid schema: 'tables' must be an object (got ${obj.tables === null ? 'null' : Array.isArray(obj.tables) ? 'array' : typeof obj.tables})`,
			'INVALID_SCHEMA',
		);
	}

	// Required field: relations must be a non-array object
	if (
		obj.relations === undefined ||
		obj.relations === null ||
		typeof obj.relations !== 'object' ||
		Array.isArray(obj.relations)
	) {
		throw new SchemaLoadError(
			`Invalid schema: 'relations' must be an object (got ${obj.relations === null ? 'null' : Array.isArray(obj.relations) ? 'array' : typeof obj.relations}). ` +
				`Did you forget to call defineSchema()?`,
			'INVALID_SCHEMA',
		);
	}

	// Required field: hints must be an object (may be empty {})
	if (obj.hints !== undefined) {
		if (
			obj.hints === null ||
			typeof obj.hints !== 'object' ||
			Array.isArray(obj.hints)
		) {
			throw new SchemaLoadError(
				`Invalid schema: 'hints' must be an object`,
				'INVALID_SCHEMA',
			);
		}
	}

	// Required field: conventions must be an object when present
	if (obj.conventions !== undefined) {
		if (
			obj.conventions === null ||
			typeof obj.conventions !== 'object' ||
			Array.isArray(obj.conventions)
		) {
			throw new SchemaLoadError(
				`Invalid schema: 'conventions' must be an object`,
				'INVALID_SCHEMA',
			);
		}
	}
}
