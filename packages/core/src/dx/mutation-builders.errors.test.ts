/**
 * @fileoverview Error path tests for mutation builders.
 *
 * Covers:
 * - InsertBuilder: no values → InvalidOperationError
 * - UpdateBuilder: no set fields, no where without allowAll → UnsafeOperationError
 * - DeleteBuilder: no where without allowAll → UnsafeOperationError
 * - UpsertBuilder: no values, no conflict target, no conflict action
 * - MutationBuilderBase: requireAdapter without adapter → ExecutionError
 * - Hook error chains: beforeMutation throws → onError fires
 */

import { describe, expect, it } from 'vitest';
import {
	ExecutionError,
	InvalidOperationError,
	UnsafeOperationError,
} from './errors.js';
import { createHookManager } from './hooks.js';
import {
	DeleteBuilder,
	InsertBuilder,
	type Updateable,
	UpdateBuilder,
	UpsertBuilder,
} from './mutation-builders.js';
import { createOrm } from './orm.js';
import type { OrmInstanceInternal } from './orm-instance-types.js';
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
});

// Cast to OrmInstanceInternal to access string-based mutation methods used in error tests.
// These are @internal APIs — external consumers use the typed entry points (into/modify/etc).
const orm = createOrm({
	adapter: createMockAdapter(),
	schema: testSchema,
}) as unknown as OrmInstanceInternal;

/**
 * Helper to build base options without adapter (for requireAdapter tests).
 */
function baseOptsNoAdapter() {
	return {
		table: 'users',
		model: testSchema.model,
		adapter: undefined,
		schemaName: undefined,
		hookStore: undefined,
		onHookError: undefined,
		inTransaction: undefined,
	};
}

// ============================================================================
// InsertBuilder — error paths
// ============================================================================

describe('InsertBuilder — error paths', () => {
	it('should throw InvalidOperationError when dump() called without values', () => {
		expect(() => orm.insert('users').dump()).toThrow(InvalidOperationError);
	});

	it('should mention "No values provided" in the error message', () => {
		expect(() => orm.insert('users').dump()).toThrow(
			/No values provided for insert/,
		);
	});

	it('should throw InvalidOperationError when values is an empty array', () => {
		expect(() => orm.insert('users').values([]).dump()).toThrow(
			InvalidOperationError,
		);
	});

	it('rejects an empty insert row before it can compile zero-column VALUES', () => {
		expect(() => orm.insert('users').values({})).toThrow(InvalidOperationError);
		expect(() => orm.insert('users').values({})).toThrow(
			/insert values\(\) requires every row to contain at least one column/,
		);
	});

	it('rejects null, primitive, and nested-array insert rows with InvalidOperationError', () => {
		expect(() => orm.insert('users').values([null] as never)).toThrow(
			InvalidOperationError,
		);
		expect(() => orm.insert('users').values('x' as never)).toThrow(
			InvalidOperationError,
		);
		expect(() => orm.insert('users').values([[]] as never)).toThrow(
			InvalidOperationError,
		);
	});

	it('accepts class instances as insert rows', () => {
		class UserInput {
			name = 'Alice';
		}

		expect(() =>
			orm.insert('users').values(new UserInput() as never),
		).not.toThrow();
	});

	it('should throw ExecutionError on dump() without adapter', () => {
		const builder = new InsertBuilder({
			...baseOptsNoAdapter(),
			values: [{ name: 'Alice' }],
		});
		expect(() => builder.dump()).toThrow(ExecutionError);
	});

	it('rejects widened payload columns outside the model before they reach SQL', () => {
		type User = {
			id: number;
			name: string;
			email: string;
			active: boolean;
		};
		const externalPayload: unknown = { active: false, isAdmin: true };
		const widened = externalPayload as Updateable<User>;

		expect(() => orm.update('users').set(widened)).toThrow(
			InvalidOperationError,
		);
		expect(() => orm.update('users').set(widened)).toThrow(/isAdmin/);
	});

	it('rejects unmodeled columns from every mutation payload entry point', () => {
		const payload = { name: 'Alice', isAdmin: true } as never;
		expect(() => orm.insert('users').values(payload)).toThrow(
			InvalidOperationError,
		);
		expect(() => orm.upsert('users').values(payload)).toThrow(
			InvalidOperationError,
		);
		expect(() => orm.update('users').set(payload)).toThrow(
			InvalidOperationError,
		);
		expect(() => orm.update('users').batchSet('id', [payload])).toThrow(
			InvalidOperationError,
		);
		expect(() => orm.upsert('users').doUpdate(payload)).toThrow(
			InvalidOperationError,
		);
	});

	it('validates direct-model ORM payloads when the compiler resolves the table', () => {
		const directModelOrm = createOrm({
			model: testSchema.model,
			adapter: createMockAdapter(),
		}) as unknown as OrmInstanceInternal;

		expect(() =>
			directModelOrm.update('users').set({ name: 'Alice' }),
		).not.toThrow();
		expect(() =>
			directModelOrm
				.update('users')
				.set({ name: 'Alice', isAdmin: true } as never),
		).toThrow(InvalidOperationError);
		expect(() =>
			directModelOrm
				.update('users')
				.set({ name: 'Alice', isAdmin: true } as never),
		).toThrow(
			"Invalid update: update payload contains columns not present in model for table 'users': isAdmin",
		);
	});

	it('skips payload-column validation when the ORM model cannot resolve the table', () => {
		const modelLessOrm = createOrm({
			model: { getTable: () => undefined } as any,
			adapter: createMockAdapter(),
		}) as unknown as OrmInstanceInternal;

		expect(() =>
			modelLessOrm.update('users').set({ id: 1, name: 'Alice' }),
		).not.toThrow();
		expect(() =>
			modelLessOrm.update('users').set({ isAdmin: true } as never),
		).not.toThrow();
	});

	it('should throw ExecutionError on execute() without adapter', async () => {
		const builder = new InsertBuilder({
			...baseOptsNoAdapter(),
			values: [{ name: 'Alice' }],
		});
		await expect(builder.execute()).rejects.toThrow(ExecutionError);
	});

	it('should include "Adapter not configured" in the error reason', () => {
		const builder = new InsertBuilder({
			...baseOptsNoAdapter(),
			values: [{ name: 'Alice' }],
		});
		try {
			builder.dump();
			expect.unreachable('Should have thrown');
		} catch (error) {
			expect(error).toBeInstanceOf(ExecutionError);
			expect((error as ExecutionError).reason).toBe('Adapter not configured');
		}
	});
});

