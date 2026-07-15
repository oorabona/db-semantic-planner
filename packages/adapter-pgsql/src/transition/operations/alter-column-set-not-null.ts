import { createHash } from 'node:crypto';
import type {
	AdvisoryObservation,
	ApplyGuard,
	Assumption,
	DurableIntentRecord,
	EvidenceObservation,
	FingerprintManifest,
	IssuedObservation,
	JsonValue,
	ObservationContext,
	ObservationIssuer,
	ObservationRequest,
	OperationEffectAssessment,
	PhysicalOperation,
	ResourceAddress,
	StepJournal,
	TransactionalCompletionRecord,
} from '@dbsp/types';
import { validateIdentifier } from '../../validate.js';
import {
	ALTER_COLUMN_SET_NOT_NULL_OPERATION_KIND,
	COLUMN_EXISTS_OBSERVATION,
	NO_NULLS_GUARD,
	PG_OPERATION_PACK_ARTIFACT,
} from '../constants.js';
import { advisoryObservationId, assumptionId } from '../ids.js';
import { readPgObservationContext } from '../observation-issuer.js';
import { stableJson } from '../stable-json.js';

export type AlterColumnSetNotNullPayload = {
	readonly table: string;
	readonly column: string;
	readonly schema?: string;
};

type QueryResultLike = {
	readonly rows: readonly Record<string, unknown>[];
};

type Queryable = {
	query(sql: string, params?: readonly unknown[]): Promise<QueryResultLike>;
};

type ReleasableQueryable = Queryable & {
	release(error?: unknown): void;
};

type PoolLike = {
	connect(): Promise<ReleasableQueryable>;
};

type TransitionExecutionClient = {
	readonly opaqueClient: unknown;
};

type CatalogValue = {
	readonly exists: boolean;
	readonly nullable: boolean | null;
	readonly oid: string | null;
	readonly attnum: number | null;
};

const JOURNAL_TABLE = 'dbsp_transition_journal';
const GUARD_STATEMENT_TIMEOUT_MS = 5000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function quoteIdent(
	value: string,
	type: 'table' | 'column' | 'schema',
): string {
	validateIdentifier(value, type);
	return `"${value.replaceAll('"', '""')}"`;
}

function payloadOf(operation: PhysicalOperation): AlterColumnSetNotNullPayload {
	if (
		operation.operationKind.artifact.id !== PG_OPERATION_PACK_ARTIFACT.id ||
		operation.operationKind.artifact.version !==
			PG_OPERATION_PACK_ARTIFACT.version ||
		operation.operationKind.name !==
			ALTER_COLUMN_SET_NOT_NULL_OPERATION_KIND.name
	) {
		throw new Error('unsupported operation kind for AlterColumnSetNotNull');
	}
	if (!isRecord(operation.payload)) {
		throw new Error('AlterColumnSetNotNull payload must be an object');
	}
	const { table, column, schema } = operation.payload;
	if (typeof table !== 'string' || typeof column !== 'string') {
		throw new Error('AlterColumnSetNotNull payload requires table and column');
	}
	if (schema != null && typeof schema !== 'string') {
		throw new Error(
			'AlterColumnSetNotNull schema must be a string when present',
		);
	}
	const payload = schema ? { table, column, schema } : { table, column };
	validateIdentifier(payload.table, 'table');
	validateIdentifier(payload.column, 'column');
	if (payload.schema) {
		validateIdentifier(payload.schema, 'schema');
	}
	return payload;
}

function schemaFor(
	payload: AlterColumnSetNotNullPayload,
	_context: ObservationContext,
): string {
	return explicitSchema(payload);
}

function explicitSchema(payload: AlterColumnSetNotNullPayload): string {
	if (!payload.schema) {
		throw new Error('PostgreSQL transition operation requires explicit schema');
	}
	return payload.schema;
}

