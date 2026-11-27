import {
	and,
	caseWhen,
	createOrm,
	eq,
	exists,
	fn,
	literal,
	not,
	notExists,
	or,
	schema,
} from '@dbsp/core';
import type { ModelIR, RelationIR, WhereIntent } from '@dbsp/types';
import { NotYetSupportedError } from '@dbsp/types';
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
	const refusal = new NotYetSupportedError(
		`many-to-many traversal ${predicate.kind}('tags')`,
		'WHERE condition',
		787,
	);
	for (const [route, wrap] of [
		['direct', (p: WhereIntent) => p],
		['legacy dotted', (p: WhereIntent) => and(p, eq('posts.id', 1))],
		['logical', (p: WhereIntent) => not(or(eq('id', 1), p))],
	] as const) {
		it(`${form} refuses ${route} root lowering`, () => {
			expect(() =>
				orm.select('posts').where(wrap(predicate)).dump(),
			).toThrowError(refusal);
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
		).toThrowError(refusal);
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
		new NotYetSupportedError(
			"many-to-many traversal relationFilter('posts.tags')",
			'WHERE condition',
			787,
		),
	);
});
it('types the many-to-many refusal in HAVING, CASE WHEN, FILTER and mutation WHERE', () => {
	const refusal = (position: string) =>
		new NotYetSupportedError(
			"many-to-many traversal exists('tags')",
			`${position} condition`,
			787,
		);
	expect(() =>
		orm.select('posts').groupBy(['id']).having(exists('tags')).dump(),
	).toThrowError(NotYetSupportedError);
	expect(() =>
		orm.select('posts').groupBy(['id']).having(exists('tags')).dump(),
	).toThrowError(refusal('HAVING'));
	expect(() =>
		orm
			.select('posts')
			.columns([
				caseWhen(exists('tags'), literal('y')).else(literal('n')).as('t'),
			])
			.dump(),
	).toThrowError(refusal('CASE WHEN'));
	expect(() =>
		orm
			.select('posts')
			.columns([fn('count', '*').filter(exists('tags')).as('n')])
			.dump(),
	).toThrowError(refusal('FILTER'));
	expect(() =>
		orm.update('posts').set({ id: 2 }).where(exists('tags')).dump(),
	).toThrowError(refusal('WHERE'));
});
