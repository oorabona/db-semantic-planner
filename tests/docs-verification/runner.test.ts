import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs, { readdirSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { Pool } from 'pg';
import { generatedSuitesRootDirectory } from './generated-suite-path.js';
import { renderBlockModule, runBlock } from './runner.js';

const TMP_ROOT = join(process.cwd(), generatedSuitesRootDirectory(), '.tmp');

function scratchEntries(): string[] {
	return readdirSync(TMP_ROOT)
		.filter((entry) => entry.startsWith(`block-${process.pid}-`))
		.sort();
}

async function captureRejection(
	operation: () => Promise<void>,
): Promise<unknown> {
	let failure: unknown;
	let hasFailure = false;
	try {
		await operation();
	} catch (error) {
		failure = error;
		hasFailure = true;
	}
	assert.equal(hasFailure, true, 'operation must reject');
	return failure;
}

test('a completed run leaves no scratch file for this process', async () => {
	const before = scratchEntries();
	const concurrentEntry = join(
		TMP_ROOT,
		`block-${process.pid + 1}-${randomUUID()}.ts`,
	);
	fs.writeFileSync(concurrentEntry, 'export {};');

	try {
		await runBlock('const result = 1 + 1;', 'runner.test.ts', 23);

		assert.deepEqual(
			scratchEntries(),
			before,
			'completed run must leave no scratch file for this process',
		);
	} finally {
		const newEntries = scratchEntries().filter(
			(entry) => !before.includes(entry),
		);
		for (const entry of newEntries) {
			fs.unlinkSync(join(TMP_ROOT, entry));
		}
		fs.unlinkSync(concurrentEntry);
	}
});

test('a real-db module imports expect after block imports are stripped', () => {
	const body = renderBlockModule('expect(true).toBe(true);', true);

	assert.match(
		body,
		/^import \{ expect \} from 'vitest';$/m,
		'real-db module must import expect',
	);
});

test('falsy thrown values fail doctest blocks', async () => {
	const undefinedFailure = await captureRejection(() =>
		runBlock('throw undefined;', 'falsy-undefined.md', 11),
	);
	assert.match(
		(undefinedFailure as Error).message,
		/falsy-undefined\.md:11 — undefined/,
		'throw undefined must fail the block',
	);

	const zeroFailure = await captureRejection(() =>
		runBlock('throw 0;', 'falsy-zero.md', 12),
	);
	assert.match(
		(zeroFailure as Error).message,
		/falsy-zero\.md:12 — 0/,
		'throw 0 must fail the block',
	);
});

test('a partial scratch module is removed when writing fails, even when retention is enabled', async () => {
	const before = scratchEntries();
	const originalWriteFileSync = fs.writeFileSync;
	const originalKeepFailedModules =
		process.env.DBSP_DOCTEST_KEEP_FAILED_MODULES;
	process.env.DBSP_DOCTEST_KEEP_FAILED_MODULES = '1';

	try {
		fs.writeFileSync = ((
			path: Parameters<typeof fs.writeFileSync>[0],
			data: Parameters<typeof fs.writeFileSync>[1],
			options?: Parameters<typeof fs.writeFileSync>[2],
		) => {
			if (String(path).startsWith(TMP_ROOT)) {
				originalWriteFileSync(path, data, options);
				throw new Error('injected write failure');
			}
			return originalWriteFileSync(path, data, options);
		}) as typeof fs.writeFileSync;
		syncBuiltinESMExports();

		const moduleUrl = new URL(
			`./runner.ts?write-failure=${randomUUID()}`,
			import.meta.url,
		).href;
		const { runBlock: runBlockWithWriteFailure } = await import(moduleUrl);
		await assert.rejects(
			runBlockWithWriteFailure('const result = 1 + 1;', 'write-failure.md', 17),
			/write-failure\.md:17 — injected write failure/,
		);
		assert.deepEqual(
			scratchEntries(),
			before,
			'partial scratch module must be removed after a failed write',
		);
	} finally {
		fs.writeFileSync = originalWriteFileSync;
		syncBuiltinESMExports();
		const newEntries = scratchEntries().filter(
			(entry) => !before.includes(entry),
		);
		for (const entry of newEntries) {
			fs.unlinkSync(join(TMP_ROOT, entry));
		}
		if (originalKeepFailedModules === undefined) {
			delete process.env.DBSP_DOCTEST_KEEP_FAILED_MODULES;
		} else {
			process.env.DBSP_DOCTEST_KEEP_FAILED_MODULES = originalKeepFailedModules;
		}
	}
});

test('a scratch operation and its unlink failure are both retained', async () => {
	const originalWriteFileSync = fs.writeFileSync;
	const originalUnlinkSync = fs.unlinkSync;
	let failedTmpFile: string | undefined;

	try {
		fs.writeFileSync = ((
			path: Parameters<typeof fs.writeFileSync>[0],
			data: Parameters<typeof fs.writeFileSync>[1],
			options?: Parameters<typeof fs.writeFileSync>[2],
		) => {
			if (String(path).startsWith(TMP_ROOT)) {
				originalWriteFileSync(path, data, options);
				throw new Error('injected write failure');
			}
			return originalWriteFileSync(path, data, options);
		}) as typeof fs.writeFileSync;
		fs.unlinkSync = ((path: Parameters<typeof fs.unlinkSync>[0]) => {
			if (String(path).startsWith(TMP_ROOT)) {
				failedTmpFile = String(path);
				throw new Error('injected unlink failure');
			}
			return originalUnlinkSync(path);
		}) as typeof fs.unlinkSync;
		syncBuiltinESMExports();

		const moduleUrl = new URL(
			`./runner.ts?scratch-aggregate=${randomUUID()}`,
			import.meta.url,
		).href;
		const { runBlock: runBlockWithFailures } = await import(moduleUrl);
		const failure = await captureRejection(() =>
			runBlockWithFailures('const result = 1 + 1;', 'aggregate.md', 27),
		);

		assert.ok(failure instanceof AggregateError);
		assert.match(
			failure.message,
			/aggregate\.md:27 — documentation block and scratch cleanup both failed/,
		);
		assert.deepEqual(
			failure.errors,
			[
				new Error('injected write failure'),
				new Error('injected unlink failure'),
			],
			'both original operation and unlink failures must be visible',
		);
	} finally {
		fs.writeFileSync = originalWriteFileSync;
		fs.unlinkSync = originalUnlinkSync;
		syncBuiltinESMExports();
		if (failedTmpFile !== undefined) {
			originalUnlinkSync(failedTmpFile);
		}
	}
});

test('a falsy unlink failure retains its value and names the doctest location', async () => {
	const originalUnlinkSync = fs.unlinkSync;
	let failedTmpFile: string | undefined;

	try {
		fs.unlinkSync = ((path: Parameters<typeof fs.unlinkSync>[0]) => {
			if (String(path).startsWith(TMP_ROOT)) {
				failedTmpFile = String(path);
				throw undefined;
			}
			return originalUnlinkSync(path);
		}) as typeof fs.unlinkSync;
		syncBuiltinESMExports();

		const moduleUrl = new URL(
			`./runner.ts?undefined-unlink=${randomUUID()}`,
			import.meta.url,
		).href;
		const { runBlock: runBlockWithUndefinedUnlink } = await import(moduleUrl);
		const failure = await captureRejection(() =>
			runBlockWithUndefinedUnlink('const result = 1 + 1;', 'unlink.md', 29),
		);

		assert.match(
			(failure as Error).message,
			/unlink\.md:29 — mandatory scratch cleanup failed/,
		);
		assert.ok(
			Object.hasOwn(failure as object, 'cause'),
			'the location error must retain an undefined cleanup failure as its cause',
		);
		assert.equal((failure as Error).cause, undefined);
	} finally {
		fs.unlinkSync = originalUnlinkSync;
		syncBuiltinESMExports();
		if (failedTmpFile !== undefined) {
			originalUnlinkSync(failedTmpFile);
		}
	}
});

test('a real-db reset failure ends the pool and retains an end failure', async () => {
	const originalRealDb = process.env.DBSP_DOCTEST_REAL_DB;
	const stubPool = Pool.prototype as unknown as {
		query: (...args: unknown[]) => Promise<unknown>;
		end: (...args: unknown[]) => Promise<void>;
	};
	const originalQuery = stubPool.query;
	const originalEnd = stubPool.end;
	const resetFailure = new Error('injected reset failure');
	const endFailure = new Error('injected pool end failure');
	let endCalls = 0;
	process.env.DBSP_DOCTEST_REAL_DB = '1';

	try {
		stubPool.query = async () => {
			throw resetFailure;
		};
		stubPool.end = async () => {
			endCalls += 1;
			throw endFailure;
		};

		const moduleUrl = new URL(
			`./runner.ts?real-db-reset=${randomUUID()}`,
			import.meta.url,
		).href;
		const { runBlock: runRealDbBlock } = await import(moduleUrl);
		const failure = await captureRejection(() =>
			runRealDbBlock('const result = 1 + 1;', 'real-db-reset.md', 31, {
				realDbOnly: true,
			}),
		);

		assert.equal(endCalls, 1, 'pool.end() must run after a reset failure');
		assert.ok(failure instanceof Error);
		assert.match(
			failure.message,
			/real-db-reset\.md:31 — documentation block and mandatory cleanup both failed/,
		);
		assert.ok(failure.cause instanceof AggregateError);
		assert.deepEqual(
			failure.cause.errors,
			[resetFailure, endFailure],
			'both reset and pool shutdown failures must be visible',
		);
	} finally {
		stubPool.query = originalQuery;
		stubPool.end = originalEnd;
		if (originalRealDb === undefined) {
			delete process.env.DBSP_DOCTEST_REAL_DB;
		} else {
			process.env.DBSP_DOCTEST_REAL_DB = originalRealDb;
		}
	}
});

test('a real-db block return still fails when ending its pool fails', async () => {
	const originalRealDb = process.env.DBSP_DOCTEST_REAL_DB;
	const stubPool = Pool.prototype as unknown as {
		query: (...args: unknown[]) => Promise<unknown>;
		end: (...args: unknown[]) => Promise<void>;
	};
	const originalQuery = stubPool.query;
	const originalEnd = stubPool.end;
	const endFailure = new Error('injected pool end failure after return');
	let endCalls = 0;
	process.env.DBSP_DOCTEST_REAL_DB = '1';

	try {
		stubPool.query = async () => ({ rows: [], rowCount: 0 });
		stubPool.end = async () => {
			endCalls += 1;
			throw endFailure;
		};

		const moduleUrl = new URL(
			`./runner.ts?real-db-return=${randomUUID()}`,
			import.meta.url,
		).href;
		const { runBlock: runRealDbBlock } = await import(moduleUrl);
		const failure = await captureRejection(() =>
			runRealDbBlock('return;', 'real-db-return.md', 37, {
				realDbOnly: true,
			}),
		);

		assert.equal(endCalls, 1, 'pool.end() must run after a block return');
		assert.match(
			(failure as Error).message,
			/real-db-return\.md:37 — injected pool end failure after return/,
			'the cleanup failure must fail a block that returns early',
		);
		assert.equal(
			(failure as Error).cause,
			endFailure,
			'the cleanup failure must remain the location error cause',
		);
	} finally {
		stubPool.query = originalQuery;
		stubPool.end = originalEnd;
		if (originalRealDb === undefined) {
			delete process.env.DBSP_DOCTEST_REAL_DB;
		} else {
			process.env.DBSP_DOCTEST_REAL_DB = originalRealDb;
		}
	}
});

test('a real-db block cannot shadow the harness pool with var', async () => {
	const originalRealDb = process.env.DBSP_DOCTEST_REAL_DB;
	const stubPool = Pool.prototype as unknown as {
		query: (...args: unknown[]) => Promise<unknown>;
		end: (...args: unknown[]) => Promise<void>;
	};
	const originalQuery = stubPool.query;
	const originalEnd = stubPool.end;
	let endCalls = 0;
	process.env.DBSP_DOCTEST_REAL_DB = '1';

	try {
		stubPool.query = async () => ({ rows: [], rowCount: 0 });
		stubPool.end = async () => {
			endCalls += 1;
		};

		const moduleUrl = new URL(
			`./runner.ts?real-db-var-pool=${randomUUID()}`,
			import.meta.url,
		).href;
		const { runBlock: runRealDbBlock } = await import(moduleUrl);
		await runRealDbBlock('var __pool = undefined;', 'real-db-var-pool.md', 39, {
			realDbOnly: true,
		});

		assert.equal(
			endCalls,
			1,
			'the lifecycle must end its own pool after a block declares var __pool',
		);
	} finally {
		stubPool.query = originalQuery;
		stubPool.end = originalEnd;
		if (originalRealDb === undefined) {
			delete process.env.DBSP_DOCTEST_REAL_DB;
		} else {
			process.env.DBSP_DOCTEST_REAL_DB = originalRealDb;
		}
	}
});

test('an empty foreign aggregate retains its own message', async () => {
	const emptyFailure = await captureRejection(() =>
		runBlock('await Promise.any([]);', 'empty-aggregate.md', 41),
	);
	assert.match(
		(emptyFailure as Error).message,
		/empty-aggregate\.md:41 — All promises were rejected/,
		'an empty foreign aggregate must use its own diagnostic message',
	);
	assert.ok(
		(emptyFailure as Error).cause instanceof AggregateError,
		'the foreign aggregate must remain the location error cause',
	);
	const foreignAggregate = (emptyFailure as Error).cause as AggregateError;
	assert.equal(foreignAggregate.message, 'All promises were rejected');
	assert.deepEqual(foreignAggregate.errors, []);
});

test('an unstringifiable thrown value still receives a location error', async () => {
	const failure = await captureRejection(() =>
		runBlock('throw Object.create(null);', 'unstringifiable.md', 45),
	);

	assert.match(
		(failure as Error).message,
		/unstringifiable\.md:45 — <non-stringifiable thrown value>/,
	);
	assert.equal(
		Object.getPrototypeOf((failure as Error).cause),
		null,
		'the original non-stringifiable value must remain the cause',
	);
});

test('a throwing Error message getter cannot replace the original failure', async () => {
	const failure = await captureRejection(() =>
		runBlock(
			`class BadMessageError extends Error {
				get message() { throw new Error('message getter failed'); }
			}
			throw new BadMessageError();`,
			'bad-message.md',
			46,
		),
	);

	assert.match(
		(failure as Error).message,
		/bad-message\.md:46 — <non-stringifiable thrown value>/,
	);
	assert.notEqual((failure as Error).cause, undefined);
});

test('a two-child foreign aggregate retains its message and identity', async () => {
	const applicationFailure = await captureRejection(() =>
		runBlock(
			"throw new AggregateError([new Error('first child'), new Error('second child')], 'application aggregate');",
			'foreign-aggregate.md',
			43,
		),
	);
	assert.match(
		(applicationFailure as Error).message,
		/foreign-aggregate\.md:43 — application aggregate/,
		'a foreign aggregate must retain its own message',
	);
	const applicationCause = (applicationFailure as Error).cause;
	assert.ok(applicationCause instanceof AggregateError);
	assert.equal(applicationCause.message, 'application aggregate');
	assert.deepEqual(
		applicationCause.errors.map((error) =>
			error instanceof Error ? error.message : error,
		),
		['first child', 'second child'],
		'a foreign aggregate must retain both children',
	);
});

test('a foreign aggregate remains intact alongside an unlink failure', async () => {
	const originalUnlinkSync = fs.unlinkSync;
	let failedTmpFile: string | undefined;

	try {
		fs.unlinkSync = ((path: Parameters<typeof fs.unlinkSync>[0]) => {
			if (String(path).startsWith(TMP_ROOT)) {
				failedTmpFile = String(path);
				throw new Error('injected unlink failure');
			}
			return originalUnlinkSync(path);
		}) as typeof fs.unlinkSync;
		syncBuiltinESMExports();

		const moduleUrl = new URL(
			`./runner.ts?foreign-aggregate-unlink=${randomUUID()}`,
			import.meta.url,
		).href;
		const { runBlock: runBlockWithUnlinkFailure } = await import(moduleUrl);
		const failure = await captureRejection(() =>
			runBlockWithUnlinkFailure(
				"throw new AggregateError([new Error('first child'), new Error('second child')], 'application aggregate');",
				'foreign-aggregate-unlink.md',
				47,
			),
		);

		assert.ok(failure instanceof AggregateError);
		assert.match(
			failure.message,
			/foreign-aggregate-unlink\.md:47 — documentation block and scratch cleanup both failed/,
		);
		const foreignAggregate = failure.errors[0];
		assert.ok(foreignAggregate instanceof AggregateError);
		assert.equal(foreignAggregate.message, 'application aggregate');
		assert.deepEqual(
			foreignAggregate.errors.map((error) =>
				error instanceof Error ? error.message : error,
			),
			['first child', 'second child'],
		);
	} finally {
		fs.unlinkSync = originalUnlinkSync;
		syncBuiltinESMExports();
		if (failedTmpFile !== undefined) {
			originalUnlinkSync(failedTmpFile);
		}
	}
});
