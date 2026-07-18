import { createApplier, createPackRegistry, createProver } from '@dbsp/core';
import type {
	ApplicableEvaluation,
	ApplyPolicy,
	Assumption,
	CompareOutcome,
	ObservationContext,
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

	async connect() {
		return {
			query: async (sql: string, params?: readonly unknown[]) =>
				this.query(sql, params),
			release: vi.fn(),
		};
	}

	async query(sql: string, _params?: readonly unknown[]) {
		this.queries.push(sql);
		if (sql.startsWith('CREATE ')) {
			return { rows: [] };
		}
		if (sql.includes('INSERT INTO "dbsp_meta"."dbsp_transition_run"')) {
			return { rows: [] };
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
	const outcome = await createProver(registry).prove(compare, pool, context);
	return { outcome, registry, pool };
}

describe('ManualSql operation runtime', () => {
	it('retains and widens the human blast-radius assumption', async () => {
		const manualOperation = operation();
		const { outcome } = await prove(manualOperation);

		expect(outcome.kind).toBe('proven');
		if (outcome.kind !== 'proven') {
			return;
		}
		const userBlast = outcome.plan.assumptions.find(
			(assumption) => assumption.class === 'user-blast-radius',
		);
		expect(userBlast).toMatchObject({
			asserter: human,
			scope: [
				{
					engine: 'postgresql',
					database: 'manual-db',
					schema: 'tenant',
					kind: 'schema',
					name: 'tenant',
				},
			],
		});
		expect(outcome.plan.steps[0]?.restsOnAssumptions).toContain(userBlast?.id);
		expect(
			(
				outcome.plan.steps[0]?.operation.payload as {
					statement?: { attestation?: Assumption };
				}
			).statement?.attestation,
		).toMatchObject({ class: 'user-blast-radius' });
	});

	it('blocks without user-blast-radius acceptance and executes with it', async () => {
		const manualOperation = operation([tableResource]);
		const { outcome, registry, pool } = await prove(manualOperation);
		expect(outcome.kind).toBe('proven');
		if (outcome.kind !== 'proven') {
			return;
		}
		const denied = await createApplier(registry).apply(
			{ plan: outcome.plan, assessment: outcome.assessment },
			{ accepts: [{ class: 'operation-pack-semantics' }] },
			pool,
		);

		expect(denied.assessment.decision).toBe('blocked');
		expect(denied.assessment.reasons[0]).toMatchObject({
			code: 'uncomposable',
		});
		expect(
			pool.queries.includes(
				'ALTER TABLE "tenant"."users" ADD COLUMN "manual_flag" boolean',
			),
		).toBe(false);

		const acceptedPolicy: ApplyPolicy = {
			accepts: [
				{ class: 'operation-pack-semantics' },
				{
					class: 'user-blast-radius',
					fromTrustRoot: human,
					withinScope: [{ within: tableResource }],
				},
			],
		};
		const applied = await createApplier(registry).apply(
			{ plan: outcome.plan, assessment: outcome.assessment },
			acceptedPolicy,
			pool,
		);

		expect(applied.assessment.lifecycle).toBe('completed');
		expect(
			pool.queries.includes(
				'ALTER TABLE "tenant"."users" ADD COLUMN "manual_flag" boolean',
			),
		).toBe(true);
		expect(applied.journals[0]?.intent.operation.payload).toMatchObject({
			statement: {
				attestation: expect.objectContaining({
					class: 'user-blast-radius',
				}),
			},
		});
	});
});
