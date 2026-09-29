import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
	canonicalJsonDigest,
	defaultIndexName,
	projectLedgerChain,
	validateDeclarationModel,
	validateNormalizedManagedStepManifest,
} from '@dbsp/core';
import { mintDurablyLoadedRun } from '@dbsp/core/internal';
import type {
	ColumnIR,
	DbCasing,
	ForeignKeyIR,
	IndexIR,
	LedgerAddress,
	LedgerHome,
	ModelIR,
	NormalizedManagedStep,
	SequenceIR,
	TableIR,
	TransitionRunMetadata,
} from '@dbsp/types';
import type { Pool, PoolClient } from 'pg';
import { hasDeclaredFkIndexAdmission } from '../ddl/fk-index-coverage.js';
import {
	createPgsqlGeneratedManagedStep,
	generateMigrationSQL,
	type SchemaChange,
} from '../ddl/index.js';
import {
	canonicalColumnSet,
	isQualifyingUniqueIndex,
	sameColumnSet,
} from '../ddl/key-column-set.js';
import {
	comparePgsqlDeclaredAdoptionSchema,
	modelForDeclaredAdoption,
} from '../ddl/live-diff.js';
import {
	addressForChange,
	createPgsqlDeclaredAdoptionStep,
	createPgsqlDeclaredSequenceAdoptionStep,
} from '../ddl/managed-step-manifest.js';
import { getPhase } from '../ddl/migration-sql.js';
import { mapColumnType } from '../ddl/type-mapping.js';
import { getNamingPluginForDbCasing } from '../naming-plugin.js';
import { physicalizeDeclaredSequences } from '../sequence-name.js';
import { escapeDiagnosticText } from '../validate.js';
import {
	PgApplicationStepError,
	type PgConvergeApplicationStep,
	planPgApplicationSteps,
	runPgApplicationSteps,
	validatePgConvergeApplicationSteps,
} from './application-step.js';
import { readPgCatalogueIdentity } from './catalogue-identity.js';
import { readPgLedgerAddressChain } from './chain-reader.js';
import { classifyPgDatabaseWritability } from './database-writability.js';
import { executeGeneratorPlan } from './generator-execution.js';
import { readTransitionRunIdsForExecutionIds } from './journal.js';
import {
	acquirePgLedgerSessionLock,
	ensurePgLedgerStorageVersion,
	PgLedgerStorageUnsupportedError,
	readPgLedgerReservationsForHome,
	releasePgLedgerSessionLock,
} from './ledger.js';
import { advisoryKey } from './lessor.js';
import {
	lockPgJournalRun,
	PgCommitAcknowledgementAmbiguousError,
	type PgLockedRun,
	readPgOutcomeSessionCompromise,
} from './outcome-protocol.js';
import {
	type PgLedgerScopeCurrency,
	readPgLedgerScopeCurrency,
	runPgConvergeInitializationPreflight,
} from './reinitialize-preflight.js';
import { pgDeclaredSequenceAdoptionShapeMatches } from './sequence-adoption.js';

export type PgConvergeRefusal =
	| 'invalid-options'
	| 'unsupported-change'
	| 'unmanaged-object'
	| 'unmanaged-parent'
	| 'concurrent-drift'
	| 'ledger-absent'
	| 'incompatible-ledger'
	| 'unsupported-server'
	| 'busy'
	| 'recovery-required'
	| 'database-read-only'
	| 'execution-refused'
	| 'adoption-refused'
	| 'application-step-changed'
	| 'application-step-failed'
	| 'initialization-refused';

export interface PgConvergeInitializationFailure {
	readonly home: LedgerHome;
	readonly code: string;
	readonly step: string;
	readonly detail: string;
}

/**
 * Unsupported-change, ledger and ownership refusals occur before converge commits
 * managed DDL. An execution refusal may follow a rolled-back transactional DDL
 * attempt, and comparison may use rollback-only scratch DDL.
 */
export class PgConvergeRefusalError extends Error {
	constructor(
		readonly refusal: PgConvergeRefusal,
		readonly changes: readonly Pick<
			SchemaChange,
			'kind' | 'table' | 'column' | 'details'
		>[],
		readonly detail?: string,
		readonly runIds?: readonly string[],
		readonly executionIds?: readonly string[],
		readonly busyRunIds?: readonly string[],
		readonly initialization?: PgConvergeInitializationFailure,
	) {
		super(detail ?? `converge refuses ${refusal}`);
		this.name = 'PgConvergeRefusalError';
	}
}

function isPgJournalLookupUnavailable(error: unknown): boolean {
	return (
		error !== null &&
		typeof error === 'object' &&
		'code' in error &&
		((error as { readonly code?: unknown }).code === '42501' ||
			(error as { readonly code?: unknown }).code === '42P01')
	);
}

function pgJournalLookupUnavailableCode(
	error: unknown,
): '42501' | '42P01' | undefined {
	if (!isPgJournalLookupUnavailable(error)) return undefined;
	return (error as { readonly code: '42501' | '42P01' }).code;
}

async function refuseForLiveReservations(
	client: PoolClient,
	schema: string,
	markSessionCompromised: () => void,
): Promise<void> {
	const reservations = await readPgLedgerReservationsForHome(
		client,
		schemaHome(schema),
	);
	if (reservations.length === 0) return;
	const executionIds = [...new Set(reservations.map((row) => row.executionId))];
	let mappings: ReadonlyMap<string, readonly string[]>;
	let unavailableJournalLookupCode: '42501' | '42P01' | undefined;
	try {
		mappings = await readTransitionRunIdsForExecutionIds(client, executionIds);
	} catch (error) {
		unavailableJournalLookupCode = pgJournalLookupUnavailableCode(error);
		if (!unavailableJournalLookupCode) {
			markSessionCompromised();
			throw error;
		}
		mappings = new Map();
	}
	const runIds = [...new Set([...mappings.values()].flat())];
	const unmappedExecutionIds = executionIds.filter(
		(executionId) =>
			unavailableJournalLookupCode !== '42501' && !mappings.has(executionId),
	);
	const unreadableJournalAttributionExecutionIds =
		unavailableJournalLookupCode === '42501' ? executionIds : [];
	const recoverableRunIds: string[] = [];
	const busyRunIds: string[] = [];
	for (const runId of runIds) {
		const key = advisoryKey(runId);
		const lock = await client
			.query('SELECT pg_catalog.pg_try_advisory_lock($1::bigint) AS locked', [
				key.toString(),
			])
			.catch((error: unknown) => {
				markSessionCompromised();
				throw error;
			});
		const acquired = lock.rows[0]?.locked;
		if (acquired !== true && acquired !== false) {
			markSessionCompromised();
			throw new Error('converge predecessor lock acquisition is indeterminate');
		}
		if (acquired === false) {
			busyRunIds.push(runId);
			continue;
		}
		const unlock = await client
			.query('SELECT pg_catalog.pg_advisory_unlock($1::bigint) AS unlocked', [
				key.toString(),
			])
			.catch((error: unknown) => {
				markSessionCompromised();
				throw error;
			});
		if (unlock.rows[0]?.unlocked !== true) {
			markSessionCompromised();
			throw new Error(
				'converge could not confirm predecessor run lock release',
			);
		}
		recoverableRunIds.push(runId);
	}
	const runList = (ids: readonly string[]) =>
		ids.map((id) => `run ${escapeDiagnosticText(id)}`).join(', ');
	const executionList = (ids: readonly string[]) =>
		ids.map((id) => `execution ${escapeDiagnosticText(id)}`).join(', ');
	const recoveryDetail = [
		...(busyRunIds.length === 0
			? []
			: [
					`${runList(busyRunIds)} ${busyRunIds.length === 1 ? 'is' : 'are'} still executing; call convergePg again after ${busyRunIds.length === 1 ? 'it finishes' : 'they finish'}`,
				]),
		...(recoverableRunIds.length === 0
			? []
			: [
					`reconcile ${runList(recoverableRunIds)}: call reconcilePgTransitionRun(pool, runId) or run \`dbsp reconcile --db <database> <run-id>\` once per run`,
				]),
		...(unmappedExecutionIds.length === 0
			? []
			: [
					`no journal run is recorded for ${executionList(unmappedExecutionIds)}; the ledger owner must resolve it`,
				]),
		...(unreadableJournalAttributionExecutionIds.length === 0
			? []
			: [
					`journal attribution for ${executionList(unreadableJournalAttributionExecutionIds)} could not be read (SQLSTATE 42501); the journal owner must resolve it`,
				]),
	].join('; ');
	throw new PgConvergeRefusalError(
		recoverableRunIds.length === 0 &&
			unmappedExecutionIds.length === 0 &&
			unreadableJournalAttributionExecutionIds.length === 0
			? 'busy'
			: 'recovery-required',
		[],
		`converge found live ledger reservations; ${recoveryDetail}`,
		recoverableRunIds,
		[...unmappedExecutionIds, ...unreadableJournalAttributionExecutionIds],
		busyRunIds,
	);
}

