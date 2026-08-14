/** Unit 11: one shared sequential PostgreSQL container, isolated schemas. */

import { randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import {
	classifyGeneratedMutation,
	classifyRemovalEffectsClosure,
	createPgsqlGeneratedManagedStep,
	createPgTransitionRunPersister,
	readPgCatalogueIdentity,
	readPgRemovalEffectsClosure,
	runPgReinitializePreflight,
} from '@dbsp/adapter-pgsql';
import {
	appendPgLedgerResolution,
	lockPgJournalRun,
} from '@dbsp/adapter-pgsql/internal';
import { outcomeClaimId, transitionPlanDigest } from '@dbsp/core';
import { mintDurablyLoadedRun } from '@dbsp/core/internal';
import type {
	LedgerAddress,
	LedgerReservationRow,
	NormalizedManagedStep,
	ProvenPlanStep,
} from '@dbsp/types';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
	runApply,
	runNoArgumentApply,
} from '../../packages/cli/src/commands/apply.js';
import { executeGeneratorPlan } from '../../packages/cli/src/commands/generator-execution.js';
import type { GeneratorDurablePlan } from '../../packages/cli/src/commands/generator-plan.js';
import { runReconcile } from '../../packages/cli/src/commands/reconcile.js';
import { openFixtureOutcomeClaim } from './outcome-claim-fixture.js';
import { dropSchema, getTestPool } from './testkit/index.js';

const schemas: string[] = [];
const schemaFiles: string[] = [];

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
			...(schema === undefined ? {} : { planningSchema: schema }),
			changes: [change],
			statements: change.statements,
		},
	} as unknown as GeneratorDurablePlan;
}

async function applyPersistedGenerator(input: {
	readonly plan: GeneratorDurablePlan;
	readonly database: string;
	readonly schema: string;
	readonly accepts?: readonly string[];
}) {
	const pool = await getTestPool();
	const runId = `generator:${randomUUID()}`;
	const planDigest = transitionPlanDigest(input.plan);
	await createPgTransitionRunPersister(pool).persist(
		{
			runId,
			planDigest,
			targetContextDigest: `fixture:${input.database}:${input.schema}`,
			databaseId: input.database,
			coreVersion: 'destructive-generator-e2e',
			startedAt: new Date().toISOString(),
			replayability: 'replayable',
		},
		input.plan,
	);
	const applied = await runApply(
		runId,
		{
			db: process.env.DATABASE_URL!,
			planDigest,
			...(input.accepts === undefined ? {} : { accept: input.accepts }),
		},
		pool,
	);
	if (!('result' in applied))
		throw new Error(
			`apply did not execute persisted generator run: ${applied.outcome}`,
		);
	return applied.result;
}

