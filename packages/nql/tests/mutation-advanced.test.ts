/**
 * NQL Mutation Advanced Tests
 *
 * Tests for subquery-in-WHERE on mutations, RETURNING via pipe,
 * and insert-from patterns at the NQL → Intent level.
 */

import { describe, expect, it } from 'vitest';
import type {
	DeleteIntent,
	InsertFromIntent,
	InsertIntent,
	UpdateIntent,
	UpsertFromIntent,
	UpsertIntent,
	WhereComparisonIntent,
	WhereInIntent,
	WhereNotIntent,
} from '../src/compiler/index.js';
import { compile } from '../src/index.js';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
function compileNql(input: string) {
	const result = compile(input, null);
	if (!result.success) {
		throw new Error(`Compile error: ${result.errors[0]?.message}`);
	}
	return result.ast!;
}

// ===========================================================================
// A: Subquery in WHERE on mutations
// ===========================================================================
describe('NQL Mutation - Subquery in WHERE', () => {
	it('A1: update with id in (subquery)', () => {
		const result = compileNql(
			'update users set active = false where id in (posts | where published = false | select userId)',
		);

		const update = result.mutation as UpdateIntent;
		expect(update.type).toBe('update');
		expect(update.table).toBe('users');
		expect(update.set).toEqual({ active: false });

		const where = update.where as WhereInIntent;
		expect(where.kind).toBe('in');
		expect(where.field).toBe('id');
		expect(where.subquery).toBeDefined();
		expect(where.subquery!.from).toBe('posts');
	});

	it('A2: update with id not in (subquery)', () => {
		const result = compileNql(
			'update users set active = false where id not in (posts | where published = true | select userId)',
		);

		const update = result.mutation as UpdateIntent;
		expect(update.type).toBe('update');

		const where = update.where as WhereNotIntent;
		expect(where.kind).toBe('not');
		const inner = where.condition as WhereInIntent;
		expect(inner.kind).toBe('in');
		expect(inner.subquery).toBeDefined();
		expect(inner.subquery!.from).toBe('posts');
	});

	it('A3: delete with postId in (subquery)', () => {
		const result = compileNql(
			'delete from comments where postId in (posts | where published = false | select id)',
		);

		const del = result.mutation as DeleteIntent;
		expect(del.type).toBe('delete');
		expect(del.table).toBe('comments');

		const where = del.where as WhereInIntent;
		expect(where.kind).toBe('in');
		expect(where.field).toBe('postId');
		expect(where.subquery).toBeDefined();
		expect(where.subquery!.from).toBe('posts');
	});

	it('A4: delete with id not in (subquery)', () => {
		const result = compileNql(
			'delete from permissions where id not in (rolePermissions | select permissionId)',
		);

		const del = result.mutation as DeleteIntent;
		expect(del.type).toBe('delete');

		const where = del.where as WhereNotIntent;
		expect(where.kind).toBe('not');
		const inner = where.condition as WhereInIntent;
		expect(inner.kind).toBe('in');
		expect(inner.subquery).toBeDefined();
		expect(inner.subquery!.from).toBe('rolePermissions');
	});

	it('A5: delete with subquery having orderBy and limit', () => {
		const result = compileNql(
			'delete from users where id in (orders | select userId | order by createdAt desc | limit 10)',
		);

		const del = result.mutation as DeleteIntent;
		const where = del.where as WhereInIntent;
		expect(where.subquery).toBeDefined();
		expect(where.subquery!.orderBy).toBeDefined();
		expect(where.subquery!.orderBy).toHaveLength(1);
		expect(where.subquery!.orderBy![0]!.field).toBe('createdAt');
		expect(where.subquery!.orderBy![0]!.direction).toBe('desc');
		expect(where.subquery!.limit).toBe(10);
	});
});

// ===========================================================================
// B: RETURNING via pipe (| select)
// ===========================================================================
describe('NQL Mutation - RETURNING via pipe', () => {
	it('B1: insert with | select *', () => {
		const result = compileNql(
			"insert into users set name = 'Alice' | select *",
		);

		const insert = result.mutation as InsertIntent;
		expect(insert.type).toBe('insert');
		expect(insert.returning).toBeDefined();
		expect(insert.returning).toContain('*');
	});

	it('B2: insert with | select id, name', () => {
		const result = compileNql(
			"insert into users set name = 'Alice' | select id, name",
		);

		const insert = result.mutation as InsertIntent;
		expect(insert.returning).toBeDefined();
		expect(insert.returning).toContain('id');
		expect(insert.returning).toContain('name');
	});

	it('B3: update with | select id', () => {
		const result = compileNql(
			'update users set active = false where id = 1 | select id',
		);

		const update = result.mutation as UpdateIntent;
		expect(update.returning).toBeDefined();
		expect(update.returning).toContain('id');
	});

	it('B4: delete with | select id', () => {
		const result = compileNql('delete from users where id = 1 | select id');

		const del = result.mutation as DeleteIntent;
		expect(del.returning).toBeDefined();
		expect(del.returning).toContain('id');
	});

	it('B5: upsert with | select *', () => {
		const result = compileNql(
			"upsert into users on email set name = 'Alice', email = 'a@b.com' | select *",
		);

		const upsert = result.mutation as UpsertIntent;
		expect(upsert.returning).toBeDefined();
		expect(upsert.returning).toContain('*');
	});
});

