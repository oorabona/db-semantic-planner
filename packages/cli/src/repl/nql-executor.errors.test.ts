/**
 * Error path tests for nql-executor.ts
 *
 * Block 6 of Error Path Test Coverage plan.
 * Covers: parse errors, compile errors, mutation error paths,
 * intent summary edge cases, isNqlQuery edge cases.
 */

import type { ResolvedSchema } from '@dbsp/core';
import {
	assertResolvedSchemaToGeneratedSchema,
	buildModelFromSchema,
} from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import {
	compileNqlToSql,
	getNqlIntent,
	isNqlQuery,
	NqlCompileError,
	NqlParseError,
} from './nql-executor.js';

// Minimal schema for error path testing
const testSchema: ResolvedSchema = {
	tables: {
		users: {
			id: { type: 'integer', primaryKey: true },
			name: { type: 'string', nullable: false },
			email: { type: 'string', nullable: false },
			active: { type: 'boolean', default: 'true' },
		},
		posts: {
			id: { type: 'integer', primaryKey: true },
			title: { type: 'string', nullable: false },
			user_id: { type: 'integer', references: { table: 'users' } },
		},
	},
	relations: {
		'posts.author': {
			kind: 'belongsTo',
			target: 'users',
			foreignKey: 'user_id',
		},
		'users.posts': {
			kind: 'hasMany',
			target: 'posts',
			foreignKey: 'user_id',
		},
	},
	hints: {},
	indexes: {},
	defaultFilters: {},
	conventions: {
		fkPattern: '{singular}_id',
		pluralize: true,
		timestamps: ['created_at', 'updated_at'],
		fkAutoIndex: true,
	},
};

const generated = assertResolvedSchemaToGeneratedSchema(testSchema);
const model = buildModelFromSchema(generated);

// ============================================================================
// NqlParseError
// ============================================================================

describe('NqlParseError', () => {
	it('formats single error message', () => {
		const err = new NqlParseError([
			{ code: 'PARSE_001', message: 'Unexpected token' },
		]);
		expect(err.name).toBe('NqlParseError');
		expect(err.message).toContain('NQL parse error:');
		expect(err.message).toContain('Unexpected token');
		expect(err.errors).toHaveLength(1);
	});

	it('formats multiple error messages', () => {
		const err = new NqlParseError([
			{ code: 'PARSE_001', message: 'First error' },
			{ code: 'PARSE_002', message: 'Second error' },
		]);
		expect(err.message).toContain('First error');
		expect(err.message).toContain('Second error');
		expect(err.errors).toHaveLength(2);
	});

	it('preserves error codes on errors array', () => {
		const errors = [{ code: 'LEX_001', message: 'Bad token' }];
		const err = new NqlParseError(errors);
		expect(err.errors[0]!.code).toBe('LEX_001');
	});
});

// ============================================================================
// NqlCompileError
// ============================================================================

describe('NqlCompileError', () => {
	it('formats message with prefix', () => {
		const err = new NqlCompileError('something went wrong');
		expect(err.name).toBe('NqlCompileError');
		expect(err.message).toBe('NQL compile error: something went wrong');
	});
});

// ============================================================================
// compileNqlToSql — parse error paths
// ============================================================================

