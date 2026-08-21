/** Execute exactly one reviewed durable transition run; never re-plan. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import {
	appendIntentJournal,
	appendTransitionAuthorization,
	createPgTransitionLessor,
	createPgTransitionPack,
	escapeDiagnosticText,
	preparePgExecutionSession,
	readPgLedgerAddressChain,
	readPgLedgerReservationsForExecution,
	readTransitionJournal,
	TransitionRunIdentityMismatchError,
	validatePgManagedLedgerCurrency,
	withPgTransitionRunLock,
} from '@dbsp/adapter-pgsql';
import { lockPgJournalRun } from '@dbsp/adapter-pgsql/internal';
import {
	acquireExclusiveTransitionLease,
	acquireTransitionLease,
	createApplier,
	createPackRegistry,
	type PackRegistry,
	selectorMatchesResource,
	transitionPlanDigest,
	validateNormalizedManagedStepManifest,
} from '@dbsp/core';
import { mintDurablyLoadedRun } from '@dbsp/core/internal';
import type {
	ApplyPolicy,
	ApplyResult,
	AssumptionAcceptance,
	LedgerAddress,
	LedgerHome,
	NormalizedManagedStep,
	PhysicalOperation,
	ResourceAddress,
	ResourceSelector,
	TransitionRunAuthorization,
	TransitionRunJournal,
	TrustRoot,
} from '@dbsp/types';
import { ledgerAddressKey, REFUSAL_VOCABULARY } from '@dbsp/types';
import { Command } from 'commander';
import type { Pool } from 'pg';
import { createDbConnection } from '../utils/db-utils.js';
import { printCliJson } from '../utils/output.js';
import { executionIdsForRun } from './execution-ids.js';
import {
	executeGeneratorPlan,
	type GeneratorExecutionResult,
} from './generator-execution.js';
import type { GeneratorDurablePlan } from './generator-plan.js';
import {
	persistedLifecycleDirectiveError,
	runGeneratorPlan,
} from './generator-plan.js';
import {
	exitCodeForPlanResult,
	formatPlanHuman,
	formatPlanJson,
	type PlanResult,
	runPlan,
} from './plan.js';
import {
	formatPreAppendRefusalHuman,
	type PreAppendRefusal,
	preAppendRefusalFor,
} from './refusal-output.js';

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
	/** Reviewed replacement selector(s) for the no-argument generator path. */
	readonly replace?: readonly string[];
}

/**
 * Recovery is keyed to the loaded durable run. Ledger address history belongs
 * to every run that touched the address and must not make a fresh run stale.
 */
export function generatorRunHasPriorStepEvents(
	loaded: Pick<TransitionRunJournal, 'events'>,
): boolean {
	return loaded.events.some((event) => {
		const executionId =
			event.event === 'intent' && 'executionId' in event.record
				? event.record.executionId
				: undefined;
		return !(
			typeof executionId === 'string' &&
			event.stepId === `dbsp.generator.attempt:${executionId}` &&
			event.operationRef === 'dbsp.generator.attempt'
		);
	});
}

function ledgerHomeForGeneratorAddress(address: LedgerAddress): LedgerHome {
	if (address.scope === 'database') return { scope: 'database' };
	if (!address.schema)
		throw new Error(
			`schema-scoped generated address ${address.name} has no schema ledger`,
		);
	return { scope: 'schema', schema: address.schema };
}

/** Every generated address, including each closure member, bounds replay evidence reads. */
function generatorPlanLedgerAddresses(
	steps: readonly NormalizedManagedStep[],
): readonly LedgerAddress[] {
	const addresses = new Map<string, LedgerAddress>();
	for (const step of steps) {
		if (step.address !== undefined) {
			addresses.set(ledgerAddressKey(step.address), step.address);
			continue;
		}
		const closure = step.closure;
		if (!closure)
			throw new Error(`generated step ${step.stepKey} has no ledger address`);
		const candidates = [
			closure.root,
			...closure.members.map((member) => member.address),
		];
		for (const address of candidates)
			addresses.set(ledgerAddressKey(address), address);
	}
	return [...addresses.values()];
}

/**
 * A recorded attempt remains retryable only until the ledger contains no trace
 * of it. Reservations are queried by ledger home; chain reads stay at plan addresses.
 */