export type PgConvergeResult =
	| { readonly kind: 'no-drift'; readonly applied: readonly string[] }
	| { readonly kind: 'applied'; readonly applied: readonly string[] }
	| {
			readonly kind: 'partially-applied';
			readonly completedStepKeys: readonly string[];
			readonly notStartedStepKeys: readonly string[];
			readonly detail: string;
	  }
	| { readonly kind: 'transport-ambiguous'; readonly detail: string };

export type PgConvergePlannedStep =
	| {
			readonly stepKey: string;
			readonly order: number;
			readonly dependencyOrder: readonly string[];
			readonly address: NonNullable<NormalizedManagedStep['address']>;
			readonly kind: SchemaChange['kind'];
			readonly table: string;
			readonly column?: string;
			readonly details: string;
	  }
	| {
			readonly stepKey: string;
			readonly order: number;
			readonly dependencyOrder: readonly string[];
			readonly address: NonNullable<NormalizedManagedStep['address']>;
			readonly kind: 'adopt_table' | 'adopt_sequence';
	  }
	| {
			readonly kind: 'application-step';
			readonly id: string;
			readonly step: 'once';
			readonly inspected?: never;
			readonly stepKey?: never;
			readonly order?: never;
			readonly dependencyOrder?: never;
			readonly address?: never;
	  }
	| {
			readonly kind: 'application-step';
			readonly id: string;
			readonly step: 'assert';
			readonly inspected: boolean;
			readonly stepKey?: never;
			readonly order?: never;
			readonly dependencyOrder?: never;
			readonly address?: never;
	  };

export type PgConvergeCheckResult =
	| { readonly kind: 'no-drift' }
	| {
			readonly kind: 'would-apply';
			readonly planDigest: string;
			readonly steps: readonly PgConvergePlannedStep[];
	  };

export interface ConvergePgBaseOptions {
	readonly schema?: string;
	readonly dbCasing?: DbCasing;
	/**
	 * In apply mode, create a ledger for an absent schema ledger. `pristine`
	 * refuses declared live tables or standalone sequences; `adopt-existing`
	 * also adopts matching declared relations on every converge call. The schema
	 * itself must already exist. Defaults to `never`.
	 */
	readonly initialize?: 'never' | 'pristine' | 'adopt-existing';
	/**
	 * Exact physical PostgreSQL index names that converge must leave alone on
	 * declared model tables. Each table name uses the model's naming, while the
	 * index name is used verbatim. Entries are validated before connecting: they
	 * must be distinct, name declared tables, and must not equal the name of an
	 * index listed in any declared table's `indexes`. Converge never drops a
	 * live index named here. It does not check these names against the other
	 * relations the model creates (tables, sequences, primary-key or UNIQUE
	 * constraint indexes); PostgreSQL rejects such a collision when the step
	 * runs, and converge reports it as that step's failure.
	 */
	readonly externalIndexes?: readonly {
		readonly table: string;
		readonly name: string;
	}[];
	/**
	 * Transactional application-owned schema work. Recorded runs append
	 * `application-step:<id>` to `applied`, after generated change kinds.
	 * The transaction facade rejects leading transaction-control keywords; it is
	 * a correctness guard, not a security boundary for code in this process.
	 */
	readonly steps?: readonly PgConvergeApplicationStep[];
}

export interface ConvergePgOptions extends ConvergePgBaseOptions {
	readonly mode?: 'apply';
}

export interface ConvergePgCheckOptions extends ConvergePgBaseOptions {
	readonly mode: 'check';
}

type Queryable = Pick<PoolClient, 'query'>;

const lockedConvergeClients = new WeakSet<object>();

function schemaHome(schema: string): LedgerHome {
	return { scope: 'schema', schema };
}

function addressHome(address: LedgerAddress): LedgerHome {
	if (!address.schema)
		throw new Error(`converge address ${address.name} has no schema ledger`);
	return schemaHome(address.schema);
}

function refusal(
	kind: PgConvergeRefusal,
	changes: readonly SchemaChange[],
	detail: string,
): PgConvergeRefusalError {
	return new PgConvergeRefusalError(
		kind,
		changes.map((change) => ({
			kind: change.kind,
			table: change.table,
			...(change.column === undefined ? {} : { column: change.column }),
			details: change.details,
		})),
		detail,
	);
}

function invalidOptions(detail: string): PgConvergeRefusalError {
	return new PgConvergeRefusalError('invalid-options', [], detail);
}

const APPLICATION_STEP_DOLLAR_USER_SCHEMA_MESSAGE =
	'converge application steps do not support schema $user';

function initializationFailure(
	home: LedgerHome,
	code: string,
	step: string,
	detail: string,
): PgConvergeRefusalError {
	return new PgConvergeRefusalError(
		'initialization-refused',
		[],
		`converge initialization refuses ${home.scope === 'database' ? 'database' : home.schema}: ${detail}`,
		undefined,
		undefined,
		undefined,
		{ home, code, step, detail },
	);
}

function reportInitializationFailure(
	report: Awaited<ReturnType<typeof runPgConvergeInitializationPreflight>>,
): PgConvergeRefusalError | undefined {
	const failed = report.scopes.find((scope) => scope.outcome === 'failed');
	if (failed) {
		const code = failed.refusal?.code ?? 'reinitialize-preflight-failed';
		const detail = failed.refusal?.detail ?? failed.reason.message;
		if (code === 'reinitialize-preflight-advisory-lock')
			return new PgConvergeRefusalError('busy', [], detail);
		return initializationFailure(
			failed.ledger,
			code,
			failed.reason.step,
			detail,
		);
	}
	const notAttempted = report.scopes.find(
		(scope) => scope.outcome === 'not-attempted',
	);
	if (!notAttempted) return undefined;
	return initializationFailure(
		notAttempted.ledger,
		'reinitialize-preflight-failed',
		'output',
		'reinitialize-preflight did not attempt this scope',
	);
}

type DeclaredRelationNames = Readonly<{
	tables: ReadonlySet<string>;
	sequences: ReadonlySet<string>;
}>;

async function declaredRelationNames(
	client: PoolClient,
	schema: string,
	names: readonly string[],
): Promise<DeclaredRelationNames> {
	if (names.length === 0) return { tables: new Set(), sequences: new Set() };
	const result = await client.query(
		`SELECT relation.relname AS name, relation.relkind AS kind FROM pg_catalog.pg_class relation JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = $1 AND relation.relname = ANY($2::text[]) AND relation.relkind IN ('r', 'p', 'f', 'S')`,
		[schema, names],
	);
	const tables = new Set<string>();
	const sequences = new Set<string>();
	for (const row of result.rows) {
		if (typeof row.name !== 'string') continue;
		if (row.kind === 'r' || row.kind === 'p' || row.kind === 'f')
			tables.add(row.name);
		else if (row.kind === 'S') sequences.add(row.name);
	}
	return { tables, sequences };
}

function declaredIndexNames(
	model: ModelIR,
	naming: ReturnType<typeof getNamingPluginForDbCasing>,
): ReadonlySet<string> {
	return new Set(
		[...model.tables.values()].flatMap((table) => {
			const physicalTable = naming.toDatabase(table.name);
			return table.indexes.map((index) =>
				defaultIndexName(physicalTable, {
					...index,
					...(index.name === undefined
						? {}
						: { name: naming.toDatabase(index.name) }),
					columns: index.columns.map((column) => naming.toDatabase(column)),
				}),
			);
		}),
	);
}

