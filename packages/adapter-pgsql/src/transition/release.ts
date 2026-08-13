/** End management without issuing DDL or accepting a caller-supplied controller. */
import { randomUUID } from 'node:crypto';
import { projectLedgerChain } from '@dbsp/core';
import type { LedgerAddress, LedgerHome, LedgerRefusal } from '@dbsp/types';
import * as transitionTypes from '@dbsp/types';
import { refusalFor } from '@dbsp/types';
import {
	readPgLedgerAddressChain,
	readPgLedgerControllerOid,
} from './chain-reader.js';
import type { TransitionJournalQueryable } from './journal.js';
import {
	acquirePgLedgerLocks,
	appendPgLedgerRelease,
	type PgLedgerTarget,
} from './ledger.js';
import {
	validatePgLedgerRuntimeIntegrity,
	withPgTransitionTransaction,
} from './outcome-protocol.js';
import { readPgLedgerScopeCurrency } from './reinitialize-preflight.js';

type ControllerIdentity = { readonly name: string; readonly oid: string };
type ControllerIdentityHelper = (
	recorded: ControllerIdentity,
	current: ControllerIdentity,
) => boolean;

const sameControllerIdentity =
	(
		transitionTypes as typeof transitionTypes & {
			readonly sameControllerIdentity?: ControllerIdentityHelper;
		}
	).sameControllerIdentity ??
	((recorded, current) =>
		recorded.name === current.name && recorded.oid === current.oid);

export type PgReleaseResult =
	| { readonly outcome: 'released' }
	| {
			/** Transport/query/read-only failure; never mislabel it malformed chain. */
			readonly outcome: 'release-unavailable';
			readonly detail: string;
			readonly address: LedgerAddress;
	  }
	| {
			readonly outcome: 'release-refused';
			readonly detail: string;
			readonly address: LedgerAddress;
			readonly refusal: LedgerRefusal;
	  };

function releaseRefusal(
	address: LedgerAddress,
	code: 'ERR-02' | 'ERR-05' | 'ERR-06' | 'ERR-08',
	state: LedgerRefusal['state'],
): Extract<PgReleaseResult, { readonly outcome: 'release-refused' }> {
	const refusal = refusalFor(code, { address, state });
	return {
		outcome: 'release-refused',
		detail: refusal.cause,
		address,
		refusal,
	};
}

function target(home: LedgerHome): PgLedgerTarget {
	if (home.scope === 'database') return { scope: 'database' };
	if (!home.schema) throw new Error('schema release requires a schema ledger');
	return { scope: 'schema', schema: home.schema };
}

/**
 * Refuse from the live subject before opening a release transaction.
 *
 * This is intentionally only an early refusal pass: success still repeats
 * every fact under the ledger lock below.  It means a pending, blocked,
 * foreign-controller, or stale-lineage address keeps its classified refusal
 * even when a subsequently unnecessary transaction cleanup loses transport.
 */
async function preflightReleaseRefusal(input: {
	readonly executor: TransitionJournalQueryable;
	readonly home: LedgerHome;
	readonly address: LedgerAddress;
}): Promise<PgReleaseResult | undefined> {
	const currency = await readPgLedgerScopeCurrency(input.executor, input.home);
	if (currency.kind !== 'current')
		return releaseRefusal(input.address, 'ERR-06', 'unknown');
	const chain = await readPgLedgerAddressChain(
		input.executor,
		input.home,
		input.address,
	);
	const projection = projectLedgerChain(chain);
	if (projection.kind !== 'projected-ledger-chain')
		return releaseRefusal(input.address, 'ERR-08', 'unknown');
	if (projection.openClaim !== undefined)
		return releaseRefusal(input.address, 'ERR-08', projection.stableState);
	if (projection.stableState !== 'managed' || !chain.terminalMember)
		return releaseRefusal(input.address, 'ERR-02', projection.stableState);
	const user = await input.executor.query(
		'SELECT current_user AS current_user, current_user::regrole::oid::text AS current_user_oid',
	);
	const currentUser = user.rows[0]?.current_user;
	const currentUserOid = user.rows[0]?.current_user_oid;
	if (typeof currentUser !== 'string' || typeof currentUserOid !== 'string')
		throw new Error('current_user role identity is unreadable');
	const controllerOid =
		(
			chain.terminalMember as typeof chain.terminalMember & {
				readonly controllerOid?: string;
			}
		).controllerOid ??
		(await readPgLedgerControllerOid(
			input.executor,
			input.home,
			input.address,
			chain.terminalMember.eventId,
		));
	if (
		!sameControllerIdentity(
			{ name: chain.terminalMember.controller, oid: controllerOid },
			{ name: currentUser, oid: currentUserOid },
		)
	)
		return releaseRefusal(input.address, 'ERR-05', projection.stableState);
	return undefined;
}

