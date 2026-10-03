import { POSTGRESQL_CAPABILITIES, plan, ref, schema } from '@dbsp/core';
import { deparseSync } from 'pgsql-deparser';
import { expect, it } from 'vitest';
import { selectStmt, sqlJsonAggSubquery } from '../ast-helpers.js';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';
import { queryLocal } from '../sql-identifier.js';

it('chunks 51 child properties independently', () => {
	const children = Array.from({ length: 51 }, (_, i) => ({
		key: queryLocal(`child${i}`),
		node: { A_Const: { ival: { ival: i } } },
	}));
	const target = sqlJsonAggSubquery(
		queryLocal('posts'),
		{ A_Const: { boolval: { boolval: true } } },
		queryLocal('posts_json'),
		undefined,
		{ childNodes: children },
	);
	const sql = deparseSync(selectStmt({ targetList: [target] }));
	const first = Array.from({ length: 50 }, (_, i) => `'child${i}', ${i}`).join(
		', ',
	);
	expect(sql.replace(/\s+/g, ' ').trim()).toBe(
		`SELECT COALESCE((SELECT json_agg(to_jsonb(__t__) || (jsonb_build_object(${first}) || jsonb_build_object('child50', 50))) FROM posts AS __t__ WHERE true), '[]'::json) AS posts_json`,
	);
});

it('compiles 51 nested child includes in bounded objects', () => {
	const names = Array.from({ length: 51 }, (_, i) => `child${i}`);
	const wide = schema({
		users: { id: { type: 'integer', primaryKey: true } },
		posts: {
			id: { type: 'integer', primaryKey: true },
			authorId: ref('users', { inverse: 'posts' }),
		},
		...Object.fromEntries(
			names.map((name) => [
				name,
				{
					id: { type: 'integer' as const, primaryKey: true },
					postId: ref('posts', { inverse: name }),
				},
			]),
		),
	}).model;
	const report = plan(
		{
			type: 'select',
			from: 'users',
			include: [
				{ relation: 'posts', include: names.map((relation) => ({ relation })) },
			],
		},
		wide,
		{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
	);
	const result = createPgCompileOnlyAdapter({ model: wide }).compile(report, {
		model: wide,
	});
	const property = (name: string) =>
		`'${name}', COALESCE((SELECT json_agg(to_jsonb(__t1__) ORDER BY __t1__.id ASC NULLS LAST) FROM ${name} AS __t1__ WHERE __t1__."postId" = __t__.id), '[]'::json)`;
	const first = names.slice(0, 50).map(property).join(', ');
	expect(result.sql).toBe(
		`SELECT users.*, COALESCE((SELECT json_agg(to_jsonb(__t__) || (jsonb_build_object(${first}) || jsonb_build_object(${property('child50')})) ORDER BY __t__.id ASC NULLS LAST) FROM posts AS __t__ WHERE __t__."authorId" = users.id), '[]'::json) AS posts_json FROM users`,
	);
	expect(result.parameters).toEqual([]);
});
