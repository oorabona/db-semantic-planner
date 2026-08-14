/** Restored live guarantees for the current PostgreSQL DDL generator. */

import { randomUUID } from 'node:crypto';
import {
	camelCaseNaming,
	derivePostgresqlCapabilitiesForVersion,
	generateDDL,
} from '@dbsp/adapter-pgsql';
import { schema } from '@dbsp/core';
import { afterAll, describe, expect, it } from 'vitest';
import {
	closeTestDb,
	createSchema,
	dropSchema,
	getTestPool,
} from './testkit/index.js';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const NAMING_SCHEMA = `MixedCaseSchema${suffix}`;
const INDEX_SCHEMA = `ddl_index_features_${suffix}`;

function quoteIdent(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

async function executeDdl(statements: readonly string[]): Promise<void> {
	const pool = await getTestPool();
	for (const statement of statements) await pool.query(statement);
}

afterAll(async () => {
	await dropSchema(NAMING_SCHEMA);
	await dropSchema(INDEX_SCHEMA);
	await closeTestDb();
});

describe('PostgreSQL DDL generator restored guarantees', () => {
	it('provisions a verbatim mixed-case schemaName while camel-case object names transform', async () => {
		const desired = schema({
			orderEvents: {
				id: { type: 'integer', primaryKey: true },
				createdAt: 'timestamp',
			},
		});
		await createSchema(NAMING_SCHEMA);

		const statements = generateDDL(desired.model, {
			schemaName: NAMING_SCHEMA,
			naming: camelCaseNaming,
		});
		expect(statements).toEqual(
			expect.arrayContaining([
				expect.stringContaining(
					`CREATE TABLE ${quoteIdent(NAMING_SCHEMA)}."order_events"`,
				),
			]),
		);
		expect(statements.join('\n')).toContain('"created_at"');
		await executeDdl(statements);

		const pool = await getTestPool();
		await expect(
			pool.query(
				`SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
				[NAMING_SCHEMA, 'order_events'],
			),
		).resolves.toMatchObject({
			rows: [{ table_schema: NAMING_SCHEMA, table_name: 'order_events' }],
		});
	});

	it('keeps default and latest-capability index DDL byte-identical and provisions INCLUDE with NULLS NOT DISTINCT', async () => {
		const desired = schema(
			{
				accounts: {
					id: { type: 'integer', primaryKey: true },
					email: { type: 'string', nullable: true },
					displayName: 'string',
				},
			},
			{
				accounts: {
					indexes: [
						{
							name: 'uq_accounts_email_covering',
							columns: ['email'],
							unique: true,
							include: ['displayName'],
							nullsNotDistinct: true,
						},
					],
				},
			},
		);
		await createSchema(INDEX_SCHEMA);

		const defaultDdl = generateDDL(desired.model, {
			schemaName: INDEX_SCHEMA,
		});
		const latestDdl = generateDDL(desired.model, {
			schemaName: INDEX_SCHEMA,
			dialectCapabilities: derivePostgresqlCapabilitiesForVersion('18'),
		});
		expect(defaultDdl).toEqual(latestDdl);
		expect(defaultDdl.join('\n')).toContain('INCLUDE ("displayName")');
		expect(defaultDdl.join('\n')).toContain('NULLS NOT DISTINCT');

		const pool = await getTestPool();
		const version = await pool.query<{ server_version_num: string }>(
			'SHOW server_version_num',
		);
		expect(Number(version.rows[0]?.server_version_num)).toBeGreaterThanOrEqual(
			150000,
		);
		await executeDdl(latestDdl);
		await expect(
			pool.query<{ definition: string; nulls_not_distinct: boolean }>(
				`SELECT pg_catalog.pg_get_indexdef(index_meta.indexrelid) AS definition, index_meta.indnullsnotdistinct AS nulls_not_distinct FROM pg_catalog.pg_index index_meta JOIN pg_catalog.pg_class index_relation ON index_relation.oid = index_meta.indexrelid JOIN pg_catalog.pg_namespace namespace ON namespace.oid = index_relation.relnamespace WHERE namespace.nspname = $1 AND index_relation.relname = $2`,
				[INDEX_SCHEMA, 'uq_accounts_email_covering'],
			),
		).resolves.toMatchObject({
			rows: [
				{
					nulls_not_distinct: true,
					definition: expect.stringContaining('INCLUDE ("displayName")'),
				},
			],
		});
	});
});
