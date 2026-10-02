import { createOrm, schema, sql } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

const db = schema({
	t: {
		id: 'integer',
		a: 'integer',
		b: 'integer',
		updatedAt: 'timestamp',
		tags: { type: 'text', dbType: 'text[]' },
	},
} as const);
const adapter = createPgsqlCompileOnlyAdapter({ model: db.model });
const orm = createOrm({ schema: db, adapter });
const insert = (values: Record<string, unknown>[], batchThreshold = 50) =>
	adapter.compileInsert(
		{ type: 'insert', table: 't', values },
		{ batchThreshold },
	);
const upsert = (values: Record<string, unknown>[], batchThreshold = 50) =>
	adapter.compileUpsert(
		{
			type: 'upsert',
			table: 't',
			values,
			onConflict: { columns: ['id'] },
			action: { type: 'doNothing' },
		},
		{ batchThreshold },
	);
const update = (updates: Record<string, unknown>[]) =>
	adapter.compileBatchUpdate({
		type: 'batchUpdate',
		table: 't',
		updates,
		matchColumns: ['id'],
	});

function exactRefusal(run: () => unknown, message: string) {
	let caught: unknown;
	try {
		run();
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(Error);
	expect((caught as Error).message).toBe(message);
}

describe('mutation own-key contract', () => {
	it('uses all insert columns and DEFAULT for both missing and extra keys', () => {
		const result = insert([{ a: 1 }, { b: 2 }], 1);
		expect(result.sql).toBe(
			'INSERT INTO t (a, b) VALUES ($1, DEFAULT), (DEFAULT, $2)',
		);
		expect(result.parameters).toEqual([1, 2]);
		expect(
			orm
				.insert('t')
				.values([{ a: 1 }, { b: 2 }])
				.dump().sql,
		).toBe(result.sql);
	});
	it('keeps equal own-key sets homogeneous regardless of order', () => {
		expect(
			insert([
				{ a: 1, b: 2 },
				{ b: 3, a: 4 },
			]).sql,
		).toBe('INSERT INTO t (a, b) VALUES ($1, $2), ($3, $4)');
		expect(
			upsert([
				{ id: 1, a: 2 },
				{ a: 3, id: 4 },
			]).sql,
		).toBe(
			'INSERT INTO t (id, a) VALUES ($1, $2), ($3, $4) ON CONFLICT (id) DO NOTHING',
		);
		expect(
			update([
				{ id: 1, a: 2 },
				{ a: 3, id: 4 },
			]).parameters,
		).toEqual([
			[1, 4],
			[2, 3],
		]);
	});
	for (const batchThreshold of [50, 0]) {
		it(`normalizes own undefined in both rows for insert/upsert threshold ${batchThreshold}`, () => {
			const values = [
				{ id: 1, a: undefined },
				{ id: 2, a: undefined },
			];
			const inserted = insert(values, batchThreshold);
			const upserted = upsert(values, batchThreshold);
			expect(inserted.sql).toBe(
				batchThreshold === 0
					? 'INSERT INTO t (id, a) SELECT unnest(CAST($1 AS int4[])) AS id, unnest(CAST($2 AS int4[])) AS a'
					: 'INSERT INTO t (id, a) VALUES ($1, NULL), ($2, NULL)',
			);
			expect(inserted.parameters).toEqual(
				batchThreshold === 0
					? [
							[1, 2],
							[null, null],
						]
					: [1, 2],
			);
			expect(upserted.sql).toBe(
				batchThreshold === 0
					? 'INSERT INTO t (id, a) SELECT unnest(CAST($1 AS int4[])) AS id, unnest(CAST($2 AS int4[])) AS a ON CONFLICT (id) DO NOTHING'
					: 'INSERT INTO t (id, a) VALUES ($1, $2), ($3, $4) ON CONFLICT (id) DO NOTHING',
			);
			expect(upserted.parameters).toEqual(
				batchThreshold === 0
					? [
							[1, 2],
							[null, null],
						]
					: [1, null, 2, null],
			);
		});
	}
	for (const [values, reason] of [
		[[{ id: 1, a: 2 }, { id: 2 }], "row 1 lacks key 'a' present in row 0"],
		[[{ id: 1 }, { id: 2, a: 3 }], "row 1 has key 'a' that row 0 does not"],
	] as const) {
		for (const operation of ['upsert', 'update'] as const) {
			it(`refuses ${operation}: ${reason} through builder and adapter`, () => {
				const rows = values.map((row) => ({ ...row }));
				const message = `Invalid ${operation}: ${operation}: ${reason}`;
				exactRefusal(
					() => (operation === 'upsert' ? upsert(rows) : update(rows)),
					message,
				);
				exactRefusal(
					() =>
						operation === 'upsert'
							? orm.upsert('t').values(rows)
							: orm.update('t').batchSet('id', rows),
					message,
				);
			});
		}
	}
	it('refuses missing match key in row zero at both entry points', () => {
		const message =
			"Invalid update: update: row 0 lacks required match key 'id'";
		exactRefusal(() => update([{ a: 1 }]), message);
		exactRefusal(() => orm.update('t').batchSet('id', [{ a: 1 }]), message);
	});
	it('refuses missing match key in a later row at both entry points', () => {
		const message =
			"Invalid update: update: row 1 lacks key 'id' present in row 0";
		exactRefusal(() => update([{ id: 1, a: 2 }, { a: 3 }]), message);
		exactRefusal(
			() => orm.update('t').batchSet('id', [{ id: 1, a: 2 }, { a: 3 }]),
			message,
		);
	});
	it('checks shape before an upsert scalar merge can hide it', () => {
		exactRefusal(
			() =>
				adapter.compileUpsert({
					type: 'upsert',
					table: 't',
					values: [{ id: 1, a: 2 }, { id: 2 }],
					onConflict: { columns: ['id'] },
					action: { type: 'doUpdate', set: { a: 4 } },
				}),
			"Invalid upsert: upsert: row 1 lacks key 'a' present in row 0",
		);
	});
	it('evaluates scalar raw expressions in batch updates', () => {
		const result = orm
			.update('t')
			.set({ updatedAt: sql('now()') })
			.batchSet('id', [
				{ id: 1, a: 2 },
				{ id: 2, a: 3 },
			])
			.dump();
		expect(result.sql).toBe(
			'UPDATE t SET a = t.a,"updatedAt" = now() FROM unnest(CAST($1 AS int4[]), CAST($2 AS int4[])) AS t(id, a) WHERE t.id = t.id',
		);
		expect(result.parameters).toEqual([
			[1, 2],
			[2, 3],
		]);
	});
	it('refuses empty builders before SQL generation', () => {
		exactRefusal(
			() => orm.insert('t').values([]).dump(),
			'Invalid insert: No values provided for insert',
		);
		exactRefusal(
			() => orm.upsert('t').values([]).onConflict(['id']).doNothing().dump(),
			'Invalid upsert: No values provided for upsert',
		);
	});
	it('refuses empty adapter inserts and upserts', () => {
		exactRefusal(
			() => insert([]),
			'Invalid insert: insert: values requires at least one row',
		);
		exactRefusal(
			() => upsert([]),
			'Invalid upsert: upsert: values requires at least one row',
		);
	});
	it('refuses a heterogeneous batch beyond the parameter limit at both entry points', () => {
		const rows = Array.from({ length: 32768 }, (_, i) =>
			i === 0 ? { a: 1 } : { a: 1, b: 2 },
		);
		const message =
			'Invalid insert: insert: heterogeneous batch requires 65536 parameter slots, exceeding PostgreSQL limit 65535';
		exactRefusal(() => insert(rows), message);
		exactRefusal(() => orm.insert('t').values(rows).dump(), message);
	});
	for (const operation of ['insert', 'upsert', 'update'] as const) {
		it(`gives operation-valid array refusal advice for ${operation}`, () => {
			const rows = [
				{ id: 1, tags: ['a'] },
				{ id: 2, tags: ['b'] },
			];
			const arrayOrm = createOrm({ model: db.model, adapter });
			const advice =
				operation === 'update'
					? 'Use single-row updates, or scalar set only when every row should receive the same array.'
					: 'Set batchThreshold to at least the batch size to use VALUES, or use single-row mutations for array columns.';
			const message = `Batch mutation of array-typed column 'tags' (text[]) is not supported: unnest flattens multi-dimensional arrays. ${advice}`;
			exactRefusal(
				() =>
					operation === 'insert'
						? insert(rows, 0)
						: operation === 'upsert'
							? upsert(rows, 0)
							: update(rows),
				message,
			);
			exactRefusal(
				() =>
					operation === 'insert'
						? arrayOrm.insert('t').values(rows).dump({ batchThreshold: 0 })
						: operation === 'upsert'
							? arrayOrm
									.upsert('t')
									.values(rows)
									.onConflict(['id'])
									.doNothing()
									.dump({ batchThreshold: 0 })
							: arrayOrm.update('t').batchSet('id', rows).dump(),
				message,
			);
		});
	}
});
