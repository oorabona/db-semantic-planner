import {
	createExecutionContract,
	type RegisteredOperationSemantics,
} from '@dbsp/core';
import type {
	ExecutionContract,
	ExecutionRequirement,
	PostgreSqlObservationTargetIdentity,
	ProvenPlanShape,
	TransitionSessionClient,
} from '@dbsp/types';
import {
	ALTER_COLUMN_SET_NOT_NULL_MIN_SERVER_VERSION_NUM,
	ALTER_COLUMN_SET_NOT_NULL_OPERATION_KIND,
	ALTER_TABLE_ADD_CHECK_MIN_SERVER_VERSION_NUM,
	ALTER_TABLE_ADD_CHECK_OPERATION_KIND,
	ALTER_TYPE_ADD_VALUE_MIN_SERVER_VERSION_NUM,
	ALTER_TYPE_ADD_VALUE_OPERATION_KIND,
	CREATE_UNIQUE_INDEX_CONCURRENTLY_MIN_SERVER_VERSION_NUM,
	CREATE_UNIQUE_INDEX_CONCURRENTLY_OPERATION_KIND,
} from './constants.js';
import { assertPgDatabaseWritable } from './database-writability.js';
import { readPgObservationContextFromClient } from './observation-issuer.js';
import { createPgTransitionPack } from './pack.js';

type Queryable = {
	query(
		sql: string,
		params?: readonly unknown[],
	): Promise<{
		readonly rows: readonly Record<string, unknown>[];
	}>;
};

type ExecutionContractOperationRuntime = RegisteredOperationSemantics & {
	readonly rendererSessionRequirements?: readonly {
		readonly setting: 'standard_conforming_strings';
		readonly value: 'on';
	}[];
};

/**
 * A proven operation may still be ineligible for a durable execution contract
 * when its reviewed requirements cannot be derived.  The CLI renders this as a
 * blocked assessment rather than treating it as an operational failure.
 */
export class PgExecutionContractDerivationError extends Error {
	constructor(
		readonly operationRef: string,
		readonly operationName: string,
		detail: string,
	) {
		super(
			`operation ${operationRef} (${operationName}) has no derivable execution contract: ${detail}`,
		);
		this.name = 'PgExecutionContractDerivationError';
	}
}

function queryable(target: TransitionSessionClient): Queryable {
	return target as unknown as Queryable;
}

function stringField(value: unknown, label: string): string {
	if (typeof value !== 'string' || value.length === 0)
		throw new Error(`PostgreSQL ${label} could not be read`);
	return value;
}

function quoted(value: string): string {
	return JSON.stringify(value);
}

/**
 * pg serializes text parameters as UTF-8.  A non-UTF-8 server session can
 * round-trip that byte sequence through node-postgres while storing a different
 * value, so observations and DDL must pin the server session to UTF-8 first.
 */
export async function forcePgUtf8Session(
	target: TransitionSessionClient,
): Promise<void> {
	const executor = queryable(target);
	await executor.query("SET client_encoding TO 'UTF8'");
	const value = String(
		(await executor.query('SHOW client_encoding')).rows[0]?.client_encoding ??
			'',
	);
	if (value !== 'UTF8')
		throw new Error(
			`PostgreSQL client_encoding expected ${quoted('UTF8')}, observed ${quoted(value || 'no value')}`,
		);
}

