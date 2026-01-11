/**
 * ARCH-002 Block 1: defineSchema()
 *
 * Main entry point for defining the schema Source of Truth.
 * Merges explicit definitions with convention-inferred relations.
 */

import { DEFAULT_CONVENTIONS, inferRelations } from './conventions.js';
import type {
	ConventionsDefinition,
	HintsDefinition,
	RelationsDefinition,
	ResolvedSchema,
	SchemaConfigInput,
	SchemaDefinitionInput,
	TablesDefinition,
} from './types.js';

let deprecationWarned = false;

/**
 * Define a schema with tables, relations, hints, and conventions.
 *
 * @example
 * ```typescript
 * const schema = defineSchema({
 *   tables: {
 *     users: {
 *       id: { type: 'uuid', primaryKey: true },
 *       name: { type: 'string', nullable: false },
 *     },
 *     posts: {
 *       id: { type: 'uuid', primaryKey: true },
 *       authorId: { type: 'uuid', references: { table: 'users' } },
 *     },
 *   },
 *   relations: {
 *     'posts.author': { kind: 'belongsTo', target: 'users', foreignKey: 'authorId' },
 *   },
 * });
 * ```
 */
/**
 * Define a schema with tables, relations, hints, and conventions.
 *
 * @example New API (recommended)
 * ```typescript
 * // Simple - just tables
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
 *
 * // With config
 * const schema = defineSchema(
 *   {
 *     users: { id: { type: 'uuid', primaryKey: true } },
 *     roles: { id: { type: 'uuid', primaryKey: true } },
 *   },
 *   {
 *     relations: [...]
 *   }
 * );
 * ```
 *
 * @example Legacy API (deprecated)
 * ```typescript
 * const schema = defineSchema({
 *   tables: {
 *     users: { id: { type: 'uuid', primaryKey: true } },
 *   },
 *   relations: {...},
 * });
 * ```
 */
export function defineSchema<T extends TablesDefinition>(
	tables: T,
	config?: SchemaConfigInput,
): ResolvedSchema<T>;
/**
 * @deprecated Use defineSchema(tables, config?) instead
 */
export function defineSchema<T extends TablesDefinition>(
	input: SchemaDefinitionInput<T>,
): ResolvedSchema<T>;
export function defineSchema<T extends TablesDefinition>(
	tablesOrInput: T | SchemaDefinitionInput<T>,
	config?: SchemaConfigInput,
): ResolvedSchema<T> {
	let tables: T;
	let relations: RelationsDefinition;
	let hints: HintsDefinition;
	let conventions: ConventionsDefinition;

	// Detect legacy format: { tables: {...} }
	if (isLegacyFormat(tablesOrInput)) {
		if (!deprecationWarned) {
			console.warn(
				'[db-semantic-planner] defineSchema({ tables: {...} }) is deprecated. ' +
					'Use defineSchema(tables, config?) instead.',
			);
			deprecationWarned = true;
		}
		const input = tablesOrInput as SchemaDefinitionInput<T>;
		tables = input.tables;
		relations = input.relations ?? {};
		hints = input.hints ?? {};
		conventions = input.conventions ?? {};
	} else {
		// New format: tables as first arg, config as second
		tables = tablesOrInput as T;
		relations = config?.relations ?? {};
		hints = config?.hints ?? {};
		conventions = config?.conventions ?? {};
	}

	// Merge user conventions with defaults
	const resolvedConventions: Required<ConventionsDefinition> = {
		...DEFAULT_CONVENTIONS,
		...conventions,
	};

	// Infer relations from table definitions + merge with explicit
	const allRelations = inferRelations(tables, resolvedConventions, relations);

	// Validate explicit relations reference existing tables
	validateRelations(tables, relations);

	// Validate hints reference existing relations
	validateHints(allRelations, hints);

	return {
		tables,
		relations: allRelations,
		hints,
		conventions: resolvedConventions,
	};
}

/**
 * Detect legacy format by checking if input has a 'tables' property
 * that looks like a TablesDefinition (contains objects with column definitions).
 */
function isLegacyFormat<T extends TablesDefinition>(
	input: T | SchemaDefinitionInput<T>,
): input is SchemaDefinitionInput<T> {
	if (!('tables' in input)) {
		return false;
	}

	// If other legacy-only keys exist alongside 'tables', it's definitely legacy
	if ('relations' in input || 'hints' in input || 'conventions' in input) {
		return true;
	}

	const tables = (input as SchemaDefinitionInput<T>).tables;
	if (typeof tables !== 'object' || tables === null) {
		return false;
	}

	// Check the structure of what's inside 'tables':
	// - Legacy: { tables: { users: { id: { type: 'uuid' } } } } - children are table defs
	// - New with table named "tables": { tables: { id: { type: 'uuid' } } } - children are column defs
	//
	// Heuristic: if direct children of 'tables' have 'type' property, it's a column def,
	// meaning 'tables' is actually a table name in new format (not legacy wrapper)
	for (const key of Object.keys(tables)) {
		const value = tables[key];
		if (typeof value === 'object' && value !== null && 'type' in value) {
			// Direct child has 'type' - this means 'tables' is a table name, not a wrapper
			// So this is NEW format, not legacy
			return false;
		}
	}

	// Children don't have 'type' directly, so they must be table definitions
	// Check if any table has columns with 'type' to confirm legacy format
	for (const tableKey of Object.keys(tables)) {
		const table = tables[tableKey];
		if (typeof table !== 'object' || table === null) {
			continue;
		}
		for (const colKey of Object.keys(table)) {
			const col = table[colKey];
			if (typeof col === 'object' && col !== null && 'type' in col) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Validate that explicit relations reference existing tables.
 */
function validateRelations(
	tables: TablesDefinition,
	relations: RelationsDefinition,
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
	relations: RelationsDefinition,
	hints: HintsDefinition,
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
 * Error thrown when schema validation fails.
 */
export class SchemaValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SchemaValidationError';
	}
}
