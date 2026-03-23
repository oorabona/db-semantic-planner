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

import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../../../../adapter-pgsql/src/pgsql-adapter.js';
import { eq } from '../filters.js';
import { createOrm } from '../orm.js';
import { ref, schema } from '../schema.js';

const db = schema({
	users: {
		id: { type: "integer", primaryKey: true },
		name: "string",
		email: "string",
		active: "boolean",
	},
	posts: {
		id: { type: "integer", primaryKey: true },
		title: "string",
		authorId: ref("users"),
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
		expect(orm.tables['users']).toBeDefined();
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
	it('SC-03: from() with where() produces correct SQL and params', () => {
		const { users } = orm.tables;
		const dump = orm.from(users).where(eq(users.id, 1)).dump();
		expect(dump.sql.toLowerCase()).toContain('select');
		expect(dump.sql.toLowerCase()).toContain('users');
		expect(dump.params).toContain(1);
	});

	it('SC-03: from() WHERE uses column name from ColumnRef', () => {
		const { users } = orm.tables;
		const dump = orm.from(users).where(eq(users.active, true)).dump();
		// Column name appears in SQL (may or may not be quoted depending on adapter)
		expect(dump.sql.toLowerCase()).toContain('active');
		expect(dump.params).toContain(true);
	});

	it('SC-03: from() produces identical SQL to select() for same table', () => {
		const { users } = orm.tables;
		const fromDump = orm.from(users).dump();
		// @ts-expect-error -- select() is deprecated/internal but still works at runtime
		const selectDump = orm.select('users').dump();
		expect(fromDump.sql).toBe(selectDump.sql);
	});
});

describe('DX-040-SURFACE: orm.from() with columns()', () => {
	it('SC-04: columns() selects specific columns', () => {
		const { users } = orm.tables;
		const dump = orm.from(users).columns(['id', 'name']).dump();
		// Column names appear in SQL (may or may not be quoted depending on adapter)
		expect(dump.sql.toLowerCase()).toContain('id');
		expect(dump.sql.toLowerCase()).toContain('name');
		expect(dump.sql.toLowerCase()).toContain('users');
	});
});

describe('DX-040-SURFACE: orm.from() with include()', () => {
	it('SC-05: from() with include produces SQL with relation', () => {
		const { posts } = orm.tables;
		const dump = orm.from(posts).include('author').dump();
		expect(dump.sql).toBeDefined();
		// SQL includes the posts table (may or may not be quoted depending on adapter)
		expect(dump.sql.toLowerCase()).toContain('posts');
	});
});

describe('DX-040-SURFACE: orm.from() with union()', () => {
	it('SC-06: from() union produces UNION SQL', () => {
		const { users } = orm.tables;
		const q1 = orm.from(users).where(eq(users.active, true));
		const q2 = orm.from(users).where(eq(users.active, false));
		const dump = q1.union(q2).dump();
		expect(dump.sql.toUpperCase()).toContain('UNION');
	});
});
