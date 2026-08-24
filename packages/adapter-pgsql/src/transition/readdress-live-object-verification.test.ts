import { canonicalJsonDigest } from '@dbsp/core';
import type { LedgerPayload } from '@dbsp/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	project: vi.fn(),
	readChain: vi.fn(),
	readIdentity: vi.fn(),
	execute: vi.fn(),
	verifyTable: vi.fn(),
	verifyIndex: vi.fn(),
	verifyCheck: vi.fn(),
	locks: vi.fn(),
	transaction: vi.fn(),
	lockTimeout: vi.fn(),
}));

vi.mock('@dbsp/core', async (importOriginal) => ({
	...(await importOriginal<typeof import('@dbsp/core')>()),
	projectLedgerChain: mocks.project,
}));
vi.mock('./chain-reader.js', () => ({
	readPgLedgerAddressChain: mocks.readChain,
}));
vi.mock('./catalogue-identity.js', () => ({
	readPgCatalogueIdentity: mocks.readIdentity,
}));
vi.mock('./ledger.js', () => ({
	acquirePgLedgerLocks: mocks.locks,
}));
vi.mock('./outcome-protocol.js', () => ({
	executePgAdmittedOperation: mocks.execute,
	recoverPgAdmittedReaddressPair: vi.fn(),
	setPgTransitionLockTimeout: mocks.lockTimeout,
	withPgTransitionTransaction: mocks.transaction,
}));
vi.mock('../ddl/generated-postcondition-verifier.js', () => ({
	decodeGeneratedPostconditionPayload: (payload: unknown) => {
		const value = (payload as { readonly value?: unknown }).value;
		if (
			!value ||
			typeof value !== 'object' ||
			(value as { postconditionVersion?: unknown }).postconditionVersion !== 3
		)
			throw new Error('generated postcondition format is unsupported; replan');
		return value;
	},
	withPinnedGeneratedPostconditionSession: async (
		session: unknown,
		work: (capability: unknown) => Promise<unknown>,
	) => work(session),
	verifyGeneratedTablePostcondition: mocks.verifyTable,
	verifyGeneratedIndexPostcondition: mocks.verifyIndex,
	verifyGeneratedCheckPostcondition: mocks.verifyCheck,
}));

import {
	executePgPersistedTableReaddress,
	rekeyDeclaration,
} from './readdress.js';

const source = {
	scope: 'schema' as const,
	engine: 'postgresql',
	database: 'app',
	schema: 'tenant',
	kind: 'table' as const,
	name: 'orders',
};
const target = { ...source, name: 'orders_archive' };
const identity = {
	engine: 'postgresql',
	format: 1,
	value: { oid: '42' },
};
const expected = {
	value: {
		postconditionVersion: 3 as const,
		targetBinding: {
			bindingVersion: 1 as const,
			bindingKind: 'managed-step-address' as const,
		},
		declaration: {
			canonicalFormVersion: 1 as const,
			kind: 'table' as const,
			columns: [],
		},
	},
	digest: 'reviewed',
};

function step(...declarations: readonly unknown[]) {
	const expectedDeclaration =
		declarations.length === 0 ? expected : declarations[0];
	return {
		stepKey: 'move-orders',
		address: source,
		claimKind: 'readdress-intent',
		classification: 'paired-readdress',
		requiresVacancy: false,
		plannedClaimKeys: ['move-orders/root'],
		statementBundle: {
			statements: ['ALTER TABLE "tenant"."orders" RENAME TO "orders_archive"'],
		},
		expectedDeclaration,
		lifecycle: {
			kind: 'readdress',
			declaration: {
				from: { schema: source.schema, name: source.name },
				to: { schema: target.schema, name: target.name },
			},
		},
	} as never;
}

function stepForTarget(name: string) {
	const base = step() as unknown as Record<string, unknown>;
	return {
		...base,
		lifecycle: {
			kind: 'readdress',
			declaration: {
				from: { schema: source.schema, name: source.name },
				to: { schema: target.schema, name },
			},
		},
	} as never;
}

function executor(
	closureRows: readonly { readonly kind: string; readonly name: string }[] = [
		{ kind: 'table', name: source.name },
	],
) {
	return {
		query: vi.fn(async (sql: string) => {
			if (sql.startsWith('LOCK TABLE')) return { rows: [] };
			if (sql.includes('dependent.contype')) return { rows: [] };
			if (sql.includes("SELECT 'table'::text AS kind"))
				return { rows: closureRows };
			throw new Error(`unexpected SQL: ${sql}`);
		}),
		connect: vi.fn(),
	};
}

