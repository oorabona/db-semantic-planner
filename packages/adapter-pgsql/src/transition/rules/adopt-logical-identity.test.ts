import {
	type ApplyPolicy,
	createApplier,
	createComparator,
	createPackRegistry,
	createProver,
} from '@dbsp/core';
import type {
	EvidenceObservation,
	ModelIR,
	ObservationContext,
	ObservationIssuer,
	ObservationRequest,
	ResourceAddress,
	TableIR,
} from '@dbsp/types';
import { describe, expect, it, vi } from 'vitest';
import {
	LOGICAL_IDENTITY_ADOPTION_RULE_ID,
	LOGICAL_IDENTITY_CARRIER_OBSERVATION,
	PG_INTROSPECTION_ARTIFACT,
} from '../constants.js';
import { evidenceId } from '../ids.js';
import { createPgTransitionPack } from '../pack.js';

const asserter = { kind: 'human' as const, identity: 'schema-owner' };

const context: ObservationContext = {
	engine: 'postgresql',
	engineVersion: '180000',
	databaseId: 'testdb',
	capabilities: [],
	privileges: [],
	effectiveRole: 'test_owner',
	targetSchema: 'public',
	searchPath: ['public'],
	sessionConfiguration: {
		search_path: 'public',
		standard_conforming_strings: 'on',
		actual_search_path: '["public"]',
		'dbsp.transition.explicit_schema': 'public',
	},
	extensions: {},
};

type BindingRow = {
	readonly logical_id: string;
	readonly schema_name: string;
	readonly table_name: string;
	readonly column_name: string | null;
	readonly carrier_kind: string;
};

function usersTable(overrides: Partial<TableIR> = {}): TableIR {
	return {
		name: 'users',
		columns: [{ name: 'age', type: 'integer', nullable: true }],
		foreignKeys: [],
		indexes: [],
		...overrides,
	};
}

function model(table: TableIR): ModelIR {
	const tables = new Map<string, TableIR>([[table.name, table]]);
	return {
		tables,
		relations: new Map(),
		getTable: (name) => tables.get(name),
		getRelation: () => undefined,
		getRelationsFrom: () => [],
		getRelationsTo: () => [],
		isAmbiguous: () => ({ ambiguous: false, options: [] }),
	};
}

function desiredColumnIdentity(): ModelIR {
	return model(
		usersTable({
			columns: [
				{
					name: 'age',
					type: 'integer',
					nullable: true,
					logicalIdentity: {
						id: 'logical.column.users.age',
						carrier: {
							kind: 'postgresql-side-table',
							authenticated: false,
						},
					},
				},
			],
		}),
	);
}

function desiredTableAndColumnIdentity(): ModelIR {
	return model(
		usersTable({
			logicalIdentity: {
				id: 'logical.table.users',
				carrier: {
					kind: 'postgresql-side-table',
					authenticated: false,
				},
			},
			columns: [
				{
					name: 'age',
					type: 'integer',
					nullable: true,
					logicalIdentity: {
						id: 'logical.column.users.age',
						carrier: {
							kind: 'postgresql-side-table',
							authenticated: false,
						},
					},
				},
			],
		}),
	);
}

function currentPhysicalOnly(): ModelIR {
	return model(usersTable());
}

function targetScope(): ResourceAddress {
	return {
		engine: 'postgresql',
		database: 'testdb',
		schema: 'public',
		kind: 'column',
		name: 'age',
		qualifiedBy: ['users'],
	};
}

function bindingMatchesDetail(
	row: BindingRow,
	detail: Record<string, unknown>,
): boolean {
	return (
		row.schema_name === detail.schema &&
		row.table_name === detail.table &&
		row.column_name === detail.column
	);
}

function createFakeIssuer(rows: BindingRow[]): ObservationIssuer {
	return {
		artifact: PG_INTROSPECTION_ARTIFACT,
		readContext: async () => context,
		execute: async (
			request: ObservationRequest,
			_target: unknown,
			ctx: ObservationContext,
		): Promise<EvidenceObservation> => {
			if (request.kind !== LOGICAL_IDENTITY_CARRIER_OBSERVATION) {
				throw new Error(`unexpected observation ${request.kind}`);
			}
			const detail = request.detail as Record<string, unknown>;
			const objectBindings = rows.filter((row) =>
				bindingMatchesDetail(row, detail),
			);
			const logicalIdBindings = rows.filter(
				(row) => row.logical_id === detail.logicalId,
			);
			const expectedBinding = (row: BindingRow) =>
				bindingMatchesDetail(row, detail) &&
				row.logical_id === detail.logicalId &&
				row.carrier_kind === detail.carrierKind;
			const adoptable =
				objectBindings.length === 0 && logicalIdBindings.length === 0;
			const attached =
				objectBindings.length === 1 &&
				logicalIdBindings.length === 1 &&
				objectBindings.every(expectedBinding) &&
				logicalIdBindings.every(expectedBinding);
			const holds = detail.expected === 'attached' ? attached : adoptable;
			return {
				role: 'evidence',
				id: evidenceId(`test.logical-identity.${detail.expected}`),
				issuer: PG_INTROSPECTION_ARTIFACT,
				request: {
					...request,
					scope: [targetScope()],
					detail: {
						...detail,
						schema: 'public',
					},
				},
				result: {
					value: {
						objectExists: true,
						sideTableExists: rows.length > 0,
						logicalId: detail.logicalId,
						carrierKind: detail.carrierKind,
						authenticated: false,
						objectBindings: objectBindings.map(bindingValue),
						logicalIdBindings: logicalIdBindings.map(bindingValue),
						claims: [{ kind: LOGICAL_IDENTITY_CARRIER_OBSERVATION, holds }],
					},
				},
				context: ctx,
				stability: 'externally-mutable',
				takenAt: new Date().toISOString(),
				scope: [targetScope()],
				source: 'system-catalog',
				validity: { invalidatedBy: ['external-ddl'] },
			};
		},
	};
}

