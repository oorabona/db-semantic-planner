/**
 * @module recursive-query-builder.test
 * Unit tests for RecursiveQueryBuilder (DX-005)
 */

import { belongsTo, defineSchema, hasMany } from '@db-semantic-planner/core';
import {
	DummyDriver,
	Kysely,
	PostgresAdapter,
	PostgresIntrospector,
	PostgresQueryCompiler,
} from 'kysely';
import { describe, expect, it } from 'vitest';
import { eq } from './filters.js';
import { createRecursiveBuilder } from './recursive-query-builder.js';

// ============================================================================
// Test Schema - Role Hierarchy with Edge Table
// ============================================================================

const roleHierarchyModel = defineSchema({
	roles: {
		id: 'uuid',
		name: 'string',
	},
	roleEdges: {
		id: 'uuid',
		fromRoleId: 'uuid',
		toRoleId: 'uuid',
	},
	permissions: {
		id: 'uuid',
		name: 'string',
	},
	rolePermissions: {
		id: 'uuid',
		roleId: 'uuid',
		permissionId: 'uuid',
	},
})
	.relations({
		roleEdges: {
			fromRole: belongsTo('roles', { foreignKey: 'fromRoleId' }),
			toRole: belongsTo('roles', { foreignKey: 'toRoleId' }),
		},
		roles: {
			outgoingEdges: hasMany('roleEdges', { foreignKey: 'fromRoleId' }),
			incomingEdges: hasMany('roleEdges', { foreignKey: 'toRoleId' }),
			rolePermissions: hasMany('rolePermissions', { foreignKey: 'roleId' }),
		},
		rolePermissions: {
			role: belongsTo('roles', { foreignKey: 'roleId' }),
			permission: belongsTo('permissions', { foreignKey: 'permissionId' }),
		},
		permissions: {
			rolePermissions: hasMany('rolePermissions', {
				foreignKey: 'permissionId',
			}),
		},
	})
	.build();

// ============================================================================
// Test Schema - Category Hierarchy (Adjacency List)
// ============================================================================

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

// ============================================================================
// Helper - Create PostgreSQL Kysely instance
// ============================================================================

function createTestDb() {
	return new Kysely({
		dialect: {
			createAdapter: () => new PostgresAdapter(),
			createDriver: () => new DummyDriver(),
			createIntrospector: (db) => new PostgresIntrospector(db),
			createQueryCompiler: () => new PostgresQueryCompiler(),
		},
	});
}

// ============================================================================
// Validation Tests
// ============================================================================

