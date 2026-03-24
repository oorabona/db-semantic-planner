
/**
 * Issue 8: notExists('callee_calls') generates FROM "calls" not FROM "callee_calls"
 *
 * When using inverse hasMany relations in notExists(), the relation name
 * (e.g. 'callee_calls') differs from the actual target table ('calls').
 * The planner must resolve the relation to find the correct target table.
 *
 * Schema:
 *   symbols: id (PK), name
 *   calls: id (PK), callee_id (FK→symbols, inverse: 'callee_calls'), caller_id (FK→symbols, inverse: 'caller_calls')
 *
 * Relations on symbols:
 *   callee_calls: hasMany(calls) via callee_id
 *   caller_calls: hasMany(calls) via caller_id
 */

import { createOrm, notExists, exists, ref, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Test schema — two distinct inverse relations on symbols pointing to calls
// ---------------------------------------------------------------------------

const testSchema = schema({
	symbols: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
	},
	calls: {
		id: { type: 'integer', primaryKey: true },
		callee_id: ref('symbols', { as: 'callee', inverse: 'callee_calls' }),
		caller_id: ref('symbols', { as: 'caller', inverse: 'caller_calls' }),
	},
});

function buildAdapter() {
	return createPgsqlCompileOnlyAdapter({ model: testSchema.model });
}

function buildOrm() {
	const adapter = buildAdapter();
	return createOrm({ model: testSchema.model, adapter });
}

/** Normalize whitespace for SQL comparison. */
function ws(sql: string): string {
	return sql.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// SELECT path (goes through extractExistsDecisions + planner)
// ---------------------------------------------------------------------------

describe('notExists() with inverse relation — SELECT path', () => {
	it('notExists("callee_calls") generates FROM "calls" not FROM "callee_calls"', () => {
		const orm = buildOrm();
		const dump = orm.select('symbols').where(notExists('callee_calls')).dump();
		const normalized = ws(dump.sql);

		expect(normalized).toMatch(/NOT.*EXISTS/i);
		// Must use the actual table name 'calls', not the relation name 'callee_calls'
		expect(normalized).toMatch(/FROM\s+"?calls"?/i);
		expect(normalized).not.toMatch(/FROM\s+"?callee_calls"?/i);
	});

	it('notExists("caller_calls") generates FROM "calls" not FROM "caller_calls"', () => {
		const orm = buildOrm();
		const dump = orm.select('symbols').where(notExists('caller_calls')).dump();
		const normalized = ws(dump.sql);

		expect(normalized).toMatch(/NOT.*EXISTS/i);
		expect(normalized).toMatch(/FROM\s+"?calls"?/i);
		expect(normalized).not.toMatch(/FROM\s+"?caller_calls"?/i);
	});

	it('exists("callee_calls") generates FROM "calls" not FROM "callee_calls"', () => {
		const orm = buildOrm();
		const dump = orm.select('symbols').where(exists('callee_calls')).dump();
		const normalized = ws(dump.sql);

		expect(normalized).toMatch(/\bEXISTS\b/i);
		expect(normalized).not.toMatch(/NOT\s*EXISTS/i);
		expect(normalized).toMatch(/FROM\s+"?calls"?/i);
		expect(normalized).not.toMatch(/FROM\s+"?callee_calls"?/i);
	});

	it('correlation predicate uses the correct FK column (callee_id)', () => {
		const orm = buildOrm();
		const dump = orm.select('symbols').where(notExists('callee_calls')).dump();

		// The EXISTS subquery must correlate on callee_id
		expect(dump.sql).toContain('callee_id');
	});

	it('correlation predicate for caller_calls uses caller_id', () => {
		const orm = buildOrm();
		const dump = orm.select('symbols').where(notExists('caller_calls')).dump();

		expect(dump.sql).toContain('caller_id');
	});
});

// ---------------------------------------------------------------------------
// DELETE mutation path (goes through normalizeToDecision — different code path)
// ---------------------------------------------------------------------------

describe('notExists() with inverse relation — DELETE mutation path', () => {
	it('notExists("callee_calls") generates FROM "calls" in DELETE', () => {
		const adapter = buildAdapter();

		const { sql } = adapter.compileDelete({
			type: 'delete' as const,
			table: 'symbols',
			where: notExists('callee_calls'),
		});

		const normalized = ws(sql);
		expect(normalized).toMatch(/NOT.*EXISTS/i);
		expect(normalized).toMatch(/FROM\s+"?calls"?/i);
		expect(normalized).not.toMatch(/FROM\s+"?callee_calls"?/i);
	});

	it('notExists("caller_calls") generates FROM "calls" in DELETE', () => {
		const adapter = buildAdapter();

		const { sql } = adapter.compileDelete({
			type: 'delete' as const,
			table: 'symbols',
			where: notExists('caller_calls'),
		});

		const normalized = ws(sql);
		expect(normalized).toMatch(/NOT.*EXISTS/i);
		expect(normalized).toMatch(/FROM\s+"?calls"?/i);
		expect(normalized).not.toMatch(/FROM\s+"?caller_calls"?/i);
	});
});
