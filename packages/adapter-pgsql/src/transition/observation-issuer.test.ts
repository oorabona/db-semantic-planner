import type {
	JsonValue,
	ObservationContext,
	ObservationRequest,
} from '@dbsp/types';
import { describe, expect, it, vi } from 'vitest';
import {
	ALTER_AUTHORITY_OBSERVATION,
	ALTER_TYPE_AUTHORITY_OBSERVATION,
	COLUMN_EXISTS_OBSERVATION,
	ENGINE_VERSION_OBSERVATION,
	ENUM_LABEL_VISIBLE_OBSERVATION,
	PG_SCHEMA_USAGE_PRIVILEGE,
	PG_SET_NOT_NULL_AUTHORITY_PRIVILEGE,
	PG_TABLE_ALTER_AUTHORITY_PRIVILEGE,
	PG_TYPE_ALTER_AUTHORITY_PRIVILEGE,
	SET_NOT_NULL_RELATION_KIND_SUPPORTED_OBSERVATION,
} from './constants.js';
import {
	createPgObservationIssuer,
	readPgObservationContext,
} from './observation-issuer.js';
import { pgPrivilegeFact } from './privileges.js';

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

async function enumLabelVisibleHolds(
	labels: readonly string[],
	position?: JsonValue,
): Promise<boolean> {
	const issuer = createPgObservationIssuer();
	const detail =
		position === undefined
			? { schema: 'tenant', type: 'status', label: 'pending' }
			: { schema: 'tenant', type: 'status', label: 'pending', position };
	const observation = await issuer.execute(
		{
			kind: ENUM_LABEL_VISIBLE_OBSERVATION,
			scope: [],
			detail,
		},
		{
			query: async () => ({
				rows: [
					{
						oid: '90001',
						schema_name: 'tenant',
						type_name: 'status',
						labels,
					},
				],
			}),
		},
		context,
	);
	return (
		observation.result.value as {
			claims: readonly [{ readonly holds: boolean }];
		}
	).claims[0].holds;
}

