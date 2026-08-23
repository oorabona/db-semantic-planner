import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
	decodeGeneratedPostcondition,
	GeneratedPostconditionBindingResolutionError,
	GeneratedPostconditionProofInFlightError,
	type GeneratedPostconditionSession,
	GeneratedPostconditionSessionDeactivatedError,
	GeneratedPostconditionWorkInFlightError,
	mintGeneratedPostconditionSession,
	verifyGeneratedCheckPostcondition,
	verifyGeneratedColumnPostcondition,
	verifyGeneratedIndexPostcondition,
	verifyGeneratedTablePostcondition,
	verifyGeneratedV3CheckPostcondition,
	verifyGeneratedV3ColumnPostcondition,
	verifyGeneratedV3IndexPostcondition,
	verifyGeneratedV3TablePostcondition,
	withGeneratedPostconditionSession,
	withPinnedGeneratedPostconditionSession,
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

const v3Binding = {
	bindingVersion: 1 as const,
	bindingKind: 'managed-step-address' as const,
};

const tableAddress = {
	engine: 'postgresql',
	database: 'app',
	schema: 'tenant',
	kind: 'table',
	name: 'accounts',
};

const columnAddress = {
	engine: 'postgresql',
	database: 'app',
	schema: 'tenant',
	kind: 'column',
	name: 'id',
	parent: tableAddress,
};

const indexAddress = {
	engine: 'postgresql',
	database: 'app',
	schema: 'tenant',
	kind: 'index',
	name: 'accounts_user_id_idx',
	parent: tableAddress,
};

