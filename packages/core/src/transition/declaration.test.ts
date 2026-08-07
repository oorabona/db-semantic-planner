import type { ModelIR, TableIR } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import {
	admitRecordedIdentity,
	declarationSetFromModel,
} from './declaration.js';

const context = { engine: 'postgresql', database: 'db', schema: 'public' };

function model(table: TableIR): ModelIR {
	return {
		tables: new Map([[table.name, table]]),
		relations: new Map(),
		getTable: () => undefined,
		getRelation: () => undefined,
		getRelationsFrom: () => [],
		getRelationsTo: () => [],
		isAmbiguous: () => ({ ambiguous: false, options: [] }),
	};
}

function table(overrides: Partial<TableIR> = {}): TableIR {
	return {
		name: 'users',
		columns: [{ name: 'id', type: 'uuid', nullable: false }],
		foreignKeys: [],
		indexes: [],
		...overrides,
	};
}

describe('managed declaration slicing', () => {
	it('SC-20: has fragments only for the closed declarable-kind set', () => {
		const declarableModel = {
			...model(
				table({
					primaryKey: 'id',
					foreignKeys: [
						{
							columns: ['id'],
							references: { table: 'users', columns: ['id'] },
						},
					],
					indexes: [{ name: 'users_id_idx', columns: ['id'] }],
					checkConstraints: [{ name: 'users_id_check', expression: 'id > 0' }],
					logicalIdentity: {
						id: 'logical-users',
						carrier: { kind: 'postgresql-side-table', authenticated: false },
					},
					pseudoColumns: [],
					comment: 'not declarable',
					partition: { strategy: 'HASH', columns: ['id'] },
					rlsEnabled: true,
					policies: [{ name: 'tenant', using: 'true' }],
				}),
			),
			enums: new Map([['status', { name: 'status', values: ['active'] }]]),
			sequences: new Map([['users_id_seq', { name: 'users_id_seq' }]]),
			extensions: ['pgcrypto'],
		};
		const declarations = declarationSetFromModel(declarableModel, context);
		expect(
			new Set(declarations.declarations.map((item) => item.address.kind)),
		).toEqual(
			new Set([
				'table',
				'column',
				'index',
				'constraint',
				'enum',
				'sequence',
				'extension',
			]),
		);
		expect(JSON.stringify(declarations)).not.toContain('logical-users');
		expect(JSON.stringify(declarations)).not.toContain('not declarable');
		expect(JSON.stringify(declarations)).not.toContain('tenant');
	});

	it('SC-25: refuses a function column default with its path', () => {
		expect(() =>
			declarationSetFromModel(
				model(
					table({
						columns: [
							{
								name: 'createdAt',
								type: 'datetime',
								nullable: false,
								default: () => 'now()',
							},
						],
					}),
				),
				context,
			),
		).toThrow(
			/schema\.tables\["users"\]\.columns\[0\]\.default: found function/,
		);
	});

	it('SC-24: refuses admission when a same-name live object has another identity', () => {
		const recorded = {
			engine: 'postgresql',
			database: 'db',
			schema: 'public',
			kind: 'table',
			name: 'users',
			catalogueIdentity: {
				engine: 'postgresql',
				format: 1,
				value: { oid: '100' },
			},
		};
		const result = admitRecordedIdentity(recorded, {
			...recorded,
			catalogueIdentity: {
				engine: 'postgresql',
				format: 1,
				value: { oid: '200' },
			},
		});
		expect(result).toEqual({
			ok: false,
			detail: expect.stringContaining('identity drift for table users'),
		});
	});

	it('SC-24: refuses admission when the adapter identity format changes', () => {
		const recorded = {
			engine: 'postgresql',
			database: 'db',
			schema: 'public',
			kind: 'table',
			name: 'users',
			catalogueIdentity: {
				engine: 'postgresql',
				format: 1,
				value: { oid: '100' },
			},
		};
		expect(
			admitRecordedIdentity(recorded, {
				...recorded,
				catalogueIdentity: {
					...recorded.catalogueIdentity,
					format: 2,
				},
			}),
		).toEqual({
			ok: false,
			detail: expect.stringContaining('identity drift for table users'),
		});
	});
});
