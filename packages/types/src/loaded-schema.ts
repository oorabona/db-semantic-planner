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

function isMap(value: unknown): value is Map<unknown, unknown> {
	if (typeof value !== 'object' || value === null) return false;
	try {
		Map.prototype.has.call(value, undefined);
		return true;
	} catch {
		return false;
	}
}

/**
 * Runtime type guard for a `schema()` result. Checks the shapes, not just the
 * key names: the model's `tables` and `relations` must be real Maps and its
 * methods real functions, `definition` an object, and `tableNames` an array of
 * strings. Callers load these from disk and then call `.get()` / `.entries()`
 * on the model, so an object that merely has the right keys must not pass.
 *
 * It does not validate the schema's contents — only that this is a `schema()`
 * result rather than an arbitrary object.
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
	if (!isMap(s.model.tables)) return false;
	if (!isMap(s.model.relations)) return false;
	if (typeof s.definition !== 'object' || s.definition === null) return false;
	if (!Array.isArray(s.tableNames)) return false;
	if (s.tableNames.some((name) => typeof name !== 'string')) return false;
	// Validate required ModelIR methods are present
	if (typeof s.model.getTable !== 'function') return false;
	if (typeof s.model.getRelation !== 'function') return false;
	if (typeof s.model.getRelationsFrom !== 'function') return false;
	if (typeof s.model.getRelationsTo !== 'function') return false;
	if (typeof s.model.isAmbiguous !== 'function') return false;
	return true;
}
