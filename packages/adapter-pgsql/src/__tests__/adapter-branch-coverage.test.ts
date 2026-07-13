/**
 * Strict branch-coverage tests for adapter-pgsql uncovered paths.
 *
 * Targets:
 *  - pgsql-adapter.ts            (68% → cover error paths, schema, compile-only mode)
 *  - introspection.ts            (73% → missing PKs, mapPgType branches, filterTables, matchGlob)
 *  - adapter-compiler-recursive.ts (75% → simpleCte, rawCte, unnestCte, custom traversal error)
 *  - handlers/expression/case.ts  (71% → no-else CASE, empty conditions error)
 *  - handlers/expression/case-value.ts (76% → all scalar kinds, arithmetic, nested case)
 *  - handlers/types.ts            (71% → all type guards negative/positive branches)
 *  - recursive/path-tracking.ts   (50% → buildJsonPathColumn, buildPathString, appendPathColumn)
 *  - assert-field.ts              (75% → missing value with/without context)
 */

import { supportsTransactions } from '@dbsp/core';
import type { RecursivePlanReport } from '@dbsp/types';
import type { Pool, PoolClient, QueryConfig, QueryResult } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
	compileCteQuery,
	compileRecursive,
} from '../adapter-compiler-recursive.js';
import { requiredColumn } from '../assert-field.js';
import { caseHandler, simpleCaseHandler } from '../handlers/expression/case.js';
import { resolveCaseValue } from '../handlers/expression/case-value.js';
import {
	createCompilerState,
	isParamRef,
	isRangeValue,
	isSelectWithFields,
	isSqlExpression,
} from '../handlers/types.js';
import { introspect } from '../introspection.js';
import { preserveNaming } from '../naming-plugin.js';
import {
	createPgsqlAdapter,
	createPgsqlCompileOnlyAdapter,
} from '../pgsql-adapter.js';
import {
	appendPathColumn,
	buildJsonPathColumn,
	buildPathColumn,
	buildPathString,
} from '../recursive/path-tracking.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePool(rows: Record<string, unknown>[][] = []): Pool {
	let idx = 0;
	return {
		query: vi.fn().mockImplementation(() => {
			const r = rows[idx++] ?? [];
			return Promise.resolve({ rows: r, rowCount: r.length } as QueryResult);
		}),
		connect: vi.fn(),
	} as unknown as Pool;
}

function makeClient(queryFn?: ReturnType<typeof vi.fn>): PoolClient {
	return {
		query: queryFn ?? vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
		release: vi.fn(),
	} as unknown as PoolClient;
}

function queryText(input: string | QueryConfig<unknown[]>): string {
	return typeof input === 'string' ? input : input.text;
}

const defaultDeps = {
	naming: preserveNaming,
	schemaName: undefined as string | undefined,
	model: undefined,
	defaultPk: 'id',
	deriveFk: (rel: string) => `${rel}_id`,
};

// ---------------------------------------------------------------------------
// pgsql-adapter.ts — PgsqlAdapter branches
// ---------------------------------------------------------------------------

describe('PgsqlAdapter constructor + compile-only mode', () => {
	it('requireConnection throws when no pool given (compile-only adapter)', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(() => adapter.getPoolInstance()).toThrow(
			'PgsqlAdapter is in compile-only mode',
		);
	});

	it('capabilities.supportsStreaming is false for compile-only adapter', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		expect(adapter.capabilities.supportsStreaming).toBe(false);
		expect(adapter.capabilities.supportsTransactions).toBe(false);
	});

	it('capabilities.supportsStreaming is true when pool is provided', () => {
		const pool = makePool();
		const adapter = createPgsqlAdapter(pool);
		expect(adapter.capabilities.supportsStreaming).toBe(true);
		expect(adapter.capabilities.supportsTransactions).toBe(true);
	});

	it('unmanaged borrowed clients do not pass core transaction or streaming feature detection', () => {
		const client = makeClient();
		const adapter = createPgsqlAdapter(client, { borrowedClient: true });

		expect(adapter.capabilities.supportsStreaming).toBe(false);
		expect(supportsTransactions(adapter)).toBe(false);
	});

	it('managed borrowed clients pass core transaction detection and run a savepoint transaction', async () => {
		const client = makeClient();
		const adapter = createPgsqlAdapter(client, {
			borrowedClient: true,
			managedTransactions: true,
		});

		expect(supportsTransactions(adapter)).toBe(true);
		await adapter.transaction(async (tx) => {
			await tx.execute({ sql: 'SELECT 1', parameters: [] });
		});

		const calls = (client.query as ReturnType<typeof vi.fn>).mock.calls.map(
			(c) => queryText(c[0] as string | QueryConfig<unknown[]>),
		);
		expect(calls[0]).toMatch(/^SAVEPOINT dbsp_savepoint_/);
		expect(calls).toContain('SELECT 1');
		expect(calls.at(-1)).toMatch(/^RELEASE SAVEPOINT dbsp_savepoint_/);
	});

	it('factory rejects a PoolClient unless borrowedClient: true is declared', () => {
		const client = makeClient();
		expect(() => createPgsqlAdapter(client as unknown as Pool)).toThrow(
			/borrowedClient: true/,
		);
	});

	it('borrowed client adapters are not inTransaction merely because they have release()', () => {
		const client = makeClient();
		const adapter = createPgsqlAdapter(client, { borrowedClient: true });
		expect(adapter.inTransaction).toBe(false);
	});

	it('inTransaction is false when created from pool', () => {
		const pool = makePool();
		const adapter = createPgsqlAdapter(pool);
		expect(adapter.inTransaction).toBe(false);
	});
});