function compareNamespaceNames(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalNamespaceIdentities(
	namespaces: readonly { readonly name: string; readonly oid: string }[],
): readonly { readonly name: string; readonly oid: string }[] {
	const byName = new Map<string, string>();
	for (const namespace of namespaces) {
		const prior = byName.get(namespace.name);
		if (prior !== undefined && prior !== namespace.oid) {
			throw new Error(
				`PostgreSQL target namespace ${quoted(namespace.name)} has conflicting OIDs`,
			);
		}
		byName.set(namespace.name, namespace.oid);
	}
	return [...byName]
		.map(([name, oid]) => ({ name, oid }))
		.sort(
			(left, right) =>
				compareNamespaceNames(left.name, right.name) ||
				compareNamespaceNames(left.oid, right.oid),
		);
}

function stableJson(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
		.join(',')}}`;
}

/**
 * Compare namespace identities by name, rather than the incidental order in
 * which PostgreSQL or a persisted JSON document happened to return them.
 */
export function pgTargetIdentityMismatch(
	expected: PostgreSqlObservationTargetIdentity,
	observed: PostgreSqlObservationTargetIdentity,
): string | undefined {
	if (observed.systemIdentifier !== expected.systemIdentifier)
		return `system identifier expected ${quoted(expected.systemIdentifier)}, observed ${quoted(observed.systemIdentifier)}`;
	if (observed.databaseOid !== expected.databaseOid)
		return `database OID expected ${quoted(expected.databaseOid)}, observed ${quoted(observed.databaseOid)}`;
	const observedNamespaces = new Map(
		observed.namespaces.map((namespace) => [namespace.name, namespace.oid]),
	);
	for (const namespace of expected.namespaces) {
		const observedOid = observedNamespaces.get(namespace.name);
		if (observedOid !== namespace.oid)
			return `namespace ${quoted(namespace.name)} OID expected ${quoted(namespace.oid)}, observed ${quoted(observedOid ?? 'missing')}`;
	}
	return undefined;
}

/**
 * Name resolution is only used to locate the namespace OID.  The resulting
 * contract never treats the name itself as identity.
 */
export async function readPgExecutionTargetFromClient(
	target: TransitionSessionClient,
	namespaceNames: readonly string[],
): Promise<{
	readonly identity: PostgreSqlObservationTargetIdentity;
	readonly sessionProvenance: Readonly<
		Record<'search_path' | 'client_encoding' | 'TimeZone', string>
	>;
}> {
	if (namespaceNames.length === 0)
		throw new Error(
			'execution contract requires at least one target namespace',
		);
	// This is also the planning and recovery physical-target boundary. Establish
	// UTF-8 before namespace names or any catalog text are read from this lease.
	await forcePgUtf8Session(target);
	const executor = queryable(target);
	const system = await executor.query(
		'SELECT (pg_catalog.pg_control_system()).system_identifier::text AS system_identifier',
	);
	const database = await executor.query(
		'SELECT d.oid::text AS database_oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()',
	);
	const namespaces = await executor.query(
		'SELECT n.nspname AS name, n.oid::text AS oid FROM pg_catalog.pg_namespace n WHERE n.nspname = ANY($1::text[]) ORDER BY n.nspname, n.oid',
		[[...namespaceNames]],
	);
	const settings = await executor.query(
		"SELECT current_setting('search_path') AS search_path, current_setting('client_encoding') AS client_encoding, current_setting('TimeZone') AS timezone",
	);
	const names = [...new Set(namespaceNames)].sort(compareNamespaceNames);
	const resolvedNamespaces = namespaces.rows
		.map((row) => ({
			name: stringField(row.name, 'namespace name'),
			oid: stringField(row.oid, 'namespace oid'),
		}))
		.sort((left, right) => compareNamespaceNames(left.name, right.name));
	if (
		resolvedNamespaces.length !== names.length ||
		!names.every((name, index) => resolvedNamespaces[index]?.name === name)
	)
		throw new Error('PostgreSQL target namespace could not be read');
	const row = settings.rows[0] ?? {};
	return {
		identity: {
			systemIdentifier: stringField(
				system.rows[0]?.system_identifier,
				'system identifier',
			),
			databaseOid: stringField(database.rows[0]?.database_oid, 'database OID'),
			namespaces: resolvedNamespaces,
		},
		sessionProvenance: {
			search_path: stringField(row.search_path, 'search_path'),
			client_encoding: stringField(row.client_encoding, 'client_encoding'),
			TimeZone: stringField(row.timezone, 'TimeZone'),
		},
	};
}

function payloadString(
	operation: ProvenPlanShape['steps'][number]['operation'],
	field: string,
): string {
	const payload = operation.payload;
	if (
		payload === null ||
		typeof payload !== 'object' ||
		Array.isArray(payload) ||
		typeof (payload as Record<string, unknown>)[field] !== 'string'
	)
		throw new PgExecutionContractDerivationError(
			operation.ref,
			operation.operationKind.name,
			`has no derivable ${field} authority target`,
		);
	return (payload as Record<string, string>)[field]!;
}

function executionContractOperationRuntime(
	operation: ProvenPlanShape['steps'][number]['operation'],
): ExecutionContractOperationRuntime {
	const runtime = createPgTransitionPack().operationSemantics.find(
		(candidate) => candidate.supportsOperation?.(operation) === true,
	) as ExecutionContractOperationRuntime | undefined;
	const eligibility = runtime?.executionContractEligibility;
	if (runtime !== undefined && eligibility?.eligible === true) return runtime;
	throw new PgExecutionContractDerivationError(
		operation.ref,
		operation.operationKind.name,
		(eligibility?.eligible === false ? eligibility.detail : undefined) ??
			'no reviewed PostgreSQL execution requirements are registered',
	);
}

/**
 * The execution artifact must state the same floor as the operation capability
 * it reviews.  There is deliberately no fallback: registering a new operation
 * requires an explicit reviewed mapping before it can produce a contract.
 */
export const PG_OPERATION_ENGINE_FLOORS = {
	[ALTER_COLUMN_SET_NOT_NULL_OPERATION_KIND.name]:
		ALTER_COLUMN_SET_NOT_NULL_MIN_SERVER_VERSION_NUM,
	[ALTER_TABLE_ADD_CHECK_OPERATION_KIND.name]:
		ALTER_TABLE_ADD_CHECK_MIN_SERVER_VERSION_NUM,
	[ALTER_TYPE_ADD_VALUE_OPERATION_KIND.name]:
		ALTER_TYPE_ADD_VALUE_MIN_SERVER_VERSION_NUM,
	[CREATE_UNIQUE_INDEX_CONCURRENTLY_OPERATION_KIND.name]:
		CREATE_UNIQUE_INDEX_CONCURRENTLY_MIN_SERVER_VERSION_NUM,
} as const;

export function pgOperationEngineFloor(operationName: string): number {
	const floor =
		PG_OPERATION_ENGINE_FLOORS[
			operationName as keyof typeof PG_OPERATION_ENGINE_FLOORS
		];
	if (floor === undefined) {
		throw new Error(
			`operation ${operationName} has no reviewed PostgreSQL engine capability mapping`,
		);
	}
	return floor;
}

function operationRequirements(
	step: ProvenPlanShape['steps'][number],
): readonly ExecutionRequirement[] {
	const operation = step.operation;
	const name = operation.operationKind.name;
	const runtime = executionContractOperationRuntime(operation);
	const schema = payloadString(operation, 'schema');
	const rendererSessionRequirements: readonly ExecutionRequirement[] = (
		runtime.rendererSessionRequirements ?? []
	).map((requirement) => ({
		kind: 'postgresql.session-setting',
		mode: 'set-and-verify',
		setting: requirement.setting,
		value: requirement.value,
	}));
	const engine = (minServerVersionNum: number): ExecutionRequirement => ({
		kind: 'postgresql.engine-version',
		mode: 'must-satisfy',
		stepId: step.stepId,
		minServerVersionNum,
	});
	const schemaUsage = (): ExecutionRequirement => ({
		kind: 'postgresql.authority',
		mode: 'must-satisfy',
		action: 'schema-usage',
		schema,
	});
	const tableAlter = (): ExecutionRequirement => ({
		kind: 'postgresql.authority',
		mode: 'must-satisfy',
		action: 'table-alter',
		schema,
		object: payloadString(operation, 'table'),
	});
	if (name === ALTER_TYPE_ADD_VALUE_OPERATION_KIND.name) {
		return [
			engine(pgOperationEngineFloor(name)),
			schemaUsage(),
			{
				kind: 'postgresql.authority',
				mode: 'must-satisfy',
				action: 'type-alter',
				schema,
				object: payloadString(operation, 'type'),
			},
			...rendererSessionRequirements,
		];
	}
	if (
		name === ALTER_COLUMN_SET_NOT_NULL_OPERATION_KIND.name ||
		name === ALTER_TABLE_ADD_CHECK_OPERATION_KIND.name ||
		name === CREATE_UNIQUE_INDEX_CONCURRENTLY_OPERATION_KIND.name
	)
		return [
			engine(pgOperationEngineFloor(name)),
			schemaUsage(),
			tableAlter(),
			...rendererSessionRequirements,
		];
	throw new PgExecutionContractDerivationError(
		operation.ref,
		name,
		'no reviewed PostgreSQL execution requirements are registered',
	);
}

function staticRequirements(
	plan: ProvenPlanShape,
): readonly ExecutionRequirement[] {
	const requirements: ExecutionRequirement[] = [];
	for (const step of plan.steps)
		requirements.push(...operationRequirements(step));
	requirements.push({
		kind: 'postgresql.session-setting',
		mode: 'set-and-verify',
		setting: 'client_encoding',
		value: 'UTF8',
	});
	return createExecutionContract(requirements).requirements;
}

/**
 * A persisted contract is not self-authenticating merely because its clauses
 * are well-formed. Re-derive every non-physical clause from the stored plan;
 * only the planning-time physical identity is deliberately retained as data.
 */
export function validatePgExecutionContractDerivation(
	plan: ProvenPlanShape,
	contract: ExecutionContract,
): { readonly ok: true } | { readonly ok: false; readonly detail: string } {
	let expected: readonly ExecutionRequirement[];
	try {
		expected = staticRequirements(plan);
	} catch (error) {
		return {
			ok: false,
			detail: `execution contract could not be derived from plan: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	const actual = contract.requirements.filter(
		(requirement) => requirement.kind !== 'postgresql.physical-target',
	);
	if (stableJson(actual) !== stableJson(expected))
		return {
			ok: false,
			detail:
				'execution contract static clauses do not exactly derive from the stored plan',
		};
	return { ok: true };
}

