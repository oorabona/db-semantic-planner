/**
 * Row-level locking intent for SELECT queries (E15).
 *
 * Maps to PostgreSQL's FOR UPDATE/SHARE/NO KEY UPDATE/KEY SHARE
 * with SKIP LOCKED / NOWAIT wait policies.
 */

/** Row-level lock strength for SELECT queries. */
export type LockStrength =
	| 'forUpdate'
	| 'forNoKeyUpdate'
	| 'forShare'
	| 'forKeyShare';

/**
 * Wait policy when a lock conflict is encountered.
 *
 * - `block`: Wait indefinitely (default PostgreSQL behavior)
 * - `skipLocked`: Skip already-locked rows (job queue pattern)
 * - `noWait`: Error immediately if any row is locked
 */
export type LockWaitPolicy = 'block' | 'skipLocked' | 'noWait';

/** Declarative lock intent for SELECT queries. */
export interface LockIntent {
	readonly strength: LockStrength;
	readonly waitPolicy: LockWaitPolicy;
}
