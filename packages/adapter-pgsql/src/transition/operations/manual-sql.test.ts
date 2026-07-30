import {
	createPackRegistry,
	createProver,
	createTransitionLessor,
} from '@dbsp/core';
import type {
	ApplicableEvaluation,
	Assumption,
	CompareOutcome,
	ObservationContext,
	ObservationRequest,
	PhysicalOperation,
	RecognitionResult,
	ResourceAddress,
	TransitionRule,
} from '@dbsp/types';
import { describe, expect, it, vi } from 'vitest';
import {
	ENGINE_VERSION_OBSERVATION,
	MANUAL_SQL_OPERATION_KIND,
	PG_RULE_PACK_ARTIFACT,
} from '../constants.js';
import { assumptionId } from '../ids.js';
import { createPgObservationIssuer } from '../observation-issuer.js';
import {
	createManualSqlOperationRuntime,
	type ManualSqlPayload,
	normalizeManualSqlPayload,
} from './manual-sql.js';

const context: ObservationContext = {
	engine: 'postgresql',
	engineVersion: '180000',
	databaseId: 'manual-db',
	capabilities: [],
	privileges: [],
	effectiveRole: 'schema_owner',
	targetSchema: 'tenant',
	searchPath: ['tenant'],
	sessionConfiguration: { standard_conforming_strings: 'on' },
	extensions: {},
};

const tableResource: ResourceAddress = {
	engine: 'postgresql',
	database: 'manual-db',
	schema: 'tenant',
	kind: 'table',
	name: 'users',
};

const schemaResource: ResourceAddress = {
	engine: 'postgresql',
	database: 'manual-db',
	schema: 'tenant',
	kind: 'schema',
	name: 'tenant',
};

const databaseResource: ResourceAddress = {
	engine: 'postgresql',
	database: 'manual-db',
	kind: 'database',
	name: 'manual-db',
};

const human = { kind: 'human' as const, identity: 'schema-owner' };

function userBlastAssumption(
	scope: readonly ResourceAddress[] = [],
): Assumption {
	return {
		id: assumptionId('manual.user-blast.users'),
		class: 'user-blast-radius',
		asserter: human,
		statement: 'schema-owner declares this manual statement only touches users',
		scope,
	};
}

function manualObservationRequests(): readonly ObservationRequest[] {
	return [
		{
			kind: ENGINE_VERSION_OBSERVATION,
			scope: [databaseResource],
			detail: { minServerVersionNum: 120000 },
		},
	];
}

function operation(
	payloadScope: readonly ResourceAddress[] = [],
): PhysicalOperation {
	const payload = normalizeManualSqlPayload(
		{
			statement: {
				kind: 'unsafe-native',
				category: 'statement',
				text: 'ALTER TABLE "tenant"."users" ADD COLUMN "manual_flag" boolean',
				assumption: userBlastAssumption().id,
				attestation: userBlastAssumption(payloadScope),
			},
			blastRadius: [tableResource],
			preconditions: [
				{
					proposition: {
						kind: 'manual.users.manual_flag.absent',
						scope: [tableResource],
					},
					scope: [tableResource],
				},
			],
			postconditions: [
				{
					proposition: {
						kind: 'manual.users.manual_flag.present',
						scope: [tableResource],
					},
					scope: [tableResource],
				},
			],
		},
		context,
	);
	return {
		ref: 'postgresql:manual-sql:users-manual-flag',
		operationKind: MANUAL_SQL_OPERATION_KIND,
		payload: payload as never,
	};
}

function expectStatementRejected(text: string, pattern: RegExp): void {
	expect(() =>
		normalizeManualSqlPayload(
			{
				statement: {
					kind: 'unsafe-native',
					category: 'statement',
					text,
					assumption: userBlastAssumption().id,
					attestation: userBlastAssumption([tableResource]),
				},
				blastRadius: [tableResource],
				preconditions: [],
				postconditions: [],
			},
			context,
		),
	).toThrow(pattern);
}

function validManualPayload(): ManualSqlPayload {
	return {
		statement: {
			kind: 'unsafe-native',
			category: 'statement',
			text: 'ALTER TABLE "tenant"."users" ADD COLUMN "manual_flag" boolean',
			assumption: userBlastAssumption().id,
			attestation: userBlastAssumption([tableResource]),
		},
		blastRadius: [tableResource],
		preconditions: [
			{
				proposition: {
					kind: 'manual.users.manual_flag.absent',
					scope: [tableResource],
				},
				scope: [tableResource],
			},
		],
		postconditions: [
			{
				proposition: {
					kind: 'manual.users.manual_flag.present',
					scope: [tableResource],
				},
				scope: [tableResource],
			},
		],
	};
}

