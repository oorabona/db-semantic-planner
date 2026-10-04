import {
	createOrm,
	eq,
	exists,
	inSubquery,
	outerRef,
	rawExists,
	ref,
	schema,
	subquery,
} from '@dbsp/core';
import { rawNotExists } from '@dbsp/core/internal';
import type { CompileOptions, PlanReport } from '@dbsp/types';
import { createPhysicalNameInventory } from '@dbsp/types/internal';
import { expect, it } from 'vitest';
import { compileSelect } from '../adapter-compiler-select.js';
import { defaultFkDerivation } from '../assert-field.js';
import { createDeclaredNameResolver } from '../declared-name-resolver.js';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';
import { createPgPhysicalModel } from '../physical-model/index.js';

const db = schema({
	calls: {
		id: { type: 'integer', primaryKey: true },
		callerId: ref('symbols', { as: 'caller' }),
		calleeId: ref('symbols', { as: 'callee' }),
	},
	symbols: { id: { type: 'integer', primaryKey: true }, name: 'text' },
	posts: { id: { type: 'integer', primaryKey: true } },
	comments: { id: { type: 'integer', primaryKey: true }, postId: 'integer' },
	userProfiles: {
		id: { type: 'integer', primaryKey: true },
		fileId: ref('files', { as: 'file' }),
	},
	nodes: {
		id: { type: 'integer', primaryKey: true },
		parentId: ref('nodes', {
			roles: { parent: 'parent', children: 'children' },
		}),
	},
	files: { id: { type: 'integer', primaryKey: true } },
});
const orm = createOrm({
	schema: db,
	adapter: createPgCompileOnlyAdapter({ model: db.model }),
});
const body = (q: string) =>
	rawExists(
		subquery('comments')
			.select('id')
			.where(eq('postId', outerRef(q))),
	);
const on = eq('calls.id', 1);

