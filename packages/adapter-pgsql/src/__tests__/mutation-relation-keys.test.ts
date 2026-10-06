import { exists, notExists, ref, schema } from '@dbsp/core';
import type { ModelIR, RelationIR } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

function modelWithImplicitKeys(
	nonKeyId = false,
	override?: Partial<RelationIR>,
): ModelIR {
	const base = schema({
		users: {
			code: { type: 'text', primaryKey: true },
			...(nonKeyId ? { id: { type: 'integer' as const } } : {}),
		},
		posts: {
			id: { type: 'integer', primaryKey: true },
			authorCode: ref('users', {
				as: 'author',
				inverse: 'authored',
				references: ['code'],
			}),
			title: { type: 'text' },
		},
		posts_archive: { id: 'integer', title: 'text' },
	}).model;
	const relations = new Map<string, RelationIR>(
		[...base.relations].map(([name, relation]) => {
			const implicit = { ...relation };
			delete implicit.sourceKey;
			delete implicit.targetKey;
			return [name, { ...implicit, ...override }];
		}),
	);
	return {
		...base,
		relations,
		getTable: (name) => base.getTable(name),
		getRelation: (name) => relations.get(name),
		getRelationsFrom: (source) =>
			[...relations.values()].filter((r) => r.source === source),
		getRelationsTo: (target) =>
			[...relations.values()].filter((r) => r.target === target),
	};
}

describe('mutation relation guards use declared keys', () => {
	it.each([false, true])(
		'UPDATE exists uses the target primary key when non-key id is present: %s',
		(nonKeyId) => {
			const adapter = createPgCompileOnlyAdapter({
				model: modelWithImplicitKeys(nonKeyId),
			});
			expect(
				adapter.compileUpdate({
					type: 'update',
					table: 'posts',
					set: { title: 'x' },
					where: exists('author'),
				}).sql,
			).toBe(
				'UPDATE posts SET title = $1 WHERE EXISTS (SELECT 1 FROM users AS users_exists_0 WHERE posts."authorCode" = users_exists_0.code)',
			);
		},
	);

	it('DELETE notExists uses the source primary key for an inverse relation', () => {
		const adapter = createPgCompileOnlyAdapter({
			model: modelWithImplicitKeys(),
		});
		expect(
			adapter.compileDelete({
				type: 'delete',
				table: 'users',
				where: notExists('authored'),
			}).sql,
		).toBe(
			'DELETE FROM users WHERE NOT (EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.code = posts_exists_0."authorCode"))',
		);
	});

	it('upsert action WHERE uses the target primary key', () => {
		const adapter = createPgCompileOnlyAdapter({
			model: modelWithImplicitKeys(),
		});
		expect(
			adapter.compileUpsert({
				type: 'upsert',
				table: 'posts',
				values: [{ id: 1, title: 'x' }],
				onConflict: { columns: ['id'] },
				action: {
					type: 'doUpdate',
					set: { title: 'x' },
					where: exists('author'),
				},
			}).sql,
		).toBe(
			'INSERT INTO posts (id, title) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET title = $3 WHERE EXISTS (SELECT 1 FROM users AS users_exists_0 WHERE posts."authorCode" = users_exists_0.code)',
		);
	});

	it('INSERT SELECT source WHERE uses the target primary key', () => {
		const adapter = createPgCompileOnlyAdapter({
			model: modelWithImplicitKeys(),
		});
		expect(
			adapter.compileInsertFrom({
				type: 'insert_from',
				table: 'posts_archive',
				source: 'posts',
				columns: ['id', 'title'],
				where: exists('author'),
			}).sql,
		).toBe(
			'INSERT INTO posts_archive (id, title) SELECT posts.id AS id, posts.title AS title FROM posts WHERE EXISTS (SELECT 1 FROM users AS users_exists_0 WHERE posts."authorCode" = users_exists_0.code)',
		);
	});

	it('refuses a relation without a declared foreign key', () => {
		const adapter = createPgCompileOnlyAdapter({
			model: modelWithImplicitKeys(false, { foreignKey: undefined }),
		});
		expect(() =>
			adapter.compileUpdate({
				type: 'update',
				table: 'posts',
				set: { title: 'x' },
				where: exists('author'),
			}),
		).toThrow(
			"Relation 'posts.author' is missing a declared foreign key column.",
		);
	});

	it('refuses mismatched relation key arity', () => {
		const adapter = createPgCompileOnlyAdapter({
			model: modelWithImplicitKeys(false, { foreignKey: ['authorCode', 'id'] }),
		});
		expect(() =>
			adapter.compileDelete({
				type: 'delete',
				table: 'users',
				where: notExists('authored'),
			}),
		).toThrow("Relation 'users.authored' has mismatched key arity.");
	});
});
