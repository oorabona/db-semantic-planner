/**
 * DX-023: Lightweight ModelIR Definition
 *
 * Provides a simplified API for defining relations when using Kysely's Database type.
 * Instead of verbose column definitions, developers can focus solely on relations
 * using shorthand syntax with automatic FK inference.
 *
 * @example
 * ```typescript
 * import { defineModel } from '@db-semantic-planner/core';
 *
 * interface Database {
 *   users: { id: number; name: string; };
 *   posts: { id: number; user_id: number; title: string; };
 * }
 *
 * const model = defineModel<Database>({
 *   relations: {
 *     'users.posts': '1:N',
 *     'posts.author': ['N:1', 'users'],
 *   },
 * });
 * ```
 */

import type {
	Cardinality as ModelCardinality,
	ModelIR,
	Optionality,
	RelationIR,
	RelationType,
	TableIR,
} from '../index.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Cardinality shorthand notation.
 *
 * | Shorthand | Relation Type | Source Side | Target Side |
 * |-----------|---------------|-------------|-------------|
 * | `'1:N'`   | hasMany       | one         | many        |
 * | `'N:1'`   | belongsTo     | many        | one         |
 * | `'1:1'`   | hasOne        | one         | one         |
 * | `'M:N'`   | belongsToMany | many        | many        |
 */
export type CardinalityShorthand = '1:N' | 'N:1' | '1:1' | 'M:N';

/**
 * Object form for relation definition with full control.
 */
export interface RelationObjectDef {
	/** Cardinality shorthand */
	readonly cardinality: CardinalityShorthand;
	/** Explicit foreign key column(s) */
	readonly fk?: string | readonly string[];
	/** Explicit target table (if different from inferred) */
	readonly target?: string;
	/** Junction table for M:N relations */
	readonly through?: string;
}

/**
 * Tuple form for relation definition: [cardinality, target]
 */
export type RelationTupleDef = readonly [CardinalityShorthand, string];

/**
 * All supported forms for relation definition.
 *
 * - **Simple:** `'1:N'` - target inferred from relation name
 * - **Tuple:** `['N:1', 'users']` - explicit target
 * - **Object:** `{ cardinality: '1:N', fk: 'order_uuid' }` - full control
 */
export type RelationShorthand =
	| CardinalityShorthand
	| RelationTupleDef
	| RelationObjectDef;

/**
 * Relation key format: `'sourceTable.relationName'`
 */
export type RelationKey<DB> =
	DB extends Record<string, unknown>
		? `${Extract<keyof DB, string>}.${string}`
		: string;

/**
 * Lightweight relations definition with type-safe keys.
 */
export type LightweightRelationsDef<DB> = {
	readonly [K in RelationKey<DB>]?: RelationShorthand;
};

/**
 * Options for defineModel function.
 */
export interface DefineModelOptions<DB> {
	/** Relation definitions using shorthand syntax */
	readonly relations: LightweightRelationsDef<DB>;
}

// ============================================================================
// Errors
// ============================================================================

/**
 * Error thrown when a relation definition is invalid.
 *
 * @example
 * ```typescript
 * defineModel<DB>({ relations: { 'users.posts': '2:N' } });
 * // Throws: InvalidRelationDefinitionError: Invalid cardinality '2:N'
 * ```
 */
export class InvalidRelationDefinitionError extends Error {
	override readonly name = 'InvalidRelationDefinitionError' as const;

	/** The relation key that caused the error */
	readonly relationKey: string;

	/** Specific reason for the error */
	readonly reason: string;

	/** Suggested fix, if available */
	readonly suggestion?: string;

	constructor(opts: {
		relationKey: string;
		reason: string;
		suggestion?: string;
	}) {
		let message = `Invalid relation definition for '${opts.relationKey}': ${opts.reason}`;
		if (opts.suggestion) {
			message += `\n\nSuggestion: ${opts.suggestion}`;
		}

		super(message);
		this.relationKey = opts.relationKey;
		this.reason = opts.reason;
		if (opts.suggestion) {
			this.suggestion = opts.suggestion;
		}

		Object.setPrototypeOf(this, InvalidRelationDefinitionError.prototype);
	}
}

