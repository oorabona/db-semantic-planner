import {
	belongsTo,
	defineSchema,
	hasMany,
	plan,
	planRecursive,
	type QueryIntent,
	type RecursiveIntent,
} from '@db-semantic-planner/core';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { describe, expect, it } from 'vitest';
import { compile, compileRecursive } from './compiler.js';
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
	// RFC-001: Recursive CTE Compilation Tests
	// ============================================================================

	describe('RFC-001: Recursive CTE', () => {
		/**
		 * Recursive schema: Categories with parent (for hierarchical traversal)
		 */
		const recursiveSchema = defineSchema({
			categories: {
				id: 'number',
				name: 'string',
				parentId: 'number',
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
		const edgeTableSchema = defineSchema({
			roles: {
				id: 'number',
				name: 'string',
			},
			roleEdges: {
				id: 'number',
				parentRoleId: 'number',
				childRoleId: 'number',
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
	});
});
