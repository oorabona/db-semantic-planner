/**
 * Connectionless PgsqlAdapter contract.
 *
 * Each execution entry point has an individual regression test. Removing its
 * guard lets that operation reach compilation or a distinct legacy failure.
 */

import {
	createHookManager,
	createOrm,
	eq,
	schema,
	supportsExecution,
} from '@dbsp/core';
import type { CompileOnlyAdapter } from '@dbsp/types';
import { projectionlessCompiledQuery } from '@dbsp/types/adapter-sdk';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
	createPgsqlCompileOnlyAdapter,
	type PgsqlAdapter,
} from '../pgsql-adapter.js';
import { stringMutationOrm } from '../test-compat/issue-441.js';

const db = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
	},
} as const);

const query = projectionlessCompiledQuery(
	{ sql: 'SELECT 1', parameters: [] },
	'connectionless-adapter-test',
);

function connectionlessMessage(operation: string): string {
	return `Cannot ${operation}: this PgsqlAdapter was constructed without a connection. Use createPgsqlAdapter(pool) to execute database operations.`;
}

function ormConnectionlessMessage(operation: string): string {
	return `Cannot execute ${operation}: this PgsqlAdapter was constructed without a connection.\n\nTo fix: Use createPgsqlAdapter(pool) to execute database operations.`;
}

function createConnectionlessOrm() {
	const adapter = createPgsqlCompileOnlyAdapter({ model: db.model });
	return {
		adapter,
		orm: stringMutationOrm(createOrm({ schema: db, adapter })),
	};
}

function connectionlessCteQuery() {
	const { orm } = createConnectionlessOrm();
	return orm
		.withCte('lookup_ids')
		.fromUnnest({ id: [1] })
		.query(orm.select('users'));
}

function connectionlessRawCteQuery() {
	const { orm } = createConnectionlessOrm();
	return orm.recursive('user_tree', {
		base: orm.select('users'),
		step: orm.select('users'),
	});
}

describe('createPgsqlCompileOnlyAdapter connectionless construction', () => {
	it('returns PgsqlAdapter and the documented createOrm(...).dump() call typechecks and works', () => {
		const adapter = createPgsqlCompileOnlyAdapter({ model: db.model });
		expectTypeOf(adapter).toEqualTypeOf<PgsqlAdapter>();
		const existingCompileOnlyAnnotation: CompileOnlyAdapter = adapter;

		const orm = createOrm({ model: db.model, adapter });
		const dump = orm.select('users').dump();
		expect(dump.sql).toContain('SELECT');
		void existingCompileOnlyAnnotation;
	});

	it('supportsExecution is false for an adapter constructed without a connection', () => {
		expect(supportsExecution(createPgsqlCompileOnlyAdapter())).toBe(false);
	});
});

