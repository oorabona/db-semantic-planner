/**
 * Schema Loader for Sidecar
 *
 * Loads dbsp.schema.ts/js files using dynamic import.
 * The sidecar runs under tsx, so TypeScript files are supported natively.
 *
 * Adapted from packages/cli/src/utils/schema-loader.ts with sidecar-specific
 * simplifications (no tsx installation hints — tsx is always available).
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { LoadedSchema as BaseLoadedSchema, DbCasing } from '@dbsp/types';
import { isValidSchema } from '@dbsp/types';

/** Schema modules may export the database naming convention alongside `schema()`. */
export interface LoadedSchema extends BaseLoadedSchema {
	readonly dbCasing?: DbCasing;
}

/**
 * Default schema file names to search for, in priority order.
 */
const DEFAULT_SCHEMA_FILES = [
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
 * Find a schema file in the given directory.
 *
 * @param cwd - Directory to search in
 * @returns Absolute path to the schema file, or null if not found
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
 * ARCH-005: Only accepts schema() results.
 *
 * @param schemaPath - Absolute or relative path to the schema file
 * @returns The loaded schema with definition, ModelIR, and table names
 * @throws SchemaLoadError if the file is not found or has invalid format
 */
export async function loadSchema(schemaPath: string): Promise<LoadedSchema> {
	const resolvedPath = resolve(schemaPath);

	if (!existsSync(resolvedPath)) {
		throw new SchemaLoadError(`Schema file not found: ${resolvedPath}`);
	}

	try {
		const fileUrl = pathToFileURL(resolvedPath).href;
		const module = await import(fileUrl);

		// Look for schema export (named 'schema' or default)
		const schema = module.schema ?? module.default;

		if (!schema) {
			throw new SchemaLoadError(
				`Schema file must export 'schema' or default export: ${resolvedPath}`,
			);
		}

		if (!isValidSchema(schema)) {
			throw new SchemaLoadError(
				`Invalid schema format in ${resolvedPath}. ` +
					`Use schema() from @dbsp/core to create schemas.`,
			);
		}

		const dbCasing = readDbCasingExport(module.dbCasing, resolvedPath);
		return dbCasing === undefined
			? (schema as LoadedSchema)
			: { ...schema, dbCasing };
	} catch (error) {
		if (error instanceof SchemaLoadError) throw error;
		const message = error instanceof Error ? error.message : String(error);
		throw new SchemaLoadError(`Failed to load schema: ${message}`);
	}
}

function readDbCasingExport(
	value: unknown,
	resolvedPath: string,
): DbCasing | undefined {
	if (value === undefined) return undefined;
	if (value === 'snake_case' || value === 'camelCase' || value === 'preserve') {
		return value;
	}
	throw new SchemaLoadError(
		`Invalid dbCasing export in ${resolvedPath}. Expected 'snake_case', 'camelCase', or 'preserve'.`,
	);
}
