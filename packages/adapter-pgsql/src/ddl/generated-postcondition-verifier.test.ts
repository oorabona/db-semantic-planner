import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
	decodeGeneratedPostcondition,
	type GeneratedPostconditionSession,
	mintGeneratedPostconditionSession,
	verifyGeneratedCheckPostcondition,
	verifyGeneratedIndexPostcondition,
	verifyGeneratedTablePostcondition,
} from './generated-postcondition-verifier.js';

const indexTarget = {
	schema: 'tenant',
	table: 'accounts',
	name: 'accounts_user_id_idx',
};

const tableTarget = {
	schema: 'tenant',
	table: 'accounts',
	name: 'accounts',
};

const tablePostcondition = {
	postconditionVersion: 2 as const,
	kind: 'table' as const,
	columns: [
		{ name: 'id', type: 'integer', nullable: false, hasDefault: false },
	],
};

const indexPostcondition = {
	postconditionVersion: 2 as const,
	kind: 'index' as const,
	index: {
		schema: 'tenant',
		table: 'accounts',
		name: 'accounts_user_id_idx',
		method: 'btree',
		unique: false,
		valid: true as const,
		ready: true as const,
		live: true as const,
		columns: ['UserID'],
		nullsNotDistinct: false,
	},
};

function indexRow(overrides: Record<string, unknown> = {}) {
	return {
		schema_name: 'tenant',
		table_name: 'accounts',
		index_name: 'accounts_user_id_idx',
		method_name: 'btree',
		is_unique: false,
		is_valid: true,
		is_ready: true,
		is_live: true,
		nulls_not_distinct: false,
		is_primary: false,
		is_exclusion: false,
		is_immediate: true,
		is_constraint_owned: false,
		key_count: 1,
		key_columns: ['UserID'],
		key_definitions: ['"UserID"'],
		include_columns: [],
		opclasses: ['int4_ops'],
		key_options: ['0'],
		reloptions: [],
		predicate_expression: null,
		...overrides,
	};
}

function indexExecutor(input: {
	readonly live?: Record<string, unknown>;
	readonly staged?: Record<string, unknown>;
}) {
	const query = vi.fn(async (sql: string) => {
		if (sql.includes('WHERE namespace.nspname'))
			return { rows: [indexRow(input.live)] };
		if (sql.includes('WHERE relation.oid'))
			return { rows: [indexRow(input.staged)] };
		return { rows: [] };
	});
	return {
		query,
		session: mintGeneratedPostconditionSession({ query }),
	};
}

function testSession(
	query: GeneratedPostconditionSession['query'],
): GeneratedPostconditionSession {
	return mintGeneratedPostconditionSession({ query });
}

function tableSession(rows: readonly Record<string, unknown>[]) {
	return testSession(
		vi.fn(async () => ({
			rows: rows.map((row) => ({
				relation_kind: 'r',
				column_default: null,
				collation_name: null,
				identity_kind: '',
				...row,
			})),
		})),
	);
}

function checkRow(overrides: Record<string, unknown> = {}) {
	return {
		expression: "(status = 'Active'::text)",
		validated: true,
		no_inherit: false,
		enforced: true,
		is_local: true,
		inheritance_count: 0,
		parent_id: 0,
		...overrides,
	};
}

