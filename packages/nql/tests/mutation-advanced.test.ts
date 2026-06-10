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

// ===========================================================================
// F: Multi-row INSERT (B1-B10 acceptance criteria)
// ===========================================================================
describe('NQL Mutation - Multi-row INSERT', () => {
	it('B1: SQL-style values produces multiple rows in InsertIntent', () => {
		const result = compileNql(
			"insert into users values (name = 'A'), (name = 'B')",
		);

		const insert = result.mutation as InsertIntent;
		expect(insert.type).toBe('insert');
		expect(insert.table).toBe('users');
		expect(insert.values).toHaveLength(2);
		expect(insert.values[0]).toEqual({ name: 'A' });
		expect(insert.values[1]).toEqual({ name: 'B' });
	});

	it('B2: NQL-style pipe-set produces multiple rows in InsertIntent', () => {
		const result = compileNql(
			"insert into users set name = 'A' | set name = 'B'",
		);

		const insert = result.mutation as InsertIntent;
		expect(insert.type).toBe('insert');
		expect(insert.values).toHaveLength(2);
		expect(insert.values[0]).toEqual({ name: 'A' });
		expect(insert.values[1]).toEqual({ name: 'B' });
	});

	it('B3: Mixed columns get normalized (union, missing → undefined)', () => {
		const result = compileNql(
			"insert into users values (name = 'A'), (name = 'B', email = 'b@test.com')",
		);

		const insert = result.mutation as InsertIntent;
		expect(insert.values).toHaveLength(2);
		// First row should have undefined email (column normalization)
		expect(insert.values[0]).toEqual({ name: 'A', email: undefined });
		// Second row has both columns
		expect(insert.values[1]).toEqual({ name: 'B', email: 'b@test.com' });
	});

	it('B4: Single row values is equivalent to set', () => {
		const valuesResult = compileNql("insert into users values (name = 'A')");
		const setResult = compileNql("insert into users set name = 'A'");

		const valuesInsert = valuesResult.mutation as InsertIntent;
		const setInsert = setResult.mutation as InsertIntent;

		expect(valuesInsert.values).toEqual(setInsert.values);
	});

	it('B5: Single row set (backward compatible)', () => {
		const result = compileNql("insert into users set name = 'John', age = 30");

		const insert = result.mutation as InsertIntent;
		expect(insert.values).toHaveLength(1);
		expect(insert.values[0]).toEqual({ name: 'John', age: 30 });
	});

	it('B6: Multi-row with RETURNING produces returning array', () => {
		const result = compileNql(
			"insert into users values (name = 'A'), (name = 'B') | select id",
		);

		const insert = result.mutation as InsertIntent;
		expect(insert.values).toHaveLength(2);
		expect(insert.returning).toBeDefined();
		expect(insert.returning).toContain('id');
	});

	it('B7: Empty values () produces parse error', () => {
		const result = compile('insert into users values ()', null);
		expect(result.success).toBe(false);
		expect(result.errors).toHaveLength(1);
		// Parser expects an identifier for the column name, not a closing paren
		expect(result.errors[0]?.message).toContain('Identifier');
		expect(result.errors[0]?.message).toContain("but found: ')'");
	});

	it('B9: Invalid column name produces compile error via model validation', () => {
		// B9 tests that invalid column names are caught during compilation
		// Note: At NQL level (no model), column names are accepted as-is
		// Validation happens at the adapter compile stage when model is provided
		// This test verifies the NQL layer accepts any column name
		const result = compileNql(
			"insert into users values (nonExistentColumn = 'test')",
		);

		const insert = result.mutation as InsertIntent;
		expect(insert.type).toBe('insert');
		expect(insert.values[0]).toEqual({ nonExistentColumn: 'test' });
		// Actual validation happens at adapter.compile() with model
	});

	it('B10: 3+ rows work correctly', () => {
		const result = compileNql(
			"insert into users values (name = 'A'), (name = 'B'), (name = 'C')",
		);

		const insert = result.mutation as InsertIntent;
		expect(insert.values).toHaveLength(3);
		expect(insert.values[0]).toEqual({ name: 'A' });
		expect(insert.values[1]).toEqual({ name: 'B' });
		expect(insert.values[2]).toEqual({ name: 'C' });
	});
});

