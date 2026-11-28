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
	distinct,
	ExpressionRef,
	eq,
	every,
	exists,
	fn,
	gt,
	InvalidOperationError,
	inArray,
	inSubquery,
	isNotNull,
	isNull,
	like,
	literal,
	NotYetSupportedError,
	neq,
	none,
	notExists,
	param,
	rawExists,
	ref,
	rowNumber,
	SubqueryExpression,
	schema,
	some,
	star,
	subquery,
	wSum,
} from '@dbsp/core';
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

const nodeTables = {
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
} as const;
const nodeDb = schema(nodeTables);
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

describe('A relation-path ref at the top level or as data keeps its #991 reading', () => {
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
				pathTable: 'nodes',
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
			'SELECT (SELECT lag(nodes_1.data, $1, $2) OVER (ORDER BY nodes_1.id ASC) AS v FROM nodes AS nodes_1) AS x FROM nodes',
		);
		expect(lagged.params).toEqual([1, leaf]);
	});
});

describe('Typed quantifiers and callback refs (#991, #1014)', () => {
	const quantifiers = { some, every, none } as const;
	const writingsDb = schema({
		users: { id: { type: 'integer', primaryKey: true }, email: 'text' },
		posts: {
			id: { type: 'integer', primaryKey: true },
			published: 'boolean',
			author_id: ref('users', { as: 'author', inverse: 'writings' }),
			editor_id: ref('users', { as: 'editor', inverse: 'edits' }),
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
	const plainDb = schema({
		users: { id: { type: 'integer', primaryKey: true }, name: 'text' },
		posts: {
			id: { type: 'integer', primaryKey: true },
			user_id: ref('users', { inverse: 'posts' }),
		},
		comments: {
			id: { type: 'integer', primaryKey: true },
			post_id: ref('posts', { inverse: 'comments' }),
		},
	});
	const plainOrm = createOrm({
		schema: plainDb,
		adapter: createPgCompileOnlyAdapter({ model: plainDb.model }),
		suppressDxWarnings: true,
	});
	const casedDb = schema({
		userProfiles: {
			id: { type: 'integer', primaryKey: true },
			displayName: 'text',
			ownerId: ref('accounts', { as: 'owner', inverse: 'profiles' }),
		},
		accounts: { id: { type: 'integer', primaryKey: true } },
		profileNotes: {
			id: { type: 'integer', primaryKey: true },
			body: 'text',
			profileId: ref('userProfiles', { as: 'profile', inverse: 'notes' }),
		},
	});
	const casedOrm = createOrm({
		schema: casedDb,
		adapter: createPgCompileOnlyAdapter({
			model: casedDb.model,
			dbCasing: 'snake_case',
		}),
		suppressDxWarnings: true,
	});
	const replies = (mode: keyof typeof quantifiers = 'some') =>
		quantifiers[mode](posts.replies, (r) => eq(r.body!, 'x'));
	const children = (mode: keyof typeof quantifiers = 'some') =>
		quantifiers[mode](nodes.children, (c) => eq(c.label!, 'x'));

	// O2 (#1014): a callback column nested in a body inside its callback binds
	// the callback's range (the child, nodes_exists_0), for every leaf constructor.
	it.each([
		[
			'like',
			(c: typeof nodes) => like(c.label!, 'a%'),
			'SELECT nodes.* FROM nodes WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.id = nodes_exists_0.parent_id AND EXISTS (SELECT 1 FROM nodes AS nodes_exists_1 WHERE nodes_exists_0.parent_id = nodes_exists_1.id AND nodes_exists_0.label LIKE $1))',
			['a%'],
		],
		[
			'like case-insensitive',
			(c: typeof nodes) => like(c.label!, 'x%', true),
			'SELECT nodes.* FROM nodes WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.id = nodes_exists_0.parent_id AND EXISTS (SELECT 1 FROM nodes AS nodes_exists_1 WHERE nodes_exists_0.parent_id = nodes_exists_1.id AND nodes_exists_0.label ILIKE $1))',
			['x%'],
		],
		[
			'like escape',
			(c: typeof nodes) => like(c.label!, 'x%', { escape: '!' }),
			'SELECT nodes.* FROM nodes WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.id = nodes_exists_0.parent_id AND EXISTS (SELECT 1 FROM nodes AS nodes_exists_1 WHERE nodes_exists_0.parent_id = nodes_exists_1.id AND nodes_exists_0.label LIKE $1 ESCAPE $2))',
			['x%', '!'],
		],
		[
			'inArray',
			(c: typeof nodes) => inArray(c.label!, ['a']),
			'SELECT nodes.* FROM nodes WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.id = nodes_exists_0.parent_id AND EXISTS (SELECT 1 FROM nodes AS nodes_exists_1 WHERE nodes_exists_0.parent_id = nodes_exists_1.id AND nodes_exists_0.label = ANY ($1)))',
			[['a']],
		],
		[
			'any',
			(c: typeof nodes) => any(c.label!, ['a']),
			'SELECT nodes.* FROM nodes WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.id = nodes_exists_0.parent_id AND EXISTS (SELECT 1 FROM nodes AS nodes_exists_1 WHERE nodes_exists_0.parent_id = nodes_exists_1.id AND nodes_exists_0.label = ANY (CAST($1 AS text[]))))',
			[['a']],
		],
		[
			'isNull',
			(c: typeof nodes) => isNull(c.label!),
			'SELECT nodes.* FROM nodes WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.id = nodes_exists_0.parent_id AND EXISTS (SELECT 1 FROM nodes AS nodes_exists_1 WHERE nodes_exists_0.parent_id = nodes_exists_1.id AND nodes_exists_0.label IS NULL))',
			[],
		],
		[
			'isNotNull',
			(c: typeof nodes) => isNotNull(c.label!),
			'SELECT nodes.* FROM nodes WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.id = nodes_exists_0.parent_id AND EXISTS (SELECT 1 FROM nodes AS nodes_exists_1 WHERE nodes_exists_0.parent_id = nodes_exists_1.id AND nodes_exists_0.label IS NOT NULL))',
			[],
		],
		[
			'inSubquery',
			(c: typeof nodes) =>
				inSubquery(c.id!, subquery('nodes').select('parent_id')),
			'SELECT nodes.* FROM nodes WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.id = nodes_exists_0.parent_id AND EXISTS (SELECT 1 FROM nodes AS nodes_exists_1 WHERE nodes_exists_0.parent_id = nodes_exists_1.id AND nodes_exists_0.id = ANY (SELECT nodes_subq_2.parent_id FROM nodes AS nodes_subq_2)))',
			[],
		],
		[
			'aliased',
			(c: typeof nodes) => eq(c.label!.as('child_label'), 'x'),
			'SELECT nodes.* FROM nodes WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.id = nodes_exists_0.parent_id AND EXISTS (SELECT 1 FROM nodes AS nodes_exists_1 WHERE nodes_exists_0.parent_id = nodes_exists_1.id AND nodes_exists_0.label = $1))',
			['x'],
		],
	] as const)(
		'AC40 callback-token-per-constructor %s',
		(_name, leaf, sql, params) => {
			const dumped = nodeOrm
				.select('nodes')
				.where(
					some(nodes.children, (c) =>
						exists('parent', { where: leaf(c as never) }),
					),
				)
				.dump();
			expect(dumped.sql).toBe(sql);
			expect(dumped.params).toEqual(params);
		},
	);

	it('R3b callback-scoped-columnref: a callback ColumnRef in fn() is not yet supported (#1052)', () => {
		let error: unknown;
		try {
			some(nodes.children, (child) =>
				exists('parent', {
					where: eq('label', fn('upper', child.label!)),
				}),
			);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(NotYetSupportedError);
		expect(error).toMatchObject({
			construct: 'a callback-scoped ColumnRef',
			position: 'expression argument',
			issue: 1052,
			message:
				'a callback-scoped ColumnRef in an expression argument is not supported yet (#1052).',
		});
	});

	it('R2b callback-scoped ColumnRef right: a callback ColumnRef compared as a value is not yet supported (#1052)', () => {
		let error: unknown;
		try {
			some(nodes.children, (child) =>
				exists('parent', { where: eq('label', child.label!) }),
			);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(NotYetSupportedError);
		expect(error).toMatchObject({
			construct: 'a callback-scoped ColumnRef',
			position: 'comparison value',
			issue: 1052,
			message:
				'a callback-scoped ColumnRef in a comparison value is not supported yet (#1052).',
		});
	});

	it('AC41 callback-and-top-level-kept', () => {
		expect(nodeOrm.select('nodes').where(children()).dump().sql).toBe(
			'SELECT nodes.* FROM nodes WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.id = nodes_exists_0.parent_id AND nodes_exists_0.label = $1)',
		);
		// A callback's own relation, directly in its condition, starts from the
		// related row even when an outer range has the same table.
		expect(
			nodeOrm
				.select('nodes')
				.where(
					some(nodes.children, (c) =>
						some(c.children as never, (g) => eq(g.label!, 'x')),
					),
				)
				.dump().sql,
		).toBe(
			'SELECT nodes.* FROM nodes WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.id = nodes_exists_0.parent_id AND EXISTS (SELECT 1 FROM nodes AS nodes_exists_1 WHERE nodes_exists_0.id = nodes_exists_1.parent_id AND nodes_exists_1.label = $1))',
		);
	});

	it.each(['some', 'every', 'none'] as const)(
		'AC44 unambiguous-body-kept exists %s',
		(mode) => {
			expect(
				writingsOrm
					.select('users')
					.where(exists('writings', { where: replies(mode) }))
					.dump().sql,
			).toBe(
				{
					some: 'SELECT users.* FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.author_id AND EXISTS (SELECT 1 FROM comments AS comments_exists_1 WHERE posts_exists_0.id = comments_exists_1.post_id AND comments_exists_1.body = $1))',
					every:
						'SELECT users.* FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.author_id AND NOT (EXISTS (SELECT 1 FROM comments AS comments_exists_1 WHERE posts_exists_0.id = comments_exists_1.post_id AND NOT (comments_exists_1.body = $1))))',
					none: 'SELECT users.* FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.author_id AND NOT (EXISTS (SELECT 1 FROM comments AS comments_exists_1 WHERE posts_exists_0.id = comments_exists_1.post_id AND comments_exists_1.body = $1)))',
				}[mode],
			);
		},
	);

	it('AC44 unambiguous-body-kept rawExists and HAVING', () => {
		expect(
			writingsOrm
				.select('users')
				.where(rawExists(subquery('posts').select('id').where(replies())))
				.dump().sql,
		).toBe(
			'SELECT users.* FROM users WHERE EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE EXISTS (SELECT 1 FROM comments AS comments_exists_0 WHERE posts_sq.id = comments_exists_0.post_id AND comments_exists_0.body = $1))',
		);
		expect(
			writingsOrm
				.select('users')
				.groupBy(['id'])
				.having(exists('writings', { where: replies() }))
				.dump().sql,
		).toBe(
			'SELECT users.* FROM users GROUP BY users.id HAVING EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.author_id AND EXISTS (SELECT 1 FROM comments AS comments_exists_1 WHERE posts_exists_0.id = comments_exists_1.post_id AND comments_exists_1.body = $1))',
		);
	});

	it('AC44 qualifier-only-dotted-value-kept', () => {
		expect(
			nodeOrm
				.select('nodes')
				.where(eq('nodes.id', caseWhen(children(), 1).else(2)))
				.dump().sql,
		).toBe(
			'SELECT nodes.* FROM nodes WHERE nodes.id = CASE WHEN EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.id = nodes_exists_0.parent_id AND nodes_exists_0.label = $1) THEN 1 ELSE 2 END',
		);
	});

	it('AC44 top-level-second-range-kept', () => {
		expect(
			nodeOrm.select('nodes').join('parent').where(children()).dump().sql,
		).toBe(
			'SELECT nodes.* FROM nodes JOIN nodes AS parent ON nodes.parent_id = parent.id WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_1 WHERE nodes.id = nodes_exists_1.parent_id AND nodes_exists_1.label = $1)',
		);
	});

	it('AC44 chained-origin-kept', () => {
		expect(
			writingsOrm
				.select('comments')
				.where(
					rawExists(
						subquery('users')
							.select('id')
							.where(some(users.writings.replies, (r) => eq(r.body!, 'x'))),
					),
				)
				.dump().sql,
		).toBe(
			'SELECT comments.* FROM comments WHERE EXISTS (SELECT users_sq.id FROM users AS users_sq WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users_sq.id = posts_exists_0.author_id AND EXISTS (SELECT 1 FROM comments AS comments_exists_1 WHERE posts_exists_0.id = comments_exists_1.post_id AND comments_exists_1.body = $1)))',
		);
	});

	it('AC44 cased-schema-model-name-kept', () => {
		expect(
			casedOrm
				.select('accounts')
				.where(
					exists('profiles', {
						where: some(casedOrm.tables.userProfiles.notes, (n) =>
							eq(n.body!, 'x'),
						),
					}),
				)
				.dump().sql,
		).toBe(
			'SELECT accounts.* FROM accounts WHERE EXISTS (SELECT 1 FROM user_profiles AS "userProfiles_exists_0" WHERE accounts.id = "userProfiles_exists_0".owner_id AND EXISTS (SELECT 1 FROM profile_notes AS "profileNotes_exists_1" WHERE "userProfiles_exists_0".id = "profileNotes_exists_1".profile_id AND "profileNotes_exists_1".body = $1))',
		);
	});

	it('AC45 legacy-route-unambiguous-kept', () => {
		expect(
			writingsOrm
				.select('users')
				.columns([
					'id',
					subquery('posts').select('id').where(replies()).count().asExpr('n'),
				])
				.dump().sql,
		).toBe(
			'SELECT users.id, (SELECT count(*) FROM posts WHERE EXISTS (SELECT 1 FROM comments AS comments_exists_0 WHERE posts.id = comments_exists_0.post_id AND comments_exists_0.body = $1)) AS n FROM users',
		);
		expect(
			writingsOrm
				.select('users')
				.columns([
					'id',
					subquery('users')
						.select('id')
						.where(exists('writings', { where: replies() }))
						.count()
						.asExpr('n'),
				])
				.dump().sql,
		).toBe(
			'SELECT users.id, (SELECT count(*) FROM users AS users_1 WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users_1.id = posts_exists_0.author_id AND EXISTS (SELECT 1 FROM comments AS comments_exists_1 WHERE posts_exists_0.id = comments_exists_1.post_id AND comments_exists_1.body = $1))) AS n FROM users',
		);
		// A two-hop relation path on the same route traverses both hops (C3).
		expect(
			writingsOrm
				.select('comments')
				.columns([
					subquery('users')
						.where(some(users.writings.replies, (r) => eq(r.body!, 'x')))
						.count()
						.asExpr('n'),
				])
				.dump().sql,
		).toBe(
			'SELECT (SELECT count(*) FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.author_id AND EXISTS (SELECT 1 FROM comments AS comments_exists_1 WHERE posts_exists_0.id = comments_exists_1.post_id AND comments_exists_1.body = $1))) AS n FROM comments',
		);
	});

	it('AC11b having-body-quantifier-resolved: a table-rooted quantifier in a dotted HAVING comparison body follows the unambiguous-range rule', () => {
		expect(
			plainOrm
				.select('users')
				.groupBy(['id'])
				.having(
					inSubquery(
						'users.id',
						subquery('posts')
							.select('user_id')
							.where(some(plainOrm.tables.posts.comments, () => and())),
					),
				)
				.dump().sql,
		).toBe(
			'SELECT users.* FROM users GROUP BY users.id HAVING users.id = ANY (SELECT posts_subq_0.user_id FROM posts AS posts_subq_0 WHERE EXISTS (SELECT 1 FROM comments AS comments_exists_1 WHERE posts_subq_0.id = comments_exists_1.post_id AND true))',
		);
	});

	it('AC45 having-builder-body-kept', () => {
		const body = rawExists(
			// An issued builder body is accepted at runtime; its type lacks the
			// SubqueryBuilder shape (#994).
			plainOrm
				.select('posts')
				.columns(['user_id'])
				.where(some(plainOrm.tables.posts.comments, () => and())) as never,
		).subquery;
		expect(
			plainOrm
				.select('users')
				.groupBy(['id'])
				.having(inSubquery('users.id', new SubqueryExpression(body)))
				.dump().sql,
		).toBe(
			'SELECT users.* FROM users GROUP BY users.id HAVING users.id = ANY (SELECT posts_subq_0.user_id FROM posts AS posts_subq_0 WHERE EXISTS (SELECT 1 FROM comments AS comments_exists_1 WHERE posts_subq_0.id = comments_exists_1.post_id AND true))',
		);
	});
});

describe('A callback-scoped ColumnRef in an ordering, grouping, aggregate or window position (ADR 0011 delivery 3)', () => {
	const scopeDb = schema({
		users: { id: { type: 'integer', primaryKey: true }, name: 'text' },
		posts: {
			id: { type: 'integer', primaryKey: true },
			score: 'integer',
			user_id: ref('users', { as: 'author', inverse: 'posts' }),
		},
	});
	const scopeOrm = createOrm({
		schema: scopeDb,
		adapter: createPgCompileOnlyAdapter({ model: scopeDb.model }),
		suppressDxWarnings: true,
	});
	const captured = (() => {
		let ref: any;
		some(scopeOrm.tables.users.posts, (p) => {
			ref = p;
			return eq(p.id!, 1);
		});
		return ref;
	})();

	function expect1052(build: () => unknown, position: string): void {
		let error: unknown;
		try {
			build();
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(NotYetSupportedError);
		expect(error).toMatchObject({
			construct: 'a callback-scoped ColumnRef',
			position,
			issue: 1052,
		});
	}

	it('R1b orderBy callback ColumnRef: a callback ref is refused as a single ordering and in the list form', () => {
		expect1052(
			() => scopeOrm.select('users').orderBy(captured.id).dump(),
			'ORDER BY',
		);
		expect1052(
			() =>
				scopeOrm
					.select('users')
					.orderBy([{ column: captured.id }])
					.dump(),
			'ORDER BY',
		);
	});

	it('R1d window and distinct callback ColumnRef: a callback ref is refused in wSum, partitionBy, window orderBy and distinct', () => {
		expect1052(() => wSum(captured.score), 'window field');
		expect1052(
			() => rowNumber().partitionBy(captured.score),
			'window partition',
		);
		expect1052(() => rowNumber().orderBy(captured.score), 'window order');
		expect1052(() => distinct(captured.score), 'aggregate field');
	});

	it('R1d ownTable callback ColumnRef: a callback ref of the query table is refused in groupBy and count', () => {
		expect1052(
			() => scopeOrm.select('posts').groupBy([captured.score]).dump(),
			'GROUP BY',
		);
		expect1052(
			() => scopeOrm.select('posts').count(captured.score),
			'aggregate field',
		);
	});

	it('R2b aliased refs keep the scope refusal: an aliased callback ref is refused as a column', () => {
		expect1052(
			() =>
				scopeOrm
					.select('users')
					.columns([captured.id.as('post_id')])
					.dump(),
			'expression argument',
		);
	});
});

/**
 * #1014: a typed ref inside a body resolves from the range it came from. Each
 * unit is a call of the spec's case table (`1014-typed-refs-from-origin`, M7)
 * with its expected SQL and parameters.
 */
describe('A typed ref inside a body resolves from its origin range (#1014)', () => {
	const B = schema(nodeTables);
	const D = schema({
		users: { id: { type: 'integer', primaryKey: true }, email: 'text' },
		posts: {
			id: { type: 'integer', primaryKey: true },
			published: 'boolean',
			title: 'text',
			author_id: ref('users', { as: 'author', inverse: 'writings' }),
			editor_id: ref('users', { as: 'editor', inverse: 'edits' }),
		},
		comments: {
			id: { type: 'integer', primaryKey: true },
			body: 'text',
			post_id: ref('posts', { as: 'post', inverse: 'replies' }),
		},
	});
	const S = schema({
		posts: { id: { type: 'integer', primaryKey: true }, title: 'text' },
		comments: {
			id: { type: 'integer', primaryKey: true },
			body: 'text',
			post_id: ref('posts', { as: 'post', inverse: 'replies' }),
		},
	});
	const DF = schema(
		{
			users: { id: { type: 'integer', primaryKey: true }, email: 'text' },
			posts: {
				id: { type: 'integer', primaryKey: true },
				published: 'boolean',
				deleted_at: { type: 'timestamp', nullable: true },
				author_id: ref('users', { as: 'author', inverse: 'writings' }),
			},
			comments: { id: { type: 'integer', primaryKey: true }, body: 'text' },
		},
		undefined,
		{ defaultFilters: { posts: isNull('deleted_at') } },
	);
	const options = { suppressDxWarnings: true } as const;
	const b = createOrm({
		schema: B,
		adapter: createPgCompileOnlyAdapter({ model: B.model }),
		...options,
	});
	const d = createOrm({
		schema: D,
		adapter: createPgCompileOnlyAdapter({ model: D.model }),
		...options,
	});
	const s = createOrm({
		schema: S,
		adapter: createPgCompileOnlyAdapter({ model: S.model }),
		...options,
	});
	const df = createOrm({
		schema: DF,
		adapter: createPgCompileOnlyAdapter({ model: DF.model }),
		...options,
	});
	// The probes' fixtures are untyped JavaScript; the typed relations are read
	// through these loosely typed handles.
	const nodes: any = b.tables.nodes;
	const users: any = d.tables.users;
	const posts: any = d.tables.posts;
	const U: any = df.tables.users;
	const sTables: any = s.tables;
	const dTables: any = d.tables;
	const SE = SubqueryExpression;
	type Any = any;
	const L = () => eq(nodes.parent.label, 'x');
	const q = () => some(posts.replies, (k: Any) => eq(k.body, 'x'));
	// A callback parameter kept by the callback, then used outside it (O2).
	let saved: any;
	let savedRel: any;
	const sq = some(nodes.children, (k: Any) => {
		saved = k;
		savedRel = k;
		return eq(k.label, 'x');
	});
	const local = () =>
		new SE({
			type: 'select',
			from: 'recent',
			select: { type: 'fields', fields: ['id'] },
			limit: 1,
		} as never).asExpr('v');
	const lb = (where: unknown) =>
		new SE({
			type: 'select',
			from: 'recent',
			select: { type: 'fields', fields: ['id'] },
			where,
			limit: 1,
		} as never).asExpr('v');
	const cte = (query: unknown) =>
		d
			.withCte('recent')
			.fromUnnest({ id: [1, 2] })
			.query(query as never);
	const aggBody = (filter: unknown) =>
		new SE({
			type: 'select',
			from: 'posts',
			select: {
				type: 'aggregate',
				aggregates: [{ function: 'count', field: '*', filter }],
			},
		} as never).asExpr('n');
	const CASE = () =>
		caseWhen(eq(users.writings.published, true), literal(1)).else(literal(0));
	const leaf = L();
	// An expression object in a typed function argument is refused before any
	// origin check (#1116); R9's cases pass a caseWhen() ExpressionRef there.
	const r9Message =
		'Invalid typed function: an expression is not a typed function argument; build the call with fn(name, ...args)';
	const expectR9 = (build: () => unknown): void => {
		let error: unknown;
		try {
			dumpOf(build);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(InvalidOperationError);
		expect(error).toMatchObject({ message: r9Message });
	};
	type Dumped = { sql: string; params?: unknown; parameters?: unknown };
	const dumpOf = (build: () => unknown): Dumped => {
		const built = build() as { dump?: () => Dumped } & Dumped;
		return typeof built.dump === 'function' ? built.dump() : built;
	};
	const expectDump = (
		build: () => unknown,
		sql: string,
		parameters: unknown,
	): void => {
		const dumped = dumpOf(build);
		expect(dumped.sql).toBe(sql);
		expect(dumped.params ?? dumped.parameters).toEqual(parameters);
	};

	it('AC1 / exists (A1)', () => {
		expectDump(
			() => b.select('nodes').where(exists('parent', { where: L() })),
			'SELECT nodes.* FROM nodes WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.parent_id = nodes_exists_0.id AND nodes_exists_0.label = $1)',
			['x'],
		);
	});

	it('AC1 / notExists (A3)', () => {
		expectDump(
			() => b.select('nodes').where(notExists('parent', { where: L() })),
			'SELECT nodes.* FROM nodes WHERE NOT (EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.parent_id = nodes_exists_0.id AND nodes_exists_0.label = $1))',
			['x'],
		);
	});

	it('AC1 / cross-table (A2)', () => {
		expectDump(
			() =>
				d
					.select('users')
					.where(
						exists('writings', { where: eq(users.writings.published, true) }),
					),
			'SELECT users.* FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.author_id AND posts_exists_0.published = $1)',
			[true],
		);
	});

	it('AC1 / quantifier-body (A4)', () => {
		expectDump(
			() =>
				b
					.select('nodes')
					.where(some(nodes.children, () => eq(nodes.children.label, 'x'))),
			'SELECT nodes.* FROM nodes WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.id = nodes_exists_0.parent_id AND nodes_exists_0.label = $1)',
			['x'],
		);
	});

	it('AC1 / every (E8)', () => {
		expectDump(
			() =>
				d
					.select('users')
					.where(
						every(users.writings, () => eq(users.writings.published, true)),
					),
			'SELECT users.* FROM users WHERE NOT (EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.author_id AND NOT (posts_exists_0.published = $1)))',
			[true],
		);
	});

	it('AC2 / outer-root (A13)', () => {
		expectDump(
			() => b.select('nodes').where(exists('children', { where: L() })),
			'SELECT nodes.* FROM nodes WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.id = nodes_exists_0.parent_id AND EXISTS (SELECT 1 FROM nodes AS nodes_exists_1 WHERE nodes.parent_id = nodes_exists_1.id AND nodes_exists_1.label = $1))',
			['x'],
		);
	});

	it('AC2 / single-range-origin (A16)', () => {
		expectDump(
			() =>
				d
					.select('posts')
					.where(
						exists('author', { where: eq(users.writings.published, true) }),
					),
			'SELECT posts.* FROM posts WHERE EXISTS (SELECT 1 FROM users AS users_exists_0 WHERE posts.author_id = users_exists_0.id AND EXISTS (SELECT 1 FROM posts AS posts_exists_1 WHERE users_exists_0.id = posts_exists_1.author_id AND posts_exists_1.published = $1))',
			[true],
		);
	});

	it('AC2 / include-not-bound (E13)', () => {
		expectDump(
			() =>
				d.select('users').where(
					exists('writings', {
						include: { replies: { join: 'inner' } },
						where: eq(users.writings.replies.body, 'x'),
					}),
				),
			'SELECT users.* FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 JOIN comments AS replies ON posts_exists_0.id = replies.post_id WHERE users.id = posts_exists_0.author_id AND EXISTS (SELECT 1 FROM comments AS comments_exists_1 WHERE posts_exists_0.id = comments_exists_1.post_id AND comments_exists_1.body = $1))',
			['x'],
		);
	});

	it('AC2 / multi-hop-predicate (E16)', () => {
		expectDump(
			() =>
				d.select('users').where(
					exists('writings.replies', {
						where: eq(users.writings.title, 'x'),
					}),
				),
			'SELECT users.* FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.author_id AND EXISTS (SELECT 1 FROM comments AS comments_exists_1 WHERE posts_exists_0.id = comments_exists_1.post_id AND posts_exists_0.title = $1))',
			['x'],
		);
	});

	it('AC3 / two-bound (A14)', () => {
		expectDump(
			() =>
				b.select('nodes').where(
					exists('parent', {
						where: exists('parent', {
							where: eq(nodes.parent.parent.label, 'x'),
						}),
					}),
				),
			'SELECT nodes.* FROM nodes WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.parent_id = nodes_exists_0.id AND EXISTS (SELECT 1 FROM nodes AS nodes_exists_1 WHERE nodes_exists_0.parent_id = nodes_exists_1.id AND nodes_exists_1.label = $1))',
			['x'],
		);
	});

	it('AC3 / bound-then-traversed (A15)', () => {
		expectDump(
			() =>
				d
					.select('users')
					.where(
						exists('writings', { where: eq(users.writings.replies.body, 'x') }),
					),
			'SELECT users.* FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.author_id AND EXISTS (SELECT 1 FROM comments AS comments_exists_1 WHERE posts_exists_0.id = comments_exists_1.post_id AND comments_exists_1.body = $1))',
			['x'],
		);
	});

	it('AC4 / rawExists (A5)', () => {
		expectDump(
			() =>
				b
					.select('nodes')
					.where(rawExists(subquery('nodes').select('id').where(L()))),
			'SELECT nodes.* FROM nodes WHERE EXISTS (SELECT nodes_sq.id FROM nodes AS nodes_sq WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes_sq.parent_id = nodes_exists_0.id AND nodes_exists_0.label = $1))',
			['x'],
		);
	});

	it('AC4 / inSubquery (A6)', () => {
		expectDump(
			() =>
				b
					.select('nodes')
					.where(inSubquery('id', subquery('nodes').select('id').where(L()))),
			'SELECT nodes.* FROM nodes WHERE nodes.id = ANY (SELECT nodes_subq_0.id FROM nodes AS nodes_subq_0 WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_1 WHERE nodes_subq_0.parent_id = nodes_exists_1.id AND nodes_exists_1.label = $1))',
			['x'],
		);
	});

	it('AC4 / scalar (A7)', () => {
		expectDump(
			() =>
				b
					.select('nodes')
					.columns([
						'id',
						subquery('nodes').select('id').where(L()).count().asExpr('n'),
					]),
			'SELECT nodes.id, (SELECT count(*) FROM nodes AS nodes_1 WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes_1.parent_id = nodes_exists_0.id AND nodes_exists_0.label = $1)) AS n FROM nodes',
			['x'],
		);
	});

	it('AC4 / outer-origin (E9)', () => {
		expectDump(
			() =>
				d
					.select('users')
					.where(
						rawExists(
							subquery('comments')
								.select('id')
								.where(eq(users.writings.published, true)),
						),
					),
			'SELECT users.* FROM users WHERE EXISTS (SELECT comments_sq.id FROM comments AS comments_sq WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.author_id AND posts_exists_0.published = $1))',
			[true],
		);
	});

	it('AC4 / chain-across-queries (E10)', () => {
		expectDump(
			() =>
				d.select('users').where(
					exists('writings', {
						where: rawExists(
							subquery('comments')
								.select('id')
								.where(eq(users.writings.title, 'x')),
						),
					}),
				),
			'SELECT users.* FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.author_id AND EXISTS (SELECT comments_sq.id FROM comments AS comments_sq WHERE posts_exists_0.title = $1))',
			['x'],
		);
	});

	it('AC4 / rawNotExists (Q1)', () => {
		expectDump(
			() =>
				b.select('nodes').where({
					kind: 'rawNotExists',
					subquery: subquery('nodes')
						.select('id')
						.where(L())
						.build()
						.toIntent(),
				}),
			'SELECT nodes.* FROM nodes WHERE NOT (EXISTS (SELECT nodes_sq.id FROM nodes AS nodes_sq WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes_sq.parent_id = nodes_exists_0.id AND nodes_exists_0.label = $1)))',
			['x'],
		);
	});

	it('AC4 / scalar-comparison (V1)', () => {
		expectDump(
			() =>
				b.select('nodes').where({
					kind: 'subquery',
					field: 'id',
					operator: 'eq',
					subquery: subquery('nodes')
						.select('id')
						.where(L())
						.build()
						.toIntent(),
				}),
			'SELECT nodes.* FROM nodes WHERE nodes.id = (SELECT nodes_subq_0.id FROM nodes AS nodes_subq_0 WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_1 WHERE nodes_subq_0.parent_id = nodes_exists_1.id AND nodes_exists_1.label = $1))',
			['x'],
		);
	});

	it('AC4 / in-rewrite-origin (S1a)', () => {
		expectDump(
			() =>
				b
					.select('nodes')
					.where(
						inSubquery('id', subquery('nodes').select('parent_id').where(L())),
					),
			'SELECT nodes.* FROM nodes WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.id = nodes_exists_0.parent_id AND EXISTS (SELECT 1 FROM nodes AS nodes_exists_1 WHERE nodes_exists_0.parent_id = nodes_exists_1.id AND nodes_exists_1.label = $1))',
			['x'],
		);
	});

	it('AC4 / in-rewrite-string-control (S1d)', () => {
		expectDump(
			() =>
				b
					.select('nodes')
					.where(
						inSubquery(
							'id',
							subquery('nodes').select('parent_id').where(eq('label', 'x')),
						),
					),
			'SELECT nodes.* FROM nodes WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.id = nodes_exists_0.parent_id AND nodes_exists_0.label = $1)',
			['x'],
		);
	});

	it('AC4 / local-where-scalar (W1)', () => {
		expectDump(
			() =>
				cte(d.select('posts').where(eq('id', lb(eq(posts.author.email, 'x'))))),
			'WITH recent AS (SELECT t.id AS id FROM unnest(CAST($1 AS int4[])) AS t(id)) SELECT posts.* FROM posts WHERE posts.id = (SELECT recent.id FROM recent WHERE EXISTS (SELECT 1 FROM users AS users_exists_0 WHERE posts.author_id = users_exists_0.id AND users_exists_0.email = $2) LIMIT 1)',
			[[1, 2], 'x'],
		);
	});

	it('AC4 / local-where-quantifier (W2)', () => {
		expectDump(
			() =>
				cte(
					d
						.select('posts')
						.where(
							eq('id', lb(some(posts.replies, (k: Any) => eq(k.body, 'x')))),
						),
				),
			'WITH recent AS (SELECT t.id AS id FROM unnest(CAST($1 AS int4[])) AS t(id)) SELECT posts.* FROM posts WHERE posts.id = (SELECT recent.id FROM recent WHERE EXISTS (SELECT 1 FROM comments AS comments_exists_0 WHERE posts.id = comments_exists_0.post_id AND comments_exists_0.body = $2) LIMIT 1)',
			[[1, 2], 'x'],
		);
	});

	it('AC4 / local-where-callback (W3)', () => {
		expectDump(
			() =>
				cte(
					d
						.select('users')
						.where(
							some(users.writings, (p: Any) => eq('id', lb(eq(p.title, 'x')))),
						),
				),
			'WITH recent AS (SELECT t.id AS id FROM unnest(CAST($1 AS int4[])) AS t(id)) SELECT users.* FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.author_id AND posts_exists_0.id = (SELECT recent.id FROM recent WHERE posts_exists_0.title = $2 LIMIT 1))',
			[[1, 2], 'x'],
		);
	});

	it('AC4 / local-root-core-resolved (Y1)', () => {
		expectDump(
			() =>
				cte(
					d.select('users').columns([
						caseWhen(
							exists('writings', {
								where: and(
									gt(lb(eq('id', 1)), 0),
									eq(users.writings.published, true),
								),
							}),
							literal(1),
						)
							.else(literal(0))
							.as('c'),
					]),
				),
			'WITH recent AS (SELECT t.id AS id FROM unnest(CAST($1 AS int4[])) AS t(id)) SELECT CASE WHEN EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.author_id AND (SELECT recent.id FROM recent WHERE recent.id = $2 LIMIT 1) > $3 AND posts_exists_0.published = $4) THEN 1 ELSE 0 END AS c FROM users',
			[[1, 2], 1, 0, true],
		);
	});

	it('AC4 / local-rawExists (E26)', () => {
		expectDump(
			() =>
				d
					.withCte('recent')
					.fromUnnest({ id: [1, 2] })
					.query(
						d
							.select('posts')
							.where(
								rawExists(
									subquery('recent')
										.select('id')
										.where(eq(posts.author.email, 'x')),
								),
							),
					),
			'WITH recent AS (SELECT t.id AS id FROM unnest(CAST($1 AS int4[])) AS t(id)) SELECT posts.* FROM posts WHERE EXISTS (SELECT recent_sq.id FROM recent AS recent_sq WHERE EXISTS (SELECT 1 FROM users AS users_exists_0 WHERE posts.author_id = users_exists_0.id AND users_exists_0.email = $2))',
			[[1, 2], 'x'],
		);
	});

	it('AC5 / FILTER (A8)', () => {
		expectDump(
			() =>
				b.select('nodes').columns([
					fn('count', star())
						.filter(exists('parent', { where: L() }))
						.as('n'),
				]),
			'SELECT count(*) FILTER (WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.parent_id = nodes_exists_0.id AND nodes_exists_0.label = $1)) AS n FROM nodes',
			['x'],
		);
	});

	it('AC5 / CASE (A9)', () => {
		expectDump(
			() =>
				b.select('nodes').columns([
					caseWhen(exists('parent', { where: L() }), literal(1))
						.else(literal(0))
						.as('c'),
				]),
			'SELECT CASE WHEN EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.parent_id = nodes_exists_0.id AND nodes_exists_0.label = $1) THEN 1 ELSE 0 END AS c FROM nodes',
			['x'],
		);
	});

	it('AC5 / HAVING (A10)', () => {
		expectDump(
			() =>
				b
					.select('nodes')
					.groupBy(['id'])
					.having(exists('parent', { where: L() })),
			'SELECT nodes.* FROM nodes GROUP BY nodes.id HAVING EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.parent_id = nodes_exists_0.id AND nodes_exists_0.label = $1)',
			['x'],
		);
	});

	it('AC5 / join-on (E14)', () => {
		expectDump(
			() =>
				b.select('nodes').join('nodes', {
					as: 'n2',
					on: and(eq('n2.id', 1), exists('parent', { where: L() })),
				}),
			'SELECT nodes.* FROM nodes JOIN nodes AS n2 ON n2.id = $1 AND EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.parent_id = nodes_exists_0.id AND nodes_exists_0.label = $2)',
			[1, 'x'],
		);
	});

	it('AC5 / body-orderBy (E28)', () => {
		expectDump(
			() =>
				b.select('nodes').columns([
					'id',
					new SubqueryExpression({
						type: 'select',
						from: 'nodes',
						select: { type: 'fields', fields: ['id'] },
						orderBy: [
							{
								expression:
									caseWhen(eq(nodes.parent.label, 'x'), literal(1)).else(
										literal(0),
									).intent ??
									caseWhen(eq(nodes.parent.label, 'x'), literal(1)).else(
										literal(0),
									),
								direction: 'asc',
							},
						],
						limit: 1,
					}).asExpr('v'),
				]),
			'SELECT nodes.id, (SELECT nodes_1.id FROM nodes AS nodes_1 ORDER BY CASE WHEN EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes_1.parent_id = nodes_exists_0.id AND nodes_exists_0.label = $1) THEN 1 ELSE 0 END ASC LIMIT 1) AS v FROM nodes',
			['x'],
		);
	});

	it('AC5 / body-aggregate-filter-inner-ref (G3)', () => {
		expectDump(
			() =>
				d.select('users').columns(['id', aggBody(eq(posts.author.email, 'x'))]),
			'SELECT users.id, (SELECT count(*) FILTER (WHERE EXISTS (SELECT 1 FROM users AS users_exists_0 WHERE posts.author_id = users_exists_0.id AND users_exists_0.email = $1)) FROM posts) AS n FROM users',
			['x'],
		);
	});

	it('AC5 / body-aggregate-filter-inner-quantifier (G4)', () => {
		expectDump(
			() =>
				d
					.select('users')
					.columns([
						'id',
						aggBody(some(posts.replies, (r: Any) => eq(r.body, 'x'))),
					]),
			'SELECT users.id, (SELECT count(*) FILTER (WHERE EXISTS (SELECT 1 FROM comments AS comments_exists_0 WHERE posts.id = comments_exists_0.post_id AND comments_exists_0.body = $1)) FROM posts) AS n FROM users',
			['x'],
		);
	});

	it('AC5 / body-call-inner-column (S2b)', () => {
		expectDump(
			() =>
				d.select('users').columns([
					'id',
					d
						.select('posts')
						.columns([
							fn(
								'count',
								caseWhen(eq('published', true), literal(1)).else(literal(null)),
							).as('n'),
						])
						.asExpr('n'),
				]),
			'SELECT users.id, (SELECT count(CASE WHEN posts.published = $1 THEN 1 ELSE NULL END) AS n FROM posts) AS n FROM users',
			[true],
		);
	});

	it('AC5 / body-call-inner-typed (X4)', () => {
		expectDump(
			() =>
				d.select('users').columns([
					'id',
					d
						.select('posts')
						.columns([
							fn(
								'count',
								caseWhen(eq(posts.author.email, 'x'), literal(1)).else(
									literal(null),
								),
							).as('n'),
						])
						.asExpr('n'),
				]),
			'SELECT users.id, (SELECT count(CASE WHEN EXISTS (SELECT 1 FROM users AS users_exists_0 WHERE posts.author_id = users_exists_0.id AND users_exists_0.email = $1) THEN 1 ELSE NULL END) AS n FROM posts) AS n FROM users',
			['x'],
		);
	});

	it('AC5 / update (A11)', () => {
		expectDump(
			() =>
				d
					.update('users')
					.set({ email: 'e' })
					.where(
						exists('writings', { where: eq(users.writings.published, true) }),
					),
			'UPDATE users SET email = $1 WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.author_id AND posts_exists_0.published = $2)',
			['e', true],
		);
	});

	it('AC5 / delete (A12)', () => {
		expectDump(
			() =>
				d
					.delete('users')
					.where(
						exists('writings', { where: eq(users.writings.published, true) }),
					),
			'DELETE FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.author_id AND posts_exists_0.published = $1)',
			[true],
		);
	});

	it('AC5 / batchSet (E23)', () => {
		expectDump(
			() =>
				d
					.update('users')
					.batchSet('id', [{ id: 1, email: 'a' }])
					.where(
						exists('writings', { where: eq(users.writings.published, true) }),
					),
			'UPDATE users SET email = t.email FROM unnest(CAST($2 AS int4[]), CAST($3 AS text[])) AS t(id, email) WHERE users.id = t.id AND EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.author_id AND posts_exists_0.published = $1)',
			[true, [1], ['a']],
		);
	});

	it('AC5 / upsert-guard (E24)', () => {
		expectDump(
			() =>
				d
					.upsert('users')
					.values({ id: 1, email: 'a' })
					.onConflict(['id'])
					.doUpdate(
						{ email: 'b' },
						exists('writings', { where: eq(users.writings.published, true) }),
					),
			'INSERT INTO users (id, email) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET email = $3 WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.author_id AND posts_exists_0.published = $4)',
			[1, 'a', 'b', true],
		);
	});

	it('AC6 / some (B1)', () => {
		expectDump(
			() =>
				b
					.select('nodes')
					.where(some(nodes.children, (k: Any) => eq(k.parent.label, 'x'))),
			'SELECT nodes.* FROM nodes WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.id = nodes_exists_0.parent_id AND EXISTS (SELECT 1 FROM nodes AS nodes_exists_1 WHERE nodes_exists_0.parent_id = nodes_exists_1.id AND nodes_exists_1.label = $1))',
			['x'],
		);
	});

	it('AC6 / every (B2)', () => {
		expectDump(
			() =>
				b
					.select('nodes')
					.where(every(nodes.children, (k: Any) => eq(k.parent.label, 'x'))),
			'SELECT nodes.* FROM nodes WHERE NOT (EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.id = nodes_exists_0.parent_id AND NOT (EXISTS (SELECT 1 FROM nodes AS nodes_exists_1 WHERE nodes_exists_0.parent_id = nodes_exists_1.id AND nodes_exists_1.label = $1))))',
			['x'],
		);
	});

	it('AC6 / none (Q2)', () => {
		expectDump(
			() =>
				b
					.select('nodes')
					.where(none(nodes.children, (k: Any) => eq(k.parent.label, 'x'))),
			'SELECT nodes.* FROM nodes WHERE NOT (EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.id = nodes_exists_0.parent_id AND EXISTS (SELECT 1 FROM nodes AS nodes_exists_1 WHERE nodes_exists_0.parent_id = nodes_exists_1.id AND nodes_exists_1.label = $1)))',
			['x'],
		);
	});

	it('AC6 / nested-bound (B4)', () => {
		expectDump(
			() =>
				b
					.select('nodes')
					.where(
						some(nodes.children, (k: Any) =>
							exists('parent', { where: eq(k.parent.label, 'x') }),
						),
					),
			'SELECT nodes.* FROM nodes WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.id = nodes_exists_0.parent_id AND EXISTS (SELECT 1 FROM nodes AS nodes_exists_1 WHERE nodes_exists_0.parent_id = nodes_exists_1.id AND nodes_exists_1.label = $1))',
			['x'],
		);
	});

	it('AC7 / in-exists (D1)', () => {
		expectDump(
			() =>
				b
					.select('nodes')
					.where(
						some(nodes.children, (k: Any) =>
							exists('parent', { where: eq(k.label, 'x') }),
						),
					),
			'SELECT nodes.* FROM nodes WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.id = nodes_exists_0.parent_id AND EXISTS (SELECT 1 FROM nodes AS nodes_exists_1 WHERE nodes_exists_0.parent_id = nodes_exists_1.id AND nodes_exists_0.label = $1))',
			['x'],
		);
	});

	it('AC7 / in-quantifier (D2)', () => {
		expectDump(
			() =>
				b
					.select('nodes')
					.where(
						some(nodes.children, (k: Any) =>
							some(k.children, () => eq(k.label, 'x')),
						),
					),
			'SELECT nodes.* FROM nodes WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.id = nodes_exists_0.parent_id AND EXISTS (SELECT 1 FROM nodes AS nodes_exists_1 WHERE nodes_exists_0.id = nodes_exists_1.parent_id AND nodes_exists_0.label = $1))',
			['x'],
		);
	});

	it('AC7 / in-notExists (Q3)', () => {
		expectDump(
			() =>
				b
					.select('nodes')
					.where(
						some(nodes.children, (k: Any) =>
							notExists('parent', { where: eq(k.label, 'x') }),
						),
					),
			'SELECT nodes.* FROM nodes WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.id = nodes_exists_0.parent_id AND NOT (EXISTS (SELECT 1 FROM nodes AS nodes_exists_1 WHERE nodes_exists_0.parent_id = nodes_exists_1.id AND nodes_exists_0.label = $1)))',
			['x'],
		);
	});

	it('AC7 / in-operand (S1e)', () => {
		expectDump(
			() =>
				b.select('nodes').where(
					some(nodes.children, (k: Any) =>
						exists('parent', {
							where: inSubquery(
								k.id,
								subquery('nodes').select('parent_id').where(eq('label', 'x')),
							),
						}),
					),
				),
			'SELECT nodes.* FROM nodes WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.id = nodes_exists_0.parent_id AND EXISTS (SELECT 1 FROM nodes AS nodes_exists_1 WHERE nodes_exists_0.parent_id = nodes_exists_1.id AND nodes_exists_0.id = ANY (SELECT nodes_subq_2.parent_id FROM nodes AS nodes_subq_2 WHERE nodes_subq_2.label = $1)))',
			['x'],
		);
	});

	it('AC7 / in-operand-scalar-body (S1g)', () => {
		expectDump(
			() =>
				d.select('users').where(
					some(users.writings, (p: Any) =>
						gt(
							d
								.select('users')
								.where(inSubquery(p.id, subquery('posts').select('author_id')))
								.count()
								.asExpr('n'),
							0,
						),
					),
				),
			'SELECT users.* FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.author_id AND (SELECT count(*) FROM users AS users_1 WHERE posts_exists_0.id = ANY (SELECT posts_subq_0.author_id FROM posts AS posts_subq_0)) > $1)',
			[0],
		);
	});

	it('AC7 / cross-table (D3)', () => {
		expectDump(
			() =>
				d
					.select('users')
					.where(
						some(users.writings, (p: Any) =>
							some(p.replies, () => eq(p.title, 'x')),
						),
					),
			'SELECT users.* FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.author_id AND EXISTS (SELECT 1 FROM comments AS comments_exists_1 WHERE posts_exists_0.id = comments_exists_1.post_id AND posts_exists_0.title = $1))',
			['x'],
		);
	});

	it('AC7 / dotted-value-side (E11b)', () => {
		expectDump(
			() =>
				d
					.select('users')
					.where(
						some(users.writings, (p: Any) =>
							eq(posts.id, caseWhen(eq(p.published, true), 1).else(2)),
						),
					),
			'SELECT users.* FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.author_id AND posts_exists_0.id = CASE WHEN posts_exists_0.published = $1 THEN 1 ELSE 2 END)',
			[true],
		);
	});

	it('AC8 / single-range-kept (C1)', () => {
		expectDump(
			() => d.select('users').where(exists('writings', { where: q() })),
			'SELECT users.* FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.author_id AND EXISTS (SELECT 1 FROM comments AS comments_exists_1 WHERE posts_exists_0.id = comments_exists_1.post_id AND comments_exists_1.body = $1))',
			['x'],
		);
	});

	it('AC8 / subquery-root (C2)', () => {
		expectDump(
			() =>
				d
					.select('users')
					.where(rawExists(subquery('posts').select('id').where(q()))),
			'SELECT users.* FROM users WHERE EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE EXISTS (SELECT 1 FROM comments AS comments_exists_0 WHERE posts_sq.id = comments_exists_0.post_id AND comments_exists_0.body = $1))',
			['x'],
		);
	});

	it('AC8 / outer-root (C3)', () => {
		expectDump(
			() => d.select('posts').where(exists('author', { where: q() })),
			'SELECT posts.* FROM posts WHERE EXISTS (SELECT 1 FROM users AS users_exists_0 WHERE posts.author_id = users_exists_0.id AND EXISTS (SELECT 1 FROM comments AS comments_exists_1 WHERE posts.id = comments_exists_1.post_id AND comments_exists_1.body = $1))',
			['x'],
		);
	});

	it('AC8 / root-wins (C4)', () => {
		expectDump(
			() =>
				b.select('nodes').where(
					exists('parent', {
						where: some(nodes.children, (k: Any) => eq(k.label, 'x')),
					}),
				),
			'SELECT nodes.* FROM nodes WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.parent_id = nodes_exists_0.id AND EXISTS (SELECT 1 FROM nodes AS nodes_exists_1 WHERE nodes.id = nodes_exists_1.parent_id AND nodes_exists_1.label = $1))',
			['x'],
		);
	});

	it('AC8 / other-relation (C5)', () => {
		expectDump(
			() =>
				d.select('users').where(
					exists('writings', {
						where: some(users.edits, (p: Any) => eq(p.title, 'x')),
					}),
				),
			'SELECT users.* FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.author_id AND EXISTS (SELECT 1 FROM posts AS posts_exists_1 WHERE users.id = posts_exists_1.editor_id AND posts_exists_1.title = $1))',
			['x'],
		);
	});

	it('AC8 / subquery-shadows (E21)', () => {
		expectDump(
			() =>
				b.select('nodes').where(
					rawExists(
						subquery('nodes')
							.select('id')
							.where(some(nodes.children, (k: Any) => eq(k.label, 'x'))),
					),
				),
			'SELECT nodes.* FROM nodes WHERE EXISTS (SELECT nodes_sq.id FROM nodes AS nodes_sq WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes_sq.id = nodes_exists_0.parent_id AND nodes_exists_0.label = $1))',
			['x'],
		);
	});

	it('AC8 / dotted-value-side (E11a)', () => {
		expectDump(
			() =>
				b.select('nodes').where(
					eq(
						'parent.id',
						caseWhen(
							some(nodes.children, (k: Any) => eq(k.label, 'x')),
							1,
						).else(2),
					),
				),
			'SELECT nodes.* FROM nodes WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.parent_id = nodes_exists_0.id AND nodes_exists_0.id = CASE WHEN EXISTS (SELECT 1 FROM nodes AS nodes_exists_1 WHERE nodes.id = nodes_exists_1.parent_id AND nodes_exists_1.label = $1) THEN 1 ELSE 2 END)',
			['x'],
		);
	});

	it('AC8 / having-dotted-body (E12)', () => {
		expectDump(
			() =>
				b
					.select('nodes')
					.groupBy(['id'])
					.having(
						inSubquery(
							'nodes.id',
							subquery('nodes')
								.select('parent_id')
								.where(some(nodes.children, (k: Any) => eq(k.label, 'x'))),
						),
					),
			'SELECT nodes.* FROM nodes GROUP BY nodes.id HAVING nodes.id = ANY (SELECT nodes_subq_0.parent_id FROM nodes AS nodes_subq_0 WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_1 WHERE nodes_subq_0.id = nodes_exists_1.parent_id AND nodes_exists_1.label = $1))',
			['x'],
		);
	});

	it('AC9 / across-subquery (V2)', () => {
		expectDump(
			() =>
				b.select('nodes').where(
					some(nodes.children, (k: Any) =>
						rawExists(
							subquery('nodes')
								.select('id')
								.where(some(k.children, (g: Any) => eq(g.label, 'x'))),
						),
					),
				),
			'SELECT nodes.* FROM nodes WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.id = nodes_exists_0.parent_id AND EXISTS (SELECT nodes_sq.id FROM nodes AS nodes_sq WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_1 WHERE nodes_exists_0.id = nodes_exists_1.parent_id AND nodes_exists_1.label = $1)))',
			['x'],
		);
	});

	it('AC9 / in-relation-predicate (D4)', () => {
		expectDump(
			() =>
				b.select('nodes').where(
					some(nodes.children, (k: Any) =>
						exists('children', {
							where: some(k.children, (g: Any) => eq(g.label, 'x')),
						}),
					),
				),
			'SELECT nodes.* FROM nodes WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.id = nodes_exists_0.parent_id AND EXISTS (SELECT 1 FROM nodes AS nodes_exists_1 WHERE nodes_exists_0.id = nodes_exists_1.parent_id AND EXISTS (SELECT 1 FROM nodes AS nodes_exists_2 WHERE nodes_exists_0.id = nodes_exists_2.parent_id AND nodes_exists_2.label = $1)))',
			['x'],
		);
	});

	it('AC10 / tableref-leaf-shared (V3)', () => {
		expectDump(
			() =>
				b
					.select('nodes')
					.where(
						and(
							exists('children', { where: leaf }),
							rawExists(subquery('nodes').select('id').where(leaf)),
						),
					),
			'SELECT nodes.* FROM nodes WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.id = nodes_exists_0.parent_id AND EXISTS (SELECT 1 FROM nodes AS nodes_exists_1 WHERE nodes.parent_id = nodes_exists_1.id AND nodes_exists_1.label = $1)) AND EXISTS (SELECT nodes_sq.id FROM nodes AS nodes_sq WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_2 WHERE nodes_sq.parent_id = nodes_exists_2.id AND nodes_exists_2.label = $2))',
			['x', 'x'],
		);
	});

	it('AC10 / shared-quantifier (E20)', () => {
		expectDump(
			() => {
				const shared = some(nodes.children, (k: Any) =>
					exists('parent', { where: eq(k.label, 'x') }),
				);
				return b
					.select('nodes')
					.where(and(shared, exists('parent', { where: shared })));
			},
			'SELECT nodes.* FROM nodes WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.id = nodes_exists_0.parent_id AND EXISTS (SELECT 1 FROM nodes AS nodes_exists_1 WHERE nodes_exists_0.parent_id = nodes_exists_1.id AND nodes_exists_0.label = $1)) AND EXISTS (SELECT 1 FROM nodes AS nodes_exists_2 WHERE nodes.parent_id = nodes_exists_2.id AND EXISTS (SELECT 1 FROM nodes AS nodes_exists_3 WHERE nodes.id = nodes_exists_3.parent_id AND EXISTS (SELECT 1 FROM nodes AS nodes_exists_4 WHERE nodes_exists_3.parent_id = nodes_exists_4.id AND nodes_exists_3.label = $2)))',
			['x', 'x'],
		);
	});

	it('AC11 / inverse-spelling (N1)', () => {
		expectDump(
			() =>
				s
					.select('posts')
					.where(
						exists('replies', { where: eq(sTables.posts.comments.body, 'x') }),
					),
			'SELECT posts.* FROM posts WHERE EXISTS (SELECT 1 FROM comments AS comments_exists_0 WHERE posts.id = comments_exists_0.post_id AND comments_exists_0.body = $1)',
			['x'],
		);
	});

	it('AC11 / declared-spelling (N1c)', () => {
		expectDump(
			() =>
				s
					.select('posts')
					.where(
						exists('replies', { where: eq(sTables.posts.replies.body, 'x') }),
					),
			'SELECT posts.* FROM posts WHERE EXISTS (SELECT 1 FROM comments AS comments_exists_0 WHERE posts.id = comments_exists_0.post_id AND comments_exists_0.body = $1)',
			['x'],
		);
	});

	// AC12: every leaf constructor marks a TableRef path with its table, and the
	// leaf inside exists('parent') binds that predicate's target.
	const P = () => nodes.parent.label;
	it.each([
		[
			'AC12 / eq',
			() => eq(P(), 'x'),
			{
				kind: 'comparison',
				field: 'parent.label',
				operator: 'eq',
				value: 'x',
				pathRef: true,
				pathTable: 'nodes',
			},
			'SELECT nodes.* FROM nodes WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.parent_id = nodes_exists_0.id AND nodes_exists_0.label = $1)',
			['x'],
		],
		[
			'AC12 / like',
			() => like(P(), 'x%'),
			{
				kind: 'like',
				field: 'parent.label',
				pattern: 'x%',
				pathRef: true,
				pathTable: 'nodes',
			},
			'SELECT nodes.* FROM nodes WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.parent_id = nodes_exists_0.id AND nodes_exists_0.label LIKE $1)',
			['x%'],
		],
		[
			'AC12 / inArray',
			() => inArray(P(), ['x', 'y']),
			{
				kind: 'in',
				field: 'parent.label',
				values: ['x', 'y'],
				pathRef: true,
				pathTable: 'nodes',
			},
			'SELECT nodes.* FROM nodes WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.parent_id = nodes_exists_0.id AND nodes_exists_0.label = ANY ($1))',
			[['x', 'y']],
		],
		[
			'AC12 / inSubquery',
			() => inSubquery(P(), subquery('nodes').select('label')),
			{
				kind: 'in',
				field: 'parent.label',
				subquery: {
					type: 'select',
					from: 'nodes',
					select: { type: 'fields', fields: ['label'] },
				},
				pathRef: true,
				pathTable: 'nodes',
			},
			'SELECT nodes.* FROM nodes WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.parent_id = nodes_exists_0.id AND nodes_exists_0.label = ANY (SELECT nodes_subq_1.label FROM nodes AS nodes_subq_1))',
			[],
		],
		[
			'AC12 / any',
			() => any(P(), ['x']),
			{
				kind: 'any',
				field: 'parent.label',
				values: ['x'],
				pathRef: true,
				pathTable: 'nodes',
			},
			'SELECT nodes.* FROM nodes WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.parent_id = nodes_exists_0.id AND nodes_exists_0.label = ANY (CAST($1 AS text[])))',
			[['x']],
		],
		[
			'AC12 / isNull',
			() => isNull(P()),
			{
				kind: 'null',
				field: 'parent.label',
				operator: 'isNull',
				pathRef: true,
				pathTable: 'nodes',
			},
			'SELECT nodes.* FROM nodes WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.parent_id = nodes_exists_0.id AND nodes_exists_0.label IS NULL)',
			[],
		],
		[
			'AC12 / isNotNull',
			() => isNotNull(P()),
			{
				kind: 'null',
				field: 'parent.label',
				operator: 'isNotNull',
				pathRef: true,
				pathTable: 'nodes',
			},
			'SELECT nodes.* FROM nodes WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.parent_id = nodes_exists_0.id AND nodes_exists_0.label IS NOT NULL)',
			[],
		],
	] as const)('%s', (_name, build, payload, sql, params) => {
		expect(build()).toEqual(payload);
		expectDump(
			() => b.select('nodes').where(exists('parent', { where: build() })),
			sql,
			params,
		);
	});

	it('AC12 / chained', () => {
		expect(eq(users.writings.replies.body, 'x')).toEqual({
			kind: 'comparison',
			field: 'writings.replies.body',
			operator: 'eq',
			value: 'x',
			pathRef: true,
			pathTable: 'users',
		});
	});

	it('AC13 / root-where (K1)', () => {
		expectDump(
			() => b.select('nodes').where(L()),
			'SELECT nodes.* FROM nodes WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.parent_id = nodes_exists_0.id AND nodes_exists_0.label = $1)',
			['x'],
		);
	});

	it('AC13 / join-bound-by-name (T2)', () => {
		expectDump(
			() => b.select('nodes').join('parent').where(L()),
			'SELECT nodes.* FROM nodes JOIN nodes AS parent ON nodes.parent_id = parent.id WHERE parent.label = $1',
			['x'],
		);
	});

	it('AC13 / include-where (T4)', () => {
		expectDump(
			() => b.select('nodes').include('parent', { join: 'left', where: L() }),
			'SELECT nodes.*, parent.id AS "parent.id", parent.label AS "parent.label", parent.parent_id AS "parent.parent_id", parent.id AS __dbsp_presence_parent FROM nodes LEFT JOIN nodes AS parent ON nodes.parent_id = parent.id WHERE parent.label = $1',
			['x'],
		);
	});

	it('AC13 / renamed-join (T5)', () => {
		expectDump(
			() =>
				d
					.select('users')
					.join('writings', { as: 'w' })
					.where(eq(users.writings.published, true)),
			'SELECT users.* FROM users JOIN posts AS w ON users.id = w.author_id WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_1 WHERE users.id = posts_exists_1.author_id AND posts_exists_1.published = $1)',
			[true],
		);
	});

	it('AC13 / plain-columns K3 (K3)', () => {
		expectDump(
			() =>
				b
					.select('nodes')
					.where(exists('parent', { where: eq(nodes.label, 'x') })),
			'SELECT nodes.* FROM nodes WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.parent_id = nodes_exists_0.id AND nodes_exists_0.label = $1)',
			['x'],
		);
	});

	it('AC13 / plain-columns K4 (K4)', () => {
		expectDump(
			() =>
				b
					.select('nodes')
					.where(some(nodes.children, (k: Any) => eq(k.label, 'x'))),
			'SELECT nodes.* FROM nodes WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.id = nodes_exists_0.parent_id AND nodes_exists_0.label = $1)',
			['x'],
		);
	});

	it('AC13 / local-callback-direct (S3d)', () => {
		expectDump(
			() =>
				b
					.withCte('recent')
					.fromUnnest({ id: [1] })
					.query(
						b.select('nodes').columns([
							caseWhen(
								and(
									some(nodes.children, (k: Any) => eq(k.label, 'x')),
									eq('id', local()),
								),
								literal(1),
							)
								.else(literal(0))
								.as('c'),
						]),
					),
			'WITH recent AS (SELECT t.id AS id FROM unnest(CAST($1 AS int4[])) AS t(id)) SELECT CASE WHEN EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.id = nodes_exists_0.parent_id AND nodes_exists_0.label = $2) AND nodes.id = (SELECT recent.id FROM recent LIMIT 1) THEN 1 ELSE 0 END AS c FROM nodes',
			[[1], 'x'],
		);
	});

	it('AC13 / callback-in-operand-direct (S1f)', () => {
		expectDump(
			() =>
				b
					.select('nodes')
					.where(
						some(nodes.children, (k: Any) =>
							inSubquery(
								k.id,
								subquery('nodes').select('parent_id').where(eq('label', 'x')),
							),
						),
					),
			'SELECT nodes.* FROM nodes WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.id = nodes_exists_0.parent_id AND nodes_exists_0.id = ANY (SELECT nodes_subq_1.parent_id FROM nodes AS nodes_subq_1 WHERE nodes_subq_1.label = $1))',
			['x'],
		);
	});

	it('AC16 / filtered-body (P1)', () => {
		expectDump(
			() =>
				df
					.select('users')
					.where(
						rawExists(
							df.select('comments').where(eq(U.writings.published, true)),
						),
					),
			'SELECT users.* FROM users WHERE EXISTS (SELECT 1 FROM comments AS comments_sq WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.author_id AND posts_exists_0.deleted_at IS NULL AND posts_exists_0.published = $1))',
			[true],
		);
	});

	it('AC16 / unfiltered-body (P2)', () => {
		expectDump(
			() =>
				df
					.select('users')
					.where(
						rawExists(
							df
								.select('comments')
								.withoutDefaultFilters()
								.where(eq(U.writings.published, true)),
						),
					),
			'SELECT users.* FROM users WHERE EXISTS (SELECT 1 FROM comments AS comments_sq WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.author_id AND posts_exists_0.published = $1))',
			[true],
		);
	});

	it('R1 / leaf (R1b)', () => {
		expect(() =>
			dumpOf(() =>
				d
					.select('users')
					.join('writings')
					.where(exists('edits', { where: eq(posts.author.email, 'x') })),
			),
		).toThrow(
			new Error(
				"ColumnRef 'author.email' starts at table 'posts', which several ranges in scope read: 'posts_exists_1', 'writings'; use the callback parameter of a quantifier, or write the path from this query's root.",
			),
		);
	});

	it('R1 / quantifier (E2)', () => {
		expect(() =>
			dumpOf(() =>
				d
					.select('users')
					.join('writings')
					.where(exists('edits', { where: q() })),
			),
		).toThrow(
			new Error(
				"RelationRef 'replies' starts at table 'posts', which several ranges in scope read: 'posts_exists_1', 'writings'; use the callback parameter of a quantifier, or write the path from this query's root.",
			),
		);
	});

	it('R2 / no-range (E3)', () => {
		expect(() =>
			dumpOf(() =>
				d
					.select('users')
					.where(
						exists('writings', { where: eq(dTables.comments.post.title, 'x') }),
					),
			),
		).toThrow(
			new Error(
				"ColumnRef 'post.title' starts at table 'comments', which no query in scope reads.",
			),
		);
	});

	it('R3 / leaf-top-level (E1)', () => {
		expect(() =>
			dumpOf(() => b.select('nodes').where(and(sq, eq(saved.label, 'y')))),
		).toThrow(
			new Error(
				"ColumnRef 'label' comes from a quantifier callback parameter and is used outside that callback.",
			),
		);
	});

	it('R3 / leaf-in-body (E1b)', () => {
		expect(() =>
			dumpOf(() =>
				b
					.select('nodes')
					.where(exists('parent', { where: eq(saved.label, 'y') })),
			),
		).toThrow(
			new Error(
				"ColumnRef 'label' comes from a quantifier callback parameter and is used outside that callback.",
			),
		);
	});

	it('R3 / quantifier (R3b)', () => {
		expect(() =>
			dumpOf(() =>
				b.select('nodes').where(
					and(
						sq,
						some(savedRel.children, (g: Any) => eq(g.label, 'y')),
					),
				),
			),
		).toThrow(
			new Error(
				"RelationRef 'children' comes from a quantifier callback parameter and is used outside that callback.",
			),
		);
	});

	it('R3b / in-operand (S1c)', () => {
		expect(() =>
			dumpOf(() =>
				b
					.select('nodes')
					.where(inSubquery(saved.id, subquery('nodes').select('parent_id'))),
			),
		).toThrow(
			new Error(
				"ColumnRef 'id' comes from a quantifier callback parameter and is used outside that callback.",
			),
		);
	});

	it('R4 / no-origin (E18)', () => {
		expect(() =>
			dumpOf(() =>
				b.select('nodes').where(
					exists('parent', {
						where: {
							kind: 'comparison',
							field: 'parent.label',
							operator: 'eq',
							value: 'x',
							pathRef: true,
						},
					}),
				),
			),
		).toThrow(
			new Error(
				"ColumnRef 'parent.label' follows a relation but carries no origin; build it from orm.tables or a quantifier callback parameter.",
			),
		);
	});

	// AC8 / body-leaf: a typed ref from the root inside a scalar body over a CTE
	// (in a projection, a CASE condition, HAVING) resolves from its origin.
	const localBody = (cond: unknown) =>
		new SE({
			type: 'select',
			from: 'recent',
			where: cond,
			select: {
				type: 'expressions',
				columns: [
					{
						kind: 'case',
						when: [{ condition: cond, result: { kind: 'literal', value: 1 } }],
						else: { kind: 'literal', value: 0 },
						as: 'c',
					},
				],
			},
			limit: 1,
		} as never).asExpr('v');
	it.each([
		[
			'L1',
			() =>
				cte(
					d
						.select('posts')
						.columns(['id', localBody(eq(posts.author.email, 'x'))]),
				),
		],
		[
			'L2',
			() =>
				cte(
					d.select('posts').columns([
						caseWhen(gt(localBody(eq(posts.author.email, 'x')), 0), literal(1))
							.else(literal(0))
							.as('c'),
					]),
				),
		],
		[
			'L3',
			() =>
				cte(
					d
						.select('posts')
						.groupBy(['id'])
						.having(gt(localBody(eq(posts.author.email, 'x')), 0)),
				),
		],
	])('AC8 / body-leaf (%s)', (name, build) => {
		const expected: Record<string, { sql: string; params: unknown[] }> = {
			L1: {
				sql: 'WITH recent AS (SELECT t.id AS id FROM unnest(CAST($1 AS int4[])) AS t(id)) SELECT posts.id, (SELECT CASE WHEN EXISTS (SELECT 1 FROM users AS users_exists_1 WHERE posts.author_id = users_exists_1.id AND users_exists_1.email = $2) THEN 1 ELSE 0 END AS c FROM recent WHERE EXISTS (SELECT 1 FROM users AS users_exists_0 WHERE posts.author_id = users_exists_0.id AND users_exists_0.email = $3) LIMIT 1) AS v FROM posts',
				params: [[1, 2], 'x', 'x'],
			},
			L2: {
				sql: 'WITH recent AS (SELECT t.id AS id FROM unnest(CAST($1 AS int4[])) AS t(id)) SELECT CASE WHEN (SELECT CASE WHEN EXISTS (SELECT 1 FROM users AS users_exists_1 WHERE posts.author_id = users_exists_1.id AND users_exists_1.email = $2) THEN 1 ELSE 0 END AS c FROM recent WHERE EXISTS (SELECT 1 FROM users AS users_exists_0 WHERE posts.author_id = users_exists_0.id AND users_exists_0.email = $3) LIMIT 1) > $4 THEN 1 ELSE 0 END AS c FROM posts',
				params: [[1, 2], 'x', 'x', 0],
			},
			L3: {
				sql: 'WITH recent AS (SELECT t.id AS id FROM unnest(CAST($1 AS int4[])) AS t(id)) SELECT posts.* FROM posts GROUP BY posts.id HAVING (SELECT CASE WHEN EXISTS (SELECT 1 FROM users AS users_exists_1 WHERE posts.author_id = users_exists_1.id AND users_exists_1.email = $2) THEN 1 ELSE 0 END AS c FROM recent WHERE EXISTS (SELECT 1 FROM users AS users_exists_0 WHERE posts.author_id = users_exists_0.id AND users_exists_0.email = $3) LIMIT 1) > $4',
				params: [[1, 2], 'x', 'x', 0],
			},
		};
		const want = expected[name];
		if (!want) throw new Error(`no expectation for ${name}`);
		expectDump(build, want.sql, want.params);
	});

	it('AC8 / body-leaf E25 (E25)', () => {
		expectDump(
			() =>
				d
					.withCte('recent')
					.fromUnnest({ id: [1, 2] })
					.query(
						d.select('posts').columns([
							'id',
							new SubqueryExpression({
								type: 'select',
								from: 'recent',
								where: eq(posts.author.email, 'x'),
								select: {
									type: 'expressions',
									columns: [{ kind: 'literal', value: 1, as: 'c' }],
								},
								limit: 1,
							}).asExpr('v'),
						]),
					),
			'WITH recent AS (SELECT t.id AS id FROM unnest(CAST($1 AS int4[])) AS t(id)) SELECT posts.id, (SELECT 1 AS c FROM recent WHERE EXISTS (SELECT 1 FROM users AS users_exists_0 WHERE posts.author_id = users_exists_0.id AND users_exists_0.email = $2) LIMIT 1) AS v FROM posts',
			[[1, 2], 'x'],
		);
	});

	it('AC8 / root-sibling-leaf (S3b)', () => {
		expectDump(
			() =>
				b
					.withCte('recent')
					.fromUnnest({ id: [1] })
					.query(
						b.select('nodes').columns([
							caseWhen(
								and(exists('parent', { where: L() }), eq('id', local())),
								literal(1),
							)
								.else(literal(0))
								.as('c'),
						]),
					),
			'WITH recent AS (SELECT t.id AS id FROM unnest(CAST($1 AS int4[])) AS t(id)) SELECT CASE WHEN EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.parent_id = nodes_exists_0.id AND nodes_exists_0.label = $2) AND nodes.id = (SELECT recent.id FROM recent LIMIT 1) THEN 1 ELSE 0 END AS c FROM nodes',
			[[1], 'x'],
		);
	});

	it('R5 / root-sibling-stray-callback (S3a)', () => {
		expect(() =>
			dumpOf(() =>
				b
					.withCte('recent')
					.fromUnnest({ id: [1] })
					.query(
						b.select('nodes').columns([
							caseWhen(and(eq(saved.label, 'x'), eq('id', local())), literal(1))
								.else(literal(0))
								.as('c'),
						]),
					),
			),
		).toThrow(
			new Error(
				"ColumnRef 'label' comes from a quantifier callback parameter and is used outside that callback.",
			),
		);
	});

	it('AC8 / root-sibling-nested-callback (S3c)', () => {
		expectDump(
			() =>
				b
					.withCte('recent')
					.fromUnnest({ id: [1] })
					.query(
						b.select('nodes').columns([
							caseWhen(
								and(
									some(nodes.children, (k: Any) =>
										exists('parent', { where: eq(k.label, 'x') }),
									),
									eq('id', local()),
								),
								literal(1),
							)
								.else(literal(0))
								.as('c'),
						]),
					),
			'WITH recent AS (SELECT t.id AS id FROM unnest(CAST($1 AS int4[])) AS t(id)) SELECT CASE WHEN EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.id = nodes_exists_0.parent_id AND EXISTS (SELECT 1 FROM nodes AS nodes_exists_1 WHERE nodes_exists_0.parent_id = nodes_exists_1.id AND nodes_exists_0.label = $2)) AND nodes.id = (SELECT recent.id FROM recent LIMIT 1) THEN 1 ELSE 0 END AS c FROM nodes',
			[[1], 'x'],
		);
	});

	it('AC8 / root-reduced-typed (Y2)', () => {
		expectDump(
			() =>
				cte(
					d.select('users').columns([
						caseWhen(
							and(
								gt(lb(eq('id', 1)), 0),
								exists('writings', {
									where: eq(users.writings.published, true),
								}),
							),
							literal(1),
						)
							.else(literal(0))
							.as('c'),
					]),
				),
			'WITH recent AS (SELECT t.id AS id FROM unnest(CAST($1 AS int4[])) AS t(id)) SELECT CASE WHEN (SELECT recent.id FROM recent WHERE recent.id = $2 LIMIT 1) > $3 AND EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.author_id AND posts_exists_0.published = $4) THEN 1 ELSE 0 END AS c FROM users',
			[[1, 2], 1, 0, true],
		);
	});

	it('AC8 / case-body-quantifier (W4)', () => {
		expectDump(
			() =>
				cte(
					d.select('posts').columns([
						caseWhen(
							gt(lb(some(posts.replies, (k: Any) => eq(k.body, 'x'))), 0),
							literal(1),
						)
							.else(literal(0))
							.as('c'),
					]),
				),
			'WITH recent AS (SELECT t.id AS id FROM unnest(CAST($1 AS int4[])) AS t(id)) SELECT CASE WHEN (SELECT recent.id FROM recent WHERE EXISTS (SELECT 1 FROM comments AS comments_exists_0 WHERE posts.id = comments_exists_0.post_id AND comments_exists_0.body = $2) LIMIT 1) > $3 THEN 1 ELSE 0 END AS c FROM posts',
			[[1, 2], 'x', 0],
		);
	});

	it('R7 / projection-filter-leaf (G1)', () => {
		expect(() =>
			dumpOf(() =>
				d
					.select('users')
					.columns(['id', aggBody(eq(users.writings.published, true))]),
			),
		).toThrow(
			new Error(
				"ColumnRef 'writings.published' resolves to a row outside this subquery body; in a function argument or FILTER there, SQL would evaluate the call in the enclosing query if it is an aggregate.",
			),
		);
	});

	it('R7 / projection-filter-quantifier (G2)', () => {
		expect(() =>
			dumpOf(() =>
				d
					.select('users')
					.columns([
						'id',
						aggBody(some(users.writings, (p: Any) => eq(p.published, true))),
					]),
			),
		).toThrow(
			new Error(
				"RelationRef 'writings' resolves to a row outside this subquery body; in a function argument or FILTER there, SQL would evaluate the call in the enclosing query if it is an aggregate.",
			),
		);
	});

	it('R7 / call-argument (S2a)', () => {
		expect(() =>
			dumpOf(() =>
				d.select('users').columns([
					'id',
					d
						.select('posts')
						.columns([
							fn(
								'count',
								caseWhen(eq(users.writings.published, true), literal(1)).else(
									literal(null),
								),
							).as('n'),
						])
						.asExpr('n'),
				]),
			),
		).toThrow(
			new Error(
				"ColumnRef 'writings.published' resolves to a row outside this subquery body; in a function argument or FILTER there, SQL would evaluate the call in the enclosing query if it is an aggregate.",
			),
		);
	});

	it('R7 / fn-filter (S2c)', () => {
		expect(() =>
			dumpOf(() =>
				d.select('users').columns([
					'id',
					d
						.select('posts')
						.columns([
							fn('count', star())
								.filter(eq(users.writings.published, true))
								.as('n'),
						])
						.asExpr('n'),
				]),
			),
		).toThrow(
			new Error(
				"ColumnRef 'writings.published' resolves to a row outside this subquery body; in a function argument or FILTER there, SQL would evaluate the call in the enclosing query if it is an aggregate.",
			),
		);
	});

	it('R7 / mixed-filter (S2d)', () => {
		expect(() =>
			dumpOf(() =>
				d.select('users').columns([
					'id',
					d
						.select('posts')
						.columns([
							fn('count', star())
								.filter(
									and(
										eq('published', true),
										eq(users.writings.published, true),
									),
								)
								.as('n'),
						])
						.asExpr('n'),
				]),
			),
		).toThrow(
			new Error(
				"ColumnRef 'writings.published' resolves to a row outside this subquery body; in a function argument or FILTER there, SQL would evaluate the call in the enclosing query if it is an aggregate.",
			),
		);
	});

	it('R7 / aggregate-extra-argument (X2)', () => {
		expect(() =>
			dumpOf(() =>
				d.select('users').columns([
					'id',
					d
						.select('posts')
						.columns([
							new ExpressionRef({
								kind: 'aggregate',
								function: 'string_agg',
								field: 'title',
								extraArgs: [CASE()],
							}).as('v'),
						])
						.asExpr('v'),
				]),
			),
		).toThrow(
			new Error(
				"ColumnRef 'writings.published' resolves to a row outside this subquery body; in a function argument or FILTER there, SQL would evaluate the call in the enclosing query if it is an aggregate.",
			),
		);
	});

	it('R7 / callback (S2e)', () => {
		expect(() =>
			dumpOf(() =>
				d.select('users').where(
					some(users.writings, (p: Any) =>
						gt(
							d
								.select('comments')
								.columns([
									fn('count', star()).filter(eq(p.published, true)).as('n'),
								])
								.asExpr('n'),
							0,
						),
					),
				),
			),
		).toThrow(
			new Error(
				"ColumnRef 'published' resolves to a row outside this subquery body; in a function argument or FILTER there, SQL would evaluate the call in the enclosing query if it is an aggregate.",
			),
		);
	});

	it('R8 / ambiguous-inverse (E4)', () => {
		expect(() =>
			dumpOf(() =>
				d
					.select('users')
					.where(
						exists('writings', { where: eq(users.posts.published, true) }),
					),
			),
		).toThrow(
			new Error(
				"exists('posts'): no relation 'posts' is declared on table 'users'. Use rawExists(subquery(...)) for an EXISTS over an undeclared or uncorrelated subquery.",
			),
		);
	});

	it('R9 / body-outer-anchor (X1)', () => {
		expectR9(() =>
			d.select('users').columns([
				'id',
				d
					.select('posts')
					.columns([
						new ExpressionRef({
							kind: 'function',
							name: 'coalesce',
							args: [CASE()],
						}).as('v'),
					])
					.limit(1)
					.asExpr('v'),
			]),
		);
	});

	it('R9 / body-inner-anchor (X3)', () => {
		expectR9(() =>
			d.select('users').columns([
				'id',
				d
					.select('posts')
					.columns([
						new ExpressionRef({
							kind: 'function',
							name: 'coalesce',
							args: [
								caseWhen(eq(posts.author.email, 'x'), literal(1)).else(
									literal(0),
								),
							],
						}).as('v'),
					])
					.limit(1)
					.asExpr('v'),
			]),
		);
	});

	it('R9 / statement-body-path (X5)', () => {
		expectR9(() =>
			d.select('users').columns([
				new ExpressionRef({
					kind: 'function',
					name: 'coalesce',
					args: [
						caseWhen(
							exists('writings', {
								where: eq(users.writings.published, true),
							}),
							literal(1),
						).else(literal(0)),
					],
				}).as('v'),
			]),
		);
	});
	it('R6 / value-and-fn (E27)', () => {
		let error: unknown;
		try {
			b.select('nodes').where(
				some(nodes.children, (k: Any) =>
					some(nodes.children, (g: Any) => eq(g.label, k.label)),
				),
			);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(NotYetSupportedError);
		expect(error).toMatchObject({
			issue: 1052,
			message:
				'a callback-scoped ColumnRef in a comparison value is not supported yet (#1052).',
		});
	});

	// Review regressions: an include's where starts O1 at the statement root, an
	// intermediate hop is a range of its predicate for O8, a HAVING aggregate's
	// extra arguments are call arguments, and the plan decides an anchored
	// quantifier from its origin table.
	const BI = schema({
		...nodeTables,
		items: { id: { type: 'integer', primaryKey: true } },
	});
	const bi = createOrm({
		schema: BI,
		adapter: createPgCompileOnlyAdapter({ model: BI.model }),
		...options,
	});
	const bn: Any = bi.tables.nodes;
	it('O1 include-where body starts at the statement root', () => {
		expectDump(
			() =>
				bi.select('nodes').include('parent', {
					join: 'left',
					where: rawExists(
						subquery('items').select('id').where(eq(bn.parent.label, 'x')),
					),
				}),
			'SELECT nodes.*, parent.id AS "parent.id", parent.label AS "parent.label", parent.parent_id AS "parent.parent_id", parent.id AS __dbsp_presence_parent FROM nodes LEFT JOIN nodes AS parent ON nodes.parent_id = parent.id WHERE EXISTS (SELECT items_sq.id FROM items AS items_sq WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_1 WHERE nodes.parent_id = nodes_exists_1.id AND nodes_exists_1.label = $1))',
			['x'],
		);
	});
	const commentsBody = (filter: unknown) =>
		d
			.select('comments')
			.columns([
				fn('count', star())
					.filter(filter as never)
					.as('n'),
			])
			.asExpr('n');
	it.each([
		[
			'leaf in FILTER',
			() => commentsBody(eq(users.writings.title, 'x')),
			"ColumnRef 'writings.title'",
		],
		[
			'leaf in a count argument',
			() =>
				d
					.select('comments')
					.columns([
						fn(
							'count',
							caseWhen(eq(users.writings.title, 'x'), literal(1)).else(
								literal(null),
							),
						).as('n'),
					])
					.asExpr('n'),
			"ColumnRef 'writings.title'",
		],
		[
			'quantifier in FILTER',
			() =>
				commentsBody(some(users.writings.replies, (k: Any) => eq(k.body, 'x'))),
			"RelationRef 'writings.replies'",
		],
	])(
		'O8 an intermediate-hop anchor is outside the body (%s)',
		(_name, body, written) => {
			expect(() =>
				dumpOf(() =>
					d
						.select('users')
						.where(exists('writings.replies', { where: gt(body(), 0) })),
				),
			).toThrow(
				new Error(
					`${written} resolves to a row outside this subquery body; in a function argument or FILTER there, SQL would evaluate the call in the enclosing query if it is an aggregate.`,
				),
			);
		},
	);
	it('O8 a HAVING aggregate extra argument is a call argument', () => {
		const agg = new ExpressionRef({
			kind: 'aggregate',
			function: 'string_agg',
			field: 'title',
			extraArgs: [
				caseWhen(eq(users.writings.published, true), literal(',')).else(
					literal(';'),
				),
			],
		} as never);
		expect(() =>
			dumpOf(() =>
				d.select('users').columns([
					d
						.select('posts')
						.columns([fn('count', star()).as('n')])
						.having(eq(agg, 'x'))
						.asExpr('v'),
				]),
			),
		).toThrow(
			new Error(
				"ColumnRef 'writings.published' resolves to a row outside this subquery body; in a function argument or FILTER there, SQL would evaluate the call in the enclosing query if it is an aggregate.",
			),
		);
	});
	type Planned = {
		plan?: {
			warnings: readonly { message: string }[];
			decisions: readonly {
				type: string;
				context: { sourceTable?: string; relation?: string };
			}[];
		};
	};
	const decided = (build: () => unknown) => {
		const plan = (dumpOf(build) as unknown as Planned).plan!;
		return {
			warnings: plan.warnings.map((w) => w.message),
			decisions: plan.decisions
				.filter((x) => x.type === 'filter-strategy')
				.map((x) => `${x.context.sourceTable}.${x.context.relation}`),
		};
	};
	it.each([
		[
			'table-rooted quantifier read from the outer root (C3)',
			() => d.select('posts').where(exists('author', { where: q() })),
			['posts.author', 'posts.replies'],
		],
		[
			'table-rooted quantifier read from the statement root (C5)',
			() =>
				d.select('users').where(
					exists('writings', {
						where: some(users.edits, (p: Any) => eq(p.title, 'x')),
					}),
				),
			['users.writings', 'users.edits'],
		],
		[
			'callback relation in a nested predicate',
			() =>
				d.select('users').where(
					some(users.writings, (p: Any) =>
						exists('author', {
							where: some(p.replies, (k: Any) => eq(k.body, 'x')),
						}),
					),
				),
			['users.writings', 'posts.author', 'posts.replies'],
		],
	])(
		'the plan decides an anchored quantifier from its origin table (%s)',
		(_name, build, decisions) => {
			expect(decided(build)).toEqual({ warnings: [], decisions });
		},
	);
});
