import type {
	EvidenceObservation,
	JsonValue,
	ObservationContext,
	ObservationIssuer,
	ObservationRequest,
	ObservationStability,
	ResourceAddress,
	VendorValidatedExpression,
} from '@dbsp/types';
import {
	renderCheckConstraintClause,
	splitCheckConstraintState,
} from '../check-expression.js';
import { formatSqlDefault, quoteIdent } from '../ddl/phases/utils.js';
import { validateCheckExpression } from '../validate.js';
import {
	ALTER_AUTHORITY_OBSERVATION,
	ALTER_TYPE_AUTHORITY_OBSERVATION,
	CHECK_CONSTRAINT_ABSENT_OBSERVATION,
	COLUMN_EXISTS_OBSERVATION,
	DBSP_LOGICAL_IDENTITY_TABLE,
	DBSP_META_SCHEMA,
	ENGINE_VERSION_OBSERVATION,
	ENUM_LABEL_VISIBLE_OBSERVATION,
	ENUM_TYPE_EXISTS_OBSERVATION,
	EXPRESSION_DEPARSE_OBSERVATION,
	INDEX_ABSENT_OBSERVATION,
	LOGICAL_IDENTITY_CARRIER_OBSERVATION,
	PG_DEPARSE_ARTIFACT,
	PG_INTROSPECTION_ARTIFACT,
	PG_SCHEMA_USAGE_PRIVILEGE,
	PG_SET_NOT_NULL_AUTHORITY_PRIVILEGE,
	PG_TABLE_ALTER_AUTHORITY_PRIVILEGE,
	PG_TYPE_ALTER_AUTHORITY_PRIVILEGE,
	SET_NOT_NULL_RELATION_KIND_SUPPORTED_OBSERVATION,
	TABLE_CHECK_CONSTRAINTS_OBSERVATION,
	TABLE_INDEXES_OBSERVATION,
} from './constants.js';
import { evidenceId } from './ids.js';
import { mergePgObservationPrivileges, pgPrivilegeFact } from './privileges.js';

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
	readonly column?: string;
	readonly constraint?: string;
	readonly index?: string;
	readonly schema?: string;
};

type EnumObservationTarget = {
	readonly type: string;
	readonly label?: string;
	readonly schema?: string;
};

type LogicalIdentityObservationTarget = {
	readonly schema: string;
	readonly table: string;
	readonly column?: string;
	readonly logicalId: string;
	readonly carrierKind: 'postgresql-side-table';
	readonly authenticated: false;
	readonly expected: 'adoptable' | 'attached';
};

type LogicalIdentityBinding = {
	readonly logicalId: string;
	readonly schema: string;
	readonly table: string;
	readonly column: string | null;
	readonly carrierKind: string;
};

