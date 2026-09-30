import {
	escapeDiagnosticText,
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
	type MigrateResult,
	migrateCommand,
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
		'database-read-only',
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
		expect(deps.converge).toHaveBeenCalledWith(
			deps.pool,
			expect.objectContaining({ schema: 'tenant' }),
			{ externalIndexes: [{ table: 'a', name: 'b:c' }] },
		);
	});

	it('omits absent casing and external index keys', async () => {
		const { deps } = await migrate({ kind: 'no-drift', applied: [] });
		expect(deps.converge).toHaveBeenCalledWith(
			deps.pool,
			expect.objectContaining({ schema: 'public' }),
			{},
		);
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

	it('prints completed and not-started partial application keys as escaped text', async () => {
		const { value } = await migrate({
			kind: 'partially-applied',
			completedStepKeys: ['step:one\ntwo', 'step:three'],
			notStartedStepKeys: ['step:four', 'step:five'],
			detail: 'step failed',
		});
		expect(formatMigrateHuman(value, db)).toContain(
			'completed: step:one\\ntwo, step:three\nnot started: step:four, step:five\nstep failed',
		);

		const { value: empty } = await migrate({
			kind: 'partially-applied',
			completedStepKeys: [],
			notStartedStepKeys: [],
			detail: 'step failed',
		});
		expect(formatMigrateHuman(empty, db)).toContain(
			'completed: none\nnot started: none',
		);
	});

	it('prints cleanup convergence details before the cleanup error', async () => {
		const pool = new pg.Pool();
		vi.spyOn(pool, 'end').mockRejectedValue(new Error('close failed'));
		const deps = dependencies({
			createDbConnection: vi.fn().mockResolvedValue({ pool }),
			converge: vi
				.fn()
				.mockResolvedValue({ kind: 'applied', applied: ['create\ntable'] }),
		});
		const value = await runMigrate('schema.ts', { db }, deps);
		expect(formatMigrateHuman(value, db)).toContain(
			'convergence: applied\ncreate\\ntable\nConnection cleanup failed: close failed',
		);
	});

	it('prints a reconcile placeholder and labeled escaped recovery run ids', async () => {
		const runIds = ['run-1', 'run;$(x) y', 'run\nid'];
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
							runIds,
						),
					),
			},
		);
		const text = formatMigrateHuman(value, db);
		const reconcileLines = text
			.split('\n')
			.filter((line) => line.startsWith('dbsp reconcile'));
		expect(reconcileLines).toEqual(['dbsp reconcile --db <database> <run-id>']);
		for (const runId of runIds) {
			expect(reconcileLines[0]).not.toContain(runId);
			expect(text.split('\n')).toContain(
				`run id: ${escapeDiagnosticText(runId)}`,
			);
		}
		expect(text).toContain('detail\\nnext');
	});

	it('defers execution-id ownership guidance to the adapter detail', async () => {
		const executionId = 'execution:one';
		const executionIds = [executionId];
		const detail =
			'converge found live ledger reservations; journal attribution for execution execution:one could not be read (SQLSTATE 42501); the journal owner must resolve it';
		const { value } = await migrate(
			{ kind: 'no-drift', applied: [] },
			{
				converge: vi
					.fn()
					.mockRejectedValue(
						new PgConvergeRefusalError(
							'recovery-required',
							[],
							detail,
							undefined,
							executionIds,
						),
					),
			},
		);
		const lines = formatMigrateHuman(value, db).split('\n');
		expect(lines.some((line) => line.startsWith('dbsp reconcile'))).toBe(false);
		expect(lines).toEqual([
			'recovery-required: public',
			detail,
			`execution id: ${escapeDiagnosticText(executionId)}`,
			'no dbsp command resolves a claim by execution id; the owner named in the detail above must resolve these claims',
		]);
		expect(lines.join('\n')).toContain('journal owner must resolve it');
		expect(lines.join('\n')).not.toContain('ledger owner');
	});

	it('prints busy-only recovery guidance without a reconcile command', async () => {
		const busyRunIds = ['run:busy\nnext', 'run:still-busy'];
		const { value } = await migrate(
			{ kind: 'no-drift', applied: [] },
			{
				converge: vi
					.fn()
					.mockRejectedValue(
						new PgConvergeRefusalError(
							'recovery-required',
							[],
							undefined,
							undefined,
							undefined,
							busyRunIds,
						),
					),
			},
		);
		const lines = formatMigrateHuman(value, db).split('\n');
		expect(lines.some((line) => line.startsWith('dbsp reconcile'))).toBe(false);
		for (const busyRunId of busyRunIds)
			expect(lines).toContain(
				`busy run id: ${escapeDiagnosticText(busyRunId)}`,
			);
		expect(lines).toContain('these runs are still executing; retry later');
	});

	it('orders all recovery guidance by actionable identifier type', async () => {
		const runIds = ['run:one'];
		const executionIds = ['execution:one'];
		const busyRunIds = ['run:busy'];
		const { value } = await migrate(
			{ kind: 'no-drift', applied: [] },
			{
				converge: vi
					.fn()
					.mockRejectedValue(
						new PgConvergeRefusalError(
							'recovery-required',
							[],
							undefined,
							runIds,
							executionIds,
							busyRunIds,
						),
					),
			},
		);
		expect(formatMigrateHuman(value, db).split('\n')).toEqual([
			'recovery-required: public',
			'dbsp reconcile --db <database> <run-id>',
			'run id: run:one',
			'busy run id: run:busy',
			'these runs are still executing; retry later',
			'execution id: execution:one',
			'no dbsp command resolves a claim by execution id; the owner named in the detail above must resolve these claims',
		]);
	});

	it.each([
		[
			'applied',
			(entries: readonly string[]): MigrateResult => ({
				outcome: 'applied',
				exitCode: 0,
				schema: 'public',
				schemaFile: 'schema.ts',
				applied: entries,
			}),
			'entry:',
		],
		[
			'changes',
			(entries: readonly string[]): MigrateResult => ({
				outcome: 'unsupported-change',
				exitCode: 74,
				schema: 'public',
				schemaFile: 'schema.ts',
				changes: entries.map((details) => ({ kind: 'create_index', details })),
			}),
			'{"kind":"create_index","details":"entry:',
		],
		[
			'runIds',
			(entries: readonly string[]): MigrateResult => ({
				outcome: 'recovery-required',
				exitCode: 64,
				schema: 'public',
				schemaFile: 'schema.ts',
				runIds: entries,
			}),
			'run id: entry:',
		],
		[
			'busyRunIds',
			(entries: readonly string[]): MigrateResult => ({
				outcome: 'recovery-required',
				exitCode: 64,
				schema: 'public',
				schemaFile: 'schema.ts',
				busyRunIds: entries,
			}),
			'busy run id: entry:',
		],
		[
			'executionIds',
			(entries: readonly string[]): MigrateResult => ({
				outcome: 'recovery-required',
				exitCode: 64,
				schema: 'public',
				schemaFile: 'schema.ts',
				executionIds: entries,
			}),
			'execution id: entry:',
		],
		[
			'result.applied',
			(entries: readonly string[]): MigrateResult => ({
				outcome: 'cleanup-failed',
				exitCode: 79,
				schema: 'public',
				schemaFile: 'schema.ts',
				result: { kind: 'applied', applied: entries },
			}),
			'entry:',
		],
	] as const)(
		'renders 200,000 %s entries without expanding a push call',
		(source, createResult, entryPrefix) => {
			const entries = Array.from(
				{ length: 200_000 },
				(_, index) => `entry:${index}`,
			);
			const renderedEntries = formatMigrateHuman(createResult(entries), db)
				.split('\n')
				.filter((line) => line.startsWith(entryPrefix));
			expect(renderedEntries, `${source} entries`).toHaveLength(entries.length);
		},
	);

	it('documents external index operands and syntax errors in help', () => {
		const write = vi
			.spyOn(process.stdout, 'write')
			.mockImplementation(() => true);
		migrateCommand.outputHelp();
		const help = write.mock.calls.map(([text]) => String(text)).join('');
		expect(help).toContain('--external-index <model-table:index>');
		expect(help).toMatch(/the table\s+is the model name/);
		expect(help).toContain(
			'Command-line syntax errors (an unknown option, a missing --db or schema file) exit 1 with { status, error } under --format json, as for every dbsp command.',
		);
		expect(help).toContain(
			'invalid-options (70): an --external-index or --format value is malformed, or convergePg refused its options',
		);
	});

	it('collects external index operands in order', () => {
		migrateCommand.parseOptions([
			'--external-index',
			'users:users_email_idx',
			'--external-index',
			'orders:orders_number_idx',
			'--external-index',
			'audit:audit_event_idx',
		]);
		expect(migrateCommand.opts().externalIndex).toEqual([
			'users:users_email_idx',
			'orders:orders_number_idx',
			'audit:audit_event_idx',
		]);
	});

	it('redacts both URL and authority password from all renderer diagnostic fields', async () => {
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

	it('redacts decoded and raw password query values from diagnostics only', async () => {
		const queryDb =
			'postgres://user@host/db?password=query%20secret&password=second';
		const pool = new pg.Pool();
		vi.spyOn(pool, 'end').mockRejectedValue(
			new Error('query secret query%20secret second'),
		);
		const cleanup = await runMigrate(
			'schema.ts',
			{ db: queryDb },
			dependencies({
				createDbConnection: vi.fn().mockResolvedValue({ pool }),
				converge: vi.fn().mockResolvedValue({
					kind: 'transport-ambiguous',
					detail: 'query secret query%20secret second',
				}),
			}),
		);
		const failed = await migrate(
			{ kind: 'no-drift', applied: [] },
			{
				converge: vi
					.fn()
					.mockRejectedValue(new Error('query secret query%20secret second')),
			},
			{ db: queryDb },
		);
		for (const value of [cleanup, failed.value])
			for (const rendered of [
				JSON.stringify(formatMigrateJson(value, queryDb)),
				formatMigrateHuman(value, queryDb),
			]) {
				expect(rendered).not.toContain('query secret');
				expect(rendered).not.toContain('query%20secret');
				expect(rendered).not.toContain('second');
				expect(rendered).toContain('<redacted>');
			}
	});

	it('leaves changes untouched when a password matches a table name', async () => {
		const passwordDb = 'postgres://user@host/db?password=accounts';
		const { value } = await migrate(
			{ kind: 'no-drift', applied: [] },
			{
				converge: vi
					.fn()
					.mockRejectedValue(
						new PgConvergeRefusalError('unsupported-change', [
							{ kind: 'create_index', table: 'accounts', details: 'unsafe' },
						]),
					),
			},
			{ db: passwordDb },
		);
		expect(formatMigrateJson(value, passwordDb).changes).toEqual([
			{ kind: 'create_index', table: 'accounts', details: 'unsafe' },
		]);
		expect(formatMigrateHuman(value, passwordDb)).toContain(
			'"table":"accounts"',
		);
	});

	it('prints ledger preflight placeholders and labeled escaped values but no URL', async () => {
		const schemaFile = 'schema file; $(x).ts';
		const { value } = await migrate(
			{ kind: 'no-drift', applied: [] },
			{
				converge: vi
					.fn()
					.mockRejectedValue(new PgConvergeRefusalError('ledger-absent', [])),
			},
			{ schema: 'tenant\nschema' },
		);
		const withPath = { ...value, schemaFile };
		const text = formatMigrateHuman(withPath, db);
		expect(text).toContain(
			'dbsp preflight --reinitialize --db <database> --schema-file <schema-file> --scope <schema> --out <adoption-file>',
		);
		expect(text).toContain('schema file: schema file; $(x).ts');
		expect(text).toContain('schema: tenant\\nschema');
		expect(text).toContain('ledger-absent: tenant\\nschema');
		expect(text.split(schemaFile)).toHaveLength(2);
		expect(text).not.toContain('--schema-file schema file; $(x).ts');
		expect(text).not.toContain('--scope tenant\\nschema');
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
		expect(MIGRATE_OUTCOME_CONTRACT).toContainEqual([
			'database-read-only',
			34,
			'target cannot accept managed writes',
		]);
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
