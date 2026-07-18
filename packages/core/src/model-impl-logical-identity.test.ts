import { describe, expect, it } from 'vitest';
import { ModelIRImpl } from './model-impl.js';
import type { TableIR } from './model-ir.js';

function makeModel(logicalIdentity: unknown): ModelIRImpl {
	const table: TableIR = {
		name: 'users',
		columns: [{ name: 'id', type: 'integer', nullable: false }],
		primaryKey: 'id',
		foreignKeys: [],
		indexes: [],
		logicalIdentity: logicalIdentity as TableIR['logicalIdentity'],
	};
	return new ModelIRImpl(new Map([[table.name, table]]), new Map());
}

describe('ModelIRImpl logical identity carrier validation', () => {
	it('rejects a missing logical identity carrier', () => {
		expect(() => makeModel({ id: 'logical.table.users' })).toThrow(
			/malformed logical identity carrier/,
		);
	});

	it('rejects a carrier with an empty kind', () => {
		expect(() =>
			makeModel({
				id: 'logical.table.users',
				carrier: { kind: '   ', authenticated: false },
			}),
		).toThrow(/malformed logical identity carrier/);
	});

	it('rejects an authenticated carrier without a supported attestation shape', () => {
		expect(() =>
			makeModel({
				id: 'logical.table.users',
				carrier: { kind: 'postgresql-side-table', authenticated: true },
			}),
		).toThrow(/malformed logical identity carrier/);
	});
});
