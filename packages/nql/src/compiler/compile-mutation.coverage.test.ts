/**
 * Coverage tests for compile-mutation.ts — uncovered branches.
 *
 * Exercises: single-row insert, multi-row insert with column normalization,
 * update with/without WHERE, delete with/without WHERE, upsert, upsert with
 * multiple conflict columns, insert from with columns, insert from with
 * WHERE + limit, RETURNING (star, specific columns), mutation + bind,
 * mutationBindings map, extractBindName for mutationPipeline,
 * resolveBindingsInWhere (NOT, AND/OR compound).
 */

import type {
	DeleteIntent,
	InsertFromIntent,
	InsertIntent,
	UpdateIntent,
	UpsertFromIntent,
	UpsertIntent,
	WhereAndIntent,
	WhereComparisonIntent,
	WhereInIntent,
} from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { compile } from '../index.js';
import type { CompileResult } from './index.js';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
function compileNql(input: string): CompileResult {
	const result = compile(input, null);
	if (!result.success) {
		throw new Error(`Compile error: ${result.errors[0]?.message}`);
	}
	return result.ast!;
}

// ===========================================================================
// INSERT — single row
// ===========================================================================
describe('compile-mutation: INSERT single row', () => {
	it('compiles insert with multiple columns', () => {
		const result = compileNql(
			"insert into users set name = 'John', email = 'j@e.com', age = 30",
		);

		const insert = result.mutation as InsertIntent;
		expect(insert.type).toBe('insert');
		expect(insert.table).toBe('users');
		expect(insert.values).toHaveLength(1);
		expect(insert.values[0]).toEqual({
			name: 'John',
			email: 'j@e.com',
			age: 30,
		});
	});

	it('compiles insert with boolean and null values', () => {
		const result = compileNql(
			'insert into users set active = true, deleted_at = null',
		);

		const insert = result.mutation as InsertIntent;
		expect(insert.values[0]).toEqual({
			active: true,
			deleted_at: null,
		});
	});
});

// ===========================================================================
// INSERT — multi-row with column normalization
// ===========================================================================
describe('compile-mutation: INSERT multi-row', () => {
	it('pipe-set syntax produces multiple rows', () => {
		const result = compileNql(
			"insert into users set name = 'Alice' | set name = 'Bob'",
		);

		const insert = result.mutation as InsertIntent;
		expect(insert.type).toBe('insert');
		expect(insert.values).toHaveLength(2);
		expect(insert.values[0]!.name).toBe('Alice');
		expect(insert.values[1]!.name).toBe('Bob');
	});

	it('normalizes columns across rows (missing → undefined)', () => {
		const result = compileNql(
			"insert into users set name = 'Alice', email = 'a@b.com' | set name = 'Bob'",
		);

		const insert = result.mutation as InsertIntent;
		expect(insert.values).toHaveLength(2);

		// First row has both columns
		expect(insert.values[0]).toEqual({
			name: 'Alice',
			email: 'a@b.com',
		});

		// Second row: email normalized to undefined (→ NULL)
		expect(insert.values[1]!.name).toBe('Bob');
		expect('email' in insert.values[1]!).toBe(true);
		expect(insert.values[1]!.email).toBeUndefined();
	});

	it('normalizes columns when second row has extra columns', () => {
		const result = compileNql(
			"insert into users set name = 'Alice' | set name = 'Bob', role = 'admin'",
		);

		const insert = result.mutation as InsertIntent;
		expect(insert.values).toHaveLength(2);

		// First row: role normalized to undefined
		expect(insert.values[0]!.name).toBe('Alice');
		expect('role' in insert.values[0]!).toBe(true);
		expect(insert.values[0]!.role).toBeUndefined();

		// Second row has both
		expect(insert.values[1]).toEqual({ name: 'Bob', role: 'admin' });
	});

	it('SQL-style values syntax produces multiple rows', () => {
		const result = compileNql(
			"insert into users values (name = 'Alice'), (name = 'Bob')",
		);

		const insert = result.mutation as InsertIntent;
		expect(insert.values).toHaveLength(2);
		expect(insert.values[0]!.name).toBe('Alice');
		expect(insert.values[1]!.name).toBe('Bob');
	});
});

