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
	SchemaDefinitionInput,
	TablesDefinition,
} from './types.js';

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
export function defineSchema<T extends TablesDefinition>(
	input: SchemaDefinitionInput<T>,
): ResolvedSchema<T> {
	const { tables, relations = {}, hints = {}, conventions = {} } = input;

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
