import {
	createTransitionLessor,
	TRANSITION_LESSOR_REJECTION,
} from '@dbsp/core';
import type {
	JsonValue,
	ObservationContext,
	ObservationRequest,
} from '@dbsp/types';
import { describe, expect, it, vi } from 'vitest';
import { createTestTransitionSession } from './__fixtures__/transition-session.js';
import {
	ALTER_AUTHORITY_OBSERVATION,
	ALTER_TYPE_AUTHORITY_OBSERVATION,
	CHECK_CONSTRAINT_ABSENT_OBSERVATION,
	COLUMN_EXISTS_OBSERVATION,
	ENGINE_VERSION_OBSERVATION,
	ENUM_LABEL_VISIBLE_OBSERVATION,
	EXPRESSION_DEPARSE_OBSERVATION,
	INDEX_ABSENT_OBSERVATION,
	LOGICAL_IDENTITY_CARRIER_OBSERVATION,
	PG_DEPARSE_ARTIFACT,
	PG_SCHEMA_USAGE_PRIVILEGE,
	PG_SET_NOT_NULL_AUTHORITY_PRIVILEGE,
	PG_TABLE_ALTER_AUTHORITY_PRIVILEGE,
	PG_TYPE_ALTER_AUTHORITY_PRIVILEGE,
	SET_NOT_NULL_RELATION_KIND_SUPPORTED_OBSERVATION,
	TABLE_CHECK_CONSTRAINTS_OBSERVATION,
	TABLE_INDEXES_OBSERVATION,
} from './constants.js';
import {
	createPgObservationIssuer,
	executePgObservationFromLessor,
	readPgObservationContextFromClient,
	readPgObservationContextFromLessor,
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
		createTestTransitionSession({
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
		}),
		context,
	);
	return (
		observation.result.value as {
			claims: readonly [{ readonly holds: boolean }];
		}
	).claims[0].holds;
}

