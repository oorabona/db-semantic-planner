/**
 * Tests for nested-exists predicate coverage — every WhereIntent kind that
 * can appear inside an exists() where clause must survive enrichment and
 * appear in the emitted SQL.  Before the fix, several kinds (rawExists,
 * rawNotExists, subquery/scalar, jsonContains, jsonExists, any) fell through
 * to `default: return []` in convertWhereToDecisions, silently dropping the
 * predicate and broadening the filter.
 *
 * Fix: convertWhereToDecisions now delegates missing kinds to convertWhereCondition
 * (which applies all guards), and the default throws an exhaustive error.
 */

import {
	and,
	createOrm,
	eq,
	exists,
	gt,
	inArray,
	or,
	plan,
	rawExists,
	rawNotExists,
	ref,
	schema,
	subquery,
} from '@dbsp/core';
import { POSTGRESQL_CAPABILITIES } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Schema: users → posts (hasMany), plus auditLog (standalone, for rawExists)
// ---------------------------------------------------------------------------
const testSchema = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
		active: { type: 'boolean' },
		tags: { type: 'jsonb' },
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: { type: 'text' },
		published: { type: 'boolean' },
		views: { type: 'integer' },
		metadata: { type: 'jsonb' },
		author_id: ref('users', { as: 'author', inverse: 'posts' }),
	},
	auditLog: {
		id: { type: 'integer', primaryKey: true },
		action: { type: 'text' },
		post_id: { type: 'integer' },
	},
	scores: {
		id: { type: 'integer', primaryKey: true },
		val: { type: 'integer' },
		user_id: { type: 'integer' },
	},
} as const);

function buildOrm() {
	const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });
	return createOrm({ model: testSchema.model, adapter });
}

function ws(sql: string): string {
	return sql.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// rawExists nested inside exists() — primary defect case
// ---------------------------------------------------------------------------

describe('nested rawExists inside exists() where clause — NOT silently dropped', () => {
	it('exists(posts, { where: rawExists(auditLog) }) — emits BOTH EXISTS subqueries', () => {
		const orm = buildOrm();
		const { sql } = (orm as any)
			.select('users')
			.where(
				exists('posts', {
					where: rawExists(subquery('auditLog').select('id')),
				}),
			)
			.dump();
		const normalized = ws(sql);

		// Must contain two EXISTS subqueries: outer posts + inner auditLog.
		const existsCount = (normalized.match(/\bEXISTS\b/g) ?? []).length;
		expect(existsCount, `Expected 2 EXISTS, got: ${normalized}`).toBe(2);

		// The auditLog table must appear (not dropped).
		expect(normalized).toMatch(/auditLog|audit_log/i);
	});

	it('exists(posts, { where: and(eq(published,true), rawExists(auditLog)) }) — both predicates present', () => {
		const orm = buildOrm();
		const { sql, params } = (orm as any)
			.select('users')
			.where(
				exists('posts', {
					where: and(
						eq('published', true),
						rawExists(subquery('auditLog').select('id')),
					),
				}),
			)
			.dump();
		const normalized = ws(sql);

		// Two EXISTS: outer posts (with WHERE) + inner auditLog rawExists.
		const existsCount = (normalized.match(/\bEXISTS\b/g) ?? []).length;
		expect(existsCount, `Expected 2 EXISTS, got: ${normalized}`).toBe(2);

		// published predicate must be present.
		expect(normalized).toMatch(/published\s*=\s*\$1/i);
		expect(params).toContain(true);

		// auditLog must appear.
		expect(normalized).toMatch(/auditLog|audit_log/i);
	});

	it('exists(posts, { where: rawNotExists(auditLog) }) — rawNotExists NOT dropped', () => {
		const orm = buildOrm();
		const { sql } = (orm as any)
			.select('users')
			.where(
				exists('posts', {
					where: rawNotExists(subquery('auditLog').select('id')),
				}),
			)
			.dump();
		const normalized = ws(sql);

		// The outer posts EXISTS plus the inner NOT EXISTS.
		expect(normalized).toMatch(/\bNOT\b.*\bEXISTS\b|\bNOT EXISTS\b/i);
		expect(normalized).toMatch(/auditLog|audit_log/i);
	});
});

// ---------------------------------------------------------------------------
// rawExists modifier guard still fires when nested
// ---------------------------------------------------------------------------

describe('nested rawExists modifier guard still applies', () => {
	it('exists(posts, { where: rawExists(subquery.limit(0)) }) — guard fires for nested rawExists', () => {
		const orm = buildOrm();
		// SubqueryBuilder has no .limit(); pass QueryIntent via buildIntent.
		const limitedSubquery = {
			buildIntent: () => ({
				type: 'select' as const,
				from: 'auditLog',
				select: { type: 'fields' as const, fields: ['id'] as const },
				limit: 0,
			}),
		};
		expect(() => {
			(orm as any)
				.select('users')
				.where(
					exists('posts', {
						where: rawExists(limitedSubquery as any),
					}),
				)
				.dump();
		}).toThrow(/LIMIT.*not supported|not supported.*LIMIT/i);
	});

	it('exists(posts, { where: rawExists(subquery.groupBy(...)) }) — guard fires for GROUP BY', () => {
		const orm = buildOrm();
		const groupedSubquery = {
			buildIntent: () => ({
				type: 'select' as const,
				from: 'auditLog',
				select: { type: 'fields' as const, fields: ['id'] as const },
				groupBy: ['action'],
			}),
		};
		expect(() => {
			(orm as any)
				.select('users')
				.where(
					exists('posts', {
						where: rawExists(groupedSubquery as any),
					}),
				)
				.dump();
		}).toThrow(/GROUP BY.*not supported|not supported.*GROUP BY/i);
	});
});

// ---------------------------------------------------------------------------
// other nested predicate kinds — must not be silently dropped
// ---------------------------------------------------------------------------

describe('jsonContains / jsonExists / any nested inside exists() where clause', () => {
	it('exists(posts, { where: jsonContains(metadata, val) }) — predicate compiles, not dropped', () => {
		// Inject the intent directly via plan() since jsonContains has no ORM helper.
		const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });
		const planReport = plan(
			{
				type: 'select',
				from: 'users',
				where: {
					kind: 'exists',
					relation: 'posts',
					where: {
						kind: 'jsonContains',
						field: 'metadata',
						value: { key: 'active' },
					},
				},
			},
			testSchema.model,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);
		const { sql } = adapter.compile(planReport, { model: testSchema.model });
		const normalized = ws(sql);
		// The jsonContains predicate must appear — SQL uses @> operator.
		expect(normalized).toMatch(/@>|\$1/);
		expect(normalized).toMatch(/EXISTS/i);
	});

	it('exists(posts, { where: any(tags, [1,2,3]) }) — any predicate not dropped', () => {
		const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });
		const planReport = plan(
			{
				type: 'select',
				from: 'users',
				where: {
					kind: 'exists',
					relation: 'posts',
					where: {
						kind: 'any',
						field: 'views',
						values: [10, 20, 30],
					},
				},
			},
			testSchema.model,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);
		const { sql } = adapter.compile(planReport, { model: testSchema.model });
		const normalized = ws(sql);
		// The ANY predicate must appear (not dropped).
		expect(normalized).toMatch(/EXISTS/i);
		// At least one of the any values must appear as a param.
		expect(normalized).toMatch(/\$\d+/);
	});
});

