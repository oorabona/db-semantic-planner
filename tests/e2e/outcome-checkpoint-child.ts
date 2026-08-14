import { executePgAdmittedOperation } from '@dbsp/adapter-pgsql';
import { lockPgJournalRun } from '@dbsp/adapter-pgsql/internal';
import { validateNormalizedManagedStepManifest } from '@dbsp/core';
import { mintDurablyLoadedRun } from '@dbsp/core/internal';
import type { LedgerReservationRow, OutcomeClaimPlan } from '@dbsp/types';
import pg from 'pg';
import { checkpoint } from './harness/index.js';

const [mode, schema, expectation] = process.argv.slice(2);
const db = process.env.DATABASE_URL;

function quoteIdent(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

if (
	(mode !== 'transactional' && mode !== 'non-transactional') ||
	!schema ||
	!db
)
	throw new Error(
		'outcome checkpoint child requires transactional|non-transactional, schema, and DATABASE_URL',
	);

const address = {
	scope: 'schema' as const,
	engine: 'postgresql' as const,
	database: 'dbsp-e2e',
	schema,
	kind: 'table',
	name: `checkpoint_${mode.replaceAll('-', '_')}`,
};
const claimId = `checkpoint:${mode}`;
const plannedClaimKey = `step:${claimId}`;
const executionId = `execution:${mode}`;
const plan: OutcomeClaimPlan = {
	claimId,
	claimSpecies: 'sql-bearing',
	plannedClaimKey,
	executionId,
	claimGroupId: claimId,
	rootClaimId: claimId,
	address,
	claimKind: 'intent',
	statementBundle: {
		statements: [
			{
				ordinal: 0,
				sql: `CREATE TABLE ${quoteIdent(schema)}.${quoteIdent(address.name)} (id integer PRIMARY KEY)`,
			},
		],
	},
};
const reservations: readonly LedgerReservationRow[] = [
	{
		address,
		claimKind: 'intent',
		executionId,
		rootClaimId: claimId,
		homeLedger: { scope: 'schema', schema },
	},
];

const manifest = validateNormalizedManagedStepManifest([
	{
		stepKey: plannedClaimKey,
		order: 0,
		segmentId: claimId,
		dependencyOrder: [],
		address: plan.address as never,
		claimKind: plan.claimKind,
		plannedClaimKeys: [plannedClaimKey],
		statementBundle: plan.statementBundle,
		classification: 'non-destructive',
		requiresVacancy: false,
		replayPolicy: 'recorded',
	},
]);
if (!manifest.ok) throw new Error(manifest.detail);

const run = lockPgJournalRun(
	mintDurablyLoadedRun({
		runId: executionId,
		planDigest: claimId,
		targetContextDigest: 'checkpoint-e2e',
		databaseId: address.database,
		coreVersion: 'checkpoint-e2e',
		startedAt: '2026-08-14T00:00:00.000Z',
		replayability: 'replayable',
	}),
);

const pool = new pg.Pool({ connectionString: db, max: 1 });
void executePgAdmittedOperation(pool, {
	run,
	approval: { approvals: [] },
	manifest: manifest.manifest,
	recomputedPlanDigest: claimId,
	operation: {
		kind: 'single-outcome',
		request: {
			plan,
			reservations,
			resolution: { eventId: `${claimId}:observed`, eventKind: 'observed' },
			vacancy: async () => ({ kind: 'vacant' as const }),
			observer: checkpoint,
			...(mode === 'non-transactional'
				? { executingEventId: `${claimId}:executing` }
				: {}),
		},
	},
})
	.then(async (result) => {
		if (expectation === 'integrity-refusal') {
			if (result.kind !== 'outcome-protocol-refused')
				throw new Error(`checkpoint child result: ${result.kind}`);
			return;
		}
		if (result.kind !== 'executed-outcome-claim')
			throw new Error(`checkpoint child result: ${result.kind}`);
	})
	.finally(async () => pool.end())
	.catch((error: unknown) => {
		process.stderr.write(
			`outcome checkpoint child failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
		);
		process.exitCode = 1;
	});
