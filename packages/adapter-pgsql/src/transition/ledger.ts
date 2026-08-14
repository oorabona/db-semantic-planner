import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
	LedgerChainMember,
	LedgerClaimKind,
	LedgerEventKind,
	LedgerHome,
	LedgerIdentity,
	LedgerReservationRow,
} from '@dbsp/types';
import { validateIdentifier } from '../validate.js';
import {
	DBSP_LEDGER_EVENT_TABLE,
	DBSP_LEDGER_IDENTITY_TABLE,
	DBSP_LEDGER_MARKER_TABLE,
	DBSP_LEDGER_RESERVATION_TABLE,
	DBSP_LEDGER_TABLES,
	DBSP_META_SCHEMA,
} from './constants.js';
import { classifyPgWrite } from './database-writability.js';
import type { TransitionJournalQueryable } from './journal.js';
import {
	generatePgLedgerExpectedManifest,
	PG_LEDGER_SPEC,
	renderCreateLedgerImmutabilityFunctionFromSpec,
	renderCreateLedgerImmutabilityTriggerFromSpec,
	renderCreateLedgerIndexFromSpec,
	renderCreateLedgerTableFromSpec,
} from './ledger-spec.js';
import { readPgLedgerMarker } from './reinitialize-preflight.js';

const CLAIM_EVENT_KINDS = new Set<LedgerEventKind>([
	'adopt-intent',
	'intent',
	'retire-intent',
	'readdress-intent',
]);

const RESOLUTION_EVENT_KINDS = new Set<LedgerEventKind>([
	'adopt',
	'refused',
	'observed',
	'absent',
	'indeterminate',
	'resolved',
	'readdressed-to',
	'readdressed-from',
	'released',
]);

export const PG_LEDGER_MIN_SERVER_VERSION_NUM = 150000;
export const PG_LEDGER_SHAPE_VERSION = 1;

type LedgerTableRow = {
	readonly table_name: unknown;
	readonly relation_kind: unknown;
};

type LedgerColumnRow = {
	readonly table_name: unknown;
	readonly column_name: unknown;
	readonly column_type: unknown;
	readonly is_not_null: unknown;
};

type LedgerDefaultRow = {
	readonly table_name: unknown;
	readonly column_name: unknown;
	readonly default_definition: unknown;
};

type LedgerTriggerRow = {
	readonly trigger_name: unknown;
	readonly trigger_enabled: unknown;
	readonly trigger_type: unknown;
	readonly trigger_arguments: unknown;
	readonly trigger_deferrable: unknown;
	readonly trigger_initially_deferred: unknown;
	readonly function_name: unknown;
	readonly function_identity_arguments: unknown;
	readonly function_result: unknown;
	readonly function_language: unknown;
	readonly function_kind: unknown;
	readonly function_volatility: unknown;
	readonly function_is_strict: unknown;
	readonly function_is_security_definer: unknown;
	readonly function_is_leakproof: unknown;
	readonly function_config_is_null: unknown;
	readonly function_source: unknown;
};

type LedgerConstraintRow = {
	readonly table_name: unknown;
	readonly constraint_name: unknown;
	readonly contype: unknown;
	readonly check_expression: unknown;
	readonly connullsnotdistinct: unknown;
	readonly key_columns: unknown;
	readonly referenced_table_name: unknown;
	readonly referenced_columns: unknown;
	readonly confupdtype: unknown;
	readonly confdeltype: unknown;
	readonly condeferrable: unknown;
	readonly condeferred: unknown;
	readonly convalidated: unknown;
};

type LedgerIndexRow = {
	readonly table_name: unknown;
	readonly index_name: unknown;
	readonly indisprimary: unknown;
	readonly indisunique: unknown;
	readonly indisvalid: unknown;
	readonly indisready: unknown;
	readonly index_columns: unknown;
};

export type PgLedgerPhysicalShapeOutcome =
	| { readonly kind: 'verified' }
	| { readonly kind: 'shape-wrong'; readonly artefact: string }
	| { readonly kind: 'unverifiable'; readonly cause: string }
	| { readonly kind: 'unsupported-major'; readonly major: number | undefined }
	| { readonly kind: 'validator-abi-failure'; readonly sqlstate: string };

type LedgerDeparseFixture = Readonly<{
	checks: Readonly<Record<string, string>>;
	defaults: Readonly<Record<string, string>>;
}>;

function pgSqlState(error: unknown): string | undefined {
	if (!error || typeof error !== 'object') return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === 'string' ? code : undefined;
}

export function classifyPgLedgerShapeError(
	error: unknown,
): Exclude<PgLedgerPhysicalShapeOutcome, { readonly kind: 'verified' }> {
	const sqlstate = pgSqlState(error);
	if (
		sqlstate === '42501' ||
		sqlstate === '08000' ||
		sqlstate === '08003' ||
		sqlstate === '08006' ||
		sqlstate === '57014'
	)
		return { kind: 'unverifiable', cause: sqlstate };
	if (sqlstate === '40001' || sqlstate === '40P01' || sqlstate === '55P03')
		return { kind: 'unverifiable', cause: sqlstate };
	if (sqlstate === '42703' || sqlstate === '42883' || sqlstate === '0A000')
		return { kind: 'validator-abi-failure', sqlstate };
	return { kind: 'unverifiable', cause: sqlstate ?? 'unknown' };
}

async function readLedgerDeparseFixture(
	major: number,
): Promise<LedgerDeparseFixture | undefined> {
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		// tsup copies the published fixtures to dist/.  Keep this first so a
		// workspace consumer never depends on a repository-relative fallback.
		resolve(here, `pg-${major}.json`),
		resolve(here, 'ledger-deparse-fixtures', `pg-${major}.json`),
		resolve(
			process.cwd(),
			'packages/adapter-pgsql/src/transition/ledger-deparse-fixtures',
			`pg-${major}.json`,
		),
	];
	for (const filename of candidates) {
		try {
			const parsed: unknown = JSON.parse(await readFile(filename, 'utf8'));
			if (
				parsed &&
				typeof parsed === 'object' &&
				'checks' in parsed &&
				'defaults' in parsed &&
				typeof (parsed as { checks: unknown }).checks === 'object' &&
				typeof (parsed as { defaults: unknown }).defaults === 'object'
			)
				return parsed as LedgerDeparseFixture;
		} catch (error) {
			if (
				!(
					error &&
					typeof error === 'object' &&
					(error as { code?: unknown }).code === 'ENOENT'
				)
			)
				throw error;
		}
	}
	return undefined;
}

function stringArray(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
		return undefined;
	return value;
}

function hasColumns(value: unknown, expected: readonly string[]): boolean {
	const columns = stringArray(value);
	return (
		columns !== undefined &&
		columns.length === expected.length &&
		columns.every((column, index) => column === expected[index])
	);
}

function ledgerPhysicalShapeError(
	target: PgLedgerTarget,
	table: string,
	invariant: string,
): Error {
	return new Error(
		`ledger physical shape: ${ledgerSchema(target)}.${table} ${invariant}; run dbsp preflight --reinitialize`,
	);
}

/**
 * `pg_constraint.conindid` is zero for constraints without a backing index.
 * The LEFT JOIN therefore exposes NULL for `indnullsnotdistinct`; normalize
 * that catalogue absence to the comparator's explicit false property.
 */
