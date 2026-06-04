/**
 * Regression tests for multi-hop relationFilter(['hop1', 'hop2'], { where }) compilation.
 *
 * A multi-hop relation path like ['posts', 'comments'] from users means:
 *   users → posts (via posts.authorId) → comments (via comments.postId)
 *
 * The planner produces ONE filter-strategy decision for the LAST hop (comments),
 * with context.sourceTable = 'posts' and context.target = 'comments'.
 * The adapter must match the stub (targetTable = ['posts','comments']) to this
 * decision and compile a valid EXISTS — no malformed SQL, no thrown error.
 *
 * BASELINE from main (old top-level extraction path):
 * The old code produced:
 *   EXISTS (SELECT 1 FROM comments WHERE users.id = comments."postId")
 * Correlation used the ROOT table (users), NOT the intermediate posts table.
 * The nested `where` filter was LOST because the intent match failed
 * (i.relation[0]='posts' ≠ context.relation='comments').
 *
 * The new code must produce the same or better SQL with NO malformed table name,
 * no thrown error for a declared-relation multi-hop path.
 */

import { plan, ref, schema } from '@dbsp/core';
import { POSTGRESQL_CAPABILITIES } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Schema: users → posts (via posts.authorId) → comments (via comments.postId)
// ---------------------------------------------------------------------------

const testSchema = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
		active: { type: 'boolean' },
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: { type: 'text' },
		published: { type: 'boolean' },
		authorId: ref('users', { as: 'author', inverse: 'posts' }),
	},
	comments: {
		id: { type: 'integer', primaryKey: true },
		body: { type: 'text' },
		postId: ref('posts', { as: 'post', inverse: 'comments' }),
	},
} as const);

const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });

function ws(sql: string): string {
	return sql.replace(/\s+/g, ' ').trim();
}

