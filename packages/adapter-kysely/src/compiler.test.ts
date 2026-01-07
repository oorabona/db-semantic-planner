import {
	belongsTo,
	defineSchema,
	hasMany,
	plan,
	type QueryIntent,
} from '@db-semantic-planner/core';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { describe, expect, it } from 'vitest';
import { compile } from './compiler.js';
import { CompilationError } from './errors.js';

// ============================================================================
// Test Setup
// ============================================================================

/**
 * Create an in-memory Kysely instance for testing compilation
 * Uses SQLite for real SQL generation
 */
function createTestKysely() {
	return new Kysely<Record<string, unknown>>({
		dialect: new SqliteDialect({
			database: new Database(':memory:'),
		}),
	});
}

// ============================================================================
// Test Schemas
// ============================================================================

/**
 * Basic schema: Users with posts
 */
const basicSchema = defineSchema({
	users: {
		id: 'number',
		name: 'string',
		email: 'string',
		active: 'boolean',
	},
	posts: {
		id: 'number',
		title: 'string',
		content: 'string',
		userId: 'number',
		published: 'boolean',
	},
})
	.relations({
		users: {
			posts: hasMany('posts', { foreignKey: 'userId' }),
		},
		posts: {
			author: belongsTo('users', { foreignKey: 'userId' }),
		},
	})
	.build();

/**
 * Q1 Schema: Products with images (EXISTS filter test)
 */
const q1Schema = defineSchema({
	products: {
		id: 'number',
		name: 'string',
	},
	productImages: {
		id: 'number',
		productId: 'number',
		locale: 'string',
		type: 'string',
		approved: 'boolean',
	},
})
	.relations({
		products: {
			images: hasMany('productImages', { foreignKey: 'productId' }),
		},
		productImages: {
			product: belongsTo('products', { foreignKey: 'productId' }),
		},
	})
	.build();

// ============================================================================
// Basic SELECT Tests
// ============================================================================

