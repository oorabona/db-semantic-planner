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
	/** Legacy call sites without an address: declared inventory entries win; local SQL names remain verbatim. */
	resolve(name: string): string;
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

export function createDeclaredNameResolver(
	physicalModel: PgPhysicalModel,
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
		uniqueIndex: (name: string) => {
			const matches = inventory.entries.filter(
				(entry) =>
					entry.logical.kind === 'index' && entry.logical.name === name,
			);
			return matches.length === 1 ? matches[0]!.physical : undefined;
		},
		resolve: (name: string) => {
			const match = inventory.entries.find(
				(entry) => entry.logical.name === name,
			);
			return match?.physical ?? name;
		},
	});
}
