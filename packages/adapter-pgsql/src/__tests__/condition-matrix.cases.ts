/**
 * Fixtures enter through public builders (planner for typed recursive anchors).
 * Ordered subqueries use QueryIntent because SubqueryBuilder has no order/limit API.
 * Custom authorities enter through createPgCompileOnlyAdapter constructor options;
 * the same position builders exercise every entry it can reach, including errors.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
type MatrixOrm = typeof orm;
function makePositions(
	orm: MatrixOrm,
	adapter: ReturnType<typeof createPgCompileOnlyAdapter>,
	model: typeof db.model = db.model,
): Position[] {
	return [
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
					.where(
						inSubquery('id', subquery('posts').select('authorId').where(c)),
					)
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
					.where(
						(name === 'exists' ? exists : notExists)('posts', { where: c }),
					)
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
			run: (c: WhereIntent) => {
				const report = orm
					.select('comments')
					.where(eq('score', 31))
					.include('post', { join, where: c })
					.plan();
				const poisoned = new Proxy(model, {
					get(target, property) {
						if (property === 'getRelation' || property === 'getRelationsFrom')
							return () => {
								throw new Error('include relation lookup after planning');
							};
						const member = Reflect.get(target, property);
						return typeof member === 'function' ? member.bind(target) : member;
					},
				});
				const compile = (model: typeof db.model): MatrixOutcome => {
					try {
						const result = adapter.compile(report, { model });
						return { sql: result.sql, params: result.parameters, error: null };
					} catch (error) {
						if (!(error instanceof Error)) throw error;
						return { sql: null, params: null, error: error.message };
					}
				};
				const canonical = compile(model);
				const actual = compile(poisoned);
				if (JSON.stringify(actual) !== JSON.stringify(canonical))
					throw new Error('poisoned include compilation differs');
				if (actual.error !== null) throw new Error(actual.error);
				return { sql: actual.sql!, params: actual.params! };
			},
		})),
		{
			name: 'manual-join-on',
			run: (c) => {
				const report = orm
					.select('users')
					.join('posts', { as: 'p', on: c })
					.plan();
				const poisoned = new Proxy(model, {
					get(target, property) {
						if (property === 'getRelation' || property === 'getRelationsFrom')
							return () => {
								throw new Error('join relation lookup after planning');
							};
						const member = Reflect.get(target, property);
						return typeof member === 'function' ? member.bind(target) : member;
					},
				});
				const compile = (authority: typeof model): MatrixOutcome => {
					try {
						const result = adapter.compile(report, { model: authority });
						return { sql: result.sql, params: result.parameters, error: null };
					} catch (error) {
						if (!(error instanceof Error)) throw error;
						return { sql: null, params: null, error: error.message };
					}
				};
				const canonical = compile(model);
				const compiled = compile(poisoned);
				if (JSON.stringify(compiled) !== JSON.stringify(canonical))
					throw new Error('poisoned join compilation differs');
				if (compiled.error !== null) throw new Error(compiled.error);
				return { sql: compiled.sql, params: compiled.params };
			},
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
						model,
					),
					model,
				),
		},
		{
			name: 'recursive-start-where-adjacency',
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
								kind: 'adjacency',
								nodeTable: 'users',
								nodeId: 'id',
								parentId: 'score',
								direction: 'descendants',
							},
							maxDepth: 2,
						},
						model,
					),
					model,
				),
		},
		{
			name: 'update-where',
			run: (c) =>
				orm.modify(orm.tables.users).set({ score: 41 }).where(c).dump(),
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
}
const positions = makePositions(orm, adapter);
// The extra declared columns let both conventions produce SQL instead of failing
// declared-name validation before the FK derivation can become observable.
const authorityColumns = {
	...columns,
	matrix_pk: { type: 'integer' },
	matrix_users_matrix_pk: { type: 'integer' },
	matrix_posts_matrix_pk: { type: 'integer' },
	matrix_comments_matrix_pk: { type: 'integer' },
} as const;
const authorityDb = schema({
	users: authorityColumns,
	posts: {
		...authorityColumns,
		authorId: ref('users', { as: 'author', inverse: 'posts' }),
	},
	comments: {
		...authorityColumns,
		postId: ref('posts', { as: 'post', inverse: 'comments' }),
	},
	edges: {
		id: { type: 'integer', primaryKey: true },
		from_id: { type: 'integer' },
		to_id: { type: 'integer' },
	},
} as const);
const authorityAdapter = createPgCompileOnlyAdapter({
	model: authorityDb.model,
	defaultPkColumnName: 'matrix_pk',
	deriveFkColumnName: (table, pk) => `matrix_${table}_${pk}`,
});
const authorityPositions = makePositions(
	createOrm({ schema: authorityDb, adapter: authorityAdapter }),
	authorityAdapter,
	authorityDb.model,
);
// Disable implicit PK inference; refs target unique columns on tables with no PK.
function keyFallbackPositions(custom: boolean) {
	const fallbackColumns = {
		...authorityColumns,
		id: { type: 'integer', unique: true },
		matrix_pk: { type: 'integer', unique: true },
	} as const;
	const fallbackDb = schema(
		{
			users: fallbackColumns,
			posts: {
				...fallbackColumns,
				authorId: ref('users', {
					as: 'author',
					inverse: 'posts',
					references: [custom ? 'matrix_pk' : 'id'],
				}),
			},
			comments: {
				...fallbackColumns,
				postId: ref('posts', {
					as: 'post',
					inverse: 'comments',
					references: [custom ? 'matrix_pk' : 'id'],
				}),
			},
			edges: {
				id: { type: 'integer', primaryKey: true },
				from_id: { type: 'integer' },
				to_id: { type: 'integer' },
			},
		} as const,
		undefined,
		{ defaultPkColumnName: null },
	);
	const fallbackAdapter = createPgCompileOnlyAdapter({
		model: fallbackDb.model,
		...(custom
			? {
					defaultPkColumnName: 'matrix_pk',
					deriveFkColumnName: (table: string, pk: string) =>
						`matrix_${table}_${pk}`,
				}
			: {}),
	});
	const fallbackOrm = createOrm({
		schema: fallbackDb,
		adapter: fallbackAdapter,
	});
	return {
		orm: fallbackOrm,
		positions: makePositions(fallbackOrm, fallbackAdapter, fallbackDb.model),
	};
}
const fallbackDefaultPositions = keyFallbackPositions(false);
const fallbackCustomPositions = keyFallbackPositions(true);
function predicates(
	p: Position,
	matrixOrm: MatrixOrm = orm,
): [string, WhereIntent][] {
	const field = (name: string) =>
		`${p.prefix ?? ''}${name === 'period' || name === 'data' ? name : (p.field ?? name)}`;
	const child = p.table === 'posts' ? 'comments' : 'posts';
	const relation =
		p.table === 'posts'
			? matrixOrm.tables.posts.comments
			: matrixOrm.tables.users.posts;
	const inner = subquery('posts').select('id').where(eq('score', 53));
	const ordered = {
		...subquery('posts')
			.select('score')
			.where(eq('score', 59))
			.build()
			.toIntent(),
		orderBy: [{ field: 'score', direction: 'desc' as const }],
		limit: 1,
	};
	const range = { lower: '2026-01-01', upper: '2026-02-01' };
	return [
		...Object.entries({ eq, neq, gt, gte, lt, lte, isDistinctFrom }).map(
			([name, helper]): [string, WhereIntent] => [
				name,
				helper(field('score'), 7),
			],
		),
		['eq-null', eq(field('score'), null)],
		['neq-null', neq(field('score'), null)],
		['isDistinctFrom-null', isDistinctFrom(field('score'), null)],
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
			'rawExists-like-escape',
			rawExists(
				subquery('posts')
					.select('id')
					.where(like('name', 'c!_%', { escape: '!' })),
			),
		],
		[
			'rawExists-range',
			rawExists(
				subquery('posts').select('id').where(rangeOverlaps('period', range)),
			),
		],
		[
			'inSubquery-order-limit',
			{ kind: 'in', field: field('id'), subquery: ordered },
		],
		['rawExists-order-limit', { kind: 'rawExists', subquery: ordered }],
		[
			'scalar-subquery-order-limit',
			{
				kind: 'subquery',
				field: field('score'),
				operator: 'eq',
				subquery: ordered,
			},
		],
		[
			'expression-scalar-subquery',
			{
				kind: 'expression',
				expr: { kind: 'subquery', query: ordered },
				operator: 'gt',
				value: 67,
			},
		],
		...(['exists', 'notExists'] as const).flatMap(
			(kind): [string, WhereIntent][] =>
				(['up', 'down'] as const).map((direction) => [
					`${kind}-recursive-${direction}`,
					{
						kind,
						relation: child,
						where: eq('score', 71),
						recursive: { direction, through: child, maxDepth: 3 },
					},
				]),
		),

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
	[
		...predicates(position).map(([kind, predicate]) => ({
			kind,
			predicate,
			runPosition: position,
		})),
		...predicates(position)
			.filter(([kind]) =>
				['exists', 'notExists', 'some', 'every', 'none'].includes(kind),
			)
			.map(([kind, predicate]) => ({
				kind: `${kind}-custom-authorities`,
				predicate,
				runPosition: authorityPositions.find(
					({ name }) => name === position.name,
				)!,
			})),
		...[false, true].flatMap((custom) =>
			predicates(
				position,
				(custom ? fallbackCustomPositions : fallbackDefaultPositions).orm,
			)
				.filter(([kind]) =>
					['exists', 'notExists', 'some', 'every', 'none'].includes(kind),
				)
				.map(([kind, predicate]) => ({
					kind: `${kind}-no-pk-${custom ? 'custom' : 'default'}-authorities`,
					predicate,
					runPosition: (custom
						? fallbackCustomPositions
						: fallbackDefaultPositions
					).positions.find(({ name }) => name === position.name)!,
				})),
		),
	].flatMap(({ kind, predicate, runPosition }) => {
		const field = `${position.prefix ?? ''}${position.field ?? 'score'}`;
		const sibling = eq(field, 13);
		const shapes: [string, WhereIntent][] = [
			['leaf', predicate],
			['and', and(predicate, sibling)],
			['or', or(predicate, sibling)],
			['not', not(predicate)],
			// Empty groups have no predicate. Keep one existing key per observable
			// envelope: custom key authorities affect IN, relation and include bodies.
			...(kind === 'eq' ||
			(kind === 'exists-custom-authorities' &&
				(position.name === 'in-subquery-body' ||
					position.name.startsWith('relation-') ||
					position.name.startsWith('include-')))
				? ([
						['empty-or', or()],
						['empty-and', and()],
					] satisfies [string, WhereIntent][])
				: []),
			['two-level', and(sibling, or(not(predicate), eq(field, 17)))],
		];
		return shapes.map(([shape, condition]) => ({
			position: position.name,
			kind,
			shape,
			run(): MatrixOutcome {
				try {
					const result = runPosition.run(condition);
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

// Keep bounded refusal probes alongside the to-one condition compilation positions.
for (const join of ['inner', 'left'] as const) {
	for (const [shape, condition] of [
		['leaf', eq('score', 19)],
		['or', or(eq('score', 19), eq('score', 23))],
	] as const) {
		conditionMatrix.push({
			position: `include-${join}-to-many-refusal`,
			kind: 'eq',
			shape,
			run(): MatrixOutcome {
				try {
					const result = orm
						.select('users')
						.include('posts', { join, where: condition })
						.dump();
					return { sql: result.sql, params: result.params, error: null };
				} catch (error) {
					if (!(error instanceof Error)) throw error;
					return { sql: null, params: null, error: error.message };
				}
			},
		});
	}
}

/** The directory holds only generated JSON parts; explicit rewrite prunes stale parts. */
export function prepareConditionMatrix(
	baselineDirectory: URL,
	matrix: typeof conditionMatrix,
	rewrite = process.env.CONDITION_MATRIX_REWRITE === '1',
) {
	const directory = fileURLToPath(baselineDirectory);
	const matrixPositions = [...new Set(matrix.map(({ position }) => position))];
	// Fixed-size ordered shards keep every artifact below 200 KB, even for long SQL.
	const shards = matrixPositions.flatMap((position) => {
		const entries = matrix.filter((entry) => entry.position === position);
		return Array.from(
			{ length: Math.ceil(entries.length / 100) },
			(_, index) => ({
				path: pathToFileURL(
					join(
						directory,
						`${position}${index === 0 ? '' : `.${String(index + 1).padStart(3, '0')}`}.json`,
					),
				),
				entries: entries.slice(index * 100, (index + 1) * 100),
			}),
		);
	});

	// Explicit opt-in only.
	if (rewrite) {
		mkdirSync(baselineDirectory, { recursive: true });
		shards.forEach(({ path, entries }) => {
			writeFileSync(
				path,
				`${JSON.stringify({ entries: entries.map(({ position, kind, shape, run }) => ({ position, kind, shape, ...run() })) }, null, 2)}\n`,
			);
		});

		const inventory = new Set(
			shards.map(({ path }) => basename(fileURLToPath(path))),
		);
		for (const name of readdirSync(baselineDirectory)) {
			if (name.endsWith('.json') && !inventory.has(name)) {
				rmSync(join(directory, name), { force: true });
			}
		}

		if (shards.length > 0)
			execFileSync(
				fileURLToPath(
					new URL('../../../../node_modules/.bin/biome', import.meta.url),
				),
				['format', '--write', ...shards.map(({ path }) => fileURLToPath(path))],
				{ cwd: fileURLToPath(baselineDirectory) },
			);
	}
	return shards;
}