type AlterAuthorityFacts = {
	readonly hasAlterAuthority: boolean;
	readonly hasTableAlterAuthority: boolean;
	readonly hasTypeAlterAuthority?: boolean;
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
): ObservationTarget & { readonly column: string } {
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

function tableDetailTarget(
	request: ObservationRequest,
	context: ObservationContext,
): ObservationTarget & { readonly schema: string } {
	if (!isRecord(request.detail)) {
		throw new Error(`${request.kind} requires table detail`);
	}
	const { table, schema, constraint, index } = request.detail;
	if (typeof table !== 'string') {
		throw new Error(`${request.kind} requires table detail`);
	}
	if (schema != null && typeof schema !== 'string') {
		throw new Error(`${request.kind} schema detail must be a string`);
	}
	if (constraint != null && typeof constraint !== 'string') {
		throw new Error(`${request.kind} constraint detail must be a string`);
	}
	if (index != null && typeof index !== 'string') {
		throw new Error(`${request.kind} index detail must be a string`);
	}
	const resolvedSchema = schema ?? explicitSchemaFromContext(context);
	if (!resolvedSchema) {
		throw new Error(
			`${request.kind} requires explicit schema detail; unqualified transition observations cannot be resolved from search_path`,
		);
	}
	return {
		table,
		...(constraint != null ? { constraint } : {}),
		...(index != null ? { index } : {}),
		schema: resolvedSchema,
	};
}

function resolvedTarget(
	target: ObservationTarget,
): ObservationTarget & { readonly schema: string; readonly column: string } {
	if (!target.schema) {
		throw new Error('PostgreSQL transition observation target lost schema');
	}
	if (!target.column) {
		throw new Error('PostgreSQL column observation target lost column');
	}
	return { table: target.table, column: target.column, schema: target.schema };
}

function resolvedTableTarget(
	target: ObservationTarget,
): ObservationTarget & { readonly schema: string } {
	if (!target.schema) {
		throw new Error('PostgreSQL transition observation target lost schema');
	}
	return {
		table: target.table,
		...(target.column !== undefined ? { column: target.column } : {}),
		...(target.constraint !== undefined
			? { constraint: target.constraint }
			: {}),
		...(target.index !== undefined ? { index: target.index } : {}),
		schema: target.schema,
	};
}

function enumDetailTarget(
	request: ObservationRequest,
	context: ObservationContext,
): EnumObservationTarget & { readonly schema: string } {
	if (!isRecord(request.detail)) {
		throw new Error(`${request.kind} requires enum type detail`);
	}
	const { type, label, schema } = request.detail;
	if (typeof type !== 'string') {
		throw new Error(`${request.kind} requires enum type detail`);
	}
	if (
		request.kind === ENUM_LABEL_VISIBLE_OBSERVATION &&
		typeof label !== 'string'
	) {
		throw new Error(`${request.kind} requires enum label detail`);
	}
	if (label != null && typeof label !== 'string') {
		throw new Error(`${request.kind} label detail must be a string`);
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
	return label == null
		? { type, schema: resolvedSchema }
		: { type, label, schema: resolvedSchema };
}

function logicalIdentityDetailTarget(
	request: ObservationRequest,
	context: ObservationContext,
): LogicalIdentityObservationTarget {
	if (!isRecord(request.detail)) {
		throw new Error(`${request.kind} requires logical identity detail`);
	}
	const {
		table,
		column,
		schema,
		logicalId,
		carrierKind,
		authenticated,
		expected,
	} = request.detail;
	if (typeof table !== 'string' || typeof logicalId !== 'string') {
		throw new Error(`${request.kind} requires table and logicalId detail`);
	}
	if (column != null && typeof column !== 'string') {
		throw new Error(`${request.kind} column detail must be a string or null`);
	}
	if (schema != null && typeof schema !== 'string') {
		throw new Error(`${request.kind} schema detail must be a string`);
	}
	if (carrierKind !== 'postgresql-side-table' || authenticated !== false) {
		throw new Error(
			`${request.kind} only supports authenticated:false postgresql-side-table carrier detail`,
		);
	}
	if (expected !== 'adoptable' && expected !== 'attached') {
		throw new Error(`${request.kind} requires expected=adoptable|attached`);
	}
	const resolvedSchema = schema ?? explicitSchemaFromContext(context);
	if (!resolvedSchema) {
		throw new Error(
			`${request.kind} requires explicit schema detail; unqualified transition observations cannot be resolved from search_path`,
		);
	}
	return column == null
		? {
				table,
				schema: resolvedSchema,
				logicalId,
				carrierKind,
				authenticated,
				expected,
			}
		: {
				table,
				column,
				schema: resolvedSchema,
				logicalId,
				carrierKind,
				authenticated,
				expected,
			};
}

function targetFromRequests(
	requests: readonly ObservationRequest[] | undefined,
	context: ObservationContext,
): ObservationTarget | EnumObservationTarget | undefined {
	for (const request of requests ?? []) {
		if (!isRecord(request.detail)) {
			continue;
		}
		if (
			typeof request.detail.table === 'string' &&
			typeof request.detail.column === 'string'
		) {
			return detailTarget(request, context);
		}
		if (typeof request.detail.table === 'string') {
			return tableDetailTarget(request, context);
		}
		if (typeof request.detail.type === 'string') {
			return enumDetailTarget(request, context);
		}
	}
	return undefined;
}

async function readTableAlterAuthorityFacts(
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

async function readTypeAlterAuthorityFacts(
	executor: Queryable,
	target: EnumObservationTarget & { readonly schema: string },
): Promise<AlterAuthorityFacts> {
	const result = await executor.query(
		// USAGE reflects privileges available to the effective role without SET ROLE;
		// MEMBER alone is too broad for ALTER ownership checks under NOINHERIT.
		"SELECT pg_catalog.pg_has_role(t.typowner, 'USAGE') AS has_type_alter_authority, " +
			"pg_catalog.has_schema_privilege(n.oid, 'USAGE') AS has_schema_usage " +
			'FROM pg_catalog.pg_type t ' +
			'JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace ' +
			'WHERE n.nspname = $1 AND t.typname = $2 ' +
			"AND t.typtype = 'e'",
		[target.schema, target.type],
	);
	const row = result.rows[0];
	const hasTypeAlterAuthority = row?.has_type_alter_authority === true;
	const hasSchemaUsage = row?.has_schema_usage === true;
	return {
		hasAlterAuthority: hasTypeAlterAuthority && hasSchemaUsage,
		hasTableAlterAuthority: false,
		hasTypeAlterAuthority,
		hasSchemaUsage,
	};
}

function isEnumTarget(
	target: ObservationTarget | EnumObservationTarget,
): target is EnumObservationTarget {
	return 'type' in target;
}

function resolvedEnumTarget(
	target: EnumObservationTarget,
): EnumObservationTarget & { readonly schema: string } {
	if (!target.schema) {
		throw new Error('PostgreSQL transition observation target lost schema');
	}
	return { type: target.type, schema: target.schema };
}

function privilegeFactsForTarget(
	target: ObservationTarget & { readonly schema: string },
	facts: AlterAuthorityFacts,
): readonly string[] {
	const tableFacts = [
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
	];
	return target.column
		? [
				...tableFacts,
				pgPrivilegeFact(
					PG_SET_NOT_NULL_AUTHORITY_PRIVILEGE,
					[target.schema, target.table, target.column],
					facts.hasAlterAuthority,
				),
			]
		: tableFacts;
}

function privilegeFactsForEnumTarget(
	target: EnumObservationTarget & { readonly schema: string },
	facts: AlterAuthorityFacts,
): readonly string[] {
	return [
		pgPrivilegeFact(
			PG_SCHEMA_USAGE_PRIVILEGE,
			[target.schema],
			facts.hasSchemaUsage,
		),
		pgPrivilegeFact(
			PG_TYPE_ALTER_AUTHORITY_PRIVILEGE,
			[target.schema, target.type],
			facts.hasTypeAlterAuthority === true,
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
							([key]) => !['schema', 'table', 'column', 'index'].includes(key),
						),
					)
				: {}),
			table: target.table,
			...(target.column !== undefined ? { column: target.column } : {}),
			...(target.constraint !== undefined
				? { constraint: target.constraint }
				: {}),
			...(target.index !== undefined ? { index: target.index } : {}),
			schema: target.schema ?? null,
		},
	};
}

function scopeFor(
	target: ObservationTarget,
	context: ObservationContext,
	kind: 'table' | 'column',
): ResourceAddress {
	if (kind === 'column' && !target.column) {
		throw new Error('column observation scope requires a column target');
	}
	const base: ResourceAddress = {
		engine: 'postgresql',
		database: context.databaseId,
		kind,
		name: kind === 'table' ? target.table : (target.column ?? target.table),
	};
	const qualified =
		kind === 'column' ? { ...base, qualifiedBy: [target.table] } : base;
	return target.schema ? { ...qualified, schema: target.schema } : qualified;
}

function logicalIdentityScopeFor(
	target: LogicalIdentityObservationTarget,
	context: ObservationContext,
): ResourceAddress {
	const base: ResourceAddress = {
		engine: 'postgresql',
		database: context.databaseId,
		schema: target.schema,
		kind: target.column ? 'column' : 'table',
		name: target.column ?? target.table,
	};
	return target.column ? { ...base, qualifiedBy: [target.table] } : base;
}

function enumScopeFor(
	target: EnumObservationTarget & { readonly schema: string },
	context: ObservationContext,
): ResourceAddress {
	return {
		engine: 'postgresql',
		database: context.databaseId,
		schema: target.schema,
		kind: 'type',
		name: target.type,
		qualifiedBy: ['enum'],
	};
}

