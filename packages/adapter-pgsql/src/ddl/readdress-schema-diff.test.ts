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

	it('normalizes both endpoints and assesses every occupied readdress state', () => {
		const desired = model([
			table('newUsers', {
				from: { name: 'oldUsers' },
				to: { name: 'newUsers' },
			}),
		]);
		const compare = (db: ModelIR) =>
			compareSchemata(desired, db, { dbCasing: 'snake_case' }).changes;

		const sourceOnly = compare(model([table('old_users')]));
		expect(sourceOnly).toHaveLength(1);
		expect(sourceOnly[0]).toMatchObject({
			kind: 'readdress_table',
			table: 'new_users',
			meta: {
				table: { name: 'new_users' },
				readdressAssessment: 'source-only',
				readdress: {
					from: { name: 'old_users' },
					to: { name: 'new_users' },
				},
			},
		});

		const targetOnly = compare(model([table('new_users')]));
		expect(targetOnly).toHaveLength(1);
		expect(targetOnly[0]).toMatchObject({
			kind: 'readdress_table',
			meta: {
				table: { name: 'new_users' },
				readdressAssessment: 'target-only',
			},
		});

		const bothPresent = compare(
			model([table('old_users'), table('new_users')]),
		);
		expect(bothPresent).toHaveLength(1);
		expect(bothPresent[0]).toMatchObject({
			kind: 'readdress_table',
			meta: {
				table: { name: 'new_users' },
				readdressAssessment: 'target-occupied',
			},
		});
	});

	it('carries the desired ModelIR table through every refused re-address state', () => {
		const desired = model([
			table('accounts', {
				from: { name: 'users' },
				to: { name: 'accounts' },
			}),
		]);
		for (const live of [
			model([]),
			model([table('users'), table('accounts')]),
		]) {
			const change = compareSchemata(desired, live).changes[0];
			expect(change).toMatchObject({
				kind: 'readdress_table',
				meta: { table: { name: 'accounts' } },
			});
		}
	});
});