function externalIndexKey(table: string, name: string): string {
	return JSON.stringify([table, name]);
}

/** Validate logical option entries and produce physical keys for diff matching. */
function validateExternalIndexes(
	model: ModelIR,
	options: ConvergePgBaseOptions,
	naming: ReturnType<typeof getNamingPluginForDbCasing>,
): ReadonlySet<string> {
	const supplied = options.externalIndexes;
	if (supplied === undefined) return new Set();
	if (!Array.isArray(supplied))
		throw invalidOptions('converge externalIndexes must be an array');

	const declaredTables = new Set(
		[...model.tables.values()].map((table) => table.name),
	);
	const declaredIndexes = declaredIndexNames(model, naming);
	const seen = new Set<string>();
	const externalIndexKeys = new Set<string>();
	for (const [position, entry] of supplied.entries()) {
		const label = `externalIndexes[${position}]`;
		if (
			entry === null ||
			typeof entry !== 'object' ||
			Array.isArray(entry) ||
			typeof entry.table !== 'string' ||
			entry.table.length === 0 ||
			typeof entry.name !== 'string' ||
			entry.name.length === 0
		)
			throw invalidOptions(
				`converge ${label} must be an object with non-empty string table and name fields`,
			);

		if (seen.has(entry.name))
			throw invalidOptions(
				`converge ${label} duplicates external index ${entry.name}`,
			);
		seen.add(entry.name);

		if (!declaredTables.has(entry.table))
			throw invalidOptions(
				`converge ${label} names undeclared table ${entry.table}`,
			);
		if (declaredIndexes.has(entry.name))
			throw invalidOptions(
				`converge ${label} names declared index ${entry.name}`,
			);
		externalIndexKeys.add(
			externalIndexKey(naming.toDatabase(entry.table), entry.name),
		);
	}
	return externalIndexKeys;
}

/**
 * Converge has one declaration-scoped, external-index-masked comparison.  The
 * same function is used before planning and again while the adoption claim is
 * open, preventing its admission check from drifting from the initial plan.
 */
async function compareConvergeMaskedSchema(input: {
	readonly executor: PoolClient;
	readonly model: ModelIR;
	readonly schema: string;
	readonly casing: DbCasing;
	readonly externalIndexes: ReadonlySet<string>;
}) {
	return comparePgsqlDeclaredAdoptionSchema({
		executor: input.executor,
		model: input.model,
		schema: input.schema,
		dbCasing: input.casing,
		externalIndexMask: input.externalIndexes,
	});
}

function startupSafeAddColumn(change: SchemaChange): boolean {
	if (change.kind !== 'add_column' || !change.meta?.column) return false;
	const column = change.meta.column;
	if (typeof column !== 'object' || Array.isArray(column)) return false;
	const record = column as Record<string, unknown>;
	// This is intentionally a positive shape allowlist. New ColumnIR surface
	// cannot become startup DDL until this list is deliberately reconsidered.
	if (
		!Object.keys(record).every((key) =>
			['name', 'type', 'nullable', 'js', 'originalDbType', 'default'].includes(
				key,
			),
		) ||
		[
			'logicalIdentity',
			'originalDbTypeSchema',
			'originalDbTypeSchemaScope',
			'unique',
			'uniqueConstraintName',
			'autoIncrement',
			'collation',
			'comment',
			'identity',
		].some((field) => record[field] !== undefined) ||
		typeof record.name !== 'string' ||
		typeof record.type !== 'string' ||
		typeof record.nullable !== 'boolean' ||
		(record.js !== undefined &&
			(typeof record.js !== 'string' || record.js.length === 0)) ||
		(record.originalDbType !== undefined &&
			(typeof record.originalDbType !== 'string' ||
				record.originalDbType.length === 0))
	)
		return false;

	const hasDefault = record.default !== undefined;
	const defaultIsLiteral =
		typeof record.default === 'boolean' ||
		(typeof record.default === 'number' && Number.isFinite(record.default)) ||
		(typeof record.default === 'string' && !record.default.endsWith('()'));
	return (
		(!hasDefault || defaultIsLiteral) &&
		((record.nullable === true && !hasDefault) ||
			(record.nullable === false && hasDefault))
	);
}

async function assertDefaultedColumnsUseBuiltInBaseTypesOrEnums(
	client: Queryable,
	changes: readonly SchemaChange[],
	schema: string,
): Promise<void> {
	for (const change of changes) {
		if (change.kind !== 'add_column' || !change.meta?.column) continue;
		const column = change.meta.column;
		if (typeof column !== 'object' || Array.isArray(column)) continue;
		const record = column as Record<string, unknown>;
		if (record.default === undefined) continue;

		const typeName = mapColumnType(column as ColumnIR, schema);
		const type = (
			await client.query<{
				readonly typtype: string;
				readonly is_pg_catalog: boolean;
			}>(
				"SELECT t.typtype, t.typnamespace = 'pg_catalog'::pg_catalog.regnamespace AS is_pg_catalog FROM pg_catalog.pg_type t WHERE t.oid = pg_catalog.to_regtype($1)",
				[typeName],
			)
		).rows[0];
		if (
			type === undefined ||
			(type.typtype !== 'e' && (type.typtype !== 'b' || !type.is_pg_catalog))
		)
			throw refusal(
				'unsupported-change',
				[change],
				`converge refuses defaulted column ${record.name} with ${type?.typtype ?? 'unresolvable'} type ${typeName}`,
			);
	}
}

function generatedAddress(
	change: SchemaChange,
	database: string,
	schema: string,
): LedgerAddress {
	return addressForChange({ change, database, schema });
}

function referencedTableAddress(
	change: SchemaChange,
	database: string,
	schema: string,
): LedgerAddress | undefined {
	const fk = change.meta?.fk;
	if (!fk || typeof fk !== 'object' || Array.isArray(fk)) return undefined;
	const references = (fk as Record<string, unknown>).references;
	if (
		!references ||
		typeof references !== 'object' ||
		Array.isArray(references)
	)
		return undefined;
	const record = references as Record<string, unknown>;
	if (typeof record.table !== 'string' || record.table.length === 0)
		return undefined;
	if (record.schema !== undefined && typeof record.schema !== 'string')
		return undefined;
	return {
		scope: 'schema',
		engine: 'postgresql',
		database,
		schema: record.schema ?? schema,
		kind: 'table',
		name: record.table,
	};
}

function additiveChange(
	change: SchemaChange,
	database: string,
	schema: string,
	createdTableAddresses: ReadonlySet<string>,
): boolean {
	if (change.kind === 'create_table') return true;
	if (change.kind === 'add_column') return startupSafeAddColumn(change);
	if (change.kind === 'create_sequence') return true;
	if (
		change.kind !== 'create_index' &&
		change.kind !== 'add_check_constraint' &&
		change.kind !== 'add_foreign_key'
	)
		return false;
	if (isUnnamedExpressionOnlyIndex(change))
		throw refusal(
			'unsupported-change',
			[change],
			`converge refuses unnamed expression-only index on ${change.table}; name the index`,
		);
	const address = generatedAddress(change, database, schema);
	const parent = parentAddress(address);
	if (
		(change.kind === 'create_index' ||
			change.kind === 'add_check_constraint') &&
		parent
	)
		return createdTableAddresses.has(canonicalJsonDigest(parent));
	if (change.kind === 'add_foreign_key' && parent) {
		const referenced = referencedTableAddress(change, database, schema);
		return (
			referenced !== undefined &&
			createdTableAddresses.has(canonicalJsonDigest(parent)) &&
			createdTableAddresses.has(canonicalJsonDigest(referenced))
		);
	}
	return false;
}