// ============================================================================
// UpdateBuilder — error paths
// ============================================================================

describe('UpdateBuilder — error paths', () => {
	it('should throw InvalidOperationError when set() is empty', () => {
		expect(() =>
			orm
				.update('users')
				.where({ kind: 'comparison', field: 'id', operator: 'eq', value: 1 })
				.dump(),
		).toThrow(InvalidOperationError);
	});

	it('should mention "No fields to update" in error', () => {
		expect(() =>
			orm
				.update('users')
				.where({ kind: 'comparison', field: 'id', operator: 'eq', value: 1 })
				.dump(),
		).toThrow(/No fields to update/);
	});

	it('should throw UnsafeOperationError when no where and no allowAll', () => {
		expect(() => orm.update('users').set({ name: 'Bob' }).dump()).toThrow(
			UnsafeOperationError,
		);
	});

	it('should mention "WHERE clause required" in unsafe update error', () => {
		expect(() => orm.update('users').set({ name: 'Bob' }).dump()).toThrow(
			/WHERE clause required/,
		);
	});

	it('should not throw when where clause is provided', () => {
		// This will throw from the mock adapter (compile not implemented),
		// but should not throw InvalidOperationError or UnsafeOperationError
		expect(() =>
			orm
				.update('users')
				.set({ name: 'Bob' })
				.where({ kind: 'comparison', field: 'id', operator: 'eq', value: 1 })
				.dump(),
		).toThrow('Not implemented in mock adapter');
	});

	it('should not throw when allowAll is used via updateAll()', () => {
		// updateAll sets allowAll = true
		expect(() => orm.updateAll('users').set({ active: false }).dump()).toThrow(
			'Not implemented in mock adapter',
		);
	});

	it('should throw ExecutionError on dump() without adapter', () => {
		const builder = new UpdateBuilder({
			...baseOptsNoAdapter(),
			set: { name: 'Bob' },
			where: { kind: 'comparison', field: 'id', operator: 'eq', value: 1 },
		});
		expect(() => builder.dump()).toThrow(ExecutionError);
	});
});

// ============================================================================
// DeleteBuilder — error paths
// ============================================================================

describe('DeleteBuilder — error paths', () => {
	it('should throw UnsafeOperationError when no where and no allowAll', () => {
		expect(() => orm.delete('users').dump()).toThrow(UnsafeOperationError);
	});

	it('should mention "WHERE clause required" in unsafe delete error', () => {
		expect(() => orm.delete('users').dump()).toThrow(/WHERE clause required/);
	});

	it('should suggest deleteAll() in error message', () => {
		expect(() => orm.delete('users').dump()).toThrow(/deleteAll/);
	});

	it('should not throw when where clause is provided', () => {
		expect(() =>
			orm
				.delete('users')
				.where({ kind: 'comparison', field: 'id', operator: 'eq', value: 1 })
				.dump(),
		).toThrow('Not implemented in mock adapter');
	});

	it('should not throw when allowAll is used via deleteAll()', () => {
		expect(() => orm.deleteAll('users').dump()).toThrow(
			'Not implemented in mock adapter',
		);
	});

	it('should throw ExecutionError on dump() without adapter', () => {
		const builder = new DeleteBuilder({
			...baseOptsNoAdapter(),
			where: { kind: 'comparison', field: 'id', operator: 'eq', value: 1 },
		});
		expect(() => builder.dump()).toThrow(ExecutionError);
	});
});

