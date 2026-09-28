import {
	type PgConvergeRefusal,
	PgConvergeRefusalError,
	type PgConvergeResult,
} from '@dbsp/adapter-pgsql';
import { ModelIRImpl } from '@dbsp/core';
import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	exitCodeForMigrateOutcome,
	formatMigrateHuman,
	formatMigrateJson,
	MIGRATE_OUTCOME_CONTRACT,
	type MigrateDeps,
	runMigrate,
} from './migrate.js';

const model = new ModelIRImpl(new Map(), new Map(), new Map());
const loaded = { definition: {}, model, tableNames: [] };
const db = 'postgres://operator:top-secret@localhost:5432/example';

function dependencies(overrides: Partial<MigrateDeps> = {}) {
	const pool = new pg.Pool();
	const end = vi.spyOn(pool, 'end').mockResolvedValue(undefined);
	return {
		pool,
		end,
		loadSchema: vi.fn().mockResolvedValue(loaded),
		createDbConnection: vi.fn().mockResolvedValue({ pool }),
		converge: vi.fn(),
		...overrides,
	};
}

async function migrate(
	result: PgConvergeResult,
	overrides: Partial<MigrateDeps> = {},
	options: Record<string, unknown> = {},
) {
	const deps = dependencies({
		converge: vi.fn().mockResolvedValue(result),
		...overrides,
	});
	const value = await runMigrate('schema.ts', { db, ...options }, deps);
	return { deps, value };
}

afterEach(() => vi.restoreAllMocks());

