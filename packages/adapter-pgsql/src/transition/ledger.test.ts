import type { LedgerChainMember, LedgerReservationRow } from '@dbsp/types';
import { describe, expect, it, vi } from 'vitest';
import {
	acquirePgLedgerLocks,
	appendPgLedgerClaim,
	appendPgLedgerClaimGroup,
	appendPgLedgerResolution,
	appendPgLedgerResolutionGroup,
	ensurePgLedger,
	PgLedgerStorageUnsupportedError,
	renderCreateLedgerEventTableSql,
	validatePgLedgerPhysicalShape,
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

/** Catalog facts that are normalization-independent and protect chain closure. */
function createdLedgerTableRows() {
	return [
		{
			table_name: 'dbsp_ledger_event',
			relation_kind: 'r',
		},
		{
			table_name: 'dbsp_ledger_reservation',
			relation_kind: 'r',
		},
		{
			table_name: 'dbsp_ledger_identity',
			relation_kind: 'r',
		},
		{
			table_name: 'dbsp_ledger_marker',
			relation_kind: 'r',
		},
	];
}

function createdLedgerColumnRows() {
	const columns = [
		['dbsp_ledger_event', 'event_id', 'text', true],
		['dbsp_ledger_event', 'address_engine', 'text', true],
		['dbsp_ledger_event', 'address_database', 'text', true],
		['dbsp_ledger_event', 'address_schema', 'text', true],
		['dbsp_ledger_event', 'address_parent', 'jsonb', true],
		['dbsp_ledger_event', 'address_kind', 'text', true],
		['dbsp_ledger_event', 'address_name', 'text', true],
		['dbsp_ledger_event', 'execution_id', 'text', false],
		['dbsp_ledger_event', 'planned_claim_key', 'text', false],
		['dbsp_ledger_event', 'claim_group_id', 'text', false],
		['dbsp_ledger_event', 'root_claim_id', 'text', false],
		['dbsp_ledger_event', 'catalogue_identity', 'jsonb', false],
		['dbsp_ledger_event', 'event_kind', 'text', true],
		['dbsp_ledger_event', 'predecessor', 'text', false],
		['dbsp_ledger_event', 'pair_id', 'text', false],
		['dbsp_ledger_event', 'declared', 'jsonb', false],
		['dbsp_ledger_event', 'declared_digest', 'text', false],
		['dbsp_ledger_event', 'observed', 'jsonb', false],
		['dbsp_ledger_event', 'observed_digest', 'text', false],
		['dbsp_ledger_event', 'controller', 'name', true],
		['dbsp_ledger_event', 'recorded_at', 'timestamp with time zone', true],
		['dbsp_ledger_reservation', 'address_engine', 'text', true],
		['dbsp_ledger_reservation', 'address_database', 'text', true],
		['dbsp_ledger_reservation', 'address_schema', 'text', true],
		['dbsp_ledger_reservation', 'address_parent', 'jsonb', true],
		['dbsp_ledger_reservation', 'address_kind', 'text', true],
		['dbsp_ledger_reservation', 'address_name', 'text', true],
		['dbsp_ledger_reservation', 'claim_kind', 'text', true],
		['dbsp_ledger_reservation', 'execution_id', 'text', true],
		['dbsp_ledger_reservation', 'pair_id', 'text', false],
		['dbsp_ledger_reservation', 'root_claim_id', 'text', true],
		['dbsp_ledger_reservation', 'home_ledger_scope', 'text', true],
		['dbsp_ledger_reservation', 'home_ledger_schema', 'text', false],
		['dbsp_ledger_identity', 'id', 'boolean', true],
		['dbsp_ledger_identity', 'cluster_system_identifier', 'text', true],
		['dbsp_ledger_identity', 'database_oid', 'text', true],
		['dbsp_ledger_identity', 'namespace_oid', 'text', false],
		['dbsp_ledger_marker', 'id', 'boolean', true],
		['dbsp_ledger_marker', 'version', 'integer', true],
	] as const;
	return columns.map(([table_name, column_name, column_type, is_not_null]) => ({
		table_name,
		column_name,
		column_type,
		is_not_null,
	}));
}

function createdLedgerInvariantConstraintRows() {
	const addressColumns = [
		'address_engine',
		'address_database',
		'address_schema',
		'address_parent',
		'address_kind',
		'address_name',
	];
	return [
		['dbsp_ledger_event', 'p'],
		['dbsp_ledger_event', 'c'],
		['dbsp_ledger_event', 'c'],
		['dbsp_ledger_event', 'c'],
		['dbsp_ledger_event', 'u'],
		[
			'dbsp_ledger_event',
			'f',
			false,
			true,
			[...addressColumns, 'predecessor'],
			[...addressColumns, 'event_id'],
		],
		['dbsp_ledger_reservation', 'p'],
		['dbsp_ledger_reservation', 'c'],
		['dbsp_ledger_reservation', 'c'],
		['dbsp_ledger_reservation', 'c'],
		['dbsp_ledger_identity', 'p'],
		['dbsp_ledger_identity', 'c'],
		['dbsp_ledger_marker', 'p'],
		['dbsp_ledger_marker', 'c'],
		['dbsp_ledger_marker', 'c'],
		[
			'dbsp_ledger_event',
			'u',
			true,
			false,
			[...addressColumns, 'predecessor'],
			[],
		],
	].map(
		([
			table_name,
			contype,
			connullsnotdistinct = false,
			is_self_referential = false,
			key_columns = [],
			referenced_columns = [],
		]) => ({
			table_name,
			contype,
			connullsnotdistinct,
			is_self_referential,
			key_columns,
			referenced_columns,
		}),
	);
}

function createdLedgerTerminalIndexRows() {
	return [
		{
			table_name: 'dbsp_ledger_event',
			indisprimary: false,
			indisunique: false,
			index_columns: ['predecessor'],
		},
	];
}

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

	it.each([
		{ scope: 'schema' as const, schema: 'tenant_shape' },
		{ scope: 'database' as const },
	])('accepts a legitimately-created ledger by structural invariants for $scope scope', async (ledger) => {
		const query = vi.fn(async (sql: string) => {
			if (sql === 'SHOW server_version_num')
				return { rows: [{ server_version_num: '180000' }] };
			if (
				sql.includes(
					'FROM pg_catalog.pg_class relation JOIN pg_catalog.pg_namespace',
				)
			)
				return { rows: createdLedgerTableRows() };
			if (sql.includes('FROM pg_catalog.pg_attribute attribute'))
				return { rows: createdLedgerColumnRows() };
			if (sql.includes('FROM pg_catalog.pg_constraint'))
				return {
					rows: [
						...createdLedgerInvariantConstraintRows(),
						...createdLedgerColumnRows()
							.filter((row) => row.is_not_null)
							.map(({ table_name, column_name }) => ({
								table_name,
								contype: 'n',
								key_columns: [column_name],
							})),
					],
				};
			if (sql.includes('FROM pg_catalog.pg_index'))
				return { rows: createdLedgerTerminalIndexRows() };
			return { rows: [] };
		});
		await ensurePgLedger({ query }, ledger, { writeMarker: false });
		await expect(
			validatePgLedgerPhysicalShape({ query }, ledger),
		).resolves.toBeUndefined();
		expect(query).toHaveBeenCalledWith(
			expect.stringContaining('CREATE TABLE IF NOT EXISTS'),
		);
		const constraintQuery = query.mock.calls.find(([sql]) =>
			String(sql).includes('FROM pg_catalog.pg_constraint'),
		)?.[0];
		expect(constraintQuery).toContain(
			'LEFT JOIN pg_catalog.pg_index constraint_index ON constraint_index.indexrelid = constraint_item.conindid',
		);
		expect(constraintQuery).toContain(
			'constraint_index.indnullsnotdistinct AS connullsnotdistinct',
		);
		expect(constraintQuery).not.toContain(
			'constraint_item.connullsnotdistinct',
		);
		expect(constraintQuery).toContain(
			"constraint_item.contype IN ('p', 'c', 'u', 'f')",
		);
	});

	it.each([
		{
			name: 'self-referential predecessor foreign key',
			without: (
				rows: ReturnType<typeof createdLedgerInvariantConstraintRows>,
			) => rows.filter((row) => row.contype !== 'f'),
			expected:
				'dbsp_ledger_event missing self-referential predecessor foreign key',
		},
		{
			name: 'UNIQUE NULLS NOT DISTINCT child constraint',
			without: (
				rows: ReturnType<typeof createdLedgerInvariantConstraintRows>,
			) => rows.filter((row) => row.contype !== 'u'),
			expected:
				'dbsp_ledger_event missing UNIQUE NULLS NOT DISTINCT on address and predecessor',
		},
	])('refuses a pre-existing ledger missing its $name', async ({
		without,
		expected,
	}) => {
		const query = vi.fn(async (sql: string) => {
			if (
				sql.includes(
					'FROM pg_catalog.pg_class relation JOIN pg_catalog.pg_namespace',
				)
			)
				return { rows: createdLedgerTableRows() };
			if (sql.includes('FROM pg_catalog.pg_attribute attribute'))
				return { rows: createdLedgerColumnRows() };
			if (sql.includes('FROM pg_catalog.pg_constraint'))
				return { rows: without(createdLedgerInvariantConstraintRows()) };
			if (sql.includes('FROM pg_catalog.pg_index'))
				return { rows: createdLedgerTerminalIndexRows() };
			return { rows: [] };
		});
		await expect(
			validatePgLedgerPhysicalShape({ query }, target),
		).rejects.toThrow(expected);
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

	it('appends and resolves a root plus contained member as one group transaction unit', async () => {
		const child = {
			...claim,
			eventId: 'claim-child',
			address: {
				...claim.address,
				kind: 'column',
				name: 'accounts.id',
				parent: claim.address,
			},
			eventKind: 'retire-intent' as const,
			claimGroupId: 'claim-1',
			rootClaimId: 'claim-1',
		};
		const childReservation: LedgerReservationRow = {
			...reservation,
			address: child.address,
			claimKind: 'retire-intent',
			rootClaimId: 'claim-1',
		};
		const query = vi.fn(async () => ({ rows: [] }));
		await appendPgLedgerClaimGroup(
			{ query },
			{
				...claim,
				eventKind: 'retire-intent',
				claimGroupId: 'claim-1',
				rootClaimId: 'claim-1',
			},
			[child],
			[{ ...reservation, claimKind: 'retire-intent' }, childReservation],
		);
		expect(query).toHaveBeenCalledTimes(2);
		await appendPgLedgerResolutionGroup(
			{ query },
			'claim-1',
			[
				{
					...claim,
					eventId: 'absent-root',
					eventKind: 'absent',
					predecessor: 'claim-1',
				},
				{
					...child,
					eventId: 'absent-child',
					eventKind: 'absent',
					predecessor: 'claim-child',
				},
			],
			[{ address: claim.address }, { address: child.address }],
		);
		expect(query).toHaveBeenCalledTimes(4);
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
