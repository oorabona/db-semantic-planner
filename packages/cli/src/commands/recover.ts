/** Classify a previously attempted run. Recovery never executes planned DDL. */
import {
	createPgTransitionPack,
	preparePgRecoveryAdmission,
	readPgObservationContextFromLessor,
	readTransitionJournal,
	withPgTransitionRunLock,
} from '@dbsp/adapter-pgsql';
import {
	acquireTransitionTargetLease,
	assumptionAccepted,
	createApplier,
	createPackRegistry,
	loadVerifiedRecoveryJournal,
	transitionPlanDigest,
	validateTransitionRelationalInvariants,
} from '@dbsp/core';
import type {
	ApplyPolicy,
	ApplyResult,
	TransitionRunJournal,
} from '@dbsp/types';
import { Command } from 'commander';
import type { Pool } from 'pg';
import { createDbConnection } from '../utils/db-utils.js';
import {
	authorizationDigest,
	canonicalApplyPolicy,
	validateAssumptionAcceptance,
	withPoolCleanupReported,
} from './apply.js';

export const RECOVER_OUTCOME_CONTRACT = [
	['completed', 0, 'all attempted steps were durably reconciled'],
	['recovery-resume-required', 40, 'remaining work requires a new proof'],
	['recovery-partially-applied', 41, 'durable effects require recovery action'],
	['recovery-unknown-step-result', 42, 'a prior step could not be classified'],
	['recovery-guard-failed', 43, 'a prior guard rejected the target'],
	['recovery-guard-timeout', 44, 'a prior guard timed out'],
	[
		'recovery-operation-failed-not-applied',
		45,
		'a prior operation rolled back',
	],
	[
		'recovery-context-mismatch',
		46,
		'run evidence or target context is invalid',
	],
	['recovery-read-failed', 47, 'recovery could not read the target'],
	['recovery-load-failed', 48, 'run journal could not be loaded'],
	['recovery-plan-invalid', 49, 'stored plan failed validation'],
	[
		'recovery-authorization-missing',
		50,
		'attempted run has no durable authorization',
	],
	[
		'recovery-authorization-invalid',
		51,
		'attempted run authorization is invalid',
	],
	['plan-digest-required', 54, 'a reviewed plan digest is required'],
	[
		'recovery-plan-digest-mismatch',
		55,
		'reviewed plan digest does not match the run',
	],
	['run-busy', 52, 'another database session holds this run lock'],
	['recovery-failed', 53, 'unexpected recovery command failure'],
] as const;

export type RecoverOutcome = (typeof RECOVER_OUTCOME_CONTRACT)[number][0];
const recoverExitCodes = new Map<RecoverOutcome, number>(
	RECOVER_OUTCOME_CONTRACT.map(([outcome, exitCode]) => [outcome, exitCode]),
);

