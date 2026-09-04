/**
 * #462: IS DISTINCT FROM is a null-safe comparison, not a binary '=' operator.
 */

import {
	and,
	createOrm,
	eq,
	exprRef,
	isDistinctFrom,
	neq,
	not,
	or,
	ref,
	schema,
} from '@dbsp/core';
import type {
	QueryIntent,
	RecursivePlanReport,
	WhereIntent,
} from '@dbsp/types';
import type { Node } from '@pgsql/types';
import { deparseSync } from 'pgsql-deparser';
import { describe, expect, it } from 'vitest';
import { compileRecursive } from '../adapter-compiler-recursive.js';
import {
	buildSubqueryFromIntent,
	compileWhereIntent,
	type WhereCompilerCtx,
} from '../compile-where.js';
import { compilePlan, type SimplifiedPlanReport } from '../compiler.js';
import {
	createCompilerState,
	createWhereDispatcher,
	type Decision,
} from '../handlers/index.js';
import { comparisonHandler } from '../handlers/where/comparison.js';
import { customExpressionWhereHandler } from '../handlers/where/custom-expression.js';
import { jsonComparisonHandler } from '../handlers/where/json.js';
import { scalarSubqueryHandler } from '../handlers/where/subquery.js';
import { convertWhereCondition } from '../intent-to-decisions.js';
import { identityNaming } from '../naming-plugin.js';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';
import { deparse } from '../pgsql-deparser.js';
import { mapComparisonOperator } from '../plan-decision-extractor.js';

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

function deparseWhere(node: Node): string {
	return deparseSync([{ SelectStmt: { whereClause: node } }])
		.replace(/^SELECT\s+WHERE\s+/i, '')
		.trim();
}

