/**
 * DX-022: Hierarchy List Methods Tests
 * Tests for listAncestors() and listDescendants() ORM methods
 * These replace the old ancestors(), descendants(), subtree() methods (BREAKING CHANGE)
 */

import { createOrm, ref, schema } from '@dbsp/core';
import {
	Kysely,
	PostgresAdapter,
	PostgresIntrospector,
	PostgresQueryCompiler,
} from 'kysely';
import { describe, expect, it } from 'vitest';
import { createKyselyAdapter } from './kysely-adapter.js';

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
const categorySchema = schema({
	categories: {
		id: { type: 'uuid', primaryKey: true },
		name: 'string',
		parentId: ref('categories', {
			nullable: true,
			roles: { parent: 'parent', children: 'children' },
		}),
	},
});

describe('DX-022: Hierarchy List Methods', () => {
	describe('listAncestors()', () => {
		it('should throw when db not configured', async () => {
			const orm = createOrm({ schema: categorySchema });

			await expect(
				orm.listAncestors('categories', 42, { parentId: 'parentId' }),
			).rejects.toThrow('listAncestors() requires an adapter');
		});

		it('should have method defined on ORM', () => {
			const db = createTestDb();
			const orm = createOrm({
				schema: categorySchema,
				adapter: createKyselyAdapter(db),
			});

			expect(typeof orm.listAncestors).toBe('function');
		});

		it('should have correct signature', () => {
			const db = createTestDb();
			const orm = createOrm({
				schema: categorySchema,
				adapter: createKyselyAdapter(db),
			});

			// Method should accept table, nodeIdValue, and options
			expect(orm.listAncestors.length).toBe(3);
		});
	});

	describe('listDescendants()', () => {
		it('should throw when db not configured', async () => {
			const orm = createOrm({ schema: categorySchema });

			await expect(
				orm.listDescendants('categories', 1, { parentId: 'parentId' }),
			).rejects.toThrow('listDescendants() requires an adapter');
		});

		it('should have method defined on ORM', () => {
			const db = createTestDb();
			const orm = createOrm({
				schema: categorySchema,
				adapter: createKyselyAdapter(db),
			});

			expect(typeof orm.listDescendants).toBe('function');
		});

		it('should have correct signature', () => {
			const db = createTestDb();
			const orm = createOrm({
				schema: categorySchema,
				adapter: createKyselyAdapter(db),
			});

			// Method should accept table, nodeIdValue, and options
			expect(orm.listDescendants.length).toBe(3);
		});
	});

	describe('Multi-tenant support', () => {
		it('should have listAncestors on tenant ORM', () => {
			const db = createTestDb();
			const orm = createOrm({
				schema: categorySchema,
				adapter: createKyselyAdapter(db),
			});
			const scopedOrm = orm.withSchema('tenant_123');

			expect(typeof scopedOrm.listAncestors).toBe('function');
		});

		it('should have listDescendants on tenant ORM', () => {
			const db = createTestDb();
			const orm = createOrm({
				schema: categorySchema,
				adapter: createKyselyAdapter(db),
			});
			const scopedOrm = orm.withSchema('tenant_123');

			expect(typeof scopedOrm.listDescendants).toBe('function');
		});
	});
});
