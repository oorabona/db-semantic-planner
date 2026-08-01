import { ModelIRImpl, POSTGRESQL_CAPABILITIES } from '@dbsp/core';
import type { ColumnIR, EnumIR, ModelIR, TableIR } from '@dbsp/types';
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { PgsqlCanonicalizationScope } from '../expression-canonicalizer.js';
import { PgsqlAdapter } from '../pgsql-adapter.js';
import {
	assertNoRepeatedExpressionSurfaceDrift,
	CheckConstraintNewEnumValueError,
	comparePgsqlDatabaseSchema,
	IndexPredicateCanonicalizationError,
	NonConvergentSchemaDiffError,
} from './live-diff.js';
import type { SchemaDiff } from './schema-diff.js';

function checkExpressionDiff(
	table: string,
	constraint: string,
	databaseExpression: string,
	desiredExpression: string,
): SchemaDiff {
	return {
		changes: [
			{
				kind: 'drop_check_constraint',
				table,
				destructive: true,
				details: `Drop CHECK constraint "${constraint}" (expression changed)`,
				meta: {
					check: { name: constraint, expression: databaseExpression },
				},
			},
			{
				kind: 'add_check_constraint',
				table,
				destructive: false,
				details: `Add CHECK constraint "${constraint}" ${desiredExpression}`,
				meta: {
					check: { name: constraint, expression: desiredExpression },
				},
			},
		],
		hasDestructive: true,
		summary: {
			tables: { added: 0, dropped: 0 },
			columns: { added: 0, dropped: 0, altered: 0 },
			indexes: { added: 0, dropped: 0 },
			constraints: { added: 1, dropped: 1, altered: 0 },
		},
	};
}

