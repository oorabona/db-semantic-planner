/**
 * DDL provisioning checks that remain after the removal of direct push and
 * file-based migration execution. These tests require DATABASE_URL.
 */
import { compareSchemata, introspect } from '@dbsp/adapter-pgsql';
import { ref, schema } from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	closeTestDb,
	createSchema,
	dropSchema,
	getTestPool,
} from './testkit/index.js';

const SCHEMA = 'ddl_provisioning_test';

const schemaV2 = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		email: { type: 'string', unique: true },
		name: 'string',
		active: { type: 'boolean', default: 'true' },
		createdAt: 'timestamp',
		updatedAt: { type: 'timestamp', nullable: true },
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: 'string',
		body: { type: 'string', nullable: true },
		authorId: ref('users'),
		published: { type: 'boolean', default: 'false' },
	},
});

describe('DDL provisioning E2E', () => {
	let pool: Awaited<ReturnType<typeof getTestPool>>;

	beforeAll(async () => {
		pool = await getTestPool();
		await dropSchema(SCHEMA);
		await createSchema(SCHEMA);
	});

	afterAll(async () => {
		await dropSchema(SCHEMA);
		await closeTestDb();
	});

	describe('verify — enriched schema comparison', () => {
		it('inspects the live schema', async () => {
			const dbModel = await introspect(pool, { schema: SCHEMA });
			expect(schemaV2.model.tables.size).toBeGreaterThan(0);
			expect(dbModel).toBeDefined();
		});

		it('produces a structured diff summary', async () => {
			const dbModel = await introspect(pool, { schema: SCHEMA });
			const diff = compareSchemata(schemaV2.model, dbModel);
			expect(diff.summary).toBeDefined();
			expect(diff.summary.tables).toBeDefined();
			expect(diff.summary.columns).toBeDefined();
			expect(diff.summary.indexes).toBeDefined();
			expect(diff.summary.constraints).toBeDefined();
		});
	});
});
