/**
 * Error path tests for customExpressionWhereHandler.
 *
 * Verifies that unsupported comparison operators throw rather than silently
 * passing raw strings through to the generated SQL (F-004 audit finding).
 */

import { createOrm, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const db = schema({
	items: {
		id: { type: 'integer', primaryKey: true },
		price: 'integer',
		score: 'integer',
	},
});
const orm = createOrm({
	schema: db,
	adapter: createPgCompileOnlyAdapter({ model: db.model }),
});

function compileWhereExpr(
	column: string,
	operator: string,
	value: unknown = 0,
): { sql: string; params: readonly unknown[] } {
	const { sql, params } = orm
		.select('items')
		.where({
			kind: 'expression',
			expr: { kind: 'ref', column },
			operator,
			value,
		} as never)
		.dump();
	return { sql, params };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('customExpressionWhereHandler — operator validation', () => {
	it('throws for an unmapped operator (injection attempt)', () => {
		expect(() => compileWhereExpr('price', 'LIKE')).toThrow(
			new Error("Unsupported comparison operator 'LIKE'"),
		);
	});

	it('throws for a completely unknown operator', () => {
		expect(() => compileWhereExpr('score', '??')).toThrow(
			new Error("Unsupported comparison operator '??'"),
		);
	});

	it('throws for an empty string operator', () => {
		expect(() => compileWhereExpr('score', '')).toThrow(
			new Error("Unsupported comparison operator ''"),
		);
	});

	it('does not throw for all mapped operators', () => {
		const validOps = [
			['eq', '='],
			['neq', '<>'],
			['gt', '>'],
			['gte', '>='],
			['lt', '<'],
			['lte', '<='],
			['=', '='],
			['!=', '<>'],
			['>', '>'],
			['>=', '>='],
			['<', '<'],
			['<=', '<='],
		] as const;
		for (const [op, sqlOp] of validOps) {
			expect(compileWhereExpr('price', op, 42)).toEqual({
				sql: `SELECT items.* FROM items WHERE items.price ${sqlOp} $1`,
				params: [42],
			});
		}
	});
});