it('manual explicit and implicit ranges bind emitted and logical qualifiers', () => {
	const results = [
		orm
			.select('calls')
			.join('symbols', { as: 'caller', on })
			.where(body('caller.id'))
			.dump(),
		orm
			.select('calls')
			.join('posts', { as: 'p', on })
			.where(body('p.id'))
			.dump(),
		orm
			.select('calls')
			.join('symbols', { as: 'caller', on })
			.where(body('symbols.id'))
			.dump(),
		orm
			.select('calls')
			.join('symbols', { on })
			.where(body('symbols.id'))
			.dump(),
		orm.select('calls').join('caller').where(body('caller.id')).dump(),
	];
	expect(
		results.map(({ sql, params }) => ({ sql, params })),
	).toMatchInlineSnapshot(`
		[
		  {
		    "params": [
		      1,
		    ],
		    "sql": "SELECT calls.* FROM calls JOIN symbols AS caller ON calls.id = $1 WHERE EXISTS (SELECT comments_sq.id FROM comments AS comments_sq WHERE comments_sq."postId" = caller.id)",
		  },
		  {
		    "params": [
		      1,
		    ],
		    "sql": "SELECT calls.* FROM calls JOIN posts AS p ON calls.id = $1 WHERE EXISTS (SELECT comments_sq.id FROM comments AS comments_sq WHERE comments_sq."postId" = p.id)",
		  },
		  {
		    "params": [
		      1,
		    ],
		    "sql": "SELECT calls.* FROM calls JOIN symbols AS caller ON calls.id = $1 WHERE EXISTS (SELECT comments_sq.id FROM comments AS comments_sq WHERE comments_sq."postId" = caller.id)",
		  },
		  {
		    "params": [
		      1,
		    ],
		    "sql": "SELECT calls.* FROM calls JOIN symbols AS symbols ON calls.id = $1 WHERE EXISTS (SELECT comments_sq.id FROM comments AS comments_sq WHERE comments_sq."postId" = symbols.id)",
		  },
		  {
		    "params": [],
		    "sql": "SELECT calls.* FROM calls JOIN symbols AS caller ON calls."callerId" = caller.id WHERE EXISTS (SELECT comments_sq.id FROM comments AS comments_sq WHERE comments_sq."postId" = caller.id)",
		  },
		]
	`);
});
it('join includes bind emitted aliases and a unique logical table', () => {
	const results = [
		orm
			.select('calls')
			.include('caller', { join: 'left' })
			.include('callee', { join: 'left' })
			.where(body('caller.id'))
			.dump(),
		orm
			.select('calls')
			.include('caller', { join: 'left' })
			.where(body('symbols.id'))
			.dump(),
	];
	expect(
		results.map(({ sql, params }) => ({ sql, params })),
	).toMatchInlineSnapshot(`
		[
		  {
		    "params": [],
		    "sql": "SELECT calls.*, caller.id AS "caller.id", caller.name AS "caller.name", caller.id AS __dbsp_presence_caller, callee.id AS "callee.id", callee.name AS "callee.name", callee.id AS __dbsp_presence_callee FROM calls LEFT JOIN symbols AS caller ON calls."callerId" = caller.id LEFT JOIN symbols AS callee ON calls."calleeId" = callee.id WHERE EXISTS (SELECT comments_sq.id FROM comments AS comments_sq WHERE comments_sq."postId" = caller.id)",
		  },
		  {
		    "params": [],
		    "sql": "SELECT calls.*, caller.id AS "caller.id", caller.name AS "caller.name", caller.id AS __dbsp_presence_caller FROM calls LEFT JOIN symbols AS caller ON calls."callerId" = caller.id WHERE EXISTS (SELECT comments_sq.id FROM comments AS comments_sq WHERE comments_sq."postId" = caller.id)",
		  },
		]
	`);
});
it('manual duplicate logical tables refuse ambiguity in both join orders', () => {
	for (const aliases of [
		['caller', 'callee'],
		['callee', 'caller'],
	] as const) {
		expect(() =>
			orm
				.select('calls')
				.join('symbols', { as: aliases[0], on })
				.join('symbols', { as: aliases[1], on })
				.where(body('symbols.id'))
				.dump(),
		).toThrow(
			"outerRef qualifier 'symbols' is ambiguous between 'callee', 'caller' in an enclosing query.",
		);
	}
});
it('join includes refuse logical-table ambiguity in both orders', () => {
	for (const aliases of [
		['caller', 'callee'],
		['callee', 'caller'],
	] as const) {
		expect(() =>
			orm
				.select('calls')
				.include(aliases[0], { join: 'left' })
				.include(aliases[1], { join: 'left' })
				.where(body('symbols.id'))
				.dump(),
		).toThrow(
			"outerRef qualifier 'symbols' is ambiguous between 'callee', 'caller' in an enclosing query.",
		);
	}
});
it('exact emitted qualifier wins over duplicate logical tables', () => {
	const result = orm
		.select('calls')
		.join('symbols', { as: 'symbols', on })
		.join('symbols', { as: 'callee', on })
		.where(body('symbols.id'))
		.dump();
	expect({ sql: result.sql, params: result.params }).toMatchInlineSnapshot(`
		{
		  "params": [
		    1,
		    1,
		  ],
		  "sql": "SELECT calls.* FROM calls JOIN symbols AS symbols ON calls.id = $1 JOIN symbols AS callee ON calls.id = $2 WHERE EXISTS (SELECT comments_sq.id FROM comments AS comments_sq WHERE comments_sq."postId" = symbols.id)",
		}
	`);
});
it('root, unqualified, nearest enclosing and missing qualifiers retain their contracts', () => {
	for (const q of ['calls.id', 'id']) {
		const result = orm.select('calls').where(body(q)).dump();
		expect(result.sql).toBe(
			'SELECT calls.* FROM calls WHERE EXISTS (SELECT comments_sq.id FROM comments AS comments_sq WHERE comments_sq."postId" = calls.id)',
		);
		expect(result.params).toEqual([]);
	}
	const result = orm
		.select('calls')
		.join('symbols', { as: 'caller', on })
		.where(
			rawExists(subquery('symbols').select('id').where(body('symbols.id'))),
		)
		.dump();
	expect({ sql: result.sql, params: result.params }).toMatchInlineSnapshot(`
		{
		  "params": [
		    1,
		  ],
		  "sql": "SELECT calls.* FROM calls JOIN symbols AS caller ON calls.id = $1 WHERE EXISTS (SELECT symbols_sq.id FROM symbols AS symbols_sq WHERE EXISTS (SELECT comments_sq.id FROM comments AS comments_sq WHERE comments_sq."postId" = symbols_sq.id))",
		}
	`);
	expect(() => orm.select('calls').where(body('missing.id')).dump()).toThrow(
		"outerRef qualifier 'missing' is not visible in an enclosing query.",
	);
});
it('snake_case collisions reserve logical and emitted root qualifiers', () => {
	const local = createOrm({
		schema: db,
		adapter: createPgCompileOnlyAdapter({
			model: db.model,
			dbCasing: 'snake_case',
		}),
	});
	for (const alias of ['userProfiles', 'user_profiles']) {
		for (const relationMode of [false, true]) {
			expect(() =>
				local
					.select('userProfiles')
					.join(
						relationMode ? 'file' : 'files',
						relationMode
							? { as: alias }
							: { as: alias, on: eq(`${alias}.id`, 1) },
					)
					.dump(),
			).toThrow(`Query scope already binds qualifier '${alias}'.`);
		}
	}
});