function parentAddress(address: LedgerAddress): LedgerAddress | undefined {
	if (
		address.kind !== 'column' &&
		address.kind !== 'index' &&
		address.kind !== 'constraint'
	)
		return undefined;
	const parent = address.parent;
	if (!parent) return undefined;
	return {
		scope: address.scope,
		engine: parent.engine,
		database: parent.database,
		...(parent.schema === undefined ? {} : { schema: parent.schema }),
		...(parent.parent === undefined ? {} : { parent: parent.parent }),
		kind: parent.kind,
		name: parent.name,
	};
}

function mintPgConvergeLockedRun(
	client: PoolClient,
	run: TransitionRunMetadata,
): PgLockedRun {
	if (!lockedConvergeClients.has(client))
		throw new Error('converge witness requires the held schema ledger lock');
	return lockPgJournalRun(mintDurablyLoadedRun(run));
}

async function databaseId(client: Queryable): Promise<string> {
	const database = (
		await client.query('SELECT current_database() AS database_id')
	).rows[0]?.database_id;
	if (typeof database !== 'string' || database.length === 0)
		throw new Error('converge could not read PostgreSQL database identity');
	return database;
}

type ManagedCurrent = 'managed' | 'unmanaged' | 'absent';

type DeclaredAdoptionAdmission =
	| { readonly kind: 'managed' }
	| {
			readonly kind: 'unknown';
			readonly catalogueIdentity: NonNullable<
				LedgerAddress['catalogueIdentity']
			>;
	  }
	| { readonly kind: 'absent' }
	| { readonly kind: 'refused' };

/** Read one catalogue identity and classify its corresponding ledger terminal. */
async function isManagedCurrent(
	client: PoolClient,
	address: LedgerAddress,
): Promise<ManagedCurrent> {
	const live = await readPgCatalogueIdentity(client, address);
	if (!live?.catalogueIdentity) return 'absent';
	const chain = await readPgLedgerAddressChain(
		client,
		addressHome(address),
		address,
	);
	const state = projectLedgerChain(chain);
	return state.kind === 'projected-ledger-chain' &&
		state.stableState === 'managed' &&
		isDeepStrictEqual(
			chain.terminalMember?.catalogueIdentity,
			live.catalogueIdentity,
		)
		? 'managed'
		: 'unmanaged';
}

/**
 * Admission for a declared adoption is deliberately narrower than ordinary
 * ownership: adopt-intent opens only from a projected unknown ledger state.
 */
async function declaredAdoptionAdmission(
	client: PoolClient,
	address: LedgerAddress,
): Promise<DeclaredAdoptionAdmission> {
	const live = await readPgCatalogueIdentity(client, address);
	if (!live?.catalogueIdentity) return { kind: 'absent' };
	const chain = await readPgLedgerAddressChain(
		client,
		addressHome(address),
		address,
	);
	const state = projectLedgerChain(chain);
	if (state.kind !== 'projected-ledger-chain') return { kind: 'refused' };
	if (state.stableState === 'unknown')
		return { kind: 'unknown', catalogueIdentity: live.catalogueIdentity };
	if (
		state.stableState === 'managed' &&
		isDeepStrictEqual(
			chain.terminalMember?.catalogueIdentity,
			live.catalogueIdentity,
		)
	)
		return { kind: 'managed' };
	return { kind: 'refused' };
}

function declaredAdoptionTable(
	model: ModelIR,
	naming: ReturnType<typeof getNamingPluginForDbCasing>,
	address: LedgerAddress,
): TableIR {
	const table = [...model.tables.values()].find(
		(candidate) => naming.toDatabase(candidate.name) === address.name,
	);
	if (!table)
		throw new Error(
			`converge adoption step for ${address.name} has no declared table`,
		);
	return table;
}

async function assertOwnedChange(
	client: PoolClient,
	change: SchemaChange,
	step: NormalizedManagedStep,
	createdTableAddresses: ReadonlySet<string>,
	previouslyCreatedAddresses: ReadonlySet<string>,
	laterCreatedAddresses: ReadonlySet<string>,
): Promise<void> {
	const address = step.address;
	if (!address) throw new Error(`converge step ${step.stepKey} has no address`);
	const parent = parentAddress(address);
	const requiresCreatedParent =
		change.kind === 'create_index' ||
		change.kind === 'add_check_constraint' ||
		change.kind === 'add_foreign_key';
	if (
		parent &&
		requiresCreatedParent &&
		!createdTableAddresses.has(canonicalJsonDigest(parent))
	)
		throw refusal(
			'unsupported-change',
			[change],
			`converge refuses ${change.kind} on a table not created by this run`,
		);
	if (
		parent &&
		!requiresCreatedParent &&
		!previouslyCreatedAddresses.has(canonicalJsonDigest(parent))
	) {
		if (laterCreatedAddresses.has(canonicalJsonDigest(parent)))
			throw refusal(
				'unmanaged-parent',
				[change],
				`converge refuses ${change.kind} because parent ${parent.name} is created later in the manifest`,
			);
		if ((await isManagedCurrent(client, parent)) !== 'managed')
			throw refusal(
				'unmanaged-parent',
				[change],
				`converge refuses ${change.kind} on unmanaged parent ${parent.name}`,
			);
	}
	if ((await isManagedCurrent(client, address)) === 'unmanaged')
		throw refusal(
			'unmanaged-object',
			[change],
			`converge refuses unmanaged live ${address.kind} ${address.name}`,
		);
}

async function assertExistingDeclaredTablesManaged(
	client: PoolClient,
	database: string,
	schema: string,
	model: ModelIR,
	casing: DbCasing,
	createdTables: ReadonlySet<string>,
	adoptedTables: ReadonlySet<string>,
): Promise<void> {
	const naming = getNamingPluginForDbCasing(casing);
	for (const table of model.tables.values()) {
		const address: LedgerAddress = {
			scope: 'schema',
			engine: 'postgresql',
			database,
			schema,
			kind: 'table',
			name: naming.toDatabase(table.name),
		};
		// An absent table has a create_table change and is admitted as fresh work;
		// an adoption step separately owns the sole unmanaged-table exception.
		if (createdTables.has(address.name) || adoptedTables.has(address.name))
			continue;
		const managed = await isManagedCurrent(client, address);
		if (managed === 'absent')
			throw refusal(
				'concurrent-drift',
				[],
				`converge observed declared table ${address.name} absent after comparison`,
			);
		if (managed === 'unmanaged')
			throw refusal(
				'unmanaged-object',
				[],
				`converge refuses unmanaged live table ${address.name}`,
			);
	}
}

async function assertExistingDeclaredSequencesManaged(
	client: PoolClient,
	database: string,
	schema: string,
	sequences: ReadonlyMap<string, SequenceIR>,
	createdSequenceAddresses: ReadonlySet<string>,
	adoptedSequenceAddresses: ReadonlySet<string>,
): Promise<void> {
	for (const sequence of sequences.values()) {
		const address = generatedAddress(
			{
				kind: 'create_sequence',
				table: '',
				destructive: false,
				details: `Create sequence ${sequence.name}`,
				meta: { sequence },
			},
			database,
			schema,
		);
		if (
			createdSequenceAddresses.has(canonicalJsonDigest(address)) ||
			adoptedSequenceAddresses.has(canonicalJsonDigest(address))
		)
			continue;
		const managed = await isManagedCurrent(client, address);
		if (managed === 'absent')
			throw refusal(
				'concurrent-drift',
				[],
				`converge observed declared sequence ${address.name} absent after comparison`,
			);
		if (managed === 'unmanaged')
			throw refusal(
				'unmanaged-object',
				[],
				`converge refuses unmanaged live sequence ${address.name}`,
			);
	}
}

function assertDeclaredSequenceNamesPreserved(
	model: ModelIR,
	naming: ReturnType<typeof getNamingPluginForDbCasing>,
): Map<string, SequenceIR> {
	return physicalizeDeclaredSequences(model.sequences, naming);
}

function referencedUniqueKey(
	table: LedgerAddress,
	columns: readonly string[],
): string | undefined {
	const columnSet = canonicalColumnSet(columns);
	return columnSet === undefined
		? undefined
		: JSON.stringify([canonicalJsonDigest(table), columnSet]);
}

