/** Unit 12: one shared PostgreSQL container, isolated schemas and pair recovery. */

import { randomUUID } from 'node:crypto';
import {
	appendPgLedgerResolution,
	executePgTableReaddress,
	openPgOutcomeClaim,
	readPgCatalogueIdentity,
	readPgLedgerAddressChain,
	recoverPgReaddressPair,
	renderPgTableReaddressStatements,
	runPgReinitializePreflight,
} from '@dbsp/adapter-pgsql';
import { projectLedgerChain } from '@dbsp/core';
import type {
	LedgerAddress,
	LedgerClaimKind,
	LedgerReservationRow,
} from '@dbsp/types';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { runInspect } from '../../packages/cli/src/commands/inspect.js';
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

function statementBundle(statements: readonly string[]) {
	return {
		statements: statements.map((sql, ordinal) => ({ ordinal, sql })),
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
	const admission = await openPgOutcomeClaim(pool, {
		plan: {
			claimId: input.claimId,
			address: input.address,
			claimKind: input.claimKind,
			statementBundle: statementBundle(input.statements),
			...(input.pairId === undefined ? {} : { pairId: input.pairId }),
		},
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
		statements: [],
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

async function appendInterruptedPair(input: {
	readonly source: LedgerAddress;
	readonly target: LedgerAddress;
	readonly executionId: string;
	readonly pairId: string;
}): Promise<readonly LedgerReservationRow[]> {
	const rows: LedgerReservationRow[] = [];
	for (const [side, value] of [
		['source', input.source],
		['target', input.target],
	] as const) {
		const rootClaimId = `dbsp.readdress.${input.pairId}.${side}.table.${randomUUID().replaceAll('-', '')}`;
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
			statements: renderPgTableReaddressStatements(input.source, input.target),
		});
		rows.push(row);
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
		const result = await executePgTableReaddress(pool, {
			database: databaseId,
			targetSchema: schema,
			executionId: unique('run'),
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
		const result = await executePgTableReaddress(pool, {
			database: databaseId,
			targetSchema: schema,
			executionId: unique('run'),
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
			`SELECT DISTINCT pair_id FROM ${quote(targetSchema)}.dbsp_ledger_event WHERE pair_id = $1`,
			[result.pairId],
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
		const mismatch = await executePgTableReaddress(pool, {
			database: databaseId,
			targetSchema: schema,
			executionId: unique('run'),
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
		const occupied = await executePgTableReaddress(pool, {
			database: databaseId,
			targetSchema: schema,
			executionId: unique('run'),
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

	it('SC-56: re-run is idempotent, a chainless source refuses, and an absent target chain remains appended', async () => {
		const { schema, database: databaseId } = await fixture();
		const pool = await getTestPool();
		await createManagedTable(schema, databaseId, 'repeat_source');
		const request = {
			database: databaseId,
			targetSchema: schema,
			executionId: unique('run'),
			declaration: {
				from: { name: 'repeat_source' },
				to: { name: 'repeat_target' },
			},
		} as const;
		const initial = await executePgTableReaddress(pool, request);
		requireCompleted(initial);
		expect(await executePgTableReaddress(pool, request)).toEqual({
			outcome: 'no-op',
		});
		await pool.query(
			`CREATE TABLE ${quote(schema)}.chainless_target (id integer)`,
		);
		expect(
			await executePgTableReaddress(pool, {
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
		const readdressed = await executePgTableReaddress(pool, {
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
		const refusedRows = await appendInterruptedPair({
			source: address(schema, databaseId, 'recovery_source'),
			target: address(schema, databaseId, 'recovery_target'),
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

	it('SC-58: both refusal details are retained in JSON-shaped output and inspect stays readable', async () => {
		const { schema, database: databaseId } = await fixture();
		const pool = await getTestPool();
		await createManagedTable(schema, databaseId, 'json_source');
		const crossDatabase = await executePgTableReaddress(pool, {
			database: databaseId,
			targetSchema: schema,
			executionId: unique('run'),
			declaration: {
				from: { database: databaseId, name: 'json_source' },
				to: { database: 'other_database', name: 'json_target' },
			},
		});
		await pool.query(`CREATE TABLE ${quote(schema)}.json_target (id integer)`);
		const occupied = await executePgTableReaddress(pool, {
			database: databaseId,
			targetSchema: schema,
			executionId: unique('run'),
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
