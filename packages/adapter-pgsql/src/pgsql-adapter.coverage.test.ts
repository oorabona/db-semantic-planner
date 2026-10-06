// @ts-nocheck — coverage test: runtime assertions on AST nodes
import { plan as nativePlan, POSTGRESQL_CAPABILITIES } from '@dbsp/core';
/**
 * Coverage tests for pgsql-adapter.ts.
 *
 * Focus: Branch coverage for PgAdapter including:
 * - createPgCompileOnlyAdapter() with default and custom options
 * - compile() with various decision types
 * - compile() with schema scoping
 * - withSchema() adapter cloning
 * - dialectCapabilities property
 * - Custom options: defaultPkColumnName, deriveFkColumnName
 * - Adapter capabilities (execution/streaming support)
 */

import { ref, schema } from '@dbsp/core';
import type { ModelIR, PlanReport } from '@dbsp/types';
import { projectionlessCompiledQuery } from '@dbsp/types/adapter-sdk';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter, PgAdapter } from './pgsql-adapter.js';
import { createPgPhysicalModel } from './physical-model/index.js';

function completeModel(
	definition: Record<string, Record<string, unknown>>,
): ModelIR {
	return schema(definition as any).model;
}

const coverageModel = completeModel({
	orders: { user_id: 'integer' },
	jobs: { id: 'integer' },
	items: { id: 'integer' },
	users: {
		id: { type: 'integer', primaryKey: true },
		name: 'text',
		email: 'text',
		active: 'boolean',
	},
	categories: {
		id: 'integer',
		parent_id: 'integer',
		name: 'text',
		active: 'boolean',
	},
	nodes: {
		id: 'integer',
		name: 'text',
		active: 'boolean',
		x: 'integer',
		y: 'integer',
	},
	edges: { id: 'integer', from_id: 'integer', to_id: 'integer' },
	staging_users: {
		id: 'integer',
		name: 'text',
		email: 'text',
		active: 'boolean',
	},
	archive_users: { id: 'integer', name: 'text', email: 'text' },
	staging: { id: 'integer', name: 'text', email: 'text', active: 'boolean' },
	posts: {
		id: 'integer',
		title: 'text',
		archived: 'boolean',
		user_id: ref('users', { as: 'author' }),
	},
	archive: { id: 'integer', title: 'text' },
});
function testQuery<T = unknown>(
	sql: string,
	parameters: readonly unknown[] = [],
) {
	return projectionlessCompiledQuery<T>(
		{ sql, parameters },
		'pgsql-adapter-coverage-test',
	);
}

