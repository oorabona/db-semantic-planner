/** Unit 13: declared adoption, release, reviewed replacement, and schema-move drift. */

import { randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import {
	readPgCatalogueIdentity,
	runPgReinitializePreflight,
} from '@dbsp/adapter-pgsql';
import { appendPgLedgerResolution } from '@dbsp/adapter-pgsql/internal';
import {
	type LedgerAddress,
	type LedgerPayload,
	REFUSAL_VOCABULARY,
} from '@dbsp/types';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
	runApply,
	runNoArgumentApply,
} from '../../packages/cli/src/commands/apply.js';
import {
	type GeneratorDurablePlan,
	runGeneratorPlan,
} from '../../packages/cli/src/commands/generator-plan.js';
import { runInspect } from '../../packages/cli/src/commands/inspect.js';
import type { PlanResult } from '../../packages/cli/src/commands/plan.js';
import { runRelease } from '../../packages/cli/src/commands/release.js';
import { openFixtureOutcomeClaim } from './outcome-claim-fixture.js';
import { dropSchema, getTestPool } from './testkit/index.js';

const schemas: string[] = [];
const schemaFiles: string[] = [];
const generatorSchemaFiles = new WeakMap<object, string>();

function quote(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function unique(subject: string): string {
	return `${subject}_${randomUUID().replaceAll('-', '')}`;
}

async function database(): Promise<string> {
	const result = await (await getTestPool()).query(
		'SELECT current_database() AS database',
	);
	return String(result.rows[0]?.database);
}

function address(
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

function declaration(name: string): LedgerPayload {
	return {
		value: {
			kind: 'table',
			name,
			shape: {
				name,
				columns: [{ name: 'id', type: 'integer', nullable: true }],
			},
		},
		digest: `declared:${name}`,
	};
}

async function fixture(...requested: string[]) {
	const pool = await getTestPool();
	// dbsp_meta is container-scoped. Each sequential scenario starts with no journal.
	await pool.query('DROP SCHEMA IF EXISTS dbsp_meta CASCADE');
	const names = requested.length === 0 ? [unique('unit13')] : requested;
	for (const schema of names) {
		await pool.query(`CREATE SCHEMA ${quote(schema)}`);
		schemas.push(schema);
	}
	const preflight = await runPgReinitializePreflight({
		pool,
		schemas: names,
		declarations: { version: 1, digest: unique('unit13'), declarations: [] },
		writeAdoptionFile: async () => {},
	});
	if (preflight.scopes.some((scope) => scope.outcome === 'failed'))
		throw new Error('fixture could not initialize a current ledger lineage');
	return { pool, database: await database(), schemas: names };
}

/** Setup adopts through an admitted fixture claim; lifecycle assertions use apply below. */
async function adopt(value: LedgerAddress): Promise<void> {
	const pool = await getTestPool();
	const claimId = unique('fixture-adopt');
	const live = await readPgCatalogueIdentity(pool, value);
	if (!live?.catalogueIdentity) throw new Error(`cannot adopt ${value.name}`);
	const reservation = {
		address: value,
		claimKind: 'adopt-intent' as const,
		executionId: claimId,
		rootClaimId: claimId,
		homeLedger: { scope: 'schema' as const, schema: value.schema! },
	};
	const opened = await openFixtureOutcomeClaim(pool, {
		claimId,
		address: value,
		claimKind: 'adopt-intent',
		statements: ['SELECT 1'],
		reservations: [reservation],
	});
	if (opened.kind !== 'admitted-outcome-claim') throw new Error(opened.reason);
	await appendPgLedgerResolution(
		pool,
		{ scope: 'schema', schema: value.schema! },
		{
			eventId: `${claimId}:adopted`,
			address: value,
			eventKind: 'adopt',
			predecessor: claimId,
			catalogueIdentity: live.catalogueIdentity,
			observed: declaration(value.name),
		},
		claimId,
		[reservation],
	);
}

async function schemaFile(
	table: string,
	state: 'adopt' | 'replace',
): Promise<string> {
	const path = `${process.cwd()}/.unit13-${unique(table)}.mjs`;
	await writeFile(
		path,
		`import { schema } from '@dbsp/core';\nexport default schema({ ${table}: { id: 'integer' } }, { ${table}: { ${state}: true } });\n`,
	);
	schemaFiles.push(path);
	return path;
}

async function planFor(input: {
	readonly schema: string;
	readonly table: string;
	readonly state: 'adopt' | 'replace';
}) {
	const file = await schemaFile(input.table, input.state);
	const plan = await runGeneratorPlan({
		db: process.env.DATABASE_URL!,
		schema: input.schema,
		schemaFile: file,
	});
	generatorSchemaFiles.set(plan, file);
	return plan;
}

function generatorPlan(plan: PlanResult): {
	readonly plan: GeneratorDurablePlan;
	readonly planDigest: string;
	readonly runId: string;
	readonly schemaFile: string;
} {
	if (!plan.plan || !plan.planDigest || !plan.runId)
		throw new Error('generator plan was not persisted');
	const file = generatorSchemaFiles.get(plan);
	if (!file) throw new Error('generator plan has no persisted schema fixture');
	return {
		plan: plan.plan as GeneratorDurablePlan,
		planDigest: plan.planDigest,
		runId: plan.runId,
		schemaFile: file,
	};
}

/** Execute only the reviewed, persisted generator run through the public apply path. */
async function applyReviewedGenerator(
	reviewed: ReturnType<typeof generatorPlan>,
	input: {
		readonly accepts?: readonly string[];
		readonly replaces?: readonly string[];
	} = {},
) {
	const applied = await runApply(
		reviewed.runId,
		{
			db: process.env.DATABASE_URL!,
			planDigest: reviewed.planDigest,
			...(input.accepts === undefined ? {} : { accept: input.accepts }),
			...(input.replaces === undefined ? {} : { replace: input.replaces }),
		},
		await getTestPool(),
	);
	if (!('result' in applied))
		throw new Error(
			`apply did not execute reviewed generator run: ${applied.outcome}`,
		);
	return applied.result;
}

/**
 * Generator removals are only executable by no-argument apply's just-persisted
 * review flow.  The callback receives the actual digest before it supplies the
 * explicit acceptance; the fixture never supplies the private removal bridge.
 */
async function applyReviewedReplacement(
	reviewed: ReturnType<typeof generatorPlan>,
	schema: string,
	input: {
		readonly accepts?: boolean;
		readonly replaces?: readonly string[];
	} = {},
) {
	const pool = await getTestPool();
	const applied = await runNoArgumentApply(
		{
			db: process.env.DATABASE_URL!,
			schemaFile: reviewed.schemaFile,
			schema,
			yes: true,
			...(input.replaces === undefined ? {} : { replace: input.replaces }),
		},
		async () => true,
		(runId, options) =>
			runApply(
				runId,
				{
					...options,
					...(input.accepts
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
			`no-argument apply did not execute replacement: ${applied.outcome}`,
		);
	return applied.result &&
		typeof applied.result === 'object' &&
		'result' in applied.result
		? applied.result.result
		: applied.result;
}

async function leaveOpenClaim(
	value: LedgerAddress,
	blocked = false,
): Promise<void> {
	const pool = await getTestPool();
	const claimId = unique(blocked ? 'blocked' : 'pending');
	const reservation = {
		address: value,
		claimKind: 'intent' as const,
		executionId: claimId,
		rootClaimId: claimId,
		homeLedger: { scope: 'schema' as const, schema: value.schema! },
	};
	const opened = await openFixtureOutcomeClaim(pool, {
		claimId,
		address: value,
		claimKind: 'intent',
		statements: ['SELECT 1'],
		reservations: [reservation],
	});
	if (opened.kind !== 'admitted-outcome-claim') throw new Error(opened.reason);
	if (!blocked) return;
	await appendPgLedgerResolution(
		pool,
		{ scope: 'schema', schema: value.schema! },
		{
			eventId: `${claimId}:indeterminate`,
			address: value,
			eventKind: 'indeterminate',
			predecessor: claimId,
		},
		claimId,
		[reservation],
	);
}

afterEach(async () => {
	const pool = await getTestPool();
	await pool.query('DROP SCHEMA IF EXISTS dbsp_meta CASCADE');
	while (schemas.length) await dropSchema(schemas.pop()!);
	while (schemaFiles.length) await unlink(schemaFiles.pop()!).catch(() => {});
});
afterAll(async () => {
	while (schemas.length) await dropSchema(schemas.pop()!);
	while (schemaFiles.length) await unlink(schemaFiles.pop()!).catch(() => {});
});

describe.sequential('unit 13 adoption, release, replacement, and drift (SC-59…62)', () => {
	it('SC-59: a DSL-declared matching table records declaration, shape and identity; it is idempotent and mismatches refuse', async () => {
		const { pool, database: databaseId, schemas: names } = await fixture();
		const schema = names[0]!;
		await pool.query(
			`CREATE TABLE ${quote(schema)}.accounts (id integer PRIMARY KEY)`,
		);
		const plan = await planFor({ schema, table: 'accounts', state: 'adopt' });
		const reviewed = generatorPlan(plan);
		expect(reviewed.plan.generator.changes).toContainEqual(
			expect.objectContaining({ kind: 'adopt_table', table: 'accounts' }),
		);
		await expect(applyReviewedGenerator(reviewed)).resolves.toEqual({
			outcome: 'completed',
		});
		const replay = generatorPlan(
			await planFor({ schema, table: 'accounts', state: 'adopt' }),
		);
		await expect(applyReviewedGenerator(replay)).resolves.toEqual({
			outcome: 'completed',
		});
		await expect(
			pool.query(
				`SELECT event_kind, declared, catalogue_identity FROM ${quote(schema)}.dbsp_ledger_event WHERE address_name = 'accounts' ORDER BY recorded_at`,
			),
		).resolves.toMatchObject({
			rows: expect.arrayContaining([
				expect.objectContaining({
					event_kind: 'adopt-intent',
					declared: expect.anything(),
				}),
				expect.objectContaining({
					event_kind: 'adopt',
					catalogue_identity: expect.anything(),
				}),
			]),
		});

		// Each persisted generator fixture declares one table. Remove the prior
		// adopted fixture so this mismatch run cannot also plan its retirement.
		await pool.query(`DROP TABLE ${quote(schema)}.accounts`);
		await pool.query(`CREATE TABLE ${quote(schema)}.shape_mismatch (id text)`);
		const shape = await planFor({
			schema,
			table: 'shape_mismatch',
			state: 'adopt',
		});
		const reviewedShape = generatorPlan(shape);
		expect(reviewedShape.plan.generator.changes).toContainEqual(
			expect.objectContaining({
				kind: 'adoption_refused',
				table: 'shape_mismatch',
			}),
		);
		await expect(applyReviewedGenerator(reviewedShape)).resolves.toEqual({
			outcome: 'adoption-refused',
			detail:
				'declared adoption for shape_mismatch refuses live shape mismatch',
		});
		await pool.query(`DROP TABLE ${quote(schema)}.shape_mismatch`);
		await pool.query(
			`CREATE TABLE ${quote(schema)}.identity_mismatch (id integer PRIMARY KEY)`,
		);
		const identity = await planFor({
			schema,
			table: 'identity_mismatch',
			state: 'adopt',
		});
		const reviewedIdentity = generatorPlan(identity);
		await pool.query(
			`DROP TABLE ${quote(schema)}.identity_mismatch; CREATE TABLE ${quote(schema)}.identity_mismatch (id integer PRIMARY KEY)`,
		);
		await expect(applyReviewedGenerator(reviewedIdentity)).resolves.toEqual({
			outcome: 'adoption-refused',
			detail:
				'declared adoption for identity_mismatch refuses live identity mismatch',
		});
		await expect(
			pool.query(
				`SELECT count(*)::int AS count FROM ${quote(schema)}.dbsp_ledger_event WHERE address_name = 'identity_mismatch'`,
			),
		).resolves.toMatchObject({ rows: [{ count: 0 }] });
		void databaseId;
	});

	it('SC-60 / OBL-CLI9: release refusals preserve each object; success makes the address unknown', async () => {
		const { pool, database: databaseId, schemas: names } = await fixture();
		const schema = names[0]!;
		for (const name of [
			'pending',
			'blocked',
			'other_controller',
			'lineage',
			'released',
		])
			await pool.query(
				`CREATE TABLE ${quote(schema)}.${quote(name)} (id integer, payload text)`,
			);
		await adopt(address(schema, databaseId, 'pending'));
		await leaveOpenClaim(address(schema, databaseId, 'pending'));
		await pool.query(
			`INSERT INTO ${quote(schema)}.pending VALUES (1, 'pending')`,
		);
		const pendingBefore = await pool.query(
			`SELECT * FROM ${quote(schema)}.pending`,
		);
		await expect(
			runRelease('pending', { db: process.env.DATABASE_URL!, schema }),
		).resolves.toMatchObject({
			outcome: 'release-refused',
			address: address(schema, databaseId, 'pending'),
			detail: REFUSAL_VOCABULARY['ERR-08'].cause,
			refusal: {
				code: 'ERR-08',
				state: 'managed',
				...REFUSAL_VOCABULARY['ERR-08'],
			},
		});
		await expect(
			pool.query(`SELECT * FROM ${quote(schema)}.pending`),
		).resolves.toEqual(pendingBefore);
		await adopt(address(schema, databaseId, 'blocked'));
		await leaveOpenClaim(address(schema, databaseId, 'blocked'), true);
		await pool.query(
			`INSERT INTO ${quote(schema)}.blocked VALUES (2, 'blocked')`,
		);
		const blockedBefore = await pool.query(
			`SELECT * FROM ${quote(schema)}.blocked`,
		);
		await expect(
			runRelease('blocked', { db: process.env.DATABASE_URL!, schema }),
		).resolves.toMatchObject({
			outcome: 'release-refused',
			address: address(schema, databaseId, 'blocked'),
			detail: REFUSAL_VOCABULARY['ERR-08'].cause,
			refusal: {
				code: 'ERR-08',
				state: 'managed',
				...REFUSAL_VOCABULARY['ERR-08'],
			},
		});
		await expect(
			pool.query(`SELECT * FROM ${quote(schema)}.blocked`),
		).resolves.toEqual(blockedBefore);
		await adopt(address(schema, databaseId, 'other_controller'));
		await pool.query(
			`INSERT INTO ${quote(schema)}.other_controller VALUES (3, 'other')`,
		);
		const otherControllerBefore = await pool.query(
			`SELECT * FROM ${quote(schema)}.other_controller`,
		);
		await pool.query(
			`ALTER TABLE ${quote(schema)}.dbsp_ledger_event DISABLE TRIGGER ALL; UPDATE ${quote(schema)}.dbsp_ledger_event SET controller = 'dbsp_other_controller' WHERE address_name = 'other_controller'; ALTER TABLE ${quote(schema)}.dbsp_ledger_event ENABLE TRIGGER ALL`,
		);
		await expect(
			runRelease('other_controller', { db: process.env.DATABASE_URL!, schema }),
		).resolves.toMatchObject({
			outcome: 'release-refused',
			address: address(schema, databaseId, 'other_controller'),
			detail: REFUSAL_VOCABULARY['ERR-05'].cause,
			refusal: {
				code: 'ERR-05',
				state: 'managed',
				...REFUSAL_VOCABULARY['ERR-05'],
			},
		});
		await expect(
			pool.query(`SELECT * FROM ${quote(schema)}.other_controller`),
		).resolves.toEqual(otherControllerBefore);
		await adopt(address(schema, databaseId, 'lineage'));
		await pool.query(
			`INSERT INTO ${quote(schema)}.lineage VALUES (4, 'lineage')`,
		);
		const lineageBefore = await pool.query(
			`SELECT * FROM ${quote(schema)}.lineage`,
		);
		await pool.query(
			`UPDATE ${quote(schema)}.dbsp_ledger_identity SET database_oid = 'lineage-mismatch'`,
		);
		await expect(
			runRelease('lineage', { db: process.env.DATABASE_URL!, schema }),
		).resolves.toMatchObject({
			outcome: 'release-refused',
			address: address(schema, databaseId, 'lineage'),
			detail: REFUSAL_VOCABULARY['ERR-06'].cause,
			refusal: {
				code: 'ERR-06',
				state: 'unknown',
				...REFUSAL_VOCABULARY['ERR-06'],
			},
		});
		await expect(
			pool.query(`SELECT * FROM ${quote(schema)}.lineage`),
		).resolves.toEqual(lineageBefore);
		await pool.query(
			`UPDATE ${quote(schema)}.dbsp_ledger_identity SET database_oid = (SELECT oid::text FROM pg_catalog.pg_database WHERE datname = current_database())`,
		);
		await pool.query(
			`INSERT INTO ${quote(schema)}.released VALUES (7, 'keep')`,
		);
		await adopt(address(schema, databaseId, 'released'));
		const before = await pool.query(`SELECT * FROM ${quote(schema)}.released`);
		await expect(
			runRelease('released', { db: process.env.DATABASE_URL!, schema }),
		).resolves.toEqual({ outcome: 'released' });
		await expect(
			pool.query(`SELECT * FROM ${quote(schema)}.released`),
		).resolves.toEqual(before);
		const released = await runInspect('released', {
			db: process.env.DATABASE_URL!,
			schema,
		});
		const neverSeen = await runInspect('never_seen', {
			db: process.env.DATABASE_URL!,
			schema,
		});
		expect(released.projection).toMatchObject({
			stableState: 'unknown',
			events: expect.arrayContaining([
				expect.objectContaining({ eventKind: 'released' }),
			]),
		});
		expect(neverSeen.projection).toMatchObject({ stableState: 'unknown' });
	});

	it('SC-61: replacement requires a reviewed name, then retires and creates under two claims and tokens', async () => {
		const { pool, database: databaseId, schemas: names } = await fixture();
		const schema = names[0]!;
		await pool.query(`CREATE TABLE ${quote(schema)}.replace_me (id integer)`);
		await adopt(address(schema, databaseId, 'replace_me'));
		const plan = await planFor({
			schema,
			table: 'replace_me',
			state: 'replace',
		});
		const reviewed = generatorPlan(plan);
		await expect(applyReviewedReplacement(reviewed, schema)).resolves.toEqual({
			outcome: 'destructive-authority-refused',
			detail:
				'replacement requires a named --replace selector from the reviewed plan',
		});
		await expect(
			applyReviewedReplacement(reviewed, schema, {
				replaces: ['other_table'],
				accepts: true,
			}),
		).resolves.toEqual({
			outcome: 'destructive-authority-refused',
			detail: 'replacement other_table was not requested by the reviewed plan',
		});
		await expect(
			applyReviewedReplacement(reviewed, schema, {
				replaces: ['replace_me'],
			}),
		).resolves.toEqual({
			outcome: 'destructive-authority-refused',
			detail: 'operator acceptance is absent',
		});
		await expect(
			applyReviewedReplacement(reviewed, schema, {
				replaces: ['replace_me'],
				accepts: true,
			}),
		).resolves.toEqual({ outcome: 'completed' });
		await expect(
			pool.query(
				`SELECT event_kind FROM ${quote(schema)}.dbsp_ledger_event WHERE address_name = 'replace_me' AND event_kind IN ('retire-intent', 'intent')`,
			),
		).resolves.toMatchObject({
			rows: [{ event_kind: 'retire-intent' }, { event_kind: 'intent' }],
		});
		await expect(
			pool.query(
				`SELECT count(DISTINCT event_id) FILTER (WHERE event_kind IN ('retire-intent', 'intent'))::int AS tokens FROM ${quote(schema)}.dbsp_ledger_event WHERE address_name = 'replace_me'`,
			),
		).resolves.toMatchObject({ rows: [{ tokens: 2 }] });
		const lifecycle = await pool.query<{
			event_id: string;
			event_kind: string;
			predecessor: string | null;
		}>(
			`SELECT event_id, event_kind, predecessor FROM ${quote(schema)}.dbsp_ledger_event WHERE address_name = 'replace_me'`,
		);
		const children = new Map<string, string[]>();
		for (const event of lifecycle.rows) {
			if (event.predecessor === null) continue;
			const members = children.get(event.predecessor) ?? [];
			members.push(event.event_id);
			children.set(event.predecessor, members);
		}
		expect(
			[...children.values()].every((members) => members.length === 1),
		).toBe(true);
		const roots = lifecycle.rows.filter((event) => event.predecessor === null);
		expect(roots).toHaveLength(1);
		const ordered = [] as typeof lifecycle.rows;
		let current = roots[0];
		while (current) {
			ordered.push(current);
			const [child] = children.get(current.event_id) ?? [];
			current = child
				? lifecycle.rows.find((event) => event.event_id === child)
				: undefined;
		}
		expect(ordered).toHaveLength(lifecycle.rows.length);
		expect(ordered.map((event) => event.event_kind)).toEqual([
			'adopt-intent',
			'adopt',
			'retire-intent',
			'executing',
			'absent',
			'intent',
			'observed',
		]);
	});

	it('SC-62: an out-of-band SET SCHEMA is drift in both reviewed scopes and neither adoption proceeds while the source claim stands', async () => {
		const source = unique('source');
		const target = unique('target');
		const { pool, database: databaseId } = await fixture(source, target);
		await pool.query(
			`CREATE TABLE ${quote(source)}.moved (id integer PRIMARY KEY)`,
		);
		const sourcePlan = await planFor({
			schema: source,
			table: 'moved',
			state: 'adopt',
		});
		const targetPlan = await planFor({
			schema: target,
			table: 'moved',
			state: 'adopt',
		});
		await leaveOpenClaim(address(source, databaseId, 'moved'));
		await pool.query(
			`ALTER TABLE ${quote(source)}.moved SET SCHEMA ${quote(target)}`,
		);
		const reviewedSource = generatorPlan(sourcePlan);
		const reviewedTarget = generatorPlan(targetPlan);
		expect(reviewedSource.plan.generator.changes).toContainEqual(
			expect.objectContaining({ kind: 'adopt_table', table: 'moved' }),
		);
		expect(reviewedTarget.plan.generator.changes).toContainEqual(
			expect.objectContaining({ kind: 'adoption_refused', table: 'moved' }),
		);
		await expect(applyReviewedGenerator(reviewedSource)).resolves.toMatchObject(
			{
				outcome: 'adoption-refused',
				detail: expect.stringContaining('shape mismatch'),
			},
		);
		await expect(applyReviewedGenerator(reviewedTarget)).resolves.toMatchObject(
			{
				outcome: 'adoption-refused',
				detail: expect.stringContaining('shape mismatch'),
			},
		);
		// Both reviewed scopes retain their pre-move refusal; the source claim is
		// still open, and neither scope may append an adoption while the drift is
		// unresolved.
		await expect(
			pool.query(
				`SELECT count(*) FILTER (WHERE event_kind = 'adopt')::int AS adopted, count(*) FILTER (WHERE event_kind = 'intent')::int AS open_claims FROM ${quote(source)}.dbsp_ledger_event WHERE address_name = 'moved'`,
			),
		).resolves.toMatchObject({ rows: [{ adopted: 0, open_claims: 1 }] });
		await expect(
			pool.query(
				`SELECT count(*)::int AS adopted FROM ${quote(target)}.dbsp_ledger_event WHERE address_name = 'moved' AND event_kind = 'adopt'`,
			),
		).resolves.toMatchObject({ rows: [{ adopted: 0 }] });
	});
});
