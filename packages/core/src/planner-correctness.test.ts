/**
 * @fileoverview Proof tests for planner correctness fixes (Commit 2).
 *
 * Covers:
 * - FIND-012: NOT IN on nullable FK preserves NOT IN semantics (no NOT EXISTS rewrite)
 * - FIND-013: Recursive includes on dialect without supportsRecursiveCTE throw
 * - FIND-014: include.limit with join strategy throws InvalidOperationError
 * - FIND-130 (item 1): IN→EXISTS optimization aligns report.intent with plan.decisions
 * - FIND-015: Lenient ambiguity resolution is alphabetically deterministic
 *
 * Regression gate: each test is designed so removing the corresponding fix
 * would cause it to fail.
 */

import type { IncludeIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import {
	createDialectCapabilities,
	POSTGRESQL_CAPABILITIES,
	SQLITE_CAPABILITIES,
} from './dialects/index.js';
import { InvalidOperationError } from './dx/errors.js';
import { eq, inSubquery, not } from './dx/filters.js';
import { createOrm } from './dx/index.js';
import { ref, schema } from './dx/schema.js';
import { subquery } from './dx/subquery-builder.js';
import { createMockAdapter } from './dx/test-utils.js';
import type { QueryIntent } from './index.js';
import {
	plan,
	UnsupportedStrategyError,
	validateIncludeStrategy,
	validateResolvedIncludeStrategy,
} from './planner.js';

// ============================================================================
// Dialect fixtures
// ============================================================================

/** Dialect that declares NO strategy support — forces auto → join */
const NO_CTE_CAPS = createDialectCapabilities({
	name: 'test-no-cte',
	identifierQuote: '"',
	parameterStyle: 'dollar',
	limitStyle: 'limit-offset',
	booleanStyle: 'native',
	recursivePathStyle: 'string',
	stringConcatStyle: 'operator',
	supportsLateralJoin: false,
	supportsJsonAgg: false,
	supportsRecursiveCTE: false,
});

/** Dialect with full support including recursive CTE */
const FULL_CAPS = POSTGRESQL_CAPABILITIES;

// ============================================================================
// FIND-012 — NOT IN on nullable FK must NOT be rewritten to NOT EXISTS
// ============================================================================

describe('FIND-012: NOT IN on nullable FK preserves NOT IN semantics', () => {
	/**
	 * Schema with a nullable FK: posts.authorId is nullable.
	 * NOT IN on a nullable column MUST be preserved as NOT IN.
	 * SQL three-valued logic: NOT IN returns UNKNOWN (excludes row) when the
	 * subquery can produce NULLs, whereas NOT EXISTS always returns TRUE for
	 * an empty subquery.
	 */
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

	/**
	 * Schema with a non-nullable FK: posts_nn.authorId is NOT NULL.
	 * NOT IN on a non-nullable column CAN safely be rewritten to NOT EXISTS.
	 */
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

	it('NOT IN on nullable FK preserves NOT(IN) — no filter-strategy decision emitted', () => {
		// Regression gate: before FIND-012 fix, the planner rewrote NOT IN → NOT EXISTS
		// (a filter-strategy decision is created only when EXISTS/NOT EXISTS is reached
		// in processWhere). After the fix, NOT IN is preserved → processWhere hits the
		// 'not' → 'in' path → no filter-strategy decision → no relation analysis.
		const intent: QueryIntent = {
			type: 'select',
			from: 'users',
			where: not(inSubquery('id', subquery('posts').select('authorId'))),
		};
		const result = plan(intent, schemaWithNullableFK.model);
		expect(result).toBeDefined();

		// With the fix: no filter-strategy decision (NOT IN preserved, not rewritten to EXISTS)
		const filterDecision = result.decisions.find(
			(d) => d.type === 'filter-strategy',
		);
		expect(filterDecision).toBeUndefined();
	});

	it('NOT IN on non-nullable FK emits a filter-strategy decision (notExists rewrite applies)', () => {
		// Regression gate: the valid optimization for non-nullable columns MUST still
		// produce a filter-strategy decision (meaning notExists was reached and
		// processRelationFilter was called).
		const intent: QueryIntent = {
			type: 'select',
			from: 'users',
			where: not(inSubquery('id', subquery('posts_nn').select('authorId'))),
		};
		const result = plan(intent, schemaWithNonNullableFK.model);
		expect(result).toBeDefined();

		// notExists was reached → filter-strategy decision exists
		const filterDecision = result.decisions.find(
			(d) => d.type === 'filter-strategy',
		);
		expect(filterDecision).toBeDefined();
	});

	it('positive IN on nullable FK is optimized to EXISTS — filter-strategy decision present', () => {
		// The positive IN → EXISTS rewrite is always safe (no three-valued-logic issue).
		// This guards against accidentally blocking the positive-match optimization.
		const intent: QueryIntent = {
			type: 'select',
			from: 'users',
			where: inSubquery('id', subquery('posts').select('authorId')),
		};
		const result = plan(intent, schemaWithNullableFK.model);
		expect(result).toBeDefined();

		// Positive IN → EXISTS: processRelationFilter is called → filter-strategy decision
		const filterDecision = result.decisions.find(
			(d) => d.type === 'filter-strategy',
		);
		expect(filterDecision).toBeDefined();
	});
});

// ============================================================================
// FIND-013 — Recursive includes gate on supportsRecursiveCTE capability
// ============================================================================

describe('FIND-013: Recursive includes gate on supportsRecursiveCTE capability', () => {
	const categoriesSchema = schema({
		categories: {
			id: { type: 'integer', primaryKey: true },
			name: 'string',
			parentId: ref('categories', {
				nullable: true,
				roles: { parent: 'parent', children: 'children' },
			}),
		},
	});

	it('recursive include on dialect with supportsRecursiveCTE=false throws UnsupportedStrategyError', () => {
		// Regression gate: before FIND-013 fix, the planner silently emitted a
		// CTE-based plan even when the dialect declared supportsRecursiveCTE=false.
		const intent: QueryIntent = {
			type: 'select',
			from: 'categories',
			include: [{ relation: 'children', recursive: { maxDepth: 5 } }],
		};
		expect(() =>
			plan(intent, categoriesSchema.model, {
				dialectCapabilities: NO_CTE_CAPS,
			}),
		).toThrow(UnsupportedStrategyError);
	});

	it('thrown error message mentions recursive', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'categories',
			include: [{ relation: 'children', recursive: { maxDepth: 5 } }],
		};
		expect(() =>
			plan(intent, categoriesSchema.model, {
				dialectCapabilities: NO_CTE_CAPS,
			}),
		).toThrow(/recursive/i);
	});

	it('recursive include on dialect with supportsRecursiveCTE=true succeeds with cte strategy', () => {
		// Regression gate: a valid dialect must not throw.
		const intent: QueryIntent = {
			type: 'select',
			from: 'categories',
			include: [{ relation: 'children', recursive: { maxDepth: 5 } }],
		};
		const result = plan(intent, categoriesSchema.model, {
			dialectCapabilities: FULL_CAPS,
		});
		expect(result).toBeDefined();
		const stratDecision = result.decisions.find(
			(d) => d.type === 'include-strategy',
		);
		expect(stratDecision?.choice).toBe('cte');
	});

	it('recursive include with no dialectCapabilities (undefined) refuses explicitly', () => {
		// Unknown dialect → refuse recursion without explicit CTE capability.
		const intent: QueryIntent = {
			type: 'select',
			from: 'categories',
			include: [{ relation: 'children', recursive: { maxDepth: 5 } }],
		};
		expect(() => plan(intent, categoriesSchema.model)).toThrow(
			'Recursive include at include[0](children) requires a dialect with supportsRecursiveCTE; current dialect (no capabilities) does not support it.',
		);
	});
});

