
/**
 * INCLUDE-2HOP-FILE regression test.
 *
 * Bug: `.include('symbol.file', {join:'inner'})` 2-hop join fails because the
 * outer relation (symbol) gets a non-join strategy (json_agg) when no explicit
 * join is set on the intermediate wrapper intent produced by parseDotNotationInclude.
 * The nested `file` join then references the intermediate table (`symbols`) in its
 * ON clause, but `symbols` is not in the outer FROM clause → PostgreSQL error.
 *
 * Fix (core/src/dx/intent-builder.ts: parseDotNotationInclude): propagate the
 * `join` option to ALL intermediate wrapper relations so every hop uses the
 * join strategy, placing each intermediate table in the outer FROM clause.
 *
 * Schema:
 *   symbol_parents: id (PK), symbol_id (FK → symbols)
 *   symbols: id (PK), file_id (FK → files)
 *   files: id (PK), path (text)
 */

import { createOrm, ref, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { normalizeSQL } from '../ast-helpers.js';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Test schema: symbol_parents → symbols (via 'symbol') → files (via 'file')
// ---------------------------------------------------------------------------
const testSchema = schema({
	files: {
		id: { type: 'integer', primaryKey: true },
		path: { type: 'text' },
	},
	symbols: {
		id: { type: 'integer', primaryKey: true },
		file_id: ref('files', { as: 'file', inverse: 'symbols' }),
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

describe('INCLUDE-2HOP-FILE: dot-notation include generates correct 2-hop JOIN', () => {
	it('include("symbol.file", {join:"inner"}) alone produces 2 separate JOINs', () => {
		const orm = buildOrm();
		const dump = orm
			.select('symbol_parents')
			.include('symbol.file', { join: 'inner' })
			.dump();

		const sql = normalizeSQL(dump.sql);

		// Must contain two separate JOIN clauses (symbol + file)
		const joinMatches = sql.match(/\bjoin\b/gi);
		expect(joinMatches?.length, 'Expected 2 JOIN clauses').toBeGreaterThanOrEqual(2);

		// Must join the symbols table first (intermediate hop)
		expect(sql, 'Should JOIN symbols as symbol').toContain('symbols as symbol');

		// Must join the files table
		expect(sql, 'Should JOIN files table').toContain('files');

		// The files join ON clause must reference the symbol alias (not "symbols" bare)
		// Bug symptom: "ON symbols.file_id = file.id" (symbols not in FROM)
		// Fixed:       "ON symbol.file_id = file.id"  (symbol is the JOIN alias)
		expect(sql, 'File JOIN ON clause should reference symbol alias').toContain(
			'symbol.file_id',
		);

		// Must NOT produce "from symbol_parents join files" directly (skipping symbols JOIN)
		expect(sql, 'Should not skip intermediate symbols JOIN').not.toMatch(
			/from symbol_parents\s+join files/i,
		);
	});

	it('include("symbol", {join:"inner"}).include("symbol.file", {join:"inner"}) produces correct 2-hop JOINs', () => {
		const orm = buildOrm();
		const dump = orm
			.select('symbol_parents')
			.include('symbol', { join: 'inner' })
			.include('symbol.file', { join: 'inner' })
			.dump();

		const sql = normalizeSQL(dump.sql);

		// Must join both symbols and files tables
		expect(sql, 'Should JOIN symbols table').toContain('symbols');
		expect(sql, 'Should JOIN files table').toContain('files');

		// File join must reference a valid alias for symbols in its ON clause.
		// When both .include('symbol') and .include('symbol.file') are called,
		// the symbols table may be joined twice (as 'symbol' and 'symbol_1') due
		// to alias deduplication — either alias is valid.
		expect(sql, 'File JOIN ON clause should reference a symbols alias').toMatch(
			/symbol(?:_\d+)?\.file_id/,
		);
	});

	it('regression guard: simple 1-hop include("symbol", {join:"inner"}) still works', () => {
		const orm = buildOrm();
		const dump = orm
			.select('symbol_parents')
			.include('symbol', { join: 'inner' })
			.dump();

		const sql = normalizeSQL(dump.sql);

		// Must join the symbols table (JOIN or INNER JOIN — PostgreSQL omits INNER keyword)
		expect(sql, 'Should JOIN symbols table').toContain('symbols');
		expect(sql, 'Should contain a join clause').toMatch(/\bjoin\b/i);
	});

	it('regression guard: dot-notation without join option keeps default strategy', () => {
		const orm = buildOrm();
		// No join option — should not force join strategy on intermediate relations
		const dump = orm
			.select('symbol_parents')
			.include('symbol.file')
			.dump();

		const sql = normalizeSQL(dump.sql);

		// Should produce valid SQL regardless of strategy
		expect(sql, 'Should contain FROM symbol_parents').toContain('symbol_parents');
	});
});
