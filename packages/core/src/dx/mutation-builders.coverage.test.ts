// @ts-nocheck — coverage test: runtime assertions on AST nodes
/**
 * @fileoverview Coverage tests for mutation-builders.ts
 * Targets uncovered branches not tested in mutation-builders.test.ts or mutation-builders.errors.test.ts
 */

import { describe, expect, it, vi } from 'vitest';
import type { Adapter, CompiledQuery, Dump } from '../adapter.js';
import {
	DeleteBuilder,
	InsertBuilder,
	UpdateBuilder,
	UpsertBuilder,
} from './mutation-builders.js';
import { createOrm } from './orm.js';
import { ref, schema } from './schema.js';
import { createMockAdapter } from './test-utils.js';

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
		authorId: ref('users', { as: 'author', inverse: 'posts' }),
	},
});

// ============================================================================
// InsertBuilder: Column combinations and returning
// ============================================================================

describe('InsertBuilder coverage', () => {
	it('should build intent with returning columns', () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compileInsert = vi.fn(() => ({
			sql: 'INSERT INTO users (name) VALUES ($1) RETURNING id',
			parameters: ['Alice'],
		}));
		const orm = createOrm({ schema: testSchema, adapter });

		// Act
		const builder = orm
			.insert('users')
			.values({ name: 'Alice' })
			.returning(['id']);
		const dump = builder.dump();

		// Assert
		expect(dump.intent.returning).toEqual(['id']);
	});

	it('should build intent without returning when not specified', () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compileInsert = vi.fn(() => ({
			sql: 'INSERT INTO users (name) VALUES ($1)',
			parameters: ['Alice'],
		}));
		const orm = createOrm({ schema: testSchema, adapter });

		// Act
		const builder = orm.insert('users').values({ name: 'Alice' });
		const dump = builder.dump();

		// Assert
		expect(dump.intent.returning).toBeUndefined();
	});

	it('should handle single value via values()', () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compileInsert = vi.fn(() => ({
			sql: 'INSERT INTO users (name) VALUES ($1)',
			parameters: ['Alice'],
		}));
		const orm = createOrm({ schema: testSchema, adapter });

		// Act
		const builder = orm.insert('users').values({ name: 'Alice' });
		const dump = builder.dump();

		// Assert
		expect(dump.intent.values).toHaveLength(1);
		expect(dump.intent.values[0]).toEqual({ name: 'Alice' });
	});

	it('should handle array of values via values()', () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compileInsert = vi.fn(() => ({
			sql: 'INSERT INTO users (name) VALUES ($1), ($2)',
			parameters: ['Alice', 'Bob'],
		}));
		const orm = createOrm({ schema: testSchema, adapter });

		// Act
		const builder = orm
			.insert('users')
			.values([{ name: 'Alice' }, { name: 'Bob' }]);
		const dump = builder.dump();

		// Assert
		expect(dump.intent.values).toHaveLength(2);
	});

	it('should include schemaName in dump meta when provided', () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compileInsert = vi.fn(() => ({
			sql: 'INSERT INTO tenant_1.users (name) VALUES ($1)',
			parameters: ['Alice'],
		}));
		adapter.withSchema = vi.fn(() => adapter);
		const orm = createOrm({ schema: testSchema, adapter });

		// Act
		const builder = orm
			.withSchema('tenant_1')
			.insert('users')
			.values({ name: 'Alice' });
		const dump = builder.dump();

		// Assert
		expect(dump.meta?.schema).toBe('tenant_1');
	});

	it('should not include schema in dump meta when not provided', () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compileInsert = vi.fn(() => ({
			sql: 'INSERT INTO users (name) VALUES ($1)',
			parameters: ['Alice'],
		}));
		const orm = createOrm({ schema: testSchema, adapter });

		// Act
		const builder = orm.insert('users').values({ name: 'Alice' });
		const dump = builder.dump();

		// Assert
		expect(dump.meta?.schema).toBeUndefined();
	});

	it('should execute without returning and return undefined', async () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compileInsert = vi.fn(() => ({
			sql: 'INSERT INTO users (name) VALUES ($1)',
			parameters: ['Alice'],
		}));
		adapter.execute = vi.fn(() => Promise.resolve([]));
		const orm = createOrm({ schema: testSchema, adapter });

		// Act
		const builder = orm.insert('users').values({ name: 'Alice' });
		const result = await builder.execute();

		// Assert
		expect(result).toBeUndefined();
	});

	it('should execute with returning and return results', async () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compileInsert = vi.fn(() => ({
			sql: 'INSERT INTO users (name) VALUES ($1) RETURNING id',
			parameters: ['Alice'],
		}));
		adapter.execute = vi.fn(() => Promise.resolve([{ id: 1 }]));
		const orm = createOrm({ schema: testSchema, adapter });

		// Act
		const builder = orm
			.insert('users')
			.values({ name: 'Alice' })
			.returning(['id']);
		const result = await builder.execute();

		// Assert
		expect(result).toEqual([{ id: 1 }]);
	});
});

