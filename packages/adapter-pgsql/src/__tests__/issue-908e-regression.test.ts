import {
	cast,
	createOrm,
	exprRef,
	fn,
	ResultHydrator,
	ref,
	relationColumn,
	schema,
	star,
} from '@dbsp/core';
import { expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const model = schema({
	users: { id: { type: 'integer', primaryKey: true }, name: 'text' },
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: 'text',
		authorId: ref('users', { as: 'author' }),
		__dbspPresenceAuthor: 'text',
	},
}).model;
const adapter = createPgCompileOnlyAdapter({ model });
const orm = createOrm({ model, adapter });
const payloadSql =
	'author.id AS "author.id", author.name AS "author.name", author.id AS __dbsp_presence_author FROM posts LEFT JOIN users AS author ON posts."authorId" = author.id';
it('908e: field projection before include keeps its payload', () => {
	const query = orm
		.select('posts')
		.columns(['title'])
		.include('author', { join: 'left' });
	expect(query.dump().sql).toBe(`SELECT posts.title, ${payloadSql}`);
	const report = query.plan();
	const compiled = adapter.compile(report);
	const rows = [
		{
			title: 'Hello',
			'author.id': 7,
			'author.name': 'Ada',
			__dbsp_presence_author: 7,
		},
	];
	new ResultHydrator(model, 'posts').hydrateJoinIncludes(
		rows,
		report,
		compiled,
	);
	expect(rows).toEqual([{ title: 'Hello', author: { id: 7, name: 'Ada' } }]);
});
it('908e: scalar expression after include keeps its SQL and hydrated payload', () => {
	const query = orm
		.select('posts')
		.include('author', { join: 'left' })
		.columns([fn('upper', exprRef('title')).as('t')]);
	expect(query.dump().sql).toBe(`SELECT upper(title) AS t, ${payloadSql}`);
	const report = query.plan();
	const compiled = adapter.compile(report);
	const rows = [
		{
			t: 'HELLO',
			'author.id': 7,
			'author.name': 'Ada',
			__dbsp_presence_author: 7,
		},
	];
	new ResultHydrator(model, 'posts').hydrateJoinIncludes(
		rows,
		report,
		compiled,
	);
	expect(rows).toEqual([{ t: 'HELLO', author: { id: 7, name: 'Ada' } }]);
});
const refusal =
	"Include include[0](author) cannot use 'join' with aggregation, groupBy or DISTINCT because its data would be dropped. Use .join() for relational columns, grouping or ordering.";
for (const [name, expression] of [
	['count', fn('count', star()).as('n')],
	['nested count', cast(fn('round', fn('count', star())), 'integer').as('n')],
] as const) {
	it(`908e: ${name} refuses at plan and external compile and excludes join alternatives`, () => {
		const query = orm
			.select('posts')
			.include('author', { join: 'left', select: { type: 'all' } })
			.columns([expression]);
		expect(() => query.plan()).toThrow(`Invalid include: ${refusal}`);
		const report = orm
			.select('posts')
			.include('author', { join: 'left', select: { type: 'all' } })
			.plan();
		const select = orm.select('posts').columns([expression]).plan().intent!
			.select!;
		expect(() =>
			adapter.compile({ ...report, intent: { ...report.intent!, select } }),
		).toThrow(
			new Error(
				'Adapter compilation requires a report planned by this loaded copy of dbsp (plan(), the ORM or NQL); plan the query with this loaded copy, or use compilePlan from @dbsp/adapter-pgsql/internal for decision-level compilation',
			),
		);
		expect(
			orm
				.select('posts')
				.columns([expression])
				.include('author')
				.plan()
				.decisions.find((d) => d.type === 'include-strategy')?.alternatives,
		).not.toContain('join');
	});
}
for (const [name, expression] of [
	['unaliased ref', exprRef('__dbspPresenceAuthor')],
	['cast ref', cast(cast(exprRef('__dbspPresenceAuthor'), 'text'), 'text')],
] as const) {
	it(`908e: marker avoids emitted snake case ${name} and is removed on hydration`, () => {
		const snakeAdapter = createPgCompileOnlyAdapter({
			model,
			dbCasing: 'snake_case',
		});
		const query = createOrm({ model, adapter: snakeAdapter })
			.select('posts')
			.include('author', { join: 'left' })
			.columns([expression, relationColumn('author', 'name', 'name')]);
		const report = query.plan();
		const compiled = snakeAdapter.compile(report);
		const marker =
			compiled.hydrationPlan!.includePayloads![0]!.presence!.outputLabel;
		expect(marker).toBe('__dbsp_presence_author_1');
		expect(compiled.sql).toBe(
			`SELECT ${name === 'cast ref' ? 'CAST(CAST(__dbsp_presence_author AS text) AS text)' : '__dbsp_presence_author'}, author.name AS "author.name", author.id AS ${marker} FROM posts LEFT JOIN users AS author ON posts.author_id = author.id`,
		);
		const rows = [
			{ __dbsp_presence_author: 'root', 'author.name': 'Ada', [marker]: 7 },
		];
		new ResultHydrator(model, 'posts').hydrateJoinIncludes(
			rows,
			report,
			compiled,
		);
		expect(rows).toEqual([
			{ __dbsp_presence_author: 'root', author: { name: 'Ada' } },
		]);
	});
}

it('908e: marker allocation ignores unselected root columns', () => {
	const snakeAdapter = createPgCompileOnlyAdapter({
		model,
		dbCasing: 'snake_case',
	});
	const query = createOrm({ model, adapter: snakeAdapter })
		.select('posts')
		.include('author', { join: 'left' })
		.columns([relationColumn('author', 'name', 'name')]);
	expect(query.dump().sql).toBe(
		'SELECT author.name AS "author.name", author.id AS __dbsp_presence_author FROM posts LEFT JOIN users AS author ON posts.author_id = author.id',
	);
});