export async function releasePgManagedAddress(input: {
	readonly executor: TransitionJournalQueryable;
	readonly home: LedgerHome;
	readonly address: LedgerAddress;
}): Promise<PgReleaseResult> {
	try {
		const earlyRefusal = await preflightReleaseRefusal(input);
		if (earlyRefusal) return earlyRefusal;
		return await withPgTransitionTransaction(
			input.executor,
			async (executor) => {
				const lock = await acquirePgLedgerLocks(executor, [input.home]);
				if (lock.kind !== 'acquired') {
					return releaseRefusal(input.address, 'ERR-08', 'unknown');
				}
				const integrity = await validatePgLedgerRuntimeIntegrity(executor, [
					input.home,
				]);
				if (integrity)
					return releaseRefusal(input.address, 'ERR-06', 'unknown');
				const currency = await readPgLedgerScopeCurrency(executor, input.home);
				if (currency.kind !== 'current') {
					return releaseRefusal(input.address, 'ERR-06', 'unknown');
				}
				const chain = await readPgLedgerAddressChain(
					executor,
					input.home,
					input.address,
				);
				const projection = projectLedgerChain(chain);
				if (projection.kind !== 'projected-ledger-chain') {
					return releaseRefusal(input.address, 'ERR-08', 'unknown');
				}
				if (projection.openClaim !== undefined) {
					return releaseRefusal(
						input.address,
						'ERR-08',
						projection.stableState,
					);
				}
				if (projection.stableState !== 'managed' || !chain.terminalMember) {
					return releaseRefusal(
						input.address,
						'ERR-02',
						projection.stableState,
					);
				}
				const user = await executor.query(
					'SELECT current_user AS current_user, current_user::regrole::oid::text AS current_user_oid',
				);
				const currentUser = user.rows[0]?.current_user;
				const currentUserOid = user.rows[0]?.current_user_oid;
				if (
					typeof currentUser !== 'string' ||
					typeof currentUserOid !== 'string'
				)
					throw new Error('current_user role identity is unreadable');
				const controllerOid =
					(
						chain.terminalMember as typeof chain.terminalMember & {
							readonly controllerOid?: string;
						}
					).controllerOid ??
					(await readPgLedgerControllerOid(
						executor,
						input.home,
						input.address,
						chain.terminalMember.eventId,
					));
				if (
					!sameControllerIdentity(
						{ name: chain.terminalMember.controller, oid: controllerOid },
						{ name: currentUser, oid: currentUserOid },
					)
				) {
					return releaseRefusal(
						input.address,
						'ERR-05',
						projection.stableState,
					);
				}
				const eventId = `dbsp.release.${randomUUID()}`;
				await appendPgLedgerRelease(executor, target(input.home), {
					eventId,
					address: input.address,
					eventKind: 'released',
					predecessor: chain.terminalMember.eventId,
				});
				return { outcome: 'released' };
			},
		);
	} catch (error) {
		return {
			outcome: 'release-unavailable',
			address: input.address,
			detail: error instanceof Error ? error.message : String(error),
		};
	}
}