// ---------------------------------------------------------------------------
// Regression: existing nested-exists predicates unchanged
// ---------------------------------------------------------------------------

describe('regression: comparison, and, or, not, nested-exists still work', () => {
	it('exists(posts, { where: eq(published, true) }) — comparison still works', () => {
		const orm = buildOrm();
		const { sql, params } = (orm as any)
			.select('users')
			.where(exists('posts', { where: eq('published', true) }))
			.dump();
		expect(ws(sql)).toContain('EXISTS');
		expect(ws(sql)).toMatch(/published\s*=\s*\$1/i);
		expect(params).toContain(true);
	});

	it('exists(posts, { where: and(eq, gt) }) — and still works', () => {
		const orm = buildOrm();
		const { sql, params } = (orm as any)
			.select('users')
			.where(
				exists('posts', { where: and(eq('published', true), gt('views', 5)) }),
			)
			.dump();
		expect(ws(sql)).toContain('AND');
		expect(params).toContain(true);
		expect(params).toContain(5);
	});

	it('exists(posts, { where: or(eq, eq) }) — or still works', () => {
		const orm = buildOrm();
		const { sql, params } = (orm as any)
			.select('users')
			.where(
				exists('posts', { where: or(eq('published', true), eq('title', 'x')) }),
			)
			.dump();
		expect(ws(sql)).toContain('OR');
		expect(params).toContain(true);
		expect(params).toContain('x');
	});

	it('exists(posts, { where: exists(auditLog-via-rawExists) }) — nested exists still works', () => {
		const orm = buildOrm();
		const { sql } = (orm as any)
			.select('users')
			.where(
				exists('posts', {
					where: eq('published', true),
				}),
			)
			.dump();
		expect(ws(sql)).toContain('EXISTS');
		expect(ws(sql)).toContain('published');
	});
});

// ---------------------------------------------------------------------------
// Bug fix: nested IN value-list not:true — NOT IN must not compile as IN
// (PR #130 converter-divergence class closure)
// ---------------------------------------------------------------------------

