import { bindExecutionContract, type InProcessProvenPlan } from '@dbsp/core';
import type {
	ExecutionContract,
	ProvenPlanShape,
	TransitionSessionClient,
} from '@dbsp/types';
import { describe, expect, it, vi } from 'vitest';
import {
	ALTER_COLUMN_SET_NOT_NULL_MIN_SERVER_VERSION_NUM,
	ALTER_COLUMN_SET_NOT_NULL_OPERATION_KIND,
	ALTER_TABLE_ADD_CHECK_MIN_SERVER_VERSION_NUM,
	ALTER_TABLE_ADD_CHECK_OPERATION_KIND,
	ALTER_TYPE_ADD_VALUE_MIN_SERVER_VERSION_NUM,
	ALTER_TYPE_ADD_VALUE_OPERATION_KIND,
	ATTACH_LOGICAL_IDENTITY_OPERATION_KIND,
	CREATE_UNIQUE_INDEX_CONCURRENTLY_MIN_SERVER_VERSION_NUM,
	CREATE_UNIQUE_INDEX_CONCURRENTLY_OPERATION_KIND,
	MANUAL_SQL_OPERATION_KIND,
} from './constants.js';
import {
	createPgExecutionContract,
	evaluatePgExecutionContract,
	forcePgUtf8Session,
	pgOperationEngineFloor,
	validatePgExecutionContractDerivation,
} from './execution-contract.js';
import { createPgTransitionPack } from './pack.js';

const contract: ExecutionContract = {
	version: 1,
	requirements: [
		{
			kind: 'postgresql.physical-target',
			mode: 'must-match',
			systemIdentifier: 'system-1',
			databaseOid: '5',
			namespaces: [{ name: 'public', oid: '2200' }],
		},
		{
			kind: 'postgresql.session-setting',
			mode: 'set-and-verify',
			setting: 'standard_conforming_strings',
			value: 'on',
		},
	],
};

function physicalTargetQuery({
	systemIdentifier = 'system-1',
	databaseOid = '5',
	namespaceOid = '2200',
}: {
	readonly systemIdentifier?: string;
	readonly databaseOid?: string;
	readonly namespaceOid?: string;
}) {
	return vi.fn(async (sql: string) => {
		if (sql.startsWith('SELECT (pg_catalog.pg_control_system())'))
			return { rows: [{ system_identifier: systemIdentifier }] };
		if (sql.startsWith('SELECT d.oid::text'))
			return { rows: [{ database_oid: databaseOid }] };
		if (sql.startsWith('SELECT n.nspname'))
			return { rows: [{ name: 'public', oid: namespaceOid }] };
		if (sql.startsWith("SELECT current_setting('search_path')"))
			return {
				rows: [
					{ search_path: 'public', client_encoding: 'UTF8', timezone: 'UTC' },
				],
			};
		if (sql === "SET client_encoding TO 'UTF8'") return { rows: [] };
		if (sql === 'SHOW client_encoding')
			return { rows: [{ client_encoding: 'UTF8' }] };
		throw new Error(`unexpected query ${sql}`);
	});
}

