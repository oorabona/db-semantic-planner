import {
	type GeneratedPostconditionSession,
	withGeneratedPostconditionSession,
} from '@dbsp/adapter-pgsql';
import type { ValidatedManagedStepManifest } from '@dbsp/core';
import type { LedgerAddress, NormalizedManagedStep } from '@dbsp/types';
import { describe, expect, it, vi } from 'vitest';

const executePgAdmittedOperation = vi.hoisted(() => vi.fn());
const preflightPgDeclaredAdoption = vi.hoisted(() => vi.fn());
const executePgDeclaredAdoption = vi.hoisted(() => vi.fn());
const executePgPersistedTableReaddress = vi.hoisted(() => vi.fn());

vi.mock('@dbsp/adapter-pgsql', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@dbsp/adapter-pgsql')>();
	return {
		...actual,
		executePgAdmittedOperation: (...args: unknown[]) =>
			executePgAdmittedOperation(...args),
		preflightPgDeclaredAdoption: (...args: unknown[]) =>
			preflightPgDeclaredAdoption(...args),
		executePgDeclaredAdoption: (...args: unknown[]) =>
			executePgDeclaredAdoption(...args),
		executePgPersistedTableReaddress: (...args: unknown[]) =>
			executePgPersistedTableReaddress(...args),
	};
});

import {
	executeGeneratorPlan,
	readGeneratedPostcondition,
} from './generator-execution.js';

async function readTestGeneratedPostcondition(
	executor: Pick<GeneratedPostconditionSession, 'query'>,
	step: NormalizedManagedStep,
	address: Parameters<typeof readGeneratedPostcondition>[2],
) {
	return withGeneratedPostconditionSession(
		{
			connect: async () => ({
				...executor,
				release: () => undefined,
			}),
		},
		(session) => readGeneratedPostcondition(session, step, address),
	);
}

const dataDestructiveStep: NormalizedManagedStep = {
	stepKey: 'generator:0',
	order: 0,
	segmentId: 'generator-segment-0',
	dependencyOrder: [],
	address: {
		scope: 'schema',
		engine: 'postgresql',
		database: 'app',
		schema: 'tenant',
		kind: 'table',
		name: 'accounts',
	},
	claimKind: 'intent',
	plannedClaimKeys: ['generator:0:root'],
	statementBundle: {
		statements: [
			{
				ordinal: 0,
				sql: 'ALTER TABLE tenant.accounts ALTER COLUMN id TYPE bigint',
			},
		],
	},
	classification: 'data-destructive',
	requiresVacancy: false,
	replayPolicy: 'recorded',
};

function indexProjectionRow(overrides: Record<string, unknown> = {}) {
	return {
		schema_name: 'tenant',
		table_name: 'accounts',
		index_name: 'accounts_id_idx',
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
		key_columns: ['id'],
		key_definitions: ['id'],
		include_columns: [],
		opclasses: ['int4_ops'],
		key_options: ['0'],
		reloptions: [],
		predicate_expression: null,
		...overrides,
	};
}

function indexReadbackExecutor(input: {
	readonly live?: Record<string, unknown>;
	readonly staged?: Record<string, unknown>;
}) {
	return {
		query: vi.fn(async (sql: string) => {
			if (sql.includes('WHERE namespace.nspname'))
				return { rows: [indexProjectionRow(input.live)] };
			if (sql.includes('WHERE relation.oid'))
				return { rows: [indexProjectionRow(input.staged)] };
			return { rows: [] };
		}),
	};
}

