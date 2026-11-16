/**
 * A typed ColumnRef addresses the range its table or relation binds in the
 * query (#991): a TableRef column compiles as `<table>.<column>`, a ref reached
 * through a relation as `<path>.<column>`, and the qualifier resolves through
 * the query scope like the same string.
 */
import {
	and,
	any,
	caseWhen,
	createOrm,
	eq,
	every,
	exists,
	fn,
	inArray,
	inSubquery,
	isNotNull,
	isNull,
	like,
	literal,
	neq,
	notExists,
	param,
	rawExists,
	ref,
	SubqueryExpression,
	schema,
	some,
	star,
	subquery,
} from '@dbsp/core';
import type { WhereIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const fileDb = schema({
	files: { id: { type: 'integer', primaryKey: true }, path: 'text' },
	symbols: {
		id: { type: 'integer', primaryKey: true },
		start_line: 'integer',
		file_id: ref('files', { as: 'file' }),
	},
	calls: {
		id: { type: 'integer', primaryKey: true },
		caller_id: ref('symbols', { as: 'caller', inverse: 'callerCalls' }),
		callee_id: ref('symbols', { as: 'callee', inverse: 'calleeCalls' }),
	},
});
const fileOrm = createOrm({
	schema: fileDb,
	adapter: createPgCompileOnlyAdapter({ model: fileDb.model }),
	suppressDxWarnings: true,
});
const { files, symbols, calls } = fileOrm.tables;
const FILE_JOIN =
	'SELECT symbols.* FROM symbols JOIN files AS file ON symbols.file_id = file.id';

const nodeDb = schema({
	nodes: {
		id: { type: 'integer', primaryKey: true },
		label: 'text',
		parent_id: ref('nodes', {
			nullable: true,
			as: 'parent',
			inverse: 'children',
			roles: { parent: 'parent', children: 'children' },
		}),
	},
});
const nodeOrm = createOrm({
	schema: nodeDb,
	adapter: createPgCompileOnlyAdapter({ model: nodeDb.model }),
	suppressDxWarnings: true,
});
const { nodes } = nodeOrm.tables;
const PARENT_JOIN =
	'SELECT nodes.* FROM nodes JOIN nodes AS parent ON nodes.parent_id = parent.id';

describe('ColumnRef in WHERE: the ref keeps its table', () => {
	it('a joined table column binds the join range', () => {
		expect(
			fileOrm.select('symbols').join('file').where(eq(files.id, 1)).dump().sql,
		).toBe(`${FILE_JOIN} WHERE file.id = $1`);
	});

	it.each([
		['like', () => like(files.path, 'a%'), 'file.path LIKE $1'],
		['inArray', () => inArray(files.id, [1]), 'file.id = ANY ($1)'],
		[
			'inSubquery',
			() => inSubquery(files.id, subquery('symbols').select('file_id')),
			'file.id = ANY (SELECT symbols_subq_1.file_id FROM symbols AS symbols_subq_1)',
		],
		['any', () => any(files.id, [1]), 'file.id = ANY (CAST($1 AS int4[]))'],
		['isNull', () => isNull(files.path), 'file.path IS NULL'],
		['isNotNull', () => isNotNull(files.path), 'file.path IS NOT NULL'],
		['neq', () => neq(files.id, 1), 'file.id <> $1'],
	])('%s keeps the joined table', (_name, condition, where) => {
		expect(
			fileOrm.select('symbols').join('file').where(condition()).dump().sql,
		).toBe(`${FILE_JOIN} WHERE ${where}`);
	});

	it('a single-hop relation-path ref binds the relation join', () => {
		expect(
			fileOrm
				.select('symbols')
				.join('file')
				.where(eq(symbols.file.path, 'x'))
				.dump().sql,
		).toBe(`${FILE_JOIN} WHERE file.path = $1`);
	});

	it('a TableRef column reaches a multi-hop join through its table', () => {
		expect(
			fileOrm
				.select('calls')
				.join('callee.file')
				.where(eq(files.path, 'x'))
				.dump().sql,
		).toBe(
			'SELECT calls.* FROM calls JOIN symbols AS callee ON calls.callee_id = callee.id JOIN files AS callee_file ON callee.file_id = callee_file.id WHERE callee_file.path = $1',
		);
	});

	it('a multi-hop relation-path ref follows the WHERE rule for dotted paths', () => {
		expect(
			fileOrm
				.select('calls')
				.join('callee.file')
				.where(eq(calls.callee.file.path, 'x'))
				.dump().sql,
		).toBe(
			'SELECT calls.* FROM calls JOIN symbols AS callee ON calls.callee_id = callee.id JOIN files AS callee_file ON callee.file_id = callee_file.id WHERE EXISTS (SELECT 1 FROM files AS files_exists_2 WHERE callee.file_id = files_exists_2.id AND files_exists_2.path = $1)',
		);
	});

	it('a relation-path ref binds its own hop when the table is joined twice', () => {
		expect(
			fileOrm
				.select('calls')
				.join('caller')
				.join('callee')
				.where(eq(calls.callee.id, 7))
				.dump().sql,
		).toBe(
			'SELECT calls.* FROM calls JOIN symbols AS caller ON calls.caller_id = caller.id JOIN symbols AS callee ON calls.callee_id = callee.id WHERE callee.id = $1',
		);
	});

	it('a TableRef column whose table is joined twice is refused', () => {
		expect(() =>
			fileOrm
				.select('calls')
				.join('caller')
				.join('callee')
				.where(eq(symbols.id, 7))
				.dump(),
		).toThrow(
			"WHERE qualifier 'symbols' is ambiguous between 'callee', 'caller'.",
		);
	});

	it('a TableRef column in an include where binds the include range', () => {
		expect(
			fileOrm
				.select('symbols')
				.join('files', { as: 'file', on: eq('file.id', 42) })
				.include('file', { join: 'left', where: eq(files.path, 'x') })
				.dump().sql,
		).toBe(
			'SELECT symbols.*, file_1.id AS "file.id", file_1.path AS "file.path", file_1.id AS __dbsp_presence_file FROM symbols JOIN files AS file ON file.id = $2 LEFT JOIN files AS file_1 ON symbols.file_id = file_1.id WHERE file_1.path = $1',
		);
	});
});

describe('ColumnRef in WHERE: a renamed relation join', () => {
	const db = schema({
		users: { id: { type: 'integer', primaryKey: true }, email: 'text' },
		posts: {
			id: { type: 'integer', primaryKey: true },
			published: 'boolean',
			author_id: ref('users', { as: 'author', inverse: 'writings' }),
		},
	});
	const orm = createOrm({
		schema: db,
		adapter: createPgCompileOnlyAdapter({ model: db.model }),
		suppressDxWarnings: true,
	});

	it('a relation-path ref traverses from the root', () => {
		expect(
			orm
				.select('users')
				.join('writings', { as: 'w' })
				.where(eq(orm.tables.users.writings.published, true))
				.dump().sql,
		).toBe(
			'SELECT users.* FROM users JOIN posts AS w ON users.id = w.author_id WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_1 WHERE users.id = posts_exists_1.author_id AND posts_exists_1.published = $1)',
		);
	});
});

describe('Self-join: the root keeps its own name', () => {
	it('a root TableRef column binds the root', () => {
		expect(
			nodeOrm.select('nodes').join('parent').where(eq(nodes.label, 'x')).dump()
				.sql,
		).toBe(`${PARENT_JOIN} WHERE nodes.label = $1`);
	});

	it('a relation-path ref binds the joined relation', () => {
		expect(
			nodeOrm
				.select('nodes')
				.join('parent')
				.where(eq(nodes.parent.label, 'x'))
				.dump().sql,
		).toBe(`${PARENT_JOIN} WHERE parent.label = $1`);
	});

	it('the root-named string binds the root', () => {
		expect(
			nodeOrm
				.select('nodes')
				.join('parent')
				.where(eq('nodes.label', 'x'))
				.dump().sql,
		).toBe(`${PARENT_JOIN} WHERE nodes.label = $1`);
	});

	it('a root TableRef column binds the root under snake_case', () => {
		const db = schema({
			userProfiles: {
				id: { type: 'integer', primaryKey: true },
				displayName: 'text',
				parentId: ref('userProfiles', {
					nullable: true,
					as: 'parent',
					inverse: 'children',
					roles: { parent: 'parent', children: 'children' },
				}),
			},
		});
		const orm = createOrm({
			schema: db,
			adapter: createPgCompileOnlyAdapter({
				model: db.model,
				dbCasing: 'snake_case',
			}),
			suppressDxWarnings: true,
		});
		expect(
			orm
				.select('userProfiles')
				.join('parent')
				.where(eq(orm.tables.userProfiles.displayName, 'x'))
				.dump().sql,
		).toBe(
			'SELECT user_profiles.* FROM user_profiles JOIN user_profiles AS parent ON user_profiles.parent_id = parent.id WHERE user_profiles.display_name = $1',
		);
	});
});

describe('ColumnRef in an upsert guard', () => {
	it('a TableRef column guards DO UPDATE', () => {
		const db = schema({
			t: {
				id: { type: 'integer', primaryKey: true },
				extra: 'text',
				k: 'text',
			},
		});
		const orm = createOrm({
			schema: db,
			adapter: createPgCompileOnlyAdapter({ model: db.model }),
			suppressDxWarnings: true,
		});
		const { t } = orm.tables;
		expect(
			orm
				.upsertInto(t)
				.values({ id: 1, extra: 'a', k: 'k' })
				.onConflict(['id'])
				.doUpdate({ extra: 'b' }, eq(t.extra, 'g'))
				.dump().sql,
		).toBe(
			'INSERT INTO t (id, extra, k) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET extra = $4 WHERE t.extra = $5',
		);
	});
});

describe('A relation-path ref inside a body is refused (#991)', () => {
	const refusal = (field: string) =>
		new Error(
			`ColumnRef '${field}' follows a relation; inside a relation predicate, quantifier callback or subquery body its path would be read from that body's row (#1005).`,
		);
	const L = () => eq(nodes.parent.label, 'x');
	const writingsDb = schema({
		users: { id: { type: 'integer', primaryKey: true }, email: 'text' },
		posts: {
			id: { type: 'integer', primaryKey: true },
			published: 'boolean',
			author_id: ref('users', { as: 'author', inverse: 'writings' }),
		},
		comments: {
			id: { type: 'integer', primaryKey: true },
			body: 'text',
			post_id: ref('posts', { as: 'post', inverse: 'replies' }),
		},
	});
	const writingsOrm = createOrm({
		schema: writingsDb,
		adapter: createPgCompileOnlyAdapter({ model: writingsDb.model }),
		suppressDxWarnings: true,
	});
	const { users, posts } = writingsOrm.tables;
	const postsDb = schema({
		users: { id: { type: 'integer', primaryKey: true }, email: 'text' },
		posts: {
			id: { type: 'integer', primaryKey: true },
			published: 'boolean',
			author_id: ref('users', { as: 'author', inverse: 'posts' }),
		},
	});
	const postsOrm = createOrm({
		schema: postsDb,
		adapter: createPgCompileOnlyAdapter({ model: postsDb.model }),
		suppressDxWarnings: true,
	});
	const P = () => eq(postsOrm.tables.users.posts.published, true);
	const dataDb = schema({
		nodes: {
			id: { type: 'integer', primaryKey: true },
			label: 'text',
			data: { type: 'json', dbType: 'jsonb' },
			parent_id: ref('nodes', {
				nullable: true,
				as: 'parent',
				inverse: 'children',
				roles: { parent: 'parent', children: 'children' },
			}),
		},
	});
	const dataOrm = createOrm({
		schema: dataDb,
		adapter: createPgCompileOnlyAdapter({ model: dataDb.model }),
		suppressDxWarnings: true,
	});
	const dataNodes = dataOrm.tables.nodes;

	it.each([
		['exists', () => exists('parent', { where: L() })],
		['notExists', () => notExists('parent', { where: L() })],
	])('AC25 predicate-body-refused %s', (_name, where) => {
		expect(() => nodeOrm.select('nodes').where(where()).dump()).toThrow(
			refusal('parent.label'),
		);
	});

	it('AC26 cross-table-body-refused in a SELECT and an UPDATE', () => {
		const body = () =>
			exists('writings', { where: eq(users.writings.published, true) });
		expect(() => writingsOrm.select('users').where(body()).dump()).toThrow(
			refusal('writings.published'),
		);
		expect(() =>
			writingsOrm.update('users').set({ email: 'e' }).where(body()).dump(),
		).toThrow(refusal('writings.published'));
	});

	it('AC27 callback-path-refused absolute and from the callback parameter', () => {
		expect(() =>
			nodeOrm
				.select('nodes')
				.where(some(nodes.children, () => eq(nodes.children.label, 'x')))
				.dump(),
		).toThrow(refusal('children.label'));
		// The callback parameter is typed without its relations (filters.ts).
		const viaParent = (c: unknown) => eq((c as typeof nodes).parent.label, 'x');
		expect(() =>
			nodeOrm.select('nodes').where(some(nodes.children, viaParent)).dump(),
		).toThrow(refusal('parent.label'));
		expect(() =>
			nodeOrm.select('nodes').where(every(nodes.children, viaParent)).dump(),
		).toThrow(refusal('parent.label'));
	});

	it.each([
		['rawExists', () => rawExists(subquery('nodes').select('id').where(L()))],
		[
			'inSubquery',
			() => inSubquery('id', subquery('nodes').select('id').where(L())),
		],
	])('AC28 subquery-body-refused %s', (_name, where) => {
		expect(() => nodeOrm.select('nodes').where(where()).dump()).toThrow(
			refusal('parent.label'),
		);
	});

	it.each([
		[
			'FILTER',
			() =>
				nodeOrm.select('nodes').columns([
					fn('count', star())
						.filter(exists('parent', { where: L() }))
						.as('n'),
				]),
		],
		[
			'CASE WHEN',
			() =>
				nodeOrm.select('nodes').columns([
					caseWhen(exists('parent', { where: L() }), literal(1))
						.else(literal(0))
						.as('c'),
				]),
		],
		[
			'HAVING',
			() =>
				nodeOrm
					.select('nodes')
					.columns(['id'])
					.groupBy(['id'])
					.having(exists('parent', { where: L() })),
		],
	])('AC29 nested-positions-refused %s', (_name, query) => {
		expect(() => query().dump()).toThrow(refusal('parent.label'));
	});

	it('AC29 join-on-body-refused', () => {
		expect(() =>
			nodeOrm
				.select('nodes')
				.join('nodes', {
					as: 'n2',
					on: and(eq('n2.id', 1), exists('parent', { where: L() })),
				})
				.dump(),
		).toThrow(refusal('parent.label'));
	});

	it('AC30 top-level-unchanged', () => {
		expect(nodeOrm.select('nodes').where(L()).dump().sql).toBe(
			'SELECT nodes.* FROM nodes WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.parent_id = nodes_exists_0.id AND nodes_exists_0.label = $1)',
		);
		expect(nodeOrm.select('nodes').join('parent').where(L()).dump().sql).toBe(
			`${PARENT_JOIN} WHERE parent.label = $1`,
		);
		expect(
			nodeOrm
				.select('nodes')
				.include('parent', { join: 'left', where: L() })
				.dump().sql,
		).toBe(
			'SELECT nodes.*, parent.id AS "parent.id", parent.label AS "parent.label", parent.parent_id AS "parent.parent_id", parent.id AS __dbsp_presence_parent FROM nodes LEFT JOIN nodes AS parent ON nodes.parent_id = parent.id WHERE parent.label = $1',
		);
		expect(
			nodeOrm
				.select('nodes')
				.columns([fn('count', star()).filter(L()).as('n')])
				.dump().sql,
		).toBe(
			'SELECT count(*) FILTER (WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.parent_id = nodes_exists_0.id AND nodes_exists_0.label = $1)) AS n FROM nodes',
		);
		expect(
			nodeOrm
				.select('nodes')
				.columns([caseWhen(L(), literal(1)).else(literal(0)).as('c')])
				.dump().sql,
		).toBe(
			'SELECT CASE WHEN EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.parent_id = nodes_exists_0.id AND nodes_exists_0.label = $1) THEN 1 ELSE 0 END AS c FROM nodes',
		);
		expect(
			writingsOrm
				.update('users')
				.set({ email: 'e' })
				.where(eq(users.writings.published, true))
				.dump().sql,
		).toBe(
			'UPDATE users SET email = $1 WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.author_id AND posts_exists_0.published = $2)',
		);
	});

	it('AC31 unmarked-refs-accepted', () => {
		const expected =
			'SELECT users.* FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.author_id AND posts_exists_0.published = $1)';
		expect(
			writingsOrm
				.select('users')
				.where(some(users.writings, (p) => eq(p.published!, true)))
				.dump().sql,
		).toBe(expected);
		expect(
			writingsOrm
				.select('users')
				.where(exists('writings', { where: eq(posts.published, true) }))
				.dump().sql,
		).toBe(expected);
	});

	it('AC33 direct-body-refused in where, projection, orderBy, having and B9', () => {
		const projected = (body: Record<string, unknown>) =>
			postsOrm.select('users').columns([
				new SubqueryExpression({
					type: 'select',
					from: 'posts',
					...body,
				} as never).asExpr('v'),
			]);
		const caseOf = () => caseWhen(P(), literal(1)).else(literal(0)).intent;
		for (const query of [
			() =>
				postsOrm
					.select('users')
					.columns([subquery('posts').where(P()).count().asExpr('n')]),
			() => projected({ select: { type: 'expressions', columns: [caseOf()] } }),
			() =>
				projected({
					select: { type: 'fields', fields: ['id'] },
					orderBy: [{ expression: caseOf(), direction: 'asc' }],
					limit: 1,
				}),
			() =>
				projected({
					select: { type: 'fields', fields: ['id'] },
					groupBy: ['id'],
					having: P(),
				}),
		])
			expect(() => query().dump()).toThrow(refusal('posts.published'));
		expect(() =>
			nodeOrm
				.select('nodes')
				.columns([subquery('nodes').select('id').where(L()).asExpr('v')])
				.dump(),
		).toThrow(refusal('parent.label'));
	});

	it('AC33 aggregate-filter-body-refused', () => {
		expect(() =>
			postsOrm
				.select('users')
				.columns([
					new SubqueryExpression({
						type: 'select',
						from: 'posts',
						select: {
							type: 'aggregate',
							aggregates: [{ function: 'count', field: '*', filter: P() }],
						},
					} as never).asExpr('n'),
				])
				.dump(),
		).toThrow(refusal('posts.published'));
	});

	it('AC33 having-body-refused', () => {
		expect(() =>
			postsOrm
				.select('users')
				.columns(['id'])
				.groupBy(['id'])
				.having(
					inSubquery(
						postsOrm.tables.users.id,
						subquery('posts').select('author_id').where(P()),
					),
				)
				.dump(),
		).toThrow(refusal('posts.published'));
	});

	it.each([
		['like', () => like(nodes.parent.label, 'a%'), 'parent.label'],
		['inArray', () => inArray(nodes.parent.label, ['a']), 'parent.label'],
		['any', () => any(nodes.parent.label, ['a']), 'parent.label'],
		['isNull', () => isNull(nodes.parent.label), 'parent.label'],
		['isNotNull', () => isNotNull(nodes.parent.label), 'parent.label'],
		[
			'inSubquery',
			() => inSubquery(nodes.parent.id, subquery('nodes').select('parent_id')),
			'parent.id',
		],
	])('AC34 per-constructor-marker %s', (_name, leaf, field) => {
		expect(() =>
			nodeOrm
				.select('nodes')
				.where(exists('parent', { where: leaf() }))
				.dump(),
		).toThrow(refusal(field));
	});

	it('AC35 plan-refuses in a resolved body and a directly lowered body', () => {
		expect(() =>
			nodeOrm
				.select('nodes')
				.where(exists('parent', { where: L() }))
				.plan(),
		).toThrow(refusal('parent.label'));
		expect(() =>
			postsOrm
				.select('users')
				.columns([subquery('posts').where(P()).count().asExpr('n')])
				.plan(),
		).toThrow(refusal('posts.published'));
	});

	it('AC36 rawnotexists-body-refused and scalar-comparison-body-refused', () => {
		const body = () =>
			subquery('nodes').select('id').where(L()).build().toIntent();
		for (const where of [
			{ kind: 'rawNotExists', subquery: body() },
			{ kind: 'subquery', field: 'id', operator: 'eq', subquery: body() },
		])
			expect(() =>
				nodeOrm
					.select('nodes')
					.where(where as WhereIntent)
					.dump(),
			).toThrow(refusal('parent.label'));
	});

	it('AC36 in-operand-outside-body', () => {
		const result = writingsOrm
			.select('users')
			.where(inSubquery(users.writings.id, subquery('posts').select('id')))
			.dump();
		expect(result.sql).toBe(
			'SELECT users.* FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.author_id AND posts_exists_0.id = ANY (SELECT posts_subq_1.id FROM posts AS posts_subq_1))',
		);
		expect(result.params).toEqual([]);
	});

	it('AC37 bound-payload-opaque plain and through param()', () => {
		const leaf = eq(dataNodes.parent.label, 'x');
		const plain = dataOrm
			.select('nodes')
			.where(exists('parent', { where: eq('data', leaf) }))
			.dump();
		expect(plain.sql).toBe(
			'SELECT nodes.* FROM nodes WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.parent_id = nodes_exists_0.id AND nodes_exists_0.data = CAST($1 AS jsonb))',
		);
		expect(plain.params).toEqual([
			{
				kind: 'comparison',
				field: 'parent.label',
				operator: 'eq',
				value: 'x',
				pathRef: true,
			},
		]);
		const wrapped = dataOrm
			.select('nodes')
			.where(exists('parent', { where: eq('data', param(leaf)) }))
			.dump();
		expect(wrapped.sql).toBe(
			'SELECT nodes.* FROM nodes WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.parent_id = nodes_exists_0.id AND nodes_exists_0.data = $1)',
		);
		expect(wrapped.params).toEqual(plain.params);
	});

	it('AC37 batch-and-window-data-opaque', () => {
		const leaf = eq(dataNodes.parent.label, 'x');
		const batch = dataOrm
			.from(
				dataOrm.batchValues(
					[[exists('parent', { where: leaf })]],
					['data'],
					['jsonb'],
				),
			)
			.dump();
		expect(batch.sql).toBe(
			'SELECT batch.* FROM unnest(CAST($1 AS jsonb[])) AS batch(data)',
		);
		expect(batch.params).toEqual([[exists('parent', { where: leaf })]]);
		const lagBody = new SubqueryExpression({
			type: 'select',
			from: 'nodes',
			select: {
				type: 'expressions',
				columns: [
					{
						kind: 'window',
						function: 'lag',
						field: 'data',
						alias: 'v',
						offset: 1,
						defaultValue: leaf,
						over: { orderBy: [{ field: 'id', direction: 'asc' }] },
					},
				],
			},
		} as never);
		const lagged = dataOrm
			.select('nodes')
			.columns([lagBody.asExpr('x')])
			.dump();
		expect(lagged.sql).toBe(
			'SELECT (SELECT lag(nodes_sq.data, $1, $2) OVER (ORDER BY nodes_sq.id ASC) AS v FROM nodes AS nodes_sq) AS x FROM nodes',
		);
		expect(lagged.params).toEqual([1, leaf]);
	});

	it('AC37 shared-occurrence-refused', () => {
		const shared = L();
		expect(() =>
			nodeOrm
				.select('nodes')
				.where(and(shared, exists('parent', { where: shared })))
				.dump(),
		).toThrow(refusal('parent.label'));
	});
});