function normalizeLedgerConstraintRow(
	row: LedgerConstraintRow,
): LedgerConstraintRow {
	return {
		...row,
		connullsnotdistinct:
			row.connullsnotdistinct === null ? false : row.connullsnotdistinct,
	};
}

async function readLedgerConstraints(
	executor: TransitionJournalQueryable,
	schema: string,
): Promise<readonly LedgerConstraintRow[]> {
	const constraints = await executor.query(
		`SELECT relation.relname AS table_name, constraint_item.conname AS constraint_name, constraint_item.contype, pg_catalog.pg_get_expr(constraint_item.conbin, constraint_item.conrelid) AS check_expression, constraint_index.indnullsnotdistinct AS connullsnotdistinct, ARRAY(SELECT attribute.attname::text FROM unnest(constraint_item.conkey) WITH ORDINALITY AS key_column(attnum, position) JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = constraint_item.conrelid AND attribute.attnum = key_column.attnum ORDER BY key_column.position) AS key_columns, referenced_relation.relname AS referenced_table_name, ARRAY(SELECT attribute.attname::text FROM unnest(constraint_item.confkey) WITH ORDINALITY AS referenced_column(attnum, position) JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = constraint_item.confrelid AND attribute.attnum = referenced_column.attnum ORDER BY referenced_column.position) AS referenced_columns, constraint_item.confupdtype, constraint_item.confdeltype, constraint_item.condeferrable, constraint_item.condeferred, constraint_item.convalidated FROM pg_catalog.pg_constraint constraint_item JOIN pg_catalog.pg_class relation ON relation.oid = constraint_item.conrelid JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace LEFT JOIN pg_catalog.pg_class referenced_relation ON referenced_relation.oid = constraint_item.confrelid LEFT JOIN pg_catalog.pg_index constraint_index ON constraint_index.indexrelid = constraint_item.conindid WHERE namespace.nspname = $1 AND relation.relname = ANY($2::text[]) AND constraint_item.contype IN ('p', 'c', 'u', 'f') ORDER BY relation.relname, constraint_item.oid`,
		[schema, DBSP_LEDGER_TABLES],
	);
	// PostgreSQL 18 records NOT NULL as pg_constraint rows with contype = 'n'.
	// NOT NULL belongs to the column-shape assertion above, never this set.
	return (constraints.rows as readonly LedgerConstraintRow[])
		.filter(
			(row) =>
				row.contype === 'p' ||
				row.contype === 'c' ||
				row.contype === 'u' ||
				row.contype === 'f',
		)
		.map(normalizeLedgerConstraintRow);
}

async function readLedgerDefaults(
	executor: TransitionJournalQueryable,
	schema: string,
): Promise<readonly LedgerDefaultRow[]> {
	const result = await executor.query(
		`SELECT relation.relname AS table_name, attribute.attname AS column_name, pg_catalog.pg_get_expr(default_item.adbin, default_item.adrelid, false) AS default_definition FROM pg_catalog.pg_attrdef default_item JOIN pg_catalog.pg_class relation ON relation.oid = default_item.adrelid JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = relation.oid AND attribute.attnum = default_item.adnum WHERE namespace.nspname = $1 AND relation.relname = ANY($2::text[]) ORDER BY relation.relname, attribute.attname`,
		[schema, DBSP_LEDGER_TABLES],
	);
	return result.rows as readonly LedgerDefaultRow[];
}

/**
 * Read-only admission of an existing ledger.  A fixture is deliberately a
 * prerequisite: deparse text is not portable across PostgreSQL majors.
 */
export async function classifyPgLedgerPhysicalShape(
	executor: TransitionJournalQueryable,
	target: PgLedgerTarget,
): Promise<PgLedgerPhysicalShapeOutcome> {
	let major: number | undefined;
	try {
		const value = (
			await executor.query(
				"SELECT current_setting('server_version_num') AS server_version_num",
			)
		).rows[0]?.server_version_num;
		const version = Number(value);
		if (!Number.isSafeInteger(version))
			return { kind: 'unsupported-major', major: undefined };
		major = Math.floor(version / 10000);
		const fixture = await readLedgerDeparseFixture(major);
		if (!fixture) return { kind: 'unsupported-major', major };
		await executor.query('SET LOCAL search_path = pg_catalog');
		await executor.query('SET LOCAL quote_all_identifiers = off');
		await validatePgLedgerPhysicalShapeFacts(executor, target, fixture);
		return { kind: 'verified' };
	} catch (error) {
		const sqlstate = pgSqlState(error);
		if (sqlstate) return classifyPgLedgerShapeError(error);
		return {
			kind: 'shape-wrong',
			artefact:
				error instanceof Error
					? error.message
					: 'unreadable catalogue projection',
		};
	}
}

export class PgLedgerPhysicalShapeValidationError extends Error {
	readonly outcome: Exclude<PgLedgerPhysicalShapeOutcome, { kind: 'verified' }>;

	constructor(
		outcome: Exclude<PgLedgerPhysicalShapeOutcome, { kind: 'verified' }>,
	) {
		super(
			`ledger physical shape is ${outcome.kind}: ${JSON.stringify(outcome)}`,
		);
		this.name = 'PgLedgerPhysicalShapeValidationError';
		this.outcome = outcome;
	}
}

/** The legacy admission boundary: only a verified shape returns to its caller. */
export function assertPgLedgerPhysicalShapeVerified(
	outcome: PgLedgerPhysicalShapeOutcome,
): asserts outcome is { readonly kind: 'verified' } {
	if (outcome.kind !== 'verified')
		throw new PgLedgerPhysicalShapeValidationError(outcome);
}

/**
 * Throwing compatibility façade. Existing mutating callers intentionally keep
 * their historical contract; outcome-aware consumers use `classify…`.
 */
export async function validatePgLedgerPhysicalShape(
	executor: TransitionJournalQueryable,
	target: PgLedgerTarget,
): Promise<void> {
	assertPgLedgerPhysicalShapeVerified(
		await classifyPgLedgerPhysicalShape(executor, target),
	);
}

async function readLedgerImmutabilityTriggers(
	executor: TransitionJournalQueryable,
	schema: string,
	tableName: string,
): Promise<readonly LedgerTriggerRow[]> {
	const result = await executor.query(
		`SELECT trigger_item.tgname AS trigger_name, trigger_item.tgenabled AS trigger_enabled, trigger_item.tgtype::text AS trigger_type, pg_catalog.encode(trigger_item.tgargs, 'hex') AS trigger_arguments, trigger_item.tgdeferrable AS trigger_deferrable, trigger_item.tginitdeferred AS trigger_initially_deferred, procedure.proname AS function_name, pg_catalog.pg_get_function_identity_arguments(procedure.oid) AS function_identity_arguments, pg_catalog.pg_get_function_result(procedure.oid) AS function_result, language.lanname AS function_language, procedure.prokind AS function_kind, procedure.provolatile AS function_volatility, procedure.proisstrict AS function_is_strict, procedure.prosecdef AS function_is_security_definer, procedure.proleakproof AS function_is_leakproof, procedure.proconfig IS NULL AS function_config_is_null, procedure.prosrc AS function_source FROM pg_catalog.pg_trigger trigger_item JOIN pg_catalog.pg_class relation ON relation.oid = trigger_item.tgrelid JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace JOIN pg_catalog.pg_proc procedure ON procedure.oid = trigger_item.tgfoid JOIN pg_catalog.pg_language language ON language.oid = procedure.prolang WHERE namespace.nspname = $1 AND relation.relname = $2 AND NOT trigger_item.tgisinternal ORDER BY trigger_item.tgname`,
		[schema, tableName],
	);
	return result.rows as readonly LedgerTriggerRow[];
}

