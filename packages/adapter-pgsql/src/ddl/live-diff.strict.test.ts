import { ModelIRImpl } from '@dbsp/core';
import type { ColumnIR, EnumIR, ModelIR, TableIR } from '@dbsp/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PgsqlAdapter } from '../pgsql-adapter.js';
import type { CheckConstraintNewEnumValueError as CheckConstraintNewEnumValueErrorType } from './live-diff.js';
import {
	ExpressionCanonicalizationUnavailableError,
	type SchemaDiff,
} from './schema-diff.js';

const mockCanonicalizeExpressionSurfaces = vi.fn();

vi.mock('../expression-canonicalizer.js', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../expression-canonicalizer.js')>();
	return {
		...actual,
		canonicalizeExpressionSurfaces: (...args: unknown[]) =>
			mockCanonicalizeExpressionSurfaces(...args),
	};
});

const {
	CheckConstraintNewEnumValueError,
	comparePgsqlDatabaseSchema,
	ExpressionKeyedIndexPredicateCanonicalizationUnsupportedError,
	IndexPredicateCanonicalizationError,
	NonConvergentSchemaDiffError,
	PartialIndexPredicateNewEnumValueError,
	RawIndexPredicateFallbackError,
} = await import('./live-diff.js');
const {
	CheckConstraintNewEnumValueError: RootCheckConstraintNewEnumValueError,
	ColumnDefaultCanonicalizationError: RootColumnDefaultCanonicalizationError,
} = await import('../index.js');
const { ColumnDefaultCanonicalizationError } = await import(
	'../expression-canonicalizer.js'
);
const { PlannedSchemaStagingError } = await import(
	'../expression-canonicalizer.js'
);

function makeCol(name: string, overrides: Partial<ColumnIR> = {}): ColumnIR {
	return {
		name,
		type: 'number',
		nullable: false,
		...overrides,
	};
}

function makeTable(overrides: Partial<TableIR> & { name: string }): TableIR {
	return {
		columns: [makeCol('id')],
		foreignKeys: [],
		indexes: [],
		...overrides,
	};
}

function makeModel(
	tables: readonly TableIR[],
	enums?: readonly EnumIR[],
): ModelIR {
	return new ModelIRImpl(
		new Map(tables.map((table) => [table.name, table])),
		new Map(),
		enums === undefined
			? undefined
			: new Map(enums.map((enumDef) => [enumDef.name, enumDef])),
	);
}

function checkExpressionDiff(
	table: string,
	constraint: string,
	databaseExpression: string,
	desiredExpression: string,
): SchemaDiff {
	return {
		changes: [
			{
				kind: 'drop_check_constraint',
				table,
				destructive: true,
				details: `Drop CHECK constraint "${constraint}" (expression changed)`,
				meta: {
					check: { name: constraint, expression: databaseExpression },
				},
			},
			{
				kind: 'add_check_constraint',
				table,
				destructive: false,
				details: `Add CHECK constraint "${constraint}" ${desiredExpression}`,
				meta: {
					check: { name: constraint, expression: desiredExpression },
				},
			},
		],
		hasDestructive: true,
		summary: {
			tables: { added: 0, dropped: 0 },
			columns: { added: 0, dropped: 0, altered: 0 },
			indexes: { added: 0, dropped: 0 },
			constraints: { added: 1, dropped: 1, altered: 0 },
		},
	};
}

function makeAdapter(
	dbModel: ModelIR,
	withScratchScope?: (
		fn: (scratch: PgsqlAdapter) => Promise<unknown>,
	) => Promise<unknown>,
): PgsqlAdapter {
	const adapter = {
		introspect: vi.fn(async () => dbModel),
		withScratchScope: vi.fn(
			withScratchScope ??
				(async (fn) => fn(adapter as unknown as PgsqlAdapter)),
		),
	} as unknown as PgsqlAdapter;
	return adapter;
}

function makeCheckFallbackModels(): {
	readonly desired: ModelIR;
	readonly dbModel: ModelIR;
} {
	const desired = makeModel([
		makeTable({
			name: 'users',
			checkConstraints: [{ name: 'users_age_check', expression: 'age > 0' }],
		}),
	]);
	const dbModel = makeModel([
		makeTable({
			name: 'users',
			checkConstraints: [
				{ name: 'users_age_check', expression: 'CHECK ((age > 0))' },
			],
		}),
	]);
	return { desired, dbModel };
}

function pgError(code: string, message: string): Error {
	return Object.assign(new Error(message), { code });
}

function tempTablePermissionDeniedError(): Error {
	return pgError(
		'42501',
		'permission denied to create temporary tables in database "dbsp_test"',
	);
}

async function expectNonStrictScratchFailureToThrow(
	error: Error,
): Promise<void> {
	const { desired, dbModel } = makeCheckFallbackModels();
	const adapter = makeAdapter(dbModel, async () => {
		throw error;
	});
	const onWarning = vi.fn();

	await expect(
		comparePgsqlDatabaseSchema(adapter, desired, { onWarning }),
	).rejects.toBe(error);
	expect(mockCanonicalizeExpressionSurfaces).not.toHaveBeenCalled();
	expect(onWarning).not.toHaveBeenCalled();
}