// ============================================================================
// Parsing
// ============================================================================

/**
 * Valid cardinality values.
 */
const VALID_CARDINALITIES = new Set<string>(['1:N', 'N:1', '1:1', 'M:N']);

/**
 * Maps cardinality shorthand to relation type.
 */
const CARDINALITY_TO_TYPE: Record<CardinalityShorthand, RelationType> = {
	'1:N': 'hasMany',
	'N:1': 'belongsTo',
	'1:1': 'hasOne',
	'M:N': 'belongsToMany',
};

/**
 * Maps cardinality shorthand to ModelIR cardinality.
 * ModelIR uses 'one' or 'many' to describe the target side cardinality.
 */
const CARDINALITY_TO_MODEL: Record<CardinalityShorthand, ModelCardinality> = {
	'1:N': 'many', // Target side is many
	'N:1': 'one', // Target side is one
	'1:1': 'one', // Target side is one
	'M:N': 'many', // Target side is many
};

/**
 * Type guard for CardinalityShorthand.
 */
export function isCardinalityShorthand(
	value: unknown,
): value is CardinalityShorthand {
	return typeof value === 'string' && VALID_CARDINALITIES.has(value);
}

/**
 * Type guard for RelationTupleDef.
 */
export function isRelationTupleDef(value: unknown): value is RelationTupleDef {
	return (
		Array.isArray(value) &&
		value.length === 2 &&
		isCardinalityShorthand(value[0]) &&
		typeof value[1] === 'string'
	);
}

/**
 * Type guard for RelationObjectDef.
 */
export function isRelationObjectDef(
	value: unknown,
): value is RelationObjectDef {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}
	const obj = value as Record<string, unknown>;
	return isCardinalityShorthand(obj.cardinality);
}

/**
 * Parsed relation key information.
 */
export interface ParsedRelationKey {
	readonly sourceTable: string;
	readonly relationName: string;
}

/**
 * Parses a relation key into source table and relation name.
 *
 * @param key - The relation key in format 'sourceTable.relationName'
 * @returns Parsed key components
 * @throws InvalidRelationDefinitionError if key format is invalid
 */
export function parseRelationKey(key: string): ParsedRelationKey {
	const dotIndex = key.indexOf('.');
	if (dotIndex === -1 || dotIndex === 0 || dotIndex === key.length - 1) {
		throw new InvalidRelationDefinitionError({
			relationKey: key,
			reason: "Invalid key format. Expected 'sourceTable.relationName'",
			suggestion: "Use format like 'users.posts' or 'posts.author'",
		});
	}

	return {
		sourceTable: key.slice(0, dotIndex),
		relationName: key.slice(dotIndex + 1),
	};
}

/**
 * Parsed relation definition.
 */
export interface ParsedRelationDef {
	readonly cardinality: CardinalityShorthand;
	readonly relationType: RelationType;
	readonly modelCardinality: ModelCardinality;
	readonly target: string | undefined;
	readonly fk: string | readonly string[] | undefined;
	readonly through: string | undefined;
}

/**
 * Parses a relation shorthand value into its components.
 *
 * @param key - The relation key for error messages
 * @param value - The relation shorthand value
 * @returns Parsed relation definition
 * @throws InvalidRelationDefinitionError if value is invalid
 */