function tableSql(
	payload: AlterColumnSetNotNullPayload,
	context: ObservationContext,
): string {
	const schema = schemaFor(payload, context);
	return `${quoteIdent(schema, 'schema')}.${quoteIdent(payload.table, 'table')}`;
}

export function renderAlterColumnSetNotNullSql(
	payload: AlterColumnSetNotNullPayload,
	context: ObservationContext,
): string {
	return `ALTER TABLE ${tableSql(payload, context)} ALTER COLUMN ${quoteIdent(
		payload.column,
		'column',
	)} SET NOT NULL`;
}

export function renderSetNotNullLockSql(
	payload: AlterColumnSetNotNullPayload,
	context: ObservationContext,
): string {
	return `LOCK TABLE ${tableSql(payload, context)} IN ACCESS EXCLUSIVE MODE`;
}

export function renderNoNullsCheckSql(
	payload: AlterColumnSetNotNullPayload,
	context: ObservationContext,
): string {
	return `SELECT 1 FROM ${tableSql(payload, context)} WHERE ${quoteIdent(
		payload.column,
		'column',
	)} IS NULL LIMIT 1`;
}

function tableResource(
	payload: AlterColumnSetNotNullPayload,
	context?: ObservationContext,
): ResourceAddress {
	const schema = context
		? schemaFor(payload, context)
		: explicitSchema(payload);
	const base: ResourceAddress = {
		engine: 'postgresql',
		database: context?.databaseId ?? 'unknown',
		kind: 'table',
		name: payload.table,
	};
	return schema ? { ...base, schema } : base;
}

function columnResource(
	payload: AlterColumnSetNotNullPayload,
	context?: ObservationContext,
): ResourceAddress {
	const schema = context
		? schemaFor(payload, context)
		: explicitSchema(payload);
	const base: ResourceAddress = {
		engine: 'postgresql',
		database: context?.databaseId ?? 'unknown',
		kind: 'column',
		name: payload.column,
		qualifiedBy: [payload.table],
	};
	return schema ? { ...base, schema } : base;
}

export function operationPackSemanticsAssumption(
	payload: AlterColumnSetNotNullPayload,
	context: ObservationContext,
): Assumption {
	return {
		id: assumptionId(
			`dbsp.postgresql.operations.pg18@0.1.0#semantics:${JSON.stringify([
				schemaFor(payload, context),
				payload.table,
				payload.column,
			])}`,
		),
		class: 'operation-pack-semantics',
		asserter: { kind: 'pack', artifact: PG_OPERATION_PACK_ARTIFACT },
		statement:
			'PostgreSQL AlterColumnSetNotNull renderer, lock, guard, failure, and effect semantics are correct for this operation payload.',
		scope: [tableResource(payload, context), columnResource(payload, context)],
	};
}

function digest(value: unknown): string {
	return createHash('sha256').update(stableJson(value)).digest('hex');
}

function contextDigest(context: ObservationContext): string {
	return digest({
		engine: context.engine,
		engineVersion: context.engineVersion,
		databaseId: context.databaseId,
		effectiveRole: context.effectiveRole,
		searchPath: context.searchPath,
		sessionConfiguration: context.sessionConfiguration,
		extensions: context.extensions,
	});
}

function sameResourceTarget(
	resource: ResourceAddress,
	payload: AlterColumnSetNotNullPayload,
	context: ObservationContext,
): boolean {
	const schema = schemaFor(payload, context);
	return (
		resource.engine === 'postgresql' &&
		resource.database === context.databaseId &&
		resource.kind === 'column' &&
		resource.name === payload.column &&
		resource.schema === schema &&
		resource.qualifiedBy?.length === 1 &&
		resource.qualifiedBy[0] === payload.table
	);
}

