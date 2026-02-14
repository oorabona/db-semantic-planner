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
import type { ModelIR } from '@dbsp/types';

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
 * ARCH-005: Only accepts new schema() format, not legacy defineSchema().
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

		return schema;
	} catch (error) {
		if (error instanceof SchemaLoadError) throw error;
		const message = error instanceof Error ? error.message : String(error);
		throw new SchemaLoadError(`Failed to load schema: ${message}`);
	}
}
