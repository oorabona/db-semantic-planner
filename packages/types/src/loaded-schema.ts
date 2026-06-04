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
	readonly tableNames: readonly string[];
}

/**
 * Runtime type guard for `LoadedSchema` — verifies the object has
 * `definition`, `model` (with nested `tables` + `relations`), and
 * `tableNames` as an array. Structural check only — does not validate
 * the inner values of any field.
 *
 * Type guard for ARCH-005 schema() output.
 */
export function isValidSchema(schema: unknown): schema is LoadedSchema {
	if (
		typeof schema !== 'object' ||
		schema === null ||
		!('model' in schema) ||
		!('definition' in schema) ||
		!('tableNames' in schema)
	) {
		return false;
	}
	const s = schema as LoadedSchema;
	if (typeof s.model !== 'object' || s.model === null) return false;
	if (!('tables' in s.model) || !('relations' in s.model)) return false;
	if (!Array.isArray(s.tableNames)) return false;
	// Validate required ModelIR methods are present
	if (typeof s.model.getTable !== 'function') return false;
	if (typeof s.model.getRelation !== 'function') return false;
	if (typeof s.model.getRelationsFrom !== 'function') return false;
	if (typeof s.model.getRelationsTo !== 'function') return false;
	if (typeof s.model.isAmbiguous !== 'function') return false;
	return true;
}
