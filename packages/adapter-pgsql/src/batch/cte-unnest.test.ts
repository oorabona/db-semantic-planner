/**
 * CTE with unnest() builder tests — BATCH-001 Block 5
 *
 * Verifies the compileCteQuery strategy:
 *   WITH "cteName" AS (
 *     SELECT t."col1", t."col2", (t.ordinality - 1) AS "idx"
 *     FROM unnest(CAST($1 AS type[]), CAST($2 AS type[])) WITH ORDINALITY AS t("col1", "col2", ordinality)
 *   )
 *   SELECT ... FROM "outerTable" WHERE ...
 */

import { createOrm, eq, InvalidOperationError } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

function makeOrm() {
	return createOrm({
		model: { getTable: () => undefined } as any,
		adapter: createPgsqlCompileOnlyAdapter(),
	});
}

// ---------------------------------------------------------------------------
// SC-14: CTE with unnest + WITH ORDINALITY index
// ---------------------------------------------------------------------------
describe('SC-14: CTE with unnest + WITH ORDINALITY index', () => {
	it('generates WITH clause with ORDINALITY', () => {
		const orm = makeOrm();
		const result = orm
			.withCte('lookups')
			.fromUnnest({
				parent_file_id: [1, 2, 3],
				parent_name: ['Foo', 'Bar', 'Baz'],
			})
			.withIndex('idx')
			.query(orm.select('symbols'))
			.dump();

		expect(result.sql).toContain('WITH');
		expect(result.sql).toContain('lookups');
		expect(result.sql).toContain('unnest');
		expect(result.sql).toContain('ORDINALITY');
		expect(result.sql).toContain('idx');
	});

	it('uses CAST($N AS type[]) for each column', () => {
		const orm = makeOrm();
		const result = orm
			.withCte('lookups')
			.fromUnnest({
				parent_file_id: [1, 2, 3],
				parent_name: ['Foo', 'Bar', 'Baz'],
			})
			.withIndex('idx')
			.query(orm.select('symbols'))
			.dump();

		expect(result.sql).toContain('CAST($1 AS int4[])');
		expect(result.sql).toContain('CAST($2 AS text[])');
	});

	it('parameter arrays are correct', () => {
		const orm = makeOrm();
		const result = orm
			.withCte('lookups')
			.fromUnnest({
				parent_file_id: [1, 2, 3],
				parent_name: ['Foo', 'Bar', 'Baz'],
			})
			.withIndex('idx')
			.query(orm.select('symbols'))
			.dump();

		expect(result.params[0]).toEqual([1, 2, 3]);
		expect(result.params[1]).toEqual(['Foo', 'Bar', 'Baz']);
	});

	it('index column uses (ordinality - 1) expression', () => {
		const orm = makeOrm();
		const result = orm
			.withCte('lookups')
			.fromUnnest({ id: [10, 20] })
			.withIndex('idx')
			.query(orm.select('symbols'))
			.dump();

		// ordinality - 1 expression should appear
		expect(result.sql).toContain('ordinality');
		expect(result.sql).toContain('1');
		expect(result.sql).toContain('idx');
	});
});

// ---------------------------------------------------------------------------
// SC-15: CTE joined with outer query
// ---------------------------------------------------------------------------
describe('SC-15: CTE joined with outer query', () => {
	it('includes both CTE and outer SELECT in SQL', () => {
		const orm = makeOrm();
		const result = orm
			.withCte('lookups')
			.fromUnnest({ id: [1, 2, 3] })
			.query(orm.select('symbols'))
			.dump();

		expect(result.sql).toContain('WITH');
		expect(result.sql).toContain('lookups');
		expect(result.sql).toContain('symbols');
	});

	it('outer query parameters are offset after CTE parameters', () => {
		const orm = makeOrm();
		const result = orm
			.withCte('lookups')
			.fromUnnest({ id: [1, 2, 3] })
			.query(orm.select('symbols').where(eq('active', true)))
			.dump();

		// $1 is the CTE array, $2 is the WHERE parameter
		expect(result.params[0]).toEqual([1, 2, 3]);
		expect(result.params[1]).toBe(true);
		expect(result.sql).toContain('$1');
		expect(result.sql).toContain('$2');
	});

	it('works with direct adapter compileCteQuery', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const result = adapter.compileCteQuery({
			kind: 'cteQuery',
			ctes: [
				{
					kind: 'unnestCte',
					name: 'data',
					columns: { id: [1, 2], name: ['a', 'b'] },
				},
			],
			query: {
				type: 'select',
				from: 'symbols',
			},
		});

		expect(result.sql).toContain('WITH');
		expect(result.sql).toContain('data');
		expect(result.sql).toContain('symbols');
		expect(result.parameters[0]).toEqual([1, 2]);
		expect(result.parameters[1]).toEqual(['a', 'b']);
	});
});