// ===========================================================================
// UPDATE
// ===========================================================================
describe('compile-mutation: UPDATE', () => {
	it('update with WHERE', () => {
		const result = compileNql('update users set active = false where id = 1');

		const update = result.mutation as UpdateIntent;
		expect(update.type).toBe('update');
		expect(update.table).toBe('users');
		expect(update.set).toEqual({ active: false });
		expect(update.where).toBeDefined();

		const where = update.where as WhereComparisonIntent;
		expect(where.kind).toBe('comparison');
		expect(where.field).toBe('id');
		expect(where.value).toBe(1);
	});

	it('update without WHERE sets allowAll', () => {
		const result = compileNql("update users set status = 'archived'");

		const update = result.mutation as UpdateIntent;
		expect(update.type).toBe('update');
		expect(update.where).toBeUndefined();
		expect(update.allowAll).toBe(true);
	});

	it('update with multiple set assignments', () => {
		const result = compileNql(
			"update users set name = 'New', active = true where id = 5",
		);

		const update = result.mutation as UpdateIntent;
		expect(update.set).toEqual({ name: 'New', active: true });
	});

	it('update with complex WHERE (AND)', () => {
		const result = compileNql(
			"update users set active = false where role = 'user' and age < 18",
		);

		const update = result.mutation as UpdateIntent;
		const where = update.where as WhereAndIntent;
		expect(where.kind).toBe('and');
		expect(where.conditions).toHaveLength(2);
	});
});

// ===========================================================================
// DELETE
// ===========================================================================
describe('compile-mutation: DELETE', () => {
	it('delete with WHERE', () => {
		const result = compileNql('delete from users where id = 1');

		const del = result.mutation as DeleteIntent;
		expect(del.type).toBe('delete');
		expect(del.table).toBe('users');
		expect(del.where).toBeDefined();
	});

	it('delete without WHERE sets allowAll', () => {
		const result = compileNql('delete from users');

		const del = result.mutation as DeleteIntent;
		expect(del.type).toBe('delete');
		expect(del.where).toBeUndefined();
		expect(del.allowAll).toBe(true);
	});

	it('delete with complex WHERE', () => {
		const result = compileNql(
			"delete from logs where created_at < '2024-01-01' and level = 'debug'",
		);

		const del = result.mutation as DeleteIntent;
		const where = del.where as WhereAndIntent;
		expect(where.kind).toBe('and');
	});
});

// ===========================================================================
// UPSERT
// ===========================================================================
describe('compile-mutation: UPSERT', () => {
	it('upsert with single conflict column', () => {
		const result = compileNql(
			"upsert into users on id set name = 'John', email = 'j@e.com'",
		);

		const upsert = result.mutation as UpsertIntent;
		expect(upsert.type).toBe('upsert');
		expect(upsert.table).toBe('users');
		expect(upsert.onConflict).toEqual({ columns: ['id'] });
		expect(upsert.values).toHaveLength(1);
		expect(upsert.values[0]).toEqual({ name: 'John', email: 'j@e.com' });
		expect(upsert.action).toEqual({
			type: 'doUpdate',
			set: { name: 'John', email: 'j@e.com' },
		});
	});

	it('upsert with multiple conflict columns', () => {
		const result = compileNql(
			'upsert into events on (userId, eventType) set count = 1',
		);

		const upsert = result.mutation as UpsertIntent;
		expect(upsert.onConflict).toEqual({
			columns: ['userId', 'eventType'],
		});
	});

	it('upsert with RETURNING', () => {
		const result = compileNql(
			"upsert into users on email set name = 'Alice', email = 'a@b.com' | select *",
		);

		const upsert = result.mutation as UpsertIntent;
		expect(upsert.returning).toBeDefined();
		expect(upsert.returning).toContain('*');
	});
});

