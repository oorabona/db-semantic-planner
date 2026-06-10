/**
 * Regression tests for issue #129: 7 correctness items in @dbsp/nql.
 *
 * Each test is labelled with its item number.
 * Items 1–7 each have a test that FAILS before the fix and PASSES after.
 */

import type {
	DeleteIntent,
	UpdateIntent,
	UpsertFromIntent,
	UpsertIntent,
} from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { compile } from '../index.js';
import { MAX_ANY_ITEMS } from './compile-expression.js';
import type { CompileResult } from './index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function compileNql(input: string, schema: unknown = null): CompileResult {
	const result = compile(input, schema);
	if (!result.success) {
		throw new Error(`Compile error: ${result.errors[0]?.message}`);
	}
	return result.ast!;
}

function compileFails(
	input: string,
	schema: unknown = null,
	options?: import('../index.js').NqlCompilerOptions,
): string {
	const result = compile(input, schema, undefined, options);
	if (result.success) {
		throw new Error(`Expected compile to fail but it succeeded`);
	}
	return result.errors[0]?.message ?? '';
}

// Minimal schema with two tables so cross-table ctx-isolation tests work
const schema = {
	getTable(name: string) {
		const tables: Record<string, { columns: { name: string }[] }> = {
			users: {
				columns: [
					{ name: 'id' },
					{ name: 'name' },
					{ name: 'email' },
					{ name: 'active' },
					{ name: 'score' },
				],
			},
			orders: {
				columns: [
					{ name: 'id' },
					{ name: 'userId' },
					{ name: 'total' },
					{ name: 'status' },
				],
			},
			products: {
				columns: [
					{ name: 'id' },
					{ name: 'name' },
					{ name: 'price' },
					{ name: 'active' },
				],
			},
		};
		return tables[name];
	},
	getRelationsFrom(sourceTable: string) {
		const rels: Record<string, { name: string; target: string }[]> = {
			users: [{ name: 'orders', target: 'orders' }],
			orders: [],
			products: [],
		};
		return rels[sourceTable] ?? [];
	},
};

// ===========================================================================
// ITEM 1 — ANY(:param) accepts non-array / unbounded
// NOTE: Comprehensive ANY tests already exist in compile-expression.coverage.test.ts.
// These regression tests confirm the fix is present and add the MAX_ANY_ITEMS assertion.
// ===========================================================================

describe('item 1 — ANY(:param) validation', () => {
	it('throws when param is not bound (undefined)', () => {
		// Correct NQL syntax: field = ANY(:param)
		const r = compile('users | where id = ANY(:ids)', null, undefined, {
			params: {},
		});
		expect(r.success).toBe(false);
		expect(r.errors[0]?.message).toMatch(/ids/i);
		expect(r.errors[0]?.message).toMatch(/not bound/i);
	});

	it('throws when param is a non-array (string)', () => {
		const r = compile('users | where id = ANY(:ids)', null, undefined, {
			params: { ids: 'not-an-array' },
		});
		expect(r.success).toBe(false);
		expect(r.errors[0]?.message).toMatch(/ids/i);
		expect(r.errors[0]?.message).toMatch(/array/i);
	});

	it('throws when array exceeds maximum item count', () => {
		const tooMany = Array.from({ length: MAX_ANY_ITEMS + 1 }, (_, i) => i);
		const r = compile('users | where id = ANY(:ids)', null, undefined, {
			params: { ids: tooMany },
		});
		expect(r.success).toBe(false);
		expect(r.errors[0]?.message).toMatch(/ids/i);
		expect(r.errors[0]?.message).toMatch(/exceed/i);
		expect(r.errors[0]?.message).toContain(String(MAX_ANY_ITEMS));
	});

	it('compiles when array is within bounds', () => {
		const ids = [1, 2, 3];
		const r = compile('users | where id = ANY(:ids)', null, undefined, {
			params: { ids },
		});
		expect(r.success).toBe(true);
		const where = r.ast!.query!.where as unknown as {
			kind: string;
			values: unknown[];
		};
		expect(where.kind).toBe('any');
		expect(where.values).toEqual(ids);
	});

	it('MAX_ANY_ITEMS constant is 10000', () => {
		expect(MAX_ANY_ITEMS).toBe(10000);
	});
});