// ============================================================================
// UpdateBuilder: WHERE chains and allowAll
// ============================================================================

describe('UpdateBuilder coverage', () => {
	it('should merge multiple set() calls', () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compileUpdate = vi.fn(() => ({
			sql: 'UPDATE users SET name = $1, email = $2',
			parameters: ['Alice', 'alice@example.com'],
		}));
		const orm = createOrm({ schema: testSchema, adapter });

		// Act
		const builder = orm
			.update('users')
			.set({ name: 'Alice' })
			.set({ email: 'alice@example.com' })
			.where({ kind: 'comparison', field: 'id', operator: 'eq', value: 1 });
		const dump = builder.dump();

		// Assert
		expect(dump.intent.set).toEqual({
			name: 'Alice',
			email: 'alice@example.com',
		});
	});

	it('should overwrite previous values in set() with last value wins', () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compileUpdate = vi.fn(() => ({
			sql: 'UPDATE users SET name = $1',
			parameters: ['Bob'],
		}));
		const orm = createOrm({ schema: testSchema, adapter });

		// Act
		const builder = orm
			.update('users')
			.set({ name: 'Alice' })
			.set({ name: 'Bob' })
			.where({ kind: 'comparison', field: 'id', operator: 'eq', value: 1 });
		const dump = builder.dump();

		// Assert
		expect(dump.intent.set.name).toBe('Bob');
	});

	it('should build intent with where clause', () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compileUpdate = vi.fn(() => ({
			sql: 'UPDATE users SET name = $1 WHERE id = $2',
			parameters: ['Alice', 1],
		}));
		const orm = createOrm({ schema: testSchema, adapter });

		// Act
		const builder = orm
			.update('users')
			.set({ name: 'Alice' })
			.where({ kind: 'comparison', field: 'id', operator: 'eq', value: 1 });
		const dump = builder.dump();

		// Assert
		expect(dump.intent.where).toBeDefined();
	});

	it('should build intent with allowAll when using updateAll()', () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compileUpdate = vi.fn(() => ({
			sql: 'UPDATE users SET active = $1',
			parameters: [false],
		}));
		const orm = createOrm({ schema: testSchema, adapter });

		// Act
		const builder = orm.updateAll('users').set({ active: false });
		const dump = builder.dump();

		// Assert
		expect(dump.intent.allowAll).toBe(true);
		expect(dump.intent.where).toBeUndefined();
	});

	it('should include returning columns when specified', () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compileUpdate = vi.fn(() => ({
			sql: 'UPDATE users SET name = $1 WHERE id = $2 RETURNING id, name',
			parameters: ['Alice', 1],
		}));
		const orm = createOrm({ schema: testSchema, adapter });

		// Act
		const builder = orm
			.update('users')
			.set({ name: 'Alice' })
			.where({ kind: 'comparison', field: 'id', operator: 'eq', value: 1 })
			.returning(['id', 'name']);
		const dump = builder.dump();

		// Assert
		expect(dump.intent.returning).toEqual(['id', 'name']);
	});

	it('should execute without returning and return undefined', async () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compileUpdate = vi.fn(() => ({
			sql: 'UPDATE users SET name = $1 WHERE id = $2',
			parameters: ['Alice', 1],
		}));
		adapter.execute = vi.fn(() => Promise.resolve([]));
		const orm = createOrm({ schema: testSchema, adapter });

		// Act
		const builder = orm
			.update('users')
			.set({ name: 'Alice' })
			.where({ kind: 'comparison', field: 'id', operator: 'eq', value: 1 });
		const result = await builder.execute();

		// Assert
		expect(result).toBeUndefined();
	});

	it('should execute with returning and return results', async () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compileUpdate = vi.fn(() => ({
			sql: 'UPDATE users SET name = $1 WHERE id = $2 RETURNING id',
			parameters: ['Alice', 1],
		}));
		adapter.execute = vi.fn(() => Promise.resolve([{ id: 1 }]));
		const orm = createOrm({ schema: testSchema, adapter });

		// Act
		const builder = orm
			.update('users')
			.set({ name: 'Alice' })
			.where({ kind: 'comparison', field: 'id', operator: 'eq', value: 1 })
			.returning(['id']);
		const result = await builder.execute();

		// Assert
		expect(result).toEqual([{ id: 1 }]);
	});
});

