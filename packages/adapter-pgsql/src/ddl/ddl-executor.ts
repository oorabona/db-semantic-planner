/** PostgreSQL-specific execution of a compiled, two-phase DDL plan. */

import type { Pool, PoolClient } from 'pg';
import { poolClientTransactionOpen } from '../pg-client-state.js';

export interface DdlExecutionPlan {
	readonly autocommit: readonly string[];
	readonly main: readonly string[];
}

export interface DdlExecutionResult {
	readonly statementsExecuted: number;
	readonly dryRun: boolean;
}

export interface ExecuteDdlPlanOptions {
	readonly dryRun?: boolean;
	/** Runs after main statements, before COMMIT, on the same client. */
	readonly onMain?: (client: PoolClient) => Promise<void>;
}

export type DdlExecutionPhase =
	| 'acquisition'
	| 'precondition'
	| 'autocommit'
	| 'main';
export type DdlExecutionOutcome = 'not_started' | 'rolled_back' | 'unknown';

/**
 * The diagnostic wrapper for DDL execution. The database error is retained
 * untouched as primaryError; callers must never annotate caught errors.
 */
export class DdlExecutionError extends Error {
	constructor(
		readonly phase: DdlExecutionPhase,
		readonly autocommitCompleted: number,
		readonly primaryError: unknown,
		readonly rollbackError: unknown | undefined,
		readonly transactionStateUnproven: boolean,
		/** True only when the COMMIT request itself failed. */
		readonly commitAttempted = false,
		/** A failed COMMIT (or failed rollback) cannot prove database state. */
		readonly outcome: DdlExecutionOutcome = transactionStateUnproven
			? 'unknown'
			: 'rolled_back',
	) {
		super(
			`DDL ${phase} phase failed after ${describeAutocommitOperations(
				autocommitCompleted,
			)}: ${
				primaryError instanceof Error
					? primaryError.message
					: String(primaryError)
			}`,
			{ cause: primaryError },
		);
		this.name = 'DdlExecutionError';
	}
}

/** `1 autocommit operation` / `2 autocommit operations`. */
function describeAutocommitOperations(count: number): string {
	return `${count} autocommit operation${count === 1 ? '' : 's'}`;
}

/**
 * Operator-facing phrase for durable pre-transaction work. A successful
 * `ADD VALUE IF NOT EXISTS` can be a retry no-op, so this deliberately reports
 * completed operations rather than claiming that labels were added.
 */
export function describeCompletedAutocommitOperations(count: number): string {
	return count === 1
		? '1 autocommit operation completed'
		: `${count} autocommit operations completed`;
}

/** Execute enum additions one query at a time, then main work in one transaction. */
export async function executeDdlPlan(
	pool: Pool,
	plan: DdlExecutionPlan,
	options?: ExecuteDdlPlanOptions,
): Promise<DdlExecutionResult> {
	const statementsExecuted = plan.autocommit.length + plan.main.length;
	if (statementsExecuted === 0 && !options?.onMain) {
		return { statementsExecuted: 0, dryRun: options?.dryRun ?? false };
	}
	if (options?.dryRun) {
		return { statementsExecuted, dryRun: true };
	}

	let client: PoolClient | undefined;
	let releaseError: Error | undefined;
	try {
		try {
			client = await pool.connect();
		} catch (error) {
			throw new DdlExecutionError(
				'acquisition',
				0,
				error,
				undefined,
				false,
				false,
				'not_started',
			);
		}
		return await executeDdlPlanWithClient(client, plan, options);
	} catch (error) {
		const executionError = asDdlExecutionError(error, 0);
		if (
			executionError.transactionStateUnproven ||
			executionError.phase === 'precondition'
		) {
			releaseError = executionError;
		}
		throw executionError;
	} finally {
		client?.release(releaseError);
	}
}

/**
 * Execute a DDL plan on a caller-owned, already-acquired client.
 *
 * The caller retains ownership of the client and is responsible for releasing
 * it. This function must never acquire or release a connection. The client
 * must be idle (not inside a transaction): autocommit statements must be
 * durable independently and this executor owns BEGIN/COMMIT/ROLLBACK.
 */