function bindingValue(row: BindingRow) {
	return {
		logicalId: row.logical_id,
		schema: row.schema_name,
		table: row.table_name,
		column: row.column_name,
		carrierKind: row.carrier_kind,
	};
}

function createFakePool(rows: BindingRow[]) {
	const sideTableWrites = { count: 0 };
	const runs = new Map<string, Record<string, unknown>>();
	const tableShape = (table: string): Record<string, unknown> => {
		if (table === 'dbsp_transition_run') {
			return {
				relkind: 'r',
				columns: {
					run_id: { type: 'text', notNull: true },
					plan_digest: { type: 'text', notNull: true },
					target_context_digest: { type: 'text', notNull: true },
					database_id: { type: 'text', notNull: true },
					core_version: { type: 'text', notNull: true },
					started_at: { type: 'timestamp with time zone', notNull: true },
				},
				primary_key: ['run_id'],
				foreign_keys: [],
				checks: [],
			};
		}
		return {
			relkind: 'r',
			columns: {
				run_id: { type: 'text', notNull: true },
				seq: { type: 'bigint', notNull: true },
				event: { type: 'text', notNull: true },
				step_id: { type: 'text', notNull: true },
				operation_ref: { type: 'text', notNull: true },
				operation_kind: { type: 'jsonb', notNull: true },
				recorded_at: { type: 'timestamp with time zone', notNull: true },
				record: { type: 'jsonb', notNull: true },
			},
			primary_key: ['run_id', 'seq'],
			foreign_keys: [
				{
					columns: ['run_id'],
					foreignSchema: 'dbsp_meta',
					foreignTable: 'dbsp_transition_run',
					foreignColumns: ['run_id'],
				},
			],
			checks: ['CHECK (event IN (intent, completion, observed))'],
		};
	};
	const client = {
		query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
			if (sql.startsWith('CREATE SCHEMA')) {
				return { rows: [] };
			}
			if (sql.includes('dbsp_transition_journal_shape')) {
				return { rows: [tableShape(String(params?.[1]))] };
			}
			if (sql.includes('INSERT INTO "dbsp_meta"."dbsp_transition_run"')) {
				const [
					run_id,
					plan_digest,
					target_context_digest,
					database_id,
					core_version,
					started_at,
				] = params ?? [];
				if (!runs.has(String(run_id))) {
					runs.set(String(run_id), {
						run_id,
						plan_digest,
						target_context_digest,
						database_id,
						core_version,
						started_at,
					});
				}
				return { rows: [] };
			}
			if (sql.includes('FROM "dbsp_meta"."dbsp_transition_run"')) {
				return { rows: [runs.get(String(params?.[0]))].filter(Boolean) };
			}
			if (sql.includes('INSERT INTO "dbsp_meta"."dbsp_transition_journal"')) {
				return { rows: [] };
			}
			if (sql === 'SHOW server_version_num') {
				return { rows: [{ server_version_num: '180000' }] };
			}
			if (sql.includes('current_database()')) {
				return { rows: [{ database_id: 'testdb' }] };
			}
			if (sql.includes('current_user AS current_user')) {
				return { rows: [{ current_user: 'test_owner' }] };
			}
			if (sql.includes('current_schemas(false)')) {
				return { rows: [{ search_path: ['public'] }] };
			}
			if (sql === 'SHOW search_path') {
				return { rows: [{ search_path: 'public' }] };
			}
			if (sql === 'SHOW standard_conforming_strings') {
				return { rows: [{ standard_conforming_strings: 'on' }] };
			}
			if (sql.includes('FROM pg_catalog.pg_extension')) {
				return { rows: [] };
			}
			if (sql.includes('FROM pg_catalog.pg_database')) {
				return { rows: [{}] };
			}
			if (sql.includes('pg_has_role(c.relowner')) {
				return {
					rows: [
						{
							has_table_alter_authority: true,
							has_schema_usage: true,
						},
					],
				};
			}
			if (sql.includes('INSERT INTO "dbsp_meta"."dbsp_logical_identity"')) {
				const [logicalId, schemaName, tableName, columnName, carrierKind] =
					params ?? [];
				rows.push({
					logical_id: String(logicalId),
					schema_name: String(schemaName),
					table_name: String(tableName),
					column_name: columnName == null ? null : String(columnName),
					carrier_kind: String(carrierKind),
				});
				sideTableWrites.count += 1;
				return { rows: [] };
			}
			return { rows: [] };
		}),
		release: vi.fn(),
	};
	return {
		pool: {
			connect: vi.fn(async () => client),
		},
		client,
		sideTableWrites,
	};
}

