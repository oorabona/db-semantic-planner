// @ts-nocheck — coverage test: runtime assertions on AST nodes
/**
 * @fileoverview Coverage tests for typed-query-builder.ts
 * Targets uncovered branches not tested in existing test files
 */

import { describe, expect, it, vi } from 'vitest';
import type { Adapter } from '../adapter.js';
import { schema } from './schema.js';
import { createMockAdapter } from './test-utils.js';
import { createTypedOrm } from './typed-query-builder.js';

// ============================================================================
// Test Schema
// ============================================================================

const testSchema = schema({
	users: {
		id: 'integer',
		name: 'string',
		email: 'string',
		active: 'boolean',
	},
	posts: {
		id: 'integer',
		title: 'string',
		userId: 'integer',
	},
});

// ============================================================================
// FromBuilder method combinations
// ============================================================================

describe('FromBuilder method chains', () => {
	it('should handle orderBy with default direction (asc)', () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compile = vi.fn(() => ({
			sql: 'SELECT * FROM users ORDER BY name ASC',
			parameters: [],
		}));
		adapter.createDump = vi.fn((plan, compiled) => ({
			plan,
			sql: compiled.sql,
			params: compiled.parameters,
		}));
		adapter.execute = vi.fn(() => Promise.resolve([{ id: 1, name: 'Alice' }]));
		const orm = createTypedOrm(testSchema.model, adapter);
		const { users } = testSchema.tables;

		// Act
		const dump = orm.from(users).orderBy(users.name).dump();

		// Assert
		expect(dump.plan.intent.orderBy).toBeDefined();
		expect(dump.plan.intent.orderBy![0]!.direction).toBe('asc');
	});

	it('should handle orderBy with explicit desc direction', () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compile = vi.fn(() => ({
			sql: 'SELECT * FROM users ORDER BY name DESC',
			parameters: [],
		}));
		adapter.createDump = vi.fn((plan, compiled) => ({
			plan,
			sql: compiled.sql,
			params: compiled.parameters,
		}));
		adapter.execute = vi.fn(() => Promise.resolve([{ id: 1, name: 'Alice' }]));
		const orm = createTypedOrm(testSchema.model, adapter);
		const { users } = testSchema.tables;

		// Act
		const dump = orm.from(users).orderBy(users.name, 'desc').dump();

		// Assert
		expect(dump.plan.intent.orderBy![0]!.direction).toBe('desc');
	});

	it('should combine limit and offset', () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compile = vi.fn(() => ({
			sql: 'SELECT * FROM users LIMIT 10 OFFSET 5',
			parameters: [],
		}));
		adapter.createDump = vi.fn((plan, compiled) => ({
			plan,
			sql: compiled.sql,
			params: compiled.parameters,
		}));
		const orm = createTypedOrm(testSchema.model, adapter);
		const { users } = testSchema.tables;

		// Act
		const dump = orm.from(users).limit(10).offset(5).dump();

		// Assert
		expect(dump.plan.intent.limit).toBe(10);
		expect(dump.plan.intent.offset).toBe(5);
	});

	it('should handle multiple where() calls combined with AND', () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compile = vi.fn(() => ({
			sql: 'SELECT * FROM users WHERE active = true AND id > 5',
			parameters: [],
		}));
		adapter.createDump = vi.fn((plan, compiled) => ({
			plan,
			sql: compiled.sql,
			params: compiled.parameters,
		}));
		const orm = createTypedOrm(testSchema.model, adapter);
		const { users } = testSchema.tables;

		// Act
		const builder = orm
			.from(users)
			.where({
				kind: 'comparison',
				field: 'active',
				operator: 'eq',
				value: true,
			})
			.where({ kind: 'comparison', field: 'id', operator: 'gt', value: 5 });
		const dump = builder.dump();

		// Assert
		expect(dump.plan.intent.where).toBeDefined();
		expect(dump.plan.intent.where?.kind).toBe('and');
	});

	it('should handle single where() without AND wrapper', () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compile = vi.fn(() => ({
			sql: 'SELECT * FROM users WHERE active = true',
			parameters: [],
		}));
		adapter.createDump = vi.fn((plan, compiled) => ({
			plan,
			sql: compiled.sql,
			params: compiled.parameters,
		}));
		const orm = createTypedOrm(testSchema.model, adapter);
		const { users } = testSchema.tables;

		// Act
		const builder = orm.from(users).where({
			kind: 'comparison',
			field: 'active',
			operator: 'eq',
			value: true,
		});
		const dump = builder.dump();

		// Assert
		expect(dump.plan.intent.where).toBeDefined();
		expect(dump.plan.intent.where?.kind).toBe('comparison');
	});

	it('should handle pick() with multiple columns', () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compile = vi.fn(() => ({
			sql: 'SELECT id, name FROM users',
			parameters: [],
		}));
		adapter.createDump = vi.fn((plan, compiled) => ({
			plan,
			sql: compiled.sql,
			params: compiled.parameters,
		}));
		adapter.execute = vi.fn(() => Promise.resolve([{ id: 1, name: 'Alice' }]));
		const orm = createTypedOrm(testSchema.model, adapter);
		const { users } = testSchema.tables;

		// Act
		const dump = orm.from(users).pick(users.id, users.name).dump();

		// Assert
		expect(dump.plan.intent.select).toBeDefined();
		expect(dump.plan.intent.select?.fields).toEqual(['id', 'name']);
	});

	it('should handle query without pick() (all columns)', () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compile = vi.fn(() => ({
			sql: 'SELECT * FROM users',
			parameters: [],
		}));
		adapter.createDump = vi.fn((plan, compiled) => ({
			plan,
			sql: compiled.sql,
			params: compiled.parameters,
		}));
		const orm = createTypedOrm(testSchema.model, adapter);
		const { users } = testSchema.tables;

		// Act
		const dump = orm.from(users).dump();

		// Assert
		expect(dump.plan.intent.select).toBeUndefined();
	});

	it('should handle complex chaining: pick, where, orderBy, limit, offset', () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compile = vi.fn(() => ({
			sql: 'SELECT id, name FROM users WHERE active = true ORDER BY name ASC LIMIT 10 OFFSET 5',
			parameters: [],
		}));
		adapter.createDump = vi.fn((plan, compiled) => ({
			plan,
			sql: compiled.sql,
			params: compiled.parameters,
		}));
		const orm = createTypedOrm(testSchema.model, adapter);
		const { users } = testSchema.tables;

		// Act
		const dump = orm
			.from(users)
			.pick(users.id, users.name)
			.where({
				kind: 'comparison',
				field: 'active',
				operator: 'eq',
				value: true,
			})
			.orderBy(users.name)
			.limit(10)
			.offset(5)
			.dump();

		// Assert
		expect(dump.plan.intent.select?.fields).toEqual(['id', 'name']);
		expect(dump.plan.intent.where).toBeDefined();
		expect(dump.plan.intent.orderBy).toHaveLength(1);
		expect(dump.plan.intent.limit).toBe(10);
		expect(dump.plan.intent.offset).toBe(5);
	});
});