export function parseRelationDef(
	key: string,
	value: RelationShorthand,
): ParsedRelationDef {
	// Form 1: Simple shorthand - '1:N'
	if (isCardinalityShorthand(value)) {
		return {
			cardinality: value,
			relationType: CARDINALITY_TO_TYPE[value],
			modelCardinality: CARDINALITY_TO_MODEL[value],
			target: undefined,
			fk: undefined,
			through: undefined,
		};
	}

	// Form 2: Tuple - ['N:1', 'users']
	if (isRelationTupleDef(value)) {
		const [cardinality, target] = value;
		return {
			cardinality,
			relationType: CARDINALITY_TO_TYPE[cardinality],
			modelCardinality: CARDINALITY_TO_MODEL[cardinality],
			target,
			fk: undefined,
			through: undefined,
		};
	}

	// Form 3: Object - { cardinality: '1:N', fk: 'order_uuid' }
	if (isRelationObjectDef(value)) {
		const { cardinality, fk, target, through } = value;
		return {
			cardinality,
			relationType: CARDINALITY_TO_TYPE[cardinality],
			modelCardinality: CARDINALITY_TO_MODEL[cardinality],
			target,
			fk,
			through,
		};
	}

	// Invalid format
	const valueStr =
		typeof value === 'object' ? JSON.stringify(value) : String(value);
	throw new InvalidRelationDefinitionError({
		relationKey: key,
		reason: `Invalid relation definition format: ${valueStr}`,
		suggestion:
			"Use one of: '1:N', ['N:1', 'targetTable'], or { cardinality: '1:N', fk: 'column' }",
	});
}

// ============================================================================
// FK Inference
// ============================================================================

/**
 * Irregular plural → singular mappings.
 * For MVP, we only handle common cases.
 */
const IRREGULAR_PLURALS: Record<string, string> = {
	people: 'person',
	children: 'child',
	men: 'man',
	women: 'woman',
	teeth: 'tooth',
	feet: 'foot',
	geese: 'goose',
	mice: 'mouse',
	data: 'datum',
	media: 'medium',
	criteria: 'criterion',
	phenomena: 'phenomenon',
};

/**
 * Singularizes a table name using simple rules.
 *
 * Rules:
 * 1. Check irregular plurals first
 * 2. 'ies' → 'y' (categories → category)
 * 3. 's' → '' (users → user)
 *
 * @param tableName - The table name to singularize
 * @returns Singularized form
 */
export function singularize(tableName: string): string {
	const lower = tableName.toLowerCase();

	// Check irregular plurals
	const irregular = IRREGULAR_PLURALS[lower];
	if (irregular !== undefined) {
		// Preserve original case pattern
		if (tableName[0]?.toUpperCase() === tableName[0]) {
			return irregular.charAt(0).toUpperCase() + irregular.slice(1);
		}
		return irregular;
	}

	// Handle 'ies' → 'y'
	if (lower.endsWith('ies') && tableName.length > 3) {
		return `${tableName.slice(0, -3)}y`;
	}

	// Handle regular plurals ending in 's'
	if (lower.endsWith('s') && !lower.endsWith('ss') && tableName.length > 1) {
		return tableName.slice(0, -1);
	}

	// Already singular or unknown pattern
	return tableName;
}

/**
 * Infers the foreign key column name based on convention.
 *
 * Convention: `{singular_table_name}_id`
 *
 * For hasMany/hasOne (1:N, 1:1): FK is on target table, named after source
 * For belongsTo (N:1): FK is on source table, named after target
 * For belongsToMany (M:N): FKs are on junction table
 *
 * @param tableName - The table name to base the FK on
 * @returns Inferred FK column name
 */
export function inferForeignKey(tableName: string): string {
	const singular = singularize(tableName);
	// Convert to snake_case if needed (handle camelCase table names)
	const snakeCase = singular.replace(/([A-Z])/g, '_$1').toLowerCase();
	// Remove leading underscore if present
	const cleanSnakeCase = snakeCase.startsWith('_')
		? snakeCase.slice(1)
		: snakeCase;
	return `${cleanSnakeCase}_id`;
}

// ============================================================================
// ModelIR Builder
// ============================================================================

/**
 * Builds a ModelIR from lightweight relation definitions.
 *
 * @param options - The defineModel options
 * @returns A ModelIR instance
 */
