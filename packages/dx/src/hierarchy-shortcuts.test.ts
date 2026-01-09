/**
 * DX-009: Hierarchy Shortcuts Tests
 * Tests for ancestors(), descendants(), subtree() ORM shortcuts
 */

import { belongsTo, defineSchema, hasMany } from '@db-semantic-planner/core';
import {
	Kysely,
	PostgresAdapter,
	PostgresIntrospector,
	PostgresQueryCompiler,
} from 'kysely';
import { describe, expect, it } from 'vitest';
import { createOrm } from './orm.js';

// Dummy driver for testing (no actual DB connection)
class DummyDriver {
	async init() {}
	async acquireConnection() {
		return {};
	}
	async beginTransaction() {}
	async commitTransaction() {}
	async rollbackTransaction() {}
	async releaseConnection() {}
	async destroy() {}
}

function createTestDb() {
	return new Kysely({
		dialect: {
			createAdapter: () => new PostgresAdapter(),
			createDriver: () => new DummyDriver() as never,
			createIntrospector: (db) => new PostgresIntrospector(db),
			createQueryCompiler: () => new PostgresQueryCompiler(),
		},
	});
}

// Adjacency model: categories with parent reference
const categoryModel = defineSchema({
	categories: {
		id: 'uuid',
		name: 'string',
		parentId: { type: 'uuid', nullable: true },
	},
})
	.relations({
		categories: {
			parent: belongsTo('categories', { foreignKey: 'parentId' }),
			children: hasMany('categories', { foreignKey: 'parentId' }),
		},
	})
	.build();

describe('DX-009: Hierarchy Shortcuts', () => {
	describe('ancestors()', () => {
		it('should create RecursiveQueryBuilder for ancestor traversal', () => {
			const db = createTestDb();
			const orm = createOrm({ model: categoryModel, db });

			const builder = orm.ancestors('categories', 42, {
				parentId: 'parentId',
			});

			// Builder should be configured correctly
			const { sql, intent } = builder.upToDepth(10).dump();

			expect(sql.toLowerCase()).toContain('with recursive');
			expect(intent.traversal?.kind).toBe('adjacency');
			if (intent.traversal?.kind === 'adjacency') {
				expect(intent.traversal.direction).toBe('ancestors');
			}
		});

		it('should use default nodeId "id" when not specified', () => {
			const db = createTestDb();
			const orm = createOrm({ model: categoryModel, db });

			const builder = orm.ancestors('categories', 1, {
				parentId: 'parentId',
			});

			const { intent } = builder.upToDepth(5).dump();
			expect(intent.start.nodeIdExpr).toEqual({ kind: 'column', name: 'id' });
		});

		it('should use custom nodeId when specified', () => {
			const db = createTestDb();
			const orm = createOrm({ model: categoryModel, db });

			const builder = orm.ancestors('categories', 1, {
				parentId: 'parentId',
				nodeId: 'category_id',
			});

			const { intent } = builder.upToDepth(5).dump();
			expect(intent.start.nodeIdExpr).toEqual({
				kind: 'column',
				name: 'category_id',
			});
		});

		it('should use custom cteName when specified', () => {
			const db = createTestDb();
			const orm = createOrm({ model: categoryModel, db });

			const builder = orm.ancestors('categories', 1, {
				parentId: 'parentId',
				cteName: 'my_ancestors',
			});

			const { sql } = builder.upToDepth(5).dump();
			expect(sql).toContain('my_ancestors');
		});

		it('should throw when db not configured', () => {
			const orm = createOrm({ model: categoryModel });

			expect(() =>
				orm.ancestors('categories', 42, { parentId: 'parentId' }),
			).toThrow('ancestors() requires a database connection');
		});
	});

	describe('descendants()', () => {
		it('should create RecursiveQueryBuilder for descendant traversal', () => {
			const db = createTestDb();
			const orm = createOrm({ model: categoryModel, db });

			const builder = orm.descendants('categories', 1, {
				parentId: 'parentId',
			});

			const { sql, intent } = builder.upToDepth(10).dump();

			expect(sql.toLowerCase()).toContain('with recursive');
			expect(intent.traversal?.kind).toBe('adjacency');
			if (intent.traversal?.kind === 'adjacency') {
				expect(intent.traversal.direction).toBe('descendants');
			}
		});

		it('should generate auto cteName based on table', () => {
			const db = createTestDb();
			const orm = createOrm({ model: categoryModel, db });

			const builder = orm.descendants('categories', 1, {
				parentId: 'parentId',
			});

			const { sql } = builder.upToDepth(5).dump();
			expect(sql).toContain('categories_descendants');
		});

		it('should throw when db not configured', () => {
			const orm = createOrm({ model: categoryModel });

			expect(() =>
				orm.descendants('categories', 1, { parentId: 'parentId' }),
			).toThrow('descendants() requires a database connection');
		});
	});

	describe('subtree()', () => {
		it('should create RecursiveQueryBuilder for subtree traversal', () => {
			const db = createTestDb();
			const orm = createOrm({ model: categoryModel, db });

			const builder = orm.subtree('categories', 5, {
				parentId: 'parentId',
			});

			const { sql, intent } = builder.upToDepth(10).dump();

			expect(sql.toLowerCase()).toContain('with recursive');
			// Subtree uses descendants direction (includes starting node)
			expect(intent.traversal?.kind).toBe('adjacency');
			if (intent.traversal?.kind === 'adjacency') {
				expect(intent.traversal.direction).toBe('descendants');
			}
		});

		it('should generate auto cteName with _subtree suffix', () => {
			const db = createTestDb();
			const orm = createOrm({ model: categoryModel, db });

			const builder = orm.subtree('categories', 5, {
				parentId: 'parentId',
			});

			const { sql } = builder.upToDepth(5).dump();
			expect(sql).toContain('categories_subtree');
		});

		it('should throw when db not configured', () => {
			const orm = createOrm({ model: categoryModel });

			expect(() =>
				orm.subtree('categories', 5, { parentId: 'parentId' }),
			).toThrow('subtree() requires a database connection');
		});
	});

	describe('Multi-tenant support', () => {
		it('should work with forTenant()', () => {
			const db = createTestDb();
			const orm = createOrm({ model: categoryModel, db });
			const tenantOrm = orm.forTenant('tenant_123');

			const builder = tenantOrm.descendants('categories', 1, {
				parentId: 'parentId',
			});

			const { sql } = builder.upToDepth(5).dump();
			expect(sql).toContain('tenant_123');
		});
	});
});