describe('dbsp migrate outcomes', () => {
	it.each([
		['no-drift', { kind: 'no-drift', applied: [] }, 0],
		['applied', { kind: 'applied', applied: ['create-table'] }, 0],
		[
			'partially-applied',
			{
				kind: 'partially-applied',
				completedStepKeys: ['step:one'],
				notStartedStepKeys: ['step:two'],
				detail: 'step failed',
			},
			11,
		],
		[
			'transport-ambiguous',
			{ kind: 'transport-ambiguous', detail: 'lost reply' },
			65,
		],
	] as const)(
		'%s maps every converge result to its contract',
		async (outcome, result, exitCode) => {
			const { value } = await migrate(result);
			expect(value.outcome).toBe(outcome);
			expect(value.exitCode).toBe(exitCode);
			expect(formatMigrateJson(value, db)).toMatchObject({
				outcome,
				exitCode,
				schema: 'public',
			});
		},
	);

	it.each([
		'invalid-options',
		'unsupported-change',
		'unmanaged-object',
		'unmanaged-parent',
		'concurrent-drift',
		'ledger-absent',
		'incompatible-ledger',
		'unsupported-server',
		'busy',
		'recovery-required',
		'execution-refused',
		'adoption-refused',
	] satisfies readonly PgConvergeRefusal[])(
		'%s refusal maps exhaustively',
		async (refusal) => {
			const error = new PgConvergeRefusalError(
				refusal,
				[{ kind: 'create_index', table: 'accounts', details: 'unsafe' }],
				'database detail',
				['run:one'],
				['execution:one'],
				['run:busy'],
			);
			const { value } = await migrate(
				{ kind: 'no-drift', applied: [] },
				{ converge: vi.fn().mockRejectedValue(error) },
			);
			expect(value.outcome).toBe(refusal);
			expect(value.exitCode).toBe(exitCodeForMigrateOutcome(refusal));
			expect(value.changes).toHaveLength(1);
			expect(value.runIds).toEqual(['run:one']);
		},
	);

	it('maps a non-refusal throw to migrate-failed and escapes its human text', async () => {
		const { value } = await migrate(
			{ kind: 'no-drift', applied: [] },
			{ converge: vi.fn().mockRejectedValue(new Error('bad\nreply')) },
		);
		expect(value).toMatchObject({ outcome: 'migrate-failed', exitCode: 29 });
		expect(formatMigrateHuman(value, db)).toContain('bad\\nreply');
	});

	it('stops after schema loading fails', async () => {
		const deps = dependencies({
			loadSchema: vi.fn().mockRejectedValue(new Error('broken schema')),
		});
		const value = await runMigrate('schema.ts', { db }, deps);
		expect(value).toMatchObject({ outcome: 'load-failed', exitCode: 27 });
		expect(deps.createDbConnection).not.toHaveBeenCalled();
		expect(deps.converge).not.toHaveBeenCalled();
	});

	it.each(['missing', ':index', 'table:'])(
		'rejects malformed external index %s before loading',
		async (externalIndex) => {
			const deps = dependencies();
			const value = await runMigrate(
				'schema.ts',
				{ db, externalIndex: [externalIndex] },
				deps,
			);
			expect(value).toMatchObject({ outcome: 'invalid-options', exitCode: 70 });
			expect(deps.loadSchema).not.toHaveBeenCalled();
			expect(deps.createDbConnection).not.toHaveBeenCalled();
		},
	);

	it('splits external indexes at their first colon and passes schema and casing', async () => {
		const deps = dependencies({
			loadSchema: vi
				.fn()
				.mockResolvedValue({ ...loaded, dbCasing: 'snake_case' }),
			converge: vi.fn().mockResolvedValue({ kind: 'no-drift', applied: [] }),
		});
		await runMigrate(
			'schema.ts',
			{ db, schema: 'tenant', externalIndex: ['a:b:c'] },
			deps,
		);
		expect(deps.converge).toHaveBeenCalledWith(deps.pool, model, {
			schema: 'tenant',
			dbCasing: 'snake_case',
			externalIndexes: [{ table: 'a', name: 'b:c' }],
		});
	});

	it('omits absent casing and external index keys', async () => {
		const { deps } = await migrate({ kind: 'no-drift', applied: [] });
		expect(deps.converge).toHaveBeenCalledWith(deps.pool, model, {
			schema: 'public',
		});
	});

	it('ends the pool once after successful, refused, and thrown convergence', async () => {
		const success = await migrate({
			kind: 'applied',
			applied: ['create-table'],
		});
		expect(success.deps.end).toHaveBeenCalledTimes(1);
		const refusal = await migrate(
			{ kind: 'no-drift', applied: [] },
			{
				converge: vi
					.fn()
					.mockRejectedValue(new PgConvergeRefusalError('busy', [])),
			},
		);
		expect(refusal.deps.end).toHaveBeenCalledTimes(1);
		const failed = await migrate(
			{ kind: 'no-drift', applied: [] },
			{ converge: vi.fn().mockRejectedValue(new Error('database rejected')) },
		);
		expect(failed.deps.end).toHaveBeenCalledTimes(1);
	});

	it('turns successful cleanup failure into cleanup-failed but retains refusal', async () => {
		const pool = new pg.Pool();
		const end = vi
			.spyOn(pool, 'end')
			.mockRejectedValue(new Error('close failed'));
		const deps = dependencies({
			createDbConnection: vi.fn().mockResolvedValue({ pool }),
			converge: vi
				.fn()
				.mockResolvedValue({ kind: 'applied', applied: ['create-table'] }),
		});
		const value = await runMigrate('schema.ts', { db }, deps);
		expect(value).toMatchObject({
			outcome: 'cleanup-failed',
			exitCode: 79,
			cleanupError: 'close failed',
		});
		expect(value.result).toEqual({
			kind: 'applied',
			applied: ['create-table'],
		});
		const refused = await runMigrate(
			'schema.ts',
			{ db },
			{
				...deps,
				converge: vi
					.fn()
					.mockRejectedValue(new PgConvergeRefusalError('busy', [])),
			},
		);
		expect(refused).toMatchObject({
			outcome: 'busy',
			exitCode: 21,
			cleanupError: 'close failed',
		});
	});

	it('prints reconcile instructions per recovery run and escapes terminal controls', async () => {
		const { value } = await migrate(
			{ kind: 'no-drift', applied: [] },
			{
				converge: vi
					.fn()
					.mockRejectedValue(
						new PgConvergeRefusalError(
							'recovery-required',
							[],
							'detail\nnext',
							['run:one\ntwo', 'run:three'],
						),
					),
			},
		);
		const text = formatMigrateHuman(value, db);
		expect(text).toContain('dbsp reconcile --db <database> run:one\\ntwo');
		expect(text).toContain('dbsp reconcile --db <database> run:three');
		expect(text).toContain('detail\\nnext');
	});

	it('redacts both URL and password from all renderer diagnostic fields', async () => {
		const { value } = await migrate(
			{ kind: 'no-drift', applied: [] },
			{ converge: vi.fn().mockRejectedValue(new Error(`${db} top-secret`)) },
		);
		for (const rendered of [
			JSON.stringify(formatMigrateJson(value, db)),
			formatMigrateHuman(value, db),
		]) {
			expect(rendered).not.toContain(db);
			expect(rendered).not.toContain('top-secret');
			expect(rendered).toContain('<redacted>');
		}
	});

	it('prints ledger preflight instruction with path and effective schema but no URL', async () => {
		const { value } = await migrate(
			{ kind: 'no-drift', applied: [] },
			{
				converge: vi
					.fn()
					.mockRejectedValue(new PgConvergeRefusalError('ledger-absent', [])),
			},
			{ schema: 'tenant' },
		);
		const text = formatMigrateHuman(value, db);
		expect(text).toContain('--schema-file schema.ts --scope tenant');
		expect(text).not.toContain(db);
	});

	it('keeps JSON as one parseable document and preserves newline detail', async () => {
		const { value } = await migrate({
			kind: 'transport-ambiguous',
			detail: 'line one\nline two',
		});
		const document = formatMigrateJson(value, db);
		expect(JSON.parse(JSON.stringify(document))).toMatchObject({
			outcome: 'transport-ambiguous',
			exitCode: 65,
			detail: 'line one\nline two',
		});
	});

	it('refuses an invalid format before loading', async () => {
		const deps = dependencies();
		const value = await runMigrate('schema.ts', { db, format: 'yaml' }, deps);
		expect(value).toMatchObject({ outcome: 'invalid-options', exitCode: 70 });
		expect(deps.loadSchema).not.toHaveBeenCalled();
	});

	it('defines every outcome once and reserves exit zero for success', () => {
		expect(
			new Set(MIGRATE_OUTCOME_CONTRACT.map(([outcome]) => outcome)).size,
		).toBe(MIGRATE_OUTCOME_CONTRACT.length);
		expect(
			MIGRATE_OUTCOME_CONTRACT.filter(([, exitCode]) => exitCode === 0).map(
				([outcome]) => outcome,
			),
		).toEqual(['no-drift', 'applied']);
	});
});
