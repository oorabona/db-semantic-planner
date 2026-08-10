/** Unit 11: one shared sequential PostgreSQL container, isolated schemas. */

import { randomUUID } from 'node:crypto';
import {
	classifyGeneratedMutation,
	classifyRemovalEffectsClosure,
	createPgsqlGeneratedManagedStep,
	createPgTransitionRunPersister,
	readPgCatalogueIdentity,
	runPgReinitializePreflight,
} from '@dbsp/adapter-pgsql';
import { appendPgLedgerResolution } from '@dbsp/adapter-pgsql/internal';
import { outcomeClaimId, transitionPlanDigest } from '@dbsp/core';
import type {
	LedgerAddress,
	LedgerReservationRow,
	NormalizedManagedStep,
	ProvenPlanStep,
} from '@dbsp/types';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { runApply } from '../../packages/cli/src/commands/apply.js';
import { executeGeneratorPlan } from '../../packages/cli/src/commands/generator-execution.js';
import type { GeneratorDurablePlan } from '../../packages/cli/src/commands/generator-plan.js';
import { runReconcile } from '../../packages/cli/src/commands/reconcile.js';
import { openFixtureOutcomeClaim } from './outcome-claim-fixture.js';
import { dropSchema, getTestPool } from './testkit/index.js';

const schemas: string[] = [];

function isNormalizedManagedStep(
	step: ProvenPlanStep,
): step is ProvenPlanStep & NormalizedManagedStep {
	return 'plannedClaimKeys' in step && 'statementBundle' in step;
}

