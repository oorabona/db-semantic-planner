import { createHash } from 'node:crypto';
import type {
	ApplyGuard,
	Assumption,
	DurableIntentRecord,
	EvidenceObservation,
	FingerprintManifest,
	IssuedObservation,
	ObservationContext,
	ObservationIssuer,
	ObservationRequest,
	OperationEffectAssessment,
	PhysicalOperation,
	ResourceAddress,
	StepJournal,
	TransactionalCompletionRecord,
} from '@dbsp/types';
import {
	clampTransactionTimeoutMs,
	setLocalTransactionTimeoutSql,
} from '../../transaction-timeouts.js';
import { assertString, validateIdentifier } from '../../validate.js';
import { stampedClaimForRequest } from '../claim-stamping.js';
import {
	ALTER_TYPE_ADD_VALUE_CAPABILITY,
	ALTER_TYPE_ADD_VALUE_OPERATION_KIND,
	ENUM_LABEL_VISIBLE_OBSERVATION,
	ENUM_TYPE_EXISTS_OBSERVATION,
	PG_OPERATION_PACK_ARTIFACT,
	PG_SCHEMA_USAGE_PRIVILEGE,
	PG_TYPE_ALTER_AUTHORITY_PRIVILEGE,
} from '../constants.js';
import { observationContextMatches } from '../context-match.js';
import { assumptionId, evidenceId } from '../ids.js';
import {
	appendCompletionJournal,
	appendIntentJournal,
	appendObservedJournal,
} from '../journal.js';
import { readPgObservationContext } from '../observation-issuer.js';
import { isPgGuardTimeout } from '../pg-guard-timeout.js';
import { pgPrivilegeValue } from '../privileges.js';
import { stableJson } from '../stable-json.js';

export type AlterTypeAddValuePayload = {
	readonly schema: string;
	readonly type: string;
	readonly label: string;
	readonly after?: string;
	readonly expectedBefore: readonly string[];
	readonly expectedAfter: readonly string[];
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

type EnumCatalogValue = {
	readonly exists: boolean;
	readonly oid: string | null;
	readonly schema: string | null;
	readonly type: string | null;
	readonly labels: readonly string[];
};

const MAX_PG_ENUM_LABEL_BYTES = 63;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
	return (
		Array.isArray(value) && value.every((item) => typeof item === 'string')
	);
}

function quoteIdent(value: string, type: 'schema' | 'alias'): string {
	validateIdentifier(value, type);
	return `"${value.replaceAll('"', '""')}"`;
}

function assertStandardConformingStrings(context: ObservationContext): void {
	if (context.sessionConfiguration.standard_conforming_strings !== 'on') {
		throw new Error(
			'AlterTypeAddValue requires standard_conforming_strings=on before rendering enum labels',
		);
	}
}

export function validatePgEnumLabel(
	value: string,
	context = 'enum label',
): void {
	assertString(value, `Invalid ${context}`);
	if (/\x00/.test(value)) {
		throw new Error(
			`Invalid ${context}: contains NUL byte (\\x00) which would be silently truncated by PostgreSQL`,
		);
	}
	if (/[\x01-\x1f\x7f]/.test(value)) {
		throw new Error(
			`Invalid ${context}: contains control characters (only printable characters allowed)`,
		);
	}
	const byteLength = Buffer.byteLength(value, 'utf8');
	if (byteLength > MAX_PG_ENUM_LABEL_BYTES) {
		throw new Error(
			`Invalid ${context}: exceeds PostgreSQL enum label limit of ${MAX_PG_ENUM_LABEL_BYTES} bytes (got ${byteLength} bytes)`,
		);
	}
}

function quoteEnumLabel(value: string, labelContext: string): string {
	validatePgEnumLabel(value, labelContext);
	return `'${value.replace(/'/g, "''")}'`;
}

function validateEnumLabelList(
	values: readonly string[],
	context: string,
): void {
	for (const [index, value] of values.entries()) {
		validatePgEnumLabel(value, `${context}[${index}]`);
	}
}

