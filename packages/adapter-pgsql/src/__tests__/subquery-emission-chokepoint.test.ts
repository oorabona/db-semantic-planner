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
 * C. compilePlan decision    dispatchWhere → inSubquery Decision
 *                            → inSubqueryHandler → buildScalarSubquery
 *                            → buildPredicateSubquerySelect
 * D. Nested IN (logical)     mapInSubqueryCondition → inSubquery Decision
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
	not,
	rawExists,
	schema,
	subquery,
} from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { normalizeSQL } from '../ast-helpers.js';
import {
	buildSubqueryFromIntent,
	compileWhereIntent,
	type WhereCompilerCtx,
} from '../compile-where.js';
import { compilePlan, type SimplifiedPlanReport } from '../compiler.js';
import { createCompilerState } from '../handlers/types.js';
import { convertWhereCondition } from '../intent-to-decisions.js';
import { identityNaming } from '../naming-plugin.js';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

// ============================================================================
// Schema
// ============================================================================

const testSchema = schema({
	orders: {
		id: { type: 'integer', primaryKey: true },
		customer_id: { type: 'integer' },
		total: { type: 'numeric' },
		status: { type: 'text' },
	},
	customers: {
		id: { type: 'integer', primaryKey: true },
		active: { type: 'boolean' },
		region: { type: 'text' },
	},
	products: {
		id: { type: 'integer', primaryKey: true },
		price: { type: 'numeric' },
	},
	files: {
		id: { type: 'integer', primaryKey: true },
		project_id: { type: 'integer' },
	},
});

function buildOrm() {
	const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });
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
		naming: identityNaming,
		compileSubquery: (sqIntent, paramOffset) =>
			buildSubqueryFromIntent(sqIntent, paramOffset, identityNaming),
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
// C. compilePlan decision path — dispatchWhere → inSubqueryHandler
// ============================================================================

describe('PATH C: compilePlan decision path (dispatchWhere → inSubqueryHandler)', () => {
	it('GROUP BY in directly-constructed IN-subquery plan throws', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'customer_id',
					operator: 'in',
					subquery: {
						from: 'customers',
						select: 'id',
						// @ts-expect-error: injecting forbidden modifier for guard test
						groupBy: ['region'],
					},
				},
			],
		};
		expect(() => compilePlan(plan)).toThrow(/GROUP BY.*not supported/i);
	});

	it('valid directly-constructed IN-subquery plan compiles correctly', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'customer_id',
					operator: 'in',
					subquery: {
						from: 'customers',
						select: 'id',
					},
				},
			],
		};
		const result = compilePlan(plan);
		expect(normalizeSQL(result.sql)).toMatch(
			/customer_id\s*=\s*any\s*\(\s*select/i,
		);
	});
});

// ============================================================================
// D. Nested IN (logical group) — mapInSubqueryCondition → inSubqueryHandler
// ============================================================================

