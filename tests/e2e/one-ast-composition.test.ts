/**
 * Composed statements on a real database (ADR 0012): a set operation keeps
 * its grouping, and an orm.recursive depth guard cuts the walk where it says.
 */
import { createOrm, eq, exprRef, literal, op, schema } from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	closeTestDb,
	createSchema,
	dropSchema,
	execInSchema,
	getTestAdapter,
} from './testkit/index.js';

const SCHEMA = 'one_ast_composition_e2e';

const compositionSchema = schema({
	a_values: { id: { type: 'integer', primaryKey: true }, v: 'integer' },
	b_values: { id: { type: 'integer', primaryKey: true }, v: 'integer' },
	c_values: { id: { type: 'integer', primaryKey: true }, v: 'integer' },
	nodes: {
		id: { type: 'integer', primaryKey: true },
		parentId: { type: 'integer', nullable: true },
	},
} as const);

beforeAll(async () => {
	await dropSchema(SCHEMA);
	await createSchema(SCHEMA);
	await execInSchema(
		SCHEMA,
		`CREATE TABLE a_values (id integer PRIMARY KEY, v integer NOT NULL);
		 CREATE TABLE b_values (id integer PRIMARY KEY, v integer NOT NULL);
		 CREATE TABLE c_values (id integer PRIMARY KEY, v integer NOT NULL);
		 INSERT INTO a_values (id, v) VALUES (1, 1);
		 INSERT INTO b_values (id, v) VALUES (1, 1);
		 INSERT INTO c_values (id, v) VALUES (1, 2);
		 CREATE TABLE nodes (id integer PRIMARY KEY, parent_id integer);
		 INSERT INTO nodes (id, parent_id) VALUES
		   (1, NULL), (2, 1), (3, 2), (4, 3), (5, 4), (6, 5);`,
	);
});

afterAll(async () => {
	await dropSchema(SCHEMA);
	await closeTestDb();
});

describe('composed statements on PostgreSQL (ADR 0012)', () => {
	it('AC8 real-db-union: A UNION ALL (B UNION C) keeps the duplicate the grouping keeps', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ schema: compositionSchema, adapter }).withSchema(
			SCHEMA,
		);

		const rows = await orm.nql<{
			v: number;
		}>`a_values | select v | union all (b_values | select v | union (c_values | select v))`.all();

		expect(rows.map((row) => row.v).sort((x, y) => x - y)).toEqual([1, 1, 2]);
	});

	it('AC8 real-db-recursive: an orm.recursive walk longer than maxDepth stops at the cut-off', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({
			model: compositionSchema.model,
			adapter,
		}).withSchema(SCHEMA) as any;

		const rows = await orm
			.recursive('chain', {
				base: orm
					.select('nodes')
					.columns(['id', literal(1).as('depth')])
					.where(eq('id', 1)),
				step: orm
					.select('nodes')
					.join('chain', {
						on: eq('nodes.parentId', exprRef('chain.id')),
						as: 'chain',
					})
					.columns([
						'id',
						op('+', exprRef('chain.depth'), literal(1)).as('depth'),
					]),
				maxDepth: 3,
			})
			.orderBy('id')
			.all();

		expect(rows).toEqual([
			{ id: 1, depth: 1 },
			{ id: 2, depth: 2 },
			{ id: 3, depth: 3 },
		]);
	});
});
