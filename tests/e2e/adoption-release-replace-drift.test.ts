/** Unit 13: declared adoption, release, reviewed replacement, and schema-move drift. */

import { randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import {
	executePgDeclaredAdoption,
	readPgCatalogueIdentity,
	runPgReinitializePreflight,
} from '@dbsp/adapter-pgsql';
import { appendPgLedgerResolution } from '@dbsp/adapter-pgsql/internal';
import type { LedgerAddress, LedgerPayload } from '@dbsp/types';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { executeGeneratorPlan } from '../../packages/cli/src/commands/generator-execution.js';
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

/** The only fixture adoption path uses the production token-gated executor. */
async function adopt(value: LedgerAddress): Promise<void> {
	const pool = await getTestPool();
	const live = await readPgCatalogueIdentity(pool, value);
	if (!live?.catalogueIdentity) throw new Error(`cannot adopt ${value.name}`);
	const result = await executePgDeclaredAdoption({
		executor: pool,
		home: { scope: 'schema', schema: value.schema! },
		address: value,
		declaration: declaration(value.name),
		expectedCatalogueIdentity: live.catalogueIdentity,
		shapeMatches: async () => true,
		executionId: unique('adopt'),
	} as never);
	if (result.outcome !== 'completed')
		throw new Error(
			`fixture adoption refused: ${
				result.outcome === 'adoption-refused' ? result.detail : result.outcome
			}`,
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
	return runGeneratorPlan({
		db: process.env.DATABASE_URL!,
		schema: input.schema,
		schemaFile: await schemaFile(input.table, input.state),
	});
}

function generatorPlan(plan: PlanResult): {
	readonly plan: GeneratorDurablePlan;
	readonly planDigest: string;
	readonly runId: string;
} {
	if (!plan.plan || !plan.planDigest || !plan.runId)
		throw new Error('generator plan was not persisted');
	return {
		plan: plan.plan as GeneratorDurablePlan,
		planDigest: plan.planDigest,
		runId: plan.runId,
	};
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
		await expect(
			executeGeneratorPlan({
				pool,
				plan: reviewed.plan,
				planDigest: reviewed.planDigest,
				schema,
				runId: reviewed.runId,
			}),
		).resolves.toEqual({ outcome: 'completed' });
		await expect(
			executeGeneratorPlan({
				pool,
				plan: reviewed.plan,
				planDigest: reviewed.planDigest,
				schema,
				runId: unique('repeat'),
			}),
		).resolves.toEqual({ outcome: 'completed' });
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
		await expect(
			executeGeneratorPlan({
				pool,
				plan: reviewedShape.plan,
				planDigest: reviewedShape.planDigest,
				schema,
				runId: reviewedShape.runId,
			}),
		).resolves.toEqual({
			outcome: 'adoption-refused',
			detail:
				'declared adoption for shape_mismatch refuses live shape mismatch',
		});
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
		await expect(
			executeGeneratorPlan({
				pool,
				plan: reviewedIdentity.plan,
				planDigest: reviewedIdentity.planDigest,
				schema,
				runId: reviewedIdentity.runId,
			}),
		).resolves.toEqual({
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

	it('SC-60: release refuses pending, blocked, another controller and lineage mismatch; success preserves the object and makes the address unknown', async () => {
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
		await expect(
			runRelease('pending', { db: process.env.DATABASE_URL!, schema }),
		).resolves.toMatchObject({
			outcome: 'release-refused',
			detail: 'release refuses pending address pending',
		});
		await adopt(address(schema, databaseId, 'blocked'));
		await leaveOpenClaim(address(schema, databaseId, 'blocked'), true);
		await expect(
			runRelease('blocked', { db: process.env.DATABASE_URL!, schema }),
		).resolves.toMatchObject({
			outcome: 'release-refused',
			detail: 'release refuses blocked address blocked',
		});
		await adopt(address(schema, databaseId, 'other_controller'));
		await pool.query(
			`ALTER TABLE ${quote(schema)}.dbsp_ledger_event DISABLE TRIGGER ALL; UPDATE ${quote(schema)}.dbsp_ledger_event SET controller = 'dbsp_other_controller' WHERE address_name = 'other_controller'; ALTER TABLE ${quote(schema)}.dbsp_ledger_event ENABLE TRIGGER ALL`,
		);
		await expect(
			runRelease('other_controller', { db: process.env.DATABASE_URL!, schema }),
		).resolves.toMatchObject({
			outcome: 'release-refused',
			detail: expect.stringContaining('address owned by dbsp_other_controller'),
		});
		await adopt(address(schema, databaseId, 'lineage'));
		await pool.query(
			`UPDATE ${quote(schema)}.dbsp_ledger_identity SET database_oid = 'lineage-mismatch'`,
		);
		await expect(
			runRelease('lineage', { db: process.env.DATABASE_URL!, schema }),
		).resolves.toMatchObject({
			outcome: 'release-refused',
			detail: 'release refuses lineage not-current',
		});
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
		await expect(
			executeGeneratorPlan({
				pool,
				plan: reviewed.plan,
				planDigest: reviewed.planDigest,
				schema,
				runId: reviewed.runId,
			}),
		).resolves.toEqual({
			outcome: 'destructive-authority-refused',
			detail:
				'replacement requires a named --replace selector from the reviewed plan',
		});
		await expect(
			executeGeneratorPlan({
				pool,
				plan: reviewed.plan,
				planDigest: reviewed.planDigest,
				schema,
				replaces: ['other_table'],
				accepts: [`destructive-plan-accepted:${reviewed.planDigest}`],
				runId: reviewed.runId,
			}),
		).resolves.toEqual({
			outcome: 'destructive-authority-refused',
			detail: 'replacement other_table was not requested by the reviewed plan',
		});
		await expect(
			executeGeneratorPlan({
				pool,
				plan: reviewed.plan,
				planDigest: reviewed.planDigest,
				schema,
				replaces: ['replace_me'],
				runId: unique('replace-unaccepted'),
			}),
		).resolves.toEqual({
			outcome: 'destructive-authority-refused',
			detail: 'operator acceptance is absent',
		});
		await expect(
			executeGeneratorPlan({
				pool,
				plan: reviewed.plan,
				planDigest: reviewed.planDigest,
				schema,
				replaces: ['replace_me'],
				accepts: [`destructive-plan-accepted:${reviewed.planDigest}`],
				runId: unique('replace'),
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
		await expect(
			executeGeneratorPlan({
				pool,
				plan: reviewedSource.plan,
				planDigest: reviewedSource.planDigest,
				schema: source,
				runId: reviewedSource.runId,
			}),
		).resolves.toMatchObject({
			outcome: 'adoption-refused',
			detail: expect.stringContaining('shape mismatch'),
		});
		await expect(
			executeGeneratorPlan({
				pool,
				plan: reviewedTarget.plan,
				planDigest: reviewedTarget.planDigest,
				schema: target,
				runId: reviewedTarget.runId,
			}),
		).resolves.toMatchObject({
			outcome: 'adoption-refused',
			detail: expect.stringContaining('shape mismatch'),
		});
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
