/**
 * Regression tests: IN→EXISTS optimization must produce consistent plan/SQL output.
 *
 * Correct design (FIND-130):
 *   - plan.intent  = the ORIGINAL submitted intent (kind='in') — observable via dump()
 *   - plan.executableIntent = the OPTIMIZED form (kind='exists') — what the adapter compiles
 *   - plan.decisions records an EXISTS filter-strategy (built from the optimized WHERE)
 *   - compiled SQL uses EXISTS — matching plan.decisions and plan.executableIntent
 *
 * This file pins the corrected three-way consistency: intent shows what the user wrote,
 * executableIntent carries the rewritten form, and SQL agrees with both decisions and executableIntent.
 */

import {
	and,
	eq,
	inSubquery,
	not,
	POSTGRESQL_CAPABILITIES,
	plan,
	type QueryIntent,
	ref,
	schema,
	subquery,
} from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { normalizeSQL } from '../ast-helpers.js';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Schema: products --(hasMany productImages via productId FK)
// ---------------------------------------------------------------------------
const testSchema = schema({
	products: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
	},
	productImages: {
		id: { type: 'integer', primaryKey: true },
		productId: ref('products', {
			as: 'product',
			inverse: 'images',
		}),
		approved: 'boolean',
	},
});

// Schema for NOT IN tests (nullable vs non-nullable FK)
const schemaWithNullableFK = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		authorId: ref('users', {
			as: 'author',
			inverse: 'posts',
			nullable: true,
		}),
		title: 'string',
	},
});

const schemaWithNonNullableFK = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
	},
	posts_nn: {
		id: { type: 'integer', primaryKey: true },
		authorId: ref('users', {
			as: 'author',
			inverse: 'posts_nn',
			// nullable omitted → defaults to false (NOT NULL)
		}),
		title: 'string',
	},
});

// ---------------------------------------------------------------------------
// Helper
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
// Suite: positive IN → EXISTS (plan/SQL agreement)
// ---------------------------------------------------------------------------
describe('IN→EXISTS: plan and SQL both use EXISTS for optimizable IN subquery', () => {
	it('compiled SQL uses EXISTS, not IN, for hasMany IN-subquery', () => {
		// Regression gate (issue #130 item 1): before the fix, SQL contained
		// IN (SELECT ...) even though plan.decisions claimed EXISTS.
		const intent: QueryIntent = {
			type: 'select',
			from: 'products',
			where: {
				kind: 'in',
				field: 'id',
				values: [],
				subquery: {
					type: 'select',
					from: 'productImages',
					select: { type: 'fields', fields: ['productId'] },
					where: {
						kind: 'comparison',
						field: 'approved',
						operator: 'eq',
						value: true,
					},
				},
			},
		};

		const planReport = plan(intent, testSchema.model, {
			dialectCapabilities: POSTGRESQL_CAPABILITIES,
		});

		// plan.decisions must claim EXISTS
		const filterDecision = planReport.decisions.find(
			(d) => d.type === 'filter-strategy',
		);
		expect(filterDecision?.choice).toBe('exists');

		// plan.intent.where must stay kind='in' — the original submitted intent is preserved
		expect(planReport.intent.where?.kind).toBe('in');
		// plan.executableIntent.where must be kind='exists' — the optimized form the adapter compiles
		expect(planReport.executableIntent).toBeDefined();
		expect(planReport.executableIntent?.where?.kind).toBe('exists');

		// SQL must use EXISTS, not IN (...) — normalizeSQL lowercases, so match lowercase
		const { sql } = compileIntent(intent, testSchema.model);
		expect(sql).toContain('exists');
		expect(sql).not.toContain('= any (select');
		// SQL must contain exactly one EXISTS clause (no duplication)
		const existsCount = (sql.match(/\bexists\b/g) ?? []).length;
		expect(existsCount).toBe(1);
	});

	it('SQL parameter is the approved=true value, not a duplicate', () => {
		// Regression gate: before the fix, the adapter emitted both IN and EXISTS
		// WHERE clauses, which would double-bind parameters. After the fix, only
		// the EXISTS path is compiled → one param binding for approved=true.
		const intent = inSubquery(
			'id',
			subquery('productImages').select('productId').where({
				kind: 'comparison',
				field: 'approved',
				operator: 'eq',
				value: true,
			}),
		);

		const queryIntent: QueryIntent = {
			type: 'select',
			from: 'products',
			where: intent,
		};

		const { params } = compileIntent(queryIntent, testSchema.model);
		// Only one parameter for the approved=true condition
		expect(params).toHaveLength(1);
		expect(params[0]).toBe(true);
	});

	it('IN within AND conditions: SQL uses EXISTS for the IN branch', () => {
		const queryIntent: QueryIntent = {
			type: 'select',
			from: 'products',
			where: {
				kind: 'and',
				conditions: [
					{
						kind: 'comparison',
						field: 'name',
						operator: 'eq',
						value: 'Widget',
					},
					{
						kind: 'in',
						field: 'id',
						values: [],
						subquery: {
							type: 'select',
							from: 'productImages',
							select: { type: 'fields', fields: ['productId'] },
							where: {
								kind: 'comparison',
								field: 'approved',
								operator: 'eq',
								value: true,
							},
						},
					},
				],
			},
		};

		const { sql } = compileIntent(queryIntent, testSchema.model);
		// normalizeSQL lowercases output
		expect(sql).toContain('exists');
		expect(sql).not.toContain('= any (select');
	});
});

