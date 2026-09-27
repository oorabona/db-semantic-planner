/** Render adapter-owned transition reconciliation for the command line. */
import {
	escapeDiagnosticText,
	type PgReconcileRecoveryReport,
	type PgReconcileSelectedIssue,
	PgReconcileTransitionRunError,
	reconcilePgTransitionRun,
} from '@dbsp/adapter-pgsql';
import type { ResourceAddress } from '@dbsp/types';
import { Command } from 'commander';
import { createDbConnection } from '../utils/db-utils.js';
import { printCliJson } from '../utils/output.js';
import {
	formatPreAppendRefusalHuman,
	type PreAppendRefusal,
	preAppendRefusalFor,
} from './refusal-output.js';

export interface ReconcileOptions {
	readonly db: string;
	readonly format?: 'text' | 'json';
}

export interface ReconcileResult {
	readonly outcome:
		| 'database-read-only'
		| 'reconcile-claim-selection-unavailable'
		| 'reconcile-run-unavailable'
		| 'reconcile-unresolved'
		| 'reconcile-completed';
	readonly runId: string;
	readonly addresses: readonly ResourceAddress[];
	readonly detail?: string;
	readonly failureCause?: ReconcileFailureCause;
	readonly recovery?: readonly ReconcileRecoveryReport[];
	readonly refusal?: PreAppendRefusal;
}

export type ReconcileFailureCause =
	| 'authentication'
	| 'transport'
	| 'malformed-journal'
	| 'catalogue';

function pgSqlState(error: unknown): string | undefined {
	if (typeof error !== 'object' || error === null || !('code' in error))
		return undefined;
	const code = error.code;
	return typeof code === 'string' ? code : undefined;
}

function isTransportError(error: unknown): boolean {
	if (typeof error !== 'object' || error === null || !('code' in error))
		return false;
	const code = error.code;
	return (
		typeof code === 'string' &&
		[
			'ECONNREFUSED',
			'ECONNRESET',
			'EHOSTUNREACH',
			'ENETUNREACH',
			'ETIMEDOUT',
		].includes(code)
	);
}

/** Classify PostgreSQL failures by SQLSTATE; no server message is parsed. */
export function classifyReconcileFailure(
	error: unknown,
	stage: 'journal' | 'catalogue' | 'reconcile',
): ReconcileFailureCause {
	const state = pgSqlState(error);
	if (state === '28000' || state === '28P01') return 'authentication';
	if (state?.startsWith('08') || isTransportError(error)) return 'transport';
	if (stage === 'journal') return 'malformed-journal';
	return 'catalogue';
}

export interface ReconcileRecoveryReport extends PgReconcileRecoveryReport {
	readonly refusal?: PreAppendRefusal;
}

function isUnresolvedRecoveryOutcome(report: ReconcileRecoveryReport): boolean {
	return [
		'pending',
		'blocked',
		'malformed-chain',
		'protocol-refused',
		'transport-ambiguous',
		'no-open-claim',
		'indeterminate-appended',
		'indeterminate-pair',
	].includes(report.outcome);
}

function ledgerCurrencyDetail(
	issue: Extract<
		PgReconcileSelectedIssue,
		{ readonly kind: 'ledger-not-current' }
	>,
): string {
	return issue.currency.kind === 'not-current' &&
		issue.currency.reason === 'lineage'
		? 'ledger lineage mismatch; run dbsp preflight --reinitialize'
		: `ledger marker ${issue.currency.marker.kind}; run dbsp preflight --reinitialize`;
}

function refusalForSelectedIssue(
	issue: PgReconcileSelectedIssue | undefined,
): PreAppendRefusal | undefined {
	if (issue === undefined) return undefined;
	if (issue.kind === 'ledger-not-current') {
		const address = issue.affectedAddresses[0];
		return address === undefined
			? undefined
			: preAppendRefusalFor('ERR-03', { address, state: 'unknown' });
	}
	if (issue.kind === 'database-read-only') {
		const address = issue.affectedAddresses[0];
		return address === undefined
			? undefined
			: preAppendRefusalFor('ERR-07', { address, state: 'unknown' });
	}
	return preAppendRefusalFor(
		issue.kind === 'catalogue-unavailable' ? 'ERR-09' : 'ERR-08',
		{ address: issue.address, state: 'unknown' },
	);
}

function mapRecovery(
	reports: readonly PgReconcileRecoveryReport[] | undefined,
	issue: PgReconcileSelectedIssue | undefined,
): readonly ReconcileRecoveryReport[] | undefined {
	if (reports === undefined) return undefined;
	const markerDetail =
		issue?.kind === 'ledger-not-current'
			? ledgerCurrencyDetail(issue)
			: undefined;
	return reports.map((report) => ({
		...report,
		...(markerDetail === undefined ? {} : { reason: markerDetail }),
		...(issue?.kind === 'ledger-not-current'
			? {
					refusal: preAppendRefusalFor('ERR-03', {
						address: report.address,
						state: 'unknown',
					}),
				}
			: report.failureCause === 'catalogue'
				? {
						refusal: preAppendRefusalFor('ERR-09', {
							address: report.address,
							state: 'unknown',
						}),
					}
				: report.failureCause === 'malformed-journal'
					? {
							refusal: preAppendRefusalFor('ERR-08', {
								address: report.address,
								state: 'unknown',
							}),
						}
					: {}),
	}));
}

