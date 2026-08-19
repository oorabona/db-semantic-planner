/** Unit 12: one shared PostgreSQL container, isolated schemas and pair recovery. */

import { randomUUID } from 'node:crypto';
import {
	acquirePgLedgerLocks,
	createPgsqlGeneratedManagedStep,
	createPgTransitionRunPersister,
	readPgCatalogueIdentity,
	readPgLedgerAddressChain,
	readPgLedgerReservationsForExecution,
	recoverPgReaddressPair,
	renderPgTableReaddressStatements,
	runPgReinitializePreflight,
} from '@dbsp/adapter-pgsql';
import {
	appendPgLedgerResolution,
	recoverPgAdmittedReaddressPair,
} from '@dbsp/adapter-pgsql/internal';
import { projectLedgerChain, transitionPlanDigest } from '@dbsp/core';
import type {
	LedgerAddress,
	LedgerClaimKind,
	LedgerReservationRow,
	TableReaddressDeclaration,
} from '@dbsp/types';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { runApply } from '../../packages/cli/src/commands/apply.js';
import type { GeneratorDurablePlan } from '../../packages/cli/src/commands/generator-plan.js';
import { runInspect } from '../../packages/cli/src/commands/inspect.js';
import { openFixtureOutcomeClaim } from './outcome-claim-fixture.js';
import { dropSchema, getTestPool } from './testkit/index.js';

const schemas: string[] = [];

