/**
 * #315 - PostgreSQL canonical CHECK expressions converge in live diffs.
 *
 * These tests require the e2e PostgreSQL database and are intentionally not run
 * by the agent verification command for this change.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	CheckConstraintNewEnumValueError,
	comparePgsqlDatabaseSchema,
	createPgsqlAdapter,
	generateDDL,
	generateMigrationSQL,
} from '@dbsp/adapter-pgsql';
import { ModelIRImpl, schema } from '@dbsp/core';
import type { ColumnIR, TableIR } from '@dbsp/types';
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import { verifyCommand } from '../../packages/cli/src/commands/verify.js';
import { executeDdl } from '../../packages/cli/src/ddl-executor.js';
import { loadSchema } from '../../packages/cli/src/utils/schema-loader.js';
import {
	closeTestDb,
	createSchema,
	dropSchema,
	getTestPool,
} from './testkit/index.js';

const SCHEMA = 'check_canonicalization_test';

function makeCol(name: string, type: ColumnIR['type'] = 'integer'): ColumnIR {
	return {
		name,
		type,
		nullable: false,
	};
}

function makeModel(table: TableIR): ModelIRImpl {
	return new ModelIRImpl(new Map([[table.name, table]]), new Map());
}

function changeKinds(
	diff: Awaited<ReturnType<typeof comparePgsqlDatabaseSchema>>,
): string[] {
	return diff.changes.map((change) => change.kind);
}

interface VerifyCommandResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: string | number | undefined;
}

function writeTempSchemaFile(contents: string): {
	readonly schemaPath: string;
	readonly tmpDir: string;
} {
	const tmpDir = mkdtempSync(join(process.cwd(), '.tmp-check-verify-'));
	const schemaPath = join(tmpDir, 'dbsp.schema.ts');
	writeFileSync(schemaPath, contents, 'utf8');
	return { schemaPath, tmpDir };
}

async function runVerifyCommand(
	args: readonly string[],
): Promise<VerifyCommandResult> {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const previousExitCode = process.exitCode;
	process.exitCode = undefined;
	const logSpy = vi
		.spyOn(console, 'log')
		.mockImplementation((message?: unknown, ...rest: unknown[]) => {
			stdout.push([message, ...rest].map(String).join(' '));
		});
	const warnSpy = vi
		.spyOn(console, 'warn')
		.mockImplementation((message?: unknown, ...rest: unknown[]) => {
			stderr.push([message, ...rest].map(String).join(' '));
		});
	const errorSpy = vi
		.spyOn(console, 'error')
		.mockImplementation((message?: unknown, ...rest: unknown[]) => {
			stderr.push([message, ...rest].map(String).join(' '));
		});
	const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((
		code?: string | number | null | undefined,
	) => {
		throw new Error(`process.exit:${code}`);
	}) as typeof process.exit);

	try {
		await verifyCommand.parseAsync([...args], { from: 'user' });
		return {
			stdout: stdout.join('\n'),
			stderr: stderr.join('\n'),
			exitCode: process.exitCode,
		};
	} finally {
		process.exitCode = previousExitCode;
		logSpy.mockRestore();
		warnSpy.mockRestore();
		errorSpy.mockRestore();
		exitSpy.mockRestore();
	}
}

function parseVerifyJson(result: VerifyCommandResult): Record<string, unknown> {
	return JSON.parse(result.stdout) as Record<string, unknown>;
}

/**
 * The CHECK constraint drift `verify` reports.
 *
 * `verify` also reports every extension installed in the database that the schema
 * does not declare — 57 of them on the e2e image — because `compareSchemata`
 * defaults to managing extensions it was never told about (#317). That noise is
 * not what these tests are about, and it predates the live-diff work, so they look
 * at the CHECK constraint drift only.
 */
function checkIssues(
	json: Record<string, unknown>,
): Array<Record<string, unknown>> {
	const issues = (json.issues ?? []) as Array<Record<string, unknown>>;
	return issues.filter(
		(issue) => typeof issue.type === 'string' && issue.type.includes('check'),
	);
}

function quoteIdent(name: string): string {
	return `"${name.replace(/"/gu, '""')}"`;
}

function quoteLiteral(value: string): string {
	return `'${value.replace(/'/gu, "''")}'`;
}

async function publicHasTempPrivilege(
	pool: Awaited<ReturnType<typeof getTestPool>>,
): Promise<boolean> {
	const result = await pool.query<{ acl: string[] | null }>(
		`SELECT datacl::text[] AS acl
		 FROM pg_database
		 WHERE datname = current_database()`,
	);
	const acl = result.rows[0]?.acl;
	if (acl === null || acl === undefined) return true;
	return acl.some((item) => {
		const grantee = item.slice(0, item.indexOf('='));
		const privileges = item.slice(item.indexOf('=') + 1, item.indexOf('/'));
		return grantee === '' && privileges.includes('T');
	});
}

async function roleExists(
	pool: Awaited<ReturnType<typeof getTestPool>>,
	role: string,
): Promise<boolean> {
	const result = await pool.query<{ exists: boolean }>(
		'SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists',
		[role],
	);
	return result.rows[0]?.exists === true;
}

