import { ModelIRImpl, POSTGRESQL_CAPABILITIES } from '@dbsp/core';
import type {
	ColumnIR,
	EnumIR,
	ModelIR,
	SequenceIR,
	TableIR,
} from '@dbsp/types';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { generateMigrationSQL } from './ddl/migration-sql.js';
import { formatSqlDefault } from './ddl/phases/utils.js';
import { compareSchemata } from './ddl/schema-diff.js';
import {
	CheckConstraintCanonicalizationError,
	ColumnDefaultCanonicalizationError,
	canonicalizeCheckConstraints,
	canonicalizeExpressionSurfaces,
	fallbackToRawExpressionComparison,
	isExpressionCanonicalizationInfrastructureUnavailableError,
} from './expression-canonicalizer.js';
import {
	isEngineCanonicalCheck,
	isEngineCanonicalSqlDefault,
	markEngineCanonicalCheck,
} from './expression-provenance.js';
import { PgsqlAdapter } from './pgsql-adapter.js';

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
	extensions?: readonly string[],
	sequences?: readonly SequenceIR[],
): ModelIR {
	return new ModelIRImpl(
		new Map(tables.map((table) => [table.name, table])),
		new Map(),
		enums === undefined
			? undefined
			: new Map(enums.map((enumDef) => [enumDef.name, enumDef])),
		extensions,
		sequences === undefined
			? undefined
			: new Map(sequences.map((sequence) => [sequence.name, sequence])),
	);
}

function normalizeSql(sql: string): string {
	return sql.replace(/\s+/g, ' ').trim();
}

function fakeQueryResult(
	rows: readonly Record<string, unknown>[],
): QueryResult<Record<string, unknown>> {
	return {
		command: 'SELECT',
		oid: 0,
		fields: [],
		rows: [...rows],
		rowCount: rows.length,
	};
}

function normalizeCanonicalizationSql(sql: string): string {
	return normalizeSql(sql)
		.replace(/\bdbsp_savepoint_[a-f0-9]+\b/giu, 'dbsp_savepoint')
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
	readonly statements: string[] = [];
	readonly queries: Array<{
		readonly sql: string;
		readonly parameters: readonly unknown[] | undefined;
	}> = [];
	readonly tempTables = new Set<string>();
	readonly savepointTempTables = new Map<string, Set<string>>();
	readonly savepointSearchPaths = new Map<string, string>();
	readonly preexistingTempTables = new Set<string>();
	readonly canonicalExpressions = new Map<string, string>();
	readonly canonicalDatabaseExpressions = new Map<string, string>();
	readonly canonicalDefaults = new Map<string, string>();
	readonly canonicalPredicates = new Map<string, string>();
	canonicalPredicateFallback: string | undefined;
	canonicalPredicateFromCreateIndex = false;
	requiredPredicateSearchPathSchema: string | undefined;
	requiredScratchTypeSearchPathSchema: string | undefined;
	shadowedPredicateFunctionSchemas: readonly string[] | undefined;
	standardConformingStrings: 'on' | 'off' = 'on';
	readonly omittedDefaultSources = new Set<string>();
	readonly searchPathQueries: string[] = [];
	searchPath = '"$user", public';
	failOnSql: RegExp | undefined;
	failOnSqlError: Error | undefined;
	/**
	 * Whether the client starts inside a transaction. A caller-owned client handed
	 * to the canonicaliser may be either; PostgreSQL rejects SAVEPOINT outside a
	 * transaction block with 25P01, and this fake reproduces that.
	 */
	inTransaction = true;
	readonly release = vi.fn();

	async query(
		sql: string,
		parameters?: readonly unknown[],
	): Promise<QueryResult<Record<string, unknown>>> {
		const normalized = normalizeSql(sql);
		this.statements.push(normalized);
		if (normalized.startsWith('SET LOCAL search_path TO ')) {
			this.searchPathQueries.push(normalized);
			this.searchPath = normalized.replace(/^SET LOCAL search_path TO /u, '');
		} else if (normalized === "SET LOCAL standard_conforming_strings TO 'on'") {
			this.standardConformingStrings = 'on';
		} else if (
			normalized ===
			"SELECT pg_catalog.current_setting('search_path') AS search_path"
		) {
			return fakeQueryResult([{ search_path: this.searchPath }]);
		} else if (
			normalized === "SELECT pg_catalog.set_config('search_path', $1, true)"
		) {
			this.searchPath = String(parameters?.[0]);
		} else if (!normalized.startsWith('RELEASE SAVEPOINT ')) {
			this.queries.push({ sql, parameters });
		}
		if (this.failOnSql?.test(normalized)) {
			throw this.failOnSqlError ?? new Error('DDL refused');
		}

		if (normalized.startsWith('SAVEPOINT ') && !this.inTransaction) {
			throw Object.assign(new Error('no transaction is in progress'), {
				code: '25P01',
			});
		}
		const savepointMatch = /^SAVEPOINT ([^\s]+)$/u.exec(normalized);
		if (savepointMatch) {
			this.savepointTempTables.set(
				savepointMatch[1]!,
				new Set(this.tempTables),
			);
			this.savepointSearchPaths.set(savepointMatch[1]!, this.searchPath);
		}
		if (normalized === 'BEGIN') {
			this.inTransaction = true;
		}

		const createMatch = /^CREATE TEMP TABLE "([^"]+)"/u.exec(normalized);
		if (createMatch) {
			if (
				this.requiredScratchTypeSearchPathSchema !== undefined &&
				normalized.includes('tenant_status') &&
				!this.searchPath.includes(
					`"${this.requiredScratchTypeSearchPathSchema}"`,
				)
			) {
				throw Object.assign(new Error('type does not exist'), {
					code: '42704',
				});
			}
			const tempTableName = createMatch[1]!;
			if (
				this.preexistingTempTables.has(tempTableName) ||
				this.tempTables.has(tempTableName)
			) {
				throw new Error(`relation "${tempTableName}" already exists`);
			}
			this.tempTables.add(tempTableName);
		}
		const createIndexMatch =
			/^CREATE INDEX "([^"]+)" ON "([^"]+)" \(\(1\)\) WHERE (.+)$/u.exec(
				normalized,
			);
		if (
			createIndexMatch &&
			this.requiredPredicateSearchPathSchema !== undefined &&
			!this.searchPath.includes(`"${this.requiredPredicateSearchPathSchema}"`)
		) {
			throw Object.assign(new Error('function does not exist'), {
				code: '42883',
			});
		}
		if (createIndexMatch && this.canonicalPredicateFromCreateIndex) {
			this.canonicalPredicates.set(
				`${createIndexMatch[2]}.${createIndexMatch[1]}`,
				this.standardConformingStrings === 'on'
					? `canonical(${createIndexMatch[3]})`
					: `session-dependent(${createIndexMatch[3]})`,
			);
		}
		if (
			createIndexMatch &&
			this.shadowedPredicateFunctionSchemas !== undefined
		) {
			const resolvedSchema = [...this.shadowedPredicateFunctionSchemas].sort(
				(left, right) =>
					this.searchPath.indexOf(`"${left}"`) -
					this.searchPath.indexOf(`"${right}"`),
			)[0];
			if (resolvedSchema !== undefined) {
				this.canonicalPredicates.set(
					`${createIndexMatch[2]}.${createIndexMatch[1]}`,
					`"${resolvedSchema}".is_active(state)`,
				);
			}
		}

		if (normalized === 'ROLLBACK') {
			this.tempTables.clear();
			this.savepointTempTables.clear();
			this.inTransaction = false;
		} else {
			const rollbackMatch = /^ROLLBACK TO SAVEPOINT ([^\s]+)$/u.exec(
				normalized,
			);
			if (rollbackMatch) {
				const snapshot = this.savepointTempTables.get(rollbackMatch[1]!);
				this.tempTables.clear();
				for (const table of snapshot ?? []) {
					this.tempTables.add(table);
				}
				this.searchPath =
					this.savepointSearchPaths.get(rollbackMatch[1]!) ?? this.searchPath;
			}
		}

		const releaseMatch = /^RELEASE SAVEPOINT ([^\s]+)$/u.exec(normalized);
		if (releaseMatch) {
			this.savepointTempTables.delete(releaseMatch[1]!);
			this.savepointSearchPaths.delete(releaseMatch[1]!);
		}

		if (normalized.startsWith('SELECT conname AS name,')) {
			const names = parameters?.[1] as readonly string[];
			const relationName = String(parameters?.[0]);
			if (!relationName.startsWith('_dbsp_check_canon_')) {
				return fakeQueryResult(
					names.flatMap((name) => {
						const expression = this.canonicalDatabaseExpressions.get(
							`${relationName}.${name}`,
						);
						return expression === undefined ? [] : [{ name, expression }];
					}),
				);
			}
			return fakeQueryResult(
				names.map((name) => ({
					name,
					expression:
						this.canonicalExpressions.get(name) ??
						this.canonicalExpressions.get(legacyCanonicalizationName(name)) ??
						`CHECK ((canonical_${name}))`,
				})),
			);
		}

		if (normalized.startsWith('SELECT pg_get_expr(d.adbin,')) {
			const relationName = parameters?.[0];
			const columnName = parameters?.[1];
			const key = `${String(relationName)}.${String(columnName)}`;
			const expression =
				this.canonicalDefaults.get(key) ??
				this.canonicalDefaults.get(String(columnName)) ??
				`canonical_${String(columnName)}`;
			return fakeQueryResult([{ expression }]);
		}

		if (normalized.startsWith('SELECT source, pg_get_expr(d.adbin,')) {
			const sources = parameters?.[0] as readonly string[];
			const relations = parameters?.[1] as readonly string[];
			const columnName = String(parameters?.[2]);
			return fakeQueryResult(
				sources.flatMap((source, index) => {
					if (this.omittedDefaultSources.has(source)) return [];
					const relationName = relations[index]!;
					return [
						{
							source,
							expression:
								this.canonicalDefaults.get(`${relationName}.${columnName}`) ??
								this.canonicalDefaults.get(columnName) ??
								`canonical_${columnName}`,
						},
					];
				}),
			);
		}

		if (normalized.includes('FROM pg_catalog.pg_index ix')) {
			const relationName = String(parameters?.[0]);
			const indexName = String(parameters?.[1]);
			return fakeQueryResult([
				{
					predicate:
						this.canonicalPredicates.get(`${relationName}.${indexName}`) ??
						this.canonicalPredicates.get(indexName) ??
						this.canonicalPredicateFallback ??
						"((state)::text = 'active'::text)",
				},
			]);
		}

		const dropMatch = /^DROP TABLE "([^"]+)"$/u.exec(normalized);
		if (dropMatch) this.tempTables.delete(dropMatch[1]!);

		return fakeQueryResult([]);
	}
}

class FakePgPool {
	readonly connect = vi.fn(async () => this.client as unknown as PoolClient);

	constructor(readonly client: FakePgClient) {}
}

function adapterForPool(pool: FakePgPool): PgsqlAdapter {
	return new PgsqlAdapter(pool as unknown as Pool);
}

function adapterForBorrowedClient(client: FakePgClient): PgsqlAdapter {
	return new PgsqlAdapter(client as unknown as PoolClient, {
		borrowedClient: true,
	});
}

