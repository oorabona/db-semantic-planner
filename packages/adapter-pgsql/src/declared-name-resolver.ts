/**
 * Declared-name authority for query compilation.
 *
 * The planner continues to speak logical ModelIR names.  This adapter-side
 * resolver is the one place that crosses to the physical vocabulary produced
 * by createPgPhysicalModel().  Names which are not declared model objects are
 * deliberately left to the caller: they are query-local SQL identifiers.
 */
import type { ModelIR } from '@dbsp/types';
import type { NamingPlugin } from './naming-plugin.js';
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
	/** Compatibility bridge for legacy compiler paths while they are migrated. */
	toDatabase(name: string): string;
}

type PerModelPhysicalCache = Map<string, PgPhysicalModel>;
const physicalModels = new WeakMap<ModelIR, PerModelPhysicalCache>();

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

/** Some legacy compile-only tests provide deliberately partial ModelIR-like
 * objects for type inference. They are not a logical model that the physical
 * model can inventory; retain the historical naming path for those fixtures. */
export function canCreatePgPhysicalModel(model: ModelIR): boolean {
	if (!(model.tables instanceof Map)) return false;
	for (const table of model.tables.values()) {
		if (
			!Array.isArray(table.columns) ||
			(table.primaryKey !== undefined &&
				typeof table.primaryKey !== 'string' &&
				!Array.isArray(table.primaryKey)) ||
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
	fallbackNaming: NamingPlugin,
): DeclaredNameResolver {
	const { inventory } = physicalModel;
	const schema = physicalModel.schema;
	const get = (
		address: Parameters<typeof inventory.get>[0],
	): string | undefined =>
		inventory.has(address) ? inventory.get(address) : undefined;

	return Object.freeze({
		physicalModel,
		table: (name: string) => get({ kind: 'table', schema, name }),
		column: (table: string, name: string) =>
			get({ kind: 'column', schema, table, name }),
		index: (table: string, name: string) =>
			get({ kind: 'index', schema, table, name }),
		constraint: (table: string, name: string) =>
			get({ kind: 'constraint', schema, table, name }),
		enum: (name: string) => get({ kind: 'enum', schema, name }),
		// Older call sites do not carry a table address yet.  The physical model
		// uses the same db-casing/truncation rule for declared table/column names;
		// use a matching inventory entry before preserving historical fallback.
		toDatabase: (name: string) => {
			for (const entry of inventory.entries) {
				if (entry.logical.name === name) return entry.physical;
			}
			return fallbackNaming.toDatabase(name);
		},
	});
}
