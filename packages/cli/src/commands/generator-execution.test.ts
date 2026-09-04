import {
	GeneratedPostconditionBindingResolutionError,
	type GeneratedPostconditionSession,
	generatedPostconditionDigest,
	generatedPostconditionForChange,
	type verifyGeneratedCheckPostcondition as VerifyGeneratedCheckPostcondition,
	type verifyGeneratedColumnPostcondition as VerifyGeneratedColumnPostcondition,
	type verifyGeneratedIndexPostcondition as VerifyGeneratedIndexPostcondition,
	type verifyGeneratedTablePostcondition as VerifyGeneratedTablePostcondition,
	withGeneratedPostconditionSession,
} from '@dbsp/adapter-pgsql';
import {
	canonicalJsonDigest,
	type ValidatedManagedStepManifest,
} from '@dbsp/core';
import type { LedgerAddress, NormalizedManagedStep } from '@dbsp/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const executePgAdmittedOperation = vi.hoisted(() => vi.fn());
const preflightPgDeclaredAdoption = vi.hoisted(() => vi.fn());
const executePgDeclaredAdoption = vi.hoisted(() => vi.fn());
const executePgPersistedTableReaddress = vi.hoisted(() => vi.fn());
const verifyGeneratedTablePostcondition = vi.hoisted(() => vi.fn());
const verifyGeneratedColumnPostcondition = vi.hoisted(() => vi.fn());
const verifyGeneratedIndexPostcondition = vi.hoisted(() => vi.fn());
const verifyGeneratedCheckPostcondition = vi.hoisted(() => vi.fn());
const v3VerifierDelegates = vi.hoisted(() => ({
	table: undefined as unknown as typeof VerifyGeneratedTablePostcondition,
	column: undefined as unknown as typeof VerifyGeneratedColumnPostcondition,
	index: undefined as unknown as typeof VerifyGeneratedIndexPostcondition,
	check: undefined as unknown as typeof VerifyGeneratedCheckPostcondition,
}));

vi.mock('@dbsp/adapter-pgsql', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@dbsp/adapter-pgsql')>();
	v3VerifierDelegates.table = actual.verifyGeneratedTablePostcondition;
	v3VerifierDelegates.column = actual.verifyGeneratedColumnPostcondition;
	v3VerifierDelegates.index = actual.verifyGeneratedIndexPostcondition;
	v3VerifierDelegates.check = actual.verifyGeneratedCheckPostcondition;
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
		verifyGeneratedTablePostcondition: (...args: unknown[]) =>
			verifyGeneratedTablePostcondition(...args),
		verifyGeneratedColumnPostcondition: (...args: unknown[]) =>
			verifyGeneratedColumnPostcondition(...args),
		verifyGeneratedIndexPostcondition: (...args: unknown[]) =>
			verifyGeneratedIndexPostcondition(...args),
		verifyGeneratedCheckPostcondition: (...args: unknown[]) =>
			verifyGeneratedCheckPostcondition(...args),
	};
});

beforeEach(() => {
	verifyGeneratedTablePostcondition.mockReset();
	verifyGeneratedColumnPostcondition.mockReset();
	verifyGeneratedIndexPostcondition.mockReset();
	verifyGeneratedCheckPostcondition.mockReset();
	verifyGeneratedTablePostcondition.mockImplementation(
		v3VerifierDelegates.table,
	);
	verifyGeneratedColumnPostcondition.mockImplementation(
		v3VerifierDelegates.column,
	);
	verifyGeneratedIndexPostcondition.mockImplementation(
		v3VerifierDelegates.index,
	);
	verifyGeneratedCheckPostcondition.mockImplementation(
		v3VerifierDelegates.check,
	);
});

import {
	executeGeneratorPlan,
	type GeneratedIdentityObservation,
	type GeneratedStructuralObservation,
	readGeneratedPostcondition,
} from './generator-execution.js';