function expectPayloadRejected(payload: unknown, pattern: RegExp): void {
	expect(() =>
		normalizeManualSqlPayload(payload as ManualSqlPayload, context),
	).toThrow(pattern);
}

function manualRule(manualOperation: PhysicalOperation): TransitionRule {
	const ruleRef = {
		id: 'postgresql.manual-sql.test',
		pack: PG_RULE_PACK_ARTIFACT,
	};
	return {
		id: ruleRef.id,
		artifact: ruleRef.pack,
		support: {
			engine: 'postgresql',
			versions: [],
			requiredCapabilities: [],
		},
		recognize(): RecognitionResult<unknown> {
			return { recognized: true, match: {} };
		},
		requiredObservations: manualObservationRequests,
		evaluate: () => ({
			outcome: 'applicable',
			obligations: [],
			assumptions: [],
		}),
		generateCandidate(_match: unknown, _evaluation: ApplicableEvaluation) {
			return {
				generatedBy: ruleRef,
				operations: [manualOperation],
				obligations: [],
				assumptions: [],
				guards: [],
				selectionRationale: {
					chosen: ruleRef,
					overRules: [],
					why: 'test manual SQL escape hatch',
				},
			};
		},
	};
}

class ManualSqlPool {
	readonly queries: string[] = [];
	readonly runs = new Map<string, Record<string, unknown>>();
	readonly plans = new Map<string, Record<string, unknown>>();

