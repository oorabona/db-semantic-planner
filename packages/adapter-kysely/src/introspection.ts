/**
 * @module introspection
 * Database introspection for automatic ModelIR generation.
 *
 * ADAPTER-006: Schema Introspection
 */

import type {
	ColumnIR,
	ColumnType,
	ForeignKeyIR,
	ModelIR,
	RelationIR,
	TableIR,
} from '@db-semantic-planner/core';
import { ModelIRImpl } from '@db-semantic-planner/core';
import type { ColumnMetadata, Kysely, TableMetadata } from 'kysely';
import { sql } from 'kysely';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Safely get first element from a non-empty array.
 * Returns the element or a fallback if array is empty.
 */
function first<T>(arr: readonly T[], fallback: T): T {
	const element = arr[0];
	return element !== undefined ? element : fallback;
}

/**
 * Get first element, throwing if array is empty.
 * Use only when array is guaranteed non-empty by previous checks.
 */
function firstOrThrow<T>(arr: readonly T[], context: string): T {
	const element = arr[0];
	if (element === undefined) {
		throw new Error(`Expected non-empty array in ${context}`);
	}
	return element;
}

// ============================================================================
// Types
// ============================================================================

/**
 * Foreign key information (used internally and for testing).
 */
export interface ForeignKeyInfo {
	sourceTable: string;
	sourceColumns: string[];
	targetTable: string;
	targetColumns: string[];
}

/**
 * Options for database introspection.
 */
export interface IntrospectionOptions {
	/**
	 * Tables to exclude (glob patterns with * supported).
	 * @example ['_migrations', '_prisma*', 'pg_*']
	 */
	readonly exclude?: readonly string[];

	/**
	 * Tables to include (default: all non-excluded).
	 * When specified, only these tables are introspected.
	 */
	readonly include?: readonly string[];

	/**
	 * Schema name to introspect.
	 * @default 'public' for PostgreSQL
	 */
	readonly schema?: string;

	/**
	 * Naming convention for inferred relation names.
	 * @default 'camelCase'
	 */
	readonly relationNaming?: 'camelCase' | 'snake_case';

	/**
	 * @internal Inject FK data for testing (bypasses information_schema query).
	 */
	readonly _foreignKeysForTesting?: readonly ForeignKeyInfo[];
}

/**
 * Hierarchy pattern detected during introspection.
 */
export interface DetectedHierarchy {
	/** Type of hierarchy pattern */
	readonly type: 'adjacency' | 'edge-table';

	/** Table containing the nodes */
	readonly nodeTable: string;

	/** Table containing edges (only for edge-table pattern) */
	readonly edgeTable?: string;

	/** Column referencing parent node */
	readonly parentColumn: string;

	/** Column referencing child node (only for edge-table pattern) */
	readonly childColumn?: string;

	/** Primary key column of the node table */
	readonly nodeIdColumn: string;
}

/**
 * Extended ModelIR with introspection metadata.
 */
export interface IntrospectedModelIR extends ModelIR {
	/** Detected hierarchy patterns */
	readonly hierarchies: readonly DetectedHierarchy[];

	/** When the introspection was performed */
	readonly introspectedAt: Date;

	/** Warnings generated during introspection */
	readonly warnings: readonly string[];
}

// ============================================================================
// Internal Types
// ============================================================================

