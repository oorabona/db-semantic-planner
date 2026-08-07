import {
	appendPgLedgerClaim,
	appendPgLedgerResolution,
	compareSchemata,
	ensurePgLedger,
	introspect,
	readPgLedgerAddressChain,
} from '@dbsp/adapter-pgsql';
import { projectLedgerChain } from '@dbsp/core';
import type {
	LedgerAddress,
	LedgerChainMember,
	LedgerReservationRow,
} from '@dbsp/types';
import { afterEach, describe, expect, it } from 'vitest';
import { dropSchema, getTestPool } from './testkit/index.js';

const schemas: string[] = [];

function quoteIdent(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function address(schema: string, name = 'accounts'): LedgerAddress {
	return {
		scope: 'schema',
		engine: 'postgresql',
		database: 'e2e',
		schema,
		kind: 'table',
		name,
	};
}

function event(
	eventId: string,
	eventKind: LedgerChainMember['eventKind'],
	addressValue: LedgerAddress,
	predecessor?: string,
): LedgerChainMember {
	return {
		eventId,
		address: addressValue,
		eventKind,
		...(predecessor === undefined ? {} : { predecessor }),
		controller: 'deployment',
	};
}

afterEach(async () => {
	for (const schema of schemas.splice(0)) await dropSchema(schema);
});

describe('SC-27 and SC-28 #481 ledger projections', () => {
	it('reports stable state alongside pending and blocked, while refusals preserve it', () => {
		const value = address('fixture');
		const managed = [
			event('adopt-intent', 'adopt-intent', value),
			{
				...event('adopt', 'adopt', value, 'adopt-intent'),
				observed: { value: { table: 'accounts' }, digest: 'observed' },
			},
		];
		const pending = projectLedgerChain({
			ledger: { scope: 'schema', schema: 'fixture' },
			address: value,
			events: [...managed, event('intent', 'intent', value, 'adopt')],
		});
		const blocked = projectLedgerChain({
			ledger: { scope: 'schema', schema: 'fixture' },
			address: value,
			events: [
				...managed,
				event('intent', 'intent', value, 'adopt'),
				event('indeterminate', 'indeterminate', value, 'intent'),
			],
		});
		const refusedModification = projectLedgerChain({
			ledger: { scope: 'schema', schema: 'fixture' },
			address: value,
			events: [
				...managed,
				event('intent', 'intent', value, 'adopt'),
				event('refused', 'refused', value, 'intent'),
			],
		});
		const refusedCreation = projectLedgerChain({
			ledger: { scope: 'schema', schema: 'fixture' },
			address: value,
			events: [
				event('intent', 'intent', value),
				event('refused', 'refused', value, 'intent'),
			],
		});

		for (const [result, state] of [
			[pending, 'pending'],
			[blocked, 'blocked'],
			[refusedModification, 'managed'],
			[refusedCreation, 'unknown'],
		] as const) {
			expect(result.kind).toBe('projected-ledger-chain');
			if (result.kind === 'projected-ledger-chain')
				expect(result.reportedState.kind).toBe(state);
		}
		if (pending.kind === 'projected-ledger-chain') {
			expect(pending.reportedState).toMatchObject({
				kind: 'pending',
				stableState: 'managed',
				claim: { kind: 'intent' },
			});
		}
	});
});

describe('SC-29 #481 malformed projections', () => {
	it('keeps malformed chains inspectable as structured values', () => {
		const value = address('fixture');
		const result = projectLedgerChain({
			ledger: { scope: 'schema', schema: 'fixture' },
			address: value,
			events: [
				event('one', 'intent', value, 'two'),
				event('two', 'refused', value, 'one'),
			],
		});
		expect(result).toMatchObject({
			kind: 'unprojectable-ledger-chain',
			reason: { code: 'cycle' },
			address: value,
		});
	});
});

describe('SC-31 #481 live drift is not persisted', () => {
	it('keeps a recorded observation unchanged after an outside ALTER while live comparison reports drift', async () => {
		const schema = `ledger_projection_${Date.now().toString(36)}`;
		schemas.push(schema);
		const pool = await getTestPool();
		await pool.query(`CREATE SCHEMA ${quoteIdent(schema)}`);
		await pool.query(
			`CREATE TABLE ${quoteIdent(schema)}.${quoteIdent('accounts')} (id integer PRIMARY KEY)`,
		);
		const target = { scope: 'schema', schema } as const;
		const value = address(schema);
		const claim = {
			eventId: 'adopt-intent',
			address: value,
			eventKind: 'adopt-intent' as const,
			declared: {
				value: { table: 'accounts', columns: ['id'] },
				digest: 'declared-v1',
			},
		};
		const reservation: LedgerReservationRow = {
			address: value,
			claimKind: 'adopt-intent',
			executionId: 'execution',
			rootClaimId: claim.eventId,
			homeLedger: target,
		};
		await ensurePgLedger(pool, target);
		await appendPgLedgerClaim(pool, target, claim, [reservation]);
		await appendPgLedgerResolution(
			pool,
			target,
			{
				...claim,
				eventId: 'adopt',
				eventKind: 'adopt',
				predecessor: claim.eventId,
				observed: {
					value: { table: 'accounts', columns: ['id'] },
					digest: 'observed-v1',
				},
			},
			claim.eventId,
			[reservation],
		);
		const declaredModel = await introspect(pool, { schema });
		await pool.query(
			`ALTER TABLE ${quoteIdent(schema)}.${quoteIdent('accounts')} ADD COLUMN outside_change text`,
		);
		const liveModel = await introspect(pool, { schema });
		const chain = await readPgLedgerAddressChain(pool, target, value);
		const projection = projectLedgerChain(chain);

		expect(compareSchemata(declaredModel, liveModel).changes).not.toHaveLength(
			0,
		);
		expect(projection).toMatchObject({
			kind: 'projected-ledger-chain',
			observation: { digest: 'observed-v1' },
			declaration: { digest: 'declared-v1' },
		});
	});
});
