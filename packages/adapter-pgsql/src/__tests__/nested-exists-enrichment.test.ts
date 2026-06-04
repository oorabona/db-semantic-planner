/**
 * Tests for nested exists enrichment — exists() whose where clause itself contains
 * another exists().  Three defects addressed:
 *
 * (1) Nested exists emitted twice: the filter-strategy loop appended an extra
 *     top-level AND EXISTS for the inner relation because no matching stub was found
 *     in the top-level stubs array.  Fixed by skipping append when the target is
 *     a known nested-exists relation.
 *
 * (2) Fail-closed for undeclared nested relations: enrichExistsStubsInConditions
 *     previously convention-compiled an undeclared inner relation; now throws.
 *
 * (3) outerRef rejection on the direct compile-where path (compileWhereIntent /
 *     handleRawExistsIntent).  The decisions path already rejected this; the direct
 *     path now matches.
 */

import {
	and,
	createOrm,
	eq,
	exists,
	or,
	outerRef,
	plan,
	rawExists,
	ref,
	schema,
	subquery,
} from '@dbsp/core';
import { POSTGRESQL_CAPABILITIES } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import {
	buildSubqueryFromIntent,
	compileWhereIntent,
	type WhereCompilerCtx,
} from '../compile-where.js';
import { createCompilerState } from '../handlers/types.js';
import { identityNaming } from '../naming-plugin.js';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Schema: users → posts (hasMany via posts.author_id)
//                posts → comments (hasMany via comments.post_id)
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
		author_id: ref('users', { as: 'author', inverse: 'posts' }),
	},
	comments: {
		id: { type: 'integer', primaryKey: true },
		body: { type: 'text' },
		post_id: ref('posts', { as: 'post', inverse: 'comments' }),
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
// Defect 1 — nested exists emitted exactly once (not twice)
// ---------------------------------------------------------------------------

describe('nested exists — correct EXISTS count and structure', () => {
	it('exists(posts, { where: exists(comments, { where: eq(body,x) }) }) → exactly 2 EXISTS, correct correlations', () => {
		const orm = buildOrm();
		const { sql, params } = (orm as any)
			.select('users')
			.where(
				exists('posts', {
					where: exists('comments', { where: eq('body', 'x') }),
				}),
			)
			.dump();
		const normalized = ws(sql);

		// Count the number of EXISTS occurrences — must be exactly 2.
		const existsMatches = normalized.match(/\bEXISTS\b/g);
		expect(
			existsMatches?.length,
			`Expected exactly 2 EXISTS, got: ${normalized}`,
		).toBe(2);

		// Outer correlation: users.id = posts_exists_N.author_id
		expect(normalized).toMatch(/users\.id\s*=\s*posts_exists_\d+\.author_id/);

		// Inner correlation: posts_exists_N.id = comments_exists_M.post_id
		expect(normalized).toMatch(
			/posts_exists_\d+\.id\s*=\s*comments_exists_\d+\.post_id/,
		);

		// Inner filter: comments alias has body = $1
		expect(normalized).toMatch(/comments_exists_\d+\.body\s*=\s*\$1/);

		// Must NOT have a third AND EXISTS at the root — that would be the double-emit.
		// The SQL structure is: WHERE EXISTS (posts ... AND EXISTS (comments ...))
		// with exactly one top-level WHERE clause, no extra root-level AND EXISTS.
		// Use the FIRST WHERE occurrence to check the root predicate starts with EXISTS.
		const firstWhereMatch = normalized.match(/WHERE\s+(EXISTS\b)/i);
		expect(
			firstWhereMatch,
			`Expected outermost WHERE to start with EXISTS, got: ${normalized}`,
		).not.toBeNull();

		expect(params).toEqual(['x']);
	});

	it('nested exists under OR — no extra top-level AND EXISTS', () => {
		const orm = buildOrm();
		const { sql, params } = (orm as any)
			.select('users')
			.where(
				or(
					eq('active', true),
					exists('posts', {
						where: exists('comments', { where: eq('body', 'hello') }),
					}),
				),
			)
			.dump();
		const normalized = ws(sql);

		// Exactly 2 EXISTS in the output.
		const existsMatches = normalized.match(/\bEXISTS\b/g);
		expect(
			existsMatches?.length,
			`Expected exactly 2 EXISTS, got: ${normalized}`,
		).toBe(2);

		// The top-level boolean operator is OR, not AND.
		expect(normalized).toMatch(/WHERE.*active.*OR.*EXISTS/i);

		// Must NOT have a third bare AND EXISTS appended at root level.
		// Pattern: "... OR EXISTS (...) AND EXISTS (...)" would indicate double-emit.
		expect(normalized).not.toMatch(
			/OR\s+EXISTS\s*\(.*\)\s+AND\s+EXISTS\s*\(/is,
		);

		expect(params).toEqual([true, 'hello']);
	});

	it('nested exists under AND — both filters present, no duplication', () => {
		const orm = buildOrm();
		const { sql, params } = (orm as any)
			.select('users')
			.where(
				and(
					eq('active', true),
					exists('posts', {
						where: exists('comments', { where: eq('body', 'hi') }),
					}),
				),
			)
			.dump();
		const normalized = ws(sql);

		const existsMatches = normalized.match(/\bEXISTS\b/g);
		expect(
			existsMatches?.length,
			`Expected exactly 2 EXISTS, got: ${normalized}`,
		).toBe(2);

		// The outer exists is AND-ed with the active filter (either order is fine).
		expect(normalized).toMatch(/active/i);
		expect(normalized).toMatch(/EXISTS/i);
		expect(params).toEqual([true, 'hi']);
	});
});

// ---------------------------------------------------------------------------
// Defect 2 — fail-closed: undeclared inner relation must throw
// ---------------------------------------------------------------------------

describe('nested exists — fail-closed for undeclared inner relation', () => {
	it('exists(posts, { where: exists(undeclaredRelation) }) → throws clear error', () => {
		const orm = buildOrm();
		expect(() => {
			(orm as any)
				.select('users')
				.where(
					exists('posts', {
						where: (exists as any)('unknownRelation', {}),
					}),
				)
				.dump();
		}).toThrow(/no relation 'unknownRelation' is declared on table 'posts'/i);
	});

	it('top-level exists with undeclared relation still throws (regression guard)', () => {
		const orm = buildOrm();
		expect(() => {
			(orm as any)
				.select('users')
				.where((exists as any)('noSuchTable', {}))
				.dump();
		}).toThrow(/no relation 'noSuchTable'.*declared/i);
	});
});

// ---------------------------------------------------------------------------
// Defect 3 — rawExists + outerRef on the direct compileWhereIntent path
// ---------------------------------------------------------------------------

describe('rawExists + outerRef on direct compileWhereIntent path', () => {
	function makeRealCtx(): WhereCompilerCtx {
		const paramState = createCompilerState();
		return {
			rootTable: 'users',
			aliases: new Map(),
			paramState,
			naming: identityNaming,
			compileSubquery: (subIntent, paramOffset) =>
				buildSubqueryFromIntent(subIntent, paramOffset, identityNaming),
		};
	}

	it('rawExists(subquery with outerRef) on direct path → throws', () => {
		const intent = {
			kind: 'rawExists' as const,
			subquery: {
				type: 'select' as const,
				from: 'posts',
				select: { type: 'fields' as const, fields: ['id'] as const },
				where: {
					kind: 'comparison',
					field: 'author_id',
					operator: 'eq',
					value: outerRef('id'),
				},
			},
		};
		const ctx = makeRealCtx();
		expect(() => compileWhereIntent(intent as any, ctx)).toThrow(
			/correlated subqueries.*not yet supported/i,
		);
	});

	it('rawNotExists(subquery with outerRef) on direct path → throws', () => {
		const intent = {
			kind: 'rawNotExists' as const,
			subquery: {
				type: 'select' as const,
				from: 'posts',
				select: { type: 'fields' as const, fields: ['id'] as const },
				where: {
					kind: 'comparison',
					field: 'author_id',
					operator: 'eq',
					value: outerRef('id'),
				},
			},
		};
		const ctx = makeRealCtx();
		expect(() => compileWhereIntent(intent as any, ctx)).toThrow(
			/correlated subqueries.*not yet supported/i,
		);
	});

	it('rawExists without outerRef on direct path → does NOT throw', () => {
		const ctx = makeRealCtx();
		const safeIntent = {
			kind: 'rawExists' as const,
			subquery: {
				type: 'select' as const,
				from: 'posts',
				select: { type: 'fields' as const, fields: ['id'] as const },
				where: {
					kind: 'comparison',
					field: 'published',
					operator: 'eq',
					value: true,
				},
			},
		};
		expect(() => compileWhereIntent(safeIntent as any, ctx)).not.toThrow();
	});

	it('rawExists + outerRef on ORM path (decisions path) → still throws', () => {
		const orm = buildOrm();
		const correlated = rawExists(
			subquery('posts')
				.select('id')
				.where(eq('author_id', outerRef('id') as any)),
		);
		expect(() => {
			(orm as any).select('users').where(correlated).dump();
		}).toThrow(/correlated subqueries.*not yet supported/i);
	});
});

// ---------------------------------------------------------------------------
// Regression guard — single-level exists must compile unchanged
// ---------------------------------------------------------------------------

describe('regression: single-level exists unchanged', () => {
	it('exists(posts) at top level — correct SQL (regression lock)', () => {
		const orm = buildOrm();
		const { sql, params } = (orm as any)
			.select('users')
			.where(exists('posts', { where: eq('published', true) }))
			.dump();
		expect(ws(sql)).toEqual(
			'SELECT users.* FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.author_id AND posts_exists_0.published = $1)',
		);
		expect(params).toEqual([true]);
	});

	it('or(eq, exists(posts)) — exists stays in OR branch', () => {
		const orm = buildOrm();
		const { sql, params } = (orm as any)
			.select('users')
			.where(or(eq('name', 'Alice'), exists('posts')))
			.dump();
		expect(ws(sql)).toEqual(
			'SELECT users.* FROM users WHERE users.name = $1 OR EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.author_id)',
		);
		expect(params).toEqual(['Alice']);
	});
});

// ---------------------------------------------------------------------------
// Defect 1 identity drift — relation alias != resolved table name
// ---------------------------------------------------------------------------

describe('nested exists — relation alias != table name (identity drift)', () => {
	// posts.author_id = ref('users', { as: 'author', inverse: 'posts' })
	// From posts: relation name 'author', resolved target = 'users'.
	// filter-strategy context.target = 'users', context.relation = 'author'.
	// collectNestedExistsTargets must store 'users' (resolved), not 'author' (alias).
	it('exists(posts, { where: exists(author) }) — no duplicate EXISTS (alias != table)', () => {
		const orm = buildOrm();
		// 'author' is the relation alias on posts → users (belongsTo).
		const { sql, params } = (orm as any)
			.select('users')
			.where(
				exists('posts', {
					where: (exists as any)('author', { where: eq('name', 'Bob') }),
				}),
			)
			.dump();
		const normalized = ws(sql);

		// Exactly 2 EXISTS — outer (posts) + inner (author → users).
		const existsMatches = normalized.match(/\bEXISTS\b/g);
		expect(
			existsMatches?.length,
			`Expected exactly 2 EXISTS, got: ${normalized}`,
		).toBe(2);

		// Inner existence resolved to users table, not appended as a third EXISTS.
		expect(normalized).toContain('users');
		expect(params).toEqual(['Bob']);
	});

	it('nested exists alias under OR — no spurious top-level AND EXISTS', () => {
		const orm = buildOrm();
		const { sql, params } = (orm as any)
			.select('users')
			.where(
				or(
					eq('active', true),
					exists('posts', {
						where: (exists as any)('author', { where: eq('name', 'Carol') }),
					}),
				),
			)
			.dump();
		const normalized = ws(sql);

		const existsMatches = normalized.match(/\bEXISTS\b/g);
		expect(
			existsMatches?.length,
			`Expected exactly 2 EXISTS, got: ${normalized}`,
		).toBe(2);

		// Top-level boolean is OR — not contaminated by a spurious AND EXISTS.
		expect(normalized).toMatch(/WHERE.*OR.*EXISTS/i);
		expect(params).toEqual([true, 'Carol']);
	});
});

// ---------------------------------------------------------------------------
// Defect 2 — nested string[] relationFilter inside exists (array form of relation)
// ---------------------------------------------------------------------------

describe('nested exists — string[] relationFilter inside outer exists', () => {
	// Simulate what NQL produces: a nested relationFilter with relation as string[]
	// (even single-element arrays).  enrichExistsStubsInConditions must walk each
	// hop from the correct source table, not coerce the array to a mis-resolved string.

	it('exists(posts) wrapping inner relationFilter(["comments"]) — no error, exactly 2 EXISTS', () => {
		const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });
		const planReport = plan(
			{
				type: 'select',
				from: 'users',
				where: {
					kind: 'exists',
					relation: 'posts',
					where: {
						kind: 'relationFilter',
						// Single-element string[] — NQL's canonical form for a single hop.
						relation: ['comments'] as unknown as string,
						where: {
							kind: 'comparison',
							field: 'body',
							operator: 'eq',
							value: 'hi',
						},
						mode: 'some',
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

		const existsMatches = normalized.match(/\bEXISTS\b/g);
		expect(
			existsMatches?.length,
			`Expected exactly 2 EXISTS, got: ${normalized}`,
		).toBe(2);

		// Inner EXISTS targets comments table.
		expect(normalized).toMatch(/FROM\s+"?comments"?\s+AS/i);
		// Inner filter present.
		expect(normalized).toMatch(/body\s*=\s*\$1/i);
		expect(parameters).toContain('hi');
	});

	it('exists(posts) wrapping inner relationFilter(["comments"], mode=every) — no throw', () => {
		const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });
		const planReport = plan(
			{
				type: 'select',
				from: 'users',
				where: {
					kind: 'exists',
					relation: 'posts',
					where: {
						kind: 'relationFilter',
						relation: ['comments'] as unknown as string,
						where: {
							kind: 'comparison',
							field: 'body',
							operator: 'eq',
							value: 'bad',
						},
						mode: 'every',
					},
				},
			},
			testSchema.model,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);
		// mode='every' produces a NOT-wrapped inner condition — must not throw.
		expect(() =>
			adapter.compile(planReport, { model: testSchema.model }),
		).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Defect 3 — scalar subquery modifier guard on direct compileWhereIntent path
// ---------------------------------------------------------------------------

describe('scalar subquery modifier guard on direct compileWhereIntent path', () => {
	function makeScalarCtx(): WhereCompilerCtx {
		const paramState = createCompilerState();
		return {
			rootTable: 'users',
			aliases: new Map(),
			paramState,
			naming: identityNaming,
			compileSubquery: (subIntent, paramOffset) =>
				buildSubqueryFromIntent(subIntent, paramOffset, identityNaming),
		};
	}

	it('scalar subquery with GROUP BY on direct path → throws', () => {
		const intent = {
			kind: 'subquery' as const,
			field: 'id',
			operator: 'eq',
			subquery: {
				type: 'select' as const,
				from: 'posts',
				select: {
					type: 'aggregate' as const,
					fn: 'count' as const,
					field: 'id',
				},
				groupBy: ['author_id'],
			},
		};
		expect(() => compileWhereIntent(intent as any, makeScalarCtx())).toThrow(
			/GROUP BY.*not supported|not supported.*GROUP BY/i,
		);
	});

	it('scalar subquery with HAVING on direct path → throws', () => {
		const intent = {
			kind: 'subquery' as const,
			field: 'id',
			operator: 'eq',
			subquery: {
				type: 'select' as const,
				from: 'posts',
				select: {
					type: 'aggregate' as const,
					fn: 'count' as const,
					field: 'id',
				},
				having: {
					kind: 'comparison',
					field: 'id',
					operator: 'gt',
					value: 5,
				},
			},
		};
		expect(() => compileWhereIntent(intent as any, makeScalarCtx())).toThrow(
			/HAVING.*not supported|not supported.*HAVING/i,
		);
	});

	it('scalar subquery with OFFSET on direct path → throws', () => {
		const intent = {
			kind: 'subquery' as const,
			field: 'id',
			operator: 'eq',
			subquery: {
				type: 'select' as const,
				from: 'posts',
				select: { type: 'fields' as const, fields: ['id'] as const },
				offset: 5,
			},
		};
		expect(() => compileWhereIntent(intent as any, makeScalarCtx())).toThrow(
			/OFFSET.*not supported|not supported.*OFFSET/i,
		);
	});

	it('plain scalar subquery (no forbidden modifiers) on direct path → does NOT throw', () => {
		const intent = {
			kind: 'subquery' as const,
			field: 'id',
			operator: 'eq',
			subquery: {
				type: 'select' as const,
				from: 'posts',
				select: {
					type: 'aggregate' as const,
					fn: 'count' as const,
					field: 'id',
				},
			},
		};
		expect(() =>
			compileWhereIntent(intent as any, makeScalarCtx()),
		).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Bounded refinement 1 — scalar-direct rejects limit/orderBy; decisions-path
//   scalar still allows them (regression guard for propagation).
// ---------------------------------------------------------------------------

describe('scalar-direct guard: limit and orderBy rejected on direct path', () => {
	function makeScalarCtx(): WhereCompilerCtx {
		const paramState = createCompilerState();
		return {
			rootTable: 'users',
			aliases: new Map(),
			paramState,
			naming: identityNaming,
			compileSubquery: (subIntent, paramOffset) =>
				buildSubqueryFromIntent(subIntent, paramOffset, identityNaming),
		};
	}

	it('scalar subquery with LIMIT on direct path throws', () => {
		const intent = {
			kind: 'subquery' as const,
			field: 'id',
			operator: 'eq',
			subquery: {
				type: 'select' as const,
				from: 'posts',
				select: {
					type: 'aggregate' as const,
					fn: 'count' as const,
					field: 'id',
				},
				limit: 0,
			},
		};
		expect(() => compileWhereIntent(intent as any, makeScalarCtx())).toThrow(
			/LIMIT.*not supported|not supported.*LIMIT/i,
		);
	});

	it('scalar subquery with field ORDER BY on direct path throws', () => {
		const intent = {
			kind: 'subquery' as const,
			field: 'id',
			operator: 'eq',
			subquery: {
				type: 'select' as const,
				from: 'posts',
				select: { type: 'fields' as const, fields: ['id'] as const },
				orderBy: [{ field: 'id', direction: 'asc' }],
			},
		};
		expect(() => compileWhereIntent(intent as any, makeScalarCtx())).toThrow(
			/ORDER BY.*not supported|not supported.*ORDER BY/i,
		);
	});

	it('decisions-path scalar with LIMIT does not throw (propagation regression)', () => {
		const orm = buildOrm();
		const withLimit = {
			buildIntent: () =>
				({
					type: 'select' as const,
					from: 'posts',
					select: {
						type: 'aggregate' as const,
						fn: 'count' as const,
						field: 'id',
					},
					limit: 1,
				}) as any,
		};
		expect(() => {
			(orm as any)
				.select('users')
				.where(eq('id', withLimit as any))
				.dump();
		}).not.toThrow();
	});

	it('decisions-path scalar with field ORDER BY does not throw (propagation regression)', () => {
		const orm = buildOrm();
		const withOrder = {
			buildIntent: () =>
				({
					type: 'select' as const,
					from: 'posts',
					select: { type: 'fields' as const, fields: ['id'] as const },
					orderBy: [{ field: 'id', direction: 'asc' as const }],
				}) as any,
		};
		expect(() => {
			(orm as any)
				.select('users')
				.where(eq('id', withOrder as any))
				.dump();
		}).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Bounded refinement 2 — nested multi-hop fail-closed: undeclared hop throws
// ---------------------------------------------------------------------------

describe('nested multi-hop fail-closed for undeclared hops', () => {
	it('exists(posts) wrapping relationFilter([comments,undeclared]) throws at undeclared hop', () => {
		const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });
		const planReport = plan(
			{
				type: 'select',
				from: 'users',
				where: {
					kind: 'exists',
					relation: 'posts',
					where: {
						kind: 'relationFilter',
						relation: ['comments', 'undeclared'] as unknown as string,
						where: {
							kind: 'comparison',
							field: 'body',
							operator: 'eq',
							value: 'x',
						},
						mode: 'some',
					},
				},
			},
			testSchema.model,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);
		expect(() =>
			adapter.compile(planReport, { model: testSchema.model }),
		).toThrow(/no relation 'undeclared' is declared on table 'comments'/i);
	});

	it('exists(posts) wrapping relationFilter([undeclared]) throws on first hop', () => {
		const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });
		const planReport = plan(
			{
				type: 'select',
				from: 'users',
				where: {
					kind: 'exists',
					relation: 'posts',
					where: {
						kind: 'relationFilter',
						relation: ['undeclared'] as unknown as string,
						where: {
							kind: 'comparison',
							field: 'col',
							operator: 'eq',
							value: 1,
						},
						mode: 'some',
					},
				},
			},
			testSchema.model,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);
		expect(() =>
			adapter.compile(planReport, { model: testSchema.model }),
		).toThrow(/no relation 'undeclared' is declared on table 'posts'/i);
	});

	it('exists(posts) wrapping inner relationFilter(["comments"]) — fully-declared does not throw (regression)', () => {
		const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });
		const planReport = plan(
			{
				type: 'select',
				from: 'users',
				where: {
					kind: 'exists',
					relation: 'posts',
					where: {
						kind: 'relationFilter',
						relation: ['comments'] as unknown as string,
						where: {
							kind: 'comparison',
							field: 'body',
							operator: 'eq',
							value: 'ok',
						},
						mode: 'some',
					},
				},
			},
			testSchema.model,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);
		expect(() =>
			adapter.compile(planReport, { model: testSchema.model }),
		).not.toThrow();
		const { sql } = adapter.compile(planReport, { model: testSchema.model });
		expect(ws(sql)).toMatch(/EXISTS.*EXISTS/i);
	});
});

// ---------------------------------------------------------------------------
// scalar-direct projection validation inherits all scalar checks
// ---------------------------------------------------------------------------

describe('scalar-direct projection validation on direct compileWhereIntent path', () => {
	function makeScalarCtx() {
		const paramState = createCompilerState();
		return {
			rootTable: 'users',
			aliases: new Map(),
			paramState,
			naming: identityNaming,
			compileSubquery: (subIntent: any, paramOffset: number) =>
				buildSubqueryFromIntent(subIntent, paramOffset, identityNaming),
		};
	}

	it('scalar subquery with 2-field projection on direct path throws', () => {
		const intent = {
			kind: 'subquery' as const,
			field: 'id',
			operator: 'eq',
			subquery: {
				type: 'select' as const,
				from: 'posts',
				select: { type: 'fields' as const, fields: ['id', 'title'] as const },
			},
		};
		expect(() => compileWhereIntent(intent as any, makeScalarCtx())).toThrow(
			/multi-field projection.*scalar subquery must project exactly one column/i,
		);
	});

	it('scalar subquery with expressions projection on direct path throws', () => {
		const intent = {
			kind: 'subquery' as const,
			field: 'id',
			operator: 'eq',
			subquery: {
				type: 'select' as const,
				from: 'posts',
				select: { type: 'expressions' as const },
			},
		};
		expect(() => compileWhereIntent(intent as any, makeScalarCtx())).toThrow(
			/expressions SELECT.*not supported in scalar subquery/i,
		);
	});

	it('scalar subquery with single-field projection on direct path does NOT throw', () => {
		const intent = {
			kind: 'subquery' as const,
			field: 'id',
			operator: 'eq',
			subquery: {
				type: 'select' as const,
				from: 'posts',
				select: { type: 'fields' as const, fields: ['id'] as const },
			},
		};
		expect(() =>
			compileWhereIntent(intent as any, makeScalarCtx()),
		).not.toThrow();
	});
});
