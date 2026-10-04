import {
	createOrm,
	eq,
	ResultHydrator,
	ref,
	relationColumn,
	schema,
} from '@dbsp/core';
import { expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const model = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text', nullable: true },
		email: { type: 'text', nullable: true },
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		authorId: ref('users', { as: 'author', inverse: 'posts', nullable: true }),
		title: { type: 'text' },
	},
}).model;
const adapter = createPgCompileOnlyAdapter({ model });
const orm = createOrm({ model, adapter });

for (const join of ['left', 'inner'] as const) {
	for (const select of [undefined, { type: 'all' as const }]) {
		it(`whole related row: ${join}, ${select ? 'all' : 'omitted'}`, () => {
			const query = orm
				.select('posts')
				.include('author', { join, ...(select && { select }) });
			expect(query.dump().sql).toBe(
				`SELECT posts.*, author.id AS "author.id", author.name AS "author.name", author.email AS "author.email", author.id AS __dbsp_presence_author FROM posts ${join === 'left' ? 'LEFT JOIN' : 'JOIN'} users AS author ON posts."authorId" = author.id`,
			);
		});
	}
}
it('field selection returns exactly the requested fields', () => {
	const query = orm.select('posts').include('author', {
		join: 'left',
		select: { type: 'fields', fields: ['name', 'email'] },
	});
	expect(query.dump().sql).toBe(
		'SELECT posts.*, author.name AS "author.name", author.email AS "author.email", author.id AS __dbsp_presence_author FROM posts LEFT JOIN users AS author ON posts."authorId" = author.id',
	);
	const report = query.plan();
	const compiled = adapter.compile(report, { model });
	const rows = [
		{
			id: 1,
			'author.name': 'Ada',
			'author.email': null,
			__dbsp_presence_author: 7,
		},
	];
	new ResultHydrator(model, 'posts').hydrateJoinIncludes(
		rows,
		report,
		compiled,
	);
	expect(rows).toEqual([{ id: 1, author: { name: 'Ada', email: null } }]);
});
it('all-null selected values belong to an existing object; a missing row is null; markers are private', async () => {
	const executionAdapter = createPgCompileOnlyAdapter({ model });
	Object.defineProperty(executionAdapter, 'connectionAvailability', {
		value: { status: 'available' },
	});
	const query = createOrm({ model, adapter: executionAdapter })
		.select('posts')
		.include('author', {
			join: 'left',
			select: { type: 'fields', fields: ['name', 'email'] },
		});
	const rows = [
		{
			id: 1,
			'author.name': null,
			'author.email': null,
			__dbsp_presence_author: 7,
		},
		{
			id: 2,
			'author.name': null,
			'author.email': null,
			__dbsp_presence_author: null,
		},
	];
	executionAdapter.execute = async <T>() => structuredClone(rows) as T[];
	expect(await query.all()).toEqual([
		{ id: 1, author: { name: null, email: null } },
		{ id: 2, author: null },
	]);
});
const refusal =
	"Include include[0](posts) cannot use 'join' for a to-many relation. Use .join(), NQL | flat, or a json_agg/lateral include.";
for (const join of ['left', 'inner'] as const)
	it(`to-many ${join} is refused at plan()`, () => {
		expect(() => orm.select('users').include('posts', { join }).plan()).toThrow(
			`Invalid include: ${refusal}`,
		);
	});
