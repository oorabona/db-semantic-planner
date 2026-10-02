/**
 * Gap 6: orm.selectExpression() — FROM-less SELECT compilation.
 *
 * Exercises:
 *   OrmInstance.selectExpression(expr: ExpressionSpec) →
 *   adapter.compileSelectExpression(intent: ExpressionIntent) →
 *   compileExpressionIntent + selectStmt + deparseQuoted → SQL
 */

import { createOrm, fn, literal, op, param, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

// Minimal schema for ORM integration tests (createOrm requires a schema)
const minimalSchema = schema({
	items: { id: { type: 'integer', primaryKey: true } },
} as const);

// ============================================================================
// PgAdapter.compileSelectExpression() — unit tests
// ============================================================================

describe('PgAdapter.compileSelectExpression()', () => {
	it('compiles nextval() to SELECT nextval(...)', () => {
		const adapter = createPgCompileOnlyAdapter();
		const expr = fn('nextval', literal('my_seq'));
		const { sql, parameters } = adapter.compileSelectExpression(expr.intent);

		expect(sql.replace(/\s+/g, ' ').trim()).toEqual("SELECT nextval('my_seq')");
		expect(parameters).toEqual([]);
	});

	it('compiles now() to SELECT now()', () => {
		const adapter = createPgCompileOnlyAdapter();
		const expr = fn('now');
		const { sql, parameters } = adapter.compileSelectExpression(expr.intent);

		expect(sql.replace(/\s+/g, ' ').trim()).toEqual('SELECT now()');
		expect(parameters).toEqual([]);
	});

	it('compiles parameterized expression: $1 + $2', () => {
		const adapter = createPgCompileOnlyAdapter();
		const expr = op('+', param(1), param(2));
		const { sql, parameters } = adapter.compileSelectExpression(expr.intent);

		expect(sql.replace(/\s+/g, ' ').trim()).toEqual('SELECT $1 + $2');
		expect(parameters).toEqual([1, 2]);
	});

	it('compiles literal integer: SELECT 42', () => {
		const adapter = createPgCompileOnlyAdapter();
		const expr = literal(42);
		const { sql, parameters } = adapter.compileSelectExpression(expr.intent);

		expect(sql.replace(/\s+/g, ' ').trim()).toEqual('SELECT 42');
		expect(parameters).toEqual([]);
	});

	it('compiles literal string: SELECT $1', () => {
		// literal('hello') is a SQL string literal — inlined as 'hello'
		const adapter = createPgCompileOnlyAdapter();
		const expr = literal('hello');
		const { sql, parameters } = adapter.compileSelectExpression(expr.intent);

		// literal() produces inlined SQL — 'hello' not parameterized
		expect(sql.replace(/\s+/g, ' ').trim()).toEqual("SELECT 'hello'");
		expect(parameters).toEqual([]);
	});

	it('compiles nested function call: pg_catalog.version()', () => {
		const adapter = createPgCompileOnlyAdapter();
		const expr = fn('version');
		const { sql, parameters } = adapter.compileSelectExpression(expr.intent);

		expect(sql.replace(/\s+/g, ' ').trim()).toEqual('SELECT version()');
		expect(parameters).toEqual([]);
	});
});

// ============================================================================
// orm.selectExpression() — ORM integration tests
// ============================================================================

describe('orm.selectExpression()', () => {
	it('accepts the caller model through a snake_case adapter boundary', () => {
		const adapter = createPgCompileOnlyAdapter({ dbCasing: 'snake_case' });

		expect(
			adapter.compileSelectExpression(fn('now').intent, {
				model: minimalSchema.model,
			}).sql,
		).toBe('SELECT now()');
	});

	it('returns { sql, parameters } for a scalar fn() expression', () => {
		const adapter = createPgCompileOnlyAdapter();
		const orm = createOrm({ schema: minimalSchema, adapter });

		const result = orm.selectExpression(fn('nextval', literal('my_seq')));

		expect(result.sql.replace(/\s+/g, ' ').trim()).toEqual(
			"SELECT nextval('my_seq')",
		);
		expect(result.parameters).toEqual([]);
	});

	it('returns { sql, parameters } for a parameterized expression', () => {
		const adapter = createPgCompileOnlyAdapter();
		const orm = createOrm({ schema: minimalSchema, adapter });

		const result = orm.selectExpression(op('+', param(10), param(20)));

		expect(result.sql.replace(/\s+/g, ' ').trim()).toEqual('SELECT $1 + $2');
		expect(result.parameters).toEqual([10, 20]);
	});

	it('exposes execute() method on the result object', () => {
		const adapter = createPgCompileOnlyAdapter();
		const orm = createOrm({ schema: minimalSchema, adapter });

		const result = orm.selectExpression(fn('now'));

		expect(typeof result.execute).toBe('function');
	});
});
