import { createHash } from 'node:crypto';
import type {
	AdvisoryObservation,
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
	VendorValidatedExpression,
} from '@dbsp/types';
import { validateCheckExpression, validateIdentifier } from '../../validate.js';
import {
	ALTER_TABLE_ADD_CHECK_CAPABILITY,
	ALTER_TABLE_ADD_CHECK_OPERATION_KIND,
	CHECK_CONSTRAINT_ABSENT_OBSERVATION,
	CHECK_ROWS_SATISFY_GUARD,
	PG_DEPARSE_ARTIFACT,
	PG_OPERATION_PACK_ARTIFACT,
	PG_SCHEMA_USAGE_PRIVILEGE,
	PG_TABLE_ALTER_AUTHORITY_PRIVILEGE,
	TABLE_CHECK_CONSTRAINTS_OBSERVATION,
} from '../constants.js';
import { observationContextMatches } from '../context-match.js';
import { advisoryObservationId, assumptionId } from '../ids.js';
import {
	appendCompletionJournal,
	appendIntentJournal,
	appendObservedJournal,
} from '../journal.js';
import { readPgObservationContext } from '../observation-issuer.js';
import { pgPrivilegeValue } from '../privileges.js';
import { stableJson } from '../stable-json.js';

export type CheckSet = {
	readonly name: string;
	readonly oid: string | null;
	readonly expression: string;
	readonly predicate: string;
	readonly notValid: boolean;
};