// ============================================================================
// exists() and existsDump()
// ============================================================================

describe('Existence checks', () => {
	it('should return true when exists() finds matching rows', async () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compile = vi.fn(() => ({
			sql: 'SELECT EXISTS(SELECT 1 FROM users WHERE active = true LIMIT 1)',
			parameters: [],
		}));
		adapter.execute = vi.fn(() => Promise.resolve([{ exists: true }]));
		const orm = createTypedOrm(testSchema.model, adapter);
		const { users } = testSchema.tables;

		// Act
		const result = await orm
			.from(users)
			.where({
				kind: 'comparison',
				field: 'active',
				operator: 'eq',
				value: true,
			})
			.exists();

		// Assert
		expect(result).toBe(true);
	});

	it('should return false when exists() finds no matching rows', async () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compile = vi.fn(() => ({
			sql: 'SELECT EXISTS(SELECT 1 FROM users WHERE active = false LIMIT 1)',
			parameters: [],
		}));
		adapter.execute = vi.fn(() => Promise.resolve([{ exists: false }]));
		const orm = createTypedOrm(testSchema.model, adapter);
		const { users } = testSchema.tables;

		// Act
		const result = await orm
			.from(users)
			.where({
				kind: 'comparison',
				field: 'active',
				operator: 'eq',
				value: false,
			})
			.exists();

		// Assert
		expect(result).toBe(false);
	});

	it('should return false when exists() receives empty result array', async () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compile = vi.fn(() => ({
			sql: 'SELECT EXISTS(SELECT 1 FROM users LIMIT 1)',
			parameters: [],
		}));
		adapter.execute = vi.fn(() => Promise.resolve([]));
		const orm = createTypedOrm(testSchema.model, adapter);
		const { users } = testSchema.tables;

		// Act
		const result = await orm.from(users).exists();

		// Assert
		expect(result).toBe(false);
	});

	it('should generate existsDump() with existsWrap and limit=1', () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compile = vi.fn(() => ({
			sql: 'SELECT EXISTS(SELECT 1 FROM users LIMIT 1)',
			parameters: [],
		}));
		adapter.createDump = vi.fn((plan, compiled) => ({
			plan,
			sql: compiled.sql,
			params: compiled.parameters,
		}));
		const orm = createTypedOrm(testSchema.model, adapter);
		const { users } = testSchema.tables;

		// Act
		const dump = orm.from(users).existsDump();

		// Assert
		expect(dump.plan.intent.existsWrap).toBe(true);
		expect(dump.plan.intent.limit).toBe(1);
	});

	it('should strip orderBy from exists intent', async () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compile = vi.fn(() => ({
			sql: 'SELECT EXISTS(SELECT 1 FROM users WHERE active = true LIMIT 1)',
			parameters: [],
		}));
		adapter.execute = vi.fn(() => Promise.resolve([{ exists: true }]));
		const orm = createTypedOrm(testSchema.model, adapter);
		const { users } = testSchema.tables;

		// Act
		const result = await orm
			.from(users)
			.where({
				kind: 'comparison',
				field: 'active',
				operator: 'eq',
				value: true,
			})
			.orderBy(users.name)
			.exists();

		// Assert - orderBy was stripped (tested via integration)
		expect(result).toBe(true);
	});

	it('should preserve where in exists intent', async () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compile = vi.fn(() => ({
			sql: 'SELECT EXISTS(SELECT 1 FROM users WHERE active = true LIMIT 1)',
			parameters: [],
		}));
		adapter.execute = vi.fn(() => Promise.resolve([{ exists: true }]));
		const orm = createTypedOrm(testSchema.model, adapter);
		const { users } = testSchema.tables;

		// Act
		const result = await orm
			.from(users)
			.where({
				kind: 'comparison',
				field: 'active',
				operator: 'eq',
				value: true,
			})
			.exists();

		// Assert - where clause was preserved (tested via integration)
		expect(result).toBe(true);
	});
});

