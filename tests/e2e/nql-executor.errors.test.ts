/**
 * NQL Executor — Error Path E2E Tests
 *
 * Integration tests for nql-executor.ts error paths using testcontainers (real PostgreSQL).
 * Tests both pure functions and compile-time error paths that need a real model + adapter.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	compileNqlToSql,
	getNqlIntent,
	isNqlQuery,
	NqlCompileError,
	NqlParseError,
} from '../../packages/cli/src/repl/nql-executor.js';
import {
	blogModel,
	closeTestDb,
	createBlogSchema,
	dropBlogSchema,
	seedBlogData,
} from './testkit/index.js';

// ============================================================================
// Section A: Pure functions (no DB needed)
// ============================================================================

describe('NQL Executor — Pure Functions', () => {
	// -----------------------------------------------------------------------
	// isNqlQuery
	// -----------------------------------------------------------------------

	describe('isNqlQuery', () => {
		it('should return false for empty string', () => {
			expect(isNqlQuery('')).toBe(false);
		});

		it('should return false for whitespace only', () => {
			expect(isNqlQuery('   ')).toBe(false);
			expect(isNqlQuery('\t\n')).toBe(false);
		});

		it('should return false for REPL dot-commands', () => {
			expect(isNqlQuery('.tables')).toBe(false);
			expect(isNqlQuery('.schema users')).toBe(false);
			expect(isNqlQuery('.help')).toBe(false);
		});

		it('should return false for raw SQL bang-commands', () => {
			expect(isNqlQuery('!SELECT 1')).toBe(false);
			expect(isNqlQuery('!DROP TABLE users')).toBe(false);
		});

		it('should return true for valid NQL input', () => {
			expect(isNqlQuery('users')).toBe(true);
			expect(isNqlQuery('posts | where published = true')).toBe(true);
		});

		it('should return true for NQL with leading whitespace (trimmed)', () => {
			expect(isNqlQuery('  users')).toBe(true);
			expect(isNqlQuery('\t posts | limit 5')).toBe(true);
		});
	});

	// -----------------------------------------------------------------------
	// NqlParseError
	// -----------------------------------------------------------------------

	describe('NqlParseError', () => {
		it('should set errors array from constructor', () => {
			const errors = [
				{ code: 'PARSE_001', message: 'Unexpected token' },
				{ code: 'PARSE_002', message: 'Missing pipe' },
			];
			const err = new NqlParseError(errors);

			expect(err.errors).toBe(errors);
			expect(err.errors).toHaveLength(2);
		});

		it('should have name "NqlParseError"', () => {
			const err = new NqlParseError([{ code: 'X', message: 'test' }]);
			expect(err.name).toBe('NqlParseError');
		});

		it('should join all error messages in the message', () => {
			const err = new NqlParseError([
				{ code: 'A', message: 'First problem' },
				{ code: 'B', message: 'Second problem' },
			]);
			expect(err.message).toContain('First problem');
			expect(err.message).toContain('Second problem');
			expect(err.message).toMatch(/^NQL parse error:/);
		});

		it('should be instanceof Error', () => {
			const err = new NqlParseError([{ code: 'X', message: 'test' }]);
			expect(err).toBeInstanceOf(Error);
		});
	});

	// -----------------------------------------------------------------------
	// NqlCompileError
	// -----------------------------------------------------------------------

	describe('NqlCompileError', () => {
		it('should prefix message with "NQL compile error: "', () => {
			const err = new NqlCompileError('something went wrong');
			expect(err.message).toBe('NQL compile error: something went wrong');
		});

		it('should have name "NqlCompileError"', () => {
			const err = new NqlCompileError('test');
			expect(err.name).toBe('NqlCompileError');
		});

		it('should be instanceof Error', () => {
			const err = new NqlCompileError('test');
			expect(err).toBeInstanceOf(Error);
		});
	});
});

// ============================================================================
// Section B: Integration tests (needs built packages + model)
// ============================================================================

describe('NQL Executor — Integration (compileNqlToSql)', () => {
	const SCHEMA = 'nql_executor_err_e2e';

	beforeAll(async () => {
		await dropBlogSchema(SCHEMA);
		await createBlogSchema(SCHEMA);
		await seedBlogData(SCHEMA);
	});

	afterAll(async () => {
		await dropBlogSchema(SCHEMA);
		await closeTestDb();
	});

	// -----------------------------------------------------------------------
	// compileNqlToSql — error paths
	// -----------------------------------------------------------------------

	describe('compileNqlToSql — error paths', () => {
		it('should throw NqlParseError for raw SQL syntax', async () => {
			// Raw SQL is not valid NQL — parser rejects it
			await expect(
				compileNqlToSql('SELECT * FROM users', blogModel),
			).rejects.toThrow(NqlParseError);
		});

		it('should throw for non-existent table in NQL', async () => {
			// Table not in model — compiler or parser should reject
			await expect(
				compileNqlToSql('nonexistent_table_xyz', blogModel),
			).rejects.toThrow();
		});

		it('should throw for NQL referencing non-existent column', async () => {
			// Column "ghost_column" does not exist on "authors"
			await expect(
				compileNqlToSql('authors | where ghost_column = true', blogModel),
			).rejects.toThrow();
		});

		it('should throw for empty NQL string', async () => {
			await expect(compileNqlToSql('', blogModel)).rejects.toThrow();
		});

		it('should throw for incomplete pipe expression', async () => {
			await expect(compileNqlToSql('authors |', blogModel)).rejects.toThrow();
		});
	});

	// -----------------------------------------------------------------------
	// compileNqlToSql — success paths
	// -----------------------------------------------------------------------

	describe('compileNqlToSql — success paths', () => {
		it('should compile a simple table query and return sql + params', async () => {
			const result = await compileNqlToSql('authors', blogModel);

			expect(result).toHaveProperty('sql');
			expect(result).toHaveProperty('params');
			expect(result).toHaveProperty('intentType', 'query');
			expect(result).toHaveProperty('intent');
			expect(typeof result.sql).toBe('string');
			expect(result.sql.toLowerCase()).toContain('select');
			expect(result.sql.toLowerCase()).toContain('authors');
		});

		it('should compile a filtered query', async () => {
			const result = await compileNqlToSql(
				'posts | where published = true',
				blogModel,
			);

			expect(result.intentType).toBe('query');
			expect(result.sql.toLowerCase()).toContain('where');
			expect(result.intent.hasWhere).toBe(true);
			expect(result.intent.table).toBe('posts');
		});

		it('should include planReport for queries', async () => {
			const result = await compileNqlToSql('authors', blogModel);

			expect(result.planReport).toBeDefined();
			expect(result.planReport!.decisions).toBeDefined();
			expect(Array.isArray(result.planReport!.decisions)).toBe(true);
		});

		it('should compile an insert mutation', async () => {
			const result = await compileNqlToSql(
				"insert into authors set name = 'Test', email = 'test@test.com'",
				blogModel,
			);

			expect(result.intentType).toBe('insert');
			expect(result.intent.type).toBe('insert');
			expect(result.intent.table).toBe('authors');
			expect(result.sql.toLowerCase()).toContain('insert');
		});

		it('should compile an update mutation', async () => {
			const result = await compileNqlToSql(
				"update authors set name = 'Updated' where id = 1",
				blogModel,
			);

			expect(result.intentType).toBe('update');
			expect(result.intent.type).toBe('update');
			expect(result.sql.toLowerCase()).toContain('update');
		});

		it('should compile a delete mutation', async () => {
			const result = await compileNqlToSql(
				'delete from comments where id = 999',
				blogModel,
			);

			expect(result.intentType).toBe('delete');
			expect(result.intent.type).toBe('delete');
			expect(result.sql.toLowerCase()).toContain('delete');
		});
	});

	// -----------------------------------------------------------------------
	// compileNqlToSql — options
	// -----------------------------------------------------------------------

	describe('compileNqlToSql — options', () => {
		it('should include schema prefix when schemaName option is set', async () => {
			const result = await compileNqlToSql('authors', blogModel, {
				schemaName: 'my_tenant',
			});

			expect(result.sql).toContain('my_tenant.');
		});

		it('should transform column casing with dbCasing option', async () => {
			const result = await compileNqlToSql(
				'posts | where authorId = 1',
				blogModel,
				{ dbCasing: 'snake_case' },
			);

			// With snake_case, camelCase columns like authorId become author_id in SQL
			expect(result.sql).toContain('author_id');
		});
	});

	// -----------------------------------------------------------------------
	// getNqlIntent — error paths
	// -----------------------------------------------------------------------

	describe('getNqlIntent — error paths', () => {
		it('should throw NqlParseError for invalid NQL', () => {
			expect(() => getNqlIntent('SELECT * FROM users', blogModel)).toThrow(
				NqlParseError,
			);
		});

		it('should return neither query nor mutation for empty input', () => {
			// Empty string compiles to an AST with no query/mutation
			const result = getNqlIntent('', blogModel);
			expect(result.query).toBeUndefined();
			expect(result.mutation).toBeUndefined();
		});
	});

	// -----------------------------------------------------------------------
	// getNqlIntent — success paths
	// -----------------------------------------------------------------------

	describe('getNqlIntent — success paths', () => {
		it('should return query intent for a query', () => {
			const result = getNqlIntent('authors', blogModel);

			expect(result.query).toBeDefined();
			expect(result.mutation).toBeUndefined();
			expect(result.query!.from).toBe('authors');
		});

		it('should return mutation intent for a mutation', () => {
			const result = getNqlIntent(
				"insert into authors set name = 'X', email = 'x@test.com'",
				blogModel,
			);

			expect(result.mutation).toBeDefined();
			expect(result.query).toBeUndefined();
			expect(result.mutation!.table).toBe('authors');
		});

		it('should return query with where info', () => {
			const result = getNqlIntent('posts | where published = true', blogModel);

			expect(result.query).toBeDefined();
			expect(result.query!.where).toBeDefined();
		});
	});
});