/** Build the versioned canonical document once, while the plan is minted. */
export function createPgExecutionContract(
	plan: ProvenPlanShape,
	identity: PostgreSqlObservationTargetIdentity,
	_sessionProvenance: Readonly<
		Record<'search_path' | 'client_encoding' | 'TimeZone', string>
	>,
): ExecutionContract {
	if (
		identity.systemIdentifier.length === 0 ||
		identity.databaseOid.length === 0 ||
		identity.namespaces.length === 0
	)
		throw new Error('PostgreSQL physical target identity is incomplete');
	const requirements: ExecutionRequirement[] = [
		{
			kind: 'postgresql.physical-target',
			mode: 'must-match',
			systemIdentifier: identity.systemIdentifier,
			databaseOid: identity.databaseOid,
			namespaces: canonicalNamespaceIdentities(identity.namespaces),
		},
	];
	for (const requirement of staticRequirements(plan))
		requirements.push(requirement);
	// Every supported renderer qualifies identifiers from its payload, so
	// search_path cannot redirect a target. They also generate no temporal
	// literals, so TimeZone cannot alter rendered SQL or its fingerprints. They
	// are intentionally not contract clauses. Encoding is different: pg writes
	// UTF-8 bytes, therefore it is an execution requirement, not provenance.
	return createExecutionContract(requirements);
}