/**
 * Compare the live ledger to a scratch ledger rendered from this shared
 * definition. Constraint and trigger facts come from catalog rows so the
 * comparison stays valid across schemas; only CHECK expressions are deparsed.
 */
/**
 * Verify catalog facts before an existing relation is accepted as a ledger.
 * CREATE ... IF NOT EXISTS is deliberately not evidence of this shape.
 */
async function validatePgLedgerPhysicalShapeFacts(
	executor: TransitionJournalQueryable,
	target: PgLedgerTarget,
	fixture: LedgerDeparseFixture,
): Promise<void> {
	const manifest = generatePgLedgerExpectedManifest();
	const tables = await executor.query(
		`SELECT relation.relname AS table_name, relation.relkind AS relation_kind FROM pg_catalog.pg_class relation JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = $1 AND relation.relname = ANY($2::text[]) ORDER BY relation.relname`,
		[ledgerSchema(target), DBSP_LEDGER_TABLES],
	);
	const tableRows = tables.rows as readonly LedgerTableRow[];
	for (const definition of manifest.tables) {
		const row = tableRows.find(
			(candidate) => candidate.table_name === definition.name,
		);
		if (!row)
			throw ledgerPhysicalShapeError(target, definition.name, 'is missing');
		if (row.relation_kind !== manifest.relationKind)
			throw ledgerPhysicalShapeError(
				target,
				definition.name,
				'is not an ordinary table',
			);
	}

	const columns = await executor.query(
		`SELECT relation.relname AS table_name, attribute.attname AS column_name, pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) AS column_type, attribute.attnotnull AS is_not_null FROM pg_catalog.pg_attribute attribute JOIN pg_catalog.pg_class relation ON relation.oid = attribute.attrelid JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = $1 AND relation.relname = ANY($2::text[]) AND attribute.attnum > 0 AND NOT attribute.attisdropped ORDER BY relation.relname, attribute.attnum`,
		[ledgerSchema(target), DBSP_LEDGER_TABLES],
	);
	const columnRows = columns.rows as readonly LedgerColumnRow[];
	for (const definition of manifest.tables) {
		const actual = columnRows.filter(
			(row) => row.table_name === definition.name,
		);
		const hasExpectedColumns =
			actual.length === definition.columns.length &&
			definition.columns.every((expected, index) => {
				const row = actual[index];
				return (
					row?.column_name === expected.name &&
					row.column_type === expected.type &&
					row.is_not_null === !expected.nullable
				);
			});
		if (!hasExpectedColumns)
			throw ledgerPhysicalShapeError(
				target,
				definition.name,
				'has an unexpected column shape',
			);
	}

	// PostgreSQL 18 records NOT NULL as pg_constraint rows with contype = 'n'.
	// NOT NULL belongs to the column-shape assertion above, never this set.
	const constraintRows = await readLedgerConstraints(
		executor,
		ledgerSchema(target),
	);
	for (const definition of manifest.tables) {
		const expected = definition.constraints;
		const actual = constraintRows.filter(
			(row) => row.table_name === definition.name,
		);
		if (actual.length !== expected.length)
			throw ledgerPhysicalShapeError(
				target,
				definition.name,
				'has an unexpected named constraint set',
			);
		for (const constraint of expected) {
			const row = actual.find(
				(candidate) => candidate.constraint_name === constraint.name,
			);
			if (
				!row ||
				row.contype !== constraint.type ||
				row.condeferrable !== manifest.constraintProperties.deferrable ||
				row.condeferred !== manifest.constraintProperties.initiallyDeferred ||
				row.convalidated !== manifest.constraintProperties.validated ||
				row.connullsnotdistinct !== (constraint.nullsNotDistinct ?? false) ||
				(constraint.columns !== undefined &&
					!hasColumns(row.key_columns, constraint.columns)) ||
				(constraint.referencedTable !== undefined &&
					row.referenced_table_name !== constraint.referencedTable) ||
				(constraint.referencedColumns !== undefined &&
					!hasColumns(row.referenced_columns, constraint.referencedColumns))
			)
				throw ledgerPhysicalShapeError(
					target,
					definition.name,
					`has an unexpected constraint ${constraint.name}`,
				);
			if (constraint.type === 'c') {
				const expectedExpression =
					fixture.checks[`${definition.name}.${constraint.name}`];
				if (
					typeof expectedExpression !== 'string' ||
					row.check_expression !== expectedExpression
				)
					throw ledgerPhysicalShapeError(
						target,
						definition.name,
						`has an unexpected CHECK ${constraint.name}`,
					);
			}
		}
	}
	const defaults = await readLedgerDefaults(executor, ledgerSchema(target));
	for (const definition of manifest.tables) {
		for (const column of definition.columns.filter(
			(candidate) => candidate.defaultSql !== undefined,
		)) {
			const expected = fixture.defaults[`${definition.name}.${column.name}`];
			const actual = defaults.find(
				(row) =>
					row.table_name === definition.name && row.column_name === column.name,
			);
			if (
				typeof expected !== 'string' ||
				actual?.default_definition !== expected
			)
				throw ledgerPhysicalShapeError(
					target,
					definition.name,
					`has an unexpected default for ${column.name}`,
				);
		}
	}
	const triggers = await readLedgerImmutabilityTriggers(
		executor,
		ledgerSchema(target),
		manifest.immutabilityTrigger.tableName,
	);
	if (triggers.length !== 1)
		throw ledgerPhysicalShapeError(
			target,
			manifest.immutabilityTrigger.tableName,
			'has an unexpected immutability trigger set',
		);
	const trigger = triggers[0]!;
	const expectedTrigger = manifest.immutabilityTrigger;
	if (
		trigger.trigger_name !== expectedTrigger.name ||
		trigger.trigger_enabled !== expectedTrigger.enabled ||
		trigger.trigger_type !== expectedTrigger.type ||
		trigger.trigger_arguments !== expectedTrigger.arguments ||
		trigger.trigger_deferrable !== expectedTrigger.deferrable ||
		trigger.trigger_initially_deferred !== expectedTrigger.initiallyDeferred ||
		trigger.function_name !== expectedTrigger.functionName ||
		trigger.function_identity_arguments !==
			expectedTrigger.functionIdentityArguments ||
		trigger.function_result !== expectedTrigger.functionResult ||
		trigger.function_language !== expectedTrigger.functionLanguage ||
		trigger.function_kind !== expectedTrigger.functionKind ||
		trigger.function_volatility !== expectedTrigger.functionVolatility ||
		trigger.function_is_strict !== expectedTrigger.functionIsStrict ||
		trigger.function_is_security_definer !==
			expectedTrigger.functionIsSecurityDefiner ||
		trigger.function_is_leakproof !== expectedTrigger.functionIsLeakproof ||
		trigger.function_config_is_null !== expectedTrigger.functionConfigIsNull ||
		trigger.function_source !== expectedTrigger.functionBody
	)
		throw ledgerPhysicalShapeError(
			target,
			manifest.immutabilityTrigger.tableName,
			'has an unexpected immutability trigger or function definition',
		);

	const indexes = await executor.query(
		`SELECT relation.relname AS table_name, index_relation.relname AS index_name, index_definition.indisprimary, index_definition.indisunique, index_definition.indisvalid, index_definition.indisready, ARRAY(SELECT attribute.attname::text FROM unnest(index_definition.indkey) WITH ORDINALITY AS index_column(attnum, position) JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = relation.oid AND attribute.attnum = index_column.attnum ORDER BY index_column.position) AS index_columns FROM pg_catalog.pg_index index_definition JOIN pg_catalog.pg_class relation ON relation.oid = index_definition.indrelid JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace JOIN pg_catalog.pg_class index_relation ON index_relation.oid = index_definition.indexrelid WHERE namespace.nspname = $1 AND relation.relname = $2 ORDER BY index_definition.indexrelid`,
		[ledgerSchema(target), DBSP_LEDGER_EVENT_TABLE],
	);
	for (const definition of manifest.tables) {
		for (const index of definition.indexes ?? []) {
			const actual = (indexes.rows as readonly LedgerIndexRow[]).find(
				(row) =>
					row.table_name === definition.name && row.index_name === index.name,
			);
			if (
				actual?.indisprimary !== false ||
				actual?.indisunique !== index.unique ||
				actual?.indisvalid !== index.valid ||
				actual?.indisready !== index.ready ||
				!hasColumns(actual?.index_columns, index.columns)
			)
				throw ledgerPhysicalShapeError(
					target,
					definition.name,
					`has an unexpected index ${index.name}`,
				);
		}
	}
}

