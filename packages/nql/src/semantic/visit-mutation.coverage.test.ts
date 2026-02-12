import { describe, expect, it } from 'vitest';
import { compile, parse } from '../index.js';

/**
 * Coverage tests for visit-mutation.ts branches.
 * Exercises INSERT, UPDATE, DELETE, UPSERT, INSERT FROM, UPSERT FROM,
 * multi-row INSERT, RETURNING, BIND via parse() / compile().
 */

function parseNql(input: string) {
	const result = parse(input);
	if (!result.success)
		throw new Error(`Parse error: ${result.errors[0]?.message}`);
	return result.ast!;
}

function compileNql(input: string) {
	const result = compile(input, null);
	if (!result.success)
		throw new Error(`Compile error: ${result.errors[0]?.message}`);
	return result.ast!;
}

// ============================================================
// INSERT — single row (set syntax)
// ============================================================

describe('visit-mutation: INSERT', () => {
	it('parses INSERT with set syntax', () => {
		const ast = parseNql(
			"insert into users set name = 'John', email = 'j@e.com'",
		);
		expect(ast.statements).toHaveLength(1);
		const stmt = ast.statements[0]!;
		expect(stmt.type).toBe('mutationPipeline');
		if (stmt.type !== 'mutationPipeline') return;
		const mutation = stmt.mutation;
		expect(mutation.type).toBe('insert');
		if (mutation.type !== 'insert') return;
		expect(mutation.table).toBe('users');
		expect(mutation.rows).toHaveLength(1);
		expect(mutation.rows[0]).toHaveLength(2);
		expect(mutation.rows[0]![0]!.column).toBe('name');
		expect(mutation.rows[0]![1]!.column).toBe('email');
	});

	it('parses INSERT multi-row via pipe set syntax', () => {
		const ast = parseNql(
			"insert into users set name = 'John' | set name = 'Jane'",
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'mutationPipeline') return;
		const mutation = stmt.mutation;
		expect(mutation.type).toBe('insert');
		if (mutation.type !== 'insert') return;
		expect(mutation.rows).toHaveLength(2);
		if (mutation.rows[0]![0]!.value.type === 'string') {
			expect(mutation.rows[0]![0]!.value.value).toBe('John');
		}
		if (mutation.rows[1]![0]!.value.type === 'string') {
			expect(mutation.rows[1]![0]!.value.value).toBe('Jane');
		}
	});

	it('parses INSERT multi-row via values tuple syntax', () => {
		const ast = parseNql(
			"insert into users values (name = 'John', email = 'j@e.com'), (name = 'Jane', email = 'jane@e.com')",
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'mutationPipeline') return;
		const mutation = stmt.mutation;
		expect(mutation.type).toBe('insert');
		if (mutation.type !== 'insert') return;
		expect(mutation.rows).toHaveLength(2);
		expect(mutation.rows[0]).toHaveLength(2);
		expect(mutation.rows[1]).toHaveLength(2);
	});
});

// ============================================================
// UPDATE
// ============================================================

describe('visit-mutation: UPDATE', () => {
	it('parses UPDATE with WHERE', () => {
		const ast = parseNql("update users set name = 'John' where id = 1");
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'mutationPipeline') return;
		const mutation = stmt.mutation;
		expect(mutation.type).toBe('update');
		if (mutation.type !== 'update') return;
		expect(mutation.table).toBe('users');
		expect(mutation.assignments).toHaveLength(1);
		expect(mutation.where).toBeDefined();
	});

	it('parses UPDATE without WHERE', () => {
		const ast = parseNql('update users set active = false');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'mutationPipeline') return;
		const mutation = stmt.mutation;
		expect(mutation.type).toBe('update');
		if (mutation.type !== 'update') return;
		expect(mutation.where).toBeUndefined();
	});

	it('parses UPDATE with multiple assignments', () => {
		const ast = parseNql(
			"update users set name = 'John', email = 'j@e.com' where id = 1",
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'mutationPipeline') return;
		const mutation = stmt.mutation;
		if (mutation.type !== 'update') return;
		expect(mutation.assignments).toHaveLength(2);
	});
});

// ============================================================
// DELETE
// ============================================================

