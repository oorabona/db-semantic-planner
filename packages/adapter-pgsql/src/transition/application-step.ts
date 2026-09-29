import { randomUUID } from 'node:crypto';
import {
	outcomeClaimEventId,
	outcomeClaimId,
	projectLedgerChain,
} from '@dbsp/core';
import { admitOutcomeClaim } from '@dbsp/core/internal';
import type { LedgerAddress, LedgerHome, LedgerPayload } from '@dbsp/types';
import type { PoolClient, QueryConfig } from 'pg';
import { readPgLedgerAddressChain } from './chain-reader.js';
import {
	acquirePgLedgerLocks,
	appendPgLedgerClaim,
	appendPgLedgerResolution,
} from './ledger.js';
import {
	beginPgOutcome,
	commitPgOutcome,
	PgCommitAcknowledgementAmbiguousError,
	rollbackPgOutcomeGroup,
} from './outcome-protocol.js';

/** The intentionally narrow query facade passed to application callbacks. */
export interface PgApplicationStepTx {
	query<Row extends Record<string, unknown> = Record<string, unknown>>(
		text: string,
		values?: readonly unknown[],
	): Promise<{ readonly rows: readonly Row[] }>;
}

interface PgConvergeApplicationStepBase {
	readonly id: string;
	readonly digest: string;
	readonly scope?: 'schema';
	readonly phase: 'before-generated-ddl' | 'after-generated-ddl';
	readonly lockTimeoutMs?: number;
	readonly statementTimeoutMs?: number;
	readonly apply: (tx: PgApplicationStepTx) => Promise<void> | void;
}

export interface PgConvergeOnceStep extends PgConvergeApplicationStepBase {
	readonly kind: 'once';
}

export interface PgConvergeAssertStep extends PgConvergeApplicationStepBase {
	readonly kind: 'assert';
	readonly inspect: (
		tx: PgApplicationStepTx,
	) => Promise<'healthy' | 'unhealthy'> | 'healthy' | 'unhealthy';
}

export type PgConvergeApplicationStep =
	| PgConvergeOnceStep
	| PgConvergeAssertStep;

export type ValidatedPgConvergeApplicationStep = PgConvergeApplicationStep;

export interface PgPlannedApplicationStep {
	readonly kind: 'application-step';
	readonly id: string;
	readonly step: 'once' | 'assert';
}

export class PgApplicationStepError extends Error {
	constructor(
		readonly refusal:
			| 'application-step-changed'
			| 'application-step-failed'
			| 'recovery-required',
		readonly stepId: string,
		detail: string,
	) {
		super(detail);
		this.name = 'PgApplicationStepError';
	}
}