function payloadOf(operation: PhysicalOperation): AlterTypeAddValuePayload {
	if (
		operation.operationKind.artifact.id !== PG_OPERATION_PACK_ARTIFACT.id ||
		operation.operationKind.artifact.version !==
			PG_OPERATION_PACK_ARTIFACT.version ||
		operation.operationKind.name !== ALTER_TYPE_ADD_VALUE_OPERATION_KIND.name
	) {
		throw new Error('unsupported operation kind for AlterTypeAddValue');
	}
	if (!isRecord(operation.payload)) {
		throw new Error('AlterTypeAddValue payload must be an object');
	}
	const { schema, type, label, after, expectedBefore, expectedAfter } =
		operation.payload;
	if (
		typeof schema !== 'string' ||
		typeof type !== 'string' ||
		typeof label !== 'string'
	) {
		throw new Error(
			'AlterTypeAddValue payload requires schema, type and label',
		);
	}
	if (after !== undefined && typeof after !== 'string') {
		throw new Error('AlterTypeAddValue after must be a string when present');
	}
	if (!isStringArray(expectedBefore) || !isStringArray(expectedAfter)) {
		throw new Error(
			'AlterTypeAddValue payload requires ordered expectedBefore and expectedAfter label lists',
		);
	}
	validateIdentifier(schema, 'schema');
	validateIdentifier(type, 'alias');
	validatePgEnumLabel(label, 'enum value');
	const normalizedAfter = typeof after === 'string' ? after : undefined;
	if (normalizedAfter !== undefined) {
		validatePgEnumLabel(normalizedAfter, 'enum AFTER position');
	}
	validateEnumLabelList(expectedBefore, 'expectedBefore enum value');
	validateEnumLabelList(expectedAfter, 'expectedAfter enum value');
	if (expectedAfter.filter((value) => value === label).length !== 1) {
		throw new Error('AlterTypeAddValue expectedAfter must contain label once');
	}
	if (expectedBefore.includes(label)) {
		throw new Error('AlterTypeAddValue expectedBefore must not contain label');
	}
	const withoutLabel = expectedAfter.filter((value) => value !== label);
	if (stableJson(withoutLabel) !== stableJson(expectedBefore)) {
		throw new Error(
			'AlterTypeAddValue expectedBefore must match expectedAfter without the added label',
		);
	}
	const index = expectedAfter.indexOf(label);
	if (index <= 0) {
		throw new Error('AlterTypeAddValue only supports ADD VALUE after a label');
	}
	if (
		normalizedAfter !== undefined &&
		expectedAfter[index - 1] !== normalizedAfter
	) {
		throw new Error(
			'AlterTypeAddValue after does not match expectedAfter order',
		);
	}
	if (normalizedAfter === undefined && index !== expectedAfter.length - 1) {
		throw new Error('AlterTypeAddValue positioned labels require after');
	}
	return normalizedAfter === undefined
		? { schema, type, label, expectedBefore, expectedAfter }
		: {
				schema,
				type,
				label,
				after: normalizedAfter,
				expectedBefore,
				expectedAfter,
			};
}

function qualifiedTypeSql(payload: AlterTypeAddValuePayload): string {
	return `${quoteIdent(payload.schema, 'schema')}.${quoteIdent(
		payload.type,
		'alias',
	)}`;
}

export function renderAlterTypeAddValueSql(
	payload: AlterTypeAddValuePayload,
	context: ObservationContext,
): string {
	assertStandardConformingStrings(context);
	const position =
		payload.after === undefined
			? ''
			: ` AFTER ${quoteEnumLabel(payload.after, 'enum AFTER position')}`;
	return `ALTER TYPE ${qualifiedTypeSql(payload)} ADD VALUE IF NOT EXISTS ${quoteEnumLabel(
		payload.label,
		'enum value',
	)}${position}`;
}

export function renderAlterTypeAddValueLockSql(): string {
	return 'SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))';
}

function alterTypeLockKey(payload: AlterTypeAddValuePayload): string {
	return `dbsp.postgresql.enum-type:${payload.schema}.${payload.type}`;
}

function typeResource(
	payload: AlterTypeAddValuePayload,
	context?: ObservationContext,
): ResourceAddress {
	return {
		engine: 'postgresql',
		database: context?.databaseId ?? 'unknown',
		schema: payload.schema,
		kind: 'type',
		name: payload.type,
		qualifiedBy: ['enum'],
	};
}

function enumAddPositionIdentity(payload: AlterTypeAddValuePayload) {
	return payload.after === undefined
		? {
				mode: 'append',
				after:
					payload.expectedBefore[payload.expectedBefore.length - 1] ?? null,
			}
		: { mode: 'after', after: payload.after };
}

