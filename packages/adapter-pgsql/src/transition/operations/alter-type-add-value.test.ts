import type {
	ApplyGuard,
	DurableIntentRecord,
	EvidenceObservation,
	ObservationContext,
	ObservationRequest,
	PhysicalOperation,
	StepJournal,
	TransactionalCompletionRecord,
	TransitionRunMetadata,
} from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { createTestTransitionSession } from '../__fixtures__/transition-session.js';
import {
	ALTER_TYPE_ADD_VALUE_CAPABILITY,
	ALTER_TYPE_ADD_VALUE_OPERATION_KIND,
	ENUM_LABEL_VISIBLE_OBSERVATION,
	ENUM_TYPE_EXISTS_OBSERVATION,
	PG_INTROSPECTION_ARTIFACT,
} from '../constants.js';
import { evidenceId } from '../ids.js';
import {
	type AlterTypeAddValuePayload,
	createAlterTypeAddValueOperationRuntime,
	renderAlterTypeAddValueLockSql,
	renderAlterTypeAddValueSql,
} from './alter-type-add-value.js';

const context: ObservationContext = {
	engine: 'postgresql',
	engineVersion: '180000',
	databaseId: 'test',
	capabilities: [ALTER_TYPE_ADD_VALUE_CAPABILITY],
	privileges: [],
	effectiveRole: 'tenant_owner',
	searchPath: ['tenant'],
	sessionConfiguration: { standard_conforming_strings: 'on' },
	extensions: {},
};

const operationPayload: AlterTypeAddValuePayload = {
	schema: 'tenant',
	type: 'status',
	label: 'pending',
	expectedBefore: ['inactive', 'active'],
	expectedAfter: ['inactive', 'active', 'pending'],
};

const operation: PhysicalOperation = {
	ref: 'postgresql:enum-add-value:["tenant","status","pending",{"mode":"append","after":"active"}]',
	operationKind: ALTER_TYPE_ADD_VALUE_OPERATION_KIND,
	payload: operationPayload as never,
};

function journalRun(): TransitionRunMetadata {
	return {
		runId: 'run:enum-add-value',
		planDigest: 'sha256:enum-add-value-plan',
		targetContextDigest: 'sha256:enum-add-value-context',
		databaseId: 'test',
		coreVersion: 'dbsp.core.transition.applier@0.1.0',
		startedAt: new Date(0).toISOString(),
	};
}

function journalRunRow(run: TransitionRunMetadata) {
	return {
		run_id: run.runId,
		plan_digest: run.planDigest,
		target_context_digest: run.targetContextDigest,
		database_id: run.databaseId,
		core_version: run.coreVersion,
		started_at: run.startedAt,
	};
}

function journalTableShape(table: string) {
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
}

type EnumEvidenceOptions = {
	readonly requestSchema?: string;
	readonly requestType?: string;
	readonly requestLabel?: string;
	readonly scopeSchema?: string;
	readonly scopeType?: string;
	readonly scopeDatabase?: string;
	readonly scopeQualifiedBy?: readonly string[];
	readonly valueSchema?: string | null;
	readonly valueType?: string | null;
	readonly oid?: string | null;
	readonly observationContext?: ObservationContext;
};

function enumEvidence(
	labels: readonly string[],
	kind = ENUM_TYPE_EXISTS_OBSERVATION,
	options: EnumEvidenceOptions = {},
): EvidenceObservation {
	const requestSchema = options.requestSchema ?? 'tenant';
	const requestType = options.requestType ?? 'status';
	const request: ObservationRequest = {
		kind,
		scope: [
			{
				engine: 'postgresql',
				database: options.scopeDatabase ?? context.databaseId,
				schema: options.scopeSchema ?? 'tenant',
				kind: 'type',
				name: options.scopeType ?? 'status',
				qualifiedBy: options.scopeQualifiedBy ?? ['enum'],
			},
		],
		detail:
			kind === ENUM_LABEL_VISIBLE_OBSERVATION
				? {
						schema: requestSchema,
						type: requestType,
						label: options.requestLabel ?? 'pending',
					}
				: { schema: requestSchema, type: requestType },
	};
	return {
		role: 'evidence',
		id: evidenceId(`enum.status.${kind}.${labels.join('.')}`),
		issuer: PG_INTROSPECTION_ARTIFACT,
		request,
		result: {
			value: {
				exists: true,
				oid: options.oid === undefined ? '90001' : options.oid,
				schema:
					options.valueSchema === undefined ? 'tenant' : options.valueSchema,
				type: options.valueType === undefined ? 'status' : options.valueType,
				labels,
				claims: [{ kind, holds: true }],
			},
		},
		context: options.observationContext ?? context,
		stability: 'externally-mutable',
		takenAt: new Date().toISOString(),
		scope: request.scope,
		source: 'system-catalog',
		validity: { invalidatedBy: ['external-ddl'] },
	};
}