describe('PgsqlAdapter.execute error paths', () => {
	it('execute throws when pool query rejects', async () => {
		const pool = makePool();
		(pool.query as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error('db error'),
		);
		const adapter = createPgsqlAdapter(pool);
		await expect(
			adapter.execute({ sql: 'SELECT 1', parameters: [] }),
		).rejects.toThrow('db error');
	});

	it('executeOne returns null when no rows', async () => {
		const pool = makePool([[]]); // empty rows
		const adapter = createPgsqlAdapter(pool);
		expect(await adapter.executeOne({ sql: 'SELECT 1', parameters: [] })).toBe(
			null,
		);
	});

	it('executeOneOrThrow throws when no rows', async () => {
		const pool = makePool([[]]); // empty rows
		const adapter = createPgsqlAdapter(pool);
		await expect(
			adapter.executeOneOrThrow({ sql: 'SELECT 1', parameters: [] }),
		).rejects.toThrow('No results found');
	});
});

describe('PgsqlAdapter.introspect', () => {
	it('throws on compile-only adapter', async () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		await expect(adapter.introspect()).rejects.toThrow(
			'Cannot introspect without a database connection',
		);
	});
});

describe('PgsqlAdapter.transaction', () => {
	it('throws for a borrowed client without managedTransactions', async () => {
		const client = makeClient();
		const adapter = createPgsqlAdapter(client, { borrowedClient: true });
		await expect(adapter.transaction(async () => undefined)).rejects.toThrow(
			/managedTransactions: true/,
		);
		expect(client.query).not.toHaveBeenCalled();
	});

	it('rolls back on fn error', async () => {
		const queryMock = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
		const connectClient = makeClient(queryMock);
		const pool = makePool();
		(pool.connect as ReturnType<typeof vi.fn>).mockResolvedValue(connectClient);
		const adapter = createPgsqlAdapter(pool);
		await expect(
			adapter.transaction(async () => {
				throw new Error('fn error');
			}),
		).rejects.toThrow('fn error');
		const calls = (
			connectClient.query as ReturnType<typeof vi.fn>
		).mock.calls.map((c) => c[0]);
		expect(calls).toEqual(expect.arrayContaining(['ROLLBACK']));
	});
});

describe('PgsqlAdapter.withSchema', () => {
	it('throws on invalid schema name (space)', () => {
		const adapter = createPgsqlAdapter(makePool());
		expect(() => adapter.withSchema('bad name!')).toThrow();
	});

	it('returns a new adapter instance', () => {
		const adapter = createPgsqlAdapter(makePool());
		expect(adapter.withSchema('tenant_1')).not.toBe(adapter);
	});
});

describe('PgsqlAdapter.executeDDL', () => {
	it('throws on compile-only adapter', async () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		await expect(adapter.executeDDL('CREATE TABLE x (id INT)')).rejects.toThrow(
			'Cannot execute DDL on compile-only adapter',
		);
	});
});

describe('PgsqlAdapter.createDump', () => {
	const basePlan = {
		rootTable: 't',
		decisions: [],
		warnings: [],
		ctes: [],
		intent: { from: 't', select: [] },
		metadata: { planningTimeMs: 0, relationsAnalyzed: 0, isAmbiguous: false },
	};

	it('includes schema in meta when schemaName is set', () => {
		const adapter = createPgsqlAdapter(makePool(), { schemaName: 'myschema' });
		const dump = adapter.createDump(basePlan as never, {
			sql: 'SELECT 1',
			parameters: [],
		});
		expect(dump.meta?.schema).toBe('myschema');
	});

	it('omits schema from meta when no schemaName', () => {
		const adapter = createPgsqlAdapter(makePool());
		const dump = adapter.createDump(basePlan as never, {
			sql: 'SELECT 1',
			parameters: [],
		});
		expect(dump.meta?.schema).toBeUndefined();
	});
});

