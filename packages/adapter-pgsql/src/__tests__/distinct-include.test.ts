/**
 * DISTINCT-VECTOR regression test.
 *
 * Bug: `.distinct()` combined with `.include('rel', {join:'inner'})` includes
 * ALL columns from the joined table in the SELECT DISTINCT list. If the joined
 * table contains a `vector(1024)` column, PostgreSQL rejects the query because
 * vector has no equality operator (required for DISTINCT).
 *
 * Fix (adapter-compiler-select.ts: compileSelect): when `plan.intent?.distinct`
 * is true, clear the `columns` list from join includeStrategy decisions — same
 * pattern as the INCLUDE-COUNT fix for aggregate-only queries. The JOIN itself
 * is kept (for filtering), but the joined table's columns are not added to the
 * SELECT list unless explicitly requested via `relationColumn()`.
 *
 * Schema:
 *   symbols: id (PK), name (text), embedding (vector(1024))
 *   symbol_parents: id (PK), symbol_id (FK → symbols)
 */

import { createOrm, ref, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { normalizeSQL } from '../ast-helpers.js';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Test schema: symbol_parents → symbols (symbols has a vector column)
// ---------------------------------------------------------------------------
const testSchema = schema({
	symbols: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
		embedding: { type: 'vector(1024)' as any },
	},
	symbol_parents: {
		id: { type: 'integer', primaryKey: true },
		symbol_id: ref('symbols', { as: 'symbol', inverse: 'parents' }),
	},
});

function buildOrm() {
	const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });
	return createOrm({ model: testSchema.model, adapter });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DISTINCT-VECTOR: DISTINCT with join include does not leak vector columns', () => {
	it('.distinct().include("symbol", {join:"inner"}) does NOT add symbol.* to SELECT', () => {
		const orm = buildOrm();
		const dump = (orm as any)
			.select('symbol_parents')
			.distinct()
			.include('symbol', { join: 'inner' })
			.dump();

		const sql = normalizeSQL(dump.sql);

		// Must contain DISTINCT keyword
		expect(sql, 'Should contain DISTINCT').toContain('distinct');

		// Must contain JOIN (needed for filtering)
		expect(sql, 'Should contain JOIN').toMatch(/\bjoin\b/i);

		// Must NOT select symbol columns (especially not the vector column)
		// Without fix: "SELECT DISTINCT ..., symbol.id AS "symbol.id", symbol.name AS "symbol.name", symbol.embedding AS "symbol.embedding""
		expect(
			sql,
			'Should NOT include symbol.id in SELECT DISTINCT',
		).not.toContain('"symbol.id"');
		expect(
			sql,
			'Should NOT include symbol.embedding in SELECT DISTINCT',
		).not.toContain('symbol.embedding');
	});

	it('.distinct().include("symbol", {join:"inner"}).columns(["id", "symbol_id"]) selects only explicit columns', () => {
		const orm = buildOrm();
		const dump = (orm as any)
			.select('symbol_parents')
			.distinct()
			.columns(['id', 'symbol_id'])
			.include('symbol', { join: 'inner' })
			.dump();

		const sql = normalizeSQL(dump.sql);

		// Must contain DISTINCT keyword
		expect(sql, 'Should contain DISTINCT').toContain('distinct');

		// Must contain JOIN (needed for filtering)
		expect(sql, 'Should contain JOIN').toMatch(/\bjoin\b/i);

		// Must select id and symbol_id from the root table
		expect(sql, 'Should select id').toContain('symbol_parents.id');
		expect(sql, 'Should select symbol_id').toContain('symbol_id');

		// Must NOT select symbol.embedding (the vector column that breaks DISTINCT)
		expect(
			sql,
			'Should NOT include vector column in SELECT DISTINCT',
		).not.toContain('embedding');
	});

	it('regression guard: without .distinct(), join include still adds symbol.* to SELECT', () => {
		const orm = buildOrm();
		const dump = (orm as any)
			.select('symbol_parents')
			.include('symbol', { join: 'inner' })
			.dump();

		const sql = normalizeSQL(dump.sql);

		// Without DISTINCT, join columns should be included (current behavior)
		expect(sql, 'Should NOT contain DISTINCT').not.toContain('distinct');

		// Must still contain JOIN
		expect(sql, 'Should contain JOIN').toMatch(/\bjoin\b/i);

		// Symbol columns should appear in SELECT (normal include behavior)
		expect(sql, 'Should include symbol.id in non-DISTINCT SELECT').toContain(
			'"symbol.id"',
		);
	});

	it('regression guard: .distinct() without join include keeps DISTINCT behavior', () => {
		const orm = buildOrm();
		const dump = orm.select('symbol_parents').distinct().columns(['id']).dump();

		const sql = normalizeSQL(dump.sql);

		// Must contain DISTINCT
		expect(sql, 'Should contain DISTINCT').toContain('distinct');

		// Must NOT contain JOIN (no include)
		expect(sql, 'Should NOT contain JOIN').not.toMatch(/\bjoin\b/i);
	});
});