function setupTargetOnlyNoOp(
	targetDeclaration: LedgerPayload = rekeyDeclaration(undefined, target),
) {
	mocks.locks.mockResolvedValue({ kind: 'acquired' });
	mocks.readIdentity.mockImplementation(async (_session: unknown, address) =>
		address.name === target.name
			? { ...target, catalogueIdentity: identity }
			: undefined,
	);
	mocks.readChain.mockImplementation(
		async (_session: unknown, _home, address) =>
			address.name === source.name
				? {
						marker: 'source',
						terminalMember: {
							eventKind: 'readdressed-to',
							pairId: 'pair',
						},
					}
				: {
						marker: 'target',
						terminalMember: {
							eventKind: 'readdressed-from',
							pairId: 'pair',
							catalogueIdentity: identity,
						},
					},
	);
	mocks.project.mockImplementation((chain) =>
		chain.marker === 'source'
			? { kind: 'projected-ledger-chain', stableState: 'unknown' }
			: {
					kind: 'projected-ledger-chain',
					stableState: 'managed',
					declaration: targetDeclaration,
				},
	);
}

function setupAdmission() {
	mocks.readIdentity.mockImplementation(async (_session: unknown, address) =>
		address.name === source.name
			? { ...source, catalogueIdentity: identity }
			: undefined,
	);
	mocks.readChain.mockImplementation(
		async (_session: unknown, _home, address) =>
			address.name === source.name
				? {
						marker: 'source',
						terminalMember: {
							eventId: 'managed',
							controller: 'owner',
							controllerOid: '10',
							catalogueIdentity: identity,
						},
					}
				: { marker: 'target' },
	);
	mocks.project.mockImplementation((chain) =>
		chain.marker === 'source'
			? {
					kind: 'projected-ledger-chain',
					stableState: 'managed',
					declaration: expected,
				}
			: {
					kind: 'projected-ledger-chain',
					stableState: 'absent',
				},
	);
	mocks.execute.mockImplementation(async (executor, input) => {
		const admission = await input.operation.request.verifyLiveAdmission(
			executor,
			{ name: 'owner', oid: '10' },
		);
		return Array.isArray(admission)
			? { kind: 'executed-paired-readdress' }
			: admission;
	});
}

