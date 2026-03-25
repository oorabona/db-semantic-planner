/**
 * Vector Search Integration Tests — FR-4
 *
 * Covers:
 * 1. vectorDims(col) — SELECT vector_dims(col) AS dim
 * 2. cosineDistance() end-to-end: SELECT, WHERE, ORDER BY
 * 3. Self-join pattern for find-duplicates using .join(..., { on, as })
 *
 * All tests use the compile-only adapter (no DB required).
 * SQL assertions use normalizeSQL + toContain / toBe (exact).
 *
 * Note on SQL quoting:
 * - compilePlan() with SimplifiedPlanReport produces unquoted SQL (no model → no naming plugin)
 * - orm.select() with a real model produces double-quoted SQL
 */

import { createOrm, exprRef, op, schema } from '@dbsp/core';
import type { WhereComparisonIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { normalizeSQL } from '../ast-helpers.js';
import { compilePlan, type SimplifiedPlanReport } from '../compiler.js';
import {
	cosineDistance,
	rawDistance,
	vectorDims,
} from '../extensions/pgvector.js';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

const testSchema = schema({
	embeddings: {
		id: { type: 'integer', primaryKey: true },
		model: { type: 'text' },
		vector: { type: 'text', dbType: 'vector(768)' },
	},
});

type ExprRef = ReturnType<typeof vectorDims>;

function exprIntent(expr: ExprRef): unknown {
	return (expr as unknown as { intent: unknown }).intent;
}

function compileSelect(
	expr: ExprRef,
	alias: string,
): { sql: string; parameters: readonly unknown[] } {
	const plan: SimplifiedPlanReport = {
		rootTable: 'embeddings',
		decisions: [
			{
				type: 'selectCustomExpression',
				expressionIntent: exprIntent(expr),
				alias,
			},
		],
	};
	return compilePlan(plan);
}

function compileOrderBy(
	expressionIntent: unknown,
	direction: 'ASC' | 'DESC' = 'ASC',
): { sql: string; parameters: readonly unknown[] } {
	const plan: SimplifiedPlanReport = {
		rootTable: 'embeddings',
		decisions: [
			{ type: 'select', column: '*' },
			{ type: 'orderBy', expressionIntent, direction },
		],
	};
	return compilePlan(plan);
}

const QV = [0.1, 0.2, 0.3];

describe('vectorDims', () => {
	it('compiles to vector_dims(col) in SELECT', () => {
		const expr = vectorDims('vector');
		const { sql, parameters } = compileSelect(expr, 'dim');
		const normalized = normalizeSQL(sql);
		expect(normalized).toContain('vector_dims');
		expect(normalized).toContain('vector');
		expect(normalized).toContain('dim');
		expect(normalized).toContain('from');
		expect(parameters).toHaveLength(0);
	});

	it('returns ExpressionRef chainable with .as() — alias stored in intent', () => {
		const expr = vectorDims('vector').as('ndim');
		// .as() stores alias in intent, returns new ExpressionRef
		expect((expr as unknown as { intent: { as?: string } }).intent.as).toBe('ndim');
	});

	it('produces no bound parameters', () => {
		const { sql, parameters } = compileSelect(vectorDims('vector'), 'dim');
		expect(parameters).toHaveLength(0);
		expect(normalizeSQL(sql)).not.toContain('$1');
	});

	it('SQL contains FROM embeddings table', () => {
		const { sql } = compileSelect(vectorDims('vector'), 'dim');
		expect(normalizeSQL(sql)).toContain('from embeddings');
	});
});

describe('cosineDistance — SELECT', () => {
	it('compiles 1 - (col <=> $1::vector) in SELECT', () => {
		const expr = cosineDistance('vector', QV);
		const { sql, parameters } = compileSelect(expr as ExprRef, 'score');
		const normalized = normalizeSQL(sql);
		expect(normalized).toContain('<=>');
		expect(normalized).toContain('1 -');
		expect(normalized).toContain('score');
		expect(parameters).toHaveLength(1);
		expect(parameters[0]).toEqual(QV);
	});

	it('CAST($N AS vector) appears in SELECT SQL', () => {
		const { sql } = compileSelect(cosineDistance('vector', QV) as ExprRef, 's');
		expect(normalizeSQL(sql)).toMatch(/cast\(\$\d+ as vector\)/);
	});
});

describe('cosineDistance — WHERE', () => {
	it('compiles cosineDistance expression in WHERE with gte threshold', () => {
		const intent = exprIntent(cosineDistance('vector', QV) as ExprRef) as Record<string, unknown>;
		const plan: SimplifiedPlanReport = {
			rootTable: 'embeddings',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					operator: 'expression',
					expressionIntent: intent,
					value: 0.8,
					subqueryOperator: '>=',
				},
			],
		};
		const { sql, parameters } = compilePlan(plan);
		const normalized = normalizeSQL(sql);
		expect(normalized).toContain('where');
		expect(normalized).toContain('<=>');
		expect(normalized).toContain('>=');
		expect(parameters).toHaveLength(2);
		expect(parameters[0]).toEqual(QV);
		expect(parameters[1]).toBe(0.8);
	});

	it('WHERE with lt threshold has correct parameter order', () => {
		const intent = exprIntent(cosineDistance('vector', QV) as ExprRef) as Record<string, unknown>;
		const plan: SimplifiedPlanReport = {
			rootTable: 'embeddings',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					operator: 'expression',
					expressionIntent: intent,
					value: 0.3,
					subqueryOperator: '<',
				},
			],
		};
		const { sql, parameters } = compilePlan(plan);
		const normalized = normalizeSQL(sql);
		expect(normalized).toContain('where');
		expect(normalized).toContain('<');
		expect(parameters[1]).toBe(0.3);
	});
});