async function canonicalizeWithScratch(
	adapter: PgsqlAdapter,
	desired: ModelIR,
	dbModel: ModelIR,
	options?: Parameters<typeof canonicalizeCheckConstraints>[3],
): Promise<ModelIR> {
	return adapter.withScratchScope((scratch) =>
		canonicalizeCheckConstraints(scratch, desired, dbModel, options),
	);
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
	it.each([
		['single-quoted', "state = 'pending'"],
		['dollar-quoted', 'state = $$pending$$'],
		['tagged dollar-quoted', 'state = $lit$pending$lit$'],
	])('canonicalizes an authored CHECK with a %s enum-value spelling', async (_kind, expression) => {
		const client = new FakePgClient();
		client.canonicalExpressions.set(
			'_dbsp_check_canon_0_0',
			"CHECK (((state)::text = 'pending'::text))",
		);
		const desired = makeModel([
			makeTable({
				name: 'orders',
				columns: [makeCol('state', { type: 'string' })],
				checkConstraints: [{ name: 'orders_state_check', expression }],
			}),
		]);

		const canonical = await canonicalizeWithScratch(
			adapterForPool(new FakePgPool(client)),
			desired,
			makeModel([]),
		);

		expect(
			canonical.tables.get('orders')?.checkConstraints?.[0]?.expression,
		).toBe("CHECK (((state)::text = 'pending'::text))");
	});

	it('creates a desired-only enum before canonicalizing its default and CHECK in strict mode', async () => {
		const client = new FakePgClient();
		const desired = makeModel(
			[
				makeTable({
					name: 'jobs',
					columns: [
						makeCol('id'),
						makeCol('status', {
							type: 'string',
							originalDbType: 'status',
							default: { sql: "'active'::status" },
						}),
					],
					checkConstraints: [
						{ name: 'jobs_status_check', expression: "status = 'active'" },
					],
				}),
			],
			[{ name: 'status', values: ['active', 'inactive'] }],
		);
		const database = makeModel([
			makeTable({
				name: 'jobs',
				columns: [makeCol('id'), makeCol('status', { default: 'active' })],
			}),
		]);

		const canonical = await adapterForPool(
			new FakePgPool(client),
		).withScratchScope((scratch) =>
			canonicalizeExpressionSurfaces(scratch, desired, database, {
				requireCanonicalization: true,
			}),
		);

		expect(client.queries.map((query) => normalizeSql(query.sql))).toContain(
			"CREATE TYPE \"status\" AS ENUM ('active', 'inactive');",
		);
		expect(canonical.defaultOutcomes).toEqual([
			expect.objectContaining({ status: 'canonicalised', column: 'status' }),
		]);
		expect(
			canonical.desired.tables.get('jobs')?.checkConstraints?.[0],
		).toSatisfy(isEngineCanonicalCheck);
	});

	it('classifies a denied desired-only enum creation as unavailable, including in strict mode', async () => {
		const client = new FakePgClient();
		client.failOnSql = /^CREATE TYPE/u;
		client.failOnSqlError = Object.assign(new Error('permission denied'), {
			code: '42501',
		});
		const desired = makeModel(
			[
				makeTable({
					name: 'jobs',
					columns: [
						makeCol('id'),
						makeCol('status', {
							type: 'string',
							originalDbType: 'status',
							default: { sql: "'active'::status" },
						}),
					],
					checkConstraints: [
						{ name: 'jobs_status_check', expression: "status = 'active'" },
					],
				}),
			],
			[{ name: 'status', values: ['active'] }],
		);
		const database = makeModel([
			makeTable({
				name: 'jobs',
				columns: [makeCol('id'), makeCol('status', { default: 'active' })],
			}),
		]);
		const onWarning = vi.fn();

		const canonical = await adapterForPool(
			new FakePgPool(client),
		).withScratchScope((scratch) =>
			canonicalizeExpressionSurfaces(scratch, desired, database, {
				requireCanonicalization: true,
				onWarning,
			}),
		);

		expect(canonical.defaultOutcomes).toContainEqual(
			expect.objectContaining({
				status: 'unavailable',
				column: 'status',
				comparison: 'raw',
			}),
		);
		expect(onWarning).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: 'column_default',
				outcome: 'unavailable',
			}),
		);
		expect(onWarning).not.toHaveBeenCalledWith(
			expect.objectContaining({ outcome: 'rejected' }),
		);
	});

	it('freezes a branded CHECK so a changed expression cannot retain deparser provenance', () => {
		const check = markEngineCanonicalCheck({
			name: 'jobs_status_check',
			expression: 'CHECK ((status IS NOT NULL))',
		});
		expect(Reflect.set(check, 'expression', 'CHECK (unsafe; SELECT 1)')).toBe(
			false,
		);
		expect(check.expression).toBe('CHECK ((status IS NOT NULL))');
		expect(isEngineCanonicalCheck(check)).toBe(true);
	});

	it('does not authenticate Proxy-forged CHECK or default provenance', () => {
		const forge = <T extends object>(value: T) =>
			new Proxy(value, {
				get(target, property, receiver) {
					return typeof property === 'symbol'
						? property
						: Reflect.get(target, property, receiver);
				},
			});
		const check = forge({
			name: 'jobs_status_check',
			expression: "CHECK (status = U&'\\0441')",
		});
		const defaultValue = forge({ sql: "U&'\\0441'" });

		expect(isEngineCanonicalCheck(check)).toBe(false);
		expect(isEngineCanonicalSqlDefault(defaultValue)).toBe(false);
		expect(() => formatSqlDefault(defaultValue)).toThrow(
			/Unsafe SQL expression in column default/,
		);
	});

	it('keeps a direct pool-backed call on its session path before scratch DDL', async () => {
		const client = new FakePgClient();
		client.canonicalExpressions.set(
			'_dbsp_check_canon_0_0',
			'CHECK ((tenant_fn(age)))',
		);
		const desired = makeModel([
			makeTable({
				name: 'jobs',
				columns: [makeCol('id'), makeCol('age')],
				checkConstraints: [
					{ name: 'jobs_age_check', expression: 'tenant_fn(age)' },
				],
			}),
		]);
		const dbModel = makeModel([makeTable({ name: 'jobs' })]);

		const canonical = await canonicalizeWithScratch(
			adapterForPool(new FakePgPool(client)),
			desired,
			dbModel,
			{ schemaName: 'tenant_one' },
		);

		expect(canonical.tables.get('jobs')?.checkConstraints).toEqual([
			{ name: 'jobs_age_check', expression: 'CHECK ((tenant_fn(age)))' },
		]);
		const begin = client.statements.indexOf('BEGIN');
		const settings = client.statements.indexOf(
			"SET LOCAL standard_conforming_strings TO 'on'",
		);
		const create = client.statements.findIndex((statement) =>
			statement.startsWith('CREATE TEMP TABLE '),
		);
		expect(begin).toBeGreaterThanOrEqual(0);
		expect(settings).toBeGreaterThan(begin);
		expect(create).toBeGreaterThan(settings);
		expect(client.searchPathQueries).not.toContain(
			'SET LOCAL search_path TO pg_catalog, "tenant_one"',
		);
	});

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

		const canonical = await canonicalizeWithScratch(
			adapterForPool(pool),
			desired,
			dbModel,
			{ schemaName: 'public' },
		);

		const normalizedQueries = client.queries.map((q) =>
			normalizeCanonicalizationSql(q.sql),
		);
		expect(normalizedQueries).toEqual([
			'BEGIN',
			'SAVEPOINT dbsp_savepoint',
			'SAVEPOINT dbsp_savepoint',
			'CREATE TEMP TABLE "_dbsp_check_canon_0" (LIKE "public"."users") ON COMMIT DROP',
			'ALTER TABLE "_dbsp_check_canon_0" ADD COLUMN "age" INTEGER NOT NULL',
			'ALTER TABLE "_dbsp_check_canon_0" ADD COLUMN "status" VARCHAR(255) NOT NULL',
			'SAVEPOINT dbsp_savepoint',
			'ALTER TABLE "_dbsp_check_canon_0" ADD CONSTRAINT "_dbsp_check_canon_0_0" CHECK (age > 0)',
			'SAVEPOINT dbsp_savepoint',
			'ALTER TABLE "_dbsp_check_canon_0" ADD CONSTRAINT "_dbsp_check_canon_0_1" CHECK (status = \'active\')',
			'SAVEPOINT dbsp_savepoint',
			'SELECT conname AS name, pg_get_constraintdef(oid, false) AS expression FROM pg_constraint WHERE conrelid = $1::regclass AND conname = ANY($2::text[]) ORDER BY array_position($2::text[], conname)',
			'SAVEPOINT dbsp_savepoint',
			'SAVEPOINT dbsp_savepoint',
			'CREATE TEMP TABLE "_dbsp_check_canon_1" (LIKE "public"."products") ON COMMIT DROP',
			'ALTER TABLE "_dbsp_check_canon_1" ADD COLUMN "price" INTEGER NOT NULL',
			'SAVEPOINT dbsp_savepoint',
			'ALTER TABLE "_dbsp_check_canon_1" ADD CONSTRAINT "_dbsp_check_canon_1_0" CHECK (price > 0)',
			'SAVEPOINT dbsp_savepoint',
			'SELECT conname AS name, pg_get_constraintdef(oid, false) AS expression FROM pg_constraint WHERE conrelid = $1::regclass AND conname = ANY($2::text[]) ORDER BY array_position($2::text[], conname)',
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

	it('rolls a caller-owned transaction back to its original search_path and temp-relation state while releasing nested savepoints', async () => {
		const client = new FakePgClient();
		client.searchPath = '"caller", public';
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

		const canonical = await canonicalizeWithScratch(
			adapterForBorrowedClient(client),
			desired,
			dbModel,
		);

		expect(canonical.tables.get('users')?.checkConstraints).toEqual([
			{ name: 'users_age_check', expression: 'CHECK ((age > 0))' },
		]);
		expect(client.release).not.toHaveBeenCalled();
		expect(client.searchPath).toBe('"caller", public');
		expect(client.tempTables).toEqual(new Set());
		expect(
			client.queries.map((q) => normalizeCanonicalizationSql(q.sql)),
		).toEqual([
			'SAVEPOINT dbsp_savepoint',
			'SAVEPOINT dbsp_savepoint',
			'SAVEPOINT dbsp_savepoint',
			'CREATE TEMP TABLE "_dbsp_check_canon_0" (LIKE "public"."users") ON COMMIT DROP',
			'SAVEPOINT dbsp_savepoint',
			'ALTER TABLE "_dbsp_check_canon_0" ADD CONSTRAINT "_dbsp_check_canon_0_0" CHECK (age > 0)',
			'SAVEPOINT dbsp_savepoint',
			'SELECT conname AS name, pg_get_constraintdef(oid, false) AS expression FROM pg_constraint WHERE conrelid = $1::regclass AND conname = ANY($2::text[]) ORDER BY array_position($2::text[], conname)',
			'ROLLBACK TO SAVEPOINT dbsp_savepoint',
		]);
		expect(
			client.statements.some((statement) =>
				statement.startsWith('RELEASE SAVEPOINT '),
			),
		).toBe(true);
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

		const first = await canonicalizeWithScratch(
			adapterForBorrowedClient(client),
			desired,
			dbModel,
			{ onWarning: warnings },
		);
		const second = await canonicalizeWithScratch(
			adapterForBorrowedClient(client),
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

	it('falls back with a warning when a CHECK references an enum value added by the same diff', async () => {
		const enumValueError = Object.assign(
			new Error('unsafe use of new value "pending" of enum type status'),
			{ code: '42883' },
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

		const canonical = await canonicalizeWithScratch(
			adapterForPool(pool),
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
					'Could not canonicalize one CHECK constraint',
				),
			}),
		]);
		expect(warnings[0]!.message).toContain('unsafe use of new value "pending"');
		expect(
			client.queries.map((q) => normalizeCanonicalizationSql(q.sql)),
		).toEqual([
			'BEGIN',
			'SAVEPOINT dbsp_savepoint',
			'SAVEPOINT dbsp_savepoint',
			'CREATE TEMP TABLE "_dbsp_check_canon_0" (LIKE "public"."jobs") ON COMMIT DROP',
			'SAVEPOINT dbsp_savepoint',
			'ALTER TABLE "_dbsp_check_canon_0" ADD CONSTRAINT "_dbsp_check_canon_0_0" CHECK (status = \'pending\')',
			'ROLLBACK TO SAVEPOINT dbsp_savepoint',
			'ROLLBACK',
		]);
	});

	it('keeps canonicalizing sibling CHECK constraints when one ADD CONSTRAINT is refused', async () => {
		const enumValueError = Object.assign(
			new Error('unsafe use of new value "pending" of enum type status'),
			{ code: '42883' },
		);
		const client = new FakePgClient();
		client.failOnSql = /^ALTER TABLE .*CHECK \(status = 'pending'\)$/u;
		client.failOnSqlError = enumValueError;
		client.canonicalExpressions.set(
			'_dbsp_check_canon_0_0',
			'CHECK ((age > 0))',
		);
		const pool = new FakePgPool(client);
		const warnings: Array<{
			readonly constraint: string;
			readonly message: string;
		}> = [];
		const desired = makeModel(
			[
				makeTable({
					name: 'jobs',
					columns: [
						makeCol('id'),
						makeCol('age'),
						makeCol('status', {
							type: 'string',
							originalDbType: 'status',
						}),
					],
					checkConstraints: [
						{ name: 'jobs_age_check', expression: 'age > 0' },
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
						makeCol('age'),
						makeCol('status', {
							type: 'string',
							originalDbType: 'status',
						}),
					],
					checkConstraints: [
						{ name: 'jobs_age_check', expression: 'CHECK ((age > 0))' },
					],
				}),
			],
			[{ name: 'status', values: ['active'] }],
		);

		const canonical = await canonicalizeWithScratch(
			adapterForPool(pool),
			desired,
			dbModel,
			{ onWarning: (warning) => warnings.push(warning) },
		);

		expect(canonical.tables.get('jobs')?.checkConstraints).toEqual([
			{ name: 'jobs_age_check', expression: 'CHECK ((age > 0))' },
			{ name: 'jobs_status_check', expression: "status = 'pending'" },
		]);
		expect(warnings).toEqual([
			expect.objectContaining({
				constraint: 'jobs_status_check',
				message: expect.stringContaining(
					'Could not canonicalize one CHECK constraint',
				),
			}),
		]);
		expect(createdTempTableNames(client)).toHaveLength(1);

		const checkChanges = compareSchemata(canonical, dbModel)
			.changes.filter(
				(change) =>
					change.kind === 'add_check_constraint' ||
					change.kind === 'drop_check_constraint',
			)
			.map(
				(change) =>
					`${change.kind}:${(change.meta?.check as { name: string }).name}`,
			);
		expect(checkChanges).toEqual(['add_check_constraint:jobs_status_check']);
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
			canonicalizeWithScratch(adapterForPool(pool), desired, dbModel, {
				requireCanonicalization: true,
			}),
		).rejects.toThrow(CheckConstraintCanonicalizationError);
		expect(
			client.queries.map((q) => normalizeCanonicalizationSql(q.sql)),
		).toEqual([
			'BEGIN',
			'SAVEPOINT dbsp_savepoint',
			'SAVEPOINT dbsp_savepoint',
			'CREATE TEMP TABLE "_dbsp_check_canon_0" (LIKE "public"."jobs") ON COMMIT DROP',
			'SAVEPOINT dbsp_savepoint',
			'ALTER TABLE "_dbsp_check_canon_0" ADD CONSTRAINT "_dbsp_check_canon_0_0" CHECK (status = \'pending\')',
			'ROLLBACK TO SAVEPOINT dbsp_savepoint',
			'ROLLBACK TO SAVEPOINT dbsp_savepoint',
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

		const canonical = await canonicalizeWithScratch(
			adapterForPool(pool),
			desired,
			dbModel,
		);

		expect(
			client.queries.map((q) => normalizeCanonicalizationSql(q.sql)),
		).toEqual([
			'BEGIN',
			'SAVEPOINT dbsp_savepoint',
			'SAVEPOINT dbsp_savepoint',
			'CREATE TEMP TABLE "_dbsp_check_canon_0" ("id" INTEGER NOT NULL, "amount" INTEGER NOT NULL) ON COMMIT DROP',
			'SAVEPOINT dbsp_savepoint',
			'ALTER TABLE "_dbsp_check_canon_0" ADD CONSTRAINT "_dbsp_check_canon_0_0" CHECK (amount > 0)',
			'SAVEPOINT dbsp_savepoint',
			'SELECT conname AS name, pg_get_constraintdef(oid, false) AS expression FROM pg_constraint WHERE conrelid = $1::regclass AND conname = ANY($2::text[]) ORDER BY array_position($2::text[], conname)',
			'ROLLBACK',
		]);
		expect(canonical.tables.get('payments')?.checkConstraints).toEqual([
			{ name: 'payments_amount_check', expression: 'CHECK ((amount > 0))' },
		]);
		expect(client.tempTables.size).toBe(0);
	});

	it('keeps an existing column as PostgreSQL typed it when desired metadata is less precise', async () => {
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

		await canonicalizeWithScratch(adapterForPool(pool), desired, dbModel, {
			schemaName: 'tenant_1',
		});

		expect(
			client.queries.map((q) => normalizeCanonicalizationSql(q.sql)),
		).toContain(
			'CREATE TEMP TABLE "_dbsp_check_canon_0" (LIKE "tenant_1"."jobs") ON COMMIT DROP',
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

		await canonicalizeWithScratch(adapterForPool(pool), desired, dbModel, {
			schemaName: 'tenantOne',
			dbCasing: 'snake_case',
		});

		expect(
			client.queries.map((q) => normalizeCanonicalizationSql(q.sql)),
		).toContain(
			'CREATE TEMP TABLE "_dbsp_check_canon_0" (LIKE "tenantOne"."jobs") ON COMMIT DROP',
		);
		expect(
			client.queries.some((q) => q.sql.includes('"tenant_one".status')),
		).toBe(false);
	});

	it('retains only the outer scratch subtransaction across several tables and columns', async () => {
		const client = new FakePgClient();
		client.searchPath = '"caller", public';
		const model = (names: readonly string[]) =>
			makeModel(
				names.map((name) =>
					makeTable({
						name,
						columns: [
							makeCol('id'),
							makeCol('first', { default: 'first' }),
							makeCol('second', { default: 'second' }),
						],
					}),
				),
			);

		await adapterForBorrowedClient(client).withScratchScope((scratch) =>
			canonicalizeExpressionSurfaces(
				scratch,
				model(['one', 'two', 'three']),
				model(['one', 'two', 'three']),
			),
		);

		expect(client.savepointTempTables.size).toBe(1);
		expect(client.searchPath).toBe('"caller", public');
		expect(client.tempTables).toEqual(new Set());
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

		await canonicalizeWithScratch(adapterForPool(pool), desired, dbModel, {
			schemaName: 'tenant_1',
		});

		expect(
			client.queries.map((q) => normalizeCanonicalizationSql(q.sql)),
		).toContain(
			'CREATE TEMP TABLE "_dbsp_check_canon_0" (LIKE "tenant_1"."jobs") ON COMMIT DROP',
		);
		expect(
			client.queries.map((q) => normalizeCanonicalizationSql(q.sql)),
		).toContain(
			'ALTER TABLE "_dbsp_check_canon_0" ALTER COLUMN "state" TYPE INTEGER',
		);
	});

	for (const testCase of [
		{
			label: 'DEFAULT',
			column: makeCol('subject', {
				default: { sql: "nextval('missing_subject_seq'::regclass)" },
			}),
			forbiddenClause: /DEFAULT/u,
		},
		{
			label: 'auto increment',
			column: makeCol('subject', { autoIncrement: true }),
			forbiddenClause: /SERIAL/u,
		},
		{
			label: 'UNIQUE',
			column: makeCol('subject', { type: 'string', unique: true }),
			forbiddenClause: /UNIQUE/u,
		},
		{
			label: 'identity',
			column: makeCol('subject', { identity: 'always' }),
			forbiddenClause: /GENERATED/u,
		},
	] as const) {
		it(`removes ${testCase.label} but keeps NOT NULL on a scratch CHECK column`, async () => {
			const client = new FakePgClient();
			client.failOnSql = testCase.forbiddenClause;
			client.canonicalExpressions.set(
				'_dbsp_check_canon_0_0',
				'CHECK ((subject > 0))',
			);
			const pool = new FakePgPool(client);
			const tableName = `scratch_${testCase.label.toLowerCase().replace(/ /gu, '_')}`;
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

			const canonical = await canonicalizeWithScratch(
				adapterForPool(pool),
				desired,
				dbModel,
			);

			expect(
				client.queries.map((q) => normalizeCanonicalizationSql(q.sql)),
			).toContain(
				`CREATE TEMP TABLE "_dbsp_check_canon_0" (LIKE "public"."${tableName}") ON COMMIT DROP`,
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
		client.failOnSqlError = Object.assign(
			new Error('permission denied to create temporary tables'),
			{ code: '42501' },
		);
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

		const canonical = await canonicalizeWithScratch(
			adapterForPool(pool),
			desired,
			dbModel,
			{ onWarning: (warning) => warnings.push(warning.message) },
		);

		expect(canonical).not.toBe(desired);
		expect(canonical.tables.get('users')?.checkConstraints).toEqual([
			{ name: 'users_age_check', expression: 'age > 0' },
		]);
		expect(warnings).toEqual([
			expect.stringContaining('Could not canonicalize one CHECK constraint'),
		]);
		expect(warnings[0]).toContain('best-effort raw string comparison');
		expect(client.tempTables.size).toBe(0);
		expect(
			client.queries.map((q) => normalizeCanonicalizationSql(q.sql)),
		).toEqual([
			'BEGIN',
			'SAVEPOINT dbsp_savepoint',
			'SAVEPOINT dbsp_savepoint',
			'CREATE TEMP TABLE "_dbsp_check_canon_0" (LIKE "public"."users") ON COMMIT DROP',
			'ROLLBACK TO SAVEPOINT dbsp_savepoint',
			'ROLLBACK',
		]);
	});

	it('falls back only for CHECKs whose scratch column type is unavailable', async () => {
		const client = new FakePgClient();
		client.failOnSql = /ADD COLUMN "status" missing_status/u;
		client.failOnSqlError = Object.assign(new Error('type does not exist'), {
			code: '42704',
		});
		const warnings: unknown[] = [];
		const desired = makeModel([
			makeTable({
				name: 'jobs',
				columns: [
					makeCol('id'),
					makeCol('status', {
						type: 'string',
						originalDbType: 'missing_status',
					}),
				],
				checkConstraints: [
					{ name: 'jobs_status_check', expression: "status = 'queued'" },
				],
			}),
		]);
		const dbModel = makeModel([makeTable({ name: 'jobs' })]);

		const canonical = await canonicalizeWithScratch(
			adapterForPool(new FakePgPool(client)),
			desired,
			dbModel,
			{ onWarning: (warning) => warnings.push(warning) },
		);

		expect(canonical.tables.get('jobs')?.checkConstraints).toEqual(
			desired.tables.get('jobs')?.checkConstraints,
		);
		expect(warnings).toEqual([
			expect.objectContaining({
				kind: 'check_constraint',
				name: 'jobs_status_check',
			}),
		]);
	});

	it('reports fallback warnings under the CHECK database name when dbCasing is configured', async () => {
		const client = new FakePgClient();
		client.failOnSql = /^CREATE TEMP TABLE/u;
		client.failOnSqlError = Object.assign(
			new Error('permission denied to create temporary tables'),
			{ code: '42501' },
		);
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

		const canonical = await canonicalizeWithScratch(
			adapterForPool(pool),
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
					'Could not canonicalize one CHECK constraint',
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
			canonicalizeWithScratch(adapterForPool(pool), desired, dbModel, {
				requireCanonicalization: true,
			}),
		).rejects.toThrow(CheckConstraintCanonicalizationError);
		expect(client.tempTables.size).toBe(0);
		expect(
			client.queries.map((q) => normalizeCanonicalizationSql(q.sql)),
		).toEqual([
			'BEGIN',
			'SAVEPOINT dbsp_savepoint',
			'SAVEPOINT dbsp_savepoint',
			'CREATE TEMP TABLE "_dbsp_check_canon_0" (LIKE "public"."users") ON COMMIT DROP',
			'ROLLBACK TO SAVEPOINT dbsp_savepoint',
			'ROLLBACK TO SAVEPOINT dbsp_savepoint',
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
			canonicalizeWithScratch(adapterForPool(pool), desired, dbModel),
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

		const canonical = await canonicalizeWithScratch(
			adapterForBorrowedClient(client),
			desired,
			dbModel,
		);

		expect(
			canonical.tables.get('users')?.checkConstraints?.[0]?.expression,
		).toBe('CHECK ((age > 0))');
		const issued = client.queries.map((q) => normalizeSql(q.sql));
		expect(issued).toContain('BEGIN');
		expect(issued).toContain('ROLLBACK');
		// The caller's client is theirs — never released by the adapter scratch scope.
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

		await canonicalizeWithScratch(
			adapterForBorrowedClient(client),
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

	it('does not issue scratch DDL when no desired table declares a CHECK constraint', async () => {
		const client = new FakePgClient();
		const pool = new FakePgPool(client);
		const desired = makeModel([makeTable({ name: 'logs' })]);
		const dbModel = makeModel([makeTable({ name: 'logs' })]);

		const canonical = await canonicalizeWithScratch(
			adapterForPool(pool),
			desired,
			dbModel,
		);

		expect(canonical).toBe(desired);
		expect(pool.connect).toHaveBeenCalledTimes(1);
		expect(client.statements).toEqual(['BEGIN', 'ROLLBACK']);
		expect(client.release).toHaveBeenCalledTimes(1);
	});

	it('honors canonicalizeCheckConstraints: false in the public helper', async () => {
		const client = new FakePgClient();
		const desired = makeModel([
			makeTable({
				name: 'users',
				columns: [makeCol('id'), makeCol('age')],
				checkConstraints: [{ name: 'users_age_check', expression: 'age > 0' }],
			}),
		]);
		const dbModel = makeModel([makeTable({ name: 'users' })]);

		await expect(
			canonicalizeWithScratch(
				adapterForPool(new FakePgPool(client)),
				desired,
				dbModel,
				{
					canonicalizeCheckConstraints: false,
				},
			),
		).resolves.toBe(desired);
		expect(client.statements).toEqual(['BEGIN', 'ROLLBACK']);
	});

	it.each([
		'08P01',
		'25P02',
		'3B001',
		'40001',
		'53000',
		'54000',
		'55P03',
		'55P04',
		'57014',
		'58000',
		'XX000',
	])('rethrows operational SQLSTATE %s instead of warning', async (code) => {
		const client = new FakePgClient();
		client.failOnSql = /SET DEFAULT rejected_default\(\)/u;
		client.failOnSqlError = Object.assign(new Error(`operational ${code}`), {
			code,
		});
		const desired = makeModel([
			makeTable({
				name: 'jobs',
				columns: [
					makeCol('id'),
					makeCol('state', { default: { sql: 'rejected_default()' } }),
				],
			}),
		]);
		const database = makeModel([
			makeTable({
				name: 'jobs',
				columns: [makeCol('id'), makeCol('state', { default: 0 })],
			}),
		]);
		const onWarning = vi.fn();
		await expect(
			adapterForPool(new FakePgPool(client)).withScratchScope((scratch) =>
				canonicalizeExpressionSurfaces(scratch, desired, database, {
					onWarning,
				}),
			),
		).rejects.toMatchObject({
			name: ColumnDefaultCanonicalizationError.name,
			message: expect.stringContaining(
				'Could not canonicalize one column default',
			),
		});
		expect(onWarning).not.toHaveBeenCalled();
	});

	it('rethrows an unclassified frozen default rejection instead of warning', async () => {
		const client = new FakePgClient();
		client.failOnSql = /SET DEFAULT rejected_default\(\)/u;
		client.failOnSqlError = Object.freeze(new Error('unclassified rejection'));
		const desired = makeModel([
			makeTable({
				name: 'jobs',
				columns: [
					makeCol('id'),
					makeCol('state', { default: { sql: 'rejected_default()' } }),
				],
			}),
		]);
		const database = makeModel([
			makeTable({
				name: 'jobs',
				columns: [makeCol('id'), makeCol('state', { default: 0 })],
			}),
		]);
		const onWarning = vi.fn();
		await expect(
			adapterForPool(new FakePgPool(client)).withScratchScope((scratch) =>
				canonicalizeExpressionSurfaces(scratch, desired, database, {
					onWarning,
				}),
			),
		).rejects.toMatchObject({ name: ColumnDefaultCanonicalizationError.name });
		expect(onWarning).not.toHaveBeenCalled();
	});

	it('rethrows a semantic default rejection when its rollback cleanup is unclassified', async () => {
		const client = new FakePgClient();
		client.failOnSql = /SET DEFAULT rejected_default\(\)/u;
		const semanticRejection = Object.assign(new Error('undefined function'), {
			code: '42883',
		});
		const rollbackFailure = new Error('rollback failed without SQLSTATE');
		const combinedFailure = new AggregateError(
			[semanticRejection, rollbackFailure],
			'rollback cleanup failed',
		);
		Object.defineProperty(combinedFailure, 'cleanupError', {
			value: rollbackFailure,
		});
		client.failOnSqlError = combinedFailure;
		const desired = makeModel([
			makeTable({
				name: 'jobs',
				columns: [
					makeCol('id'),
					makeCol('state', { default: { sql: 'rejected_default()' } }),
				],
			}),
		]);
		const database = makeModel([
			makeTable({
				name: 'jobs',
				columns: [makeCol('id'), makeCol('state', { default: 0 })],
			}),
		]);
		const onWarning = vi.fn();

		await expect(
			adapterForPool(new FakePgPool(client)).withScratchScope((scratch) =>
				canonicalizeExpressionSurfaces(scratch, desired, database, {
					onWarning,
				}),
			),
		).rejects.toMatchObject({ name: ColumnDefaultCanonicalizationError.name });
		expect(onWarning).not.toHaveBeenCalled();
	});

	it('escapes control characters in default fallback warnings', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		try {
			const desired = makeModel([
				makeTable({
					name: 'jobs\nwarning',
					columns: [
						makeCol('id'),
						makeCol('state\tdefault', { default: 'pending' }),
					],
				}),
			]);
			fallbackToRawExpressionComparison(
				desired,
				desired,
				new Error('database\nerror\u001b[2J'),
				{ canonicalizeCheckConstraints: false },
			);
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining('Could not canonicalize one column default'),
			);
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining('database\\nerror\\u001b[2J'),
			);
			expect(warn.mock.calls[0]?.[0]).not.toContain('\n');
		} finally {
			warn.mockRestore();
		}
	});

	it('keeps local default validation outside PostgreSQL fallback handling', async () => {
		const client = new FakePgClient();
		const desired = makeModel([
			makeTable({
				name: 'jobs',
				columns: [
					makeCol('id'),
					makeCol('state', { default: { sql: 'now(); DROP TABLE jobs' } }),
				],
			}),
		]);
		const database = makeModel([
			makeTable({
				name: 'jobs',
				columns: [makeCol('id'), makeCol('state', { default: 0 })],
			}),
		]);
		const onWarning = vi.fn();
		await expect(
			adapterForPool(new FakePgPool(client)).withScratchScope((scratch) =>
				canonicalizeExpressionSurfaces(scratch, desired, database, {
					onWarning,
				}),
			),
		).rejects.toMatchObject({
			name: ColumnDefaultCanonicalizationError.name,
			cause: expect.objectContaining({
				message: expect.stringContaining('Unsafe SQL expression'),
			}),
		});
		expect(onWarning).not.toHaveBeenCalled();
		expect(
			client.queries.some((query) =>
				normalizeSql(query.sql).includes('SET DEFAULT now();'),
			),
		).toBe(false);
	});

	it('rolls back the scratch relation when PostgreSQL rejects a default', async () => {
		const client = new FakePgClient();
		client.failOnSql = /SET DEFAULT missing_default\(\)/u;
		client.failOnSqlError = Object.assign(new Error('undefined function'), {
			code: '42883',
		});
		const desired = makeModel([
			makeTable({
				name: 'jobs',
				columns: [
					makeCol('id'),
					makeCol('state', { default: { sql: 'missing_default()' } }),
				],
			}),
		]);
		const database = makeModel([
			makeTable({
				name: 'jobs',
				columns: [makeCol('id'), makeCol('state', { default: 0 })],
			}),
		]);
		await expect(
			adapterForPool(new FakePgPool(client)).withScratchScope((scratch) =>
				canonicalizeExpressionSurfaces(scratch, desired, database),
			),
		).rejects.toMatchObject({ name: ColumnDefaultCanonicalizationError.name });
		expect(client.tempTables).toEqual(new Set());
	});
});

describe('canonicalizeExpressionSurfaces partial-index predicates', () => {
	it('uses the migration session function lookup order and reconstructs the desired shape for an existing table', async () => {
		const client = new FakePgClient();
		client.searchPath = '"trusted_extensions", "tenant", public';
		client.shadowedPredicateFunctionSchemas = ['trusted_extensions', 'tenant'];
		const desired = makeModel([
			makeTable({
				name: 'jobs',
				columns: [makeCol('id'), makeCol('state', { type: 'string' })],
				indexes: [
					{
						name: 'idx_jobs_active',
						columns: ['id'],
						where: 'is_active(state)',
					},
				],
			}),
		]);
		const database = makeModel([
			makeTable({
				name: 'jobs',
				columns: [makeCol('id'), makeCol('state', { type: 'string' })],
			}),
		]);

		const canonical = await adapterForPool(
			new FakePgPool(client),
		).withScratchScope((scratch) =>
			canonicalizeExpressionSurfaces(scratch, desired, database, {
				schemaName: 'tenant',
			}),
		);

		expect(client.searchPathQueries).toEqual([
			'SET LOCAL search_path TO pg_catalog',
		]);
		expect(
			client.statements.find((statement) =>
				statement.startsWith('CREATE TEMP TABLE '),
			),
		).toContain('(LIKE "tenant"."jobs") ON COMMIT DROP');
		expect(canonical.desired.tables.get('jobs')?.indexes[0]?.where).toBe(
			'"trusted_extensions".is_active(state)',
		);
	});

	it('uses the migration session path for a predicate whose bare column type resolves only there', async () => {
		const client = new FakePgClient();
		client.searchPath = '"shared_types", public';
		client.requiredScratchTypeSearchPathSchema = 'shared_types';
		const desired = makeModel([
			makeTable({
				name: 'jobs',
				columns: [
					makeCol('id'),
					makeCol('state', {
						type: 'string',
						originalDbType: 'tenant_status',
					}),
				],
				indexes: [
					{
						name: 'idx_jobs_active',
						columns: ['id'],
						where: "state = 'active'",
					},
				],
			}),
		]);
		const database = makeModel([makeTable({ name: 'jobs' })]);

		const canonical = await adapterForPool(
			new FakePgPool(client),
		).withScratchScope((scratch) =>
			canonicalizeExpressionSurfaces(scratch, desired, database, {
				schemaName: 'tenant',
			}),
		);

		expect(canonical.indexPredicateOutcomes).toContainEqual(
			expect.objectContaining({
				side: 'desired',
				index: 'idx_jobs_active',
				status: 'canonicalised',
			}),
		);
		expect(
			client.statements.find((statement) =>
				statement.startsWith('CREATE TEMP TABLE '),
			),
		).toContain('(LIKE "tenant"."jobs") ON COMMIT DROP');
		expect(client.statements).toContainEqual(
			expect.stringMatching(/ADD COLUMN "state" tenant_status NOT NULL$/u),
		);
		expect(client.searchPathQueries).toEqual([
			'SET LOCAL search_path TO pg_catalog',
		]);
		expect(client.searchPath).toBe('"shared_types", public');
	});

	it('keeps an anonymous 42704 as scratch infrastructure failure', async () => {
		const client = new FakePgClient();
		client.failOnSql = /ADD COLUMN "missing" missing_type/u;
		client.failOnSqlError = Object.assign(
			new Error('type "missing_type" does not exist'),
			{ code: '42704' },
		);
		const desired = makeModel([
			makeTable({
				name: 'jobs',
				columns: [
					makeCol('first', {
						type: 'string',
						originalDbType: 'unrelated_type',
					}),
					makeCol('missing', {
						type: 'string',
						originalDbType: 'missing_type',
					}),
				],
				indexes: [
					{ name: 'idx_jobs_missing', columns: ['first'], where: 'true' },
				],
			}),
		]);
		const database = makeModel([
			makeTable({
				name: 'jobs',
				columns: [
					makeCol('first', {
						type: 'string',
						originalDbType: 'unrelated_type',
					}),
				],
			}),
		]);

		let error: unknown;
		try {
			await adapterForPool(new FakePgPool(client)).withScratchScope((scratch) =>
				canonicalizeExpressionSurfaces(scratch, desired, database),
			);
		} catch (caught) {
			error = caught;
		}

		expect(
			isExpressionCanonicalizationInfrastructureUnavailableError(error),
		).toBe(true);
		expect(error).toMatchObject({
			message:
				'PostgreSQL could not build the scratch relation for a partial-index predicate. Reason: type "missing_type" does not exist',
		});
		expect((error as Error).message).not.toContain('unrelated_type');
	});

	it('qualifies a planned predicate column type from its structural schema identity', async () => {
		const client = new FakePgClient();
		const desired = makeModel([
			makeTable({
				name: 'jobs',
				columns: [
					makeCol('id'),
					makeCol('state', {
						type: 'string',
						originalDbType: 'tenant_status',
						originalDbTypeSchema: 'tenant',
						originalDbTypeSchemaScope: 'target',
					}),
				],
				indexes: [
					{
						name: 'idx_jobs_active',
						columns: ['id'],
						where: "state = 'active'",
					},
				],
			}),
		]);

		await adapterForPool(new FakePgPool(client)).withScratchScope((scratch) =>
			canonicalizeExpressionSurfaces(
				scratch,
				desired,
				makeModel([makeTable({ name: 'jobs' })]),
				{ schemaName: 'tenant' },
			),
		);
		expect(client.statements).toContainEqual(
			expect.stringMatching(
				/ADD COLUMN "state" "tenant"\.tenant_status NOT NULL$/u,
			),
		);
	});

	it('takes only type spelling from the database when a collation change has a predicate', async () => {
		const client = new FakePgClient();
		client.canonicalPredicateFallback = "(value ~~ 'foo%'::text)";
		const desired = makeModel([
			makeTable({
				name: 'jobs',
				columns: [
					makeCol('id'),
					makeCol('value', {
						type: 'string',
						collation: 'nondeterministic_icu',
					}),
				],
				indexes: [
					{
						name: 'idx_jobs_value_prefix',
						columns: ['id'],
						where: "value LIKE 'foo%'",
					},
				],
			}),
		]);
		const database = makeModel([
			makeTable({
				name: 'jobs',
				columns: [
					makeCol('id'),
					makeCol('value', {
						type: 'string',
						nullable: true,
						collation: 'C',
						originalDbType: 'text',
					}),
				],
			}),
		]);

		await adapterForPool(new FakePgPool(client)).withScratchScope((scratch) =>
			canonicalizeExpressionSurfaces(scratch, desired, database),
		);

		// PG 18 accepts pattern matching under nondeterministic collations, so no live rejection can witness this.
		expect(
			client.statements.find((statement) =>
				statement.startsWith('CREATE TEMP TABLE '),
			),
		).toContain('(LIKE "public"."jobs") ON COMMIT DROP');
		expect(client.statements).toContainEqual(
			expect.stringMatching(
				/ALTER COLUMN "value" TYPE VARCHAR\(255\) COLLATE "nondeterministic_icu"$/u,
			),
		);
	});

	it('rejects a predicate needing a desired-only extension without installing it', async () => {
		const client = new FakePgClient();
		client.failOnSql = /^CREATE INDEX/u;
		client.failOnSqlError = Object.assign(
			new Error('function does not exist'),
			{
				code: '42883',
			},
		);
		const desired = makeModel(
			[
				makeTable({
					name: 'jobs',
					columns: [makeCol('id'), makeCol('payload', { type: 'string' })],
					indexes: [
						{
							name: 'idx_jobs_payload_digest',
							columns: ['id'],
							where: "digest(payload, 'sha256') IS NOT NULL",
						},
					],
				}),
			],
			undefined,
			['pgcrypto'],
		);
		const database = makeModel([makeTable({ name: 'jobs' })]);
		const onWarning = vi.fn();

		const canonical = await adapterForPool(
			new FakePgPool(client),
		).withScratchScope((scratch) =>
			canonicalizeExpressionSurfaces(scratch, desired, database, {
				schemaName: 'tenant',
				onWarning,
			}),
		);

		expect(canonical.indexPredicateOutcomes).toContainEqual(
			expect.objectContaining({
				side: 'desired',
				index: 'idx_jobs_payload_digest',
				status: 'rejected',
				comparison: 'raw',
			}),
		);
		expect(onWarning).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: 'index_predicate',
				outcome: 'rejected',
			}),
		);
		expect(client.statements).not.toContainEqual(
			expect.stringMatching(/^CREATE EXTENSION/u),
		);
		expect(client.searchPathQueries).toEqual([]);
	});

	it('records database predicates when a desired predicate is rejected', async () => {
		const client = new FakePgClient();
		client.failOnSql = /^CREATE INDEX/u;
		client.failOnSqlError = Object.assign(
			new Error('function does not exist'),
			{ code: '42883' },
		);
		const desired = makeModel([
			makeTable({
				name: 'jobs',
				indexes: [
					{
						name: 'idx_jobs_desired',
						columns: ['id'],
						where: 'missing_predicate(id)',
					},
				],
			}),
		]);
		const database = makeModel([
			makeTable({
				name: 'jobs',
				indexes: [
					{
						name: 'idx_jobs_live',
						columns: ['id'],
						where: 'state = 1',
					},
				],
			}),
		]);
		const onWarning = vi.fn();

		const canonical = await adapterForPool(
			new FakePgPool(client),
		).withScratchScope((scratch) =>
			canonicalizeExpressionSurfaces(scratch, desired, database, { onWarning }),
		);

		expect(canonical.indexPredicateOutcomes).toEqual([
			expect.objectContaining({
				side: 'desired',
				index: 'idx_jobs_desired',
				status: 'rejected',
				comparison: 'raw',
			}),
			expect.objectContaining({
				side: 'database',
				index: 'idx_jobs_live',
				status: 'rejected',
				comparison: 'raw',
			}),
		]);
		expect(onWarning).toHaveBeenCalledTimes(2);
		expect(onWarning).toHaveBeenCalledWith(
			expect.objectContaining({ side: 'database', name: 'idx_jobs_live' }),
		);
	});

	it('canonicalizes duplicate structural indexes independently without overwriting either predicate', async () => {
		const client = new FakePgClient();
		client.canonicalPredicateFromCreateIndex = true;
		client.canonicalPredicates.set(
			'idx_jobs_active',
			"canonical(state = 'active')",
		);
		client.canonicalPredicates.set(
			'idx_jobs_inactive',
			"canonical(state = 'inactive')",
		);
		const desired = makeModel([
			makeTable({
				name: 'jobs',
				columns: [makeCol('id'), makeCol('state', { type: 'string' })],
				indexes: [
					{
						name: 'idx_jobs_active',
						columns: ['id'],
						where: "state = 'active'",
					},
					{
						name: 'idx_jobs_inactive',
						columns: ['id'],
						where: "state = 'inactive'",
					},
				],
			}),
		]);
		// Reverse the physical order: matching by an unconsumed structural key
		// alone would pair both desired indexes with this first database index.
		const database = makeModel([
			makeTable({
				name: 'jobs',
				columns: [makeCol('id'), makeCol('state', { type: 'string' })],
				indexes: [
					{
						name: 'idx_jobs_inactive',
						columns: ['id'],
						where: "state = 'inactive'",
					},
					{
						name: 'idx_jobs_active',
						columns: ['id'],
						where: "state = 'active'",
					},
				],
			}),
		]);

		const canonical = await adapterForPool(
			new FakePgPool(client),
		).withScratchScope((scratch) =>
			canonicalizeExpressionSurfaces(scratch, desired, database),
		);

		expect(canonical.desired.tables.get('jobs')!.indexes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: 'idx_jobs_active',
					where: "canonical(state = 'active')",
				}),
				expect.objectContaining({
					name: 'idx_jobs_inactive',
					where: "canonical(state = 'inactive')",
				}),
			]),
		);
		expect(
			compareSchemata(canonical.desired, canonical.database).changes,
		).toEqual([]);
	});

	it('canonicalizes desired-only and database-only predicates without a cross-model join', async () => {
		const client = new FakePgClient();
		client.canonicalPredicateFromCreateIndex = true;
		client.canonicalPredicates.set('idx_jobs_archived', 'canonical(state = 2)');
		const desired = makeModel([
			makeTable({
				name: 'jobs',
				columns: [makeCol('id'), makeCol('state', { type: 'string' })],
				indexes: [
					{ name: 'idx_jobs_active', columns: ['id'], where: 'state = 1' },
				],
			}),
		]);
		const database = makeModel([
			makeTable({
				name: 'jobs',
				columns: [makeCol('id'), makeCol('state', { type: 'string' })],
				indexes: [
					{
						name: 'idx_jobs_archived',
						columns: ['id'],
						where: 'state = 2',
					},
				],
			}),
		]);

		const canonical = await adapterForPool(
			new FakePgPool(client),
		).withScratchScope((scratch) =>
			canonicalizeExpressionSurfaces(scratch, desired, database),
		);

		expect(canonical.indexPredicateOutcomes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					side: 'desired',
					index: 'idx_jobs_active',
					status: 'canonicalised',
				}),
				expect.objectContaining({
					side: 'database',
					index: 'idx_jobs_archived',
					status: 'canonicalised',
				}),
			]),
		);
		expect(
			compareSchemata(canonical.desired, canonical.database).changes,
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: 'create_index' }),
				expect.objectContaining({ kind: 'drop_index' }),
			]),
		);
	});

	it('reports expression-keyed partial predicates as unavailable without canonicalizing them', async () => {
		const client = new FakePgClient();
		const desired = makeModel([
			makeTable({
				name: 'users',
				columns: [makeCol('id'), makeCol('email', { type: 'string' })],
				indexes: [
					{
						name: 'idx_users_active_email',
						columns: [],
						expressions: ['lower(email)'],
						where: 'active',
					},
				],
			}),
		]);
		const database = makeModel([makeTable({ name: 'users' })]);
		const onWarning = vi.fn();

		const canonical = await adapterForPool(
			new FakePgPool(client),
		).withScratchScope((scratch) =>
			canonicalizeExpressionSurfaces(scratch, desired, database, {
				onWarning,
			}),
		);

		expect(canonical.indexPredicateOutcomes).toEqual([
			expect.objectContaining({
				side: 'desired',
				table: 'users',
				index: 'idx_users_active_email',
				status: 'unavailable',
				comparison: 'raw',
				reason: expect.objectContaining({
					message:
						'Partial-index predicates on expression-keyed indexes are not canonicalized.',
				}),
			}),
		]);
		expect(onWarning).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: 'index_predicate',
				name: 'idx_users_active_email',
				outcome: 'unavailable',
			}),
		);
		expect(client.statements).not.toContainEqual(
			expect.stringMatching(/^CREATE INDEX/u),
		);
	});

	it('canonicalizes each side when structural columns need database casing', async () => {
		const client = new FakePgClient();
		client.canonicalPredicates.set(
			'idx_job_queues_active',
			"((state_code)::text = 'active'::text)",
		);
		client.canonicalPredicateFallback = "((state_code)::text = 'active'::text)";
		const desired = makeModel([
			makeTable({
				name: 'jobQueues',
				columns: [makeCol('id'), makeCol('stateCode', { type: 'string' })],
				indexes: [
					{
						name: 'idxJobQueuesActive',
						columns: ['stateCode'],
						where: "state_code = 'active'",
					},
				],
			}),
		]);
		const database = makeModel([
			makeTable({
				name: 'job_queues',
				columns: [makeCol('id'), makeCol('state_code', { type: 'string' })],
				indexes: [
					{
						name: 'idx_job_queues_active',
						columns: ['state_code'],
						where: "((state_code)::text = 'active'::text)",
					},
				],
			}),
		]);

		const canonical = await adapterForPool(
			new FakePgPool(client),
		).withScratchScope((scratch) =>
			canonicalizeExpressionSurfaces(scratch, desired, database, {
				dbCasing: 'snake_case',
			}),
		);

		expect(
			compareSchemata(canonical.desired, canonical.database, {
				dbCasing: 'snake_case',
			}).changes,
		).toEqual([]);
	});

	it('does not return a mixed model when database deparse fails after desired canonicalization', async () => {
		const client = new FakePgClient();
		client.failOnSql = /JOIN pg_catalog\.pg_class i/u;
		client.failOnSqlError = Object.assign(new Error('catalog deparse denied'), {
			code: '42501',
		});
		const model = makeModel([
			makeTable({
				name: 'jobs',
				indexes: [
					{ name: 'idx_jobs_active', columns: ['id'], where: 'id > 0' },
				],
			}),
		]);

		await expect(
			adapterForPool(new FakePgPool(client)).withScratchScope((scratch) =>
				canonicalizeExpressionSurfaces(scratch, model, model),
			),
		).rejects.toThrow('catalog deparse denied');
		expect(
			client.statements.some((statement) =>
				statement.startsWith('CREATE INDEX'),
			),
		).toBe(true);
	});

	it('uses PostgreSQL predicate spelling so a raw index replacement disappears', async () => {
		const client = new FakePgClient();
		client.canonicalPredicates.set(
			'idx_jobs_active',
			"((state)::text = 'a;b'::text)",
		);
		client.canonicalPredicateFallback = "((state)::text = 'a;b'::text)";
		const desired = makeModel([
			makeTable({
				name: 'jobs',
				columns: [makeCol('id'), makeCol('state', { type: 'string' })],
				indexes: [
					{
						name: 'idx_jobs_active',
						columns: ['id'],
						where: "state = 'a;b'",
					},
				],
			}),
		]);
		const database = makeModel([
			makeTable({
				name: 'jobs',
				columns: [makeCol('id'), makeCol('state', { type: 'string' })],
				indexes: [
					{
						name: 'idx_jobs_active',
						columns: ['id'],
						where: "((state)::text = 'a;b'::text)",
					},
				],
			}),
		]);

		// Non-vacuity: connectionless raw comparison sees the replacement.
		expect(compareSchemata(desired, database).changes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: 'create_index' }),
				expect.objectContaining({ kind: 'drop_index' }),
			]),
		);
		const canonical = await adapterForPool(
			new FakePgPool(client),
		).withScratchScope((scratch) =>
			canonicalizeExpressionSurfaces(scratch, desired, database),
		);
		expect(
			compareSchemata(canonical.desired, canonical.database).changes,
		).toEqual([]);
		expect(canonical.indexPredicateOutcomes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					side: 'desired',
					index: 'idx_jobs_active',
					status: 'canonicalised',
				}),
			]),
		);
		expect(client.statements).toContainEqual(
			expect.stringContaining("WHERE state = 'a;b'"),
		);
	});

	it('canonicalizes an introspected predicate with omitted expressions before comparing public enum qualification', async () => {
		const client = new FakePgClient();
		client.canonicalPredicateFallback =
			"((state)::text = 'active'::public.dbsp_383_index_predicate_state)";
		const desired = makeModel([
			makeTable({
				name: 'jobs',
				columns: [makeCol('id'), makeCol('state', { type: 'string' })],
				indexes: [
					{
						name: 'idx_jobs_active',
						columns: ['id'],
						where: "state = 'active'",
						expressions: [],
					},
				],
			}),
		]);
		const database = makeModel([
			makeTable({
				name: 'jobs',
				columns: [makeCol('id'), makeCol('state', { type: 'string' })],
				indexes: [
					{
						name: 'idx_jobs_active',
						columns: ['id'],
						where: "((state)::text = 'active'::dbsp_383_index_predicate_state)",
					},
				],
			}),
		]);

		const canonical = await adapterForPool(
			new FakePgPool(client),
		).withScratchScope((scratch) =>
			canonicalizeExpressionSurfaces(scratch, desired, database),
		);

		expect(
			compareSchemata(canonical.desired, canonical.database).changes,
		).toEqual([]);
		expect(canonical.indexPredicateOutcomes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					side: 'database',
					index: 'idx_jobs_active',
					status: 'canonicalised',
				}),
			]),
		);
	});

	it('classifies a PostgreSQL predicate rejection without treating it as equality', async () => {
		const client = new FakePgClient();
		client.failOnSql = /^CREATE INDEX/u;
		client.failOnSqlError = Object.assign(
			new Error('column "missing" does not exist'),
			{
				code: '42703',
			},
		);
		const model = makeModel([
			makeTable({
				name: 'jobs',
				indexes: [
					{ name: 'idx_jobs_missing', columns: ['id'], where: 'missing = 1' },
				],
			}),
		]);
		const database = makeModel([
			makeTable({
				name: 'jobs',
				indexes: [
					{ name: 'idx_jobs_missing', columns: ['id'], where: 'missing = 2' },
				],
			}),
		]);
		const warning = vi.fn();
		const canonical = await adapterForPool(
			new FakePgPool(client),
		).withScratchScope((scratch) =>
			canonicalizeExpressionSurfaces(scratch, model, database, {
				onWarning: warning,
			}),
		);
		expect(canonical.indexPredicateOutcomes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ status: 'rejected', comparison: 'raw' }),
			]),
		);
		expect(warning).toHaveBeenCalledWith(
			expect.objectContaining({ kind: 'index_predicate', outcome: 'rejected' }),
		);
		expect(
			compareSchemata(canonical.desired, canonical.database).changes,
		).not.toEqual([]);
	});

	it('classifies permission denied by the tagged predicate statement as terminal', async () => {
		const client = new FakePgClient();
		client.failOnSql = /^CREATE INDEX/u;
		client.failOnSqlError = Object.assign(
			new Error('permission denied for function restricted_predicate'),
			{ code: '42501' },
		);
		const desired = makeModel([
			makeTable({
				name: 'jobs',
				indexes: [
					{
						name: 'idx_jobs_restricted',
						columns: ['id'],
						where: 'restricted_predicate(id)',
					},
				],
			}),
		]);
		const database = makeModel([makeTable({ name: 'jobs' })]);

		const canonical = await adapterForPool(
			new FakePgPool(client),
		).withScratchScope((scratch) =>
			canonicalizeExpressionSurfaces(scratch, desired, database),
		);

		expect(
			client.statements.some((statement) =>
				statement.startsWith('CREATE TEMP TABLE '),
			),
		).toBe(true);
		expect(canonical.indexPredicateOutcomes).toEqual([
			expect.objectContaining({
				side: 'desired',
				index: 'idx_jobs_restricted',
				status: 'rejected',
				comparison: 'raw',
			}),
		]);
	});

	it('keeps a real canonical predicate change as an index replacement', async () => {
		const client = new FakePgClient();
		client.canonicalPredicates.set(
			'"public"."jobs".idx_jobs_active',
			"((state)::text = 'inactive'::text)",
		);
		const desired = makeModel([
			makeTable({
				name: 'jobs',
				columns: [makeCol('id'), makeCol('state', { type: 'string' })],
				indexes: [
					{
						name: 'idx_jobs_active',
						columns: ['id'],
						where: "state = 'active'",
					},
				],
			}),
		]);
		const database = makeModel([
			makeTable({
				name: 'jobs',
				columns: [makeCol('id'), makeCol('state', { type: 'string' })],
				indexes: [
					{
						name: 'idx_jobs_active',
						columns: ['id'],
						where: "((state)::text = 'inactive'::text)",
					},
				],
			}),
		]);
		const canonical = await adapterForPool(
			new FakePgPool(client),
		).withScratchScope((scratch) =>
			canonicalizeExpressionSurfaces(scratch, desired, database),
		);
		expect(
			compareSchemata(canonical.desired, canonical.database).changes,
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: 'create_index' }),
				expect.objectContaining({ kind: 'drop_index' }),
			]),
		);
	});
});