describe('visit-mutation: DELETE', () => {
	it('parses DELETE with WHERE', () => {
		const ast = parseNql('delete from users where id = 1');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'mutationPipeline') return;
		const mutation = stmt.mutation;
		expect(mutation.type).toBe('delete');
		if (mutation.type !== 'delete') return;
		expect(mutation.table).toBe('users');
		expect(mutation.where).toBeDefined();
	});

	it('parses DELETE without WHERE', () => {
		const ast = parseNql('delete from users');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'mutationPipeline') return;
		const mutation = stmt.mutation;
		expect(mutation.type).toBe('delete');
		if (mutation.type !== 'delete') return;
		expect(mutation.where).toBeUndefined();
	});
});

// ============================================================
// UPSERT
// ============================================================

describe('visit-mutation: UPSERT', () => {
	it('parses UPSERT with single conflict column', () => {
		const ast = parseNql(
			"upsert into users on id set name = 'John', email = 'j@e.com'",
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'mutationPipeline') return;
		const mutation = stmt.mutation;
		expect(mutation.type).toBe('upsert');
		if (mutation.type !== 'upsert') return;
		expect(mutation.table).toBe('users');
		expect(mutation.conflictColumns).toEqual(['id']);
		expect(mutation.assignments).toHaveLength(2);
	});

	it('parses UPSERT with multiple conflict columns (parenthesized)', () => {
		const ast = parseNql("upsert into users on (id, email) set name = 'John'");
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'mutationPipeline') return;
		const mutation = stmt.mutation;
		expect(mutation.type).toBe('upsert');
		if (mutation.type !== 'upsert') return;
		expect(mutation.conflictColumns).toEqual(['id', 'email']);
	});

	it('parses UPSERT with WHERE', () => {
		const ast = parseNql(
			"upsert into users on id set name = 'John' where active = true",
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'mutationPipeline') return;
		const mutation = stmt.mutation;
		if (mutation.type !== 'upsert') return;
		expect(mutation.where).toBeDefined();
	});
});

// ============================================================
// INSERT FROM
// ============================================================

describe('visit-mutation: INSERT FROM', () => {
	it('parses INSERT FROM basic', () => {
		const ast = parseNql('insert into archived_users from users');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'mutationPipeline') return;
		const mutation = stmt.mutation;
		expect(mutation.type).toBe('insert_from');
		if (mutation.type !== 'insert_from') return;
		expect(mutation.table).toBe('archived_users');
		expect(mutation.source).toBe('users');
		expect(mutation.where).toBeUndefined();
		expect(mutation.limit).toBeUndefined();
	});

	it('parses INSERT FROM with WHERE', () => {
		const ast = parseNql(
			'insert into archived_users from users where active = false',
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'mutationPipeline') return;
		const mutation = stmt.mutation;
		if (mutation.type !== 'insert_from') return;
		expect(mutation.where).toBeDefined();
	});

	it('parses INSERT FROM with LIMIT', () => {
		const ast = parseNql('insert into archived_users from users limit 100');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'mutationPipeline') return;
		const mutation = stmt.mutation;
		if (mutation.type !== 'insert_from') return;
		expect(mutation.limit).toBe(100);
	});

	it('parses INSERT FROM with WHERE and LIMIT', () => {
		const ast = parseNql(
			'insert into archived_users from users where active = false limit 50',
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'mutationPipeline') return;
		const mutation = stmt.mutation;
		if (mutation.type !== 'insert_from') return;
		expect(mutation.where).toBeDefined();
		expect(mutation.limit).toBe(50);
	});
});

// ============================================================
// UPSERT FROM
// ============================================================

describe('visit-mutation: UPSERT FROM', () => {
	it('parses UPSERT FROM with single conflict column', () => {
		const ast = parseNql('upsert into authors on id from counts');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'mutationPipeline') return;
		const mutation = stmt.mutation;
		expect(mutation.type).toBe('upsert_from');
		if (mutation.type !== 'upsert_from') return;
		expect(mutation.table).toBe('authors');
		expect(mutation.conflictColumns).toEqual(['id']);
		expect(mutation.source).toBe('counts');
	});

	it('parses UPSERT FROM with multiple conflict columns', () => {
		const ast = parseNql('upsert into authors on (id, email) from counts');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'mutationPipeline') return;
		const mutation = stmt.mutation;
		if (mutation.type !== 'upsert_from') return;
		expect(mutation.conflictColumns).toEqual(['id', 'email']);
		expect(mutation.source).toBe('counts');
	});

	it('parses UPSERT FROM with WHERE and LIMIT', () => {
		const ast = parseNql(
			'upsert into authors on id from counts where active = true limit 100',
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'mutationPipeline') return;
		const mutation = stmt.mutation;
		if (mutation.type !== 'upsert_from') return;
		expect(mutation.where).toBeDefined();
		expect(mutation.limit).toBe(100);
	});
});

