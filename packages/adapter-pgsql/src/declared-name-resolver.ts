/**
 * Declared-name authority for query compilation.
 *
 * The planner continues to speak logical ModelIR names.  This adapter-side
 * resolver is the one place that crosses to the physical vocabulary produced
 * by createPgPhysicalModel().  Names which are not declared model objects are
 * deliberately left to the caller: they are query-local SQL identifiers.
 */
import type { ModelIR } from '@dbsp/types';
import {
	createPgPhysicalModel,
	type PgPhysicalModel,
} from './physical-model/index.js';

export interface DeclaredNameResolver {
	readonly physicalModel: PgPhysicalModel;
	table(name: string): string | undefined;
	column(table: string, name: string): string | undefined;
	index(table: string, name: string): string | undefined;
	constraint(table: string, name: string): string | undefined;
	enum(name: string): string | undefined;
	/** Resolve an index only when its logical name is unique across the model. */
	uniqueIndex(name: string): string | undefined;
}

type PerModelPhysicalCache = Map<string, PgPhysicalModel>;
const physicalModels = new WeakMap<ModelIR, PerModelPhysicalCache>();
const declaredResolvers = new WeakMap<PgPhysicalModel, DeclaredNameResolver>();

/**
 * Cache physical models by logical-model identity, effective schema and
 * db-casing. Module scope is intentional: withSchema() constructs a sibling
 * adapter and must reuse the same cache.
 */
export function getCachedPgPhysicalModel(
	model: ModelIR,
	schema: string,
	dbCasing: import('@dbsp/types').DbCasing,
): PgPhysicalModel {
	let byKey = physicalModels.get(model);
	if (byKey === undefined) {
		byKey = new Map();
		physicalModels.set(model, byKey);
	}
	const key = `${schema}\u0000${dbCasing}`;
	const cached = byKey.get(key);
	if (cached !== undefined) return cached;
	const physical = createPgPhysicalModel({
		mode: 'logical',
		model,
		schema,
		dbCasing,
	});
	byKey.set(key, physical);
	return physical;
}

/**
 * Some direct adapter tests use partial ModelIR-shaped fixtures solely for
 * relation/type inference. They are not a complete declared inventory, so
 * preserve the legacy naming-only path rather than treating a partial fixture
 * as an authority. Normal schema()/ModelIR instances always take the
 * fail-closed physical-model path.
 */
export function canCreatePgPhysicalModel(model: ModelIR): boolean {
	if (!(model.tables instanceof Map) || model.tables.size === 0) return false;
	for (const table of model.tables.values()) {
		if (
			table.primaryKey !== undefined &&
			typeof table.primaryKey !== 'string' &&
			!Array.isArray(table.primaryKey)
		) {
			return true;
		}
	}
	if (
		typeof (model as { getRelationsFrom?: unknown }).getRelationsFrom !==
			'function' ||
		typeof (model as { isAmbiguous?: unknown }).isAmbiguous !== 'function'
	) {
		return false;
	}
	for (const [key, table] of model.tables) {
		if (
			key !== table.name ||
			!Array.isArray(table.columns) ||
			!Array.isArray(table.foreignKeys) ||
			!Array.isArray(table.indexes) ||
			(table.checkConstraints !== undefined &&
				!Array.isArray(table.checkConstraints)) ||
			(table.pseudoColumns !== undefined &&
				!Array.isArray(table.pseudoColumns)) ||
			(table.policies !== undefined && !Array.isArray(table.policies))
		) {
			return false;
		}
	}
	return true;
}

export function createDeclaredNameResolver(
	physicalModel: PgPhysicalModel,
): DeclaredNameResolver {
	const cached = declaredResolvers.get(physicalModel);
	if (cached !== undefined) return cached;
	const { inventory } = physicalModel;
	const schema = physicalModel.schema;
	// DDL helper lookup permits a logical index name only when it is unique
	// across the model. Build that reverse lookup once with the cached physical
	// model rather than scanning the inventory for every helper call.
	const uniqueIndexes = new Map<string, string | undefined>();
	for (const entry of inventory.entries) {
		if (entry.logical.kind !== 'index') continue;
		const seen = uniqueIndexes.has(entry.logical.name);
		uniqueIndexes.set(entry.logical.name, seen ? undefined : entry.physical);
	}
	const get = (
		address: Parameters<typeof inventory.get>[0],
	): string | undefined =>
		inventory.has(address) ? inventory.get(address) : undefined;

	const resolver = Object.freeze({
		physicalModel,
		table: (name: string) => get({ kind: 'table', schema, name }),
		column: (table: string, name: string) =>
			get({ kind: 'column', schema, table, name }),
		index: (table: string, name: string) =>
			get({ kind: 'index', schema, table, name }),
		constraint: (table: string, name: string) =>
			get({ kind: 'constraint', schema, table, name }),
		enum: (name: string) => get({ kind: 'enum', schema, name }),
		uniqueIndex: (name: string) => uniqueIndexes.get(name),
	});
	declaredResolvers.set(physicalModel, resolver);
	return resolver;
}