async function generatorRunHasLedgerEvidence(
	session: Parameters<typeof readPgLedgerReservationsForExecution>[0],
	journal: Awaited<ReturnType<typeof readTransitionJournal>>,
	steps: readonly NormalizedManagedStep[],
): Promise<boolean> {
	const executionIds = executionIdsForRun(journal);
	const executionIdSet = new Set(executionIds);
	const addresses = generatorPlanLedgerAddresses(steps);
	const homes = new Map<string, LedgerHome>();
	for (const address of addresses) {
		const home = ledgerHomeForGeneratorAddress(address);
		homes.set(`${home.scope}:${home.schema ?? ''}`, home);
	}
	for (const home of homes.values()) {
		for (const executionId of executionIds) {
			const reservations = await readPgLedgerReservationsForExecution(
				session,
				home,
				executionId,
			);
			if (reservations.length > 0) return true;
		}
	}
	for (const address of addresses) {
		const chain = await readPgLedgerAddressChain(
			session,
			ledgerHomeForGeneratorAddress(address),
			address,
		);
		if (
			chain.events.some((event) => executionIdSet.has(event.executionId ?? ''))
		)
			return true;
	}
	return false;
}

/** The generator replay gate has one decision: journal steps or attributable ledger evidence. */
async function generatorRunRequiresRecovery(
	target: Parameters<typeof acquireExclusiveTransitionLease>[0],
	journal: Awaited<ReturnType<typeof readTransitionJournal>>,
	steps: readonly NormalizedManagedStep[],
): Promise<boolean> {
	if (generatorRunHasPriorStepEvents(journal)) return true;
	const lease = await acquireExclusiveTransitionLease(target);
	try {
		return await generatorRunHasLedgerEvidence(lease.session, journal, steps);
	} finally {
		await lease.release();
	}
}

const GENERATOR_ATTEMPT_OPERATION: Omit<PhysicalOperation, 'payload'> = {
	ref: 'dbsp.generator.attempt',
	operationKind: {
		artifact: {
			id: 'dbsp.postgresql.generator' as PhysicalOperation['operationKind']['artifact']['id'],
			version: '1',
		},
		name: 'GeneratorAttempt',
	},
};

/**
 * The just-persisted generator-removal exception is an in-module capability,
 * not an ApplyOptions field.  A public caller can neither name its type nor
 * manufacture a value accepted by the WeakSet check below.
 */
interface JustPersistedGeneratorRemovalCapability {
	readonly runId: string;
}

const justPersistedGeneratorRemovalCapabilities = new WeakSet<object>();
const justPersistedGeneratorRemovalContext =
	new AsyncLocalStorage<JustPersistedGeneratorRemovalCapability>();

function mintJustPersistedGeneratorRemovalCapability(
	runId: string,
): JustPersistedGeneratorRemovalCapability {
	const capability = Object.freeze({ runId });
	justPersistedGeneratorRemovalCapabilities.add(capability);
	return capability;
}

function permitsJustPersistedGeneratorRemoval(runId: string): boolean {
	const capability = justPersistedGeneratorRemovalContext.getStore();
	return (
		capability !== undefined &&
		capability.runId === runId &&
		justPersistedGeneratorRemovalCapabilities.has(capability)
	);
}

