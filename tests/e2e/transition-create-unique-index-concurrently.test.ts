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

const schemaName = 'transition_create_unique_index_concurrently';

const policy: ApplyPolicy = {
	accepts: [
		{ class: 'operation-pack-semantics' },
		{ class: 'external-ddl-exclusion' },
		{ class: 'non-transactional-segment' },
	],
};

function quoteIdent(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function usersTable(indexes: TableIR['indexes'] = []): TableIR {
	return {
		name: 'users',
		columns: [
			{ name: 'id', type: 'integer', nullable: false },
			{ name: 'email', type: 'string', nullable: false },
		],
		primaryKey: 'id',
		foreignKeys: [],
		indexes,
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

async function createUsers(emails: readonly string[]): Promise<void> {
	const pool = await getTestPool();
	await pool.query(
		`CREATE TABLE ${quoteIdent(schemaName)}.${quoteIdent(
			'users',
		)} (id integer PRIMARY KEY, email text NOT NULL)`,
	);
	let id = 1;
	for (const email of emails) {
		await pool.query(
			`INSERT INTO ${quoteIdent(schemaName)}.${quoteIdent(
				'users',
			)} (id, email) VALUES ($1, $2)`,
			[id++, email],
		);
	}
}

async function targetIndexCatalog(indexName = 'idx_users_email') {
	const pool = await getTestPool();
	return pool.query(
		'SELECT i.relname AS name, ix.indisunique, ix.indisvalid, ix.indisready ' +
			'FROM pg_catalog.pg_class i ' +
			'JOIN pg_catalog.pg_namespace n ON n.oid = i.relnamespace ' +
			'JOIN pg_catalog.pg_index ix ON ix.indexrelid = i.oid ' +
			'WHERE n.nspname = $1 AND i.relname = $2',
		[schemaName, indexName],
	);
}

async function userRows(): Promise<readonly { id: number; email: string }[]> {
	const pool = await getTestPool();
	const result = await pool.query(
		`SELECT id, email FROM ${quoteIdent(schemaName)}.${quoteIdent(
			'users',
		)} ORDER BY id`,
	);
	return result.rows as { id: number; email: string }[];
}

async function proveUniqueIndex(desired: ModelIR, current: ModelIR) {
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
		compare,
		outcome: await prover.prove(compare, target, context),
	};
}

let target: Awaited<ReturnType<typeof getTestTransitionLessor>>;

describe('ADR-0003 transition planner: CREATE UNIQUE INDEX CONCURRENTLY', () => {
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

	it('proves and applies a valid unique index concurrently and re-proves no-drift', async () => {
		await createUsers(['a@example.com', 'b@example.com', 'c@example.com']);
		const desired = model(
			usersTable([
				{ name: 'idx_users_email', columns: ['email'], unique: true },
			]),
		);
		const current = model(usersTable());
		const { pool, registry, outcome } = await proveUniqueIndex(
			desired,
			current,
		);
		expect(outcome.kind).toBe('proven');
		if (outcome.kind !== 'proven') {
			return;
		}
		const guard = outcome.plan.steps[0]?.guards[0];
		expect(guard).toMatchObject({
			phase: 'during-operation',
			protocol: { kind: 'engine-validated' },
			predicate: { kind: 'NO_DUPLICATES_FOR_UNIQUE_INDEX_BUILD' },
		});
		// CIC runs autocommit: its segment forbids the transaction (the applier
		// never opens a BEGIN for it). As the sole/first segment there is nothing
		// to commit before it, so commitBoundaryBefore is false by construction.
		expect(outcome.plan.segments[0]).toMatchObject({
			transaction: 'forbids-transaction',
			commitBoundaryAfter: true,
		});

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
		const catalog = await targetIndexCatalog();
		expect(catalog.rows[0]).toMatchObject({
			indisunique: true,
			indisvalid: true,
			indisready: true,
		});

		const adapter = createPgsqlAdapter(pool, { schemaName });
		const introspected = await adapter.introspect({ schema: schemaName });
		// Isolate index idempotency from the deferred author-vs-introspected column
		// equivalence (tracked in #345): mirror the introspected columns and re-declare
		// the SAME unique index in author form (no valid/ready). The applied index is
		// already present and valid, so this must re-prove as no-drift.
		const introspectedUsers = introspected.getTable('users');
		const desiredEquivalent = model({
			...introspectedUsers!,
			indexes: [{ name: 'idx_users_email', columns: ['email'], unique: true }],
		});
		const noDrift = await proveUniqueIndex(desiredEquivalent, introspected);
		expect(noDrift.outcome.kind).toBe('no-drift');
	});

	it('fails duplicates as guard-failed and cleans up the invalid index', async () => {
		await createUsers(['dup@example.com', 'dup@example.com', 'ok@example.com']);
		const desired = model(
			usersTable([
				{ name: 'idx_users_email', columns: ['email'], unique: true },
			]),
		);
		const current = model(usersTable());
		const { pool, registry, outcome } = await proveUniqueIndex(
			desired,
			current,
		);
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
		expect((await targetIndexCatalog()).rows).toEqual([]);
		expect(await userRows()).toEqual([
			{ id: 1, email: 'dup@example.com' },
			{ id: 2, email: 'dup@example.com' },
			{ id: 3, email: 'ok@example.com' },
		]);
	});

	it('rejects unsupported index shapes without attempting DDL', async () => {
		await createUsers(['a@example.com', 'b@example.com']);
		const desired = model(
			usersTable([
				{
					name: 'idx_users_email_active',
					columns: ['email'],
					unique: true,
					where: 'email IS NOT NULL',
				},
			]),
		);
		const current = model(usersTable());
		const { compare, outcome } = await proveUniqueIndex(desired, current);

		expect(compare.kind).toBe('unsupported');
		expect(outcome.kind).toBe('blocked');
		if (outcome.kind === 'blocked') {
			expect(outcome.assessment.reasons[0]?.code).toBe(
				'unsupported-transition',
			);
		}
		expect((await targetIndexCatalog('idx_users_email_active')).rows).toEqual(
			[],
		);
	});
});