// ===========================================================================
// ITEM 2 — Clauses after a set operation silently dropped → now throws
// ===========================================================================

describe('item 2 — clauses after set operation throw (not silently dropped)', () => {
	it('throws when an order clause follows a union', () => {
		const msg = compileFails(
			'users | select id, name | union (orders | select id, userId) | order by id',
		);
		expect(msg).toMatch(/clauses after a set operation.*not supported/i);
		expect(msg).toMatch(/orderBy/i);
	});

	it('throws when a limit clause follows a union', () => {
		const msg = compileFails(
			'users | select id, name | union (orders | select id, userId) | limit 10',
		);
		expect(msg).toMatch(/clauses after a set operation.*not supported/i);
	});

	it('throws when a where clause follows an intersect', () => {
		const msg = compileFails(
			'users | select id | intersect (orders | select id) | where id = 1',
		);
		expect(msg).toMatch(/clauses after a set operation.*not supported/i);
	});

	it('a plain set operation without trailing clauses still compiles', () => {
		const r = compile(
			'users | select id, name | union (orders | select id, userId)',
			null,
		);
		expect(r.success).toBe(true);
		expect(r.ast?.setOperation).toBeDefined();
	});
});

// ===========================================================================
// ITEM 3 — Nested subqueries mutate shared compiler ctx
// ===========================================================================

describe('item 3 — nested subquery ctx restore', () => {
	/**
	 * Construct a query where:
	 *   - outer table is "users"
	 *   - a subquery in an IN clause references "orders"
	 *   - after the IN clause, an orderBy references an "users" column
	 *
	 * Before the fix, ctx.currentFromTable would be "orders" after the subquery,
	 * causing the post-subquery column validation to wrongly check against "orders".
	 * With schema validation, a "users"-only column validated after the subquery
	 * would throw "unknown column" against "orders" before the fix.
	 */
	it('post-subquery column validated against outer table (users), not inner (orders)', () => {
		// "score" exists on users but NOT on orders.
		// Before fix: after compiling the IN subquery, ctx.currentFromTable = 'orders',
		// so | order by score would fail validation (score not on orders).
		// After fix: ctx is restored to 'users', so order by score passes.
		const r = compile(
			'users | where id in (orders | select userId) | order by score',
			schema,
		);
		expect(r.success).toBe(true);
		const query = r.ast!.query!;
		expect(query.from).toBe('users');
		expect(query.orderBy).toBeDefined();
		expect(query.orderBy?.[0]?.field).toBe('score');
	});

	it('inner subquery table does not bleed into outer validation after fix', () => {
		// "total" is on orders, NOT on users. After fix, the outer query's orderBy
		// "name" (which IS on users) should compile fine regardless of subquery table.
		const r = compile(
			'users | where id in (orders | select userId) | order by name',
			schema,
		);
		expect(r.success).toBe(true);
	});

	it('scalar subquery in SELECT restores outer table before validating following column', () => {
		// "name" exists on users but NOT on orders. Before the fix, the scalar
		// subquery left ctx.currentFromTable = 'orders', so the following "name"
		// column was validated against the inner table.
		const r = compile(
			'users | select (orders | select count() as cnt) as cnt, name',
			schema,
		);
		expect(r.success).toBe(true);
		const query = r.ast!.query!;
		expect(query.from).toBe('users');
		expect(query.select).toMatchObject({
			type: 'expressions',
			columns: [
				{ kind: 'subquery', as: 'cnt' },
				{ kind: 'column', column: 'name' },
			],
		});
	});

	it('scalar subquery in SELECT does not allow inner-only columns afterward', () => {
		// "total" exists on orders but NOT on users. The column after the scalar
		// subquery must still be validated against the outer users table.
		const msg = compileFails(
			'users | select (orders | select count() as cnt) as cnt, total',
			schema,
		);
		expect(msg).toMatch(/total/i);
	});
});

// ===========================================================================
// ITEM 4 — `upsert ... where ...` parsed but unsupported
// ===========================================================================

const conditionalUpsertUnsupportedError =
	'conditional upsert is not yet supported: a WHERE clause on `upsert` (ON CONFLICT DO UPDATE ... WHERE) is parsed but cannot be honored by the SQL generator yet. Remove the WHERE, or use a plain conditional update. Tracked for a future release.';

