import { canonicalJsonDigest } from '@dbsp/core';
import type { LedgerAddress, NormalizedManagedStep } from '@dbsp/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as generatedPostconditionReader from './generated-postcondition-reader.js';
import {
	readGeneratedPostcondition,
	readGeneratedPostconditionReadBack,
} from './generated-postcondition-reader.js';
import {
	GeneratedPostconditionBindingResolutionError,
	type GeneratedPostconditionSession,
	withGeneratedPostconditionSession,
} from './generated-postcondition-verifier.js';
import {
	generatedPostconditionDigest,
	generatedPostconditionForChange,
} from './managed-step-manifest.js';

const verifyGeneratedTablePostcondition = vi.hoisted(() => vi.fn());
const verifyGeneratedColumnPostcondition = vi.hoisted(() => vi.fn());
const verifyGeneratedIndexPostcondition = vi.hoisted(() => vi.fn());
const verifyGeneratedCheckPostcondition = vi.hoisted(() => vi.fn());

vi.mock('./generated-postcondition-verifier.js', async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import('./generated-postcondition-verifier.js')
		>();
	return {
		...actual,
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
});

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
				query: executor.query,
				release: () => undefined,
			}),
		},
		(session) => readGeneratedPostcondition(session, material, address),
	);
}

function v3Step(
	postcondition: { readonly postconditionVersion: number },
	address: LedgerAddress,
): NormalizedManagedStep {
	return {
		...dataDestructiveStep,
		address,
		expectedDeclaration: {
			value: postcondition,
			digest: generatedPostconditionDigest(postcondition),
		},
	} as unknown as NormalizedManagedStep;
}

