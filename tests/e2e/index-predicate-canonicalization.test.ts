/** #383 — PostgreSQL partial-index predicates converge in live diffs. */

import {
	comparePgsqlDatabaseSchema,
	compareSchemata,
	createPgsqlAdapter,
	generateMigrationSQL,
	IndexPredicateCanonicalizationError,
} from '@dbsp/adapter-pgsql';
import { ModelIRImpl } from '@dbsp/core';
import type { IndexIR, ModelIR, TableIR } from '@dbsp/types';
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import {
	closeTestDb,
	createSchema,
	dropSchema,
	getTestPool,
} from './testkit/index.js';

const SCHEMA = 'index_predicate_canonicalization_test';
const PUBLIC_ENUM = 'dbsp_383_index_predicate_state';

async function runCleanup(...steps: readonly (() => unknown)[]): Promise<void> {
	const errors: unknown[] = [];
	for (const step of steps) {
		try {
			await step();
		} catch (error) {
			errors.push(error);
		}
	}
	if (errors.length > 0) {
		throw new AggregateError(
			errors,
			'index-predicate canonicalization E2E cleanup failed',
		);
	}
}

function model(
	predicate: string,
	enumValues: readonly string[] = ['active', 'inactive'],
	additionalIndexes: readonly IndexIR[] = [],
): ModelIR {
	const jobs: TableIR = {
		name: 'jobs',
		columns: [
			{ name: 'id', type: 'integer', nullable: false },
			{
				name: 'state',
				type: 'string',
				nullable: false,
				originalDbType: 'job_state',
				originalDbTypeSchema: SCHEMA,
				originalDbTypeSchemaScope: 'target',
			},
			{ name: 'note', type: 'text', nullable: true },
		],
		foreignKeys: [],
		indexes: [
			{
				name: 'idx_jobs_active',
				columns: ['id'],
				where: predicate,
			},
			...additionalIndexes,
		],
	};
	return new ModelIRImpl(
		new Map([['jobs', jobs]]),
		new Map(),
		new Map([['job_state', { name: 'job_state', values: enumValues }]]),
	);
}

/**
 * `pg_get_expr` omits a type qualification while `public` is on the search
 * path, but the catalog-only canonical deparse must restore it.  Keep the
 * desired predicate unqualified so that only canonicalising both sides can
 * make the live comparison converge.
 */
function publicEnumModel(predicate: string): ModelIR {
	const jobs: TableIR = {
		name: 'jobs',
		columns: [
			{ name: 'id', type: 'integer', nullable: false },
			{
				name: 'state',
				type: 'string',
				nullable: false,
				originalDbType: PUBLIC_ENUM,
				originalDbTypeSchema: 'public',
				originalDbTypeSchemaScope: 'absolute',
			},
		],
		foreignKeys: [],
		indexes: [
			{
				name: 'idx_jobs_active',
				columns: ['id'],
				where: predicate,
				expressions: [],
			},
		],
	};
	return new ModelIRImpl(new Map([['jobs', jobs]]), new Map(), new Map());
}

