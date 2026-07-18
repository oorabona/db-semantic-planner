import {
	createPgsqlAdapter,
	createPgTransitionPack,
	DBSP_LOGICAL_IDENTITY_TABLE,
	DBSP_META_SCHEMA,
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

const schemaName = 'transition_identity_adoption';
const asserter = { kind: 'human' as const, identity: 'schema-owner' };

const acceptedPolicy: ApplyPolicy = {
	accepts: [
		{ class: 'operation-pack-semantics' },
		{
			class: 'baseline-identity-attachment',
			fromTrustRoot: asserter,
			withinScope: [{ kind: 'column', name: 'age' }],
		},
	],
};

function quoteIdent(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function modelFromTable(table: TableIR): ModelIR {
	const tables = new Map<string, TableIR>([[table.name, table]]);
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

function withAgeIdentity(table: TableIR): TableIR {
	return {
		...table,
		columns: table.columns.map((column) =>
			column.name === 'age'
				? {
						...column,
						logicalIdentity: {
							id: 'logical.column.users.age',
							carrier: {
								kind: 'postgresql-side-table',
								authenticated: false,
							},
						},
					}
				: column,
		),
	};
}

async function createUsers(): Promise<void> {
	const pool = await getTestPool();
	await pool.query(
		`CREATE TABLE ${quoteIdent(schemaName)}.${quoteIdent(
			'users',
		)} (age integer NULL)`,
	);
}

async function sideTableRows(): Promise<readonly Record<string, unknown>[]> {
	const pool = await getTestPool();
	const exists = await pool.query(
		'SELECT pg_catalog.to_regclass($1) IS NOT NULL AS exists',
		[
			`${quoteIdent(DBSP_META_SCHEMA)}.${quoteIdent(
				DBSP_LOGICAL_IDENTITY_TABLE,
			)}`,
		],
	);
	if (exists.rows[0]?.exists !== true) {
		return [];
	}
	const result = await pool.query(
		`SELECT logical_id, schema_name, table_name, column_name, carrier_kind ` +
			`FROM ${quoteIdent(DBSP_META_SCHEMA)}.${quoteIdent(
				DBSP_LOGICAL_IDENTITY_TABLE,
			)} ` +
			`WHERE schema_name = $1 ` +
			`ORDER BY logical_id`,
		[schemaName],
	);
	return result.rows;
}

async function tableExists(
	name: string,
	schema = schemaName,
): Promise<boolean> {
	const pool = await getTestPool();
	const result = await pool.query(
		'SELECT 1 FROM pg_catalog.pg_class c ' +
			'JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace ' +
			'WHERE n.nspname = $1 AND c.relname = $2 LIMIT 1',
		[schema, name],
	);
	return result.rows.length > 0;
}

function transitionRegistry() {
	return createPackRegistry([
		createPgTransitionPack({
			identityAdoptionAsserter: asserter,
			identityAdoptionSelectionBasis:
				'e2e selected same physical column during baseline adoption',
		}),
	]);
}

describe('ADR-0003 transition planner: logical identity adoption', () => {
	beforeAll(async () => {
		await createSchema(schemaName);
	});

	afterEach(async () => {
		const pool = await getTestPool();
		if (await tableExists(DBSP_LOGICAL_IDENTITY_TABLE, DBSP_META_SCHEMA)) {
			await pool.query(
				`DELETE FROM ${quoteIdent(DBSP_META_SCHEMA)}.${quoteIdent(
					DBSP_LOGICAL_IDENTITY_TABLE,
				)} WHERE schema_name = $1`,
				[schemaName],
			);
		}
		await pool.query(
			`DROP TABLE IF EXISTS ${quoteIdent(schemaName)}.${quoteIdent(
				DBSP_LOGICAL_IDENTITY_TABLE,
			)} CASCADE`,
		);
		await pool.query(
			`DROP TABLE IF EXISTS ${quoteIdent(schemaName)}.${quoteIdent(
				'accounts',
			)} CASCADE`,
		);
		await pool.query(
			`DROP TABLE IF EXISTS ${quoteIdent(schemaName)}.${quoteIdent(
				'users',
			)} CASCADE`,
		);
	});

	afterAll(async () => {
		await dropSchema(schemaName);
	});

	it('adopts a column identity, writes the side table, and re-proves no-drift after introspection', async () => {
		await createUsers();
		const pool = await getTestPool();
		const adapter = createPgsqlAdapter(pool, { schemaName });
		const current = await adapter.introspect({ schema: schemaName });
		const currentUsers = current.getTable('users');
		expect(currentUsers).toBeDefined();
		if (!currentUsers) {
			return;
		}
		const desired = modelFromTable(withAgeIdentity(currentUsers));
		const registry = transitionRegistry();
		const comparator = createComparator(registry);
		const prover = createProver(registry);
		const context = await readPgObservationContext(pool, schemaName);
		const compare = comparator.compare(desired, current);
		expect(compare.kind).toBe('transitions');

		const outcome = await prover.prove(compare, pool, context);
		expect(outcome.kind).toBe('proven');
		if (outcome.kind !== 'proven') {
			return;
		}
		expect(
			outcome.plan.assumptions.some(
				(assumption) => assumption.class === 'baseline-identity-attachment',
			),
		).toBe(true);

		const applied = await createApplier(registry).apply(
			{ plan: outcome.plan, assessment: outcome.assessment },
			acceptedPolicy,
			pool,
		);

		expect(applied.assessment.decision).toBe('applicable');
		expect(await tableExists(DBSP_LOGICAL_IDENTITY_TABLE)).toBe(false);
		expect(
			await tableExists(DBSP_LOGICAL_IDENTITY_TABLE, DBSP_META_SCHEMA),
		).toBe(true);
		expect(await sideTableRows()).toContainEqual(
			expect.objectContaining({
				logical_id: 'logical.column.users.age',
				schema_name: schemaName,
				table_name: 'users',
				column_name: 'age',
				carrier_kind: 'postgresql-side-table',
			}),
		);

		const reintrospected = await adapter.introspect({ schema: schemaName });
		const reintrospectedAge = reintrospected
			.getTable('users')
			?.columns.find((column) => column.name === 'age');
		expect(reintrospectedAge?.logicalIdentity).toMatchObject({
			id: 'logical.column.users.age',
			carrier: {
				kind: 'postgresql-side-table',
				authenticated: false,
			},
		});
		const noDrift = await prover.prove(
			comparator.compare(desired, reintrospected),
			pool,
			context,
		);
		expect(noDrift.kind).toBe('no-drift');
	});

	it('blocks a rename-shaped diff without identity and leaves the table unchanged', async () => {
		await createUsers();
		const pool = await getTestPool();
		const registry = transitionRegistry();
		const current = modelFromTable({
			name: 'users',
			columns: [{ name: 'age', type: 'integer', nullable: true }],
			foreignKeys: [],
			indexes: [],
		});
		const desired = modelFromTable({
			name: 'accounts',
			columns: [{ name: 'age', type: 'integer', nullable: true }],
			foreignKeys: [],
			indexes: [],
		});
		const compare = createComparator(registry).compare(desired, current);
		expect(compare.kind).toBe('unsupported');
		const outcome = await createProver(registry).prove(
			compare,
			pool,
			await readPgObservationContext(pool, schemaName),
		);

		expect(outcome.kind).toBe('blocked');
		if (outcome.kind === 'blocked') {
			expect(outcome.assessment.reasons[0]?.code).toBe(
				'unsupported-transition',
			);
		}
		expect(await tableExists('users')).toBe(true);
		expect(await tableExists('accounts')).toBe(false);
	});

	it('blocks apply when baseline identity assumptions are not accepted and writes no side-table row', async () => {
		await createUsers();
		const pool = await getTestPool();
		const adapter = createPgsqlAdapter(pool, { schemaName });
		const current = await adapter.introspect({ schema: schemaName });
		const currentUsers = current.getTable('users');
		expect(currentUsers).toBeDefined();
		if (!currentUsers) {
			return;
		}
		const desired = modelFromTable(withAgeIdentity(currentUsers));
		const registry = transitionRegistry();
		const comparator = createComparator(registry);
		const prover = createProver(registry);
		const context = await readPgObservationContext(pool, schemaName);
		const outcome = await prover.prove(
			comparator.compare(desired, current),
			pool,
			context,
		);
		expect(outcome.kind).toBe('proven');
		if (outcome.kind !== 'proven') {
			return;
		}

		const applied = await createApplier(registry).apply(
			{ plan: outcome.plan, assessment: outcome.assessment },
			{ accepts: [{ class: 'operation-pack-semantics' }] },
			pool,
		);

		expect(applied.assessment.decision).toBe('blocked');
		expect(applied.assessment.reasons[0]).toMatchObject({
			code: 'uncomposable',
		});
		expect(await sideTableRows()).toHaveLength(0);
	});
});
