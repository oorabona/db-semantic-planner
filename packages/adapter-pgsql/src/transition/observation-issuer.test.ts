import type { ObservationContext, ObservationRequest } from '@dbsp/types';
import { describe, expect, it, vi } from 'vitest';
import {
	ALTER_AUTHORITY_OBSERVATION,
	ENGINE_VERSION_OBSERVATION,
} from './constants.js';
import {
	createPgObservationIssuer,
	readPgObservationContext,
} from './observation-issuer.js';

const context: ObservationContext = {
	engine: 'postgresql',
	engineVersion: '180000',
	databaseId: 'test',
	capabilities: ['alter-column-set-not-null'],
	privileges: [],
	searchPath: ['tenant'],
	sessionConfiguration: {},
	extensions: {},
};

function engineRequest(minServerVersionNum: number): ObservationRequest {
	return {
		kind: ENGINE_VERSION_OBSERVATION,
		scope: [
			{
				engine: 'postgresql',
				database: 'test',
				kind: 'engine',
				name: 'postgresql',
			},
		],
		detail: { minServerVersionNum },
	};
}

describe('PostgreSQL transition observation issuer', () => {
	it('binds engine-version evidence to the request minimum', async () => {
		const issuer = createPgObservationIssuer();
		const observation = await issuer.execute(
			engineRequest(190000),
			{
				query: async () => ({ rows: [{ server_version_num: '180000' }] }),
			},
			context,
		);

		expect(observation.request.detail).toEqual({
			minServerVersionNum: 190000,
		});
		expect(observation.result.value).toMatchObject({
			serverVersionNum: 180000,
			minServerVersionNum: 190000,
			supported: false,
		});
	});

	it('uses effective-role USAGE membership for ALTER authority evidence', async () => {
		const issuer = createPgObservationIssuer();
		const queries: string[] = [];
		await issuer.execute(
			{
				kind: ALTER_AUTHORITY_OBSERVATION,
				scope: [],
				detail: { schema: 'tenant', table: 'users', column: 'age' },
			},
			{
				query: async (sql: string) => {
					queries.push(sql);
					return {
						rows: [
							{
								has_table_alter_authority: true,
								has_schema_usage: true,
							},
						],
					};
				},
			},
			context,
		);

		expect(queries[0]).toContain("'USAGE'");
		expect(queries[0]).toContain('has_schema_privilege');
		expect(queries[0]).not.toContain('MEMBER');
	});

	it('fails closed for schema-less relation observations instead of using search_path', async () => {
		const issuer = createPgObservationIssuer();
		const query = vi.fn(async () => ({ rows: [] }));

		await expect(
			issuer.execute(
				{
					kind: ALTER_AUTHORITY_OBSERVATION,
					scope: [],
					detail: { table: 'users', column: 'age' },
				},
				{ query },
				context,
			),
		).rejects.toThrow(/requires explicit schema detail/);
		expect(query).not.toHaveBeenCalled();
	});

	it('requires schema USAGE for ALTER authority evidence', async () => {
		const issuer = createPgObservationIssuer();
		const observation = await issuer.execute(
			{
				kind: ALTER_AUTHORITY_OBSERVATION,
				scope: [],
				detail: { schema: 'tenant', table: 'users', column: 'age' },
			},
			{
				query: async () => ({
					rows: [
						{
							has_table_alter_authority: true,
							has_schema_usage: false,
						},
					],
				}),
			},
			context,
		);

		expect(observation.result.value).toMatchObject({
			hasAlterAuthority: false,
			hasTableAlterAuthority: true,
			hasSchemaUsage: false,
			claims: [{ kind: ALTER_AUTHORITY_OBSERVATION, holds: false }],
		});
	});

	it('reads resolved schemas without splitting SHOW search_path', async () => {
		const contextFromDb = await readPgObservationContext(
			{
				query: async (sql: string) => {
					if (sql === 'SHOW server_version_num') {
						return { rows: [{ server_version_num: '180000' }] };
					}
					if (sql === 'SELECT current_database() AS database_id') {
						return { rows: [{ database_id: 'db' }] };
					}
					if (sql === 'SELECT current_user AS current_user') {
						return { rows: [{ current_user: 'role,with,commas' }] };
					}
					if (sql.includes('current_schemas(false)')) {
						return { rows: [{ search_path: ['role,with,commas', 'public'] }] };
					}
					if (sql === 'SHOW search_path') {
						return { rows: [{ search_path: '"$user", public' }] };
					}
					throw new Error(`unexpected query: ${sql}`);
				},
			},
			'tenant',
		);

		expect(contextFromDb.searchPath).toEqual(['tenant']);
		expect(contextFromDb.sessionConfiguration.actual_search_path).toBe(
			JSON.stringify(['role,with,commas', 'public']),
		);
	});

	it('reads observation context sequentially on one checked-out pool client', async () => {
		const queries: string[] = [];
		let inFlight = 0;
		let maxInFlight = 0;
		const release = vi.fn();
		const client = {
			query: async (sql: string) => {
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise((resolve) => setTimeout(resolve, 0));
				queries.push(sql);
				inFlight -= 1;
				if (sql === 'SHOW server_version_num') {
					return { rows: [{ server_version_num: '180000' }] };
				}
				if (sql === 'SELECT current_database() AS database_id') {
					return { rows: [{ database_id: 'db' }] };
				}
				if (sql === 'SELECT current_user AS current_user') {
					return { rows: [{ current_user: 'tenant_owner' }] };
				}
				if (sql.includes('current_schemas(false)')) {
					return { rows: [{ search_path: ['tenant', 'public'] }] };
				}
				if (sql === 'SHOW search_path') {
					return { rows: [{ search_path: 'tenant, public' }] };
				}
				throw new Error(`unexpected query: ${sql}`);
			},
			release,
		};
		const pool = {
			connect: vi.fn(async () => client),
		};

		const contextFromDb = await readPgObservationContext(pool, 'tenant');

		expect(pool.connect).toHaveBeenCalledOnce();
		expect(release).toHaveBeenCalledOnce();
		expect(maxInFlight).toBe(1);
		expect(queries).toEqual([
			'SHOW server_version_num',
			'SELECT current_database() AS database_id',
			'SELECT current_user AS current_user',
			'SELECT pg_catalog.to_json(pg_catalog.current_schemas(false)) AS search_path',
			'SHOW search_path',
		]);
		expect(contextFromDb.effectiveRole).toBe('tenant_owner');
	});
});