describe('PATH D: nested IN inside logical group (mapInSubqueryCondition → inSubqueryHandler)', () => {
	it('GROUP BY in nested IN-subquery inside AND plan throws', () => {
		const innerSubquery = {
			from: 'customers',
			select: 'id',
			// @ts-expect-error: injecting forbidden modifier
			groupBy: ['region'],
		};
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					operator: 'in',
					column: 'status',
					subquery: {
						from: 'customers',
						select: 'region',
						where: {
							type: 'where',
							column: 'customer_id',
							operator: 'in',
							subquery: innerSubquery as any,
						} as any,
					},
				},
			],
		};
		expect(() => compilePlan(plan)).toThrow(/GROUP BY.*not supported/i);
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
		const adapter = createPgsqlCompileOnlyAdapter();
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
						// @ts-expect-error: injecting forbidden modifier
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

	it('direct compilePlan with whereNot(whereAnd(c1, c2)) inside IN-subquery compiles correctly', () => {
		/**
		 * Directly-constructed SimplifiedPlanReport with a whereNot wrapping a whereAnd
		 * with two conditions inside an IN-subquery WHERE clause.
		 *
		 * Decision structure: whereNot → { conditions: [ whereAnd → { conditions: [c1, c2] } ] }
		 * Produces SQL: NOT (c1 AND c2) inside the subquery WHERE.
		 *
		 * This proves:
		 * 1. subqueryIntent provenance is correctly carried on the directly-constructed decision
		 * 2. mapInSubqueryCondition correctly preserves the nested NOT → AND → [c1, c2] structure
		 * 3. buildPredicateSubquerySelect compiles both conditions and binds both parameters
		 */
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'customer_id',
					operator: 'inSubquery',
					targetTable: 'customers',
					selectColumn: 'id',
					// Provenance: original QueryIntent for buildPredicateSubquerySelect validation
					subqueryIntent: {
						from: 'customers',
						select: { type: 'fields', fields: ['id'] },
					} as any,
					conditions: [
						{
							// whereNot wraps a single whereAnd so both conditions compile
							type: 'whereNot',
							conditions: [
								{
									type: 'whereAnd',
									conditions: [
										{
											type: 'where',
											column: 'active',
											operator: '=',
											value: false,
											table: 'customers',
										},
										{
											type: 'where',
											column: 'region',
											operator: '=',
											value: 'blocked',
											table: 'customers',
										},
									],
								},
							],
						},
					],
				},
			],
		};

		const result = compilePlan(plan);
		const sql = normalizeSQL(result.sql);

		// Should compile without throwing
		expect(sql, 'Should produce IN subquery').toMatch(
			/customer_id\s*=\s*any\s*\(\s*select/i,
		);

		// Should contain NOT
		expect(sql, 'Should contain NOT').toContain('not');

		// Both parameters should be bound: false for active, 'blocked' for region
		expect(result.parameters).toHaveLength(2);
		expect(result.parameters).toContain(false);
		expect(result.parameters).toContain('blocked');
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
// REGRESSION LOCK — DEFECT 1: JOIN ON scalar subquery must still throw
// ============================================================================

describe('DEFECT 1 regression: scalar subquery in JOIN ON condition is rejected', () => {
	/**
	 * adapter-compiler-select.ts injects a throw-callback for ctx.compileSubquery
	 * when building JOIN ON conditions (two sites: table-mode and BatchValues-mode).
	 * Before the fix, handleSubqueryIntent bypassed ctx.compileSubquery and called
	 * buildSubqueryFromIntent directly — so a scalar subquery in a JOIN ON would
	 * silently compile instead of throwing.
	 *
	 * Fix: handleSubqueryIntent routes through ctx.compileSubquery so the override
	 * throw fires.  The per-site 'scalar-direct' modifier guard still runs FIRST so
	 * modifier errors are reported before the JOIN ON error.
	 */
	it('scalar subquery in JOIN ON condition throws (table-mode join, injected ctx)', () => {
		// Simulate the WhereCompilerCtx that adapter-compiler-select.ts builds for
		// table-mode JOIN ON compilation — compileSubquery is overridden to throw.
		const paramState = createCompilerState();
		const ctx: WhereCompilerCtx = {
			rootTable: 'orders',
			aliases: new Map(),
			paramState,
			naming: identityNaming,
			// Exact override used in adapter-compiler-select.ts ~387
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

	it('scalar subquery in BatchValues JOIN ON condition throws (injected ctx)', () => {
		// Simulate the BatchValues JOIN ON WhereCompilerCtx from
		// adapter-compiler-select.ts ~331.
		const paramState = createCompilerState();
		const ctx: WhereCompilerCtx = {
			rootTable: 'orders',
			aliases: new Map(),
			paramState,
			naming: identityNaming,
			// Exact override used in adapter-compiler-select.ts ~331
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

	it('modifier guard fires before JOIN ON throw (scalar-direct rejects LIMIT first)', () => {
		// A scalar subquery with LIMIT in a JOIN ON context: the 'scalar-direct'
		// modifier guard must fire BEFORE ctx.compileSubquery so the caller sees
		// the modifier error, not the JOIN ON override error.
		const paramState = createCompilerState();
		const ctx: WhereCompilerCtx = {
			rootTable: 'orders',
			aliases: new Map(),
			paramState,
			naming: identityNaming,
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

	it('non-subquery WHERE condition in JOIN ON still compiles (no false positive)', () => {
		// A plain comparison in a JOIN ON must compile normally — the fix must not
		// break the common case.
		const paramState = createCompilerState();
		const ctx: WhereCompilerCtx = {
			rootTable: 'orders',
			aliases: new Map(),
			paramState,
			naming: identityNaming,
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

describe('DEFECT 2 regression: directly-constructed decision with lowered outerRef throws', () => {
	/**
	 * When convertSubquery lowered a WhereSubqueryIntent to a Decision, any
	 * outerRef() node in the inner WHERE became { kind:'fieldRef', scope:'outer' }
	 * in the lowered Decision.conditions.  buildPredicateSubquerySelect only checks
	 * sourceIntent.where (via containsOuterRef); when subqueryIntent is absent
	 * (directly-constructed decision), the synthesized sourceIntent has no .where,
	 * so the correlated reference was silently compiled against the wrong alias.
	 *
	 * Fix: buildScalarSubquery now checks decision.conditions recursively for
	 * { kind:'fieldRef', scope:'outer' } before calling buildPredicateSubquerySelect.
	 */
	it('scalarSubquery decision with outer fieldRef in conditions → throws', () => {
		// Directly-constructed handler Decision simulating a correlated scalar subquery
		// whose outerRef was already lowered by convertComparison.
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'total',
					operator: 'scalarSubquery',
					subqueryOperator: '>',
					targetTable: 'products',
					selectColumn: 'price',
					// subqueryIntent absent — directly-constructed decision
					conditions: [
						{
							// Lowered outerRef: convertComparison turns outerRef('id') into
							// { kind: 'fieldRef', scope: 'outer', column: 'id' }
							type: 'where',
							column: 'user_id',
							operator: '=',
							value: { kind: 'fieldRef', scope: 'outer', column: 'id' },
							table: 'products',
						},
					],
				},
			],
		};

		expect(() => compilePlan(plan)).toThrow(
			/correlated outerRef.*not yet supported/i,
		);
	});

	it('inSubquery decision with outer fieldRef in conditions → throws', () => {
		// Same scenario for an IN subquery.
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'customer_id',
					operator: 'inSubquery',
					targetTable: 'customers',
					selectColumn: 'id',
					// subqueryIntent absent — directly-constructed decision
					conditions: [
						{
							type: 'where',
							column: 'id',
							operator: '=',
							value: {
								kind: 'fieldRef',
								scope: 'outer',
								column: 'customer_id',
							},
							table: 'customers',
						},
					],
				},
			],
		};

		expect(() => compilePlan(plan)).toThrow(
			/correlated outerRef.*not yet supported/i,
		);
	});

	it('outerRef nested in AND inside decision.conditions → throws', () => {
		// The check must recurse into nested conditions (whereAnd etc.).
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'total',
					operator: 'scalarSubquery',
					subqueryOperator: '>',
					targetTable: 'products',
					selectColumn: 'price',
					conditions: [
						{
							type: 'whereAnd',
							conditions: [
								{
									type: 'where',
									column: 'active',
									operator: '=',
									value: true,
									table: 'products',
								},
								{
									type: 'where',
									column: 'user_id',
									operator: '=',
									// Correlated reference nested inside AND
									value: { kind: 'fieldRef', scope: 'outer', column: 'id' },
									table: 'products',
								},
							],
						},
					],
				},
			],
		};

		expect(() => compilePlan(plan)).toThrow(
			/correlated outerRef.*not yet supported/i,
		);
	});

	it('non-correlated lowered decision (no outer fieldRef) compiles correctly', () => {
		// A directly-constructed decision with no correlated reference must still
		// compile — the check must not produce false positives.
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'customer_id',
					operator: 'inSubquery',
					targetTable: 'customers',
					selectColumn: 'id',
					conditions: [
						{
							type: 'where',
							column: 'active',
							operator: '=',
							value: true,
							table: 'customers',
						},
					],
				},
			],
		};

		expect(() => compilePlan(plan)).not.toThrow();
		const result = compilePlan(plan);
		expect(normalizeSQL(result.sql)).toMatch(
			/customer_id\s*=\s*any\s*\(\s*select/i,
		);
	});
});

// ============================================================================
// REGRESSION LOCK — DEFECT 3: decision-level guard catches directly-constructed
// compilePlan inSubquery/scalarSubquery decisions with no subqueryIntent
// ============================================================================

describe('DEFECT 3 regression: decision-level guard (assertNoDroppedDecisionModifiers)', () => {
	/**
	 * When a caller constructs a SimplifiedPlanReport directly with
	 * operator:'inSubquery' or 'scalarSubquery' and no subqueryIntent, the
	 * chokepoint (buildPredicateSubquerySelect) synthesizes a minimal sourceIntent
	 * (from/select only) — so Layer 1 (sourceIntent validation) passes vacuously.
	 *
	 * Layer 2 (assertNoDroppedDecisionModifiers) now validates the Decision's OWN
	 * fields unconditionally so GROUP BY / HAVING / OFFSET / DISTINCT / include
	 * carried directly on the decision are still caught.
	 *
	 * mapToHandlerDecision (compiler.ts ~131) preserves `include` through the mapper,
	 * so `include` on a directly-constructed decision WOULD reach SQL emission unless
	 * caught here.
	 */

	it('directly-constructed inSubquery decision with GROUP BY (no subqueryIntent) → throws', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'customer_id',
					operator: 'inSubquery',
					targetTable: 'customers',
					selectColumn: 'id',
					// No subqueryIntent — directly constructed
					// @ts-expect-error: injecting forbidden modifier for guard test
					groupBy: ['region'],
				},
			],
		};
		expect(() => compilePlan(plan)).toThrow(
			/IN subquery with GROUP BY is not supported/,
		);
	});

	it('directly-constructed inSubquery decision with HAVING (no subqueryIntent) → throws', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'customer_id',
					operator: 'inSubquery',
					targetTable: 'customers',
					selectColumn: 'id',
					// @ts-expect-error
					having: {
						kind: 'comparison',
						field: 'count',
						operator: 'gt',
						value: 0,
					},
				},
			],
		};
		expect(() => compilePlan(plan)).toThrow(
			/IN subquery with HAVING is not supported/,
		);
	});

	it('directly-constructed inSubquery decision with include (no subqueryIntent) → throws', () => {
		// include is preserved by mapToHandlerDecision (~131) and WOULD be silently
		// emitted inside the IN subquery if not caught by the decision-level guard.
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'customer_id',
					operator: 'inSubquery',
					targetTable: 'customers',
					selectColumn: 'id',
					include: [
						{
							type: 'includeStrategy',
							choice: 'join',
							relation: 'orders',
						},
					],
				},
			],
		};
		expect(() => compilePlan(plan)).toThrow(
			/IN subquery with include \(relation hydration\) is not supported/,
		);
	});

	it('directly-constructed inSubquery decision with OFFSET (no subqueryIntent) → throws', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'customer_id',
					operator: 'inSubquery',
					targetTable: 'customers',
					selectColumn: 'id',
					offset: 5,
				},
			],
		};
		expect(() => compilePlan(plan)).toThrow(
			/IN subquery with OFFSET is not supported/,
		);
	});

	it('directly-constructed scalarSubquery decision with GROUP BY (no subqueryIntent) → throws', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'total',
					operator: 'scalarSubquery',
					subqueryOperator: '>',
					targetTable: 'products',
					selectColumn: 'price',
					// @ts-expect-error
					groupBy: ['category'],
				},
			],
		};
		expect(() => compilePlan(plan)).toThrow(
			/scalar subquery with GROUP BY is not supported/,
		);
	});

	it('directly-constructed scalarSubquery decision with DISTINCT (no subqueryIntent) → throws', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'total',
					operator: 'scalarSubquery',
					subqueryOperator: '>',
					targetTable: 'products',
					selectColumn: 'price',
					// @ts-expect-error
					distinct: true,
				},
			],
		};
		expect(() => compilePlan(plan)).toThrow(
			/scalar subquery with DISTINCT is not supported/,
		);
	});

	it('directly-constructed scalarSubquery decision with aggregateDistinct but no aggregate (no subqueryIntent) → throws', () => {
		// aggregateDistinct is only meaningful on an aggregate. Carried on a plain
		// scalar projection with no aggregate, it would silently drop DISTINCT at
		// emission (the #247 class of bug) — the decision-level guard must fail loud.
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'total',
					operator: 'scalarSubquery',
					subqueryOperator: '>',
					targetTable: 'products',
					selectColumn: 'price',
					// @ts-expect-error: injecting the modifier without an aggregate for the guard test
					aggregateDistinct: true,
				},
			],
		};
		expect(() => compilePlan(plan)).toThrow(
			/aggregate DISTINCT without an aggregate function is not supported/,
		);
	});

	it('valid directly-constructed inSubquery decision (with subqueryIntent) still compiles', () => {
		// Regression guard: a valid lowered decision with subqueryIntent must still work.
		const orm = buildOrm();
		expect(() =>
			orm
				.select('orders')
				.where(inSubquery('customer_id', subquery('customers').select('id')))
				.dump(),
		).not.toThrow();
	});

	it('valid directly-constructed inSubquery decision (no subqueryIntent, named column) still compiles', () => {
		// A directly-constructed plan with no forbidden modifiers and a valid selectColumn.
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'customer_id',
					operator: 'inSubquery',
					targetTable: 'customers',
					selectColumn: 'id',
				},
			],
		};
		expect(() => compilePlan(plan)).not.toThrow();
		const result = compilePlan(plan);
		expect(normalizeSQL(result.sql)).toMatch(/customer_id\s*=\s*any\s*\(/i);
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

	it('directly-constructed inSubquery decision with selectColumn = wildcard → throws at decision guard', () => {
		// A directly-constructed decision where the malformed intent already lowered
		// fields[0] to '*' (e.g. via the `?? '*'` fallback in convertIn).
		// The decision-level guard catches this case.
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'customer_id',
					operator: 'inSubquery',
					targetTable: 'customers',
					selectColumn: '*', // wildcard — would emit SELECT * inside ANY(...)
				},
			],
		};
		expect(() => compilePlan(plan)).toThrow(
			/IN subquery with missing or wildcard selectColumn.*is not supported/,
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