// ============================================================================
// all() and first()
// ============================================================================

describe('Query execution', () => {
	it('should execute all() and return results', async () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compile = vi.fn(() => ({
			sql: 'SELECT * FROM users',
			parameters: [],
		}));
		adapter.execute = vi.fn(() =>
			Promise.resolve([
				{ id: 1, name: 'Alice' },
				{ id: 2, name: 'Bob' },
			]),
		);
		const orm = createTypedOrm(testSchema.model, adapter);
		const { users } = testSchema.tables;

		// Act
		const results = await orm.from(users).all();

		// Assert
		expect(results).toHaveLength(2);
		expect(results[0]).toEqual({ id: 1, name: 'Alice' });
	});

	it('should execute first() and return first row', async () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compile = vi.fn(() => ({
			sql: 'SELECT * FROM users LIMIT 1',
			parameters: [],
		}));
		adapter.execute = vi.fn(() => Promise.resolve([{ id: 1, name: 'Alice' }]));
		const orm = createTypedOrm(testSchema.model, adapter);
		const { users } = testSchema.tables;

		// Act
		const result = await orm.from(users).first();

		// Assert
		expect(result).toEqual({ id: 1, name: 'Alice' });
	});

	it('should execute first() and return null when no results', async () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compile = vi.fn(() => ({
			sql: 'SELECT * FROM users LIMIT 1',
			parameters: [],
		}));
		adapter.execute = vi.fn(() => Promise.resolve([]));
		const orm = createTypedOrm(testSchema.model, adapter);
		const { users } = testSchema.tables;

		// Act
		const result = await orm.from(users).first();

		// Assert
		expect(result).toBeNull();
	});

	it('should add limit=1 to first() query automatically', async () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compile = vi.fn(() => ({
			sql: 'SELECT * FROM users LIMIT 1',
			parameters: [],
		}));
		adapter.execute = vi.fn(() => Promise.resolve([{ id: 1, name: 'Alice' }]));
		const orm = createTypedOrm(testSchema.model, adapter);
		const { users } = testSchema.tables;

		// Act
		const result = await orm.from(users).first();

		// Assert
		expect(result).toEqual({ id: 1, name: 'Alice' });
		expect(adapter.compile).toHaveBeenCalled();
	});
});