	tableShape(table: string): Record<string, unknown> {
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
		if (table === 'dbsp_transition_run_plan') {
			return {
				relkind: 'r',
				columns: {
					run_id: { type: 'text', notNull: true },
					plan: { type: 'jsonb', notNull: true },
				},
				primary_key: ['run_id'],
				foreign_keys: [
					{
						columns: ['run_id'],
						foreignSchema: 'dbsp_meta',
						foreignTable: 'dbsp_transition_run',
						foreignColumns: ['run_id'],
					},
				],
				checks: [],
			};
		}
		if (table === 'dbsp_transition_authorization') {
			return {
				relkind: 'r',
				columns: {
					run_id: { type: 'text', notNull: true },
					seq: { type: 'bigint', notNull: true },
					policy: { type: 'jsonb', notNull: true },
					grants: { type: 'jsonb', notNull: true },
					digest: { type: 'text', notNull: true },
					actor: { type: 'text', notNull: true },
					authorized_at: {
						type: 'timestamp with time zone',
						notNull: true,
					},
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
	}

	async connect() {
		return {
			query: async (sql: string, params?: readonly unknown[]) =>
				this.query(sql, params),
			release: vi.fn(),
		};
	}

	async query(
		sql: string,
		_params?: readonly unknown[],
	): Promise<{ rows: readonly Record<string, unknown>[] }> {
		this.queries.push(sql);
		if (sql === "SET client_encoding TO 'UTF8'") return { rows: [] };
		if (sql === 'SHOW client_encoding')
			return { rows: [{ client_encoding: 'UTF8' }] };
		if (sql.startsWith('SELECT (pg_catalog.pg_control_system())')) {
			return { rows: [{ system_identifier: 'manual-system' }] };
		}
		if (sql.startsWith('SELECT d.oid::text')) {
			return { rows: [{ database_oid: '5' }] };
		}
		if (sql.startsWith('SELECT n.nspname')) {
			return { rows: [{ name: 'tenant', oid: '2200' }] };
		}
		if (sql.startsWith("SELECT current_setting('search_path')")) {
			return {
				rows: [
					{ search_path: 'tenant', client_encoding: 'UTF8', timezone: 'UTC' },
				],
			};
		}
		if (sql.startsWith('CREATE ')) {
			return { rows: [] };
		}
		if (sql.includes('dbsp_transition_journal_shape')) {
			return { rows: [this.tableShape(String(_params?.[1]))] };
		}
		if (sql.includes('WITH ins_run AS')) {
			const [
				run_id,
				plan_digest,
				target_context_digest,
				database_id,
				core_version,
				started_at,
				plan,
			] = _params ?? [];
			if (!this.runs.has(String(run_id))) {
				this.runs.set(String(run_id), {
					run_id,
					plan_digest,
					target_context_digest,
					database_id,
					core_version,
					started_at,
				});
				this.plans.set(String(run_id), {
					run_id,
					plan: JSON.parse(String(plan)) as unknown,
				});
			}
			return { rows: [] };
		}
		if (sql.includes('INSERT INTO "dbsp_meta"."dbsp_transition_run"')) {
			const [
				run_id,
				plan_digest,
				target_context_digest,
				database_id,
				core_version,
				started_at,
			] = _params ?? [];
			if (!this.runs.has(String(run_id))) {
				this.runs.set(String(run_id), {
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
		if (sql.includes('INSERT INTO "dbsp_meta"."dbsp_transition_run_plan"')) {
			const [run_id, plan] = _params ?? [];
			if (!this.plans.has(String(run_id))) {
				this.plans.set(String(run_id), {
					run_id,
					plan: JSON.parse(String(plan)) as unknown,
				});
			}
			return { rows: [] };
		}
		if (sql.includes('FROM "dbsp_meta"."dbsp_transition_run_plan"')) {
			return {
				rows: [this.plans.get(String(_params?.[0]))].filter(
					(row): row is Record<string, unknown> => row !== undefined,
				),
			};
		}
		if (sql.includes('FROM "dbsp_meta"."dbsp_transition_run"')) {
			return {
				rows: [this.runs.get(String(_params?.[0]))].filter(
					(row): row is Record<string, unknown> => row !== undefined,
				),
			};
		}
		if (sql.includes('INSERT INTO "dbsp_meta"."dbsp_transition_journal"')) {
			return { rows: [] };
		}
		if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
			return { rows: [] };
		}
		if (sql === 'SHOW server_version_num') {
			return { rows: [{ server_version_num: '180000' }] };
		}
		if (sql.includes('current_database()')) {
			return { rows: [{ database_id: 'manual-db' }] };
		}
		if (sql.includes('current_user')) {
			return { rows: [{ current_user: 'schema_owner' }] };
		}
		if (sql.includes('current_schemas(false)')) {
			return { rows: [{ search_path: ['tenant'] }] };
		}
		if (sql === 'SHOW search_path') {
			return { rows: [{ search_path: 'tenant' }] };
		}
		if (sql === 'SHOW standard_conforming_strings') {
			return { rows: [{ standard_conforming_strings: 'on' }] };
		}
		if (sql.includes('FROM pg_catalog.pg_extension')) {
			return { rows: [] };
		}
		if (sql.includes('FROM pg_catalog.pg_database')) {
			return { rows: [{ collation_provider: null, collation_version: null }] };
		}
		return { rows: [] };
	}
}

async function prove(manualOperation: PhysicalOperation) {
	const registry = createPackRegistry([
		{
			rules: [manualRule(manualOperation)],
			operationSemantics: [createManualSqlOperationRuntime()],
			issuer: createPgObservationIssuer(),
		},
	]);
	const compare: CompareOutcome = {
		kind: 'transitions',
		candidates: [
			{
				rule: { id: 'postgresql.manual-sql.test', pack: PG_RULE_PACK_ARTIFACT },
				match: {},
				requiredObservations: manualObservationRequests(),
				obligations: [],
				selectionRationale: {
					chosen: {
						id: 'postgresql.manual-sql.test',
						pack: PG_RULE_PACK_ARTIFACT,
					},
					overRules: [],
					why: 'test manual SQL escape hatch',
				},
			},
		],
		obligations: [],
	};
	const pool = new ManualSqlPool();
	const outcome = await createProver(registry).prove(
		compare,
		createTransitionLessor(async () => pool.connect()),
		context,
	);
	return { outcome, registry, pool };
}

describe('ManualSql operation runtime', () => {
	it('rejects multi-statement escape-hatch SQL while allowing embedded semicolons in literals and comments', () => {
		expectStatementRejected(
			'ALTER TABLE "tenant"."users" ADD COLUMN "x" text; DROP TABLE "tenant"."users"',
			/exactly one PostgreSQL statement/,
		);
		expectStatementRejected(';;', /exactly one PostgreSQL statement/);
		expectStatementRejected(
			'SELECT $tag$; not a terminator',
			/single complete PostgreSQL statement/,
		);

		expect(() =>
			normalizeManualSqlPayload(
				{
					statement: {
						kind: 'unsafe-native',
						category: 'statement',
						text:
							"SELECT ';' AS semicolon /* ; */ " +
							'FROM pg_catalog.pg_class WHERE relname = $tag$;ok$tag$;',
						assumption: userBlastAssumption().id,
						attestation: userBlastAssumption([tableResource]),
					},
					blastRadius: [tableResource],
					preconditions: [],
					postconditions: [],
				},
				context,
			),
		).not.toThrow();
	});

	it.each([
		'BEGIN',
		'COMMIT',
		'ROLLBACK',
		'SAVEPOINT dbsp_manual',
		'SET TRANSACTION READ WRITE',
		'START TRANSACTION',
		'/* leading comment */ COMMIT',
	])('rejects transaction-control escape-hatch SQL: %s', (sql) => {
		expectStatementRejected(sql, /transaction-control/);
	});

	it('rejects malformed unsafe statement attestations before normalization', () => {
		expectPayloadRejected(
			{
				...validManualPayload(),
				statement: {
					...validManualPayload().statement,
					attestation: {
						...userBlastAssumption([tableResource]),
						id: undefined,
					},
				},
			},
			/attestation id/,
		);
		expectPayloadRejected(
			{
				...validManualPayload(),
				statement: {
					...validManualPayload().statement,
					attestation: {
						...userBlastAssumption([tableResource]),
						statement: '',
					},
				},
			},
			/attestation statement/,
		);
		expectPayloadRejected(
			{
				...validManualPayload(),
				statement: {
					...validManualPayload().statement,
					assumption: assumptionId('manual.user-blast.other'),
				},
			},
			/assumption must match its attestation id/,
		);
		expectPayloadRejected(
			{
				...validManualPayload(),
				statement: {
					...validManualPayload().statement,
					attestation: {
						...userBlastAssumption([tableResource]),
						scope: [
							{
								engine: 'postgresql',
								database: 'manual-db',
								schema: 'tenant',
								kind: 'table',
							},
						],
					},
				},
			},
			/attestation scope\[0\] must be a resource address/,
		);
	});

	it('rejects malformed manual assertions before normalization', () => {
		expectPayloadRejected(
			{
				...validManualPayload(),
				preconditions: [
					{
						proposition: { kind: 'unknown', scope: [tableResource] },
						scope: [tableResource],
					},
				],
			},
			/known proposition kind/,
		);
		expectPayloadRejected(
			{
				...validManualPayload(),
				preconditions: [
					{
						proposition: {
							kind: 'manual.users.manual_flag.absent',
							scope: [
								{
									engine: 'postgresql',
									database: 'manual-db',
									kind: 'table',
								},
							],
						},
						scope: [tableResource],
					},
				],
			},
			/preconditions\[0\]\.proposition\.scope\[0\] must be a resource address/,
		);
		expectPayloadRejected(
			{
				...validManualPayload(),
				postconditions: [
					{
						proposition: {
							kind: 'manual.users.manual_flag.present',
							scope: [tableResource],
						},
						scope: [
							{
								engine: 'postgresql',
								database: 'manual-db',
								kind: 'table',
							},
						],
					},
				],
			},
			/postconditions\[0\]\.scope\[0\] must be a resource address/,
		);
	});

	it('canonicalizes well-formed manual assertions and attestation scopes', () => {
		const normalized = normalizeManualSqlPayload(validManualPayload(), context);

		expect(normalized.statement.attestation).toMatchObject({
			id: userBlastAssumption().id,
			statement:
				'schema-owner declares this manual statement only touches users',
			scope: [tableResource],
		});
		expect(normalized.preconditions[0]).toEqual(
			validManualPayload().preconditions[0],
		);
		expect(normalized.postconditions[0]).toEqual(
			validManualPayload().postconditions[0],
		);
	});

	it('rejects user blast-radius attestations that do not cover the declared blastRadius', () => {
		expectPayloadRejected(
			{
				...validManualPayload(),
				statement: {
					...validManualPayload().statement,
					attestation: userBlastAssumption([tableResource]),
				},
				blastRadius: [schemaResource],
			},
			/attestation scope must cover the declared blastRadius/,
		);
	});

	it('mutation: consuming execution-contract eligibility during proving blocks ManualSql callers that never requested a contract', async () => {
		const manualOperation = operation();
		const { outcome } = await prove(manualOperation);

		expect(outcome.kind).toBe('proven');
		if (outcome.kind !== 'proven') {
			return;
		}
		expect(outcome.plan.steps[0]?.operation.operationKind.name).toBe(
			'ManualSql',
		);
	});
});
