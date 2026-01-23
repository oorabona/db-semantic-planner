/**
 * IAM/RBAC ModelIR Definition
 *
 * Defines the schema for IAM entities and their relationships.
 */

import { defineSchemaBuilder, hasMany, belongsTo } from '@dbsp/core';

/**
 * IAM schema ModelIR with snake_case names matching PostgreSQL.
 *
 * Tables: users, roles, permissions, user_roles, role_permissions, role_edges, sod_rules
 */
export const iamModel = defineSchemaBuilder({
	users: {
		id: { type: 'integer', primaryKey: true },
		username: { type: 'string' },
		email: { type: 'string' },
		created_at: { type: 'date' },
	},
	roles: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'string' },
		description: { type: 'string' },
	},
	permissions: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'string' },
		description: { type: 'string' },
	},
	user_roles: {
		user_id: { type: 'integer' },
		role_id: { type: 'integer' },
		granted_at: { type: 'date' },
	},
	role_permissions: {
		role_id: { type: 'integer' },
		permission_id: { type: 'integer' },
	},
	role_edges: {
		id: { type: 'integer', primaryKey: true },
		parent_role_id: { type: 'integer' },
		child_role_id: { type: 'integer' },
	},
	sod_rules: {
		id: { type: 'integer', primaryKey: true },
		role_a_id: { type: 'integer' },
		role_b_id: { type: 'integer' },
		reason: { type: 'string' },
	},
})
	.relations({
		// Users relations
		users: {
			user_roles: hasMany('user_roles', { foreignKey: 'user_id' }),
		},
		// Roles relations
		roles: {
			user_roles: hasMany('user_roles', { foreignKey: 'role_id' }),
			role_permissions: hasMany('role_permissions', { foreignKey: 'role_id' }),
			parent_edges: hasMany('role_edges', { foreignKey: 'child_role_id' }),
			child_edges: hasMany('role_edges', { foreignKey: 'parent_role_id' }),
			sod_rules_a: hasMany('sod_rules', { foreignKey: 'role_a_id' }),
			sod_rules_b: hasMany('sod_rules', { foreignKey: 'role_b_id' }),
		},
		// Permissions relations
		permissions: {
			role_permissions: hasMany('role_permissions', { foreignKey: 'permission_id' }),
		},
		// Junction: user_roles
		user_roles: {
			user: belongsTo('users', { foreignKey: 'user_id' }),
			role: belongsTo('roles', { foreignKey: 'role_id' }),
		},
		// Junction: role_permissions
		role_permissions: {
			role: belongsTo('roles', { foreignKey: 'role_id' }),
			permission: belongsTo('permissions', { foreignKey: 'permission_id' }),
		},
		// Edge table: role_edges (multiple FKs to same table)
		role_edges: {
			parent_role: belongsTo('roles', { foreignKey: 'parent_role_id' }),
			child_role: belongsTo('roles', { foreignKey: 'child_role_id' }),
		},
		// SoD rules (multiple FKs to same table)
		sod_rules: {
			role_a: belongsTo('roles', { foreignKey: 'role_a_id' }),
			role_b: belongsTo('roles', { foreignKey: 'role_b_id' }),
		},
	})
	.build();
