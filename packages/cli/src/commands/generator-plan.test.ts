import { validateNormalizedManagedStepManifest } from '@dbsp/core';
import type { NormalizedManagedStep } from '@dbsp/types';
import { describe, expect, it, vi } from 'vitest';

const generator = vi.hoisted(() => ({
	comparePgsqlDatabaseSchema: vi.fn(),
	comparePgsqlDeclaredAdoptionSchema: vi.fn(),
	createDbConnection: vi.fn(),
	createPgsqlAdapter: vi.fn(),
	generateMigrationSQL: vi.fn(),
	loadSchema: vi.fn(),
	readPgCatalogueIdentity: vi.fn(),
}));

vi.mock('@dbsp/adapter-pgsql', async (importOriginal) => ({
	...(await importOriginal<typeof import('@dbsp/adapter-pgsql')>()),
	comparePgsqlDatabaseSchema: generator.comparePgsqlDatabaseSchema,
	createPgsqlAdapter: generator.createPgsqlAdapter,
	generateMigrationSQL: generator.generateMigrationSQL,
	readPgCatalogueIdentity: generator.readPgCatalogueIdentity,
}));

vi.mock('@dbsp/adapter-pgsql/internal', async (importOriginal) => ({
	...(await importOriginal<typeof import('@dbsp/adapter-pgsql/internal')>()),
	comparePgsqlDeclaredAdoptionSchema:
		generator.comparePgsqlDeclaredAdoptionSchema,
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
		generator.createPgsqlAdapter.mockReturnValue({});
		generator.comparePgsqlDatabaseSchema.mockResolvedValue({
			changes: [],
			hasDestructive: false,
			summary: {
				tables: { added: 0, dropped: 0 },
				columns: { added: 0, dropped: 0, altered: 0 },
				indexes: { added: 0, dropped: 0 },
				constraints: { added: 0, dropped: 0, altered: 0 },
			},
		});
		generator.comparePgsqlDeclaredAdoptionSchema.mockResolvedValue({
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
		generator.createPgsqlAdapter.mockReturnValue({});
		generator.comparePgsqlDatabaseSchema.mockResolvedValue({
			changes: [],
			hasDestructive: false,
			summary: {
				tables: { added: 0, dropped: 0 },
				columns: { added: 0, dropped: 0, altered: 0 },
				indexes: { added: 0, dropped: 0 },
				constraints: { added: 0, dropped: 0, altered: 0 },
			},
		});
		generator.comparePgsqlDeclaredAdoptionSchema.mockResolvedValue({
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
		generator.createPgsqlAdapter.mockReturnValue({});
		generator.comparePgsqlDatabaseSchema.mockResolvedValue({
			changes: [],
			hasDestructive: false,
			summary: {
				tables: { added: 0, dropped: 0 },
				columns: { added: 0, dropped: 0, altered: 0 },
				indexes: { added: 0, dropped: 0 },
				constraints: { added: 0, dropped: 0, altered: 0 },
			},
		});
		generator.comparePgsqlDeclaredAdoptionSchema.mockResolvedValue({
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
