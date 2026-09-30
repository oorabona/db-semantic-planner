import { canonicalJsonDigest } from '@dbsp/core';
import type { DbCasing, IndexIR, ModelIR, TableIR } from '@dbsp/types';
import type { Pool, PoolClient } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPgsqlGeneratedManagedStep } from '../ddl/managed-step-manifest.js';
import { compareSchemata, type SchemaChange } from '../ddl/schema-diff.js';
import { getNamingPluginForDbCasing } from '../naming-plugin.js';
import {
	physicalizeDeclaredSequences,
	SequenceNameMapKeyMismatchError,
} from '../sequence-name.js';
import type { PgDatabaseWritability } from './database-writability.js';
import type {
	executeGeneratorPlan,
	GeneratorExecutionResult,
} from './generator-execution.js';

const mocks = vi.hoisted(() => {
	const introspect = vi.fn<(...args: unknown[]) => Promise<unknown>>(
		async () => undefined,
	);
	return {
		compare: vi.fn(),
		declaredComparison: vi.fn(),
		createStep: vi.fn(),
		generate: vi.fn<(...args: unknown[]) => readonly string[]>(() => [
			'CREATE TABLE "users" ()',
		]),
		execute: vi.fn<
			(
				input: Parameters<typeof executeGeneratorPlan>[0],
			) => Promise<GeneratorExecutionResult>
		>(async () => ({ outcome: 'completed' })),
		identity: vi.fn(),
		chain: vi.fn<
			(...args: unknown[]) => Promise<{
				readonly ledger?: unknown;
				readonly address?: unknown;
				readonly events: readonly never[];
			}>
		>(async (...args: unknown[]) => ({
			ledger: args[1],
			address: args[2],
			events: [],
		})),
		reservations: vi.fn(async () => []),
		runIds: vi.fn(async () => new Map()),
		lock: vi.fn(async () => ({ kind: 'acquired' })),
		unlock: vi.fn(async () => true),
		currency: vi.fn(async () => ({ kind: 'current' })),
		preflight: vi.fn(async () => ({
			scopes: [
				{
					ledger: { scope: 'schema', schema: 'public' },
					outcome: 'current',
					marker: { kind: 'absent' },
				},
			],
			adoptionCandidates: [],
		})),
		writability: vi.fn<() => Promise<PgDatabaseWritability>>(async () => ({
			kind: 'writable',
		})),
		sequenceShape: vi.fn(async () => true),
		introspect,
		adapter: {
			introspect,
			withScratchScope: async (fn: (scope: unknown) => Promise<unknown>) => {
				const scope = {
					executeRaw: async (sql: string) =>
						sql.includes("current_setting('search_path')")
							? [{ search_path: 'public' }]
							: [],
					transaction: async (inner: (value: unknown) => Promise<unknown>) =>
						inner(scope),
				};
				return fn(scope);
			},
		},
	};
});

let cannedComparisonChanges: readonly SchemaChange[] = [];
const mockResolvedComparison = mocks.compare.mockResolvedValue.bind(
	mocks.compare,
);
mocks.compare.mockResolvedValue = ((value: {
	readonly changes?: readonly SchemaChange[];
}) => {
	cannedComparisonChanges = value.changes ?? [];
	return mockResolvedComparison(value);
}) as never;

function forward(fn: unknown, args: readonly unknown[]): unknown {
	return (fn as (...values: readonly unknown[]) => unknown)(...args);
}

vi.mock('../ddl/index.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../ddl/index.js')>()),
	createPgsqlGeneratedManagedStep: (...args: unknown[]) =>
		forward(mocks.createStep, args),
}));

vi.mock('../ddl/migration-sql.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../ddl/migration-sql.js')>()),
	generateMigrationSQL: (...args: unknown[]) => forward(mocks.generate, args),
}));

vi.mock('../ddl/live-diff.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../ddl/live-diff.js')>()),
	comparePgsqlDeclaredAdoptionSchema: async (...args: unknown[]) => {
		const input = args[0] as {
			readonly model: ModelIR;
			readonly schema: string;
			readonly dbCasing: DbCasing;
			readonly externalIndexMask?: ReadonlySet<string>;
			readonly ownershipMask?: unknown;
		};
		forward(mocks.declaredComparison, [input]);
		const declaredTables = new Set(
			[...input.model.tables.values()].map((table) =>
				input.dbCasing === 'snake_case'
					? table.name.replace(
							/[A-Z]/g,
							(character) => `_${character.toLowerCase()}`,
						)
					: table.name,
			),
		);
		const naming = getNamingPluginForDbCasing(input.dbCasing);
		const declaredSequences = new Set(
			physicalizeDeclaredSequences(input.model.sequences, naming).keys(),
		);
		const legacyRawSequenceNames = new Set(
			[...(input.model.sequences?.values() ?? [])]
				.filter((sequence) => {
					const databaseName = naming.toDatabase(sequence.name);
					return (
						databaseName !== sequence.name &&
						!declaredSequences.has(sequence.name)
					);
				})
				.map((sequence) => sequence.name),
		);
		const declaredEnums = new Set(input.model.enums?.keys() ?? []);
		const adapter = new Proxy(mocks.adapter, {
			get(target, property, receiver) {
				if (property === 'introspect')
					return async (options?: Record<string, unknown>) => {
						const introspected = (await target.introspect(options)) as ModelIR;
						return {
							...introspected,
							tables: new Map(
								[...introspected.tables].filter(([name]) =>
									declaredTables.has(name),
								),
							),
							sequences: new Map(
								[...(introspected.sequences ?? [])].filter(
									([name]) =>
										declaredSequences.has(name) ||
										(legacyRawSequenceNames.has(name) &&
											!introspected.sequences?.has(naming.toDatabase(name))),
								),
							),
							enums: new Map(
								[...(introspected.enums ?? [])].filter(([name]) =>
									declaredEnums.has(name),
								),
							),
						};
					};
				return Reflect.get(target, property, receiver);
			},
		});
		const compared = (await forward(mocks.compare, [
			adapter,
			input.model,
			{
				schema: input.schema,
				dbCasing: input.dbCasing,
				ignoreUnmanagedExtensions: true,
			},
		])) as { readonly changes: readonly SchemaChange[] };
		return {
			...compared,
			changes: compared.changes.filter((change) => {
				if (change.kind !== 'drop_index') return true;
				const index = change.meta?.index;
				if (!index || typeof index !== 'object' || Array.isArray(index))
					return true;
				return !(
					'name' in index &&
					typeof index.name === 'string' &&
					input.externalIndexMask?.has(
						JSON.stringify([change.table, index.name]),
					)
				);
			}),
		};
	},
}));
vi.mock('../pgsql-adapter.js', () => ({
	createPgsqlAdapter: () => mocks.adapter,
}));
vi.mock('./generator-execution.js', () => ({
	executeGeneratorPlan: (...args: unknown[]) => forward(mocks.execute, args),
}));
vi.mock('./catalogue-identity.js', () => ({
	readPgCatalogueIdentity: (...args: unknown[]) =>
		forward(mocks.identity, args),
}));
vi.mock('./chain-reader.js', () => ({
	readPgLedgerAddressChain: (...args: unknown[]) => forward(mocks.chain, args),
}));
vi.mock('./database-writability.js', () => ({
	classifyPgDatabaseWritability: (...args: unknown[]) =>
		forward(mocks.writability, args),
}));
vi.mock('./ledger.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('./ledger.js')>()),
	acquirePgLedgerSessionLock: (...args: unknown[]) => forward(mocks.lock, args),
	readPgLedgerReservationsForHome: (...args: unknown[]) =>
		forward(mocks.reservations, args),
	releasePgLedgerSessionLock: (...args: unknown[]) =>
		forward(mocks.unlock, args),
}));
vi.mock('./journal.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('./journal.js')>()),
	readTransitionRunIdsForExecutionIds: (...args: unknown[]) =>
		forward(mocks.runIds, args),
}));
vi.mock('./reinitialize-preflight.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('./reinitialize-preflight.js')>()),
	readPgLedgerScopeCurrency: (...args: unknown[]) =>
		forward(mocks.currency, args),
	runPgConvergeInitializationPreflight: (...args: unknown[]) =>
		forward(mocks.preflight, args),
}));
vi.mock('./sequence-adoption.js', () => ({
	pgDeclaredSequenceAdoptionShapeMatches: (...args: unknown[]) =>
		forward(mocks.sequenceShape, args),
}));

import {
	type ConvergePgCheckOptions,
	type ConvergePgOptions,
	convergePg,
	type PgConvergeCheckResult,
	PgConvergeRefusalError,
	type PgConvergeResult,
} from './converge.js';
import { rollbackPgOutcomeGroup } from './outcome-protocol.js';

function emptyModel(): ModelIR {
	const tables = new Map(
		cannedComparisonChanges.flatMap((change) =>
			change.kind === 'create_table'
				? [
						[
							change.table,
							change.meta?.table !== undefined &&
							Array.isArray((change.meta.table as TableIR).columns) &&
							Array.isArray((change.meta.table as TableIR).foreignKeys) &&
							Array.isArray((change.meta.table as TableIR).indexes)
								? (change.meta.table as TableIR)
								: {
										name: change.table,
										columns: [],
										foreignKeys: [],
										indexes: [],
									},
						] as const,
					]
				: [],
		),
	);
	return {
		tables,
		relations: new Map(),
		getTable: (name) => tables.get(name),
		getRelation: () => undefined,
		getRelationsFrom: () => [],
		getRelationsTo: () => [],
		isAmbiguous: () => ({ ambiguous: false, options: [] }),
	};
}

function modelWithSequences(names: readonly string[]): ModelIR {
	return {
		...emptyModel(),
		sequences: new Map(names.map((name) => [name, { name }])),
	};
}

function modelWithEnums(names: readonly string[]): ModelIR {
	return {
		...emptyModel(),
		enums: new Map(names.map((name) => [name, { name, values: ['pending'] }])),
	};
}

function modelWithTable(
	name: string,
	indexes: readonly TableIR['indexes'][number][] = [],
): ModelIR {
	return modelWithTables([{ name, columns: [], foreignKeys: [], indexes }]);
}

function modelWithTables(tables: readonly TableIR[]): ModelIR {
	const tableMap = new Map(tables.map((table) => [table.name, table]));
	return {
		...emptyModel(),
		tables: tableMap,
		getTable: (tableName) => tableMap.get(tableName),
	};
}

function mockManagedObjects(): void {
	const catalogueIdentity = {
		engine: 'postgresql',
		format: 1,
		value: { oid: '1' },
	};
	mocks.identity.mockResolvedValue({ catalogueIdentity });
	mocks.chain.mockImplementation((async (...args: unknown[]) => {
		const address = args[2] as Record<string, unknown>;
		return {
			ledger: { scope: 'schema', schema: 'public' },
			address,
			events: [
				{
					eventId: 'adopt-intent',
					address,
					eventKind: 'adopt-intent',
					controller: 'deployment',
				},
				{
					eventId: 'adopt',
					predecessor: 'adopt-intent',
					address,
					eventKind: 'adopt',
					controller: 'deployment',
					observed: { value: { table: address.name }, digest: 'observed' },
				},
			],
			terminalMember: { catalogueIdentity },
		};
	}) as never);
}

function mockManagedObjectsWithUnmanagedApplicationSteps(): void {
	const catalogueIdentity = {
		engine: 'postgresql',
		format: 1,
		value: { oid: '1' },
	};
	mocks.identity.mockResolvedValue({ catalogueIdentity });
	mocks.chain.mockImplementation((async (...args: unknown[]) => {
		const address = args[2] as Record<string, unknown>;
		if (address.kind === 'application-step') return { address, events: [] };
		return {
			ledger: { scope: 'schema', schema: 'public' },
			address,
			events: [
				{
					eventId: 'adopt-intent',
					address,
					eventKind: 'adopt-intent',
					controller: 'deployment',
				},
				{
					eventId: 'adopt',
					predecessor: 'adopt-intent',
					address,
					eventKind: 'adopt',
					controller: 'deployment',
					observed: { value: { table: address.name }, digest: 'observed' },
				},
			],
			terminalMember: { catalogueIdentity },
		};
	}) as never);
}

function createTableWithForeignKey(
	table: string,
	foreignKeyColumns: readonly string[],
	indexes: readonly {
		readonly name: string;
		readonly columns: readonly string[];
	}[] = [],
): SchemaChange {
	return {
		kind: 'create_table',
		table,
		destructive: false,
		details: `Create table ${table}`,
		meta: {
			table: {
				name: table,
				columns: [],
				foreignKeys: [
					{
						columns: foreignKeyColumns,
						references: { table: 'parents', columns: ['id'] },
					},
				],
				indexes,
			},
		},
	};
}

function freshSingleColumnFkChange(
	overrides: Partial<TableIR> = {},
): SchemaChange {
	const table: TableIR = {
		name: 'posts',
		columns: [
			{ name: 'author_id', type: 'integer', nullable: false },
			{ name: 'tenant_id', type: 'integer', nullable: false },
			{ name: 'id', type: 'integer', nullable: false },
		],
		foreignKeys: [
			{
				columns: ['author_id'],
				references: { table: 'parents', columns: ['id'] },
			},
		],
		indexes: [],
		...overrides,
	};
	return {
		kind: 'create_table',
		table: 'posts',
		destructive: false,
		details: 'Create table posts',
		meta: { table },
	};
}

function freshForeignKeyChanges(
	referencedColumns: readonly string[],
	options: {
		readonly primaryKey?: string | readonly string[];
		readonly index?: Record<string, unknown>;
	} = {},
): SchemaChange[] {
	return [
		{
			kind: 'create_table',
			table: 'parent_table',
			destructive: false,
			details: 'create parent',
			meta: {
				table: {
					name: 'parent_table',
					columns: [],
					foreignKeys: [],
					indexes: [],
					...(options.primaryKey === undefined
						? {}
						: { primaryKey: options.primaryKey }),
				},
			},
		},
		{
			kind: 'create_table',
			table: 'child_table',
			destructive: false,
			details: 'create child',
			meta: {
				table: {
					name: 'child_table',
					columns: [],
					foreignKeys: [],
					indexes: [],
				},
			},
		},
		{
			kind: 'add_foreign_key',
			table: 'child_table',
			destructive: false,
			details: 'child references parent',
			meta: {
				fk: {
					columns: ['parent_first', 'parent_second'],
					references: { table: 'parent_table', columns: referencedColumns },
				},
			},
		},
		...(options.index === undefined
			? []
			: [
					{
						kind: 'create_index' as const,
						table: 'parent_table',
						destructive: false,
						details: 'create parent index',
						meta: { index: options.index },
					},
				]),
	];
}

function compareIntrospectedSchema(): void {
	mocks.compare.mockImplementation(
		async (
			adapter: { introspect: (options?: unknown) => Promise<ModelIR> },
			model: ModelIR,
		) => compareSchemata(model, await adapter.introspect({ schema: 'public' })),
	);
}

const typeClassificationQuery =
	"SELECT t.typtype, t.typnamespace = 'pg_catalog'::pg_catalog.regnamespace AS is_pg_catalog FROM pg_catalog.pg_type t WHERE t.oid = pg_catalog.to_regtype($1)";

function client(type?: {
	readonly typtype: string;
	readonly is_pg_catalog: boolean;
}): PoolClient {
	return {
		query: vi.fn(async (sql: string) => {
			if (sql === 'SHOW server_version_num')
				return { rows: [{ server_version_num: '150000' }] };
			if (sql === 'SELECT current_database() AS database_id')
				return { rows: [{ database_id: 'app' }] };
			if (sql === typeClassificationQuery)
				return {
					rows: type === undefined ? [] : [type],
				};
			return { rows: [] };
		}),
		release: vi.fn(),
	} as unknown as PoolClient;
}

function poolFor(value = client()): Pool {
	return { connect: vi.fn(async () => value) } as unknown as Pool;
}

function change(
	kind: string,
	meta?: Record<string, unknown>,
): Record<string, unknown> {
	return {
		kind,
		table: 'users',
		column: 'email',
		destructive: kind.startsWith('drop') || kind.startsWith('alter'),
		details: kind,
		...(meta === undefined ? {} : { meta }),
	};
}

