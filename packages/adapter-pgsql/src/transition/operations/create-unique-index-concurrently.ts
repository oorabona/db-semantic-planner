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
	RecoveryArtefact,
	ResourceAddress,
	StepJournal,
	TransactionalCompletionRecord,
} from '@dbsp/types';
import { validateIdentifier } from '../../validate.js';
import {
	CREATE_UNIQUE_INDEX_CONCURRENTLY_CAPABILITY,
	CREATE_UNIQUE_INDEX_CONCURRENTLY_OPERATION_KIND,
	INDEX_ABSENT_OBSERVATION,
	NO_DUPLICATES_FOR_UNIQUE_INDEX_BUILD_GUARD,
	PG_OPERATION_PACK_ARTIFACT,
	PG_SCHEMA_USAGE_PRIVILEGE,
	PG_TABLE_ALTER_AUTHORITY_PRIVILEGE,
	TABLE_INDEXES_OBSERVATION,
} from '../constants.js';
import { observationContextMatches } from '../context-match.js';
import { assumptionId } from '../ids.js';
import {
	appendCompletionJournal,
	appendIntentJournal,
	appendObservedJournal,
} from '../journal.js';
import {
	normalizePgIndexCatalogRow,
	readPgObservationContext,
} from '../observation-issuer.js';
import { pgPrivilegeValue } from '../privileges.js';
import { stableJson } from '../stable-json.js';

export type IndexSet = {
	readonly name: string;
	readonly oid: string | null;
	readonly columns: readonly string[];
	readonly unique: boolean;
	readonly valid: boolean;
	readonly ready: boolean;
	readonly method: string | null;
	readonly predicate: string | null;
	readonly expressions: readonly string[];
	readonly include: readonly string[];
	readonly opclass: Readonly<Record<string, string>>;
	readonly collation: Readonly<Record<string, string>>;
	readonly options: Readonly<Record<string, string>>;
	readonly with: Readonly<Record<string, string>>;
	readonly nullsNotDistinct: boolean;
};

export type CreateUniqueIndexConcurrentlyPayload = {
	readonly schema: string;
	readonly table: string;
	readonly index: string;
	readonly columns: readonly string[];
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

type IndexCatalogValue = {
	readonly exists: boolean;
	readonly oid: string | null;
	readonly relkind: string | null;
	readonly schema: string | null;
	readonly table: string | null;
	readonly targetIndexNameExists: boolean;
	readonly indexes: readonly IndexSet[];
};

type TargetIndexCatalogValue = {
	readonly tableExists: boolean;
	readonly tableOid: string | null;
	readonly relkind: string | null;
	readonly schema: string | null;
	readonly table: string | null;
	readonly index: IndexSet | null;
};

const DEFAULT_LOCK_TIMEOUT_MS = 5000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
	return (
		Array.isArray(value) && value.every((item) => typeof item === 'string')
	);
}

function quoteIdent(
	value: string,
	type: 'schema' | 'table' | 'column' | 'alias',
): string {
	validateIdentifier(value, type);
	return `"${value.replaceAll('"', '""')}"`;
}

function payloadOf(
	operation: PhysicalOperation,
): CreateUniqueIndexConcurrentlyPayload {
	if (
		operation.operationKind.artifact.id !== PG_OPERATION_PACK_ARTIFACT.id ||
		operation.operationKind.artifact.version !==
			PG_OPERATION_PACK_ARTIFACT.version ||
		operation.operationKind.name !==
			CREATE_UNIQUE_INDEX_CONCURRENTLY_OPERATION_KIND.name
	) {
		throw new Error(
			'unsupported operation kind for CreateUniqueIndexConcurrently',
		);
	}
	if (!isRecord(operation.payload)) {
		throw new Error('CreateUniqueIndexConcurrently payload must be an object');
	}
	const { schema, table, index, columns } = operation.payload;
	if (
		typeof schema !== 'string' ||
		typeof table !== 'string' ||
		typeof index !== 'string' ||
		!isStringArray(columns) ||
		columns.length === 0
	) {
		throw new Error(
			'CreateUniqueIndexConcurrently payload requires schema, table, index and columns',
		);
	}
	validateIdentifier(schema, 'schema');
	validateIdentifier(table, 'table');
	validateIdentifier(index, 'alias');
	for (const column of columns) {
		validateIdentifier(column, 'column');
	}
	return { schema, table, index, columns };
}

