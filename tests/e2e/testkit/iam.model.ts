/**
 * IAM/RBAC ModelIR Definition
 *
 * Defines the schema for IAM entities and their relationships.
 * Uses schema() + fk() API with auto-inferred relations.
 */

import { fk, schema } from '@dbsp/core';

/**
 * IAM schema for E2E tests.
 *
 * Tables: users, roles, permissions, userRoles, rolePermissions, roleEdges, sodRules
 */
const iamSchema = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		username: 'string',
		email: 'string',
		createdAt: 'date',
	},
	roles: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		description: { type: 'string', nullable: true },
	},
	permissions: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		description: { type: 'string', nullable: true },
	},
	// Junction: users <-> roles
	userRoles: {
		userId: fk('users'),
		roleId: fk('roles'),
		grantedAt: 'date',
	},
	// Junction: roles <-> permissions
	rolePermissions: {
		roleId: fk('roles'),
		permissionId: fk('permissions'),
	},
	// Edge table: role hierarchy (multiple FKs to same table)
	roleEdges: {
		id: { type: 'integer', primaryKey: true },
		parentRoleId: fk('roles', { as: 'parentRole', inverse: 'childEdges' }),
		childRoleId: fk('roles', { as: 'childRole', inverse: 'parentEdges' }),
	},
	// SoD rules (multiple FKs to same table)
	sodRules: {
		id: { type: 'integer', primaryKey: true },
		roleAId: fk('roles', { as: 'roleA', inverse: 'sodRulesA' }),
		roleBId: fk('roles', { as: 'roleB', inverse: 'sodRulesB' }),
		reason: 'string',
	},
});

export const iamModel = iamSchema.model;
