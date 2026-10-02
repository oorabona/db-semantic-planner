/** All fixtures enter through the public builder (planner for typed recursive anchors). */
import {
	and,
	any,
	caseWhen,
	createOrm,
	eq,
	every,
	exists,
	exprRef,
	fn,
	gt,
	gte,
	inArray,
	inSubquery,
	isDistinctFrom,
	isNotNull,
	isNull,
	like,
	literal,
	lt,
	lte,
	neq,
	none,
	not,
	notExists,
	or,
	planRecursive,
	rangeContainedBy,
	rangeContains,
	rangeOverlaps,
	rawExists,
	ref,
	schema,
	some,
	star,
	subquery,
} from '@dbsp/core';
import type { WhereIntent } from '@dbsp/types';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const columns = {
	id: { type: 'integer', primaryKey: true },
	name: { type: 'text' },
	score: { type: 'integer' },
	period: { type: 'daterange' },
	data: { type: 'jsonb' },
} as const;
const db = schema({
	users: columns,
	posts: {
		...columns,
		authorId: ref('users', { as: 'author', inverse: 'posts' }),
	},
	comments: {
		...columns,
		postId: ref('posts', { as: 'post', inverse: 'comments' }),
	},
	edges: {
		id: { type: 'integer', primaryKey: true },
		from_id: { type: 'integer' },
		to_id: { type: 'integer' },
	},
} as const);
const adapter = createPgCompileOnlyAdapter({ model: db.model });
const orm = createOrm({ schema: db, adapter });
type Result =
	| { sql: string; params: readonly unknown[] }
	| { sql: string; parameters: readonly unknown[] };