const generatedIdentityObservation = {
	value: { kind: 'identity-observed' },
	digest: 'identity-observation',
	payloadKind: 'generated-identity-observation',
} satisfies GeneratedIdentityObservation;
// @ts-expect-error Generated identity evidence cannot occupy a structural slot.
const identityInStructuralSlot: GeneratedStructuralObservation =
	generatedIdentityObservation;
void identityInStructuralSlot;

async function readTestGeneratedPostcondition(
	executor: Pick<GeneratedPostconditionSession, 'query'>,
	step: NormalizedManagedStep,
	address: Parameters<typeof readGeneratedPostcondition>[2],
) {
	const declaration = step.expectedDeclaration;
	const material =
		declaration?.value &&
		typeof declaration.value === 'object' &&
		!Array.isArray(declaration.value) &&
		typeof (declaration.value as { postconditionVersion?: unknown })
			.postconditionVersion === 'number'
			? {
					...step,
					expectedDeclaration: {
						...declaration,
						digest: generatedPostconditionDigest(
							declaration.value as { postconditionVersion: number },
						),
					},
				}
			: step;
	return withGeneratedPostconditionSession(
		{
			connect: async () => ({
				query: async (sql: string, params?: readonly unknown[]) => {
					if (sql.startsWith('LOCK TABLE ONLY')) return { rows: [] };
					const result = await executor.query(sql, params);
					if (!sql.includes('pg_catalog.current_database()')) return result;
					return {
						rows: result.rows.map((row) => ({
							database_name: 'app',
							relation_oid: '101',
							...(sql.includes('type_item.oid')
								? { relation_kind: 'e', object_oid: '102' }
								: sql.includes('pg_catalog.pg_extension extension')
									? { relation_kind: 'x', object_oid: '102' }
									: sql.includes(
												'relation.oid::text AS relation_oid, relation.oid::text AS object_oid',
											)
										? { relation_kind: 'S', object_oid: '102' }
										: sql.includes('index_relation.oid')
											? {
													relation_kind: 'i',
													parent_relation_kind: 'r',
													table_name: 'accounts',
												}
											: sql.includes('constraint_item.oid')
												? { relation_kind: 'r', constraint_name: params?.[2] }
												: { relation_kind: 'r' }),
							...(sql.includes('attribute.attnum')
								? { attribute_number: 1 }
								: {}),
							...(sql.includes('index_relation.oid') ||
							sql.includes('constraint_item.oid')
								? { object_oid: '102' }
								: {}),
							...row,
						})),
					};
				},
				release: () => undefined,
			}),
		},
		(session) => readGeneratedPostcondition(session, material, address),
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

/** Every generated fixture uses the address-free v3 declaration contract. */
function v3<const Declaration extends Record<string, unknown>>(
	declaration: Declaration,
) {
	return {
		postconditionVersion: 3 as const,
		targetBinding: {
			bindingVersion: 1 as const,
			bindingKind: 'managed-step-address' as const,
		},
		declaration: { canonicalFormVersion: 1 as const, ...declaration },
	};
}

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

function columnProjectionRow(overrides: Record<string, unknown> = {}) {
	return {
		relation_kind: 'r',
		column_name: 'id',
		column_type: 'integer',
		is_not_null: true,
		column_default: null,
		collation_name: null,
		identity_kind: '',
		...overrides,
	};
}

function indexReadbackExecutor(input: {
	readonly live?: Record<string, unknown>;
	readonly staged?: Record<string, unknown>;
}) {
	return {
		query: vi.fn(async (sql: string) => {
			if (sql.startsWith('LOCK TABLE ONLY')) return { rows: [] };
			if (sql.includes('FROM pg_catalog.pg_class index_relation'))
				return {
					rows: [
						{
							database_name: 'app',
							relation_kind: 'i',
							parent_relation_kind: 'r',
							relation_oid: '101',
							object_oid: '102',
							table_name: 'accounts',
						},
					],
				};
			if (sql.includes('::pg_catalog.regclass'))
				return { rows: [indexProjectionRow(input.staged)] };
			if (sql.includes('index_meta.indisunique'))
				return { rows: [indexProjectionRow(input.live)] };
			return { rows: [] };
		}),
	};
}

describe('generator execution fixture shim', () => {
	it('names an undecodable generated declaration rather than a missing structural postcondition', async () => {
		await expect(
			readTestGeneratedPostcondition(
				{ query: vi.fn() },
				dataDestructiveStep,
				dataDestructiveStep.address!,
			),
		).rejects.toThrow(
			'generated table step generator:0 has no decodable generated declaration',
		);
	});

	it('dispatches an absence declaration through the destructive absence read-back', async () => {
		const step = {
			...dataDestructiveStep,
			expectedDeclaration: {
				value: v3({ kind: 'absent' }),
				digest: 'absence-postcondition',
			},
		} as NormalizedManagedStep;
		const query = vi.fn(async () => ({ rows: [] }));
		await expect(
			readTestGeneratedPostcondition({ query }, step, step.address!),
		).resolves.toMatchObject({ value: { kind: 'absent' } });
		expect(query).toHaveBeenCalled();
	});

	it.each([
		[
			'table',
			{
				postconditionVersion: 3,
				targetBinding: {
					bindingVersion: 1,
					bindingKind: 'managed-step-address',
				},
				declaration: {
					canonicalFormVersion: 1,
					kind: 'table',
					columns: [{ name: 'id' }],
				},
			},
			dataDestructiveStep.address,
			verifyGeneratedTablePostcondition,
			{
				kind: 'table',
				projection: {
					columns: [
						{
							name: 'id',
							type: 'integer',
							nullable: false,
							default: undefined,
							collation: null,
							identity: null,
						},
					],
				},
			},
		],
		[
			'column',
			{
				postconditionVersion: 3,
				targetBinding: {
					bindingVersion: 1,
					bindingKind: 'managed-step-address',
				},
				declaration: {
					canonicalFormVersion: 1,
					kind: 'column',
					column: { type: 'integer', nullable: false },
				},
			},
			{
				...dataDestructiveStep.address,
				kind: 'column',
				name: 'id',
				parent: dataDestructiveStep.address,
			},
			verifyGeneratedColumnPostcondition,
			{
				kind: 'column',
				projection: {
					type: 'integer',
					nullable: false,
					default: undefined,
					collation: null,
					identity: null,
				},
			},
		],
		[
			'index',
			{
				postconditionVersion: 3,
				targetBinding: {
					bindingVersion: 1,
					bindingKind: 'managed-step-address',
				},
				declaration: {
					canonicalFormVersion: 1,
					kind: 'index',
					index: {
						method: 'btree',
						unique: false,
						valid: true,
						ready: true,
						live: true,
						columns: ['id'],
						nullsNotDistinct: false,
					},
				},
			},
			{
				...dataDestructiveStep.address,
				kind: 'index',
				name: 'accounts_id_idx',
				parent: dataDestructiveStep.address,
			},
			verifyGeneratedIndexPostcondition,
			{ kind: 'index', projection: { method: 'btree' } },
		],
		[
			'check',
			{
				postconditionVersion: 3,
				targetBinding: {
					bindingVersion: 1,
					bindingKind: 'managed-step-address',
				},
				declaration: {
					canonicalFormVersion: 1,
					kind: 'check',
					check: {
						expression: {
							canonicalFormVersion: 1,
							sql: 'CHECK (id > 0)',
						},
						notValid: false,
					},
				},
			},
			{
				...dataDestructiveStep.address,
				kind: 'constraint',
				name: 'accounts_id_check',
				parent: dataDestructiveStep.address,
			},
			verifyGeneratedCheckPostcondition,
			{
				kind: 'constraint',
				projection: {
					expression: 'CHECK (id > 0)',
					validated: true,
					noInherit: false,
					enforced: true,
					isLocal: true,
					inheritanceCount: 0,
					parentId: 0,
				},
			},
		],
	] as const)(
		'routes a v3 %s postcondition through its binding-aware verifier',
		async (_kind, value, address, verify, result) => {
			vi.clearAllMocks();
			verify.mockResolvedValue(result);
			const step = {
				...dataDestructiveStep,
				address,
				expectedDeclaration: { value, digest: 'v3-postcondition' },
			} as unknown as NormalizedManagedStep;

			await readTestGeneratedPostcondition(
				{ query: vi.fn() },
				step,
				address as LedgerAddress,
			);

			expect(verify).toHaveBeenCalledWith(
				expect.objectContaining({ postcondition: value, address }),
			);
		},
	);

	it('refuses a malformed v3 binding address before verifier dispatch', async () => {
		const address: LedgerAddress = {
			...dataDestructiveStep.address!,
			kind: 'column',
			name: 'id',
		};
		const declaration = v3({
			kind: 'column',
			column: { type: 'integer', nullable: false },
		});
		const step = {
			...dataDestructiveStep,
			address,
			expectedDeclaration: {
				value: declaration,
				digest: generatedPostconditionDigest(declaration),
			},
		} as unknown as NormalizedManagedStep;
		verifyGeneratedColumnPostcondition.mockResolvedValue({
			kind: 'column',
			catalogueIdentity: {
				engine: 'postgresql',
				format: 1,
				value: { parentOid: 'proof-scope-X', name: 'id' },
			},
			projection: {
				type: 'integer',
				nullable: false,
				default: undefined,
				collation: null,
				identity: null,
			},
		});

		await expect(
			readTestGeneratedPostcondition({ query: vi.fn() }, step, address),
		).rejects.toBeInstanceOf(GeneratedPostconditionBindingResolutionError);
		expect(verifyGeneratedColumnPostcondition).not.toHaveBeenCalled();
	});

	it('refuses a deferred declaration/address kind mismatch before catalogue observation', async () => {
		const query = vi.fn(async (_sql: string) => ({ rows: [{ oid: '401' }] }));
		const address = {
			scope: 'schema' as const,
			engine: 'postgresql',
			database: 'app',
			schema: 'tenant',
			kind: 'sequence' as const,
			name: 'accounts_id_seq',
		};
		const step = {
			...dataDestructiveStep,
			address,
			expectedDeclaration: {
				value: v3({ kind: 'enum', labels: ['active'] }),
				digest: 'v3-postcondition',
			},
		} as unknown as NormalizedManagedStep;
		await expect(
			readTestGeneratedPostcondition({ query }, step, address),
		).rejects.toThrow('generated postcondition binding');
		expect(
			query.mock.calls.some(([sql]) =>
				String(sql).includes('pg_catalog.current_database()'),
			),
		).toBe(false);
	});

	it('normalizes deferred observation payloads before their persisted JSON round trip', async () => {
		const address = {
			scope: 'database' as const,
			engine: 'postgresql',
			database: 'app',
			kind: 'extension' as const,
			name: 'pgcrypto',
		};
		const step = {
			...dataDestructiveStep,
			address,
			expectedDeclaration: {
				value: v3({ kind: 'extension', version: '1.0' }),
				digest: 'v3-postcondition',
			},
		} as unknown as NormalizedManagedStep;
		const observed = await readTestGeneratedPostcondition(
			{ query: vi.fn(async () => ({ rows: [{ oid: '401' }] })) },
			step,
			address,
		);
		expect(observed.value).toEqual(JSON.parse(JSON.stringify(observed.value)));
		expect(
			Object.hasOwn((observed.value as { address: object }).address, 'schema'),
		).toBe(false);
	});

	it.each([
		[
			'non-CHECK constraint',
			v3({
				kind: 'constraint',
				constraint: {
					type: 'p',
					columns: ['id'],
					deferrable: false,
					initiallyDeferred: false,
					enforced: true,
				},
			}),
			{
				...dataDestructiveStep.address,
				kind: 'constraint',
				name: 'accounts_pkey',
				parent: dataDestructiveStep.address,
			},
			undefined,
			undefined,
		],
		[
			'enum',
			v3({ kind: 'enum', labels: ['active'] }),
			{
				...dataDestructiveStep.address,
				kind: 'enum',
				name: 'status',
				parent: undefined,
			},
			undefined,
			undefined,
		],
		[
			'sequence',
			v3({ kind: 'sequence', startValue: '1', incrementBy: '1' }),
			{
				...dataDestructiveStep.address,
				kind: 'sequence',
				name: 'accounts_id_seq',
				parent: undefined,
			},
			undefined,
			undefined,
		],
		[
			'extension',
			v3({ kind: 'extension', version: '1.0' }),
			{
				scope: 'database',
				engine: 'postgresql',
				database: 'app',
				kind: 'extension',
				name: 'pgcrypto',
			},
			undefined,
			undefined,
		],
	] as const)(
		'records an identity-only observation for every deferred v3 %s kind',
		async (_label, value, address, _verify, _result) => {
			const step = {
				...dataDestructiveStep,
				address,
				expectedDeclaration: { value, digest: 'v3-postcondition' },
			} as unknown as NormalizedManagedStep;
			await readTestGeneratedPostcondition(
				{ query: vi.fn(async () => ({ rows: [{ oid: '401' }] })) },
				step,
				address as LedgerAddress,
			);
			const observed = await readTestGeneratedPostcondition(
				{ query: vi.fn(async () => ({ rows: [{ oid: '401' }] })) },
				step,
				address as LedgerAddress,
			);
			expect(observed.value).toMatchObject({
				kind: 'identity-observed',
				observedKind: address.kind,
				structuralSemantics: 'unverified',
			});
		},
	);

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
					value: v3({ kind: 'column', column: { type: 'bigint' } }),
					digest: 'column-postcondition',
				},
				address: {
					...dataDestructiveStep.address,
					kind: 'column' as const,
					name: 'id',
					parent: dataDestructiveStep.address,
				},
			},
			[
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
		],
	] as const)(
		'refuses a present-but-unmutated generated %s rather than recording observed',
		async (step, rows) => {
			await expect(
				readTestGeneratedPostcondition(
					{ query: vi.fn().mockResolvedValue({ rows }) },
					step as unknown as NormalizedManagedStep,
					step.address! as never,
				),
			).rejects.toThrow('generated column id type postcondition differs');
		},
	);

	it.each([
		['string nullability', { is_not_null: 't' }],
		['unknown identity', { identity_kind: 'x' }],
	])(
		'refuses an incomplete generated column projection with %s',
		async (_label, override) => {
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
					value: v3({
						kind: 'column',
						column: {
							type: 'integer',
							nullable: false,
							default: {
								defaultKind: 'none',
								hasDefault: false,
								identity: null,
							},
						},
					}),
					digest: 'column-postcondition',
				},
			} as unknown as NormalizedManagedStep;
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
									...override,
								},
							],
						}),
					},
					step,
					address,
				),
			).rejects.toThrow('generated column id has an incomplete projection');
		},
	);

	it.each([
		[
			'a view relation',
			columnProjectionRow({ relation_kind: 'v' }),
			'generated column id parent is not a table',
		],
		[
			'another projected column',
			columnProjectionRow({ column_name: 'other_id' }),
			'generated column id projection names another column',
		],
		['no projected column', undefined, 'generated column id is absent'],
	] as const)(
		'refuses generated column binding or proof for %s',
		async (_case, row, message) => {
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
					value: v3({
						kind: 'column',
						column: { type: 'integer', nullable: false },
					}),
					digest: 'column-postcondition',
				},
			} as unknown as NormalizedManagedStep;
			const query = vi.fn(async (sql: string) => ({
				rows: sql.startsWith('LOCK TABLE ONLY')
					? []
					: row === undefined
						? []
						: [
								sql.includes('relation.relkind AS relation_kind') ||
								row.relation_kind !== 'v'
									? row
									: Object.fromEntries(
											Object.entries(row).filter(
												([key]) => key !== 'relation_kind',
											),
										),
							],
			}));
			await expect(
				readTestGeneratedPostcondition(
					{ query },
					step,
					address as LedgerAddress,
				),
			).rejects.toThrow(
				row === undefined ||
					row.column_name !== 'id' ||
					row.relation_kind === 'v'
					? 'generated postcondition binding did not resolve'
					: message,
			);
			if (row?.relation_kind === 'v') {
				const bindingQuery = query.mock.calls.find(
					([sql]) =>
						typeof sql === 'string' &&
						sql.includes('relation.relkind AS relation_kind'),
				);
				expect(bindingQuery?.[0]).toContain(
					'relation.relkind AS relation_kind',
				);
			}
		},
	);

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
				value: v3({
					kind: 'column',
					column: { type: 'text', nullable: true, authoredCollation: null },
				}),
				digest: 'column-postcondition',
			},
		} as unknown as NormalizedManagedStep;
		await expect(
			readTestGeneratedPostcondition(
				{
					query: vi.fn().mockResolvedValue({
						rows: [
							{
								relation_kind: 'r',
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
				value: v3({
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
				}),
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
				value: v3({
					kind: 'table',
					columns: [{ name: 'id', type: 'integer', nullable: false }],
				}),
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
				value: v3({
					kind: 'column',
					column: { type: 'integer', nullable: false },
				}),
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
				columnStep,
				columnStep.address!,
			);
		const firstTable = await tableRead('C');
		const secondTable = await tableRead('POSIX');
		expect(firstTable.value).toMatchObject({
			columns: [{ collation: 'C', identity: 'always' }],
		});
		expect(firstTable.digest).not.toBe(secondTable.digest);
		expect(firstTable.digest).toBe(canonicalJsonDigest(firstTable.value));
		const firstColumn = await columnRead('C');
		const secondColumn = await columnRead('POSIX');
		expect(firstColumn.value).toMatchObject({
			collation: 'C',
			identity: 'always',
		});
		expect(firstColumn.digest).not.toBe(secondColumn.digest);
		expect(firstColumn.digest).toBe(canonicalJsonDigest(firstColumn.value));
	});

	it('retains the structural index postcondition guard with live and scratch projections', async () => {
		const step = {
			...dataDestructiveStep,
			expectedDeclaration: {
				value: v3({
					kind: 'index',
					index: {
						method: 'btree',
						unique: false,
						valid: true,
						ready: true,
						live: true,
						columns: ['id'],
						nullsNotDistinct: false,
					},
				}),
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
				value: v3({
					kind: 'check',
					check: {
						expression: { canonicalFormVersion: 1, sql: 'CHECK (id > 0)' },
						notValid: false,
					},
				}),
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
			if (sql.includes('constraint_item.oid::text AS object_oid'))
				return {
					rows: [{ relation_kind: 'r', constraint_name: 'accounts_check' }],
				};
			if (sql.includes('constraint_item.conrelid = $1::pg_catalog.oid'))
				return {
					rows: [
						{
							constraint_type: 'c',
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
			if (sql.includes('conrelid = $1::pg_catalog.regclass'))
				return {
					rows: [
						{
							constraint_type: 'c',
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
	] as const)(
		'refuses a present but unusable generated index when it is %s',
		async (_state, unavailable) => {
			const step = {
				...dataDestructiveStep,
				expectedDeclaration: {
					value: v3({
						kind: 'index',
						index: {
							method: 'btree',
							unique: false,
							valid: true,
							ready: true,
							live: true,
							columns: ['id'],
							nullsNotDistinct: false,
						},
					}),
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
			).rejects.toThrow(
				'generated index accounts_id_idx postcondition differs',
			);
			const projectionSql = query.mock.calls
				.map(([sql]) => sql)
				.find((sql) => sql.includes('index_meta.indisvalid'));
			expect(projectionSql).toContain('index_meta.indisvalid');
			expect(projectionSql).toContain('index_meta.indisready');
			expect(projectionSql).toContain('index_meta.indislive');
		},
	);

	it('records an observed generated index only when it is valid, ready, and live', async () => {
		const step = {
			...dataDestructiveStep,
			expectedDeclaration: {
				value: v3({
					kind: 'index',
					index: {
						method: 'btree',
						unique: false,
						valid: true,
						ready: true,
						live: true,
						columns: ['id'],
						nullsNotDistinct: false,
					},
				}),
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

	it('folds legacy generated reader payloads into REPLAN_REQUIRED before query', async () => {
		const query = vi.fn();
		const address = {
			...dataDestructiveStep.address,
			kind: 'enum' as const,
			name: 'order_state',
		};
		const step = {
			...dataDestructiveStep,
			stepKey: 'generator:legacy-enum',
			address,
			expectedDeclaration: {
				value: { postconditionVersion: 2, kind: 'enum', labels: [] },
				digest: 'legacy',
			},
		} as unknown as NormalizedManagedStep;
		await expect(
			readTestGeneratedPostcondition({ query }, step, address as LedgerAddress),
		).rejects.toMatchObject({
			code: 'REPLAN_REQUIRED',
			diagnostic: { versionSeen: 2, stepIdentity: 'generator:legacy-enum' },
		});
		expect(query).not.toHaveBeenCalled();
	});
	it('reads CREATE TABLE columns when a separately-rendered constraint follows it', async () => {
		const step: NormalizedManagedStep = {
			...dataDestructiveStep,
			expectedDeclaration: {
				value: v3({
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
				}),
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

	it('records proof-scoped identity and a real observation for an untyped column-type terminal', async () => {
		const address = {
			...dataDestructiveStep.address!,
			kind: 'column' as const,
			name: 'id',
			parent: dataDestructiveStep.address!,
		};
		const expectedDeclaration = generatedPostconditionForChange({
			change: {
				kind: 'alter_column_type',
				table: 'accounts',
				column: 'id',
				destructive: true,
				details: 'untyped column-type target',
			},
			schema: 'tenant',
		});
		if (!expectedDeclaration)
			throw new Error('missing partial column declaration');
		const declaration = expectedDeclaration.value;
		const step = {
			...dataDestructiveStep,
			address,
			expectedDeclaration,
		} as unknown as NormalizedManagedStep;
		verifyGeneratedColumnPostcondition.mockResolvedValue({
			kind: 'column',
			catalogueIdentity: {
				engine: 'postgresql',
				format: 1,
				value: { parentOid: 'proof-scope-X', name: 'id' },
			},
			projection: {
				type: 'bigint',
				nullable: false,
				default: undefined,
				collation: null,
				identity: null,
			},
		});
		let observed: unknown;
		let recordedIdentity: unknown;
		executePgAdmittedOperation.mockImplementation(
			async (
				_executor,
				input: {
					operation: {
						readBackAndResolve: (executor: {
							query(): Promise<{
								readonly rows: readonly Record<string, unknown>[];
							}>;
						}) => Promise<{
							readonly members: readonly {
								readonly member: {
									readonly observed?: unknown;
									readonly catalogueIdentity?: unknown;
								};
							}[];
						}>;
					};
				},
			) => {
				const resolution = await input.operation.readBackAndResolve({
					query: async () => ({
						rows: [{ parent_oid: 'separate-read-Y' }],
					}),
				});
				observed = resolution.members[0]?.member.observed;
				recordedIdentity = resolution.members[0]?.member.catalogueIdentity;
				return { kind: 'executed-destructive-outcome' };
			},
		);

		await expect(
			executeGeneratorPlan({
				pool: {
					query: vi.fn().mockResolvedValue({ rows: [{ database_id: 'app' }] }),
				} as never,
				run: {} as never,
				plan: { steps: [step] },
				planDigest: 'reviewed-plan',
				schema: 'tenant',
				accepts: ['destructive-plan-accepted:reviewed-plan'],
				runId: 'reviewed-run',
				recordAttempt: async () => undefined,
			}),
		).resolves.toEqual({ outcome: 'completed' });
		expect(verifyGeneratedColumnPostcondition.mock.calls[0]?.[0]).toMatchObject(
			{
				postcondition: declaration,
			},
		);
		expect(observed).toMatchObject({
			value: { kind: 'column', type: 'bigint', nullable: false },
		});
		expect(recordedIdentity).toEqual({
			engine: 'postgresql',
			format: 1,
			value: { parentOid: 'proof-scope-X', name: 'id' },
		});
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