export class PgLedgerStorageUnsupportedError extends Error {
	constructor(observed: unknown) {
		super(
			`ledger-storage-postgresql-15-required: PostgreSQL >= 15 is required for NULLS NOT DISTINCT (server_version_num ${String(observed)})`,
		);
		this.name = 'PgLedgerStorageUnsupportedError';
	}
}

declare const pgOrderedLedgerLocksBrand: unique symbol;

/** Proof returned only after this transaction acquired every home in order. */
export interface PgOrderedLedgerLocks {
	readonly homes: readonly PgLedgerTarget[];
	readonly [pgOrderedLedgerLocksBrand]: 'dbsp-pg-ordered-ledger-locks';
}

const orderedLedgerLocks = new WeakSet<object>();

function mintPgOrderedLedgerLocks(
	homes: readonly LedgerHome[],
): PgOrderedLedgerLocks {
	const proof = Object.freeze({
		homes: Object.freeze(
			orderedLedgerHomes(homes).map((home) => Object.freeze({ ...home })),
		),
	}) as PgOrderedLedgerLocks;
	orderedLedgerLocks.add(proof);
	return proof;
}

export function isPgOrderedLedgerLocks(
	value: unknown,
): value is PgOrderedLedgerLocks {
	return (
		value != null &&
		(typeof value === 'object' || typeof value === 'function') &&
		orderedLedgerLocks.has(value as object)
	);
}

export type PgLedgerLockResult =
	| { readonly kind: 'acquired'; readonly proof: PgOrderedLedgerLocks }
	| { readonly kind: 'busy'; readonly ledger: LedgerHome }
	| {
			readonly kind: 'refused';
			readonly ledger: LedgerHome;
			readonly error: unknown;
	  };

export type PgLedgerTarget = LedgerHome;

/** Read only reservations explicitly linked to one durable execution/run. */
export async function readPgLedgerReservationsForExecution(
	executor: TransitionJournalQueryable,
	target: PgLedgerTarget,
	executionId: string,
): Promise<readonly LedgerReservationRow[]> {
	const result = await executor.query(
		`SELECT address_engine, address_database, address_schema, address_parent, address_kind, address_name, claim_kind, execution_id, pair_id, root_claim_id, home_ledger_scope, home_ledger_schema FROM ${reservationTable(target)} WHERE execution_id = $1 ORDER BY root_claim_id, address_kind, address_name`,
		[executionId],
	);
	return result.rows.map((row) => {
		const schema = String(row.address_schema ?? '');
		const homeSchema = String(row.home_ledger_schema ?? '');
		const parent = row.address_parent;
		return {
			address: {
				scope: target.scope,
				engine: String(row.address_engine),
				database: String(row.address_database),
				...(schema ? { schema } : {}),
				...(parent == null
					? {}
					: {
							parent: typeof parent === 'string' ? JSON.parse(parent) : parent,
						}),
				kind: String(row.address_kind),
				name: String(row.address_name),
			},
			claimKind: String(row.claim_kind) as LedgerReservationRow['claimKind'],
			executionId: String(row.execution_id),
			...(row.pair_id == null ? {} : { pairId: String(row.pair_id) }),
			rootClaimId: String(row.root_claim_id),
			homeLedger:
				row.home_ledger_scope === 'database'
					? { scope: 'database' }
					: { scope: 'schema', schema: homeSchema },
		};
	});
}

/**
 * A re-address pair can cross ledger homes. Discover every existing reservation
 * table before reading the pair so recovery cannot accidentally treat one side
 * of a cross-schema closure as the entire operation.
 */
export type PgLedgerReservationCandidateOutcome =
	| { readonly target: PgLedgerTarget; readonly kind: 'verified' }
	| { readonly target: PgLedgerTarget; readonly kind: 'not-ledger-shape' }
	| {
			readonly target: PgLedgerTarget;
			readonly kind: 'unverifiable';
			readonly cause: string;
	  };

export type PgLedgerReservationsForPair = readonly LedgerReservationRow[] & {
	readonly candidates: readonly PgLedgerReservationCandidateOutcome[];
};

type LedgerDiscoveryRow = {
	readonly nspname: unknown;
	readonly table_name: unknown;
	readonly relation_kind: unknown;
	readonly column_names: unknown;
};

/** The discriminator rejects only definite counterfeits; it never admits one. */
export function hasPgLedgerCandidateFingerprint(
	rows: readonly Pick<
		LedgerDiscoveryRow,
		'table_name' | 'relation_kind' | 'column_names'
	>[],
): boolean {
	const manifest = generatePgLedgerExpectedManifest();
	return manifest.tables.every((definition) => {
		const row = rows.find(
			(candidate) => candidate.table_name === definition.name,
		);
		return (
			row?.relation_kind === manifest.relationKind &&
			hasColumns(
				row.column_names,
				definition.columns.map((column) => column.name),
			)
		);
	});
}

function candidateOutcome(
	target: PgLedgerTarget,
	outcome: PgLedgerPhysicalShapeOutcome,
): PgLedgerReservationCandidateOutcome {
	if (outcome.kind === 'verified') return { target, kind: 'verified' };
	if (outcome.kind === 'shape-wrong')
		return { target, kind: 'not-ledger-shape' };
	return {
		target,
		kind: 'unverifiable',
		cause:
			outcome.kind === 'unverifiable'
				? outcome.cause
				: outcome.kind === 'unsupported-major'
					? `unsupported-major:${String(outcome.major)}`
					: outcome.sqlstate,
	};
}

