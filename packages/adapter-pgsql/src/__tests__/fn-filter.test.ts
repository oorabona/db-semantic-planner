/**
 * Tests for FILTER (WHERE ...) clause support on fn() custom function expressions.
 *
 * Covers: fn('array_agg', ...).filter(condition) and fn('json_agg', ...).filter(condition)
 * at the ExpressionRef API level and through the ORM pipeline (`dump()`).
 */

import {
	createOrm,
	type ExpressionRef,
	eq,
	exprRef,
	fn,
	isNotNull,
	schema,
} from '@dbsp/core';
import type { CustomFnExpressionIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const db = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		active: { type: 'boolean' },
		name: { type: 'text' },
		data: { type: 'jsonb' },
		tag: { type: 'text' },
	},
	items: {
		id: { type: 'integer', primaryKey: true },
		value: { type: 'integer' },
		status: { type: 'text' },
	},
} as const);
const orm = createOrm({
	schema: db,
	adapter: createPgCompileOnlyAdapter({ model: db.model }),
});

// ============================================================================
// Helpers
// ============================================================================

function getExprIntent(expr: ReturnType<typeof fn>): CustomFnExpressionIntent {
	return (expr as unknown as { intent: CustomFnExpressionIntent }).intent;
}

function compileUsersColumns(columns: readonly (string | ExpressionRef)[]) {
	const { sql, params } = orm.select('users').columns(columns).dump();
	return { sql, params };
}

// ============================================================================
// ExpressionRef.filter() — API-level unit tests
// ============================================================================

describe('ExpressionRef.filter()', () => {
	it('fn().filter() returns a new ExpressionRef with filter set', () => {
		const expr = fn('array_agg', exprRef('name'));
		const filtered = expr.filter(eq('active', true));

		const intent = getExprIntent(filtered);
		expect(intent.kind).toBe('customFn');
		expect(intent.name).toBe('array_agg');
		expect(intent.filter).toBeDefined();
		// eq() produces kind:'comparison' (WhereComparisonIntent)
		expect(intent.filter?.kind).toBe('comparison');
	});

	it('fn().filter() does not mutate the original ExpressionRef', () => {
		const expr = fn('array_agg', exprRef('name'));
		expr.filter(eq('active', true));

		const origIntent = getExprIntent(expr);
		expect(origIntent.filter).toBeUndefined();
	});

	it('fn().filter().as() chains correctly', () => {
		const expr = fn('array_agg', exprRef('name'))
			.filter(eq('active', true))
			.as('names');

		const intent = getExprIntent(expr);
		expect(intent.as).toBe('names');
		expect(intent.filter).toBeDefined();
	});

	it('fn().as().filter() chains correctly', () => {
		const expr = fn('array_agg', exprRef('name'))
			.as('names')
			.filter(eq('active', true));

		const intent = getExprIntent(expr);
		expect(intent.as).toBe('names');
		expect(intent.filter).toBeDefined();
	});

	it('filter() throws on non-customFn ExpressionRef (exprRef)', () => {
		const expr = exprRef('name');
		expect(() => expr.filter(eq('active', true))).toThrow(
			'filter() can only be used on function expressions created with fn()',
		);
	});
});

// ============================================================================
// Additional compiler pipeline tests — filter variants
// ============================================================================

describe('fn().filter() — additional variants', () => {
	it('fn() without filter does NOT produce FILTER clause', () => {
		expect(
			compileUsersColumns([fn('array_agg', exprRef('name')).as('names')]),
		).toEqual({
			sql: 'SELECT array_agg(name) AS names FROM users',
			params: [],
		});
	});

	it('schema-qualified fn with filter: my_schema.my_agg(col) FILTER (WHERE ...)', () => {
		const { sql, params } = orm
			.select('items')
			.columns([
				fn('my_schema.my_agg', exprRef('value'))
					.filter(eq('status', 'active'))
					.as('result'),
			])
			.dump();
		expect({ sql, params }).toEqual({
			sql: 'SELECT my_schema.my_agg(value) FILTER (WHERE items.status = $1) AS result FROM items',
			params: ['active'],
		});
	});
});

// ============================================================================
// Full pipeline tests — SQL output via pgsql-deparser
// ============================================================================

describe('fn().filter() produces FILTER clause in SQL', () => {
	it('array_agg(name) FILTER (WHERE active = $1) AS names', () => {
		expect(
			compileUsersColumns([
				fn('array_agg', exprRef('name')).filter(eq('active', true)).as('names'),
			]),
		).toEqual({
			sql: 'SELECT array_agg(name) FILTER (WHERE users.active = $1) AS names FROM users',
			params: [true],
		});
	});

	it('json_agg(data) FILTER (WHERE data IS NOT NULL) AS items', () => {
		expect(
			compileUsersColumns([
				fn('json_agg', exprRef('data')).filter(isNotNull('data')).as('items'),
			]),
		).toEqual({
			sql: 'SELECT json_agg(data) FILTER (WHERE users.data IS NOT NULL) AS items FROM users',
			params: [],
		});
	});

	it('fn() without filter produces no FILTER clause', () => {
		expect(
			compileUsersColumns([fn('array_agg', exprRef('name')).as('names')]),
		).toEqual({
			sql: 'SELECT array_agg(name) AS names FROM users',
			params: [],
		});
	});

	it('multiple decisions: filter uses correct $N param index', () => {
		expect(
			compileUsersColumns([
				'id',
				fn('array_agg', exprRef('tag')).filter(eq('active', true)).as('tags'),
			]),
		).toEqual({
			sql: 'SELECT users.id, array_agg(tag) FILTER (WHERE users.active = $1) AS tags FROM users',
			params: [true],
		});
	});
});
