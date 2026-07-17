import type {
	ApplyGuard,
	ObservationContext,
	PhysicalOperation,
} from '@dbsp/types';
import { describe, expect, it, vi } from 'vitest';
import {
	CREATE_UNIQUE_INDEX_CONCURRENTLY_CAPABILITY,
	CREATE_UNIQUE_INDEX_CONCURRENTLY_OPERATION_KIND,
	NO_DUPLICATES_FOR_UNIQUE_INDEX_BUILD_GUARD,
} from '../constants.js';
import {
	createCreateUniqueIndexConcurrentlyOperationRuntime,
	renderCreateUniqueIndexConcurrentlySql,
} from './create-unique-index-concurrently.js';

const context: ObservationContext = {
	engine: 'postgresql',
	engineVersion: '180000',
	databaseId: 'test',
	capabilities: [CREATE_UNIQUE_INDEX_CONCURRENTLY_CAPABILITY],
	privileges: [],
	effectiveRole: 'tenant_owner',
	searchPath: ['tenant'],
	sessionConfiguration: {},
	extensions: {},
};

const operation: PhysicalOperation = {
	ref: 'postgresql:create-unique-index-concurrently:["tenant","users","idx_users_email"]',
	operationKind: CREATE_UNIQUE_INDEX_CONCURRENTLY_OPERATION_KIND,
	payload: {
		schema: 'tenant',
		table: 'users',
		index: 'idx_users_email',
		columns: ['email'],
	} as never,
};

function guard(): ApplyGuard {
	return {
		appliesTo: operation.ref,
		predicate: {
			kind: NO_DUPLICATES_FOR_UNIQUE_INDEX_BUILD_GUARD,
			scope: [
				{
					engine: 'postgresql',
					database: 'test',
					schema: 'tenant',
					kind: 'index',
					name: 'idx_users_email',
					qualifiedBy: ['users'],
				},
			],
			detail: {
				schema: 'tenant',
				table: 'users',
				index: 'idx_users_email',
				columns: ['email'],
			},
		},
		protocol: {
			kind: 'engine-validated',
			onFailureLeaves: [
				{
					kind: 'invalid-index',
					resource: {
						engine: 'postgresql',
						database: 'test',
						schema: 'tenant',
						kind: 'index',
						name: 'idx_users_email',
						qualifiedBy: ['users'],
					},
				},
			],
			binding: {
				kind: 'external-ddl-exclusion',
				assumption: 'assumption:cic' as never,
				scope: [],
			},
		},
		phase: 'during-operation',
	};
}

function targetRow(overrides: Record<string, unknown> = {}) {
	return {
		table_oid: '10001',
		relkind: 'r',
		schema_name: 'tenant',
		table_name: 'users',
		index_oid: '20002',
		index_name: 'idx_users_email',
		indisunique: true,
		indisvalid: true,
		indisready: true,
		nulls_not_distinct: false,
		method: 'btree',
		predicate: null,
		expressions_text: null,
		reloptions: null,
		columns: ['email'],
		include_columns: [],
		opclass_cols: [],
		opclass_names: [],
		...overrides,
	};
}

async function observeAfter(row: Record<string, unknown> = targetRow()) {
	const runtime = createCreateUniqueIndexConcurrentlyOperationRuntime();
	const client = {
		opaqueClient: {
			query: vi.fn(async () => ({ rows: [row] })),
		},
	};
	return runtime.observeOperation(
		client,
		operation,
		context,
		'after',
		{} as never,
	);
}