function stepFor(changeInput: Record<string, unknown>) {
	const kind = changeInput.kind;
	const child = kind === 'add_column';
	return {
		stepKey: 'converge:0',
		order: 0,
		segmentId: 'generator-segment-0',
		dependencyOrder: [],
		address: {
			scope: 'schema',
			engine: 'postgresql',
			database: 'app',
			schema: 'public',
			kind: child ? 'column' : 'table',
			name: child ? 'email' : 'users',
			...(child
				? {
						parent: {
							scope: 'schema',
							engine: 'postgresql',
							database: 'app',
							schema: 'public',
							kind: 'table',
							name: 'users',
						},
					}
				: {}),
		},
		claimKind: 'intent',
		plannedClaimKeys: ['converge:0:root'],
		statementBundle: { statements: [{ ordinal: 0, sql: 'SELECT 1' }] },
		classification: 'non-destructive',
		requiresVacancy: true,
		replayPolicy: 'recorded',
	};
}

async function expectRefusal(
	input: Record<string, unknown>,
	refusal: string,
	testClient = client(),
) {
	mocks.compare.mockResolvedValue({ changes: [input] });
	mocks.createStep.mockImplementation(
		({ change: value }: { change: Record<string, unknown> }) => stepFor(value),
	);
	await expect(
		convergePg(poolFor(testClient), emptyModel()),
	).rejects.toMatchObject({
		name: 'PgConvergeRefusalError',
		refusal,
	});
	expect(mocks.execute).not.toHaveBeenCalled();
}

async function expectAdmittedAddColumn(
	column: Record<string, unknown>,
	type?: { readonly typtype: string; readonly is_pg_catalog: boolean },
	testClient = client(type),
): Promise<PoolClient> {
	const parent = {
		scope: 'schema',
		engine: 'postgresql',
		database: 'app',
		schema: 'public',
		kind: 'table',
		name: 'users',
	} as const;
	const catalogueIdentity = {
		engine: 'postgresql',
		format: 1,
		value: { oid: '1' },
	};
	mocks.compare.mockResolvedValue({
		changes: [change('add_column', { column })],
	});
	mocks.createStep.mockImplementation(
		({ change: value }: { change: Record<string, unknown> }) => stepFor(value),
	);
	mocks.identity.mockImplementation(
		async (_client: unknown, address: { readonly kind?: string }) =>
			address.kind === 'table' ? { catalogueIdentity } : undefined,
	);
	mocks.chain.mockResolvedValue({
		ledger: { scope: 'schema', schema: 'public' },
		address: parent,
		events: [
			{
				eventId: 'adopt-intent',
				address: parent,
				eventKind: 'adopt-intent',
				controller: 'deployment',
			},
			{
				eventId: 'adopt',
				predecessor: 'adopt-intent',
				address: parent,
				eventKind: 'adopt',
				controller: 'deployment',
				observed: { value: { table: 'users' }, digest: 'observed' },
			},
		],
		terminalMember: { catalogueIdentity },
	} as never);

	await expect(convergePg(poolFor(testClient), emptyModel())).resolves.toEqual({
		kind: 'applied',
		applied: ['add_column'],
	});
	expect(mocks.execute).toHaveBeenCalled();
	return testClient;
}

afterEach(() => {
	cannedComparisonChanges = [];
	for (const mock of Object.values(mocks)) {
		if ('mockReset' in mock) mock.mockReset();
	}
	mocks.generate.mockReturnValue(['CREATE TABLE "users" ()']);
	mocks.execute.mockResolvedValue({ outcome: 'completed' });
	mocks.lock.mockResolvedValue({ kind: 'acquired' });
	mocks.unlock.mockResolvedValue(true);
	mocks.currency.mockResolvedValue({ kind: 'current' });
	mocks.preflight.mockResolvedValue({
		scopes: [
			{
				ledger: { scope: 'schema', schema: 'public' },
				outcome: 'current',
				marker: { kind: 'absent' },
			},
		],
		adoptionCandidates: [],
	});
	mocks.writability.mockResolvedValue({ kind: 'writable' });
	mocks.sequenceShape.mockResolvedValue(true);
	mocks.reservations.mockResolvedValue([]);
	mocks.runIds.mockResolvedValue(new Map());
	mocks.introspect.mockResolvedValue(emptyModel());
});

