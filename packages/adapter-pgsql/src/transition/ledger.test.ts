import type { LedgerChainMember, LedgerReservationRow } from '@dbsp/types';
import { describe, expect, it, vi } from 'vitest';
import {
	acquirePgLedgerLocks,
	appendPgLedgerClaim,
	appendPgLedgerResolution,
	ensurePgLedger,
	PgLedgerStorageUnsupportedError,
	renderCreateLedgerEventTableSql,
} from './ledger.js';

const target = { scope: 'schema', schema: 'tenant_a' } as const;

const claim: Omit<LedgerChainMember, 'controller' | 'recordedAt'> = {
	eventId: 'claim-1',
	address: {
		scope: 'schema',
		engine: 'postgresql',
		database: 'app',
		schema: 'tenant_a',
		kind: 'table',
		name: 'accounts',
	},
	eventKind: 'intent',
};

const reservation: LedgerReservationRow = {
	address: claim.address,
	claimKind: 'intent',
	executionId: 'execution-1',
	rootClaimId: 'claim-1',
	homeLedger: target,
};

describe('managed ledger storage', () => {
	it('renders the closed, same-address append-only chain shape', () => {
		const sql = renderCreateLedgerEventTableSql(target);
		expect(sql).toContain('UNIQUE NULLS NOT DISTINCT');
		expect(sql).toContain('FOREIGN KEY (address_engine, address_database');
		expect(sql).toContain('REFERENCES "tenant_a"."dbsp_ledger_event"');
		expect(sql).toContain("'readdressed-from'");
		expect(sql).not.toContain('sequence');
	});

	it('declares and proves PG 15 before ledger DDL', async () => {
		const query = vi.fn(async (sql: string) =>
			sql === 'SHOW server_version_num'
				? { rows: [{ server_version_num: '140000' }] }
				: { rows: [] },
		);
		await expect(ensurePgLedger({ query }, target)).rejects.toBeInstanceOf(
			PgLedgerStorageUnsupportedError,
		);
		expect(query).toHaveBeenCalledOnce();
	});

	it('records the shape marker after creating every additive table', async () => {
		const query = vi.fn(async (sql: string) =>
			sql === 'SHOW server_version_num'
				? { rows: [{ server_version_num: '150000' }] }
				: { rows: [] },
		);
		await ensurePgLedger({ query }, target);
		const sql = query.mock.calls.map(([value]) => String(value)).join('\n');
		expect(sql).toContain('dbsp_ledger_reservation');
		expect(sql).toContain('dbsp_ledger_identity');
		expect(sql).toContain('dbsp_ledger_marker');
		expect(sql).toContain('dbsp_ledger_event_immutable');
		expect(sql).toContain('INSERT INTO "tenant_a"."dbsp_ledger_marker"');
	});

	it('can defer the marker for the reinitialize-preflight final step', async () => {
		const query = vi.fn(async (sql: string) =>
			sql === 'SHOW server_version_num'
				? { rows: [{ server_version_num: '150000' }] }
				: { rows: [] },
		);
		await ensurePgLedger({ query }, target, { writeMarker: false });
		expect(
			query.mock.calls.some(([sql]) =>
				String(sql).includes('INSERT INTO "tenant_a"."dbsp_ledger_marker"'),
			),
		).toBe(false);
	});

	it('makes a claim append and its closure reservations one statement', async () => {
		const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({
			rows: [],
		}));
		await appendPgLedgerClaim({ query }, target, claim, [reservation]);
		expect(query).toHaveBeenCalledOnce();
		expect(query.mock.calls[0]?.[0]).toContain('WITH appended AS');
		expect(query.mock.calls[0]?.[0]).toContain(
			'INSERT INTO "tenant_a"."dbsp_ledger_reservation"',
		);
	});

	it('makes a resolution append and its reservation release one statement', async () => {
		const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({
			rows: [],
		}));
		await appendPgLedgerResolution(
			{ query },
			target,
			{
				...claim,
				eventId: 'observed-1',
				eventKind: 'observed',
				predecessor: 'claim-1',
			},
			'claim-1',
			[reservation],
		);
		expect(query).toHaveBeenCalledOnce();
		expect(query.mock.calls[0]?.[0]).toContain('WITH appended AS');
		expect(query.mock.calls[0]?.[0]).toContain('DELETE FROM');
	});

	it('binds the reservation root after every expanded event value', async () => {
		const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({
			rows: [],
		}));
		await appendPgLedgerResolution(
			{ query },
			target,
			{
				...claim,
				eventId: 'observed-with-provenance',
				eventKind: 'observed',
				predecessor: 'claim-1',
				executionId: 'execution-1',
				plannedClaimKey: 'step:1/root',
				claimGroupId: 'claim-1',
				rootClaimId: 'claim-1',
			},
			'claim-1',
			[reservation],
		);
		const [sql, params] = query.mock.calls[0] ?? [];
		expect(String(sql)).toContain('r.root_claim_id = $20');
		expect(params?.[19]).toBe('claim-1');
	});

	it('locks dbsp_meta before schema names and turns a lock error into a refusal', async () => {
		const query = vi.fn(async () => ({ rows: [{ locked: true }] }));
		await expect(
			acquirePgLedgerLocks({ query }, [
				{ scope: 'schema', schema: 'zeta' },
				{ scope: 'database' },
				{ scope: 'schema', schema: 'alpha' },
			]),
		).resolves.toEqual({ kind: 'acquired' });
		expect(query).toHaveBeenCalledTimes(3);

		const failing = new Error('lock permission denied');
		await expect(
			acquirePgLedgerLocks({ query: async () => Promise.reject(failing) }, [
				{ scope: 'database' },
			]),
		).resolves.toEqual({
			kind: 'refused',
			ledger: { scope: 'database' },
			error: failing,
		});
	});
});
