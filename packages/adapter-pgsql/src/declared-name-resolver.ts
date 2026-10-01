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
	/** Restores the declared logical column key for one emitted physical column. */
	logicalColumn(table: string, physicalName: string): string | undefined;
	index(table: string, name: string): string | undefined;
	constraint(table: string, name: string): string | undefined;
	enum(name: string): string | undefined;
	/** Resolve an index only when its logical name is unique across the model. */
	uniqueIndex(name: string): string | undefined;
}

/**
 * Cross a declared logical address into the physical inventory.  The absence of
 * an authority is the deliberately supported `dbCasing: 'preserve'` model-less
 * compatibility mode, where the logical spelling is already the SQL spelling.
 * Once an authority exists, a missing address is an error rather than a
 * casing-based fallback.
 */
export function declaredTableName(
	declaredNames: DeclaredNameResolver | undefined,
	table: string,
): string {
	if (declaredNames === undefined) return table;
	const physical = declaredNames.table(table);
	if (physical !== undefined) return physical;
	throw new Error(
		`Declared table '${table}' is absent from the physical model.`,
	);
}

export function declaredColumnName(
	declaredNames: DeclaredNameResolver | undefined,
	table: string,
	column: string,
): string {
	if (declaredNames === undefined) return column;
	const physical = declaredNames.column(table, column);
	if (physical !== undefined) return physical;
	throw new Error(
		`Declared column '${table}.${column}' is absent from the physical model.`,
	);
}

/** Recover a declared logical key from a returned physical column label. */
export function declaredLogicalColumnName(
	declaredNames: DeclaredNameResolver | undefined,
	table: string,
	physicalColumn: string,
): string {
	if (declaredNames === undefined) return physicalColumn;
	const logical = declaredNames.logicalColumn(table, physicalColumn);
	if (logical !== undefined) return logical;
	throw new Error(
		`Physical column '${table}.${physicalColumn}' is absent from the declared model.`,
	);
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
	const logicalColumns = new Map<string, string>();
	for (const entry of inventory.entries) {
		if (entry.logical.kind !== 'index') continue;
		const seen = uniqueIndexes.has(entry.logical.name);
		uniqueIndexes.set(entry.logical.name, seen ? undefined : entry.physical);
	}
	for (const entry of inventory.entries) {
		if (entry.logical.kind !== 'column') continue;
		logicalColumns.set(
			`${entry.logical.table}\u0000${entry.physical}`,
			entry.logical.name,
		);
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
		logicalColumn: (table: string, physicalName: string) =>
			logicalColumns.get(`${table}\u0000${physicalName}`),
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
