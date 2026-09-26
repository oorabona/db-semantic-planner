import type { ModelIR } from '@dbsp/types';
import type { Pool, PoolClient } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPgsqlGeneratedManagedStep } from '../ddl/managed-step-manifest.js';
import { generateMigrationSQL as generateMigrationSql } from '../ddl/migration-sql.js';
import { compareSchemata, type SchemaChange } from '../ddl/schema-diff.js';
import type { GeneratorExecutionResult } from './generator-execution.js';

const mocks = vi.hoisted(() => {
	const introspect = vi.fn<(...args: unknown[]) => Promise<unknown>>(
		async () => undefined,
	);
	return {
		compare: vi.fn(),
		createStep: vi.fn(),
		generate: vi.fn<(...args: unknown[]) => readonly string[]>(() => [
			'CREATE TABLE "users" ()',
		]),
		execute: vi.fn<(...args: unknown[]) => Promise<GeneratorExecutionResult>>(
			async () => ({ outcome: 'completed' }),
		),
		identity: vi.fn(),
		chain: vi.fn(async () => ({ events: [] })),
		lock: vi.fn(async () => ({ kind: 'acquired' })),
		unlock: vi.fn(async () => true),
		currency: vi.fn(async () => ({ kind: 'current' })),
		introspect,
		adapter: { introspect },
	};
});

function forward(fn: unknown, args: readonly unknown[]): unknown {
	return (fn as (...values: readonly unknown[]) => unknown)(...args);
}

vi.mock('../ddl/index.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../ddl/index.js')>()),
	comparePgsqlDatabaseSchema: (...args: unknown[]) =>
		forward(mocks.compare, args),
	createPgsqlGeneratedManagedStep: (...args: unknown[]) =>
		forward(mocks.createStep, args),
	generateMigrationSQL: (...args: unknown[]) => forward(mocks.generate, args),
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
vi.mock('./ledger.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('./ledger.js')>()),
	acquirePgLedgerSessionLock: (...args: unknown[]) => forward(mocks.lock, args),
	releasePgLedgerSessionLock: (...args: unknown[]) =>
		forward(mocks.unlock, args),
}));
vi.mock('./reinitialize-preflight.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('./reinitialize-preflight.js')>()),
	readPgLedgerScopeCurrency: (...args: unknown[]) =>
		forward(mocks.currency, args),
}));

import { convergePg, PgConvergeRefusalError } from './converge.js';

function emptyModel(): ModelIR {
	return {
		tables: new Map(),
		relations: new Map(),
		getTable: () => undefined,
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

function compareIntrospectedSchema(): void {
	mocks.compare.mockImplementation(
		async (
			adapter: { introspect: (options?: unknown) => Promise<ModelIR> },
			model: ModelIR,
		) => compareSchemata(model, await adapter.introspect({ schema: 'public' })),
	);
}

function client(): PoolClient {
	return {
		query: vi.fn(async (sql: string) => {
			if (sql === 'SHOW server_version_num')
				return { rows: [{ server_version_num: '150000' }] };
			if (sql === 'SELECT current_database() AS database_id')
				return { rows: [{ database_id: 'app' }] };
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

async function expectRefusal(input: Record<string, unknown>, refusal: string) {
	mocks.compare.mockResolvedValue({ changes: [input] });
	mocks.createStep.mockImplementation(
		({ change: value }: { change: Record<string, unknown> }) => stepFor(value),
	);
	await expect(convergePg(poolFor(), emptyModel())).rejects.toMatchObject({
		name: 'PgConvergeRefusalError',
		refusal,
	});
	expect(mocks.execute).not.toHaveBeenCalled();
}

afterEach(() => {
	for (const mock of Object.values(mocks)) {
		if ('mockReset' in mock) mock.mockReset();
	}
	mocks.generate.mockReturnValue(['CREATE TABLE "users" ()']);
	mocks.execute.mockResolvedValue({ outcome: 'completed' });
	mocks.lock.mockResolvedValue({ kind: 'acquired' });
	mocks.unlock.mockResolvedValue(true);
	mocks.currency.mockResolvedValue({ kind: 'current' });
	mocks.introspect.mockResolvedValue(emptyModel());
});

describe('convergePg refusal boundary', () => {
	it('does not compare an undeclared live sequence when the model declares none', async () => {
		mocks.introspect.mockResolvedValue(modelWithSequences(['live_sequence']));
		compareIntrospectedSchema();

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

	it('refuses a fresh single-column FK without a declared index before execution', async () => {
		mocks.compare.mockResolvedValue({
			changes: [createTableWithForeignKey('posts', ['author_id'])],
		});

		await expect(convergePg(poolFor(), emptyModel())).rejects.toMatchObject({
			refusal: 'unsupported-change',
			detail: expect.stringContaining('posts.author_id (idx_posts_author_id)'),
			changes: [
				expect.objectContaining({ kind: 'create_table', table: 'posts' }),
			],
		});
		expect(mocks.execute).not.toHaveBeenCalled();
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
			expect.objectContaining({ fkAutoIndex: false }),
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
		mocks.generate.mockImplementation((...args: unknown[]) =>
			generateMigrationSql(
				args[0] as Parameters<typeof generateMigrationSql>[0],
				args[1] as Parameters<typeof generateMigrationSql>[1],
			),
		);
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
			expect.objectContaining({ fkAutoIndex: false }),
		);
	});

	it('refuses a sequence whose declared name changes under snake_case before comparison', async () => {
		await expect(
			convergePg(poolFor(), modelWithSequences(['orderNumber']), {
				dbCasing: 'snake_case',
			}),
		).rejects.toMatchObject({
			refusal: 'unsupported-change',
			detail: expect.stringContaining('order_number'),
		});
		expect(mocks.compare).not.toHaveBeenCalled();
		expect(mocks.execute).not.toHaveBeenCalled();
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
			).rejects.toMatchObject({
				refusal: 'unsupported-change',
				detail: expect.stringContaining('order_number'),
			});
			expect(mocks.compare).not.toHaveBeenCalled();
		},
	);

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
	});

	it('ignores an undeclared live table while comparing declared physical names', async () => {
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
			include: ['user_profile'],
		});
	});

	it('excludes every live table for an empty declaration', async () => {
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
			include: [],
			exclude: ['*'],
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
						address: { kind: 'constraint', name: 'fk_left_table_right_id' },
						dependencyOrder: ['converge:1', 'converge:0'],
					},
					{
						address: { kind: 'constraint', name: 'fk_right_table_left_id' },
						dependencyOrder: ['converge:0', 'converge:1'],
					},
					{
						address: { kind: 'index', name: 'idx_left_table_id' },
						dependencyOrder: ['converge:1'],
					},
					{
						address: { kind: 'constraint', name: 'left_id_check' },
						dependencyOrder: ['converge:1'],
					},
				],
			},
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

	it('refuses a recovery-required executor outcome with its detail unchanged', async () => {
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
});