/** Validate before a pool client is acquired; wording deliberately omits caller data. */
export function validatePgConvergeApplicationSteps(
	steps: unknown,
): readonly ValidatedPgConvergeApplicationStep[] {
	if (steps === undefined) return [];
	if (!Array.isArray(steps))
		throw new PgApplicationStepError(
			'application-step-failed',
			'',
			'converge steps must be an array',
		);
	const ids = new Set<string>();
	return steps.map((value) => {
		if (!value || typeof value !== 'object' || Array.isArray(value))
			throw new PgApplicationStepError(
				'application-step-failed',
				'',
				'converge step must be an object',
			);
		const step = value as Record<string, unknown>;
		if (step.kind !== 'once' && step.kind !== 'assert')
			throw new PgApplicationStepError(
				'application-step-failed',
				'',
				'converge step kind is invalid',
			);
		if (typeof step.id !== 'string' || step.id.length === 0)
			throw new PgApplicationStepError(
				'application-step-failed',
				'',
				'converge step id must be a non-empty string',
			);
		if (ids.has(step.id))
			throw new PgApplicationStepError(
				'application-step-failed',
				'',
				'converge step ids must be unique',
			);
		ids.add(step.id);
		if (typeof step.digest !== 'string' || step.digest.length === 0)
			throw new PgApplicationStepError(
				'application-step-failed',
				'',
				'converge step digest must be a non-empty string',
			);
		if (step.scope !== undefined && step.scope !== 'schema')
			throw new PgApplicationStepError(
				'application-step-failed',
				'',
				'converge step scope must be schema',
			);
		if (
			step.phase !== 'before-generated-ddl' &&
			step.phase !== 'after-generated-ddl'
		)
			throw new PgApplicationStepError(
				'application-step-failed',
				'',
				'converge step phase is invalid',
			);
		for (const timeout of ['lockTimeoutMs', 'statementTimeoutMs'] as const)
			if (
				step[timeout] !== undefined &&
				(!Number.isSafeInteger(step[timeout]) ||
					(step[timeout] as number) < 1 ||
					(step[timeout] as number) > 2_147_483_647)
			)
				throw new PgApplicationStepError(
					'application-step-failed',
					'',
					'converge step timeout must be a safe integer from 1 to 2147483647 milliseconds',
				);
		if (typeof step.apply !== 'function')
			throw new PgApplicationStepError(
				'application-step-failed',
				'',
				'converge step apply must be a function',
			);
		if (step.kind === 'assert' && typeof step.inspect !== 'function')
			throw new PgApplicationStepError(
				'application-step-failed',
				'',
				'converge assert inspect must be a function',
			);
		return step.kind === 'once'
			? {
					kind: 'once',
					id: step.id as string,
					digest: step.digest as string,
					...(step.scope === undefined ? {} : { scope: 'schema' }),
					phase: step.phase as PgConvergeOnceStep['phase'],
					...(step.lockTimeoutMs === undefined
						? {}
						: { lockTimeoutMs: step.lockTimeoutMs as number }),
					...(step.statementTimeoutMs === undefined
						? {}
						: { statementTimeoutMs: step.statementTimeoutMs as number }),
					apply: step.apply as PgConvergeOnceStep['apply'],
				}
			: {
					kind: 'assert',
					id: step.id as string,
					digest: step.digest as string,
					...(step.scope === undefined ? {} : { scope: 'schema' }),
					phase: step.phase as PgConvergeAssertStep['phase'],
					...(step.lockTimeoutMs === undefined
						? {}
						: { lockTimeoutMs: step.lockTimeoutMs as number }),
					...(step.statementTimeoutMs === undefined
						? {}
						: { statementTimeoutMs: step.statementTimeoutMs as number }),
					inspect: step.inspect as PgConvergeAssertStep['inspect'],
					apply: step.apply as PgConvergeAssertStep['apply'],
				};
	});
}

function address(database: string, schema: string, id: string): LedgerAddress {
	return {
		scope: 'schema',
		engine: 'postgresql',
		database,
		schema,
		kind: 'application-step',
		name: id,
	};
}

function home(schema: string): LedgerHome {
	return { scope: 'schema', schema };
}

function declaration(step: PgConvergeApplicationStep): LedgerPayload {
	return {
		value: { id: step.id, digest: step.digest, step: step.kind },
		digest: step.digest,
	};
}

function recordedDigest(
	payload: LedgerPayload | undefined,
): string | undefined {
	const value = payload?.value;
	return value &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		typeof (value as Record<string, unknown>).digest === 'string'
		? (value as Record<string, string>).digest
		: undefined;
}

const APPLICATION_STEP_TRANSACTION_CONTROL_MESSAGE =
	'application step transaction control is refused';

function withoutLeadingSqlComments(text: string): string {
	let remaining = text;
	while (true) {
		remaining = remaining.trimStart();
		if (remaining.startsWith('--')) {
			const lineEnd = remaining.indexOf('\n');
			remaining = lineEnd === -1 ? '' : remaining.slice(lineEnd + 1);
			continue;
		}
		if (remaining.startsWith('/*')) {
			const commentEnd = remaining.indexOf('*/', 2);
			if (commentEnd === -1) return remaining;
			remaining = remaining.slice(commentEnd + 2);
			continue;
		}
		return remaining;
	}
}

function refusesApplicationStepTransactionControl(text: string): boolean {
	const statement = withoutLeadingSqlComments(text);
	const keyword = statement.match(/^([A-Za-z]+)/)?.[1]?.toUpperCase();
	if (
		keyword &&
		[
			'BEGIN',
			'START',
			'COMMIT',
			'END',
			'ROLLBACK',
			'ABORT',
			'SAVEPOINT',
			'RELEASE',
			'PREPARE',
			'DISCARD',
		].includes(keyword)
	)
		return true;
	if (keyword !== 'SET') return false;
	return /^SET\s+(?:(?:LOCAL|SESSION)\s+)?(?:TRANSACTION\b|SESSION\s+CHARACTERISTICS\b)/iu.test(
		statement,
	);
}

