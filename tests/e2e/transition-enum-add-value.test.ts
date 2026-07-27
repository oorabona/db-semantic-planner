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
} from '@dbsp/core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	createSchema,
	dropSchema,
	getTestPool,
	getTestTransitionLessor,
} from './testkit/index.js';

const schemaName = 'transition_enum_add_value';

const policy: ApplyPolicy = {
	accepts: [
		{ class: 'operation-pack-semantics' },
		{ class: 'external-ddl-exclusion' },
	],
};

function quoteIdent(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function model(values: readonly string[]): ModelIR {
	const enums = new Map([
		['status', { name: 'status', schema: schemaName, values }],
	]);
	return {
		tables: new Map(),
		relations: new Map(),
		enums,
		getTable: () => undefined,
		getRelation: () => undefined,
		getRelationsFrom: () => [],
		getRelationsTo: () => [],
		isAmbiguous: () => ({ ambiguous: false, options: [] }),
	};
}

async function enumLabels(): Promise<readonly string[]> {
	const pool = await getTestPool();
	const result = await pool.query(
		'SELECT e.enumlabel AS label ' +
			'FROM pg_catalog.pg_type t ' +
			'JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace ' +
			'JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid ' +
			'WHERE n.nspname = $1 AND t.typname = $2 ' +
			'ORDER BY e.enumsortorder',
		[schemaName, 'status'],
	);
	return result.rows.map((row) => String(row.label));
}

let target: Awaited<ReturnType<typeof getTestTransitionLessor>>;

describe('ADR-0003 transition planner: ALTER TYPE ADD VALUE', () => {
	beforeAll(async () => {
		target = await getTestTransitionLessor();
		await createSchema(schemaName);
	});

	afterEach(async () => {
		const pool = await getTestPool();
		await pool.query(
			`DROP TYPE IF EXISTS ${quoteIdent(schemaName)}.${quoteIdent(
				'status',
			)} CASCADE`,
		);
		await pool.query(
			`DROP TABLE IF EXISTS ${quoteIdent(schemaName)}.${quoteIdent(
				'dbsp_transition_journal',
			)} CASCADE`,
		);
	});

	afterAll(async () => {
		await dropSchema(schemaName);
	});

	it('proves and applies one enum label addition', async () => {
		const pool = await getTestPool();
		await pool.query(
			`CREATE TYPE ${quoteIdent(schemaName)}.${quoteIdent(
				'status',
			)} AS ENUM ('inactive', 'active')`,
		);
		const registry = createPackRegistry([createPgTransitionPack()]);
		const comparator = createComparator(registry);
		const desired = model(['inactive', 'pending', 'active']);
		const current = model(['inactive', 'active']);
		const compare = comparator.compare(desired, current);
		expect(compare.kind).toBe('transitions');

		const context = await readPgObservationContextFromLessor(
			target,
			schemaName,
		);
		const outcome = await createProver(registry).prove(
			compare,
			target,
			context,
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

		expect(result.assessment.decision).toBe('applicable');
		expect(result.journals[0]?.outcome).toBe('completed');
		expect(await enumLabels()).toEqual(['inactive', 'pending', 'active']);

		const adapter = createPgsqlAdapter(pool, { schemaName });
		const introspected = await adapter.introspect({ schema: schemaName });
		const noOp = comparator.compare(desired, introspected);
		expect(noOp.kind).toBe('no-drift');
	});
});
