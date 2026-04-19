/**
 * Table-level DDL SQL generators for PostgreSQL.
 *
 * @module ddl/table-operations
 */

import type {
	AlterColumnOptions,
	TruncateOptions,
	VacuumOptions,
} from '@dbsp/core';
import { validateDbTypeName } from '../validate.js';

function quoteIdentifier(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

function qualifyTable(table: string, schema?: string): string {
	const quotedTable = quoteIdentifier(table);
	return schema ? `${quoteIdentifier(schema)}.${quotedTable}` : quotedTable;
}

export function generateTruncateSQL(
	table: string,
	schema?: string,
	options?: TruncateOptions,
): string {
	const target = qualifyTable(table, schema);
	const parts: string[] = [`TRUNCATE ${target}`];
	if (options?.restartIdentity) parts.push('RESTART IDENTITY');
	if (options?.cascade) parts.push('CASCADE');
	return parts.join(' ');
}

export function generateVacuumSQL(
	table: string,
	_schema?: string,
	options?: VacuumOptions,
): string {
	const modifiers: string[] = [];
	if (options?.full) modifiers.push('FULL');
	if (options?.analyze) modifiers.push('ANALYZE');
	const modifier = modifiers.length > 0 ? ` ${modifiers.join(' ')}` : '';
	return `VACUUM${modifier} ${quoteIdentifier(table)}`;
}

function formatDefault(value: unknown): string {
	if (value === null) return 'NULL';
	// { sql: string } escape hatch — emit verbatim (used by introspection-sourced defaults)
	if (typeof value === 'object' && value !== null && 'sql' in value) {
		return (value as Record<string, unknown>).sql as string;
	}
	if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
	if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
	return String(value);
}

export function generateAlterColumnSQL(
	table: string,
	column: string,
	options: AlterColumnOptions,
	schema?: string,
): string {
	const target = qualifyTable(table, schema);
	const quotedCol = quoteIdentifier(column);
	const prefix = `ALTER TABLE ${target} ALTER COLUMN ${quotedCol}`;
	const statements: string[] = [];
	if (options.type !== undefined) {
		const safeType = validateDbTypeName(options.type);
		const using = options.using !== undefined ? ` USING ${options.using}` : '';
		statements.push(`${prefix} TYPE ${safeType}${using}`);
	}
	if (options.setNotNull === true) {
		statements.push(`${prefix} SET NOT NULL`);
	} else if (options.setNotNull === false) {
		statements.push(`${prefix} DROP NOT NULL`);
	}
	if (options.setDefault !== undefined) {
		statements.push(
			`${prefix} SET DEFAULT ${formatDefault(options.setDefault)}`,
		);
	}
	if (options.dropDefault === true) {
		statements.push(`${prefix} DROP DEFAULT`);
	}
	if (statements.length === 0) {
		throw new Error(
			'generateAlterColumnSQL: at least one option must be specified',
		);
	}
	return statements.join(';\n');
}
