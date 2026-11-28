/**
 * #462: IS DISTINCT FROM is a null-safe comparison, not a binary '=' operator.
 */

import { and, createOrm, eq, isDistinctFrom, plan, schema } from '@dbsp/core';
import type { WhereIntent } from '@dbsp/types';
import type { Node } from '@pgsql/types';
import { deparseSync } from 'pgsql-deparser';
import { describe, expect, it } from 'vitest';
import { createDeclaredNameResolver } from '../declared-name-resolver.js';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';
import { createPgPhysicalModel } from '../physical-model/index.js';

const testSchema = schema({
	t: {
		id: { type: 'integer', primaryKey: true },
		a: { type: 'text' },
		c: { type: 'integer', nullable: true },
		updated: { type: 'boolean' },
	},
	edges: {
		from_id: { type: 'integer' },
		to_id: { type: 'integer' },
	},
} as const);

const plannedDb = schema({
	orders: {
		id: { type: 'integer', primaryKey: true },
		total: { type: 'integer' },
	},
	products: {
		id: { type: 'integer', primaryKey: true },
		price: { type: 'integer' },
		category: { type: 'text' },
	},
	t: {
		id: { type: 'integer', primaryKey: true },
		meta: { type: 'jsonb' },
	},
} as const);

/** Plans `where` on `from` and compiles it through a model-carrying adapter. */
function compileWhereIntentFor(from: string, where: WhereIntent) {
	const adapter = createPgCompileOnlyAdapter({ model: plannedDb.model });
	const { sql, parameters } = adapter.compile(
		plan({ type: 'select', from, where }, plannedDb.model),
	);
	return { sql, params: parameters };
}

function resolverFor(model: typeof testSchema.model) {
	return createDeclaredNameResolver(
		createPgPhysicalModel({
			mode: 'logical',
			model,
			schema: 'public',
			dbCasing: 'preserve',
		}),
	);
}

function buildOrm() {
	const adapter = createPgCompileOnlyAdapter({ model: testSchema.model });
	return createOrm({ model: testSchema.model, adapter });
}

function deparseWhere(node: Node): string {
	return deparseSync([{ SelectStmt: { whereClause: node } }])
		.replace(/^SELECT\s+WHERE\s+/i, '')
		.trim();
}

describe('#462 isDistinctFrom', () => {
	const scalarSubquery = (operator: string, where?: WhereIntent): WhereIntent =>
		({
			kind: 'subquery',
			field: 'total',
			operator,
			subquery: {
				type: 'select',
				from: 'products',
				select: { type: 'fields', fields: ['price'] },
				...(where === undefined ? {} : { where }),
			},
		}) as unknown as WhereIntent;
	const toolsOnly: WhereIntent = {
		kind: 'comparison',
		field: 'category',
		operator: 'eq',
		value: 'tools',
	};

	it('compiles scalar-subquery not-equal', () => {
		expect(compileWhereIntentFor('orders', scalarSubquery('neq'))).toEqual({
			sql: 'SELECT orders.* FROM orders WHERE orders.total <> (SELECT products_subq_0.price FROM products AS products_subq_0)',
			params: [],
		});
	});

	it('compiles scalar-subquery isDistinctFrom', () => {
		expect(
			compileWhereIntentFor('orders', scalarSubquery('isDistinctFrom')),
		).toEqual({
			sql: 'SELECT orders.* FROM orders WHERE orders.total IS DISTINCT FROM (SELECT products_subq_0.price FROM products AS products_subq_0)',
			params: [],
		});
	});

	it('preserves scalar-subquery not-equal bindings', () => {
		expect(
			compileWhereIntentFor('orders', scalarSubquery('neq', toolsOnly)),
		).toEqual({
			sql: 'SELECT orders.* FROM orders WHERE orders.total <> (SELECT products_subq_0.price FROM products AS products_subq_0 WHERE products_subq_0.category = $1)',
			params: ['tools'],
		});
	});

	it('preserves scalar-subquery isDistinctFrom bindings', () => {
		expect(
			compileWhereIntentFor(
				'orders',
				scalarSubquery('isDistinctFrom', toolsOnly),
			),
		).toEqual({
			sql: 'SELECT orders.* FROM orders WHERE orders.total IS DISTINCT FROM (SELECT products_subq_0.price FROM products AS products_subq_0 WHERE products_subq_0.category = $1)',
			params: ['tools'],
		});
	});

	it('refuses an unknown scalar-subquery operator', () => {
		expect(() =>
			compileWhereIntentFor('orders', scalarSubquery('notAnOperator')),
		).toThrow(new Error("Unsupported comparison operator 'notAnOperator'"));
	});

	it('compiles select, update, and nested comparisons with the same bindings as neq', () => {
		const orm = buildOrm();
		const selectBuilder = orm.select('t').where(isDistinctFrom('c', 6));
		expect(selectBuilder.plan().intent?.where).toMatchObject({
			kind: 'comparison',
			operator: 'isDistinctFrom',
		});

		const select = selectBuilder.dump();
		expect(select.sql).toBe('SELECT t.* FROM t WHERE t.c IS DISTINCT FROM $1');
		expect(select.params).toEqual([6]);

		const update = orm
			.modify(orm.tables.t!)
			.set({ updated: true })
			.where(isDistinctFrom('c', 6))
			.dump();
		expect(update.sql).toBe(
			'UPDATE t SET updated = $1 WHERE t.c IS DISTINCT FROM $2',
		);
		expect(update.parameters).toEqual([true, 6]);

		const nested = orm
			.select('t')
			.where(and(eq('a', 'x'), isDistinctFrom('c', 6)))
			.dump();
		expect(nested.sql).toBe(
			'SELECT t.* FROM t WHERE t.a = $1 AND t.c IS DISTINCT FROM $2',
		);
		expect(nested.params).toEqual(['x', 6]);
	});

	it('preserves a normalized JSON decision comparison operator', () => {
		expect(
			compileWhereIntentFor('t', {
				kind: 'comparison',
				field: 'meta',
				operator: 'isDistinctFrom',
				jsonPath: ['kind'],
				jsonMode: 'text',
				value: 'x',
			} as unknown as WhereIntent),
		).toEqual({
			sql: 'SELECT t.* FROM t WHERE (t.meta ->> $1) IS DISTINCT FROM $2',
			params: ['kind', 'x'],
		});
	});

	it('refuses unsupported legacy custom-expression decisions', () => {
		expect(() =>
			compileWhereIntentFor('t', {
				kind: 'expression',
				expr: { kind: 'literal', value: 1 },
				operator: 'toString',
				value: 2,
			} as unknown as WhereIntent),
		).toThrow(new Error("Unsupported comparison operator 'toString'"));
	});

	it('keeps legacy custom-expression decisions in parity', () => {
		const compileLegacy = (operator: 'neq' | 'isDistinctFrom') =>
			compileWhereIntentFor('t', {
				kind: 'expression',
				expr: { kind: 'literal', value: 1 },
				operator,
				value: 6,
			} as unknown as WhereIntent);
		const neqResult = compileLegacy('neq');
		const distinctResult = compileLegacy('isDistinctFrom');
		expect(neqResult.sql).toBe('SELECT t.* FROM t WHERE 1 <> $1');
		expect(distinctResult.sql).toBe(
			'SELECT t.* FROM t WHERE 1 IS DISTINCT FROM $1',
		);
		expect(neqResult.params).toEqual([6]);
		expect(distinctResult.params).toEqual(neqResult.params);
	});
});
