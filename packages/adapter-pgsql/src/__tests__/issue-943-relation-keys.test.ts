import { createOrm, exists, ModelIRImpl } from '@dbsp/core';
import type { RelationIR, TableIR } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

function ormFor(
	foreignKey?: string,
	defaultPkColumnName = 'wrong_pk',
	manager = false,
) {
	const table = (name: string, columns: string[]): TableIR => ({
		name,
		columns: columns.map((name) => ({ name, type: 'uuid', nullable: false })),
		primaryKey: 'uuid',
		foreignKeys: [],
		indexes: [],
	});
	const relation: RelationIR = {
		name: 'author',
		source: 'posts',
		target: 'users',
		type: 'belongsTo',
		cardinality: 'one',
		optionality: 'optional',
		includeStrategy: 'auto',
		joinDefault: 'auto',
		...(foreignKey === undefined ? {} : { foreignKey }),
	};
	const model = new ModelIRImpl(
		new Map([
			['posts', table('posts', ['uuid', 'author_uuid'])],
			['users', table('users', manager ? ['uuid', 'manager_uuid'] : ['uuid'])],
		]),
		new Map([
			['posts.author', relation],
			[
				'users.manager',
				{
					...relation,
					name: 'manager',
					source: 'users',
					foreignKey: 'manager_uuid',
				},
			],
		]),
	);
	const adapter = createPgCompileOnlyAdapter({
		model,
		defaultPkColumnName,
		deriveFkColumnName: () => {
			throw new Error('Model must own relation keys');
		},
	});
	return createOrm({ model, adapter });
}

describe('#943 declared model relation keys', () => {
	it.each(['uuid', 'wrong_pk'])(
		'includes using model keys with adapter PK %s',
		(defaultPk) => {
			const dump = ormFor('author_uuid', defaultPk)
				.select('posts')
				.include('author', { join: 'left' })
				.dump();
			expect(dump.sql).toMatchInlineSnapshot(
				`"SELECT posts.*, author.uuid AS "author.uuid", author.uuid AS __dbsp_presence_author FROM posts LEFT JOIN users AS author ON posts.author_uuid = author.uuid"`,
			);
			expect(dump.params).toEqual([]);
		},
	);
	it('joins using the same model authority', () => {
		expect(
			ormFor('author_uuid').select('posts').join('author').dump().sql,
		).toContain('posts.author_uuid = author.uuid');
	});
	it.each(['include', 'join', 'predicate'] as const)(
		'refuses a missing foreign key in %s',
		(consumer) => {
			const query = ormFor().select('posts');
			expect(() => {
				if (consumer === 'include')
					query.include('author', { join: 'left' }).dump();
				else if (consumer === 'join') query.join('author').dump();
				else query.where(exists('author')).dump();
			}).toThrow(
				"Relation 'posts.author' is missing a declared foreign key column.",
			);
		},
	);
	it.each(['include', 'join', 'predicate'] as const)(
		'planning refuses a missing foreign key in %s',
		(consumer) => {
			const query = ormFor().select('posts');
			expect(() => {
				if (consumer === 'include')
					query.include('author', { join: 'left' }).plan();
				else if (consumer === 'join') query.join('author').plan();
				else query.where(exists('author')).plan();
			}).toThrow(
				"Relation 'posts.author' is missing a declared foreign key column.",
			);
		},
	);
});

it('#943 recursive planning uses the declared primary key fallback', () => {
	const model = new ModelIRImpl(
		new Map([
			[
				'nodes',
				{
					name: 'nodes',
					primaryKey: 'uuid',
					foreignKeys: [],
					indexes: [],
					columns: ['uuid', 'parent_uuid'].map((name) => ({
						name,
						type: 'uuid',
						nullable: false,
					})),
				},
			],
		]),
		new Map([
			[
				'nodes.children',
				{
					name: 'children',
					source: 'nodes',
					target: 'nodes',
					type: 'hasMany',
					cardinality: 'many',
					optionality: 'optional',
					includeStrategy: 'auto',
					joinDefault: 'auto',
					foreignKey: 'parent_uuid',
				},
			],
		]),
	);
	const orm = createOrm({
		model,
		adapter: createPgCompileOnlyAdapter({
			model,
			defaultPkColumnName: 'wrong_pk',
		}),
	});
	expect(() =>
		orm
			.select('nodes')
			.include('children', { recursive: true, direction: 'descendants' })
			.plan(),
	).not.toThrow();
	expect(
		orm
			.select('nodes')
			.include('children', { recursive: true, direction: 'descendants' })
			.dump().sql,
	).toContain('__n.parent_uuid = nodes.uuid');
});
it('#943 EXISTS includes use the referenced model primary key', () => {
	const orm = ormFor('author_uuid', 'wrong_pk', true);
	expect(
		orm
			.select('posts')
			.where(exists('author', { include: { manager: { join: 'inner' } } }))
			.dump().sql,
	).toBe(
		'SELECT posts.* FROM posts WHERE EXISTS (SELECT 1 FROM users AS users_exists_0 JOIN users AS manager ON users_exists_0.manager_uuid = manager.uuid WHERE posts.author_uuid = users_exists_0.uuid)',
	);
});
