import type {
	EvidenceObservation,
	JsonValue,
	ObservationContext,
	ObservationIssuer,
	ObservationRequest,
	ObservationStability,
	ResourceAddress,
} from '@dbsp/types';
import {
	ALTER_AUTHORITY_OBSERVATION,
	COLUMN_EXISTS_OBSERVATION,
	ENGINE_VERSION_OBSERVATION,
	PG_INTROSPECTION_ARTIFACT,
} from './constants.js';
import { evidenceId } from './ids.js';

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

type ObservationTarget = {
	readonly table: string;
	readonly column: string;
	readonly schema?: string;
};

let observationSequence = 0;
const EXPLICIT_SCHEMA_CONTEXT_KEY = 'dbsp.transition.explicit_schema';

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function queryable(target: unknown): Queryable {
	if (isRecord(target) && typeof target.query === 'function') {
		return target as Queryable;
	}
	throw new Error(
		'PostgreSQL observation target must expose query(sql, params)',
	);
}

function poolLike(target: unknown): PoolLike | undefined {
	// A pg.Pool exposes connect() but not release(). A checked-out PoolClient also
	// inherits connect() but adds release() — calling connect() on it throws
	// "Client has already been connected". Treat anything with release() as an
	// already-connected client (a queryable), never a pool to connect() again.
	return isRecord(target) &&
		typeof target.connect === 'function' &&
		typeof target.release !== 'function'
		? (target as PoolLike)
		: undefined;
}

function nextEvidenceId(kind: string): ReturnType<typeof evidenceId> {
	observationSequence += 1;
	return evidenceId(
		`dbsp.postgresql.introspection.pg18:${kind}:${Date.now()}:${observationSequence}`,
	);
}

function explicitSchemaFromContext(
	context: ObservationContext,
): string | undefined {
	const value = context.sessionConfiguration[EXPLICIT_SCHEMA_CONTEXT_KEY];
	return value && value.length > 0 ? value : undefined;
}

function detailTarget(
	request: ObservationRequest,
	context: ObservationContext,
): ObservationTarget {
	if (!isRecord(request.detail)) {
		throw new Error(`${request.kind} requires table and column detail`);
	}
	const { table, column, schema } = request.detail;
	if (typeof table !== 'string' || typeof column !== 'string') {
		throw new Error(`${request.kind} requires table and column detail`);
	}
	if (schema != null && typeof schema !== 'string') {
		throw new Error(`${request.kind} schema detail must be a string`);
	}
	const resolvedSchema = schema ?? explicitSchemaFromContext(context);
	if (!resolvedSchema) {
		throw new Error(
			`${request.kind} requires explicit schema detail; unqualified transition observations cannot be resolved from search_path`,
		);
	}
	return { table, column, schema: resolvedSchema };
}

function requestForTarget(
	request: ObservationRequest,
	target: ObservationTarget,
	context: ObservationContext,
	kind: 'table' | 'column',
): ObservationRequest {
	return {
		kind: request.kind,
		scope: [scopeFor(target, context, kind)],
		detail: {
			table: target.table,
			column: target.column,
			schema: target.schema ?? null,
		},
	};
}

function scopeFor(
	target: ObservationTarget,
	context: ObservationContext,
	kind: 'table' | 'column',
): ResourceAddress {
	const base: ResourceAddress = {
		engine: 'postgresql',
		database: context.databaseId,
		kind,
		name: kind === 'table' ? target.table : target.column,
	};
	const qualified =
		kind === 'column' ? { ...base, qualifiedBy: [target.table] } : base;
	return target.schema ? { ...qualified, schema: target.schema } : qualified;
}

function evidenceObservation(params: {
	readonly request: ObservationRequest;
	readonly context: ObservationContext;
	readonly scope: readonly ResourceAddress[];
	readonly stability: ObservationStability;
	readonly source: EvidenceObservation['source'];
	readonly value: JsonValue;
}): EvidenceObservation {
	return {
		role: 'evidence',
		id: nextEvidenceId(params.request.kind),
		issuer: PG_INTROSPECTION_ARTIFACT,
		request: params.request,
		result: { value: params.value },
		context: params.context,
		stability:
			params.stability === 'historical-only'
				? 'externally-mutable'
				: params.stability,
		takenAt: new Date().toISOString(),
		scope: params.scope,
		source: params.source,
		validity: {
			invalidatedBy: ['external-ddl'],
		},
	};
}

async function observeColumn(
	executor: Queryable,
	request: ObservationRequest,
	context: ObservationContext,
): Promise<EvidenceObservation> {
	const target = detailTarget(request, context);
	const normalizedRequest = requestForTarget(
		request,
		target,
		context,
		'column',
	);
	const result = await executor.query(
		'SELECT c.oid::text AS oid, a.attnum::int AS attnum, ' +
			'(NOT a.attnotnull) AS nullable ' +
			'FROM pg_catalog.pg_class c ' +
			'JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace ' +
			'JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid ' +
			'WHERE n.nspname = $1 AND c.relname = $2 AND a.attname = $3 ' +
			"AND c.relkind IN ('r', 'p') AND NOT a.attisdropped",
		[target.schema, target.table, target.column],
	);
	const row = result.rows[0];
	const exists = row != null;
	const value = {
		exists,
		nullable: exists ? row.nullable === true : null,
		oid: exists && typeof row.oid === 'string' ? row.oid : null,
		attnum: exists && typeof row.attnum === 'number' ? row.attnum : null,
		claims: [{ kind: COLUMN_EXISTS_OBSERVATION, holds: exists }],
	};
	return evidenceObservation({
		request: normalizedRequest,
		context,
		scope: [scopeFor(target, context, 'column')],
		stability: 'externally-mutable',
		source: 'system-catalog',
		value,
	});
}