/** Evaluate the stored document on the leased executor, before it renders SQL. */
export async function evaluatePgExecutionContract(
	target: TransitionSessionClient,
	contract: ExecutionContract,
): Promise<
	| { readonly ok: true }
	| { readonly ok: false; readonly clause: string; readonly detail: string }
> {
	// Contract ordering is data-driven; UTF-8 cannot be left to the later
	// client_encoding clause because authority and physical clauses read text.
	await forcePgUtf8Session(target);
	const executor = queryable(target);
	for (const requirement of contract.requirements) {
		if (requirement.kind === 'postgresql.physical-target') {
			try {
				const live = await readPgExecutionTargetFromClient(
					target,
					requirement.namespaces.map((entry) => entry.name),
				);
				const mismatch = pgTargetIdentityMismatch(requirement, live.identity);
				if (mismatch)
					return {
						ok: false,
						clause: requirement.kind,
						detail: mismatch,
					};
			} catch (error) {
				return {
					ok: false,
					clause: requirement.kind,
					detail: error instanceof Error ? error.message : String(error),
				};
			}
			continue;
		}
		if (requirement.kind === 'postgresql.engine-version') {
			const version = Number(
				(await executor.query('SHOW server_version_num')).rows[0]
					?.server_version_num,
			);
			if (
				!Number.isInteger(version) ||
				(requirement.minServerVersionNum !== undefined &&
					version < requirement.minServerVersionNum) ||
				(requirement.maxServerVersionNum !== undefined &&
					version > requirement.maxServerVersionNum)
			)
				return {
					ok: false,
					clause: `${requirement.kind}:${requirement.stepId}`,
					detail: `server_version_num expected ${requirement.minServerVersionNum === undefined ? '-infinity' : String(requirement.minServerVersionNum)}..${requirement.maxServerVersionNum === undefined ? 'infinity' : String(requirement.maxServerVersionNum)}, observed ${String(version)}`,
				};
			continue;
		}
		if (requirement.kind === 'postgresql.authority') {
			const sql =
				requirement.action === 'schema-usage'
					? "SELECT pg_catalog.has_schema_privilege($1::text, 'USAGE') AS holds"
					: requirement.action === 'table-alter'
						? "SELECT pg_catalog.pg_has_role(c.relowner, 'USAGE') AS holds FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2"
						: "SELECT pg_catalog.pg_has_role(t.typowner, 'USAGE') AS holds FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1 AND t.typname = $2";
			const result = await executor.query(
				sql,
				requirement.object === undefined
					? [requirement.schema]
					: [requirement.schema, requirement.object],
			);
			if (result.rows[0]?.holds !== true)
				return {
					ok: false,
					clause: `${requirement.kind}:${requirement.action}:${requirement.schema}${requirement.object ? `.${requirement.object}` : ''}`,
					detail: `authority ${requirement.action} on ${requirement.object === undefined ? quoted(requirement.schema) : quoted(`${requirement.schema}.${requirement.object}`)} expected true, observed ${String(result.rows[0]?.holds ?? false)}`,
				};
			continue;
		}
		if (requirement.kind === 'postgresql.session-setting') {
			if (requirement.mode === 'provenance') continue;
			if (
				requirement.setting !== 'standard_conforming_strings' &&
				requirement.setting !== 'client_encoding'
			)
				return {
					ok: false,
					clause: requirement.kind,
					detail: 'unsupported set-and-verify session setting',
				};
			await executor.query(
				requirement.setting === 'client_encoding'
					? "SET client_encoding TO 'UTF8'"
					: "SET standard_conforming_strings TO 'on'",
			);
			const value = String(
				(await executor.query(`SHOW ${requirement.setting}`)).rows[0]?.[
					requirement.setting
				] ?? '',
			);
			if (value !== requirement.value)
				return {
					ok: false,
					clause: `${requirement.kind}:${requirement.setting}`,
					detail: `session setting ${requirement.setting} expected ${quoted(requirement.value)}, observed ${quoted(value || 'no value')}`,
				};
			continue;
		}
		return {
			ok: false,
			clause: 'unknown-requirement',
			detail: 'unknown execution requirement kind',
		};
	}
	return { ok: true };
}