describe('CreateUniqueIndexConcurrently operation runtime', () => {
	it('renders the supported CREATE UNIQUE INDEX CONCURRENTLY statement', () => {
		expect(
			renderCreateUniqueIndexConcurrentlySql({
				schema: 'tenant',
				table: 'users',
				index: 'idx_users_email',
				columns: ['email'],
			}),
		).toBe(
			'CREATE UNIQUE INDEX CONCURRENTLY "idx_users_email" ON "tenant"."users" ("email")',
		);
	});

	it('declares forbids-transaction execution and no acquired locks', () => {
		const runtime = createCreateUniqueIndexConcurrentlyOperationRuntime();
		const effects = runtime.effectsOf(operation, context);

		expect(effects.effects.execution).toEqual({
			transaction: 'forbids-transaction',
			commitBoundary: 'before-and-after',
		});
		expect(effects.effects.locks).toEqual([]);
	});

	it('recognizes raw pg_index flags for a valid ready matching target index', async () => {
		const result = await observeAfter(targetRow());

		expect(result.fingerprint.includedFacts).toEqual(
			expect.arrayContaining([
				{ key: 'pg_index.idx_users_email.indisunique', value: 'boolean:true' },
				{ key: 'pg_index.idx_users_email.indisvalid', value: 'boolean:true' },
				{ key: 'pg_index.idx_users_email.indisready', value: 'boolean:true' },
			]),
		);
	});

	it('normalizes JSON arrays and PostgreSQL text-array literals equivalently', async () => {
		const jsonResult = await observeAfter(
			targetRow({
				columns: ['email'],
				include_columns: [],
				opclass_cols: [],
				opclass_names: [],
			}),
		);
		const literalResult = await observeAfter(
			targetRow({
				columns: '{email}',
				include_columns: '{}',
				opclass_cols: '{}',
				opclass_names: '{}',
			}),
		);

		expect(literalResult.fingerprint).toEqual(jsonResult.fingerprint);
	});

	it('requires indisvalid and indisready in the after fingerprint', async () => {
		const runtime = createCreateUniqueIndexConcurrentlyOperationRuntime();
		const client = {
			opaqueClient: {
				query: vi.fn(async () => ({
					rows: [targetRow({ indisvalid: false })],
				})),
			},
		};

		await expect(
			runtime.observeOperation(
				client,
				operation,
				context,
				'after',
				{} as never,
			),
		).rejects.toThrow(/valid ready matching unique index/);
	});

	it.each([
		['not ready', { indisready: false }],
		['wrong columns', { columns: ['id'] }],
		['non-btree method', { method: 'hash' }],
		['partial predicate', { predicate: '(email IS NOT NULL)' }],
		['expression key', { expressions_text: 'lower(email)' }],
		['included column', { include_columns: ['id'] }],
		[
			'non-default opclass',
			{ opclass_cols: ['email'], opclass_names: ['text_pattern_ops'] },
		],
		['reloptions', { reloptions: ['fillfactor=70'] }],
		['NULLS NOT DISTINCT', { nulls_not_distinct: true }],
	])('rejects a target index with %s', async (_label, overrides) => {
		await expect(observeAfter(targetRow(overrides))).rejects.toThrow(
			/valid ready matching unique index/,
		);
	});

	it('rejects an absent target index after creation', async () => {
		await expect(observeAfter(targetRow({ index_name: null }))).rejects.toThrow(
			/target index is missing/,
		);
	});

	it('cleans an invalid index after unique-build failure and reports guard-failed', async () => {
		const runtime = createCreateUniqueIndexConcurrentlyOperationRuntime();
		const queries: string[] = [];
		let catalogReads = 0;
		const client = {
			opaqueClient: {
				query: vi.fn(async (sql: string) => {
					queries.push(sql);
					if (sql.startsWith('CREATE UNIQUE INDEX')) {
						throw { code: '23505', message: 'could not create unique index' };
					}
					if (sql.includes('FROM pg_catalog.pg_class t')) {
						catalogReads += 1;
						return {
							rows:
								catalogReads === 1
									? [targetRow({ indisvalid: false, indisready: false })]
									: [targetRow({ index_name: null })],
						};
					}
					return { rows: [] };
				}),
			},
		};

		const result = await runtime.executeOperation(client, operation, context, [
			guard(),
		]);

		expect(result).toEqual({
			kind: 'guard-failed',
			guard: guard(),
			recovery: [],
		});
		expect(queries).toContain(
			'DROP INDEX CONCURRENTLY IF EXISTS "tenant"."idx_users_email"',
		);
		expect(queries[0]).toBe("SET lock_timeout = '5000ms'");
		expect(queries.at(-1)).toBe('SET lock_timeout = DEFAULT');
	});

	it('reports partially-applied when invalid-index cleanup cannot be verified', async () => {
		const runtime = createCreateUniqueIndexConcurrentlyOperationRuntime();
		let catalogReads = 0;
		const client = {
			opaqueClient: {
				query: vi.fn(async (sql: string) => {
					if (sql.startsWith('CREATE UNIQUE INDEX')) {
						throw { code: '23505', message: 'could not create unique index' };
					}
					if (sql.includes('FROM pg_catalog.pg_class t')) {
						catalogReads += 1;
						return {
							rows:
								catalogReads === 1
									? [targetRow({ indisvalid: false, indisready: false })]
									: [targetRow({ indisvalid: false, indisready: false })],
						};
					}
					return { rows: [] };
				}),
			},
		};

		const result = await runtime.executeOperation(client, operation, context, [
			guard(),
		]);

		expect(result.kind).toBe('partially-applied');
		if (result.kind === 'partially-applied') {
			expect(result.recovery).toEqual([
				expect.objectContaining({
					kind: 'invalid-index',
					resource: expect.objectContaining({
						schema: 'tenant',
						name: 'idx_users_email',
					}),
				}),
			]);
			expect(result.detail).toMatch(/cleanup did not remove/);
		}
	});
});