describe('PgAdapter - Coverage Tests', () => {
	describe('createPgCompileOnlyAdapter', () => {
		it('creates adapter with default options', () => {
			const adapter = createPgCompileOnlyAdapter();

			expect(adapter).toBeDefined();
			expect(adapter.dbCasing).toBe('preserve');
			expect(adapter.capabilities.supportsReturning).toBe(true);
			expect(adapter.capabilities.supportsStreaming).toBe(false);
		});

		it('creates adapter with custom dbCasing', () => {
			const adapter = createPgCompileOnlyAdapter({
				dbCasing: 'snake_case',
			});

			expect(adapter.dbCasing).toBe('snake_case');
		});

		it('creates adapter with schemaName option', () => {
			const adapter = createPgCompileOnlyAdapter({
				schemaName: 'tenant_xyz',
			});

			// Schema name is stored internally
			expect(adapter).toBeDefined();
		});

		it('creates adapter with defaultPkColumnName option', () => {
			const adapter = createPgCompileOnlyAdapter({
				defaultPkColumnName: 'uuid',
			});

			expect(adapter).toBeDefined();
		});

		it('creates adapter with custom deriveFkColumnName function', () => {
			const customDerivation = (tableName: string, pkName: string) =>
				`${tableName}_${pkName}_fk`;

			const adapter = createPgCompileOnlyAdapter({
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

			const adapter = createPgCompileOnlyAdapter({
				logger: mockLogger,
			});

			expect(adapter).toBeDefined();
		});
	});

	describe('dialectCapabilities', () => {
		it('returns PostgreSQL capabilities', () => {
			const adapter = createPgCompileOnlyAdapter();
			const caps = adapter.dialectCapabilities;

			expect(caps).toBeDefined();
			expect(caps.supportsJsonAgg).toBe(true);
			expect(caps.supportsLateralJoin).toBe(true);
			expect(caps.supportsRecursiveCTE).toBe(true);
		});
	});

	describe('capabilities', () => {
		it('compile-only adapter reports no execution support', () => {
			const adapter = createPgCompileOnlyAdapter();

			expect(adapter.capabilities.supportsReturning).toBe(true);
			expect(adapter.capabilities.supportsStreaming).toBe(false);
		});

		it('compile-only adapter reports schema support', () => {
			const adapter = createPgCompileOnlyAdapter();

			expect(adapter.capabilities.supportsSchemas).toBe(true);
		});
	});

	describe('compile - basic SELECT', () => {
		it('compiles minimal SELECT plan', () => {
			const adapter = createPgCompileOnlyAdapter();
			const plan: PlanReport = nativePlan(
				{ type: 'select', from: 'users' },
				coverageModel,
				{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
			);

			const result = adapter.compile(plan);

			expect(result.sql).toContain('SELECT');
			expect(result.sql).toContain('users');
			expect(Array.isArray(result.parameters)).toBe(true);
		});

		it('compiles SELECT with specific columns', () => {
			const adapter = createPgCompileOnlyAdapter();
			const plan: PlanReport = nativePlan(
				{
					type: 'select',
					from: 'users',
					select: { type: 'fields', fields: ['id', 'name'] },
				},
				coverageModel,
				{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
			);

			const result = adapter.compile(plan);

			expect(result.sql).toContain('SELECT');
			expect(result.parameters).toEqual([]);
		});
	});

	describe('compile - schema scoping', () => {
		it('includes schema from adapter options', () => {
			const adapter = createPgCompileOnlyAdapter({
				schemaName: 'tenant_123',
			});
			const plan: PlanReport = nativePlan(
				{ type: 'select', from: 'users' },
				coverageModel,
				{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
			);

			const result = adapter.compile(plan);

			expect(result.sql).toContain('tenant_123');
		});

		it('includes schema from compile options', () => {
			const adapter = createPgCompileOnlyAdapter();
			const plan: PlanReport = nativePlan(
				{ type: 'select', from: 'users' },
				coverageModel,
				{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
			);

			const result = adapter.compile(plan, { schemaName: 'custom_schema' });

			expect(result.sql).toContain('custom_schema');
		});

		it('compile options schemaName takes precedence over adapter constructor schemaName', () => {
			const adapter = createPgCompileOnlyAdapter({
				schemaName: 'adapter_schema',
			});
			const plan: PlanReport = nativePlan(
				{ type: 'select', from: 'users' },
				coverageModel,
				{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
			);

			const result = adapter.compile(plan, { schemaName: 'override_schema' });

			// options.schemaName takes precedence over adapter constructor schemaName.
			// buildCompileDeps() uses || (not ??) for schemaName: empty string falls through
			// to the adapter constructor value. For model it still uses ?? (empty model is meaningful).
			expect(result.sql).toContain('override_schema');
		});

		it('compile options schemaName empty string falls through to adapter constructor schemaName', () => {
			const adapter = createPgCompileOnlyAdapter({
				schemaName: 'adapter_default',
			});
			const plan: PlanReport = nativePlan(
				{ type: 'select', from: 'users' },
				coverageModel,
				{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
			);

			const result = adapter.compile(plan, { schemaName: '' });

			// Empty string should NOT win; constructor schemaName wins via `||`
			expect(result.sql).toContain('adapter_default');
			expect(result.sql).not.toContain('"".');
		});
	});

	describe('compile - schemaName validation in options', () => {
		it('rejects malicious schemaName via compile options (SQL injection)', () => {
			const adapter = createPgCompileOnlyAdapter();
			const plan: PlanReport = nativePlan(
				{ type: 'select', from: 'users' },
				coverageModel,
				{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
			);

			expect(() =>
				adapter.compile(plan, { schemaName: 'x"; DROP TABLE users--' }),
			).toThrow(/[Ii]nvalid|identifier/);
		});

		it('rejects schemaName with semicolon via compile options', () => {
			const adapter = createPgCompileOnlyAdapter();
			const plan: PlanReport = nativePlan(
				{ type: 'select', from: 'users' },
				coverageModel,
				{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
			);

			expect(() => adapter.compile(plan, { schemaName: 'bad;schema' })).toThrow(
				/[Ii]nvalid|identifier/,
			);
		});

		it('accepts valid identifier in options.schemaName', () => {
			const adapter = createPgCompileOnlyAdapter();
			const plan: PlanReport = nativePlan(
				{ type: 'select', from: 'users' },
				coverageModel,
				{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
			);

			const result = adapter.compile(plan, { schemaName: 'tenant_42' });
			expect(result.sql).toContain('tenant_42');
		});
	});

	describe('compile - DISTINCT', () => {
		it('compiles SELECT DISTINCT', () => {
			const adapter = createPgCompileOnlyAdapter();
			const plan: PlanReport = nativePlan(
				{
					type: 'select',
					from: 'users',
					distinct: true,
					select: { type: 'fields', fields: ['email'] },
				},
				coverageModel,
				{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
			);

			const result = adapter.compile(plan);

			expect(result.sql.toLowerCase()).toContain('distinct');
		});
	});

	describe('compile - ORDER BY', () => {
		it('compiles ORDER BY ASC', () => {
			const adapter = createPgCompileOnlyAdapter();
			const plan: PlanReport = nativePlan(
				{
					type: 'select',
					from: 'users',
					orderBy: [{ field: 'name', direction: 'asc' }],
				},
				coverageModel,
				{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
			);

			const result = adapter.compile(plan);

			expect(result.sql.toLowerCase()).toContain('order by');
		});

		it('compiles ORDER BY DESC', () => {
			const adapter = createPgCompileOnlyAdapter();
			const plan: PlanReport = nativePlan(
				{
					type: 'select',
					from: 'users',
					orderBy: [{ field: 'created_at', direction: 'desc' }],
				},
				coverageModel,
				{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
			);

			const result = adapter.compile(plan);

			expect(result.sql.toLowerCase()).toContain('order by');
			expect(result.sql.toLowerCase()).toContain('desc');
		});
	});

	describe('compile - LIMIT and OFFSET', () => {
		it('compiles LIMIT', () => {
			const adapter = createPgCompileOnlyAdapter();
			const plan: PlanReport = nativePlan(
				{ type: 'select', from: 'users', limit: 10 },
				coverageModel,
				{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
			);

			const result = adapter.compile(plan);

			expect(result.sql.toLowerCase()).toContain('limit');
		});

		it('compiles OFFSET', () => {
			const adapter = createPgCompileOnlyAdapter();
			const plan: PlanReport = nativePlan(
				{ type: 'select', from: 'users', offset: 20 },
				coverageModel,
				{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
			);

			const result = adapter.compile(plan);

			expect(result.sql.toLowerCase()).toContain('offset');
		});

		it('compiles LIMIT and OFFSET together', () => {
			const adapter = createPgCompileOnlyAdapter();
			const plan: PlanReport = nativePlan(
				{ type: 'select', from: 'users', limit: 10, offset: 20 },
				coverageModel,
				{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
			);

			const result = adapter.compile(plan);

			expect(result.sql.toLowerCase()).toContain('limit');
			expect(result.sql.toLowerCase()).toContain('offset');
		});
	});

	describe('compile - WHERE with parameters', () => {
		it('compiles WHERE clause with parameterized value', () => {
			const adapter = createPgCompileOnlyAdapter();
			const plan: PlanReport = nativePlan(
				{
					type: 'select',
					from: 'users',
					where: {
						kind: 'comparison',
						field: 'active',
						operator: 'eq',
						value: true,
					},
				},
				coverageModel,
				{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
			);

			const result = adapter.compile(plan);

			expect(result.sql.toLowerCase()).toContain('where');
			expect(result.parameters.length).toBeGreaterThan(0);
		});

		it('compiles WHERE with multiple conditions', () => {
			const adapter = createPgCompileOnlyAdapter();
			const plan: PlanReport = nativePlan(
				{
					type: 'select',
					from: 'users',
					where: {
						kind: 'and',
						conditions: [
							{
								kind: 'comparison',
								field: 'active',
								operator: 'eq',
								value: true,
							},
							{ kind: 'comparison', field: 'age', operator: 'gt', value: 18 },
						],
					},
				},
				coverageModel,
				{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
			);

			const result = adapter.compile(plan);

			expect(result.sql.toLowerCase()).toContain('where');
		});
	});

	describe('compile - GROUP BY', () => {
		it('compiles GROUP BY', () => {
			const adapter = createPgCompileOnlyAdapter();
			const plan: PlanReport = nativePlan(
				{
					type: 'select',
					from: 'orders',
					groupBy: ['user_id'],
					select: { type: 'fields', fields: ['user_id'] },
				},
				coverageModel,
				{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
			);

			const result = adapter.compile(plan);

			expect(result.sql.toLowerCase()).toContain('group by');
		});
	});

	describe('withSchema', () => {
		it('returns new adapter with schema scope', () => {
			const adapter = createPgCompileOnlyAdapter();
			const scopedAdapter = adapter.withSchema('tenant_456');

			expect(scopedAdapter).toBeDefined();
			expect(scopedAdapter).not.toBe(adapter);
		});

		it('schema-scoped adapter includes schema in compiled SQL', () => {
			const adapter = createPgCompileOnlyAdapter();
			const scopedAdapter = adapter.withSchema('tenant_456');

			const plan: PlanReport = nativePlan(
				{ type: 'select', from: 'users' },
				coverageModel,
				{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
			);

			const result = scopedAdapter.compile(plan);

			expect(result.sql).toContain('tenant_456');
		});

		it('validates schema identifier', () => {
			const adapter = createPgCompileOnlyAdapter();

			// Invalid schema name with SQL injection attempt
			expect(() => adapter.withSchema('tenant"; DROP TABLE users--')).toThrow();
		});

		it('preserves dbCasing in scoped adapter', () => {
			const adapter = createPgCompileOnlyAdapter({
				dbCasing: 'snake_case',
			});
			const scopedAdapter = adapter.withSchema('tenant_789');

			expect(scopedAdapter.dbCasing).toBe('snake_case');
		});
	});

	describe('compile options - custom PK and FK derivation', () => {
		it('uses custom defaultPkColumnName', () => {
			const adapter = createPgCompileOnlyAdapter({
				defaultPkColumnName: 'uuid',
			});

			// This would be exercised in FK resolution scenarios
			expect(adapter).toBeDefined();
		});

		it('uses custom deriveFkColumnName function', () => {
			const customFn = (tableName: string, pkName: string) =>
				`${tableName}_${pkName}_custom`;

			const adapter = createPgCompileOnlyAdapter({
				deriveFkColumnName: customFn,
			});

			// This would be exercised in FK resolution scenarios
			expect(adapter).toBeDefined();
		});
	});

	describe('compile with model option', () => {
		it('passes model to compile function', () => {
			const adapter = createPgCompileOnlyAdapter();
			const mockModel = coverageModel;

			const plan: PlanReport = nativePlan(
				{ type: 'select', from: 'users' },
				coverageModel,
				{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
			);

			const result = adapter.compile(plan, { model: mockModel as any });

			expect(result.sql).toContain('SELECT');
		});
	});

	describe('compile - edge cases', () => {
		it('compiles plan without decisions array', () => {
			const adapter = createPgCompileOnlyAdapter();
			const plan: PlanReport = nativePlan(
				{ type: 'select', from: 'users' },
				coverageModel,
				{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
			);

			const result = adapter.compile(plan);

			// Should still produce valid SQL
			expect(result.sql).toContain('SELECT');
		});

		it('compiles plan with intent object', () => {
			const adapter = createPgCompileOnlyAdapter();
			const plan: PlanReport = nativePlan(
				{
					type: 'select',
					from: 'users',
					select: { type: 'all' },
				},
				coverageModel,
				{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
			);

			const result = adapter.compile(plan);

			expect(result.sql).toContain('SELECT');
		});
	});

	describe('multiple options combinations', () => {
		it('creates adapter with all options', () => {
			const adapter = createPgCompileOnlyAdapter({
				schemaName: 'tenant_full',
				dbCasing: 'camelCase',
				defaultPkColumnName: 'id',
				deriveFkColumnName: (t, p) => `${t}_${p}`,
			});

			expect(adapter).toBeDefined();
			expect(adapter.dbCasing).toBe('camelCase');
		});

		it('refuses non-preserve compilation without a model', () => {
			const adapter = createPgCompileOnlyAdapter({
				schemaName: 'tenant_all',
				dbCasing: 'snake_case',
			});

			const plan: PlanReport = nativePlan(
				{ type: 'select', from: 'users' },
				coverageModel,
				{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
			);

			expect(() => adapter.compile(plan)).toThrow(
				"PgAdapter compilation with dbCasing 'snake_case' requires a ModelIR",
			);
		});
	});

	// ==================================================================
	// NEW COVERAGE TESTS — mutation compilation, recursive, lock modes,
	// subquery includes, error paths, schema scoping edges
	// ==================================================================

	describe('compileInsert', () => {
		it('compiles a basic INSERT with single row', () => {
			const adapter = createPgCompileOnlyAdapter({ model: coverageModel });
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
			const adapter = createPgCompileOnlyAdapter({ model: coverageModel });
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
			const adapter = createPgCompileOnlyAdapter({
				model: coverageModel,
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
			const adapter = createPgCompileOnlyAdapter({ model: coverageModel });
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
			const adapter = createPgCompileOnlyAdapter({
				model: coverageModel,
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
			const adapter = createPgCompileOnlyAdapter({ model: coverageModel });
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

		it('refuses INSERT with empty values array', () => {
			const adapter = createPgCompileOnlyAdapter({ model: coverageModel });
			const intent = {
				table: 'users',
				values: [],
			};
			expect(() => adapter.compileInsert(intent as any)).toThrow(
				'Invalid insert: insert: values requires at least one row',
			);
		});

		it('refuses INSERT with undefined values', () => {
			const adapter = createPgCompileOnlyAdapter({ model: coverageModel });
			const intent = {
				table: 'users',
			};
			expect(() => adapter.compileInsert(intent as any)).toThrow(
				'Invalid insert: insert: values requires at least one row',
			);
		});
	});

	describe('compileUpdate', () => {
		it('compiles a basic UPDATE', () => {
			const adapter = createPgCompileOnlyAdapter({ model: coverageModel });
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
			const adapter = createPgCompileOnlyAdapter({ model: coverageModel });
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
			const adapter = createPgCompileOnlyAdapter({ model: coverageModel });
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
			const adapter = createPgCompileOnlyAdapter({
				model: coverageModel,
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
			const adapter = createPgCompileOnlyAdapter({ model: coverageModel });
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
			const adapter = createPgCompileOnlyAdapter({ model: coverageModel });
			const intent = { table: 'users' };
			const result = adapter.compileDelete(intent as any);
			const sql = result.sql.toLowerCase();
			expect(sql).toContain('delete');
			expect(sql).toContain('users');
		});

		it('compiles DELETE with WHERE clause', () => {
			const adapter = createPgCompileOnlyAdapter({ model: coverageModel });
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
			const adapter = createPgCompileOnlyAdapter({ model: coverageModel });
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
			const adapter = createPgCompileOnlyAdapter({
				model: coverageModel,
				schemaName: 'tenant_del',
			});
			const intent = { table: 'users' };
			const result = adapter.compileDelete(intent as any);
			expect(result.sql).toContain('tenant_del');
		});

		it('compiles DELETE with schema from compile options', () => {
			const adapter = createPgCompileOnlyAdapter({ model: coverageModel });
			const intent = { table: 'users' };
			const result = adapter.compileDelete(intent as any, {
				schemaName: 'del_schema',
			});
			expect(result.sql).toContain('del_schema');
		});
	});

	describe('compileUpsert', () => {
		it('compiles upsert with doNothing action', () => {
			const adapter = createPgCompileOnlyAdapter({ model: coverageModel });
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
			const adapter = createPgCompileOnlyAdapter({ model: coverageModel });
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
			const adapter = createPgCompileOnlyAdapter({ model: coverageModel });
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
			const adapter = createPgCompileOnlyAdapter({ model: coverageModel });
			const intent = {
				table: 'users',
				values: [{ id: 1, name: 'Alice' }],
				onConflict: { constraint: 'pk_users' },
				action: { type: 'doNothing' },
			};
			const result = adapter.compileUpsert(intent as any);
			const sql = result.sql.toLowerCase();
			expect(sql).toContain('on conflict');
		});

		it('compiles upsert with RETURNING', () => {
			const adapter = createPgCompileOnlyAdapter({ model: coverageModel });
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
			const adapter = createPgCompileOnlyAdapter({
				model: coverageModel,
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
			const adapter = createPgCompileOnlyAdapter({ model: coverageModel });
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
			const adapter = createPgCompileOnlyAdapter({ model: coverageModel });
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
			const adapter = createPgCompileOnlyAdapter({ model: coverageModel });
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
			const adapter = createPgCompileOnlyAdapter({ model: coverageModel });
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
			const adapter = createPgCompileOnlyAdapter({
				model: coverageModel,
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
			const adapter = createPgCompileOnlyAdapter({ model: coverageModel });
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
			const adapter = createPgCompileOnlyAdapter({ model: coverageModel });
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
			const adapter = createPgCompileOnlyAdapter({
				model: coverageModel,
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
			const adapter = createPgCompileOnlyAdapter();
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
			const model = coverageModel;
			const result = adapter.compileRecursive(report as any, model);
			const sql = result.sql.toLowerCase();
			expect(sql).toContain('with recursive');
			expect(sql).toContain('categories');
		});

		it('compiles adjacency-list ancestor traversal', () => {
			const adapter = createPgCompileOnlyAdapter();
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
			const result = adapter.compileRecursive(report as any, coverageModel);
			const sql = result.sql.toLowerCase();
			expect(sql).toContain('with recursive');
		});

		it('compiles edge-table traversal', () => {
			const adapter = createPgCompileOnlyAdapter();
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
			const result = adapter.compileRecursive(report as any, coverageModel);
			const sql = result.sql.toLowerCase();
			expect(sql).toContain('with recursive');
			expect(sql).toContain('edges');
		});

		it('compiles edge-table with bidirectional direction', () => {
			const adapter = createPgCompileOnlyAdapter();
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
			const result = adapter.compileRecursive(report as any, coverageModel);
			const sql = result.sql.toLowerCase();
			expect(sql).toContain('with recursive');
		});

		it('compiles recursive with track depth', () => {
			const adapter = createPgCompileOnlyAdapter();
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
			const result = adapter.compileRecursive(report as any, coverageModel);
			expect(result.sql).toContain('level');
		});

		it('compiles recursive with track path', () => {
			const adapter = createPgCompileOnlyAdapter();
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
			const result = adapter.compileRecursive(report as any, coverageModel);
			expect(result.sql).toContain('trail');
		});

		it('compiles recursive with schema scoping', () => {
			const adapter = createPgCompileOnlyAdapter({
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
			const result = adapter.compileRecursive(report as any, coverageModel);
			expect(result.sql).toContain('tenant_rec');
		});

		it('throws for unsupported traversal kind', () => {
			const adapter = createPgCompileOnlyAdapter();
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
			expect(() =>
				adapter.compileRecursive(report as any, coverageModel),
			).toThrow(/Unsupported traversal kind/);
		});

		it('compiles edge-table with anchor WHERE', () => {
			const adapter = createPgCompileOnlyAdapter();
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
			const result = adapter.compileRecursive(report as any, coverageModel);
			expect(result.sql).toBeDefined();
		});

		it('compiles edge-table with "in" direction (swaps edgeFrom/edgeTo)', () => {
			const adapter = createPgCompileOnlyAdapter();
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
			const result = adapter.compileRecursive(report as any, coverageModel);
			expect(result.sql).toBeDefined();
		});
	});

	describe('buildRecursiveAnchorWhere - edge cases', () => {
		it('handles AND condition with single item', () => {
			const adapter = createPgCompileOnlyAdapter();
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
			const result = adapter.compileRecursive(report as any, coverageModel);
			expect(result.sql).toBeDefined();
		});

		it('handles OR condition with multiple items', () => {
			const adapter = createPgCompileOnlyAdapter();
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
			const result = adapter.compileRecursive(report as any, coverageModel);
			expect(result.sql).toBeDefined();
		});

		it('refuses unknown recursive anchor kind', () => {
			const adapter = createPgCompileOnlyAdapter();
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
			expect(() =>
				adapter.compileRecursive(report as any, coverageModel),
			).toThrow(/recursive start\.where.*unknown_kind/);
		});

		it('handles null/undefined where with fallback to TRUE', () => {
			const adapter = createPgCompileOnlyAdapter();
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
			const result = adapter.compileRecursive(report as any, coverageModel);
			expect(result.sql).toBeDefined();
		});
	});

	describe('createDump', () => {
		it('creates a dump with minimal meta', () => {
			const adapter = createPgCompileOnlyAdapter();
			const plan = { rootTable: 'users', decisions: [] } as any;
			const query = testQuery('SELECT 1');
			const dump = adapter.createDump(plan, query);

			expect(dump.sql).toBe('SELECT 1');
			expect(dump.params).toEqual([]);
			expect(dump.plan).toBe(plan);
			expect(dump.meta?.compiledAt).toBeInstanceOf(Date);
		});

		it('creates dump with schema in meta', () => {
			const adapter = createPgCompileOnlyAdapter({
				schemaName: 'tenant_dump',
			});
			const plan = { rootTable: 'users', decisions: [] } as any;
			const query = testQuery('SELECT 1');
			const dump = adapter.createDump(plan, query);

			expect(dump.meta?.schema).toBe('tenant_dump');
		});

		it('creates dump with custom meta overrides', () => {
			const adapter = createPgCompileOnlyAdapter();
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
			const adapter = createPgCompileOnlyAdapter();
			await expect(adapter.execute(testQuery('SELECT 1'))).rejects.toThrow(
				/constructed without a connection/,
			);
		});

		it('throws on executeOne', async () => {
			const adapter = createPgCompileOnlyAdapter();
			await expect(adapter.executeOne(testQuery('SELECT 1'))).rejects.toThrow(
				/constructed without a connection/,
			);
		});

		it('throws on executeRaw', async () => {
			const adapter = createPgCompileOnlyAdapter();
			await expect(adapter.executeRaw('SELECT 1')).rejects.toThrow(
				/constructed without a connection/,
			);
		});

		it('throws on getPoolInstance', () => {
			const adapter = createPgCompileOnlyAdapter();
			expect(() => adapter.getPoolInstance()).toThrow(
				/constructed without a connection/,
			);
		});

		it('throws on introspect', async () => {
			const adapter = createPgCompileOnlyAdapter();
			await expect(adapter.introspect()).rejects.toThrow(
				/constructed without a connection/,
			);
		});

		it('throws on transaction', async () => {
			const adapter = createPgCompileOnlyAdapter();
			await expect(adapter.transaction(async () => 'x')).rejects.toThrow(
				/constructed without a connection/,
			);
		});

		it('stream throws on a connectionless adapter', async () => {
			const adapter = createPgCompileOnlyAdapter();
			const iter = adapter.stream(testQuery('SELECT 1'));
			// The generator should throw when iterated
			await expect(iter.next()).rejects.toThrow(
				/constructed without a connection/,
			);
		});
	});

	describe('validateIdentifier', () => {
		it('accepts valid identifier', () => {
			const adapter = createPgCompileOnlyAdapter();
			expect(() => adapter.validateIdentifier('users', 'table')).not.toThrow();
		});

		it('rejects SQL injection in identifier', () => {
			const adapter = createPgCompileOnlyAdapter();
			expect(() =>
				adapter.validateIdentifier('users"; DROP TABLE--', 'table'),
			).toThrow();
		});
	});

	describe('compile - lock mode variants', () => {
		it('compiles FOR UPDATE via legacy plan', () => {
			const adapter = createPgCompileOnlyAdapter();
			const plan = nativePlan(
				{
					type: 'select',
					from: 'jobs',
					select: { type: 'all' },
					lock: { strength: 'forUpdate', waitPolicy: 'block' },
				},
				coverageModel,
				{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
			);
			const result = adapter.compile(plan);
			const sql = result.sql.toLowerCase();
			expect(sql).toContain('for update');
		});

		it('compiles FOR SHARE with skipLocked via intent', () => {
			const adapter = createPgCompileOnlyAdapter();
			const plan = nativePlan(
				{
					type: 'select',
					from: 'jobs',
					select: { type: 'all' },
					lock: { strength: 'forShare', waitPolicy: 'skipLocked' },
				},
				coverageModel,
				{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
			);
			const result = adapter.compile(plan);
			const sql = result.sql.toLowerCase();
			expect(sql).toContain('for share');
			expect(sql).toContain('skip locked');
		});

		it('compiles FOR NO KEY UPDATE with noWait via intent', () => {
			const adapter = createPgCompileOnlyAdapter();
			const plan = nativePlan(
				{
					type: 'select',
					from: 'items',
					select: { type: 'all' },
					lock: { strength: 'forNoKeyUpdate', waitPolicy: 'noWait' },
				},
				coverageModel,
				{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
			);
			const result = adapter.compile(plan);
			const sql = result.sql.toLowerCase();
			expect(sql).toContain('for no key update');
			expect(sql).toContain('nowait');
		});

		it('compiles FOR KEY SHARE via intent', () => {
			const adapter = createPgCompileOnlyAdapter();
			const plan = nativePlan(
				{
					type: 'select',
					from: 'posts',
					select: { type: 'all' },
					lock: { strength: 'forKeyShare', waitPolicy: 'block' },
				},
				coverageModel,
				{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
			);
			const result = adapter.compile(plan);
			const sql = result.sql.toLowerCase();
			expect(sql).toContain('for key share');
		});
	});

	describe('compile - existsWrap via intent', () => {
		it('wraps select in EXISTS when intent has existsWrap', () => {
			const adapter = createPgCompileOnlyAdapter();
			const plan = nativePlan(
				{
					type: 'select',
					from: 'users',
					select: { type: 'all' },
					existsWrap: true,
				},
				coverageModel,
				{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
			);
			const result = adapter.compile(plan);
			const sql = result.sql.toLowerCase();
			expect(sql).toContain('exists');
		});
	});

	describe('compile - dbCasing variants', () => {
		it('refuses snake_case naming without a model', () => {
			const adapter = createPgCompileOnlyAdapter({
				dbCasing: 'snake_case',
			});
			const plan = nativePlan(
				{ type: 'select', from: 'users' },
				coverageModel,
				{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
			);
			expect(() => adapter.compile(plan)).toThrow('requires a ModelIR');
		});

		it('refuses camelCase naming without a model', () => {
			const adapter = createPgCompileOnlyAdapter({
				dbCasing: 'camelCase',
			});
			const plan = nativePlan(
				{ type: 'select', from: 'users' },
				coverageModel,
				{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
			);
			expect(() => adapter.compile(plan)).toThrow('requires a ModelIR');
		});

		it('refuses INSERT compilation without a model', () => {
			const adapter = createPgCompileOnlyAdapter({ dbCasing: 'snake_case' });
			expect(() =>
				adapter.compileInsert({ table: 'users', values: [{ id: 1 }] } as any),
			).toThrow('requires a ModelIR');
		});

		it('refuses INSERT FROM compilation without a model', () => {
			const adapter = createPgCompileOnlyAdapter({ dbCasing: 'snake_case' });
			expect(() =>
				adapter.compileInsertFrom({ table: 'users' } as any),
			).toThrow('requires a ModelIR');
		});

		it('refuses UPDATE compilation without a model', () => {
			const adapter = createPgCompileOnlyAdapter({ dbCasing: 'snake_case' });
			expect(() => adapter.compileUpdate({ table: 'users' } as any)).toThrow(
				'requires a ModelIR',
			);
		});

		it('refuses batch UPDATE compilation without a model', () => {
			const adapter = createPgCompileOnlyAdapter({ dbCasing: 'snake_case' });
			expect(() =>
				adapter.compileBatchUpdate({ table: 'users' } as any),
			).toThrow('requires a ModelIR');
		});

		it('refuses DELETE compilation without a model', () => {
			const adapter = createPgCompileOnlyAdapter({ dbCasing: 'snake_case' });
			expect(() => adapter.compileDelete({ table: 'users' } as any)).toThrow(
				'requires a ModelIR',
			);
		});

		it('refuses UPSERT compilation without a model', () => {
			const adapter = createPgCompileOnlyAdapter({ dbCasing: 'snake_case' });
			expect(() =>
				adapter.compileUpsert({
					table: 'users',
					values: [{ id: 1 }],
					onConflict: { columns: [] },
					action: { type: 'doNothing' },
				} as any),
			).toThrow('requires a ModelIR');
		});

		it('refuses UPSERT FROM compilation without a model', () => {
			const adapter = createPgCompileOnlyAdapter({ dbCasing: 'snake_case' });
			expect(() =>
				adapter.compileUpsertFrom({
					table: 'users',
					source: 'users_import',
					conflictColumns: [],
					sourceQuery: {} as any,
				} as any),
			).toThrow('requires a ModelIR');
		});
	});

	describe('generateDDL', () => {
		it('generates DDL from a simple model', () => {
			const adapter = createPgCompileOnlyAdapter();
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
							primaryKey: 'id',
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

			const ddl = adapter.generateDDL(
				createPgPhysicalModel({ mode: 'logical', model, schema: 'public' }),
			);
			expect(ddl.length).toBeGreaterThan(0);
			expect(ddl.some((s) => s.toLowerCase().includes('create table'))).toBe(
				true,
			);
		});

		it('generates DDL with schema name', () => {
			const adapter = createPgCompileOnlyAdapter({
				schemaName: 'tenant_ddl',
			});
			const model = {
				tables: new Map([
					[
						'users',
						{
							name: 'users',
							columns: [{ name: 'id', type: 'integer', nullable: false }],
							primaryKey: 'id',
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

			const ddl = adapter.generateDDL(
				createPgPhysicalModel({
					mode: 'logical',
					model,
					schema: 'tenant_ddl',
				}),
			);
			expect(ddl.some((s) => s.includes('tenant_ddl'))).toBe(true);
		});
	});

	// ==========================================================================
	// NEW COVERAGE: intent-based compile path branches
	// ==========================================================================

	describe('compile — intent path with model (column validation)', () => {
		it('throws when include has invalid columns in target table', () => {
			const model = schema({
				posts: {
					id: { type: 'integer', primaryKey: true },
					author_id: ref('users', { as: 'author' }),
				},
				users: { id: { type: 'integer', primaryKey: true }, name: 'text' },
			}).model;

			// Use intent path: plan.intent triggers intentToDecisions which produces
			// selectRelationColumn decisions. plan.decisions contains planner output
			// (include-strategy) consumed by extractAllIncludeDecisions.
			const adapter = createPgCompileOnlyAdapter({ model });
			const plan = nativePlan(
				{
					type: 'select',
					from: 'posts',
					include: [{ relation: 'author' }],
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
				adapter.model,
				{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
			);

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
							primaryKey: 'id',
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

			const adapter = createPgCompileOnlyAdapter({ model });
			const plan = nativePlan(
				{
					type: 'select',
					from: 'events',
					select: { type: 'fields', fields: ['id'] },
					where: {
						kind: 'range',
						field: 'period',
						operator: 'contains',
						value: '2024-01-01',
					},
				},
				model,
				{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
			);

			// Should not throw — enrichment adds dataType to the decision
			const result = adapter.compile(plan, { model });
			expect(result.sql).toContain('SELECT');
		});
	});

	describe('compile — intent path with relationColumnsMap', () => {
		it('deduplicates selectRelationColumn when covered by include', () => {
			const adapter = createPgCompileOnlyAdapter({ model: coverageModel });
			const plan = nativePlan(
				{
					type: 'select',
					from: 'posts',
					select: {
						type: 'expressions',
						columns: [
							{ kind: 'column', column: 'id' },
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
				adapter.model,
				{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
			);

			const result = adapter.compile(plan);
			expect(result.sql).toContain('SELECT');
		});

		it('keeps selectRelationColumn when no include covers the relation', () => {
			const adapter = createPgCompileOnlyAdapter({ model: coverageModel });
			const plan = nativePlan(
				{
					type: 'select',
					from: 'posts',
					select: {
						fields: [
							'id',
							{ kind: 'relationColumn', relation: 'author', column: 'name' },
						],
					},
				},
				coverageModel,
				{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
			);

			const result = adapter.compile(plan);
			expect(result.sql).toContain('SELECT');
		});

		it('handles wildcard column in selectRelationColumn dedup', () => {
			const adapter = createPgCompileOnlyAdapter({ model: coverageModel });
			const plan = nativePlan(
				{
					type: 'select',
					from: 'posts',
					select: {
						type: 'expressions',
						columns: [
							{ kind: 'column', column: 'id' },
							{ kind: 'relationColumn', relation: 'author', column: '*' },
						],
					},
					include: [{ relation: 'author' }],
				},
				adapter.model,
				{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
			);

			const result = adapter.compile(plan);
			expect(result.sql).toContain('SELECT');
		});
	});

	describe('getColumnTypes — coverage', () => {
		it('returns undefined when model is absent', () => {
			const adapter = createPgCompileOnlyAdapter();
			const result = adapter.compileInsert({
				type: 'insert',
				table: 'users',
				values: [{ name: 'alice' }],
			} as any);
			expect(result.sql).toContain('INSERT');
		});

		it('returns no special column types for scalar columns in a declared model', () => {
			const adapter = createPgCompileOnlyAdapter({ model: coverageModel });
			// getColumnTypes is private, but exercised through compileInsert
			const result = adapter.compileInsert({
				type: 'insert',
				table: 'users',
				values: [{ name: 'alice' }],
			} as any);
			expect(result.sql).toContain('INSERT');
		});

		it('returns no special column types for a declared table', () => {
			const model = completeModel({
				unknown_table: { foo: 'text' },
			});

			const adapter = createPgCompileOnlyAdapter({ model });
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
							primaryKey: 'id',
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

			const adapter = createPgCompileOnlyAdapter({ model });
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
			const model = coverageModel;

			const adapter = createPgCompileOnlyAdapter();
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
			const adapter = createPgCompileOnlyAdapter({ model: coverageModel });
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
			const adapter = createPgCompileOnlyAdapter({ model: coverageModel });
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

	describe('compileInsertFrom — coverage', () => {
		it('compiles insert-from with columns, where, limit, returning', () => {
			const adapter = createPgCompileOnlyAdapter({ model: coverageModel });
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
			const adapter = createPgCompileOnlyAdapter({ model: coverageModel });
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
							primaryKey: 'id',
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

			const adapter = createPgCompileOnlyAdapter({ model });
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
			const adapter = createPgCompileOnlyAdapter();
			const plan = nativePlan(
				{
					type: 'select',
					from: 'jobs',
					select: { type: 'fields', fields: ['id'] },
					lock: { strength: 'forUpdate', waitPolicy: 'block' },
				},
				coverageModel,
				{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
			);

			const result = adapter.compile(plan);
			expect(result.sql).toContain('FOR UPDATE');
		});

		it('propagates existsWrap from intent', () => {
			const adapter = createPgCompileOnlyAdapter();
			const plan = nativePlan(
				{
					type: 'select',
					from: 'users',
					select: { type: 'fields', fields: ['id'] },
					existsWrap: true,
					where: {
						kind: 'comparison',
						field: 'email',
						operator: 'eq',
						value: 'test@test.com',
					},
				},
				coverageModel,
				{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
			);

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
			const adapter = createPgCompileOnlyAdapter();
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

			// Unissued relation reports refuse before attempting model resolution.
			// Use rawExists(subquery(...)) for EXISTS over uncorrelated/undeclared targets.
			expect(() => adapter.compile(plan)).toThrow(
				'Adapter compilation requires a report planned in this process; plan the query in this process, or use compilePlan from @dbsp/adapter-pgsql/internal for decision-level compilation',
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

			expect(() => new PgAdapter(fakeClient)).toThrow(/borrowedClient: true/);
		});

		it('runs no transaction on a borrowed client unless asked to manage one', async () => {
			const fakeClient = {
				release: () => {},
				query: async () => ({ rows: [] }),
				_txStatus: 'I',
			} as any;

			const adapter = new PgAdapter(fakeClient, { borrowedClient: true });
			expect(adapter.capabilities.supportsStreaming).toBe(false);
			expect(adapter.capabilities.supportsTransactions).toBe(false);
			expect(adapter.inTransaction).toBe(false);
			await expect(adapter.transaction(async () => 'inline')).rejects.toThrow(
				/managedTransactions: true/,
			);
		});
	});
});

describe('synthetic binding includes', () => {
	it('compiles synthetic binding json_agg include decisions with CTE parentKey correlation', () => {
		const model = completeModel({
			active_authors: { author_key: 'integer', id: 'integer' },
			projected_authors: { id: 'integer' },
			posts: {
				id: { type: 'integer', primaryKey: true },
				author_id: ref('active_authors', { inverse: 'author_posts' }),
			},
			comments: {
				id: { type: 'integer', primaryKey: true },
				post_id: ref('posts', { inverse: 'comments' }),
			},
		});
		// This synthetic relation correlates on the projected author key.
		Object.assign(model.getRelation('active_authors.author_posts'), {
			sourceKey: ['author_key'],
		});
		const adapter = createPgCompileOnlyAdapter({ model });

		const plan: PlanReport = nativePlan(
			{
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
			adapter.model,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);

		const result = adapter.compile(plan);

		expect(result.sql).toContain('json_agg(jsonb_build_object(');
		expect(result.sql).toContain('AS author_posts_json');
		expect(result.sql).toMatch(
			/WHERE __t__\.author_id = active_authors\.author_key/i,
		);
	});

	it('compiles synthetic binding nested json_agg includes from flat chained intent paths', () => {
		const adapter = createPgCompileOnlyAdapter({
			model: completeModel({
				active_authors: { author_key: 'integer', id: 'integer' },
				projected_authors: { id: 'integer' },
				posts: {
					id: { type: 'integer', primaryKey: true },
					author_id: ref('projected_authors', { inverse: 'author_posts' }),
				},
				comments: {
					id: { type: 'integer', primaryKey: true },
					post_id: ref('posts', { inverse: 'comments' }),
				},
			}),
		});
		const plan: PlanReport = nativePlan(
			{
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
			adapter.model,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);

		const result = adapter.compile(plan);

		expect(result.sql).toContain('json_agg(jsonb_build_object(');
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
		const adapter = createPgCompileOnlyAdapter({
			model: completeModel({
				active_authors: { author_key: 'integer', id: 'integer' },
				projected_authors: { id: 'integer' },
				posts: {
					id: { type: 'integer', primaryKey: true },
					author_id: 'integer',
				},
				comments: {
					id: { type: 'integer', primaryKey: true },
					post_id: ref('posts', { inverse: 'comments' }),
				},
			}),
		});
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
		).toThrow(
			'Adapter compilation requires a report planned in this process; plan the query in this process, or use compilePlan from @dbsp/adapter-pgsql/internal for decision-level compilation',
		);
	});
});