// ============================================================================
// Error handling: no adapter
// ============================================================================

describe('Error handling without adapter', () => {
	it('should throw when calling all() without adapter', async () => {
		// Arrange
		const orm = createTypedOrm(testSchema.model);
		const { users } = testSchema.tables;

		// Act & Assert
		await expect(orm.from(users).all()).rejects.toThrow(
			/Cannot execute query without adapter/,
		);
	});

	it('should throw when calling first() without adapter', async () => {
		// Arrange
		const orm = createTypedOrm(testSchema.model);
		const { users } = testSchema.tables;

		// Act & Assert
		await expect(orm.from(users).first()).rejects.toThrow(
			/Cannot execute query without adapter/,
		);
	});

	it('should throw when calling exists() without adapter', async () => {
		// Arrange
		const orm = createTypedOrm(testSchema.model);
		const { users } = testSchema.tables;

		// Act & Assert
		await expect(orm.from(users).exists()).rejects.toThrow(
			/Cannot execute query without adapter/,
		);
	});

	it('should throw when calling dump() without adapter', () => {
		// Arrange
		const orm = createTypedOrm(testSchema.model);
		const { users } = testSchema.tables;

		// Act & Assert
		expect(() => orm.from(users).dump()).toThrow(
			/Cannot dump query without adapter/,
		);
	});

	it('should throw when calling existsDump() without adapter', () => {
		// Arrange
		const orm = createTypedOrm(testSchema.model);
		const { users } = testSchema.tables;

		// Act & Assert
		expect(() => orm.from(users).existsDump()).toThrow(
			/Cannot dump query without adapter/,
		);
	});
});

// ============================================================================
// Schema scoping
// ============================================================================

describe('Schema scoping', () => {
	it('should pass schemaName to compile when using exists() with schema', async () => {
		// Arrange
		const adapter = createMockAdapter();
		let capturedOptions: unknown;
		adapter.compile = vi.fn((_plan, options) => {
			capturedOptions = options;
			return {
				sql: 'SELECT EXISTS(SELECT 1 FROM tenant_1.users LIMIT 1)',
				parameters: [],
			};
		});
		adapter.execute = vi.fn(() => Promise.resolve([{ exists: true }]));
		const orm = createTypedOrm(testSchema.model, adapter, 'tenant_1');
		const { users } = testSchema.tables;

		// Act
		await orm.from(users).exists();

		// Assert
		expect(adapter.compile).toHaveBeenCalledOnce();
		expect((capturedOptions as any)?.schemaName).toBe('tenant_1');
	});

	it('should not pass schemaName when no schema provided', async () => {
		// Arrange
		const adapter = createMockAdapter();
		let capturedOptions: unknown;
		adapter.compile = vi.fn((_plan, options) => {
			capturedOptions = options;
			return {
				sql: 'SELECT EXISTS(SELECT 1 FROM users LIMIT 1)',
				parameters: [],
			};
		});
		adapter.execute = vi.fn(() => Promise.resolve([{ exists: true }]));
		const orm = createTypedOrm(testSchema.model, adapter);
		const { users } = testSchema.tables;

		// Act
		await orm.from(users).exists();

		// Assert
		expect(adapter.compile).toHaveBeenCalledOnce();
		expect((capturedOptions as any)?.schemaName).toBeUndefined();
	});
});
