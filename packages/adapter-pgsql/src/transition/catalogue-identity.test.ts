import type { ResourceAddress } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { readPgCatalogueIdentity } from './catalogue-identity.js';

class QueryRecorder {
	readonly calls: Array<{
		readonly sql: string;
		readonly params: readonly unknown[];
	}> = [];
	constructor(private readonly rows: readonly Record<string, unknown>[]) {}
	async query(sql: string, params: readonly unknown[] = []) {
		this.calls.push({ sql, params });
		return { rows: this.rows };
	}
}

const table: ResourceAddress = {
	engine: 'postgresql',
	database: 'db',
	schema: 'public',
	kind: 'table',
	name: 'orders',
};

describe('PostgreSQL managed catalogue identities', () => {
	it.each([
		['table', { oid: '11' }],
		['index', { oid: '12' }],
		['sequence', { oid: '13' }],
		['enum', { oid: '14' }],
		['extension', { oid: '15' }],
		['constraint', { oid: '16' }],
	] as const)('SC-23: records %s identity as an OID', async (kind, row) => {
		const query = new QueryRecorder([row]);
		const result = await readPgCatalogueIdentity(query, {
			...table,
			kind,
			name: `${kind}_name`,
			...(kind === 'index' || kind === 'constraint' ? { parent: table } : {}),
		});
		expect(result?.catalogueIdentity).toEqual({
			engine: 'postgresql',
			format: 1,
			value: { oid: row.oid },
		});
		expect(query.calls).toHaveLength(1);
	});

	it('SC-23: records a column as its parent OID plus name', async () => {
		const query = new QueryRecorder([{ parent_oid: '42' }]);
		const result = await readPgCatalogueIdentity(query, {
			...table,
			kind: 'column',
			name: 'customer_id',
			parent: table,
		});
		expect(result).toMatchObject({
			catalogueIdentity: {
				engine: 'postgresql',
				format: 1,
				value: { parentOid: '42', name: 'customer_id' },
			},
			parent: {
				catalogueIdentity: {
					engine: 'postgresql',
					format: 1,
					value: { oid: '42' },
				},
			},
		});
	});
});
