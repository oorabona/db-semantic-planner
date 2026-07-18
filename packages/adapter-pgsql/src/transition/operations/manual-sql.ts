import { createHash } from 'node:crypto';
import type {
	Assumption,
	DurableIntentRecord,
	EvidenceObservation,
	ExecutableAssertion,
	FingerprintManifest,
	ObservationContext,
	OperationEffectAssessment,
	PhysicalOperation,
	ResourceAddress,
	ResourceSelector,
	StepJournal,
	TransactionalCompletionRecord,
	UnsafeNativeFragment,
} from '@dbsp/types';
import {
	DBSP_META_SCHEMA,
	MANUAL_SQL_OPERATION_KIND,
	PG_OPERATION_PACK_ARTIFACT,
} from '../constants.js';
import { assumptionId } from '../ids.js';
import {
	appendCompletionJournal,
	appendIntentJournal,
	appendObservedJournal,
} from '../journal.js';
import { readPgObservationContext } from '../observation-issuer.js';
import { stableJson } from '../stable-json.js';

export type ManualSqlPayload = {
	readonly statement: UnsafeNativeFragment;
	readonly blastRadius: readonly ResourceAddress[];
	readonly preconditions: readonly ExecutableAssertion[];
	readonly postconditions: readonly ExecutableAssertion[];
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
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

function digest(value: unknown): string {
	return createHash('sha256').update(stableJson(value)).digest('hex');
}

function fact(key: string, value: unknown) {
	return {
		key,
		value: typeof value === 'string' ? value : stableJson(value),
	};
}

function operationPackSemanticsAssumption(
	payload: ManualSqlPayload,
	context: ObservationContext,
): Assumption {
	return {
		id: assumptionId(
			`dbsp.postgresql.operations.pg18@0.1.0#manual-sql:${digest([
				payload.statement.text,
				payload.blastRadius,
				context.databaseId,
			])}`,
		),
		class: 'operation-pack-semantics',
		asserter: { kind: 'pack', artifact: PG_OPERATION_PACK_ARTIFACT },
		statement:
			'PostgreSQL ManualSql executes one author-attested unsafe-native statement and treats declared pre/postconditions and blast radius as assumptions, not verified facts.',
		scope: metadataAndBlastScope(payload, context),
	};
}

function databaseResource(context: ObservationContext): ResourceAddress {
	return {
		engine: 'postgresql',
		database: context.databaseId,
		kind: 'database',
		name: context.databaseId,
	};
}

function schemaResource(
	schema: string,
	context: ObservationContext,
): ResourceAddress {
	return {
		engine: 'postgresql',
		database: context.databaseId,
		schema,
		kind: 'schema',
		name: schema,
	};
}

function resourceHasUnknownScope(resource: ResourceAddress): boolean {
	return (
		resource.database === 'unknown' ||
		resource.database.length === 0 ||
		resource.schema === 'unknown'
	);
}

function widenedManualScope(
	blastRadius: readonly ResourceAddress[],
	context: ObservationContext,
): readonly ResourceAddress[] {
	const schemas = [
		...new Set(
			blastRadius
				.map((resource) => resource.schema)
				.filter((schema): schema is string => !!schema && schema !== 'unknown'),
		),
	];
	if (schemas.length > 0) {
		return schemas.map((schema) => schemaResource(schema, context));
	}
	if (context.targetSchema) {
		return [schemaResource(context.targetSchema, context)];
	}
	return [databaseResource(context)];
}

function normalizeAssumptionScope(
	scope: readonly ResourceAddress[],
	blastRadius: readonly ResourceAddress[],
	context: ObservationContext,
): readonly ResourceAddress[] {
	if (scope.length === 0 || scope.some(resourceHasUnknownScope)) {
		return widenedManualScope(blastRadius, context);
	}
	return scope;
}

function metadataAndBlastScope(
	payload: ManualSqlPayload,
	context: ObservationContext,
): readonly ResourceAddress[] {
	return [
		...payload.blastRadius,
		{
			engine: 'postgresql',
			database: context.databaseId,
			schema: DBSP_META_SCHEMA,
			kind: 'schema',
			name: DBSP_META_SCHEMA,
		},
	];
}

function resourceSelector(resource: ResourceAddress): ResourceSelector {
	return {
		kind: resource.kind,
		...(resource.schema ? { schema: resource.schema } : {}),
		name: resource.name,
	};
}

function assertResource(value: unknown, field: string): ResourceAddress {
	if (!isRecord(value)) {
		throw new Error(`${field} must be a resource address`);
	}
	const { engine, database, schema, kind, name, qualifiedBy } = value;
	if (
		typeof engine !== 'string' ||
		typeof database !== 'string' ||
		(schema !== undefined && typeof schema !== 'string') ||
		typeof kind !== 'string' ||
		typeof name !== 'string' ||
		(qualifiedBy !== undefined &&
			(!Array.isArray(qualifiedBy) ||
				!qualifiedBy.every((item) => typeof item === 'string')))
	) {
		throw new Error(`${field} must be a resource address`);
	}
	return {
		engine,
		database,
		...(schema !== undefined ? { schema } : {}),
		kind,
		name,
		...(qualifiedBy !== undefined ? { qualifiedBy } : {}),
	};
}

function assertAssertion(value: unknown, field: string): ExecutableAssertion {
	if (
		!isRecord(value) ||
		!isRecord(value.proposition) ||
		!Array.isArray(value.scope)
	) {
		throw new Error(`${field} must be an executable assertion`);
	}
	return value as unknown as ExecutableAssertion;
}

function assertUnsafeStatement(value: unknown): UnsafeNativeFragment {
	if (
		!isRecord(value) ||
		value.kind !== 'unsafe-native' ||
		value.category !== 'statement' ||
		typeof value.text !== 'string' ||
		value.text.trim().length === 0 ||
		typeof value.assumption !== 'string' ||
		!isRecord(value.attestation)
	) {
		throw new Error(
			'ManualSql requires one unsafe-native statement fragment with a user-blast-radius attestation',
		);
	}
	const attestation = value.attestation;
	if (
		attestation.class !== 'user-blast-radius' ||
		!isRecord(attestation.asserter) ||
		attestation.asserter.kind !== 'human' ||
		typeof attestation.asserter.identity !== 'string' ||
		!Array.isArray(attestation.scope)
	) {
		throw new Error(
			'ManualSql statement attestation must be a human user-blast-radius assumption',
		);
	}
	return value as unknown as UnsafeNativeFragment;
}

function payloadOf(operation: PhysicalOperation): ManualSqlPayload {
	if (
		operation.operationKind.artifact.id !== PG_OPERATION_PACK_ARTIFACT.id ||
		operation.operationKind.artifact.version !==
			PG_OPERATION_PACK_ARTIFACT.version ||
		operation.operationKind.name !== MANUAL_SQL_OPERATION_KIND.name
	) {
		throw new Error('unsupported operation kind for ManualSql');
	}
	if (!isRecord(operation.payload)) {
		throw new Error('ManualSql payload must be an object');
	}
	const { statement, blastRadius, preconditions, postconditions } =
		operation.payload;
	if (!Array.isArray(blastRadius) || blastRadius.length === 0) {
		throw new Error('ManualSql requires a non-empty declared blastRadius');
	}
	if (!Array.isArray(preconditions) || !Array.isArray(postconditions)) {
		throw new Error(
			'ManualSql requires declared preconditions and postconditions',
		);
	}
	return {
		statement: assertUnsafeStatement(statement),
		blastRadius: blastRadius.map((resource, index) =>
			assertResource(resource, `blastRadius[${index}]`),
		),
		preconditions: preconditions.map((assertion, index) =>
			assertAssertion(assertion, `preconditions[${index}]`),
		),
		postconditions: postconditions.map((assertion, index) =>
			assertAssertion(assertion, `postconditions[${index}]`),
		),
	};
}

function userBlastRadiusAssumption(
	payload: ManualSqlPayload,
	context: ObservationContext,
): Assumption {
	const attestation = payload.statement.attestation;
	if (!attestation) {
		throw new Error(
			'ManualSql statement is missing its user-blast-radius assumption',
		);
	}
	return {
		...attestation,
		scope: normalizeAssumptionScope(
			attestation.scope,
			payload.blastRadius,
			context,
		),
	};
}

export function normalizeManualSqlPayload(
	payload: ManualSqlPayload,
	context: ObservationContext,
): ManualSqlPayload {
	const statement = assertUnsafeStatement(payload.statement);
	return {
		statement: {
			...statement,
			attestation: userBlastRadiusAssumption(
				{ ...payload, statement },
				context,
			),
		},
		blastRadius: payload.blastRadius.map((resource, index) =>
			assertResource(resource, `blastRadius[${index}]`),
		),
		preconditions: payload.preconditions.map((assertion, index) =>
			assertAssertion(assertion, `preconditions[${index}]`),
		),
		postconditions: payload.postconditions.map((assertion, index) =>
			assertAssertion(assertion, `postconditions[${index}]`),
		),
	};
}

function fingerprintFor(
	payload: ManualSqlPayload,
	context: ObservationContext,
	phase: 'before' | 'after',
): FingerprintManifest {
	const assertions =
		phase === 'before' ? payload.preconditions : payload.postconditions;
	const includedFacts = [
		fact('manual-sql.statement.sha256', digest(payload.statement.text)),
		fact('manual-sql.phase', phase),
		fact('manual-sql.declared-blast-radius', payload.blastRadius),
		fact('manual-sql.declared-assertions', assertions),
		fact(
			'manual-sql.user-blast-radius',
			userBlastRadiusAssumption(payload, context),
		),
		fact('context.engine', context.engine),
		fact('context.engineVersion', context.engineVersion),
		fact('context.databaseId', context.databaseId),
	];
	return {
		algorithm: 'sha256:stable-json',
		semanticModel: PG_OPERATION_PACK_ARTIFACT,
		includedFacts,
		excludedOrUnknownFacts: [
			{
				key: 'manual-sql.semantic-safety',
				reason:
					'ManualSql is an explicit escape hatch; dbsp does not parse or prove the statement beyond its declared statement category and accepted user-blast-radius assumption.',
			},
		],
		digest: digest(includedFacts),
	};
}

function beforeAfterFingerprints(
	operation: PhysicalOperation,
	_evidence: readonly EvidenceObservation[],
	context: ObservationContext,
) {
	const payload = payloadOf(operation);
	return {
		expectedBefore: fingerprintFor(payload, context, 'before'),
		expectedAfter: fingerprintFor(payload, context, 'after'),
	};
}

export function createManualSqlOperationRuntime() {
	return {
		artifact: PG_OPERATION_PACK_ARTIFACT,
		operationKind: MANUAL_SQL_OPERATION_KIND,
		supportsOperation(operation: PhysicalOperation) {
			return (
				operation.operationKind.artifact.id === PG_OPERATION_PACK_ARTIFACT.id &&
				operation.operationKind.artifact.version ===
					PG_OPERATION_PACK_ARTIFACT.version &&
				operation.operationKind.name === MANUAL_SQL_OPERATION_KIND.name
			);
		},
		effectsOf(
			operation: PhysicalOperation,
			context: ObservationContext,
		): OperationEffectAssessment {
			const payload = payloadOf(operation);
			const selectors = payload.blastRadius.map(resourceSelector);
			return {
				effects: {
					reads: selectors,
					writes: selectors,
					locks: [],
					invalidates: selectors.map((scope) => ({ scope })),
					contextMutations: [],
					externalEffects: {
						accountedFor: selectors,
						couldNotAccountFor: [],
					},
					execution: {
						transaction: 'joins-current',
						commitBoundary: 'none',
					},
				},
				restsOn: [
					operationPackSemanticsAssumption(payload, context),
					userBlastRadiusAssumption(payload, context),
				],
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
		async setLockTimeout(
			_client: TransitionExecutionClient,
			_maxWaitMs: number,
		) {
			// ManualSql does not infer object locks from opaque SQL text.
		},
		async acquireLocks() {
			// ManualSql has only declared blast radius; the human attestation is policy gated.
		},
		async observeContext(
			client: TransitionExecutionClient,
			_operation: PhysicalOperation,
			proofContext: ObservationContext,
		) {
			return readPgObservationContext(
				client.opaqueClient,
				proofContext.targetSchema ?? proofContext.searchPath?.[0] ?? 'public',
			);
		},
		async observeOperation(
			_client: TransitionExecutionClient,
			operation: PhysicalOperation,
			context: ObservationContext,
			phase: 'before' | 'after',
		) {
			return {
				observations: [],
				fingerprint: fingerprintFor(payloadOf(operation), context, phase),
			};
		},
		async checkGuard() {
			return { passed: true, observations: [], recovery: [] };
		},
		async executeOperation(
			client: TransitionExecutionClient,
			operation: PhysicalOperation,
		) {
			await clientQuery(client).query(payloadOf(operation).statement.text);
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
