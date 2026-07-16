import type {
	EvidenceObservation,
	JsonValue,
	ObservationContext,
	ObservationIssuer,
	ObservationRequest,
	ObservationStability,
	ResourceAddress,
} from '@dbsp/types';
import { formatSqlDefault, quoteIdent } from '../ddl/phases/utils.js';
import {
	ALTER_AUTHORITY_OBSERVATION,
	COLUMN_EXISTS_OBSERVATION,
	ENGINE_VERSION_OBSERVATION,
	EXPRESSION_DEPARSE_OBSERVATION,
	PG_INTROSPECTION_ARTIFACT,
	PG_SCHEMA_USAGE_PRIVILEGE,
	PG_SET_NOT_NULL_AUTHORITY_PRIVILEGE,
	PG_TABLE_ALTER_AUTHORITY_PRIVILEGE,
	SET_NOT_NULL_RELATION_KIND_SUPPORTED_OBSERVATION,
} from './constants.js';
import { evidenceId } from './ids.js';
import { pgPrivilegeFact } from './privileges.js';

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

type AlterAuthorityFacts = {
	readonly hasAlterAuthority: boolean;
	readonly hasTableAlterAuthority: boolean;
	readonly hasSchemaUsage: boolean;
};

type PortableExpressionDetail = {
	readonly kind: 'portable';
	readonly ast: JsonValue;
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
	const targetSchema = (context as { readonly targetSchema?: string })
		.targetSchema;
	if (targetSchema && targetSchema.length > 0) {
		return targetSchema;
	}
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

function resolvedTarget(
	target: ObservationTarget,
): ObservationTarget & { readonly schema: string } {
	if (!target.schema) {
		throw new Error('PostgreSQL transition observation target lost schema');
	}
	return { table: target.table, column: target.column, schema: target.schema };
}

function targetFromRequests(
	requests: readonly ObservationRequest[] | undefined,
	context: ObservationContext,
): ObservationTarget | undefined {
	for (const request of requests ?? []) {
		if (!isRecord(request.detail)) {
			continue;
		}
		if (
			typeof request.detail.table !== 'string' ||
			typeof request.detail.column !== 'string'
		) {
			continue;
		}
		return detailTarget(request, context);
	}
	return undefined;
}

async function readAlterAuthorityFacts(
	executor: Queryable,
	target: ObservationTarget & { readonly schema: string },
): Promise<AlterAuthorityFacts> {
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
	return {
		hasAlterAuthority: hasTableAlterAuthority && hasSchemaUsage,
		hasTableAlterAuthority,
		hasSchemaUsage,
	};
}

function privilegeFactsForTarget(
	target: ObservationTarget & { readonly schema: string },
	facts: AlterAuthorityFacts,
): readonly string[] {
	return [
		pgPrivilegeFact(
			PG_SCHEMA_USAGE_PRIVILEGE,
			[target.schema],
			facts.hasSchemaUsage,
		),
		pgPrivilegeFact(
			PG_TABLE_ALTER_AUTHORITY_PRIVILEGE,
			[target.schema, target.table],
			facts.hasTableAlterAuthority,
		),
		pgPrivilegeFact(
			PG_SET_NOT_NULL_AUTHORITY_PRIVILEGE,
			[target.schema, target.table, target.column],
			facts.hasAlterAuthority,
		),
	];
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
			...(isRecord(request.detail)
				? Object.fromEntries(
						Object.entries(request.detail).filter(
							([key]) => !['schema', 'table', 'column'].includes(key),
						),
					)
				: {}),
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

function stringOrNull(value: unknown): string | null {
	return typeof value === 'string' ? value : null;
}

function numberOrNull(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function identityFromAttidentity(
	value: unknown,
): 'always' | 'byDefault' | null {
	if (value === 'a') {
		return 'always';
	}
	if (value === 'd') {
		return 'byDefault';
	}
	return null;
}

function portableExpressionFromRequest(
	request: ObservationRequest,
): PortableExpressionDetail | undefined {
	if (!isRecord(request.detail)) {
		return undefined;
	}
	const left = request.detail.left;
	const right = request.detail.right;
	if (isRecord(left) && left.kind === 'portable') {
		return left as unknown as PortableExpressionDetail;
	}
	if (isRecord(right) && right.kind === 'portable') {
		return right as unknown as PortableExpressionDetail;
	}
	return undefined;
}

function renderPortableDefaultSql(value: PortableExpressionDetail): string {
	const ast = value.ast;
	if (
		ast === null ||
		typeof ast === 'string' ||
		typeof ast === 'number' ||
		typeof ast === 'boolean'
	) {
		return formatSqlDefault(ast, 'transition column default deparse');
	}
	throw new Error(
		'column-default deparse only supports pack-rendered scalar portable defaults; structured default ASTs remain unknown until a default renderer is added',
	);
}

function canonicalDefaultQuery() {
	return (
		'SELECT pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) AS default_expression ' +
		'FROM pg_catalog.pg_class c ' +
		'JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace ' +
		'JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid ' +
		'JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum ' +
		'WHERE n.nspname = $1 AND c.relname = $2 AND a.attname = $3 ' +
		'AND NOT a.attisdropped'
	);
}

async function readCatalogDefaultCanonical(
	executor: Queryable,
	target: ObservationTarget & { readonly schema: string },
): Promise<string> {
	const result = await executor.query(canonicalDefaultQuery(), [
		target.schema,
		target.table,
		target.column,
	]);
	const expression = result.rows[0]?.default_expression;
	if (typeof expression !== 'string') {
		throw new Error('column-default deparse could not read catalog default');
	}
	return expression;
}

async function readTempDefaultCanonical(
	executor: Queryable,
	tempTable: string,
	column: string,
): Promise<string> {
	const result = await executor.query(
		'SELECT pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) AS default_expression ' +
			'FROM pg_catalog.pg_attrdef ad ' +
			'JOIN pg_catalog.pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum ' +
			'WHERE ad.adrelid = $1::pg_catalog.regclass AND a.attname = $2 ' +
			'AND NOT a.attisdropped',
		[tempTable, column],
	);
	const expression = result.rows[0]?.default_expression;
	if (typeof expression !== 'string') {
		throw new Error('column-default deparse could not read temp default');
	}
	return expression;
}

async function observeExpressionDeparse(
	executor: Queryable,
	request: ObservationRequest,
	context: ObservationContext,
): Promise<EvidenceObservation> {
	if (
		!isRecord(request.detail) ||
		request.detail.surface !== 'column-default' ||
		request.detail.category !== 'scalar'
	) {
		throw new Error(
			`${request.kind} requires surface=column-default and category=scalar`,
		);
	}
	const target = resolvedTarget(detailTarget(request, context));
	const normalizedRequest = requestForTarget(
		request,
		target,
		context,
		'column',
	);
	const portable = portableExpressionFromRequest(request);
	if (!portable) {
		throw new Error(
			'column-default deparse requires one portable expression side',
		);
	}
	const desiredSql = renderPortableDefaultSql(portable);
	const catalogCanonical = await readCatalogDefaultCanonical(executor, target);
	const tempTable = `_dbsp_default_deparse_${Date.now()}_${++observationSequence}`;
	const savepoint = `dbsp_default_deparse_sp_${observationSequence}`;
	let savepointActive = false;
	let startedTransaction = false;
	try {
		// Isolate the round-trip so it NEVER disturbs an outer transaction. At apply
		// this observation runs inside the applier's lock transaction, so a bare
		// BEGIN/ROLLBACK here would roll back the applier's DDL and lock. A SAVEPOINT
		// nests safely; it errors only when there is no transaction (pure prove-time
		// autocommit), in which case we open our own BEGIN/ROLLBACK. Either way the
		// temp table lives across CREATE / ALTER / read and is discarded afterwards.
		try {
			await executor.query(`SAVEPOINT ${quoteIdent(savepoint, 'table')}`);
			savepointActive = true;
		} catch {
			await executor.query('BEGIN');
			startedTransaction = true;
		}
		await executor.query(
			`CREATE TEMP TABLE ${quoteIdent(tempTable, 'table')} ` +
				`(LIKE ${quoteIdent(target.schema, 'schema')}.${quoteIdent(
					target.table,
					'table',
				)} INCLUDING DEFAULTS)`,
		);
		await executor.query(
			`ALTER TABLE ${quoteIdent(tempTable, 'table')} ` +
				`ALTER COLUMN ${quoteIdent(target.column, 'column')} ` +
				`SET DEFAULT ${desiredSql}`,
		);
		const desiredCanonical = await readTempDefaultCanonical(
			executor,
			tempTable,
			target.column,
		);
		return evidenceObservation({
			request: normalizedRequest,
			context,
			scope: [scopeFor(target, context, 'column')],
			stability: 'externally-mutable',
			source: 'vendor-deparser',
			value: {
				ok: true,
				surface: 'column-default',
				category: 'scalar',
				leftCanonical:
					(portable as unknown) ===
					(isRecord(request.detail.left) ? request.detail.left : undefined)
						? desiredCanonical
						: catalogCanonical,
				rightCanonical:
					(portable as unknown) ===
					(isRecord(request.detail.right) ? request.detail.right : undefined)
						? desiredCanonical
						: catalogCanonical,
				desiredCanonical,
				catalogCanonical,
			},
		});
	} finally {
		if (savepointActive) {
			await executor
				.query(`ROLLBACK TO SAVEPOINT ${quoteIdent(savepoint, 'table')}`)
				.catch(() => undefined);
			await executor
				.query(`RELEASE SAVEPOINT ${quoteIdent(savepoint, 'table')}`)
				.catch(() => undefined);
		} else if (startedTransaction) {
			await executor.query('ROLLBACK').catch(() => undefined);
		}
	}
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
		'SELECT c.oid::text AS oid, c.relkind AS relkind, a.attnum::int AS attnum, ' +
			'(NOT a.attnotnull) AS nullable, ' +
			'a.atttypid::text AS atttypid, a.atttypmod::int AS atttypmod, ' +
			'pg_catalog.format_type(a.atttypid, a.atttypmod) AS format_type, ' +
			't.typname AS type_name, tn.nspname AS type_schema, ' +
			'(ad.oid IS NOT NULL) AS has_default, ' +
			'pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) AS default_expression, ' +
			'a.attcollation::text AS attcollation, coll.collname AS collation_name, ' +
			'collns.nspname AS collation_schema, ' +
			"pg_catalog.to_jsonb(coll)->>'collprovider' AS collation_provider, " +
			"pg_catalog.to_jsonb(coll)->>'collversion' AS collation_version, " +
			"NULLIF(a.attidentity, '') AS attidentity, " +
			"NULLIF(a.attgenerated, '') AS attgenerated, " +
			'd.description AS comment, ' +
			'(uq.oid IS NOT NULL) AS unique, uq.conname AS unique_constraint_name, ' +
			'(owned_seq.seqrelid IS NOT NULL) AS auto_increment ' +
			'FROM pg_catalog.pg_class c ' +
			'JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace ' +
			'JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid ' +
			'JOIN pg_catalog.pg_type t ON t.oid = a.atttypid ' +
			'JOIN pg_catalog.pg_namespace tn ON tn.oid = t.typnamespace ' +
			'LEFT JOIN pg_catalog.pg_attrdef ad ' +
			'ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum ' +
			'LEFT JOIN pg_catalog.pg_collation coll ON coll.oid = a.attcollation ' +
			'LEFT JOIN pg_catalog.pg_namespace collns ON collns.oid = coll.collnamespace ' +
			'LEFT JOIN pg_catalog.pg_description d ' +
			'ON d.objoid = c.oid AND d.objsubid = a.attnum ' +
			'LEFT JOIN LATERAL ( ' +
			'SELECT con.oid, con.conname FROM pg_catalog.pg_constraint con ' +
			"WHERE con.contype = 'u' AND con.conrelid = c.oid " +
			'AND con.conparentid = 0 AND array_length(con.conkey, 1) = 1 ' +
			'AND con.conkey[1] = a.attnum ORDER BY con.conname LIMIT 1 ' +
			') uq ON true ' +
			'LEFT JOIN LATERAL ( ' +
			'SELECT dep.objid AS seqrelid FROM pg_catalog.pg_depend dep ' +
			'JOIN pg_catalog.pg_class seq ON seq.oid = dep.objid ' +
			"AND seq.relkind = 'S' " +
			'WHERE dep.refobjid = c.oid AND dep.refobjsubid = a.attnum ' +
			"AND dep.deptype IN ('a', 'i') LIMIT 1 " +
			') owned_seq ON true ' +
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
		relkind: exists ? stringOrNull(row.relkind) : null,
		attnum: exists && typeof row.attnum === 'number' ? row.attnum : null,
		atttypid: exists ? stringOrNull(row.atttypid) : null,
		atttypmod: exists ? numberOrNull(row.atttypmod) : null,
		formatType: exists ? stringOrNull(row.format_type) : null,
		typeName: exists ? stringOrNull(row.type_name) : null,
		typeSchema: exists ? stringOrNull(row.type_schema) : null,
		hasDefault: exists ? row.has_default === true : null,
		defaultExpression: exists ? stringOrNull(row.default_expression) : null,
		attcollation: exists ? stringOrNull(row.attcollation) : null,
		collationName: exists ? stringOrNull(row.collation_name) : null,
		collationSchema: exists ? stringOrNull(row.collation_schema) : null,
		collationProvider: exists ? stringOrNull(row.collation_provider) : null,
		collationVersion: exists ? stringOrNull(row.collation_version) : null,
		attidentity: exists ? stringOrNull(row.attidentity) : null,
		identity: exists ? identityFromAttidentity(row.attidentity) : null,
		attgenerated: exists ? stringOrNull(row.attgenerated) : null,
		comment: exists ? stringOrNull(row.comment) : null,
		unique: exists ? row.unique === true : null,
		uniqueConstraintName: exists
			? stringOrNull(row.unique_constraint_name)
			: null,
		autoIncrement: exists ? row.auto_increment === true : null,
		claims: [
			{ kind: COLUMN_EXISTS_OBSERVATION, holds: exists },
			{
				kind: SET_NOT_NULL_RELATION_KIND_SUPPORTED_OBSERVATION,
				holds: exists && row?.relkind === 'r',
			},
		],
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
	const resolved = resolvedTarget(target);
	const facts = await readAlterAuthorityFacts(executor, resolved);
	const value = {
		...facts,
		privileges: privilegeFactsForTarget(resolved, facts),
		claims: [
			{ kind: ALTER_AUTHORITY_OBSERVATION, holds: facts.hasAlterAuthority },
		],
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
		async readContext(target, context, requests) {
			return readPgObservationContext(
				target,
				explicitSchemaFromContext(context),
				targetFromRequests(requests, context),
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
				case EXPRESSION_DEPARSE_OBSERVATION: {
					// The deparse round-trip creates a session-scoped TEMP TABLE and then
					// ALTERs/reads it across several statements. On a pool each query
					// would run on a different connection, so the temp table would vanish
					// between statements. Run the whole round-trip on ONE checked-out
					// client (mirroring readPgObservationContext); a pre-checked-out
					// client is already session-scoped and used directly.
					const deparsePool = poolLike(target);
					if (deparsePool) {
						const client = await deparsePool.connect();
						try {
							return await observeExpressionDeparse(client, request, context);
						} finally {
							client.release();
						}
					}
					return observeExpressionDeparse(executor, request, context);
				}
				default:
					throw new Error(`unsupported PostgreSQL observation ${request.kind}`);
			}
		},
	};
}

export async function readPgObservationContext(
	target: unknown,
	schema?: string,
	observationTarget?: ObservationTarget,
): Promise<ObservationContext> {
	const pool = poolLike(target);
	if (pool) {
		const client = await pool.connect();
		try {
			return await readPgObservationContextFromClient(
				client,
				schema,
				observationTarget,
			);
		} finally {
			client.release();
		}
	}
	return readPgObservationContextFromClient(
		queryable(target),
		schema,
		observationTarget,
	);
}

async function readPgObservationContextFromClient(
	executor: Queryable,
	schema?: string,
	observationTarget?: ObservationTarget,
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
	const extensions = await executor.query(
		'SELECT extname AS name, extversion AS version FROM pg_catalog.pg_extension ORDER BY extname',
	);
	const databaseCollation = await executor.query(
		"SELECT pg_catalog.to_jsonb(d)->>'datlocprovider' AS collation_provider, " +
			"pg_catalog.to_jsonb(d)->>'datcollversion' AS collation_version " +
			'FROM pg_catalog.pg_database d ' +
			'WHERE d.datname = pg_catalog.current_database()',
	);
	const resolved = resolvedSearchPath.rows[0]?.search_path;
	const actualSearchPath = Array.isArray(resolved)
		? resolved.filter((item): item is string => typeof item === 'string')
		: [];
	const configuredSearchPath = schema != null ? [schema] : actualSearchPath;
	const databaseId = String(database.rows[0]?.database_id ?? 'unknown');
	const extensionMap = Object.fromEntries(
		extensions.rows.flatMap((row) =>
			typeof row.name === 'string' && typeof row.version === 'string'
				? [[row.name, row.version]]
				: [],
		),
	);
	const resolvedObservationTarget = observationTarget?.schema
		? { ...observationTarget, schema: observationTarget.schema }
		: observationTarget && schema
			? { ...observationTarget, schema }
			: undefined;
	const targetSchema = resolvedObservationTarget?.schema ?? schema;
	const privilegeFacts = resolvedObservationTarget
		? privilegeFactsForTarget(
				resolvedObservationTarget,
				await readAlterAuthorityFacts(executor, resolvedObservationTarget),
			)
		: [];
	const collationRow = databaseCollation.rows[0];
	const collationProvider = stringOrNull(collationRow?.collation_provider);
	const collationVersion = stringOrNull(collationRow?.collation_version);
	return {
		engine: 'postgresql',
		engineVersion: String(version.rows[0]?.server_version_num ?? 'unknown'),
		databaseId,
		capabilities: [],
		privileges: privilegeFacts,
		effectiveRole: String(role.rows[0]?.current_user ?? 'unknown'),
		...(targetSchema ? { targetSchema } : {}),
		searchPath:
			configuredSearchPath.length > 0 ? configuredSearchPath : ['public'],
		sessionConfiguration: {
			search_path: String(searchPathSetting.rows[0]?.search_path ?? ''),
			actual_search_path: JSON.stringify(actualSearchPath),
			...(schema != null ? { [EXPLICIT_SCHEMA_CONTEXT_KEY]: schema } : {}),
		},
		extensions: extensionMap,
		...(collationProvider ? { collationProvider } : {}),
		...(collationVersion ? { collationVersion } : {}),
	};
}
