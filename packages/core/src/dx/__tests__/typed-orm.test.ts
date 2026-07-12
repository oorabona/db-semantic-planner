/**
 * Tests for DX-040-SURFACE: Typed ORM Public API
 *
 * SC-01: orm.tables returns typed table refs
 * SC-02: Table ref has column accessors
 * SC-03: from() produces valid SQL (with WHERE)
 * SC-04: from() with columns()
 * SC-05: from() with include (string)
 * SC-06: from() preserves set operations (union)
 */

import { describe, expect, expectTypeOf, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../../../../adapter-pgsql/src/pgsql-adapter.js';
import { normalizeSQL } from '../../sql-utils.js';
import { eq } from '../filters.js';
import { createOrm } from '../orm.js';
import { ref, schema } from '../schema.js';

const db = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		email: 'string',
		active: 'boolean',
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: 'string',
		authorId: ref('users'),
	},
});

const adapter = createPgsqlCompileOnlyAdapter();
const orm = createOrm({ schema: db, adapter });

describe('DX-040-SURFACE: orm.tables', () => {
	it('SC-01: orm.tables returns table ref objects', () => {
		const { users, posts } = orm.tables;
		expect(users).toBeDefined();
		expect(posts).toBeDefined();
	});

	it('SC-01: orm.tables shares tables with schema.tables', () => {
		expect(orm.tables.users).toBeDefined();
		expect(db.tables.users).toBeDefined();
	});
});

describe('DX-040-SURFACE: column accessors', () => {
	it('SC-02: users table ref has column accessors', () => {
		const { users } = orm.tables;
		expect(users.id).toBeDefined();
		expect(users.name).toBeDefined();
		expect(users.email).toBeDefined();
		expect(users.active).toBeDefined();
	});

	it('SC-02: posts table ref has column accessors', () => {
		const { posts } = orm.tables;
		expect(posts.id).toBeDefined();
		expect(posts.title).toBeDefined();
		expect(posts.authorId).toBeDefined();
	});
});

describe('DX-040-SURFACE: orm.from() SQL output', () => {
	it('SC-03: from() with where(eq id) produces exact SQL and params', () => {
		const { users } = orm.tables;
		const dump = orm.from(users).where(eq(users.id, 1)).dump();
		expect(normalizeSQL(dump.sql)).toBe(
			'select users.* from users where users.id = $1',
		);
		expect(dump.params).toEqual([1]);
	});

	it('SC-03: from() WHERE uses column name from ColumnRef', () => {
		const { users } = orm.tables;
		const dump = orm.from(users).where(eq(users.active, true)).dump();
		expect(normalizeSQL(dump.sql)).toBe(
			'select users.* from users where users.active = $1',
		);
		expect(dump.params).toEqual([true]);
	});

	it('SC-03: from() produces identical SQL to select() for same table', () => {
		const { users } = orm.tables;
		const fromDump = orm.from(users).dump();
		// select() remains the ordinary string-based public API
		const selectDump = orm.select('users').dump();
		expect(fromDump.sql).toBe(selectDump.sql);
	});

	it('SC-03: from() with no WHERE produces bare SELECT', () => {
		const { users } = orm.tables;
		const dump = orm.from(users).dump();
		expect(normalizeSQL(dump.sql)).toBe('select users.* from users');
		expect(dump.params).toEqual([]);
	});
});

describe('DX-040-SURFACE: orm.from() with columns()', () => {
	it('SC-04: columns() selects specific columns with exact SQL', () => {
		const { users } = orm.tables;
		const dump = orm.from(users).columns(['id', 'name']).dump();
		expect(normalizeSQL(dump.sql)).toBe(
			'select users.id, users.name from users',
		);
		expect(dump.params).toEqual([]);
	});
});

describe('DX-040-SURFACE: orm.from() with include()', () => {
	it('SC-05: from() with include produces SQL with subquery for relation', () => {
		const { posts } = orm.tables;
		const dump = orm.from(posts).include('author').dump();
		// author is a belongsTo (authorId -> users.id): scalar subquery via json_agg
		expect(normalizeSQL(dump.sql)).toBe(
			'select posts.*, coalesce((select json_agg(to_jsonb(__t__) order by __t__.id asc nulls last) from users as __t__ where __t__.id = posts."authorid"), \'[]\'::json) as author_json from posts',
		);
		expect(dump.params).toEqual([]);
	});
});

describe('DX-040-SURFACE: orm.from() with union()', () => {
	it('SC-06: from() union produces UNION SQL with correct params', () => {
		const { users } = orm.tables;
		const q1 = orm.from(users).where(eq(users.active, true));
		const q2 = orm.from(users).where(eq(users.active, false));
		const dump = q1.union(q2).dump();
		expect(normalizeSQL(dump.sql)).toBe(
			'(select users.* from users where users.active = $1) union (select users.* from users where users.active = $2)',
		);
		expect(dump.params).toEqual([true, false]);
	});
});