// ---------------------------------------------------------------------------
// SC-16: CTE without index (no WITH ORDINALITY)
// ---------------------------------------------------------------------------
describe('SC-16: CTE without index (no WITH ORDINALITY)', () => {
	it('generates unnest without ordinality when no withIndex()', () => {
		const orm = makeOrm();
		const result = orm
			.withCte('data')
			.fromUnnest({ id: [1, 2], name: ['a', 'b'] })
			.query(orm.select('symbols'))
			.dump();

		expect(result.sql).toContain('unnest');
		expect(result.sql).toContain('data');
		// No ORDINALITY in the SQL
		expect(result.sql).not.toContain('ORDINALITY');
		expect(result.params[0]).toEqual([1, 2]);
		expect(result.params[1]).toEqual(['a', 'b']);
	});

	it('single column CTE works', () => {
		const orm = makeOrm();
		const result = orm
			.withCte('ids')
			.fromUnnest({ id: [10, 20, 30] })
			.query(orm.select('symbols'))
			.dump();

		expect(result.sql).toContain('ids');
		expect(result.sql).toContain('unnest');
		expect(result.params[0]).toEqual([10, 20, 30]);
	});
});

// ---------------------------------------------------------------------------
// Additional: type inference
// ---------------------------------------------------------------------------
describe('type inference in CTE columns', () => {
	it('integer arrays use int4[] type', () => {
		const orm = makeOrm();
		const result = orm
			.withCte('nums')
			.fromUnnest({ n: [1, 2, 3] })
			.query(orm.select('symbols'))
			.dump();

		expect(result.sql).toContain('CAST($1 AS int4[])');
	});

	it('string arrays use text[] type', () => {
		const orm = makeOrm();
		const result = orm
			.withCte('strs')
			.fromUnnest({ s: ['a', 'b'] })
			.query(orm.select('symbols'))
			.dump();

		expect(result.sql).toContain('CAST($1 AS text[])');
	});

	it('boolean arrays use bool[] type', () => {
		const orm = makeOrm();
		const result = orm
			.withCte('flags')
			.fromUnnest({ flag: [true, false] })
			.query(orm.select('symbols'))
			.dump();

		expect(result.sql).toContain('CAST($1 AS bool[])');
	});

	it('float arrays use float8[] type', () => {
		const orm = makeOrm();
		const result = orm
			.withCte('scores')
			.fromUnnest({ score: [1.5, 2.7] })
			.query(orm.select('symbols'))
			.dump();

		expect(result.sql).toContain('CAST($1 AS float8[])');
	});
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------
describe('error cases', () => {
	it('throws when calling query() without fromUnnest()', () => {
		const orm = makeOrm();
		expect(() => {
			orm.withCte('data').query(orm.select('symbols'));
		}).toThrow(InvalidOperationError);
	});

	it('throws on array length mismatch in fromUnnest', () => {
		const orm = makeOrm();
		expect(() => {
			orm.withCte('data').fromUnnest({ id: [1, 2, 3], name: ['a', 'b'] }); // length mismatch
		}).toThrow(InvalidOperationError);
	});

	it('allows empty arrays (zero rows)', () => {
		const orm = makeOrm();
		// Empty arrays are valid — results in zero rows from CTE
		const result = orm
			.withCte('empty')
			.fromUnnest({ id: [], name: [] })
			.query(orm.select('symbols'))
			.dump();

		expect(result.sql).toContain('empty');
		expect(result.params[0]).toEqual([]);
	});

	it('single-column mismatch check skipped (only 1 array)', () => {
		const orm = makeOrm();
		// Single column — no mismatch possible
		const result = orm
			.withCte('single')
			.fromUnnest({ id: [1, 2, 3] })
			.query(orm.select('symbols'))
			.dump();

		expect(result.sql).toContain('single');
	});
});
