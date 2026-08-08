import type { ModelIR } from '@dbsp/core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runApply } from '../../packages/cli/src/commands/apply.js';
import { runPlan } from '../../packages/cli/src/commands/plan.js';
import { createSchema, dropSchema, getTestPool } from './testkit/index.js';
import { runPreflight } from './transition-reinitialize-preflight-testkit.js';

const schemaName = 'apply_command_enum_add_value';

function quoteIdent(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function enumModel(values: readonly string[]): ModelIR {
	return {
		tables: new Map(),
		relations: new Map(),
		enums: new Map([
			['status', { name: 'status', schema: schemaName, values }],
		]),
		getTable: () => undefined,
		getRelation: () => undefined,
		getRelationsFrom: () => [],
		getRelationsTo: () => [],
		isAmbiguous: () => ({ ambiguous: false, options: [] }),
	};
}

describe('dbsp apply: enum-add-value', () => {
	let runId: string | undefined;

	beforeAll(async () => {
		await createSchema(schemaName);
		const preflight = await runPreflight([schemaName]);
		if (preflight.scopes.some((scope) => scope.outcome === 'failed'))
			throw new Error('fixture could not initialize a current ledger');
	});

	afterEach(async () => {
		const pool = await getTestPool();
		if (runId) {
			await pool.query(
				'DELETE FROM dbsp_meta.dbsp_transition_authorization WHERE run_id = $1',
				[runId],
			);
			await pool.query(
				'DELETE FROM dbsp_meta.dbsp_transition_journal WHERE run_id = $1',
				[runId],
			);
			await pool.query(
				'DELETE FROM dbsp_meta.dbsp_transition_run_plan WHERE run_id = $1',
				[runId],
			);
			await pool.query(
				'DELETE FROM dbsp_meta.dbsp_transition_run WHERE run_id = $1',
				[runId],
			);
			runId = undefined;
		}
		await pool.query(
			`DROP TYPE IF EXISTS ${quoteIdent(schemaName)}.${quoteIdent('status')} CASCADE`,
		);
	});

	afterAll(async () => dropSchema(schemaName));

	it('mutation: releasing the pinned apply session before its observed journal write loses the completed audit event', async () => {
		const pool = await getTestPool();
		await pool.query(
			`CREATE TYPE ${quoteIdent(schemaName)}.${quoteIdent('status')} AS ENUM ('inactive', 'active')`,
		);
		const planned = await runPlan(
			{
				db: 'postgres://testcontainer/not-used',
				schemaFile: 'unused-by-e2e-fixture.ts',
				schema: schemaName,
			},
			{
				createDbConnection: async () => ({
					pool,
					release: () => Promise.resolve(),
				}),
				loadSchema: async () => ({
					model: enumModel(['inactive', 'pending', 'active']),
					definition: {},
					tableNames: [],
				}),
			},
		);
		expect(planned.runId).toBeTruthy();
		runId = planned.runId!;

		const applied = await runApply(
			runId,
			{
				db: 'postgres://testcontainer/not-used',
				planDigest: planned.planDigest!,
				...(planned.plan
					? {
							accept: planned.plan.assumptions.map(
								(assumption) => assumption.class,
							),
						}
					: {}),
			},
			pool,
		);
		expect(applied.outcome).toBe('completed');

		const labels = await pool.query(
			'SELECT e.enumlabel AS label FROM pg_catalog.pg_type t ' +
				'JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace ' +
				'JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid ' +
				'WHERE n.nspname = $1 AND t.typname = $2 ORDER BY e.enumsortorder',
			[schemaName, 'status'],
		);
		expect(labels.rows.map((row) => row.label)).toEqual([
			'inactive',
			'pending',
			'active',
		]);
		await expect(
			pool.query(
				'SELECT * FROM dbsp_meta.dbsp_transition_authorization WHERE run_id = $1',
				[runId],
			),
		).resolves.toMatchObject({ rows: [expect.any(Object)] });
		await expect(
			pool.query(
				"SELECT event FROM dbsp_meta.dbsp_transition_journal WHERE run_id = $1 AND event = 'observed'",
				[runId],
			),
		).resolves.toMatchObject({ rows: [{ event: 'observed' }] });
		const auditOrder = await pool.query(
			'SELECT ' +
				'(SELECT min(authorized_at) FROM dbsp_meta.dbsp_transition_authorization WHERE run_id = $1) AS authorized_at, ' +
				'(SELECT min(recorded_at) FROM dbsp_meta.dbsp_transition_journal WHERE run_id = $1) AS first_step_at',
			[runId],
		);
		const audit = auditOrder.rows[0] as {
			authorized_at: Date | string;
			first_step_at: Date | string;
		};
		expect(new Date(audit.authorized_at).getTime()).toBeLessThanOrEqual(
			new Date(audit.first_step_at).getTime(),
		);
	});
});
