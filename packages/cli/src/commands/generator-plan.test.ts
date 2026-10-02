import { validateNormalizedManagedStepManifest } from '@dbsp/core/internal';
import type { NormalizedManagedStep } from '@dbsp/types';
import { describe, expect, it, vi } from 'vitest';

const generator = vi.hoisted(() => ({
	comparePgDatabaseSchema: vi.fn(),
	comparePgDeclaredAdoptionSchema: vi.fn(),
	createDbConnection: vi.fn(),
	createPgAdapter: vi.fn(),
	generateMigrationSQL: vi.fn(),
	loadSchema: vi.fn(),
	readPgCatalogueIdentity: vi.fn(),
}));

vi.mock('@dbsp/adapter-pgsql', async (importOriginal) => ({
	...(await importOriginal<typeof import('@dbsp/adapter-pgsql')>()),
	comparePgDatabaseSchema: generator.comparePgDatabaseSchema,
	createPgAdapter: generator.createPgAdapter,
	generateMigrationSQL: generator.generateMigrationSQL,
	readPgCatalogueIdentity: generator.readPgCatalogueIdentity,
}));

vi.mock('@dbsp/adapter-pgsql/internal', async (importOriginal) => ({
	...(await importOriginal<typeof import('@dbsp/adapter-pgsql/internal')>()),
	comparePgDeclaredAdoptionSchema: generator.comparePgDeclaredAdoptionSchema,
}));

vi.mock('../utils/db-utils.js', () => ({
	createDbConnection: generator.createDbConnection,
}));

vi.mock('../utils/schema-loader.js', () => ({
	loadSchema: generator.loadSchema,
}));

import {
	decodeGeneratorPlanMaterial,
	type GeneratorDurablePlan,
	linearizeGeneratedManagedStepDependencies,
	persistedLifecycleDirectiveError,
	runGeneratorPlan,
} from './generator-plan.js';

function step(order: number, stepKey: string): NormalizedManagedStep {
	return {
		stepKey,
		order,
		segmentId: `segment-${order}`,
		dependencyOrder: [],
		address: {
			scope: 'schema',
			engine: 'postgresql',
			database: 'app',
			schema: 'tenant',
			kind: 'table',
			name: `table_${order}`,
		},
		claimKind: order === 1 ? 'retire-intent' : 'intent',
		plannedClaimKeys: [`claim-${order}`],
		statementBundle: { statements: [] },
		classification: order === 1 ? 'removal' : 'non-destructive',
		requiresVacancy: false,
		replayPolicy: order === 1 ? 'fresh-live-only' : 'recorded',
	};
}

