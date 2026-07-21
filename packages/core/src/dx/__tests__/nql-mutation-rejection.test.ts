/**
 * Tests for nql`...` tagged template mutation support.
 *
 * Tracks: https://github.com/oorabona/db-semantic-planner/issues/113
 */

import { describe, expect, it, vi } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../../../../adapter-pgsql/src/pgsql-adapter.js';
import type { Adapter } from '../../adapter.js';
import type { MutationDump } from '../mutation-builders.js';
import { createNqlTag } from '../nql.js';
import { schema } from '../schema.js';

function createMutationTag(executeResult: readonly unknown[] = []) {
	const db = schema({
		users: {
			id: 'integer',
			name: 'string',
			active: 'boolean',
		},
	} as const);
	const adapter = createPgsqlCompileOnlyAdapter({
		model: db.model,
	}) as unknown as Adapter;

	const compile = vi.spyOn(adapter, 'compile');
	adapter.executeWithMeta = vi.fn(async () => ({
		rows: [...executeResult],
		rowCount: executeResult.length,
	}));

	return {
		adapter,
		compile,
		nql: createNqlTag(db.definition, db.model, adapter),
	};
}

function createExecuteOnlyMutationTag(executeResult: readonly unknown[] = []) {
	const db = schema({
		users: {
			id: 'integer',
			name: 'string',
			active: 'boolean',
		},
	} as const);
	const adapter = createPgsqlCompileOnlyAdapter({
		model: db.model,
	}) as unknown as Adapter;

	const compile = vi.spyOn(adapter, 'compile');
	adapter.execute = vi.fn(async () => [...executeResult]);
	Object.defineProperty(adapter, 'executeWithMeta', {
		value: undefined,
		configurable: true,
		writable: true,
	});

	return {
		adapter,
		compile,
		nql: createNqlTag(db.definition, db.model, adapter),
	};
}

function expectMutationDump(dump: unknown): MutationDump {
	expect(dump).toMatchObject({
		sql: expect.any(String),
		parameters: expect.any(Array),
		intent: expect.any(Object),
	});
	expect(dump).not.toHaveProperty('plan');
	return dump as MutationDump;
}

