import { readFileSync } from 'node:fs';
import { createOrm, schema, sql } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

const columns = {
	id: 'integer',
	a: 'integer',
	b: 'integer',
	updatedAt: 'timestamp',
	tags: { type: 'text', dbType: 'text[]' },
} as const;
const db = schema({
	calls: columns,
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

describe('mutation enumerable own keys contract', () => {
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
					: 'INSERT INTO t (id, a) VALUES ($1, NULL), ($2, NULL) ON CONFLICT (id) DO NOTHING',
			);
			expect(upserted.parameters).toEqual(
				batchThreshold === 0
					? [
							[1, 2],
							[null, null],
						]
					: [1, 2],
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
			.update('calls')
			.set({ updatedAt: sql('now()') })
			.batchSet('id', [
				{ id: 1, a: 2 },
				{ id: 2, a: 3 },
			])
			.dump();
		expect(result.sql).toBe(
			'UPDATE calls SET a = t.a,"updatedAt" = now() FROM unnest(CAST($1 AS int4[]), CAST($2 AS int4[])) AS t(id, a) WHERE calls.id = t.id',
		);
		expect(
			adapter.compileBatchUpdate({
				type: 'batchUpdate',
				table: 'calls',
				matchColumns: ['id'],
				updates: [
					{ id: 1, a: 2 },
					{ id: 2, a: 3 },
				],
				scalarSet: { updatedAt: sql('now()') },
			}).sql,
		).toBe(result.sql);
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

	for (const operation of ['insert', 'upsert'] as const) {
		for (const count of [65535, 65536]) {
			it(`${operation} counts ${count} actual VALUES binds through builder and adapter`, () => {
				const rows = Array.from({ length: count }, (_, id) => ({
					id,
					a: null,
					b: undefined,
				}));
				const direct = () =>
					operation === 'insert' ? insert(rows, count) : upsert(rows, count);
				const built = () =>
					operation === 'insert'
						? orm.insert('t').values(rows).dump({ batchThreshold: count })
						: orm
								.upsert('t')
								.values(rows)
								.onConflict(['id'])
								.doNothing()
								.dump({ batchThreshold: count });
				if (count === 65536) {
					const message = `Invalid ${operation}: ${operation}: batch requires 65536 parameters, exceeding PostgreSQL limit 65535`;
					exactRefusal(direct, message);
					exactRefusal(built, message);
				} else {
					const expected = `INSERT INTO t (id, a, b) VALUES ${rows.map((_, i) => `($${i + 1}, NULL, NULL)`).join(', ')}${operation === 'upsert' ? ' ON CONFLICT (id) DO NOTHING' : ''}`;
					for (const run of [direct, built]) {
						const result = run();
						expect(result.sql).toBe(expected);
						expect(result.parameters).toHaveLength(count);
					}
				}
			});
		}
	}

	it('includes upsert action WHERE binds in the final parameter count', () => {
		const where = {
			kind: 'comparison' as const,
			field: 'id',
			operator: 'eq' as const,
			value: 7,
		};
		for (const count of [65534, 65535]) {
			const rows = Array.from({ length: count }, (_, id) => ({ id, a: 1 }));
			// Raw assignment is evaluated; its column is not merged into VALUES.
			const set = { a: sql('42') };
			const options = { batchThreshold: count };
			const direct = () =>
				adapter.compileUpsert(
					{
						type: 'upsert',
						table: 't',
						values: rows.map(({ id }) => ({ id })),
						onConflict: { columns: ['id'] },
						action: { type: 'doUpdate', set, where },
					},
					options,
				);
			const built = () =>
				orm
					.upsert('t')
					.values(rows.map(({ id }) => ({ id })))
					.onConflict(['id'])
					.doUpdate(set, where)
					.dump(options);
			if (count === 65535) {
				const message =
					'Invalid upsert: upsert: batch requires 65536 parameters, exceeding PostgreSQL limit 65535';
				exactRefusal(direct, message);
				exactRefusal(built, message);
			} else {
				const expected = `INSERT INTO t (id) VALUES ${rows.map((_, i) => `($${i + 1})`).join(', ')} ON CONFLICT (id) DO UPDATE SET a = 42 WHERE t.id = $65535`;
				for (const run of [direct, built]) {
					const result = run();
					expect(result.sql).toBe(expected);
					expect(result.parameters).toHaveLength(65535);
				}
			}
		}
	});
	it('counts DEFAULT cells as zero binds at the exact boundary', () => {
		const rows = Array.from({ length: 32768 }, (_, i) =>
			i === 0 ? { a: 1 } : { a: 1, b: 2 },
		);
		const expected =
			'INSERT INTO t (a, b) VALUES ($1, DEFAULT), ' +
			rows
				.slice(1)
				.map((_, i) => `($${2 * i + 2}, $${2 * i + 3})`)
				.join(', ');
		for (const result of [insert(rows), orm.insert('t').values(rows).dump()]) {
			expect(result.sql).toBe(expected);
			expect(result.parameters).toHaveLength(65535);
		}
	});

	it('refuses a heterogeneous insert with 65536 actual binds through both entry points', () => {
		const rows = Array.from({ length: 32769 }, (_, i) =>
			i === 0 ? { a: null } : { a: 1, b: 2 },
		);
		const message =
			'Invalid insert: insert: batch requires 65536 parameters, exceeding PostgreSQL limit 65535';
		exactRefusal(() => insert(rows), message);
		exactRefusal(() => orm.insert('t').values(rows).dump(), message);
	});
	it('avoids a batch source alias colliding with target t', () => {
		const rows = [{ id: 1, a: 2 }];
		const expected =
			'UPDATE t SET a = t1.a FROM unnest(CAST($1 AS int4[]), CAST($2 AS int4[])) AS t1(id, a) WHERE t.id = t1.id';
		expect(update(rows).sql).toBe(expected);
		expect(orm.update('t').batchSet('id', rows).dump().sql).toBe(expected);
	});
	it('refuses empty match keys', () => {
		const message = 'Invalid update: batchSet requires at least one match key';
		exactRefusal(
			() =>
				orm
					.update('t')
					.batchSet([], [{ id: 1, a: 2 }])
					.dump(),
			message,
		);
		exactRefusal(
			() =>
				adapter.compileBatchUpdate({
					type: 'batchUpdate',
					table: 't',
					matchColumns: [],
					updates: [{ id: 1, a: 2 }],
				}),
			message,
		);
	});
	it('refuses assignmentless batches', () => {
		const message = 'Invalid update: batchSet requires at least one assignment';
		exactRefusal(() => update([{ id: 1 }]), message);
		exactRefusal(
			() =>
				orm
					.update('t')
					.batchSet('id', [{ id: 1 }])
					.dump(),
			message,
		);
	});
	it('refuses overlapping scalar and row assignments by column name', () => {
		const message =
			"Invalid update: batchSet column 'a' also appears in scalar set";
		exactRefusal(
			() =>
				adapter.compileBatchUpdate({
					type: 'batchUpdate',
					table: 't',
					matchColumns: ['id'],
					updates: [{ id: 1, a: 2 }],
					scalarSet: { a: 9 },
				}),
			message,
		);
		exactRefusal(
			() =>
				orm
					.update('t')
					.set({ a: 9 })
					.batchSet('id', [{ id: 1, a: 2 }])
					.dump(),
			message,
		);
	});
	for (const operation of ['insert', 'upsert'] as const) {
		it(`prioritizes maxBatchSize over ${operation} shape and bind inspection`, () => {
			const rows = Array.from({ length: 32769 }, (_, i) =>
				i === 0 ? { a: 1 } : { a: 1, b: 2 },
			);
			const options = { maxBatchSize: 100 };
			const message = `Invalid ${operation}: Batch size 32769 exceeds maxBatchSize 100`;
			exactRefusal(
				() =>
					operation === 'insert'
						? adapter.compileInsert(
								{ type: 'insert', table: 't', values: rows },
								options,
							)
						: adapter.compileUpsert(
								{
									type: 'upsert',
									table: 't',
									values: rows,
									onConflict: { columns: ['id'] },
									action: { type: 'doNothing' },
								},
								options,
							),
				message,
			);
			// Mutate retained rows after builder validation, so compilation must honor the limit before shape inspection.
			const retained = [{ a: 1 }];
			const built =
				operation === 'insert'
					? orm.insert('t').values(retained)
					: orm.upsert('t').values(retained).onConflict(['id']).doNothing();
			retained.push(...rows.slice(1));
			exactRefusal(() => built.dump(options), message);
		});
		it(`inspects ${operation} enumerable own keys once per public compilation`, () => {
			let scans = 0;
			const row = new Proxy(
				{ id: 1, a: 2 },
				{
					ownKeys(target) {
						scans++;
						return Reflect.ownKeys(target);
					},
				},
			);
			const built =
				operation === 'insert'
					? orm.insert('t').values([row])
					: orm.upsert('t').values([row]).onConflict(['id']).doNothing();
			const expected = `INSERT INTO t (id, a) VALUES ($1, $2)${operation === 'upsert' ? ' ON CONFLICT (id) DO NOTHING' : ''}`;
			for (const run of [
				() => (operation === 'insert' ? insert([row]) : upsert([row])),
				() => built.dump(),
			]) {
				scans = 0;
				expect(run().sql).toBe(expected);
				expect(scans).toBe(2);
			}
		});
	}
	it('discovers only enumerable own keys', () => {
		const row = Object.defineProperty({ a: 1 }, 'b', {
			value: 2,
			enumerable: false,
		});
		expect(insert([row]).sql).toBe('INSERT INTO t (a) VALUES ($1)');
		expect(orm.insert('t').values([row]).dump().sql).toBe(
			'INSERT INTO t (a) VALUES ($1)',
		);
		const guide = readFileSync(
			new URL('../../../docs/guide/mutations.md', import.meta.url),
			'utf8',
		);
		expect(guide).toContain(
			'Missing enumerable own keys use the column DEFAULT',
		);
		expect(guide).toContain('requires identical enumerable own keys');
		expect(guide).toContain(
			'Batch upsert rows must have identical enumerable own keys',
		);
		const jsdoc = readFileSync(
			new URL('../../../core/src/dx/mutation-builders.ts', import.meta.url),
			'utf8',
		);
		expect(jsdoc).toContain('Missing enumerable own keys use DEFAULT');
		expect(jsdoc).toContain('Rows must share enumerable own keys');
		expect(jsdoc).toContain('Batch rows must share enumerable own keys');
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