function typeExistsGuard(): ApplyGuard {
	return {
		appliesTo: operation.ref,
		predicate: {
			kind: ENUM_TYPE_EXISTS_OBSERVATION,
			target: {
				engine: 'postgresql',
				database: 'test',
				schema: 'tenant',
				kind: 'type',
				name: 'status',
				qualifiedBy: ['enum'],
			},
			scope: [
				{
					engine: 'postgresql',
					database: 'test',
					schema: 'tenant',
					kind: 'type',
					name: 'status',
					qualifiedBy: ['enum'],
				},
			],
			detail: { schema: 'tenant', type: 'status' },
		},
		protocol: {
			kind: 'engine-validated',
			onFailureLeaves: [],
			binding: {
				kind: 'external-ddl-exclusion',
				assumption: 'assumption:enum' as never,
				scope: [
					{
						engine: 'postgresql',
						database: 'test',
						schema: 'tenant',
						kind: 'type',
						name: 'status',
						qualifiedBy: ['enum'],
					},
				],
			},
		},
		phase: 'before-operation',
	};
}

describe('AlterTypeAddValue operation runtime', () => {
	it('renders ADD VALUE IF NOT EXISTS with escaping and AFTER position', () => {
		expect(
			renderAlterTypeAddValueSql(
				{
					schema: 'tenant',
					type: 'status',
					label: "owner's",
					after: "user's",
					expectedBefore: ["user's"],
					expectedAfter: ["user's", "owner's"],
				},
				context,
			),
		).toBe(
			`ALTER TYPE "tenant"."status" ADD VALUE IF NOT EXISTS 'owner''s' AFTER 'user''s'`,
		);
	});

	it('fails closed when standard_conforming_strings is not confirmed on', () => {
		expect(() =>
			renderAlterTypeAddValueSql(
				{
					schema: 'tenant',
					type: 'status',
					label: 'pending',
					expectedBefore: ['active'],
					expectedAfter: ['active', 'pending'],
				},
				{ ...context, sessionConfiguration: {} },
			),
		).toThrow(/standard_conforming_strings=on/);
		expect(() =>
			renderAlterTypeAddValueSql(
				{
					schema: 'tenant',
					type: 'status',
					label: 'pending',
					expectedBefore: ['active'],
					expectedAfter: ['active', 'pending'],
				},
				{
					...context,
					sessionConfiguration: { standard_conforming_strings: 'off' },
				},
			),
		).toThrow(/standard_conforming_strings=on/);
	});

	it('keeps backslash-quote enum labels inside the literal when strings are standard-conforming', () => {
		const sql = renderAlterTypeAddValueSql(
			{
				schema: 'tenant',
				type: 'status',
				label: "pending\\'; DROP TYPE tenant.status; --",
				expectedBefore: ['active'],
				expectedAfter: ['active', "pending\\'; DROP TYPE tenant.status; --"],
			},
			context,
		);

		expect(sql).toBe(
			`ALTER TYPE "tenant"."status" ADD VALUE IF NOT EXISTS 'pending\\''; DROP TYPE tenant.status; --'`,
		);
	});

	it('rejects control-character enum label injection attempts', () => {
		expect(() =>
			renderAlterTypeAddValueSql(
				{
					schema: 'tenant',
					type: 'status',
					label: "pending\x00'; DROP TYPE status; --",
					expectedBefore: ['active'],
					expectedAfter: ['active', "pending\x00'; DROP TYPE status; --"],
				},
				context,
			),
		).toThrow(/NUL byte|control characters/);
		expect(() =>
			renderAlterTypeAddValueSql(
				{
					schema: 'tenant',
					type: 'status',
					label: 'pending\x1f',
					expectedBefore: ['active'],
					expectedAfter: ['active', 'pending\x1f'],
				},
				context,
			),
		).toThrow(/control characters/);
	});

	it('enforces PostgreSQL enum label byte length', () => {
		const exactLimitLabel = 'a'.repeat(63);
		const oneByteTooLong = 'a'.repeat(64);
		const multibyteTooLong = '€'.repeat(22);

		expect(
			renderAlterTypeAddValueSql(
				{
					schema: 'tenant',
					type: 'status',
					label: exactLimitLabel,
					expectedBefore: ['active'],
					expectedAfter: ['active', exactLimitLabel],
				},
				context,
			),
		).toBe(
			`ALTER TYPE "tenant"."status" ADD VALUE IF NOT EXISTS '${exactLimitLabel}'`,
		);
		expect(() =>
			renderAlterTypeAddValueSql(
				{
					schema: 'tenant',
					type: 'status',
					label: oneByteTooLong,
					expectedBefore: ['active'],
					expectedAfter: ['active', oneByteTooLong],
				},
				context,
			),
		).toThrow(/63 bytes.*64 bytes/);
		expect(() =>
			renderAlterTypeAddValueSql(
				{
					schema: 'tenant',
					type: 'status',
					label: multibyteTooLong,
					expectedBefore: ['active'],
					expectedAfter: ['active', multibyteTooLong],
				},
				context,
			),
		).toThrow(/63 bytes.*66 bytes/);
	});

	it('declares transactional execution without an intrinsic commit boundary', () => {
		const runtime = createAlterTypeAddValueOperationRuntime();
		const effects = runtime.effectsOf(operation, context);

		expect(effects.effects.execution).toEqual({
			transaction: 'joins-current',
			commitBoundary: 'none',
		});
		expect(effects.effects.writes).toContainEqual({
			kind: 'type',
			schema: 'tenant',
			name: 'status',
		});
		expect(effects.effects.recovery).toBeUndefined();
		expect(effects.restsOn[0]).toMatchObject({
			class: 'operation-pack-semantics',
		});
	});

	it('keeps SQL idempotence but rejects an already-applied label during before fingerprinting', () => {
		const runtime = createAlterTypeAddValueOperationRuntime();

		expect(renderAlterTypeAddValueSql(operationPayload, context)).toBe(
			'ALTER TYPE "tenant"."status" ADD VALUE IF NOT EXISTS \'pending\'',
		);
		expect(() =>
			runtime.buildFingerprints(
				operation,
				[enumEvidence(['inactive', 'active', 'pending'])],
				context,
			),
		).toThrow(/expected before enum labels/);
	});

	it('fingerprints ordered enum labels and rejects wrong-order observations', () => {
		const runtime = createAlterTypeAddValueOperationRuntime();
		const fingerprints = runtime.buildFingerprints(
			operation,
			[enumEvidence(['inactive', 'active'])],
			context,
		);

		expect(fingerprints.expectedBefore.includedFacts).toContainEqual({
			key: 'enum.values.ordered',
			value: 'array:[string:"inactive",string:"active"]',
		});
		expect(fingerprints.expectedAfter.includedFacts).toContainEqual({
			key: 'enum.values.ordered',
			value: 'array:[string:"inactive",string:"active",string:"pending"]',
		});
		expect(() =>
			runtime.buildFingerprints(
				operation,
				[enumEvidence(['active', 'inactive'])],
				context,
			),
		).toThrow(/expected before enum labels/);
	});

	it('binds enum fingerprints only to matching request scope, context and catalog value', () => {
		const runtime = createAlterTypeAddValueOperationRuntime();
		const labels = ['inactive', 'active'] as const;
		const staleCases: readonly EvidenceObservation[] = [
			enumEvidence(labels, ENUM_TYPE_EXISTS_OBSERVATION, {
				requestSchema: 'archive',
			}),
			enumEvidence(labels, ENUM_TYPE_EXISTS_OBSERVATION, {
				requestType: 'priority',
			}),
			enumEvidence(labels, ENUM_TYPE_EXISTS_OBSERVATION, {
				scopeSchema: 'archive',
			}),
			enumEvidence(labels, ENUM_TYPE_EXISTS_OBSERVATION, {
				scopeType: 'priority',
			}),
			enumEvidence(labels, ENUM_TYPE_EXISTS_OBSERVATION, {
				scopeDatabase: 'other_db',
			}),
			enumEvidence(labels, ENUM_TYPE_EXISTS_OBSERVATION, {
				observationContext: { ...context, databaseId: 'other_db' },
			}),
			enumEvidence(labels, ENUM_TYPE_EXISTS_OBSERVATION, {
				valueSchema: 'archive',
			}),
			enumEvidence(labels, ENUM_TYPE_EXISTS_OBSERVATION, {
				valueType: 'priority',
			}),
		];

		for (const staleEvidence of staleCases) {
			expect(() =>
				runtime.buildFingerprints(operation, [staleEvidence], context),
			).toThrow(/missing enum catalog evidence/);
		}

		const fingerprints = runtime.buildFingerprints(
			operation,
			[
				enumEvidence(labels, ENUM_TYPE_EXISTS_OBSERVATION, {
					oid: 'stale',
					valueType: 'priority',
				}),
				enumEvidence(labels),
			],
			context,
		);

		expect(fingerprints.expectedBefore.includedFacts).toContainEqual({
			key: 'pg_type.oid',
			value: '90001',
		});
	});

	it('rejects execute-time enum evidence whose schema matches itself but not the payload', () => {
		const runtime = createAlterTypeAddValueOperationRuntime();

		expect(() =>
			runtime.buildFingerprints(
				operation,
				[
					enumEvidence(['inactive', 'active'], ENUM_TYPE_EXISTS_OBSERVATION, {
						requestSchema: 'archive',
						scopeSchema: 'archive',
						valueSchema: 'archive',
					}),
				],
				context,
			),
		).toThrow(/missing enum catalog evidence/);
	});

	it('executes the rendered ALTER TYPE statement', async () => {
		const runtime = createAlterTypeAddValueOperationRuntime();
		const queries: string[] = [];
		await runtime.executeOperation(
			{
				opaqueClient: createTestTransitionSession({
					query: async (sql: string) => {
						queries.push(sql);
						return { rows: [] };
					},
				}),
			},
			operation,
			context,
		);

		expect(queries).toEqual([
			'ALTER TYPE "tenant"."status" ADD VALUE IF NOT EXISTS \'pending\'',
		]);
	});

	it('writes durable journal metadata outside the tenant target', async () => {
		const runtime = createAlterTypeAddValueOperationRuntime();
		const queries: string[] = [];
		const run = journalRun();
		const intent: DurableIntentRecord = {
			runId: run.runId,
			run,
			stepId: 'step:enum',
			operation,
			recordedAt: new Date().toISOString(),
		};
		const completion: TransactionalCompletionRecord = {
			runId: run.runId,
			stepId: 'step:enum',
			committedWithDdl: false,
			recordedAt: new Date().toISOString(),
		};
		const journal: StepJournal = {
			intent,
			outcome: 'completed',
			transactionalCompletion: completion,
			observedOutcome: {
				stepId: 'step:enum',
				observations: [],
				recordedAt: new Date().toISOString(),
			},
		};
		const client = {
			opaqueClient: createTestTransitionSession({
				query: async (sql: string, params?: readonly unknown[]) => {
					queries.push(sql);
					if (sql.includes('dbsp_transition_journal_shape')) {
						return { rows: [journalTableShape(String(params?.[1]))] };
					}
					if (sql.includes('FROM "dbsp_meta"."dbsp_transition_run"')) {
						return { rows: [journalRunRow(run)] };
					}
					return { rows: [] };
				},
			}),
		};

		await runtime.writeIntentJournal(client, intent);
		await runtime.writeCompletionJournal(client, operation, completion);
		await runtime.writeObservedJournal(client, journal);

		expect(queries).toContain('CREATE SCHEMA IF NOT EXISTS "dbsp_meta"');
		expect(
			queries.some((sql) =>
				sql.includes('INSERT INTO "dbsp_meta"."dbsp_transition_run"'),
			),
		).toBe(true);
		expect(
			queries.filter((sql) =>
				sql.includes('INSERT INTO "dbsp_meta"."dbsp_transition_journal"'),
			),
		).toHaveLength(3);
		expect(queries.some((sql) => sql.includes('"tenant"'))).toBe(false);
	});

	it('acquires the enum type lock before observation', async () => {
		const runtime = createAlterTypeAddValueOperationRuntime();
		const queries: { sql: string; params?: readonly unknown[] }[] = [];
		await runtime.acquireLocks(
			{
				opaqueClient: createTestTransitionSession({
					query: async (sql: string, params?: readonly unknown[]) => {
						queries.push({ sql, params });
						return { rows: [] };
					},
				}),
			},
			operation,
		);

		expect(queries).toEqual([
			{
				sql: renderAlterTypeAddValueLockSql(),
				params: ['dbsp.postgresql.enum-type:tenant.status'],
			},
		]);
	});

	it('fails the enum-type-exists guard and emits guard evidence when the type is missing', async () => {
		const runtime = createAlterTypeAddValueOperationRuntime();
		const result = await runtime.checkGuard(
			{
				opaqueClient: createTestTransitionSession({
					query: async () => ({ rows: [] }),
				}),
			},
			operation,
			typeExistsGuard(),
			context,
		);

		expect(result.passed).toBe(false);
		expect(result.observations).toHaveLength(1);
		expect(result.observations[0]).toMatchObject({
			role: 'evidence',
			request: {
				kind: ENUM_TYPE_EXISTS_OBSERVATION,
				detail: { schema: 'tenant', type: 'status' },
			},
			result: {
				value: {
					exists: false,
					claims: [{ kind: ENUM_TYPE_EXISTS_OBSERVATION, holds: false }],
				},
			},
		});
	});
});
