/**
 * Tests for database introspection.
 *
 * @module introspection.test
 */

import type { ColumnMetadata, Kysely, TableMetadata } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import type { ForeignKeyInfo } from './introspection.js';
import { introspect } from './introspection.js';

// ============================================================================
// Mock Helpers
// ============================================================================

/**
 * Create a mock column metadata.
 */
function createColumn(
	name: string,
	dataType: string,
	options: { nullable?: boolean; autoIncrementing?: boolean } = {},
): ColumnMetadata {
	return {
		name,
		dataType,
		isNullable: options.nullable ?? true,
		isAutoIncrementing: options.autoIncrementing ?? false,
		hasDefaultValue: false,
	};
}

/**
 * Create a mock table metadata.
 */
function createTable(
	name: string,
	columns: ColumnMetadata[],
	schema = 'public',
): TableMetadata {
	return {
		name,
		schema,
		columns,
		isView: false,
	};
}

/**
 * Create a FK info for testing.
 */
function createFk(
	sourceTable: string,
	sourceColumn: string | string[],
	targetTable: string,
	targetColumn: string | string[],
): ForeignKeyInfo {
	return {
		sourceTable,
		sourceColumns: Array.isArray(sourceColumn) ? sourceColumn : [sourceColumn],
		targetTable,
		targetColumns: Array.isArray(targetColumn) ? targetColumn : [targetColumn],
	};
}

/**
 * Create a mock Kysely instance with introspection support.
 */
function createMockDb(tables: TableMetadata[]): Kysely<unknown> {
	return {
		introspection: {
			getTables: vi.fn().mockResolvedValue(tables),
		},
	} as unknown as Kysely<unknown>;
}

// ============================================================================
// Tests: Column Type Mapping
// ============================================================================

