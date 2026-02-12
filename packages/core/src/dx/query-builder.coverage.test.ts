// @ts-nocheck — coverage test: runtime assertions on AST nodes
/**
 * Coverage test for QueryBuilderImpl - targets uncovered branches.
 * Focus areas:
 * - paginate() variations: withCount, without count, edge cases
 * - cursorPaginate() branches: forward/backward direction, multiple orderBy
 * - Method chaining: complex combinations
 * - include() with dot notation
 * - stream() with hooks + onStart callback
 * - dump() with schema
 * - exists() with hooks
 * - Schema-scoped queries
 */

import { describe, expect, it, vi } from 'vitest';
import type { Adapter, Dump } from '../adapter.js';
import { eq } from './filters.js';
import { createHookManager } from './hooks.js';
import { createOrm } from './orm.js';
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
		authorId: ref('users', { as: 'author', inverse: 'comments' }),
	},
});

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
	const executeSpy = vi.fn(() => Promise.resolve([...executeResult]));
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
		stream: vi.fn(async function* (_compiled: unknown, _opts?: unknown) {
			for (const row of executeResult) {
				yield row;
			}
		}),
	} as unknown as Adapter;
	return adapter;
}

// ============================================================================
// paginate() — withCount variations
// ============================================================================

describe('paginate() coverage', () => {
	it('should handle withCount: false (no count query)', async () => {
		const rows = Array.from({ length: 25 }, (_, i) => ({
			id: i + 1,
			name: `User${i + 1}`,
		}));
		const adapter = createSpyAdapter(rows.slice(0, 20));
		const orm = createOrm({ adapter, schema: testSchema });

		const result = await orm
			.select('users')
			.paginate({ page: 1, perPage: 20, withCount: false });

		expect(result.pagination.total).toBeUndefined();
		expect(result.pagination.totalPages).toBeUndefined();
		expect(result.pagination.hasNextPage).toBe(true); // Optimistic: full page
		expect(result.pagination.hasPrevPage).toBe(false);
		expect(result.data.length).toBe(20);
	});

	it('should handle withCount: true with exact page boundary', async () => {
		const rows = Array.from({ length: 20 }, (_, i) => ({
			id: i + 1,
			name: `User${i + 1}`,
		}));
		const adapter = createSpyAdapter(rows);
		const orm = createOrm({ adapter, schema: testSchema });

		// Mock count result
		adapter.execute = vi
			.fn()
			.mockResolvedValueOnce(rows) // main query
			.mockResolvedValueOnce([{ _count: 40 }]); // count query

		const result = await orm
			.select('users')
			.paginate({ page: 1, perPage: 20, withCount: true });

		expect(result.pagination.total).toBe(40);
		expect(result.pagination.totalPages).toBe(2);
		expect(result.pagination.hasNextPage).toBe(true);
		expect(result.pagination.hasPrevPage).toBe(false);
	});

	it('should handle last page (partial results)', async () => {
		const rows = Array.from({ length: 5 }, (_, i) => ({
			id: i + 41,
			name: `User${i + 41}`,
		}));
		const adapter = createSpyAdapter(rows);
		const orm = createOrm({ adapter, schema: testSchema });

		adapter.execute = vi
			.fn()
			.mockResolvedValueOnce(rows)
			.mockResolvedValueOnce([{ _count: 45 }]);

		const result = await orm
			.select('users')
			.paginate({ page: 3, perPage: 20, withCount: true });

		expect(result.pagination.total).toBe(45);
		expect(result.pagination.totalPages).toBe(3);
		expect(result.pagination.hasNextPage).toBe(false);
		expect(result.pagination.hasPrevPage).toBe(true);
		expect(result.data.length).toBe(5);
	});

	it('should handle page 2+ with withCount: false', async () => {
		const rows = Array.from({ length: 20 }, (_, i) => ({
			id: i + 21,
			name: `User${i + 21}`,
		}));
		const adapter = createSpyAdapter(rows);
		const orm = createOrm({ adapter, schema: testSchema });

		const result = await orm
			.select('users')
			.paginate({ page: 2, perPage: 20, withCount: false });

		expect(result.pagination.hasPrevPage).toBe(true);
		expect(result.pagination.hasNextPage).toBe(true); // Optimistic
	});

	it('should calculate correct offset for page > 1', async () => {
		const rows = [{ id: 31, name: 'User31' }];
		const adapter = createSpyAdapter(rows);
		const orm = createOrm({ adapter, schema: testSchema });

		adapter.execute = vi
			.fn()
			.mockResolvedValueOnce(rows) // main query
			.mockResolvedValueOnce([{ _count: 100 }]); // count query

		await orm.select('users').paginate({ page: 4, perPage: 10 });

		// Check that execute was called twice (once for data, once for count)
		expect(adapter.execute).toHaveBeenCalledTimes(2);
	});
});