describe('DX-040-SURFACE: typed mutations via TableRef', () => {
	it('SC-07: orm.into() produces exact INSERT SQL', () => {
		const { users } = orm.tables;
		const dump = orm
			.into(users)
			.values({ name: 'Alice', email: 'alice@example.com', active: true })
			.dump();
		expect(normalizeSQL(dump.sql)).toBe(
			'insert into users (name, email, active) values ($1, $2, $3)',
		);
		expect(dump.parameters).toEqual(['Alice', 'alice@example.com', true]);
	});

	it('SC-08: orm.modify() produces exact UPDATE SQL', () => {
		const { users } = orm.tables;
		const dump = orm
			.modify(users)
			.set({ active: false })
			.where(eq(users.id, 1))
			.dump();
		expect(normalizeSQL(dump.sql)).toBe(
			'update users set active = $1 where users.id = $2',
		);
		expect(dump.parameters).toEqual([false, 1]);
	});

	it('SC-09: orm.removeFrom() produces exact DELETE SQL', () => {
		const { users } = orm.tables;
		const dump = orm.removeFrom(users).where(eq(users.id, 1)).dump();
		expect(normalizeSQL(dump.sql)).toBe(
			'delete from users where users.id = $1',
		);
		expect(dump.parameters).toEqual([1]);
	});

	it('SC-10: orm.upsertInto() produces exact INSERT ... ON CONFLICT SQL', () => {
		const { users } = orm.tables;
		const dump = orm
			.upsertInto(users)
			.values({ name: 'Alice', email: 'alice@example.com', active: true })
			.onConflict(['email'])
			.doNothing()
			.dump();
		expect(normalizeSQL(dump.sql)).toBe(
			'insert into users (name, email, active) values ($1, $2, $3) on conflict (email) do nothing',
		);
		expect(dump.parameters).toEqual(['Alice', 'alice@example.com', true]);
	});

	it('SC-11: orm.from() still works after typed mutations are added (regression)', () => {
		const { users } = orm.tables;
		const dump = orm.from(users).where(eq(users.active, true)).dump();
		expect(normalizeSQL(dump.sql)).toBe(
			'select users.* from users where users.active = $1',
		);
		expect(dump.params).toEqual([true]);
	});

	it('SC-12: string-based select() is on public OrmInstance type', () => {
		// select() remains on public OrmInstance as the string-based table API
		orm.select('users');
	});

	it('SC-13: string-based insert() is not on public OrmInstance type', () => {
		// @ts-expect-error -- insert() is not on public OrmInstance
		orm.insert('users');
	});

	it('SC-14: string-based update() is not on public OrmInstance type', () => {
		// @ts-expect-error -- update() is not on public OrmInstance
		orm.update('users');
	});

	it('SC-15: string-based delete() is not on public OrmInstance type', () => {
		// @ts-expect-error -- delete() is not on public OrmInstance
		orm.delete('users');
	});

	it('SC-16: string-based upsert() is not on public OrmInstance type', () => {
		// @ts-expect-error -- upsert() is not on public OrmInstance
		orm.upsert('users');
	});
});

describe('DX-040-SURFACE: Type-level safety', () => {
	it('from() all() return type is Promise<array>', () => {
		const { users } = orm.tables;
		const query = orm.from(users);
		// Test type of the method reference, not the call (no DB execution)
		expectTypeOf(query.all).returns.resolves.toBeArray();
	});

	it('from() with where() all() return type is preserved', () => {
		const { users } = orm.tables;
		const query = orm.from(users).where(eq(users.active, true));
		expectTypeOf(query.all).returns.resolves.toBeArray();
	});

	it('eq() with ColumnRef rejects wrong value type (number column, string passed)', () => {
		const { users } = orm.tables;
		// Valid: number column with number value
		eq(users.id, 1);

		// @ts-expect-error — id is number (integer), not string
		eq(users.id, 'not a number');
	});

	it('eq() with boolean ColumnRef rejects non-boolean value', () => {
		const { users } = orm.tables;
		// Valid
		eq(users.active, true);

		// @ts-expect-error — active is boolean, not string
		eq(users.active, 'yes');
	});

	it('invalid column access on TableRef is a compile error', () => {
		const { users } = orm.tables;

		// @ts-expect-error — 'nonexistent' is not a column on users
		users.nonexistent;
	});

	it('into().values() rejects wrong column type', () => {
		const { users } = orm.tables;
		// Valid
		orm
			.into(users)
			.values({ name: 'Alice', email: 'test@test.com', active: true });

		// @ts-expect-error — active must be boolean, not string
		orm
			.into(users)
			.values({ name: 'Alice', email: 'test@test.com', active: 'not boolean' });
	});

	it('OrmInstance exposes string-based select()', () => {
		// select() remains on public OrmInstance as the string-based table API
		orm.select('users');
	});

	it('OrmInstance does not expose string-based insert()', () => {
		// @ts-expect-error — insert() is removed from public OrmInstance type
		orm.insert('users');
	});

	it('OrmInstance does not expose string-based update()', () => {
		// @ts-expect-error — update() is removed from public OrmInstance type
		orm.update('users');
	});

	it('OrmInstance does not expose string-based delete()', () => {
		// @ts-expect-error — delete() is removed from public OrmInstance type
		orm.delete('users');
	});

	it('OrmInstance does not expose string-based upsert()', () => {
		// @ts-expect-error — upsert() is removed from public OrmInstance type
		orm.upsert('users');
	});

	it('SC-17: from(users).all() infers exact row type without cast', () => {
		const { users } = orm.tables;
		const query = orm.from(users);
		// Must resolve to { id: number; name: string; email: string; active: boolean }[]
		// without any `as unknown as T` cast
		expectTypeOf(query.all).returns.resolves.toEqualTypeOf<
			{ id: number; name: string; email: string; active: boolean }[]
		>();
	});

	it('SC-18: from(users).columns([...]).all() infers Pick type without cast', () => {
		const { users } = orm.tables;
		const query = orm.from(users).columns(['id', 'name']);
		expectTypeOf(query.all).returns.resolves.toEqualTypeOf<
			Pick<
				{ id: number; name: string; email: string; active: boolean },
				'id' | 'name'
			>[]
		>();
	});
});
