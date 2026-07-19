import { describe, expect, it } from 'vitest';
import type { ColumnIR, ModelIR, TableIR } from '../model-ir.js';
import { createComparator } from './comparator.js';
import { createPackRegistry } from './registry.js';

function modelFromTable(table: TableIR): ModelIR {
	const tables = new Map([[table.name, table]]);
	return {
		tables,
		externalTables: new Set(),
		relations: new Map(),
		getTable: (name) => tables.get(name),
		getRelation: () => undefined,
		getRelationsFrom: () => [],
		getRelationsTo: () => [],
		isAmbiguous: () => ({ ambiguous: false, options: [] }),
	};
}

function column(overrides: Partial<ColumnIR> = {}): ColumnIR {
	return {
		name: 'id',
		type: 'integer',
		nullable: false,
		...overrides,
	};
}

function table(overrides: Partial<TableIR> = {}): TableIR {
	return {
		name: 'users',
		columns: [column()],
		foreignKeys: [],
		indexes: [],
		...overrides,
	};
}

function compare(desired: TableIR, current: TableIR) {
	return createComparator(createPackRegistry([])).compare(
		modelFromTable(desired),
		modelFromTable(current),
		{ engine: 'postgresql' },
	);
}

describe('logical identity comparison', () => {
	it('surfaces table carrier-kind changes as drift with the same logical id', () => {
		const desired = table({
			logicalIdentity: {
				id: 'logical.table.users',
				carrier: { kind: 'postgresql-side-table', authenticated: false },
			},
		});
		const current = table({
			logicalIdentity: {
				id: 'logical.table.users',
				carrier: { kind: 'legacy-side-table', authenticated: false },
			},
		});

		expect(compare(desired, current).kind).toBe('unsupported');
	});

	it('surfaces column carrier-kind changes as drift with the same logical id', () => {
		const desired = table({
			columns: [
				column({
					logicalIdentity: {
						id: 'logical.column.users.id',
						carrier: { kind: 'postgresql-side-table', authenticated: false },
					},
				}),
			],
		});
		const current = table({
			columns: [
				column({
					logicalIdentity: {
						id: 'logical.column.users.id',
						carrier: { kind: 'legacy-side-table', authenticated: false },
					},
				}),
			],
		});

		expect(compare(desired, current).kind).toBe('unsupported');
	});
});