describe('cosineDistance — ORDER BY', () => {
	it('compiles rawDistance in ORDER BY ASC', () => {
		const expr = rawDistance('vector', QV);
		const intent = exprIntent(expr as ExprRef);
		const { sql, parameters } = compileOrderBy(intent, 'ASC');
		const normalized = normalizeSQL(sql);
		expect(normalized).toContain('order by');
		expect(normalized).toContain('<=>');
		expect(normalized).toContain('asc');
		expect(parameters[0]).toEqual(QV);
	});

	it('compiles cosineDistance in ORDER BY DESC', () => {
		const expr = cosineDistance('vector', QV);
		const intent = exprIntent(expr as ExprRef);
		const { sql, parameters } = compileOrderBy(intent, 'DESC');
		const normalized = normalizeSQL(sql);
		expect(normalized).toContain('order by');
		expect(normalized).toContain('<=>');
		expect(normalized).toContain('desc');
		expect(parameters[0]).toEqual(QV);
	});
});

describe('cosineDistance — full ANN search pipeline', () => {
	it('SELECT score + WHERE threshold + ORDER BY raw distance + LIMIT', () => {
		const simExpr = cosineDistance('vector', QV);
		const distExpr = rawDistance('vector', QV);
		const distIntent = exprIntent(distExpr as ExprRef);
		const plan: SimplifiedPlanReport = {
			rootTable: 'embeddings',
			decisions: [
				{ type: 'select', column: 'id' },
				{
					type: 'selectCustomExpression',
					expressionIntent: exprIntent(simExpr as ExprRef),
					alias: 'score',
				},
				{
					type: 'where',
					operator: 'expression',
					expressionIntent: exprIntent(simExpr as ExprRef) as Record<string, unknown>,
					value: 0.5,
					subqueryOperator: '>=',
				},
				{ type: 'orderBy', expressionIntent: distIntent, direction: 'ASC' },
				{ type: 'limit', limit: 10 },
			],
		};
		const { sql, parameters } = compilePlan(plan);
		const normalized = normalizeSQL(sql);
		expect(normalized).toContain('id');
		expect(normalized).toContain('<=>');
		expect(normalized).toContain('score');
		expect(normalized).toContain('where');
		expect(normalized).toContain('>=');
		expect(normalized).toContain('order by');
		expect(normalized).toContain('asc');
		expect(normalized).toContain('limit 10');
		expect(parameters).toHaveLength(4);
		expect(parameters[0]).toEqual(QV);
		expect(parameters[2]).toBe(0.5);
		expect(parameters[3]).toEqual(QV);
	});
});