describe('PostgreSQL transition observation issuer', () => {
	it('refuses a forged lessor before acquiring for an observation', async () => {
		const acquire = vi.fn(async () => ({ query: vi.fn() }));

		await expect(
			executePgObservationFromLessor(
				{ acquire } as never,
				engineRequest(180000),
				context,
			),
		).rejects.toThrow(TRANSITION_LESSOR_REJECTION);
		expect(acquire).not.toHaveBeenCalled();
	});

	it('refuses a forged lessor before acquiring for a context read', async () => {
		const acquire = vi.fn(async () => ({ query: vi.fn() }));

		await expect(
			readPgObservationContextFromLessor({ acquire } as never, 'tenant'),
		).rejects.toThrow(TRANSITION_LESSOR_REJECTION);
		expect(acquire).not.toHaveBeenCalled();
	});

	it.each([
		[
			'an observation',
			(lessor: never) =>
				executePgObservationFromLessor(lessor, engineRequest(180000), context),
		],
		[
			'a context read',
			(lessor: never) => readPgObservationContextFromLessor(lessor, 'tenant'),
		],
	])('rejects a branded malformed acquisition for %s', async (_label, invoke) => {
		const release = vi.fn();
		const lessor = { acquire: vi.fn(async () => ({ release })) };
		Object.defineProperty(lessor, Symbol.for('dbsp.transition.lessor'), {
			value: { protocolVersion: 1 },
		});

		await expect(invoke(lessor as never)).rejects.toThrow(
			'must acquire a lease exposing query() and release()',
		);
		expect(release).toHaveBeenCalledOnce();
	});

	it('fails closed before trusting logical identity rows from an unmanaged side table', async () => {
		const issuer = createPgObservationIssuer();
		const query = vi.fn(async (sql: string) => {
			if (sql.includes('pg_catalog.jsonb_object_agg')) {
				return {
					rows: [
						{
							table_exists: true,
							columns: {
								logical_id: { type: 'text', notNull: true },
								schema_name: { type: 'text', notNull: true },
								table_name: { type: 'text', notNull: true },
								column_name: { type: 'text', notNull: false },
								carrier_kind: { type: 'text', notNull: true },
								attached_at: {
									type: 'timestamp with time zone',
									notNull: true,
								},
							},
							primary_key: ['logical_id'],
						},
					],
				};
			}
			if (sql.includes('pg_catalog.to_regclass')) {
				return { rows: [{ exists: true }] };
			}
			if (sql.includes('JOIN pg_catalog.pg_attribute a')) {
				return { rows: [{}] };
			}
			throw new Error(`unexpected query: ${sql}`);
		});

		await expect(
			issuer.execute(
				{
					kind: LOGICAL_IDENTITY_CARRIER_OBSERVATION,
					scope: [],
					detail: {
						schema: 'tenant',
						table: 'users',
						column: 'age',
						logicalId: 'logical.users.age',
						carrierKind: 'postgresql-side-table',
						authenticated: false,
						expected: 'attached',
					},
				},
				createTestTransitionSession({ query }),
				context,
			),
		).rejects.toThrow(/not the dbsp-managed carrier shape/);
		expect(
			query.mock.calls.some(([sql]) =>
				String(sql).includes('SELECT logical_id, schema_name'),
			),
		).toBe(false);
	});

	it('surfaces relation kind in column evidence for partitioned tables', async () => {
		const issuer = createPgObservationIssuer();
		const queries: string[] = [];
		const observation = await issuer.execute(
			{
				kind: COLUMN_EXISTS_OBSERVATION,
				scope: [],
				detail: { schema: 'tenant', table: 'users', column: 'age' },
			},
			createTestTransitionSession({
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
			}),
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
			createTestTransitionSession({
				query: async () => ({ rows: [{ server_version_num: '180000' }] }),
			}),
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
			createTestTransitionSession({
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
			}),
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
				createTestTransitionSession({ query }),
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
			createTestTransitionSession({
				query: async () => ({
					rows: [
						{
							has_table_alter_authority: true,
							has_schema_usage: false,
						},
					],
				}),
			}),
			context,
		);

		expect(observation.result.value).toMatchObject({
			hasAlterAuthority: false,
			hasTableAlterAuthority: true,
			hasSchemaUsage: false,
			claims: [{ kind: ALTER_AUTHORITY_OBSERVATION, holds: false }],
		});
	});

	it('observes table CHECK constraints with table identity and absence claim', async () => {
		const issuer = createPgObservationIssuer();
		const observation = await issuer.execute(
			{
				kind: TABLE_CHECK_CONSTRAINTS_OBSERVATION,
				scope: [],
				detail: {
					schema: 'tenant',
					table: 'users',
					constraint: 'users_age_check',
				},
			},
			createTestTransitionSession({
				query: async () => ({
					rows: [
						{
							oid: '12345',
							relkind: 'r',
							schema_name: 'tenant',
							table_name: 'users',
							checks: [
								{
									name: 'users_state_check',
									oid: '90001',
									expression: "CHECK (((state)::text = 'active'::text))",
									predicateExpression: "((state)::text = 'active'::text)",
									notValid: false,
								},
							],
						},
					],
				}),
			}),
			context,
		);

		expect(observation.request).toMatchObject({
			kind: TABLE_CHECK_CONSTRAINTS_OBSERVATION,
			detail: {
				schema: 'tenant',
				table: 'users',
				constraint: 'users_age_check',
			},
		});
		expect(observation.result.value).toMatchObject({
			exists: true,
			oid: '12345',
			relkind: 'r',
			checks: [
				{
					name: 'users_state_check',
					oid: '90001',
					predicate: "((state)::text = 'active'::text)",
					notValid: false,
				},
			],
			claims: expect.arrayContaining([
				expect.objectContaining({
					kind: TABLE_CHECK_CONSTRAINTS_OBSERVATION,
					holds: true,
				}),
				expect.objectContaining({
					kind: CHECK_CONSTRAINT_ABSENT_OBSERVATION,
					holds: true,
				}),
			]),
		});
		const value = observation.result.value as {
			readonly checks?: readonly Record<string, unknown>[];
		};
		expect(value.checks?.[0]).not.toHaveProperty('predicateExpression');
	});

	it('fails closed when table CHECK catalog JSON is malformed', async () => {
		const issuer = createPgObservationIssuer();

		await expect(
			issuer.execute(
				{
					kind: TABLE_CHECK_CONSTRAINTS_OBSERVATION,
					scope: [],
					detail: {
						schema: 'tenant',
						table: 'users',
						constraint: 'users_age_check',
					},
				},
				createTestTransitionSession({
					query: async () => ({
						rows: [
							{
								oid: '12345',
								relkind: 'r',
								schema_name: 'tenant',
								table_name: 'users',
								checks: '[{',
							},
						],
					}),
				}),
				context,
			),
		).rejects.toThrow(/CHECK catalog JSON could not be parsed/);
	});

	it('fails closed when table CHECK catalog entries are malformed', async () => {
		const issuer = createPgObservationIssuer();

		await expect(
			issuer.execute(
				{
					kind: TABLE_CHECK_CONSTRAINTS_OBSERVATION,
					scope: [],
					detail: {
						schema: 'tenant',
						table: 'users',
						constraint: 'users_age_check',
					},
				},
				createTestTransitionSession({
					query: async () => ({
						rows: [
							{
								oid: '12345',
								relkind: 'r',
								schema_name: 'tenant',
								table_name: 'users',
								checks: [{ name: 'users_age_check' }],
							},
						],
					}),
				}),
				context,
			),
		).rejects.toThrow(/CHECK catalog entry 0 has invalid shape/);
	});

	it('observes table indexes from raw pg_index flag names and text-array literals', async () => {
		const issuer = createPgObservationIssuer();
		const queries: string[] = [];
		const observation = await issuer.execute(
			{
				kind: TABLE_INDEXES_OBSERVATION,
				scope: [],
				detail: {
					schema: 'tenant',
					table: 'users',
					index: 'idx_users_email',
				},
			},
			createTestTransitionSession({
				query: async (sql: string) => {
					queries.push(sql);
					if (sql.includes('FROM pg_catalog.pg_class c')) {
						return {
							rows: [
								{
									oid: '12345',
									relkind: 'r',
									schema_name: 'tenant',
									table_name: 'users',
								},
							],
						};
					}
					if (sql.includes('FROM pg_catalog.pg_index ix')) {
						return {
							rows: [
								{
									oid: '20002',
									index_name: 'idx_users_email',
									columns: '{email}',
									include_columns: '{}',
									expressions_text: null,
									opclass_names: '{}',
									opclass_cols: '{}',
									collation_names: '{pg_catalog.C}',
									collation_cols: '{email}',
									option_values: '{3}',
									option_cols: '{email}',
									indisunique: true,
									indisvalid: true,
									indisready: true,
									nulls_not_distinct: false,
									method: 'btree',
									predicate: null,
									reloptions: null,
								},
							],
						};
					}
					if (sql.includes('FROM pg_catalog.pg_class i')) {
						return { rows: [{}] };
					}
					throw new Error(`unexpected query: ${sql}`);
				},
			}),
			context,
		);

		const value = observation.result.value as {
			readonly indexes: readonly Record<string, unknown>[];
			readonly claims: readonly Record<string, unknown>[];
		};
		expect(queries[1]).toContain('jsonb_agg');
		expect(queries[1]).toContain('ix.indisunique AS indisunique');
		expect(value.indexes).toEqual([
			expect.objectContaining({
				name: 'idx_users_email',
				oid: '20002',
				columns: ['email'],
				include: [],
				unique: true,
				valid: true,
				ready: true,
				method: 'btree',
				predicate: null,
				collation: { email: 'pg_catalog.C' },
				options: { email: '3' },
			}),
		]);
		expect(value.claims).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: TABLE_INDEXES_OBSERVATION,
					holds: true,
				}),
				expect.objectContaining({
					kind: INDEX_ABSENT_OBSERVATION,
					holds: false,
				}),
			]),
		);
	});

	it('deparses table CHECK expressions under a savepoint and returns CHECK plus predicate artifacts', async () => {
		const issuer = createPgObservationIssuer();
		const queries: string[] = [];
		const proofContext = {
			...context,
			sessionConfiguration: { standard_conforming_strings: 'on' },
		};
		const observation = await issuer.execute(
			{
				kind: EXPRESSION_DEPARSE_OBSERVATION,
				scope: [],
				detail: {
					surface: 'table-check',
					category: 'predicate',
					schema: 'tenant',
					table: 'users',
					constraint: 'users_age_check',
					expression: 'age > 0',
				},
			},
			createTestTransitionSession({
				query: async (sql: string) => {
					queries.push(sql);
					if (sql.includes('JOIN pg_catalog.pg_class')) {
						return { rows: [] };
					}
					if (sql.includes('WHERE con.conrelid = $1::pg_catalog.regclass')) {
						return {
							rows: [
								{
									expression: 'CHECK ((age > 0))',
									predicate_expression: '(age > 0)',
									not_valid: false,
								},
							],
						};
					}
					return { rows: [] };
				},
			}),
			proofContext,
		);

		expect(queries.some((sql) => sql.startsWith('SAVEPOINT'))).toBe(true);
		expect(
			queries.find((sql) =>
				sql.startsWith('CREATE TEMP TABLE "_dbsp_check_deparse_'),
			),
		).toContain(
			'(LIKE "tenant"."users" INCLUDING DEFAULTS INCLUDING GENERATED INCLUDING IDENTITY)',
		);
		expect(
			queries.find((sql) =>
				sql.startsWith('ALTER TABLE "_dbsp_check_deparse_'),
			),
		).toMatch(/ADD CONSTRAINT "users_age_check" CHECK \(age > 0\)$/u);
		expect(observation.role).toBe('evidence');
		expect(observation.source).toBe('vendor-deparser');
		expect(observation.context).toEqual(proofContext);
		expect(observation.scope).toEqual([
			{
				engine: 'postgresql',
				database: 'test',
				kind: 'table',
				name: 'users',
				schema: 'tenant',
			},
		]);
		expect(observation.request).toEqual({
			kind: EXPRESSION_DEPARSE_OBSERVATION,
			scope: observation.scope,
			detail: {
				surface: 'table-check',
				category: 'predicate',
				table: 'users',
				constraint: 'users_age_check',
				schema: 'tenant',
				expression: 'age > 0',
			},
		});
		expect(observation.result.value).toMatchObject({
			ok: true,
			surface: 'table-check',
			category: 'predicate',
			desiredCanonical: 'CHECK ((age > 0))',
			desiredPredicateCanonical: '(age > 0)',
			expression: {
				kind: 'vendor-validated',
				category: 'predicate',
				validatedBy: PG_DEPARSE_ARTIFACT,
				text: 'CHECK ((age > 0))',
			},
			predicate: {
				kind: 'vendor-validated',
				category: 'predicate',
				validatedBy: PG_DEPARSE_ARTIFACT,
				text: '(age > 0)',
			},
			claims: [{ kind: EXPRESSION_DEPARSE_OBSERVATION, holds: true }],
		});
	});

	it('opens a transaction before table CHECK temp-table deparse when no outer transaction exists', async () => {
		const issuer = createPgObservationIssuer();
		const queries: string[] = [];
		let savepointAttempts = 0;
		await issuer.execute(
			{
				kind: EXPRESSION_DEPARSE_OBSERVATION,
				scope: [],
				detail: {
					surface: 'table-check',
					category: 'predicate',
					schema: 'tenant',
					table: 'users',
					constraint: 'users_age_check',
					expression: 'age > 0',
				},
			},
			createTestTransitionSession({
				query: async (sql: string) => {
					queries.push(sql);
					if (sql.startsWith('SAVEPOINT')) {
						savepointAttempts += 1;
						if (savepointAttempts === 1) {
							throw new Error(
								'SAVEPOINT can only be used in transaction blocks',
							);
						}
					}
					if (sql.includes('JOIN pg_catalog.pg_class')) {
						return { rows: [] };
					}
					if (sql.includes('WHERE con.conrelid = $1::pg_catalog.regclass')) {
						return {
							rows: [
								{
									expression: 'CHECK ((age > 0))',
									predicate_expression: '(age > 0)',
									not_valid: false,
								},
							],
						};
					}
					return { rows: [] };
				},
			}),
			{
				...context,
				sessionConfiguration: { standard_conforming_strings: 'on' },
			},
		);

		const firstSavepoint = queries.findIndex((sql) =>
			sql.startsWith('SAVEPOINT'),
		);
		expect(firstSavepoint).toBeGreaterThan(0);
		expect(queries[firstSavepoint + 1]).toBe('BEGIN');
		expect(queries[firstSavepoint + 2]).toMatch(/^SAVEPOINT /u);
		expect(queries[firstSavepoint + 3]).toMatch(/^CREATE TEMP TABLE /u);
		expect(queries).toContain('ROLLBACK');
	});

	it('fails closed for malformed table CHECK deparse requests before querying', async () => {
		const issuer = createPgObservationIssuer();
		const query = vi.fn(async () => ({ rows: [] }));

		await expect(
			issuer.execute(
				{
					kind: EXPRESSION_DEPARSE_OBSERVATION,
					scope: [],
					detail: {
						surface: 'table-check',
						category: 'scalar',
						schema: 'tenant',
						table: 'users',
						constraint: 'users_age_check',
						expression: 'age > 0',
					},
				},
				createTestTransitionSession({ query }),
				{
					...context,
					sessionConfiguration: { standard_conforming_strings: 'on' },
				},
			),
		).rejects.toThrow(/surface=table-check and category=predicate/);
		expect(query).not.toHaveBeenCalled();
	});

	it('reads ALTER TYPE authority evidence for enum targets', async () => {
		const issuer = createPgObservationIssuer();
		const observation = await issuer.execute(
			{
				kind: ALTER_TYPE_AUTHORITY_OBSERVATION,
				scope: [],
				detail: { schema: 'tenant', type: 'status' },
			},
			createTestTransitionSession({
				query: async () => ({
					rows: [
						{
							has_type_alter_authority: true,
							has_schema_usage: true,
						},
					],
				}),
			}),
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
			createTestTransitionSession({
				query: async () => ({
					rows: [
						{
							has_type_alter_authority: true,
							has_schema_usage: true,
						},
					],
				}),
			}),
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
		const target = createTestTransitionSession({
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
		});

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
				createTestTransitionSession({ query }),
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
				createTestTransitionSession({ query }),
				context,
			),
		).rejects.toThrow(/requires enum label detail/);
		expect(query).not.toHaveBeenCalled();
	});

	it('reads resolved schemas without splitting SHOW search_path', async () => {
		const contextFromDb = await readPgObservationContextFromClient(
			createTestTransitionSession({
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
			}),
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
		const contextFromDb = await readPgObservationContextFromClient(
			createTestTransitionSession({
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
			}),
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

		const contextFromDb = await readPgObservationContextFromLessor(
			createTransitionLessor(async () => client),
			'tenant',
		);

		expect(pool.connect).not.toHaveBeenCalled();
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
