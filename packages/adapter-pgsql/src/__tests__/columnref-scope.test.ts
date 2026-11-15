/**
 * A typed ColumnRef addresses the range its table or relation binds in the
 * query (#991): a TableRef column compiles as `<table>.<column>`, a ref reached
 * through a relation as `<path>.<column>`, and the qualifier resolves through
 * the query scope like the same string.
 */
import {
	any,
	createOrm,
	eq,
	inArray,
	inSubquery,
	isNotNull,
	isNull,
	like,
	neq,
	ref,
	schema,
	subquery,
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
