/**
 * @fileoverview Error path tests for QueryBuilderImpl.
 *
 * Covers:
 * - firstOrThrow: no results → NotFoundError
 * - byIdOrThrow: no match → NotFoundError
 * - buildPkCondition: empty composite PK
 * - paginate: page < 1, perPage < 1
 * - cursorPaginate: limit < 1, missing orderBy, invalid cursor
 * - getConfiguredAdapter: no adapter → ExecutionError
 * - handleAmbiguity: strict mode → AmbiguousRelationError
 * - Hook error chains: beforeQuery throws → onError fires
 */

import { describe, expect, it, vi } from 'vitest';
import type { Adapter, Dump } from '../adapter.js';
import {
	AmbiguousRelationError,
	ExecutionError,
	InvalidOperationError,
	NotFoundError,
} from './errors.js';
import { createHookManager } from './hooks.js';
import { createOrm } from './orm.js';
import { QueryBuilderImpl } from './query-builder.js';
import { ref, schema } from './schema.js';
import { createMockAdapter } from './test-utils.js';

// ============================================================================
// Test Schema
// ============================================================================

const testSchema = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		email: 'string',
		active: 'boolean',
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: 'string',
		authorId: ref('users', { as: 'author', inverse: 'posts' }),
	},
	comments: {
		id: { type: 'integer', primaryKey: true },
		text: 'text',
		postId: ref('posts', { as: 'post', inverse: 'comments' }),
	},
	order_lines: {
		order_id: 'integer',
		product_id: 'integer',
		quantity: 'integer',
	},
});

const orm = createOrm({ adapter: createMockAdapter(), schema: testSchema });

// ============================================================================
// Spy Adapter — returns configurable results
// ============================================================================

function createSpyAdapter(executeResult: unknown[] = []) {
	const base = createMockAdapter();
	const compileSpy = vi.fn((_plan: unknown, _opts?: unknown) => ({
		sql: 'SELECT * FROM "users"',
		parameters: [] as readonly unknown[],
	}));
	const compileWithIncludesSpy = vi.fn((_plan: unknown, _opts?: unknown) => ({
		main: {
			sql: 'SELECT * FROM "users"',
			parameters: [] as readonly unknown[],
		},
		subqueryIncludes: [],
	}));
	const executeSpy = vi.fn(() => Promise.resolve(executeResult));
	const createDumpSpy = vi.fn(
		(
			_plan: unknown,
			compiled: { sql: string; parameters: readonly unknown[] },
		) =>
			({
				sql: compiled.sql,
				params: compiled.parameters,
				plan: {},
			}) as unknown as Dump,
	);

	const adapter = {
		...base,
		compile: compileSpy,
		compileWithIncludes: compileWithIncludesSpy,
		execute: executeSpy,
		createDump: createDumpSpy,
		withSchema: (_schemaName: string) => adapter,
	} as unknown as Adapter;
	return adapter;
}

// ============================================================================
// firstOrThrow — NotFoundError
// ============================================================================

describe('firstOrThrow — error paths', () => {
	it('should throw NotFoundError when no results found', async () => {
		const adapter = createSpyAdapter([]);
		const ormWithSpy = createOrm({
			adapter,
			schema: testSchema,
		});

		await expect(ormWithSpy.select('users').firstOrThrow()).rejects.toThrow(
			NotFoundError,
		);
	});

	it('should include table name in NotFoundError', async () => {
		const adapter = createSpyAdapter([]);
		const ormWithSpy = createOrm({
			adapter,
			schema: testSchema,
		});

		await expect(ormWithSpy.select('users').firstOrThrow()).rejects.toThrow(
			/users/,
		);
	});

	it('should not throw when result exists', async () => {
		const adapter = createSpyAdapter([{ id: 1, name: 'Alice' }]);
		const ormWithSpy = createOrm({
			adapter,
			schema: testSchema,
		});

		const result = await ormWithSpy.select('users').firstOrThrow();
		expect(result).toEqual({ id: 1, name: 'Alice' });
	});
});

// ============================================================================
// byIdOrThrow — NotFoundError
// ============================================================================

describe('byIdOrThrow — error paths', () => {
	it('should throw NotFoundError when ID not found', async () => {
		const adapter = createSpyAdapter([]);
		const ormWithSpy = createOrm({
			adapter,
			schema: testSchema,
		});

		await expect(ormWithSpy.select('users').byIdOrThrow(999)).rejects.toThrow(
			NotFoundError,
		);
	});

	it('should include hint about primary key in NotFoundError', async () => {
		const adapter = createSpyAdapter([]);
		const ormWithSpy = createOrm({
			adapter,
			schema: testSchema,
		});

		await expect(ormWithSpy.select('users').byIdOrThrow(999)).rejects.toThrow(
			/primary key/i,
		);
	});
});

