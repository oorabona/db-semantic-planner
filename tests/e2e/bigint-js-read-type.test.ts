import { createOrm, eq, ref, schema } from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	closeTestDb,
	createSchema,
	dropSchema,
	getTestAdapter,
	getTestPool,
	sql,
} from './testkit/index.js';

const SCHEMA = 'bigint_js_read_type_e2e';
const WRITTEN_BIGINT = 9_007_199_254_740_993n;
const OVERFLOW_NUMBER = 9_007_199_254_740_992n;

const bigintReadSchema = schema({
	accounts: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
	},
	readings: {
		id: { type: 'integer', primaryKey: true },
		accountId: ref('accounts'),
		observedAt: { type: 'bigint', js: 'bigint' },
		safeMetric: { type: 'bigint', js: 'number' },
	},
});

async function createFixtures(): Promise<void> {
	const pool = await getTestPool();
	await sql`
		CREATE TABLE ${sql.ref(SCHEMA)}.accounts (
			id integer PRIMARY KEY,
			name text NOT NULL
		)
	`.execute(pool);
	await sql`
		CREATE TABLE ${sql.ref(SCHEMA)}.readings (
			id integer PRIMARY KEY,
			account_id integer NOT NULL REFERENCES ${sql.ref(SCHEMA)}.accounts(id),
			observed_at bigint NOT NULL,
			safe_metric bigint NOT NULL
		)
	`.execute(pool);
	await sql`
		INSERT INTO ${sql.ref(SCHEMA)}.accounts (id, name)
		VALUES (${1}, ${'primary'}), (${2}, ${'overflow-holder'})
	`.execute(pool);
	// reading 1 is account 1's only reading: safe_metric fits in a JS number, so the
	// success round-trip (which includes ALL of account 1's readings) never hits an
	// overflow. The overflow reading 2 lives under account 2 so the include cannot pull
	// it; the separate overflow test selects it directly by id.
	await sql`
		INSERT INTO ${sql.ref(SCHEMA)}.readings
			(id, account_id, observed_at, safe_metric)
		VALUES
			(${1}, ${1}, ${WRITTEN_BIGINT.toString()}, ${42}),
			(${2}, ${2}, ${WRITTEN_BIGINT.toString()}, ${OVERFLOW_NUMBER.toString()})
	`.execute(pool);
}

describe('#310 bigint js read type e2e', () => {
	beforeAll(async () => {
		await dropSchema(SCHEMA);
		await createSchema(SCHEMA);
		await createFixtures();
	});

	afterAll(async () => {
		await dropSchema(SCHEMA);
		await closeTestDb();
	});

	it('round-trips an opted-in bigint top-level and inside a to-many include', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ schema: bigintReadSchema, adapter }).withSchema(
			SCHEMA,
		);

		const topLevel = (await orm
			.select('readings')
			.where(eq('id', 1))
			.columns(['id', 'observedAt'])
			.execute()) as Array<{ id: number; observedAt: bigint }>;

		expect(topLevel).toHaveLength(1);
		expect(topLevel[0]?.observedAt).toBe(WRITTEN_BIGINT);

		const included = (await orm
			.select('accounts')
			.where(eq('id', 1))
			.include('readings')
			.columns(['id', 'name'])
			.execute()) as Array<{
			id: number;
			name: string;
			readings: Array<{ id: number; observedAt: bigint; safeMetric: number }>;
		}>;

		expect(included).toHaveLength(1);
		expect(
			included[0]?.readings.map((reading) => reading.observedAt),
		).toContain(WRITTEN_BIGINT);
	});

	it('throws when js:number would lose bigint precision', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ schema: bigintReadSchema, adapter }).withSchema(
			SCHEMA,
		);

		await expect(
			orm
				.select('readings')
				.where(eq('id', 2))
				.columns(['safeMetric'])
				.execute(),
		).rejects.toThrow(RangeError);
	});
});
