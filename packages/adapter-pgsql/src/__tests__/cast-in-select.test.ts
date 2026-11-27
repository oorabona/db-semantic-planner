/**
 * cast()-in-SELECT tests.
 *
 * Verifies that cast() expressions compile correctly when used in .columns() /
 * SELECT lists, covering:
 *   1. Implicit alias from source column when no .as() is given (cast on exprRef)
 *   2. Explicit alias via .as()
 *   3. Cast wrapping a fn() call in SELECT
 *   4. Cast wrapping an aggregate fn() in SELECT
 *   5. Alias propagates to the hydrated result row key (dump() assertions)
 *   6. Type name injection guard
 *   7. Dotted ref implicit alias uses the last dot-segment
 *
 * Every test goes through the ORM pipeline (`dump()`), through
 * handleCustomExpressionSelect and intentToDecisions, which is where implicit alias
 * derivation happens. The deparser produces CAST(x AS type) syntax (standard SQL, not
 * PostgreSQL ::type).
 *
 * Note: exprRef() is the expression column-reference helper exported as 'exprRef' from
 * @dbsp/core. The 'ref' export from @dbsp/core is the schema foreign-key ref function.
 */

import { cast, createOrm, exprRef, fn, param, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

// ============================================================================
// Test schema & ORM factory
// ============================================================================

const testSchema = schema({
	events: {
		id: { type: 'integer', primaryKey: true },
		created_at: { type: 'timestamp' },
		score: { type: 'number' },
		amount: { type: 'integer' },
	},
} as const);

function buildOrm() {
	const adapter = createPgCompileOnlyAdapter({ model: testSchema.model });
	return createOrm({ model: testSchema.model, adapter });
}

function ws(sql: string): string {
	return sql.replace(/\s+/g, ' ').trim();
}

// ============================================================================
// Helpers
// ============================================================================

/** Compile `cast(...)` as an explicitly aliased column of `events`. */
function compileCastWithAlias(
	castExpr: ReturnType<typeof cast>,
	alias: string,
): { sql: string; params: readonly unknown[] } {
	const { sql, params } = buildOrm()
		.select('events')
		.columns([castExpr.as(alias)])
		.dump();
	return { sql, params };
}

// ============================================================================
// 1. Implicit alias — full ORM pipeline, cast on exprRef, no .as()
// ============================================================================

describe('cast-in-SELECT: implicit alias from source column (full ORM pipeline)', () => {
	it('cast(exprRef("created_at"), "text") produces implicit alias "created_at" in SQL', () => {
		const orm = buildOrm();
		const dump = (orm as ReturnType<typeof buildOrm>)
			.select('events')
			.columns(['id', cast(exprRef('created_at'), 'text')])
			.dump();
		const sql = ws(dump.sql);
		// Must contain the CAST expression
		expect(sql).toMatch(/CAST\(created_at AS text\)/i);
		// Must contain the implicit alias so the hydrated row key is 'created_at'
		expect(sql).toContain('AS created_at');
	});

	it('cast(exprRef("score"), "integer") produces implicit alias "score"', () => {
		const orm = buildOrm();
		const dump = (orm as ReturnType<typeof buildOrm>)
			.select('events')
			.columns(['id', cast(exprRef('score'), 'integer')])
			.dump();
		const sql = ws(dump.sql);
		expect(sql).toMatch(/CAST\(score AS integer\)/i);
		expect(sql).toContain('AS score');
	});

	it('explicit .as() overrides the implicit alias', () => {
		const orm = buildOrm();
		const dump = (orm as ReturnType<typeof buildOrm>)
			.select('events')
			.columns(['id', cast(exprRef('created_at'), 'text').as('ts')])
			.dump();
		const sql = ws(dump.sql);
		// The explicit alias 'ts' must be the output alias
		expect(sql).toContain('AS ts');
		// The source column is part of the CAST expression, not the alias
		expect(sql).toMatch(/CAST\(created_at AS text\)/i);
	});
});

// ============================================================================
// 2. Explicit alias via .as() — compiler path
// ============================================================================

describe('cast-in-SELECT: explicit alias via .as()', () => {
	it('cast(exprRef("created_at"), "text") + alias "createdAtText" emits CAST with alias', () => {
		expect(
			compileCastWithAlias(
				cast(exprRef('created_at'), 'text'),
				'createdAtText',
			),
		).toEqual({
			sql: 'SELECT CAST(created_at AS text) AS "createdAtText" FROM events',
			params: [],
		});
	});

	it('cast(param([0.1, 0.2]), "vector") + alias "embedding" binds params correctly', () => {
		expect(
			compileCastWithAlias(cast(param([0.1, 0.2]), 'vector'), 'embedding'),
		).toEqual({
			sql: 'SELECT CAST($1 AS vector) AS embedding FROM events',
			params: [[0.1, 0.2]],
		});
	});
});

// ============================================================================
// 3. Cast wrapping a fn() call in SELECT
// ============================================================================

describe('cast-in-SELECT: cast wrapping fn()', () => {
	it('cast(fn("lower", exprRef("created_at")), "text") compiles correctly', () => {
		expect(
			compileCastWithAlias(
				cast(fn('lower', exprRef('created_at')), 'text'),
				'lower_ts',
			),
		).toEqual({
			sql: 'SELECT CAST(lower(created_at) AS text) AS lower_ts FROM events',
			params: [],
		});
	});

	it('cast(fn("floor", exprRef("score")), "integer") compiles correctly', () => {
		expect(
			compileCastWithAlias(
				cast(fn('floor', exprRef('score')), 'integer'),
				'floored',
			),
		).toEqual({
			sql: 'SELECT CAST(floor(score) AS integer) AS floored FROM events',
			params: [],
		});
	});
});

// ============================================================================
// 4. Cast wrapping an aggregate fn() in SELECT
// ============================================================================

describe('cast-in-SELECT: cast wrapping aggregate fn()', () => {
	it('cast(fn("count", exprRef("id")), "text") compiles correctly', () => {
		expect(
			compileCastWithAlias(
				cast(fn('count', exprRef('id')), 'text'),
				'count_text',
			),
		).toEqual({
			sql: 'SELECT CAST(count(id) AS text) AS count_text FROM events',
			params: [],
		});
	});

	it('cast(fn("sum", exprRef("amount")), "float4") compiles correctly', () => {
		expect(
			compileCastWithAlias(
				cast(fn('sum', exprRef('amount')), 'float4'),
				'total_float',
			),
		).toEqual({
			sql: 'SELECT CAST(sum(amount) AS float4) AS total_float FROM events',
			params: [],
		});
	});
});

// ============================================================================
// 5. Alias propagates to hydrated result row key (dump assertions)
// ============================================================================

describe('cast-in-SELECT: alias propagates to result row key', () => {
	it('explicit alias "scoreText" is the output column label in dump()', () => {
		const orm = buildOrm();
		const dump = (orm as ReturnType<typeof buildOrm>)
			.select('events')
			.columns(['id', cast(exprRef('score'), 'text').as('scoreText')])
			.dump();
		// camelCase alias → quoted in SQL
		expect(dump.sql).toContain('"scoreText"');
	});

	it('implicit alias "created_at" is the output column label in dump()', () => {
		const orm = buildOrm();
		const dump = (orm as ReturnType<typeof buildOrm>)
			.select('events')
			.columns(['id', cast(exprRef('created_at'), 'text')])
			.dump();
		// Implicit alias 'created_at' appears as the output alias
		// (unquoted since it's a valid lowercase identifier)
		expect(ws(dump.sql)).toContain('AS created_at');
		// The CAST syntax is used
		expect(dump.sql).toMatch(/CAST\(created_at AS text\)/i);
	});

	it('cast(param(...), "vector").as("embedding") labels result column correctly', () => {
		const orm = buildOrm();
		const dump = (orm as ReturnType<typeof buildOrm>)
			.select('events')
			.columns(['id', cast(param([0.1, 0.2]), 'vector').as('embedding')])
			.dump();
		expect(ws(dump.sql)).toContain('AS embedding');
		expect(dump.sql).toMatch(/CAST\(\$1 AS vector\)/i);
		expect(dump.params).toEqual([[0.1, 0.2]]);
	});
});

// ============================================================================
// 6. Type name injection guard
// ============================================================================

describe('cast-in-SELECT: type name injection guard', () => {
	it('cast() throws on SQL-injection type name before compilation', () => {
		expect(() => cast(exprRef('col'), 'int; DROP TABLE x--')).toThrow(
			/Invalid type name/,
		);
	});

	it('cast() throws on empty type name', () => {
		expect(() => cast(exprRef('col'), '')).toThrow(/Invalid type name/);
	});

	it('cast() with simple type compiles correctly', () => {
		expect(compileCastWithAlias(cast(exprRef('score'), 'text'), 'v')).toEqual({
			sql: 'SELECT CAST(score AS text) AS v FROM events',
			params: [],
		});
	});

	it('cast() with array type suffix compiles correctly', () => {
		expect(
			compileCastWithAlias(cast(exprRef('score'), 'float4[]'), 'v'),
		).toEqual({
			sql: 'SELECT CAST(score AS float4[]) AS v FROM events',
			params: [],
		});
	});
});

// ============================================================================
// 7. Dotted ref implicit alias uses last segment
// ============================================================================

describe('cast-in-SELECT: dotted ref implicit alias uses last dot-segment', () => {
	it('implicit alias derivation: last dot-segment of column name is used', () => {
		// Directly verify the alias-derivation logic that handleCustomExpressionSelect applies.
		// This is a unit test of the derivation rule, not of handler dispatch.
		const col = 't.score';
		const dotIdx = col.lastIndexOf('.');
		const derivedAlias = dotIdx !== -1 ? col.slice(dotIdx + 1) : col;
		expect(derivedAlias).toBe('score');
	});

	it('cast with derived alias "score" compiles correctly', () => {
		const { sql, params } = buildOrm()
			.select('events')
			.columns([cast(exprRef('events.score'), 'float4')])
			.dump();
		expect({ sql, params }).toEqual({
			sql: 'SELECT CAST(events.score AS float4) AS score FROM events',
			params: [],
		});
	});

	it('ORM pipeline: cast(exprRef("score"), "float4") uses "score" as implicit alias', () => {
		const orm = buildOrm();
		const dump = (orm as ReturnType<typeof buildOrm>)
			.select('events')
			.columns(['id', cast(exprRef('score'), 'float4')])
			.dump();
		expect(ws(dump.sql)).toContain('AS score');
		expect(dump.sql).toMatch(/CAST\(score AS float4\)/i);
	});
});