describe('PgsqlAdapter.listIndexes', () => {
	it('passes namePattern as 3rd param', async () => {
		const rows = [
			{
				indexname: 'idx_foo',
				indexdef: 'CREATE INDEX idx_foo ON public.foo USING btree (id)',
			},
		];
		const pool = makePool([rows]);
		const adapter = createPgsqlAdapter(pool);
		const result = await adapter.listIndexes('foo', 'public', {
			namePattern: 'idx_%',
		});
		expect(result).toHaveLength(1);
		expect(result[0]!.name).toBe('idx_foo');
		expect((pool.query as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toEqual([
			'foo',
			'public',
			'idx_%',
		]);
	});

	it('detects unique index', async () => {
		const rows = [
			{
				indexname: 'u',
				indexdef: 'CREATE UNIQUE INDEX u ON t USING btree (email)',
			},
		];
		const pool = makePool([rows]);
		const result = await createPgsqlAdapter(pool).listIndexes('t', 'public');
		expect(result[0]!.unique).toBe(true);
		expect(result[0]!.method).toBe('btree');
	});

	it('detects non-default index method (gin)', async () => {
		const rows = [
			{ indexname: 'g', indexdef: 'CREATE INDEX g ON t USING gin (col)' },
		];
		const result = await createPgsqlAdapter(makePool([rows])).listIndexes('t');
		expect(result[0]!.method).toBe('gin');
		expect(result[0]!.unique).toBe(false);
	});

	it('defaults method to btree when USING absent', async () => {
		const rows = [{ indexname: 'i', indexdef: 'CREATE INDEX i ON t (id)' }];
		const result = await createPgsqlAdapter(makePool([rows])).listIndexes('t');
		expect(result[0]!.method).toBe('btree');
	});
});

describe('PgsqlAdapter.indexExists', () => {
	it('returns true when exists', async () => {
		expect(
			await createPgsqlAdapter(makePool([[{ exists: true }]])).indexExists(
				'idx',
				'tbl',
			),
		).toBe(true);
	});

	it('returns false when no rows', async () => {
		expect(
			await createPgsqlAdapter(makePool([[]])).indexExists('idx', 'tbl'),
		).toBe(false);
	});
});

describe('PgsqlAdapter.storageSize', () => {
	it('returns 0 when no rows', async () => {
		expect(await createPgsqlAdapter(makePool([[]])).storageSize('tbl')).toBe(0);
	});

	it('parses size string to number', async () => {
		expect(
			await createPgsqlAdapter(makePool([[{ size: '8192' }]])).storageSize(
				'tbl',
				'schema',
			),
		).toBe(8192);
	});

	it('escapes embedded double-quotes in names', async () => {
		const pool = makePool([[{ size: '4096' }]]);
		await createPgsqlAdapter(pool).storageSize('my"table', 'my"schema');
		const arg = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]![1][0];
		expect(arg).toBe('"my""schema"."my""table"');
	});
});

// ---------------------------------------------------------------------------
// introspection.ts — filterTables / matchGlob / mapPgType / buildTableIR
// ---------------------------------------------------------------------------

function makeIntrospectPool(
	columns: Record<string, unknown>[] = [],
	overrides?: {
		pks?: Record<string, unknown>[];
		formattedColumnTypes?: Record<string, unknown>[];
	},
): Pool {
	// queryAllCatalogs fires the 14 catalog queries in sequence via Promise.all;
	// makePool returns these in call order, so the order MUST match queryAllCatalogs.
	const results: Record<string, unknown>[][] = [
		columns, // 1. columns
		overrides?.pks ?? [], // 2. pks
		[], // 3. fks
		[], // 4. indexes
		[], // 5. uniqueColumns
		[], // 6. enums
		[], // 7. comments
		[], // 8. checks
		[], // 9. partitions
		[], // 10. extensions
		[], // 11. sequences
		[], // 12. rls
		[], // 13. policies
		overrides?.formattedColumnTypes ?? [], // 14. formattedColumnTypes
	];
	return makePool(results);
}

function col(
	overrides: Partial<Record<string, unknown>> & {
		table_name: string;
		column_name: string;
		data_type: string;
		udt_name: string;
	},
): Record<string, unknown> {
	return {
		is_nullable: 'NO',
		column_default: null,
		is_identity: 'NO',
		identity_generation: null,
		collation_name: null,
		...overrides,
	};
}

describe('introspection.filterTables', () => {
	it('no filters — all tables returned', async () => {
		const pool = makeIntrospectPool(
			[
				col({
					table_name: 'users',
					column_name: 'id',
					data_type: 'integer',
					udt_name: 'int4',
				}),
			],
			{ pks: [{ table_name: 'users', column_names: ['id'] }] },
		);
		const model = await introspect(pool);
		expect(Array.from(model.tables.keys())).toEqual(['users']);
	});

	it('include filter — keeps only exact match', async () => {
		const pool = makeIntrospectPool([
			col({
				table_name: 'users',
				column_name: 'id',
				data_type: 'integer',
				udt_name: 'int4',
			}),
			col({
				table_name: 'posts',
				column_name: 'id',
				data_type: 'integer',
				udt_name: 'int4',
			}),
		]);
		const model = await introspect(pool, { include: ['users'] });
		expect(Array.from(model.tables.keys())).toEqual(['users']);
	});

	it('sources originalDbType from the format_type catalog query verbatim', async () => {
		const pool = makeIntrospectPool(
			[
				col({
					table_name: 'events',
					column_name: 'kinds',
					data_type: 'ARRAY',
					udt_name: '_int4',
				}),
				col({
					table_name: 'events',
					column_name: 'name',
					data_type: 'character varying',
					udt_name: 'varchar',
				}),
			],
			{
				formattedColumnTypes: [
					// Array columns are sourced from format_type (integer[], not _int4).
					{
						table_name: 'events',
						column_name: 'kinds',
						db_type: 'integer[]',
					},
					// A built-in modifier is preserved verbatim.
					{
						table_name: 'events',
						column_name: 'name',
						db_type: 'character varying(120)',
					},
				],
			},
		);
		const model = await introspect(pool);
		const columns = model.getTable('events')?.columns ?? [];
		const byName = new Map(columns.map((c) => [c.name, c.originalDbType]));
		expect(byName.get('kinds')).toBe('integer[]');
		expect(byName.get('name')).toBe('character varying(120)');
	});

	it('exclude filter — removes matching tables', async () => {
		const pool = makeIntrospectPool([
			col({
				table_name: 'users',
				column_name: 'id',
				data_type: 'integer',
				udt_name: 'int4',
			}),
			col({
				table_name: '_prisma_migrations',
				column_name: 'id',
				data_type: 'text',
				udt_name: 'text',
			}),
		]);
		const model = await introspect(pool, { exclude: ['_prisma*'] });
		expect(Array.from(model.tables.keys())).toEqual(['users']);
	});

	it('include wildcard glob — matches multiple tables', async () => {
		const pool = makeIntrospectPool([
			col({
				table_name: 'tenant_a',
				column_name: 'id',
				data_type: 'integer',
				udt_name: 'int4',
			}),
			col({
				table_name: 'tenant_b',
				column_name: 'id',
				data_type: 'integer',
				udt_name: 'int4',
			}),
			col({
				table_name: 'other',
				column_name: 'id',
				data_type: 'integer',
				udt_name: 'int4',
			}),
		]);
		const model = await introspect(pool, { include: ['tenant_*'] });
		expect(Array.from(model.tables.keys()).sort()).toEqual([
			'tenant_a',
			'tenant_b',
		]);
	});

	it('table without primary key — warning emitted', async () => {
		const pool = makeIntrospectPool([
			col({
				table_name: 'no_pk',
				column_name: 'name',
				data_type: 'text',
				udt_name: 'text',
				is_nullable: 'YES',
			}),
		]);
		const model = await introspect(pool);
		expect(model.warnings.some((w) => w.includes('no_pk'))).toBe(true);
	});
});

describe('introspection.buildTableIR — column branches', () => {
	it('column with non-null default — default stored', async () => {
		const pool = makeIntrospectPool(
			[
				col({
					table_name: 'tbl',
					column_name: 'score',
					data_type: 'integer',
					udt_name: 'int4',
					column_default: '0',
				}),
			],
			{ pks: [{ table_name: 'tbl', column_names: ['score'] }] },
		);
		// C5 fix: introspected defaults stored as { sql } for verbatim DDL emission
		expect(
			(await introspect(pool)).tables.get('tbl')?.columns[0]?.default,
		).toStrictEqual({ sql: '0' });
	});

	it('identity ALWAYS → "always"', async () => {
		const pool = makeIntrospectPool(
			[
				col({
					table_name: 'tbl',
					column_name: 'id',
					data_type: 'integer',
					udt_name: 'int4',
					is_identity: 'YES',
					identity_generation: 'ALWAYS',
				}),
			],
			{ pks: [{ table_name: 'tbl', column_names: ['id'] }] },
		);
		expect(
			(await introspect(pool)).tables.get('tbl')?.columns[0]?.identity,
		).toBe('always');
	});

	it('identity BY DEFAULT → "byDefault"', async () => {
		const pool = makeIntrospectPool(
			[
				col({
					table_name: 'tbl',
					column_name: 'id',
					data_type: 'integer',
					udt_name: 'int4',
					is_identity: 'YES',
					identity_generation: 'BY DEFAULT',
				}),
			],
			{ pks: [{ table_name: 'tbl', column_names: ['id'] }] },
		);
		expect(
			(await introspect(pool)).tables.get('tbl')?.columns[0]?.identity,
		).toBe('byDefault');
	});

	it('collation != "default" — stored on column', async () => {
		const pool = makeIntrospectPool(
			[
				col({
					table_name: 'tbl',
					column_name: 'name',
					data_type: 'text',
					udt_name: 'text',
					collation_name: 'en_US',
				}),
			],
			{ pks: [{ table_name: 'tbl', column_names: ['name'] }] },
		);
		expect(
			(await introspect(pool)).tables.get('tbl')?.columns[0]?.collation,
		).toBe('en_US');
	});

	it('collation "default" — not stored', async () => {
		const pool = makeIntrospectPool(
			[
				col({
					table_name: 'tbl',
					column_name: 'name',
					data_type: 'text',
					udt_name: 'text',
					collation_name: 'default',
				}),
			],
			{ pks: [{ table_name: 'tbl', column_names: ['name'] }] },
		);
		expect(
			(await introspect(pool)).tables.get('tbl')?.columns[0]?.collation,
		).toBeUndefined();
	});
});

describe('introspection.mapPgType — all branches', () => {
	async function mapType(dataType: string, udtName: string): Promise<string> {
		const pool = makeIntrospectPool([
			col({
				table_name: 'tbl',
				column_name: 'c',
				data_type: dataType,
				udt_name: udtName,
			}),
		]);
		return (await introspect(pool)).tables.get('tbl')!.columns[0]!
			.type as string;
	}

	it('uuid udt → uuid', async () => {
		expect(await mapType('uuid', 'uuid')).toBe('uuid');
	});
	it('jsonb udt → jsonb', async () => {
		expect(await mapType('jsonb', 'jsonb')).toBe('jsonb');
	});
	it('json udt → json', async () => {
		expect(await mapType('json', 'json')).toBe('json');
	});
	it('int4range → int4range', async () => {
		expect(await mapType('USER-DEFINED', 'int4range')).toBe('int4range');
	});
	it('int8range → int8range', async () => {
		expect(await mapType('USER-DEFINED', 'int8range')).toBe('int8range');
	});
	it('numrange → numrange', async () => {
		expect(await mapType('USER-DEFINED', 'numrange')).toBe('numrange');
	});
	it('daterange → daterange', async () => {
		expect(await mapType('USER-DEFINED', 'daterange')).toBe('daterange');
	});
	it('tsrange → tsrange', async () => {
		expect(await mapType('USER-DEFINED', 'tsrange')).toBe('tsrange');
	});
	it('tstzrange → tstzrange', async () => {
		expect(await mapType('USER-DEFINED', 'tstzrange')).toBe('tstzrange');
	});
	it('integer → integer', async () => {
		expect(await mapType('integer', 'int4')).toBe('integer');
	});
	it('smallint → integer', async () => {
		expect(await mapType('smallint', 'int2')).toBe('integer');
	});
	it('bigint → bigint', async () => {
		expect(await mapType('bigint', 'int8')).toBe('bigint');
	});
	it('numeric → decimal', async () => {
		expect(await mapType('numeric', 'numeric')).toBe('decimal');
	});
	it('decimal → decimal', async () => {
		expect(await mapType('decimal', 'numeric')).toBe('decimal');
	});
	it('real → decimal', async () => {
		expect(await mapType('real', 'float4')).toBe('decimal');
	});
	it('double precision → decimal', async () => {
		expect(await mapType('double precision', 'float8')).toBe('decimal');
	});
	it('boolean → boolean', async () => {
		expect(await mapType('boolean', 'bool')).toBe('boolean');
	});
	it('character varying → string', async () => {
		expect(await mapType('character varying', 'varchar')).toBe('string');
	});
	it('character → string', async () => {
		expect(await mapType('character', 'bpchar')).toBe('string');
	});
	it('varchar → string', async () => {
		expect(await mapType('varchar', 'varchar')).toBe('string');
	});
	it('char → string', async () => {
		expect(await mapType('char', 'bpchar')).toBe('string');
	});
	it('text → text', async () => {
		expect(await mapType('text', 'text')).toBe('text');
	});
	it('date → date', async () => {
		expect(await mapType('date', 'date')).toBe('date');
	});
	it('time without time zone → time', async () => {
		expect(await mapType('time without time zone', 'time')).toBe('time');
	});
	it('time with time zone → time', async () => {
		expect(await mapType('time with time zone', 'timetz')).toBe('time');
	});
	it('timestamp without time zone → timestamp', async () => {
		expect(await mapType('timestamp without time zone', 'timestamp')).toBe(
			'timestamp',
		);
	});
	it('timestamp with time zone → datetime', async () => {
		expect(await mapType('timestamp with time zone', 'timestamptz')).toBe(
			'datetime',
		);
	});
	it('unknown type → string fallback', async () => {
		expect(await mapType('USER-DEFINED', 'custom_type')).toBe('string');
	});
});

// ---------------------------------------------------------------------------
// handlers/types.ts — type guards
// ---------------------------------------------------------------------------

describe('isSqlExpression', () => {
	it('true — object with string sql', () => {
		expect(isSqlExpression({ sql: 'SELECT 1' })).toBe(true);
	});
	it('false — null', () => {
		expect(isSqlExpression(null)).toBe(false);
	});
	it('false — non-object', () => {
		expect(isSqlExpression('str')).toBe(false);
	});
	it('false — sql not a string', () => {
		expect(isSqlExpression({ sql: 42 })).toBe(false);
	});
	it('false — no sql key', () => {
		expect(isSqlExpression({ other: 'v' })).toBe(false);
	});
});

describe('isRangeValue', () => {
	it('true — has lower', () => {
		expect(isRangeValue({ lower: 1 })).toBe(true);
	});
	it('true — has upper', () => {
		expect(isRangeValue({ upper: 100 })).toBe(true);
	});
	it('false — null', () => {
		expect(isRangeValue(null)).toBe(false);
	});
	it('false — primitive', () => {
		expect(isRangeValue(42)).toBe(false);
	});
	it('false — neither lower nor upper', () => {
		expect(isRangeValue({ value: 5 })).toBe(false);
	});
});

describe('isParamRef', () => {
	it('true — numeric paramIndex', () => {
		expect(isParamRef({ paramIndex: 1 })).toBe(true);
	});
	it('false — null', () => {
		expect(isParamRef(null)).toBe(false);
	});
	it('false — non-object', () => {
		expect(isParamRef('str')).toBe(false);
	});
	it('false — paramIndex not a number', () => {
		expect(isParamRef({ paramIndex: '1' })).toBe(false);
	});
	it('false — paramIndex missing', () => {
		expect(isParamRef({ other: 1 })).toBe(false);
	});
});

describe('isSelectWithFields', () => {
	it('true — array fields', () => {
		expect(isSelectWithFields({ fields: ['a'] })).toBe(true);
	});
	it('true — undefined fields', () => {
		expect(isSelectWithFields({ fields: undefined })).toBe(true);
	});
	it('false — null', () => {
		expect(isSelectWithFields(null)).toBe(false);
	});
	it('false — no fields key', () => {
		expect(isSelectWithFields({ other: [] })).toBe(false);
	});
	it('false — non-object', () => {
		expect(isSelectWithFields('str')).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// assert-field.ts — requiredColumn
// ---------------------------------------------------------------------------

describe('requiredColumn', () => {
	it('throws without context', () => {
		expect(() => requiredColumn(undefined, 'column')).toThrow(
			"Missing required column 'column'",
		);
	});
	it('throws with context appended', () => {
		expect(() => requiredColumn(undefined, 'fkCol', 'JOIN handler')).toThrow(
			"Missing required column 'fkCol' in JOIN handler",
		);
	});
	it('returns value when defined', () => {
		expect(requiredColumn('user_id', 'fkCol')).toBe('user_id');
	});
	it('throws for empty string', () => {
		expect(() => requiredColumn('', 'col')).toThrow(
			"Missing required column 'col'",
		);
	});
});

// ---------------------------------------------------------------------------
// handlers/expression/case-value.ts — resolveCaseValue
// ---------------------------------------------------------------------------

describe('resolveCaseValue', () => {
	it('null → nullConstNode', () => {
		expect(
			resolveCaseValue(null, 't', undefined, undefined, createCompilerState()),
		).toMatchObject({
			A_Const: { isnull: true },
		});
	});

	it('undefined → nullConstNode', () => {
		expect(
			resolveCaseValue(
				undefined,
				't',
				undefined,
				undefined,
				createCompilerState(),
			),
		).toMatchObject({
			A_Const: { isnull: true },
		});
	});

	it('string → columnRef', () => {
		const node = resolveCaseValue(
			'myCol',
			'tbl',
			undefined,
			undefined,
			createCompilerState(),
		) as {
			ColumnRef: { fields: { String: { sval: string } }[] };
		};
		expect(node.ColumnRef.fields[0]!.String.sval).toBe('tbl');
		expect(node.ColumnRef.fields[1]!.String.sval).toBe('myCol');
	});

	it('number (non-object) → ParamRef', () => {
		const s = createCompilerState();
		expect(resolveCaseValue(42, 't', undefined, undefined, s)).toMatchObject({
			ParamRef: { number: 1 },
		});
		expect(s.parameters).toEqual([42]);
	});

	it('boolean (non-object) → ParamRef', () => {
		const s = createCompilerState();
		expect(resolveCaseValue(true, 't', undefined, undefined, s)).toMatchObject({
			ParamRef: { number: 1 },
		});
	});

	it('literal null → nullConstNode', () => {
		expect(
			resolveCaseValue(
				{ kind: 'literal', value: null },
				't',
				undefined,
				undefined,
				createCompilerState(),
			),
		).toMatchObject({ A_Const: { isnull: true } });
	});

	it('literal boolean → boolval node', () => {
		expect(
			resolveCaseValue(
				{ kind: 'literal', value: true },
				't',
				undefined,
				undefined,
				createCompilerState(),
			),
		).toMatchObject({ A_Const: { boolval: { boolval: true } } });
	});

	it('literal integer → Integer node', () => {
		expect(
			resolveCaseValue(
				{ kind: 'literal', value: 5 },
				't',
				undefined,
				undefined,
				createCompilerState(),
			),
		).toMatchObject({ Integer: { ival: 5 } });
	});

	it('literal float → Float node', () => {
		expect(
			resolveCaseValue(
				{ kind: 'literal', value: 3.14 },
				't',
				undefined,
				undefined,
				createCompilerState(),
			),
		).toMatchObject({ Float: { fval: '3.14' } });
	});

	it('literal string → ParamRef', () => {
		const s = createCompilerState();
		expect(
			resolveCaseValue(
				{ kind: 'literal', value: 'active' },
				't',
				undefined,
				undefined,
				s,
			),
		).toMatchObject({
			ParamRef: { number: 1 },
		});
		expect(s.parameters).toEqual(['active']);
	});

	it('column expression → columnRef', () => {
		const node = resolveCaseValue(
			{ kind: 'column', column: 'status' },
			'tbl',
			undefined,
			undefined,
			createCompilerState(),
		) as { ColumnRef: { fields: { String: { sval: string } }[] } };
		expect(node.ColumnRef.fields[0]!.String.sval).toBe('tbl');
		expect(node.ColumnRef.fields[1]!.String.sval).toBe('status');
	});

	it('arithmetic expression → A_Expr', () => {
		const node = resolveCaseValue(
			{
				kind: 'arithmetic',
				operator: '+',
				left: { kind: 'literal', value: 1 },
				right: { kind: 'literal', value: 2 },
			},
			't',
			undefined,
			undefined,
			createCompilerState(),
		);
		expect(node).toMatchObject({
			A_Expr: { kind: 'AEXPR_OP', name: [{ String: { sval: '+' } }] },
		});
	});

	it('case without nestedCaseHandler → falls through to ParamRef', () => {
		const s = createCompilerState();
		const caseExpr = { kind: 'case', conditions: [] };
		expect(
			resolveCaseValue(caseExpr, 't', undefined, undefined, s),
		).toMatchObject({ ParamRef: { number: 1 } });
		expect(s.parameters[0]).toBe(caseExpr);
	});

	it('case with nestedCaseHandler → handler invoked', () => {
		const s = createCompilerState();
		const result = { A_Const: { isnull: true } };
		const handler = vi.fn().mockReturnValue(result);
		const caseExpr = { kind: 'case', conditions: [] };
		expect(
			resolveCaseValue(caseExpr, 't', undefined, undefined, s, handler),
		).toBe(result);
		expect(handler).toHaveBeenCalledWith(caseExpr);
	});

	it('unknown kind → default ParamRef', () => {
		const s = createCompilerState();
		const weird = { kind: 'unknown_expr' };
		expect(resolveCaseValue(weird, 't', undefined, undefined, s)).toMatchObject(
			{ ParamRef: { number: 1 } },
		);
		expect(s.parameters[0]).toBe(weird);
	});
});

// ---------------------------------------------------------------------------
// handlers/expression/case.ts — caseHandler + simpleCaseHandler
// ---------------------------------------------------------------------------

describe('caseHandler.compile', () => {
	const ctx = {
		naming: preserveNaming,
		rootTable: 'tbl',
		maxRecursiveDepth: 10,
	};

	it('throws when conditions is empty array', () => {
		expect(() =>
			caseHandler.compile(
				{
					type: 'case',
					conditions: [],
					column: undefined,
					value: undefined,
				} as never,
				ctx as never,
				createCompilerState(),
			),
		).toThrow('CASE requires at least one WHEN condition');
	});

	it('throws when conditions is undefined', () => {
		expect(() =>
			caseHandler.compile(
				{
					type: 'case',
					conditions: undefined,
					column: undefined,
					value: undefined,
				} as never,
				ctx as never,
				createCompilerState(),
			),
		).toThrow('CASE requires at least one WHEN condition');
	});

	// Positive-path tests (reaching WHEN dispatch) hit require('../index.js') which
	// resolves against dist/ only at runtime, not in source-level unit tests.
	// Those branches are exercised by the integration suite (case-when.test.ts).
});

describe('simpleCaseHandler.compile', () => {
	const ctx = {
		naming: preserveNaming,
		rootTable: 'tbl',
		maxRecursiveDepth: 10,
	};

	it('throws when column is missing', () => {
		expect(() =>
			simpleCaseHandler.compile(
				{
					type: 'simpleCase',
					column: undefined,
					// biome-ignore lint/suspicious/noThenProperty: testing CASE expression data structure (not a Promise)
					conditions: [{ when: { value: 1 }, then: 'x' }],
					value: undefined,
				} as never,
				ctx as never,
				createCompilerState(),
			),
		).toThrow('Simple CASE requires a column');
	});

	it('throws when conditions is empty', () => {
		expect(() =>
			simpleCaseHandler.compile(
				{
					type: 'simpleCase',
					column: 'status',
					conditions: [],
					value: undefined,
				} as never,
				ctx as never,
				createCompilerState(),
			),
		).toThrow('Simple CASE requires at least one WHEN condition');
	});

	it('compiles without else — defresult undefined', () => {
		const node = simpleCaseHandler.compile(
			{
				type: 'simpleCase',
				column: 'status',
				// biome-ignore lint/suspicious/noThenProperty: testing CASE expression data structure (not a Promise)
				conditions: [{ when: { value: 'active' }, then: 'Active' }],
				value: undefined,
			} as never,
			ctx as never,
			createCompilerState(),
		);
		const ce = (node as { CaseExpr: { defresult?: unknown; arg: unknown } })
			.CaseExpr;
		expect(ce.defresult).toBeUndefined();
		expect(ce.arg).toBeDefined();
	});

	it('compiles with else — defresult defined', () => {
		const node = simpleCaseHandler.compile(
			{
				type: 'simpleCase',
				column: 'status',
				// biome-ignore lint/suspicious/noThenProperty: testing CASE expression data structure (not a Promise)
				conditions: [{ when: { value: 'active' }, then: 'Active' }],
				value: 'Unknown',
			} as never,
			ctx as never,
			createCompilerState(),
		);
		expect(
			(node as { CaseExpr: { defresult?: unknown } }).CaseExpr.defresult,
		).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// recursive/path-tracking.ts
// ---------------------------------------------------------------------------

describe('buildPathColumn', () => {
	it('ResTarget __path with ARRAY[pk::text]', () => {
		const rt = (
			buildPathColumn('a', 'id') as {
				ResTarget: { name: string; val: unknown };
			}
		).ResTarget;
		expect(rt.name).toBe('__path');
		expect(rt.val).toMatchObject({
			A_ArrayExpr: { elements: expect.any(Array) },
		});
	});
});

describe('appendPathColumn', () => {
	it('ResTarget __path with || A_Expr', () => {
		const rt = (
			appendPathColumn('cte', 'inner', 'id') as {
				ResTarget: { name: string; val: unknown };
			}
		).ResTarget;
		expect(rt.name).toBe('__path');
		expect(rt.val).toMatchObject({ A_Expr: expect.any(Object) });
	});
});

describe('buildJsonPathColumn', () => {
	it('ResTarget __json_path with json_agg', () => {
		const rt = (
			buildJsonPathColumn('t', 'id') as {
				ResTarget: { name: string; val: unknown };
			}
		).ResTarget;
		expect(rt.name).toBe('__json_path');
		expect(rt.val).toMatchObject({
			FuncCall: { funcname: [{ String: { sval: 'json_agg' } }] },
		});
	});

	it('uses custom depthColumn in ORDER BY', () => {
		const rt = (
			buildJsonPathColumn('t', 'id', 'level') as {
				ResTarget: {
					val: {
						FuncCall: {
							agg_order: {
								SortBy: {
									node: {
										ColumnRef: { fields: { String: { sval: string } }[] };
									};
								};
							}[];
						};
					};
				};
			}
		).ResTarget;
		expect(
			rt.val.FuncCall.agg_order[0]!.SortBy.node.ColumnRef.fields[1]!.String
				.sval,
		).toBe('level');
	});
});

describe('buildPathString', () => {
	it('ResTarget __path_string with default separator /', () => {
		const rt = (
			buildPathString('cte') as { ResTarget: { name: string; val: unknown } }
		).ResTarget;
		expect(rt.name).toBe('__path_string');
		const args = (
			rt.val as {
				FuncCall: { args: { A_Const: { sval: { sval: string } } }[] };
			}
		).FuncCall.args;
		expect(args[1]!.A_Const.sval.sval).toBe('/');
	});

	it('respects custom separator', () => {
		const rt = (
			buildPathString('cte', ' > ') as {
				ResTarget: {
					val: {
						FuncCall: { args: { A_Const: { sval: { sval: string } } }[] };
					};
				};
			}
		).ResTarget;
		expect(rt.val.FuncCall.args[1]!.A_Const.sval.sval).toBe(' > ');
	});
});

// ---------------------------------------------------------------------------
// adapter-compiler-recursive.ts — compileCteQuery CTE kind branches
// ---------------------------------------------------------------------------

describe('compileCteQuery — CTE kind branches', () => {
	it('throws for unsupported CTE kind', () => {
		expect(() =>
			compileCteQuery(
				{
					ctes: [{ kind: 'unknownCte', name: 'x' }],
					query: { from: 'users', select: [] },
				} as never,
				undefined,
				defaultDeps,
			),
		).toThrow("Unsupported CTE kind 'unknownCte'");
	});

	it('simpleCte — emits WITH "name" AS (...)', () => {
		const r = compileCteQuery(
			{
				ctes: [
					{
						kind: 'simpleCte',
						name: 'cte_users',
						query: { from: 'users', select: [] },
					},
				],
				query: { from: 'users', select: [] },
			} as never,
			undefined,
			defaultDeps,
		);
		expect(r.sql).toMatch(/^WITH "cte_users" AS/);
	});

	it('simpleCte — does NOT produce WITH RECURSIVE', () => {
		const r = compileCteQuery(
			{
				ctes: [
					{
						kind: 'simpleCte',
						name: 'sub',
						query: { from: 'users', select: [] },
					},
				],
				query: { from: 'users', select: [] },
			} as never,
			undefined,
			defaultDeps,
		);
		expect(r.sql).not.toMatch(/WITH RECURSIVE/);
	});

	it('rawCte — produces WITH RECURSIVE', () => {
		const r = compileCteQuery(
			{
				ctes: [
					{
						kind: 'rawCte',
						name: 'tree',
						base: { from: 'n', select: [] },
						step: { from: 'n', select: [] },
						unionAll: true,
					},
				],
				query: { from: 'n', select: [] },
			} as never,
			undefined,
			defaultDeps,
		);
		expect(r.sql).toMatch(/WITH RECURSIVE/);
	});

	it('rawCte with maxDepth — injects depth guard param', () => {
		const r = compileCteQuery(
			{
				ctes: [
					{
						kind: 'rawCte',
						name: 'tree',
						base: { from: 'n', select: [] },
						step: { from: 'n', select: [] },
						unionAll: false,
						maxDepth: 5,
						depthColumn: 'depth',
					},
				],
				query: { from: 'n', select: [] },
			} as never,
			undefined,
			defaultDeps,
		);
		expect(r.sql).toMatch(/< \$\d+/);
		expect(r.parameters).toContain(5);
	});

	it('rawCte unionAll=false — uses UNION not UNION ALL', () => {
		const r = compileCteQuery(
			{
				ctes: [
					{
						kind: 'rawCte',
						name: 'it',
						base: { from: 'n', select: [] },
						step: { from: 'n', select: [] },
						unionAll: false,
					},
				],
				query: { from: 'n', select: [] },
			} as never,
			undefined,
			defaultDeps,
		);
		expect(r.sql).toMatch(/\bUNION\b/);
		expect(r.sql).not.toMatch(/UNION ALL/);
	});

	it('empty CTE list — outer query emitted without WITH prefix', () => {
		const r = compileCteQuery(
			{ ctes: [], query: { from: 'users', select: [] } } as never,
			undefined,
			defaultDeps,
		);
		expect(r.sql).not.toMatch(/^WITH/);
	});
});

// ---------------------------------------------------------------------------
// adapter-compiler-recursive.ts — compileRecursive unsupported traversal
// ---------------------------------------------------------------------------

describe('compileRecursive — unsupported traversal', () => {
	it('throws for "custom" traversal kind', () => {
		const report: RecursivePlanReport = {
			intent: {
				traversal: { kind: 'custom' } as never,
				cteName: 'tree',
				maxDepth: 10,
				start: { nodeIdExpr: { kind: 'column', name: 'id' }, select: [] },
			},
		} as never;
		expect(() =>
			compileRecursive(report, {} as never, undefined, defaultDeps),
		).toThrow("Unsupported traversal kind 'custom'");
	});
});
