/**
 * Guard tests: IN-subquery and scalar-subquery with unsupported modifiers
 *
 * When a subquery carries GROUP BY, HAVING, OFFSET, DISTINCT, DISTINCT ON,
 * include (relation hydration), or joins, the adapter MUST throw a clear error
 * instead of silently dropping those modifiers (which would change which rows
 * match — a silent filter broadening).
 *
 * Modifiers that ARE faithfully emitted (no throw): where, limit, orderBy.
 */

import {
	createOrm,
	eq,
	inSubquery,
	POSTGRESQL_CAPABILITIES,
	plan,
	type QueryIntent,
	ref,
	schema,
	subquery,
} from '@dbsp/core';
import { NotYetSupportedError, type WhereIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { normalizeSQL } from '../ast-helpers.js';
import { convertWhereCondition } from '../intent-to-decisions.js';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Helper: compile a full QueryIntent to SQL string (same pattern as
// in-to-exists-plan-sql-agreement.test.ts)
// ---------------------------------------------------------------------------
function compileIntent(
	intent: QueryIntent,
	model: ReturnType<typeof schema>['model'],
): { sql: string; params: readonly unknown[] } {
	const planReport = plan(intent, model, {
		dialectCapabilities: POSTGRESQL_CAPABILITIES,
	});
	const adapter = createPgCompileOnlyAdapter();
	const result = adapter.compile(planReport, { model });
	return { sql: normalizeSQL(result.sql), params: result.parameters };
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
const testSchema = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
		active: { type: 'boolean' },
	},
	images: {
		id: { type: 'integer', primaryKey: true },
		product_id: { type: 'integer' },
	},
	products: {
		id: { type: 'integer', primaryKey: true },
		price: { type: 'number' },
	},
});

function buildOrm() {
	const adapter = createPgCompileOnlyAdapter({ model: testSchema.model });
	return createOrm({ model: testSchema.model, adapter });
}

// ---------------------------------------------------------------------------
// Helpers — build a raw WhereIntent exercising the IN-subquery path
// ---------------------------------------------------------------------------

function makeInSubqueryIntent(extraSubqueryFields: Record<string, unknown>) {
	return {
		kind: 'in' as const,
		field: 'id',
		subquery: {
			type: 'select' as const,
			from: 'images',
			select: { type: 'fields' as const, fields: ['product_id'] as const },
			...extraSubqueryFields,
		},
	};
}

function makeScalarSubqueryWhereIntent(
	extraSubqueryFields: Record<string, unknown>,
) {
	return {
		kind: 'subquery' as const,
		field: 'price',
		operator: 'gt' as const,
		subquery: {
			type: 'select' as const,
			from: 'products',
			select: {
				type: 'aggregate' as const,
				aggregates: [{ function: 'avg' as const, field: 'price' }],
			},
			...extraSubqueryFields,
		},
	};
}

// ============================================================================
// IN-subquery — unsupported modifiers must throw
// ============================================================================

