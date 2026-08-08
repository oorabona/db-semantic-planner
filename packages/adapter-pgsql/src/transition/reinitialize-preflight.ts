import { randomBytes } from 'node:crypto';
import type {
	DeclarationSet,
	LedgerAddress,
	LedgerHome,
	LedgerIdentity,
	LedgerMarkerState,
	ReinitializePreflightAdoptionCandidate,
	ReinitializePreflightFailureStep,
	ReinitializePreflightRefusalCode,
	ReinitializePreflightReport,
	ReinitializePreflightScopeReport,
} from '@dbsp/types';
import { validateIdentifier } from '../validate.js';
import {
	DBSP_LEDGER_EVENT_TABLE,
	DBSP_LEDGER_IDENTITY_TABLE,
	DBSP_LEDGER_MARKER_TABLE,
	DBSP_LEDGER_TABLES,
	DBSP_META_SCHEMA,
	isDbspLedgerInfrastructureTable,
} from './constants.js';
import type { TransitionJournalQueryable } from './journal.js';
import {
	acquirePgLedgerLocks,
	ensureDbspMetaLedger,
	ensurePgLedger,
	PG_LEDGER_SHAPE_VERSION,
	recordPgLedgerIdentity,
	writePgLedgerShapeMarker,
} from './ledger.js';

export type ReinitializePreflightCheckpoint =
	| 'archive'
	| 'create'
	| 'grants'
	| 'marker'
	| 'output';

/** Test-only callers can observe real engine progress without changing production flow. */
export type ReinitializePreflightObserver = (
	checkpoint: ReinitializePreflightCheckpoint,
	ledger?: LedgerHome,
) => Promise<void>;

export interface PgReinitializePreflightClient
	extends TransitionJournalQueryable {
	release?(error?: unknown): void;
}

export interface PgReinitializePreflightPool {
	connect(): Promise<PgReinitializePreflightClient>;
}

export interface PgReinitializePreflightOptions {
	readonly pool: PgReinitializePreflightPool;
	/** Schema names only. `dbsp_meta` is always added as the database ledger. */
	readonly schemas: readonly string[];
	readonly declarations: DeclarationSet;
	readonly writeAdoptionFile: (
		report: ReinitializePreflightReport,
	) => Promise<void>;
	readonly observer?: ReinitializePreflightObserver;
}

const LEDGER_TABLES = DBSP_LEDGER_TABLES;

/** Bound every PostgreSQL object-lock wait made by one preflight scope. */
export const REINITIALIZE_PREFLIGHT_LOCK_TIMEOUT_SQL =
	"SET LOCAL lock_timeout = '5s'";

function quoteIdent(value: string, type: 'schema' | 'table'): string {
	validateIdentifier(value, type);
	return `"${value.replaceAll('"', '""')}"`;
}

function schemaFor(home: LedgerHome): string {
	if (home.scope === 'database') return DBSP_META_SCHEMA;
	if (!home.schema)
		throw new Error('schema ledger target is missing its schema');
	return home.schema;
}

function qualified(home: LedgerHome, table: string): string {
	return `${quoteIdent(schemaFor(home), 'schema')}.${quoteIdent(table, 'table')}`;
}

/**
 * Creation-time ownership and ACLs. Existing current ledgers are only
 * validated, never silently repaired, so a widened grant remains a refusal.
 */
export function renderReinitializePreflightCreationGrantSql(
	home: LedgerHome,
): readonly string[] {
	return [
		...(home.scope === 'database'
			? [
					`ALTER SCHEMA ${quoteIdent(DBSP_META_SCHEMA, 'schema')} OWNER TO CURRENT_USER`,
					`REVOKE ALL ON SCHEMA ${quoteIdent(DBSP_META_SCHEMA, 'schema')} FROM PUBLIC`,
				]
			: []),
		...LEDGER_TABLES.flatMap((table) => [
			`ALTER TABLE ${qualified(home, table)} OWNER TO CURRENT_USER`,
			`REVOKE ALL ON TABLE ${qualified(home, table)} FROM PUBLIC`,
		]),
	];
}

