import type { ModelIR } from '@dbsp/core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runPlan } from '../../packages/cli/src/commands/plan.js';
import { createSchema, dropSchema, getTestPool } from './testkit/index.js';

const schemaName = 'plan_command_enum_add_value';

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

describe('dbsp plan: enum-add-value', () => {
	let plannedRunId: string | undefined;

	beforeAll(async () => createSchema(schemaName));

	afterEach(async () => {
		const pool = await getTestPool();
		if (plannedRunId) {
			await pool.query(
				'DELETE FROM dbsp_meta.dbsp_transition_run_plan WHERE run_id = $1',
				[plannedRunId],
			);
			await pool.query(
				'DELETE FROM dbsp_meta.dbsp_transition_run WHERE run_id = $1',
				[plannedRunId],
			);
			plannedRunId = undefined;
		}
		await pool.query(
			`DROP TYPE IF EXISTS ${quoteIdent(schemaName)}.${quoteIdent('status')} CASCADE`,
		);
	});

	afterAll(async () => dropSchema(schemaName));

	it('proves and retains exactly one run and plan row without changing the target enum', async () => {
		const planningPool = await getTestPool();
		await planningPool.query(
			`CREATE TYPE ${quoteIdent(schemaName)}.${quoteIdent('status')} AS ENUM ('inactive', 'active')`,
		);
		const result = await runPlan(
			{
				db: 'postgres://testcontainer/not-used',
				schemaFile: 'unused-by-e2e-fixture.ts',
				schema: schemaName,
			},
			{
				createDbConnection: async () => ({
					pool: planningPool,
					release: () => Promise.resolve(),
				}),
				loadSchema: async () => ({
					model: enumModel(['inactive', 'pending', 'active']),
					definition: {},
					tableNames: [],
				}),
			},
		);

		expect(result.proveKind).toBe('proven');
		expect(result.persisted).toBe(true);
		expect(result.runId).toBeTruthy();
		const runId = result.runId!;
		plannedRunId = runId;
		const verificationPool = await getTestPool();
		const runs = await verificationPool.query(
			'SELECT run_id FROM dbsp_meta.dbsp_transition_run WHERE run_id = $1',
			[runId],
		);
		const plans = await verificationPool.query(
			'SELECT run_id FROM dbsp_meta.dbsp_transition_run_plan WHERE run_id = $1',
			[runId],
		);
		expect(runs.rows).toHaveLength(1);
		expect(plans.rows).toHaveLength(1);

		const labels = await verificationPool.query(
			'SELECT e.enumlabel AS label FROM pg_catalog.pg_type t ' +
				'JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace ' +
				'JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid ' +
				'WHERE n.nspname = $1 AND t.typname = $2 ORDER BY e.enumsortorder',
			[schemaName, 'status'],
		);
		expect(labels.rows.map((row) => row.label)).toEqual(['inactive', 'active']);
	});
});