function foreignKeyForChange(change: SchemaChange): ForeignKeyIR | undefined {
	const foreignKey = change.meta?.fk;
	if (
		!foreignKey ||
		typeof foreignKey !== 'object' ||
		Array.isArray(foreignKey)
	)
		return undefined;
	return foreignKey as ForeignKeyIR;
}

function indexForChange(change: SchemaChange): IndexIR | undefined {
	const index = change.meta?.index;
	if (!index || typeof index !== 'object' || Array.isArray(index))
		return undefined;
	return index as IndexIR;
}

function tableForChange(change: SchemaChange): TableIR | undefined {
	const table = change.meta?.table;
	if (!table || typeof table !== 'object' || Array.isArray(table))
		return undefined;
	return table as TableIR;
}

function tableHasInlineUniqueKey(
	table: TableIR | undefined,
	columns: readonly string[],
): boolean {
	if (!table) return false;
	const primaryKey = table.primaryKey;
	if (
		primaryKey !== undefined &&
		sameColumnSet(
			typeof primaryKey === 'string' ? [primaryKey] : primaryKey,
			columns,
		)
	)
		return true;
	return (
		columns.length === 1 &&
		table.columns.some(
			(column) => column.name === columns[0] && column.unique === true,
		)
	);
}

function isUnnamedExpressionOnlyIndex(change: SchemaChange): boolean {
	if (change.kind !== 'create_index') return false;
	const index = indexForChange(change);
	return (
		index !== undefined &&
		(typeof index.name !== 'string' || index.name.length === 0) &&
		index.columns.length === 0
	);
}

/**
 * PostgreSQL only accepts a fresh FK to an inline PK, an inline single-column
 * UNIQUE, or a declared non-partial, column-only unique index. TableIR has no
 * table-level unique-constraint representation to admit here.
 */
function assertFreshForeignKeysReferenceUniqueKeys(
	changes: readonly SchemaChange[],
	database: string,
	schema: string,
): ReadonlyMap<SchemaChange, SchemaChange> {
	const createdTables = new Map<string, SchemaChange>();
	const qualifyingIndexesByReferencedKey = new Map<string, SchemaChange>();
	for (const change of changes) {
		if (change.kind === 'create_table') {
			const address = generatedAddress(change, database, schema);
			createdTables.set(canonicalJsonDigest(address), change);
			continue;
		}
		if (change.kind !== 'create_index') continue;
		const index = indexForChange(change);
		if (
			index?.unique !== true ||
			index.where !== undefined ||
			(index.expressions !== undefined && index.expressions.length > 0)
		)
			continue;
		const parent = parentAddress(generatedAddress(change, database, schema));
		if (!parent) continue;
		const key = referencedUniqueKey(parent, index.columns);
		if (key !== undefined) qualifyingIndexesByReferencedKey.set(key, change);
	}
	const qualifyingIndexes = new Map<SchemaChange, SchemaChange>();
	for (const change of changes) {
		if (change.kind !== 'add_foreign_key') continue;
		const foreignKey = foreignKeyForChange(change);
		const referenced = referencedTableAddress(change, database, schema);
		if (!foreignKey || !referenced)
			throw new Error(
				'converge admitted add_foreign_key without a typed referenced table',
			);
		const referencedTable = createdTables.get(canonicalJsonDigest(referenced));
		if (!referencedTable)
			throw new Error(
				'converge admitted add_foreign_key without a referenced creating table',
			);
		if (
			tableHasInlineUniqueKey(
				tableForChange(referencedTable),
				foreignKey.references.columns,
			)
		)
			continue;
		const referencedKey = referencedUniqueKey(
			referenced,
			foreignKey.references.columns,
		);
		const indexChange =
			referencedKey === undefined
				? undefined
				: qualifyingIndexesByReferencedKey.get(referencedKey);
		if (
			indexChange &&
			isQualifyingUniqueIndex(
				indexForChange(indexChange),
				foreignKey.references.columns,
			)
		) {
			qualifyingIndexes.set(change, indexChange);
			continue;
		}
		const fkName = `fk_${change.table}_${foreignKey.columns.join('_')}`;
		throw refusal(
			'unsupported-change',
			[change],
			`converge refuses fresh foreign key ${fkName}: referenced columns ${referenced.name}(${foreignKey.references.columns.join(', ')}) have no declared qualifying unique key`,
		);
	}
	return qualifyingIndexes;
}

function uncoveredFreshFkColumns(
	changes: readonly SchemaChange[],
): readonly { readonly table: string; readonly column: string }[] {
	return changes.flatMap((change) => {
		if (change.kind !== 'create_table') return [];
		const table = change.meta?.table as TableIR | undefined;
		if (table === undefined) return [];
		return table.foreignKeys.flatMap((foreignKey) => {
			const column = foreignKey.columns[0];
			return foreignKey.columns.length === 1 &&
				column !== undefined &&
				!hasDeclaredFkIndexAdmission(table, column)
				? [{ table: change.table, column }]
				: [];
		});
	});
}

function projectCheckedPlan(
	steps: readonly NormalizedManagedStep[],
	changesByStepKey: ReadonlyMap<string, SchemaChange>,
): readonly PgConvergePlannedStep[] {
	return steps.map((step) => {
		if (step.address === undefined)
			throw new Error(
				`converge checked manifest step ${step.stepKey} has no root address`,
			);
		const common = {
			stepKey: step.stepKey,
			order: step.order,
			dependencyOrder: step.dependencyOrder,
			address: step.address,
		};
		const change = changesByStepKey.get(step.stepKey);
		if (change)
			return {
				...common,
				kind: change.kind,
				table: change.table,
				...(change.column === undefined ? {} : { column: change.column }),
				details: change.details,
			};
		if (step.lifecycle?.kind === 'adoption')
			return { ...common, kind: 'adopt_table' };
		if (step.lifecycle?.kind === 'sequence-adoption')
			return { ...common, kind: 'adopt_sequence' };
		throw new Error(
			`converge checked manifest step ${step.stepKey} has no paired change or adoption lifecycle`,
		);
	});
}

/**
 * Converges only startup-safe PostgreSQL additions: it creates tables and
 * sequences, adds nullable columns without defaults and NOT NULL columns with
 * boolean, finite-number, or non-function-like string literal defaults of a
 * a PostgreSQL built-in base type or an enum to managed tables, and creates
 * indexes, CHECK constraints, and foreign keys when their table parents are
 * created by this same run (for foreign keys, both tables).
 * Other defaulted original database types are refused.
 *
 * Adding a column still takes an ACCESS EXCLUSIVE lock on its table, bounded by
 * the executor's five-second lock_timeout and held through read-back and the
 * ledger terminal. A no-rewrite default is therefore not non-blocking.
 *
 * Converge mutates only declared additions whose target and existing parent pass
 * managed admission. It compares the declared tables, sequences, and enums'
 * structural shape; it does not audit the provenance of an exact-matching child
 * already present on a managed table.
 * `externalIndexes` accepts exact physical index names on logical model tables;
 * entries are validated before the ledger lock or any query, and converge
 * never drops a matching live index. A name that collides with another
 * relation the model creates fails when that step runs.
 * Before comparison, converge refuses while its target ledger home has a live
 * reservation: wait for a run that is still executing, reconcile a run whose
 * lock is free with reconcilePgTransitionRun or `dbsp reconcile --db
 * <database> <run-id>`, have the ledger owner resolve an unmapped reservation
 * and the journal owner one whose journal attribution cannot be read, then call
 * converge again.
 * Application steps run on the converge session: session-level effects such as
 * `SET` without `LOCAL`, `SET ROLE`, `LISTEN`, `PREPARE`, temporary tables and
 * session advisory locks are not part of a step and can affect the rest of the
 * call. Steps should use `SET LOCAL`.
 * A declared table with `adopt: true` is taken into management when it exists,
 * the ledger projects its address as unknown (the only state an adoption claim
 * opens from), and it matches the declaration exactly after `externalIndexes`
 * masking. A mismatch found while planning refuses
 * `adoption-refused` before anything is written. A table that changes while
 * its adoption runs is refused under its claim and the ledger records that
 * refused adoption; tables adopted earlier in the same call stay adopted.
 * Tables a run creates and every change on those tables commit together or not
 * at all. A sequence created by the same run commits on its own and can remain
 * after a failure. After a transport-ambiguous outcome, the next call observes
 * whichever state PostgreSQL holds. Converge runs are not journaled. Check mode
 * returns a point-in-time plan without executing it; it is not a guarantee that
 * a later apply will succeed, because other sessions can change the database
 * and execution-time ledger physical-shape integrity, claim-time adoption
 * re-verification, vacancy, and lock-timeout checks are not reproduced.
 * `initialize` defaults to `never`. `pristine` creates an absent ledger only
 * when declared tables and standalone sequences are absent, while
 * `adopt-existing` creates an absent ledger and adopts matching declared
 * relations on every call. The target schema must already exist. Application
 * steps run with `search_path` set to the target schema, `pg_temp`, then the
 * connection's entries, so `current_schema()` is the target. Lookup goes through
 * `pg_catalog` (implicit, first), the target, `pg_temp`, then those entries.
 */
