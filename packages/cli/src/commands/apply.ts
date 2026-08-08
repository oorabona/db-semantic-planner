/** Execute exactly one reviewed durable transition run; never re-plan. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import {
	appendTransitionAuthorization,
	createPgTransitionPack,
	preparePgExecutionSession,
	readTransitionJournal,
	validatePgManagedLedgerCurrency,
	withPgTransitionRunLock,
} from '@dbsp/adapter-pgsql';
import {
	acquireExclusiveTransitionLease,
	createApplier,
	createPackRegistry,
	type PackRegistry,
	selectorMatchesResource,
	transitionPlanDigest,
} from '@dbsp/core';
import type {
	ApplyPolicy,
	ApplyResult,
	AssumptionAcceptance,
	ResourceAddress,
	ResourceSelector,
	TransitionRunAuthorization,
	TrustRoot,
} from '@dbsp/types';
import { Command } from 'commander';
import type { Pool } from 'pg';
import { createDbConnection } from '../utils/db-utils.js';
import {
	exitCodeForPlanResult,
	formatPlanHuman,
	formatPlanJson,
	type PlanResult,
	runPlan,
} from './plan.js';

export type ApplyFormat = 'text' | 'json';
export interface ApplyOptions {
	readonly db: string;
	readonly planDigest?: string;
	readonly accept?: readonly string[];
	readonly acceptPolicy?: string;
	readonly format?: ApplyFormat;
	/** The no-argument form's authored declaration. */
	readonly schemaFile?: string;
	readonly schema?: string;
	readonly yes?: boolean;
	readonly dryRun?: boolean;
}