export async function executeDdlPlanWithClient(
	client: PoolClient,
	plan: DdlExecutionPlan,
	options?: ExecuteDdlPlanOptions,
): Promise<DdlExecutionResult> {
	const statementsExecuted = plan.autocommit.length + plan.main.length;
	if (statementsExecuted === 0 && !options?.onMain) {
		return { statementsExecuted: 0, dryRun: options?.dryRun ?? false };
	}
	if (options?.dryRun) {
		return { statementsExecuted, dryRun: true };
	}
	try {
		await assertIdleClient(client);
	} catch (error) {
		throw new DdlExecutionError(
			'precondition',
			0,
			error,
			undefined,
			false,
			false,
			'not_started',
		);
	}

	let autocommitCompleted = 0;
	try {
		for (const statement of plan.autocommit) {
			try {
				await client.query(statement);
				autocommitCompleted++;
			} catch (primaryError) {
				// Every autocommit statement is its own transaction, so a lost
				// response can hide a durable commit: the outcome is unknown.
				// A server rejection did not commit and could in principle be
				// reported as such, but telling the two apart means trusting the
				// shape of a driver error (`EPIPE` is a five-character code just
				// like a SQLSTATE), so the bound is deliberately unknown for all
				// of them — the safe direction. `ADD VALUE IF NOT EXISTS` makes
				// the retry a no-op either way.
				throw new DdlExecutionError(
					'autocommit',
					autocommitCompleted,
					primaryError,
					undefined,
					true,
				);
			}
		}
		if (plan.main.length > 0 || options?.onMain) {
			await executeMainTransaction(
				client,
				plan.main,
				options?.onMain,
				autocommitCompleted,
			);
		}
		return { statementsExecuted, dryRun: false };
	} catch (error) {
		throw asDdlExecutionError(error, autocommitCompleted);
	}
}

async function executeMainTransaction(
	client: PoolClient,
	statements: readonly string[],
	onMain: ExecuteDdlPlanOptions['onMain'],
	autocommitCompleted: number,
): Promise<void> {
	try {
		await client.query('BEGIN');
		for (const statement of statements) await client.query(statement);
		if (onMain) await onMain(client);
	} catch (primaryError) {
		try {
			await client.query('ROLLBACK');
		} catch (rollbackError) {
			throw new DdlExecutionError(
				'main',
				autocommitCompleted,
				primaryError,
				rollbackError,
				true,
			);
		}
		throw new DdlExecutionError(
			'main',
			autocommitCompleted,
			primaryError,
			undefined,
			false,
		);
	}

	try {
		await client.query('COMMIT');
	} catch (primaryError) {
		// A server can commit before its reply is lost. Do not issue ROLLBACK:
		// doing so cannot prove the outcome and hides the ambiguity from callers.
		throw new DdlExecutionError(
			'main',
			autocommitCompleted,
			primaryError,
			undefined,
			true,
			true,
		);
	}
}

async function assertIdleClient(client: PoolClient): Promise<void> {
	// Newer pg clients report transaction status directly. Older clients are
	// probed with SAVEPOINT: only SQLSTATE 25P01 proves the session is idle, so
	// an ambiguous probe result is rejected rather than risking caller-owned work.
	const transactionOpen = poolClientTransactionOpen(client);
	if (transactionOpen === false) return;
	if (transactionOpen === true) {
		throw new Error(
			'executeDdlPlanWithClient requires an idle PostgreSQL client, but the session already has an open transaction.',
		);
	}

	try {
		await client.query('SAVEPOINT "dbsp_idle_probe"');
	} catch (error) {
		if ((error as { readonly code?: unknown }).code === '25P01') return;
		throw new Error(
			'executeDdlPlanWithClient requires an idle PostgreSQL client, but the session transaction state could not be established.',
			{ cause: error },
		);
	}

	throw new Error(
		'executeDdlPlanWithClient requires an idle PostgreSQL client, but the session already has an open transaction.',
	);
}

function asDdlExecutionError(
	error: unknown,
	autocommitCompleted: number,
): DdlExecutionError {
	return error instanceof DdlExecutionError
		? error
		: new DdlExecutionError(
				'main',
				autocommitCompleted,
				error,
				undefined,
				false,
			);
}
