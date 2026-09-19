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
	releasePgLedgerSessionLock,
} from './ledger.js';
import { lockPgJournalRun, type PgLockedRun } from './outcome-protocol.js';
import { readPgLedgerScopeCurrency } from './reinitialize-preflight.js';

export type PgConvergeRefusal =
	| 'unsupported-change'
	| 'unmanaged-object'
	| 'unmanaged-parent'
	| 'concurrent-drift'
	| 'ledger-absent'
	| 'incompatible-ledger'
	| 'busy'
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
	  }
	| {
			readonly kind: 'recovery-required';
			/**
			 * Locator for a reconciliation workflow, not a recovery handle: recovery
			 * also needs the address, reservations, resolution event id, and read-back.
			 */
			readonly claimId: string;
			readonly detail: string;
	  }
	| { readonly kind: 'transport-ambiguous'; readonly detail: string };

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
	return false;
}

function parentAddress(address: LedgerAddress): LedgerAddress | undefined {
	if (address.kind !== 'column') return undefined;
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
		// Reaching this loop means comparison saw the table: an absent table would
		// produce create_table, put it in changedTables, and skip this check.
		if (changedTables.has(address.name)) continue;
		const live = await readPgCatalogueIdentity(client, address);
		if (!live)
			throw refusal(
				'concurrent-drift',
				[],
				`converge observed declared table ${address.name} absent after comparison`,
			);
		if (!(await isManagedCurrent(client, address)))
			throw refusal(
				'unmanaged-object',
				[],
				`converge refuses unmanaged live table ${address.name}`,
			);
	}
}

/**
 * Converges only startup-safe PostgreSQL additions: it creates eligible tables
 * and adds plain nullable columns to managed tables. It does not create indexes.
 *
 * Converge mutates only declared additions whose target and existing parent pass
 * managed admission. It compares structural shape; it does not audit the
 * provenance of an exact-matching child already present on a managed table.
 * Its run ids are ephemeral claim namespaces: no transition journal or durable
 * run relation is touched.
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
	let destroyReason:
		| 'converge could not confirm ledger lock release'
		| 'converge received a transport-ambiguous outcome'
		| 'converge received a recovery-required outcome'
		| undefined;
	let locked = false;
	try {
		const lock = await acquirePgLedgerSessionLock(client, schemaHome(schema));
		if (lock.kind === 'busy')
			throw new PgConvergeRefusalError(
				'busy',
				[],
				'converge schema ledger lock is busy',
			);
		locked = true;
		lockedConvergeClients.add(client);
		const currency = await readPgLedgerScopeCurrency(
			client,
			schemaHome(schema),
		);
		if (currency.kind === 'absent')
			throw new PgConvergeRefusalError(
				'ledger-absent',
				[],
				`converge requires a current schema ledger for ${schema}; runPgReinitializePreflight creates one`,
			);
		if (currency.kind === 'not-current')
			throw new PgConvergeRefusalError(
				'incompatible-ledger',
				[],
				`converge requires a current schema ledger for ${schema}; ledger currency failed ${currency.reason}`,
			);
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
		if (outcome.outcome === 'recovery-required') {
			destroyReason = 'converge received a recovery-required outcome';
			return {
				kind: 'recovery-required',
				claimId: outcome.claimId,
				detail: outcome.detail,
			};
		}
		if (outcome.outcome === 'transport-ambiguous') {
			destroyReason = 'converge received a transport-ambiguous outcome';
			return { kind: 'transport-ambiguous', detail: outcome.detail };
		}
		throw refusal('execution-refused', diff.changes, outcome.detail);
	} finally {
		lockedConvergeClients.delete(client);
		if (locked) {
			try {
				if (!(await releasePgLedgerSessionLock(client, schemaHome(schema))))
					destroyReason = 'converge could not confirm ledger lock release';
			} catch {
				destroyReason = 'converge could not confirm ledger lock release';
			}
		}
		client.release(
			destroyReason === undefined ? undefined : new Error(destroyReason),
		);
	}
}
