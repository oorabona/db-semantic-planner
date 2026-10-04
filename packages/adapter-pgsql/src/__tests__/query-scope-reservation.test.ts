import { createOrm, eq, outerRef, ref, schema, subquery } from '@dbsp/core';
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
it('refuses correlated SELECT-expression subqueries', () => {
	expect(() =>
		orm
			.select('symbols')
			.columns([
				'id',
				subquery('calls')
					.where(eq('symbolId', outerRef('id')))
					.count()
					.asExpr('callCount'),
			])
			.dump(),
	).toThrowError(
		new Error(
			'scalar subquery with correlated outerRef() is not yet supported — use exists("relation", { where: ... }) when a schema relation exists, or restructure the query to avoid the correlation.',
		),
	);
});
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
