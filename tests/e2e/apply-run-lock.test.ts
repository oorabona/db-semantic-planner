import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { withPgTransitionRunLock } from '../../packages/adapter-pgsql/src/transition/lessor.js';

function deferred(): {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
} {
	let resolve!: () => void;
	return { promise: new Promise<void>((done) => (resolve = done)), resolve };
}

describe('dbsp apply run lock', () => {
	const pools: pg.Pool[] = [];

	afterEach(async () => {
		await Promise.all(pools.splice(0).map((pool) => pool.end()));
	});

	it('mutation: replacing the PostgreSQL session lock with an in-process mutex allows two independent sessions to execute', async () => {
		const connectionString = process.env.DATABASE_URL;
		if (!connectionString) throw new Error('DATABASE_URL not set');
		const firstPool = new pg.Pool({ connectionString, max: 1 });
		const secondPool = new pg.Pool({ connectionString, max: 1 });
		pools.push(firstPool, secondPool);
		const entered = deferred();
		const release = deferred();
		let executions = 0;

		const first = withPgTransitionRunLock(
			firstPool,
			'dbsp-e2e-apply-run-lock',
			async () => {
				executions += 1;
				entered.resolve();
				await release.promise;
			},
		);
		await entered.promise;
		const second = await withPgTransitionRunLock(
			secondPool,
			'dbsp-e2e-apply-run-lock',
			async () => {
				executions += 1;
			},
		);
		expect(second).toEqual({ kind: 'busy' });
		expect(executions).toBe(1);
		release.resolve();
		await expect(first).resolves.toEqual({
			kind: 'acquired',
			value: undefined,
		});
	});
});
