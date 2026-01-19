/**
 * Schema Loader Utility
 *
 * Loads dbsp.schema.ts files using tsx for TypeScript support.
 * Falls back to native import for .js files.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ResolvedSchema } from '@dbsp/core';

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
 * For TypeScript files, this uses tsx loader via dynamic import.
 * The tsx package must be available (peer dependency).
 */
export async function loadSchema(schemaPath: string): Promise<ResolvedSchema> {
	const resolvedPath = resolve(schemaPath);

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

		// Basic validation - check for required properties
		if (!schema.tables || typeof schema.tables !== 'object') {
			throw new SchemaLoadError(
				`Invalid schema: missing 'tables' property in ${resolvedPath}`,
			);
		}

		if (!schema.relations || typeof schema.relations !== 'object') {
			throw new SchemaLoadError(
				`Invalid schema: missing 'relations' property in ${resolvedPath}. ` +
					`Did you forget to call defineSchema()?`,
			);
		}

		return schema as ResolvedSchema;
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
	schema: ResolvedSchema;
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
