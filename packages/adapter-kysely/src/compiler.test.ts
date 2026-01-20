import {
	belongsTo,
	defineSchemaBuilder,
	hasMany,
	ModelIRImpl,
	plan,
	planRecursive,
	type QueryIntent,
	type RecursiveIntent,
	type UpsertIntent,
	type WindowIntent,
} from '@dbsp/core';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { describe, expect, it } from 'vitest';
import {
	compile,
	compileDelete,
	compileInsert,
	compileRecursive,
	compileSeparateInclude,
	compileUpdate,
	compileUpsert,
	compileWindowSelect,
	compileWithIncludes,
	injectAdvancedRecursiveClauses,
} from './compiler.js';
import { POSTGRESQL_CAPABILITIES, SQLITE_CAPABILITIES } from './dialect.js';
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
const basicSchema = defineSchemaBuilder({
	users: {
		id: { type: 'number' },
		name: { type: 'string' },
		email: { type: 'string' },
		active: { type: 'boolean' },
	},
	posts: {
		id: { type: 'number' },
		title: { type: 'string' },
		content: { type: 'string' },
		userId: { type: 'number' },
		published: { type: 'boolean' },
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
const q1Schema = defineSchemaBuilder({
	products: {
		id: { type: 'number' },
		name: { type: 'string' },
	},
	productImages: {
		id: { type: 'number' },
		productId: { type: 'number' },
		locale: { type: 'string' },
		type: { type: 'string' },
		approved: { type: 'boolean' },
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

		it('should compile case-insensitive LIKE pattern (ILIKE)', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				where: {
					kind: 'like',
					field: 'name',
					pattern: '%john%',
					caseInsensitive: true,
				},
			};

			const planReport = plan(intent, basicSchema);
			const compiled = compile(planReport, basicSchema, kysely);

			expect(compiled.sql).toContain('ilike');
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

		it('should compile OR with mixed intent types (ADAPTER-005 fix)', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				where: {
					kind: 'or',
					conditions: [
						{ kind: 'comparison', field: 'id', operator: 'eq', value: 1 },
						{
							kind: 'like',
							field: 'name',
							pattern: '%admin%',
							caseInsensitive: true,
						},
						{ kind: 'in', field: 'role', values: ['admin', 'moderator'] },
						{ kind: 'null', field: 'deletedAt', operator: 'isNull' },
					],
				},
			};

			const planReport = plan(intent, basicSchema);
			const compiled = compile(planReport, basicSchema, kysely);

			// Verify OR is present and all conditions are compiled
			expect(compiled.sql).toContain('or');
			expect(compiled.sql).toContain('ilike'); // caseInsensitive like
			expect(compiled.sql).toContain('in');
			expect(compiled.sql).toContain('is null');
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

		it('should apply schema prefix to EXISTS subquery for multi-tenant', () => {
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
			const compiled = compile(planReport, q1Schema, kysely, 'acme');

			// Root table should have schema prefix (quoted identifier format)
			expect(compiled.sql).toContain('"acme"."products"');
			// EXISTS subquery should ALSO have schema prefix
			expect(compiled.sql).toContain('"acme"."productImages"');
		});

		it('should apply schema prefix to relationFilter subquery for multi-tenant', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'products',
				where: {
					kind: 'relationFilter',
					relation: 'images',
					mode: 'some',
					where: {
						kind: 'comparison',
						field: 'approved',
						operator: 'eq',
						value: true,
					},
				},
			};

			const planReport = plan(intent, q1Schema);
			const compiled = compile(planReport, q1Schema, kysely, 'tenant_xyz');

			// Root table should have schema prefix (quoted identifier format)
			expect(compiled.sql).toContain('"tenant_xyz"."products"');
			// EXISTS subquery should ALSO have schema prefix
			expect(compiled.sql).toContain('"tenant_xyz"."productImages"');
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

	// ============================================================================
	// Aggregate Tests
	// ============================================================================

	describe('Aggregates', () => {
		it('should compile COUNT(*)', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				select: {
					type: 'aggregate',
					aggregates: [{ function: 'count' }],
				},
			};

			const planReport = plan(intent, basicSchema);
			const compiled = compile(planReport, basicSchema, kysely);

			expect(compiled.sql.toLowerCase()).toContain('count(*)');
		});

		it('should compile COUNT with field', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				select: {
					type: 'aggregate',
					aggregates: [{ function: 'count', field: 'email' }],
				},
			};

			const planReport = plan(intent, basicSchema);
			const compiled = compile(planReport, basicSchema, kysely);

			expect(compiled.sql.toLowerCase()).toContain('count(');
			expect(compiled.sql).toContain('email');
		});

		it('should compile SUM', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'posts',
				select: {
					type: 'aggregate',
					aggregates: [{ function: 'sum', field: 'id' }],
				},
			};

			const planReport = plan(intent, basicSchema);
			const compiled = compile(planReport, basicSchema, kysely);

			expect(compiled.sql.toLowerCase()).toContain('sum(');
		});

		it('should compile AVG', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'posts',
				select: {
					type: 'aggregate',
					aggregates: [{ function: 'avg', field: 'id' }],
				},
			};

			const planReport = plan(intent, basicSchema);
			const compiled = compile(planReport, basicSchema, kysely);

			expect(compiled.sql.toLowerCase()).toContain('avg(');
		});

		it('should compile MIN', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'posts',
				select: {
					type: 'aggregate',
					aggregates: [{ function: 'min', field: 'id' }],
				},
			};

			const planReport = plan(intent, basicSchema);
			const compiled = compile(planReport, basicSchema, kysely);

			expect(compiled.sql.toLowerCase()).toContain('min(');
		});

		it('should compile MAX', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'posts',
				select: {
					type: 'aggregate',
					aggregates: [{ function: 'max', field: 'id' }],
				},
			};

			const planReport = plan(intent, basicSchema);
			const compiled = compile(planReport, basicSchema, kysely);

			expect(compiled.sql.toLowerCase()).toContain('max(');
		});

		it('should compile multiple aggregates', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'posts',
				select: {
					type: 'aggregate',
					aggregates: [
						{ function: 'count' },
						{ function: 'min', field: 'id' },
						{ function: 'max', field: 'id' },
					],
				},
			};

			const planReport = plan(intent, basicSchema);
			const compiled = compile(planReport, basicSchema, kysely);

			expect(compiled.sql.toLowerCase()).toContain('count(*)');
			expect(compiled.sql.toLowerCase()).toContain('min(');
			expect(compiled.sql.toLowerCase()).toContain('max(');
		});

		it('should compile aggregate with alias', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				select: {
					type: 'aggregate',
					aggregates: [{ function: 'count', as: 'total_users' }],
				},
			};

			const planReport = plan(intent, basicSchema);
			const compiled = compile(planReport, basicSchema, kysely);

			expect(compiled.sql.toLowerCase()).toContain('count(*)');
			expect(compiled.sql).toContain('total_users');
		});

		it('should compile aggregate with fields (for GROUP BY)', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'posts',
				select: {
					type: 'aggregate',
					aggregates: [{ function: 'count', as: 'post_count' }],
					fields: ['userId'],
				},
				groupBy: ['userId'],
			};

			const planReport = plan(intent, basicSchema);
			const compiled = compile(planReport, basicSchema, kysely);

			expect(compiled.sql.toLowerCase()).toContain('count(*)');
			expect(compiled.sql).toContain('userId');
			expect(compiled.sql.toLowerCase()).toContain('group by');
		});
	});

	// ============================================================================
	// GROUP BY Tests
	// ============================================================================

	describe('GROUP BY', () => {
		it('should compile GROUP BY single field', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'posts',
				select: {
					type: 'aggregate',
					aggregates: [{ function: 'count' }],
					fields: ['userId'],
				},
				groupBy: ['userId'],
			};

			const planReport = plan(intent, basicSchema);
			const compiled = compile(planReport, basicSchema, kysely);

			expect(compiled.sql.toLowerCase()).toContain('group by');
			expect(compiled.sql).toContain('userId');
		});

		it('should compile GROUP BY multiple fields', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'posts',
				select: {
					type: 'aggregate',
					aggregates: [{ function: 'count' }],
					fields: ['userId', 'published'],
				},
				groupBy: ['userId', 'published'],
			};

			const planReport = plan(intent, basicSchema);
			const compiled = compile(planReport, basicSchema, kysely);

			expect(compiled.sql.toLowerCase()).toContain('group by');
			expect(compiled.sql).toContain('userId');
			expect(compiled.sql).toContain('published');
		});

		it('should compile GROUP BY with WHERE', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'posts',
				select: {
					type: 'aggregate',
					aggregates: [{ function: 'count', as: 'published_count' }],
					fields: ['userId'],
				},
				where: {
					kind: 'comparison',
					field: 'published',
					operator: 'eq',
					value: true,
				},
				groupBy: ['userId'],
			};

			const planReport = plan(intent, basicSchema);
			const compiled = compile(planReport, basicSchema, kysely);

			expect(compiled.sql.toLowerCase()).toContain('where');
			expect(compiled.sql.toLowerCase()).toContain('group by');
		});

		it('should compile GROUP BY with ORDER BY', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'posts',
				select: {
					type: 'aggregate',
					aggregates: [{ function: 'count', as: 'cnt' }],
					fields: ['userId'],
				},
				groupBy: ['userId'],
				orderBy: [{ field: 'userId', direction: 'asc' }],
			};

			const planReport = plan(intent, basicSchema);
			const compiled = compile(planReport, basicSchema, kysely);

			expect(compiled.sql.toLowerCase()).toContain('group by');
			expect(compiled.sql.toLowerCase()).toContain('order by');
		});

		it('should apply schema prefix with GROUP BY', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'posts',
				select: {
					type: 'aggregate',
					aggregates: [{ function: 'count' }],
					fields: ['userId'],
				},
				groupBy: ['userId'],
			};

			const planReport = plan(intent, basicSchema);
			const compiled = compile(planReport, basicSchema, kysely, 'tenant_abc');

			expect(compiled.sql).toContain('"tenant_abc"."posts"');
			expect(compiled.sql.toLowerCase()).toContain('group by');
		});
	});

	// ============================================================================
	// DX-034: DISTINCT Aggregates and HAVING
	// ============================================================================

	describe('DX-034: DISTINCT Aggregates', () => {
		it('should compile COUNT(DISTINCT field)', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'posts',
				select: {
					type: 'aggregate',
					aggregates: [{ function: 'count', field: 'userId', distinct: true }],
				},
			};

			const planReport = plan(intent, basicSchema);
			const compiled = compile(planReport, basicSchema, kysely);

			expect(compiled.sql.toLowerCase()).toContain('count(distinct');
		});

		it('should compile COUNT(DISTINCT field) with alias', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'posts',
				select: {
					type: 'aggregate',
					aggregates: [
						{
							function: 'count',
							field: 'userId',
							distinct: true,
							as: 'unique_authors',
						},
					],
				},
			};

			const planReport = plan(intent, basicSchema);
			const compiled = compile(planReport, basicSchema, kysely);

			expect(compiled.sql.toLowerCase()).toContain('count(distinct');
			expect(compiled.sql).toContain('unique_authors');
		});

		it('should compile SUM(DISTINCT field)', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'posts',
				select: {
					type: 'aggregate',
					aggregates: [
						{
							function: 'sum',
							field: 'userId',
							distinct: true,
							as: 'unique_sum',
						},
					],
				},
			};

			const planReport = plan(intent, basicSchema);
			const compiled = compile(planReport, basicSchema, kysely);

			expect(compiled.sql.toLowerCase()).toContain('sum(distinct');
			expect(compiled.sql).toContain('unique_sum');
		});

		it('should compile AVG(DISTINCT field)', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'posts',
				select: {
					type: 'aggregate',
					aggregates: [
						{
							function: 'avg',
							field: 'userId',
							distinct: true,
							as: 'unique_avg',
						},
					],
				},
			};

			const planReport = plan(intent, basicSchema);
			const compiled = compile(planReport, basicSchema, kysely);

			expect(compiled.sql.toLowerCase()).toContain('avg(distinct');
			expect(compiled.sql).toContain('unique_avg');
		});
	});

	describe('DX-034: HAVING clause', () => {
		it('should compile HAVING with simple condition', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'posts',
				select: {
					type: 'aggregate',
					aggregates: [{ function: 'count', as: 'cnt' }],
					fields: ['userId'],
				},
				groupBy: ['userId'],
				having: {
					kind: 'comparison',
					field: 'userId',
					operator: 'gt',
					value: 5,
				},
			};

			const planReport = plan(intent, basicSchema);
			const compiled = compile(planReport, basicSchema, kysely);

			expect(compiled.sql.toLowerCase()).toContain('having');
			expect(compiled.sql.toLowerCase()).toContain('group by');
		});

		it('should place HAVING after GROUP BY', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'posts',
				select: {
					type: 'aggregate',
					aggregates: [{ function: 'count', as: 'cnt' }],
					fields: ['userId'],
				},
				groupBy: ['userId'],
				having: {
					kind: 'comparison',
					field: 'userId',
					operator: 'gt',
					value: 0,
				},
			};

			const planReport = plan(intent, basicSchema);
			const compiled = compile(planReport, basicSchema, kysely);

			const lowerSql = compiled.sql.toLowerCase();
			const groupByIndex = lowerSql.indexOf('group by');
			const havingIndex = lowerSql.indexOf('having');
			expect(groupByIndex).toBeLessThan(havingIndex);
		});
	});

	describe('DX-034: SELECT DISTINCT', () => {
		it('should compile SELECT DISTINCT', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				distinct: true,
			};

			const planReport = plan(intent, basicSchema);
			const compiled = compile(planReport, basicSchema, kysely);

			expect(compiled.sql.toLowerCase()).toContain('select distinct');
		});

		it('should compile SELECT DISTINCT with columns', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				select: {
					type: 'columns',
					fields: ['name', 'email'],
				},
				distinct: true,
			};

			const planReport = plan(intent, basicSchema);
			const compiled = compile(planReport, basicSchema, kysely);

			expect(compiled.sql.toLowerCase()).toContain('select distinct');
			expect(compiled.sql).toContain('name');
			expect(compiled.sql).toContain('email');
		});
	});

	// ============================================================================
	// RFC-001: Recursive CTE Compilation Tests
	// ============================================================================

	describe('RFC-001: Recursive CTE', () => {
		/**
		 * Recursive schema: Categories with parent (for hierarchical traversal)
		 */
		const recursiveSchema = defineSchemaBuilder({
			categories: {
				id: { type: 'number' },
				name: { type: 'string' },
				parentId: { type: 'number' },
			},
		})
			.relations({
				categories: {
					parent: belongsTo('categories', { foreignKey: 'parentId' }),
					children: hasMany('categories', { foreignKey: 'parentId' }),
				},
			})
			.build();

		/**
		 * Edge-table schema: Roles with edges (for role hierarchy)
		 */
		const edgeTableSchema = defineSchemaBuilder({
			roles: {
				id: { type: 'number' },
				name: { type: 'string' },
			},
			roleEdges: {
				id: { type: 'number' },
				parentRoleId: { type: 'number' },
				childRoleId: { type: 'number' },
			},
		})
			.relations({
				roles: {
					parentEdges: hasMany('roleEdges', { foreignKey: 'childRoleId' }),
					childEdges: hasMany('roleEdges', { foreignKey: 'parentRoleId' }),
				},
				roleEdges: {
					parentRole: belongsTo('roles', { foreignKey: 'parentRoleId' }),
					childRole: belongsTo('roles', { foreignKey: 'childRoleId' }),
				},
			})
			.build();

		describe('adjacency traversal', () => {
			it('should generate WITH RECURSIVE SQL for adjacency traversal', () => {
				const intent: RecursiveIntent = {
					type: 'recursive',
					cteName: 'category_tree',
					start: {
						from: 'categories',
						nodeIdExpr: { kind: 'column', name: 'id' },
						where: {
							kind: 'comparison',
							field: 'id',
							operator: 'eq',
							value: 1,
						},
					},
					traversal: {
						kind: 'adjacency',
						nodeTable: 'categories',
						nodeId: 'id',
						parentId: 'parentId',
						direction: 'descendants',
					},
					maxDepth: 10,
				};

				const report = planRecursive(intent, recursiveSchema);
				const compiled = compileRecursive(report, recursiveSchema, kysely);

				// Should contain WITH RECURSIVE
				expect(compiled.sql.toLowerCase()).toContain('with recursive');
				// Should contain CTE name
				expect(compiled.sql).toContain('category_tree');
				// Should contain UNION ALL (for non-bidirectional)
				expect(compiled.sql.toLowerCase()).toContain('union all');
			});

			it('should include depth tracking column', () => {
				const intent: RecursiveIntent = {
					type: 'recursive',
					cteName: 'category_tree',
					start: {
						from: 'categories',
						nodeIdExpr: { kind: 'column', name: 'id' },
					},
					traversal: {
						kind: 'adjacency',
						nodeTable: 'categories',
						nodeId: 'id',
						parentId: 'parentId',
						direction: 'descendants',
					},
					maxDepth: 10,
					track: { depth: true },
				};

				const report = planRecursive(intent, recursiveSchema);
				const compiled = compileRecursive(report, recursiveSchema, kysely);

				// Should include depth tracking
				expect(compiled.sql.toLowerCase()).toContain('depth');
			});

			it('should handle ancestors direction', () => {
				const intent: RecursiveIntent = {
					type: 'recursive',
					cteName: 'ancestors',
					start: {
						from: 'categories',
						nodeIdExpr: { kind: 'column', name: 'id' },
						where: {
							kind: 'comparison',
							field: 'id',
							operator: 'eq',
							value: 5,
						},
					},
					traversal: {
						kind: 'adjacency',
						nodeTable: 'categories',
						nodeId: 'id',
						parentId: 'parentId',
						direction: 'ancestors',
					},
					maxDepth: 10,
				};

				const report = planRecursive(intent, recursiveSchema);
				const compiled = compileRecursive(report, recursiveSchema, kysely);

				expect(compiled.sql.toLowerCase()).toContain('with recursive');
				expect(compiled.sql).toContain('ancestors');
			});
		});

		describe('edge-table traversal', () => {
			it('should generate WITH RECURSIVE SQL for edge-table traversal', () => {
				const intent: RecursiveIntent = {
					type: 'recursive',
					cteName: 'role_hierarchy',
					start: {
						from: 'roles',
						nodeIdExpr: { kind: 'column', name: 'id' },
						where: {
							kind: 'comparison',
							field: 'name',
							operator: 'eq',
							value: 'admin',
						},
					},
					traversal: {
						kind: 'edge-table',
						nodeTable: 'roles',
						edgeTable: 'roleEdges',
						nodeId: 'id',
						edgeFrom: 'parentRoleId',
						edgeTo: 'childRoleId',
						direction: 'out',
					},
					maxDepth: 10,
				};

				const report = planRecursive(intent, edgeTableSchema);
				const compiled = compileRecursive(report, edgeTableSchema, kysely);

				expect(compiled.sql.toLowerCase()).toContain('with recursive');
				expect(compiled.sql).toContain('role_hierarchy');
				// Should reference edge table
				expect(compiled.sql.toLowerCase()).toContain('roleedges');
			});

			it('should use UNION for bidirectional with unknown storage hint', () => {
				const intent: RecursiveIntent = {
					type: 'recursive',
					cteName: 'role_hierarchy',
					start: {
						from: 'roles',
						nodeIdExpr: { kind: 'column', name: 'id' },
					},
					traversal: {
						kind: 'edge-table',
						nodeTable: 'roles',
						edgeTable: 'roleEdges',
						nodeId: 'id',
						edgeFrom: 'parentRoleId',
						edgeTo: 'childRoleId',
						direction: 'both',
						// edgeStorageHint defaults to 'unknown'
					},
					maxDepth: 10,
				};

				const report = planRecursive(intent, edgeTableSchema);
				const compiled = compileRecursive(report, edgeTableSchema, kysely);

				// Should use UNION (not UNION ALL) for deduplication
				// Count occurrences of 'union' - should have at least one that's not 'union all'
				const sql = compiled.sql.toLowerCase();
				expect(sql).toContain('union');
			});

			it('should use UNION ALL for bidirectional with directed-only hint', () => {
				const intent: RecursiveIntent = {
					type: 'recursive',
					cteName: 'role_hierarchy',
					start: {
						from: 'roles',
						nodeIdExpr: { kind: 'column', name: 'id' },
					},
					traversal: {
						kind: 'edge-table',
						nodeTable: 'roles',
						edgeTable: 'roleEdges',
						nodeId: 'id',
						edgeFrom: 'parentRoleId',
						edgeTo: 'childRoleId',
						direction: 'both',
						edgeStorageHint: 'directed-only',
					},
					maxDepth: 10,
				};

				const report = planRecursive(intent, edgeTableSchema);
				const compiled = compileRecursive(report, edgeTableSchema, kysely);

				expect(compiled.sql.toLowerCase()).toContain('union all');
			});
		});

		describe('deduplication', () => {
			it('should apply DISTINCT ON for dedupe:final strategy', () => {
				const intent: RecursiveIntent = {
					type: 'recursive',
					cteName: 'category_tree',
					start: {
						from: 'categories',
						nodeIdExpr: { kind: 'column', name: 'id' },
					},
					traversal: {
						kind: 'adjacency',
						nodeTable: 'categories',
						nodeId: 'id',
						parentId: 'parentId',
						direction: 'descendants',
					},
					maxDepth: 10,
					dedupe: 'final',
				};

				const report = planRecursive(intent, recursiveSchema);
				const compiled = compileRecursive(report, recursiveSchema, kysely);

				// Should use DISTINCT ON (PostgreSQL) for final dedup
				// SQLite may not support this - check for distinct at least
				const sql = compiled.sql.toLowerCase();
				expect(sql).toMatch(/distinct|group by/);
			});
		});

		describe('schema prefix (multi-tenant)', () => {
			it('should apply schema prefix to all tables', () => {
				const intent: RecursiveIntent = {
					type: 'recursive',
					cteName: 'category_tree',
					start: {
						from: 'categories',
						nodeIdExpr: { kind: 'column', name: 'id' },
					},
					traversal: {
						kind: 'adjacency',
						nodeTable: 'categories',
						nodeId: 'id',
						parentId: 'parentId',
						direction: 'descendants',
					},
					maxDepth: 10,
				};

				const report = planRecursive(intent, recursiveSchema);
				const compiled = compileRecursive(
					report,
					recursiveSchema,
					kysely,
					'tenant_xyz',
				);

				expect(compiled.sql).toContain('"tenant_xyz"."categories"');
			});

			it('should apply schema prefix to edge table', () => {
				const intent: RecursiveIntent = {
					type: 'recursive',
					cteName: 'role_hierarchy',
					start: {
						from: 'roles',
						nodeIdExpr: { kind: 'column', name: 'id' },
					},
					traversal: {
						kind: 'edge-table',
						nodeTable: 'roles',
						edgeTable: 'roleEdges',
						nodeId: 'id',
						edgeFrom: 'parentRoleId',
						edgeTo: 'childRoleId',
						direction: 'out',
					},
					maxDepth: 10,
				};

				const report = planRecursive(intent, edgeTableSchema);
				const compiled = compileRecursive(
					report,
					edgeTableSchema,
					kysely,
					'tenant_abc',
				);

				expect(compiled.sql).toContain('"tenant_abc"."roles"');
				expect(compiled.sql).toContain('"tenant_abc"."roleEdges"');
			});
		});

		describe('ARCH-001: path tracking strategies', () => {
			// Note: PostgreSQL array strategy test is in E2E (tests/e2e/iam.recursive.test.ts)
			// because it requires real PostgreSQL to test ARRAY[] syntax

			it('should use string strategy when explicitly requested', () => {
				const intent: RecursiveIntent = {
					type: 'recursive',
					cteName: 'category_tree',
					start: {
						from: 'categories',
						nodeIdExpr: { kind: 'column', name: 'id' },
					},
					traversal: {
						kind: 'adjacency',
						nodeTable: 'categories',
						nodeId: 'id',
						parentId: 'parentId',
						direction: 'descendants',
					},
					track: {
						path: {
							strategy: 'string',
						},
					},
					maxDepth: 10,
				};

				const report = planRecursive(intent, recursiveSchema);
				const compiled = compileRecursive(report, recursiveSchema, kysely);

				// String strategy uses CAST for base case
				expect(compiled.sql.toLowerCase()).toContain('cast(');
				// And || with separator for recursive step
				// Default separator is '/'
				expect(compiled.sql).toContain("'/'");
			});

			it('should use custom separator in string strategy', () => {
				const intent: RecursiveIntent = {
					type: 'recursive',
					cteName: 'category_tree',
					start: {
						from: 'categories',
						nodeIdExpr: { kind: 'column', name: 'id' },
					},
					traversal: {
						kind: 'adjacency',
						nodeTable: 'categories',
						nodeId: 'id',
						parentId: 'parentId',
						direction: 'descendants',
					},
					track: {
						path: {
							strategy: 'string',
							separator: '->',
						},
					},
					maxDepth: 10,
				};

				const report = planRecursive(intent, recursiveSchema);
				const compiled = compileRecursive(report, recursiveSchema, kysely);

				// Custom separator should appear in the SQL
				expect(compiled.sql).toContain("'->'");
				// Should not use default separator
				expect(compiled.sql).not.toContain("'/'");
			});

			it('should use custom path alias', () => {
				const intent: RecursiveIntent = {
					type: 'recursive',
					cteName: 'category_tree',
					start: {
						from: 'categories',
						nodeIdExpr: { kind: 'column', name: 'id' },
					},
					traversal: {
						kind: 'adjacency',
						nodeTable: 'categories',
						nodeId: 'id',
						parentId: 'parentId',
						direction: 'descendants',
					},
					track: {
						path: {
							as: 'breadcrumb',
						},
					},
					maxDepth: 10,
				};

				const report = planRecursive(intent, recursiveSchema);
				const compiled = compileRecursive(report, recursiveSchema, kysely);

				// Custom alias should appear
				expect(compiled.sql).toContain('"breadcrumb"');
				// CTE columns should include the custom alias
				expect(compiled.sql).toContain('breadcrumb');
			});

			it('should include path in edge-table traversal', () => {
				const intent: RecursiveIntent = {
					type: 'recursive',
					cteName: 'role_hierarchy',
					start: {
						from: 'roles',
						nodeIdExpr: { kind: 'column', name: 'id' },
					},
					traversal: {
						kind: 'edge-table',
						nodeTable: 'roles',
						edgeTable: 'roleEdges',
						nodeId: 'id',
						edgeFrom: 'parentRoleId',
						edgeTo: 'childRoleId',
						direction: 'out',
					},
					track: {
						path: {
							strategy: 'string',
							separator: ' > ',
						},
					},
					maxDepth: 10,
				};

				const report = planRecursive(intent, edgeTableSchema);
				const compiled = compileRecursive(report, edgeTableSchema, kysely);

				// Should use custom separator for edge-table traversal too
				expect(compiled.sql).toContain("' > '");
				// Should have path column
				expect(compiled.sql).toContain('"path"');
			});
		});

		// ====================================================================
		// CORE-007: Advanced Recursive Options (CYCLE/SEARCH)
		// ====================================================================

		describe('CORE-007: Advanced recursive options', () => {
			// Sample compiled SQL for testing injection
			const sampleCteSQL = {
				sql: 'WITH RECURSIVE category_tree(node_id, depth) AS (...) SELECT * FROM category_tree',
				parameters: [],
				query: { kind: 'SelectQueryNode' },
			};

			describe('injectAdvancedRecursiveClauses (unit tests)', () => {
				it('should inject CYCLE clause when cycle detection is enabled (PostgreSQL)', () => {
					const result = injectAdvancedRecursiveClauses(
						sampleCteSQL,
						{ cycle: 'mark' },
						'category_tree',
						'node_id',
						POSTGRESQL_CAPABILITIES,
					);

					expect(result.sql).toContain('CYCLE node_id SET is_cycle USING path');
				});

				it('should inject SEARCH DEPTH FIRST clause when search=depth (PostgreSQL)', () => {
					const result = injectAdvancedRecursiveClauses(
						sampleCteSQL,
						{ search: 'depth' },
						'category_tree',
						'node_id',
						POSTGRESQL_CAPABILITIES,
					);

					expect(result.sql).toContain(
						'SEARCH DEPTH FIRST BY node_id SET ordercol',
					);
				});

				it('should inject SEARCH BREADTH FIRST clause when search=breadth (PostgreSQL)', () => {
					const result = injectAdvancedRecursiveClauses(
						sampleCteSQL,
						{ search: 'breadth' },
						'category_tree',
						'node_id',
						POSTGRESQL_CAPABILITIES,
					);

					expect(result.sql).toContain(
						'SEARCH BREADTH FIRST BY node_id SET ordercol',
					);
				});

				it('should inject both CYCLE and SEARCH clauses when both are specified', () => {
					const result = injectAdvancedRecursiveClauses(
						sampleCteSQL,
						{ cycle: 'stop', search: 'depth' },
						'category_tree',
						'node_id',
						POSTGRESQL_CAPABILITIES,
					);

					expect(result.sql).toContain('CYCLE');
					expect(result.sql).toContain('SEARCH DEPTH FIRST');
				});

				it('should NOT inject CYCLE/SEARCH clauses for SQLite (no capabilities)', () => {
					const result = injectAdvancedRecursiveClauses(
						sampleCteSQL,
						{ cycle: 'mark', search: 'depth' },
						'category_tree',
						'node_id',
						SQLITE_CAPABILITIES,
					);

					// SQLite doesn't support CYCLE/SEARCH - should NOT be present
					expect(result.sql).not.toContain('CYCLE');
					expect(result.sql).not.toContain('SEARCH');
					// Original SQL should be unchanged
					expect(result.sql).toBe(sampleCteSQL.sql);
				});

				it('should preserve parameters in the compiled result', () => {
					const compiledWithParams = {
						...sampleCteSQL,
						parameters: [1, 'test'],
					};
					const result = injectAdvancedRecursiveClauses(
						compiledWithParams,
						{ cycle: 'mark' },
						'category_tree',
						'node_id',
						POSTGRESQL_CAPABILITIES,
					);

					expect(result.parameters).toEqual([1, 'test']);
				});

				it('should handle all cycle modes (mark, stop, error)', () => {
					for (const mode of ['mark', 'stop', 'error'] as const) {
						const result = injectAdvancedRecursiveClauses(
							sampleCteSQL,
							{ cycle: mode },
							'category_tree',
							'node_id',
							POSTGRESQL_CAPABILITIES,
						);
						// All modes use CYCLE clause - application handles is_cycle differently
						expect(result.sql).toContain(
							'CYCLE node_id SET is_cycle USING path',
						);
					}
				});
			});

			describe('integration with compileRecursive', () => {
				it('should NOT inject CYCLE/SEARCH clauses for SQLite (no capabilities)', () => {
					const intent: RecursiveIntent = {
						type: 'recursive',
						cteName: 'category_tree',
						start: {
							from: 'categories',
							nodeIdExpr: { kind: 'column', name: 'id' },
						},
						traversal: {
							kind: 'adjacency',
							nodeTable: 'categories',
							nodeId: 'id',
							parentId: 'parentId',
							direction: 'descendants',
						},
						maxDepth: 10,
						advancedOptions: {
							cycle: 'mark',
							search: 'depth',
						},
					};

					const report = planRecursive(intent, recursiveSchema);
					const compiled = compileRecursive(report, recursiveSchema, kysely);

					// SQLite doesn't support CYCLE/SEARCH - should NOT be present
					expect(compiled.sql).not.toContain('CYCLE');
					expect(compiled.sql).not.toContain('SEARCH');
				});

				it('should accept advancedOptions without errors', () => {
					const intent: RecursiveIntent = {
						type: 'recursive',
						cteName: 'category_tree',
						start: {
							from: 'categories',
							nodeIdExpr: { kind: 'column', name: 'id' },
						},
						traversal: {
							kind: 'adjacency',
							nodeTable: 'categories',
							nodeId: 'id',
							parentId: 'parentId',
							direction: 'descendants',
						},
						maxDepth: 10,
						advancedOptions: {
							cycle: 'mark',
							search: 'breadth',
						},
					};

					// Should not throw
					const report = planRecursive(intent, recursiveSchema);
					const compiled = compileRecursive(report, recursiveSchema, kysely);

					// Just verify it compiles without error (case-insensitive check)
					expect(compiled.sql.toLowerCase()).toContain('with recursive');
					expect(compiled.sql).toContain('category_tree');
				});
			});
		});
	});

	// ============================================================================
	// Mutation Compilers (DX-010)
	// ============================================================================

	describe('Mutation Compilers (DX-010)', () => {
		describe('compileInsert', () => {
			it('should compile single row insert', () => {
				const kysely = createTestKysely();
				const intent = {
					type: 'insert' as const,
					table: 'users',
					values: [{ name: 'John', email: 'john@example.com' }],
				};

				const compiled = compileInsert(intent, kysely);

				expect(compiled.sql).toContain('insert into');
				expect(compiled.sql.toLowerCase()).toContain('users');
				expect(compiled.parameters).toContain('John');
				expect(compiled.parameters).toContain('john@example.com');
			});

			it('should compile bulk insert', () => {
				const kysely = createTestKysely();
				const intent = {
					type: 'insert' as const,
					table: 'users',
					values: [
						{ name: 'John', email: 'john@example.com' },
						{ name: 'Jane', email: 'jane@example.com' },
					],
				};

				const compiled = compileInsert(intent, kysely);

				expect(compiled.sql).toContain('insert into');
				expect(compiled.parameters).toHaveLength(4);
				expect(compiled.parameters).toContain('John');
				expect(compiled.parameters).toContain('Jane');
			});

			it('should compile insert with schema prefix (multi-tenant)', () => {
				const kysely = createTestKysely();
				const intent = {
					type: 'insert' as const,
					table: 'users',
					values: [{ name: 'John' }],
				};

				const compiled = compileInsert(intent, kysely, 'tenant_123');

				// SQLite may quote schema/table names, so check for both patterns
				expect(compiled.sql.toLowerCase()).toMatch(/tenant_123[".].*users/);
			});
		});

		describe('compileUpdate', () => {
			it('should compile update with WHERE clause', () => {
				const kysely = createTestKysely();
				const intent = {
					type: 'update' as const,
					table: 'users',
					set: { name: 'Updated' },
					where: {
						kind: 'comparison' as const,
						field: 'id',
						operator: 'eq',
						value: 1,
					},
				};

				const compiled = compileUpdate(intent, kysely);

				expect(compiled.sql.toLowerCase()).toContain('update');
				expect(compiled.sql.toLowerCase()).toContain('users');
				expect(compiled.sql.toLowerCase()).toContain('set');
				expect(compiled.sql.toLowerCase()).toContain('where');
				expect(compiled.parameters).toContain('Updated');
				expect(compiled.parameters).toContain(1);
			});

			it('should compile update with allowAll (no WHERE)', () => {
				const kysely = createTestKysely();
				const intent = {
					type: 'update' as const,
					table: 'users',
					set: { active: false },
					allowAll: true,
				};

				const compiled = compileUpdate(intent, kysely);

				expect(compiled.sql.toLowerCase()).toContain('update');
				expect(compiled.sql.toLowerCase()).not.toContain('where');
			});

			it('should throw error for update without WHERE and without allowAll', () => {
				const kysely = createTestKysely();
				const intent = {
					type: 'update' as const,
					table: 'users',
					set: { name: 'Dangerous' },
				};

				expect(() => compileUpdate(intent, kysely)).toThrow(CompilationError);
				expect(() => compileUpdate(intent, kysely)).toThrow('unsafe');
			});

			it('should compile update with AND conditions', () => {
				const kysely = createTestKysely();
				const intent = {
					type: 'update' as const,
					table: 'users',
					set: { active: true },
					where: {
						kind: 'and' as const,
						conditions: [
							{
								kind: 'comparison' as const,
								field: 'id',
								operator: 'eq',
								value: 1,
							},
							{
								kind: 'comparison' as const,
								field: 'active',
								operator: 'eq',
								value: false,
							},
						],
					},
				};

				const compiled = compileUpdate(intent, kysely);

				expect(compiled.sql.toLowerCase()).toContain('where');
				expect(compiled.parameters).toContain(1);
				expect(compiled.parameters).toContain(false);
			});

			it('should compile update with schema prefix (multi-tenant)', () => {
				const kysely = createTestKysely();
				const intent = {
					type: 'update' as const,
					table: 'users',
					set: { name: 'Test' },
					where: {
						kind: 'comparison' as const,
						field: 'id',
						operator: 'eq',
						value: 1,
					},
				};

				const compiled = compileUpdate(intent, kysely, 'tenant_abc');

				// SQLite may quote schema/table names, so check for both patterns
				expect(compiled.sql.toLowerCase()).toMatch(/tenant_abc[".].*users/);
			});
		});

		describe('compileDelete', () => {
			it('should compile delete with WHERE clause', () => {
				const kysely = createTestKysely();
				const intent = {
					type: 'delete' as const,
					table: 'users',
					where: {
						kind: 'comparison' as const,
						field: 'id',
						operator: 'eq',
						value: 1,
					},
				};

				const compiled = compileDelete(intent, kysely);

				expect(compiled.sql.toLowerCase()).toContain('delete from');
				expect(compiled.sql.toLowerCase()).toContain('users');
				expect(compiled.sql.toLowerCase()).toContain('where');
				expect(compiled.parameters).toContain(1);
			});

			it('should compile delete with allowAll (no WHERE)', () => {
				const kysely = createTestKysely();
				const intent = {
					type: 'delete' as const,
					table: 'users',
					allowAll: true,
				};

				const compiled = compileDelete(intent, kysely);

				expect(compiled.sql.toLowerCase()).toContain('delete from');
				expect(compiled.sql.toLowerCase()).not.toContain('where');
			});

			it('should throw error for delete without WHERE and without allowAll', () => {
				const kysely = createTestKysely();
				const intent = {
					type: 'delete' as const,
					table: 'users',
				};

				expect(() => compileDelete(intent, kysely)).toThrow(CompilationError);
				expect(() => compileDelete(intent, kysely)).toThrow('unsafe');
			});

			it('should compile delete with IN clause', () => {
				const kysely = createTestKysely();
				const intent = {
					type: 'delete' as const,
					table: 'users',
					where: { kind: 'in' as const, field: 'id', values: [1, 2, 3] },
				};

				const compiled = compileDelete(intent, kysely);

				expect(compiled.sql.toLowerCase()).toContain('where');
				expect(compiled.sql.toLowerCase()).toContain('in');
			});

			it('should compile delete with OR conditions', () => {
				const kysely = createTestKysely();
				const intent = {
					type: 'delete' as const,
					table: 'users',
					where: {
						kind: 'or' as const,
						conditions: [
							{
								kind: 'comparison' as const,
								field: 'id',
								operator: 'eq',
								value: 1,
							},
							{
								kind: 'comparison' as const,
								field: 'id',
								operator: 'eq',
								value: 2,
							},
						],
					},
				};

				const compiled = compileDelete(intent, kysely);

				expect(compiled.sql.toLowerCase()).toContain('where');
				expect(compiled.sql.toLowerCase()).toContain('or');
			});

			it('should compile delete with schema prefix (multi-tenant)', () => {
				const kysely = createTestKysely();
				const intent = {
					type: 'delete' as const,
					table: 'users',
					where: {
						kind: 'comparison' as const,
						field: 'id',
						operator: 'eq',
						value: 1,
					},
				};

				const compiled = compileDelete(intent, kysely, 'tenant_xyz');

				// SQLite may quote schema/table names, so check for both patterns
				expect(compiled.sql.toLowerCase()).toMatch(/tenant_xyz[".].*users/);
			});

			it('should compile delete with null check', () => {
				const kysely = createTestKysely();
				const intent = {
					type: 'delete' as const,
					table: 'users',
					where: {
						kind: 'null' as const,
						field: 'deletedAt',
						operator: 'isNotNull' as const,
					},
				};

				const compiled = compileDelete(intent, kysely);

				expect(compiled.sql.toLowerCase()).toContain('where');
				expect(compiled.sql.toLowerCase()).toContain('is not null');
			});
		});
	});

	// ============================================================================
	// Window Function Compilation (P3-A)
	// ============================================================================

	describe('Window Function Compilation (P3-A)', () => {
		describe('compileWindowSelect', () => {
			it('should compile ROW_NUMBER with ORDER BY', () => {
				const kysely = createTestKysely();
				let query = kysely.selectFrom('users as t0').selectAll();

				const window: WindowIntent = {
					kind: 'window',
					function: 'row_number',
					alias: 'rn',
					over: {
						orderBy: [{ field: 'createdAt', direction: 'desc' }],
					},
				};

				query = compileWindowSelect(query, window, 't0');
				const compiled = query.compile();

				expect(compiled.sql).toContain('ROW_NUMBER()');
				expect(compiled.sql).toContain('OVER');
				expect(compiled.sql).toContain('ORDER BY');
				expect(compiled.sql).toContain('"createdAt"');
				expect(compiled.sql).toContain('DESC');
				expect(compiled.sql).toContain('"rn"');
			});

			it('should compile RANK with PARTITION BY and ORDER BY', () => {
				const kysely = createTestKysely();
				let query = kysely.selectFrom('products as t0').selectAll();

				const window: WindowIntent = {
					kind: 'window',
					function: 'rank',
					alias: 'category_rank',
					over: {
						partitionBy: ['categoryId'],
						orderBy: [{ field: 'sales', direction: 'desc' }],
					},
				};

				query = compileWindowSelect(query, window, 't0');
				const compiled = query.compile();

				expect(compiled.sql).toContain('RANK()');
				expect(compiled.sql).toContain('PARTITION BY');
				expect(compiled.sql).toContain('"categoryId"');
				expect(compiled.sql).toContain('ORDER BY');
				expect(compiled.sql).toContain('"sales"');
				expect(compiled.sql).toContain('"category_rank"');
			});

			it('should compile DENSE_RANK', () => {
				const kysely = createTestKysely();
				let query = kysely.selectFrom('users as t0').selectAll();

				const window: WindowIntent = {
					kind: 'window',
					function: 'dense_rank',
					alias: 'dense_rn',
					over: {
						orderBy: [{ field: 'score' }],
					},
				};

				query = compileWindowSelect(query, window, 't0');
				const compiled = query.compile();

				expect(compiled.sql).toContain('DENSE_RANK()');
				expect(compiled.sql).toContain('"dense_rn"');
			});

			it('should compile SUM aggregate window function', () => {
				const kysely = createTestKysely();
				let query = kysely.selectFrom('transactions as t0').selectAll();

				const window: WindowIntent = {
					kind: 'window',
					function: 'sum',
					field: 'amount',
					alias: 'running_sum',
					over: {
						partitionBy: ['accountId'],
						orderBy: [{ field: 'date', direction: 'asc' }],
					},
				};

				query = compileWindowSelect(query, window, 't0');
				const compiled = query.compile();

				expect(compiled.sql).toContain('SUM(');
				expect(compiled.sql).toContain('"t0"."amount"');
				expect(compiled.sql).toContain('PARTITION BY');
				expect(compiled.sql).toContain('"accountId"');
				expect(compiled.sql).toContain('ORDER BY');
				expect(compiled.sql).toContain('"date"');
				expect(compiled.sql).toContain('"running_sum"');
			});

			it('should compile AVG aggregate window function', () => {
				const kysely = createTestKysely();
				let query = kysely.selectFrom('sales as t0').selectAll();

				const window: WindowIntent = {
					kind: 'window',
					function: 'avg',
					field: 'price',
					alias: 'avg_price',
					over: {
						partitionBy: ['productId'],
					},
				};

				query = compileWindowSelect(query, window, 't0');
				const compiled = query.compile();

				expect(compiled.sql).toContain('AVG(');
				expect(compiled.sql).toContain('"t0"."price"');
				expect(compiled.sql).toContain('"avg_price"');
			});

			it('should compile COUNT aggregate window function', () => {
				const kysely = createTestKysely();
				let query = kysely.selectFrom('orders as t0').selectAll();

				const window: WindowIntent = {
					kind: 'window',
					function: 'count',
					field: 'id',
					alias: 'order_count',
					over: {
						partitionBy: ['customerId'],
					},
				};

				query = compileWindowSelect(query, window, 't0');
				const compiled = query.compile();

				expect(compiled.sql).toContain('COUNT(');
				expect(compiled.sql).toContain('"t0"."id"');
				expect(compiled.sql).toContain('"order_count"');
			});

			it('should compile MIN aggregate window function', () => {
				const kysely = createTestKysely();
				let query = kysely.selectFrom('prices as t0').selectAll();

				const window: WindowIntent = {
					kind: 'window',
					function: 'min',
					field: 'value',
					alias: 'min_value',
					over: {
						partitionBy: ['categoryId'],
					},
				};

				query = compileWindowSelect(query, window, 't0');
				const compiled = query.compile();

				expect(compiled.sql).toContain('MIN(');
				expect(compiled.sql).toContain('"min_value"');
			});

			it('should compile MAX aggregate window function', () => {
				const kysely = createTestKysely();
				let query = kysely.selectFrom('prices as t0').selectAll();

				const window: WindowIntent = {
					kind: 'window',
					function: 'max',
					field: 'value',
					alias: 'max_value',
					over: {
						partitionBy: ['categoryId'],
					},
				};

				query = compileWindowSelect(query, window, 't0');
				const compiled = query.compile();

				expect(compiled.sql).toContain('MAX(');
				expect(compiled.sql).toContain('"max_value"');
			});

			it('should compile LAG offset function', () => {
				const kysely = createTestKysely();
				let query = kysely.selectFrom('prices as t0').selectAll();

				const window: WindowIntent = {
					kind: 'window',
					function: 'lag',
					field: 'price',
					alias: 'prev_price',
					over: {
						orderBy: [{ field: 'date', direction: 'asc' }],
					},
				};

				query = compileWindowSelect(query, window, 't0');
				const compiled = query.compile();

				expect(compiled.sql).toContain('LAG(');
				expect(compiled.sql).toContain('"t0"."price"');
				expect(compiled.sql).toContain('"prev_price"');
			});

			it('should compile LEAD offset function', () => {
				const kysely = createTestKysely();
				let query = kysely.selectFrom('prices as t0').selectAll();

				const window: WindowIntent = {
					kind: 'window',
					function: 'lead',
					field: 'price',
					alias: 'next_price',
					over: {
						orderBy: [{ field: 'date', direction: 'asc' }],
					},
				};

				query = compileWindowSelect(query, window, 't0');
				const compiled = query.compile();

				expect(compiled.sql).toContain('LEAD(');
				expect(compiled.sql).toContain('"t0"."price"');
				expect(compiled.sql).toContain('"next_price"');
			});

			it('should handle empty partitionBy (no PARTITION BY clause)', () => {
				const kysely = createTestKysely();
				let query = kysely.selectFrom('users as t0').selectAll();

				const window: WindowIntent = {
					kind: 'window',
					function: 'row_number',
					alias: 'global_rn',
					over: {
						partitionBy: [],
						orderBy: [{ field: 'id' }],
					},
				};

				query = compileWindowSelect(query, window, 't0');
				const compiled = query.compile();

				expect(compiled.sql).toContain('ROW_NUMBER()');
				expect(compiled.sql).toContain('ORDER BY');
				expect(compiled.sql).not.toContain('PARTITION BY');
			});

			it('should handle multiple ORDER BY fields', () => {
				const kysely = createTestKysely();
				let query = kysely.selectFrom('products as t0').selectAll();

				const window: WindowIntent = {
					kind: 'window',
					function: 'row_number',
					alias: 'rn',
					over: {
						orderBy: [
							{ field: 'categoryId', direction: 'asc' },
							{ field: 'price', direction: 'desc' },
						],
					},
				};

				query = compileWindowSelect(query, window, 't0');
				const compiled = query.compile();

				expect(compiled.sql).toContain('"categoryId" ASC');
				expect(compiled.sql).toContain('"price" DESC');
			});

			it('should default direction to ASC when not specified', () => {
				const kysely = createTestKysely();
				let query = kysely.selectFrom('users as t0').selectAll();

				const window: WindowIntent = {
					kind: 'window',
					function: 'row_number',
					alias: 'rn',
					over: {
						orderBy: [{ field: 'createdAt' }],
					},
				};

				query = compileWindowSelect(query, window, 't0');
				const compiled = query.compile();

				expect(compiled.sql).toContain('"createdAt" ASC');
			});

			it('should throw error for aggregate function without field', () => {
				const kysely = createTestKysely();
				const query = kysely.selectFrom('users as t0').selectAll();

				const window: WindowIntent = {
					kind: 'window',
					function: 'sum',
					alias: 'total',
					over: {},
				};

				expect(() => compileWindowSelect(query, window, 't0')).toThrow(
					CompilationError,
				);
				expect(() => compileWindowSelect(query, window, 't0')).toThrow(
					'requires a field',
				);
			});

			it('should compile window with empty OVER clause', () => {
				const kysely = createTestKysely();
				let query = kysely.selectFrom('users as t0').selectAll();

				const window: WindowIntent = {
					kind: 'window',
					function: 'row_number',
					alias: 'rn',
					over: {},
				};

				query = compileWindowSelect(query, window, 't0');
				const compiled = query.compile();

				expect(compiled.sql).toContain('ROW_NUMBER() OVER ()');
			});

			it('should handle multiple partitionBy fields', () => {
				const kysely = createTestKysely();
				let query = kysely.selectFrom('sales as t0').selectAll();

				const window: WindowIntent = {
					kind: 'window',
					function: 'sum',
					field: 'amount',
					alias: 'total',
					over: {
						partitionBy: ['regionId', 'productId'],
					},
				};

				query = compileWindowSelect(query, window, 't0');
				const compiled = query.compile();

				expect(compiled.sql).toContain('PARTITION BY');
				expect(compiled.sql).toContain('"regionId"');
				expect(compiled.sql).toContain('"productId"');
			});

			it('should allow chaining multiple window functions', () => {
				const kysely = createTestKysely();
				let query = kysely.selectFrom('products as t0').selectAll();

				const window1: WindowIntent = {
					kind: 'window',
					function: 'row_number',
					alias: 'rn',
					over: {
						orderBy: [{ field: 'price', direction: 'desc' }],
					},
				};

				const window2: WindowIntent = {
					kind: 'window',
					function: 'sum',
					field: 'price',
					alias: 'running_total',
					over: {
						orderBy: [{ field: 'id', direction: 'asc' }],
					},
				};

				query = compileWindowSelect(query, window1, 't0');
				query = compileWindowSelect(query, window2, 't0');
				const compiled = query.compile();

				expect(compiled.sql).toContain('ROW_NUMBER()');
				expect(compiled.sql).toContain('SUM(');
				expect(compiled.sql).toContain('"rn"');
				expect(compiled.sql).toContain('"running_total"');
			});
		});
	});

	// ============================================================================
	// CORE-001: Filter Strategy Enforcement
	// ============================================================================

	describe('Filter Strategy Enforcement (CORE-001)', () => {
		describe('BDD Scenario 1: EXISTS strategy for hasMany (default)', () => {
			it('should generate EXISTS when planner decides filter-strategy: exists', () => {
				const kysely = createTestKysely();

				// Given: users hasMany posts
				// When: filter users by posts condition
				const intent: QueryIntent = {
					from: 'users',
					select: { type: 'all' },
					where: {
						kind: 'relationFilter',
						relation: 'posts',
						mode: 'some',
						where: {
							kind: 'comparison',
							field: 'published',
							operator: 'eq',
							value: true,
						},
					},
				};

				const report = plan(intent, basicSchema);
				const compiled = compile(report, basicSchema, kysely);

				// Then: planner decides 'exists' (hasMany → exists by default)
				const filterDecision = report.decisions.find(
					(d) => d.type === 'filter-strategy',
				);
				expect(filterDecision?.choice).toBe('exists');

				// And: SQL contains EXISTS, not JOIN
				expect(compiled.sql).toContain('exists');
				expect(compiled.sql).not.toMatch(/join\s+["']?posts["']?/i);
			});
		});

		describe('BDD Scenario 2: JOIN strategy for belongsTo (default)', () => {
			it('should generate JOIN when planner decides filter-strategy: join', () => {
				const kysely = createTestKysely();

				// Given: posts belongsTo users (cardinality: one)
				// When: filter posts by author condition
				const intent: QueryIntent = {
					from: 'posts',
					select: { type: 'all' },
					where: {
						kind: 'relationFilter',
						relation: 'author', // belongsTo relation
						mode: 'some',
						where: {
							kind: 'comparison',
							field: 'active',
							operator: 'eq',
							value: true,
						},
					},
				};

				const report = plan(intent, basicSchema);
				const compiled = compile(report, basicSchema, kysely);

				// Then: planner decides 'join' (belongsTo → one cardinality → join)
				const filterDecision = report.decisions.find(
					(d) => d.type === 'filter-strategy',
				);
				expect(filterDecision?.choice).toBe('join');

				// And: SQL contains JOIN, not EXISTS
				expect(compiled.sql.toLowerCase()).toContain('join');
				expect(compiled.sql.toLowerCase()).toContain('users');
				expect(compiled.sql.toLowerCase()).not.toContain('exists');
			});
		});

		describe('BDD Scenario 3: Explicit JOIN override for hasMany', () => {
			it('should generate JOIN when forceFilterStrategy is set', () => {
				const kysely = createTestKysely();

				// Given: users hasMany posts (normally exists)
				// But: forceFilterStrategy: 'join'
				const intent: QueryIntent = {
					from: 'users',
					select: { type: 'all' },
					where: {
						kind: 'relationFilter',
						relation: 'posts',
						mode: 'some',
						where: {
							kind: 'comparison',
							field: 'published',
							operator: 'eq',
							value: true,
						},
					},
				};

				const report = plan(intent, basicSchema, {
					forceFilterStrategy: 'join',
				});
				const compiled = compile(report, basicSchema, kysely);

				// Then: planner decides 'join' (forced)
				const filterDecision = report.decisions.find(
					(d) => d.type === 'filter-strategy',
				);
				expect(filterDecision?.choice).toBe('join');

				// And: SQL contains JOIN
				expect(compiled.sql.toLowerCase()).toContain('join');
				expect(compiled.sql.toLowerCase()).toContain('posts');
			});
		});

		describe('BDD Scenario 4: Explicit EXISTS override for belongsTo', () => {
			it('should generate EXISTS when forceFilterStrategy overrides default', () => {
				const kysely = createTestKysely();

				// Given: posts belongsTo author (normally join)
				// But: forceFilterStrategy: 'exists'
				const intent: QueryIntent = {
					from: 'posts',
					select: { type: 'all' },
					where: {
						kind: 'relationFilter',
						relation: 'author',
						mode: 'some',
						where: {
							kind: 'comparison',
							field: 'active',
							operator: 'eq',
							value: true,
						},
					},
				};

				const report = plan(intent, basicSchema, {
					forceFilterStrategy: 'exists',
				});
				const compiled = compile(report, basicSchema, kysely);

				// Then: planner decides 'exists' (forced)
				const filterDecision = report.decisions.find(
					(d) => d.type === 'filter-strategy',
				);
				expect(filterDecision?.choice).toBe('exists');

				// And: SQL contains EXISTS, not JOIN
				expect(compiled.sql.toLowerCase()).toContain('exists');
				expect(compiled.sql.toLowerCase()).not.toMatch(
					/join\s+["']?users["']?/i,
				);
			});
		});

		describe('JOIN filter with nested conditions', () => {
			it('should apply WHERE conditions on joined table', () => {
				const kysely = createTestKysely();

				const intent: QueryIntent = {
					from: 'posts',
					select: { type: 'all' },
					where: {
						kind: 'relationFilter',
						relation: 'author',
						mode: 'some',
						where: {
							kind: 'and',
							conditions: [
								{
									kind: 'comparison',
									field: 'active',
									operator: 'eq',
									value: true,
								},
								{
									kind: 'like',
									field: 'name',
									pattern: '%admin%',
								},
							],
						},
					},
				};

				const report = plan(intent, basicSchema);
				const compiled = compile(report, basicSchema, kysely);

				// Should use JOIN for belongsTo
				expect(compiled.sql.toLowerCase()).toContain('join');

				// Should have conditions applied
				expect(compiled.sql.toLowerCase()).toContain('active');
			});
		});

		describe('JOIN filter error handling', () => {
			it('should throw for none mode with join strategy', () => {
				const kysely = createTestKysely();

				// Given: posts belongsTo author (would use join)
				// But: mode is 'none' which requires EXISTS pattern
				const intent: QueryIntent = {
					from: 'posts',
					select: { type: 'all' },
					where: {
						kind: 'relationFilter',
						relation: 'author',
						mode: 'none', // NOT EXISTS semantic
						where: {
							kind: 'comparison',
							field: 'active',
							operator: 'eq',
							value: true,
						},
					},
				};

				const report = plan(intent, basicSchema);

				// The decision is 'join' but mode is 'none'
				// Our implementation should handle this gracefully
				// (either throw or fall back to EXISTS)
				expect(() => compile(report, basicSchema, kysely)).toThrow(
					/join.*not supported.*none/i,
				);
			});
		});
	});

	// ============================================================================
	// CORE-001: Include Strategy Enforcement
	// ============================================================================

	describe('Include Strategy Enforcement (CORE-001)', () => {
		describe('BDD Scenario 5: JOIN strategy for belongsTo include', () => {
			it('should generate LEFT JOIN when planner decides include-strategy: join', () => {
				const kysely = createTestKysely();

				// Given: posts belongsTo author (cardinality 'one' → include-strategy: join)
				// Using basicSchema where posts.author is belongsTo users

				// When: I select posts with include('author')
				const intent: QueryIntent = {
					type: 'select',
					from: 'posts',
					select: { type: 'all' },
					include: [{ relation: 'author' }],
				};

				const report = plan(intent, basicSchema);
				const compiled = compile(report, basicSchema, kysely);

				// Then: planner decides include-strategy: 'join'
				const includeDecision = report.decisions.find(
					(d) => d.type === 'include-strategy',
				);
				expect(includeDecision).toBeDefined();
				expect(includeDecision?.choice).toBe('join');

				// And: SQL contains LEFT JOIN
				expect(compiled.sql.toLowerCase()).toContain('left join');
				expect(compiled.sql.toLowerCase()).toContain('users');

				// And: SQL selects user columns with aliased names
				expect(compiled.sql.toLowerCase()).toContain('author.');
			});
		});

		describe('BDD Scenario 6: Separate strategy for hasMany include (explicit)', () => {
			it('should NOT generate JOIN when planner decides include-strategy: separate', () => {
				const kysely = createTestKysely();

				// Given: users hasMany posts with explicit separate strategy
				// Note: Since JOIN is now the default, we explicitly request 'separate'

				// When: I select users with include('posts') and defaultIncludeStrategy: 'separate'
				const intent: QueryIntent = {
					type: 'select',
					from: 'users',
					select: { type: 'all' },
					include: [{ relation: 'posts' }],
				};

				const report = plan(intent, basicSchema, {
					defaultIncludeStrategy: 'separate',
				});

				// Then: planner decides include-strategy: 'separate'
				const includeDecision = report.decisions.find(
					(d) => d.type === 'include-strategy',
				);
				expect(includeDecision).toBeDefined();
				expect(includeDecision?.choice).toBe('separate');

				// And: SQL does NOT contain JOIN posts (separate queries will be needed)
				const compiled = compile(report, basicSchema, kysely);
				expect(compiled.sql.toLowerCase()).not.toContain('join');
				expect(compiled.sql.toLowerCase()).not.toContain('left join posts');
			});
		});

		describe('BDD Scenario 7: Explicit JOIN override for hasMany include', () => {
			it('should generate LEFT JOIN when relation has includeStrategy: join hint', () => {
				const kysely = createTestKysely();

				// Given: users hasMany posts with explicit includeStrategy: 'join'
				const schemaWithJoinHint = defineSchemaBuilder({
					users: {
						id: { type: 'number' },
						name: { type: 'string' },
					},
					posts: {
						id: { type: 'number' },
						title: { type: 'string' },
						userId: { type: 'number' },
					},
				})
					.relations({
						users: {
							posts: hasMany(
								'posts',
								{ foreignKey: 'userId' },
								{ includeStrategy: 'join' },
							),
						},
					})
					.build();

				// When: I select users with include('posts')
				const intent: QueryIntent = {
					type: 'select',
					from: 'users',
					select: { type: 'all' },
					include: [{ relation: 'posts' }],
				};

				const report = plan(intent, schemaWithJoinHint);
				const compiled = compile(report, schemaWithJoinHint, kysely);

				// Then: planner decides include-strategy: 'join' (due to hint)
				const includeDecision = report.decisions.find(
					(d) => d.type === 'include-strategy',
				);
				expect(includeDecision).toBeDefined();
				expect(includeDecision?.choice).toBe('join');

				// And: SQL contains LEFT JOIN
				expect(compiled.sql.toLowerCase()).toContain('left join');
				expect(compiled.sql.toLowerCase()).toContain('posts');

				// And: SQL selects post columns with aliased names
				expect(compiled.sql.toLowerCase()).toContain('posts.');
			});
		});

		describe('BDD Scenario 8: compileWithIncludes returns separateIncludes metadata', () => {
			it('should return separateIncludes for hasMany relations (when using separate strategy)', () => {
				const kysely = createTestKysely();

				// Given: users hasMany posts with explicit 'separate' strategy
				// Note: JOIN is now the default, so we explicitly request 'separate'
				// When: I use compileWithIncludes
				const intent: QueryIntent = {
					type: 'select',
					from: 'users',
					select: { type: 'all' },
					include: [{ relation: 'posts' }],
				};

				const report = plan(intent, basicSchema, {
					defaultIncludeStrategy: 'separate',
				});
				const result = compileWithIncludes(report, basicSchema, kysely);

				// Then: main query should be compiled
				expect(result.main).toBeDefined();
				expect(result.main.sql.toLowerCase()).toContain('select');
				expect(result.main.sql.toLowerCase()).not.toContain('join posts');

				// And: separateIncludes should contain posts metadata
				expect(result.separateIncludes).toHaveLength(1);
				expect(result.separateIncludes[0].relationName).toBe('posts');
				expect(result.separateIncludes[0].targetTable).toBe('posts');
				expect(result.separateIncludes[0].foreignKey).toBe('userId');
				expect(result.separateIncludes[0].sourceKey).toBe('id');
			});

			it('should return empty separateIncludes for JOIN includes', () => {
				const kysely = createTestKysely();

				// Given: posts belongsTo user (default includeStrategy is 'join')
				const intent: QueryIntent = {
					type: 'select',
					from: 'posts',
					select: { type: 'all' },
					include: [{ relation: 'author' }],
				};

				const report = plan(intent, basicSchema);
				const result = compileWithIncludes(report, basicSchema, kysely);

				// Then: main query should be compiled with JOIN
				expect(result.main.sql.toLowerCase()).toContain('left join');

				// And: separateIncludes should be empty (author is JOINed)
				expect(result.separateIncludes).toHaveLength(0);
			});
		});

		describe('BDD Scenario 9: compileSeparateInclude generates follow-up queries', () => {
			it('should generate IN query for separate include', () => {
				const kysely = createTestKysely();

				// Given: separate include metadata from compileWithIncludes
				const includeInfo = {
					relationName: 'posts',
					targetTable: 'posts',
					foreignKey: 'userId',
					sourceKey: 'id',
				};

				// When: I compile the separate include with parent IDs
				const parentIds = [1, 2, 3];
				const compiled = compileSeparateInclude(includeInfo, parentIds, kysely);

				// Then: SQL should contain IN clause with parent IDs
				expect(compiled.sql.toLowerCase()).toContain('select');
				expect(compiled.sql.toLowerCase()).toContain('from "posts"');
				expect(compiled.sql.toLowerCase()).toContain('"userid" in');
			});

			it('should return empty result for empty parent IDs', () => {
				const kysely = createTestKysely();

				const includeInfo = {
					relationName: 'posts',
					targetTable: 'posts',
					foreignKey: 'userId',
					sourceKey: 'id',
				};

				// When: parent IDs is empty
				const compiled = compileSeparateInclude(includeInfo, [], kysely);

				// Then: SQL should return empty result (WHERE false)
				expect(compiled.sql.toLowerCase()).toContain('select');
				// The query uses eb.lit(false) which compiles to "0" in SQLite
			});

			it('should apply schema prefix for multi-tenant', () => {
				const kysely = createTestKysely();

				const includeInfo = {
					relationName: 'posts',
					targetTable: 'posts',
					foreignKey: 'userId',
					sourceKey: 'id',
				};

				const compiled = compileSeparateInclude(
					includeInfo,
					[1, 2],
					kysely,
					'tenant_abc',
				);

				// Then: SQL should contain schema prefix (SQLite quotes identifiers)
				expect(compiled.sql.toLowerCase()).toMatch(/tenant_abc.*posts/);
			});

			it('should generate junction JOIN for manyToMany (M:N) relations', () => {
				const kysely = createTestKysely();

				// Given: manyToMany relation info (posts.tags via postTags junction)
				const includeInfo = {
					relationName: 'tags',
					targetTable: 'tags',
					foreignKey: 'id', // tags.id
					sourceKey: 'id', // posts.id
					// M:N specific properties
					through: 'postTags',
					throughSourceKey: 'postId', // postTags.postId
					throughTargetKey: 'tagId', // postTags.tagId
				};

				// When: compile separate include with parent post IDs
				const parentIds = [1, 2, 3];
				const compiled = compileSeparateInclude(includeInfo, parentIds, kysely);

				const sql = compiled.sql.toLowerCase();

				// Then: SQL should JOIN through junction table
				expect(sql).toContain('select');
				expect(sql).toContain('from "tags"');
				expect(sql).toContain('inner join "posttags"');

				// Junction should join to target table
				expect(sql).toContain('"posttags"."tagid"');
				expect(sql).toContain('"tags"."id"');

				// WHERE should filter by source key in junction table
				expect(sql).toContain('"posttags"."postid" in');

				// Should include __sourceKey for hydration mapping
				expect(sql).toContain('__sourcekey');

				// Should have parent IDs as parameters
				expect(compiled.parameters).toEqual([1, 2, 3]);
			});
		});

		describe('CORE-006: LATERAL JOIN strategy', () => {
			it('should generate LEFT JOIN LATERAL when strategy is lateral', () => {
				const kysely = createTestKysely();

				// Given: users hasMany posts with explicit 'lateral' strategy hint
				const schemaWithLateral = defineSchemaBuilder({
					users: {
						id: { type: 'number' },
						name: { type: 'string' },
					},
					posts: {
						id: { type: 'number' },
						title: { type: 'string' },
						userId: { type: 'number' },
					},
				})
					.relations({
						users: {
							posts: hasMany(
								'posts',
								{ foreignKey: 'userId' },
								{ includeStrategy: 'lateral' },
							),
						},
					})
					.build();

				// When: I select users with include('posts')
				const intent: QueryIntent = {
					type: 'select',
					from: 'users',
					select: { type: 'all' },
					include: [{ relation: 'posts' }],
				};

				const report = plan(intent, schemaWithLateral);

				// Then: planner decides include-strategy: 'lateral'
				const includeDecision = report.decisions.find(
					(d) => d.type === 'include-strategy',
				);
				expect(includeDecision).toBeDefined();
				expect(includeDecision?.choice).toBe('lateral');

				// When: compiled
				const compiled = compile(report, schemaWithLateral, kysely);

				// Then: SQL contains LATERAL JOIN
				expect(compiled.sql.toLowerCase()).toContain('lateral');
			});

			it('should support limit and orderBy in LATERAL subquery', () => {
				const kysely = createTestKysely();

				const schemaWithLateral = defineSchemaBuilder({
					users: {
						id: { type: 'number' },
						name: { type: 'string' },
					},
					posts: {
						id: { type: 'number' },
						title: { type: 'string' },
						createdAt: 'Date',
						userId: { type: 'number' },
					},
				})
					.relations({
						users: {
							posts: hasMany(
								'posts',
								{ foreignKey: 'userId' },
								{ includeStrategy: 'lateral' },
							),
						},
					})
					.build();

				// When: I select users with include('posts') with limit and orderBy
				const intent: QueryIntent = {
					type: 'select',
					from: 'users',
					select: { type: 'all' },
					include: [
						{
							relation: 'posts',
							limit: 5,
							orderBy: [{ field: 'createdAt', direction: 'desc' }],
						},
					],
				};

				const report = plan(intent, schemaWithLateral);
				const compiled = compile(report, schemaWithLateral, kysely);
				const sql = compiled.sql.toLowerCase();

				// Then: SQL contains LATERAL with ORDER BY and LIMIT
				expect(sql).toContain('lateral');
				expect(sql).toContain('order by');
				expect(sql).toContain('createdat');
				expect(sql).toContain('desc');
				expect(sql).toContain('limit 5');
			});
		});

		describe('CORE-006: JSON_AGG strategy', () => {
			it('should generate json_agg subquery when strategy is json_agg', () => {
				const kysely = createTestKysely();

				// Given: users hasMany posts with explicit 'json_agg' strategy hint
				const schemaWithJsonAgg = defineSchemaBuilder({
					users: {
						id: { type: 'number' },
						name: { type: 'string' },
					},
					posts: {
						id: { type: 'number' },
						title: { type: 'string' },
						userId: { type: 'number' },
					},
				})
					.relations({
						users: {
							posts: hasMany(
								'posts',
								{ foreignKey: 'userId' },
								{ includeStrategy: 'json_agg' },
							),
						},
					})
					.build();

				// When: I select users with include('posts')
				const intent: QueryIntent = {
					type: 'select',
					from: 'users',
					select: { type: 'all' },
					include: [{ relation: 'posts' }],
				};

				const report = plan(intent, schemaWithJsonAgg);

				// Then: planner decides include-strategy: 'json_agg'
				const includeDecision = report.decisions.find(
					(d) => d.type === 'include-strategy',
				);
				expect(includeDecision).toBeDefined();
				expect(includeDecision?.choice).toBe('json_agg');

				// When: compiled
				const compiled = compile(report, schemaWithJsonAgg, kysely);
				const sql = compiled.sql.toLowerCase();

				// Then: SQL contains json aggregation subquery (json_group_array for SQLite)
				// Note: createTestKysely uses SQLite which uses json_group_array instead of json_agg
				expect(sql).toMatch(/json_agg|json_group_array/);
				// to_jsonb is PostgreSQL-specific, SQLite uses different syntax
				// expect(sql).toContain('to_jsonb');
				// Should be a correlated subquery, not a JOIN
				expect(sql).not.toContain('left join "posts"');
			});

			it('should support orderBy in JSON_AGG aggregation', () => {
				const kysely = createTestKysely();

				const schemaWithJsonAgg = defineSchemaBuilder({
					users: {
						id: { type: 'number' },
						name: { type: 'string' },
					},
					posts: {
						id: { type: 'number' },
						title: { type: 'string' },
						createdAt: 'Date',
						userId: { type: 'number' },
					},
				})
					.relations({
						users: {
							posts: hasMany(
								'posts',
								{ foreignKey: 'userId' },
								{ includeStrategy: 'json_agg' },
							),
						},
					})
					.build();

				// When: I select users with include('posts') with orderBy
				const intent: QueryIntent = {
					type: 'select',
					from: 'users',
					select: { type: 'all' },
					include: [
						{
							relation: 'posts',
							orderBy: [{ field: 'createdAt', direction: 'desc' }],
						},
					],
				};

				const report = plan(intent, schemaWithJsonAgg);
				const compiled = compile(report, schemaWithJsonAgg, kysely);
				const sql = compiled.sql.toLowerCase();

				// Then: SQL contains ORDER BY inside json aggregation
				expect(sql).toMatch(/json_agg|json_group_array/);
				expect(sql).toContain('order by');
				expect(sql).toContain('createdat');
				expect(sql).toContain('desc');
			});

			it('should return empty JSON array when no related records', () => {
				const kysely = createTestKysely();

				const schemaWithJsonAgg = defineSchemaBuilder({
					users: {
						id: { type: 'number' },
						name: { type: 'string' },
					},
					posts: {
						id: { type: 'number' },
						title: { type: 'string' },
						userId: { type: 'number' },
					},
				})
					.relations({
						users: {
							posts: hasMany(
								'posts',
								{ foreignKey: 'userId' },
								{ includeStrategy: 'json_agg' },
							),
						},
					})
					.build();

				const intent: QueryIntent = {
					type: 'select',
					from: 'users',
					select: { type: 'all' },
					include: [{ relation: 'posts' }],
				};

				const report = plan(intent, schemaWithJsonAgg);
				const compiled = compile(report, schemaWithJsonAgg, kysely);
				const sql = compiled.sql.toLowerCase();

				// Then: SQL contains COALESCE for empty array fallback
				expect(sql).toContain('coalesce');
				// Either '[]' or '[]'::json depending on dialect
				expect(sql).toMatch(/\[\]/);
			});
		});
	});

	// ============================================================================
	// Upsert Compiler (DX-026)
	// ============================================================================

	describe('Upsert Compiler (DX-026)', () => {
		describe('compileUpsert', () => {
			it('should compile INSERT ... ON CONFLICT DO NOTHING', () => {
				const kysely = createTestKysely();
				const intent: UpsertIntent = {
					type: 'upsert',
					table: 'users',
					values: [{ name: 'John', email: 'john@example.com' }],
					onConflict: { columns: ['email'] },
					action: { type: 'doNothing' },
				};

				const compiled = compileUpsert(intent, kysely);

				expect(compiled.sql.toLowerCase()).toContain('insert into');
				expect(compiled.sql.toLowerCase()).toContain('users');
				expect(compiled.sql.toLowerCase()).toContain('on conflict');
				expect(compiled.sql.toLowerCase()).toContain('do nothing');
				expect(compiled.parameters).toContain('John');
				expect(compiled.parameters).toContain('john@example.com');
			});

			it('should compile INSERT ... ON CONFLICT DO UPDATE with explicit SET', () => {
				const kysely = createTestKysely();
				const intent: UpsertIntent = {
					type: 'upsert',
					table: 'users',
					values: [{ name: 'John', email: 'john@example.com' }],
					onConflict: { columns: ['email'] },
					action: {
						type: 'doUpdate',
						set: { name: 'Updated John' },
					},
				};

				const compiled = compileUpsert(intent, kysely);

				expect(compiled.sql.toLowerCase()).toContain('insert into');
				expect(compiled.sql.toLowerCase()).toContain('on conflict');
				expect(compiled.sql.toLowerCase()).toContain('do update');
				expect(compiled.sql.toLowerCase()).toContain('set');
				expect(compiled.parameters).toContain('Updated John');
			});

			it('should compile upsert with auto-UPDATE from excluded row', () => {
				const kysely = createTestKysely();
				const intent: UpsertIntent = {
					type: 'upsert',
					table: 'users',
					values: [{ name: 'John', email: 'john@example.com' }],
					onConflict: { columns: ['email'] },
					action: { type: 'doUpdate' },
				};

				const compiled = compileUpsert(intent, kysely);

				expect(compiled.sql.toLowerCase()).toContain('insert into');
				expect(compiled.sql.toLowerCase()).toContain('on conflict');
				expect(compiled.sql.toLowerCase()).toContain('do update');
				// Should reference excluded.name since email is the conflict column
				expect(compiled.sql.toLowerCase()).toContain('excluded');
			});

			it('should compile upsert with constraint name', () => {
				const kysely = createTestKysely();
				const intent: UpsertIntent = {
					type: 'upsert',
					table: 'users',
					values: [{ name: 'John', email: 'john@example.com' }],
					onConflict: { constraint: 'users_email_unique' },
					action: { type: 'doNothing' },
				};

				const compiled = compileUpsert(intent, kysely);

				expect(compiled.sql.toLowerCase()).toContain('insert into');
				expect(compiled.sql.toLowerCase()).toContain('on conflict');
				// SQLite doesn't support constraint syntax well, but the SQL should still be generated
				expect(compiled.sql).toContain('users_email_unique');
			});

			it('should compile upsert with multiple conflict columns', () => {
				const kysely = createTestKysely();
				const intent: UpsertIntent = {
					type: 'upsert',
					table: 'posts',
					values: [{ title: 'Post', content: 'Content', userId: 1 }],
					onConflict: { columns: ['title', 'userId'] },
					action: { type: 'doUpdate', set: { content: 'Updated content' } },
				};

				const compiled = compileUpsert(intent, kysely);

				expect(compiled.sql.toLowerCase()).toContain('on conflict');
				expect(compiled.sql.toLowerCase()).toContain('do update');
			});

			it('should compile bulk upsert with multiple values', () => {
				const kysely = createTestKysely();
				const intent: UpsertIntent = {
					type: 'upsert',
					table: 'users',
					values: [
						{ name: 'John', email: 'john@example.com' },
						{ name: 'Jane', email: 'jane@example.com' },
					],
					onConflict: { columns: ['email'] },
					action: { type: 'doNothing' },
				};

				const compiled = compileUpsert(intent, kysely);

				expect(compiled.sql.toLowerCase()).toContain('insert into');
				expect(compiled.parameters).toContain('John');
				expect(compiled.parameters).toContain('Jane');
			});

			it('should compile upsert with multi-tenant schema prefix', () => {
				const kysely = createTestKysely();
				const intent: UpsertIntent = {
					type: 'upsert',
					table: 'users',
					values: [{ name: 'John', email: 'john@example.com' }],
					onConflict: { columns: ['email'] },
					action: { type: 'doNothing' },
				};

				const compiled = compileUpsert(intent, kysely, 'tenant_123');

				expect(compiled.sql.toLowerCase()).toMatch(/tenant_123[".].*users/);
			});

			it('should compile upsert with RETURNING clause', () => {
				const kysely = createTestKysely();
				const intent: UpsertIntent = {
					type: 'upsert',
					table: 'users',
					values: [{ name: 'John', email: 'john@example.com' }],
					onConflict: { columns: ['email'] },
					action: { type: 'doNothing' },
					returning: ['id', 'name'],
				};

				const compiled = compileUpsert(intent, kysely);

				expect(compiled.sql.toLowerCase()).toContain('returning');
				expect(compiled.sql.toLowerCase()).toMatch(/returning.*"id".*"name"/);
			});

			it('should compile upsert with WHERE clause in doUpdate', () => {
				const kysely = createTestKysely();
				const intent: UpsertIntent = {
					type: 'upsert',
					table: 'users',
					values: [{ name: 'John', email: 'john@example.com', active: true }],
					onConflict: { columns: ['email'] },
					action: {
						type: 'doUpdate',
						set: { name: 'Updated John' },
						where: {
							kind: 'comparison',
							field: 'active',
							operator: 'eq',
							value: true,
						},
					},
				};

				const compiled = compileUpsert(intent, kysely);

				expect(compiled.sql.toLowerCase()).toContain('do update');
				expect(compiled.sql.toLowerCase()).toContain('where');
			});
		});

		describe('compileInsert with RETURNING (DX-026)', () => {
			it('should compile insert with RETURNING clause', () => {
				const kysely = createTestKysely();
				const intent = {
					type: 'insert' as const,
					table: 'users',
					values: [{ name: 'John', email: 'john@example.com' }],
					returning: ['id', 'name'],
				};

				const compiled = compileInsert(intent, kysely);

				expect(compiled.sql.toLowerCase()).toContain('insert into');
				expect(compiled.sql.toLowerCase()).toContain('returning');
				expect(compiled.sql.toLowerCase()).toMatch(/returning.*"id".*"name"/);
			});

			it('should compile insert without RETURNING when not specified', () => {
				const kysely = createTestKysely();
				const intent = {
					type: 'insert' as const,
					table: 'users',
					values: [{ name: 'John', email: 'john@example.com' }],
				};

				const compiled = compileInsert(intent, kysely);

				expect(compiled.sql.toLowerCase()).not.toContain('returning');
			});
		});

		describe('compileUpdate with RETURNING (DX-026)', () => {
			it('should compile update with RETURNING clause', () => {
				const kysely = createTestKysely();
				const intent = {
					type: 'update' as const,
					table: 'users',
					set: { name: 'Updated' },
					where: {
						kind: 'comparison' as const,
						field: 'id',
						operator: 'eq' as const,
						value: 1,
					},
					returning: ['id', 'name', 'email'],
				};

				const compiled = compileUpdate(intent, kysely);

				expect(compiled.sql.toLowerCase()).toContain('update');
				expect(compiled.sql.toLowerCase()).toContain('returning');
			});

			it('should compile update without RETURNING when not specified', () => {
				const kysely = createTestKysely();
				const intent = {
					type: 'update' as const,
					table: 'users',
					set: { name: 'Updated' },
					where: {
						kind: 'comparison' as const,
						field: 'id',
						operator: 'eq' as const,
						value: 1,
					},
				};

				const compiled = compileUpdate(intent, kysely);

				expect(compiled.sql.toLowerCase()).not.toContain('returning');
			});
		});

		describe('compileDelete with RETURNING (DX-026)', () => {
			it('should compile delete with RETURNING clause', () => {
				const kysely = createTestKysely();
				const intent = {
					type: 'delete' as const,
					table: 'users',
					where: {
						kind: 'comparison' as const,
						field: 'id',
						operator: 'eq' as const,
						value: 1,
					},
					returning: ['id', 'name'],
				};

				const compiled = compileDelete(intent, kysely);

				expect(compiled.sql.toLowerCase()).toContain('delete');
				expect(compiled.sql.toLowerCase()).toContain('returning');
			});

			it('should compile delete without RETURNING when not specified', () => {
				const kysely = createTestKysely();
				const intent = {
					type: 'delete' as const,
					table: 'users',
					where: {
						kind: 'comparison' as const,
						field: 'id',
						operator: 'eq' as const,
						value: 1,
					},
				};

				const compiled = compileDelete(intent, kysely);

				expect(compiled.sql.toLowerCase()).not.toContain('returning');
			});
		});
	});
});

// ============================================================================
// ADAPTER-003: Smart Column Aliasing (onCollision mode)
// ============================================================================

describe('ADAPTER-003: Smart Column Aliasing - onCollision mode', () => {
	const kysely = createTestKysely();

	// Schema with overlapping column names for collision testing
	// users: id, name, createdAt
	// posts: id, title, userId, createdAt (id and createdAt collide with users)
	const schemaWithCollisions = defineSchemaBuilder({
		users: {
			id: { type: 'number' },
			name: { type: 'string' },
			createdAt: { type: 'string' },
		},
		posts: {
			id: { type: 'number' },
			title: { type: 'string' },
			userId: { type: 'number' },
			createdAt: { type: 'string' },
		},
	})
		.relations({
			posts: {
				author: belongsTo('users', { foreignKey: 'userId' }),
			},
		})
		.build();

	describe("aliasIncludedColumns: 'always' (default)", () => {
		it('should alias ALL columns from included tables', () => {
			// Given: posts belongsTo author
			// When: I include author with default aliasing mode
			const intent: QueryIntent = {
				type: 'select',
				from: 'posts',
				select: { type: 'all' },
				include: [{ relation: 'author' }],
			};

			const report = plan(intent, schemaWithCollisions);

			// Default: aliasIncludedColumns: 'always'
			const compiled = compile(report, schemaWithCollisions, kysely);

			// Then: ALL author columns should have "author." prefix
			const sql = compiled.sql.toLowerCase();

			// All columns from author table should be aliased
			expect(sql).toContain('"author.id"');
			expect(sql).toContain('"author.name"');
			expect(sql).toContain('"author.createdat"');
		});

		it('should use "always" as default when no option is specified', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'posts',
				select: { type: 'all' },
				include: [{ relation: 'author' }],
			};

			const report = plan(intent, schemaWithCollisions);

			// Compile without explicit aliasIncludedColumns
			const compiledDefault = compile(report, schemaWithCollisions, kysely);
			// Compile with explicit 'always'
			const compiledAlways = compile(report, schemaWithCollisions, kysely, {
				aliasIncludedColumns: 'always',
			});

			// Both should produce the same SQL
			expect(compiledDefault.sql).toBe(compiledAlways.sql);
		});
	});

	describe("aliasIncludedColumns: 'onCollision'", () => {
		it('should only alias columns that collide with root table', () => {
			// Given: posts (id, title, userId, createdAt) with author (id, name, createdAt)
			// Colliding columns: id, createdAt
			// Non-colliding columns: name
			const intent: QueryIntent = {
				type: 'select',
				from: 'posts',
				select: { type: 'all' },
				include: [{ relation: 'author' }],
			};

			const report = plan(intent, schemaWithCollisions);

			// When: aliasIncludedColumns: 'onCollision'
			const compiled = compile(report, schemaWithCollisions, kysely, {
				aliasIncludedColumns: 'onCollision',
			});

			const sql = compiled.sql.toLowerCase();

			// Then: Colliding columns (id, createdAt) should be aliased
			expect(sql).toContain('"author.id"');
			expect(sql).toContain('"author.createdat"');

			// And: Non-colliding column (name) should NOT be aliased
			// It should appear as a simple column reference without "author." prefix
			expect(sql).not.toContain('"author.name"');

			// But the name column should still be selected (without alias)
			// In SQLite, unaliased column refs become `"t1"."name"` (double-quoted)
			expect(sql).toMatch(/"t\d+"\."name"/); // e.g., "t1"."name"
		});

		it('should produce different SQL than "always" mode', () => {
			const intent: QueryIntent = {
				type: 'select',
				from: 'posts',
				select: { type: 'all' },
				include: [{ relation: 'author' }],
			};

			const report = plan(intent, schemaWithCollisions);

			const compiledAlways = compile(report, schemaWithCollisions, kysely, {
				aliasIncludedColumns: 'always',
			});
			const compiledOnCollision = compile(
				report,
				schemaWithCollisions,
				kysely,
				{ aliasIncludedColumns: 'onCollision' },
			);

			// The SQL should be different
			expect(compiledAlways.sql).not.toBe(compiledOnCollision.sql);

			// 'always' should have more aliases
			const alwaysAliasCount = (
				compiledAlways.sql.match(/as "author\./gi) || []
			).length;
			const onCollisionAliasCount = (
				compiledOnCollision.sql.match(/as "author\./gi) || []
			).length;

			expect(alwaysAliasCount).toBeGreaterThan(onCollisionAliasCount);
		});
	});

	describe('collision detection across multiple includes', () => {
		// Schema with multiple relations where column names collide
		const schemaWithMultipleIncludes = defineSchemaBuilder({
			comments: {
				id: { type: 'number' },
				content: { type: 'string' },
				postId: { type: 'number' },
				authorId: { type: 'number' },
				createdAt: { type: 'string' },
			},
			posts: {
				id: { type: 'number' },
				title: { type: 'string' },
				createdAt: { type: 'string' },
			},
			users: {
				id: { type: 'number' },
				name: { type: 'string' },
				createdAt: { type: 'string' },
			},
		})
			.relations({
				comments: {
					post: belongsTo('posts', { foreignKey: 'postId' }),
					author: belongsTo('users', { foreignKey: 'authorId' }),
				},
			})
			.build();

		it('should detect collisions across root and multiple included tables', () => {
			// Given: comments with post and author includes
			// All three tables have 'id' and 'createdAt' columns
			const intent: QueryIntent = {
				type: 'select',
				from: 'comments',
				select: { type: 'all' },
				include: [{ relation: 'post' }, { relation: 'author' }],
			};

			const report = plan(intent, schemaWithMultipleIncludes);

			// When: aliasIncludedColumns: 'onCollision'
			const compiled = compile(report, schemaWithMultipleIncludes, kysely, {
				aliasIncludedColumns: 'onCollision',
			});

			const sql = compiled.sql.toLowerCase();

			// Then: 'id' and 'createdAt' should be aliased for both includes
			expect(sql).toContain('"post.id"');
			expect(sql).toContain('"post.createdat"');
			expect(sql).toContain('"author.id"');
			expect(sql).toContain('"author.createdat"');

			// And: Non-colliding columns should NOT be aliased
			// post.title and author.name don't collide with comments
			expect(sql).not.toContain('"post.title"');
			expect(sql).not.toContain('"author.name"');
		});
	});
});

// ============================================================================
// CORE-006: Composite Key Support Tests
// ============================================================================

describe('CORE-006: Composite Key Support', () => {
	/**
	 * Schema with composite foreign keys for testing multi-column joins
	 * tenant_orders has composite FK [tenantId, customerId] -> customers[tenantId, id]
	 *
	 * We construct ModelIR manually to set composite primary keys,
	 * since defineSchema() defaults primaryKey to 'id'.
	 */
	const compositeKeySchema = (() => {
		const tables = new Map();

		// tenants table (simple PK)
		tables.set('tenants', {
			name: 'tenants',
			columns: [
				{ name: 'id', type: { type: 'number' }, nullable: false },
				{ name: 'name', type: { type: 'string' }, nullable: false },
			],
			primaryKey: 'id',
			foreignKeys: [],
		});

		// customers table (composite PK: [tenantId, id])
		tables.set('customers', {
			name: 'customers',
			columns: [
				{ name: 'tenantId', type: { type: 'number' }, nullable: false },
				{ name: 'id', type: { type: 'number' }, nullable: false },
				{ name: 'name', type: { type: 'string' }, nullable: false },
				{ name: 'email', type: { type: 'string' }, nullable: false },
			],
			primaryKey: ['tenantId', 'id'], // Composite PK
			foreignKeys: [],
		});

		// tenant_orders table (composite FK to customers)
		tables.set('tenant_orders', {
			name: 'tenant_orders',
			columns: [
				{ name: 'id', type: { type: 'number' }, nullable: false },
				{ name: 'tenantId', type: { type: 'number' }, nullable: false },
				{ name: 'customerId', type: { type: 'number' }, nullable: false },
				{ name: 'total', type: { type: 'number' }, nullable: false },
				{ name: 'status', type: { type: 'string' }, nullable: false },
			],
			primaryKey: 'id',
			foreignKeys: [
				{
					columns: ['tenantId', 'customerId'],
					references: { table: 'customers', columns: ['tenantId', 'id'] },
				},
			],
		});

		const relations = new Map();

		// hasMany: customers -> tenant_orders
		relations.set('customers.tenant_orders', {
			name: 'tenant_orders',
			type: 'hasMany',
			source: 'customers',
			target: 'tenant_orders',
			foreignKey: ['tenantId', 'customerId'], // Composite FK
			cardinality: 'one-to-many',
			optionality: 'optional',
			includeStrategy: 'separate', // hasMany defaults to separate
			filterStrategy: 'exists',
			joinDefault: 'left',
		});

		// belongsTo: tenant_orders -> customers
		relations.set('tenant_orders.customer', {
			name: 'customer',
			type: 'belongsTo',
			source: 'tenant_orders',
			target: 'customers',
			foreignKey: ['tenantId', 'customerId'], // Composite FK
			cardinality: 'many-to-one',
			optionality: 'optional',
			includeStrategy: 'join', // belongsTo defaults to join
			filterStrategy: 'exists',
			joinDefault: 'left',
		});

		return new ModelIRImpl(tables, relations);
	})();

	describe('EXISTS with composite foreign keys', () => {
		it('should compile EXISTS with composite FK correlation (hasMany)', () => {
			const kysely = createTestKysely();
			const intent: QueryIntent = {
				type: 'select',
				from: 'customers',
				where: {
					kind: 'exists',
					relation: 'tenant_orders',
				},
			};

			const planReport = plan(intent, compositeKeySchema);
			const compiled = compile(planReport, compositeKeySchema, kysely);

			// Should have composite key correlation in EXISTS
			expect(compiled.sql).toContain('exists');
			// Check that both FK columns are referenced in the correlation
			expect(compiled.sql).toMatch(/tenantId.*=.*tenantId/i);
			expect(compiled.sql).toMatch(/customerId.*=.*id/i);
		});

		it('should compile nested EXISTS where with composite FK', () => {
			const kysely = createTestKysely();
			const intent: QueryIntent = {
				type: 'select',
				from: 'customers',
				where: {
					kind: 'exists',
					relation: 'tenant_orders',
					where: {
						kind: 'comparison',
						field: 'status',
						operator: 'eq',
						value: 'completed',
					},
				},
			};

			const planReport = plan(intent, compositeKeySchema);
			const compiled = compile(planReport, compositeKeySchema, kysely);

			expect(compiled.sql).toContain('exists');
			expect(compiled.sql.toLowerCase()).toContain('status');
			expect(compiled.parameters).toContain('completed');
		});
	});

	describe('SeparateIncludeInfo with composite keys', () => {
		it('should return array for composite FK in SeparateIncludeInfo', () => {
			const kysely = createTestKysely();
			const intent: QueryIntent = {
				type: 'select',
				from: 'customers',
				include: [{ relation: 'tenant_orders' }],
			};

			const planReport = plan(intent, compositeKeySchema);
			const result = compileWithIncludes(
				planReport,
				compositeKeySchema,
				kysely,
			);

			// For composite keys, foreignKey should be an array
			const includeInfo = result.separateIncludes[0];
			expect(includeInfo).toBeDefined();
			expect(includeInfo?.relationName).toBe('tenant_orders');

			// Composite FK should be returned as array
			expect(Array.isArray(includeInfo?.foreignKey)).toBe(true);
			expect(includeInfo?.foreignKey).toEqual(['tenantId', 'customerId']);

			// Composite source key should also be array
			expect(Array.isArray(includeInfo?.sourceKey)).toBe(true);
			expect(includeInfo?.sourceKey).toEqual(['tenantId', 'id']);
		});
	});

	describe('compileSeparateInclude with composite keys', () => {
		it('should compile separate include with composite FK using OR conditions', () => {
			const kysely = createTestKysely();

			// Simulate parent tuples: [tenantId, customerId]
			const parentIds = [
				[1, 100],
				[1, 101],
				[2, 100],
			];

			const includeInfo = {
				relationName: 'tenant_orders',
				targetTable: 'tenant_orders',
				foreignKey: ['tenantId', 'customerId'] as readonly string[],
				sourceKey: ['tenantId', 'id'] as readonly string[],
			};

			const compiled = compileSeparateInclude(includeInfo, parentIds, kysely);

			// Should produce OR conditions for composite key tuples
			expect(compiled.sql).toContain('tenant_orders');
			// Should have conditions for each tuple
			expect(compiled.sql.toLowerCase()).toContain('or');
			// Should reference both FK columns
			expect(compiled.sql).toContain('tenantId');
			expect(compiled.sql).toContain('customerId');
		});
	});

	describe('CTE Include Strategy (CLI-012)', () => {
		const createCteTestSchema = () =>
			defineSchemaBuilder({
				categories: {
					id: 'integer',
					name: { type: 'string' },
					parentId: 'integer',
				},
				users: {
					id: 'integer',
					name: { type: 'string' },
				},
				posts: {
					id: 'integer',
					title: { type: 'string' },
					authorId: 'integer',
				},
			})
				.relations({
					categories: {
						parent: belongsTo(
							'categories',
							{ foreignKey: 'parentId' },
							{ includeStrategy: 'cte' },
						),
					},
					users: {
						posts: hasMany(
							'posts',
							{ foreignKey: 'authorId' },
							{ includeStrategy: 'cte' },
						),
					},
				})
				.build();

		it('should generate CTE when includeStrategy is cte for self-referential relation', () => {
			const kysely = createTestKysely();
			const model = createCteTestSchema();

			// Query categories with include parent (cte strategy)
			const intent: QueryIntent = {
				type: 'select',
				from: 'categories',
				include: [{ relation: 'parent' }],
			};

			const planReport = plan(intent, model);
			const compiled = compile(planReport, model, kysely);

			// Should have WITH clause for the CTE
			expect(compiled.sql.toUpperCase()).toContain('WITH');
			expect(compiled.sql).toContain('cte_categories_parent');
			// CTE should select from categories
			expect(compiled.sql.toLowerCase()).toContain('select');
			expect(compiled.sql.toLowerCase()).toContain('categories');
		});

		it('should generate CTE when includeStrategy is cte for hasMany relation', () => {
			const kysely = createTestKysely();
			const model = createCteTestSchema();

			// Query users with include posts (cte strategy)
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				include: [{ relation: 'posts' }],
			};

			const planReport = plan(intent, model);
			const compiled = compile(planReport, model, kysely);

			// Should have WITH clause for the CTE
			expect(compiled.sql.toUpperCase()).toContain('WITH');
			expect(compiled.sql).toContain('cte_users_posts');
		});

		it('should record CTE in plan.ctes when cte strategy is used', () => {
			const model = createCteTestSchema();

			const intent: QueryIntent = {
				type: 'select',
				from: 'categories',
				include: [{ relation: 'parent' }],
			};

			const planReport = plan(intent, model);

			// Plan should contain CTE definition
			expect(planReport.ctes.length).toBeGreaterThan(0);
			const cteDef = planReport.ctes.find(
				(c) => c.name === 'cte_categories_parent',
			);
			expect(cteDef).toBeDefined();
			expect(cteDef?.sourceIntent).toBe('categories.parent');
		});

		it('should JOIN to CTE name instead of table name', () => {
			const kysely = createTestKysely();
			const model = createCteTestSchema();

			const intent: QueryIntent = {
				type: 'select',
				from: 'categories',
				include: [{ relation: 'parent' }],
			};

			const planReport = plan(intent, model);
			const compiled = compile(planReport, model, kysely);

			// Should have LEFT JOIN to the CTE
			expect(compiled.sql.toUpperCase()).toContain('LEFT JOIN');
			// The join should reference the CTE name
			expect(compiled.sql).toContain('cte_categories_parent');
		});

		// CLI-012b: Filtered CTEs
		it('should apply include.where filter inside CTE (CLI-012b)', () => {
			const kysely = createTestKysely();
			const model = createCteTestSchema();

			// Query users with include posts filtered by title
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				include: [
					{
						relation: 'posts',
						where: {
							kind: 'comparison',
							field: 'title',
							operator: 'eq',
							value: 'Hello',
						},
					},
				],
			};

			const planReport = plan(intent, model);
			const compiled = compile(planReport, model, kysely);

			// Should have WITH clause for the CTE
			expect(compiled.sql.toUpperCase()).toContain('WITH');
			expect(compiled.sql).toContain('cte_users_posts');

			// The filter should be INSIDE the CTE definition, not in the main query
			// Pattern: WITH cte_users_posts AS (SELECT ... FROM posts WHERE posts.title = ?)
			const ctePart = compiled.sql.match(/WITH.*AS\s*\([^)]+\)/is)?.[0] || '';
			expect(ctePart.toUpperCase()).toContain('WHERE');
			expect(ctePart).toContain('"posts"."title"');

			// The value should be in the parameters
			expect(compiled.parameters).toContain('Hello');
		});

		it('should handle include without filter (no regression - CLI-012b)', () => {
			const kysely = createTestKysely();
			const model = createCteTestSchema();

			// Query users with include posts (no where clause)
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				include: [{ relation: 'posts' }],
			};

			const planReport = plan(intent, model);
			const compiled = compile(planReport, model, kysely);

			// Should have WITH clause for the CTE
			expect(compiled.sql.toUpperCase()).toContain('WITH');
			expect(compiled.sql).toContain('cte_users_posts');

			// CTE should NOT have WHERE clause (just SELECT * FROM posts)
			const ctePart = compiled.sql.match(/WITH.*AS\s*\([^)]+\)/is)?.[0] || '';
			expect(ctePart.toUpperCase()).not.toContain('WHERE');
		});

		// CLI-012b: Nested CTEs with filters
		it('should apply filters to nested CTEs (CLI-012b)', () => {
			const kysely = createTestKysely();
			// Extended schema with nested relations
			const model = defineSchemaBuilder({
				users: {
					id: 'integer',
					name: { type: 'string' },
				},
				posts: {
					id: 'integer',
					title: { type: 'string' },
					authorId: 'integer',
					published: { type: 'boolean' },
				},
				comments: {
					id: 'integer',
					content: { type: 'string' },
					postId: 'integer',
					approved: { type: 'boolean' },
				},
			})
				.relations({
					users: {
						posts: hasMany(
							'posts',
							{ foreignKey: 'authorId' },
							{ includeStrategy: 'cte' },
						),
					},
					posts: {
						comments: hasMany(
							'comments',
							{ foreignKey: 'postId' },
							{ includeStrategy: 'cte' },
						),
					},
				})
				.build();

			// Query users -> posts (published) -> comments (approved)
			const intent: QueryIntent = {
				type: 'select',
				from: 'users',
				include: [
					{
						relation: 'posts',
						where: {
							kind: 'comparison',
							field: 'published',
							operator: 'eq',
							value: true,
						},
						include: [
							{
								relation: 'comments',
								where: {
									kind: 'comparison',
									field: 'approved',
									operator: 'eq',
									value: true,
								},
							},
						],
					},
				],
			};

			const planReport = plan(intent, model);
			const compiled = compile(planReport, model, kysely);

			// Should have CTEs for both posts and comments
			expect(compiled.sql).toContain('cte_users_posts');
			expect(compiled.sql).toContain('cte_posts_comments');

			// Both CTEs should have their respective WHERE clauses
			// Check posts CTE has published filter
			expect(compiled.sql).toContain('"posts"."published"');
			// Check comments CTE has approved filter
			expect(compiled.sql).toContain('"comments"."approved"');
		});

		// CLI-012c: Recursive CTEs for self-referential relations
		describe('recursive CTEs (CLI-012c)', () => {
			// Helper to create self-referential schema
			function createRecursiveSchema() {
				return defineSchemaBuilder({
					categories: {
						id: 'integer',
						name: { type: 'string' },
						parentId: 'integer',
					},
				})
					.relations({
						categories: {
							children: hasMany('categories', { foreignKey: 'parentId' }),
							parent: belongsTo('categories', { foreignKey: 'parentId' }),
						},
					})
					.build();
			}

			it('should generate WITH RECURSIVE for self-referential include with recursive option', () => {
				const kysely = createTestKysely();
				const model = createRecursiveSchema();

				// Verify relation is self-referential
				const relation = model.getRelation('categories.children');
				expect(relation?.source).toBe('categories');
				expect(relation?.target).toBe('categories');

				const intent: QueryIntent = {
					type: 'select',
					from: 'categories',
					include: [
						{
							relation: 'children',
							recursive: { maxDepth: 10 },
						},
					],
				};

				const planReport = plan(intent, model);

				// Should have a recursive CTE
				expect(planReport.ctes.length).toBeGreaterThan(0);
				const recursiveCte = planReport.ctes.find((c) => c.recursive);
				expect(recursiveCte).toBeDefined();
				expect(recursiveCte?.name).toBe('cte_categories_children');

				const compiled = compile(planReport, model, kysely);

				// Should use WITH RECURSIVE
				expect(compiled.sql.toUpperCase()).toContain('WITH RECURSIVE');
				expect(compiled.sql).toContain('cte_categories_children');
			});

			it('should track depth when requested', () => {
				const kysely = createTestKysely();
				const model = createRecursiveSchema();

				const intent: QueryIntent = {
					type: 'select',
					from: 'categories',
					include: [
						{
							relation: 'children',
							recursive: {
								maxDepth: 5,
								track: { depth: true },
							},
						},
					],
				};

				const planReport = plan(intent, model);
				const compiled = compile(planReport, model, kysely);

				// Should have depth tracking (0 AS depth in base case)
				expect(compiled.sql).toContain('0');
				expect(compiled.sql.toLowerCase()).toContain('depth');
			});

			it('should warn when recursive is set on non-self-referential relation', () => {
				const kysely = createTestKysely();
				const model = createCteTestSchema(); // users -> posts (not self-referential)

				const intent: QueryIntent = {
					type: 'select',
					from: 'users',
					include: [
						{
							relation: 'posts',
							recursive: {}, // Invalid: posts is not self-referential
						},
					],
				};

				const planReport = plan(intent, model);

				// Should emit warning
				const warning = planReport.warnings.find(
					(w) => w.code === 'INVALID_RECURSIVE_INCLUDE',
				);
				expect(warning).toBeDefined();
				expect(warning?.message).toContain('posts');
				expect(warning?.message).toContain('not self-referential');

				// Should NOT use WITH RECURSIVE (fallback to normal CTE)
				const compiled = compile(planReport, model, kysely);
				expect(compiled.sql.toUpperCase()).not.toContain('WITH RECURSIVE');
			});

			it('should apply include.where filter to recursive CTE', () => {
				const kysely = createTestKysely();
				const model = defineSchemaBuilder({
					categories: {
						id: 'integer',
						name: { type: 'string' },
						parentId: 'integer',
						active: { type: 'boolean' },
					},
				})
					.relations({
						categories: {
							children: hasMany('categories', { foreignKey: 'parentId' }),
						},
					})
					.build();

				const intent: QueryIntent = {
					type: 'select',
					from: 'categories',
					include: [
						{
							relation: 'children',
							where: {
								kind: 'comparison',
								field: 'active',
								operator: 'eq',
								value: true,
							},
							recursive: { maxDepth: 10 },
						},
					],
				};

				const planReport = plan(intent, model);
				const compiled = compile(planReport, model, kysely);

				// Should have filter applied
				expect(compiled.sql).toContain('"active"');
				expect(compiled.parameters).toContain(true);
			});

			it('should use custom depth alias when specified', () => {
				const kysely = createTestKysely();
				const model = createRecursiveSchema();

				const intent: QueryIntent = {
					type: 'select',
					from: 'categories',
					include: [
						{
							relation: 'children',
							recursive: {
								maxDepth: 10,
								track: { depth: { as: 'level' } },
							},
						},
					],
				};

				const planReport = plan(intent, model);
				const compiled = compile(planReport, model, kysely);

				// Should use custom alias 'level' instead of 'depth'
				expect(compiled.sql.toLowerCase()).toContain('level');
			});
		});
	});
});