// ===========================================================================
// C: Insert from
// ===========================================================================
describe('NQL Mutation - Insert from', () => {
	it('C1: simple insert from', () => {
		const result = compileNql('insert into archivedPosts from posts');

		const insertFrom = result.mutation as InsertFromIntent;
		expect(insertFrom.type).toBe('insert_from');
		expect(insertFrom.table).toBe('archivedPosts');
		expect(insertFrom.source).toBe('posts');
	});

	it('C2: insert from with where', () => {
		const result = compileNql(
			'insert into archivedPosts from posts where published = false',
		);

		const insertFrom = result.mutation as InsertFromIntent;
		expect(insertFrom.type).toBe('insert_from');
		expect(insertFrom.where).toBeDefined();
		const where = insertFrom.where as WhereComparisonIntent;
		expect(where.field).toBe('published');
		expect(where.operator).toBe('eq');
		expect(where.value).toBe(false);
	});

	it('C3: insert from with where and limit', () => {
		const result = compileNql(
			'insert into archivedPosts from posts where published = false limit 100',
		);

		const insertFrom = result.mutation as InsertFromIntent;
		expect(insertFrom.type).toBe('insert_from');
		expect(insertFrom.where).toBeDefined();
		expect(insertFrom.limit).toBe(100);
	});
});

// ---------------------------------------------------------------------------
// D: Bind clause on queries (Block 3)
// ---------------------------------------------------------------------------
describe('D: Bind clause on queries', () => {
	it('D1: query with | bind parses and compiles', () => {
		const result = compileNql('posts | select userId | bind subset');

		// The last statement is a query — bind is metadata, doesn't change the query intent
		expect(result.query).toBeDefined();
		expect(result.query!.from).toBe('posts');
	});

	it('D2: multi-statement bind + insert from resolves sourceQuery', () => {
		const result = compileNql(
			'posts | where active = true | select userId | bind active\ninsert into archive from active',
		);

		// The final result is the insert_from mutation
		expect(result.mutation).toBeDefined();
		const insertFrom = result.mutation as InsertFromIntent;
		expect(insertFrom.type).toBe('insert_from');
		expect(insertFrom.source).toBe('active');
		expect(insertFrom.sourceQuery).toBeDefined();
		expect(insertFrom.sourceQuery!.from).toBe('posts');
	});

	it('D2b: bindings map is populated on multi-statement programs', () => {
		const result = compileNql(
			'posts | select userId | bind counts\ninsert into archive from counts',
		);

		expect(result.bindings).toBeDefined();
		expect(result.bindings!.size).toBe(1);
		expect(result.bindings!.has('counts')).toBe(true);
		expect(result.bindings!.get('counts')!.from).toBe('posts');
	});

	it('D2c: single statement with bind has no bindings map', () => {
		const result = compileNql('posts | select userId | bind subset');

		// Single statement — bindings not populated (fast path)
		expect(result.bindings).toBeUndefined();
	});
});

describe('E: Upsert from', () => {
	it('E1: upsert into X on Y from Z parses and compiles', () => {
		const result = compileNql('upsert into authors on id from activeAuthors');

		// Arrange + Assert
		expect(result.mutation).toBeDefined();
		const mutation = result.mutation as UpsertFromIntent;
		expect(mutation.type).toBe('upsert_from');
		expect(mutation.table).toBe('authors');
		expect(mutation.source).toBe('activeAuthors');
		expect(mutation.conflictColumns).toEqual(['id']);
	});

	it('E2: upsert from with WHERE clause', () => {
		const result = compileNql(
			'upsert into authors on id from activeAuthors where active = true',
		);

		const mutation = result.mutation as UpsertFromIntent;
		expect(mutation.type).toBe('upsert_from');
		expect(mutation.table).toBe('authors');
		expect(mutation.source).toBe('activeAuthors');
		expect(mutation.conflictColumns).toEqual(['id']);
		expect(mutation.where).toBeDefined();
		const where = mutation.where as WhereComparisonIntent;
		expect(where.kind).toBe('comparison');
		expect(where.field).toBe('active');
		expect(where.value).toBe(true);
	});

	it('E3: multi-statement bind + upsert from resolves sourceQuery', () => {
		const nql = `
			posts | select userId, count(*) as postCount | group by userId | bind counts
			upsert into authors on id from counts
		`;
		const result = compileNql(nql);

		// Final statement is the upsert
		const mutation = result.mutation as UpsertFromIntent;
		expect(mutation.type).toBe('upsert_from');
		expect(mutation.table).toBe('authors');
		expect(mutation.source).toBe('counts');
		expect(mutation.conflictColumns).toEqual(['id']);

		// sourceQuery should be resolved from the bound query
		expect(mutation.sourceQuery).toBeDefined();
		expect(mutation.sourceQuery!.from).toBe('posts');

		// Bindings map should be populated
		expect(result.bindings).toBeDefined();
		expect(result.bindings!.has('counts')).toBe(true);
	});

	it('E4: upsert from with multiple conflict columns', () => {
		const result = compileNql(
			'upsert into authors on (id, email) from activeAuthors',
		);

		const mutation = result.mutation as UpsertFromIntent;
		expect(mutation.type).toBe('upsert_from');
		expect(mutation.conflictColumns).toEqual(['id', 'email']);
	});

	it('E5: upsert from with LIMIT', () => {
		const result = compileNql(
			'upsert into authors on id from activeAuthors limit 100',
		);

		const mutation = result.mutation as UpsertFromIntent;
		expect(mutation.type).toBe('upsert_from');
		expect(mutation.limit).toBe(100);
	});
});
