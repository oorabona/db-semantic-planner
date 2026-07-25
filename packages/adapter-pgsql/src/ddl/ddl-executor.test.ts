import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
	DdlExecutionError,
	executeDdlPlan,
	executeDdlPlanWithClient,
} from './ddl-executor.js';

type QueryResponse = Error | undefined;

function sqlState(code: string, message = code): Error {
	return Object.assign(new Error(message), { code });
}

function makeClient(
	responses: readonly QueryResponse[] = [],
	txStatus?: 'I' | 'T' | 'E',
): PoolClient & {
	readonly queries: ReturnType<typeof vi.fn>;
	readonly release: ReturnType<typeof vi.fn>;
} {
	const queue = [...responses];
	const queries = vi.fn(async () => {
		const response = queue.shift();
		if (response !== undefined) throw response;
		return { rows: [] };
	});
	const release = vi.fn();
	return {
		query: queries,
		queries,
		release,
		...(txStatus === undefined ? {} : { _txStatus: txStatus }),
	} as unknown as PoolClient & {
		readonly queries: typeof queries;
		readonly release: typeof release;
	};
}

function makePool(client: PoolClient, connectError?: Error): Pool {
	return {
		connect: vi.fn(async () => {
			if (connectError !== undefined) throw connectError;
			return client;
		}),
	} as unknown as Pool;
}

function queried(client: { queries: ReturnType<typeof vi.fn> }): string[] {
	return client.queries.mock.calls.map(([statement]) => statement as string);
}