describe('nql`...` mutation support', () => {
	it('compiles INSERT through adapter.compile and returns MutationDump', () => {
		const { compile, nql } = createMutationTag();

		const dump = expectMutationDump(
			nql`insert into users set name = ${'Alice'}, active = ${true}`.dump(),
		);

		expect(compile).toHaveBeenCalledOnce();
		expect(compile.mock.calls[0]?.[0]).toMatchObject({ mutation: dump.intent });
		expect(compile.mock.calls[0]?.[1]).toMatchObject({
			model: expect.any(Object),
		});
		expect(dump.intent).toMatchObject({
			type: 'insert',
			table: 'users',
			values: [
				{
					name: { kind: 'param', value: 'Alice' },
					active: { kind: 'param', value: true },
				},
			],
		});
		expect(dump.parameters).toEqual(['Alice', true]);
		expect(dump.sql).toMatch(/insert into users/i);
	});

	it('compiles UPDATE through adapter.compile and binds SET/WHERE interpolations', () => {
		const { compile, nql } = createMutationTag();

		const dump = expectMutationDump(
			nql`update users set name = ${'Bob'} where id = ${2}`.dump(),
		);

		expect(compile).toHaveBeenCalledOnce();
		expect(compile.mock.calls[0]?.[0]).toMatchObject({ mutation: dump.intent });
		expect(dump.intent).toMatchObject({
			type: 'update',
			table: 'users',
			set: { name: { kind: 'param', value: 'Bob' } },
			where: {
				kind: 'comparison',
				field: 'id',
				operator: 'eq',
				value: { kind: 'param', value: 2 },
			},
		});
		expect(dump.parameters).toEqual(['Bob', 2]);
		expect(dump.sql).toMatch(/update users set/i);
	});

	it('compiles DELETE through adapter.compile and binds WHERE interpolation', () => {
		const { compile, nql } = createMutationTag();

		const dump = expectMutationDump(
			nql`delete from users where id = ${3}`.dump(),
		);

		expect(compile).toHaveBeenCalledOnce();
		expect(compile.mock.calls[0]?.[0]).toMatchObject({ mutation: dump.intent });
		expect(dump.intent).toMatchObject({
			type: 'delete',
			table: 'users',
			where: {
				kind: 'comparison',
				field: 'id',
				operator: 'eq',
				value: { kind: 'param', value: 3 },
			},
		});
		expect(dump.parameters).toEqual([3]);
		expect(dump.sql).toMatch(/delete from users/i);
	});

	it('compiles UPSERT through adapter.compile and binds values', () => {
		const { compile, nql } = createMutationTag();

		const dump = expectMutationDump(
			nql`upsert into users on id set id = ${4}, name = ${'Charlie'}, active = ${false}`.dump(),
		);

		expect(compile).toHaveBeenCalledOnce();
		expect(compile.mock.calls[0]?.[0]).toMatchObject({ mutation: dump.intent });
		expect(dump.intent).toMatchObject({
			type: 'upsert',
			table: 'users',
			values: [
				{
					id: { kind: 'param', value: 4 },
					name: { kind: 'param', value: 'Charlie' },
					active: { kind: 'param', value: false },
				},
			],
			onConflict: { columns: ['id'] },
		});
		expect(dump.parameters).toEqual([4, 'Charlie', false]);
		expect(dump.sql).toMatch(/on conflict/i);
	});

	it('returns mutation intent from toIntentIR()', () => {
		const { nql } = createMutationTag();

		const intent = nql`insert into users set name = ${'Dana'}`.toIntentIR();

		expect(intent).toMatchObject({
			type: 'insert',
			table: 'users',
			values: [{ name: { kind: 'param', value: 'Dana' } }],
		});
	});

	it('does not produce a plan for mutations', () => {
		const { nql } = createMutationTag();

		expect(() => {
			nql`update users set active = ${false} where id = ${5}`.plan();
		}).toThrow(/mutations do not have execution plans/i);
	});

	it('all() executes a RETURNING mutation and returns adapter rows', async () => {
		const rows = [{ id: 6, name: 'Eve' }];
		const { adapter, compile, nql } = createMutationTag(rows);

		const result = await nql<{
			id: number;
			name: string;
		}>`update users set name = ${'Eve'} where id = ${6} | select id, name`.all();

		expect(compile).toHaveBeenCalledOnce();
		expect(adapter.executeWithMeta).toHaveBeenCalledOnce();
		expect(result).toEqual(rows);
	});

	it('run() executes a mutation and discards adapter rows', async () => {
		const rows = [{ id: 7 }];
		const { adapter, compile, nql } = createMutationTag(rows);

		const result =
			await nql`delete from users where id = ${7} | select id`.run();

		expect(compile).toHaveBeenCalledOnce();
		expect(adapter.executeWithMeta).toHaveBeenCalledOnce();
		expect(result).toBeUndefined();
	});

	it('all() executes a RETURNING mutation on an execute-only adapter', async () => {
		const rows = [{ id: 6, name: 'Eve' }];
		const { adapter, compile, nql } = createExecuteOnlyMutationTag(rows);

		const result = await nql<{
			id: number;
			name: string;
		}>`update users set name = ${'Eve'} where id = ${6} | select id, name`.all();

		expect(compile).toHaveBeenCalledOnce();
		expect(adapter.execute).toHaveBeenCalledOnce();
		expect(adapter.executeWithMeta).toBeUndefined();
		expect(result).toEqual(rows);
	});

	it('run() executes a mutation on an execute-only adapter', async () => {
		const rows = [{ id: 7 }];
		const { adapter, compile, nql } = createExecuteOnlyMutationTag(rows);

		const result =
			await nql`delete from users where id = ${7} | select id`.run();

		expect(compile).toHaveBeenCalledOnce();
		expect(adapter.execute).toHaveBeenCalledOnce();
		expect(adapter.executeWithMeta).toBeUndefined();
		expect(result).toBeUndefined();
	});

	it('still throws generic NQL compilation error for parse failures', () => {
		const { nql } = createMutationTag();

		expect(() => {
			nql`select * from`.dump();
		}).toThrow(/NQL compilation failed/);
	});
});
