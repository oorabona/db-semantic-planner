import type { LedgerChainMember } from '@dbsp/types';
import { describe, expect, it, vi } from 'vitest';
import {
	findPgLedgerTerminalMember,
	readPgLedgerAddressChain,
	readPgLedgerControllerOid,
} from './chain-reader.js';

const ledger = { scope: 'schema', schema: 'tenant' } as const;
const address = {
	scope: 'schema',
	engine: 'postgresql',
	database: 'app',
	schema: 'tenant',
	kind: 'table',
	name: 'accounts',
} as const;

function event(eventId: string, predecessor?: string): LedgerChainMember {
	return {
		eventId,
		address,
		eventKind: eventId === 'claim' ? 'intent' : 'refused',
		...(predecessor === undefined ? {} : { predecessor }),
		controller: 'deployment',
	};
}

describe('PostgreSQL address-chain reader', () => {
	it('finds the terminal by predecessor topology, not the supplied row position', () => {
		const claim = event('claim');
		const terminal = event('terminal', 'claim');
		expect(findPgLedgerTerminalMember([terminal, claim])).toBe(terminal);
		expect(
			findPgLedgerTerminalMember([
				claim,
				event('left', 'claim'),
				event('right', 'claim'),
			]),
		).toBeUndefined();
	});

	it('reads all members without a table-wide ordering and preserves an unknown kind for core', async () => {
		const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({
			rows: [
				{
					event_id: 'terminal',
					address_engine: 'postgresql',
					address_database: 'app',
					address_schema: 'tenant',
					address_parent: null,
					address_kind: 'table',
					address_name: 'accounts',
					catalogue_identity: null,
					event_kind: 'unknown-future-kind',
					predecessor: 'claim',
					pair_id: null,
					declared: null,
					declared_digest: null,
					observed: null,
					observed_digest: null,
					controller: 'deployment',
					recorded_at: '2026-08-07T00:00:00.000Z',
				},
				{
					event_id: 'claim',
					address_engine: 'postgresql',
					address_database: 'app',
					address_schema: 'tenant',
					address_parent: null,
					address_kind: 'table',
					address_name: 'accounts',
					catalogue_identity: null,
					event_kind: 'intent',
					predecessor: null,
					pair_id: null,
					declared: null,
					declared_digest: null,
					observed: null,
					observed_digest: null,
					controller: 'deployment',
					recorded_at: '2026-08-06T00:00:00.000Z',
				},
			],
		}));
		const result = await readPgLedgerAddressChain({ query }, ledger, address);
		expect(result.terminalMember?.eventId).toBe('terminal');
		expect(result.events[0]?.eventKind).toBe('unknown-future-kind');
		const sql = String(query.mock.calls[0]?.[0]);
		expect(sql).not.toMatch(/order\s+by|max\s*\(/i);
		expect(sql).toContain('WHERE address_engine = $1');
	});

	it('OBL-CTRL3: two address chains sharing an event id cannot cross-answer controller lookup', async () => {
		const auditAddress = { ...address, name: 'audit_log' };
		const query = vi.fn(
			async (_sql: string, parameters: readonly unknown[]) => ({
				rows: [{ controller_oid: parameters[6] === 'accounts' ? '42' : '43' }],
			}),
		);
		await expect(
			readPgLedgerControllerOid({ query }, ledger, address, 'shared-event'),
		).resolves.toBe('42');
		await expect(
			readPgLedgerControllerOid(
				{ query },
				ledger,
				auditAddress,
				'shared-event',
			),
		).resolves.toBe('43');
		const [sql, parameters] = query.mock.calls[0] as unknown as readonly [
			string,
			readonly unknown[],
		];
		expect(String(sql)).toContain('event_id = $1 AND address_engine = $2');
		expect(parameters).toEqual([
			'shared-event',
			'postgresql',
			'app',
			'tenant',
			'null',
			'table',
			'accounts',
		]);
		expect(query.mock.calls[1]?.[1]).toEqual([
			'shared-event',
			'postgresql',
			'app',
			'tenant',
			'null',
			'table',
			'audit_log',
		]);
	});
});
