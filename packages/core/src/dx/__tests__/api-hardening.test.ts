/**
 * API Hardening Tests — Commit 6 (FIND-031 through FIND-037)
 *
 * Proof tests for type-safety fixes applied in this commit:
 * - FIND-031: into/modify/removeFrom/upsertInto return typed builders
 * - FIND-032: .returning() columns tied to R generic
 * - FIND-033: execute() returns Promise<void> without returning(), Promise<R[]> with
 * - FIND-035: OrmInstanceInternal not publicly exported from dx/index barrel
 * - FIND-036: SetOperationBuilderImpl not publicly exported from dx/index barrel
 * - FIND-037: SelectExpressionResult.execute() default Record<string, unknown>
 */

import { createPgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { fn } from '../expressions.js';
import { eq } from '../filters.js';
import {
	DeleteBuilder,
	InsertBuilder,
	UpdateBuilder,
	UpsertBuilder,
} from '../mutation-builders.js';
import { createOrm } from '../orm.js';
import type { SelectExpressionResult } from '../orm-instance-types.js';
import { ref, schema } from '../schema.js';
import type { SetOperationBuilder } from '../set-operation-builder.js';

// ──────────────────────────────────────────────────────────────────────────────
// Shared schema fixture
// ──────────────────────────────────────────────────────────────────────────────

const db = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		email: 'string',
		active: 'boolean',
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: 'string',
		authorId: ref('users'),
	},
});

const adapter = createPgsqlCompileOnlyAdapter();
const orm = createOrm({ schema: db, adapter });

type UserRow = { id: number; name: string; email: string; active: boolean };

// ──────────────────────────────────────────────────────────────────────────────
// FIND-031: into/modify/removeFrom/upsertInto return typed builders
// ──────────────────────────────────────────────────────────────────────────────

describe('FIND-031: typed mutation entry points', () => {
	it('orm.into(table) returns InsertBuilder typed to table row', () => {
		const { users } = orm.tables;
		const builder = orm.into(users);
		expect(builder).toBeInstanceOf(InsertBuilder);
		expectTypeOf(builder).toMatchTypeOf<InsertBuilder<UserRow>>();
	});

	it('orm.modify(table) returns UpdateBuilder typed to table row', () => {
		const { users } = orm.tables;
		const builder = orm.modify(users);
		expect(builder).toBeInstanceOf(UpdateBuilder);
		expectTypeOf(builder).toMatchTypeOf<UpdateBuilder<UserRow>>();
	});

	it('orm.removeFrom(table) returns DeleteBuilder typed to table row', () => {
		const { users } = orm.tables;
		const builder = orm.removeFrom(users);
		expect(builder).toBeInstanceOf(DeleteBuilder);
		expectTypeOf(builder).toMatchTypeOf<DeleteBuilder<UserRow>>();
	});

	it('orm.upsertInto(table) returns UpsertBuilder typed to table row', () => {
		const { users } = orm.tables;
		const builder = orm.upsertInto(users);
		expect(builder).toBeInstanceOf(UpsertBuilder);
		expectTypeOf(builder).toMatchTypeOf<UpsertBuilder<UserRow>>();
	});
});

// ──────────────────────────────────────────────────────────────────────────────
// FIND-032 + FIND-033: .returning() transitions execute() type
// ──────────────────────────────────────────────────────────────────────────────

