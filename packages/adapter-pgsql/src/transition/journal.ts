import type {
	DurableIntentRecord,
	PhysicalOperation,
	StepJournal,
	TransactionalCompletionRecord,
	TransitionJournalEvent,
	TransitionJournalEventName,
	TransitionRunJournal,
	TransitionRunMetadata,
} from '@dbsp/types';
import { validateIdentifier } from '../validate.js';
import {
	DBSP_META_SCHEMA,
	DBSP_TRANSITION_JOURNAL_TABLE,
	DBSP_TRANSITION_RUN_TABLE,
} from './constants.js';

type QueryResultLike = {
	readonly rows: readonly Record<string, unknown>[];
};

export type TransitionJournalQueryable = {
	query(sql: string, params?: readonly unknown[]): Promise<QueryResultLike>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function quoteIdent(
	value: string,
	type: 'schema' | 'table' | 'column' | 'alias',
): string {
	validateIdentifier(value, type);
	return `"${value.replaceAll('"', '""')}"`;
}

function qualified(schema: string, table: string): string {
	return `${quoteIdent(schema, 'schema')}.${quoteIdent(table, 'table')}`;
}

function transitionRunTable(): string {
	return qualified(DBSP_META_SCHEMA, DBSP_TRANSITION_RUN_TABLE);
}

function transitionJournalTable(): string {
	return qualified(DBSP_META_SCHEMA, DBSP_TRANSITION_JOURNAL_TABLE);
}

export function renderCreateDbspMetaSchemaSql(): string {
	return `CREATE SCHEMA IF NOT EXISTS ${quoteIdent(DBSP_META_SCHEMA, 'schema')}`;
}

export function renderCreateTransitionRunTableSql(): string {
	return (
		`CREATE TABLE IF NOT EXISTS ${transitionRunTable()} (` +
		'run_id text PRIMARY KEY, ' +
		'plan_digest text NOT NULL, ' +
		'target_context_digest text NOT NULL, ' +
		'database_id text NOT NULL, ' +
		'core_version text NOT NULL, ' +
		'started_at timestamptz NOT NULL DEFAULT now()' +
		')'
	);
}

export function renderCreateTransitionJournalTableSql(): string {
	return (
		`CREATE TABLE IF NOT EXISTS ${transitionJournalTable()} (` +
		'run_id text NOT NULL, ' +
		'seq bigint NOT NULL, ' +
		'event text NOT NULL, ' +
		'step_id text NOT NULL, ' +
		'operation_ref text NOT NULL, ' +
		'operation_kind jsonb NOT NULL, ' +
		'recorded_at timestamptz NOT NULL DEFAULT now(), ' +
		'record jsonb NOT NULL, ' +
		`PRIMARY KEY (run_id, seq), ` +
		`FOREIGN KEY (run_id) REFERENCES ${transitionRunTable()} (run_id), ` +
		"CHECK (event IN ('intent', 'completion', 'observed'))" +
		')'
	);
}

export async function ensureTransitionJournal(
	executor: TransitionJournalQueryable,
): Promise<void> {
	await executor.query(renderCreateDbspMetaSchemaSql());
	await executor.query(renderCreateTransitionRunTableSql());
	await executor.query(renderCreateTransitionJournalTableSql());
}

function requireRun(record: DurableIntentRecord): TransitionRunMetadata {
	if (!record.run) {
		throw new Error(
			'durable transition journal intent is missing run metadata',
		);
	}
	if (record.run.runId !== record.runId) {
		throw new Error('durable transition journal intent run id mismatch');
	}
	return record.run;
}

function runIdFromRecord(
	event: TransitionJournalEventName,
	record: DurableIntentRecord | TransactionalCompletionRecord | StepJournal,
): string {
	const runId =
		event === 'observed'
			? (record as StepJournal).intent.runId
			: (record as DurableIntentRecord | TransactionalCompletionRecord).runId;
	if (!runId) {
		throw new Error(
			`durable transition ${event} journal record is missing run id`,
		);
	}
	return runId;
}

async function ensureRun(
	executor: TransitionJournalQueryable,
	run: TransitionRunMetadata,
): Promise<void> {
	await executor.query(
		`INSERT INTO ${transitionRunTable()} ` +
			'(run_id, plan_digest, target_context_digest, database_id, core_version, started_at) ' +
			'VALUES ($1, $2, $3, $4, $5, $6::timestamptz) ' +
			'ON CONFLICT (run_id) DO NOTHING',
		[
			run.runId,
			run.planDigest,
			run.targetContextDigest,
			run.databaseId,
			run.coreVersion,
			run.startedAt,
		],
	);
}

async function appendJournalEvent(params: {
	readonly executor: TransitionJournalQueryable;
	readonly event: TransitionJournalEventName;
	readonly runId: string;
	readonly stepId: string;
	readonly operation: PhysicalOperation;
	readonly record:
		| DurableIntentRecord
		| TransactionalCompletionRecord
		| StepJournal;
}): Promise<void> {
	await params.executor.query(
		`INSERT INTO ${transitionJournalTable()} ` +
			'(run_id, seq, event, step_id, operation_ref, operation_kind, record) ' +
			'VALUES ($1, ' +
			`COALESCE((SELECT max(seq) + 1 FROM ${transitionJournalTable()} WHERE run_id = $1), 1), ` +
			'$2, $3, $4, $5::jsonb, $6::jsonb)',
		[
			params.runId,
			params.event,
			params.stepId,
			params.operation.ref,
			JSON.stringify(params.operation.operationKind),
			JSON.stringify(params.record),
		],
	);
}

export async function appendIntentJournal(
	executor: TransitionJournalQueryable,
	record: DurableIntentRecord,
): Promise<void> {
	await ensureTransitionJournal(executor);
	const run = requireRun(record);
	await ensureRun(executor, run);
	await appendJournalEvent({
		executor,
		event: 'intent',
		runId: run.runId,
		stepId: record.stepId,
		operation: record.operation,
		record,
	});
}

export async function appendCompletionJournal(
	executor: TransitionJournalQueryable,
	operation: PhysicalOperation,
	record: TransactionalCompletionRecord,
): Promise<void> {
	await ensureTransitionJournal(executor);
	await appendJournalEvent({
		executor,
		event: 'completion',
		runId: runIdFromRecord('completion', record),
		stepId: record.stepId,
		operation,
		record,
	});
}

export async function appendObservedJournal(
	executor: TransitionJournalQueryable,
	journal: StepJournal,
): Promise<void> {
	await ensureTransitionJournal(executor);
	if (journal.intent.run) {
		if (
			journal.intent.runId !== undefined &&
			journal.intent.run.runId !== journal.intent.runId
		) {
			throw new Error(
				'durable transition observed journal intent run id mismatch',
			);
		}
		await ensureRun(executor, journal.intent.run);
	}
	await appendJournalEvent({
		executor,
		event: 'observed',
		runId: runIdFromRecord('observed', journal),
		stepId: journal.intent.stepId,
		operation: journal.intent.operation,
		record: journal,
	});
}

function runMetadataFromRow(
	row: Record<string, unknown>,
): TransitionRunMetadata {
	const {
		run_id,
		plan_digest,
		target_context_digest,
		database_id,
		core_version,
		started_at,
	} = row;
	if (
		typeof run_id !== 'string' ||
		typeof plan_digest !== 'string' ||
		typeof target_context_digest !== 'string' ||
		typeof database_id !== 'string' ||
		typeof core_version !== 'string'
	) {
		throw new Error('dbsp transition run row has an invalid shape');
	}
	const startedAt =
		started_at instanceof Date
			? started_at.toISOString()
			: typeof started_at === 'string'
				? started_at
				: String(started_at);
	return {
		runId: run_id,
		planDigest: plan_digest,
		targetContextDigest: target_context_digest,
		databaseId: database_id,
		coreVersion: core_version,
		startedAt,
	};
}

function eventFromRow(row: Record<string, unknown>): TransitionJournalEvent {
	const {
		run_id,
		seq,
		event,
		step_id,
		operation_ref,
		operation_kind,
		recorded_at,
		record,
	} = row;
	if (
		typeof run_id !== 'string' ||
		!(typeof seq === 'number' || typeof seq === 'string') ||
		(event !== 'intent' && event !== 'completion' && event !== 'observed') ||
		typeof step_id !== 'string' ||
		typeof operation_ref !== 'string' ||
		!isRecord(operation_kind) ||
		!isRecord(record)
	) {
		throw new Error('dbsp transition journal row has an invalid shape');
	}
	const recordedAt =
		recorded_at instanceof Date
			? recorded_at.toISOString()
			: typeof recorded_at === 'string'
				? recorded_at
				: String(recorded_at);
	return {
		runId: run_id,
		seq: Number(seq),
		event,
		stepId: step_id,
		operationRef: operation_ref,
		operationKind:
			operation_kind as unknown as PhysicalOperation['operationKind'],
		recordedAt,
		record: record as unknown as TransitionJournalEvent['record'],
	};
}

export async function readTransitionJournal(
	executor: TransitionJournalQueryable,
	runId: string,
): Promise<TransitionRunJournal> {
	await ensureTransitionJournal(executor);
	const run = await executor.query(
		`SELECT run_id, plan_digest, target_context_digest, database_id, core_version, started_at ` +
			`FROM ${transitionRunTable()} WHERE run_id = $1`,
		[runId],
	);
	const runRow = run.rows[0];
	if (!runRow) {
		throw new Error(`dbsp transition run ${runId} was not found`);
	}
	const events = await executor.query(
		`SELECT run_id, seq::text AS seq, event, step_id, operation_ref, operation_kind, recorded_at, record ` +
			`FROM ${transitionJournalTable()} WHERE run_id = $1 ORDER BY seq`,
		[runId],
	);
	return {
		run: runMetadataFromRow(runRow),
		events: events.rows.map(eventFromRow),
	};
}