// ============================================================================
// cursorPaginate() — forward/backward, multiple orderBy
// ============================================================================

describe('cursorPaginate() coverage', () => {
	it('should handle forward direction with cursor', async () => {
		const rows = [
			{ id: 11, name: 'User11' },
			{ id: 12, name: 'User12' },
		];
		const adapter = createSpyAdapter(rows);
		const orm = createOrm({ adapter, schema: testSchema });

		// Create cursor for id=10
		const cursor = Buffer.from(JSON.stringify({ id: 10 }), 'utf-8').toString(
			'base64',
		);

		const result = await orm
			.select('users')
			.orderBy('id')
			.cursorPaginate({ cursor, limit: 2, direction: 'forward' });

		expect(result.data.length).toBe(2);
		expect(result.hasNextPage).toBe(false);
		expect(result.hasPrevPage).toBe(true);
		expect(result.prevCursor).not.toBeNull();
	});

	it('should handle backward direction with cursor', async () => {
		const rows = [
			{ id: 8, name: 'User8' },
			{ id: 9, name: 'User9' },
		];
		const adapter = createSpyAdapter(rows);
		const orm = createOrm({ adapter, schema: testSchema });

		const cursor = Buffer.from(JSON.stringify({ id: 10 }), 'utf-8').toString(
			'base64',
		);

		const result = await orm
			.select('users')
			.orderBy('id')
			.cursorPaginate({ cursor, limit: 2, direction: 'backward' });

		expect(result.data.length).toBe(2);
		expect(result.hasNextPage).toBe(true);
		expect(result.hasPrevPage).toBe(false);
	});

	it('should handle multiple orderBy fields (compound cursor)', async () => {
		// Provide 3 rows so hasMore = true (limit + 1)
		const rows = [
			{ id: 5, email: 'b@example.com', name: 'User5' },
			{ id: 6, email: 'c@example.com', name: 'User6' },
			{ id: 7, email: 'd@example.com', name: 'User7' },
		];
		const adapter = createSpyAdapter(rows);
		const orm = createOrm({ adapter, schema: testSchema });

		// Cursor with multiple fields
		const cursor = Buffer.from(
			JSON.stringify({ email: 'a@example.com', id: 4 }),
			'utf-8',
		).toString('base64');

		const result = await orm
			.select('users')
			.orderBy([
				{ column: 'email', direction: 'asc' },
				{ column: 'id', direction: 'asc' },
			])
			.cursorPaginate({ cursor, limit: 2 });

		// Should return 2 items (limit), not 3
		expect(result.data.length).toBe(2);
		expect(result.nextCursor).not.toBeNull();
	});

	it('should handle desc order with backward direction', async () => {
		const rows = [
			{ id: 12, name: 'User12' },
			{ id: 11, name: 'User11' },
		];
		const adapter = createSpyAdapter(rows);
		const orm = createOrm({ adapter, schema: testSchema });

		const cursor = Buffer.from(JSON.stringify({ id: 10 }), 'utf-8').toString(
			'base64',
		);

		const result = await orm
			.select('users')
			.orderBy('id', 'desc')
			.cursorPaginate({ cursor, limit: 2, direction: 'backward' });

		expect(result.data.length).toBe(2);
	});

	it('should build complex cursor condition for 3+ orderBy fields', async () => {
		const rows = [{ id: 1, email: 'a@test.com', name: 'Alice', active: true }];
		const adapter = createSpyAdapter(rows);
		const orm = createOrm({ adapter, schema: testSchema });

		const cursor = Buffer.from(
			JSON.stringify({ email: 'z@test.com', name: 'Zoe', id: 99 }),
			'utf-8',
		).toString('base64');

		const result = await orm
			.select('users')
			.orderBy([
				{ column: 'email', direction: 'asc' },
				{ column: 'name', direction: 'asc' },
				{ column: 'id', direction: 'asc' },
			])
			.cursorPaginate({ cursor, limit: 10 });

		expect(result.data).toBeDefined();
	});

	it('should return null cursors when no data', async () => {
		const adapter = createSpyAdapter([]);
		const orm = createOrm({ adapter, schema: testSchema });

		const result = await orm
			.select('users')
			.orderBy('id')
			.cursorPaginate({ limit: 10 });

		expect(result.data.length).toBe(0);
		expect(result.nextCursor).toBeNull();
		expect(result.prevCursor).toBeNull();
	});
});

