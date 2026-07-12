import { ModelIRImpl } from '@dbsp/core';
import type { ColumnIR, EnumIR, ModelIR, TableIR } from '@dbsp/types';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { compareSchemata } from './ddl/schema-diff.js';
import {
	CheckConstraintCanonicalizationError,
	canonicalizeCheckConstraints,
} from './expression-canonicalizer.js';

function makeCol(name: string, overrides: Partial<ColumnIR> = {}): ColumnIR {
	return {
		name,
		type: 'number',
		nullable: false,
		...overrides,
	};
}

function makeTable(overrides: Partial<TableIR> & { name: string }): TableIR {
	return {
		columns: [makeCol('id')],
		foreignKeys: [],
		indexes: [],
		...overrides,
	};
}

function makeModel(
	tables: readonly TableIR[],
	enums?: readonly EnumIR[],
): ModelIR {
	return new ModelIRImpl(
		new Map(tables.map((table) => [table.name, table])),
		new Map(),
		enums === undefined
			? undefined
			: new Map(enums.map((enumDef) => [enumDef.name, enumDef])),
	);
}

function normalizeSql(sql: string): string {
	return sql.replace(/\s+/g, ' ').trim();
}

function normalizeCanonicalizationSql(sql: string): string {
	return normalizeSql(sql)
		.replace(
			/\bdbsp_check_canon_[a-z0-9]+_(root|sp_\d+|enum_\d+)\b/giu,
			'dbsp_check_canon_$1',
		)
		.replace(
			/_dbsp_check_canon_[a-z0-9]+_(\d+(?:_\d+)?)/giu,
			'_dbsp_check_canon_$1',
		);
}

function legacyCanonicalizationName(name: string): string {
	return name.replace(
		/^_dbsp_check_canon_[a-z0-9]+_(\d+_\d+)$/iu,
		'_dbsp_check_canon_$1',
	);
}

class FakePgClient {
	readonly queries: Array<{
		readonly sql: string;
		readonly parameters: readonly unknown[] | undefined;
	}> = [];
	readonly tempTables = new Set<string>();
	readonly preexistingTempTables = new Set<string>();
	readonly canonicalExpressions = new Map<string, string>();
	failOnSql: RegExp | undefined;
	failOnSqlError: Error | undefined;
	/**
	 * Whether the client starts inside a transaction. A caller-owned client handed
	 * to the canonicaliser may be either; PostgreSQL rejects SAVEPOINT outside a
	 * transaction block with 25P01, and this fake reproduces that.
	 */
	inTransaction = true;
	readonly release = vi.fn();

	async query<T extends Record<string, unknown> = Record<string, unknown>>(
		sql: string,
		parameters?: readonly unknown[],
	): Promise<QueryResult<T>> {
		this.queries.push({ sql, parameters });
		const normalized = normalizeSql(sql);
		if (this.failOnSql?.test(normalized)) {
			throw this.failOnSqlError ?? new Error('DDL refused');
		}

		if (normalized.startsWith('SAVEPOINT ') && !this.inTransaction) {
			throw Object.assign(new Error('no transaction is in progress'), {
				code: '25P01',
			});
		}
		if (normalized === 'BEGIN') {
			this.inTransaction = true;
		}

		const createMatch = /^CREATE TEMP TABLE "([^"]+)"/u.exec(normalized);
		if (createMatch) {
			const tempTableName = createMatch[1]!;
			if (
				this.preexistingTempTables.has(tempTableName) ||
				this.tempTables.has(tempTableName)
			) {
				throw new Error(`relation "${tempTableName}" already exists`);
			}
			this.tempTables.add(tempTableName);
		}

		if (
			normalized === 'ROLLBACK' ||
			normalized.startsWith('ROLLBACK TO SAVEPOINT')
		) {
			this.tempTables.clear();
		}

		if (normalized.startsWith('SELECT conname AS name,')) {
			const names = parameters?.[1] as readonly string[];
			return {
				rows: names.map((name) => ({
					name,
					expression:
						this.canonicalExpressions.get(name) ??
						this.canonicalExpressions.get(legacyCanonicalizationName(name)) ??
						`CHECK ((canonical_${name}))`,
				})) as T[],
				rowCount: names.length,
			} as QueryResult<T>;
		}

		return { rows: [], rowCount: 0 } as QueryResult<T>;
	}
}

class FakePgPool {
	readonly connect = vi.fn(async () => this.client as unknown as PoolClient);

	constructor(readonly client: FakePgClient) {}
}

function createdTempTableNames(client: FakePgClient): string[] {
	const names: string[] = [];
	for (const query of client.queries) {
		const match = /^CREATE TEMP TABLE "([^"]+)"/u.exec(normalizeSql(query.sql));
		if (match) {
			names.push(match[1]!);
		}
	}
	return names;
}

