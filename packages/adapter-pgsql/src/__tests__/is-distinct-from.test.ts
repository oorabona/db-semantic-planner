/**
 * #462: IS DISTINCT FROM is a null-safe comparison, not a binary '=' operator.
 */

import {
	and,
	createOrm,
	eq,
	exprRef,
	isDistinctFrom,
	ref,
	schema,
} from '@dbsp/core';
import type { QueryIntent, WhereIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import {
	buildSubqueryFromIntent,
	compileWhereIntent,
	type WhereCompilerCtx,
} from '../compile-where.js';
import {
	createCompilerState,
	createWhereDispatcher,
	type Decision,
} from '../handlers/index.js';
import { comparisonHandler } from '../handlers/where/comparison.js';
import { convertWhereCondition } from '../intent-to-decisions.js';
import { identityNaming } from '../naming-plugin.js';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

const testSchema = schema({
	t: {
		id: { type: 'integer', primaryKey: true },
		a: { type: 'text' },
		c: { type: 'integer', nullable: true },
		updated: { type: 'boolean' },
	},
} as const);

function buildOrm() {
	const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });
	return createOrm({ model: testSchema.model, adapter });
}

function whereCtx(): WhereCompilerCtx {
	return {
		rootTable: 't',
		aliases: new Map(),
		paramState: createCompilerState(),
		naming: identityNaming,
		compileSubquery: (intent: QueryIntent, paramOffset: number) =>
			buildSubqueryFromIntent(intent, paramOffset, identityNaming),
	};
}

describe('#462 isDistinctFrom', () => {
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

	it('uses AEXPR_DISTINCT for expression and field-reference comparisons', () => {
		const expressionCtx = whereCtx();
		const expression = compileWhereIntent(
			{
				kind: 'expression',
				expr: { kind: 'literal', value: 1 },
				operator: 'isDistinctFrom',
				value: 2,
			} as unknown as WhereIntent,
			expressionCtx,
		);
		expect(expression).toMatchObject({
			A_Expr: { kind: 'AEXPR_DISTINCT', name: [{ String: { sval: '=' } }] },
		});

		const referenceCtx = whereCtx();
		const reference = compileWhereIntent(
			isDistinctFrom('c', exprRef('a')),
			referenceCtx,
		);
		expect(reference).toMatchObject({
			A_Expr: { kind: 'AEXPR_DISTINCT', name: [{ String: { sval: '=' } }] },
		});
		expect(referenceCtx.paramState.parameters).toEqual([]);

		const refDefinitionCtx = whereCtx();
		const refDefinition = compileWhereIntent(
			isDistinctFrom('c', ref('a')),
			refDefinitionCtx,
		);
		expect(refDefinition).toMatchObject({
			A_Expr: { kind: 'AEXPR_DISTINCT', name: [{ String: { sval: '=' } }] },
		});
		expect(refDefinitionCtx.paramState.parameters).toEqual([]);
	});

	it('compiles scalar subquery comparisons as IS DISTINCT FROM', () => {
		const decisions = convertWhereCondition(
			{
				kind: 'subquery',
				field: 'c',
				operator: 'isDistinctFrom',
				subquery: { from: 't', select: { type: 'fields', fields: ['c'] } },
			} as unknown as WhereIntent,
			't',
		);
		expect(decisions?.subqueryOperator).toBe('isDistinctFrom');
	});

	it('refuses unknown comparison operators on every comparison emission path', () => {
		const unknown = 'unknownComparison';

		expect(() =>
			compileWhereIntent(
				{
					kind: 'expression',
					expr: { kind: 'literal', value: 1 },
					operator: unknown,
					value: 2,
				} as unknown as WhereIntent,
				whereCtx(),
			),
		).toThrow(`No WHERE handler registered for operator: ${unknown}`);

		expect(() =>
			compileWhereIntent(
				{
					kind: 'subquery',
					field: 'c',
					operator: unknown,
					subquery: { from: 't', select: { type: 'fields', fields: ['c'] } },
				} as unknown as WhereIntent,
				whereCtx(),
			),
		).toThrow(`No WHERE handler registered for operator: ${unknown}`);

		expect(() =>
			compileWhereIntent(
				{
					...eq('c', exprRef('a')),
					operator: unknown,
				} as unknown as WhereIntent,
				whereCtx(),
			),
		).toThrow(`No WHERE handler registered for operator: ${unknown}`);

		expect(() =>
			compileWhereIntent(
				{
					...eq('c', ref('a')),
					operator: unknown,
				} as unknown as WhereIntent,
				whereCtx(),
			),
		).toThrow(`No WHERE handler registered for operator: ${unknown}`);

		expect(() =>
			convertWhereCondition(
				{
					kind: 'subquery',
					field: 'c',
					operator: unknown,
					subquery: { from: 't' },
				} as unknown as WhereIntent,
				't',
			),
		).toThrow(`No WHERE handler registered for operator: ${unknown}`);

		expect(() =>
			comparisonHandler.compile(
				{
					type: 'where',
					column: 'c',
					operator: unknown,
					value: 6,
				} as Decision,
				{
					naming: identityNaming,
					rootTable: 't',
					maxRecursiveDepth: 100,
				},
				createCompilerState(),
				createWhereDispatcher(),
			),
		).toThrow(`No WHERE handler registered for operator: ${unknown}`);
	});
});
