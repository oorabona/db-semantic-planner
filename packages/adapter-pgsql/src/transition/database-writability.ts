import type { TransitionJournalQueryable } from './journal.js';

/** The stable command outcome for a PostgreSQL target that cannot accept writes. */
export const DATABASE_READ_ONLY_OUTCOME = 'database-read-only' as const;

export class PgDatabaseReadOnlyError extends Error {
	readonly code = DATABASE_READ_ONLY_OUTCOME;

	constructor(detail: string) {
		super(`${DATABASE_READ_ONLY_OUTCOME}: ${detail}`);
		this.name = 'PgDatabaseReadOnlyError';
	}
}

export function isPgDatabaseReadOnlyError(
	error: unknown,
): error is PgDatabaseReadOnlyError {
	return (
		error !== null &&
		typeof error === 'object' &&
		'code' in error &&
		(error as { readonly code?: unknown }).code === DATABASE_READ_ONLY_OUTCOME
	);
}

export type PgDatabaseWritability =
	| { readonly kind: 'writable' }
	| {
			readonly kind: typeof DATABASE_READ_ONLY_OUTCOME;
			readonly detail: string;
	  }
	| { readonly kind: 'unavailable'; readonly detail: string };

function onOff(value: unknown): boolean | undefined {
	if (value === 'on') return true;
	if (value === 'off') return false;
	return undefined;
}

/**
 * One PostgreSQL writability classification for every managed mutation.  Both
 * a physical standby and a session made read-only by default reach the same
 * outcome; an unreadable response is deliberately not treated as writable.
 */
export async function classifyPgDatabaseWritability(
	executor: TransitionJournalQueryable,
): Promise<PgDatabaseWritability> {
	const row = (
		await executor.query(
			"SELECT pg_catalog.pg_is_in_recovery() AS in_recovery, current_setting('default_transaction_read_only') AS default_transaction_read_only, current_setting('transaction_read_only') AS transaction_read_only",
		)
	).rows[0];
	if (!row || typeof row.in_recovery !== 'boolean') {
		return {
			kind: 'unavailable',
			detail: 'PostgreSQL writability could not be read',
		};
	}
	const defaultReadOnly = onOff(row.default_transaction_read_only);
	const transactionReadOnly = onOff(row.transaction_read_only);
	if (defaultReadOnly === undefined || transactionReadOnly === undefined) {
		return {
			kind: 'unavailable',
			detail: 'PostgreSQL writability settings could not be read',
		};
	}
	if (row.in_recovery)
		return { kind: DATABASE_READ_ONLY_OUTCOME, detail: 'target is a standby' };
	if (defaultReadOnly || transactionReadOnly) {
		return {
			kind: DATABASE_READ_ONLY_OUTCOME,
			detail: 'target session is read-only',
		};
	}
	return { kind: 'writable' };
}

/** Fail closed without replacing a PostgreSQL query failure's own words. */
export async function assertPgDatabaseWritable(
	executor: TransitionJournalQueryable,
): Promise<void> {
	const classification = await classifyPgDatabaseWritability(executor);
	if (classification.kind === 'writable') return;
	if (classification.kind === DATABASE_READ_ONLY_OUTCOME)
		throw new PgDatabaseReadOnlyError(classification.detail);
	throw new Error(classification.detail);
}

/** Preserve PostgreSQL's own failure words while normalizing SQLSTATE 25006. */
export async function classifyPgWrite<T>(write: () => Promise<T>): Promise<T> {
	try {
		return await write();
	} catch (error) {
		if (
			error !== null &&
			typeof error === 'object' &&
			'code' in error &&
			(error as { readonly code?: unknown }).code === '25006'
		) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new PgDatabaseReadOnlyError(detail);
		}
		throw error;
	}
}
