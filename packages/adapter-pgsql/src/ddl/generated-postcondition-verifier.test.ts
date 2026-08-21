import { describe, expect, it, vi } from 'vitest';
import {
	type GeneratedPostconditionSession,
	mintGeneratedPostconditionSession,
	verifyGeneratedCheckPostcondition,
	verifyGeneratedIndexPostcondition,
} from './generated-postcondition-verifier.js';

const indexTarget = {
	schema: 'tenant',
	table: 'accounts',
	name: 'accounts_user_id_idx',
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