describe('IN-subquery: unsupported modifiers throw clear error (filter-broadening guard)', () => {
	it('throws when subquery has GROUP BY', () => {
		const intent = makeInSubqueryIntent({ groupBy: ['product_id'] });
		expect(() => convertWhereCondition(intent as any, 'products')).toThrow(
			/GROUP BY in an IN subquery body is not supported yet \(#1087\)/,
		);
	});

	it('throws when subquery has HAVING', () => {
		const intent = makeInSubqueryIntent({
			groupBy: ['product_id'],
			having: {
				kind: 'comparison' as const,
				field: 'count',
				operator: 'gt' as const,
				value: 1,
			},
		});
		// having is guarded separately; GROUP BY is listed first
		expect(() => convertWhereCondition(intent as any, 'products')).toThrow(
			/GROUP BY in an IN subquery body is not supported yet \(#1087\)/,
		);
	});

	it('throws when subquery has HAVING without GROUP BY', () => {
		const intent = makeInSubqueryIntent({
			having: {
				kind: 'comparison' as const,
				field: 'count',
				operator: 'gt' as const,
				value: 1,
			},
		});
		expect(() => convertWhereCondition(intent as any, 'products')).toThrow(
			/HAVING in an IN subquery body is not supported yet \(#1087\)/,
		);
	});

	it('throws when subquery has OFFSET', () => {
		const intent = makeInSubqueryIntent({ offset: 5 });
		expect(() => convertWhereCondition(intent as any, 'products')).toThrow(
			/OFFSET in an IN subquery body is not supported yet \(#1087\)/,
		);
	});

	it('throws when subquery has DISTINCT', () => {
		const intent = makeInSubqueryIntent({ distinct: true });
		expect(() => convertWhereCondition(intent as any, 'products')).toThrow(
			/DISTINCT in an IN subquery body is not supported yet \(#1087\)/,
		);
	});

	it('throws when subquery has DISTINCT ON', () => {
		const intent = makeInSubqueryIntent({ distinctOn: ['product_id'] });
		expect(() => convertWhereCondition(intent as any, 'products')).toThrow(
			/DISTINCT ON in an IN subquery body is not supported yet \(#1087\)/,
		);
	});

	it('throws when subquery has an aggregate SELECT (filter broadening on IN path)', () => {
		const intent = {
			kind: 'in' as const,
			field: 'id',
			subquery: {
				type: 'select' as const,
				from: 'images',
				select: {
					type: 'aggregate' as const,
					aggregates: [{ function: 'count' as const, field: '*' }],
				},
			},
		};
		expect(() => convertWhereCondition(intent as any, 'products')).toThrow(
			/aggregate SELECT in an IN subquery body is not supported yet \(#1087\)/,
		);
	});

	it('the refusal is a NotYetSupportedError', () => {
		const intent = makeInSubqueryIntent({ groupBy: ['product_id'] });
		expect(() => convertWhereCondition(intent as any, 'products')).toThrow(
			NotYetSupportedError,
		);
	});
});

// ============================================================================
// Scalar subquery — unsupported modifiers must throw
// ============================================================================

describe('scalar subquery: unsupported modifiers throw clear error (filter-broadening guard)', () => {
	it('throws when subquery has GROUP BY', () => {
		const intent = makeScalarSubqueryWhereIntent({ groupBy: ['category'] });
		expect(() => convertWhereCondition(intent as any, 'products')).toThrow(
			/GROUP BY in a scalar subquery body is not supported yet \(#1087\)/,
		);
	});

	it('throws when subquery has HAVING', () => {
		const intent = makeScalarSubqueryWhereIntent({
			having: {
				kind: 'comparison' as const,
				field: 'count',
				operator: 'gt' as const,
				value: 1,
			},
		});
		expect(() => convertWhereCondition(intent as any, 'products')).toThrow(
			/HAVING in a scalar subquery body is not supported yet \(#1087\)/,
		);
	});

	it('throws when subquery has OFFSET', () => {
		const intent = makeScalarSubqueryWhereIntent({ offset: 10 });
		expect(() => convertWhereCondition(intent as any, 'products')).toThrow(
			/OFFSET in a scalar subquery body is not supported yet \(#1087\)/,
		);
	});

	it('throws when subquery has DISTINCT', () => {
		const intent = makeScalarSubqueryWhereIntent({ distinct: true });
		expect(() => convertWhereCondition(intent as any, 'products')).toThrow(
			/DISTINCT in a scalar subquery body is not supported yet \(#1087\)/,
		);
	});

	it('throws when subquery has DISTINCT ON', () => {
		const intent = makeScalarSubqueryWhereIntent({ distinctOn: ['category'] });
		expect(() => convertWhereCondition(intent as any, 'products')).toThrow(
			/DISTINCT ON in a scalar subquery body is not supported yet \(#1087\)/,
		);
	});

	it('the refusal is a NotYetSupportedError', () => {
		const intent = makeScalarSubqueryWhereIntent({ groupBy: ['category'] });
		expect(() => convertWhereCondition(intent as any, 'products')).toThrow(
			NotYetSupportedError,
		);
	});
});

// ============================================================================
// IN-subquery — supported modifiers still compile fine (no throw)
// ============================================================================

describe('IN-subquery: supported modifiers still compile (no false positives)', () => {
	it('compiles successfully with only where (inner filter)', () => {
		const orm = buildOrm();
		const dump = orm
			.select('products')
			.where(
				inSubquery(
					'id',
					subquery('images').select('product_id').where(eq('id', 1)),
				),
			)
			.dump();
		expect(dump.sql).toContain('ANY');
		expect(dump.sql).toContain('images');
	});

	it('compiles successfully with only limit', () => {
		// limit is faithfully propagated through convertIn → buildScalarSubquery
		const intent = {
			kind: 'in' as const,
			field: 'id',
			subquery: {
				type: 'select' as const,
				from: 'images',
				select: { type: 'fields' as const, fields: ['product_id'] as const },
				limit: 10,
			},
		};
		// Should not throw
		expect(() =>
			convertWhereCondition(intent as any, 'products'),
		).not.toThrow();
	});

	it('compiles successfully with only orderBy', () => {
		// orderBy is faithfully propagated through convertIn → buildScalarSubquery
		const intent = {
			kind: 'in' as const,
			field: 'id',
			subquery: {
				type: 'select' as const,
				from: 'images',
				select: { type: 'fields' as const, fields: ['product_id'] as const },
				orderBy: [{ field: 'product_id', direction: 'asc' }],
			},
		};
		// Should not throw
		expect(() =>
			convertWhereCondition(intent as any, 'products'),
		).not.toThrow();
	});

	it('compiles successfully with no extra modifiers (baseline)', () => {
		const orm = buildOrm();
		const dump = orm
			.select('products')
			.where(inSubquery('id', subquery('images').select('product_id')))
			.dump();
		expect(dump.sql).toContain('ANY');
		expect(dump.sql).toContain('images');
		expect(dump.params).toEqual([]);
	});
});

// ============================================================================
// NOT IN subquery — same guard applies
// ============================================================================

describe('NOT IN subquery: unsupported modifiers throw clear error', () => {
	it('throws when subquery has GROUP BY (not: true path)', () => {
		const intent = {
			kind: 'in' as const,
			field: 'id',
			not: true,
			subquery: {
				type: 'select' as const,
				from: 'images',
				select: { type: 'fields' as const, fields: ['product_id'] as const },
				groupBy: ['product_id'],
			},
		};
		expect(() => convertWhereCondition(intent as any, 'products')).toThrow(
			/GROUP BY in an IN subquery body is not supported yet \(#1087\)/,
		);
	});
});

// ============================================================================
// GAP #1 — IN-subquery must reject non-fields SELECT projections
// ============================================================================

describe('IN-subquery: non-fields SELECT projection is rejected (gap #1)', () => {
	it('throws when subquery has no select clause (would compile to SELECT *)', () => {
		const intent = {
			kind: 'in' as const,
			field: 'id',
			subquery: {
				type: 'select' as const,
				from: 'images',
				// no select — falls back to '*', invalid inside ANY(SELECT * ...)
			},
		};
		expect(() => convertWhereCondition(intent as any, 'products')).toThrow(
			/IN subquery with missing select.*is not supported/,
		);
	});

	it('throws when subquery has select: { type: "all" } (SELECT *)', () => {
		const intent = {
			kind: 'in' as const,
			field: 'id',
			subquery: {
				type: 'select' as const,
				from: 'images',
				select: { type: 'all' as const },
			},
		};
		expect(() => convertWhereCondition(intent as any, 'products')).toThrow(
			/IN subquery with SELECT \* \/ all.*is not supported/,
		);
	});

	it('throws when subquery has select: { type: "expressions" }', () => {
		const intent = {
			kind: 'in' as const,
			field: 'id',
			subquery: {
				type: 'select' as const,
				from: 'images',
				select: {
					type: 'expressions' as const,
					columns: [{ kind: 'ref' as const, column: 'product_id' }],
				},
			},
		};
		expect(() => convertWhereCondition(intent as any, 'products')).toThrow(
			/expressions SELECT in an IN subquery body is not supported yet \(#1087\)/,
		);
	});

	it('throws when subquery has select: { type: "fields", fields: [] } (empty list)', () => {
		const intent = {
			kind: 'in' as const,
			field: 'id',
			subquery: {
				type: 'select' as const,
				from: 'images',
				select: { type: 'fields' as const, fields: [] as const },
			},
		};
		expect(() => convertWhereCondition(intent as any, 'products')).toThrow(
			/IN subquery with empty fields list.*is not supported/,
		);
	});

	it('throws when subquery has select: { type: "fields", fields: ["a","b"] } (multi-field, defect #2)', () => {
		// Multi-field projection is silently truncated to fields[0] — the extra
		// column is dropped, producing semantically-wrong SQL. Must throw clearly.
		const intent = {
			kind: 'in' as const,
			field: 'id',
			subquery: {
				type: 'select' as const,
				from: 'images',
				select: {
					type: 'fields' as const,
					fields: ['product_id', 'category_id'] as const,
				},
			},
		};
		expect(() => convertWhereCondition(intent as any, 'products')).toThrow(
			/IN subquery with multi-field projection \[product_id, category_id\].*is not supported/,
		);
	});

	it('compiles correctly with select: { type: "fields", fields: ["product_id"] } (exactly 1 field)', () => {
		const intent = {
			kind: 'in' as const,
			field: 'id',
			subquery: {
				type: 'select' as const,
				from: 'images',
				select: { type: 'fields' as const, fields: ['product_id'] as const },
			},
		};
		// Should NOT throw
		expect(() =>
			convertWhereCondition(intent as any, 'products'),
		).not.toThrow();
	});
});

// ============================================================================
// GAP #1 — scalar subquery: expressions SELECT rejected
// ============================================================================

describe('scalar subquery: expressions SELECT rejected (gap #1)', () => {
	it('throws when subquery has select: { type: "expressions" }', () => {
		const intent = {
			kind: 'subquery' as const,
			field: 'price',
			operator: 'gt' as const,
			subquery: {
				type: 'select' as const,
				from: 'products',
				select: {
					type: 'expressions' as const,
					columns: [{ kind: 'ref' as const, column: 'price' }],
				},
			},
		};
		expect(() => convertWhereCondition(intent as any, 'products')).toThrow(
			/expressions SELECT in a scalar subquery body is not supported yet \(#1087\)/,
		);
	});
});

// ============================================================================
// GAP #2 — scalar subquery: LIMIT and ORDER BY are now propagated
// ============================================================================

describe('scalar subquery: LIMIT and ORDER BY are propagated through to SQL (gap #2)', () => {
	it('emits LIMIT in the scalar subquery SQL', () => {
		const intent = {
			kind: 'subquery' as const,
			field: 'price',
			operator: 'eq' as const,
			subquery: {
				type: 'select' as const,
				from: 'products',
				select: { type: 'fields' as const, fields: ['price'] as const },
				limit: 1,
			},
		};
		// Must not throw, and the compiled SQL must contain LIMIT
		const result = convertWhereCondition(intent as any, 'orders');
		expect(result).not.toBeNull();
		// limit is propagated onto the decision
		expect((result as any).limit).toBe(1);
	});

	it('propagates ORDER BY to PlanDecision with correct PlanDecision shape', () => {
		// PlanDecision.orderBy uses { field, direction: 'asc'|'desc' } (lowercase).
		// mapToHandlerDecision reads o.field → column for buildScalarSubquery.
		// Key fix: must NOT use { column, direction: 'ASC' } (wrong shape).
		const intent = {
			kind: 'subquery' as const,
			field: 'price',
			operator: 'lt' as const,
			subquery: {
				type: 'select' as const,
				from: 'products',
				select: { type: 'fields' as const, fields: ['price'] as const },
				orderBy: [{ field: 'price', direction: 'desc' as const }],
			},
		};
		const result = convertWhereCondition(intent as any, 'orders');
		expect(result).not.toBeNull();
		// PlanDecision.orderBy shape: { field, direction: lowercase }
		expect((result as any).orderBy).toEqual([
			{ field: 'price', direction: 'desc' },
		]);
	});

	it('emits ORDER BY and LIMIT in compiled SQL (end-to-end proof, gap #2)', () => {
		// This is the proof test: the ORDER BY column must actually appear in SQL.
		// Before the fix, orderBy entries were built with { column } not { field },
		// so mapToHandlerDecision read o.field = undefined → column: undefined →
		// buildScalarSubquery emitted sortBy(columnRef(undefined,...)) → lost sort.
		const intent: QueryIntent = {
			type: 'select',
			from: 'products',
			where: {
				kind: 'subquery',
				field: 'price',
				operator: 'eq',
				subquery: {
					type: 'select',
					from: 'products',
					select: { type: 'fields', fields: ['price'] },
					orderBy: [{ field: 'price', direction: 'asc' }],
					limit: 1,
				},
			} as any,
		};
		const { sql } = compileIntent(intent, testSchema.model);
		// ORDER BY and LIMIT must be present in the subquery clause
		expect(sql).toMatch(/order by/i);
		expect(sql).toMatch(/price/i);
		expect(sql).toMatch(/limit/i);
	});

	it('scalar subquery without limit/orderBy still compiles fine (regression guard)', () => {
		const intent = {
			kind: 'subquery' as const,
			field: 'price',
			operator: 'gt' as const,
			subquery: {
				type: 'select' as const,
				from: 'products',
				select: {
					type: 'aggregate' as const,
					aggregates: [{ function: 'avg' as const, field: 'price' }],
				},
			},
		};
		const result = convertWhereCondition(intent as any, 'products');
		expect(result).not.toBeNull();
		expect((result as any).aggregate).toBe('avg');
		expect((result as any).limit).toBeUndefined();
		expect((result as any).orderBy).toBeUndefined();
	});
});

// ============================================================================
// New structural modifiers guarded: existsWrap, lock, batchValuesSource
// ============================================================================

describe('IN/scalar subquery: existsWrap, lock, batchValuesSource throw', () => {
	it('IN subquery throws when existsWrap is set', () => {
		const intent = makeInSubqueryIntent({ existsWrap: true });
		expect(() => convertWhereCondition(intent as any, 'products')).toThrow(
			/existsWrap in an IN subquery body is not supported yet \(#1087\)/,
		);
	});

	it('scalar subquery throws when existsWrap is set', () => {
		const intent = makeScalarSubqueryWhereIntent({ existsWrap: true });
		expect(() => convertWhereCondition(intent as any, 'products')).toThrow(
			/existsWrap in a scalar subquery body is not supported yet \(#1087\)/,
		);
	});

	it('IN subquery throws when lock is set', () => {
		const intent = makeInSubqueryIntent({
			lock: { strength: 'for_update' as const },
		});
		expect(() => convertWhereCondition(intent as any, 'products')).toThrow(
			/lock in an IN subquery body is not supported yet \(#1087\)/,
		);
	});

	it('IN subquery throws when batchValuesSource is set', () => {
		const intent = makeInSubqueryIntent({
			batchValuesSource: { alias: 'v', columns: ['id'], params: [] },
		});
		expect(() => convertWhereCondition(intent as any, 'products')).toThrow(
			/batchValuesSource in an IN subquery body is not supported yet \(#1087\)/,
		);
	});
});

// ============================================================================
// Expression-based orderBy is rejected
// ============================================================================

describe('IN/scalar subquery: expression-based orderBy throws', () => {
	it('IN subquery throws when orderBy uses an expression (not a field name)', () => {
		const intent = makeInSubqueryIntent({
			orderBy: [
				{
					// OrderByExpressionIntent: has expression, no field
					expression: { kind: 'ref' as const, column: 'price' },
					direction: 'asc' as const,
				},
			],
		});
		expect(() => convertWhereCondition(intent as any, 'products')).toThrow(
			/ORDER BY with an expression in an IN subquery body is not supported yet \(#1087\)/,
		);
	});

	it('scalar subquery throws when orderBy uses an expression', () => {
		const intent = makeScalarSubqueryWhereIntent({
			orderBy: [
				{
					expression: { kind: 'ref' as const, column: 'price' },
					direction: 'desc' as const,
				},
			],
		});
		expect(() => convertWhereCondition(intent as any, 'products')).toThrow(
			/ORDER BY with an expression in a scalar subquery body is not supported yet \(#1087\)/,
		);
	});

	it('IN subquery with field-based orderBy still compiles (no false positive)', () => {
		const intent = makeInSubqueryIntent({
			orderBy: [{ field: 'product_id', direction: 'asc' as const }],
		});
		expect(() =>
			convertWhereCondition(intent as any, 'products'),
		).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// GAP 2: scalar subquery with multi-field projection rejects (silent truncation)
// ---------------------------------------------------------------------------

describe('scalar subquery — multi-field projection guard (GAP-2)', () => {
	it('throws when scalar subquery has a 2-field projection (would silently drop second column)', () => {
		const intent = {
			kind: 'subquery' as const,
			field: 'price',
			operator: 'gt' as const,
			subquery: {
				type: 'select' as const,
				from: 'products',
				select: {
					type: 'fields' as const,
					fields: ['price', 'cost'] as const,
				},
			},
		};
		expect(() => convertWhereCondition(intent as any, 'products')).toThrow(
			/scalar subquery with multi-field projection \[price, cost\].*is not supported/,
		);
	});

	it('does not throw for a scalar subquery with a single-field projection', () => {
		const intent = {
			kind: 'subquery' as const,
			field: 'price',
			operator: 'gt' as const,
			subquery: {
				type: 'select' as const,
				from: 'products',
				select: {
					type: 'fields' as const,
					fields: ['price'] as const,
				},
			},
		};
		expect(() =>
			convertWhereCondition(intent as any, 'products'),
		).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// DEFECT 2: rawExists/rawNotExists unsupported subquery modifiers
//
// buildSubqueryFromIntent (used by rawExistsHandler) only emits from/select/where.
// Modifiers limit, offset, groupBy, having, joins, include, distinct, distinctOn
// are SILENTLY DROPPED, which changes which rows match.
// The guard in convertWhereCondition must THROW a clear error for each of these.
// ---------------------------------------------------------------------------

describe('rawExists/rawNotExists — fail-loud guard for dropped subquery modifiers', () => {
	// Helper: build a minimal rawExists intent with extra fields on the subquery
	function makeRawExistsIntent(extraSubqueryFields: Record<string, unknown>) {
		return {
			kind: 'rawExists' as const,
			subquery: {
				type: 'select' as const,
				from: 'files',
				select: { type: 'fields' as const, fields: ['id'] as const },
				...extraSubqueryFields,
			},
		};
	}

	function makeRawNotExistsIntent(
		extraSubqueryFields: Record<string, unknown>,
	) {
		return {
			kind: 'rawNotExists' as const,
			subquery: {
				type: 'select' as const,
				from: 'files',
				select: { type: 'fields' as const, fields: ['id'] as const },
				...extraSubqueryFields,
			},
		};
	}

	// --- REJECT cases ---

	it('rawExists with LIMIT throws (buildSubqueryFromIntent does not emit LIMIT)', () => {
		const intent = makeRawExistsIntent({ limit: 0 });
		expect(() => convertWhereCondition(intent as any, 'users')).toThrow(
			/LIMIT.*not supported|not supported.*LIMIT/i,
		);
	});

	it('rawNotExists with LIMIT throws', () => {
		const intent = makeRawNotExistsIntent({ limit: 0 });
		expect(() => convertWhereCondition(intent as any, 'users')).toThrow(
			/LIMIT.*not supported|not supported.*LIMIT/i,
		);
	});

	it('rawExists with OFFSET throws', () => {
		const intent = makeRawExistsIntent({ offset: 5 });
		expect(() => convertWhereCondition(intent as any, 'users')).toThrow(
			/OFFSET.*not supported|not supported.*OFFSET/i,
		);
	});

	it('rawExists with GROUP BY throws', () => {
		const intent = makeRawExistsIntent({ groupBy: ['size'] });
		expect(() => convertWhereCondition(intent as any, 'users')).toThrow(
			/GROUP BY.*not supported|not supported.*GROUP BY/i,
		);
	});

	it('rawExists with HAVING throws', () => {
		const intent = makeRawExistsIntent({
			having: { kind: 'comparison', field: 'count', operator: 'gt', value: 1 },
		});
		expect(() => convertWhereCondition(intent as any, 'users')).toThrow(
			/HAVING.*not supported|not supported.*HAVING/i,
		);
	});

	it('rawExists with joins throws', () => {
		const intent = makeRawExistsIntent({
			joins: [{ table: 'other', on: 'other.id = files.otherId' }],
		});
		expect(() => convertWhereCondition(intent as any, 'users')).toThrow(
			/joins.*not supported|not supported.*joins/i,
		);
	});

	it('rawExists with include throws', () => {
		const intent = makeRawExistsIntent({ include: ['something'] });
		expect(() => convertWhereCondition(intent as any, 'users')).toThrow(
			/include.*not supported|not supported.*include/i,
		);
	});

	it('rawExists with DISTINCT throws', () => {
		const intent = makeRawExistsIntent({ distinct: true });
		expect(() => convertWhereCondition(intent as any, 'users')).toThrow(
			/DISTINCT.*not supported|not supported.*DISTINCT/i,
		);
	});

	it('rawExists with DISTINCT ON throws', () => {
		const intent = makeRawExistsIntent({ distinctOn: ['size'] });
		expect(() => convertWhereCondition(intent as any, 'users')).toThrow(
			/DISTINCT ON.*not supported|not supported.*DISTINCT ON/i,
		);
	});

	// --- PASS cases (modifiers buildSubqueryFromIntent DOES emit) ---

	it('rawExists with only WHERE does NOT throw (plain usage)', () => {
		const intent = makeRawExistsIntent({
			where: {
				kind: 'comparison',
				field: 'active',
				operator: 'eq',
				value: true,
			},
		});
		expect(() => convertWhereCondition(intent as any, 'users')).not.toThrow();
	});

	it('rawNotExists with only WHERE does NOT throw (plain usage)', () => {
		const intent = makeRawNotExistsIntent({
			where: {
				kind: 'comparison',
				field: 'active',
				operator: 'eq',
				value: true,
			},
		});
		expect(() => convertWhereCondition(intent as any, 'users')).not.toThrow();
	});

	it('rawExists with no modifiers at all does NOT throw', () => {
		const intent = makeRawExistsIntent({});
		expect(() => convertWhereCondition(intent as any, 'users')).not.toThrow();
	});

	it('error message identifies the context as rawExists', () => {
		const intent = makeRawExistsIntent({ limit: 1 });
		expect(() => convertWhereCondition(intent as any, 'users')).toThrow(
			/LIMIT in a rawExists subquery body is not supported yet \(#1087\)/,
		);
	});
});

// ---------------------------------------------------------------------------
// Not-yet and semantic classes of condition-body refusals (ADR 0010, #1027)
// ---------------------------------------------------------------------------
describe('condition-body refusal classes', () => {
	const bodySchema = schema({
		users: { id: { type: 'integer', primaryKey: true }, name: 'string' },
		posts: {
			id: { type: 'integer', primaryKey: true },
			authorId: ref('users', { as: 'author', inverse: 'authored' }),
		},
	});
	const orm = createOrm({
		model: bodySchema.model,
		adapter: createPgCompileOnlyAdapter({ model: bodySchema.model }),
	});
	const body = (extra: Record<string, unknown>) =>
		({
			type: 'select',
			from: 'posts',
			select: { type: 'fields', fields: ['authorId'] },
			...extra,
		}) as unknown as QueryIntent;
	const inBody = (extra: Record<string, unknown>) =>
		({ kind: 'in', field: 'id', subquery: body(extra) }) as WhereIntent;
	const scalarBody = (extra: Record<string, unknown>) =>
		({
			kind: 'subquery',
			field: 'id',
			operator: 'eq',
			subquery: body(extra),
		}) as WhereIntent;
	const rawBody = (extra: Record<string, unknown>) =>
		({ kind: 'rawExists', subquery: body(extra) }) as WhereIntent;
	const dump = (where: WhereIntent) => () =>
		orm.select('users').where(where).dump();
	const flat = [{ relation: 'author', strategy: 'flat' }];
	const hydrating = [{ relation: 'author' }];
	const join = [
		{
			table: 'users',
			on: { kind: 'comparison', field: 'id', operator: 'eq', value: 1 },
		},
	];
	const batch = { alias: 'v', columns: ['id'], params: [] };
	const one = (fn: string, field?: string) => ({
		function: fn,
		...(field !== undefined && { field }),
	});

	it('types the not-yet modifiers per body use', () => {
		for (const [where, construct, position, issue] of [
			[inBody({ groupBy: ['authorId'] }), 'GROUP BY', 'IN', 1087],
			[inBody({ having: eq('authorId', 1) }), 'HAVING', 'IN', 1087],
			[
				inBody({ groupBy: ['authorId'], having: eq('authorId', 1) }),
				'GROUP BY',
				'IN',
				1087,
			],
			[inBody({ distinctOn: ['authorId'] }), 'DISTINCT ON', 'IN', 1087],
			[inBody({ include: flat }), 'flat include', 'IN', 1087],
			[inBody({ joins: join }), 'joins', 'IN', 1087],
			[inBody({ existsWrap: true }), 'existsWrap', 'IN', 1087],
			[inBody({ lock: { strength: 'for_update' } }), 'lock', 'IN', 1087],
			[inBody({ batchValuesSource: batch }), 'batchValuesSource', 'IN', 1087],
			[
				inBody({
					orderBy: [
						{ expression: { kind: 'ref', column: 'id' }, direction: 'asc' },
					],
				}),
				'ORDER BY with an expression',
				'IN',
				1087,
			],
			[
				inBody({ select: { type: 'aggregate', aggregates: [one('count')] } }),
				'aggregate SELECT',
				'IN',
				1087,
			],
			[
				inBody({
					select: {
						type: 'aggregate',
						aggregates: [one('count'), one('count')],
					},
				}),
				'aggregate SELECT',
				'IN',
				1087,
			],
			[
				inBody({
					select: {
						type: 'expressions',
						columns: [{ kind: 'ref', column: 'authorId' }],
					},
				}),
				'expressions SELECT',
				'IN',
				1087,
			],
			[
				inBody({
					select: {
						type: 'expressions',
						columns: [
							{ kind: 'ref', column: 'authorId' },
							{ kind: 'ref', column: 'id' },
						],
					},
				}),
				'expressions SELECT',
				'IN',
				1087,
			],
			[
				inBody({
					existsWrap: true,
					select: { type: 'fields', fields: ['authorId', 'id'] },
				}),
				'existsWrap',
				'IN',
				1087,
			],
			[
				inBody({ existsWrap: true, include: hydrating }),
				'existsWrap',
				'IN',
				1087,
			],
			[scalarBody({ distinct: true }), 'DISTINCT', 'scalar', 1087],
			[scalarBody({ joins: join }), 'joins', 'scalar', 1039],
			[
				scalarBody({ batchValuesSource: batch }),
				'batchValuesSource',
				'scalar',
				1031,
			],
			[scalarBody({ include: flat }), 'flat include', 'scalar', 1030],
			[
				scalarBody({
					select: {
						type: 'aggregate',
						aggregates: [one('count'), one('max', 'id')],
					},
				}),
				'aggregate SELECT',
				'scalar',
				1087,
			],
			[
				scalarBody({
					select: {
						type: 'expressions',
						columns: [{ kind: 'ref', column: 'authorId' }],
					},
				}),
				'expressions SELECT',
				'scalar',
				1087,
			],
			[rawBody({ offset: 1, distinct: true }), 'OFFSET', 'rawExists', 1087],
			[rawBody({ include: hydrating }), 'include', 'rawExists', 1087],
			[rawBody({ limit: 1 }), 'LIMIT', 'rawExists', 1087],
			[
				rawBody({ orderBy: [{ field: 'id', direction: 'asc' }] }),
				'ORDER BY',
				'rawExists',
				1087,
			],
		] as const)
			expect(dump(where), `${construct} in ${position}`).toThrow(
				new NotYetSupportedError(construct, `${position} subquery body`, issue),
			);
		expect(() =>
			createPgCompileOnlyAdapter({ model: bodySchema.model }).compileUpdate({
				type: 'update',
				table: 'users',
				set: { name: 'x' },
				where: inBody({ groupBy: ['authorId'] }),
			}),
		).toThrow(new NotYetSupportedError('GROUP BY', 'IN subquery body', 1087));
	});

	it('keeps semantic projection refusals as plain errors', () => {
		const IN_ONE = 'IN subquery must project exactly one named column';
		for (const [where, message] of [
			[
				inBody({ select: { type: 'fields', fields: ['authorId', 'id'] } }),
				`IN subquery with multi-field projection [authorId, id] (${IN_ONE} — use a single field) is not supported.`,
			],
			[
				inBody({
					groupBy: ['authorId'],
					select: { type: 'fields', fields: ['authorId', 'id'] },
				}),
				`IN subquery with multi-field projection [authorId, id] (${IN_ONE} — use a single field) is not supported.`,
			],
			[
				inBody({ include: hydrating }),
				'IN subquery with include (relation hydration) is not supported.',
			],
			[
				inBody({ include: [...flat, ...hydrating] }),
				'IN subquery with include (relation hydration) is not supported.',
			],
			[
				inBody({ select: undefined }),
				`IN subquery with missing select (${IN_ONE}) is not supported.`,
			],
			[
				inBody({ select: { type: 'all' } }),
				`IN subquery with SELECT * / all (${IN_ONE}) is not supported.`,
			],
			[
				inBody({ select: { type: 'fields', fields: [] } }),
				`IN subquery with empty fields list (${IN_ONE}) is not supported.`,
			],
			[
				inBody({ select: { type: 'fields', fields: [5] } }),
				'IN subquery with non-string field element 5 (IN subquery fields must contain a plain column name string) is not supported.',
			],
			[
				scalarBody({ select: { type: 'fields', fields: ['authorId', 'id'] } }),
				'scalar subquery with multi-field projection [authorId, id] (scalar subquery must project exactly one column — use a single field) is not supported.',
			],
			[
				scalarBody({ include: hydrating }),
				'scalar subquery with include (relation hydration) is not supported.',
			],
		] as const)
			expect(dump(where), message).toThrow(new Error(message));
	});
});
