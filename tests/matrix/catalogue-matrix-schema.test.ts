import { describe, expect, it } from 'vitest';
import {
	createOwnedMatrixSchema,
	dropOwnedMatrixSchema,
	newMatrixSchemaName,
	type OwnedMatrixSchema,
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
					if (!schemas.delete(drop[1]))
						throw new Error(`schema ${drop[1]} does not exist`);
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
		).rejects.toThrow(`schema ${name} already exists`);
		expect(fixture.schemas).toContain(name);
		expect(fixture.queries).toEqual([
			`CREATE SCHEMA ${name}`,
			`CREATE SCHEMA ${name}`,
		]);

		await dropOwnedMatrixSchema(owned);
		expect(fixture.schemas).not.toContain(name);
		await expect(dropOwnedMatrixSchema(owned)).rejects.toThrow(
			'consumed ownership token',
		);
	});

	it('rejects a forged ownership token without issuing DROP SCHEMA', async () => {
		const fixture = schemaPool();
		const name = newMatrixSchemaName();
		await fixture.pool.query(`CREATE SCHEMA ${name}`);
		const forged = { name } as unknown as OwnedMatrixSchema;
		await expect(dropOwnedMatrixSchema(forged)).rejects.toThrow(
			'unknown ownership token',
		);
		expect(fixture.schemas).toContain(name);
		expect(fixture.queries).toEqual([`CREATE SCHEMA ${name}`]);
	});

	it('binds cleanup to the executor that minted the ownership token', async () => {
		const mintingFixture = schemaPool();
		const otherFixture = schemaPool();
		const name = newMatrixSchemaName();
		const owned = await createOwnedMatrixSchema(
			mintingFixture.pool as never,
			name,
		);

		await dropOwnedMatrixSchema(owned);

		expect(mintingFixture.queries).toEqual([
			`CREATE SCHEMA ${name}`,
			`DROP SCHEMA ${name} CASCADE`,
		]);
		expect(otherFixture.queries).toEqual([]);
	});

	it('rejects a concurrent second cleanup while the first DROP is in flight', async () => {
		let resolveDrop: (() => void) | undefined;
		const queries: string[] = [];
		const pool = {
			async query(sql: string) {
				queries.push(sql);
				if (sql.startsWith('CREATE')) return { rows: [] };
				await new Promise<void>((resolve) => {
					resolveDrop = resolve;
				});
				return { rows: [] };
			},
		};
		const owned = await createOwnedMatrixSchema(pool as never);
		const firstDrop = dropOwnedMatrixSchema(owned);

		await expect(dropOwnedMatrixSchema(owned)).rejects.toThrow(
			'already in flight',
		);
		expect(queries).toHaveLength(2);
		resolveDrop?.();
		await firstDrop;
		await expect(dropOwnedMatrixSchema(owned)).rejects.toThrow(
			'consumed ownership token',
		);
	});

	it('allows cleanup retry after a failed DROP', async () => {
		let failDrop = true;
		const pool = {
			async query(sql: string) {
				if (sql.startsWith('CREATE')) return { rows: [] };
				if (failDrop) {
					failDrop = false;
					throw new Error('temporary cleanup failure');
				}
				return { rows: [] };
			},
		};
		const owned = await createOwnedMatrixSchema(pool as never);

		await expect(dropOwnedMatrixSchema(owned)).rejects.toThrow(
			'temporary cleanup failure',
		);
		await expect(dropOwnedMatrixSchema(owned)).resolves.toBeUndefined();
	});

	it('makes the schema fake reject a double DROP like PostgreSQL', async () => {
		const fixture = schemaPool();
		const name = newMatrixSchemaName();
		await fixture.pool.query(`CREATE SCHEMA ${name}`);
		await fixture.pool.query(`DROP SCHEMA ${name} CASCADE`);
		await expect(
			fixture.pool.query(`DROP SCHEMA ${name} CASCADE`),
		).rejects.toThrow(`schema ${name} does not exist`);
	});
});
