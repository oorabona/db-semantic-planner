/**
 * DX-022: Hierarchy List Methods Tests
 * Tests for listAncestors() and listDescendants() ORM methods
 * These replace the old ancestors(), descendants(), subtree() methods (BREAKING CHANGE)
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

describe('DX-022: Hierarchy List Methods', () => {
	describe('listAncestors()', () => {
		it('should throw when db not configured', async () => {
			const orm = createOrm({ model: categoryModel });

			await expect(
				orm.listAncestors('categories', 42, { parentId: 'parentId' }),
			).rejects.toThrow('listAncestors() requires a database connection');
		});

		it('should have method defined on ORM', () => {
			const db = createTestDb();
			const orm = createOrm({ model: categoryModel, db });

			expect(typeof orm.listAncestors).toBe('function');
		});

		it('should have correct signature', () => {
			const db = createTestDb();
			const orm = createOrm({ model: categoryModel, db });

			// Method should accept table, nodeIdValue, and options
			expect(orm.listAncestors.length).toBe(3);
		});
	});

	describe('listDescendants()', () => {
		it('should throw when db not configured', async () => {
			const orm = createOrm({ model: categoryModel });

			await expect(
				orm.listDescendants('categories', 1, { parentId: 'parentId' }),
			).rejects.toThrow('listDescendants() requires a database connection');
		});

		it('should have method defined on ORM', () => {
			const db = createTestDb();
			const orm = createOrm({ model: categoryModel, db });

			expect(typeof orm.listDescendants).toBe('function');
		});

		it('should have correct signature', () => {
			const db = createTestDb();
			const orm = createOrm({ model: categoryModel, db });

			// Method should accept table, nodeIdValue, and options
			expect(orm.listDescendants.length).toBe(3);
		});
	});

	describe('Old API removed (DX-022 Breaking Change)', () => {
		it('should NOT have ancestors() method', () => {
			const db = createTestDb();
			const orm = createOrm({ model: categoryModel, db });

			// biome-ignore lint/suspicious/noExplicitAny: Testing removed API
			expect((orm as any).ancestors).toBeUndefined();
		});

		it('should NOT have descendants() method', () => {
			const db = createTestDb();
			const orm = createOrm({ model: categoryModel, db });

			// biome-ignore lint/suspicious/noExplicitAny: Testing removed API
			expect((orm as any).descendants).toBeUndefined();
		});

		it('should NOT have subtree() method', () => {
			const db = createTestDb();
			const orm = createOrm({ model: categoryModel, db });

			// biome-ignore lint/suspicious/noExplicitAny: Testing removed API
			expect((orm as any).subtree).toBeUndefined();
		});

		it('should NOT have recursive() method', () => {
			const db = createTestDb();
			const orm = createOrm({ model: categoryModel, db });

			// biome-ignore lint/suspicious/noExplicitAny: Testing removed API
			expect((orm as any).recursive).toBeUndefined();
		});
	});

	describe('Multi-tenant support', () => {
		it('should have listAncestors on tenant ORM', () => {
			const db = createTestDb();
			const orm = createOrm({ model: categoryModel, db });
			const tenantOrm = orm.forTenant('tenant_123');

			expect(typeof tenantOrm.listAncestors).toBe('function');
		});

		it('should have listDescendants on tenant ORM', () => {
			const db = createTestDb();
			const orm = createOrm({ model: categoryModel, db });
			const tenantOrm = orm.forTenant('tenant_123');

			expect(typeof tenantOrm.listDescendants).toBe('function');
		});
	});
});
