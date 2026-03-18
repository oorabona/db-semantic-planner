/**
 * PostgreSQL Schema Introspection (ADAPTER-006)
 *
 * Queries information_schema/pg_catalog to build ModelIR
 * from an existing database. Supports:
 * - Table/column/PK discovery
 * - FK → bidirectional relation inference
 * - Hierarchy detection (adjacency + edge-table)
 * - Include/exclude filtering
 *
 * @module introspection
 */

import { ModelIRImpl } from '@dbsp/core';
import type {
	CheckConstraintIR,
	ColumnIR,
	ColumnType,
	ForeignKeyIR,
	IndexIR,
	ModelIR,
	OnDeleteAction,
	RelationIR,
	RelationType,
	TableIR,
} from '@dbsp/types';
import type { Pool } from 'pg';
import { DEFAULT_PK_COLUMN } from './assert-field.js';

// ============================================================================
// Types
// ============================================================================

/** Options for database introspection */
export interface IntrospectionOptions {
	/** Tables to exclude (glob patterns: * matches any chars) */
	readonly exclude?: readonly string[];
	/** Tables to include (default: all). Applied before exclude. */
	readonly include?: readonly string[];
	/** Schema name to introspect (default: 'public') */
	readonly schema?: string;
}

/** Hierarchy pattern detected during introspection */
export interface DetectedHierarchy {
	readonly type: 'adjacency' | 'edge-table';
	readonly nodeTable: string;
	readonly edgeTable?: string;
	readonly parentColumn: string;
	readonly childColumn?: string;
	readonly nodeIdColumn: string;
}

/** Extended ModelIR with hierarchy metadata */
export interface IntrospectedModelIR extends ModelIR {
	readonly hierarchies: readonly DetectedHierarchy[];
	readonly introspectedAt: Date;
	readonly warnings: readonly string[];
}

// ============================================================================
// Raw query result types
// ============================================================================

interface RawColumn {
	table_name: string;
	column_name: string;
	data_type: string;
	udt_name: string;
	is_nullable: string;
	column_default: string | null;
}

interface RawPrimaryKey {
	table_name: string;
	column_name: string;
}

interface RawForeignKey {
	constraint_name: string;
	source_table: string;
	source_column: string;
	target_table: string;
	target_column: string;
	delete_rule: string;
}

interface RawIndex {
	index_name: string;
	table_name: string;
	columns: string[];
	is_unique: boolean;
}

// ============================================================================
// Block 1: Core Introspection (tables, columns, PKs)
// ============================================================================

/**
 * Introspect a PostgreSQL database and return a ModelIR.
 *
 * @param pool - pg.Pool connection
 * @param options - Introspection options (schema, include/exclude)
 * @returns IntrospectedModelIR with tables, relations, and hierarchy metadata
 *
 * @example
 * ```typescript
 * const model = await introspect(pool);
 * const orm = createOrm({ model, adapter: createPgsqlAdapter(pool) });
 * ```
 */