function tableSql(payload: CreateUniqueIndexConcurrentlyPayload): string {
	return `${quoteIdent(payload.schema, 'schema')}.${quoteIdent(
		payload.table,
		'table',
	)}`;
}

export function renderCreateUniqueIndexConcurrentlySql(
	payload: CreateUniqueIndexConcurrentlyPayload,
): string {
	return `CREATE UNIQUE INDEX CONCURRENTLY ${quoteIdent(
		payload.index,
		'alias',
	)} ON ${tableSql(payload)} (${payload.columns
		.map((column) => quoteIdent(column, 'column'))
		.join(', ')})`;
}

export function renderDropIndexConcurrentlySql(
	payload: Pick<CreateUniqueIndexConcurrentlyPayload, 'schema' | 'index'>,
): string {
	return `DROP INDEX CONCURRENTLY IF EXISTS ${quoteIdent(
		payload.schema,
		'schema',
	)}.${quoteIdent(payload.index, 'alias')}`;
}

function tableResource(
	payload: CreateUniqueIndexConcurrentlyPayload,
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

function indexResource(
	payload: CreateUniqueIndexConcurrentlyPayload,
	context?: ObservationContext,
): ResourceAddress {
	return {
		engine: 'postgresql',
		database: context?.databaseId ?? 'unknown',
		schema: payload.schema,
		kind: 'index',
		name: payload.index,
		qualifiedBy: [payload.table],
	};
}

function columnResource(
	payload: CreateUniqueIndexConcurrentlyPayload,
	column: string,
	context?: ObservationContext,
): ResourceAddress {
	return {
		engine: 'postgresql',
		database: context?.databaseId ?? 'unknown',
		schema: payload.schema,
		kind: 'column',
		name: column,
		qualifiedBy: [payload.table],
	};
}

export function invalidIndexArtefact(
	payload: CreateUniqueIndexConcurrentlyPayload,
	context?: ObservationContext,
): RecoveryArtefact {
	return {
		kind: 'invalid-index',
		resource: indexResource(payload, context),
		note: 'CREATE UNIQUE INDEX CONCURRENTLY can leave an INVALID index after uniqueness validation fails',
	};
}

export function operationPackSemanticsAssumption(
	payload: CreateUniqueIndexConcurrentlyPayload,
	context: ObservationContext,
): Assumption {
	return {
		id: assumptionId(
			`dbsp.postgresql.operations.pg18@0.1.0#semantics:${JSON.stringify([
				payload.schema,
				payload.table,
				payload.index,
			])}`,
		),
		class: 'operation-pack-semantics',
		asserter: { kind: 'pack', artifact: PG_OPERATION_PACK_ARTIFACT },
		statement:
			'PostgreSQL CreateUniqueIndexConcurrently renderer, autocommit execution, engine guard compensation, and effect semantics are correct for this operation payload.',
		scope: [
			tableResource(payload, context),
			indexResource(payload, context),
			...payload.columns.map((column) =>
				columnResource(payload, column, context),
			),
		],
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

function stringOrNull(value: unknown): string | null {
	return typeof value === 'string' ? value : null;
}

function indexSetEntry(value: unknown): IndexSet | undefined {
	return isRecord(value)
		? (normalizePgIndexCatalogRow(value) ?? undefined)
		: undefined;
}

function indexSet(value: unknown): readonly IndexSet[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const indexes: IndexSet[] = [];
	for (const item of value) {
		const index = indexSetEntry(item);
		if (!index) {
			return undefined;
		}
		indexes.push(index);
	}
	return indexes.sort((left, right) => left.name.localeCompare(right.name));
}

function sameTableResource(
	resource: ResourceAddress,
	payload: CreateUniqueIndexConcurrentlyPayload,
	context: ObservationContext,
): boolean {
	return (
		resource.engine === 'postgresql' &&
		resource.database === context.databaseId &&
		resource.schema === payload.schema &&
		resource.kind === 'table' &&
		resource.name === payload.table
	);
}

function requestTargetsPayload(
	request: ObservationRequest,
	payload: CreateUniqueIndexConcurrentlyPayload,
	context: ObservationContext,
): boolean {
	if (request.kind !== TABLE_INDEXES_OBSERVATION || !isRecord(request.detail)) {
		return false;
	}
	return (
		request.detail.schema === payload.schema &&
		request.detail.table === payload.table &&
		request.detail.index === payload.index &&
		request.scope.some((resource) =>
			sameTableResource(resource, payload, context),
		)
	);
}

function sameIndexResource(
	resource: ResourceAddress,
	payload: CreateUniqueIndexConcurrentlyPayload,
	context: ObservationContext,
): boolean {
	return (
		resource.engine === 'postgresql' &&
		resource.database === context.databaseId &&
		resource.schema === payload.schema &&
		resource.kind === 'index' &&
		resource.name === payload.index &&
		resource.qualifiedBy?.length === 1 &&
		resource.qualifiedBy[0] === payload.table
	);
}

function catalogValueFromEvidence(
	evidence: readonly EvidenceObservation[],
	payload: CreateUniqueIndexConcurrentlyPayload,
	context: ObservationContext,
): IndexCatalogValue | undefined {
	for (const observation of evidence) {
		if (
			!requestTargetsPayload(observation.request, payload, context) ||
			!observationContextMatches(observation, context)
		) {
			continue;
		}
		const value = observation.result.value;
		if (
			!isRecord(value) ||
			value.schema !== payload.schema ||
			value.table !== payload.table
		) {
			continue;
		}
		const indexes = indexSet(value.indexes);
		if (
			typeof value.exists === 'boolean' &&
			(value.oid === null || typeof value.oid === 'string') &&
			(value.relkind === null || typeof value.relkind === 'string') &&
			typeof value.targetIndexNameExists === 'boolean' &&
			indexes !== undefined
		) {
			return {
				exists: value.exists,
				oid: value.oid,
				relkind: value.relkind,
				schema: value.schema,
				table: value.table,
				targetIndexNameExists: value.targetIndexNameExists,
				indexes,
			};
		}
	}
	return undefined;
}

function hasUnsupportedShape(index: IndexSet): boolean {
	return (
		index.unique !== true ||
		index.method !== 'btree' ||
		index.predicate !== null ||
		index.expressions.length > 0 ||
		index.include.length > 0 ||
		Object.keys(index.opclass).length > 0 ||
		Object.keys(index.collation).length > 0 ||
		Object.keys(index.options).length > 0 ||
		Object.keys(index.with).length > 0 ||
		index.nullsNotDistinct === true ||
		index.columns.length === 0
	);
}

function sameColumns(
	left: readonly string[],
	right: readonly string[],
): boolean {
	return stableJson(left) === stableJson(right);
}

function targetIndex(
	catalog: Pick<IndexCatalogValue, 'indexes'>,
	payload: CreateUniqueIndexConcurrentlyPayload,
): IndexSet | undefined {
	return catalog.indexes.find((index) => index.name === payload.index);
}

function validEquivalentExists(
	catalog: Pick<IndexCatalogValue, 'indexes'>,
	payload: CreateUniqueIndexConcurrentlyPayload,
): boolean {
	return catalog.indexes.some(
		(index) =>
			index.name !== payload.index &&
			index.valid &&
			index.ready &&
			!hasUnsupportedShape(index) &&
			sameColumns(index.columns, payload.columns),
	);
}

function normalizedIndexForDigest(
	payload: CreateUniqueIndexConcurrentlyPayload,
	index: IndexSet,
	phase: 'before' | 'after',
) {
	const oid =
		phase === 'after' && index.name === payload.index ? null : index.oid;
	return {
		name: index.name,
		oid,
		columns: index.columns,
		unique: index.unique,
		valid: index.valid,
		ready: index.ready,
		method: index.method,
		predicate: index.predicate,
		expressions: index.expressions,
		include: index.include,
		opclass: index.opclass,
		collation: index.collation,
		options: index.options,
		with: index.with,
		nullsNotDistinct: index.nullsNotDistinct,
	};
}

function syntheticTargetIndex(
	payload: CreateUniqueIndexConcurrentlyPayload,
): IndexSet {
	return {
		name: payload.index,
		oid: null,
		columns: payload.columns,
		unique: true,
		valid: true,
		ready: true,
		method: 'btree',
		predicate: null,
		expressions: [],
		include: [],
		opclass: {},
		collation: {},
		options: {},
		with: {},
		nullsNotDistinct: false,
	};
}

function targetPrivilegeFacts(
	payload: CreateUniqueIndexConcurrentlyPayload,
	context: ObservationContext,
) {
	return [
		fact(
			`context.privilege.${PG_SCHEMA_USAGE_PRIVILEGE}`,
			pgPrivilegeValue(context, PG_SCHEMA_USAGE_PRIVILEGE, [payload.schema]),
		),
		fact(
			`context.privilege.${PG_TABLE_ALTER_AUTHORITY_PRIVILEGE}`,
			pgPrivilegeValue(context, PG_TABLE_ALTER_AUTHORITY_PRIVILEGE, [
				payload.schema,
				payload.table,
			]),
		),
	];
}

function fingerprintForBefore(
	payload: CreateUniqueIndexConcurrentlyPayload,
	context: ObservationContext,
	catalog: IndexCatalogValue,
): FingerprintManifest {
	if (!catalog.exists || catalog.oid == null) {
		throw new Error('table catalog identity is missing');
	}
	if (catalog.schema !== payload.schema || catalog.table !== payload.table) {
		throw new Error('table index catalog identity does not target the payload');
	}
	if (catalog.relkind !== 'r') {
		throw new Error(
			'CreateUniqueIndexConcurrently only supports ordinary tables',
		);
	}
	if (catalog.targetIndexNameExists || targetIndex(catalog, payload)) {
		throw new Error('target index name is already present');
	}
	if (validEquivalentExists(catalog, payload)) {
		throw new Error(
			'a valid structurally equivalent unique index already exists',
		);
	}
	const normalizedIndexes = catalog.indexes.map((index) =>
		normalizedIndexForDigest(payload, index, 'before'),
	);
	const includedFacts = [
		fact('target.schema', payload.schema),
		fact('target.table', payload.table),
		fact('target.index', payload.index),
		fact('target.columns', payload.columns),
		fact('pg_class.oid', catalog.oid),
		fact('pg_class.relkind', catalog.relkind),
		fact('target.index.name.absent', !catalog.targetIndexNameExists),
		fact(
			'target.valid-equivalent.absent',
			!validEquivalentExists(catalog, payload),
		),
		fact('table.indexes.sorted', normalizedIndexes),
		fact('context.engine', context.engine),
		fact('context.engineVersion', context.engineVersion),
		fact('context.databaseId', context.databaseId),
		fact('context.effectiveRole', context.effectiveRole ?? null),
		fact(
			`context.capability.${CREATE_UNIQUE_INDEX_CONCURRENTLY_CAPABILITY}.available`,
			context.capabilities.includes(
				CREATE_UNIQUE_INDEX_CONCURRENTLY_CAPABILITY,
			),
		),
		...targetPrivilegeFacts(payload, context),
	];
	return {
		algorithm: 'sha256:stable-json',
		semanticModel: PG_OPERATION_PACK_ARTIFACT,
		includedFacts,
		excludedOrUnknownFacts: [],
		digest: digest(includedFacts),
	};
}

function fingerprintForAfter(
	payload: CreateUniqueIndexConcurrentlyPayload,
	context: ObservationContext,
	catalog: TargetIndexCatalogValue,
): FingerprintManifest {
	if (!catalog.tableExists || catalog.tableOid == null) {
		throw new Error('table catalog identity is missing after index creation');
	}
	if (catalog.schema !== payload.schema || catalog.table !== payload.table) {
		throw new Error(
			'target index catalog identity does not target the payload',
		);
	}
	if (catalog.relkind !== 'r') {
		throw new Error(
			'CreateUniqueIndexConcurrently only supports ordinary tables',
		);
	}
	const index = catalog.index;
	if (!index || index.name !== payload.index) {
		throw new Error('target index is missing after creation');
	}
	if (
		hasUnsupportedShape(index) ||
		!index.valid ||
		!index.ready ||
		!sameColumns(index.columns, payload.columns)
	) {
		throw new Error('target index is not a valid ready matching unique index');
	}
	const normalizedIndex = normalizedIndexForDigest(payload, index, 'after');
	const includedFacts = [
		fact('target.schema', payload.schema),
		fact('target.table', payload.table),
		fact('target.index', payload.index),
		fact('target.columns', payload.columns),
		fact('pg_class.oid', catalog.tableOid),
		fact('pg_class.relkind', catalog.relkind),
		fact(`pg_index.${payload.index}.indisunique`, true),
		fact(`pg_index.${payload.index}.indisvalid`, index.valid),
		fact(`pg_index.${payload.index}.indisready`, index.ready),
		fact('target.index.shape', normalizedIndex),
		fact('context.engine', context.engine),
		fact('context.engineVersion', context.engineVersion),
		fact('context.databaseId', context.databaseId),
		fact('context.effectiveRole', context.effectiveRole ?? null),
		fact(
			`context.capability.${CREATE_UNIQUE_INDEX_CONCURRENTLY_CAPABILITY}.available`,
			context.capabilities.includes(
				CREATE_UNIQUE_INDEX_CONCURRENTLY_CAPABILITY,
			),
		),
		...targetPrivilegeFacts(payload, context),
	];
	return {
		algorithm: 'sha256:stable-json',
		semanticModel: PG_OPERATION_PACK_ARTIFACT,
		includedFacts,
		excludedOrUnknownFacts: [
			{
				key: `pg_class.${payload.index}.oid.actual`,
				reason:
					'the target index OID is allocated by PostgreSQL during CREATE INDEX CONCURRENTLY; the digest binds the index by schema, table, name, validity and shape instead',
			},
		],
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
		throw new Error('missing table index catalog evidence');
	}
	return {
		expectedBefore: fingerprintForBefore(payload, context, catalog),
		expectedAfter: fingerprintForAfter(payload, context, {
			tableExists: catalog.exists,
			tableOid: catalog.oid,
			relkind: catalog.relkind,
			schema: catalog.schema,
			table: catalog.table,
			index: syntheticTargetIndex(payload),
		}),
	};
}

function observedFingerprint(
	operation: PhysicalOperation,
	observation: IssuedObservation,
	context: ObservationContext,
): FingerprintManifest {
	if (observation.role !== 'evidence') {
		throw new Error('table index catalog observation must be durable evidence');
	}
	const payload = payloadOf(operation);
	const catalog = catalogValueFromEvidence([observation], payload, context);
	if (!catalog) {
		throw new Error('table index catalog observation did not include indexes');
	}
	return fingerprintForBefore(payload, context, catalog);
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
		return DEFAULT_LOCK_TIMEOUT_MS;
	}
	return Math.max(1, Math.min(Math.trunc(maxWaitMs), 600_000));
}

function guardTargetsPayload(
	guard: ApplyGuard,
	payload: CreateUniqueIndexConcurrentlyPayload,
	context: ObservationContext,
): boolean {
	if (guard.predicate.kind !== NO_DUPLICATES_FOR_UNIQUE_INDEX_BUILD_GUARD) {
		return false;
	}
	if (!isRecord(guard.predicate.detail)) {
		return false;
	}
	return (
		guard.predicate.detail.schema === payload.schema &&
		guard.predicate.detail.table === payload.table &&
		guard.predicate.detail.index === payload.index &&
		stableJson(guard.predicate.detail.columns) ===
			stableJson(payload.columns) &&
		sameIndexResource(guard.predicate.target, payload, context) &&
		guard.predicate.scope.some((resource) =>
			sameIndexResource(resource, payload, context),
		)
	);
}

function engineGuardFor(
	payload: CreateUniqueIndexConcurrentlyPayload,
	duringGuards: readonly ApplyGuard[],
	context: ObservationContext,
): ApplyGuard {
	const guard = duringGuards.find((candidate) =>
		guardTargetsPayload(candidate, payload, context),
	);
	if (guard?.protocol.kind !== 'engine-validated') {
		throw new Error(
			'CreateUniqueIndexConcurrently requires a matching during-operation engine-validated guard',
		);
	}
	return guard;
}

function isUniqueBuildFailure(error: unknown): boolean {
	return (
		isRecord(error) &&
		(error.code === '23505' ||
			(typeof error.message === 'string' &&
				/duplicate key value|could not create unique index/iu.test(
					error.message,
				)))
	);
}

async function readTargetIndexCatalogValue(
	executor: Queryable,
	payload: CreateUniqueIndexConcurrentlyPayload,
): Promise<TargetIndexCatalogValue> {
	const result = await executor.query(
		`SELECT
		   t.oid::text AS table_oid,
		   t.relkind AS relkind,
		   n.nspname AS schema_name,
		   t.relname AS table_name,
		   i.oid::text AS index_oid,
		   i.relname AS index_name,
		   ix.indisunique AS indisunique,
		   ix.indisvalid AS indisvalid,
		   ix.indisready AS indisready,
		   COALESCE((to_jsonb(ix) ->> 'indnullsnotdistinct')::boolean, false) AS nulls_not_distinct,
		   am.amname AS method,
		   pg_catalog.pg_get_expr(ix.indpred, ix.indrelid, false) AS predicate,
		   pg_catalog.pg_get_expr(ix.indexprs, ix.indrelid, false) AS expressions_text,
		   i.reloptions AS reloptions,
		   COALESCE((
		     SELECT jsonb_agg(a.attname ORDER BY k.n)
		     FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, n)
		     JOIN pg_catalog.pg_attribute a
		       ON a.attrelid = t.oid AND a.attnum = k.attnum
		     WHERE k.n <= ix.indnkeyatts AND k.attnum != 0
		   ), '[]'::jsonb) AS columns,
		   COALESCE((
		     SELECT jsonb_agg(a.attname ORDER BY k.n)
		     FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, n)
		     JOIN pg_catalog.pg_attribute a
		       ON a.attrelid = t.oid AND a.attnum = k.attnum
		     WHERE k.n > ix.indnkeyatts
		   ), '[]'::jsonb) AS include_columns,
		   COALESCE((
		     SELECT jsonb_agg(a.attname ORDER BY k.n)
		     FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, n)
		     JOIN pg_catalog.pg_attribute a
		       ON a.attrelid = t.oid AND a.attnum = k.attnum
		     JOIN pg_catalog.pg_opclass oc
		       ON oc.oid = (ix.indclass::oid[])[k.n - 1]
		     WHERE k.n <= ix.indnkeyatts AND k.attnum != 0
		       AND NOT oc.opcdefault
		   ), '[]'::jsonb) AS opclass_cols,
		   COALESCE((
		     SELECT jsonb_agg(oc.opcname ORDER BY k.n)
		     FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, n)
		     JOIN pg_catalog.pg_opclass oc
		       ON oc.oid = (ix.indclass::oid[])[k.n - 1]
		     WHERE k.n <= ix.indnkeyatts AND k.attnum != 0
		       AND NOT oc.opcdefault
		   ), '[]'::jsonb) AS opclass_names
		   ,
		   COALESCE((
		     SELECT jsonb_agg(a.attname ORDER BY k.n)
		     FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, n)
		     JOIN pg_catalog.pg_attribute a
		       ON a.attrelid = t.oid AND a.attnum = k.attnum
		     JOIN pg_catalog.pg_collation coll
		       ON coll.oid = (ix.indcollation::oid[])[k.n - 1]
		     WHERE k.n <= ix.indnkeyatts AND k.attnum != 0
		       AND coll.oid <> 0::oid
		       AND coll.oid <> a.attcollation
		   ), '[]'::jsonb) AS collation_cols,
		   COALESCE((
		     SELECT jsonb_agg((collns.nspname || '.' || coll.collname) ORDER BY k.n)
		     FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, n)
		     JOIN pg_catalog.pg_attribute a
		       ON a.attrelid = t.oid AND a.attnum = k.attnum
		     JOIN pg_catalog.pg_collation coll
		       ON coll.oid = (ix.indcollation::oid[])[k.n - 1]
		     JOIN pg_catalog.pg_namespace collns ON collns.oid = coll.collnamespace
		     WHERE k.n <= ix.indnkeyatts AND k.attnum != 0
		       AND coll.oid <> 0::oid
		       AND coll.oid <> a.attcollation
		   ), '[]'::jsonb) AS collation_names,
		   COALESCE((
		     SELECT jsonb_agg(a.attname ORDER BY k.n)
		     FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, n)
		     JOIN pg_catalog.pg_attribute a
		       ON a.attrelid = t.oid AND a.attnum = k.attnum
		     WHERE k.n <= ix.indnkeyatts AND k.attnum != 0
		       AND ((ix.indoption::int2[])[k.n - 1])::int <> 0
		   ), '[]'::jsonb) AS option_cols,
		   COALESCE((
		     SELECT jsonb_agg(((ix.indoption::int2[])[k.n - 1])::int ORDER BY k.n)
		     FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, n)
		     JOIN pg_catalog.pg_attribute a
		       ON a.attrelid = t.oid AND a.attnum = k.attnum
		     WHERE k.n <= ix.indnkeyatts AND k.attnum != 0
		       AND ((ix.indoption::int2[])[k.n - 1])::int <> 0
		   ), '[]'::jsonb) AS option_values
		 FROM pg_catalog.pg_class t
		 JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
		 LEFT JOIN pg_catalog.pg_class i
		   ON i.relname = $3 AND i.relnamespace = n.oid AND i.relkind = 'i'
		 LEFT JOIN pg_catalog.pg_index ix
		   ON ix.indexrelid = i.oid AND ix.indrelid = t.oid
		 LEFT JOIN pg_catalog.pg_am am ON am.oid = i.relam
		 WHERE n.nspname = $1 AND t.relname = $2
		   AND t.relkind IN ('r', 'p')`,
		[payload.schema, payload.table, payload.index],
	);
	const row = result.rows[0];
	if (!row) {
		return {
			tableExists: false,
			tableOid: null,
			relkind: null,
			schema: null,
			table: null,
			index: null,
		};
	}
	const index =
		typeof row.index_name === 'string' ? normalizePgIndexCatalogRow(row) : null;
	return {
		tableExists: true,
		tableOid: stringOrNull(row.table_oid),
		relkind: stringOrNull(row.relkind),
		schema: stringOrNull(row.schema_name),
		table: stringOrNull(row.table_name),
		index,
	};
}

async function targetIndexAbsent(
	executor: Queryable,
	payload: CreateUniqueIndexConcurrentlyPayload,
): Promise<boolean> {
	const catalog = await readTargetIndexCatalogValue(executor, payload);
	return catalog.index == null;
}

function partialDetail(error: unknown): string {
	return error instanceof Error
		? error.message
		: 'invalid index cleanup could not be verified';
}

type InvalidIndexCleanupOutcome =
	| { readonly kind: 'none' }
	| { readonly kind: 'cleaned' }
	| { readonly kind: 'inspection-failed'; readonly error: unknown }
	| { readonly kind: 'cleanup-failed'; readonly error: unknown }
	| { readonly kind: 'cleanup-unverified' };

async function cleanupInvalidTargetIndex(
	executor: Queryable,
	payload: CreateUniqueIndexConcurrentlyPayload,
): Promise<InvalidIndexCleanupOutcome> {
	let catalog: TargetIndexCatalogValue;
	try {
		catalog = await readTargetIndexCatalogValue(executor, payload);
	} catch (error) {
		return { kind: 'inspection-failed', error };
	}
	if (!catalog.index || (catalog.index.valid && catalog.index.ready)) {
		return { kind: 'none' };
	}
	try {
		await executor.query(renderDropIndexConcurrentlySql(payload));
		if (await targetIndexAbsent(executor, payload)) {
			return { kind: 'cleaned' };
		}
		return { kind: 'cleanup-unverified' };
	} catch (error) {
		return { kind: 'cleanup-failed', error };
	}
}

function cleanupPartialOutcome(
	payload: CreateUniqueIndexConcurrentlyPayload,
	context: ObservationContext,
	cleanup: Exclude<
		InvalidIndexCleanupOutcome,
		{ readonly kind: 'none' | 'cleaned' }
	>,
) {
	return {
		kind: 'partially-applied' as const,
		recovery: [invalidIndexArtefact(payload, context)],
		detail:
			cleanup.kind === 'cleanup-unverified'
				? 'invalid index cleanup did not remove the target index'
				: partialDetail(cleanup.error),
	};
}

export function createCreateUniqueIndexConcurrentlyOperationRuntime() {
	return {
		artifact: PG_OPERATION_PACK_ARTIFACT,
		operationKind: CREATE_UNIQUE_INDEX_CONCURRENTLY_OPERATION_KIND,
		supportsOperation(operation: PhysicalOperation) {
			return (
				operation.operationKind.artifact.id === PG_OPERATION_PACK_ARTIFACT.id &&
				operation.operationKind.artifact.version ===
					PG_OPERATION_PACK_ARTIFACT.version &&
				operation.operationKind.name ===
					CREATE_UNIQUE_INDEX_CONCURRENTLY_OPERATION_KIND.name
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
						{ kind: 'table', schema: payload.schema, name: payload.table },
						{ kind: 'table-rows', within: tableResource(payload, context) },
						...payload.columns.map((column) => ({
							kind: 'column',
							name: column,
							within: tableResource(payload, context),
						})),
					],
					writes: [
						{
							kind: 'index',
							name: payload.index,
							within: tableResource(payload, context),
						},
					],
					locks: [],
					invalidates: [
						{
							proposition: TABLE_INDEXES_OBSERVATION,
							scope: {
								kind: 'table',
								schema: payload.schema,
								name: payload.table,
							},
						},
						{
							proposition: INDEX_ABSENT_OBSERVATION,
							scope: {
								kind: 'index',
								name: payload.index,
								within: tableResource(payload, context),
							},
						},
					],
					contextMutations: [
						{
							facet: 'session',
							key: 'lock_timeout',
							value: 'temporarily-set-and-reset-by-operation',
						},
					],
					externalEffects: {
						accountedFor: [
							{
								kind: 'index',
								name: payload.index,
								within: tableResource(payload, context),
							},
						],
						couldNotAccountFor: [],
					},
					execution: {
						transaction: 'forbids-transaction',
						commitBoundary: 'before-and-after',
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
		async begin(_client: TransitionExecutionClient) {
			throw new Error(
				'CreateUniqueIndexConcurrently forbids transaction blocks',
			);
		},
		async setLockTimeout(
			_client: TransitionExecutionClient,
			_maxWaitMs: number,
		) {
			// CREATE INDEX CONCURRENTLY cannot run inside the applier transaction.
			// The operation wraps its autocommit statement in a session SET/RESET.
		},
		async acquireLocks() {
			// PostgreSQL owns the lock protocol for CREATE INDEX CONCURRENTLY.
		},
		async observeContext(
			client: TransitionExecutionClient,
			operation: PhysicalOperation,
			_proofContext: ObservationContext,
		) {
			const payload = payloadOf(operation);
			return readPgObservationContext(client.opaqueClient, payload.schema, {
				schema: payload.schema,
				table: payload.table,
				index: payload.index,
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
			if (phase === 'after') {
				const catalog = await readTargetIndexCatalogValue(
					clientQuery(client),
					payload,
				);
				return {
					observations: [],
					fingerprint: fingerprintForAfter(payload, context, catalog),
				};
			}
			const request: ObservationRequest = {
				kind: TABLE_INDEXES_OBSERVATION,
				scope: [tableResource(payload, context)],
				detail: {
					schema: payload.schema,
					table: payload.table,
					index: payload.index,
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
			_client: TransitionExecutionClient,
			_operation: PhysicalOperation,
			guard: ApplyGuard,
		) {
			throw new Error(
				`CreateUniqueIndexConcurrently guard ${guard.predicate.kind} is engine-validated during execution`,
			);
		},
		async executeOperation(
			client: TransitionExecutionClient,
			operation: PhysicalOperation,
			context: ObservationContext,
			duringGuards: readonly ApplyGuard[] = [],
		) {
			const payload = payloadOf(operation);
			const guard = engineGuardFor(payload, duringGuards, context);
			const executor = clientQuery(client);
			await executor.query(
				`SET lock_timeout = '${boundedLockTimeout(DEFAULT_LOCK_TIMEOUT_MS)}ms'`,
			);
			try {
				await executor.query(renderCreateUniqueIndexConcurrentlySql(payload));
				return { kind: 'completed' };
			} catch (error) {
				const cleanup = await cleanupInvalidTargetIndex(executor, payload);
				if (
					cleanup.kind === 'inspection-failed' ||
					cleanup.kind === 'cleanup-failed' ||
					cleanup.kind === 'cleanup-unverified'
				) {
					return cleanupPartialOutcome(payload, context, cleanup);
				}
				if (!isUniqueBuildFailure(error)) {
					throw error;
				}
				return {
					kind: 'guard-failed',
					guard,
					recovery: [],
					nonRollbackableFootprint: 'none',
				};
			} finally {
				await executor
					.query('SET lock_timeout = DEFAULT')
					.catch(() => undefined);
			}
		},
		async writeCompletionJournal(
			client: TransitionExecutionClient,
			operation: PhysicalOperation,
			record: TransactionalCompletionRecord,
		) {
			await appendCompletionJournal(clientQuery(client), operation, record);
		},
		async commit(_client: TransitionExecutionClient) {
			throw new Error(
				'CreateUniqueIndexConcurrently forbids transaction blocks',
			);
		},
		async rollback(_client: TransitionExecutionClient) {
			throw new Error(
				'CreateUniqueIndexConcurrently forbids transaction blocks',
			);
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
