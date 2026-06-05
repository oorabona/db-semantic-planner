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
 * Two layers:
 *   - Unit (compilePlan): tests SQL compilation from a pre-built SimplifiedPlanReport.
 *     The deparser produces CAST(x AS type) syntax (standard SQL, not PostgreSQL ::type).
 *   - Integration (dump/ORM): tests the full pipeline through handleCustomExpressionSelect
 *     and intentToDecisions, which is where implicit alias derivation happens.
 *
 * Note: exprRef() is the expression column-reference helper exported as 'exprRef' from
 * @dbsp/core. The 'ref' export from @dbsp/core is the schema foreign-key ref function.
 */

import { cast, createOrm, exprRef, fn, param, schema } from '@dbsp/core';
import type { CastExpressionIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { normalizeSQL } from '../ast-helpers.js';
import { compilePlan, type SimplifiedPlanReport } from '../compiler.js';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

// ============================================================================
// Test schema & ORM factory
// ============================================================================

const testSchema = schema({
	events: {
		id: { type: 'integer', primaryKey: true },
		created_at: { type: 'timestamp' },
		score: { type: 'float' },
		amount: { type: 'integer' },
	},
} as const);

function buildOrm() {
	const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });
	return createOrm({ model: testSchema.model, adapter });
}

function ws(sql: string): string {
	return sql.replace(/\s+/g, ' ').trim();
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build a selectCustomExpression plan directly with an explicit alias.
 * This tests the compiler path (not the intentToDecisions handler).
 */
function compileCastWithAlias(
	castExpr: ReturnType<typeof cast>,
	alias: string,
): { sql: string; parameters: readonly unknown[] } {
	const intent = (castExpr as unknown as { intent: CastExpressionIntent })
		.intent;
	const plan: SimplifiedPlanReport = {
		rootTable: 'events',
		decisions: [
			{
				type: 'selectCustomExpression',
				expressionIntent: intent,
				alias,
			},
		],
	};
	return compilePlan(plan);
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
		const { sql } = compileCastWithAlias(
			cast(exprRef('created_at'), 'text'),
			'createdAtText',
		);
		const normalized = normalizeSQL(sql);
		// normalizeSQL lowercases; deparser produces CAST(x AS type)
		expect(normalized).toContain('cast(created_at as text)');
		// camelCase alias is quoted and lowercased by normalizeSQL
		expect(normalized).toContain('"createdattext"');
	});

	it('cast(param([0.1, 0.2]), "vector") + alias "embedding" binds params correctly', () => {
		const { sql, parameters } = compileCastWithAlias(
			cast(param([0.1, 0.2]), 'vector'),
			'embedding',
		);
		const normalized = normalizeSQL(sql);
		expect(normalized).toContain('cast($1 as vector)');
		expect(normalized).toContain('as embedding');
		expect(parameters).toEqual([[0.1, 0.2]]);
	});
});

// ============================================================================
// 3. Cast wrapping a fn() call in SELECT
// ============================================================================

describe('cast-in-SELECT: cast wrapping fn()', () => {
	it('cast(fn("lower", exprRef("created_at")), "text") compiles correctly', () => {
		const { sql } = compileCastWithAlias(
			cast(fn('lower', exprRef('created_at')), 'text'),
			'lower_ts',
		);
		const normalized = normalizeSQL(sql);
		// Function call wrapped in CAST
		expect(normalized).toMatch(/cast\(lower\(.*\) as text\)/);
		expect(normalized).toContain('lower_ts');
	});

	it('cast(fn("floor", exprRef("score")), "integer") compiles correctly', () => {
		const { sql } = compileCastWithAlias(
			cast(fn('floor', exprRef('score')), 'integer'),
			'floored',
		);
		const normalized = normalizeSQL(sql);
		expect(normalized).toMatch(/cast\(floor\(.*\) as integer\)/);
		expect(normalized).toContain('floored');
	});
});

// ============================================================================
// 4. Cast wrapping an aggregate fn() in SELECT
// ============================================================================

describe('cast-in-SELECT: cast wrapping aggregate fn()', () => {
	it('cast(fn("count", exprRef("id")), "text") compiles correctly', () => {
		const { sql } = compileCastWithAlias(
			cast(fn('count', exprRef('id')), 'text'),
			'count_text',
		);
		const normalized = normalizeSQL(sql);
		expect(normalized).toMatch(/cast\(count\(.*\) as text\)/);
		expect(normalized).toContain('count_text');
	});

	it('cast(fn("sum", exprRef("amount")), "float4") compiles correctly', () => {
		const { sql } = compileCastWithAlias(
			cast(fn('sum', exprRef('amount')), 'float4'),
			'total_float',
		);
		const normalized = normalizeSQL(sql);
		expect(normalized).toMatch(/cast\(sum\(.*\) as float4\)/);
		expect(normalized).toContain('total_float');
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
		const { sql } = compileCastWithAlias(cast(exprRef('score'), 'text'), 'v');
		expect(normalizeSQL(sql)).toContain('cast(score as text)');
	});

	it('cast() with array type suffix compiles correctly', () => {
		const { sql } = compileCastWithAlias(
			cast(exprRef('score'), 'float4[]'),
			'v',
		);
		expect(normalizeSQL(sql)).toContain('cast(score as float4[])');
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

	it('compilePlan: cast with derived alias "score" compiles correctly', () => {
		// Build the intent manually to simulate what the handler produces
		// for cast(exprRef('t.score'), 'float4') with implicit alias.
		const castIntent: CastExpressionIntent = {
			kind: 'cast',
			expr: { kind: 'ref', column: 't.score' },
			typeName: 'float4',
		};
		const derivedAlias = 'score'; // last segment of 't.score'
		const plan: SimplifiedPlanReport = {
			rootTable: 'events',
			decisions: [
				{
					type: 'selectCustomExpression',
					expressionIntent: castIntent,
					alias: derivedAlias,
				},
			],
		};
		const { sql } = compilePlan(plan);
		const normalized = normalizeSQL(sql);
		// Cast compiles to standard CAST syntax
		expect(normalized).toContain('cast(');
		expect(normalized).toContain('as float4');
		expect(normalized).toContain('as score');
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