function errorDetail(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Apply maps only the two non-resumable persisted-plan failure contracts. */
function isInvalidNonResumablePersistedRunError(
	error: unknown,
	runId: string,
): error is Error {
	return (
		error instanceof Error &&
		(error.message ===
			'dbsp transition run plan row is invalid and non-resumable' ||
			error.message ===
				`dbsp transition run ${runId} has no persisted proven plan and is non-resumable`)
	);
}

class RecordedPlanDigestMismatchError extends Error {
	constructor(
		detail = 'persisted generator plan digest does not match the recorded review',
	) {
		super(detail);
		this.name = 'RecordedPlanDigestMismatchError';
	}
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
		'non-replayable-generator-run',
		35,
		'generator removal runs require a fresh no-argument apply against live state',
	],
	[
		'selection-incomplete',
		63,
		'reviewed optional actions were not selected exactly before execution',
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
	[
		'recovery-required',
		64,
		'an admitted non-transactional claim remains open; run recover with the reported claim reference',
	],
	[
		'transport-ambiguous',
		65,
		'an admitted operation has an ambiguous transport outcome; reconcile the run before retrying',
	],
	['database-read-only', 34, 'target cannot accept managed writes'],
	[
		'destructive-authority-refused',
		59,
		'a live destructive authority did not permit the generated mutation',
	],
	[
		'adoption-refused',
		62,
		'a declared adoption no longer matches the live object reviewed for admission',
	],
	[
		'readdress-unsupported',
		60,
		'declared re-addressing is supported only for tables in one database; declare the move as a retirement and a creation',
	],
	[
		'readdress-refused',
		61,
		'declared re-addressing could not verify its source identity or target vacancy',
	],
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
	| 'run-busy'
	| 'plan-digest-required'
	| 'non-replayable-generator-run'
	| 'policy-invalid'
	| 'apply-failed'
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
	if (result.unresolvedOutcome) return result.unresolvedOutcome.kind;
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

type CoreApplyCommandResult = {
	readonly outcome: Exclude<
		ApplyOutcome,
		| 'run-busy'
		| 'plan-digest-required'
		| 'non-replayable-generator-run'
		| 'policy-invalid'
		| 'apply-failed'
	>;
	readonly runId: string;
	readonly result: ApplyResult;
	readonly refusal?: PreAppendRefusal;
};

type GeneratorApplyCommandResult = {
	readonly [Outcome in GeneratorExecutionResult['outcome']]: {
		readonly outcome: Outcome;
		readonly runId: string;
		readonly result: Extract<
			GeneratorExecutionResult,
			{ readonly outcome: Outcome }
		>;
		readonly refusal?: PreAppendRefusal;
	};
}[GeneratorExecutionResult['outcome']];

function generatorApplyCommandResult(
	execution: GeneratorExecutionResult,
	runId: string,
	refusal: PreAppendRefusal | undefined,
): GeneratorApplyCommandResult {
	const fields = refusal === undefined ? {} : { refusal };
	switch (execution.outcome) {
		case 'completed':
			return {
				outcome: execution.outcome,
				runId,
				result: execution,
				...fields,
			};
		case 'partially-applied':
			return {
				outcome: execution.outcome,
				runId,
				result: execution,
				...fields,
			};
		case 'selection-incomplete':
			return {
				outcome: execution.outcome,
				runId,
				result: execution,
				...fields,
			};
		case 'adoption-refused':
			return {
				outcome: execution.outcome,
				runId,
				result: execution,
				...fields,
			};
		case 'readdress-unsupported':
			return {
				outcome: execution.outcome,
				runId,
				result: execution,
				...fields,
			};
		case 'readdress-refused':
			return {
				outcome: execution.outcome,
				runId,
				result: execution,
				...fields,
			};
		case 'destructive-authority-refused':
			return {
				outcome: execution.outcome,
				runId,
				result: execution,
				...fields,
			};
		case 'prior-step-events-refusal':
			return {
				outcome: execution.outcome,
				runId,
				result: execution,
				...fields,
			};
		case 'recovery-required':
			return {
				outcome: execution.outcome,
				runId,
				result: execution,
				...fields,
			};
		case 'transport-ambiguous':
			return {
				outcome: execution.outcome,
				runId,
				result: execution,
				...fields,
			};
		case 'execution-failed':
			return {
				outcome: execution.outcome,
				runId,
				result: execution,
				...fields,
			};
	}
}

type ApplyHumanResult =
	| (ApplyCommandResult & {
			readonly refusal?: PreAppendRefusal | RecordedPlanRefusal;
	  })
	| {
			readonly outcome: string;
			readonly runId: string;
			readonly refusal?: PreAppendRefusal | RecordedPlanRefusal;
	  };

export function formatApplyHuman(result: ApplyHumanResult): string {
	const line = `${result.outcome}: ${result.runId}`;
	if (result.refusal) {
		if ('address' in result.refusal)
			return formatPreAppendRefusalHuman(line, result.refusal);
		return [
			line,
			`refusal: ${escapeDiagnosticText(result.refusal.cause)}`,
			`state: ${escapeDiagnosticText(result.refusal.state)}`,
			`withheld authority: ${escapeDiagnosticText(result.refusal.withheldAuthority)}`,
			`resolving command: ${escapeDiagnosticText(result.refusal.resolvingCommand)}`,
		].join('\n');
	}
	if (!('result' in result)) return line;
	if ('assessment' in result.result) {
		if (result.result.unresolvedOutcome) {
			const unresolved = result.result.unresolvedOutcome;
			return unresolved.kind === 'recovery-required'
				? [
						line,
						`claim: ${escapeDiagnosticText(unresolved.claimId)}`,
						`detail: ${escapeDiagnosticText(unresolved.detail)}`,
						`resolving command: dbsp reconcile --db <database> ${escapeDiagnosticText(result.runId)}`,
					].join('\n')
				: [
						line,
						`detail: ${escapeDiagnosticText(unresolved.detail)}`,
						`resolving command: dbsp reconcile --db <database> ${escapeDiagnosticText(result.runId)}`,
					].join('\n');
		}
		if (result.outcome !== 'plan-digest-mismatch') return line;
		const detail = result.result.assessment.reasons[0]?.detail;
		return detail ? `${line}\n${detail}` : line;
	}
	const execution = result.result;
	switch (execution.outcome) {
		case 'completed':
			return line;
		case 'recovery-required':
			return [
				line,
				`claim: ${escapeDiagnosticText(execution.claimId)}`,
				`detail: ${escapeDiagnosticText(execution.detail)}`,
				`resolving command: dbsp reconcile --db <database> ${escapeDiagnosticText(result.runId)}`,
			].join('\n');
		case 'transport-ambiguous':
			return [
				line,
				`detail: ${escapeDiagnosticText(execution.detail)}`,
				`resolving command: dbsp reconcile --db <database> ${escapeDiagnosticText(result.runId)}`,
			].join('\n');
		case 'partially-applied':
		case 'selection-incomplete':
		case 'adoption-refused':
		case 'readdress-unsupported':
		case 'readdress-refused':
		case 'destructive-authority-refused':
		case 'execution-failed':
			return `${line}\ndetail: ${escapeDiagnosticText(execution.detail)}`;
		case 'prior-step-events-refusal':
			return [
				line,
				`detail: ${escapeDiagnosticText(execution.detail)}`,
				`resolving command: dbsp reconcile --db <database> ${escapeDiagnosticText(result.runId)}`,
			].join('\n');
	}
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

type RecordedPlanRefusal = {
	readonly cause: string;
	readonly state: 'recorded-plan';
	readonly withheldAuthority: string;
	readonly resolvingCommand: string;
};

function recordedPlanRefusal(): RecordedPlanRefusal {
	return { ...REFUSAL_VOCABULARY['ERR-10'], state: 'recorded-plan' };
}

export type ApplyCommandResult = (
	| CoreApplyCommandResult
	| GeneratorApplyCommandResult
	| {
			readonly outcome: 'run-busy' | 'plan-digest-required';
			readonly runId: string;
	  }
	| {
			/** ERR-10: a removal-bearing generator run cannot be replayed by id. */
			readonly outcome: 'non-replayable-generator-run';
			readonly runId: string;
			readonly refusal: RecordedPlanRefusal;
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

function isGeneratorPlan(plan: unknown): plan is GeneratorDurablePlan {
	return (
		plan !== undefined &&
		plan !== null &&
		typeof plan === 'object' &&
		'generator' in plan &&
		(plan as { generator?: { kind?: unknown } }).generator?.kind ===
			'schema-differ-generator'
	);
}

/** Every mapped command refusal needs a real plan address; never invent one. */
function firstPlanAddress(plan: unknown): LedgerAddress | undefined {
	if (plan === null || typeof plan !== 'object' || !('steps' in plan))
		return undefined;
	const steps = (plan as { readonly steps?: unknown }).steps;
	if (!Array.isArray(steps)) return undefined;
	for (const step of steps) {
		if (step === null || typeof step !== 'object') continue;
		const candidate = step as {
			readonly managedClaim?: { readonly address?: LedgerAddress };
			readonly address?: LedgerAddress;
			readonly closure?: { readonly root?: LedgerAddress };
		};
		const address =
			candidate.managedClaim?.address ??
			candidate.address ??
			candidate.closure?.root;
		if (address) return address;
	}
	return undefined;
}

function applyPreAppendRefusal(
	outcome: ApplyOutcome,
	plan: unknown,
	result?: ApplyResult,
): PreAppendRefusal | undefined {
	const address = firstPlanAddress(plan);
	if (!address) return undefined;
	if (outcome === 'transactional-only-refusal')
		return preAppendRefusalFor('ERR-01', { address, state: 'unknown' });
	if (outcome === 'database-read-only')
		return preAppendRefusalFor('ERR-07', { address, state: 'unknown' });
	if (
		outcome === 'execution-contract-refused' &&
		result?.assessment.reasons[0]?.detail?.startsWith(
			'managed-ledger-not-current:',
		)
	)
		return preAppendRefusalFor('ERR-03', { address, state: 'unknown' });
	if (outcome === 'destructive-authority-refused')
		return preAppendRefusalFor('ERR-04', { address, state: 'managed' });
	if (outcome === 'adoption-refused')
		return preAppendRefusalFor('ERR-02', { address, state: 'unknown' });
	return undefined;
}

export type ApplyConfirmation = (
	runId: string,
	planDigest: string,
) => Promise<boolean>;

/** Rendering is injected so the public pipeline can prove presentation precedes consent. */
export type ApplyPlanPresenter = (plan: PlanResult) => void;

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
	present: ApplyPlanPresenter = () => undefined,
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
	// The transition planner intentionally has no removal mapping.  The live
	// schema differ is therefore only a bridge for that exact unsupported
	// comparison.  A capability refusal, no-drift result, or inapplicable plan
	// retains its own meaning and must never become generated DDL.
	const isUnsupportedRemoval =
		plan.proveKind === 'blocked' &&
		plan.compareKind === 'unsupported' &&
		plan.assessment.decision === 'blocked' &&
		plan.assessment.reasons.length === 1 &&
		plan.assessment.reasons[0]?.code === 'unsupported-transition';
	const effectivePlan = isUnsupportedRemoval
		? await runGeneratorPlan({
				db: options.db,
				schemaFile: options.schemaFile,
				...(options.schema === undefined ? {} : { schema: options.schema }),
				dryRun: options.dryRun === true,
			})
		: plan;
	if (options.dryRun === true)
		return {
			outcome: 'dry-run',
			plan: effectivePlan,
			runId: null,
			planDigest: null,
		};
	if (
		effectivePlan.proveKind !== 'proven' ||
		effectivePlan.persisted !== true ||
		!effectivePlan.runId ||
		!effectivePlan.planDigest
	) {
		// A blocked/no-drift plan has no executable durable record. Its existing
		// presentation is the complete result; do not invent an apply attempt.
		return {
			outcome: 'not-executable',
			plan: effectivePlan,
			runId: effectivePlan.runId,
			planDigest: effectivePlan.planDigest,
		};
	}
	const runId = effectivePlan.runId;
	const planDigest = effectivePlan.planDigest;
	// Persisted material is shown before any confirmation requirement or prompt.
	present(effectivePlan);
	if (options.yes !== true && process.stdin.isTTY !== true) {
		return {
			outcome: 'confirmation-required',
			plan: effectivePlan,
			runId: effectivePlan.runId,
			planDigest: effectivePlan.planDigest,
		};
	}
	if (options.yes !== true && !(await confirm(runId, planDigest))) {
		return {
			outcome: 'confirmation-declined',
			plan: effectivePlan,
			runId: effectivePlan.runId,
			planDigest: effectivePlan.planDigest,
		};
	}
	const recordedRunOptions = Object.fromEntries(
		Object.entries(options).filter(([key]) => key !== 'schema'),
	) as ApplyOptions;
	const executeOptions = {
		...recordedRunOptions,
		planDigest: effectivePlan.planDigest,
	};
	const result = isUnsupportedRemoval
		? await justPersistedGeneratorRemovalContext.run(
				mintJustPersistedGeneratorRemovalCapability(runId),
				() => execute(runId, executeOptions),
			)
		: await execute(runId, executeOptions);
	return {
		outcome: result.outcome,
		plan: effectivePlan,
		runId: effectivePlan.runId,
		planDigest: effectivePlan.planDigest,
		result,
	};
}

async function loadOnLessor(
	target: Parameters<typeof acquireTransitionLease>[0],
	runId: string,
) {
	const lease = await acquireTransitionLease(target);
	try {
		return await readTransitionJournal(lease.session, runId, { ensure: false });
	} finally {
		await lease.release();
	}
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

async function runApplyInternal(
	runId: string,
	options: ApplyOptions,
	pool?: Pool,
): Promise<ApplyCommandResult> {
	const expectedPlanDigest = options.planDigest;
	if (!expectedPlanDigest) return { outcome: 'plan-digest-required', runId };
	if (options.schema !== undefined)
		throw new Error(
			'apply <run-id> refuses --schema: execution uses the recorded plan and context',
		);
	const policy = await effectiveApplyPolicy(options);
	const owned =
		pool === undefined ? (await createDbConnection(options.db)).pool : pool;
	// SC-52: this is deliberately before authorization, preflight, or a step
	// attempt. A persisted generator removal is reviewable, not replayable.
	let persisted: Awaited<ReturnType<typeof loadOnTarget>>;
	try {
		persisted = await loadOnLessor(createPgTransitionLessor(owned), runId);
	} catch (error) {
		if (isInvalidNonResumablePersistedRunError(error, runId)) {
			const refusal: ApplyCommandResult = {
				outcome: 'plan-digest-mismatch',
				runId,
				result: {
					assessment: {
						reasons: [{ detail: error.message }],
					},
				} as unknown as ApplyResult,
			};
			return pool === undefined
				? withPoolCleanupReported(refusal, () => owned.end())
				: refusal;
		}
		if (error instanceof TransitionRunIdentityMismatchError) {
			const refusal: ApplyCommandResult = {
				outcome: 'run-id-mismatch',
				runId,
				result: {
					assessment: {
						reasons: [{ detail: error.message }],
					},
				} as unknown as ApplyResult,
			};
			return pool === undefined
				? withPoolCleanupReported(refusal, () => owned.end())
				: refusal;
		}
		if (pool === undefined) {
			try {
				await owned.end();
			} catch {
				// The load failure is the primary command outcome.
			}
		}
		throw error;
	}
	if (
		persisted.run.replayability === 'non-replayable-generator-removal' &&
		!permitsJustPersistedGeneratorRemoval(runId)
	) {
		const refusal: ApplyCommandResult = {
			outcome: 'non-replayable-generator-run',
			runId,
			refusal: recordedPlanRefusal(),
		};
		return pool === undefined
			? withPoolCleanupReported(refusal, () => owned.end())
			: refusal;
	}
	let result: ApplyCommandResult;
	try {
		if (isGeneratorPlan(persisted.plan)) {
			const locked = await withPgTransitionRunLock(
				owned,
				runId,
				async (target) => {
					const current = await loadOnTarget(target, runId);
					if (!isGeneratorPlan(current.plan))
						throw new Error(
							'persisted run no longer contains a generator plan',
						);
					const recordedSchema = current.plan.generator.planningSchema;
					if (!recordedSchema)
						throw new Error(
							'persisted generator run has no recorded planning schema and is non-resumable',
						);
					let actualDigest: string;
					try {
						actualDigest = transitionPlanDigest(current.plan);
					} catch (error) {
						// Persisted generator material is hostile input at apply. The
						// digest boundary must refuse it rather than let parser detail
						// escape as a command exception.
						throw new RecordedPlanDigestMismatchError(
							`persisted generator manifest is invalid: ${errorDetail(error)}`,
						);
					}
					if (
						actualDigest !== current.run.planDigest ||
						actualDigest !== expectedPlanDigest
					)
						throw new RecordedPlanDigestMismatchError();
					const manifest = validateNormalizedManagedStepManifest(
						current.plan.steps as unknown as readonly NormalizedManagedStep[],
					);
					if (!manifest.ok)
						throw new RecordedPlanDigestMismatchError(
							`persisted generator manifest is invalid: ${manifest.detail}`,
						);
					const lifecycleError = persistedLifecycleDirectiveError(
						manifest.manifest.steps,
					);
					if (lifecycleError)
						throw new RecordedPlanDigestMismatchError(
							`persisted generator manifest is invalid: ${lifecycleError}`,
						);
					if (
						await generatorRunRequiresRecovery(
							target,
							current,
							manifest.manifest.steps,
						)
					)
						return {
							outcome: 'prior-step-events-refusal' as const,
							detail:
								'run has prior generator step-attempt events; run dbsp recover instead',
						};
					return executeGeneratorPlan({
						pool: owned,
						run: lockPgJournalRun(mintDurablyLoadedRun(current.run)),
						manifest: manifest.manifest,
						planDigest: actualDigest,
						schema: recordedSchema,
						approval: { approvals: policy.accepts },
						recordAttempt: async (executionId) => {
							const journalLease =
								await acquireExclusiveTransitionLease(target);
							try {
								await appendIntentJournal(journalLease.session, {
									runId: current.run.runId,
									run: current.run,
									executionId,
									stepId: `dbsp.generator.attempt:${executionId}`,
									operation: {
										...GENERATOR_ATTEMPT_OPERATION,
										payload: { executionId },
									},
									recordedAt: new Date().toISOString(),
								});
							} finally {
								await journalLease.release();
							}
						},
						...(options.replace === undefined
							? {}
							: { replaces: options.replace }),
						runId,
					});
				},
			);
			if (locked.kind === 'busy') result = { outcome: 'run-busy', runId };
			else {
				const execution = locked.value;
				const defaultRefusal = applyPreAppendRefusal(
					execution.outcome as ApplyOutcome,
					persisted.plan,
				);
				const withheldAuthority =
					execution.outcome === 'destructive-authority-refused'
						? (execution.refusal?.withheldAuthority ??
							(execution.detail.includes('operator acceptance')
								? 'destructive operator acceptance authority'
								: execution.detail.includes('ledger lineage')
									? 'destructive ledger lineage authority'
									: undefined))
						: undefined;
				const preAppendRefusal =
					defaultRefusal === undefined || withheldAuthority === undefined
						? defaultRefusal
						: {
								...defaultRefusal,
								refusal: {
									...defaultRefusal.refusal,
									withheldAuthority,
								},
							};
				result = generatorApplyCommandResult(
					execution,
					runId,
					preAppendRefusal,
				);
			}
		} else {
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
								return {
									ok: false,
									kind: 'refused' as const,
									detail: currency,
								};
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
								process.env.USER ??
								process.env.LOGNAME ??
								'unknown-local-actor';
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
			if (locked.kind === 'busy') result = { outcome: 'run-busy', runId };
			else {
				const outcome = outcomeForApplyResult(locked.value);
				const preAppendRefusal = applyPreAppendRefusal(
					outcome,
					persisted.plan,
					locked.value,
				);
				result = {
					outcome,
					runId,
					result: locked.value,
					...(preAppendRefusal === undefined
						? {}
						: { refusal: preAppendRefusal }),
				};
			}
		}
	} catch (error) {
		if (error instanceof RecordedPlanDigestMismatchError) {
			result = {
				outcome: 'plan-digest-mismatch',
				runId,
				result: {
					assessment: {
						reasons: [{ detail: error.message }],
					},
				} as unknown as ApplyResult,
			};
		} else {
			if (pool === undefined) {
				try {
					await owned.end();
				} catch {
					// The primary failure remains the command failure.
				}
			}
			throw error;
		}
	}
	if (pool === undefined) {
		return withPoolCleanupReported(result, () => owned.end());
	}
	return result;
}

/** Public durable apply surface: it never accepts the private replay bridge. */
export async function runApply(
	runId: string,
	options: ApplyOptions,
	pool?: Pool,
): Promise<ApplyCommandResult> {
	return runApplyInternal(runId, options, pool);
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
	.option('--schema <name>', 'Database schema name for no-argument apply')
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
		'--replace <address>',
		'Replace exactly this address when the presented plan requested it; repeatable',
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
				result = await runNoArgumentApply(
					options,
					confirmNoArgumentApply,
					runApply,
					options.format === 'json'
						? () => undefined
						: (plan) =>
								console.log(formatPlanHuman(plan, options.dryRun === true)),
				);
			} catch (error) {
				result = {
					error: error instanceof Error ? error.message : String(error),
				};
			}
			if ('error' in result) {
				if (options.format === 'json')
					printCliJson({ outcome: 'apply-failed', ...result });
				else console.error(`❌ ${escapeDiagnosticText(result.error)}`);
				process.exitCode = exitCodeForApplyOutcome('apply-failed');
				return;
			}
			const exitCode =
				result.outcome === 'dry-run' || result.outcome === 'not-executable'
					? exitCodeForPlanResult(result.plan)
					: exitCodeForApplyOutcome(result.outcome);
			if (options.format === 'json') {
				printCliJson({
					outcome: result.outcome,
					exitCode,
					plan: formatPlanJson(result.plan, options.dryRun === true),
					...(result.runId === null ? {} : { runId: result.runId }),
					...(result.planDigest === null
						? {}
						: { planDigest: result.planDigest }),
					...('result' in result ? { apply: result.result } : {}),
				});
			} else {
				if (result.outcome === 'dry-run' || result.outcome === 'not-executable')
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
		if (options.format === 'json') printCliJson(document);
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
