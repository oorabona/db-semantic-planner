import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
	canonicalJsonDigest,
	projectLedgerChain,
	validateDeclarationModel,
	validateNormalizedManagedStepManifest,
} from '@dbsp/core';
import { mintDurablyLoadedRun } from '@dbsp/core/internal';
import type {
	DbCasing,
	LedgerAddress,
	LedgerHome,
	LedgerIdentity,
	ModelIR,
	NormalizedManagedStep,
	TransitionRunMetadata,
} from '@dbsp/types';
import type { Pool, PoolClient } from 'pg';
import {
	comparePgsqlDatabaseSchema,
	createPgsqlGeneratedManagedStep,
	generateMigrationSQL,
	type SchemaChange,
} from '../ddl/index.js';
import { getNamingPluginForDbCasing } from '../naming-plugin.js';
import { createPgsqlAdapter } from '../pgsql-adapter.js';
import { readPgCatalogueIdentity } from './catalogue-identity.js';
import { readPgLedgerAddressChain } from './chain-reader.js';
import { executeGeneratorPlan } from './generator-execution.js';
import {
	acquirePgLedgerSessionLock,
	ensureDbspMetaLedger,
	ensurePgLedger,
	recordPgLedgerIdentity,
	releasePgLedgerSessionLock,
	writePgLedgerShapeMarker,
} from './ledger.js';
import { lockPgJournalRun, type PgLockedRun } from './outcome-protocol.js';
import { readPgLedgerScopeCurrency } from './reinitialize-preflight.js';

export type PgConvergeRefusal =
	| 'unsupported-change'
	| 'unmanaged-object'
	| 'unmanaged-parent'
	| 'incompatible-ledger'
	| 'execution-refused';

/** A typed refusal leaves no claim that a durable run was created or can recover. */
export class PgConvergeRefusalError extends Error {
	constructor(
		readonly refusal: PgConvergeRefusal,
		readonly changes: readonly Pick<
			SchemaChange,
			'kind' | 'table' | 'column' | 'details'
		>[],
		readonly detail?: string,
	) {
		super(detail ?? `converge refuses ${refusal}`);
		this.name = 'PgConvergeRefusalError';
	}
}

export type PgConvergeResult =
	| { readonly kind: 'no-drift'; readonly applied: readonly string[] }
	| { readonly kind: 'applied'; readonly applied: readonly string[] }
	| {
			readonly kind: 'partially-applied';
			readonly completedStepKeys: readonly string[];
			readonly notStartedStepKeys: readonly string[];
			readonly detail: string;
	  };

