/**
 * IAM/RBAC Seed Data
 *
 * Creates realistic IAM data for testing recursive CTE queries.
 *
 * Role Hierarchy:
 *   admin ─┬─> manager ──> employee
 *          └─> auditor
 *
 * Users:
 *   - alice: admin (inherits manager, employee permissions)
 *   - bob: manager + auditor (dual role)
 *   - charlie: approver + requester (SoD violation)
 *   - dave: no roles (edge case)
 */

import type pg from 'pg';
import { sql } from './sql.js';

/**
 * Seed IAM data in the specified schema.
 */
export async function seedIamData(
	pool: pg.Pool,
	schemaName: string,
): Promise<void> {
	// Set search path
	await sql`SET search_path TO ${sql.ref(schemaName)}`.execute(pool);

	// ──────────────────────────────────────────────────────────────────────────
	// ROLES
	// ──────────────────────────────────────────────────────────────────────────

	await sql`
		INSERT INTO roles (id, name, description) VALUES
			(1, 'admin', 'System administrator with full access'),
			(2, 'manager', 'Team manager with edit access'),
			(3, 'employee', 'Regular employee with read access'),
			(4, 'auditor', 'Auditor with report access'),
			(5, 'approver', 'Can approve requests'),
			(6, 'requester', 'Can create requests')
	`.execute(pool);

	// Reset sequence
	await sql`SELECT setval('roles_id_seq', 6)`.execute(pool);

	// ──────────────────────────────────────────────────────────────────────────
	// PERMISSIONS
	// ──────────────────────────────────────────────────────────────────────────

	await sql`
		INSERT INTO permissions (id, name, description) VALUES
			(1, 'users:read', 'View user profiles'),
			(2, 'users:edit', 'Edit user profiles'),
			(3, 'users:delete', 'Delete users'),
			(4, 'reports:view', 'View reports'),
			(5, 'reports:export', 'Export reports'),
			(6, 'requests:create', 'Create new requests'),
			(7, 'requests:approve', 'Approve pending requests')
	`.execute(pool);

	// Reset sequence
	await sql`SELECT setval('permissions_id_seq', 7)`.execute(pool);

	// ──────────────────────────────────────────────────────────────────────────
	// ROLE PERMISSIONS
	// ──────────────────────────────────────────────────────────────────────────

	await sql`
		INSERT INTO role_permissions (role_id, permission_id) VALUES
			-- admin: users:delete (unique to admin)
			(1, 3),
			-- manager: users:edit (inherited by admin)
			(2, 2),
			-- employee: users:read (inherited by manager and admin)
			(3, 1),
			-- auditor: reports:view, reports:export
			(4, 4),
			(4, 5),
			-- approver: requests:approve
			(5, 7),
			-- requester: requests:create
			(6, 6)
	`.execute(pool);

	// ──────────────────────────────────────────────────────────────────────────
	// ROLE HIERARCHY (edge table)
	// ──────────────────────────────────────────────────────────────────────────

	await sql`
		INSERT INTO role_edges (parent_role_id, child_role_id) VALUES
			-- admin -> manager (admin inherits from manager)
			(1, 2),
			-- manager -> employee (manager inherits from employee)
			(2, 3),
			-- admin -> auditor (admin also inherits from auditor)
			(1, 4)
	`.execute(pool);

	// ──────────────────────────────────────────────────────────────────────────
	// USERS
	// ──────────────────────────────────────────────────────────────────────────

	await sql`
		INSERT INTO users (id, username, email) VALUES
			(1, 'alice', 'alice@example.com'),
			(2, 'bob', 'bob@example.com'),
			(3, 'charlie', 'charlie@example.com'),
			(4, 'dave', 'dave@example.com')
	`.execute(pool);

	// Reset sequence
	await sql`SELECT setval('users_id_seq', 4)`.execute(pool);

	// ──────────────────────────────────────────────────────────────────────────
	// USER ROLES
	// ──────────────────────────────────────────────────────────────────────────

	await sql`
		INSERT INTO user_roles (user_id, role_id) VALUES
			-- alice: admin
			(1, 1),
			-- bob: manager + auditor
			(2, 2),
			(2, 4),
			-- charlie: approver + requester (SoD violation)
			(3, 5),
			(3, 6)
			-- dave: no roles (intentionally empty)
	`.execute(pool);

	// ──────────────────────────────────────────────────────────────────────────
	// SEPARATION OF DUTY RULES
	// ──────────────────────────────────────────────────────────────────────────

	await sql`
		INSERT INTO sod_rules (role_a_id, role_b_id, reason) VALUES
			-- approver and requester are incompatible (fraud prevention)
			(5, 6, 'Segregation: requester cannot approve own requests')
	`.execute(pool);

	// Reset search path
	await sql`SET search_path TO public`.execute(pool);
}

/**
 * Get expected test data for assertions.
 */
export const iamTestData = {
	users: {
		alice: { id: 1, username: 'alice', directRoles: ['admin'] },
		bob: { id: 2, username: 'bob', directRoles: ['manager', 'auditor'] },
		charlie: {
			id: 3,
			username: 'charlie',
			directRoles: ['approver', 'requester'],
		},
		dave: { id: 4, username: 'dave', directRoles: [] },
	},
	roles: {
		admin: { id: 1, name: 'admin' },
		manager: { id: 2, name: 'manager' },
		employee: { id: 3, name: 'employee' },
		auditor: { id: 4, name: 'auditor' },
		approver: { id: 5, name: 'approver' },
		requester: { id: 6, name: 'requester' },
	},
	permissions: {
		'users:read': { id: 1 },
		'users:edit': { id: 2 },
		'users:delete': { id: 3 },
		'reports:view': { id: 4 },
		'reports:export': { id: 5 },
		'requests:create': { id: 6 },
		'requests:approve': { id: 7 },
	},
	/**
	 * Expected effective permissions by user.
	 * Includes direct + inherited permissions.
	 */
	effectivePermissions: {
		alice: [
			'users:delete',
			'users:edit',
			'users:read',
			'reports:view',
			'reports:export',
		],
		bob: ['users:edit', 'users:read', 'reports:view', 'reports:export'],
		charlie: ['requests:approve', 'requests:create'],
		dave: [],
	},
	/**
	 * Expected role hierarchy (descendants from admin).
	 */
	adminDescendants: [
		{ role: 'manager', depth: 1 },
		{ role: 'employee', depth: 2 },
		{ role: 'auditor', depth: 1 },
	],
	/**
	 * SoD violations.
	 */
	sodViolations: {
		charlie: [{ roleA: 'approver', roleB: 'requester' }],
	},
} as const;