describe('#383 partial-index predicate canonicalization (real PG)', () => {
	let pool: Awaited<ReturnType<typeof getTestPool>>;
	let adapter: ReturnType<typeof createPgsqlAdapter>;

	beforeAll(async () => {
		pool = await getTestPool();
		adapter = createPgsqlAdapter(pool);
	});

	beforeEach(async () => {
		await dropSchema(SCHEMA);
		await createSchema(SCHEMA);
		await pool.query(
			`CREATE TYPE "${SCHEMA}".job_state AS ENUM ('active', 'inactive')`,
		);
		await pool.query(
			`CREATE TABLE "${SCHEMA}".jobs (id integer NOT NULL, state "${SCHEMA}".job_state NOT NULL, note text)`,
		);
		await pool.query(
			`CREATE INDEX idx_jobs_active ON "${SCHEMA}".jobs (id) WHERE state = 'active'`,
		);
	});

	afterAll(async () => {
		await runCleanup(
			() => dropSchema(SCHEMA),
			() => closeTestDb(),
		);
	});

	it('turns enum-label spelling drift into an empty live re-diff, while raw comparison proves the case is non-vacuous', async () => {
		const desired = model("state = 'active'");
		const rawDatabase = await adapter.introspect({ schema: SCHEMA });
		expect(
			compareSchemata(desired, rawDatabase, {
				ignoreUnmanagedExtensions: true,
			}).changes,
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: 'create_index' }),
				expect.objectContaining({ kind: 'drop_index' }),
			]),
		);
		const diff = await comparePgsqlDatabaseSchema(adapter, desired, {
			schema: SCHEMA,
			ignoreUnmanagedExtensions: true,
		});
		expect(diff.changes).toEqual([]);
	});

	it('canonicalizes the introspected predicate when its public enum qualification is absent from the desired side', async () => {
		await dropSchema(SCHEMA);
		await createSchema(SCHEMA);
		await pool.query(`DROP TYPE IF EXISTS public.${PUBLIC_ENUM}`);
		await pool.query(
			`CREATE TYPE public.${PUBLIC_ENUM} AS ENUM ('active', 'inactive')`,
		);
		await pool.query(
			`CREATE TABLE "${SCHEMA}".jobs (id integer NOT NULL, state public.${PUBLIC_ENUM} NOT NULL)`,
		);
		await pool.query(
			`CREATE INDEX idx_jobs_active ON "${SCHEMA}".jobs (id) WHERE state = 'active'`,
		);

		try {
			const desired = publicEnumModel("state = 'active'");
			const rawDatabase = await adapter.introspect({ schema: SCHEMA });
			const rawIndex = rawDatabase.tables
				.get('jobs')
				?.indexes.find((index) => index.name === 'idx_jobs_active');
			expect(rawIndex?.expressions).toBeUndefined();
			expect(
				compareSchemata(desired, rawDatabase, {
					ignoreUnmanagedExtensions: true,
				}).changes,
			).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ kind: 'create_index' }),
					expect.objectContaining({ kind: 'drop_index' }),
				]),
			);

			const diff = await comparePgsqlDatabaseSchema(adapter, desired, {
				schema: SCHEMA,
				ignoreUnmanagedExtensions: true,
			});
			expect(diff.changes).toEqual([]);
		} finally {
			await runCleanup(
				() => dropSchema(SCHEMA),
				() => pool.query(`DROP TYPE IF EXISTS public.${PUBLIC_ENUM}`),
			);
		}
	});

	it('refuses a migration when PostgreSQL rejects the predicate', async () => {
		const warning = vi.fn();
		await expect(
			comparePgsqlDatabaseSchema(adapter, model('missing = true'), {
				schema: SCHEMA,
				ignoreUnmanagedExtensions: true,
				onExpressionCanonicalizationWarning: warning,
			}),
		).rejects.toBeInstanceOf(IndexPredicateCanonicalizationError);
		expect(warning).toHaveBeenCalledWith(
			expect.objectContaining({ kind: 'index_predicate', outcome: 'rejected' }),
		);
	});

	it('canonicalizes a predicate on a column added by the migration against the desired table shape', async () => {
		await pool.query(`DROP TABLE "${SCHEMA}".jobs`);
		await pool.query(`CREATE TABLE "${SCHEMA}".jobs (id integer NOT NULL)`);

		const diff = await comparePgsqlDatabaseSchema(
			adapter,
			model("state = 'active'"),
			{
				schema: SCHEMA,
				ignoreUnmanagedExtensions: true,
			},
		);

		expect(diff.changes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: 'add_column' }),
				expect.objectContaining({ kind: 'create_index' }),
			]),
		);
	});

	it('refuses a rejected predicate in strict mode', async () => {
		await expect(
			comparePgsqlDatabaseSchema(adapter, model('missing = true'), {
				schema: SCHEMA,
				ignoreUnmanagedExtensions: true,
				requireExpressionCanonicalization: true,
			}),
		).rejects.toBeInstanceOf(Error);
	});

	it('reports same-migration enum additions as candidates for a rejected predicate', async () => {
		await expect(
			comparePgsqlDatabaseSchema(
				adapter,
				model('missing = true', ['active', 'inactive', 'pending']),
				{
					schema: SCHEMA,
					ignoreUnmanagedExtensions: true,
				},
			),
		).rejects.toMatchObject({
			addedEnumValues: [{ enumName: 'job_state', value: 'pending' }],
		});
	});

	it('still emits a replacement for a true predicate change', async () => {
		const diff = await comparePgsqlDatabaseSchema(
			adapter,
			model("state = 'inactive'"),
			{
				schema: SCHEMA,
				ignoreUnmanagedExtensions: true,
			},
		);
		expect(diff.changes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: 'create_index' }),
				expect.objectContaining({ kind: 'drop_index' }),
			]),
		);
	});

	it('emits a non-empty migration from a live-canonicalized predicate containing a backslash', async () => {
		const diff = await comparePgsqlDatabaseSchema(
			adapter,
			model("state = 'active'", undefined, [
				{
					name: 'idx_jobs_note_pattern',
					columns: ['id'],
					where: String.raw`note ~ $$\d+$$`,
				},
			]),
			{
				schema: SCHEMA,
				ignoreUnmanagedExtensions: true,
			},
		);
		const statements = generateMigrationSQL(diff, {
			schemaName: SCHEMA,
		});

		expect(statements).toEqual([expect.stringContaining('CREATE INDEX ')]);
		expect(statements[0]).toContain(String.raw`note ~ E'\\d+'::text`);
	});

	it('preserves a canonicalized backslash predicate when generated SQL auto-commits', async () => {
		const diff = await comparePgsqlDatabaseSchema(
			adapter,
			model("state = 'active'", undefined, [
				{
					name: 'idx_jobs_note_pattern',
					columns: ['id'],
					where: String.raw`note ~ $$\d+$$`,
				},
			]),
			{
				schema: SCHEMA,
				ignoreUnmanagedExtensions: true,
			},
		);
		const statements = generateMigrationSQL(diff, {
			schemaName: SCHEMA,
		});
		const client = await pool.connect();

		try {
			await client.query('SET standard_conforming_strings = off');
			for (const statement of statements) {
				await client.query(statement);
			}

			expect(statements).not.toContain('SET standard_conforming_strings = on;');
			expect(statements).not.toContain(
				'SET LOCAL standard_conforming_strings = on;',
			);

			const setting = await client.query<{
				standard_conforming_strings: string;
			}>('SHOW standard_conforming_strings');
			expect(setting.rows[0]?.standard_conforming_strings).toBe('off');

			const predicate = await client.query<{ predicate: string }>(
				`SELECT pg_get_expr(i.indpred, i.indrelid) AS predicate
				 FROM pg_index i
				 JOIN pg_class c ON c.oid = i.indexrelid
				 JOIN pg_namespace n ON n.oid = c.relnamespace
				 WHERE n.nspname = $1 AND c.relname = 'idx_jobs_note_pattern'`,
				[SCHEMA],
			);
			expect(predicate.rows[0]?.predicate).toContain(String.raw`\d+`);
		} finally {
			await runCleanup(
				() => client.query('RESET standard_conforming_strings'),
				() => client.release(),
			);
		}
	});
});