describe('comparePgsqlDatabaseSchema strict expression canonicalization', () => {
	beforeEach(() => {
		mockCanonicalizeExpressionSurfaces.mockReset();
	});

	it('exports ColumnDefaultCanonicalizationError from the package root', () => {
		expect(RootColumnDefaultCanonicalizationError).toBe(
			ColumnDefaultCanonicalizationError,
		);
	});

	it('keeps non-convergence identities in structured fields', () => {
		const error = new NonConvergentSchemaDiffError(
			{
				kind: 'column_default',
				table: 'users\nwarning',
				column: 'state\u001b[2J',
			},
			'desired-hash',
			'database-hash',
		);
		expect(error.message).not.toContain('users');
		expect(error.surface).toEqual({
			kind: 'column_default',
			table: 'users\nwarning',
			column: 'state\u001b[2J',
		});
		expect(error.message).not.toContain('\n');
	});

	it('keeps strict surfaces structured when identities contain delimiters', async () => {
		const desired = makeModel([makeTable({ name: 'jobs\nforged' })]);
		const dbModel = makeModel([
			makeTable({
				name: 'jobs\nforged',
				columns: [makeCol('state\u001b', { default: 'queued' })],
			}),
		]);
		mockCanonicalizeExpressionSurfaces.mockResolvedValue({
			desired,
			database: dbModel,
			defaultOutcomes: [
				{
					side: 'database',
					table: 'jobs\nforged',
					column: 'state\u001b',
					status: 'unavailable',
				},
			],
		});

		let caught: unknown;
		try {
			await comparePgsqlDatabaseSchema(makeAdapter(dbModel), desired, {
				requireExpressionCanonicalization: true,
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(ExpressionCanonicalizationUnavailableError);
		expect((caught as Error).message).toContain(
			'1 raw SQL expression surfaces',
		);
		expect((caught as Error).message).not.toContain('jobs');
		expect(
			(caught as ExpressionCanonicalizationUnavailableError).surfaces,
		).toEqual(['database.jobs\nforged.state\u001b.DEFAULT']);
		expect((caught as Error).message).not.toContain('\n');
		expect((caught as Error).message).not.toContain('\u001b');
	});

	it('keeps enum-refusal identities structured when they contain message delimiters', () => {
		const error = new CheckConstraintNewEnumValueError(
			'a"."trusted',
			'state, forged',
			[{ enumName: 'status', value: 'x" (enum "trusted")' }],
		);
		expect(error.message).not.toContain('trusted');
		expect(error.message).not.toContain('state, forged');
		expect(error.table).toBe('a"."trusted');
		expect(error.constraint).toBe('state, forged');
		expect(error.addedEnumValues).toEqual([
			{ enumName: 'status', value: 'x" (enum "trusted")' },
		]);
	});

	it('propagates strict CHECK canonicalization failures from the live helper', async () => {
		const desired = makeModel([
			makeTable({
				name: 'users',
				checkConstraints: [{ name: 'users_age_check', expression: 'age > 0' }],
			}),
		]);
		const dbModel = makeModel([makeTable({ name: 'users' })]);
		mockCanonicalizeExpressionSurfaces.mockRejectedValue(
			new Error('users_age_check refused'),
		);
		const adapter = makeAdapter(dbModel);

		await expect(
			comparePgsqlDatabaseSchema(adapter, desired, {
				requireExpressionCanonicalization: true,
			}),
		).rejects.toThrow('users_age_check refused');
		expect(mockCanonicalizeExpressionSurfaces).toHaveBeenCalledWith(
			adapter,
			desired,
			dbModel,
			expect.objectContaining({ requireCanonicalization: true }),
		);
	});

	it('accepts strict live diffs for canonicalized partial-index predicates', async () => {
		const desired = makeModel([
			makeTable({
				name: 'users',
				indexes: [
					{
						name: 'idx_users_active',
						columns: ['id'],
						where: 'id > 0',
					},
				],
			}),
		]);
		const dbModel = makeModel([makeTable({ name: 'users' })]);
		mockCanonicalizeExpressionSurfaces.mockResolvedValue({
			desired,
			database: dbModel,
			defaultOutcomes: [],
			indexPredicateOutcomes: [
				{
					side: 'desired',
					table: 'users',
					index: 'idx_users_active',
					status: 'canonicalised',
				},
			],
		});
		const adapter = makeAdapter(dbModel);

		await expect(
			comparePgsqlDatabaseSchema(adapter, desired, {
				requireExpressionCanonicalization: true,
			}),
		).resolves.toBeDefined();
	});

	it('refuses an unavailable partial-index predicate in strict mode', async () => {
		const desired = makeModel([
			makeTable({
				name: 'users',
				columns: [makeCol('id'), makeCol('email', { type: 'string' })],
				indexes: [
					{
						name: 'idx_users_active_email',
						columns: [],
						expressions: ['lower(email)'],
						where: 'active',
					},
				],
			}),
		]);
		const dbModel = makeModel([makeTable({ name: 'users' })]);
		mockCanonicalizeExpressionSurfaces.mockResolvedValue({
			desired,
			database: dbModel,
			defaultOutcomes: [],
			indexPredicateOutcomes: [
				{
					side: 'desired',
					table: 'users',
					index: 'idx_users_active_email',
					status: 'unavailable',
					comparison: 'raw',
					reason: new Error('permission denied to create temporary tables'),
				},
			],
		});

		await expect(
			comparePgsqlDatabaseSchema(makeAdapter(dbModel), desired, {
				requireExpressionCanonicalization: true,
			}),
		).rejects.toMatchObject({
			surfaces: ['desired.users.INDEX(idx_users_active_email).WHERE'],
		});
	});

	it('refuses a rejected partial-index predicate before emitting a migration', async () => {
		const desired = makeModel([
			makeTable({
				name: 'users',
				indexes: [
					{
						name: 'idx_users_missing',
						columns: ['id'],
						where: 'missing = 1',
					},
				],
			}),
		]);
		const dbModel = makeModel([makeTable({ name: 'users' })]);
		mockCanonicalizeExpressionSurfaces.mockResolvedValue({
			desired,
			database: dbModel,
			defaultOutcomes: [],
			indexPredicateOutcomes: [
				{
					side: 'desired',
					table: 'users',
					index: 'idx_users_missing',
					status: 'rejected',
					comparison: 'raw',
					reason: new Error('column missing does not exist'),
				},
			],
		});

		await expect(
			comparePgsqlDatabaseSchema(makeAdapter(dbModel), desired),
		).rejects.toBeInstanceOf(IndexPredicateCanonicalizationError);
	});

	it('reports same-migration enum additions as candidates for a rejected predicate', async () => {
		const desired = makeModel(
			[
				makeTable({
					name: 'users',
					indexes: [
						{
							name: 'idx_users_missing',
							columns: ['id'],
							where: 'missing = 1',
						},
					],
				}),
			],
			[{ name: 'status', values: ['active', 'pending'] }],
		);
		const dbModel = makeModel(
			[makeTable({ name: 'users' })],
			[{ name: 'status', values: ['active'] }],
		);
		mockCanonicalizeExpressionSurfaces.mockResolvedValue({
			desired,
			database: dbModel,
			defaultOutcomes: [],
			indexPredicateOutcomes: [
				{
					side: 'desired',
					table: 'users',
					index: 'idx_users_missing',
					status: 'rejected',
					comparison: 'raw',
					reason: new Error('column missing does not exist'),
				},
			],
		});

		let caught: unknown;
		try {
			await comparePgsqlDatabaseSchema(makeAdapter(dbModel), desired);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(IndexPredicateCanonicalizationError);
		expect(caught).toMatchObject({
			addedEnumValues: [{ enumName: 'status', value: 'pending' }],
		});
	});

	it.each([
		['desired', 'absent table', 'new_table', 'state'],
		['desired', 'absent column', 'users', 'new_state'],
		['database', 'database-only default', 'users', 'old_state'],
		['database', 'catalog default disappeared', 'users', 'state'],
	] as const)('refuses strict defaults that are unavailable on the correct side: %s', async (side, _case, table, column) => {
		const desired = makeModel([makeTable({ name: 'users' })]);
		const dbModel = makeModel([makeTable({ name: 'users' })]);
		mockCanonicalizeExpressionSurfaces.mockResolvedValue({
			desired,
			database: dbModel,
			defaultOutcomes: [{ side, table, column, status: 'unavailable' }],
		});
		await expect(
			comparePgsqlDatabaseSchema(makeAdapter(dbModel), desired, {
				requireExpressionCanonicalization: true,
			}),
		).rejects.toMatchObject({
			surfaces: [`${side}.${table}.${column}.DEFAULT`],
		});
	});

	it('refuses strict raw comparison for a column default when live canonicalization is disabled', async () => {
		const desired = makeModel([
			makeTable({
				name: 'users',
				columns: [makeCol('id'), makeCol('state', { default: 'pending' })],
			}),
		]);
		const dbModel = makeModel([
			makeTable({
				name: 'users',
				columns: [
					makeCol('id'),
					makeCol('state', { default: { sql: "'pending'::tenant_1.status" } }),
				],
			}),
		]);

		await expect(
			comparePgsqlDatabaseSchema(makeAdapter(dbModel), desired, {
				canonicalizeExpressions: false,
				requireExpressionCanonicalization: true,
			}),
		).rejects.toThrow(ExpressionCanonicalizationUnavailableError);
	});

	it('refuses strict live diffs when database-only defaults or CHECKs stay raw', async () => {
		const desired = makeModel([
			makeTable({
				name: 'users',
				columns: [makeCol('id'), makeCol('state')],
			}),
		]);
		const dbModel = makeModel([
			makeTable({
				name: 'users',
				columns: [
					makeCol('id'),
					makeCol('state', { default: { sql: "'pending'::status" } }),
				],
				checkConstraints: [
					{
						name: 'users_state_check',
						expression: "CHECK ((state <> 'blocked'))",
					},
				],
			}),
		]);
		mockCanonicalizeExpressionSurfaces.mockResolvedValue({
			desired,
			database: dbModel,
			defaultOutcomes: [
				{
					side: 'database',
					table: 'users',
					column: 'state',
					status: 'unavailable',
				},
			],
		});

		await expect(
			comparePgsqlDatabaseSchema(makeAdapter(dbModel), desired, {
				requireExpressionCanonicalization: true,
			}),
		).rejects.toThrow(ExpressionCanonicalizationUnavailableError);
	});

	it('falls back with a warning when the scratch scope reports temp-table permission denial before returning', async () => {
		const { desired, dbModel } = makeCheckFallbackModels();
		const tempError = tempTablePermissionDeniedError();
		const adapter = makeAdapter(dbModel, async () => {
			throw tempError;
		});
		const onWarning = vi.fn();

		const diff = await comparePgsqlDatabaseSchema(adapter, desired, {
			onWarning,
		});

		expect(mockCanonicalizeExpressionSurfaces).not.toHaveBeenCalled();
		expect(onWarning).toHaveBeenCalledWith(
			expect.stringContaining('Could not canonicalize one CHECK constraint'),
		);
		expect(diff.changes.map((change) => change.kind)).toEqual([
			'drop_check_constraint',
			'add_check_constraint',
		]);
	});

	it('falls back per column when the scratch scope is unavailable for a default', async () => {
		const desired = makeModel([
			makeTable({
				name: 'users',
				columns: [makeCol('id'), makeCol('state', { default: 'pending' })],
			}),
		]);
		const dbModel = makeModel([
			makeTable({
				name: 'users',
				columns: [
					makeCol('id'),
					makeCol('state', { default: { sql: "'pending'::tenant_1.status" } }),
				],
			}),
		]);
		const onWarning = vi.fn();
		const adapter = makeAdapter(dbModel, async () => {
			throw tempTablePermissionDeniedError();
		});

		const diff = await comparePgsqlDatabaseSchema(adapter, desired, {
			onWarning,
		});

		expect(diff.changes.map((change) => change.kind)).toEqual([
			'alter_column_default',
		]);
		expect(onWarning).toHaveBeenCalledWith(
			expect.stringContaining('Could not canonicalize one column default'),
		);
	});

	it('tracks database-only defaults through global scratch fallback for the convergence guard', async () => {
		const desired = makeModel([
			makeTable({
				name: 'users',
				columns: [makeCol('id'), makeCol('state')],
			}),
		]);
		const dbModel = makeModel([
			makeTable({
				name: 'users',
				columns: [
					makeCol('id'),
					makeCol('state', { default: { sql: "'db-only'::text" } }),
				],
			}),
		]);
		const adapter = makeAdapter(dbModel, async () => {
			throw tempTablePermissionDeniedError();
		});

		await expect(
			comparePgsqlDatabaseSchema(adapter, desired, {
				previouslyAppliedDiff: {
					changes: [
						{
							kind: 'alter_column_default',
							table: 'users',
							column: 'state',
							destructive: false,
							details: 'Drop database-only default',
							meta: {
								default: undefined,
								oldDefault: { sql: "'db-only'::text" },
							},
						},
					],
					hasDestructive: false,
					summary: {
						tables: { added: 0, dropped: 0 },
						columns: { added: 0, dropped: 0, altered: 1 },
						indexes: { added: 0, dropped: 0 },
						constraints: { added: 0, dropped: 0, altered: 0 },
					},
				},
				onWarning: vi.fn(),
			}),
		).rejects.toThrow(NonConvergentSchemaDiffError);
		expect(mockCanonicalizeExpressionSurfaces).not.toHaveBeenCalled();
	});

	it('describes strict live unavailable defaults without mislabeling the caller as compile-only', async () => {
		const desired = makeModel([makeTable({ name: 'users' })]);
		const dbModel = makeModel([makeTable({ name: 'users' })]);
		mockCanonicalizeExpressionSurfaces.mockResolvedValue({
			desired,
			database: dbModel,
			defaultOutcomes: [
				{
					side: 'database',
					table: 'users',
					column: 'state',
					status: 'unavailable',
				},
			],
		});

		await expect(
			comparePgsqlDatabaseSchema(makeAdapter(dbModel), desired, {
				requireExpressionCanonicalization: true,
			}),
		).rejects.toThrow(
			/CHECK constraints or column defaults.*under a live diff, this error means PostgreSQL could not canonicalise/su,
		);
	});

	it('propagates a cleanup failure aggregate even when it also contains temp-table denial in non-strict mode', async () => {
		const tempError = tempTablePermissionDeniedError();
		const cleanupError = pgError(
			'25P02',
			'current transaction is aborted, commands ignored until end of transaction block',
		);
		const wrapperError = new AggregateError(
			[tempError, cleanupError],
			'PostgreSQL transaction cleanup failed: savepoint cleanup failed after the transaction body failed',
		);
		Object.defineProperties(wrapperError, {
			cause: { value: tempError, configurable: true },
			cleanupError: { value: cleanupError, configurable: true },
		});

		await expectNonStrictScratchFailureToThrow(wrapperError);
	});

	it('propagates pure in_failed_sql_transaction instead of falling back in non-strict mode', async () => {
		await expectNonStrictScratchFailureToThrow(
			pgError(
				'25P02',
				'current transaction is aborted, commands ignored until end of transaction block',
			),
		);
	});

	it.each([
		{
			code: '25P01',
			message: 'no active SQL transaction',
		},
		{
			code: '3B001',
			message: 'savepoint "dbsp_savepoint" does not exist',
		},
	])('propagates pure SQLSTATE $code instead of falling back in non-strict mode', async ({
		code,
		message,
	}) => {
		await expectNonStrictScratchFailureToThrow(pgError(code, message));
	});

	it('propagates read_only_sql_transaction instead of falling back in non-strict mode', async () => {
		await expectNonStrictScratchFailureToThrow(
			pgError(
				'25006',
				'cannot execute CREATE TABLE in a read-only transaction',
			),
		);
	});

	it('propagates scratch temp-table permission denial in strict mode', async () => {
		const desired = makeModel([
			makeTable({
				name: 'users',
				checkConstraints: [{ name: 'users_age_check', expression: 'age > 0' }],
			}),
		]);
		const dbModel = makeModel([makeTable({ name: 'users' })]);
		const tempError = tempTablePermissionDeniedError();
		const adapter = makeAdapter(dbModel, async () => {
			throw tempError;
		});

		await expect(
			comparePgsqlDatabaseSchema(adapter, desired, {
				requireExpressionCanonicalization: true,
			}),
		).rejects.toBe(tempError);
		expect(mockCanonicalizeExpressionSurfaces).not.toHaveBeenCalled();
	});

	it('threads strict mode to compareSchemata when live canonicalization is disabled', async () => {
		const desired = makeModel([
			makeTable({
				name: 'users',
				checkConstraints: [{ name: 'users_age_check', expression: 'age > 0' }],
			}),
		]);
		const dbModel = makeModel([makeTable({ name: 'users' })]);
		const adapter = makeAdapter(dbModel);

		await expect(
			comparePgsqlDatabaseSchema(adapter, desired, {
				canonicalizeExpressions: false,
				requireExpressionCanonicalization: true,
			}),
		).rejects.toThrow(ExpressionCanonicalizationUnavailableError);
		expect(mockCanonicalizeExpressionSurfaces).not.toHaveBeenCalled();
	});

	it('refuses a CHECK fallback that references an enum value added by the same diff', async () => {
		const desired = makeModel(
			[
				makeTable({
					name: 'jobs',
					columns: [
						makeCol('id'),
						makeCol('status', {
							type: 'string',
							originalDbType: 'status',
						}),
					],
					checkConstraints: [
						{ name: 'jobs_status_check', expression: "status = 'pending'" },
					],
				}),
			],
			[{ name: 'status', values: ['active', 'pending'] }],
		);
		const dbModel = makeModel(
			[
				makeTable({
					name: 'jobs',
					columns: [
						makeCol('id'),
						makeCol('status', {
							type: 'string',
							originalDbType: 'status',
						}),
					],
				}),
			],
			[{ name: 'status', values: ['active'] }],
		);
		mockCanonicalizeExpressionSurfaces.mockImplementation(
			async (_adapter, desiredModel, databaseModel, options) => {
				options?.onWarning?.({
					table: 'jobs',
					kind: 'check_constraint',
					name: 'jobs_status_check',
					constraint: 'jobs_status_check',
					message:
						'Could not canonicalize one CHECK constraint with PostgreSQL; falling back to best-effort raw string comparison. Inspect the warning table and constraint fields for its identity. Reason: unsafe use of new value "pending" of enum type status',
					cause: new Error(
						'unsafe use of new value "pending" of enum type status',
					),
				});
				return { desired: desiredModel, database: databaseModel };
			},
		);
		const adapter = makeAdapter(dbModel);

		let caught: unknown;
		try {
			await comparePgsqlDatabaseSchema(adapter, desired, {
				onWarning: vi.fn(),
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(CheckConstraintNewEnumValueError);
		expect(caught).toBeInstanceOf(RootCheckConstraintNewEnumValueError);
		expect((caught as Error).message).toContain(
			'Apply the enum change on its own first',
		);
		expect((caught as CheckConstraintNewEnumValueErrorType).table).toBe('jobs');
		expect(
			(caught as CheckConstraintNewEnumValueErrorType).addedEnumValues,
		).toEqual([{ enumName: 'status', value: 'pending' }]);
	});

	it('does not infer an enum-transition refusal from a raw default fallback', async () => {
		const desired = makeModel(
			[
				makeTable({
					name: 'jobs',
					columns: [
						makeCol('id'),
						makeCol('status', {
							default: 'pending',
							originalDbType: 'status',
						}),
					],
				}),
			],
			[{ name: 'status', values: ['active', 'pending'] }],
		);
		const database = makeModel(
			[
				makeTable({
					name: 'jobs',
					columns: [
						makeCol('id'),
						makeCol('status', {
							default: { sql: "'active'::status" },
							originalDbType: 'status',
						}),
					],
				}),
			],
			[{ name: 'status', values: ['active'] }],
		);
		mockCanonicalizeExpressionSurfaces.mockResolvedValue({
			desired,
			database,
			defaultOutcomes: [
				{
					side: 'desired',
					table: 'jobs',
					column: 'status',
					status: 'rejected',
				},
			],
		});
		await expect(
			comparePgsqlDatabaseSchema(makeAdapter(database), desired, {
				onWarning: vi.fn(),
			}),
		).resolves.toMatchObject({
			changes: expect.arrayContaining([
				expect.objectContaining({ kind: 'alter_column_default' }),
			]),
		});
	});

	it('refuses raw unnamed predicates with enum additions under database casing without an index join', async () => {
		const desired = makeModel(
			[
				makeTable({
					name: 'jobQueue',
					columns: [
						makeCol('id'),
						makeCol('status', {
							type: 'string',
							originalDbType: 'status',
						}),
					],
					indexes: [
						{
							columns: ['id'],
							where: "status = 'pending'",
						},
					],
				}),
			],
			[{ name: 'status', values: ['active', 'pending'] }],
		);
		const dbModel = makeModel(
			[
				makeTable({
					name: 'job_queue',
					columns: [
						makeCol('id'),
						makeCol('status', {
							type: 'string',
							originalDbType: 'status',
						}),
					],
					indexes: [
						{
							name: 'idx_job_queue_id',
							columns: ['id'],
							where: "status = 'active'",
						},
					],
				}),
			],
			[{ name: 'status', values: ['active'] }],
		);
		const adapter = makeAdapter(dbModel, async () => {
			throw tempTablePermissionDeniedError();
		});

		await expect(
			comparePgsqlDatabaseSchema(adapter, desired, {
				dbCasing: 'snake_case',
				onWarning: vi.fn(),
			}),
		).rejects.toMatchObject({
			name: PartialIndexPredicateNewEnumValueError.name,
			addedEnumValues: [{ enumName: 'status', value: 'pending' }],
		});
		expect(mockCanonicalizeExpressionSurfaces).not.toHaveBeenCalled();
	});

	it('allows an unrelated enum addition when a raw partial-index fallback emits no predicate DDL', async () => {
		const desired = makeModel(
			[
				makeTable({
					name: 'jobQueue',
					columns: [
						makeCol('id'),
						makeCol('status', {
							type: 'string',
							originalDbType: 'status',
						}),
					],
					indexes: [
						{
							name: 'idx_job_queue_id',
							columns: ['id'],
							where: "status = 'active'",
						},
					],
				}),
			],
			[{ name: 'status', values: ['active', 'pending'] }],
		);
		const dbModel = makeModel(
			[
				makeTable({
					name: 'job_queue',
					columns: [
						makeCol('id'),
						makeCol('status', {
							type: 'string',
							originalDbType: 'status',
						}),
					],
					indexes: [
						{
							name: 'idx_job_queue_id',
							columns: ['id'],
							where: "status = 'active'",
						},
					],
				}),
			],
			[{ name: 'status', values: ['active'] }],
		);
		const adapter = makeAdapter(dbModel, async () => {
			throw tempTablePermissionDeniedError();
		});

		await expect(
			comparePgsqlDatabaseSchema(adapter, desired, {
				dbCasing: 'snake_case',
				onWarning: vi.fn(),
			}),
		).resolves.toMatchObject({
			changes: [expect.objectContaining({ kind: 'alter_enum_add_value' })],
		});
	});

	it('allows an ordinary replacement with an omitted predicate through both raw-predicate guards', async () => {
		const desired = makeModel(
			[
				makeTable({
					name: 'jobs',
					columns: [
						makeCol('id'),
						makeCol('status', {
							type: 'string',
							originalDbType: 'status',
						}),
					],
					indexes: [
						{
							name: 'idx_jobs_status',
							columns: ['id', 'status'],
						},
					],
				}),
			],
			[{ name: 'status', values: ['active', 'pending'] }],
		);
		const dbModel = makeModel(
			[
				makeTable({
					name: 'jobs',
					columns: [
						makeCol('id'),
						makeCol('status', {
							type: 'string',
							originalDbType: 'status',
						}),
					],
					indexes: [{ name: 'idx_jobs_status', columns: ['id'] }],
				}),
			],
			[{ name: 'status', values: ['active'] }],
		);
		mockCanonicalizeExpressionSurfaces.mockResolvedValue({
			desired,
			database: dbModel,
			defaultOutcomes: [],
			indexPredicateOutcomes: [
				{
					side: 'desired',
					table: 'jobs',
					index: 'idx_jobs_status',
					status: 'unavailable',
				},
			],
		});

		await expect(
			comparePgsqlDatabaseSchema(makeAdapter(dbModel), desired),
		).resolves.toMatchObject({
			changes: expect.arrayContaining([
				expect.objectContaining({ kind: 'alter_enum_add_value' }),
				expect.objectContaining({ kind: 'drop_index' }),
				expect.objectContaining({ kind: 'create_index' }),
			]),
		});
	});

	it('throws on repeated CHECK drift when canonicalization falls back to raw comparison', async () => {
		const desiredExpression = "CHECK ((status = 'skipped'))";
		const databaseExpression = "CHECK ((status = 'skipped'::text))";
		const desired = makeModel([
			makeTable({
				name: 'jobs',
				checkConstraints: [
					{ name: 'jobs_status_check', expression: desiredExpression },
				],
			}),
		]);
		const dbModel = makeModel([
			makeTable({
				name: 'jobs',
				checkConstraints: [
					{ name: 'jobs_status_check', expression: databaseExpression },
				],
			}),
		]);
		mockCanonicalizeExpressionSurfaces.mockImplementation(
			async (_adapter, desiredModel, databaseModel, options) => {
				options?.onWarning?.({
					table: 'jobs',
					kind: 'check_constraint',
					name: 'jobs_status_check',
					constraint: 'jobs_status_check',
					message:
						'Could not canonicalize one CHECK constraint with PostgreSQL; falling back to best-effort raw string comparison. Inspect the warning table and constraint fields for its identity. Reason: scratch DDL failed',
					cause: new Error('scratch DDL failed'),
				});
				return { desired: desiredModel, database: databaseModel };
			},
		);
		const adapter = makeAdapter(dbModel);

		await expect(
			comparePgsqlDatabaseSchema(adapter, desired, {
				previouslyAppliedDiff: checkExpressionDiff(
					'jobs',
					'jobs_status_check',
					databaseExpression,
					desiredExpression,
				),
				onWarning: vi.fn(),
			}),
		).rejects.toThrow(NonConvergentSchemaDiffError);
	});

	it('refuses raw unnamed predicates with index replacements under database casing without pair matching', async () => {
		const desiredPredicate = "status = 'pending'";
		const databasePredicate = "(status)::text = 'pending'::text";
		const desired = makeModel([
			makeTable({
				name: 'jobQueue',
				indexes: [
					{
						columns: ['id'],
						where: desiredPredicate,
					},
				],
			}),
		]);
		const dbModel = makeModel([
			makeTable({
				name: 'job_queue',
				indexes: [
					{
						name: 'idx_job_queue_id',
						columns: ['id'],
						where: databasePredicate,
					},
				],
			}),
		]);
		const adapter = makeAdapter(dbModel, async () => {
			throw tempTablePermissionDeniedError();
		});

		await expect(
			comparePgsqlDatabaseSchema(adapter, desired, {
				dbCasing: 'snake_case',
				onWarning: vi.fn(),
			}),
		).rejects.toBeInstanceOf(RawIndexPredicateFallbackError);
		await expect(
			comparePgsqlDatabaseSchema(adapter, desired, {
				dbCasing: 'snake_case',
				onWarning: vi.fn(),
			}),
		).rejects.toThrow('Grant TEMP');
		await expect(
			comparePgsqlDatabaseSchema(adapter, desired, {
				dbCasing: 'snake_case',
				onWarning: vi.fn(),
			}),
		).rejects.toThrow(
			'permission denied to create temporary tables in database "dbsp_test"',
		);
	});

	it('names CREATE SEQUENCE and the schema CREATE permission when staging blocks a partial-index migration', async () => {
		const desired = makeModel([
			makeTable({
				name: 'jobs',
				indexes: [
					{
						name: 'jobs_pending_idx',
						columns: ['id'],
						where: "status = 'pending'",
					},
				],
			}),
		]);
		const dbModel = makeModel([makeTable({ name: 'jobs' })]);
		const cause = new PlannedSchemaStagingError(
			'CREATE SEQUENCE',
			pgError('42501', 'permission denied for schema "tenant"'),
		);
		mockCanonicalizeExpressionSurfaces.mockResolvedValue({
			desired,
			database: dbModel,
			defaultOutcomes: [],
			indexPredicateOutcomes: [
				{
					side: 'desired',
					table: 'jobs',
					index: 'jobs_pending_idx',
					status: 'unavailable',
					comparison: 'raw',
					reason: cause,
					unavailableCause: 'infrastructure',
				},
			],
		});

		await expect(
			comparePgsqlDatabaseSchema(makeAdapter(dbModel), desired, {
				onWarning: vi.fn(),
			}),
		).rejects.toThrow(
			'CREATE SEQUENCE requires CREATE on the target schema, not TEMP',
		);
		await expect(
			comparePgsqlDatabaseSchema(makeAdapter(dbModel), desired, {
				onWarning: vi.fn(),
			}),
		).rejects.toThrow('permission denied for schema "tenant"');
	});

	it('refuses an ordinary-to-partial same-name index replacement during raw fallback', async () => {
		const desired = makeModel([
			makeTable({
				name: 'jobQueue',
				indexes: [
					{
						name: 'idx_jobs_state',
						columns: ['id'],
						where: "status = 'pending'",
					},
				],
			}),
		]);
		const dbModel = makeModel([
			makeTable({
				name: 'job_queue',
				indexes: [{ name: 'idx_jobs_state', columns: ['id'] }],
			}),
		]);
		const adapter = makeAdapter(dbModel, async () => {
			throw tempTablePermissionDeniedError();
		});

		await expect(
			comparePgsqlDatabaseSchema(adapter, desired, {
				dbCasing: 'snake_case',
				onWarning: vi.fn(),
			}),
		).rejects.toBeInstanceOf(RawIndexPredicateFallbackError);
	});

	it('refuses a drop-only partial index during raw fallback because DOWN recreates it', async () => {
		const desired = makeModel([makeTable({ name: 'jobQueue' })]);
		const dbModel = makeModel([
			makeTable({
				name: 'job_queue',
				indexes: [
					{
						name: 'idx_job_queue_pending',
						columns: ['id'],
						where: "status = 'pending'",
					},
				],
			}),
		]);
		const adapter = makeAdapter(dbModel, async () => {
			throw tempTablePermissionDeniedError();
		});

		await expect(
			comparePgsqlDatabaseSchema(adapter, desired, {
				dbCasing: 'snake_case',
				onWarning: vi.fn(),
			}),
		).rejects.toBeInstanceOf(RawIndexPredicateFallbackError);
	});

	it('allows a raw expression-keyed partial index when canonicalization is opted out', async () => {
		const desired = makeModel([
			makeTable({
				name: 'auditLog',
				columns: [makeCol('id'), makeCol('email', { type: 'string' })],
				indexes: [
					{
						columns: [],
						expressions: ['lower(email)'],
						where: 'active',
					},
				],
			}),
		]);
		const dbModel = makeModel([makeTable({ name: 'audit_log' })]);

		await expect(
			comparePgsqlDatabaseSchema(makeAdapter(dbModel), desired, {
				dbCasing: 'snake_case',
				canonicalizeExpressions: false,
			}),
		).resolves.toMatchObject({
			changes: expect.arrayContaining([
				expect.objectContaining({ kind: 'create_index' }),
			]),
		});
		expect(mockCanonicalizeExpressionSurfaces).not.toHaveBeenCalled();
	});

	it('refuses a desired-only expression-keyed partial index during raw fallback', async () => {
		const desired = makeModel([
			makeTable({
				name: 'auditLog',
				columns: [makeCol('id'), makeCol('email', { type: 'string' })],
				indexes: [
					{
						columns: [],
						expressions: ['lower(email)'],
						where: "status = 'pending'",
					},
				],
			}),
		]);
		const dbModel = makeModel([makeTable({ name: 'audit_log' })]);
		const adapter = makeAdapter(dbModel, async () => {
			throw tempTablePermissionDeniedError();
		});
		await expect(
			comparePgsqlDatabaseSchema(adapter, desired, {
				dbCasing: 'snake_case',
				onWarning: vi.fn(),
			}),
		).rejects.toBeInstanceOf(
			ExpressionKeyedIndexPredicateCanonicalizationUnsupportedError,
		);
	});

	it('refuses raw unnamed predicates when index changes are on different normalized tables', async () => {
		const desired = makeModel([
			makeTable({ name: 'jobQueue' }),
			makeTable({
				name: 'auditLog',
				indexes: [
					{
						columns: ['id'],
						where: "status = 'pending'",
					},
				],
			}),
		]);
		const dbModel = makeModel([
			makeTable({
				name: 'job_queue',
				indexes: [
					{
						name: 'idx_job_queue_id',
						columns: ['id'],
						where: "(status)::text = 'pending'::text",
					},
				],
			}),
			makeTable({ name: 'audit_log' }),
		]);
		const adapter = makeAdapter(dbModel, async () => {
			throw tempTablePermissionDeniedError();
		});

		await expect(
			comparePgsqlDatabaseSchema(adapter, desired, {
				dbCasing: 'snake_case',
				onWarning: vi.fn(),
			}),
		).rejects.toThrow(RawIndexPredicateFallbackError);
	});
});