interface ForeignKeyRow {
	source_table: string;
	source_column: string;
	target_table: string;
	target_column: string;
	constraint_name: string;
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Check if a table name matches an exclude/include pattern.
 * Supports basic glob patterns with *.
 */
function matchesPattern(name: string, pattern: string): boolean {
	if (pattern.includes('*')) {
		// Convert glob to regex
		const regex = new RegExp(
			`^${pattern.replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
		);
		return regex.test(name);
	}
	return name === pattern;
}

/**
 * Check if a table should be included based on options.
 */
function shouldIncludeTable(
	tableName: string,
	options: IntrospectionOptions,
): boolean {
	// Check exclude patterns first
	if (options.exclude?.some((p) => matchesPattern(tableName, p))) {
		return false;
	}

	// If include patterns specified, table must match one
	if (options.include && options.include.length > 0) {
		return options.include.some((p) => matchesPattern(tableName, p));
	}

	return true;
}

/**
 * Convert Kysely column type to our ColumnIR type.
 */
function mapColumnType(kyselyType: string): ColumnType {
	const type = kyselyType.toLowerCase();

	if (
		type.includes('varchar') ||
		type.includes('text') ||
		type.includes('char') ||
		type.includes('uuid')
	) {
		return 'string';
	}
	if (
		type.includes('int') ||
		type.includes('serial') ||
		type.includes('bigint') ||
		type.includes('numeric') ||
		type.includes('decimal') ||
		type.includes('float') ||
		type.includes('double') ||
		type.includes('real')
	) {
		return 'number';
	}
	if (type.includes('bool')) {
		return 'boolean';
	}
	if (
		type.includes('timestamp') ||
		type.includes('date') ||
		type.includes('time')
	) {
		return 'date';
	}
	if (type.includes('json')) {
		return 'json';
	}

	// Default to string for unknown types
	return 'string';
}

/**
 * Convert FK column name to relation name.
 * @example 'author_id' → 'author'
 * @example 'user_id' → 'user'
 * @example 'parentId' → 'parent'
 */
function fkToRelationName(
	fkColumn: string,
	naming: 'camelCase' | 'snake_case',
): string {
	// Remove common suffixes
	let name = fkColumn;
	if (name.endsWith('_id')) {
		name = name.slice(0, -3);
	} else if (name.endsWith('Id')) {
		name = name.slice(0, -2);
	}

	// Apply naming convention
	if (naming === 'camelCase') {
		// Convert snake_case to camelCase if needed
		return name.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
	}
	// snake_case: convert camelCase to snake_case
	return name.replace(/([A-Z])/g, '_$1').toLowerCase();
}

/**
 * Pluralize a table name for hasMany relation.
 * Simple English pluralization rules.
 */

// ============================================================================
// Main Introspection Function
// ============================================================================

/**
 * Introspect a database and generate ModelIR.
 *
 * @param db - Kysely database instance
 * @param options - Introspection options
 * @returns IntrospectedModelIR with tables, relations, and detected hierarchies
 *
 * @example
 * ```typescript
 * import { introspect } from '@db-semantic-planner/adapter-kysely';
 *
 * const model = await introspect(db);
 * const planner = createPlanner(model);
 * ```
 */
export async function introspect(
	db: Kysely<unknown>,
	options: IntrospectionOptions = {},
): Promise<IntrospectedModelIR> {
	const warnings: string[] = [];
	const naming = options.relationNaming ?? 'camelCase';
	const schema = options.schema ?? 'public';

	// Get table metadata from Kysely
	const tableMetadata = await db.introspection.getTables({
		withInternalKyselyTables: false,
	});

	// Filter tables based on options
	const filteredTables = tableMetadata.filter((t) =>
		shouldIncludeTable(t.name, options),
	);

	// Get table names for FK filtering
	const tableNames = new Set(filteredTables.map((t) => t.name));

	// Query foreign keys from information_schema (or use test data)
	const allForeignKeys = options._foreignKeysForTesting
		? [...options._foreignKeysForTesting]
		: await queryForeignKeys(db, schema);

	// Filter FKs to only include those where both source and target are in our tables
	const foreignKeys = allForeignKeys.filter(
		(fk) => tableNames.has(fk.sourceTable) && tableNames.has(fk.targetTable),
	);

	// Build FK map grouped by source table
	const fkMap = buildForeignKeyMap(foreignKeys);

	// Build table IR with FKs
	const tableList = filteredTables.map((table) =>
		buildTableIR(table, fkMap.get(table.name) ?? [], warnings),
	);

	// Convert to Map for ModelIR
	const tablesMap = new Map<string, TableIR>();
	for (const table of tableList) {
		tablesMap.set(table.name, table);
	}

	// Infer relations from foreign keys
	const relationList = inferRelations(foreignKeys, naming);

	// Convert to Map for ModelIR (keyed by "source.name")
	const relationsMap = new Map<string, RelationIR>();
	for (const relation of relationList) {
		const key = `${relation.source}.${relation.name}`;
		relationsMap.set(key, relation);
	}

	// Detect hierarchy patterns
	const hierarchies = detectHierarchies(foreignKeys, tableList);

	// Create ModelIR using the implementation class
	const baseModel = new ModelIRImpl(tablesMap, relationsMap);

	// Return extended model with introspection metadata
	return {
		...baseModel,
		tables: baseModel.tables,
		relations: baseModel.relations,
		getTable: baseModel.getTable.bind(baseModel),
		getRelation: baseModel.getRelation.bind(baseModel),
		getRelationsFrom: baseModel.getRelationsFrom.bind(baseModel),
		getRelationsTo: baseModel.getRelationsTo.bind(baseModel),
		isAmbiguous: baseModel.isAmbiguous.bind(baseModel),
		hierarchies,
		introspectedAt: new Date(),
		warnings,
	};
}

// ============================================================================
// Table Building
// ============================================================================

/**
 * Build TableIR from Kysely TableMetadata.
 */
function buildTableIR(
	table: TableMetadata,
	tableFks: ForeignKeyInfo[],
	warnings: string[],
): TableIR {
	// Map columns
	const columns: ColumnIR[] = table.columns.map((col: ColumnMetadata) => ({
		name: col.name,
		type: mapColumnType(col.dataType),
		nullable: col.isNullable,
	}));

	// Extract primary key
	const pkColumns = table.columns
		.filter((col: ColumnMetadata) => col.isAutoIncrementing)
		.map((col: ColumnMetadata) => col.name);

	// If no auto-increment, try to find 'id' column
	const primaryKey: string | readonly string[] =
		pkColumns.length > 0
			? pkColumns.length === 1
				? first(pkColumns, 'id')
				: pkColumns
			: 'id';

	// Check if the table actually has the assumed PK
	const hasIdColumn = table.columns.some(
		(col: ColumnMetadata) => col.name === 'id',
	);
	if (pkColumns.length === 0 && !hasIdColumn) {
		// No PK detected
		warnings.push(
			`Table '${table.name}' has no detected primary key. Assuming 'id' but this may be incorrect.`,
		);
	}

	// Convert ForeignKeyInfo to ForeignKeyIR
	const foreignKeys: ForeignKeyIR[] = tableFks.map((fk) => ({
		columns: fk.sourceColumns,
		references: {
			table: fk.targetTable,
			columns: fk.targetColumns,
		},
	}));

	return {
		name: table.name,
		columns,
		primaryKey,
		foreignKeys,
	};
}

/**
 * Query foreign keys from information_schema.
 * PostgreSQL-specific for MVP.
 */
async function queryForeignKeys(
	db: Kysely<unknown>,
	schema: string,
): Promise<ForeignKeyInfo[]> {
	// Use raw SQL since information_schema types aren't available in Kysely
	const result = await sql<ForeignKeyRow>`
		SELECT
			tc.table_name as source_table,
			kcu.column_name as source_column,
			ccu.table_name as target_table,
			ccu.column_name as target_column,
			tc.constraint_name
		FROM information_schema.table_constraints tc
		INNER JOIN information_schema.key_column_usage kcu
			ON tc.constraint_name = kcu.constraint_name
			AND tc.table_schema = kcu.table_schema
		INNER JOIN information_schema.constraint_column_usage ccu
			ON tc.constraint_name = ccu.constraint_name
			AND tc.table_schema = ccu.table_schema
		WHERE tc.constraint_type = 'FOREIGN KEY'
			AND tc.table_schema = ${schema}
	`.execute(db);

	// Group by constraint name to handle composite FKs
	const fkByConstraint = new Map<
		string,
		{
			sourceTable: string;
			sourceColumns: string[];
			targetTable: string;
			targetColumns: string[];
		}
	>();

	for (const row of result.rows) {
		const key = row.constraint_name;
		const existing = fkByConstraint.get(key);

		if (existing) {
			existing.sourceColumns.push(row.source_column);
			existing.targetColumns.push(row.target_column);
		} else {
			fkByConstraint.set(key, {
				sourceTable: row.source_table,
				sourceColumns: [row.source_column],
				targetTable: row.target_table,
				targetColumns: [row.target_column],
			});
		}
	}

	return Array.from(fkByConstraint.values());
}

/**
 * Build a map of foreign keys grouped by source table.
 */
function buildForeignKeyMap(
	fks: ForeignKeyInfo[],
): Map<string, ForeignKeyInfo[]> {
	const map = new Map<string, ForeignKeyInfo[]>();

	for (const fk of fks) {
		const existing = map.get(fk.sourceTable) ?? [];
		existing.push(fk);
		map.set(fk.sourceTable, existing);
	}

	return map;
}

// ============================================================================
// Relation Inference (Block 2)
// ============================================================================

/**
 * Infer relations from foreign key constraints.
 * Each FK generates two relations: belongsTo (owner → target) and hasMany (target → owner).
 */
function inferRelations(
	foreignKeys: ForeignKeyInfo[],
	naming: 'camelCase' | 'snake_case',
): RelationIR[] {
	const relations: RelationIR[] = [];

	for (const fk of foreignKeys) {
		// FK must have at least one source column
		const firstSourceCol = firstOrThrow(fk.sourceColumns, 'FK source columns');

		// belongsTo: FK owner → FK target
		const belongsToName = fkToRelationName(firstSourceCol, naming);
		const belongsTo: RelationIR = {
			name: belongsToName,
			type: 'belongsTo',
			source: fk.sourceTable,
			target: fk.targetTable,
			foreignKey:
				fk.sourceColumns.length === 1 ? firstSourceCol : fk.sourceColumns,
			cardinality: 'one',
			optionality: 'optional', // FK columns are usually nullable
			includeStrategy: 'join',
			filterStrategy: 'join',
			joinDefault: 'left',
		};
		relations.push(belongsTo);

		// hasMany: FK target → FK owner
		// Use plural form of source table name
		const hasManyName = fk.sourceTable;
		const hasMany: RelationIR = {
			name: hasManyName,
			type: 'hasMany',
			source: fk.targetTable,
			target: fk.sourceTable,
			foreignKey:
				fk.sourceColumns.length === 1 ? firstSourceCol : fk.sourceColumns,
			cardinality: 'many',
			optionality: 'optional',
			includeStrategy: 'separate', // Use 'separate' for hasMany to avoid row explosion
			filterStrategy: 'exists',
			joinDefault: 'left',
		};
		relations.push(hasMany);
	}

	return relations;
}

// ============================================================================
// Hierarchy Detection (Block 3)
// ============================================================================

/**
 * Detect hierarchy patterns (adjacency and edge-table).
 *
 * Adjacency pattern: Self-referential FK (e.g., categories.parent_id → categories.id)
 * Edge-table pattern: Table with 2 FKs to same target (e.g., role_edges with parent_role_id and child_role_id → roles)
 */
function detectHierarchies(
	foreignKeys: ForeignKeyInfo[],
	tables: readonly TableIR[],
): DetectedHierarchy[] {
	const hierarchies: DetectedHierarchy[] = [];

	// Create a map of table name → primary key
	const tablePkMap = new Map<string, string>();
	for (const table of tables) {
		const pk =
			typeof table.primaryKey === 'string'
				? table.primaryKey
				: table.primaryKey[0];
		if (pk) {
			tablePkMap.set(table.name, pk);
		}
	}

	// Detect adjacency patterns (self-referential FKs)
	for (const fk of foreignKeys) {
		if (fk.sourceTable === fk.targetTable) {
			// Self-referential FK = adjacency pattern
			const nodeIdColumn = tablePkMap.get(fk.sourceTable) ?? 'id';
			const parentCol = firstOrThrow(fk.sourceColumns, 'adjacency FK');
			hierarchies.push({
				type: 'adjacency',
				nodeTable: fk.sourceTable,
				parentColumn: parentCol,
				nodeIdColumn,
			});
		}
	}

	// Detect edge-table patterns (table with 2+ FKs to same target)
	// Group FKs by source table
	const fksBySource = new Map<string, ForeignKeyInfo[]>();
	for (const fk of foreignKeys) {
		const existing = fksBySource.get(fk.sourceTable) ?? [];
		existing.push(fk);
		fksBySource.set(fk.sourceTable, existing);
	}

	// Check each table for edge-table pattern
	for (const [sourceTable, tableFks] of fksBySource) {
		// Skip self-referential tables (already handled as adjacency)
		const nonSelfFks = tableFks.filter(
			(fk) => fk.sourceTable !== fk.targetTable,
		);

		// Group by target table
		const fksByTarget = new Map<string, ForeignKeyInfo[]>();
		for (const fk of nonSelfFks) {
			const existing = fksByTarget.get(fk.targetTable) ?? [];
			existing.push(fk);
			fksByTarget.set(fk.targetTable, existing);
		}

		// Check for 2+ FKs to same target
		for (const [targetTable, targetFks] of fksByTarget) {
			if (targetFks.length >= 2) {
				// Edge-table pattern detected - we checked length >= 2
				const nodeIdColumn = tablePkMap.get(targetTable) ?? 'id';
				const parentFk = targetFks[0];
				const childFk = targetFks[1];
				if (parentFk && childFk) {
					hierarchies.push({
						type: 'edge-table',
						nodeTable: targetTable,
						edgeTable: sourceTable,
						parentColumn: firstOrThrow(parentFk.sourceColumns, 'parent FK'),
						childColumn: firstOrThrow(childFk.sourceColumns, 'child FK'),
						nodeIdColumn,
					});
				}
			}
		}
	}

	return hierarchies;
}
