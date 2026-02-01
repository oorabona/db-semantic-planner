/**
 * Tests for NQL Executor
 *
 * Part of NQLM (NQL CLI Migration) - Block 2
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
	NqlParseError,
} from './nql-executor.js';

// Test schema: ResolvedSchema → assertResolvedSchemaToGeneratedSchema → buildModelFromSchema
const testSchema: ResolvedSchema = {
	tables: {
		users: {
			id: { type: 'integer', primaryKey: true },
			name: { type: 'string', nullable: false },
			email: { type: 'string', nullable: false },
			active: { type: 'boolean', default: 'true' },
			age: { type: 'integer', nullable: true },
			created_at: { type: 'timestamp', nullable: true },
		},
		posts: {
			id: { type: 'integer', primaryKey: true },
			title: { type: 'string', nullable: false },
			content: { type: 'string', nullable: true },
			published: { type: 'boolean', default: 'false' },
			user_id: { type: 'integer', references: { table: 'users' } },
			created_at: { type: 'timestamp', nullable: true },
		},
		orders: {
			id: { type: 'integer', primaryKey: true },
			status: { type: 'string', nullable: false },
			total: { type: 'decimal', nullable: false },
			user_id: { type: 'integer', references: { table: 'users' } },
			created_at: { type: 'timestamp', nullable: true },
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
	conventions: {
		fkPattern: '{singular}_id',
		pluralize: true,
		timestamps: ['created_at', 'updated_at'],
		fkAutoIndex: true,
	},
};

// Convert to GeneratedSchema, then to ModelIR
const generatedSchema = assertResolvedSchemaToGeneratedSchema(testSchema);
const testModel = buildModelFromSchema(generatedSchema);

describe('nql-executor', () => {
	describe('isNqlQuery', () => {
		it('returns true for valid NQL queries', async () => {
			expect(isNqlQuery('users')).toBe(true);
			expect(isNqlQuery('users | where active = true')).toBe(true);
			expect(isNqlQuery('posts | select title, content')).toBe(true);
		});

		it('returns false for REPL commands', async () => {
			expect(isNqlQuery('.tables')).toBe(false);
			expect(isNqlQuery('.schema')).toBe(false);
			expect(isNqlQuery('.help')).toBe(false);
		});

		it('returns false for raw SQL commands', async () => {
			expect(isNqlQuery('!SELECT 1')).toBe(false);
			expect(isNqlQuery('!SELECT * FROM users')).toBe(false);
		});

		it('returns false for empty input', async () => {
			expect(isNqlQuery('')).toBe(false);
			expect(isNqlQuery('   ')).toBe(false);
		});
	});

	describe('compileNqlToSql', () => {
		const model = testModel;

		describe('SELECT queries', () => {
			it('compiles simple table scan', async () => {
				const result = await compileNqlToSql('users', model);

				expect(result.intentType).toBe('query');
				expect(result.sql.toLowerCase()).toContain('select');
				expect(result.sql.toLowerCase()).toContain('users');
			});

			it('compiles query with where clause', async () => {
				const result = await compileNqlToSql(
					'users | where active = true',
					model,
				);

				expect(result.intentType).toBe('query');
				expect(result.sql.toLowerCase()).toContain('where');
				expect(result.params).toContain(true);
			});

			it('compiles query with limit', async () => {
				const result = await compileNqlToSql('users | limit 10', model);

				expect(result.intentType).toBe('query');
				expect(result.sql.toLowerCase()).toContain('limit');
			});

			it('compiles query with select fields', async () => {
				const result = await compileNqlToSql(
					'users | select name, email',
					model,
				);

				expect(result.intentType).toBe('query');
				expect(result.sql.toLowerCase()).toContain('name');
				expect(result.sql.toLowerCase()).toContain('email');
			});

			it('compiles query with order by', async () => {
				const result = await compileNqlToSql(
					'users | order by name asc',
					model,
				);

				expect(result.intentType).toBe('query');
				expect(result.sql.toLowerCase()).toContain('order by');
			});

			it('compiles query with multiple clauses', async () => {
				const result = await compileNqlToSql(
					'users | where active = true | select name, email | order by name | limit 10',
					model,
				);

				expect(result.intentType).toBe('query');
				expect(result.sql.toLowerCase()).toContain('where');
				expect(result.sql.toLowerCase()).toContain('order by');
				expect(result.sql.toLowerCase()).toContain('limit');
			});

			it('compiles query with string comparison', async () => {
				const result = await compileNqlToSql(
					"users | where name = 'Alice'",
					model,
				);

				expect(result.intentType).toBe('query');
				expect(result.params).toContain('Alice');
			});

			it('compiles query with numeric comparison', async () => {
				const result = await compileNqlToSql('users | where age > 18', model);

				expect(result.intentType).toBe('query');
				expect(result.params).toContain(18);
			});

			it('uses json_agg for hasMany includes (STRAT-SIMPLIFY)', async () => {
				// users.posts is hasMany, should use json_agg by default
				const result = await compileNqlToSql(
					'users | select *, posts.*',
					model,
				);

				expect(result.intentType).toBe('query');
				// Should use json_agg, NOT left join for hasMany
				expect(result.sql.toLowerCase()).toContain('json_agg');
				expect(result.sql.toLowerCase()).not.toMatch(/left\s+join/);
			});

			it('compiles query with group by', async () => {
				const result = await compileNqlToSql(
					'users | group by active | select count(*)',
					model,
				);
				expect(result.intentType).toBe('query');
				expect(result.sql.toLowerCase()).toContain('group by');
				expect(result.sql.toLowerCase()).toContain('count(*)');
			});
		});

		describe('error handling', () => {
			it('throws NqlParseError for invalid syntax', async () => {
				await expect(
					compileNqlToSql('users | where = invalid', model),
				).rejects.toThrow(NqlParseError);
			});

			it('parse error contains helpful message', async () => {
				try {
					await compileNqlToSql('users | where = invalid', model);
					expect.fail('Should have thrown');
				} catch (e) {
					expect(e).toBeInstanceOf(NqlParseError);
					expect((e as NqlParseError).message).toContain('parse error');
				}
			});
		});
	});

	describe('getNqlIntent', () => {
		const model = testModel;

		it('returns query intent for SELECT', async () => {
			const result = getNqlIntent('users | where active = true', model);

			expect(result.query).toBeDefined();
			expect(result.mutation).toBeUndefined();
			expect(result.query?.from).toBe('users');
		});

		it('query intent includes where clause', async () => {
			const result = getNqlIntent('users | where active = true', model);

			expect(result.query?.where).toBeDefined();
		});

		it('query intent includes limit', async () => {
			const result = getNqlIntent('users | limit 10', model);

			expect(result.query?.limit).toBe(10);
		});

		it('query intent includes offset', async () => {
			const result = getNqlIntent('users | offset 5', model);

			expect(result.query?.offset).toBe(5);
		});
	});

	describe('multiline queries', () => {
		const model = testModel;

		it('compiles multiline query', async () => {
			const nql = `users
				| where active = true
				| limit 10`;

			const result = await compileNqlToSql(nql, model);

			expect(result.intentType).toBe('query');
			expect(result.sql.toLowerCase()).toContain('where');
			expect(result.sql.toLowerCase()).toContain('limit');
		});

		it('compiles query with comments', async () => {
			const nql = `users # get all users
				| where active = true # only active
				| limit 10`;

			const result = await compileNqlToSql(nql, model);

			expect(result.intentType).toBe('query');
		});
	});

	describe('edge cases', () => {
		const model = testModel;

		it('handles escaped quotes in strings', async () => {
			const result = await compileNqlToSql(
				"users | where name = 'O''Brien'",
				model,
			);

			expect(result.intentType).toBe('query');
			expect(result.params).toContain("O'Brien");
		});

		it('handles null comparison', async () => {
			const result = await compileNqlToSql(
				'users | where email is null',
				model,
			);

			expect(result.intentType).toBe('query');
			expect(result.sql.toLowerCase()).toContain('is null');
		});

		it('handles not null comparison', async () => {
			const result = await compileNqlToSql(
				'users | where email is not null',
				model,
			);

			expect(result.intentType).toBe('query');
			expect(result.sql.toLowerCase()).toContain('is not null');
		});
	});
});