// ============================================================================
// buildPkCondition — composite PK errors
// ============================================================================

describe('buildPkCondition — composite PK error paths', () => {
	it('should throw when composite PK is empty object', async () => {
		const adapter = createSpyAdapter([]);
		const ormWithSpy = createOrm({
			adapter,
			schema: testSchema,
		});

		await expect(ormWithSpy.select('order_lines').byId({})).rejects.toThrow(
			'Composite primary key cannot be empty',
		);
	});
});

// ============================================================================
// paginate — validation errors
// ============================================================================

describe('paginate — error paths', () => {
	it('should throw InvalidOperationError when page < 1', async () => {
		await expect(
			orm.select('users').paginate({ page: 0, perPage: 10 }),
		).rejects.toThrow(InvalidOperationError);
	});

	it('should include "Page must be >= 1" in error message', async () => {
		// FIND-021: new message uses "positive safe integer" phrasing
		await expect(orm.select('users').paginate({ page: 0 })).rejects.toThrow(
			/page must be a positive safe integer/,
		);
	});

	it('should throw InvalidOperationError when page is negative', async () => {
		await expect(orm.select('users').paginate({ page: -1 })).rejects.toThrow(
			InvalidOperationError,
		);
	});

	it('should throw InvalidOperationError when perPage < 1', async () => {
		await expect(
			orm.select('users').paginate({ page: 1, perPage: 0 }),
		).rejects.toThrow(InvalidOperationError);
	});

	it('should include "perPage must be >= 1" in error message', async () => {
		// FIND-021: new message uses "positive safe integer" phrasing
		await expect(
			orm.select('users').paginate({ page: 1, perPage: 0 }),
		).rejects.toThrow(/perPage must be a positive safe integer/);
	});

	it('should throw when perPage is negative', async () => {
		await expect(
			orm.select('users').paginate({ page: 1, perPage: -5 }),
		).rejects.toThrow(InvalidOperationError);
	});
});

// ============================================================================
// cursorPaginate — validation errors
// ============================================================================

describe('cursorPaginate — error paths', () => {
	it('should throw InvalidOperationError when limit < 1', async () => {
		await expect(
			orm.select('users').orderBy('id').cursorPaginate({ limit: 0 }),
		).rejects.toThrow(InvalidOperationError);
	});

	it('should include "limit must be >= 1" in error message', async () => {
		// FIND-021: new message uses "positive safe integer" phrasing
		await expect(
			orm.select('users').orderBy('id').cursorPaginate({ limit: 0 }),
		).rejects.toThrow(/limit must be a positive safe integer/);
	});

	it('should throw when limit is negative', async () => {
		await expect(
			orm.select('users').orderBy('id').cursorPaginate({ limit: -1 }),
		).rejects.toThrow(InvalidOperationError);
	});

	it('should throw InvalidOperationError when orderBy is missing', async () => {
		await expect(
			orm.select('users').cursorPaginate({ limit: 10 }),
		).rejects.toThrow(InvalidOperationError);
	});

	it('should mention orderBy requirement in error message', async () => {
		await expect(
			orm.select('users').cursorPaginate({ limit: 10 }),
		).rejects.toThrow(/orderBy clause/);
	});

	it('should throw InvalidOperationError for invalid cursor string', async () => {
		await expect(
			orm
				.select('users')
				.orderBy('id')
				.cursorPaginate({ cursor: '!!!not-valid-base64!!!' }),
		).rejects.toThrow(InvalidOperationError);
	});

	it('should mention "Invalid cursor format" in error message', async () => {
		await expect(
			orm
				.select('users')
				.orderBy('id')
				.cursorPaginate({ cursor: '!!!not-base64!!!' }),
		).rejects.toThrow(/Invalid cursor format/);
	});

	it('should throw for cursor that is valid base64 but invalid JSON', async () => {
		// "not json" encoded as base64
		const badCursor = Buffer.from('not json at all').toString('base64');
		await expect(
			orm.select('users').orderBy('id').cursorPaginate({ cursor: badCursor }),
		).rejects.toThrow(InvalidOperationError);
	});
});

// ============================================================================
// getConfiguredAdapter — no adapter
// ============================================================================

