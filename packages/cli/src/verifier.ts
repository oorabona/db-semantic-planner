/**
 * Schema Verifier — Drift Detection via Comparison Engine
 *
 * Compares schema definition against real database using the
 * adapter's compareSchemata engine for full drift detection.
 *
 * Detects: tables, columns, types, nullable, defaults, FKs, indexes, PKs.
 */

import type { ChangeKind, SchemaChange, SchemaDiff } from '@dbsp/adapter-pgsql';

// ============================================================================
// Types
// ============================================================================

export type DriftSeverity = 'error' | 'warning' | 'info';

export type DriftType =
	// Tables
	| 'missing_table_in_db'
	| 'missing_table_in_schema'
	// Columns
	| 'missing_column_in_db'
	| 'missing_column_in_schema'
	| 'type_mismatch'
	| 'nullable_mismatch'
	| 'default_mismatch'
	// Constraints
	| 'primary_key_mismatch'
	| 'missing_fk_in_db'
	| 'missing_fk_in_schema'
	| 'fk_on_delete_mismatch'
	// Indexes
	| 'missing_index_in_db'
	| 'missing_index_in_schema'
	// CHECK constraints
	| 'missing_check_in_db'
	| 'missing_check_in_schema'
	// ENUM types
	| 'missing_enum_in_db'
	| 'missing_enum_in_schema'
	| 'enum_value_mismatch'
	// Column enhancements
	| 'collation_mismatch'
	| 'identity_mismatch'
	// Comments
	| 'comment_mismatch'
	// Extensions & Sequences
	| 'missing_extension'
	| 'missing_sequence'
	| 'sequence_mismatch';

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

export interface VerifyResult {
	/** Whether the schema matches the database */
	valid: boolean;
	/** List of drift issues found */
	issues: DriftIssue[];
	/** Tables in schema */
	schemaTables: string[];
	/** Tables in database */
	dbTables: string[];
	/** Structured diff (for programmatic consumers) */
	diff: SchemaDiff;
}

/**
 * @deprecated Use DbTableInfo from introspection instead.
 * Kept for backward compatibility with existing tests.
 */
export interface DbTableInfo {
	name: string;
	columns: DbColumnInfo[];
}

/**
 * @deprecated Use ColumnIR from introspection instead.
 */
export interface DbColumnInfo {
	name: string;
	dataType: string;
	isNullable: boolean;
	isPrimaryKey?: boolean;
	hasDefault?: boolean;
}

// ============================================================================
// Change → Drift Mapping
// ============================================================================

const CHANGE_TO_DRIFT: Record<
	ChangeKind,
	{ type: DriftType; severity: DriftSeverity }
> = {
	create_table: { type: 'missing_table_in_db', severity: 'error' },
	drop_table: { type: 'missing_table_in_schema', severity: 'warning' },
	add_column: { type: 'missing_column_in_db', severity: 'error' },
	drop_column: { type: 'missing_column_in_schema', severity: 'info' },
	alter_column_type: { type: 'type_mismatch', severity: 'error' },
	alter_column_nullable: { type: 'nullable_mismatch', severity: 'warning' },
	alter_column_default: { type: 'default_mismatch', severity: 'warning' },
	add_primary_key: { type: 'primary_key_mismatch', severity: 'error' },
	drop_primary_key: { type: 'primary_key_mismatch', severity: 'error' },
	add_foreign_key: { type: 'missing_fk_in_db', severity: 'error' },
	drop_foreign_key: { type: 'missing_fk_in_schema', severity: 'warning' },
	alter_foreign_key: { type: 'fk_on_delete_mismatch', severity: 'warning' },
	create_index: { type: 'missing_index_in_db', severity: 'warning' },
	drop_index: { type: 'missing_index_in_schema', severity: 'info' },
	// CHECK constraints
	add_check_constraint: { type: 'missing_check_in_db', severity: 'warning' },
	drop_check_constraint: { type: 'missing_check_in_schema', severity: 'info' },
	// ENUM types
	create_enum: { type: 'missing_enum_in_db', severity: 'error' },
	alter_enum_add_value: { type: 'enum_value_mismatch', severity: 'warning' },
	drop_enum: { type: 'missing_enum_in_schema', severity: 'warning' },
	// Column enhancements
	alter_column_collation: { type: 'collation_mismatch', severity: 'warning' },
	alter_column_identity: { type: 'identity_mismatch', severity: 'warning' },
	// Comments
	add_comment: { type: 'comment_mismatch', severity: 'info' },
	drop_comment: { type: 'comment_mismatch', severity: 'info' },
	// Extensions & Sequences
	create_extension: { type: 'missing_extension', severity: 'error' },
	drop_extension: { type: 'missing_extension', severity: 'info' },
	create_sequence: { type: 'missing_sequence', severity: 'warning' },
	alter_sequence: { type: 'sequence_mismatch', severity: 'warning' },
	drop_sequence: { type: 'missing_sequence', severity: 'info' },
};

function changeToDriftIssue(change: SchemaChange): DriftIssue {
	const mapping = CHANGE_TO_DRIFT[change.kind] ?? {
		type: 'type_mismatch' as DriftType,
		severity: 'warning' as DriftSeverity,
	};
	return {
		severity: mapping.severity,
		type: mapping.type,
		table: change.table,
		...(change.column !== undefined ? { column: change.column } : {}),
		message: change.details,
	};
}

// ============================================================================
// Verification (from SchemaDiff)
// ============================================================================

/**
 * Convert a SchemaDiff into a VerifyResult.
 *
 * @param diff - Structured diff from compareSchemata()
 * @param schemaTables - Table names in schema (for backward compat)
 * @param dbTables - Table names in database (for backward compat)
 */
export function verifyFromDiff(
	diff: SchemaDiff,
	schemaTables: string[],
	dbTables: string[],
): VerifyResult {
	const issues = diff.changes.map(changeToDriftIssue);

	// Sort by severity (error > warning > info)
	const severityOrder: Record<DriftSeverity, number> = {
		error: 0,
		warning: 1,
		info: 2,
	};
	issues.sort(
		(a: DriftIssue, b: DriftIssue) =>
			severityOrder[a.severity] - severityOrder[b.severity],
	);

	const hasErrors = issues.some((i: DriftIssue) => i.severity === 'error');

	return {
		valid: !hasErrors,
		issues,
		schemaTables,
		dbTables,
		diff,
	};
}

// ============================================================================
// Format
// ============================================================================

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