/**
 * The durable preflight boundary.  This intentionally receives a core-minted
 * leased session, so SET/SHOW and the context used by the renderer are on the
 * exact connection that subsequently records intent and executes DDL.
 */
export async function preparePgExecutionSession(
	target: TransitionSessionClient,
	contract: ExecutionContract,
	plan: ProvenPlanShape,
): Promise<
	| {
			readonly ok: true;
			readonly context: import('@dbsp/types').ObservationContext;
	  }
	| {
			readonly ok: false;
			readonly kind: 'refused' | 'failed' | 'read-only';
			readonly detail: string;
	  }
> {
	try {
		await assertPgDatabaseWritable(target);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			kind: detail.startsWith('database-read-only:') ? 'read-only' : 'failed',
			detail,
		};
	}
	const derivation = validatePgExecutionContractDerivation(plan, contract);
	if (!derivation.ok)
		return { ok: false, kind: 'refused', detail: derivation.detail };
	let evaluation: Awaited<ReturnType<typeof evaluatePgExecutionContract>>;
	try {
		evaluation = await evaluatePgExecutionContract(target, contract);
	} catch (error) {
		return {
			ok: false,
			kind: 'failed',
			detail: `execution contract query failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (!evaluation.ok)
		return {
			ok: false,
			kind: 'refused',
			detail: `${evaluation.clause}: ${evaluation.detail}`,
		};
	const physical = contract.requirements.find(
		(
			requirement,
		): requirement is Extract<
			ExecutionRequirement,
			{ readonly kind: 'postgresql.physical-target' }
		> => requirement.kind === 'postgresql.physical-target',
	);
	if (!physical)
		return {
			ok: false,
			kind: 'refused',
			detail: 'execution contract has no physical target clause',
		};
	try {
		return {
			ok: true,
			context: await readPgObservationContextFromClient(
				target,
				physical.namespaces[0]?.name,
			),
		};
	} catch (error) {
		return {
			ok: false,
			kind: 'failed',
			detail: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Recovery admission is intentionally narrower than apply preflight: it proves
 * only that recovery is reading the planned cluster, database and namespaces.
 * Target state may have changed, and revoked DDL authority is irrelevant to
 * classification.
 */
export async function preparePgRecoveryAdmission(
	target: TransitionSessionClient,
	contract: ExecutionContract,
): Promise<
	| {
			readonly ok: true;
			readonly context: import('@dbsp/types').ObservationContext;
	  }
	| { readonly ok: false; readonly detail: string }
> {
	const physical = contract.requirements.find(
		(
			requirement,
		): requirement is Extract<
			ExecutionRequirement,
			{ readonly kind: 'postgresql.physical-target' }
		> => requirement.kind === 'postgresql.physical-target',
	);
	if (!physical)
		return {
			ok: false,
			detail: 'recovery admission contract has no physical target clause',
		};
	try {
		const live = await readPgExecutionTargetFromClient(
			target,
			physical.namespaces.map((entry) => entry.name),
		);
		const mismatch = pgTargetIdentityMismatch(physical, live.identity);
		if (mismatch)
			return { ok: false, detail: `postgresql.physical-target: ${mismatch}` };
		return {
			ok: true,
			context: await readPgObservationContextFromClient(
				target,
				physical.namespaces[0]?.name,
			),
		};
	} catch (error) {
		return {
			ok: false,
			detail: error instanceof Error ? error.message : String(error),
		};
	}
}