// ============================================================================
// FIND-014 — include.limit with join strategy throws InvalidOperationError
// ============================================================================

describe('FIND-014: include.limit with join strategy throws InvalidOperationError', () => {
	const simpleSchema = schema({
		users: {
			id: { type: 'integer', primaryKey: true },
			name: 'string',
		},
		posts: {
			id: { type: 'integer', primaryKey: true },
			authorId: ref('users', { as: 'author', inverse: 'posts' }),
			title: 'string',
		},
	});

	it('include.limit with explicit join:inner throws InvalidOperationError', () => {
		// Regression gate: before FIND-014 fix, the limit was silently dropped
		// and callers received unlimited rows with no diagnostic.
		const intent: QueryIntent = {
			type: 'select',
			from: 'users',
			include: [{ relation: 'posts', join: 'inner', limit: 5 }],
		};
		expect(() => plan(intent, simpleSchema.model)).toThrow(
			InvalidOperationError,
		);
	});

	it('include.limit with explicit join:left throws InvalidOperationError', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'users',
			include: [{ relation: 'posts', join: 'left', limit: 3 }],
		};
		expect(() => plan(intent, simpleSchema.model)).toThrow(
			InvalidOperationError,
		);
	});

	it('error message mentions join strategy and limit constraint', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'users',
			include: [{ relation: 'posts', join: 'inner', limit: 5 }],
		};
		expect(() => plan(intent, simpleSchema.model)).toThrow(
			/join.*limit|limit.*join/i,
		);
	});

	it('include.limit with auto selection that falls back to join (no lateral/json_agg) throws', () => {
		// When auto-selection returns join (no lateral/json_agg) and limit is set,
		// must throw rather than silently drop the limit.
		const intent: QueryIntent = {
			type: 'select',
			from: 'users',
			include: [{ relation: 'posts', limit: 5 }],
		};
		expect(() =>
			plan(intent, simpleSchema.model, {
				dialectCapabilities: NO_CTE_CAPS, // forces join fallback
			}),
		).toThrow(InvalidOperationError);
	});

	it('include.limit with strategy:flat and LATERAL capability works (the supported path)', () => {
		// Regression gate: flat + limit MUST succeed via LATERAL strategy.
		const intent: QueryIntent = {
			type: 'select',
			from: 'users',
			include: [{ relation: 'posts', strategy: 'flat', limit: 5 }],
		};
		const result = plan(intent, simpleSchema.model, {
			dialectCapabilities: FULL_CAPS,
		});
		expect(result).toBeDefined();
		const stratDecision = result.decisions.find(
			(d) => d.type === 'include-strategy',
		);
		expect(stratDecision?.choice).toBe('lateral');
	});

	it('include with no limit and explicit join:inner does not throw', () => {
		// Guard against over-triggering: limit-free join includes must not throw.
		const intent: QueryIntent = {
			type: 'select',
			from: 'users',
			include: [{ relation: 'posts', join: 'inner' }],
		};
		expect(() => plan(intent, simpleSchema.model)).not.toThrow();
	});
});

// ============================================================================
// FIND-015 — Lenient ambiguity resolution is alphabetically deterministic
// ============================================================================

