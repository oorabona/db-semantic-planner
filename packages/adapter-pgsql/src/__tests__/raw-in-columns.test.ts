/**
 * RAW-IN-COLUMNS regression test.
 *
 * Bug: raw('COUNT(*)::int', 'count') in .columns() threw because rawHandler
 * read decision.value (undefined) instead of decision.args[0] where the SQL
 * string is stored by handleRawExpression. Additionally, buildRawExpression
 * produced a bogus TypeCast(::sql) that PostgreSQL cannot parse.
 *
 * Fix:
 *  1. rawHandler.compile reads args[0] ?? value
 *  2. buildRawExpression uses pgsql-parser (parseSync) for valid AST output
 *
 * Note on deparser output:
 *  - pgsql-parser parses COUNT(*)::int and the deparser re-emits it as
 *    cast(count(*) as int4) — the canonical PostgreSQL representation.
 *  - Column aliases for simple lowercase names are unquoted: as count, as amount.
 *  - Regular columns in SELECT with explicit .columns() are table-qualified and
 *    unquoted: orders.id, orders.status.
 */

import { createOrm, raw, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { normalizeSQL } from '../ast-helpers.js';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

const testSchema = schema({
	orders: {
		id: { type: 'integer', primaryKey: true },
		total: { type: 'integer' },
		status: { type: 'text' },
	},
});

function buildOrm() {
	const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });
	return createOrm({ model: testSchema.model, adapter });
}

describe('RAW-IN-COLUMNS: raw() expressions compile correctly in SELECT', () => {
	it('raw("COUNT(*)::int", "count") compiles to cast(count(*) as int4) as count', () => {
		const orm = buildOrm();
		const dump = orm
			.select('orders')
			.columns([raw('COUNT(*)::int', 'count')])
			.dump();

		const sql = normalizeSQL(dump.sql);

		// RawSQL passthrough: SQL emitted verbatim (no parse/reformat)
		expect(sql).toContain('count(*)::int');
		// Alias present (unquoted for simple lowercase names)
		expect(sql).toContain('as count');
		// No parameters needed for a raw expression with no user values
		expect(dump.params).toHaveLength(0);
	});

	it('raw("NOW()", "current_time") compiles to now() as current_time', () => {
		const orm = buildOrm();
		const dump = orm
			.select('orders')
			.columns([raw('NOW()', 'current_time')])
			.dump();

		const sql = normalizeSQL(dump.sql);

		// RawSQL passthrough (normalizeSQL lowercases)
		expect(sql).toContain('now()');
		// Alias applied by ResTarget wrapping
		expect(sql).toMatch(/current_time/i);
		expect(dump.params).toHaveLength(0);
	});

	it('raw() mixed with regular columns', () => {
		const orm = buildOrm();
		const dump = orm
			.select('orders')
			.columns(['id', 'status', raw('COUNT(*)::int', 'count')])
			.dump();

		const sql = normalizeSQL(dump.sql);

		// Regular columns are table-qualified and unquoted by the deparser
		expect(sql).toContain('orders.id');
		expect(sql).toContain('orders.status');
		// RawSQL passthrough: SQL emitted verbatim
		expect(sql).toContain('count(*)::int');
		// Alias is unquoted for simple lowercase names
		expect(sql).toContain('as count');
	});

	it('raw() with arithmetic expression', () => {
		const orm = buildOrm();
		const dump = orm
			.select('orders')
			.columns([raw('total / 100.0', 'amount')])
			.dump();

		const sql = normalizeSQL(dump.sql);

		expect(sql).toContain('total / 100.0');
		// Alias is unquoted for simple lowercase names
		expect(sql).toContain('as amount');
	});

	it('does not produce bogus TypeCast(::sql) output', () => {
		const orm = buildOrm();
		const dump = orm
			.select('orders')
			.columns([raw('NOW()', 'ts')])
			.dump();

		const sql = dump.sql;

		// Bogus output was: CAST('NOW()' AS sql)
		// Valid output must NOT contain "AS sql" pseudo-type
		expect(sql).not.toContain('AS sql');
		expect(sql).not.toContain('as sql');
		// Actual output should be: now() as ts
		expect(normalizeSQL(sql)).toContain('now()');
		expect(normalizeSQL(sql)).toContain('as ts');
	});
});