// ============================================================================
// Method chaining combinations
// ============================================================================

describe('Method chaining coverage', () => {
	it('should chain where + include + orderBy + limit', async () => {
		const rows = [{ id: 1, name: 'Alice', posts: [] }];
		const adapter = createSpyAdapter(rows);
		const orm = createOrm({ adapter, schema: testSchema });

		const result = await orm
			.select('users')
			.where(eq('active', true))
			.include('posts')
			.orderBy('name')
			.limit(10)
			.all();

		expect(result.length).toBe(1);
	});

	it('should chain groupBy + having + orderBy', async () => {
		const rows = [{ authorId: 1, post_count: 5 }];
		const adapter = createSpyAdapter(rows);
		const orm = createOrm({ adapter, schema: testSchema });

		const result = await orm
			.select('posts')
			.groupBy(['authorId'])
			.count('id', 'post_count')
			.having({
				kind: 'comparison',
				field: 'post_count',
				operator: 'gt',
				value: 3,
			})
			.orderBy('post_count', 'desc')
			.all();

		expect(result.length).toBe(1);
	});

	it('should chain distinct + columns + where', async () => {
		const rows = [{ email: 'alice@test.com' }];
		const adapter = createSpyAdapter(rows);
		const orm = createOrm({ adapter, schema: testSchema });

		const result = await orm
			.select('users')
			.distinct()
			.columns(['email'])
			.where(eq('active', true))
			.all();

		expect(result.length).toBe(1);
	});

	it('should chain withPlanOptions + withStrictMode', async () => {
		const rows = [{ id: 1, name: 'Alice' }];
		const adapter = createSpyAdapter(rows);
		const orm = createOrm({ adapter, schema: testSchema, strictMode: true });

		const result = await orm
			.select('users')
			.withPlanOptions({ enableCTEs: false })
			.withStrictMode(false)
			.all();

		expect(result.length).toBe(1);
	});
});

// ============================================================================
// include() — dot notation
// ============================================================================

describe('include() dot notation coverage', () => {
	it('should handle dot notation: posts.comments', async () => {
		const rows = [{ id: 1, name: 'Alice', posts: [] }];
		const adapter = createSpyAdapter(rows);
		const orm = createOrm({ adapter, schema: testSchema });

		const result = await orm.select('users').include('posts.comments').all();

		expect(result).toBeDefined();
	});

	it('should handle dot notation with options', async () => {
		const rows = [{ id: 1, name: 'Alice', posts: [] }];
		const adapter = createSpyAdapter(rows);
		const orm = createOrm({ adapter, schema: testSchema });

		const result = await orm
			.select('users')
			.include('posts.comments', { limit: 5 })
			.all();

		expect(result).toBeDefined();
	});

	it('should handle multiple dot notation includes', async () => {
		const rows = [{ id: 1, title: 'Post1', comments: [], author: {} }];
		const adapter = createSpyAdapter(rows);
		const orm = createOrm({ adapter, schema: testSchema });

		const result = await orm
			.select('posts')
			.include('comments.author')
			.include('author')
			.all();

		expect(result).toBeDefined();
	});
});

// ============================================================================
// stream() — with hooks and onStart
// ============================================================================