export async function introspect(
	pool: Pool,
	options?: IntrospectionOptions,
): Promise<IntrospectedModelIR> {
	const schema = options?.schema ?? 'public';
	const warnings: string[] = [];

	// Step 1: Fetch columns
	const columnsResult = await pool.query<RawColumn>(
		`SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default
		 FROM information_schema.columns
		 WHERE table_schema = $1
		 ORDER BY table_name, ordinal_position`,
		[schema],
	);

	// Step 2: Fetch primary keys
	const pksResult = await pool.query<RawPrimaryKey>(
		`SELECT tc.table_name, kcu.column_name
		 FROM information_schema.table_constraints tc
		 JOIN information_schema.key_column_usage kcu
		   ON tc.constraint_name = kcu.constraint_name
		   AND tc.table_schema = kcu.table_schema
		 WHERE tc.constraint_type = 'PRIMARY KEY'
		   AND tc.table_schema = $1
		 ORDER BY tc.table_name, kcu.ordinal_position`,
		[schema],
	);

	// Step 3: Fetch foreign keys
	const fksResult = await pool.query<RawForeignKey>(
		`SELECT
		   tc.constraint_name,
		   kcu.table_name AS source_table,
		   kcu.column_name AS source_column,
		   ccu.table_name AS target_table,
		   ccu.column_name AS target_column,
		   rc.delete_rule
		 FROM information_schema.table_constraints tc
		 JOIN information_schema.key_column_usage kcu
		   ON tc.constraint_name = kcu.constraint_name
		   AND tc.table_schema = kcu.table_schema
		 JOIN information_schema.constraint_column_usage ccu
		   ON ccu.constraint_name = tc.constraint_name
		   AND ccu.table_schema = tc.table_schema
		 JOIN information_schema.referential_constraints rc
		   ON rc.constraint_name = tc.constraint_name
		   AND rc.constraint_schema = tc.table_schema
		 WHERE tc.constraint_type = 'FOREIGN KEY'
		   AND tc.table_schema = $1
		 ORDER BY tc.constraint_name, kcu.ordinal_position`,
		[schema],
	);

	// Step 4: Fetch indexes (excluding PK-backing indexes)
	const indexesResult = await pool.query<RawIndex>(
		`SELECT
		   i.relname AS index_name,
		   t.relname AS table_name,
		   array_agg(a.attname ORDER BY k.n) AS columns,
		   ix.indisunique AS is_unique
		 FROM pg_index ix
		 JOIN pg_class i ON i.oid = ix.indexrelid
		 JOIN pg_class t ON t.oid = ix.indrelid
		 JOIN pg_namespace n ON n.oid = t.relnamespace
		 CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, n)
		 JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
		 WHERE n.nspname = $1
		   AND NOT ix.indisprimary
		 GROUP BY i.relname, t.relname, ix.indisunique
		 ORDER BY t.relname, i.relname`,
		[schema],
	);

	// Step 5: Fetch CHECK constraints
	const checksResult = await pool.query<{
		name: string;
		expression: string;
		raw_table: string;
	}>(
		`SELECT
		   c.conname AS name,
		   pg_get_constraintdef(c.oid, false) AS expression,
		   c.conrelid::regclass::text AS raw_table
		 FROM pg_constraint c
		 JOIN pg_namespace n ON n.oid = c.connamespace
		 WHERE c.contype = 'c'
		   AND n.nspname = $1`,
		[schema],
	);

	// Group CHECK constraints by table (strip schema prefix if present)
	const tableChecks = new Map<string, CheckConstraintIR[]>();
	for (const ck of checksResult.rows) {
		const tableName = ck.raw_table.replace(/^".*"\.|^.*\./u, '');
		const checkIR: CheckConstraintIR = {
			name: ck.name,
			expression: ck.expression,
		};
		const existing = tableChecks.get(tableName);
		if (existing) {
			existing.push(checkIR);
		} else {
			tableChecks.set(tableName, [checkIR]);
		}
	}

	// Group indexes by table
	const tableIndexes = new Map<string, IndexIR[]>();
	for (const idx of indexesResult.rows) {
		const indexIR: IndexIR = {
			name: idx.index_name,
			columns: Array.isArray(idx.columns)
				? idx.columns
				: String(idx.columns)
						.replace(/^\{|}$/g, '')
						.split(',')
						.filter(Boolean),
			...(idx.is_unique ? { unique: true } : {}),
		};
		const existing = tableIndexes.get(idx.table_name);
		if (existing) {
			existing.push(indexIR);
		} else {
			tableIndexes.set(idx.table_name, [indexIR]);
		}
	}

	// Group columns by table
	const tableColumns = new Map<string, RawColumn[]>();
	for (const col of columnsResult.rows) {
		const existing = tableColumns.get(col.table_name);
		if (existing) {
			existing.push(col);
		} else {
			tableColumns.set(col.table_name, [col]);
		}
	}

	// Group PKs by table
	const tablePKs = new Map<string, string[]>();
	for (const pk of pksResult.rows) {
		const existing = tablePKs.get(pk.table_name);
		if (existing) {
			existing.push(pk.column_name);
		} else {
			tablePKs.set(pk.table_name, [pk.column_name]);
		}
	}

	// Group FKs by constraint name (for composite FK support)
	const fksByConstraint = new Map<
		string,
		{
			source: string;
			target: string;
			cols: string[];
			refs: string[];
			deleteRule: string;
		}
	>();
	for (const fk of fksResult.rows) {
		const existing = fksByConstraint.get(fk.constraint_name);
		if (existing) {
			existing.cols.push(fk.source_column);
			existing.refs.push(fk.target_column);
		} else {
			fksByConstraint.set(fk.constraint_name, {
				source: fk.source_table,
				target: fk.target_table,
				cols: [fk.source_column],
				refs: [fk.target_column],
				deleteRule: fk.delete_rule,
			});
		}
	}

	// Apply include/exclude filters
	let tableNames = Array.from(tableColumns.keys());
	tableNames = filterTables(tableNames, options);

	// Build TableIR map
	const tables = new Map<string, TableIR>();
	for (const tableName of tableNames) {
		const rawCols = tableColumns.get(tableName) ?? [];
		const pkCols = tablePKs.get(tableName);

		const columns: ColumnIR[] = rawCols.map((col) => ({
			name: col.column_name,
			type: mapPgType(col.data_type, col.udt_name),
			nullable: col.is_nullable === 'YES',
			...(col.column_default != null ? { default: col.column_default } : {}),
			dbType: col.udt_name,
		}));

		// Build FK list for this table
		const foreignKeys: ForeignKeyIR[] = [];
		for (const [, fk] of fksByConstraint) {
			if (fk.source !== tableName) continue;
			// Only include FK if target table is in our filtered set
			if (!tableNames.includes(fk.target)) continue;
			foreignKeys.push({
				columns: fk.cols,
				references: { table: fk.target, columns: fk.refs },
				onDelete: mapDeleteRule(fk.deleteRule),
			});
		}

		if (!pkCols) {
			warnings.push(`Table "${tableName}" has no primary key`);
		}

		const checks = tableChecks.get(tableName);
		const table: TableIR = {
			name: tableName,
			columns,
			...(pkCols
				? { primaryKey: pkCols.length === 1 ? pkCols[0]! : pkCols }
				: {}),
			foreignKeys,
			indexes: tableIndexes.get(tableName) ?? [],
			...(checks && checks.length > 0 ? { checkConstraints: checks } : {}),
		};
		tables.set(tableName, table);
	}

	// Block 2: Infer relations from foreign keys
	const relations = inferRelations(fksByConstraint, tableNames);

	// Block 3: Detect hierarchies
	const hierarchies = detectHierarchies(tables, fksByConstraint, tableNames);

	// Build ModelIR
	const modelIR = new ModelIRImpl(tables, relations);

	return Object.assign(modelIR, {
		hierarchies,
		introspectedAt: new Date(),
		warnings,
	}) as IntrospectedModelIR;
}