function quote(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

async function database(): Promise<string> {
	const result = await getTestPool().then((pool) =>
		pool.query('SELECT current_database() AS database_id'),
	);
	return String(result.rows[0]?.database_id);
}

async function fixture(): Promise<{
	readonly schema: string;
	readonly database: string;
}> {
	const schema = `destructive_generator_${randomUUID().replaceAll('-', '')}`;
	const pool = await getTestPool();
	await pool.query(`CREATE SCHEMA ${quote(schema)}`);
	const preflight = await runPgReinitializePreflight({
		pool,
		schemas: [schema],
		declarations: {
			version: 1,
			digest: `destructive-generator-${schema}`,
			declarations: [],
		},
		writeAdoptionFile: async () => {},
	});
	if (
		preflight.scopes.some(
			(scope) => scope.outcome !== 'current' && scope.outcome !== 'unchanged',
		)
	)
		throw new Error('fixture could not initialize a current ledger lineage');
	schemas.push(schema);
	return { schema, database: await database() };
}

function tableAddress(
	schema: string,
	databaseId: string,
	name: string,
): LedgerAddress {
	return {
		scope: 'schema',
		engine: 'postgresql',
		database: databaseId,
		schema,
		kind: 'table',
		name,
	};
}

function reservation(
	address: LedgerAddress,
	claimId: string,
	claimKind: 'adopt-intent' | 'retire-intent',
): LedgerReservationRow {
	return {
		address,
		claimKind,
		executionId: claimId,
		rootClaimId: claimId,
		homeLedger: { scope: 'schema', schema: address.schema! },
	};
}

async function adopt(address: LedgerAddress): Promise<void> {
	const pool = await getTestPool();
	const claimId = `adopt:${address.name}:${randomUUID()}`;
	const admission = await openFixtureOutcomeClaim(pool, {
		claimId,
		address,
		claimKind: 'adopt-intent',
		statements: ['SELECT 1'],
		reservations: [reservation(address, claimId, 'adopt-intent')],
	});
	if (admission.kind !== 'admitted-outcome-claim')
		throw new Error(admission.reason);
	const live = await readPgCatalogueIdentity(pool, address);
	if (!live?.catalogueIdentity)
		throw new Error(`fixture could not read ${address.name}`);
	await appendPgLedgerResolution(
		pool,
		{ scope: 'schema', schema: address.schema! },
		{
			eventId: `${claimId}:adopted`,
			address,
			eventKind: 'adopt',
			predecessor: claimId,
			catalogueIdentity: live.catalogueIdentity,
			observed: {
				value: { table: address.name },
				digest: `fixture:${address.name}`,
			},
		},
		claimId,
		[reservation(address, claimId, 'adopt-intent')],
	);
}

function generatorPlan(
	change: GeneratorDurablePlan['generator']['changes'][number],
	database?: string,
	schema?: string,
): GeneratorDurablePlan {
	return {
		observations: [],
		claims: [],
		assumptions: [],
		preconditions: [],
		segments: [],
		steps:
			database && schema
				? [
						createPgsqlGeneratedManagedStep({
							change: {
								...change,
								destructive: change.classification !== 'non-destructive',
							} as Parameters<
								typeof createPgsqlGeneratedManagedStep
							>[0]['change'],
							database,
							schema,
							stepKey: 'generator:0',
							order: 0,
							statements: change.statements,
						}),
					]
				: [],
		postconditions: [],
		generator: {
			kind: 'schema-differ-generator',
			changes: [change],
			statements: change.statements,
		},
	} as unknown as GeneratorDurablePlan;
}

async function executeDrop(input: {
	schema: string;
	database: string;
	name: string;
	accepts?: readonly string[];
}) {
	const plan = generatorPlan(
		{
			kind: 'drop_table',
			table: input.name,
			classification: 'removal',
			details: `drop ${input.name}`,
			statements: [`DROP TABLE ${quote(input.schema)}.${quote(input.name)}`],
		},
		input.database,
		input.schema,
	);
	const digest = transitionPlanDigest(plan);
	return executeGeneratorPlan({
		pool: await getTestPool(),
		plan,
		planDigest: digest,
		schema: input.schema,
		...(input.accepts ? { accepts: input.accepts } : {}),
		runId: `generator:${randomUUID()}`,
	});
}

/** Assert topology, not timestamp order: every address is one closed line. */
async function expectSingleChildChain(
	pool: Awaited<ReturnType<typeof getTestPool>>,
	schema: string,
	addressName: string,
	expectedKinds: readonly string[],
): Promise<void> {
	const result = await pool.query<{
		event_id: string;
		event_kind: string;
		predecessor: string | null;
	}>(
		`SELECT event_id, event_kind, predecessor FROM ${quote(schema)}.dbsp_ledger_event WHERE address_name = $1`,
		[addressName],
	);
	const children = new Map<string, string[]>();
	for (const event of result.rows) {
		if (event.predecessor === null) continue;
		const members = children.get(event.predecessor) ?? [];
		members.push(event.event_id);
		children.set(event.predecessor, members);
	}
	expect([...children.values()].every((members) => members.length === 1)).toBe(
		true,
	);
	const roots = result.rows.filter((event) => event.predecessor === null);
	expect(roots).toHaveLength(1);
	const ordered = [] as typeof result.rows;
	let current = roots[0];
	while (current) {
		ordered.push(current);
		const [child] = children.get(current.event_id) ?? [];
		current = child
			? result.rows.find((event) => event.event_id === child)
			: undefined;
	}
	expect(ordered).toHaveLength(result.rows.length);
	expect(ordered.map((event) => event.event_kind)).toEqual(expectedKinds);
}

afterEach(async () => {
	const schema = schemas.pop();
	if (schema) await dropSchema(schema);
});
afterAll(async () => {
	while (schemas.length) await dropSchema(schemas.pop()!);
});

describe.sequential('unit 11 destructive generator authority (SC-46…52)', () => {
	it('SC-46: parent-accounted extension members do not gain per-member reservations', () => {
		const root = tableAddress('public', 'db', 'extension-root');
		const closure = classifyRemovalEffectsClosure({
			root: { ...root, scope: 'database', kind: 'extension', name: 'hstore' },
			effects: [
				{
					address: { ...root, kind: 'undeclarable', name: 'hstore_type' },
					extensionMember: true,
				},
			],
			isManaged: () => false,
		});
		expect(closure.kind).toBe('all-contained-or-managed');
	});

	it('SC-47: absent digest-bound acceptance refuses before DROP and leaves the object present', async () => {
		const { schema, database: databaseId } = await fixture();
		const pool = await getTestPool();
		await pool.query(`CREATE TABLE ${quote(schema)}.victim (id integer)`);
		await adopt(tableAddress(schema, databaseId, 'victim'));
		const result = await executeDrop({
			schema,
			database: databaseId,
			name: 'victim',
		});
		expect(result).toEqual({
			outcome: 'destructive-authority-refused',
			detail: 'operator acceptance is absent',
		});
		await expect(
			pool.query('SELECT to_regclass($1) AS object', [`${schema}.victim`]),
		).resolves.toMatchObject({ rows: [{ object: `${schema}.victim` }] });
	});

	it('SC-48: an unmanaged escaping dependent refuses the whole removal before its statement', () => {
		const root = tableAddress('public', 'db', 'orders');
		const closure = classifyRemovalEffectsClosure({
			root,
			effects: [{ address: { ...root, name: 'external_events' } }],
			isManaged: () => false,
		});
		expect(closure.kind).toBe('reaches-unmanaged');
	});

	it('SC-49: a lossy generated type mutation has no authority without the digest-bound accept', async () => {
		const { schema, database: databaseId } = await fixture();
		const pool = await getTestPool();
		await pool.query(`CREATE TABLE ${quote(schema)}.narrow (value integer)`);
		await pool.query(`INSERT INTO ${quote(schema)}.narrow VALUES (99999)`);
		const address = tableAddress(schema, databaseId, 'narrow');
		const column = {
			...address,
			kind: 'column' as const,
			name: 'value',
			parent: address,
		};
		await adopt(column);
		const plan = generatorPlan(
			{
				kind: 'alter_column_type',
				table: 'narrow',
				column: 'value',
				classification: 'data-destructive',
				details: 'integer to smallint',
				statements: [
					`ALTER TABLE ${quote(schema)}.narrow ALTER COLUMN value TYPE smallint`,
				],
			},
			databaseId,
			schema,
		);
		const result = await executeGeneratorPlan({
			pool,
			plan,
			planDigest: transitionPlanDigest(plan),
			schema,
			runId: `generator:${randomUUID()}`,
		});
		expect(result).toEqual({
			outcome: 'destructive-authority-refused',
			detail: 'operator acceptance is absent',
		});
	});

	it('SC-50: an unrecognised generated mutation is destructive by default', () => {
		expect(classifyGeneratedMutation('future_unclassified_mutation')).toBe(
			'data-destructive',
		);
	});

	it('SC-51: one DROP TABLE claim records root absence after catalogue absence', async () => {
		const { schema, database: databaseId } = await fixture();
		const pool = await getTestPool();
		await pool.query(
			`CREATE TABLE ${quote(schema)}.managed_parent (id serial PRIMARY KEY, obsolete text, payload text); CREATE INDEX managed_parent_payload_idx ON ${quote(schema)}.managed_parent (payload)`,
		);
		const parent = tableAddress(schema, databaseId, 'managed_parent');
		const child = {
			...parent,
			kind: 'column' as const,
			name: 'obsolete',
			parent,
		};
		const identifier = { ...child, name: 'id' };
		await adopt(parent);
		await adopt(identifier);
		await adopt(child);
		const probe = generatorPlan(
			{
				kind: 'drop_table',
				table: 'managed_parent',
				classification: 'removal',
				details: 'drop managed_parent',
				statements: [`DROP TABLE ${quote(schema)}.managed_parent`],
			},
			databaseId,
			schema,
		);
		const digest = transitionPlanDigest(probe);
		const result = await executeGeneratorPlan({
			pool,
			plan: probe,
			planDigest: digest,
			schema,
			accepts: [`destructive-plan-accepted:${digest}`],
			runId: `generator:${randomUUID()}`,
		});
		expect(result).toEqual({ outcome: 'completed' });
		await expect(
			pool.query(
				`SELECT event_kind FROM ${quote(schema)}.dbsp_ledger_event WHERE address_name = 'managed_parent' ORDER BY recorded_at DESC LIMIT 1`,
			),
		).resolves.toMatchObject({ rows: [{ event_kind: 'absent' }] });
		const rootChain = await pool.query<{
			event_id: string;
			event_kind: string;
			predecessor: string | null;
		}>(
			`SELECT event_id, event_kind, predecessor FROM ${quote(schema)}.dbsp_ledger_event WHERE address_name = 'managed_parent' ORDER BY recorded_at`,
		);
		const lifecycle = rootChain.rows.slice(-3);
		expect(lifecycle.map((event) => event.event_kind)).toEqual([
			'retire-intent',
			'executing',
			'absent',
		]);
		expect(lifecycle[1]?.predecessor).toBe(lifecycle[0]?.event_id);
		expect(lifecycle[2]?.predecessor).toBe(lifecycle[1]?.event_id);
		await expectSingleChildChain(pool, schema, 'managed_parent', [
			'adopt-intent',
			'adopt',
			'retire-intent',
			'executing',
			'absent',
		]);
		await expect(
			pool.query(
				`SELECT count(*)::int AS count FROM ${quote(schema)}.dbsp_ledger_reservation WHERE root_claim_id = $1`,
				[lifecycle[0]?.event_id],
			),
		).resolves.toMatchObject({ rows: [{ count: 0 }] });
		await expect(
			pool.query(
				`SELECT event_kind FROM ${quote(schema)}.dbsp_ledger_event WHERE address_name = 'obsolete' ORDER BY recorded_at DESC LIMIT 1`,
			),
		).resolves.toMatchObject({ rows: [{ event_kind: 'absent' }] });
		await expect(
			pool.query(
				`SELECT event_kind FROM ${quote(schema)}.dbsp_ledger_event WHERE address_name = 'id' ORDER BY recorded_at DESC LIMIT 1`,
			),
		).resolves.toMatchObject({ rows: [{ event_kind: 'absent' }] });
	});

	it('SC-52: a persisted generator-removal run refuses replay by id', async () => {
		const pool = await getTestPool();
		const plan = generatorPlan({
			kind: 'drop_table',
			table: 'never_replay',
			classification: 'removal',
			details: 'drop never_replay',
			statements: ['DROP TABLE never_replay'],
		});
		const runId = `dbsp-generator-${randomUUID()}`;
		const digest = transitionPlanDigest(plan);
		await createPgTransitionRunPersister(pool).persist(
			{
				runId,
				planDigest: digest,
				targetContextDigest: 'fixture',
				databaseId: await database(),
				coreVersion: 'fixture',
				startedAt: new Date().toISOString(),
				replayability: 'non-replayable-generator-removal',
			},
			plan,
		);
		await expect(
			runApply(runId, { db: 'postgres://fixture', planDigest: digest }, pool),
		).resolves.toMatchObject({
			outcome: 'non-replayable-generator-run',
			refusal: {
				cause: 'recorded-plan path cannot execute a removal',
				state: 'recorded-plan',
				withheldAuthority: 'recorded-plan removal execution',
				resolvingCommand: 'dbsp apply',
			},
		});
	});

	it('SC-68: reconcile finds an interrupted generator claim by durable run id', async () => {
		const { schema, database: databaseId } = await fixture();
		const pool = await getTestPool();
		await pool.query(
			`CREATE TABLE ${quote(schema)}.interrupted_generator (id integer)`,
		);
		const address = tableAddress(schema, databaseId, 'interrupted_generator');
		await adopt(address);
		const plan = generatorPlan(
			{
				kind: 'drop_table',
				table: address.name,
				classification: 'removal',
				details: 'drop interrupted_generator',
				statements: [`DROP TABLE ${quote(schema)}.${quote(address.name)}`],
			},
			databaseId,
			schema,
		);
		const runId = `dbsp-generator-${randomUUID()}`;
		const planDigest = transitionPlanDigest(plan);
		await createPgTransitionRunPersister(pool).persist(
			{
				runId,
				planDigest,
				targetContextDigest: 'fixture',
				databaseId,
				coreVersion: 'fixture',
				startedAt: new Date().toISOString(),
				replayability: 'non-replayable-generator-removal',
			},
			plan,
		);
		const step = plan.steps[0]!;
		if (!isNormalizedManagedStep(step))
			throw new Error('generator plan step is not normalized');
		const plannedClaimKey = step.plannedClaimKeys[0]!;
		const executionId = `dbsp.generator.execution.${runId}`;
		const claimId = outcomeClaimId(executionId, plannedClaimKey, address);
		const opened = await openFixtureOutcomeClaim(pool, {
			claimId,
			executionId,
			plannedClaimKey,
			address,
			claimKind: 'retire-intent',
			statements: step.statementBundle.statements.map(
				(statement) => statement.sql,
			),
			reservations: [
				{
					address,
					claimKind: 'retire-intent',
					executionId,
					rootClaimId: claimId,
					homeLedger: { scope: 'schema', schema },
				},
			],
		});
		expect(opened.kind).toBe('admitted-outcome-claim');
		await expect(
			runReconcile(runId, { db: 'postgres://fixture' }, pool),
		).resolves.toMatchObject({
			outcome: 'reconcile-completed',
			runId,
			addresses: [expect.objectContaining({ name: address.name })],
		});
		await expect(
			pool.query(
				`SELECT event_kind FROM ${quote(schema)}.dbsp_ledger_event WHERE event_id = $1`,
				[`${claimId}:reconcile:${runId}`],
			),
		).resolves.toMatchObject({ rows: [{ event_kind: 'refused' }] });
	});
});