// ===========================================================================
// UPSERT FROM
// ===========================================================================
describe('compile-mutation: UPSERT FROM', () => {
	it('upsert from basic', () => {
		const result = compileNql('upsert into authors on id from activeAuthors');

		const mutation = result.mutation as UpsertFromIntent;
		expect(mutation.type).toBe('upsert_from');
		expect(mutation.table).toBe('authors');
		expect(mutation.source).toBe('activeAuthors');
		expect(mutation.conflictColumns).toEqual(['id']);
	});

	it('upsert from with WHERE', () => {
		const result = compileNql(
			'upsert into authors on id from activeAuthors where active = true',
		);

		const mutation = result.mutation as UpsertFromIntent;
		expect(mutation.where).toBeDefined();
		const where = mutation.where as WhereComparisonIntent;
		expect(where.field).toBe('active');
	});
});

// ===========================================================================
// INSERT FROM
// ===========================================================================
describe('compile-mutation: INSERT FROM', () => {
	it('insert from basic', () => {
		const result = compileNql('insert into archive from users');

		const insertFrom = result.mutation as InsertFromIntent;
		expect(insertFrom.type).toBe('insert_from');
		expect(insertFrom.table).toBe('archive');
		expect(insertFrom.source).toBe('users');
	});

	it('insert from with WHERE and limit', () => {
		const result = compileNql(
			'insert into archive from users where active = false limit 50',
		);

		const insertFrom = result.mutation as InsertFromIntent;
		expect(insertFrom.where).toBeDefined();
		expect(insertFrom.limit).toBe(50);
	});

	it('insert from with RETURNING', () => {
		const result = compileNql(
			'insert into archive from users | select id, name',
		);

		const insertFrom = result.mutation as InsertFromIntent;
		expect(insertFrom.returning).toBeDefined();
		expect(insertFrom.returning).toContain('id');
		expect(insertFrom.returning).toContain('name');
	});

	it('insert from with star RETURNING', () => {
		const result = compileNql('insert into archive from users | select *');

		const insertFrom = result.mutation as InsertFromIntent;
		expect(insertFrom.returning).toContain('*');
	});
});

// ===========================================================================
// RETURNING — multiple columns, star
// ===========================================================================
describe('compile-mutation: RETURNING clause', () => {
	it('insert with single RETURNING column', () => {
		const result = compileNql(
			"insert into users set name = 'John' | select id",
		);

		const insert = result.mutation as InsertIntent;
		expect(insert.returning).toEqual(['id']);
	});

	it('insert with multiple RETURNING columns', () => {
		const result = compileNql(
			"insert into users set name = 'John' | select id, name, created_at",
		);

		const insert = result.mutation as InsertIntent;
		expect(insert.returning).toEqual(['id', 'name', 'created_at']);
	});

	it('insert with star RETURNING', () => {
		const result = compileNql("insert into users set name = 'John' | select *");

		const insert = result.mutation as InsertIntent;
		expect(insert.returning).toEqual(['*']);
	});

	it('update with RETURNING', () => {
		const result = compileNql(
			'update users set active = false where id = 1 | select id, active',
		);

		const update = result.mutation as UpdateIntent;
		expect(update.returning).toContain('id');
		expect(update.returning).toContain('active');
	});

	it('delete with RETURNING', () => {
		const result = compileNql('delete from users where id = 1 | select id');

		const del = result.mutation as DeleteIntent;
		expect(del.returning).toEqual(['id']);
	});
});