describe('connectionless execution refusal', () => {
	it('query execution: rejects before validating a compiled query', async () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		await expect(
			adapter.execute({ sql: 'SELECT 1', parameters: [] } as never),
		).rejects.toThrow(connectionlessMessage('execute'));
	});

	it('all(): query execution refuses uniformly', async () => {
		const { orm } = createConnectionlessOrm();
		await expect(orm.select('users').all()).rejects.toThrow(
			ormConnectionlessMessage('all()'),
		);
	});

	it('insert mutation: refuses uniformly', async () => {
		const { orm } = createConnectionlessOrm();
		await expect(
			orm.insert('users').values({ name: 'Ada' }).execute(),
		).rejects.toThrow(ormConnectionlessMessage('insert()'));
	});

	it('update mutation: refuses uniformly', async () => {
		const { orm } = createConnectionlessOrm();
		await expect(
			orm.update('users').set({ name: 'Grace' }).where(eq('id', 1)).execute(),
		).rejects.toThrow(ormConnectionlessMessage('update()'));
	});

	it('delete mutation: refuses uniformly', async () => {
		const { orm } = createConnectionlessOrm();
		await expect(
			orm.delete('users').where(eq('id', 1)).execute(),
		).rejects.toThrow(ormConnectionlessMessage('delete()'));
	});

	it('raw SQL: refuses uniformly', async () => {
		const { orm } = createConnectionlessOrm();
		await expect(orm.raw('SELECT 1')).rejects.toThrow(
			connectionlessMessage('executeRaw'),
		);
	});

	it('NQL: refuses uniformly', async () => {
		const { orm } = createConnectionlessOrm();
		await expect(orm.nql`users | select id`.all()).rejects.toThrow(
			ormConnectionlessMessage('nql().all()'),
		);
	});

	it('exists(): refuses uniformly through the execution funnel', async () => {
		const { orm } = createConnectionlessOrm();
		await expect(orm.select('users').exists()).rejects.toThrow(
			ormConnectionlessMessage('exists()'),
		);
	});

	it('hook-aware exists(): refuses uniformly through the execution funnel', async () => {
		const adapter = createPgsqlCompileOnlyAdapter({ model: db.model });
		const hooks = createHookManager().beforeQuery((context) => context);
		const orm = createOrm({ schema: db, adapter, hooks });

		await expect(orm.select('users').exists()).rejects.toThrow(
			ormConnectionlessMessage('exists()'),
		);
	});

	it('affectedRows(): refuses uniformly through the metadata execution funnel', async () => {
		const { orm } = createConnectionlessOrm();
		await expect(
			orm
				.update('users')
				.set({ name: 'Grace' })
				.where(eq('id', 1))
				.affectedRows(),
		).rejects.toThrow(ormConnectionlessMessage('update.affectedRows()'));
	});

	it.each([
		['all', () => connectionlessCteQuery().all()],
		['execute', () => connectionlessCteQuery().execute()],
	] as const)(
		'withCte().%s(): refuses uniformly through the execution funnel',
		async (_, run) => {
			await expect(run()).rejects.toThrow(
				ormConnectionlessMessage('withCte().all()'),
			);
		},
	);

	it.each([
		['all', () => connectionlessRawCteQuery().all()],
		['execute', () => connectionlessRawCteQuery().execute()],
	] as const)(
		'recursive().%s(): refuses uniformly through the execution funnel',
		async (_, run) => {
			await expect(run()).rejects.toThrow(
				ormConnectionlessMessage('recursive().all()'),
			);
		},
	);

	it('stream: refuses on first iteration, not construction', async () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const stream = adapter.stream(query);
		await expect(stream.next()).rejects.toThrow(
			connectionlessMessage('stream'),
		);
	});

	it('raw stream: refuses on first iteration, not construction', async () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const stream = adapter.streamRaw('SELECT 1');
		await expect(stream.next()).rejects.toThrow(
			connectionlessMessage('streamRaw'),
		);
	});

	it('transaction: returns a rejected promise rather than throwing synchronously', async () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		let transaction: Promise<void> | undefined;
		expect(() => {
			transaction = adapter.transaction(async () => undefined);
		}).not.toThrow();
		await expect(transaction).rejects.toThrow(
			connectionlessMessage('transaction'),
		);
	});

	it('pinned connection: refuses uniformly', async () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		await expect(
			adapter.withPinnedConnection(async () => undefined),
		).rejects.toThrow(connectionlessMessage('withPinnedConnection'));
	});

	it('introspection: refuses uniformly', async () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		await expect(adapter.introspect()).rejects.toThrow(
			connectionlessMessage('introspect'),
		);
	});

	it('DDL execution: refuses uniformly', async () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		await expect(
			adapter.executeDDL('CREATE TABLE users (id integer)'),
		).rejects.toThrow(connectionlessMessage('executeDDL'));
	});

	it('index listing catalog read: refuses uniformly', async () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		await expect(adapter.listIndexes('users')).rejects.toThrow(
			connectionlessMessage('listIndexes'),
		);
	});

	it('index existence catalog read: refuses uniformly', async () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		await expect(
			adapter.indexExists('users_name_idx', 'users'),
		).rejects.toThrow(connectionlessMessage('indexExists'));
	});

	it('storage-size catalog read: refuses uniformly', async () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		await expect(adapter.storageSize('users')).rejects.toThrow(
			connectionlessMessage('storageSize'),
		);
	});
});

describe('connectionless ORM execution refusal', () => {
	it('transaction(): preempts the transaction capability preflight', async () => {
		const { orm } = createConnectionlessOrm();
		await expect(orm.transaction(async () => undefined)).rejects.toThrow(
			ormConnectionlessMessage('transaction()'),
		);
	});

	it('withPinnedConnection(): preempts the pinned-connection capability preflight', async () => {
		const { orm } = createConnectionlessOrm();
		await expect(
			orm.withPinnedConnection(async () => undefined),
		).rejects.toThrow(ormConnectionlessMessage('withPinnedConnection()'));
	});

	it('stream(): preempts the streaming capability preflight on first iteration', async () => {
		const { orm } = createConnectionlessOrm();
		await expect(orm.select('users').stream().next()).rejects.toThrow(
			ormConnectionlessMessage('stream()'),
		);
	});

	it('ordered NQL mutation programs refuse before the transaction capability preflight', async () => {
		const { orm } = createConnectionlessOrm();
		await expect(
			orm.nql`insert into users set name = ${'Ada'} | select id | bind created
users | where id in (created) | select id`.all(),
		).rejects.toThrow(ormConnectionlessMessage('nql().all()'));
	});
});
