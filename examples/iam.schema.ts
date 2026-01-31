/**
 * Example: IAM / RBAC Schema
 *
 * A comprehensive Identity & Access Management model demonstrating:
 * - Edge-table recursive hierarchy (roleEdges)
 * - Self-referential adjacency list (resources.parentId)
 * - Junction tables for M:N (userRoles, rolePermissions)
 * - Dual-FK disambiguation (sodRules, roleEdges)
 * - Audit trail with JSONB
 *
 * Usage:
 *   pnpm dbsp repl --schema ./examples/iam.schema.ts
 *   pnpm dbsp generate ddl --schema ./examples/iam.schema.ts --drop --out ./examples/iam.ddl.sql
 */

import { ref, schema } from '@dbsp/core';

export default schema({
	users: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		username: 'string',
		email: { type: 'string', unique: true },
		active: { type: 'boolean', default: 'true', index: true },
		createdAt: { type: 'timestamp', default: 'now()' },
	},
	roles: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		name: { type: 'string', unique: true },
		description: { type: 'text', nullable: true },
		active: { type: 'boolean', default: 'true' },
	},
	permissions: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		name: { type: 'string', unique: true },
		resource: 'string',
		action: 'string',
		description: { type: 'text', nullable: true },
	},
	resources: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		name: 'string',
		type: 'string',
		// Self-ref adjacency list (contrast with edge-table on roleEdges)
		parentId: ref('resources', {
			nullable: true,
			roles: { parent: 'parent', children: 'children' },
		}),
	},
	// Junction: users <-> roles (M:N)
	userRoles: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		userId: ref('users', { onDelete: 'CASCADE', inverse: 'userRoles' }),
		roleId: ref('roles', { onDelete: 'CASCADE', inverse: 'userRoles' }),
		grantedAt: { type: 'timestamp', default: 'now()' },
	},
	// Junction: roles <-> permissions (M:N)
	rolePermissions: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		roleId: ref('roles', { onDelete: 'CASCADE', inverse: 'rolePermissions' }),
		permissionId: ref('permissions', { onDelete: 'CASCADE', inverse: 'rolePermissions' }),
	},
	// Edge table for recursive CTE (NOT self-ref — uses dedicated edge table)
	roleEdges: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		parentRoleId: ref('roles', { as: 'parentRole', inverse: 'childEdges', onDelete: 'CASCADE' }),
		childRoleId: ref('roles', { as: 'childRole', inverse: 'parentEdges', onDelete: 'CASCADE' }),
	},
	// Separation of Duty rules
	sodRules: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		roleAId: ref('roles', { as: 'roleA', inverse: 'sodRulesA' }),
		roleBId: ref('roles', { as: 'roleB', inverse: 'sodRulesB' }),
		reason: 'string',
	},
	// Audit trail
	auditLog: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		userId: ref('users', { nullable: true, onDelete: 'SET NULL' }),
		action: 'string',
		resource: 'string',
		timestamp: { type: 'timestamp', default: 'now()', index: true },
		details: { type: 'jsonb', nullable: true },
	},
});