describe('generator execution fixture shim', () => {
	it('binds adoption and re-address claims to the recorded attempt namespace', async () => {
		const attempts: string[] = [];
		preflightPgDeclaredAdoption.mockResolvedValue({ outcome: 'ready' });
		executePgDeclaredAdoption.mockResolvedValue({ outcome: 'completed' });
		executePgPersistedTableReaddress.mockResolvedValue({
			outcome: 'completed',
			pairId: 'pair',
		});
		const lifecycleStep = (kind: 'adoption' | 'readdress') =>
			({
				...dataDestructiveStep,
				stepKey: kind,
				order: kind === 'adoption' ? 0 : 1,
				segmentId:
					kind === 'adoption' ? 'generator-segment-0' : 'generator-segment-1',
				plannedClaimKeys: [`${kind}:root`],
				claimKind: kind === 'adoption' ? 'adopt-intent' : 'readdress-intent',
				classification:
					kind === 'adoption' ? 'non-destructive' : 'paired-readdress',
				statementBundle: { statements: [] },
				selection: { kind, selector: 'table:accounts' },
				lifecycle:
					kind === 'adoption'
						? { kind, shape: {} }
						: {
								kind,
								declaration: {
									from: { name: 'accounts' },
									to: { name: 'accounts_next' },
								},
							},
				...(kind === 'adoption'
					? {
							expectedDeclaration: {
								value: { kind: 'table' },
								digest: 'declared',
							},
							expectedCatalogueIdentity: {
								engine: 'postgresql',
								format: 1,
								value: { oid: '1' },
							},
						}
					: {}),
			}) as unknown as NormalizedManagedStep;
		await expect(
			executeGeneratorPlan({
				pool: {
					query: vi.fn().mockResolvedValue({ rows: [{ database_id: 'app' }] }),
				} as never,
				run: {} as never,
				plan: {
					steps: [lifecycleStep('adoption'), lifecycleStep('readdress')],
				},
				planDigest: 'reviewed-plan',
				schema: 'tenant',
				runId: 'reviewed-run',
				recordAttempt: async (executionId) => {
					attempts.push(executionId);
				},
			}),
		).resolves.toEqual({ outcome: 'completed' });
		const executionId = attempts[0];
		expect(executionId).toMatch(/^dbsp\.generator\.execution\./);
		expect(executePgDeclaredAdoption).toHaveBeenCalledWith(
			expect.objectContaining({ executionId }),
		);
		expect(executePgPersistedTableReaddress).toHaveBeenCalledWith(
			expect.objectContaining({ executionId }),
		);
	});

	it.each([
		[
			{
				...dataDestructiveStep,
				expectedDeclaration: {
					value: {
						postconditionVersion: 2,
						kind: 'column',
						column: { name: 'id', type: 'bigint' },
					},
					digest: 'column-postcondition',
				},
				address: {
					...dataDestructiveStep.address,
					kind: 'column' as const,
					name: 'id',
					parent: dataDestructiveStep.address,
				},
			},
			[{ column_type: 'integer', is_not_null: true, column_default: null }],
		],
	] as const)('refuses a present-but-unmutated generated %s rather than recording observed', async (step, rows) => {
		await expect(
			readTestGeneratedPostcondition(
				{ query: vi.fn().mockResolvedValue({ rows }) },
				step as unknown as NormalizedManagedStep,
				step.address! as never,
			),
		).rejects.toThrow();
	});

	it.each([
		['string nullability', { is_not_null: 't' }],
		['unknown identity', { identity_kind: 'x' }],
	])('refuses an incomplete generated column projection with %s', async (_label, override) => {
		const address = {
			...dataDestructiveStep.address,
			kind: 'column' as const,
			name: 'id',
			parent: dataDestructiveStep.address!,
		} as LedgerAddress;
		const step = {
			...dataDestructiveStep,
			address,
			expectedDeclaration: {
				value: {
					postconditionVersion: 2,
					kind: 'column',
					column: {
						name: 'id',
						type: 'integer',
						nullable: false,
						identity: null,
					},
				},
				digest: 'column-postcondition',
			},
		} as unknown as NormalizedManagedStep;
		await expect(
			readTestGeneratedPostcondition(
				{
					query: vi.fn().mockResolvedValue({
						rows: [
							{
								column_name: 'id',
								column_type: 'integer',
								is_not_null: true,
								column_default: null,
								collation_name: null,
								identity_kind: '',
								...override,
							},
						],
					}),
				},
				step,
				address,
			),
		).rejects.toThrow('generated column id has an incomplete projection');
	});

	it('canonicalizes PostgreSQL default collation for generated column read-back', async () => {
		const address = {
			...dataDestructiveStep.address,
			kind: 'column' as const,
			name: 'body',
			parent: dataDestructiveStep.address!,
		} as LedgerAddress;
		const step = {
			...dataDestructiveStep,
			address,
			expectedDeclaration: {
				value: {
					postconditionVersion: 2,
					kind: 'column',
					column: {
						name: 'body',
						type: 'text',
						nullable: true,
						collation: null,
					},
				},
				digest: 'column-postcondition',
			},
		} as unknown as NormalizedManagedStep;
		await expect(
			readTestGeneratedPostcondition(
				{
					query: vi.fn().mockResolvedValue({
						rows: [
							{
								column_name: 'body',
								column_type: 'text',
								is_not_null: false,
								column_default: null,
								collation_name: 'default',
								identity_kind: '',
							},
						],
					}),
				},
				step,
				address,
			),
		).resolves.toMatchObject({ value: { collation: null } });
	});

	it('normalizes PostgreSQL primary-key attnotnull on CREATE TABLE read-back', async () => {
		const step: NormalizedManagedStep = {
			...dataDestructiveStep,
			expectedDeclaration: {
				value: {
					postconditionVersion: 2,
					kind: 'table',
					columns: [
						{ name: 'id', type: 'integer', nullable: false, hasDefault: false },
					],
				},
				digest: 'table-postcondition',
			},
			statementBundle: {
				statements: [
					{
						ordinal: 0,
						sql: 'CREATE TABLE tenant.accounts ("id" INTEGER, CONSTRAINT "pk_accounts" PRIMARY KEY ("id"))',
					},
				],
			},
		};
		await expect(
			readTestGeneratedPostcondition(
				{
					query: vi.fn().mockResolvedValue({
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
					}),
				},
				step,
				step.address!,
			),
		).resolves.toMatchObject({
			value: {
				kind: 'table',
				columns: [expect.objectContaining({ name: 'id', nullable: false })],
			},
		});
	});

	it('records table and column collation and identity in observed payload digests', async () => {
		const baseAddress = dataDestructiveStep.address!;
		const tableStep: NormalizedManagedStep = {
			...dataDestructiveStep,
			expectedDeclaration: {
				value: {
					postconditionVersion: 2,
					kind: 'table',
					columns: [{ name: 'id', type: 'integer', nullable: false }],
				},
				digest: 'table-postcondition',
			},
		};
		const tableRead = (collation_name: string) =>
			readTestGeneratedPostcondition(
				{
					query: vi.fn().mockResolvedValue({
						rows: [
							{
								relation_kind: 'r',
								column_name: 'id',
								column_type: 'integer',
								is_not_null: true,
								column_default: null,
								collation_name,
								identity_kind: 'a',
							},
						],
					}),
				},
				tableStep,
				tableStep.address!,
			);
		const columnStep: NormalizedManagedStep = {
			...dataDestructiveStep,
			expectedDeclaration: {
				value: {
					postconditionVersion: 2,
					kind: 'column',
					column: { name: 'id', type: 'integer', nullable: false },
				},
				digest: 'column-postcondition',
			},
			address: {
				...baseAddress,
				kind: 'column',
				name: 'id',
				parent: baseAddress,
			},
		};
		const columnRead = (collation_name: string) =>
			readTestGeneratedPostcondition(
				{
					query: vi.fn().mockResolvedValue({
						rows: [
							{
								column_name: 'id',
								column_type: 'integer',
								is_not_null: true,
								column_default: null,
								collation_name,
								identity_kind: 'a',
							},
						],
					}),
				},
				columnStep,
				columnStep.address!,
			);
		const firstTable = await tableRead('C');
		const secondTable = await tableRead('POSIX');
		expect(firstTable.value).toMatchObject({
			columns: [{ collation: 'C', identity: 'always' }],
		});
		expect(firstTable.digest).not.toBe(secondTable.digest);
		const firstColumn = await columnRead('C');
		const secondColumn = await columnRead('POSIX');
		expect(firstColumn.value).toMatchObject({
			collation: 'C',
			identity: 'always',
		});
		expect(firstColumn.digest).not.toBe(secondColumn.digest);
	});

	it('retains the structural index postcondition guard with live and scratch projections', async () => {
		const step = {
			...dataDestructiveStep,
			expectedDeclaration: {
				value: {
					postconditionVersion: 2,
					kind: 'index',
					index: {
						schema: 'tenant',
						table: 'accounts',
						name: 'accounts_id_idx',
						method: 'btree',
						unique: false,
						valid: true,
						ready: true,
						live: true,
						columns: ['id'],
						nullsNotDistinct: false,
					},
				},
				digest: 'index-postcondition',
			},
			address: {
				...dataDestructiveStep.address,
				kind: 'index' as const,
				name: 'accounts_id_idx',
				parent: dataDestructiveStep.address,
			},
		} as const;
		const { query } = indexReadbackExecutor({
			live: { key_columns: ['other_id'], key_definitions: ['other_id'] },
		});
		await expect(
			readTestGeneratedPostcondition(
				{ query },
				step as unknown as NormalizedManagedStep,
				step.address! as never,
			),
		).rejects.toThrow('generated index accounts_id_idx postcondition differs');
		expect(
			query.mock.calls.some(([sql]) => sql.includes('WHERE namespace.nspname')),
		).toBe(true);
		expect(
			query.mock.calls.some(([sql]) => sql.includes('WHERE relation.oid')),
		).toBe(true);
	});

	it('retains the structural CHECK postcondition guard with live and scratch projections', async () => {
		const step = {
			...dataDestructiveStep,
			expectedDeclaration: {
				value: {
					postconditionVersion: 2,
					kind: 'constraint',
					constraint: {
						type: 'c',
						expression: 'CHECK (id > 0)',
						notValid: false,
					},
				},
				digest: 'constraint-postcondition',
			},
			address: {
				...dataDestructiveStep.address,
				kind: 'constraint' as const,
				name: 'accounts_check',
				parent: dataDestructiveStep.address,
			},
		} as const;
		const query = vi.fn(async (sql: string) => {
			if (sql.includes('namespace.nspname'))
				return {
					rows: [
						{
							expression: '(id < 0)',
							validated: true,
							no_inherit: false,
							enforced: true,
							is_local: true,
							inheritance_count: 0,
							parent_id: 0,
						},
					],
				};
			if (sql.includes('conrelid = $1'))
				return {
					rows: [
						{
							expression: '(id > 0)',
							validated: true,
							no_inherit: false,
							enforced: true,
							is_local: true,
							inheritance_count: 0,
							parent_id: 0,
						},
					],
				};
			return { rows: [] };
		});
		await expect(
			readTestGeneratedPostcondition(
				{ query },
				step as unknown as NormalizedManagedStep,
				step.address as never,
			),
		).rejects.toThrow(
			'generated constraint accounts_check postcondition differs',
		);
		expect(
			query.mock.calls.some(([sql]) => sql.includes('namespace.nspname')),
		).toBe(true);
		expect(
			query.mock.calls.some(([sql]) => sql.includes('conrelid = $1')),
		).toBe(true);
	});

	it.each([
		['invalid', { is_valid: false }],
		['not ready', { is_ready: false }],
		['not live', { is_live: false }],
	] as const)('refuses a present but unusable generated index when it is %s', async (_state, unavailable) => {
		const step = {
			...dataDestructiveStep,
			expectedDeclaration: {
				value: {
					postconditionVersion: 2,
					kind: 'index',
					index: {
						schema: 'tenant',
						table: 'accounts',
						name: 'accounts_id_idx',
						method: 'btree',
						unique: false,
						valid: true,
						ready: true,
						live: true,
						columns: ['id'],
						nullsNotDistinct: false,
					},
				},
				digest: 'index-postcondition',
			},
			address: {
				...dataDestructiveStep.address,
				kind: 'index' as const,
				name: 'accounts_id_idx',
				parent: dataDestructiveStep.address,
			},
		} as const;
		const { query } = indexReadbackExecutor({ live: unavailable });

		await expect(
			readTestGeneratedPostcondition(
				{ query },
				step as unknown as NormalizedManagedStep,
				step.address as never,
			),
		).rejects.toThrow('generated index accounts_id_idx postcondition differs');
		const projectionSql = query.mock.calls
			.map(([sql]) => sql)
			.find((sql) => sql.includes('index_meta.indisvalid'));
		expect(projectionSql).toContain('index_meta.indisvalid');
		expect(projectionSql).toContain('index_meta.indisready');
		expect(projectionSql).toContain('index_meta.indislive');
	});

	it('records an observed generated index only when it is valid, ready, and live', async () => {
		const step = {
			...dataDestructiveStep,
			expectedDeclaration: {
				value: {
					postconditionVersion: 2,
					kind: 'index',
					index: {
						schema: 'tenant',
						table: 'accounts',
						name: 'accounts_id_idx',
						method: 'btree',
						unique: false,
						valid: true,
						ready: true,
						live: true,
						columns: ['id'],
						nullsNotDistinct: false,
					},
				},
				digest: 'index-postcondition',
			},
			address: {
				...dataDestructiveStep.address,
				kind: 'index' as const,
				name: 'accounts_id_idx',
				parent: dataDestructiveStep.address,
			},
		} as const;

		await expect(
			readTestGeneratedPostcondition(
				indexReadbackExecutor({}),
				step as unknown as NormalizedManagedStep,
				step.address as never,
			),
		).resolves.toMatchObject({
			value: {
				kind: 'index',
				projection: expect.objectContaining({ method: 'btree' }),
			},
		});
	});

	it('rejects a legacy rendered-definition manifest before it can record observed', async () => {
		const query = vi.fn();
		const step = {
			...dataDestructiveStep,
			expectedDeclaration: {
				value: {
					kind: 'index',
					definition: 'CREATE INDEX accounts_id_idx ON tenant.accounts (id)',
				},
				digest: 'legacy-rendered-definition',
			},
			address: {
				...dataDestructiveStep.address,
				kind: 'index' as const,
				name: 'accounts_id_idx',
				parent: dataDestructiveStep.address,
			},
		} as const;
		await expect(
			readTestGeneratedPostcondition(
				{ query },
				step as unknown as NormalizedManagedStep,
				step.address as never,
			),
		).rejects.toThrow('replan');
		expect(query).not.toHaveBeenCalled();
	});

	it.each([
		[
			'enum labels',
			{ postconditionVersion: 2, kind: 'enum', labels: ['draft', 'paid'] },
			{
				...dataDestructiveStep.address,
				kind: 'enum' as const,
				name: 'order_state',
			},
			[{ label: 'draft' }],
		],
		[
			'sequence properties',
			{
				postconditionVersion: 2,
				kind: 'sequence',
				startValue: '7',
				incrementBy: '3',
				cycle: false,
			},
			{
				...dataDestructiveStep.address,
				kind: 'sequence' as const,
				name: 'order_number',
			},
			[
				{
					start_value: '7',
					increment_by: '1',
					min_value: '1',
					max_value: '100',
					cache_size: '1',
					cycle: false,
				},
			],
		],
		[
			'extension version',
			{ postconditionVersion: 2, kind: 'extension', version: '1.3' },
			{
				...dataDestructiveStep.address,
				scope: 'database' as const,
				kind: 'extension' as const,
				name: 'pgcrypto',
			},
			[{ version: '1.2' }],
		],
	] as const)('refuses a changed generated %s rather than recording observed', async (_name, value, address, rows) => {
		const step = {
			...dataDestructiveStep,
			expectedDeclaration: { value, digest: 'typed-postcondition' },
			address,
		} as unknown as NormalizedManagedStep;
		await expect(
			readTestGeneratedPostcondition(
				{ query: vi.fn().mockResolvedValue({ rows }) },
				step,
				address as never,
			),
		).rejects.toThrow('postcondition differs');
	});

	it('reads CREATE TABLE columns when a separately-rendered constraint follows it', async () => {
		const step: NormalizedManagedStep = {
			...dataDestructiveStep,
			expectedDeclaration: {
				value: {
					postconditionVersion: 2,
					kind: 'table',
					columns: [
						{ name: 'id', type: 'integer', nullable: false, hasDefault: false },
					],
				},
				digest: 'table-postcondition',
			},
			statementBundle: {
				statements: [
					{
						ordinal: 0,
						sql: 'CREATE TABLE tenant.accounts ("id" INTEGER NOT NULL)',
					},
					{
						ordinal: 1,
						sql: 'ALTER TABLE tenant.accounts ADD CONSTRAINT "pk_accounts" PRIMARY KEY ("id")',
					},
				],
			},
		};
		await expect(
			readTestGeneratedPostcondition(
				{
					query: vi.fn().mockResolvedValue({
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
					}),
				},
				step,
				step.address!,
			),
		).resolves.toMatchObject({ value: { kind: 'table' } });
	});

	it('validates plan fixtures before destructive admission and passes the branded manifest', async () => {
		executePgAdmittedOperation.mockResolvedValue({
			kind: 'executed-destructive-outcome',
		});
		const plan = { steps: [dataDestructiveStep] };
		const pool = {
			query: vi.fn().mockResolvedValue({ rows: [{ database_id: 'app' }] }),
		};

		await expect(
			executeGeneratorPlan({
				pool: pool as never,
				run: {} as never,
				plan,
				planDigest: 'reviewed-plan',
				schema: 'tenant',
				accepts: ['destructive-plan-accepted:reviewed-plan'],
				runId: 'reviewed-run',
				recordAttempt: async () => undefined,
			}),
		).resolves.toEqual({ outcome: 'completed' });

		expect(executePgAdmittedOperation).toHaveBeenCalledTimes(1);
		const admission = executePgAdmittedOperation.mock.calls[0]?.[1] as {
			readonly manifest: ValidatedManagedStepManifest;
			readonly operation: { readonly kind: string };
		};
		const manifest: ValidatedManagedStepManifest = admission.manifest;
		expect(admission.operation.kind).toBe('destructive-outcome');
		expect(manifest.steps).toEqual(plan.steps);
		expect(manifest.steps).not.toBe(plan.steps);
		expect(Object.isFrozen(manifest)).toBe(true);
		expect(Object.isFrozen(manifest.steps)).toBe(true);
	});

	it('preserves a post-executing open claim as recovery-required', async () => {
		executePgAdmittedOperation.mockResolvedValue({
			kind: 'outcome-recovery-required',
			claimId: 'open-claim',
			reason: 'sender disconnected after executing committed',
		});
		const step: NormalizedManagedStep = {
			...dataDestructiveStep,
			statementBundle: {
				statements: [
					{ ordinal: 0, sql: 'CREATE TABLE tenant.accounts (id integer)' },
				],
			},
			classification: 'non-destructive',
		};
		await expect(
			executeGeneratorPlan({
				pool: {
					query: vi.fn().mockResolvedValue({ rows: [{ database_id: 'app' }] }),
				} as never,
				run: {} as never,
				plan: { steps: [step] },
				planDigest: 'reviewed-plan',
				schema: 'tenant',
				runId: 'reviewed-run',
				recordAttempt: async () => undefined,
			}),
		).resolves.toEqual({
			outcome: 'recovery-required',
			claimId: 'open-claim',
			detail:
				'claim open-claim remains open and requires recovery: sender disconnected after executing committed',
		});
	});

	it('preserves a non-destructive transport ambiguity', async () => {
		executePgAdmittedOperation.mockResolvedValue({
			kind: 'outcome-transport-ambiguous',
			reason: 'commit acknowledgement lost',
		});
		const step: NormalizedManagedStep = {
			...dataDestructiveStep,
			statementBundle: {
				statements: [
					{ ordinal: 0, sql: 'CREATE TABLE tenant.accounts (id integer)' },
				],
			},
			classification: 'non-destructive',
		};
		await expect(
			executeGeneratorPlan({
				pool: {
					query: vi.fn().mockResolvedValue({ rows: [{ database_id: 'app' }] }),
				} as never,
				run: {} as never,
				plan: { steps: [step] },
				planDigest: 'reviewed-plan',
				schema: 'tenant',
				runId: 'reviewed-run',
				recordAttempt: async () => undefined,
			}),
		).resolves.toEqual({
			outcome: 'transport-ambiguous',
			detail: 'commit acknowledgement lost',
		});
	});

	it('maps a destructive transport recovery to the claim-bearing exit outcome', async () => {
		executePgAdmittedOperation.mockResolvedValue({
			kind: 'outcome-recovery-required',
			claimId: 'destructive-open-claim',
			reason: 'terminal COMMIT acknowledgement was lost',
		});
		await expect(
			executeGeneratorPlan({
				pool: {
					query: vi.fn().mockResolvedValue({ rows: [{ database_id: 'app' }] }),
				} as never,
				run: {} as never,
				plan: { steps: [dataDestructiveStep] },
				planDigest: 'reviewed-plan',
				schema: 'tenant',
				accepts: ['destructive-plan-accepted:reviewed-plan'],
				runId: 'reviewed-run',
				recordAttempt: async () => undefined,
			}),
		).resolves.toEqual({
			outcome: 'recovery-required',
			claimId: 'destructive-open-claim',
			detail:
				'claim destructive-open-claim remains open and requires recovery: terminal COMMIT acknowledgement was lost',
		});
	});

	it('preserves a destructive transport ambiguity', async () => {
		executePgAdmittedOperation.mockResolvedValue({
			kind: 'outcome-transport-ambiguous',
			reason: 'terminal commit acknowledgement lost',
		});
		await expect(
			executeGeneratorPlan({
				pool: {
					query: vi.fn().mockResolvedValue({ rows: [{ database_id: 'app' }] }),
				} as never,
				run: {} as never,
				plan: { steps: [dataDestructiveStep] },
				planDigest: 'reviewed-plan',
				schema: 'tenant',
				accepts: ['destructive-plan-accepted:reviewed-plan'],
				runId: 'reviewed-run',
				recordAttempt: async () => undefined,
			}),
		).resolves.toEqual({
			outcome: 'transport-ambiguous',
			detail: 'terminal commit acknowledgement lost',
		});
	});
});
