/**
 * ADR 0011 delivery 4, refusals: a VALUES row has no column to read, an
 * `outerRef()` value has no enclosing query, a mutation value names its
 * position for an unknown qualifier, an expression value needs a model, and
 * the VALUES fallback keeps the parameter limit.
 */
import {
	caseWhen,
	cast,
	createOrm,
	eq,
	exists,
	exprRef,
	InvalidOperationError,
	literal,
	op,
	outerRef,
	param,
	ref,
	schema,
	subquery,
} from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const db = schema({
	users: { id: { type: 'integer', primaryKey: true }, name: 'text' },
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: 'text',
		score: 'integer',
		user_id: ref('users', { as: 'author' }),
	},
} as const);
const orm = createOrm({
	schema: db,
	adapter: createPgCompileOnlyAdapter({ model: db.model }),
	suppressDxWarnings: true,
});
const P = orm.tables.posts;

const READ_TAIL =
	'an INSERT row has no columns in scope. Use a value, param(), literal() or an uncorrelated subquery';
const refusal = (run: () => unknown, message: string) => {
	expect(run).toThrow(InvalidOperationError);
	expect(run).toThrow(message);
};

describe('ADR 0011 delivery 4: mutation value refusals', () => {
	it('values cells cannot read columns', () => {
		const insert = (score: unknown) => () =>
			orm
				.insert('posts')
				.values({ id: 1, score: score as never })
				.dump();
		const cases: [unknown, string][] = [
			[exprRef('score'), "column 'score'"],
			[P.score, "column 'posts.score'"],
			[op('+', exprRef('score'), 1), "column 'score'"],
			[cast(exprRef('score'), 'int4'), "column 'score'"],
			[caseWhen(eq('score', 1), literal(2)).else(literal(3)), "column 'score'"],
			[
				subquery('users')
					.where(eq('id', outerRef('user_id')))
					.count(),
				"column 'user_id'",
			],
			[
				subquery('users')
					.where(
						eq(
							'id',
							subquery('users')
								.where(eq('id', outerRef('posts.user_id')))
								.max('id'),
						),
					)
					.count(),
				"column 'posts.user_id'",
			],
			[
				caseWhen(exists('author'), literal(2)).else(literal(3)),
				"relation 'author'",
			],
		];
		for (const [value, read] of cases)
			refusal(
				insert(value),
				`Invalid insert: values() cannot read ${read}; ${READ_TAIL}`,
			);
		refusal(
			() =>
				orm
					.upsert('posts')
					.values({ id: 1, score: exprRef('score') as never })
					.onConflict(['id'])
					.doUpdate()
					.dump(),
			`Invalid upsert: values() cannot read column 'score'; ${READ_TAIL}`,
		);
		refusal(
			() =>
				orm
					.insert('posts')
					.values([
						{ id: 1, score: exprRef('score') as never },
						{ id: 2, score: 1 },
					])
					.dump({ batchThreshold: 0 }),
			`Invalid insert: values() cannot read column 'score'; ${READ_TAIL}`,
		);
	});

	it('outerRef has no enclosing range in a mutation value', () => {
		expect(() =>
			orm
				.update('posts')
				.set({ score: outerRef('id') as never })
				.where(eq('id', 1))
				.dump(),
		).toThrow('outerRef() requires an enclosing query range.');
		expect(() =>
			orm
				.insert('posts')
				.values({ id: 1, score: outerRef('id') as never })
				.dump(),
		).toThrow('outerRef() requires an enclosing query range.');
	});

	it('mutation values name the position of an unknown qualifier', () => {
		expect(() =>
			orm
				.update('posts')
				.set({ score: exprRef('nope.score') as never })
				.where(eq('id', 1))
				.dump(),
		).toThrow("SET qualifier 'nope' is not visible in this query.");
		expect(() =>
			orm
				.upsert('posts')
				.values({ id: 1, score: 2 })
				.onConflict(['id'])
				.doUpdate({ score: exprRef('excluded.score') as never })
				.dump(),
		).toThrow(
			"DO UPDATE SET qualifier 'excluded' is not visible in this query.",
		);
		expect(() =>
			orm
				.update('posts')
				.batchSet('id', [
					{ id: 1, title: 'a' },
					{ id: 2, title: 'b' },
				])
				.set({ score: exprRef('t.title') as never })
				.dump(),
		).toThrow("SET qualifier 't' is not visible in this query.");
	});

	it('expression values need a model', () => {
		const adapter = createPgCompileOnlyAdapter();
		const where = {
			kind: 'comparison',
			field: 'id',
			operator: 'eq',
			value: 1,
		} as const;
		refusal(
			() =>
				adapter.compileUpdate({
					type: 'update',
					table: 'posts',
					set: { score: op('+', exprRef('score'), 1) },
					where,
				}),
			'Invalid update: an expression value requires a ModelIR; pass a model to the adapter or to the compile options',
		);
		const control = adapter.compileUpdate({
			type: 'update',
			table: 'posts',
			set: { score: param(5) },
			where,
		});
		expect({ sql: control.sql, params: control.parameters }).toEqual({
			sql: 'UPDATE posts SET score = $1 WHERE posts.id = $2',
			params: [5, 1],
		});
	});

	it('fallback keeps the parameter limit', () => {
		refusal(
			() =>
				orm
					.insert('posts')
					.values(
						Array.from({ length: 32768 }, (_, i) => ({
							id: i,
							score: literal(1) as never,
							title: 'x',
						})),
					)
					.dump(),
			'Invalid insert: insert: batch requires 65536 parameters, exceeding PostgreSQL limit 65535',
		);
	});
});