export function unresolvedRecoveryDetail(
	reports: readonly ReconcileRecoveryReport[],
): string | undefined {
	const unresolved = reports.filter(isUnresolvedRecoveryOutcome);
	if (unresolved.length === 0) return undefined;
	return unresolved
		.map(
			(report) =>
				`${escapeDiagnosticText(report.address.name)}: ${escapeDiagnosticText(report.reason ?? report.outcome)}`,
		)
		.join('; ');
}

export function formatReconcileHuman(result: ReconcileResult): string {
	const line = `${escapeDiagnosticText(result.outcome)}: ${escapeDiagnosticText(result.runId)}`;
	const base = result.refusal
		? formatPreAppendRefusalHuman(line, result.refusal)
		: line;
	if (result.outcome === 'reconcile-completed' || !result.recovery) return base;
	const unresolved = result.recovery.filter(isUnresolvedRecoveryOutcome);
	return unresolved.length === 0
		? base
		: [
				base,
				...unresolved.map(
					(report) =>
						`${escapeDiagnosticText(report.address.name)}: ${escapeDiagnosticText(report.outcome)}${report.reason ? `: ${escapeDiagnosticText(report.reason)}` : ''}`,
				),
			].join('\n');
}

function mapAdapterResult(
	result: Awaited<ReturnType<typeof reconcilePgTransitionRun>>,
): ReconcileResult {
	if (result.kind === 'busy')
		return {
			outcome: 'reconcile-run-unavailable',
			runId: result.runId,
			addresses: [],
		};
	if (result.kind === 'selection-unavailable')
		return {
			outcome: 'reconcile-claim-selection-unavailable',
			runId: result.runId,
			addresses: result.addresses,
			...(result.detail === undefined ? {} : { detail: result.detail }),
		};
	if (result.kind === 'database-read-only') {
		const refusal = refusalForSelectedIssue(result.selectedIssue);
		return {
			outcome: 'database-read-only',
			runId: result.runId,
			addresses: result.addresses,
			detail: result.selectedIssue.reason,
			...(refusal === undefined ? {} : { refusal }),
		};
	}
	const recovery = mapRecovery(result.recovery, result.selectedIssue);
	const detail =
		result.selectedIssue?.kind === 'ledger-not-current'
			? ledgerCurrencyDetail(result.selectedIssue)
			: recovery === undefined
				? undefined
				: unresolvedRecoveryDetail(recovery);
	if (result.kind === 'unresolved') {
		const refusal = refusalForSelectedIssue(result.selectedIssue);
		return {
			outcome: 'reconcile-unresolved',
			runId: result.runId,
			addresses: result.addresses,
			...(detail === undefined ? {} : { detail }),
			...(recovery === undefined ? {} : { recovery }),
			...(refusal === undefined ? {} : { refusal }),
		};
	}
	return {
		outcome: 'reconcile-completed',
		runId: result.runId,
		addresses: result.addresses,
		...(recovery === undefined ? {} : { recovery }),
	};
}

export async function runReconcile(
	runId: string,
	options: ReconcileOptions,
	pool?: import('pg').Pool,
): Promise<ReconcileResult> {
	let owned: import('pg').Pool;
	try {
		owned = pool ?? (await createDbConnection(options.db)).pool;
	} catch (error) {
		return {
			outcome: 'reconcile-run-unavailable',
			runId,
			addresses: [],
			failureCause: classifyReconcileFailure(error, 'reconcile'),
		};
	}
	try {
		return mapAdapterResult(await reconcilePgTransitionRun(owned, runId));
	} catch (error) {
		const typed =
			error instanceof PgReconcileTransitionRunError ? error : undefined;
		const cause = typed?.originalCause ?? error;
		return {
			outcome: 'reconcile-run-unavailable',
			runId,
			addresses: [],
			detail: escapeDiagnosticText(
				cause instanceof Error ? cause.message : String(cause),
			),
			failureCause: classifyReconcileFailure(
				cause,
				typed?.stage ?? 'reconcile',
			),
		};
	} finally {
		if (pool === undefined) await owned.end();
	}
}

export const reconcileCommand = new Command('reconcile')
	.description('Resolve this run’s open managed claims from live evidence only')
	.argument('<run-id>', 'Durable run identifier')
	.requiredOption('-d, --db <url>', 'Database connection URL (required)')
	.option('--format <format>', 'Output format: text or json', 'text')
	.action(async (runId: string, options: ReconcileOptions) => {
		const result = await runReconcile(runId, options);
		if (options.format === 'json') printCliJson(result);
		else console.log(formatReconcileHuman(result));
		process.exitCode = result.outcome === 'reconcile-completed' ? 0 : 1;
	});
