/**
 * SQL Injection checks for migration-sql formatDefault({ sql }) escape hatch.
 *
 * Covers the local formatDefault() function used by upAddColumn,
 * upAlterColumnDefault, changeToDownSQL, and generateCreateTableSQL.
 *
 * @see packages/adapter-pgsql/src/ddl/migration-sql.ts (formatDefault, L1129)
 */

import { describe, expect, it } from 'vitest';
import { generateMigrationSQL } from '../ddl/migration-sql.js';
import type { SchemaChange, SchemaDiff } from '../ddl/schema-diff.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDiff(changes: SchemaChange[]): SchemaDiff {
	return {
		changes,
		hasDestructive: changes.some((c) => c.destructive),
		summary: {
			tables: { added: 0, dropped: 0 },
			columns: { added: 0, dropped: 0, altered: 0 },
			indexes: { added: 0, dropped: 0 },
			constraints: { added: 0, dropped: 0, altered: 0 },
		},
	};
}

function addColumnWithDefault(defaultVal: unknown): () => void {
	return () =>
		generateMigrationSQL(
			makeDiff([
				{
					kind: 'add_column',
					table: 'users',
					column: 'created_at',
					destructive: false,
					details: '',
					meta: {
						column: {
							name: 'created_at',
							type: 'timestamp',
							nullable: true,
							default: defaultVal,
						},
					},
				},
			]),
		);
}

function alterColumnDefaultWith(defaultVal: unknown): () => void {
	return () =>
		generateMigrationSQL(
			makeDiff([
				{
					kind: 'alter_column_default',
					table: 'users',
					column: 'created_at',
					destructive: false,
					details: '',
					meta: { default: defaultVal },
				},
			]),
		);
}

// ── Injection tests: upAddColumn path ────────────────────────────────────────

describe('SQL Injection Checks — migration-sql formatDefault({ sql }) via upAddColumn (DDL-MIGRATION-001)', () => {
	it('throws on semicolon injection', () => {
		expect(addColumnWithDefault({ sql: 'NOW(); DROP TABLE users --' })).toThrow(
			/Unsafe SQL expression/,
		);
	});

	it('throws on line-comment injection (--)', () => {
		expect(addColumnWithDefault({ sql: 'NOW() -- injected' })).toThrow(
			/Unsafe SQL expression/,
		);
	});

	it('throws on block-comment injection (/*)', () => {
		expect(addColumnWithDefault({ sql: "/* comment */ 'active'" })).toThrow(
			/Unsafe SQL expression/,
		);
	});

	it('throws on dollar-quote injection ($$)', () => {
		// Construct $$ without literal dollar-signs in source
		const dollar = String.fromCharCode(36);
		const dollarQuote = dollar + dollar;
		expect(
			addColumnWithDefault({ sql: `${dollarQuote}injected${dollarQuote}` }),
		).toThrow(/Unsafe SQL expression/);
	});

	it('rejects backslash in { sql }', () => {
		expect(addColumnWithDefault({ sql: 'NOW() \\foo' })).toThrow(
			/Unsafe SQL expression/,
		);
	});

	it('allows safe expression NOW()', () => {
		expect(addColumnWithDefault({ sql: 'NOW()' })).not.toThrow();
	});
});

// ── Injection tests: upAlterColumnDefault path ───────────────────────────────

describe('SQL Injection Checks — migration-sql formatDefault({ sql }) via upAlterColumnDefault (DDL-MIGRATION-002)', () => {
	it('throws on semicolon injection', () => {
		expect(
			alterColumnDefaultWith({ sql: 'NOW(); DROP TABLE users --' }),
		).toThrow(/Unsafe SQL expression/);
	});

	it('throws on line-comment injection (--)', () => {
		expect(alterColumnDefaultWith({ sql: 'NOW() -- injected' })).toThrow(
			/Unsafe SQL expression/,
		);
	});

	it('throws on block-comment injection (/*)', () => {
		expect(alterColumnDefaultWith({ sql: "/* comment */ 'active'" })).toThrow(
			/Unsafe SQL expression/,
		);
	});

	it('throws on dollar-quote injection ($$)', () => {
		const dollar = String.fromCharCode(36);
		const dollarQuote = dollar + dollar;
		expect(
			alterColumnDefaultWith({ sql: `${dollarQuote}injected${dollarQuote}` }),
		).toThrow(/Unsafe SQL expression/);
	});

	it('rejects backslash in { sql }', () => {
		expect(alterColumnDefaultWith({ sql: 'NOW() \\foo' })).toThrow(
			/Unsafe SQL expression/,
		);
	});

	it('allows safe expression gen_random_uuid()', () => {
		expect(alterColumnDefaultWith({ sql: 'gen_random_uuid()' })).not.toThrow();
	});
});