export type AlterTableAddCheckPayload = {
	readonly schema: string;
	readonly table: string;
	readonly constraint: string;
	readonly expression: VendorValidatedExpression;
	readonly predicate: VendorValidatedExpression;
	readonly expectedBefore: readonly CheckSet[];
	readonly expectedAfter: readonly CheckSet[];
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

type CheckCatalogValue = {
	readonly exists: boolean;
	readonly oid: string | null;
	readonly relkind: string | null;
	readonly schema: string | null;
	readonly table: string | null;
	readonly checks: readonly CheckSet[];
};

const GUARD_STATEMENT_TIMEOUT_MS = 5000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isArtifact(value: unknown): value is { id: string; version: string } {
	return (
		isRecord(value) &&
		typeof value.id === 'string' &&
		typeof value.version === 'string'
	);
}

function sameArtifact(
	left: { readonly id: string; readonly version: string },
	right: { readonly id: string; readonly version: string },
): boolean {
	return left.id === right.id && left.version === right.version;
}

function quoteIdent(
	value: string,
	type: 'table' | 'column' | 'schema' | 'alias',
): string {
	validateIdentifier(value, type);
	return `"${value.replaceAll('"', '""')}"`;
}

function assertStandardConformingStrings(context: ObservationContext): void {
	if (context.sessionConfiguration.standard_conforming_strings !== 'on') {
		throw new Error(
			'AlterTableAddCheck requires standard_conforming_strings=on before rendering CHECK expressions',
		);
	}
}

function checkHasUnsupportedShape(
	check: Pick<CheckSet, 'expression'>,
): boolean {
	return (
		/\bNOT\s+VALID\b/iu.test(check.expression) ||
		/\bNO\s+INHERIT\b/iu.test(check.expression)
	);
}

function vendorExpression(
	value: unknown,
	field: 'expression' | 'predicate',
): VendorValidatedExpression {
	if (
		!isRecord(value) ||
		value.kind !== 'vendor-validated' ||
		value.category !== 'predicate' ||
		!isArtifact(value.validatedBy) ||
		!sameArtifact(value.validatedBy, PG_DEPARSE_ARTIFACT) ||
		typeof value.text !== 'string'
	) {
		throw new Error(
			`AlterTableAddCheck ${field} must be a predicate VendorValidatedExpression validated by PostgreSQL deparse`,
		);
	}
	if (field === 'expression') {
		if (!/^\s*CHECK\s*\(/iu.test(value.text)) {
			throw new Error(
				'AlterTableAddCheck expression must be a full CHECK clause',
			);
		}
		validateCheckExpression(value.text, 'validated table CHECK clause');
		if (checkHasUnsupportedShape({ expression: value.text })) {
			throw new Error(
				'AlterTableAddCheck does not support NOT VALID or NO INHERIT',
			);
		}
	} else {
		validateCheckExpression(
			`CHECK (${value.text})`,
			'validated table CHECK predicate',
		);
	}
	return {
		kind: 'vendor-validated',
		category: 'predicate',
		validatedBy: PG_DEPARSE_ARTIFACT,
		text: value.text,
	};
}

function checkSetEntry(value: unknown, field: string): CheckSet {
	if (!isRecord(value)) {
		throw new Error(`AlterTableAddCheck ${field} entry must be an object`);
	}
	const { name, oid, expression, predicate, notValid } = value;
	if (
		typeof name !== 'string' ||
		!(oid === null || typeof oid === 'string') ||
		typeof expression !== 'string' ||
		typeof predicate !== 'string' ||
		typeof notValid !== 'boolean'
	) {
		throw new Error(
			`AlterTableAddCheck ${field} entry requires name, oid, expression, predicate and notValid`,
		);
	}
	validateIdentifier(name, 'alias');
	validateCheckExpression(expression, `${field} CHECK expression`);
	validateCheckExpression(`CHECK (${predicate})`, `${field} CHECK predicate`);
	if (notValid || checkHasUnsupportedShape({ expression })) {
		throw new Error(
			'AlterTableAddCheck does not support NOT VALID or NO INHERIT',
		);
	}
	return { name, oid, expression, predicate, notValid };
}

function checkSet(value: unknown, field: string): readonly CheckSet[] {
	if (!Array.isArray(value)) {
		throw new Error(`AlterTableAddCheck ${field} must be an array`);
	}
	const checks = value.map((entry, index) =>
		checkSetEntry(entry, `${field}[${index}]`),
	);
	const names = new Set(checks.map((check) => check.name));
	if (names.size !== checks.length) {
		throw new Error(
			`AlterTableAddCheck ${field} contains duplicate CHECK names`,
		);
	}
	return [...checks].sort((left, right) => left.name.localeCompare(right.name));
}

function assertPayloadCheckSets(payload: AlterTableAddCheckPayload): void {
	if (
		payload.expectedBefore.some((check) => check.name === payload.constraint)
	) {
		throw new Error(
			'AlterTableAddCheck target constraint must be absent in expectedBefore',
		);
	}
	const targetAfter = payload.expectedAfter.filter(
		(check) => check.name === payload.constraint,
	);
	if (targetAfter.length !== 1) {
		throw new Error(
			'AlterTableAddCheck target constraint must be present exactly once in expectedAfter',
		);
	}
	if (payload.expectedAfter.length !== payload.expectedBefore.length + 1) {
		throw new Error(
			'AlterTableAddCheck expectedAfter must add exactly one CHECK',
		);
	}
	const beforeByName = new Map(
		payload.expectedBefore.map((check) => [check.name, check]),
	);
	for (const check of payload.expectedAfter) {
		if (check.name === payload.constraint) {
			if (
				check.expression !== payload.expression.text ||
				check.predicate !== payload.predicate.text
			) {
				throw new Error(
					'AlterTableAddCheck expectedAfter target must match validated expressions',
				);
			}
			continue;
		}
		const before = beforeByName.get(check.name);
		if (!before || stableJson(before) !== stableJson(check)) {
			throw new Error(
				'AlterTableAddCheck expectedAfter must preserve existing CHECK set entries',
			);
		}
	}
}

function payloadOf(operation: PhysicalOperation): AlterTableAddCheckPayload {
	if (
		operation.operationKind.artifact.id !== PG_OPERATION_PACK_ARTIFACT.id ||
		operation.operationKind.artifact.version !==
			PG_OPERATION_PACK_ARTIFACT.version ||
		operation.operationKind.name !== ALTER_TABLE_ADD_CHECK_OPERATION_KIND.name
	) {
		throw new Error('unsupported operation kind for AlterTableAddCheck');
	}
	if (!isRecord(operation.payload)) {
		throw new Error('AlterTableAddCheck payload must be an object');
	}
	const {
		schema,
		table,
		constraint,
		expression,
		predicate,
		expectedBefore,
		expectedAfter,
	} = operation.payload;
	if (
		typeof schema !== 'string' ||
		typeof table !== 'string' ||
		typeof constraint !== 'string'
	) {
		throw new Error(
			'AlterTableAddCheck payload requires schema, table and constraint',
		);
	}
	validateIdentifier(schema, 'schema');
	validateIdentifier(table, 'table');
	validateIdentifier(constraint, 'alias');
	const payload = {
		schema,
		table,
		constraint,
		expression: vendorExpression(expression, 'expression'),
		predicate: vendorExpression(predicate, 'predicate'),
		expectedBefore: checkSet(expectedBefore, 'expectedBefore'),
		expectedAfter: checkSet(expectedAfter, 'expectedAfter'),
	};
	assertPayloadCheckSets(payload);
	return payload;
}

function tableSql(payload: AlterTableAddCheckPayload): string {
	return `${quoteIdent(payload.schema, 'schema')}.${quoteIdent(
		payload.table,
		'table',
	)}`;
}

export function renderAlterTableAddCheckSql(
	payload: AlterTableAddCheckPayload,
	context: ObservationContext,
): string {
	assertStandardConformingStrings(context);
	payloadOf({
		ref: 'validation',
		operationKind: ALTER_TABLE_ADD_CHECK_OPERATION_KIND,
		payload: payload as never,
	});
	return `ALTER TABLE ${tableSql(payload)} ADD CONSTRAINT ${quoteIdent(
		payload.constraint,
		'alias',
	)} ${payload.expression.text}`;
}

export function renderAddCheckLockSql(
	payload: AlterTableAddCheckPayload,
): string {
	return `LOCK TABLE ${tableSql(payload)} IN ACCESS EXCLUSIVE MODE`;
}

export function renderCheckRowsSatisfySql(
	payload: AlterTableAddCheckPayload,
	context: ObservationContext,
): string {
	assertStandardConformingStrings(context);
	return `SELECT 1 FROM ${tableSql(payload)} WHERE (${payload.predicate.text}) IS FALSE LIMIT 1`;
}

function tableResource(
	payload: AlterTableAddCheckPayload,
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

function checkResource(
	payload: AlterTableAddCheckPayload,
	context?: ObservationContext,
): ResourceAddress {
	return {
		engine: 'postgresql',
		database: context?.databaseId ?? 'unknown',
		schema: payload.schema,
		kind: 'check-constraint',
		name: payload.constraint,
		qualifiedBy: [payload.table],
	};
}

export function operationPackSemanticsAssumption(
	payload: AlterTableAddCheckPayload,
	context: ObservationContext,
): Assumption {
	return {
		id: assumptionId(
			`dbsp.postgresql.operations.pg18@0.1.0#semantics:${JSON.stringify([
				payload.schema,
				payload.table,
				payload.constraint,
			])}`,
		),
		class: 'operation-pack-semantics',
		asserter: { kind: 'pack', artifact: PG_OPERATION_PACK_ARTIFACT },
		statement:
			'PostgreSQL AlterTableAddCheck renderer, lock, guard, failure, and effect semantics are correct for this operation payload.',
		scope: [tableResource(payload, context), checkResource(payload, context)],
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
	payload: AlterTableAddCheckPayload,
	context: ObservationContext,
): boolean {
	if (request.kind !== TABLE_CHECK_CONSTRAINTS_OBSERVATION) {
		return false;
	}
	if (!isRecord(request.detail)) {
		return false;
	}
	if (
		request.detail.schema !== payload.schema ||
		request.detail.table !== payload.table ||
		request.detail.constraint !== payload.constraint
	) {
		return false;
	}
	return request.scope.some((resource) =>
		sameTableResource(resource, payload, context),
	);
}

function sameTableResource(
	resource: ResourceAddress,
	payload: AlterTableAddCheckPayload,
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

function sameCheckResource(
	resource: ResourceAddress,
	payload: AlterTableAddCheckPayload,
	context: ObservationContext,
): boolean {
	return (
		resource.engine === 'postgresql' &&
		resource.database === context.databaseId &&
		resource.schema === payload.schema &&
		resource.kind === 'check-constraint' &&
		resource.name === payload.constraint &&
		resource.qualifiedBy?.length === 1 &&
		resource.qualifiedBy[0] === payload.table
	);
}

function catalogValueTargetsPayload(
	value: Record<string, unknown>,
	payload: AlterTableAddCheckPayload,
): boolean {
	return value.schema === payload.schema && value.table === payload.table;
}

function canonicalCheck(check: CheckSet): CheckSet {
	return {
		name: check.name,
		oid: check.oid,
		expression: check.expression,
		predicate: check.predicate,
		notValid: check.notValid,
	};
}

function canonicalObservedCheckSet(
	value: unknown,
): readonly CheckSet[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const checks: CheckSet[] = [];
	for (const item of value) {
		if (!isRecord(item)) {
			return undefined;
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
			return undefined;
		}
		checks.push({
			name: item.name,
			oid: item.oid,
			expression: item.expression,
			predicate,
			notValid: item.notValid,
		});
	}
	return checks.sort((left, right) => left.name.localeCompare(right.name));
}

function catalogValueFromEvidence(
	evidence: readonly EvidenceObservation[],
	payload: AlterTableAddCheckPayload,
	context: ObservationContext,
): CheckCatalogValue | undefined {
	for (const observation of evidence) {
		if (
			!requestTargetsPayload(observation.request, payload, context) ||
			!observationContextMatches(observation, context)
		) {
			continue;
		}
		const value = observation.result.value;
		if (!isRecord(value) || !catalogValueTargetsPayload(value, payload)) {
			continue;
		}
		const checks = canonicalObservedCheckSet(value.checks);
		if (
			typeof value.exists === 'boolean' &&
			(value.oid === null || typeof value.oid === 'string') &&
			(value.relkind === null || typeof value.relkind === 'string') &&
			(value.schema === null || typeof value.schema === 'string') &&
			(value.table === null || typeof value.table === 'string') &&
			checks !== undefined
		) {
			return {
				exists: value.exists,
				oid: value.oid,
				relkind: value.relkind,
				schema: value.schema,
				table: value.table,
				checks,
			};
		}
	}
	return undefined;
}

function targetPrivilegeFacts(
	payload: AlterTableAddCheckPayload,
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

function normalizedChecksForDigest(
	payload: AlterTableAddCheckPayload,
	checks: readonly CheckSet[],
	phase: 'before' | 'after',
): readonly CheckSet[] {
	const targetAfter = payload.expectedAfter.find(
		(check) => check.name === payload.constraint,
	);
	return checks
		.map((check) => {
			const canonical = canonicalCheck(check);
			return phase === 'after' &&
				canonical.name === payload.constraint &&
				targetAfter !== undefined
				? { ...canonical, oid: targetAfter.oid }
				: canonical;
		})
		.sort((left, right) => left.name.localeCompare(right.name));
}

function fingerprintFor(
	payload: AlterTableAddCheckPayload,
	context: ObservationContext,
	catalog: CheckCatalogValue,
	checks: readonly CheckSet[],
	phase: 'before' | 'after',
): FingerprintManifest {
	if (!catalog.exists || catalog.oid == null) {
		throw new Error('table catalog identity is missing');
	}
	if (catalog.schema !== payload.schema || catalog.table !== payload.table) {
		throw new Error('table check catalog identity does not target the payload');
	}
	if (catalog.relkind !== 'r') {
		throw new Error('AlterTableAddCheck only supports ordinary tables');
	}
	const normalizedChecks = normalizedChecksForDigest(payload, checks, phase);
	const includedFacts = [
		fact('target.schema', payload.schema),
		fact('target.table', payload.table),
		fact('target.constraint', payload.constraint),
		fact('pg_class.oid', catalog.oid),
		fact('pg_class.relkind', catalog.relkind),
		fact('table.checks.sorted', normalizedChecks),
		...normalizedChecks.flatMap((check) => [
			fact(`pg_constraint.${check.name}.name`, check.name),
			fact(`pg_constraint.${check.name}.oid`, check.oid),
			fact(`pg_constraint.${check.name}.expression`, check.expression),
			fact(`pg_constraint.${check.name}.predicate`, check.predicate),
			fact(`pg_constraint.${check.name}.notValid`, check.notValid),
		]),
		fact('context.engine', context.engine),
		fact('context.engineVersion', context.engineVersion),
		fact('context.databaseId', context.databaseId),
		fact('context.effectiveRole', context.effectiveRole ?? null),
		fact(
			`context.capability.${ALTER_TABLE_ADD_CHECK_CAPABILITY}.available`,
			context.capabilities.includes(ALTER_TABLE_ADD_CHECK_CAPABILITY),
		),
		fact(
			'context.session.standard_conforming_strings',
			context.sessionConfiguration.standard_conforming_strings ?? null,
		),
		...targetPrivilegeFacts(payload, context),
	];
	return {
		algorithm: 'sha256:stable-json',
		semanticModel: PG_OPERATION_PACK_ARTIFACT,
		includedFacts,
		excludedOrUnknownFacts:
			phase === 'after'
				? [
						{
							key: `pg_constraint.${payload.constraint}.oid.actual`,
							reason:
								'the new CHECK constraint OID is allocated by PostgreSQL during ADD CONSTRAINT; the post-apply catalog observation carries it, while the planned expectedAfter digest binds the new constraint by name, table, expression and predicate',
						},
					]
				: [],
		digest: digest(includedFacts),
	};
}

function assertObservedChecks(
	observed: readonly CheckSet[],
	expected: readonly CheckSet[],
	phase: 'before' | 'after',
	payload: AlterTableAddCheckPayload,
): void {
	const normalizedObserved = normalizedChecksForDigest(
		payload,
		observed,
		phase,
	);
	const normalizedExpected = normalizedChecksForDigest(
		payload,
		expected,
		phase,
	);
	if (stableJson(normalizedObserved) !== stableJson(normalizedExpected)) {
		throw new Error(
			`expected ${phase} CHECK set ${stableJson(
				normalizedExpected,
			)} but observed ${stableJson(normalizedObserved)}`,
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
		throw new Error('missing table CHECK catalog evidence');
	}
	assertObservedChecks(
		catalog.checks,
		payload.expectedBefore,
		'before',
		payload,
	);
	return {
		expectedBefore: fingerprintFor(
			payload,
			context,
			catalog,
			payload.expectedBefore,
			'before',
		),
		expectedAfter: fingerprintFor(
			payload,
			context,
			catalog,
			payload.expectedAfter,
			'after',
		),
	};
}

function observedFingerprint(
	operation: PhysicalOperation,
	observation: IssuedObservation,
	context: ObservationContext,
	phase: 'before' | 'after',
): FingerprintManifest {
	if (observation.role !== 'evidence') {
		throw new Error('table CHECK catalog observation must be durable evidence');
	}
	const payload = payloadOf(operation);
	const catalog = catalogValueFromEvidence([observation], payload, context);
	if (!catalog) {
		throw new Error('table CHECK catalog observation did not include checks');
	}
	if (phase === 'before') {
		assertObservedChecks(
			catalog.checks,
			payload.expectedBefore,
			'before',
			payload,
		);
		return fingerprintFor(payload, context, catalog, catalog.checks, 'before');
	}
	assertObservedChecks(catalog.checks, payload.expectedAfter, 'after', payload);
	return fingerprintFor(payload, context, catalog, catalog.checks, 'after');
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

function boundedStatementTimeout(maxWaitMs: number): number {
	if (!Number.isFinite(maxWaitMs)) {
		return GUARD_STATEMENT_TIMEOUT_MS;
	}
	return Math.max(1, Math.min(Math.trunc(maxWaitMs), 600_000));
}

function guardTargetsPayload(
	guard: ApplyGuard,
	payload: AlterTableAddCheckPayload,
	context: ObservationContext,
): boolean {
	if (guard.predicate.kind !== CHECK_ROWS_SATISFY_GUARD) {
		return false;
	}
	if (!isRecord(guard.predicate.detail)) {
		return false;
	}
	return (
		guard.predicate.detail.schema === payload.schema &&
		guard.predicate.detail.table === payload.table &&
		guard.predicate.detail.constraint === payload.constraint &&
		sameCheckResource(guard.predicate.target, payload, context) &&
		guard.predicate.scope.some((resource) =>
			sameCheckResource(resource, payload, context),
		)
	);
}

function advisoryGuardObservation(
	guard: ApplyGuard,
	context: ObservationContext,
	passed: boolean,
): AdvisoryObservation {
	const request =
		guard.predicate.detail === undefined
			? {
					kind: CHECK_ROWS_SATISFY_GUARD,
					scope: guard.predicate.scope,
				}
			: {
					kind: CHECK_ROWS_SATISFY_GUARD,
					scope: guard.predicate.scope,
					detail: guard.predicate.detail,
				};
	return {
		role: 'advisory',
		id: advisoryObservationId(
			`dbsp.postgresql.guard.check-rows-satisfy:${Date.now()}:${passed ? 'pass' : 'fail'}`,
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

export function createAlterTableAddCheckOperationRuntime() {
	return {
		artifact: PG_OPERATION_PACK_ARTIFACT,
		operationKind: ALTER_TABLE_ADD_CHECK_OPERATION_KIND,
		supportsOperation(operation: PhysicalOperation) {
			return (
				operation.operationKind.artifact.id === PG_OPERATION_PACK_ARTIFACT.id &&
				operation.operationKind.artifact.version ===
					PG_OPERATION_PACK_ARTIFACT.version &&
				operation.operationKind.name ===
					ALTER_TABLE_ADD_CHECK_OPERATION_KIND.name
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
						{
							kind: 'expression-dependencies',
							within: checkResource(payload, context),
						},
					],
					writes: [
						{
							kind: 'check-constraint',
							name: payload.constraint,
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
							proposition: TABLE_CHECK_CONSTRAINTS_OBSERVATION,
							scope: {
								kind: 'table',
								schema: payload.schema,
								name: payload.table,
							},
						},
						{
							proposition: CHECK_CONSTRAINT_ABSENT_OBSERVATION,
							scope: {
								kind: 'check-constraint',
								name: payload.constraint,
								within: tableResource(payload, context),
							},
						},
					],
					contextMutations: [],
					externalEffects: {
						accountedFor: [
							{
								kind: 'check-constraint',
								name: payload.constraint,
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
		) {
			await clientQuery(client).query(
				renderAddCheckLockSql(payloadOf(operation)),
			);
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
				constraint: payload.constraint,
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
			const request: ObservationRequest = {
				kind: TABLE_CHECK_CONSTRAINTS_OBSERVATION,
				scope: [tableResource(payload, context)],
				detail: {
					schema: payload.schema,
					table: payload.table,
					constraint: payload.constraint,
				},
			};
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
					phase,
				),
			};
		},
		async checkGuard(
			client: TransitionExecutionClient,
			operation: PhysicalOperation,
			guard: ApplyGuard,
			context: ObservationContext,
		) {
			const payload = payloadOf(operation);
			if (!guardTargetsPayload(guard, payload, context)) {
				throw new Error(
					'AlterTableAddCheck CHECK_ROWS_SATISFY guard does not target the operation payload',
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
				result = await executor.query(
					renderCheckRowsSatisfySql(payload, context),
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
					'AlterTableAddCheck does not implement during-operation guards',
				);
			}
			await clientQuery(client).query(
				renderAlterTableAddCheckSql(payloadOf(operation), context),
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
