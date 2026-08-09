/** `dbsp release` stops managing one address and deliberately emits no DDL. */
import {
	createPgTransitionLessor,
	escapeDiagnosticText,
	releasePgManagedAddress,
} from '@dbsp/adapter-pgsql';
import { acquireTransitionLease } from '@dbsp/core';
import type { LedgerAddress, LedgerRefusal } from '@dbsp/types';
import { Command } from 'commander';
import { createDbConnection } from '../utils/db-utils.js';
import { printCliJson } from '../utils/output.js';
import { inspectAddress } from './inspect.js';

export interface ReleaseOptions {
	readonly db: string;
	readonly schema?: string;
	readonly kind?: string;
	readonly parent?: string;
	readonly databaseLedger?: boolean;
	readonly format?: 'text' | 'json';
}

export type ReleaseCommandResult =
	| { readonly outcome: 'released' }
	| { readonly outcome: 'release-unavailable'; readonly detail: string }
	| {
			readonly outcome: 'release-refused';
			readonly detail: string;
			readonly address: LedgerAddress;
			readonly refusal: LedgerRefusal;
	  };

export async function runRelease(
	selector: string,
	options: ReleaseOptions,
): Promise<ReleaseCommandResult> {
	const { pool } = await createDbConnection(options.db);
	const schema = options.schema ?? 'public';
	try {
		const lease = await acquireTransitionLease(createPgTransitionLessor(pool));
		try {
			const databaseRow = await lease.session.query(
				'SELECT current_database() AS database',
			);
			const database = databaseRow.rows[0]?.database;
			if (typeof database !== 'string')
				throw new Error('PostgreSQL current_database() is unreadable');
			// Keep the leased session alive until the release preflight/transaction has
			// settled. A bare promise return would enter the finally blocks below
			// immediately, ending this pool while the adapter is still reading it.
			return (await releasePgManagedAddress({
				executor: lease.session,
				home: options.databaseLedger
					? { scope: 'database' }
					: { scope: 'schema', schema },
				address: inspectAddress(
					database,
					schema,
					selector,
					options.kind,
					options.parent,
					options.databaseLedger ? 'database' : 'schema',
				),
			})) as ReleaseCommandResult;
		} finally {
			await lease.release();
		}
	} finally {
		await pool.end();
	}
}

export function formatReleaseHuman(result: ReleaseCommandResult): string {
	if (result.outcome === 'released') return 'released';
	if (result.outcome === 'release-unavailable')
		return `release-unavailable: ${escapeDiagnosticText(result.detail)}`;
	return [
		`release-refused: ${escapeDiagnosticText(result.detail)}`,
		`address: ${escapeDiagnosticText(JSON.stringify(result.address))}`,
		`state: ${escapeDiagnosticText(result.refusal.state)}`,
		`withheld authority: ${escapeDiagnosticText(result.refusal.withheldAuthority)}`,
		`resolving command: ${escapeDiagnosticText(result.refusal.resolvingCommand)}`,
	].join('\n');
}

export const releaseCommand = new Command('release')
	.description(
		'End management for one address without touching the database object',
	)
	.argument('<address>', 'Address as name or kind:name')
	.requiredOption('-d, --db <url>', 'Database connection URL (required)')
	.option('--schema <name>', 'Schema ledger containing the address', 'public')
	.option('--kind <kind>', 'Kind for an unqualified address', 'table')
	.option('--parent <kind:name>', 'Parent for column, index, or constraint')
	.option(
		'--database-ledger',
		'Release from the database ledger (for extensions)',
	)
	.option('--format <format>', 'Output format: text or json', 'text')
	.action(async (address: string, options: ReleaseOptions) => {
		try {
			const result = await runRelease(address, options);
			if (options.format === 'json') printCliJson(result);
			else console.log(formatReleaseHuman(result));
			process.exitCode = result.outcome === 'released' ? 0 : 1;
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			if (options.format === 'json')
				printCliJson({ outcome: 'release-refused', detail });
			else console.error(`release-refused: ${escapeDiagnosticText(detail)}`);
			process.exitCode = 1;
		}
	});
