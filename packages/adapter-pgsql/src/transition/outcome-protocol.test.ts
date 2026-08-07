import type { LedgerReservationRow, OutcomeClaimPlan } from '@dbsp/types';
import { describe, expect, it, vi } from 'vitest';
import {
	runPgNonTransactionalOutcome,
	runPgTransactionalOutcome,
} from './outcome-protocol.js';

const address = {
	scope: 'schema' as const,
	engine: 'postgresql',
	database: 'app',
	schema: 'tenant',
	kind: 'table',
	name: 'accounts',
};

function request(claimId: string): {
	readonly plan: OutcomeClaimPlan;
	readonly reservations: readonly LedgerReservationRow[];
} {
	return {
		plan: {
			claimId,
			address,
			claimKind: 'intent',
			statementBundle: {
				statements: [
					{ ordinal: 0, sql: 'CREATE TABLE tenant.accounts (id integer)' },
				],
			},
		},
		reservations: [
			{
				address,
				claimKind: 'intent',
				executionId: `${claimId}-execution`,
				rootClaimId: claimId,
				homeLedger: { scope: 'schema', schema: 'tenant' },
			},
		],
	};
}

function recorder(failSql?: string) {
	const sql: string[] = [];
	let claimId: string | undefined;
	return {
		sql,
		query: vi.fn(async (statement: string, params?: readonly unknown[]) => {
			sql.push(statement);
			if (statement.includes('pg_try_advisory_xact_lock'))
				return { rows: [{ locked: true }] };
			if (statement.startsWith('SELECT event_id')) {
				return {
					rows:
						claimId === undefined
							? []
							: [
									{
										event_id: claimId,
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
										recorded_at: null,
									},
								],
				};
			}
			if (statement.includes('WITH appended AS') && claimId === undefined)
				claimId = String(params?.[0]);
			if (statement === failSql)
				throw new Error('DDL failed with PostgreSQL words');
			return { rows: [] };
		}),
	};
}

describe('PostgreSQL outcome protocol compositions', () => {
	it('keeps claim, DDL and resolution inside one transactional boundary (SC-32)', async () => {
		const executor = recorder('CREATE TABLE tenant.accounts (id integer)');
		const input = request('transactional');
		const result = await runPgTransactionalOutcome(executor, {
			...input,
			resolution: { eventId: 'transactional-observed', eventKind: 'observed' },
			vacancy: async () => ({ kind: 'vacant' }),
		});
		expect(result).toMatchObject({
			kind: 'outcome-protocol-refused',
			reason: 'DDL failed with PostgreSQL words',
		});
		expect(executor.sql).toContain('BEGIN');
		expect(executor.sql).toContain('ROLLBACK');
		expect(executor.sql).not.toContain('COMMIT');
		const claim = executor.sql.findIndex((sql) =>
			sql.includes('WITH appended AS'),
		);
		const ddl = executor.sql.indexOf(
			'CREATE TABLE tenant.accounts (id integer)',
		);
		expect(claim).toBeGreaterThan(-1);
		expect(ddl).toBeGreaterThan(claim);
	});

	it('commits executing before the observable gate and first non-transactional send', async () => {
		const executor = recorder();
		const input = request('nontransactional');
		let checkpoint = -1;
		const result = await runPgNonTransactionalOutcome(executor, {
			...input,
			executingEventId: 'nontransactional-executing',
			resolution: {
				eventId: 'nontransactional-observed',
				eventKind: 'observed',
			},
			vacancy: async () => ({ kind: 'vacant' }),
			onExecutingCommitted: () => {
				checkpoint = executor.sql.length;
			},
		});
		expect(result.kind).toBe('executed-outcome-claim');
		expect(checkpoint).toBeGreaterThan(0);
		expect(executor.sql[checkpoint - 1]).toBe('COMMIT');
		expect(executor.sql.slice(checkpoint)).toContain(
			'CREATE TABLE tenant.accounts (id integer)',
		);
	});
});
