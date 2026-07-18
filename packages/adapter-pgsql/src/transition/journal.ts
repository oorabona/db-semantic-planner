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

type JournalTableShapeRow = {
	readonly relkind: string | null;
	readonly columns: unknown;
	readonly primary_key: unknown;
	readonly foreign_keys: unknown;
	readonly checks: unknown;
};

function jsonRecord(value: unknown): Record<string, unknown> {
	if (isRecord(value)) {
		return value;
	}
	if (typeof value !== 'string') {
		return {};
	}
	try {
		const parsed = JSON.parse(value) as unknown;
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function jsonArray(value: unknown): readonly unknown[] {
	if (Array.isArray(value)) {
		return value;
	}
	if (typeof value !== 'string') {
		return [];
	}
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function jsonStringArray(value: unknown): readonly string[] {
	return jsonArray(value).filter(
		(item): item is string => typeof item === 'string',
	);
}

function columnShape(
	columns: Record<string, unknown>,
	name: string,
): Record<string, unknown> | undefined {
	const value = columns[name];
	return isRecord(value) ? value : undefined;
}

function columnMatches(
	columns: Record<string, unknown>,
	name: string,
	type: string,
): boolean {
	const shape = columnShape(columns, name);
	return shape?.type === type && shape.notNull === true;
}

function sameStringSet(
	left: readonly string[],
	right: readonly string[],
): boolean {
	return (
		left.length === right.length &&
		[...left].sort().every((value, index) => value === [...right].sort()[index])
	);
}

function columnsMatch(
	columns: Record<string, unknown>,
	expected: Readonly<Record<string, string>>,
): boolean {
	const names = Object.keys(expected);
	if (!sameStringSet(Object.keys(columns), names)) {
		return false;
	}
	return names.every((name) => columnMatches(columns, name, expected[name]!));
}

function foreignKeyMatches(
	value: unknown,
	expected: {
		readonly columns: readonly string[];
		readonly foreignSchema: string;
		readonly foreignTable: string;
		readonly foreignColumns: readonly string[];
	},
): boolean {
	if (!isRecord(value)) {
		return false;
	}
	return (
		value.foreignSchema === expected.foreignSchema &&
		value.foreignTable === expected.foreignTable &&
		JSON.stringify(jsonStringArray(value.columns)) ===
			JSON.stringify(expected.columns) &&
		JSON.stringify(jsonStringArray(value.foreignColumns)) ===
			JSON.stringify(expected.foreignColumns)
	);
}

function eventCheckMatches(value: string): boolean {
	const normalized = value.replace(/\s+/gu, '').toLowerCase();
	return new Set([
		"check(eventin('intent','completion','observed'))",
		"check((eventin('intent','completion','observed')))",
		'check(eventin(intent,completion,observed))',
		'check((eventin(intent,completion,observed)))',
		"check((event=any(array['intent'::text,'completion'::text,'observed'::text])))",
	]).has(normalized);
}

function assertRunTableShape(row: JournalTableShapeRow | undefined): void {
	if (row?.relkind !== 'r') {
		throw new Error('dbsp transition run journal table has invalid shape');
	}
	const columns = jsonRecord(row.columns);
	if (
		!columnsMatch(columns, {
			run_id: 'text',
			plan_digest: 'text',
			target_context_digest: 'text',
			database_id: 'text',
			core_version: 'text',
			started_at: 'timestamp with time zone',
		})
	) {
		throw new Error('dbsp transition run journal table columns drifted');
	}
	if (JSON.stringify(jsonStringArray(row.primary_key)) !== '["run_id"]') {
		throw new Error('dbsp transition run journal table primary key drifted');
	}
	if (
		jsonArray(row.foreign_keys).length !== 0 ||
		jsonArray(row.checks).length !== 0
	) {
		throw new Error('dbsp transition run journal table constraints drifted');
	}
}

function assertJournalTableShape(row: JournalTableShapeRow | undefined): void {
	if (row?.relkind !== 'r') {
		throw new Error('dbsp transition event journal table has invalid shape');
	}
	const columns = jsonRecord(row.columns);
	if (
		!columnsMatch(columns, {
			run_id: 'text',
			seq: 'bigint',
			event: 'text',
			step_id: 'text',
			operation_ref: 'text',
			operation_kind: 'jsonb',
			recorded_at: 'timestamp with time zone',
			record: 'jsonb',
		})
	) {
		throw new Error('dbsp transition event journal table columns drifted');
	}
	if (JSON.stringify(jsonStringArray(row.primary_key)) !== '["run_id","seq"]') {
		throw new Error('dbsp transition event journal table primary key drifted');
	}
	const foreignKeys = jsonArray(row.foreign_keys);
	if (
		foreignKeys.length !== 1 ||
		!foreignKeyMatches(foreignKeys[0], {
			columns: ['run_id'],
			foreignSchema: DBSP_META_SCHEMA,
			foreignTable: DBSP_TRANSITION_RUN_TABLE,
			foreignColumns: ['run_id'],
		})
	) {
		throw new Error('dbsp transition event journal table foreign key drifted');
	}
	const checks = jsonStringArray(row.checks);
	if (checks.length !== 1 || !eventCheckMatches(checks[0]!)) {
		throw new Error('dbsp transition event journal table CHECK drifted');
	}
}

async function readJournalTableShape(
	executor: TransitionJournalQueryable,
	table: string,
): Promise<JournalTableShapeRow | undefined> {
	const result = await executor.query(
		`/* dbsp_transition_journal_shape */ SELECT c.relkind AS relkind, ` +
			`COALESCE((` +
			`SELECT pg_catalog.jsonb_object_agg(a.attname, pg_catalog.jsonb_build_object(` +
			`'type', pg_catalog.format_type(a.atttypid, a.atttypmod), ` +
			`'notNull', a.attnotnull)) ` +
			`FROM pg_catalog.pg_attribute a ` +
			`WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped` +
			`), '{}'::jsonb) AS columns, ` +
			`COALESCE((` +
			`SELECT pg_catalog.jsonb_agg(a.attname ORDER BY key.ordinality) ` +
			`FROM pg_catalog.pg_constraint con ` +
			`JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS key(attnum, ordinality) ON true ` +
			`JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = key.attnum ` +
			`WHERE con.conrelid = c.oid AND con.contype = 'p'` +
			`), '[]'::jsonb) AS primary_key, ` +
			`COALESCE((` +
			`SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(` +
			`'columns', fk_cols.columns, ` +
			`'foreignSchema', fn.nspname, ` +
			`'foreignTable', fc.relname, ` +
			`'foreignColumns', ref_cols.columns) ORDER BY con.conname) ` +
			`FROM pg_catalog.pg_constraint con ` +
			`JOIN pg_catalog.pg_class fc ON fc.oid = con.confrelid ` +
			`JOIN pg_catalog.pg_namespace fn ON fn.oid = fc.relnamespace ` +
			`JOIN LATERAL (` +
			`SELECT pg_catalog.jsonb_agg(a.attname ORDER BY key.ordinality) AS columns ` +
			`FROM unnest(con.conkey) WITH ORDINALITY AS key(attnum, ordinality) ` +
			`JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = key.attnum` +
			`) fk_cols ON true ` +
			`JOIN LATERAL (` +
			`SELECT pg_catalog.jsonb_agg(a.attname ORDER BY key.ordinality) AS columns ` +
			`FROM unnest(con.confkey) WITH ORDINALITY AS key(attnum, ordinality) ` +
			`JOIN pg_catalog.pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = key.attnum` +
			`) ref_cols ON true ` +
			`WHERE con.conrelid = c.oid AND con.contype = 'f'` +
			`), '[]'::jsonb) AS foreign_keys, ` +
			`COALESCE((` +
			`SELECT pg_catalog.jsonb_agg(pg_catalog.pg_get_constraintdef(con.oid, false) ORDER BY con.conname) ` +
			`FROM pg_catalog.pg_constraint con ` +
			`WHERE con.conrelid = c.oid AND con.contype = 'c'` +
			`), '[]'::jsonb) AS checks ` +
			`FROM pg_catalog.pg_class c ` +
			`JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace ` +
			`WHERE n.nspname = $1 AND c.relname = $2`,
		[DBSP_META_SCHEMA, table],
	);
	return result.rows[0] as JournalTableShapeRow | undefined;
}

async function verifyTransitionJournalShape(
	executor: TransitionJournalQueryable,
): Promise<void> {
	assertRunTableShape(
		await readJournalTableShape(executor, DBSP_TRANSITION_RUN_TABLE),
	);
	assertJournalTableShape(
		await readJournalTableShape(executor, DBSP_TRANSITION_JOURNAL_TABLE),
	);
}

export async function ensureTransitionJournal(
	executor: TransitionJournalQueryable,
): Promise<void> {
	await executor.query(renderCreateDbspMetaSchemaSql());
	await executor.query(renderCreateTransitionRunTableSql());
	await executor.query(renderCreateTransitionJournalTableSql());
	await verifyTransitionJournalShape(executor);
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
	const existing = await executor.query(
		`SELECT run_id, plan_digest, target_context_digest, database_id, core_version, started_at ` +
			`FROM ${transitionRunTable()} WHERE run_id = $1`,
		[run.runId],
	);
	const row = existing.rows[0];
	if (!row) {
		throw new Error('dbsp transition run metadata was not persisted');
	}
	const current = runMetadataFromRow(row);
	if (
		current.planDigest !== run.planDigest ||
		current.targetContextDigest !== run.targetContextDigest ||
		current.databaseId !== run.databaseId ||
		current.coreVersion !== run.coreVersion
	) {
		throw new Error(
			`dbsp transition run ${run.runId} already exists with different metadata`,
		);
	}
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
