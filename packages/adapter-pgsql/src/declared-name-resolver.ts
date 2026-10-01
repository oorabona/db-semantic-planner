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

function requireResolver(
	resolver: DeclaredNameResolver | undefined,
): DeclaredNameResolver {
	if (resolver === undefined) {
		throw new Error(
			'Declared SQL identifiers require a physical-name resolver.',
		);
	}
	return resolver;
}

/** Resolve a declared table; absence is never a casing fallback. */
export function declaredTableName(
	resolver: DeclaredNameResolver | undefined,
	table: string,
): string {
	const physical = requireResolver(resolver).table(table);
	if (physical === undefined) {
		throw new Error(
			`Declared table '${table}' is absent from the physical model.`,
		);
	}
	return physical;
}

/** Resolve a declared column; absence is never a casing fallback. */
export function declaredColumnName(
	resolver: DeclaredNameResolver | undefined,
	table: string,
	column: string,
): string {
	const physical = requireResolver(resolver).column(table, column);
	if (physical === undefined) {
		throw new Error(
			`Declared column '${table}.${column}' is absent from the physical model.`,
		);
	}
	return physical;
}

/**
 * Cross a declared logical address into the physical inventory.  The absence of
 * an authority is the deliberately supported `dbCasing: 'preserve'` model-less
 * compatibility mode, where the logical spelling is already the SQL spelling.
 * Once an authority exists, a missing address is an error rather than a
 * casing-based fallback.
 */
type PerModelPhysicalCache = Map<string, PgPhysicalModel>;
const physicalModels = new WeakMap<ModelIR, PerModelPhysicalCache>();
const declaredResolvers = new WeakMap<PgPhysicalModel, DeclaredNameResolver>();

/**
 * Cache physical models by logical-model identity, effective schema and
 * db-casing. Module scope is intentional:
 * withSchema() constructs a sibling adapter and must reuse the same cache.
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