describe('executeDdlPlan', () => {
	it('reports acquisition failure without releasing an unacquired client', async () => {
		const client = makeClient([], 'I');
		const pool = makePool(client, new Error('connect failed'));

		await expect(
			executeDdlPlan(pool, { autocommit: [], main: ['SELECT 1'] }),
		).rejects.toMatchObject({
			phase: 'acquisition',
			outcome: 'not_started',
		});
		expect(client.release).not.toHaveBeenCalled();
	});

	it('destroys an acquired client when the transaction precondition fails', async () => {
		const client = makeClient([], 'T');

		await expect(
			executeDdlPlan(makePool(client), { autocommit: [], main: ['SELECT 1'] }),
		).rejects.toMatchObject({ phase: 'precondition', outcome: 'not_started' });
		expect(queried(client)).toEqual([]);
		expect(client.release).toHaveBeenCalledWith(expect.any(DdlExecutionError));
	});

	it('probes a legacy client and proceeds only when SAVEPOINT returns 25P01', async () => {
		const client = makeClient([
			sqlState('25P01'),
			undefined,
			undefined,
			undefined,
		]);

		await expect(
			executeDdlPlan(makePool(client), {
				autocommit: [],
				main: ['SELECT main'],
			}),
		).resolves.toEqual({ statementsExecuted: 1, dryRun: false });
		expect(queried(client)).toEqual([
			'SAVEPOINT "dbsp_idle_probe"',
			'BEGIN',
			'SELECT main',
			'COMMIT',
		]);
	});

	it('rejects a legacy client when the SAVEPOINT probe succeeds', async () => {
		const client = makeClient();

		await expect(
			executeDdlPlan(makePool(client), { autocommit: [], main: ['SELECT 1'] }),
		).rejects.toMatchObject({ phase: 'precondition', outcome: 'not_started' });
		expect(queried(client)).toEqual(['SAVEPOINT "dbsp_idle_probe"']);
		expect(client.release).toHaveBeenCalledWith(expect.any(DdlExecutionError));
	});

	it('rejects a legacy client when the SAVEPOINT probe is ambiguous', async () => {
		const client = makeClient([sqlState('25P02')]);

		await expect(
			executeDdlPlan(makePool(client), { autocommit: [], main: ['SELECT 1'] }),
		).rejects.toMatchObject({ phase: 'precondition', outcome: 'not_started' });
		expect(queried(client)).toEqual(['SAVEPOINT "dbsp_idle_probe"']);
	});

	it('retains completed autocommit work and reports an unknown outcome', async () => {
		const client = makeClient(
			[undefined, new Error('autocommit failure')],
			'I',
		);

		await expect(
			executeDdlPlan(makePool(client), {
				autocommit: ['ALTER TYPE first', 'ALTER TYPE second'],
				main: ['SELECT main'],
			}),
		).rejects.toMatchObject({
			phase: 'autocommit',
			autocommitCompleted: 1,
			outcome: 'unknown',
		});
		expect(queried(client)).toEqual(['ALTER TYPE first', 'ALTER TYPE second']);
	});

	it('rolls back a main statement failure', async () => {
		const client = makeClient(
			[undefined, new Error('main failure'), undefined],
			'I',
		);

		await expect(
			executeDdlPlan(makePool(client), { autocommit: [], main: ['INVALID'] }),
		).rejects.toMatchObject({ phase: 'main', outcome: 'rolled_back' });
		expect(queried(client)).toEqual(['BEGIN', 'INVALID', 'ROLLBACK']);
	});

	it('rolls back an onMain failure', async () => {
		const client = makeClient([undefined, undefined], 'I');

		await expect(
			executeDdlPlan(
				makePool(client),
				{ autocommit: [], main: [] },
				{ onMain: async () => Promise.reject(new Error('record failure')) },
			),
		).rejects.toMatchObject({ phase: 'main', outcome: 'rolled_back' });
		expect(queried(client)).toEqual(['BEGIN', 'ROLLBACK']);
	});

	it('retains a rollback error and reports an unknown outcome', async () => {
		const rollbackError = new Error('rollback failure');
		const client = makeClient(
			[undefined, new Error('main failure'), rollbackError],
			'I',
		);

		await expect(
			executeDdlPlan(makePool(client), { autocommit: [], main: ['INVALID'] }),
		).rejects.toMatchObject({
			phase: 'main',
			rollbackError,
			outcome: 'unknown',
		});
		expect(queried(client)).toEqual(['BEGIN', 'INVALID', 'ROLLBACK']);
	});

	it('does not roll back after a failed COMMIT response', async () => {
		const client = makeClient(
			[undefined, undefined, new Error('connection lost during commit')],
			'I',
		);

		await expect(
			executeDdlPlan(makePool(client), {
				autocommit: [],
				main: ['SELECT main'],
			}),
		).rejects.toMatchObject({
			phase: 'main',
			commitAttempted: true,
			outcome: 'unknown',
		});
		expect(queried(client)).toEqual(['BEGIN', 'SELECT main', 'COMMIT']);
	});

	it('does not acquire a client, execute SQL, or invoke onMain for a dry run', async () => {
		const client = makeClient([], 'I');
		const pool = makePool(client);
		const onMain = vi.fn();

		await expect(
			executeDdlPlan(
				pool,
				{ autocommit: ['ALTER TYPE status'], main: ['ALTER TABLE jobs'] },
				{ dryRun: true, onMain },
			),
		).resolves.toEqual({ statementsExecuted: 2, dryRun: true });
		expect(pool.connect).not.toHaveBeenCalled();
		expect(queried(client)).toEqual([]);
		expect(onMain).not.toHaveBeenCalled();
	});

	it('executes phases in order and releases normally on success', async () => {
		const client = makeClient([], 'I');

		await expect(
			executeDdlPlan(makePool(client), {
				autocommit: ['ALTER TYPE status'],
				main: ['ALTER TABLE jobs'],
			}),
		).resolves.toEqual({ statementsExecuted: 2, dryRun: false });
		expect(queried(client)).toEqual([
			'ALTER TYPE status',
			'BEGIN',
			'ALTER TABLE jobs',
			'COMMIT',
		]);
		expect(client.release).toHaveBeenCalledWith(undefined);
	});
});

describe('executeDdlPlanWithClient', () => {
	it('never releases a caller-owned client', async () => {
		const client = makeClient([], 'I');

		await executeDdlPlanWithClient(client, {
			autocommit: ['ALTER TYPE status'],
			main: [],
		});

		expect(queried(client)).toEqual(['ALTER TYPE status']);
		expect(client.release).not.toHaveBeenCalled();
	});
});
