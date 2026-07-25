/**
 * Transaction state of a checked-out `pg` client.
 *
 * `pg` records the status byte of every ReadyForQuery message on the client,
 * from 8.22 onwards. It is not part of `@types/pg`, so the shape is narrowed
 * here — in ONE place, so that every consumer of "is this session already in a
 * transaction?" reads the same field with the same interpretation.
 * `tests/e2e/borrowed-client-ownership.test.ts` locks the observed values
 * against a real PostgreSQL connection.
 *
 * The field is absent on older pg, which @dbsp/cli's peer range still admits,
 * so `undefined` is a routine answer on that path rather than an anomaly (#387).
 */

import type { PoolClient } from 'pg';

/**
 * Whether the client's session currently has an open transaction.
 *
 * Returns `undefined` when the status cannot be read — callers decide what
 * ignorance means for them, because it is not the same everywhere: reporting
 * an unknown state is fine, acting on one is not.
 */
export function poolClientTransactionOpen(
	client: PoolClient,
): boolean | undefined {
	const status = (client as { readonly _txStatus?: unknown })._txStatus;
	if (status === 'T' || status === 'E') return true;
	if (status === 'I') return false;
	return undefined;
}