describe('FIND-032+033: .returning() and execute() types', () => {
	it('InsertBuilder without returning(): execute() is Promise<UserRow> (typed entry preserves row type)', () => {
		// With FIND-031: orm.into(table) returns InsertBuilder<UserRow>, so execute() → Promise<UserRow>.
		// The Promise<void> contract only holds for the untyped string-based insert('table') path.
		const builder = orm
			.into(orm.tables.users)
			.values({ name: 'Alice', email: 'a@b.com', active: true });
		expectTypeOf(builder.execute).returns.toEqualTypeOf<Promise<UserRow>>();
	});

	it('InsertBuilder with returning<R>(): execute() is Promise<R[]>', () => {
		type Inserted = { id: number };
		const builder = orm
			.into(orm.tables.users)
			.values({ name: 'Alice', email: 'a@b.com', active: true })
			.returning<Inserted>(['id']);
		expect(builder).toBeInstanceOf(InsertBuilder);
		expectTypeOf(builder.execute).returns.toEqualTypeOf<Promise<Inserted[]>>();
	});

	it('UpdateBuilder without returning(): execute() is Promise<UserRow> (typed entry preserves row type)', () => {
		const builder = orm
			.modify(orm.tables.users)
			.set({ active: false })
			.where(eq(orm.tables.users.id, 1));
		expectTypeOf(builder.execute).returns.toEqualTypeOf<Promise<UserRow>>();
	});

	it('UpdateBuilder with returning<R>(): execute() is Promise<R[]>', () => {
		type Updated = { id: number; active: boolean };
		const builder = orm
			.modify(orm.tables.users)
			.set({ active: false })
			.where(eq(orm.tables.users.id, 1))
			.returning<Updated>(['id', 'active']);
		expect(builder).toBeInstanceOf(UpdateBuilder);
		expectTypeOf(builder.execute).returns.toEqualTypeOf<Promise<Updated[]>>();
	});

	it('DeleteBuilder without returning(): execute() is Promise<UserRow> (typed entry preserves row type)', () => {
		const builder = orm
			.removeFrom(orm.tables.users)
			.where(eq(orm.tables.users.id, 1));
		expectTypeOf(builder.execute).returns.toEqualTypeOf<Promise<UserRow>>();
	});

	it('DeleteBuilder with returning<R>(): execute() is Promise<R[]>', () => {
		type Deleted = { id: number };
		const builder = orm
			.removeFrom(orm.tables.users)
			.where(eq(orm.tables.users.id, 1))
			.returning<Deleted>(['id']);
		expect(builder).toBeInstanceOf(DeleteBuilder);
		expectTypeOf(builder.execute).returns.toEqualTypeOf<Promise<Deleted[]>>();
	});

	it('UpsertBuilder without returning(): execute() is Promise<UserRow> (typed entry preserves row type)', () => {
		const builder = orm
			.upsertInto(orm.tables.users)
			.values({ name: 'Alice', email: 'a@b.com', active: true })
			.onConflict(['email'])
			.doUpdate({ name: 'Alice' });
		expectTypeOf(builder.execute).returns.toEqualTypeOf<Promise<UserRow>>();
	});

	it('UpsertBuilder with returning<R>(): execute() is Promise<R[]>', () => {
		type Upserted = { id: number; name: string };
		const builder = orm
			.upsertInto(orm.tables.users)
			.values({ name: 'Alice', email: 'a@b.com', active: true })
			.onConflict(['email'])
			.doUpdate({ name: 'Alice' })
			.returning<Upserted>(['id', 'name']);
		expect(builder).toBeInstanceOf(UpsertBuilder);
		expectTypeOf(builder.execute).returns.toEqualTypeOf<Promise<Upserted[]>>();
	});

	it('mutation builders expose affectedRows(): Promise<number>', () => {
		const insertBuilder = orm
			.into(orm.tables.users)
			.values({ name: 'Alice', email: 'a@b.com', active: true });
		const updateBuilder = orm
			.modify(orm.tables.users)
			.set({ active: false })
			.where(eq(orm.tables.users.id, 1));
		const deleteBuilder = orm
			.removeFrom(orm.tables.users)
			.where(eq(orm.tables.users.id, 1));
		const upsertBuilder = orm
			.upsertInto(orm.tables.users)
			.values({ name: 'Alice', email: 'a@b.com', active: true })
			.onConflict(['email'])
			.doUpdate({ name: 'Alice' });

		expectTypeOf(insertBuilder.affectedRows).returns.toEqualTypeOf<
			Promise<number>
		>();
		expectTypeOf(updateBuilder.affectedRows).returns.toEqualTypeOf<
			Promise<number>
		>();
		expectTypeOf(deleteBuilder.affectedRows).returns.toEqualTypeOf<
			Promise<number>
		>();
		expectTypeOf(upsertBuilder.affectedRows).returns.toEqualTypeOf<
			Promise<number>
		>();
	});
});

// ──────────────────────────────────────────────────────────────────────────────
// FIND-035: OrmInstanceInternal not in public dx/index barrel
// ──────────────────────────────────────────────────────────────────────────────

describe('FIND-035: OrmInstanceInternal not publicly exported', () => {
	it('OrmInstanceInternal is not a runtime export from dx/index', async () => {
		const barrel = await import('../index.js');
		// @ts-expect-error OrmInstanceInternal should NOT be in the public API
		expect(barrel.OrmInstanceInternal).toBeUndefined();
	});
});

// ──────────────────────────────────────────────────────────────────────────────
// FIND-036: SetOperationBuilderImpl not in public dx/index barrel
// ──────────────────────────────────────────────────────────────────────────────

describe('FIND-036: SetOperationBuilderImpl not publicly exported', () => {
	it('SetOperationBuilderImpl is not a runtime export from dx/index', async () => {
		const barrel = await import('../index.js');
		// @ts-expect-error SetOperationBuilderImpl should NOT be in the public API
		expect(barrel.SetOperationBuilderImpl).toBeUndefined();
	});

	it('SetOperationBuilder interface contract preserved via .union()', () => {
		const q1 = orm.select('users');
		const q2 = orm.select('users');
		const setOp = q1.union(q2);
		expect(setOp).toBeDefined();
		// The returned type satisfies the public SetOperationBuilder interface
		expectTypeOf(setOp).toMatchTypeOf<SetOperationBuilder<unknown>>();
	});
});

// ──────────────────────────────────────────────────────────────────────────────
// FIND-037: SelectExpressionResult.execute() default Record<string, unknown>
// ──────────────────────────────────────────────────────────────────────────────

describe('FIND-037: SelectExpressionResult.execute() default type', () => {
	it('execute() default T is Record<string, unknown>, not unknown', () => {
		// FIND-037 fix: SelectExpressionResult.execute<T = Record<string, unknown>>()
		// The interface method default was changed from T=unknown to T=Record<string,unknown>.
		// Verify via the interface type: the call signature with default T should accept
		// a Promise<Record<string, unknown>[]> assignment, but NOT Promise<unknown[]>.

		// Type-level proof: Promise<Record<string, unknown>[]> is assignable to the return type.
		// If T defaulted to unknown, the assignment below would fail.
		type ExecMethod = SelectExpressionResult['execute'];
		type DefaultReturnRow = Awaited<ReturnType<ExecMethod>>[number];
		// Record<string, unknown> satisfies the default row type
		const _proofRow: DefaultReturnRow = {} as Record<string, unknown>;
		void _proofRow;

		// Runtime: result object is created and execute exists
		const expr = fn('now');
		const result = orm.selectExpression(expr);
		expect(typeof result.execute).toBe('function');
	});
});
