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

type MutationWithWhere = UpdateIntent | DeleteIntent;

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
function compileNql(
	input: string,
	compilerOptions?: Parameters<typeof compile>[3],
): CompileResult {
	const result = compile(input, null, undefined, compilerOptions);
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
		const result = compileNql("update users set status = 'archived'", {
			allowUnfilteredMutations: true,
		});

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
		const result = compileNql('delete from users', {
			allowUnfilteredMutations: true,
		});

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

	it('upsert WHERE compiles compound predicates against the target table', () => {
		const validationSchema = {
			getTable(name: string) {
				const tables: Record<
					string,
					{ columns: { name: string }[]; pseudoColumns?: never[] }
				> = {
					users: {
						columns: [{ name: 'id' }, { name: 'name' }, { name: 'active' }],
					},
				};
				return tables[name];
			},
			getRelationsFrom() {
				return [];
			},
			getRelationsTo() {
				return [];
			},
		};
		const result = compile(
			"upsert into users on id set id = 1, name = 'John', active = true where active = true and name like 'J%'",
			validationSchema,
		);

		if (!result.success || !result.ast?.mutation) {
			throw new Error(`Compile error: ${result.errors[0]?.message}`);
		}
		const upsert = result.ast.mutation as UpsertIntent;
		expect(upsert.action.type).toBe('doUpdate');
		if (upsert.action.type !== 'doUpdate') return;
		const where = upsert.action.where as WhereAndIntent;
		expect(where.kind).toBe('and');
		expect(where.conditions).toHaveLength(2);
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
		expect(insert.returningItems).toBeUndefined();
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

// ===========================================================================
// resolveBindingsInWhere — NOT compound with binding ref
// ===========================================================================
describe('compile-mutation: resolveBindingsInWhere NOT compound', () => {
	it('resolves NOT IN with bound ref through NOT wrapper', () => {
		const result = compileNql(
			'users | where active = false | select id | bind inactive\nupdate users set active = true where not (id in (inactive))',
		);

		const update = result.mutation as UpdateIntent;
		expect(update.type).toBe('update');
		// NOT wraps an IN with subquery
		const where = update.where!;
		expect(where.kind).toBe('not');
	});

	it('resolves AND compound with binding ref in one leg', () => {
		const result = compileNql(
			'users | where active = false | select id | bind inactive\nupdate users set active = true where id in (inactive) and role = 1',
		);

		const update = result.mutation as UpdateIntent;
		const where = update.where! as WhereAndIntent;
		expect(where.kind).toBe('and');
		expect(where.conditions).toHaveLength(2);
		// First condition is IN with subquery (resolved from binding)
		const inWhere = where.conditions[0] as WhereInIntent;
		expect(inWhere.kind).toBe('in');
		expect(inWhere.subquery).toBeDefined();
	});

	it('resolves OR compound with binding ref in one leg', () => {
		const result = compileNql(
			'users | where active = false | select id | bind inactive\nupdate users set active = true where id in (inactive) or role = 1',
		);

		const update = result.mutation as UpdateIntent;
		const where = update.where!;
		expect(where.kind).toBe('or');
	});
});

// ===========================================================================
// RETURNING: non-field expression item returns alias
// ===========================================================================
describe('compile-mutation: RETURNING with alias', () => {
	it('returning column with alias uses alias name', () => {
		const result = compileNql(
			"insert into users set name = 'Alice' | select id as user_id",
		);

		const insert = result.mutation as InsertIntent;
		expect(insert.returning).toEqual(['user_id']);
		expect(insert.returningItems).toEqual([
			{ source: 'id', output: 'user_id' },
		]);
	});

	it('preserves self alias as an alias-aware item', () => {
		const result = compileNql(
			"insert into users set name = 'Alice' | select name as name",
		);

		const insert = result.mutation as InsertIntent;
		expect(insert.returning).toEqual(['name']);
		expect(insert.returningItems).toEqual([{ source: 'name', output: 'name' }]);
	});

	it('rejects mixed star and explicit RETURNING projections', () => {
		const result = compile(
			"insert into users set name = 'Alice' | select *, name as who",
			null,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(
			/Mutation RETURNING cannot mix `select \*` with explicit projection items/,
		);
	});

	it('rejects duplicate RETURNING output names', () => {
		const result = compile(
			"insert into users set name = 'Alice' | select id as x, name as x",
			null,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(
			/Mutation RETURNING has duplicate output name 'x'/,
		);
	});

	it('rejects aliased dotted RETURNING sources', () => {
		const result = compile(
			"insert into users set name = 'Alice' | select users.name as who",
			null,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(
			/Mutation RETURNING alias cannot use dotted source 'users\.name'/,
		);
	});

	it('canonicalizes aliased RETURNING source but preserves output verbatim', () => {
		const result = compile(
			'insert into users set user_id = 1 | select user_id as Contact | bind m\nm | select Contact',
			{
				getTable(name: string) {
					return name === 'users'
						? { columns: [{ name: 'userId' }, { name: 'email' }] }
						: undefined;
				},
				getRelationsFrom() {
					return [];
				},
			},
		);

		expect(result.success).toBe(true);
		expect(result.ast?.mutationBindings?.get('m')?.returning).toEqual([
			'Contact',
		]);
		expect(result.ast?.mutationBindings?.get('m')?.returningItems).toEqual([
			{ source: 'userId', output: 'Contact' },
		]);
	});
});

// ===========================================================================
// Insert from with optional fields
// ===========================================================================
describe('compile-mutation: insertFrom optional fields', () => {
	it('insert from without WHERE or limit omits them', () => {
		const result = compileNql('insert into archive from users');

		const insertFrom = result.mutation as InsertFromIntent;
		expect(insertFrom.type).toBe('insert_from');
		expect(insertFrom.where).toBeUndefined();
		expect(insertFrom.limit).toBeUndefined();
	});
});

// ===========================================================================
// Upsert from with optional fields
// ===========================================================================
describe('compile-mutation: upsertFrom optional fields', () => {
	it('upsert from without WHERE or limit omits them', () => {
		const result = compileNql('upsert into authors on id from activeAuthors');

		const upsertFrom = result.mutation as UpsertFromIntent;
		expect(upsertFrom.type).toBe('upsert_from');
		expect(upsertFrom.where).toBeUndefined();
		expect(upsertFrom.limit).toBeUndefined();
	});

	it('upsert from with multiple conflict columns in identList', () => {
		const result = compileNql(
			'upsert into events on (userId, eventType) from staging',
		);

		const upsertFrom = result.mutation as UpsertFromIntent;
		expect(upsertFrom.type).toBe('upsert_from');
		expect(upsertFrom.conflictColumns).toEqual(['userId', 'eventType']);
		expect(upsertFrom.source).toBe('staging');
	});

	it('upsert from with limit', () => {
		const result = compileNql(
			'upsert into authors on id from staging limit 100',
		);

		const upsertFrom = result.mutation as UpsertFromIntent;
		expect(upsertFrom.limit).toBe(100);
	});

	it('upsert from with WHERE', () => {
		const result = compileNql(
			'upsert into authors on id from staging where active = true',
		);

		const upsertFrom = result.mutation as UpsertFromIntent;
		expect(upsertFrom.where).toBeDefined();
	});
});

// ===========================================================================
// ROUND 2: extractReturningColumns with expression items (lines 270-273)
// ===========================================================================

describe('RETURNING with expression items', () => {
	it('RETURNING with aliased column returns alias', () => {
		const result = compileNql(
			"update users set name = 'bob' where id = 1 | select id, name as n",
		);

		expect(result.mutation).toBeDefined();
		const returning = result.mutation?.returning;
		expect(returning).toContain('n');
	});

	it('RETURNING * returns star', () => {
		const result = compileNql(
			"update users set name = 'bob' where id = 1 | select *",
		);

		expect(result.mutation).toBeDefined();
		expect(result.mutation?.returning).toContain('*');
	});
});

// ===========================================================================
// ROUND 2: extractReturningColumns validator branch (line 273)
// ===========================================================================

const schema = {
	getTable(name: string) {
		const tables: Record<
			string,
			{ columns: { name: string }[]; pseudoColumns?: never[] }
		> = {
			users: {
				columns: [
					{ name: 'id' },
					{ name: 'name' },
					{ name: 'email' },
					{ name: 'active' },
				],
			},
			staging: {
				columns: [{ name: 'id' }, { name: 'name' }, { name: 'email' }],
			},
		};
		return tables[name];
	},
	getRelationsFrom() {
		return [];
	},
	getRelationsTo() {
		return [];
	},
};

describe('RETURNING with schema validation', () => {
	it('validates RETURNING columns with schema (line 273)', () => {
		const result = compile(
			"update users set name = 'bob' where id = 1 | select id, name",
			schema,
		);

		expect(result.success).toBe(true);
		expect(result.ast?.mutation?.returning).toContain('id');
		expect(result.ast?.mutation?.returning).toContain('name');
	});
});

// ===========================================================================
// ROUND 2: resolveBindingsInWhere with branded IN binding (lines 296-308)
// ===========================================================================

describe('resolveBindingsInWhere with bound IN', () => {
	it('IN with bound CTE ref resolves to subquery (line 296-326)', () => {
		const result = compileNql(
			'users | select id | bind activeIds\ndelete from users where id in (activeIds)',
		);

		expect(result.mutation).toBeDefined();
		const where = (result.mutation as MutationWithWhere)?.where;
		expect(where).toBeDefined();
		expect(where?.kind).toBe('in');
		// The IN clause should have a subquery from the bound CTE
		const inWhere = where as WhereInIntent;
		expect(inWhere.subquery).toBeDefined();
		expect(inWhere.subquery?.from).toBe('activeIds');
	});

	it('IN with named-param $ref value remains a value, not a bound CTE subquery', () => {
		const refValue = { $ref: 'activeIds' };
		const result = compileNql(
			'users | select id | bind activeIds\ndelete from users where id in (:p)',
			{ params: { p: refValue } },
		);

		expect(result.mutation).toBeDefined();
		const where = (result.mutation as MutationWithWhere)?.where;
		expect(where).toBeDefined();
		expect(where?.kind).toBe('in');
		const inWhere = where as WhereInIntent;
		expect(inWhere.subquery).toBeUndefined();
		const values = (inWhere as { values: readonly unknown[] }).values;
		expect(values).toEqual([{ kind: 'param', value: refValue }]);
	});

	it('IN with bound ref in update resolves to subquery', () => {
		const result = compileNql(
			"users | where active = true | select id | bind validIds\nupdate users set status = 'archived' where id in (validIds)",
		);

		expect(result.mutation).toBeDefined();
		const where = (result.mutation as MutationWithWhere)?.where;
		expect(where).toBeDefined();
		expect(where?.kind).toBe('in');
		const inWhere = where as WhereInIntent;
		expect(inWhere.subquery).toBeDefined();
	});

	it('NOT wrapping around resolveBindingsInWhere (line 333-338)', () => {
		const result = compileNql(
			'users | select id | bind activeIds\ndelete from users where not id in (activeIds)',
		);

		expect(result.mutation).toBeDefined();
		const where = (result.mutation as MutationWithWhere)?.where;
		expect(where).toBeDefined();
		// NOT wraps the in clause
		expect(where?.kind).toBe('not');
	});

	it('AND/OR pass through resolveBindingsInWhere unchanged (line 340-370)', () => {
		const result = compileNql(
			'users | select id | bind activeIds\ndelete from users where id in (activeIds) and active = true',
		);

		expect(result.mutation).toBeDefined();
		const where = (result.mutation as MutationWithWhere)?.where;
		expect(where).toBeDefined();
		expect(where?.kind).toBe('and');
	});
});

// ===========================================================================
// ROUND 2: resolveBindingsInWhere NOT unchanged path (line 336)
// ===========================================================================

describe('resolveBindingsInWhere NOT path', () => {
	it('NOT wrapping non-IN condition passes through unchanged (line 336)', () => {
		const result = compileNql(
			"users | select id | bind ids\ndelete from users where not name = 'test'",
		);

		expect(result.mutation).toBeDefined();
		const where = (result.mutation as MutationWithWhere)?.where;
		expect(where?.kind).toBe('not');
	});
});

// ===========================================================================
// ROUND 2: resolveBindingsInWhere AND/OR unchanged (line 347)
// ===========================================================================

describe('resolveBindingsInWhere AND/OR unchanged', () => {
	it('AND with no bindings passes through unchanged (line 347)', () => {
		const result = compileNql(
			"users | select id | bind ids\ndelete from users where name = 'a' and email = 'b'",
		);

		expect(result.mutation).toBeDefined();
		const where = (result.mutation as MutationWithWhere)?.where;
		expect(where?.kind).toBe('and');
	});
});

// ===========================================================================
// ROUND 2: insert_from with sourceQuery from bindings (line 143)
// ===========================================================================

describe('insert_from with bound source', () => {
	it('insert from with preceding bind injects sourceQuery (line 143)', () => {
		const result = compileNql(
			'users | select id, name | bind source\ninsert into staging from source',
		);

		expect(result.mutation).toBeDefined();
		expect(result.mutation?.type).toBe('insert_from');
		const insertFrom = result.mutation as InsertFromIntent;
		expect(insertFrom.sourceQuery).toBeDefined();
	});
});

// ===========================================================================
// ROUND 2: upsert_from with sourceQuery from bindings (line 247)
// ===========================================================================

describe('upsert_from with bound source', () => {
	it('upsert from with preceding bind injects sourceQuery (line 247)', () => {
		const result = compileNql(
			'users | select id, name | bind source\nupsert into staging on id from source',
		);

		expect(result.mutation).toBeDefined();
		expect(result.mutation?.type).toBe('upsert_from');
		const upsertFrom = result.mutation as UpsertFromIntent;
		expect(upsertFrom.sourceQuery).toBeDefined();
	});
});
