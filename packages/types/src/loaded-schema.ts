import type { ModelIR } from './model-ir.js';

/**
 * Canonical shape of a `schema()` factory result as produced by
 * `createOrm({schema: ...})` callers and consumed by tooling
 * (cli, gui sidecar, mcp-server).
 *
 * ARCH-005: Schema type from schema() function.
 * Contains the definition, pre-computed ModelIR, and table names.
 */
export interface LoadedSchema {
	readonly definition: Record<string, unknown>;
	readonly model: ModelIR;
	readonly tableNames: string[];
}

/**
 * Runtime type guard for `LoadedSchema` — verifies the object
 * has `definition`, `model`, `model.tables`, and `model.relations`.
 * Structural check only — does not validate inner values.
 *
 * Type guard for ARCH-005 schema() output.
 */
export function isValidSchema(schema: unknown): schema is LoadedSchema {
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