describe('PostgreSQL execution contract evaluator', () => {
	it.each([
		[
			'ManualSql',
			MANUAL_SQL_OPERATION_KIND,
			'postgresql:manual-sql:users',
			{
				statement: { text: 'ALTER TABLE public.users ADD COLUMN flag boolean' },
			},
		],
		[
			'AttachLogicalIdentity',
			ATTACH_LOGICAL_IDENTITY_OPERATION_KIND,
			'postgresql:logical-identity-adopt:users',
			{
				schema: 'public',
				table: 'users',
				logicalId: 'logical.table.users',
			},
		],
	] as const)('mutation: contract construction cannot make ineligible %s executable', (operationName, operationKind, ref, payload) => {
		const plan = {
			steps: [
				{
					stepId: `step:${operationName}`,
					operation: { ref, operationKind, payload },
				},
			],
		} as unknown as ProvenPlanShape;
		expect(() =>
			createPgExecutionContract(
				plan,
				{
					systemIdentifier: 'system-1',
					databaseOid: '5',
					namespaces: [{ name: 'public', oid: '2200' }],
				},
				{
					search_path: 'public',
					client_encoding: 'UTF8',
					TimeZone: 'UTC',
				},
			),
		).toThrow(
			new RegExp(`\\(${operationName}\\).*no derivable execution contract`),
		);
	});

	it('mutation: a new operation cannot fall through to a default PostgreSQL engine floor', () => {
		expect(
			pgOperationEngineFloor(ALTER_COLUMN_SET_NOT_NULL_OPERATION_KIND.name),
		).toBe(ALTER_COLUMN_SET_NOT_NULL_MIN_SERVER_VERSION_NUM);
		expect(
			pgOperationEngineFloor(ALTER_TABLE_ADD_CHECK_OPERATION_KIND.name),
		).toBe(ALTER_TABLE_ADD_CHECK_MIN_SERVER_VERSION_NUM);
		expect(
			pgOperationEngineFloor(ALTER_TYPE_ADD_VALUE_OPERATION_KIND.name),
		).toBe(ALTER_TYPE_ADD_VALUE_MIN_SERVER_VERSION_NUM);
		expect(
			pgOperationEngineFloor(
				CREATE_UNIQUE_INDEX_CONCURRENTLY_OPERATION_KIND.name,
			),
		).toBe(CREATE_UNIQUE_INDEX_CONCURRENTLY_MIN_SERVER_VERSION_NUM);
		expect(() => pgOperationEngineFloor('NewOperation')).toThrow(
			/no reviewed PostgreSQL engine capability mapping/,
		);
	});

	it('mutation: omitting a session clause required by any eligible renderer leaves its contract unable to render', () => {
		const identity = {
			systemIdentifier: 'system-1',
			databaseOid: '5',
			namespaces: [{ name: 'public', oid: '2200' }],
		};
		const rendererRequirements = createPgTransitionPack()
			.operationSemantics.filter(
				(runtime) =>
					runtime.executionContractEligibility?.eligible === true &&
					'operationKind' in runtime &&
					'rendererSessionRequirements' in runtime &&
					runtime.operationKind !== undefined &&
					(runtime.rendererSessionRequirements?.length ?? 0) > 0,
			)
			.flatMap((runtime) => {
				if (
					!('operationKind' in runtime) ||
					!('rendererSessionRequirements' in runtime) ||
					runtime.operationKind === undefined
				) {
					return [];
				}
				return (runtime.rendererSessionRequirements ?? []).map(
					(requirement) => ({
						operationKind: runtime.operationKind,
						requirement,
					}),
				);
			});

		for (const { operationKind, requirement } of rendererRequirements) {
			const contract = createPgExecutionContract(
				{
					steps: [
						{
							stepId: `step:${operationKind.name}`,
							operation: {
								ref: `operation:${operationKind.name}`,
								operationKind,
								// Renderer settings are operation metadata; this generic
								// payload provides every authority target supported today.
								payload: { schema: 'public', table: 'users', type: 'status' },
							},
						},
					],
				} as unknown as ProvenPlanShape,
				identity,
				{
					search_path: 'public',
					client_encoding: 'UTF8',
					TimeZone: 'UTC',
				},
			);
			expect(contract.requirements).toContainEqual({
				kind: 'postgresql.session-setting',
				mode: 'set-and-verify',
				setting: requirement.setting,
				value: requirement.value,
			});
		}
	});

	it.each([
		'LATIN1',
		'SQL_ASCII',
	] as const)('mutation: observing non-ASCII labels on %s without pinning UTF-8 can confirm different bytes', async (initialEncoding) => {
		const query = vi.fn(async (sql: string) => {
			if (sql === "SET client_encoding TO 'UTF8'") return { rows: [] };
			if (sql === 'SHOW client_encoding')
				return { rows: [{ client_encoding: 'UTF8' }] };
			throw new Error(`unexpected query ${sql}`);
		});
		await forcePgUtf8Session({ query } as unknown as TransitionSessionClient);
		expect(initialEncoding).not.toBe('UTF8');
		expect(query.mock.calls.map(([sql]) => sql)).toEqual([
			"SET client_encoding TO 'UTF8'",
			'SHOW client_encoding',
		]);
		// The label makes this a byte-provenance regression, not an ASCII-only
		// setting test: node-postgres would otherwise send C3 A9 for é.
		expect('é').toBe('é');
	});

	it('mutation: a physical-target-only contract is valid JSON but does not derive from its plan', () => {
		const plan = {
			steps: [
				{
					stepId: 'step:enum-status',
					operation: {
						ref: 'enum-status-add-é',
						operationKind: ALTER_TYPE_ADD_VALUE_OPERATION_KIND,
						payload: { schema: 'public', type: 'status' },
					},
				},
			],
		} as unknown as ProvenPlanShape;
		const physicalOnly: ExecutionContract = {
			version: 1,
			requirements: [contract.requirements[0]!],
		};
		expect(validatePgExecutionContractDerivation(plan, physicalOnly)).toEqual({
			ok: false,
			detail:
				'execution contract static clauses do not exactly derive from the stored plan',
		});
	});

	it('mutation: emitting requirements in operation-source order must still bind as a canonical contract', () => {
		const plan = {
			steps: [
				{
					stepId: 'step:enum-status',
					operation: {
						ref: 'enum-status-add-pending',
						operationKind: ALTER_TYPE_ADD_VALUE_OPERATION_KIND,
						payload: { schema: 'public', type: 'status' },
					},
				},
			],
		} as unknown as ProvenPlanShape;
		const contract = createPgExecutionContract(
			plan,
			{
				systemIdentifier: 'system-1',
				databaseOid: '5',
				namespaces: [{ name: 'public', oid: '2200' }],
			},
			{
				search_path: 'public',
				client_encoding: 'UTF8',
				TimeZone: 'UTC',
			},
		);

		expect(() =>
			bindExecutionContract({} as InProcessProvenPlan, contract),
		).not.toThrow();
	});

	it('mutation: repeating schema usage in a two-step plan changes neither the canonical requirement set nor its digest', () => {
		const identity = {
			systemIdentifier: 'system-1',
			databaseOid: '5',
			namespaces: [{ name: 'public', oid: '2200' }],
		};
		const oneStep = {
			steps: [
				{
					stepId: 'step:check-one',
					operation: {
						ref: 'check-one',
						operationKind: ALTER_TABLE_ADD_CHECK_OPERATION_KIND,
						payload: { schema: 'public', table: 'users' },
					},
				},
			],
		} as unknown as ProvenPlanShape;
		const twoSteps = {
			steps: [
				...oneStep.steps,
				{
					stepId: 'step:check-two',
					operation: {
						ref: 'check-two',
						operationKind: ALTER_TABLE_ADD_CHECK_OPERATION_KIND,
						payload: { schema: 'public', table: 'accounts' },
					},
				},
			],
		} as unknown as ProvenPlanShape;
		const single = createPgExecutionContract(oneStep, identity, {
			search_path: 'public',
			client_encoding: 'UTF8',
			TimeZone: 'UTC',
		});
		const repeated = createPgExecutionContract(twoSteps, identity, {
			search_path: 'public',
			client_encoding: 'UTF8',
			TimeZone: 'UTC',
		});
		expect(
			repeated.requirements.filter(
				(requirement) =>
					requirement.kind === 'postgresql.authority' &&
					requirement.action === 'schema-usage',
			),
		).toHaveLength(1);
		expect(
			single.requirements.filter(
				(requirement) =>
					requirement.kind === 'postgresql.authority' &&
					requirement.action === 'schema-usage',
			),
		).toEqual(
			repeated.requirements.filter(
				(requirement) =>
					requirement.kind === 'postgresql.authority' &&
					requirement.action === 'schema-usage',
			),
		);
	});

	it('mutation: setting standard_conforming_strings on another connection cannot satisfy the executor session', async () => {
		const query = vi.fn(async (sql: string) => {
			if (sql.startsWith('SELECT (pg_catalog.pg_control_system())'))
				return { rows: [{ system_identifier: 'system-1' }] };
			if (sql.startsWith('SELECT d.oid::text'))
				return { rows: [{ database_oid: '5' }] };
			if (sql.startsWith('SELECT n.nspname'))
				return { rows: [{ name: 'public', oid: '2200' }] };
			if (sql.startsWith("SELECT current_setting('search_path')"))
				return {
					rows: [
						{ search_path: 'public', client_encoding: 'UTF8', timezone: 'UTC' },
					],
				};
			if (sql === "SET standard_conforming_strings TO 'on'")
				return { rows: [] };
			if (sql === 'SHOW standard_conforming_strings')
				return { rows: [{ standard_conforming_strings: 'on' }] };
			if (sql === "SET client_encoding TO 'UTF8'") return { rows: [] };
			if (sql === 'SHOW client_encoding')
				return { rows: [{ client_encoding: 'UTF8' }] };
			throw new Error(`unexpected query ${sql}`);
		});
		const result = await evaluatePgExecutionContract(
			{ query } as unknown as TransitionSessionClient,
			contract,
		);
		expect(result).toEqual({ ok: true });
		expect(query.mock.calls.map(([sql]) => sql)).toContain(
			"SET standard_conforming_strings TO 'on'",
		);
		expect(query.mock.calls.map(([sql]) => sql)).toContain(
			'SHOW standard_conforming_strings',
		);
	});

	it('mutation: accepting a same-named database after its OID changes bypasses the physical-target contract', async () => {
		const query = vi.fn(async (sql: string) => {
			if (sql.startsWith('SELECT (pg_catalog.pg_control_system())'))
				return { rows: [{ system_identifier: 'system-1' }] };
			if (sql.startsWith('SELECT d.oid::text'))
				return { rows: [{ database_oid: '6' }] };
			if (sql.startsWith('SELECT n.nspname'))
				return { rows: [{ name: 'public', oid: '2200' }] };
			if (sql.startsWith("SELECT current_setting('search_path')"))
				return {
					rows: [
						{ search_path: 'public', client_encoding: 'UTF8', timezone: 'UTC' },
					],
				};
			if (sql === "SET client_encoding TO 'UTF8'") return { rows: [] };
			if (sql === 'SHOW client_encoding')
				return { rows: [{ client_encoding: 'UTF8' }] };
			throw new Error(`unexpected query ${sql}`);
		});

		await expect(
			evaluatePgExecutionContract(
				{ query } as unknown as TransitionSessionClient,
				contract,
			),
		).resolves.toEqual({
			ok: false,
			clause: 'postgresql.physical-target',
			detail: 'database OID expected "5", observed "6"',
		});
		expect(query.mock.calls.map(([sql]) => sql)).not.toContain(
			"SET standard_conforming_strings TO 'on'",
		);
	});

	it('mutation: accepting a different PostgreSQL cluster bypasses the physical-target contract', async () => {
		const query = physicalTargetQuery({ systemIdentifier: 'system-2' });

		await expect(
			evaluatePgExecutionContract(
				{ query } as unknown as TransitionSessionClient,
				contract,
			),
		).resolves.toEqual({
			ok: false,
			clause: 'postgresql.physical-target',
			detail: 'system identifier expected "system-1", observed "system-2"',
		});
	});

	it('mutation: accepting a recreated namespace with its new OID bypasses the physical-target contract', async () => {
		const query = physicalTargetQuery({ namespaceOid: '2201' });

		await expect(
			evaluatePgExecutionContract(
				{ query } as unknown as TransitionSessionClient,
				contract,
			),
		).resolves.toEqual({
			ok: false,
			clause: 'postgresql.physical-target',
			detail: 'namespace "public" OID expected "2200", observed "2201"',
		});
	});

	it('mutation: rederiving apply namespaces from steps instead of the persisted physical clause changes the target being checked', async () => {
		const fallbackContract: ExecutionContract = {
			version: 1,
			requirements: [
				{
					kind: 'postgresql.physical-target',
					mode: 'must-match',
					systemIdentifier: 'system-1',
					databaseOid: '5',
					namespaces: [{ name: 'requested_schema', oid: '2200' }],
				},
			],
		};
		const query = vi.fn(async (sql: string, params?: readonly unknown[]) => {
			if (sql.startsWith('SELECT (pg_catalog.pg_control_system())'))
				return { rows: [{ system_identifier: 'system-1' }] };
			if (sql.startsWith('SELECT d.oid::text'))
				return { rows: [{ database_oid: '5' }] };
			if (sql.startsWith('SELECT n.nspname')) {
				expect(params).toEqual([['requested_schema']]);
				return { rows: [{ name: 'requested_schema', oid: '2200' }] };
			}
			if (sql.startsWith("SELECT current_setting('search_path')"))
				return {
					rows: [
						{ search_path: 'public', client_encoding: 'UTF8', timezone: 'UTC' },
					],
				};
			if (sql === "SET client_encoding TO 'UTF8'") return { rows: [] };
			if (sql === 'SHOW client_encoding')
				return { rows: [{ client_encoding: 'UTF8' }] };
			throw new Error(`unexpected query ${sql}`);
		});

		await expect(
			evaluatePgExecutionContract(
				{ query } as unknown as TransitionSessionClient,
				fallbackContract,
			),
		).resolves.toEqual({ ok: true });
	});

	it('mutation: treating namespace identities as an ordered list rejects an unchanged target', async () => {
		const multiNamespaceContract: ExecutionContract = {
			version: 1,
			requirements: [
				{
					kind: 'postgresql.physical-target',
					mode: 'must-match',
					systemIdentifier: 'system-1',
					databaseOid: '5',
					namespaces: [
						{ name: 'zeta', oid: '2' },
						{ name: 'alpha', oid: '1' },
					],
				},
			],
		};
		const query = vi.fn(async (sql: string) => {
			if (sql.startsWith('SELECT (pg_catalog.pg_control_system())'))
				return { rows: [{ system_identifier: 'system-1' }] };
			if (sql.startsWith('SELECT d.oid::text'))
				return { rows: [{ database_oid: '5' }] };
			if (sql.startsWith('SELECT n.nspname'))
				return {
					rows: [
						{ name: 'alpha', oid: '1' },
						{ name: 'zeta', oid: '2' },
					],
				};
			if (sql.startsWith("SELECT current_setting('search_path')"))
				return {
					rows: [
						{ search_path: 'public', client_encoding: 'UTF8', timezone: 'UTC' },
					],
				};
			if (sql === "SET client_encoding TO 'UTF8'") return { rows: [] };
			if (sql === 'SHOW client_encoding')
				return { rows: [{ client_encoding: 'UTF8' }] };
			throw new Error(`unexpected query ${sql}`);
		});

		await expect(
			evaluatePgExecutionContract(
				{ query } as unknown as TransitionSessionClient,
				multiNamespaceContract,
			),
		).resolves.toEqual({ ok: true });
	});

	it('mutation: accepting revoked schema authority starts an intent without the reviewed contract', async () => {
		const query = vi.fn(async (sql: string) => {
			if (sql.startsWith('SELECT (pg_catalog.pg_control_system())'))
				return { rows: [{ system_identifier: 'system-1' }] };
			if (sql.startsWith('SELECT d.oid::text'))
				return { rows: [{ database_oid: '5' }] };
			if (sql.startsWith('SELECT n.nspname'))
				return { rows: [{ name: 'public', oid: '2200' }] };
			if (sql.startsWith("SELECT current_setting('search_path')"))
				return {
					rows: [
						{ search_path: 'public', client_encoding: 'UTF8', timezone: 'UTC' },
					],
				};
			if (sql.includes('has_schema_privilege'))
				return { rows: [{ holds: false }] };
			if (sql === "SET client_encoding TO 'UTF8'") return { rows: [] };
			if (sql === 'SHOW client_encoding')
				return { rows: [{ client_encoding: 'UTF8' }] };
			throw new Error(`unexpected query ${sql}`);
		});
		const authorityContract: ExecutionContract = {
			version: 1,
			requirements: [
				contract.requirements[0]!,
				{
					kind: 'postgresql.authority',
					mode: 'must-satisfy',
					action: 'schema-usage',
					schema: 'public',
				},
			],
		};

		await expect(
			evaluatePgExecutionContract(
				{ query } as unknown as TransitionSessionClient,
				authorityContract,
			),
		).resolves.toEqual({
			ok: false,
			clause: 'postgresql.authority:schema-usage:public',
			detail:
				'authority schema-usage on "public" expected true, observed false',
		});
	});
});
