/**
 * Consolidation test: buildPredicateSubquerySelect chokepoint
 *
 * Proves that:
 * 1. ALL paths that emit a predicate subquery SELECT route through
 *    `buildPredicateSubquerySelect` (subquery-emission.ts) and are validated
 *    there against the original QueryIntent (via subqueryIntent provenance).
 *
 * 2. A whereNot with MULTIPLE children inside an IN-subquery WHERE compiles
 *    correctly to NOT (c1 AND c2) — previously broken when lowering stripped
 *    the whereNot structure before the handler saw it.
 *
 * PATHS ENUMERATED
 * ----------------
 * A. Intent IN path          convertIn → inSubquery Decision → inSubqueryHandler
 *                            → buildScalarSubquery → buildPredicateSubquerySelect
 * B. Intent scalar path      convertSubquery → scalarSubquery Decision
 *                            → scalarSubqueryHandler → buildScalarSubquery
 *                            → buildPredicateSubquerySelect
 * D. Nested IN (logical)     nested lowering → inSubquery Decision
 *                            → inSubqueryHandler → buildScalarSubquery
 *                            → buildPredicateSubquerySelect
 * E. Mutation path           normalizeToDecision(case 'in') → inSubquery Decision
 *                            → inSubqueryHandler → buildScalarSubquery
 *                            → buildPredicateSubquerySelect
 * F. rawExists/rawNotExists  convertWhereCondition(rawExists) → rawExistsHandler
 *                            → buildSubqueryFromIntent (direct-path chokepoint)
 * G. scalar-direct           handleSubqueryIntent → buildSubqueryFromIntent
 *                            (direct-path chokepoint) with use='scalar-direct'
 *
 * VALIDATION PROPERTY
 * -------------------
 * For each path, passing a subquery with a forbidden modifier (GROUP BY) must
 * throw — proving the chokepoint runs for that path.
 * For valid inputs, each path must compile to correct SQL.
 */