function withCandidateOutcomes(
	rows: readonly LedgerReservationRow[],
	candidates: readonly PgLedgerReservationCandidateOutcome[],
): PgLedgerReservationsForPair {
	const result = [...rows] as unknown as PgLedgerReservationsForPair;
	Object.defineProperty(result, 'candidates', {
		value: candidates,
		enumerable: false,
	});
	return result;
}

export async function readPgLedgerReservationsForPair(
	executor: TransitionJournalQueryable,
	pairId: string,
): Promise<PgLedgerReservationsForPair> {
	let begun = false;
	try {
		await executor.query(
			'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
		);
		begun = true;
		const discovered = await executor.query(
			`SELECT namespace.nspname, relation.relname AS table_name, relation.relkind AS relation_kind, ARRAY(SELECT attribute.attname::text FROM pg_catalog.pg_attribute attribute WHERE attribute.attrelid = relation.oid AND attribute.attnum > 0 AND NOT attribute.attisdropped ORDER BY attribute.attnum) AS column_names FROM pg_catalog.pg_class relation JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace WHERE relation.relname = ANY($1::text[]) ORDER BY namespace.nspname, relation.relname`,
			[generatePgLedgerExpectedManifest().tables.map((table) => table.name)],
		);
		const grouped = new Map<string, LedgerDiscoveryRow[]>();
		for (const row of discovered.rows as readonly LedgerDiscoveryRow[]) {
			if (typeof row.nspname !== 'string') continue;
			const entries = grouped.get(row.nspname) ?? [];
			entries.push(row);
			grouped.set(row.nspname, entries);
		}
		const candidates: PgLedgerReservationCandidateOutcome[] = [];
		const reservations: LedgerReservationRow[] = [];
		for (const [schema, rows] of grouped) {
			if (!rows.some((row) => row.table_name === DBSP_LEDGER_RESERVATION_TABLE))
				continue;
			const target: PgLedgerTarget =
				schema === DBSP_META_SCHEMA
					? { scope: 'database' }
					: { scope: 'schema', schema };
			if (!hasPgLedgerCandidateFingerprint(rows)) {
				candidates.push({ target, kind: 'not-ledger-shape' });
				continue;
			}
			try {
				const outcome = await classifyPgLedgerPhysicalShape(executor, target);
				const classified = candidateOutcome(target, outcome);
				if (classified.kind !== 'verified') {
					candidates.push(classified);
					continue;
				}
				const marker = await readPgLedgerMarker(executor, target);
				if (marker.kind !== 'current') {
					candidates.push({ target, kind: 'not-ledger-shape' });
					continue;
				}
				reservations.push(
					...(await readPgLedgerReservationsForPairInHomes(executor, pairId, [
						target,
					])),
				);
				candidates.push(classified);
			} catch (error) {
				const classified = candidateOutcome(
					target,
					classifyPgLedgerShapeError(error),
				);
				candidates.push(classified);
			}
		}
		await executor.query('COMMIT');
		begun = false;
		return withCandidateOutcomes(reservations, candidates);
	} catch (error) {
		if (begun) {
			try {
				await executor.query('ROLLBACK');
			} catch {
				// Preserve the discovery failure, never a cleanup failure.
			}
		}
		throw error;
	}
}

/** Read a re-address pair only from ledger homes already admitted by a caller. */
export async function readPgLedgerReservationsForPairInHomes(
	executor: TransitionJournalQueryable,
	pairId: string,
	targets: readonly PgLedgerTarget[],
): Promise<readonly LedgerReservationRow[]> {
	const rows = await Promise.all(
		targets.map(async (target) => {
			const result = await executor.query(
				`SELECT address_engine, address_database, address_schema, address_parent, address_kind, address_name, claim_kind, execution_id, pair_id, root_claim_id, home_ledger_scope, home_ledger_schema FROM ${reservationTable(target)} WHERE pair_id = $1 ORDER BY root_claim_id, address_kind, address_name`,
				[pairId],
			);
			return result.rows.map((value) => {
				const schema = String(value.address_schema ?? '');
				const homeSchema = String(value.home_ledger_schema ?? '');
				return {
					address: {
						scope: target.scope,
						engine: String(value.address_engine),
						database: String(value.address_database),
						...(schema ? { schema } : {}),
						...(value.address_parent == null
							? {}
							: {
									parent:
										typeof value.address_parent === 'string'
											? JSON.parse(value.address_parent)
											: value.address_parent,
								}),
						kind: String(value.address_kind),
						name: String(value.address_name),
					},
					claimKind: String(
						value.claim_kind,
					) as LedgerReservationRow['claimKind'],
					executionId: String(value.execution_id),
					...(value.pair_id == null ? {} : { pairId: String(value.pair_id) }),
					rootClaimId: String(value.root_claim_id),
					homeLedger:
						value.home_ledger_scope === 'database'
							? { scope: 'database' as const }
							: { scope: 'schema' as const, schema: homeSchema },
				};
			});
		}),
	);
	return rows.flat();
}

type LedgerWriteMember = Omit<LedgerChainMember, 'controller' | 'recordedAt'>;

function quoteIdent(value: string, type: 'schema' | 'table' | 'alias'): string {
	validateIdentifier(value, type);
	return `"${value.replaceAll('"', '""')}"`;
}

function qualified(schema: string, table: string): string {
	return `${quoteIdent(schema, 'schema')}.${quoteIdent(table, 'table')}`;
}

function eventTable(target: PgLedgerTarget): string {
	return qualified(ledgerSchema(target), DBSP_LEDGER_EVENT_TABLE);
}

function reservationTable(target: PgLedgerTarget): string {
	return qualified(ledgerSchema(target), DBSP_LEDGER_RESERVATION_TABLE);
}

function ledgerSchema(target: PgLedgerTarget): string {
	if (target.scope === 'database') return DBSP_META_SCHEMA;
	if (!target.schema)
		throw new Error('schema ledger target is missing its schema');
	return target.schema;
}

function addressColumns(prefix = ''): string {
	return [
		`${prefix}address_engine`,
		`${prefix}address_database`,
		`${prefix}address_schema`,
		`${prefix}address_parent`,
		`${prefix}address_kind`,
		`${prefix}address_name`,
	].join(', ');
}

function addressValues(member: LedgerWriteMember): readonly unknown[] {
	return [
		member.address.engine,
		member.address.database,
		// PostgreSQL MATCH SIMPLE skips a composite foreign key containing NULL.
		// The empty spelling keeps database-scoped addresses non-null, so the
		// same-address predecessor constraint is enforced for them too.
		member.address.schema ?? '',
		JSON.stringify(member.address.parent ?? null),
		member.address.kind,
		member.address.name,
	];
}

function assertTargetMatchesAddress(
	target: PgLedgerTarget,
	member: Pick<LedgerWriteMember, 'address'>,
): void {
	if (member.address.scope !== target.scope) {
		throw new Error(
			`ledger target ${target.scope} does not match ${member.address.scope}-scoped address ${member.address.name}`,
		);
	}
	if (
		target.scope === 'schema' &&
		(target.schema !== member.address.schema || !target.schema)
	) {
		throw new Error(
			`ledger target schema ${String(target.schema)} does not match address schema ${String(member.address.schema)} for ${member.address.name}`,
		);
	}
}

