import { createPgsqlGeneratedManagedStep } from '@dbsp/adapter-pgsql';
import { lockPgJournalRun } from '@dbsp/adapter-pgsql/internal';
import { transitionPlanDigest } from '@dbsp/core';
import { mintDurablyLoadedRun } from '@dbsp/core/internal';
import pg from 'pg';
import { executeGeneratorPlan } from '../../packages/cli/src/commands/generator-execution.js';
import { checkpoint } from './harness/index.js';

const [mode, schema, rootName] = process.argv.slice(2);
const db = process.env.DATABASE_URL;

function quoteIdent(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

if (mode !== 'auth10' || !schema || !rootName || !db)
	throw new Error(
		'destructive checkpoint child requires auth10, schema, root name, and DATABASE_URL',
	);

const pool = new pg.Pool({ connectionString: db, max: 1 });

void (async () => {
	const databaseId = String(
		(
			await pool.query<{ database: string }>(
				'SELECT current_database() AS database',
			)
		).rows[0]?.database,
	);
	if (!databaseId)
		throw new Error('destructive checkpoint child has no database');
	const step = createPgsqlGeneratedManagedStep({
		change: {
			kind: 'drop_table',
			table: rootName,
			classification: 'removal',
			details: 'IPC-armed containment-window removal',
			statements: [`DROP TABLE ${quoteIdent(schema)}.${quoteIdent(rootName)}`],
			destructive: true,
		} as never,
		database: databaseId,
		schema,
		stepKey: 'generator:0',
		order: 0,
		statements: [`DROP TABLE ${quoteIdent(schema)}.${quoteIdent(rootName)}`],
	});
	const plan = {
		observations: [],
		claims: [],
		assumptions: [],
		preconditions: [],
		segments: [],
		steps: [step],
		postconditions: [],
		generator: {
			kind: 'schema-differ-generator',
			planningSchema: schema,
			changes: [],
			statements: [],
		},
	};
	const planDigest = transitionPlanDigest(plan as never);
	const runId = `obl-auth10:${rootName}`;
	const result = await executeGeneratorPlan({
		pool,
		plan,
		planDigest,
		schema,
		run: lockPgJournalRun(
			mintDurablyLoadedRun({
				runId,
				planDigest,
				targetContextDigest: `checkpoint:${schema}`,
				databaseId,
				coreVersion: 'checkpoint-e2e',
				startedAt: '2026-08-14T00:00:00.000Z',
				replayability: 'replayable',
			}),
		),
		runId,
		accepts: [`destructive-plan-accepted:${planDigest}`],
		observer: checkpoint,
	});
	if (
		result.outcome !== 'destructive-authority-refused' ||
		result.refusal?.withheldAuthority !== 'destructive containment authority'
	)
		throw new Error(
			`AUTH10 checkpoint child result: ${JSON.stringify(result)}`,
		);
})()
	.finally(async () => pool.end())
	.catch((error: unknown) => {
		process.stderr.write(
			`destructive checkpoint child failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
		);
		process.exitCode = 1;
	});
