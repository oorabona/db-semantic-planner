import { ModelIRImpl } from '@dbsp/core';
import type { ColumnIR, ModelIR, TableIR } from '@dbsp/types';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
	assertNoRepeatedExpressionSurfaceDrift,
	comparePgsqlDatabaseSchema,
	NonConvergentSchemaDiffError,
} from './live-diff.js';
import { generateMigrationSQL } from './migration-sql.js';
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

function makeModel(tables: readonly TableIR[]): ModelIR {
	return new ModelIRImpl(
		new Map(tables.map((table) => [table.name, table])),
		new Map(),
	);
}

function normalizeSql(sql: string): string {
	return sql.replace(/\s+/g, ' ').trim();
}

class FakeLiveDiffClient {
	readonly queries: string[] = [];
	readonly release = vi.fn();

	constructor(
		readonly databaseCheckExpression: string,
		readonly failCanonicalization: boolean,
	) {}

	async query<T extends Record<string, unknown> = Record<string, unknown>>(
		sql: string,
		parameters?: readonly unknown[],
	): Promise<QueryResult<T>> {
		const normalized = normalizeSql(sql);
		this.queries.push(normalized);

		if (normalized.startsWith('CREATE TEMP TABLE')) {
			if (this.failCanonicalization) {
				throw new Error('scratch DDL failed');
			}
			return { rows: [], rowCount: 0 } as QueryResult<T>;
		}

		if (normalized.startsWith('SELECT conname AS name,')) {
			const names = parameters?.[1] as readonly string[];
			return {
				rows: names.map((name) => ({
					name,
					expression: 'CHECK ((age > 0))',
				})) as T[],
				rowCount: names.length,
			} as QueryResult<T>;
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
				] as T[],
				rowCount: 2,
			} as QueryResult<T>;
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
				] as T[],
				rowCount: 1,
			} as QueryResult<T>;
		}

		return { rows: [], rowCount: 0 } as QueryResult<T>;
	}
}

interface FakeQueryableClient {
	readonly release: ReturnType<typeof vi.fn>;
	query<T extends Record<string, unknown> = Record<string, unknown>>(
		sql: string,
		parameters?: readonly unknown[],
	): Promise<QueryResult<T>>;
}

class FakeForeignKeyLiveDiffClient implements FakeQueryableClient {
	readonly queries: string[] = [];
	readonly release = vi.fn();

	async query<T extends Record<string, unknown> = Record<string, unknown>>(
		sql: string,
	): Promise<QueryResult<T>> {
		const normalized = normalizeSql(sql);
		this.queries.push(normalized);

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
						table_name: 'posts',
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
						table_name: 'posts',
						column_name: 'author_id',
						data_type: 'integer',
						udt_name: 'int4',
						is_nullable: 'NO',
						column_default: null,
						collation_name: null,
						is_identity: 'NO',
						identity_generation: null,
					},
				] as T[],
				rowCount: 3,
			} as QueryResult<T>;
		}

		if (normalized.includes('FROM information_schema.table_constraints')) {
			return {
				rows: [
					{ table_name: 'users', column_name: 'id' },
					{ table_name: 'posts', column_name: 'id' },
				] as T[],
				rowCount: 2,
			} as QueryResult<T>;
		}

		if (normalized.includes("c.contype = 'f'")) {
			return {
				rows: [
					{
						constraint_name: 'fk_posts_author_id',
						source_table: 'posts',
						source_column: 'author_id',
						target_schema: 'public',
						target_table: 'users',
						target_column: 'id',
						delete_rule: 'NO ACTION',
						update_rule: 'NO ACTION',
						is_deferrable: 'NO',
						initially_deferred: 'NO',
						not_valid: true,
					},
				] as T[],
				rowCount: 1,
			} as QueryResult<T>;
		}

		return { rows: [], rowCount: 0 } as QueryResult<T>;
	}
}

class FakeLiveDiffPool {
	readonly connect = vi.fn(async () => this.client as unknown as PoolClient);
	readonly query = vi.fn(
		async <T extends Record<string, unknown> = Record<string, unknown>>(
			sql: string,
			parameters?: readonly unknown[],
		) => this.client.query<T>(sql, parameters),
	);

	constructor(readonly client: FakeQueryableClient) {}
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
});

describe('comparePgsqlDatabaseSchema', () => {
	it('emits validation SQL when an introspected foreign key is NOT VALID but desired is validated', async () => {
		const desired = makeModel([
			makeTable({
				name: 'users',
				columns: [makeCol('id')],
				primaryKey: 'id',
			}),
			makeTable({
				name: 'posts',
				columns: [makeCol('id'), makeCol('author_id')],
				primaryKey: 'id',
				foreignKeys: [
					{
						columns: ['author_id'],
						references: { table: 'users', columns: ['id'] },
					},
				],
			}),
		]);
		const client = new FakeForeignKeyLiveDiffClient();
		const pool = new FakeLiveDiffPool(client);

		const diff = await comparePgsqlDatabaseSchema(
			pool as unknown as Pool,
			desired,
		);
		const statements = generateMigrationSQL(diff);

		expect(diff.changes.map((change) => change.kind)).toEqual([
			'validate_constraint',
		]);
		expect(diff.summary.constraints.altered).toBe(1);
		expect(statements).toEqual([
			'ALTER TABLE "posts" VALIDATE CONSTRAINT "fk_posts_author_id";',
		]);
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
			comparePgsqlDatabaseSchema(pool as unknown as Pool, desired, {
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
});
