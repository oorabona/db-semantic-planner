import { describe, expect, it } from 'vitest';
import {
	createOwnedMatrixSchema,
	dropOwnedMatrixSchema,
	newMatrixSchemaName,
} from './catalogue-matrix-schema.js';

function schemaPool() {
	const schemas = new Set<string>();
	const queries: string[] = [];
	return {
		schemas,
		queries,
		pool: {
			async query(sql: string) {
				queries.push(sql);
				const create = /^CREATE SCHEMA (.+)$/.exec(sql);
				if (create?.[1] !== undefined) {
					if (schemas.has(create[1]))
						throw new Error(`schema ${create[1]} already exists`);
					schemas.add(create[1]);
					return { rows: [] };
				}
				const drop = /^DROP SCHEMA (.+) CASCADE$/.exec(sql);
				if (drop?.[1] !== undefined) {
					schemas.delete(drop[1]);
					return { rows: [] };
				}
				throw new Error(`unexpected query: ${sql}`);
			},
		},
	};
}

describe('catalogue matrix schema ownership', () => {
	it('fails a collision without deleting the schema it did not create', async () => {
		const fixture = schemaPool();
		const name = newMatrixSchemaName();
		const owned = await createOwnedMatrixSchema(fixture.pool as never, name);
		await expect(
			createOwnedMatrixSchema(fixture.pool as never, name),
		).rejects.toThrow('already exists');
		expect(fixture.schemas).toContain(name);
		expect(fixture.queries).toEqual([
			`CREATE SCHEMA ${name}`,
			`CREATE SCHEMA ${name}`,
		]);

		await dropOwnedMatrixSchema(fixture.pool as never, owned);
		expect(fixture.schemas).not.toContain(name);
	});
});