// ============================================================================
// Block 2: Relation Inference
// ============================================================================

/**
 * Infer bidirectional relations from FK constraints.
 * Each FK produces: belongsTo (source → target) + hasMany (target → source).
 */
function inferRelations(
	fksByConstraint: Map<
		string,
		{
			source: string;
			target: string;
			cols: string[];
			refs: string[];
			deleteRule: string;
		}
	>,
	filteredTables: string[],
): Map<string, RelationIR> {
	const relations = new Map<string, RelationIR>();
	const filteredSet = new Set(filteredTables);

	for (const [, fk] of fksByConstraint) {
		if (!filteredSet.has(fk.source) || !filteredSet.has(fk.target)) continue;

		// Derive relation name from FK column
		// author_id → author (belongsTo)
		// category_id → category (belongsTo)
		const belongsToName = deriveRelationName(fk.cols[0]!, fk.target);
		const fkCol = fk.cols.length === 1 ? fk.cols[0]! : fk.cols;

		// belongsTo: source (FK owner) → target
		const belongsToKey = `${fk.source}.${belongsToName}`;
		if (!relations.has(belongsToKey)) {
			relations.set(belongsToKey, {
				name: belongsToName,
				type: 'belongsTo' as RelationType,
				source: fk.source,
				target: fk.target,
				foreignKey: fkCol,
				cardinality: 'one',
				optionality: 'optional',
				includeStrategy: 'auto',
				filterStrategy: 'auto',
				joinDefault: 'auto',
			});
		}

		// hasMany: target → source (FK owner)
		// users.posts (users hasMany posts)
		const hasManyName = fk.source; // Use source table name for hasMany
		const hasManyKey = `${fk.target}.${hasManyName}`;
		if (!relations.has(hasManyKey)) {
			relations.set(hasManyKey, {
				name: hasManyName,
				type: 'hasMany' as RelationType,
				source: fk.target,
				target: fk.source,
				foreignKey: fkCol,
				cardinality: 'many',
				optionality: 'optional',
				includeStrategy: 'auto',
				filterStrategy: 'auto',
				joinDefault: 'auto',
			});
		}
	}

	return relations;
}

/**
 * Derive a relation name from a FK column name.
 * - author_id → author
 * - category_id → category
 * - parent_id → parent
 * - If no _id suffix, use target table (singular)
 */
function deriveRelationName(fkColumn: string, _targetTable: string): string {
	if (fkColumn.endsWith('_id')) {
		return fkColumn.slice(0, -3);
	}
	if (fkColumn.endsWith('Id')) {
		return fkColumn.slice(0, -2);
	}
	return fkColumn;
}

// ============================================================================
// Block 3: Hierarchy Detection
// ============================================================================

/**
 * Detect hierarchy patterns:
 * - Adjacency: self-referential FK (table.parent_id → table.id)
 * - Edge-table: table with 2+ FKs to same target
 */