export function createPgApplicationStepTx(
	client: PoolClient,
): PgApplicationStepTx {
	return {
		query: (text: string, values?: readonly unknown[]) => {
			if (refusesApplicationStepTransactionControl(text))
				return Promise.reject(
					new Error(APPLICATION_STEP_TRANSACTION_CONTROL_MESSAGE),
				);
			const query: QueryConfig<unknown[]> & {
				readonly queryMode: 'extended';
			} = {
				text,
				values: values === undefined ? [] : [...values],
				queryMode: 'extended',
			};
			return client.query(query);
		},
	};
}

async function controller(client: PoolClient) {
	const row = (
		await client.query(
			'SELECT current_user AS current_user, current_user::regrole::oid::text AS current_user_oid',
		)
	).rows[0];
	return typeof row?.current_user === 'string' &&
		typeof row?.current_user_oid === 'string'
		? { name: row.current_user, oid: row.current_user_oid }
		: undefined;
}

async function admission(
	client: PoolClient,
	database: string,
	schema: string,
	step: PgConvergeApplicationStep,
) {
	const stepAddress = address(database, schema, step.id);
	const chain = await readPgLedgerAddressChain(
		client,
		home(schema),
		stepAddress,
	);
	const projection = projectLedgerChain(chain);
	const plan = {
		claimId: outcomeClaimId(
			`application-step:${step.id}`,
			step.digest,
			stepAddress,
		),
		claimSpecies: 'application-step' as const,
		address: stepAddress,
		claimKind: 'intent' as const,
		statementBundle: { statements: [] as const },
		applicationStep: step.kind,
		declared: declaration(step),
	};
	if (projection.kind !== 'projected-ledger-chain')
		throw new PgApplicationStepError(
			'application-step-failed',
			step.id,
			'application step ledger chain is malformed',
		);
	if (projection.openClaim)
		throw new PgApplicationStepError(
			'recovery-required',
			step.id,
			'application step recovery is required',
		);
	if (
		step.kind === 'once' &&
		projection.stableState === 'managed' &&
		recordedDigest(projection.declaration) !== step.digest
	)
		throw new PgApplicationStepError(
			'application-step-changed',
			step.id,
			'application step once digest changed',
		);
	const currentController =
		projection.stableState === 'managed' ? await controller(client) : undefined;
	if (projection.stableState === 'managed') {
		if (
			!currentController ||
			chain.terminalMember?.controller !== currentController.name ||
			chain.terminalMember?.controllerOid !== currentController.oid
		)
			throw new PgApplicationStepError(
				'application-step-failed',
				step.id,
				'application step controller mismatch',
			);
	}
	const admitted = admitOutcomeClaim({
		plan,
		projection,
		...(currentController === undefined ? {} : { currentController }),
	});
	if (admitted.kind !== 'admitted-outcome-claim') {
		if (projection.openClaim)
			throw new PgApplicationStepError(
				'recovery-required',
				step.id,
				'application step recovery is required',
			);
		if (step.kind === 'once' && projection.stableState === 'managed')
			return { chain, projection, plan, complete: true as const };
		throw new PgApplicationStepError(
			'application-step-failed',
			step.id,
			admitted.reason,
		);
	}
	return { chain, projection, plan, complete: false as const };
}

async function inspectPgApplicationStep(
	step: PgConvergeAssertStep,
	tx: PgApplicationStepTx,
): Promise<'healthy' | 'unhealthy'> {
	let status: unknown;
	try {
		status = await step.inspect(tx);
	} catch (error) {
		throw new PgApplicationStepError(
			'application-step-failed',
			step.id,
			error instanceof Error ? error.message : String(error),
		);
	}
	if (status !== 'healthy' && status !== 'unhealthy')
		throw new PgApplicationStepError(
			'application-step-failed',
			step.id,
			'application step inspect returned an invalid status',
		);
	return status;
}

async function setPgApplicationStepStatementTimeout(
	client: PoolClient,
	timeout: number | undefined,
): Promise<void> {
	if (timeout === undefined) return;
	await client.query(`SET LOCAL statement_timeout = '${timeout}ms'`);
}