function targetForAddress(
	address: LedgerReservationRow['address'],
): PgLedgerTarget {
	if (address.scope === 'database') return { scope: 'database' };
	if (!address.schema) {
		throw new Error(
			`schema-scoped reservation ${address.name} is missing its schema`,
		);
	}
	return { scope: 'schema', schema: address.schema };
}

function ensureClaimEvent(
	kind: LedgerEventKind,
): asserts kind is LedgerClaimKind {
	if (!CLAIM_EVENT_KINDS.has(kind)) {
		throw new Error(`ledger event ${kind} is not a claim event`);
	}
}

function ensureResolutionEvent(kind: LedgerEventKind): void {
	if (!RESOLUTION_EVENT_KINDS.has(kind)) {
		throw new Error(`ledger event ${kind} is not a resolution event`);
	}
}

function memberValues(member: LedgerWriteMember): readonly unknown[] {
	return [
		member.eventId,
		...addressValues(member),
		member.executionId ?? null,
		member.plannedClaimKey ?? null,
		member.claimGroupId ?? null,
		member.rootClaimId ?? null,
		member.catalogueIdentity ? JSON.stringify(member.catalogueIdentity) : null,
		member.eventKind,
		member.predecessor ?? null,
		member.pairId ?? null,
		member.declared ? JSON.stringify(member.declared.value) : null,
		member.declared?.digest ?? null,
		member.observed ? JSON.stringify(member.observed.value) : null,
		member.observed?.digest ?? null,
		member.refusal?.code ?? null,
		member.refusal?.cause ?? null,
		member.refusal?.state ?? null,
		member.refusal?.withheldAuthority ?? null,
		member.refusal?.resolvingCommand ?? null,
	];
}

function eventInsertSql(target: PgLedgerTarget): string {
	return `INSERT INTO ${eventTable(target)} (event_id, ${addressColumns()}, execution_id, planned_claim_key, claim_group_id, root_claim_id, catalogue_identity, event_kind, predecessor, pair_id, declared, declared_digest, observed, observed_digest, refusal_code, refusal_cause, refusal_state, refusal_withheld_authority, refusal_resolving_command) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16::jsonb, $17, $18::jsonb, $19, $20, $21, $22, $23, $24) RETURNING event_id`;
}

export function renderCreateLedgerEventTableSql(
	target: PgLedgerTarget,
): string {
	const definition = PG_LEDGER_SPEC.find(
		(table) => table.name === DBSP_LEDGER_EVENT_TABLE,
	);
	if (!definition) throw new Error('ledger event definition is missing');
	return renderCreateLedgerTableFromSpec(target, definition);
}

export function renderCreateLedgerTerminalMemberIndexSql(
	target: PgLedgerTarget,
): string {
	const definition = PG_LEDGER_SPEC.find(
		(table) => table.name === DBSP_LEDGER_EVENT_TABLE,
	);
	const index = definition?.indexes?.[0];
	if (!index)
		throw new Error('ledger terminal-member index definition is missing');
	return renderCreateLedgerIndexFromSpec(target, definition, index);
}

export function renderCreateLedgerReservationTableSql(
	target: PgLedgerTarget,
): string {
	const definition = PG_LEDGER_SPEC.find(
		(table) => table.name === DBSP_LEDGER_RESERVATION_TABLE,
	);
	if (!definition) throw new Error('ledger reservation definition is missing');
	return renderCreateLedgerTableFromSpec(target, definition);
}

export function renderCreateLedgerIdentityTableSql(
	target: PgLedgerTarget,
): string {
	const definition = PG_LEDGER_SPEC.find(
		(table) => table.name === DBSP_LEDGER_IDENTITY_TABLE,
	);
	if (!definition) throw new Error('ledger identity definition is missing');
	return renderCreateLedgerTableFromSpec(target, definition);
}

export function renderCreateLedgerMarkerTableSql(
	target: PgLedgerTarget,
): string {
	const definition = PG_LEDGER_SPEC.find(
		(table) => table.name === DBSP_LEDGER_MARKER_TABLE,
	);
	if (!definition) throw new Error('ledger marker definition is missing');
	return renderCreateLedgerTableFromSpec(target, definition);
}

export function renderCreateLedgerImmutabilityFunctionSql(
	target: PgLedgerTarget,
): string {
	return renderCreateLedgerImmutabilityFunctionFromSpec(target);
}

export function renderCreateLedgerImmutabilityTriggerSql(
	target: PgLedgerTarget,
): string {
	return renderCreateLedgerImmutabilityTriggerFromSpec(target);
}

/** Proves the PG 15 requirement before emitting a NULLS NOT DISTINCT table. */
export async function ensurePgLedgerStorageVersion(
	executor: TransitionJournalQueryable,
): Promise<void> {
	const raw = (await executor.query('SHOW server_version_num')).rows[0]
		?.server_version_num;
	const version = Number(raw);
	if (
		!Number.isSafeInteger(version) ||
		version < PG_LEDGER_MIN_SERVER_VERSION_NUM
	) {
		throw new PgLedgerStorageUnsupportedError(raw);
	}
}

export async function ensurePgLedger(
	executor: TransitionJournalQueryable,
	target: PgLedgerTarget,
	options: { readonly writeMarker?: boolean } = {},
): Promise<void> {
	await ensurePgLedgerStorageVersion(executor);
	await executor.query(renderCreateLedgerEventTableSql(target));
	await executor.query(renderCreateLedgerTerminalMemberIndexSql(target));
	await executor.query(renderCreateLedgerReservationTableSql(target));
	await executor.query(renderCreateLedgerIdentityTableSql(target));
	await executor.query(renderCreateLedgerMarkerTableSql(target));
	if (options.writeMarker !== false)
		await writePgLedgerShapeMarker(executor, target);
	await executor.query(renderCreateLedgerImmutabilityFunctionSql(target));
	await executor.query(renderCreateLedgerImmutabilityTriggerSql(target));
}

export async function ensureDbspMetaLedger(
	executor: TransitionJournalQueryable,
	options: { readonly writeMarker?: boolean } = {},
): Promise<void> {
	await executor.query(
		`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(DBSP_META_SCHEMA, 'schema')}`,
	);
	await ensurePgLedger(executor, { scope: 'database' }, options);
}

/** Writes the marker separately when a cutover must make it the final step. */
export async function writePgLedgerShapeMarker(
	executor: TransitionJournalQueryable,
	target: PgLedgerTarget,
): Promise<void> {
	await executor.query(
		`INSERT INTO ${qualified(ledgerSchema(target), DBSP_LEDGER_MARKER_TABLE)} (id, version) VALUES (true, $1) ON CONFLICT (id) DO NOTHING`,
		[PG_LEDGER_SHAPE_VERSION],
	);
}

