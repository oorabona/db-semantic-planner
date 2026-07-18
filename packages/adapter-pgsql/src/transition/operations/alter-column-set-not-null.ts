import { createHash } from 'node:crypto';
import type {
	AdvisoryObservation,
	ApplyGuard,
	Assumption,
	DurableIntentRecord,
	EquivalenceContext,
	EquivalenceResult,
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
	columnShapeFromCatalog,
	isSetNotNullColumnShapeExpectation,
	type SetNotNullColumnShapeExpectation,
	type SetNotNullObservedColumnShape,
} from '../column-shape.js';
import {
	ALTER_COLUMN_SET_NOT_NULL_CAPABILITY,
	ALTER_COLUMN_SET_NOT_NULL_OPERATION_KIND,
	COLUMN_EXISTS_OBSERVATION,
	EXPRESSION_DEPARSE_OBSERVATION,
	NO_NULLS_GUARD,
	PG_OPERATION_PACK_ARTIFACT,
	PG_SCHEMA_USAGE_PRIVILEGE,
	PG_SET_NOT_NULL_AUTHORITY_PRIVILEGE,
	PG_TABLE_ALTER_AUTHORITY_PRIVILEGE,
} from '../constants.js';
import { observationContextMatches } from '../context-match.js';
import { createPgEquivalenceCapability } from '../equivalence.js';
import { advisoryObservationId, assumptionId } from '../ids.js';
import {
	appendCompletionJournal,
	appendIntentJournal,
	appendObservedJournal,
} from '../journal.js';
import { readPgObservationContext } from '../observation-issuer.js';
import { pgPrivilegeValue } from '../privileges.js';
import { stableJson } from '../stable-json.js';

export type AlterColumnSetNotNullPayload = {
	readonly table: string;
	readonly column: string;
	readonly schema?: string;
	readonly expectedColumnShape?: SetNotNullColumnShapeExpectation;
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
	readonly relkind: string | null;
	readonly nullable: boolean | null;
	readonly oid: string | null;
	readonly attnum: number | null;
	readonly atttypid: string | null;
	readonly atttypmod: number | null;
	readonly formatType: string | null;
	readonly typeName: string | null;
	readonly typeSchema: string | null;
	readonly hasDefault: boolean | null;
	readonly defaultExpression: string | null;
	readonly attcollation: string | null;
	readonly collationName: string | null;
	readonly collationSchema: string | null;
	readonly collationProvider: string | null;
	readonly collationVersion: string | null;
	readonly attidentity: string | null;
	readonly identity: 'always' | 'byDefault' | null;
	readonly attgenerated: string | null;
	readonly comment: string | null;
	readonly unique: boolean | null;
	readonly uniqueConstraintName: string | null;
	readonly autoIncrement: boolean | null;
};

const GUARD_STATEMENT_TIMEOUT_MS = 5000;
const STALE_EXPECTED_COLUMN_SHAPE_REASON =
	'the target column no longer matches the compared desired shape; the recognized pure-nullability tightening is stale - replan against fresh state';

type ColumnShapeGuardFailure = {
	readonly field: string;
	readonly detail: string;
};

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
	const { table, column, schema, expectedColumnShape } = operation.payload;
	if (typeof table !== 'string' || typeof column !== 'string') {
		throw new Error('AlterColumnSetNotNull payload requires table and column');
	}
	if (schema != null && typeof schema !== 'string') {
		throw new Error(
			'AlterColumnSetNotNull schema must be a string when present',
		);
	}
	if (
		expectedColumnShape != null &&
		!isSetNotNullColumnShapeExpectation(expectedColumnShape)
	) {
		throw new Error(
			'AlterColumnSetNotNull expectedColumnShape must be a structured column shape expectation when present',
		);
	}
	const payload = schema ? { table, column, schema } : { table, column };
	validateIdentifier(payload.table, 'table');
	validateIdentifier(payload.column, 'column');
	if (payload.schema) {
		validateIdentifier(payload.schema, 'schema');
	}
	return expectedColumnShape ? { ...payload, expectedColumnShape } : payload;
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

function fact(key: string, value: unknown) {
	return {
		key,
		value: typeof value === 'string' ? value : stableJson(value),
	};
}

