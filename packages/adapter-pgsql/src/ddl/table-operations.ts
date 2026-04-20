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
import { formatSqlDefault, quoteIdent } from './phases/utils.js';

// S-2: quoteIdentifier now delegates to quoteIdent (validates + double-quotes).
// The former local helper was bare `"${name}"` with no validation.
function quoteIdentifier(name: string): string {
	return quoteIdent(name, 'alias');
}

function qualifyTable(table: string, schema?: string): string {
	return schema
		? `${quoteIdent(schema, 'schema')}.${quoteIdent(table, 'table')}`
		: quoteIdent(table, 'table');
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

// M-6: formatDefault is now a thin alias for the shared formatSqlDefault from phases/utils.
// The duplicate implementations have been consolidated.
function formatDefault(value: unknown): string {
	return formatSqlDefault(value, 'table-operations default');
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
