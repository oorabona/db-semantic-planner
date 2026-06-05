/**
 * DEFECT 1 regression: IN→EXISTS optimizer MUST NOT propagate the rewritten
 * exists condition into a same-relation include.
 *
 * The user wrote inSubquery(), NOT exists() — they did not opt into include-filter
 * coupling.  The optimizer-generated exists still compiles in the WHERE (correct)
 * but its conditions must be invisible to propagateExistsConditions (include must
 * return ALL rows for the matched parent, not only the filtered subset).
 *
 * Oracle: when propagation leaks, `published = $N` appears in BOTH the WHERE EXISTS
 * subquery AND the include subquery's WHERE clause — two parameter bindings for `true`.
 * Without the leak, only one binding (just the WHERE EXISTS).
 *
 * Contrast: a user-authored exists() + include() DOES inherit the filter
 * (that is the designed propagation behaviour — see exists-inline-position.test.ts § 5).
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
				values: [],
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
// 2. User-authored exists() + include — include DOES inherit the filter (baseline)
//    Oracle: 2 `true` params when propagation correctly fires.
// ---------------------------------------------------------------------------

describe('user-authored exists() + include: propagation still works (baseline)', () => {
	it('params contain true TWICE when root WHERE is exists() — propagation fires', () => {
		// User-authored exists('posts', { where: eq('published', true) }) + include('posts')
		// → propagateExistsConditions DOES propagate the condition.
		// → include subquery adds WHERE published = $N → 2 true params total.
		const orm = buildOrm();
		const dump = (orm as any)
			.select('users')
			.where(exists('posts', { where: eq('published', true) }))
			.include('posts')
			.dump();

		expect(ws(dump.sql)).toContain('EXISTS');

		// Two `true` bindings: one in the WHERE EXISTS, one in the include subquery WHERE.
		const trueParams = dump.params.filter((p: unknown) => p === true);
		expect(trueParams).toHaveLength(2);
	});

	it('direct compileIntent: user-authored exists + include propagates — 2 true params', () => {
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

		const trueBindings = params.filter((p) => p === true);
		expect(trueBindings).toHaveLength(2);
	});
});
