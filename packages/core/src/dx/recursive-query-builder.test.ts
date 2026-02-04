/**
 * @module recursive-query-builder.test
 * Unit tests for RecursiveQueryBuilder (DX-005)
 *
 * NOTE: These tests only verify intent-building logic (core package).
 * SQL generation tests are in adapter-pgsql/src/__tests__/
 */

import { eq, ref, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createRecursiveBuilder } from './recursive-query-builder.js';
import { createMockAdapter } from './test-utils.js';

// ============================================================================
// Test Schema - Role Hierarchy with Edge Table
// ============================================================================

const roleHierarchyModel = schema({
	roles: {
		id: { type: 'uuid', primaryKey: true },
		name: 'string',
	},
	roleEdges: {
		id: { type: 'uuid', primaryKey: true },
		fromRoleId: ref('roles', { as: 'fromRole', inverse: 'outgoingEdges' }),
		toRoleId: ref('roles', { as: 'toRole', inverse: 'incomingEdges' }),
	},
	permissions: {
		id: { type: 'uuid', primaryKey: true },
		name: 'string',
	},
	rolePermissions: {
		id: { type: 'uuid', primaryKey: true },
		roleId: ref('roles', { as: 'role', inverse: 'rolePermissions' }),
		permissionId: ref('permissions', {
			as: 'permission',
			inverse: 'rolePermissions',
		}),
	},
}).model;

// ============================================================================
// Test Schema - Category Hierarchy (Adjacency List)
// ============================================================================

const categoryModel = schema({
	categories: {
		id: { type: 'uuid', primaryKey: true },
		name: 'string',
		parentId: ref('categories', {
			nullable: true,
			as: 'parent',
			inverse: 'children',
			roles: { parent: 'parent', children: 'children' },
		}),
	},
}).model;

// ============================================================================
// Validation Tests
// ============================================================================

