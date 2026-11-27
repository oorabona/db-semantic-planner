/**
 * Nested json_agg compilation tests
 *
 * Tests for the recursive compileJsonAggDecision path:
 * - Single-level includes (no children)
 * - Two-level nested includes (parent → child)
 * - Deep nesting (6 levels) to verify stack safety
 * - ResTarget extraction edge cases
 */

import { createOrm, ref, schema } from '@dbsp/core';
import { parseSync } from 'pgsql-parser';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const rolesDb = schema(
	{
		users: { id: { type: 'integer', primaryKey: true } },
		roles: {
			role_id: { type: 'integer', primaryKey: true },
			tenant_id: { type: 'integer', primaryKey: true },
		},
		user_roles: {
			id: { type: 'integer', primaryKey: true },
			user_id: ref('users', { as: 'user', inverse: 'userRoles' }),
			role_id: 'integer',
			tenant_id: 'integer',
		},
	},
	{
		user_roles: {
			foreignKeys: [
				ref('roles', {
					columns: ['role_id', 'tenant_id'],
					references: ['role_id', 'tenant_id'],
					as: 'role',
					inverse: 'userRoles',
				}),
			],
		},
	},
);

const permissionsDb = schema({
	users: { id: { type: 'integer', primaryKey: true } },
	roles: { id: { type: 'integer', primaryKey: true } },
	permissions: {
		id: { type: 'integer', primaryKey: true },
		role_id: ref('roles', { as: 'role', inverse: 'permissions' }),
	},
	user_roles: {
		id: { type: 'integer', primaryKey: true },
		user_id: ref('users', { as: 'user', inverse: 'userRoles' }),
		role_id: ref('roles', { as: 'role', inverse: 'userRoles' }),
	},
});

const chainDb = schema({
	root: { id: { type: 'integer', primaryKey: true } },
	a: {
		id: { type: 'integer', primaryKey: true },
		root_id: ref('root', { as: 'root', inverse: 'a' }),
	},
	b: {
		id: { type: 'integer', primaryKey: true },
		a_id: ref('a', { as: 'a', inverse: 'b' }),
	},
	c: {
		id: { type: 'integer', primaryKey: true },
		b_id: ref('b', { as: 'b', inverse: 'c' }),
	},
	d: {
		id: { type: 'integer', primaryKey: true },
		c_id: ref('c', { as: 'c', inverse: 'd' }),
	},
	e: {
		id: { type: 'integer', primaryKey: true },
		d_id: ref('d', { as: 'd', inverse: 'e' }),
	},
	f: {
		id: { type: 'integer', primaryKey: true },
		e_id: ref('e', { as: 'e', inverse: 'f' }),
	},
});

function ormFor<
	S extends typeof rolesDb | typeof permissionsDb | typeof chainDb,
>(db: S) {
	return createOrm({
		model: db.model,
		adapter: createPgCompileOnlyAdapter({ model: db.model }),
	});
}