describe('canonicalizeExpressionSurfaces column defaults', () => {
	it('emits a PostgreSQL-deparsed default containing a backslash without lexing it as authored SQL', async () => {
		const client = new FakePgClient();
		client.canonicalDefaults.set('body', String.raw`'back\slash'::text`);
		const desired = makeModel([
			makeTable({
				name: 'notes',
				columns: [makeCol('body', { default: 'backslash' })],
			}),
		]);
		const canonical = await adapterForPool(
			new FakePgPool(client),
		).withScratchScope((scratch) =>
			canonicalizeExpressionSurfaces(scratch, desired, desired),
		);
		expect(
			formatSqlDefault(
				canonical.desired.tables.get('notes')!.columns[0]!.default,
			),
		).toBe(String.raw`E'back\\slash'::text`);
	});

	it('emits a PostgreSQL-deparsed CHECK regex containing a backslash without lexing it as authored SQL', async () => {
		const client = new FakePgClient();
		client.canonicalExpressions.set(
			'_dbsp_check_canon_0_0',
			String.raw`CHECK ((a ~ '\d+'::text))`,
		);
		const desired = makeModel([
			makeTable({
				name: 'notes',
				columns: [makeCol('a', { type: 'string' })],
				checkConstraints: [{ name: 'notes_a_check', expression: "a ~ 'd+'" }],
			}),
		]);
		const database = makeModel([
			makeTable({
				name: 'notes',
				columns: [makeCol('a', { type: 'string' })],
			}),
		]);
		const canonical = await canonicalizeWithScratch(
			adapterForPool(new FakePgPool(client)),
			desired,
			database,
		);

		expect(
			generateMigrationSQL(compareSchemata(canonical, database)).join('\n'),
		).toContain(String.raw`CHECK ((a ~ E'\\d+'::text))`);
	});
	it('resolves matching live CHECK constraints under the session path and deparses them under pg_catalog', async () => {
		const client = new FakePgClient();
		client.canonicalExpressions.set(
			'_dbsp_check_canon_0_0',
			'CHECK ((state = \'queued\'::"tenantOne".status))',
		);
		client.canonicalDatabaseExpressions.set(
			'"tenantOne"."jobs".jobs_state_check',
			'CHECK ((state = \'queued\'::"tenantOne".status))',
		);
		const desired = makeModel([
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
		]);
		const dbModel = makeModel([
			makeTable({
				name: 'jobs',
				columns: desired.tables.get('jobs')!.columns,
				checkConstraints: [
					{
						name: 'jobs_state_check',
						expression: 'CHECK ((state = \'queued\'::"tenantOne".status))',
					},
				],
			}),
		]);

		const canonical = await adapterForPool(
			new FakePgPool(client),
		).withScratchScope((scratch) =>
			canonicalizeExpressionSurfaces(scratch, desired, dbModel, {
				schemaName: 'tenantOne',
				dbCasing: 'snake_case',
			}),
		);

		expect(canonical.database.tables.get('jobs')?.checkConstraints).toEqual([
			{
				name: 'jobs_state_check',
				expression: 'CHECK ((state = \'queued\'::"tenantOne".status))',
			},
		]);
		expect(
			compareSchemata(canonical.desired, canonical.database, {
				dbCasing: 'snake_case',
			}).changes,
		).toEqual([]);
		expect(client.searchPathQueries).toEqual([
			'SET LOCAL search_path TO pg_catalog',
			'SET LOCAL search_path TO pg_catalog',
		]);
		expect(
			client.queries.some(
				(query) =>
					normalizeSql(query.sql).startsWith('SELECT conname AS name,') &&
					query.parameters?.[0] === '"tenantOne"."jobs"' &&
					Array.isArray(query.parameters?.[1]) &&
					query.parameters?.[1]?.includes('jobs_state_check'),
			),
		).toBe(true);
	});

	it('deparses several matching live CHECK constraints with one query per table', async () => {
		const client = new FakePgClient();
		const desiredChecks = [
			{ name: 'jobs_age_check', expression: 'age > 0' },
			{ name: 'jobs_score_check', expression: 'score >= 0' },
		];
		const desired = makeModel([
			makeTable({
				name: 'jobs',
				columns: [makeCol('id'), makeCol('age'), makeCol('score')],
				checkConstraints: desiredChecks,
			}),
		]);
		const database = makeModel([
			makeTable({
				name: 'jobs',
				columns: desired.tables.get('jobs')!.columns,
				checkConstraints: desiredChecks,
			}),
		]);
		client.canonicalDatabaseExpressions.set(
			'"public"."jobs".jobs_age_check',
			'CHECK ((age > 0))',
		);
		client.canonicalDatabaseExpressions.set(
			'"public"."jobs".jobs_score_check',
			'CHECK ((score >= 0))',
		);

		await adapterForPool(new FakePgPool(client)).withScratchScope((scratch) =>
			canonicalizeExpressionSurfaces(scratch, desired, database),
		);

		const liveDeparseQueries = client.queries.filter(
			(query) =>
				normalizeSql(query.sql).startsWith('SELECT conname AS name,') &&
				query.parameters?.[0] === '"public"."jobs"',
		);
		expect(liveDeparseQueries).toHaveLength(1);
		expect(liveDeparseQueries[0]?.parameters?.[1]).toEqual([
			'jobs_age_check',
			'jobs_score_check',
		]);
	});

	it('propagates a live CHECK deparse failure instead of falling back to raw comparison', async () => {
		const client = new FakePgClient();
		const deparseError = new Error('live catalog read failed');
		client.failOnSql = /AND conname = ANY\(\$2::text\[\]\)$/u;
		client.failOnSqlError = deparseError;
		const desired = makeModel([
			makeTable({
				name: 'jobs',
				columns: [makeCol('id'), makeCol('age')],
				checkConstraints: [{ name: 'jobs_age_check', expression: 'age > 0' }],
			}),
		]);
		const dbModel = makeModel([
			makeTable({
				name: 'jobs',
				columns: [makeCol('id'), makeCol('age')],
				checkConstraints: [{ name: 'jobs_age_check', expression: 'age > 0' }],
			}),
		]);

		await expect(
			adapterForPool(new FakePgPool(client)).withScratchScope((scratch) =>
				canonicalizeExpressionSurfaces(scratch, desired, dbModel),
			),
		).rejects.toMatchObject({
			name: CheckConstraintCanonicalizationError.name,
		});
	});

	it('resolves defaults under the session path, deparses both sides under pg_catalog, and preserves PostgreSQL rendering verbatim', async () => {
		const client = new FakePgClient();
		client.canonicalDefaults.set('state', "'pending'::tenant_1.status");
		client.canonicalDefaults.set('counter', "nextval('counter_seq'::regclass)");
		client.canonicalDefaults.set('ivl', "'1 day'::interval day to second");
		client.canonicalDefaults.set('ratio', '1.5');
		client.canonicalDefaults.set('label', "'O''Reilly'::text");
		client.canonicalDefaults.set('created_at', 'now()');
		client.canonicalDefaults.set('uuid', 'gen_random_uuid()');
		const desired = new ModelIRImpl(
			new Map([
				[
					'jobs',
					makeTable({
						name: 'jobs',
						columns: [
							makeCol('state', {
								type: 'string',
								originalDbType: 'status',
								default: 'pending',
							}),
							makeCol('counter', {
								default: { sql: "nextval('counter_seq'::regclass)" },
							}),
							makeCol('ivl', {
								type: 'string',
								default: { sql: "'1 day'::interval day to second" },
							}),
							makeCol('ratio', { default: 1.5 }),
							makeCol('label', { type: 'string', default: "O'Reilly" }),
							makeCol('created_at', { type: 'string', default: 'now()' }),
							makeCol('uuid', { type: 'uuid', default: 'gen_random_uuid()' }),
						],
					}),
				],
			]),
			new Map(),
			new Map(
				[{ name: 'status', values: ['pending'] }].map((e) => [e.name, e]),
			),
			undefined,
			new Map([['counter_seq', { name: 'counter_seq' }]]),
		);
		const dbModel = new ModelIRImpl(
			new Map([
				[
					'jobs',
					makeTable({
						name: 'jobs',
						columns: desired.tables.get('jobs')!.columns.map((column) => ({
							...column,
							default: { sql: 'introspection-time rendering is ignored' },
						})),
					}),
				],
			]),
			new Map(),
			new Map(
				[{ name: 'status', values: ['pending'] }].map((e) => [e.name, e]),
			),
			undefined,
			undefined,
		);

		const canonical = await adapterForPool(
			new FakePgPool(client),
		).withScratchScope((scratch) =>
			canonicalizeExpressionSurfaces(scratch, desired, dbModel, {
				schemaName: 'tenant_1',
			}),
		);

		expect(canonical.desired.tables.get('jobs')?.columns[0]?.default).toEqual({
			sql: "'pending'::tenant_1.status",
		});
		expect(
			compareSchemata(canonical.desired, canonical.database).changes.map(
				(change) => change.kind,
			),
		).toEqual(['create_sequence']);
		expect(client.searchPathQueries).toEqual(
			expect.arrayContaining(['SET LOCAL search_path TO pg_catalog']),
		);
		expect(client.searchPathQueries).not.toContain(
			'SET LOCAL search_path TO pg_catalog, "tenant_1"',
		);
		expect(
			client.queries.some((query) =>
				normalizeSql(query.sql).startsWith('CREATE SEQUENCE'),
			),
		).toBe(true);
		expect(
			client.queries.some((query) =>
				normalizeSql(query.sql).startsWith(
					'SELECT source, pg_get_expr(d.adbin,',
				),
			),
		).toBe(true);
		expect(client.tempTables).toEqual(new Set());
	});

	it('rejects an unresolved default even without strict canonicalization', async () => {
		const client = new FakePgClient();
		client.canonicalDefaults.set('good', "nextval('counter_seq'::regclass)");
		client.failOnSql =
			/SET DEFAULT (?:nextval\('missing'::regclass\)|missing_default_function\(\))/u;
		client.failOnSqlError = Object.assign(new Error('undefined function'), {
			code: '42883',
		});
		const desired = makeModel([
			makeTable({
				name: 'jobs',
				columns: [
					makeCol('good', {
						default: { sql: "nextval('counter_seq'::regclass)" },
					}),
					makeCol('missing', {
						default: { sql: "nextval('missing'::regclass)" },
					}),
					makeCol('missing_function', {
						default: { sql: 'missing_default_function()' },
					}),
				],
			}),
		]);
		const dbModel = makeModel([
			makeTable({
				name: 'jobs',
				columns: [
					makeCol('good', { default: { sql: 'old good' } }),
					makeCol('missing', { default: { sql: 'old missing' } }),
					makeCol('missing_function', {
						default: { sql: 'old missing function' },
					}),
				],
			}),
		]);
		const adapter = adapterForPool(new FakePgPool(client));
		await expect(
			adapter.withScratchScope((scratch) =>
				canonicalizeExpressionSurfaces(scratch, desired, dbModel),
			),
		).rejects.toThrow('Could not canonicalize one column default');
	});

	it.each([
		['bare', "nextval('counter_seq'::regclass)"],
		['target-qualified', "nextval('tenant.counter_seq'::regclass)"],
	] as const)('stages a planned sequence before canonicalizing a %s default reference', async (_reference, defaultSql) => {
		const client = new FakePgClient();
		const desired = makeModel(
			[
				makeTable({
					name: 'jobs',
					columns: [
						makeCol('id'),
						makeCol('counter', { default: { sql: defaultSql } }),
					],
				}),
			],
			undefined,
			undefined,
			[{ name: 'counter_seq' }],
		);
		const database = makeModel([
			makeTable({
				name: 'jobs',
				columns: [
					makeCol('id'),
					makeCol('counter', { default: { sql: 'old counter default' } }),
				],
			}),
		]);

		const canonical = await adapterForPool(
			new FakePgPool(client),
		).withScratchScope((scratch) =>
			canonicalizeExpressionSurfaces(scratch, desired, database, {
				schemaName: 'tenant',
			}),
		);

		const statements = client.queries.map((query) => normalizeSql(query.sql));
		const sequence = statements.indexOf(
			'CREATE SEQUENCE "tenant"."counter_seq";',
		);
		const defaultStatement = statements.findIndex((statement) =>
			statement.includes(`SET DEFAULT ${defaultSql}`),
		);
		expect(sequence).toBeGreaterThanOrEqual(0);
		expect(defaultStatement).toBeGreaterThan(sequence);
		expect(canonical.defaultOutcomes).toContainEqual(
			expect.objectContaining({ status: 'canonicalised', column: 'counter' }),
		);
	});

	it('does not stage an unused missing sequence when the migration excludes sequence DDL', async () => {
		const client = new FakePgClient();
		const desired = makeModel(
			[
				makeTable({
					name: 'jobs',
					indexes: [
						{
							name: 'jobs_pending_idx',
							columns: ['id'],
							where: "status = 'pending'",
						},
					],
				}),
			],
			undefined,
			undefined,
			[{ name: 'unused_seq' }],
		);
		const database = makeModel([makeTable({ name: 'jobs' })]);
		const dialectCapabilities = {
			...POSTGRESQL_CAPABILITIES,
			supportsDDLSequences: false,
		};

		const canonical = await adapterForPool(
			new FakePgPool(client),
		).withScratchScope((scratch) =>
			canonicalizeExpressionSurfaces(scratch, desired, database, {
				dialectCapabilities,
			}),
		);

		expect(
			client.queries.some((query) =>
				normalizeSql(query.sql).startsWith('CREATE SEQUENCE'),
			),
		).toBe(false);
		expect(
			compareSchemata(canonical.desired, canonical.database, {
				dialectCapabilities,
			}).changes,
		).toContainEqual(expect.objectContaining({ kind: 'create_index' }));
	});

	it('classifies a planned-sequence staging failure as unavailable', async () => {
		const client = new FakePgClient();
		client.failOnSql = /^CREATE SEQUENCE/u;
		client.failOnSqlError = Object.assign(new Error('permission denied'), {
			code: '42501',
		});
		const desired = makeModel(
			[
				makeTable({
					name: 'jobs',
					columns: [
						makeCol('id'),
						makeCol('counter', {
							default: { sql: "nextval('counter_seq'::regclass)" },
						}),
					],
				}),
			],
			undefined,
			undefined,
			[{ name: 'counter_seq' }],
		);
		const database = makeModel([
			makeTable({
				name: 'jobs',
				columns: [
					makeCol('id'),
					makeCol('counter', { default: { sql: 'old counter default' } }),
				],
			}),
		]);
		const onWarning = vi.fn();

		const canonical = await adapterForPool(
			new FakePgPool(client),
		).withScratchScope((scratch) =>
			canonicalizeExpressionSurfaces(scratch, desired, database, {
				requireCanonicalization: true,
				onWarning,
			}),
		);

		expect(canonical.defaultOutcomes).toContainEqual(
			expect.objectContaining({
				status: 'unavailable',
				column: 'counter',
				comparison: 'raw',
			}),
		);
		expect(onWarning).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: 'column_default',
				outcome: 'unavailable',
			}),
		);
	});

	it('rejects a default with a genuinely missing sequence', async () => {
		const client = new FakePgClient();
		client.failOnSql =
			/SET DEFAULT nextval\('missing_counter_seq'::regclass\)/u;
		client.failOnSqlError = Object.assign(
			new Error('relation does not exist'),
			{
				code: '42P01',
			},
		);
		const desired = new ModelIRImpl(
			new Map([
				[
					'jobs',
					makeTable({
						name: 'jobs',
						columns: [
							makeCol('id'),
							makeCol('counter', {
								default: {
									sql: "nextval('missing_counter_seq'::regclass)",
								},
							}),
						],
					}),
				],
			]),
			new Map(),
			undefined,
			undefined,
		);
		const dbModel = makeModel([
			makeTable({
				name: 'jobs',
				columns: [
					makeCol('id'),
					makeCol('counter', { default: { sql: 'old counter default' } }),
				],
			}),
		]);
		await expect(
			adapterForPool(new FakePgPool(client)).withScratchScope((scratch) =>
				canonicalizeExpressionSurfaces(scratch, desired, dbModel),
			),
		).rejects.toMatchObject({
			name: ColumnDefaultCanonicalizationError.name,
			column: 'counter',
		});
		expect(
			client.queries.some((query) =>
				normalizeSql(query.sql).startsWith('CREATE SEQUENCE'),
			),
		).toBe(false);
	});

	it('uses the live OID for an unrelated existing column type', async () => {
		const client = new FakePgClient();
		client.canonicalDefaults.set('ready', '1');
		const desired = makeModel([
			makeTable({
				name: 'jobs',
				columns: [
					makeCol('ready', { default: 1 }),
					makeCol('unavailable', {
						type: 'string',
						originalDbType: 'missing_type',
						default: 2,
					}),
				],
			}),
		]);
		const dbModel = makeModel([
			makeTable({
				name: 'jobs',
				columns: [
					makeCol('ready', { default: 0 }),
					makeCol('unavailable', { type: 'string', default: 1 }),
				],
			}),
		]);

		const canonical = await adapterForPool(
			new FakePgPool(client),
		).withScratchScope((scratch) =>
			canonicalizeExpressionSurfaces(scratch, desired, dbModel),
		);

		expect(canonical.desired.tables.get('jobs')?.columns[0]?.default).toEqual({
			sql: '1',
		});
		expect(canonical.desired.tables.get('jobs')?.columns[1]?.default).toEqual({
			sql: 'canonical_unavailable',
		});
	});

	it('skips canonicalization for an absent column default', async () => {
		const client = new FakePgClient();
		client.failOnSql = /ALTER TABLE .*"new_counter" SET DEFAULT/u;
		const desired = makeModel([
			makeTable({
				name: 'jobs',
				columns: [makeCol('id'), makeCol('new_counter', { default: 1 })],
			}),
		]);
		const dbModel = makeModel([
			makeTable({ name: 'jobs', columns: [makeCol('id')] }),
		]);

		const warnings: unknown[] = [];
		const canonical = await adapterForPool(
			new FakePgPool(client),
		).withScratchScope((scratch) =>
			canonicalizeExpressionSurfaces(scratch, desired, dbModel, {
				onWarning: (warning) => warnings.push(warning),
			}),
		);

		expect(canonical.desired.tables.get('jobs')?.columns[1]?.default).toBe(1);
		expect(
			client.queries.some((query) =>
				normalizeSql(query.sql).includes('"new_counter" SET DEFAULT'),
			),
		).toBe(false);
		expect(warnings).toEqual([
			expect.objectContaining({
				kind: 'column_default',
				name: 'new_counter',
				comparison: 'unpaired',
				side: 'desired',
				message: expect.stringContaining(
					'comparison is unavailable for this column',
				),
			}),
		]);
	});

	it('keeps the failing later column when strict default canonicalization rejects', async () => {
		const client = new FakePgClient();
		client.failOnSql = /SET DEFAULT missing_default_function\(\)/u;
		client.failOnSqlError = Object.assign(new Error('undefined function'), {
			code: '42883',
		});
		const desired = makeModel([
			makeTable({
				name: 'jobs',
				columns: [
					makeCol('first', { default: 1 }),
					makeCol('failing', {
						default: { sql: 'missing_default_function()' },
					}),
				],
			}),
		]);
		const dbModel = makeModel([
			makeTable({
				name: 'jobs',
				columns: [
					makeCol('first', { default: 0 }),
					makeCol('failing', { default: 0 }),
				],
			}),
		]);

		await expect(
			adapterForPool(new FakePgPool(client)).withScratchScope((scratch) =>
				canonicalizeExpressionSurfaces(scratch, desired, dbModel, {
					requireCanonicalization: true,
				}),
			),
		).rejects.toMatchObject({
			name: ColumnDefaultCanonicalizationError.name,
			column: 'failing',
		});
	});

	it('records a catalog default that disappears before paired deparse as unavailable', async () => {
		const client = new FakePgClient();
		client.omittedDefaultSources.add('database');
		const desired = makeModel([
			makeTable({
				name: 'jobs',
				columns: [makeCol('id'), makeCol('state', { default: 'pending' })],
			}),
		]);
		const database = makeModel([
			makeTable({
				name: 'jobs',
				columns: [
					makeCol('id'),
					makeCol('state', { default: { sql: "'pending'::text" } }),
				],
			}),
		]);
		const warnings: unknown[] = [];
		const canonical = await adapterForPool(
			new FakePgPool(client),
		).withScratchScope((scratch) =>
			canonicalizeExpressionSurfaces(scratch, desired, database, {
				onWarning: (warning) => warnings.push(warning),
			}),
		);
		expect(canonical.defaultOutcomes).toContainEqual(
			expect.objectContaining({
				side: 'database',
				table: 'jobs',
				column: 'state',
				status: 'unavailable',
				comparison: 'raw',
			}),
		);
		expect(warnings).toEqual([
			expect.objectContaining({
				kind: 'column_default',
				name: 'state',
				outcome: 'unavailable',
				comparison: 'raw',
			}),
		]);
	});

	it('keeps desired and database default fallback outcomes distinct for one column', () => {
		const desired = makeModel([
			makeTable({
				name: 'jobs',
				columns: [makeCol('id'), makeCol('state', { default: 'pending' })],
			}),
		]);
		const database = makeModel([
			makeTable({
				name: 'jobs',
				columns: [
					makeCol('id'),
					makeCol('state', { default: { sql: "'active'::text" } }),
				],
			}),
		]);

		const fallback = fallbackToRawExpressionComparison(
			desired,
			database,
			new Error('scratch scope unavailable'),
			{ canonicalizeCheckConstraints: false, onWarning: () => undefined },
		);

		expect(fallback.defaultOutcomes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					side: 'desired',
					table: 'jobs',
					column: 'state',
					comparison: 'raw',
				}),
				expect.objectContaining({
					side: 'database',
					table: 'jobs',
					column: 'state',
					comparison: 'raw',
				}),
			]),
		);
	});

	it('reports every predicate on both complete raw models during raw fallback', () => {
		const desired = makeModel([
			makeTable({
				name: 'jobs',
				indexes: [
					{ name: 'idx_jobs_active', columns: ['id'], where: 'state = 1' },
				],
			}),
		]);
		const database = makeModel([
			makeTable({
				name: 'jobs',
				indexes: [
					{ name: 'idx_jobs_active', columns: ['id'], where: 'state = 1' },
					{ name: 'idx_jobs_archived', columns: ['id'], where: 'state = 2' },
				],
			}),
		]);

		const fallback = fallbackToRawExpressionComparison(
			desired,
			database,
			new Error('scratch scope unavailable'),
			{ canonicalizeCheckConstraints: false, onWarning: () => undefined },
		);

		expect(fallback.indexPredicateOutcomes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					side: 'desired',
					index: 'idx_jobs_active',
					status: 'unavailable',
					comparison: 'raw',
				}),
				expect.objectContaining({
					side: 'database',
					index: 'idx_jobs_active',
					status: 'unavailable',
					comparison: 'raw',
				}),
				expect.objectContaining({
					side: 'database',
					index: 'idx_jobs_archived',
					status: 'unavailable',
					comparison: 'raw',
				}),
			]),
		);
	});

	it('reports strict refusal instead of announcing raw fallback for shape-unavailable defaults', async () => {
		const desired = makeModel([
			makeTable({
				name: 'new_jobs',
				columns: [makeCol('id'), makeCol('state', { default: 'pending' })],
			}),
		]);
		const warnings: unknown[] = [];

		const canonical = await adapterForPool(
			new FakePgPool(new FakePgClient()),
		).withScratchScope((scratch) =>
			canonicalizeExpressionSurfaces(scratch, desired, makeModel([]), {
				requireCanonicalization: true,
				onWarning: (warning) => warnings.push(warning),
			}),
		);

		expect(canonical.defaultOutcomes).toContainEqual(
			expect.objectContaining({
				table: 'new_jobs',
				column: 'state',
				status: 'unavailable',
				comparison: 'unpaired',
			}),
		);
		expect(warnings).toEqual([
			expect.objectContaining({
				outcome: 'refused',
				message: expect.stringContaining(
					'strict canonicalization cannot compare this column',
				),
			}),
		]);
	});

	it('reports strict refusal instead of announcing raw fallback when a catalog default disappears', async () => {
		const client = new FakePgClient();
		client.omittedDefaultSources.add('database');
		const desired = makeModel([
			makeTable({
				name: 'jobs',
				columns: [makeCol('id'), makeCol('state', { default: 'pending' })],
			}),
		]);
		const database = makeModel([
			makeTable({
				name: 'jobs',
				columns: [
					makeCol('id'),
					makeCol('state', { default: { sql: "'pending'::text" } }),
				],
			}),
		]);
		const warnings: unknown[] = [];

		const canonical = await adapterForPool(
			new FakePgPool(client),
		).withScratchScope((scratch) =>
			canonicalizeExpressionSurfaces(scratch, desired, database, {
				requireCanonicalization: true,
				onWarning: (warning) => warnings.push(warning),
			}),
		);

		expect(canonical.defaultOutcomes).toContainEqual(
			expect.objectContaining({ status: 'unavailable' }),
		);
		expect(warnings).toEqual([
			expect.objectContaining({
				outcome: 'refused',
				message: expect.not.stringContaining('falling back'),
			}),
		]);
	});

	it.each([
		['a frozen Error', Object.freeze(new Error('deparse failed'))],
		['a non-Error value', 'deparse failed'],
	] as const)('preserves %s and a search_path restore failure without mutating the original rejection', async (_description, deparseError) => {
		const client = new FakePgClient();
		const restoreError = new Error('search_path restore failed');
		const query = client.query.bind(client);
		let catalogOnlyPathWasSet = false;
		vi.spyOn(client, 'query').mockImplementation(async (sql, parameters) => {
			const normalized = normalizeSql(sql);
			if (normalized === 'SET LOCAL search_path TO pg_catalog') {
				catalogOnlyPathWasSet = true;
			}
			if (normalized.startsWith('SELECT conname AS name,')) {
				throw deparseError;
			}
			if (
				catalogOnlyPathWasSet &&
				normalized === "SELECT pg_catalog.set_config('search_path', $1, true)"
			) {
				throw restoreError;
			}
			return query(sql, parameters);
		});
		const desired = makeModel([
			makeTable({
				name: 'jobs',
				checkConstraints: [{ name: 'jobs_id_check', expression: 'id > 0' }],
			}),
		]);

		let caught: unknown;
		try {
			await canonicalizeWithScratch(
				adapterForPool(new FakePgPool(client)),
				desired,
				makeModel([makeTable({ name: 'jobs' })]),
			);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(CheckConstraintCanonicalizationError);
		const cause = (caught as CheckConstraintCanonicalizationError).cause;
		expect(cause).toBeInstanceOf(AggregateError);
		expect((cause as AggregateError).errors).toEqual([
			deparseError,
			restoreError,
		]);
	});
});
