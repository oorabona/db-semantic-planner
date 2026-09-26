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
	ForeignKeyIR,
	IndexIR,
	LedgerAddress,
	LedgerHome,
	ModelIR,
	NormalizedManagedStep,
	TableIR,
	TransitionRunMetadata,
} from '@dbsp/types';
import type { Pool, PoolClient } from 'pg';
import {
	comparePgsqlDatabaseSchema,
	createPgsqlGeneratedManagedStep,
	generateMigrationSQL,
	type SchemaChange,
} from '../ddl/index.js';
import { addressForChange } from '../ddl/managed-step-manifest.js';
import { collectFkAutoIndexSpecs, getPhase } from '../ddl/migration-sql.js';
import { getNamingPluginForDbCasing } from '../naming-plugin.js';
import { createPgsqlAdapter } from '../pgsql-adapter.js';
import { readPgCatalogueIdentity } from './catalogue-identity.js';
import { readPgLedgerAddressChain } from './chain-reader.js';
import { executeGeneratorPlan } from './generator-execution.js';
import {
	acquirePgLedgerSessionLock,
	ensurePgLedgerStorageVersion,
	PgLedgerStorageUnsupportedError,
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
	| 'unsupported-server'
	| 'busy'
	| 'execution-refused';

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
	if (change.kind === 'add_column') return plainNullableColumn(change);
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
	model: ModelIR,
	createdSequenceAddresses: ReadonlySet<string>,
): Promise<void> {
	for (const sequence of model.sequences?.values() ?? []) {
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
		if (createdSequenceAddresses.has(canonicalJsonDigest(address))) continue;
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
): void {
	for (const [key, sequence] of model.sequences ?? []) {
		if (key !== sequence.name)
			throw refusal(
				'unsupported-change',
				[],
				`converge refuses declared sequence map key ${key}: SequenceIR.name is ${sequence.name}`,
			);
		for (const name of [key, sequence.name]) {
			const physicalName = naming.toDatabase(name);
			if (physicalName !== name)
				throw refusal(
					'unsupported-change',
					[],
					`converge refuses declared sequence ${name}: configured naming gives physical name ${physicalName}; see #803`,
				);
		}
	}
}

function sameColumnSet(
	left: readonly string[],
	right: readonly string[],
): boolean {
	const leftKey = canonicalColumnSet(left);
	const rightKey = canonicalColumnSet(right);
	return leftKey !== undefined && leftKey === rightKey;
}

/** A unique-key column set, with duplicates rejected and names encoded unambiguously. */
function canonicalColumnSet(columns: readonly string[]): string | undefined {
	if (new Set(columns).size !== columns.length) return undefined;
	return JSON.stringify([...columns].sort());
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

function isQualifyingUniqueIndex(
	index: IndexIR | undefined,
	columns: readonly string[],
): boolean {
	return (
		index?.unique === true &&
		index.where === undefined &&
		(index.expressions === undefined || index.expressions.length === 0) &&
		sameColumnSet(index.columns, columns)
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

function convergePhase(change: SchemaChange): number {
	if (change.kind === 'create_index') return getPhase('add_foreign_key');
	if (change.kind === 'add_foreign_key') return getPhase('create_index');
	return getPhase(change.kind);
}

function describeFkAutoIndexSpecs(
	specs: ReturnType<typeof collectFkAutoIndexSpecs>,
): string {
	return specs
		.map((spec) => `${spec.table}.${spec.keys[0]?.column} (${spec.name})`)
		.join(', ');
}

/**
 * Converges only startup-safe PostgreSQL additions: it creates tables and
 * sequences, adds plain nullable columns to managed tables, and creates
 * indexes, CHECK constraints, and foreign keys when their table parents are
 * created by this same run (for foreign keys, both tables).
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
		| 'converge could not determine ledger lock acquisition'
		| 'converge could not confirm ledger lock release'
		| 'converge received a transport-ambiguous outcome'
		| undefined;
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
		assertDeclaredSequenceNamesPreserved(model, naming);
		const declaredTables = [...model.tables.values()].map((table) =>
			naming.toDatabase(table.name),
		);
		const declaredSequences = new Set(model.sequences?.keys() ?? []);
		const declarationScopedAdapter = new Proxy(adapter, {
			get(target, property, receiver) {
				if (property === 'introspect') {
					return (
						introspectionOptions?: Parameters<typeof target.introspect>[0],
					) =>
						target
							.introspect({
								...introspectionOptions,
								include: declaredTables,
								// `include: []` means all tables to the introspector. An empty
								// declaration must instead compare no live tables.
								...(declaredTables.length === 0 ? { exclude: ['*'] } : {}),
							})
							.then((introspected) => ({
								...introspected,
								sequences: new Map(
									[...(introspected.sequences ?? [])].filter(([name]) =>
										declaredSequences.has(name),
									),
								),
							}));
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
			model,
			createdSequenceAddresses,
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
		const fkUniqueIndexes = assertFreshForeignKeysReferenceUniqueKeys(
			diff.changes,
			database,
			schema,
		);
		const fkAutoIndexSpecs = collectFkAutoIndexSpecs(diff.changes, schema);
		if (fkAutoIndexSpecs.length > 0) {
			const tables = new Set(fkAutoIndexSpecs.map((spec) => spec.table));
			throw refusal(
				'unsupported-change',
				diff.changes.filter(
					(change) =>
						change.kind === 'create_table' && tables.has(change.table),
				),
				`converge refuses fresh foreign keys without declared indexes: ${describeFkAutoIndexSpecs(fkAutoIndexSpecs)}; declare each index in the model`,
			);
		}
		await assertExistingDeclaredTablesManaged(
			client,
			database,
			schema,
			model,
			casing,
			new Set(diff.changes.map((change) => naming.toDatabase(change.table))),
		);
		if (diff.changes.length === 0) return { kind: 'no-drift', applied: [] };
		const orderedChanges = [...diff.changes].sort(
			(left, right) => convergePhase(left) - convergePhase(right),
		);
		const createTableStepKeys = new Map<string, string>();
		const createIndexStepKeys = new Map<SchemaChange, string>();
		for (const [order, change] of orderedChanges.entries()) {
			if (change.kind === 'create_table') {
				const address = generatedAddress(change, database, schema);
				createTableStepKeys.set(
					canonicalJsonDigest(address),
					`converge:${order}`,
				);
			}
			if (change.kind === 'create_index')
				createIndexStepKeys.set(change, `converge:${order}`);
		}
		const assembled: {
			readonly change: SchemaChange;
			readonly step: NormalizedManagedStep;
		}[] = [];
		for (const [order, change] of orderedChanges.entries()) {
			const address = generatedAddress(change, database, schema);
			const parent = parentAddress(address);
			const dependencies = new Set<string>();
			if (
				parent &&
				(change.kind === 'create_index' ||
					change.kind === 'add_check_constraint' ||
					change.kind === 'add_foreign_key')
			) {
				const dependency = createTableStepKeys.get(canonicalJsonDigest(parent));
				if (!dependency)
					throw new Error(
						`converge admitted ${change.kind} without a creating table step`,
					);
				dependencies.add(dependency);
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
				stepKey: `converge:${order}`,
				order,
				dependencyOrder: [...dependencies],
				statements,
			});
			assembled.push({ change, step });
		}
		const manifest = validateNormalizedManagedStepManifest(
			assembled.map(({ step }) => step),
		);
		if (!manifest.ok)
			throw new Error(`converge manifest is invalid: ${manifest.detail}`);
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
				applied: orderedChanges.map((change) => change.kind),
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