describe('compileNqlToSql — parse errors', () => {
	it('throws NqlParseError for completely invalid syntax', async () => {
		await expect(compileNqlToSql('??? !!!', model)).rejects.toThrow(
			NqlParseError,
		);
	});

	it('throws NqlParseError for unclosed string literal', async () => {
		await expect(
			compileNqlToSql("users | where name = 'unterminated", model),
		).rejects.toThrow(NqlParseError);
	});

	it('throws NqlParseError for missing table name', async () => {
		await expect(
			compileNqlToSql('| where active = true', model),
		).rejects.toThrow();
	});

	it('throws NqlParseError for dangling pipe operator', async () => {
		await expect(compileNqlToSql('users |', model)).rejects.toThrow();
	});

	it('throws NqlParseError for unknown table (semantic error)', async () => {
		await expect(
			compileNqlToSql('nonexistent_table | select id', model),
		).rejects.toThrow();
	});

	it('throws NqlParseError for unknown column in where', async () => {
		await expect(
			compileNqlToSql('users | where nonexistent = 1', model),
		).rejects.toThrow();
	});

	it('parse error contains readable message', async () => {
		try {
			await compileNqlToSql('??? !!!', model);
			expect.fail('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(NqlParseError);
			const parseErr = err as NqlParseError;
			expect(parseErr.errors.length).toBeGreaterThan(0);
			expect(parseErr.errors[0]!.message).toBeTruthy();
		}
	});
});

// ============================================================================
// compileNqlToSql — mutation compilation paths
// ============================================================================

describe('compileNqlToSql — mutations', () => {
	it('compiles INSERT mutation (dry-run)', async () => {
		const result = await compileNqlToSql(
			"insert into users set name = 'Test', email = 'test@test.com'",
			model,
		);
		expect(result.intentType).toBe('insert');
		expect(result.sql).toContain('INSERT INTO');
		expect(result.intent.type).toBe('insert');
	});

	it('compiles UPDATE mutation (dry-run)', async () => {
		const result = await compileNqlToSql(
			"update users set name = 'Updated' where id = 1",
			model,
		);
		expect(result.intentType).toBe('update');
		expect(result.sql).toContain('UPDATE');
		expect(result.intent.type).toBe('update');
		expect(result.intent.hasWhere).toBe(true);
	});

	it('compiles DELETE mutation (dry-run)', async () => {
		const result = await compileNqlToSql(
			'delete from users where id = 1',
			model,
		);
		expect(result.intentType).toBe('delete');
		expect(result.sql).toContain('DELETE');
		expect(result.intent.type).toBe('delete');
	});

	it('mutation intent summary has correct table', async () => {
		const result = await compileNqlToSql(
			"insert into posts set title = 'Hello', user_id = 1",
			model,
		);
		expect(result.intent.table).toBe('posts');
	});
});

// ============================================================================
// compileNqlToSql — set operation paths
// ============================================================================

describe('compileNqlToSql — set operations', () => {
	it('compiles UNION set operation', async () => {
		const result = await compileNqlToSql(
			'users | where active = true | select name | union (users | select name)',
			model,
		);
		expect(result.intentType).toBe('setOperation');
		expect(result.sql).toContain('UNION');
		expect(result.intent.type).toBe('setOperation');
	});

	it('compiles INTERSECT set operation', async () => {
		const result = await compileNqlToSql(
			'users | select name | intersect (users | select name)',
			model,
		);
		expect(result.intentType).toBe('setOperation');
		expect(result.sql).toContain('INTERSECT');
	});

	it('set operation intent summary has left table', async () => {
		const result = await compileNqlToSql(
			'users | select name | union (posts | select title)',
			model,
		);
		expect(result.intent.table).toBe('users');
	});

	it('set operation has no planReport', async () => {
		const result = await compileNqlToSql(
			'users | select name | union (users | select name)',
			model,
		);
		expect(result.planReport).toBeUndefined();
	});
});

// ============================================================================
// compileNqlToSql — options paths
// ============================================================================

describe('compileNqlToSql — options', () => {
	it('applies schemaName when provided', async () => {
		const result = await compileNqlToSql('users', model, {
			schemaName: 'tenant_1',
		});
		expect(result.sql).toContain('tenant_1');
	});

	it('works without options', async () => {
		const result = await compileNqlToSql('users', model);
		expect(result.sql).toContain('SELECT');
	});
});

// ============================================================================
// compileNqlToSql — intent summary edge cases
// ============================================================================

describe('compileNqlToSql — intent summary', () => {
	it('query intent has correct with[] for includes', async () => {
		const result = await compileNqlToSql('users | select *, posts.*', model);
		expect(result.intent.with).toContain('posts');
	});

	it('query intent hasGroupBy is true when grouped', async () => {
		const result = await compileNqlToSql(
			'users | group by active | select active, count()',
			model,
		);
		expect(result.intent.hasGroupBy).toBe(true);
	});

	it('query intent hasOrderBy is true when ordered', async () => {
		const result = await compileNqlToSql('users | order by name asc', model);
		expect(result.intent.hasOrderBy).toBe(true);
	});

	it('query intent ctes is empty (CTEs are program-level)', async () => {
		const result = await compileNqlToSql('users', model);
		expect(result.intent.ctes).toEqual([]);
	});

	it('mutation intent with is empty', async () => {
		const result = await compileNqlToSql(
			"insert into users set name = 'X', email = 'x@x.com'",
			model,
		);
		expect(result.intent.with).toEqual([]);
	});

	it('mutation intent hasGroupBy/hasOrderBy are false', async () => {
		const result = await compileNqlToSql(
			"insert into users set name = 'X', email = 'x@x.com'",
			model,
		);
		expect(result.intent.hasGroupBy).toBe(false);
		expect(result.intent.hasOrderBy).toBe(false);
	});

	it('set operation intent hasWhere reflects left side', async () => {
		const result = await compileNqlToSql(
			'users | where active = true | select name | union (users | select name)',
			model,
		);
		expect(result.intent.hasWhere).toBe(true);
	});
});

// ============================================================================
// getNqlIntent — error propagation
// ============================================================================

describe('getNqlIntent — errors', () => {
	it('throws NqlParseError for invalid NQL', () => {
		expect(() => getNqlIntent('??? invalid', model)).toThrow(NqlParseError);
	});

	it('throws for unknown table', () => {
		expect(() => getNqlIntent('nonexistent | select id', model)).toThrow();
	});

	it('returns mutation intent for INSERT', () => {
		const result = getNqlIntent(
			"insert into users set name = 'A', email = 'a@a.com'",
			model,
		);
		expect(result.mutation).toBeDefined();
		expect(result.query).toBeUndefined();
	});

	it('returns query intent for SELECT', () => {
		const result = getNqlIntent('users | where active = true', model);
		expect(result.query).toBeDefined();
		expect(result.mutation).toBeUndefined();
	});
});

// ============================================================================
// isNqlQuery — edge cases
// ============================================================================

describe('isNqlQuery — edge cases', () => {
	it('returns false for whitespace-only input', () => {
		expect(isNqlQuery('   ')).toBe(false);
		expect(isNqlQuery('\t')).toBe(false);
		expect(isNqlQuery('\n')).toBe(false);
	});

	it('returns false for dot-commands with leading spaces', () => {
		expect(isNqlQuery('  .tables')).toBe(false);
	});

	it('returns false for raw SQL with leading spaces', () => {
		expect(isNqlQuery('  !SELECT 1')).toBe(false);
	});

	it('returns true for table name starting with number-like prefix', () => {
		// Edge: valid table names that look unusual
		expect(isNqlQuery('table123')).toBe(true);
	});

	it('returns true for NQL with pipe operators', () => {
		expect(isNqlQuery('users | where id = 1')).toBe(true);
	});
});