describe('canonicalizeCheckConstraints', () => {
	it('batches CHECK canonicalization one desired-shaped temp table per target table and rolls it back', async () => {
		const client = new FakePgClient();
		client.canonicalExpressions.set(
			'_dbsp_check_canon_0_0',
			'CHECK ((age > 0))',
		);
		client.canonicalExpressions.set(
			'_dbsp_check_canon_0_1',
			"CHECK (((status)::text = 'active'::text))",
		);
		client.canonicalExpressions.set(
			'_dbsp_check_canon_1_0',
			'CHECK ((price > 0))',
		);
		const pool = new FakePgPool(client);
		const desired = makeModel([
			makeTable({
				name: 'users',
				columns: [
					makeCol('id'),
					makeCol('age'),
					makeCol('status', { type: 'string' }),
				],
				checkConstraints: [
					{ name: 'users_age_check', expression: 'age > 0' },
					{
						name: 'users_status_check',
						expression: "CHECK (status = 'active')",
					},
				],
			}),
			makeTable({
				name: 'products',
				columns: [makeCol('id'), makeCol('price')],
				checkConstraints: [
					{ name: 'products_price_check', expression: 'CHECK (price > 0)' },
				],
			}),
			makeTable({ name: 'logs' }),
		]);
		const dbModel = makeModel([
			makeTable({
				name: 'users',
				columns: [makeCol('id')],
			}),
			makeTable({ name: 'products' }),
			makeTable({ name: 'logs' }),
		]);

		const canonical = await canonicalizeCheckConstraints(
			pool as unknown as Pool,
			desired,
			dbModel,
			{ schemaName: 'public' },
		);

		const normalizedQueries = client.queries.map((q) =>
			normalizeCanonicalizationSql(q.sql),
		);
		expect(normalizedQueries).toEqual([
			'BEGIN',
			'SAVEPOINT dbsp_check_canon_sp_0',
			'CREATE TEMP TABLE "_dbsp_check_canon_0" ("id" INTEGER, "age" INTEGER, "status" VARCHAR(255)) ON COMMIT DROP',
			'ALTER TABLE "_dbsp_check_canon_0" ADD CONSTRAINT "_dbsp_check_canon_0_0" CHECK (age > 0)',
			'ALTER TABLE "_dbsp_check_canon_0" ADD CONSTRAINT "_dbsp_check_canon_0_1" CHECK (status = \'active\')',
			'SELECT conname AS name, pg_get_constraintdef(oid, false) AS expression FROM pg_constraint WHERE conrelid = $1::regclass AND conname = ANY($2::text[]) ORDER BY array_position($2::text[], conname)',
			'RELEASE SAVEPOINT dbsp_check_canon_sp_0',
			'SAVEPOINT dbsp_check_canon_sp_1',
			'CREATE TEMP TABLE "_dbsp_check_canon_1" ("id" INTEGER, "price" INTEGER) ON COMMIT DROP',
			'ALTER TABLE "_dbsp_check_canon_1" ADD CONSTRAINT "_dbsp_check_canon_1_0" CHECK (price > 0)',
			'SELECT conname AS name, pg_get_constraintdef(oid, false) AS expression FROM pg_constraint WHERE conrelid = $1::regclass AND conname = ANY($2::text[]) ORDER BY array_position($2::text[], conname)',
			'RELEASE SAVEPOINT dbsp_check_canon_sp_1',
			'ROLLBACK',
		]);
		expect(client.tempTables.size).toBe(0);
		expect(client.release).toHaveBeenCalledTimes(1);

		const users = canonical.tables.get('users');
		const products = canonical.tables.get('products');
		expect(users?.checkConstraints).toEqual([
			{ name: 'users_age_check', expression: 'CHECK ((age > 0))' },
			{
				name: 'users_status_check',
				expression: "CHECK (((status)::text = 'active'::text))",
			},
		]);
		expect(products?.checkConstraints).toEqual([
			{ name: 'products_price_check', expression: 'CHECK ((price > 0))' },
		]);
	});

	it('uses a caller-owned PoolClient inside savepoints without BEGIN, bare ROLLBACK, or release', async () => {
		const client = new FakePgClient();
		client.canonicalExpressions.set(
			'_dbsp_check_canon_0_0',
			'CHECK ((age > 0))',
		);
		const desired = makeModel([
			makeTable({
				name: 'users',
				columns: [makeCol('id'), makeCol('age')],
				checkConstraints: [{ name: 'users_age_check', expression: 'age > 0' }],
			}),
		]);
		const dbModel = makeModel([
			makeTable({
				name: 'users',
				columns: [makeCol('id'), makeCol('age')],
				checkConstraints: [
					{ name: 'users_age_check', expression: 'CHECK ((age > 0))' },
				],
			}),
		]);

		const canonical = await canonicalizeCheckConstraints(
			client as unknown as PoolClient,
			desired,
			dbModel,
		);

		expect(canonical.tables.get('users')?.checkConstraints).toEqual([
			{ name: 'users_age_check', expression: 'CHECK ((age > 0))' },
		]);
		expect(client.release).not.toHaveBeenCalled();
		expect(
			client.queries.map((q) => normalizeCanonicalizationSql(q.sql)),
		).toEqual([
			'SAVEPOINT dbsp_check_canon_root',
			'SAVEPOINT dbsp_check_canon_sp_0',
			'CREATE TEMP TABLE "_dbsp_check_canon_0" ("id" INTEGER, "age" INTEGER) ON COMMIT DROP',
			'ALTER TABLE "_dbsp_check_canon_0" ADD CONSTRAINT "_dbsp_check_canon_0_0" CHECK (age > 0)',
			'SELECT conname AS name, pg_get_constraintdef(oid, false) AS expression FROM pg_constraint WHERE conrelid = $1::regclass AND conname = ANY($2::text[]) ORDER BY array_position($2::text[], conname)',
			'RELEASE SAVEPOINT dbsp_check_canon_sp_0',
			'ROLLBACK TO SAVEPOINT dbsp_check_canon_root',
			'RELEASE SAVEPOINT dbsp_check_canon_root',
		]);
	});

	it('uses unique scratch identifiers per call without colliding with the old fixed temp name', async () => {
		const client = new FakePgClient();
		client.preexistingTempTables.add('_dbsp_check_canon_0');
		client.canonicalExpressions.set(
			'_dbsp_check_canon_0_0',
			'CHECK ((age > 0))',
		);
		const desired = makeModel([
			makeTable({
				name: 'users',
				columns: [makeCol('id'), makeCol('age')],
				checkConstraints: [{ name: 'users_age_check', expression: 'age > 0' }],
			}),
		]);
		const dbModel = makeModel([
			makeTable({
				name: 'users',
				columns: [makeCol('id'), makeCol('age')],
			}),
		]);
		const warnings = vi.fn();

		const first = await canonicalizeCheckConstraints(
			client as unknown as PoolClient,
			desired,
			dbModel,
			{ onWarning: warnings },
		);
		const second = await canonicalizeCheckConstraints(
			client as unknown as PoolClient,
			desired,
			dbModel,
			{ onWarning: warnings },
		);

		expect(first.tables.get('users')?.checkConstraints).toEqual([
			{ name: 'users_age_check', expression: 'CHECK ((age > 0))' },
		]);
		expect(second.tables.get('users')?.checkConstraints).toEqual([
			{ name: 'users_age_check', expression: 'CHECK ((age > 0))' },
		]);
		expect(warnings).not.toHaveBeenCalled();
		const scratchNames = createdTempTableNames(client);
		expect(scratchNames).toHaveLength(2);
		expect(new Set(scratchNames).size).toBe(2);
		expect(scratchNames).not.toContain('_dbsp_check_canon_0');
	});

	it('creates missing desired enum types inside the rolled-back transaction before scratch tables', async () => {
		const client = new FakePgClient();
		client.canonicalExpressions.set(
			'_dbsp_check_canon_0_0',
			"CHECK (((status)::text = 'active'::text))",
		);
		const pool = new FakePgPool(client);
		const desired = makeModel(
			[
				makeTable({
					name: 'jobs',
					columns: [
						makeCol('id'),
						makeCol('status', {
							type: 'string',
							originalDbType: 'status',
						}),
					],
					checkConstraints: [
						{ name: 'jobs_status_check', expression: "status = 'active'" },
					],
				}),
			],
			[{ name: 'status', values: ['active', 'inactive'] }],
		);
		const dbModel = makeModel([makeTable({ name: 'jobs' })]);

		const canonical = await canonicalizeCheckConstraints(
			pool as unknown as Pool,
			desired,
			dbModel,
		);

		const normalizedQueries = client.queries.map((q) =>
			normalizeCanonicalizationSql(q.sql),
		);
		expect(normalizedQueries).toEqual([
			'BEGIN',
			'SAVEPOINT dbsp_check_canon_enum_0',
			"CREATE TYPE \"status\" AS ENUM ('active', 'inactive');",
			'RELEASE SAVEPOINT dbsp_check_canon_enum_0',
			'SAVEPOINT dbsp_check_canon_sp_0',
			'CREATE TEMP TABLE "_dbsp_check_canon_0" ("id" INTEGER, "status" status) ON COMMIT DROP',
			'ALTER TABLE "_dbsp_check_canon_0" ADD CONSTRAINT "_dbsp_check_canon_0_0" CHECK (status = \'active\')',
			'SELECT conname AS name, pg_get_constraintdef(oid, false) AS expression FROM pg_constraint WHERE conrelid = $1::regclass AND conname = ANY($2::text[]) ORDER BY array_position($2::text[], conname)',
			'RELEASE SAVEPOINT dbsp_check_canon_sp_0',
			'ROLLBACK',
		]);
		expect(client.tempTables.size).toBe(0);
		expect(canonical.tables.get('jobs')?.checkConstraints).toEqual([
			{
				name: 'jobs_status_check',
				expression: "CHECK (((status)::text = 'active'::text))",
			},
		]);
	});

	it('creates missing desired enum types in the verbatim database schemaName', async () => {
		const client = new FakePgClient();
		client.canonicalExpressions.set(
			'_dbsp_check_canon_0_0',
			"CHECK (((status)::text = 'active'::text))",
		);
		const pool = new FakePgPool(client);
		const desired = makeModel(
			[
				makeTable({
					name: 'jobs',
					columns: [
						makeCol('id'),
						makeCol('status', {
							type: 'string',
							originalDbType: 'status',
							originalDbTypeSchema: 'tenantOne',
							originalDbTypeSchemaScope: 'target',
						}),
					],
					checkConstraints: [
						{ name: 'jobsStatusCheck', expression: "status = 'active'" },
					],
				}),
			],
			[
				{
					name: 'status',
					schema: 'tenantOne',
					values: ['active', 'inactive'],
				},
			],
		);
		const dbModel = makeModel([makeTable({ name: 'jobs' })]);

		await canonicalizeCheckConstraints(
			pool as unknown as Pool,
			desired,
			dbModel,
			{ schemaName: 'tenantOne', dbCasing: 'snake_case' },
		);

		const normalizedQueries = client.queries.map((q) =>
			normalizeCanonicalizationSql(q.sql),
		);
		expect(normalizedQueries).toContain(
			'CREATE TYPE "tenantOne"."status" AS ENUM (\'active\', \'inactive\');',
		);
		expect(normalizedQueries).not.toContain(
			'CREATE TYPE "tenant_one"."status" AS ENUM (\'active\', \'inactive\');',
		);
	});

	it('falls back with a warning when a CHECK references an enum value added by the same diff', async () => {
		const enumValueError = new Error(
			'unsafe use of new value "pending" of enum type status',
		);
		const client = new FakePgClient();
		client.failOnSql = /^ALTER TABLE .*CHECK \(status = 'pending'\)$/u;
		client.failOnSqlError = enumValueError;
		const pool = new FakePgPool(client);
		const warnings: Array<{
			readonly table: string;
			readonly constraint: string;
			readonly message: string;
		}> = [];
		const desired = makeModel(
			[
				makeTable({
					name: 'jobs',
					columns: [
						makeCol('id'),
						makeCol('status', {
							type: 'string',
							originalDbType: 'status',
						}),
					],
					checkConstraints: [
						{ name: 'jobs_status_check', expression: "status = 'pending'" },
					],
				}),
			],
			[{ name: 'status', values: ['active', 'pending'] }],
		);
		const dbModel = makeModel(
			[
				makeTable({
					name: 'jobs',
					columns: [
						makeCol('id'),
						makeCol('status', {
							type: 'string',
							originalDbType: 'status',
						}),
					],
				}),
			],
			[{ name: 'status', values: ['active'] }],
		);

		const canonical = await canonicalizeCheckConstraints(
			pool as unknown as Pool,
			desired,
			dbModel,
			{ onWarning: (warning) => warnings.push(warning) },
		);

		expect(canonical.tables.get('jobs')?.checkConstraints).toEqual([
			{ name: 'jobs_status_check', expression: "status = 'pending'" },
		]);
		expect(warnings).toEqual([
			expect.objectContaining({
				table: 'jobs',
				constraint: 'jobs_status_check',
				message: expect.stringContaining(
					'Could not canonicalize CHECK constraint "jobs"."jobs_status_check"',
				),
			}),
		]);
		expect(warnings[0]!.message).toContain('unsafe use of new value "pending"');
		expect(
			client.queries.map((q) => normalizeCanonicalizationSql(q.sql)),
		).toEqual([
			'BEGIN',
			'SAVEPOINT dbsp_check_canon_sp_0',
			'CREATE TEMP TABLE "_dbsp_check_canon_0" ("id" INTEGER, "status" status) ON COMMIT DROP',
			'ALTER TABLE "_dbsp_check_canon_0" ADD CONSTRAINT "_dbsp_check_canon_0_0" CHECK (status = \'pending\')',
			'ROLLBACK TO SAVEPOINT dbsp_check_canon_sp_0',
			'RELEASE SAVEPOINT dbsp_check_canon_sp_0',
			'ROLLBACK',
		]);
	});

	it('throws in strict mode when a CHECK references an enum value added by the same diff', async () => {
		const client = new FakePgClient();
		client.failOnSql = /^ALTER TABLE .*CHECK \(status = 'pending'\)$/u;
		client.failOnSqlError = new Error(
			'unsafe use of new value "pending" of enum type status',
		);
		const pool = new FakePgPool(client);
		const desired = makeModel(
			[
				makeTable({
					name: 'jobs',
					columns: [
						makeCol('id'),
						makeCol('status', {
							type: 'string',
							originalDbType: 'status',
						}),
					],
					checkConstraints: [
						{ name: 'jobs_status_check', expression: "status = 'pending'" },
					],
				}),
			],
			[{ name: 'status', values: ['active', 'pending'] }],
		);
		const dbModel = makeModel(
			[
				makeTable({
					name: 'jobs',
					columns: [
						makeCol('id'),
						makeCol('status', {
							type: 'string',
							originalDbType: 'status',
						}),
					],
				}),
			],
			[{ name: 'status', values: ['active'] }],
		);

		await expect(
			canonicalizeCheckConstraints(pool as unknown as Pool, desired, dbModel, {
				requireCanonicalization: true,
			}),
		).rejects.toThrow(CheckConstraintCanonicalizationError);
		expect(
			client.queries.map((q) => normalizeCanonicalizationSql(q.sql)),
		).toEqual([
			'BEGIN',
			'SAVEPOINT dbsp_check_canon_sp_0',
			'CREATE TEMP TABLE "_dbsp_check_canon_0" ("id" INTEGER, "status" status) ON COMMIT DROP',
			'ALTER TABLE "_dbsp_check_canon_0" ADD CONSTRAINT "_dbsp_check_canon_0_0" CHECK (status = \'pending\')',
			'ROLLBACK TO SAVEPOINT dbsp_check_canon_sp_0',
			'RELEASE SAVEPOINT dbsp_check_canon_sp_0',
			'ROLLBACK',
		]);
	});

	it('canonicalizes a bare CHECK predicate for a table absent from the database model', async () => {
		const client = new FakePgClient();
		client.canonicalExpressions.set(
			'_dbsp_check_canon_0_0',
			'CHECK ((amount > 0))',
		);
		const pool = new FakePgPool(client);
		const desired = makeModel([
			makeTable({
				name: 'payments',
				columns: [makeCol('id'), makeCol('amount')],
				checkConstraints: [
					{ name: 'payments_amount_check', expression: 'amount > 0' },
				],
			}),
		]);
		const dbModel = makeModel([]);

		const canonical = await canonicalizeCheckConstraints(
			pool as unknown as Pool,
			desired,
			dbModel,
		);

		expect(
			client.queries.map((q) => normalizeCanonicalizationSql(q.sql)),
		).toEqual([
			'BEGIN',
			'SAVEPOINT dbsp_check_canon_sp_0',
			'CREATE TEMP TABLE "_dbsp_check_canon_0" ("id" INTEGER, "amount" INTEGER) ON COMMIT DROP',
			'ALTER TABLE "_dbsp_check_canon_0" ADD CONSTRAINT "_dbsp_check_canon_0_0" CHECK (amount > 0)',
			'SELECT conname AS name, pg_get_constraintdef(oid, false) AS expression FROM pg_constraint WHERE conrelid = $1::regclass AND conname = ANY($2::text[]) ORDER BY array_position($2::text[], conname)',
			'RELEASE SAVEPOINT dbsp_check_canon_sp_0',
			'ROLLBACK',
		]);
		expect(canonical.tables.get('payments')?.checkConstraints).toEqual([
			{ name: 'payments_amount_check', expression: 'CHECK ((amount > 0))' },
		]);
		expect(client.tempTables.size).toBe(0);
	});

	it('types an existing desired column from the database column when originalDbType is absent', async () => {
		const client = new FakePgClient();
		client.canonicalExpressions.set(
			'_dbsp_check_canon_0_0',
			"CHECK (((state)::text <> 'done'::text))",
		);
		const pool = new FakePgPool(client);
		const desired = makeModel(
			[
				makeTable({
					name: 'jobs',
					columns: [
						makeCol('id'),
						makeCol('state', {
							type: 'string',
						}),
					],
					checkConstraints: [
						{ name: 'jobs_state_check', expression: "state <> 'done'" },
					],
				}),
			],
			[{ name: 'status', schema: 'tenant_1', values: ['queued', 'done'] }],
		);
		const dbModel = makeModel(
			[
				makeTable({
					name: 'jobs',
					columns: [
						makeCol('id'),
						makeCol('state', {
							type: 'string',
							originalDbType: 'status',
							originalDbTypeSchema: 'tenant_1',
							originalDbTypeSchemaScope: 'target',
						}),
					],
				}),
			],
			[{ name: 'status', schema: 'tenant_1', values: ['queued', 'done'] }],
		);

		await canonicalizeCheckConstraints(
			pool as unknown as Pool,
			desired,
			dbModel,
			{ schemaName: 'tenant_1' },
		);

		expect(
			client.queries.map((q) => normalizeCanonicalizationSql(q.sql)),
		).toContain(
			'CREATE TEMP TABLE "_dbsp_check_canon_0" ("id" INTEGER, "state" "tenant_1".status) ON COMMIT DROP',
		);
	});

	it('uses the database schemaName verbatim when dbCasing is configured', async () => {
		const client = new FakePgClient();
		client.canonicalExpressions.set(
			'_dbsp_check_canon_0_0',
			"CHECK (((state)::text = 'queued'::text))",
		);
		const pool = new FakePgPool(client);
		const desired = makeModel(
			[
				makeTable({
					name: 'jobs',
					columns: [
						makeCol('id'),
						makeCol('state', {
							type: 'string',
							originalDbType: 'status',
							originalDbTypeSchema: 'tenantOne',
							originalDbTypeSchemaScope: 'target',
						}),
					],
					checkConstraints: [
						{ name: 'jobsStateCheck', expression: "state = 'queued'" },
					],
				}),
			],
			[{ name: 'status', schema: 'tenantOne', values: ['queued', 'done'] }],
		);
		const dbModel = makeModel(
			[
				makeTable({
					name: 'jobs',
					columns: [
						makeCol('id'),
						makeCol('state', {
							type: 'string',
							originalDbType: 'status',
							originalDbTypeSchema: 'tenantOne',
							originalDbTypeSchemaScope: 'target',
						}),
					],
				}),
			],
			[{ name: 'status', schema: 'tenantOne', values: ['queued', 'done'] }],
		);

		await canonicalizeCheckConstraints(
			pool as unknown as Pool,
			desired,
			dbModel,
			{ schemaName: 'tenantOne', dbCasing: 'snake_case' },
		);

		expect(
			client.queries.map((q) => normalizeCanonicalizationSql(q.sql)),
		).toContain(
			'CREATE TEMP TABLE "_dbsp_check_canon_0" ("id" INTEGER, "state" "tenantOne".status) ON COMMIT DROP',
		);
		expect(
			client.queries.some((q) => q.sql.includes('"tenant_one".status')),
		).toBe(false);
	});

	it('keeps the desired type when the same diff changes a column type', async () => {
		const client = new FakePgClient();
		client.canonicalExpressions.set(
			'_dbsp_check_canon_0_0',
			'CHECK ((state > 0))',
		);
		const pool = new FakePgPool(client);
		const desired = makeModel([
			makeTable({
				name: 'jobs',
				columns: [
					makeCol('id'),
					makeCol('state', {
						type: 'integer',
					}),
				],
				checkConstraints: [
					{ name: 'jobs_state_check', expression: 'state > 0' },
				],
			}),
		]);
		const dbModel = makeModel([
			makeTable({
				name: 'jobs',
				columns: [
					makeCol('id'),
					makeCol('state', {
						type: 'string',
						originalDbType: 'status',
						originalDbTypeSchema: 'tenant_1',
						originalDbTypeSchemaScope: 'target',
					}),
				],
			}),
		]);

		await canonicalizeCheckConstraints(
			pool as unknown as Pool,
			desired,
			dbModel,
			{ schemaName: 'tenant_1' },
		);

		expect(
			client.queries.map((q) => normalizeCanonicalizationSql(q.sql)),
		).toContain(
			'CREATE TEMP TABLE "_dbsp_check_canon_0" ("id" INTEGER, "state" INTEGER) ON COMMIT DROP',
		);
	});

	for (const testCase of [
		{
			label: 'DEFAULT',
			column: makeCol('subject', {
				default: { sql: "nextval('missing_subject_seq'::regclass)" },
			}),
			forbiddenClause: /DEFAULT/u,
			expectedType: 'INTEGER',
		},
		{
			label: 'UNIQUE',
			column: makeCol('subject', { type: 'string', unique: true }),
			forbiddenClause: /UNIQUE/u,
			expectedType: 'VARCHAR(255)',
		},
		{
			label: 'identity',
			column: makeCol('subject', { identity: 'always' }),
			forbiddenClause: /GENERATED/u,
			expectedType: 'INTEGER',
		},
	] as const) {
		it(`canonicalizes a CHECK when the checked column has ${testCase.label} using only name and type`, async () => {
			const client = new FakePgClient();
			client.failOnSql = testCase.forbiddenClause;
			client.canonicalExpressions.set(
				'_dbsp_check_canon_0_0',
				'CHECK ((subject > 0))',
			);
			const pool = new FakePgPool(client);
			const tableName = `scratch_${testCase.label.toLowerCase()}`;
			const check = {
				name: `${tableName}_subject_check`,
				expression: 'subject > 0',
			};
			const dbCheck = { ...check, expression: 'CHECK ((subject > 0))' };
			const desired = makeModel([
				makeTable({
					name: tableName,
					columns: [testCase.column],
					checkConstraints: [check],
				}),
			]);
			const dbModel = makeModel([
				makeTable({
					name: tableName,
					columns: [testCase.column],
					checkConstraints: [dbCheck],
				}),
			]);

			const canonical = await canonicalizeCheckConstraints(
				pool as unknown as Pool,
				desired,
				dbModel,
			);

			expect(
				client.queries.map((q) => normalizeCanonicalizationSql(q.sql)),
			).toContain(
				`CREATE TEMP TABLE "_dbsp_check_canon_0" ("subject" ${testCase.expectedType}) ON COMMIT DROP`,
			);
			expect(canonical.tables.get(tableName)?.checkConstraints).toEqual([
				dbCheck,
			]);
			expect(compareSchemata(canonical, dbModel).changes).toEqual([]);
		});
	}

	it('falls back to raw CHECK comparison with a warning when scratch DDL is refused', async () => {
		const client = new FakePgClient();
		client.failOnSql = /^CREATE TEMP TABLE/u;
		const pool = new FakePgPool(client);
		const warnings: string[] = [];
		const desired = makeModel([
			makeTable({
				name: 'users',
				columns: [makeCol('id'), makeCol('age')],
				checkConstraints: [{ name: 'users_age_check', expression: 'age > 0' }],
			}),
		]);
		const dbModel = makeModel([makeTable({ name: 'users' })]);

		const canonical = await canonicalizeCheckConstraints(
			pool as unknown as Pool,
			desired,
			dbModel,
			{ onWarning: (warning) => warnings.push(warning.message) },
		);

		expect(canonical).not.toBe(desired);
		expect(canonical.tables.get('users')?.checkConstraints).toEqual([
			{ name: 'users_age_check', expression: 'age > 0' },
		]);
		expect(warnings).toEqual([
			expect.stringContaining(
				'Could not canonicalize CHECK constraint "users"."users_age_check"',
			),
		]);
		expect(warnings[0]).toContain('best-effort raw string comparison');
		expect(client.tempTables.size).toBe(0);
		expect(
			client.queries.map((q) => normalizeCanonicalizationSql(q.sql)),
		).toEqual([
			'BEGIN',
			'SAVEPOINT dbsp_check_canon_sp_0',
			'CREATE TEMP TABLE "_dbsp_check_canon_0" ("id" INTEGER, "age" INTEGER) ON COMMIT DROP',
			'ROLLBACK TO SAVEPOINT dbsp_check_canon_sp_0',
			'RELEASE SAVEPOINT dbsp_check_canon_sp_0',
			'ROLLBACK',
		]);
	});

	it('reports fallback warnings under the CHECK database name when dbCasing is configured', async () => {
		const client = new FakePgClient();
		client.failOnSql = /^CREATE TEMP TABLE/u;
		const pool = new FakePgPool(client);
		const warnings: Array<{
			readonly table: string;
			readonly constraint: string;
			readonly message: string;
		}> = [];
		const desired = makeModel([
			makeTable({
				name: 'users',
				columns: [makeCol('id'), makeCol('age')],
				checkConstraints: [{ name: 'usersAgeCheck', expression: 'age > 0' }],
			}),
		]);
		const dbModel = makeModel([makeTable({ name: 'users' })]);

		const canonical = await canonicalizeCheckConstraints(
			pool as unknown as Pool,
			desired,
			dbModel,
			{
				dbCasing: 'snake_case',
				onWarning: (warning) => warnings.push(warning),
			},
		);

		expect(canonical.tables.get('users')?.checkConstraints).toEqual([
			{ name: 'usersAgeCheck', expression: 'age > 0' },
		]);
		expect(warnings).toEqual([
			expect.objectContaining({
				table: 'users',
				constraint: 'users_age_check',
				message: expect.stringContaining(
					'Could not canonicalize CHECK constraint "users"."users_age_check"',
				),
			}),
		]);
	});

	it('throws in strict mode when scratch DDL is refused and still rolls back', async () => {
		const client = new FakePgClient();
		client.failOnSql = /^CREATE TEMP TABLE/u;
		const pool = new FakePgPool(client);
		const desired = makeModel([
			makeTable({
				name: 'users',
				columns: [makeCol('id'), makeCol('age')],
				checkConstraints: [{ name: 'users_age_check', expression: 'age > 0' }],
			}),
		]);
		const dbModel = makeModel([makeTable({ name: 'users' })]);

		await expect(
			canonicalizeCheckConstraints(pool as unknown as Pool, desired, dbModel, {
				requireCanonicalization: true,
			}),
		).rejects.toThrow(CheckConstraintCanonicalizationError);
		expect(client.tempTables.size).toBe(0);
		expect(
			client.queries.map((q) => normalizeCanonicalizationSql(q.sql)),
		).toEqual([
			'BEGIN',
			'SAVEPOINT dbsp_check_canon_sp_0',
			'CREATE TEMP TABLE "_dbsp_check_canon_0" ("id" INTEGER, "age" INTEGER) ON COMMIT DROP',
			'ROLLBACK TO SAVEPOINT dbsp_check_canon_sp_0',
			'RELEASE SAVEPOINT dbsp_check_canon_sp_0',
			'ROLLBACK',
		]);
	});

	it('surfaces a failed rollback in non-strict mode and discards the pool client', async () => {
		// Undoing the scratch DDL is not best-effort. Every CHECK here canonicalises
		// successfully, so nothing would warn: without this the caller would get a
		// canonicalised model back after the transaction was left in an unknown state.
		const rollbackError = new Error('rollback connection lost');
		const client = new FakePgClient();
		client.failOnSql = /^ROLLBACK$/u;
		client.failOnSqlError = rollbackError;
		client.canonicalExpressions.set(
			'_dbsp_check_canon_0_0',
			'CHECK ((age > 0))',
		);
		const pool = new FakePgPool(client);
		const desired = makeModel([
			makeTable({
				name: 'users',
				columns: [makeCol('id'), makeCol('age')],
				checkConstraints: [{ name: 'users_age_check', expression: 'age > 0' }],
			}),
		]);
		const dbModel = makeModel([makeTable({ name: 'users' })]);

		await expect(
			canonicalizeCheckConstraints(pool as unknown as Pool, desired, dbModel),
		).rejects.toThrow('rollback connection lost');

		expect(client.release).toHaveBeenCalledTimes(1);
		expect(client.release).toHaveBeenCalledWith(rollbackError);
	});

	it('opens its own transaction on a caller-owned client that has none', async () => {
		// PostgreSQL rejects SAVEPOINT outside a transaction block with 25P01. That
		// answer is the signal to open a transaction rather than nest in the caller's.
		const client = new FakePgClient();
		client.inTransaction = false;
		client.canonicalExpressions.set(
			'_dbsp_check_canon_0_0',
			'CHECK ((age > 0))',
		);
		const desired = makeModel([
			makeTable({
				name: 'users',
				columns: [makeCol('id'), makeCol('age')],
				checkConstraints: [{ name: 'users_age_check', expression: 'age > 0' }],
			}),
		]);
		const dbModel = makeModel([makeTable({ name: 'users' })]);

		const canonical = await canonicalizeCheckConstraints(
			client as unknown as PoolClient,
			desired,
			dbModel,
		);

		expect(
			canonical.tables.get('users')?.checkConstraints?.[0]?.expression,
		).toBe('CHECK ((age > 0))');
		const issued = client.queries.map((q) => normalizeSql(q.sql));
		expect(issued).toContain('BEGIN');
		expect(issued).toContain('ROLLBACK');
		// The caller's client is theirs — never released by the canonicaliser.
		expect(client.release).not.toHaveBeenCalled();
	});

	it('does not open a transaction on a caller-owned client that already has one', async () => {
		const client = new FakePgClient();
		client.canonicalExpressions.set(
			'_dbsp_check_canon_0_0',
			'CHECK ((age > 0))',
		);
		const desired = makeModel([
			makeTable({
				name: 'users',
				columns: [makeCol('id'), makeCol('age')],
				checkConstraints: [{ name: 'users_age_check', expression: 'age > 0' }],
			}),
		]);
		const dbModel = makeModel([makeTable({ name: 'users' })]);

		await canonicalizeCheckConstraints(
			client as unknown as PoolClient,
			desired,
			dbModel,
		);

		const issued = client.queries.map((q) => normalizeSql(q.sql));
		expect(issued).not.toContain('BEGIN');
		expect(issued).not.toContain('ROLLBACK');
		expect(issued.some((sql) => sql.startsWith('SAVEPOINT '))).toBe(true);
		expect(issued.some((sql) => sql.startsWith('ROLLBACK TO SAVEPOINT '))).toBe(
			true,
		);
		expect(client.release).not.toHaveBeenCalled();
	});

	it('does not touch the database when no desired table declares a CHECK constraint', async () => {
		const client = new FakePgClient();
		const pool = new FakePgPool(client);
		const desired = makeModel([makeTable({ name: 'logs' })]);
		const dbModel = makeModel([makeTable({ name: 'logs' })]);

		const canonical = await canonicalizeCheckConstraints(
			pool as unknown as Pool,
			desired,
			dbModel,
		);

		expect(canonical).toBe(desired);
		expect(pool.connect).not.toHaveBeenCalled();
		expect(client.queries).toEqual([]);
	});
});
