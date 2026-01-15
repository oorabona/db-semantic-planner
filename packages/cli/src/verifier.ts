/**
 * ARCH-002 Block 7: Schema Verifier
 *
 * Compares schema definition against real database for drift detection.
 */

import type { ResolvedSchema } from '@dbsp/schema';

// ============================================================================
// Types
// ============================================================================

export type DriftSeverity = 'error' | 'warning' | 'info';

export interface DriftIssue {
	/** Issue severity */
	severity: DriftSeverity;
	/** Human-readable message */
	message: string;
	/** Table affected (if any) */
	table?: string;
	/** Column affected (if any) */
	column?: string;
	/** Issue type for programmatic handling */
	type: DriftType;
}

export type DriftType =
	| 'missing_table_in_db'
	| 'missing_table_in_schema'
	| 'missing_column_in_db'
	| 'missing_column_in_schema'
	| 'type_mismatch'
	| 'nullable_mismatch'
	| 'primary_key_mismatch';

export interface VerifyResult {
	/** Whether the schema matches the database */
	valid: boolean;
	/** List of drift issues found */
	issues: DriftIssue[];
	/** Tables in schema */
	schemaTables: string[];
	/** Tables in database */
	dbTables: string[];
}

/**
 * Database table metadata from introspection.
 */
export interface DbTableInfo {
	name: string;
	columns: DbColumnInfo[];
}

/**
 * Database column metadata from introspection.
 */
export interface DbColumnInfo {
	name: string;
	dataType: string;
	isNullable: boolean;
	isPrimaryKey?: boolean;
	hasDefault?: boolean;
}

// ============================================================================
// Type Mapping
// ============================================================================

/**
 * Map database type to schema column type.
 * This is database-specific (PostgreSQL).
 */
function dbTypeToSchemaType(dbType: string): string {
	const normalizedType = dbType.toLowerCase().replace(/\(.+\)/, '');

	const typeMap: Record<string, string> = {
		// String types
		'character varying': 'string',
		varchar: 'string',
		text: 'text',
		char: 'string',
		character: 'string',

		// Number types
		integer: 'integer',
		int: 'integer',
		int4: 'integer',
		smallint: 'integer',
		int2: 'integer',
		bigint: 'bigint',
		int8: 'bigint',
		numeric: 'decimal',
		decimal: 'decimal',
		real: 'number',
		float4: 'number',
		'double precision': 'number',
		float8: 'number',

		// Boolean
		boolean: 'boolean',
		bool: 'boolean',

		// Date/Time
		date: 'date',
		timestamp: 'timestamp',
		'timestamp without time zone': 'timestamp',
		'timestamp with time zone': 'timestamp',
		timestamptz: 'timestamp',
		time: 'timestamp',
		'time without time zone': 'timestamp',
		'time with time zone': 'timestamp',

		// JSON
		json: 'json',
		jsonb: 'json',

		// UUID
		uuid: 'uuid',
	};

	return typeMap[normalizedType] ?? normalizedType;
}

/**
 * Map schema column type to normalized type for comparison.
 */
function schemaTypeToNormalized(schemaType: string): string {
	// Schema types are already normalized
	return schemaType;
}

/**
 * Check if two types are compatible.
 */
function typesCompatible(schemaType: string, dbType: string): boolean {
	const normalizedSchema = schemaTypeToNormalized(schemaType);
	const normalizedDb = dbTypeToSchemaType(dbType);

	// Direct match
	if (normalizedSchema === normalizedDb) {
		return true;
	}

	// String variants
	if (normalizedSchema === 'string' && normalizedDb === 'text') return true;
	if (normalizedSchema === 'text' && normalizedDb === 'string') return true;

	// Number variants
	if (
		normalizedSchema === 'number' &&
		['integer', 'decimal'].includes(normalizedDb)
	)
		return true;
	if (normalizedSchema === 'integer' && normalizedDb === 'number') return true;
	if (normalizedSchema === 'decimal' && normalizedDb === 'number') return true;

	// Timestamp variants
	if (normalizedSchema === 'timestamp' && normalizedDb === 'datetime')
		return true;
	if (normalizedSchema === 'datetime' && normalizedDb === 'timestamp')
		return true;

	return false;
}

// ============================================================================
// Verification Logic
// ============================================================================

/**
 * Verify schema against database tables.
 *
 * @param schema - Resolved schema from defineSchema()
 * @param dbTables - Tables from database introspection
 * @returns Verification result with issues
 */
