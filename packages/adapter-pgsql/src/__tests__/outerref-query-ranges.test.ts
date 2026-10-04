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
	userProfiles: { id: { type: 'integer', primaryKey: true } },
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
		    "sql": "SELECT calls.*, caller.id AS "caller.id", callee.id AS "callee.id" FROM calls LEFT JOIN symbols AS caller ON calls."callerId" = caller.id LEFT JOIN symbols AS callee ON calls."calleeId" = callee.id WHERE EXISTS (SELECT comments_sq.id FROM comments AS comments_sq WHERE comments_sq."postId" = caller.id)",
		  },
		  {
		    "params": [],
		    "sql": "SELECT calls.*, caller.id AS "caller.id" FROM calls LEFT JOIN symbols AS caller ON calls."callerId" = caller.id WHERE EXISTS (SELECT comments_sq.id FROM comments AS comments_sq WHERE comments_sq."postId" = caller.id)",
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
it('snake_case collisions reserve the emitted root qualifier only', () => {
	const local = createOrm({
		schema: db,
		adapter: createPgCompileOnlyAdapter({
			model: db.model,
			dbCasing: 'snake_case',
		}),
	});
	const result = local
		.select('userProfiles')
		.join('files', { as: 'userProfiles', on: eq('userProfiles.id', 1) })
		.dump();
	expect({ sql: result.sql, params: result.params }).toMatchInlineSnapshot(`
		{
		  "params": [
		    1,
		  ],
		  "sql": "SELECT "userProfiles".* FROM user_profiles JOIN files AS "userProfiles" ON "userProfiles".id = $1",
		}
	`);
	expect(() =>
		local
			.select('userProfiles')
			.join('files', { as: 'user_profiles', on: eq('user_profiles.id', 1) })
			.dump(),
	).toThrow("Query scope already binds qualifier 'user_profiles'.");
});

it('physical-name mappings reserve the emitted root qualifier only', () => {
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
	const result = local
		.select('userProfiles')
		.join('files', { as: 'userProfiles', on: eq('userProfiles.id', 1) })
		.dump();
	expect({ sql: result.sql, params: result.params }).toMatchInlineSnapshot(`
		{
		  "params": [
		    1,
		  ],
		  "sql": "SELECT "userProfiles".* FROM account_profiles JOIN files AS "userProfiles" ON "userProfiles".id = $1",
		}
	`);
	expect(() =>
		local
			.select('userProfiles')
			.join('files', {
				as: 'account_profiles',
				on: eq('account_profiles.id', 1),
			})
			.dump(),
	).toThrow("Query scope already binds qualifier 'account_profiles'.");
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
