/**
 * Regression tests: Defect 2 — dotted-field EXISTS and explicit EXISTS on the
 * same relation must NOT have their conditions cross-contaminated by the enricher.
 *
 * Root cause: enrichExistsDecisionsInPlace → collectExistsStubs collected ALL
 * operator==='exists' decisions, including the already-complete ones produced by
 * convertDottedFieldsToExists.  When two exists decisions shared the same relation
 * name, the enricher could match the dotted-field stub to the wrong filter-strategy
 * intent, replacing its conditions — silently dropping the dotted-field predicate.
 *
 * Fix: collectExistsStubs now skips decisions that already have foreignKey set
 * (i.e. those produced by convertDottedFieldsToExists), so only unresolved stubs
 * from convertExistsLike are enriched.
 */

import { and, createOrm, eq, exists, gt, ref, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Schema: users hasMany posts (non-nullable FK so rewriting is unambiguous)
// ---------------------------------------------------------------------------
const testSchema = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: { type: 'text' },
		views: { type: 'integer' },
		author_id: ref('users', { as: 'author', inverse: 'posts' }),
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
// Suite 1: Dotted-field alone — baseline (no regression)
// ---------------------------------------------------------------------------

describe('dotted-field filter alone compiles to EXISTS with correct condition', () => {
	it('eq("posts.title", "x") produces EXISTS with title condition', () => {
		const orm = buildOrm();
		const dump = orm.select('users').where(eq('posts.title', 'hello')).dump();
		const sql = ws(dump.sql);

		expect(sql.toLowerCase()).toContain('exists');
		// column appears in the EXISTS subquery WHERE clause (may be aliased, unquoted)
		expect(sql.toLowerCase()).toContain('title');
		// Value is bound as a parameter
		expect(Array.from(dump.params)).toContain('hello');
	});
});

// ---------------------------------------------------------------------------
// Suite 2: Dotted-field + explicit exists on same relation — BOTH conditions present
// ---------------------------------------------------------------------------

describe('dotted-field + explicit exists on same relation: both conditions survive', () => {
	it('and(eq("posts.title","x"), exists("posts",{where:gt("views",10)})) — both EXISTS survive', () => {
		// Before the fix, the enricher would replace the dotted-field EXISTS conditions
		// with those from the explicit exists intent, dropping "title = $N".
		const orm = buildOrm();
		const dump = orm
			.select('users')
			.where(
				and(
					eq('posts.title', 'hello'),
					exists('posts', { where: gt('views', 10) }),
				),
			)
			.dump();

		const sql = ws(dump.sql).toLowerCase();

		// Both EXISTS subqueries must appear in the SQL
		const existsCount = (sql.match(/\bexists\b/g) ?? []).length;
		expect(existsCount).toBeGreaterThanOrEqual(2);

		// title condition must appear (from the dotted-field EXISTS)
		expect(sql).toContain('title');

		// views condition must appear (from the explicit exists)
		expect(sql).toContain('views');

		// Both values are bound as parameters
		const params = Array.from(dump.params);
		expect(params).toContain('hello');
		expect(params).toContain(10);
	});

	it('conditions are not swapped: title param bound, views param bound', () => {
		const orm = buildOrm();
		const dump = orm
			.select('users')
			.where(
				and(
					eq('posts.title', 'my-title'),
					exists('posts', { where: gt('views', 42) }),
				),
			)
			.dump();

		const sql = ws(dump.sql).toLowerCase();

		// Both parameter values present
		const params = Array.from(dump.params);
		expect(params).toContain('my-title');
		expect(params).toContain(42);

		// SQL contains both column references
		expect(sql).toContain('title');
		expect(sql).toContain('views');
	});
});

// ---------------------------------------------------------------------------
// Suite 3: Two explicit exists on same relation — both conditions survive
// ---------------------------------------------------------------------------

describe('two explicit exists() on same relation with different conditions: both survive', () => {
	it('and(exists("posts",{where:eq("title","x")}), exists("posts",{where:gt("views",5)})) — both survive', () => {
		const orm = buildOrm();
		const dump = orm
			.select('users')
			.where(
				and(
					exists('posts', { where: eq('title', 'wanted') }),
					exists('posts', { where: gt('views', 5) }),
				),
			)
			.dump();

		const sql = ws(dump.sql).toLowerCase();

		// Both EXISTS subqueries
		const existsCount = (sql.match(/\bexists\b/g) ?? []).length;
		expect(existsCount).toBeGreaterThanOrEqual(2);

		// Both conditions appear
		expect(sql).toContain('title');
		expect(sql).toContain('views');

		const params = Array.from(dump.params);
		expect(params).toContain('wanted');
		expect(params).toContain(5);
	});
});