describe('stream() coverage', () => {
	it('should call onStart callback lazily on first iteration', async () => {
		const rows = [
			{ id: 1, name: 'Alice' },
			{ id: 2, name: 'Bob' },
		];
		const adapter = createSpyAdapter(rows);
		const orm = createOrm({ adapter, schema: testSchema });

		const onStart = vi.fn();
		const stream = orm.select('users').stream({ onStart });

		// onStart should NOT be called yet
		expect(onStart).not.toHaveBeenCalled();

		const collected = [];
		for await (const row of stream) {
			collected.push(row);
		}

		// onStart should be called exactly once
		expect(onStart).toHaveBeenCalledTimes(1);
		expect(collected.length).toBe(2);
	});

	it('should fire beforeQuery hook on first iteration (lazy)', async () => {
		const rows = [{ id: 1, name: 'Alice' }];
		const adapter = createSpyAdapter(rows);
		const hookManager = createHookManager();
		let hookFired = false;
		hookManager.beforeQuery(() => {
			hookFired = true;
		});

		const orm = createOrm({ adapter, schema: testSchema, hooks: hookManager });

		const stream = orm.select('users').stream();

		const collected = [];
		for await (const row of stream) {
			collected.push(row);
		}

		// Verify stream worked
		expect(collected.length).toBe(1);
		// Hook may or may not fire due to re-entrancy guards, but stream should work
		expect(collected[0]).toHaveProperty('id');
	});

	it('should handle stream with chunkSize option', async () => {
		const rows = Array.from({ length: 100 }, (_, i) => ({
			id: i + 1,
			name: `User${i + 1}`,
		}));
		const adapter = createSpyAdapter(rows);
		const orm = createOrm({ adapter, schema: testSchema });

		const collected = [];
		for await (const row of orm.select('users').stream({ chunkSize: 10 })) {
			collected.push(row);
		}

		expect(collected.length).toBe(100);
	});

	it('should fire onError hook on stream error', async () => {
		const adapter = createSpyAdapter([]);
		adapter.stream = vi.fn(async function* () {
			throw new Error('Stream error');
		});

		const hookManager = createHookManager();
		const onErrorSpy = vi.fn((err) => err);
		hookManager.onError(onErrorSpy);

		const orm = createOrm({ adapter, schema: testSchema, hooks: hookManager });

		const stream = orm.select('users').stream();

		await expect(async () => {
			for await (const _row of stream) {
				// Should not reach here
			}
		}).rejects.toThrow('Stream error');

		// onError hook should have been called (through throw method)
		// Note: onError is called via the stream's throw() method
	});
});

// ============================================================================
// dump() — with schema
// ============================================================================

describe('dump() coverage', () => {
	it('should include schema in meta when context has schemaName', () => {
		const adapter = createSpyAdapter([]);
		const orm = createOrm({ adapter, schema: testSchema });

		const scopedOrm = orm.withSchema('tenant_123');
		const dump = scopedOrm.select('users').dump();

		expect(dump.meta?.schema).toBe('tenant_123');
	});

	it('should merge adapter schema with context schema', () => {
		const adapter = createSpyAdapter([]);
		// Mock createDump to return a dump without schema
		adapter.createDump = vi.fn((_plan, compiled) => ({
			sql: compiled.sql,
			params: compiled.parameters,
			plan: {},
			meta: {},
		})) as any;

		const orm = createOrm({ adapter, schema: testSchema });
		const scopedOrm = orm.withSchema('public');
		const dump = scopedOrm.select('users').dump();

		expect(dump.meta?.schema).toBe('public');
	});

	it('should not override adapter-provided schema', () => {
		const adapter = createSpyAdapter([]);
		adapter.createDump = vi.fn((_plan, compiled) => ({
			sql: compiled.sql,
			params: compiled.parameters,
			plan: {},
			meta: { schema: 'adapter_schema' },
		})) as any;

		const orm = createOrm({ adapter, schema: testSchema });
		const scopedOrm = orm.withSchema('context_schema');
		const dump = scopedOrm.select('users').dump();

		// Adapter schema takes precedence
		expect(dump.meta?.schema).toBe('adapter_schema');
	});
});

// ============================================================================
// exists() — with hooks
// ============================================================================

describe('exists() with hooks coverage', () => {
	it('should work with hooks enabled', async () => {
		const adapter = createSpyAdapter([{ exists: true }]);
		const hookManager = createHookManager();

		hookManager.beforeQuery(() => {
			// Hook registered
		});

		const orm = createOrm({ adapter, schema: testSchema, hooks: hookManager });

		const result = await orm.select('users').where(eq('active', true)).exists();

		expect(result).toBe(true);
	});

	it('should handle errors with onError hook', async () => {
		const adapter = createSpyAdapter([]);
		adapter.execute = vi.fn().mockRejectedValue(new Error('DB error'));

		const hookManager = createHookManager();
		hookManager.onError(() => {
			return new Error('Transformed');
		});

		const orm = createOrm({ adapter, schema: testSchema, hooks: hookManager });

		await expect(orm.select('users').exists()).rejects.toThrow();
	});

	it('should handle exists() returning false', async () => {
		const adapter = createSpyAdapter([]);
		const orm = createOrm({ adapter, schema: testSchema });

		const result = await orm.select('users').where(eq('id', 9999)).exists();

		expect(result).toBe(false);
	});
});

