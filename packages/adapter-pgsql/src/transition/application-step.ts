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
	readPgOutcomeSessionCompromise,
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

export type PgPlannedApplicationStep =
	| {
			readonly kind: 'application-step';
			readonly id: string;
			readonly step: 'once';
	  }
	| {
			readonly kind: 'application-step';
			readonly id: string;
			readonly step: 'assert';
			readonly inspected: boolean;
	  };

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
		const kind = step.kind;
		const id = step.id;
		const digest = step.digest;
		const scope = step.scope;
		const phase = step.phase;
		const lockTimeoutMs = step.lockTimeoutMs;
		const statementTimeoutMs = step.statementTimeoutMs;
		const apply = step.apply;
		const inspect = step.inspect;
		if (kind !== 'once' && kind !== 'assert')
			throw new PgApplicationStepError(
				'application-step-failed',
				'',
				'converge step kind is invalid',
			);
		if (typeof id !== 'string' || id.length === 0)
			throw new PgApplicationStepError(
				'application-step-failed',
				'',
				'converge step id must be a non-empty string',
			);
		if (ids.has(id))
			throw new PgApplicationStepError(
				'application-step-failed',
				'',
				'converge step ids must be unique',
			);
		ids.add(id);
		if (typeof digest !== 'string' || digest.length === 0)
			throw new PgApplicationStepError(
				'application-step-failed',
				'',
				'converge step digest must be a non-empty string',
			);
		if (scope !== undefined && scope !== 'schema')
			throw new PgApplicationStepError(
				'application-step-failed',
				'',
				'converge step scope must be schema',
			);
		if (phase !== 'before-generated-ddl' && phase !== 'after-generated-ddl')
			throw new PgApplicationStepError(
				'application-step-failed',
				'',
				'converge step phase is invalid',
			);
		for (const timeout of [lockTimeoutMs, statementTimeoutMs])
			if (
				timeout !== undefined &&
				(!Number.isSafeInteger(timeout) ||
					(timeout as number) < 1 ||
					(timeout as number) > 2_147_483_647)
			)
				throw new PgApplicationStepError(
					'application-step-failed',
					'',
					'converge step timeout must be a safe integer from 1 to 2147483647 milliseconds',
				);
		if (typeof apply !== 'function')
			throw new PgApplicationStepError(
				'application-step-failed',
				'',
				'converge step apply must be a function',
			);
		if (kind === 'assert' && typeof inspect !== 'function')
			throw new PgApplicationStepError(
				'application-step-failed',
				'',
				'converge assert inspect must be a function',
			);
		return kind === 'once'
			? {
					kind: 'once',
					id,
					digest,
					...(scope === undefined ? {} : { scope: 'schema' }),
					phase,
					...(lockTimeoutMs === undefined
						? {}
						: { lockTimeoutMs: lockTimeoutMs as number }),
					...(statementTimeoutMs === undefined
						? {}
						: { statementTimeoutMs: statementTimeoutMs as number }),
					apply: apply as PgConvergeOnceStep['apply'],
				}
			: {
					kind: 'assert',
					id,
					digest,
					...(scope === undefined ? {} : { scope: 'schema' }),
					phase,
					...(lockTimeoutMs === undefined
						? {}
						: { lockTimeoutMs: lockTimeoutMs as number }),
					...(statementTimeoutMs === undefined
						? {}
						: { statementTimeoutMs: statementTimeoutMs as number }),
					inspect: inspect as PgConvergeAssertStep['inspect'],
					apply: apply as PgConvergeAssertStep['apply'],
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

function isRecordedOnce(
	payload: LedgerPayload | undefined,
	step: PgConvergeOnceStep,
): boolean {
	const value = payload?.value;
	return Boolean(
		value &&
			typeof value === 'object' &&
			!Array.isArray(value) &&
			payload.digest === step.digest &&
			(value as Record<string, unknown>).id === step.id &&
			(value as Record<string, unknown>).digest === step.digest &&
			(value as Record<string, unknown>).step === 'once',
	);
}

const APPLICATION_STEP_TRANSACTION_CONTROL_MESSAGE =
	'application step transaction control is refused';
const APPLICATION_STEP_TX_REVOKED_MESSAGE =
	'application step transaction facade is no longer active';

function skipSqlWhitespaceAndComments(text: string, offset = 0): number {
	let index = offset;
	while (true) {
		while (index < text.length && /[ \t\n\r\f\v]/u.test(text[index]!))
			index += 1;
		if (text.startsWith('--', index)) {
			const lineEnd = text.slice(index + 2).search(/[\r\n]/u);
			index = lineEnd === -1 ? text.length : index + 2 + lineEnd;
			continue;
		}
		if (!text.startsWith('/*', index)) return index;
		index += 2;
		let depth = 1;
		while (index < text.length && depth > 0) {
			if (text.startsWith('/*', index)) {
				depth += 1;
				index += 2;
			} else if (text.startsWith('*/', index)) {
				depth -= 1;
				index += 2;
			} else index += 1;
		}
	}
}

function readSqlKeyword(
	text: string,
	offset = 0,
): { readonly keyword: string; readonly end: number } | undefined {
	const start = skipSqlWhitespaceAndComments(text, offset);
	const match =
		/^[A-Za-z_\u0080-\u{10FFFF}][A-Za-z0-9_$\u0080-\u{10FFFF}]*/u.exec(
			text.slice(start),
		);
	return match === null
		? undefined
		: { keyword: match[0].toUpperCase(), end: start + match[0].length };
}

function refusesApplicationStepTransactionControl(text: string): boolean {
	const first = readSqlKeyword(text);
	const keyword = first?.keyword;
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
		].includes(keyword)
	)
		return true;
	if (first?.keyword !== 'SET') return false;
	let next = readSqlKeyword(text, first.end);
	if (next?.keyword === 'LOCAL') next = readSqlKeyword(text, next.end);
	if (next?.keyword === 'TRANSACTION') return true;
	if (next?.keyword === 'SESSION') {
		const afterSession = readSqlKeyword(text, next.end);
		return (
			afterSession?.keyword === 'TRANSACTION' ||
			afterSession?.keyword === 'CHARACTERISTICS'
		);
	}
	return false;
}

