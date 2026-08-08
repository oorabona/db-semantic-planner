import type { ModelIR, TableIR } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { compareSchemata } from './schema-diff.js';

function model(tables: readonly TableIR[]): ModelIR {
	return {
		tables: new Map(tables.map((table) => [table.name, table])),
		relations: new Map(),
		getTable(name) {
			return this.tables.get(name);
		},
		getRelation() {
			return undefined;
		},
		getRelationsFrom() {
			return [];
		},
		getRelationsTo() {
			return [];
		},
		isAmbiguous() {
			return { ambiguous: false, options: [] };
		},
	};
}

function table(name: string, readdress?: TableIR['readdress']): TableIR {
	return {
		name,
		columns: [],
		foreignKeys: [],
		indexes: [],
		...(readdress ? { readdress } : {}),
	};
}

describe('declared table re-addressing in schema diff', () => {
	it('replaces the otherwise inferred create/drop pair', () => {
		const diff = compareSchemata(
			model([
				table('accounts', {
					from: { name: 'users' },
					to: { name: 'accounts' },
				}),
			]),
			model([table('users')]),
		);
		expect(diff.changes.map((change) => change.kind)).toEqual([
			'readdress_table',
		]);
	});

	it('keeps an undeclared name change as create/drop drift', () => {
		const diff = compareSchemata(
			model([table('accounts')]),
			model([table('users')]),
		);
		expect(diff.changes.map((change) => change.kind).sort()).toEqual([
			'create_table',
			'drop_table',
		]);
	});
});