describe('item 4 — upsert where fails loudly', () => {
	it('upsert with where throws unsupported conditional upsert error', () => {
		const msg = compileFails(
			"upsert into users on id set name = 'Alice' where active = true",
		);
		expect(msg).toBe(conditionalUpsertUnsupportedError);
	});

	it('upsert without where produces no action.where', () => {
		const result = compileNql("upsert into users on id set name = 'Bob'");
		const upsert = result.mutation as UpsertIntent;
		expect(upsert.action.type).toBe('doUpdate');
		const action = upsert.action as { type: 'doUpdate'; where?: unknown };
		expect(action.where).toBeUndefined();
	});

	it('upsert where with compound condition throws unsupported conditional upsert error', () => {
		const msg = compileFails(
			"upsert into users on id set name = 'Carol' where active = true and score > 0",
		);
		expect(msg).toBe(conditionalUpsertUnsupportedError);
	});
});

// ===========================================================================
// ITEM 5 — insert/upsert from skip schema validation
// ===========================================================================

describe('item 5 — insert/upsert from schema validation', () => {
	it('insert from throws on bad target table', () => {
		const msg = compileFails(
			'insert into nonexistent_table from orders',
			schema,
		);
		expect(msg).toMatch(/nonexistent_table/i);
	});

	it('insert from throws on bad source table', () => {
		const msg = compileFails(
			'insert into users from nonexistent_source',
			schema,
		);
		expect(msg).toMatch(/nonexistent_source/i);
	});

	it('insert from with valid target and source compiles', () => {
		const r = compile('insert into users from orders', schema);
		expect(r.success).toBe(true);
		expect(r.ast?.mutation?.type).toBe('insert_from');
	});

	it('upsert from throws on bad target table', () => {
		const msg = compileFails(
			'upsert into nonexistent_table on id from orders',
			schema,
		);
		expect(msg).toMatch(/nonexistent_table/i);
	});

	it('upsert from throws on bad source table', () => {
		const msg = compileFails(
			'upsert into users on id from nonexistent_source',
			schema,
		);
		expect(msg).toMatch(/nonexistent_source/i);
	});

	it('upsert from throws on bad conflict column', () => {
		const msg = compileFails(
			'upsert into users on nonexistent_col from orders',
			schema,
		);
		expect(msg).toMatch(/nonexistent_col/i);
	});

	it('upsert from with valid target, source, and conflict column compiles', () => {
		const r = compile('upsert into users on id from orders', schema);
		expect(r.success).toBe(true);
		expect(r.ast?.mutation?.type).toBe('upsert_from');
		const m = r.ast!.mutation as UpsertFromIntent;
		expect(m.conflictColumns).toEqual(['id']);
	});
});

// ===========================================================================
// ITEM 6 — update/delete without where silently affects all rows
// ===========================================================================