function observationTargetsPayload(
	observation: EvidenceObservation,
	payload: AlterColumnSetNotNullPayload,
	context: ObservationContext,
): boolean {
	if (observation.request.kind !== COLUMN_EXISTS_OBSERVATION) {
		return false;
	}
	const schema = schemaFor(payload, context);
	const detail = observation.request.detail;
	if (!isRecord(detail)) {
		return false;
	}
	if (
		detail.table !== payload.table ||
		detail.column !== payload.column ||
		detail.schema !== schema
	) {
		return false;
	}
	return observation.request.scope.some((resource) =>
		sameResourceTarget(resource, payload, context),
	);
}

function catalogValueFromEvidence(
	evidence: readonly EvidenceObservation[],
	payload: AlterColumnSetNotNullPayload,
	context: ObservationContext,
): CatalogValue | undefined {
	for (const observation of evidence) {
		if (!observationTargetsPayload(observation, payload, context)) {
			continue;
		}
		const value = observation.result.value;
		if (!isRecord(value)) {
			continue;
		}
		const exists = value.exists;
		const nullable = value.nullable;
		const oid = value.oid;
		const attnum = value.attnum;
		if (
			typeof exists === 'boolean' &&
			(nullable === null || typeof nullable === 'boolean') &&
			(oid === null || typeof oid === 'string') &&
			(attnum === null || typeof attnum === 'number')
		) {
			return { exists, nullable, oid, attnum };
		}
	}
	return undefined;
}

function fingerprintFor(
	payload: AlterColumnSetNotNullPayload,
	context: ObservationContext,
	catalog: CatalogValue,
	nullable: boolean,
): FingerprintManifest {
	if (!catalog.exists || catalog.oid == null || catalog.attnum == null) {
		throw new Error('column catalog identity is missing');
	}
	const includedFacts = [
		{ key: 'schema', value: schemaFor(payload, context) },
		{ key: 'table', value: payload.table },
		{ key: 'column', value: payload.column },
		{ key: 'pg_class.oid', value: catalog.oid },
		{ key: 'pg_attribute.attnum', value: String(catalog.attnum) },
		{ key: 'nullable', value: String(nullable) },
		{ key: 'context.digest', value: contextDigest(context) },
	];
	// The fingerprint intentionally scopes to column identity (oid+attnum) and
	// nullability — the only facts a SET NOT NULL transition reads or depends on.
	// Every other column/table fact is DELIBERATELY not fingerprinted; its stability
	// is bounded by the external-ddl-exclusion assumption on the proven step, not by
	// this manifest. Declaring them here keeps the manifest honest: a change to one of
	// these while oid+attnum+nullable stay identical is out of this fingerprint's
	// coverage, not silently "matched". Widening the fingerprint to the full column
	// fact set is tracked for the fingerprint-manifest stage.
	const excludedOrUnknownFacts = [
		{
			key: 'pg_attribute.atttypid',
			reason:
				'column data type/modifiers not fingerprinted; SET NOT NULL is type-agnostic — bounded by the external-ddl-exclusion assumption',
		},
		{
			key: 'pg_attrdef',
			reason:
				'column default not fingerprinted — bounded by the external-ddl-exclusion assumption',
		},
		{
			key: 'pg_attribute.attcollation',
			reason:
				'column collation not fingerprinted — bounded by the external-ddl-exclusion assumption',
		},
		{
			key: 'pg_attribute.attidentity/attgenerated',
			reason:
				'identity/generated status not fingerprinted — bounded by the external-ddl-exclusion assumption',
		},
		{
			key: 'pg_description',
			reason:
				'column/table comment not fingerprinted — bounded by the external-ddl-exclusion assumption',
		},
		{
			key: 'relation.siblings',
			reason:
				'sibling columns, indexes, constraints, RLS and triggers not fingerprinted; SET NOT NULL does not depend on them — bounded by the external-ddl-exclusion assumption',
		},
	];
	return {
		algorithm: 'sha256:stable-json',
		semanticModel: PG_OPERATION_PACK_ARTIFACT,
		includedFacts,
		excludedOrUnknownFacts,
		digest: digest(includedFacts),
	};
}

