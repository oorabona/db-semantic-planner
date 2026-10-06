import { describe, expect, it } from 'vitest';
import { ref, schema } from './dx/schema.js';
import { eq, exists, outerRef, POSTGRESQL_CAPABILITIES } from './index.js';
import { plan } from './planner.js';
import { resolveReportIncludes } from './resolved-includes.js';

const model = schema({
	users: { id: { type: 'integer', primaryKey: true }, name: 'text' },
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: 'text',
		authorId: ref('users', { as: 'author', inverse: 'authored' }),
	},
	comments: {
		id: { type: 'integer', primaryKey: true },
		body: 'text',
		postId: ref('posts', { as: 'post', inverse: 'comments' }),
	},
}).model;
describe('include predicate report construction', () => {
	it('stores a resolved condition and immediate source range', () => {
		const report = plan(
			{
				type: 'select',
				from: 'comments',
				include: [
					{
						relation: 'post',
						join: 'left',
						include: [
							{
								relation: 'author',
								join: 'left',
								where: eq('name', outerRef('title')),
							},
						],
					},
				],
			},
			model,
		);
		const parent = report.execution!.includes[0]!;
		const child = parent.children[0]!;
		expect(child.predicate!.outerRange).toBe(parent.outputRange);
		expect(child.predicate!.condition).toMatchObject({
			kind: 'comparison',
			left: { range: child.targetRange },
			right: { kind: 'outerRef', range: parent.outputRange, column: 'title' },
		});
	});
	it('runs the full tree refusal pre-pass before resolving any predicate', () => {
		expect(() =>
			plan(
				{
					type: 'select',
					from: 'posts',
					include: [
						{ relation: 'author', join: 'left', where: eq('nope', 1) },
						{ relation: 'author', join: 'left', where: exists('nope') },
					],
				},
				model,
			),
		).toThrow(
			new Error(
				'Relation predicates inside an include where are not supported yet at include[1](author).where for strategy join (oorabona/db-semantic-planner#892).',
			),
		);
	});
	it('keeps the authored include key in the strategy refusal', () => {
		expect(() =>
			resolveReportIncludes(
				{
					type: 'select',
					from: 'posts',
					include: [{ relation: 'users', via: 'author', where: eq('nope', 1) }],
				},
				[],
				model,
			),
		).toThrow(
			new Error(
				'Include where is not supported for strategy json_agg at include[0](users).where (oorabona/db-semantic-planner#892).',
			),
		);
	});
	it('keeps planner foreign-key refusals ahead of the include predicate pre-pass', () => {
		const broken = new Proxy(model, {
			get(target, property) {
				if (property === 'getRelation')
					return (name: string) => {
						const relation = target.getRelation(name);
						return relation?.source === 'posts' && relation.name === 'author'
							? { ...relation, foreignKey: undefined }
							: relation;
					};
				if (property === 'getRelationsFrom')
					return (table: string) =>
						target
							.getRelationsFrom(table)
							.map((relation) =>
								table === 'posts' && relation.name === 'author'
									? { ...relation, foreignKey: undefined }
									: relation,
							);
				const member = Reflect.get(target, property);
				return typeof member === 'function' ? member.bind(target) : member;
			},
		});
		expect(() =>
			plan(
				{
					type: 'select',
					from: 'users',
					include: [{ relation: 'authored', where: exists('author') }],
				},
				broken,
				{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
			),
		).toThrow(
			new Error(
				"Relation 'posts.author' is missing a declared foreign key column.",
			),
		);
	});
	it('keeps qualified field refusal text without relation-path resolution', () => {
		expect(() =>
			plan(
				{
					type: 'select',
					from: 'posts',
					include: [
						{ relation: 'author', join: 'left', where: eq('nope.name', 1) },
					],
				},
				model,
			),
		).toThrow(
			new Error(
				"Declared column 'nope.name' is absent from the physical model.",
			),
		);
	});
	it('refuses missing columns during planning after strategy validation', () => {
		expect(() =>
			plan(
				{
					type: 'select',
					from: 'posts',
					include: [{ relation: 'author', join: 'left', where: eq('nope', 1) }],
				},
				model,
			),
		).toThrow(
			new Error(
				"Declared column 'users.nope' is absent from the physical model.",
			),
		);
	});
});