function errorDetail(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** A failed owned-pool cleanup supplements a computed command result. */
export async function withPoolCleanupReported<T extends object>(
	result: T,
	close: () => Promise<void>,
): Promise<T & { readonly cleanupError?: string }> {
	try {
		await close();
		return result;
	} catch (error) {
		return {
			...result,
			cleanupError: `database pool cleanup failed: ${errorDetail(error)}`,
		};
	}
}

function compareCodeUnits(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/** Stable JSON encoding: object keys sort lexically and arrays retain their supplied order. */
export function canonicalJson(value: unknown): string {
	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'boolean' ||
		typeof value === 'number'
	) {
		if (typeof value === 'number' && !Number.isFinite(value))
			throw new Error('policy values must be finite JSON values');
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	if (typeof value !== 'object')
		throw new Error(
			'policy values must be JSON values (undefined is not allowed)',
		);
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(',')}}`;
}

function nonEmptyString(value: unknown, path: string): asserts value is string {
	if (typeof value !== 'string' || value.length === 0 || value.trim() !== value)
		throw new Error(`${path} must be a non-empty, unpadded string`);
}

function exactKeys(
	record: Record<string, unknown>,
	allowed: readonly string[],
	path: string,
	subject = 'AssumptionAcceptance',
): void {
	for (const key of Object.keys(record)) {
		if (!allowed.includes(key))
			throw new Error(`${path}.${key} is not a valid ${subject} field`);
	}
}

function record(value: unknown, path: string): Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value))
		throw new Error(`${path} must be an object`);
	return value as Record<string, unknown>;
}

function validateResourceAddress(
	value: unknown,
	path: string,
): ResourceAddress {
	const candidate = record(value, path);
	exactKeys(
		candidate,
		[
			'engine',
			'database',
			'schema',
			'parent',
			'kind',
			'name',
			'catalogueIdentity',
			'qualifiedBy',
		],
		path,
	);
	for (const key of ['engine', 'database', 'kind', 'name'] as const)
		nonEmptyString(candidate[key], `${path}.${key}`);
	if (candidate.schema !== undefined)
		nonEmptyString(candidate.schema, `${path}.schema`);
	if (candidate.parent !== undefined)
		validateResourceAddress(candidate.parent, `${path}.parent`);
	if (candidate.catalogueIdentity !== undefined) {
		const identity = record(
			candidate.catalogueIdentity,
			`${path}.catalogueIdentity`,
		);
		exactKeys(
			identity,
			['engine', 'format', 'value'],
			`${path}.catalogueIdentity`,
			'catalogue identity',
		);
		nonEmptyString(identity.engine, `${path}.catalogueIdentity.engine`);
		if (
			typeof identity.format !== 'number' ||
			!Number.isInteger(identity.format) ||
			identity.format <= 0
		)
			throw new Error(
				`${path}.catalogueIdentity.format must be a positive integer`,
			);
		const identityValue = record(
			identity.value,
			`${path}.catalogueIdentity.value`,
		);
		try {
			canonicalJson(identityValue);
		} catch (error) {
			throw new Error(
				`${path}.catalogueIdentity.value must be a canonicalizable JSON object: ${errorDetail(error)}`,
			);
		}
	}
	if (candidate.qualifiedBy !== undefined) {
		if (!Array.isArray(candidate.qualifiedBy))
			throw new Error(`${path}.qualifiedBy must be an array of strings`);
		candidate.qualifiedBy.forEach((part, index) => {
			nonEmptyString(part, `${path}.qualifiedBy[${index}]`);
		});
	}
	return candidate as unknown as ResourceAddress;
}

function validateSelector(value: unknown, path: string): ResourceSelector {
	const candidate = record(value, path);
	exactKeys(candidate, ['kind', 'schema', 'name', 'within'], path);
	for (const key of ['kind', 'schema', 'name'] as const) {
		if (candidate[key] !== undefined)
			nonEmptyString(candidate[key], `${path}.${key}`);
	}
	if (candidate.within !== undefined)
		validateResourceAddress(candidate.within, `${path}.within`);
	return candidate as ResourceSelector;
}

function validateTrustRoot(value: unknown, path: string): TrustRoot {
	const candidate = record(value, path);
	nonEmptyString(candidate.kind, `${path}.kind`);
	switch (candidate.kind) {
		case 'pack': {
			exactKeys(candidate, ['kind', 'artifact'], path);
			const artifact = record(candidate.artifact, `${path}.artifact`);
			exactKeys(artifact, ['id', 'version'], `${path}.artifact`);
			nonEmptyString(artifact.id, `${path}.artifact.id`);
			nonEmptyString(artifact.version, `${path}.artifact.version`);
			return candidate as TrustRoot;
		}
		case 'human':
			exactKeys(candidate, ['kind', 'identity'], path);
			nonEmptyString(candidate.identity, `${path}.identity`);
			return candidate as TrustRoot;
		case 'policy':
			exactKeys(candidate, ['kind', 'policyId'], path);
			nonEmptyString(candidate.policyId, `${path}.policyId`);
			return candidate as TrustRoot;
		default:
			throw new Error(`${path}.kind must be pack, human, or policy`);
	}
}

/** Reject malformed policy input before it can be mistaken for a non-matching grant. */
export function validateAssumptionAcceptance(
	value: unknown,
	path = 'acceptance',
): AssumptionAcceptance {
	const candidate = record(value, path);
	exactKeys(candidate, ['class', 'fromTrustRoot', 'withinScope'], path);
	nonEmptyString(candidate.class, `${path}.class`);
	if (candidate.fromTrustRoot !== undefined)
		validateTrustRoot(candidate.fromTrustRoot, `${path}.fromTrustRoot`);
	if (candidate.withinScope !== undefined) {
		if (!Array.isArray(candidate.withinScope))
			throw new Error(`${path}.withinScope must be an array of selectors`);
		candidate.withinScope.forEach((selector, index) => {
			validateSelector(selector, `${path}.withinScope[${index}]`);
		});
	}
	return candidate as unknown as AssumptionAcceptance;
}

function normaliseAcceptance(
	acceptance: AssumptionAcceptance,
): AssumptionAcceptance {
	const validated = validateAssumptionAcceptance(acceptance);
	const withinScope = validated.withinScope
		? [
				...new Map(
					validated.withinScope.map((item) => [canonicalJson(item), item]),
				),
			]
				.sort(([left], [right]) => compareCodeUnits(left, right))
				.map(([, item]) => JSON.parse(canonicalJson(item)) as ResourceSelector)
		: undefined;
	return JSON.parse(
		canonicalJson({
			class: validated.class,
			...(validated.fromTrustRoot
				? { fromTrustRoot: validated.fromTrustRoot }
				: {}),
			...(withinScope === undefined ? {} : { withinScope }),
		}),
	) as AssumptionAcceptance;
}

/**
 * Canonical policy representation used for both the authorization record and
 * its SHA-256 digest.  File and repeated --accept grants form a set union:
 * exact duplicates are retained once, and selector order is normalized.
 */
export function canonicalApplyPolicy(
	acceptances: readonly AssumptionAcceptance[],
): readonly AssumptionAcceptance[] {
	return [
		...new Map(
			acceptances.map((item) => {
				const normalized = normaliseAcceptance(item);
				return [canonicalJson(normalized), normalized] as const;
			}),
		),
	]
		.sort(([left], [right]) => compareCodeUnits(left, right))
		.map(([, item]) => item);
}

export function policyDigest(policy: readonly AssumptionAcceptance[]): string {
	return createHash('sha256')
		.update(canonicalJson(canonicalApplyPolicy(policy)))
		.digest('hex');
}

/**
 * Hash the exact durable approval, not merely its policy. Run id prevents an
 * approval from replaying onto another run; plan digest pins its reviewed
 * content; grants record which policy entry accepted each assumption.
 */
export function authorizationDigest(
	runId: string,
	planDigest: string,
	policy: readonly AssumptionAcceptance[],
	grants: TransitionRunAuthorization['grants'],
	actor: string,
	authorizedAt: string,
): string {
	const authorizedInstant = new Date(authorizedAt);
	if (Number.isNaN(authorizedInstant.getTime()))
		throw new Error('authorization timestamp must be a valid instant');
	return createHash('sha256')
		.update(
			canonicalJson({
				runId,
				planDigest,
				policy: canonicalApplyPolicy(policy),
				grants,
				actor,
				// PostgreSQL drivers may spell the same timestamptz instant differently.
				authorizedAt: authorizedInstant.toISOString(),
			}),
		)
		.digest('hex');
}

/** A prior authorization is reusable only when every authorization input matches. */
export function hasReusableAuthorization(
	authorizations:
		| readonly Pick<
				TransitionRunAuthorization,
				'digest' | 'actor' | 'authorizedAt' | 'policy' | 'grants'
		  >[]
		| undefined,
	runId: string,
	planDigest: string,
	policy: readonly AssumptionAcceptance[],
	grants: TransitionRunAuthorization['grants'],
): boolean {
	return (
		authorizations?.some(
			(item) =>
				canonicalJson(item.policy) === canonicalJson(policy) &&
				canonicalJson(item.grants) === canonicalJson(grants) &&
				item.digest ===
					authorizationDigest(
						runId,
						planDigest,
						policy,
						grants,
						item.actor,
						item.authorizedAt,
					),
		) ?? false
	);
}

/** Policy files are UTF-8 JSON arrays of strictly validated AssumptionAcceptance objects. */
export async function effectiveApplyPolicy(
	options: ApplyOptions,
): Promise<ApplyPolicy> {
	let fromFile: unknown[] = [];
	if (options.acceptPolicy) {
		const parsed: unknown = JSON.parse(
			await readFile(options.acceptPolicy, 'utf8'),
		);
		if (!Array.isArray(parsed))
			throw new Error('--accept-policy must contain a JSON array');
		fromFile = parsed;
	}
	const merged = [
		...fromFile,
		...(options.accept ?? []).map((classification) => ({
			class: classification,
		})),
	];
	return {
		accepts: canonicalApplyPolicy(
			merged.map((grant, index) =>
				validateAssumptionAcceptance(grant, `acceptance[${index}]`),
			),
		),
	};
}

function registry(): PackRegistry {
	return createPackRegistry([createPgTransitionPack({})]);
}

/**
 * `dbsp apply`'s public result contract.  `outcome` is always present in
 * `--format json`; it is the stable machine-readable name and `exitCode` is
 * its exact process status.  Core step outcomes retain their core names.
 */
export const APPLY_OUTCOME_CONTRACT = [
	['completed', 0, 'all planned steps completed'],
	['operation-failed-not-applied', 10, 'operation failed before application'],
	['partially-applied', 11, 'some target effects may be durable'],
	['unknown-step-result', 12, 'a step result could not be determined'],
	['outcome-unknown', 13, 'run lifecycle is indeterminate'],
	['guard-failed', 14, 'a guard rejected the target'],
	['guard-timeout', 15, 'a guard timed out'],
	['context-mismatch', 16, 'target no longer matches the run context'],
	[
		'transactional-only-refusal',
		17,
		"durable apply executes segments that forbid a transaction block only when the plan's non-transactional-segment assumption is accepted",
	],
	['digest-mismatch', 18, 'persisted plan does not match its recorded digest'],
	[
		'plan-digest-required',
		32,
		'apply requires the plan digest printed by dbsp plan',
	],
	[
		'plan-digest-mismatch',
		33,
		'operator-reviewed plan digest does not match the stored plan',
	],
	[
		'prior-step-events-refusal',
		19,
		'attempted runs must be classified by recover',
	],
	[
		'compatibility-refusal',
		20,
		'run execution compatibility epoch is unsupported',
	],
	['run-busy', 21, 'another database session holds this run lock'],
	[
		'assumption-not-accepted',
		22,
		'policy does not accept a required assumption',
	],
	['authorization-write-failed', 23, 'authorization was not durably committed'],
	[
		'execution-contract-refused',
		31,
		'execution contract clause was refused; re-plan for a different target or correct access',
	],
	[
		'execution-preflight-failed',
		30,
		'execution preflight query failed; retry after transport or read access is restored',
	],
	[
		'execution-failed',
		56,
		'execution phase failed after preflight; inspect the run with recover',
	],
	['database-read-only', 34, 'target cannot accept managed writes'],
	[
		'confirmation-required',
		57,
		'no-argument apply requires an interactive confirmation or --yes',
	],
	[
		'confirmation-declined',
		58,
		'operator declined the persisted plan before execution',
	],
	['operation-unavailable', 24, 'a required operation artifact is unavailable'],
	['plan-validation-failed', 25, 'stored run evidence is invalid'],
	['run-id-mismatch', 26, 'loaded run does not match the requested id'],
	['load-failed', 27, 'run or target context could not be loaded'],
	['policy-invalid', 28, 'acceptance policy input is malformed'],
	['apply-failed', 29, 'unexpected apply command failure'],
] as const;

export type ApplyOutcome = (typeof APPLY_OUTCOME_CONTRACT)[number][0];
type ApplyExecutionOutcome = Exclude<
	ApplyOutcome,
	'run-busy' | 'plan-digest-required' | 'policy-invalid' | 'apply-failed'
>;

const applyExitCodes = new Map<ApplyOutcome, number>(
	APPLY_OUTCOME_CONTRACT.map(([outcome, exitCode]) => [outcome, exitCode]),
);

function isApplyOutcome(value: string): value is ApplyOutcome {
	return applyExitCodes.has(value as ApplyOutcome);
}

function isApplyExecutionOutcome(
	value: string,
): value is ApplyExecutionOutcome {
	return (
		isApplyOutcome(value) &&
		value !== 'run-busy' &&
		value !== 'policy-invalid' &&
		value !== 'apply-failed'
	);
}

export function exitCodeForApplyOutcome(outcome: ApplyOutcome): number {
	return applyExitCodes.get(outcome) as number;
}

export function outcomeForApplyResult(
	result: ApplyResult,
): ApplyExecutionOutcome {
	if (result.durableOutcome && isApplyExecutionOutcome(result.durableOutcome))
		return result.durableOutcome;
	// A committed earlier segment is the operator-facing fact.  Do not let the
	// narrower reason from a later segment hide durable target effects.
	if (result.assessment.lifecycle === 'partially-applied')
		return 'partially-applied';
	if (result.assessment.lifecycle === 'completed') return 'completed';
	const reason = result.assessment.reasons[0];
	if (
		reason?.code === 'context-mismatch' &&
		'fact' in reason &&
		reason.fact?.key === 'durable-apply-outcome' &&
		isApplyExecutionOutcome(reason.fact.value)
	) {
		return reason.fact.value;
	}
	if (reason?.code === 'unknown-step-result') return 'unknown-step-result';
	if (reason?.code === 'operation-failed-not-applied')
		return 'operation-failed-not-applied';
	if (reason?.code === 'partially-applied') return 'partially-applied';
	if (reason?.code === 'guard-failed') return 'guard-failed';
	if (reason?.code === 'guard-timeout') return 'guard-timeout';
	if (reason?.code === 'context-mismatch') return 'context-mismatch';
	if (result.assessment.lifecycle === 'outcome-unknown')
		return 'outcome-unknown';
	return 'context-mismatch';
}

function formatApplyHuman(result: {
	readonly outcome: string;
	readonly runId: string;
	readonly result?: ApplyResult;
}): string {
	const line = `${result.outcome}: ${result.runId}`;
	if (result.outcome !== 'plan-digest-mismatch' || !result.result) return line;
	const detail = result.result.assessment.reasons[0]?.detail;
	return detail ? `${line}\n${detail}` : line;
}

function acceptanceMatches(
	assumption: {
		readonly class: string;
		readonly asserter: TrustRoot;
		readonly scope: readonly ResourceAddress[];
	},
	acceptance: AssumptionAcceptance,
): boolean {
	return (
		acceptance.class === assumption.class &&
		(!acceptance.fromTrustRoot ||
			canonicalJson(acceptance.fromTrustRoot) ===
				canonicalJson(assumption.asserter)) &&
		(assumption.scope.length === 0
			? !acceptance.withinScope || acceptance.withinScope.length === 0
			: !acceptance.withinScope ||
				acceptance.withinScope.length === 0 ||
				assumption.scope.every((resource) =>
					acceptance.withinScope?.some((selector) =>
						selectorMatchesResource(selector, resource),
					),
				))
	);
}

export type ApplyCommandResult = (
	| {
			readonly outcome: Exclude<
				ApplyOutcome,
				'run-busy' | 'plan-digest-required' | 'policy-invalid' | 'apply-failed'
			>;
			readonly runId: string;
			readonly result: ApplyResult;
	  }
	| {
			readonly outcome: 'run-busy' | 'plan-digest-required';
			readonly runId: string;
	  }
) & { readonly cleanupError?: string };

export type NoArgumentApplyResult =
	| {
			readonly outcome:
				| 'dry-run'
				| 'not-executable'
				| 'confirmation-required'
				| 'confirmation-declined';
			readonly plan: PlanResult;
			readonly runId: string | null;
			readonly planDigest: string | null;
	  }
	| {
			readonly outcome: ApplyOutcome;
			readonly plan: PlanResult;
			readonly runId: string;
			readonly planDigest: string;
			readonly result: ApplyCommandResult;
	  };

export type ApplyConfirmation = (
	runId: string,
	planDigest: string,
) => Promise<boolean>;

/** The sole interactive gate for no-argument apply. EOF and every non-y answer refuse. */
export async function confirmNoArgumentApply(
	runId: string,
	planDigest: string,
): Promise<boolean> {
	const prompt = createInterface({
		input: process.stdin,
		output: process.stderr,
	});
	try {
		const answer = await prompt.question(
			`Apply persisted run ${runId} (plan digest ${planDigest})? [y/N] `,
		);
		return /^(?:y|yes)$/iu.test(answer.trim());
	} finally {
		prompt.close();
	}
}

/**
 * The unrecorded-plan path deliberately delegates proving and persistence to
 * runPlan. Therefore the durable row exists before this function asks a human
 * to approve it, and a decline is inspectable rather than a discarded plan.
 */
export async function runNoArgumentApply(
	options: ApplyOptions,
	confirm: ApplyConfirmation = confirmNoArgumentApply,
	execute: typeof runApply = runApply,
): Promise<NoArgumentApplyResult> {
	if (!options.schemaFile)
		throw new Error('no-argument apply requires --schema-file <path>');
	const plan = await runPlan({
		db: options.db,
		schemaFile: options.schemaFile,
		...(options.schema === undefined ? {} : { schema: options.schema }),
		dryRun: options.dryRun === true,
		format: options.format === 'json' ? 'json' : 'sql',
	});
	if (options.dryRun === true)
		return {
			outcome: 'dry-run',
			plan,
			runId: null,
			planDigest: null,
		};
	if (
		plan.proveKind !== 'proven' ||
		plan.persisted !== true ||
		!plan.runId ||
		!plan.planDigest
	) {
		// A blocked/no-drift plan has no executable durable record. Its existing
		// presentation is the complete result; do not invent an apply attempt.
		return {
			outcome: 'not-executable',
			plan,
			runId: plan.runId,
			planDigest: plan.planDigest,
		};
	}
	if (options.yes !== true && process.stdin.isTTY !== true) {
		return {
			outcome: 'confirmation-required',
			plan,
			runId: plan.runId,
			planDigest: plan.planDigest,
		};
	}
	if (options.yes !== true && !(await confirm(plan.runId, plan.planDigest))) {
		return {
			outcome: 'confirmation-declined',
			plan,
			runId: plan.runId,
			planDigest: plan.planDigest,
		};
	}
	const result = await execute(plan.runId, {
		...options,
		planDigest: plan.planDigest,
	});
	return {
		outcome: result.outcome,
		plan,
		runId: plan.runId,
		planDigest: plan.planDigest,
		result,
	};
}

async function loadOnTarget(
	target: Parameters<typeof acquireExclusiveTransitionLease>[0],
	runId: string,
) {
	const lease = await acquireExclusiveTransitionLease(target);
	try {
		return await readTransitionJournal(lease.session, runId, { ensure: false });
	} finally {
		await lease.release();
	}
}

export async function runApply(
	runId: string,
	options: ApplyOptions,
	pool?: Pool,
): Promise<ApplyCommandResult> {
	const expectedPlanDigest = options.planDigest;
	if (!expectedPlanDigest) return { outcome: 'plan-digest-required', runId };
	const policy = await effectiveApplyPolicy(options);
	const owned =
		pool === undefined ? (await createDbConnection(options.db)).pool : pool;
	let result: ApplyCommandResult;
	try {
		const locked = await withPgTransitionRunLock(
			owned,
			runId,
			async (target) => {
				const loadCurrent = async (id: string) => {
					return loadOnTarget(target, id);
				};
				const applier = createApplier(registry(), {
					// A durable apply only verifies the existing immutable row. The applier
					// calls this before execution; a changed record remains a refusal.
					persist: async () => undefined,
				});
				return applier.applyDurable({
					runId,
					expectedPlanDigest,
					loadCurrent,
					prepareExecutionSession: async (session, contract, plan) => {
						const currency = await validatePgManagedLedgerCurrency(
							session,
							plan,
						);
						if (currency)
							return { ok: false, kind: 'refused' as const, detail: currency };
						return preparePgExecutionSession(session, contract, plan);
					},
					policy,
					target,
					authorize: async (run, plan, session) => {
						const current = await loadOnTarget(target, run.runId);
						const grants = plan.assumptions.map((assumption) => ({
							assumptionId: assumption.id,
							grant: policy.accepts.findIndex((grant) =>
								acceptanceMatches(assumption, grant),
							),
						}));
						// Crash after commit but before intent: reuse the exact prior approval.
						if (
							hasReusableAuthorization(
								current.authorizations,
								run.runId,
								transitionPlanDigest(plan),
								policy.accepts,
								grants,
							)
						)
							return;
						const actor =
							process.env.USER ?? process.env.LOGNAME ?? 'unknown-local-actor';
						const authorizedAt = new Date().toISOString();
						const digest = authorizationDigest(
							run.runId,
							transitionPlanDigest(plan),
							policy.accepts,
							grants,
							actor,
							authorizedAt,
						);
						const record: TransitionRunAuthorization = {
							runId: run.runId,
							policy: policy.accepts,
							grants,
							digest,
							actor,
							authorizedAt,
						};
						await appendTransitionAuthorization(session, record);
					},
				});
			},
		);
		result =
			locked.kind === 'busy'
				? { outcome: 'run-busy', runId }
				: {
						outcome: outcomeForApplyResult(locked.value),
						runId,
						result: locked.value,
					};
	} catch (error) {
		if (pool === undefined) {
			try {
				await owned.end();
			} catch {
				// The primary failure remains the command failure.
			}
		}
		throw error;
	}
	if (pool === undefined) {
		return withPoolCleanupReported(result, () => owned.end());
	}
	return result;
}

export const applyCommand = new Command('apply')
	.description(
		'Plan, persist, present and execute a declaration, or execute one reviewed durable run',
	)
	.argument('[run-id]', 'Durable run identifier returned by dbsp plan')
	.requiredOption('-d, --db <url>', 'Database connection URL (required)')
	.option(
		'--plan-digest <sha>',
		'Plan digest printed by dbsp plan; required to anchor review outside the database',
	)
	.option('--schema-file <path>', 'Schema DSL file for no-argument apply')
	.option(
		'--schema <name>',
		'Database schema name for no-argument apply',
		'public',
	)
	.option('--yes', 'Confirm no-argument apply without an interactive prompt')
	.option(
		'--dry-run',
		'Present a no-argument plan without persisting or executing',
	)
	.option(
		'--accept <class>',
		'Accept an assumption class broadly; repeatable',
		(value, previous: string[] = []) => [...previous, value],
	)
	.option(
		'--accept-policy <file>',
		'UTF-8 JSON AssumptionAcceptance[] policy file; set-unioned with --accept and canonicalised before authorization',
	)
	.option('--format <format>', 'Output format: text or json', 'text')
	.action(async (runId: string | undefined, options: ApplyOptions) => {
		if (runId === undefined) {
			let result: NoArgumentApplyResult | { readonly error: string };
			try {
				result = await runNoArgumentApply(options);
			} catch (error) {
				result = {
					error: error instanceof Error ? error.message : String(error),
				};
			}
			if ('error' in result) {
				if (options.format === 'json')
					console.log(
						JSON.stringify({ outcome: 'apply-failed', ...result }, null, 2),
					);
				else console.error(`❌ ${result.error}`);
				process.exitCode = exitCodeForApplyOutcome('apply-failed');
				return;
			}
			const exitCode =
				result.outcome === 'dry-run' || result.outcome === 'not-executable'
					? exitCodeForPlanResult(result.plan)
					: exitCodeForApplyOutcome(result.outcome);
			if (options.format === 'json') {
				console.log(
					JSON.stringify(
						{
							outcome: result.outcome,
							exitCode,
							plan: formatPlanJson(result.plan, options.dryRun === true),
							...(result.runId === null ? {} : { runId: result.runId }),
							...(result.planDigest === null
								? {}
								: { planDigest: result.planDigest }),
							...('result' in result ? { apply: result.result } : {}),
						},
						null,
						2,
					),
				);
			} else {
				console.log(formatPlanHuman(result.plan, options.dryRun === true));
				if (result.outcome === 'confirmation-required')
					console.error(
						'confirmation-required: rerun with --yes or from an interactive TTY',
					);
				else if (result.outcome === 'confirmation-declined')
					console.log('confirmation-declined: persisted run was not executed');
				else if (result.outcome === 'not-executable') {
					// The planner already rendered the concrete no-drift/blocked reason.
				} else if (result.outcome !== 'dry-run' && 'result' in result)
					console.log(formatApplyHuman(result.result));
			}
			process.exitCode = exitCode;
			return;
		}
		let result:
			| ApplyCommandResult
			| {
					readonly outcome: 'policy-invalid' | 'apply-failed';
					readonly runId: string;
					readonly error: string;
			  };
		try {
			result = options.planDigest
				? await runApply(runId, options)
				: { outcome: 'plan-digest-required', runId };
		} catch (error) {
			result = {
				outcome:
					error instanceof SyntaxError ? 'policy-invalid' : 'apply-failed',
				runId,
				error: error instanceof Error ? error.message : String(error),
			};
			// Validation errors are ordinary Errors, not necessarily SyntaxErrors.
			if (
				result.outcome === 'apply-failed' &&
				/^(acceptance\[|--accept-policy|policy )/u.test(result.error)
			)
				result = { ...result, outcome: 'policy-invalid' };
		}
		const exitCode = exitCodeForApplyOutcome(result.outcome);
		const document = { ...result, exitCode };
		if (options.format === 'json')
			console.log(JSON.stringify(document, null, 2));
		else console.log(formatApplyHuman(result));
		process.exitCode = exitCode;
	})
	.addHelpText(
		'after',
		`\nJSON result contract (outcome -> exit code):\n${APPLY_OUTCOME_CONTRACT.map(
			([outcome, exitCode, description]) =>
				`  ${outcome} -> ${exitCode}: ${description}`,
		).join(
			'\n',
		)}\n\nApply requires --plan-digest from dbsp plan. It recomputes the stored plan digest before authorization or planned DDL and refuses a missing or mismatched value. This detects substitution, not deletion: missing run evidence makes apply refuse. Policy files are JSON arrays. Every entry is strictly validated; file entries and repeated --accept values are set-unioned, exact duplicates are normalized, selector order is normalized, and the authorization digest is SHA-256 over canonical JSON {runId, planDigest, policy, grants}.\n`,
	);