export function verify(
	schema: ResolvedSchema,
	dbTables: DbTableInfo[],
): VerifyResult {
	const issues: DriftIssue[] = [];
	const schemaTableNames = Object.keys(schema.tables);
	const dbTableNames = dbTables.map((t) => t.name);
	const dbTableMap = new Map(dbTables.map((t) => [t.name, t]));

	// Check for tables in schema but not in DB
	for (const tableName of schemaTableNames) {
		if (!dbTableMap.has(tableName)) {
			issues.push({
				severity: 'error',
				type: 'missing_table_in_db',
				table: tableName,
				message: `Table "${tableName}" exists in schema but not in database`,
			});
		}
	}

	// Check for tables in DB but not in schema
	for (const tableName of dbTableNames) {
		if (!schemaTableNames.includes(tableName)) {
			issues.push({
				severity: 'warning',
				type: 'missing_table_in_schema',
				table: tableName,
				message: `Table "${tableName}" exists in database but not in schema`,
			});
		}
	}

	// Check column-level drift for matching tables
	for (const tableName of schemaTableNames) {
		const dbTable = dbTableMap.get(tableName);
		if (!dbTable) continue; // Already reported as missing

		const schemaTable = schema.tables[tableName];
		// Safety check (should always exist since we're iterating schemaTableNames)
		if (!schemaTable) continue;

		const schemaColumnNames = Object.keys(schemaTable);
		const dbColumnMap = new Map(dbTable.columns.map((c) => [c.name, c]));
		const dbColumnNames = dbTable.columns.map((c) => c.name);

		// Check for columns in schema but not in DB
		for (const columnName of schemaColumnNames) {
			const dbColumn = dbColumnMap.get(columnName);

			if (!dbColumn) {
				issues.push({
					severity: 'error',
					type: 'missing_column_in_db',
					table: tableName,
					column: columnName,
					message: `Column "${tableName}.${columnName}" exists in schema but not in database`,
				});
				continue;
			}

			const schemaColumn = schemaTable[columnName];
			// Safety check (should always exist since we're iterating schemaColumnNames)
			if (!schemaColumn) continue;

			// Check type compatibility
			if (!typesCompatible(schemaColumn.type, dbColumn.dataType)) {
				issues.push({
					severity: 'error',
					type: 'type_mismatch',
					table: tableName,
					column: columnName,
					message: `Column "${tableName}.${columnName}" type mismatch: schema="${schemaColumn.type}", database="${dbColumn.dataType}"`,
				});
			}

			// Check nullable mismatch
			const schemaNullable = schemaColumn.nullable ?? true;
			if (schemaNullable !== dbColumn.isNullable) {
				issues.push({
					severity: 'warning',
					type: 'nullable_mismatch',
					table: tableName,
					column: columnName,
					message: `Column "${tableName}.${columnName}" nullable mismatch: schema=${schemaNullable}, database=${dbColumn.isNullable}`,
				});
			}
		}

		// Check for columns in DB but not in schema
		for (const columnName of dbColumnNames) {
			if (!schemaColumnNames.includes(columnName)) {
				issues.push({
					severity: 'info',
					type: 'missing_column_in_schema',
					table: tableName,
					column: columnName,
					message: `Column "${tableName}.${columnName}" exists in database but not in schema`,
				});
			}
		}
	}

	// Sort issues by severity (error > warning > info)
	const severityOrder = { error: 0, warning: 1, info: 2 };
	issues.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

	// Valid if no errors
	const hasErrors = issues.some((i) => i.severity === 'error');

	return {
		valid: !hasErrors,
		issues,
		schemaTables: schemaTableNames,
		dbTables: dbTableNames,
	};
}

/**
 * Format verification result for CLI output.
 */
export function formatVerifyResult(result: VerifyResult): string {
	const lines: string[] = [];

	if (result.valid) {
		lines.push('✅ Schema matches database');
	} else {
		lines.push('❌ Schema drift detected');
	}

	lines.push('');
	lines.push(`Tables in schema: ${result.schemaTables.length}`);
	lines.push(`Tables in database: ${result.dbTables.length}`);
	lines.push('');

	if (result.issues.length === 0) {
		lines.push('No issues found.');
	} else {
		const errors = result.issues.filter((i) => i.severity === 'error');
		const warnings = result.issues.filter((i) => i.severity === 'warning');
		const infos = result.issues.filter((i) => i.severity === 'info');

		if (errors.length > 0) {
			lines.push(`❌ ${errors.length} error(s):`);
			for (const issue of errors) {
				lines.push(`   ${issue.message}`);
			}
			lines.push('');
		}

		if (warnings.length > 0) {
			lines.push(`⚠️  ${warnings.length} warning(s):`);
			for (const issue of warnings) {
				lines.push(`   ${issue.message}`);
			}
			lines.push('');
		}

		if (infos.length > 0) {
			lines.push(`ℹ️  ${infos.length} info:`);
			for (const issue of infos) {
				lines.push(`   ${issue.message}`);
			}
			lines.push('');
		}
	}

	return lines.join('\n');
}
