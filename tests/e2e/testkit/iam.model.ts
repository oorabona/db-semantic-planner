/**
 * IAM/RBAC ModelIR Definition
 *
 * Defines the schema for IAM entities and their relationships.
 */

import { buildModelFromResolvedSchema, defineSchema } from '@dbsp/core';

/**
 * IAM schema with snake_case names matching PostgreSQL.
 *
 * Tables: users, roles, permissions, user_roles, role_permissions, role_edges, sod_rules
 */
const iamSchema = defineSchema(
	{
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
	},
	{
		relations: {
			// Users relations
			'users.user_roles': {
				kind: 'hasMany',
				target: 'user_roles',
				foreignKey: 'user_id',
			},
			// Roles relations
			'roles.user_roles': {
				kind: 'hasMany',
				target: 'user_roles',
				foreignKey: 'role_id',
			},
			'roles.role_permissions': {
				kind: 'hasMany',
				target: 'role_permissions',
				foreignKey: 'role_id',
			},
			'roles.parent_edges': {
				kind: 'hasMany',
				target: 'role_edges',
				foreignKey: 'child_role_id',
			},
			'roles.child_edges': {
				kind: 'hasMany',
				target: 'role_edges',
				foreignKey: 'parent_role_id',
			},
			'roles.sod_rules_a': {
				kind: 'hasMany',
				target: 'sod_rules',
				foreignKey: 'role_a_id',
			},
			'roles.sod_rules_b': {
				kind: 'hasMany',
				target: 'sod_rules',
				foreignKey: 'role_b_id',
			},
			// Permissions relations
			'permissions.role_permissions': {
				kind: 'hasMany',
				target: 'role_permissions',
				foreignKey: 'permission_id',
			},
			// Junction: user_roles
			'user_roles.user': {
				kind: 'belongsTo',
				target: 'users',
				foreignKey: 'user_id',
			},
			'user_roles.role': {
				kind: 'belongsTo',
				target: 'roles',
				foreignKey: 'role_id',
			},
			// Junction: role_permissions
			'role_permissions.role': {
				kind: 'belongsTo',
				target: 'roles',
				foreignKey: 'role_id',
			},
			'role_permissions.permission': {
				kind: 'belongsTo',
				target: 'permissions',
				foreignKey: 'permission_id',
			},
			// Edge table: role_edges (multiple FKs to same table)
			'role_edges.parent_role': {
				kind: 'belongsTo',
				target: 'roles',
				foreignKey: 'parent_role_id',
			},
			'role_edges.child_role': {
				kind: 'belongsTo',
				target: 'roles',
				foreignKey: 'child_role_id',
			},
			// SoD rules (multiple FKs to same table)
			'sod_rules.role_a': {
				kind: 'belongsTo',
				target: 'roles',
				foreignKey: 'role_a_id',
			},
			'sod_rules.role_b': {
				kind: 'belongsTo',
				target: 'roles',
				foreignKey: 'role_b_id',
			},
		},
	},
);

export const iamModel = buildModelFromResolvedSchema(iamSchema);