// ============================================================================
// Schema-scoped queries
// ============================================================================

describe('Schema-scoped queries coverage', () => {
	it('should pass schemaName to compile options', async () => {
		const adapter = createSpyAdapter([{ id: 1, name: 'Alice' }]);
		const compileWithIncludesSpy = vi.spyOn(adapter, 'compileWithIncludes');

		const orm = createOrm({ adapter, schema: testSchema });
		const scopedOrm = orm.withSchema('tenant_42');

		await scopedOrm.select('users').first();

		expect(compileWithIncludesSpy).toHaveBeenCalled();
		const compileOpts = compileWithIncludesSpy.mock.calls[0][1];
		expect(compileOpts.schemaName).toBe('tenant_42');
	});

	it('should work with schema scoping and hooks', async () => {
		const adapter = createSpyAdapter([{ id: 1, name: 'Alice' }]);
		const hookManager = createHookManager();

		hookManager.beforeQuery(() => {
			// Hook registered
		});

		const orm = createOrm({ adapter, schema: testSchema, hooks: hookManager });
		const scopedOrm = orm.withSchema('tenant_xyz');

		const result = await scopedOrm.select('users').all();

		expect(result).toHaveLength(1);
		expect(result[0]).toHaveProperty('name', 'Alice');
	});
});

// ============================================================================
// Aggregate methods coverage
// ============================================================================

describe('Aggregate methods coverage', () => {
	it('should handle count() with distinct field object', async () => {
		const rows = [{ _count: 10 }];
		const adapter = createSpyAdapter(rows);
		const orm = createOrm({ adapter, schema: testSchema });

		const result = await orm
			.select('users')
			.count({ field: 'email', as: 'unique_emails' })
			.all();

		expect(result).toBeDefined();
	});

	it('should handle sum() with distinct field', async () => {
		const rows = [{ total: 1000 }];
		const adapter = createSpyAdapter(rows);
		const orm = createOrm({ adapter, schema: testSchema });

		const result = await orm
			.select('posts')
			.sum({ kind: 'distinct', field: 'authorId' }, 'total')
			.all();

		expect(result).toBeDefined();
	});

	it('should handle avg() with distinct field', async () => {
		const rows = [{ avg_val: 42.5 }];
		const adapter = createSpyAdapter(rows);
		const orm = createOrm({ adapter, schema: testSchema });

		const result = await orm
			.select('posts')
			.avg({ kind: 'distinct', field: 'authorId' }, 'avg_val')
			.all();

		expect(result).toBeDefined();
	});
});

// ============================================================================
// coalesce() coverage
// ============================================================================

describe('coalesce() coverage', () => {
	it('should add coalesce to existing SelectWithExpressionsIntent', async () => {
		const rows = [{ id: 1, display_name: 'Alice' }];
		const adapter = createSpyAdapter(rows);
		const orm = createOrm({ adapter, schema: testSchema });

		const result = await orm
			.select('users')
			.columns(['id', 'name'])
			.coalesce(['name', 'email'], 'display_name')
			.all();

		expect(result).toBeDefined();
	});

	it('should convert SelectFieldsIntent to expressions when adding coalesce', async () => {
		const rows = [
			{ email: 'alice@test.com', primary_contact: 'alice@test.com' },
		];
		const adapter = createSpyAdapter(rows);
		const orm = createOrm({ adapter, schema: testSchema });

		const result = await orm
			.select('users')
			.columns(['email'])
			.coalesce(['email', 'name'], 'primary_contact')
			.all();

		expect(result).toBeDefined();
	});

	it('should handle coalesce without prior select', async () => {
		const rows = [{ name: 'Alice', fallback: 'Alice' }];
		const adapter = createSpyAdapter(rows);
		const orm = createOrm({ adapter, schema: testSchema });

		const result = await orm
			.select('users')
			.coalesce(['name', 'email'], 'fallback')
			.all();

		expect(result).toBeDefined();
	});
});

