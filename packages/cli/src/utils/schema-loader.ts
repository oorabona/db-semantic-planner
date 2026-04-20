/**
 * Schema Loader Utility
 *
 * Loads dbsp.schema.ts files using tsx for TypeScript support.
 * Falls back to native import for .js files.
 *
 * NOTE: Similar code exists in packages/mcp-server/src/schema-loader.ts
 * The MCP version has additional security features (path traversal protection,
 * allowedRoots, error codes) that are required for network-exposed services.
 * This CLI version is simpler as it runs locally with user trust.
 * See ARCH-004 for analysis of this intentional duplication.
 */

import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelIR } from '@dbsp/core';

/**
 * ARCH-005: Schema type from schema() function.
 * Contains the definition, pre-computed ModelIR, and table names.
 */
export interface LoadedSchema {
	readonly definition: Record<string, unknown>;
	readonly model: ModelIR;
	readonly tableNames: string[];
}

/**
 * Type guard for ARCH-005 schema() output.
 */
function isValidSchema(schema: unknown): schema is LoadedSchema {
	return (
		typeof schema === 'object' &&
		schema !== null &&
		'model' in schema &&
		'definition' in schema &&
		typeof (schema as LoadedSchema).model === 'object' &&
		(schema as LoadedSchema).model !== null &&
		'tables' in (schema as LoadedSchema).model &&
		'relations' in (schema as LoadedSchema).model
	);
}

/**
 * Default schema file names to search for.
 */
export const DEFAULT_SCHEMA_FILES = [
	'dbsp.schema.ts',
	'dbsp.schema.js',
	'schema.ts',
	'schema.js',
];

/**
 * Error thrown when schema loading fails.
 */
export class SchemaLoadError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SchemaLoadError';
	}
}

/**
 * Find the schema file in the given directory.
 */
export function findSchemaFile(cwd: string): string | null {
	for (const file of DEFAULT_SCHEMA_FILES) {
		const fullPath = resolve(cwd, file);
		if (existsSync(fullPath)) {
			return fullPath;
		}
	}
	return null;
}

/**
 * Load a schema from a TypeScript or JavaScript file.
 *
 * ARCH-005: Only accepts new schema() format, not legacy defineSchema().
 * For TypeScript files, this uses tsx loader via dynamic import.
 */
export async function loadSchema(schemaPath: string): Promise<LoadedSchema> {
	const resolvedPath = resolve(schemaPath);

	// SEC-8: Prevent path traversal — schema must be under cwd.
	// This check runs before existsSync so traversal attempts are caught
	// regardless of whether the file exists.
	const cwd = resolve(process.cwd());
	if (!resolvedPath.startsWith(cwd + sep)) {
		throw new SchemaLoadError(
			`Schema file must be inside the current working directory: ${resolvedPath}`,
		);
	}

	if (!existsSync(resolvedPath)) {
		throw new SchemaLoadError(`Schema file not found: ${resolvedPath}`);
	}

	try {
		// For TypeScript files, we need tsx to be in the loader chain
		// This works when running via `tsx` or when tsx is registered
		const fileUrl = pathToFileURL(resolvedPath).href;
		const module = await import(fileUrl);

		// Look for schema export (named 'schema' or default)
		const schema = module.schema ?? module.default;

		if (!schema) {
			throw new SchemaLoadError(
				`Schema file must export 'schema' or default export: ${resolvedPath}`,
			);
		}

		// ARCH-005: Validate schema() format
		if (!isValidSchema(schema)) {
			throw new SchemaLoadError(
				`Invalid schema format in ${resolvedPath}. ` +
					`Use schema() from @dbsp/core to create schemas.`,
			);
		}

		return schema;
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
					`Then run dbsp via tsx:\n` +
					`  pnpm tsx node_modules/.bin/dbsp generate manifest\n\n` +
					`Original error: ${message}`,
			);
		}

		throw new SchemaLoadError(`Failed to load schema: ${message}`);
	}
}

/**
 * Load schema from the current working directory.
 * Searches for default schema file names.
 */
export async function loadSchemaFromCwd(cwd: string = process.cwd()): Promise<{
	schema: LoadedSchema;
	path: string;
}> {
	const schemaPath = findSchemaFile(cwd);

	if (!schemaPath) {
		throw new SchemaLoadError(
			`No schema file found in ${cwd}.\n` +
				`Expected one of: ${DEFAULT_SCHEMA_FILES.join(', ')}`,
		);
	}

	const schema = await loadSchema(schemaPath);
	return { schema, path: schemaPath };
}
