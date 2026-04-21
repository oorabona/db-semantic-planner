/**
 * @fileoverview Proof tests for planner correctness fixes (Commit 2).
 *
 * Covers:
 * - FIND-012: NOT IN on nullable FK preserves NOT IN semantics (no NOT EXISTS rewrite)
 * - FIND-013: Recursive includes on dialect without supportsRecursiveCTE throw
 * - FIND-014: include.limit with join strategy throws InvalidOperationError
 * - FIND-015: Lenient ambiguity resolution is alphabetically deterministic
 *
 * Regression gate: each test is designed so removing the corresponding fix
 * would cause it to fail.
 */

import { describe, expect, it } from 'vitest';
import {
	createDialectCapabilities,
	POSTGRESQL_CAPABILITIES,
} from './dialects/index.js';
import { InvalidOperationError } from './dx/errors.js';
import { inSubquery, not } from './dx/filters.js';
import { createOrm } from './dx/index.js';
import { ref, schema } from './dx/schema.js';
import { subquery } from './dx/subquery-builder.js';
import { createMockAdapter } from './dx/test-utils.js';
import type { QueryIntent } from './index.js';
import { plan, UnsupportedStrategyError } from './planner.js';

// ============================================================================
// Dialect fixtures
// ============================================================================

/** Dialect that declares NO strategy support — forces auto → join */
const NO_CTE_CAPS = createDialectCapabilities({
	name: 'test-no-cte',
	identifierQuote: '"',
	parameterStyle: 'dollar',
	limitStyle: 'limit-offset',
	booleanStyle: 'boolean',
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

	it('recursive include with no dialectCapabilities (undefined) does not throw (backward compat)', () => {
		// Unknown dialect → assume CTE is supported (matches planner convention).
		const intent: QueryIntent = {
			type: 'select',
			from: 'categories',
			include: [{ relation: 'children', recursive: { maxDepth: 5 } }],
		};
		expect(() => plan(intent, categoriesSchema.model)).not.toThrow();
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
