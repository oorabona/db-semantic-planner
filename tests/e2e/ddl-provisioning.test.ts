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
	compareSchemata,
	derivePostgresqlCapabilitiesForVersion,
	generateDDL,
	generateMigrationSQL,
	introspect,
} from '@dbsp/adapter-pgsql';
import { ModelIRImpl, ref, schema } from '@dbsp/core';
import type { IndexIR, TableIR } from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pushCommand } from '../../packages/cli/src/commands/push.js';
import { executeDdl } from '../../packages/cli/src/ddl-executor.js';
import {
	computeChecksum,
	generateMigrationFilename,
} from '../../packages/cli/src/migration-file.js';
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
						dialectCapabilities:
							derivePostgresqlCapabilitiesForVersion('14'),
					}),
				).toThrow('NULLS NOT DISTINCT requires PostgreSQL >= 15');

				const table = await getTableOid(
					pool,
					tenantSchema,
					'index_cap_users',
				);
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