export function exitCodeForRecoverOutcome(outcome: RecoverOutcome): number {
	return recoverExitCodes.get(outcome) as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

type AuthorizationValidation =
	| { readonly ok: true; readonly policy: ApplyPolicy }
	| {
			readonly ok: false;
			readonly outcome:
				| 'recovery-authorization-missing'
				| 'recovery-authorization-invalid';
	  };

/**
 * Recovery uses a durable approval exactly as recorded; it never turns plan
 * assumptions into new broad grants. A record must bind its canonical policy,
 * digest, and one accepting grant for every plan assumption.
 */
export function validateRecoveryAuthorization(
	journal: TransitionRunJournal & {
		readonly plan: import('@dbsp/types').ProvenPlanShape;
	},
): AuthorizationValidation {
	const records = journal.authorizations ?? [];
	if (records.length === 0)
		return { ok: false, outcome: 'recovery-authorization-missing' };
	for (const candidate of records) {
		try {
			if (!isRecord(candidate) || candidate.runId !== journal.run.runId)
				continue;
			if (!Array.isArray(candidate.policy) || !Array.isArray(candidate.grants))
				continue;
			const accepts = canonicalApplyPolicy(
				candidate.policy.map((grant, index) =>
					validateAssumptionAcceptance(grant, `authorization.policy[${index}]`),
				),
			);
			const grants = new Map<string, number>();
			for (const grant of candidate.grants) {
				if (!isRecord(grant) || typeof grant.assumptionId !== 'string')
					throw new Error('invalid authorization grant');
				if (!Number.isInteger(grant.grant))
					throw new Error('invalid authorization grant index');
				if (grants.has(grant.assumptionId))
					throw new Error('duplicate authorization grant');
				grants.set(grant.assumptionId, grant.grant as number);
			}
			if (
				typeof candidate.digest !== 'string' ||
				candidate.digest !==
					authorizationDigest(
						journal.run.runId,
						journal.run.planDigest,
						accepts,
						candidate.grants,
						candidate.actor,
						candidate.authorizedAt,
					)
			)
				continue;
			if (grants.size !== journal.plan.assumptions.length) continue;
			const policy = { accepts };
			if (
				journal.plan.assumptions.every((assumption) => {
					const grant = grants.get(assumption.id);
					const acceptedGrant =
						grant === undefined ? undefined : accepts[grant];
					return (
						grant !== undefined &&
						grant >= 0 &&
						grant < accepts.length &&
						acceptedGrant !== undefined &&
						assumptionAccepted(assumption, {
							accepts: [acceptedGrant],
						})
					);
				})
			)
				return { ok: true, policy };
		} catch {
			// A malformed durable record is not a policy input to repair here.
		}
	}
	return { ok: false, outcome: 'recovery-authorization-invalid' };
}

export function recoveryPolicyForJournal(
	loaded: TransitionRunJournal & {
		readonly plan: import('@dbsp/types').ProvenPlanShape;
	},
	runId: string,
):
	| { readonly ok: true; readonly policy: ApplyPolicy }
	| {
			readonly ok: false;
			readonly outcome:
				| 'recovery-plan-invalid'
				| 'recovery-authorization-missing'
				| 'recovery-authorization-invalid';
	  } {
	if (
		loaded.run.runId !== runId ||
		loaded.run.planDigest !== transitionPlanDigest(loaded.plan) ||
		!validateTransitionRelationalInvariants({ kind: 'plan', plan: loaded.plan })
			.ok
	)
		return { ok: false, outcome: 'recovery-plan-invalid' };
	return validateRecoveryAuthorization(loaded);
}

export function outcomeForRecoveryResult(
	result: ApplyResult,
): Exclude<RecoverOutcome, 'run-busy' | 'recovery-failed'> {
	if (result.recoveryOutcome) return result.recoveryOutcome;
	if (result.assessment.lifecycle === 'completed') return 'completed';
	if (result.assessment.lifecycle === 'partially-applied')
		return 'recovery-partially-applied';
	const reason = result.assessment.reasons[0];
	switch (reason?.code) {
		case 'resume-required':
			return 'recovery-resume-required';
		case 'unknown-step-result':
			return 'recovery-unknown-step-result';
		case 'guard-failed':
			return 'recovery-guard-failed';
		case 'guard-timeout':
			return 'recovery-guard-timeout';
		case 'operation-failed-not-applied':
			return 'recovery-operation-failed-not-applied';
		default:
			return 'recovery-context-mismatch';
	}
}

async function load(
	target: Parameters<typeof acquireTransitionTargetLease>[0],
	runId: string,
) {
	const lease = await acquireTransitionTargetLease(target);
	try {
		return await readTransitionJournal(lease.session, runId, { ensure: false });
	} finally {
		await lease.release();
	}
}

export type RecoverCommandResult = (
	| {
			readonly outcome: Exclude<RecoverOutcome, 'run-busy' | 'recovery-failed'>;
			readonly runId: string;
			readonly result?: ApplyResult;
	  }
	| { readonly outcome: 'run-busy'; readonly runId: string }
) & {
	readonly cleanupError?: string;
};

type RecoverRunResult =
	| RecoverCommandResult
	| {
			readonly outcome:
				| 'plan-digest-required'
				| 'recovery-plan-digest-mismatch';
			readonly runId: string;
			readonly cleanupError?: string;
	  };

export async function runRecover(
	runId: string,
	options: { readonly db: string; readonly planDigest?: string },
	pool?: Pool,
): Promise<RecoverRunResult> {
	if (!options.planDigest) return { outcome: 'plan-digest-required', runId };
	const expectedPlanDigest = options.planDigest;
	const owned =
		pool === undefined ? (await createDbConnection(options.db)).pool : pool;
	let result: RecoverRunResult;
	try {
		const locked = await withPgTransitionRunLock(
			owned,
			runId,
			async (target) => {
				const loaded = await loadVerifiedRecoveryJournal(
					runId,
					expectedPlanDigest,
					(id) => load(target, id),
				);
				if (!loaded.ok) {
					switch (loaded.code) {
						case 'load-failed':
							return { outcome: 'recovery-load-failed' as const };
						case 'plan-digest-mismatch':
							return { outcome: 'recovery-plan-digest-mismatch' as const };
						case 'event-invalid':
							return { outcome: 'recovery-context-mismatch' as const };
						default:
							return { outcome: 'recovery-plan-invalid' as const };
					}
				}
				const authorization =
					loaded.journal.events.length === 0
						? undefined
						: recoveryPolicyForJournal(loaded.journal, runId);
				if (authorization && !authorization.ok)
					return { outcome: authorization.outcome };
				const result = await createApplier(
					createPackRegistry([createPgTransitionPack({})]),
					{ persist: async () => undefined },
				).resume(
					loaded.journal,
					(leasedTarget) => readPgObservationContextFromLessor(leasedTarget),
					authorization?.policy,
					target,
					async (leasedTarget, contract) => {
						const lease = await acquireTransitionTargetLease(leasedTarget);
						try {
							return await preparePgRecoveryAdmission(lease.session, contract);
						} finally {
							await lease.release();
						}
					},
				);
				return { outcome: outcomeForRecoveryResult(result), result };
			},
		);
		result =
			locked.kind === 'busy'
				? { outcome: 'run-busy', runId }
				: { ...locked.value, runId };
	} catch (error) {
		if (pool === undefined) {
			try {
				await owned.end();
			} catch {
				// Preserve the primary recovery error for the CLI boundary.
			}
		}
		throw error;
	}
	if (pool === undefined) {
		return withPoolCleanupReported(result, () => owned.end());
	}
	return result;
}

export const recoverCommand = new Command('recover')
	.description(
		'Observe and classify an attempted durable run; performs no planned target DDL and does not re-authorize assumptions',
	)
	.argument('<run-id>', 'Durable run identifier')
	.requiredOption('-d, --db <url>', 'Database connection URL (required)')
	.requiredOption(
		'--plan-digest <sha>',
		'Plan digest printed by dbsp plan; required to anchor recovery outside the database',
	)
	.option('--format <format>', 'Output format: text or json', 'text')
	.action(
		async (
			runId: string,
			options: { db: string; planDigest: string; format?: 'text' | 'json' },
		) => {
			let result:
				| RecoverCommandResult
				| {
						readonly outcome: 'recovery-failed';
						readonly runId: string;
						readonly error: string;
				  };
			try {
				result = await runRecover(runId, options);
			} catch (error) {
				result = {
					outcome: 'recovery-failed',
					runId,
					error: error instanceof Error ? error.message : String(error),
				};
			}
			const document = {
				...result,
				exitCode: exitCodeForRecoverOutcome(result.outcome),
			};
			if (options.format === 'json')
				console.log(JSON.stringify(document, null, 2));
			else console.log(`${result.outcome}: ${runId}`);
			process.exitCode = document.exitCode;
		},
	)
	.addHelpText(
		'after',
		`\nJSON result contract (outcome -> exit code):\n${RECOVER_OUTCOME_CONTRACT.map(([outcome, code, description]) => `  ${outcome} -> ${code}: ${description}`).join('\n')}\n`,
	);
