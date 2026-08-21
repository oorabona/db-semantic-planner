import { validateNormalizedManagedStepManifest } from '@dbsp/core';
import type { NormalizedManagedStep } from '@dbsp/types';
import { describe, expect, it, vi } from 'vitest';

const generator = vi.hoisted(() => ({
	comparePgsqlDatabaseSchema: vi.fn(),
	createDbConnection: vi.fn(),
	createPgsqlAdapter: vi.fn(),
	generateMigrationSQL: vi.fn(),
	loadSchema: vi.fn(),
}));

vi.mock('@dbsp/adapter-pgsql', async (importOriginal) => ({
	...(await importOriginal<typeof import('@dbsp/adapter-pgsql')>()),
	comparePgsqlDatabaseSchema: generator.comparePgsqlDatabaseSchema,
	createPgsqlAdapter: generator.createPgsqlAdapter,
	generateMigrationSQL: generator.generateMigrationSQL,
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