// ============================================================================
// UpsertBuilder — error paths
// ============================================================================

describe('UpsertBuilder — error paths', () => {
	it('should throw InvalidOperationError when no values provided', () => {
		expect(() =>
			orm.upsert('users').onConflict(['id']).doNothing().dump(),
		).toThrow(InvalidOperationError);
	});

	it('should mention "No values provided for upsert"', () => {
		expect(() =>
			orm.upsert('users').onConflict(['id']).doNothing().dump(),
		).toThrow(/No values provided for upsert/);
	});

	it('should throw InvalidOperationError when no conflict target', () => {
		expect(() =>
			orm.upsert('users').values({ name: 'Alice' }).doNothing().dump(),
		).toThrow(InvalidOperationError);
	});

	it('should mention "No conflict target specified"', () => {
		expect(() =>
			orm.upsert('users').values({ name: 'Alice' }).doNothing().dump(),
		).toThrow(/No conflict target specified/);
	});

	it('should throw InvalidOperationError when no conflict action', () => {
		expect(() =>
			orm.upsert('users').values({ name: 'Alice' }).onConflict(['id']).dump(),
		).toThrow(InvalidOperationError);
	});

	it('should mention "No conflict action specified"', () => {
		expect(() =>
			orm.upsert('users').values({ name: 'Alice' }).onConflict(['id']).dump(),
		).toThrow(/No conflict action specified/);
	});

	it('should suggest doUpdate() or doNothing() in conflict action error', () => {
		expect(() =>
			orm.upsert('users').values({ name: 'Alice' }).onConflict(['id']).dump(),
		).toThrow(/doUpdate.*doNothing/);
	});

	it('should throw InvalidOperationError with empty values array', () => {
		expect(() =>
			orm.upsert('users').values([]).onConflict(['id']).doNothing().dump(),
		).toThrow(/No values provided for upsert/);
	});

	it('rejects an empty upsert row before it can compile zero-column VALUES', () => {
		expect(() => orm.upsert('users').values({})).toThrow(InvalidOperationError);
		expect(() => orm.upsert('users').values({})).toThrow(
			/upsert values\(\) requires every row to contain at least one column/,
		);
	});

	it('rejects null and primitive upsert rows with InvalidOperationError', () => {
		expect(() => orm.upsert('users').values([null] as never)).toThrow(
			InvalidOperationError,
		);
		expect(() => orm.upsert('users').values('x' as never)).toThrow(
			InvalidOperationError,
		);
	});

	it.each([
		null,
		0,
		false,
		'',
	])('doUpdate rejects explicit invalid payload %j instead of selecting auto-update', (set) => {
		expect(() => orm.upsert('users').doUpdate(set as never)).toThrow(
			InvalidOperationError,
		);
	});

	it('should throw ExecutionError on dump() without adapter', () => {
		const builder = new UpsertBuilder({
			...baseOptsNoAdapter(),
			values: [{ name: 'Alice' }],
			onConflict: { columns: ['id'] },
			action: { type: 'doNothing' },
		});
		expect(() => builder.dump()).toThrow(ExecutionError);
	});
});

// ============================================================================
// Hook error chains — mutation builders
// ============================================================================

describe('Mutation hook error chains', () => {
	it('should propagate error from beforeMutation hook via onError', async () => {
		const hookError = new Error('beforeMutation hook failed');
		const transformedError = new Error('Transformed by onError');

		const hookManager = createHookManager()
			.beforeMutation(() => {
				throw hookError;
			})
			.onError(() => transformedError);

		const ormWithHooks = createOrm({
			adapter: createMockAdapter(),
			schema: testSchema,
			hooks: hookManager,
		});

		// Insert needs adapter.execute, which mock throws "Not implemented"
		// But the hook fires before execute, so the hook error should propagate
		const builder = (ormWithHooks as unknown as OrmInstanceInternal)
			.insert('users')
			.values({ name: 'Alice', email: 'alice@test.com', active: true });

		await expect(builder.execute()).rejects.toThrow('Transformed by onError');
	});

	it('should propagate original error when no onError hooks registered', async () => {
		const hookManager = createHookManager().beforeMutation(() => {
			throw new Error('hook failed');
		});

		const ormWithHooks = createOrm({
			adapter: createMockAdapter(),
			schema: testSchema,
			hooks: hookManager,
		});

		const builder = (ormWithHooks as unknown as OrmInstanceInternal)
			.insert('users')
			.values({ name: 'Alice', email: 'alice@test.com', active: true });

		await expect(builder.execute()).rejects.toThrow('hook failed');
	});
});