describe('FIND-015: Lenient ambiguity resolution is alphabetically deterministic', () => {
	/**
	 * Schema with two relations from users → posts:
	 * - zebraPosts (definition order: first)
	 * - authoredPosts (definition order: second)
	 *
	 * Alphabetical order: authoredPosts < zebraPosts → authoredPosts must be chosen
	 * regardless of which was defined first.
	 */
	const schemaZebraFirst = schema({
		users: {
			id: { type: 'integer', primaryKey: true },
			name: 'string',
		},
		posts: {
			id: { type: 'integer', primaryKey: true },
			zebraId: ref('users', { as: 'zebra', inverse: 'zebraPosts' }),
			authorId: ref('users', { as: 'author', inverse: 'authoredPosts' }),
			title: 'string',
		},
	});

	/**
	 * Same logical schema with reversed definition order:
	 * - authoredPosts (definition order: first)
	 * - zebraPosts (definition order: second)
	 */
	const schemaAuthorFirst = schema({
		users: {
			id: { type: 'integer', primaryKey: true },
			name: 'string',
		},
		posts_af: {
			id: { type: 'integer', primaryKey: true },
			authorId: ref('users', { as: 'author', inverse: 'authoredPosts_af' }),
			zebraId: ref('users', { as: 'zebra', inverse: 'zebraPosts_af' }),
			title: 'string',
		},
	});

	it('lenient mode picks alphabetically first relation when zebra is defined first', () => {
		// Regression gate: before FIND-015, options[0] was schema-order-dependent.
		// After fix: always alphabetically first regardless of definition order.
		const orm = createOrm({
			adapter: createMockAdapter(),
			schema: schemaZebraFirst,
			strictMode: false,
		});
		const planReport = orm.select('users').include('posts').plan();

		const warning = planReport.warnings.find(
			(w) => w.code === 'AMBIGUOUS_RELATION',
		);
		expect(warning).toBeDefined();
		// authoredPosts < zebraPosts alphabetically → must be chosen
		expect(warning?.message).toContain('authoredPosts');
		expect(warning?.message).not.toMatch(
			/^.*zebra.*was automatically resolved/,
		);
	});

	it('lenient mode picks same relation when definition order is reversed', () => {
		// Core determinism test: reversing definition order must not change the result.
		const orm = createOrm({
			adapter: createMockAdapter(),
			schema: schemaAuthorFirst,
			strictMode: false,
		});
		const planReport = orm.select('users').include('posts_af').plan();

		const warning = planReport.warnings.find(
			(w) => w.code === 'AMBIGUOUS_RELATION',
		);
		expect(warning).toBeDefined();
		expect(warning?.message).toContain('authoredPosts_af');
	});

	it('strict mode still throws when multiple relations match (no silent auto-resolve)', () => {
		const orm = createOrm({
			adapter: createMockAdapter(),
			schema: schemaZebraFirst,
			strictMode: true,
		});
		expect(() => orm.select('users').include('posts').plan()).toThrow();
	});

	it('warning message documents the alphabetical tie-break', () => {
		const orm = createOrm({
			adapter: createMockAdapter(),
			schema: schemaZebraFirst,
			strictMode: false,
		});
		const planReport = orm.select('users').include('posts').plan();
		const warning = planReport.warnings.find(
			(w) => w.code === 'AMBIGUOUS_RELATION',
		);
		// The message should mention alphabetical tie-break (documents the contract)
		expect(warning?.message).toMatch(/alphabetical/i);
	});
});

// ============================================================================
// FIND-130 (item 1) — IN→EXISTS optimization must align report.intent with
//                      plan.decisions so dump().plan and dump().sql agree
// ============================================================================