// ---------------------------------------------------------------------------
// Suite: NOT IN → NOT EXISTS (non-nullable FK only)
// ---------------------------------------------------------------------------
describe('NOT IN→NOT EXISTS: SQL uses NOT EXISTS for non-nullable FK', () => {
	it('compiled SQL uses NOT EXISTS for NOT IN on non-nullable FK', () => {
		const queryIntent: QueryIntent = {
			type: 'select',
			from: 'users',
			where: not(inSubquery('id', subquery('posts_nn').select('authorId'))),
		};

		const planReport = plan(queryIntent, schemaWithNonNullableFK.model, {
			dialectCapabilities: POSTGRESQL_CAPABILITIES,
		});

		// plan must claim a filter-strategy (notExists rewrite applied)
		const filterDecision = planReport.decisions.find(
			(d) => d.type === 'filter-strategy',
		);
		expect(filterDecision).toBeDefined();

		// plan.intent.where must stay kind='not' — the original submitted intent is preserved
		expect(planReport.intent.where?.kind).toBe('not');
		// plan.executableIntent.where must be kind='not' wrapping kind='exists'.
		// The corrected design preserves the outer 'not' structure; the inner 'in'
		// leaf (not-flag=false) rewrites to 'exists'.  The adapter compiles
		// not(exists) as NOT EXISTS(...) — semantically equivalent and correct.
		expect(planReport.executableIntent).toBeDefined();
		const execWhere = planReport.executableIntent?.where as {
			kind: string;
			condition?: { kind: string };
		};
		expect(execWhere?.kind).toBe('not');
		expect(execWhere?.condition?.kind).toBe('exists');

		const { sql } = compileIntent(queryIntent, schemaWithNonNullableFK.model);
		// normalizeSQL lowercases output; adapter emits NOT (EXISTS (...))
		expect(sql).toContain('exists');
		expect(sql).toContain('not');
		expect(sql).not.toContain('= any');
		// The inner child is POSITIVE EXISTS (in-intent not-flag=false, form='exists').
		// The outer NOT wraps it: NOT(EXISTS(...)).  Assert no double-negation.
		expect(sql).not.toMatch(/not\s*\(\s*not/i);
	});
});

// ---------------------------------------------------------------------------
// Suite: NOT IN preserved on nullable FK (three-valued-logic guard)
// ---------------------------------------------------------------------------
describe('NOT IN preserved: SQL keeps NOT IN when FK is nullable', () => {
	it('compiled SQL keeps NOT IN when nullable FK blocks NOT EXISTS rewrite', () => {
		// The nullable FK guard in optimizeInToExists must prevent rewriting
		// NOT IN → NOT EXISTS to avoid SQL three-valued-logic differences.
		const queryIntent: QueryIntent = {
			type: 'select',
			from: 'users',
			where: not(inSubquery('id', subquery('posts').select('authorId'))),
		};

		const planReport = plan(queryIntent, schemaWithNullableFK.model, {
			dialectCapabilities: POSTGRESQL_CAPABILITIES,
		});

		// plan must NOT have a filter-strategy (NOT IN preserved, not rewritten)
		const filterDecision = planReport.decisions.find(
			(d) => d.type === 'filter-strategy',
		);
		expect(filterDecision).toBeUndefined();

		// plan.intent must be unchanged (same object as input intent)
		expect(planReport.intent).toBe(queryIntent);

		// normalizeSQL lowercases output; optimization was blocked → no EXISTS in SQL
		const { sql } = compileIntent(queryIntent, schemaWithNullableFK.model);
		expect(sql).not.toContain('exists');
	});
});

// ---------------------------------------------------------------------------
// Suite: non-simple subquery guards (SQL-level verification)
// ---------------------------------------------------------------------------
describe('Non-simple subquery: compilation throws for modifiers that would be silently dropped', () => {
	it('IN with groupBy/having subquery: planner succeeds, compilation throws (filter-broadening guard)', () => {
		// Issue #130: before the guard, GROUP BY / HAVING were silently dropped from
		// the compiled SQL, broadening the filter to match more rows. The fix throws
		// a clear error so callers restructure the query (e.g. use a CTE) rather
		// than get a semantically-wrong result.
		const queryIntent: QueryIntent = {
			type: 'select',
			from: 'products',
			where: {
				kind: 'in',
				field: 'id',
				values: [],
				subquery: {
					type: 'select',
					from: 'productImages',
					select: { type: 'fields', fields: ['productId'] },
					groupBy: ['productId'],
					having: {
						kind: 'comparison',
						field: 'count',
						operator: 'gt',
						value: 1,
					},
				},
			},
		};

		const planReport = plan(queryIntent, testSchema.model, {
			dialectCapabilities: POSTGRESQL_CAPABILITIES,
		});

		// Planner still succeeds: no filter-strategy optimization is attempted
		// (the modifier check is in the adapter compilation layer, not the planner).
		const filterDecision = planReport.decisions.find(
			(d) => d.type === 'filter-strategy',
		);
		expect(filterDecision).toBeUndefined();

		// plan.intent unchanged
		expect(planReport.intent).toBe(queryIntent);

		// Compilation must throw — GROUP BY / HAVING would otherwise be silently dropped.
		expect(() => compileIntent(queryIntent, testSchema.model)).toThrow(
			/IN subquery with GROUP BY, HAVING is not supported/,
		);
		expect(() => compileIntent(queryIntent, testSchema.model)).toThrow(
			/restructure the query or use a CTE/,
		);
	});

	it('IN with offset subquery: compilation throws (filter-broadening guard)', () => {
		// Issue #130: OFFSET was silently dropped, returning the wrong rows.
		const queryIntent: QueryIntent = {
			type: 'select',
			from: 'products',
			where: {
				kind: 'in',
				field: 'id',
				values: [],
				subquery: {
					type: 'select',
					from: 'productImages',
					select: { type: 'fields', fields: ['productId'] },
					offset: 10,
				},
			},
		};

		expect(() => compileIntent(queryIntent, testSchema.model)).toThrow(
			/IN subquery with OFFSET is not supported/,
		);
	});
});

// ---------------------------------------------------------------------------
// Suite: IN→EXISTS inside OR — EXISTS compiled inline, OR semantics preserved
// ---------------------------------------------------------------------------
// Note: schemaWithNonNullableFK is declared at module scope above (line ~63)

describe('IN→EXISTS inside OR: EXISTS compiled inline, OR semantics preserved', () => {
	it('or(eq(...), inSubquery(...)): SQL is OR-combined with EXISTS and FK correlation', () => {
		// The optimizer recurses into OR branches; the adapter compiles EXISTS inline
		// at its boolean tree position so the result is name=$1 OR EXISTS(...),
		// not name=$1 AND EXISTS(...).
		// Also verifies: FK correlation is present and inner WHERE is preserved.
		const queryIntent: QueryIntent = {
			type: 'select',
			from: 'products',
			where: {
				kind: 'or',
				conditions: [
					{
						kind: 'comparison',
						field: 'name',
						operator: 'eq',
						value: 'Widget',
					},
					{
						kind: 'in',
						field: 'id',
						values: [],
						subquery: {
							type: 'select',
							from: 'productImages',
							select: { type: 'fields', fields: ['productId'] },
							where: {
								kind: 'comparison',
								field: 'approved',
								operator: 'eq',
								value: true,
							},
						},
					},
				],
			},
		};

		const planReport = plan(queryIntent, testSchema.model, {
			dialectCapabilities: POSTGRESQL_CAPABILITIES,
		});

		// Filter-strategy decision is emitted (IN inside OR is now optimized)
		const filterDecision = planReport.decisions.find(
			(d) => d.type === 'filter-strategy',
		);
		expect(filterDecision?.choice).toBe('exists');

		// plan.intent stays the original
		expect(planReport.intent).toBe(queryIntent);

		// executableIntent carries the optimized OR (exists inside)
		expect(planReport.executableIntent?.where?.kind).toBe('or');
		const orWhere = planReport.executableIntent?.where as {
			kind: 'or';
			conditions: { kind: string }[];
		};
		expect(orWhere.conditions[1]?.kind).toBe('exists');

		// SQL: exists is OR-combined, not AND-combined
		// normalizeSQL lowercases output
		const { sql, params } = compileIntent(queryIntent, testSchema.model);

		expect(sql).toContain('or');
		expect(sql).toContain('exists');

		// EXISTS must be OR-combined — must NOT be an AND at the top WHERE level
		expect(sql).not.toMatch(/where .+ and exists/i);

		// Positive EXISTS — in-intent has no not-flag, OR context is non-negated
		expect(sql).not.toMatch(/not\s+exists/i);

		// FK correlation must be present: products.id = alias."productId"
		expect(sql).toContain('"productid"');

		// Inner WHERE condition (approved) must be in SQL (not dropped)
		expect(sql).toContain('approved');

		// Both parameters: $1=Widget, $2=true
		expect(params).toHaveLength(2);
		expect(params[0]).toBe('Widget');
		expect(params[1]).toBe(true);
	});
});

describe('NOT(AND(inSubquery, eq)): EXISTS compiled inline inside NOT/AND', () => {
	it('not(and(inSubquery, eq)): SQL is NOT(EXISTS(...) AND name=$N)', () => {
		// When NOT wraps an AND containing an IN-subquery, the IN is rewritten to
		// EXISTS inside the AND, which stays inside the NOT.
		// The adapter compiles it as NOT (EXISTS(...) AND name=$N).
		const queryIntent: QueryIntent = {
			type: 'select',
			from: 'products',
			where: {
				kind: 'not',
				condition: {
					kind: 'and',
					conditions: [
						{
							kind: 'in',
							field: 'id',
							values: [],
							subquery: {
								type: 'select',
								from: 'productImages',
								select: { type: 'fields', fields: ['productId'] },
								where: {
									kind: 'comparison',
									field: 'approved',
									operator: 'eq',
									value: true,
								},
							},
						},
						{ kind: 'comparison', field: 'name', operator: 'eq', value: 'W' },
					],
				},
			},
		};

		const planReport = plan(queryIntent, testSchema.model, {
			dialectCapabilities: POSTGRESQL_CAPABILITIES,
		});

		// Filter-strategy decision is emitted (IN inside NOT/AND is optimized)
		const filterDecision = planReport.decisions.find(
			(d) => d.type === 'filter-strategy',
		);
		expect(filterDecision?.choice).toBe('exists');

		// SQL: NOT (EXISTS(...) AND name=$N)
		const { sql, params } = compileIntent(queryIntent, testSchema.model);

		// normalizeSQL lowercases
		expect(sql).toContain('not');
		expect(sql).toContain('exists');

		// EXISTS must be inside the NOT, not appended as top-level AND after the NOT
		expect(sql).toMatch(/not\s*\(/i);

		// The inner EXISTS must be POSITIVE — the 'in' leaf (not-flag=false) rewrites to
		// 'exists', and the outer NOT is preserved by the recursion.  The SQL is
		// NOT(EXISTS(...) AND name=$N).  Verify no double-negation: no inner NOT EXISTS
		// inside the outer NOT wrapper.
		expect(sql).not.toMatch(/not\s+exists/i);
		// No pattern: NOT (NOT ... EXISTS ...): outer NOT followed by another NOT before EXISTS
		expect(sql).not.toMatch(/not\s*\(\s*not/i);

		// FK correlation and inner WHERE are present
		expect(sql).toContain('"productid"');
		expect(sql).toContain('approved');

		// name condition is also inside the NOT
		expect(sql).toContain('name');

		// params: $1=true (approved), $2='W' (name)
		expect(params).toHaveLength(2);
		expect(params[0]).toBe(true);
		expect(params[1]).toBe('W');
	});
});

describe('NOT IN under OR (non-nullable FK): NOT EXISTS inline under OR', () => {
	it('or(eq, not(inSubquery)) on non-nullable FK: SQL is name=$1 OR NOT EXISTS(...)', () => {
		// A NOT IN under OR on a non-nullable FK becomes NOT EXISTS inline under OR,
		// not hoisted to a top-level AND.
		const queryIntent: QueryIntent = {
			type: 'select',
			from: 'users',
			where: {
				kind: 'or',
				conditions: [
					{ kind: 'comparison', field: 'name', operator: 'eq', value: 'Alice' },
					{
						kind: 'not',
						condition: {
							kind: 'in',
							field: 'id',
							values: [],
							subquery: {
								type: 'select',
								from: 'posts_nn',
								select: { type: 'fields', fields: ['authorId'] },
							},
						},
					},
				],
			},
		};

		const planReport = plan(queryIntent, schemaWithNonNullableFK.model, {
			dialectCapabilities: POSTGRESQL_CAPABILITIES,
		});

		// Filter-strategy decision is emitted
		const filterDecision = planReport.decisions.find(
			(d) => d.type === 'filter-strategy',
		);
		expect(filterDecision).toBeDefined();

		// SQL: name=$1 OR NOT EXISTS(...)
		const { sql, params } = compileIntent(
			queryIntent,
			schemaWithNonNullableFK.model,
		);

		expect(sql).toContain('or');
		expect(sql).toContain('not');
		expect(sql).toContain('exists');

		// NOT EXISTS must be OR-combined — verify no top-level AND NOT EXISTS
		expect(sql).not.toMatch(/where .+ and not .+exists/i);

		// FK correlation present
		expect(sql).toContain('"authorid"');

		// Only the name param
		expect(params).toHaveLength(1);
		expect(params[0]).toBe('Alice');
	});
});

describe('simple top-level IN→EXISTS still works (non-regression)', () => {
	it('simple inSubquery at top level still compiles to EXISTS', () => {
		const queryIntent: QueryIntent = {
			type: 'select',
			from: 'products',
			where: {
				kind: 'in',
				field: 'id',
				values: [],
				subquery: {
					type: 'select',
					from: 'productImages',
					select: { type: 'fields', fields: ['productId'] },
					where: {
						kind: 'comparison',
						field: 'approved',
						operator: 'eq',
						value: true,
					},
				},
			},
		};

		const { sql, params } = compileIntent(queryIntent, testSchema.model);

		expect(sql).toContain('exists');
		// Positive EXISTS must NOT be negated — the in-intent has no not-flag
		expect(sql).not.toMatch(/not\s+exists/i);
		expect(sql).not.toContain('= any (select');
		expect(sql).toContain('"productid"');
		expect(sql).toContain('approved');
		expect(params).toHaveLength(1);
		expect(params[0]).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Defect 1 regression tests: NULL-safety under nested negation (Issue #130-H)
//
// SQL three-valued logic: `x NOT IN (SELECT y ...)` is UNKNOWN (row excluded)
// when y can be NULL.  `NOT EXISTS` is always two-valued, so the rewrite
// broadens the filter for nullable FKs.  A positive IN inside a negated
// context (e.g. not(and(inSubquery(...), eq(...)))) must NOT be rewritten to
// EXISTS when the FK is nullable.
// ---------------------------------------------------------------------------

describe('NULL-safety under negation: not(and(inSubquery(nullable FK), eq)) keeps IN', () => {
	it('not(and(inSubquery(nullable FK), eq)) SQL keeps = ANY (not EXISTS)', () => {
		// nullable FK: posts.authorId is nullable → rewrite is unsafe under negation
		const queryIntent: QueryIntent = {
			type: 'select',
			from: 'users',
			where: not(
				and(
					inSubquery('id', subquery('posts').select('authorId')),
					eq('name', 'Alice'),
				),
			),
		};

		const planReport = plan(queryIntent, schemaWithNullableFK.model, {
			dialectCapabilities: POSTGRESQL_CAPABILITIES,
		});

		// Planner must NOT emit a filter-strategy (nullable IN under negation is kept as-is)
		const filterDecision = planReport.decisions.find(
			(d) => d.type === 'filter-strategy',
		);
		expect(filterDecision).toBeUndefined();

		const { sql, params } = compileIntent(
			queryIntent,
			schemaWithNullableFK.model,
		);

		// SQL must NOT contain EXISTS — the IN must be preserved as = ANY
		expect(sql).not.toContain('exists');
		expect(sql).toContain('= any');
		// name condition also present
		expect(sql).toContain('name');
		// params: $1='Alice'
		expect(params).toHaveLength(1);
		expect(params[0]).toBe('Alice');
	});
});

describe('NULL-safety under negation: not(and(inSubquery(non-nullable FK), eq)) rewrites', () => {
	it('not(and(inSubquery(non-nullable FK), eq)) SQL uses NOT(EXISTS(...) AND name=$N)', () => {
		// non-nullable FK: posts_nn.authorId is NOT NULL → rewrite is safe
		const queryIntent: QueryIntent = {
			type: 'select',
			from: 'users',
			where: not(
				and(
					inSubquery('id', subquery('posts_nn').select('authorId')),
					eq('name', 'Bob'),
				),
			),
		};

		const planReport = plan(queryIntent, schemaWithNonNullableFK.model, {
			dialectCapabilities: POSTGRESQL_CAPABILITIES,
		});

		// Planner emits filter-strategy (safe to rewrite)
		const filterDecision = planReport.decisions.find(
			(d) => d.type === 'filter-strategy',
		);
		expect(filterDecision?.choice).toBe('exists');

		const { sql, params } = compileIntent(
			queryIntent,
			schemaWithNonNullableFK.model,
		);

		// SQL uses NOT(EXISTS(...) AND ...) — EXISTS is inside the NOT
		expect(sql).toContain('not');
		expect(sql).toContain('exists');
		expect(sql).not.toContain('= any');
		// The inner EXISTS must be POSITIVE (not-flag=false → form='exists').
		// Verifies no double-negation: inner NOT EXISTS would be wrong here.
		expect(sql).not.toMatch(/not\s+exists/i);
		// FK correlation present
		expect(sql).toContain('"authorid"');
		// name condition inside the NOT
		expect(sql).toContain('name');
		expect(params).toHaveLength(1);
		expect(params[0]).toBe('Bob');
	});
});

describe('NULL-safety: positive inSubquery on nullable FK still rewrites to EXISTS', () => {
	it('positive inSubquery (non-negated) on nullable FK still compiles to EXISTS', () => {
		// Positive context is null-safe: IN → EXISTS does not change semantics
		// (EXISTS is true whenever a matching row exists, same as IN ignoring NULL values)
		const queryIntent: QueryIntent = {
			type: 'select',
			from: 'users',
			where: inSubquery('id', subquery('posts').select('authorId')),
		};

		const planReport = plan(queryIntent, schemaWithNullableFK.model, {
			dialectCapabilities: POSTGRESQL_CAPABILITIES,
		});

		// Planner emits a filter-strategy — positive IN is rewritten to EXISTS
		const filterDecision = planReport.decisions.find(
			(d) => d.type === 'filter-strategy',
		);
		expect(filterDecision?.choice).toBe('exists');

		const { sql } = compileIntent(queryIntent, schemaWithNullableFK.model);
		expect(sql).toContain('exists');
		// Positive EXISTS — in-intent has no not-flag, no outer not wrapper
		expect(sql).not.toMatch(/not\s+exists/i);
		expect(sql).not.toContain('= any');
	});
});

// ---------------------------------------------------------------------------
// Suite: FIX 2 — enrichExistsDecisionsInPlace uses constructor model fallback
// ---------------------------------------------------------------------------
describe('enrichExistsDecisionsInPlace: constructor model used when compile options omit model', () => {
	// Schema: posts --(belongsTo users via authorId)
	// When the adapter is created with { model } at construction time and
	// compile(plan) is called WITHOUT { model } in compile options, the EXISTS
	// subquery must still resolve the belongsTo FK direction correctly:
	//   outer.author_id = inner.id   (belongsTo: FK on the outer posts table)
	// NOT:
	//   outer.id = inner.author_id   (wrong has-many direction fallback)
	//
	// The exists() inside or() forces the planner to emit filter-strategy: 'exists'
	// (not 'join'), so enrichExistsDecisionsInPlace processes it.
	const belongsToSchema = schemaWithNullableFK; // posts.authorId → users (belongsTo)

	it('belongsTo exists filter compiled with constructor model: FK direction matches compile-with-options', () => {
		// Regression gate (FIX 2 — FIND-130): enrichExistsDecisionsInPlace previously
		// received only options?.model (undefined when compile options omit it), so the
		// constructor-configured model was never used for FK direction resolution.
		// This caused belongsTo EXISTS filters to fall back to the has-many FK direction.
		//
		// Test: a plan containing an OR exists filter (which forces exists strategy, not join)
		// compiled via adapter constructed with model but compile() called without model option.
		const queryIntent: QueryIntent = {
			type: 'select',
			from: 'posts',
			where: {
				kind: 'or',
				conditions: [
					{ kind: 'comparison', field: 'title', operator: 'eq', value: 'x' },
					{ kind: 'exists', relation: 'author' },
				],
			},
		};

		const planReport = plan(queryIntent, belongsToSchema.model, {
			dialectCapabilities: POSTGRESQL_CAPABILITIES,
		});

		// Verify the plan has a filter-strategy decision (choice may be 'join' or 'exists'
		// depending on relation cardinality — either way enrichExistsDecisionsInPlace runs).
		const filterDecision = planReport.decisions.find(
			(d) => d.type === 'filter-strategy',
		);
		expect(filterDecision).toBeDefined();

		// Reference: compile with model in OPTIONS (the currently-working path)
		const adapterNoCtorModel = createPgsqlCompileOnlyAdapter();
		const sqlWithOptionsModel = normalizeSQL(
			adapterNoCtorModel.compile(planReport, { model: belongsToSchema.model })
				.sql,
		);

		// Under test: compile with model in CONSTRUCTOR, no model in compile options.
		// Before FIX 2: enrichExistsDecisionsInPlace received undefined model →
		//   relationType not resolved → hasMany fallback → wrong FK direction.
		// After FIX 2: deps.model (= constructor model) is used → belongsTo resolved →
		//   correct FK direction.
		const adapterWithCtorModel = createPgsqlCompileOnlyAdapter({
			model: belongsToSchema.model,
		});
		const sqlWithCtorModel = normalizeSQL(
			adapterWithCtorModel.compile(planReport).sql,
		);

		// SQL must contain EXISTS (or-position: planner emits EXISTS subquery for both
		// choice='join' and choice='exists' when the filter is in OR position)
		expect(sqlWithCtorModel).toContain('exists');
		// belongsTo direction: the FK (authorId) on the outer (posts) side must appear in
		// the EXISTS correlation — NOT the has-many direction (posts.id = inner.authorId).
		expect(sqlWithCtorModel).toContain('authorid'); // normalizeSQL lowercases identifiers
		// Both paths must produce identical SQL (constructor model = options model)
		expect(sqlWithCtorModel).toBe(sqlWithOptionsModel);
	});
});

// ---------------------------------------------------------------------------
// Defect: NOT-IN-via-flag ({kind:'in', not:true}) is the second form of NOT IN.
// The optimizer must handle it with the same NULL-safety as not(in(...)).
//
// The `not` flag is set by the NQL compiler and by the adapter's convertIn()
// when cond.not is true (operator: 'notInSubquery').  The planner's
// optimizeInToExists must use effectiveNegated = negated XOR Boolean(inWhere.not)
// to correctly guard the IN→EXISTS rewrite for this form too.
// ---------------------------------------------------------------------------

describe('NOT-IN-via-flag: {kind:"in", not:true} on non-nullable FK → NOT EXISTS', () => {
	it('{kind:"in", not:true} with non-nullable FK compiles to NOT EXISTS', () => {
		// Build the intent directly using the not-flag form.
		// semantically: id NOT IN (SELECT authorId FROM posts_nn) → NOT EXISTS(...)
		const queryIntent: QueryIntent = {
			type: 'select',
			from: 'users',
			where: {
				kind: 'in',
				field: 'id',
				values: [],
				not: true,
				subquery: {
					type: 'select',
					from: 'posts_nn',
					select: { type: 'fields', fields: ['authorId'] },
				},
			},
		};

		const planReport = plan(queryIntent, schemaWithNonNullableFK.model, {
			dialectCapabilities: POSTGRESQL_CAPABILITIES,
		});

		// Planner emits a filter-strategy (notExists rewrite applied)
		const filterDecision = planReport.decisions.find(
			(d) => d.type === 'filter-strategy',
		);
		expect(filterDecision).toBeDefined();

		const { sql } = compileIntent(queryIntent, schemaWithNonNullableFK.model);

		// SQL must use NOT … EXISTS — NOT IN was rewritten.
		// The adapter may produce either `NOT EXISTS(...)` or `NOT (EXISTS(...))` —
		// both forms are semantically equivalent; check both markers are present.
		expect(sql).toContain('not');
		expect(sql).toContain('exists');
		// Must NOT fall back to the NOT IN scalar form
		expect(sql).not.toContain('= any');
		// FK correlation present
		expect(sql).toContain('"authorid"');
	});
});

describe('NOT-IN-via-flag: {kind:"in", not:true} on nullable FK → keeps NOT IN', () => {
	it('{kind:"in", not:true} with nullable FK keeps NOT IN (SQL semantics preserved)', () => {
		// nullable FK: posts.authorId is nullable → rewrite would be NULL-unsafe
		const queryIntent: QueryIntent = {
			type: 'select',
			from: 'users',
			where: {
				kind: 'in',
				field: 'id',
				values: [],
				not: true,
				subquery: {
					type: 'select',
					from: 'posts',
					select: { type: 'fields', fields: ['authorId'] },
				},
			},
		};

		const planReport = plan(queryIntent, schemaWithNullableFK.model, {
			dialectCapabilities: POSTGRESQL_CAPABILITIES,
		});

		// Planner must NOT emit a filter-strategy (nullable FK blocks rewrite)
		const filterDecision = planReport.decisions.find(
			(d) => d.type === 'filter-strategy',
		);
		expect(filterDecision).toBeUndefined();

		const { sql } = compileIntent(queryIntent, schemaWithNullableFK.model);

		// SQL must NOT contain EXISTS — original NOT IN form must be preserved
		expect(sql).not.toContain('exists');
		// The NOT IN form uses != ALL or <> ALL or NOT IN depending on the compiler
		// — at minimum, no EXISTS must appear
	});
});

describe('double-negation: not({kind:"in", not:true}) on non-nullable FK → NOT(NOT EXISTS)', () => {
	it('not({kind:"in", not:true}) produces NOT(NOT EXISTS) — outer not structure preserved', () => {
		// NOT (field NOT IN (subquery)) — the corrected design preserves the outer NOT
		// structure.  The inner {kind:'in', not:true} leaf rewrites to notExists (form
		// from flag), so the result is not(notExists) = NOT(NOT EXISTS(...)).
		// Semantically equivalent to positive EXISTS, but the boolean structure is
		// explicitly preserved rather than algebraically collapsed.
		const queryIntent: QueryIntent = {
			type: 'select',
			from: 'users',
			where: {
				kind: 'not',
				condition: {
					kind: 'in',
					field: 'id',
					values: [],
					not: true,
					subquery: {
						type: 'select',
						from: 'posts_nn',
						select: { type: 'fields', fields: ['authorId'] },
					},
				},
			},
		};

		const planReport = plan(queryIntent, schemaWithNonNullableFK.model, {
			dialectCapabilities: POSTGRESQL_CAPABILITIES,
		});

		// Planner emits a filter-strategy (notExists — the inner not-flag leaf rewrites to notExists)
		const filterDecision = planReport.decisions.find(
			(d) => d.type === 'filter-strategy',
		);
		expect(filterDecision).toBeDefined();

		// executableIntent: outer not wrapping inner notExists
		const execWhere = planReport.executableIntent?.where as {
			kind: string;
			condition?: { kind: string };
		};
		expect(execWhere?.kind).toBe('not');
		expect(execWhere?.condition?.kind).toBe('notExists');

		const { sql } = compileIntent(queryIntent, schemaWithNonNullableFK.model);

		// SQL contains both exists and not (outer NOT wraps inner NOT EXISTS)
		expect(sql).toContain('exists');
		expect(sql).toContain('not');
		expect(sql).toContain('"authorid"');
		// NOT IN raw form must not appear
		expect(sql).not.toContain('= any');
	});
});

describe('positive inSubquery (non-negated) — non-regression for not-flag fix', () => {
	it('plain inSubquery (no not flag) on non-nullable FK still rewrites to EXISTS', () => {
		const { sql } = compileIntent(
			{
				type: 'select',
				from: 'users',
				where: inSubquery('id', subquery('posts_nn').select('authorId')),
			},
			schemaWithNonNullableFK.model,
		);
		expect(sql).toContain('exists');
		expect(sql).not.toContain('not exists');
	});

	it('plain inSubquery (no not flag) on nullable FK still rewrites to EXISTS', () => {
		const { sql } = compileIntent(
			{
				type: 'select',
				from: 'users',
				where: inSubquery('id', subquery('posts').select('authorId')),
			},
			schemaWithNullableFK.model,
		);
		expect(sql).toContain('exists');
		expect(sql).not.toContain('not exists');
	});
});
