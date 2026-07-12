/**
 * #315 - PostgreSQL canonical CHECK expressions converge in live diffs.
 *
 * These tests require the e2e PostgreSQL database and are intentionally not run
 * by the agent verification command for this change.
 */

import {
	comparePgsqlDatabaseSchema,
	generateDDL,
	generateMigrationSQL,
} from '@dbsp/adapter-pgsql';
import { ModelIRImpl, schema } from '@dbsp/core';
import type { ColumnIR, TableIR } from '@dbsp/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { executeDdl } from '../../packages/cli/src/ddl-executor.js';
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

describe('#315 CHECK constraint canonicalization live diff', () => {
	let pool: Awaited<ReturnType<typeof getTestPool>>;

	beforeAll(async () => {
		pool = await getTestPool();
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

		const first = await comparePgsqlDatabaseSchema(pool, desired.model, {
			schema: SCHEMA,
			ignoreUnmanagedExtensions: true,
		});
		const second = await comparePgsqlDatabaseSchema(pool, desired.model, {
			schema: SCHEMA,
			ignoreUnmanagedExtensions: true,
		});

		expect(first.changes).toEqual([]);
		expect(second.changes).toEqual([]);
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

		const diff = await comparePgsqlDatabaseSchema(pool, desired.model, {
			schema: SCHEMA,
			ignoreUnmanagedExtensions: true,
		});
		expect(changeKinds(diff)).toEqual(['add_column', 'add_check_constraint']);

		await executeDdl(
			pool,
			generateMigrationSQL(diff, { schemaName: SCHEMA }) as string[],
		);

		// The whole point: it converges on the very next run.
		const after = await comparePgsqlDatabaseSchema(pool, desired.model, {
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
		const diff = await comparePgsqlDatabaseSchema(pool, desired.model, {
			schema: SCHEMA,
			ignoreUnmanagedExtensions: true,
		});
		await executeDdl(
			pool,
			generateMigrationSQL(diff, { schemaName: SCHEMA }) as string[],
		);

		const after = await comparePgsqlDatabaseSchema(pool, desired.model, {
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

		const diff = await comparePgsqlDatabaseSchema(pool, desired, {
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

		const after = await comparePgsqlDatabaseSchema(pool, desired, {
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

		const diff = await comparePgsqlDatabaseSchema(pool, changed.model, {
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

		const diff = await comparePgsqlDatabaseSchema(pool, desired, {
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

	it('emits validation change only when FK differs by NOT VALID state', async () => {
		await pool.query(`
			CREATE TABLE ${SCHEMA}.users (
				id integer PRIMARY KEY
			)
		`);
		await pool.query(`
			CREATE TABLE ${SCHEMA}.posts (
				id integer PRIMARY KEY,
				author_id integer NOT NULL
			)
		`);
		await pool.query(`
			ALTER TABLE ${SCHEMA}.posts
			ADD CONSTRAINT fk_posts_author_id
			FOREIGN KEY (author_id) REFERENCES ${SCHEMA}.users (id) NOT VALID
		`);
		const desired = new ModelIRImpl(
			new Map([
				[
					'users',
					{
						name: 'users',
						columns: [makeCol('id')],
						primaryKey: 'id',
						foreignKeys: [],
						indexes: [],
					},
				],
				[
					'posts',
					{
						name: 'posts',
						columns: [makeCol('id'), makeCol('author_id')],
						primaryKey: 'id',
						foreignKeys: [
							{
								columns: ['author_id'],
								references: { table: 'users', columns: ['id'] },
							},
						],
						indexes: [],
					},
				],
			]),
			new Map(),
		);

		const diff = await comparePgsqlDatabaseSchema(pool, desired, {
			schema: SCHEMA,
			ignoreUnmanagedExtensions: true,
		});
		const statements = generateMigrationSQL(diff, {
			includeDestructive: true,
			schemaName: SCHEMA,
		});

		expect(changeKinds(diff)).toEqual(['validate_constraint']);
		expect(diff.summary.constraints.altered).toBe(1);
		expect(statements).toEqual([
			'ALTER TABLE "check_canonicalization_test"."posts" VALIDATE CONSTRAINT "fk_posts_author_id";',
		]);
	});

	it('drops and re-adds FK NOT VALID when desired asks for NOT VALID on a validated FK', async () => {
		await pool.query(`
			CREATE TABLE ${SCHEMA}.users (
				id integer PRIMARY KEY
			)
		`);
		await pool.query(`
			CREATE TABLE ${SCHEMA}.posts (
				id integer PRIMARY KEY,
				author_id integer NOT NULL,
				CONSTRAINT fk_posts_author_id
					FOREIGN KEY (author_id) REFERENCES ${SCHEMA}.users (id)
			)
		`);
		const desired = new ModelIRImpl(
			new Map([
				[
					'users',
					{
						name: 'users',
						columns: [makeCol('id')],
						primaryKey: 'id',
						foreignKeys: [],
						indexes: [],
					},
				],
				[
					'posts',
					{
						name: 'posts',
						columns: [makeCol('id'), makeCol('author_id')],
						primaryKey: 'id',
						foreignKeys: [
							{
								columns: ['author_id'],
								references: { table: 'users', columns: ['id'] },
								notValid: true,
							},
						],
						indexes: [],
					},
				],
			]),
			new Map(),
		);

		const diff = await comparePgsqlDatabaseSchema(pool, desired, {
			schema: SCHEMA,
			ignoreUnmanagedExtensions: true,
		});
		const statements = generateMigrationSQL(diff, {
			includeDestructive: true,
			schemaName: SCHEMA,
		});

		expect(changeKinds(diff)).toEqual(['drop_foreign_key', 'add_foreign_key']);
		expect(statements).toEqual([
			'ALTER TABLE "check_canonicalization_test"."posts" DROP CONSTRAINT IF EXISTS "fk_posts_author_id";',
			'ALTER TABLE "check_canonicalization_test"."posts" ADD CONSTRAINT "fk_posts_author_id" FOREIGN KEY ("author_id") REFERENCES "check_canonicalization_test"."users" ("id") NOT VALID;',
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

		const diff = await comparePgsqlDatabaseSchema(pool, desired, {
			schema: SCHEMA,
			ignoreUnmanagedExtensions: true,
		});

		expect(diff.changes).toEqual([]);
	});
});