// ============================================================================
// DeleteBuilder: cascade options
// ============================================================================

describe('DeleteBuilder coverage', () => {
	it('should build intent with cascade = true (all relations)', () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compileDelete = vi.fn(() => ({
			sql: 'DELETE FROM users WHERE id = $1',
			parameters: [1],
		}));
		const orm = createOrm({ schema: testSchema, adapter });

		// Act
		const builder = orm
			.delete('users')
			.where({ kind: 'comparison', field: 'id', operator: 'eq', value: 1 })
			.cascade();
		const dump = builder.dump();

		// Assert
		expect(dump.intent.cascade).toBe(true);
	});

	it('should build intent with cascade = array of relation names', () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compileDelete = vi.fn(() => ({
			sql: 'DELETE FROM users WHERE id = $1',
			parameters: [1],
		}));
		const orm = createOrm({ schema: testSchema, adapter });

		// Act
		const builder = orm
			.delete('users')
			.where({ kind: 'comparison', field: 'id', operator: 'eq', value: 1 })
			.cascade(['posts']);
		const dump = builder.dump();

		// Assert
		expect(dump.intent.cascade).toEqual(['posts']);
	});

	it('should build intent without cascade when not specified', () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compileDelete = vi.fn(() => ({
			sql: 'DELETE FROM users WHERE id = $1',
			parameters: [1],
		}));
		const orm = createOrm({ schema: testSchema, adapter });

		// Act
		const builder = orm
			.delete('users')
			.where({ kind: 'comparison', field: 'id', operator: 'eq', value: 1 });
		const dump = builder.dump();

		// Assert
		expect(dump.intent.cascade).toBeUndefined();
	});

	it('should build intent with allowAll when using deleteAll()', () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compileDelete = vi.fn(() => ({
			sql: 'DELETE FROM users',
			parameters: [],
		}));
		const orm = createOrm({ schema: testSchema, adapter });

		// Act
		const builder = orm.deleteAll('users');
		const dump = builder.dump();

		// Assert
		expect(dump.intent.allowAll).toBe(true);
		expect(dump.intent.where).toBeUndefined();
	});

	it('should include returning columns when specified', () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compileDelete = vi.fn(() => ({
			sql: 'DELETE FROM users WHERE id = $1 RETURNING id, email',
			parameters: [1],
		}));
		const orm = createOrm({ schema: testSchema, adapter });

		// Act
		const builder = orm
			.delete('users')
			.where({ kind: 'comparison', field: 'id', operator: 'eq', value: 1 })
			.returning(['id', 'email']);
		const dump = builder.dump();

		// Assert
		expect(dump.intent.returning).toEqual(['id', 'email']);
	});

	it('should execute without returning and return undefined', async () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compileDelete = vi.fn(() => ({
			sql: 'DELETE FROM users WHERE id = $1',
			parameters: [1],
		}));
		adapter.execute = vi.fn(() => Promise.resolve([]));
		const orm = createOrm({ schema: testSchema, adapter });

		// Act
		const builder = orm
			.delete('users')
			.where({ kind: 'comparison', field: 'id', operator: 'eq', value: 1 });
		const result = await builder.execute();

		// Assert
		expect(result).toBeUndefined();
	});

	it('should execute with returning and return results', async () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compileDelete = vi.fn(() => ({
			sql: 'DELETE FROM users WHERE id = $1 RETURNING id',
			parameters: [1],
		}));
		adapter.execute = vi.fn(() => Promise.resolve([{ id: 1 }]));
		const orm = createOrm({ schema: testSchema, adapter });

		// Act
		const builder = orm
			.delete('users')
			.where({ kind: 'comparison', field: 'id', operator: 'eq', value: 1 })
			.returning(['id']);
		const result = await builder.execute();

		// Assert
		expect(result).toEqual([{ id: 1 }]);
	});
});