it('physical-name mappings reserve logical and emitted root qualifiers', () => {
	const original = createPgPhysicalModel({
		mode: 'logical',
		model: db.model,
		schema: 'public',
		dbCasing: 'preserve',
	});
	const physicalModel = {
		...original,
		inventory: createPhysicalNameInventory(
			original.inventory.entries.map((entry) =>
				entry.logical.kind === 'table' && entry.logical.name === 'userProfiles'
					? { ...entry, physical: 'account_profiles' }
					: entry,
			),
		),
	};
	const adapter = createPgCompileOnlyAdapter({ model: db.model });
	// Inject an explicit inventory at the adapter seam, while exercising the ORM dump path.
	adapter.compile = <T>(plan: PlanReport, options?: CompileOptions) =>
		compileSelect<T>(plan, options, {
			model: db.model,
			schemaName: undefined,
			defaultPk: 'id',
			deriveFk: defaultFkDerivation,
			physicalModel,
			declaredNames: createDeclaredNameResolver(physicalModel),
		});
	const local = createOrm({ schema: db, adapter });
	for (const alias of ['userProfiles', 'account_profiles']) {
		for (const relationMode of [false, true]) {
			expect(() =>
				local
					.select('userProfiles')
					.join(
						relationMode ? 'file' : 'files',
						relationMode
							? { as: alias }
							: { as: alias, on: eq(`${alias}.id`, 1) },
					)
					.dump(),
			).toThrow(`Query scope already binds qualifier '${alias}'.`);
		}
	}
});

it('emitted aliases survive public relation-path ambiguity and deeper bodies', () => {
	const query = orm
		.select('calls')
		.join('caller')
		.join('caller', { as: 'other' });
	const results = [
		query.where(body('caller.id')).dump(),
		query
			.where(rawExists(subquery('posts').select('id').where(body('caller.id'))))
			.dump(),
		query
			.where(
				inSubquery(
					'id',
					subquery('posts').select('id').where(body('posts.id')),
				),
			)
			.dump(),
	];
	expect(
		results.map(({ sql, params }) => ({ sql, params })),
	).toMatchInlineSnapshot(`
		[
		  {
		    "params": [],
		    "sql": "SELECT calls.* FROM calls JOIN symbols AS caller ON calls."callerId" = caller.id JOIN symbols AS other ON calls."callerId" = other.id WHERE EXISTS (SELECT comments_sq.id FROM comments AS comments_sq WHERE comments_sq."postId" = caller.id)",
		  },
		  {
		    "params": [],
		    "sql": "SELECT calls.* FROM calls JOIN symbols AS caller ON calls."callerId" = caller.id JOIN symbols AS other ON calls."callerId" = other.id WHERE EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE EXISTS (SELECT comments_sq.id FROM comments AS comments_sq WHERE comments_sq."postId" = caller.id))",
		  },
		  {
		    "params": [],
		    "sql": "SELECT calls.* FROM calls JOIN symbols AS caller ON calls."callerId" = caller.id JOIN symbols AS other ON calls."callerId" = other.id WHERE calls.id = ANY (SELECT posts_subq_2.id FROM posts AS posts_subq_2 WHERE EXISTS (SELECT comments_sq.id FROM comments AS comments_sq WHERE comments_sq."postId" = posts_subq_2.id))",
		  },
		]
	`);
	expect(() => query.where(body('symbols.id')).dump()).toThrow(
		"outerRef qualifier 'symbols' is ambiguous between 'caller', 'other' in an enclosing query.",
	);
});

it('a relation predicate retains its own root range for a nested qualified body', () => {
	const result = orm
		.select('calls')
		.where(exists('caller', { where: body('symbols.id') }))
		.dump();
	expect({ sql: result.sql, params: result.params }).toMatchInlineSnapshot(`
		{
		  "params": [],
		  "sql": "SELECT calls.* FROM calls JOIN symbols AS caller ON caller.id = calls."callerId" WHERE EXISTS (SELECT comments_sq.id FROM comments AS comments_sq WHERE comments_sq."postId" = caller.id)",
		}
	`);
});