describe('generated postcondition verifier', () => {
	it('accepts the catalogue-faithful default btree projection', async () => {
		const executor = indexExecutor({});
		await expect(
			verifyGeneratedIndexPostcondition({
				session: executor.session,
				postcondition: indexPostcondition,
				target: indexTarget,
			}),
		).resolves.toMatchObject({
			kind: 'index',
			projection: { method: 'btree', keyDefinitions: ['"UserID"'] },
		});
		expect(executor.query.mock.calls.map(([sql]) => sql)).toContainEqual(
			expect.stringContaining('USING btree'),
		);
		expect(executor.query.mock.calls.map(([sql]) => sql)).not.toContainEqual(
			expect.stringContaining('INCLUDING GENERATED'),
		);
	});

	it('refuses a quoted identifier that differs by case', async () => {
		await expect(
			verifyGeneratedIndexPostcondition({
				session: indexExecutor({
					staged: { key_columns: ['userid'], key_definitions: ['userid'] },
				}).session,
				postcondition: indexPostcondition,
				target: indexTarget,
			}),
		).rejects.toThrow('postcondition differs');
	});

	it('refuses an expectation carrying an unmodeled index feature', async () => {
		await expect(
			verifyGeneratedIndexPostcondition({
				session: indexExecutor({}).session,
				postcondition: {
					...indexPostcondition,
					index: { ...indexPostcondition.index, ordering: 'DESC' },
				},
				target: indexTarget,
			}),
		).rejects.toThrow('replan');
	});

	it.each([
		['live predicate', '"UserID" > 0', '"UserID" > 1'],
		['staged predicate', '"UserID" > 1', '"UserID" > 0'],
	])('refuses a differing %s after server deparse', async (_side, live, staged) => {
		await expect(
			verifyGeneratedIndexPostcondition({
				session: indexExecutor({
					live: { predicate_expression: live },
					staged: { predicate_expression: staged },
				}).session,
				postcondition: {
					...indexPostcondition,
					index: { ...indexPostcondition.index, where: '"UserID" > 0' },
				},
				target: indexTarget,
			}),
		).rejects.toThrow('postcondition differs');
	});

	it('refuses when the server round-trip is unavailable', async () => {
		const executor = indexExecutor({});
		executor.query.mockImplementationOnce(async () => ({ rows: [indexRow()] }));
		executor.query.mockImplementationOnce(async () => {
			throw new Error('permission denied for schema pg_temp');
		});
		await expect(
			verifyGeneratedIndexPostcondition({
				session: executor.session,
				postcondition: indexPostcondition,
				target: indexTarget,
			}),
		).rejects.toThrow('permission denied');
	});

	it('accepts an exactly server-deparsed CHECK expression', async () => {
		const executor = {
			query: vi.fn(async (sql: string) => {
				if (sql.includes('namespace.nspname'))
					return {
						rows: [checkRow()],
					};
				if (sql.includes('conrelid = $1'))
					return {
						rows: [checkRow()],
					};
				return { rows: [] };
			}),
		};
		await expect(
			verifyGeneratedCheckPostcondition({
				session: testSession(executor.query as never),
				postcondition: {
					postconditionVersion: 2,
					kind: 'constraint',
					constraint: {
						type: 'c',
						expression: "CHECK (status = 'Active')",
						notValid: false,
					},
				},
				target: {
					schema: 'tenant',
					table: 'accounts',
					name: 'accounts_status_check',
				},
			}),
		).resolves.toMatchObject({ kind: 'constraint' });
	});

	it('refuses a case-different CHECK literal and a validation mismatch', async () => {
		const executor = {
			query: vi.fn(async (sql: string) => {
				if (sql.includes('namespace.nspname'))
					return {
						rows: [checkRow({ expression: "(status = 'active'::text)" })],
					};
				if (sql.includes('conrelid = $1'))
					return {
						rows: [checkRow()],
					};
				return { rows: [] };
			}),
		};
		const postcondition = {
			postconditionVersion: 2 as const,
			kind: 'constraint' as const,
			constraint: {
				type: 'c' as const,
				expression: "CHECK (status = 'Active')",
				notValid: false,
			},
		};
		await expect(
			verifyGeneratedCheckPostcondition({
				session: testSession(executor.query as never),
				postcondition,
				target: {
					schema: 'tenant',
					table: 'accounts',
					name: 'accounts_status_check',
				},
			}),
		).rejects.toThrow('postcondition differs');
		executor.query.mockImplementation(async (sql: string) => {
			if (sql.includes('namespace.nspname') || sql.includes('conrelid = $1'))
				return {
					rows: [checkRow({ validated: false })],
				};
			return { rows: [] };
		});
		await expect(
			verifyGeneratedCheckPostcondition({
				session: testSession(executor.query as never),
				postcondition,
				target: {
					schema: 'tenant',
					table: 'accounts',
					name: 'accounts_status_check',
				},
			}),
		).rejects.toThrow('postcondition differs');
	});

	it('rejects legacy rendered definitions with a replan direction', async () => {
		await expect(
			verifyGeneratedIndexPostcondition({
				session: indexExecutor({}).session,
				postcondition: {
					kind: 'index',
					definition:
						'CREATE INDEX accounts_user_id_idx ON accounts ("UserID")',
				},
				target: indexTarget,
			}),
		).rejects.toThrow('replan');
	});

	it.each([
		[
			'catalogue without optional keys',
			{ nulls_not_distinct: false, key_count: 1 },
		],
		[
			'catalogue with optional keys',
			{ nulls_not_distinct: false, key_count: 1 },
		],
		[
			'catalogue with all current keys',
			{ nulls_not_distinct: false, key_count: 1 },
		],
	])('reads a %s index row through dynamic optional catalogue fields', async (_shape, live) => {
		const executor = indexExecutor({ live });
		await expect(
			verifyGeneratedIndexPostcondition({
				session: executor.session,
				postcondition: indexPostcondition,
				target: indexTarget,
			}),
		).resolves.toMatchObject({ kind: 'index' });
		const select = executor.query.mock.calls
			.map(([sql]) => sql)
			.find((sql) => sql.includes('pg_catalog.to_jsonb(index_meta)')) as string;
		expect(select).toContain('pg_catalog.to_jsonb(index_meta)');
		expect(select).toContain("CASE WHEN index_meta_json.value ? 'indnkeyatts'");
		expect(select).toContain(
			"CASE WHEN index_meta_json.value ? 'indnullsnotdistinct'",
		);
	});

	it('accepts reversed reloptions and refuses incomplete index booleans', async () => {
		await expect(
			verifyGeneratedIndexPostcondition({
				session: indexExecutor({
					live: { reloptions: ['fillfactor=90', 'deduplicate_items=off'] },
					staged: { reloptions: ['deduplicate_items=off', 'fillfactor=90'] },
				}).session,
				postcondition: indexPostcondition,
				target: indexTarget,
			}),
		).resolves.toMatchObject({ kind: 'index' });
		await expect(
			verifyGeneratedIndexPostcondition({
				session: indexExecutor({ live: { is_valid: 't' } }).session,
				postcondition: indexPostcondition,
				target: indexTarget,
			}),
		).rejects.toThrow('complete projection');
	});

	it('canonicalizes equivalent reloptions before returning the observed projection', async () => {
		const readProjection = async (reloptions: readonly string[]) =>
			verifyGeneratedIndexPostcondition({
				session: indexExecutor({
					live: { reloptions },
					staged: { reloptions: [...reloptions].reverse() },
				}).session,
				postcondition: indexPostcondition,
				target: indexTarget,
			});
		const first = await readProjection([
			'fillfactor=90',
			'deduplicate_items=off',
		]);
		const second = await readProjection([
			'deduplicate_items=off',
			'fillfactor=90',
		]);
		const digest = (value: unknown) =>
			createHash('sha256').update(JSON.stringify(value)).digest('hex');
		expect(first.projection.reloptions).toEqual([
			'deduplicate_items=off',
			'fillfactor=90',
		]);
		expect(digest(first.projection)).toBe(digest(second.projection));
	});

	it('refuses unsupported column-default relationships and accepts producer shapes', () => {
		for (const column of [
			{ name: 'id', default: "nextval('accounts_id_seq'::regclass)" },
			{ name: 'id', hasDefault: false, default: '0' },
			{ name: 'id', hasDefault: true },
		])
			expect(() =>
				decodeGeneratedPostcondition({
					postconditionVersion: 2,
					kind: 'column',
					column,
				}),
			).toThrow('replan');
		expect(() =>
			decodeGeneratedPostcondition({
				postconditionVersion: 2,
				kind: 'table',
				columns: [
					{ name: 'id', hasDefault: false },
					{ name: 'serial_id', hasDefault: true, default: "nextval('seq')" },
				],
			}),
		).not.toThrow();
	});

	it('refuses duplicate expected table-column names before reading the catalogue', async () => {
		await expect(
			verifyGeneratedTablePostcondition({
				session: tableSession([
					{ column_name: 'id', column_type: 'integer', is_not_null: true },
					{
						column_name: 'payload',
						column_type: 'text',
						is_not_null: false,
					},
				]),
				postcondition: {
					postconditionVersion: 2,
					kind: 'table',
					columns: [
						{ name: 'id', type: 'integer', nullable: false },
						{ name: 'id', type: 'integer', nullable: false },
					],
				},
				target: tableTarget,
			}),
		).rejects.toThrow('replan');
	});

	it('requires a present heap or partitioned table, including for zero columns', async () => {
		const zeroColumnPostcondition = {
			postconditionVersion: 2 as const,
			kind: 'table' as const,
			columns: [],
		};
		await expect(
			verifyGeneratedTablePostcondition({
				session: tableSession([{ column_name: null }]),
				postcondition: zeroColumnPostcondition,
				target: tableTarget,
			}),
		).resolves.toMatchObject({ kind: 'table', projection: { columns: [] } });
		await expect(
			verifyGeneratedTablePostcondition({
				session: tableSession([]),
				postcondition: zeroColumnPostcondition,
				target: tableTarget,
			}),
		).rejects.toThrow('generated table accounts is absent');
		await expect(
			verifyGeneratedTablePostcondition({
				session: tableSession([
					{
						relation_kind: 'v',
						column_name: 'id',
						column_type: 'integer',
						is_not_null: true,
					},
				]),
				postcondition: tablePostcondition,
				target: tableTarget,
			}),
		).rejects.toThrow('generated table accounts is not a table');
	});

	it('refuses table columns that have the right fields in a different ordinal order', async () => {
		await expect(
			verifyGeneratedTablePostcondition({
				session: tableSession([
					{ column_name: 'payload', column_type: 'text', is_not_null: true },
					{ column_name: 'id', column_type: 'text', is_not_null: true },
				]),
				postcondition: {
					postconditionVersion: 2,
					kind: 'table',
					columns: [
						{ name: 'id', type: 'text', nullable: false },
						{ name: 'payload', type: 'text', nullable: false },
					],
				},
				target: tableTarget,
			}),
		).rejects.toThrow('column postcondition differs');
	});

	it.each([
		['non-boolean nullability', { is_not_null: 't' }],
		['unknown identity code', { identity_kind: 'x' }],
	])('refuses an incomplete table projection with %s', async (_label, override) => {
		await expect(
			verifyGeneratedTablePostcondition({
				session: tableSession([
					{
						column_name: 'id',
						column_type: 'integer',
						is_not_null: true,
						...override,
					},
				]),
				postcondition: tablePostcondition,
				target: tableTarget,
			}),
		).rejects.toThrow(
			'generated table verifier could not read a complete projection',
		);
	});

	it('snapshots decoded postconditions and requires usable index state literally true', () => {
		expect(() =>
			decodeGeneratedPostcondition({
				...indexPostcondition,
				index: { ...indexPostcondition.index, valid: false },
			}),
		).toThrow('replan');
		let reads = 0;
		const source = {
			postconditionVersion: 2,
			kind: 'index',
			get index() {
				reads += 1;
				return reads === 1
					? indexPostcondition.index
					: { ...indexPostcondition.index, valid: false };
			},
		};
		const snapshot = decodeGeneratedPostcondition(source);
		expect(reads).toBe(1);
		expect(snapshot).toEqual(indexPostcondition);
		expect(snapshot).not.toBe(source);
		if (snapshot.kind === 'index')
			expect(snapshot.index).not.toBe(indexPostcondition.index);
	});

	it('preserves every own option key in decoded index snapshots', () => {
		const source = JSON.parse(
			'{"postconditionVersion":2,"kind":"index","index":{"schema":"tenant","table":"accounts","name":"accounts_user_id_idx","method":"btree","unique":false,"valid":true,"ready":true,"live":true,"columns":["UserID"],"nullsNotDistinct":false,"opclass":{"__proto__":"text_pattern_ops"},"with":{"__proto__":"fillfactor=90"}}}',
		);
		const snapshot = decodeGeneratedPostcondition(source);
		if (snapshot.kind !== 'index') throw new Error('expected index snapshot');
		for (const [record, value] of [
			[snapshot.index.opclass, 'text_pattern_ops'],
			[snapshot.index.with, 'fillfactor=90'],
		] as const) {
			expect(Object.keys(record ?? {})).toEqual(['__proto__']);
			expect(
				Object.getOwnPropertyDescriptor(record ?? {}, '__proto__')?.value,
			).toBe(value);
		}
	});

	it('refuses declared table collation and identity mismatches', async () => {
		await expect(
			verifyGeneratedTablePostcondition({
				session: tableSession([
					{
						column_name: 'id',
						column_type: 'integer',
						is_not_null: true,
						collation_name: 'POSIX',
						identity_kind: 'a',
					},
				]),
				postcondition: {
					...tablePostcondition,
					columns: [{ ...tablePostcondition.columns[0], collation: 'C' }],
				},
				target: tableTarget,
			}),
		).rejects.toThrow('column postcondition differs');
		await expect(
			verifyGeneratedTablePostcondition({
				session: tableSession([
					{
						column_name: 'id',
						column_type: 'integer',
						is_not_null: true,
						collation_name: 'C',
						identity_kind: 'd',
					},
				]),
				postcondition: {
					...tablePostcondition,
					columns: [{ ...tablePostcondition.columns[0], identity: 'always' }],
				},
				target: tableTarget,
			}),
		).rejects.toThrow('column postcondition differs');
	});

	it('canonicalizes PostgreSQL default collation for text table columns', async () => {
		await expect(
			verifyGeneratedTablePostcondition({
				session: tableSession([
					{
						column_name: 'body',
						column_type: 'text',
						is_not_null: false,
						collation_name: 'default',
					},
				]),
				postcondition: {
					postconditionVersion: 2,
					kind: 'table',
					columns: [
						{ name: 'body', type: 'text', nullable: true, collation: null },
					],
				},
				target: tableTarget,
			}),
		).resolves.toMatchObject({
			kind: 'table',
			projection: { columns: [{ collation: null }] },
		});
	});

	it('ignores undeclared table collation and identity values', async () => {
		await expect(
			verifyGeneratedTablePostcondition({
				session: tableSession([
					{
						column_name: 'id',
						column_type: 'integer',
						is_not_null: true,
						collation_name: 'C',
						identity_kind: 'a',
					},
				]),
				postcondition: tablePostcondition,
				target: tableTarget,
			}),
		).resolves.toMatchObject({
			kind: 'table',
			projection: { columns: [{ collation: 'C', identity: 'always' }] },
		});
	});

	it('defaults absent optional catalogue fields but refuses a present NULL', async () => {
		await expect(
			verifyGeneratedIndexPostcondition({
				session: indexExecutor({}).session,
				postcondition: indexPostcondition,
				target: indexTarget,
			}),
		).resolves.toMatchObject({ kind: 'index' });
		await expect(
			verifyGeneratedIndexPostcondition({
				session: indexExecutor({ live: { nulls_not_distinct: null } }).session,
				postcondition: indexPostcondition,
				target: indexTarget,
			}),
		).rejects.toThrow('complete projection');
	});

	it('refuses a constraint-owned index and an inherited CHECK with matching text', async () => {
		await expect(
			verifyGeneratedIndexPostcondition({
				session: indexExecutor({ live: { is_constraint_owned: true } }).session,
				postcondition: indexPostcondition,
				target: indexTarget,
			}),
		).rejects.toThrow('postcondition differs');
		const query = vi.fn(async (sql: string) => {
			if (sql.includes('namespace.nspname'))
				return {
					rows: [
						checkRow({ is_local: false, inheritance_count: 1, parent_id: 42 }),
					],
				};
			if (sql.includes('conrelid = $1')) return { rows: [checkRow()] };
			return { rows: [] };
		});
		await expect(
			verifyGeneratedCheckPostcondition({
				session: testSession(query as never),
				postcondition: {
					postconditionVersion: 2,
					kind: 'constraint',
					constraint: {
						type: 'c',
						expression: "CHECK (status = 'Active')",
						notValid: false,
					},
				},
				target: {
					schema: 'tenant',
					table: 'accounts',
					name: 'accounts_status_check',
				},
			}),
		).rejects.toThrow('postcondition differs');
	});

	it('refuses unsafe CHECK staging before it issues any query', async () => {
		const query = vi.fn();
		await expect(
			verifyGeneratedCheckPostcondition({
				session: testSession(query as never),
				postcondition: {
					postconditionVersion: 2,
					kind: 'constraint',
					constraint: {
						type: 'c',
						expression: 'CHECK (true); SELECT pg_advisory_lock(42); --',
						notValid: false,
					},
				},
				target: { schema: 'tenant', table: 'accounts', name: 'unsafe_check' },
			}),
		).rejects.toThrow('Unsafe SQL expression');
		expect(query).not.toHaveBeenCalled();
	});

	it('refuses incomplete CHECK projections and NO INHERIT or NOT ENFORCED mismatches', async () => {
		for (const live of [
			{ validated: 'f' },
			{ no_inherit: true },
			{ enforced: false },
		]) {
			const query = vi.fn(async (sql: string) => {
				if (sql.includes('namespace.nspname'))
					return { rows: [checkRow(live)] };
				if (sql.includes('conrelid = $1')) return { rows: [checkRow()] };
				return { rows: [] };
			});
			await expect(
				verifyGeneratedCheckPostcondition({
					session: testSession(query as never),
					postcondition: {
						postconditionVersion: 2,
						kind: 'constraint',
						constraint: {
							type: 'c',
							expression: "CHECK (status = 'Active')",
							notValid: false,
						},
					},
					target: {
						schema: 'tenant',
						table: 'accounts',
						name: 'accounts_status_check',
					},
				}),
			).rejects.toThrow(
				live.validated === 'f'
					? 'complete projection'
					: 'postcondition differs',
			);
		}
	});

	it('honors explicit valid CHECK state over a textual NOT VALID suffix', async () => {
		const query = vi.fn(async (sql: string) => {
			if (sql.includes('namespace.nspname') || sql.includes('conrelid = $1'))
				return { rows: [checkRow()] };
			return { rows: [] };
		});
		await expect(
			verifyGeneratedCheckPostcondition({
				session: testSession(query as never),
				postcondition: {
					postconditionVersion: 2,
					kind: 'constraint',
					constraint: {
						type: 'c',
						expression: "CHECK (status = 'Active') NOT VALID",
						notValid: false,
					},
				},
				target: {
					schema: 'tenant',
					table: 'accounts',
					name: 'accounts_status_check',
				},
			}),
		).resolves.toMatchObject({ kind: 'constraint' });
		expect(query.mock.calls.map(([sql]) => sql)).toContainEqual(
			expect.stringContaining("CHECK (status = 'Active')"),
		);
		expect(query.mock.calls.map(([sql]) => sql)).not.toContainEqual(
			expect.stringContaining("CHECK (status = 'Active') NOT VALID"),
		);
	});

	it.each([
		{
			postconditionVersion: 2,
			kind: 'index',
			index: { ...indexPostcondition.index, method: undefined },
		},
		{ postconditionVersion: 2, kind: 'constraint', constraint: null },
		{
			postconditionVersion: 2,
			kind: 'index',
			index: { ...indexPostcondition.index, columns: [1] },
		},
		{
			postconditionVersion: 2,
			kind: 'index',
			index: { ...indexPostcondition.index, opclass: { other: 'int4_ops' } },
		},
	])('refuses malformed version-2 expectations before querying', async (postcondition) => {
		const query = vi.fn();
		const verify =
			postcondition.kind === 'constraint'
				? verifyGeneratedCheckPostcondition({
						session: testSession(query as never),
						postcondition,
						target: { schema: 'tenant', table: 'accounts', name: 'check' },
					})
				: verifyGeneratedIndexPostcondition({
						session: testSession(query as never),
						postcondition,
						target: indexTarget,
					});
		await expect(verify).rejects.toThrow('replan');
		expect(query).not.toHaveBeenCalled();
	});

	it('refuses a pool-shaped executor instead of treating query as a pinned session', async () => {
		const pool = { query: vi.fn() };
		await expect(
			verifyGeneratedIndexPostcondition({
				session: pool as never,
				postcondition: indexPostcondition,
				target: indexTarget,
			}),
		).rejects.toThrow('adapter-minted exclusive session capability');
		expect(pool.query).not.toHaveBeenCalled();
	});

	it('refuses a hand-built callback as a session capability', async () => {
		const callback = async () => ({ query: vi.fn() });
		await expect(
			verifyGeneratedIndexPostcondition({
				session: callback as never,
				postcondition: indexPostcondition,
				target: indexTarget,
			}),
		).rejects.toThrow('adapter-minted exclusive session capability');
	});
});
