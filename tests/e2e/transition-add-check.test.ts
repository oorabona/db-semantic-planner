import {
	createPgsqlAdapter,
	createPgTransitionPack,
	createPgTransitionRunPersister,
	readPgObservationContextFromLessor,
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
import {
	createSchema,
	dropSchema,
	getTestPool,
	getTestTransitionLessor,
} from './testkit/index.js';

const schemaName = 'transition_add_check';

const policy: ApplyPolicy = {
	accepts: [
		{ class: 'operation-pack-semantics' },
		{ class: 'external-ddl-exclusion' },
	],
};

function quoteIdent(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function usersTable(checkExpression?: string): TableIR {
	return {
		name: 'users',
		columns: [{ name: 'age', type: 'integer', nullable: true }],
		foreignKeys: [],
		indexes: [],
		...(checkExpression
			? {
					checkConstraints: [
						{ name: 'users_age_check', expression: checkExpression },
					],
				}
			: {}),
	};
}

function model(table: TableIR): ModelIR {
	const tables = new Map<string, TableIR>([['users', table]]);
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

async function createUsers(ages: readonly number[]): Promise<void> {
	const pool = await getTestPool();
	await pool.query(
		`CREATE TABLE ${quoteIdent(schemaName)}.${quoteIdent(
			'users',
		)} (age integer NULL)`,
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

async function checkExists(): Promise<boolean> {
	const pool = await getTestPool();
	const result = await pool.query(
		'SELECT 1 FROM pg_catalog.pg_constraint con ' +
			'JOIN pg_catalog.pg_class c ON c.oid = con.conrelid ' +
			'JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace ' +
			'WHERE n.nspname = $1 AND c.relname = $2 AND con.conname = $3',
		[schemaName, 'users', 'users_age_check'],
	);
	return result.rows.length > 0;
}

let target: Awaited<ReturnType<typeof getTestTransitionLessor>>;

describe('ADR-0003 transition planner: ADD CHECK', () => {
	beforeAll(async () => {
		target = await getTestTransitionLessor();
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

	it('proves and applies one ADD CONSTRAINT CHECK and re-proves equivalent introspection as no-drift', async () => {
		await createUsers([1, 2, 3]);
		const pool = await getTestPool();
		const registry = createPackRegistry([createPgTransitionPack()]);
		const comparator = createComparator(registry);
		const prover = createProver(registry);
		const context = await readPgObservationContextFromLessor(
			target,
			schemaName,
		);
		const desired = model(usersTable('age > 0'));
		const current = model(usersTable());
		const compare = comparator.compare(desired, current);
		expect(compare.kind).toBe('transitions');

		const outcome = await prover.prove(compare, target, context);
		expect(outcome.kind).toBe('proven');
		if (outcome.kind !== 'proven') {
			return;
		}
		const result = await createApplier(
			registry,
			createPgTransitionRunPersister(pool),
		).apply(
			{ plan: outcome.plan, assessment: outcome.assessment },
			policy,
			target,
		);

		expect(result.assessment.decision).toBe('applicable');
		expect(result.journals[0]?.outcome).toBe('completed');
		expect(await checkExists()).toBe(true);

		const adapter = createPgsqlAdapter(pool, { schemaName });
		const introspected = await adapter.introspect({ schema: schemaName });
		const introspectedUsers = introspected.getTable('users');
		expect(introspectedUsers?.checkConstraints?.[0]).toMatchObject({
			name: 'users_age_check',
		});
		// Realistic idempotency: the author's desired declares only the table +
		// its CHECK (author form `age > 0`); model-level collections (extensions/
		// sequences/enums) are undefined — a real user never lists the 19 system
		// extensions. Re-comparing against the introspected model MUST be no-drift.
		const desiredEquivalent = model({
			...introspectedUsers!,
			checkConstraints: [{ name: 'users_age_check', expression: 'age > 0' }],
		});
		const noDriftCompare = comparator.compare(desiredEquivalent, introspected);
		const noDrift = await prover.prove(noDriftCompare, target, context);
		expect(noDrift.kind).toBe('no-drift');
	});

	it('fails the row-satisfy guard and leaves the CHECK unapplied when existing rows violate it', async () => {
		await createUsers([1, -1, 3]);
		const pool = await getTestPool();
		const registry = createPackRegistry([createPgTransitionPack()]);
		const comparator = createComparator(registry);
		const prover = createProver(registry);
		const context = await readPgObservationContextFromLessor(
			target,
			schemaName,
		);
		const compare = comparator.compare(
			model(usersTable('age > 0')),
			model(usersTable()),
		);
		const outcome = await prover.prove(compare, target, context);
		expect(outcome.kind).toBe('proven');
		if (outcome.kind !== 'proven') {
			return;
		}

		const result = await createApplier(
			registry,
			createPgTransitionRunPersister(pool),
		).apply(
			{ plan: outcome.plan, assessment: outcome.assessment },
			policy,
			target,
		);

		expect(result.assessment.reasons[0]?.code).toBe('guard-failed');
		expect(result.journals[0]?.outcome).toBe('guard-failed');
		expect(await checkExists()).toBe(false);
	});
});