describe('SQL Compiler', () => {
	const kysely = createTestKysely();

	describe('basic SELECT', () => {
		it('should compile a simple select all query', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
			};

			const planReport = plan(intent, basicSchema);
			const compiled = compile(planReport, basicSchema, kysely);

			expect(compiled.sql).toContain('select');
			expect(compiled.sql).toContain('users');
			expect(compiled.sql).toContain('t0');
		});

		it('should compile select with specific fields', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				select: {
					type: 'fields',
					fields: ['id', 'name'],
				},
			};

			const planReport = plan(intent, basicSchema);
			const compiled = compile(planReport, basicSchema, kysely);

			expect(compiled.sql).toContain('select');
			expect(compiled.sql).toContain('t0');
		});

		it('should use deterministic aliases', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'posts',
			};

			const planReport = plan(intent, basicSchema);
			const compiled = compile(planReport, basicSchema, kysely);

			// First table always gets t0
			expect(compiled.sql).toContain('t0');
		});

		it('should support schema prefix for multi-tenant', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
			};

			const planReport = plan(intent, basicSchema);
			const compiled = compile(planReport, basicSchema, kysely, 'tenant_123');

			expect(compiled.sql).toContain('tenant_123');
		});
	});

	// ============================================================================
	// WHERE Clause Tests
	// ============================================================================

	describe('WHERE clauses', () => {
		it('should compile equality comparison', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				where: {
					kind: 'comparison',
					field: 'id',
					operator: 'eq',
					value: 1,
				},
			};

			const planReport = plan(intent, basicSchema);
			const compiled = compile(planReport, basicSchema, kysely);

			expect(compiled.sql).toContain('where');
			expect(compiled.parameters).toContain(1);
		});

		it('should compile inequality comparison', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				where: {
					kind: 'comparison',
					field: 'active',
					operator: 'neq',
					value: false,
				},
			};

			const planReport = plan(intent, basicSchema);
			const compiled = compile(planReport, basicSchema, kysely);

			expect(compiled.sql).toContain('where');
		});

		it('should compile greater than comparison', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				where: {
					kind: 'comparison',
					field: 'id',
					operator: 'gt',
					value: 10,
				},
			};

			const planReport = plan(intent, basicSchema);
			const compiled = compile(planReport, basicSchema, kysely);

			expect(compiled.sql).toContain('where');
			expect(compiled.parameters).toContain(10);
		});

		it('should compile LIKE pattern', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				where: {
					kind: 'like',
					field: 'name',
					pattern: '%john%',
				},
			};

			const planReport = plan(intent, basicSchema);
			const compiled = compile(planReport, basicSchema, kysely);

			expect(compiled.sql).toContain('like');
			expect(compiled.parameters).toContain('%john%');
		});

		it('should compile IN list', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				where: {
					kind: 'in',
					field: 'id',
					values: [1, 2, 3],
				},
			};

			const planReport = plan(intent, basicSchema);
			const compiled = compile(planReport, basicSchema, kysely);

			expect(compiled.sql).toContain('in');
		});

		it('should compile IS NULL', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				where: {
					kind: 'null',
					field: 'email',
					operator: 'isNull',
				},
			};

			const planReport = plan(intent, basicSchema);
			const compiled = compile(planReport, basicSchema, kysely);

			expect(compiled.sql).toContain('is null');
		});

		it('should compile IS NOT NULL', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				where: {
					kind: 'null',
					field: 'email',
					operator: 'isNotNull',
				},
			};

			const planReport = plan(intent, basicSchema);
			const compiled = compile(planReport, basicSchema, kysely);

			expect(compiled.sql).toContain('is not null');
		});

		it('should compile AND conditions', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				where: {
					kind: 'and',
					conditions: [
						{
							kind: 'comparison',
							field: 'active',
							operator: 'eq',
							value: true,
						},
						{ kind: 'comparison', field: 'id', operator: 'gt', value: 5 },
					],
				},
			};

			const planReport = plan(intent, basicSchema);
			const compiled = compile(planReport, basicSchema, kysely);

			expect(compiled.sql).toContain('and');
		});

		it('should compile OR conditions', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				where: {
					kind: 'or',
					conditions: [
						{
							kind: 'comparison',
							field: 'name',
							operator: 'eq',
							value: 'Alice',
						},
						{ kind: 'comparison', field: 'name', operator: 'eq', value: 'Bob' },
					],
				},
			};

			const planReport = plan(intent, basicSchema);
			const compiled = compile(planReport, basicSchema, kysely);

			expect(compiled.sql).toContain('or');
		});

		it('should compile NOT condition', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				where: {
					kind: 'not',
					condition: {
						kind: 'comparison',
						field: 'active',
						operator: 'eq',
						value: false,
					},
				},
			};

			const planReport = plan(intent, basicSchema);
			const compiled = compile(planReport, basicSchema, kysely);

			expect(compiled.sql).toContain('not');
		});
	});

	// ============================================================================
	// ORDER BY Tests
	// ============================================================================

	describe('ORDER BY', () => {
		it('should compile ORDER BY ASC', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				orderBy: [{ field: 'name', direction: 'asc' }],
			};

			const planReport = plan(intent, basicSchema);
			const compiled = compile(planReport, basicSchema, kysely);

			expect(compiled.sql).toContain('order by');
			expect(compiled.sql).toContain('asc');
		});

		it('should compile ORDER BY DESC', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				orderBy: [{ field: 'id', direction: 'desc' }],
			};

			const planReport = plan(intent, basicSchema);
			const compiled = compile(planReport, basicSchema, kysely);

			expect(compiled.sql).toContain('order by');
			expect(compiled.sql).toContain('desc');
		});

		it('should compile multiple ORDER BY', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				orderBy: [
					{ field: 'name', direction: 'asc' },
					{ field: 'id', direction: 'desc' },
				],
			};

			const planReport = plan(intent, basicSchema);
			const compiled = compile(planReport, basicSchema, kysely);

			expect(compiled.sql).toContain('order by');
		});
	});

	// ============================================================================
	// LIMIT/OFFSET Tests
	// ============================================================================

	describe('LIMIT and OFFSET', () => {
		it('should compile LIMIT', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				limit: 10,
			};

			const planReport = plan(intent, basicSchema);
			const compiled = compile(planReport, basicSchema, kysely);

			expect(compiled.sql).toContain('limit');
		});

		it('should compile OFFSET', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				offset: 20,
			};

			const planReport = plan(intent, basicSchema);
			const compiled = compile(planReport, basicSchema, kysely);

			expect(compiled.sql).toContain('offset');
		});

		it('should compile LIMIT with OFFSET', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				limit: 10,
				offset: 20,
			};

			const planReport = plan(intent, basicSchema);
			const compiled = compile(planReport, basicSchema, kysely);

			expect(compiled.sql).toContain('limit');
			expect(compiled.sql).toContain('offset');
		});
	});

	// ============================================================================
	// EXISTS Subquery Tests (Q1)
	// ============================================================================

	describe('EXISTS subquery (Q1)', () => {
		it('should compile EXISTS for relation filter (some)', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'products',
				where: {
					kind: 'relationFilter',
					relation: 'images',
					mode: 'some',
					where: {
						kind: 'and',
						conditions: [
							{
								kind: 'comparison',
								field: 'locale',
								operator: 'eq',
								value: 'en',
							},
							{
								kind: 'comparison',
								field: 'approved',
								operator: 'eq',
								value: true,
							},
						],
					},
				},
			};

			const planReport = plan(intent, q1Schema);
			const compiled = compile(planReport, q1Schema, kysely);

			expect(compiled.sql).toContain('exists');
			expect(compiled.sql).toContain('productImages');
		});

		it('should compile NOT EXISTS for relation filter (none)', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'products',
				where: {
					kind: 'relationFilter',
					relation: 'images',
					mode: 'none',
					where: {
						kind: 'comparison',
						field: 'type',
						operator: 'eq',
						value: 'thumbnail',
					},
				},
			};

			const planReport = plan(intent, q1Schema);
			const compiled = compile(planReport, q1Schema, kysely);

			expect(compiled.sql).toContain('not');
			expect(compiled.sql).toContain('exists');
		});

		it('should compile every mode as NOT EXISTS (NOT condition)', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'products',
				where: {
					kind: 'relationFilter',
					relation: 'images',
					mode: 'every',
					where: {
						kind: 'comparison',
						field: 'approved',
						operator: 'eq',
						value: true,
					},
				},
			};

			const planReport = plan(intent, q1Schema);
			const compiled = compile(planReport, q1Schema, kysely);

			// every = NOT EXISTS (records that don't match)
			expect(compiled.sql).toContain('not');
			expect(compiled.sql).toContain('exists');
		});

		it('should compile direct exists intent', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'products',
				where: {
					kind: 'exists',
					relation: 'images',
					where: {
						kind: 'comparison',
						field: 'locale',
						operator: 'eq',
						value: 'fr',
					},
				},
			};

			const planReport = plan(intent, q1Schema);
			const compiled = compile(planReport, q1Schema, kysely);

			expect(compiled.sql).toContain('exists');
		});

		it('should compile notExists intent', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'products',
				where: {
					kind: 'notExists',
					relation: 'images',
				},
			};

			const planReport = plan(intent, q1Schema);
			const compiled = compile(planReport, q1Schema, kysely);

			expect(compiled.sql).toContain('not');
			expect(compiled.sql).toContain('exists');
		});
	});

	// ============================================================================
	// Error Handling Tests
	// ============================================================================

	describe('error handling', () => {
		it('should throw CompilationError for unknown relation', () => {
			// Create a plan report manually with invalid relation
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				where: {
					kind: 'exists',
					relation: 'nonexistent',
				},
			};

			const planReport = plan(intent, basicSchema);

			expect(() => {
				compile(planReport, basicSchema, kysely);
			}).toThrow(CompilationError);
		});
	});

	// ============================================================================
	// Complex Query Tests
	// ============================================================================

	describe('complex queries', () => {
		it('should compile nested logical conditions', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				where: {
					kind: 'and',
					conditions: [
						{
							kind: 'or',
							conditions: [
								{
									kind: 'comparison',
									field: 'name',
									operator: 'eq',
									value: 'Alice',
								},
								{
									kind: 'comparison',
									field: 'name',
									operator: 'eq',
									value: 'Bob',
								},
							],
						},
						{
							kind: 'comparison',
							field: 'active',
							operator: 'eq',
							value: true,
						},
					],
				},
			};

			const planReport = plan(intent, basicSchema);
			const compiled = compile(planReport, basicSchema, kysely);

			expect(compiled.sql).toContain('and');
			expect(compiled.sql).toContain('or');
		});

		it('should compile full query with all clauses', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				select: { type: 'fields', fields: ['id', 'name', 'email'] },
				where: {
					kind: 'and',
					conditions: [
						{
							kind: 'comparison',
							field: 'active',
							operator: 'eq',
							value: true,
						},
						{ kind: 'like', field: 'email', pattern: '%@example.com' },
					],
				},
				orderBy: [{ field: 'name', direction: 'asc' }],
				limit: 50,
				offset: 0,
			};

			const planReport = plan(intent, basicSchema);
			const compiled = compile(planReport, basicSchema, kysely);

			expect(compiled.sql).toContain('select');
			expect(compiled.sql).toContain('where');
			expect(compiled.sql).toContain('order by');
			expect(compiled.sql).toContain('limit');
		});
	});
});