/** Records lineage once; a mismatching identity is an admission concern of unit 5. */
export async function recordPgLedgerIdentity(
	executor: TransitionJournalQueryable,
	target: PgLedgerTarget,
	identity: LedgerIdentity,
): Promise<void> {
	await executor.query(
		`INSERT INTO ${qualified(ledgerSchema(target), DBSP_LEDGER_IDENTITY_TABLE)} (id, cluster_system_identifier, database_oid, namespace_oid) VALUES (true, $1, $2, $3) ON CONFLICT (id) DO NOTHING`,
		[
			identity.clusterSystemIdentifier,
			identity.databaseOid,
			identity.namespaceOid ?? null,
		],
	);
}

export async function appendPgLedgerProgress(
	executor: TransitionJournalQueryable,
	target: PgLedgerTarget,
	member: LedgerWriteMember,
): Promise<void> {
	assertTargetMatchesAddress(target, member);
	if (
		member.eventKind !== 'executing' &&
		member.eventKind !== 'indeterminate'
	) {
		throw new Error(
			`ledger event ${member.eventKind} changes reservation state; use the claim or resolution append primitive`,
		);
	}
	await classifyPgWrite(() =>
		executor.query(eventInsertSql(target), memberValues(member)),
	);
}

/**
 * Appends the root claim and every reservation in one PostgreSQL statement.
 * Callers can include this statement in a larger DDL transaction, but cannot
 * accidentally split this claim's append from its durable reservation rows.
 */
export async function appendPgLedgerClaim(
	executor: TransitionJournalQueryable,
	target: PgLedgerTarget,
	member: LedgerWriteMember,
	reservations: readonly LedgerReservationRow[],
	reservationRootClaimId = member.eventId,
): Promise<void> {
	assertTargetMatchesAddress(target, member);
	ensureClaimEvent(member.eventKind);
	if (reservations.length === 0) {
		throw new Error(
			`ledger claim ${member.eventId} has an empty effects closure`,
		);
	}
	const reservationsByLedger = new Map<
		string,
		{
			target: PgLedgerTarget;
			rows: LedgerReservationRow[];
		}
	>();
	for (const reservation of reservations) {
		if (reservation.claimKind !== member.eventKind) {
			throw new Error(
				`ledger reservation ${reservation.address.name} claim kind does not match claim ${member.eventId}`,
			);
		}
		if (reservation.rootClaimId !== reservationRootClaimId) {
			throw new Error(
				`ledger reservation ${reservation.address.name} is not anchored to claim group ${reservationRootClaimId}`,
			);
		}
		if (
			reservation.homeLedger.scope !== target.scope ||
			reservation.homeLedger.schema !== target.schema
		) {
			throw new Error(
				`ledger reservation ${reservation.address.name} does not name claim ${member.eventId}'s home ledger`,
			);
		}
		const reservationTarget = targetForAddress(reservation.address);
		const key = `${reservationTarget.scope}:${reservationTarget.schema ?? ''}`;
		const group = reservationsByLedger.get(key) ?? {
			target: reservationTarget,
			rows: [],
		};
		group.rows.push(reservation);
		reservationsByLedger.set(key, group);
	}
	const values = [...memberValues(member)] as unknown[];
	const reservationInserts = [...reservationsByLedger.values()].map((group) => {
		const rows = group.rows.map((reservation) => {
			const start = values.length + 1;
			values.push(
				...addressValues({ address: reservation.address } as LedgerWriteMember),
				reservation.claimKind,
				reservation.executionId,
				reservation.pairId ?? null,
				reservation.rootClaimId,
				reservation.homeLedger.scope,
				reservation.homeLedger.schema ?? null,
			);
			return `($${start}, $${start + 1}, $${start + 2}, $${start + 3}::jsonb, $${start + 4}, $${start + 5}, $${start + 6}, $${start + 7}, $${start + 8}, $${start + 9}, $${start + 10}, $${start + 11})`;
		});
		return `INSERT INTO ${reservationTable(group.target)} (${addressColumns()}, claim_kind, execution_id, pair_id, root_claim_id, home_ledger_scope, home_ledger_schema) VALUES ${rows.join(', ')} RETURNING root_claim_id`;
	});
	const [lastReservationInsert] = reservationInserts.slice(-1);
	const leadingReservationInserts = reservationInserts.slice(0, -1);
	await classifyPgWrite(() =>
		executor.query(
			`WITH appended AS (${eventInsertSql(target)})${leadingReservationInserts.map((insert, index) => `, reserved_${index} AS (${insert})`).join('')} ${lastReservationInsert}`,
			values,
		),
	);
}

/**
 * Appends an entire destructive closure as one ledger group.  The caller owns
 * the surrounding locked transaction; consequently a failed member insert
 * rolls back the root, every member and every reservation together.
 */
export async function appendPgLedgerClaimGroup(
	executor: TransitionJournalQueryable,
	root: LedgerWriteMember,
	members: readonly LedgerWriteMember[],
	reservations: readonly LedgerReservationRow[],
): Promise<void> {
	const claims = [root, ...members];
	if (claims.length < 2)
		throw new Error(
			'ledger claim group requires a root and at least one member',
		);
	if (reservations.length !== claims.length)
		throw new Error(
			'ledger claim group requires exactly one reservation per claim',
		);
	const byAddress = new Map<string, LedgerWriteMember>();
	const addressKey = (member: Pick<LedgerWriteMember, 'address'>) =>
		JSON.stringify(addressValues(member as LedgerWriteMember));
	for (const claim of claims) {
		ensureClaimEvent(claim.eventKind);
		assertTargetMatchesAddress(targetForAddress(claim.address), claim);
		const key = addressKey(claim);
		if (byAddress.has(key))
			throw new Error(
				`ledger claim group repeats address ${claim.address.name}`,
			);
		byAddress.set(key, claim);
	}
	for (const reservation of reservations) {
		const claim = byAddress.get(addressKey({ address: reservation.address }));
		if (!claim)
			throw new Error(
				`ledger claim group reservation ${reservation.address.name} has no claim`,
			);
		if (reservation.rootClaimId !== root.eventId)
			throw new Error(
				`ledger claim group reservation ${reservation.address.name} is not anchored to root ${root.eventId}`,
			);
		if (reservation.claimKind !== claim.eventKind)
			throw new Error(
				`ledger claim group reservation ${reservation.address.name} claim kind does not match its claim`,
			);
	}
	for (const claim of claims) {
		const reservation = reservations.find(
			(candidate) =>
				addressKey({ address: candidate.address }) === addressKey(claim),
		);
		if (!reservation)
			throw new Error(
				`ledger claim group claim ${claim.eventId} has no reservation`,
			);
		await appendPgLedgerClaim(
			executor,
			targetForAddress(claim.address),
			claim,
			[reservation],
			root.eventId,
		);
	}
}