async function setupNoTempRole(
	pool: Awaited<ReturnType<typeof getTestPool>>,
	role: string,
	password: string,
	schemaName: string,
): Promise<{ readonly database: string; readonly publicHadTemp: boolean }> {
	const databaseResult = await pool.query<{ name: string }>(
		'SELECT current_database() AS name',
	);
	const database = databaseResult.rows[0]!.name;
	const publicHadTemp = await publicHasTempPrivilege(pool);
	if (await roleExists(pool, role)) {
		await cleanupNoTempRole(pool, role, schemaName, database, publicHadTemp);
	}
	try {
		await pool.query(
			`CREATE ROLE ${quoteIdent(role)} LOGIN PASSWORD ${quoteLiteral(password)}`,
		);
		await pool.query(
			`GRANT CONNECT ON DATABASE ${quoteIdent(database)} TO ${quoteIdent(role)}`,
		);
		await pool.query(
			`GRANT USAGE ON SCHEMA ${quoteIdent(schemaName)} TO ${quoteIdent(role)}`,
		);
		await pool.query(
			`GRANT SELECT ON ALL TABLES IN SCHEMA ${quoteIdent(schemaName)} TO ${quoteIdent(role)}`,
		);
		await pool.query(
			`REVOKE TEMPORARY ON DATABASE ${quoteIdent(database)} FROM PUBLIC`,
		);
		await pool.query(
			`REVOKE TEMPORARY ON DATABASE ${quoteIdent(database)} FROM ${quoteIdent(role)}`,
		);
		return { database, publicHadTemp };
	} catch (error) {
		if (await roleExists(pool, role)) {
			await cleanupNoTempRole(pool, role, schemaName, database, publicHadTemp);
		}
		throw error;
	}
}

async function cleanupNoTempRole(
	pool: Awaited<ReturnType<typeof getTestPool>>,
	role: string,
	schemaName: string,
	database: string,
	publicHadTemp: boolean,
): Promise<void> {
	if (publicHadTemp) {
		await pool.query(
			`GRANT TEMPORARY ON DATABASE ${quoteIdent(database)} TO PUBLIC`,
		);
	} else {
		await pool.query(
			`REVOKE TEMPORARY ON DATABASE ${quoteIdent(database)} FROM PUBLIC`,
		);
	}
	await pool.query(
		`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${quoteIdent(schemaName)} FROM ${quoteIdent(role)}`,
	);
	await pool.query(
		`REVOKE ALL PRIVILEGES ON SCHEMA ${quoteIdent(schemaName)} FROM ${quoteIdent(role)}`,
	);
	await pool.query(
		`REVOKE ALL PRIVILEGES ON DATABASE ${quoteIdent(database)} FROM ${quoteIdent(role)}`,
	);
	await pool.query(`DROP OWNED BY ${quoteIdent(role)}`);
	await pool.query(`DROP ROLE IF EXISTS ${quoteIdent(role)}`);
}

function databaseUrlForRole(role: string, password: string): string {
	const url = new URL(process.env.DATABASE_URL!);
	url.username = role;
	url.password = password;
	return url.toString();
}