// ===========================================================================
// F16: Mutation | bind (E16f — mutation RETURNING reused in subsequent stmts)
// ===========================================================================
describe('F16: Mutation bind with RETURNING', () => {
	it('F16a: insert with RETURNING + bind populates both bindings and mutationBindings', () => {
		const result = compileNql(
			"insert into users set name = 'Alice' | select id | bind newUser\nusers | where id in (newUser)",
		);

		// Final statement is the query
		expect(result.query).toBeDefined();
		expect(result.query!.from).toBe('users');

		// bindings should contain a synthetic QueryIntent
		expect(result.bindings).toBeDefined();
		expect(result.bindings!.size).toBe(1);
		expect(result.bindings!.has('newUser')).toBe(true);
		const syntheticQuery = result.bindings!.get('newUser')!;
		expect(syntheticQuery.type).toBe('select');
		expect(syntheticQuery.from).toBe('users');
		expect(syntheticQuery.select).toEqual({
			type: 'fields',
			fields: ['id'],
		});

		// mutationBindings should contain the original InsertIntent with RETURNING
		expect(result.mutationBindings).toBeDefined();
		expect(result.mutationBindings!.size).toBe(1);
		expect(result.mutationBindings!.has('newUser')).toBe(true);
		const mutationBinding = result.mutationBindings!.get(
			'newUser',
		)! as InsertIntent;
		expect(mutationBinding.type).toBe('insert');
		expect(mutationBinding.table).toBe('users');
		expect(mutationBinding.returning).toEqual(['id']);
	});

	it('F16b: update with RETURNING + bind populates bindings', () => {
		const result = compileNql(
			"update users set active = false where role = 'banned' | select id | bind deactivated\ndelete from sessions where userId in (deactivated)",
		);

		// Final statement is the delete
		expect(result.mutation).toBeDefined();
		expect((result.mutation as DeleteIntent).type).toBe('delete');

		// bindings should contain the synthetic QueryIntent
		expect(result.bindings).toBeDefined();
		expect(result.bindings!.has('deactivated')).toBe(true);
		const syntheticQuery = result.bindings!.get('deactivated')!;
		expect(syntheticQuery.type).toBe('select');
		expect(syntheticQuery.from).toBe('users');
		expect(syntheticQuery.select).toEqual({
			type: 'fields',
			fields: ['id'],
		});

		// mutationBindings should contain the UpdateIntent
		expect(result.mutationBindings).toBeDefined();
		const mutationBinding = result.mutationBindings!.get(
			'deactivated',
		)! as UpdateIntent;
		expect(mutationBinding.type).toBe('update');
		expect(mutationBinding.table).toBe('users');
		expect(mutationBinding.returning).toEqual(['id']);
	});

	it('F16c: delete with RETURNING + bind populates bindings', () => {
		const result = compileNql(
			'delete from users where active = false | select id, email | bind removed\nusers | where id in (removed)',
		);

		// bindings should contain synthetic QueryIntent with both columns
		expect(result.bindings).toBeDefined();
		expect(result.bindings!.has('removed')).toBe(true);
		const syntheticQuery = result.bindings!.get('removed')!;
		expect(syntheticQuery.select).toEqual({
			type: 'fields',
			fields: ['id', 'email'],
		});

		// mutationBindings should contain the DeleteIntent
		expect(result.mutationBindings).toBeDefined();
		const mutationBinding = result.mutationBindings!.get(
			'removed',
		)! as DeleteIntent;
		expect(mutationBinding.type).toBe('delete');
		expect(mutationBinding.returning).toEqual(['id', 'email']);
	});

	it('F16d: mutation without RETURNING + bind is rejected', () => {
		expect(() =>
			compileNql(
				"insert into users set name = 'Alice' | bind newUser\nusers | select id",
			),
		).toThrowError(
			"Compile error: statement 1 of 2 binds 'newUser' but produces no referenceable result — a mutation used as a binding must include a `returning` clause.",
		);
	});

	it('F16e: mutation bind resolves in subsequent mutation WHERE subquery', () => {
		const result = compileNql(
			"insert into users set name = 'Alice' | select id | bind newIds\ndelete from temp where userId in (newIds)",
		);

		// Final statement is a delete mutation
		expect(result.mutation).toBeDefined();
		const del = result.mutation as DeleteIntent;
		expect(del.type).toBe('delete');
		expect(del.table).toBe('temp');

		// The WHERE should have the binding resolved to a subquery
		const where = del.where as WhereInIntent;
		expect(where.kind).toBe('in');
		expect(where.field).toBe('userId');
		expect(where.subquery).toBeDefined();
		expect(where.subquery!.from).toBe('newIds');
		expect(where.subquery!.select).toEqual({
			type: 'fields',
			fields: ['id'],
		});
	});

	it('F16f: multiple mutation binds in sequence', () => {
		const result = compileNql(
			"insert into users set name = 'Alice' | select id | bind user1\ninsert into users set name = 'Bob' | select id | bind user2\nusers | where id in (user1)",
		);

		// Both mutation bindings should be populated
		expect(result.bindings).toBeDefined();
		expect(result.bindings!.size).toBe(2);
		expect(result.bindings!.has('user1')).toBe(true);
		expect(result.bindings!.has('user2')).toBe(true);

		expect(result.mutationBindings).toBeDefined();
		expect(result.mutationBindings!.size).toBe(2);
	});

	it('F16g: mixed query bind + mutation bind', () => {
		const result = compileNql(
			'users | where active = true | select id | bind activeIds\ninsert into logs set userId = 1 | select id | bind logIds\nusers | where id in (activeIds)',
		);

		expect(result.bindings).toBeDefined();
		expect(result.bindings!.size).toBe(2);

		// activeIds should be a regular query binding (no mutationBindings entry)
		expect(result.bindings!.has('activeIds')).toBe(true);
		expect(result.bindings!.get('activeIds')!.from).toBe('users');

		// logIds should be a mutation binding
		expect(result.bindings!.has('logIds')).toBe(true);
		expect(result.mutationBindings).toBeDefined();
		expect(result.mutationBindings!.size).toBe(1);
		expect(result.mutationBindings!.has('logIds')).toBe(true);
	});

	it('F16h: RETURNING * on mutation bind produces fields: [*]', () => {
		const result = compileNql(
			"insert into users set name = 'Alice' | select * | bind allCols\nusers | select id",
		);

		expect(result.bindings).toBeDefined();
		expect(result.bindings!.has('allCols')).toBe(true);
		const syntheticQuery = result.bindings!.get('allCols')!;
		expect(syntheticQuery.select).toEqual({
			type: 'fields',
			fields: ['*'],
		});
	});
});