describe('generated managed-step dependencies', () => {
	it('refuses declared sequence adoption before opening a connection or comparing', async () => {
		generator.loadSchema.mockResolvedValue({
			model: {
				tables: new Map(),
				sequences: new Map([
					['union_group_seq', { name: 'union_group_seq', adopt: true }],
				]),
			},
		});
		await expect(
			runGeneratorPlan({
				db: 'postgres://unused',
				schemaFile: 'schema.ts',
				dryRun: true,
			}),
		).rejects.toThrow(
			'sequence adoption is available through convergePg / dbsp migrate',
		);
		expect(generator.createDbConnection).not.toHaveBeenCalled();
		expect(generator.comparePgDatabaseSchema).not.toHaveBeenCalled();
	});

	it('refuses a replacement plan with an empty primary key before replacement-create material exists', async () => {
		const pool = {
			end: vi.fn(),
			query: vi.fn().mockResolvedValue({ rows: [{ database_id: 'app' }] }),
		};
		generator.loadSchema.mockResolvedValue({
			model: {
				tables: new Map([
					[
						'orders',
						{
							name: 'orders',
							replace: true,
							columns: [{ name: 'id', type: 'integer', nullable: false }],
							primaryKey: [],
							foreignKeys: [],
							indexes: [],
						},
					],
				]),
			},
		});
		generator.createDbConnection.mockResolvedValue({ pool });
		generator.createPgAdapter.mockReturnValue({});
		generator.comparePgDatabaseSchema.mockResolvedValue({
			changes: [],
			hasDestructive: false,
			summary: {
				tables: { added: 0, dropped: 0 },
				columns: { added: 0, dropped: 0, altered: 0 },
				indexes: { added: 0, dropped: 0 },
				constraints: { added: 0, dropped: 0, altered: 0 },
			},
		});
		generator.comparePgDeclaredAdoptionSchema.mockResolvedValue({
			changes: [],
		});
		generator.generateMigrationSQL.mockReturnValue([
			'CREATE TABLE "public"."orders" ("id" INTEGER)',
		]);

		await expect(
			runGeneratorPlan({
				db: 'postgres://unused',
				schemaFile: 'schema.ts',
				dryRun: true,
			}),
		).rejects.toThrow(
			'generator planning refuses create_table table.primaryKey: missing typed columns',
		);
		expect(pool.end).toHaveBeenCalledOnce();
	});

	it('refuses all referenced key removals before rendering or writing a manifest', async () => {
		const pool = {
			end: vi.fn(),
			query: vi.fn().mockResolvedValue({ rows: [{ database_id: 'app' }] }),
		};
		const conflicts = [
			{
				keyKind: 'unique_index',
				table: 'parents',
				keyColumns: ['external_id'],
				keyName: 'parents_external_id_unique',
				referencingTable: 'children',
				foreignKeyColumns: ['parent_external_id'],
			},
			{
				keyKind: 'primary_key',
				table: 'accounts',
				keyColumns: ['id'],
				referencingTable: 'invoices',
				foreignKeyColumns: ['account_id'],
			},
		];
		generator.loadSchema.mockResolvedValue({ model: { tables: new Map() } });
		generator.createDbConnection.mockResolvedValue({ pool });
		generator.createPgAdapter.mockReturnValue({});
		generator.comparePgDatabaseSchema.mockResolvedValue({
			changes: [
				{
					kind: 'drop_index',
					table: 'parents',
					destructive: true,
					details: '',
					meta: { referencedBy: [conflicts[0]] },
				},
				{
					kind: 'drop_primary_key',
					table: 'accounts',
					destructive: true,
					details: '',
					meta: { referencedBy: [conflicts[1]] },
				},
			],
			hasDestructive: true,
			summary: {
				tables: { added: 0, dropped: 0 },
				columns: { added: 0, dropped: 0, altered: 0 },
				indexes: { added: 0, dropped: 1 },
				constraints: { added: 0, dropped: 1, altered: 0 },
			},
		});
		generator.generateMigrationSQL.mockClear();

		await expect(
			runGeneratorPlan({
				db: 'postgres://unused',
				schemaFile: 'schema.ts',
				dryRun: false,
			}),
		).rejects.toMatchObject({
			name: 'ReferencedKeyRemovalError',
			conflicts,
		});
		expect(generator.generateMigrationSQL).not.toHaveBeenCalled();
		expect(pool.query).toHaveBeenCalledWith(
			'SELECT current_database() AS database_id',
		);
		expect(pool.end).toHaveBeenCalledOnce();
	});

	it('emits the a08db11d adoption step byte-for-byte', async () => {
		const pool = {
			end: vi.fn(),
			query: vi.fn().mockResolvedValue({ rows: [{ database_id: 'app' }] }),
		};
		const shape = {
			name: 'legacy_orders',
			adopt: true as const,
			columns: [
				{ name: 'id', type: 'integer', nullable: false },
				{ name: 'code', type: 'integer', nullable: false },
			],
			primaryKey: 'id',
			foreignKeys: [],
			indexes: [],
		};
		generator.loadSchema.mockResolvedValue({
			model: { tables: new Map([[shape.name, shape]]) },
		});
		generator.createDbConnection.mockResolvedValue({ pool });
		generator.createPgAdapter.mockReturnValue({});
		generator.comparePgDatabaseSchema.mockResolvedValue({
			changes: [],
			hasDestructive: false,
			summary: {
				tables: { added: 0, dropped: 0 },
				columns: { added: 0, dropped: 0, altered: 0 },
				indexes: { added: 0, dropped: 0 },
				constraints: { added: 0, dropped: 0, altered: 0 },
			},
		});
		generator.comparePgDeclaredAdoptionSchema.mockResolvedValue({
			changes: [],
		});
		generator.readPgCatalogueIdentity.mockResolvedValue({
			catalogueIdentity: {
				engine: 'postgresql',
				format: 1,
				value: { oid: '42' },
			},
		});

		const result = await runGeneratorPlan({
			db: 'postgres://unused',
			schemaFile: 'schema.ts',
			dryRun: true,
		});

		expect(result.plan?.steps).toEqual([
			{
				stepKey: 'generator:0:adoption',
				order: 0,
				segmentId: 'generator-segment-0',
				dependencyOrder: [],
				address: {
					scope: 'schema',
					engine: 'postgresql',
					database: 'app',
					schema: 'public',
					kind: 'table',
					name: 'legacy_orders',
				},
				claimKind: 'adopt-intent',
				plannedClaimKeys: ['generator:0:adoption:root'],
				statementBundle: { statements: [] },
				classification: 'non-destructive',
				requiresVacancy: false,
				selection: { kind: 'adoption', selector: 'table:legacy_orders' },
				expectedDeclaration: {
					value: {
						kind: 'table',
						name: 'legacy_orders',
						shape: {
							name: 'legacy_orders',
							adopt: true,
							columns: [
								{ name: 'id', type: 'integer', nullable: false },
								{ name: 'code', type: 'integer', nullable: false },
							],
							primaryKey: 'id',
							foreignKeys: [],
							indexes: [],
						},
					},
					digest:
						'59b6dac697de619f3bd777db71859ead244ec0a76b3bdb6a22a19ce601f0dd34',
				},
				expectedCatalogueIdentity: {
					engine: 'postgresql',
					format: 1,
					value: { oid: '42' },
				},
				lifecycle: {
					kind: 'adoption',
					shape: {
						name: 'legacy_orders',
						adopt: true,
						columns: [
							{ name: 'id', type: 'integer', nullable: false },
							{ name: 'code', type: 'integer', nullable: false },
						],
						primaryKey: 'id',
						foreignKeys: [],
						indexes: [],
					},
				},
				replayPolicy: 'recorded',
			},
		]);
		expect(pool.end).toHaveBeenCalledOnce();
	});

	it('persists non-preserve casing in digest-covered generator material', async () => {
		const pool = {
			end: vi.fn(),
			query: vi.fn().mockResolvedValue({ rows: [{ database_id: 'app' }] }),
		};
		const shape = {
			name: 'legacy_orders',
			adopt: true as const,
			columns: [{ name: 'orderCode', type: 'integer', nullable: false }],
			foreignKeys: [],
			indexes: [],
		};
		generator.createDbConnection.mockResolvedValue({ pool });
		generator.createPgAdapter.mockReturnValue({});
		generator.comparePgDatabaseSchema.mockResolvedValue({
			changes: [],
			hasDestructive: false,
			summary: {
				tables: { added: 0, dropped: 0 },
				columns: { added: 0, dropped: 0, altered: 0 },
				indexes: { added: 0, dropped: 0 },
				constraints: { added: 0, dropped: 0, altered: 0 },
			},
		});
		generator.comparePgDeclaredAdoptionSchema.mockResolvedValue({
			changes: [],
		});
		generator.readPgCatalogueIdentity.mockResolvedValue({
			catalogueIdentity: {
				engine: 'postgresql',
				format: 1,
				value: { oid: '42' },
			},
		});
		generator.loadSchema.mockResolvedValue({
			model: { tables: new Map([[shape.name, shape]]) },
			dbCasing: 'snake_case',
		});
		const snake = await runGeneratorPlan({
			db: 'postgres://unused',
			schemaFile: 'schema.ts',
			dryRun: true,
		});
		generator.loadSchema.mockResolvedValue({
			model: { tables: new Map([[shape.name, shape]]) },
		});
		const preserve = await runGeneratorPlan({
			db: 'postgres://unused',
			schemaFile: 'schema.ts',
			dryRun: true,
		});

		const snakeMaterial = (snake.plan as GeneratorDurablePlan).generator;
		const preserveMaterial = (preserve.plan as GeneratorDurablePlan).generator;
		expect(snakeMaterial).toMatchObject({ dbCasing: 'snake_case' });
		expect(preserveMaterial).not.toHaveProperty('dbCasing');
		expect(preserve.planDigest).toBe(
			'f2ad370f29b9a6d0f58aa9aa9d732d708406b175d9f0201c0f988ce5b0a65e61',
		);
		expect(snake.planDigest).not.toBe(preserve.planDigest);
	});

	it('orders generated changes by migration phase and keeps each SQL bundle with its change', async () => {
		const pool = {
			end: vi.fn(),
			query: vi.fn().mockResolvedValue({ rows: [{ database_id: 'app' }] }),
		};
		const child = {
			name: 'child',
			columns: [
				{ name: 'id', type: 'integer', nullable: false },
				{ name: 'parent_id', type: 'integer', nullable: false },
			],
			primaryKey: 'id',
			foreignKeys: [
				{
					columns: ['parent_id'],
					references: { table: 'parent', columns: ['id'] },
				},
			],
			indexes: [],
		};
		const parent = {
			name: 'parent',
			columns: [{ name: 'id', type: 'integer', nullable: false }],
			primaryKey: 'id',
			foreignKeys: [],
			indexes: [],
		};
		const self = {
			name: 'self_ref',
			columns: [
				{ name: 'id', type: 'integer', nullable: false },
				{ name: 'parent_id', type: 'integer', nullable: true },
			],
			primaryKey: 'id',
			foreignKeys: [
				{
					columns: ['parent_id'],
					references: { table: 'self_ref', columns: ['id'] },
				},
			],
			indexes: [{ name: 'self_ref_id_key', columns: ['id'], unique: true }],
		};
		generator.loadSchema.mockResolvedValue({
			model: {
				tables: new Map([
					[child.name, child],
					[parent.name, parent],
					[self.name, self],
				]),
			},
		});
		generator.createDbConnection.mockResolvedValue({ pool });
		generator.createPgAdapter.mockReturnValue({});
		generator.comparePgDatabaseSchema.mockResolvedValue({
			changes: [
				{
					kind: 'add_foreign_key',
					table: 'child',
					destructive: false,
					details: 'child foreign key',
					meta: {
						fk: {
							name: 'fk_child_parent_id',
							columns: ['parent_id'],
							references: { table: 'parent', columns: ['id'] },
						},
					},
				},
				{
					kind: 'create_index',
					table: 'self_ref',
					destructive: false,
					details: 'self unique index',
					meta: {
						index: {
							name: 'self_ref_id_key',
							columns: ['id'],
							unique: true,
						},
					},
				},
				{
					kind: 'add_foreign_key',
					table: 'self_ref',
					destructive: false,
					details: 'self foreign key',
					meta: {
						fk: {
							name: 'fk_self_ref_parent_id',
							columns: ['parent_id'],
							references: { table: 'self_ref', columns: ['id'] },
						},
					},
				},
				{
					kind: 'create_table',
					table: 'parent',
					destructive: false,
					details: 'create parent',
					meta: { table: parent },
				},
				{
					kind: 'create_table',
					table: 'child',
					destructive: false,
					details: 'create child',
					meta: { table: child },
				},
				{
					kind: 'create_table',
					table: 'self_ref',
					destructive: false,
					details: 'create self reference',
					meta: { table: self },
				},
				{
					kind: 'alter_foreign_key',
					table: 'self_ref',
					destructive: true,
					details: 'alter child foreign key',
					meta: {
						oldFk: {
							name: 'fk_self_ref_parent_id',
							columns: ['parent_id'],
							references: { table: 'legacy_self_ref', columns: ['id'] },
						},
						fk: {
							name: 'fk_self_ref_parent_id',
							columns: ['parent_id'],
							references: { table: 'self_ref', columns: ['id'] },
						},
					},
				},
			],
			hasDestructive: true,
			summary: {
				tables: { added: 3, dropped: 0 },
				columns: { added: 0, dropped: 0, altered: 0 },
				indexes: { added: 1, dropped: 0 },
				constraints: { added: 3, dropped: 0, altered: 1 },
			},
		});
		generator.generateMigrationSQL.mockImplementation((diff) => {
			const change = diff.changes[0];
			if (change.kind === 'alter_foreign_key')
				return ['ALTER FK DROP', 'ALTER FK ADD'];
			return [`SQL ${change.kind}:${change.table}`];
		});

		const result = await runGeneratorPlan({
			db: 'postgres://unused',
			schemaFile: 'schema.ts',
			dryRun: true,
		});
		const plan = result.plan as GeneratorDurablePlan;
		expect(plan.generator.changes.map((change) => change.kind)).toEqual([
			'create_table',
			'create_table',
			'create_table',
			'create_index',
			'add_foreign_key',
			'add_foreign_key',
			'alter_foreign_key',
		]);
		expect(plan.generator.changes.map((change) => change.statements)).toEqual([
			['SQL create_table:parent'],
			['SQL create_table:child'],
			['SQL create_table:self_ref'],
			['SQL create_index:self_ref'],
			['SQL add_foreign_key:child'],
			['SQL add_foreign_key:self_ref'],
			['ALTER FK DROP', 'ALTER FK ADD'],
		]);
		expect(plan.steps).toMatchObject([
			{
				address: { kind: 'table', name: 'parent' },
				statementBundle: {
					statements: [{ ordinal: 0, sql: 'SQL create_table:parent' }],
				},
				dependencyOrder: [],
			},
			{
				address: { kind: 'table', name: 'child' },
				statementBundle: {
					statements: [{ ordinal: 0, sql: 'SQL create_table:child' }],
				},
				dependencyOrder: ['generator:0'],
			},
			{
				address: { kind: 'table', name: 'self_ref' },
				statementBundle: {
					statements: [{ ordinal: 0, sql: 'SQL create_table:self_ref' }],
				},
				dependencyOrder: ['generator:1'],
			},
			{
				address: { kind: 'index', name: 'self_ref_id_key' },
				statementBundle: {
					statements: [{ ordinal: 0, sql: 'SQL create_index:self_ref' }],
				},
				dependencyOrder: ['generator:2'],
			},
			{
				address: { kind: 'constraint' },
				statementBundle: {
					statements: [{ ordinal: 0, sql: 'SQL add_foreign_key:child' }],
				},
				dependencyOrder: ['generator:3'],
			},
			{
				address: { kind: 'constraint' },
				statementBundle: {
					statements: [{ ordinal: 0, sql: 'SQL add_foreign_key:self_ref' }],
				},
				dependencyOrder: ['generator:4'],
			},
			{
				address: { kind: 'constraint' },
				statementBundle: { statements: [{ ordinal: 0, sql: 'ALTER FK DROP' }] },
				dependencyOrder: ['generator:5'],
			},
			{
				address: { kind: 'constraint' },
				statementBundle: { statements: [{ ordinal: 0, sql: 'ALTER FK ADD' }] },
				dependencyOrder: ['generator:6:alter-foreign-key-retire'],
			},
		]);
	});

	it('physicalizes declared adoption material under dbCasing while retaining its logical declaration', async () => {
		const pool = {
			end: vi.fn(),
			query: vi.fn().mockResolvedValue({ rows: [{ database_id: 'app' }] }),
		};
		const shape = {
			name: 'legacyOrders',
			adopt: true as const,
			columns: [{ name: 'id', type: 'integer', nullable: false }],
			primaryKey: 'id',
			foreignKeys: [],
			indexes: [],
		};
		generator.loadSchema.mockResolvedValue({
			model: { tables: new Map([[shape.name, shape]]) },
			dbCasing: 'snake_case',
		});
		generator.createDbConnection.mockResolvedValue({ pool });
		generator.createPgAdapter.mockReturnValue({});
		generator.comparePgDatabaseSchema.mockResolvedValue({
			changes: [],
			hasDestructive: false,
			summary: {
				tables: { added: 0, dropped: 0 },
				columns: { added: 0, dropped: 0, altered: 0 },
				indexes: { added: 0, dropped: 0 },
				constraints: { added: 0, dropped: 0, altered: 0 },
			},
		});
		generator.comparePgDeclaredAdoptionSchema.mockResolvedValue({
			changes: [],
		});
		generator.readPgCatalogueIdentity.mockResolvedValue({
			catalogueIdentity: {
				engine: 'postgresql',
				format: 1,
				value: { oid: '42' },
			},
		});

		const matched = await runGeneratorPlan({
			db: 'postgres://unused',
			schemaFile: 'schema.ts',
			dryRun: true,
		});
		const matchedPlan = matched.plan as GeneratorDurablePlan;
		expect(matchedPlan.generator.changes).toContainEqual(
			expect.objectContaining({ kind: 'adopt_table', table: 'legacy_orders' }),
		);
		expect(generator.readPgCatalogueIdentity).toHaveBeenLastCalledWith(pool, {
			engine: 'postgresql',
			database: 'app',
			schema: 'public',
			kind: 'table',
			name: 'legacy_orders',
		});
		expect(matchedPlan.steps[0]).toMatchObject({
			address: { name: 'legacy_orders' },
			selection: { selector: 'table:legacy_orders' },
			expectedDeclaration: { value: { shape: { name: 'legacyOrders' } } },
			lifecycle: { shape: { name: 'legacyOrders' } },
		});

		generator.comparePgDatabaseSchema.mockResolvedValue({
			changes: [],
			hasDestructive: false,
			summary: {
				tables: { added: 0, dropped: 0 },
				columns: { added: 0, dropped: 0, altered: 0 },
				indexes: { added: 0, dropped: 0 },
				constraints: { added: 0, dropped: 0, altered: 0 },
			},
		});
		generator.comparePgDeclaredAdoptionSchema.mockResolvedValue({
			changes: [{ kind: 'add_column' }],
		});
		generator.readPgCatalogueIdentity.mockClear();
		const mismatched = await runGeneratorPlan({
			db: 'postgres://unused',
			schemaFile: 'schema.ts',
			dryRun: true,
		});
		const mismatchPlan = mismatched.plan as GeneratorDurablePlan;
		expect(mismatchPlan.generator.changes).toEqual([
			expect.objectContaining({
				kind: 'adoption_refused',
				table: 'legacy_orders',
			}),
		]);
		expect(mismatchPlan.steps).toMatchObject([
			{
				address: { name: 'legacy_orders' },
				lifecycle: { kind: 'adoption-refused' },
			},
		]);
		expect(generator.readPgCatalogueIdentity).not.toHaveBeenCalled();
	});

	it('uses the declaration-scoped comparison as the sole adoption verdict', async () => {
		const pool = {
			end: vi.fn(),
			query: vi.fn().mockResolvedValue({ rows: [{ database_id: 'app' }] }),
		};
		const adopted = {
			name: 'legacy_orders',
			adopt: true as const,
			columns: [{ name: 'id', type: 'integer', nullable: false }],
			foreignKeys: [],
			indexes: [],
		};
		const unrelated = {
			name: 'unrelated',
			columns: [{ name: 'id', type: 'integer', nullable: false }],
			foreignKeys: [],
			indexes: [],
		};
		generator.loadSchema.mockResolvedValue({
			model: {
				tables: new Map([
					[adopted.name, adopted],
					[unrelated.name, unrelated],
				]),
			},
		});
		generator.createDbConnection.mockResolvedValue({ pool });
		generator.createPgAdapter.mockReturnValue({});
		generator.comparePgDatabaseSchema.mockResolvedValue({
			changes: [
				{
					kind: 'add_column',
					table: 'legacy_orders',
					column: 'missing',
					destructive: false,
					details: 'missing column',
					meta: {
						column: { name: 'missing', type: 'integer', nullable: true },
					},
				},
				{
					kind: 'add_column',
					table: 'unrelated',
					column: 'missing',
					destructive: false,
					details: 'missing column',
					meta: {
						column: { name: 'missing', type: 'integer', nullable: true },
					},
				},
			],
			hasDestructive: false,
			summary: {
				tables: { added: 0, dropped: 0 },
				columns: { added: 2, dropped: 0, altered: 0 },
				indexes: { added: 0, dropped: 0 },
				constraints: { added: 0, dropped: 0, altered: 0 },
			},
		});
		generator.comparePgDeclaredAdoptionSchema.mockResolvedValue({
			changes: [],
		});
		generator.generateMigrationSQL.mockReturnValue(['ALTER TABLE']);
		generator.readPgCatalogueIdentity.mockResolvedValue({
			catalogueIdentity: {
				engine: 'postgresql',
				format: 1,
				value: { oid: '42' },
			},
		});

		const admitted = await runGeneratorPlan({
			db: 'postgres://unused',
			schemaFile: 'schema.ts',
			dryRun: true,
		});
		const admittedChanges = (admitted.plan as GeneratorDurablePlan).generator
			.changes;
		expect(admittedChanges).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: 'adopt_table',
					table: 'legacy_orders',
				}),
				expect.objectContaining({ kind: 'add_column', table: 'unrelated' }),
			]),
		);
		expect(admittedChanges).not.toContainEqual(
			expect.objectContaining({ kind: 'add_column', table: 'legacy_orders' }),
		);

		generator.comparePgDatabaseSchema.mockResolvedValue({
			changes: [],
			hasDestructive: false,
			summary: {
				tables: { added: 0, dropped: 0 },
				columns: { added: 0, dropped: 0, altered: 0 },
				indexes: { added: 0, dropped: 0 },
				constraints: { added: 0, dropped: 0, altered: 0 },
			},
		});
		generator.comparePgDeclaredAdoptionSchema.mockResolvedValue({
			changes: [{ kind: 'add_column' }],
		});
		generator.readPgCatalogueIdentity.mockClear();

		const refused = await runGeneratorPlan({
			db: 'postgres://unused',
			schemaFile: 'schema.ts',
			dryRun: true,
		});
		const refusedChanges = (refused.plan as GeneratorDurablePlan).generator
			.changes;
		expect(refusedChanges).toEqual([
			expect.objectContaining({
				kind: 'adoption_refused',
				table: 'legacy_orders',
			}),
		]);
		expect(generator.readPgCatalogueIdentity).not.toHaveBeenCalled();
	});

	it('refuses replacement when dbCasing changes the physical table address', async () => {
		generator.createDbConnection.mockClear();
		generator.loadSchema.mockResolvedValue({
			model: {
				tables: new Map([
					[
						'legacyOrders',
						{
							name: 'legacyOrders',
							replace: true,
							columns: [],
							foreignKeys: [],
							indexes: [],
						},
					],
				]),
			},
			dbCasing: 'snake_case',
		});

		await expect(
			runGeneratorPlan({
				db: 'postgres://unused',
				schemaFile: 'schema.ts',
				dryRun: true,
			}),
		).rejects.toThrow(
			'generator planning refuses replacement legacyOrders: dbCasing addresses physical table legacy_orders',
		);
		expect(generator.createDbConnection).not.toHaveBeenCalled();
	});

	it('decodes omitted casing as preserve and refuses an invalid value', () => {
		expect(
			decodeGeneratorPlanMaterial({ kind: 'schema-differ-generator' }).dbCasing,
		).toBe('preserve');
		expect(() =>
			decodeGeneratorPlanMaterial({
				kind: 'schema-differ-generator',
				dbCasing: 'upper_case',
			}),
		).toThrow('invalid dbCasing');
	});

	it('SC-59/61 linearizes a replacement-bearing manifest using emitted step keys', () => {
		const manifest = linearizeGeneratedManagedStepDependencies([
			step(0, 'generator:0'),
			step(1, 'generator:1:replacement-retire'),
			step(2, 'generator:1:replacement-create'),
			step(3, 'generator:3'),
		]);

		expect(manifest.map((item) => item.dependencyOrder)).toEqual([
			[],
			['generator:0'],
			['generator:1:replacement-retire'],
			['generator:1:replacement-create'],
		]);
		// A successful validation now returns the opaque, normalized manifest that
		// the executor binds to the recorded digest; do not discard that authority.
		expect(validateNormalizedManagedStepManifest(manifest).ok).toBe(true);
	});

	it('refuses persisted manifests that combine lifecycle directives for one table', () => {
		const adoption = {
			...step(0, 'adoption'),
			selection: { kind: 'adoption' as const, selector: 'table:table_0' },
		};
		const readdress = {
			...step(1, 'readdress'),
			address: adoption.address!,
			selection: { kind: 'readdress' as const, selector: 'table:table_0' },
		};
		expect(persistedLifecycleDirectiveError([adoption, readdress])).toBe(
			'persisted lifecycle for table_0 cannot set adoption and readdress together',
		);
	});
});
