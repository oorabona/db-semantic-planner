import { createOrm, isDistinctFrom, neq, schema } from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	closeTestDb,
	createSchema,
	dropSchema,
	execInSchema,
	getTestAdapter,
} from './testkit/index.js';

const SCHEMA = 'is_distinct_from_e2e';

const distinctSchema = schema({
	distinct_values: {
		id: { type: 'integer', primaryKey: true },
		v: { type: 'integer', nullable: true },
	},
} as const);

beforeAll(async () => {
	await dropSchema(SCHEMA);
	await createSchema(SCHEMA);
	await execInSchema(
		SCHEMA,
		`CREATE TABLE distinct_values (id integer PRIMARY KEY, v integer);
		 INSERT INTO distinct_values (id, v) VALUES (1, NULL), (2, 6), (3, 7);`,
	);
});

afterAll(async () => {
	await dropSchema(SCHEMA);
	await closeTestDb();
});

describe('#462 IS DISTINCT FROM', () => {
	it('has null-safe inequality semantics distinct from neq', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ schema: distinctSchema, adapter }).withSchema(
			SCHEMA,
		);

		const distinctFromSix = await orm
			.select('distinct_values')
			.where(isDistinctFrom('v', 6))
			.columns(['id'])
			.execute();
		expect(distinctFromSix.map((row) => row.id)).toEqual([1, 3]);

		const notEqualSix = await orm
			.select('distinct_values')
			.where(neq('v', 6))
			.columns(['id'])
			.execute();
		expect(notEqualSix.map((row) => row.id)).toEqual([3]);

		const distinctFromNull = await orm
			.select('distinct_values')
			.where(isDistinctFrom('v', null))
			.columns(['id'])
			.execute();
		expect(distinctFromNull.map((row) => row.id)).toEqual([2, 3]);
	});
});