/** Resolves every closure terminal in the caller's one locked transaction. */
export async function appendPgLedgerResolutionGroup(
	executor: TransitionJournalQueryable,
	rootClaimId: string,
	members: readonly LedgerWriteMember[],
	reservations: readonly Pick<LedgerReservationRow, 'address'>[],
): Promise<void> {
	if (members.length < 2)
		throw new Error(
			'ledger resolution group requires a root and at least one member',
		);
	if (reservations.length !== members.length)
		throw new Error(
			'ledger resolution group requires exactly one reservation per terminal',
		);
	const addressKey = (member: Pick<LedgerWriteMember, 'address'>) =>
		JSON.stringify(addressValues(member as LedgerWriteMember));
	const memberAddresses = new Set<string>();
	for (const member of members) {
		ensureResolutionEvent(member.eventKind);
		const key = addressKey(member);
		if (memberAddresses.has(key))
			throw new Error(
				`ledger resolution group repeats address ${member.address.name}`,
			);
		memberAddresses.add(key);
	}
	for (const reservation of reservations) {
		if (!memberAddresses.has(addressKey(reservation)))
			throw new Error(
				`ledger resolution group reservation ${reservation.address.name} has no terminal`,
			);
	}
	const [root, ...containedMembers] = members;
	if (!root) throw new Error('ledger resolution group has no root terminal');
	// The group owns its whole reservation closure.  Its first append releases
	// every reservation under the shared transaction; later terminal appends
	// therefore deliberately expect an empty deletion effect.
	await appendPgLedgerResolution(
		executor,
		targetForAddress(root.address),
		root,
		rootClaimId,
		reservations,
	);
	for (const member of containedMembers) {
		await appendPgLedgerResolution(
			executor,
			targetForAddress(member.address),
			member,
			rootClaimId,
			[],
		);
	}
}

/**
 * Appends a terminal member and releases the reservations owned by this
 * append atomically. A group-owned contained member has an intentionally
 * empty closure because its group's root append already released it.
 */
export async function appendPgLedgerResolution(
	executor: TransitionJournalQueryable,
	target: PgLedgerTarget,
	member: LedgerWriteMember,
	rootClaimId: string,
	reservations: readonly Pick<LedgerReservationRow, 'address'>[],
): Promise<void> {
	assertTargetMatchesAddress(target, member);
	ensureResolutionEvent(member.eventKind);
	if (member.eventKind === 'refused' && member.refusal === undefined)
		throw new Error(
			`ledger refusal ${member.eventId} is missing its durable refusal protocol`,
		);
	if (member.eventKind !== 'refused' && member.refusal !== undefined)
		throw new Error(
			`ledger event ${member.eventId} carries a refusal protocol but is not refused`,
		);
	const values = [...memberValues(member)] as unknown[];
	const rootClaimIdParameter = values.length + 1;
	if (reservations.length > 0) values.push(rootClaimId);
	const reservationsByLedger = new Map<
		string,
		{
			target: PgLedgerTarget;
			rows: Pick<LedgerReservationRow, 'address'>[];
		}
	>();
	for (const reservation of reservations) {
		const reservationTarget = targetForAddress(reservation.address);
		const key = `${reservationTarget.scope}:${reservationTarget.schema ?? ''}`;
		const group = reservationsByLedger.get(key) ?? {
			target: reservationTarget,
			rows: [],
		};
		group.rows.push(reservation);
		reservationsByLedger.set(key, group);
	}
	const reservationDeletes = [...reservationsByLedger.values()].map((group) => {
		const addressPredicates = group.rows.map((reservation) => {
			const start = values.length + 1;
			values.push(
				...addressValues({ address: reservation.address } as LedgerWriteMember),
			);
			return `(${addressColumns('r.')}) = ($${start}, $${start + 1}, $${start + 2}, $${start + 3}::jsonb, $${start + 4}, $${start + 5})`;
		});
		return `DELETE FROM ${reservationTable(group.target)} r WHERE r.root_claim_id = $${rootClaimIdParameter} AND (${addressPredicates.join(' OR ')}) RETURNING r.root_claim_id`;
	});
	const deletedCtes = reservationDeletes.map(
		(deletion, index) => `released_${index} AS (${deletion})`,
	);
	const deletedCount =
		deletedCtes.length === 0
			? '0::int'
			: `(${deletedCtes.map((_, index) => `(SELECT count(*)::int FROM released_${index})`).join(' + ')})`;
	const result = await classifyPgWrite(() =>
		executor.query(
			`WITH appended AS (${eventInsertSql(target)})${deletedCtes.length === 0 ? '' : `, ${deletedCtes.join(', ')}`} SELECT (SELECT count(*)::int FROM appended) AS appended_count, ${deletedCount} AS deleted_count`,
			values,
		),
	);
	const row = result.rows[0];
	const appended = Number(row?.appended_count);
	const deleted = Number(row?.deleted_count);
	// Query-only unit doubles predate the CTE's count projection. They prove SQL
	// construction but cannot attest row counts; real PostgreSQL rows are always
	// checked fail-closed below.
	if (row?.appended_count === undefined && row?.deleted_count === undefined)
		return;
	if (appended !== 1 || deleted !== reservations.length)
		throw new Error(
			`ledger resolution ${member.eventId} refused: appended ${appended} terminal rows but deleted ${deleted}/${reservations.length} reservations`,
		);
}

/**
 * `released` has no claim spelling in the closed event grammar. It is the
 * deliberate atomic managed-to-unknown transition, so it must not invent an
 * empty reservation closure merely to reuse ordinary claim resolution.
 */
export async function appendPgLedgerRelease(
	executor: TransitionJournalQueryable,
	target: PgLedgerTarget,
	member: LedgerWriteMember,
): Promise<void> {
	assertTargetMatchesAddress(target, member);
	if (member.eventKind !== 'released')
		throw new Error('ledger release append requires a released event');
	await classifyPgWrite(() =>
		executor.query(eventInsertSql(target), memberValues(member)),
	);
}

function orderedLedgerHomes(
	homes: readonly LedgerHome[],
): readonly LedgerHome[] {
	const byKey = new Map<string, LedgerHome>();
	for (const home of homes) {
		if (home.scope === 'schema' && !home.schema) {
			throw new Error('schema ledger lock target is missing its schema');
		}
		const key = home.scope === 'database' ? '0' : `1:${home.schema}`;
		byKey.set(key, home);
	}
	return [...byKey.entries()]
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([, home]) => home);
}

function ledgerLockKey(home: LedgerHome): string {
	return createHash('sha256')
		.update('dbsp.managed-ledger.lock.v1:\0')
		.update(home.scope === 'database' ? DBSP_META_SCHEMA : (home.schema ?? ''))
		.digest()
		.readBigInt64BE(0)
		.toString();
}

/**
 * Transaction-scoped, non-waiting locks for one effects closure. The ordering
 * is dbsp_meta first and then schema name, so opposing closures cannot deadlock.
 */
export async function acquirePgLedgerLocks(
	executor: TransitionJournalQueryable,
	homes: readonly LedgerHome[],
): Promise<PgLedgerLockResult> {
	for (const home of orderedLedgerHomes(homes)) {
		try {
			const result = await executor.query(
				'SELECT pg_catalog.pg_try_advisory_xact_lock($1::bigint) AS locked',
				[ledgerLockKey(home)],
			);
			if (result.rows[0]?.locked !== true)
				return { kind: 'busy', ledger: home };
		} catch (error) {
			return { kind: 'refused', ledger: home, error };
		}
	}
	const result = { kind: 'acquired' as const } as PgLedgerLockResult;
	// Keep the historical result's enumerable shape: callers branch on `kind`,
	// while only the new evidence constructor needs the opaque proof.
	Object.defineProperty(result, 'proof', {
		value: mintPgOrderedLedgerLocks(homes),
		enumerable: false,
	});
	return result;
}
