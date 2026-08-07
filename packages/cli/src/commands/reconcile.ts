/**
 * Reconcile is intentionally a separate writer from inspect.  This initial
 * command foundation loads the durable run and reports the candidate addresses
 * it can safely classify; outcome appends remain delegated to the unit-8
 * adapter primitive, never to a hand-written CLI insert.
 */
import {
	readTransitionJournal,
	withPgTransitionRunLock,
} from '@dbsp/adapter-pgsql';
import { acquireExclusiveTransitionLease } from '@dbsp/core';
import { Command } from 'commander';
import { createDbConnection } from '../utils/db-utils.js';

export interface ReconcileOptions {
	readonly db: string;
	readonly format?: 'text' | 'json';
}

export interface ReconcileResult {
	readonly outcome:
		| 'reconcile-claim-selection-unavailable'
		| 'reconcile-run-unavailable';
	readonly runId: string;
	readonly addresses: readonly unknown[];
	readonly detail?: string;
}

/**
 * The run journal is the authority for selecting reconciliation work. It is
 * read with ensure:false, so a diagnostic invocation cannot create legacy
 * journal storage. Claim-to-run linkage is supplied by the managed applier;
 * until a run has emitted claims there is deliberately nothing to append.
 */
export async function runReconcile(
	runId: string,
	options: ReconcileOptions,
): Promise<ReconcileResult> {
	const { pool } = await createDbConnection(options.db);
	try {
		const locked = await withPgTransitionRunLock(
			pool,
			runId,
			async (target) => {
				const lease = await acquireExclusiveTransitionLease(target);
				try {
					return await readTransitionJournal(lease.session, runId, {
						ensure: false,
					});
				} finally {
					await lease.release();
				}
			},
		);
		if (locked.kind === 'busy')
			return { outcome: 'reconcile-run-unavailable', runId, addresses: [] };
		const declarations = locked.value.plan.declarations?.declarations ?? [];
		return {
			outcome: 'reconcile-claim-selection-unavailable',
			runId,
			addresses: declarations.map((declaration) => declaration.address),
			detail:
				'run journal has no claim-to-run linkage; refusing to resolve a claim that may belong to another run',
		};
	} catch {
		return { outcome: 'reconcile-run-unavailable', runId, addresses: [] };
	} finally {
		await pool.end();
	}
}

export const reconcileCommand = new Command('reconcile')
	.description('Resolve this run’s open managed claims from live evidence only')
	.argument('<run-id>', 'Durable run identifier')
	.requiredOption('-d, --db <url>', 'Database connection URL (required)')
	.option('--format <format>', 'Output format: text or json', 'text')
	.action(async (runId: string, options: ReconcileOptions) => {
		const result = await runReconcile(runId, options);
		if (options.format === 'json') console.log(JSON.stringify(result, null, 2));
		else console.log(`${result.outcome}: ${runId}`);
		process.exitCode = 1;
	});