describe('getConfiguredAdapter — error paths', () => {
	it('should throw ExecutionError when all() called without adapter', async () => {
		// Construct a QueryBuilderImpl directly without adapter
		const builder = new QueryBuilderImpl(
			{ model: testSchema.model, strictMode: false },
			'users',
		);

		await expect(builder.all()).rejects.toThrow(ExecutionError);
	});

	it('should include "Adapter not configured" in error message', async () => {
		const builder = new QueryBuilderImpl(
			{ model: testSchema.model, strictMode: false },
			'users',
		);

		await expect(builder.all()).rejects.toThrow(/Adapter not configured/);
	});

	it('should throw ExecutionError on first() without adapter', async () => {
		const builder = new QueryBuilderImpl(
			{ model: testSchema.model, strictMode: false },
			'users',
		);

		await expect(builder.first()).rejects.toThrow(ExecutionError);
	});
});

// ============================================================================
// handleAmbiguity — strict mode AmbiguousRelationError
// ============================================================================

describe('handleAmbiguity — strict mode', () => {
	// Create schema with ambiguous relations (multiple FKs to same table)
	const ambiguousSchema = schema({
		users: {
			id: { type: 'integer', primaryKey: true },
			name: 'string',
		},
		messages: {
			id: { type: 'integer', primaryKey: true },
			text: 'string',
			senderId: ref('users', { as: 'sender', inverse: 'sentMessages' }),
			receiverId: ref('users', { as: 'receiver', inverse: 'receivedMessages' }),
		},
	});

	it('should throw AmbiguousRelationError in strict mode for ambiguous include', () => {
		const strictOrm = createOrm({
			adapter: createMockAdapter(),
			schema: ambiguousSchema,
			strictMode: true,
		});

		expect(() => strictOrm.select('messages').include('users').plan()).toThrow(
			AmbiguousRelationError,
		);
	});

	it('should not throw in lenient mode for ambiguous include (adds warning)', () => {
		const lenientOrm = createOrm({
			adapter: createMockAdapter(),
			schema: ambiguousSchema,
			strictMode: false,
		});

		const planReport = lenientOrm.select('messages').include('users').plan();
		// In lenient mode, it should resolve automatically and add a warning
		expect(planReport.warnings.length).toBeGreaterThan(0);
		expect(planReport.warnings[0]?.code).toBe('AMBIGUOUS_RELATION');
	});
});

// ============================================================================
// Hook error chains — query builder
// ============================================================================

describe('Query hook error chains', () => {
	it('should fire onError when beforeQuery throws', async () => {
		const hookError = new Error('beforeQuery hook failed');
		const transformedError = new Error('Transformed by onError');

		const adapter = createSpyAdapter([{ id: 1 }]);
		const hookManager = createHookManager()
			.beforeQuery(() => {
				throw hookError;
			})
			.onError(() => transformedError);

		const ormWithHooks = createOrm({
			adapter,
			schema: testSchema,
			hooks: hookManager,
		});

		await expect(ormWithHooks.select('users').all()).rejects.toThrow(
			'Transformed by onError',
		);
	});

	it('should propagate original error when no onError hooks', async () => {
		const adapter = createSpyAdapter([{ id: 1 }]);
		const hookManager = createHookManager().beforeQuery(() => {
			throw new Error('hook boom');
		});

		const ormWithHooks = createOrm({
			adapter,
			schema: testSchema,
			hooks: hookManager,
		});

		await expect(ormWithHooks.select('users').all()).rejects.toThrow(
			'hook boom',
		);
	});

	it('should fire onError when afterQuery throws', async () => {
		const adapter = createSpyAdapter([{ id: 1, name: 'Alice' }]);
		const hookManager = createHookManager()
			.afterQuery(() => {
				throw new Error('afterQuery hook failed');
			})
			.onError(() => new Error('Transformed after'));

		const ormWithHooks = createOrm({
			adapter,
			schema: testSchema,
			hooks: hookManager,
		});

		await expect(ormWithHooks.select('users').all()).rejects.toThrow(
			'Transformed after',
		);
	});
});

// ============================================================================
// NotFoundError shape
// ============================================================================

describe('NotFoundError shape', () => {
	it('should have table property set', async () => {
		const adapter = createSpyAdapter([]);
		const ormWithSpy = createOrm({ adapter, schema: testSchema });

		try {
			await ormWithSpy.select('users').firstOrThrow();
			expect.unreachable('Should have thrown');
		} catch (error) {
			expect(error).toBeInstanceOf(NotFoundError);
			expect((error as NotFoundError).table).toBe('users');
		}
	});

	it('should have hint property on byIdOrThrow', async () => {
		const adapter = createSpyAdapter([]);
		const ormWithSpy = createOrm({ adapter, schema: testSchema });

		try {
			await ormWithSpy.select('users').byIdOrThrow(42);
			expect.unreachable('Should have thrown');
		} catch (error) {
			expect(error).toBeInstanceOf(NotFoundError);
			expect((error as NotFoundError).hint).toContain('primary key');
		}
	});
});