describe('#462 isDistinctFrom', () => {
	const scalarSubqueryPlan = (
		subqueryOperator: string,
		conditions?: readonly unknown[],
	): SimplifiedPlanReport =>
		({
			rootTable: 'orders',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'total',
					operator: 'scalarSubquery',
					subqueryOperator,
					targetTable: 'products',
					selectColumn: 'price',
					conditions,
				},
			],
		}) as SimplifiedPlanReport;

	it('compiles scalar-subquery equality through compilePlan', () => {
		const result = compilePlan(scalarSubqueryPlan('='));
		expect(result.sql).toBe(
			'SELECT * FROM orders WHERE orders.total = (SELECT products_subq_0.price FROM products AS products_subq_0)',
		);
		expect(result.parameters).toEqual([]);
	});

	it('compiles scalar-subquery not-equal through compilePlan', () => {
		const result = compilePlan(scalarSubqueryPlan('!='));
		expect(result.sql).toBe(
			'SELECT * FROM orders WHERE orders.total <> (SELECT products_subq_0.price FROM products AS products_subq_0)',
		);
		expect(result.parameters).toEqual([]);
	});

	it('compiles scalar-subquery isDistinctFrom through compilePlan', () => {
		const result = compilePlan(scalarSubqueryPlan('isDistinctFrom'));
		expect(result.sql).toBe(
			'SELECT * FROM orders WHERE orders.total IS DISTINCT FROM (SELECT products_subq_0.price FROM products AS products_subq_0)',
		);
		expect(result.parameters).toEqual([]);
	});

	it('preserves scalar-subquery not-equal bindings through compilePlan', () => {
		const result = compilePlan(
			scalarSubqueryPlan('!=', [
				{ type: 'where', column: 'category', operator: '=', value: 'tools' },
			]),
		);
		expect(result.sql).toBe(
			'SELECT * FROM orders WHERE orders.total <> (SELECT products_subq_0.price FROM products AS products_subq_0 WHERE products_subq_0.category = $1)',
		);
		expect(result.parameters).toEqual(['tools']);
	});

	it('preserves scalar-subquery isDistinctFrom bindings through compilePlan', () => {
		const result = compilePlan(
			scalarSubqueryPlan('isDistinctFrom', [
				{ type: 'where', column: 'category', operator: '=', value: 'tools' },
			]),
		);
		expect(result.sql).toBe(
			'SELECT * FROM orders WHERE orders.total IS DISTINCT FROM (SELECT products_subq_0.price FROM products AS products_subq_0 WHERE products_subq_0.category = $1)',
		);
		expect(result.parameters).toEqual(['tools']);
	});

	it('refuses an unknown scalar-subquery operator through compilePlan', () => {
		expect(() => compilePlan(scalarSubqueryPlan('notAnOperator'))).toThrow(
			'No WHERE handler registered for operator: notAnOperator',
		);
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

	it('refuses unknown and prototype comparison operators before binding', () => {
		const unknownOperators = [
			'unknownComparison',
			'toString',
			'constructor',
			'__proto__',
		];

		for (const unknown of unknownOperators) {
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

			expect(() =>
				customExpressionWhereHandler.compile(
					{
						type: 'where',
						operator: 'expression',
						subqueryOperator: unknown,
						expressionIntent: { kind: 'literal', value: 1 },
						value: 2,
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

			expect(() =>
				jsonComparisonHandler.compile(
					{
						type: 'where',
						column: 'c',
						operator: 'jsonComparison',
						subqueryOperator: unknown,
						jsonPath: ['key'],
						value: 2,
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

			expect(() => mapComparisonOperator(unknown)).toThrow(
				`No WHERE handler registered for operator: ${unknown}`,
			);
		}

		expect(() =>
			comparisonHandler.compile(
				{ type: 'where', column: 'c', value: 6 } as Decision,
				{
					naming: identityNaming,
					rootTable: 't',
					maxRecursiveDepth: 100,
				},
				createCompilerState(),
				createWhereDispatcher(),
			),
		).toThrow('No WHERE handler registered for operator: undefined');
	});

	it('refuses a scalar subquery operator before subquery validation', () => {
		expect(() =>
			convertWhereCondition(
				{
					kind: 'subquery',
					field: 'c',
					operator: 'unknownComparison',
					subquery: {
						from: 't',
						groupBy: ['c'],
					},
				} as unknown as WhereIntent,
				't',
			),
		).toThrow('No WHERE handler registered for operator: unknownComparison');
	});

	it('leaves no bound parameters after a refusal', () => {
		const ctx = whereCtx();
		expect(() =>
			compileWhereIntent(
				{
					kind: 'comparison',
					field: 'meta',
					operator: 'unknownComparison',
					jsonPath: ['kind'],
					jsonMode: 'text',
					value: 'x',
				} as unknown as WhereIntent,
				ctx,
			),
		).toThrow('No WHERE handler registered for operator: unknownComparison');
		const valid = compileWhereIntent(eq('c', 3), ctx);
		expect(deparseWhere(valid)).toBe('t.c = $1');
		expect(ctx.paramState.parameters).toEqual([3]);
	});

	it('does not inherit an expression comparison operator from Object.prototype', () => {
		const original = Object.getOwnPropertyDescriptor(
			Object.prototype,
			'operator',
		);
		Object.defineProperty(Object.prototype, 'operator', {
			configurable: true,
			writable: true,
			value: 'isDistinctFrom',
		});
		try {
			const node = compileWhereIntent(
				{
					kind: 'expression',
					expr: { kind: 'ref', column: 'active' },
				} as unknown as WhereIntent,
				whereCtx(),
			);
			expect(deparseWhere(node)).toBe('active');
		} finally {
			if (original) {
				Object.defineProperty(Object.prototype, 'operator', original);
			} else {
				delete (Object.prototype as { operator?: unknown }).operator;
			}
		}
	});

	it('refuses absent and empty comparison operators in direct handlers', () => {
		const handlerCtx = {
			naming: identityNaming,
			rootTable: 't',
			maxRecursiveDepth: 100,
		};
		const dispatch = createWhereDispatcher();

		for (const subqueryOperator of [undefined, '']) {
			const operatorProperty =
				subqueryOperator === undefined ? {} : { subqueryOperator };
			const expected = `No WHERE handler registered for operator: ${subqueryOperator}`;

			expect(() =>
				jsonComparisonHandler.compile(
					{
						type: 'where',
						column: 'meta',
						operator: 'jsonComparison',
						jsonPath: ['kind'],
						value: 'x',
						...operatorProperty,
					} as Decision,
					handlerCtx,
					createCompilerState(),
					dispatch,
				),
			).toThrow(expected);

			expect(() =>
				scalarSubqueryHandler.compile(
					{
						type: 'where',
						column: 'c',
						operator: 'scalarSubquery',
						targetTable: 't',
						selectColumn: 'c',
						...operatorProperty,
					} as Decision,
					handlerCtx,
					createCompilerState(),
					dispatch,
				),
			).toThrow(expected);
		}

		expect(() =>
			customExpressionWhereHandler.compile(
				{
					type: 'where',
					operator: 'expression',
					expressionIntent: { kind: 'literal', value: 1 },
					value: 2,
				} as Decision,
				handlerCtx,
				createCompilerState(),
				dispatch,
			),
		).toThrow('No WHERE handler registered for operator: undefined');

		expect(() =>
			customExpressionWhereHandler.compile(
				{
					type: 'where',
					operator: 'expression',
					subqueryOperator: '',
					expressionIntent: { kind: 'literal', value: 1 },
					value: undefined,
				} as Decision,
				handlerCtx,
				createCompilerState(),
				dispatch,
			),
		).toThrow('No WHERE handler registered for operator: ');
	});

	it('keeps neq and isDistinctFrom parameter parity across comparison routes', () => {
		const routes: Array<{
			name: string;
			neq: WhereIntent;
			distinct: WhereIntent;
			expectedNeq: string;
			expectedDistinct: string;
		}> = [
			{
				name: 'plain comparison',
				neq: neq('c', 6),
				distinct: isDistinctFrom('c', 6),
				expectedNeq: 't.c <> $1',
				expectedDistinct: 't.c IS DISTINCT FROM $1',
			},
			{
				name: 'and-or-not nesting',
				neq: not(or(and(neq('c', 6)))) as WhereIntent,
				distinct: not(or(and(isDistinctFrom('c', 6)))) as WhereIntent,
				expectedNeq: 'NOT (t.c <> $1)',
				expectedDistinct: 'NOT (t.c IS DISTINCT FROM $1)',
			},
			{
				name: 'expression comparison',
				neq: {
					kind: 'expression',
					expr: { kind: 'literal', value: 1 },
					operator: 'neq',
					value: 6,
				} as unknown as WhereIntent,
				distinct: {
					kind: 'expression',
					expr: { kind: 'literal', value: 1 },
					operator: 'isDistinctFrom',
					value: 6,
				} as unknown as WhereIntent,
				expectedNeq: '1 != $1',
				expectedDistinct: '1 IS DISTINCT FROM $1',
			},
			{
				name: 'JSON path comparison',
				neq: {
					kind: 'comparison',
					field: 'meta',
					operator: 'neq',
					value: 'x',
					jsonPath: ['kind'],
					jsonMode: 'text',
				} as unknown as WhereIntent,
				distinct: {
					kind: 'comparison',
					field: 'meta',
					operator: 'isDistinctFrom',
					value: 'x',
					jsonPath: ['kind'],
					jsonMode: 'text',
				} as unknown as WhereIntent,
				expectedNeq: '(t.meta ->> $1) != $2',
				expectedDistinct: '(t.meta ->> $1) IS DISTINCT FROM $2',
			},
			{
				name: 'scalar subquery',
				neq: {
					kind: 'subquery',
					field: 'c',
					operator: 'neq',
					subquery: { from: 't', select: { type: 'fields', fields: ['c'] } },
				} as unknown as WhereIntent,
				distinct: {
					kind: 'subquery',
					field: 'c',
					operator: 'isDistinctFrom',
					subquery: { from: 't', select: { type: 'fields', fields: ['c'] } },
				} as unknown as WhereIntent,
				expectedNeq: 't.c != ((SELECT t_sq.c\nFROM t AS t_sq))',
				expectedDistinct:
					't.c IS DISTINCT FROM ((SELECT t_sq.c\nFROM t AS t_sq))',
			},
		];

		for (const route of routes) {
			const neqCtx = whereCtx();
			const distinctCtx = whereCtx();
			expect(deparseWhere(compileWhereIntent(route.neq, neqCtx))).toBe(
				route.expectedNeq,
			);
			expect(
				deparseWhere(compileWhereIntent(route.distinct, distinctCtx)),
			).toBe(route.expectedDistinct);
			expect(distinctCtx.paramState.parameters, route.name).toEqual(
				neqCtx.paramState.parameters,
			);
		}
	});

	it('deparses a nested JSON operand of isDistinctFrom like pgsql-deparser', () => {
		const node = compileWhereIntent(
			{
				kind: 'comparison',
				field: 'meta',
				operator: 'isDistinctFrom',
				value: 'x',
				jsonPath: ['kind'],
				jsonMode: 'text',
			} as unknown as WhereIntent,
			whereCtx(),
		);
		expect(deparse(node)).toBe('(t.meta ->> $1) IS DISTINCT FROM $2');
		expect(deparse(node)).toBe(deparseWhere(node));
	});

	it('preserves a normalized JSON decision comparison operator through compilePlan', () => {
		const result = compilePlan({
			rootTable: 't',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'meta',
					operator: 'jsonComparison',
					subqueryOperator: 'isDistinctFrom',
					jsonPath: ['kind'],
					jsonMode: 'text',
					value: 'x',
				},
			],
		});
		expect(result.sql).toBe(
			'SELECT * FROM t WHERE (t.meta ->> $1) IS DISTINCT FROM $2',
		);
		expect(result.parameters).toEqual(['kind', 'x']);
	});

	it('lowers a standalone custom expression without a comparison-operator property', () => {
		const decision = convertWhereCondition(
			{
				kind: 'expression',
				expr: { kind: 'ref', column: 'active' },
			} as unknown as WhereIntent,
			't',
		);
		expect(Object.hasOwn(decision!, 'subqueryOperator')).toBe(false);
	});

	it('refuses unsupported legacy custom-expression decisions through compilePlan', () => {
		const decision = convertWhereCondition(
			{
				kind: 'expression',
				expr: { kind: 'literal', value: 1 },
				operator: 'toString',
				value: 2,
			} as unknown as WhereIntent,
			't',
		);
		expect(() =>
			compilePlan({
				rootTable: 't',
				decisions: [{ type: 'select', column: '*' }, decision!],
			}),
		).toThrow('No WHERE handler registered for operator: toString');
	});

	it('keeps legacy custom-expression decisions in parity', () => {
		const compileLegacy = (operator: 'neq' | 'isDistinctFrom') => {
			const decision = convertWhereCondition(
				{
					kind: 'expression',
					expr: { kind: 'literal', value: 1 },
					operator,
					value: 6,
				} as unknown as WhereIntent,
				't',
			);
			return compilePlan({
				rootTable: 't',
				decisions: [{ type: 'select', column: '*' }, decision!],
			});
		};
		const neqResult = compileLegacy('neq');
		const distinctResult = compileLegacy('isDistinctFrom');
		expect(neqResult.sql).toBe('SELECT * FROM t WHERE 1 != $1');
		expect(distinctResult.sql).toBe(
			'SELECT * FROM t WHERE 1 IS DISTINCT FROM $1',
		);
		expect(distinctResult.parameters).toEqual(neqResult.parameters);
	});

	it('keeps the recursive-anchor comparison route in parity', () => {
		const compileAnchor = (operator: 'neq' | 'isDistinctFrom') =>
			compileRecursive(
				{
					rootTable: 't',
					decisions: [],
					warnings: [],
					ctes: [],
					intent: {
						type: 'recursive',
						cteName: 'tree',
						start: {
							from: 't',
							nodeIdExpr: { kind: 'column', name: 'id' },
							select: [],
							where: { kind: 'comparison', field: 'c', operator, value: 6 },
						},
						traversal: {
							kind: 'edge-table',
							nodeTable: 't',
							nodeId: 'id',
							edgeTable: 'edges',
							edgeFrom: 'from_id',
							edgeTo: 'to_id',
							direction: 'out',
						},
						maxDepth: 2,
					},
					metadata: {
						planningTimeMs: 0,
						relationsAnalyzed: 0,
						isAmbiguous: false,
						isRecursive: true,
						traversalKind: 'edge-table',
						usesBidirectional: false,
						dedupeStrategy: 'none',
					},
				} as RecursivePlanReport,
				testSchema.model,
				undefined,
				{
					naming: identityNaming,
					schemaName: undefined,
					model: undefined,
					defaultPk: 'id',
					deriveFk: (relation: string) => `${relation}_id`,
				},
			);
		const neqResult = compileAnchor('neq');
		const distinctResult = compileAnchor('isDistinctFrom');
		expect(neqResult.parameters).toEqual([6]);
		expect(distinctResult.parameters).toEqual(neqResult.parameters);
		expect(neqResult.sql).toBe(
			'WITH RECURSIVE tree AS (SELECT __n.id AS id, 1 AS __depth, ARRAY[__n.id] AS __visited FROM t AS __n WHERE __n.c != $1 UNION ALL SELECT __n.id AS id, tree.__depth + 1 AS __depth, tree.__visited || __n.id AS __visited FROM tree JOIN edges AS __e ON __e.from_id = tree.id JOIN t AS __n ON __n.id = __e.to_id WHERE tree.__depth < 2 AND __n.id <> ALL (tree.__visited)) SELECT tree.id AS id FROM tree',
		);
		expect(distinctResult.sql).toBe(
			'WITH RECURSIVE tree AS (SELECT __n.id AS id, 1 AS __depth, ARRAY[__n.id] AS __visited FROM t AS __n WHERE __n.c IS DISTINCT FROM $1 UNION ALL SELECT __n.id AS id, tree.__depth + 1 AS __depth, tree.__visited || __n.id AS __visited FROM tree JOIN edges AS __e ON __e.from_id = tree.id JOIN t AS __n ON __n.id = __e.to_id WHERE tree.__depth < 2 AND __n.id <> ALL (tree.__visited)) SELECT tree.id AS id FROM tree',
		);
	});

	it('refuses a recursive-anchor operator before naming the field', () => {
		const naming = Object.assign(Object.create(identityNaming), {
			toDatabase: () => {
				throw new Error('naming plugin should not run');
			},
		}) as typeof identityNaming;
		expect(() =>
			compileRecursive(
				{
					rootTable: 't',
					decisions: [],
					warnings: [],
					ctes: [],
					intent: {
						type: 'recursive',
						cteName: 'tree',
						start: {
							from: 't',
							nodeIdExpr: { kind: 'column', name: 'id' },
							select: [],
							where: {
								kind: 'comparison',
								field: 'c',
								operator: 'unknownComparison',
								value: 6,
							},
						},
						traversal: {
							kind: 'edge-table',
							nodeTable: 't',
							nodeId: 'id',
							edgeTable: 'edges',
							edgeFrom: 'from_id',
							edgeTo: 'to_id',
							direction: 'out',
						},
						maxDepth: 2,
					},
					metadata: {
						planningTimeMs: 0,
						relationsAnalyzed: 0,
						isAmbiguous: false,
						isRecursive: true,
						traversalKind: 'edge-table',
						usesBidirectional: false,
						dedupeStrategy: 'none',
					},
				} as unknown as RecursivePlanReport,
				testSchema.model,
				undefined,
				{
					naming,
					schemaName: undefined,
					model: undefined,
					defaultPk: 'id',
					deriveFk: (relation: string) => `${relation}_id`,
				},
			),
		).toThrow('No WHERE handler registered for operator: unknownComparison');
	});
});