describe('RecursiveQueryBuilder', () => {
	describe('validation', () => {
		it('should throw if from() not called', () => {
			const adapter = createMockAdapter();
			const builder = createRecursiveBuilder(
				roleHierarchyModel,
				adapter,
				'role_tree',
			);

			builder
				.nodeId('id')
				.traverseVia('roleEdges', { from: 'from_role_id', to: 'to_role_id' })
				.maxDepth(10);

			expect(() => builder.buildIntent()).toThrow('from() must be called');
		});

		it('should throw if nodeId() not called', () => {
			const adapter = createMockAdapter();
			const builder = createRecursiveBuilder(
				roleHierarchyModel,
				adapter,
				'role_tree',
			);

			builder
				.from('roles')
				.traverseVia('roleEdges', { from: 'from_role_id', to: 'to_role_id' })
				.maxDepth(10);

			expect(() => builder.buildIntent()).toThrow('nodeId() must be called');
		});

		it('should throw if traverseVia() not called', () => {
			const adapter = createMockAdapter();
			const builder = createRecursiveBuilder(
				roleHierarchyModel,
				adapter,
				'role_tree',
			);

			builder.from('roles').nodeId('id').maxDepth(10);

			expect(() => builder.buildIntent()).toThrow(
				'traverseVia() must be called',
			);
		});

		it('should throw if maxDepth() not called', () => {
			const adapter = createMockAdapter();
			const builder = createRecursiveBuilder(
				roleHierarchyModel,
				adapter,
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
			const adapter = createMockAdapter();
			const builder = createRecursiveBuilder(
				roleHierarchyModel,
				adapter,
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
			const adapter = createMockAdapter();

			// Test 'in' direction
			const builderIn = createRecursiveBuilder(
				roleHierarchyModel,
				adapter,
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
				adapter,
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
			const adapter = createMockAdapter();
			const builder = createRecursiveBuilder(
				roleHierarchyModel,
				adapter,
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
			const adapter = createMockAdapter();
			const builder = createRecursiveBuilder(
				categoryModel,
				adapter,
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
			const adapter = createMockAdapter();
			const builder = createRecursiveBuilder(
				categoryModel,
				adapter,
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
			const adapter = createMockAdapter();
			const builder = createRecursiveBuilder(
				roleHierarchyModel,
				adapter,
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
			expect(intent.emit?.joinWith?.[0]!.table).toBe('rolePermissions');
			expect(intent.emit?.joinWith?.[0]!.type).toBe('inner');
		});

		it('should support leftJoin()', () => {
			const adapter = createMockAdapter();
			const builder = createRecursiveBuilder(
				roleHierarchyModel,
				adapter,
				'role_tree',
			);

			const intent = builder
				.from('roles')
				.nodeId('id')
				.traverseVia('roleEdges', { from: 'from_role_id', to: 'to_role_id' })
				.maxDepth(10)
				.leftJoin('rolePermissions', 'id', 'role_id')
				.buildIntent();

			expect(intent.emit?.joinWith?.[0]!.type).toBe('left');
		});

		it('should support multiple joins', () => {
			const adapter = createMockAdapter();
			const builder = createRecursiveBuilder(
				roleHierarchyModel,
				adapter,
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
			const adapter = createMockAdapter();
			const builder = createRecursiveBuilder(
				roleHierarchyModel,
				adapter,
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
			const adapter = createMockAdapter();
			const builder = createRecursiveBuilder(
				roleHierarchyModel,
				adapter,
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
			const adapter = createMockAdapter();
			const builder = createRecursiveBuilder(
				roleHierarchyModel,
				adapter,
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
			const adapter = createMockAdapter();
			const builder = createRecursiveBuilder(
				roleHierarchyModel,
				adapter,
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
			const adapter = createMockAdapter();
			const builder = createRecursiveBuilder(
				roleHierarchyModel,
				adapter,
				'role_tree',
			);

			const intent = builder
				.from('roles')
				.nodeId('id')
				.traverseVia('roleEdges', { from: 'from_role_id', to: 'to_role_id' })
				.maxDepth(10)
				.trackPath({ alias: 'path_ids', strategy: 'array' })
				.buildIntent();

			if (typeof intent.track?.path !== 'string' && intent.track?.path) {
				expect((intent.track!.path as any).alias).toBe('path_ids');
				expect(intent.track.path.strategy).toBe('array');
			}
		});

		it('should support dedupeWith()', () => {
			const adapter = createMockAdapter();
			const builder = createRecursiveBuilder(
				roleHierarchyModel,
				adapter,
				'role_tree',
			);

			const intent = builder
				.from('roles')
				.nodeId('id')
				.traverseVia('roleEdges', { from: 'from_role_id', to: 'to_role_id' })
				.maxDepth(10)
				.dedupeWith('none')
				.buildIntent();

			expect(intent.dedupe).toBe('none');
		});
	});

	// ============================================================================
	// NOTE: dump() and SQL generation tests are in adapter-pgsql
	// See: packages/adapter-pgsql/src/__tests__/
	// ============================================================================

	// ============================================================================
	// DX-009: Intuitive Alias Tests
	// ============================================================================

	describe('Intuitive Aliases (DX-009)', () => {
		it('startingFrom() should be alias for nodeId()', () => {
			const adapter = createMockAdapter();

			// Using old API
			const intentOld = createRecursiveBuilder(categoryModel, adapter, 'tree1')
				.from('categories')
				.nodeId('id')
				.where(eq('id', 1))
				.traverseVia('categories', { parentId: 'parentId' })
				.maxDepth(5)
				.buildIntent();

			// Using new alias API
			const intentNew = createRecursiveBuilder(categoryModel, adapter, 'tree2')
				.from('categories')
				.startingFrom('id')
				.where(eq('id', 1))
				.traverseVia('categories', { parentId: 'parentId' })
				.maxDepth(5)
				.buildIntent();

			// Should produce equivalent intents
			expect(intentOld.start.nodeIdExpr).toEqual(intentNew.start.nodeIdExpr);
		});

		it('following() should be alias for traverseVia()', () => {
			const adapter = createMockAdapter();

			// Using old API
			const intentOld = createRecursiveBuilder(categoryModel, adapter, 'tree1')
				.from('categories')
				.nodeId('id')
				.where(eq('id', 1))
				.traverseVia('categories', { parentId: 'parentId' })
				.maxDepth(5)
				.buildIntent();

			// Using new alias API
			const intentNew = createRecursiveBuilder(categoryModel, adapter, 'tree2')
				.from('categories')
				.nodeId('id')
				.where(eq('id', 1))
				.following('categories', { parentId: 'parentId' })
				.maxDepth(5)
				.buildIntent();

			// Should have equivalent traversal config
			expect(intentOld.traversal).toEqual(intentNew.traversal);
		});

		it('upToDepth() should be alias for maxDepth()', () => {
			const adapter = createMockAdapter();

			// Using old API
			const intentOld = createRecursiveBuilder(categoryModel, adapter, 'tree1')
				.from('categories')
				.nodeId('id')
				.where(eq('id', 1))
				.traverseVia('categories', { parentId: 'parentId' })
				.maxDepth(7)
				.buildIntent();

			// Using new alias API
			const intentNew = createRecursiveBuilder(categoryModel, adapter, 'tree2')
				.from('categories')
				.nodeId('id')
				.where(eq('id', 1))
				.traverseVia('categories', { parentId: 'parentId' })
				.upToDepth(7)
				.buildIntent();

			// Should have same maxDepth
			expect(intentOld.maxDepth).toEqual(intentNew.maxDepth);
			expect(intentNew.maxDepth).toBe(7);
		});

		it('should support full fluent chain with new aliases', () => {
			const adapter = createMockAdapter();

			const intent = createRecursiveBuilder(
				categoryModel,
				adapter,
				'category_tree',
			)
				.from('categories')
				.startingFrom('id')
				.where(eq('id', 42))
				.following('categories', {
					parentId: 'parentId',
					direction: 'descendants',
				})
				.upToDepth(10)
				.buildIntent();

			expect(intent.start.nodeIdExpr).toEqual({ kind: 'column', name: 'id' });
			expect(intent.maxDepth).toBe(10);
			expect(intent.traversal?.kind).toBe('adjacency');
		});
	});
});