// ============================================================
// MUTATION PIPELINE: RETURNING (select clause after mutation)
// ============================================================

describe('visit-mutation: RETURNING (pipe select)', () => {
	it('parses INSERT with RETURNING via pipe select', () => {
		const ast = parseNql(
			"insert into users set name = 'John' | select id, name",
		);
		const stmt = ast.statements[0]!;
		expect(stmt.type).toBe('mutationPipeline');
		if (stmt.type !== 'mutationPipeline') return;
		expect(stmt.clauses).toHaveLength(1);
		const selectClause = stmt.clauses[0]!;
		expect(selectClause.type).toBe('select');
	});

	it('parses DELETE with RETURNING', () => {
		const ast = parseNql('delete from users where id = 1 | select id');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'mutationPipeline') return;
		expect(stmt.clauses).toHaveLength(1);
		expect(stmt.clauses[0]!.type).toBe('select');
	});

	it('parses UPDATE with RETURNING', () => {
		const ast = parseNql(
			"update users set status = 'inactive' where id = 1 | select id, status",
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'mutationPipeline') return;
		expect(stmt.clauses).toHaveLength(1);
		expect(stmt.clauses[0]!.type).toBe('select');
	});
});

// ============================================================
// MUTATION PIPELINE: BIND
// ============================================================

describe('visit-mutation: BIND in mutation pipeline', () => {
	it('parses mutation with bind clause', () => {
		const ast = parseNql(
			"insert into users set name = 'John' | select id | bind newUser",
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'mutationPipeline') return;
		expect(stmt.clauses).toHaveLength(2);
		const bind = stmt.clauses.find((c) => c.type === 'bind')!;
		if (bind.type !== 'bind') return;
		expect(bind.name).toBe('newUser');
	});
});

// ============================================================
// ASSIGNMENT VALUES
// ============================================================

describe('visit-mutation: assignment value types', () => {
	it('parses string value assignment', () => {
		const ast = parseNql("insert into users set name = 'test'");
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'mutationPipeline') return;
		if (stmt.mutation.type !== 'insert') return;
		const val = stmt.mutation.rows[0]![0]!.value;
		expect(val.type).toBe('string');
		if (val.type === 'string') expect(val.value).toBe('test');
	});

	it('parses number value assignment', () => {
		const ast = parseNql('insert into users set age = 42');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'mutationPipeline') return;
		if (stmt.mutation.type !== 'insert') return;
		const val = stmt.mutation.rows[0]![0]!.value;
		expect(val.type).toBe('number');
		if (val.type === 'number') expect(val.value).toBe(42);
	});

	it('parses boolean value assignment', () => {
		const ast = parseNql('insert into users set active = true');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'mutationPipeline') return;
		if (stmt.mutation.type !== 'insert') return;
		const val = stmt.mutation.rows[0]![0]!.value;
		expect(val.type).toBe('boolean');
		if (val.type === 'boolean') expect(val.value).toBe(true);
	});

	it('parses null value assignment', () => {
		const ast = parseNql('insert into users set bio = null');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'mutationPipeline') return;
		if (stmt.mutation.type !== 'insert') return;
		const val = stmt.mutation.rows[0]![0]!.value;
		expect(val.type).toBe('null');
	});

	it('parses expression value assignment (arithmetic)', () => {
		const ast = parseNql(
			'update orders set total = price * quantity where id = 1',
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'mutationPipeline') return;
		if (stmt.mutation.type !== 'update') return;
		const val = stmt.mutation.assignments[0]!.value;
		expect(val.type).toBe('binary');
		if (val.type === 'binary') {
			expect(val.operator).toBe('*');
		}
	});
});
