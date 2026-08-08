/** End management without issuing DDL or accepting a caller-supplied controller. */
import { randomUUID } from 'node:crypto';
import { projectLedgerChain } from '@dbsp/core';
import type { LedgerAddress, LedgerHome } from '@dbsp/types';
import { readPgLedgerAddressChain } from './chain-reader.js';
import type { TransitionJournalQueryable } from './journal.js';
import {
	acquirePgLedgerLocks,
	appendPgLedgerRelease,
	type PgLedgerTarget,
} from './ledger.js';
import { readPgLedgerScopeCurrency } from './reinitialize-preflight.js';

export type PgReleaseResult =
	| { readonly outcome: 'released' }
	| { readonly outcome: 'release-refused'; readonly detail: string };

function target(home: LedgerHome): PgLedgerTarget {
	if (home.scope === 'database') return { scope: 'database' };
	if (!home.schema) throw new Error('schema release requires a schema ledger');
	return { scope: 'schema', schema: home.schema };
}

async function rollback(executor: TransitionJournalQueryable): Promise<void> {
	try {
		await executor.query('ROLLBACK');
	} catch {
		// Preserve the database's original refusal words.
	}
}

/**
 * Refuse from the live subject before opening a release transaction.
 *
 * This is intentionally only an early refusal pass: success still repeats
 * every fact under the ledger lock below.  It means a pending, blocked,
 * foreign-controller, or stale-lineage address keeps its own words even when
 * a subsequently unnecessary transaction cleanup loses its transport.
 */
async function preflightReleaseRefusal(input: {
	readonly executor: TransitionJournalQueryable;
	readonly home: LedgerHome;
	readonly address: LedgerAddress;
}): Promise<PgReleaseResult | undefined> {
	const currency = await readPgLedgerScopeCurrency(input.executor, input.home);
	if (currency.kind !== 'current')
		return {
			outcome: 'release-refused',
			detail: `release refuses lineage ${currency.kind}`,
		};
	const chain = await readPgLedgerAddressChain(
		input.executor,
		input.home,
		input.address,
	);
	const projection = projectLedgerChain(chain);
	if (projection.kind !== 'projected-ledger-chain')
		return {
			outcome: 'release-refused',
			detail: `release refuses malformed ledger chain: ${projection.reason.code}`,
		};
	if (projection.openClaim !== undefined)
		return {
			outcome: 'release-refused',
			detail: `release refuses ${projection.openClaim.phase === 'indeterminate' ? 'blocked' : 'pending'} address ${input.address.name}`,
		};
	if (projection.stableState !== 'managed' || !chain.terminalMember)
		return {
			outcome: 'release-refused',
			detail: `release requires managed address ${input.address.name}`,
		};
	const user = await input.executor.query(
		'SELECT current_user AS current_user',
	);
	const currentUser = user.rows[0]?.current_user;
	if (typeof currentUser !== 'string')
		throw new Error('current_user is unreadable');
	if (chain.terminalMember.controller !== currentUser)
		return {
			outcome: 'release-refused',
			detail: `release refuses controller ${currentUser} for address owned by ${chain.terminalMember.controller}`,
		};
	return undefined;
}

export async function releasePgManagedAddress(input: {
	readonly executor: TransitionJournalQueryable;
	readonly home: LedgerHome;
	readonly address: LedgerAddress;
}): Promise<PgReleaseResult> {
	let begun = false;
	try {
		const earlyRefusal = await preflightReleaseRefusal(input);
		if (earlyRefusal) return earlyRefusal;
		await input.executor.query('BEGIN');
		begun = true;
		const lock = await acquirePgLedgerLocks(input.executor, [input.home]);
		if (lock.kind !== 'acquired') {
			await rollback(input.executor);
			begun = false;
			return {
				outcome: 'release-refused',
				detail:
					lock.kind === 'busy'
						? 'release refuses a busy ledger'
						: lock.error instanceof Error
							? lock.error.message
							: String(lock.error),
			};
		}
		const currency = await readPgLedgerScopeCurrency(
			input.executor,
			input.home,
		);
		if (currency.kind !== 'current') {
			await rollback(input.executor);
			begun = false;
			return {
				outcome: 'release-refused',
				detail: `release refuses lineage ${currency.kind}`,
			};
		}
		const chain = await readPgLedgerAddressChain(
			input.executor,
			input.home,
			input.address,
		);
		const projection = projectLedgerChain(chain);
		if (projection.kind !== 'projected-ledger-chain') {
			await rollback(input.executor);
			begun = false;
			return {
				outcome: 'release-refused',
				detail: `release refuses malformed ledger chain: ${projection.reason.code}`,
			};
		}
		if (projection.openClaim !== undefined) {
			await rollback(input.executor);
			begun = false;
			return {
				outcome: 'release-refused',
				detail: `release refuses ${projection.openClaim.phase === 'indeterminate' ? 'blocked' : 'pending'} address ${input.address.name}`,
			};
		}
		if (projection.stableState !== 'managed' || !chain.terminalMember) {
			await rollback(input.executor);
			begun = false;
			return {
				outcome: 'release-refused',
				detail: `release requires managed address ${input.address.name}`,
			};
		}
		const user = await input.executor.query(
			'SELECT current_user AS current_user',
		);
		const currentUser = user.rows[0]?.current_user;
		if (typeof currentUser !== 'string')
			throw new Error('current_user is unreadable');
		if (chain.terminalMember.controller !== currentUser) {
			await rollback(input.executor);
			begun = false;
			return {
				outcome: 'release-refused',
				detail: `release refuses controller ${currentUser} for address owned by ${chain.terminalMember.controller}`,
			};
		}
		const eventId = `dbsp.release.${randomUUID()}`;
		await appendPgLedgerRelease(input.executor, target(input.home), {
			eventId,
			address: input.address,
			eventKind: 'released',
			predecessor: chain.terminalMember.eventId,
		});
		await input.executor.query('COMMIT');
		begun = false;
		return { outcome: 'released' };
	} catch (error) {
		if (begun) await rollback(input.executor);
		return {
			outcome: 'release-refused',
			detail: error instanceof Error ? error.message : String(error),
		};
	}
}