function quote(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function unique(subject: string): string {
	return `${subject}_${randomUUID().replaceAll('-', '')}`;
}

async function database(): Promise<string> {
	const pool = await getTestPool();
	const result = await pool.query('SELECT current_database() AS database');
	return String(result.rows[0]?.database);
}

function address(
	schema: string,
	databaseId: string,
	name: string,
	kind: LedgerAddress['kind'] = 'table',
	parent?: LedgerAddress,
): LedgerAddress {
	return {
		scope: 'schema',
		engine: 'postgresql',
		database: databaseId,
		schema,
		kind,
		name,
		...(parent === undefined ? {} : { parent }),
	};
}

function reservation(
	value: LedgerAddress,
	executionId: string,
	pairId: string,
	rootClaimId: string,
): LedgerReservationRow {
	return {
		address: value,
		claimKind: 'readdress-intent',
		executionId,
		pairId,
		rootClaimId,
		homeLedger: { scope: 'schema', schema: value.schema! },
	};
}

async function admitFixtureOutcomeClaim(input: {
	readonly claimId: string;
	readonly address: LedgerAddress;
	readonly claimKind: LedgerClaimKind;
	readonly statements: readonly string[];
	readonly executionId?: string;
	readonly pairId?: string;
	readonly rootClaimId?: string;
}): Promise<void> {
	const pool = await getTestPool();
	const rootClaimId = input.rootClaimId ?? input.claimId;
	const admission = await openFixtureOutcomeClaim(pool, {
		claimId: input.claimId,
		address: input.address,
		claimKind: input.claimKind,
		statements: input.statements,
		...(input.pairId === undefined ? {} : { pairId: input.pairId }),
		reservations: [
			{
				address: input.address,
				claimKind: input.claimKind,
				executionId: input.executionId ?? input.claimId,
				rootClaimId,
				...(input.pairId === undefined ? {} : { pairId: input.pairId }),
				homeLedger: { scope: 'schema', schema: input.address.schema! },
			},
		],
	});
	if (admission.kind !== 'admitted-outcome-claim')
		throw new Error(admission.reason);
}

function requireCompleted<T extends { readonly outcome: string }>(
	result: T,
): asserts result is T & {
	readonly outcome: 'completed';
	readonly pairId: string;
} {
	if (result.outcome !== 'completed')
		throw new Error(
			`expected re-address to complete; received ${JSON.stringify(result)}`,
		);
}

async function fixture(): Promise<{ schema: string; database: string }> {
	const schema = unique('readdress');
	const pool = await getTestPool();
	// dbsp_meta is shared by the container; every scenario starts with no run journal.
	await pool.query('DROP SCHEMA IF EXISTS dbsp_meta CASCADE');
	await pool.query(`CREATE SCHEMA ${quote(schema)}`);
	const databaseId = await database();
	const preflight = await runPgReinitializePreflight({
		pool,
		schemas: [schema],
		declarations: {
			version: 1,
			digest: `readdress-${schema}`,
			declarations: [],
		},
		writeAdoptionFile: async () => {},
	});
	if (preflight.scopes.some((scope) => scope.outcome === 'failed'))
		throw new Error('fixture could not initialize the schema ledger');
	schemas.push(schema);
	return { schema, database: databaseId };
}

async function adopt(value: LedgerAddress): Promise<void> {
	const pool = await getTestPool();
	const claimId = `adopt:${value.kind}:${value.name}:${randomUUID()}`;
	await admitFixtureOutcomeClaim({
		claimId,
		address: value,
		claimKind: 'adopt-intent',
		statements: ['SELECT 1'],
	});
	const live = await readPgCatalogueIdentity(pool, value);
	if (!live?.catalogueIdentity) throw new Error(`cannot adopt ${value.name}`);
	await appendPgLedgerResolution(
		pool,
		{ scope: 'schema', schema: value.schema! },
		{
			eventId: `${claimId}:adopted`,
			address: value,
			eventKind: 'adopt',
			predecessor: claimId,
			catalogueIdentity: live.catalogueIdentity,
			observed: {
				value: { subject: value.name },
				digest: `adopt:${value.name}`,
			},
		},
		claimId,
		[{ address: value }],
	);
}

async function createManagedTable(
	schema: string,
	databaseId: string,
	name: string,
): Promise<readonly LedgerAddress[]> {
	const pool = await getTestPool();
	await pool.query(
		`CREATE TABLE ${quote(schema)}.${quote(name)} (id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, payload bytea NOT NULL)`,
	);
	const table = address(schema, databaseId, name);
	const members = [
		table,
		address(schema, databaseId, 'id', 'column', table),
		address(schema, databaseId, 'payload', 'column', table),
		address(schema, databaseId, `${name}_pkey`, 'index', table),
		address(schema, databaseId, `${name}_pkey`, 'constraint', table),
		address(schema, databaseId, `${name}_id_seq`, 'sequence', table),
	];
	for (const member of members) await adopt(member);
	return members;
}

/**
 * Persist the exact paired lifecycle step, then execute it through apply.
 * No E2E driver mints a lifecycle witness or calls the readdress executor.
 */
async function applyPersistedReaddress(input: {
	readonly database: string;
	readonly targetSchema: string;
	readonly declaration: TableReaddressDeclaration;
	readonly corruptPersistedMaterial?: 'substitute-step' | 'remove-steps';
}) {
	const pool = await getTestPool();
	const sourceName = input.declaration.from.name;
	const step = createPgsqlGeneratedManagedStep({
		change: {
			kind: 'readdress_table',
			table: sourceName,
			details: `readdress ${sourceName}`,
			meta: { readdress: input.declaration },
		} as never,
		database: input.database,
		schema: input.targetSchema,
		stepKey: 'generator:0',
		order: 0,
		statements: renderPgTableReaddressStatements(
			address(
				input.declaration.from.schema ?? input.targetSchema,
				input.declaration.from.database ?? input.database,
				input.declaration.from.name,
			),
			address(
				input.declaration.to.schema ?? input.targetSchema,
				input.declaration.to.database ?? input.database,
				input.declaration.to.name,
			),
		),
	});
	Object.assign(step, {
		classification: 'paired-readdress',
		claimKind: 'readdress-intent',
		selection: { kind: 'readdress', selector: `table:${sourceName}` },
		lifecycle: { kind: 'readdress', declaration: input.declaration },
	});
	const plan = {
		observations: [],
		claims: [],
		assumptions: [],
		preconditions: [],
		segments: [],
		steps: [step],
		postconditions: [],
		generator: {
			kind: 'schema-differ-generator',
			planningSchema: input.targetSchema,
			changes: [
				{
					kind: 'readdress_table',
					table: sourceName,
					classification: 'paired-readdress',
					details: `readdress ${sourceName}`,
					statements: [],
					readdress: input.declaration,
				},
			],
		},
	} as unknown as GeneratorDurablePlan;
	const runId = unique('persisted-readdress');
	const planDigest = transitionPlanDigest(plan);
	await createPgTransitionRunPersister(pool).persist(
		{
			runId,
			planDigest,
			targetContextDigest: `fixture:${input.database}:${input.targetSchema}`,
			databaseId: input.database,
			coreVersion: 'readdress-e2e',
			startedAt: new Date().toISOString(),
			replayability: 'replayable',
		},
		plan as never,
	);
	if (input.corruptPersistedMaterial === 'substitute-step')
		await pool.query(
			`UPDATE dbsp_meta.dbsp_transition_run_plan SET plan = jsonb_set(plan, '{steps,0,statementBundle}', '{"statements":["SELECT 0"]}'::jsonb) WHERE run_id = $1`,
			[runId],
		);
	if (input.corruptPersistedMaterial === 'remove-steps')
		await pool.query(
			`UPDATE dbsp_meta.dbsp_transition_run_plan SET plan = plan - 'steps' WHERE run_id = $1`,
			[runId],
		);
	const applied = await runApply(
		runId,
		{ db: process.env.DATABASE_URL!, planDigest },
		pool,
	);
	if (!('result' in applied))
		throw new Error(
			`apply did not execute persisted readdress: ${applied.outcome}`,
		);
	if (input.corruptPersistedMaterial !== undefined) return applied;
	return applied.result as unknown as {
		readonly outcome: string;
		readonly detail?: string;
		readonly pairId?: string;
	};
}

async function appendInterruptedPair(input: {
	readonly source: LedgerAddress;
	readonly target: LedgerAddress;
	readonly executionId: string;
	readonly pairId: string;
	/** A real table closure may place children before the declared table root. */
	readonly members?: readonly {
		readonly source: LedgerAddress;
		readonly target: LedgerAddress;
	}[];
}): Promise<readonly LedgerReservationRow[]> {
	const rows: LedgerReservationRow[] = [];
	for (const member of input.members ?? [input]) {
		for (const [side, value] of [
			['source', member.source],
			['target', member.target],
		] as const) {
			const rootClaimId = `dbsp.readdress.${input.pairId}.${side}.${value.kind}.${randomUUID().replaceAll('-', '')}`;
			const row = reservation(
				value,
				input.executionId,
				input.pairId,
				rootClaimId,
			);
			await admitFixtureOutcomeClaim({
				claimId: rootClaimId,
				address: value,
				claimKind: 'readdress-intent',
				pairId: input.pairId,
				executionId: input.executionId,
				statements: renderPgTableReaddressStatements(
					input.source,
					input.target,
				),
			});
			rows.push(row);
		}
	}
	return rows;
}

afterEach(async () => {
	const pool = await getTestPool();
	await pool.query('DROP SCHEMA IF EXISTS dbsp_meta CASCADE');
	while (schemas.length) await dropSchema(schemas.pop()!);
});
afterAll(async () => {
	while (schemas.length) await dropSchema(schemas.pop()!);
});

describe.sequential('unit 12 re-address recovery (SC-53…58)', () => {
	it('OBL-LOCK3: severing a paired recovery append acknowledgement reports ambiguity and leaves the durable refusals inspectable', async () => {
		const { schema, database: databaseId } = await fixture();
		const pool = await getTestPool();
		await createManagedTable(schema, databaseId, 'ambiguous_pair_source');
		const rows = await appendInterruptedPair({
			source: address(schema, databaseId, 'ambiguous_pair_source'),
			target: address(schema, databaseId, 'ambiguous_pair_target'),
			executionId: unique('run'),
			pairId: unique('pair'),
		});
		const pairId = rows[0]?.pairId;
		const executionId = rows[0]?.executionId;
		if (!pairId || !executionId) throw new Error('fixture pair is incomplete');
		await expect(
			recoverPgAdmittedReaddressPair(pool, {
				pairId,
				executionId,
				reservations: rows,
				assess: async () => ({
					kind: 'refused',
					reason: 'verified untouched pair',
				}),
				observer: (point) => {
					if (point === 'commit-acknowledged')
						throw new Error('simulated lost COMMIT acknowledgement');
				},
			}),
		).resolves.toMatchObject({ kind: 'outcome-transport-ambiguous' });
		for (const row of rows) {
			const chain = await readPgLedgerAddressChain(
				pool,
				row.homeLedger,
				row.address,
			);
			expect(chain.terminalMember).toMatchObject({ eventKind: 'refused' });
		}
	});

	it('resolves every paired recovery terminal under one held advisory-lock transaction', async () => {
		const { schema, database: databaseId } = await fixture();
		const pool = await getTestPool();
		await createManagedTable(schema, databaseId, 'atomic_pair_source');
		const rows = await appendInterruptedPair({
			source: address(schema, databaseId, 'atomic_pair_source'),
			target: address(schema, databaseId, 'atomic_pair_target'),
			executionId: unique('run'),
			pairId: unique('pair'),
		});
		const pairId = rows[0]?.pairId;
		const executionId = rows[0]?.executionId;
		if (!pairId || !executionId) throw new Error('fixture pair is incomplete');
		const probe = await pool.connect();
		try {
			await expect(
				recoverPgAdmittedReaddressPair(pool, {
					pairId,
					executionId,
					reservations: rows,
					assess: async () => {
						await probe.query('BEGIN');
						try {
							const lock = await acquirePgLedgerLocks(
								probe,
								rows.map((row) => row.homeLedger),
							);
							expect(lock.kind).toBe('busy');
						} finally {
							await probe.query('ROLLBACK');
						}
						return { kind: 'refused', reason: 'verified untouched pair' };
					},
				}),
			).resolves.toMatchObject({ kind: 'refused' });
			for (const row of rows) {
				const chain = await readPgLedgerAddressChain(
					pool,
					row.homeLedger,
					row.address,
				);
				expect(chain.terminalMember).toMatchObject({ eventKind: 'refused' });
			}
		} finally {
			probe.release();
		}
	});

	it('SC-53: rename retains rows, closes the source chain, roots the target, and preserves existing bytes', async () => {
		const { schema, database: databaseId } = await fixture();
		const pool = await getTestPool();
		await createManagedTable(schema, databaseId, 'source');
		await pool.query(
			`INSERT INTO ${quote(schema)}.source (payload) VALUES (decode('00ff', 'hex'))`,
		);
		const before = await pool.query(
			`SELECT id, encode(payload, 'hex') AS payload FROM ${quote(schema)}.source`,
		);
		const result = await applyPersistedReaddress({
			database: databaseId,
			targetSchema: schema,
			declaration: { from: { name: 'source' }, to: { name: 'renamed' } },
		});
		requireCompleted(result);
		const after = await pool.query(
			`SELECT id, encode(payload, 'hex') AS payload FROM ${quote(schema)}.renamed`,
		);
		expect(after.rows).toEqual(before.rows);
		const source = await readPgLedgerAddressChain(
			pool,
			{ scope: 'schema', schema },
			address(schema, databaseId, 'source'),
		);
		const target = await readPgLedgerAddressChain(
			pool,
			{ scope: 'schema', schema },
			address(schema, databaseId, 'renamed'),
		);
		expect(source.terminalMember?.eventKind).toBe('readdressed-to');
		expect(target.terminalMember?.eventKind).toBe('readdressed-from');
		expect(projectLedgerChain(target).kind).toBe('projected-ledger-chain');
	});

	it('SC-54: cross-schema move carries the table, index, owned sequence, and one pair id', async () => {
		const { schema, database: databaseId } = await fixture();
		const targetSchema = unique('readdress_target');
		const pool = await getTestPool();
		await pool.query(`CREATE SCHEMA ${quote(targetSchema)}`);
		schemas.push(targetSchema);
		await runPgReinitializePreflight({
			pool,
			schemas: [targetSchema],
			declarations: { version: 1, digest: targetSchema, declarations: [] },
			writeAdoptionFile: async () => {},
		});
		await createManagedTable(schema, databaseId, 'moved');
		const result = await applyPersistedReaddress({
			database: databaseId,
			targetSchema: schema,
			declaration: {
				from: { schema, name: 'moved' },
				to: { schema: targetSchema, name: 'moved' },
			},
		});
		requireCompleted(result);
		await expect(
			pool.query('SELECT to_regclass($1) AS object', [`${targetSchema}.moved`]),
		).resolves.toMatchObject({ rows: [{ object: `${targetSchema}.moved` }] });
		await expect(
			pool.query('SELECT to_regclass($1) AS object', [
				`${targetSchema}.moved_pkey`,
			]),
		).resolves.toMatchObject({
			rows: [{ object: `${targetSchema}.moved_pkey` }],
		});
		await expect(
			pool.query('SELECT to_regclass($1) AS object', [
				`${targetSchema}.moved_id_seq`,
			]),
		).resolves.toMatchObject({
			rows: [{ object: `${targetSchema}.moved_id_seq` }],
		});
		const pairs = await pool.query(
			`SELECT DISTINCT pair_id FROM ${quote(targetSchema)}.dbsp_ledger_event WHERE pair_id IS NOT NULL`,
		);
		expect(pairs.rows).toHaveLength(1);
	});

	it('SC-55: identity mismatch and an occupied target refuse before DDL', async () => {
		const { schema, database: databaseId } = await fixture();
		const pool = await getTestPool();
		await createManagedTable(schema, databaseId, 'identity_source');
		await pool.query(
			`DROP TABLE ${quote(schema)}.identity_source; CREATE TABLE ${quote(schema)}.identity_source (id bigint PRIMARY KEY, payload bytea NOT NULL)`,
		);
		const mismatch = await applyPersistedReaddress({
			database: databaseId,
			targetSchema: schema,
			declaration: {
				from: { name: 'identity_source' },
				to: { name: 'identity_target' },
			},
		});
		expect(mismatch).toMatchObject({
			outcome: 'readdress-refused',
			detail: expect.stringContaining('source identity mismatch'),
		});
		await expect(
			pool.query('SELECT to_regclass($1) AS object', [
				`${schema}.identity_source`,
			]),
		).resolves.toMatchObject({
			rows: [{ object: `${schema}.identity_source` }],
		});
		await createManagedTable(schema, databaseId, 'occupied_source');
		await pool.query(
			`CREATE TABLE ${quote(schema)}.occupied_target (id integer)`,
		);
		const occupied = await applyPersistedReaddress({
			database: databaseId,
			targetSchema: schema,
			declaration: {
				from: { name: 'occupied_source' },
				to: { name: 'occupied_target' },
			},
		});
		expect(occupied).toEqual({
			outcome: 'readdress-refused',
			detail: 'target occupied_target is occupied',
		});
	});

	it('OBL-LIFE1: apply refuses substituted and absent persisted readdress material before DDL', async () => {
		for (const [name, corruptPersistedMaterial, error] of [
			[
				'substituted_step',
				'substitute-step',
				'persisted generator manifest is invalid',
			],
			[
				'absent_step',
				'remove-steps',
				'dbsp transition run plan row is invalid and non-resumable',
			],
		] as const) {
			const { schema, database: databaseId } = await fixture();
			const pool = await getTestPool();
			const target = `${name}_target`;
			await createManagedTable(schema, databaseId, name);
			await expect(
				applyPersistedReaddress({
					database: databaseId,
					targetSchema: schema,
					declaration: { from: { name }, to: { name: target } },
					corruptPersistedMaterial,
				}),
			).resolves.toMatchObject({
				outcome: 'plan-digest-mismatch',
				result: {
					assessment: {
						reasons: [{ detail: expect.stringContaining(error) }],
					},
				},
			});
			await expect(
				pool.query(
					'SELECT to_regclass($1) AS source, to_regclass($2) AS target',
					[`${schema}.${name}`, `${schema}.${target}`],
				),
			).resolves.toMatchObject({
				rows: [{ source: `${schema}.${name}`, target: null }],
			});
		}
	});

	it('OBL-LIFE4: apply refuses cross-database, non-table, and escaping-dependent readdresses', async () => {
		const { schema, database: databaseId } = await fixture();
		const pool = await getTestPool();
		await createManagedTable(schema, databaseId, 'bounded_source');
		await expect(
			applyPersistedReaddress({
				database: databaseId,
				targetSchema: schema,
				declaration: {
					from: { database: databaseId, name: 'bounded_source' },
					to: { database: 'other_database', name: 'bounded_target' },
				},
			}),
		).resolves.toMatchObject({
			outcome: 'readdress-unsupported',
			detail: 'cross-database',
		});
		await expect(
			applyPersistedReaddress({
				database: databaseId,
				targetSchema: schema,
				declaration: {
					from: { kind: 'index', name: 'bounded_source' },
					to: { kind: 'index', name: 'bounded_target' },
				},
			}),
		).resolves.toMatchObject({
			outcome: 'readdress-unsupported',
			detail: 'unsupported-kind index',
		});
		await pool.query(
			`CREATE TABLE ${quote(schema)}.bounded_escape (source_id bigint REFERENCES ${quote(schema)}.bounded_source(id))`,
		);
		await expect(
			applyPersistedReaddress({
				database: databaseId,
				targetSchema: schema,
				declaration: {
					from: { name: 'bounded_source' },
					to: { name: 'bounded_target' },
				},
			}),
		).resolves.toMatchObject({
			outcome: 'readdress-refused',
			detail: expect.stringContaining('escaping dependent'),
		});
	});

	it('SC-56: re-run is idempotent, a chainless source refuses, and an absent target chain remains appended', async () => {
		const { schema, database: databaseId } = await fixture();
		const pool = await getTestPool();
		await createManagedTable(schema, databaseId, 'repeat_source');
		const request = {
			database: databaseId,
			targetSchema: schema,
			declaration: {
				from: { name: 'repeat_source' },
				to: { name: 'repeat_target' },
			},
		} as const;
		const initial = await applyPersistedReaddress(request);
		requireCompleted(initial);
		const beforeRepeat = await readPgLedgerAddressChain(
			pool,
			{ scope: 'schema', schema },
			address(schema, databaseId, 'repeat_target'),
		);
		// The generator reports its aggregate outcome as completed; the paired
		// lifecycle itself is a no-op, so it must append no second target claim.
		expect(await applyPersistedReaddress(request)).toEqual({
			outcome: 'completed',
		});
		const afterRepeat = await readPgLedgerAddressChain(
			pool,
			{ scope: 'schema', schema },
			address(schema, databaseId, 'repeat_target'),
		);
		expect(afterRepeat.events).toHaveLength(beforeRepeat.events.length);
		await pool.query(
			`CREATE TABLE ${quote(schema)}.chainless_target (id integer)`,
		);
		expect(
			await applyPersistedReaddress({
				...request,
				declaration: {
					from: { name: 'chainless_source' },
					to: { name: 'chainless_target' },
				},
			}),
		).toEqual({
			outcome: 'readdress-refused',
			detail: 'source chainless_source has no re-address chain',
		});
		const retiredMembers = await createManagedTable(
			schema,
			databaseId,
			'retired_target',
		);
		const retired = address(schema, databaseId, 'retired_target');
		const retirements: { member: LedgerAddress; claimId: string }[] = [];
		const retirementStatements = [`DROP TABLE ${quote(schema)}.retired_target`];
		for (const member of retiredMembers) {
			const claimId = `retire:${member.kind}:${member.name}:${randomUUID()}`;
			await admitFixtureOutcomeClaim({
				claimId,
				address: member,
				claimKind: 'retire-intent',
				statements: retirementStatements,
			});
			retirements.push({ member, claimId });
		}
		await pool.query(`DROP TABLE ${quote(schema)}.retired_target`);
		for (const { member, claimId } of retirements) {
			await appendPgLedgerResolution(
				pool,
				{ scope: 'schema', schema },
				{
					eventId: `${claimId}:absent`,
					address: member,
					eventKind: 'absent',
					predecessor: claimId,
				},
				claimId,
				[{ address: member }],
			);
		}
		const prior = (
			await readPgLedgerAddressChain(pool, { scope: 'schema', schema }, retired)
		).terminalMember?.eventId;
		await createManagedTable(schema, databaseId, 'retired_source');
		const readdressed = await applyPersistedReaddress({
			...request,
			declaration: {
				from: { name: 'retired_source' },
				to: { name: 'retired_target' },
			},
		});
		requireCompleted(readdressed);
		const target = await readPgLedgerAddressChain(
			pool,
			{ scope: 'schema', schema },
			retired,
		);
		expect(target.events.some((event) => event.predecessor === prior)).toBe(
			true,
		);
	});

	it('SC-57: fabricated interrupted pairs classify whole closures as refused, pending, or indeterminate', async () => {
		const { schema, database: databaseId } = await fixture();
		const pool = await getTestPool();
		await createManagedTable(schema, databaseId, 'recovery_source');
		const recoverySource = address(schema, databaseId, 'recovery_source');
		const recoveryTarget = address(schema, databaseId, 'recovery_target');
		const refusedRows = await appendInterruptedPair({
			source: recoverySource,
			target: recoveryTarget,
			executionId: unique('run'),
			pairId: unique('pair'),
		});
		expect(
			await recoverPgReaddressPair(pool, {
				pairId: refusedRows[0]!.pairId!,
				executionId: refusedRows[0]!.executionId,
				reservations: refusedRows,
			}),
		).toMatchObject({ kind: 'readdress-recovery-refused-pair' });
		const recoveredRoot = await readPgLedgerAddressChain(
			pool,
			{ scope: 'schema', schema },
			recoverySource,
		);
		expect(recoveredRoot.terminalMember).toMatchObject({
			address: recoverySource,
			eventKind: 'refused',
			pairId: refusedRows[0]!.pairId,
		});
		await createManagedTable(schema, databaseId, 'indeterminate_source');
		await pool.query(
			`CREATE TABLE ${quote(schema)}.indeterminate_target (id integer)`,
		);
		const indeterminateRows = await appendInterruptedPair({
			source: address(schema, databaseId, 'indeterminate_source'),
			target: address(schema, databaseId, 'indeterminate_target'),
			executionId: unique('run'),
			pairId: unique('pair'),
		});
		expect(
			await recoverPgReaddressPair(pool, {
				pairId: indeterminateRows[0]!.pairId!,
				executionId: indeterminateRows[0]!.executionId,
				reservations: indeterminateRows,
			}),
		).toMatchObject({ kind: 'readdress-recovery-indeterminate-pair' });
		for (const row of indeterminateRows) {
			const chain = await readPgLedgerAddressChain(
				pool,
				{ scope: 'schema', schema },
				row.address,
			);
			expect(chain.terminalMember).toMatchObject({
				eventKind: 'indeterminate',
				predecessor: row.rootClaimId,
			});
		}
		expect(
			await readPgLedgerReservationsForExecution(
				pool,
				{ scope: 'schema', schema },
				indeterminateRows[0]!.executionId,
			),
		).toHaveLength(indeterminateRows.length);
		await createManagedTable(schema, databaseId, 'pending_source');
		const pendingTarget = address(schema, databaseId, 'pending_target', 'view');
		const pendingRows = await appendInterruptedPair({
			source: address(schema, databaseId, 'pending_source'),
			target: pendingTarget,
			executionId: unique('run'),
			pairId: unique('pair'),
		});
		expect(
			await recoverPgReaddressPair(pool, {
				pairId: pendingRows[0]!.pairId!,
				executionId: pendingRows[0]!.executionId,
				reservations: pendingRows,
			}),
		).toMatchObject({ kind: 'readdress-recovery-pending-pair' });
		const inspected = await runInspect('table:pending_source', {
			db: process.env.DATABASE_URL!,
			schema,
			format: 'json',
		});
		expect(JSON.stringify(inspected)).toContain('readdressPair');
	});

	it('OBL-REC2: paired recovery over a half-applied rename reissues no DDL', async () => {
		const { schema, database: databaseId } = await fixture();
		const pool = await getTestPool();
		await createManagedTable(schema, databaseId, 'half_applied_source');
		const rows = await appendInterruptedPair({
			source: address(schema, databaseId, 'half_applied_source'),
			target: address(schema, databaseId, 'half_applied_target'),
			executionId: unique('run'),
			pairId: unique('pair'),
		});

		// Simulate the sole physical rename having landed before the process died.
		// Recovery must classify this from the durable pair and live catalogue; it
		// must never attempt to send the rename bundle a second time.
		await pool.query(
			`ALTER TABLE ${quote(schema)}.half_applied_source RENAME TO half_applied_target`,
		);
		const statements: string[] = [];
		const captured = {
			query<Row extends Record<string, unknown> = Record<string, unknown>>(
				text: string,
				values?: readonly unknown[],
			) {
				statements.push(text);
				return values === undefined
					? pool.query<Row>(text)
					: pool.query<Row>(text, [...values]);
			},
		};

		await expect(
			recoverPgReaddressPair(captured, {
				pairId: rows[0]!.pairId!,
				executionId: rows[0]!.executionId,
				reservations: rows,
			}),
		).resolves.toMatchObject({ kind: 'readdress-recovery-indeterminate-pair' });
		expect(statements.join('\n')).not.toMatch(/\b(?:ALTER|CREATE|DROP)\b/iu);
		for (const row of rows) {
			const chain = await readPgLedgerAddressChain(
				pool,
				row.homeLedger,
				row.address,
			);
			expect(chain.terminalMember).toMatchObject({
				eventKind: 'indeterminate',
				predecessor: row.rootClaimId,
			});
		}
	});

	it('SC-58: both refusal details are retained in JSON-shaped output and inspect stays readable', async () => {
		const { schema, database: databaseId } = await fixture();
		const pool = await getTestPool();
		await createManagedTable(schema, databaseId, 'json_source');
		const crossDatabase = await applyPersistedReaddress({
			database: databaseId,
			targetSchema: schema,
			declaration: {
				from: { database: databaseId, name: 'json_source' },
				to: { database: 'other_database', name: 'json_target' },
			},
		});
		await pool.query(`CREATE TABLE ${quote(schema)}.json_target (id integer)`);
		const occupied = await applyPersistedReaddress({
			database: databaseId,
			targetSchema: schema,
			declaration: {
				from: { name: 'json_source' },
				to: { name: 'json_target' },
			},
		});
		expect(JSON.stringify(crossDatabase)).toContain('cross-database');
		expect(JSON.stringify(occupied)).toContain(
			'target json_target is occupied',
		);
		const inspected = await runInspect('table:json_source', {
			db: process.env.DATABASE_URL!,
			schema,
			format: 'json',
		});
		expect(JSON.stringify(inspected)).toContain('json_source');
	});
});