it('to-many join default is refused at plan()', () => {
	expect(() =>
		orm
			.select('users')
			.withPlanOptions({ defaultIncludeStrategy: 'join' })
			.include('posts')
			.plan(),
	).toThrow(`Invalid include: ${refusal}`);
});
it('adapter refuses an external to-many join report', () => {
	const report = orm.select('users').include('posts').plan();
	const external = {
		...report,
		decisions: report.decisions.map((d) =>
			d.type === 'include-strategy' ? { ...d, choice: 'join' } : d,
		),
	};
	expect(() => adapter.compile(external, { model })).toThrow(refusal);
});
it('join include where stays in root WHERE', () => {
	expect(
		orm
			.select('posts')
			.include('author', { join: 'left', where: eq('name', 'Ada') })
			.dump(),
	).toMatchObject({
		sql: 'SELECT posts.*, author.id AS "author.id", author.name AS "author.name", author.email AS "author.email", author.id AS __dbsp_presence_author FROM posts LEFT JOIN users AS author ON posts."authorId" = author.id WHERE author.name = $1',
		params: ['Ada'],
	});
});
it('a relation join hint refuses a to-many include', () => {
	const hintModel = schema({
		users: { id: { type: 'integer', primaryKey: true } },
		posts: {
			id: { type: 'integer', primaryKey: true },
			userId: ref('users', { inverse: 'posts' }),
		},
	}).model;
	Object.assign(hintModel.getRelation('users.posts')!, {
		includeStrategy: 'join',
	});
	const hintOrm = createOrm({
		model: hintModel,
		adapter: createPgCompileOnlyAdapter({ model: hintModel }),
	});
	expect(() => hintOrm.select('users').include('posts').plan()).toThrow(
		`Invalid include: ${refusal}`,
	);
});
it('presence labels cannot collide with root or payload keys', () => {
	const collisionModel = schema({
		users: {
			id: { type: 'integer', primaryKey: true },
			__dbsp_presence_author: { type: 'text', nullable: true },
		},
		posts: {
			id: { type: 'integer', primaryKey: true },
			authorId: ref('users', { as: 'author' }),
			__dbsp_presence_author: 'text',
		},
	}).model;
	const collisionAdapter = createPgCompileOnlyAdapter({
		model: collisionModel,
	});
	const builder = createOrm({
		model: collisionModel,
		adapter: collisionAdapter,
	})
		.select('posts')
		.include('author', { join: 'left' });
	const report = builder.plan();
	const compiled = collisionAdapter.compile(report);
	const shape = compiled.hydrationPlan!.includePayloads![0]!;
	expect(shape.presence).toEqual({
		physicalName: 'id',
		outputLabel: '__dbsp_presence_author_1',
	});
	const rows = [
		{
			id: 1,
			authorId: 7,
			__dbsp_presence_author: 'root',
			'author.id': 7,
			'author.__dbsp_presence_author': null,
			__dbsp_presence_author_1: 7,
		},
	];
	new ResultHydrator(collisionModel, 'posts').hydrateJoinIncludes(
		rows,
		report,
		compiled,
	);
	expect(rows).toEqual([
		{
			id: 1,
			authorId: 7,
			__dbsp_presence_author: 'root',
			author: { id: 7, __dbsp_presence_author: null },
		},
	]);
});
it('a keyless target uses a constant inside the joined target', () => {
	const keylessModel = schema(
		{
			users: {
				id: { type: 'text', unique: true },
				name: { type: 'text', nullable: true },
			},
			posts: {
				id: { type: 'integer', primaryKey: true },
				authorCode: ref('users', { as: 'author', references: ['id'] }),
			},
		},
		undefined,
		{ defaultPkColumnName: null },
	).model;
	const keylessAdapter = createPgCompileOnlyAdapter({ model: keylessModel });
	const builder = createOrm({ model: keylessModel, adapter: keylessAdapter })
		.select('posts')
		.include('author', {
			join: 'left',
			select: { type: 'fields', fields: ['name'] },
		});
	const report = builder.plan();
	const compiled = keylessAdapter.compile(report);
	expect(compiled.sql).toBe(
		'SELECT posts.*, author.name AS "author.name", author.__dbsp_presence_author AS __dbsp_presence_author FROM posts LEFT JOIN (SELECT author.id, author.name, 1 AS __dbsp_presence_author FROM users AS author) AS author ON posts."authorCode" = author.id',
	);
	const rows = [
		{ 'author.name': null, __dbsp_presence_author: 1 },
		{ 'author.name': null, __dbsp_presence_author: null },
	];
	new ResultHydrator(keylessModel, 'posts').hydrateJoinIncludes(
		rows,
		report,
		compiled,
	);
	expect(rows).toEqual([{ author: { name: null } }, { author: null }]);
});
it('adapter resolves to-many cardinality from the model when an external report omits it', () => {
	const report = orm.select('users').include('posts').plan();
	const decisions = report.decisions.map((d) => {
		if (d.type !== 'include-strategy') return d;
		const context = { ...d.context };
		delete context.relationType;
		return { ...d, choice: 'join', context };
	});
	expect(() => adapter.compile({ ...report, decisions }, { model })).toThrow(
		refusal,
	);
});
it('lateral transport uses a private marker even when selected fields are all null', () => {
	const builder = orm
		.select('posts')
		.withPlanOptions({ defaultIncludeStrategy: 'lateral' })
		.include('author')
		.columns([
			relationColumn('author', 'name', 'name'),
			relationColumn('author', 'email', 'email'),
		]);
	const report = builder.plan();
	const compiled = adapter.compile(report);
	expect(compiled.sql).toBe(
		'SELECT users_lat_0.name AS "author.name", users_lat_0.email AS "author.email", users_lat_0.__dbsp_presence_author AS __dbsp_presence_author FROM posts LEFT JOIN LATERAL (SELECT users_inner_0.name, users_inner_0.email, users_inner_0.id AS __dbsp_presence_author FROM users AS users_inner_0 WHERE users_inner_0.id = posts."authorId") AS users_lat_0 ON true',
	);
	const rows = [
		{ 'author.name': null, 'author.email': null, __dbsp_presence_author: 7 },
		{ 'author.name': null, 'author.email': null, __dbsp_presence_author: null },
	];
	new ResultHydrator(model, 'posts').hydrateJoinIncludes(
		rows,
		report,
		compiled,
	);
	expect(rows).toEqual([
		{ author: { name: null, email: null } },
		{ author: null },
	]);
});
it('an explicit empty field selection returns an empty object or null using only the private marker', () => {
	const builder = orm.select('posts').include('author', {
		join: 'left',
		select: { type: 'fields', fields: [] },
	});
	const report = builder.plan();
	const compiled = adapter.compile(report);
	expect(compiled.sql).toBe(
		'SELECT posts.*, author.id AS __dbsp_presence_author FROM posts LEFT JOIN users AS author ON posts."authorId" = author.id',
	);
	const rows = [
		{ __dbsp_presence_author: 7 },
		{ __dbsp_presence_author: null },
	];
	new ResultHydrator(model, 'posts').hydrateJoinIncludes(
		rows,
		report,
		compiled,
	);
	expect(rows).toEqual([{ author: {} }, { author: null }]);
});
