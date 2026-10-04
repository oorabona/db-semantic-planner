import {
	createOrm,
	eq,
	literal,
	op,
	outerRef,
	ref,
	schema,
	subquery,
} from '@dbsp/core';
import { expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const db = schema({
	uses: { id: 'integer', file_id: 'integer' },
	files: { id: 'integer' },
	symbols: { id: 'integer' },
	calls: { id: 'integer', symbolId: 'integer' },
});
const orm = createOrm({
	schema: db,
	adapter: createPgCompileOnlyAdapter({ model: db.model }),
});
const on = eq('uses.file_id', ref('files.id'));

it('refuses a manual join alias colliding with the root qualifier', () => {
	expect(() =>
		orm
			.select('uses')
			.join('files', { as: 'uses', on: eq('uses.file_id', ref('uses.id')) })
			.dump(),
	).toThrowError(new Error("Query scope already binds qualifier 'uses'."));
});
it('refuses an alias colliding with an earlier implicit join qualifier', () => {
	expect(() =>
		orm
			.select('uses')
			.join('files', { on })
			.join('symbols', { as: 'files', on })
			.dump(),
	).toThrowError(new Error("Query scope already binds qualifier 'files'."));
});
it('refuses repeated implicit join qualifiers', () => {
	expect(() =>
		orm.select('uses').join('files', { on }).join('files', { on }).dump(),
	).toThrowError(new Error("Query scope already binds qualifier 'files'."));
});
const correlationMessage =
	'Correlated subqueries are not supported in SELECT expressions — use an uncorrelated subquery or a .join() with groupBy and an aggregate.';
for (const nested of [false, true]) {
	for (const entry of ['compileSelectExpression', 'columns'] as const) {
		it(`refuses ${nested ? 'op-nested' : 'direct'} correlation through ${entry}`, () => {
			const sub = subquery('calls')
				.where(eq('symbolId', outerRef('id')))
				.count()
				.asExpr('n');
			const expr = nested ? op('+', sub, literal(1)) : sub;
			expect(() =>
				entry === 'compileSelectExpression'
					? createPgCompileOnlyAdapter().compileSelectExpression(expr.intent)
					: orm.select('symbols').columns(['id', expr]).dump(),
			).toThrowError(new Error(correlationMessage));
		});
	}
}
for (const alias of [undefined, 'draft_posts']) {
	it(`joins a CTE binding with ${alias ? 'explicit' : 'implicit'} natural qualifier`, () => {
		const model = schema({
			posts: { id: 'integer', published: 'boolean' },
			comments: { id: 'integer', postId: 'integer' },
		}).model;
		const result = createPgCompileOnlyAdapter({ model }).compile({
			bindings: new Map([
				[
					'draft_posts',
					{
						type: 'select',
						from: 'posts',
						select: { type: 'fields', fields: ['id'] },
						where: eq('published', false),
					},
				],
			]),
			query: {
				type: 'select',
				from: 'comments',
				select: { type: 'fields', fields: ['id'] },
				joins: [
					{
						table: 'draft_posts',
						...(alias !== undefined && { alias }),
						type: 'inner',
						on: eq('comments.postId', ref('draft_posts.id')),
					},
				],
			},
		});
		expect(result.sql).toBe(
			'WITH "draft_posts" as (SELECT posts.id FROM posts WHERE posts.published = $1) SELECT comments.id FROM comments JOIN draft_posts AS draft_posts ON comments."postId" = draft_posts.id',
		);
		expect(result.parameters).toEqual([false]);
	});
}
it('preserves exact SQL for distinct qualifiers and an uncorrelated SELECT expression', () => {
	const result = orm
		.select('uses')
		.columns(['id', subquery('calls').count().asExpr('callCount')])
		.join('files', { on })
		.join('symbols', { as: 's', on: eq('files.id', ref('s.id')) })
		.dump();
	expect(result.sql).toBe(
		'SELECT uses.id, (SELECT count(*) FROM calls) AS "callCount" FROM uses JOIN files AS files ON uses.file_id = files.id JOIN symbols AS s ON files.id = s.id',
	);
});