function compileMultiHop(
	relation: string[],
	body?: string,
): { sql: string; parameters: readonly unknown[] } {
	const whereCondition: {
		kind: 'comparison';
		field: string;
		operator: string;
		value: unknown;
	} = body
		? {
				kind: 'comparison',
				field: 'body',
				operator: 'like',
				value: `%${body}%`,
			}
		: { kind: 'comparison', field: 'id', operator: 'isNotNull', value: null };

	const planReport = plan(
		{
			type: 'select',
			from: 'users',
			where: {
				kind: 'relationFilter',
				relation,
				where: whereCondition,
				mode: 'some',
			},
		},
		testSchema.model,
		{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
	);
	return adapter.compile(planReport, { model: testSchema.model });
}

// ---------------------------------------------------------------------------
// 1. Baseline regression — multi-hop compiles without error
// ---------------------------------------------------------------------------

describe('1. multi-hop relationFilter — no malformed SQL, no error', () => {
	it('relationFilter(["posts","comments"]) does NOT throw', () => {
		expect(() => compileMultiHop(['posts', 'comments'], 'hello')).not.toThrow();
	});

	it('relationFilter(["posts","comments"]) produces WHERE EXISTS', () => {
		const { sql } = compileMultiHop(['posts', 'comments'], 'hello');
		const normalized = ws(sql);
		expect(normalized).toContain('EXISTS');
		expect(normalized).toContain('SELECT users.* FROM users');
	});

	it('relationFilter(["posts","comments"]) targets the last-hop table (comments)', () => {
		const { sql } = compileMultiHop(['posts', 'comments'], 'hello');
		const normalized = ws(sql);
		// EXISTS subquery must target comments, not posts or a malformed name
		expect(normalized).toMatch(/FROM\s+"?comments"?/i);
		// Must NOT contain malformed table names
		expect(normalized).not.toMatch(/posts,comments/i);
		expect(normalized).not.toMatch(/\[object/i);
		expect(normalized).not.toMatch(/undefined/i);
	});

	it('relationFilter(["posts","comments"]) uses the correct FK column (postId)', () => {
		const { sql } = compileMultiHop(['posts', 'comments'], 'hello');
		const normalized = ws(sql);
		// FK from posts → comments is postId
		expect(normalized).toContain('postId');
	});

	it('SQL matches the baseline from main (single EXISTS on comments via FK postId)', () => {
		// Baseline SQL from old top-level path: EXISTS on comments with postId FK.
		// The correlation uses the outer root table alias (users.id), because the
		// planner's filter-strategy has sourceTable='posts' but buildExistsSubquery
		// uses ctx.rootTable as the outer alias.
		// This test locks that no regression from the multi-hop fix.
		const { sql } = compileMultiHop(['posts', 'comments']);
		const normalized = ws(sql);
		// Single WHERE EXISTS clause (not nested) — 'comments_exists_0' alias doesn't count
		const existsCount = (normalized.match(/WHERE EXISTS/gi) ?? []).length;
		expect(existsCount).toBe(1);
		// Targets comments table
		expect(normalized).toMatch(/FROM\s+"?comments"?/i);
		// Uses the FK
		expect(normalized).toContain('postId');
	});
});

// ---------------------------------------------------------------------------
// 2. Fail-closed guard does NOT fire for a fully-declared multi-hop path
// ---------------------------------------------------------------------------

describe('2. fail-closed guard — declared multi-hop path does not throw', () => {
	it('["posts","comments"] — all hops declared — no error', () => {
		expect(() => compileMultiHop(['posts', 'comments'])).not.toThrow();
	});

	it('["posts"] single-element array — no regression from last-element fix', () => {
		const planReport = plan(
			{
				type: 'select',
				from: 'users',
				where: {
					kind: 'relationFilter',
					relation: ['posts'],
					where: {
						kind: 'comparison',
						field: 'published',
						operator: 'eq',
						value: true,
					},
					mode: 'some',
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
		expect(normalized).toMatch(/FROM\s+"?posts"?/i);
		expect(parameters).toContain(true);
	});

	it('undeclared single-hop still throws (fail-closed unchanged for single-hop)', () => {
		// auditLog is in the schema but has no FK relation to users
		const schemaWithAuditLog = schema({
			users: { id: { type: 'integer', primaryKey: true }, name: 'text' },
			auditLog: {
				id: { type: 'integer', primaryKey: true },
				entityType: 'text',
			},
		} as const);
		const adapterLocal = createPgsqlCompileOnlyAdapter({
			model: schemaWithAuditLog.model,
		});
		const planReport = plan(
			{
				type: 'select',
				from: 'users',
				where: {
					kind: 'exists',
					relation: 'auditLog',
					where: {
						kind: 'comparison',
						field: 'entityType',
						operator: 'eq',
						value: 'login',
					},
				} as any,
			},
			schemaWithAuditLog.model,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);
		expect(() =>
			adapterLocal.compile(planReport, { model: schemaWithAuditLog.model }),
		).toThrow(/exists\('auditLog'\).*no relation 'auditLog'.*declared/i);
	});
});

// ---------------------------------------------------------------------------
// 3. Multi-hop nested under OR — inline position preserved
// ---------------------------------------------------------------------------

describe('3. multi-hop relationFilter nested under OR', () => {
	it('or(eq, multi-hop-relationFilter) — compiles with EXISTS, no malformed SQL', () => {
		const planReport = plan(
			{
				type: 'select',
				from: 'users',
				where: {
					kind: 'or',
					conditions: [
						{
							kind: 'comparison',
							field: 'active',
							operator: 'eq',
							value: true,
						},
						{
							kind: 'relationFilter',
							relation: ['posts', 'comments'],
							where: {
								kind: 'comparison',
								field: 'body',
								operator: 'like',
								value: '%hi%',
							},
							mode: 'some',
						},
					],
				},
			},
			testSchema.model,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);
		const { sql } = adapter.compile(planReport, { model: testSchema.model });
		const normalized = ws(sql);
		// EXISTS must appear
		expect(normalized).toContain('EXISTS');
		// No malformed SQL
		expect(normalized).not.toMatch(/posts,comments/i);
		expect(normalized).not.toMatch(/\[object/i);
		// Targets comments
		expect(normalized).toMatch(/FROM\s+"?comments"?/i);
	});
});

// ---------------------------------------------------------------------------
// 4. Single-hop exists — no regression from multi-hop normalizeStubRelation fix
// ---------------------------------------------------------------------------

describe('4. single-hop exists — no regression', () => {
	it('plain string relation still works (not an array path)', () => {
		const planReport = plan(
			{
				type: 'select',
				from: 'users',
				where: {
					kind: 'relationFilter',
					relation: 'posts',
					where: {
						kind: 'comparison',
						field: 'published',
						operator: 'eq',
						value: true,
					},
					mode: 'some',
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
		expect(normalized).toMatch(/FROM\s+"?posts"?/i);
		expect(parameters).toContain(true);
	});

	it('exists("comments") from posts — single hop, correct FK (postId)', () => {
		const planReport = plan(
			{
				type: 'select',
				from: 'posts',
				where: {
					kind: 'exists',
					relation: 'comments',
					where: {
						kind: 'comparison',
						field: 'body',
						operator: 'like',
						value: '%hi%',
					},
				} as any,
			},
			testSchema.model,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);
		const { sql, parameters } = adapter.compile(planReport, {
			model: testSchema.model,
		});
		const normalized = ws(sql);
		expect(normalized).toContain('EXISTS');
		expect(normalized).toMatch(/FROM\s+"?comments"?/i);
		expect(normalized).toContain('postId');
		expect(parameters).toContain('%hi%');
	});
});