const checkAddress = {
	engine: 'postgresql',
	database: 'app',
	schema: 'tenant',
	kind: 'constraint',
	name: 'accounts_status_check',
	parent: tableAddress,
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
		if (sql.includes('has_database_privilege'))
			return { rows: [{ has_temp_privilege: true }] };
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

function tableSession(
	rows: readonly Record<string, unknown>[],
	stagedDefaults: Readonly<Record<string, string>> = {},
	sequenceEvidence?: readonly Record<string, unknown>[],
) {
	return testSession(
		vi.fn(async (sql: string, params?: readonly unknown[]) => {
			if (sql.includes('has_database_privilege'))
				return { rows: [{ has_temp_privilege: true }] };
			if (sql.includes('attribute.attname = ANY($2::text[])')) {
				const names = params?.[1] as readonly string[];
				return {
					rows: names.flatMap((name) =>
						stagedDefaults[name] === undefined
							? []
							: [{ column_name: name, column_default: stagedDefaults[name] }],
					),
				};
			}
			return {
				rows: rows.map((row) => ({
					relation_kind: 'r',
					column_default: null,
					generated_sequence_default:
						sequenceEvidence?.some(
							(evidence) => evidence.generated_sequence_default === true,
						) ?? String(row.column_default).startsWith("nextval('"),
					collation_name: null,
					identity_kind: '',
					...row,
				})),
			};
		}),
	);
}

function columnSession(
	live: Record<string, unknown>,
	stagedDefaults: Readonly<Record<string, string>> = {},
	sequenceEvidence?: readonly Record<string, unknown>[],
) {
	return testSession(
		vi.fn(async (sql: string, params?: readonly unknown[]) => {
			if (sql.includes('has_database_privilege'))
				return { rows: [{ has_temp_privilege: true }] };
			if (sql.includes('attribute.attname = ANY($2::text[])')) {
				const names = params?.[1] as readonly string[];
				return {
					rows: names.flatMap((name) =>
						stagedDefaults[name] === undefined
							? []
							: [{ column_name: name, column_default: stagedDefaults[name] }],
					),
				};
			}
			return {
				rows: [
					{
						relation_kind: 'r',
						column_name: 'id',
						column_type: 'integer',
						is_not_null: true,
						column_default: null,
						generated_sequence_default:
							sequenceEvidence?.some(
								(evidence) => evidence.generated_sequence_default === true,
							) ?? String(live.column_default).startsWith("nextval('"),
						collation_name: null,
						identity_kind: '',
						...live,
					},
				],
			};
		}),
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
	it('deactivates a retained capability after the public checkout bracket', async () => {
		const query = vi.fn(async (_sql: string) => ({ rows: [] }));
		const release = vi.fn();
		let retained: GeneratedPostconditionSession | undefined;
		await withGeneratedPostconditionSession(
			{
				connect: async () => ({ query, release }),
			},
			async (session) => {
				retained = session;
				return 'completed';
			},
		);
		if (!retained) throw new Error('expected a retained capability');
		await expect(retained.query('SELECT 1')).rejects.toBeInstanceOf(
			GeneratedPostconditionSessionDeactivatedError,
		);
		expect(release).toHaveBeenCalledWith();
	});

	it('deactivates a retained capability after a pinned protocol-style bracket', async () => {
		const query = vi.fn(async () => ({ rows: [] }));
		let retained: GeneratedPostconditionSession | undefined;
		await withPinnedGeneratedPostconditionSession(
			{ query },
			async (session) => {
				retained = session;
				return 'completed';
			},
		);
		if (!retained) throw new Error('expected a retained capability');
		await expect(retained.query('SELECT 1')).rejects.toBeInstanceOf(
			GeneratedPostconditionSessionDeactivatedError,
		);
	});

	it('refuses an overlapping proof while the first proof completes', async () => {
		let openFirstQuery: (() => void) | undefined;
		let releaseFirstQuery: (() => void) | undefined;
		const firstQueryOpened = new Promise<void>((resolve) => {
			openFirstQuery = resolve;
		});
		const firstQueryReleased = new Promise<void>((resolve) => {
			releaseFirstQuery = resolve;
		});
		let queryCount = 0;
		const query = vi.fn(async () => {
			queryCount += 1;
			if (queryCount === 1) {
				openFirstQuery?.();
				await firstQueryReleased;
			}
			return {
				rows: [
					{
						relation_kind: 'r',
						column_name: 'id',
						column_type: 'integer',
						is_not_null: true,
						column_default: null,
						collation_name: null,
						identity_kind: '',
					},
				],
			};
		});
		await withPinnedGeneratedPostconditionSession(
			{ query },
			async (session) => {
				const first = verifyGeneratedTablePostcondition({
					session,
					postcondition: tablePostcondition,
					target: tableTarget,
				});
				await firstQueryOpened;
				await expect(
					verifyGeneratedTablePostcondition({
						session,
						postcondition: tablePostcondition,
						target: tableTarget,
					}),
				).rejects.toBeInstanceOf(GeneratedPostconditionProofInFlightError);
				releaseFirstQuery?.();
				await expect(first).resolves.toMatchObject({ kind: 'table' });
			},
		);
	});

	it('rejects a successful public checkout callback with proof work in flight', async () => {
		let resolveQueryStarted: (() => void) | undefined;
		let releaseQuery: (() => void) | undefined;
		const queryStarted = new Promise<void>((resolve) => {
			resolveQueryStarted = resolve;
		});
		const queryMayFinish = new Promise<void>((resolve) => {
			releaseQuery = resolve;
		});
		const query = vi.fn(async () => {
			resolveQueryStarted?.();
			await queryMayFinish;
			return {
				rows: [
					{
						relation_kind: 'r',
						column_name: 'id',
						column_type: 'integer',
						is_not_null: true,
						column_default: null,
						collation_name: null,
						identity_kind: '',
					},
				],
			};
		});
		const release = vi.fn();
		let proof: Promise<unknown> | undefined;
		await expect(
			withGeneratedPostconditionSession(
				{ connect: async () => ({ query, release }) },
				async (session) => {
					proof = verifyGeneratedTablePostcondition({
						session,
						postcondition: tablePostcondition,
						target: tableTarget,
					});
					await queryStarted;
					return 'completed';
				},
			),
		).rejects.toBeInstanceOf(GeneratedPostconditionWorkInFlightError);
		expect(release).toHaveBeenCalledWith(expect.any(Error));
		releaseQuery?.();
		if (!proof) throw new Error('expected a proof');
		await expect(proof).resolves.toMatchObject({ kind: 'table' });
	});

	it('rejects a successful pinned callback with proof work in flight', async () => {
		let resolveQueryStarted: (() => void) | undefined;
		let releaseQuery: (() => void) | undefined;
		const queryStarted = new Promise<void>((resolve) => {
			resolveQueryStarted = resolve;
		});
		const queryMayFinish = new Promise<void>((resolve) => {
			releaseQuery = resolve;
		});
		const query = vi.fn(async () => {
			resolveQueryStarted?.();
			await queryMayFinish;
			return {
				rows: [
					{
						relation_kind: 'r',
						column_name: 'id',
						column_type: 'integer',
						is_not_null: true,
						column_default: null,
						collation_name: null,
						identity_kind: '',
					},
				],
			};
		});
		let proof: Promise<unknown> | undefined;
		await expect(
			withPinnedGeneratedPostconditionSession({ query }, async (session) => {
				proof = verifyGeneratedTablePostcondition({
					session,
					postcondition: tablePostcondition,
					target: tableTarget,
				});
				await queryStarted;
				return 'completed';
			}),
		).rejects.toBeInstanceOf(GeneratedPostconditionWorkInFlightError);
		releaseQuery?.();
		if (!proof) throw new Error('expected a proof');
		await expect(proof).resolves.toMatchObject({ kind: 'table' });
	});

	it('evicts a replan when the caller queried before proof', async () => {
		const release = vi.fn();
		await expect(
			withGeneratedPostconditionSession(
				{ connect: async () => ({ query: vi.fn(), release }) },
				async (session) => {
					await session.query('BEGIN');
					return verifyGeneratedIndexPostcondition({
						session,
						postcondition: {
							...indexPostcondition,
							index: {
								...indexPostcondition.index,
								ordering: 'DESC',
							},
						},
						target: indexTarget,
					});
				},
			),
		).rejects.toThrow('replan');
		expect(release).toHaveBeenCalledWith(expect.any(Error));
	});

	it('evicts a scratch mismatch when the caller set session state before proof', async () => {
		const query = vi.fn(async (sql: string) => {
			if (sql.includes('WHERE namespace.nspname'))
				return { rows: [indexRow()] };
			if (sql.includes('WHERE relation.oid'))
				return { rows: [indexRow({ key_columns: ['other'] })] };
			return { rows: [] };
		});
		const release = vi.fn();
		await expect(
			withGeneratedPostconditionSession(
				{ connect: async () => ({ query, release }) },
				async (session) => {
					await session.query('SET ROLE verifier_test');
					return verifyGeneratedIndexPostcondition({
						session,
						postcondition: indexPostcondition,
						target: indexTarget,
					});
				},
			),
		).rejects.toThrow('postcondition differs');
		expect(release).toHaveBeenCalledWith(expect.any(Error));
	});

	it('evicts a falsy callback failure with a truthy release error', async () => {
		const query = vi.fn(async () => ({ rows: [] }));
		const release = vi.fn();
		const client = { query, release };
		await expect(
			withGeneratedPostconditionSession(
				{ connect: async () => client },
				async (session) => {
					await session.query('BEGIN');
					throw undefined;
				},
			),
		).rejects.toBeUndefined();
		const [releaseArgument] = release.mock.calls[0] ?? [];
		expect(releaseArgument).toBeInstanceOf(Error);
		expect(releaseArgument).toBeTruthy();
		expect(releaseArgument).toHaveProperty('cause', undefined);
	});

	it('evicts a safe-marked failure after the callback opens a transaction', async () => {
		const release = vi.fn();
		let failure: unknown;
		await expect(
			withGeneratedPostconditionSession(
				{
					connect: async () => ({ query: vi.fn(), release }),
				},
				async (session) => {
					try {
						await verifyGeneratedIndexPostcondition({
							session,
							postcondition: {
								...indexPostcondition,
								index: {
									...indexPostcondition.index,
									ordering: 'DESC',
								},
							},
							target: indexTarget,
						});
					} catch (error) {
						failure = error;
						await session.query('BEGIN');
						throw error;
					}
				},
			),
		).rejects.toThrow('replan');
		if (!failure) throw new Error('expected a safe-marked failure');
		expect(release).toHaveBeenCalledWith(failure);
	});

	it('evicts a safe-marked failure from a previous checkout', async () => {
		let marked: unknown;
		const firstRelease = vi.fn();
		await expect(
			withGeneratedPostconditionSession(
				{ connect: async () => ({ query: vi.fn(), release: firstRelease }) },
				async (session) => {
					try {
						await verifyGeneratedIndexPostcondition({
							session,
							postcondition: {
								...indexPostcondition,
								index: {
									...indexPostcondition.index,
									ordering: 'DESC',
								},
							},
							target: indexTarget,
						});
					} catch (error) {
						marked = error;
						throw error;
					}
				},
			),
		).rejects.toThrow('replan');
		expect(firstRelease).toHaveBeenCalledWith();
		if (!marked) throw new Error('expected a marked failure');

		const secondRelease = vi.fn();
		await expect(
			withGeneratedPostconditionSession(
				{ connect: async () => ({ query: vi.fn(), release: secondRelease }) },
				async () => {
					throw marked;
				},
			),
		).rejects.toBe(marked);
		expect(secondRelease).toHaveBeenCalledWith(marked);
	});

	it('keeps an unchanged-session replan and a clean scratch mismatch reusable', async () => {
		const replanRelease = vi.fn();
		await expect(
			withGeneratedPostconditionSession(
				{
					connect: async () => ({
						query: vi.fn(),
						release: replanRelease,
					}),
				},
				(session) =>
					verifyGeneratedIndexPostcondition({
						session,
						postcondition: {
							...indexPostcondition,
							index: { ...indexPostcondition.index, ordering: 'DESC' },
						},
						target: indexTarget,
					}),
			),
		).rejects.toThrow('replan');
		expect(replanRelease).toHaveBeenCalledWith();

		const query = vi.fn(async (sql: string) => {
			if (sql.includes('WHERE namespace.nspname'))
				return { rows: [indexRow()] };
			if (sql.includes('WHERE relation.oid'))
				return { rows: [indexRow({ key_columns: ['other'] })] };
			return { rows: [] };
		});
		const mismatchRelease = vi.fn();
		await expect(
			withGeneratedPostconditionSession(
				{ connect: async () => ({ query, release: mismatchRelease }) },
				(session) =>
					verifyGeneratedIndexPostcondition({
						session,
						postcondition: indexPostcondition,
						target: indexTarget,
					}),
			),
		).rejects.toThrow('postcondition differs');
		expect(mismatchRelease).toHaveBeenCalledWith();
	});

	it('evicts cleanup and unknown failures, and preserves proof failures from release errors', async () => {
		const cleanupFailure = new Error('rollback failed');
		const cleanupQuery = vi.fn(async (sql: string) => {
			if (sql.includes('WHERE namespace.nspname'))
				return { rows: [indexRow()] };
			if (sql.includes('WHERE relation.oid'))
				return { rows: [indexRow({ key_columns: ['other'] })] };
			if (sql.startsWith('ROLLBACK TO SAVEPOINT')) throw cleanupFailure;
			return { rows: [] };
		});
		const cleanupRelease = vi.fn();
		await expect(
			withGeneratedPostconditionSession(
				{
					connect: async () => ({
						query: cleanupQuery,
						release: cleanupRelease,
					}),
				},
				(session) =>
					verifyGeneratedIndexPostcondition({
						session,
						postcondition: indexPostcondition,
						target: indexTarget,
					}),
			),
		).rejects.toThrow('scratch cleanup failed');
		expect(cleanupRelease.mock.calls[0]).toHaveLength(1);

		const unknown = new Error('unknown failure');
		const unknownRelease = vi.fn();
		await expect(
			withGeneratedPostconditionSession(
				{
					connect: async () => ({
						query: vi.fn(),
						release: unknownRelease,
					}),
				},
				async () => {
					throw unknown;
				},
			),
		).rejects.toBe(unknown);
		expect(unknownRelease).toHaveBeenCalledWith(unknown);

		const proofFailure = new Error('proof failure');
		const releaseFailure = new Error('release failure');
		await expect(
			withGeneratedPostconditionSession(
				{
					connect: async () => ({
						query: vi.fn(),
						release: async () => {
							throw releaseFailure;
						},
					}),
				},
				async () => {
					throw proofFailure;
				},
			),
		).rejects.toSatisfy(
			(error: unknown) =>
				error instanceof AggregateError &&
				error.errors.includes(proofFailure) &&
				error.errors.includes(releaseFailure) &&
				error.cause === proofFailure,
		);
	});

	it('sets the shared scratch lock bound for standalone checkouts', async () => {
		for (const [lockTimeoutMs, expected] of [
			[undefined, "SET LOCAL lock_timeout = '5000ms'"],
			[37, "SET LOCAL lock_timeout = '37ms'"],
		] as const) {
			const query = vi.fn(async (sql: string) => {
				if (sql.includes('WHERE namespace.nspname'))
					return { rows: [indexRow()] };
				if (sql.includes('WHERE relation.oid')) return { rows: [indexRow()] };
				return { rows: [] };
			});
			await withGeneratedPostconditionSession(
				{ connect: async () => ({ query, release: vi.fn() }) },
				(session) =>
					verifyGeneratedIndexPostcondition({
						session,
						postcondition: indexPostcondition,
						target: indexTarget,
					}),
				lockTimeoutMs,
			);
			expect(query.mock.calls.map(([sql]) => sql)).toContain(expected);
		}
	});

	it('preserves an enclosing explicit lock bound when the pinned bracket omits one', async () => {
		const query = vi.fn(async (sql: string) => {
			if (sql.includes('WHERE namespace.nspname'))
				return { rows: [indexRow()] };
			if (sql.includes('WHERE relation.oid')) return { rows: [indexRow()] };
			return { rows: [] };
		});
		await query('BEGIN');
		await query("SET LOCAL lock_timeout = '37ms'");
		await withPinnedGeneratedPostconditionSession({ query }, (session) =>
			verifyGeneratedIndexPostcondition({
				session,
				postcondition: indexPostcondition,
				target: indexTarget,
			}),
		);
		const queries = query.mock.calls.map(([sql]) => sql);
		expect(queries).toContain("SET LOCAL lock_timeout = '37ms'");
		expect(queries).not.toContain("SET LOCAL lock_timeout = '5000ms'");
		expect(
			queries.filter((sql) => sql === "SET LOCAL lock_timeout = '37ms'"),
		).toHaveLength(1);
	});

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

	it('keeps persisted v2 column defaults without defaultKind decodable', () => {
		expect(
			decodeGeneratedPostcondition({
				postconditionVersion: 2,
				kind: 'column',
				column: { name: 'status', hasDefault: true, default: "'pending'" },
			}),
		).toEqual({
			postconditionVersion: 2,
			kind: 'column',
			column: { name: 'status', hasDefault: true, default: "'pending'" },
		});
	});

	it('refuses a persisted setting-dependent backslash default and stages E literals', async () => {
		expect(() =>
			decodeGeneratedPostcondition({
				postconditionVersion: 2,
				kind: 'column',
				column: {
					name: 'path',
					hasDefault: true,
					default: String.raw`'C:\\Users'`,
				},
			}),
		).toThrow('replan');
		await expect(
			verifyGeneratedTablePostcondition({
				session: tableSession(
					[
						{
							column_name: 'path',
							column_type: 'text',
							is_not_null: false,
							column_default: String.raw`'C:\\Users'::text`,
						},
					],
					{ path: String.raw`'C:\\Users'::text` },
				),
				postcondition: {
					postconditionVersion: 2,
					kind: 'table',
					columns: [
						{
							name: 'path',
							hasDefault: true,
							defaultKind: 'authored',
							default: String.raw`E'C:\\Users'`,
						},
					],
				},
				target: tableTarget,
			}),
		).resolves.toMatchObject({ kind: 'table' });
	});

	it('compares authored text defaults through paired server deparses', async () => {
		await expect(
			verifyGeneratedTablePostcondition({
				session: tableSession(
					[
						{
							column_name: 'status',
							column_type: 'text',
							is_not_null: false,
							column_default: "'pending'::text",
						},
					],
					{ status: "'pending'::text" },
				),
				postcondition: {
					postconditionVersion: 2,
					kind: 'table',
					columns: [
						{
							name: 'status',
							type: 'text',
							nullable: true,
							hasDefault: true,
							defaultKind: 'authored',
							default: "'pending'",
						},
					],
				},
				target: tableTarget,
			}),
		).resolves.toMatchObject({ kind: 'table' });
		await expect(
			verifyGeneratedTablePostcondition({
				session: tableSession(
					[
						{
							column_name: 'status',
							column_type: 'text',
							is_not_null: false,
							column_default: "'pending'::text",
						},
					],
					{ status: "'draft'::text" },
				),
				postcondition: {
					postconditionVersion: 2,
					kind: 'table',
					columns: [
						{
							name: 'status',
							type: 'text',
							nullable: true,
							hasDefault: true,
							defaultKind: 'authored',
							default: "'draft'",
						},
					],
				},
				target: tableTarget,
			}),
		).rejects.toThrow('column postcondition differs');
	});

	it('stages every authored default with one ALTER and one catalogue projection', async () => {
		const query = vi.fn(async (sql: string) => {
			if (sql.includes('has_database_privilege'))
				return { rows: [{ has_temp_privilege: true }] };
			if (sql.includes('attribute.attname = ANY($2::text[])'))
				return {
					rows: [
						{ column_name: 'status', column_default: "'pending'::text" },
						{ column_name: 'path', column_default: "'C:\\\\Users'::text" },
					],
				};
			if (sql.includes('WHERE namespace.nspname'))
				return {
					rows: [
						{
							relation_kind: 'r',
							column_name: 'status',
							column_type: 'text',
							is_not_null: false,
							column_default: "'pending'::text",
							generated_sequence_default: false,
							collation_name: null,
							identity_kind: '',
						},
						{
							relation_kind: 'r',
							column_name: 'path',
							column_type: 'text',
							is_not_null: false,
							column_default: "'C:\\\\Users'::text",
							generated_sequence_default: false,
							collation_name: null,
							identity_kind: '',
						},
					],
				};
			return { rows: [] };
		});
		await expect(
			verifyGeneratedTablePostcondition({
				session: testSession(query),
				postcondition: {
					postconditionVersion: 2,
					kind: 'table',
					columns: [
						{
							name: 'status',
							hasDefault: true,
							defaultKind: 'authored',
							default: "'pending'",
						},
						{
							name: 'path',
							hasDefault: true,
							defaultKind: 'authored',
							default: String.raw`E'C:\\Users'`,
						},
					],
				},
				target: tableTarget,
			}),
		).resolves.toMatchObject({ kind: 'table' });
		const statements = query.mock.calls.map(([sql]) => sql);
		const alterations = statements.filter((sql) =>
			sql.startsWith('ALTER TABLE'),
		);
		expect(alterations).toHaveLength(1);
		expect(alterations[0]).toContain(', ALTER COLUMN "path" SET DEFAULT');
		expect(
			statements.filter((sql) =>
				sql.includes('attribute.attname = ANY($2::text[])'),
			),
		).toHaveLength(1);
	});

	it('translates a vanished authored-default target at either ACCESS SHARE lock and releases cleanly', async () => {
		const cases: readonly {
			readonly absent: string;
			readonly verify: (
				session: GeneratedPostconditionSession,
			) => Promise<unknown>;
		}[] = [
			{
				absent: 'generated table accounts is absent',
				verify: (session: GeneratedPostconditionSession) =>
					verifyGeneratedTablePostcondition({
						session,
						postcondition: {
							postconditionVersion: 2,
							kind: 'table',
							columns: [
								{
									name: 'id',
									hasDefault: true,
									defaultKind: 'authored',
									default: '1',
								},
							],
						},
						target: tableTarget,
					}),
			},
			{
				absent: 'generated column id is absent',
				verify: (session: GeneratedPostconditionSession) =>
					verifyGeneratedColumnPostcondition({
						session,
						postcondition: {
							postconditionVersion: 2,
							kind: 'column',
							column: {
								name: 'id',
								hasDefault: true,
								defaultKind: 'authored',
								default: '1',
							},
						},
						target: { ...tableTarget, name: 'id' },
					}),
			},
		] as const;
		for (const testCase of cases) {
			const query = vi.fn(async (sql: string) => {
				if (sql.startsWith('LOCK TABLE')) {
					const error = new Error('relation does not exist') as Error & {
						code: string;
					};
					error.code = '42P01';
					throw error;
				}
				return { rows: [] };
			});
			const release = vi.fn();
			await expect(
				withGeneratedPostconditionSession(
					{ connect: async () => ({ query, release }) },
					testCase.verify,
				),
			).rejects.toThrow(testCase.absent);
			expect(release).toHaveBeenCalledWith();
			expect(query.mock.calls.map(([sql]) => sql)).toContain(
				`LOCK TABLE "tenant"."accounts" IN ACCESS SHARE MODE`,
			);
		}
	});

	it('requires generated sequence defaults by relation kind and ownership OIDs', async () => {
		const serialPostcondition = {
			postconditionVersion: 2 as const,
			kind: 'column' as const,
			column: {
				name: 'id',
				type: 'integer',
				nullable: false,
				hasDefault: true,
				defaultKind: 'generated-sequence' as const,
			},
		};
		await expect(
			verifyGeneratedColumnPostcondition({
				session: columnSession({
					column_default: "nextval('renamed_id_seq'::regclass)",
				}),
				postcondition: serialPostcondition,
				target: { ...tableTarget, name: 'id' },
			}),
		).resolves.toMatchObject({ kind: 'column' });
		for (const evidence of [
			[
				{
					invokes_nextval: false,
					sequence_relation_kind: 'r',
					owned_by_column: false,
				},
			],
			[
				{
					invokes_nextval: false,
					sequence_relation_kind: 'S',
					owned_by_column: false,
				},
			],
		] as const)
			await expect(
				verifyGeneratedColumnPostcondition({
					session: columnSession(
						{ column_default: "nextval('renamed_id_seq'::regclass)" },
						{},
						evidence,
					),
					postcondition: serialPostcondition,
					target: { ...tableTarget, name: 'id' },
				}),
			).rejects.toThrow('default postcondition differs');
		await expect(
			verifyGeneratedColumnPostcondition({
				session: columnSession({ column_default: '5' }),
				postcondition: serialPostcondition,
				target: { ...tableTarget, name: 'id' },
			}),
		).rejects.toThrow('default postcondition differs');
		await expect(
			verifyGeneratedColumnPostcondition({
				session: columnSession(
					{
						column_default: "nextval('accounts_id_seq'::regclass)",
					},
					{ id: '5' },
				),
				postcondition: {
					postconditionVersion: 2,
					kind: 'column',
					column: {
						name: 'id',
						hasDefault: true,
						defaultKind: 'authored',
						default: '5',
					},
				},
				target: { ...tableTarget, name: 'id' },
			}),
		).rejects.toThrow('default postcondition differs');
	});

	it.each([
		"currval('accounts_id_seq'::regclass)",
		"nextval('accounts_id_seq'::regclass) + 1",
		"'accounts_id_seq'::regclass::oid",
	])('refuses an owned sequence default without the SERIAL nextval shape: %s', async (column_default) => {
		await expect(
			verifyGeneratedColumnPostcondition({
				session: columnSession({ column_default }, {}, [
					{ generated_sequence_default: false },
				]),
				postcondition: {
					postconditionVersion: 2,
					kind: 'column',
					column: {
						name: 'id',
						hasDefault: true,
						defaultKind: 'generated-sequence',
					},
				},
				target: { ...tableTarget, name: 'id' },
			}),
		).rejects.toThrow('default postcondition differs');
	});

	it('refuses a view column and releases successful catalogue absence cleanly', async () => {
		await expect(
			verifyGeneratedColumnPostcondition({
				session: columnSession({ relation_kind: 'v' }),
				postcondition: {
					postconditionVersion: 2,
					kind: 'column',
					column: { name: 'id', hasDefault: false },
				},
				target: { ...tableTarget, name: 'id' },
			}),
		).rejects.toThrow('parent is not a table');
		const query = vi.fn(async () => ({ rows: [] }));
		const release = vi.fn();
		await expect(
			withGeneratedPostconditionSession(
				{ connect: async () => ({ query, release }) },
				(session) =>
					verifyGeneratedColumnPostcondition({
						session,
						postcondition: {
							postconditionVersion: 2,
							kind: 'column',
							column: { name: 'id', hasDefault: false },
						},
						target: { ...tableTarget, name: 'id' },
					}),
			),
		).rejects.toThrow('generated column id is absent');
		expect(release).toHaveBeenCalledWith();
	});

	it('routes table generated-sequence defaults through the dependency proof', async () => {
		const serialPostcondition = {
			postconditionVersion: 2 as const,
			kind: 'table' as const,
			columns: [
				{
					name: 'id',
					type: 'INTEGER',
					nullable: false,
					hasDefault: true,
					defaultKind: 'generated-sequence' as const,
				},
			],
		};
		await expect(
			verifyGeneratedTablePostcondition({
				session: tableSession([
					{
						column_name: 'id',
						column_type: 'integer',
						is_not_null: true,
						column_default: "nextval('accounts_id_seq'::regclass)",
					},
				]),
				postcondition: serialPostcondition,
				target: tableTarget,
			}),
		).resolves.toMatchObject({ kind: 'table' });
		await expect(
			verifyGeneratedTablePostcondition({
				session: tableSession([
					{
						column_name: 'id',
						column_type: 'integer',
						is_not_null: true,
						column_default: '42',
					},
				]),
				postcondition: serialPostcondition,
				target: tableTarget,
			}),
		).rejects.toThrow('column postcondition differs');
		await expect(
			verifyGeneratedTablePostcondition({
				session: tableSession(
					[
						{
							column_name: 'id',
							column_type: 'integer',
							is_not_null: true,
							column_default: '42',
						},
					],
					{ id: '42' },
				),
				postcondition: {
					postconditionVersion: 2,
					kind: 'table',
					columns: [
						{
							name: 'id',
							hasDefault: true,
							defaultKind: 'authored',
							default: '42',
						},
					],
				},
				target: tableTarget,
			}),
		).resolves.toMatchObject({ kind: 'table' });
	});

	it('names the standalone field whose postcondition differs', async () => {
		await expect(
			verifyGeneratedColumnPostcondition({
				session: columnSession({ column_type: 'text' }),
				postcondition: {
					postconditionVersion: 2,
					kind: 'column',
					column: {
						name: 'id',
						type: 'integer',
						nullable: false,
						hasDefault: false,
					},
				},
				target: { ...tableTarget, name: 'id' },
			}),
		).rejects.toThrow('generated column id type postcondition differs');
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

	it('resolves each v3 binding before delegating the existing structural proof', async () => {
		const tableQuery = vi.fn(async (sql: string) => {
			if (sql.startsWith('SELECT relation.relkind AS relation_kind FROM'))
				return { rows: [{ relation_kind: 'r' }] };
			if (sql.includes('attribute.attname = ANY')) return { rows: [] };
			return {
				rows: [
					{
						relation_kind: 'r',
						column_name: 'id',
						column_type: 'integer',
						is_not_null: true,
						column_default: null,
						generated_sequence_default: false,
						collation_name: null,
						identity_kind: '',
					},
				],
			};
		});
		await expect(
			verifyGeneratedV3TablePostcondition({
				session: testSession(tableQuery as never),
				postcondition: {
					postconditionVersion: 3,
					targetBinding: v3Binding,
					declaration: {
						canonicalFormVersion: 1,
						kind: 'table',
						columns: [
							{
								name: 'id',
								type: 'integer',
								nullable: false,
								default: {
									defaultKind: 'none',
									hasDefault: false,
									identity: null,
								},
							},
						],
					},
				},
				address: tableAddress,
			}),
		).resolves.toMatchObject({ kind: 'table' });
		expect(tableQuery).toHaveBeenCalledTimes(2);

		const columnQuery = vi.fn(async (sql: string) => {
			if (
				sql.includes(
					'attribute.attname AS column_name FROM pg_catalog.pg_namespace',
				)
			)
				return { rows: [{ relation_kind: 'r', column_name: 'id' }] };
			return {
				rows: [
					{
						relation_kind: 'r',
						column_name: 'id',
						column_type: 'integer',
						is_not_null: true,
						column_default: null,
						generated_sequence_default: false,
						collation_name: null,
						identity_kind: '',
					},
				],
			};
		});
		await expect(
			verifyGeneratedV3ColumnPostcondition({
				session: testSession(columnQuery as never),
				postcondition: {
					postconditionVersion: 3,
					targetBinding: v3Binding,
					declaration: {
						canonicalFormVersion: 1,
						kind: 'column',
						column: { type: 'integer', nullable: false },
					},
				},
				address: columnAddress,
			}),
		).resolves.toMatchObject({ kind: 'column' });
		expect(columnQuery).toHaveBeenCalledTimes(2);

		const indexQuery = vi.fn(async (sql: string) => {
			if (sql.startsWith('SELECT index_relation.relkind AS relation_kind'))
				return { rows: [{ relation_kind: 'i', table_name: 'accounts' }] };
			if (sql.includes('has_database_privilege'))
				return { rows: [{ has_temp_privilege: true }] };
			if (sql.includes('WHERE namespace.nspname'))
				return { rows: [indexRow()] };
			if (sql.includes('WHERE relation.oid')) return { rows: [indexRow()] };
			return { rows: [] };
		});
		await expect(
			verifyGeneratedV3IndexPostcondition({
				session: testSession(indexQuery as never),
				postcondition: {
					postconditionVersion: 3,
					targetBinding: v3Binding,
					declaration: {
						canonicalFormVersion: 1,
						kind: 'index',
						index: {
							method: 'btree',
							unique: false,
							valid: true,
							ready: true,
							live: true,
							columns: ['UserID'],
							nullsNotDistinct: false,
						},
					},
				},
				address: indexAddress,
			}),
		).resolves.toMatchObject({ kind: 'index' });
		expect(indexQuery).toHaveBeenCalledWith(
			expect.stringContaining('FROM pg_catalog.pg_class index_relation'),
			['tenant', 'accounts_user_id_idx'],
		);

		const checkQuery = vi.fn(async (sql: string) => {
			if (
				sql.startsWith(
					'SELECT relation.relkind AS relation_kind, constraint_item',
				)
			)
				return {
					rows: [
						{ relation_kind: 'r', constraint_name: 'accounts_status_check' },
					],
				};
			if (sql.includes('has_database_privilege'))
				return { rows: [{ has_temp_privilege: true }] };
			if (sql.includes('namespace.nspname')) return { rows: [checkRow()] };
			if (sql.includes('conrelid = $1')) return { rows: [checkRow()] };
			return { rows: [] };
		});
		await expect(
			verifyGeneratedV3CheckPostcondition({
				session: testSession(checkQuery as never),
				postcondition: {
					postconditionVersion: 3,
					targetBinding: v3Binding,
					declaration: {
						canonicalFormVersion: 1,
						kind: 'check',
						check: {
							expression: {
								canonicalFormVersion: 1,
								sql: "CHECK (status = 'Active')",
							},
							notValid: false,
						},
					},
				},
				address: checkAddress,
			}),
		).resolves.toMatchObject({ kind: 'constraint' });
		expect(checkQuery).toHaveBeenCalledWith(
			expect.stringContaining('FROM pg_catalog.pg_constraint constraint_item'),
			['tenant', 'accounts', 'accounts_status_check'],
		);
	});

	it('raises the named v3 binding failure before issuing structural queries', async () => {
		const query = vi.fn(async (_sql: string) => ({ rows: [] }));
		await expect(
			verifyGeneratedV3ColumnPostcondition({
				session: testSession(query as never),
				postcondition: {
					postconditionVersion: 3,
					targetBinding: v3Binding,
					declaration: {
						canonicalFormVersion: 1,
						kind: 'column',
						column: { type: 'integer' },
					},
				},
				address: columnAddress,
			}),
		).rejects.toMatchObject({
			name: 'GeneratedPostconditionBindingResolutionError',
			sought: 'column tenant.accounts.id',
			found: 'absent',
		});
		expect(query).toHaveBeenCalledTimes(1);
		expect(query.mock.calls[0]?.[0]).toContain(
			'attribute.attname AS column_name FROM pg_catalog.pg_namespace',
		);
	});

	it('does not let a structural lookalike satisfy an unresolved v3 binding', async () => {
		const query = vi.fn(async (sql: string) => {
			if (
				sql.includes(
					'attribute.attname AS column_name FROM pg_catalog.pg_namespace',
				)
			)
				return { rows: [] };
			// This is a structurally identical id column at another address. If the
			// resolver were bypassed, the old proof would incorrectly accept it.
			return {
				rows: [
					{
						relation_kind: 'r',
						column_name: 'id',
						column_type: 'integer',
						is_not_null: true,
						column_default: null,
						generated_sequence_default: false,
						collation_name: null,
						identity_kind: '',
					},
				],
			};
		});
		await expect(
			verifyGeneratedV3ColumnPostcondition({
				session: testSession(query as never),
				postcondition: {
					postconditionVersion: 3,
					targetBinding: v3Binding,
					declaration: {
						canonicalFormVersion: 1,
						kind: 'column',
						column: { type: 'integer', nullable: false },
					},
				},
				address: columnAddress,
			}),
		).rejects.toBeInstanceOf(GeneratedPostconditionBindingResolutionError);
		expect(query).toHaveBeenCalledTimes(1);
	});

	it('names the observed slot when a v3 binding resolves to a different object', async () => {
		const query = vi.fn(async () => ({
			rows: [{ relation_kind: 'i', table_name: 'audit_accounts' }],
		}));
		await expect(
			verifyGeneratedV3IndexPostcondition({
				session: testSession(query as never),
				postcondition: {
					postconditionVersion: 3,
					targetBinding: v3Binding,
					declaration: {
						canonicalFormVersion: 1,
						kind: 'index',
						index: {
							method: 'btree',
							unique: false,
							valid: true,
							ready: true,
							live: true,
							columns: ['UserID'],
							nullsNotDistinct: false,
						},
					},
				},
				address: indexAddress,
			}),
		).rejects.toMatchObject({
			sought: 'index tenant.accounts.accounts_user_id_idx',
			found: 'index tenant.audit_accounts.accounts_user_id_idx',
		});
		expect(query).toHaveBeenCalledTimes(1);
	});
});
