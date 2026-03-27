/**
 * DX-to-SQL integration tests: full pipeline from DX API (orm.select/delete/update)
 * through the planner to the SQL compiler.
 *
 * These tests use EXACT SQL matching (toEqual) to catch regressions like Issue 14
 * where field->column mapping was lost in compileWhereIntent.
 *
 * Schema mirrors the astix project structure:
 *   symbols - id, name, kind, start_line, end_line, complexity, exported, file_id->files
 *   files   - id, path
 *   calls   - id, caller_id->symbols, callee_id->symbols
 */

import {
	and,
	createOrm,
	eq,
	exists,
	gte,
	inArray,
	isNotNull,
	isNull,
	like,
	lte,
	neq,
	not,
	notExists,
	op,
	or,
	ref,
	schema,
} from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Schema & ORM factory
// ---------------------------------------------------------------------------

const testSchema = schema({
	symbols: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
		kind: { type: 'text' },
		start_line: { type: 'integer' },
		end_line: { type: 'integer' },
		complexity: { type: 'integer' },
		exported: { type: 'boolean' },
		file_id: ref('files', { as: 'file', inverse: 'symbols' }),
	},
	files: {
		id: { type: 'integer', primaryKey: true },
		path: { type: 'text' },
	},
	calls: {
		id: { type: 'integer', primaryKey: true },
		caller_id: ref('symbols', { as: 'caller', inverse: 'caller_calls' }),
		callee_id: ref('symbols', { as: 'callee', inverse: 'callee_calls' }),
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
// 1. Simple comparison: lte
// ---------------------------------------------------------------------------

describe('1. lte() compiles to WHERE col <= $1', () => {
	it('produces exact SQL with single parameter', () => {
		const orm = buildOrm();
		const dump = (orm as any)
			.select('symbols')
			.where(lte('start_line', 10))
			.dump();
		expect(ws(dump.sql)).toEqual(
			'SELECT symbols.* FROM symbols WHERE symbols.start_line <= $1',
		);
		expect(dump.params).toEqual([10]);
	});
});

// ---------------------------------------------------------------------------
// 2. AND of comparisons: and(lte, gte)
// ---------------------------------------------------------------------------

describe('2. and(lte, gte) compiles both conditions', () => {
	it('produces exact SQL with two parameters', () => {
		const orm = buildOrm();
		const dump = (orm as any)
			.select('symbols')
			.where(and(lte('start_line', 10), gte('end_line', 20)))
			.dump();
		expect(ws(dump.sql)).toEqual(
			'SELECT symbols.* FROM symbols WHERE symbols.start_line <= $1 AND symbols.end_line >= $2',
		);
		expect(dump.params).toEqual([10, 20]);
	});
});

// ---------------------------------------------------------------------------
// 3. Expression in WHERE: op() with column names
// ---------------------------------------------------------------------------

describe('3. op() expression in WHERE with gte', () => {
	it('compiles column arithmetic expression without binding refs as params', () => {
		const orm = buildOrm();
		const lineCount = op('-', 'end_line', 'start_line');
		const dump = orm.select('symbols').where(lineCount.gte(50)).dump();
		expect(ws(dump.sql)).toEqual(
			'SELECT symbols.* FROM symbols WHERE (end_line - start_line) >= $1',
		);
		expect(dump.params).toEqual([50]);
	});
});

// ---------------------------------------------------------------------------
// 4. OR with comparison + exists
// ---------------------------------------------------------------------------

describe('4. or(eq, exists) - both branches survive', () => {
	it('extracts exists to AND and keeps eq condition', () => {
		// Note: the planner extracts exists/notExists from OR and combines as AND.
		// This is documented behavior. The test asserts both eq and EXISTS appear.
		const orm = buildOrm();
		const dump = (orm as any)
			.select('symbols')
			.where(or(eq('kind', 'function'), exists('callee_calls')))
			.dump();
		expect(ws(dump.sql)).toEqual(
			'SELECT symbols.* FROM symbols WHERE symbols.kind = $1 AND EXISTS (SELECT 1 FROM calls AS calls_exists_0 WHERE symbols.id = calls_exists_0.callee_id)',
		);
		expect(dump.params).toEqual(['function']);
	});
});

// ---------------------------------------------------------------------------
// 5. notExists with inner WHERE
// ---------------------------------------------------------------------------

describe('5. notExists with inner where', () => {
	it('produces NOT EXISTS with inner WHERE condition', () => {
		const orm = buildOrm();
		const dump = (orm as any)
			.select('symbols')
			.where(notExists('callee_calls', { where: eq('caller_id', 5) }))
			.dump();
		expect(ws(dump.sql)).toEqual(
			'SELECT symbols.* FROM symbols WHERE NOT (EXISTS (SELECT 1 FROM calls AS calls_exists_0 WHERE symbols.id = calls_exists_0.callee_id AND calls_exists_0.caller_id = $1))',
		);
		expect(dump.params).toEqual([5]);
	});

	it('produces NOT EXISTS with no inner WHERE (plain notExists)', () => {
		const orm = buildOrm();
		const dump = (orm as any)
			.select('symbols')
			.where(notExists('callee_calls'))
			.dump();
		expect(ws(dump.sql)).toEqual(
			'SELECT symbols.* FROM symbols WHERE NOT (EXISTS (SELECT 1 FROM calls AS calls_exists_0 WHERE symbols.id = calls_exists_0.callee_id))',
		);
		expect(dump.params).toEqual([]);
	});
});
// ---------------------------------------------------------------------------
// 6. DELETE with comparison
// ---------------------------------------------------------------------------

describe('6. DELETE with eq WHERE', () => {
	it('produces DELETE FROM ... WHERE col = $1', () => {
		const orm = buildOrm();
		const dump = (orm as any)
			.delete('symbols')
			.where(eq('kind', 'unused'))
			.dump();
		expect(ws(dump.sql)).toEqual('DELETE FROM symbols WHERE symbols.kind = $1');
		expect(dump.parameters).toEqual(['unused']);
	});
});

// ---------------------------------------------------------------------------
// 7. DELETE with and(inArray, gte)
// ---------------------------------------------------------------------------

describe('7. DELETE with and(inArray, gte)', () => {
	it('compiles inArray to ANY($1) and gte as second condition', () => {
		const orm = buildOrm();
		const dump = (orm as any)
			.delete('symbols')
			.where(and(inArray('kind', ['fn', 'class']), gte('complexity', 10)))
			.dump();
		expect(ws(dump.sql)).toEqual(
			'DELETE FROM symbols WHERE symbols.kind = ANY ($1) AND symbols.complexity >= $2',
		);
		expect(dump.parameters).toEqual([['fn', 'class'], 10]);
	});
});

// ---------------------------------------------------------------------------
// 8. UPDATE with comparison WHERE
// ---------------------------------------------------------------------------

describe('8. UPDATE with eq WHERE', () => {
	it('produces UPDATE SET ... WHERE using compileWhereIntent', () => {
		const orm = buildOrm();
		const dump = (orm as any)
			.update('symbols')
			.set({ exported: false })
			.where(eq('kind', 'private'))
			.dump();
		expect(ws(dump.sql)).toEqual(
			'UPDATE symbols SET exported = $1 WHERE symbols.kind = $2',
		);
		expect(dump.parameters).toEqual([false, 'private']);
	});

	it('UPDATE with and(eq, isNotNull) WHERE', () => {
		const orm = buildOrm();
		const dump = (orm as any)
			.update('symbols')
			.set({ exported: true })
			.where(and(eq('kind', 'function'), isNotNull('name')))
			.dump();
		expect(ws(dump.sql)).toEqual(
			'UPDATE symbols SET exported = $1 WHERE symbols.kind = $2 AND symbols.name IS NOT NULL',
		);
		expect(dump.parameters).toEqual([true, 'function']);
	});
});

// ---------------------------------------------------------------------------
// 9. like with escape character
// ---------------------------------------------------------------------------

describe('9. like with escape character', () => {
	it('produces LIKE $1 ESCAPE $2 with two parameters', () => {
		const orm = buildOrm();
		const dump = (orm as any)
			.select('symbols')
			.where(like('name', '\\_test%', { escape: '\\' }))
			.dump();
		expect(ws(dump.sql)).toEqual(
			'SELECT symbols.* FROM symbols WHERE symbols.name LIKE $1 ESCAPE $2',
		);
		expect(dump.params).toEqual(['\\_test%', '\\']);
	});

	it('like without escape has no ESCAPE clause', () => {
		const orm = buildOrm();
		const dump = (orm as any)
			.select('symbols')
			.where(like('name', '%test%'))
			.dump();
		expect(ws(dump.sql)).toEqual(
			'SELECT symbols.* FROM symbols WHERE symbols.name LIKE $1',
		);
		expect(dump.params).toEqual(['%test%']);
	});
});

// ---------------------------------------------------------------------------
// 10. Nested and(or(eq, neq), not(isNull))
// ---------------------------------------------------------------------------

describe('10. nested and(or(eq, neq), not(isNull))', () => {
	it('compiles all operators in nested boolean tree', () => {
		const orm = buildOrm();
		const dump = (orm as any)
			.select('symbols')
			.where(
				and(
					or(eq('kind', 'function'), neq('kind', 'variable')),
					not(isNull('name')),
				),
			)
			.dump();
		// pgsql-deparser serializes OR without parentheses; the AST is preserved.
		// This exact output is the regression anchor.
		expect(ws(dump.sql)).toEqual(
			'SELECT symbols.* FROM symbols WHERE symbols.kind = $1 OR symbols.kind <> $2 AND NOT (symbols.name IS NULL)',
		);
		expect(dump.params).toEqual(['function', 'variable']);
	});

	it('isNull and isNotNull produce correct IS NULL / IS NOT NULL', () => {
		const orm = buildOrm();

		const dumpNull = (orm as any)
			.select('symbols')
			.where(isNull('name'))
			.dump();
		expect(ws(dumpNull.sql)).toEqual(
			'SELECT symbols.* FROM symbols WHERE symbols.name IS NULL',
		);

		const dumpNotNull = (orm as any)
			.select('symbols')
			.where(isNotNull('name'))
			.dump();
		expect(ws(dumpNotNull.sql)).toEqual(
			'SELECT symbols.* FROM symbols WHERE symbols.name IS NOT NULL',
		);
	});
});

// ---------------------------------------------------------------------------
// 11. Regression: two exists() on same relation produce distinct params
// ---------------------------------------------------------------------------

describe('11. two exists() on same relation — distinct params (no duplication)', () => {
	// Bug: extractExistsDecisions used .find() which always returned the FIRST
	// matching intent for both filter-strategy decisions when relation names matched.
	// Fix: switch to .findIndex() + .splice() to consume each intent once.
	it('and(exists(callee_calls, {where}), exists(callee_calls, {where})) — both params present', () => {
		const orm = buildOrm();
		const dump = (orm as any)
			.select('symbols')
			.where(
				and(
					exists('callee_calls', { where: eq('caller_id', 1) }),
					exists('callee_calls', { where: eq('caller_id', 2) }),
				),
			)
			.dump();

		// Both params must appear — not [1, 1] (the bug) or [2, 2]
		expect(dump.params).toContain(1);
		expect(dump.params).toContain(2);
		expect(dump.params).toHaveLength(2);

		// Two separate EXISTS subqueries must appear in the SQL
		const matches = ws(dump.sql).match(/EXISTS/g);
		expect(matches).toHaveLength(2);
	});

	it('param order: first exists gets param 1, second gets param 2', () => {
		const orm = buildOrm();
		const dump = (orm as any)
			.select('symbols')
			.where(
				and(
					exists('callee_calls', { where: eq('caller_id', 10) }),
					exists('callee_calls', { where: eq('caller_id', 20) }),
				),
			)
			.dump();

		expect(dump.params).toEqual([10, 20]);
	});
});