function beforeAfterFingerprints(
	operation: PhysicalOperation,
	evidence: readonly EvidenceObservation[],
	context: ObservationContext,
) {
	const payload = payloadOf(operation);
	const catalog = catalogValueFromEvidence(evidence, payload, context);
	if (!catalog) {
		throw new Error('missing column catalog evidence');
	}
	if (catalog.nullable !== true) {
		throw new Error('expectedBefore requires a currently nullable column');
	}
	return {
		expectedBefore: fingerprintFor(payload, context, catalog, true),
		expectedAfter: fingerprintFor(payload, context, catalog, false),
	};
}

function observedFingerprint(
	operation: PhysicalOperation,
	observation: IssuedObservation,
	context: ObservationContext,
): FingerprintManifest {
	if (observation.role !== 'evidence') {
		throw new Error('catalog observation must be durable evidence');
	}
	const payload = payloadOf(operation);
	const catalog = catalogValueFromEvidence([observation], payload, context);
	if (!catalog || catalog.nullable == null) {
		throw new Error('catalog observation did not include nullability');
	}
	return fingerprintFor(payload, context, catalog, catalog.nullable);
}

function queryable(target: unknown): Queryable {
	if (isRecord(target) && typeof target.query === 'function') {
		return target as Queryable;
	}
	throw new Error(
		'PostgreSQL transition target must expose query(sql, params)',
	);
}

function releasable(target: unknown): target is ReleasableQueryable {
	return isRecord(target) && typeof target.release === 'function';
}

function poolLike(target: unknown): PoolLike | undefined {
	// A checked-out PoolClient inherits connect() but adds release(); calling
	// connect() on it throws "Client has already been connected". Only a real
	// Pool (connect() without release()) may be connect()-ed.
	return isRecord(target) &&
		typeof target.connect === 'function' &&
		!releasable(target)
		? (target as PoolLike)
		: undefined;
}

function clientQuery(client: TransitionExecutionClient): Queryable {
	return queryable(client.opaqueClient);
}

function qualifiedJournalTable(schema: string): string {
	return `${quoteIdent(schema, 'schema')}.${quoteIdent(JOURNAL_TABLE, 'table')}`;
}

async function ensureJournal(
	executor: Queryable,
	schema: string,
): Promise<void> {
	await executor.query(
		`CREATE TABLE IF NOT EXISTS ${qualifiedJournalTable(schema)} (` +
			'id bigserial PRIMARY KEY, ' +
			'step_id text NOT NULL, ' +
			'event text NOT NULL, ' +
			'operation_ref text NOT NULL, ' +
			'operation_kind text NOT NULL, ' +
			'recorded_at timestamptz NOT NULL DEFAULT now(), ' +
			'record jsonb NOT NULL' +
			')',
	);
}

async function insertJournalRecord(
	executor: Queryable,
	event: string,
	operation: PhysicalOperation,
	stepId: string,
	record: JsonValue,
): Promise<void> {
	const schema = explicitSchema(payloadOf(operation));
	await ensureJournal(executor, schema);
	await executor.query(
		`INSERT INTO ${qualifiedJournalTable(schema)} ` +
			'(step_id, event, operation_ref, operation_kind, record) ' +
			'VALUES ($1, $2, $3, $4, $5::jsonb)',
		[
			stepId,
			event,
			operation.ref,
			operation.operationKind.name,
			JSON.stringify(record),
		],
	);
}

