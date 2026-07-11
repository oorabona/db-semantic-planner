/**
 * #261/#262 — introspection originalDbType fidelity (real PostgreSQL).
 *
 * Verifies against a live database (what mocked unit tests cannot):
 * 1. introspect() sources originalDbType from format_type(), preserving every
 *    typmod (temporal precision, bit length, numeric precision, vector dims).
 * 2. A WHERE cast against an introspected schema emits a truncation-safe target
 *    (varchar(120) -> CAST(... AS varchar)), not the bounded type.
 * 3. introspect -> compareSchemata is idempotent (no spurious drift).
 */

import {
	compareSchemata,
	generateDDL,
	generateMigrationSQL,
} from '@dbsp/adapter-pgsql';
import { createOrm, eq, getSchemaFromDb, ModelIRImpl } from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	closeTestDb,
	createPgsqlAdapterForSchema,
	createSchema,
	dropSchema,
	getTestPool,
} from './testkit/index.js';

const SCHEMA = 'dbtype_fidelity_test';
const TENANT_SCHEMA = 'tenant_1';
const PUBLIC_ENUM_TYPE = 'dbsp_285_status';
const PUBLIC_TABLE = 'dbsp_285_public_status_holder';

// pgvector is present in the project's -full test image but not in a stock
// PostgreSQL image; gate the vector column so the suite still runs without it.
let hasVector = false;