function originalDbTypeSchemaScope(
	payload: AlterColumnSetNotNullPayload,
	typeSchema: string | null,
): 'target' | 'absolute' | null {
	if (!typeSchema || typeSchema === 'pg_catalog') {
		return null;
	}
	return typeSchema === explicitSchema(payload) ? 'target' : 'absolute';
}

function structuralFailure(
	field: string,
	detail: string,
): ColumnShapeGuardFailure {
	return { field, detail };
}

function equivalenceFailure(
	field: string,
	result: EquivalenceResult,
): ColumnShapeGuardFailure | undefined {
	if (result.kind === 'equivalent') {
		return undefined;
	}
	if (result.kind === 'different') {
		return {
			field,
			detail: `${field} is semantically different`,
		};
	}
	const firstDetail = result.obligations[0]?.proposition.detail;
	return {
		field,
		detail:
			firstDetail == null
				? `${field} equivalence is unresolved`
				: `${field} equivalence is unresolved: ${stableJson(firstDetail)}`,
	};
}

function assertDefaultUnknownSkipInvariant(
	expected: SetNotNullColumnShapeExpectation,
	observed: SetNotNullObservedColumnShape,
	catalog: CatalogValue,
): void {
	if (
		expected.default == null ||
		observed.default == null ||
		catalog.hasDefault !== true ||
		catalog.defaultExpression == null
	) {
		throw new Error(
			`${STALE_EXPECTED_COLUMN_SHAPE_REASON}; field default: default value comparison was unresolved without the required default-presence and fingerprint facts`,
		);
	}
}

function columnDefaultDeparseResource(
	payload: AlterColumnSetNotNullPayload,
	context: ObservationContext,
): ResourceAddress {
	return {
		engine: 'postgresql',
		database: context.databaseId,
		schema: schemaFor(payload, context),
		kind: 'column',
		name: payload.column,
		qualifiedBy: [payload.table],
	};
}

function columnDefaultDeparseRequest(
	payload: AlterColumnSetNotNullPayload,
	expected: SetNotNullColumnShapeExpectation,
	observed: SetNotNullObservedColumnShape,
	context: ObservationContext,
): ObservationRequest | undefined {
	if (expected.default == null || observed.default == null) {
		return undefined;
	}
	return {
		kind: EXPRESSION_DEPARSE_OBSERVATION,
		scope: [columnDefaultDeparseResource(payload, context)],
		detail: {
			surface: 'column-default',
			category: 'scalar',
			table: payload.table,
			column: payload.column,
			schema: schemaFor(payload, context),
			left: expected.default as unknown as JsonValue,
			right: observed.default as unknown as JsonValue,
		},
	};
}

function setNotNullEquivalenceContext(
	payload: AlterColumnSetNotNullPayload,
	expected: SetNotNullColumnShapeExpectation,
	observed: SetNotNullObservedColumnShape,
	context: ObservationContext,
): EquivalenceContext & { readonly deparseRequest?: ObservationRequest } {
	const targetSchema = schemaFor(payload, context);
	const proofObservationContext =
		context.targetSchema === targetSchema
			? context
			: { ...context, targetSchema };
	const base = {
		engine: context.engine,
		databaseId: context.databaseId,
		targetSchema,
		...(context.searchPath ? { searchPath: context.searchPath } : {}),
		proofObservationContext,
	};
	const request = columnDefaultDeparseRequest(
		payload,
		expected,
		observed,
		context,
	);
	return request ? { ...base, deparseRequest: request } : base;
}

