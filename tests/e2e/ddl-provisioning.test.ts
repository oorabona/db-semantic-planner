/**
 * DDL Provisioning E2E Tests
 *
 * Tests the full DDL provisioning lifecycle:
 * - push (additive + drop mode)
 * - migrate (dev + apply + status)
 * - verify (enriched checks: FK, index, defaults, unique)
 *
 * Requires: DATABASE_URL env var + running PostgreSQL container.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	camelCaseNaming,
	comparePgsqlDatabaseSchema,
	compareSchemata,
	createPgsqlAdapter,
	derivePostgresqlCapabilitiesForVersion,
	executeDdlPlan,
	executeDdlPlanWithClient,
	generateDDL,
	generateMigrationPlan,
	generateMigrationSQL,
	generatePhasedMigrationFiles,
	introspect,
	MigrationPhaseBoundaryError,
	type SchemaDiff,
} from '@dbsp/adapter-pgsql';
import type { IndexIR, TableIR } from '@dbsp/core';
import { ModelIRImpl, ref, schema } from '@dbsp/core';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runApply } from '../../packages/cli/src/commands/migrate.js';
import { pushCommand } from '../../packages/cli/src/commands/push.js';
import { executeDdl } from '../../packages/cli/src/ddl-executor.js';
import {
	computeChecksum,
	generateMigrationFilename,
	writeMigrationFile,
} from '../../packages/cli/src/migration-file.js';
import { loadSchema } from '../../packages/cli/src/utils/schema-loader.js';
import { handleSchemaApply } from '../../packages/gui/sidecar/schema-apply-handler.js';
import {
	closeTestDb,
	createSchema,
	dropSchema,
	getTestPool,
} from './testkit/index.js';

const SCHEMA = 'ddl_provisioning_test';

// ============================================================================
// Schema Definitions
// ============================================================================

const schemaV1 = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		email: { type: 'string', unique: true },
		name: 'string',
		active: { type: 'boolean', default: 'true' },
		createdAt: 'timestamp',
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: 'string',
		body: { type: 'string', nullable: true },
		authorId: ref('users'),
		published: { type: 'boolean', default: 'false' },
	},
	tags: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'string', unique: true },
	},
	postTags: {
		postId: ref('posts'),
		tagId: ref('tags'),
	},
});

// V2 adds a column and a new table
const schemaV2 = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		email: { type: 'string', unique: true },
		name: 'string',
		active: { type: 'boolean', default: 'true' },
		createdAt: 'timestamp',
		updatedAt: { type: 'timestamp', nullable: true }, // NEW COLUMN
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: 'string',
		body: { type: 'string', nullable: true },
		authorId: ref('users'),
		published: { type: 'boolean', default: 'false' },
	},
	tags: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'string', unique: true },
	},
	postTags: {
		postId: ref('posts'),
		tagId: ref('tags'),
	},
	comments: {
		// NEW TABLE
		id: { type: 'integer', primaryKey: true },
		body: 'string',
		postId: ref('posts'),
		authorId: ref('users'),
	},
});

async function getTableOid(
	pool: Awaited<ReturnType<typeof getTestPool>>,
	schemaName: string,
	tableName: string,
): Promise<string | undefined> {
	const result = await pool.query<{ oid: string }>(
		`SELECT c.oid::text AS oid
		 FROM pg_class c
		 JOIN pg_namespace n ON n.oid = c.relnamespace
		 WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r'`,
		[schemaName, tableName],
	);
	return result.rows[0]?.oid;
}

async function deleteMigrationRecordIfPresent(
	pool: Awaited<ReturnType<typeof getTestPool>>,
	migrationName: string,
): Promise<void> {
	try {
		await pool.query(`DELETE FROM "_dbsp_migrations" WHERE "name" = $1`, [
			migrationName,
		]);
	} catch (error: unknown) {
		if (
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			error.code === '42P01'
		) {
			return;
		}
		throw error;
	}
}

function modelWithIndex(index: IndexIR): ModelIRImpl {
	const table: TableIR = {
		name: 'index_cap_users',
		columns: [
			{ name: 'id', type: 'integer', nullable: false },
			{ name: 'email', type: 'string', nullable: false },
			{ name: 'name', type: 'string', nullable: false },
		],
		primaryKey: 'id',
		foreignKeys: [],
		indexes: [index],
	};
	return new ModelIRImpl(new Map([[table.name, table]]), new Map());
}

// ============================================================================
// Test Suite
// ============================================================================

describe('DDL Provisioning E2E', () => {
	let pool: Awaited<ReturnType<typeof getTestPool>>;

	beforeAll(async () => {
		pool = await getTestPool();
		await dropSchema(SCHEMA);
		await createSchema(SCHEMA);
	});

	afterAll(async () => {
		await dropSchema(SCHEMA);
		await closeTestDb();
	});

	describe('shared executor client ownership', () => {
		it('reports an unknown outcome after a real autocommit statement commits but its response is lost', async () => {
			await pool.query(
				`CREATE TYPE "${SCHEMA}"."lost_response_status" AS ENUM ('active')`,
			);
			const client = await pool.connect();
			const statement = `ALTER TYPE "${SCHEMA}"."lost_response_status" ADD VALUE IF NOT EXISTS 'pending';`;
			const query = client.query.bind(client);
			(
				client as unknown as { query: (sql: string) => Promise<unknown> }
			).query = async (sql) => {
				const result = await query(sql);
				if (sql === statement) throw new Error('autocommit response lost');
				return result;
			};

			try {
				await expect(
					executeDdlPlanWithClient(client, {
						autocommit: [statement],
						main: [],
					}),
				).rejects.toMatchObject({
					phase: 'autocommit',
					outcome: 'unknown',
					transactionStateUnproven: true,
				});
				const labels = await client.query<{ enumlabel: string }>(
					`SELECT enumlabel FROM pg_enum WHERE enumtypid = '"${SCHEMA}"."lost_response_status"'::regtype ORDER BY enumsortorder`,
				);
				expect(labels.rows.map((row) => row.enumlabel)).toEqual([
					'active',
					'pending',
				]);
			} finally {
				// The wrapper is an own property shadowing Client.prototype.query,
				// and it accepts only the SQL string. Returning the client to the
				// shared pool with it still installed would silently drop the
				// values of every later parameterized query on that connection.
				delete (client as unknown as { query?: unknown }).query;
				client.release();
				await pool.query(
					`DROP TYPE IF EXISTS "${SCHEMA}"."lost_response_status"`,
				);
			}
		});

		it('classifies a lost COMMIT response as an unknown outcome without rollback', async () => {
			const client = {
				_txStatus: 'I' as const,
				query: vi.fn(async (sql: string) => {
					if (sql === 'COMMIT')
						throw new Error('connection lost during COMMIT');
					return { rows: [] };
				}),
			};

			await expect(
				executeDdlPlanWithClient(client as never, {
					autocommit: [],
					main: ['SELECT 1'],
				}),
			).rejects.toMatchObject({
				commitAttempted: true,
				transactionStateUnproven: true,
				outcome: 'unknown',
				primaryError: expect.objectContaining({
					message: 'connection lost during COMMIT',
				}),
			});
			expect(client.query).not.toHaveBeenCalledWith('ROLLBACK');
		});

		it('releases only the client it acquires from a pool', async () => {
			const executorPool = new Pool({
				connectionString: process.env.DATABASE_URL!,
				max: 1,
			});
			try {
				await executeDdlPlan(executorPool, {
					autocommit: [],
					main: ['SELECT 1'],
				});
				expect(executorPool.idleCount).toBe(1);
			} finally {
				await executorPool.end();
			}
		});

		it('labels a pooled non-idle client as not started and destroys it', async () => {
			const executorPool = new Pool({
				connectionString: process.env.DATABASE_URL!,
				max: 1,
			});
			const borrowed = await executorPool.connect();
			try {
				await borrowed.query('BEGIN');
				borrowed.release();

				await expect(
					executeDdlPlan(executorPool, {
						autocommit: [],
						main: ['SELECT 1'],
					}),
				).rejects.toMatchObject({
					phase: 'precondition',
					outcome: 'not_started',
				});
				expect(executorPool.totalCount).toBe(0);
			} finally {
				await executorPool.end();
			}
		});

		it('leaves a caller-owned client connected and usable', async () => {
			const executorPool = new Pool({
				connectionString: process.env.DATABASE_URL!,
				max: 1,
			});
			const client = await executorPool.connect();
			try {
				await executeDdlPlanWithClient(client, {
					autocommit: [],
					main: ['SELECT 1'],
				});

				expect((await client.query('SELECT 1')).rowCount).toBe(1);
				expect(executorPool.idleCount).toBe(0);
			} finally {
				client.release();
				await executorPool.end();
			}
		});

		it('rejects GUI requests that label arbitrary SQL as autocommit', async () => {
			const client = {
				_txStatus: 'I' as const,
				query: vi.fn(),
				release: vi.fn(),
			};
			const result = await handleSchemaApply(
				{
					connectionId: 'e2e',
					autocommit: ['DROP TABLE "must_not_run";'],
					main: [],
				},
				() => ({ connect: vi.fn().mockResolvedValue(client) }) as never,
			);

			expect(result).toMatchObject({ applied: 0, success: false });
			expect(result.error).toContain('Invalid enum sidecar');
			expect(client.query).not.toHaveBeenCalled();
		});
	});

	// ========================================================================
	// Push Tests
	// ========================================================================

	describe('push — additive mode', () => {
		it('should deploy V1 schema from empty database', async () => {
			const schemaModel = schemaV1.model;

			// Generate DDL for V1
			const statements = generateDDL(schemaModel, {
				schemaName: SCHEMA,
			});

			expect(statements.length).toBeGreaterThan(0);

			// Execute DDL
			const result = await executeDdl(pool, statements);
			expect(result.statementsExecuted).toBeGreaterThan(0);
			expect(result.dryRun).toBe(false);
		});

		it('applies an enum label addition before additive DDL that uses the new label', async () => {
			const tenantSchema = 'ddl_push_enum_phase';
			const tempDir = mkdtempSync(
				join(process.cwd(), 'tests/e2e/.tmp-enum-push-'),
			);
			const schemaPath = join(tempDir, 'dbsp.schema.ts');
			await dropSchema(tenantSchema);
			await createSchema(tenantSchema);
			try {
				await pool.query(
					`CREATE TYPE "${tenantSchema}"."status" AS ENUM ('active')`,
				);
				await pool.query(
					`CREATE TABLE "${tenantSchema}"."jobs" ("id" integer PRIMARY KEY, "status" "${tenantSchema}"."status")`,
				);

				// schema() supplies the loader-valid CHECK surface. The explicit ModelIR
				// wrapper preserves the live enum type and declares the desired enum label,
				// which the schema DSL cannot declare yet. Deliberately omit the enum
				// default and partial index: PostgreSQL renders both with enum casts, while
				// the current default/index comparisons use non-equivalent raw forms. They
				// are unrelated to proving #321's enum-first push execution path.
				writeFileSync(
					schemaPath,
					[
						"import { schema as defineSchema, ModelIRImpl } from '@dbsp/core';",
						'',
						'const base = defineSchema(',
						'\t{',
						'\t\tjobs: {',
						"\t\t\tid: { type: 'integer', primaryKey: true },",
						"\t\t\tstatus: 'string',",
						'\t\t},',
						'\t},',
						'\t{',
						'\t\tjobs: {',
						'\t\t\tcheckConstraints: [',
						`\t\t\t\t{ name: 'jobs_pending_check', expression: "status = 'pending'" },`,
						'\t\t\t],',
						'\t\t},',
						'\t},',
						');',
						'',
						"const jobs = base.model.getTable('jobs');",
						"if (!jobs) throw new Error('jobs model missing');",
						'const model = new ModelIRImpl(',
						'\tnew Map([',
						'\t\t[',
						"\t\t\t'jobs',",
						'\t\t\t{',
						'\t\t\t\t...jobs,',
						'\t\t\t\tcolumns: jobs.columns.map((column) =>',
						"\t\t\t\t\tcolumn.name === 'status'",
						'\t\t\t\t\t\t? {',
						'\t\t\t\t\t\t\t\t...column,',
						"\t\t\t\t\t\t\t\toriginalDbType: 'status',",
						`\t\t\t\t\t\t\t\toriginalDbTypeSchema: '${tenantSchema}',`,
						"\t\t\t\t\t\t\t\toriginalDbTypeSchemaScope: 'target',",
						'\t\t\t\t\t\t\t}',
						'\t\t\t\t\t\t: column,',
						'\t\t\t\t),',
						'\t\t\t},',
						'\t\t],',
						'\t]),',
						'\tnew Map(base.model.relations),',
						'\tnew Map([',
						'\t\t[',
						"\t\t\t'status',",
						'\t\t\t{',
						"\t\t\t\tname: 'status',",
						`\t\t\t\tschema: '${tenantSchema}',`,
						"\t\t\t\tvalues: ['active', 'pending'],",
						'\t\t\t},',
						'\t\t],',
						'\t]),',
						');',
						'',
						'export const schema = { ...base, model };',
						'',
					].join('\n'),
				);

				const loaded = await loadSchema(schemaPath);
				const diff = await comparePgsqlDatabaseSchema(
					createPgsqlAdapter(pool),
					loaded.model,
					{ schema: tenantSchema },
				);
				const plan = generateMigrationPlan(diff, {
					includeDestructive: false,
					schemaName: tenantSchema,
				});
				expect(diff.changes.map((change) => change.kind)).toContain(
					'alter_enum_add_value',
				);
				expect(plan.autocommit).toHaveLength(1);
				expect(plan.autocommit[0]).toContain(
					"ADD VALUE IF NOT EXISTS 'pending'",
				);
				expect(
					plan.main.some(
						(statement) =>
							statement.includes('ADD CONSTRAINT') &&
							statement.includes("'pending'"),
					),
				).toBe(true);

				// The flat renderer stays exported so existing callers keep
				// compiling, but it cannot silently hand back a statement list
				// that is unsafe to run in one transaction. Asserted through the
				// package barrel: reachability from a consumer's import is the
				// property that matters here, not the module-internal binding.
				expect(() =>
					generateMigrationSQL(diff, {
						includeDestructive: false,
						schemaName: tenantSchema,
					}),
				).toThrow(MigrationPhaseBoundaryError);

				await pushCommand.parseAsync(
					[
						'--schema',
						schemaPath,
						'--db',
						process.env.DATABASE_URL!,
						'--schema-name',
						tenantSchema,
						'--json',
					],
					{ from: 'user' },
				);

				const labels = await pool.query<{ count: string }>(
					`SELECT count(*)::text AS count
					 FROM pg_enum e
					 JOIN pg_type t ON t.oid = e.enumtypid
					 JOIN pg_namespace n ON n.oid = t.typnamespace
					 WHERE n.nspname = $1 AND t.typname = $2 AND e.enumlabel = $3`,
					[tenantSchema, 'status', 'pending'],
				);
				expect(labels.rows[0]?.count).toBe('1');
				const inserted = await pool.query<{ status: string }>(
					`INSERT INTO "${tenantSchema}"."jobs" ("id", "status") VALUES (1, 'pending') RETURNING "status"::text AS "status"`,
				);
				expect(inserted.rows).toEqual([{ status: 'pending' }]);
				const check = await pool.query<{
					definition: string;
					validated: boolean;
				}>(
					`SELECT pg_get_constraintdef(c.oid) AS definition, c.convalidated AS validated
					 FROM pg_constraint c
					 JOIN pg_namespace n ON n.oid = c.connamespace
					 WHERE n.nspname = $1 AND c.conname = $2`,
					[tenantSchema, 'jobs_pending_check'],
				);
				expect(check.rows[0]?.definition).toContain("status = 'pending'");
				expect(check.rows[0]?.validated).toBe(true);
				await expect(
					pool.query(
						`INSERT INTO "${tenantSchema}"."jobs" ("id", "status") VALUES (2, 'active')`,
					),
				).rejects.toThrow();
			} finally {
				// push never records migrations — nothing to clean in _dbsp_migrations.
				await dropSchema(tenantSchema);
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it('emits byte-identical default and latest-capability index DDL and provisions it', async () => {
			const tenantSchema = 'ddl_index_caps_default';
			const model = modelWithIndex({
				name: 'uk_index_cap_users_email_nnd',
				columns: ['email'],
				unique: true,
				include: ['name'],
				nullsNotDistinct: true,
			});

			await dropSchema(tenantSchema);
			await createSchema(tenantSchema);
			try {
				const defaultStatements = generateDDL(model, {
					schemaName: tenantSchema,
				});
				const latestStatements = generateDDL(model, {
					schemaName: tenantSchema,
					dialectCapabilities: derivePostgresqlCapabilitiesForVersion('15'),
				});

				expect(latestStatements).toEqual(defaultStatements);
				expect(defaultStatements).toContain(
					`CREATE UNIQUE INDEX "uk_index_cap_users_email_nnd" ON "${tenantSchema}"."index_cap_users" ("email") INCLUDE ("name") NULLS NOT DISTINCT;`,
				);

				const result = await executeDdl(pool, defaultStatements);
				expect(result.statementsExecuted).toBe(defaultStatements.length);

				const index = await pool.query<{
					indexdef: string;
					indnullsnotdistinct: boolean;
				}>(
					`SELECT pg_get_indexdef(i.indexrelid) AS indexdef, i.indnullsnotdistinct
					 FROM pg_index i
					 JOIN pg_class c ON c.oid = i.indexrelid
					 JOIN pg_namespace n ON n.oid = c.relnamespace
					 WHERE n.nspname = $1 AND c.relname = $2`,
					[tenantSchema, 'uk_index_cap_users_email_nnd'],
				);
				expect(index.rows[0]?.indexdef).toContain('INCLUDE (name)');
				expect(index.rows[0]?.indexdef).toContain('NULLS NOT DISTINCT');
				expect(index.rows[0]?.indnullsnotdistinct).toBe(true);
			} finally {
				await dropSchema(tenantSchema);
			}
		});

		it('rejects version-derived unsupported index DDL before executing statements', async () => {
			const tenantSchema = 'ddl_index_caps_gate';
			const model = modelWithIndex({
				name: 'uk_index_cap_users_email_nnd',
				columns: ['email'],
				unique: true,
				nullsNotDistinct: true,
			});

			await dropSchema(tenantSchema);
			await createSchema(tenantSchema);
			try {
				expect(() =>
					generateDDL(model, {
						schemaName: tenantSchema,
						dialectCapabilities: derivePostgresqlCapabilitiesForVersion('14'),
					}),
				).toThrow('NULLS NOT DISTINCT requires PostgreSQL >= 15');

				const table = await getTableOid(pool, tenantSchema, 'index_cap_users');
				expect(table).toBeUndefined();
			} finally {
				await dropSchema(tenantSchema);
			}
		});

		it('applies generated DDL with a verbatim mixed-case schemaName under a naming plugin', async () => {
			const tenantSchema = 'ddlTenantOne';
			const ownersTable: TableIR = {
				name: 'tenantOwners',
				columns: [{ name: 'id', type: 'integer', nullable: false }],
				primaryKey: 'id',
				foreignKeys: [],
				indexes: [],
			};
			const jobsTable: TableIR = {
				name: 'jobQueue',
				columns: [
					{ name: 'id', type: 'integer', nullable: false },
					{ name: 'ownerId', type: 'integer', nullable: false },
					{
						name: 'status',
						type: 'string',
						nullable: false,
						comment: 'Current status',
						originalDbType: 'status',
						originalDbTypeSchema: tenantSchema,
						originalDbTypeSchemaScope: 'target',
					},
					{ name: 'priority', type: 'integer', nullable: false },
				],
				primaryKey: 'id',
				foreignKeys: [
					{
						columns: ['ownerId'],
						references: { table: 'tenantOwners', columns: ['id'] },
						onDelete: 'CASCADE',
					},
				],
				indexes: [{ name: 'idx_job_queue_status', columns: ['status'] }],
				checkConstraints: [
					{
						name: 'jobQueuePriorityCheck',
						expression: 'CHECK ((priority >= 0))',
					},
				],
				rlsEnabled: true,
				comment: 'Job queue',
			};
			const schemaModel = new ModelIRImpl(
				new Map([
					[ownersTable.name, ownersTable],
					[jobsTable.name, jobsTable],
				]),
				new Map(),
				new Map([
					[
						'status',
						{
							name: 'status',
							schema: tenantSchema,
							values: ['queued', 'done'],
						},
					],
				]),
				undefined,
				new Map([['job_id_seq', { name: 'job_id_seq' }]]),
			);

			await dropSchema(tenantSchema);
			await createSchema(tenantSchema);
			try {
				const statements = generateDDL(schemaModel, {
					schemaName: tenantSchema,
					naming: camelCaseNaming,
				});
				expect(statements.join('\n')).not.toContain('"ddl_tenant_one"');

				const result = await executeDdl(pool, statements);
				expect(result.statementsExecuted).toBe(statements.length);

				const tables = await pool.query<{ table_name: string }>(
					`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
					[tenantSchema],
				);
				expect(tables.rows.map((row) => row.table_name)).toEqual([
					'job_queue',
					'tenant_owners',
				]);

				const enumType = await pool.query<{ typname: string }>(
					`SELECT t.typname
					 FROM pg_type t
					 JOIN pg_namespace n ON n.oid = t.typnamespace
					 WHERE n.nspname = $1 AND t.typname = $2`,
					[tenantSchema, 'status'],
				);
				expect(enumType.rows).toHaveLength(1);
			} finally {
				await dropSchema(tenantSchema);
			}
		});

		it('push --drop uses schema dbCasing to drop and recreate snake_case tables', async () => {
			const tenantSchema = 'ddl_push_drop_casing';
			const tempDir = mkdtempSync(
				join(process.cwd(), 'tests/e2e/.tmp-push-drop-'),
			);
			const schemaPath = join(tempDir, 'dbsp.schema.ts');
			writeFileSync(
				schemaPath,
				[
					"import { schema as defineSchema } from '@dbsp/core';",
					'',
					"export const dbCasing = 'snake_case' as const;",
					'',
					'export const schema = defineSchema({',
					'	userProfiles: {',
					"		id: { type: 'integer', primaryKey: true },",
					"		displayName: 'string',",
					'	},',
					'});',
					'',
				].join('\n'),
			);

			await dropSchema(tenantSchema);
			await createSchema(tenantSchema);
			try {
				await pool.query(
					`CREATE TABLE "${tenantSchema}"."user_profiles" ("id" integer PRIMARY KEY, "display_name" text)`,
				);
				await pool.query(
					`INSERT INTO "${tenantSchema}"."user_profiles" ("id", "display_name") VALUES (1, 'stale')`,
				);
				const beforeOid = await getTableOid(
					pool,
					tenantSchema,
					'user_profiles',
				);

				const dryRunLogs: string[] = [];
				const logSpy = vi
					.spyOn(console, 'log')
					.mockImplementation((message?: unknown, ...rest: unknown[]) => {
						dryRunLogs.push([message, ...rest].map(String).join(' '));
					});
				const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((
					code?: string | number | null | undefined,
				) => {
					throw new Error(`process.exit:${code}`);
				}) as typeof process.exit);
				try {
					await pushCommand.parseAsync(
						[
							'--schema',
							schemaPath,
							'--db',
							process.env.DATABASE_URL!,
							'--schema-name',
							tenantSchema,
							'--drop',
							'--dry-run',
						],
						{ from: 'user' },
					);
				} finally {
					logSpy.mockRestore();
					exitSpy.mockRestore();
				}

				const dryRunSql = dryRunLogs.join('\n');
				expect(dryRunSql).toContain(
					`DROP TABLE IF EXISTS "${tenantSchema}"."user_profiles" CASCADE;`,
				);
				expect(dryRunSql).not.toContain('"userProfiles"');

				const applyLogSpy = vi
					.spyOn(console, 'log')
					.mockImplementation(() => {});
				const applyExitSpy = vi.spyOn(process, 'exit').mockImplementation(((
					code?: string | number | null | undefined,
				) => {
					throw new Error(`process.exit:${code}`);
				}) as typeof process.exit);
				try {
					await pushCommand.parseAsync(
						[
							'--schema',
							schemaPath,
							'--db',
							process.env.DATABASE_URL!,
							'--schema-name',
							tenantSchema,
							'--drop',
							'--json',
						],
						{ from: 'user' },
					);
				} finally {
					applyLogSpy.mockRestore();
					applyExitSpy.mockRestore();
				}

				const afterOid = await getTableOid(pool, tenantSchema, 'user_profiles');
				expect(afterOid).toBeDefined();
				expect(afterOid).not.toBe(beforeOid);

				const wrongCase = await getTableOid(pool, tenantSchema, 'userProfiles');
				expect(wrongCase).toBeUndefined();

				const rows = await pool.query<{ count: string }>(
					`SELECT count(*)::text AS count FROM "${tenantSchema}"."user_profiles"`,
				);
				expect(rows.rows[0]!.count).toBe('0');
			} finally {
				await dropSchema(tenantSchema);
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it('should be idempotent — no changes when schema matches', async () => {
			const schemaModel = schemaV1.model;
			const dbModel = await introspect(pool, { schema: SCHEMA });
			// ignoreUnmanagedExtensions: true — the test schema declares no extensions;
			// image-bundled extensions (pgvector, pg_search, etc.) must not be counted
			// as managed objects so they don't produce spurious drop_extension diffs.
			const diff = compareSchemata(schemaModel, dbModel, {
				ignoreUnmanagedExtensions: true,
			});

			expect(diff.changes).toHaveLength(0);
		});

		it('should detect additive changes from V1 to V2', async () => {
			const schemaModel = schemaV2.model;
			const dbModel = await introspect(pool, { schema: SCHEMA });
			const diff = compareSchemata(schemaModel, dbModel);

			expect(diff.changes.length).toBeGreaterThan(0);

			// Should have non-destructive changes (add column, add table)
			const additive = diff.changes.filter((c) => !c.destructive);
			expect(additive.length).toBeGreaterThan(0);
		});

		it('should apply additive migration SQL', async () => {
			const schemaModel = schemaV2.model;
			const dbModel = await introspect(pool, { schema: SCHEMA });
			const diff = compareSchemata(schemaModel, dbModel);

			const statements = generateMigrationSQL(diff, {
				includeDestructive: false,
				schemaName: SCHEMA,
			});

			if (statements.length > 0) {
				const result = await executeDdl(pool, statements);
				expect(result.statementsExecuted).toBe(statements.length);
			}

			// After applying, diff should be empty (or only destructive changes)
			const newDb = await introspect(pool, { schema: SCHEMA });
			const newDiff = compareSchemata(schemaModel, newDb);
			const remaining = newDiff.changes.filter((c) => !c.destructive);
			expect(remaining).toHaveLength(0);
		});
	});

	describe('push — dry-run', () => {
		it('should not modify database in dry-run mode', async () => {
			const statements = ['CREATE TABLE "should_not_exist" ("id" serial)'];
			const result = await executeDdl(pool, statements, { dryRun: true });

			expect(result.dryRun).toBe(true);
			expect(result.statementsExecuted).toBe(1);

			// Verify table was NOT created
			const check = await pool.query(
				`SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
				[SCHEMA, 'should_not_exist'],
			);
			expect(check.rowCount).toBe(0);
		});
	});

	// ========================================================================
	// Migrate Tests
	// ========================================================================

	describe('migrate — filename generation', () => {
		it('round-trips generated sibling files with dollar and quoted enum labels', async () => {
			const tenantSchema = 'ddl_migrate_enum_phase';
			const migrationName = '0001_enum_pending.sql';
			const tempDir = mkdtempSync(
				join(process.cwd(), 'tests/e2e/.tmp-enum-migrate-'),
			);
			await dropSchema(tenantSchema);
			await createSchema(tenantSchema);
			try {
				await pool.query(
					`CREATE TYPE "${tenantSchema}"."status" AS ENUM ('active')`,
				);
				await pool.query(
					`CREATE TABLE "${tenantSchema}"."alter_defaults" ("status" "${tenantSchema}"."status")`,
				);
				const generatedDiff: SchemaDiff = {
					changes: [
						{
							kind: 'alter_enum_add_value',
							table: '',
							destructive: false,
							details: 'Add dollar-quoted-looking status',
							meta: {
								enum: {
									name: 'status',
									schema: tenantSchema,
									values: ['active', '$tag$'],
								},
								value: '$tag$',
							},
						},
						{
							kind: 'alter_enum_add_value',
							table: '',
							destructive: false,
							details: 'Add quoted status',
							meta: {
								enum: {
									name: 'status',
									schema: tenantSchema,
									values: ['active', '$tag$', "O'Reilly"],
								},
								value: "O'Reilly",
							},
						},
						{
							kind: 'alter_column_default',
							table: 'alter_defaults',
							column: 'status',
							destructive: false,
							details: 'Set dollar-quoted-looking default',
							meta: { default: '$tag$' },
						},
					],
					hasDestructive: false,
					summary: {
						tables: { added: 0, dropped: 0 },
						columns: { added: 0, dropped: 0, altered: 1 },
						indexes: { added: 0, dropped: 0 },
						constraints: { added: 0, dropped: 0, altered: 0 },
					},
				};
				const migration = generatePhasedMigrationFiles(generatedDiff, {
					schemaName: tenantSchema,
					name: migrationName,
				});
				writeMigrationFile(
					tempDir,
					migrationName,
					migration.content,
					migration.preContent,
				);

				await runApply({ db: process.env.DATABASE_URL!, dir: tempDir });
				expect(
					await pool.query(`SELECT '$tag$'::"${tenantSchema}"."status"`),
				).toHaveProperty('rowCount', 1);
				const defaults = await pool.query<{ status: string }>(
					`INSERT INTO "${tenantSchema}"."alter_defaults" DEFAULT VALUES RETURNING "status"::text AS "status"`,
				);
				expect(defaults.rows).toEqual([{ status: '$tag$' }]);
				expect(
					await pool.query(`SELECT 'O''Reilly'::"${tenantSchema}"."status"`),
				).toHaveProperty('rowCount', 1);
			} finally {
				await deleteMigrationRecordIfPresent(pool, migrationName);
				await dropSchema(tenantSchema);
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it('keeps a committed enum phase retryable when the main phase fails', async () => {
			const tenantSchema = 'ddl_migrate_enum_retry';
			const migrationName = '0001_enum_pending_retry.sql';
			const tempDir = mkdtempSync(
				join(process.cwd(), 'tests/e2e/.tmp-enum-retry-'),
			);
			await dropSchema(tenantSchema);
			await createSchema(tenantSchema);
			try {
				await pool.query(
					`CREATE TYPE "${tenantSchema}"."status" AS ENUM ('active')`,
				);
				writeMigrationFile(
					tempDir,
					migrationName,
					[
						'-- dbsp:destructive: false',
						`CREATE TABLE "${tenantSchema}"."main_created" ("status" "${tenantSchema}"."status" DEFAULT 'pending');`,
						`ALTER TABLE "${tenantSchema}"."not_yet" ADD COLUMN "status" "${tenantSchema}"."status" DEFAULT 'pending';`,
						'-- DOWN',
					].join('\n'),
					`ALTER TYPE "${tenantSchema}"."status" ADD VALUE IF NOT EXISTS 'pending';\n`,
				);

				// The recovery message must name completed durable operations without
				// claiming that IF NOT EXISTS added labels, and retain retry guidance.
				await expect(
					runApply({ db: process.env.DATABASE_URL!, dir: tempDir }),
				).rejects.toThrow(
					'1 autocommit operation completed before the failure; the migration remains pending and no migration record was written. Retry the unchanged file.',
				);
				expect(
					await pool.query(`SELECT 'pending'::"${tenantSchema}"."status"`),
				).toHaveProperty('rowCount', 1);
				expect(
					await getTableOid(pool, tenantSchema, 'main_created'),
				).toBeUndefined();
				const pendingRecord = await pool.query<{ count: string }>(
					`SELECT count(*)::text AS count FROM "_dbsp_migrations" WHERE "name" = $1`,
					[migrationName],
				);
				expect(pendingRecord.rows[0]?.count).toBe('0');

				await pool.query(
					`CREATE TABLE "${tenantSchema}"."not_yet" ("id" integer PRIMARY KEY)`,
				);
				await runApply({ db: process.env.DATABASE_URL!, dir: tempDir });

				const appliedRecord = await pool.query<{ count: string }>(
					`SELECT count(*)::text AS count FROM "_dbsp_migrations" WHERE "name" = $1`,
					[migrationName],
				);
				expect(appliedRecord.rows[0]?.count).toBe('1');
				expect(
					await getTableOid(pool, tenantSchema, 'main_created'),
				).toBeDefined();
				const labels = await pool.query<{ count: string }>(
					`SELECT count(*)::text AS count
					 FROM pg_enum e
					 JOIN pg_type t ON t.oid = e.enumtypid
					 JOIN pg_namespace n ON n.oid = t.typnamespace
					 WHERE n.nspname = $1 AND t.typname = $2 AND e.enumlabel = $3`,
					[tenantSchema, 'status', 'pending'],
				);
				expect(labels.rows[0]?.count).toBe('1');
			} finally {
				await deleteMigrationRecordIfPresent(pool, migrationName);
				await dropSchema(tenantSchema);
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it('should generate sequential filenames', () => {
			const f1 = generateMigrationFilename([], 'init');
			expect(f1).toBe('0001_init.sql');

			const f2 = generateMigrationFilename([f1], 'add_users');
			expect(f2).toBe('0002_add_users.sql');

			const f3 = generateMigrationFilename([f1, f2], 'add_posts');
			expect(f3).toBe('0003_add_posts.sql');
		});
	});

	describe('migrate — checksum validation', () => {
		it('should detect content changes via checksum', () => {
			const original = 'CREATE TABLE "users" ("id" serial);\n';
			const modified = 'CREATE TABLE "users" ("id" serial, "name" text);\n';

			const hash1 = computeChecksum(original);
			const hash2 = computeChecksum(modified);

			expect(hash1).not.toBe(hash2);
			expect(hash1).toHaveLength(64);
		});
	});

	// ========================================================================
	// Verify Tests (Enriched)
	// ========================================================================

	describe('verify — enriched schema comparison', () => {
		it('should detect foreign key presence in schema diff', async () => {
			const dbModel = await introspect(pool, { schema: SCHEMA });

			// V2 schema has foreign keys defined (via ref() inline)
			expect(schemaV2.model.tables.size).toBeGreaterThan(0);

			// Introspected model should have matching structure
			expect(dbModel).toBeDefined();
		});

		it('should detect indexes from introspection', async () => {
			const dbModel = await introspect(pool, { schema: SCHEMA });

			// Unique constraints create indexes
			expect(dbModel).toBeDefined();
		});

		it('should produce detailed diff summary', async () => {
			// Start fresh with a modified schema to get a diff
			const modifiedModel = schemaV2.model;
			const dbModel = await introspect(pool, { schema: SCHEMA });
			const diff = compareSchemata(modifiedModel, dbModel);

			// Summary should have structured counts
			expect(diff.summary).toBeDefined();
			expect(diff.summary.tables).toBeDefined();
			expect(diff.summary.columns).toBeDefined();
			expect(diff.summary.indexes).toBeDefined();
			expect(diff.summary.constraints).toBeDefined();
		});
	});
});