async function executeDrop(input: {
	schema: string;
	database: string;
	name: string;
	accepts?: readonly string[];
}) {
	const path = `${process.cwd()}/.unit11-${randomUUID()}.mjs`;
	await writeFile(
		path,
		"import { schema } from '@dbsp/core';\nexport default schema({});\n",
	);
	schemaFiles.push(path);
	const pool = await getTestPool();
	const applied = await runNoArgumentApply(
		{
			db: process.env.DATABASE_URL!,
			schemaFile: path,
			schema: input.schema,
			yes: true,
		},
		async () => true,
		(runId, options) =>
			runApply(
				runId,
				{
					...options,
					...(input.accepts?.length
						? {
								accept: [
									...(options.accept ?? []),
									`destructive-plan-accepted:${options.planDigest}`,
								],
							}
						: {}),
				},
				pool,
			),
	);
	if (!('result' in applied))
		throw new Error(
			`no-argument apply did not execute removal: ${applied.outcome}`,
		);
	return applied.result &&
		typeof applied.result === 'object' &&
		'result' in applied.result
		? applied.result.result
		: applied.result;
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
	while (schemaFiles.length) await unlink(schemaFiles.pop()!).catch(() => {});
});
afterAll(async () => {
	while (schemas.length) await dropSchema(schemas.pop()!);
	while (schemaFiles.length) await unlink(schemaFiles.pop()!).catch(() => {});
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

	it('OBL-AUTH8 operator acceptance: absent digest-bound acceptance names its withheld authority before DROP', async () => {
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
			refusal: {
				withheldAuthority: 'destructive operator acceptance authority',
			},
		});
		await expect(
			pool.query('SELECT to_regclass($1) AS object', [`${schema}.victim`]),
		).resolves.toMatchObject({ rows: [{ object: `${schema}.victim` }] });
	});

	it.each([
		[
			'ownership',
			async (
				pool: Awaited<ReturnType<typeof getTestPool>>,
				address: LedgerAddress,
			) => {
				// Deliberately leave the live table outside the ledger.
				void pool;
				void address;
			},
			'destructive ownership authority',
		],
		[
			'catalogue identity',
			async (
				pool: Awaited<ReturnType<typeof getTestPool>>,
				address: LedgerAddress,
			) => {
				await adopt(address);
				await pool.query(
					`DROP TABLE ${quote(address.schema!)}.${quote(address.name)}; CREATE TABLE ${quote(address.schema!)}.${quote(address.name)} (id integer)`,
				);
			},
			'destructive catalogue identity authority',
		],
		[
			'ledger lineage',
			async (
				pool: Awaited<ReturnType<typeof getTestPool>>,
				address: LedgerAddress,
			) => {
				await adopt(address);
				await pool.query(
					`UPDATE ${quote(address.schema!)}.dbsp_ledger_identity SET database_oid = '0' WHERE id = true`,
				);
			},
			'destructive ledger lineage authority',
		],
	] as const)('OBL-AUTH8 %s: public generated removal refuses with the withheld-authority tuple', async (_axis, arrange, withheldAuthority) => {
		const { schema, database: databaseId } = await fixture();
		const pool = await getTestPool();
		const name = `auth8_${randomUUID().replaceAll('-', '')}`;
		const address = tableAddress(schema, databaseId, name);
		await pool.query(
			`CREATE TABLE ${quote(schema)}.${quote(name)} (id integer)`,
		);
		await arrange(pool, address);
		await expect(
			executeDrop({
				schema,
				database: databaseId,
				name,
				accepts: ['accept'],
			}),
		).resolves.toMatchObject({
			outcome: 'destructive-authority-refused',
			refusal: { withheldAuthority },
		});
		await expect(
			pool.query('SELECT to_regclass($1) AS object', [`${schema}.${name}`]),
		).resolves.toMatchObject({ rows: [{ object: `${schema}.${name}` }] });
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
		const result = await applyPersistedGenerator({
			plan,
			database: databaseId,
			schema,
		});
		expect(result).toMatchObject({
			outcome: 'destructive-authority-refused',
			detail: 'operator acceptance is absent',
			refusal: {
				withheldAuthority: 'destructive operator acceptance authority',
			},
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
		const result = await executeDrop({
			schema,
			database: databaseId,
			name: 'managed_parent',
			accepts: ['accept'],
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

	it('OBL-RUN6: a public caller cannot forge the private generator-removal bridge', async () => {
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
		const forgedPublicOptions = {
			db: 'postgres://fixture',
			planDigest: digest,
			// Hostile JavaScript can add the historic private field even though
			// ApplyOptions does not expose it. The exported surface must ignore it.
			freshGeneratorRemovalRunId: runId,
		} as unknown as Parameters<typeof runApply>[1];
		await expect(
			runApply(runId, forgedPublicOptions, pool),
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

	it('OBL-CTRL4 / OBL-AUTH8 containment: a superuser-planted pg_catalog dependent is positive unmanaged evidence and no removal DDL is issued', async () => {
		const { schema, database: databaseId } = await fixture();
		const pool = await getTestPool();
		const rootName = `obl_ctrl4_root_${randomUUID().replaceAll('-', '')}`;
		const plantedName = `dbsp_obl_ctrl4_${randomUUID().replaceAll('-', '')}`;
		const root = tableAddress(schema, databaseId, rootName);
		try {
			await pool.query(
				`CREATE TABLE ${quote(schema)}.${quote(rootName)} (id integer PRIMARY KEY)`,
			);
			await adopt(root);
			// The e2e role is a superuser.  This deliberately proves that a system
			// schema location is not silently promoted to dbsp ownership.
			await pool.query('SET allow_system_table_mods = on');
			await pool.query(
				`CREATE TABLE pg_catalog.${quote(plantedName)} (root_id integer REFERENCES ${quote(schema)}.${quote(rootName)}(id))`,
			);
			const live = await readPgCatalogueIdentity(pool, root);
			if (!live?.catalogueIdentity)
				throw new Error('OBL-CTRL4 fixture root identity is unreadable');
			const closure = await readPgRemovalEffectsClosure({
				executor: pool,
				root: { ...root, catalogueIdentity: live.catalogueIdentity },
				isManaged: async () => false,
			});
			expect(['reaches-unmanaged', 'undecidable']).toContain(closure.kind);
			if (closure.kind === 'reaches-unmanaged')
				expect(closure.unmanaged).toMatchObject({
					schema: 'pg_catalog',
					name: plantedName,
				});
			// Drive the public generator-removal surface all the way to the
			// authority decision.  Reading the closure alone is not sufficient:
			// the command must retain the containment refusal and must not turn the
			// planned DROP into DDL.
			const refused = await executeDrop({
				schema,
				database: databaseId,
				name: rootName,
				accepts: ['accept'],
			});
			expect(refused).toMatchObject({
				outcome: 'destructive-authority-refused',
				detail: expect.stringMatching(/containment|unmanaged|undecidable/i),
				refusal: {
					withheldAuthority: 'destructive containment authority',
				},
			});
			await expect(
				pool.query('SELECT to_regclass($1) AS root', [`${schema}.${rootName}`]),
			).resolves.toMatchObject({ rows: [{ root: `${schema}.${rootName}` }] });
		} finally {
			await pool
				.query('SET allow_system_table_mods = on')
				.catch(() => undefined);
			await pool
				.query(`DROP TABLE IF EXISTS pg_catalog.${quote(plantedName)}`)
				.catch(() => undefined);
		}
	});

	it('OBL-AUTH10: a dependent added at the post-lock admission checkpoint changes the containment closure and refuses before DROP', async () => {
		const { schema, database: databaseId } = await fixture();
		const pool = await getTestPool();
		const rootName = `obl_auth10_root_${randomUUID().replaceAll('-', '')}`;
		const dependentName = `obl_auth10_dependent_${randomUUID().replaceAll('-', '')}`;
		const root = tableAddress(schema, databaseId, rootName);
		await pool.query(
			`CREATE TABLE ${quote(schema)}.${quote(rootName)} (id integer PRIMARY KEY)`,
		);
		await adopt(root);
		const plan = generatorPlan(
			{
				kind: 'drop_table',
				table: rootName,
				classification: 'removal',
				details: 'checkpointed destructive removal',
				statements: [`DROP TABLE ${quote(schema)}.${quote(rootName)}`],
			},
			databaseId,
			schema,
		);
		const planDigest = transitionPlanDigest(plan);
		const runId = `obl-auth10:${randomUUID()}`;
		const run = lockPgJournalRun(
			mintDurablyLoadedRun({
				runId,
				planDigest,
				targetContextDigest: `checkpoint:${schema}`,
				databaseId,
				coreVersion: 'checkpoint-e2e',
				startedAt: new Date().toISOString(),
				replayability: 'replayable',
			}),
		);
		let reached: (() => void) | undefined;
		const atAdmission = new Promise<void>((resolve) => {
			reached = resolve;
		});
		let release: (() => void) | undefined;
		const continueAdmission = new Promise<void>((resolve) => {
			release = resolve;
		});
		const running = executeGeneratorPlan({
			pool,
			plan,
			planDigest,
			schema,
			run,
			runId,
			accepts: [`destructive-plan-accepted:${planDigest}`],
			observer: async (point) => {
				if (point !== 'post-lock-integrity-before-append') return;
				reached?.();
				await continueAdmission;
			},
		});
		await atAdmission;
		await pool.query(
			`CREATE TABLE ${quote(schema)}.${quote(dependentName)} (root_id integer REFERENCES ${quote(schema)}.${quote(rootName)}(id))`,
		);
		release?.();
		await expect(running).resolves.toMatchObject({
			outcome: 'destructive-authority-refused',
			detail: expect.stringMatching(/containment.*undecidable/i),
			refusal: { withheldAuthority: 'destructive containment authority' },
		});
		await expect(
			pool.query('SELECT to_regclass($1) AS object', [`${schema}.${rootName}`]),
		).resolves.toMatchObject({ rows: [{ object: `${schema}.${rootName}` }] });
	});

	it('OBL-AUTH5: destructive executing and group-terminal appends each reach the post-lock integrity checkpoint', async () => {
		const { schema, database: databaseId } = await fixture();
		const pool = await getTestPool();
		const rootName = `obl_auth5_root_${randomUUID().replaceAll('-', '')}`;
		const root = tableAddress(schema, databaseId, rootName);
		await pool.query(
			`CREATE TABLE ${quote(schema)}.${quote(rootName)} (id integer PRIMARY KEY)`,
		);
		await adopt(root);
		const plan = generatorPlan(
			{
				kind: 'drop_table',
				table: rootName,
				classification: 'removal',
				details: 'checkpointed destructive removal',
				statements: [`DROP TABLE ${quote(schema)}.${quote(rootName)}`],
			},
			databaseId,
			schema,
		);
		const planDigest = transitionPlanDigest(plan);
		const runId = `obl-auth5:${randomUUID()}`;
		const run = lockPgJournalRun(
			mintDurablyLoadedRun({
				runId,
				planDigest,
				targetContextDigest: `checkpoint:${schema}`,
				databaseId,
				coreVersion: 'checkpoint-e2e',
				startedAt: new Date().toISOString(),
				replayability: 'replayable',
			}),
		);
		const checkpoints: string[] = [];
		const result = await executeGeneratorPlan({
			pool,
			plan,
			planDigest,
			schema,
			run,
			runId,
			accepts: [`destructive-plan-accepted:${planDigest}`],
			observer: async (point) => {
				checkpoints.push(point);
			},
		});
		expect(result).toEqual({ outcome: 'completed' });
		expect(checkpoints).toEqual([
			'post-lock-integrity-before-append',
			'commit-acknowledged',
			'post-lock-integrity-before-append',
			'commit-acknowledged',
			'ddl-completed-before-read-back',
			'post-lock-integrity-before-append',
			'commit-acknowledged',
		]);
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