describe('introspection', () => {
	describe('column type mapping', () => {
		it('should map varchar to string', async () => {
			const db = createMockDb([
				createTable('users', [
					createColumn('id', 'int4', { autoIncrementing: true }),
					createColumn('name', 'varchar(255)'),
				]),
			]);

			const result = await introspect(db, { _foreignKeysForTesting: [] });
			const usersTable = result.getTable('users');

			expect(usersTable).toBeDefined();
			const nameCol = usersTable?.columns.find((c) => c.name === 'name');
			expect(nameCol?.type).toBe('string');
		});

		it('should map text to string', async () => {
			const db = createMockDb([
				createTable('posts', [
					createColumn('id', 'int4', { autoIncrementing: true }),
					createColumn('content', 'text'),
				]),
			]);

			const result = await introspect(db, { _foreignKeysForTesting: [] });
			const table = result.getTable('posts');
			const col = table?.columns.find((c) => c.name === 'content');
			expect(col?.type).toBe('string');
		});

		it('should map uuid to uuid type', async () => {
			const db = createMockDb([
				createTable('items', [createColumn('id', 'uuid')]),
			]);

			const result = await introspect(db, { _foreignKeysForTesting: [] });
			const table = result.getTable('items');
			const col = table?.columns.find((c) => c.name === 'id');
			// UUID gets its own type (better than mapping to string)
			expect(col?.type).toBe('uuid');
			// Original DB type is preserved
			expect(col?.originalDbType).toBe('uuid');
		});

		it('should map integer types correctly', async () => {
			const db = createMockDb([
				createTable('counters', [
					createColumn('id', 'serial', { autoIncrementing: true }),
					createColumn('count', 'int4'),
					createColumn('big_count', 'bigint'),
				]),
			]);

			const result = await introspect(db, { _foreignKeysForTesting: [] });
			const table = result.getTable('counters');

			// Regular integers map to number
			expect(table?.columns.find((c) => c.name === 'count')?.type).toBe(
				'number',
			);
			// BigInt maps to bigint type (for safe handling of large integers)
			expect(table?.columns.find((c) => c.name === 'big_count')?.type).toBe(
				'bigint',
			);
			// Original DB types are preserved
			expect(
				table?.columns.find((c) => c.name === 'big_count')?.originalDbType,
			).toBe('bigint');
		});

		it('should map float/decimal to number', async () => {
			const db = createMockDb([
				createTable('prices', [
					createColumn('id', 'int4', { autoIncrementing: true }),
					createColumn('amount', 'numeric(10,2)'),
					createColumn('rate', 'float8'),
				]),
			]);

			const result = await introspect(db, { _foreignKeysForTesting: [] });
			const table = result.getTable('prices');

			expect(table?.columns.find((c) => c.name === 'amount')?.type).toBe(
				'number',
			);
			expect(table?.columns.find((c) => c.name === 'rate')?.type).toBe(
				'number',
			);
		});

		it('should map boolean to boolean', async () => {
			const db = createMockDb([
				createTable('flags', [
					createColumn('id', 'int4', { autoIncrementing: true }),
					createColumn('is_active', 'bool'),
				]),
			]);

			const result = await introspect(db, { _foreignKeysForTesting: [] });
			const table = result.getTable('flags');
			const col = table?.columns.find((c) => c.name === 'is_active');
			expect(col?.type).toBe('boolean');
		});

		it('should map timestamp and date types correctly', async () => {
			const db = createMockDb([
				createTable('events', [
					createColumn('id', 'int4', { autoIncrementing: true }),
					createColumn('created_at', 'timestamptz'),
					createColumn('updated_at', 'timestamp'),
					createColumn('event_date', 'date'),
				]),
			]);

			const result = await introspect(db, { _foreignKeysForTesting: [] });
			const table = result.getTable('events');

			// Timestamp types map to datetime
			expect(table?.columns.find((c) => c.name === 'created_at')?.type).toBe(
				'datetime',
			);
			expect(table?.columns.find((c) => c.name === 'updated_at')?.type).toBe(
				'datetime',
			);
			// Date-only maps to date
			expect(table?.columns.find((c) => c.name === 'event_date')?.type).toBe(
				'date',
			);
			// Original DB types are preserved (useful for detecting timezone info loss)
			expect(
				table?.columns.find((c) => c.name === 'created_at')?.originalDbType,
			).toBe('timestamptz');
		});

		it('should map json/jsonb to json', async () => {
			const db = createMockDb([
				createTable('configs', [
					createColumn('id', 'int4', { autoIncrementing: true }),
					createColumn('data', 'jsonb'),
					createColumn('settings', 'json'),
				]),
			]);

			const result = await introspect(db, { _foreignKeysForTesting: [] });
			const table = result.getTable('configs');

			expect(table?.columns.find((c) => c.name === 'data')?.type).toBe('json');
			expect(table?.columns.find((c) => c.name === 'settings')?.type).toBe(
				'json',
			);
		});

		it('should default unknown types to string', async () => {
			const db = createMockDb([
				createTable('custom', [
					createColumn('id', 'int4', { autoIncrementing: true }),
					createColumn('geo', 'geometry'),
				]),
			]);

			const result = await introspect(db, { _foreignKeysForTesting: [] });
			const table = result.getTable('custom');
			const col = table?.columns.find((c) => c.name === 'geo');
			expect(col?.type).toBe('string');
			// Original DB type is preserved
			expect(col?.originalDbType).toBe('geometry');
		});

		it('should add warnings for lossy type conversions', async () => {
			const db = createMockDb([
				createTable('prices', [
					createColumn('id', 'int4', { autoIncrementing: true }),
					createColumn('amount', 'numeric(10,2)'),
					createColumn('name', 'varchar(255)'),
					createColumn('data', 'jsonb'),
					createColumn('geo', 'geometry'),
				]),
			]);

			const result = await introspect(db, { _foreignKeysForTesting: [] });

			// Should have warnings for lossy conversions
			expect(result.warnings.some((w) => w.includes('prices.amount'))).toBe(
				true,
			);
			expect(result.warnings.some((w) => w.includes('precision'))).toBe(true);
			expect(result.warnings.some((w) => w.includes('prices.name'))).toBe(true);
			expect(result.warnings.some((w) => w.includes('varchar'))).toBe(true);
			expect(result.warnings.some((w) => w.includes('prices.data'))).toBe(true);
			expect(result.warnings.some((w) => w.includes('jsonb'))).toBe(true);
			expect(result.warnings.some((w) => w.includes('prices.geo'))).toBe(true);
			expect(result.warnings.some((w) => w.includes('geometry'))).toBe(true);
		});

		it('should preserve originalDbType for all columns', async () => {
			const db = createMockDb([
				createTable('mixed', [
					createColumn('id', 'int4', { autoIncrementing: true }),
					createColumn('price', 'numeric(10,2)'),
					createColumn('name', 'varchar(100)'),
					createColumn('is_active', 'bool'),
					createColumn('uuid', 'uuid'),
					createColumn('count', 'bigint'),
				]),
			]);

			const result = await introspect(db, { _foreignKeysForTesting: [] });
			const table = result.getTable('mixed');

			expect(table?.columns.find((c) => c.name === 'id')?.originalDbType).toBe(
				'int4',
			);
			expect(
				table?.columns.find((c) => c.name === 'price')?.originalDbType,
			).toBe('numeric(10,2)');
			expect(
				table?.columns.find((c) => c.name === 'name')?.originalDbType,
			).toBe('varchar(100)');
			expect(
				table?.columns.find((c) => c.name === 'is_active')?.originalDbType,
			).toBe('bool');
			expect(
				table?.columns.find((c) => c.name === 'uuid')?.originalDbType,
			).toBe('uuid');
			expect(
				table?.columns.find((c) => c.name === 'count')?.originalDbType,
			).toBe('bigint');
		});
	});

	// ============================================================================
	// Tests: Table Filtering
	// ============================================================================

	describe('table filtering', () => {
		const tables = [
			createTable('users', [
				createColumn('id', 'int4', { autoIncrementing: true }),
			]),
			createTable('posts', [
				createColumn('id', 'int4', { autoIncrementing: true }),
			]),
			createTable('_migrations', [
				createColumn('id', 'int4', { autoIncrementing: true }),
			]),
			createTable('pg_stats', [
				createColumn('id', 'int4', { autoIncrementing: true }),
			]),
			createTable('prisma_migrations', [
				createColumn('id', 'int4', { autoIncrementing: true }),
			]),
		];

		it('should include all tables by default', async () => {
			const db = createMockDb(tables);
			const result = await introspect(db, { _foreignKeysForTesting: [] });

			expect(result.tables.size).toBe(5);
		});

		it('should exclude tables matching exact pattern', async () => {
			const db = createMockDb(tables);
			const result = await introspect(db, {
				exclude: ['_migrations'],
				_foreignKeysForTesting: [],
			});

			expect(result.getTable('_migrations')).toBeUndefined();
			expect(result.getTable('users')).toBeDefined();
		});

		it('should exclude tables matching glob pattern', async () => {
			const db = createMockDb(tables);
			const result = await introspect(db, {
				exclude: ['pg_*'],
				_foreignKeysForTesting: [],
			});

			expect(result.getTable('pg_stats')).toBeUndefined();
			expect(result.getTable('users')).toBeDefined();
		});

		it('should exclude multiple patterns', async () => {
			const db = createMockDb(tables);
			const result = await introspect(db, {
				exclude: ['_*', 'pg_*', 'prisma_*'],
				_foreignKeysForTesting: [],
			});

			expect(result.tables.size).toBe(2);
			expect(result.getTable('users')).toBeDefined();
			expect(result.getTable('posts')).toBeDefined();
		});

		it('should include only matching tables when include is specified', async () => {
			const db = createMockDb(tables);
			const result = await introspect(db, {
				include: ['users', 'posts'],
				_foreignKeysForTesting: [],
			});

			expect(result.tables.size).toBe(2);
			expect(result.getTable('users')).toBeDefined();
			expect(result.getTable('posts')).toBeDefined();
		});

		it('should include tables matching glob pattern', async () => {
			const db = createMockDb(tables);
			const result = await introspect(db, {
				include: ['*s'], // ends with 's'
				_foreignKeysForTesting: [],
			});

			expect(result.getTable('users')).toBeDefined();
			expect(result.getTable('posts')).toBeDefined();
			expect(result.getTable('pg_stats')).toBeDefined();
		});

		it('should apply exclude before include', async () => {
			const db = createMockDb(tables);
			const result = await introspect(db, {
				exclude: ['users'],
				include: ['users', 'posts'],
				_foreignKeysForTesting: [],
			});

			// users excluded even though it's in include
			expect(result.getTable('users')).toBeUndefined();
			expect(result.getTable('posts')).toBeDefined();
		});
	});

	// ============================================================================
	// Tests: Primary Key Detection
	// ============================================================================

	describe('primary key detection', () => {
		it('should detect auto-incrementing column as primary key', async () => {
			const db = createMockDb([
				createTable('users', [
					createColumn('id', 'serial', { autoIncrementing: true }),
					createColumn('name', 'varchar'),
				]),
			]);

			const result = await introspect(db, { _foreignKeysForTesting: [] });
			const table = result.getTable('users');

			expect(table?.primaryKey).toBe('id');
		});

		it('should default to id column when no auto-increment detected', async () => {
			const db = createMockDb([
				createTable('users', [
					createColumn('id', 'uuid'),
					createColumn('name', 'varchar'),
				]),
			]);

			const result = await introspect(db, { _foreignKeysForTesting: [] });
			const table = result.getTable('users');

			expect(table?.primaryKey).toBe('id');
		});

		it('should add warning when no id column and no auto-increment', async () => {
			const db = createMockDb([
				createTable('legacy', [
					createColumn('legacy_id', 'int4'),
					createColumn('data', 'text'),
				]),
			]);

			const result = await introspect(db, { _foreignKeysForTesting: [] });

			expect(result.warnings).toContain(
				"Table 'legacy' has no detected primary key. Assuming 'id' but this may be incorrect.",
			);
		});

		it('should handle composite primary keys from multiple auto-increment columns', async () => {
			const db = createMockDb([
				createTable('composite', [
					createColumn('key1', 'serial', { autoIncrementing: true }),
					createColumn('key2', 'serial', { autoIncrementing: true }),
					createColumn('data', 'text'),
				]),
			]);

			const result = await introspect(db, { _foreignKeysForTesting: [] });
			const table = result.getTable('composite');

			// Should be array when multiple auto-incrementing columns
			expect(Array.isArray(table?.primaryKey)).toBe(true);
			expect(table?.primaryKey).toContain('key1');
			expect(table?.primaryKey).toContain('key2');
		});
	});

	// ============================================================================
	// Tests: Relation Inference
	// ============================================================================

	describe('relation inference', () => {
		it('should infer belongsTo relation from FK', async () => {
			const tables = [
				createTable('users', [
					createColumn('id', 'int4', { autoIncrementing: true }),
				]),
				createTable('posts', [
					createColumn('id', 'int4', { autoIncrementing: true }),
					createColumn('author_id', 'int4'),
				]),
			];
			const fks = [createFk('posts', 'author_id', 'users', 'id')];

			const db = createMockDb(tables);
			const result = await introspect(db, { _foreignKeysForTesting: fks });

			// posts.author → users (belongsTo)
			const authorRelation = result.getRelation('posts.author');
			expect(authorRelation).toBeDefined();
			expect(authorRelation?.type).toBe('belongsTo');
			expect(authorRelation?.source).toBe('posts');
			expect(authorRelation?.target).toBe('users');
			expect(authorRelation?.foreignKey).toBe('author_id');
		});

		it('should infer hasMany relation from FK', async () => {
			const tables = [
				createTable('users', [
					createColumn('id', 'int4', { autoIncrementing: true }),
				]),
				createTable('posts', [
					createColumn('id', 'int4', { autoIncrementing: true }),
					createColumn('author_id', 'int4'),
				]),
			];
			const fks = [createFk('posts', 'author_id', 'users', 'id')];

			const db = createMockDb(tables);
			const result = await introspect(db, { _foreignKeysForTesting: fks });

			// users.posts → posts (hasMany)
			const postsRelation = result.getRelation('users.posts');
			expect(postsRelation).toBeDefined();
			expect(postsRelation?.type).toBe('hasMany');
			expect(postsRelation?.source).toBe('users');
			expect(postsRelation?.target).toBe('posts');
			expect(postsRelation?.cardinality).toBe('many');
		});

		it('should use camelCase naming by default', async () => {
			const tables = [
				createTable('users', [
					createColumn('id', 'int4', { autoIncrementing: true }),
				]),
				createTable('blog_posts', [
					createColumn('id', 'int4', { autoIncrementing: true }),
					createColumn('user_id', 'int4'),
				]),
			];
			const fks = [createFk('blog_posts', 'user_id', 'users', 'id')];

			const db = createMockDb(tables);
			const result = await introspect(db, { _foreignKeysForTesting: fks });

			// Should be 'user' not 'user_'
			const userRelation = result.getRelation('blog_posts.user');
			expect(userRelation).toBeDefined();
		});

		it('should handle snake_case naming option', async () => {
			const tables = [
				createTable('users', [
					createColumn('id', 'int4', { autoIncrementing: true }),
				]),
				createTable('blog_posts', [
					createColumn('id', 'int4', { autoIncrementing: true }),
					createColumn('userId', 'int4'),
				]),
			];
			const fks = [createFk('blog_posts', 'userId', 'users', 'id')];

			const db = createMockDb(tables);
			const result = await introspect(db, {
				relationNaming: 'snake_case',
				_foreignKeysForTesting: fks,
			});

			// userId → user (camelCase to snake_case)
			const userRelation = result.getRelation('blog_posts.user');
			expect(userRelation).toBeDefined();
		});

		it('should use source table name for hasMany relations', async () => {
			const tables = [
				createTable('categories', [
					createColumn('id', 'int4', { autoIncrementing: true }),
				]),
				createTable('products', [
					createColumn('id', 'int4', { autoIncrementing: true }),
					createColumn('category_id', 'int4'),
				]),
			];
			const fks = [createFk('products', 'category_id', 'categories', 'id')];

			const db = createMockDb(tables);
			const result = await introspect(db, { _foreignKeysForTesting: fks });

			// categories.products (table name used directly, no pluralization needed)
			const productsRelation = result.getRelation('categories.products');
			expect(productsRelation).toBeDefined();
			expect(productsRelation?.target).toBe('products');
		});

		it('should use join strategy for belongsTo relations', async () => {
			const tables = [
				createTable('users', [
					createColumn('id', 'int4', { autoIncrementing: true }),
				]),
				createTable('posts', [
					createColumn('id', 'int4', { autoIncrementing: true }),
					createColumn('author_id', 'int4'),
				]),
			];
			const fks = [createFk('posts', 'author_id', 'users', 'id')];

			const db = createMockDb(tables);
			const result = await introspect(db, { _foreignKeysForTesting: fks });

			const belongsTo = result.getRelation('posts.author');
			expect(belongsTo?.includeStrategy).toBe('join');
		});

		it('should use separate strategy for hasMany relations', async () => {
			const tables = [
				createTable('users', [
					createColumn('id', 'int4', { autoIncrementing: true }),
				]),
				createTable('posts', [
					createColumn('id', 'int4', { autoIncrementing: true }),
					createColumn('author_id', 'int4'),
				]),
			];
			const fks = [createFk('posts', 'author_id', 'users', 'id')];

			const db = createMockDb(tables);
			const result = await introspect(db, { _foreignKeysForTesting: fks });

			const hasMany = result.getRelation('users.posts');
			expect(hasMany?.includeStrategy).toBe('subquery');
		});
	});

	// ============================================================================
	// Tests: Composite Foreign Keys
	// ============================================================================

	describe('composite foreign keys', () => {
		it('should handle composite FK columns', async () => {
			const tables = [
				createTable('tenants', [
					createColumn('org_id', 'int4', { autoIncrementing: true }),
					createColumn('tenant_id', 'int4', { autoIncrementing: true }),
				]),
				createTable('users', [
					createColumn('id', 'int4', { autoIncrementing: true }),
					createColumn('org_id', 'int4'),
					createColumn('tenant_id', 'int4'),
				]),
			];
			// Composite FK with array of columns
			const fks = [
				createFk('users', ['org_id', 'tenant_id'], 'tenants', [
					'org_id',
					'tenant_id',
				]),
			];

			const db = createMockDb(tables);
			const result = await introspect(db, { _foreignKeysForTesting: fks });

			// Should have FK with array of columns
			const usersTable = result.getTable('users');
			expect(usersTable?.foreignKeys).toHaveLength(1);
			expect(usersTable?.foreignKeys[0]?.columns).toContain('org_id');
			expect(usersTable?.foreignKeys[0]?.columns).toContain('tenant_id');
		});

		it('should create relation with composite FK columns array', async () => {
			const tables = [
				createTable('tenants', [
					createColumn('org_id', 'int4', { autoIncrementing: true }),
					createColumn('tenant_id', 'int4', { autoIncrementing: true }),
				]),
				createTable('users', [
					createColumn('id', 'int4', { autoIncrementing: true }),
					createColumn('org_id', 'int4'),
					createColumn('tenant_id', 'int4'),
				]),
			];
			const fks = [
				createFk('users', ['org_id', 'tenant_id'], 'tenants', [
					'org_id',
					'tenant_id',
				]),
			];

			const db = createMockDb(tables);
			const result = await introspect(db, { _foreignKeysForTesting: fks });

			// Relation uses first column for name, but stores array for FK
			const orgRelation = result.getRelation('users.org');
			expect(orgRelation).toBeDefined();
			// FK should be array when composite
			expect(Array.isArray(orgRelation?.foreignKey)).toBe(true);
		});
	});

	// ============================================================================
	// Tests: Adjacency Pattern Detection
	// ============================================================================

	describe('adjacency pattern detection', () => {
		it('should detect self-referential FK as adjacency pattern', async () => {
			const tables = [
				createTable('categories', [
					createColumn('id', 'int4', { autoIncrementing: true }),
					createColumn('name', 'varchar'),
					createColumn('parent_id', 'int4'),
				]),
			];
			const fks = [createFk('categories', 'parent_id', 'categories', 'id')];

			const db = createMockDb(tables);
			const result = await introspect(db, { _foreignKeysForTesting: fks });

			expect(result.hierarchies).toHaveLength(1);
			const hierarchy = result.hierarchies[0];
			expect(hierarchy).toBeDefined();
			expect(hierarchy?.type).toBe('adjacency');
			expect(hierarchy?.nodeTable).toBe('categories');
			expect(hierarchy?.parentColumn).toBe('parent_id');
			expect(hierarchy?.nodeIdColumn).toBe('id');
		});

		it('should detect manager relationship as adjacency', async () => {
			const tables = [
				createTable('employees', [
					createColumn('id', 'int4', { autoIncrementing: true }),
					createColumn('name', 'varchar'),
					createColumn('manager_id', 'int4'),
				]),
			];
			const fks = [createFk('employees', 'manager_id', 'employees', 'id')];

			const db = createMockDb(tables);
			const result = await introspect(db, { _foreignKeysForTesting: fks });

			const hierarchy = result.hierarchies[0];
			expect(hierarchy).toBeDefined();
			expect(hierarchy?.type).toBe('adjacency');
			expect(hierarchy?.parentColumn).toBe('manager_id');
		});

		it('should not create adjacency for non-self-referential FK', async () => {
			const tables = [
				createTable('users', [
					createColumn('id', 'int4', { autoIncrementing: true }),
				]),
				createTable('posts', [
					createColumn('id', 'int4', { autoIncrementing: true }),
					createColumn('author_id', 'int4'),
				]),
			];
			const fks = [createFk('posts', 'author_id', 'users', 'id')];

			const db = createMockDb(tables);
			const result = await introspect(db, { _foreignKeysForTesting: fks });

			// Should have no adjacency hierarchies
			const adjacencyHierarchies = result.hierarchies.filter(
				(h) => h.type === 'adjacency',
			);
			expect(adjacencyHierarchies).toHaveLength(0);
		});

		it('should handle multiple adjacency patterns in same database', async () => {
			const tables = [
				createTable('categories', [
					createColumn('id', 'int4', { autoIncrementing: true }),
					createColumn('parent_id', 'int4'),
				]),
				createTable('employees', [
					createColumn('id', 'int4', { autoIncrementing: true }),
					createColumn('manager_id', 'int4'),
				]),
			];
			const fks = [
				createFk('categories', 'parent_id', 'categories', 'id'),
				createFk('employees', 'manager_id', 'employees', 'id'),
			];

			const db = createMockDb(tables);
			const result = await introspect(db, { _foreignKeysForTesting: fks });

			const adjacencyHierarchies = result.hierarchies.filter(
				(h) => h.type === 'adjacency',
			);
			expect(adjacencyHierarchies).toHaveLength(2);
		});
	});

	// ============================================================================
	// Tests: Edge-Table Pattern Detection
	// ============================================================================

	describe('edge-table pattern detection', () => {
		it('should detect edge-table pattern with 2 FKs to same target', async () => {
			const tables = [
				createTable('roles', [
					createColumn('id', 'int4', { autoIncrementing: true }),
					createColumn('name', 'varchar'),
				]),
				createTable('role_hierarchy', [
					createColumn('id', 'int4', { autoIncrementing: true }),
					createColumn('parent_role_id', 'int4'),
					createColumn('child_role_id', 'int4'),
				]),
			];
			const fks = [
				createFk('role_hierarchy', 'parent_role_id', 'roles', 'id'),
				createFk('role_hierarchy', 'child_role_id', 'roles', 'id'),
			];

			const db = createMockDb(tables);
			const result = await introspect(db, { _foreignKeysForTesting: fks });

			const edgeTable = result.hierarchies.find((h) => h.type === 'edge-table');
			expect(edgeTable).toBeDefined();
			expect(edgeTable?.nodeTable).toBe('roles');
			expect(edgeTable?.edgeTable).toBe('role_hierarchy');
			expect(edgeTable?.parentColumn).toBe('parent_role_id');
			expect(edgeTable?.childColumn).toBe('child_role_id');
		});

		it('should not detect edge-table when FKs point to different targets', async () => {
			const tables = [
				createTable('users', [
					createColumn('id', 'int4', { autoIncrementing: true }),
				]),
				createTable('posts', [
					createColumn('id', 'int4', { autoIncrementing: true }),
				]),
				createTable('comments', [
					createColumn('id', 'int4', { autoIncrementing: true }),
					createColumn('author_id', 'int4'),
					createColumn('post_id', 'int4'),
				]),
			];
			const fks = [
				createFk('comments', 'author_id', 'users', 'id'),
				createFk('comments', 'post_id', 'posts', 'id'),
			];

			const db = createMockDb(tables);
			const result = await introspect(db, { _foreignKeysForTesting: fks });

			const edgeTableHierarchies = result.hierarchies.filter(
				(h) => h.type === 'edge-table',
			);
			expect(edgeTableHierarchies).toHaveLength(0);
		});

		it('should not confuse self-referential FK with edge-table', async () => {
			const tables = [
				createTable('categories', [
					createColumn('id', 'int4', { autoIncrementing: true }),
					createColumn('parent_id', 'int4'),
				]),
			];
			const fks = [createFk('categories', 'parent_id', 'categories', 'id')];

			const db = createMockDb(tables);
			const result = await introspect(db, { _foreignKeysForTesting: fks });

			// Should be adjacency, not edge-table
			expect(result.hierarchies.every((h) => h.type === 'adjacency')).toBe(
				true,
			);
		});

		it('should detect both adjacency and edge-table patterns in same database', async () => {
			const tables = [
				// Adjacency pattern
				createTable('categories', [
					createColumn('id', 'int4', { autoIncrementing: true }),
					createColumn('parent_id', 'int4'),
				]),
				// Edge-table pattern
				createTable('roles', [
					createColumn('id', 'int4', { autoIncrementing: true }),
				]),
				createTable('role_edges', [
					createColumn('id', 'int4', { autoIncrementing: true }),
					createColumn('parent_id', 'int4'),
					createColumn('child_id', 'int4'),
				]),
			];
			const fks = [
				createFk('categories', 'parent_id', 'categories', 'id'),
				createFk('role_edges', 'parent_id', 'roles', 'id'),
				createFk('role_edges', 'child_id', 'roles', 'id'),
			];

			const db = createMockDb(tables);
			const result = await introspect(db, { _foreignKeysForTesting: fks });

			const adjacency = result.hierarchies.filter(
				(h) => h.type === 'adjacency',
			);
			const edgeTable = result.hierarchies.filter(
				(h) => h.type === 'edge-table',
			);

			expect(adjacency).toHaveLength(1);
			expect(edgeTable).toHaveLength(1);
		});
	});

	// ============================================================================
	// Tests: Edge Cases
	// ============================================================================

	describe('edge cases', () => {
		it('should handle empty database', async () => {
			const db = createMockDb([]);
			const result = await introspect(db, { _foreignKeysForTesting: [] });

			expect(result.tables.size).toBe(0);
			expect(result.relations.size).toBe(0);
			expect(result.hierarchies).toHaveLength(0);
		});

		it('should filter FK relations when target table is excluded', async () => {
			const tables = [
				createTable('users', [
					createColumn('id', 'int4', { autoIncrementing: true }),
				]),
				createTable('posts', [
					createColumn('id', 'int4', { autoIncrementing: true }),
					createColumn('author_id', 'int4'),
				]),
			];
			const fks = [createFk('posts', 'author_id', 'users', 'id')];

			const db = createMockDb(tables);
			const result = await introspect(db, {
				exclude: ['users'],
				_foreignKeysForTesting: fks,
			});

			// posts table exists but no relation to excluded users
			expect(result.getTable('posts')).toBeDefined();
			expect(result.getRelation('posts.author')).toBeUndefined();
		});

		it('should set introspectedAt timestamp', async () => {
			const db = createMockDb([
				createTable('test', [
					createColumn('id', 'int4', { autoIncrementing: true }),
				]),
			]);

			const before = new Date();
			const result = await introspect(db, { _foreignKeysForTesting: [] });
			const after = new Date();

			expect(result.introspectedAt.getTime()).toBeGreaterThanOrEqual(
				before.getTime(),
			);
			expect(result.introspectedAt.getTime()).toBeLessThanOrEqual(
				after.getTime(),
			);
		});

		it('should use public schema by default', async () => {
			const db = createMockDb([
				createTable('users', [
					createColumn('id', 'int4', { autoIncrementing: true }),
				]),
			]);

			// Just verify no error - actual schema usage is in queryForeignKeys
			const result = await introspect(db, { _foreignKeysForTesting: [] });
			expect(result.tables.size).toBe(1);
		});

		it('should accept custom schema option', async () => {
			const db = createMockDb([
				createTable(
					'users',
					[createColumn('id', 'int4', { autoIncrementing: true })],
					'tenant_123', // Match the schema option
				),
			]);

			// Introspect with custom schema - should only find tables in that schema
			const result = await introspect(db, {
				schema: 'tenant_123',
				_foreignKeysForTesting: [],
			});
			expect(result.tables.size).toBe(1);
		});
	});

	// ============================================================================
	// Tests: ModelIR Interface Compliance
	// ============================================================================

	describe('ModelIR interface compliance', () => {
		it('should implement getTable method', async () => {
			const db = createMockDb([
				createTable('users', [
					createColumn('id', 'int4', { autoIncrementing: true }),
				]),
			]);

			const result = await introspect(db, { _foreignKeysForTesting: [] });

			expect(typeof result.getTable).toBe('function');
			expect(result.getTable('users')).toBeDefined();
			expect(result.getTable('nonexistent')).toBeUndefined();
		});

		it('should implement getRelation method', async () => {
			const tables = [
				createTable('users', [
					createColumn('id', 'int4', { autoIncrementing: true }),
				]),
				createTable('posts', [
					createColumn('id', 'int4', { autoIncrementing: true }),
					createColumn('author_id', 'int4'),
				]),
			];
			const fks = [createFk('posts', 'author_id', 'users', 'id')];

			const db = createMockDb(tables);
			const result = await introspect(db, { _foreignKeysForTesting: fks });

			expect(typeof result.getRelation).toBe('function');
			expect(result.getRelation('posts.author')).toBeDefined();
			expect(result.getRelation('posts.nonexistent')).toBeUndefined();
		});

		it('should implement getRelationsFrom method', async () => {
			const tables = [
				createTable('users', [
					createColumn('id', 'int4', { autoIncrementing: true }),
				]),
				createTable('posts', [
					createColumn('id', 'int4', { autoIncrementing: true }),
					createColumn('author_id', 'int4'),
				]),
			];
			const fks = [createFk('posts', 'author_id', 'users', 'id')];

			const db = createMockDb(tables);
			const result = await introspect(db, { _foreignKeysForTesting: fks });

			expect(typeof result.getRelationsFrom).toBe('function');
			const fromPosts = result.getRelationsFrom('posts');
			expect(fromPosts).toHaveLength(1);
			expect(fromPosts[0]?.name).toBe('author');
		});

		it('should implement getRelationsTo method', async () => {
			const tables = [
				createTable('users', [
					createColumn('id', 'int4', { autoIncrementing: true }),
				]),
				createTable('posts', [
					createColumn('id', 'int4', { autoIncrementing: true }),
					createColumn('author_id', 'int4'),
				]),
			];
			const fks = [createFk('posts', 'author_id', 'users', 'id')];

			const db = createMockDb(tables);
			const result = await introspect(db, { _foreignKeysForTesting: fks });

			expect(typeof result.getRelationsTo).toBe('function');
			const toUsers = result.getRelationsTo('users');
			expect(toUsers).toHaveLength(1);
			expect(toUsers[0]?.name).toBe('author');
		});

		it('should provide tables as ReadonlyMap', async () => {
			const db = createMockDb([
				createTable('users', [
					createColumn('id', 'int4', { autoIncrementing: true }),
				]),
				createTable('posts', [
					createColumn('id', 'int4', { autoIncrementing: true }),
				]),
			]);

			const result = await introspect(db, { _foreignKeysForTesting: [] });

			expect(result.tables).toBeInstanceOf(Map);
			expect(result.tables.size).toBe(2);
			expect(result.tables.get('users')).toBeDefined();
		});

		it('should provide relations as ReadonlyMap', async () => {
			const tables = [
				createTable('users', [
					createColumn('id', 'int4', { autoIncrementing: true }),
				]),
				createTable('posts', [
					createColumn('id', 'int4', { autoIncrementing: true }),
					createColumn('author_id', 'int4'),
				]),
			];
			const fks = [createFk('posts', 'author_id', 'users', 'id')];

			const db = createMockDb(tables);
			const result = await introspect(db, { _foreignKeysForTesting: fks });

			expect(result.relations).toBeInstanceOf(Map);
			expect(result.relations.size).toBe(2); // belongsTo + hasMany
		});
	});
});

// ============================================================================
// Tests: getSchemaFromDb (ARCH-006)
// ============================================================================

// NOTE: getSchemaFromDb requires a real database connection because it calls
// introspect() which queries information_schema. Unit tests cannot mock this
// effectively. See tests/e2e/introspection.test.ts for e2e tests of getSchemaFromDb.