function jsonRecord(value: unknown): JsonValue {
	return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function boundedLockTimeout(maxWaitMs: number): number {
	if (!Number.isFinite(maxWaitMs)) {
		return 5000;
	}
	return Math.max(1, Math.min(Math.trunc(maxWaitMs), 600_000));
}

function boundedStatementTimeout(maxWaitMs: number): number {
	if (!Number.isFinite(maxWaitMs)) {
		return GUARD_STATEMENT_TIMEOUT_MS;
	}
	return Math.max(1, Math.min(Math.trunc(maxWaitMs), 600_000));
}

function advisoryGuardObservation(
	guard: ApplyGuard,
	context: ObservationContext,
	passed: boolean,
): AdvisoryObservation {
	const request =
		guard.predicate.detail === undefined
			? {
					kind: NO_NULLS_GUARD,
					scope: guard.predicate.scope,
				}
			: {
					kind: NO_NULLS_GUARD,
					scope: guard.predicate.scope,
					detail: guard.predicate.detail,
				};
	return {
		role: 'advisory',
		id: advisoryObservationId(
			`dbsp.postgresql.guard.no-nulls:${Date.now()}:${passed ? 'pass' : 'fail'}`,
		),
		issuer: PG_OPERATION_PACK_ARTIFACT,
		request,
		result: { value: { passed } },
		context,
		stability: 'historical-only',
		takenAt: new Date().toISOString(),
		scope: guard.predicate.scope,
	};
}

export function createAlterColumnSetNotNullOperationRuntime() {
	return {
		artifact: PG_OPERATION_PACK_ARTIFACT,
		supportsOperation(operation: PhysicalOperation) {
			return (
				operation.operationKind.artifact.id === PG_OPERATION_PACK_ARTIFACT.id &&
				operation.operationKind.artifact.version ===
					PG_OPERATION_PACK_ARTIFACT.version &&
				operation.operationKind.name ===
					ALTER_COLUMN_SET_NOT_NULL_OPERATION_KIND.name
			);
		},
		effectsOf(
			operation: PhysicalOperation,
			context: ObservationContext,
		): OperationEffectAssessment {
			const payload = payloadOf(operation);
			return {
				effects: {
					reads: [
						{
							kind: 'column',
							name: payload.column,
							within: tableResource(payload, context),
						},
					],
					writes: [
						{
							kind: 'column',
							name: payload.column,
							within: tableResource(payload, context),
						},
					],
					locks: [
						{
							resource: tableResource(payload, context),
							mode: 'ACCESS EXCLUSIVE',
							maxWaitMs: 5000,
							order: 0,
						},
					],
					invalidates: [
						{
							proposition: 'postgresql.column.exists',
							scope: {
								kind: 'column',
								name: payload.column,
								within: tableResource(payload, context),
							},
						},
					],
					contextMutations: [],
					externalEffects: {
						accountedFor: [
							{
								kind: 'column',
								name: payload.column,
								within: tableResource(payload, context),
							},
						],
						couldNotAccountFor: [],
					},
					execution: {
						transaction: 'joins-current',
						commitBoundary: 'none',
					},
				},
				restsOn: [operationPackSemanticsAssumption(payload, context)],
			};
		},
		buildFingerprints: beforeAfterFingerprints,
		async checkout(target: unknown): Promise<TransitionExecutionClient> {
			const pool = poolLike(target);
			if (!pool) {
				throw new Error(
					'PostgreSQL transition target must be a Pool-like object with connect(); checked-out clients are not accepted',
				);
			}
			return { opaqueClient: await pool.connect() };
		},
		release(client: TransitionExecutionClient, error?: unknown) {
			if (releasable(client.opaqueClient)) {
				client.opaqueClient.release(error);
			}
		},
		async writeIntentJournal(
			client: TransitionExecutionClient,
			record: DurableIntentRecord,
		) {
			await insertJournalRecord(
				clientQuery(client),
				'intent',
				record.operation,
				record.stepId,
				jsonRecord(record),
			);
		},
		async begin(client: TransitionExecutionClient) {
			await clientQuery(client).query('BEGIN');
		},
		async setLockTimeout(client: TransitionExecutionClient, maxWaitMs: number) {
			await clientQuery(client).query(
				`SET LOCAL lock_timeout = '${boundedLockTimeout(maxWaitMs)}ms'`,
			);
		},
		async acquireLocks(
			client: TransitionExecutionClient,
			operation: PhysicalOperation,
			_effects: OperationEffectAssessment,
			context: ObservationContext,
		) {
			await clientQuery(client).query(
				renderSetNotNullLockSql(payloadOf(operation), context),
			);
		},
		async observeContext(
			client: TransitionExecutionClient,
			operation: PhysicalOperation,
			_proofContext: ObservationContext,
		) {
			return readPgObservationContext(
				client.opaqueClient,
				explicitSchema(payloadOf(operation)),
			);
		},
		async observeOperation(
			client: TransitionExecutionClient,
			operation: PhysicalOperation,
			context: ObservationContext,
			_phase: 'before' | 'after',
			issuer: ObservationIssuer,
		) {
			const payload = payloadOf(operation);
			const request: ObservationRequest = {
				kind: COLUMN_EXISTS_OBSERVATION,
				scope: [columnResource(payload, context)],
				detail: {
					table: payload.table,
					column: payload.column,
					schema: schemaFor(payload, context),
				},
			};
			const observation = await issuer.execute(
				request,
				client.opaqueClient,
				context,
			);
			return {
				observations: [observation],
				fingerprint: observedFingerprint(operation, observation, context),
			};
		},
		async checkGuard(
			client: TransitionExecutionClient,
			operation: PhysicalOperation,
			guard: ApplyGuard,
			context: ObservationContext,
		) {
			if (guard.predicate.kind !== NO_NULLS_GUARD) {
				throw new Error(`unsupported PostgreSQL guard ${guard.predicate.kind}`);
			}
			const executor = clientQuery(client);
			await executor.query(
				`SET LOCAL statement_timeout = '${boundedStatementTimeout(
					GUARD_STATEMENT_TIMEOUT_MS,
				)}ms'`,
			);
			let result: QueryResultLike;
			try {
				result = await executor.query(
					renderNoNullsCheckSql(payloadOf(operation), context),
				);
			} catch (error) {
				await executor
					.query('SET LOCAL statement_timeout = DEFAULT')
					.catch(() => undefined);
				if (isRecord(error) && error.code === '57014') {
					throw { code: 'DBSP_GUARD_TIMEOUT', cause: error };
				}
				throw error;
			}
			await executor.query('SET LOCAL statement_timeout = DEFAULT');
			const passed = result.rows.length === 0;
			return {
				passed,
				observations: [advisoryGuardObservation(guard, context, passed)],
				recovery: guard.protocol.onFailureLeaves,
			};
		},
		async executeOperation(
			client: TransitionExecutionClient,
			operation: PhysicalOperation,
			context: ObservationContext,
			duringGuards: readonly ApplyGuard[] = [],
		) {
			if (duringGuards.length > 0) {
				throw new Error(
					'AlterColumnSetNotNull does not implement during-operation guards',
				);
			}
			await clientQuery(client).query(
				renderAlterColumnSetNotNullSql(payloadOf(operation), context),
			);
		},
		async writeCompletionJournal(
			client: TransitionExecutionClient,
			operation: PhysicalOperation,
			record: TransactionalCompletionRecord,
		) {
			await insertJournalRecord(
				clientQuery(client),
				'completion',
				operation,
				record.stepId,
				jsonRecord(record),
			);
		},
		async commit(client: TransitionExecutionClient) {
			await clientQuery(client).query('COMMIT');
		},
		async rollback(client: TransitionExecutionClient) {
			await clientQuery(client).query('ROLLBACK');
		},
		async writeObservedJournal(
			client: TransitionExecutionClient,
			journal: StepJournal,
		) {
			await insertJournalRecord(
				clientQuery(client),
				'observed',
				journal.intent.operation,
				journal.intent.stepId,
				jsonRecord(journal),
			);
		},
		isLockTimeout(error: unknown) {
			return (
				isRecord(error) &&
				(error.code === '55P03' || error.code === 'DBSP_GUARD_TIMEOUT')
			);
		},
	};
}