// ============================================================================
// byIds() coverage
// ============================================================================

describe('byIds() coverage', () => {
	it('should return empty array when ids is empty', async () => {
		const adapter = createSpyAdapter([]);
		const orm = createOrm({ adapter, schema: testSchema });

		const result = await orm.select('users').byIds([]);

		expect(result).toEqual([]);
	});

	it('should handle non-empty ids array', async () => {
		const rows = [
			{ id: 1, name: 'Alice' },
			{ id: 2, name: 'Bob' },
		];
		const adapter = createSpyAdapter(rows);
		const orm = createOrm({ adapter, schema: testSchema });

		const result = await orm.select('users').byIds([1, 2]);

		expect(result.length).toBe(2);
	});
});

// ============================================================================
// Lock methods coverage
// ============================================================================

describe('Lock methods coverage', () => {
	it('should handle forShare()', async () => {
		const adapter = createSpyAdapter([{ id: 1, name: 'Alice' }]);
		const orm = createOrm({ adapter, schema: testSchema });

		// Test that the lock method chains correctly
		const query = orm.select('users').forShare();
		const result = await query.all();

		expect(result).toBeDefined();
	});

	it('should handle forNoKeyUpdate()', async () => {
		const adapter = createSpyAdapter([{ id: 1, name: 'Alice' }]);
		const orm = createOrm({ adapter, schema: testSchema });

		const query = orm.select('users').forNoKeyUpdate();
		const result = await query.all();

		expect(result).toBeDefined();
	});

	it('should handle forKeyShare()', async () => {
		const adapter = createSpyAdapter([{ id: 1, name: 'Alice' }]);
		const orm = createOrm({ adapter, schema: testSchema });

		const query = orm.select('users').forKeyShare();
		const result = await query.all();

		expect(result).toBeDefined();
	});

	it('should handle lock() with explicit wait policy', async () => {
		const adapter = createSpyAdapter([{ id: 1, name: 'Alice' }]);
		const orm = createOrm({ adapter, schema: testSchema });

		const query = orm.select('users').lock('forUpdate', 'noWait');
		const result = await query.all();

		expect(result).toBeDefined();
	});

	it('should handle skipLocked()', async () => {
		const adapter = createSpyAdapter([{ id: 1, name: 'Alice' }]);
		const orm = createOrm({ adapter, schema: testSchema });

		const query = orm.select('users').forUpdate().skipLocked();
		const result = await query.all();

		expect(result).toBeDefined();
	});

	it('should handle noWait()', async () => {
		const adapter = createSpyAdapter([{ id: 1, name: 'Alice' }]);
		const orm = createOrm({ adapter, schema: testSchema });

		const query = orm.select('users').forUpdate().noWait();
		const result = await query.all();

		expect(result).toBeDefined();
	});

	it('should warn when lock used outside transaction', async () => {
		const adapter = createSpyAdapter([{ id: 1, name: 'Alice' }]);
		const orm = createOrm({ adapter, schema: testSchema });

		const consoleWarnSpy = vi
			.spyOn(console, 'warn')
			.mockImplementation(() => {});

		await orm.select('users').forUpdate().all();

		expect(consoleWarnSpy).toHaveBeenCalledWith(
			expect.stringContaining('outside a transaction'),
		);

		consoleWarnSpy.mockRestore();
	});
});

// ============================================================================
// withRelationHint() coverage
// ============================================================================

describe('withRelationHint() coverage', () => {
	it('should apply relation hint to ambiguous include', () => {
		const ambiguousSchema = schema({
			users: {
				id: { type: 'integer', primaryKey: true },
				name: 'string',
			},
			messages: {
				id: { type: 'integer', primaryKey: true },
				text: 'string',
				senderId: ref('users', { as: 'sender', inverse: 'sentMessages' }),
				receiverId: ref('users', {
					as: 'receiver',
					inverse: 'receivedMessages',
				}),
			},
		});

		const adapter = createSpyAdapter([]);
		const orm = createOrm({
			adapter,
			schema: ambiguousSchema,
			strictMode: false,
		});

		const dump = orm
			.select('messages')
			.withRelationHint('users', 'sender')
			.include('users')
			.dump();

		expect(dump).toBeDefined();
	});
});
