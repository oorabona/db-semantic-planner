/**
 * @fileoverview Tests for .exists() and .existsDump() on QueryBuilder (DX-CATA-1 Block 1).
 * Acceptance criteria A1-A9.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Adapter, Dump } from '../adapter.js';
import { eq } from './filters.js';
import { createOrm } from './orm.js';
import { ref, schema } from './schema.js';
import { createMockAdapter } from './test-utils.js';

// ============================================================================
// Test Setup
// ============================================================================

const testSchema = schema({
	users: {
		id: 'uuid',
		name: 'string',
		email: 'string',
		active: 'boolean',
		role: 'string',
	},
	posts: {
		id: 'uuid',
		title: 'string',
		author: ref('users'),
	},
});

/**
 * Create a mock adapter that records compile calls and returns controllable execute results.
 */
function createSpyAdapter(executeResult: unknown[] = []) {
	const base = createMockAdapter();
	const compileSpy = vi.fn((_plan: unknown, _opts?: unknown) => ({
		sql: 'SELECT 1',
		parameters: [] as readonly unknown[],
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

	// Create a self-referential adapter so withSchema returns the same spy
	const adapter = {
		...base,
		compile: compileSpy,
		execute: executeSpy,
		createDump: createDumpSpy,
		withSchema: (_schemaName: string) => adapter, // Return self to preserve spies
		_spies: {
			compile: compileSpy,
			execute: executeSpy,
			createDump: createDumpSpy,
		},
	} as unknown as Adapter & {
		_spies: {
			compile: typeof compileSpy;
			execute: typeof executeSpy;
			createDump: typeof createDumpSpy;
		};
	};
	return adapter;
}

// ============================================================================
// Tests
// ============================================================================

describe('DX-CATA-1: .exists() and .existsDump()', () => {
	describe('A1: exists() returns true on non-empty result', () => {
		it('returns true when rows exist', async () => {
			const adapter = createSpyAdapter([{ exists: true }]);
			const orm = createOrm({ adapter, schema: testSchema });

			const result = await orm.select('users').exists();
			expect(result).toBe(true);
		});
	});

	describe('A2: exists() returns false when no match', () => {
		it('returns false when no rows match', async () => {
			const adapter = createSpyAdapter([{ exists: false }]);
			const orm = createOrm({ adapter, schema: testSchema });

			const result = await orm.select('users').where(eq('id', '999')).exists();
			expect(result).toBe(false);
		});
	});

	describe('A3: exists() returns false on empty table', () => {
		it('returns false when execute returns empty array', async () => {
			const adapter = createSpyAdapter([]);
			const orm = createOrm({ adapter, schema: testSchema });

			const result = await orm.select('users').exists();
			expect(result).toBe(false);
		});
	});

	describe('A5: existsDump() returns Dump', () => {
		it('returns a Dump object', () => {
			const adapter = createSpyAdapter();
			const orm = createOrm({ adapter, schema: testSchema });

			const dump = orm.select('users').where(eq('active', true)).existsDump();
			expect(dump).toBeDefined();
			expect(dump.sql).toBeDefined();
			expect(dump.params).toBeDefined();
		});
	});

	describe('A6: include is ignored in exists()', () => {
		it('strips include from the intent', async () => {
			const adapter = createSpyAdapter([{ exists: true }]);
			const orm = createOrm({ adapter, schema: testSchema });

			await orm.select('users').include('posts').exists();

			// Verify compile was called and inspect the plan's intent
			const compileCalls = (
				adapter as unknown as {
					_spies: { compile: { mock: { calls: unknown[][] } } };
				}
			)._spies.compile.mock.calls;
			expect(compileCalls.length).toBe(1);
			const firstCall = compileCalls[0];
			expect(firstCall).toBeDefined();
			const planArg = firstCall![0] as {
				intent?: { include?: unknown; existsWrap?: boolean };
			};
			expect(planArg.intent?.existsWrap).toBe(true);
			expect(planArg.intent?.include).toBeUndefined();
		});
	});

	describe('A7: groupBy and having are preserved in exists()', () => {
		it('preserves groupBy in the exists intent', async () => {
			const adapter = createSpyAdapter([{ exists: true }]);
			const orm = createOrm({ adapter, schema: testSchema });

			await orm
				.select('users')
				.groupBy(['role'])
				.having(eq('role', 'admin'))
				.exists();

			const compileCalls = (
				adapter as unknown as {
					_spies: { compile: { mock: { calls: unknown[][] } } };
				}
			)._spies.compile.mock.calls;
			const planArg = compileCalls[0]![0] as {
				intent?: { groupBy?: string[]; having?: unknown };
			};
			expect(planArg.intent?.groupBy).toEqual(['role']);
			expect(planArg.intent?.having).toBeDefined();
		});
	});

	describe('A8: orderBy is stripped in exists()', () => {
		it('removes orderBy from the exists intent', async () => {
			const adapter = createSpyAdapter([{ exists: true }]);
			const orm = createOrm({ adapter, schema: testSchema });

			await orm.select('users').orderBy('name').exists();

			const compileCalls = (
				adapter as unknown as {
					_spies: { compile: { mock: { calls: unknown[][] } } };
				}
			)._spies.compile.mock.calls;
			const planArg = compileCalls[0]![0] as {
				intent?: { orderBy?: unknown; existsWrap?: boolean };
			};
			expect(planArg.intent?.existsWrap).toBe(true);
			expect(planArg.intent?.orderBy).toBeUndefined();
		});
	});

	describe('A9: offset is preserved in exists()', () => {
		it('preserves offset in the exists intent', async () => {
			const adapter = createSpyAdapter([{ exists: true }]);
			const orm = createOrm({ adapter, schema: testSchema });

			await orm.select('users').offset(5).exists();

			const compileCalls = (
				adapter as unknown as {
					_spies: { compile: { mock: { calls: unknown[][] } } };
				}
			)._spies.compile.mock.calls;
			const planArg = compileCalls[0]![0] as { intent?: { offset?: number } };
			expect(planArg.intent?.offset).toBe(5);
		});
	});

	describe('exists sets limit to 1 and existsWrap to true', () => {
		it('sets limit=1 and existsWrap=true in the intent', async () => {
			const adapter = createSpyAdapter([{ exists: true }]);
			const orm = createOrm({ adapter, schema: testSchema });

			await orm.select('users').exists();

			const compileCalls = (
				adapter as unknown as {
					_spies: { compile: { mock: { calls: unknown[][] } } };
				}
			)._spies.compile.mock.calls;
			const planArg = compileCalls[0]![0] as {
				intent?: { limit?: number; existsWrap?: boolean };
			};
			expect(planArg.intent?.existsWrap).toBe(true);
			expect(planArg.intent?.limit).toBe(1);
		});
	});

	describe('A4: withSchema().exists() passes schemaName', () => {
		it('passes schemaName to adapter.compile', async () => {
			const adapter = createSpyAdapter([{ exists: true }]);
			const orm = createOrm({ adapter, schema: testSchema });

			await orm.withSchema('tenant_123').select('users').exists();

			const compileCalls = (
				adapter as unknown as {
					_spies: { compile: { mock: { calls: unknown[][] } } };
				}
			)._spies.compile.mock.calls;
			const options = compileCalls[0]![1] as { schemaName?: string };
			expect(options.schemaName).toBe('tenant_123');
		});
	});
});