// ============================================================================
// UpsertBuilder: conflict resolution branches
// ============================================================================

describe('UpsertBuilder coverage', () => {
	it('should build intent with onConflict columns', () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compileUpsert = vi.fn(() => ({
			sql: 'INSERT INTO users (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
			parameters: [1, 'Alice'],
		}));
		const orm = createOrm({ schema: testSchema, adapter });

		// Act
		const builder = orm
			.upsert('users')
			.values({ id: 1, name: 'Alice' })
			.onConflict(['id'])
			.doNothing();
		const dump = builder.dump();

		// Assert
		expect(dump.intent.onConflict).toEqual({ columns: ['id'] });
	});

	it('should build intent with onConflictConstraint', () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compileUpsert = vi.fn(() => ({
			sql: 'INSERT INTO users (id, name) VALUES ($1, $2) ON CONFLICT ON CONSTRAINT users_pkey DO NOTHING',
			parameters: [1, 'Alice'],
		}));
		const orm = createOrm({ schema: testSchema, adapter });

		// Act
		const builder = orm
			.upsert('users')
			.values({ id: 1, name: 'Alice' })
			.onConflictConstraint('users_pkey')
			.doNothing();
		const dump = builder.dump();

		// Assert
		expect(dump.intent.onConflict).toEqual({ constraint: 'users_pkey' });
	});

	it('should build intent with doNothing action', () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compileUpsert = vi.fn(() => ({
			sql: 'INSERT INTO users (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
			parameters: [1, 'Alice'],
		}));
		const orm = createOrm({ schema: testSchema, adapter });

		// Act
		const builder = orm
			.upsert('users')
			.values({ id: 1, name: 'Alice' })
			.onConflict(['id'])
			.doNothing();
		const dump = builder.dump();

		// Assert
		expect(dump.intent.action).toEqual({ type: 'doNothing' });
	});

	it('should build intent with doUpdate action without set', () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compileUpsert = vi.fn(() => ({
			sql: 'INSERT INTO users (id, name) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name',
			parameters: [1, 'Alice'],
		}));
		const orm = createOrm({ schema: testSchema, adapter });

		// Act
		const builder = orm
			.upsert('users')
			.values({ id: 1, name: 'Alice' })
			.onConflict(['id'])
			.doUpdate();
		const dump = builder.dump();

		// Assert
		expect(dump.intent.action.type).toBe('doUpdate');
		expect(dump.intent.action).not.toHaveProperty('set');
	});

	it('should build intent with doUpdate action with explicit set', () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compileUpsert = vi.fn(() => ({
			sql: 'INSERT INTO users (id, name) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET name = $3',
			parameters: [1, 'Alice', 'Alice Updated'],
		}));
		const orm = createOrm({ schema: testSchema, adapter });

		// Act
		const builder = orm
			.upsert('users')
			.values({ id: 1, name: 'Alice' })
			.onConflict(['id'])
			.doUpdate({ name: 'Alice Updated' });
		const dump = builder.dump();

		// Assert
		expect(dump.intent.action).toEqual({
			type: 'doUpdate',
			set: { name: 'Alice Updated' },
		});
	});

	it('should build intent with doUpdate action with where clause', () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compileUpsert = vi.fn(() => ({
			sql: 'INSERT INTO users (id, name) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name WHERE active = true',
			parameters: [1, 'Alice'],
		}));
		const orm = createOrm({ schema: testSchema, adapter });

		// Act
		const whereClause = {
			kind: 'comparison' as const,
			field: 'active',
			operator: 'eq' as const,
			value: true,
		};
		const builder = orm
			.upsert('users')
			.values({ id: 1, name: 'Alice' })
			.onConflict(['id'])
			.doUpdate(undefined, whereClause);
		const dump = builder.dump();

		// Assert
		expect(dump.intent.action).toEqual({
			type: 'doUpdate',
			where: whereClause,
		});
	});

	it('should handle bulk upsert with array of values', () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compileUpsert = vi.fn(() => ({
			sql: 'INSERT INTO users (id, name) VALUES ($1, $2), ($3, $4) ON CONFLICT (id) DO NOTHING',
			parameters: [1, 'Alice', 2, 'Bob'],
		}));
		const orm = createOrm({ schema: testSchema, adapter });

		// Act
		const builder = orm
			.upsert('users')
			.values([
				{ id: 1, name: 'Alice' },
				{ id: 2, name: 'Bob' },
			])
			.onConflict(['id'])
			.doNothing();
		const dump = builder.dump();

		// Assert
		expect(dump.intent.values).toHaveLength(2);
	});

	it('should include returning columns when specified', () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compileUpsert = vi.fn(() => ({
			sql: 'INSERT INTO users (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING RETURNING id, name',
			parameters: [1, 'Alice'],
		}));
		const orm = createOrm({ schema: testSchema, adapter });

		// Act
		const builder = orm
			.upsert('users')
			.values({ id: 1, name: 'Alice' })
			.onConflict(['id'])
			.doNothing()
			.returning(['id', 'name']);
		const dump = builder.dump();

		// Assert
		expect(dump.intent.returning).toEqual(['id', 'name']);
	});

	it('should execute without returning and return undefined', async () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compileUpsert = vi.fn(() => ({
			sql: 'INSERT INTO users (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
			parameters: [1, 'Alice'],
		}));
		adapter.execute = vi.fn(() => Promise.resolve([]));
		const orm = createOrm({ schema: testSchema, adapter });

		// Act
		const builder = orm
			.upsert('users')
			.values({ id: 1, name: 'Alice' })
			.onConflict(['id'])
			.doNothing();
		const result = await builder.execute();

		// Assert
		expect(result).toBeUndefined();
	});

	it('should execute with returning and return results', async () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compileUpsert = vi.fn(() => ({
			sql: 'INSERT INTO users (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING RETURNING id',
			parameters: [1, 'Alice'],
		}));
		adapter.execute = vi.fn(() => Promise.resolve([{ id: 1 }]));
		const orm = createOrm({ schema: testSchema, adapter });

		// Act
		const builder = orm
			.upsert('users')
			.values({ id: 1, name: 'Alice' })
			.onConflict(['id'])
			.doNothing()
			.returning(['id']);
		const result = await builder.execute();

		// Assert
		expect(result).toEqual([{ id: 1 }]);
	});
});

