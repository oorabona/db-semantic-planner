import { randomUUID } from 'node:crypto';
import {
	readPgCatalogueIdentity,
	readTransitionJournal,
} from '@dbsp/adapter-pgsql';
import {
	admitRecordedIdentity,
	declarationSetFromModel,
	type ModelIR,
	type TableIR,
} from '@dbsp/core';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { runApply } from '../../packages/cli/src/commands/apply.js';
import { runPlan } from '../../packages/cli/src/commands/plan.js';
import { describeWithE2eCapabilities } from './harness/index.js';
import { createSchema, dropSchema, getTestPool } from './testkit/index.js';

const schemaName = `managed_declarations_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
let runId: string | undefined;

function quoteIdent(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

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

function fixtureTable(): TableIR {
	return {
		name: 'users',
		columns: [{ name: 'id', type: 'integer', nullable: false }],
		foreignKeys: [],
		indexes: [],
		logicalIdentity: {
			id: 'out-of-band-logical-identity',
			carrier: { kind: 'postgresql-side-table', authenticated: false },
		},
		pseudoColumns: [],
		comment: 'out-of-band-comment',
		partition: { strategy: 'HASH', columns: ['id'] },
		rlsEnabled: true,
		policies: [{ name: 'out-of-band-policy', using: 'true' }],
	};
}

describeWithE2eCapabilities(
	[],
	'managed declarations and catalogue identities (SC-20…26)',
	() => {
		beforeAll(async () => createSchema(schemaName));

		afterEach(async () => {
			const pool = await getTestPool();
			if (runId) {
				await pool.query(
					'DELETE FROM dbsp_meta.dbsp_transition_authorization WHERE run_id = $1',
					[runId],
				);
				await pool.query(
					'DELETE FROM dbsp_meta.dbsp_transition_journal WHERE run_id = $1',
					[runId],
				);
				await pool.query(
					'DELETE FROM dbsp_meta.dbsp_transition_run_plan WHERE run_id = $1',
					[runId],
				);
				await pool.query(
					'DELETE FROM dbsp_meta.dbsp_transition_run WHERE run_id = $1',
					[runId],
				);
				runId = undefined;
			}
			await pool.query(
				`DROP TABLE IF EXISTS ${quoteIdent(schemaName)}.${quoteIdent('identity_left')} CASCADE`,
			);
			await pool.query(
				`DROP TABLE IF EXISTS ${quoteIdent(schemaName)}.${quoteIdent('identity_right')} CASCADE`,
			);
			await pool.query(
				`DROP TABLE IF EXISTS ${quoteIdent(schemaName)}.${quoteIdent('recreated')} CASCADE`,
			);
			await pool.query(
				`DROP TYPE IF EXISTS ${quoteIdent(schemaName)}.${quoteIdent('status')} CASCADE`,
			);
		});

		afterAll(async () => dropSchema(schemaName));

		it('SC-20: emits only the closed declarable fragments', () => {
			const declarations = declarationSetFromModel(
				{ ...emptyModel(), tables: new Map([['users', fixtureTable()]]) },
				{ engine: 'postgresql', database: 'e2e', schema: schemaName },
			);
			expect(
				declarations.declarations.map((item) => item.address.kind),
			).toEqual(['column', 'table']);
			expect(JSON.stringify(declarations)).not.toMatch(
				/out-of-band-(logical-identity|comment|policy)/u,
			);
		});

		it('SC-21 and SC-23: keeps same-named constraints distinct and records every PostgreSQL identity form', async () => {
			const pool = await getTestPool();
			await pool.query(
				`CREATE TABLE ${quoteIdent(schemaName)}.${quoteIdent('identity_left')} (id integer CONSTRAINT ${quoteIdent('same_check')} CHECK (id > 0))`,
			);
			await pool.query(
				`CREATE TABLE ${quoteIdent(schemaName)}.${quoteIdent('identity_right')} (id integer CONSTRAINT ${quoteIdent('same_check')} CHECK (id > 0))`,
			);
			await pool.query(
				`CREATE INDEX ${quoteIdent('identity_left_idx')} ON ${quoteIdent(schemaName)}.${quoteIdent('identity_left')} (id)`,
			);
			await pool.query(
				`CREATE SEQUENCE ${quoteIdent(schemaName)}.${quoteIdent('identity_seq')}`,
			);
			await pool.query(
				`CREATE TYPE ${quoteIdent(schemaName)}.${quoteIdent('identity_enum')} AS ENUM ('a')`,
			);

			const left = {
				engine: 'postgresql',
				database: 'e2e',
				schema: schemaName,
				kind: 'table',
				name: 'identity_left',
			} as const;
			const right = { ...left, name: 'identity_right' };
			const [
				leftConstraint,
				rightConstraint,
				column,
				index,
				sequence,
				enumeration,
				extension,
			] = await Promise.all([
				readPgCatalogueIdentity(pool, {
					...left,
					kind: 'constraint',
					name: 'same_check',
					parent: left,
				}),
				readPgCatalogueIdentity(pool, {
					...right,
					kind: 'constraint',
					name: 'same_check',
					parent: right,
				}),
				readPgCatalogueIdentity(pool, {
					...left,
					kind: 'column',
					name: 'id',
					parent: left,
				}),
				readPgCatalogueIdentity(pool, {
					...left,
					kind: 'index',
					name: 'identity_left_idx',
					parent: left,
				}),
				readPgCatalogueIdentity(pool, {
					...left,
					kind: 'sequence',
					name: 'identity_seq',
				}),
				readPgCatalogueIdentity(pool, {
					...left,
					kind: 'enum',
					name: 'identity_enum',
				}),
				readPgCatalogueIdentity(pool, {
					engine: 'postgresql',
					database: 'e2e',
					kind: 'extension',
					name: 'plpgsql',
				}),
			]);
			expect(leftConstraint?.catalogueIdentity).toMatchObject({
				engine: 'postgresql',
				format: 1,
				value: { oid: expect.any(String) },
			});
			expect(rightConstraint?.catalogueIdentity).toMatchObject({
				engine: 'postgresql',
				format: 1,
				value: { oid: expect.any(String) },
			});
			expect(leftConstraint?.catalogueIdentity).not.toEqual(
				rightConstraint?.catalogueIdentity,
			);
			expect(column?.catalogueIdentity).toMatchObject({
				engine: 'postgresql',
				format: 1,
				value: { parentOid: expect.any(String), name: 'id' },
			});
			for (const address of [index, sequence, enumeration, extension])
				expect(address?.catalogueIdentity).toMatchObject({
					engine: 'postgresql',
					format: 1,
					value: { oid: expect.any(String) },
				});
		});

		it('SC-24: refuses a same-name table recreated outside the recorded run', async () => {
			const pool = await getTestPool();
			const address = {
				engine: 'postgresql',
				database: 'e2e',
				schema: schemaName,
				kind: 'table',
				name: 'recreated',
			} as const;
			await pool.query(
				`CREATE TABLE ${quoteIdent(schemaName)}.${quoteIdent('recreated')} (id integer)`,
			);
			const recorded = await readPgCatalogueIdentity(pool, address);
			await pool.query(
				`DROP TABLE ${quoteIdent(schemaName)}.${quoteIdent('recreated')}`,
			);
			await pool.query(
				`CREATE TABLE ${quoteIdent(schemaName)}.${quoteIdent('recreated')} (id integer)`,
			);
			const live = await readPgCatalogueIdentity(pool, address);
			expect(recorded).toBeDefined();
			expect(live).toBeDefined();
			expect(admitRecordedIdentity(recorded!, live!)).toMatchObject({
				ok: false,
				detail: expect.stringContaining('identity drift'),
			});
		});

		it('SC-25: plan names a function-valued column default before connecting', async () => {
			const badModel: ModelIR = {
				...emptyModel(),
				tables: new Map([
					[
						'users',
						{
							...fixtureTable(),
							columns: [
								{
									name: 'createdAt',
									type: 'datetime' as const,
									nullable: false,
									default: () => 'now()',
								},
							],
						},
					],
				]),
			};
			await expect(
				runPlan(
					{ db: 'postgres://must-not-connect', schemaFile: 'not-read.ts' },
					{
						loadSchema: async () => ({
							model: badModel,
							definition: {},
							tableNames: ['users'],
						}),
					},
				),
			).rejects.toThrow(/schema\.tables\["users"\]\.columns\[0\]\.default/);
		});

		it('SC-22 and SC-26: persists a digest-covered declaration set and recorded apply reads no schema file', async () => {
			const pool = await getTestPool();
			await pool.query(
				`CREATE TYPE ${quoteIdent(schemaName)}.${quoteIdent('status')} AS ENUM ('active')`,
			);
			const planned = await runPlan(
				{
					db: 'postgres://testcontainer/not-used',
					schemaFile: 'only-read-during-plan.ts',
					schema: schemaName,
				},
				{
					createDbConnection: async () => ({
						pool,
						release: () => Promise.resolve(),
					}),
					loadSchema: async () => ({
						model: {
							...emptyModel(),
							enums: new Map([
								[
									'status',
									{
										name: 'status',
										schema: schemaName,
										values: ['active', 'pending'],
									},
								],
							]),
						},
						definition: {},
						tableNames: [],
					}),
				},
			);
			runId = planned.runId ?? undefined;
			expect(planned.plan?.declarations?.digest).toBeTruthy();
			expect(planned.planDigest).toBeTruthy();
			const stored = await readTransitionJournal(pool, planned.runId!);
			expect(stored.plan.declarations).toEqual(planned.plan?.declarations);
			expect(stored.run.planDigest).toBe(planned.planDigest);
			const applied = await runApply(
				planned.runId!,
				{
					db: 'postgres://testcontainer/not-used',
					planDigest: planned.planDigest!,
					...(planned.plan && planned.plan.assumptions.length > 0
						? {
								accept: planned.plan.assumptions.map(
									(assumption) => assumption.class,
								),
							}
						: {}),
				},
				pool,
			);
			expect(applied.outcome).toBe('completed');
		});
	},
);