describe('re-address live-object verification', () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.transaction.mockImplementation(async (session, work) =>
			work(session),
		);
	});

	it('refuses source structural drift in admission before the paired DDL path', async () => {
		setupAdmission();
		mocks.verifyTable.mockRejectedValue(
			new Error('column postcondition differs'),
		);
		await expect(
			executePgPersistedTableReaddress({
				executor: executor(),
				run: {} as never,
				manifest: {} as never,
				recomputedPlanDigest: 'plan',
				approval: { approvals: [] },
				executionId: 'attempt',
				step: step(),
				database: source.database,
				targetSchema: source.schema,
			}),
		).resolves.toMatchObject({
			outcome: 'readdress-refused',
			detail: expect.stringContaining('source orders structural proof failed'),
		});
		expect(mocks.verifyTable).toHaveBeenCalledTimes(1);
	});

	it('drives the real verifyLiveAdmission callback before closure, identity, and structural proof', async () => {
		setupAdmission();
		mocks.verifyTable.mockResolvedValue({
			kind: 'table',
			projection: { columns: [] },
		});
		mocks.execute.mockResolvedValue({ kind: 'executed-paired-readdress' });
		const client = executor();
		const result = await executePgPersistedTableReaddress({
			executor: client,
			run: {} as never,
			manifest: {} as never,
			recomputedPlanDigest: 'plan',
			approval: { approvals: [] },
			executionId: 'attempt',
			step: step(),
			database: source.database,
			targetSchema: source.schema,
		});
		expect(result).toEqual({
			outcome: 'completed',
			pairId: expect.any(String),
		});
		const admitted = mocks.execute.mock.calls[0]?.[1];
		expect(admitted.operation.request.members[0]?.targetDeclared).toMatchObject(
			{
				payloadKind: 'generated-declaration',
			},
		);
		await expect(
			admitted.operation.request.verifyLiveAdmission(client, {
				name: 'owner',
				oid: '10',
			}),
		).resolves.toEqual([{ source, target, catalogueIdentity: identity }]);
		const relationLock = client.query.mock.invocationCallOrder.find(
			(_order, index) =>
				client.query.mock.calls[index]?.[0] ===
				'LOCK TABLE ONLY "tenant"."orders" IN SHARE UPDATE EXCLUSIVE MODE',
		);
		expect(relationLock).toBeDefined();
		expect(relationLock!).toBeLessThan(
			mocks.readChain.mock.invocationCallOrder.at(-1)!,
		);
		expect(relationLock!).toBeLessThan(
			mocks.readIdentity.mock.invocationCallOrder.at(-1)!,
		);
		expect(relationLock!).toBeLessThan(
			mocks.verifyTable.mock.invocationCallOrder[0]!,
		);
	});

	it('refuses a replacement between source read and append, even after taking the source lock', async () => {
		setupAdmission();
		let sourceLocked = false;
		let sourceReads = 0;
		let replacementReadUnderLock = false;
		const client = executor();
		client.query.mockImplementation(async (sql: string) => {
			if (
				sql ===
				'LOCK TABLE ONLY "tenant"."orders" IN SHARE UPDATE EXCLUSIVE MODE'
			) {
				sourceLocked = true;
				return { rows: [] };
			}
			if (sql.startsWith('LOCK TABLE')) return { rows: [] };
			if (sql.includes('dependent.contype')) return { rows: [] };
			if (sql.includes("SELECT 'table'::text AS kind"))
				return { rows: [{ kind: 'table', name: source.name }] };
			throw new Error(`unexpected SQL: ${sql}`);
		});
		mocks.readIdentity.mockImplementation(async (_session: unknown, address) =>
			address.name === source.name
				? (() => {
						sourceReads += 1;
						if (sourceReads > 1) replacementReadUnderLock = sourceLocked;
						return {
							...source,
							catalogueIdentity:
								sourceReads === 1
									? identity
									: { ...identity, value: { oid: 'replaced' } },
						};
					})()
				: undefined,
		);
		await expect(
			executePgPersistedTableReaddress({
				executor: client,
				run: {} as never,
				manifest: {} as never,
				recomputedPlanDigest: 'plan',
				approval: { approvals: [] },
				executionId: 'attempt',
				step: step(),
				database: source.database,
				targetSchema: source.schema,
			}),
		).resolves.toMatchObject({
			outcome: 'readdress-refused',
			detail: expect.stringContaining('source identity mismatch'),
		});
		expect(replacementReadUnderLock).toBe(true);
	});

	it('refuses an absent or legacy reviewed shape with replan wording', async () => {
		for (const declaration of [
			undefined,
			{ value: { kind: 'table' }, digest: 'legacy' },
		]) {
			vi.clearAllMocks();
			mocks.verifyTable.mockReset();
			setupAdmission();
			await expect(
				executePgPersistedTableReaddress({
					executor: executor(),
					run: {} as never,
					manifest: {} as never,
					recomputedPlanDigest: 'plan',
					approval: { approvals: [] },
					executionId: 'attempt',
					step: step(declaration as never),
					database: source.database,
					targetSchema: source.schema,
				}),
			).resolves.toMatchObject({
				outcome: 'readdress-refused',
				detail: expect.stringContaining('replan'),
			});
		}
	});

	it('refuses a declared undecodable member before it can append a claim', async () => {
		setupAdmission();
		const priorReadChain = mocks.readChain.getMockImplementation()!;
		const priorProject = mocks.project.getMockImplementation()!;
		mocks.readChain.mockImplementation(async (session, home, address) =>
			address.kind === 'index'
				? { marker: 'declared-legacy-index', events: [{}] }
				: priorReadChain(session, home, address),
		);
		mocks.project.mockImplementation((chain) =>
			chain.marker === 'declared-legacy-index'
				? {
						kind: 'projected-ledger-chain',
						stableState: 'managed',
						declaration: { value: { kind: 'index' }, digest: 'legacy' },
					}
				: priorProject(chain),
		);
		await expect(
			executePgPersistedTableReaddress({
				executor: executor([
					{ kind: 'table', name: source.name },
					{ kind: 'index', name: 'orders_idx' },
				]),
				run: {} as never,
				manifest: {} as never,
				recomputedPlanDigest: 'plan',
				approval: { approvals: [] },
				executionId: 'attempt',
				step: step(),
				database: source.database,
				targetSchema: source.schema,
			}),
		).resolves.toMatchObject({
			outcome: 'readdress-refused',
			detail: expect.stringContaining('replan'),
		});
		expect(mocks.execute).not.toHaveBeenCalled();
	});

	it('keeps a never-declared member on identity read-back', async () => {
		setupAdmission();
		const priorReadChain = mocks.readChain.getMockImplementation()!;
		const priorProject = mocks.project.getMockImplementation()!;
		mocks.readChain.mockImplementation(async (session, home, address) =>
			address.kind === 'sequence'
				? { marker: 'never-declared-sequence', events: [] }
				: priorReadChain(session, home, address),
		);
		mocks.project.mockImplementation((chain) =>
			chain.marker === 'never-declared-sequence'
				? { kind: 'projected-ledger-chain', stableState: 'absent' }
				: priorProject(chain),
		);
		let member: Record<string, unknown> | undefined;
		mocks.execute.mockImplementation(async (_executor, input) => {
			member = input.operation.request.members.find(
				(candidate: { readonly source: { readonly kind: string } }) =>
					candidate.source.kind === 'sequence',
			);
			return { kind: 'executed-paired-readdress' };
		});
		await expect(
			executePgPersistedTableReaddress({
				executor: executor([
					{ kind: 'table', name: source.name },
					{ kind: 'sequence', name: 'orders_id_seq' },
				]),
				run: {} as never,
				manifest: {} as never,
				recomputedPlanDigest: 'plan',
				approval: { approvals: [] },
				executionId: 'attempt',
				step: step(),
				database: source.database,
				targetSchema: source.schema,
			}),
		).resolves.toMatchObject({ outcome: 'completed' });
		expect(member).toMatchObject({
			targetObserved: { value: { kind: 'sequence', name: 'orders_id_seq' } },
		});
		expect(member).not.toHaveProperty('postDdlReadBack');
		expect(member).toHaveProperty('postDdlVerify');
		const verify = member?.postDdlVerify as (executor: {
			query(sql: string, params?: readonly unknown[]): Promise<unknown>;
		}) => Promise<void>;
		await expect(
			verify({ query: vi.fn(async () => ({ rows: [] })) }),
		).rejects.toThrow('is not dependent on target table orders_archive');
	});

	it('refuses a pre-flip v2 index member before it can append a claim', async () => {
		setupAdmission();
		const priorReadChain = mocks.readChain.getMockImplementation()!;
		const priorProject = mocks.project.getMockImplementation()!;
		const indexDeclaration = {
			value: {
				postconditionVersion: 2,
				kind: 'index',
				index: {
					schema: source.schema,
					table: source.name,
					name: 'orders_idx',
					method: 'btree',
					unique: false,
					valid: true,
					ready: true,
					live: true,
					columns: ['id'],
					nullsNotDistinct: false,
				},
			},
			digest: 'index-v2',
		};
		mocks.readChain.mockImplementation(async (session, home, address) =>
			address.kind === 'index'
				? { marker: 'declared-index', events: [{}] }
				: priorReadChain(session, home, address),
		);
		mocks.project.mockImplementation((chain) =>
			chain.marker === 'declared-index'
				? {
						kind: 'projected-ledger-chain',
						stableState: 'managed',
						declaration: indexDeclaration,
					}
				: priorProject(chain),
		);
		let member: Record<string, unknown> | undefined;
		mocks.execute.mockImplementation(async (_executor, input) => {
			member = input.operation.request.members.find(
				(candidate: { readonly source: { readonly kind: string } }) =>
					candidate.source.kind === 'index',
			);
			return { kind: 'executed-paired-readdress' };
		});
		await expect(
			executePgPersistedTableReaddress({
				executor: executor([
					{ kind: 'table', name: source.name },
					{ kind: 'index', name: 'orders_idx' },
				]),
				run: {} as never,
				manifest: {} as never,
				recomputedPlanDigest: 'plan',
				approval: { approvals: [] },
				executionId: 'attempt',
				step: step(),
				database: source.database,
				targetSchema: source.schema,
			}),
		).resolves.toMatchObject({
			outcome: 'readdress-refused',
			detail: expect.stringContaining('replan'),
		});
		expect(member).toBeUndefined();
	});

	it('admits a generated source whose creation declaration differs from the reviewed step', async () => {
		setupAdmission();
		mocks.project.mockImplementation((chain) =>
			chain.marker === 'source'
				? {
						kind: 'projected-ledger-chain',
						stableState: 'managed',
						declaration: {
							value: {
								postconditionVersion: 3,
								targetBinding: {
									bindingVersion: 1,
									bindingKind: 'managed-step-address',
								},
								declaration: {
									canonicalFormVersion: 1,
									kind: 'table',
									columns: [{ name: 'created_at' }],
								},
							},
							digest: 'creation-declaration',
						},
					}
				: { kind: 'projected-ledger-chain', stableState: 'absent' },
		);
		mocks.verifyTable.mockResolvedValue({
			kind: 'table',
			projection: { columns: [] },
		});
		await expect(
			executePgPersistedTableReaddress({
				executor: executor(),
				run: {} as never,
				manifest: {} as never,
				recomputedPlanDigest: 'plan',
				approval: { approvals: [] },
				executionId: 'attempt',
				step: step(),
				database: source.database,
				targetSchema: source.schema,
			}),
		).resolves.toMatchObject({ outcome: 'completed' });
		expect(mocks.verifyTable).toHaveBeenCalledTimes(1);
	});

	it('carries verifier projection as the post-DDL observed payload', async () => {
		setupAdmission();
		mocks.verifyTable.mockResolvedValue({
			kind: 'table',
			projection: {
				columns: [{ name: 'id', type: 'integer', nullable: false }],
			},
		});
		let readBack: ((session: unknown) => Promise<unknown>) | undefined;
		mocks.execute.mockImplementation(async (_executor, input) => {
			readBack = input.operation.request.members[0].postDdlReadBack;
			return { kind: 'executed-paired-readdress' };
		});
		await executePgPersistedTableReaddress({
			executor: executor(),
			run: {} as never,
			manifest: {} as never,
			recomputedPlanDigest: 'plan',
			approval: { approvals: [] },
			executionId: 'attempt',
			step: step(),
			database: source.database,
			targetSchema: source.schema,
		});
		await expect(readBack?.({})).resolves.toMatchObject({
			value: { columns: [{ name: 'id', type: 'integer', nullable: false }] },
		});
	});

	it.each([
		['identity mismatch', { ...identity, value: { oid: '99' } }, identity],
		['missing recorded identity', identity, undefined],
	] as const)('refuses target-only no-op with %s', async (_label, liveIdentity, recordedIdentity) => {
		setupTargetOnlyNoOp();
		mocks.readIdentity.mockImplementation(async (_session: unknown, address) =>
			address.name === target.name
				? { ...target, catalogueIdentity: liveIdentity }
				: undefined,
		);
		mocks.readChain.mockImplementation(
			async (_session: unknown, _home, address) =>
				address.name === source.name
					? {
							marker: 'source',
							terminalMember: { eventKind: 'readdressed-to', pairId: 'pair' },
						}
					: {
							marker: 'target',
							terminalMember: {
								eventKind: 'readdressed-from',
								pairId: 'pair',
								catalogueIdentity: recordedIdentity,
							},
						},
		);
		await expect(
			executePgPersistedTableReaddress({
				executor: executor(),
				run: {} as never,
				manifest: {} as never,
				recomputedPlanDigest: 'plan',
				approval: { approvals: [] },
				executionId: 'attempt',
				step: step(),
				database: source.database,
				targetSchema: source.schema,
			}),
		).resolves.toMatchObject({
			outcome: 'readdress-refused',
			detail: expect.stringContaining('target identity mismatch'),
		});
	});

	it('reaches a target-only no-op for a versionless adopted target whose provenance differs from the reviewed declaration', async () => {
		setupTargetOnlyNoOp();
		mocks.readIdentity.mockImplementation(async (_session: unknown, address) =>
			address.name === target.name
				? { ...target, catalogueIdentity: identity }
				: undefined,
		);
		mocks.readChain.mockImplementation(
			async (_session: unknown, _home, address) =>
				address.name === source.name
					? {
							marker: 'source',
							terminalMember: { eventKind: 'readdressed-to', pairId: 'pair' },
						}
					: {
							marker: 'target',
							terminalMember: {
								eventKind: 'readdressed-from',
								pairId: 'pair',
								catalogueIdentity: identity,
							},
						},
		);
		mocks.project.mockImplementation((chain) =>
			chain.marker === 'source'
				? { kind: 'projected-ledger-chain', stableState: 'unknown' }
				: {
						kind: 'projected-ledger-chain',
						stableState: 'managed',
						declaration: rekeyDeclaration(undefined, target),
					},
		);
		mocks.verifyTable.mockResolvedValue({
			kind: 'table',
			projection: { columns: [] },
		});
		const client = executor();
		const checkedOutClient = { query: client.query };
		await expect(
			executePgPersistedTableReaddress({
				executor: checkedOutClient,
				run: {} as never,
				manifest: {} as never,
				recomputedPlanDigest: 'plan',
				approval: { approvals: [] },
				executionId: 'attempt',
				step: step(),
				database: source.database,
				targetSchema: source.schema,
			}),
		).resolves.toEqual({ outcome: 'no-op' });
		expect(mocks.transaction).toHaveBeenCalledWith(
			checkedOutClient,
			expect.any(Function),
		);
		expect(mocks.locks).toHaveBeenCalledWith(checkedOutClient, [
			{ scope: 'schema', schema: source.schema },
			{ scope: 'schema', schema: target.schema },
		]);
		expect(checkedOutClient.query).toHaveBeenCalledWith(
			'LOCK TABLE ONLY "tenant"."orders_archive" IN SHARE UPDATE EXCLUSIVE MODE',
		);
		expect(mocks.locks.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.readChain.mock.invocationCallOrder[0]!,
		);
		expect(mocks.readChain.mock.invocationCallOrder[1]).toBeLessThan(
			checkedOutClient.query.mock.invocationCallOrder[0]!,
		);
		expect(checkedOutClient.query.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.readIdentity.mock.invocationCallOrder[2]!,
		);
		expect(mocks.verifyTable).toHaveBeenCalledTimes(1);
	});

	it('accepts a synthesized declaration after its jsonb key reorder', async () => {
		const sourceDeclaration = {
			value: { alpha: false, zebra: true },
			digest: 'legacy',
		};
		const minted = rekeyDeclaration(sourceDeclaration, target);
		const jsonbLoadedTarget = {
			value: { alpha: false, name: target.name, zebra: true },
			digest: minted.digest,
		};
		expect(canonicalJsonDigest(jsonbLoadedTarget.value)).toBe(minted.digest);

		setupTargetOnlyNoOp(jsonbLoadedTarget);
		mocks.project.mockImplementation((chain) =>
			chain.marker === 'source'
				? {
						kind: 'projected-ledger-chain',
						stableState: 'unknown',
						declaration: sourceDeclaration,
					}
				: {
						kind: 'projected-ledger-chain',
						stableState: 'managed',
						declaration: jsonbLoadedTarget,
					},
		);
		mocks.verifyTable.mockResolvedValue({
			kind: 'table',
			projection: { columns: [] },
		});

		await expect(
			executePgPersistedTableReaddress({
				executor: executor(),
				run: {} as never,
				manifest: {} as never,
				recomputedPlanDigest: 'plan',
				approval: { approvals: [] },
				executionId: 'attempt',
				step: step(),
				database: source.database,
				targetSchema: source.schema,
			}),
		).resolves.toEqual({ outcome: 'no-op' });
	});

	it.each([
		['v1', { postconditionVersion: 1 }],
		['v2', { postconditionVersion: 2 }],
		['unknown version', { postconditionVersion: 77 }],
	] as const)('refuses a version-carrying %s target before structural proof', async (_label, value) => {
		setupTargetOnlyNoOp({ value, digest: 'legacy-versioned' });
		await expect(
			executePgPersistedTableReaddress({
				executor: executor(),
				run: {} as never,
				manifest: {} as never,
				recomputedPlanDigest: 'plan',
				approval: { approvals: [] },
				executionId: 'attempt',
				step: step(),
				database: source.database,
				targetSchema: source.schema,
			}),
		).resolves.toMatchObject({
			outcome: 'readdress-refused',
			detail: expect.stringContaining('declaration is not decodable'),
		});
		expect(mocks.verifyTable).not.toHaveBeenCalled();
	});

	it('refuses a target-only no-op whose declaration differs from the recorded source transfer', async () => {
		setupTargetOnlyNoOp({
			value: { kind: 'table', name: 'other_orders_archive' },
			digest: 'different-source-transfer',
		});
		await expect(
			executePgPersistedTableReaddress({
				executor: executor(),
				run: {} as never,
				manifest: {} as never,
				recomputedPlanDigest: 'plan',
				approval: { approvals: [] },
				executionId: 'attempt',
				step: step(),
				database: source.database,
				targetSchema: source.schema,
			}),
		).resolves.toMatchObject({
			outcome: 'readdress-refused',
			detail: expect.stringContaining('is not the recorded source transfer'),
		});
		expect(mocks.verifyTable).not.toHaveBeenCalled();
	});

	it.each([
		['Unicode', 'café', '"café"'],
		['spaces', 'order items', '"order items"'],
		['embedded double quotes', 'order"items', '"order""items"'],
		['hyphens', 'order-items', '"order-items"'],
	] as const)('locks a target-only no-op relation name with %s', async (_label, name, rendered) => {
		const namedTarget = { ...target, name };
		setupTargetOnlyNoOp(rekeyDeclaration(undefined, namedTarget));
		mocks.readIdentity.mockImplementation(async (_session: unknown, address) =>
			address.name === namedTarget.name
				? { ...namedTarget, catalogueIdentity: identity }
				: undefined,
		);
		mocks.readChain.mockImplementation(
			async (_session: unknown, _home, address) =>
				address.name === source.name
					? {
							marker: 'source',
							terminalMember: { eventKind: 'readdressed-to', pairId: 'pair' },
						}
					: {
							marker: 'target',
							terminalMember: {
								eventKind: 'readdressed-from',
								pairId: 'pair',
								catalogueIdentity: identity,
							},
						},
		);
		mocks.project.mockImplementation((chain) =>
			chain.marker === 'source'
				? { kind: 'projected-ledger-chain', stableState: 'unknown' }
				: {
						kind: 'projected-ledger-chain',
						stableState: 'managed',
						declaration: rekeyDeclaration(undefined, namedTarget),
					},
		);
		mocks.verifyTable.mockResolvedValue({
			kind: 'table',
			projection: { columns: [] },
		});
		const client = executor();
		await expect(
			executePgPersistedTableReaddress({
				executor: client,
				run: {} as never,
				manifest: {} as never,
				recomputedPlanDigest: 'plan',
				approval: { approvals: [] },
				executionId: 'attempt',
				step: stepForTarget(name),
				database: source.database,
				targetSchema: source.schema,
			}),
		).resolves.toEqual({ outcome: 'no-op' });
		expect(client.query).toHaveBeenCalledWith(
			`LOCK TABLE ONLY "tenant".${rendered} IN SHARE UPDATE EXCLUSIVE MODE`,
		);
	});

	it('refuses a NUL-bearing target-only no-op relation name before its lock query', async () => {
		const nulTarget = { ...target, name: 'order\0items' };
		setupTargetOnlyNoOp(rekeyDeclaration(undefined, nulTarget));
		mocks.readIdentity.mockImplementation(async (_session: unknown, address) =>
			address.name === nulTarget.name
				? { ...nulTarget, catalogueIdentity: identity }
				: undefined,
		);
		const client = executor();
		await expect(
			executePgPersistedTableReaddress({
				executor: client,
				run: {} as never,
				manifest: {} as never,
				recomputedPlanDigest: 'plan',
				approval: { approvals: [] },
				executionId: 'attempt',
				step: stepForTarget(nulTarget.name),
				database: source.database,
				targetSchema: source.schema,
			}),
		).resolves.toMatchObject({
			outcome: 'readdress-refused',
			detail: expect.stringContaining(
				'PostgreSQL lock identifier must not contain NUL',
			),
		});
		expect(client.query).not.toHaveBeenCalledWith(
			expect.stringContaining('LOCK TABLE'),
		);
	});

	it('surfaces a target no-op relation lock error with its PostgreSQL message', async () => {
		setupTargetOnlyNoOp();
		const client = executor();
		client.query.mockImplementation(async (sql: string) => {
			if (sql.startsWith('LOCK TABLE'))
				throw new Error('canceling statement due to lock timeout');
			if (sql.includes('dependent.contype')) return { rows: [] };
			if (sql.includes("SELECT 'table'::text AS kind"))
				return { rows: [{ kind: 'table', name: source.name }] };
			throw new Error(`unexpected SQL: ${sql}`);
		});
		await expect(
			executePgPersistedTableReaddress({
				executor: client,
				run: {} as never,
				manifest: {} as never,
				recomputedPlanDigest: 'plan',
				approval: { approvals: [] },
				executionId: 'attempt',
				step: step(),
				database: source.database,
				targetSchema: source.schema,
			}),
		).resolves.toMatchObject({
			outcome: 'readdress-refused',
			detail: expect.stringContaining(
				'canceling statement due to lock timeout',
			),
		});
		expect(mocks.lockTimeout).toHaveBeenCalledWith(client);
	});

	it('refuses a released append that lands between the early live reads and locked verdict', async () => {
		setupTargetOnlyNoOp();
		let released = false;
		mocks.transaction.mockImplementation(async (session, work) => {
			released = true;
			return work(session);
		});
		mocks.readChain.mockImplementation(
			async (_session: unknown, _home, address) =>
				address.name === source.name
					? {
							marker: 'source',
							terminalMember: released
								? { eventKind: 'released' }
								: { eventKind: 'readdressed-to', pairId: 'pair' },
						}
					: {
							marker: 'target',
							terminalMember: {
								eventKind: 'readdressed-from',
								pairId: 'pair',
								catalogueIdentity: identity,
							},
						},
		);
		await expect(
			executePgPersistedTableReaddress({
				executor: executor(),
				run: {} as never,
				manifest: {} as never,
				recomputedPlanDigest: 'plan',
				approval: { approvals: [] },
				executionId: 'attempt',
				step: step(),
				database: source.database,
				targetSchema: source.schema,
			}),
		).resolves.toMatchObject({
			outcome: 'readdress-refused',
			detail: expect.stringContaining('complete re-address chain'),
		});
		expect(mocks.locks.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.readChain.mock.invocationCallOrder[0]!,
		);
	});

	it('refuses a drop and recreate that lands between the early live reads and locked verdict', async () => {
		setupTargetOnlyNoOp();
		let recreated = false;
		mocks.transaction.mockImplementation(async (session, work) => {
			recreated = true;
			return work(session);
		});
		mocks.readIdentity.mockImplementation(async (_session: unknown, address) =>
			address.name === target.name
				? {
						...target,
						catalogueIdentity: recreated
							? { ...identity, value: { oid: '99' } }
							: identity,
					}
				: undefined,
		);
		await expect(
			executePgPersistedTableReaddress({
				executor: executor(),
				run: {} as never,
				manifest: {} as never,
				recomputedPlanDigest: 'plan',
				approval: { approvals: [] },
				executionId: 'attempt',
				step: step(),
				database: source.database,
				targetSchema: source.schema,
			}),
		).resolves.toMatchObject({
			outcome: 'readdress-refused',
			detail: expect.stringContaining('target identity mismatch'),
		});
	});

	it('refuses a terminal-looking source chain that does not project to a closed re-address', async () => {
		setupTargetOnlyNoOp();
		mocks.project.mockImplementation((chain) =>
			chain.marker === 'source'
				? { kind: 'projected-ledger-chain', stableState: 'managed' }
				: { kind: 'projected-ledger-chain', stableState: 'managed' },
		);
		await expect(
			executePgPersistedTableReaddress({
				executor: executor(),
				run: {} as never,
				manifest: {} as never,
				recomputedPlanDigest: 'plan',
				approval: { approvals: [] },
				executionId: 'attempt',
				step: step(),
				database: source.database,
				targetSchema: source.schema,
			}),
		).resolves.toMatchObject({
			outcome: 'readdress-refused',
			detail: expect.stringContaining('complete re-address chain'),
		});
		expect(mocks.verifyTable).not.toHaveBeenCalled();
	});

	it('refuses a changed current postcondition through the target-only no-op structural proof', async () => {
		setupTargetOnlyNoOp();
		mocks.verifyTable.mockRejectedValue(
			new Error('column postcondition differs'),
		);
		await expect(
			executePgPersistedTableReaddress({
				executor: executor(),
				run: {} as never,
				manifest: {} as never,
				recomputedPlanDigest: 'plan',
				approval: { approvals: [] },
				executionId: 'attempt',
				step: step(),
				database: source.database,
				targetSchema: source.schema,
			}),
		).resolves.toMatchObject({
			outcome: 'readdress-refused',
			detail: expect.stringContaining('structural proof failed'),
		});
	});
});