type Position = {
	name: string;
	table?: 'posts';
	field?: string;
	prefix?: string;
	run: (c: WhereIntent) => Result;
};
const positions: Position[] = [
	{ name: 'select-where', run: (c) => orm.select('users').where(c).dump() },
	{
		name: 'having-alias',
		field: 'n',
		run: (c) =>
			orm.select('users').count({ as: 'n' }).groupBy(['id']).having(c).dump(),
	},
	{
		name: 'select-filter',
		run: (c) =>
			orm
				.select('users')
				.columns([fn('count', star()).filter(c).as('n')])
				.dump(),
	},
	{
		name: 'having-filter',
		run: (c) =>
			orm
				.select('users')
				.groupBy(['id'])
				.having(fn('count', star()).filter(c).gt(19))
				.dump(),
	},
	{
		name: 'case-when',
		run: (c) =>
			orm
				.select('users')
				.columns([caseWhen(c, literal(11)).else(literal(22)).as('label')])
				.dump(),
	},
	{
		name: 'in-subquery-body',
		table: 'posts',
		run: (c) =>
			orm
				.select('users')
				.where(inSubquery('id', subquery('posts').select('authorId').where(c)))
				.dump(),
	},
	{
		name: 'scalar-subquery-body',
		table: 'posts',
		run: (c) =>
			orm
				.select('users')
				.where({
					kind: 'subquery',
					field: 'score',
					operator: 'eq',
					subquery: {
						type: 'select',
						from: 'posts',
						select: { type: 'fields', fields: ['score'] },
						where: c,
					},
				})
				.dump(),
	},
	{
		name: 'raw-exists-body',
		table: 'posts',
		run: (c) =>
			orm
				.select('users')
				.where(rawExists(subquery('posts').select('id').where(c)))
				.dump(),
	},
	...(['exists', 'notExists'] as const).map((name) => ({
		name: `relation-${name}`,
		table: 'posts' as const,
		run: (c: WhereIntent) =>
			orm
				.select('users')
				.where((name === 'exists' ? exists : notExists)('posts', { where: c }))
				.dump(),
	})),
	...(['some', 'every', 'none'] as const).map((name) => ({
		name: `relation-${name}`,
		table: 'posts' as const,
		run: (c: WhereIntent) =>
			orm
				.select('users')
				.where({ some, every, none }[name](orm.tables.users.posts, () => c))
				.dump(),
	})),
	{
		name: 'dotted-relation',
		prefix: 'posts.',
		run: (c) => orm.select('users').where(c).dump(),
	},
	{
		name: 'dotted-two-hop',
		prefix: 'posts.comments.',
		run: (c) => orm.select('users').where(c).dump(),
	},
	...(['inner', 'left'] as const).map((join) => ({
		name: `include-${join}-where`,
		table: 'posts' as const,
		run: (c: WhereIntent) =>
			orm
				.select('users')
				.where(eq('score', 31))
				.include('posts', { join, where: c })
				.dump(),
	})),
	{
		name: 'manual-join-on',
		run: (c) => orm.select('users').join('posts', { as: 'p', on: c }).dump(),
	},
	// orm.recursive(name, { base, step }) is the raw-CTE API and cannot express start.where.
	{
		name: 'recursive-start-where',
		run: (c) =>
			adapter.compileRecursive(
				planRecursive(
					{
						type: 'recursive',
						cteName: 'tree',
						start: {
							from: 'users',
							nodeIdExpr: { kind: 'column', name: 'id' },
							where: c,
						},
						traversal: {
							kind: 'edge-table',
							nodeTable: 'users',
							nodeId: 'id',
							edgeTable: 'edges',
							edgeFrom: 'from_id',
							edgeTo: 'to_id',
							direction: 'out',
						},
						maxDepth: 2,
					},
					db.model,
				),
				db.model,
			),
	},
	{
		name: 'update-where',
		run: (c) => orm.modify(orm.tables.users).set({ score: 41 }).where(c).dump(),
	},
	{
		name: 'delete-where',
		run: (c) => orm.removeFrom(orm.tables.users).where(c).dump(),
	},
	{
		name: 'upsert-guard',
		run: (c) =>
			orm
				.upsert('users')
				.values({ id: 1, score: 43 })
				.onConflict(['id'])
				.doUpdate({ score: 47 }, c)
				.dump(),
	},
];
function predicates(p: Position): [string, WhereIntent][] {
	const field = (name: string) =>
		`${p.prefix ?? ''}${name === 'period' || name === 'data' ? name : (p.field ?? name)}`;
	const child = p.table === 'posts' ? 'comments' : 'posts';
	const relation =
		p.table === 'posts' ? orm.tables.posts.comments : orm.tables.users.posts;
	const inner = subquery('posts').select('id').where(eq('score', 53));
	const range = { lower: '2026-01-01', upper: '2026-02-01' };
	return [
		...Object.entries({ eq, neq, gt, gte, lt, lte, isDistinctFrom }).map(
			([name, helper]): [string, WhereIntent] => [
				name,
				helper(field('score'), 7),
			],
		),
		['eq-null', eq(field('score'), null)],
		['like', like(field('name'), 'a%')],
		['ilike', like(field('name'), 'B%', true)],
		['like-escape', like(field('name'), 'c!_%', { escape: '!' })],
		['in-values', inArray(field('score'), [3, 5])],
		['in-empty', inArray(field('score'), [])],
		['any', any(field('score'), [3, 5])],
		['any-empty', any(field('score'), [])],
		['isNull', isNull(field('score'))],
		['isNotNull', isNotNull(field('score'))],
		[
			'between',
			{
				kind: 'range',
				field: field('period'),
				operator: 'between',
				value: range,
			},
		],
		['range-overlaps', rangeOverlaps(field('period'), range)],
		['range-contains', rangeContains(field('period'), range)],
		['range-contains-point', rangeContains(field('period'), '2026-01-15')],
		['range-containedBy', rangeContainedBy(field('period'), range)],
		[
			'jsonContains',
			{
				kind: 'jsonContains',
				field: field('data'),
				value: { active: true },
				reversed: false,
			},
		],
		[
			'jsonContainedBy',
			{
				kind: 'jsonContains',
				field: field('data'),
				value: { active: true },
				reversed: true,
			},
		],
		['jsonExists', { kind: 'jsonExists', field: field('data'), key: 'active' }],
		['inSubquery', inSubquery(field('id'), inner)],
		[
			'scalar-subquery',
			{
				kind: 'subquery',
				field: field('score'),
				operator: 'eq',
				subquery: {
					type: 'select',
					from: 'posts',
					select: { type: 'fields', fields: ['score'] },
					where: eq('score', 59),
				},
			},
		],
		['rawExists', rawExists(inner)],
		[
			'rawNotExists',
			{ kind: 'rawNotExists', subquery: inner.build().toIntent() },
		],
		['exists', exists(child, { where: eq('score', 61) })],
		['notExists', notExists(child, { where: eq('score', 61) })],
		['some', some(relation, () => eq('score', 61))],
		['every', every(relation, () => eq('score', 61))],
		['none', none(relation, () => eq('score', 61))],
		['expression', fn('length', exprRef(field('name'))).gt(2)],
		[
			'raw-expression',
			{
				kind: 'expression',
				expr: { kind: 'raw', sql: '1', as: 'predicate' },
				operator: 'eq',
				value: 1,
			},
		],
	];
}
export type MatrixOutcome =
	| { sql: string; params: readonly unknown[]; error: null }
	| { sql: null; params: null; error: string };
export const conditionMatrix = positions.flatMap((position) =>
	predicates(position).flatMap(([kind, predicate]) => {
		const field = `${position.prefix ?? ''}${position.field ?? 'score'}`;
		const sibling = eq(field, 13);
		const shapes: [string, WhereIntent][] = [
			['leaf', predicate],
			['and', and(predicate, sibling)],
			['or', or(predicate, sibling)],
			['not', not(predicate)],
			['empty-or', or()],
			['empty-and', and()],
			['two-level', and(sibling, or(not(predicate), eq(field, 17)))],
		];
		return shapes.map(([shape, condition]) => ({
			position: position.name,
			kind,
			shape,
			run(): MatrixOutcome {
				try {
					const result = position.run(condition);
					return {
						sql: result.sql,
						params: 'params' in result ? result.params : result.parameters,
						error: null,
					};
				} catch (error) {
					if (!(error instanceof Error)) throw error;
					return { sql: null, params: null, error: error.message };
				}
			},
		}));
	}),
);
