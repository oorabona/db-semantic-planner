/**
 * @module fn-relation-col.test
 * Tests for fn() with ref('relation.col') arguments in SELECT context.
 *
 * Verifies that ref('callerFile.path') inside fn('min', ...) correctly resolves
 * to a table-qualified column reference (e.g. "callerFile"."path"), NOT the root
 * table-qualified form ("symbols"."callerFile.path").
 *
 * The ref() case in compileExpressionIntent already splits on '.' — these tests
 * confirm the behaviour holds when ref() is nested inside fn() arguments, since
 * fn() args are compiled recursively via compileExpressionIntent.
 */

import { createOrm, exprRef, fn, ref, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const db = schema({
	files: {
		id: { type: 'integer', primaryKey: true },
		path: 'string',
		name: 'string',
	},
	symbols: {
		id: { type: 'integer', primaryKey: true },
		fileId: ref('files', { as: 'file' }),
	},
});
const orm = createOrm({
	model: db.model,
	adapter: createPgCompileOnlyAdapter({ model: db.model }),
});

describe("fn() with ref('relation.col') argument compilation", () => {
	it('fn("min", ref("callerFile.path")) emits min("callerFile"."path")', () => {
		const { sql, params } = orm
			.select('symbols')
			.join('file', { as: 'callerFile' })
			.columns([fn('min', exprRef('callerFile.path')).as('example')])
			.dump();

		expect({ sql, params }).toEqual({
			sql: 'SELECT min("callerFile".path) AS example FROM symbols JOIN files AS "callerFile" ON symbols."fileId" = "callerFile".id',
			params: [],
		});
	});

	it('nested fn(): inner ref with dot resolves to join alias', () => {
		const { sql, params } = orm
			.select('symbols')
			.join('file', { as: 'callerFile' })
			.columns([
				fn(
					'concat',
					fn('min', exprRef('callerFile.path')),
					fn('max', exprRef('callerFile.name')),
				).as('result'),
			])
			.dump();

		expect({ sql, params }).toEqual({
			sql: 'SELECT concat(min("callerFile".path), max("callerFile".name)) AS result FROM symbols JOIN files AS "callerFile" ON symbols."fileId" = "callerFile".id',
			params: [],
		});
	});
});
