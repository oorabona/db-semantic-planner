import { createHash } from 'node:crypto';
import type {
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
	ATTACH_LOGICAL_IDENTITY_OPERATION_KIND,
	DBSP_LOGICAL_IDENTITY_TABLE,
	DBSP_META_SCHEMA,
	LOGICAL_IDENTITY_CARRIER_OBSERVATION,
	PG_OPERATION_PACK_ARTIFACT,
} from '../constants.js';
import { assumptionId } from '../ids.js';
import {
	appendCompletionJournal,
	appendIntentJournal,
	appendObservedJournal,
	renderCreateDbspMetaSchemaSql,
} from '../journal.js';
import { readPgObservationContext } from '../observation-issuer.js';
import { stableJson } from '../stable-json.js';

export type AttachLogicalIdentityPayload = {
	readonly schema: string;
	readonly table: string;
	readonly column?: string;
	readonly logicalId: string;
	readonly carrierKind: 'postgresql-side-table';
	readonly authenticated: false;
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

type CarrierBinding = {
	readonly logicalId: string;
	readonly schema: string;
	readonly table: string;
	readonly column: string | null;
	readonly carrierKind: string;
};

type CarrierState = {
	readonly objectExists: boolean;
	readonly objectBindings: readonly CarrierBinding[];
	readonly logicalIdBindings: readonly CarrierBinding[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function quoteIdent(
	value: string,
	type: 'table' | 'column' | 'schema' | 'alias',
): string {
	validateIdentifier(value, type);
	return `"${value.replaceAll('"', '""')}"`;
}

function payloadOf(operation: PhysicalOperation): AttachLogicalIdentityPayload {
	if (
		operation.operationKind.artifact.id !== PG_OPERATION_PACK_ARTIFACT.id ||
		operation.operationKind.artifact.version !==
			PG_OPERATION_PACK_ARTIFACT.version ||
		operation.operationKind.name !== ATTACH_LOGICAL_IDENTITY_OPERATION_KIND.name
	) {
		throw new Error('unsupported operation kind for AttachLogicalIdentity');
	}
	if (!isRecord(operation.payload)) {
		throw new Error('AttachLogicalIdentity payload must be an object');
	}
	const { schema, table, column, logicalId, carrierKind, authenticated } =
		operation.payload;
	if (
		typeof schema !== 'string' ||
		typeof table !== 'string' ||
		typeof logicalId !== 'string'
	) {
		throw new Error(
			'AttachLogicalIdentity payload requires schema, table and logicalId',
		);
	}
	if (logicalId.trim().length === 0) {
		throw new Error('AttachLogicalIdentity logicalId must be non-empty');
	}
	if (column != null && typeof column !== 'string') {
		throw new Error(
			'AttachLogicalIdentity column must be a string when present',
		);
	}
	if (carrierKind !== 'postgresql-side-table' || authenticated !== false) {
		throw new Error(
			'AttachLogicalIdentity only supports the unauthenticated postgresql-side-table carrier',
		);
	}
	validateIdentifier(schema, 'schema');
	validateIdentifier(table, 'table');
	if (column) {
		validateIdentifier(column, 'column');
	}
	return column
		? { schema, table, column, logicalId, carrierKind, authenticated }
		: { schema, table, logicalId, carrierKind, authenticated };
}

function qualifiedSideTable(): string {
	return `${quoteIdent(DBSP_META_SCHEMA, 'schema')}.${quoteIdent(
		DBSP_LOGICAL_IDENTITY_TABLE,
		'table',
	)}`;
}

function tableResource(
	payload: Pick<AttachLogicalIdentityPayload, 'schema' | 'table'>,
	context?: ObservationContext,
): ResourceAddress {
	return {
		engine: 'postgresql',
		database: context?.databaseId ?? 'unknown',
		schema: payload.schema,
		kind: 'table',
		name: payload.table,
	};
}

function targetResource(
	payload: AttachLogicalIdentityPayload,
	context?: ObservationContext,
): ResourceAddress {
	const table = tableResource(payload, context);
	return payload.column
		? {
				...table,
				kind: 'column',
				name: payload.column,
				qualifiedBy: [payload.table],
			}
		: table;
}

function sideTableResource(
	_payload: Pick<AttachLogicalIdentityPayload, 'schema'>,
	context?: ObservationContext,
): ResourceAddress {
	return {
		engine: 'postgresql',
		database: context?.databaseId ?? 'unknown',
		schema: DBSP_META_SCHEMA,
		kind: 'table',
		name: DBSP_LOGICAL_IDENTITY_TABLE,
	};
}

export function operationPackSemanticsAssumption(
	payload: AttachLogicalIdentityPayload,
	context: ObservationContext,
): Assumption {
	return {
		id: assumptionId(
			`dbsp.postgresql.operations.pg18@0.1.0#logical-identity:${JSON.stringify([
				context.databaseId,
				payload.schema,
				payload.table,
				payload.column ?? null,
				payload.logicalId,
			])}`,
		),
		class: 'operation-pack-semantics',
		asserter: { kind: 'pack', artifact: PG_OPERATION_PACK_ARTIFACT },
		statement:
			'PostgreSQL AttachLogicalIdentity side-table creation, insert, fingerprint, and effect semantics are correct for this operation payload.',
		scope: [
			targetResource(payload, context),
			sideTableResource(payload, context),
		],
	};
}

export function renderAttachLogicalIdentityLockSql(
	payload: AttachLogicalIdentityPayload,
): string {
	return `LOCK TABLE ${quoteIdent(payload.schema, 'schema')}.${quoteIdent(
		payload.table,
		'table',
	)} IN ACCESS SHARE MODE`;
}

export function renderCreateLogicalIdentitySideTableSql(
	_schema: string,
): string {
	return (
		`CREATE TABLE IF NOT EXISTS ${qualifiedSideTable()} (` +
		'logical_id text PRIMARY KEY, ' +
		'schema_name text NOT NULL, ' +
		'table_name text NOT NULL, ' +
		'column_name text, ' +
		'carrier_kind text NOT NULL, ' +
		'attached_at timestamptz NOT NULL DEFAULT clock_timestamp(), ' +
		"CHECK (logical_id <> ''), " +
		"CHECK (carrier_kind = 'postgresql-side-table')" +
		')'
	);
}

export function renderCreateLogicalIdentityIndexesSql(
	_schema: string,
): readonly string[] {
	const sideTable = qualifiedSideTable();
	return [
		`CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdent(
			`${DBSP_LOGICAL_IDENTITY_TABLE}_table_uq`,
			'alias',
		)} ON ${sideTable} (schema_name, table_name) WHERE column_name IS NULL`,
		`CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdent(
			`${DBSP_LOGICAL_IDENTITY_TABLE}_column_uq`,
			'alias',
		)} ON ${sideTable} (schema_name, table_name, column_name) WHERE column_name IS NOT NULL`,
	];
}

export function renderInsertLogicalIdentitySql(_schema: string): string {
	return (
		`INSERT INTO ${qualifiedSideTable()} ` +
		'(logical_id, schema_name, table_name, column_name, carrier_kind) ' +
		'VALUES ($1, $2, $3, $4, $5)'
	);
}

function digest(value: unknown): string {
	return createHash('sha256').update(stableJson(value)).digest('hex');
}

function fact(key: string, value: unknown) {
	return {
		key,
		value: typeof value === 'string' ? value : stableJson(value),
	};
}

function bindingMatchesPayload(
	binding: CarrierBinding,
	payload: AttachLogicalIdentityPayload,
): boolean {
	return (
		binding.schema === payload.schema &&
		binding.table === payload.table &&
		binding.column === (payload.column ?? null) &&
		binding.carrierKind === payload.carrierKind
	);
}

function carrierStateIsAdoptable(
	state: CarrierState,
	payload: AttachLogicalIdentityPayload,
): boolean {
	return (
		state.objectExists &&
		state.objectBindings.length === 0 &&
		state.logicalIdBindings.length === 0 &&
		payload.authenticated === false
	);
}

function carrierStateIsAttached(
	state: CarrierState,
	payload: AttachLogicalIdentityPayload,
): boolean {
	return (
		state.objectExists &&
		state.objectBindings.length === 1 &&
		state.logicalIdBindings.length === 1 &&
		state.objectBindings.every(
			(binding) =>
				binding.logicalId === payload.logicalId &&
				bindingMatchesPayload(binding, payload),
		) &&
		state.logicalIdBindings.every((binding) =>
			bindingMatchesPayload(binding, payload),
		)
	);
}

function expectedAfterState(
	payload: AttachLogicalIdentityPayload,
): CarrierState {
	const binding = {
		logicalId: payload.logicalId,
		schema: payload.schema,
		table: payload.table,
		column: payload.column ?? null,
		carrierKind: payload.carrierKind,
	};
	return {
		objectExists: true,
		objectBindings: [binding],
		logicalIdBindings: [binding],
	};
}

function fingerprintFor(
	payload: AttachLogicalIdentityPayload,
	context: ObservationContext,
	state: CarrierState,
	expected: 'adoptable' | 'attached',
): FingerprintManifest {
	const includedFacts = [
		fact('target.schema', payload.schema),
		fact('target.table', payload.table),
		fact('target.column', payload.column ?? null),
		fact('logicalIdentity.id', payload.logicalId),
		fact('logicalIdentity.carrier.kind', payload.carrierKind),
		fact('logicalIdentity.carrier.authenticated', payload.authenticated),
		fact('carrier.expected', expected),
		fact('carrier.object.exists', state.objectExists),
		fact('carrier.object.bindings', state.objectBindings),
		fact('carrier.logical-id.bindings', state.logicalIdBindings),
		fact('context.engine', context.engine),
		fact('context.engineVersion', context.engineVersion),
		fact('context.databaseId', context.databaseId),
		fact('context.effectiveRole', context.effectiveRole ?? null),
	];
	return {
		algorithm: 'sha256:stable-json',
		semanticModel: PG_OPERATION_PACK_ARTIFACT,
		includedFacts,
		excludedOrUnknownFacts: [
			{
				key: 'dbsp_logical_identity.side-table-exists',
				reason:
					'absence and an existing empty carrier table are equivalent before adoption; the stable precondition is no object/id binding conflict',
			},
			{
				key: 'dbsp_logical_identity.attached_at',
				reason:
					'attached_at is audit metadata and not part of logical identity binding semantics',
			},
		],
		digest: digest(includedFacts),
	};
}

function carrierStateFromValue(value: JsonValue): CarrierState | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const objectBindings = bindingsFromValue(value.objectBindings);
	const logicalIdBindings = bindingsFromValue(value.logicalIdBindings);
	if (
		typeof value.objectExists !== 'boolean' ||
		objectBindings === undefined ||
		logicalIdBindings === undefined
	) {
		return undefined;
	}
	return {
		objectExists: value.objectExists,
		objectBindings,
		logicalIdBindings,
	};
}

function bindingsFromValue(
	value: unknown,
): readonly CarrierBinding[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const bindings: CarrierBinding[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) {
			return undefined;
		}
		const { logicalId, schema, table, column, carrierKind } = entry;
		if (
			typeof logicalId !== 'string' ||
			typeof schema !== 'string' ||
			typeof table !== 'string' ||
			!(column === null || typeof column === 'string') ||
			typeof carrierKind !== 'string'
		) {
			return undefined;
		}
		bindings.push({ logicalId, schema, table, column, carrierKind });
	}
	return bindings;
}

function observationTargetsPayload(
	observation: EvidenceObservation,
	payload: AttachLogicalIdentityPayload,
	expected: 'adoptable' | 'attached',
): boolean {
	if (observation.request.kind !== LOGICAL_IDENTITY_CARRIER_OBSERVATION) {
		return false;
	}
	const detail = observation.request.detail;
	return (
		isRecord(detail) &&
		detail.schema === payload.schema &&
		detail.table === payload.table &&
		(detail.column ?? null) === (payload.column ?? null) &&
		detail.logicalId === payload.logicalId &&
		detail.carrierKind === payload.carrierKind &&
		detail.authenticated === payload.authenticated &&
		detail.expected === expected
	);
}

function carrierStateFromEvidence(
	evidence: readonly EvidenceObservation[],
	payload: AttachLogicalIdentityPayload,
	expected: 'adoptable' | 'attached',
): CarrierState | undefined {
	for (const observation of evidence) {
		if (!observationTargetsPayload(observation, payload, expected)) {
			continue;
		}
		const state = carrierStateFromValue(observation.result.value);
		if (state) {
			return state;
		}
	}
	return undefined;
}

function beforeAfterFingerprints(
	operation: PhysicalOperation,
	evidence: readonly EvidenceObservation[],
	context: ObservationContext,
) {
	const payload = payloadOf(operation);
	const beforeState = carrierStateFromEvidence(evidence, payload, 'adoptable');
	if (!beforeState) {
		throw new Error('missing logical identity carrier evidence');
	}
	if (!carrierStateIsAdoptable(beforeState, payload)) {
		throw new Error(
			'expectedBefore requires an adoptable logical identity carrier state',
		);
	}
	return {
		expectedBefore: fingerprintFor(payload, context, beforeState, 'adoptable'),
		expectedAfter: fingerprintFor(
			payload,
			context,
			expectedAfterState(payload),
			'attached',
		),
	};
}

function observedFingerprint(
	operation: PhysicalOperation,
	observation: IssuedObservation,
	context: ObservationContext,
	expected: 'adoptable' | 'attached',
): FingerprintManifest {
	if (observation.role !== 'evidence') {
		throw new Error(
			'logical identity carrier observation must be durable evidence',
		);
	}
	const payload = payloadOf(operation);
	const state = carrierStateFromValue(observation.result.value);
	if (!state) {
		throw new Error(
			'logical identity carrier observation did not include state',
		);
	}
	if (expected === 'adoptable' && !carrierStateIsAdoptable(state, payload)) {
		throw new Error('logical identity carrier is not adoptable');
	}
	if (expected === 'attached' && !carrierStateIsAttached(state, payload)) {
		throw new Error('logical identity carrier is not attached');
	}
	return fingerprintFor(payload, context, state, expected);
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
	return isRecord(target) &&
		typeof target.connect === 'function' &&
		!releasable(target)
		? (target as PoolLike)
		: undefined;
}

function clientQuery(client: TransitionExecutionClient): Queryable {
	return queryable(client.opaqueClient);
}

function boundedLockTimeout(maxWaitMs: number): number {
	if (!Number.isFinite(maxWaitMs)) {
		return 5000;
	}
	return Math.max(1, Math.min(Math.trunc(maxWaitMs), 600_000));
}

function observationRequest(
	payload: AttachLogicalIdentityPayload,
	context: ObservationContext,
	expected: 'adoptable' | 'attached',
): ObservationRequest {
	return {
		kind: LOGICAL_IDENTITY_CARRIER_OBSERVATION,
		scope: [targetResource(payload, context)],
		detail: {
			schema: payload.schema,
			table: payload.table,
			column: payload.column ?? null,
			logicalId: payload.logicalId,
			carrierKind: payload.carrierKind,
			authenticated: payload.authenticated,
			expected,
		},
	};
}

export function createAttachLogicalIdentityOperationRuntime() {
	return {
		artifact: PG_OPERATION_PACK_ARTIFACT,
		supportsOperation(operation: PhysicalOperation) {
			return (
				operation.operationKind.artifact.id === PG_OPERATION_PACK_ARTIFACT.id &&
				operation.operationKind.artifact.version ===
					PG_OPERATION_PACK_ARTIFACT.version &&
				operation.operationKind.name ===
					ATTACH_LOGICAL_IDENTITY_OPERATION_KIND.name
			);
		},
		effectsOf(
			operation: PhysicalOperation,
			context: ObservationContext,
		): OperationEffectAssessment {
			const payload = payloadOf(operation);
			const targetSelector = payload.column
				? {
						kind: 'column',
						name: payload.column,
						within: tableResource(payload, context),
					}
				: {
						kind: 'table',
						schema: payload.schema,
						name: payload.table,
					};
			const sideTableSelector = {
				kind: 'table',
				schema: DBSP_META_SCHEMA,
				name: DBSP_LOGICAL_IDENTITY_TABLE,
			};
			return {
				effects: {
					reads: [targetSelector, sideTableSelector],
					writes: [sideTableSelector],
					locks: [
						{
							resource: tableResource(payload, context),
							mode: 'ACCESS SHARE',
							maxWaitMs: 5000,
							order: 0,
						},
					],
					invalidates: [
						{
							proposition: LOGICAL_IDENTITY_CARRIER_OBSERVATION,
							scope: targetSelector,
						},
					],
					contextMutations: [],
					externalEffects: {
						accountedFor: [sideTableSelector],
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
			await appendIntentJournal(clientQuery(client), record);
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
		) {
			await clientQuery(client).query(
				renderAttachLogicalIdentityLockSql(payloadOf(operation)),
			);
		},
		async observeContext(
			client: TransitionExecutionClient,
			operation: PhysicalOperation,
			_proofContext: ObservationContext,
		) {
			const payload = payloadOf(operation);
			return readPgObservationContext(client.opaqueClient, payload.schema, {
				table: payload.table,
				...(payload.column ? { column: payload.column } : {}),
				schema: payload.schema,
			});
		},
		async observeOperation(
			client: TransitionExecutionClient,
			operation: PhysicalOperation,
			context: ObservationContext,
			phase: 'before' | 'after',
			issuer: ObservationIssuer,
		) {
			const payload = payloadOf(operation);
			const expected = phase === 'before' ? 'adoptable' : 'attached';
			const request = observationRequest(payload, context, expected);
			const observation = await issuer.execute(
				request,
				client.opaqueClient,
				context,
			);
			return {
				observations: [observation],
				fingerprint: observedFingerprint(
					operation,
					observation,
					context,
					expected,
				),
			};
		},
		async checkGuard() {
			return { passed: true, observations: [], recovery: [] };
		},
		async executeOperation(
			client: TransitionExecutionClient,
			operation: PhysicalOperation,
		) {
			const payload = payloadOf(operation);
			const executor = clientQuery(client);
			await executor.query(renderCreateDbspMetaSchemaSql());
			await executor.query(
				renderCreateLogicalIdentitySideTableSql(payload.schema),
			);
			for (const statement of renderCreateLogicalIdentityIndexesSql(
				payload.schema,
			)) {
				await executor.query(statement);
			}
			await executor.query(renderInsertLogicalIdentitySql(payload.schema), [
				payload.logicalId,
				payload.schema,
				payload.table,
				payload.column ?? null,
				payload.carrierKind,
			]);
			return { kind: 'completed' as const };
		},
		async writeCompletionJournal(
			client: TransitionExecutionClient,
			operation: PhysicalOperation,
			record: TransactionalCompletionRecord,
		) {
			await appendCompletionJournal(clientQuery(client), operation, record);
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
			await appendObservedJournal(clientQuery(client), journal);
		},
		isLockTimeout(error: unknown) {
			return isRecord(error) && error.code === '55P03';
		},
	};
}
