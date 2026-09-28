import { validateNormalizedManagedStepManifest } from '@dbsp/core';
import type { NormalizedManagedStep } from '@dbsp/types';
import { describe, expect, it, vi } from 'vitest';

const generator = vi.hoisted(() => ({
	comparePgsqlDatabaseSchema: vi.fn(),
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

vi.mock('../utils/db-utils.js', () => ({
	createDbConnection: generator.createDbConnection,
}));

vi.mock('../utils/schema-loader.js', () => ({
	loadSchema: generator.loadSchema,
}));

import {
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