function detectHierarchies(
	tables: Map<string, TableIR>,
	fksByConstraint: Map<
		string,
		{
			source: string;
			target: string;
			cols: string[];
			refs: string[];
			deleteRule: string;
		}
	>,
	filteredTables: string[],
): DetectedHierarchy[] {
	const hierarchies: DetectedHierarchy[] = [];
	const filteredSet = new Set(filteredTables);

	// Track FKs by (source, target) for edge-table detection
	const fksBySourceTarget = new Map<
		string,
		Array<{ cols: string[]; refs: string[] }>
	>();

	for (const [, fk] of fksByConstraint) {
		if (!filteredSet.has(fk.source) || !filteredSet.has(fk.target)) continue;

		// Adjacency: self-referential FK
		if (fk.source === fk.target && fk.cols.length === 1) {
			const table = tables.get(fk.source);
			const pk = table?.primaryKey;
			const nodeIdColumn =
				typeof pk === 'string' ? pk : (pk?.[0] ?? DEFAULT_PK_COLUMN);

			hierarchies.push({
				type: 'adjacency',
				nodeTable: fk.source,
				parentColumn: fk.cols[0]!,
				nodeIdColumn,
			});
		}

		// Track for edge-table detection
		const key = `${fk.source}→${fk.target}`;
		const existing = fksBySourceTarget.get(key);
		if (existing) {
			existing.push({ cols: fk.cols, refs: fk.refs });
		} else {
			fksBySourceTarget.set(key, [{ cols: fk.cols, refs: fk.refs }]);
		}
	}

	// Edge-table: table with 2+ FKs to same target (non-self-referential)
	for (const [key, fks] of fksBySourceTarget) {
		if (fks.length < 2) continue;
		const [source, target] = key.split('→');
		if (!source || !target) continue;
		if (source === target) continue; // Exclude self-referential (already handled as adjacency)

		const nodeTable = tables.get(target);
		const nodeIdColumn =
			typeof nodeTable?.primaryKey === 'string'
				? nodeTable.primaryKey
				: (nodeTable?.primaryKey?.[0] ?? DEFAULT_PK_COLUMN);

		hierarchies.push({
			type: 'edge-table',
			nodeTable: target,
			edgeTable: source,
			parentColumn: fks[0]!.cols[0]!,
			childColumn: fks[1]!.cols[0]!,
			nodeIdColumn,
		});
	}

	return hierarchies;
}

// ============================================================================
// Block 4: Helpers
// ============================================================================

/** Map PostgreSQL data type to ColumnType */
function mapPgType(dataType: string, udtName: string): ColumnType {
	// Check UDT name first (more specific)
	switch (udtName) {
		case 'uuid':
			return 'uuid';
		case 'jsonb':
			return 'jsonb';
		case 'json':
			return 'json';
		case 'int4range':
			return 'int4range';
		case 'int8range':
			return 'int8range';
		case 'numrange':
			return 'numrange';
		case 'daterange':
			return 'daterange';
		case 'tsrange':
			return 'tsrange';
		case 'tstzrange':
			return 'tstzrange';
	}

	// Fallback to data_type
	switch (dataType) {
		case 'integer':
		case 'smallint':
			return 'integer';
		case 'bigint':
			return 'bigint';
		case 'numeric':
		case 'decimal':
		case 'real':
		case 'double precision':
			return 'decimal';
		case 'boolean':
			return 'boolean';
		case 'character varying':
		case 'character':
		case 'varchar':
		case 'char':
			return 'string';
		case 'text':
			return 'text';
		case 'date':
			return 'date';
		case 'time without time zone':
		case 'time with time zone':
			return 'time';
		case 'timestamp without time zone':
			return 'timestamp';
		case 'timestamp with time zone':
			return 'datetime';
		case 'json':
			return 'json';
		case 'jsonb':
			return 'jsonb';
		case 'uuid':
			return 'uuid';
		default:
			return 'string'; // Safe fallback
	}
}

/** Map PostgreSQL delete rule to OnDeleteAction */
function mapDeleteRule(rule: string): OnDeleteAction {
	switch (rule) {
		case 'CASCADE':
			return 'CASCADE';
		case 'SET NULL':
			return 'SET NULL';
		case 'RESTRICT':
			return 'RESTRICT';
		default:
			return 'NO ACTION';
	}
}

/**
 * Filter table names by include/exclude options.
 * Include is applied first, then exclude.
 * Patterns support * for wildcard matching.
 */
function filterTables(
	tableNames: string[],
	options?: IntrospectionOptions,
): string[] {
	let result = tableNames;

	if (options?.include?.length) {
		result = result.filter((name) =>
			options.include!.some((pattern) => matchGlob(pattern, name)),
		);
	}

	if (options?.exclude?.length) {
		result = result.filter(
			(name) => !options.exclude!.some((pattern) => matchGlob(pattern, name)),
		);
	}

	return result;
}

/** Simple glob matching (supports * wildcard) */
function matchGlob(pattern: string, value: string): boolean {
	if (!pattern.includes('*')) return pattern === value;
	const regex = new RegExp(
		`^${pattern.replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
	);
	return regex.test(value);
}
