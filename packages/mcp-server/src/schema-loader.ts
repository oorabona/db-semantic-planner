/**
 * Schema Loader for MCP Server
 *
 * Loads dbsp schema files with security measures to prevent path traversal attacks.
 * Based on packages/cli/src/utils/schema-loader.ts but with enhanced security.
 */

import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ResolvedSchema } from '@dbsp/schema';

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
	) {
		super(message);
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
export function validatePath(
	schemaPath: string,
	allowedRoots?: string[],
): string {
	// Normalize and resolve to absolute path
	const normalizedPath = normalize(schemaPath);
	const resolvedPath = isAbsolute(normalizedPath)
		? normalizedPath
		: resolve(process.cwd(), normalizedPath);

	// Check for path traversal patterns in the original input
	// After normalization, these patterns indicate an attempt to escape
	if (schemaPath.includes('..') && !existsSync(resolvedPath)) {
		throw new SchemaLoadError(
			`Suspicious path pattern detected: ${schemaPath}`,
			'PATH_TRAVERSAL',
		);
	}

	// If file exists, resolve symlinks and verify the real path
	if (existsSync(resolvedPath)) {
		const realPath = realpathSync(resolvedPath);

		// If allowedRoots specified, verify path is within allowed directories
		if (allowedRoots && allowedRoots.length > 0) {
			const normalizedRoots = allowedRoots.map((root) =>
				isAbsolute(root) ? normalize(root) : resolve(process.cwd(), root),
			);

			const isWithinAllowedRoot = normalizedRoots.some((root) => {
				// Resolve symlinks for root as well
				const realRoot = existsSync(root) ? realpathSync(root) : root;
				return realPath.startsWith(`${realRoot}/`) || realPath === realRoot;
			});

			if (!isWithinAllowedRoot) {
				throw new SchemaLoadError(
					`Schema path resolves outside allowed directories: ${realPath}. ` +
						`Allowed roots: ${normalizedRoots.join(', ')}`,
					'PATH_TRAVERSAL',
				);
			}
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
		// Convert to file URL for dynamic import
		const fileUrl = pathToFileURL(resolvedPath).href;
		const module = await import(fileUrl);

		// Look for schema export (named 'schema' or default)
		const schema = module.schema ?? module.default;

		if (!schema) {
			throw new SchemaLoadError(
				`Schema file must export 'schema' or default export: ${resolvedPath}`,
				'INVALID_SCHEMA',
			);
		}

		// Validate schema structure
		validateSchemaStructure(schema, resolvedPath);

		return {
			schema: schema as ResolvedSchema,
			resolvedPath,
		};
	} catch (error) {
		if (error instanceof SchemaLoadError) {
			throw error;
		}

		const message = error instanceof Error ? error.message : String(error);

		// Provide helpful error for TypeScript files
		if (
			resolvedPath.endsWith('.ts') &&
			message.includes('Cannot find module')
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
		);
	}
}

/**
 * Validate that the loaded object has the expected schema structure.
 */
function validateSchemaStructure(schema: unknown, path: string): void {
	if (!schema || typeof schema !== 'object') {
		throw new SchemaLoadError(
			`Invalid schema: expected object in ${path}`,
			'INVALID_SCHEMA',
		);
	}

	const obj = schema as Record<string, unknown>;

	if (!obj.tables || typeof obj.tables !== 'object') {
		throw new SchemaLoadError(
			`Invalid schema: missing 'tables' property in ${path}`,
			'INVALID_SCHEMA',
		);
	}

	if (!obj.relations || typeof obj.relations !== 'object') {
		throw new SchemaLoadError(
			`Invalid schema: missing 'relations' property in ${path}. ` +
				`Did you forget to call defineSchema()?`,
			'INVALID_SCHEMA',
		);
	}
}