describe('FIND-130: IN→EXISTS optimization: intent stays original; executableIntent carries optimized WHERE', () => {
	/**
	 * Schema: products --(hasMany)--> productImages
	 * The hasMany relation means:
	 *   products.id IN (SELECT productId FROM productImages WHERE ...)
	 * can be rewritten to:
	 *   EXISTS (SELECT 1 FROM productImages WHERE productId = products.id AND ...)
	 */
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

	it('report.intent stays kind=in; report.executableIntent carries kind=exists after IN→EXISTS optimization', () => {
		// Contract (FIND-130 correct design):
		//   - report.intent = original submitted intent (kind='in') — observable via dump()
		//   - report.executableIntent = optimized form (kind='exists') — adapter compiles from this
		//   - plan.decisions records EXISTS filter-strategy (built from optimized WHERE)
		// All three are consistent: intent shows what the user wrote; SQL uses EXISTS.
		const intent: QueryIntent = {
			type: 'select',
			from: 'products',
			where: {
				kind: 'in',
				field: 'id',
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

		const report = plan(intent, testSchema.model);

		// The filter-strategy decision must claim EXISTS
		const filterDecision = report.decisions.find(
			(d) => d.type === 'filter-strategy',
		);
		expect(filterDecision?.choice).toBe('exists');

		// report.intent.where must stay kind='in' — the original submitted intent is preserved
		expect(report.intent.where?.kind).toBe('in');

		// report.executableIntent.where must be kind='exists' — the optimized form for SQL
		expect(report.executableIntent).toBeDefined();
		expect(report.executableIntent?.where?.kind).toBe('exists');

		// The original intent object must NOT be mutated
		expect(intent.where?.kind).toBe('in');
	});

	it('report.intent is not mutated — original intent retains kind=in', () => {
		// Regression gate: plannedIntent must be a new object when optimization runs;
		// the caller's original intent must be unchanged.
		const originalWhere = {
			kind: 'in' as const,
			field: 'id',
			subquery: {
				type: 'select' as const,
				from: 'productImages',
				select: { type: 'fields' as const, fields: ['productId'] },
			},
		};
		const intent: QueryIntent = {
			type: 'select',
			from: 'products',
			where: originalWhere,
		};

		plan(intent, testSchema.model);

		// Original intent must be unchanged (no in-place mutation)
		expect(intent.where).toBe(originalWhere);
		expect(intent.where?.kind).toBe('in');
	});

	it('report.intent.where retains kind=in when optimization does not apply (unknown relation)', () => {
		// When optimization does not trigger, report.intent must be the same object
		// as the original intent (no unnecessary wrapping).
		const intent: QueryIntent = {
			type: 'select',
			from: 'products',
			where: {
				kind: 'in',
				field: 'id',
				subquery: {
					type: 'select',
					from: 'unknownTable',
					select: { type: 'fields', fields: ['productId'] },
				},
			},
		};

		const report = plan(intent, testSchema.model);

		// No optimization: report.intent must still be the original object
		expect(report.intent).toBe(intent);
		expect(report.intent.where?.kind).toBe('in');
	});

	it('NOT IN on non-nullable FK: report.intent.where.kind is notExists after rewrite', () => {
		// When NOT IN → NOT EXISTS rewrite applies (non-nullable FK), the optimized
		// intent must also flow through so plan and SQL agree on NOT EXISTS.
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

		const intent: QueryIntent = {
			type: 'select',
			from: 'users',
			where: {
				kind: 'not',
				condition: {
					kind: 'in',
					field: 'id',
					subquery: {
						type: 'select',
						from: 'posts_nn',
						select: { type: 'fields', fields: ['authorId'] },
					},
				},
			},
		};

		const report = plan(intent, schemaWithNonNullableFK.model);

		// plan.decisions must record a filter-strategy (notExists reached processRelationFilter)
		const filterDecision = report.decisions.find(
			(d) => d.type === 'filter-strategy',
		);
		expect(filterDecision).toBeDefined();

		// report.intent.where must stay kind='not' — the original submitted intent is preserved
		expect(report.intent.where?.kind).toBe('not');

		// report.executableIntent.where must be kind='not' wrapping kind='exists'.
		// The corrected design preserves the outer 'not' structure and rewrites the
		// inner 'in' leaf to 'exists' (form from the in-intent's own not-flag=false).
		// The adapter compiles not(exists) as NOT EXISTS(...) — semantically correct.
		// (Previously this was kind='notExists' directly; the new form is structurally
		// equivalent and keeps the boolean tree intact for nested contexts.)
		expect(report.executableIntent).toBeDefined();
		const execWhere = report.executableIntent?.where as {
			kind: string;
			condition?: { kind: string };
		};
		expect(execWhere?.kind).toBe('not');
		expect(execWhere?.condition?.kind).toBe('exists');

		// Original intent must not be mutated
		expect(intent.where?.kind).toBe('not');
	});

	it('NOT IN on nullable FK: report.intent unchanged (optimization blocked by null guard)', () => {
		// When nullable FK blocks the NOT IN → NOT EXISTS rewrite,
		// report.intent must remain the original intent (kind='not' wrapping 'in').
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

		const intent: QueryIntent = {
			type: 'select',
			from: 'users',
			where: {
				kind: 'not',
				condition: {
					kind: 'in',
					field: 'id',
					subquery: {
						type: 'select',
						from: 'posts',
						select: { type: 'fields', fields: ['authorId'] },
					},
				},
			},
		};

		const report = plan(intent, schemaWithNullableFK.model);

		// Nullable FK blocks NOT IN → NOT EXISTS: no filter-strategy decision
		const filterDecision = report.decisions.find(
			(d) => d.type === 'filter-strategy',
		);
		expect(filterDecision).toBeUndefined();

		// report.intent must be identical to original (optimization did not apply)
		expect(report.intent).toBe(intent);
		expect(report.intent.where?.kind).toBe('not');
	});
});

// ============================================================================
// Conservative IN→EXISTS guards: non-simple subqueries + OR-position
// ============================================================================

describe('IN→EXISTS: conservative guard blocks non-simple subqueries and OR position', () => {
	/**
	 * Schema: products --(hasMany productImages via productId FK)
	 */
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

	it('IN with groupBy subquery: report.intent.where stays kind=in (optimization blocked)', () => {
		// Regression gate (filter broadening): EXISTS drops GROUP BY/HAVING constraints,
		// causing the rewritten query to match more rows than the original IN form.
		const intent: QueryIntent = {
			type: 'select',
			from: 'products',
			where: {
				kind: 'in',
				field: 'id',
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

		const report = plan(intent, testSchema.model);

		const filterDecision = report.decisions.find(
			(d) => d.type === 'filter-strategy',
		);
		expect(filterDecision).toBeUndefined();
		expect(report.intent).toBe(intent);
		expect(report.intent.where?.kind).toBe('in');
	});

	it('IN with having-only subquery: report.intent.where stays kind=in', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'products',
			where: {
				kind: 'in',
				field: 'id',
				subquery: {
					type: 'select',
					from: 'productImages',
					select: { type: 'fields', fields: ['productId'] },
					having: {
						kind: 'comparison',
						field: 'count',
						operator: 'gt',
						value: 1,
					},
				},
			},
		};

		const report = plan(intent, testSchema.model);
		expect(report.intent).toBe(intent);
		expect(report.intent.where?.kind).toBe('in');
	});

	it('IN with offset subquery: report.intent.where stays kind=in', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'products',
			where: {
				kind: 'in',
				field: 'id',
				subquery: {
					type: 'select',
					from: 'productImages',
					select: { type: 'fields', fields: ['productId'] },
					offset: 5,
				},
			},
		};

		const report = plan(intent, testSchema.model);
		expect(report.intent).toBe(intent);
		expect(report.intent.where?.kind).toBe('in');
	});

	it('IN with distinctOn subquery: report.intent.where stays kind=in', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'products',
			where: {
				kind: 'in',
				field: 'id',
				subquery: {
					type: 'select',
					from: 'productImages',
					select: { type: 'fields', fields: ['productId'] },
					distinctOn: ['productId'],
				},
			},
		};

		const report = plan(intent, testSchema.model);
		expect(report.intent).toBe(intent);
		expect(report.intent.where?.kind).toBe('in');
	});

	it('IN with aggregate select subquery: report.intent.where stays kind=in', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'products',
			where: {
				kind: 'in',
				field: 'id',
				subquery: {
					type: 'select',
					from: 'productImages',
					select: {
						type: 'aggregate',
						aggregates: [{ function: 'count', field: 'productId' }],
					},
				},
			},
		};

		const report = plan(intent, testSchema.model);
		expect(report.intent).toBe(intent);
		expect(report.intent.where?.kind).toBe('in');
	});

	it('IN inside OR: the IN branch is rewritten to exists inside the OR', () => {
		// The adapter now compiles EXISTS inline at its boolean tree position rather than
		// hoisting to top-level AND, so it is safe to optimize an IN inside an OR.
		// This test confirms the planner does recurse into OR branches and rewrites the
		// IN branch to exists — the OR structure is preserved in executableIntent.
		const intent: QueryIntent = {
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

		const report = plan(intent, testSchema.model);

		// A filter-strategy decision is emitted (the IN inside OR was optimized)
		const filterDecision = report.decisions.find(
			(d) => d.type === 'filter-strategy',
		);
		expect(filterDecision?.choice).toBe('exists');

		// report.intent stays the original (unchanged)
		expect(report.intent).toBe(intent);

		// executableIntent carries the optimized OR (with exists inside)
		expect(report.executableIntent?.where?.kind).toBe('or');
		const orWhere = report.executableIntent?.where;
		if (orWhere?.kind !== 'or') {
			throw new Error('Expected the optimized where clause to be an OR');
		}
		expect(orWhere.conditions[1]?.kind).toBe('exists');
	});

	it('simple IN (no modifiers, top-level): still rewrites to EXISTS', () => {
		// Non-regression: the conservative guard must not block the simple case.
		const intent: QueryIntent = {
			type: 'select',
			from: 'products',
			where: {
				kind: 'in',
				field: 'id',
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

		const report = plan(intent, testSchema.model);

		const filterDecision = report.decisions.find(
			(d) => d.type === 'filter-strategy',
		);
		expect(filterDecision?.choice).toBe('exists');
		// report.intent.where stays kind='in' — original intent preserved
		expect(report.intent.where?.kind).toBe('in');
		// report.executableIntent.where is kind='exists' — the optimized form for SQL
		expect(report.executableIntent?.where?.kind).toBe('exists');
	});

	it('simple IN inside AND: still rewrites to EXISTS', () => {
		// Non-regression: AND recursion must still produce EXISTS for the IN branch.
		const intent: QueryIntent = {
			type: 'select',
			from: 'products',
			where: {
				kind: 'and',
				conditions: [
					{ kind: 'comparison', field: 'name', operator: 'eq', value: 'W' },
					{
						kind: 'in',
						field: 'id',
						subquery: {
							type: 'select',
							from: 'productImages',
							select: { type: 'fields', fields: ['productId'] },
						},
					},
				],
			},
		};

		const report = plan(intent, testSchema.model);

		const filterDecision = report.decisions.find(
			(d) => d.type === 'filter-strategy',
		);
		expect(filterDecision?.choice).toBe('exists');
		// report.intent stays original — the AND's second condition keeps kind='in'
		const originalAndWhere = report.intent.where;
		if (originalAndWhere?.kind !== 'and') {
			throw new Error('Expected the original where clause to be an AND');
		}
		expect(originalAndWhere.conditions[1]?.kind).toBe('in');
		// report.executableIntent carries the rewritten AND — second condition is kind='exists'
		const execAndWhere = report.executableIntent?.where;
		if (execAndWhere?.kind !== 'and') {
			throw new Error('Expected the optimized where clause to be an AND');
		}
		expect(execAndWhere.conditions[1]?.kind).toBe('exists');
	});

	it('IN with lock subquery: report.intent.where stays kind=in (lock guard)', () => {
		// Regression gate (FIX 1 — FIND-130): an IN subquery with a row lock (FOR UPDATE)
		// must NOT be rewritten to EXISTS — the adapter would silently drop the lock clause.
		// Guard: sq.lock != null blocks the rewrite.
		const intent: QueryIntent = {
			type: 'select',
			from: 'products',
			where: {
				kind: 'in',
				field: 'id',
				subquery: {
					type: 'select',
					from: 'productImages',
					select: { type: 'fields', fields: ['productId'] },
					lock: { strength: 'forUpdate', waitPolicy: 'block' },
				},
			},
		};

		const report = plan(intent, testSchema.model);

		const filterDecision = report.decisions.find(
			(d) => d.type === 'filter-strategy',
		);
		expect(filterDecision).toBeUndefined();
		expect(report.intent).toBe(intent);
		expect(report.intent.where?.kind).toBe('in');
	});

	it('IN with existsWrap subquery: report.intent.where stays kind=in (existsWrap guard)', () => {
		// Regression gate (FIX 1 — FIND-130): an IN subquery with existsWrap=true
		// must NOT be rewritten to EXISTS — rewriting would silently drop the existsWrap
		// semantics. Guard: sq.existsWrap blocks the rewrite.
		const intent: QueryIntent = {
			type: 'select',
			from: 'products',
			where: {
				kind: 'in',
				field: 'id',
				subquery: {
					type: 'select',
					from: 'productImages',
					select: { type: 'fields', fields: ['productId'] },
					existsWrap: true,
				},
			},
		};

		const report = plan(intent, testSchema.model);

		const filterDecision = report.decisions.find(
			(d) => d.type === 'filter-strategy',
		);
		expect(filterDecision).toBeUndefined();
		expect(report.intent).toBe(intent);
		expect(report.intent.where?.kind).toBe('in');
	});
});

describe('#894 strategy error alternatives', () => {
	const db = schema({
		users: { id: { type: 'integer', primaryKey: true } },
		posts: {
			id: { type: 'integer', primaryKey: true },
			authorId: ref('users', { as: 'author', inverse: 'posts' }),
		},
	} as const);
	const intent: QueryIntent = {
		type: 'select',
		from: 'users',
		include: [{ relation: 'posts' }],
	};
	it('lists all accepted strategies without capabilities', () => {
		expect(() =>
			plan(intent, db.model, { defaultIncludeStrategy: 'subquery' as never }),
		).toThrow(
			"Unknown strategy 'subquery'. Valid strategies: 'join', 'json_agg', 'lateral', 'cte', 'auto'.",
		);
		expect(validateIncludeStrategy('auto', undefined)).toBe('join');
		for (const strategy of ['join', 'json_agg', 'lateral', 'cte']) {
			expect(validateIncludeStrategy(strategy, undefined)).toBe(strategy);
		}
	});
	it('lists only accepted strategies when lateral and json_agg are unavailable', () => {
		expect(() =>
			plan(intent, db.model, {
				defaultIncludeStrategy: 'lateral',
				dialectCapabilities: NO_CTE_CAPS,
			}),
		).toThrow(
			"Strategy 'lateral' is not supported by test-no-cte. Supported strategies: 'join', 'auto'.",
		);
		expect(validateIncludeStrategy('join', NO_CTE_CAPS)).toBe('join');
	});
});

describe('#900 resolved validator accepted lists', () => {
	it('accepts exactly the resolved list with no capabilities', () => {
		for (const s of ['join', 'json_agg', 'lateral', 'cte'])
			expect(validateResolvedIncludeStrategy(s, undefined)).toBe(s);
		expect(() => validateResolvedIncludeStrategy('auto', undefined)).toThrow(
			"Strategy 'auto' is not supported by a dialect without capabilities. Supported strategies: 'join', 'json_agg', 'lateral', 'cte'.",
		);
	});
	it('lists only join with restricted capabilities', () => {
		expect(validateResolvedIncludeStrategy('join', NO_CTE_CAPS)).toBe('join');
		expect(validateIncludeStrategy('auto', NO_CTE_CAPS)).toBe('join');
		for (const s of ['auto', 'json_agg', 'lateral', 'cte'])
			expect(() => validateResolvedIncludeStrategy(s, NO_CTE_CAPS)).toThrow(
				`Strategy '${s}' is not supported by test-no-cte. Supported strategies: 'join'.`,
			);
	});
});

describe('#900 default capability validation at the include consumer', () => {
	const db = schema({
		categories: {
			id: { type: 'integer', primaryKey: true },
			parentId: ref('categories', {
				nullable: true,
				roles: { parent: 'parent', children: 'children' },
			}),
		},
	});

	for (const defaultIncludeStrategy of ['json_agg', 'lateral'] as const) {
		it(`plans recursive children as cte with unsupported ${defaultIncludeStrategy} default`, () => {
			const report = plan(
				{
					type: 'select',
					from: 'categories',
					include: [{ relation: 'children', recursive: { maxDepth: 5 } }],
				},
				db.model,
				{ defaultIncludeStrategy, dialectCapabilities: SQLITE_CAPABILITIES },
			);
			const decision = report.decisions.find(
				(d) => d.type === 'include-strategy',
			);
			expect(decision?.choice).toBe('cte');
			expect(decision?.alternatives).toEqual([]);
		});

		it(`refuses a non-recursive consumer of unsupported ${defaultIncludeStrategy} default`, () => {
			const consumeDefault = () =>
				plan(
					{
						type: 'select',
						from: 'categories',
						include: [{ relation: 'children' }],
					},
					db.model,
					{ defaultIncludeStrategy, dialectCapabilities: SQLITE_CAPABILITIES },
				);
			expect(consumeDefault).toThrow(UnsupportedStrategyError);
			expect(consumeDefault).toThrow(
				`Strategy '${defaultIncludeStrategy}' is not supported by sqlite. Supported strategies: 'join', 'cte', 'auto'.`,
			);
		});
	}

	it('refuses an unknown default at entry even without includes', () => {
		const unknownDefault = () =>
			plan({ type: 'select', from: 'categories' }, db.model, {
				defaultIncludeStrategy: 'subquery' as never,
				dialectCapabilities: SQLITE_CAPABILITIES,
			});
		expect(unknownDefault).toThrow(UnsupportedStrategyError);
		expect(unknownDefault).toThrow(
			"Unknown strategy 'subquery'. Valid strategies: 'join', 'json_agg', 'lateral', 'cte', 'auto'.",
		);
	});
});

describe('#900 flat strategy precedence', () => {
	function fixture(hint: string = 'auto') {
		const db = schema({
			users: { id: { type: 'integer', primaryKey: true } },
			posts: {
				id: { type: 'integer', primaryKey: true },
				authorId: ref('users', { as: 'author', inverse: 'posts' }),
			},
			comments: {
				id: { type: 'integer', primaryKey: true },
				postId: ref('posts', { as: 'post', inverse: 'comments' }),
			},
		});
		Object.assign(db.model.getRelation('users.posts')!, {
			includeStrategy: hint,
		});
		return db.model;
	}

	for (const strategy of ['flat', 'auto'] as const) {
		for (const hint of ['json_agg', 'lateral', 'cte']) {
			it(`refuses explicit join conflicting with ${hint} on ${strategy}`, () => {
				expect(() =>
					plan(
						{
							type: 'select',
							from: 'users',
							include: [{ relation: 'posts', strategy, join: 'left' }],
						},
						fixture(hint),
						{ dialectCapabilities: FULL_CAPS },
					),
				).toThrow(
					new UnsupportedStrategyError(
						`Include at include[0](posts) cannot use explicit join because relation 'posts' declares includeStrategy '${hint}'. Use 'auto' or 'join', or remove include.join.`,
					),
				);
			});
		}
		for (const hint of ['auto', 'join']) {
			it(`explicit join beats lateral default with ${hint} hint on ${strategy}`, () => {
				const report = plan(
					{
						type: 'select',
						from: 'users',
						include: [{ relation: 'posts', strategy, join: 'left' }],
					},
					fixture(hint),
					{ defaultIncludeStrategy: 'lateral', dialectCapabilities: FULL_CAPS },
				);
				const decision = report.decisions.find(
					(d) => d.type === 'include-strategy',
				)!;
				expect(decision.choice).toBe('join');
				expect(decision.reasoning).toBe(
					'Relation users.posts (hasMany, cardinality: many) - using join selected by explicit join',
				);
			});
		}
	}
	for (const strategy of ['join', 'lateral'] as const) {
		it(`flat ${strategy} decision reports default and admissible alternatives`, () => {
			const decision = resolve('auto', strategy).decisions.find(
				(d) => d.type === 'include-strategy',
			)!;
			expect(decision.choice).toBe(strategy);
			expect(decision.reasoning).toBe(
				`Relation users.posts (hasMany, cardinality: many) - using ${strategy} selected by defaultIncludeStrategy`,
			);
			expect(decision.alternatives).toEqual([
				strategy === 'join' ? 'lateral' : 'join',
			]);
		});
	}
	it('flat where under join default has no lateral alternative', () => {
		const decision = resolve('auto', 'join', {
			where: eq('id', 1),
		}).decisions.find((d) => d.type === 'include-strategy')!;
		expect(decision.alternatives).toEqual([]);
	});
	it('limited nested include excludes join and cte alternatives', () => {
		const decision = plan(
			{
				type: 'select',
				from: 'users',
				include: [{ relation: 'posts', limit: 2 }],
			},
			fixture(),
			{ dialectCapabilities: FULL_CAPS },
		).decisions.find((d) => d.type === 'include-strategy')!;
		expect(decision.alternatives).toEqual(['lateral']);
	});
	it('refuses an unknown runtime join selection form', () => {
		expect(() =>
			plan(
				{
					type: 'select',
					from: 'users',
					include: [
						{
							relation: 'posts',
							join: 'left',
							select: { type: 'future' } as unknown as IncludeIntent['select'],
						},
					],
				},
				fixture(),
				{ dialectCapabilities: FULL_CAPS },
			),
		).toThrowError(
			"Invalid include: Include include[0](posts) select is not supported by 'join' strategy. Received select form: future.",
		);
	});
	for (const [extra, expected] of [
		[{ where: eq('id', 1) }, []],
		[{ orderBy: [{ field: 'id', direction: 'asc' }] }, []],
		[{ select: { type: 'fields', fields: ['id'] } }, ['join']],
		[{ select: { type: 'all' } }, ['lateral']],
		[{ select: { type: 'fields', fields: ['*'] } }, ['lateral']],
	] as const) {
		it(`nested alternatives honour options ${JSON.stringify(extra)}`, () => {
			const report = plan(
				{
					type: 'select',
					from: 'users',
					include: [{ relation: 'posts', ...extra }],
				},
				fixture(),
				{
					dialectCapabilities: FULL_CAPS,
					defaultIncludeStrategy: 'where' in extra ? 'join' : 'json_agg',
				},
			);
			expect(
				report.decisions.find((d) => d.type === 'include-strategy')!
					.alternatives,
			).toEqual(expected);
		});
	}
	for (const strategy of ['join', 'lateral', 'json_agg'] as const) {
		it(`nested ${strategy} chain has no independently substitutable alternatives`, () => {
			const report = plan(
				{
					type: 'select',
					from: 'users',
					include: [{ relation: 'posts', include: [{ relation: 'comments' }] }],
				},
				fixture(),
				{ dialectCapabilities: FULL_CAPS, defaultIncludeStrategy: strategy },
			);
			for (const decision of report.decisions.filter(
				(d) => d.type === 'include-strategy',
			))
				expect(decision.alternatives).toEqual([]);
		});
	}
	it('flat capability refusal excludes nested strategies even when CTE is supported', () => {
		expect(() =>
			resolve(
				'auto',
				'lateral',
				{},
				{ ...FULL_CAPS, supportsLateralJoin: false },
			),
		).toThrow(
			new UnsupportedStrategyError(
				`Flat output for relation 'posts' requires a dialect with supportsLateralJoin; current dialect (${FULL_CAPS.name}) does not support it. Accepted strategies for flat output: 'join', 'lateral'.`,
			),
		);
	});

	for (const [hint, fallback, extra, expected, source] of [
		['auto', 'auto', {}, 'join', 'flat output'],
		['auto', 'auto', { limit: 0 }, 'lateral', 'per-parent limit'],
		[
			'auto',
			'auto',
			{ include: [{ relation: 'comments', strategy: 'flat', limit: 2 }] },
			'lateral',
			'per-parent limit',
		],
		['lateral', 'join', {}, 'lateral', 'relation hint'],
	] as const) {
		it(`reports ${source} for ${hint}/${fallback}/${JSON.stringify(extra)}`, () => {
			const decision = resolve(hint, fallback, extra).decisions.find(
				(d) => d.type === 'include-strategy',
			)!;
			expect(decision.choice).toBe(expected);
			expect(decision.reasoning).toBe(
				`Relation users.posts (hasMany, cardinality: many) - using ${expected} selected by ${source}`,
			);
		});
	}
	it('reports nested output shape selection', () => {
		const decision = plan(
			{ type: 'select', from: 'users', include: [{ relation: 'posts' }] },
			fixture(),
			{ dialectCapabilities: FULL_CAPS },
		).decisions.find((d) => d.type === 'include-strategy')!;
		expect(decision.reasoning).toBe(
			'Relation users.posts (hasMany, cardinality: many) - using json_agg selected by nested output',
		);
	});
	it('flat alternatives respect dialect capabilities', () => {
		const decision = resolve('auto', 'auto', {}, NO_CTE_CAPS).decisions.find(
			(d) => d.type === 'include-strategy',
		)!;
		expect(decision.alternatives).toEqual([]);
	});
	it('flat explicit join with limit lists only flat accepted strategies', () => {
		expect(() =>
			resolve('auto', 'lateral', { join: 'left', limit: 2 }),
		).toThrow(
			new InvalidOperationError(
				'include',
				"Flat output for relation 'posts' cannot use 'join' selected by explicit join because the include or a nested include has a per-parent limit. Accepted strategies for flat output: 'join', 'lateral'; per-parent limits require 'lateral' with a dialect that supports lateral joins.",
			),
		);
	});
	for (const strategy of ['flat', 'auto'] as const) {
		it(`conflict reports the full nested include path on ${strategy}`, () => {
			const model = fixture('join');
			Object.assign(model.getRelation('posts.comments')!, {
				includeStrategy: 'lateral',
			});
			expect(() =>
				plan(
					{
						type: 'select',
						from: 'users',
						include: [
							{
								relation: 'posts',
								strategy,
								include: [{ relation: 'comments', strategy, join: 'left' }],
							},
						],
					},
					model,
					{ dialectCapabilities: FULL_CAPS },
				),
			).toThrow(
				new UnsupportedStrategyError(
					"Include at include[0].include[0](posts.comments) cannot use explicit join because relation 'comments' declares includeStrategy 'lateral'. Use 'auto' or 'join', or remove include.join.",
				),
			);
		});
	}
	const limited = [
		{ limit: 2 },
		{
			include: [{ relation: 'comments', strategy: 'flat' as const, limit: 2 }],
		},
	];
	function resolve(
		hint = 'auto',
		defaultIncludeStrategy:
			| 'auto'
			| 'join'
			| 'lateral'
			| 'json_agg'
			| 'cte' = 'auto',
		extra = {},
		dialectCapabilities = FULL_CAPS,
	) {
		return plan(
			{
				type: 'select',
				from: 'users',
				include: [{ relation: 'posts', strategy: 'flat', ...extra }],
			},
			fixture(hint),
			{ defaultIncludeStrategy, dialectCapabilities },
		);
	}
	function choices(report: ReturnType<typeof plan>) {
		return report.decisions
			.filter((d) => d.type === 'include-strategy')
			.map((d) => d.choice);
	}
	for (const [hint, fallback, expected] of [
		['join', 'lateral', 'join'],
		['lateral', 'join', 'lateral'],
	] as const) {
		it(`hint ${hint} beats default ${fallback}`, () =>
			expect(choices(resolve(hint, fallback))).toEqual([expected]));
	}
	for (const hint of ['json_agg', 'cte']) {
		it(`refuses ${hint} hint for flat output`, () =>
			expect(() => resolve(hint)).toThrow(
				new UnsupportedStrategyError(
					`Flat output for relation 'posts' cannot use relation includeStrategy hint '${hint}'. Use 'auto', 'join', or 'lateral'.`,
				),
			));
	}
	for (const [index, extra] of limited.entries()) {
		for (const source of [
			'relation includeStrategy hint',
			'defaultIncludeStrategy',
		]) {
			it(`refuses ${source} join with ${index === 0 ? 'direct' : 'nested'} limit`, () =>
				expect(() =>
					resolve(
						source === 'relation includeStrategy hint' ? 'join' : 'auto',
						source === 'defaultIncludeStrategy' ? 'join' : 'lateral',
						extra,
					),
				).toThrow(
					new InvalidOperationError(
						'include',
						`Flat output for relation 'posts' cannot use 'join' selected by ${source} because the include or a nested include has a per-parent limit. Accepted strategies for flat output: 'join', 'lateral'; per-parent limits require 'lateral' with a dialect that supports lateral joins.`,
					),
				));
		}
	}
	for (const fallback of ['join', 'lateral'] as const) {
		it(`honours ${fallback} default without limit`, () =>
			expect(choices(resolve('auto', fallback))).toEqual([fallback]));
	}
	for (const fallback of ['json_agg', 'cte', 'auto'] as const) {
		it(`skips ${fallback} default without limit`, () =>
			expect(choices(resolve('auto', fallback))).toEqual(['join']));
		it(`skips ${fallback} default with limit`, () =>
			expect(choices(resolve('auto', fallback, { limit: 2 }))).toEqual([
				'lateral',
			]));
	}
	for (const [hint, fallback, extra] of [
		['auto', 'auto', { limit: 2 }],
		['lateral', 'join', {}],
		['auto', 'lateral', {}],
	] as const) {
		it(`refuses required lateral without capability (${hint}/${fallback})`, () =>
			expect(() => resolve(hint, fallback, extra, NO_CTE_CAPS)).toThrow(
				new UnsupportedStrategyError(
					"Flat output for relation 'posts' requires a dialect with supportsLateralJoin; current dialect (test-no-cte) does not support it. Accepted strategies for flat output: 'join', 'lateral'.",
				),
			));
	}
	it('refuses a nested limit without lateral support', () =>
		expect(() => resolve('auto', 'auto', limited[1], NO_CTE_CAPS)).toThrow(
			new UnsupportedStrategyError(
				"Flat output for relation 'posts' requires a dialect with supportsLateralJoin; current dialect (test-no-cte) does not support it. Accepted strategies for flat output: 'join', 'lateral'.",
			),
		));
	it('skips json_agg default on a non-JSON dialect', () =>
		expect(choices(resolve('auto', 'json_agg', {}, NO_CTE_CAPS))).toEqual([
			'join',
		]));
	it('honours lateral default throughout nested flat chain', () =>
		expect(
			choices(
				resolve('auto', 'lateral', {
					include: [{ relation: 'comments', strategy: 'flat' }],
				}),
			),
		).toEqual(['lateral', 'lateral']));
	it('refuses a limit when no dialect capabilities are supplied', () => {
		expect(() =>
			plan(
				{
					type: 'select',
					from: 'users',
					include: [{ relation: 'posts', strategy: 'flat', limit: 0 }],
				},
				fixture(),
			),
		).toThrow(
			new UnsupportedStrategyError(
				"Flat output for relation 'posts' requires a dialect with supportsLateralJoin; current dialect (no capabilities) does not support it. Accepted strategies for flat output: 'join', 'lateral'.",
			),
		);
	});
	it('recursive stale hint uses recursive-specific accepted list', () => {
		const db = schema({
			categories: {
				id: { type: 'integer', primaryKey: true },
				parentId: ref('categories', {
					roles: { parent: 'parent', children: 'children' },
				}),
			},
		});
		Object.assign(db.model.getRelation('categories.children')!, {
			includeStrategy: 'subquery',
		});
		expect(() =>
			plan(
				{
					type: 'select',
					from: 'categories',
					include: [{ relation: 'children', recursive: {} }],
				},
				db.model,
				{ dialectCapabilities: FULL_CAPS },
			),
		).toThrow(
			new UnsupportedStrategyError(
				"Recursive include at include[0](children) requires strategy 'cte', but relation 'children' declares includeStrategy 'subquery'. Use 'auto' or 'cte'.",
			),
		);
	});
});
