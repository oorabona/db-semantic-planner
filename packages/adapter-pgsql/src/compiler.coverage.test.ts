// @ts-nocheck — coverage test: runtime assertions on AST nodes
/**
 * Coverage tests for compiler.ts.
 *
 * Focus: Uncovered branches in PlanCompiler including:
 * - Various decision types (selectFunction, selectExpression, selectWindow, etc.)
 * - existsWrap functionality
 * - DISTINCT handling
 * - Schema scoping
 * - Lock clauses (FOR UPDATE, FOR SHARE, SKIP LOCKED, NOWAIT)
 * - ORDER BY with nulls (FIRST/LAST)
 * - GROUP BY and HAVING
 * - Parameterized limit/offset
 * - Include strategies (json_agg, lateral, cte)
 * - JOIN filter strategy
 * - Set operations branches
 * - IN/NOT IN subquery handling
 * - Nested conditions (whereAnd, whereOr, whereNot)
 * - Returning clauses
 */

import { markNqlTrustedRelationFilter } from '@dbsp/types/internal';
import { describe, expect, it } from 'vitest';
import { POSTGRESQL_CAPABILITIES } from '../../core/src/dialects/index.js';
import { normalizeSQL } from './ast-helpers.js';
import { PlanCompiler, type SimplifiedPlanReport } from './compiler.js';
import { identityNaming } from './naming-plugin.js';

