/**
 * Decoupled include: neither IN→EXISTS optimizer-generated exists nor user-authored
 * exists propagate their filter into a sibling include subquery.
 *
 * Oracle: published = $N must appear exactly ONCE in params regardless of whether
 * the WHERE filter came from inSubquery() (optimizer-rewritten) or exists().
 * Without the decoupling, a user-authored exists() + include() would bind published
 * twice (WHERE EXISTS once, include once).  After decoupling, always once.
 */

import {
	createOrm,
	eq,
	exists,
	inSubquery,
	POSTGRESQL_CAPABILITIES,
	plan,
	type QueryIntent,
	ref,
	schema,
	subquery,
} from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Schema: users --(hasMany posts via authorId FK)
// ---------------------------------------------------------------------------
const testSchema = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: { type: 'text' },
		published: { type: 'boolean' },
		authorId: ref('users', { as: 'author', inverse: 'posts' }),
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
// Helper to compile a QueryIntent directly (plan + adapter)
// ---------------------------------------------------------------------------
function compileIntent(intent: QueryIntent): {
	sql: string;
	params: readonly unknown[];
} {
	const planReport = plan(intent, testSchema.model, {
		dialectCapabilities: POSTGRESQL_CAPABILITIES,
	});
	const adapter = createPgsqlCompileOnlyAdapter();
	const result = adapter.compile(planReport, { model: testSchema.model });
	return { sql: ws(result.sql), params: result.parameters };
}

// ---------------------------------------------------------------------------
// 1. inSubquery + include — include must NOT inherit the inSubquery predicate
// ---------------------------------------------------------------------------

describe('inSubquery + include: optimizer-generated EXISTS must NOT propagate to include', () => {
	it('params contain true exactly ONCE — predicate not duplicated into include', () => {
		// Oracle: if propagation leaks, published=true is bound in BOTH the WHERE EXISTS
		// subquery AND the include subquery's WHERE clause → two `true` params.
		// Without the leak, only one `true` param exists (just the WHERE EXISTS).
		const orm = buildOrm();
		const dump = (orm as any)
			.select('users')
			.where(
				inSubquery(
					'id',
					subquery('posts').select('authorId').where(eq('published', true)),
				),
			)
			.include('posts')
			.dump();

		// Root WHERE must use EXISTS (optimizer rewrote inSubquery → exists)
		expect(ws(dump.sql)).toContain('EXISTS');

		// Param oracle: only ONE true binding — the WHERE EXISTS predicate.
		// If the include subquery also inherited published=true, there would be 2.
		const trueParams = dump.params.filter((p: unknown) => p === true);
		expect(trueParams).toHaveLength(1);
	});

	it('compiled intent: include has no extra WHERE clause for published (param count)', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'users',
			where: {
				kind: 'in',
				field: 'id',
				subquery: {
					type: 'select',
					from: 'posts',
					select: { type: 'fields', fields: ['authorId'] },
					where: {
						kind: 'comparison',
						field: 'published',
						operator: 'eq',
						value: true,
					},
				},
			},
			include: [{ relation: 'posts' }],
		};

		const { sql, params } = compileIntent(intent);

		// Root WHERE must use EXISTS (optimizer rewrote in → exists)
		expect(sql).toContain('EXISTS');

		// Param oracle: exactly 1 `true` param — from the optimizer-generated EXISTS WHERE.
		// A leaking propagation would produce 2.
		const trueBindings = params.filter((p) => p === true);
		expect(trueBindings).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// 2. User-authored exists() + include — include is also NOT filtered (decoupled)
//    Oracle: 1 `true` param for both inSubquery and exists cases.
// ---------------------------------------------------------------------------

describe('user-authored exists() + include: include NOT filtered after decoupling', () => {
	it('params contain true ONCE when root WHERE is exists() — no propagation', () => {
		// After decoupling, user-authored exists('posts', { where: eq('published', true) })
		// + include('posts') — the include does NOT inherit the filter.
		// Oracle: exactly 1 true param (only the WHERE EXISTS, not the include).
		const orm = buildOrm();
		const dump = (orm as any)
			.select('users')
			.where(exists('posts', { where: eq('published', true) }))
			.include('posts')
			.dump();

		expect(ws(dump.sql)).toContain('EXISTS');

		// Exactly ONE true binding: only in the WHERE EXISTS.
		// If the include were still filtered, there would be 2.
		const trueParams = dump.params.filter((p: unknown) => p === true);
		expect(trueParams).toHaveLength(1);
	});

	it('direct compileIntent: user-authored exists + include — 1 true param (decoupled)', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'users',
			where: {
				kind: 'exists',
				relation: 'posts',
				where: {
					kind: 'comparison',
					field: 'published',
					operator: 'eq',
					value: true,
				},
			},
			include: [{ relation: 'posts' }],
		};

		const { params } = compileIntent(intent);

		// Exactly 1 true binding — the WHERE EXISTS only.
		const trueBindings = params.filter((p) => p === true);
		expect(trueBindings).toHaveLength(1);
	});
});