describe('#261 introspection originalDbType fidelity (real PG)', () => {
	beforeAll(async () => {
		await dropSchema(SCHEMA);
		await createSchema(SCHEMA);
		const pool = await getTestPool();
		await pool.query(`DROP SCHEMA IF EXISTS ${TENANT_SCHEMA} CASCADE`);
		await pool.query(`CREATE SCHEMA ${TENANT_SCHEMA}`);
		await pool.query(`DROP TABLE IF EXISTS public.${PUBLIC_TABLE}`);
		await pool.query(`DROP TYPE IF EXISTS public.${PUBLIC_ENUM_TYPE} CASCADE`);
		try {
			await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
			hasVector = true;
		} catch {
			hasVector = false;
		}
		await pool.query(`CREATE TYPE ${SCHEMA}.mood AS ENUM ('happy', 'sad')`);
		await pool.query(
			`CREATE TABLE ${SCHEMA}.fidelity (
				id integer PRIMARY KEY,
				ts timestamptz(3),
				bits bit(8),
				vbits varbit(16),
				name varchar(120),
				amount numeric(10,2),
				code char(5),
				when_local time(3) without time zone,
				note text,
				tags integer[],
				labels text[],
				feeling ${SCHEMA}.mood
			)`,
		);
		if (hasVector) {
			await pool.query(
				`ALTER TABLE ${SCHEMA}.fidelity ADD COLUMN embedding vector(768)`,
			);
		}
		await pool.query(
			`CREATE TYPE ${TENANT_SCHEMA}.status AS ENUM ('active', 'inactive')`,
		);
		await pool.query(
			`CREATE TYPE public.${PUBLIC_ENUM_TYPE} AS ENUM ('active', 'inactive')`,
		);
		await pool.query(
			`CREATE TABLE ${TENANT_SCHEMA}.enum_identity (
				id integer PRIMARY KEY,
				state ${TENANT_SCHEMA}.status NOT NULL,
				history ${TENANT_SCHEMA}.status[] NOT NULL,
				public_state public.${PUBLIC_ENUM_TYPE} NOT NULL,
				public_history public.${PUBLIC_ENUM_TYPE}[] NOT NULL
			)`,
		);
		await pool.query(
			`CREATE TABLE public.${PUBLIC_TABLE} (
				id integer PRIMARY KEY,
				state public.${PUBLIC_ENUM_TYPE} NOT NULL,
				history public.${PUBLIC_ENUM_TYPE}[] NOT NULL
			)`,
		);
	});

	afterAll(async () => {
		const pool = await getTestPool();
		await pool.query(`DROP SCHEMA IF EXISTS ${TENANT_SCHEMA} CASCADE`);
		await pool.query(`DROP TABLE IF EXISTS public.${PUBLIC_TABLE}`);
		await pool.query(`DROP TYPE IF EXISTS public.${PUBLIC_ENUM_TYPE} CASCADE`);
		await dropSchema(SCHEMA);
		await closeTestDb();
	});

	it('captures faithful originalDbType via format_type', async () => {
		const adapter = await createPgsqlAdapterForSchema(SCHEMA);
		const model = await adapter.introspect({ schema: SCHEMA });
		const table = model.getTable('fidelity');
		expect(table).toBeDefined();
		const byName = new Map(
			(table?.columns ?? []).map((c) => [c.name, c.originalDbType]),
		);
		const byColumn = new Map((table?.columns ?? []).map((c) => [c.name, c]));

		expect(byName.get('ts')).toBe('timestamp(3) with time zone');
		expect(byName.get('bits')).toBe('bit(8)');
		expect(byName.get('vbits')).toBe('bit varying(16)');
		expect(byName.get('name')).toBe('character varying(120)');
		expect(byName.get('amount')).toBe('numeric(10,2)');
		expect(byName.get('code')).toBe('character(5)');
		expect(byName.get('when_local')).toBe('time(3) without time zone');
		expect(byName.get('note')).toBe('text');
		// Array columns are sourced from format_type (finding 6): integer[], not the
		// internal _int4 udt_name.
		expect(byName.get('tags')).toBe('integer[]');
		expect(byName.get('labels')).toBe('text[]');
		// Custom type schema identity is stored structurally, while the SQL type
		// spelling remains bare.
		expect(byName.get('feeling')).toBe('mood');
		expect(byColumn.get('feeling')).toMatchObject({
			originalDbTypeSchema: SCHEMA,
			originalDbTypeSchemaScope: 'target',
		});
		if (hasVector) {
			expect(byName.get('embedding')).toBe('vector(768)');
		}
	});

	it('captures structural custom scalar/array types and protects enum array drops', async () => {
		const adapter = await createPgsqlAdapterForSchema(SCHEMA);
		const tenantModel = await adapter.introspect({ schema: TENANT_SCHEMA });
		const table = tenantModel.getTable('enum_identity');
		expect(table).toBeDefined();
		const byName = new Map(
			(table?.columns ?? []).map((c) => [c.name, c.originalDbType]),
		);
		const byColumn = new Map((table?.columns ?? []).map((c) => [c.name, c]));

		expect(byName.get('state')).toBe('status');
		expect(byName.get('history')).toBe('status[]');
		expect(byColumn.get('state')).toMatchObject({
			originalDbTypeSchema: TENANT_SCHEMA,
			originalDbTypeSchemaScope: 'target',
		});
		expect(byColumn.get('history')).toMatchObject({
			originalDbTypeSchema: TENANT_SCHEMA,
			originalDbTypeSchemaScope: 'target',
		});
		expect(byName.get('public_state')).toBe(PUBLIC_ENUM_TYPE);
		expect(byName.get('public_history')).toBe(`${PUBLIC_ENUM_TYPE}[]`);
		expect(byColumn.get('public_state')).toMatchObject({
			originalDbTypeSchema: 'public',
			originalDbTypeSchemaScope: 'absolute',
		});
		expect(byColumn.get('public_history')).toMatchObject({
			originalDbTypeSchema: 'public',
			originalDbTypeSchemaScope: 'absolute',
		});
		expect(tenantModel.enums?.get('status')).toEqual({
			name: 'status',
			schema: TENANT_SCHEMA,
			values: ['active', 'inactive'],
		});

		const createEnum = `CREATE TYPE "${TENANT_SCHEMA}"."status" AS ENUM ('active', 'inactive');`;
		const createTable = `CREATE TABLE "${TENANT_SCHEMA}"."enum_identity" (
  "id" INT4 NOT NULL,
  "state" "${TENANT_SCHEMA}".status NOT NULL,
  "history" "${TENANT_SCHEMA}".status[] NOT NULL,
  "public_state" "public".${PUBLIC_ENUM_TYPE} NOT NULL,
  "public_history" "public".${PUBLIC_ENUM_TYPE}[] NOT NULL,
  CONSTRAINT "pk_enum_identity" PRIMARY KEY ("id")
);`;
		expect(
			generateDDL(tenantModel, { schemaName: TENANT_SCHEMA }).filter(
				(stmt) => stmt === createEnum || stmt === createTable,
			),
		).toEqual([createEnum, createTable]);

		const withoutEnum = new ModelIRImpl(
			new Map(tenantModel.tables),
			new Map(tenantModel.relations),
			new Map(),
		);
		const diff = compareSchemata(withoutEnum, tenantModel, {
			ignoreUnmanagedExtensions: true,
		});
		expect(generateMigrationSQL(diff, { schemaName: TENANT_SCHEMA })).toEqual([
			`ALTER TABLE "${TENANT_SCHEMA}"."enum_identity" ALTER COLUMN "state" TYPE text;
ALTER TABLE "${TENANT_SCHEMA}"."enum_identity" ALTER COLUMN "history" TYPE text[] USING "history"::text[];
DROP TYPE IF EXISTS "${TENANT_SCHEMA}"."status" CASCADE;`,
		]);
	});

	it('retargets target-scoped custom types while preserving absolute public references', async () => {
		const adapter = await createPgsqlAdapterForSchema(SCHEMA);
		const tenantModel = await adapter.introspect({ schema: TENANT_SCHEMA });

		const createEnum = `CREATE TYPE "tenant_2"."status" AS ENUM ('active', 'inactive');`;
		const createTable = `CREATE TABLE "tenant_2"."enum_identity" (
  "id" INT4 NOT NULL,
  "state" "tenant_2".status NOT NULL,
  "history" "tenant_2".status[] NOT NULL,
  "public_state" "public".${PUBLIC_ENUM_TYPE} NOT NULL,
  "public_history" "public".${PUBLIC_ENUM_TYPE}[] NOT NULL,
  CONSTRAINT "pk_enum_identity" PRIMARY KEY ("id")
);`;
		expect(
			generateDDL(tenantModel, { schemaName: 'tenant_2' }).filter(
				(stmt) => stmt === createEnum || stmt === createTable,
			),
		).toEqual([createEnum, createTable]);
	});

	it('keeps public custom scalar and array type output unqualified', async () => {
		const adapter = await createPgsqlAdapterForSchema('public');
		const publicModel = await adapter.introspect({
			schema: 'public',
			include: [PUBLIC_TABLE],
		});
		const table = publicModel.getTable(PUBLIC_TABLE);
		expect(table).toBeDefined();
		const byName = new Map(
			(table?.columns ?? []).map((c) => [c.name, c.originalDbType]),
		);

		expect(byName.get('state')).toBe(PUBLIC_ENUM_TYPE);
		expect(byName.get('history')).toBe(`${PUBLIC_ENUM_TYPE}[]`);

		const createEnum = `CREATE TYPE "${PUBLIC_ENUM_TYPE}" AS ENUM ('active', 'inactive');`;
		const createTable = `CREATE TABLE "${PUBLIC_TABLE}" (
  "id" INT4 NOT NULL,
  "state" ${PUBLIC_ENUM_TYPE} NOT NULL,
  "history" ${PUBLIC_ENUM_TYPE}[] NOT NULL,
  CONSTRAINT "pk_${PUBLIC_TABLE}" PRIMARY KEY ("id")
);`;
		expect(
			generateDDL(publicModel).filter(
				(stmt) => stmt === createEnum || stmt === createTable,
			),
		).toEqual([createEnum, createTable]);
	});

	it('emits a truncation-safe CAST for a bounded introspected type in WHERE', async () => {
		const adapter = await createPgsqlAdapterForSchema(SCHEMA);
		const schema = await getSchemaFromDb(adapter, { schema: SCHEMA });
		const orm = createOrm({ schema, adapter });
		const dump = orm.select('fidelity').where(eq('name', 'x')).dump();

		// varchar(120) must cast to the unbounded base, never the length-bounded type.
		expect(dump.sql).toBe(
			`SELECT fidelity.* FROM ${SCHEMA}.fidelity WHERE fidelity.name = CAST($1 AS varchar)`,
		);
		expect(dump.params).toEqual(['x']);
	});

	it('introspect -> compareSchemata is idempotent (no spurious drift)', async () => {
		const adapter = await createPgsqlAdapterForSchema(SCHEMA);
		const a = await adapter.introspect({ schema: SCHEMA });
		const b = await adapter.introspect({ schema: SCHEMA });
		const diff = compareSchemata(a, b);
		expect(
			diff.changes.filter((c) => c.kind === 'alter_column_type'),
		).toHaveLength(0);
	});
});