describe('generated postcondition reader', () => {
	it('keeps decoded postcondition helpers module-private', () => {
		expect(generatedPostconditionReader).not.toHaveProperty(
			'generatedPostcondition',
		);
		expect(generatedPostconditionReader).not.toHaveProperty(
			'readGeneratedV3Postcondition',
		);
	});

	it('refuses an undecodable absence declaration before read-back dispatch', async () => {
		const query = vi.fn();
		const step = {
			...dataDestructiveStep,
			expectedDeclaration: {
				value: { declaration: { kind: 'absent' } },
				digest: 'hostile-undecodable-absence',
			},
		} as unknown as NormalizedManagedStep;

		await expect(
			withGeneratedPostconditionSession(
				{
					connect: async () => ({ query, release: () => undefined }),
				},
				(session) =>
					readGeneratedPostconditionReadBack(
						session,
						step,
						dataDestructiveStep.address!,
					),
			),
		).rejects.toThrow();
		expect(query).not.toHaveBeenCalled();
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

	it('routes an untyped column-type postcondition through its binding-aware verifier', async () => {
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
		const verified = {
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
		};
		verifyGeneratedColumnPostcondition.mockResolvedValue(verified);
		const readBack = await withGeneratedPostconditionSession(
			{
				connect: async () => ({
					query: vi.fn(),
					release: () => undefined,
				}),
			},
			(session) => readGeneratedPostconditionReadBack(session, step, address),
		);
		expect(verifyGeneratedColumnPostcondition.mock.calls[0]?.[0]).toMatchObject(
			{
				postcondition: declaration,
			},
		);
		const expectedValue = {
			kind: 'column',
			type: verified.projection.type,
			nullable: verified.projection.nullable,
			collation: verified.projection.collation,
			identity: verified.projection.identity,
		};
		expect(readBack).toEqual({
			catalogueIdentity: verified.catalogueIdentity,
			observed: {
				value: expectedValue,
				digest: canonicalJsonDigest(expectedValue),
				payloadKind: 'generated-structural-observation',
			},
		});
	});

	it('refuses a malformed v3 binding address before verifier dispatch', async () => {
		const address: LedgerAddress = {
			...dataDestructiveStep.address!,
			kind: 'column',
			name: 'id',
		};
		const postcondition = {
			postconditionVersion: 3 as const,
			targetBinding: {
				bindingVersion: 1 as const,
				bindingKind: 'managed-step-address' as const,
			},
			declaration: {
				canonicalFormVersion: 1 as const,
				kind: 'column' as const,
				column: { type: 'integer', nullable: false },
			},
		};

		await expect(
			withGeneratedPostconditionSession(
				{
					connect: async () => ({
						query: vi.fn(),
						release: () => undefined,
					}),
				},
				(session) =>
					readGeneratedPostconditionReadBack(
						session,
						v3Step(postcondition, address),
						address,
					),
			),
		).rejects.toBeInstanceOf(GeneratedPostconditionBindingResolutionError);
		expect(verifyGeneratedColumnPostcondition).not.toHaveBeenCalled();
	});

	it('refuses an unminted executor before an absent read-back', async () => {
		const query = vi.fn().mockResolvedValue({ rows: [] });
		const postcondition = {
			postconditionVersion: 3 as const,
			targetBinding: {
				bindingVersion: 1 as const,
				bindingKind: 'managed-step-address' as const,
			},
			declaration: {
				canonicalFormVersion: 1 as const,
				kind: 'absent' as const,
			},
		};

		await expect(
			readGeneratedPostconditionReadBack(
				{ query } as never,
				v3Step(postcondition, dataDestructiveStep.address!),
				dataDestructiveStep.address!,
			),
		).rejects.toThrow();
		expect(query).not.toHaveBeenCalled();
	});

	it('refuses an unminted executor before decoding a malformed declaration', async () => {
		const capabilityRefusal =
			'generated postcondition verifier requires an adapter-minted exclusive session capability';
		const decoderError =
			'generated table step hostile-malformed-declaration has no decodable generated declaration';
		const step = {
			...dataDestructiveStep,
			stepKey: 'hostile-malformed-declaration',
			expectedDeclaration: undefined,
		} as unknown as NormalizedManagedStep;

		let rejection: unknown;
		try {
			await readGeneratedPostconditionReadBack(
				{ query: vi.fn() } as never,
				step,
				dataDestructiveStep.address!,
			);
		} catch (error) {
			rejection = error;
		}

		expect(rejection).toBeInstanceOf(Error);
		if (!(rejection instanceof Error))
			throw new Error('expected reader rejection');
		expect(rejection.message).toBe(capabilityRefusal);
		expect(rejection.message).not.toBe(decoderError);
	});

	it('uses the captured binding address for an absent read-back', async () => {
		const postcondition = {
			postconditionVersion: 3 as const,
			targetBinding: {
				bindingVersion: 1 as const,
				bindingKind: 'managed-step-address' as const,
			},
			declaration: {
				canonicalFormVersion: 1 as const,
				kind: 'absent' as const,
			},
		};
		let bindingCaptured = false;
		const address = new Proxy(dataDestructiveStep.address!, {
			getOwnPropertyDescriptor(target, property) {
				const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
				if (property === 'name') bindingCaptured = true;
				return descriptor;
			},
			get(target, property, receiver) {
				if (!bindingCaptured) return Reflect.get(target, property, receiver);
				if (property === 'schema') return 'other';
				if (property === 'name') return 'missing';
				return Reflect.get(target, property, receiver);
			},
		}) as LedgerAddress;
		const query = vi.fn(async (_sql: string, params?: readonly unknown[]) => ({
			rows:
				params?.[0] === 'tenant' && params[1] === 'accounts'
					? [{ oid: '123' }]
					: [],
		}));

		await expect(
			withGeneratedPostconditionSession(
				{
					connect: async () => ({ query, release: () => undefined }),
				},
				(session) =>
					readGeneratedPostconditionReadBack(
						session,
						v3Step(postcondition, address),
						address,
					),
			),
		).rejects.toThrow(
			'generated table absence postcondition differs: accounts is still present',
		);
		expect(query).toHaveBeenCalledWith(expect.any(String), [
			'tenant',
			'accounts',
		]);
	});
});