// ============================================================================
// Hook interactions
// ============================================================================

describe('Mutation builders with hooks', () => {
	it('should fire afterMutation hooks even without RETURNING clause', async () => {
		// Arrange
		let hookFired = false;
		const adapter = createMockAdapter();
		adapter.compileInsert = vi.fn(() => ({
			sql: 'INSERT INTO users (name) VALUES ($1)',
			parameters: ['Alice'],
		}));
		adapter.execute = vi.fn(() => Promise.resolve([]));

		const { createHookManager } = await import('./hooks.js');
		const hooks = createHookManager().afterMutation(() => {
			hookFired = true;
			return [];
		});

		const orm = createOrm({
			schema: testSchema,
			adapter,
			hooks,
		});

		// Act
		await orm.insert('users').values({ name: 'Alice' }).execute();

		// Assert
		expect(hookFired).toBe(true);
	});
});

// ============================================================================
// dump() metadata
// ============================================================================

describe('dump() metadata', () => {
	it('should include compiledAt timestamp in dump meta', () => {
		// Arrange
		const adapter = createMockAdapter();
		adapter.compileInsert = vi.fn(() => ({
			sql: 'INSERT INTO users (name) VALUES ($1)',
			parameters: ['Alice'],
		}));
		const orm = createOrm({ schema: testSchema, adapter });

		// Act
		const builder = orm.insert('users').values({ name: 'Alice' });
		const dump = builder.dump();

		// Assert
		expect(dump.meta?.compiledAt).toBeInstanceOf(Date);
	});
});