describe('RecursiveQueryBuilder', () => {
	describe('validation', () => {
		it('should throw if from() not called', () => {
			const db = createTestDb();
			const builder = createRecursiveBuilder(
				roleHierarchyModel,
				db,
				'role_tree',
			);

			builder
				.nodeId('id')
				.traverseVia('roleEdges', { from: 'from_role_id', to: 'to_role_id' })
				.maxDepth(10);

			expect(() => builder.buildIntent()).toThrow('from() must be called');
		});

		it('should throw if nodeId() not called', () => {
			const db = createTestDb();
			const builder = createRecursiveBuilder(
				roleHierarchyModel,
				db,
				'role_tree',
			);

			builder
				.from('roles')
				.traverseVia('roleEdges', { from: 'from_role_id', to: 'to_role_id' })
				.maxDepth(10);

			expect(() => builder.buildIntent()).toThrow('nodeId() must be called');
		});

		it('should throw if traverseVia() not called', () => {
			const db = createTestDb();
			const builder = createRecursiveBuilder(
				roleHierarchyModel,
				db,
				'role_tree',
			);

			builder.from('roles').nodeId('id').maxDepth(10);

			expect(() => builder.buildIntent()).toThrow(
				'traverseVia() must be called',
			);
		});

		it('should throw if maxDepth() not called', () => {
			const db = createTestDb();
			const builder = createRecursiveBuilder(
				roleHierarchyModel,
				db,
				'role_tree',
			);

			builder
				.from('roles')
				.nodeId('id')
				.traverseVia('roleEdges', { from: 'from_role_id', to: 'to_role_id' });

			expect(() => builder.buildIntent()).toThrow('maxDepth() must be called');
		});
	});

	// ============================================================================
	// Edge-Table Traversal Tests
	// ============================================================================

	describe('edge-table traversal', () => {
		it('should build intent with edge-table traversal', () => {
			const db = createTestDb();
			const builder = createRecursiveBuilder(
				roleHierarchyModel,
				db,
				'role_tree',
			);

			const intent = builder
				.from('roles')
				.nodeId('id')
				.where(eq('id', 'user-role-123'))
				.traverseVia('roleEdges', { from: 'from_role_id', to: 'to_role_id' })
				.maxDepth(10)
				.buildIntent();

			expect(intent.type).toBe('recursive');
			expect(intent.cteName).toBe('role_tree');
			expect(intent.start.from).toBe('roles');
			expect(intent.start.nodeIdExpr).toEqual({ kind: 'column', name: 'id' });
			expect(intent.maxDepth).toBe(10);
			expect(intent.traversal.kind).toBe('edge-table');
			if (intent.traversal.kind === 'edge-table') {
				expect(intent.traversal.edgeTable).toBe('roleEdges');
				expect(intent.traversal.edgeFrom).toBe('from_role_id');
				expect(intent.traversal.edgeTo).toBe('to_role_id');
				expect(intent.traversal.direction).toBe('out');
			}
		});

		it('should support edge-table direction options', () => {
			const db = createTestDb();

			// Test 'in' direction
			const builderIn = createRecursiveBuilder(
				roleHierarchyModel,
				db,
				'role_tree',
			);
			const intentIn = builderIn
				.from('roles')
				.nodeId('id')
				.traverseVia('roleEdges', {
					from: 'from_role_id',
					to: 'to_role_id',
					direction: 'in',
				})
				.maxDepth(10)
				.buildIntent();

			expect(intentIn.traversal.kind).toBe('edge-table');
			if (intentIn.traversal.kind === 'edge-table') {
				expect(intentIn.traversal.direction).toBe('in');
			}

			// Test 'both' direction
			const builderBoth = createRecursiveBuilder(
				roleHierarchyModel,
				db,
				'role_tree',
			);
			const intentBoth = builderBoth
				.from('roles')
				.nodeId('id')
				.traverseVia('roleEdges', {
					from: 'from_role_id',
					to: 'to_role_id',
					direction: 'both',
				})
				.maxDepth(10)
				.buildIntent();

			expect(intentBoth.traversal.kind).toBe('edge-table');
			if (intentBoth.traversal.kind === 'edge-table') {
				expect(intentBoth.traversal.direction).toBe('both');
			}
		});

		it('should support storageHint for edge-table', () => {
			const db = createTestDb();
			const builder = createRecursiveBuilder(
				roleHierarchyModel,
				db,
				'role_tree',
			);

			const intent = builder
				.from('roles')
				.nodeId('id')
				.traverseVia('roleEdges', {
					from: 'from_role_id',
					to: 'to_role_id',
					direction: 'both',
					storageHint: 'directed-only',
				})
				.maxDepth(10)
				.buildIntent();

			expect(intent.traversal.kind).toBe('edge-table');
			if (intent.traversal.kind === 'edge-table') {
				expect(intent.traversal.edgeStorageHint).toBe('directed-only');
			}
		});
	});

	// ============================================================================
	// Adjacency Traversal Tests
	// ============================================================================

	describe('adjacency traversal', () => {
		it('should build intent with adjacency traversal (descendants)', () => {
			const db = createTestDb();
			const builder = createRecursiveBuilder(
				categoryModel,
				db,
				'category_tree',
			);

			const intent = builder
				.from('categories')
				.nodeId('id')
				.where(eq('id', 'root-cat-123'))
				.traverseVia('categories', { parentId: 'parent_id' })
				.maxDepth(5)
				.buildIntent();

			expect(intent.traversal.kind).toBe('adjacency');
			if (intent.traversal.kind === 'adjacency') {
				expect(intent.traversal.nodeTable).toBe('categories');
				expect(intent.traversal.parentId).toBe('parent_id');
				expect(intent.traversal.direction).toBe('descendants');
			}
		});

		it('should support ancestors direction', () => {
			const db = createTestDb();
			const builder = createRecursiveBuilder(
				categoryModel,
				db,
				'category_tree',
			);

			const intent = builder
				.from('categories')
				.nodeId('id')
				.traverseVia('categories', {
					parentId: 'parent_id',
					direction: 'ancestors',
				})
				.maxDepth(5)
				.buildIntent();

			expect(intent.traversal.kind).toBe('adjacency');
			if (intent.traversal.kind === 'adjacency') {
				expect(intent.traversal.direction).toBe('ancestors');
			}
		});
	});

	// ============================================================================
	// Emit Configuration Tests
	// ============================================================================

	describe('emit configuration', () => {
		it('should support join()', () => {
			const db = createTestDb();
			const builder = createRecursiveBuilder(
				roleHierarchyModel,
				db,
				'role_tree',
			);

			const intent = builder
				.from('roles')
				.nodeId('id')
				.traverseVia('roleEdges', { from: 'from_role_id', to: 'to_role_id' })
				.maxDepth(10)
				.join('rolePermissions', 'id', 'role_id')
				.buildIntent();

			expect(intent.emit?.joinWith).toBeDefined();
			expect(intent.emit?.joinWith?.length).toBe(1);
			expect(intent.emit?.joinWith?.[0].table).toBe('rolePermissions');
			expect(intent.emit?.joinWith?.[0].type).toBe('inner');
		});

		it('should support leftJoin()', () => {
			const db = createTestDb();
			const builder = createRecursiveBuilder(
				roleHierarchyModel,
				db,
				'role_tree',
			);

			const intent = builder
				.from('roles')
				.nodeId('id')
				.traverseVia('roleEdges', { from: 'from_role_id', to: 'to_role_id' })
				.maxDepth(10)
				.leftJoin('rolePermissions', 'id', 'role_id')
				.buildIntent();

			expect(intent.emit?.joinWith?.[0].type).toBe('left');
		});

		it('should support multiple joins', () => {
			const db = createTestDb();
			const builder = createRecursiveBuilder(
				roleHierarchyModel,
				db,
				'role_tree',
			);

			const intent = builder
				.from('roles')
				.nodeId('id')
				.traverseVia('roleEdges', { from: 'from_role_id', to: 'to_role_id' })
				.maxDepth(10)
				.join('rolePermissions', 'id', 'role_id')
				.join('permissions', 'permission_id', 'id')
				.buildIntent();

			expect(intent.emit?.joinWith?.length).toBe(2);
		});

		it('should support columns()', () => {
			const db = createTestDb();
			const builder = createRecursiveBuilder(
				roleHierarchyModel,
				db,
				'role_tree',
			);

			const intent = builder
				.from('roles')
				.nodeId('id')
				.traverseVia('roleEdges', { from: 'from_role_id', to: 'to_role_id' })
				.maxDepth(10)
				.columns(['id', 'name'])
				.buildIntent();

			expect(intent.emit?.select).toEqual(['id', 'name']);
		});

		it('should support distinct()', () => {
			const db = createTestDb();
			const builder = createRecursiveBuilder(
				roleHierarchyModel,
				db,
				'role_tree',
			);

			const intent = builder
				.from('roles')
				.nodeId('id')
				.traverseVia('roleEdges', { from: 'from_role_id', to: 'to_role_id' })
				.maxDepth(10)
				.distinct()
				.buildIntent();

			expect(intent.emit?.distinct).toBe(true);
		});

		it('should support emitFilter()', () => {
			const db = createTestDb();
			const builder = createRecursiveBuilder(
				roleHierarchyModel,
				db,
				'role_tree',
			);

			const intent = builder
				.from('roles')
				.nodeId('id')
				.traverseVia('roleEdges', { from: 'from_role_id', to: 'to_role_id' })
				.maxDepth(10)
				.emitFilter(eq('active', true))
				.buildIntent();

			expect(intent.emit?.where).toBeDefined();
		});
	});

	// ============================================================================
	// Tracking Tests
	// ============================================================================

	describe('tracking options', () => {
		it('should support trackPath()', () => {
			const db = createTestDb();
			const builder = createRecursiveBuilder(
				roleHierarchyModel,
				db,
				'role_tree',
			);

			const intent = builder
				.from('roles')
				.nodeId('id')
				.traverseVia('roleEdges', { from: 'from_role_id', to: 'to_role_id' })
				.maxDepth(10)
				.trackPath()
				.buildIntent();

			expect(intent.track?.path).toBeDefined();
		});

		it('should support trackPath() with options', () => {
			const db = createTestDb();
			const builder = createRecursiveBuilder(
				roleHierarchyModel,
				db,
				'role_tree',
			);

			const intent = builder
				.from('roles')
				.nodeId('id')
				.traverseVia('roleEdges', { from: 'from_role_id', to: 'to_role_id' })
				.maxDepth(10)
				.trackPath({ alias: 'path_ids', strategy: 'array' })
				.buildIntent();

			expect(intent.track?.path?.alias).toBe('path_ids');
			expect(intent.track?.path?.strategy).toBe('array');
		});

		it('should support dedupeWith()', () => {
			const db = createTestDb();
			const builder = createRecursiveBuilder(
				roleHierarchyModel,
				db,
				'role_tree',
			);

			const intent = builder
				.from('roles')
				.nodeId('id')
				.traverseVia('roleEdges', { from: 'from_role_id', to: 'to_role_id' })
				.maxDepth(10)
				.dedupeWith('skip-visited')
				.buildIntent();

			expect(intent.dedupe).toBe('skip-visited');
		});
	});

	// ============================================================================
	// dump() Tests
	// ============================================================================

	describe('dump()', () => {
		it('should produce valid SQL', () => {
			const db = createTestDb();
			const builder = createRecursiveBuilder(
				roleHierarchyModel,
				db,
				'role_tree',
			);

			const { sql, parameters } = builder
				.from('roles')
				.nodeId('id')
				.where(eq('id', 'user-role-123'))
				.traverseVia('roleEdges', { from: 'from_role_id', to: 'to_role_id' })
				.maxDepth(10)
				.dump();

			expect(sql.toLowerCase()).toContain('with recursive');
			expect(sql).toContain('role_tree');
			expect(parameters.length).toBeGreaterThan(0);
		});

		it('should include JOIN in emit SQL', () => {
			const db = createTestDb();
			const builder = createRecursiveBuilder(
				roleHierarchyModel,
				db,
				'role_tree',
			);

			const { sql } = builder
				.from('roles')
				.nodeId('id')
				.traverseVia('roleEdges', { from: 'from_role_id', to: 'to_role_id' })
				.maxDepth(10)
				.join('rolePermissions', 'id', 'role_id')
				.dump();

			expect(sql.toLowerCase()).toContain('join');
			// The table name in SQL is 'rolepermissions' (camelCase preserved by Kysely)
			expect(sql.toLowerCase()).toContain('rolepermissions');
		});
	});

	// ============================================================================
	// Method Chaining Tests
	// ============================================================================

	describe('method chaining', () => {
		it('should support full fluent chain', () => {
			const db = createTestDb();

			const { sql } = createRecursiveBuilder(
				roleHierarchyModel,
				db,
				'effective_permissions',
			)
				.from('roles')
				.where(eq('id', 'user-role'))
				.nodeId('id')
				.traverseVia('roleEdges', { from: 'from_role_id', to: 'to_role_id' })
				.maxDepth(10)
				.trackPath({ alias: 'role_path' })
				.dedupeWith('skip-visited')
				.join('rolePermissions', 'id', 'role_id')
				.join('permissions', 'permission_id', 'id')
				.columns(['id', 'name'])
				.distinct()
				.dump();

			expect(sql.toLowerCase()).toContain('with recursive');
			expect(sql.toLowerCase()).toContain('effective_permissions');
			expect(sql.toLowerCase()).toContain('distinct');
		});
	});

	// ============================================================================
	// Factory Function Tests
	// ============================================================================

	describe('createRecursiveBuilder', () => {
		it('should create builder with schema name', () => {
			const db = createTestDb();

			const builder = createRecursiveBuilder(
				roleHierarchyModel,
				db,
				'role_tree',
				'tenant_123',
			);
			const { sql } = builder
				.from('roles')
				.nodeId('id')
				.traverseVia('roleEdges', { from: 'from_role_id', to: 'to_role_id' })
				.maxDepth(10)
				.dump();

			expect(sql).toContain('tenant_123');
		});
	});

	// ============================================================================
	// DX-009: Intuitive Alias Tests
	// ============================================================================

	describe('Intuitive Aliases (DX-009)', () => {
		it('startingFrom() should be alias for nodeId()', () => {
			const db = createTestDb();

			// Using old API
			const builderOld = createRecursiveBuilder(categoryModel, db, 'tree1')
				.from('categories')
				.nodeId('id')
				.where(eq('id', 1))
				.traverseVia('categories', { parentId: 'parentId' })
				.maxDepth(5);

			// Using new alias API
			const builderNew = createRecursiveBuilder(categoryModel, db, 'tree2')
				.from('categories')
				.startingFrom('id')
				.where(eq('id', 1))
				.traverseVia('categories', { parentId: 'parentId' })
				.maxDepth(5);

			const dumpOld = builderOld.dump();
			const dumpNew = builderNew.dump();

			// Should produce equivalent SQL (same structure)
			expect(dumpOld.intent.nodeId).toEqual(dumpNew.intent.nodeId);
		});

		it('following() should be alias for traverseVia()', () => {
			const db = createTestDb();

			// Using old API
			const builderOld = createRecursiveBuilder(categoryModel, db, 'tree1')
				.from('categories')
				.nodeId('id')
				.where(eq('id', 1))
				.traverseVia('categories', { parentId: 'parentId' })
				.maxDepth(5);

			// Using new alias API
			const builderNew = createRecursiveBuilder(categoryModel, db, 'tree2')
				.from('categories')
				.nodeId('id')
				.where(eq('id', 1))
				.following('categories', { parentId: 'parentId' })
				.maxDepth(5);

			const dumpOld = builderOld.dump();
			const dumpNew = builderNew.dump();

			// Should have equivalent traversal config
			expect(dumpOld.intent.traversal).toEqual(dumpNew.intent.traversal);
		});

		it('upToDepth() should be alias for maxDepth()', () => {
			const db = createTestDb();

			// Using old API
			const builderOld = createRecursiveBuilder(categoryModel, db, 'tree1')
				.from('categories')
				.nodeId('id')
				.where(eq('id', 1))
				.traverseVia('categories', { parentId: 'parentId' })
				.maxDepth(7);

			// Using new alias API
			const builderNew = createRecursiveBuilder(categoryModel, db, 'tree2')
				.from('categories')
				.nodeId('id')
				.where(eq('id', 1))
				.traverseVia('categories', { parentId: 'parentId' })
				.upToDepth(7);

			const dumpOld = builderOld.dump();
			const dumpNew = builderNew.dump();

			// Should have same maxDepth
			expect(dumpOld.intent.maxDepth).toEqual(dumpNew.intent.maxDepth);
			expect(dumpNew.intent.maxDepth).toBe(7);
		});

		it('should support full fluent chain with new aliases', () => {
			const db = createTestDb();

			const builder = createRecursiveBuilder(categoryModel, db, 'category_tree')
				.from('categories')
				.startingFrom('id')
				.where(eq('id', 42))
				.following('categories', {
					parentId: 'parentId',
					direction: 'descendants',
				})
				.upToDepth(10);

			const { sql, intent } = builder.dump();

			expect(intent.start.nodeIdExpr).toEqual({ kind: 'column', name: 'id' });
			expect(intent.maxDepth).toBe(10);
			expect(intent.traversal?.kind).toBe('adjacency');
			expect(sql.toLowerCase()).toContain('with recursive');
		});
	});
});
