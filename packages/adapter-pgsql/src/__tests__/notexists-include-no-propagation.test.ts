/**
 * Regression test: exists()/notExists() + include() must NEVER propagate the
 * filter condition onto the include subquery (decoupled semantics).
 *
 * The exists() filter controls WHICH root rows are selected.  The include()
 * subquery is independent: it correlates on the FK only and returns ALL
 * related rows regardless of what the sibling exists() tested.
 *
 * Historical note: earlier code coupled include to a sibling AND-position
 * exists() via propagateExistsConditions.  That coupling is intentionally
 * removed; include is never filtered by a sibling exists.
 */

import { createOrm, eq, exists, notExists, ref, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Schema: users → posts (one-to-many)
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
	return createOrm({ model: testSchema.model, adapter: adapter as any });
}

function ws(sql: string): string {
	return sql.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Decoupled include: neither notExists nor exists propagate to the include
// ---------------------------------------------------------------------------
describe('decoupled include — sibling exists/notExists never filters the include', () => {
	it('notExists filter condition is NOT injected into the include subquery', () => {
		const orm = buildOrm();

		// Select users who have NO unpublished posts, and include all their posts.
		// The include subquery for posts must NOT carry a filter from the notExists.
		const dump = orm
			.select('users')
			.where(notExists('posts', { where: eq('published', false) }))
			.include('posts')
			.dump();

		// Plan-level check: the includeStrategy decision for 'posts' must not have conditions
		const includeDecision = dump.plan.decisions.find(
			(d: any) =>
				d.type === 'include-strategy' && d.context?.relation === 'posts',
		) as any;

		// The include decision exists (inclusion is happening)
		expect(includeDecision).toBeDefined();

		// The include decision must NOT have conditions
		expect(includeDecision?.conditions).toBeUndefined();
	});

	it('exists filter condition is NOT propagated to the include subquery (decoupled)', () => {
		// After decoupling, exists() + include() never merges the filter into the include.
		// The EXISTS subquery filters which root rows appear; the include returns ALL rows.
		const orm = buildOrm();

		const dump = orm
			.select('users')
			.where(exists('posts', { where: eq('published', true) }))
			.include('posts')
			.dump();

		const sql = ws(dump.sql);

		// EXISTS subquery must appear in the WHERE
		expect(sql).toMatch(/EXISTS/i);

		// published appears exactly ONCE — in the WHERE EXISTS, NOT in the include
		const publishedCount = (sql.match(/published/gi) ?? []).length;
		expect(publishedCount).toBe(1);

		// Plan-level: the includeStrategy for 'posts' must have NO conditions
		const includeDecision = dump.plan.decisions.find(
			(d: any) =>
				d.type === 'include-strategy' && d.context?.relation === 'posts',
		) as any;
		expect(includeDecision?.conditions).toBeUndefined();
	});

	it('notExists without include: NOT EXISTS with where condition compiles correctly', () => {
		const orm = buildOrm();

		const dump = orm
			.select('users')
			.where(notExists('posts', { where: eq('published', false) }))
			.dump();

		const sql = ws(dump.sql);

		// NOT EXISTS must appear
		expect(sql).toMatch(/NOT.*EXISTS/i);
		// The published condition must appear in the NOT EXISTS subquery
		expect(sql).toMatch(/\bpublished\b/i);
		// Must not have an include-related lateral or json_agg
		expect(sql).not.toMatch(/json_agg|lateral/i);
	});
});