describe('self-join: find-duplicates pattern', () => {
	// ON condition for self-join: embeddings.id < e2.id
	// Uses WhereComparisonIntent directly with fieldRef value (scope: 'outer')
	// per the established pattern in join-api.test.ts
	const selfJoinOn: WhereComparisonIntent = {
		kind: 'comparison',
		field: 'embeddings.id',
		operator: 'lt',
		value: { kind: 'fieldRef', column: 'id', scope: 'outer' },
	};

	it('generates INNER JOIN embeddings AS e2 with ON embeddings.id < e2.id', () => {
		const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });
		const orm = createOrm({ model: testSchema.model, adapter });

		const dump = (orm as any)
			.select('embeddings')
			.join('embeddings', { on: selfJoinOn, as: 'e2', type: 'inner' })
			.dump();

		const sql = dump.sql.replace(/\s+/g, ' ').trim();

		expect(sql).toContain('embeddings');
		expect(sql).toContain('e2');
		expect(sql).toContain('JOIN');
		expect(sql).toContain('ON');
		expect(dump.params).toEqual([]);
	});

	it('self-join SQL matches expected structure (FROM + INNER JOIN + ON id < id)', () => {
		const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });
		const orm = createOrm({ model: testSchema.model, adapter });

		const dump = (orm as any)
			.select('embeddings')
			.join('embeddings', { on: selfJoinOn, as: 'e2', type: 'inner' })
			.dump();

		// Expected: SELECT embeddings.* FROM embeddings JOIN embeddings AS e2 ON embeddings.id < e2.id
		expect(dump.sql.replace(/\s+/g, ' ').trim()).toEqual(
			'SELECT embeddings.* FROM embeddings JOIN embeddings AS e2 ON embeddings.id < e2.id',
		);
		expect(dump.params).toEqual([]);
	});

	it('col-vs-col <=> in SELECT produces zero params', () => {
		const expr = op('<=>', exprRef('e1.vector'), exprRef('e2.vector'));
		const intent = exprIntent(expr as ExprRef);
		const plan: SimplifiedPlanReport = {
			rootTable: 'embeddings',
			decisions: [
				{
					type: 'selectCustomExpression',
					expressionIntent: intent,
					alias: 'dist',
				},
			],
		};
		const { sql, parameters } = compilePlan(plan);
		const normalized = normalizeSQL(sql);
		expect(normalized).toContain('<=>');
		expect(normalized).toContain('e1');
		expect(normalized).toContain('e2');
		expect(parameters).toHaveLength(0);
	});

	it('self-join with cosineDistance in WHERE uses col-vs-col expr', () => {
		// Verify: op(<=> ref ref) in WHERE with .lt() threshold
		const distExpr = op('<=>', exprRef('embeddings.vector'), exprRef('e2.vector'));
		const plan: SimplifiedPlanReport = {
			rootTable: 'embeddings',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					operator: 'expression',
					expressionIntent: exprIntent(distExpr as ExprRef) as Record<string, unknown>,
					value: 0.2,
					subqueryOperator: '<',
				},
			],
		};
		const { sql, parameters } = compilePlan(plan);
		const normalized = normalizeSQL(sql);
		expect(normalized).toContain('<=>');
		expect(normalized).toContain('where');
		expect(normalized).toContain('<');
		// params: just the threshold — no vector param (col-vs-col)
		expect(parameters).toHaveLength(1);
		expect(parameters[0]).toBe(0.2);
	});
});