async function observeAlterAuthority(
	executor: Queryable,
	request: ObservationRequest,
	context: ObservationContext,
): Promise<EvidenceObservation> {
	const target = detailTarget(request, context);
	const normalizedRequest = requestForTarget(request, target, context, 'table');
	const result = await executor.query(
		// USAGE reflects privileges available to the effective role without SET ROLE;
		// MEMBER alone is too broad for ALTER ownership checks under NOINHERIT.
		"SELECT pg_catalog.pg_has_role(c.relowner, 'USAGE') AS has_table_alter_authority, " +
			"pg_catalog.has_schema_privilege(n.oid, 'USAGE') AS has_schema_usage " +
			'FROM pg_catalog.pg_class c ' +
			'JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace ' +
			'WHERE n.nspname = $1 AND c.relname = $2 ' +
			"AND c.relkind IN ('r', 'p')",
		[target.schema, target.table],
	);
	const row = result.rows[0];
	const hasTableAlterAuthority = row?.has_table_alter_authority === true;
	const hasSchemaUsage = row?.has_schema_usage === true;
	const hasAlterAuthority = hasTableAlterAuthority && hasSchemaUsage;
	const value = {
		hasAlterAuthority,
		hasTableAlterAuthority,
		hasSchemaUsage,
		claims: [{ kind: ALTER_AUTHORITY_OBSERVATION, holds: hasAlterAuthority }],
	};
	return evidenceObservation({
		request: normalizedRequest,
		context,
		scope: [scopeFor(target, context, 'table')],
		stability: 'session-bound',
		source: 'privilege-probe',
		value,
	});
}

async function observeEngineVersion(
	executor: Queryable,
	request: ObservationRequest,
	context: ObservationContext,
): Promise<EvidenceObservation> {
	const result = await executor.query('SHOW server_version_num');
	const raw = result.rows[0]?.server_version_num;
	const versionNum = typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN;
	if (
		!isRecord(request.detail) ||
		typeof request.detail.minServerVersionNum !== 'number'
	) {
		throw new Error(`${request.kind} requires minServerVersionNum detail`);
	}
	const minServerVersionNum = request.detail.minServerVersionNum;
	const supported =
		Number.isFinite(versionNum) && versionNum >= minServerVersionNum;
	const normalizedScope = request.scope.map((resource) => ({
		...resource,
		database: context.databaseId,
	}));
	const normalizedRequest: ObservationRequest = {
		kind: request.kind,
		scope: normalizedScope,
		detail: { minServerVersionNum },
	};
	const value = {
		serverVersionNum: Number.isFinite(versionNum) ? versionNum : null,
		minServerVersionNum,
		supported,
		claims: [{ kind: ENGINE_VERSION_OBSERVATION, holds: supported }],
	};
	return evidenceObservation({
		request: normalizedRequest,
		context,
		scope: normalizedScope,
		stability: 'connection-constant',
		source: 'configuration-probe',
		value,
	});
}

export function createPgObservationIssuer(): ObservationIssuer {
	return {
		artifact: PG_INTROSPECTION_ARTIFACT,
		async readContext(target, context) {
			return readPgObservationContext(
				target,
				explicitSchemaFromContext(context),
			);
		},
		async execute(request, target, context) {
			const executor = queryable(target);
			switch (request.kind) {
				case COLUMN_EXISTS_OBSERVATION:
					return observeColumn(executor, request, context);
				case ALTER_AUTHORITY_OBSERVATION:
					return observeAlterAuthority(executor, request, context);
				case ENGINE_VERSION_OBSERVATION:
					return observeEngineVersion(executor, request, context);
				default:
					throw new Error(`unsupported PostgreSQL observation ${request.kind}`);
			}
		},
	};
}

export async function readPgObservationContext(
	target: unknown,
	schema?: string,
): Promise<ObservationContext> {
	const pool = poolLike(target);
	if (pool) {
		const client = await pool.connect();
		try {
			return await readPgObservationContextFromClient(client, schema);
		} finally {
			client.release();
		}
	}
	return readPgObservationContextFromClient(queryable(target), schema);
}

async function readPgObservationContextFromClient(
	executor: Queryable,
	schema?: string,
): Promise<ObservationContext> {
	const version = await executor.query('SHOW server_version_num');
	const database = await executor.query(
		'SELECT current_database() AS database_id',
	);
	const role = await executor.query('SELECT current_user AS current_user');
	const resolvedSearchPath = await executor.query(
		'SELECT pg_catalog.to_json(pg_catalog.current_schemas(false)) AS search_path',
	);
	const searchPathSetting = await executor.query('SHOW search_path');
	const resolved = resolvedSearchPath.rows[0]?.search_path;
	const actualSearchPath = Array.isArray(resolved)
		? resolved.filter((item): item is string => typeof item === 'string')
		: [];
	const configuredSearchPath = schema != null ? [schema] : actualSearchPath;
	return {
		engine: 'postgresql',
		engineVersion: String(version.rows[0]?.server_version_num ?? 'unknown'),
		databaseId: String(database.rows[0]?.database_id ?? 'unknown'),
		capabilities: ['alter-column-set-not-null'],
		privileges: [],
		effectiveRole: String(role.rows[0]?.current_user ?? 'unknown'),
		searchPath:
			configuredSearchPath.length > 0 ? configuredSearchPath : ['public'],
		sessionConfiguration: {
			search_path: String(searchPathSetting.rows[0]?.search_path ?? ''),
			actual_search_path: JSON.stringify(actualSearchPath),
			...(schema != null ? { [EXPLICIT_SCHEMA_CONTEXT_KEY]: schema } : {}),
		},
		extensions: {},
	};
}
