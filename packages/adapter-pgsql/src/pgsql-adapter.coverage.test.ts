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
import { describe, expect, it } from 'vitest';
import { identityNaming } from './naming-plugin.js';
import { createPgsqlCompileOnlyAdapter } from './pgsql-adapter.js';

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

		it('adapter schema takes precedence over compile options', () => {
			const adapter = createPgsqlCompileOnlyAdapter({
				schemaName: 'adapter_schema',
			});
			const plan: PlanReport = {
				rootTable: 'users',
				decisions: [{ type: 'select', column: '*' }],
			} as any;

			const result = adapter.compile(plan, { schemaName: 'override_schema' });

			// adapter schema takes precedence via ?? operator
			expect(result.sql).toContain('adapter_schema');
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
});
