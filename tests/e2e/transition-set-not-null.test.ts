import {
	createPgTransitionPack,
	readPgObservationContext,
} from '@dbsp/adapter-pgsql';
import {
	type ApplyPolicy,
	createApplier,
	createComparator,
	createPackRegistry,
	createProver,
	type ModelIR,
	type TableIR,
} from '@dbsp/core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createSchema, dropSchema, getTestPool } from './testkit/index.js';

const schemaName = 'transition_set_not_null';

const policy: ApplyPolicy = {
	accepts: [
		{ class: 'operation-pack-semantics' },
		{ class: 'external-ddl-exclusion' },
	],
};

function quoteIdent(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function table(nullable: boolean, column = 'age', overrides = {}): TableIR {
	return {
		name: 'users',
		columns: [{ name: column, type: 'integer', nullable, ...overrides }],
		foreignKeys: [],
		indexes: [],
	};
}

function model(nullable: boolean, column = 'age', overrides = {}): ModelIR {
	const tables = new Map<string, TableIR>([
		['users', table(nullable, column, overrides)],
	]);
	return {
		tables,
		relations: new Map(),
		getTable: (name) => tables.get(name),
		getRelation: () => undefined,
		getRelationsFrom: () => [],
		getRelationsTo: () => [],
		isAmbiguous: () => ({ ambiguous: false, options: [] }),
	};
}

async function createUsersTable(
	ages: readonly (number | null)[],
): Promise<void> {
	const pool = await getTestPool();
	await pool.query(
		`CREATE TABLE ${quoteIdent(schemaName)}.${quoteIdent(
			'users',
		)} (id serial PRIMARY KEY, age integer NULL)`,
	);
	for (const age of ages) {
		await pool.query(
			`INSERT INTO ${quoteIdent(schemaName)}.${quoteIdent(
				'users',
			)} (age) VALUES ($1)`,
			[age],
		);
	}
}

async function ageIsNullable(): Promise<boolean> {
	const pool = await getTestPool();
	const result = await pool.query(
		'SELECT is_nullable FROM information_schema.columns ' +
			'WHERE table_schema = $1 AND table_name = $2 AND column_name = $3',
		[schemaName, 'users', 'age'],
	);
	return result.rows[0]?.is_nullable === 'YES';
}

async function proveSetNotNull() {
	const pool = await getTestPool();
	const registry = createPackRegistry([createPgTransitionPack()]);
	const comparator = createComparator(registry);
	const prover = createProver(registry);
	const context = await readPgObservationContext(pool, schemaName);
	const compare = comparator.compare(model(false), model(true));
	return {
		pool,
		registry,
		context,
		outcome: await prover.prove(compare, pool, context),
	};
}

async function proveSetNotNullForModels(desired: ModelIR, current: ModelIR) {
	const pool = await getTestPool();
	const registry = createPackRegistry([createPgTransitionPack()]);
	const comparator = createComparator(registry);
	const prover = createProver(registry);
	const context = await readPgObservationContext(pool, schemaName);
	const compare = comparator.compare(desired, current);
	return {
		pool,
		registry,
		context,
		outcome: await prover.prove(compare, pool, context),
	};
}

describe('ADR-0003 transition planner: SET NOT NULL', () => {
	beforeAll(async () => {
		await createSchema(schemaName);
	});

	afterEach(async () => {
		const pool = await getTestPool();
		await pool.query(
			`DROP TABLE IF EXISTS ${quoteIdent(schemaName)}.${quoteIdent(
				'users',
			)} CASCADE`,
		);
	});

	afterAll(async () => {
		await dropSchema(schemaName);
	});

	it('proves and applies SET NOT NULL when existing rows are clean', async () => {
		await createUsersTable([18, 21, 34]);
		const { pool, registry, outcome } = await proveSetNotNull();
		expect(outcome.kind).toBe('proven');
		if (outcome.kind !== 'proven') {
			return;
		}

		const result = await createApplier(registry).apply(
			{ plan: outcome.plan, assessment: outcome.assessment },
			policy,
			pool,
		);

		expect(result.assessment.decision).toBe('applicable');
		expect(result.journals[0]?.outcome).toBe('completed');
		expect(await ageIsNullable()).toBe(false);
	});

	it('keeps NO_NULLS volatile and fails apply if a null appears after proof', async () => {
		await createUsersTable([18, 21, 34]);
		const { pool, registry, outcome } = await proveSetNotNull();
		expect(outcome.kind).toBe('proven');
		if (outcome.kind !== 'proven') {
			return;
		}
		const guard = outcome.plan.steps[0]?.guards[0];
		expect(guard?.predicate.kind).toBe('NO_NULLS');
		expect(guard).not.toHaveProperty('discharged');

		await pool.query(
			`INSERT INTO ${quoteIdent(schemaName)}.${quoteIdent(
				'users',
			)} (age) VALUES (NULL)`,
		);
		const result = await createApplier(registry).apply(
			{ plan: outcome.plan, assessment: outcome.assessment },
			policy,
			pool,
		);

		expect(result.assessment.reasons[0]?.code).toBe('guard-failed');
		expect(result.journals[0]?.outcome).toBe('guard-failed');
		expect(await ageIsNullable()).toBe(true);
	});

	it('fails apply when a null row is present from the start', async () => {
		await createUsersTable([18, null, 34]);
		const { pool, registry, outcome } = await proveSetNotNull();
		expect(outcome.kind).toBe('proven');
		if (outcome.kind !== 'proven') {
			return;
		}

		const result = await createApplier(registry).apply(
			{ plan: outcome.plan, assessment: outcome.assessment },
			policy,
			pool,
		);

		expect(result.assessment.reasons[0]?.code).toBe('guard-failed');
		expect(result.journals[0]?.outcome).toBe('guard-failed');
		expect(await ageIsNullable()).toBe(true);
	});

	it('proves and applies SET NOT NULL with an unchanged literal default', async () => {
		const pool = await getTestPool();
		await pool.query(
			`CREATE TABLE ${quoteIdent(schemaName)}.${quoteIdent(
				'users',
			)} (id serial PRIMARY KEY, status text DEFAULT 'active' NULL)`,
		);
		await pool.query(
			`INSERT INTO ${quoteIdent(schemaName)}.${quoteIdent(
				'users',
			)} (status) VALUES ('active'), ('pending')`,
		);
		const desired = model(false, 'status', {
			type: 'string',
			originalDbType: 'text',
			default: 'active',
		});
		const current = model(true, 'status', {
			type: 'string',
			originalDbType: 'text',
			default: { sql: "'active'::text" },
		});
		const { registry, outcome } = await proveSetNotNullForModels(
			desired,
			current,
		);
		expect(outcome.kind).toBe('proven');
		if (outcome.kind !== 'proven') {
			return;
		}

		const result = await createApplier(registry).apply(
			{ plan: outcome.plan, assessment: outcome.assessment },
			policy,
			pool,
		);

		expect(result.assessment.decision).toBe('applicable');
		expect(result.journals[0]?.outcome).toBe('completed');
	});

	it('proves and applies SET NOT NULL for a UNIQUE nullable column', async () => {
		const pool = await getTestPool();
		await pool.query(
			`CREATE TABLE ${quoteIdent(schemaName)}.${quoteIdent(
				'users',
			)} (id serial PRIMARY KEY, email text UNIQUE NULL)`,
		);
		await pool.query(
			`INSERT INTO ${quoteIdent(schemaName)}.${quoteIdent(
				'users',
			)} (email) VALUES ('a@example.test'), ('b@example.test')`,
		);
		const desired = model(false, 'email', {
			type: 'string',
			originalDbType: 'text',
			unique: true,
		});
		const current = model(true, 'email', {
			type: 'string',
			originalDbType: 'text',
			unique: true,
			uniqueConstraintName: 'users_email_key',
		});
		const { registry, outcome } = await proveSetNotNullForModels(
			desired,
			current,
		);
		expect(outcome.kind).toBe('proven');
		if (outcome.kind !== 'proven') {
			return;
		}

		const result = await createApplier(registry).apply(
			{ plan: outcome.plan, assessment: outcome.assessment },
			policy,
			pool,
		);

		expect(result.assessment.decision).toBe('applicable');
		expect(result.journals[0]?.outcome).toBe('completed');
	});
});
