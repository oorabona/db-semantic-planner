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

import type { PgsqlAdapter } from '@dbsp/adapter-pgsql';
import { planRecursive, type RecursiveIntent } from '@dbsp/core';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	createIamSchema,
	createSchema,
	describeE2E,
	dropIamSchema,
	dropSchema,
	getPgsqlAdapter,
	getTestPool,
	iamModel,
	iamTestData,
	seedIamData,
} from './testkit/index.js';
import { sql } from './testkit/sql.js';

const IAM_SCHEMA = 'iam_test';

/** Helper: compile and execute a recursive CTE */
async function execRecursive<T extends Record<string, unknown>>(
	adapter: PgsqlAdapter<unknown>,
	pool: Pool,
	intent: RecursiveIntent,
): Promise<T[]> {
	const report = planRecursive(intent, iamModel);
	const compiled = adapter.compileRecursive(report, iamModel, {
		schemaName: IAM_SCHEMA,
	});
	const result = await pool.query<T>(compiled.sql, [...compiled.parameters]);
	return result.rows;
}

describeE2E('E2E-003: IAM/RBAC Recursive CTE', () => {
	let pool: Pool;
	let adapter: PgsqlAdapter<unknown>;

	beforeAll(async () => {
		pool = await getTestPool();
		adapter = await getPgsqlAdapter();
		await dropSchema(IAM_SCHEMA);
		await createSchema(IAM_SCHEMA);
		await createIamSchema(pool, IAM_SCHEMA);
		await seedIamData(pool, IAM_SCHEMA);
	});

	afterAll(async () => {
		pool = await getTestPool();
		await dropIamSchema(pool, IAM_SCHEMA);
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// EFFECTIVE PERMISSIONS TESTS
	// ═══════════════════════════════════════════════════════════════════════════

	describe('Effective Permissions via Role Hierarchy', () => {
		it('should compute effective permissions for admin (inherits manager + employee + auditor)', async () => {
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
					direction: 'out',
				},
				track: {
					depth: { as: 'depth' },
				},
				maxDepth: 10,
				dedupe: 'final',
			};

			// Plan, compile, and execute
			const roles = await execRecursive<{
				id: number;
				name: string;
				depth: number;
			}>(adapter, pool, roleHierarchyIntent);

			// Extract role IDs from hierarchy
			const roleIds = roles.map((r) => r.id);

			// Step 2: Get all permissions for these roles
			await sql`SET search_path TO ${sql.ref(IAM_SCHEMA)}`.execute(pool);

			const permResult = await sql<{ permission_name: string }>`
				SELECT DISTINCT p.name as permission_name
				FROM role_permissions rp
				JOIN permissions p ON p.id = rp.permission_id
				WHERE rp.role_id IN (${sql.join(roleIds.map((id) => sql.lit(id)))})
				ORDER BY p.name
			`.execute(pool);

			await sql`SET search_path TO public`.execute(pool);

			const permissions = permResult.rows.map((r) => r.permission_name);

			// Verify: admin should have all inherited permissions
			expect(permissions).toContain('users:delete'); // admin's own
			expect(permissions).toContain('users:edit'); // from manager
			expect(permissions).toContain('users:read'); // from employee
			expect(permissions).toContain('reports:view'); // from auditor
			expect(permissions).toContain('reports:export'); // from auditor

			// Should match expected effective permissions
			expect(permissions.sort()).toEqual(
				[...iamTestData.effectivePermissions.alice].sort(),
			);
		});

		it('should deduplicate permissions from multiple inheritance paths', async () => {
			// Bob has manager + auditor roles
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

				const rows = await execRecursive<{ id: number }>(adapter, pool, intent);

				for (const row of rows) {
					allRoleIds.add(row.id);
				}
			}

			// Get permissions for all roles
			await sql`SET search_path TO ${sql.ref(IAM_SCHEMA)}`.execute(pool);

			const permResult = await sql<{ permission_name: string }>`
				SELECT DISTINCT p.name as permission_name
				FROM role_permissions rp
				JOIN permissions p ON p.id = rp.permission_id
				WHERE rp.role_id IN (${sql.join([...allRoleIds].map((id) => sql.lit(id)))})
				ORDER BY p.name
			`.execute(pool);

			await sql`SET search_path TO public`.execute(pool);

			const permissions = permResult.rows.map((r) => r.permission_name);

			// Each permission should appear exactly once
			const uniquePermissions = [...new Set(permissions)];
			expect(permissions.length).toBe(uniquePermissions.length);

			// Verify expected permissions for Bob
			expect(permissions.sort()).toEqual(
				[...iamTestData.effectivePermissions.bob].sort(),
			);
		});

		it('should return empty permissions for user with no roles', async () => {
			// Dave has no roles
			await sql`SET search_path TO ${sql.ref(IAM_SCHEMA)}`.execute(pool);

			const userRolesResult = await sql<{ roleId: number }>`
				SELECT role_id FROM user_roles WHERE user_id = ${iamTestData.users.dave.id}
			`.execute(pool);

			await sql`SET search_path TO public`.execute(pool);

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

			const rows = await execRecursive<{
				id: number;
				name: string;
				depth: number;
			}>(adapter, pool, intent);

			// Filter out the root node (admin itself at depth 1)
			const descendants = rows.filter((r) => r.depth > 1);

			// Verify descendants
			expect(descendants).toHaveLength(3); // manager, employee, auditor

			// Check depth values
			const managerRow = descendants.find((r) => r.name === 'manager');
			const employeeRow = descendants.find((r) => r.name === 'employee');
			const auditorRow = descendants.find((r) => r.name === 'auditor');

			expect(managerRow?.depth).toBe(2);
			expect(employeeRow?.depth).toBe(3);
			expect(auditorRow?.depth).toBe(2);
		});

		it('should traverse descendants with path tracking', async () => {
			// PostgreSQL always supports ARRAY type — use array strategy
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
						as: 'path',
					},
				},
				maxDepth: 10,
				dedupe: 'final',
			};

			const rows = await execRecursive<{
				id: number;
				name: string;
				depth: number;
				path: string[];
			}>(adapter, pool, intent);

			// Find employee row to check path
			const employeeRow = rows.find((r) => r.name === 'employee');
			expect(employeeRow).toBeDefined();
			expect(employeeRow?.depth).toBe(3); // admin=1, manager=2, employee=3

			// Path should show the hierarchy as text array
			// ARRAY[adminId::text, managerId::text, employeeId::text]
			expect(Array.isArray(employeeRow?.path)).toBe(true);
			expect(employeeRow?.path.length).toBe(3);
		});

		it('should traverse ancestors (reverse direction)', async () => {
			// Start from employee, traverse to ancestors via reverse edge direction
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

			const rows = await execRecursive<{
				id: number;
				name: string;
				depth: number;
			}>(adapter, pool, intent);

			// Filter out root (employee itself at depth 1)
			const ancestors = rows.filter((r) => r.depth > 1);

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
			await sql`SET search_path TO ${sql.ref(IAM_SCHEMA)}`.execute(pool);

			// Get Charlie's roles
			const userRolesResult = await sql<{
				role_id: number;
				role_name: string;
			}>`
				SELECT ur.role_id, r.name as role_name
				FROM user_roles ur
				JOIN roles r ON r.id = ur.role_id
				WHERE ur.user_id = ${iamTestData.users.charlie.id}
			`.execute(pool);

			const charlieRoleIds = userRolesResult.rows.map((r) => r.role_id);

			// Check for SoD violations
			const sodResult = await sql<{
				role_a: string;
				role_b: string;
				reason: string;
			}>`
				SELECT ra.name as role_a, rb.name as role_b, s.reason
				FROM sod_rules s
				JOIN roles ra ON ra.id = s.role_a_id
				JOIN roles rb ON rb.id = s.role_b_id
				WHERE s.role_a_id = ANY(${sql.raw(`ARRAY[${charlieRoleIds.join(',')}]`)})
				  AND s.role_b_id = ANY(${sql.raw(`ARRAY[${charlieRoleIds.join(',')}]`)})
			`.execute(pool);

			await sql`SET search_path TO public`.execute(pool);

			// Charlie should have a violation
			expect(sodResult.rows).toHaveLength(1);
			expect(sodResult.rows[0]!.role_a).toBe('approver');
			expect(sodResult.rows[0]!.role_b).toBe('requester');
			expect(sodResult.rows[0]!.reason).toContain('requester cannot approve');
		});

		it('should NOT detect SoD violation for alice (admin only)', async () => {
			await sql`SET search_path TO ${sql.ref(IAM_SCHEMA)}`.execute(pool);

			// Get Alice's direct roles
			const userRolesResult = await sql<{ role_id: number }>`
				SELECT role_id FROM user_roles WHERE user_id = ${iamTestData.users.alice.id}
			`.execute(pool);

			const aliceRoleIds = userRolesResult.rows.map((r) => r.role_id);

			// Check for SoD violations
			const sodResult = await sql<{
				role_a: string;
				role_b: string;
			}>`
				SELECT ra.name as role_a, rb.name as role_b
				FROM sod_rules s
				JOIN roles ra ON ra.id = s.role_a_id
				JOIN roles rb ON rb.id = s.role_b_id
				WHERE s.role_a_id = ANY(${sql.raw(`ARRAY[${aliceRoleIds.join(',')}]`)})
				  AND s.role_b_id = ANY(${sql.raw(`ARRAY[${aliceRoleIds.join(',')}]`)})
			`.execute(pool);

			await sql`SET search_path TO public`.execute(pool);

			// Alice should have no SoD violations
			expect(sodResult.rows).toHaveLength(0);
		});

		it('should NOT detect SoD violation for bob (manager + auditor)', async () => {
			await sql`SET search_path TO ${sql.ref(IAM_SCHEMA)}`.execute(pool);

			// Get Bob's direct roles
			const userRolesResult = await sql<{ role_id: number }>`
				SELECT role_id FROM user_roles WHERE user_id = ${iamTestData.users.bob.id}
			`.execute(pool);

			const bobRoleIds = userRolesResult.rows.map((r) => r.role_id);

			// Check for SoD violations
			const sodResult = await sql<{
				role_a: string;
				role_b: string;
			}>`
				SELECT ra.name as role_a, rb.name as role_b
				FROM sod_rules s
				JOIN roles ra ON ra.id = s.role_a_id
				JOIN roles rb ON rb.id = s.role_b_id
				WHERE s.role_a_id = ANY(${sql.raw(`ARRAY[${bobRoleIds.join(',')}]`)})
				  AND s.role_b_id = ANY(${sql.raw(`ARRAY[${bobRoleIds.join(',')}]`)})
			`.execute(pool);

			await sql`SET search_path TO public`.execute(pool);

			// Bob has manager + auditor, which is NOT a SoD violation
			expect(sodResult.rows).toHaveLength(0);
		});
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// PATH TRACKING STRATEGIES
	// ═══════════════════════════════════════════════════════════════════════════

	describe('Path Tracking Strategies', () => {
		it('should use array strategy by default for PostgreSQL (path tracking)', async () => {
			// Build intent with default path tracking
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
					path: { as: '__path' },
				},
				maxDepth: 10,
			};

			const report = planRecursive(intent, iamModel);
			const compiled = adapter.compileRecursive(report, iamModel, {
				schemaName: IAM_SCHEMA,
			});

			// PostgreSQL uses ARRAY[] for path initialization
			expect(compiled.sql).toContain('ARRAY[');
			// And || for array concatenation in recursive step
			expect(compiled.sql).toContain('||');

			// Verify it actually executes and returns array paths
			const result = await pool.query<{
				id: number;
				name: string;
				__path: string[];
			}>(compiled.sql, [...compiled.parameters]);

			// Should have at least the root + descendants
			expect(result.rows.length).toBeGreaterThan(0);

			// Path should be an array of role IDs (as text)
			const adminRow = result.rows.find((r) => r.name === 'admin');
			expect(adminRow).toBeDefined();
			expect(Array.isArray(adminRow?.__path)).toBe(true);
		});
	});
});
