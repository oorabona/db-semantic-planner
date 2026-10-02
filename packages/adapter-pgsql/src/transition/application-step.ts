import { randomUUID } from 'node:crypto';
import {
	outcomeClaimEventId,
	outcomeClaimId,
	projectLedgerChain,
} from '@dbsp/core';
import { admitOutcomeClaim } from '@dbsp/core/internal';
import type { LedgerAddress, LedgerHome, LedgerPayload } from '@dbsp/types';
import type { PoolClient, QueryConfig } from 'pg';
import {
	type OwnedCheckState,
	renderOwnedTableChecksInScratchScope,
} from '../expression-canonicalizer.js';
import { createPgAdapter, type PgRollbackOnlyScope } from '../pgsql-adapter.js';
import { readPgLedgerAddressChain } from './chain-reader.js';
import type { TransitionJournalQueryable } from './journal.js';
import {
	acquirePgLedgerLocks,
	appendPgLedgerClaim,
	appendPgLedgerResolution,
} from './ledger.js';
import {
	beginPgOutcomeTransaction,
	commitPgOutcome,
	markPgOutcomeSessionCompromisedAfterCleanup,
	PgCommitAcknowledgementAmbiguousError,
	readPgOutcomeSessionCompromise,
	rollbackPgOutcomeGroup,
	setPgTransitionLockTimeout,
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
}

export interface PgConvergeOnceStep extends PgConvergeApplicationStepBase {
	readonly kind: 'once';
	readonly apply: (tx: PgApplicationStepTx) => Promise<void> | void;
}

export interface PgConvergeAssertOwnership {
	readonly checks?: readonly {
		readonly table: string;
		readonly name: string;
	}[];
	readonly columnTypes?: readonly {
		readonly table: string;
		readonly column: string;
	}[];
	readonly indexes?: readonly {
		readonly table: string;
		readonly name: string;
	}[];
}

export type PgOwnedCheckState = OwnedCheckState;

export interface PgApplicationStepOwnedState {
	readonly checks: readonly {
		readonly table: string;
		readonly name: string;
		readonly physicalTable: string;
		readonly physicalName: string;
		readonly state: PgOwnedCheckState;
	}[];
}

/** Resolved by converge from the model; internal to the PostgreSQL adapter. */
export interface PgApplicationStepResolvedOwnedCheck {
	readonly table: string;
	readonly name: string;
	readonly physicalTable: string;
	readonly physicalName: string;
	readonly expression: string;
}