describe('convergePg refusal boundary', () => {
	it('selects its result overload from the converge mode', async () => {
		const applyOptions: ConvergePgOptions = { mode: 'apply' };
		const checkOptions: ConvergePgCheckOptions = { mode: 'check' };
		mocks.compare.mockResolvedValue({ changes: [] });
		const applyResult: Promise<PgConvergeResult> = convergePg(
			poolFor(),
			emptyModel(),
			applyOptions,
		);
		const checkResult: Promise<PgConvergeCheckResult> = convergePg(
			poolFor(),
			emptyModel(),
			checkOptions,
		);

		await expect(applyResult).resolves.toEqual({
			kind: 'no-drift',
			applied: [],
		});
		await expect(checkResult).resolves.toEqual({ kind: 'no-drift' });
	});

	it.each([
		{
			name: 'preview mode with a valid model',
			mode: 'preview',
			model: emptyModel(),
		},
		{
			name: 'a null-prototype mode',
			mode: Object.create(null),
			model: emptyModel(),
		},
		{
			name: 'a mode whose coercion throws',
			mode: {
				[Symbol.toPrimitive]() {
					throw new Error('coerced');
				},
			},
			model: emptyModel(),
		},
	])(
		'refuses $name before validating or connecting',
		async ({ mode, model }) => {
			const pool = poolFor();
			const error = await Promise.resolve(
				Reflect.apply(convergePg, undefined, [pool, model, { mode }]),
			).catch((caught: unknown) => caught);

			expect(error).toBeInstanceOf(PgConvergeRefusalError);
			expect(error).toMatchObject({
				refusal: 'invalid-options',
				message: 'converge mode must be apply or check',
			});
			expect(pool.connect).not.toHaveBeenCalled();
		},
	);

	it('refuses a preview mode before validating an invalid model', async () => {
		const invalidModel: ModelIR = {
			...emptyModel(),
			enums: new Map([
				['declared_status', { name: 'actual_status', values: ['pending'] }],
			]),
		};
		const pool = poolFor();
		const error = await Promise.resolve(
			Reflect.apply(convergePg, undefined, [
				pool,
				invalidModel,
				{ mode: 'preview' },
			]),
		).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(PgConvergeRefusalError);
		expect(error).toMatchObject({
			refusal: 'invalid-options',
			message: 'converge mode must be apply or check',
		});
		expect(pool.connect).not.toHaveBeenCalled();
	});

	it('refuses application steps targeting schema $user before connecting', async () => {
		const pool = poolFor();
		await expect(
			convergePg(pool, emptyModel(), {
				schema: '$user',
				steps: [
					{
						kind: 'once',
						id: 'step',
						digest: 'v1',
						phase: 'after-generated-ddl',
						apply: async () => undefined,
					},
				],
			}),
		).rejects.toMatchObject({
			refusal: 'invalid-options',
			detail: 'converge application steps do not support schema $user',
		});
		expect(pool.connect).not.toHaveBeenCalled();
	});

	it('keeps the shape of refusals constructed without error options', () => {
		const error = new PgConvergeRefusalError('invalid-options', []);
		expect(Object.hasOwn(error, 'cause')).toBe(false);
	});

	it('keeps an owned-CHECK rendering error as an application-step refusal cause', async () => {
		const renderingError = new Error('scratch table unavailable');
		const withScratchScope = mocks.adapter.withScratchScope;
		mocks.adapter.withScratchScope = async (callback) => {
			type ScratchScope = {
				readonly executeRaw: (sql: string) => Promise<unknown[]>;
				readonly transaction: (
					inner: (value: ScratchScope) => Promise<unknown>,
				) => Promise<unknown>;
			};
			const scope: ScratchScope = {
				executeRaw: async (sql: string) => {
					if (sql.includes("current_setting('search_path')"))
						return [{ search_path: 'public' }];
					if (sql.includes('SELECT pg_catalog.to_regclass'))
						return [{ exists: true }];
					if (sql.includes('FROM pg_catalog.pg_constraint c'))
						return [
							{
								name: 'positive',
								expression: 'CHECK ((score > 0))',
								validated: true,
							},
						];
					if (sql.startsWith('CREATE TEMP TABLE ')) throw renderingError;
					return [];
				},
				transaction: async (inner) => inner(scope),
			};
			return callback(scope);
		};
		mocks.compare.mockResolvedValue({ changes: [] });
		mockManagedObjectsWithUnmanagedApplicationSteps();
		try {
			const error = await convergePg(
				poolFor(),
				modelWithTables([
					{
						name: 'projects',
						columns: [{ name: 'score', type: 'integer', nullable: false }],
						foreignKeys: [],
						indexes: [],
						checkConstraints: [{ name: 'positive', expression: 'score > 0' }],
					},
				]),
				{
					steps: [
						{
							kind: 'assert',
							id: 'owned-check-rendering',
							digest: 'v1',
							phase: 'after-generated-ddl',
							owns: { checks: [{ table: 'projects', name: 'positive' }] },
							inspect: async () => 'healthy' as const,
							apply: async () => undefined,
						},
					],
				},
			).catch((caught: unknown) => caught);
			expect(error).toMatchObject({ refusal: 'application-step-failed' });
			expect((error as Error).cause).toBe(renderingError);
		} finally {
			mocks.adapter.withScratchScope = withScratchScope;
		}
	});

	it('allows schema $user without application steps', async () => {
		mocks.compare.mockResolvedValue({ changes: [] });
		await expect(
			convergePg(poolFor(), emptyModel(), {
				mode: 'check',
				schema: '$user',
			}),
		).resolves.toEqual({ kind: 'no-drift' });
	});

	it('keeps an unexpected step getter error out of invalid-options detail', async () => {
		const pool = poolFor();
		const step = {
			get kind(): never {
				throw new Error('X');
			},
		};
		await expect(
			Reflect.apply(convergePg, undefined, [
				pool,
				emptyModel(),
				{ steps: [step] },
			]),
		).rejects.toMatchObject({
			refusal: 'invalid-options',
			detail: 'converge steps are invalid',
		});
		expect(pool.connect).not.toHaveBeenCalled();
	});

	it.each([
		{
			kind: 'once',
			id: '',
			digest: 'v1',
			phase: 'after-generated-ddl',
			apply: async () => undefined,
		},
		{
			kind: 'once',
			id: 'one',
			digest: 'v1',
			scope: 'database',
			phase: 'after-generated-ddl',
			apply: async () => undefined,
		},
		{
			kind: 'once',
			id: 'one',
			digest: 'v1',
			phase: 'after-generated-ddl',
			lockTimeoutMs: 0,
			apply: async () => undefined,
		},
	])('refuses invalid application steps before connecting', async (step) => {
		const pool = poolFor();
		await expect(
			Reflect.apply(convergePg, undefined, [
				pool,
				emptyModel(),
				{ steps: [step] },
			]),
		).rejects.toMatchObject({ refusal: 'invalid-options' });
		expect(pool.connect).not.toHaveBeenCalled();
	});

	it.each([
		[
			'an unknown owns key',
			modelWithTable('projects'),
			{
				kind: 'assert',
				id: 'unknown-key',
				digest: 'v1',
				phase: 'after-generated-ddl',
				owns: { tables: [] },
				inspect: async () => 'healthy',
				apply: async () => undefined,
			},
			'owns has an unknown key',
		],
		[
			'an empty owns object',
			modelWithTable('projects'),
			{
				kind: 'assert',
				id: 'empty-owns',
				digest: 'v1',
				phase: 'after-generated-ddl',
				owns: { checks: [] },
				inspect: async () => 'healthy',
				apply: async () => undefined,
			},
			'owns must name at least one surface',
		],
		[
			'an owns entry with an extra field',
			modelWithTable('projects'),
			{
				kind: 'assert',
				id: 'extra-field',
				digest: 'v1',
				phase: 'after-generated-ddl',
				owns: { checks: [{ table: 'projects', name: 'state', extra: true }] },
				inspect: async () => 'healthy',
				apply: async () => undefined,
			},
			'owns.checks entries',
		],
		[
			'an undeclared owned table',
			modelWithTable('projects'),
			{
				kind: 'assert',
				id: 'missing-table',
				digest: 'v1',
				phase: 'after-generated-ddl',
				owns: { checks: [{ table: 'missing', name: 'state' }] },
				inspect: async () => 'healthy',
				apply: async () => undefined,
			},
			'undeclared table missing',
		],
		[
			'an undeclared owned CHECK',
			modelWithTable('projects'),
			{
				kind: 'assert',
				id: 'missing-check',
				digest: 'v1',
				phase: 'after-generated-ddl',
				owns: { checks: [{ table: 'projects', name: 'state' }] },
				inspect: async () => 'healthy',
				apply: async () => undefined,
			},
			'undeclared CHECK projects.state',
		],
		[
			'an undeclared owned column',
			modelWithTable('projects'),
			{
				kind: 'assert',
				id: 'missing-column',
				digest: 'v1',
				phase: 'after-generated-ddl',
				owns: { columnTypes: [{ table: 'projects', column: 'state' }] },
				inspect: async () => 'healthy',
				apply: async () => undefined,
			},
			'owns undeclared column projects.state',
		],
		[
			'an index name other than its declared physical name',
			modelWithTables([
				{
					name: 'projects',
					columns: [{ name: 'revision', type: 'integer', nullable: false }],
					foreignKeys: [],
					indexes: [{ name: 'idx_projects_revision', columns: ['revision'] }],
				},
			]),
			{
				kind: 'assert',
				id: 'logical-index-name',
				digest: 'v1',
				phase: 'after-generated-ddl',
				owns: {
					indexes: [{ table: 'projects', name: 'project_revision_index' }],
				},
				inspect: async () => 'healthy',
				apply: async () => undefined,
			},
			'owns undeclared index projects.project_revision_index',
		],
		[
			'an owned CHECK before generated DDL',
			modelWithTables([
				{
					name: 'projects',
					columns: [],
					foreignKeys: [],
					indexes: [],
					checkConstraints: [{ name: 'state_check', expression: 'true' }],
				},
			]),
			{
				kind: 'assert',
				id: 'wrong-phase',
				digest: 'v1',
				phase: 'before-generated-ddl',
				owns: { checks: [{ table: 'projects', name: 'state_check' }] },
				inspect: async () => 'healthy',
				apply: async () => undefined,
			},
			'owns CHECKs or indexes but is not after-generated-ddl',
		],
		[
			'an owned unique index required by a declared foreign key',
			modelWithTables([
				{
					name: 'projects',
					columns: [{ name: 'code', type: 'integer', nullable: false }],
					foreignKeys: [],
					indexes: [
						{ name: 'idx_projects_code', columns: ['code'], unique: true },
					],
				},
				{
					name: 'tasks',
					columns: [{ name: 'project_code', type: 'integer', nullable: false }],
					foreignKeys: [
						{
							columns: ['project_code'],
							references: { table: 'projects', columns: ['code'] },
						},
					],
					indexes: [],
				},
			]),
			{
				kind: 'assert',
				id: 'owned-fk-key',
				digest: 'v1',
				phase: 'after-generated-ddl',
				owns: { indexes: [{ table: 'projects', name: 'idx_projects_code' }] },
				inspect: async () => 'healthy',
				apply: async () => undefined,
			},
			'owns unique index projects.idx_projects_code required by a declared foreign key',
		],
		[
			'owns on a once step',
			modelWithTable('projects'),
			{
				kind: 'once',
				id: 'once-owned',
				digest: 'v1',
				phase: 'after-generated-ddl',
				owns: { checks: [{ table: 'projects', name: 'state' }] },
				apply: async () => undefined,
			},
			'once steps cannot declare owns',
		],
	] as const)(
		'refuses %s before connecting',
		async (_case, model, step, detail) => {
			const pool = poolFor();
			await expect(
				Reflect.apply(convergePg, undefined, [pool, model, { steps: [step] }]),
			).rejects.toMatchObject({
				refusal: 'invalid-options',
				detail: expect.stringContaining(detail),
			});
			expect(pool.connect).not.toHaveBeenCalled();
		},
	);

	it.each([
		['an owns symbol key', () => ({ checks: [], [Symbol('extra')]: [] })],
		[
			'an owns non-enumerable key',
			() => {
				const owns = { checks: [] };
				Object.defineProperty(owns, 'extra', { value: [], enumerable: false });
				return owns;
			},
		],
		[
			'an entry symbol key',
			() => ({
				checks: [{ table: 'projects', name: 'state', [Symbol('extra')]: true }],
			}),
		],
	] as const)(
		'refuses %s as invalid-options before connecting',
		async (_case, makeOwns) => {
			const pool = poolFor();
			await expect(
				Reflect.apply(convergePg, undefined, [
					pool,
					modelWithTable('projects'),
					{
						steps: [
							{
								kind: 'assert',
								id: 'invalid-owned-keys',
								digest: 'v1',
								phase: 'after-generated-ddl',
								owns: makeOwns(),
								inspect: async () => 'healthy',
								apply: async () => undefined,
							},
						],
					},
				]),
			).rejects.toMatchObject({ refusal: 'invalid-options' });
			expect(pool.connect).not.toHaveBeenCalled();
		},
	);

	it('refuses a CHECK owner before another column-type owner for its table before connecting', async () => {
		const pool = poolFor();
		const model = modelWithTables([
			{
				name: 'projects',
				columns: [{ name: 'state', type: 'integer', nullable: false }],
				foreignKeys: [],
				indexes: [],
				checkConstraints: [{ name: 'project_state', expression: 'state > 0' }],
			},
		]);
		await expect(
			convergePg(pool, model, {
				steps: [
					{
						kind: 'assert',
						id: 'check-first',
						digest: 'v1',
						phase: 'after-generated-ddl',
						owns: { checks: [{ table: 'projects', name: 'project_state' }] },
						inspect: async () => 'healthy' as const,
						apply: async () => undefined,
					},
					{
						kind: 'assert',
						id: 'type-second',
						digest: 'v1',
						phase: 'after-generated-ddl',
						owns: { columnTypes: [{ table: 'projects', column: 'state' }] },
						inspect: async () => 'healthy' as const,
						apply: async () => undefined,
					},
				],
			}),
		).rejects.toMatchObject({ refusal: 'invalid-options' });
		expect(pool.connect).not.toHaveBeenCalled();
	});

	it('orders CHECK and column-type ownership by execution phase before connecting', async () => {
		const pool = poolFor();
		const model = modelWithTables([
			{
				name: 'projects',
				columns: [{ name: 'state', type: 'integer', nullable: false }],
				foreignKeys: [],
				indexes: [],
				checkConstraints: [{ name: 'project_state', expression: 'state > 0' }],
			},
		]);
		await expect(
			convergePg(pool, model, {
				schema: '$user',
				steps: [
					{
						kind: 'assert',
						id: 'check-first-in-array',
						digest: 'v1',
						phase: 'after-generated-ddl',
						owns: {
							checks: [{ table: 'projects', name: 'project_state' }],
						},
						inspect: async () => 'healthy' as const,
						apply: async () => undefined,
					},
					{
						kind: 'assert',
						id: 'type-second-in-array',
						digest: 'v1',
						phase: 'before-generated-ddl',
						owns: { columnTypes: [{ table: 'projects', column: 'state' }] },
						inspect: async () => 'healthy' as const,
						apply: async () => undefined,
					},
				],
			}),
		).rejects.toMatchObject({
			refusal: 'invalid-options',
			message: 'converge application steps do not support schema $user',
		});
		expect(pool.connect).not.toHaveBeenCalled();
	});

	it('allows one assertion to own a table column type and CHECK before connecting', async () => {
		const pool = poolFor();
		const model = modelWithTables([
			{
				name: 'projects',
				columns: [{ name: 'state', type: 'integer', nullable: false }],
				foreignKeys: [],
				indexes: [],
				checkConstraints: [{ name: 'project_state', expression: 'state > 0' }],
			},
		]);
		await expect(
			convergePg(pool, model, {
				schema: '$user',
				steps: [
					{
						kind: 'assert',
						id: 'type-and-check',
						digest: 'v1',
						phase: 'after-generated-ddl',
						owns: {
							checks: [{ table: 'projects', name: 'project_state' }],
							columnTypes: [{ table: 'projects', column: 'state' }],
						},
						inspect: async () => 'healthy' as const,
						apply: async () => undefined,
					},
				],
			}),
		).rejects.toMatchObject({
			refusal: 'invalid-options',
			message: 'converge application steps do not support schema $user',
		});
		expect(pool.connect).not.toHaveBeenCalled();
	});

	it('allows an owned local unique index for a foreign key targeting another schema', async () => {
		mocks.compare.mockResolvedValue({ changes: [] });
		const pool = poolFor();
		const declared = modelWithTables([
			{
				name: 'accounts',
				columns: [{ name: 'code', type: 'integer', nullable: false }],
				foreignKeys: [],
				indexes: [
					{ name: 'idx_accounts_code', columns: ['code'], unique: true },
				],
			},
			{
				name: 'entries',
				columns: [{ name: 'account_code', type: 'integer', nullable: false }],
				foreignKeys: [
					{
						columns: ['account_code'],
						references: {
							schema: 'archive',
							table: 'accounts',
							columns: ['code'],
						},
					},
				],
				indexes: [],
			},
		]);
		mocks.introspect.mockResolvedValue(declared);
		mockManagedObjectsWithUnmanagedApplicationSteps();
		await expect(
			convergePg(pool, declared, {
				steps: [
					{
						kind: 'assert',
						id: 'owned-archive-key',
						digest: 'v1',
						phase: 'after-generated-ddl',
						owns: {
							indexes: [{ table: 'accounts', name: 'idx_accounts_code' }],
						},
						inspect: async () => 'healthy' as const,
						apply: async () => undefined,
					},
				],
			}),
		).resolves.toEqual({ kind: 'no-drift', applied: [] });
		expect(pool.connect).toHaveBeenCalledTimes(1);
	});

	it.each([undefined, 'public'] as const)(
		'refuses an owned local unique index when the foreign key targets %s or the target schema is absent',
		async (referenceSchema) => {
			const pool = poolFor();
			await expect(
				convergePg(
					pool,
					modelWithTables([
						{
							name: 'accounts',
							columns: [{ name: 'code', type: 'integer', nullable: false }],
							foreignKeys: [],
							indexes: [
								{ name: 'idx_accounts_code', columns: ['code'], unique: true },
							],
						},
						{
							name: 'entries',
							columns: [
								{ name: 'account_code', type: 'integer', nullable: false },
							],
							foreignKeys: [
								{
									columns: ['account_code'],
									references: {
										...(referenceSchema === undefined
											? {}
											: { schema: referenceSchema }),
										table: 'accounts',
										columns: ['code'],
									},
								},
							],
							indexes: [],
						},
					]),
					{
						steps: [
							{
								kind: 'assert',
								id: 'owned-local-fk-key',
								digest: 'v1',
								phase: 'after-generated-ddl',
								owns: {
									indexes: [{ table: 'accounts', name: 'idx_accounts_code' }],
								},
								inspect: async () => 'healthy' as const,
								apply: async () => undefined,
							},
						],
					},
				),
			).rejects.toMatchObject({
				refusal: 'invalid-options',
				detail: expect.stringContaining('idx_accounts_code'),
			});
			expect(pool.connect).not.toHaveBeenCalled();
		},
	);

	it('uses code-unit order for canonical owned checks and column types', async () => {
		mocks.compare.mockResolvedValue({ changes: [] });
		const declared = modelWithTables([
			{
				name: 'B',
				columns: [{ name: 'value', type: 'integer', nullable: false }],
				foreignKeys: [],
				indexes: [],
				checkConstraints: [{ name: 'valid', expression: 'true' }],
			},
			{
				name: 'a',
				columns: [{ name: 'value', type: 'integer', nullable: false }],
				foreignKeys: [],
				indexes: [],
				checkConstraints: [{ name: 'valid', expression: 'true' }],
			},
		]);
		mocks.introspect.mockResolvedValue(declared);
		mockManagedObjectsWithUnmanagedApplicationSteps();
		const result = await convergePg(poolFor(), declared, {
			mode: 'check',
			steps: [
				{
					kind: 'assert',
					id: 'canonical-owned-surfaces',
					digest: 'v1',
					phase: 'after-generated-ddl',
					owns: {
						checks: [
							{ table: 'a', name: 'valid' },
							{ table: 'B', name: 'valid' },
						],
						columnTypes: [
							{ table: 'a', column: 'value' },
							{ table: 'B', column: 'value' },
						],
					},
					inspect: async () => 'unhealthy' as const,
					apply: async () => undefined,
				},
			],
		});
		expect(result).toMatchObject({ kind: 'would-apply' });
		if (result.kind !== 'would-apply') return;
		expect(result.planDigest).toBe(
			canonicalJsonDigest({
				kind: 'postgresql-additive-converge-v1',
				database: 'app',
				schema: 'public',
				steps: [],
				applicationSteps: [
					{
						kind: 'assert',
						id: 'canonical-owned-surfaces',
						digest: 'v1',
						scope: 'schema',
						phase: 'after-generated-ddl',
						owns: {
							checks: [
								{ table: 'B', name: 'valid' },
								{ table: 'a', name: 'valid' },
							],
							columnTypes: [
								{ table: 'B', column: 'value' },
								{ table: 'a', column: 'value' },
							],
						},
					},
				],
			}),
		);
	});

	it('uses the first read of an owned index name for ownership masking', async () => {
		mocks.compare.mockResolvedValue({ changes: [] });
		const declared = modelWithTables([
			{
				name: 'projects',
				columns: [
					{ name: 'code', type: 'integer', nullable: false },
					{ name: 'revision', type: 'integer', nullable: false },
				],
				foreignKeys: [],
				indexes: [
					{ name: 'idx_projects_code', columns: ['code'], unique: true },
					{ name: 'idx_projects_surface', columns: ['revision'] },
				],
			},
			{
				name: 'entries',
				columns: [{ name: 'project_code', type: 'integer', nullable: false }],
				foreignKeys: [
					{
						columns: ['project_code'],
						references: { table: 'projects', columns: ['code'] },
					},
				],
				indexes: [],
			},
		]);
		mocks.introspect.mockResolvedValue(declared);
		mockManagedObjectsWithUnmanagedApplicationSteps();
		let nameReads = 0;
		const result = await Reflect.apply(convergePg, undefined, [
			poolFor(),
			declared,
			{
				mode: 'check',
				steps: [
					{
						kind: 'assert',
						id: 'snapshot-owned-index',
						digest: 'v1',
						phase: 'after-generated-ddl',
						owns: {
							indexes: [
								{
									table: 'projects',
									get name() {
										nameReads += 1;
										return nameReads === 1
											? 'idx_projects_surface'
											: 'idx_projects_code';
									},
								},
							],
						},
						inspect: async () => 'unhealthy',
						apply: async () => undefined,
					},
				],
			},
		]);
		expect(result).toMatchObject({ kind: 'would-apply' });
		expect(nameReads).toBe(1);
		expect(mocks.declaredComparison.mock.calls[0]?.[0]).toMatchObject({
			ownershipMask: {
				indexes: new Set([
					JSON.stringify(['projects', 'idx_projects_surface']),
				]),
			},
		});
	});

	it('does not run an application step apply callback in check mode', async () => {
		mocks.compare.mockResolvedValue({ changes: [] });
		const apply = vi.fn(async () => undefined);

		await expect(
			convergePg(poolFor(), emptyModel(), {
				mode: 'check',
				steps: [
					{
						kind: 'assert',
						id: 'state-check',
						digest: 'v1',
						phase: 'after-generated-ddl',
						inspect: async () => 'unhealthy' as const,
						apply,
					},
				],
			}),
		).resolves.toMatchObject({
			kind: 'would-apply',
			steps: [
				{
					kind: 'application-step',
					id: 'state-check',
					step: 'assert',
					inspected: true,
				},
			],
		});
		expect(apply).not.toHaveBeenCalled();
	});

	it('destroys a client after an application-step callback and releases one with no steps', async () => {
		mocks.compare.mockResolvedValue({ changes: [] });
		const callbackClient = client();
		await expect(
			convergePg(poolFor(callbackClient), emptyModel(), {
				mode: 'check',
				steps: [
					{
						kind: 'assert',
						id: 'session-state-check',
						digest: 'v1',
						phase: 'after-generated-ddl',
						inspect: async () => 'healthy' as const,
						apply: async () => undefined,
					},
				],
			}),
		).resolves.toMatchObject({ kind: 'no-drift' });
		expect(callbackClient.release).toHaveBeenCalledWith(
			expect.objectContaining({
				message:
					'converge application step callback may have changed session state',
			}),
		);

		const untouchedClient = client();
		await expect(
			convergePg(poolFor(untouchedClient), emptyModel()),
		).resolves.toMatchObject({ kind: 'no-drift' });
		expect(untouchedClient.release).toHaveBeenCalledWith(undefined);
	});

	it.each(['once', Object.create(null)])(
		'refuses an invalid initialize value before validating or connecting',
		async (initialize) => {
			const pool = poolFor();
			const error = await Promise.resolve(
				Reflect.apply(convergePg, undefined, [
					pool,
					emptyModel(),
					{ initialize },
				]),
			).catch((caught: unknown) => caught);

			expect(error).toMatchObject({
				refusal: 'invalid-options',
				message:
					'converge initialize must be never, pristine, or adopt-existing',
			});
			expect(pool.connect).not.toHaveBeenCalled();
		},
	);

	it('keeps generic preflight failures as reinitialize-preflight-failed', async () => {
		mocks.currency.mockResolvedValue({ kind: 'absent' });
		mocks.preflight.mockResolvedValue({
			scopes: [
				{
					ledger: { scope: 'database' },
					outcome: 'failed',
					marker: { kind: 'absent' },
					refusal: { code: 'reinitialize-preflight-failed', detail: 'denied' },
					reason: { step: 'create', message: 'denied' },
				},
				{
					ledger: { scope: 'schema', schema: 'public' },
					outcome: 'not-attempted',
					marker: { kind: 'absent' },
				},
			],
			adoptionCandidates: [],
		} as never);

		await expect(
			convergePg(poolFor(), emptyModel(), { initialize: 'pristine' }),
		).rejects.toMatchObject({
			refusal: 'initialization-refused',
			initialization: {
				home: { scope: 'database' },
				code: 'reinitialize-preflight-failed',
				step: 'create',
				detail: 'denied',
			},
		});
	});

	it('maps a pristine live-relation preflight refusal into initialization metadata', async () => {
		mocks.currency.mockResolvedValue({ kind: 'absent' });
		mocks.preflight.mockResolvedValue({
			scopes: [
				{
					ledger: { scope: 'database' },
					outcome: 'unchanged',
					marker: { kind: 'current' },
				},
				{
					ledger: { scope: 'schema', schema: 'public' },
					outcome: 'failed',
					marker: { kind: 'absent' },
					refusal: {
						code: 'pristine-live-relations',
						detail:
							'converge pristine initialization refuses declared live relation legacy_items',
					},
					reason: {
						step: 'create',
						message:
							'converge pristine initialization refuses declared live relation legacy_items',
					},
				},
			],
			adoptionCandidates: [],
		} as never);

		await expect(
			convergePg(poolFor(), emptyModel(), { initialize: 'pristine' }),
		).rejects.toMatchObject({
			refusal: 'initialization-refused',
			initialization: {
				home: { scope: 'schema', schema: 'public' },
				code: 'pristine-live-relations',
				step: 'create',
				detail:
					'converge pristine initialization refuses declared live relation legacy_items',
			},
		});
	});

	it('maps a preflight advisory lock refusal to busy', async () => {
		mocks.currency.mockResolvedValue({ kind: 'absent' });
		mocks.preflight.mockResolvedValue({
			scopes: [
				{
					ledger: { scope: 'schema', schema: 'public' },
					outcome: 'failed',
					marker: { kind: 'absent' },
					refusal: {
						code: 'reinitialize-preflight-advisory-lock',
						detail: 'locked',
					},
					reason: { step: 'advisory-lock', message: 'locked' },
				},
			],
			adoptionCandidates: [],
		} as never);

		await expect(
			convergePg(poolFor(), emptyModel(), { initialize: 'pristine' }),
		).rejects.toMatchObject({ refusal: 'busy', detail: 'locked' });
	});

	it('rethows a rejected initialization preflight unchanged', async () => {
		const rejected = new Error('preflight transport failure');
		mocks.currency.mockResolvedValue({ kind: 'absent' });
		mocks.preflight.mockRejectedValue(rejected);

		await expect(
			convergePg(poolFor(), emptyModel(), { initialize: 'pristine' }),
		).rejects.toBe(rejected);
	});

	it('does not preflight in check mode or for non-absent currency', async () => {
		mocks.currency.mockResolvedValue({ kind: 'absent' });
		mocks.compare.mockResolvedValue({ changes: [] });
		await expect(
			convergePg(poolFor(), emptyModel(), {
				mode: 'check',
				initialize: 'pristine',
			}),
		).rejects.toMatchObject({ refusal: 'ledger-absent' });
		expect(mocks.preflight).not.toHaveBeenCalled();

		mocks.currency.mockResolvedValue({
			kind: 'not-current',
			reason: 'marker',
		} as never);
		await expect(
			convergePg(poolFor(), emptyModel(), { initialize: 'pristine' }),
		).rejects.toMatchObject({ refusal: 'incompatible-ledger' });
		expect(mocks.preflight).not.toHaveBeenCalled();

		mocks.currency.mockResolvedValue({ kind: 'absent' });
		await expect(
			convergePg(poolFor(), emptyModel(), { initialize: 'never' }),
		).rejects.toMatchObject({ refusal: 'ledger-absent' });
		expect(mocks.preflight).not.toHaveBeenCalled();
	});

	it('checks a validated manifest without executing and returns its projection', async () => {
		const catalogueIdentity = {
			engine: 'postgresql',
			format: 1,
			value: { oid: '1' },
		};
		const adopted = {
			name: 'legacy_items',
			adopt: true as const,
			columns: [],
			foreignKeys: [],
			indexes: [],
		};
		const created = {
			name: 'new_items',
			columns: [],
			foreignKeys: [],
			indexes: [{ name: 'new_items_index', columns: ['id'] }],
		};
		const createTable: SchemaChange = {
			kind: 'create_table',
			table: created.name,
			destructive: false,
			details: 'create new_items',
			meta: { table: created },
		};
		const createIndex: SchemaChange = {
			kind: 'create_index',
			table: created.name,
			destructive: false,
			details: 'create new_items_index',
			meta: { index: created.indexes[0] },
		};
		mocks.compare.mockResolvedValue({ changes: [createTable, createIndex] });
		mocks.createStep.mockImplementation(createPgsqlGeneratedManagedStep);
		mocks.identity.mockImplementation(
			async (_client: unknown, address: { readonly name?: string }) =>
				address.name === adopted.name ? { catalogueIdentity } : undefined,
		);
		mocks.chain.mockResolvedValue({ events: [] });

		const checkedClient = client();
		const checked = await convergePg(
			poolFor(checkedClient),
			modelWithTables([adopted, created]),
			{ mode: 'check' },
		);

		expect(mocks.execute).not.toHaveBeenCalled();
		expect(checkedClient.release).toHaveBeenCalled();
		expect(checked).toMatchObject({
			kind: 'would-apply',
			steps: [
				{ kind: 'adopt_table' },
				{
					kind: 'create_table',
					table: 'new_items',
					details: 'create new_items',
				},
				{
					kind: 'create_index',
					table: 'new_items',
					details: 'create new_items_index',
				},
			],
		});

		let applyInput: Parameters<typeof executeGeneratorPlan>[0] | undefined;
		mocks.execute.mockImplementation(async (input) => {
			applyInput = input;
			return { outcome: 'completed' };
		});
		await expect(
			convergePg(poolFor(), modelWithTables([adopted, created])),
		).resolves.toEqual({
			kind: 'applied',
			applied: ['adopt_table', 'create_table', 'create_index'],
		});
		expect(applyInput).toBeDefined();
		if (checked.kind !== 'would-apply' || !applyInput?.manifest) return;
		expect(checked.planDigest).toBe(
			canonicalJsonDigest({
				kind: 'postgresql-additive-converge-v1',
				database: 'app',
				schema: 'public',
				steps: applyInput.manifest.steps,
				applicationSteps: [],
			}),
		);
		expect(checked.steps.map(({ kind }) => kind)).toEqual([
			'adopt_table',
			'create_table',
			'create_index',
		]);
		expect(
			checked.steps.map(({ stepKey, order, dependencyOrder, address }) => ({
				stepKey,
				order,
				dependencyOrder,
				address,
			})),
		).toEqual(
			applyInput.manifest.steps.map(
				({ stepKey, order, dependencyOrder, address }) => ({
					stepKey,
					order,
					dependencyOrder,
					address,
				}),
			),
		);
	});

	it('refuses a declared adoption mismatch before invoking the executor', async () => {
		mocks.identity.mockResolvedValue({
			catalogueIdentity: {
				engine: 'postgresql',
				format: 1,
				value: { oid: '1' },
			},
		});
		mocks.chain.mockResolvedValue({ events: [] });
		mocks.compare.mockResolvedValue({
			changes: [
				{
					kind: 'add_column',
					table: 'legacy_items',
					column: 'missing',
					destructive: false,
					details: 'Add column missing',
					meta: { column: { name: 'missing', type: 'integer' } },
				},
			],
		});
		const desired = modelWithTables([
			{
				name: 'legacy_items',
				adopt: true,
				columns: [],
				foreignKeys: [],
				indexes: [],
			},
		]);
		await expect(convergePg(poolFor(), desired)).rejects.toMatchObject({
			refusal: 'adoption-refused',
			changes: [expect.objectContaining({ kind: 'add_column' })],
		});
		expect(mocks.execute).not.toHaveBeenCalled();
	});

	it('does not treat a view as an existing declared table for standing adoption', async () => {
		const testClient = client();
		(testClient.query as ReturnType<typeof vi.fn>).mockImplementation(
			async (sql: string) => {
				if (sql === 'SHOW server_version_num')
					return { rows: [{ server_version_num: '150000' }] };
				if (sql === 'SELECT current_database() AS database_id')
					return { rows: [{ database_id: 'app' }] };
				if (sql.includes('FROM pg_catalog.pg_class relation'))
					return { rows: [{ name: 'legacy_view', kind: 'v' }] };
				return { rows: [] };
			},
		);
		mocks.compare.mockResolvedValue({ changes: [] });

		const desired = modelWithTables([
			{
				name: 'legacy_view',
				columns: [],
				foreignKeys: [],
				indexes: [],
			},
		]);
		await expect(
			convergePg(poolFor(testClient), desired, { initialize: 'never' }),
		).rejects.toMatchObject({ refusal: 'concurrent-drift' });
		await expect(
			convergePg(poolFor(testClient), desired, {
				initialize: 'adopt-existing',
			}),
		).rejects.toMatchObject({ refusal: 'concurrent-drift' });
		expect(mocks.execute).not.toHaveBeenCalled();
	});

	it('converges a managed declared table change instead of re-adopting it', async () => {
		const table = {
			name: 'managed_items',
			adopt: true as const,
			columns: [],
			foreignKeys: [],
			indexes: [],
		};
		mockManagedObjects();
		mocks.compare.mockResolvedValue({
			changes: [
				{
					kind: 'add_column',
					table: table.name,
					column: 'nickname',
					destructive: false,
					details: 'Add column nickname',
					meta: {
						column: {
							name: 'nickname',
							type: 'string',
							nullable: true,
						},
					},
				},
			],
		});
		mocks.createStep.mockImplementation(
			({ change: input }: { change: Record<string, unknown> }) =>
				stepFor(input),
		);

		await expect(
			convergePg(poolFor(), modelWithTables([table])),
		).resolves.toEqual({ kind: 'applied', applied: ['add_column'] });
		expect(mocks.execute).toHaveBeenCalledTimes(1);
	});

	it('skips declared sequence adoption checks after matching managed admission', async () => {
		const sequence = { name: 'managed_sequence', adopt: true as const };
		mockManagedObjects();
		mocks.sequenceShape.mockResolvedValue(false);
		mocks.compare.mockResolvedValue({ changes: [] });

		await expect(
			convergePg(poolFor(), {
				...emptyModel(),
				sequences: new Map([[sequence.name, sequence]]),
			}),
		).resolves.toEqual({ kind: 'no-drift', applied: [] });
		expect(mocks.sequenceShape).not.toHaveBeenCalled();
		expect(mocks.execute).not.toHaveBeenCalled();

		mocks.compare.mockResolvedValue({
			changes: [
				{
					kind: 'alter_sequence',
					table: '',
					destructive: true,
					details: 'alter managed sequence',
					meta: { sequence },
				},
			],
		});
		await expect(
			convergePg(poolFor(), {
				...emptyModel(),
				sequences: new Map([[sequence.name, sequence]]),
			}),
		).rejects.toMatchObject({ refusal: 'unsupported-change' });
		expect(mocks.sequenceShape).not.toHaveBeenCalled();
		expect(mocks.execute).not.toHaveBeenCalled();
	});

	it('refuses declared sequence adoption with a schema other than the converge target', async () => {
		const sequence = {
			name: 'legacy_sequence',
			adopt: true as const,
			schema: 'decoy',
		};
		mocks.compare.mockResolvedValue({ changes: [] });

		await expect(
			convergePg(
				poolFor(),
				{
					...emptyModel(),
					sequences: new Map([[sequence.name, sequence]]),
				},
				{ schema: 'tenant' },
			),
		).rejects.toMatchObject({
			refusal: 'adoption-refused',
			detail: expect.stringMatching(/decoy.*tenant/),
		});
		expect(mocks.identity).not.toHaveBeenCalled();
		expect(mocks.sequenceShape).not.toHaveBeenCalled();
		expect(mocks.execute).not.toHaveBeenCalled();
	});

	it.each([
		['without a declared schema', undefined],
		['with the converge target schema', 'tenant'],
	] as const)('adopts a sequence %s', async (_description, declaredSchema) => {
		const sequence = {
			name: 'legacy_sequence',
			adopt: true as const,
			...(declaredSchema === undefined ? {} : { schema: declaredSchema }),
		};
		const catalogueIdentity = {
			engine: 'postgresql',
			format: 1,
			value: { oid: '1' },
		};
		mocks.compare.mockResolvedValue({ changes: [] });
		mocks.identity.mockResolvedValue({ catalogueIdentity });
		mocks.chain.mockResolvedValue({ events: [] });
		mocks.execute.mockImplementation(async (input) => {
			const step = input.manifest?.steps[0];
			if (!step || !input.verifyDeclaredAdoptionShape)
				throw new Error(
					'expected a declared sequence adoption step and verifier',
				);
			expect(step.lifecycle).toEqual({
				kind: 'sequence-adoption',
				shape: {
					name: sequence.name,
					...(declaredSchema === undefined ? {} : { schema: declaredSchema }),
				},
			});
			await input.verifyDeclaredAdoptionShape(input.pool, step);
			return { outcome: 'completed' };
		});

		await expect(
			convergePg(
				poolFor(),
				{
					...emptyModel(),
					sequences: new Map([[sequence.name, sequence]]),
				},
				{ schema: 'tenant' },
			),
		).resolves.toEqual({ kind: 'applied', applied: ['adopt_sequence'] });
		expect(mocks.sequenceShape).toHaveBeenCalledWith(
			expect.anything(),
			'tenant',
			sequence.name,
			sequence,
		);
	});

	it('refuses declared replace before comparison or execution', async () => {
		const testClient = client();
		mocks.compare.mockResolvedValue({ changes: [] });
		const desired = modelWithTables([
			{
				name: 'legacy_replace',
				adopt: true,
				replace: true,
				columns: [],
				foreignKeys: [],
				indexes: [],
			},
		]);

		await expect(
			convergePg(poolFor(testClient), desired),
		).rejects.toMatchObject({
			refusal: 'unsupported-change',
			detail: expect.stringContaining('replace for legacy_replace'),
		});
		expect(mocks.compare).not.toHaveBeenCalled();
		expect(mocks.execute).not.toHaveBeenCalled();
		expect(testClient.query).not.toHaveBeenCalledWith(
			'SELECT current_database() AS database_id',
		);
	});

	it('refuses declared readdress before comparison or execution', async () => {
		const desired = modelWithTables([
			{
				name: 'legacy_readdress',
				readdress: {
					from: { name: 'legacy_source' },
					to: { name: 'legacy_readdress' },
				},
				columns: [],
				foreignKeys: [],
				indexes: [],
			},
		]);

		await expect(convergePg(poolFor(), desired)).rejects.toMatchObject({
			refusal: 'unsupported-change',
			detail: expect.stringContaining('readdress for legacy_readdress'),
		});
		expect(mocks.compare).not.toHaveBeenCalled();
		expect(mocks.execute).not.toHaveBeenCalled();
	});

	it('uses only the adopting table for the claim-time comparison', async () => {
		const catalogueIdentity = {
			engine: 'postgresql',
			format: 1,
			value: { oid: '1' },
		};
		const desired = modelWithTables([
			{
				name: 'legacy_adoption',
				adopt: true,
				columns: [],
				foreignKeys: [],
				indexes: [],
			},
			{
				name: 'unrelated_table',
				adopt: true,
				columns: [],
				foreignKeys: [],
				indexes: [],
			},
		]);
		mocks.compare.mockResolvedValue({ changes: [] });
		mocks.identity.mockResolvedValue({ catalogueIdentity });
		mocks.chain.mockResolvedValue({ events: [] });
		mocks.execute.mockImplementation(async (input) => {
			const step = input.manifest?.steps[0];
			if (!step || !input.verifyDeclaredAdoptionShape)
				throw new Error('expected a declared adoption step and verifier');
			await input.verifyDeclaredAdoptionShape(input.pool, step);
			return { outcome: 'completed' };
		});

		await expect(convergePg(poolFor(), desired)).resolves.toEqual({
			kind: 'applied',
			applied: ['adopt_table', 'adopt_table'],
		});
		expect(mocks.compare).toHaveBeenCalledTimes(2);
		const verificationModel = mocks.compare.mock.calls[1]?.[1];
		expect([...verificationModel.tables.keys()]).toEqual(['legacy_adoption']);
	});

	it('continues unchanged when its ledger home has no live reservation', async () => {
		mocks.compare.mockResolvedValue({ changes: [] });

		await expect(convergePg(poolFor(), emptyModel())).resolves.toEqual({
			kind: 'no-drift',
			applied: [],
		});
		expect(mocks.reservations).toHaveBeenCalledOnce();
		expect(mocks.runIds).not.toHaveBeenCalled();
	});

	it('refuses a read-only database before comparison', async () => {
		mocks.writability.mockResolvedValue({
			kind: 'database-read-only',
			detail: 'target session is read-only',
		});

		await expect(convergePg(poolFor(), emptyModel())).rejects.toMatchObject({
			refusal: 'database-read-only',
			detail: 'target session is read-only',
		});
		expect(mocks.compare).not.toHaveBeenCalled();
		expect(mocks.execute).not.toHaveBeenCalled();
	});

	it('surfaces an unavailable writability classification before comparison', async () => {
		mocks.writability.mockResolvedValue({
			kind: 'unavailable',
			detail: 'PostgreSQL writability could not be read',
		});

		const error = await convergePg(poolFor(), emptyModel()).catch(
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(PgConvergeRefusalError);
		expect((error as Error).message).toBe(
			'PostgreSQL writability could not be read',
		);
		expect(mocks.compare).not.toHaveBeenCalled();
		expect(mocks.execute).not.toHaveBeenCalled();
	});

	it('returns no-drift after a writable matching comparison', async () => {
		mocks.compare.mockResolvedValue({ changes: [] });

		await expect(convergePg(poolFor(), emptyModel())).resolves.toEqual({
			kind: 'no-drift',
			applied: [],
		});
		expect(mocks.writability).toHaveBeenCalledOnce();
		expect(mocks.compare).toHaveBeenCalledOnce();
	});

	it('refuses busy before comparison when a mapped predecessor run lock is held', async () => {
		const testClient = client();
		(testClient.query as ReturnType<typeof vi.fn>).mockImplementation(
			async (sql: string) => {
				if (sql === 'SHOW server_version_num')
					return { rows: [{ server_version_num: '150000' }] };
				if (sql.includes('pg_try_advisory_lock'))
					return { rows: [{ locked: false }] };
				return { rows: [] };
			},
		);
		mocks.reservations.mockResolvedValue([
			{ executionId: 'execution:open' } as never,
		]);
		mocks.runIds.mockResolvedValue(new Map([['execution:open', ['run:held']]]));

		await expect(
			convergePg(poolFor(testClient), emptyModel()),
		).rejects.toMatchObject({
			refusal: 'busy',
			runIds: [],
			executionIds: [],
			busyRunIds: ['run:held'],
			detail:
				'converge found live ledger reservations; run run:held is still executing; call convergePg again after it finishes',
		});
		expect(mocks.compare).not.toHaveBeenCalled();
		expect(mocks.execute).not.toHaveBeenCalled();
		expect(
			(testClient.query as ReturnType<typeof vi.fn>).mock.calls.some(([sql]) =>
				String(sql).includes('pg_advisory_unlock'),
			),
		).toBe(false);
	});

	it('releases a free predecessor run lock then requires recovery before comparison', async () => {
		const testClient = client();
		(testClient.query as ReturnType<typeof vi.fn>).mockImplementation(
			async (sql: string) => {
				if (sql === 'SHOW server_version_num')
					return { rows: [{ server_version_num: '150000' }] };
				if (sql.includes('pg_try_advisory_lock'))
					return { rows: [{ locked: true }] };
				if (sql.includes('pg_advisory_unlock'))
					return { rows: [{ unlocked: true }] };
				return { rows: [] };
			},
		);
		mocks.reservations.mockResolvedValue([
			{ executionId: 'execution:open' } as never,
		]);
		mocks.runIds.mockResolvedValue(
			new Map([['execution:open', ['run:recover']]]),
		);

		const refusal = convergePg(poolFor(testClient), emptyModel());
		await expect(refusal).rejects.toMatchObject({
			refusal: 'recovery-required',
			runIds: ['run:recover'],
			executionIds: [],
			busyRunIds: [],
		});
		const error = await refusal.catch((caught: unknown) => caught);
		expect((error as PgConvergeRefusalError).detail).toContain(
			'dbsp reconcile --db <database> <run-id>',
		);
		expect((error as PgConvergeRefusalError).detail).not.toContain(
			'dbsp reconcile run:recover',
		);
		expect(mocks.compare).not.toHaveBeenCalled();
		expect(mocks.execute).not.toHaveBeenCalled();
		expect(
			(testClient.query as ReturnType<typeof vi.fn>).mock.calls.filter(
				([sql]) => String(sql).includes('pg_advisory_unlock'),
			),
		).toHaveLength(1);
	});

	it('classifies free, held, and unmapped predecessor reservations before refusing', async () => {
		const testClient = client();
		let probes = 0;
		(testClient.query as ReturnType<typeof vi.fn>).mockImplementation(
			async (sql: string) => {
				if (sql === 'SHOW server_version_num')
					return { rows: [{ server_version_num: '150000' }] };
				if (sql.includes('pg_try_advisory_lock')) {
					probes += 1;
					return { rows: [{ locked: probes === 1 }] };
				}
				if (sql.includes('pg_advisory_unlock'))
					return { rows: [{ unlocked: true }] };
				return { rows: [] };
			},
		);
		mocks.reservations.mockResolvedValue([
			{ executionId: 'execution:free' } as never,
			{ executionId: 'execution:held' } as never,
			{ executionId: 'execution:unmapped' } as never,
		]);
		mocks.runIds.mockResolvedValue(
			new Map([
				['execution:free', ['run:free']],
				['execution:held', ['run:held']],
			]),
		);

		await expect(
			convergePg(poolFor(testClient), emptyModel()),
		).rejects.toMatchObject({
			refusal: 'recovery-required',
			runIds: ['run:free'],
			busyRunIds: ['run:held'],
			executionIds: ['execution:unmapped'],
			detail:
				'converge found live ledger reservations; run run:held is still executing; call convergePg again after it finishes; reconcile run run:free: call reconcilePgTransitionRun(pool, runId) or run `dbsp reconcile --db <database> <run-id>` once per run; no journal run is recorded for execution execution:unmapped; the ledger owner must resolve it',
		});
		expect(probes).toBe(2);
		expect(
			(testClient.query as ReturnType<typeof vi.fn>).mock.calls.filter(
				([sql]) => String(sql).includes('pg_advisory_unlock'),
			),
		).toHaveLength(1);
	});

	it('names mapped runs and unmapped executions separately for live reservations', async () => {
		const testClient = client();
		(testClient.query as ReturnType<typeof vi.fn>).mockImplementation(
			async (sql: string) => {
				if (sql === 'SHOW server_version_num')
					return { rows: [{ server_version_num: '150000' }] };
				if (sql.includes('pg_try_advisory_lock'))
					return { rows: [{ locked: true }] };
				if (sql.includes('pg_advisory_unlock'))
					return { rows: [{ unlocked: true }] };
				return { rows: [] };
			},
		);
		mocks.reservations.mockResolvedValue([
			{ executionId: 'execution:mapped' } as never,
			{ executionId: 'execution:unmapped' } as never,
		]);
		mocks.runIds.mockResolvedValue(
			new Map([['execution:mapped', ['run:recover']]]),
		);

		await expect(
			convergePg(poolFor(testClient), emptyModel()),
		).rejects.toMatchObject({
			refusal: 'recovery-required',
			runIds: ['run:recover'],
			executionIds: ['execution:unmapped'],
			busyRunIds: [],
			detail:
				'converge found live ledger reservations; reconcile run run:recover: call reconcilePgTransitionRun(pool, runId) or run `dbsp reconcile --db <database> <run-id>` once per run; no journal run is recorded for execution execution:unmapped; the ledger owner must resolve it',
		});
	});

	async function expectIndeterminatePredecessorProbe(
		probeResult: unknown,
	): Promise<void> {
		const testClient = client();
		(testClient.query as ReturnType<typeof vi.fn>).mockImplementation(
			async (sql: string) => {
				if (sql === 'SHOW server_version_num')
					return { rows: [{ server_version_num: '150000' }] };
				if (sql.includes('pg_try_advisory_lock')) return probeResult;
				return { rows: [] };
			},
		);
		mocks.reservations.mockResolvedValue([
			{ executionId: 'execution:open' } as never,
		]);
		mocks.runIds.mockResolvedValue(
			new Map([['execution:open', ['run:indeterminate']]]),
		);

		await expect(convergePg(poolFor(testClient), emptyModel())).rejects.toThrow(
			'predecessor lock acquisition is indeterminate',
		);
		expect(testClient.release).toHaveBeenCalledWith(expect.any(Error));
		expect(
			(testClient.query as ReturnType<typeof vi.fn>).mock.calls.some(([sql]) =>
				String(sql).includes('pg_advisory_unlock'),
			),
		).toBe(false);
	}

	it('destroys the client when predecessor lock acquisition returns no row', async () => {
		await expectIndeterminatePredecessorProbe({ rows: [] });
	});

	it("destroys the client when predecessor lock acquisition returns a string 't'", async () => {
		await expectIndeterminatePredecessorProbe({ rows: [{ locked: 't' }] });
	});

	it('requires recovery for an unmapped live reservation without trying a run lock', async () => {
		const testClient = client();
		mocks.reservations.mockResolvedValue([
			{ executionId: 'execution:unknown' } as never,
		]);

		await expect(
			convergePg(poolFor(testClient), emptyModel()),
		).rejects.toMatchObject({
			refusal: 'recovery-required',
			runIds: [],
			executionIds: ['execution:unknown'],
			busyRunIds: [],
		});
		expect(mocks.compare).not.toHaveBeenCalled();
		expect(mocks.execute).not.toHaveBeenCalled();
		expect(
			(testClient.query as ReturnType<typeof vi.fn>).mock.calls.some(([sql]) =>
				String(sql).includes('pg_try_advisory_lock'),
			),
		).toBe(false);
	});

	it('requires recovery when journal attribution cannot be read', async () => {
		mocks.reservations.mockResolvedValue([
			{ executionId: 'execution:one' } as never,
			{ executionId: 'execution:two' } as never,
		]);
		mocks.runIds.mockRejectedValue(
			Object.assign(new Error('lookup failed'), { code: '42501' }),
		);

		const refusal = convergePg(poolFor(), emptyModel());
		await expect(refusal).rejects.toMatchObject({
			refusal: 'recovery-required',
			runIds: [],
			executionIds: ['execution:one', 'execution:two'],
			busyRunIds: [],
			detail:
				'converge found live ledger reservations; journal attribution for execution execution:one, execution execution:two could not be read (SQLSTATE 42501); the journal owner must resolve it',
		});
		const error = await refusal.catch((caught: unknown) => caught);
		expect((error as PgConvergeRefusalError).detail).not.toContain(
			'no journal run is recorded',
		);
	});

	it('treats an absent transition journal as unmapped live reservations', async () => {
		mocks.reservations.mockResolvedValue([
			{ executionId: 'execution:one' } as never,
		]);
		mocks.runIds.mockRejectedValue(
			Object.assign(new Error('lookup failed'), { code: '42P01' }),
		);

		await expect(convergePg(poolFor(), emptyModel())).rejects.toMatchObject({
			refusal: 'recovery-required',
			runIds: [],
			executionIds: ['execution:one'],
			busyRunIds: [],
			detail: expect.stringContaining('no journal run is recorded'),
		});
	});

	it('escapes predecessor identifiers in refusal diagnostics only', async () => {
		const testClient = client();
		(testClient.query as ReturnType<typeof vi.fn>).mockImplementation(
			async (sql: string) => {
				if (sql === 'SHOW server_version_num')
					return { rows: [{ server_version_num: '150000' }] };
				if (sql.includes('pg_try_advisory_lock'))
					return { rows: [{ locked: true }] };
				if (sql.includes('pg_advisory_unlock'))
					return { rows: [{ unlocked: true }] };
				return { rows: [] };
			},
		);
		const runId = 'run:recover\ncontinued';
		const executionId = 'execution:\u202eunmapped';
		mocks.reservations.mockResolvedValue([
			{ executionId: 'execution:mapped' } as never,
			{ executionId } as never,
		]);
		mocks.runIds.mockResolvedValue(new Map([['execution:mapped', [runId]]]));

		const error = await convergePg(poolFor(testClient), emptyModel()).catch(
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(PgConvergeRefusalError);
		const refusal = error as PgConvergeRefusalError;
		expect(refusal).toMatchObject({
			refusal: 'recovery-required',
			runIds: [runId],
			executionIds: [executionId],
		});
		expect(refusal.detail).not.toContain('\n');
		expect(refusal.detail).not.toContain('\u202e');
		expect(refusal.detail).toContain('run:recover\\ncontinued');
		expect(refusal.detail).toContain('execution:\\u202eunmapped');
	});

	it('propagates a transport failure during journal lookup and destroys the client', async () => {
		const testClient = client();
		const failure = Object.assign(new Error('connection terminated'), {
			code: '08006',
		});
		mocks.reservations.mockResolvedValue([
			{ executionId: 'execution:open' } as never,
		]);
		mocks.runIds.mockRejectedValue(failure);

		await expect(convergePg(poolFor(testClient), emptyModel())).rejects.toBe(
			failure,
		);
		expect(testClient.release).toHaveBeenCalledWith(expect.any(Error));
	});

	it('does not compare an undeclared live sequence when the model declares none', async () => {
		mocks.introspect.mockResolvedValue(modelWithSequences(['live_sequence']));
		compareIntrospectedSchema();

		await expect(convergePg(poolFor(), emptyModel())).resolves.toEqual({
			kind: 'no-drift',
			applied: [],
		});
	});

	it('does not pass undeclared live enums to the comparison', async () => {
		mocks.introspect.mockResolvedValue(modelWithEnums(['live_enum']));
		mocks.compare.mockImplementation(
			async (adapter: {
				introspect: (options?: unknown) => Promise<ModelIR>;
			}) => {
				const introspected = await adapter.introspect({ schema: 'public' });
				expect([...(introspected.enums?.keys() ?? [])]).toEqual([]);
				return { changes: [] };
			},
		);

		await expect(convergePg(poolFor(), emptyModel())).resolves.toEqual({
			kind: 'no-drift',
			applied: [],
		});
	});

	it('creates a declared vacant sequence without comparing an undeclared live sequence', async () => {
		mocks.introspect.mockResolvedValue(modelWithSequences(['live_sequence']));
		compareIntrospectedSchema();
		mocks.createStep.mockImplementation(
			({ change: input }: { change: Record<string, unknown> }) =>
				stepFor(input),
		);

		await expect(
			convergePg(poolFor(), modelWithSequences(['declared_sequence'])),
		).resolves.toEqual({
			kind: 'applied',
			applied: ['create_sequence'],
		});
		expect(mocks.execute).toHaveBeenCalledTimes(1);
	});

	it('returns no drift for an empty model with live sequences', async () => {
		mocks.introspect.mockResolvedValue(modelWithSequences(['live_sequence']));
		compareIntrospectedSchema();

		await expect(convergePg(poolFor(), emptyModel())).resolves.toEqual({
			kind: 'no-drift',
			applied: [],
		});
	});

	it('refuses an absent schema ledger without sending DDL', async () => {
		const testClient = client();
		mocks.currency.mockResolvedValue({ kind: 'absent' });

		await expect(
			convergePg(poolFor(testClient), emptyModel()),
		).rejects.toMatchObject({
			refusal: 'ledger-absent',
		});
		const receivedSql = (
			testClient.query as unknown as {
				readonly mock: { readonly calls: readonly [string][] };
			}
		).mock.calls.map(([sql]) => sql);
		expect(
			receivedSql.some((sql) =>
				/^\s*(?:ALTER|CREATE|DROP|GRANT|REVOKE)\b/i.test(sql),
			),
		).toBe(false);
	});

	it('refuses a non-current schema ledger with its currency reason', async () => {
		mocks.currency.mockResolvedValue({
			kind: 'not-current',
			reason: 'lineage',
		} as never);

		await expect(convergePg(poolFor(), emptyModel())).rejects.toMatchObject({
			refusal: 'incompatible-ledger',
			detail: expect.stringContaining('lineage'),
		});
	});

	it('reports a held session lock as busy without discarding the client', async () => {
		const testClient = client();
		mocks.lock.mockResolvedValue({ kind: 'busy' });

		await expect(
			convergePg(poolFor(testClient), emptyModel()),
		).rejects.toMatchObject({
			refusal: 'busy',
		});
		expect(mocks.currency).not.toHaveBeenCalled();
		expect(testClient.release).toHaveBeenCalledWith(undefined);
	});

	it('discards a client whose ledger lock acquisition is undetermined', async () => {
		const testClient = client();
		mocks.lock.mockRejectedValue(new Error('ledger lock response lost'));

		await expect(convergePg(poolFor(testClient), emptyModel())).rejects.toThrow(
			'ledger lock response lost',
		);
		expect(testClient.release).toHaveBeenCalledWith(
			expect.objectContaining({
				message: 'converge could not determine ledger lock acquisition',
			}),
		);
	});

	it('refuses a non-nullable column', async () => {
		await expectRefusal(
			change('add_column', {
				column: { name: 'email', type: 'string', nullable: false },
			}),
			'unsupported-change',
		);
	});

	it('admits a nullable column with js and originalDbType but no default', async () => {
		await expectAdmittedAddColumn({
			name: 'coverage_epoch',
			type: 'bigint',
			nullable: true,
			js: 'bigint',
			originalDbType: 'BIGINT',
		});
	});

	it.each([
		['boolean', false],
		['finite number', 0],
		['string', 'unknown'],
	])('admits a NOT NULL column with a %s default', async (_kind, value) => {
		await expectAdmittedAddColumn(
			{
				name: 'value',
				type: 'string',
				nullable: false,
				default: value,
			},
			{ typtype: 'b', is_pg_catalog: true },
		);
	});

	it.each([
		['base type outside pg_catalog', { typtype: 'b', is_pg_catalog: false }],
		['composite type', { typtype: 'c', is_pg_catalog: false }],
		['pseudo type', { typtype: 'p', is_pg_catalog: true }],
		['range type', { typtype: 'r', is_pg_catalog: false }],
		['multirange type', { typtype: 'm', is_pg_catalog: false }],
		['domain type', { typtype: 'd', is_pg_catalog: false }],
	] as const)(
		'refuses a defaulted column with a %s before execution',
		async (_label, type) => {
			const testClient = client(type);
			await expectRefusal(
				change('add_column', {
					column: {
						name: 'value',
						type: 'integer',
						nullable: false,
						originalDbType: 'domain_type',
						default: 1,
					},
				}),
				'unsupported-change',
				testClient,
			);
			expect(testClient.query).toHaveBeenCalledWith(typeClassificationQuery, [
				'domain_type',
			]);
		},
	);

	it('admits a defaulted column with a built-in originalDbType', async () => {
		const testClient = await expectAdmittedAddColumn(
			{
				name: 'coverage_epoch',
				type: 'bigint',
				nullable: false,
				js: 'bigint',
				originalDbType: 'BIGINT',
				default: '0',
			},
			{ typtype: 'b', is_pg_catalog: true },
		);
		expect(testClient.query).toHaveBeenCalledWith(typeClassificationQuery, [
			'BIGINT',
		]);
	});

	it('admits a defaulted column with an enum originalDbType', async () => {
		const testClient = await expectAdmittedAddColumn(
			{
				name: 'state',
				type: 'string',
				nullable: false,
				originalDbType: 'state_enum',
				default: 'pending',
			},
			{ typtype: 'e', is_pg_catalog: false },
		);
		expect(testClient.query).toHaveBeenCalledWith(typeClassificationQuery, [
			'state_enum',
		]);
	});

	it('refuses a defaulted column with an unresolvable originalDbType', async () => {
		const testClient = client();
		await expectRefusal(
			change('add_column', {
				column: {
					name: 'value',
					type: 'integer',
					nullable: false,
					originalDbType: 'missing_type',
					default: 1,
				},
			}),
			'unsupported-change',
			testClient,
		);
		expect(testClient.query).toHaveBeenCalledWith(typeClassificationQuery, [
			'missing_type',
		]);
	});

	it('propagates a defaulted column type-rendering error before execution', async () => {
		const testClient = client();
		mocks.compare.mockResolvedValue({
			changes: [
				change('add_column', {
					column: {
						name: 'value',
						type: 'integer',
						nullable: false,
						originalDbType: 'integer; DROP TABLE users',
						default: 1,
					},
				}),
			],
		});

		let thrown: unknown;
		try {
			await convergePg(poolFor(testClient), emptyModel());
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(Error);
		expect(thrown).not.toBeInstanceOf(PgConvergeRefusalError);
		expect((thrown as Error).message).toContain('Unsafe database type name');
		expect(testClient.query).not.toHaveBeenCalledWith(
			typeClassificationQuery,
			expect.anything(),
		);
		expect(mocks.execute).not.toHaveBeenCalled();
	});

	it('classifies defaulted neutral types without originalDbType', async () => {
		const rangeClient = client({ typtype: 'r', is_pg_catalog: false });
		await expectRefusal(
			change('add_column', {
				column: {
					name: 'coverage',
					type: 'daterange',
					nullable: false,
					default: '[2026-01-01,2026-01-02)',
				},
			}),
			'unsupported-change',
			rangeClient,
		);
		expect(rangeClient.query).toHaveBeenCalledWith(typeClassificationQuery, [
			'DATERANGE',
		]);

		for (const [column, typeName] of [
			[
				{ name: 'count', type: 'integer', nullable: false, default: 1 },
				'INTEGER',
			],
			[
				{ name: 'label', type: 'string', nullable: false, default: 'draft' },
				'VARCHAR(255)',
			],
		] as const) {
			const builtInClient = await expectAdmittedAddColumn(column, {
				typtype: 'b',
				is_pg_catalog: true,
			});
			expect(builtInClient.query).toHaveBeenCalledWith(
				typeClassificationQuery,
				[typeName],
			);
		}
	});

	it('refuses a column with a default', async () => {
		await expectRefusal(
			change('add_column', {
				column: { name: 'email', type: 'string', nullable: true, default: 'x' },
			}),
			'unsupported-change',
		);
	});

	it('refuses a unique column', async () => {
		await expectRefusal(
			change('add_column', {
				column: { name: 'email', type: 'string', nullable: true, unique: true },
			}),
			'unsupported-change',
		);
	});

	it.each([
		['null', null],
		['raw SQL', { sql: 'now()' }],
		['attested raw SQL', { sql: 'now()', attestedBy: 'test' }],
		['function-like string', 'now()'],
		['UUID function-like string', 'gen_random_uuid()'],
		['NaN', Number.NaN],
		['infinity', Number.POSITIVE_INFINITY],
		['negative infinity', Number.NEGATIVE_INFINITY],
		['object', { value: 'x' }],
		['array', ['x']],
	])('refuses a NOT NULL column with a %s default', async (_kind, value) => {
		await expectRefusal(
			change('add_column', {
				column: {
					name: 'email',
					type: 'string',
					nullable: false,
					default: value,
				},
			}),
			'unsupported-change',
		);
	});

	it.each([
		'logicalIdentity',
		'originalDbTypeSchema',
		'originalDbTypeSchemaScope',
		'uniqueConstraintName',
		'autoIncrement',
		'collation',
		'comment',
		'identity',
		'unknown',
	])('refuses a column with a %s key', async (key) => {
		await expectRefusal(
			change('add_column', {
				column: {
					name: 'email',
					type: 'string',
					nullable: true,
					[key]: true,
				},
			}),
			'unsupported-change',
		);
	});

	it('refuses inherited or non-enumerable unique column properties', async () => {
		const inheritedUnique = Object.assign(Object.create({ unique: true }), {
			name: 'email',
			type: 'string',
			nullable: true,
		});
		await expectRefusal(
			change('add_column', { column: inheritedUnique }),
			'unsupported-change',
		);

		const nonEnumerableUnique = {
			name: 'email',
			type: 'string',
			nullable: true,
		};
		Object.defineProperty(nonEnumerableUnique, 'unique', { value: true });
		await expectRefusal(
			change('add_column', { column: nonEnumerableUnique }),
			'unsupported-change',
		);
	});

	it.each([
		['empty js', { js: '' }],
		['empty originalDbType', { originalDbType: '' }],
		['non-string js', { js: true }],
		['non-string originalDbType', { originalDbType: true }],
	])('refuses a column with %s', async (_kind, extra) => {
		await expectRefusal(
			change('add_column', {
				column: {
					name: 'email',
					type: 'string',
					nullable: true,
					...extra,
				},
			}),
			'unsupported-change',
		);
	});

	it('refuses a create_index before execution', async () => {
		await expectRefusal(
			change('create_index', { index: { columns: ['email'] } }),
			'unsupported-change',
		);
	});

	it('refuses an index or CHECK on an existing managed table', async () => {
		mocks.compare.mockResolvedValue({
			changes: [
				{
					...change('create_table', { table: { name: 'new_table' } }),
					table: 'new_table',
				},
				{
					...change('create_index', {
						index: { name: 'idx_users', columns: ['email'] },
					}),
					table: 'users',
				},
			],
		});

		await expect(convergePg(poolFor(), emptyModel())).rejects.toMatchObject({
			refusal: 'unsupported-change',
		});
		expect(mocks.execute).not.toHaveBeenCalled();

		mocks.compare.mockResolvedValue({
			changes: [
				{
					...change('create_table', { table: { name: 'new_table' } }),
					table: 'new_table',
				},
				{
					...change('add_check_constraint', {
						check: {
							name: 'users_email_check',
							expression: 'email IS NOT NULL',
						},
					}),
					table: 'users',
				},
			],
		});
		await expect(convergePg(poolFor(), emptyModel())).rejects.toMatchObject({
			refusal: 'unsupported-change',
		});
	});

	it('refuses a foreign key from a new table to an existing table', async () => {
		mocks.compare.mockResolvedValue({
			changes: [
				{
					...change('create_table', { table: { name: 'new_table' } }),
					table: 'new_table',
				},
				{
					...change('add_foreign_key', {
						fk: {
							columns: ['user_id'],
							references: { table: 'users', columns: ['id'] },
						},
					}),
					table: 'new_table',
				},
			],
		});

		await expect(convergePg(poolFor(), emptyModel())).rejects.toMatchObject({
			refusal: 'unsupported-change',
		});
	});

	it('refuses a drop before execution', async () => {
		await expectRefusal(change('drop_table'), 'unsupported-change');
	});

	it('continues to refuse sequence alteration and removal', async () => {
		await expectRefusal(
			change('alter_sequence', { sequence: { name: 'users_id_seq' } }),
			'unsupported-change',
		);
		await expectRefusal(
			change('drop_sequence', { sequence: { name: 'users_id_seq' } }),
			'unsupported-change',
		);
	});

	it('continues to refuse index removal', async () => {
		await expectRefusal(
			change('drop_index', {
				index: { name: 'idx_users_email', columns: ['email'] },
			}),
			'unsupported-change',
		);
	});

	it('leaves an exact external index drop out of converge while refusing it without the option', async () => {
		const desired = modelWithTable('users');
		const externalDrop = change('drop_index', {
			index: { name: 'idx_users_external', columns: ['email'] },
		});
		mocks.compare.mockResolvedValue({ changes: [externalDrop] });

		await expect(convergePg(poolFor(), desired)).rejects.toMatchObject({
			refusal: 'unsupported-change',
		});

		mockManagedObjects();
		await expect(
			convergePg(poolFor(), desired, {
				externalIndexes: [{ table: 'users', name: 'idx_users_external' }],
			}),
		).resolves.toEqual({ kind: 'no-drift', applied: [] });
		expect(mocks.execute).not.toHaveBeenCalled();
	});

	it('applies declared additions without assembling a matching external index drop', async () => {
		const desired = modelWithTable('users');
		mocks.compare.mockResolvedValue({
			changes: [
				change('drop_index', {
					index: { name: 'idx_users_external', columns: ['email'] },
				}),
				change('add_column', {
					column: { name: 'nickname', type: 'string', nullable: true },
				}),
			],
		});
		mocks.createStep.mockImplementation(
			({ change: input }: { change: Record<string, unknown> }) =>
				stepFor(input),
		);
		mockManagedObjects();

		await expect(
			convergePg(poolFor(), desired, {
				externalIndexes: [{ table: 'users', name: 'idx_users_external' }],
			}),
		).resolves.toEqual({ kind: 'applied', applied: ['add_column'] });
		expect(mocks.createStep).toHaveBeenCalledWith(
			expect.objectContaining({
				change: expect.objectContaining({ kind: 'add_column' }),
			}),
		);
		expect(mocks.createStep).toHaveBeenCalledTimes(1);
	});

	it('continues to refuse an undeclared index not named external', async () => {
		const desired = modelWithTable('users');
		mocks.compare.mockResolvedValue({
			changes: [
				change('drop_index', {
					index: { name: 'idx_users_external', columns: ['email'] },
				}),
				change('drop_index', {
					index: { name: 'idx_users_other', columns: ['name'] },
				}),
			],
		});

		await expect(
			convergePg(poolFor(), desired, {
				externalIndexes: [{ table: 'users', name: 'idx_users_external' }],
			}),
		).rejects.toMatchObject({
			refusal: 'unsupported-change',
			changes: [expect.objectContaining({ details: 'drop_index' })],
		});
	});

	it.each([
		[
			'explicitly named declared index',
			modelWithTable('users', [
				{ name: 'idx_users_email', columns: ['email'] },
			]),
			[{ table: 'users', name: 'idx_users_email' }],
		],
		[
			'unnamed declared index by its generated physical name',
			modelWithTable('users', [{ columns: ['email'] }]),
			[{ table: 'users', name: 'idx_users_email' }],
		],
	] as const)(
		'rejects an entry naming an %s before connecting',
		async (_case, desired, externalIndexes) => {
			const testClient = client();
			const pool = poolFor(testClient);

			await expect(
				convergePg(pool, desired, { externalIndexes }),
			).rejects.toMatchObject({
				refusal: 'invalid-options',
				detail: expect.stringContaining('externalIndexes[0]'),
			});
			expect(pool.connect).not.toHaveBeenCalled();
			expect(testClient.query).not.toHaveBeenCalled();
			expect(mocks.execute).not.toHaveBeenCalled();
		},
	);

	it('refuses an external index declared on another table before connecting', async () => {
		const desired = modelWithTables([
			{ name: 'users', columns: [], foreignKeys: [], indexes: [] },
			{
				name: 'orders',
				columns: [],
				foreignKeys: [],
				indexes: [{ name: 'idx_shared', columns: ['user_id'] }],
			},
		]);
		const testClient = client();
		const pool = poolFor(testClient);

		await expect(
			convergePg(pool, desired, {
				externalIndexes: [{ table: 'users', name: 'idx_shared' }],
			}),
		).rejects.toMatchObject({ refusal: 'invalid-options' });
		expect(pool.connect).not.toHaveBeenCalled();
		expect(testClient.query).not.toHaveBeenCalled();
	});

	it('refuses duplicate external index names across tables before connecting', async () => {
		const desired = modelWithTables([
			{ name: 'users', columns: [], foreignKeys: [], indexes: [] },
			{ name: 'orders', columns: [], foreignKeys: [], indexes: [] },
		]);
		const testClient = client();
		const pool = poolFor(testClient);

		await expect(
			convergePg(pool, desired, {
				externalIndexes: [
					{ table: 'users', name: 'x' },
					{ table: 'orders', name: 'x' },
				],
			}),
		).rejects.toMatchObject({ refusal: 'invalid-options' });
		expect(pool.connect).not.toHaveBeenCalled();
		expect(testClient.query).not.toHaveBeenCalled();
	});

	it.each([
		['undeclared table', [{ table: 'missing', name: 'idx_missing_email' }]],
		[
			'duplicate entry',
			[
				{ table: 'users', name: 'idx_users_email' },
				{ table: 'users', name: 'idx_users_email' },
			],
		],
		['empty table', [{ table: '', name: 'idx_users_email' }]],
		['empty name', [{ table: 'users', name: '' }]],
		['non-string field', [{ table: 'users', name: 1 }]],
		['non-object entry', [null]],
	] as const)(
		'rejects a %s external-index entry before connecting',
		async (_case, externalIndexes) => {
			const testClient = client();
			const pool = poolFor(testClient);

			await expect(
				convergePg(pool, modelWithTable('users'), {
					externalIndexes: externalIndexes as never,
				}),
			).rejects.toMatchObject({ refusal: 'invalid-options' });
			expect(pool.connect).not.toHaveBeenCalled();
			expect(testClient.query).not.toHaveBeenCalled();
			expect(mocks.execute).not.toHaveBeenCalled();
		},
	);

	it('treats an absent external index as a no-op', async () => {
		mocks.compare.mockResolvedValue({ changes: [] });
		mockManagedObjects();

		await expect(
			convergePg(poolFor(), modelWithTable('users'), {
				externalIndexes: [{ table: 'users', name: 'idx_users_absent' }],
			}),
		).resolves.toEqual({ kind: 'no-drift', applied: [] });
	});

	it('matches the logical external table entry to a snake_case diff table', async () => {
		mocks.compare.mockResolvedValue({
			changes: [
				{
					...change('drop_index', {
						index: { name: 'idx_user_profiles_external', columns: ['email'] },
					}),
					table: 'user_profiles',
				},
			],
		});
		mockManagedObjects();

		await expect(
			convergePg(poolFor(), modelWithTable('userProfiles'), {
				dbCasing: 'snake_case',
				externalIndexes: [
					{ table: 'userProfiles', name: 'idx_user_profiles_external' },
				],
			}),
		).resolves.toEqual({ kind: 'no-drift', applied: [] });
	});

	it('refuses a fresh single-column FK without a declared foreign key index before execution', async () => {
		mocks.compare.mockResolvedValue({
			changes: [createTableWithForeignKey('posts', ['author_id'])],
		});

		await expect(
			convergePg(poolFor(), emptyModel(), { fkAutoIndex: false }),
		).rejects.toMatchObject({
			refusal: 'unsupported-change',
			detail: expect.stringContaining(
				'converge refuses fresh foreign keys without a declared foreign key index: posts.author_id; declare a single-column index on each listed column, or a primary key or btree index (non-partial, without expressions) whose first column is that column',
			),
			changes: [
				expect.objectContaining({ kind: 'create_table', table: 'posts' }),
			],
		});
		expect(mocks.execute).not.toHaveBeenCalled();
	});

	it.each([
		[
			'a leading composite primary key',
			{ primaryKey: ['author_id', 'tenant_id'] },
		],
		['a single-column primary key', { primaryKey: 'author_id' }],
		[
			'a leading composite index',
			{
				indexes: [
					{ name: 'posts_author_tenant', columns: ['author_id', 'tenant_id'] },
				],
			},
		],
		[
			'an index with INCLUDE columns',
			{
				indexes: [
					{
						name: 'posts_author_include',
						columns: ['author_id'],
						include: ['id'],
					},
				],
			},
		],
		[
			'a unique index',
			{
				indexes: [
					{ name: 'posts_author_unique', columns: ['author_id'], unique: true },
				],
			},
		],
		[
			'a unique column',
			{
				columns: [
					{ name: 'author_id', type: 'integer', nullable: false, unique: true },
					{ name: 'tenant_id', type: 'integer', nullable: false },
					{ name: 'id', type: 'integer', nullable: false },
				],
			},
		],
	] as const)('admits a fresh FK covered by %s', async (_reason, overrides) => {
		mocks.compare.mockResolvedValue({
			changes: [freshSingleColumnFkChange(overrides)],
		});
		mocks.createStep.mockImplementation(createPgsqlGeneratedManagedStep);

		await expect(convergePg(poolFor(), emptyModel())).resolves.toMatchObject({
			kind: 'applied',
		});
	});

	it.each([
		['partial', { columns: ['author_id'], where: 'id > 0' }],
		[
			'expression',
			{ columns: ['author_id'], expressions: ['lower(author_id)'] },
		],
		['gin', { columns: ['author_id'], method: 'gin' }],
		['hash', { columns: ['author_id'], method: 'hash' }],
	] as const)(
		'admits a fresh FK with a declared single-column %s index',
		async (_reason, index) => {
			mocks.compare.mockResolvedValue({
				changes: [
					freshSingleColumnFkChange({
						indexes: [
							{ name: 'posts_author_index', ...index } satisfies IndexIR,
						],
					}),
				],
			});

			mocks.createStep.mockImplementation(createPgsqlGeneratedManagedStep);

			await expect(convergePg(poolFor(), emptyModel())).resolves.toMatchObject({
				kind: 'applied',
			});
		},
	);

	it('refuses a fresh FK with only a non-leading composite index', async () => {
		mocks.compare.mockResolvedValue({
			changes: [
				freshSingleColumnFkChange({
					indexes: [
						{
							name: 'posts_tenant_author_index',
							columns: ['tenant_id', 'author_id'],
						},
					],
				}),
			],
		});

		await expect(
			convergePg(poolFor(), emptyModel(), { fkAutoIndex: false }),
		).rejects.toMatchObject({
			refusal: 'unsupported-change',
			detail: expect.stringContaining(
				'converge refuses fresh foreign keys without a declared foreign key index: posts.author_id; declare a single-column index on each listed column, or a primary key or btree index (non-partial, without expressions) whose first column is that column',
			),
		});
	});

	it('admits a fresh composite FK because the generator does not auto-index it', async () => {
		mocks.compare.mockResolvedValue({
			changes: [createTableWithForeignKey('posts', ['author_id', 'tenant_id'])],
		});
		mocks.createStep.mockImplementation(createPgsqlGeneratedManagedStep);

		await expect(convergePg(poolFor(), emptyModel())).resolves.toMatchObject({
			kind: 'applied',
		});
		expect(mocks.generate).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ fkAutoIndex: true }),
		);
	});

	it('keeps a fresh table step to table DDL when its FK index is declared', async () => {
		mocks.compare.mockResolvedValue({
			changes: [
				createTableWithForeignKey(
					'posts',
					['author_id'],
					[{ name: 'posts_author_id_index', columns: ['author_id'] }],
				),
			],
		});
		mocks.createStep.mockImplementation(createPgsqlGeneratedManagedStep);

		await expect(convergePg(poolFor(), emptyModel())).resolves.toMatchObject({
			kind: 'applied',
		});
		const plan = mocks.execute.mock.calls[0]?.[0] as {
			readonly manifest: {
				readonly steps: readonly {
					readonly statementBundle: {
						readonly statements: readonly { readonly sql: string }[];
					};
				}[];
			};
		};
		const statements = plan.manifest.steps[0]?.statementBundle.statements;
		expect(statements).toHaveLength(1);
		expect(statements?.[0]?.sql).toMatch(/^CREATE TABLE\b/);
		expect(
			statements?.some((statement) => /CREATE INDEX/i.test(statement.sql)),
		).toBe(false);
		expect(mocks.generate).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ fkAutoIndex: true }),
		);
	});

	it('admits a sequence whose declared name changes under snake_case', async () => {
		const sequenceChange = {
			...change('create_sequence', {
				sequence: { name: 'order_number' },
			}),
			table: '',
			column: undefined,
		};
		mocks.compare.mockResolvedValue({ changes: [sequenceChange] });
		mocks.createStep.mockImplementation(createPgsqlGeneratedManagedStep);

		await expect(
			convergePg(poolFor(), modelWithSequences(['orderNumber']), {
				dbCasing: 'snake_case',
			}),
		).resolves.toMatchObject({ kind: 'applied' });
		expect(mocks.compare).toHaveBeenCalledOnce();
	});

	it.each([
		['order_number', 'orderNumber'],
		['orderNumber', 'order_number'],
	])(
		'refuses a snake_case sequence when its map key and SequenceIR name disagree (%s, %s)',
		async (key, name) => {
			const model: ModelIR = {
				...emptyModel(),
				sequences: new Map([[key, { name }]]),
			};

			await expect(
				convergePg(poolFor(), model, { dbCasing: 'snake_case' }),
			).rejects.toBeInstanceOf(SequenceNameMapKeyMismatchError);
			expect(mocks.compare).not.toHaveBeenCalled();
		},
	);

	it('refuses a preserve-cased sequence whose map key differs from SequenceIR.name before comparison', async () => {
		const model: ModelIR = {
			...emptyModel(),
			sequences: new Map([['order_sequence', { name: 'actual_sequence' }]]),
		};

		await expect(convergePg(poolFor(), model)).rejects.toBeInstanceOf(
			SequenceNameMapKeyMismatchError,
		);
		expect(mocks.compare).not.toHaveBeenCalled();
	});

	it.each([
		['snake_case', 'order_number'],
		['preserve', 'orderNumber'],
	] as const)(
		'admits a sequence whose declared name is unchanged under %s',
		async (dbCasing, name) => {
			const sequenceChange = {
				...change('create_sequence', { sequence: { name } }),
				table: '',
				column: undefined,
			};
			mocks.compare.mockResolvedValue({ changes: [sequenceChange] });
			mocks.createStep.mockImplementation(createPgsqlGeneratedManagedStep);

			await expect(
				convergePg(poolFor(), modelWithSequences([name]), { dbCasing }),
			).resolves.toMatchObject({ kind: 'applied' });
		},
	);

	it('refuses a type change before execution', async () => {
		await expectRefusal(change('alter_column_type'), 'unsupported-change');
	});

	it('refuses an auto-increment transition before execution', async () => {
		await expectRefusal(
			change('alter_column_auto_increment', {
				autoIncrement: true,
				previousAutoIncrement: false,
			}),
			'unsupported-change',
		);
	});

	it('refuses an unsupported server before comparison', async () => {
		const testClient = client();
		(testClient.query as ReturnType<typeof vi.fn>).mockImplementation(
			async (sql: string) => {
				if (sql === 'SHOW server_version_num')
					return { rows: [{ server_version_num: '140000' }] };
				if (sql === 'SELECT current_database() AS database_id')
					return { rows: [{ database_id: 'app' }] };
				return { rows: [] };
			},
		);

		await expect(
			convergePg(poolFor(testClient), emptyModel()),
		).rejects.toMatchObject({
			refusal: 'unsupported-server',
			detail: expect.stringContaining('140000'),
		});
		expect(mocks.compare).not.toHaveBeenCalled();
		expect(testClient.query).toHaveBeenCalledWith('SHOW server_version_num');
		expect(mocks.currency).not.toHaveBeenCalled();
	});

	it('uses snake_case physical table names for unmanaged ownership', async () => {
		const model = {
			...emptyModel(),
			tables: new Map([
				[
					'userProfile',
					{ name: 'userProfile', columns: [], foreignKeys: [], indexes: [] },
				],
			]),
		};
		mocks.compare.mockResolvedValue({ changes: [] });
		mocks.identity.mockResolvedValue({
			catalogueIdentity: { value: { oid: '1' } },
		});
		await expect(
			convergePg(poolFor(), model, { dbCasing: 'snake_case' }),
		).rejects.toBeInstanceOf(PgConvergeRefusalError);
		expect(mocks.identity.mock.calls[0]?.[1]).toMatchObject({
			name: 'user_profile',
		});
	});

	it('refuses an add_column on an unmanaged parent', async () => {
		mocks.identity.mockResolvedValue(undefined);
		await expectRefusal(
			change('add_column', {
				column: { name: 'email', type: 'string', nullable: true },
			}),
			'unmanaged-parent',
		);
	});

	it('passes a schema-scoped generated parent address to the ledger', async () => {
		const generatedChange: SchemaChange = {
			kind: 'add_column',
			table: 'users',
			column: 'email',
			destructive: false,
			details: 'add nullable email column',
			meta: { column: { name: 'email', type: 'string', nullable: true } },
		};
		mocks.compare.mockResolvedValue({ changes: [generatedChange] });
		mocks.createStep.mockImplementation(createPgsqlGeneratedManagedStep);
		mocks.identity.mockResolvedValue({
			catalogueIdentity: {
				engine: 'postgresql',
				format: 1,
				value: { oid: '1' },
			},
		});

		await expect(convergePg(poolFor(), emptyModel())).rejects.toMatchObject({
			refusal: 'unmanaged-parent',
		});
		expect(mocks.chain).toHaveBeenCalledWith(
			expect.anything(),
			{ scope: 'schema', schema: 'public' },
			{
				scope: 'schema',
				engine: 'postgresql',
				database: 'app',
				schema: 'public',
				kind: 'table',
				name: 'users',
			},
		);
	});

	it('returns no-drift only after ownership inspection', async () => {
		mocks.compare.mockResolvedValue({ changes: [] });
		mocks.identity.mockResolvedValue(undefined);
		await expect(convergePg(poolFor(), emptyModel())).resolves.toEqual({
			kind: 'no-drift',
			applied: [],
		});
	});

	it('passes the physical snapshot without an ownership mask when no step owns a surface', async () => {
		mocks.compare.mockResolvedValue({ changes: [] });
		mocks.identity.mockResolvedValue(undefined);
		const model = emptyModel();
		await expect(convergePg(poolFor(), model)).resolves.toEqual({
			kind: 'no-drift',
			applied: [],
		});
		expect(mocks.declaredComparison).toHaveBeenCalledWith(
			expect.objectContaining({ model: expect.anything() }),
		);
		expect(mocks.declaredComparison.mock.calls[0]?.[0]?.model.tables).not.toBe(
			model.tables,
		);
		expect(mocks.declaredComparison.mock.calls[0]?.[0]).not.toHaveProperty(
			'ownershipMask',
		);
	});

	it('refuses a declared table absent after comparison without sending DDL', async () => {
		const testClient = client();
		const model = {
			...emptyModel(),
			tables: new Map([
				['users', { name: 'users', columns: [], foreignKeys: [], indexes: [] }],
			]),
		};
		mocks.compare.mockResolvedValue({ changes: [] });
		mocks.identity.mockResolvedValue(undefined);

		await expect(convergePg(poolFor(testClient), model)).rejects.toMatchObject({
			refusal: 'concurrent-drift',
			detail: expect.stringContaining('users'),
		});
		const receivedSql = (
			testClient.query as unknown as {
				readonly mock: { readonly calls: readonly [string][] };
			}
		).mock.calls.map(([sql]) => sql);
		expect(
			receivedSql.some((sql) =>
				/^\s*(?:ALTER|CREATE|DROP|GRANT|REVOKE)\b/i.test(sql),
			),
		).toBe(false);
		expect(mocks.execute).not.toHaveBeenCalled();
		expect(mocks.identity).toHaveBeenCalledTimes(1);
	});

	it('refuses a declared sequence absent after comparison with one catalogue probe', async () => {
		const model = modelWithSequences(['missing_sequence']);
		mocks.compare.mockResolvedValue({ changes: [] });
		mocks.identity.mockResolvedValue(undefined);

		await expect(convergePg(poolFor(), model)).rejects.toMatchObject({
			refusal: 'concurrent-drift',
			detail: expect.stringContaining('missing_sequence'),
		});
		expect(mocks.identity).toHaveBeenCalledTimes(1);
		expect(mocks.execute).not.toHaveBeenCalled();
	});

	it('projects declared physical names after whole-schema introspection', async () => {
		const model = {
			...emptyModel(),
			tables: new Map([
				[
					'userProfile',
					{ name: 'userProfile', columns: [], foreignKeys: [], indexes: [] },
				],
			]),
		};
		mocks.compare.mockImplementation(
			async (adapter: {
				introspect: (options?: unknown) => Promise<unknown>;
			}) => {
				await adapter.introspect({ schema: 'public' });
				return { changes: [] };
			},
		);
		const catalogueIdentity = {
			engine: 'postgresql',
			format: 1,
			value: { oid: '1' },
		};
		const address = {
			scope: 'schema',
			engine: 'postgresql',
			database: 'app',
			schema: 'public',
			kind: 'table',
			name: 'user_profile',
		} as const;
		mocks.identity.mockResolvedValue({ catalogueIdentity });
		mocks.chain.mockResolvedValue({
			ledger: { scope: 'schema', schema: 'public' },
			address,
			events: [
				{
					eventId: 'adopt-intent',
					address,
					eventKind: 'adopt-intent',
					controller: 'deployment',
				},
				{
					eventId: 'adopt',
					predecessor: 'adopt-intent',
					address,
					eventKind: 'adopt',
					controller: 'deployment',
					observed: { value: { table: 'user_profile' }, digest: 'observed' },
				},
			],
			terminalMember: { catalogueIdentity },
		} as never);

		await expect(
			convergePg(poolFor(), model, { dbCasing: 'snake_case' }),
		).resolves.toEqual({ kind: 'no-drift', applied: [] });
		expect(mocks.introspect).toHaveBeenCalledWith({
			schema: 'public',
		});
	});

	it('projects every live table out of an empty declaration', async () => {
		mocks.compare.mockImplementation(
			async (adapter: {
				introspect: (options?: unknown) => Promise<unknown>;
			}) => {
				await adapter.introspect({ schema: 'public' });
				return { changes: [] };
			},
		);

		await expect(convergePg(poolFor(), emptyModel())).resolves.toEqual({
			kind: 'no-drift',
			applied: [],
		});
		expect(mocks.introspect).toHaveBeenCalledWith({
			schema: 'public',
		});
	});

	it('executes three changes as one ordered manifest', async () => {
		const changes = [
			change('create_table'),
			change('create_table'),
			change('create_table'),
		];
		mocks.compare.mockResolvedValue({ changes });
		mocks.createStep.mockImplementation(
			({
				change: input,
				stepKey,
				order,
			}: {
				change: Record<string, unknown>;
				stepKey: string;
				order: number;
			}) => ({
				...stepFor(input),
				stepKey,
				order,
				plannedClaimKeys: [`${stepKey}:root`],
			}),
		);

		await expect(convergePg(poolFor(), emptyModel())).resolves.toEqual({
			kind: 'applied',
			applied: ['create_table', 'create_table', 'create_table'],
		});
		expect(mocks.execute).toHaveBeenCalledTimes(1);
		expect(mocks.execute.mock.calls[0]?.[0]).toMatchObject({
			manifest: { steps: [{ order: 0 }, { order: 1 }, { order: 2 }] },
		});
	});

	it('orders created tables before their indexes, CHECKs, and cyclic foreign keys', async () => {
		const changes: SchemaChange[] = [
			{
				kind: 'add_foreign_key',
				table: 'left_table',
				destructive: false,
				details: 'left references right',
				meta: {
					fk: {
						columns: ['right_id'],
						references: { table: 'right_table', columns: ['id'] },
					},
				},
			},
			{
				kind: 'create_index',
				table: 'left_table',
				destructive: false,
				details: 'left index',
				meta: {
					index: { name: 'idx_left_table_id', columns: ['id'], unique: true },
				},
			},
			{
				kind: 'add_check_constraint',
				table: 'left_table',
				destructive: false,
				details: 'left check',
				meta: { check: { name: 'left_id_check', expression: 'id > 0' } },
			},
			{
				kind: 'create_table',
				table: 'right_table',
				destructive: false,
				details: 'create right',
				meta: {
					table: {
						name: 'right_table',
						columns: [],
						primaryKey: 'id',
						foreignKeys: [],
						indexes: [],
					},
				},
			},
			{
				kind: 'add_foreign_key',
				table: 'right_table',
				destructive: false,
				details: 'right references left',
				meta: {
					fk: {
						columns: ['left_id'],
						references: { table: 'left_table', columns: ['id'] },
					},
				},
			},
			{
				kind: 'create_table',
				table: 'left_table',
				destructive: false,
				details: 'create left',
				meta: {
					table: {
						name: 'left_table',
						columns: [],
						primaryKey: 'id',
						foreignKeys: [],
						indexes: [],
					},
				},
			},
		];
		mocks.compare.mockResolvedValue({ changes });
		mocks.createStep.mockImplementation(createPgsqlGeneratedManagedStep);

		await expect(convergePg(poolFor(), emptyModel())).resolves.toMatchObject({
			kind: 'applied',
		});
		expect(mocks.execute.mock.calls[0]?.[0]).toMatchObject({
			manifest: {
				steps: [
					{
						stepKey: 'converge:0',
						address: { kind: 'table', name: 'right_table' },
					},
					{
						stepKey: 'converge:1',
						address: { kind: 'table', name: 'left_table' },
					},
					{
						address: { kind: 'index', name: 'idx_left_table_id' },
						dependencyOrder: ['converge:1'],
					},
					{
						address: { kind: 'constraint', name: 'fk_left_table_right_id' },
						dependencyOrder: ['converge:1', 'converge:0'],
					},
					{
						address: { kind: 'constraint', name: 'fk_right_table_left_id' },
						dependencyOrder: ['converge:0', 'converge:1'],
					},
					{
						address: { kind: 'constraint', name: 'left_id_check' },
						dependencyOrder: ['converge:1'],
					},
				],
			},
		});
	});

	it('orders a qualifying unique index before its fresh foreign key and records the dependency', async () => {
		const changes: SchemaChange[] = [
			{
				kind: 'add_foreign_key',
				table: 'child_table',
				destructive: false,
				details: 'child references parent external id',
				meta: {
					fk: {
						columns: ['parent_external_id'],
						references: { table: 'parent_table', columns: ['external_id'] },
					},
				},
			},
			{
				kind: 'create_index',
				table: 'parent_table',
				destructive: false,
				details: 'parent external id unique',
				meta: {
					index: {
						name: 'parent_table_external_id_unique',
						columns: ['external_id'],
						unique: true,
					},
				},
			},
			{
				kind: 'create_table',
				table: 'child_table',
				destructive: false,
				details: 'create child',
				meta: {
					table: {
						name: 'child_table',
						columns: [],
						primaryKey: 'id',
						foreignKeys: [],
						indexes: [],
					},
				},
			},
			{
				kind: 'create_table',
				table: 'parent_table',
				destructive: false,
				details: 'create parent',
				meta: {
					table: {
						name: 'parent_table',
						columns: [],
						primaryKey: 'id',
						foreignKeys: [],
						indexes: [],
					},
				},
			},
		];
		mocks.compare.mockResolvedValue({ changes });
		mocks.createStep.mockImplementation(createPgsqlGeneratedManagedStep);

		await expect(convergePg(poolFor(), emptyModel())).resolves.toEqual({
			kind: 'applied',
			applied: [
				'create_table',
				'create_table',
				'create_index',
				'add_foreign_key',
			],
		});
		expect(mocks.execute.mock.calls[0]?.[0]).toMatchObject({
			manifest: {
				steps: [
					{ address: { kind: 'table', name: 'child_table' } },
					{ address: { kind: 'table', name: 'parent_table' } },
					{
						stepKey: 'converge:2',
						address: {
							kind: 'index',
							name: 'parent_table_external_id_unique',
						},
					},
					{
						address: {
							kind: 'constraint',
							name: 'fk_child_table_parent_external_id',
						},
						dependencyOrder: ['converge:0', 'converge:1', 'converge:2'],
					},
				],
			},
		});
	});

	it('admits a fresh FK whose referenced columns reverse a composite primary key', async () => {
		mocks.compare.mockResolvedValue({
			changes: freshForeignKeyChanges(['external_id', 'tenant_id'], {
				primaryKey: ['tenant_id', 'external_id'],
			}),
		});
		mocks.createStep.mockImplementation(createPgsqlGeneratedManagedStep);

		await expect(convergePg(poolFor(), emptyModel())).resolves.toMatchObject({
			kind: 'applied',
		});
	});

	it('orders a reversed composite qualifying unique index before its fresh FK', async () => {
		mocks.compare.mockResolvedValue({
			changes: freshForeignKeyChanges(['b', 'a'], {
				index: {
					name: 'parent_table_a_b_unique',
					columns: ['a', 'b'],
					unique: true,
				},
			}),
		});
		mocks.createStep.mockImplementation(createPgsqlGeneratedManagedStep);

		await expect(convergePg(poolFor(), emptyModel())).resolves.toMatchObject({
			kind: 'applied',
		});
		const executionInput = mocks.execute.mock.calls[0]?.[0];
		expect(executionInput).toBeDefined();
		expect(executionInput).toMatchObject({
			atomicCreationGroup: [
				'converge:0',
				'converge:1',
				'converge:2',
				'converge:3',
			],
		});
		const steps = (
			executionInput as {
				readonly manifest: {
					readonly steps: readonly {
						readonly stepKey: string;
						readonly address?: { readonly kind: string; readonly name: string };
						readonly dependencyOrder: readonly string[];
					}[];
				};
			}
		).manifest.steps;
		const indexStep = steps.find(
			(step) =>
				step.address?.kind === 'index' &&
				step.address.name === 'parent_table_a_b_unique',
		);
		const foreignKeyStep = steps.find(
			(step) =>
				step.address?.kind === 'constraint' &&
				step.address.name === 'fk_child_table_parent_first_parent_second',
		);
		expect(indexStep).toBeDefined();
		expect(foreignKeyStep).toBeDefined();
		expect(foreignKeyStep?.dependencyOrder).toContain(indexStep?.stepKey);
	});

	it.each([
		['primary key', { primaryKey: 'a' }],
		[
			'unique index',
			{
				index: {
					name: 'parent_table_a_b_unique',
					columns: ['a', 'b'],
					unique: true,
				},
			},
		],
	] as const)(
		'refuses duplicate referenced columns against a %s before execution',
		async (_label, options) => {
			mocks.compare.mockResolvedValue({
				changes: freshForeignKeyChanges(['a', 'a'], options),
			});

			await expect(convergePg(poolFor(), emptyModel())).rejects.toMatchObject({
				refusal: 'unsupported-change',
			});
			expect(mocks.execute).not.toHaveBeenCalled();
		},
	);

	it('refuses an unnamed expression-only index on a fresh table before execution', async () => {
		mocks.compare.mockResolvedValue({
			changes: [
				{
					kind: 'create_table',
					table: 'users',
					destructive: false,
					details: 'create users',
					meta: {
						table: { name: 'users', columns: [], foreignKeys: [], indexes: [] },
					},
				},
				{
					kind: 'create_index',
					table: 'users',
					destructive: false,
					details: 'create expression index',
					meta: { index: { columns: [], expressions: ['lower(email::text)'] } },
				},
			],
		});

		await expect(convergePg(poolFor(), emptyModel())).rejects.toMatchObject({
			refusal: 'unsupported-change',
			detail: expect.stringContaining('users'),
		});
		expect(mocks.execute).not.toHaveBeenCalled();
	});

	it('admits a named expression-only index on a fresh table', async () => {
		mocks.compare.mockResolvedValue({
			changes: [
				{
					kind: 'create_table',
					table: 'users',
					destructive: false,
					details: 'create users',
					meta: {
						table: { name: 'users', columns: [], foreignKeys: [], indexes: [] },
					},
				},
				{
					kind: 'create_index',
					table: 'users',
					destructive: false,
					details: 'create expression index',
					meta: {
						index: {
							name: 'users_lower_email_idx',
							columns: [],
							expressions: ['lower(email::text)'],
						},
					},
				},
			],
		});
		mocks.createStep.mockImplementation(createPgsqlGeneratedManagedStep);

		await expect(convergePg(poolFor(), emptyModel())).resolves.toMatchObject({
			kind: 'applied',
		});
	});

	it('propagates an address failure for an otherwise admitted change', async () => {
		mocks.compare.mockResolvedValue({
			changes: [
				{
					kind: 'create_table',
					table: 'users',
					destructive: false,
					details: 'create users',
					meta: {
						table: { name: 'users', columns: [], foreignKeys: [], indexes: [] },
					},
				},
				{
					kind: 'add_check_constraint',
					table: 'users',
					destructive: false,
					details: 'malformed check',
					meta: { check: null },
				},
			],
		});

		await expect(convergePg(poolFor(), emptyModel())).rejects.toThrow(
			'generator planning refuses add_check_constraint: missing typed check',
		);
		expect(mocks.execute).not.toHaveBeenCalled();
	});

	it.each([
		[
			'partial unique index',
			{
				name: 'parent_table_external_id_unique',
				columns: ['external_id'],
				unique: true,
				where: 'external_id IS NOT NULL',
			},
		],
		[
			'expression unique index',
			{
				name: 'parent_table_external_id_unique',
				columns: ['external_id'],
				unique: true,
				expressions: ['lower(external_id::text)'],
			},
		],
		['no unique key', undefined],
	] as const)(
		'refuses a fresh FK referencing a %s before execution',
		async (_label, index) => {
			const changes: SchemaChange[] = [
				{
					kind: 'create_table',
					table: 'parent_table',
					destructive: false,
					details: 'create parent',
					meta: {
						table: {
							name: 'parent_table',
							columns: [],
							primaryKey: 'id',
							foreignKeys: [],
							indexes: [],
						},
					},
				},
				{
					kind: 'create_table',
					table: 'child_table',
					destructive: false,
					details: 'create child',
					meta: {
						table: {
							name: 'child_table',
							columns: [],
							primaryKey: 'id',
							foreignKeys: [],
							indexes: [],
						},
					},
				},
				{
					kind: 'add_foreign_key',
					table: 'child_table',
					destructive: false,
					details: 'child references parent external id',
					meta: {
						fk: {
							columns: ['parent_external_id'],
							references: { table: 'parent_table', columns: ['external_id'] },
						},
					},
				},
				...(index === undefined
					? []
					: [
							{
								kind: 'create_index' as const,
								table: 'parent_table',
								destructive: false,
								details: 'partial unique parent external id',
								meta: { index },
							},
						]),
			];
			mocks.compare.mockResolvedValue({ changes });

			await expect(convergePg(poolFor(), emptyModel())).rejects.toMatchObject({
				refusal: 'unsupported-change',
				detail: expect.stringContaining('fk_child_table_parent_external_id'),
			});
			expect(mocks.execute).not.toHaveBeenCalled();
		},
	);

	it('admits fresh FKs to a primary key and a column-level unique key', async () => {
		const changes: SchemaChange[] = [
			{
				kind: 'create_table',
				table: 'parent_table',
				destructive: false,
				details: 'create parent',
				meta: {
					table: {
						name: 'parent_table',
						columns: [
							{
								name: 'external_id',
								type: 'integer',
								nullable: false,
								unique: true,
							},
						],
						primaryKey: 'id',
						foreignKeys: [],
						indexes: [],
					},
				},
			},
			{
				kind: 'create_table',
				table: 'child_table',
				destructive: false,
				details: 'create child',
				meta: {
					table: {
						name: 'child_table',
						columns: [],
						primaryKey: 'id',
						foreignKeys: [],
						indexes: [],
					},
				},
			},
			{
				kind: 'add_foreign_key',
				table: 'child_table',
				destructive: false,
				details: 'child references parent id',
				meta: {
					fk: {
						columns: ['parent_id'],
						references: { table: 'parent_table', columns: ['id'] },
					},
				},
			},
			{
				kind: 'add_foreign_key',
				table: 'child_table',
				destructive: false,
				details: 'child references parent external id',
				meta: {
					fk: {
						columns: ['parent_external_id'],
						references: { table: 'parent_table', columns: ['external_id'] },
					},
				},
			},
		];
		mocks.compare.mockResolvedValue({ changes });
		mocks.createStep.mockImplementation(createPgsqlGeneratedManagedStep);

		await expect(convergePg(poolFor(), emptyModel())).resolves.toMatchObject({
			kind: 'applied',
		});
	});

	it('surfaces partially applied executor steps', async () => {
		mocks.compare.mockResolvedValue({ changes: [change('create_table')] });
		mocks.createStep.mockImplementation(
			({ change: input }: { change: Record<string, unknown> }) =>
				stepFor(input),
		);
		mocks.execute.mockResolvedValue({
			outcome: 'partially-applied',
			detail: 'second step failed',
			completedStepKeys: ['converge:0'],
			notStartedStepKeys: ['converge:1'],
		});

		await expect(convergePg(poolFor(), emptyModel())).resolves.toEqual({
			kind: 'partially-applied',
			detail: 'second step failed',
			completedStepKeys: ['converge:0'],
			notStartedStepKeys: ['converge:1'],
		});
	});

	it('destroys the client when the ledger lock release is unconfirmed', async () => {
		const testClient = client();
		mocks.compare.mockResolvedValue({ changes: [] });
		mocks.unlock.mockResolvedValue(false);

		await expect(
			convergePg(poolFor(testClient), emptyModel()),
		).resolves.toEqual({ kind: 'no-drift', applied: [] });
		expect(testClient.release).toHaveBeenCalledWith(
			expect.objectContaining({
				message: 'converge could not confirm ledger lock release',
			}),
		);
	});

	it('returns a transport-ambiguous executor outcome', async () => {
		const testClient = client();
		mocks.compare.mockResolvedValue({ changes: [change('create_table')] });
		mocks.createStep.mockImplementation(
			({ change: input }: { change: Record<string, unknown> }) =>
				stepFor(input),
		);
		mocks.execute.mockResolvedValue({
			outcome: 'transport-ambiguous',
			detail: 'terminal commit acknowledgement was lost',
		});

		await expect(
			convergePg(poolFor(testClient), emptyModel()),
		).resolves.toEqual({
			kind: 'transport-ambiguous',
			detail: 'terminal commit acknowledgement was lost',
		});
		expect(testClient.release).toHaveBeenCalledWith(
			expect.objectContaining({
				message: 'converge received a transport-ambiguous outcome',
			}),
		);
	});

	it('refuses a recovery-required executor outcome as execution-refused', async () => {
		mocks.compare.mockResolvedValue({ changes: [change('create_table')] });
		mocks.createStep.mockImplementation(
			({ change: input }: { change: Record<string, unknown> }) =>
				stepFor(input),
		);
		mocks.execute.mockResolvedValue({
			outcome: 'recovery-required',
			claimId: 'claim-769',
			detail: 'claim needs reconciliation',
		});

		await expect(convergePg(poolFor(), emptyModel())).rejects.toMatchObject({
			refusal: 'execution-refused',
			detail: 'claim needs reconciliation',
		});
	});

	it('refuses an execution-failed executor outcome with its detail unchanged', async () => {
		mocks.compare.mockResolvedValue({ changes: [change('create_table')] });
		mocks.createStep.mockImplementation(
			({ change: input }: { change: Record<string, unknown> }) =>
				stepFor(input),
		);
		mocks.execute.mockResolvedValue({
			outcome: 'execution-failed',
			detail: 'the executor detail',
		});

		await expect(convergePg(poolFor(), emptyModel())).rejects.toMatchObject({
			refusal: 'execution-refused',
			detail: 'the executor detail',
		});
	});

	it('passes no atomic group when converge creates no table', async () => {
		mocks.introspect.mockResolvedValue(emptyModel());
		compareIntrospectedSchema();
		mocks.createStep.mockImplementation(
			({ change: input }: { change: Record<string, unknown> }) =>
				stepFor(input),
		);
		await expect(
			convergePg(poolFor(), modelWithSequences(['declared_sequence'])),
		).resolves.toMatchObject({
			kind: 'applied',
		});
		expect(mocks.execute.mock.calls[0]?.[0]).not.toHaveProperty(
			'atomicCreationGroup',
		);
	});

	it('adds the creating-table dependency to a fresh add_column', async () => {
		const createTable: SchemaChange = {
			kind: 'create_table',
			table: 'users',
			destructive: false,
			details: 'create users',
			meta: {
				table: { name: 'users', columns: [], foreignKeys: [], indexes: [] },
			},
		};
		const addColumn: SchemaChange = {
			kind: 'add_column',
			table: 'users',
			column: 'email',
			destructive: false,
			details: 'add email',
			meta: { column: { name: 'email', type: 'integer', nullable: true } },
		};
		mocks.compare.mockResolvedValue({ changes: [addColumn, createTable] });
		mocks.createStep.mockImplementation(createPgsqlGeneratedManagedStep);
		await expect(convergePg(poolFor(), emptyModel())).resolves.toMatchObject({
			kind: 'applied',
		});
		expect(mocks.execute.mock.calls[0]?.[0]).toMatchObject({
			atomicCreationGroup: ['converge:0', 'converge:1'],
			manifest: {
				steps: [
					{ address: { kind: 'table', name: 'users' } },
					{ dependencyOrder: ['converge:0'] },
				],
			},
		});
	});

	it('releases a converge client with its outcome-session compromise marker', async () => {
		const testClient = client();
		(testClient.query as ReturnType<typeof vi.fn>).mockImplementation(
			async (sql: string) => {
				if (sql === 'ROLLBACK')
					throw Object.assign(new Error('rollback rejected'), {
						code: 'XX000',
					});
				if (sql === 'SHOW server_version_num')
					return { rows: [{ server_version_num: '150000' }] };
				if (sql === 'SELECT current_database() AS database_id')
					return { rows: [{ database_id: 'app' }] };
				return { rows: [] };
			},
		);
		await rollbackPgOutcomeGroup(testClient);
		mocks.compare.mockResolvedValue({ changes: [] });
		await convergePg(poolFor(testClient), emptyModel());
		expect(mocks.unlock).not.toHaveBeenCalled();
		expect(testClient.release).toHaveBeenCalledWith(
			expect.objectContaining({ message: 'rollback rejected' }),
		);
	});
});