function setNotNullShapeGuardFailures(
	expected: SetNotNullColumnShapeExpectation,
	observed: SetNotNullObservedColumnShape,
	catalog: CatalogValue,
	context: EquivalenceContext & {
		readonly deparseRequest?: ObservationRequest;
	},
	evidence: readonly EvidenceObservation[],
): readonly ColumnShapeGuardFailure[] {
	const failures: ColumnShapeGuardFailure[] = [];
	if (expected.name !== observed.name) {
		failures.push(structuralFailure('name', 'column name changed'));
	}
	if (expected.nullability.to !== false) {
		failures.push(
			structuralFailure(
				'nullability.to',
				'desired column is not a SET NOT NULL target',
			),
		);
	}
	if (observed.nullable !== expected.nullability.from) {
		failures.push(
			structuralFailure(
				'nullability.from',
				'observed column is not currently nullable',
			),
		);
	}
	if (expected.identity !== observed.identity) {
		failures.push(structuralFailure('identity', 'identity changed'));
	}
	if (expected.generated !== observed.generated) {
		failures.push(
			structuralFailure('generated', 'generated column state changed'),
		);
	}
	if (expected.autoIncrement !== observed.autoIncrement) {
		failures.push(
			structuralFailure('autoIncrement', 'auto-increment state changed'),
		);
	}
	if (expected.unique !== observed.unique) {
		failures.push(structuralFailure('unique', 'unique state changed'));
	}
	if (expected.comment !== observed.comment) {
		failures.push(structuralFailure('comment', 'column comment changed'));
	}

	const equivalence = createPgEquivalenceCapability();
	const typeFailure = equivalenceFailure(
		'type',
		equivalence.compareType(expected.type, observed.type, context, evidence),
	);
	if (typeFailure) {
		failures.push(typeFailure);
	}

	if (expected.default == null && observed.default != null) {
		failures.push(
			structuralFailure('default.presence', 'default expression added'),
		);
	} else if (expected.default != null && observed.default == null) {
		failures.push(
			structuralFailure('default.presence', 'default expression removed'),
		);
	} else if (expected.default != null && observed.default != null) {
		const defaultResult = equivalence.compareExpression(
			expected.default,
			observed.default,
			'scalar',
			context,
			evidence,
		);
		if (defaultResult.kind === 'unknown') {
			// DEFAULT value is the only deliberately relaxed field in this stale-shape
			// guard. Its value is fingerprinted (`column.default` and
			// `pg_attrdef.expression`) and the SET NOT NULL recognizer only emits this
			// operation after drafting the corresponding default-equivalence claim
			// (possibly under author attestation). Widening this relaxation to any
			// other field requires threading claim coverage into buildFingerprints.
			assertDefaultUnknownSkipInvariant(expected, observed, catalog);
		} else {
			const defaultFailure = equivalenceFailure('default', defaultResult);
			if (defaultFailure) {
				failures.push(defaultFailure);
			}
		}
	}

	const collationFailure = equivalenceFailure(
		'collation',
		equivalence.compareCollation(
			expected.collation,
			observed.collation,
			context,
			evidence,
		),
	);
	if (collationFailure) {
		failures.push(collationFailure);
	}

	return failures;
}

function assertExpectedColumnShape(
	payload: AlterColumnSetNotNullPayload,
	catalog: CatalogValue,
	context: ObservationContext,
	evidence: readonly EvidenceObservation[],
): void {
	if (!payload.expectedColumnShape) {
		throw new Error(
			`missing expected column shape; ${STALE_EXPECTED_COLUMN_SHAPE_REASON}`,
		);
	}
	const observed = columnShapeFromCatalog(catalog, payload.column);
	const failures = setNotNullShapeGuardFailures(
		payload.expectedColumnShape,
		observed,
		catalog,
		setNotNullEquivalenceContext(
			payload,
			payload.expectedColumnShape,
			observed,
			context,
		),
		evidence,
	);
	if (failures.length > 0) {
		const first =
			failures[0] ??
			structuralFailure('unknown', 'unknown column shape guard failure');
		const rest = failures.slice(1);
		const additional =
			rest.length === 0
				? ''
				: `; additional fields ${rest.map((item) => item.field).join(', ')}`;
		throw new Error(
			`${STALE_EXPECTED_COLUMN_SHAPE_REASON}; field ${first.field}: ${first.detail}${additional}`,
		);
	}
}

function collationFacts(catalog: CatalogValue) {
	if (!catalog.attcollation || catalog.attcollation === '0') {
		return [];
	}
	return [
		fact('column.collation.oid', catalog.attcollation),
		fact('column.collation.name', catalog.collationName),
		fact('column.collation.schema', catalog.collationSchema),
		fact('pg_collation.provider', catalog.collationProvider),
		fact('pg_collation.version', catalog.collationVersion),
	];
}