interface RevocablePgApplicationStepTx extends PgApplicationStepTx {
	revoke(): void;
}

function createRevocablePgApplicationStepTx(
	client: PoolClient,
): RevocablePgApplicationStepTx {
	let active = true;
	return {
		query: (text: string, values?: readonly unknown[]) => {
			if (!active)
				return Promise.reject(new Error(APPLICATION_STEP_TX_REVOKED_MESSAGE));
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
		revoke: () => {
			active = false;
		},
	};
}

export function createPgApplicationStepTx(
	client: PoolClient,
): PgApplicationStepTx {
	return createRevocablePgApplicationStepTx(client);
}

async function withPgApplicationStepTx<T>(
	client: PoolClient,
	callback: (tx: PgApplicationStepTx) => Promise<T> | T,
	onCallback?: () => void,
): Promise<T> {
	const tx = createRevocablePgApplicationStepTx(client);
	try {
		onCallback?.();
		return await callback(tx);
	} finally {
		tx.revoke();
	}
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
		!isRecordedOnce(projection.declaration, step)
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
		if (
			step.kind === 'once' &&
			projection.stableState === 'managed' &&
			isRecordedOnce(projection.declaration, step)
		)
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
	client: PoolClient,
	onCallback?: () => void,
): Promise<'healthy' | 'unhealthy'> {
	let status: unknown;
	try {
		status = await withPgApplicationStepTx(
			client,
			(tx) => step.inspect(tx),
			onCallback,
		);
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

function assertPgApplicationStepSessionHealthy(
	client: PoolClient,
	step: PgConvergeApplicationStep,
): void {
	if (readPgOutcomeSessionCompromise(client))
		throw new PgApplicationStepError(
			'application-step-failed',
			step.id,
			'application step rollback left the session outcome unknown',
		);
}

async function setPgApplicationStepStatementTimeout(
	client: PoolClient,
	timeout: number | undefined,
): Promise<void> {
	if (timeout === undefined) return;
	await client.query(`SET LOCAL statement_timeout = '${timeout}ms'`);
}

async function setPgApplicationStepSearchPath(
	client: PoolClient,
	schema: string,
): Promise<void> {
	await client.query(
		"SELECT pg_catalog.set_config('search_path', pg_catalog.quote_ident($1) || ', ' || pg_catalog.current_setting('search_path'), true)",
		[schema],
	);
}

async function admitPgApplicationStepsDuringPlanning(
	input: {
		readonly client: PoolClient;
		readonly database: string;
		readonly schema: string;
	},
	steps: readonly PgConvergeApplicationStep[],
): Promise<ReadonlySet<string>> {
	let begun = false;
	let completed = false;
	const pendingOnceIds = new Set<string>();
	if (steps.length === 0) return pendingOnceIds;
	try {
		await input.client.query('BEGIN READ ONLY');
		begun = true;
		for (const step of steps) {
			const state = await admission(
				input.client,
				input.database,
				input.schema,
				step,
			);
			if (step.kind === 'once' && !state.complete) pendingOnceIds.add(step.id);
		}
		completed = true;
		return pendingOnceIds;
	} finally {
		if (begun) {
			await rollbackPgOutcomeGroup(input.client);
			if (completed)
				assertPgApplicationStepSessionHealthy(input.client, steps.at(-1)!);
		}
	}
}

async function inspectPgApplicationStepDuringPlanning(
	input: {
		readonly client: PoolClient;
		readonly schema: string;
		readonly onApplicationStepCallback?: () => void;
	},
	step: PgConvergeAssertStep,
): Promise<'healthy' | 'unhealthy'> {
	let begun = false;
	let completed = false;
	try {
		await beginPgOutcome(input.client, step.lockTimeoutMs, 'BEGIN READ ONLY');
		begun = true;
		await setPgApplicationStepStatementTimeout(
			input.client,
			step.statementTimeoutMs,
		);
		await setPgApplicationStepSearchPath(input.client, input.schema);
		const status = await inspectPgApplicationStep(
			step,
			input.client,
			input.onApplicationStepCallback,
		);
		completed = true;
		return status;
	} finally {
		if (begun) {
			await rollbackPgOutcomeGroup(input.client);
			if (completed) assertPgApplicationStepSessionHealthy(input.client, step);
		}
	}
}

/** Reads no durable state in check mode beyond the chain itself. */
export async function planPgApplicationSteps(input: {
	readonly client: PoolClient;
	readonly database: string;
	readonly schema: string;
	readonly steps: readonly PgConvergeApplicationStep[];
	readonly hasPendingGeneratedWork?: boolean;
	readonly check?: boolean;
	readonly onApplicationStepCallback?: () => void;
}): Promise<readonly PgPlannedApplicationStep[]> {
	const pendingOnceIds = await admitPgApplicationStepsDuringPlanning(
		input,
		input.steps,
	);
	const planned: PgPlannedApplicationStep[] = [];
	const deferAssertInspection =
		input.hasPendingGeneratedWork === true || pendingOnceIds.size > 0;
	let unhealthyAssertFound = false;
	for (const step of input.steps) {
		if (step.kind === 'once') {
			if (pendingOnceIds.has(step.id))
				planned.push({ kind: 'application-step', id: step.id, step: 'once' });
			continue;
		}
		if (deferAssertInspection || unhealthyAssertFound) {
			if (input.check)
				planned.push({
					kind: 'application-step',
					id: step.id,
					step: 'assert',
					inspected: false,
				});
			continue;
		}
		if (
			(await inspectPgApplicationStepDuringPlanning(input, step)) ===
			'unhealthy'
		) {
			unhealthyAssertFound = true;
			planned.push({
				kind: 'application-step',
				id: step.id,
				step: 'assert',
				inspected: true,
			});
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
	readonly onApplicationStepCallback?: () => void;
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
			await setPgApplicationStepSearchPath(input.client, input.schema);
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
				assertPgApplicationStepSessionHealthy(input.client, step);
				continue;
			}
			if (
				step.kind === 'assert' &&
				(await inspectPgApplicationStep(
					step,
					input.client,
					input.onApplicationStepCallback,
				)) === 'healthy'
			) {
				await rollbackPgOutcomeGroup(input.client);
				begun = false;
				assertPgApplicationStepSessionHealthy(input.client, step);
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
			await withPgApplicationStepTx(
				input.client,
				(tx) => step.apply(tx),
				input.onApplicationStepCallback,
			);
			if (
				step.kind === 'assert' &&
				(await inspectPgApplicationStep(
					step,
					input.client,
					input.onApplicationStepCallback,
				)) !== 'healthy'
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
