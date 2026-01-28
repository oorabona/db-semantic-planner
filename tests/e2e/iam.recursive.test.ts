/**
 * E2E-003: IAM/RBAC Recursive CTE Validation
 *
 * Tests recursive CTE queries for:
 * - Effective permissions via role hierarchy
 * - Role hierarchy traversal with depth/path tracking
 * - Separation of Duty (SoD) detection
 *
 * Uses edge-table traversal pattern (role_edges junction table).
 */

import { compileRecursive, getCapabilities } from '@dbsp/adapter-kysely';
import { planRecursive, type RecursiveIntent } from '@dbsp/core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	createIamSchema,
	createSchema,
	dropIamSchema,
	dropSchema,
	getTestDb,
	iamModel,
	iamTestData,
	seedIamData,
	shouldSkipE2E,
} from './testkit/index.js';

const IAM_SCHEMA = 'iam_test';

describe.skipIf(shouldSkipE2E())('E2E-003: IAM/RBAC Recursive CTE', () => {
	beforeAll(async () => {
		const db = await getTestDb();
		await dropSchema(IAM_SCHEMA);
		await createSchema(IAM_SCHEMA);
		await createIamSchema(db, IAM_SCHEMA);
		await seedIamData(db, IAM_SCHEMA);
	});

	afterAll(async () => {
		const db = await getTestDb();
		await dropIamSchema(db, IAM_SCHEMA);
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// EFFECTIVE PERMISSIONS TESTS
	// ═══════════════════════════════════════════════════════════════════════════

	describe('Effective Permissions via Role Hierarchy', () => {
		it('should compute effective permissions for admin (inherits manager + employee + auditor)', async () => {
			const db = await getTestDb();

			// Step 1: Build recursive intent to traverse role hierarchy from admin
			const roleHierarchyIntent: RecursiveIntent = {
				type: 'recursive',
				cteName: 'role_tree',
				start: {
					from: 'roles',
					nodeIdExpr: { kind: 'column', name: 'id' },
					where: {
						kind: 'comparison',
						field: 'name',
						operator: 'eq',
						value: 'admin',
					},
					select: ['name'],
				},
				traversal: {
					kind: 'edge-table',
					nodeTable: 'roles',
					edgeTable: 'role_edges',
					nodeId: 'id',
					edgeFrom: 'parentRoleId',
					edgeTo: 'childRoleId',
					direction: 'out', // Traverse to children (inherited roles)
				},
				track: {
					depth: { as: 'depth' },
				},
				maxDepth: 10,
				dedupe: 'final',
			};

			// Plan and compile the recursive CTE
			const report = planRecursive(roleHierarchyIntent, iamModel);
			const compiled = compileRecursive(report, iamModel, db, IAM_SCHEMA);

			// Execute to get all roles in hierarchy
			const roleResult = await db.executeQuery<{
				id: number;
				name: string;
				depth: number;
			}>(compiled);

			// Extract role IDs from hierarchy
			const roleIds = roleResult.rows.map((r) => r.id);

			// Step 2: Get all permissions for these roles
			await sql`SET search_path TO ${sql.ref(IAM_SCHEMA)}`.execute(db);

			const permResult = await sql<{ permissionName: string }>`
				SELECT DISTINCT p.name as permission_name
				FROM role_permissions rp
				JOIN permissions p ON p.id = rp.permission_id
				WHERE rp.role_id IN (${sql.join(roleIds.map((id) => sql.lit(id)))})
				ORDER BY p.name
			`.execute(db);

			await sql`SET search_path TO public`.execute(db);

			const permissions = permResult.rows.map((r) => r.permissionName);

			// Verify: admin should have all inherited permissions
			expect(permissions).toContain('users:delete'); // admin's own
			expect(permissions).toContain('users:edit'); // from manager
			expect(permissions).toContain('users:read'); // from employee
			expect(permissions).toContain('reports:view'); // from auditor
			expect(permissions).toContain('reports:export'); // from auditor

			// Should match expected effective permissions
			expect(permissions.sort()).toEqual(
				iamTestData.effectivePermissions.alice.sort(),
			);
		});

		it('should deduplicate permissions from multiple inheritance paths', async () => {
			const db = await getTestDb();

			// Bob has manager + auditor roles
			// Both manager and auditor eventually lead to different permission sets
			// This tests that we don't get duplicates

			const bobRoleIds = [
				iamTestData.roles.manager.id,
				iamTestData.roles.auditor.id,
			];

			// For each of Bob's direct roles, traverse the hierarchy
			const allRoleIds = new Set<number>();

			for (const startRoleId of bobRoleIds) {
				allRoleIds.add(startRoleId);

				const intent: RecursiveIntent = {
					type: 'recursive',
					cteName: 'role_tree',
					start: {
						from: 'roles',
						nodeIdExpr: { kind: 'column', name: 'id' },
						where: {
							kind: 'comparison',
							field: 'id',
							operator: 'eq',
							value: startRoleId,
						},
					},
					traversal: {
						kind: 'edge-table',
						nodeTable: 'roles',
						edgeTable: 'role_edges',
						nodeId: 'id',
						edgeFrom: 'parentRoleId',
						edgeTo: 'childRoleId',
						direction: 'out',
					},
					maxDepth: 10,
					dedupe: 'final',
				};

				const report = planRecursive(intent, iamModel);
				const compiled = compileRecursive(report, iamModel, db, IAM_SCHEMA);

				const result = await db.executeQuery<{ id: number }>(compiled);

				for (const row of result.rows) {
					allRoleIds.add(row.id);
				}
			}

			// Get permissions for all roles
			await sql`SET search_path TO ${sql.ref(IAM_SCHEMA)}`.execute(db);

			const permResult = await sql<{ permissionName: string }>`
				SELECT DISTINCT p.name as permission_name
				FROM role_permissions rp
				JOIN permissions p ON p.id = rp.permission_id
				WHERE rp.role_id IN (${sql.join([...allRoleIds].map((id) => sql.lit(id)))})
				ORDER BY p.name
			`.execute(db);

			await sql`SET search_path TO public`.execute(db);

			const permissions = permResult.rows.map((r) => r.permissionName);

			// Each permission should appear exactly once
			const uniquePermissions = [...new Set(permissions)];
			expect(permissions.length).toBe(uniquePermissions.length);

			// Verify expected permissions for Bob
			expect(permissions.sort()).toEqual(
				iamTestData.effectivePermissions.bob.sort(),
			);
		});

		it('should return empty permissions for user with no roles', async () => {
			const db = await getTestDb();

			// Dave has no roles
			await sql`SET search_path TO ${sql.ref(IAM_SCHEMA)}`.execute(db);

			const userRolesResult = await sql<{ roleId: number }>`
				SELECT role_id FROM user_roles WHERE user_id = ${iamTestData.users.dave.id}
			`.execute(db);

			await sql`SET search_path TO public`.execute(db);

			// Dave should have no roles
			expect(userRolesResult.rows).toHaveLength(0);

			// Therefore no permissions
			const effectivePermissions: string[] = [];
			expect(effectivePermissions).toEqual(
				iamTestData.effectivePermissions.dave,
			);
		});
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// ROLE HIERARCHY TRAVERSAL TESTS
	// ═══════════════════════════════════════════════════════════════════════════

	describe('Role Hierarchy Traversal', () => {
		it('should traverse descendants with depth tracking', async () => {
			const db = await getTestDb();

			// Start from admin, traverse to all descendants
			const intent: RecursiveIntent = {
				type: 'recursive',
				cteName: 'role_descendants',
				start: {
					from: 'roles',
					nodeIdExpr: { kind: 'column', name: 'id' },
					where: {
						kind: 'comparison',
						field: 'name',
						operator: 'eq',
						value: 'admin',
					},
					select: ['name'],
				},
				traversal: {
					kind: 'edge-table',
					nodeTable: 'roles',
					edgeTable: 'role_edges',
					nodeId: 'id',
					edgeFrom: 'parentRoleId',
					edgeTo: 'childRoleId',
					direction: 'out',
				},
				track: {
					depth: { as: 'depth' },
				},
				maxDepth: 10,
				dedupe: 'final',
			};

			const report = planRecursive(intent, iamModel);
			const compiled = compileRecursive(report, iamModel, db, IAM_SCHEMA);

			const result = await db.executeQuery<{
				id: number;
				name: string;
				depth: number;
			}>(compiled);

			// Filter out the root node (admin itself at depth 0)
			const descendants = result.rows.filter((r) => r.depth > 0);

			// Verify descendants
			expect(descendants).toHaveLength(3); // manager, employee, auditor

			// Check depth values
			const managerRow = descendants.find((r) => r.name === 'manager');
			const employeeRow = descendants.find((r) => r.name === 'employee');
			const auditorRow = descendants.find((r) => r.name === 'auditor');

			expect(managerRow?.depth).toBe(1);
			expect(employeeRow?.depth).toBe(2);
			expect(auditorRow?.depth).toBe(1);
		});

		it('should traverse descendants with path tracking', async () => {
			const db = await getTestDb();
			const capabilities = getCapabilities(db);

			// Choose strategy based on dialect
			const pathStrategy = capabilities.supportsArrayType ? 'array' : 'string';

			const intent: RecursiveIntent = {
				type: 'recursive',
				cteName: 'role_path',
				start: {
					from: 'roles',
					nodeIdExpr: { kind: 'column', name: 'id' },
					where: {
						kind: 'comparison',
						field: 'name',
						operator: 'eq',
						value: 'admin',
					},
					select: ['name'],
				},
				traversal: {
					kind: 'edge-table',
					nodeTable: 'roles',
					edgeTable: 'role_edges',
					nodeId: 'id',
					edgeFrom: 'parentRoleId',
					edgeTo: 'childRoleId',
					direction: 'out',
				},
				track: {
					depth: { as: 'depth' },
					path: {
						strategy: pathStrategy,
						separator: ' > ',
						as: 'path',
					},
				},
				maxDepth: 10,
				dedupe: 'final',
			};

			const report = planRecursive(intent, iamModel);
			const compiled = compileRecursive(report, iamModel, db, IAM_SCHEMA);

			const result = await db.executeQuery<{
				id: number;
				name: string;
				depth: number;
				path: unknown;
			}>(compiled);

			// Find employee row to check path
			const employeeRow = result.rows.find((r) => r.name === 'employee');
			expect(employeeRow).toBeDefined();
			expect(employeeRow?.depth).toBe(2);

			// Path should show the hierarchy
			// For array strategy: [adminId, managerId, employeeId]
			// For string strategy: "adminId > managerId > employeeId"
			if (pathStrategy === 'array') {
				expect(Array.isArray(employeeRow?.path)).toBe(true);
				expect((employeeRow?.path as number[]).length).toBe(3);
			} else {
				expect(typeof employeeRow?.path).toBe('string');
				expect((employeeRow?.path as string).split(' > ').length).toBe(3);
			}
		});

		it('should traverse ancestors (reverse direction)', async () => {
			const db = await getTestDb();

			// Start from employee, traverse to ancestors
			const intent: RecursiveIntent = {
				type: 'recursive',
				cteName: 'role_ancestors',
				start: {
					from: 'roles',
					nodeIdExpr: { kind: 'column', name: 'id' },
					where: {
						kind: 'comparison',
						field: 'name',
						operator: 'eq',
						value: 'employee',
					},
					select: ['name'],
				},
				traversal: {
					kind: 'edge-table',
					nodeTable: 'roles',
					edgeTable: 'role_edges',
					nodeId: 'id',
					edgeFrom: 'childRoleId', // Reverse: from child to parent
					edgeTo: 'parentRoleId',
					direction: 'out',
				},
				track: {
					depth: { as: 'depth' },
				},
				maxDepth: 10,
				dedupe: 'final',
			};

			const report = planRecursive(intent, iamModel);
			const compiled = compileRecursive(report, iamModel, db, IAM_SCHEMA);

			const result = await db.executeQuery<{
				id: number;
				name: string;
				depth: number;
			}>(compiled);

			// Filter out root (employee itself)
			const ancestors = result.rows.filter((r) => r.depth > 0);

			// employee -> manager -> admin
			expect(ancestors).toHaveLength(2);

			const names = ancestors.map((r) => r.name).sort();
			expect(names).toContain('manager');
			expect(names).toContain('admin');
		});
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// SEPARATION OF DUTY TESTS
	// ═══════════════════════════════════════════════════════════════════════════

	describe('Separation of Duty (SoD) Detection', () => {
		it('should detect SoD violation for charlie (approver + requester)', async () => {
			const db = await getTestDb();

			await sql`SET search_path TO ${sql.ref(IAM_SCHEMA)}`.execute(db);

			// Get Charlie's roles
			const userRolesResult = await sql<{ roleId: number; roleName: string }>`
				SELECT ur.role_id, r.name as role_name
				FROM user_roles ur
				JOIN roles r ON r.id = ur.role_id
				WHERE ur.user_id = ${iamTestData.users.charlie.id}
			`.execute(db);

			const charlieRoleIds = userRolesResult.rows.map((r) => r.roleId);

			// Check for SoD violations
			// A violation exists if user has both roles in any SoD rule
			const sodResult = await sql<{
				roleA: string;
				roleB: string;
				reason: string;
			}>`
				SELECT ra.name as role_a, rb.name as role_b, s.reason
				FROM sod_rules s
				JOIN roles ra ON ra.id = s.role_a_id
				JOIN roles rb ON rb.id = s.role_b_id
				WHERE s.role_a_id = ANY(${sql.raw(`ARRAY[${charlieRoleIds.join(',')}]`)})
				  AND s.role_b_id = ANY(${sql.raw(`ARRAY[${charlieRoleIds.join(',')}]`)})
			`.execute(db);

			await sql`SET search_path TO public`.execute(db);

			// Charlie should have a violation
			expect(sodResult.rows).toHaveLength(1);
			expect(sodResult.rows[0].roleA).toBe('approver');
			expect(sodResult.rows[0].roleB).toBe('requester');
			expect(sodResult.rows[0].reason).toContain('requester cannot approve');
		});

		it('should NOT detect SoD violation for alice (admin only)', async () => {
			const db = await getTestDb();

			await sql`SET search_path TO ${sql.ref(IAM_SCHEMA)}`.execute(db);

			// Get Alice's direct roles
			const userRolesResult = await sql<{ roleId: number }>`
				SELECT role_id FROM user_roles WHERE user_id = ${iamTestData.users.alice.id}
			`.execute(db);

			const aliceRoleIds = userRolesResult.rows.map((r) => r.roleId);

			// Check for SoD violations
			const sodResult = await sql<{ roleA: string; roleB: string }>`
				SELECT ra.name as role_a, rb.name as role_b
				FROM sod_rules s
				JOIN roles ra ON ra.id = s.role_a_id
				JOIN roles rb ON rb.id = s.role_b_id
				WHERE s.role_a_id = ANY(${sql.raw(`ARRAY[${aliceRoleIds.join(',')}]`)})
				  AND s.role_b_id = ANY(${sql.raw(`ARRAY[${aliceRoleIds.join(',')}]`)})
			`.execute(db);

			await sql`SET search_path TO public`.execute(db);

			// Alice should have no SoD violations
			expect(sodResult.rows).toHaveLength(0);
		});

		it('should NOT detect SoD violation for bob (manager + auditor)', async () => {
			const db = await getTestDb();

			await sql`SET search_path TO ${sql.ref(IAM_SCHEMA)}`.execute(db);

			// Get Bob's direct roles
			const userRolesResult = await sql<{ roleId: number }>`
				SELECT role_id FROM user_roles WHERE user_id = ${iamTestData.users.bob.id}
			`.execute(db);

			const bobRoleIds = userRolesResult.rows.map((r) => r.roleId);

			// Check for SoD violations
			const sodResult = await sql<{ roleA: string; roleB: string }>`
				SELECT ra.name as role_a, rb.name as role_b
				FROM sod_rules s
				JOIN roles ra ON ra.id = s.role_a_id
				JOIN roles rb ON rb.id = s.role_b_id
				WHERE s.role_a_id = ANY(${sql.raw(`ARRAY[${bobRoleIds.join(',')}]`)})
				  AND s.role_b_id = ANY(${sql.raw(`ARRAY[${bobRoleIds.join(',')}]`)})
			`.execute(db);

			await sql`SET search_path TO public`.execute(db);

			// Bob has manager + auditor, which is NOT a SoD violation
			expect(sodResult.rows).toHaveLength(0);
		});
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// ARCH-001: PATH TRACKING STRATEGIES
	// ═══════════════════════════════════════════════════════════════════════════

	describe('ARCH-001: Path Tracking Strategies', () => {
		it('should use array strategy by default for PostgreSQL (path tracking)', async () => {
			const db = await getTestDb();

			// Verify PostgreSQL capabilities
			const caps = getCapabilities(db);
			expect(caps.supportsArrayType).toBe(true);

			// Build intent with default path tracking (no explicit strategy)
			const intent: RecursiveIntent = {
				type: 'recursive',
				cteName: 'role_tree',
				start: {
					from: 'roles',
					nodeIdExpr: { kind: 'column', name: 'id' },
					where: {
						kind: 'comparison',
						field: 'name',
						operator: 'eq',
						value: 'admin',
					},
					select: ['name'],
				},
				traversal: {
					kind: 'edge-table',
					nodeTable: 'roles',
					edgeTable: 'role_edges',
					nodeId: 'id',
					edgeFrom: 'parentRoleId',
					edgeTo: 'childRoleId',
					direction: 'out',
				},
				track: {
					path: {}, // No explicit strategy - should default to array for PostgreSQL
				},
				maxDepth: 10,
			};

			const report = planRecursive(intent, iamModel);
			const compiled = compileRecursive(report, iamModel, db, IAM_SCHEMA);

			// PostgreSQL uses ARRAY[] for path initialization
			expect(compiled.sql).toContain('ARRAY[');
			// And || for array concatenation in recursive step
			expect(compiled.sql).toMatch(/"path"\s*\|\|/);

			// Verify it actually executes and returns array paths
			const result = await db.executeQuery<{
				id: number;
				name: string;
				path: number[];
			}>(compiled);

			// Should have at least the root + descendants
			expect(result.rows.length).toBeGreaterThan(0);

			// Path should be an array of role IDs
			const adminRow = result.rows.find((r) => r.name === 'admin');
			expect(adminRow).toBeDefined();
			expect(Array.isArray(adminRow?.path)).toBe(true);
		});
	});
});
