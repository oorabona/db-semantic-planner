/**
 * Tests for nql`...` tagged template bind handling.
 *
 * Tracks: https://github.com/oorabona/db-semantic-planner/issues/113
 * Regression: https://github.com/oorabona/db-semantic-planner/issues/173
 */

import { describe, expect, it, vi } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../../../../adapter-pgsql/src/pgsql-adapter.js';
import type { Adapter, CompiledNqlQuery } from '../../adapter.js';
import { createNqlTag } from '../nql.js';
import { schema } from '../schema.js';

function createBindingTag(executeResult: readonly unknown[] = []) {
	const db = schema({
		users: {
			id: 'integer',
			name: 'string',
			active: 'boolean',
		},
	} as const);
	const adapter = createPgsqlCompileOnlyAdapter() as unknown as Adapter;
	const compile = vi.spyOn(adapter, 'compile');
	adapter.execute = vi.fn(async () => [...executeResult]);

	return {
		adapter,
		compile,
		nql: createNqlTag(db.definition, db.model, adapter),
	};
}

function expectCompiledNqlBundle(value: unknown): CompiledNqlQuery {
	expect(value).toMatchObject({
		query: expect.any(Object),
		bindings: expect.any(Map),
	});
	return value as CompiledNqlQuery;
}

describe('nql`...` bind handling', () => {
	it('compiles query-final read-only bindings through the NQL bundle for WITH CTE emission', () => {
		const { compile, nql } = createBindingTag();

		const dump = nql<{ id: number }>`users
			| where active = ${true}
			| select id
			| bind active_users
users | select id`.dump();

		expect(compile).toHaveBeenCalledOnce();
		const bundle = expectCompiledNqlBundle(compile.mock.calls[0]?.[0]);
		expect(bundle.bindings?.has('active_users')).toBe(true);
		expect(bundle.mutationBindings).toBeUndefined();
		expect(compile.mock.calls[0]?.[1]).toMatchObject({
			model: expect.any(Object),
		});
		expect(dump.sql).toMatch(/^WITH "active_users" as \(/);
		expect(dump.params).toEqual([true]);
	});

	it('executes query-final read-only bindings through the NQL bundle', async () => {
		const rows = [{ id: 1 }];
		const { adapter, compile, nql } = createBindingTag(rows);

		const result = await nql<{ id: number }>`users
			| where active = ${true}
			| select id
			| bind active_users
users | select id`.all();

		expect(result).toEqual(rows);
		expect(adapter.execute).toHaveBeenCalledOnce();
		const bundle = expectCompiledNqlBundle(compile.mock.calls[0]?.[0]);
		expect(bundle.bindings?.has('active_users')).toBe(true);
		expect(bundle.mutationBindings).toBeUndefined();
	});

	it('rejects mutation binding bodies before compiling a query-final tag program', () => {
		const { nql } = createBindingTag();

		expect(() => {
			nql<{
				id: number;
			}>`insert into users set name = ${'Alice'} | select id | bind new_user
users | where id in (new_user) | select id`.dump();
		}).toThrow(/#173/);
	});

	it('rejects mutation binding bodies before compiling a mutation-final tag program', () => {
		const { nql } = createBindingTag();

		expect(() => {
			nql<{
				id: number;
			}>`insert into users set name = ${'Alice'} | select id | bind new_user
update users set active = ${true} where id in (new_user) | select id`.dump();
		}).toThrow(/#173/);
	});
});