describe('Nested json_agg compilation', () => {
	it('compiles two-level nested json_agg (parent → child)', () => {
		const { sql, params } = ormFor(rolesDb)
			.select('users')
			.withPlanOptions({ defaultIncludeStrategy: 'json_agg' })
			.include('userRoles', { include: [{ relation: 'role' }] })
			.dump();

		expect({ sql, params }).toEqual({
			sql: `SELECT users.*, COALESCE((SELECT json_agg(jsonb_build_object('id', __t__.id, 'user_id', __t__.user_id, 'role_id', __t__.role_id, 'tenant_id', __t__.tenant_id) || jsonb_build_object('role', COALESCE((SELECT json_agg(jsonb_build_object('role_id', __t1__.role_id, 'tenant_id', __t1__.tenant_id) ORDER BY __t1__.role_id ASC NULLS LAST, __t1__.tenant_id ASC NULLS LAST) FROM roles AS __t1__ WHERE __t1__.role_id = __t__.role_id AND __t1__.tenant_id = __t__.tenant_id), '[]'::json)) ORDER BY __t__.id ASC NULLS LAST) FROM user_roles AS __t__ WHERE __t__.user_id = users.id), '[]'::json) AS "userRoles_json" FROM users`,
			params: [],
		});
		// Must be valid SQL
		expect(parseSync(sql).stmts).toHaveLength(1);
	});

	it('compiles three-level nested json_agg', () => {
		const { sql, params } = ormFor(permissionsDb)
			.select('users')
			.withPlanOptions({ defaultIncludeStrategy: 'json_agg' })
			.include('userRoles', {
				include: [{ relation: 'role', include: [{ relation: 'permissions' }] }],
			})
			.dump();

		expect({ sql, params }).toEqual({
			sql: `SELECT users.*, COALESCE((SELECT json_agg(jsonb_build_object('id', __t__.id, 'user_id', __t__.user_id, 'role_id', __t__.role_id) || jsonb_build_object('role', COALESCE((SELECT json_agg(jsonb_build_object('id', __t1__.id) || jsonb_build_object('permissions', COALESCE((SELECT json_agg(jsonb_build_object('id', __t2__.id, 'role_id', __t2__.role_id) ORDER BY __t2__.id ASC NULLS LAST) FROM permissions AS __t2__ WHERE __t2__.role_id = __t1__.id), '[]'::json)) ORDER BY __t1__.id ASC NULLS LAST) FROM roles AS __t1__ WHERE __t1__.id = __t__.role_id), '[]'::json)) ORDER BY __t__.id ASC NULLS LAST) FROM user_roles AS __t__ WHERE __t__.user_id = users.id), '[]'::json) AS "userRoles_json" FROM users`,
			params: [],
		});
		// Must be valid SQL
		expect(parseSync(sql).stmts).toHaveLength(1);
	});

	it('compiles 6-level deep nesting without stack overflow', () => {
		// Build a 6-level chain: a → b → c → d → e → f
		const { sql, params } = ormFor(chainDb)
			.select('root')
			.withPlanOptions({ defaultIncludeStrategy: 'json_agg' })
			.include('a', {
				include: [
					{
						relation: 'b',
						include: [
							{
								relation: 'c',
								include: [
									{
										relation: 'd',
										include: [{ relation: 'e', include: [{ relation: 'f' }] }],
									},
								],
							},
						],
					},
				],
			})
			.dump();

		expect({ sql, params }).toEqual({
			sql: `SELECT root.*, COALESCE((SELECT json_agg(jsonb_build_object('id', __t__.id, 'root_id', __t__.root_id) || jsonb_build_object('b', COALESCE((SELECT json_agg(jsonb_build_object('id', __t1__.id, 'a_id', __t1__.a_id) || jsonb_build_object('c', COALESCE((SELECT json_agg(jsonb_build_object('id', __t2__.id, 'b_id', __t2__.b_id) || jsonb_build_object('d', COALESCE((SELECT json_agg(jsonb_build_object('id', __t3__.id, 'c_id', __t3__.c_id) || jsonb_build_object('e', COALESCE((SELECT json_agg(jsonb_build_object('id', __t4__.id, 'd_id', __t4__.d_id) || jsonb_build_object('f', COALESCE((SELECT json_agg(jsonb_build_object('id', __t5__.id, 'e_id', __t5__.e_id) ORDER BY __t5__.id ASC NULLS LAST) FROM f AS __t5__ WHERE __t5__.e_id = __t4__.id), '[]'::json)) ORDER BY __t4__.id ASC NULLS LAST) FROM e AS __t4__ WHERE __t4__.d_id = __t3__.id), '[]'::json)) ORDER BY __t3__.id ASC NULLS LAST) FROM d AS __t3__ WHERE __t3__.c_id = __t2__.id), '[]'::json)) ORDER BY __t2__.id ASC NULLS LAST) FROM c AS __t2__ WHERE __t2__.b_id = __t1__.id), '[]'::json)) ORDER BY __t1__.id ASC NULLS LAST) FROM b AS __t1__ WHERE __t1__.a_id = __t__.id), '[]'::json)) ORDER BY __t__.id ASC NULLS LAST) FROM a AS __t__ WHERE __t__.root_id = root.id), '[]'::json) AS a_json FROM root`,
			params: [],
		});
		// Must be valid SQL
		expect(parseSync(sql).stmts).toHaveLength(1);
	});
});
