import { beforeEach, describe, expect, it, vi } from 'vitest';

const ledger = vi.hoisted(() => ({
	validatePgLedgerPhysicalShape: vi.fn(),
}));

vi.mock('./ledger.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('./ledger.js')>()),
	validatePgLedgerPhysicalShape: ledger.validatePgLedgerPhysicalShape,
}));

import { runPgReinitializePreflight } from './reinitialize-preflight.js';

function currentMismatchQuery() {
	return vi.fn(async (sql: string) => {
		if (sql.includes('pg_is_in_recovery')) {
			return {
				rows: [
					{
						in_recovery: false,
						default_transaction_read_only: 'off',
						transaction_read_only: 'off',
					},
				],
			};
		}
		if (sql.startsWith('SELECT to_regclass'))
			return { rows: [{ relation: 'dbsp_meta.dbsp_ledger_marker' }] };
		if (sql.startsWith('SELECT version FROM'))
			return { rows: [{ version: 1 }] };
		if (sql.startsWith('SELECT cluster_system_identifier')) {
			return {
				rows: [
					{
						cluster_system_identifier: 'cluster',
						database_oid: '1',
						namespace_oid: '2',
					},
				],
			};
		}
		if (sql.includes('pg_control_system')) {
			return {
				rows: [
					{
						cluster_system_identifier: 'cluster',
						database_oid: '1',
						namespace_oid: '99',
					},
				],
			};
		}
		if (sql.includes('pg_try_advisory_xact_lock'))
			return { rows: [{ locked: true }] };
		if (sql === 'SELECT current_user AS role')
			return { rows: [{ role: 'deployer' }] };
		if (sql.includes('pg_catalog.pg_get_userbyid(c.relowner)')) {
			return {
				rows: [
					'dbsp_ledger_event',
					'dbsp_ledger_identity',
					'dbsp_ledger_marker',
					'dbsp_ledger_reservation',
				].map((relname) => ({ relname, owner: 'deployer', widened: false })),
			};
		}
		if (sql.includes('pg_catalog.pg_get_userbyid(n.nspowner)'))
			return { rows: [{ owner: 'deployer', widened: false }] };
		if (sql.includes('FROM pg_catalog.pg_index index_definition'))
			return { rows: [] };
		if (sql.includes('FROM pg_catalog.pg_class relation CROSS JOIN LATERAL'))
			return { rows: [] };
		return { rows: [] };
	});
}

function currentMismatchPool(
	processQuery: ReturnType<typeof currentMismatchQuery>,
) {
	const inspectionQuery = currentMismatchQuery();
	let connects = 0;
	return {
		pool: {
			connect: async () => ({
				query: connects++ === 0 ? inspectionQuery : processQuery,
			}),
		},
		inspectionQuery,
	};
}

describe('reinitialize-preflight mismatched current ledger', () => {
	beforeEach(() => ledger.validatePgLedgerPhysicalShape.mockReset());

	it('refuses an invalid physical shape before it can archive a mismatched current marker ledger', async () => {
		ledger.validatePgLedgerPhysicalShape.mockRejectedValueOnce(
			new Error('counterfeit ledger physical shape'),
		);
		const query = currentMismatchQuery();
		const { pool } = currentMismatchPool(query);

		const report = await runPgReinitializePreflight({
			pool,
			schemas: [],
			declarations: { version: 1, digest: 'empty', declarations: [] },
			writeAdoptionFile: async () => {},
		});

		expect(query.mock.calls.map(([sql]) => sql)).not.toContainEqual(
			expect.stringContaining('ALTER TABLE'),
		);
		expect(report.scopes).toEqual([
			expect.objectContaining({
				outcome: 'failed',
				reason: {
					step: 'create',
					message: 'counterfeit ledger physical shape',
				},
			}),
		]);
		expect(ledger.validatePgLedgerPhysicalShape).toHaveBeenCalledWith(
			expect.anything(),
			{ scope: 'database' },
		);
	});

	it('archives a validated, owned mismatched current ledger only after both validations', async () => {
		ledger.validatePgLedgerPhysicalShape.mockResolvedValueOnce(undefined);
		const query = currentMismatchQuery();
		const { pool } = currentMismatchPool(query);

		await runPgReinitializePreflight({
			pool,
			schemas: [],
			declarations: { version: 1, digest: 'empty', declarations: [] },
			observer: async (point) => {
				if (point === 'archive') throw new Error('stop after archive');
			},
			writeAdoptionFile: async () => {},
		});

		const firstRename = query.mock.calls.find(([sql]) =>
			sql.startsWith('ALTER TABLE'),
		);
		expect(firstRename).toBeDefined();
		expect(ledger.validatePgLedgerPhysicalShape).toHaveBeenCalledTimes(1);
		const validationOrder =
			ledger.validatePgLedgerPhysicalShape.mock.invocationCallOrder[0];
		const renameOrder =
			query.mock.invocationCallOrder[
				query.mock.calls.findIndex(([sql]) => sql.startsWith('ALTER TABLE'))
			];
		if (validationOrder === undefined || renameOrder === undefined)
			throw new Error('expected validation and archive rename calls');
		expect(validationOrder).toBeLessThan(renameOrder);
	});
});