export function convergePg(
	pool: Pool,
	model: ModelIR,
	options?: ConvergePgOptions,
): Promise<PgConvergeResult>;
export function convergePg(
	pool: Pool,
	model: ModelIR,
	options: ConvergePgCheckOptions,
): Promise<PgConvergeCheckResult>;
export async function convergePg(
	pool: Pool,
	model: ModelIR,
	options: ConvergePgOptions | ConvergePgCheckOptions = {},
): Promise<PgConvergeResult | PgConvergeCheckResult> {
	const mode: unknown = options.mode;
	if (mode !== undefined && mode !== 'apply' && mode !== 'check')
		throw invalidOptions('converge mode must be apply or check');
	const initialize: unknown = options.initialize;
	if (
		initialize !== undefined &&
		initialize !== 'never' &&
		initialize !== 'pristine' &&
		initialize !== 'adopt-existing'
	)
		throw invalidOptions(
			'converge initialize must be never, pristine, or adopt-existing',
		);
	validateDeclarationModel(model);
	const check = mode === 'check';
	const initialization = initialize ?? 'never';
	const schema = options.schema ?? 'public';
	const casing = options.dbCasing ?? 'preserve';
	const naming = getNamingPluginForDbCasing(casing);
	const externalIndexes = validateExternalIndexes(model, options, naming);
	let applicationSteps: readonly PgConvergeApplicationStep[];
	try {
		applicationSteps = validatePgConvergeApplicationSteps(options.steps);
	} catch (error) {
		throw invalidOptions(
			error instanceof PgApplicationStepError
				? error.message
				: 'converge steps are invalid',
		);
	}
	if (applicationSteps.length > 0 && schema === '$user')
		throw invalidOptions(APPLICATION_STEP_DOLLAR_USER_SCHEMA_MESSAGE);
	const declaredSequences = assertDeclaredSequenceNamesPreserved(model, naming);
	if (!check && initialization !== 'never') {
		const initializationClient = await pool.connect();
		let initializationCurrency: PgLedgerScopeCurrency | undefined;
		let initializationError: unknown;
		try {
			initializationCurrency = await readPgLedgerScopeCurrency(
				initializationClient,
				schemaHome(schema),
			);
		} catch (error) {
			initializationError = error;
			throw error;
		} finally {
			initializationClient.release(
				initializationError instanceof Error ? initializationError : undefined,
			);
		}
		if (initializationCurrency?.kind === 'absent') {
			const report = await runPgConvergeInitializationPreflight({
				pool,
				schema,
				...(initialization === 'pristine'
					? {
							pristineRelationNames: [
								...model.tables.values(),
								...declaredSequences.keys(),
							].map((value) =>
								typeof value === 'string'
									? value
									: naming.toDatabase(value.name),
							),
						}
					: {}),
			});
			const preflightFailure = reportInitializationFailure(report);
			if (preflightFailure) throw preflightFailure;
		}
	}
	const client = await pool.connect();
	let destroyReason:
		| 'converge could not determine ledger lock acquisition'
		| 'converge could not confirm ledger lock release'
		| 'converge could not confirm predecessor run lock release'
		| 'converge received a transport-ambiguous outcome'
		| 'converge application step callback may have changed session state'
		| undefined;
	let applicationStepCallbackRan = false;
	let locked = false;
	try {
		destroyReason = 'converge could not determine ledger lock acquisition';
		const lock = await acquirePgLedgerSessionLock(client, schemaHome(schema));
		destroyReason = undefined;
		if (lock.kind === 'busy')
			throw new PgConvergeRefusalError(
				'busy',
				[],
				'converge schema ledger lock is busy',
			);
		locked = true;
		lockedConvergeClients.add(client);
		try {
			await ensurePgLedgerStorageVersion(client);
		} catch (error) {
			if (error instanceof PgLedgerStorageUnsupportedError)
				throw new PgConvergeRefusalError(
					'unsupported-server',
					[],
					`converge refuses unsupported PostgreSQL server version: ${error.message}`,
				);
			throw error;
		}
		const currency = await readPgLedgerScopeCurrency(
			client,
			schemaHome(schema),
		);
		if (currency.kind === 'absent')
			throw new PgConvergeRefusalError(
				'ledger-absent',
				[],
				`converge requires a current schema ledger for ${schema}; pass initialize: 'pristine' or 'adopt-existing' in apply mode, or run runPgReinitializePreflight`,
			);
		if (currency.kind === 'not-current')
			throw new PgConvergeRefusalError(
				'incompatible-ledger',
				[],
				`converge requires a current schema ledger for ${schema}; ledger currency failed ${currency.reason}`,
			);
		await refuseForLiveReservations(client, schema, () => {
			destroyReason = 'converge could not confirm predecessor run lock release';
		});
		const writability = await classifyPgDatabaseWritability(client);
		if (writability.kind === 'database-read-only')
			throw new PgConvergeRefusalError(
				'database-read-only',
				[],
				writability.detail,
			);
		if (writability.kind === 'unavailable') throw new Error(writability.detail);
		for (const table of model.tables.values()) {
			const directive =
				table.replace === true
					? 'replace'
					: table.readdress === undefined
						? undefined
						: 'readdress';
			if (directive)
				throw refusal(
					'unsupported-change',
					[],
					`converge refuses declared ${directive} for ${table.name}`,
				);
		}
		const database = await databaseId(client);
		const standingAdoptionRelations =
			initialization === 'adopt-existing'
				? await declaredRelationNames(
						client,
						schema,
						[...model.tables.values(), ...declaredSequences.keys()].map(
							(value) =>
								typeof value === 'string'
									? value
									: naming.toDatabase(value.name),
						),
					)
				: undefined;
		const diff = await compareConvergeMaskedSchema({
			executor: client,
			model,
			schema,
			casing,
			externalIndexes,
		});
		const adoptionSteps: NormalizedManagedStep[] = [];
		for (const table of model.tables.values()) {
			const physicalName = naming.toDatabase(table.name);
			if (
				standingAdoptionRelations === undefined
					? table.adopt !== true
					: !standingAdoptionRelations.tables.has(physicalName)
			)
				continue;
			const adoptionChanges = diff.changes.filter(
				(change) => change.table === physicalName,
			);
			const address = {
				scope: 'schema' as const,
				engine: 'postgresql',
				database,
				schema,
				kind: 'table' as const,
				name: physicalName,
			};
			const admission = await declaredAdoptionAdmission(client, address);
			if (admission.kind === 'managed') continue;
			if (admission.kind !== 'unknown')
				throw refusal(
					'adoption-refused',
					[],
					`declared adoption for ${physicalName} refuses ledger admission`,
				);
			if (adoptionChanges.length > 0)
				throw refusal(
					'adoption-refused',
					adoptionChanges,
					`declared adoption for ${physicalName} refuses live shape mismatch`,
				);
			adoptionSteps.push(
				createPgsqlDeclaredAdoptionStep({
					address,
					table,
					stepKey: `converge:${adoptionSteps.length}:adoption`,
					order: adoptionSteps.length,
					catalogueIdentity: admission.catalogueIdentity,
				}),
			);
		}
		for (const [physicalName, sequence] of declaredSequences) {
			if (
				standingAdoptionRelations === undefined
					? sequence.adopt !== true
					: !standingAdoptionRelations.sequences.has(physicalName)
			)
				continue;
			if (sequence.schema !== undefined && sequence.schema !== schema)
				throw refusal(
					'adoption-refused',
					[],
					`declared sequence adoption for ${physicalName} refuses declared schema ${sequence.schema}; converge target schema is ${schema}`,
				);
			const address = {
				scope: 'schema' as const,
				engine: 'postgresql',
				database,
				schema,
				kind: 'sequence' as const,
				name: physicalName,
			};
			const admission = await declaredAdoptionAdmission(client, address);
			if (admission.kind === 'managed') continue;
			if (admission.kind !== 'unknown')
				throw refusal(
					'adoption-refused',
					[],
					`declared sequence adoption for ${physicalName} refuses ledger admission`,
				);
			const sequenceChanges = diff.changes.filter((change) => {
				if (
					change.kind !== 'create_sequence' &&
					change.kind !== 'alter_sequence'
				)
					return false;
				const declared = change.meta?.sequence as SequenceIR | undefined;
				return declared?.name === physicalName;
			});
			if (sequenceChanges.length > 0)
				throw refusal(
					'adoption-refused',
					sequenceChanges,
					`declared sequence adoption for ${physicalName} refuses ${sequenceChanges.map((change) => change.kind).join(', ')}`,
				);
			if (
				!(await pgDeclaredSequenceAdoptionShapeMatches(
					client,
					schema,
					physicalName,
					sequence,
				))
			)
				throw refusal(
					'adoption-refused',
					[],
					`declared sequence adoption for ${physicalName} refuses live shape mismatch`,
				);
			adoptionSteps.push(
				createPgsqlDeclaredSequenceAdoptionStep({
					address,
					sequence,
					stepKey: `converge:${adoptionSteps.length}:sequence-adoption`,
					order: adoptionSteps.length,
					catalogueIdentity: admission.catalogueIdentity,
				}),
			);
		}
		const createdTableAddresses = new Set(
			diff.changes.flatMap((change) => {
				if (change.kind !== 'create_table') return [];
				const address = generatedAddress(change, database, schema);
				return [canonicalJsonDigest(address)];
			}),
		);
		const createdSequenceAddresses = new Set(
			diff.changes.flatMap((change) => {
				if (change.kind !== 'create_sequence') return [];
				const address = generatedAddress(change, database, schema);
				return [canonicalJsonDigest(address)];
			}),
		);
		await assertExistingDeclaredSequencesManaged(
			client,
			database,
			schema,
			declaredSequences,
			createdSequenceAddresses,
			new Set(
				adoptionSteps.flatMap((step) =>
					step.lifecycle?.kind === 'sequence-adoption' && step.address
						? [canonicalJsonDigest(step.address)]
						: [],
				),
			),
		);
		const rejected = diff.changes.filter(
			(change) =>
				!additiveChange(change, database, schema, createdTableAddresses),
		);
		if (rejected.length > 0)
			throw refusal(
				'unsupported-change',
				rejected,
				`converge refuses change ${rejected.map((change) => change.kind).join(', ')}`,
			);
		await assertDefaultedColumnsUseBuiltInBaseTypesOrEnums(
			client,
			diff.changes,
			schema,
		);
		const fkUniqueIndexes = assertFreshForeignKeysReferenceUniqueKeys(
			diff.changes,
			database,
			schema,
		);
		const uncoveredFkColumns = uncoveredFreshFkColumns(diff.changes);
		if (uncoveredFkColumns.length > 0) {
			const tables = new Set(uncoveredFkColumns.map(({ table }) => table));
			throw refusal(
				'unsupported-change',
				diff.changes.filter(
					(change) =>
						change.kind === 'create_table' && tables.has(change.table),
				),
				`converge refuses fresh foreign keys without a declared foreign key index: ${uncoveredFkColumns.map(({ table, column }) => `${table}.${column}`).join(', ')}; declare a single-column index on each listed column, or a primary key or btree index (non-partial, without expressions) whose first column is that column`,
			);
		}
		await assertExistingDeclaredTablesManaged(
			client,
			database,
			schema,
			model,
			casing,
			new Set(
				diff.changes
					.filter((change) => change.kind === 'create_table')
					.map((change) => naming.toDatabase(change.table)),
			),
			new Set(
				adoptionSteps
					.filter((step) => step.address?.kind === 'table')
					.map((step) => step.address?.name)
					.filter((name): name is string => name !== undefined),
			),
		);
		let plannedApplicationSteps: Awaited<
			ReturnType<typeof planPgApplicationSteps>
		>;
		try {
			plannedApplicationSteps = await planPgApplicationSteps({
				client,
				database,
				schema,
				steps: applicationSteps,
				hasPendingGeneratedWork:
					diff.changes.length > 0 || adoptionSteps.length > 0,
				check,
				onApplicationStepCallback: () => {
					applicationStepCallbackRan = true;
				},
			});
		} catch (error) {
			if (error instanceof PgApplicationStepError)
				throw refusal(
					error.refusal,
					[],
					`application step ${error.stepId}: ${error.message}`,
				);
			throw error;
		}
		if (
			diff.changes.length === 0 &&
			adoptionSteps.length === 0 &&
			plannedApplicationSteps.length === 0
		)
			return check ? { kind: 'no-drift' } : { kind: 'no-drift', applied: [] };
		const phaseOrderedChanges = [...diff.changes].sort(
			(left, right) => getPhase(left.kind) - getPhase(right.kind),
		);
		const atomicCreationChanges = new Set(
			phaseOrderedChanges.filter((change) => {
				if (change.kind === 'create_table') return true;
				const parent = parentAddress(
					generatedAddress(change, database, schema),
				);
				return (
					parent !== undefined &&
					createdTableAddresses.has(canonicalJsonDigest(parent))
				);
			}),
		);
		const firstCreationTable = phaseOrderedChanges.findIndex(
			(change) => change.kind === 'create_table',
		);
		const orderedChanges =
			firstCreationTable === -1
				? phaseOrderedChanges
				: [
						...phaseOrderedChanges
							.slice(0, firstCreationTable)
							.filter((change) => !atomicCreationChanges.has(change)),
						...phaseOrderedChanges.filter((change) =>
							atomicCreationChanges.has(change),
						),
						...phaseOrderedChanges
							.slice(firstCreationTable)
							.filter((change) => !atomicCreationChanges.has(change)),
					];
		const createTableStepKeys = new Map<string, string>();
		const createIndexStepKeys = new Map<SchemaChange, string>();
		for (const [order, change] of orderedChanges.entries()) {
			const stepOrder = adoptionSteps.length + order;
			if (change.kind === 'create_table') {
				const address = generatedAddress(change, database, schema);
				createTableStepKeys.set(
					canonicalJsonDigest(address),
					`converge:${stepOrder}`,
				);
			}
			if (change.kind === 'create_index')
				createIndexStepKeys.set(change, `converge:${stepOrder}`);
		}
		const assembled: {
			readonly change: SchemaChange;
			readonly step: NormalizedManagedStep;
		}[] = [];
		for (const [order, change] of orderedChanges.entries()) {
			const stepOrder = adoptionSteps.length + order;
			const address = generatedAddress(change, database, schema);
			const parent = parentAddress(address);
			const dependencies = new Set<string>();
			if (
				parent &&
				(change.kind === 'create_index' ||
					change.kind === 'add_check_constraint' ||
					change.kind === 'add_foreign_key' ||
					change.kind === 'add_column')
			) {
				const dependency = createTableStepKeys.get(canonicalJsonDigest(parent));
				if (dependency) dependencies.add(dependency);
				else if (change.kind !== 'add_column')
					throw new Error(
						`converge admitted ${change.kind} without a creating table step`,
					);
			}
			if (change.kind === 'add_foreign_key') {
				const referenced = referencedTableAddress(change, database, schema);
				const dependency =
					referenced &&
					createTableStepKeys.get(canonicalJsonDigest(referenced));
				if (!dependency)
					throw new Error(
						'converge admitted add_foreign_key without a referenced creating table step',
					);
				dependencies.add(dependency);
				const indexChange = fkUniqueIndexes.get(change);
				if (indexChange) {
					const indexDependency = createIndexStepKeys.get(indexChange);
					if (!indexDependency)
						throw new Error(
							'converge admitted add_foreign_key without its qualifying unique index step',
						);
					dependencies.add(indexDependency);
				}
			}
			const statements = generateMigrationSQL(
				{ ...diff, changes: [change] },
				{ includeDestructive: false, schemaName: schema, fkAutoIndex: false },
			);
			const step = createPgsqlGeneratedManagedStep({
				change,
				database,
				schema,
				stepKey: `converge:${stepOrder}`,
				order: stepOrder,
				dependencyOrder: [...dependencies],
				statements,
			});
			assembled.push({ change, step });
		}
		const manifest = validateNormalizedManagedStepManifest([
			...adoptionSteps,
			...assembled.map(({ step }) => step),
		]);
		if (!manifest.ok)
			throw new Error(`converge manifest is invalid: ${manifest.detail}`);
		const atomicCreationGroup = assembled
			.filter(({ change }) => atomicCreationChanges.has(change))
			.map(({ step }) => step.stepKey);
		const atomicCreationGroupKeys = new Set(atomicCreationGroup);
		for (const step of [...adoptionSteps, ...assembled.map(({ step }) => step)])
			if (
				!atomicCreationGroupKeys.has(step.stepKey) &&
				step.dependencyOrder.some((key) => atomicCreationGroupKeys.has(key))
			)
				throw new Error(
					`converge non-group step ${step.stepKey} depends on atomic creation group step`,
				);
		const previouslyCreatedAddresses = new Set<string>();
		const laterCreatedAddresses = new Set(createdTableAddresses);
		for (const { change, step } of assembled) {
			if (change.kind === 'create_table' && step.address)
				laterCreatedAddresses.delete(canonicalJsonDigest(step.address));
			await assertOwnedChange(
				client,
				change,
				step,
				createdTableAddresses,
				previouslyCreatedAddresses,
				laterCreatedAddresses,
			);
			if (change.kind === 'create_table' && step.address)
				previouslyCreatedAddresses.add(canonicalJsonDigest(step.address));
		}
		const planDigest = canonicalJsonDigest({
			kind: 'postgresql-additive-converge-v1',
			database,
			schema,
			steps: manifest.manifest.steps,
			applicationSteps: applicationSteps.map((step) => ({
				kind: step.kind,
				id: step.id,
				digest: step.digest,
				scope: step.scope ?? 'schema',
				phase: step.phase,
				...(step.lockTimeoutMs === undefined
					? {}
					: { lockTimeoutMs: step.lockTimeoutMs }),
				...(step.statementTimeoutMs === undefined
					? {}
					: { statementTimeoutMs: step.statementTimeoutMs }),
			})),
		});
		if (check) {
			const phaseByApplicationStepId = new Map(
				applicationSteps.map((step) => [step.id, step.phase]),
			);
			return {
				kind: 'would-apply',
				planDigest,
				steps: [
					...plannedApplicationSteps.filter(
						(step) =>
							phaseByApplicationStepId.get(step.id) === 'before-generated-ddl',
					),
					...projectCheckedPlan(
						manifest.manifest.steps,
						new Map(
							assembled.map(({ change, step }) => [step.stepKey, change]),
						),
					),
					...plannedApplicationSteps.filter(
						(step) =>
							phaseByApplicationStepId.get(step.id) === 'after-generated-ddl',
					),
				],
			};
		}
		let appliedApplicationSteps: readonly string[];
		try {
			appliedApplicationSteps = await runPgApplicationSteps({
				client,
				database,
				schema,
				phase: 'before-generated-ddl',
				steps: applicationSteps,
				onApplicationStepCallback: () => {
					applicationStepCallbackRan = true;
				},
			});
		} catch (error) {
			if (error instanceof PgCommitAcknowledgementAmbiguousError) {
				destroyReason = 'converge received a transport-ambiguous outcome';
				return { kind: 'transport-ambiguous', detail: error.message };
			}
			if (error instanceof PgApplicationStepError)
				throw refusal(
					error.refusal,
					[],
					`application step ${error.stepId}: ${error.message}`,
				);
			throw error;
		}
		const run: TransitionRunMetadata = {
			runId: `dbsp-converge-${randomUUID()}`,
			planDigest,
			targetContextDigest: canonicalJsonDigest({ database, schema, casing }),
			databaseId: database,
			coreVersion: 'postgresql-additive-converge-v1',
			startedAt: new Date().toISOString(),
			replayability: 'replayable',
		};
		const outcome = await executeGeneratorPlan({
			pool: client,
			manifest: manifest.manifest,
			planDigest,
			schema,
			run: mintPgConvergeLockedRun(client, run),
			runId: run.runId,
			recordAttempt: async () => undefined,
			verifyDeclaredAdoptionShape: async (executor, step) => {
				if (executor !== client)
					throw new Error(
						'converge adoption verifier received an unexpected executor',
					);
				const address = step.address;
				if (address?.kind === 'sequence') {
					const sequence = declaredSequences.get(address.name);
					return (
						sequence !== undefined &&
						pgDeclaredSequenceAdoptionShapeMatches(
							executor,
							schema,
							address.name,
							sequence,
						)
					);
				}
				if (address?.kind !== 'table') return false;
				const compared = await compareConvergeMaskedSchema({
					executor: client,
					model: modelForDeclaredAdoption(
						declaredAdoptionTable(model, naming, address),
					),
					schema,
					casing,
					externalIndexes,
				});
				return !compared.changes.some(
					(change) => change.table === address.name,
				);
			},
			...(atomicCreationGroup.length === 0 ? {} : { atomicCreationGroup }),
		});
		if (outcome.outcome === 'completed')
			try {
				appliedApplicationSteps = [
					...appliedApplicationSteps,
					...(await runPgApplicationSteps({
						client,
						database,
						schema,
						phase: 'after-generated-ddl',
						steps: applicationSteps,
						onApplicationStepCallback: () => {
							applicationStepCallbackRan = true;
						},
					})),
				];
			} catch (error) {
				if (error instanceof PgCommitAcknowledgementAmbiguousError) {
					destroyReason = 'converge received a transport-ambiguous outcome';
					return { kind: 'transport-ambiguous', detail: error.message };
				}
				if (error instanceof PgApplicationStepError)
					throw refusal(
						error.refusal,
						[],
						`application step ${error.stepId}: ${error.message}`,
					);
				throw error;
			}
		if (outcome.outcome === 'completed')
			return {
				kind: 'applied',
				applied: [
					...adoptionSteps.map((step) =>
						step.lifecycle?.kind === 'sequence-adoption'
							? 'adopt_sequence'
							: 'adopt_table',
					),
					...orderedChanges.map((change) => change.kind),
					...appliedApplicationSteps,
				],
			};
		if (outcome.outcome === 'partially-applied')
			return {
				kind: 'partially-applied',
				completedStepKeys: outcome.completedStepKeys,
				notStartedStepKeys: outcome.notStartedStepKeys,
				detail: outcome.detail,
			};
		if (outcome.outcome === 'transport-ambiguous') {
			destroyReason = 'converge received a transport-ambiguous outcome';
			return { kind: 'transport-ambiguous', detail: outcome.detail };
		}
		throw refusal(
			outcome.outcome === 'adoption-refused'
				? 'adoption-refused'
				: 'execution-refused',
			diff.changes,
			outcome.detail,
		);
	} finally {
		const compromised = readPgOutcomeSessionCompromise(client);
		lockedConvergeClients.delete(client);
		if (locked && !compromised) {
			try {
				if (!(await releasePgLedgerSessionLock(client, schemaHome(schema))))
					destroyReason = 'converge could not confirm ledger lock release';
			} catch {
				destroyReason = 'converge could not confirm ledger lock release';
			}
		}
		if (applicationStepCallbackRan && destroyReason === undefined)
			destroyReason =
				'converge application step callback may have changed session state';
		client.release(
			destroyReason === undefined ? compromised : new Error(destroyReason),
		);
	}
}