export interface ConvergePgOptions {
	readonly schema?: string;
	readonly dbCasing?: DbCasing;
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

function plainNullableColumn(change: SchemaChange): boolean {
	if (change.kind !== 'add_column' || !change.meta?.column) return false;
	const column = change.meta.column;
	if (typeof column !== 'object' || Array.isArray(column)) return false;
	const record = column as Record<string, unknown>;
	// This is intentionally a positive shape allowlist. New ColumnIR surface
	// cannot become startup DDL until this list is deliberately reconsidered.
	return (
		Object.keys(record).every((key) =>
			['name', 'type', 'nullable'].includes(key),
		) &&
		typeof record.name === 'string' &&
		typeof record.type === 'string' &&
		record.nullable === true
	);
}

function additiveChange(change: SchemaChange): boolean {
	if (change.kind === 'create_table') return true;
	if (change.kind === 'add_column') return plainNullableColumn(change);
	if (change.kind !== 'create_index') return false;
	const index = change.meta?.index;
	return (
		index !== null &&
		typeof index === 'object' &&
		!Array.isArray(index) &&
		(index as Record<string, unknown>).unique !== true &&
		(index as Record<string, unknown>).concurrently !== true
	);
}

function parentAddress(address: LedgerAddress): LedgerAddress | undefined {
	if (address.kind !== 'column' && address.kind !== 'index') return undefined;
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

async function liveLedgerIdentity(
	executor: Queryable,
	home: LedgerHome,
): Promise<LedgerIdentity> {
	const schema = home.scope === 'database' ? 'dbsp_meta' : home.schema;
	const row = (
		await executor.query(
			`SELECT (pg_catalog.pg_control_system()).system_identifier::text AS cluster_system_identifier, database_row.oid::text AS database_oid, namespace_row.oid::text AS namespace_oid FROM pg_catalog.pg_database database_row CROSS JOIN pg_catalog.pg_namespace namespace_row WHERE database_row.datname = pg_catalog.current_database() AND namespace_row.nspname = $1`,
			[schema],
		)
	).rows[0];
	if (
		typeof row?.cluster_system_identifier !== 'string' ||
		typeof row.database_oid !== 'string' ||
		typeof row.namespace_oid !== 'string'
	)
		throw new Error(`converge could not read ledger identity for ${schema}`);
	return {
		clusterSystemIdentifier: row.cluster_system_identifier,
		databaseOid: row.database_oid,
		namespaceOid: row.namespace_oid,
	};
}

async function ledgerHasRelations(
	executor: Queryable,
	home: LedgerHome,
): Promise<boolean> {
	const schema = home.scope === 'database' ? 'dbsp_meta' : home.schema;
	const result = await executor.query(
		`SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_class relation JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = $1 AND relation.relname LIKE 'dbsp_ledger_%') AS present`,
		[schema],
	);
	return result.rows[0]?.present === true;
}

/** Bootstrap only wholly absent ledger homes, with markers as the final writes. */
async function bootstrapLedgers(
	client: PoolClient,
	schema: string,
): Promise<void> {
	const homes: readonly LedgerHome[] = [
		{ scope: 'database' },
		schemaHome(schema),
	];
	await client.query('BEGIN');
	try {
		const absent: LedgerHome[] = [];
		for (const home of homes) {
			const currency = await readPgLedgerScopeCurrency(client, home);
			if (currency.kind === 'current') continue;
			if (currency.kind === 'not-current')
				throw refusal(
					'incompatible-ledger',
					[],
					`converge refuses non-current ledger ${home.scope === 'database' ? 'dbsp_meta' : schema}`,
				);
			if (await ledgerHasRelations(client, home))
				throw refusal(
					'incompatible-ledger',
					[],
					`converge refuses partially present ledger ${home.scope === 'database' ? 'dbsp_meta' : schema}`,
				);
			absent.push(home);
		}
		for (const home of absent) {
			if (home.scope === 'database')
				await ensureDbspMetaLedger(client, { writeMarker: false });
			else await ensurePgLedger(client, home, { writeMarker: false });
			await recordPgLedgerIdentity(
				client,
				home,
				await liveLedgerIdentity(client, home),
			);
		}
		for (const home of absent) await writePgLedgerShapeMarker(client, home);
		await client.query('COMMIT');
	} catch (error) {
		await client.query('ROLLBACK').catch(() => undefined);
		throw error;
	}
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

async function isManagedCurrent(
	client: PoolClient,
	address: LedgerAddress,
): Promise<boolean> {
	const live = await readPgCatalogueIdentity(client, address);
	if (!live?.catalogueIdentity) return false;
	const chain = await readPgLedgerAddressChain(
		client,
		addressHome(address),
		address,
	);
	const state = projectLedgerChain(chain);
	return (
		state.kind === 'projected-ledger-chain' &&
		state.stableState === 'managed' &&
		isDeepStrictEqual(
			chain.terminalMember?.catalogueIdentity,
			live.catalogueIdentity,
		)
	);
}

async function assertOwnedChange(
	client: PoolClient,
	change: SchemaChange,
	step: NormalizedManagedStep,
	previouslyCreatedAddresses: ReadonlySet<string>,
	laterCreatedAddresses: ReadonlySet<string>,
): Promise<void> {
	const address = step.address;
	if (!address) throw new Error(`converge step ${step.stepKey} has no address`);
	const parent = parentAddress(address);
	if (parent && !previouslyCreatedAddresses.has(canonicalJsonDigest(parent))) {
		if (laterCreatedAddresses.has(canonicalJsonDigest(parent)))
			throw refusal(
				'unmanaged-parent',
				[change],
				`converge refuses ${change.kind} because parent ${parent.name} is created later in the manifest`,
			);
		if (!(await isManagedCurrent(client, parent)))
			throw refusal(
				'unmanaged-parent',
				[change],
				`converge refuses ${change.kind} on unmanaged parent ${parent.name}`,
			);
	}
	const live = await readPgCatalogueIdentity(client, address);
	if (live && !(await isManagedCurrent(client, address)))
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
	changedTables: ReadonlySet<string>,
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
		// A table with a declared diff is checked by assertOwnedChange while the
		// manifest is assembled, so an obstacle refuses the whole convergence
		// before any planned DDL runs.
		if (changedTables.has(address.name)) continue;
		if (
			(await readPgCatalogueIdentity(client, address)) &&
			!(await isManagedCurrent(client, address))
		)
			throw refusal(
				'unmanaged-object',
				[],
				`converge refuses unmanaged live table ${address.name}`,
			);
	}
}

/**
 * Converges only startup-safe PostgreSQL additions. Its run ids are ephemeral
 * claim namespaces: no transition journal or durable run relation is touched.
 */
export async function convergePg(
	pool: Pool,
	model: ModelIR,
	options: ConvergePgOptions = {},
): Promise<PgConvergeResult> {
	validateDeclarationModel(model);
	const schema = options.schema ?? 'public';
	const casing = options.dbCasing ?? 'preserve';
	const client = await pool.connect();
	let destroy = false;
	let locked = false;
	try {
		const lock = await acquirePgLedgerSessionLock(client, schemaHome(schema));
		if (lock.kind === 'busy')
			throw new PgConvergeRefusalError(
				'execution-refused',
				[],
				'converge schema ledger lock is busy',
			);
		locked = true;
		lockedConvergeClients.add(client);
		await bootstrapLedgers(client, schema);
		const database = await databaseId(client);
		const adapter = createPgsqlAdapter(client, {
			borrowedClient: true,
			dbCasing: casing,
		});
		const naming = getNamingPluginForDbCasing(casing);
		const declaredTables = [...model.tables.values()].map((table) =>
			naming.toDatabase(table.name),
		);
		const declarationScopedAdapter = new Proxy(adapter, {
			get(target, property, receiver) {
				if (property === 'introspect') {
					return (
						introspectionOptions?: Parameters<typeof target.introspect>[0],
					) =>
						target.introspect({
							...introspectionOptions,
							include: declaredTables,
							// `include: []` means all tables to the introspector. An empty
							// declaration must instead compare no live tables.
							...(declaredTables.length === 0 ? { exclude: ['*'] } : {}),
						});
				}
				return Reflect.get(target, property, receiver);
			},
		});
		const diff = await comparePgsqlDatabaseSchema(
			declarationScopedAdapter,
			model,
			{
				schema,
				dbCasing: casing,
				ignoreUnmanagedExtensions: true,
			},
		);
		const rejected = diff.changes.filter((change) => !additiveChange(change));
		if (rejected.length > 0)
			throw refusal(
				'unsupported-change',
				rejected,
				`converge refuses change ${rejected.map((change) => change.kind).join(', ')}`,
			);
		await assertExistingDeclaredTablesManaged(
			client,
			database,
			schema,
			model,
			casing,
			new Set(diff.changes.map((change) => naming.toDatabase(change.table))),
		);
		if (diff.changes.length === 0) return { kind: 'no-drift', applied: [] };
		const assembled: {
			readonly change: SchemaChange;
			readonly step: NormalizedManagedStep;
		}[] = [];
		const createdAddresses = new Set<string>();
		for (const change of diff.changes) {
			const order = assembled.length;
			const statements = generateMigrationSQL(
				{ ...diff, changes: [change] },
				{ includeDestructive: false, schemaName: schema },
			);
			const step = createPgsqlGeneratedManagedStep({
				change,
				database,
				schema,
				stepKey: `converge:${order}`,
				order,
				statements,
			});
			assembled.push({ change, step });
			if (change.kind === 'create_table' && step.address)
				createdAddresses.add(canonicalJsonDigest(step.address));
		}
		const manifest = validateNormalizedManagedStepManifest(
			assembled.map(({ step }) => step),
		);
		if (!manifest.ok)
			throw new Error(`converge manifest is invalid: ${manifest.detail}`);
		const previouslyCreatedAddresses = new Set<string>();
		const laterCreatedAddresses = new Set(createdAddresses);
		for (const { change, step } of assembled) {
			if (change.kind === 'create_table' && step.address)
				laterCreatedAddresses.delete(canonicalJsonDigest(step.address));
			await assertOwnedChange(
				client,
				change,
				step,
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
		});
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
		});
		if (outcome.outcome === 'completed')
			return {
				kind: 'applied',
				applied: diff.changes.map((change) => change.kind),
			};
		if (outcome.outcome === 'partially-applied')
			return {
				kind: 'partially-applied',
				completedStepKeys: outcome.completedStepKeys,
				notStartedStepKeys: outcome.notStartedStepKeys,
				detail: outcome.detail,
			};
		throw refusal(
			'execution-refused',
			diff.changes,
			`converge ${outcome.outcome}: ${outcome.detail ?? ''}`,
		);
	} finally {
		lockedConvergeClients.delete(client);
		if (locked) {
			try {
				if (!(await releasePgLedgerSessionLock(client, schemaHome(schema))))
					destroy = true;
			} catch {
				destroy = true;
			}
		}
		client.release(
			destroy
				? new Error('converge could not confirm ledger lock release')
				: undefined,
		);
	}
}