function registryWithRows(rows: BindingRow[]) {
	const pack = createPgTransitionPack({
		identityAdoptionAsserter: asserter,
		identityAdoptionSelectionBasis: 'unit test selected same physical column',
	});
	return createPackRegistry([{ ...pack, issuer: createFakeIssuer(rows) }]);
}

function acceptedPolicy(): ApplyPolicy {
	return {
		accepts: [
			{ class: 'operation-pack-semantics' },
			{
				class: 'baseline-identity-attachment',
				fromTrustRoot: asserter,
				withinScope: [{ kind: 'column', name: 'age' }],
			},
		],
	};
}

describe('logical identity adoption rule', () => {
	it('recognizes same physical column plus new logical id as only an adoption candidate', () => {
		const rows: BindingRow[] = [];
		const registry = registryWithRows(rows);
		const compare = createComparator(registry).compare(
			desiredColumnIdentity(),
			currentPhysicalOnly(),
		);

		expect(compare.kind).toBe('transitions');
		if (compare.kind !== 'transitions') {
			return;
		}
		expect(compare.candidates).toHaveLength(1);
		expect(compare.candidates[0]?.rule.id).toBe(
			LOGICAL_IDENTITY_ADOPTION_RULE_ID,
		);
	});

	it('does not adopt a malformed logical identity with no explicit carrier', () => {
		const registry = registryWithRows([]);
		const bareIdentity = {
			id: 'logical.column.users.age',
		} as unknown as NonNullable<TableIR['columns'][number]['logicalIdentity']>;
		const compare = createComparator(registry).compare(
			model(
				usersTable({
					columns: [
						{
							name: 'age',
							type: 'integer',
							nullable: true,
							logicalIdentity: bareIdentity,
						},
					],
				}),
			),
			currentPhysicalOnly(),
		);

		expect(compare.kind).not.toBe('transitions');
	});

	it('does not emit a column-only adoption when the table also has an unadopted identity', () => {
		const registry = registryWithRows([]);
		const compare = createComparator(registry).compare(
			desiredTableAndColumnIdentity(),
			currentPhysicalOnly(),
		);

		expect(compare.kind).not.toBe('transitions');
	});

	it('emits the baseline assumption, blocks without acceptance, and applies when accepted', async () => {
		const rows: BindingRow[] = [];
		const registry = registryWithRows(rows);
		const compare = createComparator(registry).compare(
			desiredColumnIdentity(),
			currentPhysicalOnly(),
		);
		const outcome = await createProver(registry).prove(
			compare,
			createFakePool(rows).pool,
			context,
		);

		expect(outcome.kind).toBe('proven');
		if (outcome.kind !== 'proven') {
			return;
		}
		const baseline = outcome.plan.assumptions.find(
			(assumption) => assumption.class === 'baseline-identity-attachment',
		);
		expect(baseline).toBeDefined();
		expect(baseline?.asserter).toEqual(asserter);
		expect(baseline?.scope).toEqual([targetScope()]);
		expect(baseline?.statement).toContain('logical.column.users.age');
		expect(baseline?.statement).toContain('postgresql-side-table');
		expect(baseline?.statement).toContain(
			'unit test selected same physical column',
		);
		expect(outcome.plan.steps[0]?.restsOnAssumptions).toContain(baseline?.id);
		const identityClaim = outcome.plan.claims.find(
			(claim) => claim.proposition.kind === 'dbsp.logical-identity.attached',
		);
		expect(identityClaim?.derivedBy.conclusion).toBe(
			'established-under-assumptions',
		);
		expect(identityClaim?.assumes).toEqual([baseline?.id]);

		const rejectedPool = createFakePool(rows);
		const rejected = await createApplier(registry).apply(
			{ plan: outcome.plan, assessment: outcome.assessment },
			{ accepts: [{ class: 'operation-pack-semantics' }] },
			rejectedPool.pool,
		);
		expect(rejected.assessment.decision).toBe('blocked');
		expect(rejected.assessment.reasons[0]).toMatchObject({
			code: 'uncomposable',
			assumption: baseline?.id,
		});
		expect(rejectedPool.sideTableWrites.count).toBe(0);

		const acceptedPool = createFakePool(rows);
		const applied = await createApplier(registry).apply(
			{ plan: outcome.plan, assessment: outcome.assessment },
			acceptedPolicy(),
			acceptedPool.pool,
		);

		expect(applied.assessment.decision).toBe('applicable');
		expect(applied.journals[0]?.outcome).toBe('completed');
		expect(acceptedPool.sideTableWrites.count).toBe(1);
		expect(rows).toContainEqual({
			logical_id: 'logical.column.users.age',
			schema_name: 'public',
			table_name: 'users',
			column_name: 'age',
			carrier_kind: 'postgresql-side-table',
		});
	});
});
