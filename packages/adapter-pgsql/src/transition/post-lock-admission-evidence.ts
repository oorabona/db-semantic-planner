import type { TransitionJournalQueryable } from './journal.js';
import {
	assertPgLedgerPhysicalShapeVerified,
	classifyPgLedgerPhysicalShape,
	isPgOrderedLedgerLocks,
	type PgLedgerPhysicalShapeOutcome,
	type PgLedgerShapeAllowance,
	type PgLedgerTarget,
	type PgOrderedLedgerLocks,
} from './ledger.js';
import { readPgLedgerScopeCurrency } from './reinitialize-preflight.js';

declare const postLockAdmissionEvidenceBrand: unique symbol;

/**
 * Evidence that this session held the ordered ledger locks while it observed
 * both the reference shape and marker/lineage currency.
 */
export interface PostLockAdmissionEvidence {
	readonly homes: readonly PgLedgerTarget[];
	readonly backendId: string;
	readonly transactionId: string | undefined;
	readonly [postLockAdmissionEvidenceBrand]: 'dbsp-post-lock-admission-evidence';
}

const postLockAdmissionEvidence = new WeakSet<object>();

export class PostLockAdmissionEvidenceError extends Error {
	constructor(detail: string) {
		super(`post-lock admission evidence refused: ${detail}`);
		this.name = 'PostLockAdmissionEvidenceError';
	}
}

type PostLockAdmissionEvidenceSeams = {
	readonly classifyShape: (
		executor: TransitionJournalQueryable,
		home: PgLedgerTarget,
		allowance?: PgLedgerShapeAllowance,
	) => Promise<PgLedgerPhysicalShapeOutcome>;
	readonly readCurrency: typeof readPgLedgerScopeCurrency;
	readonly readSessionIdentity: (
		executor: TransitionJournalQueryable,
	) => Promise<{
		readonly backendId: string;
		readonly transactionId: string | undefined;
	}>;
};

const productionSeams: PostLockAdmissionEvidenceSeams = {
	classifyShape: classifyPgLedgerPhysicalShape,
	readCurrency: readPgLedgerScopeCurrency,
	async readSessionIdentity(executor) {
		const result = await executor.query(
			'SELECT pg_catalog.pg_backend_pid()::text AS backend_id, pg_catalog.txid_current_if_assigned()::text AS transaction_id',
		);
		const row = result.rows[0];
		if (!row || typeof row.backend_id !== 'string')
			throw new PostLockAdmissionEvidenceError(
				'backend identity could not be read from the locked session',
			);
		if (row.transaction_id != null && typeof row.transaction_id !== 'string')
			throw new PostLockAdmissionEvidenceError(
				'transaction identity could not be read from the locked session',
			);
		return {
			backendId: row.backend_id,
			...(typeof row.transaction_id === 'string'
				? { transactionId: row.transaction_id }
				: { transactionId: undefined }),
		};
	},
};

function currencyDetail(
	currency: Awaited<ReturnType<typeof readPgLedgerScopeCurrency>>,
): string {
	return currency.kind === 'not-current' && currency.reason === 'lineage'
		? 'ledger lineage is not current'
		: `ledger marker is ${currency.marker.kind}`;
}

/**
 * The only constructor. It deliberately requires the opaque lock proof rather
 * than a list of homes, so callers cannot claim a post-lock observation from
 * plain JavaScript with a structural lookalike.
 */
export async function createPostLockAdmissionEvidence(
	executor: TransitionJournalQueryable,
	locks: PgOrderedLedgerLocks,
	seams: PostLockAdmissionEvidenceSeams = productionSeams,
	allowance?: PgLedgerShapeAllowance,
): Promise<PostLockAdmissionEvidence> {
	if (!isPgOrderedLedgerLocks(locks))
		throw new PostLockAdmissionEvidenceError(
			'ordered ledger locks were not acquired by this adapter',
		);
	for (const home of locks.homes) {
		const shape = await seams.classifyShape(executor, home, allowance);
		assertPgLedgerPhysicalShapeVerified(shape);
		const currency = await seams.readCurrency(executor, home);
		if (currency.kind !== 'current')
			throw new PostLockAdmissionEvidenceError(currencyDetail(currency));
	}
	const identity = await seams.readSessionIdentity(executor);
	const evidence = Object.freeze({
		homes: Object.freeze(locks.homes.map((home) => Object.freeze({ ...home }))),
		backendId: identity.backendId,
		transactionId: identity.transactionId,
	}) as PostLockAdmissionEvidence;
	postLockAdmissionEvidence.add(evidence);
	return evidence;
}

export function isPostLockAdmissionEvidence(
	value: unknown,
): value is PostLockAdmissionEvidence {
	return (
		value != null &&
		(typeof value === 'object' || typeof value === 'function') &&
		postLockAdmissionEvidence.has(value as object)
	);
}
