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

import { createOrm, eq, inSubquery, schema, subquery } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { convertWhereCondition } from '../intent-to-decisions.js';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

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