export function operationPackSemanticsAssumption(
	payload: AlterTypeAddValuePayload,
	context: ObservationContext,
): Assumption {
	return {
		id: assumptionId(
			`dbsp.postgresql.operations.pg18@0.1.0#semantics:${JSON.stringify([
				payload.schema,
				payload.type,
				payload.label,
				enumAddPositionIdentity(payload),
			])}`,
		),
		class: 'operation-pack-semantics',
		asserter: { kind: 'pack', artifact: PG_OPERATION_PACK_ARTIFACT },
		statement:
			'PostgreSQL AlterTypeAddValue renderer, visibility, SQL idempotence, and effect semantics are correct for this operation payload.',
		scope: [typeResource(payload, context)],
	};
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

function requestTargetsPayload(
	request: ObservationRequest,
	payload: AlterTypeAddValuePayload,
	context: ObservationContext,
): boolean {
	if (
		request.kind !== ENUM_TYPE_EXISTS_OBSERVATION &&
		request.kind !== ENUM_LABEL_VISIBLE_OBSERVATION
	) {
		return false;
	}
	if (!isRecord(request.detail)) {
		return false;
	}
	const detailMatches =
		request.detail.schema === payload.schema &&
		request.detail.type === payload.type &&
		(request.kind === ENUM_TYPE_EXISTS_OBSERVATION ||
			request.detail.label === payload.label);
	if (!detailMatches) {
		return false;
	}
	return request.scope.some((resource) =>
		sameTypeResource(resource, payload, context),
	);
}

function sameTypeResource(
	resource: ResourceAddress,
	payload: AlterTypeAddValuePayload,
	context: ObservationContext,
): boolean {
	return (
		resource.engine === 'postgresql' &&
		resource.database === context.databaseId &&
		resource.schema === payload.schema &&
		resource.kind === 'type' &&
		resource.name === payload.type &&
		resource.qualifiedBy?.length === 1 &&
		resource.qualifiedBy[0] === 'enum'
	);
}

function catalogValueTargetsPayload(
	value: Record<string, unknown>,
	payload: AlterTypeAddValuePayload,
): boolean {
	return value.schema === payload.schema && value.type === payload.type;
}

function catalogValueFromEvidence(
	evidence: readonly EvidenceObservation[],
	payload: AlterTypeAddValuePayload,
	context: ObservationContext,
): EnumCatalogValue | undefined {
	for (const observation of evidence) {
		if (
			!requestTargetsPayload(observation.request, payload, context) ||
			!observationContextMatches(observation, context)
		) {
			continue;
		}
		const value = observation.result.value;
		if (!isRecord(value)) {
			continue;
		}
		if (!catalogValueTargetsPayload(value, payload)) {
			continue;
		}
		if (
			typeof value.exists === 'boolean' &&
			(value.oid === null || typeof value.oid === 'string') &&
			(value.schema === null || typeof value.schema === 'string') &&
			(value.type === null || typeof value.type === 'string') &&
			isStringArray(value.labels)
		) {
			return {
				exists: value.exists,
				oid: value.oid,
				schema: value.schema,
				type: value.type,
				labels: value.labels,
			};
		}
	}
	return undefined;
}

function fingerprintFor(
	payload: AlterTypeAddValuePayload,
	context: ObservationContext,
	catalog: EnumCatalogValue,
	labels: readonly string[],
): FingerprintManifest {
	if (!catalog.exists || catalog.oid == null) {
		throw new Error('enum type catalog identity is missing');
	}
	if (catalog.schema !== payload.schema || catalog.type !== payload.type) {
		throw new Error('enum catalog identity does not target the payload');
	}
	const includedFacts = [
		fact('target.schema', payload.schema),
		fact('target.type', payload.type),
		fact('target.label', payload.label),
		fact('target.after', payload.after ?? null),
		fact('pg_type.oid', catalog.oid),
		fact('pg_type.typname', catalog.type),
		fact('pg_type.typnamespace', catalog.schema),
		fact('pg_enum.labels', labels),
		fact('enum.values.ordered', labels),
		fact('context.engine', context.engine),
		fact('context.engineVersion', context.engineVersion),
		fact('context.databaseId', context.databaseId),
		fact('context.effectiveRole', context.effectiveRole ?? null),
		fact(
			`context.capability.${ALTER_TYPE_ADD_VALUE_CAPABILITY}.available`,
			context.capabilities.includes(ALTER_TYPE_ADD_VALUE_CAPABILITY),
		),
		...targetPrivilegeFacts(payload, context),
	];
	return {
		algorithm: 'sha256:stable-json',
		semanticModel: PG_OPERATION_PACK_ARTIFACT,
		includedFacts,
		excludedOrUnknownFacts: [
			{
				key: 'pg_depend.enum-type-users',
				reason:
					'dependents of the enum type are not changed by ADD VALUE; visibility to later operations is represented by composition facts and commit boundaries',
			},
		],
		digest: digest(includedFacts),
	};
}

function targetPrivilegeFacts(
	payload: AlterTypeAddValuePayload,
	context: ObservationContext,
) {
	return [
		fact(
			`context.privilege.${PG_SCHEMA_USAGE_PRIVILEGE}`,
			pgPrivilegeValue(context, PG_SCHEMA_USAGE_PRIVILEGE, [payload.schema]),
		),
		fact(
			`context.privilege.${PG_TYPE_ALTER_AUTHORITY_PRIVILEGE}`,
			pgPrivilegeValue(context, PG_TYPE_ALTER_AUTHORITY_PRIVILEGE, [
				payload.schema,
				payload.type,
			]),
		),
	];
}

function assertObservedLabels(
	observed: readonly string[],
	expected: readonly string[],
	phase: 'before' | 'after',
): void {
	if (stableJson(observed) !== stableJson(expected)) {
		throw new Error(
			`expected ${phase} enum labels ${stableJson(expected)} but observed ${stableJson(
				observed,
			)}`,
		);
	}
}

function beforeAfterFingerprints(
	operation: PhysicalOperation,
	evidence: readonly EvidenceObservation[],
	context: ObservationContext,
) {
	const payload = payloadOf(operation);
	const catalog = catalogValueFromEvidence(evidence, payload, context);
	if (!catalog) {
		throw new Error('missing enum catalog evidence');
	}
	assertObservedLabels(catalog.labels, payload.expectedBefore, 'before');
	return {
		expectedBefore: fingerprintFor(
			payload,
			context,
			catalog,
			payload.expectedBefore,
		),
		expectedAfter: fingerprintFor(
			payload,
			context,
			catalog,
			payload.expectedAfter,
		),
	};
}

function observedFingerprint(
	operation: PhysicalOperation,
	observation: IssuedObservation,
	context: ObservationContext,
): FingerprintManifest {
	if (observation.role !== 'evidence') {
		throw new Error('enum catalog observation must be durable evidence');
	}
	const payload = payloadOf(operation);
	const catalog = catalogValueFromEvidence([observation], payload, context);
	if (!catalog) {
		throw new Error('enum catalog observation did not include labels');
	}
	return fingerprintFor(payload, context, catalog, catalog.labels);
}

function stringArray(value: unknown): readonly string[] {
	if (Array.isArray(value)) {
		return value.filter((item): item is string => typeof item === 'string');
	}
	if (typeof value === 'string') {
		try {
			const parsed = JSON.parse(value) as unknown;
			return Array.isArray(parsed)
				? parsed.filter((item): item is string => typeof item === 'string')
				: [];
		} catch {
			return [];
		}
	}
	return [];
}

async function readEnumCatalogValue(
	executor: Queryable,
	payload: AlterTypeAddValuePayload,
): Promise<EnumCatalogValue> {
	const result = await executor.query(
		'SELECT t.oid::text AS oid, n.nspname AS schema_name, t.typname AS type_name, ' +
			"COALESCE(pg_catalog.json_agg(e.enumlabel ORDER BY e.enumsortorder) FILTER (WHERE e.enumlabel IS NOT NULL), '[]'::json) AS labels " +
			'FROM pg_catalog.pg_type t ' +
			'JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace ' +
			'LEFT JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid ' +
			"WHERE n.nspname = $1 AND t.typname = $2 AND t.typtype = 'e' " +
			'GROUP BY t.oid, n.nspname, t.typname',
		[payload.schema, payload.type],
	);
	const row = result.rows[0];
	if (!row) {
		return {
			exists: false,
			oid: null,
			schema: null,
			type: null,
			labels: [],
		};
	}
	return {
		exists: true,
		oid: typeof row.oid === 'string' ? row.oid : null,
		schema: typeof row.schema_name === 'string' ? row.schema_name : null,
		type: typeof row.type_name === 'string' ? row.type_name : null,
		labels: stringArray(row.labels),
	};
}

function guardTargetsPayload(
	guard: ApplyGuard,
	payload: AlterTypeAddValuePayload,
	context: ObservationContext,
): boolean {
	if (guard.predicate.kind !== ENUM_TYPE_EXISTS_OBSERVATION) {
		return false;
	}
	if (!isRecord(guard.predicate.detail)) {
		return false;
	}
	return (
		guard.predicate.detail.schema === payload.schema &&
		guard.predicate.detail.type === payload.type &&
		sameTypeResource(guard.predicate.target, payload, context) &&
		guard.predicate.scope.some((resource) =>
			sameTypeResource(resource, payload, context),
		)
	);
}

function enumTypeExistsGuardEvidence(
	context: ObservationContext,
	payload: AlterTypeAddValuePayload,
	catalog: EnumCatalogValue,
): EvidenceObservation {
	const request: ObservationRequest = {
		kind: ENUM_TYPE_EXISTS_OBSERVATION,
		scope: [typeResource(payload, context)],
		detail: {
			schema: payload.schema,
			type: payload.type,
		},
	};
	return {
		role: 'evidence',
		id: evidenceId(
			`dbsp.postgresql.guard.enum-type-exists:${payload.schema}.${payload.type}:${Date.now()}:${catalog.exists ? 'pass' : 'fail'}`,
		),
		issuer: PG_OPERATION_PACK_ARTIFACT,
		request,
		result: {
			value: {
				...catalog,
				claims: [stampedClaimForRequest(request, catalog.exists)],
			},
		},
		context,
		stability: 'externally-mutable',
		takenAt: new Date().toISOString(),
		scope: request.scope,
		source: 'system-catalog',
		validity: { invalidatedBy: ['external-ddl'] },
	};
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

export function createAlterTypeAddValueOperationRuntime() {
	return {
		artifact: PG_OPERATION_PACK_ARTIFACT,
		operationKind: ALTER_TYPE_ADD_VALUE_OPERATION_KIND,
		supportsOperation(operation: PhysicalOperation) {
			return (
				operation.operationKind.artifact.id === PG_OPERATION_PACK_ARTIFACT.id &&
				operation.operationKind.artifact.version ===
					PG_OPERATION_PACK_ARTIFACT.version &&
				operation.operationKind.name ===
					ALTER_TYPE_ADD_VALUE_OPERATION_KIND.name
			);
		},
		effectsOf(
			operation: PhysicalOperation,
			context: ObservationContext,
		): OperationEffectAssessment {
			const payload = payloadOf(operation);
			return {
				effects: {
					reads: [{ kind: 'type', schema: payload.schema, name: payload.type }],
					writes: [
						{ kind: 'type', schema: payload.schema, name: payload.type },
					],
					locks: [
						{
							resource: typeResource(payload, context),
							mode: 'ALTER TYPE',
							maxWaitMs: 5000,
							order: 0,
						},
					],
					invalidates: [
						{
							proposition: ENUM_TYPE_EXISTS_OBSERVATION,
							scope: {
								kind: 'type',
								schema: payload.schema,
								name: payload.type,
							},
						},
						{
							proposition: ENUM_LABEL_VISIBLE_OBSERVATION,
							scope: {
								kind: 'type',
								schema: payload.schema,
								name: payload.type,
							},
						},
					],
					contextMutations: [],
					externalEffects: {
						accountedFor: [
							{ kind: 'type', schema: payload.schema, name: payload.type },
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
			await appendIntentJournal(clientQuery(client), record);
		},
		async begin(client: TransitionExecutionClient) {
			await clientQuery(client).query('BEGIN');
		},
		async setLockTimeout(client: TransitionExecutionClient, maxWaitMs: number) {
			await clientQuery(client).query(
				setLocalTransactionTimeoutSql(
					'lock_timeout',
					`${clampTransactionTimeoutMs(maxWaitMs)}ms`,
				),
			);
		},
		async acquireLocks(
			client: TransitionExecutionClient,
			operation: PhysicalOperation,
		) {
			const payload = payloadOf(operation);
			await clientQuery(client).query(renderAlterTypeAddValueLockSql(), [
				alterTypeLockKey(payload),
			]);
		},
		async observeContext(
			client: TransitionExecutionClient,
			operation: PhysicalOperation,
			_proofContext: ObservationContext,
		) {
			const payload = payloadOf(operation);
			return readPgObservationContext(client.opaqueClient, payload.schema, {
				schema: payload.schema,
				type: payload.type,
			});
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
				kind: ENUM_LABEL_VISIBLE_OBSERVATION,
				scope: [typeResource(payload, context)],
				detail: {
					schema: payload.schema,
					type: payload.type,
					label: payload.label,
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
			const payload = payloadOf(operation);
			if (guard.predicate.kind !== ENUM_TYPE_EXISTS_OBSERVATION) {
				throw new Error(`unsupported PostgreSQL guard ${guard.predicate.kind}`);
			}
			if (!guardTargetsPayload(guard, payload, context)) {
				throw new Error(
					'AlterTypeAddValue enum-type-exists guard does not target the operation payload',
				);
			}
			const catalog = await readEnumCatalogValue(clientQuery(client), payload);
			return {
				passed: catalog.exists,
				observations: [enumTypeExistsGuardEvidence(context, payload, catalog)],
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
					'AlterTypeAddValue does not implement during-operation guards',
				);
			}
			await clientQuery(client).query(
				renderAlterTypeAddValueSql(payloadOf(operation), context),
			);
			return { kind: 'completed' };
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
			return isPgGuardTimeout(error);
		},
	};
}
