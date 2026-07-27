import {
	ADD_CHECK_RULE_ID,
	createPgsqlAdapter,
	createPgTransitionPack,
	createPgTransitionRunPersister,
	ENUM_ADD_VALUE_RULE_ID,
	readPgObservationContextFromLessor,
} from '@dbsp/adapter-pgsql';
import {
	type ApplyPolicy,
	type CheckConstraintIR,
	createApplier,
	createComparator,
	createPackRegistry,
	createProver,
	createStagedTransitionOrchestrator,
	createTransitionLessor,
	type EnumIR,
	type ModelIR,
	type TableIR,
} from '@dbsp/core';
import { Pool, type PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	createSchema,
	dropSchema,
	getTestPool,
	getTestTransitionLessor,
} from './testkit/index.js';

const schemaName = 'transition_enum_add_check_staged';

const policy: ApplyPolicy = {
	accepts: [
		{ class: 'operation-pack-semantics' },
		{ class: 'external-ddl-exclusion' },
	],
};

function quoteIdent(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function modelFromTables(
	tables: readonly TableIR[],
	enums?: ReadonlyMap<string, EnumIR>,
): ModelIR {
	const tableMap = new Map(tables.map((table) => [table.name, table]));
	return {
		tables: tableMap,
		relations: new Map(),
		...(enums ? { enums } : {}),
		getTable: (name) => tableMap.get(name),
		getRelation: () => undefined,
		getRelationsFrom: () => [],
		getRelationsTo: () => [],
		isAmbiguous: () => ({ ambiguous: false, options: [] }),
	};
}

function desiredFromCurrent(
	current: ModelIR,
	options: {
		readonly checkExpression: string;
		readonly enumValues?: readonly string[];
		readonly requiresEnumLabels?: boolean;
	},
): ModelIR {
	const currentTasks = current.getTable('tasks');
	if (!currentTasks) {
		throw new Error('expected introspected tasks table');
	}
	const check: CheckConstraintIR = {
		name: 'tasks_status_check',
		expression: options.checkExpression,
		...((options.requiresEnumLabels ?? true)
			? {
					requiresEnumLabels: [
						{ schema: schemaName, type: 'status', label: 'pending' },
					],
				}
			: {}),
	};
	const enums =
		options.enumValues === undefined
			? current.enums
			: new Map<string, EnumIR>([
					[
						'status',
						{
							name: 'status',
							schema: schemaName,
							values: options.enumValues,
						},
					],
				]);
	return modelFromTables(
		[
			{
				...currentTasks,
				checkConstraints: [check],
			},
		],
		enums,
	);
}

async function createBaseTasks(statuses: readonly string[]): Promise<void> {
	const pool = await getTestPool();
	await pool.query(
		`CREATE TYPE ${quoteIdent(schemaName)}.${quoteIdent(
			'status',
		)} AS ENUM ('active')`,
	);
	await pool.query(
		`CREATE TABLE ${quoteIdent(schemaName)}.${quoteIdent('tasks')} (
			id integer PRIMARY KEY,
			status ${quoteIdent(schemaName)}.${quoteIdent('status')} NOT NULL
		)`,
	);
	for (const [index, status] of statuses.entries()) {
		await pool.query(
			`INSERT INTO ${quoteIdent(schemaName)}.${quoteIdent(
				'tasks',
			)} (id, status) VALUES ($1, $2::${quoteIdent(schemaName)}.${quoteIdent(
				'status',
			)})`,
			[index + 1, status],
		);
	}
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

async function checkExists(): Promise<boolean> {
	const pool = await getTestPool();
	const result = await pool.query(
		'SELECT 1 FROM pg_catalog.pg_constraint con ' +
			'JOIN pg_catalog.pg_class c ON c.oid = con.conrelid ' +
			'JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace ' +
			'WHERE n.nspname = $1 AND c.relname = $2 AND con.conname = $3',
		[schemaName, 'tasks', 'tasks_status_check'],
	);
	return result.rows.length > 0;
}

/**
 * A lessor whose leases record the SQL they are asked to run, so a test can
 * assert the transaction boundaries the engine actually emitted. It is minted
 * through the same core factory a consumer would use — a hand-built object is
 * not a target.
 */
function trackedTarget(pool: Pool) {
	const queries: string[] = [];
	return {
		queries,
		target: createTransitionLessor(async () => {
			const client = await pool.connect();
			return {
				query: async (sql: string, params?: readonly unknown[]) => {
					queries.push(sql);
					return client.query(sql, params as unknown[]);
				},
				release: (error?: unknown) => {
					client.release(error as Error | undefined);
				},
			};
		}),
	};
}

let target: Awaited<ReturnType<typeof getTestTransitionLessor>>;

describe('ADR-0003 transition planner: staged enum ADD VALUE plus ADD CHECK', () => {
	beforeAll(async () => {
		target = await getTestTransitionLessor();
		await createSchema(schemaName);
	});

	afterEach(async () => {
		const pool = await getTestPool();
		await pool.query(
			`DROP TABLE IF EXISTS ${quoteIdent(schemaName)}.${quoteIdent(
				'tasks',
			)} CASCADE`,
		);
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

	it('commits the enum label, re-introspects, then proves and applies the CHECK', async () => {
		await createBaseTasks(['active']);
		const pool = await getTestPool();
		const adapter = createPgsqlAdapter(pool, { schemaName });
		const registry = createPackRegistry([createPgTransitionPack()]);
		const comparator = createComparator(registry);
		const loadCurrent = () => adapter.introspect({ schema: schemaName });
		const readContext = () =>
			readPgObservationContextFromLessor(target, schemaName);
		const current = await loadCurrent();
		const desired = desiredFromCurrent(current, {
			enumValues: ['active', 'pending'],
			checkExpression: "status <> 'pending'",
		});
		const initialCompare = comparator.compare(desired, current);
		expect(initialCompare.kind).toBe('transitions');
		if (initialCompare.kind !== 'transitions') {
			return;
		}
		expect(
			new Set(initialCompare.candidates.map((entry) => entry.rule.id)),
		).toEqual(new Set([ADD_CHECK_RULE_ID, ENUM_ADD_VALUE_RULE_ID]));

		const result = await createStagedTransitionOrchestrator(
			registry,
			createPgTransitionRunPersister(pool),
		).applyStagedTransition({
			desired,
			loadCurrent,
			readContext,
			target,
			policy,
		});

		expect(result.assessment.decision).toBe('applicable');
		expect(result.journals.map((journal) => journal.outcome)).toEqual([
			'completed',
			'completed',
		]);
		expect(await enumLabels()).toEqual(['active', 'pending']);
		expect(await checkExists()).toBe(true);

		const finalCurrent = await loadCurrent();
		const finalCheckExpression =
			finalCurrent.getTable('tasks')?.checkConstraints?.[0]?.expression ??
			"status <> 'pending'";
		const desiredEquivalent = desiredFromCurrent(finalCurrent, {
			enumValues: ['active', 'pending'],
			checkExpression: finalCheckExpression,
		});
		const noDriftCompare = comparator.compare(desiredEquivalent, finalCurrent);
		const noDrift = await createProver(registry).prove(
			noDriftCompare,
			target,
			await readContext(),
		);
		expect(noDrift.kind).toBe('no-drift');
	});

	it('rejects a real checked-out PoolClient as an undeclared target', async () => {
		await createBaseTasks(['active']);
		const connectionString = process.env.DATABASE_URL;
		if (!connectionString) throw new Error('DATABASE_URL not set');
		const pool = new Pool({ connectionString });
		let client: PoolClient | undefined;
		try {
			client = await pool.connect();
			const adapter = createPgsqlAdapter(pool, { schemaName });
			const registry = createPackRegistry([createPgTransitionPack()]);
			const comparator = createComparator(registry);
			const current = await adapter.introspect({ schema: schemaName });
			const desired = desiredFromCurrent(current, {
				enumValues: ['active', 'pending'],
				checkExpression: "status <> 'pending'",
			});
			const compare = comparator.compare(desired, current);
			expect(compare.kind).toBe('transitions');

			const outcome = await createProver(registry).prove(
				compare,
				client as never,
				await readPgObservationContextFromLessor(target, schemaName),
			);

			expect(outcome.kind).toBe('blocked');
			if (outcome.kind === 'blocked') {
				expect(outcome.assessment.reasons[0]).toMatchObject({
					fact: { value: expect.stringMatching(/core-minted lessor/i) },
				});
			}
		} finally {
			client?.release();
			await pool.end();
		}
	});

	it('applies independent enum ADD VALUE and CHECK in one atomic commit', async () => {
		await createBaseTasks(['active']);
		const pool = await getTestPool();
		const adapter = createPgsqlAdapter(pool, { schemaName });
		const registry = createPackRegistry([createPgTransitionPack()]);
		const comparator = createComparator(registry);
		const current = await adapter.introspect({ schema: schemaName });
		const desired = desiredFromCurrent(current, {
			enumValues: ['active', 'pending'],
			checkExpression: 'id > 0',
			requiresEnumLabels: false,
		});
		const compare = comparator.compare(desired, current);
		const proof = await createProver(registry).prove(
			compare,
			target,
			await readPgObservationContextFromLessor(target, schemaName),
		);
		expect(proof.kind).toBe('proven');
		if (proof.kind !== 'proven') {
			return;
		}
		expect(proof.plan.segments).toMatchObject([
			{
				transaction: 'joins-current',
				commitBoundaryBefore: false,
				commitBoundaryAfter: false,
			},
		]);
		expect(proof.plan.segments[0]?.stepIds).toHaveLength(2);
		const tracked = trackedTarget(pool);

		const result = await createApplier(
			registry,
			createPgTransitionRunPersister(pool),
		).apply(
			{ plan: proof.plan, assessment: proof.assessment },
			policy,
			tracked.target,
		);

		expect(result.assessment.decision).toBe('applicable');
		expect(result.journals.map((journal) => journal.outcome)).toEqual([
			'completed',
			'completed',
		]);
		expect(await enumLabels()).toEqual(['active', 'pending']);
		expect(await checkExists()).toBe(true);
		expect(tracked.queries.filter((sql) => sql === 'BEGIN')).toHaveLength(1);
		expect(tracked.queries.filter((sql) => sql === 'COMMIT')).toHaveLength(1);
		expect(tracked.queries.filter((sql) => sql === 'ROLLBACK')).toHaveLength(0);
	});

	it('rolls back an independent enum ADD VALUE when the independent CHECK guard fails', async () => {
		await createBaseTasks(['active']);
		const pool = await getTestPool();
		const adapter = createPgsqlAdapter(pool, { schemaName });
		const registry = createPackRegistry([createPgTransitionPack()]);
		const comparator = createComparator(registry);
		const current = await adapter.introspect({ schema: schemaName });
		const desired = desiredFromCurrent(current, {
			enumValues: ['active', 'pending'],
			checkExpression: "status::text = 'pending'",
			requiresEnumLabels: false,
		});
		const compare = comparator.compare(desired, current);
		const proof = await createProver(registry).prove(
			compare,
			target,
			await readPgObservationContextFromLessor(target, schemaName),
		);
		expect(proof.kind).toBe('proven');
		if (proof.kind !== 'proven') {
			return;
		}
		expect(proof.plan.segments).toHaveLength(1);
		expect(proof.plan.segments[0]?.stepIds).toHaveLength(2);
		const tracked = trackedTarget(pool);

		const result = await createApplier(
			registry,
			createPgTransitionRunPersister(pool),
		).apply(
			{ plan: proof.plan, assessment: proof.assessment },
			policy,
			tracked.target,
		);

		expect(result.assessment.decision).toBe('blocked');
		expect(result.assessment.lifecycle).toBe('planned');
		expect(result.assessment.reasons[0]?.code).toBe('guard-failed');
		expect(result.journals.map((journal) => journal.outcome)).toEqual([
			'guard-failed',
		]);
		expect(await enumLabels()).toEqual(['active']);
		expect(await checkExists()).toBe(false);
		expect(tracked.queries.filter((sql) => sql === 'COMMIT')).toHaveLength(0);
		expect(tracked.queries.filter((sql) => sql === 'ROLLBACK')).toHaveLength(1);
	});

	it('fails closed before DB changes when the required enum label has no producer', async () => {
		await createBaseTasks(['active']);
		const pool = await getTestPool();
		const adapter = createPgsqlAdapter(pool, { schemaName });
		const registry = createPackRegistry([createPgTransitionPack()]);
		const current = await adapter.introspect({ schema: schemaName });
		const desired = desiredFromCurrent(current, {
			checkExpression: "status <> 'pending'",
		});

		const result = await createStagedTransitionOrchestrator(
			registry,
			createPgTransitionRunPersister(pool),
		).applyStagedTransition({
			desired,
			loadCurrent: () => adapter.introspect({ schema: schemaName }),
			readContext: () => readPgObservationContextFromLessor(target, schemaName),
			target,
			policy,
		});

		expect(result.assessment.reasons[0]?.code).toBe('unsupported-transition');
		expect(result.journals).toEqual([]);
		expect(await enumLabels()).toEqual(['active']);
		expect(await checkExists()).toBe(false);
	});

	it('reports partially-applied when the CHECK row guard fails after the enum commits', async () => {
		await createBaseTasks(['active']);
		const pool = await getTestPool();
		const adapter = createPgsqlAdapter(pool, { schemaName });
		const registry = createPackRegistry([createPgTransitionPack()]);
		const current = await adapter.introspect({ schema: schemaName });
		const desired = desiredFromCurrent(current, {
			enumValues: ['active', 'pending'],
			checkExpression: "status = 'pending'",
		});

		const result = await createStagedTransitionOrchestrator(
			registry,
			createPgTransitionRunPersister(pool),
		).applyStagedTransition({
			desired,
			loadCurrent: () => adapter.introspect({ schema: schemaName }),
			readContext: () => readPgObservationContextFromLessor(target, schemaName),
			target,
			policy,
		});

		expect(result.assessment.decision).toBe('blocked');
		expect(result.assessment.lifecycle).toBe('partially-applied');
		expect(result.assessment.continuation).toBe('resume-possible');
		expect(result.assessment.reasons[0]?.code).toBe('guard-failed');
		expect(result.journals.map((journal) => journal.outcome)).toEqual([
			'completed',
			'guard-failed',
		]);
		expect(await enumLabels()).toEqual(['active', 'pending']);
		expect(await checkExists()).toBe(false);
	});
});