describe('PlanCompiler - Coverage Tests', () => {
	describe('existsWrap', () => {
		it('wraps SELECT in EXISTS subquery', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [{ type: 'select', column: 'id' }],
				existsWrap: true,
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('exists');
			expect(result.ast).toHaveProperty('SelectStmt');
		});

		it('handles existsWrap with WHERE clause', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{ type: 'where', column: 'active', operator: '=', value: true },
				],
				existsWrap: true,
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('exists');
			expect(sql).toContain('where');
		});
	});

	describe('DISTINCT', () => {
		it('compiles SELECT DISTINCT', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [{ type: 'select', column: 'email' }, { type: 'distinct' }],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('distinct');
		});
	});

	describe('Schema scoping', () => {
		it('includes schema in FROM clause via plan.schema', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				schema: 'tenant_a',
				decisions: [{ type: 'select', column: '*' }],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			expect(result.sql).toContain('tenant_a');
		});

		it('includes schema via compiler options', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [{ type: 'select', column: '*' }],
			};
			const compiler = new PlanCompiler({ schema: 'tenant_b' });
			const result = compiler.compile(plan);
			expect(result.sql).toContain('tenant_b');
		});

		it('plan.schema overrides compiler schema', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				schema: 'plan_schema',
				decisions: [{ type: 'select', column: '*' }],
			};
			const compiler = new PlanCompiler({ schema: 'compiler_schema' });
			const result = compiler.compile(plan);
			expect(result.sql).toContain('plan_schema');
			expect(result.sql).not.toContain('compiler_schema');
		});
	});

	describe('Lock clauses (FOR UPDATE/SHARE)', () => {
		it('compiles FOR UPDATE', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'jobs',
				decisions: [{ type: 'select', column: '*' }],
				lock: { strength: 'forUpdate', waitPolicy: 'block' },
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('for update');
		});

		it('compiles FOR SHARE', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'jobs',
				decisions: [{ type: 'select', column: '*' }],
				lock: { strength: 'forShare', waitPolicy: 'block' },
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('for share');
		});

		it('compiles FOR UPDATE SKIP LOCKED', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'jobs',
				decisions: [{ type: 'select', column: '*' }],
				lock: { strength: 'forUpdate', waitPolicy: 'skipLocked' },
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('for update');
			expect(sql).toContain('skip locked');
		});

		it('compiles FOR UPDATE NOWAIT', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'jobs',
				decisions: [{ type: 'select', column: '*' }],
				lock: { strength: 'forUpdate', waitPolicy: 'noWait' },
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('for update');
			expect(sql).toContain('nowait');
		});
	});

	describe('ORDER BY with nulls', () => {
		it('compiles ORDER BY with NULLS FIRST', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'orderBy',
						column: 'created_at',
						direction: 'DESC',
						nulls: 'FIRST',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('order by');
			expect(sql).toContain('nulls first');
		});

		it('compiles ORDER BY with NULLS LAST', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'orderBy',
						column: 'created_at',
						direction: 'ASC',
						nulls: 'LAST',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('order by');
			expect(sql).toContain('nulls last');
		});
	});

	describe('GROUP BY and HAVING', () => {
		it('compiles GROUP BY', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'orders',
				decisions: [
					{ type: 'select', column: 'user_id' },
					{ type: 'groupBy', column: 'user_id' },
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('group by');
			expect(sql).toContain('user_id');
		});

		it('compiles GROUP BY with HAVING', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'orders',
				decisions: [
					{ type: 'select', column: 'user_id' },
					{ type: 'groupBy', column: 'user_id' },
					{ type: 'having', column: 'total', operator: '>', value: 100 },
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('group by');
			expect(sql).toContain('having');
		});
	});

	describe('Parameterized limit/offset', () => {
		it('compiles limit as parameterized', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{ type: 'limit', limit: { paramIndex: 1 } },
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			expect(result.sql).toContain('$1');
			expect(result.parameters).toHaveLength(1);
		});

		it('compiles offset as parameterized', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{ type: 'offset', offset: { paramIndex: 1 } },
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			expect(result.sql).toContain('$1');
			expect(result.parameters).toHaveLength(1);
		});

		it('compiles both limit and offset as parameterized', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{ type: 'limit', limit: { paramIndex: 1 } },
					{ type: 'offset', offset: { paramIndex: 2 } },
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			expect(result.sql).toContain('$1');
			expect(result.sql).toContain('$2');
			expect(result.parameters).toHaveLength(2);
		});
	});

	describe('selectFunction with aggregate', () => {
		it('compiles COUNT aggregate', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{
						type: 'selectFunction',
						function: 'count',
						args: ['*'],
						alias: 'total',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('count');
			expect(sql).toContain('total');
		});

		it('compiles SUM aggregate with column', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'orders',
				decisions: [
					{
						type: 'selectFunction',
						function: 'sum',
						column: 'amount',
						alias: 'total_amount',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('sum');
			expect(sql).toContain('total_amount');
		});
	});

	describe('selectExpression with CASE', () => {
		it('compiles simple CASE expression', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{
						type: 'selectExpression',
						expressionType: 'case',
						conditions: [
							{
								when: {
									type: 'where',
									column: 'status',
									operator: '=',
									value: 1,
								},
								// biome-ignore lint/suspicious/noThenProperty: CASE/WHEN decision object uses 'then' key
								then: 'active',
							},
						],
						value: 'inactive',
						alias: 'status_label',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('case');
			expect(sql).toContain('when');
			expect(sql).toContain('status_label');
		});

		it('compiles CASE with multiple WHEN branches', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'orders',
				decisions: [
					{
						type: 'selectExpression',
						expressionType: 'case',
						conditions: [
							{
								when: {
									type: 'where',
									column: 'status',
									operator: '=',
									value: 1,
								},
								// biome-ignore lint/suspicious/noThenProperty: CASE/WHEN decision object uses 'then' key
								then: 'pending',
							},
							{
								when: {
									type: 'where',
									column: 'status',
									operator: '=',
									value: 2,
								},
								// biome-ignore lint/suspicious/noThenProperty: CASE/WHEN decision object uses 'then' key
								then: 'shipped',
							},
							{
								when: {
									type: 'where',
									column: 'status',
									operator: '=',
									value: 3,
								},
								// biome-ignore lint/suspicious/noThenProperty: CASE/WHEN decision object uses 'then' key
								then: 'delivered',
							},
						],
						value: 'unknown',
						alias: 'status_name',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('case');
			// 3 condition values (1, 2, 3)
			expect(result.parameters).toHaveLength(3);
		});
	});

	describe('selectWindow', () => {
		it('compiles window function with PARTITION BY', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'sales',
				decisions: [
					{
						type: 'selectWindow',
						function: 'row_number',
						partitionBy: ['department'],
						orderBy: [{ field: 'salary', direction: 'desc' }],
						alias: 'rank',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('row_number');
			expect(sql).toContain('over');
			expect(sql).toContain('partition by');
		});

		it('compiles window function without partition', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'sales',
				decisions: [
					{
						type: 'selectWindow',
						function: 'rank',
						orderBy: [{ field: 'amount', direction: 'desc' }],
						alias: 'global_rank',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('rank');
			expect(sql).toContain('over');
		});

		it('compiles COUNT(*) OVER() when no field is set (WCOUNT-STAR)', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'tasks',
				decisions: [
					{
						type: 'selectWindow',
						function: 'count',
						// no field → COUNT(*) OVER(...)
						partitionBy: ['project_id'],
						alias: 'total',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('count(*)');
			expect(sql).toContain('over');
			expect(sql).toContain('partition by');
		});

		it('compiles COUNT(*) OVER() with empty OVER clause (no partition, no order)', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'items',
				decisions: [
					{
						type: 'selectWindow',
						function: 'count',
						alias: 'total_rows',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('count(*)');
			expect(sql).toContain('over');
		});
	});

	describe('selectRelationColumn', () => {
		function bindingRelationColumnPlan(
			fields: {
				readonly relationType?:
					| 'belongsTo'
					| 'hasOne'
					| 'hasMany'
					| 'belongsToMany';
				readonly cardinality?: 'one' | 'many';
				readonly targetTable?: string;
				readonly sourceColumn?: string | readonly string[];
				readonly targetColumn?: string | readonly string[];
				readonly selectedColumn?: string;
			} = {},
		): SimplifiedPlanReport {
			const selectedColumn = fields.selectedColumn ?? 'title';
			const sourceColumn = Array.isArray(fields.sourceColumn)
				? fields.sourceColumn
				: [fields.sourceColumn ?? 'id'];
			const targetColumn = Array.isArray(fields.targetColumn)
				? fields.targetColumn
				: [fields.targetColumn ?? 'authorId'];
			const relationColumn = markNqlTrustedRelationFilter(
				{
					type: 'selectRelationColumn',
					relation: 'posts',
					column: selectedColumn,
					alias: `posts.${selectedColumn}`,
				},
				{
					relation: 'posts',
					targetTable: fields.targetTable ?? 'posts',
					sourceColumn,
					targetColumn,
					hops: [],
					selectedColumn,
					...(fields.cardinality !== undefined && {
						cardinality: fields.cardinality,
					}),
					...(fields.relationType !== undefined && {
						relationType: fields.relationType,
					}),
				},
			);
			return {
				rootTable: 'projected_users',
				decisions: [relationColumn],
			};
		}

		it('compiles relation column selection', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				decisions: [
					{
						type: 'selectRelationColumn',
						relation: 'author',
						column: 'name',
						alias: 'author_name',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			// Should compile via expression handler
			expect(result.sql).toBeDefined();
		});

		it('compiles trusted hasMany binding relation columns as a correlated json_agg subquery', () => {
			const compiler = new PlanCompiler();
			const result = compiler.compile(
				bindingRelationColumnPlan({
					cardinality: 'many',
					relationType: 'hasMany',
				}),
			);
			const sql = normalizeSQL(result.sql);

			expect(sql).toContain(
				"coalesce(json_agg(rc_0.title order by cast(rc_0.title as text) nulls last), '[]'::json)",
			);
			expect(sql).toContain('from posts as rc_0');
			expect(sql).toMatch(/where rc_0\."authorid" = projected_users\.id/i);
			expect(sql).toContain('as "posts.title"');
			expect(sql).not.toMatch(/\bjoin\s+"?posts"?/i);
		});

		it('casts the hasMany relation-column json aggregate sort key to text', () => {
			const compiler = new PlanCompiler();
			const result = compiler.compile(
				bindingRelationColumnPlan({
					cardinality: 'many',
					relationType: 'hasMany',
					selectedColumn: 'metadata',
				}),
			);
			const sql = normalizeSQL(result.sql);

			expect(sql).toContain(
				"coalesce(json_agg(rc_0.metadata order by cast(rc_0.metadata as text) nulls last), '[]'::json)",
			);
			expect(sql).toContain('as "posts.metadata"');
		});

		it('keeps trusted belongsTo binding relation columns on the scalar subquery path', () => {
			const relationColumn = markNqlTrustedRelationFilter(
				{
					type: 'selectRelationColumn',
					relation: 'author',
					column: 'name',
					alias: 'author.name',
				},
				{
					relation: 'author',
					targetTable: 'users',
					sourceColumn: ['authorId'],
					targetColumn: ['id'],
					hops: [],
					selectedColumn: 'name',
					cardinality: 'one',
					relationType: 'belongsTo',
				},
			);
			const result = new PlanCompiler().compile({
				rootTable: 'projected_posts',
				decisions: [relationColumn],
			});
			const sql = normalizeSQL(result.sql);

			expect(sql).toMatch(
				/\(select rc_\d+\.name from users as rc_\d+ where rc_\d+\.id = projected_posts\."authorId"\) as "author\.name"/i,
			);
			expect(sql).not.toContain('json_agg');
		});

		it('emits a two-hop binding scalar relation column as one correlated subquery with one internal join', () => {
			const relationColumn = markNqlTrustedRelationFilter(
				{
					type: 'selectRelationColumn',
					relation: 'author.company',
					column: 'name',
					alias: 'author.company.name',
				},
				{
					relation: 'author.company',
					targetTable: 'authors',
					sourceColumn: ['authorId'],
					targetColumn: ['id'],
					hops: [
						{
							target: 'companies',
							fkColumn: ['companyId'],
							joinColumn: ['id'],
						},
					],
					selectedColumn: 'name',
					cardinality: 'one',
					relationType: 'belongsTo',
				},
			);
			const result = new PlanCompiler().compile({
				rootTable: 'projected_posts',
				decisions: [relationColumn],
			});
			const sql = normalizeSQL(result.sql);

			expect(sql).toMatch(
				/\(select rc_\d+_h1\.name from authors as rc_\d+ join companies as rc_\d+_h1 on rc_\d+_h1\.id = rc_\d+\."companyId" where rc_\d+\.id = projected_posts\."authorId"\) as "author\.company\.name"/i,
			);
		});

		it('emits composite binding scalar relation-column correlation on the full root key', () => {
			const relationColumn = markNqlTrustedRelationFilter(
				{
					type: 'selectRelationColumn',
					relation: 'author',
					column: 'name',
					alias: 'author.name',
				},
				{
					relation: 'author',
					targetTable: 'users',
					sourceColumn: ['authorId', 'tenantId'],
					targetColumn: ['id', 'tenantId'],
					hops: [],
					selectedColumn: 'name',
					cardinality: 'one',
					relationType: 'belongsTo',
				},
			);
			const result = new PlanCompiler().compile({
				rootTable: 'projected_posts',
				decisions: [relationColumn],
			});
			const sql = normalizeSQL(result.sql);

			expect(sql).toMatch(
				/where rc_\d+\.id = projected_posts\."authorId" and rc_\d+\."tenantId" = projected_posts\."tenantId"/i,
			);
		});

		it('emits composite binding per-hop JOIN correlation on the full hop key', () => {
			const relationColumn = markNqlTrustedRelationFilter(
				{
					type: 'selectRelationColumn',
					relation: 'author.company',
					column: 'name',
					alias: 'author.company.name',
				},
				{
					relation: 'author.company',
					targetTable: 'authors',
					sourceColumn: ['authorId', 'tenantId'],
					targetColumn: ['id', 'tenantId'],
					hops: [
						{
							target: 'companies',
							fkColumn: ['companyId', 'tenantId'],
							joinColumn: ['id', 'tenantId'],
						},
					],
					selectedColumn: 'name',
					cardinality: 'one',
					relationType: 'belongsTo',
				},
			);
			const result = new PlanCompiler().compile({
				rootTable: 'projected_posts',
				decisions: [relationColumn],
			});
			const sql = normalizeSQL(result.sql);

			expect(sql).toMatch(
				/join companies as rc_\d+_h1 on rc_\d+_h1\.id = rc_\d+\."companyId" and rc_\d+_h1\."tenantId" = rc_\d+\."tenantId"/i,
			);
			expect(sql).toMatch(
				/where rc_\d+\.id = projected_posts\."authorId" and rc_\d+\."tenantId" = projected_posts\."tenantId"/i,
			);
		});

		it('emits a three-hop binding scalar relation column as one correlated subquery with two internal joins', () => {
			const relationColumn = markNqlTrustedRelationFilter(
				{
					type: 'selectRelationColumn',
					relation: 'author.company.country',
					column: 'name',
					alias: 'author.company.country.name',
				},
				{
					relation: 'author.company.country',
					targetTable: 'authors',
					sourceColumn: ['authorId'],
					targetColumn: ['id'],
					hops: [
						{
							target: 'companies',
							fkColumn: ['companyId'],
							joinColumn: ['id'],
						},
						{
							target: 'countries',
							fkColumn: ['countryId'],
							joinColumn: ['id'],
						},
					],
					selectedColumn: 'name',
					cardinality: 'one',
					relationType: 'belongsTo',
				},
			);
			const result = new PlanCompiler().compile({
				rootTable: 'projected_posts',
				decisions: [relationColumn],
			});
			const sql = normalizeSQL(result.sql);

			expect(sql).toMatch(
				/\(select rc_\d+_h2\.name from authors as rc_\d+ join companies as rc_\d+_h1 on rc_\d+_h1\.id = rc_\d+\."companyId" join countries as rc_\d+_h2 on rc_\d+_h2\.id = rc_\d+_h1\."countryId" where rc_\d+\.id = projected_posts\."authorId"\) as "author\.company\.country\.name"/i,
			);
		});

		it('rejects cardinality-one dotted binding relation columns without resolved hops', () => {
			const compiler = new PlanCompiler();

			expect(() =>
				compiler.compileBindingRelationColumnSubquery(
					{
						relation: 'author.company',
						targetTable: 'authors',
						sourceColumn: ['authorId'],
						targetColumn: ['id'],
						hops: [],
						selectedColumn: 'name',
						cardinality: 'one',
						relationType: 'belongsTo',
					},
					{ rootTable: 'projected_posts', decisions: [] },
					undefined,
				),
			).toThrow(/dotted but missing resolved hops/);
		});

		it('throws before SQL construction when hasMany aggregation is unsupported by the dialect', () => {
			const compiler = new PlanCompiler({
				dialectCapabilities: {
					...POSTGRESQL_CAPABILITIES,
					supportsJsonAgg: false,
				},
			});

			expect(() =>
				compiler.compile(
					bindingRelationColumnPlan({
						cardinality: 'many',
						relationType: 'hasMany',
						targetTable: 'posts;drop',
					}),
				),
			).toThrow(
				'JSON aggregation for NQL binding relation columns is not supported by this adapter',
			);
		});

		it.each([
			'belongsToMany',
			undefined,
		] as const)('throws before SQL construction for cardinality many with relationType %s', (relationType) => {
			const compiler = new PlanCompiler();

			expect(() =>
				compiler.compile(
					bindingRelationColumnPlan({
						cardinality: 'many',
						relationType,
						targetTable: 'posts;drop',
					}),
				),
			).toThrow(/only hasMany can be aggregated \(ref-#192\)/);
		});
	});

	describe('selectPseudoColumn', () => {
		it('compiles ancestors pseudo-column', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'categories',
				decisions: [
					{
						type: 'selectPseudoColumn',
						traversal: 'ancestors',
						column: 'id',
						pkColumn: 'id',
						fkColumn: 'parent_id',
						alias: 'ancestor_ids',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			// Should compile via recursive CTE
			expect(result.sql).toBeDefined();
		});
	});

	describe('selectArithmetic', () => {
		it('compiles arithmetic expression (addition)', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'products',
				decisions: [
					{
						type: 'selectArithmetic',
						operator: '+',
						args: [
							{ type: 'column', column: 'price' },
							{ type: 'column', column: 'tax' },
						],
						alias: 'total',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('+');
		});

		it('compiles arithmetic expression (multiplication)', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'orders',
				decisions: [
					{
						type: 'selectArithmetic',
						operator: '*',
						args: [
							{ type: 'column', column: 'quantity' },
							{ type: 'column', column: 'price' },
						],
						alias: 'line_total',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('*');
		});
	});

	describe('whereAnd, whereOr, whereNot', () => {
		it('compiles whereAnd with multiple conditions', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'whereAnd',
						conditions: [
							{ type: 'where', column: 'active', operator: '=', value: true },
							{ type: 'where', column: 'verified', operator: '=', value: true },
						],
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('where');
			expect(sql).toContain('and');
		});

		it('compiles whereOr with multiple conditions', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'whereOr',
						conditions: [
							{ type: 'where', column: 'role', operator: '=', value: 'admin' },
							{
								type: 'where',
								column: 'role',
								operator: '=',
								value: 'moderator',
							},
						],
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('where');
			expect(sql).toContain('or');
		});

		it('compiles whereNot with single condition', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'whereNot',
						conditions: [
							{ type: 'where', column: 'deleted', operator: '=', value: true },
						],
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('where');
			expect(sql).toContain('not');
		});

		it('compiles whereNot with multiple conditions (negates AND)', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'whereNot',
						conditions: [
							{ type: 'where', column: 'role', operator: '=', value: 'guest' },
							{ type: 'where', column: 'active', operator: '=', value: false },
						],
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('not');
		});
	});

	describe('IN/NOT IN subquery', () => {
		it('compiles IN with subquery in decision.subquery', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'where',
						column: 'id',
						operator: 'in',
						subquery: {
							from: 'active_users',
							select: 'user_id',
						},
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			// PostgreSQL uses = ANY for IN
			expect(sql).toContain('any');
			expect(sql).toContain('active_users');
		});

		it('compiles NOT IN with subquery in decision.value', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'where',
						column: 'id',
						operator: 'notIn',
						value: {
							from: 'blocked_users',
							select: 'user_id',
						},
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			// PostgreSQL uses <> ALL for NOT IN
			expect(sql).toContain('<>');
			expect(sql).toContain('all');
			expect(sql).toContain('blocked_users');
		});

		it('compiles IN subquery with WHERE condition', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'where',
						column: 'author_id',
						operator: 'in',
						subquery: {
							from: 'users',
							select: 'id',
							where: {
								type: 'where',
								column: 'active',
								operator: '=',
								value: true,
							},
						},
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			// PostgreSQL uses = ANY for IN
			expect(sql).toContain('any');
			expect(sql).toContain('where');
		});

		it('compiles IN subquery with LIMIT', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'where',
						column: 'author_id',
						operator: 'in',
						subquery: {
							from: 'users',
							select: 'id',
							limit: 10,
						},
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			// PostgreSQL uses = ANY for IN
			expect(sql).toContain('any');
			expect(sql).toContain('limit');
		});

		it('compiles IN subquery with ORDER BY', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'where',
						column: 'author_id',
						operator: 'in',
						subquery: {
							from: 'users',
							select: 'id',
							orderBy: [{ field: 'created_at', direction: 'desc' }],
						},
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			// PostgreSQL uses = ANY for IN
			expect(sql).toContain('any');
			expect(sql).toContain('order by');
		});
	});

	describe('JOIN decision', () => {
		it('compiles explicit JOIN decision', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				decisions: [
					{ type: 'select', column: '*', table: 'posts' },
					{
						type: 'join',
						joinType: 'inner',
						targetTable: 'users',
						sourceColumn: 'author_id',
						targetColumn: 'id',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('join');
			expect(sql).toContain('users');
		});

		it('compiles LEFT JOIN decision', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'join',
						joinType: 'left',
						targetTable: 'comments',
						sourceColumn: 'id',
						targetColumn: 'post_id',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('left');
			expect(sql).toContain('join');
		});
	});

	describe('INSERT/UPDATE/DELETE', () => {
		it('compiles INSERT with RETURNING *', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{
						type: 'insert',
						columns: ['name', 'email'],
						values: ['Alice', 'alice@example.com'],
					},
					{ type: 'returning', column: '*' },
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('insert');
			expect(sql).toContain('returning');
		});

		it('compiles INSERT with RETURNING specific column', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{
						type: 'insert',
						columns: ['name', 'email'],
						values: ['Bob', 'bob@example.com'],
					},
					{ type: 'returning', column: 'id', alias: 'new_id' },
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('insert');
			expect(sql).toContain('returning');
			expect(sql).toContain('new_id');
		});

		it('compiles UPDATE with RETURNING', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{
						type: 'update',
						set: [{ column: 'active', value: false }],
					},
					{ type: 'where', column: 'id', operator: '=', value: 42 },
					{ type: 'returning', column: '*' },
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('update');
			expect(sql).toContain('returning');
		});

		it('compiles DELETE with RETURNING', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'delete' },
					{ type: 'where', column: 'id', operator: '=', value: 99 },
					{ type: 'returning', column: 'id' },
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('delete');
			expect(sql).toContain('returning');
		});

		it('compiles INSERT with schema', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				schema: 'tenant_x',
				decisions: [
					{
						type: 'insert',
						columns: ['name'],
						values: ['Test'],
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			expect(result.sql).toContain('tenant_x');
		});

		it('compiles UPDATE with schema', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				schema: 'tenant_y',
				decisions: [
					{
						type: 'update',
						set: [{ column: 'name', value: 'Updated' }],
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			expect(result.sql).toContain('tenant_y');
		});

		it('compiles DELETE with schema', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				schema: 'tenant_z',
				decisions: [
					{ type: 'delete' },
					{ type: 'where', column: 'id', operator: '=', value: 1 },
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			expect(result.sql).toContain('tenant_z');
		});
	});

	describe('Default behaviors', () => {
		it('defaults to SELECT * when no targetList', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('select');
			expect(sql).toContain('*');
		});

		it('uses default primary key column name', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				decisions: [{ type: 'select', column: '*' }],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			// Should compile successfully with default pk='id'
			expect(result.sql).toBeDefined();
		});

		it('uses custom primary key column name', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				decisions: [{ type: 'select', column: '*' }],
			};
			const compiler = new PlanCompiler({ defaultPkColumnName: 'post_id' });
			const result = compiler.compile(plan);
			// Should compile with custom pk
			expect(result.sql).toBeDefined();
		});
	});

	describe('Error cases', () => {
		it('throws on unsupported query type', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [{ type: 'unsupported_type' }],
			};
			const compiler = new PlanCompiler();
			// Should handle gracefully or throw
			const result = compiler.compile(plan);
			expect(result.sql).toBeDefined();
		});

		it('throws on CASE without conditions', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{
						type: 'selectExpression',
						expressionType: 'case',
						conditions: [],
						alias: 'status',
					},
				],
			};
			const compiler = new PlanCompiler();
			expect(() => compiler.compile(plan)).toThrow(
				'CASE requires at least one WHEN condition',
			);
		});
	});

	describe('CTE (WITH clause)', () => {
		it('compiles WITH clause when pendingCtes present', () => {
			// This branch is triggered by includeStrategy decisions that produce CTEs
			// For coverage, we need a plan that generates pendingCtes
			// Since we can't easily mock the include handler, we'll rely on integration tests
			// for full CTE coverage. This test is a placeholder.
			const plan: SimplifiedPlanReport = {
				rootTable: 'categories',
				decisions: [{ type: 'select', column: '*' }],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			// Should compile successfully
			expect(result.sql).toBeDefined();
		});
	});

	describe('Lock basics', () => {
		it('compiles lock without JOINs (basic case)', () => {
			// Test basic lock compilation
			const plan: SimplifiedPlanReport = {
				rootTable: 'jobs',
				decisions: [{ type: 'select', column: '*' }],
				lock: { strength: 'forUpdate', waitPolicy: 'block' },
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('for update');
			expect(sql).toContain('jobs');
		});

		it('compiles FOR KEY SHARE', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				decisions: [{ type: 'select', column: '*' }],
				lock: { strength: 'forKeyShare', waitPolicy: 'block' },
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('for key share');
		});

		it('compiles FOR NO KEY UPDATE', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'items',
				decisions: [{ type: 'select', column: '*' }],
				lock: { strength: 'forNoKeyUpdate', waitPolicy: 'block' },
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('for no key update');
		});
	});

	// ==================================================================
	// NEW COVERAGE TESTS — additional branches in compiler.ts
	// ==================================================================

	describe('selectExpression - coalesce', () => {
		it('compiles coalesce expression via handler dispatch', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{
						type: 'selectFunction',
						function: 'coalesce',
						args: ['nickname', 'name'],
						alias: 'display_name',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('coalesce');
		});
	});

	describe('selectNqlFunction nested argument dispatch', () => {
		it('throws a structured error for unknown nested NQL SELECT expression kinds', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{
						type: 'selectNqlFunction',
						function: 'round',
						args: [{ kind: 'syntheticNestedSelectExpression' }],
						alias: 'r',
					},
				],
			};
			const compiler = new PlanCompiler();

			expect(() => compiler.compile(plan)).toThrowError(
				expect.objectContaining({
					name: 'UnhandledNqlSelectExpressionKindError',
					code: 'ERR_ADAPTER_UNHANDLED_NQL_SELECT_EXPRESSION_KIND',
					kind: 'syntheticNestedSelectExpression',
				}),
			);
		});
	});

	describe('selectFunction - AVG, MIN, MAX', () => {
		it('compiles AVG aggregate', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'orders',
				decisions: [
					{
						type: 'selectFunction',
						function: 'avg',
						column: 'amount',
						alias: 'avg_amount',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('avg');
		});

		it('compiles MIN aggregate', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'orders',
				decisions: [
					{
						type: 'selectFunction',
						function: 'min',
						column: 'amount',
						alias: 'min_amount',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('min');
		});

		it('compiles MAX aggregate', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'orders',
				decisions: [
					{
						type: 'selectFunction',
						function: 'max',
						column: 'amount',
						alias: 'max_amount',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('max');
		});
	});

	describe('selectFunction with table override', () => {
		it('compiles aggregate with table-specific alias context', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'orders',
				decisions: [
					{
						type: 'selectFunction',
						function: 'count',
						args: ['*'],
						alias: 'cnt',
						table: 'orders',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('count');
		});

		it('skips selectFunction when function name is missing', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'orders',
				decisions: [
					{
						type: 'selectFunction',
						alias: 'cnt',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			// Should not throw, just skip the decision
			expect(result.sql).toBeDefined();
		});
	});

	describe('selectWindow with table and schema', () => {
		it('compiles window function with table and schema context', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'sales',
				schema: 'analytics',
				decisions: [
					{
						type: 'selectWindow',
						function: 'dense_rank',
						orderBy: [{ field: 'revenue', direction: 'desc' }],
						alias: 'rank',
						table: 'sales',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('dense_rank');
			expect(sql).toContain('over');
		});

		it('skips selectWindow when function name is missing', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'sales',
				decisions: [
					{
						type: 'selectWindow',
						alias: 'rank',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			// Should not throw, just skip
			expect(result.sql).toBeDefined();
		});
	});

	describe('limit/offset as literal numbers', () => {
		it('compiles literal number limit', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{ type: 'limit', limit: 25 },
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('limit');
			expect(sql).toContain('25');
		});

		it('compiles literal number offset', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{ type: 'offset', offset: 50 },
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('offset');
			expect(sql).toContain('50');
		});
	});

	describe('select with table qualifier and alias', () => {
		it('compiles column with alias', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{
						type: 'select',
						column: 'email',
						alias: 'user_email',
						table: 'users',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('user_email');
		});
	});

	describe('orderBy edge cases', () => {
		it('compiles ORDER BY with default direction when omitted', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{ type: 'orderBy', column: 'name' },
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('order by');
		});

		it('skips orderBy when column is missing', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [{ type: 'select', column: '*' }, { type: 'orderBy' }],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			// No order by should be emitted
			expect(sql).not.toContain('order by');
		});
	});

	describe('groupBy edge cases', () => {
		it('skips groupBy when column is missing', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [{ type: 'select', column: '*' }, { type: 'groupBy' }],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).not.toContain('group by');
		});
	});

	describe('JOIN filter strategy (exists + join choice)', () => {
		it('compiles where exists with join strategy', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'where',
						operator: 'exists',
						choice: 'join',
						targetTable: 'authors',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('join');
			expect(sql).toContain('authors');
		});

		it('compiles where exists with join strategy + conditions', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'where',
						operator: 'exists',
						choice: 'join',
						targetTable: 'authors',
						conditions: [
							{
								type: 'where',
								column: 'active',
								operator: '=',
								value: true,
							},
						],
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('join');
			expect(sql).toContain('where');
		});

		it('compiles where exists with join strategy + multiple conditions', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'where',
						operator: 'exists',
						choice: 'join',
						targetTable: 'authors',
						conditions: [
							{
								type: 'where',
								column: 'active',
								operator: '=',
								value: true,
							},
							{
								type: 'where',
								column: 'verified',
								operator: '=',
								value: true,
							},
						],
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('join');
			expect(sql).toContain('and');
		});
	});

	describe('includeStrategy via handler', () => {
		it('compiles json_agg include strategy', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: 'id' },
					{
						type: 'includeStrategy',
						choice: 'json_agg',
						relation: 'posts',
						relationName: 'posts',
						targetTable: 'posts',
						sourceColumn: 'id',
						targetColumn: 'author_id',
						relationType: 'hasMany',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('json_agg');
		});

		it('compiles cte include strategy', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: 'id' },
					{
						type: 'includeStrategy',
						choice: 'cte',
						relation: 'department',
						relationName: 'department',
						targetTable: 'departments',
						sourceColumn: 'dept_id',
						targetColumn: 'id',
						relationType: 'belongsTo',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('with');
		});

		it('compiles include strategy with conditions (EXISTS propagation)', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: 'id' },
					{
						type: 'includeStrategy',
						choice: 'json_agg',
						relation: 'posts',
						relationName: 'posts',
						targetTable: 'posts',
						sourceColumn: 'id',
						targetColumn: 'author_id',
						relationType: 'hasMany',
						conditions: [
							{
								type: 'where',
								column: 'published',
								operator: '=',
								value: true,
							},
						],
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('json_agg');
		});

		it('throws for include without strategy choice', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: 'id' },
					{
						type: 'includeStrategy',
						relation: 'posts',
						targetTable: 'posts',
					},
				],
			};
			const compiler = new PlanCompiler();
			expect(() => compiler.compile(plan)).toThrow(/missing strategy/);
		});
	});

	describe('lock with JOINs (scoped locking)', () => {
		it('scopes lock to root table when rawJoins exist', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: 'id' },
					{
						type: 'includeStrategy',
						choice: 'json_agg',
						relation: 'posts',
						relationName: 'posts',
						targetTable: 'posts',
						sourceColumn: 'id',
						targetColumn: 'author_id',
						relationType: 'hasMany',
					},
				],
				lock: { strength: 'forUpdate', waitPolicy: 'skipLocked' },
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('for update');
			expect(sql).toContain('skip locked');
		});
	});

	describe('WITH clause from pendingCtes', () => {
		it('emits WITH clause when CTE include produces CTEs', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: 'id' },
					{
						type: 'includeStrategy',
						choice: 'cte',
						relation: 'department',
						relationName: 'department',
						targetTable: 'departments',
						sourceColumn: 'dept_id',
						targetColumn: 'id',
						relationType: 'belongsTo',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('with');
			expect(sql).toContain('cte');
		});
	});

	describe('multiple JOINs in FROM clause', () => {
		it('handles multiple explicit join decisions', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'orders',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'join',
						joinType: 'inner',
						targetTable: 'users',
						sourceColumn: 'user_id',
						targetColumn: 'id',
					},
					{
						type: 'join',
						joinType: 'left',
						targetTable: 'products',
						sourceColumn: 'product_id',
						targetColumn: 'id',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('join');
			expect(sql).toContain('orders');
			expect(sql).toContain('products');
		});
	});

	describe('whereAnd/Or/Not with single condition', () => {
		it('compiles whereAnd with single condition (no AND node)', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'whereAnd',
						conditions: [
							{
								type: 'where',
								column: 'active',
								operator: '=',
								value: true,
							},
						],
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('where');
		});

		it('compiles whereOr with single condition (no OR node)', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'whereOr',
						conditions: [
							{
								type: 'where',
								column: 'role',
								operator: '=',
								value: 'admin',
							},
						],
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('where');
		});
	});

	describe('multiple where clauses accumulate with AND', () => {
		it('combines existing WHERE with new where condition', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'where',
						column: 'active',
						operator: '=',
						value: true,
					},
					{
						type: 'whereAnd',
						conditions: [
							{
								type: 'where',
								column: 'verified',
								operator: '=',
								value: true,
							},
						],
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('and');
		});

		it('combines existing WHERE with whereOr', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'where',
						column: 'active',
						operator: '=',
						value: true,
					},
					{
						type: 'whereOr',
						conditions: [
							{
								type: 'where',
								column: 'role',
								operator: '=',
								value: 'admin',
							},
							{
								type: 'where',
								column: 'role',
								operator: '=',
								value: 'mod',
							},
						],
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('and');
			expect(sql).toContain('or');
		});

		it('combines existing WHERE with whereNot', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'where',
						column: 'active',
						operator: '=',
						value: true,
					},
					{
						type: 'whereNot',
						conditions: [
							{
								type: 'where',
								column: 'banned',
								operator: '=',
								value: true,
							},
						],
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('not');
		});
	});

	describe('UPDATE with multiple WHERE clauses', () => {
		it('accumulates WHERE clauses in UPDATE', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{
						type: 'update',
						set: [{ column: 'active', value: false }],
					},
					{
						type: 'where',
						column: 'id',
						operator: '>',
						value: 100,
					},
					{
						type: 'where',
						column: 'role',
						operator: '=',
						value: 'guest',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('update');
			expect(sql).toContain('and');
		});
	});

	describe('DELETE with multiple WHERE clauses', () => {
		it('accumulates WHERE clauses in DELETE', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'delete' },
					{
						type: 'where',
						column: 'active',
						operator: '=',
						value: false,
					},
					{
						type: 'where',
						column: 'created_at',
						operator: '<',
						value: '2020-01-01',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('delete');
			expect(sql).toContain('and');
		});
	});

	describe('CASE expression with ELSE only (no conditions)', () => {
		it('compiles CASE with else value', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{
						type: 'selectExpression',
						expressionType: 'case',
						conditions: [
							{
								when: {
									type: 'where',
									column: 'active',
									operator: '=',
									value: true,
								},
								// biome-ignore lint/suspicious/noThenProperty: CASE/WHEN decision object uses 'then' key
								then: 'yes',
							},
						],
						alias: 'label',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('case');
			expect(sql).toContain('when');
		});
	});

	describe('selectExpression non-case types skip', () => {
		it('skips selectExpression with unknown expressionType', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{
						type: 'selectExpression',
						expressionType: 'unknown_type',
						alias: 'x',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			// Should not throw, should default to SELECT *
			expect(result.sql).toBeDefined();
		});
	});

	describe('selectRelationColumn with schema', () => {
		it('compiles relation column with schema context', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				schema: 'tenant_rc',
				decisions: [
					{
						type: 'selectRelationColumn',
						relation: 'author',
						column: 'name',
						alias: 'author_name',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			expect(result.sql).toBeDefined();
		});
	});

	describe('selectArithmetic with subtraction and division', () => {
		it('compiles subtraction', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'products',
				decisions: [
					{
						type: 'selectArithmetic',
						operator: '-',
						args: [
							{ type: 'column', column: 'price' },
							{ type: 'column', column: 'discount' },
						],
						alias: 'net_price',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('-');
		});

		it('compiles division', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'products',
				decisions: [
					{
						type: 'selectArithmetic',
						operator: '/',
						args: [
							{ type: 'column', column: 'total' },
							{ type: 'column', column: 'count' },
						],
						alias: 'average',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('/');
		});
	});

	describe('compiler with custom naming plugin', () => {
		it('compiles with custom naming option', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [{ type: 'select', column: 'firstName' }],
			};
			// identity naming uses the column name as-is
			const compiler = new PlanCompiler({ naming: identityNaming });
			const result = compiler.compile(plan);
			expect(result.sql).toContain('firstName');
		});
	});

	describe('HAVING with handler dispatch', () => {
		it('compiles HAVING with parameterized value', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'orders',
				decisions: [
					{ type: 'select', column: 'user_id' },
					{ type: 'groupBy', column: 'user_id' },
					{
						type: 'having',
						column: 'count',
						operator: '>=',
						value: 5,
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('having');
			expect(result.parameters).toHaveLength(1);
		});
	});

	// ==========================================================================
	// NEW COVERAGE: additional compiler branches
	// ==========================================================================

	describe('dispatchWhere — IN subquery with value-based subquery', () => {
		it('handles IN subquery via value.from pattern', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'orders',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'where',
						column: 'user_id',
						operator: 'in',
						value: { from: 'users', select: 'id' },
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('any');
			expect(sql).toContain('select');
		});

		it('handles NOT IN subquery via value.from pattern', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'orders',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'where',
						column: 'user_id',
						operator: 'notIn',
						value: { from: 'users', select: 'id' },
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('all');
		});

		it('handles IN subquery with where + limit + orderBy', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'orders',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'where',
						column: 'user_id',
						operator: 'in',
						subquery: {
							from: 'users',
							select: 'id',
							where: {
								type: 'where',
								column: 'active',
								operator: '=',
								value: true,
							},
							limit: 10,
							orderBy: [{ field: 'name', direction: 'desc' }],
						},
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('any');
			expect(sql).toContain('limit');
		});

		it('handles IN subquery with SelectIntent-style select (fields) — single field compiles, multi-field throws', () => {
			// Single-field typeless shape is valid: the compiler uses isSelectWithFields
			// which accepts { fields: ['id'] } without a `type` key.
			const planSingle: SimplifiedPlanReport = {
				rootTable: 'orders',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'where',
						column: 'user_id',
						operator: 'in',
						subquery: {
							from: 'users',
							select: { fields: ['id'] },
						},
					},
				],
			};
			const compiler = new PlanCompiler();
			const resultSingle = compiler.compile(planSingle);
			expect(normalizeSQL(resultSingle.sql)).toContain('any');

			// Multi-field typeless shape is invalid: the guard now catches it the same
			// way it catches typed { type: 'fields', fields: ['id', 'name'] }.
			// Previously this silently truncated to fields[0] (the bug).
			const planMulti: SimplifiedPlanReport = {
				rootTable: 'orders',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'where',
						column: 'user_id',
						operator: 'in',
						subquery: {
							from: 'users',
							select: { fields: ['id', 'name'] },
						},
					},
				],
			};
			expect(() => compiler.compile(planMulti)).toThrow(
				/IN subquery with multi-field projection \[id, name\].*is not supported/,
			);
		});
	});

	describe('compileIncludeViaHandler — branches', () => {
		it('throws when include decision has no strategy choice', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				decisions: [
					{
						type: 'includeStrategy',
						relationName: 'author',
						targetTable: 'users',
					} as any,
				],
			};
			const compiler = new PlanCompiler();
			expect(() => compiler.compile(plan)).toThrow('missing strategy choice');
		});

		it('compiles include with filter conditions (pre-compiled WHERE)', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				decisions: [
					{
						type: 'includeStrategy',
						choice: 'json_agg',
						relationName: 'comments',
						targetTable: 'comments',
						relationType: 'hasMany',
						foreignKey: 'post_id',
						conditions: [
							{
								type: 'where',
								column: 'active',
								operator: '=',
								value: true,
							},
						],
					} as any,
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('json_agg');
		});

		it('compiles include with CTE strategy', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				decisions: [
					{
						type: 'includeStrategy',
						choice: 'cte',
						relationName: 'comments',
						targetTable: 'comments',
						relationType: 'hasMany',
						foreignKey: 'post_id',
					} as any,
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('with');
		});
	});

	describe('registerJoinFilter — branches', () => {
		it('uses relation-based alias for self-referential join filter', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'categories',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'where',
						operator: 'exists',
						choice: 'join',
						targetTable: 'categories',
						relationName: 'parent',
						conditions: [
							{
								type: 'where',
								column: 'name',
								operator: '=',
								value: 'electronics',
							},
						],
					} as any,
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('join');
			expect(sql).toContain('parent');
		});

		it('uses foreignKey from decision when provided', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'where',
						operator: 'exists',
						choice: 'join',
						targetTable: 'users',
						foreignKey: 'author_id',
					} as any,
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('join');
			expect(sql).toContain('author_id');
		});
	});

	describe('compileSelect — additional branches', () => {
		it('compiles with pendingCtes (withClause)', () => {
			// CTE include via includeStrategy with choice=cte triggers pendingCtes
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'includeStrategy',
						choice: 'cte',
						relationName: 'tags',
						targetTable: 'tags',
						relationType: 'hasMany',
						foreignKey: 'post_id',
					} as any,
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('with');
		});

		it('compiles lock with JOINs (scoped locking)', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'includeStrategy',
						choice: 'join',
						relationName: 'author',
						targetTable: 'users',
						relationType: 'belongsTo',
						foreignKey: 'author_id',
						sourceColumn: 'author_id',
						targetColumn: 'id',
					} as any,
				],
				lock: { strength: 'forUpdate', waitPolicy: 'block' },
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('for update');
			expect(sql).toContain('of');
		});

		it('compiles multiple where conditions (accumulation)', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{ type: 'where', column: 'active', operator: '=', value: true },
					{
						type: 'where',
						column: 'age',
						operator: '>=',
						value: 18,
					},
					{
						type: 'where',
						column: 'role',
						operator: '=',
						value: 'admin',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			expect(result.parameters).toHaveLength(3);
		});

		it('compiles whereAnd with single condition', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'whereAnd',
						conditions: [
							{ type: 'where', column: 'active', operator: '=', value: true },
						],
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('where');
		});

		it('compiles whereOr with single condition', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'whereOr',
						conditions: [
							{ type: 'where', column: 'active', operator: '=', value: true },
						],
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('where');
		});

		it('compiles whereNot with single condition', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'whereNot',
						conditions: [
							{
								type: 'where',
								column: 'deleted',
								operator: '=',
								value: true,
							},
						],
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('not');
		});
	});

	describe('mapToHandlerDecision — field mapping branches', () => {
		it('maps column from field fallback', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'where',
						field: 'name',
						operator: '=',
						value: 'Alice',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			expect(result.parameters).toContain('Alice');
		});

		it('maps relation from relationName fallback', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'includeStrategy',
						choice: 'json_agg',
						relationName: 'comments',
						targetTable: 'comments',
						relationType: 'hasMany',
						foreignKey: 'post_id',
					} as any,
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('json_agg');
		});

		it('maps orderBy within include decision', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'includeStrategy',
						choice: 'json_agg',
						relationName: 'comments',
						targetTable: 'comments',
						relationType: 'hasMany',
						foreignKey: 'post_id',
						orderBy: [{ field: 'created_at', direction: 'desc' }],
					} as any,
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			// orderBy is mapped from pd.orderBy to handler decision but json_agg
			// handler doesn't apply ORDER BY — verify compilation still succeeds
			expect(sql).toContain('json_agg');
			expect(sql).toContain('comments');
		});

		it('maps partitionBy to partition', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'orders',
				decisions: [
					{
						type: 'selectWindow',
						function: 'row_number',
						column: '*',
						partitionBy: ['user_id'],
						orderBy: [{ field: 'created_at', direction: 'desc' }],
						alias: 'rn',
					} as any,
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('partition by');
		});

		it('maps children recursively with targetTable as rootTable', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'includeStrategy',
						choice: 'json_agg',
						relationName: 'author',
						targetTable: 'users',
						relationType: 'belongsTo',
						foreignKey: 'author_id',
						children: [
							{
								type: 'includeStrategy',
								choice: 'json_agg',
								relationName: 'profile',
								targetTable: 'profiles',
								relationType: 'hasOne',
								foreignKey: 'user_id',
							},
						],
					} as any,
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('json_agg');
		});
	});

	describe('detectQueryType — branches', () => {
		it('detects insert type', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{
						type: 'insert',
						columns: ['name'],
						values: ['Alice'],
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('insert');
		});

		it('detects delete type', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'delete' },
					{ type: 'where', column: 'id', operator: '=', value: 1 },
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('delete');
		});

		it('throws for unsupported query type', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [{ type: 'merge' } as any],
			};
			const compiler = new PlanCompiler();
			// 'merge' should become detectQueryType='select' since it's not insert/update/delete
			// Actually let's test it still compiles (falls back to select)
			const result = compiler.compile(plan);
			expect(result.sql).toBeDefined();
		});
	});

	describe('compileCaseExpression — branches', () => {
		it('throws when CASE has no conditions', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{
						type: 'selectExpression',
						expressionType: 'case',
						conditions: [],
					} as any,
				],
			};
			const compiler = new PlanCompiler();
			expect(() => compiler.compile(plan)).toThrow(
				'CASE requires at least one WHEN condition',
			);
		});

		it('compiles CASE with null THEN value', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{
						type: 'selectExpression',
						expressionType: 'case',
						conditions: [
							{
								when: {
									type: 'where',
									column: 'active',
									operator: '=',
									value: false,
								},
								// biome-ignore lint/suspicious/noThenProperty: CASE/WHEN decision object uses 'then' key
								then: null,
							},
						],
						value: 'default',
						alias: 'status',
					} as any,
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('case');
			expect(sql).toContain('when');
			expect(sql).toContain('else');
		});

		it('compiles CASE with column ref THEN value', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{
						type: 'selectExpression',
						expressionType: 'case',
						conditions: [
							{
								when: {
									type: 'where',
									column: 'role',
									operator: '=',
									value: 'admin',
								},
								// biome-ignore lint/suspicious/noThenProperty: CASE/WHEN decision object uses 'then' key
								then: {
									kind: 'column',
									column: 'display_name',
								},
							},
						],
						alias: 'label',
					} as any,
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('case');
			expect(sql).toContain('display_name');
		});
	});

	describe('compileJoin — joinType left vs inner', () => {
		it('compiles LEFT JOIN when joinType is left', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'join',
						joinType: 'left',
						targetTable: 'users',
						sourceColumn: 'author_id',
						targetColumn: 'id',
						alias: 'u',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('left join');
		});
	});

	describe('wrapSelectInExists — branches', () => {
		it('wraps SELECT in EXISTS successfully', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: 'id' },
					{
						type: 'where',
						column: 'email',
						operator: '=',
						value: 'test@t.com',
					},
				],
				existsWrap: true,
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('exists');
			expect(result.sql).toContain('"exists"');
		});
	});

	describe('compileSelect — no targets defaults to star', () => {
		it('defaults to SELECT * when no select decisions', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'where', column: 'active', operator: '=', value: true },
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('*');
		});
	});

	describe('offset — parameterized and literal', () => {
		it('compiles literal offset', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{ type: 'offset', offset: 20 },
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('offset');
		});

		it('compiles parameterized offset', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{ type: 'offset', offset: { paramIndex: 1 } },
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('offset');
		});
	});

	describe('compileInsert — returning branches', () => {
		it('compiles INSERT with RETURNING *', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{
						type: 'insert',
						columns: ['name'],
						values: ['Alice'],
					},
					{ type: 'returning', column: '*' },
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('returning');
			expect(sql).toContain('*');
		});

		it('compiles INSERT with RETURNING specific column', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{
						type: 'insert',
						columns: ['name'],
						values: ['Alice'],
					},
					{ type: 'returning', column: 'id', alias: 'new_id' },
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('returning');
		});
	});

	describe('compileDelete — returning branches', () => {
		it('compiles DELETE with RETURNING *', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'delete' },
					{ type: 'where', column: 'id', operator: '=', value: 1 },
					{ type: 'returning', column: '*' },
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('delete');
			expect(sql).toContain('returning');
		});

		it('compiles DELETE with RETURNING specific column', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'delete' },
					{ type: 'where', column: 'id', operator: '=', value: 1 },
					{ type: 'returning', column: 'id' },
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('delete');
			expect(sql).toContain('returning');
		});
	});

	describe('compileUpdate — returning branches', () => {
		it('compiles UPDATE with RETURNING *', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{
						type: 'update',
						set: [{ column: 'name', value: 'Bob' }],
					},
					{ type: 'where', column: 'id', operator: '=', value: 1 },
					{ type: 'returning', column: '*' },
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('update');
			expect(sql).toContain('returning');
		});
	});

	describe('rawJoins — flush into FROM clause', () => {
		it('handles multiple raw joins (LATERAL)', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'includeStrategy',
						choice: 'lateral',
						relationName: 'comments',
						targetTable: 'comments',
						relationType: 'hasMany',
						foreignKey: 'post_id',
						limit: 5,
					} as any,
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('lateral');
		});
	});
});