describe('item 6 — unfiltered mutation guard', () => {
	const updateWithoutWhereError =
		'update without a where clause would affect all rows; pass { allowUnfilteredMutations: true } to the compiler to allow an unfiltered update';
	const deleteWithoutWhereError =
		'delete without a where clause would affect all rows; pass { allowUnfilteredMutations: true } to the compiler to allow an unfiltered delete';

	it('update without where throws by default (allowUnfilteredMutations not set)', () => {
		const msg = compileFails("update users set status = 'archived'");
		expect(msg).toBe(updateWithoutWhereError);
	});

	it('delete without where throws by default (allowUnfilteredMutations not set)', () => {
		const msg = compileFails('delete from users');
		expect(msg).toBe(deleteWithoutWhereError);
	});

	it('update without where compiles with allowUnfilteredMutations: true', () => {
		const r = compile("update users set status = 'archived'", null, undefined, {
			allowUnfilteredMutations: true,
		});
		expect(r.success).toBe(true);

		const update = r.ast!.mutation as UpdateIntent;
		expect(update).toEqual({
			type: 'update',
			table: 'users',
			set: { status: 'archived' },
			allowAll: true,
		});
	});

	it('delete without where compiles with allowUnfilteredMutations: true', () => {
		const r = compile('delete from users', null, undefined, {
			allowUnfilteredMutations: true,
		});
		expect(r.success).toBe(true);

		const del = r.ast!.mutation as DeleteIntent;
		expect(del).toEqual({
			type: 'delete',
			table: 'users',
			allowAll: true,
		});
	});

	it('update with where always compiles regardless of option', () => {
		const defaultResult = compileNql(
			'update users set active = true where id = 1',
		);
		const optedInResult = compile(
			'update users set active = false where id = 2',
			null,
			undefined,
			{ allowUnfilteredMutations: true },
		);

		expect(defaultResult.mutation as UpdateIntent).toEqual({
			type: 'update',
			table: 'users',
			set: { active: true },
			where: { kind: 'comparison', field: 'id', operator: 'eq', value: 1 },
		});
		expect(optedInResult.success).toBe(true);
		expect(optedInResult.ast!.mutation as UpdateIntent).toEqual({
			type: 'update',
			table: 'users',
			set: { active: false },
			where: { kind: 'comparison', field: 'id', operator: 'eq', value: 2 },
		});
	});

	it('delete with where always compiles regardless of option', () => {
		const defaultResult = compileNql('delete from users where id = 1');
		const optedInResult = compile(
			'delete from users where id = 2',
			null,
			undefined,
			{
				allowUnfilteredMutations: true,
			},
		);

		expect(defaultResult.mutation as DeleteIntent).toEqual({
			type: 'delete',
			table: 'users',
			where: { kind: 'comparison', field: 'id', operator: 'eq', value: 1 },
		});
		expect(optedInResult.success).toBe(true);
		expect(optedInResult.ast!.mutation as DeleteIntent).toEqual({
			type: 'delete',
			table: 'users',
			where: { kind: 'comparison', field: 'id', operator: 'eq', value: 2 },
		});
	});
});

// ===========================================================================
// ITEM 7 — Multiple statements need no separator; only the last result returned
// ===========================================================================

describe('item 7 — multiple unbound statements throw', () => {
	it('two unbound statements throw with clear message', () => {
		// Previously: second statement would silently replace the first
		const msg = compileFails(
			'users | where active = true\norders | where total > 0',
		);
		expect(msg).toMatch(
			/multiple statements.*explicit binding|statement 1.*no.*bind/i,
		);
	});

	it('three unbound statements throw', () => {
		const msg = compileFails('users | where active = true\norders\nproducts');
		expect(msg).toMatch(/multiple statements|no.*bind/i);
	});

	it('a single valid statement still compiles', () => {
		const r = compile('users | where active = true', null);
		expect(r.success).toBe(true);
		expect(r.ast?.query?.from).toBe('users');
	});

	it('multi-statement with bind clause compiles (each non-last must be bound)', () => {
		// "users | where active = true | bind activeUsers" binds first statement,
		// then "orders | where userId in (activeUsers)" references it.
		const r = compile(
			'users | where active = true | bind activeUsers\norders | where userId in (activeUsers)',
			null,
		);
		expect(r.success).toBe(true);
		expect(r.ast?.query?.from).toBe('orders');
	});

	it('non-last mutation with bind but no returning throws materialization error', () => {
		const msg = compileFails(
			'update users set active = false where id = 1 | bind ignored\nusers | select id',
		);
		expect(msg).toBe(
			"statement 1 of 2 binds 'ignored' but produces no referenceable result — a mutation used as a binding must include a `returning` clause.",
		);
	});

	it('non-last mutation with returning and bind compiles', () => {
		const r = compile(
			'update users set active = false where id = 1 | select id | bind updated\nusers | where id in (updated)',
			null,
		);
		expect(r.success).toBe(true);
		expect(r.ast?.query?.from).toBe('users');
		expect(r.ast?.bindings?.has('updated')).toBe(true);
		expect(r.ast?.mutationBindings?.has('updated')).toBe(true);
	});

	it('non-last query with bind still compiles', () => {
		const r = compile(
			'users | select id | bind userIds\norders | where userId in (userIds)',
			null,
		);
		expect(r.success).toBe(true);
		expect(r.ast?.query?.from).toBe('orders');
		expect(r.ast?.bindings?.has('userIds')).toBe(true);
		expect(r.ast?.mutationBindings).toBeUndefined();
	});
});