function homesFor(schemas: readonly string[]): readonly LedgerHome[] {
	const names = [...new Set(schemas)].sort();
	for (const name of names) validateIdentifier(name, 'schema');
	return [
		{ scope: 'database' },
		...names.map((schema) => ({ scope: 'schema' as const, schema })),
	];
}

function errorDetail(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * These SQLSTATEs mean that this deployment role cannot inspect the requested
 * scope. They are not evidence that an existing marker is malformed.
 */
const SCOPE_ACCESS_DENIED_SQLSTATES = new Set([
	'42501', // insufficient_privilege
	'3F000', // invalid_schema_name
]);

function pgErrorCode(error: unknown): string | undefined {
	if (typeof error !== 'object' || error === null || !('code' in error))
		return undefined;
	const code = error.code;
	return typeof code === 'string' ? code : undefined;
}

/** Classifies server errors only by SQLSTATE, never by their message text. */
export function isPgReinitializeScopeAccessDenied(error: unknown): boolean {
	return SCOPE_ACCESS_DENIED_SQLSTATES.has(pgErrorCode(error) ?? '');
}

function markerRefusal(marker: LedgerMarkerState): string {
	switch (marker.kind) {
		case 'older':
			return `reinitialize-preflight refuses older marker version ${marker.version}`;
		case 'future':
			return `reinitialize-preflight refuses future marker version ${marker.version}`;
		case 'mixed':
			return `reinitialize-preflight refuses mixed marker versions ${marker.versions.join(', ')}`;
		case 'unreadable':
			return `reinitialize-preflight refuses unreadable marker: ${marker.reason}`;
		default:
			return 'reinitialize-preflight marker refusal';
	}
}

export function classifyPgLedgerMarker(
	versions: readonly number[] | undefined,
	readError?: unknown,
): LedgerMarkerState {
	if (readError !== undefined)
		return { kind: 'unreadable', reason: errorDetail(readError) };
	if (versions === undefined) return { kind: 'absent' };
	const distinct = [...new Set(versions)].sort((left, right) => left - right);
	if (distinct.length !== 1) return { kind: 'mixed', versions: distinct };
	const version = distinct[0];
	if (version === undefined) return { kind: 'mixed', versions: distinct };
	if (version === PG_LEDGER_SHAPE_VERSION) return { kind: 'current' };
	return version < PG_LEDGER_SHAPE_VERSION
		? { kind: 'older', version }
		: { kind: 'future', version };
}

/**
 * Read exactly one ledger shape marker without creating or repairing anything.
 * Ordinary command surfaces use this to refuse a non-current mutating scope;
 * inspect deliberately reports the returned value instead.
 */
export async function readPgLedgerMarker(
	executor: TransitionJournalQueryable,
	home: LedgerHome,
): Promise<LedgerMarkerState> {
	const marker = await executor.query('SELECT to_regclass($1) AS relation', [
		qualified(home, DBSP_LEDGER_MARKER_TABLE),
	]);
	if (
		marker.rows[0]?.relation !== null &&
		marker.rows[0]?.relation !== undefined
	) {
		const rows = await executor.query(
			`SELECT version FROM ${qualified(home, DBSP_LEDGER_MARKER_TABLE)} ORDER BY version`,
		);
		const versions = rows.rows.map((row) => Number(row.version));
		if (versions.some((version) => !Number.isInteger(version))) {
			return {
				kind: 'unreadable',
				reason: 'marker version is not an integer',
			};
		}
		return classifyPgLedgerMarker(versions);
	}
	return classifyPgLedgerMarker(undefined);
}

export interface ReinitializePreflightScopeInspection {
	readonly home: LedgerHome;
	readonly marker: LedgerMarkerState;
	readonly identity?: LedgerIdentity;
	/** An inspection-time SQLSTATE access denial for this scope only. */
	readonly accessFailure?: string;
}

async function readIdentity(
	executor: TransitionJournalQueryable,
	home: LedgerHome,
): Promise<LedgerIdentity> {
	const result = await executor.query(
		`SELECT cluster_system_identifier, database_oid, namespace_oid FROM ${qualified(home, DBSP_LEDGER_IDENTITY_TABLE)} WHERE id = true`,
	);
	if (result.rows.length !== 1)
		throw new Error('ledger identity is missing or ambiguous');
	const row = result.rows[0] ?? {};
	if (
		typeof row.cluster_system_identifier !== 'string' ||
		typeof row.database_oid !== 'string' ||
		(row.namespace_oid !== null && typeof row.namespace_oid !== 'string')
	)
		throw new Error('ledger identity is unreadable');
	return {
		clusterSystemIdentifier: row.cluster_system_identifier,
		databaseOid: row.database_oid,
		...(row.namespace_oid === null ? {} : { namespaceOid: row.namespace_oid }),
	};
}

async function readLiveIdentity(
	executor: TransitionJournalQueryable,
	home: LedgerHome,
): Promise<LedgerIdentity> {
	const result = await executor.query(
		`SELECT (pg_catalog.pg_control_system()).system_identifier::text AS cluster_system_identifier, d.oid::text AS database_oid, n.oid::text AS namespace_oid FROM pg_catalog.pg_database d CROSS JOIN pg_catalog.pg_namespace n WHERE d.datname = pg_catalog.current_database() AND n.nspname = $1`,
		[schemaFor(home)],
	);
	const row = result.rows[0] ?? {};
	if (
		typeof row.cluster_system_identifier !== 'string' ||
		typeof row.database_oid !== 'string' ||
		typeof row.namespace_oid !== 'string'
	)
		throw new Error(
			`live identity for scope ${schemaFor(home)} could not be read`,
		);
	return {
		clusterSystemIdentifier: row.cluster_system_identifier,
		databaseOid: row.database_oid,
		namespaceOid: row.namespace_oid,
	};
}

function sameIdentity(left: LedgerIdentity, right: LedgerIdentity): boolean {
	return (
		left.clusterSystemIdentifier === right.clusterSystemIdentifier &&
		left.databaseOid === right.databaseOid &&
		left.namespaceOid === right.namespaceOid
	);
}

async function inspectScope(
	executor: TransitionJournalQueryable,
	home: LedgerHome,
): Promise<ReinitializePreflightScopeInspection> {
	try {
		const marker = await readPgLedgerMarker(executor, home);
		if (marker.kind !== 'current') return { home, marker };
		return { home, marker, identity: await readIdentity(executor, home) };
	} catch (error) {
		if (isPgReinitializeScopeAccessDenied(error)) {
			return {
				home,
				// No marker fact was observed. `absent` is the non-refusal marker
				// state; accessFailure retains the actual inspection result.
				marker: { kind: 'absent' },
				accessFailure: errorDetail(error),
			};
		}
		return {
			home,
			marker: { kind: 'unreadable', reason: errorDetail(error) },
		};
	}
}

function inspectionAccessFailure(
	inspection: ReinitializePreflightScopeInspection,
): ReinitializePreflightScopeReport | undefined {
	if (inspection.accessFailure === undefined) return undefined;
	return refusal(
		inspection.home,
		inspection.marker,
		'reinitialize-preflight-failed',
		inspection.accessFailure,
		'marker',
	);
}

async function validateOwnershipAndGrants(
	executor: TransitionJournalQueryable,
	home: LedgerHome,
): Promise<void> {
	const currentUser = await executor.query('SELECT current_user AS role');
	const role = currentUser.rows[0]?.role;
	if (typeof role !== 'string')
		throw new Error('current_user could not be read');
	const objects = await executor.query(
		`SELECT c.relname, pg_catalog.pg_get_userbyid(c.relowner) AS owner, EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) acl WHERE acl.grantee = 0 OR acl.grantee <> c.relowner) AS widened FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = ANY($2::text[]) AND c.relkind IN ('r', 'p') ORDER BY c.relname`,
		[schemaFor(home), LEDGER_TABLES],
	);
	if (objects.rows.length !== LEDGER_TABLES.length)
		throw new Error(
			'ledger ownership could not be validated because a ledger table is missing',
		);
	for (const object of objects.rows) {
		if (object.owner !== role)
			throw new Error(
				`ledger ${String(object.relname)} is owned by ${String(object.owner)}, not deployment role ${role}`,
			);
		if (object.widened === true)
			throw new Error(`ledger ${String(object.relname)} has widened grants`);
	}
	if (home.scope === 'database') {
		const meta = await executor.query(
			`SELECT pg_catalog.pg_get_userbyid(n.nspowner) AS owner, EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) acl WHERE acl.grantee = 0 OR acl.grantee <> n.nspowner) AS widened FROM pg_catalog.pg_namespace n WHERE n.nspname = $1`,
			[DBSP_META_SCHEMA],
		);
		const row = meta.rows[0];
		if (!row || row.owner !== role)
			throw new Error(`dbsp_meta is not owned by deployment role ${role}`);
		if (row.widened === true) throw new Error('dbsp_meta has widened grants');
	}
}

async function establishCreationOwnershipAndGrants(
	executor: TransitionJournalQueryable,
	home: LedgerHome,
): Promise<void> {
	for (const sql of renderReinitializePreflightCreationGrantSql(home))
		await executor.query(sql);
}

function archivedObjectName(name: string, suffix: string): string {
	const postfix = `_archive_${suffix}`;
	return `${name.slice(0, 63 - postfix.length)}${postfix}`;
}

async function archiveTableIndexes(
	executor: TransitionJournalQueryable,
	home: LedgerHome,
	table: string,
	suffix: string,
): Promise<void> {
	const indexes = await executor.query(
		`SELECT index_class.relname AS name FROM pg_catalog.pg_index index_definition JOIN pg_catalog.pg_class table_class ON table_class.oid = index_definition.indrelid JOIN pg_catalog.pg_class index_class ON index_class.oid = index_definition.indexrelid WHERE table_class.oid = pg_catalog.to_regclass($1) ORDER BY index_class.relname`,
		[qualified(home, table)],
	);
	for (const row of indexes.rows) {
		if (typeof row.name !== 'string')
			throw new Error(`archived ledger index name is unreadable for ${table}`);
		await executor.query(
			`ALTER INDEX ${qualified(home, row.name)} RENAME TO ${quoteIdent(archivedObjectName(row.name, suffix), 'table')}`,
		);
	}
}

async function archiveMismatchedLedger(
	executor: TransitionJournalQueryable,
	home: LedgerHome,
): Promise<void> {
	const suffix = randomBytes(6).toString('hex');
	const archived: string[] = [];
	for (const table of LEDGER_TABLES) {
		const archive = `${table}_archive_${suffix}`;
		await executor.query(
			`ALTER TABLE ${qualified(home, table)} RENAME TO ${quoteIdent(archive, 'table')}`,
		);
		// PostgreSQL preserves an index name when its table is renamed. The fresh
		// ledger uses deterministic primary/unique/index names, so keep every
		// archived backing index as provenance under a distinct name as well.
		await archiveTableIndexes(executor, home, archive, suffix);
		archived.push(archive);
	}
	const schema = quoteIdent(schemaFor(home), 'schema');
	await executor.query(
		`CREATE OR REPLACE FUNCTION ${schema}."dbsp_ledger_reject_archive_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'dbsp archived ledger is read-only'; END; $$`,
	);
	for (const table of archived) {
		await executor.query(
			`REVOKE ALL ON TABLE ${qualified(home, table)} FROM PUBLIC`,
		);
		await executor.query(
			`CREATE TRIGGER "dbsp_ledger_archive_immutable" BEFORE INSERT OR UPDATE OR DELETE ON ${qualified(home, table)} FOR EACH ROW EXECUTE FUNCTION ${schema}."dbsp_ledger_reject_archive_mutation"()`,
		);
	}
}

function refusal(
	home: LedgerHome,
	marker: LedgerMarkerState,
	code: ReinitializePreflightRefusalCode,
	detail: string,
	step: ReinitializePreflightFailureStep,
): ReinitializePreflightScopeReport {
	return {
		ledger: home,
		outcome: 'failed',
		marker,
		refusal: { code, detail },
		reason: { step, message: detail },
	};
}

function failureCode(detail: string): ReinitializePreflightRefusalCode {
	if (detail.includes('widened grants')) return 'reinitialize-preflight-grants';
	if (detail.includes('owned by') || detail.includes('ownership'))
		return 'reinitialize-preflight-ownership';
	return 'reinitialize-preflight-failed';
}

async function checkpoint(
	observer: ReinitializePreflightObserver | undefined,
	point: ReinitializePreflightCheckpoint,
	home?: LedgerHome,
): Promise<void> {
	if (observer) await observer(point, home);
}

async function processScope(
	pool: PgReinitializePreflightPool,
	inspection: ReinitializePreflightScopeInspection,
	observer: ReinitializePreflightObserver | undefined,
): Promise<ReinitializePreflightScopeReport> {
	const client = await pool.connect();
	let begun = false;
	let failureStep: ReinitializePreflightFailureStep = 'advisory-lock';
	try {
		await client.query('BEGIN');
		begun = true;
		await client.query(REINITIALIZE_PREFLIGHT_LOCK_TIMEOUT_SQL);
		const lock = await acquirePgLedgerLocks(client, [inspection.home]);
		if (lock.kind !== 'acquired') {
			await client.query('ROLLBACK');
			begun = false;
			return refusal(
				inspection.home,
				inspection.marker,
				'reinitialize-preflight-advisory-lock',
				lock.kind === 'busy'
					? `reinitialize-preflight could not acquire advisory lock for ${schemaFor(lock.ledger)}`
					: `reinitialize-preflight advisory lock error for ${schemaFor(lock.ledger)}: ${errorDetail(lock.error)}`,
				'advisory-lock',
			);
		}
		failureStep = 'identity';
		const current = await inspectScope(client, inspection.home);
		if (
			current.marker.kind === 'older' ||
			current.marker.kind === 'future' ||
			current.marker.kind === 'mixed' ||
			current.marker.kind === 'unreadable'
		) {
			await client.query('ROLLBACK');
			begun = false;
			return refusal(
				current.home,
				current.marker,
				'reinitialize-preflight-marker-not-current',
				markerRefusal(current.marker),
				'marker',
			);
		}
		// A fresh database ledger has no dbsp_meta namespace yet, so bootstrap it
		// before reading that namespace's live OID. The marker remains deferred.
		let initializedDatabaseLedger = false;
		if (
			current.home.scope === 'database' &&
			current.marker.kind !== 'current'
		) {
			failureStep = 'create';
			await ensureDbspMetaLedger(client, { writeMarker: false });
			initializedDatabaseLedger = true;
		}
		const live = await readLiveIdentity(client, current.home);
		if (current.marker.kind === 'current') {
			if (current.identity && sameIdentity(current.identity, live)) {
				failureStep = 'ownership-grants';
				await validateOwnershipAndGrants(client, current.home);
				await client.query('COMMIT');
				begun = false;
				return {
					ledger: current.home,
					outcome: 'unchanged',
					marker: current.marker,
				};
			}
			// A lineage mismatch is not a malformed current ledger.  Preserve the
			// old structures before applying current-ledger admission checks to the
			// fresh structures; those checks would otherwise route the mismatch to a
			// refusal before it can take the mandated archive path.
			failureStep = 'archive';
			await archiveMismatchedLedger(client, current.home);
			await checkpoint(observer, 'archive', current.home);
		}
		failureStep = 'create';
		if (!initializedDatabaseLedger && current.home.scope === 'database')
			await ensureDbspMetaLedger(client, { writeMarker: false });
		else if (!initializedDatabaseLedger)
			await ensurePgLedger(client, current.home, { writeMarker: false });
		failureStep = 'record-identity';
		await recordPgLedgerIdentity(client, current.home, live);
		await checkpoint(observer, 'create', current.home);
		failureStep = 'creation-grants';
		await establishCreationOwnershipAndGrants(client, current.home);
		failureStep = 'ownership-grants';
		await validateOwnershipAndGrants(client, current.home);
		await checkpoint(observer, 'grants', current.home);
		failureStep = 'write-marker';
		await writePgLedgerShapeMarker(client, current.home);
		await checkpoint(observer, 'marker', current.home);
		await client.query('COMMIT');
		begun = false;
		return { ledger: current.home, outcome: 'current', marker: current.marker };
	} catch (error) {
		if (begun) {
			try {
				await client.query('ROLLBACK');
			} catch {
				// The original PostgreSQL denial remains the useful report detail.
			}
		}
		return refusal(
			inspection.home,
			inspection.marker,
			failureCode(errorDetail(error)),
			errorDetail(error),
			failureStep,
		);
	} finally {
		client.release?.();
	}
}

/**
 * Processes every already-admitted scope independently.  A scope report is a
 * normal result, including `failed`; it must never prevent a later scope from
 * starting its own transaction.  The catch also makes an unexpected per-scope
 * processing rejection reportable without widening it into a run refusal.
 */
export async function processReinitializePreflightScopes(
	inspections: readonly ReinitializePreflightScopeInspection[],
	process: (
		inspection: ReinitializePreflightScopeInspection,
	) => Promise<ReinitializePreflightScopeReport>,
): Promise<readonly ReinitializePreflightScopeReport[]> {
	const scopes: ReinitializePreflightScopeReport[] = [];
	for (const inspection of inspections) {
		const accessFailure = inspectionAccessFailure(inspection);
		if (accessFailure) {
			scopes.push(accessFailure);
			continue;
		}
		try {
			scopes.push(await process(inspection));
		} catch (error) {
			scopes.push(
				refusal(
					inspection.home,
					inspection.marker,
					failureCode(errorDetail(error)),
					errorDetail(error),
					'advisory-lock',
				),
			);
		}
	}
	return scopes;
}

function addressKey(address: LedgerAddress): string {
	return JSON.stringify([
		address.engine,
		address.database,
		address.schema ?? null,
		address.parent ?? null,
		address.kind,
		address.name,
	]);
}

/** Select exactly declarations whose home has no existing chain address. */
export function selectReinitializeAdoptionCandidates(
	declarations: DeclarationSet,
	chainAddresses: ReadonlySet<string>,
): readonly ReinitializePreflightAdoptionCandidate[] {
	return declarations.declarations
		.map((declaration) => ({
			address: {
				...declaration.address,
				scope: declaration.address.kind === 'extension' ? 'database' : 'schema',
			} as LedgerAddress,
			declaration: { value: declaration.fragment, digest: declaration.digest },
		}))
		.filter(
			(candidate) =>
				(candidate.address.kind !== 'table' ||
					!isDbspLedgerInfrastructureTable(candidate.address.name)) &&
				!chainAddresses.has(addressKey(candidate.address)),
		);
}

/** Completes a report without inventing an outcome outside the closed set. */
export function assembleReinitializePreflightScopeReports(
	homes: readonly LedgerHome[],
	completed: ReadonlyMap<string, ReinitializePreflightScopeReport>,
	markers: ReadonlyMap<string, LedgerMarkerState>,
): readonly ReinitializePreflightScopeReport[] {
	return homes.map((ledger) => {
		const key =
			ledger.scope === 'database' ? 'database' : `schema:${ledger.schema}`;
		return (
			completed.get(key) ?? {
				ledger,
				outcome: 'not-attempted' as const,
				marker: markers.get(key) ?? {
					kind: 'unreadable' as const,
					reason: 'scope was not inspected',
				},
			}
		);
	});
}

async function readChainAddresses(
	pool: PgReinitializePreflightPool,
	homes: readonly LedgerHome[],
): Promise<ReadonlySet<string>> {
	const client = await pool.connect();
	let begun = false;
	try {
		await client.query('BEGIN');
		begun = true;
		await client.query(REINITIALIZE_PREFLIGHT_LOCK_TIMEOUT_SQL);
		const addresses = new Set<string>();
		for (const home of homes) {
			const marker = await readPgLedgerMarker(client, home);
			if (marker.kind !== 'current') continue;
			const rows = await client.query(
				`SELECT address_engine, address_database, address_schema, address_parent, address_kind, address_name FROM ${qualified(home, DBSP_LEDGER_EVENT_TABLE)}`,
			);
			for (const row of rows.rows) {
				if (
					typeof row.address_engine !== 'string' ||
					typeof row.address_database !== 'string' ||
					typeof row.address_schema !== 'string' ||
					typeof row.address_kind !== 'string' ||
					typeof row.address_name !== 'string'
				)
					throw new Error(
						`ledger chain address is unreadable in ${schemaFor(home)}`,
					);
				addresses.add(
					addressKey({
						scope: home.scope,
						engine: row.address_engine,
						database: row.address_database,
						...(row.address_schema === ''
							? {}
							: { schema: row.address_schema }),
						...(row.address_parent === null
							? {}
							: { parent: row.address_parent as LedgerAddress }),
						kind: row.address_kind as LedgerAddress['kind'],
						name: row.address_name,
					}),
				);
			}
		}
		await client.query('COMMIT');
		begun = false;
		return addresses;
	} catch (error) {
		if (begun) {
			try {
				await client.query('ROLLBACK');
			} catch {
				// Preserve the original PostgreSQL timeout or denial.
			}
		}
		throw error;
	} finally {
		client.release?.();
	}
}

/**
 * Runs the separately privileged reinitialize-preflight. It never invokes a
 * ledger append primitive: the only durable writes are additive structure,
 * archived structure, identity, grants, marker, and the caller-owned output.
 */
export async function runPgReinitializePreflight(
	options: PgReinitializePreflightOptions,
): Promise<ReinitializePreflightReport> {
	const homes = homesFor(options.schemas);
	const inspectionClient = await options.pool.connect();
	let inspections: readonly ReinitializePreflightScopeInspection[];
	let inspectionBegun = false;
	try {
		await inspectionClient.query('BEGIN');
		inspectionBegun = true;
		await inspectionClient.query(REINITIALIZE_PREFLIGHT_LOCK_TIMEOUT_SQL);
		inspections = [];
		for (const home of homes) {
			await inspectionClient.query(
				'SAVEPOINT reinitialize_preflight_inspection',
			);
			inspections = [
				...inspections,
				await inspectScope(inspectionClient, home),
			];
			// An inspection-time PostgreSQL error aborts this transaction until a
			// savepoint rollback. Always roll back the read-only scope work so a
			// denied schema cannot prevent inspecting its later siblings.
			await inspectionClient.query(
				'ROLLBACK TO SAVEPOINT reinitialize_preflight_inspection',
			);
			await inspectionClient.query(
				'RELEASE SAVEPOINT reinitialize_preflight_inspection',
			);
		}
		await inspectionClient.query('COMMIT');
		inspectionBegun = false;
	} catch (error) {
		if (inspectionBegun) {
			try {
				await inspectionClient.query('ROLLBACK');
			} catch {
				// The original PostgreSQL error remains the useful failure.
			}
		}
		throw error;
	} finally {
		inspectionClient.release?.();
	}
	const markerFailure = inspections.find(
		({ marker }) =>
			marker.kind === 'older' ||
			marker.kind === 'future' ||
			marker.kind === 'mixed' ||
			marker.kind === 'unreadable',
	);
	if (markerFailure) {
		return {
			scopes: inspections.map((inspection) =>
				inspection === markerFailure
					? refusal(
							inspection.home,
							inspection.marker,
							'reinitialize-preflight-marker-not-current',
							markerRefusal(inspection.marker),
							'marker',
						)
					: {
							ledger: inspection.home,
							outcome: 'not-attempted',
							marker: inspection.marker,
						},
			),
			adoptionCandidates: [],
		};
	}
	const scopes = await processReinitializePreflightScopes(
		inspections,
		(inspection) => processScope(options.pool, inspection, options.observer),
	);
	if (scopes.some((scope) => scope.outcome === 'failed'))
		return { scopes, adoptionCandidates: [] };
	try {
		const chains = await readChainAddresses(options.pool, homes);
		const adoptionCandidates = selectReinitializeAdoptionCandidates(
			options.declarations,
			chains,
		);
		const report = { scopes, adoptionCandidates };
		await checkpoint(options.observer, 'output');
		await options.writeAdoptionFile(report);
		return report;
	} catch (error) {
		return {
			scopes: scopes.map((scope) =>
				scope.outcome === 'current' || scope.outcome === 'unchanged'
					? {
							...scope,
							outcome: 'failed' as const,
							refusal: {
								code: 'reinitialize-preflight-failed' as const,
								detail: errorDetail(error),
							},
							reason: {
								step: 'output' as const,
								message: errorDetail(error),
							},
						}
					: scope,
			),
			adoptionCandidates: [],
		};
	}
}