for (const kind of ['rawExists', 'rawNotExists', 'inSubquery'] as const) {
	it(`nested relation predicates push the nearest range for ${kind}`, () => {
		const query = subquery('nodes')
			.select('id')
			.where(eq('id', outerRef('nodes.id')));
		const condition =
			kind === 'rawExists'
				? rawExists(query)
				: kind === 'rawNotExists'
					? rawNotExists(query)
					: inSubquery('id', query);
		const result = orm
			.select('nodes')
			.where(
				exists('children', { where: exists('children', { where: condition }) }),
			)
			.dump();
		const bodySql =
			kind === 'rawExists'
				? 'EXISTS (SELECT nodes_sq.id FROM nodes AS nodes_sq WHERE nodes_sq.id = nodes_exists_1.id)'
				: kind === 'rawNotExists'
					? 'NOT (EXISTS (SELECT nodes_sq.id FROM nodes AS nodes_sq WHERE nodes_sq.id = nodes_exists_1.id))'
					: 'nodes_exists_1.id = ANY (SELECT nodes_subq_2.id FROM nodes AS nodes_subq_2 WHERE nodes_subq_2.id = nodes_exists_1.id)';
		expect(result.sql).toBe(
			`SELECT nodes.* FROM nodes WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.id = nodes_exists_0."parentId" AND EXISTS (SELECT 1 FROM nodes AS nodes_exists_1 WHERE nodes_exists_0.id = nodes_exists_1."parentId" AND ${bodySql}))`,
		);
		expect(result.params).toEqual([]);
	});
}

const includeDb = schema({
	users: { id: { type: 'integer', primaryKey: true } },
	posts: {
		id: { type: 'integer', primaryKey: true },
		userId: ref('users', { as: 'author', inverse: 'posts' }),
		categoryId: ref('categories', { as: 'category' }),
		editorId: ref('users', { as: 'editor', inverse: 'editedPosts' }),
		reviewerId: ref('users', { as: 'reviewer', inverse: 'reviewedPosts' }),
	},
	categories: {
		id: { type: 'integer', primaryKey: true },
		ownerId: ref('users', { as: 'owner' }),
	},
	comments: { id: { type: 'integer', primaryKey: true }, userId: 'integer' },
});
const includeOrm = createOrm({
	schema: includeDb,
	adapter: createPgCompileOnlyAdapter({ model: includeDb.model }),
});
const includeBody = rawExists(
	subquery('comments')
		.select('id')
		.where(eq('userId', outerRef('users.id'))),
);

it('relation predicate sibling includes bind the nearest emitted logical range', () => {
	const result = includeOrm
		.select('users')
		.where(
			exists('posts', {
				include: { category: { join: 'inner' }, editor: { join: 'inner' } },
				where: includeBody,
			}),
		)
		.dump();
	expect(result.sql).toBe(
		'SELECT users.* FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 JOIN categories AS category ON posts_exists_0."categoryId" = category.id JOIN users AS editor ON posts_exists_0."editorId" = editor.id WHERE users.id = posts_exists_0."userId" AND EXISTS (SELECT comments_sq.id FROM comments AS comments_sq WHERE comments_sq."userId" = editor.id))',
	);
	expect(result.params).toEqual([]);
});

it('relation predicate linear includes retain their emitted SQL', () => {
	const result = includeOrm
		.select('users')
		.where(
			exists('posts', {
				include: { category: { join: 'inner' }, owner: { join: 'inner' } },
				where: includeBody,
			}),
		)
		.dump();
	expect(result.sql).toBe(
		'SELECT users.* FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 JOIN categories AS category ON posts_exists_0."categoryId" = category.id JOIN users AS owner ON category."ownerId" = owner.id WHERE users.id = posts_exists_0."userId" AND EXISTS (SELECT comments_sq.id FROM comments AS comments_sq WHERE comments_sq."userId" = owner.id))',
	);
	expect(result.params).toEqual([]);
});

it('relation predicate sibling includes refuse duplicate logical ranges in both orders', () => {
	for (const include of [
		{ editor: { join: 'inner' }, reviewer: { join: 'inner' } },
		{ reviewer: { join: 'inner' }, editor: { join: 'inner' } },
	] as const) {
		expect(() =>
			includeOrm
				.select('users')
				.where(
					exists('posts', {
						include,
						where: includeBody,
					}),
				)
				.dump(),
		).toThrow(
			"outerRef qualifier 'users' is ambiguous between 'editor', 'reviewer' in an enclosing query.",
		);
	}
});