describe('#315 CHECK constraint canonicalization live diff', () => {
	let pool: Awaited<ReturnType<typeof getTestPool>>;
	let adapter: ReturnType<typeof createPgsqlAdapter>;

	beforeAll(async () => {
		pool = await getTestPool();
		adapter = createPgsqlAdapter(pool);
	});

	beforeEach(async () => {
		await dropSchema(SCHEMA);
		await createSchema(SCHEMA);
	});

	afterAll(async () => {
		await dropSchema(SCHEMA);
		await closeTestDb();
	});

	it('converges after PostgreSQL deparses IS NOT DISTINCT FROM and literals', async () => {
		const desired = schema(
			{
				jobs: {
					id: { type: 'integer', primaryKey: true },
					status: 'string',
					skipped_at: { type: 'timestamp', nullable: true },
				},
			},
			{
				jobs: {
					checkConstraints: [
						{
							name: 'jobs_status_skipped_check',
							expression:
								"status IS NOT DISTINCT FROM 'skipped' OR (status <> 'skipped' AND skipped_at IS NULL)",
						},
					],
				},
			},
		);
		await executeDdl(pool, generateDDL(desired.model, { schemaName: SCHEMA }));

		const first = await comparePgsqlDatabaseSchema(adapter, desired.model, {
			schema: SCHEMA,
			ignoreUnmanagedExtensions: true,
		});
		const second = await comparePgsqlDatabaseSchema(adapter, desired.model, {
			schema: SCHEMA,
			ignoreUnmanagedExtensions: true,
		});

		expect(first.changes).toEqual([]);
		expect(second.changes).toEqual([]);
	});

	it('does not report out-of-scope existing tables when include scopes a live diff', async () => {
		await pool.query(`
			CREATE TABLE ${SCHEMA}.live_diff_users (
				id integer PRIMARY KEY,
				age integer NOT NULL,
				CONSTRAINT live_diff_users_age_check CHECK (age > 0)
			)
		`);
		await pool.query(`
			CREATE TABLE ${SCHEMA}.live_diff_posts (
				id integer PRIMARY KEY,
				score integer NOT NULL,
				CONSTRAINT live_diff_posts_score_check CHECK (score > 0)
			)
		`);
		const desired = new ModelIRImpl(
			new Map<string, TableIR>([
				[
					'live_diff_users',
					{
						name: 'live_diff_users',
						columns: [makeCol('id'), makeCol('age')],
						primaryKey: 'id',
						foreignKeys: [],
						indexes: [],
						checkConstraints: [
							{
								name: 'live_diff_users_age_check',
								expression: 'age > 0',
							},
						],
					},
				],
				[
					'live_diff_posts',
					{
						name: 'live_diff_posts',
						columns: [makeCol('id'), makeCol('score')],
						primaryKey: 'id',
						foreignKeys: [],
						indexes: [],
						checkConstraints: [
							{
								name: 'live_diff_posts_score_check',
								expression: 'score > 0',
							},
						],
					},
				],
			]),
			new Map(),
		);

		const diff = await comparePgsqlDatabaseSchema(adapter, desired, {
			schema: SCHEMA,
			include: ['live_diff_users'],
			ignoreUnmanagedExtensions: true,
		});

		expect(diff.changes).toEqual([]);
		expect(diff.changes.map((change) => change.table)).not.toContain(
			'live_diff_posts',
		);
	});

	it('canonicalizes a CHECK on a column the same diff is about to add', async () => {
		// The scratch table must be shaped from the DESIRED model: the column the
		// constraint talks about does not exist in the database yet.
		const before = schema({
			jobs: { id: { type: 'integer', primaryKey: true } },
		});
		await executeDdl(pool, generateDDL(before.model, { schemaName: SCHEMA }));

		const desired = schema(
			{
				jobs: {
					id: { type: 'integer', primaryKey: true },
					attempts: 'integer',
				},
			},
			{
				jobs: {
					checkConstraints: [
						{
							name: 'jobs_attempts_check',
							expression:
								'attempts >= 0 AND attempts IS NOT DISTINCT FROM attempts',
						},
					],
				},
			},
		);

		const diff = await comparePgsqlDatabaseSchema(adapter, desired.model, {
			schema: SCHEMA,
			ignoreUnmanagedExtensions: true,
		});
		expect(changeKinds(diff)).toEqual(['add_column', 'add_check_constraint']);

		await executeDdl(
			pool,
			generateMigrationSQL(diff, { schemaName: SCHEMA }) as string[],
		);

		// The whole point: it converges on the very next run.
		const after = await comparePgsqlDatabaseSchema(adapter, desired.model, {
			schema: SCHEMA,
			ignoreUnmanagedExtensions: true,
		});
		expect(after.changes).toEqual([]);
	});

	it('canonicalizes a CHECK that refers to an enum the same diff creates', async () => {
		const desired = schema(
			{
				jobs: {
					id: { type: 'integer', primaryKey: true },
					state: 'string',
				},
			},
			{
				jobs: {
					checkConstraints: [
						{
							name: 'jobs_state_check',
							expression:
								"state = ANY (ARRAY['queued'::text, 'done'::text]) AND state IS NOT DISTINCT FROM state",
						},
					],
				},
			},
		);

		// Nothing exists yet — table, column and constraint all land in one diff.
		const diff = await comparePgsqlDatabaseSchema(adapter, desired.model, {
			schema: SCHEMA,
			ignoreUnmanagedExtensions: true,
		});
		await executeDdl(
			pool,
			generateMigrationSQL(diff, { schemaName: SCHEMA }) as string[],
		);

		const after = await comparePgsqlDatabaseSchema(adapter, desired.model, {
			schema: SCHEMA,
			ignoreUnmanagedExtensions: true,
		});
		expect(after.changes).toEqual([]);
	});

	it('emits a valid ADD CONSTRAINT for a bare predicate on a brand-new table', async () => {
		// A hand-built ModelIR with no CHECK(...) wrapper. Emitted verbatim, this
		// would produce `ADD CONSTRAINT c amount > 0` — invalid SQL.
		const desired = makeModel({
			name: 'invoices',
			columns: [makeCol('id'), makeCol('amount')],
			foreignKeys: [],
			indexes: [],
			primaryKey: 'id',
			checkConstraints: [
				{ name: 'invoices_amount_check', expression: 'amount > 0' },
			],
		});

		const diff = await comparePgsqlDatabaseSchema(adapter, desired, {
			schema: SCHEMA,
			ignoreUnmanagedExtensions: true,
		});
		const statements = generateMigrationSQL(diff, {
			schemaName: SCHEMA,
		}) as string[];

		// It must be a real CHECK clause, and it must actually apply.
		expect(statements.some((s) => /ADD CONSTRAINT .*CHECK \(/u.test(s))).toBe(
			true,
		);
		await executeDdl(pool, statements);

		const after = await comparePgsqlDatabaseSchema(adapter, desired, {
			schema: SCHEMA,
			ignoreUnmanagedExtensions: true,
		});
		expect(after.changes).toEqual([]);
	});

	it('still detects a genuinely changed CHECK expression and produces migration SQL', async () => {
		const initial = schema(
			{
				payments: {
					id: { type: 'integer', primaryKey: true },
					amount: 'integer',
				},
			},
			{
				payments: {
					checkConstraints: [
						{ name: 'payments_amount_check', expression: 'amount > 0' },
					],
				},
			},
		);
		const changed = schema(
			{
				payments: {
					id: { type: 'integer', primaryKey: true },
					amount: 'integer',
				},
			},
			{
				payments: {
					checkConstraints: [
						{ name: 'payments_amount_check', expression: 'amount >= 0' },
					],
				},
			},
		);
		await executeDdl(pool, generateDDL(initial.model, { schemaName: SCHEMA }));

		const diff = await comparePgsqlDatabaseSchema(adapter, changed.model, {
			schema: SCHEMA,
			ignoreUnmanagedExtensions: true,
		});
		const statements = generateMigrationSQL(diff, {
			includeDestructive: true,
			schemaName: SCHEMA,
		});

		expect(changeKinds(diff)).toEqual([
			'drop_check_constraint',
			'add_check_constraint',
		]);
		expect(statements).toEqual([
			'ALTER TABLE "check_canonicalization_test"."payments" DROP CONSTRAINT IF EXISTS "payments_amount_check";',
			'DO $$ BEGIN ALTER TABLE "check_canonicalization_test"."payments" ADD CONSTRAINT "payments_amount_check" CHECK ((amount >= 0)); EXCEPTION WHEN duplicate_object THEN NULL; END $$;',
		]);
		await executeDdl(pool, statements);

		const rediff = await comparePgsqlDatabaseSchema(adapter, changed.model, {
			schema: SCHEMA,
			ignoreUnmanagedExtensions: true,
		});
		expect(rediff.changes).toEqual([]);
	});

	it('emits neither half of a changed CHECK replacement in additive mode', async () => {
		const initial = schema(
			{
				payments: {
					id: { type: 'integer', primaryKey: true },
					amount: 'integer',
				},
			},
			{
				payments: {
					checkConstraints: [
						{ name: 'payments_amount_check', expression: 'amount > 0' },
					],
				},
			},
		);
		const changed = schema(
			{
				payments: {
					id: { type: 'integer', primaryKey: true },
					amount: 'integer',
				},
			},
			{
				payments: {
					checkConstraints: [
						{ name: 'payments_amount_check', expression: 'amount >= 0' },
					],
				},
			},
		);
		await executeDdl(pool, generateDDL(initial.model, { schemaName: SCHEMA }));

		const diff = await comparePgsqlDatabaseSchema(adapter, changed.model, {
			schema: SCHEMA,
			ignoreUnmanagedExtensions: true,
		});
		const statements = generateMigrationSQL(diff, {
			includeDestructive: false,
			schemaName: SCHEMA,
		});

		expect(changeKinds(diff)).toEqual([
			'drop_check_constraint',
			'add_check_constraint',
		]);
		expect(statements).toEqual([]);

		const definition = await pool.query<{ definition: string }>(
			`SELECT pg_get_constraintdef(c.oid, false) AS definition
				   FROM pg_constraint c
				   JOIN pg_class r ON r.oid = c.conrelid
				   JOIN pg_namespace n ON n.oid = r.relnamespace
				  WHERE n.nspname = $1
				    AND r.relname = 'payments'
				    AND c.conname = 'payments_amount_check'`,
			[SCHEMA],
		);
		expect(definition.rows[0]?.definition).toBe('CHECK ((amount > 0))');
	});

	it('emits validation change only when CHECK differs by NOT VALID state', async () => {
		await pool.query(`
			CREATE TABLE ${SCHEMA}.measurements (
				id integer PRIMARY KEY,
				amount integer NOT NULL
			)
		`);
		await pool.query(`
			ALTER TABLE ${SCHEMA}.measurements
			ADD CONSTRAINT measurements_amount_check CHECK (amount > 0) NOT VALID
		`);
		const desired = makeModel({
			name: 'measurements',
			columns: [makeCol('id'), makeCol('amount')],
			primaryKey: 'id',
			foreignKeys: [],
			indexes: [],
			checkConstraints: [
				{ name: 'measurements_amount_check', expression: 'amount > 0' },
			],
		});

		const diff = await comparePgsqlDatabaseSchema(adapter, desired, {
			schema: SCHEMA,
			ignoreUnmanagedExtensions: true,
		});
		const statements = generateMigrationSQL(diff, {
			includeDestructive: true,
			schemaName: SCHEMA,
		});

		expect(changeKinds(diff)).toEqual(['validate_constraint']);
		expect(statements).toEqual([
			'ALTER TABLE "check_canonicalization_test"."measurements" VALIDATE CONSTRAINT "measurements_amount_check";',
		]);
	});

	it('round-trips CHECK NO INHERIT NOT VALID without doubling NOT VALID', async () => {
		await pool.query(`
				CREATE TABLE ${SCHEMA}.measurements (
					id integer PRIMARY KEY,
					amount integer NOT NULL
				)
			`);
		await pool.query(`
				ALTER TABLE ${SCHEMA}.measurements
				ADD CONSTRAINT measurements_amount_check
				CHECK (amount > 0) NO INHERIT NOT VALID
			`);
		const desiredNotValid = makeModel({
			name: 'measurements',
			columns: [makeCol('id'), makeCol('amount')],
			primaryKey: 'id',
			foreignKeys: [],
			indexes: [],
			checkConstraints: [
				{
					name: 'measurements_amount_check',
					expression: 'CHECK ((amount > 0)) NO INHERIT',
					notValid: true,
				},
			],
		});

		const roundTrip = await comparePgsqlDatabaseSchema(
			adapter,
			desiredNotValid,
			{
				schema: SCHEMA,
				ignoreUnmanagedExtensions: true,
			},
		);
		expect(roundTrip.changes).toEqual([]);

		const desiredValid = makeModel({
			name: 'measurements',
			columns: [makeCol('id'), makeCol('amount')],
			primaryKey: 'id',
			foreignKeys: [],
			indexes: [],
			checkConstraints: [
				{
					name: 'measurements_amount_check',
					expression: 'CHECK ((amount > 0)) NO INHERIT',
					notValid: false,
				},
			],
		});
		const diff = await comparePgsqlDatabaseSchema(adapter, desiredValid, {
			schema: SCHEMA,
			ignoreUnmanagedExtensions: true,
		});
		const statements = generateMigrationSQL(diff, {
			includeDestructive: true,
			schemaName: SCHEMA,
		});

		expect(changeKinds(diff)).toEqual(['validate_constraint']);
		expect(statements).toEqual([
			'ALTER TABLE "check_canonicalization_test"."measurements" VALIDATE CONSTRAINT "measurements_amount_check";',
		]);
	});

	it('canonicalizes a bare hand-built ModelIR predicate to the full CHECK clause', async () => {
		await pool.query(`
			CREATE TABLE ${SCHEMA}.bare_checks (
				id integer PRIMARY KEY,
				amount integer NOT NULL,
				CONSTRAINT bare_checks_amount_check CHECK (amount > 0)
			)
		`);
		const desired = makeModel({
			name: 'bare_checks',
			columns: [makeCol('id'), makeCol('amount')],
			primaryKey: 'id',
			foreignKeys: [],
			indexes: [],
			checkConstraints: [
				{ name: 'bare_checks_amount_check', expression: 'amount > 0' },
			],
		});

		const diff = await comparePgsqlDatabaseSchema(adapter, desired, {
			schema: SCHEMA,
			ignoreUnmanagedExtensions: true,
		});

		expect(diff.changes).toEqual([]);
	});

	it('canonicalizes a CHECK against the desired column type when the same diff changes that type', async () => {
		await pool.query(`
			CREATE TABLE ${SCHEMA}.type_changes (
				id integer PRIMARY KEY,
				code integer NOT NULL
			)
		`);
		const desired = makeModel({
			name: 'type_changes',
			columns: [makeCol('id'), makeCol('code', 'string')],
			primaryKey: 'id',
			foreignKeys: [],
			indexes: [],
			checkConstraints: [
				{ name: 'type_changes_code_check', expression: 'length(code) > 0' },
			],
		});

		const diff = await comparePgsqlDatabaseSchema(adapter, desired, {
			schema: SCHEMA,
			ignoreUnmanagedExtensions: true,
			requireExpressionCanonicalization: true,
		});
		const statements = generateMigrationSQL(diff, {
			includeDestructive: true,
			schemaName: SCHEMA,
		});

		expect(changeKinds(diff)).toContain('alter_column_type');
		expect(changeKinds(diff)).toContain('add_check_constraint');
		expect(
			statements.some((statement) =>
				statement.includes('ADD CONSTRAINT "type_changes_code_check" CHECK'),
			),
		).toBe(true);
		await executeDdl(pool, statements);

		const rediff = await comparePgsqlDatabaseSchema(adapter, desired, {
			schema: SCHEMA,
			ignoreUnmanagedExtensions: true,
			requireExpressionCanonicalization: true,
		});
		expect(rediff.changes).toEqual([]);
	});

	it('canonicalizes CHECK constraints inside a mixed-case database schema under snake_case dbCasing', async () => {
		const tenantSchema = 'tenantOne';
		await dropSchema(tenantSchema);
		await createSchema(tenantSchema);
		try {
			await pool.query(`
					CREATE TYPE "tenantOne".status AS ENUM ('queued', 'done')
				`);
			await pool.query(`
					CREATE TABLE "tenantOne".jobs (
						id integer PRIMARY KEY,
						state "tenantOne".status NOT NULL,
						CONSTRAINT jobs_state_check CHECK (state = 'queued')
					)
				`);
			const desired = new ModelIRImpl(
				new Map<string, TableIR>([
					[
						'jobs',
						{
							name: 'jobs',
							columns: [
								makeCol('id'),
								{ name: 'state', type: 'string', nullable: false },
							],
							primaryKey: 'id',
							foreignKeys: [],
							indexes: [],
							checkConstraints: [
								{ name: 'jobs_state_check', expression: "state = 'queued'" },
							],
						},
					],
				]),
				new Map(),
				new Map([
					[
						'status',
						{
							name: 'status',
							values: ['queued', 'done'],
							schema: tenantSchema,
						},
					],
				]),
			);

			const diff = await comparePgsqlDatabaseSchema(adapter, desired, {
				schema: tenantSchema,
				dbCasing: 'snake_case',
				ignoreUnmanagedExtensions: true,
				requireExpressionCanonicalization: true,
			});

			expect(diff.changes).toEqual([]);
		} finally {
			await dropSchema(tenantSchema);
		}
	});

	it('uses dbCasing loaded from a generated schema file for snake_case CHECK canonicalization', async () => {
		await pool.query(`
			CREATE TABLE ${SCHEMA}.order_items (
				id integer PRIMARY KEY,
				order_total integer NOT NULL,
				CONSTRAINT order_items_total_check
					CHECK (order_total >= 0 AND order_total IS NOT DISTINCT FROM order_total)
			)
		`);

		const tmpDir = mkdtempSync(join(process.cwd(), '.tmp-check-loader-'));
		try {
			const schemaPath = join(tmpDir, 'dbsp.schema.ts');
			writeFileSync(
				schemaPath,
				`
					import { schema } from '@dbsp/core';

					export const dbSchema = schema({
						orderItems: {
							id: { type: 'integer', primaryKey: true },
							orderTotal: 'integer',
						},
					}, {
						orderItems: {
							checkConstraints: [
								{
									name: 'order_items_total_check',
									expression: 'order_total >= 0 AND order_total IS NOT DISTINCT FROM order_total',
								},
							],
						},
					});

					export default dbSchema;
					export const dbCasing = 'snake_case' as const;
				`,
				'utf8',
			);

			const loaded = await loadSchema(schemaPath);
			const dbCasing = loaded.dbCasing;
			expect(dbCasing).toBe('snake_case');
			if (dbCasing === undefined) {
				throw new Error('expected generated schema to export dbCasing');
			}
			const warnings: string[] = [];
			const first = await comparePgsqlDatabaseSchema(adapter, loaded.model, {
				schema: SCHEMA,
				dbCasing,
				ignoreUnmanagedExtensions: true,
				onWarning: (message) => warnings.push(message),
			});
			const second = await comparePgsqlDatabaseSchema(adapter, loaded.model, {
				schema: SCHEMA,
				dbCasing,
				ignoreUnmanagedExtensions: true,
				onWarning: (message) => warnings.push(message),
			});

			expect(warnings).toEqual([]);
			expect(first.changes).toEqual([]);
			expect(second.changes).toEqual([]);
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	describe('verify command', () => {
		it('reports no drift when a CHECK differs only by PostgreSQL rendering', async () => {
			const desired = schema(
				{
					jobs: {
						id: { type: 'integer', primaryKey: true },
						status: 'string',
						skipped_at: { type: 'timestamp', nullable: true },
					},
				},
				{
					jobs: {
						checkConstraints: [
							{
								name: 'jobs_status_skipped_check',
								expression:
									"status IS NOT DISTINCT FROM 'skipped' OR (status <> 'skipped' AND skipped_at IS NULL)",
							},
						],
					},
				},
			);
			await executeDdl(
				pool,
				generateDDL(desired.model, { schemaName: SCHEMA }),
			);
			const { schemaPath, tmpDir } = writeTempSchemaFile(`
				import { schema } from '@dbsp/core';

				export const dbSchema = schema(
					{
						jobs: {
							id: { type: 'integer', primaryKey: true },
							status: 'string',
							skipped_at: { type: 'timestamp', nullable: true },
						},
					},
					{
						jobs: {
							checkConstraints: [
								{
									name: 'jobs_status_skipped_check',
									expression:
										"status IS NOT DISTINCT FROM 'skipped' OR (status <> 'skipped' AND skipped_at IS NULL)",
								},
							],
						},
					},
				);

				export default dbSchema;
			`);

			try {
				const result = await runVerifyCommand([
					'--schema',
					schemaPath,
					'--db',
					process.env.DATABASE_URL!,
					'--schema-name',
					SCHEMA,
					'--json',
				]);
				const json = parseVerifyJson(result);

				// The whole point: PostgreSQL re-printed the author's expression, and
				// verify must not call that drift.
				expect(checkIssues(json)).toEqual([]);
				expect(json).toMatchObject({
					schemaTables: ['jobs'],
					dbTables: ['jobs'],
				});
				expect(json).not.toHaveProperty('diff');
				expect(result.stderr).toBe('');
			} finally {
				rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it('reports genuine CHECK expression drift with the existing JSON shape and exit code', async () => {
			await pool.query(`
				CREATE TABLE ${SCHEMA}.checked_numbers (
					id integer PRIMARY KEY,
					age integer NOT NULL,
					CONSTRAINT checked_numbers_age_check CHECK (age >= 0)
				)
			`);
			const { schemaPath, tmpDir } = writeTempSchemaFile(`
				import { schema } from '@dbsp/core';

				export const dbSchema = schema(
					{
						checked_numbers: {
							id: { type: 'integer', primaryKey: true },
							age: 'integer',
						},
					},
					{
						checked_numbers: {
							checkConstraints: [
								{
									name: 'checked_numbers_age_check',
									expression: 'age > 0',
								},
							],
						},
					},
				);

				export default dbSchema;
			`);

			try {
				const result = await runVerifyCommand([
					'--schema',
					schemaPath,
					'--db',
					process.env.DATABASE_URL!,
					'--schema-name',
					SCHEMA,
					'--json',
				]);
				const json = parseVerifyJson(result);

				expect(json).toMatchObject({
					schemaTables: ['checked_numbers'],
					dbTables: ['checked_numbers'],
					summary: {
						tables: { added: 0, dropped: 0 },
						columns: { added: 0, dropped: 0, altered: 0 },
						constraints: { added: 1, dropped: 1, altered: 0 },
					},
				});
				expect(json).not.toHaveProperty('diff');
				// A real expression change is still drift, reported in the same shape.
				expect(checkIssues(json)).toEqual([
					expect.objectContaining({
						severity: 'warning',
						type: 'missing_check_in_db',
						table: 'checked_numbers',
					}),
					expect.objectContaining({
						severity: 'info',
						type: 'missing_check_in_schema',
						table: 'checked_numbers',
					}),
				]);
			} finally {
				rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it('falls back to raw CHECK comparison with a warning when the role cannot create temp tables', async () => {
			const desired = schema(
				{
					jobs: {
						id: { type: 'integer', primaryKey: true },
						status: 'string',
						skipped_at: { type: 'timestamp', nullable: true },
					},
				},
				{
					jobs: {
						checkConstraints: [
							{
								name: 'jobs_status_skipped_check',
								expression:
									"status IS NOT DISTINCT FROM 'skipped' OR (status <> 'skipped' AND skipped_at IS NULL)",
							},
						],
					},
				},
			);
			await executeDdl(
				pool,
				generateDDL(desired.model, { schemaName: SCHEMA }),
			);
			const { schemaPath, tmpDir } = writeTempSchemaFile(`
				import { schema } from '@dbsp/core';

				export const dbSchema = schema(
					{
						jobs: {
							id: { type: 'integer', primaryKey: true },
							status: 'string',
							skipped_at: { type: 'timestamp', nullable: true },
						},
					},
					{
						jobs: {
							checkConstraints: [
								{
									name: 'jobs_status_skipped_check',
									expression:
										"status IS NOT DISTINCT FROM 'skipped' OR (status <> 'skipped' AND skipped_at IS NULL)",
								},
							],
						},
					},
				);

				export default dbSchema;
			`);
			const role = 'check_canon_verify_no_temp';
			const password = 'check-canon-verify-no-temp';
			let roleState: Awaited<ReturnType<typeof setupNoTempRole>> | undefined;

			try {
				roleState = await setupNoTempRole(pool, role, password, SCHEMA);
				const result = await runVerifyCommand([
					'--schema',
					schemaPath,
					'--db',
					databaseUrlForRole(role, password),
					'--schema-name',
					SCHEMA,
					'--json',
				]);
				const json = parseVerifyJson(result);

				expect(result.stderr).toContain(
					'Could not canonicalize CHECK constraint',
				);
				expect(result.stderr).toContain('falling back');
				expect(json).toMatchObject({
					schemaTables: ['jobs'],
					dbTables: ['jobs'],
				});
				// It warned and carried on: the raw comparison reports the drift it
				// could not canonicalise away, rather than failing the command.
				expect(checkIssues(json)).toEqual([
					expect.objectContaining({
						severity: 'warning',
						type: 'missing_check_in_db',
						table: 'jobs',
					}),
					expect.objectContaining({
						severity: 'info',
						type: 'missing_check_in_schema',
						table: 'jobs',
					}),
				]);
			} finally {
				if (roleState !== undefined) {
					await cleanupNoTempRole(
						pool,
						role,
						SCHEMA,
						roleState.database,
						roleState.publicHadTemp,
					);
				}
				rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it('honours dbCasing exported by the loaded schema', async () => {
			await pool.query(`
				CREATE TABLE ${SCHEMA}.user_profiles (
					id integer PRIMARY KEY,
					display_name varchar(255) NOT NULL
				)
			`);
			const { schemaPath, tmpDir } = writeTempSchemaFile(`
				import { schema } from '@dbsp/core';

				export const dbSchema = schema({
					userProfiles: {
						id: { type: 'integer', primaryKey: true },
						displayName: 'string',
					},
				});

				export default dbSchema;
				export const dbCasing = 'snake_case' as const;
			`);

			try {
				const result = await runVerifyCommand([
					'--schema',
					schemaPath,
					'--db',
					process.env.DATABASE_URL!,
					'--schema-name',
					SCHEMA,
					'--json',
				]);
				const json = parseVerifyJson(result);

				// The schema calls it userProfiles and declares snake_case; the database
				// has user_profiles. verify must reconcile them, not report a drop and
				// an add.
				expect(json).toMatchObject({
					schemaTables: ['userProfiles'],
					dbTables: ['user_profiles'],
					summary: {
						tables: { added: 0, dropped: 0 },
						columns: { added: 0, dropped: 0, altered: 0 },
					},
				});
				expect(checkIssues(json)).toEqual([]);
			} finally {
				rmSync(tmpDir, { recursive: true, force: true });
			}
		});
	});

	it('emits a bare predicate ending in a boolean column named valid intact', async () => {
		await pool.query(`
				CREATE TABLE ${SCHEMA}.valid_flags (
				id integer PRIMARY KEY,
				enabled boolean NOT NULL,
				valid boolean NOT NULL
			)
		`);
		await pool.query(`
			CREATE TABLE ${SCHEMA}.valid_flags_not_valid (
				id integer PRIMARY KEY,
				enabled boolean NOT NULL,
				valid boolean NOT NULL
			)
		`);
		const desired = new ModelIRImpl(
			new Map<string, TableIR>([
				[
					'valid_flags',
					{
						name: 'valid_flags',
						columns: [
							makeCol('id'),
							makeCol('enabled', 'boolean'),
							makeCol('valid', 'boolean'),
						],
						primaryKey: 'id',
						foreignKeys: [],
						indexes: [],
						checkConstraints: [
							{
								name: 'valid_flags_enabled_check',
								expression: 'enabled AND NOT valid',
							},
						],
					},
				],
				[
					'valid_flags_not_valid',
					{
						name: 'valid_flags_not_valid',
						columns: [
							makeCol('id'),
							makeCol('enabled', 'boolean'),
							makeCol('valid', 'boolean'),
						],
						primaryKey: 'id',
						foreignKeys: [],
						indexes: [],
						checkConstraints: [
							{
								name: 'valid_flags_not_valid_enabled_check',
								expression: 'enabled AND NOT valid',
								notValid: true,
							},
						],
					},
				],
			]),
			new Map(),
		);

		const diff = await comparePgsqlDatabaseSchema(adapter, desired, {
			schema: SCHEMA,
			ignoreUnmanagedExtensions: true,
		});
		const statements = generateMigrationSQL(diff, {
			includeDestructive: true,
			schemaName: SCHEMA,
		});

		expect(statements).toHaveLength(2);
		expect(statements[0]).toContain('NOT valid');
		expect(statements[0]).not.toContain('enabled AND)');
		expect(statements[1]).toContain('NOT valid');
		expect(statements[1]).toContain('NOT VALID');
		await executeDdl(pool, statements);
	});

	describe('a CHECK that cannot be canonicalised while the diff adds enum values', () => {
		/**
		 * PostgreSQL cannot use an enum value in the transaction that adds it, and
		 * dbsp applies each migration in one transaction. The refusal must not depend
		 * on how the value is *spelled* in the expression: PostgreSQL refusing to
		 * canonicalise the constraint is the whole signal.
		 */
		beforeEach(async () => {
			await pool.query(
				`CREATE TYPE ${SCHEMA}.status AS ENUM ('queued', 'done')`,
			);
			await pool.query(`
				CREATE TABLE ${SCHEMA}.jobs (
					id integer PRIMARY KEY,
					state ${SCHEMA}.status NOT NULL
				)
			`);
		});

		function desiredWithPendingValue(expression: string): ModelIRImpl {
			return new ModelIRImpl(
				new Map<string, TableIR>([
					[
						'jobs',
						{
							name: 'jobs',
							columns: [
								makeCol('id'),
								// Authored desired schemas usually only know this is a string.
								// The scratch table must borrow the live enum type from introspection.
								{
									name: 'state',
									type: 'string',
									nullable: false,
								},
							],
							primaryKey: 'id',
							foreignKeys: [],
							indexes: [],
							checkConstraints: [{ name: 'jobs_state_check', expression }],
						},
					],
				]),
				new Map(),
				new Map([
					[
						'status',
						{
							name: 'status',
							values: ['queued', 'done', 'pending'],
							schema: SCHEMA,
						},
					],
				]),
			);
		}

		// Every spelling PostgreSQL accepts for the literal. The refusal must not
		// depend on any of them: a scan for the exact text `'pending'` sees the first
		// and misses the rest, which is precisely why there is no scan any more.
		it('refuses only the constraint PostgreSQL rejected, not its innocent sibling', async () => {
			// Two CHECKs on one table: PostgreSQL refuses the first (the enum value does
			// not exist yet) and accepts the second. Canonicalisation is per constraint,
			// so the sibling must keep its canonical form and stay out of the refusal.
			const desired = new ModelIRImpl(
				new Map<string, TableIR>([
					[
						'jobs',
						{
							name: 'jobs',
							columns: [
								makeCol('id'),
								{ name: 'state', type: 'string', nullable: false },
							],
							primaryKey: 'id',
							foreignKeys: [],
							indexes: [],
							checkConstraints: [
								{
									name: 'jobs_state_pending_check',
									expression: 'state = $$pending$$',
								},
								{
									name: 'jobs_state_known_check',
									expression: "state <> 'done'",
								},
							],
						},
					],
				]),
				new Map(),
				new Map([
					[
						'status',
						{
							name: 'status',
							values: ['queued', 'done', 'pending'],
							schema: SCHEMA,
						},
					],
				]),
			);

			const error = await comparePgsqlDatabaseSchema(adapter, desired, {
				schema: SCHEMA,
				ignoreUnmanagedExtensions: true,
			}).catch((e: unknown) => e as CheckConstraintNewEnumValueError);

			expect(error).toBeInstanceOf(CheckConstraintNewEnumValueError);
			expect(error.constraint).toBe('jobs_state_pending_check');
		});

		it.each([
			['single-quoted', "state = 'pending'"],
			['dollar-quoted', 'state = $$pending$$'],
			['tagged dollar-quoted', 'state = $lit$pending$lit$'],
		])('refuses a %s reference to the added enum value', async (_kind, expr) => {
			await expect(
				comparePgsqlDatabaseSchema(adapter, desiredWithPendingValue(expr), {
					schema: SCHEMA,
					ignoreUnmanagedExtensions: true,
				}),
			).rejects.toThrow(CheckConstraintNewEnumValueError);
		});

		it('names the added enum values as candidates, without asserting a cause', async () => {
			const error = await comparePgsqlDatabaseSchema(
				adapter,
				desiredWithPendingValue('state = $$pending$$'),
				{ schema: SCHEMA, ignoreUnmanagedExtensions: true },
			).catch((e: unknown) => e as CheckConstraintNewEnumValueError);

			expect(error).toBeInstanceOf(CheckConstraintNewEnumValueError);
			expect(error.table).toBe('jobs');
			expect(error.constraint).toBe('jobs_state_check');
			expect(error.addedEnumValues).toEqual([
				{ enumName: `${SCHEMA}.status`, value: 'pending' },
			]);
		});

		it('does not refuse a CHECK that PostgreSQL canonicalises fine', async () => {
			// The same diff still adds 'pending' to the enum, but this constraint uses
			// only values the database already knows, so it canonicalises and applies.
			const diff = await comparePgsqlDatabaseSchema(
				adapter,
				desiredWithPendingValue("state <> 'done'"),
				{ schema: SCHEMA, ignoreUnmanagedExtensions: true },
			);

			expect(changeKinds(diff)).toContain('alter_enum_add_value');
			expect(changeKinds(diff)).toContain('add_check_constraint');
			await executeDdl(
				pool,
				generateMigrationSQL(diff, { schemaName: SCHEMA }) as string[],
			);
		});
	});
});