export interface PgConvergeAssertStep extends PgConvergeApplicationStepBase {
	readonly kind: 'assert';
	/** Declaration surfaces maintained by this assertion rather than converge. */
	readonly owns?: PgConvergeAssertOwnership;
	readonly inspect: (
		tx: PgApplicationStepTx,
		owned: PgApplicationStepOwnedState,
	) => Promise<'healthy' | 'unhealthy'> | 'healthy' | 'unhealthy';
	readonly apply: (
		tx: PgApplicationStepTx,
		owned: PgApplicationStepOwnedState,
	) => Promise<void> | void;
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
		options?: ErrorOptions,
	) {
		super(detail, options);
		this.name = 'PgApplicationStepError';
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value))
		return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function validateOwns(owns: unknown): PgConvergeAssertOwnership {
	if (!isPlainObject(owns))
		throw new PgApplicationStepError(
			'application-step-failed',
			'',
			'converge assert owns must be a plain object',
		);
	const allowed = new Set(['checks', 'columnTypes', 'indexes']);
	if (
		!Reflect.ownKeys(owns).every(
			(key) => typeof key === 'string' && allowed.has(key),
		)
	)
		throw new PgApplicationStepError(
			'application-step-failed',
			'',
			'converge assert owns has an unknown key',
		);

	const normalized: {
		checks: { table: string; name: string }[];
		columnTypes: { table: string; column: string }[];
		indexes: { table: string; name: string }[];
	} = { checks: [], columnTypes: [], indexes: [] };
	for (const [surface, fields] of [
		['checks', ['table', 'name']],
		['columnTypes', ['table', 'column']],
		['indexes', ['table', 'name']],
	] as const) {
		if (!Object.hasOwn(owns, surface)) continue;
		const entries = owns[surface];
		if (entries === undefined) continue;
		if (!Array.isArray(entries))
			throw new PgApplicationStepError(
				'application-step-failed',
				'',
				`converge assert owns.${surface} must be an array`,
			);
		for (const entry of entries) {
			const hasRequiredEnumerableFields =
				isPlainObject(entry) &&
				Reflect.ownKeys(entry).length === fields.length &&
				fields.every((field) =>
					Object.prototype.propertyIsEnumerable.call(entry, field),
				);
			if (!hasRequiredEnumerableFields)
				throw new PgApplicationStepError(
					'application-step-failed',
					'',
					`converge assert owns.${surface} entries must have exactly non-empty string ${fields.join(' and ')} fields`,
				);
			const values = fields.map((field) => entry[field]);
			if (
				!values.every((value) => typeof value === 'string' && value.length > 0)
			)
				throw new PgApplicationStepError(
					'application-step-failed',
					'',
					`converge assert owns.${surface} entries must have exactly non-empty string ${fields.join(' and ')} fields`,
				);
			if (surface === 'columnTypes')
				normalized.columnTypes.push({
					table: values[0] as string,
					column: values[1] as string,
				});
			else
				normalized[surface].push({
					table: values[0] as string,
					name: values[1] as string,
				});
		}
	}
	if (
		normalized.checks.length === 0 &&
		normalized.columnTypes.length === 0 &&
		normalized.indexes.length === 0
	)
		throw new PgApplicationStepError(
			'application-step-failed',
			'',
			'converge assert owns must name at least one surface',
		);
	return {
		...(normalized.checks.length === 0 ? {} : { checks: normalized.checks }),
		...(normalized.columnTypes.length === 0
			? {}
			: { columnTypes: normalized.columnTypes }),
		...(normalized.indexes.length === 0 ? {} : { indexes: normalized.indexes }),
	};
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
		const hasOwns = Object.hasOwn(step, 'owns');
		const owns = hasOwns ? step.owns : undefined;
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
		if (kind === 'once' && hasOwns)
			throw new PgApplicationStepError(
				'application-step-failed',
				'',
				'converge once steps cannot declare owns',
			);
		const validatedOwns =
			kind === 'assert' && hasOwns ? validateOwns(owns) : undefined;
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
					...(validatedOwns === undefined ? {} : { owns: validatedOwns }),
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
	owned: PgApplicationStepOwnedState,
	onCallback?: () => void,
): Promise<'healthy' | 'unhealthy'> {
	let status: unknown;
	try {
		status = await withPgApplicationStepTx(
			client,
			(tx) => step.inspect(tx, owned),
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
	client: TransitionJournalQueryable,
	timeout: number | undefined,
): Promise<void> {
	if (timeout === undefined) return;
	await client.query(`SET LOCAL statement_timeout = '${timeout}ms'`);
}

async function setPgApplicationStepSearchPath(
	client: TransitionJournalQueryable,
	schema: string,
): Promise<void> {
	await client.query(
		"SELECT pg_catalog.set_config('search_path', pg_catalog.format('%I, pg_temp, %s', $1::pg_catalog.text, pg_catalog.current_setting('search_path')), true)",
		[schema],
	);
}

function scratchScopeSession(
	scope: Pick<PgRollbackOnlyScope, 'executeRaw'>,
): TransitionJournalQueryable {
	return {
		query: async (sql, params) => ({
			rows: await scope.executeRaw(sql, params),
		}),
	};
}

function hasScratchCleanupFailure(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		Object.hasOwn(error, 'cleanupError')
	);
}

async function renderPgApplicationStepOwnedChecks(
	client: PoolClient,
	schema: string,
	step: PgConvergeAssertStep,
	checks: readonly PgApplicationStepResolvedOwnedCheck[],
	configureScope: boolean,
): Promise<PgApplicationStepOwnedState> {
	if (checks.length === 0) return { checks: [] };
	try {
		const adapter = createPgAdapter(client, {
			borrowedClient: true,
			managedTransactions: true,
		});
		const statesByPhysicalTable = await adapter.withScratchScope(
			async (scope) => {
				if (configureScope) {
					const session = scratchScopeSession(scope);
					await setPgApplicationStepSearchPath(session, schema);
					await setPgTransitionLockTimeout(session, step.lockTimeoutMs);
					await setPgApplicationStepStatementTimeout(
						session,
						step.statementTimeoutMs,
					);
				}
				const byTable = new Map<
					string,
					PgApplicationStepResolvedOwnedCheck[]
				>();
				for (const check of checks) {
					const tableChecks = byTable.get(check.physicalTable);
					if (tableChecks) tableChecks.push(check);
					else byTable.set(check.physicalTable, [check]);
				}
				const renderedByPhysicalTable = new Map<
					string,
					Map<string, PgOwnedCheckState>
				>();
				for (const [physicalTable, tableChecks] of byTable) {
					const rendered = await renderOwnedTableChecksInScratchScope(scope, {
						schema,
						physicalTable,
						checks: tableChecks.map((check) => ({
							physicalName: check.physicalName,
							expression: check.expression,
						})),
						tempPrefix: `dbsp_owned_check_${randomUUID().replaceAll('-', '')}`,
					});
					renderedByPhysicalTable.set(
						physicalTable,
						new Map(rendered.map((state) => [state.physicalName, state.state])),
					);
				}
				return renderedByPhysicalTable;
			},
		);
		return {
			checks: checks.map((check) => {
				const state = statesByPhysicalTable
					.get(check.physicalTable)
					?.get(check.physicalName);
				if (state === undefined)
					throw new Error('owned CHECK rendering omitted a requested CHECK');
				return {
					table: check.table,
					name: check.name,
					physicalTable: check.physicalTable,
					physicalName: check.physicalName,
					state,
				};
			}),
		};
	} catch (error) {
		if (hasScratchCleanupFailure(error))
			markPgOutcomeSessionCompromisedAfterCleanup(client, error);
		throw new PgApplicationStepError(
			'application-step-failed',
			step.id,
			error instanceof Error ? error.message : String(error),
			{ cause: error },
		);
	}
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
		await beginPgOutcomeTransaction(input.client, 'BEGIN READ ONLY');
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
		readonly ownedChecks?: ReadonlyMap<
			string,
			readonly PgApplicationStepResolvedOwnedCheck[]
		>;
		readonly onApplicationStepCallback?: () => void;
	},
	step: PgConvergeAssertStep,
): Promise<'healthy' | 'unhealthy'> {
	let begun = false;
	let completed = false;
	try {
		const owned = await renderPgApplicationStepOwnedChecks(
			input.client,
			input.schema,
			step,
			input.ownedChecks?.get(step.id) ?? [],
			true,
		);
		await beginPgOutcomeTransaction(input.client, 'BEGIN READ ONLY');
		begun = true;
		await setPgApplicationStepSearchPath(input.client, input.schema);
		await setPgTransitionLockTimeout(input.client, step.lockTimeoutMs);
		await setPgApplicationStepStatementTimeout(
			input.client,
			step.statementTimeoutMs,
		);
		const status = await inspectPgApplicationStep(
			step,
			input.client,
			owned,
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
	readonly ownedChecks?: ReadonlyMap<
		string,
		readonly PgApplicationStepResolvedOwnedCheck[]
	>;
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
	for (const phase of [
		'before-generated-ddl',
		'after-generated-ddl',
	] as const) {
		for (const step of input.steps) {
			if (step.phase !== phase) continue;
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
	}
	return planned;
}

export async function runPgApplicationSteps(input: {
	readonly client: PoolClient;
	readonly database: string;
	readonly schema: string;
	readonly phase: PgConvergeApplicationStep['phase'];
	readonly steps: readonly PgConvergeApplicationStep[];
	readonly ownedChecks?: ReadonlyMap<
		string,
		readonly PgApplicationStepResolvedOwnedCheck[]
	>;
	readonly onApplicationStepCallback?: () => void;
}): Promise<readonly string[]> {
	const applied: string[] = [];
	for (const step of input.steps) {
		if (step.phase !== input.phase) continue;
		let begun = false;
		let commitAttempted = false;
		try {
			await beginPgOutcomeTransaction(input.client);
			begun = true;
			await setPgApplicationStepSearchPath(input.client, input.schema);
			await setPgTransitionLockTimeout(input.client, step.lockTimeoutMs);
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
				assertPgApplicationStepSessionHealthy(input.client, step);
				continue;
			}
			const owned =
				step.kind === 'assert'
					? await renderPgApplicationStepOwnedChecks(
							input.client,
							input.schema,
							step,
							input.ownedChecks?.get(step.id) ?? [],
							false,
						)
					: undefined;
			if (
				step.kind === 'assert' &&
				(await inspectPgApplicationStep(
					step,
					input.client,
					owned!,
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
				(tx) =>
					step.kind === 'assert' ? step.apply(tx, owned!) : step.apply(tx),
				input.onApplicationStepCallback,
			);
			if (
				step.kind === 'assert' &&
				(await inspectPgApplicationStep(
					step,
					input.client,
					await renderPgApplicationStepOwnedChecks(
						input.client,
						input.schema,
						step,
						input.ownedChecks?.get(step.id) ?? [],
						false,
					),
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
