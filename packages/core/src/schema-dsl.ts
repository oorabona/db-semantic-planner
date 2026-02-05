/**
 * Schema DSL - defineSchema() function
 *
 * Main entry point for defining the schema Source of Truth.
 * Merges explicit definitions with convention-inferred relations.
 *
 * Migrated from @dbsp/schema/define.ts as part of ARCH-003.
 */

import {
	DEFAULT_CONVENTIONS,
	inferRelationsFromSchema,
} from './conventions.js';
import type {
	ResolvedSchema,
	SchemaConfigInput,
	SchemaConventionsDefinition,
	SchemaDefaultFilters,
	SchemaHintsDefinition,
	SchemaIndexesDefinition,
	SchemaRelationsDefinition,
	SchemaTablesDefinition,
} from './schema-dsl-types.js';

/**
 * Define a schema with tables, relations, hints, and conventions.
 *
 * @example Simple - just tables
 * ```typescript
 * const schema = defineSchema({
 *   users: {
 *     id: { type: 'uuid', primaryKey: true },
 *     name: { type: 'string', nullable: false },
 *   },
 *   posts: {
 *     id: { type: 'uuid', primaryKey: true },
 *     authorId: { type: 'uuid', references: { table: 'users' } },
 *   },
 * });
 * ```
 *
 * @example With config
 * ```typescript
 * const schema = defineSchema(
 *   {
 *     users: { id: { type: 'uuid', primaryKey: true } },
 *     roles: { id: { type: 'uuid', primaryKey: true } },
 *   },
 *   {
 *     relations: {...}
 *   }
 * );
 * ```
 */
export function defineSchema<T extends SchemaTablesDefinition>(
	tables: T,
	config?: SchemaConfigInput,
): ResolvedSchema<T> {
	const relations: SchemaRelationsDefinition = config?.relations ?? {};
	const hints: SchemaHintsDefinition = config?.hints ?? {};
	const conventions: SchemaConventionsDefinition = config?.conventions ?? {};
	const indexes: SchemaIndexesDefinition = config?.indexes ?? {};
	const defaultFilters: SchemaDefaultFilters = config?.defaultFilters ?? {};

	// Merge user conventions with defaults
	const resolvedConventions: Required<SchemaConventionsDefinition> = {
		...DEFAULT_CONVENTIONS,
		...conventions,
	};

	// Infer relations from table definitions + merge with explicit
	const allRelations = inferRelationsFromSchema(
		tables,
		resolvedConventions,
		relations,
	);

	// Validate explicit relations reference existing tables
	validateRelations(tables, relations);

	// Validate hints reference existing relations
	validateHints(allRelations, hints);

	// Validate default filters reference existing tables
	validateDefaultFilters(tables, defaultFilters);

	return {
		tables,
		relations: allRelations,
		hints,
		conventions: resolvedConventions,
		indexes,
		defaultFilters,
	};
}

/**
 * Validate that explicit relations reference existing tables.
 */
function validateRelations(
	tables: SchemaTablesDefinition,
	relations: SchemaRelationsDefinition,
): void {
	const tableNames = new Set(Object.keys(tables));

	for (const [key, rel] of Object.entries(relations)) {
		const sourceTable = key.split('.')[0] ?? key;

		if (!tableNames.has(sourceTable)) {
			throw new SchemaValidationError(
				`Relation '${key}' references non-existent source table '${sourceTable}'`,
			);
		}

		if (!tableNames.has(rel.target)) {
			throw new SchemaValidationError(
				`Relation '${key}' references non-existent target table '${rel.target}'`,
			);
		}

		if (rel.kind === 'manyToMany' && !tableNames.has(rel.through)) {
			throw new SchemaValidationError(
				`Relation '${key}' references non-existent junction table '${rel.through}'`,
			);
		}
	}
}

/**
 * Validate that hints reference existing relation paths.
 */
function validateHints(
	relations: SchemaRelationsDefinition,
	hints: SchemaHintsDefinition,
): void {
	for (const path of Object.keys(hints)) {
		if (!(path in relations)) {
			throw new SchemaValidationError(
				`Hint path '${path}' does not match any relation. ` +
					`Available: ${Object.keys(relations).join(', ')}`,
			);
		}
	}
}

/**
 * Validate that default filters reference existing tables.
 */
function validateDefaultFilters(
	tables: SchemaTablesDefinition,
	defaultFilters: SchemaDefaultFilters,
): void {
	const tableNames = new Set(Object.keys(tables));

	for (const tableName of Object.keys(defaultFilters)) {
		if (!tableNames.has(tableName)) {
			throw new SchemaValidationError(
				`Default filter for non-existent table '${tableName}'. ` +
					`Available: ${[...tableNames].join(', ')}`,
			);
		}
	}
}

/**
 * Error thrown when schema validation fails.
 */
export class SchemaValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SchemaValidationError';
	}
}
