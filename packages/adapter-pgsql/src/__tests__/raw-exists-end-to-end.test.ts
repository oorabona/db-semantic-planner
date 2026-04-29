/**
 * End-to-end regression tests for rawExists / rawNotExists through the
 * full SELECT pipeline: DX API → planner → intent-to-decisions → compiler → SQL.
 *
 * L103 regression lock: before the fix, rawExists/rawNotExists were silently
 * dropped in convertWhereCondition (default: return null). These tests MUST
 * fail on main (no WHERE clause produced) and pass after the fix.
 *
 * All tests use createPgsqlCompileOnlyAdapter + createOrm (compile-only path,
 * no database connection required).
 */

import {
	and,
	createOrm,
	eq,
	or,
	outerRef,
	rawExists,
	rawNotExists,
	schema,
	subquery,
} from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const testSchema = schema({
	communities: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
		created_at: { type: 'timestamp' },
	},
	files: {
		id: { type: 'integer', primaryKey: true },
		community_id: { type: 'integer' },
		last_parsed: { type: 'timestamp' },
	},
} as const);

function buildOrm() {
	const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });
	return createOrm({ model: testSchema.model, adapter });
}

/** Normalize whitespace for SQL comparison. */
function ws(sql: string): string {
	return sql.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('rawExists / rawNotExists — SELECT pipeline (L103 regression lock)', () => {
	/**
	 * 1. Proof scenario from Observable Success.
	 *
	 * BEFORE fix: dump.sql === 'SELECT * FROM "communities"' — no WHERE clause.
	 * AFTER fix:  dump.sql contains WHERE EXISTS (SELECT ...).
	 */
	it('rawExists emits WHERE EXISTS clause (proof — fails on main)', () => {
		const orm = buildOrm();
		const dump = (orm as any)
			.select('communities')
			.where(rawExists(subquery('files').select('id')))
			.dump();

		const sql = ws(dump.sql);

		// The WHERE clause MUST be present — this was the bug.
		expect(sql).toMatch(/WHERE/i);
		expect(sql).toMatch(/EXISTS\s*\(/i);
		// The subquery table must appear.
		expect(sql).toContain('files');
	});

	/**
	 * 2. rawNotExists emits WHERE NOT EXISTS clause.
	 */
	it('rawNotExists emits WHERE NOT EXISTS clause', () => {
		const orm = buildOrm();
		const dump = (orm as any)
			.select('communities')
			.where(rawNotExists(subquery('files').select('id')))
			.dump();

		const sql = ws(dump.sql);

		expect(sql).toMatch(/WHERE/i);
		// Deparser may produce "NOT (EXISTS (...))" or "NOT EXISTS (...)" — both are correct.
		expect(sql).toMatch(/NOT\s+\(?EXISTS\s*\(/i);
		expect(sql).toContain('files');
	});

	/**
	 * 3. Correlated rawExists with outerRef — NOT YET SUPPORTED. The pipeline
	 *    throws at decision-time so callers don't get silently-broken SQL
	 *    (which is what the previous untested path produced — outerRef was
	 *    parameterized as $N with the SubqueryRefIntent object literal).
	 *    Tracked for follow-up: wire correlation through buildSubqueryFromIntent
	 *    by setting up an outerAlias context.
	 */
	it('rawExists with outerRef throws "not yet supported" (boundary documented)', () => {
		const orm = buildOrm();
		expect(() =>
			(orm as any)
				.select('communities')
				.where(
					rawExists(
						subquery('files')
							.where(eq('community_id', outerRef('id')))
							.select('id'),
					),
				)
				.dump(),
		).toThrow(/correlated subqueries.*not yet supported/i);
	});

	/**
	 * 4. rawExists combined with another WHERE filter via and() — both conditions
	 *    must appear in the SQL.
	 */
	it('rawExists combined with and() produces both conditions in SQL', () => {
		const orm = buildOrm();
		const dump = (orm as any)
			.select('communities')
			.where(and(eq('name', 'acme'), rawExists(subquery('files').select('id'))))
			.dump();

		const sql = ws(dump.sql);

		expect(sql).toMatch(/WHERE/i);
		expect(sql).toMatch(/EXISTS\s*\(/i);
		// The scalar comparison must also appear.
		expect(sql).toContain('$1');
		expect(dump.params).toEqual(['acme']);
	});

	/**
	 * 5. rawExists with subquery that has no WHERE — empty subquery does not crash
	 *    and emits EXISTS (SELECT ... FROM ...).
	 */
	it('rawExists with no-WHERE subquery does not crash and emits EXISTS', () => {
		const orm = buildOrm();

		expect(() => {
			const dump = (orm as any)
				.select('communities')
				.where(rawExists(subquery('files').select('id')))
				.dump();

			const sql = ws(dump.sql);
			expect(sql).toMatch(/EXISTS\s*\(/i);
			expect(sql).toContain('files');
		}).not.toThrow();
	});

	/**
	 * 6. rawExists with inner WHERE parameter — parameter propagates correctly.
	 */
	it('rawExists with parameterized inner WHERE propagates parameters', () => {
		const orm = buildOrm();
		const dump = (orm as any)
			.select('communities')
			.where(
				rawExists(subquery('files').where(eq('community_id', 42)).select('id')),
			)
			.dump();

		const sql = ws(dump.sql);

		expect(sql).toMatch(/WHERE/i);
		expect(sql).toMatch(/EXISTS\s*\(/i);
		expect(dump.params).toContain(42);
	});

	/**
	 * 7. rawExists inside or() — exercises convertLogicalGroup recursion path.
	 *    Locks the regression that OR routing also walks through convertWhereCondition.
	 */
	it('rawExists in or() group propagates EXISTS to SQL', () => {
		const orm = buildOrm();
		const dump = (orm as any)
			.select('communities')
			.where(or(eq('id', 1), rawExists(subquery('files').select('id'))))
			.dump();

		const sql = ws(dump.sql);

		expect(sql).toMatch(/WHERE/i);
		expect(sql).toMatch(/EXISTS\s*\(/i);
		// Both branches of OR must appear
		expect(sql).toMatch(/OR/i);
	});

	/**
	 * 8. Nested rawExists boundary — the inner WhereCompilerCtx's compileSubquery
	 *    callback throws "nested subquery not supported" by design. This test
	 *    documents that boundary so any future change to that contract is loud.
	 */
	it('nested rawExists throws "nested subquery not supported" (documented boundary)', () => {
		const orm = buildOrm();
		expect(() =>
			(orm as any)
				.select('communities')
				.where(
					rawExists(
						subquery('files')
							.where(rawExists(subquery('files').select('id')))
							.select('id'),
					),
				)
				.dump(),
		).toThrow(/nested subquery not supported/i);
		// (kept multi-line: nested method-chain readability > biome single-line preference)
	});
});
