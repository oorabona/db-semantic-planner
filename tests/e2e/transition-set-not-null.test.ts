import {
	createPgObservationIssuer,
	createPgTransitionPack,
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

const schemaName = 'transition_set_not_null';

const policy: ApplyPolicy = {
	accepts: [
		{ class: 'operation-pack-semantics' },
		{ class: 'external-ddl-exclusion' },
	],
};

const schemaAuthor = { kind: 'human' as const, identity: 'schema-author' };

const policyWithNativeDefaultAttestation: ApplyPolicy = {
	accepts: [
		...policy.accepts,
		{
			class: 'user-attested-native-default',
			fromTrustRoot: schemaAuthor,
			withinScope: [{ kind: 'column', name: 'age' }],
		},
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

function attestedNativeDefault(sql: string) {
	return {
		sql,
		attestedBy: schemaAuthor,
		statement: 'Schema author attests this raw SQL default is unchanged.',
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

async function createUsersTableWithRawDefault(
	ages: readonly (number | null)[],
): Promise<void> {
	const pool = await getTestPool();
	await pool.query(
		`CREATE TABLE ${quoteIdent(schemaName)}.${quoteIdent(
			'users',
		)} (id serial PRIMARY KEY, age integer DEFAULT (42 + 1) NULL)`,
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
	const context = await readPgObservationContextFromLessor(target, schemaName);
	const compare = comparator.compare(model(false), model(true));
	return {
		pool,
		target,
		registry,
		context,
		outcome: await prover.prove(compare, target, context),
	};
}

async function proveSetNotNullForModels(desired: ModelIR, current: ModelIR) {
	const pool = await getTestPool();
	const registry = createPackRegistry([createPgTransitionPack()]);
	const comparator = createComparator(registry);
	const prover = createProver(registry);
	const context = await readPgObservationContextFromLessor(target, schemaName);
	const compare = comparator.compare(desired, current);
	return {
		pool,
		target,
		registry,
		context,
		outcome: await prover.prove(compare, target, context),
	};
}

let target: Awaited<ReturnType<typeof getTestTransitionLessor>>;

describe('ADR-0003 transition planner: SET NOT NULL', () => {
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
		await pool.query(
			`DROP TYPE IF EXISTS ${quoteIdent(schemaName)}.${quoteIdent(
				'status',
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
			target,
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
			target,
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
			target,
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
			target,
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
			target,
		);

		expect(result.assessment.decision).toBe('applicable');
		expect(result.journals[0]?.outcome).toBe('completed');
	});

	it('blocks SET NOT NULL when live custom type identity remains unresolved at proof time', async () => {
		const pool = await getTestPool();
		await pool.query(
			`CREATE TYPE ${quoteIdent(schemaName)}.${quoteIdent(
				'status',
			)} AS ENUM ('active', 'pending')`,
		);
		await pool.query(
			`CREATE TABLE ${quoteIdent(schemaName)}.${quoteIdent(
				'users',
			)} (id serial PRIMARY KEY, status ${quoteIdent(
				schemaName,
			)}.${quoteIdent('status')} NULL)`,
		);
		await pool.query(
			`INSERT INTO ${quoteIdent(schemaName)}.${quoteIdent(
				'users',
			)} (status) VALUES ('active'), ('pending')`,
		);
		const desired = model(false, 'status', {
			type: 'string',
			originalDbType: 'status',
		});
		const current = model(true, 'status', {
			type: 'string',
			originalDbType: 'status',
		});
		const pack = createPgTransitionPack();
		const issuer = createPgObservationIssuer();
		const registry = createPackRegistry([
			{
				...pack,
				issuer: {
					...issuer,
					readContext: async (target, context, requests) => ({
						...(issuer.readContext
							? await issuer.readContext(target, context, requests)
							: context),
						searchPath: ['public', schemaName],
					}),
				},
			},
		]);
		const context = {
			...(await readPgObservationContextFromLessor(target, schemaName)),
			searchPath: ['public', schemaName],
		};
		const compare = createComparator(registry).compare(desired, current);
		expect(compare.kind).toBe('transitions');

		const outcome = await createProver(registry).prove(
			compare,
			target,
			context,
		);

		expect(outcome.kind).toBe('blocked');
		if (outcome.kind === 'blocked') {
			expect(JSON.stringify(outcome.assessment.reasons)).toContain(
				'the target column no longer matches the compared desired shape',
			);
			expect(JSON.stringify(outcome.assessment.reasons)).toContain(
				'field type',
			);
		}
	});

	it('proves and applies SET NOT NULL with an author-attested raw SQL default', async () => {
		await createUsersTableWithRawDefault([18, 21, 34]);
		const defaultValue = attestedNativeDefault('(42 + 1)');
		const desired = model(false, 'age', {
			default: defaultValue,
		});
		const current = model(true, 'age', {
			default: defaultValue,
		});
		const { pool, registry, outcome } = await proveSetNotNullForModels(
			desired,
			current,
		);
		expect(outcome.kind).toBe('proven');
		if (outcome.kind !== 'proven') {
			return;
		}
		expect(outcome.assessment.assurance).toBe('accepted-under-assumptions');
		const assumption = outcome.plan.assumptions.find(
			(item) => item.class === 'user-attested-native-default',
		);
		expect(assumption).toBeDefined();
		if (!assumption) {
			return;
		}
		expect(outcome.plan.steps[0]?.restsOnAssumptions).toContain(assumption.id);

		const result = await createApplier(registry).apply(
			{ plan: outcome.plan, assessment: outcome.assessment },
			policyWithNativeDefaultAttestation,
			target,
		);

		expect(result.assessment.decision).toBe('applicable');
		expect(result.journals[0]?.outcome).toBe('completed');
		expect(await ageIsNullable()).toBe(false);
	});

	it('blocks SET NOT NULL with an unattested raw SQL default', async () => {
		await createUsersTableWithRawDefault([18, 21, 34]);
		const desired = model(false, 'age', {
			default: { sql: '(42 + 1)' },
		});
		const current = model(true, 'age', {
			default: { sql: '(42 + 1)' },
		});
		const { outcome } = await proveSetNotNullForModels(desired, current);

		expect(outcome.kind).toBe('blocked');
		if (outcome.kind === 'blocked') {
			expect(outcome.assessment.reasons[0]?.code).toBe('insufficient-evidence');
		}
	});
});