function columnDefaultDiff(
	table: string,
	column: string,
	databaseDefault: unknown,
	desiredDefault: unknown,
): SchemaDiff {
	return {
		changes: [
			{
				kind: 'alter_column_default',
				table,
				column,
				destructive: false,
				details: `Change default of "${column}"`,
				meta: { default: desiredDefault, oldDefault: databaseDefault },
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
}

function makeCol(name: string): ColumnIR {
	return {
		name,
		type: 'integer',
		nullable: false,
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
	extensions?: readonly string[],
): ModelIR {
	return new ModelIRImpl(
		new Map(tables.map((table) => [table.name, table])),
		new Map(),
		undefined,
		extensions,
	);
}

function makeModelWithEnums(
	tables: readonly TableIR[],
	enums: readonly EnumIR[],
): ModelIR {
	return new ModelIRImpl(
		new Map(tables.map((table) => [table.name, table])),
		new Map(),
		new Map(enums.map((enumDef) => [enumDef.name, enumDef])),
	);
}

function normalizeSql(sql: string): string {
	return sql.replace(/\s+/g, ' ').trim();
}

type FakeQueryResult = {
	readonly rows: readonly Record<string, unknown>[];
	readonly rowCount: number;
};

class FakeLiveDiffClient {
	readonly queries: string[] = [];
	readonly release = vi.fn();

	constructor(
		readonly databaseCheckExpression: string,
		readonly failCanonicalization: boolean,
	) {}

	async query(
		sql: string,
		parameters?: readonly unknown[],
	): Promise<FakeQueryResult> {
		const normalized = normalizeSql(sql);
		this.queries.push(normalized);
		if (
			normalized ===
			"SELECT pg_catalog.current_setting('search_path') AS search_path"
		) {
			return { rows: [{ search_path: 'public' }], rowCount: 1 };
		}
		if (
			normalized ===
			'SELECT pg_catalog.current_schemas(false)::pg_catalog.text[] AS schemas'
		) {
			return { rows: [{ schemas: ['public'] }], rowCount: 1 };
		}

		if (normalized.startsWith('CREATE TEMP TABLE')) {
			if (this.failCanonicalization) {
				throw Object.assign(
					new Error('permission denied to create temporary tables'),
					{ code: '42501' },
				);
			}
			return { rows: [], rowCount: 0 };
		}

		if (normalized.startsWith('SELECT conname AS name,')) {
			const names = parameters?.[1] as readonly string[];
			return {
				rows: names.map((name) => ({
					name,
					expression: 'CHECK ((age > 0))',
				})),
				rowCount: names.length,
			};
		}

		if (normalized.includes('FROM information_schema.columns')) {
			return {
				rows: [
					{
						table_name: 'users',
						column_name: 'id',
						data_type: 'integer',
						udt_name: 'int4',
						is_nullable: 'NO',
						column_default: null,
						collation_name: null,
						is_identity: 'NO',
						identity_generation: null,
					},
					{
						table_name: 'users',
						column_name: 'age',
						data_type: 'integer',
						udt_name: 'int4',
						is_nullable: 'NO',
						column_default: null,
						collation_name: null,
						is_identity: 'NO',
						identity_generation: null,
					},
				],
				rowCount: 2,
			};
		}

		if (
			normalized.includes("c.contype = 'c'") &&
			!normalized.startsWith('SELECT conname AS name,')
		) {
			return {
				rows: [
					{
						name: 'users_age_check',
						expression: this.databaseCheckExpression,
						not_valid: false,
						raw_table: 'users',
					},
				],
				rowCount: 1,
			};
		}

		return { rows: [], rowCount: 0 };
	}
}

interface FakeQueryableClient {
	readonly release: ReturnType<typeof vi.fn>;
	query(sql: string, parameters?: readonly unknown[]): Promise<FakeQueryResult>;
}

class FakeEnumValueLiveDiffClient implements FakeQueryableClient {
	readonly queries: string[] = [];
	readonly release = vi.fn();

	async query(
		sql: string,
		parameters?: readonly unknown[],
	): Promise<FakeQueryResult> {
		const normalized = normalizeSql(sql);
		this.queries.push(normalized);
		if (
			normalized ===
			"SELECT pg_catalog.current_setting('search_path') AS search_path"
		) {
			return { rows: [{ search_path: 'tenant_1, public' }], rowCount: 1 };
		}

		if (
			normalized.startsWith('ALTER TABLE') &&
			normalized.includes("CHECK (state = 'pending')")
		) {
			throw Object.assign(new Error('undefined function'), { code: '42883' });
		}

		if (normalized.startsWith('SELECT conname AS name,')) {
			const names = parameters?.[1] as readonly string[];
			return {
				rows: names.map((name) => ({
					name,
					expression: "CHECK (((state)::text <> 'blocked'::text))",
				})),
				rowCount: names.length,
			};
		}

		if (normalized.includes('FROM information_schema.columns')) {
			return {
				rows: [
					{
						table_name: 'jobs',
						column_name: 'id',
						data_type: 'integer',
						udt_name: 'int4',
						is_nullable: 'NO',
						column_default: null,
						collation_name: null,
						is_identity: 'NO',
						identity_generation: null,
					},
					{
						table_name: 'jobs',
						column_name: 'state',
						data_type: 'USER-DEFINED',
						udt_name: 'status',
						is_nullable: 'NO',
						column_default: null,
						collation_name: null,
						is_identity: 'NO',
						identity_generation: null,
					},
				],
				rowCount: 2,
			};
		}

		if (normalized.includes('FROM information_schema.table_constraints')) {
			return {
				rows: [{ table_name: 'jobs', column_name: 'id' }],
				rowCount: 1,
			};
		}

		if (normalized.includes('JOIN pg_enum')) {
			return {
				rows: [
					{
						name: 'status',
						schema: 'tenant_1',
						values: ['queued', 'done'],
					},
				],
				rowCount: 1,
			};
		}

		if (normalized.includes('format_type(a.atttypid')) {
			return {
				rows: [
					{
						table_name: 'jobs',
						column_name: 'state',
						db_type: 'status',
						type_schema: 'tenant_1',
					},
				],
				rowCount: 1,
			};
		}

		return { rows: [], rowCount: 0 };
	}
}

class FakeLiveDiffPool {
	readonly connect = vi.fn(async () => this.client as unknown as PoolClient);
	readonly query = vi.fn(async (sql: string, parameters?: readonly unknown[]) =>
		this.client.query(sql, parameters),
	);

	constructor(readonly client: FakeQueryableClient) {}
}

function adapterForPool(pool: FakeLiveDiffPool): PgsqlAdapter {
	return new PgsqlAdapter(pool as unknown as Pool);
}

describe('assertNoRepeatedExpressionSurfaceDrift', () => {
	it('throws when the same CHECK expression drift repeats after apply and re-introspect', () => {
		const previous = checkExpressionDiff(
			'jobs',
			'jobs_status_check',
			"CHECK ((status = 'skipped'::text))",
			"CHECK ((status = 'skipped'))",
		);
		const current = checkExpressionDiff(
			'jobs',
			'jobs_status_check',
			"CHECK ((status = 'skipped'::text))",
			"CHECK ((status = 'skipped'))",
		);

		expect(() =>
			assertNoRepeatedExpressionSurfaceDrift(previous, current),
		).toThrow(NonConvergentSchemaDiffError);
	});

	it('does not throw for a genuinely changed CHECK expression', () => {
		const previous = checkExpressionDiff(
			'jobs',
			'jobs_status_check',
			"CHECK ((status = 'skipped'::text))",
			"CHECK ((status = 'skipped'))",
		);
		const current = checkExpressionDiff(
			'jobs',
			'jobs_status_check',
			"CHECK ((status = 'queued'::text))",
			"CHECK ((status = 'done'))",
		);

		expect(() =>
			assertNoRepeatedExpressionSurfaceDrift(previous, current),
		).not.toThrow();
	});

	it('throws when the same raw column-default drift repeats after apply and re-introspect', () => {
		const previous = columnDefaultDiff(
			'jobs',
			'state',
			{ sql: "'pending'::tenant_1.status" },
			'pending',
		);
		const current = columnDefaultDiff(
			'jobs',
			'state',
			{ sql: "'pending'::tenant_1.status" },
			'pending',
		);

		expect(() =>
			assertNoRepeatedExpressionSurfaceDrift(previous, current),
		).toThrow(NonConvergentSchemaDiffError);
	});

	it('distinguishes a SQL-fragment default from a scalar with the same text', () => {
		const fragment = columnDefaultDiff('jobs', 'total', '0', { sql: '1 + 1' });
		const scalar = columnDefaultDiff('jobs', 'total', '0', '1 + 1');

		expect(() =>
			assertNoRepeatedExpressionSurfaceDrift(fragment, scalar),
		).not.toThrow();
	});

	it.each([
		[
			'CHECK constraints',
			() =>
				checkExpressionDiff(
					'jobs',
					'jobs_status_check',
					"CHECK ((state = 'db-secret\\nforged log'))",
					"CHECK ((state = 'desired-secret\\nforged log'))",
				),
		],
		[
			'column defaults',
			() =>
				columnDefaultDiff(
					'jobs',
					'state',
					{ sql: "'db-secret\\nforged log'" },
					{ sql: "'desired-secret\\nforged log'" },
				),
		],
	] as const)('redacts %s from non-convergence diagnostics', (_surface, makeDiff) => {
		const diff = makeDiff();
		let caught: unknown;
		try {
			assertNoRepeatedExpressionSurfaceDrift(diff, diff);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(NonConvergentSchemaDiffError);
		expect((caught as Error).message).not.toContain('secret');
		expect((caught as Error).message).not.toContain('forged log');
		expect(caught).toMatchObject({
			desiredExpressionHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
			databaseExpressionHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
		});
	});
});

describe('comparePgsqlDatabaseSchema', () => {
	it('rejects a missing desired extension predicate in strict and non-strict modes', async () => {
		const desired = makeModel(
			[
				makeTable({
					name: 'jobs',
					indexes: [
						{
							name: 'idx_jobs_payload_digest',
							columns: ['id'],
							where: "digest(payload, 'sha256') IS NOT NULL",
						},
					],
				}),
			],
			['pgcrypto'],
		);
		const dbModel = makeModel([makeTable({ name: 'jobs' })]);
		const missingExtensionFunction = Object.assign(
			new Error('function digest(text, unknown) does not exist'),
			{ code: '42883' },
		);
		const scratch = {
			executeRaw: vi.fn(async (sql: string) => {
				if (
					sql ===
					'SELECT pg_catalog.current_schemas(false)::pg_catalog.text[] AS schemas'
				) {
					return [{ schemas: ['public'] }];
				}
				if (sql.startsWith('CREATE INDEX ')) {
					throw missingExtensionFunction;
				}
				return [];
			}),
			transaction: vi.fn(
				async (fn: (scope: PgsqlCanonicalizationScope) => Promise<unknown>) =>
					fn(scratch as unknown as PgsqlCanonicalizationScope),
			),
		};
		const adapter = {
			introspect: vi.fn(async () => dbModel),
			withScratchScope: vi.fn(
				async (fn: (scope: PgsqlCanonicalizationScope) => Promise<unknown>) =>
					fn(scratch as unknown as PgsqlCanonicalizationScope),
			),
		} as unknown as PgsqlAdapter;

		await expect(
			comparePgsqlDatabaseSchema(adapter, desired, {
				requireExpressionCanonicalization: true,
				onWarning: vi.fn(),
			}),
		).rejects.toThrow(
			'add that extension in a separate migration before the predicate',
		);

		await expect(
			comparePgsqlDatabaseSchema(adapter, desired, { onWarning: vi.fn() }),
		).rejects.toBeInstanceOf(IndexPredicateCanonicalizationError);
		expect(scratch.executeRaw).toHaveBeenCalledWith(
			expect.stringMatching(/^CREATE INDEX /u),
		);
		expect(scratch.executeRaw).not.toHaveBeenCalledWith(
			expect.stringMatching(/^CREATE EXTENSION /u),
		);
	});

	it('does not emit a desired-only partial-index migration after canonicalization is cancelled', async () => {
		const desired = makeModel([
			makeTable({
				name: 'jobs',
				indexes: [
					{
						name: 'idx_jobs_active',
						columns: ['id'],
						where: 'id > 0',
					},
				],
			}),
		]);
		const dbModel = makeModel([makeTable({ name: 'jobs' })]);
		const cancelled = Object.assign(new Error('query cancelled'), {
			code: '57014',
		});
		const scratch = {
			executeRaw: vi.fn(async (sql: string) => {
				if (
					sql ===
					'SELECT pg_catalog.current_schemas(false)::pg_catalog.text[] AS schemas'
				) {
					return [{ schemas: ['public'] }];
				}
				if (sql.startsWith('CREATE INDEX ')) throw cancelled;
				return [];
			}),
			transaction: vi.fn(
				async (fn: (scope: PgsqlCanonicalizationScope) => Promise<unknown>) =>
					fn(scratch as unknown as PgsqlCanonicalizationScope),
			),
		};
		const adapter = {
			introspect: vi.fn(async () => dbModel),
			withScratchScope: vi.fn(
				async (fn: (scope: PgsqlCanonicalizationScope) => Promise<unknown>) =>
					fn(scratch as unknown as PgsqlCanonicalizationScope),
			),
		} as unknown as PgsqlAdapter;

		await expect(
			comparePgsqlDatabaseSchema(adapter, desired),
		).rejects.toMatchObject({
			statement: 'create_partial_index',
			cause: cancelled,
		});
		expect(scratch.executeRaw).toHaveBeenCalledWith(
			expect.stringMatching(/^CREATE INDEX /u),
		);
	});

	it('refuses a CHECK on an existing enum column without desired originalDbType when the diff adds the enum value', async () => {
		const desired = makeModelWithEnums(
			[
				makeTable({
					name: 'jobs',
					columns: [
						makeCol('id'),
						{
							name: 'state',
							type: 'string',
							nullable: false,
						},
					],
					primaryKey: 'id',
					checkConstraints: [
						{ name: 'jobs_state_check', expression: "state = 'pending'" },
					],
				}),
			],
			[
				{
					name: 'status',
					schema: 'tenant_1',
					values: ['queued', 'done', 'pending'],
				},
			],
		);
		const client = new FakeEnumValueLiveDiffClient();
		const pool = new FakeLiveDiffPool(client);

		await expect(
			comparePgsqlDatabaseSchema(adapterForPool(pool), desired, {
				schema: 'tenant_1',
				onWarning: vi.fn(),
			}),
		).rejects.toThrow(CheckConstraintNewEnumValueError);
		expect(
			client.queries.some(
				(query) =>
					query.startsWith('CREATE TEMP TABLE') &&
					query.includes('(LIKE "tenant_1"."jobs")'),
			),
		).toBe(true);
	});

	it('does not refuse a CHECK PostgreSQL canonicalizes while the diff adds an enum value', async () => {
		const desired = makeModelWithEnums(
			[
				makeTable({
					name: 'jobs',
					columns: [
						makeCol('id'),
						{
							name: 'state',
							type: 'string',
							nullable: false,
						},
					],
					primaryKey: 'id',
					checkConstraints: [
						{ name: 'jobs_state_check', expression: "state <> 'done'" },
					],
				}),
			],
			[
				{
					name: 'status',
					schema: 'tenant_1',
					values: ['queued', 'done', 'pending'],
				},
			],
		);
		const client = new FakeEnumValueLiveDiffClient();

		const diff = await comparePgsqlDatabaseSchema(
			adapterForPool(new FakeLiveDiffPool(client)),
			desired,
			{ schema: 'tenant_1', onWarning: vi.fn() },
		);

		expect(diff.changes.map((change) => change.kind)).toEqual(
			expect.arrayContaining(['alter_enum_add_value', 'add_check_constraint']),
		);
	});

	it('attributes new-enum-value refusal to the CHECK PostgreSQL refused, not its sibling', async () => {
		const desired = makeModelWithEnums(
			[
				makeTable({
					name: 'jobs',
					columns: [
						makeCol('id'),
						{
							name: 'state',
							type: 'string',
							nullable: false,
						},
					],
					primaryKey: 'id',
					checkConstraints: [
						{
							name: 'jobs_state_sibling_check',
							expression: "state <> 'blocked'",
						},
						{ name: 'jobs_state_check', expression: "state = 'pending'" },
					],
				}),
			],
			[
				{
					name: 'status',
					schema: 'tenant_1',
					values: ['queued', 'done', 'pending'],
				},
			],
		);
		const client = new FakeEnumValueLiveDiffClient();
		const pool = new FakeLiveDiffPool(client);
		const onWarning = vi.fn();
		const onExpressionCanonicalizationWarning = vi.fn();

		await expect(
			comparePgsqlDatabaseSchema(adapterForPool(pool), desired, {
				schema: 'tenant_1',
				onWarning,
				onExpressionCanonicalizationWarning,
			}),
		).rejects.toMatchObject({
			table: 'jobs',
			constraint: 'jobs_state_check',
		});
		expect(onWarning).toHaveBeenCalledOnce();
		expect(onWarning.mock.calls[0]![0]).toContain('Reason: undefined function');
		expect(onExpressionCanonicalizationWarning).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: 'check_constraint',
				table: 'jobs',
				name: 'jobs_state_check',
			}),
		);
	});

	it('throws repeated drift when CHECK canonicalization falls back under dbCasing', async () => {
		const desiredExpression = 'CHECK ((age > 0))';
		const databaseExpression = 'CHECK ((age >= 0))';
		const desired = makeModel([
			makeTable({
				name: 'users',
				columns: [makeCol('id'), makeCol('age')],
				checkConstraints: [
					{ name: 'usersAgeCheck', expression: desiredExpression },
				],
			}),
		]);
		const client = new FakeLiveDiffClient(databaseExpression, true);
		const pool = new FakeLiveDiffPool(client);

		await expect(
			comparePgsqlDatabaseSchema(adapterForPool(pool), desired, {
				dbCasing: 'snake_case',
				previouslyAppliedDiff: checkExpressionDiff(
					'users',
					'users_age_check',
					databaseExpression,
					desiredExpression,
				),
				onWarning: vi.fn(),
			}),
		).rejects.toThrow(NonConvergentSchemaDiffError);
		expect(client.queries).toContain('ROLLBACK');
		expect(client.release).toHaveBeenCalledOnce();
	});

	it('skips scratch CHECK canonicalization and CHECK diffs when the dialect disables CHECK constraints', async () => {
		const desired = makeModel([
			makeTable({
				name: 'users',
				columns: [makeCol('id'), makeCol('age')],
				checkConstraints: [
					{ name: 'users_age_check', expression: 'CHECK ((age > 0))' },
				],
			}),
		]);
		const client = new FakeLiveDiffClient('CHECK ((age >= 0))', true);
		const pool = new FakeLiveDiffPool(client);
		const onWarning = vi.fn();

		const diff = await comparePgsqlDatabaseSchema(
			adapterForPool(pool),
			desired,
			{
				dialectCapabilities: {
					...POSTGRESQL_CAPABILITIES,
					supportsDDLCheckConstraints: false,
				},
				requireExpressionCanonicalization: true,
				onWarning,
			},
		);

		expect(diff.changes).toEqual([]);
		expect(onWarning).not.toHaveBeenCalled();
		expect(
			client.queries.some((query) => query.startsWith('CREATE TEMP TABLE')),
		).toBe(false);
		expect(
			client.queries.some((query) => query.startsWith('ALTER TABLE')),
		).toBe(false);
	});
});
