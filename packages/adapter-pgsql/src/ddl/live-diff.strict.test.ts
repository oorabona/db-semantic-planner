import { ModelIRImpl } from '@dbsp/core';
import type { ColumnIR, EnumIR, ModelIR, TableIR } from '@dbsp/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PgsqlAdapter } from '../pgsql-adapter.js';
import {
	ExpressionCanonicalizationUnavailableError,
	type SchemaDiff,
} from './schema-diff.js';

const mockCanonicalizeCheckConstraints = vi.fn();

vi.mock('../expression-canonicalizer.js', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../expression-canonicalizer.js')>();
	return {
		...actual,
		canonicalizeCheckConstraints: (...args: unknown[]) =>
			mockCanonicalizeCheckConstraints(...args),
	};
});

const {
	CheckConstraintNewEnumValueError,
	comparePgsqlDatabaseSchema,
	NonConvergentSchemaDiffError,
} = await import('./live-diff.js');
const {
	CheckConstraintNewEnumValueError: RootCheckConstraintNewEnumValueError,
} = await import('../index.js');

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

function makeAdapter(dbModel: ModelIR): PgsqlAdapter {
	const adapter = {
		introspect: vi.fn(async () => dbModel),
		withScratchScope: vi.fn(
			async (fn: (scratch: PgsqlAdapter) => Promise<unknown>) =>
				fn(adapter as unknown as PgsqlAdapter),
		),
	} as unknown as PgsqlAdapter;
	return adapter;
}

describe('comparePgsqlDatabaseSchema strict expression canonicalization', () => {
	beforeEach(() => {
		mockCanonicalizeCheckConstraints.mockReset();
	});

	it('propagates strict CHECK canonicalization failures from the live helper', async () => {
		const desired = makeModel([
			makeTable({
				name: 'users',
				checkConstraints: [{ name: 'users_age_check', expression: 'age > 0' }],
			}),
		]);
		const dbModel = makeModel([makeTable({ name: 'users' })]);
		mockCanonicalizeCheckConstraints.mockRejectedValue(
			new Error('users_age_check refused'),
		);
		const adapter = makeAdapter(dbModel);

		await expect(
			comparePgsqlDatabaseSchema(adapter, desired, {
				requireExpressionCanonicalization: true,
			}),
		).rejects.toThrow('users_age_check refused');
		expect(mockCanonicalizeCheckConstraints).toHaveBeenCalledWith(
			adapter,
			desired,
			dbModel,
			expect.objectContaining({ requireCanonicalization: true }),
		);
	});

	it('refuses strict live diffs for index predicates that are not canonicalized', async () => {
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
		mockCanonicalizeCheckConstraints.mockResolvedValue(desired);
		const adapter = makeAdapter(dbModel);

		await expect(
			comparePgsqlDatabaseSchema(adapter, desired, {
				requireExpressionCanonicalization: true,
			}),
		).rejects.toThrow(ExpressionCanonicalizationUnavailableError);
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
		expect(mockCanonicalizeCheckConstraints).not.toHaveBeenCalled();
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
		mockCanonicalizeCheckConstraints.mockImplementation(
			async (_adapter, desiredModel, _dbModel, options) => {
				options?.onWarning?.({
					table: 'jobs',
					constraint: 'jobs_status_check',
					message:
						'Could not canonicalize CHECK constraint "jobs"."jobs_status_check" with PostgreSQL; falling back to best-effort raw string comparison. Reason: unsafe use of new value "pending" of enum type status',
					cause: new Error(
						'unsafe use of new value "pending" of enum type status',
					),
				});
				return desiredModel;
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
		expect((caught as Error).message).toMatch(
			/CHECK constraint "jobs"\."jobs_status_check".*enum "status".*Apply the enum change on its own first/su,
		);
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
		mockCanonicalizeCheckConstraints.mockImplementation(
			async (_adapter, desiredModel, _dbModel, options) => {
				options?.onWarning?.({
					table: 'jobs',
					constraint: 'jobs_status_check',
					message:
						'Could not canonicalize CHECK constraint "jobs"."jobs_status_check" with PostgreSQL; falling back to best-effort raw string comparison. Reason: scratch DDL failed',
					cause: new Error('scratch DDL failed'),
				});
				return desiredModel;
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
});
