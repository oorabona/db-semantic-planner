/**
 * PgsqlAdapter Unit Tests
 *
 * Tests adapter interface implementation without database connection.
 */

import type { PlanReport } from '@dbsp/core';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createPgsqlAdapter, PgsqlAdapter } from './pgsql-adapter.js';

// ============================================================================
// Mock Pool
// ============================================================================

function createMockPool(): Pool {
	return {
		query: vi.fn(),
		connect: vi.fn(),
		end: vi.fn(),
		// Add other Pool methods as needed
	} as unknown as Pool;
}

// ============================================================================
// Tests
// ============================================================================

describe('PgsqlAdapter', () => {
	describe('constructor', () => {
		it('should create adapter with default options', () => {
			const pool = createMockPool();
			const adapter = new PgsqlAdapter(pool);

			expect(adapter).toBeInstanceOf(PgsqlAdapter);
			expect(adapter.namingConvention).toBe('preserve');
			expect(adapter.capabilities).toEqual({
				supportsReturning: true,
				supportsSchemas: true,
				supportsStreaming: true,
				supportsRecursiveCTE: true,
				supportsWindowFunctions: true,
				supportsArrayType: true,
			});
		});

		it('should create adapter with custom naming convention', () => {
			const pool = createMockPool();
			const adapter = new PgsqlAdapter(pool, {
				namingConvention: 'camelCase',
			});

			expect(adapter.namingConvention).toBe('camelCase');
		});

		it('should create adapter with schema name', () => {
			const pool = createMockPool();
			const adapter = new PgsqlAdapter(pool, {
				schemaName: 'tenant_123',
			});

			expect(adapter).toBeInstanceOf(PgsqlAdapter);
		});
	});

	describe('capabilities', () => {
		it('should report full PostgreSQL capabilities', () => {
			const pool = createMockPool();
			const adapter = createPgsqlAdapter(pool);

			expect(adapter.capabilities.supportsReturning).toBe(true);
			expect(adapter.capabilities.supportsSchemas).toBe(true);
			expect(adapter.capabilities.supportsStreaming).toBe(true);
			expect(adapter.capabilities.supportsRecursiveCTE).toBe(true);
			expect(adapter.capabilities.supportsWindowFunctions).toBe(true);
			expect(adapter.capabilities.supportsArrayType).toBe(true);
		});
	});

	describe('compile', () => {
		it('should compile a plan to CompiledQuery', () => {
			const pool = createMockPool();
			const adapter = createPgsqlAdapter(pool);

			// Mock plan (simplified)
			const plan: PlanReport = {
				rootTable: 'users',
				decisions: [{ type: 'select', column: '*' }],
			} as any;

			const compiled = adapter.compile(plan);

			expect(compiled).toHaveProperty('sql');
			expect(compiled).toHaveProperty('parameters');
			expect(typeof compiled.sql).toBe('string');
			expect(Array.isArray(compiled.parameters)).toBe(true);
		});

		it('should use schema from adapter options', () => {
			const pool = createMockPool();
			const adapter = createPgsqlAdapter(pool, {
				schemaName: 'tenant_123',
			});

			const plan: PlanReport = {
				rootTable: 'users',
				decisions: [{ type: 'select', column: '*' }],
			} as any;

			const compiled = adapter.compile(plan);

			// Should include schema in SQL
			expect(compiled.sql).toContain('tenant_123');
		});

		it('should use schema from compile options', () => {
			const pool = createMockPool();
			const adapter = createPgsqlAdapter(pool);

			const plan: PlanReport = {
				rootTable: 'users',
				decisions: [{ type: 'select', column: '*' }],
			} as any;

			const compiled = adapter.compile(plan, { schemaName: 'custom_schema' });

			expect(compiled.sql).toContain('custom_schema');
		});
	});

	describe('compileWithIncludes', () => {
		it('should compile plan with includes', () => {
			const pool = createMockPool();
			const adapter = createPgsqlAdapter(pool);

			const plan: PlanReport = {
				rootTable: 'posts',
				decisions: [{ type: 'select', column: '*' }],
			} as any;

			const result = adapter.compileWithIncludes(plan);

			expect(result).toHaveProperty('main');
			expect(result).toHaveProperty('subqueryIncludes');
			expect(result.main).toHaveProperty('sql');
			expect(result.main).toHaveProperty('parameters');
			expect(Array.isArray(result.subqueryIncludes)).toBe(true);
		});
	});

	describe('mutations', () => {
		it('should compile insert intent', () => {
			const pool = createMockPool();
			const adapter = createPgsqlAdapter(pool);

			const intent = {
				table: 'users',
				values: [{ name: 'Alice', email: 'alice@example.com' }],
			} as any;

			const compiled = adapter.compileInsert(intent);

			expect(compiled).toHaveProperty('sql');
			expect(compiled).toHaveProperty('parameters');
		});

		it('should compile update intent', () => {
			const pool = createMockPool();
			const adapter = createPgsqlAdapter(pool);

			const intent = {
				table: 'users',
				set: [{ column: 'name', value: 'Bob' }],
			} as any;

			const compiled = adapter.compileUpdate(intent);

			expect(compiled).toHaveProperty('sql');
			expect(compiled).toHaveProperty('parameters');
		});

		it('should compile delete intent', () => {
			const pool = createMockPool();
			const adapter = createPgsqlAdapter(pool);

			const intent = {
				table: 'users',
			} as any;

			const compiled = adapter.compileDelete(intent);

			expect(compiled).toHaveProperty('sql');
			expect(compiled).toHaveProperty('parameters');
		});

		it('should compile upsert intent', () => {
			const pool = createMockPool();
			const adapter = createPgsqlAdapter(pool);

			const intent = {
				table: 'users',
				values: [{ id: 1, name: 'Alice' }],
				conflictTarget: ['id'],
			} as any;

			// Phase 2 stub - should throw
			expect(() => adapter.compileUpsert(intent)).toThrow(
				'Not implemented - Phase 2',
			);
		});
	});

	describe('execute', () => {
		it('should execute query and return all results', async () => {
			const pool = createMockPool();
			const mockRows = [
				{ id: 1, name: 'Alice' },
				{ id: 2, name: 'Bob' },
			];
			vi.mocked(pool.query).mockResolvedValue({ rows: mockRows } as any);

			const adapter = createPgsqlAdapter(pool);
			const query = { sql: 'SELECT * FROM users', parameters: [] };

			const results = await adapter.execute(query);

			expect(results).toEqual(mockRows);
			expect(pool.query).toHaveBeenCalledWith(query.sql, query.parameters);
		});
	});

	describe('executeOne', () => {
		it('should return first result', async () => {
			const pool = createMockPool();
			const mockRows = [{ id: 1, name: 'Alice' }];
			vi.mocked(pool.query).mockResolvedValue({ rows: mockRows } as any);

			const adapter = createPgsqlAdapter(pool);
			const query = { sql: 'SELECT * FROM users LIMIT 1', parameters: [] };

			const result = await adapter.executeOne(query);

			expect(result).toEqual(mockRows[0]);
		});

		it('should return null when no results', async () => {
			const pool = createMockPool();
			vi.mocked(pool.query).mockResolvedValue({ rows: [] } as any);

			const adapter = createPgsqlAdapter(pool);
			const query = {
				sql: 'SELECT * FROM users WHERE id = $1',
				parameters: [999],
			};

			const result = await adapter.executeOne(query);

			expect(result).toBeNull();
		});
	});

	describe('executeOneOrThrow', () => {
		it('should return first result', async () => {
			const pool = createMockPool();
			const mockRows = [{ id: 1, name: 'Alice' }];
			vi.mocked(pool.query).mockResolvedValue({ rows: mockRows } as any);

			const adapter = createPgsqlAdapter(pool);
			const query = { sql: 'SELECT * FROM users LIMIT 1', parameters: [] };

			const result = await adapter.executeOneOrThrow(query);

			expect(result).toEqual(mockRows[0]);
		});

		it('should throw when no results', async () => {
			const pool = createMockPool();
			vi.mocked(pool.query).mockResolvedValue({ rows: [] } as any);

			const adapter = createPgsqlAdapter(pool);
			const query = {
				sql: 'SELECT * FROM users WHERE id = $1',
				parameters: [999],
			};

			await expect(adapter.executeOneOrThrow(query)).rejects.toThrow(
				'No results found',
			);
		});
	});

	describe('executeRaw', () => {
		it('should execute raw SQL', async () => {
			const pool = createMockPool();
			const mockRows = [{ count: 5 }];
			vi.mocked(pool.query).mockResolvedValue({ rows: mockRows } as any);

			const adapter = createPgsqlAdapter(pool);
			const sql = 'SELECT COUNT(*) FROM users';

			const results = await adapter.executeRaw(sql);

			expect(results).toEqual(mockRows);
			expect(pool.query).toHaveBeenCalledWith(sql, []);
		});

		it('should execute raw SQL with parameters', async () => {
			const pool = createMockPool();
			const mockRows = [{ id: 1, name: 'Alice' }];
			vi.mocked(pool.query).mockResolvedValue({ rows: mockRows } as any);

			const adapter = createPgsqlAdapter(pool);
			const sql = 'SELECT * FROM users WHERE id = $1';
			const params = [1];

			const results = await adapter.executeRaw(sql, params);

			expect(results).toEqual(mockRows);
			expect(pool.query).toHaveBeenCalledWith(sql, params);
		});
	});

	describe('withSchema', () => {
		it('should create schema-scoped adapter', () => {
			const pool = createMockPool();
			const adapter = createPgsqlAdapter(pool);

			const scopedAdapter = adapter.withSchema('tenant_456');

			expect(scopedAdapter).toBeInstanceOf(PgsqlAdapter);
			expect(scopedAdapter).not.toBe(adapter);
		});

		it('should validate schema name', () => {
			const pool = createMockPool();
			const adapter = createPgsqlAdapter(pool);

			// Invalid schema name with SQL injection attempt
			expect(() => adapter.withSchema('tenant"; DROP TABLE users--')).toThrow();
		});
	});

	describe('validateIdentifier', () => {
		it('should accept valid identifiers', () => {
			const pool = createMockPool();
			const adapter = createPgsqlAdapter(pool);

			expect(() => adapter.validateIdentifier('users', 'table')).not.toThrow();
			expect(() =>
				adapter.validateIdentifier('user_id', 'column'),
			).not.toThrow();
			expect(() =>
				adapter.validateIdentifier('tenant_123', 'schema'),
			).not.toThrow();
		});

		it('should reject invalid identifiers', () => {
			const pool = createMockPool();
			const adapter = createPgsqlAdapter(pool);

			// SQL injection attempts
			expect(() =>
				adapter.validateIdentifier('users; DROP TABLE users--', 'table'),
			).toThrow();
			expect(() =>
				adapter.validateIdentifier("users' OR 1=1--", 'table'),
			).toThrow();
		});
	});

	describe('createDump', () => {
		it('should create dump with plan and query', () => {
			const pool = createMockPool();
			const adapter = createPgsqlAdapter(pool);

			const plan: PlanReport = {
				rootTable: 'users',
				decisions: [],
			} as any;

			const query = {
				sql: 'SELECT * FROM users',
				parameters: [],
			};

			const dump = adapter.createDump(plan, query);

			expect(dump.plan).toBe(plan);
			expect(dump.sql).toBe(query.sql);
			expect(dump.params).toBe(query.parameters);
			expect(dump.meta).toBeDefined();
			expect(dump.meta?.compiledAt).toBeInstanceOf(Date);
		});

		it('should include schema in dump metadata', () => {
			const pool = createMockPool();
			const adapter = createPgsqlAdapter(pool, {
				schemaName: 'tenant_123',
			});

			const plan: PlanReport = {
				rootTable: 'users',
				decisions: [],
			} as any;

			const query = {
				sql: 'SELECT * FROM users',
				parameters: [],
			};

			const dump = adapter.createDump(plan, query);

			expect(dump.meta?.schema).toBe('tenant_123');
		});
	});

	describe('factory function', () => {
		it('should create adapter via factory', () => {
			const pool = createMockPool();
			const adapter = createPgsqlAdapter(pool);

			expect(adapter).toBeInstanceOf(PgsqlAdapter);
		});

		it('should pass options to adapter', () => {
			const pool = createMockPool();
			const adapter = createPgsqlAdapter(pool, {
				namingConvention: 'snake_case',
				schemaName: 'public',
			});

			expect(adapter.namingConvention).toBe('snake_case');
		});
	});

	describe('stubs (not yet implemented)', () => {
		it('compileSubqueryInclude should throw', () => {
			const pool = createMockPool();
			const adapter = createPgsqlAdapter(pool);

			const info = { relationName: 'posts' } as any;
			const parentIds = [1, 2, 3];

			expect(() => adapter.compileSubqueryInclude(info, parentIds)).toThrow(
				'Not implemented - Phase 3',
			);
		});

		it('compileInsertFrom should throw', () => {
			const pool = createMockPool();
			const adapter = createPgsqlAdapter(pool);

			const intent = { table: 'users' } as any;

			expect(() => adapter.compileInsertFrom(intent)).toThrow(
				'Not implemented - Phase 2',
			);
		});

		it('compileRecursive should throw', () => {
			const pool = createMockPool();
			const adapter = createPgsqlAdapter(pool);

			const report = {} as any;
			const model = {} as any;

			expect(() => adapter.compileRecursive(report, model)).toThrow(
				'Not implemented - Phase 2',
			);
		});

		it('stream should throw', () => {
			const pool = createMockPool();
			const adapter = createPgsqlAdapter(pool);

			const query = { sql: 'SELECT * FROM users', parameters: [] };

			expect(() => adapter.stream(query)).toThrow('Not implemented - Phase 2');
		});

		it('introspect should throw', async () => {
			const pool = createMockPool();
			const adapter = createPgsqlAdapter(pool);

			await expect(adapter.introspect()).rejects.toThrow(
				'Not implemented - Phase 4',
			);
		});

		it('generateDDL should throw', () => {
			const pool = createMockPool();
			const adapter = createPgsqlAdapter(pool);

			const schema = {} as any;

			expect(() => adapter.generateDDL(schema)).toThrow(
				'Not implemented - Phase 3',
			);
		});
	});
});
