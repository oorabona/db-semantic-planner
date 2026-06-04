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
	schema,
	subquery,
} from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { normalizeSQL } from '../ast-helpers.js';
import { convertWhereCondition } from '../intent-to-decisions.js';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

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
	const adapter = createPgsqlCompileOnlyAdapter();
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
		price: { type: 'numeric' },
	},
});

function buildOrm() {
	const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });
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

function makeScalarSubqueryIntent(
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
			/IN subquery with GROUP BY is not supported/,
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
			/IN subquery with.*is not supported/,
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
			/IN subquery with HAVING is not supported/,
		);
	});

	it('throws when subquery has OFFSET', () => {
		const intent = makeInSubqueryIntent({ offset: 5 });
		expect(() => convertWhereCondition(intent as any, 'products')).toThrow(
			/IN subquery with OFFSET is not supported/,
		);
	});

	it('throws when subquery has DISTINCT', () => {
		const intent = makeInSubqueryIntent({ distinct: true });
		expect(() => convertWhereCondition(intent as any, 'products')).toThrow(
			/IN subquery with DISTINCT is not supported/,
		);
	});

	it('throws when subquery has DISTINCT ON', () => {
		const intent = makeInSubqueryIntent({ distinctOn: ['product_id'] });
		expect(() => convertWhereCondition(intent as any, 'products')).toThrow(
			/IN subquery with DISTINCT ON is not supported/,
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
			/IN subquery with aggregate SELECT.*is not supported/,
		);
	});

	it('error message mentions restructuring or CTE', () => {
		const intent = makeInSubqueryIntent({ groupBy: ['product_id'] });
		expect(() => convertWhereCondition(intent as any, 'products')).toThrow(
			/restructure the query or use a CTE/,
		);
	});
});

// ============================================================================
// Scalar subquery — unsupported modifiers must throw
// ============================================================================

describe('scalar subquery: unsupported modifiers throw clear error (filter-broadening guard)', () => {
	it('throws when subquery has GROUP BY', () => {
		const intent = makeScalarSubqueryIntent({ groupBy: ['category'] });
		expect(() => convertWhereCondition(intent as any, 'products')).toThrow(
			/scalar subquery with GROUP BY is not supported/,
		);
	});

	it('throws when subquery has HAVING', () => {
		const intent = makeScalarSubqueryIntent({
			having: {
				kind: 'comparison' as const,
				field: 'count',
				operator: 'gt' as const,
				value: 1,
			},
		});
		expect(() => convertWhereCondition(intent as any, 'products')).toThrow(
			/scalar subquery with HAVING is not supported/,
		);
	});

	it('throws when subquery has OFFSET', () => {
		const intent = makeScalarSubqueryIntent({ offset: 10 });
		expect(() => convertWhereCondition(intent as any, 'products')).toThrow(
			/scalar subquery with OFFSET is not supported/,
		);
	});

	it('throws when subquery has DISTINCT', () => {
		const intent = makeScalarSubqueryIntent({ distinct: true });
		expect(() => convertWhereCondition(intent as any, 'products')).toThrow(
			/scalar subquery with DISTINCT is not supported/,
		);
	});

	it('throws when subquery has DISTINCT ON', () => {
		const intent = makeScalarSubqueryIntent({ distinctOn: ['category'] });
		expect(() => convertWhereCondition(intent as any, 'products')).toThrow(
			/scalar subquery with DISTINCT ON is not supported/,
		);
	});

	it('error message mentions restructuring or CTE', () => {
		const intent = makeScalarSubqueryIntent({ groupBy: ['category'] });
		expect(() => convertWhereCondition(intent as any, 'products')).toThrow(
			/restructure the query or use a CTE/,
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
			/IN subquery with GROUP BY is not supported/,
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
			/IN subquery with expressions SELECT.*is not supported/,
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
			/scalar subquery with expressions SELECT.*is not supported/,
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
			/IN subquery with existsWrap is not supported/,
		);
	});

	it('scalar subquery throws when existsWrap is set', () => {
		const intent = makeScalarSubqueryIntent({ existsWrap: true });
		expect(() => convertWhereCondition(intent as any, 'products')).toThrow(
			/scalar subquery with existsWrap is not supported/,
		);
	});

	it('IN subquery throws when lock is set', () => {
		const intent = makeInSubqueryIntent({
			lock: { strength: 'for_update' as const },
		});
		expect(() => convertWhereCondition(intent as any, 'products')).toThrow(
			/IN subquery with lock is not supported/,
		);
	});

	it('IN subquery throws when batchValuesSource is set', () => {
		const intent = makeInSubqueryIntent({
			batchValuesSource: { alias: 'v', columns: ['id'], params: [] },
		});
		expect(() => convertWhereCondition(intent as any, 'products')).toThrow(
			/IN subquery with batchValuesSource is not supported/,
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
			/IN subquery with orderBy with expression.*is not supported/,
		);
	});

	it('scalar subquery throws when orderBy uses an expression', () => {
		const intent = makeScalarSubqueryIntent({
			orderBy: [
				{
					expression: { kind: 'ref' as const, column: 'price' },
					direction: 'desc' as const,
				},
			],
		});
		expect(() => convertWhereCondition(intent as any, 'products')).toThrow(
			/scalar subquery with orderBy with expression.*is not supported/,
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