export function defineModel<DB = Record<string, unknown>>(
	options: DefineModelOptions<DB>,
): ModelIR {
	const { relations } = options;

	// Collect all tables from relation keys
	const tableNames = new Set<string>();
	const relationEntries: Array<{
		key: string;
		parsed: ParsedRelationKey;
		def: ParsedRelationDef;
	}> = [];

	// First pass: parse all relation definitions and collect table names
	for (const [key, value] of Object.entries(relations)) {
		if (value === undefined) continue;

		const parsed = parseRelationKey(key);
		const def = parseRelationDef(key, value as RelationShorthand);

		tableNames.add(parsed.sourceTable);

		// Determine target table
		let target = def.target;
		if (target === undefined) {
			// Infer target from relation name
			target = parsed.relationName;
		}
		tableNames.add(target);

		// Validate M:N has through
		if (def.cardinality === 'M:N' && def.through === undefined) {
			throw new InvalidRelationDefinitionError({
				relationKey: key,
				reason:
					"M:N relations require a 'through' option specifying the junction table",
				suggestion: `Use { cardinality: 'M:N', through: 'junction_table' }`,
			});
		}

		// Add junction table if M:N
		if (def.through !== undefined) {
			tableNames.add(def.through);
		}

		relationEntries.push({ key, parsed, def });
	}

	// Build tables map (minimal: just table name, no columns)
	// We infer that each table has an 'id' primary key by convention
	const tables = new Map<string, TableIR>();
	for (const name of tableNames) {
		tables.set(name, {
			name,
			columns: [],
			primaryKey: 'id',
			foreignKeys: [],
		});
	}

	// Build relations map
	const relationsMap = new Map<string, RelationIR>();

	for (const { key, parsed, def } of relationEntries) {
		// Determine target
		const target = def.target ?? parsed.relationName;

		// Determine FK
		let foreignKey = def.fk;
		if (foreignKey === undefined) {
			// Infer FK based on relation type
			if (def.relationType === 'belongsTo') {
				// FK is on source table, named after target
				foreignKey = inferForeignKey(target);
			} else if (
				def.relationType === 'hasMany' ||
				def.relationType === 'hasOne'
			) {
				// FK is on target table, named after source
				foreignKey = inferForeignKey(parsed.sourceTable);
			}
			// For belongsToMany, FKs are typically inferred from the junction table
			// and would need explicit definition
		}

		// Determine optionality (default to optional for now)
		const optionality: Optionality =
			def.relationType === 'belongsTo' ? 'optional' : 'required';

		const qualifiedName = key;
		const relation: RelationIR = {
			name: parsed.relationName,
			type: def.relationType,
			source: parsed.sourceTable,
			target,
			through: def.through,
			foreignKey: foreignKey,
			cardinality: def.modelCardinality,
			optionality,
			includeStrategy: 'auto',
			filterStrategy: 'auto',
			joinDefault: 'auto',
		};

		relationsMap.set(qualifiedName, relation);
	}

	// Create ModelIR implementation
	return new LightweightModelIR(tables, relationsMap);
}

/**
 * Lightweight ModelIR implementation.
 */
class LightweightModelIR implements ModelIR {
	readonly tables: ReadonlyMap<string, TableIR>;
	readonly relations: ReadonlyMap<string, RelationIR>;

	constructor(
		tables: ReadonlyMap<string, TableIR>,
		relations: ReadonlyMap<string, RelationIR>,
	) {
		this.tables = tables;
		this.relations = relations;
	}

	getTable(name: string): TableIR | undefined {
		return this.tables.get(name);
	}

	getRelation(qualifiedName: string): RelationIR | undefined {
		return this.relations.get(qualifiedName);
	}

	getRelationsFrom(sourceTable: string): readonly RelationIR[] {
		const result: RelationIR[] = [];
		for (const [key, relation] of this.relations) {
			if (key.startsWith(`${sourceTable}.`)) {
				result.push(relation);
			}
		}
		return result;
	}

	getRelationsTo(targetTable: string): readonly RelationIR[] {
		const result: RelationIR[] = [];
		for (const relation of this.relations.values()) {
			if (relation.target === targetTable) {
				result.push(relation);
			}
		}
		return result;
	}

	isAmbiguous(
		sourceTable: string,
		targetTable: string,
	): { ambiguous: boolean; options: readonly string[] } {
		const relationsToTarget: string[] = [];
		for (const [key, relation] of this.relations) {
			if (
				key.startsWith(`${sourceTable}.`) &&
				relation.target === targetTable
			) {
				relationsToTarget.push(relation.name);
			}
		}
		return {
			ambiguous: relationsToTarget.length > 1,
			options: relationsToTarget,
		};
	}
}