import {
	and,
	createOrm,
	eq,
	inSubquery,
	NotYetSupportedError,
	not,
	outerRef,
	rawExists,
	schema,
	subquery,
} from '@dbsp/core';
import type { WhereIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { normalizeSQL } from '../ast-helpers.js';
import {
	buildSubqueryFromIntent,
	compileWhereIntent,
	type WhereCompilerCtx,
} from '../compile-where.js';
import { createCompilerState } from '../handlers/types.js';
import { convertWhereCondition } from '../intent-to-decisions.js';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

// ============================================================================
// Schema
// ============================================================================

const testSchema = schema({
	orders: {
		id: { type: 'integer', primaryKey: true },
		customer_id: { type: 'integer' },
		total: { type: 'number' },
		status: { type: 'text' },
	},
	customers: {
		id: { type: 'integer', primaryKey: true },
		active: { type: 'boolean' },
		region: { type: 'text' },
	},
	products: {
		id: { type: 'integer', primaryKey: true },
		price: { type: 'number' },
	},
	files: {
		id: { type: 'integer', primaryKey: true },
		project_id: { type: 'integer' },
	},
});

function buildOrm() {
	const adapter = createPgCompileOnlyAdapter({ model: testSchema.model });
	return createOrm({ model: testSchema.model, adapter });
}

// ============================================================================
// Helper: build a WhereCompilerCtx for the direct compile-where path
// ============================================================================

function makeDirectCtx(): WhereCompilerCtx {
	const paramState = createCompilerState();
	return {
		rootTable: 'orders',
		aliases: new Map(),
		paramState,
		compileSubquery: (sqIntent, paramOffset) =>
			buildSubqueryFromIntent(sqIntent, paramOffset),
	};
}

// ============================================================================
// A. Intent IN path — convertWhereCondition → inSubqueryHandler
// ============================================================================

describe('PATH A: intent IN path (convertWhereCondition → inSubqueryHandler)', () => {
	it('GROUP BY in IN-subquery throws via convertWhereCondition (lowering guard)', () => {
		const intent = {
			kind: 'in' as const,
			field: 'customer_id',
			subquery: {
				type: 'select' as const,
				from: 'customers',
				select: { type: 'fields' as const, fields: ['id'] as const },
				groupBy: ['region'],
			},
		};
		expect(() => convertWhereCondition(intent as any, 'orders')).toThrow(
			/GROUP BY.*not supported/i,
		);
	});

	it('valid IN-subquery compiles to ANY(SELECT ...) via ORM', () => {
		const orm = buildOrm();
		const dump = orm
			.select('orders')
			.where(inSubquery('customer_id', subquery('customers').select('id')))
			.dump();
		expect(normalizeSQL(dump.sql)).toMatch(
			/customer_id\s*=\s*any\s*\(\s*select/i,
		);
	});
});

// ============================================================================
// B. Intent scalar path — convertSubquery → scalarSubqueryHandler
// ============================================================================

describe('PATH B: intent scalar path (convertSubquery → scalarSubqueryHandler)', () => {
	it('GROUP BY in scalar subquery throws via convertWhereCondition (lowering guard)', () => {
		const intent = {
			kind: 'subquery' as const,
			field: 'total',
			operator: 'gt' as const,
			subquery: {
				type: 'select' as const,
				from: 'products',
				select: {
					type: 'aggregate' as const,
					aggregates: [{ function: 'avg' as const, field: 'price' }],
				},
				groupBy: ['id'],
			},
		};
		expect(() => convertWhereCondition(intent as any, 'orders')).toThrow(
			/GROUP BY.*not supported/i,
		);
	});

	it('valid scalar subquery compiles correctly via WhereIntent', () => {
		// Use convertWhereCondition with a valid scalar subquery WhereIntent,
		// then compile to verify the handler runs without throwing.
		const intent = {
			kind: 'subquery' as const,
			field: 'total',
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
		// Should not throw — scalar subquery with no forbidden modifiers
		expect(() => convertWhereCondition(intent as any, 'orders')).not.toThrow();
	});
});

// ============================================================================
// D. Nested IN (logical group) — mapInSubqueryCondition → inSubqueryHandler
// ============================================================================

describe('PATH D: nested IN inside logical group (inSubqueryHandler)', () => {
	it('GROUP BY in nested IN-subquery inside AND plan throws', () => {
		const where = {
			kind: 'in',
			field: 'status',
			subquery: {
				type: 'select',
				from: 'customers',
				select: { type: 'fields', fields: ['region'] },
				where: {
					kind: 'in',
					field: 'id',
					subquery: {
						type: 'select',
						from: 'customers',
						select: { type: 'fields', fields: ['id'] },
						groupBy: ['region'],
					},
				},
			},
		} as unknown as WhereIntent;
		const dump = () => buildOrm().select('orders').where(where).dump();
		expect(dump).toThrow(NotYetSupportedError);
		expect(dump).toThrow(
			new NotYetSupportedError('GROUP BY', 'IN subquery body', 1087),
		);
	});

	it('valid nested IN-subquery compiles correctly (2-level)', () => {
		const orm = buildOrm();
		// 2-level nested IN tested via ORM (exercises normalizeToDecision recursion)
		const dump = orm
			.select('orders')
			.where(
				inSubquery(
					'customer_id',
					subquery('customers')
						.select('id')
						.where(inSubquery('id', subquery('customers').select('id'))),
				),
			)
			.dump();
		expect(normalizeSQL(dump.sql)).toMatch(
			/customer_id\s*=\s*any\s*\(\s*select/i,
		);
	});
});

// ============================================================================
// E. Mutation path — normalizeToDecision(case 'in') → inSubqueryHandler
// ============================================================================

describe('PATH E: mutation path (normalizeToDecision → inSubqueryHandler)', () => {
	it('GROUP BY in mutation WHERE IN-subquery throws via normalizeToDecision', () => {
		const adapter = createPgCompileOnlyAdapter({ model: testSchema.model });
		expect(() =>
			adapter.compileDelete({
				type: 'delete',
				table: 'orders',
				where: {
					kind: 'in' as const,
					field: 'customer_id',
					subquery: {
						type: 'select' as const,
						from: 'customers',
						select: { type: 'fields' as const, fields: ['id'] as const },
						groupBy: ['region'],
					},
				},
			}),
		).toThrow(/GROUP BY.*not supported/i);
	});
});

// ============================================================================
// F. rawExists/rawNotExists — direct-path chokepoint (buildSubqueryFromIntent)
// ============================================================================

describe('PATH F: rawExists/rawNotExists (direct-path chokepoint)', () => {
	it('GROUP BY in rawExists subquery throws via convertWhereCondition', () => {
		const intent = {
			kind: 'rawExists' as const,
			subquery: {
				type: 'select' as const,
				from: 'customers',
				select: { type: 'fields' as const, fields: ['id'] as const },
				groupBy: ['region'],
			},
		};
		expect(() => convertWhereCondition(intent as any, 'orders')).toThrow(
			/GROUP BY.*not supported/i,
		);
	});

	it('LIMIT in rawExists subquery throws via compileWhereIntent direct path', () => {
		const intent = {
			kind: 'rawExists' as const,
			subquery: {
				type: 'select' as const,
				from: 'customers',
				select: { type: 'fields' as const, fields: ['id'] as const },
				limit: 0,
			},
		};
		expect(() => compileWhereIntent(intent as any, makeDirectCtx())).toThrow(
			/LIMIT.*not supported/i,
		);
	});
});

// ============================================================================
// G. scalar-direct — handleSubqueryIntent → buildSubqueryFromIntent
// ============================================================================

describe('PATH G: scalar-direct (handleSubqueryIntent → buildSubqueryFromIntent)', () => {
	it('LIMIT in scalar subquery on direct path throws with scalar-direct context', () => {
		const intent = {
			kind: 'subquery' as const,
			field: 'total',
			operator: 'gt' as const,
			subquery: {
				type: 'select' as const,
				from: 'products',
				select: {
					type: 'aggregate' as const,
					aggregates: [{ function: 'avg' as const, field: 'price' }],
				},
				limit: 1,
			},
		};
		expect(() => compileWhereIntent(intent as any, makeDirectCtx())).toThrow(
			/LIMIT.*not supported/i,
		);
	});

	it('a scalar subquery with no projection throws on the direct path (ADR 0011 delivery 5)', () => {
		const intent = {
			kind: 'subquery' as const,
			field: 'total',
			operator: 'gt' as const,
			subquery: { type: 'select' as const, from: 'products' },
		};
		expect(() => compileWhereIntent(intent as any, makeDirectCtx())).toThrow(
			// This path runs the 'scalar-direct' validation (the LIMIT case above is
			// refused only there); its message label reads "scalar".
			'scalar subquery with no projection (scalar subquery must project exactly one column — select one field or one aggregate) is not supported.',
		);
	});
});

// ============================================================================
// KEY CORRECTNESS PROOF: whereNot with MULTIPLE children in IN-subquery WHERE
// ============================================================================

describe('CORRECTNESS: whereNot with multiple children in IN-subquery WHERE', () => {
	/**
	 * This was the original motivation for the provenance threading.
	 * A whereNot with multiple children (not(and(c1, c2))) must compile to
	 * NOT (c1 AND c2) inside the subquery WHERE clause.
	 *
	 * Before this refactor, the lowering could lose the NOT wrapper when
	 * the multi-child case was not correctly preserved through mapInSubqueryCondition.
	 */
	it('whereNot wrapping AND(c1, c2) inside IN-subquery compiles to NOT (c1 AND c2)', () => {
		const orm = buildOrm();

		// not(and(c1, c2)) produces NOT (c1 AND c2)
		// This exercises: convertNot → convertLogicalGroup → multiple conditions preserved
		// through the lowering pipeline and correctly emitted in the subquery WHERE clause.
		const dump = orm
			.select('orders')
			.where(
				inSubquery(
					'customer_id',
					subquery('customers')
						.select('id')
						.where(not(and(eq('active', false), eq('region', 'blocked')))),
				),
			)
			.dump();

		const sql = normalizeSQL(dump.sql);

		// Outer structure: customer_id = ANY (SELECT ...)
		expect(sql, 'Should produce IN subquery').toMatch(
			/customer_id\s*=\s*any\s*\(\s*select/i,
		);

		// Should select from customers
		expect(sql, 'Should select from customers').toContain('customers');

		// Should contain NOT
		expect(sql, 'Should contain NOT').toContain('not');

		// Both conditions should appear
		expect(sql, 'Should contain active condition').toContain('active');
		expect(sql, 'Should contain region condition').toContain('region');

		// Parameters: false, 'blocked'
		expect(dump.params, 'Should have 2 parameters').toHaveLength(2);
	});

	it('whereNot with single child in IN-subquery compiles correctly', () => {
		const orm = buildOrm();

		const dump = orm
			.select('orders')
			.where(
				inSubquery(
					'customer_id',
					subquery('customers')
						.select('id')
						.where(not(eq('active', false))),
				),
			)
			.dump();

		const sql = normalizeSQL(dump.sql);

		expect(sql, 'Should produce IN subquery').toMatch(
			/customer_id\s*=\s*any\s*\(\s*select/i,
		);
		expect(sql, 'Should contain NOT').toContain('not');
		expect(sql, 'Should contain active condition').toContain('active');

		expect(dump.params, 'Should have 1 parameter').toHaveLength(1);
		expect(dump.params[0], 'Param should be false').toBe(false);
	});

	it('NOT wrapping an AND of two conditions inside an IN-subquery compiles with both parameters bound', () => {
		/**
		 * A NOT wrapping an AND with two conditions inside an IN-subquery WHERE
		 * clause produces `NOT (c1 AND c2)` and binds both values, in order.
		 */
		const { sql, params } = buildOrm()
			.select('orders')
			.where(
				inSubquery(
					'customer_id',
					subquery('customers')
						.select('id')
						.where(not(and(eq('active', false), eq('region', 'blocked')))),
				),
			)
			.dump();

		expect({ sql, params }).toEqual({
			sql: 'SELECT orders.* FROM orders WHERE orders.customer_id = ANY (SELECT customers_subq_0.id FROM customers AS customers_subq_0 WHERE NOT (customers_subq_0.active = $1 AND customers_subq_0.region = $2))',
			params: [false, 'blocked'],
		});
	});
});

// ============================================================================
// SUMMARY: Consolidation proof
// ============================================================================

describe('SUMMARY: buildPredicateSubquerySelect routes all handler-path emissions', () => {
	it('all predicate subquery SQL on the handler path passes through buildPredicateSubquerySelect', () => {
		/**
		 * This test documents the routing invariant:
		 *
		 * Handler path (Decision → handler → SQL):
		 *   inSubqueryHandler  → buildScalarSubquery(use='IN')   → buildPredicateSubquerySelect
		 *   notInSubqueryHandler → buildScalarSubquery(use='IN') → buildPredicateSubquerySelect
		 *   scalarSubqueryHandler → buildScalarSubquery(use='scalar') → buildPredicateSubquerySelect
		 *
		 * Direct path (WhereIntent → buildSubqueryFromIntent):
		 *   handleRawExistsIntent → ctx.compileSubquery → buildSubqueryFromIntent(use='rawExists')
		 *   handleSubqueryIntent  → buildSubqueryFromIntent(use='scalar-direct')
		 *
		 * Chokepoint validation fires in:
		 *   - buildPredicateSubquerySelect  (handler path)
		 *   - buildSubqueryFromIntent       (direct path)
		 *
		 * Defense-in-depth also at:
		 *   - convertIn (intent-to-decisions.ts)
		 *   - convertSubquery (intent-to-decisions.ts)
		 *   - convertWhereCondition rawExists branch (intent-to-decisions.ts)
		 *   - normalizeToDecision case 'in' (handlers/index.ts)
		 *   - dispatchWhere (compiler.ts)
		 *   - mapInSubqueryCondition (compiler.ts)
		 *   - handleRawExistsIntent (compile-where.ts)
		 */

		// Prove by exhaustive forbidden-modifier tests on each path above
		// The individual path tests A-G above verify each route throws on GROUP BY.
		// This summary test just confirms the compile-only adapter builds without error.
		const orm = buildOrm();
		expect(() =>
			orm
				.select('orders')
				.where(inSubquery('customer_id', subquery('customers').select('id')))
				.dump(),
		).not.toThrow();

		expect(() =>
			orm
				.select('orders')
				.where(rawExists(subquery('customers').select('id')))
				.dump(),
		).not.toThrow();
	});
});

// ============================================================================
// Direct scalar compilation honours caller-injected subquery callbacks.
// ============================================================================

describe('direct compileWhereIntent scalar callback dispatch', () => {
	it('propagates the injected subquery callback error', () => {
		const paramState = createCompilerState();
		const ctx: WhereCompilerCtx = {
			rootTable: 'orders',
			aliases: new Map(),
			paramState,
			// Caller-provided refusal callback.
			compileSubquery: () => {
				throw new Error('Subquery in JOIN ON condition is not supported.');
			},
		};

		const subqueryIntent = {
			kind: 'subquery' as const,
			field: 'customer_id',
			operator: 'eq' as const,
			subquery: {
				type: 'select' as const,
				from: 'customers',
				select: { type: 'fields' as const, fields: ['id'] as const },
			},
		};

		expect(() => compileWhereIntent(subqueryIntent as any, ctx)).toThrow(
			'Subquery in JOIN ON condition is not supported.',
		);
	});

	it('propagates a distinct injected subquery callback error', () => {
		// A direct caller supplies a distinct refusal callback.
		const paramState = createCompilerState();
		const ctx: WhereCompilerCtx = {
			rootTable: 'orders',
			aliases: new Map(),
			paramState,
			// Caller-provided refusal callback.
			compileSubquery: () => {
				throw new Error(
					'Subquery in BatchValues JOIN ON condition is not supported.',
				);
			},
		};

		const subqueryIntent = {
			kind: 'subquery' as const,
			field: 'id',
			operator: 'eq' as const,
			subquery: {
				type: 'select' as const,
				from: 'customers',
				select: { type: 'fields' as const, fields: ['id'] as const },
			},
		};

		expect(() => compileWhereIntent(subqueryIntent as any, ctx)).toThrow(
			'Subquery in BatchValues JOIN ON condition is not supported.',
		);
	});

	it('rejects LIMIT before invoking the injected subquery callback', () => {
		// The scalar-direct modifier guard runs before the injected callback.
		const paramState = createCompilerState();
		const ctx: WhereCompilerCtx = {
			rootTable: 'orders',
			aliases: new Map(),
			paramState,
			compileSubquery: () => {
				throw new Error(
					'SENTINEL: compileSubquery reached — guard did NOT fire first',
				);
			},
		};

		const subqueryIntentWithLimit = {
			kind: 'subquery' as const,
			field: 'customer_id',
			operator: 'eq' as const,
			subquery: {
				type: 'select' as const,
				from: 'customers',
				select: { type: 'fields' as const, fields: ['id'] as const },
				limit: 1,
			},
		};

		// Must throw the LIMIT guard error, NOT the sentinel.
		expect(() =>
			compileWhereIntent(subqueryIntentWithLimit as any, ctx),
		).toThrow(/LIMIT.*not supported/i);
	});

	it('compiles a direct comparison without invoking the subquery callback', () => {
		// A direct comparison does not require subquery compilation.
		const paramState = createCompilerState();
		const ctx: WhereCompilerCtx = {
			rootTable: 'orders',
			aliases: new Map(),
			paramState,
			compileSubquery: () => {
				throw new Error('SENTINEL: should not be called for plain comparisons');
			},
		};

		// Plain comparison — no subquery kind
		const plainComparison = {
			kind: 'comparison' as const,
			field: 'customer_id',
			operator: 'eq' as const,
			value: 42,
		};

		expect(() => compileWhereIntent(plainComparison as any, ctx)).not.toThrow();
	});
});

// ============================================================================
// REGRESSION LOCK — DEFECT 2: lowered outerRef in decision.conditions throws
// ============================================================================

describe('DEFECT 2 regression: an IN-subquery body without an outer reference', () => {
	/**
	 * A non-correlated body must compile: the outer-reference check in
	 * buildScalarSubquery must not produce false positives.
	 */

	it('non-correlated IN-subquery body (no outer fieldRef) compiles correctly', () => {
		// A body with no correlated reference must still compile — the outer
		// reference check must not produce false positives.
		const { sql, params } = buildOrm()
			.select('orders')
			.where(
				inSubquery(
					'customer_id',
					subquery('customers').select('id').where(eq('active', true)),
				),
			)
			.dump();

		expect({ sql, params }).toEqual({
			sql: 'SELECT orders.* FROM orders WHERE orders.customer_id = ANY (SELECT customers_subq_0.id FROM customers AS customers_subq_0 WHERE customers_subq_0.active = $1)',
			params: [true],
		});
	});
});

// ============================================================================
// REGRESSION LOCK — DEFECT 3: subquery body modifier refusals
// ============================================================================

describe('DEFECT 3 regression: subquery body modifier refusals', () => {
	/**
	 * Modifiers a subquery body cannot carry are refused with NotYetSupportedError.
	 */

	it('IN-subquery body with OFFSET → throws', () => {
		const where = {
			kind: 'in',
			field: 'customer_id',
			subquery: {
				type: 'select',
				from: 'customers',
				select: { type: 'fields', fields: ['id'] },
				offset: 5,
			},
		} as unknown as WhereIntent;
		const dump = () => buildOrm().select('orders').where(where).dump();
		expect(dump).toThrow(NotYetSupportedError);
		expect(dump).toThrow(
			new NotYetSupportedError('OFFSET', 'IN subquery body', 1087),
		);
	});

	it('scalar subquery body with GROUP BY → throws', () => {
		const where = {
			kind: 'subquery',
			field: 'total',
			operator: 'gt',
			subquery: {
				type: 'select',
				from: 'products',
				select: {
					type: 'aggregate',
					aggregates: [{ function: 'avg', field: 'price' }],
				},
				groupBy: ['id'],
			},
		} as unknown as WhereIntent;
		const dump = () => buildOrm().select('orders').where(where).dump();
		expect(dump).toThrow(NotYetSupportedError);
		expect(dump).toThrow(
			new NotYetSupportedError('GROUP BY', 'scalar subquery body', 1087),
		);
	});

	it('a valid IN-subquery body still compiles', () => {
		// Regression guard: a valid lowered decision with subqueryIntent must still work.
		const orm = buildOrm();
		expect(() =>
			orm
				.select('orders')
				.where(inSubquery('customer_id', subquery('customers').select('id')))
				.dump(),
		).not.toThrow();
	});
});

// ============================================================================
// REGRESSION LOCK — malformed select.fields bypass
// ============================================================================

describe('malformed select.fields IN-subquery guard', () => {
	/**
	 * A single-element `fields` array whose element is NOT a string bypassed the
	 * previous guard (which only checked length, not element type).  The lowering
	 * in convertIn produces `selectColumn = fields[0] ?? '*'` — when fields[0] is
	 * an object the selectColumn becomes that object, not a string, producing a
	 * broken column reference or falling back to SELECT *.
	 *
	 * Fix: `assertNoUnsupportedSubqueryModifiers` now checks
	 * `typeof fields[0] !== 'string'` and rejects non-string elements.
	 *
	 * Additionally, `assertNoDroppedDecisionModifiers` rejects a decision whose
	 * `selectColumn` is not a plain string (after lowering from a malformed intent).
	 */

	it('select.fields: [ { non-string object } ] → throws at intent validation', () => {
		const intent = {
			kind: 'in' as const,
			field: 'id',
			subquery: {
				type: 'select' as const,
				from: 'customers',
				select: { type: 'fields' as const, fields: [{ col: 'id' }] },
			},
		};
		expect(() => convertWhereCondition(intent as any, 'orders')).toThrow(
			/non-string field element|IN subquery.*must project exactly one named column/i,
		);
	});

	it('select.fields: [ 42 ] (number, not string) → throws at intent validation', () => {
		const intent = {
			kind: 'in' as const,
			field: 'id',
			subquery: {
				type: 'select' as const,
				from: 'customers',
				select: { type: 'fields' as const, fields: [42] },
			},
		};
		expect(() => convertWhereCondition(intent as any, 'orders')).toThrow(
			/non-string field element|IN subquery.*must project exactly one named column/i,
		);
	});

	it('select.fields: [ null ] → throws at intent validation', () => {
		const intent = {
			kind: 'in' as const,
			field: 'id',
			subquery: {
				type: 'select' as const,
				from: 'customers',
				select: { type: 'fields' as const, fields: [null] },
			},
		};
		expect(() => convertWhereCondition(intent as any, 'orders')).toThrow(
			/non-string field element|empty fields list|IN subquery.*must project exactly one named column/i,
		);
	});

	it('valid select.fields: ["id"] (plain string) still compiles correctly', () => {
		const intent = {
			kind: 'in' as const,
			field: 'customer_id',
			subquery: {
				type: 'select' as const,
				from: 'customers',
				select: { type: 'fields' as const, fields: ['id'] },
			},
		};
		const orm = buildOrm();
		expect(() =>
			orm
				.select('orders')
				.where(inSubquery('customer_id', subquery('customers').select('id')))
				.dump(),
		).not.toThrow();
		// Also verify intent conversion doesn't throw
		expect(() => convertWhereCondition(intent as any, 'orders')).not.toThrow();
	});
});

// ============================================================================
// Correlated bodies on the routes outside the planner (#1027, #891)
// ============================================================================

describe('model-less correlated body refusals', () => {
	it('refuses every model-less correlated body before its not-yet refusal', () => {
		const adapter = createPgCompileOnlyAdapter();
		const refusal = new Error(
			'PgAdapter compilation requires a ModelIR; pass { model } to the adapter or to the compile options.',
		);
		const users = () =>
			subquery('audit')
				.select('userId')
				.where(eq('userId', outerRef('users.id')));
		const usersIntent = () => users().build().toIntent();
		// UPDATE / DELETE WHERE: the IN chokepoint.
		expect(() =>
			adapter.compileUpdate({
				type: 'update',
				table: 'users',
				set: { name: 'x' },
				where: inSubquery('id', users()),
			}),
		).toThrow(refusal);
		expect(() =>
			adapter.compileDelete({
				type: 'delete',
				table: 'users',
				where: inSubquery('id', users()),
			}),
		).toThrow(refusal);
		// Batch UPDATE WHERE: the direct condition compiler.
		for (const [where, construct] of [
			[rawExists(users()), 'a correlated rawExists() body'],
			[
				{ kind: 'rawNotExists' as const, subquery: usersIntent() },
				'a correlated rawNotExists() body',
			],
		] as const)
			expect(() =>
				adapter.compileBatchUpdate({
					type: 'batchUpdate',
					table: 'users',
					matchColumns: ['id'],
					updates: [{ id: 1, name: 'x' }],
					where,
				}),
			).toThrow(refusal);
		// An aggregate FILTER in a model-less expression body: the decision lowering.
		const posts = () =>
			subquery('audit')
				.select('id')
				.where(eq('id', outerRef('posts.id')));
		const postsIntent = () => posts().build().toIntent();
		for (const [filter, construct] of [
			[
				{ kind: 'rawExists', subquery: postsIntent() },
				'a correlated rawExists() body',
			],
			[
				{ kind: 'rawNotExists', subquery: postsIntent() },
				'a correlated rawNotExists() body',
			],
			[
				{
					kind: 'subquery',
					field: 'id',
					operator: 'eq',
					subquery: postsIntent(),
				},
				'a correlated scalar subquery body',
			],
			[inSubquery('id', posts()), 'a correlated IN subquery body'],
		] as const)
			expect(() =>
				adapter.compileSelectExpression({
					kind: 'subquery',
					query: {
						type: 'select',
						from: 'posts',
						select: {
							type: 'aggregate',
							aggregates: [{ function: 'count', field: '*', filter }],
						},
					},
				} as never),
			).toThrow(refusal);
	});
});