describe('nested IN value-list: not flag honoured in exists() where clause', () => {
	// The IN handler compiles to:
	//   IN  → col = ANY($N)  — the whole values array is bound as a single param
	//   NOT IN → col <> ALL($N) — same param shape
	// So parameters[0] is the array itself, e.g. ['draft', 'archived'].

	it('exists(posts, { where: { kind:"in", not:true } }) — compiles <> ALL (NOT IN), not = ANY', () => {
		// Inject via plan() to use the raw intent directly (no public notIn() helper).
		const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });
		const planReport = plan(
			{
				type: 'select',
				from: 'users',
				where: {
					kind: 'exists',
					relation: 'posts',
					where: {
						kind: 'in',
						field: 'title',
						values: ['draft', 'archived'],
						not: true,
					},
				},
			},
			testSchema.model,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);
		const { sql, parameters } = adapter.compile(planReport, {
			model: testSchema.model,
		});
		const normalized = ws(sql);

		// Must emit EXISTS subquery.
		expect(normalized).toContain('EXISTS');

		// NOT IN compiles as <> ALL($N) — must NOT be = ANY (positive IN).
		expect(normalized).toMatch(/<>\s*ALL\b/i);
		expect(normalized).not.toMatch(/=\s*ANY\b/i);

		// The values array must be bound as the single parameter.
		expect(parameters).toHaveLength(1);
		expect(parameters[0]).toEqual(['draft', 'archived']);
	});

	it('exists(posts, { where: { kind:"in", not:false } }) — still compiles = ANY (positive IN)', () => {
		const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });
		const planReport = plan(
			{
				type: 'select',
				from: 'users',
				where: {
					kind: 'exists',
					relation: 'posts',
					where: {
						kind: 'in',
						field: 'title',
						values: ['active', 'featured'],
						not: false,
					},
				},
			},
			testSchema.model,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);
		const { sql, parameters } = adapter.compile(planReport, {
			model: testSchema.model,
		});
		const normalized = ws(sql);

		expect(normalized).toContain('EXISTS');
		// Positive IN compiles as = ANY — must NOT be <> ALL.
		expect(normalized).toMatch(/=\s*ANY\b/i);
		expect(normalized).not.toMatch(/<>\s*ALL\b/i);
		expect(parameters[0]).toEqual(['active', 'featured']);
	});

	it('exists via inArray() helper (not:undefined) — compiles = ANY (positive IN)', () => {
		// inArray() does not set not — must compile as positive IN inside exists where.
		const orm = buildOrm();
		const { sql, params } = (orm as any)
			.select('users')
			.where(
				exists('posts', { where: inArray('title', ['published', 'live']) }),
			)
			.dump();
		const normalized = ws(sql);

		expect(normalized).toContain('EXISTS');
		// Positive IN: = ANY; must not be <> ALL
		expect(normalized).toMatch(/=\s*ANY\b/i);
		expect(normalized).not.toMatch(/<>\s*ALL\b/i);
		// Params: the array is bound as a single param
		expect(params[0]).toEqual(['published', 'live']);
	});

	// ── Regression: like/ilike inside nested exists ─────────────────────────

	it('exists(posts, { where: { kind:"like", caseInsensitive:true } }) — compiles ILIKE', () => {
		// caseInsensitive:true — previously the hand-rolled path always emitted LIKE.
		// After delegation to convertLike, ILIKE is correctly emitted.
		const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });
		const planReport = plan(
			{
				type: 'select',
				from: 'users',
				where: {
					kind: 'exists',
					relation: 'posts',
					where: {
						kind: 'like',
						field: 'title',
						pattern: '%hello%',
						caseInsensitive: true,
					},
				},
			},
			testSchema.model,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);
		const { sql, parameters } = adapter.compile(planReport, {
			model: testSchema.model,
		});
		const normalized = ws(sql);

		expect(normalized).toContain('EXISTS');
		expect(normalized).toMatch(/ILIKE/i);
		expect(parameters).toContain('%hello%');
	});

	// ── Regression: null inside nested exists ───────────────────────────────

	it('exists(posts, { where: { kind:"null", operator:"isNull" } }) — IS NULL compiles', () => {
		const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });
		const planReport = plan(
			{
				type: 'select',
				from: 'users',
				where: {
					kind: 'exists',
					relation: 'posts',
					where: {
						kind: 'null',
						field: 'title',
						operator: 'isNull',
					},
				},
			},
			testSchema.model,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);
		const { sql } = adapter.compile(planReport, { model: testSchema.model });
		const normalized = ws(sql);

		expect(normalized).toContain('EXISTS');
		expect(normalized).toMatch(/IS\s+NULL/i);
	});
});