describe('PostgreSQL transition observation issuer', () => {
	it('surfaces relation kind in column evidence for partitioned tables', async () => {
		const issuer = createPgObservationIssuer();
		const queries: string[] = [];
		const observation = await issuer.execute(
			{
				kind: COLUMN_EXISTS_OBSERVATION,
				scope: [],
				detail: { schema: 'tenant', table: 'users', column: 'age' },
			},
			{
				query: async (sql: string) => {
					queries.push(sql);
					return {
						rows: [
							{
								oid: '12345',
								relkind: 'p',
								attnum: 2,
								nullable: true,
								atttypid: '23',
								atttypmod: -1,
								format_type: 'integer',
								type_name: 'int4',
								type_schema: 'pg_catalog',
								has_default: false,
								auto_increment: false,
							},
						],
					};
				},
			},
			context,
		);

		expect(queries[0]).toContain('c.relkind AS relkind');
		expect(observation.result.value).toMatchObject({
			exists: true,
			relkind: 'p',
			claims: [
				{ kind: COLUMN_EXISTS_OBSERVATION, holds: true },
				{
					kind: SET_NOT_NULL_RELATION_KIND_SUPPORTED_OBSERVATION,
					holds: false,
				},
			],
		});
	});

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

	it('reads ALTER TYPE authority evidence for enum targets', async () => {
		const issuer = createPgObservationIssuer();
		const observation = await issuer.execute(
			{
				kind: ALTER_TYPE_AUTHORITY_OBSERVATION,
				scope: [],
				detail: { schema: 'tenant', type: 'status' },
			},
			{
				query: async () => ({
					rows: [
						{
							has_type_alter_authority: true,
							has_schema_usage: true,
						},
					],
				}),
			},
			context,
		);

		expect(observation.result.value).toMatchObject({
			hasAlterAuthority: true,
			hasTypeAlterAuthority: true,
			hasSchemaUsage: true,
			privileges: [
				pgPrivilegeFact(PG_SCHEMA_USAGE_PRIVILEGE, ['tenant'], true),
				pgPrivilegeFact(
					PG_TYPE_ALTER_AUTHORITY_PRIVILEGE,
					['tenant', 'status'],
					true,
				),
			],
			claims: [{ kind: ALTER_TYPE_AUTHORITY_OBSERVATION, holds: true }],
		});
	});

	it('emits ALTER TYPE authority under the type authority observation kind', async () => {
		const issuer = createPgObservationIssuer();
		const observation = await issuer.execute(
			{
				kind: ALTER_TYPE_AUTHORITY_OBSERVATION,
				scope: [],
				detail: { schema: 'tenant', type: 'status' },
			},
			{
				query: async () => ({
					rows: [
						{
							has_type_alter_authority: true,
							has_schema_usage: true,
						},
					],
				}),
			},
			context,
		);

		expect(observation.request.kind).toBe(ALTER_TYPE_AUTHORITY_OBSERVATION);
		expect(observation.result.value).toMatchObject({
			claims: [{ kind: ALTER_TYPE_AUTHORITY_OBSERVATION, holds: true }],
		});
	});

	it('checks enum label position when position detail is requested', async () => {
		const issuer = createPgObservationIssuer();
		const request: ObservationRequest = {
			kind: ENUM_LABEL_VISIBLE_OBSERVATION,
			scope: [],
			detail: {
				schema: 'tenant',
				type: 'status',
				label: 'pending',
				position: {
					mode: 'after',
					after: 'inactive',
					index: 1,
					atEnd: false,
				},
			},
		};
		const target = {
			query: async () => ({
				rows: [
					{
						oid: '90001',
						schema_name: 'tenant',
						type_name: 'status',
						labels: ['inactive', 'active', 'pending'],
					},
				],
			}),
		};

		const observation = await issuer.execute(request, target, context);
		const matchingObservation = await issuer.execute(
			{
				...request,
				detail: {
					schema: 'tenant',
					type: 'status',
					label: 'pending',
					position: {
						mode: 'append',
						after: 'active',
						index: 2,
						atEnd: true,
					},
				},
			},
			target,
			context,
		);

		expect(observation.result.value).toMatchObject({
			claims: [{ kind: ENUM_LABEL_VISIBLE_OBSERVATION, holds: false }],
		});
		expect(matchingObservation.result.value).toMatchObject({
			claims: [{ kind: ENUM_LABEL_VISIBLE_OBSERVATION, holds: true }],
		});
	});

	it('fails closed for unsupported enum label position modes', async () => {
		await expect(
			enumLabelVisibleHolds(['inactive', 'pending', 'active'], {
				mode: 'between',
				after: 'inactive',
			}),
		).resolves.toBe(false);
	});

	it('fails closed for after-position requests without a valid after label', async () => {
		await expect(
			enumLabelVisibleHolds(['inactive', 'pending', 'active'], {
				mode: 'after',
			}),
		).resolves.toBe(false);
		await expect(
			enumLabelVisibleHolds(['inactive', 'pending', 'active'], {
				mode: 'after',
				after: 1,
			}),
		).resolves.toBe(false);
	});

	it('fails closed for unsupported before-position shapes', async () => {
		await expect(
			enumLabelVisibleHolds(['inactive', 'pending', 'active'], {
				mode: 'before',
				before: 'active',
			}),
		).resolves.toBe(false);
		await expect(
			enumLabelVisibleHolds(['inactive', 'pending', 'active'], {
				mode: 'after',
				after: 'inactive',
				before: 'active',
			}),
		).resolves.toBe(false);
	});

	it('binds after-position evidence to the observed enum label order', async () => {
		await expect(
			enumLabelVisibleHolds(['inactive', 'pending', 'active'], {
				mode: 'after',
				after: 'inactive',
			}),
		).resolves.toBe(true);
		await expect(
			enumLabelVisibleHolds(['inactive', 'active', 'pending'], {
				mode: 'after',
				after: 'inactive',
			}),
		).resolves.toBe(false);
	});

	it('rejects unsupported enum observation detail fields before querying', async () => {
		const issuer = createPgObservationIssuer();
		const query = vi.fn(async () => ({ rows: [] }));

		await expect(
			issuer.execute(
				{
					kind: ENUM_LABEL_VISIBLE_OBSERVATION,
					scope: [],
					detail: {
						schema: 'tenant',
						type: 'status',
						label: 'pending',
						visibility: 'transaction-local',
					},
				},
				{ query },
				context,
			),
		).rejects.toThrow(/unsupported field visibility/);
		expect(query).not.toHaveBeenCalled();
	});

	it('rejects enum-label-visible requests without a label', async () => {
		const issuer = createPgObservationIssuer();
		const query = vi.fn(async () => ({ rows: [] }));

		await expect(
			issuer.execute(
				{
					kind: ENUM_LABEL_VISIBLE_OBSERVATION,
					scope: [],
					detail: { schema: 'tenant', type: 'status' },
				},
				{ query },
				context,
			),
		).rejects.toThrow(/requires enum label detail/);
		expect(query).not.toHaveBeenCalled();
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
					if (sql === 'SHOW standard_conforming_strings') {
						return { rows: [{ standard_conforming_strings: 'on' }] };
					}
					if (sql.includes('pg_extension')) {
						return { rows: [] };
					}
					if (sql.includes('pg_database')) {
						return {
							rows: [
								{
									collation_provider: 'c',
									collation_version: '153.120',
								},
							],
						};
					}
					throw new Error(`unexpected query: ${sql}`);
				},
			},
			'tenant',
		);

		expect(contextFromDb.searchPath).toEqual(['tenant']);
		expect(contextFromDb.targetSchema).toBe('tenant');
		expect(contextFromDb.capabilities).toEqual([]);
		expect(contextFromDb.extensions).toEqual({});
		expect(contextFromDb.collationProvider).toBe('c');
		expect(contextFromDb.collationVersion).toBe('153.120');
		expect(contextFromDb.sessionConfiguration.actual_search_path).toBe(
			JSON.stringify(['role,with,commas', 'public']),
		);
		expect(contextFromDb.sessionConfiguration.standard_conforming_strings).toBe(
			'on',
		);
	});

	it('reads target-scoped privilege facts into context when a target is known', async () => {
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
						return { rows: [{ current_user: 'tenant_owner' }] };
					}
					if (sql.includes('current_schemas(false)')) {
						return { rows: [{ search_path: ['tenant', 'public'] }] };
					}
					if (sql === 'SHOW search_path') {
						return { rows: [{ search_path: 'tenant, public' }] };
					}
					if (sql === 'SHOW standard_conforming_strings') {
						return { rows: [{ standard_conforming_strings: 'on' }] };
					}
					if (sql.includes('pg_extension')) {
						return {
							rows: [{ name: 'vector', version: '0.8.0' }],
						};
					}
					if (sql.includes('pg_database')) {
						return {
							rows: [{ collation_provider: null, collation_version: null }],
						};
					}
					if (sql.includes('pg_has_role')) {
						return {
							rows: [
								{
									has_table_alter_authority: true,
									has_schema_usage: true,
								},
							],
						};
					}
					throw new Error(`unexpected query: ${sql}`);
				},
			},
			'tenant',
			{ schema: 'tenant', table: 'users', column: 'age' },
		);

		expect(contextFromDb.extensions).toEqual({ vector: '0.8.0' });
		expect(contextFromDb.targetSchema).toBe('tenant');
		expect(contextFromDb.privileges).toEqual([
			pgPrivilegeFact(PG_SCHEMA_USAGE_PRIVILEGE, ['tenant'], true),
			pgPrivilegeFact(
				PG_TABLE_ALTER_AUTHORITY_PRIVILEGE,
				['tenant', 'users'],
				true,
			),
			pgPrivilegeFact(
				PG_SET_NOT_NULL_AUTHORITY_PRIVILEGE,
				['tenant', 'users', 'age'],
				true,
			),
		]);
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
				if (sql === 'SHOW standard_conforming_strings') {
					return { rows: [{ standard_conforming_strings: 'on' }] };
				}
				if (sql.includes('pg_extension')) {
					return { rows: [] };
				}
				if (sql.includes('pg_database')) {
					return {
						rows: [{ collation_provider: null, collation_version: null }],
					};
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
			'SHOW standard_conforming_strings',
			'SELECT extname AS name, extversion AS version FROM pg_catalog.pg_extension ORDER BY extname',
			"SELECT pg_catalog.to_jsonb(d)->>'datlocprovider' AS collation_provider, pg_catalog.to_jsonb(d)->>'datcollversion' AS collation_version FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()",
		]);
		expect(contextFromDb.effectiveRole).toBe('tenant_owner');
		expect(contextFromDb.targetSchema).toBe('tenant');
	});
});