function targetPrivilegeFacts(
	payload: AlterColumnSetNotNullPayload,
	context: ObservationContext,
) {
	const schema = schemaFor(payload, context);
	return [
		fact(
			`context.privilege.${PG_SCHEMA_USAGE_PRIVILEGE}`,
			pgPrivilegeValue(context, PG_SCHEMA_USAGE_PRIVILEGE, [schema]),
		),
		fact(
			`context.privilege.${PG_TABLE_ALTER_AUTHORITY_PRIVILEGE}`,
			pgPrivilegeValue(context, PG_TABLE_ALTER_AUTHORITY_PRIVILEGE, [
				schema,
				payload.table,
			]),
		),
		fact(
			`context.privilege.${PG_SET_NOT_NULL_AUTHORITY_PRIVILEGE}`,
			pgPrivilegeValue(context, PG_SET_NOT_NULL_AUTHORITY_PRIVILEGE, [
				schema,
				payload.table,
				payload.column,
			]),
		),
	];
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
		if (
			!observationTargetsPayload(observation, payload, context) ||
			!observationContextMatches(observation, context)
		) {
			continue;
		}
		const value = observation.result.value;
		if (!isRecord(value)) {
			continue;
		}
		const exists = value.exists;
		const relkind = value.relkind;
		const nullable = value.nullable;
		const oid = value.oid;
		const attnum = value.attnum;
		const atttypid = value.atttypid;
		const atttypmod = value.atttypmod;
		const formatType = value.formatType;
		const typeName = value.typeName;
		const typeSchema = value.typeSchema;
		const hasDefault = value.hasDefault;
		const defaultExpression = value.defaultExpression;
		const attcollation = value.attcollation;
		const collationName = value.collationName;
		const collationSchema = value.collationSchema;
		const collationProvider = value.collationProvider;
		const collationVersion = value.collationVersion;
		const attidentity = value.attidentity;
		const identity = value.identity;
		const attgenerated = value.attgenerated;
		const comment = value.comment;
		const unique = value.unique;
		const uniqueConstraintName = value.uniqueConstraintName;
		const autoIncrement = value.autoIncrement;
		if (
			typeof exists === 'boolean' &&
			(relkind === null || typeof relkind === 'string') &&
			(nullable === null || typeof nullable === 'boolean') &&
			(oid === null || typeof oid === 'string') &&
			(attnum === null || typeof attnum === 'number') &&
			(atttypid === null || typeof atttypid === 'string') &&
			(atttypmod === null || typeof atttypmod === 'number') &&
			(formatType === null || typeof formatType === 'string') &&
			(typeName === null || typeof typeName === 'string') &&
			(typeSchema === null || typeof typeSchema === 'string') &&
			(hasDefault === null || typeof hasDefault === 'boolean') &&
			(defaultExpression === null || typeof defaultExpression === 'string') &&
			(attcollation === null || typeof attcollation === 'string') &&
			(collationName === null || typeof collationName === 'string') &&
			(collationSchema === null || typeof collationSchema === 'string') &&
			(collationProvider === null || typeof collationProvider === 'string') &&
			(collationVersion === null || typeof collationVersion === 'string') &&
			(attidentity === null || typeof attidentity === 'string') &&
			(identity === null ||
				identity === 'always' ||
				identity === 'byDefault') &&
			(attgenerated === null || typeof attgenerated === 'string') &&
			(comment === null || typeof comment === 'string') &&
			(unique === null || typeof unique === 'boolean') &&
			(uniqueConstraintName === null ||
				typeof uniqueConstraintName === 'string') &&
			(autoIncrement === null || typeof autoIncrement === 'boolean')
		) {
			return {
				exists,
				relkind,
				nullable,
				oid,
				attnum,
				atttypid,
				atttypmod,
				formatType,
				typeName,
				typeSchema,
				hasDefault,
				defaultExpression,
				attcollation,
				collationName,
				collationSchema,
				collationProvider,
				collationVersion,
				attidentity,
				identity,
				attgenerated,
				comment,
				unique,
				uniqueConstraintName,
				autoIncrement,
			};
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
		fact('target.schema', schemaFor(payload, context)),
		fact('target.table', payload.table),
		fact('target.column', payload.column),
		fact('column.name', payload.column),
		fact('pg_class.oid', catalog.oid),
		fact('pg_class.relkind', catalog.relkind),
		fact('pg_attribute.attnum', catalog.attnum),
		fact('column.nullable', nullable),
		fact('pg_attribute.atttypid', catalog.atttypid),
		fact('pg_attribute.atttypmod', catalog.atttypmod),
		fact('pg_catalog.format_type', catalog.formatType),
		fact('pg_type.typname', catalog.typeName),
		fact('pg_type.typnamespace', catalog.typeSchema),
		fact('column.type', {
			atttypid: catalog.atttypid,
			atttypmod: catalog.atttypmod,
			formatType: catalog.formatType,
		}),
		fact('column.originalDbType', catalog.formatType),
		fact(
			'column.originalDbTypeSchema',
			catalog.typeSchema === 'pg_catalog' ? null : catalog.typeSchema,
		),
		fact(
			'column.originalDbTypeSchemaScope',
			originalDbTypeSchemaScope(payload, catalog.typeSchema),
		),
		fact('column.default', {
			hasDefault: catalog.hasDefault,
			expression: catalog.defaultExpression,
		}),
		fact('pg_attrdef.exists', catalog.hasDefault),
		fact('pg_attrdef.expression', catalog.defaultExpression),
		fact('pg_attribute.attidentity', catalog.attidentity),
		fact('column.identity', catalog.identity),
		fact('pg_attribute.attgenerated', catalog.attgenerated),
		fact('column.generated', catalog.attgenerated),
		fact('pg_attribute.attcollation', catalog.attcollation),
		fact(
			'column.collation',
			catalog.attcollation && catalog.attcollation !== '0'
				? {
						oid: catalog.attcollation,
						name: catalog.collationName,
						schema: catalog.collationSchema,
					}
				: null,
		),
		fact('pg_constraint.unique.exists', catalog.unique),
		fact('column.unique', catalog.unique),
		fact('pg_description.column', catalog.comment),
		fact('column.comment', catalog.comment),
		fact('pg_depend.owned-sequence.exists', catalog.autoIncrement),
		fact('column.autoIncrement', catalog.autoIncrement),
		...collationFacts(catalog),
		fact('context.engine', context.engine),
		fact('context.engineVersion', context.engineVersion),
		fact('context.databaseId', context.databaseId),
		fact('context.effectiveRole', context.effectiveRole ?? null),
		fact(
			`context.capability.${ALTER_COLUMN_SET_NOT_NULL_CAPABILITY}.available`,
			context.capabilities.includes(ALTER_COLUMN_SET_NOT_NULL_CAPABILITY),
		),
		...targetPrivilegeFacts(payload, context),
	];
	const excludedOrUnknownFacts = [
		{
			key: 'relation.sibling-columns-indexes-constraints',
			reason:
				'sibling columns, multi-column indexes, multi-column constraints, RLS and triggers are outside the per-column recognizer comparison - bounded by the external-ddl-exclusion assumption',
		},
		{
			key: 'column.uniqueConstraintName',
			reason:
				'unique constraint names are metadata; the structural unique boolean is compared and fingerprinted, while generated-name drift is bounded by the external-ddl-exclusion assumption',
		},
		{
			key: 'pg_constraint.unique.name',
			reason:
				'catalog unique constraint names are metadata excluded from shape equality and bounded by the external-ddl-exclusion assumption',
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
	assertExpectedColumnShape(payload, catalog, context, evidence);
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

function guardTargetsPayload(
	guard: ApplyGuard,
	payload: AlterColumnSetNotNullPayload,
	context: ObservationContext,
): boolean {
	if (guard.predicate.kind !== NO_NULLS_GUARD) {
		return false;
	}
	if (!isRecord(guard.predicate.detail)) {
		return false;
	}
	return (
		guard.predicate.detail.schema === schemaFor(payload, context) &&
		guard.predicate.detail.table === payload.table &&
		guard.predicate.detail.column === payload.column &&
		sameResourceTarget(guard.predicate.target, payload, context) &&
		guard.predicate.scope.some((resource) =>
			sameResourceTarget(resource, payload, context),
		)
	);
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
			const payload = payloadOf(operation);
			return readPgObservationContext(
				client.opaqueClient,
				explicitSchema(payload),
				payload,
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
			const payload = payloadOf(operation);
			if (!guardTargetsPayload(guard, payload, context)) {
				throw new Error(
					'AlterColumnSetNotNull NO_NULLS guard does not target the operation payload',
				);
			}
			const executor = clientQuery(client);
			await executor.query(
				`SET LOCAL statement_timeout = '${boundedStatementTimeout(
					GUARD_STATEMENT_TIMEOUT_MS,
				)}ms'`,
			);
			let result: QueryResultLike;
			try {
				result = await executor.query(renderNoNullsCheckSql(payload, context));
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
			return (
				isRecord(error) &&
				(error.code === '55P03' || error.code === 'DBSP_GUARD_TIMEOUT')
			);
		},
	};
}