/** Reads no durable state in check mode beyond the chain itself. */
export async function planPgApplicationSteps(input: {
	readonly client: PoolClient;
	readonly database: string;
	readonly schema: string;
	readonly steps: readonly PgConvergeApplicationStep[];
}): Promise<readonly PgPlannedApplicationStep[]> {
	const planned: PgPlannedApplicationStep[] = [];
	for (const step of input.steps) {
		let begun = false;
		try {
			await beginPgOutcome(input.client, step.lockTimeoutMs, 'BEGIN READ ONLY');
			begun = true;
			await setPgApplicationStepStatementTimeout(
				input.client,
				step.statementTimeoutMs,
			);
			const state = await admission(
				input.client,
				input.database,
				input.schema,
				step,
			);
			const unhealthy =
				step.kind === 'assert' &&
				(await inspectPgApplicationStep(
					step,
					createPgApplicationStepTx(input.client),
				)) === 'unhealthy';
			if (!state.complete && (step.kind === 'once' || unhealthy))
				planned.push({
					kind: 'application-step',
					id: step.id,
					step: step.kind,
				});
		} finally {
			if (begun) await rollbackPgOutcomeGroup(input.client);
		}
	}
	return planned;
}

export async function runPgApplicationSteps(input: {
	readonly client: PoolClient;
	readonly database: string;
	readonly schema: string;
	readonly phase: PgConvergeApplicationStep['phase'];
	readonly steps: readonly PgConvergeApplicationStep[];
}): Promise<readonly string[]> {
	const applied: string[] = [];
	for (const step of input.steps) {
		if (step.phase !== input.phase) continue;
		let begun = false;
		let commitAttempted = false;
		try {
			await beginPgOutcome(input.client, step.lockTimeoutMs);
			begun = true;
			await setPgApplicationStepStatementTimeout(
				input.client,
				step.statementTimeoutMs,
			);
			const lock = await acquirePgLedgerLocks(input.client, [
				home(input.schema),
			]);
			if (lock.kind !== 'acquired')
				throw new Error('application step ledger lock is unavailable');
			const state = await admission(
				input.client,
				input.database,
				input.schema,
				step,
			);
			if (state.complete) {
				await rollbackPgOutcomeGroup(input.client);
				begun = false;
				continue;
			}
			const tx = createPgApplicationStepTx(input.client);
			if (
				step.kind === 'assert' &&
				(await inspectPgApplicationStep(step, tx)) === 'healthy'
			) {
				await rollbackPgOutcomeGroup(input.client);
				begun = false;
				continue;
			}
			const executionId = `application-step:${randomUUID()}`;
			const claimId = outcomeClaimId(executionId, step.id, state.plan.address);
			const claim = {
				...state.plan,
				claimId,
				executionId,
				plannedClaimKey: step.id,
				claimGroupId: claimId,
				rootClaimId: claimId,
			};
			await appendPgLedgerClaim(
				input.client,
				home(input.schema),
				{
					eventId: claimId,
					executionId,
					plannedClaimKey: step.id,
					claimGroupId: claimId,
					rootClaimId: claimId,
					address: claim.address,
					eventKind: 'intent',
					...(state.chain.terminalMember
						? { predecessor: state.chain.terminalMember.eventId }
						: {}),
					declared: claim.declared,
				},
				[
					{
						address: claim.address,
						claimKind: 'intent',
						executionId,
						rootClaimId: claimId,
						homeLedger: home(input.schema),
					},
				],
			);
			await step.apply(tx);
			if (
				step.kind === 'assert' &&
				(await inspectPgApplicationStep(step, tx)) !== 'healthy'
			)
				throw new PgApplicationStepError(
					'application-step-failed',
					step.id,
					'application step assert remained unhealthy after apply',
				);
			await appendPgLedgerResolution(
				input.client,
				home(input.schema),
				{
					eventId: outcomeClaimEventId(claimId, 'observed'),
					executionId,
					plannedClaimKey: step.id,
					claimGroupId: claimId,
					rootClaimId: claimId,
					address: claim.address,
					eventKind: 'observed',
					predecessor: claimId,
					observed: claim.declared,
				},
				claimId,
				[{ address: claim.address }],
			);
			commitAttempted = true;
			await commitPgOutcome(input.client);
			begun = false;
			applied.push(`application-step:${step.id}`);
		} catch (error) {
			if (begun && !commitAttempted) await rollbackPgOutcomeGroup(input.client);
			if (error instanceof PgCommitAcknowledgementAmbiguousError) throw error;
			if (error instanceof PgApplicationStepError) throw error;
			throw new PgApplicationStepError(
				'application-step-failed',
				step.id,
				error instanceof Error ? error.message : String(error),
			);
		}
	}
	return applied;
}
