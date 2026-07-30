// @ts-nocheck — coverage test: runtime assertions on AST nodes
/**
 * Coverage tests for pgsql-adapter.ts.
 *
 * Focus: Branch coverage for PgsqlAdapter including:
 * - createPgsqlCompileOnlyAdapter() with default and custom options
 * - compile() with various decision types
 * - compile() with schema scoping
 * - compileWithIncludes() with and without subquery includes
 * - withSchema() adapter cloning
 * - dialectCapabilities property
 * - Custom options: defaultPkColumnName, deriveFkColumnName
 * - Adapter capabilities (execution/streaming support)
 */

import type { PlanReport } from '@dbsp/types';
import { projectionlessCompiledQuery } from '@dbsp/types/adapter-sdk';
import { describe, expect, it } from 'vitest';
import {
	createPgsqlCompileOnlyAdapter,
	PgsqlAdapter,
} from './pgsql-adapter.js';

function testQuery<T = unknown>(
	sql: string,
	parameters: readonly unknown[] = [],
) {
	return projectionlessCompiledQuery<T>(
		{ sql, parameters },
		'pgsql-adapter-coverage-test',
	);
}

describe('PgsqlAdapter - Coverage Tests', () => {
	describe('createPgsqlCompileOnlyAdapter', () => {
		it('creates adapter with default options', () => {
			const adapter = createPgsqlCompileOnlyAdapter();

			expect(adapter).toBeDefined();
			expect(adapter.dbCasing).toBe('preserve');
			expect(adapter.capabilities.supportsReturning).toBe(true);
			expect(adapter.capabilities.supportsStreaming).toBe(false);
		});

		it('creates adapter with custom dbCasing', () => {
			const adapter = createPgsqlCompileOnlyAdapter({
				dbCasing: 'snake_case',
			});

			expect(adapter.dbCasing).toBe('snake_case');
		});

		it('creates adapter with schemaName option', () => {
			const adapter = createPgsqlCompileOnlyAdapter({
				schemaName: 'tenant_xyz',
			});

			// Schema name is stored internally
			expect(adapter).toBeDefined();
		});

		it('creates adapter with defaultPkColumnName option', () => {
			const adapter = createPgsqlCompileOnlyAdapter({
				defaultPkColumnName: 'uuid',
			});

			expect(adapter).toBeDefined();
		});

		it('creates adapter with custom deriveFkColumnName function', () => {
			const customDerivation = (tableName: string, pkName: string) =>
				`${tableName}_${pkName}_fk`;

			const adapter = createPgsqlCompileOnlyAdapter({
				deriveFkColumnName: customDerivation,
			});

			expect(adapter).toBeDefined();
		});

		it('creates adapter with logger option', () => {
			const mockLogger = {
				debug: () => {},
				info: () => {},
				warn: () => {},
				error: () => {},
			};

			const adapter = createPgsqlCompileOnlyAdapter({
				logger: mockLogger,
			});

			expect(adapter).toBeDefined();
		});
	});

	describe('dialectCapabilities', () => {
		it('returns PostgreSQL capabilities', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const caps = adapter.dialectCapabilities;

			expect(caps).toBeDefined();
			expect(caps.supportsJsonAgg).toBe(true);
			expect(caps.supportsLateralJoin).toBe(true);
			expect(caps.supportsRecursiveCTE).toBe(true);
		});
	});

	describe('capabilities', () => {
		it('compile-only adapter reports no execution support', () => {
			const adapter = createPgsqlCompileOnlyAdapter();

			expect(adapter.capabilities.supportsReturning).toBe(true);
			expect(adapter.capabilities.supportsStreaming).toBe(false);
		});

		it('compile-only adapter reports schema support', () => {
			const adapter = createPgsqlCompileOnlyAdapter();

			expect(adapter.capabilities.supportsSchemas).toBe(true);
		});
	});

	describe('compile - basic SELECT', () => {
		it('compiles minimal SELECT plan', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const plan: PlanReport = {
				rootTable: 'users',
				decisions: [{ type: 'select', column: '*' }],
			} as any;

			const result = adapter.compile(plan);

			expect(result.sql).toContain('SELECT');
			expect(result.sql).toContain('users');
			expect(Array.isArray(result.parameters)).toBe(true);
		});

		it('compiles SELECT with specific columns', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const plan: PlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: 'id' },
					{ type: 'select', column: 'name' },
				],
			} as any;

			const result = adapter.compile(plan);

			expect(result.sql).toContain('SELECT');
			expect(result.parameters).toEqual([]);
		});
	});

	describe('compile - schema scoping', () => {
		it('includes schema from adapter options', () => {
			const adapter = createPgsqlCompileOnlyAdapter({
				schemaName: 'tenant_123',
			});
			const plan: PlanReport = {
				rootTable: 'users',
				decisions: [{ type: 'select', column: '*' }],
			} as any;

			const result = adapter.compile(plan);

			expect(result.sql).toContain('tenant_123');
		});

		it('includes schema from compile options', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const plan: PlanReport = {
				rootTable: 'users',
				decisions: [{ type: 'select', column: '*' }],
			} as any;

			const result = adapter.compile(plan, { schemaName: 'custom_schema' });

			expect(result.sql).toContain('custom_schema');
		});

		it('compile options schemaName takes precedence over adapter constructor schemaName', () => {
			const adapter = createPgsqlCompileOnlyAdapter({
				schemaName: 'adapter_schema',
			});
			const plan: PlanReport = {
				rootTable: 'users',
				decisions: [{ type: 'select', column: '*' }],
			} as any;

			const result = adapter.compile(plan, { schemaName: 'override_schema' });

			// options.schemaName takes precedence over adapter constructor schemaName.
			// buildCompileDeps() uses || (not ??) for schemaName: empty string falls through
			// to the adapter constructor value. For model it still uses ?? (empty model is meaningful).
			expect(result.sql).toContain('override_schema');
		});

		it('compile options schemaName empty string falls through to adapter constructor schemaName', () => {
			const adapter = createPgsqlCompileOnlyAdapter({
				schemaName: 'adapter_default',
			});
			const plan: PlanReport = {
				rootTable: 'users',
				decisions: [{ type: 'select', column: '*' }],
			} as any;

			const result = adapter.compile(plan, { schemaName: '' });

			// Empty string should NOT win; constructor schemaName wins via `||`
			expect(result.sql).toContain('adapter_default');
			expect(result.sql).not.toContain('"".');
		});
	});

	describe('compile - schemaName validation in options', () => {
		it('rejects malicious schemaName via compile options (SQL injection)', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const plan: PlanReport = {
				rootTable: 'users',
				decisions: [{ type: 'select', column: '*' }],
			} as any;

			expect(() =>
				adapter.compile(plan, { schemaName: 'x"; DROP TABLE users--' }),
			).toThrow(/[Ii]nvalid|identifier/);
		});

		it('rejects schemaName with semicolon via compile options', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const plan: PlanReport = {
				rootTable: 'users',
				decisions: [{ type: 'select', column: '*' }],
			} as any;

			expect(() => adapter.compile(plan, { schemaName: 'bad;schema' })).toThrow(
				/[Ii]nvalid|identifier/,
			);
		});

		it('accepts valid identifier in options.schemaName', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const plan: PlanReport = {
				rootTable: 'users',
				decisions: [{ type: 'select', column: '*' }],
			} as any;

			const result = adapter.compile(plan, { schemaName: 'tenant_42' });
			expect(result.sql).toContain('tenant_42');
		});
	});

	describe('compile - DISTINCT', () => {
		it('compiles SELECT DISTINCT', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const plan: PlanReport = {
				rootTable: 'users',
				decisions: [{ type: 'select', column: 'email' }, { type: 'distinct' }],
			} as any;

			const result = adapter.compile(plan);

			expect(result.sql.toLowerCase()).toContain('distinct');
		});
	});

	describe('compile - ORDER BY', () => {
		it('compiles ORDER BY ASC', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const plan: PlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{ type: 'orderBy', column: 'name', direction: 'ASC' },
				],
			} as any;

			const result = adapter.compile(plan);

			expect(result.sql.toLowerCase()).toContain('order by');
		});

		it('compiles ORDER BY DESC', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const plan: PlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{ type: 'orderBy', column: 'created_at', direction: 'DESC' },
				],
			} as any;

			const result = adapter.compile(plan);

			expect(result.sql.toLowerCase()).toContain('order by');
			expect(result.sql.toLowerCase()).toContain('desc');
		});
	});

	describe('compile - LIMIT and OFFSET', () => {
		it('compiles LIMIT', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const plan: PlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{ type: 'limit', limit: { paramIndex: 1 } },
				],
				parameters: [10],
			} as any;

			const result = adapter.compile(plan);

			expect(result.sql.toLowerCase()).toContain('limit');
		});

		it('compiles OFFSET', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const plan: PlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{ type: 'offset', offset: { paramIndex: 1 } },
				],
				parameters: [20],
			} as any;

			const result = adapter.compile(plan);

			expect(result.sql.toLowerCase()).toContain('offset');
		});

		it('compiles LIMIT and OFFSET together', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const plan: PlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{ type: 'limit', limit: { paramIndex: 1 } },
					{ type: 'offset', offset: { paramIndex: 2 } },
				],
				parameters: [10, 20],
			} as any;

			const result = adapter.compile(plan);

			expect(result.sql.toLowerCase()).toContain('limit');
			expect(result.sql.toLowerCase()).toContain('offset');
		});
	});

	describe('compile - WHERE with parameters', () => {
		it('compiles WHERE clause with parameterized value', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const plan: PlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'where',
						column: 'active',
						operator: '=',
						value: true,
						paramIndex: 0,
					},
				],
			} as any;

			const result = adapter.compile(plan);

			expect(result.sql.toLowerCase()).toContain('where');
			expect(result.parameters.length).toBeGreaterThan(0);
		});

		it('compiles WHERE with multiple conditions', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const plan: PlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'where',
						column: 'active',
						operator: '=',
						value: true,
						paramIndex: 0,
					},
					{
						type: 'where',
						column: 'age',
						operator: '>',
						value: 18,
						paramIndex: 1,
					},
				],
			} as any;

			const result = adapter.compile(plan);

			expect(result.sql.toLowerCase()).toContain('where');
		});
	});

	describe('compile - GROUP BY', () => {
		it('compiles GROUP BY', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const plan: PlanReport = {
				rootTable: 'orders',
				decisions: [
					{ type: 'select', column: 'user_id' },
					{ type: 'groupBy', column: 'user_id' },
				],
			} as any;

			const result = adapter.compile(plan);

			expect(result.sql.toLowerCase()).toContain('group by');
		});
	});

	describe('compileWithIncludes', () => {
		it('returns main query and empty subqueryIncludes array', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const plan: PlanReport = {
				rootTable: 'users',
				decisions: [{ type: 'select', column: '*' }],
			} as any;

			const result = adapter.compileWithIncludes(plan);

			expect(result.main).toBeDefined();
			expect(result.main.sql).toContain('SELECT');
			expect(Array.isArray(result.subqueryIncludes)).toBe(true);
			expect(result.subqueryIncludes).toHaveLength(0);
		});

		it('compiles with include-strategy decisions', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const plan: PlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'include-strategy',
						choice: 'json_agg',
						context: {
							relation: 'posts',
							target: 'posts',
						},
					},
				],
			} as any;

			const result = adapter.compileWithIncludes(plan);

			expect(result.main).toBeDefined();
			expect(result.main.sql).toContain('SELECT');
		});

		it('compiles synthetic binding json_agg include decisions with CTE parentKey correlation', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const plan: PlanReport = {
				rootTable: 'active_authors',
				intent: {
					type: 'select',
					from: 'active_authors',
					select: {
						type: 'expressions',
						columns: [
							{ kind: 'column', column: '*' },
							{
								kind: 'relationColumn',
								relation: 'author_posts',
								column: '*',
								as: 'author_posts.*',
							},
						],
					},
					include: [{ relation: 'author_posts' }],
				},
				decisions: [
					{
						id: 'binding-include-0',
						type: 'include-strategy',
						choice: 'json_agg',
						context: {
							sourceTable: 'active_authors',
							target: 'posts',
							relation: 'author_posts',
							relationType: 'hasMany',
							foreignKey: 'author_id',
							parentKey: 'author_key',
							targetOrderKey: ['id'],
							includeAlias: 'authorPosts',
							intentPath: 'include[0]',
						},
						reasoning: 'synthetic binding include',
						alternatives: [],
					},
				],
				warnings: [],
				ctes: [],
				metadata: {
					planningTimeMs: 0,
					relationsAnalyzed: 0,
					isAmbiguous: false,
				},
			} as PlanReport;

			const result = adapter.compile(plan);

			expect(result.sql).toContain(
				'json_agg(to_jsonb(__t__) ORDER BY __t__.id ASC NULLS LAST)',
			);
			expect(result.sql).toContain('AS author_posts_json');
			expect(result.sql).toMatch(
				/WHERE __t__\.author_id = active_authors\.author_key/i,
			);
		});

		it('compiles synthetic binding nested json_agg includes from flat chained intent paths', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const plan: PlanReport = {
				rootTable: 'projected_authors',
				intent: {
					type: 'select',
					from: 'projected_authors',
					select: {
						type: 'expressions',
						columns: [
							{ kind: 'column', column: '*' },
							{
								kind: 'relationColumn',
								relation: 'author_posts.comments',
								column: '*',
								as: 'author_posts.comments.*',
							},
						],
					},
					include: [
						{
							relation: 'author_posts',
							include: [{ relation: 'comments' }],
						},
					],
				},
				decisions: [
					{
						id: 'binding-include-0',
						type: 'include-strategy',
						choice: 'json_agg',
						context: {
							sourceTable: 'projected_authors',
							target: 'posts',
							relation: 'author_posts',
							relationType: 'hasMany',
							foreignKey: 'author_id',
							parentKey: 'id',
							targetOrderKey: ['id'],
							includeAlias: 'author_posts',
							intentPath: 'include[0]',
						},
						reasoning: 'synthetic binding include',
						alternatives: [],
					},
					{
						id: 'binding-include-0-tail-0',
						type: 'include-strategy',
						choice: 'json_agg',
						context: {
							sourceTable: 'posts',
							target: 'comments',
							relation: 'comments',
							relationType: 'hasMany',
							foreignKey: 'post_id',
							parentKey: 'id',
							targetOrderKey: ['id'],
							includeAlias: 'comments',
							intentPath: 'include[0].include[0]',
						},
						reasoning: 'synthetic binding tail include',
						alternatives: [],
					},
				],
				warnings: [],
				ctes: [],
				metadata: {
					planningTimeMs: 0,
					relationsAnalyzed: 0,
					isAmbiguous: false,
				},
			} as PlanReport;

			const result = adapter.compile(plan);

			expect(result.sql).toContain(
				'json_agg(to_jsonb(__t__) || jsonb_build_object',
			);
			expect(result.sql).toContain('ORDER BY __t__.id ASC NULLS LAST');
			expect(result.sql).toContain('ORDER BY __t1__.id ASC NULLS LAST');
			expect(result.sql).toContain('jsonb_build_object');
			expect(result.sql).toContain('AS author_posts_json');
			expect(result.sql).toMatch(
				/WHERE __t__\.author_id = projected_authors\.id/i,
			);
			expect(result.sql).toMatch(/WHERE __t1__\.post_id = __t__\.id/i);
		});

		it('rejects synthetic binding json_agg includes when the dialect disables JSON aggregation', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const plan: PlanReport = {
				rootTable: 'active_authors',
				intent: {
					type: 'select',
					from: 'active_authors',
					select: { type: 'all' },
					include: [{ relation: 'author_posts' }],
				},
				decisions: [
					{
						id: 'binding-include-0',
						type: 'include-strategy',
						choice: 'json_agg',
						context: {
							sourceTable: 'active_authors',
							target: 'posts',
							relation: 'author_posts',
							relationType: 'hasMany',
							foreignKey: 'author_id',
							parentKey: 'author_key',
							includeAlias: 'author_posts',
							intentPath: 'include[0]',
						},
						reasoning: 'synthetic binding include',
						alternatives: [],
					},
				],
				warnings: [],
				ctes: [],
				metadata: {
					planningTimeMs: 0,
					relationsAnalyzed: 0,
					isAmbiguous: false,
				},
			} as PlanReport;

			expect(() =>
				adapter.compile(plan, {
					dialectCapabilities: {
						...adapter.dialectCapabilities,
						supportsJsonAgg: false,
					},
				}),
			).toThrow(/JSON aggregation for relation includes not supported/);
		});
	});

	describe('withSchema', () => {
		it('returns new adapter with schema scope', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const scopedAdapter = adapter.withSchema('tenant_456');

			expect(scopedAdapter).toBeDefined();
			expect(scopedAdapter).not.toBe(adapter);
		});

		it('schema-scoped adapter includes schema in compiled SQL', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const scopedAdapter = adapter.withSchema('tenant_456');

			const plan: PlanReport = {
				rootTable: 'users',
				decisions: [{ type: 'select', column: '*' }],
			} as any;

			const result = scopedAdapter.compile(plan);

			expect(result.sql).toContain('tenant_456');
		});

		it('validates schema identifier', () => {
			const adapter = createPgsqlCompileOnlyAdapter();

			// Invalid schema name with SQL injection attempt
			expect(() => adapter.withSchema('tenant"; DROP TABLE users--')).toThrow();
		});

		it('preserves dbCasing in scoped adapter', () => {
			const adapter = createPgsqlCompileOnlyAdapter({
				dbCasing: 'snake_case',
			});
			const scopedAdapter = adapter.withSchema('tenant_789');

			expect(scopedAdapter.dbCasing).toBe('snake_case');
		});
	});

	describe('compile options - custom PK and FK derivation', () => {
		it('uses custom defaultPkColumnName', () => {
			const adapter = createPgsqlCompileOnlyAdapter({
				defaultPkColumnName: 'uuid',
			});

			// This would be exercised in FK resolution scenarios
			expect(adapter).toBeDefined();
		});

		it('uses custom deriveFkColumnName function', () => {
			const customFn = (tableName: string, pkName: string) =>
				`${tableName}_${pkName}_custom`;

			const adapter = createPgsqlCompileOnlyAdapter({
				deriveFkColumnName: customFn,
			});

			// This would be exercised in FK resolution scenarios
			expect(adapter).toBeDefined();
		});
	});

	describe('compile with model option', () => {
		it('passes model to compile function', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const mockModel = {
				tables: new Map(),
				relations: new Map(),
				getTable: () => undefined,
				getRelation: () => undefined,
			};

			const plan: PlanReport = {
				rootTable: 'users',
				decisions: [{ type: 'select', column: '*' }],
			} as any;

			const result = adapter.compile(plan, { model: mockModel as any });

			expect(result.sql).toContain('SELECT');
		});
	});

	describe('compile - edge cases', () => {
		it('compiles plan without decisions array', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const plan: PlanReport = {
				rootTable: 'users',
				decisions: [],
			} as any;

			const result = adapter.compile(plan);

			// Should still produce valid SQL
			expect(result.sql).toContain('SELECT');
		});

		it('compiles plan with intent object', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const plan: PlanReport = {
				rootTable: 'users',
				intent: {
					type: 'query',
					table: 'users',
					select: { type: 'all' },
				},
				decisions: [],
			} as any;

			const result = adapter.compile(plan);

			expect(result.sql).toContain('SELECT');
		});
	});

	describe('multiple options combinations', () => {
		it('creates adapter with all options', () => {
			const adapter = createPgsqlCompileOnlyAdapter({
				schemaName: 'tenant_full',
				dbCasing: 'camelCase',
				defaultPkColumnName: 'id',
				deriveFkColumnName: (t, p) => `${t}_${p}`,
			});

			expect(adapter).toBeDefined();
			expect(adapter.dbCasing).toBe('camelCase');
		});

		it('compile respects all adapter options', () => {
			const adapter = createPgsqlCompileOnlyAdapter({
				schemaName: 'tenant_all',
				dbCasing: 'snake_case',
			});

			const plan: PlanReport = {
				rootTable: 'users',
				decisions: [{ type: 'select', column: '*' }],
			} as any;

			const result = adapter.compile(plan);

			expect(result.sql).toContain('tenant_all');
		});
	});

	// ==================================================================
	// NEW COVERAGE TESTS — mutation compilation, recursive, lock modes,
	// subquery includes, error paths, schema scoping edges
	// ==================================================================

	describe('compileInsert', () => {
		it('compiles a basic INSERT with single row', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const intent = {
				table: 'users',
				values: [{ name: 'Alice', email: 'alice@ex.com' }],
			};
			const result = adapter.compileInsert(intent as any);
			const sql = result.sql.toLowerCase();
			expect(sql).toContain('insert');
			expect(sql).toContain('users');
			expect(result.parameters).toEqual(['Alice', 'alice@ex.com']);
		});

		it('compiles INSERT with RETURNING', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const intent = {
				table: 'users',
				values: [{ name: 'Bob' }],
				returning: ['id', 'name'],
			};
			const result = adapter.compileInsert(intent as any);
			const sql = result.sql.toLowerCase();
			expect(sql).toContain('returning');
		});

		it('compiles INSERT with schema scoping', () => {
			const adapter = createPgsqlCompileOnlyAdapter({
				schemaName: 'tenant_ins',
			});
			const intent = {
				table: 'users',
				values: [{ name: 'Charlie' }],
			};
			const result = adapter.compileInsert(intent as any);
			expect(result.sql).toContain('tenant_ins');
		});

		it('compiles INSERT with schema from compile options', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const intent = {
				table: 'users',
				values: [{ name: 'Dave' }],
			};
			const result = adapter.compileInsert(intent as any, {
				schemaName: 'opt_schema',
			});
			expect(result.sql).toContain('opt_schema');
		});

		it('empty-string compile options schemaName falls through to adapter constructor schemaName (INSERT path)', () => {
			// Regression guard for M-1 fix: deps.schemaName is now authoritative.
			// buildCompileDeps() uses || for schemaName, so '' falls through to constructor value.
			const adapter = createPgsqlCompileOnlyAdapter({
				schemaName: 'adapter_default',
			});
			const intent = {
				table: 'users',
				values: [{ name: 'Eve' }],
			};
			const result = adapter.compileInsert(intent as any, { schemaName: '' });
			// Constructor schema must win when options.schemaName is empty string
			expect(result.sql).toContain('adapter_default');
			expect(result.sql).not.toContain('""."'); // empty-schema prefix must never appear
		});

		it('compiles INSERT with multiple rows', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const intent = {
				table: 'users',
				values: [
					{ name: 'A', email: 'a@a.com' },
					{ name: 'B', email: 'b@b.com' },
				],
			};
			const result = adapter.compileInsert(intent as any);
			// Should have 4 params (2 rows × 2 columns)
			expect(result.parameters).toHaveLength(4);
		});

		it('compiles INSERT with empty values array', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const intent = {
				table: 'users',
				values: [],
			};
			const result = adapter.compileInsert(intent as any);
			expect(result.sql.toLowerCase()).toContain('insert');
		});

		it('compiles INSERT with undefined values', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const intent = {
				table: 'users',
			};
			const result = adapter.compileInsert(intent as any);
			expect(result.sql.toLowerCase()).toContain('insert');
		});
	});

	describe('compileUpdate', () => {
		it('compiles a basic UPDATE', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const intent = {
				table: 'users',
				set: { name: 'Updated' },
			};
			const result = adapter.compileUpdate(intent as any);
			const sql = result.sql.toLowerCase();
			expect(sql).toContain('update');
			expect(sql).toContain('users');
		});

		it('compiles UPDATE with WHERE clause', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const intent = {
				table: 'users',
				set: { active: false },
				where: { kind: 'comparison', field: 'id', operator: 'eq', value: 42 },
			};
			const result = adapter.compileUpdate(intent as any);
			const sql = result.sql.toLowerCase();
			expect(sql).toContain('update');
			expect(sql).toContain('where');
		});

		it('compiles UPDATE with RETURNING', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const intent = {
				table: 'users',
				set: { active: true },
				returning: ['*'],
			};
			const result = adapter.compileUpdate(intent as any);
			const sql = result.sql.toLowerCase();
			expect(sql).toContain('returning');
		});

		it('compiles UPDATE with schema scoping', () => {
			const adapter = createPgsqlCompileOnlyAdapter({
				schemaName: 'tenant_upd',
			});
			const intent = {
				table: 'users',
				set: { name: 'X' },
			};
			const result = adapter.compileUpdate(intent as any);
			expect(result.sql).toContain('tenant_upd');
		});

		it('compiles UPDATE with schema from compile options', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const intent = {
				table: 'users',
				set: { name: 'X' },
			};
			const result = adapter.compileUpdate(intent as any, {
				schemaName: 'upd_schema',
			});
			expect(result.sql).toContain('upd_schema');
		});
	});

	describe('compileDelete', () => {
		it('compiles a basic DELETE', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const intent = { table: 'users' };
			const result = adapter.compileDelete(intent as any);
			const sql = result.sql.toLowerCase();
			expect(sql).toContain('delete');
			expect(sql).toContain('users');
		});

		it('compiles DELETE with WHERE clause', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const intent = {
				table: 'users',
				where: { kind: 'comparison', field: 'id', operator: 'eq', value: 99 },
			};
			const result = adapter.compileDelete(intent as any);
			const sql = result.sql.toLowerCase();
			expect(sql).toContain('delete');
			expect(sql).toContain('where');
		});

		it('compiles DELETE with RETURNING', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const intent = {
				table: 'users',
				where: { kind: 'comparison', field: 'id', operator: 'eq', value: 1 },
				returning: ['id'],
			};
			const result = adapter.compileDelete(intent as any);
			const sql = result.sql.toLowerCase();
			expect(sql).toContain('returning');
		});

		it('compiles DELETE with schema scoping', () => {
			const adapter = createPgsqlCompileOnlyAdapter({
				schemaName: 'tenant_del',
			});
			const intent = { table: 'users' };
			const result = adapter.compileDelete(intent as any);
			expect(result.sql).toContain('tenant_del');
		});

		it('compiles DELETE with schema from compile options', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const intent = { table: 'users' };
			const result = adapter.compileDelete(intent as any, {
				schemaName: 'del_schema',
			});
			expect(result.sql).toContain('del_schema');
		});
	});

	describe('compileUpsert', () => {
		it('compiles upsert with doNothing action', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const intent = {
				table: 'users',
				values: [{ id: 1, name: 'Alice' }],
				onConflict: { columns: ['id'] },
				action: { type: 'doNothing' },
			};
			const result = adapter.compileUpsert(intent as any);
			const sql = result.sql.toLowerCase();
			expect(sql).toContain('insert');
			expect(sql).toContain('on conflict');
			expect(sql).toContain('do nothing');
		});

		it('compiles upsert with doUpdate action (implicit update columns)', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const intent = {
				table: 'users',
				values: [{ id: 1, name: 'Alice', email: 'alice@ex.com' }],
				onConflict: { columns: ['id'] },
				action: { type: 'doUpdate' },
			};
			const result = adapter.compileUpsert(intent as any);
			const sql = result.sql.toLowerCase();
			expect(sql).toContain('on conflict');
			expect(sql).toContain('do update');
		});

		it('compiles upsert with doUpdate and explicit set', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const intent = {
				table: 'users',
				values: [{ id: 1, name: 'Alice' }],
				onConflict: { columns: ['id'] },
				action: { type: 'doUpdate', set: { name: 'Bob' } },
			};
			const result = adapter.compileUpsert(intent as any);
			const sql = result.sql.toLowerCase();
			expect(sql).toContain('do update');
		});

		it('compiles upsert with constraint-based conflict', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const intent = {
				table: 'users',
				values: [{ id: 1, name: 'Alice' }],
				onConflict: { constraint: 'users_pkey' },
				action: { type: 'doNothing' },
			};
			const result = adapter.compileUpsert(intent as any);
			const sql = result.sql.toLowerCase();
			expect(sql).toContain('on conflict');
		});

		it('compiles upsert with RETURNING', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const intent = {
				table: 'users',
				values: [{ id: 1, name: 'Alice' }],
				onConflict: { columns: ['id'] },
				action: { type: 'doNothing' },
				returning: ['id'],
			};
			const result = adapter.compileUpsert(intent as any);
			const sql = result.sql.toLowerCase();
			expect(sql).toContain('returning');
		});

		it('compiles upsert with schema scoping', () => {
			const adapter = createPgsqlCompileOnlyAdapter({
				schemaName: 'tenant_ups',
			});
			const intent = {
				table: 'users',
				values: [{ id: 1, name: 'A' }],
				onConflict: { columns: ['id'] },
				action: { type: 'doNothing' },
			};
			const result = adapter.compileUpsert(intent as any);
			expect(result.sql).toContain('tenant_ups');
		});
	});

	describe('compileInsertFrom', () => {
		it('compiles INSERT FROM SELECT', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const intent = {
				table: 'archive_users',
				source: 'users',
				columns: ['name', 'email'],
			};
			const result = adapter.compileInsertFrom(intent as any);
			const sql = result.sql.toLowerCase();
			expect(sql).toContain('insert');
			expect(sql).toContain('select');
		});

		it('compiles INSERT FROM with WHERE', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const intent = {
				table: 'archive_users',
				source: 'users',
				columns: ['name'],
				where: {
					kind: 'comparison',
					field: 'active',
					operator: 'eq',
					value: false,
				},
			};
			const result = adapter.compileInsertFrom(intent as any);
			const sql = result.sql.toLowerCase();
			expect(sql).toContain('where');
		});

		it('compiles INSERT FROM with LIMIT', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const intent = {
				table: 'archive_users',
				source: 'users',
				limit: 100,
			};
			const result = adapter.compileInsertFrom(intent as any);
			const sql = result.sql.toLowerCase();
			expect(sql).toContain('limit');
		});

		it('compiles INSERT FROM with RETURNING', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const intent = {
				table: 'archive_users',
				source: 'users',
				returning: ['id'],
			};
			const result = adapter.compileInsertFrom(intent as any);
			const sql = result.sql.toLowerCase();
			expect(sql).toContain('returning');
		});

		it('compiles INSERT FROM with schema scoping', () => {
			const adapter = createPgsqlCompileOnlyAdapter({
				schemaName: 'tenant_if',
			});
			const intent = {
				table: 'archive_users',
				source: 'users',
			};
			const result = adapter.compileInsertFrom(intent as any);
			expect(result.sql).toContain('tenant_if');
		});
	});

	describe('compileUpsertFrom', () => {
		it('compiles UPSERT FROM SELECT', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const intent = {
				table: 'users',
				source: 'staging_users',
				conflictColumns: ['email'],
				columns: ['name', 'email'],
			};
			const result = adapter.compileUpsertFrom(intent as any);
			const sql = result.sql.toLowerCase();
			expect(sql).toContain('insert');
			expect(sql).toContain('on conflict');
		});

		it('compiles UPSERT FROM with WHERE', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const intent = {
				table: 'users',
				source: 'staging',
				conflictColumns: ['email'],
				columns: ['name', 'email'],
				where: {
					kind: 'comparison',
					field: 'active',
					operator: 'eq',
					value: true,
				},
			};
			const result = adapter.compileUpsertFrom(intent as any);
			const sql = result.sql.toLowerCase();
			expect(sql).toContain('where');
		});

		it('compiles UPSERT FROM with schema', () => {
			const adapter = createPgsqlCompileOnlyAdapter({
				schemaName: 'tenant_uf',
			});
			const intent = {
				table: 'users',
				source: 'staging',
				conflictColumns: ['email'],
				columns: ['name', 'email'],
			};
			const result = adapter.compileUpsertFrom(intent as any);
			expect(result.sql).toContain('tenant_uf');
		});
	});

	describe('compileRecursive', () => {
		it('compiles adjacency-list descendant traversal', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const report = {
				intent: {
					cteName: 'tree_cte',
					maxDepth: 10,
					track: {},
					start: {
						select: ['name'],
						nodeIdExpr: { kind: 'column', name: 'id' },
					},
					traversal: {
						kind: 'adjacency',
						nodeTable: 'categories',
						nodeId: 'id',
						parentId: 'parent_id',
						direction: 'descendants',
					},
				},
			};
			const model = {} as any;
			const result = adapter.compileRecursive(report as any, model);
			const sql = result.sql.toLowerCase();
			expect(sql).toContain('with recursive');
			expect(sql).toContain('categories');
		});

		it('compiles adjacency-list ancestor traversal', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const report = {
				intent: {
					cteName: 'anc_cte',
					maxDepth: 5,
					track: {},
					start: {
						select: ['name'],
						nodeIdExpr: { kind: 'column', name: 'id' },
					},
					traversal: {
						kind: 'adjacency',
						nodeTable: 'categories',
						nodeId: 'id',
						parentId: 'parent_id',
						direction: 'ancestors',
					},
				},
			};
			const result = adapter.compileRecursive(report as any, {} as any);
			const sql = result.sql.toLowerCase();
			expect(sql).toContain('with recursive');
		});

		it('compiles edge-table traversal', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const report = {
				intent: {
					cteName: 'graph_cte',
					maxDepth: 3,
					track: {},
					start: {
						select: ['name'],
						nodeIdExpr: { kind: 'column', name: 'id' },
					},
					traversal: {
						kind: 'edge-table',
						nodeTable: 'nodes',
						nodeId: 'id',
						edgeTable: 'edges',
						edgeFrom: 'from_id',
						edgeTo: 'to_id',
						direction: 'out',
					},
				},
			};
			const result = adapter.compileRecursive(report as any, {} as any);
			const sql = result.sql.toLowerCase();
			expect(sql).toContain('with recursive');
			expect(sql).toContain('edges');
		});

		it('compiles edge-table with bidirectional direction', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const report = {
				intent: {
					cteName: 'bidir_cte',
					maxDepth: 5,
					track: {},
					start: {
						select: [],
						nodeIdExpr: { kind: 'column', name: 'id' },
					},
					traversal: {
						kind: 'edge-table',
						nodeTable: 'nodes',
						nodeId: 'id',
						edgeTable: 'edges',
						edgeFrom: 'from_id',
						edgeTo: 'to_id',
						direction: 'both',
						edgeStorageHint: 'directed-only',
					},
				},
			};
			const result = adapter.compileRecursive(report as any, {} as any);
			const sql = result.sql.toLowerCase();
			expect(sql).toContain('with recursive');
		});

		it('compiles recursive with track depth', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const report = {
				intent: {
					cteName: 'depth_cte',
					maxDepth: 10,
					track: { depth: { as: 'level' } },
					start: {
						select: ['name'],
						nodeIdExpr: { kind: 'column', name: 'id' },
					},
					traversal: {
						kind: 'adjacency',
						nodeTable: 'categories',
						nodeId: 'id',
						parentId: 'parent_id',
						direction: 'descendants',
					},
				},
			};
			const result = adapter.compileRecursive(report as any, {} as any);
			expect(result.sql).toContain('level');
		});

		it('compiles recursive with track path', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const report = {
				intent: {
					cteName: 'path_cte',
					maxDepth: 10,
					track: { path: { as: 'trail' } },
					start: {
						select: ['name'],
						nodeIdExpr: { kind: 'column', name: 'id' },
					},
					traversal: {
						kind: 'adjacency',
						nodeTable: 'categories',
						nodeId: 'id',
						parentId: 'parent_id',
						direction: 'descendants',
					},
				},
			};
			const result = adapter.compileRecursive(report as any, {} as any);
			expect(result.sql).toContain('trail');
		});

		it('compiles recursive with schema scoping', () => {
			const adapter = createPgsqlCompileOnlyAdapter({
				schemaName: 'tenant_rec',
			});
			const report = {
				intent: {
					cteName: 'r_cte',
					maxDepth: 5,
					track: {},
					start: {
						select: [],
						nodeIdExpr: { kind: 'column', name: 'id' },
					},
					traversal: {
						kind: 'adjacency',
						nodeTable: 'categories',
						nodeId: 'id',
						parentId: 'parent_id',
						direction: 'descendants',
					},
				},
			};
			const result = adapter.compileRecursive(report as any, {} as any);
			expect(result.sql).toContain('tenant_rec');
		});

		it('throws for unsupported traversal kind', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const report = {
				intent: {
					cteName: 'custom_cte',
					maxDepth: 5,
					track: {},
					start: {
						select: [],
						nodeIdExpr: { kind: 'column', name: 'id' },
					},
					traversal: {
						kind: 'custom',
						nodeTable: 'nodes',
						nodeId: 'id',
					},
				},
			};
			expect(() => adapter.compileRecursive(report as any, {} as any)).toThrow(
				/Unsupported traversal kind/,
			);
		});

		it('compiles edge-table with anchor WHERE', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const report = {
				intent: {
					cteName: 'anchor_cte',
					maxDepth: 5,
					track: {},
					start: {
						select: ['name'],
						nodeIdExpr: { kind: 'column', name: 'id' },
						where: {
							kind: 'comparison',
							field: 'active',
							operator: 'eq',
							value: true,
						},
					},
					traversal: {
						kind: 'edge-table',
						nodeTable: 'nodes',
						nodeId: 'id',
						edgeTable: 'edges',
						edgeFrom: 'from_id',
						edgeTo: 'to_id',
						direction: 'out',
					},
				},
			};
			const result = adapter.compileRecursive(report as any, {} as any);
			expect(result.sql).toBeDefined();
		});

		it('compiles edge-table with "in" direction (swaps edgeFrom/edgeTo)', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const report = {
				intent: {
					cteName: 'in_cte',
					maxDepth: 5,
					track: {},
					start: {
						select: [],
						nodeIdExpr: { kind: 'column', name: 'id' },
					},
					traversal: {
						kind: 'edge-table',
						nodeTable: 'nodes',
						nodeId: 'id',
						edgeTable: 'edges',
						edgeFrom: 'from_id',
						edgeTo: 'to_id',
						direction: 'in',
					},
				},
			};
			const result = adapter.compileRecursive(report as any, {} as any);
			expect(result.sql).toBeDefined();
		});
	});

	describe('buildRecursiveAnchorWhere - edge cases', () => {
		it('handles AND condition with single item', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const report = {
				intent: {
					cteName: 'and_cte',
					maxDepth: 5,
					track: {},
					start: {
						select: [],
						nodeIdExpr: { kind: 'column', name: 'id' },
						where: {
							kind: 'and',
							conditions: [
								{ kind: 'comparison', field: 'x', operator: 'eq', value: 1 },
							],
						},
					},
					traversal: {
						kind: 'edge-table',
						nodeTable: 'nodes',
						nodeId: 'id',
						edgeTable: 'edges',
						edgeFrom: 'from_id',
						edgeTo: 'to_id',
						direction: 'out',
					},
				},
			};
			const result = adapter.compileRecursive(report as any, {} as any);
			expect(result.sql).toBeDefined();
		});

		it('handles OR condition with multiple items', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const report = {
				intent: {
					cteName: 'or_cte',
					maxDepth: 5,
					track: {},
					start: {
						select: [],
						nodeIdExpr: { kind: 'column', name: 'id' },
						where: {
							kind: 'or',
							conditions: [
								{ kind: 'comparison', field: 'x', operator: 'eq', value: 1 },
								{ kind: 'comparison', field: 'y', operator: 'eq', value: 2 },
							],
						},
					},
					traversal: {
						kind: 'edge-table',
						nodeTable: 'nodes',
						nodeId: 'id',
						edgeTable: 'edges',
						edgeFrom: 'from_id',
						edgeTo: 'to_id',
						direction: 'out',
					},
				},
			};
			const result = adapter.compileRecursive(report as any, {} as any);
			expect(result.sql).toBeDefined();
		});

		it('handles unknown kind with fallback to TRUE', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const report = {
				intent: {
					cteName: 'unk_cte',
					maxDepth: 5,
					track: {},
					start: {
						select: [],
						nodeIdExpr: { kind: 'column', name: 'id' },
						where: { kind: 'unknown_kind' },
					},
					traversal: {
						kind: 'edge-table',
						nodeTable: 'nodes',
						nodeId: 'id',
						edgeTable: 'edges',
						edgeFrom: 'from_id',
						edgeTo: 'to_id',
						direction: 'out',
					},
				},
			};
			const result = adapter.compileRecursive(report as any, {} as any);
			expect(result.sql).toBeDefined();
		});

		it('handles null/undefined where with fallback to TRUE', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const report = {
				intent: {
					cteName: 'null_cte',
					maxDepth: 5,
					track: {},
					start: {
						select: [],
						nodeIdExpr: { kind: 'column', name: 'id' },
						where: null,
					},
					traversal: {
						kind: 'edge-table',
						nodeTable: 'nodes',
						nodeId: 'id',
						edgeTable: 'edges',
						edgeFrom: 'from_id',
						edgeTo: 'to_id',
						direction: 'out',
					},
				},
			};
			// null where means no anchorWhere → should still compile
			const result = adapter.compileRecursive(report as any, {} as any);
			expect(result.sql).toBeDefined();
		});
	});

	describe('compileSubqueryInclude', () => {
		it('compiles simple subquery include for single FK', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const info = {
				relationName: 'posts',
				targetTable: 'posts',
				foreignKey: 'author_id',
				sourceKey: 'id',
				sourceTable: 'users',
			};
			const result = adapter.compileSubqueryInclude(info as any, [1, 2, 3]);
			const sql = result.sql.toLowerCase();
			expect(sql).toContain('select');
			expect(sql).toContain('posts');
			expect(sql).toContain('in');
			expect(result.parameters).toEqual([1, 2, 3]);
		});

		it('returns WHERE FALSE for empty parentIds', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const info = {
				relationName: 'posts',
				targetTable: 'posts',
				foreignKey: 'author_id',
				sourceKey: 'id',
				sourceTable: 'users',
			};
			const result = adapter.compileSubqueryInclude(info as any, []);
			expect(result.sql).toContain('WHERE FALSE');
			expect(result.parameters).toEqual([]);
		});

		it('returns WHERE FALSE with schema for empty parentIds', () => {
			const adapter = createPgsqlCompileOnlyAdapter({
				schemaName: 'tenant_sq',
			});
			const info = {
				relationName: 'posts',
				targetTable: 'posts',
				foreignKey: 'author_id',
				sourceKey: 'id',
				sourceTable: 'users',
			};
			const result = adapter.compileSubqueryInclude(info as any, []);
			expect(result.sql).toContain('tenant_sq');
			expect(result.sql).toContain('WHERE FALSE');
		});

		it('compiles composite FK with multiple parent IDs', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const info = {
				relationName: 'items',
				targetTable: 'items',
				foreignKey: ['org_id', 'user_id'],
				sourceKey: 'id',
				sourceTable: 'users',
			};
			const result = adapter.compileSubqueryInclude(info as any, [
				[1, 'a'],
				[2, 'b'],
			]);
			expect(result.parameters).toHaveLength(4);
		});

		it('compiles composite FK with single parent ID', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const info = {
				relationName: 'items',
				targetTable: 'items',
				foreignKey: ['org_id', 'user_id'],
				sourceKey: 'id',
				sourceTable: 'users',
			};
			const result = adapter.compileSubqueryInclude(info as any, [[1, 'a']]);
			expect(result.parameters).toHaveLength(2);
		});

		it('compiles M:N subquery include via junction table', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const info = {
				relationName: 'tags',
				targetTable: 'tags',
				foreignKey: 'tag_id',
				sourceKey: 'id',
				sourceTable: 'posts',
				through: 'post_tags',
				throughSourceKey: 'post_id',
				throughTargetKey: 'tag_id',
			};
			const result = adapter.compileSubqueryInclude(info as any, [1, 2]);
			const sql = result.sql.toLowerCase();
			expect(sql).toContain('join');
			expect(sql).toContain('post_tags');
			expect(result.parameters).toEqual([1, 2]);
		});

		it('compiles subquery include with schema', () => {
			const adapter = createPgsqlCompileOnlyAdapter({
				schemaName: 'tenant_sqi',
			});
			const info = {
				relationName: 'posts',
				targetTable: 'posts',
				foreignKey: 'author_id',
				sourceKey: 'id',
				sourceTable: 'users',
			};
			const result = adapter.compileSubqueryInclude(info as any, [1]);
			expect(result.sql).toContain('tenant_sqi');
		});
	});

	describe('compileWithIncludes - subquery includes', () => {
		// subquery strategy decisions populate subqueryIncludes for client-side hydration.
		// hydrateJsonAggIncludes only processes decisions with choice === 'json_agg';
		// choice === 'subquery' decisions must travel the subquery hydration path.
		it('subqueryIncludes is populated for subquery include-strategy (hasMany)', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const plan = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'include-strategy',
						choice: 'subquery',
						context: {
							relation: 'posts',
							target: 'posts',
							relationType: 'hasMany',
						},
					},
				],
			} as any;
			const result = adapter.compileWithIncludes(plan);
			// subquery decisions generate a client-side fetch entry
			expect(result.subqueryIncludes).toHaveLength(1);
			expect(result.subqueryIncludes[0]?.relationName).toBe('posts');
			expect(result.subqueryIncludes[0]?.targetTable).toBe('posts');
		});

		it('skips include-strategy decisions that are not subquery', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const plan = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'include-strategy',
						choice: 'json_agg',
						context: {
							relation: 'posts',
							target: 'posts',
						},
					},
				],
			} as any;
			const result = adapter.compileWithIncludes(plan);
			expect(result.subqueryIncludes).toHaveLength(0);
		});

		it('skips subquery decisions with no target', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const plan = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'include-strategy',
						choice: 'subquery',
						context: { relation: 'posts' },
					},
				],
			} as any;
			const result = adapter.compileWithIncludes(plan);
			expect(result.subqueryIncludes).toHaveLength(0);
		});

		it('uses includeAlias: subqueryIncludes uses includeAlias as relationName', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const plan = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'include-strategy',
						choice: 'subquery',
						context: {
							relation: 'posts',
							target: 'posts',
							includeAlias: 'myPosts',
							relationType: 'hasMany',
						},
					},
				],
			} as any;
			const result = adapter.compileWithIncludes(plan);
			// includeAlias is preferred as the relation name for hydration
			expect(result.subqueryIncludes).toHaveLength(1);
			expect(result.subqueryIncludes[0]?.relationName).toBe('myPosts');
		});

		it('handles belongsTo: subqueryIncludes is populated with correct sourceKey/foreignKey', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const plan = {
				rootTable: 'posts',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'include-strategy',
						choice: 'subquery',
						context: {
							relation: 'author',
							target: 'users',
							relationType: 'belongsTo',
						},
					},
				],
			} as any;
			const result = adapter.compileWithIncludes(plan);
			// belongsTo: sourceKey = FK on source (e.g. authorId), foreignKey = PK on target
			expect(result.subqueryIncludes).toHaveLength(1);
			expect(result.subqueryIncludes[0]?.relationName).toBe('author');
			expect(result.subqueryIncludes[0]?.targetTable).toBe('users');
			expect(result.subqueryIncludes[0]?.relationType).toBe('belongsTo');
		});
	});

	describe('createDump', () => {
		it('creates a dump with minimal meta', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const plan = { rootTable: 'users', decisions: [] } as any;
			const query = testQuery('SELECT 1');
			const dump = adapter.createDump(plan, query);

			expect(dump.sql).toBe('SELECT 1');
			expect(dump.params).toEqual([]);
			expect(dump.plan).toBe(plan);
			expect(dump.meta?.compiledAt).toBeInstanceOf(Date);
		});

		it('creates dump with schema in meta', () => {
			const adapter = createPgsqlCompileOnlyAdapter({
				schemaName: 'tenant_dump',
			});
			const plan = { rootTable: 'users', decisions: [] } as any;
			const query = testQuery('SELECT 1');
			const dump = adapter.createDump(plan, query);

			expect(dump.meta?.schema).toBe('tenant_dump');
		});

		it('creates dump with custom meta overrides', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const plan = { rootTable: 'users', decisions: [] } as any;
			const query = testQuery('SELECT 1');
			const dump = adapter.createDump(plan, query, {
				queryName: 'test-query',
				correlationId: 'abc-123',
			});

			expect(dump.meta?.queryName).toBe('test-query');
			expect(dump.meta?.correlationId).toBe('abc-123');
		});
	});

	describe('error paths - compile-only adapter', () => {
		it('throws on execute', async () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			await expect(adapter.execute(testQuery('SELECT 1'))).rejects.toThrow(
				/constructed without a connection/,
			);
		});

		it('throws on executeOne', async () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			await expect(adapter.executeOne(testQuery('SELECT 1'))).rejects.toThrow(
				/constructed without a connection/,
			);
		});

		it('throws on executeRaw', async () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			await expect(adapter.executeRaw('SELECT 1')).rejects.toThrow(
				/constructed without a connection/,
			);
		});

		it('throws on getPoolInstance', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			expect(() => adapter.getPoolInstance()).toThrow(
				/constructed without a connection/,
			);
		});

		it('throws on introspect', async () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			await expect(adapter.introspect()).rejects.toThrow(
				/constructed without a connection/,
			);
		});

		it('throws on transaction', async () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			await expect(adapter.transaction(async () => 'x')).rejects.toThrow(
				/constructed without a connection/,
			);
		});

		it('stream throws on a connectionless adapter', async () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const iter = adapter.stream(testQuery('SELECT 1'));
			// The generator should throw when iterated
			await expect(iter.next()).rejects.toThrow(
				/constructed without a connection/,
			);
		});
	});

	describe('validateIdentifier', () => {
		it('accepts valid identifier', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			expect(() => adapter.validateIdentifier('users', 'table')).not.toThrow();
		});

		it('rejects SQL injection in identifier', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			expect(() =>
				adapter.validateIdentifier('users"; DROP TABLE--', 'table'),
			).toThrow();
		});
	});

	describe('compile - lock mode variants', () => {
		it('compiles FOR UPDATE via legacy plan', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const plan = {
				rootTable: 'jobs',
				intent: {
					type: 'query',
					table: 'jobs',
					select: { type: 'all' },
					lock: { strength: 'forUpdate', waitPolicy: 'block' },
				},
				decisions: [],
			} as any;
			const result = adapter.compile(plan);
			const sql = result.sql.toLowerCase();
			expect(sql).toContain('for update');
		});

		it('compiles FOR SHARE with skipLocked via intent', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const plan = {
				rootTable: 'jobs',
				intent: {
					type: 'query',
					table: 'jobs',
					select: { type: 'all' },
					lock: { strength: 'forShare', waitPolicy: 'skipLocked' },
				},
				decisions: [],
			} as any;
			const result = adapter.compile(plan);
			const sql = result.sql.toLowerCase();
			expect(sql).toContain('for share');
			expect(sql).toContain('skip locked');
		});

		it('compiles FOR NO KEY UPDATE with noWait via intent', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const plan = {
				rootTable: 'items',
				intent: {
					type: 'query',
					table: 'items',
					select: { type: 'all' },
					lock: { strength: 'forNoKeyUpdate', waitPolicy: 'noWait' },
				},
				decisions: [],
			} as any;
			const result = adapter.compile(plan);
			const sql = result.sql.toLowerCase();
			expect(sql).toContain('for no key update');
			expect(sql).toContain('nowait');
		});

		it('compiles FOR KEY SHARE via intent', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const plan = {
				rootTable: 'posts',
				intent: {
					type: 'query',
					table: 'posts',
					select: { type: 'all' },
					lock: { strength: 'forKeyShare', waitPolicy: 'block' },
				},
				decisions: [],
			} as any;
			const result = adapter.compile(plan);
			const sql = result.sql.toLowerCase();
			expect(sql).toContain('for key share');
		});
	});

	describe('compile - existsWrap via intent', () => {
		it('wraps select in EXISTS when intent has existsWrap', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const plan = {
				rootTable: 'users',
				intent: {
					type: 'query',
					table: 'users',
					select: { type: 'all' },
					existsWrap: true,
				},
				decisions: [],
			} as any;
			const result = adapter.compile(plan);
			const sql = result.sql.toLowerCase();
			expect(sql).toContain('exists');
		});
	});

	describe('compile - dbCasing variants', () => {
		it('compiles with snake_case naming', () => {
			const adapter = createPgsqlCompileOnlyAdapter({
				dbCasing: 'snake_case',
			});
			const plan = {
				rootTable: 'users',
				decisions: [{ type: 'select', column: '*' }],
			} as any;
			const result = adapter.compile(plan);
			expect(result.sql).toContain('SELECT');
		});

		it('compiles with camelCase naming', () => {
			const adapter = createPgsqlCompileOnlyAdapter({
				dbCasing: 'camelCase',
			});
			const plan = {
				rootTable: 'users',
				decisions: [{ type: 'select', column: '*' }],
			} as any;
			const result = adapter.compile(plan);
			expect(result.sql).toContain('SELECT');
		});
	});

	describe('generateDDL', () => {
		it('generates DDL from a simple model', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const model = {
				tables: new Map([
					[
						'users',
						{
							name: 'users',
							columns: [
								{ name: 'id', type: 'integer', nullable: false },
								{ name: 'name', type: 'text', nullable: false },
							],
							primaryKey: { columns: ['id'] },
							foreignKeys: [],
							indexes: [],
						},
					],
				]),
				relations: new Map(),
				getTable: function (n) {
					return this.tables.get(n);
				},
				getRelation: () => undefined,
			} as any;

			const ddl = adapter.generateDDL(model);
			expect(ddl.length).toBeGreaterThan(0);
			expect(ddl.some((s) => s.toLowerCase().includes('create table'))).toBe(
				true,
			);
		});

		it('generates DDL with schema name', () => {
			const adapter = createPgsqlCompileOnlyAdapter({
				schemaName: 'tenant_ddl',
			});
			const model = {
				tables: new Map([
					[
						'users',
						{
							name: 'users',
							columns: [{ name: 'id', type: 'integer', nullable: false }],
							primaryKey: { columns: ['id'] },
							foreignKeys: [],
							indexes: [],
						},
					],
				]),
				relations: new Map(),
				getTable: function (n) {
					return this.tables.get(n);
				},
				getRelation: () => undefined,
			} as any;

			const ddl = adapter.generateDDL(model);
			expect(ddl.some((s) => s.includes('tenant_ddl'))).toBe(true);
		});
	});

	// ==========================================================================
	// NEW COVERAGE: intent-based compile path branches
	// ==========================================================================

	describe('compile — intent path with model (column validation)', () => {
		it('throws when include has invalid columns in target table', () => {
			const model = {
				tables: new Map([
					[
						'posts',
						{
							name: 'posts',
							columns: [
								{ name: 'id', type: 'integer', nullable: false },
								{ name: 'author_id', type: 'integer', nullable: false },
							],
							primaryKey: { columns: ['id'] },
							foreignKeys: [],
							indexes: [],
						},
					],
					[
						'users',
						{
							name: 'users',
							columns: [
								{ name: 'id', type: 'integer', nullable: false },
								{ name: 'name', type: 'text', nullable: false },
							],
							primaryKey: { columns: ['id'] },
							foreignKeys: [],
							indexes: [],
						},
					],
				]),
				relations: new Map(),
				getTable: function (n) {
					return this.tables.get(n);
				},
				getRelation: () => undefined,
			} as any;

			// Use intent path: plan.intent triggers intentToDecisions which produces
			// selectRelationColumn decisions. plan.decisions contains planner output
			// (include-strategy) consumed by extractAllIncludeDecisions.
			const adapter = createPgsqlCompileOnlyAdapter({ model });
			const plan = {
				rootTable: 'posts',
				// Planner decisions: include-strategy produces includeStrategy decisions
				decisions: [
					{
						type: 'include-strategy',
						choice: 'json_agg',
						context: {
							relation: 'author',
							target: 'users',
							relationType: 'belongsTo',
							sourceTable: 'posts',
						},
					},
				],
				// Intent triggers intentToDecisions to produce selectRelationColumn
				intent: {
					type: 'query',
					table: 'posts',
					select: {
						type: 'expressions',
						columns: [
							{ kind: 'column', column: 'id' },
							{
								kind: 'relationColumn',
								relation: 'author',
								column: 'name',
							},
							{
								kind: 'relationColumn',
								relation: 'author',
								column: 'NONEXISTENT',
							},
						],
					},
				},
			} as any;

			expect(() => adapter.compile(plan, { model })).toThrow('Unknown column');
		});

		it('compiles with range type enrichment from model', () => {
			const model = {
				tables: new Map([
					[
						'events',
						{
							name: 'events',
							columns: [
								{ name: 'id', type: 'integer', nullable: false },
								{ name: 'period', type: 'daterange', nullable: true },
							],
							primaryKey: { columns: ['id'] },
							foreignKeys: [],
							indexes: [],
						},
					],
				]),
				relations: new Map(),
				getTable: function (n) {
					return this.tables.get(n);
				},
				getRelation: () => undefined,
			} as any;

			const adapter = createPgsqlCompileOnlyAdapter({ model });
			const plan = {
				rootTable: 'events',
				decisions: [],
				intent: {
					type: 'query',
					table: 'events',
					select: { fields: ['id'] },
					where: {
						kind: 'range',
						field: 'period',
						operator: 'contains',
						value: '2024-01-01',
					},
				},
			} as any;

			// Should not throw — enrichment adds dataType to the decision
			const result = adapter.compile(plan, { model });
			expect(result.sql).toContain('SELECT');
		});
	});

	describe('compile — intent path with relationColumnsMap', () => {
		it('deduplicates selectRelationColumn when covered by include', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const plan = {
				rootTable: 'posts',
				decisions: [
					{
						type: 'include-strategy',
						choice: 'json_agg',
						context: {
							relation: 'author',
							target: 'users',
							relationType: 'belongsTo',
							sourceTable: 'posts',
						},
					},
				],
				intent: {
					type: 'query',
					table: 'posts',
					select: {
						fields: [
							'id',
							{ kind: 'relationColumn', relation: 'author', column: 'name' },
							{
								kind: 'relationColumn',
								relation: 'author',
								column: 'email',
							},
						],
					},
					include: [{ relation: 'author' }],
				},
			} as any;

			const result = adapter.compile(plan);
			expect(result.sql).toContain('SELECT');
		});

		it('keeps selectRelationColumn when no include covers the relation', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const plan = {
				rootTable: 'posts',
				decisions: [],
				intent: {
					type: 'query',
					table: 'posts',
					select: {
						fields: [
							'id',
							{ kind: 'relationColumn', relation: 'author', column: 'name' },
						],
					},
				},
			} as any;

			const result = adapter.compile(plan);
			expect(result.sql).toContain('SELECT');
		});

		it('handles wildcard column in selectRelationColumn dedup', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const plan = {
				rootTable: 'posts',
				decisions: [
					{
						type: 'include-strategy',
						choice: 'json_agg',
						context: {
							relation: 'author',
							target: 'users',
							relationType: 'belongsTo',
							sourceTable: 'posts',
						},
					},
				],
				intent: {
					type: 'query',
					table: 'posts',
					select: {
						fields: [
							'id',
							{ kind: 'relationColumn', relation: 'author', column: '*' },
						],
					},
					include: [{ relation: 'author' }],
				},
			} as any;

			const result = adapter.compile(plan);
			expect(result.sql).toContain('SELECT');
		});
	});

	describe('getColumnTypes — coverage', () => {
		it('returns undefined when model is absent', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			// getColumnTypes is private, but exercised through compileInsert
			const result = adapter.compileInsert({
				type: 'insert',
				table: 'users',
				values: [{ name: 'alice' }],
			} as any);
			expect(result.sql).toContain('INSERT');
		});

		it('returns undefined when table not found in model', () => {
			const model = {
				tables: new Map(),
				relations: new Map(),
				getTable: () => undefined,
				getRelation: () => undefined,
			} as any;

			const adapter = createPgsqlCompileOnlyAdapter({ model });
			const result = adapter.compileInsert({
				type: 'insert',
				table: 'unknown_table',
				values: [{ foo: 'bar' }],
			} as any);
			expect(result.sql).toContain('INSERT');
		});

		it('detects range type columns', () => {
			const model = {
				tables: new Map([
					[
						'events',
						{
							name: 'events',
							columns: [
								{ name: 'id', type: 'integer', nullable: false },
								{ name: 'period', type: 'daterange', nullable: true },
								{ name: 'title', type: 'text', nullable: false },
							],
							primaryKey: { columns: ['id'] },
							foreignKeys: [],
							indexes: [],
						},
					],
				]),
				relations: new Map(),
				getTable: function (n) {
					return this.tables.get(n);
				},
				getRelation: () => undefined,
			} as any;

			const adapter = createPgsqlCompileOnlyAdapter({ model });
			const result = adapter.compileInsert({
				type: 'insert',
				table: 'events',
				values: [{ id: 1, period: '[2024-01-01,2024-12-31]', title: 'Test' }],
			} as any);
			expect(result.sql).toContain('INSERT');
			// Range type should be cast
			expect(result.sql).toContain('daterange');
		});
	});

	describe('compileUpsertFrom — columns from model', () => {
		it('derives columns from model when not specified', () => {
			const model = {
				tables: new Map([
					[
						'users',
						{
							name: 'users',
							columns: [
								{ name: 'id', type: 'integer', nullable: false },
								{ name: 'name', type: 'text', nullable: false },
								{ name: 'email', type: 'text', nullable: true },
							],
							primaryKey: { columns: ['id'] },
							foreignKeys: [],
							indexes: [],
						},
					],
				]),
				relations: new Map(),
				getTable: function (n) {
					return this.tables.get(n);
				},
				getRelation: () => undefined,
			} as any;

			const adapter = createPgsqlCompileOnlyAdapter();
			const result = adapter.compileUpsertFrom(
				{
					type: 'upsertFrom',
					table: 'users',
					source: 'staging_users',
					conflictColumns: ['id'],
				} as any,
				{ model },
			);
			expect(result.sql).toContain('INSERT');
			expect(result.sql).toContain('ON CONFLICT');
		});

		it('uses explicit columns when provided', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const result = adapter.compileUpsertFrom({
				type: 'upsertFrom',
				table: 'users',
				source: 'staging_users',
				conflictColumns: ['id'],
				columns: ['id', 'name'],
			} as any);
			expect(result.sql).toContain('INSERT');
		});

		it('compiles with where and limit', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const result = adapter.compileUpsertFrom({
				type: 'upsertFrom',
				table: 'users',
				source: 'staging_users',
				conflictColumns: ['id'],
				columns: ['id', 'name'],
				where: {
					kind: 'comparison',
					field: 'active',
					operator: 'eq',
					value: true,
				},
				limit: 100,
				returning: ['id'],
			} as any);
			expect(result.sql).toContain('INSERT');
			expect(result.sql).toContain('LIMIT');
			expect(result.sql).toContain('RETURNING');
		});
	});

	describe('compileWithIncludes — subquery include branches', () => {
		// subquery strategy decisions populate subqueryIncludes for client-side hydration.
		// hydrateJsonAggIncludes only runs for choice === 'json_agg' planner decisions.
		it('subqueryIncludes populated for hasMany subquery decision', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const plan = {
				rootTable: 'authors',
				decisions: [
					{
						type: 'include-strategy',
						choice: 'subquery',
						context: {
							relation: 'posts',
							target: 'posts',
							relationType: 'hasMany',
							sourceTable: 'authors',
						},
					},
				],
				intent: {
					type: 'query',
					table: 'authors',
					select: { fields: ['id'] },
					include: [{ relation: 'posts' }],
				},
			} as any;

			const result = adapter.compileWithIncludes(plan);
			// subquery decisions generate a client-side fetch entry
			expect(result.subqueryIncludes.length).toBe(1);
			expect(result.subqueryIncludes[0]?.relationName).toBe('posts');
			expect(result.subqueryIncludes[0]?.targetTable).toBe('posts');
		});

		it('subqueryIncludes passes through includeIntent.select', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const plan = {
				rootTable: 'authors',
				decisions: [
					{
						type: 'include-strategy',
						choice: 'subquery',
						context: {
							relation: 'posts',
							target: 'posts',
							relationType: 'hasMany',
							sourceTable: 'authors',
						},
					},
				],
				intent: {
					type: 'query',
					table: 'authors',
					select: { fields: ['id'] },
					include: [
						{
							relation: 'posts',
							select: { fields: ['title', 'body'] },
						},
					],
				},
			} as any;

			const result = adapter.compileWithIncludes(plan);
			expect(result.subqueryIncludes).toHaveLength(1);
			// select is passed through from the include intent
			expect(result.subqueryIncludes[0]?.select).toEqual({
				fields: ['title', 'body'],
			});
		});

		it('subqueryIncludes passes through includeIntent.where', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const whereClause = {
				kind: 'comparison',
				field: 'active',
				operator: 'eq',
				value: true,
			};
			const plan = {
				rootTable: 'authors',
				decisions: [
					{
						type: 'include-strategy',
						choice: 'subquery',
						context: {
							relation: 'posts',
							target: 'posts',
							relationType: 'hasMany',
							sourceTable: 'authors',
						},
					},
				],
				intent: {
					type: 'query',
					table: 'authors',
					select: { fields: ['id'] },
					include: [
						{
							relation: 'posts',
							where: whereClause,
						},
					],
				},
			} as any;

			const result = adapter.compileWithIncludes(plan);
			expect(result.subqueryIncludes).toHaveLength(1);
			// where is passed through from the include intent
			expect(result.subqueryIncludes[0]?.where).toEqual(whereClause);
		});

		it('subqueryIncludes populated for belongsTo relationType', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const plan = {
				rootTable: 'posts',
				decisions: [
					{
						type: 'include-strategy',
						choice: 'subquery',
						context: {
							relation: 'author',
							target: 'users',
							relationType: 'belongsTo',
							sourceTable: 'posts',
						},
					},
				],
				intent: {
					type: 'query',
					table: 'posts',
					select: { fields: ['id'] },
					include: [{ relation: 'author' }],
				},
			} as any;

			const result = adapter.compileWithIncludes(plan);
			expect(result.subqueryIncludes).toHaveLength(1);
			expect(result.subqueryIncludes[0]?.relationType).toBe('belongsTo');
		});

		it('subqueryIncludes uses includeAlias as relationName when set', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const plan = {
				rootTable: 'posts',
				decisions: [
					{
						type: 'include-strategy',
						choice: 'subquery',
						context: {
							relation: 'author',
							includeAlias: 'authorInfo',
							target: 'users',
							relationType: 'belongsTo',
							sourceTable: 'posts',
						},
					},
				],
				intent: {
					type: 'query',
					table: 'posts',
					select: { fields: ['id'] },
					include: [{ relation: 'authorInfo' }],
				},
			} as any;

			const result = adapter.compileWithIncludes(plan);
			expect(result.subqueryIncludes).toHaveLength(1);
			expect(result.subqueryIncludes[0]?.relationName).toBe('authorInfo');
		});
	});

	describe('compileInsertFrom — coverage', () => {
		it('compiles insert-from with columns, where, limit, returning', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const result = adapter.compileInsertFrom({
				type: 'insertFrom',
				table: 'archive',
				source: 'posts',
				columns: ['id', 'title'],
				where: {
					kind: 'comparison',
					field: 'archived',
					operator: 'eq',
					value: true,
				},
				limit: 50,
				returning: ['id'],
			} as any);
			expect(result.sql).toContain('INSERT');
			expect(result.sql).toContain('LIMIT');
			expect(result.sql).toContain('RETURNING');
		});

		it('compiles insert-from without optional fields', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const result = adapter.compileInsertFrom({
				type: 'insertFrom',
				table: 'archive',
				source: 'posts',
			} as any);
			expect(result.sql).toContain('INSERT');
		});
	});

	describe('compileUpdate — range type enrichment', () => {
		it('detects range types in SET columns', () => {
			const model = {
				tables: new Map([
					[
						'events',
						{
							name: 'events',
							columns: [
								{ name: 'id', type: 'integer', nullable: false },
								{ name: 'period', type: 'tsrange', nullable: true },
							],
							primaryKey: { columns: ['id'] },
							foreignKeys: [],
							indexes: [],
						},
					],
				]),
				relations: new Map(),
				getTable: function (n) {
					return this.tables.get(n);
				},
				getRelation: () => undefined,
			} as any;

			const adapter = createPgsqlCompileOnlyAdapter({ model });
			const result = adapter.compileUpdate({
				type: 'update',
				table: 'events',
				set: { period: '[2024-01-01,2024-12-31)' },
				where: {
					kind: 'comparison',
					field: 'id',
					operator: 'eq',
					value: 1,
				},
			} as any);
			expect(result.sql).toContain('UPDATE');
		});
	});

	describe('compile — existsWrap and lock via intent', () => {
		it('propagates lock from intent', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const plan = {
				rootTable: 'jobs',
				decisions: [],
				intent: {
					type: 'query',
					table: 'jobs',
					select: { fields: ['id'] },
					lock: { strength: 'forUpdate', waitPolicy: 'block' },
				},
			} as any;

			const result = adapter.compile(plan);
			expect(result.sql).toContain('FOR UPDATE');
		});

		it('propagates existsWrap from intent', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const plan = {
				rootTable: 'users',
				decisions: [],
				intent: {
					type: 'query',
					table: 'users',
					select: { fields: ['id'] },
					existsWrap: true,
					where: {
						kind: 'comparison',
						field: 'email',
						operator: 'eq',
						value: 'test@test.com',
					},
				},
			} as any;

			const result = adapter.compile(plan);
			expect(result.sql.toLowerCase()).toContain('exists');
		});
	});

	describe('compile — unresolved exists() throws fail-closed', () => {
		it('throws when exists() relation cannot be resolved (no model configured)', () => {
			// exists() requires a declared FK relation in the schema.
			// When no model is configured and a filter-strategy was not produced
			// (planner could not resolve the relation), the adapter throws rather than
			// guessing (using the relation name as a table name with a derived FK),
			// which would produce silently wrong SQL.
			const adapter = createPgsqlCompileOnlyAdapter();
			const plan = {
				rootTable: 'posts',
				decisions: [],
				intent: {
					type: 'query',
					table: 'posts',
					select: { fields: ['id'] },
					where: {
						kind: 'exists',
						relation: 'author',
						where: {
							kind: 'comparison',
							field: 'name',
							operator: 'eq',
							value: 'Alice',
						},
					},
				},
			} as any;

			// Without a model the adapter cannot resolve 'author' — it must throw.
			// Use rawExists(subquery(...)) for EXISTS over uncorrelated/undeclared targets.
			expect(() => adapter.compile(plan)).toThrow(
				/exists\('author'\).*cannot resolve relation 'author'.*no model/i,
			);
		});
	});

	describe('constructor — direct PoolClient compatibility', () => {
		it('refuses a client that was not declared as borrowed', () => {
			// A checked-out client belongs to whoever checked it out. Passing one used
			// to be enough for the adapter to assume it was inside a transaction; the
			// caller has to say so now.
			const fakeClient = {
				release: () => {},
				query: async () => ({ rows: [] }),
			} as any;

			expect(() => new PgsqlAdapter(fakeClient)).toThrow(
				/borrowedClient: true/,
			);
		});

		it('runs no transaction on a borrowed client unless asked to manage one', async () => {
			const fakeClient = {
				release: () => {},
				query: async () => ({ rows: [] }),
				_txStatus: 'I',
			} as any;

			const adapter = new PgsqlAdapter(fakeClient, { borrowedClient: true });
			expect(adapter.capabilities.supportsStreaming).toBe(false);
			expect(adapter.capabilities.supportsTransactions).toBe(false);
			expect(adapter.inTransaction).toBe(false);
			await expect(adapter.transaction(async () => 'inline')).rejects.toThrow(
				/managedTransactions: true/,
			);
		});
	});
});