function requestForEnumTarget(
	request: ObservationRequest,
	target: EnumObservationTarget,
	context: ObservationContext,
): ObservationRequest {
	const resolved = resolvedEnumTarget(target);
	return {
		kind: request.kind,
		scope: [enumScopeFor(resolved, context)],
		detail: {
			...(isRecord(request.detail)
				? Object.fromEntries(
						Object.entries(request.detail).filter(
							([key]) => !['schema', 'type', 'label'].includes(key),
						),
					)
				: {}),
			type: target.type,
			...(target.label !== undefined ? { label: target.label } : {}),
			schema: resolved.schema,
		},
	};
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

function stringRecord(value: unknown): Readonly<Record<string, string>> {
	if (!isRecord(value)) {
		return {};
	}
	return Object.fromEntries(
		Object.entries(value).filter(
			(entry): entry is [string, string] =>
				typeof entry[0] === 'string' && typeof entry[1] === 'string',
		),
	);
}

function pgTextArray(value: string): readonly string[] | undefined {
	const text = value.trim();
	if (!text.startsWith('{') || !text.endsWith('}')) {
		return undefined;
	}
	const body = text.slice(1, -1);
	if (body === '') {
		return [];
	}
	const result: string[] = [];
	let item = '';
	let inQuotes = false;
	let quoted = false;
	let escaped = false;
	const pushItem = () => {
		const normalized = quoted ? item : item.trim();
		if (quoted || normalized !== 'NULL') {
			result.push(normalized);
		}
		item = '';
		quoted = false;
	};
	for (const char of body) {
		if (escaped) {
			item += char;
			escaped = false;
			continue;
		}
		if (inQuotes && char === '\\') {
			escaped = true;
			continue;
		}
		if (char === '"') {
			inQuotes = !inQuotes;
			quoted = true;
			continue;
		}
		if (!inQuotes && char === ',') {
			pushItem();
			continue;
		}
		item += char;
	}
	pushItem();
	return result;
}

export function normalizePgStringArray(value: unknown): readonly string[] {
	if (Array.isArray(value)) {
		return value.filter((item): item is string => typeof item === 'string');
	}
	if (typeof value === 'string') {
		try {
			const parsed = JSON.parse(value) as unknown;
			if (Array.isArray(parsed)) {
				return parsed.filter(
					(item): item is string => typeof item === 'string',
				);
			}
		} catch {
			// Fall through to PostgreSQL text-array parsing.
		}
		return pgTextArray(value) ?? [];
	}
	return [];
}

function stringArray(value: unknown): readonly string[] {
	return normalizePgStringArray(value);
}

function stringOrNull(value: unknown): string | null {
	return typeof value === 'string' ? value : null;
}

function numberOrNull(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function unsupportedEnumDetailKeys(
	request: ObservationRequest,
	allowedKeys: readonly string[],
): readonly string[] {
	if (!isRecord(request.detail)) {
		return [];
	}
	const allowed = new Set(allowedKeys);
	return Object.keys(request.detail).filter((key) => !allowed.has(key));
}

function assertRecognizedEnumObservationDetail(
	request: ObservationRequest,
): void {
	const allowedKeys =
		request.kind === ENUM_LABEL_VISIBLE_OBSERVATION
			? ['schema', 'type', 'label', 'position']
			: ['schema', 'type'];
	const unsupported = unsupportedEnumDetailKeys(request, allowedKeys);
	if (unsupported.length > 0) {
		throw new Error(
			`${request.kind} detail contains unsupported field ${unsupported[0]}`,
		);
	}
}

function validPositionIndex(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function hasOnlySupportedEnumPositionKeys(
	position: Record<string, unknown>,
): boolean {
	const supportedKeys = new Set(['mode', 'after', 'index', 'atEnd']);
	return Object.keys(position).every((key) => supportedKeys.has(key));
}

function enumLabelPositionHolds(
	detail: ObservationRequest['detail'],
	labels: readonly string[],
	label: string | undefined,
): boolean {
	if (label === undefined) {
		return false;
	}
	const index = labels.indexOf(label);
	if (index < 0) {
		return false;
	}
	if (!isRecord(detail)) {
		return false;
	}
	if (!('position' in detail)) {
		return true;
	}
	if (!isRecord(detail.position)) {
		return false;
	}
	if (!hasOnlySupportedEnumPositionKeys(detail.position)) {
		return false;
	}
	const { after, index: expectedIndex, atEnd, mode } = detail.position;
	if (mode !== 'append' && mode !== 'after') {
		return false;
	}
	if (mode === 'after' && typeof after !== 'string') {
		return false;
	}
	if (after !== undefined && after !== null && typeof after !== 'string') {
		return false;
	}
	if (expectedIndex !== undefined && !validPositionIndex(expectedIndex)) {
		return false;
	}
	if (atEnd !== undefined && typeof atEnd !== 'boolean') {
		return false;
	}
	if (mode === 'append' && index !== labels.length - 1) {
		return false;
	}
	if (expectedIndex !== undefined && index !== expectedIndex) {
		return false;
	}
	if (atEnd !== undefined && (index === labels.length - 1) !== atEnd) {
		return false;
	}
	if (typeof after === 'string' && labels[index - 1] !== after) {
		return false;
	}
	if (after === null && index !== 0) {
		return false;
	}
	return true;
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

function assertStandardConformingStrings(context: ObservationContext): void {
	if (context.sessionConfiguration.standard_conforming_strings !== 'on') {
		throw new Error(
			'table-check deparse requires standard_conforming_strings=on before rendering authored CHECK text',
		);
	}
}

function tableCheckDetail(
	request: ObservationRequest,
	context: ObservationContext,
): {
	readonly target: ObservationTarget & {
		readonly schema: string;
		readonly constraint: string;
	};
	readonly expression: string;
} {
	const target = tableDetailTarget(request, context);
	if (!target.constraint) {
		throw new Error('table-check deparse requires a constraint detail');
	}
	if (
		!isRecord(request.detail) ||
		typeof request.detail.expression !== 'string'
	) {
		throw new Error(
			'table-check deparse requires an authored expression detail',
		);
	}
	return {
		target: {
			table: target.table,
			schema: target.schema,
			constraint: target.constraint,
		},
		expression: request.detail.expression,
	};
}

function validatedCheckClause(expression: string): string {
	const state = splitCheckConstraintState({ expression });
	if (state.notValid) {
		throw new Error('table-check deparse does not support NOT VALID');
	}
	if (/\bNO\s+INHERIT\b/iu.test(state.expression)) {
		throw new Error('table-check deparse does not support NO INHERIT');
	}
	const clause = renderCheckConstraintClause({ expression: state.expression });
	validateCheckExpression(clause, 'table-check deparse expression');
	return clause;
}

type CanonicalCheckRead = {
	readonly expression: string;
	readonly predicate: string;
	readonly notValid: boolean;
};

async function readCatalogCheckCanonical(
	executor: Queryable,
	target: ObservationTarget & {
		readonly schema: string;
		readonly constraint: string;
	},
): Promise<CanonicalCheckRead | undefined> {
	const result = await executor.query(
		'SELECT pg_catalog.pg_get_constraintdef(con.oid, false) AS expression, ' +
			'pg_catalog.pg_get_expr(con.conbin, con.conrelid) AS predicate_expression, ' +
			'NOT con.convalidated AS not_valid ' +
			'FROM pg_catalog.pg_constraint con ' +
			'JOIN pg_catalog.pg_class c ON c.oid = con.conrelid ' +
			'JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace ' +
			'WHERE n.nspname = $1 AND c.relname = $2 AND con.conname = $3 ' +
			"AND con.contype = 'c'",
		[target.schema, target.table, target.constraint],
	);
	const row = result.rows[0];
	if (!row) {
		return undefined;
	}
	const expression = row.expression;
	const predicate = row.predicate_expression;
	if (typeof expression !== 'string' || typeof predicate !== 'string') {
		throw new Error('table-check deparse could not read catalog CHECK text');
	}
	return {
		expression,
		predicate,
		notValid: row?.not_valid === true,
	};
}

async function readTempCheckCanonical(
	executor: Queryable,
	tempTable: string,
	constraint: string,
): Promise<CanonicalCheckRead> {
	const result = await executor.query(
		'SELECT pg_catalog.pg_get_constraintdef(con.oid, false) AS expression, ' +
			'pg_catalog.pg_get_expr(con.conbin, con.conrelid) AS predicate_expression, ' +
			'NOT con.convalidated AS not_valid ' +
			'FROM pg_catalog.pg_constraint con ' +
			'WHERE con.conrelid = $1::pg_catalog.regclass AND con.conname = $2 ' +
			"AND con.contype = 'c'",
		[tempTable, constraint],
	);
	const row = result.rows[0];
	const expression = row?.expression;
	const predicate = row?.predicate_expression;
	if (typeof expression !== 'string' || typeof predicate !== 'string') {
		throw new Error('table-check deparse could not read temp CHECK text');
	}
	return {
		expression,
		predicate,
		notValid: row?.not_valid === true,
	};
}

function vendorValidatedPredicate(text: string): VendorValidatedExpression {
	return {
		kind: 'vendor-validated',
		category: 'predicate',
		validatedBy: PG_DEPARSE_ARTIFACT,
		text,
	};
}

async function observeTableCheckDeparse(
	executor: Queryable,
	request: ObservationRequest,
	context: ObservationContext,
): Promise<EvidenceObservation> {
	if (
		!isRecord(request.detail) ||
		request.detail.surface !== 'table-check' ||
		request.detail.category !== 'predicate'
	) {
		throw new Error(
			`${request.kind} requires surface=table-check and category=predicate`,
		);
	}
	assertStandardConformingStrings(context);
	const { target, expression } = tableCheckDetail(request, context);
	const normalizedRequest = requestForTarget(request, target, context, 'table');
	const desiredClause = validatedCheckClause(expression);
	const catalogCanonical = await readCatalogCheckCanonical(executor, target);
	const tempTable = `_dbsp_check_deparse_${Date.now()}_${++observationSequence}`;
	const savepoint = `dbsp_check_deparse_sp_${observationSequence}`;
	let savepointActive = false;
	let startedTransaction = false;
	try {
		try {
			await executor.query(`SAVEPOINT ${quoteIdent(savepoint, 'table')}`);
			savepointActive = true;
		} catch {
			await executor.query('BEGIN');
			startedTransaction = true;
			await executor.query(`SAVEPOINT ${quoteIdent(savepoint, 'table')}`);
			savepointActive = true;
		}
		await executor.query(
			`CREATE TEMP TABLE ${quoteIdent(tempTable, 'table')} ` +
				`(LIKE ${quoteIdent(target.schema, 'schema')}.${quoteIdent(
					target.table,
					'table',
				)} INCLUDING DEFAULTS INCLUDING GENERATED INCLUDING IDENTITY)`,
		);
		await executor.query(
			`ALTER TABLE ${quoteIdent(tempTable, 'table')} ` +
				`ADD CONSTRAINT ${quoteIdent(target.constraint, 'alias')} ${desiredClause}`,
		);
		const desiredCanonical = await readTempCheckCanonical(
			executor,
			tempTable,
			target.constraint,
		);
		const equivalentToCatalog =
			catalogCanonical === undefined
				? undefined
				: catalogCanonical.expression === desiredCanonical.expression &&
					catalogCanonical.predicate === desiredCanonical.predicate &&
					catalogCanonical.notValid === desiredCanonical.notValid;
		return evidenceObservation({
			request: normalizedRequest,
			context,
			scope: [scopeFor(target, context, 'table')],
			stability: 'externally-mutable',
			source: 'vendor-deparser',
			value: {
				ok: true,
				surface: 'table-check',
				category: 'predicate',
				desiredCanonical: desiredCanonical.expression,
				desiredPredicateCanonical: desiredCanonical.predicate,
				...(catalogCanonical
					? {
							catalogCanonical: catalogCanonical.expression,
							catalogPredicateCanonical: catalogCanonical.predicate,
							equivalentToCatalog,
						}
					: {}),
				expression: vendorValidatedPredicate(desiredCanonical.expression),
				predicate: vendorValidatedPredicate(desiredCanonical.predicate),
				claims: [{ kind: EXPRESSION_DEPARSE_OBSERVATION, holds: true }],
			} as unknown as JsonValue,
		});
	} finally {
		if (savepointActive) {
			await executor
				.query(`ROLLBACK TO SAVEPOINT ${quoteIdent(savepoint, 'table')}`)
				.catch(() => undefined);
			await executor
				.query(`RELEASE SAVEPOINT ${quoteIdent(savepoint, 'table')}`)
				.catch(() => undefined);
		}
		if (startedTransaction) {
			await executor.query('ROLLBACK').catch(() => undefined);
		}
	}
}

async function observeExpressionDeparse(
	executor: Queryable,
	request: ObservationRequest,
	context: ObservationContext,
): Promise<EvidenceObservation> {
	if (isRecord(request.detail) && request.detail.surface === 'table-check') {
		return observeTableCheckDeparse(executor, request, context);
	}
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

function logicalIdentityBindingFromRow(
	row: Record<string, unknown>,
): LogicalIdentityBinding | undefined {
	const logicalId = stringOrNull(row.logical_id);
	const schema = stringOrNull(row.schema_name);
	const table = stringOrNull(row.table_name);
	const column =
		row.column_name === null ? null : stringOrNull(row.column_name);
	const carrierKind = stringOrNull(row.carrier_kind);
	if (!logicalId || !schema || !table || carrierKind === null) {
		return undefined;
	}
	return {
		logicalId,
		schema,
		table,
		column,
		carrierKind,
	};
}

function bindingMatchesTarget(
	binding: LogicalIdentityBinding,
	target: LogicalIdentityObservationTarget,
): boolean {
	return (
		binding.schema === target.schema &&
		binding.table === target.table &&
		binding.column === (target.column ?? null)
	);
}

function bindingIsExpected(
	binding: LogicalIdentityBinding,
	target: LogicalIdentityObservationTarget,
): boolean {
	return (
		binding.logicalId === target.logicalId &&
		binding.carrierKind === target.carrierKind &&
		bindingMatchesTarget(binding, target)
	);
}

async function logicalIdentityObjectExists(
	executor: Queryable,
	target: LogicalIdentityObservationTarget,
): Promise<boolean> {
	if (target.column) {
		const result = await executor.query(
			'SELECT 1 FROM pg_catalog.pg_class c ' +
				'JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace ' +
				'JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid ' +
				'WHERE n.nspname = $1 AND c.relname = $2 AND a.attname = $3 ' +
				"AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped " +
				'LIMIT 1',
			[target.schema, target.table, target.column],
		);
		return result.rows.length > 0;
	}
	const result = await executor.query(
		'SELECT 1 FROM pg_catalog.pg_class c ' +
			'JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace ' +
			'WHERE n.nspname = $1 AND c.relname = $2 ' +
			"AND c.relkind IN ('r', 'p') LIMIT 1",
		[target.schema, target.table],
	);
	return result.rows.length > 0;
}

async function logicalIdentitySideTableExists(
	executor: Queryable,
	_schema: string,
): Promise<boolean> {
	const qualified = `${quoteIdent(DBSP_META_SCHEMA, 'schema')}.${quoteIdent(
		DBSP_LOGICAL_IDENTITY_TABLE,
		'table',
	)}`;
	const result = await executor.query(
		'SELECT pg_catalog.to_regclass($1) IS NOT NULL AS exists',
		[qualified],
	);
	return result.rows[0]?.exists === true;
}

async function logicalIdentityBindings(
	executor: Queryable,
	target: LogicalIdentityObservationTarget,
): Promise<readonly LogicalIdentityBinding[]> {
	const sideTableExists = await logicalIdentitySideTableExists(
		executor,
		target.schema,
	);
	if (!sideTableExists) {
		return [];
	}
	const result = await executor.query(
		`SELECT logical_id, schema_name, table_name, column_name, carrier_kind ` +
			`FROM ${quoteIdent(DBSP_META_SCHEMA, 'schema')}.${quoteIdent(
				DBSP_LOGICAL_IDENTITY_TABLE,
				'table',
			)} ` +
			'WHERE logical_id = $1 OR (' +
			'schema_name = $2 AND table_name = $3 AND ' +
			'((column_name IS NULL AND $4::text IS NULL) OR column_name = $4::text)' +
			') ' +
			'ORDER BY logical_id, schema_name, table_name, column_name NULLS FIRST',
		[target.logicalId, target.schema, target.table, target.column ?? null],
	);
	return result.rows.flatMap((row) => {
		const binding = logicalIdentityBindingFromRow(row);
		return binding ? [binding] : [];
	});
}

async function observeLogicalIdentityCarrier(
	executor: Queryable,
	request: ObservationRequest,
	context: ObservationContext,
): Promise<EvidenceObservation> {
	const target = logicalIdentityDetailTarget(request, context);
	const scope = logicalIdentityScopeFor(target, context);
	const normalizedRequest: ObservationRequest = {
		kind: request.kind,
		scope: [scope],
		detail: {
			schema: target.schema,
			table: target.table,
			column: target.column ?? null,
			logicalId: target.logicalId,
			carrierKind: target.carrierKind,
			authenticated: target.authenticated,
			expected: target.expected,
		},
	};
	const [objectExists, sideTableExists, bindings] = await Promise.all([
		logicalIdentityObjectExists(executor, target),
		logicalIdentitySideTableExists(executor, target.schema),
		logicalIdentityBindings(executor, target),
	]);
	const objectBindings = bindings.filter((binding) =>
		bindingMatchesTarget(binding, target),
	);
	const logicalIdBindings = bindings.filter(
		(binding) => binding.logicalId === target.logicalId,
	);
	const adoptable =
		objectExists &&
		objectBindings.length === 0 &&
		logicalIdBindings.length === 0;
	const attached =
		objectExists &&
		objectBindings.length === 1 &&
		logicalIdBindings.length === 1 &&
		objectBindings.every((binding) => bindingIsExpected(binding, target)) &&
		logicalIdBindings.every((binding) => bindingIsExpected(binding, target));
	const holds = target.expected === 'attached' ? attached : adoptable;
	return evidenceObservation({
		request: normalizedRequest,
		context,
		scope: [scope],
		stability: 'externally-mutable',
		source: 'system-catalog',
		value: {
			objectExists,
			sideTableExists,
			logicalId: target.logicalId,
			carrierKind: target.carrierKind,
			authenticated: target.authenticated,
			objectBindings,
			logicalIdBindings,
			claims: [{ kind: LOGICAL_IDENTITY_CARRIER_OBSERVATION, holds }],
		} as unknown as JsonValue,
	});
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

type ObservedCheckSetEntry = {
	readonly name: string;
	readonly oid: string | null;
	readonly expression: string;
	readonly predicate: string;
	readonly notValid: boolean;
};

function observedCheckSet(value: unknown): readonly ObservedCheckSetEntry[] {
	const parsed =
		typeof value === 'string'
			? (() => {
					try {
						return JSON.parse(value) as unknown;
					} catch {
						return [];
					}
				})()
			: value;
	if (!Array.isArray(parsed)) {
		return [];
	}
	return parsed.flatMap((item): readonly ObservedCheckSetEntry[] => {
		if (!isRecord(item)) {
			return [];
		}
		const predicate =
			typeof item.predicate === 'string'
				? item.predicate
				: typeof item.predicateExpression === 'string'
					? item.predicateExpression
					: undefined;
		if (
			typeof item.name !== 'string' ||
			!(item.oid === null || typeof item.oid === 'string') ||
			typeof item.expression !== 'string' ||
			typeof predicate !== 'string' ||
			typeof item.notValid !== 'boolean'
		) {
			return [];
		}
		return [
			{
				name: item.name,
				oid: item.oid,
				expression: item.expression,
				predicate,
				notValid: item.notValid,
			},
		];
	});
}

async function observeTableChecks(
	executor: Queryable,
	request: ObservationRequest,
	context: ObservationContext,
): Promise<EvidenceObservation> {
	const target = tableDetailTarget(request, context);
	if (!target.constraint) {
		throw new Error(
			`${request.kind} requires a constraint detail for absence binding`,
		);
	}
	const normalizedRequest = requestForTarget(request, target, context, 'table');
	const result = await executor.query(
		'SELECT c.oid::text AS oid, c.relkind AS relkind, n.nspname AS schema_name, c.relname AS table_name, ' +
			"COALESCE(pg_catalog.json_agg(pg_catalog.json_build_object('name', con.conname, 'oid', con.oid::text, 'expression', pg_catalog.pg_get_constraintdef(con.oid, false), 'predicate', pg_catalog.pg_get_expr(con.conbin, con.conrelid), 'notValid', NOT con.convalidated) ORDER BY con.conname) FILTER (WHERE con.oid IS NOT NULL), '[]'::json) AS checks " +
			'FROM pg_catalog.pg_class c ' +
			'JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace ' +
			'LEFT JOIN pg_catalog.pg_constraint con ON con.conrelid = c.oid ' +
			"AND con.contype = 'c' AND con.conparentid = 0 " +
			'WHERE n.nspname = $1 AND c.relname = $2 ' +
			"AND c.relkind IN ('r', 'p') " +
			'GROUP BY c.oid, c.relkind, n.nspname, c.relname',
		[target.schema, target.table],
	);
	const row = result.rows[0];
	const exists = row != null;
	const checks = [...observedCheckSet(row?.checks)].sort((left, right) =>
		left.name.localeCompare(right.name),
	);
	const absent = exists
		? !checks.some((check) => check.name === target.constraint)
		: false;
	const value = {
		exists,
		oid: exists ? stringOrNull(row.oid) : null,
		relkind: exists ? stringOrNull(row.relkind) : null,
		schema: exists ? stringOrNull(row.schema_name) : null,
		table: exists ? stringOrNull(row.table_name) : null,
		checks,
		claims: [
			{ kind: TABLE_CHECK_CONSTRAINTS_OBSERVATION, holds: exists },
			{ kind: CHECK_CONSTRAINT_ABSENT_OBSERVATION, holds: absent },
		],
	};
	return evidenceObservation({
		request: normalizedRequest,
		context,
		scope: [scopeFor(target, context, 'table')],
		stability: 'externally-mutable',
		source: 'system-catalog',
		value,
	});
}

function recordFromReloptions(value: unknown): Record<string, string> {
	const options = stringArray(value);
	const result: Record<string, string> = {};
	for (const option of options) {
		const separator = option.indexOf('=');
		if (separator > 0) {
			result[option.slice(0, separator)] = option.slice(separator + 1);
		}
	}
	return result;
}

function nullableStringArray(value: unknown): readonly string[] {
	return stringArray(value).filter((entry) => entry.length > 0);
}

function booleanAlias(
	row: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	return keys.some((key) => row[key] === true);
}

export type PgIndexCatalogRowValue = {
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
	readonly with: Readonly<Record<string, string>>;
	readonly nullsNotDistinct: boolean;
};

export function normalizePgIndexCatalogRow(
	row: Record<string, unknown>,
): PgIndexCatalogRowValue | null {
	const name = stringOrNull(row.index_name) ?? stringOrNull(row.name);
	if (!name) {
		return null;
	}
	const opclassCols = nullableStringArray(row.opclass_cols);
	const opclassNames = nullableStringArray(row.opclass_names);
	const expressions = nullableStringArray(row.expressions);
	const expressionsText = stringOrNull(row.expressions_text);
	const withValue = row.with ?? row.reloptions;
	return {
		name,
		oid: stringOrNull(row.index_oid) ?? stringOrNull(row.oid),
		columns: nullableStringArray(row.columns),
		include: nullableStringArray(row.include_columns ?? row.include),
		expressions:
			expressions.length > 0
				? expressions
				: expressionsText
					? [expressionsText]
					: [],
		opclass:
			opclassCols.length > 0
				? Object.fromEntries(
						opclassCols.map((column, index) => [
							column,
							opclassNames[index] ?? '',
						]),
					)
				: opclassNames.length > 0
					? { __unknown__: opclassNames.join(',') }
					: stringRecord(row.opclass),
		unique: booleanAlias(row, ['unique', 'is_unique', 'indisunique']),
		valid: booleanAlias(row, ['valid', 'is_valid', 'indisvalid']),
		ready: booleanAlias(row, ['ready', 'is_ready', 'indisready']),
		method: stringOrNull(row.method) ?? stringOrNull(row.amname),
		predicate: stringOrNull(row.predicate) ?? stringOrNull(row.where) ?? null,
		with:
			isRecord(withValue) || withValue == null
				? stringRecord(withValue)
				: recordFromReloptions(withValue),
		nullsNotDistinct: booleanAlias(row, [
			'nullsNotDistinct',
			'nulls_not_distinct',
			'indnullsnotdistinct',
		]),
	};
}

async function observeTableIndexes(
	executor: Queryable,
	request: ObservationRequest,
	context: ObservationContext,
): Promise<EvidenceObservation> {
	const target = tableDetailTarget(request, context);
	if (!target.index) {
		throw new Error(
			`${request.kind} requires an index detail for absence binding`,
		);
	}
	const normalizedRequest = requestForTarget(request, target, context, 'table');
	const tableResult = await executor.query(
		'SELECT c.oid::text AS oid, c.relkind AS relkind, n.nspname AS schema_name, c.relname AS table_name ' +
			'FROM pg_catalog.pg_class c ' +
			'JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace ' +
			'WHERE n.nspname = $1 AND c.relname = $2 ' +
			"AND c.relkind IN ('r', 'p')",
		[target.schema, target.table],
	);
	const tableRow = tableResult.rows[0];
	const exists = tableRow != null;
	const indexRows = exists
		? (
				await executor.query(
					`SELECT
			   i.oid::text AS oid,
			   i.relname AS index_name,
			   COALESCE(jsonb_agg(a.attname ORDER BY k.n)
			     FILTER (WHERE k.n <= ix.indnkeyatts AND k.attnum != 0), '[]'::jsonb) AS columns,
			   COALESCE(jsonb_agg(a_inc.attname ORDER BY k.n)
			     FILTER (WHERE k.n > ix.indnkeyatts), '[]'::jsonb) AS include_columns,
			   pg_catalog.pg_get_expr(ix.indexprs, ix.indrelid, false) AS expressions_text,
			   COALESCE(jsonb_agg(oc.opcname ORDER BY k.n)
			     FILTER (WHERE k.n <= ix.indnkeyatts AND k.attnum != 0
			             AND NOT oc.opcdefault), '[]'::jsonb) AS opclass_names,
			   COALESCE(jsonb_agg(a.attname ORDER BY k.n)
			     FILTER (WHERE k.n <= ix.indnkeyatts AND k.attnum != 0
			             AND NOT oc.opcdefault), '[]'::jsonb) AS opclass_cols,
			   ix.indisunique AS indisunique,
			   ix.indisvalid AS indisvalid,
			   ix.indisready AS indisready,
			   COALESCE((to_jsonb(ix) ->> 'indnullsnotdistinct')::boolean, false) AS nulls_not_distinct,
			   am.amname AS method,
			   pg_catalog.pg_get_expr(ix.indpred, ix.indrelid, false) AS predicate,
			   i.reloptions AS reloptions
			 FROM pg_catalog.pg_index ix
			 JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid
			 JOIN pg_catalog.pg_class t ON t.oid = ix.indrelid
			 JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
			 JOIN pg_catalog.pg_am am ON am.oid = i.relam
			 CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, n)
			 LEFT JOIN pg_catalog.pg_attribute a
			   ON a.attrelid = t.oid AND a.attnum = k.attnum AND k.attnum != 0
			 LEFT JOIN pg_catalog.pg_attribute a_inc
			   ON a_inc.attrelid = t.oid AND a_inc.attnum = k.attnum AND k.n > ix.indnkeyatts
			 LEFT JOIN pg_catalog.pg_opclass oc
			   ON oc.oid = (ix.indclass::oid[])[k.n - 1]
			   AND k.n <= ix.indnkeyatts AND k.attnum != 0
			 WHERE n.nspname = $1 AND t.relname = $2
			   AND NOT ix.indisprimary
			   AND NOT EXISTS (
			     SELECT 1 FROM pg_catalog.pg_constraint c
			     WHERE c.conindid = i.oid
			       AND c.contype = 'u'
			   )
			 GROUP BY i.oid, i.relname, ix.indisunique, ix.indisvalid,
			          ix.indisready, ix.indrelid, ix.indnkeyatts, ix.indkey,
			          ix.indclass, ix.indpred, ix.indexprs, i.reloptions,
			          am.amname, ix
			 ORDER BY i.relname`,
					[target.schema, target.table],
				)
			).rows
		: [];
	const targetNameResult = await executor.query(
		'SELECT 1 FROM pg_catalog.pg_class i ' +
			'JOIN pg_catalog.pg_namespace n ON n.oid = i.relnamespace ' +
			"WHERE n.nspname = $1 AND i.relname = $2 AND i.relkind = 'i' LIMIT 1",
		[target.schema, target.index],
	);
	const targetIndexNameExists = targetNameResult.rows.length > 0;
	const indexes = indexRows.flatMap((row) => {
		const index = normalizePgIndexCatalogRow(row);
		return index ? [index] : [];
	});
	const targetAbsent = exists
		? !targetIndexNameExists &&
			!indexes.some((index) => index.name === target.index)
		: false;
	const value = {
		exists,
		oid: exists ? stringOrNull(tableRow.oid) : null,
		relkind: exists ? stringOrNull(tableRow.relkind) : null,
		schema: exists ? stringOrNull(tableRow.schema_name) : null,
		table: exists ? stringOrNull(tableRow.table_name) : null,
		targetIndexNameExists,
		indexes,
		claims: [
			{ kind: TABLE_INDEXES_OBSERVATION, holds: exists },
			{ kind: INDEX_ABSENT_OBSERVATION, holds: targetAbsent },
		],
	};
	return evidenceObservation({
		request: normalizedRequest,
		context,
		scope: [scopeFor(target, context, 'table')],
		stability: 'externally-mutable',
		source: 'system-catalog',
		value: value as unknown as JsonValue,
	});
}

async function observeEnumLabels(
	executor: Queryable,
	request: ObservationRequest,
	context: ObservationContext,
): Promise<EvidenceObservation> {
	assertRecognizedEnumObservationDetail(request);
	const target = enumDetailTarget(request, context);
	const scope = enumScopeFor(target, context);
	const extraDetail = isRecord(request.detail)
		? Object.fromEntries(
				Object.entries(request.detail).filter(
					([key]) => !['schema', 'type', 'label'].includes(key),
				),
			)
		: {};
	const detail =
		request.kind === ENUM_LABEL_VISIBLE_OBSERVATION
			? {
					...extraDetail,
					type: target.type,
					label: target.label ?? null,
					schema: target.schema,
				}
			: {
					...extraDetail,
					type: target.type,
					schema: target.schema,
				};
	const normalizedRequest: ObservationRequest = {
		kind: request.kind,
		scope: [scope],
		detail,
	};
	const result = await executor.query(
		'SELECT t.oid::text AS oid, n.nspname AS schema_name, t.typname AS type_name, ' +
			"COALESCE(pg_catalog.json_agg(e.enumlabel ORDER BY e.enumsortorder) FILTER (WHERE e.enumlabel IS NOT NULL), '[]'::json) AS labels " +
			'FROM pg_catalog.pg_type t ' +
			'JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace ' +
			'LEFT JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid ' +
			"WHERE n.nspname = $1 AND t.typname = $2 AND t.typtype = 'e' " +
			'GROUP BY t.oid, n.nspname, t.typname',
		[target.schema, target.type],
	);
	const row = result.rows[0];
	const observedSchema = row ? stringOrNull(row.schema_name) : null;
	const observedType = row ? stringOrNull(row.type_name) : null;
	const exists =
		row != null &&
		observedSchema === target.schema &&
		observedType === target.type;
	const labels = exists ? stringArray(row.labels) : [];
	const labelVisible =
		!exists || target.label == null
			? false
			: enumLabelPositionHolds(request.detail, labels, target.label);
	const value = {
		exists,
		oid: exists ? stringOrNull(row.oid) : null,
		schema: exists ? observedSchema : null,
		type: exists ? observedType : null,
		labels,
		claims:
			request.kind === ENUM_LABEL_VISIBLE_OBSERVATION
				? [{ kind: ENUM_LABEL_VISIBLE_OBSERVATION, holds: labelVisible }]
				: [{ kind: ENUM_TYPE_EXISTS_OBSERVATION, holds: exists }],
	};
	return evidenceObservation({
		request: normalizedRequest,
		context,
		scope: [scope],
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
	const enumTarget =
		isRecord(request.detail) && typeof request.detail.type === 'string'
			? enumDetailTarget(request, context)
			: undefined;
	if (enumTarget) {
		if (request.kind !== ALTER_TYPE_AUTHORITY_OBSERVATION) {
			throw new Error(
				'ALTER TYPE authority observations must use postgresql.type.alter-authority',
			);
		}
		const normalizedRequest = requestForEnumTarget(
			request,
			enumTarget,
			context,
		);
		const resolved = resolvedEnumTarget(enumTarget);
		const facts = await readTypeAlterAuthorityFacts(executor, resolved);
		const value = {
			...facts,
			privileges: privilegeFactsForEnumTarget(resolved, facts),
			claims: [
				{
					kind: ALTER_TYPE_AUTHORITY_OBSERVATION,
					holds: facts.hasAlterAuthority,
				},
			],
		};
		return evidenceObservation({
			request: normalizedRequest,
			context,
			scope: [enumScopeFor(resolved, context)],
			stability: 'session-bound',
			source: 'privilege-probe',
			value,
		});
	}
	if (request.kind !== ALTER_AUTHORITY_OBSERVATION) {
		throw new Error(
			'ALTER TABLE authority observations must use postgresql.table.alter-authority',
		);
	}
	const target =
		isRecord(request.detail) && typeof request.detail.column === 'string'
			? detailTarget(request, context)
			: tableDetailTarget(request, context);
	const normalizedRequest = requestForTarget(request, target, context, 'table');
	const resolved = resolvedTableTarget(target);
	const facts = await readTableAlterAuthorityFacts(executor, resolved);
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
		mergeObservationPrivileges: mergePgObservationPrivileges,
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
				case TABLE_CHECK_CONSTRAINTS_OBSERVATION:
					return observeTableChecks(executor, request, context);
				case TABLE_INDEXES_OBSERVATION:
					return observeTableIndexes(executor, request, context);
				case LOGICAL_IDENTITY_CARRIER_OBSERVATION:
					return observeLogicalIdentityCarrier(executor, request, context);
				case ENUM_TYPE_EXISTS_OBSERVATION:
				case ENUM_LABEL_VISIBLE_OBSERVATION:
					return observeEnumLabels(executor, request, context);
				case ALTER_AUTHORITY_OBSERVATION:
				case ALTER_TYPE_AUTHORITY_OBSERVATION:
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
	observationTarget?: ObservationTarget | EnumObservationTarget,
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
	observationTarget?: ObservationTarget | EnumObservationTarget,
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
	const standardConformingStrings = await executor.query(
		'SHOW standard_conforming_strings',
	);
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
		? isEnumTarget(resolvedObservationTarget)
			? privilegeFactsForEnumTarget(
					resolvedEnumTarget(resolvedObservationTarget),
					await readTypeAlterAuthorityFacts(
						executor,
						resolvedEnumTarget(resolvedObservationTarget),
					),
				)
			: privilegeFactsForTarget(
					resolvedTableTarget(resolvedObservationTarget),
					await readTableAlterAuthorityFacts(
						executor,
						resolvedTableTarget(resolvedObservationTarget),
					),
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
			standard_conforming_strings: String(
				standardConformingStrings.rows[0]?.standard_conforming_strings ??
					'unknown',
			),
			actual_search_path: JSON.stringify(actualSearchPath),
			...(schema != null ? { [EXPLICIT_SCHEMA_CONTEXT_KEY]: schema } : {}),
		},
		extensions: extensionMap,
		...(collationProvider ? { collationProvider } : {}),
		...(collationVersion ? { collationVersion } : {}),
	};
}
