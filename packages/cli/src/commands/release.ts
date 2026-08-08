/** `dbsp release` stops managing one address and deliberately emits no DDL. */
import {
	createPgTransitionLessor,
	releasePgManagedAddress,
} from '@dbsp/adapter-pgsql';
import { acquireTransitionLease } from '@dbsp/core';
import { Command } from 'commander';
import { createDbConnection } from '../utils/db-utils.js';
import { printCliJson } from '../utils/output.js';
import { inspectAddress } from './inspect.js';

export interface ReleaseOptions {
	readonly db: string;
	readonly schema?: string;
	readonly format?: 'text' | 'json';
}

export async function runRelease(selector: string, options: ReleaseOptions) {
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
			return await releasePgManagedAddress({
				executor: lease.session,
				home: { scope: 'schema', schema },
				address: inspectAddress(database, schema, selector),
			});
		} finally {
			await lease.release();
		}
	} finally {
		await pool.end();
	}
}

export const releaseCommand = new Command('release')
	.description(
		'End management for one address without touching the database object',
	)
	.argument('<address>', 'Address as name or kind:name')
	.requiredOption('-d, --db <url>', 'Database connection URL (required)')
	.requiredOption('--schema <name>', 'Schema ledger containing the address')
	.option('--format <format>', 'Output format: text or json', 'text')
	.action(async (address: string, options: ReleaseOptions) => {
		try {
			const result = await runRelease(address, options);
			if (options.format === 'json') printCliJson(result);
			else
				console.log(
					result.outcome === 'released'
						? 'released'
						: `release-refused: ${result.detail}`,
				);
			process.exitCode = result.outcome === 'released' ? 0 : 1;
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			if (options.format === 'json')
				printCliJson({ outcome: 'release-refused', detail });
			else console.error(`release-refused: ${detail}`);
			process.exitCode = 1;
		}
	});
