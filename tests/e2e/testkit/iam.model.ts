/**
 * IAM/RBAC ModelIR Definition
 *
 * Defines the schema for IAM entities and their relationships.
 */

import {
	belongsTo,
	defineSchema,
	hasMany,
	type ModelIR,
} from '@dbsp/core';

/**
 * IAM schema ModelIR.
 *
 * Tables: users, roles, permissions, user_roles, role_permissions, role_edges, sod_rules
 */
/**
 * IAM schema ModelIR with snake_case names matching PostgreSQL.
 *
 * Tables: users, roles, permissions, user_roles, role_permissions, role_edges, sod_rules
 */
export const iamModel: ModelIR = defineSchema({
	users: {
		id: { type: 'number' },
		username: { type: 'string' },
		email: { type: 'string' },
		created_at: { type: 'date' },
	},
	roles: {
		id: { type: 'number' },
		name: { type: 'string' },
		description: { type: 'string' },
	},
	permissions: {
		id: { type: 'number' },
		name: { type: 'string' },
		description: { type: 'string' },
	},
	user_roles: {
		user_id: { type: 'number' },
		role_id: { type: 'number' },
		granted_at: { type: 'date' },
	},
	role_permissions: {
		role_id: { type: 'number' },
		permission_id: { type: 'number' },
	},
	role_edges: {
		id: { type: 'number' },
		parent_role_id: { type: 'number' },
		child_role_id: { type: 'number' },
	},
	sod_rules: {
		id: { type: 'number' },
		role_a_id: { type: 'number' },
		role_b_id: { type: 'number' },
		reason: { type: 'string' },
	},
})
	.relations({
		// User relations
		users: {
			user_roles: hasMany('user_roles', { foreignKey: 'user_id' }),
		},

		// Role relations
		roles: {
			user_roles: hasMany('user_roles', { foreignKey: 'role_id' }),
			role_permissions: hasMany('role_permissions', { foreignKey: 'role_id' }),
			// Edge-table relations for hierarchy
			parent_edges: hasMany('role_edges', { foreignKey: 'child_role_id' }),
			child_edges: hasMany('role_edges', { foreignKey: 'parent_role_id' }),
			// SoD rules
			sod_rules_a: hasMany('sod_rules', { foreignKey: 'role_a_id' }),
			sod_rules_b: hasMany('sod_rules', { foreignKey: 'role_b_id' }),
		},

		// Permission relations
		permissions: {
			role_permissions: hasMany('role_permissions', { foreignKey: 'permission_id' }),
		},

		// Junction table relations
		user_roles: {
			user: belongsTo('users', { foreignKey: 'user_id' }),
			role: belongsTo('roles', { foreignKey: 'role_id' }),
		},

		role_permissions: {
			role: belongsTo('roles', { foreignKey: 'role_id' }),
			permission: belongsTo('permissions', { foreignKey: 'permission_id' }),
		},

		// Edge table relations
		role_edges: {
			parent_role: belongsTo('roles', { foreignKey: 'parent_role_id' }),
			child_role: belongsTo('roles', { foreignKey: 'child_role_id' }),
		},

		// SoD rules relations
		sod_rules: {
			role_a: belongsTo('roles', { foreignKey: 'role_a_id' }),
			role_b: belongsTo('roles', { foreignKey: 'role_b_id' }),
		},
	})
	.build();
