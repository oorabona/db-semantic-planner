import {
	and,
	createOrm,
	eq,
	exists,
	not,
	notExists,
	or,
	schema,
} from '@dbsp/core';
import type { ModelIR, RelationIR, WhereIntent } from '@dbsp/types';
import { expect, it } from 'vitest';
import { compileCondition } from '../condition-compiler.js';
import { createCompilerState } from '../handlers/types.js';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const base = schema({
	posts: { id: { type: 'integer', primaryKey: true } },
	tags: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		postId: 'integer',
	},
	postTags: { postId: 'integer', tagId: 'integer' },
}).model;
const relation: RelationIR = {
	name: 'tags',
	source: 'posts',
	target: 'tags',
	type: 'belongsToMany',
	through: 'postTags',
	foreignKey: 'postId',
	otherKey: 'tagId',
	cardinality: 'many',
	optionality: 'optional',
	includeStrategy: 'auto',
	joinDefault: 'auto',
};
const relations = new Map([
	['posts.tags', relation],
	[
		'posts.posts',
		{ ...relation, name: 'posts', target: 'posts', type: 'hasMany' as const },
	],
]);
const model: ModelIR = {
	...base,
	getTable: (name) => base.getTable(name),
	isAmbiguous: (source, target) => base.isAmbiguous(source, target),
	relations,
	getRelation: (name) => relations.get(name),
	getRelationsFrom: (source) =>
		[...relations.values()].filter((r) => r.source === source),
	getRelationsTo: (target) =>
		[...relations.values()].filter((r) => r.target === target),
};
const orm = createOrm({
	model,
	adapter: createPgCompileOnlyAdapter({ model }),
});
const forms = [
	'exists',
	'notExists',
	'some',
	'every',
	'none',
	'relationFilter',
] as const;
for (const form of forms) {
	const predicate: WhereIntent =
		form === 'exists' || form === 'notExists'
			? (form === 'exists' ? exists : notExists)('tags', {
					where: eq('name', 'admin'),
				})
			: {
					kind: 'relationFilter',
					relation: 'tags',
					where: eq('name', 'admin'),
					mode: form === 'relationFilter' ? 'some' : form,
				};
	const message = `WHERE ${predicate.kind}('tags'): many-to-many traversal is not supported yet (#787).`;
	for (const [route, wrap] of [
		['direct', (p: WhereIntent) => p],
		['legacy dotted', (p: WhereIntent) => and(p, eq('posts.id', 1))],
		['logical', (p: WhereIntent) => not(or(eq('id', 1), p))],
	] as const) {
		it(`${form} refuses ${route} root lowering`, () => {
			expect(() =>
				orm.select('posts').where(wrap(predicate)).dump(),
			).toThrowError(new Error(message));
		});
	}
	it(`${form} refuses direct compiler`, () => {
		expect(() =>
			compileCondition(predicate, {
				logicalSourceTable: 'posts',
				emittedAlias: 'posts',
				visibleAliases: new Map(),
				position: 'where',
				model,
				paramState: createCompilerState(),
				compileSubquery: () => {
					throw new Error('unexpected subquery');
				},
			}),
		).toThrowError(new Error(message));
	});
}
it('refuses a path containing a many-to-many hop', () => {
	expect(() =>
		orm
			.select('posts')
			.where({
				kind: 'relationFilter',
				relation: ['posts', 'tags'],
				where: eq('name', 'admin'),
				mode: 'some',
			})
			.dump(),
	).toThrowError(
		new Error(
			"WHERE relationFilter('posts.tags'): many-to-many traversal is not supported yet (#787).",
		),
	);
});