// ===========================================================================
// Multi-statement: bind with mutation RETURNING → mutationBindings
// ===========================================================================
describe('compile-mutation: bind with mutation RETURNING', () => {
	it('mutation with RETURNING + bind populates mutationBindings', () => {
		const result = compileNql(
			"insert into users set name = 'Alice' | select id | bind newUser\nusers | where id in (newUser)",
		);

		expect(result.bindings).toBeDefined();
		expect(result.bindings!.has('newUser')).toBe(true);
		expect(result.mutationBindings).toBeDefined();
		expect(result.mutationBindings!.has('newUser')).toBe(true);

		const mutBind = result.mutationBindings!.get('newUser')!;
		expect(mutBind.type).toBe('insert');
	});

	it('bound mutation query is usable in subsequent WHERE IN', () => {
		const result = compileNql(
			"insert into users set name = 'Alice' | select id | bind newUser\nusers | where id in (newUser)",
		);

		// Final statement is a query
		expect(result.query).toBeDefined();
		expect(result.query!.from).toBe('users');
	});

	it('multi-statement with query bind (no mutationBindings)', () => {
		const result = compileNql(
			'users | select id | bind subset\norders | where userId in (subset)',
		);

		expect(result.bindings).toBeDefined();
		expect(result.bindings!.has('subset')).toBe(true);
		// No mutation bindings since it was a query, not a mutation
		expect(result.mutationBindings).toBeUndefined();
	});
});

// ===========================================================================
// resolveBindingsInWhere — compound binding resolution
// ===========================================================================
describe('compile-mutation: resolveBindingsInWhere', () => {
	it('resolves binding ref in update WHERE IN', () => {
		const result = compileNql(
			'users | where active = false | select id | bind inactive\nupdate users set active = true where id in (inactive)',
		);

		const update = result.mutation as UpdateIntent;
		expect(update.type).toBe('update');
		const where = update.where as WhereInIntent;
		expect(where.kind).toBe('in');
		expect(where.subquery).toBeDefined();
		expect(where.subquery!.from).toBe('inactive');
	});

	it('resolves binding ref in delete WHERE IN', () => {
		const result = compileNql(
			"logs | where level = 'debug' | select id | bind debugLogs\ndelete from logs where id in (debugLogs)",
		);

		const del = result.mutation as DeleteIntent;
		expect(del.type).toBe('delete');
		const where = del.where as WhereInIntent;
		expect(where.kind).toBe('in');
		expect(where.subquery).toBeDefined();
	});
});

// ===========================================================================
// extractBindName for mutationPipeline
// ===========================================================================
describe('compile-mutation: extractBindName', () => {
	it('bind on mutation pipeline extracts name', () => {
		const result = compileNql(
			"insert into users set name = 'Alice' | select id | bind created\nusers | where id in (created)",
		);

		expect(result.bindings).toBeDefined();
		expect(result.bindings!.has('created')).toBe(true);
	});

	it('bind on query pipeline extracts name', () => {
		const result = compileNql(
			'users | select id | bind allIds\norders | where userId in (allIds)',
		);

		expect(result.bindings).toBeDefined();
		expect(result.bindings!.has('allIds')).toBe(true);
	});
});

// ===========================================================================
// Empty program
// ===========================================================================
describe('compile-mutation: edge cases', () => {
	it('insert with function value (e.g., now())', () => {
		const result = compileNql(
			"insert into events set name = 'click', created_at = now()",
		);

		const insert = result.mutation as InsertIntent;
		expect(insert.values[0]!.name).toBe('click');
		// now() in value context → special $fn object
		expect(insert.values[0]!.created_at).toEqual({
			$fn: 'now',
			$args: [],
		});
	});

	it('update with function value', () => {
		const result = compileNql(
			'update users set updated_at = now() where id = 1',
		);

		const update = result.mutation as UpdateIntent;
		expect(update.set.updated_at).toEqual({
			$fn: 'now',
			$args: [],
		});
	});

	it('insert with negative number value', () => {
		const result = compileNql('insert into adjustments set amount = -100');

		const insert = result.mutation as InsertIntent;
		expect(insert.values[0]!.amount).toBe(-100);
	});
});
