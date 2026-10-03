import { describe, expect, it } from 'vitest';
import { POSTGRESQL_CAPABILITIES } from './dialects/index.js';
import { ref, schema } from './dx/schema.js';
import { AmbiguousPlanError, plan } from './planner.js';

const model = schema({
	users: { id: { type: 'integer', primaryKey: true } },
	posts: {
		id: { type: 'integer', primaryKey: true },
		userId: ref('users', { inverse: 'posts' }),
	},
	comments: {
		id: { type: 'integer' },
		postId: ref('posts', { inverse: 'comments' }),
		authorId: ref('profiles', { as: 'author' }),
		editorId: ref('profiles', { as: 'editor' }),
	},
	profiles: { id: { type: 'integer', primaryKey: true } },
	secrets: {
		id: { type: 'integer', primaryKey: true },
		userId: ref('users', { inverse: 'foo_b_ar' }),
	},
	publics: {
		id: { type: 'integer', primaryKey: true },
		userId: ref('users', { inverse: 'foo_bAr' }),
	},
}).model;

function exactError(fn: () => unknown, message: string) {
	let error: unknown;
	try {
		fn();
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(Error);
	expect((error as Error).message).toBe(message);
	return error;
}

describe('include validation regressions', () => {
	it('names the nested path for camelCase collisions too', () => {
		const collisionModel = Object.assign(Object.create(model) as typeof model, {
			getRelationsFrom: (table: string) =>
				table === 'comments'
					? model
							.getRelationsFrom(table)
							.filter((r) => r.target === 'profiles')
							.map((r, i) => ({ ...r, name: i === 0 ? 'foo_b_ar' : 'foo_bAr' }))
					: model.getRelationsFrom(table),
		});
		exactError(
			() =>
				plan(
					{
						type: 'select',
						from: 'users',
						include: [
							{
								relation: 'posts',
								include: [
									{ relation: 'comments', include: [{ relation: 'fooBAr' }] },
								],
							},
						],
					},
					collisionModel,
					{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
				),
			'Ambiguous include relation "fooBAr" from table "comments" at "posts.comments.fooBAr". Use the exact relation name or "via" to specify one of: foo_b_ar, foo_bAr',
		);
	});

	it('refuses camelCase collisions rather than selecting the first relation', () => {
		exactError(
			() =>
				plan(
					{ type: 'select', from: 'users', include: [{ relation: 'fooBAr' }] },
					model,
				),
			'Ambiguous include relation "fooBAr" from table "users" at "fooBAr". Use the exact relation name or "via" to specify one of: foo_b_ar, foo_bAr',
		);
	});
	it('refuses unknown nested order fields before checking total order', () => {
		exactError(
			() =>
				plan(
					{
						type: 'select',
						from: 'users',
						include: [
							{
								relation: 'posts',
								include: [
									{
										relation: 'comments',
										limit: 1,
										orderBy: [{ field: 'missing', direction: 'asc' }],
									},
								],
							},
						],
					},
					model,
					{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
				),
			'Include posts.comments orderBy field "missing" is not a column of target table "comments"',
		);
	});
	it('names the full three-level path and preserves ambiguity details', () => {
		const error = exactError(
			() =>
				plan(
					{
						type: 'select',
						from: 'users',
						include: [
							{
								relation: 'posts',
								include: [
									{
										relation: 'comments',
										include: [{ relation: 'profiles' }],
									},
								],
							},
						],
					},
					model,
					{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
				),
			'Ambiguous relation from "comments" to "profiles" at "posts.comments.profiles". Use "via" to specify one of: author, editor',
		);
		expect(error).toBeInstanceOf(AmbiguousPlanError);
		expect(error).toMatchObject({
			sourceTable: 'comments',
			targetTable: 'profiles',
			options: ['author', 'editor'],
		});
	});
});
