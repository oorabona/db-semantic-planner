
/**
 * Regression test: notExists() nested inside and() must produce exactly ONE NOT EXISTS clause.
 *
 * Bug: convertWhereCondition processed notExists inside and() as a whereAnd containing
 * a broken notExists (relation name as targetTable). extractExistsDecisions ALSO processed
 * the same intent from the planner's filter-strategy decision (correct table name).
 * Result: two NOT EXISTS clauses — one with "calls", one with "callee_calls".
 *
 * Fix: stripExistsFromDecision() recursively removes exists/notExists from whereAnd/whereOr/
 * whereNot decision trees so only the planner-resolved decisions survive.
 */

import { and, createOrm, eq, notExists, ref, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Test schema (mirrors the consumer's schema)
// ---------------------------------------------------------------------------

const testSchema = schema({
	projects: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
	},
	files: {
		id: { type: 'integer', primaryKey: true },
		path: { type: 'text' },
		project_id: ref('projects', { as: 'project', inverse: 'files' }),
	},
	symbols: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
		exported: { type: 'boolean' },
		file_id: ref('files', { as: 'file', inverse: 'symbols' }),
	},
	calls: {
		id: { type: 'integer', primaryKey: true },
		callee_id: ref('symbols', { as: 'callee', inverse: 'callee_calls' }),
		caller_id: ref('symbols', { as: 'caller', inverse: 'caller_calls' }),
	},
});

function buildOrm() {
	const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });
	return createOrm({ model: testSchema.model, adapter });
}

/** Normalize whitespace for SQL comparison. */
function ws(sql: string): string {
	return sql.replace(/\s+/g, ' ').trim();
}

/** Count non-overlapping regex matches in a string. */
function countMatches(str: string, pattern: RegExp): number {
	return (str.match(pattern) ?? []).length;
}

// ---------------------------------------------------------------------------
// Core regression: notExists inside and() — exactly ONE NOT EXISTS
// ---------------------------------------------------------------------------

describe('notExists() inside and() — duplicate NOT EXISTS regression', () => {
	it('produces exactly one NOT EXISTS clause (not two)', () => {
		const orm = buildOrm();

		const dump = orm
			.select('symbols')
			.where(
				and(
					eq('exported', true),
					notExists('callee_calls'),
				),
			)
			.dump();

		const normalized = ws(dump.sql);

		// Must have exactly one NOT EXISTS (two would indicate the bug)
		const notExistsCount = countMatches(normalized, /NOT\s*\(?\s*EXISTS/gi);
		expect(notExistsCount).toBe(1);
	});

	it('uses the actual table name "calls", not the relation name "callee_calls"', () => {
		const orm = buildOrm();

		const dump = orm
			.select('symbols')
			.where(
				and(
					eq('exported', true),
					notExists('callee_calls'),
				),
			)
			.dump();

		const normalized = ws(dump.sql);

		// Must reference the actual table "calls"
		expect(normalized).toMatch(/FROM\s+"?calls"?/i);

		// Must NOT reference the relation name as a table
		expect(normalized).not.toMatch(/FROM\s+"?callee_calls"?/i);
	});

	it('generates valid SELECT with AND conditions plus NOT EXISTS', () => {
		const orm = buildOrm();

		const dump = orm
			.select('symbols')
			.where(
				and(
					eq('exported', true),
					notExists('callee_calls'),
				),
			)
			.dump();

		const normalized = ws(dump.sql);

		// Basic structure
		expect(normalized).toMatch(/SELECT.*FROM\s+"?symbols"?/i);
		expect(normalized).toMatch(/NOT.*EXISTS/i);
		// The scalar eq('exported', true) condition must also appear
		expect(normalized).toMatch(/exported/i);
	});

	it('three-way and() with eq, eq, notExists — still one NOT EXISTS', () => {
		const orm = buildOrm();

		const dump = orm
			.select('symbols')
			.where(
				and(
					eq('file.project_id', 1),
					eq('exported', true),
					notExists('callee_calls'),
				),
			)
			.dump();

		const normalized = ws(dump.sql);

		const notExistsCount = countMatches(normalized, /NOT\s*\(?\s*EXISTS/gi);
		expect(notExistsCount).toBe(1);

		expect(normalized).toMatch(/FROM\s+"?calls"?/i);
		expect(normalized).not.toMatch(/FROM\s+"?callee_calls"?/i);
	});
});

// ---------------------------------------------------------------------------
// Regression guard: top-level notExists() still works
// ---------------------------------------------------------------------------

describe('notExists() at top level (regression guard)', () => {
	it('top-level notExists still produces exactly one NOT EXISTS', () => {
		const orm = buildOrm();

		const dump = orm
			.select('symbols')
			.where(notExists('callee_calls'))
			.dump();

		const normalized = ws(dump.sql);

		const notExistsCount = countMatches(normalized, /NOT\s*\(?\s*EXISTS/gi);
		expect(notExistsCount).toBe(1);
	});

	it('top-level notExists uses actual table name "calls"', () => {
		const orm = buildOrm();

		const dump = orm
			.select('symbols')
			.where(notExists('callee_calls'))
			.dump();

		const normalized = ws(dump.sql);

		expect(normalized).toMatch(/FROM\s+"?calls"?/i);
		expect(normalized).not.toMatch(/FROM\s+"?callee_calls"?/i);
	});
});

// ---------------------------------------------------------------------------
// notExists with include inside and() — the full consumer use case
// ---------------------------------------------------------------------------

describe('notExists() with include inside and()', () => {
	it('notExists with include inside and() produces one NOT EXISTS with JOIN', () => {
		const orm = buildOrm();

		const dump = orm
			.select('symbols')
			.include('file', { join: 'inner' })
			.where(
				and(
					eq('file.project_id', 1),
					eq('exported', true),
					notExists('callee_calls', {
						include: { caller: { join: 'inner' } },
					}),
				),
			)
			.dump();

		const normalized = ws(dump.sql);

		const notExistsCount = countMatches(normalized, /NOT\s*\(?\s*EXISTS/gi);
		expect(notExistsCount).toBe(1);

		expect(normalized).toMatch(/FROM\s+"?calls"?/i);
		expect(normalized).not.toMatch(/FROM\s+"?callee_calls"?/i);
	});
});
