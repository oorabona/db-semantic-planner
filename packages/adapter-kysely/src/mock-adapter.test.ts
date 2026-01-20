/**
 * DX-031: MockAdapter Tests
 * Tests for the compile-only adapter that generates SQL without database execution.
 */

import {
	belongsTo,
	createOrm,
	defineSchemaBuilder,
	ExecutionError,
	eq,
	hasMany,
} from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createMockAdapter, MockAdapter } from './mock-adapter.js';

// Test schema
const testSchema = defineSchemaBuilder({
	users: {
		id: 'serial',
		name: { type: 'string' },
		email: { type: 'string' },
		active: { type: 'boolean' },
	},
	posts: {
		id: 'serial',
		title: { type: 'string' },
		content: 'text',
		authorId: 'integer',
	},
})
	.relations({
		users: {
			posts: hasMany('posts', { foreignKey: 'authorId' }),
		},
		posts: {
			author: belongsTo('users', { foreignKey: 'authorId' }),
		},
	})
	.build();

describe('MockAdapter', () => {
	describe('createMockAdapter factory', () => {
		it('creates adapter with default options', () => {
			const adapter = createMockAdapter();

			expect(adapter).toBeInstanceOf(MockAdapter);
			expect(adapter.capabilities.supportsReturning).toBe(true);
			expect(adapter.capabilities.supportsSchemas).toBe(true);
			expect(adapter.capabilities.supportsRecursiveCTE).toBe(true);
			expect(adapter.capabilities.supportsWindowFunctions).toBe(true);
			expect(adapter.capabilities.supportsStreaming).toBe(false);
		});

		it('creates adapter with schema name', () => {
			const adapter = createMockAdapter({ schemaName: 'tenant_123' });

			expect(adapter).toBeInstanceOf(MockAdapter);
		});

		it('produces schema-qualified SQL when schemaName is set', () => {
			const orm = createOrm({
				model: testSchema,
				adapter: createMockAdapter({ schemaName: 'my_tenant' }),
			});

			const dump = orm.select('users').dump();

			// SQL should include schema qualification via Kysely's native withSchema
			expect(dump.sql).toContain('"my_tenant"');
			expect(dump.sql).toContain('"my_tenant"."users"');
			expect(dump.meta?.schema).toBe('my_tenant');
		});

		it('withSchema() produces schema-qualified SQL', () => {
			const adapter = createMockAdapter();
			const orm = createOrm({ model: testSchema, adapter });

			const scopedOrm = orm.withSchema('tenant_abc');
			const dump = scopedOrm.select('users').dump();

			// SQL should include schema qualification via Kysely's native withSchema
			expect(dump.sql).toContain('"tenant_abc"');
			expect(dump.sql).toContain('"tenant_abc"."users"');
			expect(dump.meta?.schema).toBe('tenant_abc');
		});

		it('withSchema() preserves dialect', () => {
			const adapter = createMockAdapter({ dialect: 'mysql' });
			const orm = createOrm({ model: testSchema, adapter });

			const scopedOrm = orm.withSchema('tenant_xyz');
			const dump = scopedOrm.select('users').dump();

			// MySQL uses backticks for identifiers
			expect(dump.sql).toContain('`tenant_xyz`');
		});

		it('supports mysql dialect', () => {
			const adapter = createMockAdapter({ dialect: 'mysql' });
			expect(adapter).toBeInstanceOf(MockAdapter);
		});

		it('supports sqlite dialect', () => {
			const adapter = createMockAdapter({ dialect: 'sqlite' });
			expect(adapter).toBeInstanceOf(MockAdapter);
		});

		it('supports mssql dialect', () => {
			const adapter = createMockAdapter({ dialect: 'mssql' });
			expect(adapter).toBeInstanceOf(MockAdapter);
		});
	});

	describe('compile methods', () => {
		it('compiles SELECT query to SQL', async () => {
			const orm = createOrm({
				model: testSchema,
				adapter: createMockAdapter(),
			});

			const dump = await orm.select('users').dump();

			expect(dump.sql).toContain('select');
			expect(dump.sql).toContain('"users"');
		});

		it('compiles SELECT with WHERE clause', async () => {
			const orm = createOrm({
				model: testSchema,
				adapter: createMockAdapter(),
			});

			const dump = await orm.select('users').where(eq('active', true)).dump();

			expect(dump.sql).toContain('where');
			expect(dump.sql).toContain('"active"');
			expect(dump.params).toContain(true);
		});

		it('compiles INSERT query', async () => {
			const orm = createOrm({
				model: testSchema,
				adapter: createMockAdapter(),
			});

			const dump = await orm
				.insert('users')
				.values({ name: 'John', email: 'john@test.com', active: true })
				.dump();

			expect(dump.sql).toContain('insert into');
			expect(dump.sql).toContain('"users"');
			expect(dump.parameters).toContain('John');
			expect(dump.parameters).toContain('john@test.com');
		});

		it('compiles UPDATE query', async () => {
			const orm = createOrm({
				model: testSchema,
				adapter: createMockAdapter(),
			});

			const dump = await orm
				.update('users')
				.set({ active: false })
				.where(eq('id', 1))
				.dump();

			expect(dump.sql).toContain('update');
			expect(dump.sql).toContain('"users"');
			expect(dump.sql).toContain('set');
		});

		it('compiles DELETE query', async () => {
			const orm = createOrm({
				model: testSchema,
				adapter: createMockAdapter(),
			});

			const dump = await orm.delete('users').where(eq('id', 1)).dump();

			expect(dump.sql).toContain('delete from');
			expect(dump.sql).toContain('"users"');
		});

		it('compiles query with schema prefix (multi-tenant)', async () => {
			const orm = createOrm({
				model: testSchema,
				adapter: createMockAdapter(),
			});

			// Use withSchema to scope queries to a schema
			const scopedOrm = orm.withSchema('tenant_123');
			const dump = scopedOrm.select('users').dump();

			expect(dump.sql).toContain('"tenant_123"."users"');
			expect(dump.meta?.schema).toBe('tenant_123');
		});

		it('compiles query with relation include', async () => {
			const orm = createOrm({
				model: testSchema,
				adapter: createMockAdapter(),
			});

			const dump = await orm.select('posts').include('author').dump();

			// Should contain JOIN for the author relation
			expect(dump.sql).toContain('join');
		});
	});

	describe('execution methods throw ExecutionError', () => {
		const adapter = createMockAdapter();

		it('execute throws ExecutionError', async () => {
			const query = { sql: 'SELECT 1', parameters: [] };

			await expect(adapter.execute(query)).rejects.toThrow(ExecutionError);
			await expect(adapter.execute(query)).rejects.toThrow(
				'MockAdapter does not support query execution',
			);
		});

		it('executeOne throws ExecutionError', async () => {
			const query = { sql: 'SELECT 1', parameters: [] };

			await expect(adapter.executeOne(query)).rejects.toThrow(ExecutionError);
		});

		it('executeOneOrThrow throws ExecutionError', async () => {
			const query = { sql: 'SELECT 1', parameters: [] };

			await expect(adapter.executeOneOrThrow(query)).rejects.toThrow(
				ExecutionError,
			);
		});

		it('executeRaw throws ExecutionError', async () => {
			await expect(adapter.executeRaw('SELECT 1')).rejects.toThrow(
				ExecutionError,
			);
		});

		it('stream throws ExecutionError', () => {
			const query = { sql: 'SELECT 1', parameters: [] };

			expect(() => adapter.stream(query)).toThrow(ExecutionError);
		});

		it('transaction throws ExecutionError', async () => {
			await expect(adapter.transaction(async () => {})).rejects.toThrow(
				ExecutionError,
			);
		});

		it('introspect throws ExecutionError', async () => {
			await expect(adapter.introspect()).rejects.toThrow(ExecutionError);
			await expect(adapter.introspect()).rejects.toThrow(
				'MockAdapter does not support database introspection',
			);
		});
	});

	describe('withSchema', () => {
		it('returns new adapter with schema name', () => {
			const adapter = createMockAdapter();
			const tenantAdapter = adapter.withSchema('tenant_abc');

			expect(tenantAdapter).toBeInstanceOf(MockAdapter);
			expect(tenantAdapter).not.toBe(adapter);
		});

		it('new adapter uses schema in queries', async () => {
			const orm = createOrm({
				model: testSchema,
				adapter: createMockAdapter(),
			});

			const scopedOrm = orm.withSchema('tenant_xyz');
			const dump = await scopedOrm.select('users').dump();

			expect(dump.sql).toContain('"tenant_xyz"."users"');
		});
	});

	describe('createDump', () => {
		it('creates dump with plan, SQL, and params', () => {
			const adapter = createMockAdapter();
			const mockPlan = { intent: { from: 'users' } } as any;
			const mockQuery = { sql: 'SELECT * FROM users', parameters: [1, 2] };

			const dump = adapter.createDump(mockPlan, mockQuery, {
				queryName: 'test-query',
			});

			expect(dump.plan).toBe(mockPlan);
			expect(dump.sql).toBe('SELECT * FROM users');
			expect(dump.params).toEqual([1, 2]);
			expect(dump.meta?.queryName).toBe('test-query');
		});

		it('includes tenant in meta when schema is set', () => {
			const adapter = createMockAdapter({ schemaName: 'my_tenant' });
			const dump = adapter.createDump({ intent: { from: 'users' } } as any, {
				sql: 'SELECT 1',
				parameters: [],
			});

			expect(dump.meta?.schema).toBe('my_tenant');
		});
	});

	describe('validateIdentifier', () => {
		it('validates safe identifiers', () => {
			const adapter = createMockAdapter();

			expect(() => adapter.validateIdentifier('users', 'table')).not.toThrow();
			expect(() =>
				adapter.validateIdentifier('user_name', 'column'),
			).not.toThrow();
			expect(() =>
				adapter.validateIdentifier('tenant_123', 'schema'),
			).not.toThrow();
		});

		it('throws for unsafe identifiers', () => {
			const adapter = createMockAdapter();

			expect(() =>
				adapter.validateIdentifier('users; DROP TABLE users;--', 'table'),
			).toThrow();
			expect(() => adapter.validateIdentifier("users'", 'table')).toThrow();
		});
	});

	describe('ORM integration', () => {
		it('works with full ORM workflow (compile only)', async () => {
			const orm = createOrm({
				model: testSchema,
				adapter: createMockAdapter(),
			});

			// Build a complex query
			const dump = await orm
				.select('posts')
				.columns('id', 'title')
				.where(eq('authorId', 1))
				.orderBy('id', 'desc')
				.limit(10)
				.dump();

			expect(dump.sql).toContain('select');
			// Compiler uses table aliases and short column names, e.g., "t0"."i"
			expect(dump.sql).toContain('"posts"');
			expect(dump.sql).toContain('order by');
			expect(dump.sql).toContain('limit');
		});

		it('execute methods throw helpful error', async () => {
			const orm = createOrm({
				model: testSchema,
				adapter: createMockAdapter(),
			});

			// Attempting to execute should throw with helpful message
			await expect(orm.select('users').all()).rejects.toThrow(
				'MockAdapter does not support query execution',
			);
			await expect(orm.select('users').all()).rejects.toThrow(
				'Use createKyselyAdapter()',
			);
		});
	});
});
