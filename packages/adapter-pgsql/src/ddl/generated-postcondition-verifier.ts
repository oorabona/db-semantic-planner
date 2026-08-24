import type { LedgerAddress, ResourceAddress } from '@dbsp/types';
import { renderCheckConstraintClause } from '../check-expression.js';
import { dbTypesEqual } from '../db-type.js';
import { identityNaming } from '../naming-plugin.js';
import {
	lockPgRelation,
	PgResolvableRelationLockError,
} from '../transition/lock-relation.js';
import { validateCheckExpression } from '../validate.js';
import { generateCreateIndex } from './ddl-generator.js';
import {
	parseGeneratedPostconditionV3Declaration,
	snapshotGeneratedPostconditionJson,
} from './generated-postcondition-v3-validator.js';
import { DEFAULT_DDL_LOCK_TIMEOUT_MS } from './lock-timeout.js';
import type {
	GeneratedColumnPostcondition,
	GeneratedConstraintPostcondition,
	GeneratedIndexPostcondition,
	GeneratedPostcondition,
	GeneratedPostconditionDeclarationV3,
	GeneratedPostconditionV3,
	TargetBinding,
} from './managed-step-manifest.js';
import { generatedPostconditionDigest } from './managed-step-manifest.js';
import { quoteIdent } from './phases/utils.js';

type GeneratedPostconditionQuery = {
	query(
		sql: string,
		params?: readonly unknown[],
	): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
};

const generatedPostconditionSessionBrand = Symbol(
	'generatedPostconditionSessionBrand',
);
type GeneratedPostconditionSessionState = {
	active: boolean;
	proofInFlight: boolean;
	queriesInFlight: number;
	queriesOutsideProof: number;
};

type GeneratedPostconditionSafeFailure = {
	readonly capability: object;
	readonly queryCountAtMark: number;
};

const generatedPostconditionSessionStates = new WeakMap<
	object,
	GeneratedPostconditionSessionState
>();
const generatedPostconditionQueryCounts = new WeakMap<object, number>();
const preQueryFailures = new WeakMap<
	object,
	GeneratedPostconditionSafeFailure
>();
const cleanScratchFailures = new WeakMap<
	object,
	GeneratedPostconditionSafeFailure
>();
const structuralMismatchFailures = new WeakSet<object>();
const scratchRollbackSafeFailures = new WeakSet<object>();
const generatedPostconditionSessionLockTimeouts = new WeakMap<object, number>();

/** An adapter-minted, exclusive PostgreSQL session for rollback-only proof. */
export type GeneratedPostconditionSession = GeneratedPostconditionQuery & {
	readonly [generatedPostconditionSessionBrand]: true;
};

/** A retained session capability was used after its owning bracket ended. */
export class GeneratedPostconditionSessionDeactivatedError extends Error {
	constructor() {
		super('generated postcondition session capability is no longer active');
		this.name = 'GeneratedPostconditionSessionDeactivatedError';
	}
}

/** A caller attempted to overlap rollback-only proofs on one capability. */
export class GeneratedPostconditionProofInFlightError extends Error {
	constructor() {
		super('generated postcondition session already has a proof in flight');
		this.name = 'GeneratedPostconditionProofInFlightError';
	}
}

/** A session bracket completed while rollback-only proof work was still running. */
export class GeneratedPostconditionWorkInFlightError extends Error {
	constructor() {
		super(
			'generated postcondition session bracket completed with work in flight',
		);
		this.name = 'GeneratedPostconditionWorkInFlightError';
	}
}

/**
 * This mint is intentionally not re-exported from the adapter public surface.
 * Transition admission uses it for its already-pinned client; external callers
 * use withGeneratedPostconditionSession(), which checks out and releases one.
 */
export function mintGeneratedPostconditionSession(
	session: GeneratedPostconditionQuery,
): GeneratedPostconditionSession {
	const state: GeneratedPostconditionSessionState = {
		active: true,
		proofInFlight: false,
		queriesInFlight: 0,
		queriesOutsideProof: 0,
	};
	const capability = Object.freeze({
		async query(sql: string, params?: readonly unknown[]) {
			if (!state.active)
				throw new GeneratedPostconditionSessionDeactivatedError();
			if (!state.proofInFlight) state.queriesOutsideProof += 1;
			generatedPostconditionQueryCounts.set(
				capability,
				(generatedPostconditionQueryCounts.get(capability) ?? 0) + 1,
			);
			state.queriesInFlight += 1;
			try {
				return await session.query(sql, params);
			} finally {
				state.queriesInFlight -= 1;
			}
		},
		[generatedPostconditionSessionBrand]: true as const,
	});
	generatedPostconditionSessionStates.set(capability, state);
	return capability;
}

function boundedGeneratedPostconditionLockTimeout(value: number | undefined) {
	if (!Number.isFinite(value)) return DEFAULT_DDL_LOCK_TIMEOUT_MS;
	return Math.max(
		1,
		Math.min(86_400_000, Math.trunc(value ?? DEFAULT_DDL_LOCK_TIMEOUT_MS)),
	);
}

/**
 * Internal capability bracket for callers that already own an exclusive
 * PostgreSQL session.  The wrapper cannot outlive the work that borrowed it.
 */
export async function withPinnedGeneratedPostconditionSession<T>(
	session: GeneratedPostconditionQuery,
	work: (session: GeneratedPostconditionSession) => Promise<T>,
	lockTimeoutMs?: number,
): Promise<T> {
	const capability = mintGeneratedPostconditionSession(session);
	if (lockTimeoutMs !== undefined)
		generatedPostconditionSessionLockTimeouts.set(
			capability,
			boundedGeneratedPostconditionLockTimeout(lockTimeoutMs),
		);
	try {
		const result = await work(capability);
		const state = generatedPostconditionSessionStates.get(capability);
		if (state?.proofInFlight || state?.queriesInFlight)
			throw new GeneratedPostconditionWorkInFlightError();
		return result;
	} finally {
		const state = generatedPostconditionSessionStates.get(capability);
		if (state) state.active = false;
	}
}

/**
 * Public verifier checkout bracket.  Scratch-backed proofs require the active
 * role to hold database TEMP privilege; callers must preflight that capability
 * before applying managed DDL whose postcondition needs scratch staging.
 */
export async function withGeneratedPostconditionSession<T>(
	executor: {
		connect(): Promise<
			GeneratedPostconditionQuery & {
				release(error?: unknown): void | Promise<void>;
			}
		>;
	},
	work: (session: GeneratedPostconditionSession) => Promise<T>,
	lockTimeoutMs?: number,
): Promise<T> {
	const client = await executor.connect();
	let result!: T;
	let failed = false;
	let failure: unknown;
	let capability: GeneratedPostconditionSession | undefined;
	try {
		result = await withPinnedGeneratedPostconditionSession(
			client,
			async (session) => {
				capability = session;
				return work(session);
			},
			boundedGeneratedPostconditionLockTimeout(lockTimeoutMs),
		);
	} catch (error) {
		failed = true;
		failure = error;
	}
	const shouldEvict =
		failed && !isSafeGeneratedPostconditionFailure(failure, capability);
	try {
		if (shouldEvict)
			await client.release(
				failure instanceof Error
					? failure
					: new Error('generated postcondition verification failed', {
							cause: failure,
						}),
			);
		else await client.release();
	} catch (releaseError) {
		if (failed)
			throw new AggregateError(
				[failure, releaseError],
				'generated postcondition verification failed and session release failed',
				{ cause: failure },
			);
		throw releaseError;
	}
	if (failed) throw failure;
	return result;
}

type GeneratedPostconditionTarget = {
	readonly schema: string;
	readonly table: string;
	readonly name: string;
	/** The catalogue object selected by the binding query, never a name relookup. */
	readonly relationOid?: string;
	readonly objectOid?: string;
	readonly attributeNumber?: number;
};

type ResolvableGeneratedPostconditionKind =
	| 'table'
	| 'column'
	| 'index'
	| 'constraint'
	| 'enum'
	| 'sequence'
	| 'extension';

type GeneratedPostconditionSchemaBindingKind = Exclude<
	ResolvableGeneratedPostconditionKind,
	'extension'
>;
type GeneratedPostconditionTableChildKind = 'column' | 'index' | 'constraint';

/** The canonical schema-scoped table parent of a managed table child. */
type GeneratedPostconditionTableParent = {
	readonly scope: 'schema';
	readonly engine: string;
	readonly database: string;
	readonly schema: string;
	readonly kind: 'table';
	readonly name: string;
	readonly parent?: never;
	readonly catalogueIdentity?: never;
	readonly qualifiedBy?: never;
};

type GeneratedPostconditionSchemaRootAddress<
	K extends Exclude<
		GeneratedPostconditionSchemaBindingKind,
		GeneratedPostconditionTableChildKind
	>,
> = Omit<ResourceAddress, 'engine' | 'schema' | 'parent' | 'kind'> & {
	readonly engine: string;
	readonly scope: 'schema';
	readonly schema: string;
	readonly parent?: never;
	readonly kind: K;
};

type GeneratedPostconditionTableChildAddress<
	K extends GeneratedPostconditionTableChildKind,
> = Omit<ResourceAddress, 'engine' | 'schema' | 'parent' | 'kind'> & {
	readonly engine: string;
	readonly scope: 'schema';
	readonly schema: string;
	readonly parent: GeneratedPostconditionTableParent;
	readonly kind: K;
};

type GeneratedPostconditionExtensionAddress = Omit<
	ResourceAddress,
	'engine' | 'schema' | 'parent' | 'kind'
> & {
	readonly engine: string;
	readonly scope: 'database';
	readonly schema?: never;
	readonly parent?: never;
	readonly kind: 'extension';
};

/** The complete topology selected by a v3 managed-step binding. */
export type GeneratedPostconditionBindingAddress =
	| GeneratedPostconditionSchemaRootAddress<'table' | 'enum' | 'sequence'>
	| GeneratedPostconditionTableChildAddress<GeneratedPostconditionTableChildKind>
	| GeneratedPostconditionExtensionAddress;

/** A v3 binding selected no live object, or selected a slot other than the one declared. */
const bindingResolutionFailures = new WeakSet<object>();

export class GeneratedPostconditionBindingResolutionError extends Error {
	readonly sought: string;
	readonly found: string;

	constructor(input: { readonly sought: string; readonly found: string }) {
		super(
			`generated postcondition binding did not resolve: sought ${input.sought}; found ${input.found}`,
		);
		this.name = 'GeneratedPostconditionBindingResolutionError';
		this.sought = input.sought;
		this.found = input.found;
	}
}

function bindingResolutionFailure(input: {
	readonly sought: string;
	readonly found: string;
}): GeneratedPostconditionBindingResolutionError {
	const error = new GeneratedPostconditionBindingResolutionError(input);
	bindingResolutionFailures.add(error);
	return error;
}

function bindingAddressDescription(address: LedgerAddress): string {
	const parent = address.parent?.name;
	return `${address.scope} ${address.engine}/${address.database} ${address.kind} ${address.schema ?? '<database>'}.${parent ?? address.name}`;
}

function bindingAddressTopologyFailure(
	address: LedgerAddress,
): GeneratedPostconditionBindingResolutionError {
	return bindingResolutionFailure({
		sought:
			'a resolvable generated postcondition address with canonical topology',
		found: bindingAddressDescription(address),
	});
}

function canonicalGeneratedPostconditionTableParent(
	address: LedgerAddress,
): GeneratedPostconditionTableParent | undefined {
	const parent = address.parent;
	if (
		!isRecord(parent) ||
		(parent.scope !== undefined && parent.scope !== 'schema') ||
		parent.engine !== address.engine ||
		parent.database !== address.database ||
		typeof parent.schema !== 'string' ||
		parent.schema !== address.schema ||
		parent.kind !== 'table' ||
		typeof parent.name !== 'string' ||
		parent.parent !== undefined ||
		parent.catalogueIdentity !== undefined ||
		parent.qualifiedBy !== undefined
	)
		return undefined;
	return {
		scope: 'schema',
		engine: parent.engine,
		database: parent.database,
		schema: parent.schema,
		kind: 'table',
		name: parent.name,
	};
}

/**
 * Narrows a ledger address into the complete topology that a v3 verifier can
 * bind.  Ledger addresses are intentionally broader, so this boundary must
 * reject malformed persisted input before it reaches any verifier dispatch.
 */
export function toGeneratedPostconditionBindingAddress(
	address: LedgerAddress,
): GeneratedPostconditionBindingAddress {
	const {
		scope: _scope,
		schema: _schema,
		parent: _parent,
		kind: _kind,
		...resource
	} = address;
	switch (address.kind) {
		case 'table':
		case 'enum':
		case 'sequence':
			if (
				address.scope !== 'schema' ||
				typeof address.schema !== 'string' ||
				address.schema.length === 0 ||
				address.parent !== undefined
			)
				throw bindingAddressTopologyFailure(address);
			return {
				...resource,
				scope: 'schema',
				schema: address.schema,
				kind: address.kind,
			} satisfies GeneratedPostconditionBindingAddress;
		case 'column':
		case 'index':
		case 'constraint': {
			if (
				address.scope !== 'schema' ||
				typeof address.schema !== 'string' ||
				address.schema.length === 0
			)
				throw bindingAddressTopologyFailure(address);
			const parent = canonicalGeneratedPostconditionTableParent(address);
			if (parent === undefined) throw bindingAddressTopologyFailure(address);
			return {
				...resource,
				scope: 'schema',
				schema: address.schema,
				parent,
				kind: address.kind,
			} satisfies GeneratedPostconditionBindingAddress;
		}
		case 'extension':
			if (
				address.scope !== 'database' ||
				address.schema !== undefined ||
				address.parent !== undefined
			)
				throw bindingAddressTopologyFailure(address);
			return {
				...resource,
				scope: 'database',
				kind: 'extension',
			} satisfies GeneratedPostconditionBindingAddress;
		default:
			throw bindingAddressTopologyFailure(address);
	}
}

function isBindingResolutionFailure(error: unknown): boolean {
	return (
		error !== null &&
		(typeof error === 'object' || typeof error === 'function') &&
		bindingResolutionFailures.has(error)
	);
}

type IndexProjection = {
	readonly schema: string;
	readonly table: string;
	readonly name: string;
	readonly method: string;
	readonly unique: boolean;
	readonly valid: boolean;
	readonly ready: boolean;
	readonly live: boolean;
	readonly nullsNotDistinct: boolean;
	readonly primary: boolean;
	readonly exclusion: boolean;
	readonly immediate: boolean;
	readonly constraintOwned: boolean;
	readonly keyColumns: readonly (string | null)[];
	readonly keyDefinitions: readonly string[];
	readonly includeColumns: readonly string[];
	readonly opclasses: readonly string[];
	readonly keyOptions: readonly string[];
	readonly reloptions: readonly string[];
	readonly predicate: string | null;
};

type CheckProjection = {
	readonly expression: string;
	readonly validated: boolean;
	readonly noInherit: boolean;
	readonly enforced: boolean;
	readonly isLocal: boolean;
	readonly inheritanceCount: number;
	readonly parentId: number;
};

type TableColumnProjection = {
	readonly name: string;
	readonly type: string;
	readonly nullable: boolean;
	readonly default: string | undefined;
	/** Ownership and canonical nextval shape read in the same catalogue snapshot. */
	readonly generatedSequenceDefault: boolean;
	readonly collation: string | null;
	readonly identity: 'always' | 'byDefault' | null;
};

type TableProjection = {
	readonly columns: readonly TableColumnProjection[];
};

type GeneratedColumnProjection = Omit<TableColumnProjection, 'name'>;

let scratchSequence = 0;

function nextScratchName(kind: string): string {
	scratchSequence += 1;
	return `dbsp_postcondition_${kind}_${Date.now()}_${scratchSequence}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class GeneratedPostconditionReplanRequiredError extends Error {
	readonly code = 'REPLAN_REQUIRED';
	readonly diagnostic: Readonly<{
		versionSeen: unknown;
		stepIdentity: string | undefined;
	}>;

	constructor(
		message: string,
		versionSeen: unknown = undefined,
		stepIdentity: string | undefined = undefined,
		options?: ErrorOptions,
	) {
		super(
			`${message}; REPLAN_REQUIRED (replan required): produce a version 3 postcondition`,
			options,
		);
		this.name = 'GeneratedPostconditionReplanRequiredError';
		this.diagnostic = { versionSeen, stepIdentity };
	}
}

function replan(
	message: string,
	versionSeen: unknown = undefined,
	stepIdentity: string | undefined = undefined,
	cause: unknown = undefined,
): GeneratedPostconditionReplanRequiredError {
	return new GeneratedPostconditionReplanRequiredError(
		message,
		versionSeen,
		stepIdentity,
		cause === undefined ? undefined : { cause },
	);
}

function exactKeys(
	value: Record<string, unknown>,
	fields: readonly string[],
): boolean {
	const allowed = new Set(fields);
	return Object.keys(value).every((field) => allowed.has(field));
}

function decodeTargetBinding(value: unknown, message: string): TargetBinding {
	if (!isRecord(value) || !exactKeys(value, ['bindingVersion', 'bindingKind']))
		throw replan(message);
	if (
		value.bindingVersion !== 1 ||
		value.bindingKind !== 'managed-step-address'
	)
		throw replan(message);
	return { bindingVersion: 1, bindingKind: 'managed-step-address' };
}

function decodeV3GeneratedPostcondition(
	value: Record<string, unknown>,
	_versionSeen: unknown,
	_stepIdentity: string | undefined,
): GeneratedPostconditionV3 {
	const unsupported = 'generated v3 postcondition is unsupported';
	if (
		!exactKeys(value, [
			'postconditionVersion',
			'declaration',
			'targetBinding',
		]) ||
		value.postconditionVersion !== 3
	)
		throw replan(unsupported);
	const targetBinding = decodeTargetBinding(value.targetBinding, unsupported);
	try {
		return {
			postconditionVersion: 3,
			declaration: parseGeneratedPostconditionV3Declaration(value.declaration),
			targetBinding,
		};
	} catch (error) {
		throw replan(unsupported, undefined, undefined, error);
	}
}

/**
 * Decode exactly one postcondition interpretation per version: only v3 is
 * accepted. v1/v2 and every other value are named REPLAN_REQUIRED outcomes.
 */
export function decodeGeneratedPostcondition(
	value: unknown,
	stepIdentity?: string,
): GeneratedPostcondition {
	let snapshot: unknown;
	try {
		snapshot = snapshotGeneratedPostconditionJson(value);
	} catch (error) {
		throw replan(
			'generated postcondition format is unsupported',
			undefined,
			stepIdentity,
			error,
		);
	}
	return decodeGeneratedPostconditionSnapshot(snapshot, stepIdentity);
}

function decodeGeneratedPostconditionSnapshot(
	value: unknown,
	stepIdentity?: string,
): GeneratedPostcondition {
	if (!isRecord(value))
		throw replan(
			'generated postcondition format is unsupported',
			undefined,
			stepIdentity,
		);
	const postconditionVersion = value.postconditionVersion;
	if (postconditionVersion === 3) {
		try {
			const decoded = decodeV3GeneratedPostcondition(
				value,
				postconditionVersion,
				stepIdentity,
			);
			return decoded;
		} catch (error) {
			if (error instanceof GeneratedPostconditionReplanRequiredError)
				throw new GeneratedPostconditionReplanRequiredError(
					error.message.replace(/; REPLAN_REQUIRED[\s\S]*$/, ''),
					postconditionVersion,
					stepIdentity,
					{ cause: error },
				);
			throw error;
		}
	}
	throw replan(
		'generated postcondition version is no longer interpretable',
		postconditionVersion,
		stepIdentity,
	);
}

/**
 * The persisted digest is bound to the versioned wire value before decoding.
 * A digest minted for one version cannot authenticate another version body.
 */
export function decodeGeneratedPostconditionPayload(
	payload: { readonly value: unknown; readonly digest: string },
	stepIdentity?: string,
): GeneratedPostcondition {
	let value: unknown;
	try {
		value = snapshotGeneratedPostconditionJson(payload.value);
	} catch (error) {
		throw new GeneratedPostconditionReplanRequiredError(
			'generated postcondition digest cannot be decoded',
			undefined,
			stepIdentity,
			{ cause: error },
		);
	}
	if (!isRecord(value) || typeof value.postconditionVersion !== 'number')
		return decodeGeneratedPostconditionSnapshot(value, stepIdentity);
	let expectedDigest: string;
	try {
		expectedDigest = generatedPostconditionDigest(
			value as { readonly postconditionVersion: number },
		);
	} catch (error) {
		throw new GeneratedPostconditionReplanRequiredError(
			'generated postcondition digest cannot be decoded',
			value.postconditionVersion,
			stepIdentity,
			{ cause: error },
		);
	}
	if (payload.digest !== expectedDigest)
		throw replan(
			'generated postcondition digest is not paired with its versioned value',
			value.postconditionVersion,
			stepIdentity,
		);
	return decodeGeneratedPostconditionSnapshot(value, stepIdentity);
}

function nullableStringList(value: unknown): readonly (string | null)[] {
	if (
		!Array.isArray(value) ||
		value.some((item) => typeof item !== 'string' && item !== null)
	)
		throw new Error(
			'generated index verifier could not read a complete projection',
		);
	return value;
}

function projectionStringList(value: unknown): readonly string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
		throw new Error(
			'generated index verifier could not read a complete projection',
		);
	return value;
}

function indexProjection(row: Record<string, unknown>): IndexProjection {
	if (
		typeof row.schema_name !== 'string' ||
		typeof row.table_name !== 'string' ||
		typeof row.index_name !== 'string' ||
		typeof row.method_name !== 'string' ||
		typeof row.is_unique !== 'boolean' ||
		typeof row.is_valid !== 'boolean' ||
		typeof row.is_ready !== 'boolean' ||
		typeof row.is_live !== 'boolean' ||
		typeof row.nulls_not_distinct !== 'boolean' ||
		typeof row.is_primary !== 'boolean' ||
		typeof row.is_exclusion !== 'boolean' ||
		typeof row.is_immediate !== 'boolean' ||
		typeof row.is_constraint_owned !== 'boolean' ||
		!Number.isInteger(row.key_count) ||
		(typeof row.predicate_expression !== 'string' &&
			row.predicate_expression !== null)
	)
		throw new Error(
			'generated index verifier could not read a complete projection',
		);
	return {
		schema: row.schema_name,
		table: row.table_name,
		name: row.index_name,
		method: row.method_name,
		unique: row.is_unique,
		valid: row.is_valid,
		ready: row.is_ready,
		live: row.is_live,
		nullsNotDistinct: row.nulls_not_distinct,
		primary: row.is_primary,
		exclusion: row.is_exclusion,
		immediate: row.is_immediate,
		constraintOwned: row.is_constraint_owned,
		keyColumns: nullableStringList(row.key_columns),
		keyDefinitions: projectionStringList(row.key_definitions),
		includeColumns: projectionStringList(row.include_columns),
		opclasses: projectionStringList(row.opclasses),
		keyOptions: projectionStringList(row.key_options),
		reloptions: [...projectionStringList(row.reloptions)].sort(),
		predicate: row.predicate_expression,
	};
}

const INDEX_PROJECTION_SELECT =
	"SELECT pg_catalog.current_database() AS database_name, relation.relkind AS parent_relation_kind, index_relation.relkind AS relation_kind, relation.oid::text AS relation_oid, index_relation.oid::text AS object_oid, namespace.nspname AS schema_name, relation.relname AS table_name, index_relation.relname AS index_name, access_method.amname AS method_name, index_meta.indisunique AS is_unique, index_meta.indisvalid AS is_valid, index_meta.indisready AS is_ready, index_meta.indislive AS is_live, index_meta.indisprimary AS is_primary, index_meta.indisexclusion AS is_exclusion, index_meta.indimmediate AS is_immediate, constraint_item.oid IS NOT NULL AS is_constraint_owned, CASE WHEN index_meta_json.value ? 'indnullsnotdistinct' THEN (index_meta_json.value ->> 'indnullsnotdistinct')::boolean ELSE false END AS nulls_not_distinct, CASE WHEN index_meta_json.value ? 'indnkeyatts' THEN (index_meta_json.value ->> 'indnkeyatts')::integer ELSE index_meta.indnatts END AS key_count, ARRAY(SELECT attribute.attname::text FROM unnest(index_meta.indkey) WITH ORDINALITY AS key_column(attnum, position) LEFT JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = index_meta.indrelid AND attribute.attnum = key_column.attnum WHERE key_column.position <= CASE WHEN index_meta_json.value ? 'indnkeyatts' THEN (index_meta_json.value ->> 'indnkeyatts')::integer ELSE index_meta.indnatts END ORDER BY key_column.position) AS key_columns, ARRAY(SELECT pg_catalog.pg_get_indexdef(index_meta.indexrelid, key_position, false) FROM pg_catalog.generate_series(1, CASE WHEN index_meta_json.value ? 'indnkeyatts' THEN (index_meta_json.value ->> 'indnkeyatts')::integer ELSE index_meta.indnatts END) AS key_position ORDER BY key_position) AS key_definitions, ARRAY(SELECT attribute.attname::text FROM unnest(index_meta.indkey) WITH ORDINALITY AS include_column(attnum, position) JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = index_meta.indrelid AND attribute.attnum = include_column.attnum WHERE include_column.position > CASE WHEN index_meta_json.value ? 'indnkeyatts' THEN (index_meta_json.value ->> 'indnkeyatts')::integer ELSE index_meta.indnatts END ORDER BY include_column.position) AS include_columns, ARRAY(SELECT opclass.opcname::text FROM unnest(index_meta.indclass) WITH ORDINALITY AS index_opclass(opclass_oid, position) JOIN pg_catalog.pg_opclass opclass ON opclass.oid = index_opclass.opclass_oid WHERE index_opclass.position <= CASE WHEN index_meta_json.value ? 'indnkeyatts' THEN (index_meta_json.value ->> 'indnkeyatts')::integer ELSE index_meta.indnatts END ORDER BY index_opclass.position) AS opclasses, ARRAY(SELECT index_option.option::text FROM unnest(index_meta.indoption) WITH ORDINALITY AS index_option(option, position) WHERE index_option.position <= CASE WHEN index_meta_json.value ? 'indnkeyatts' THEN (index_meta_json.value ->> 'indnkeyatts')::integer ELSE index_meta.indnatts END ORDER BY index_option.position) AS key_options, COALESCE(index_relation.reloptions, ARRAY[]::text[]) AS reloptions, pg_catalog.pg_get_expr(index_meta.indpred, index_meta.indrelid, false) AS predicate_expression FROM pg_catalog.pg_index index_meta CROSS JOIN LATERAL (SELECT pg_catalog.to_jsonb(index_meta) AS value) index_meta_json JOIN pg_catalog.pg_class relation ON relation.oid = index_meta.indrelid JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace JOIN pg_catalog.pg_class index_relation ON index_relation.oid = index_meta.indexrelid JOIN pg_catalog.pg_am access_method ON access_method.oid = index_relation.relam LEFT JOIN pg_catalog.pg_constraint constraint_item ON constraint_item.conindid = index_meta.indexrelid";

/**
 * The parent table lock protects the table while the index proof runs, but it
 * cannot lock an index relation. Bind the index and project its structure in
 * this one catalogue statement so a rename cannot split those observations.
 */
async function stabilizeGeneratedIndexBindingAndProjection(input: {
	readonly session: GeneratedPostconditionSession;
	readonly targetBinding: TargetBinding;
	readonly address: GeneratedPostconditionBindingAddress;
}): Promise<{
	readonly target: GeneratedPostconditionTarget;
	readonly projection: IndexProjection;
}> {
	if (
		input.targetBinding.bindingVersion !== 1 ||
		input.targetBinding.bindingKind !== 'managed-step-address'
	)
		throw replan('generated postcondition target binding is unsupported');
	const slot = bindingSlot(input.address, 'index');
	if (slot.found !== undefined)
		throw bindingResolutionFailure({
			sought: slot.sought,
			found: slot.found,
		});
	if (slot.stabilizationRelation)
		try {
			await lockPgRelation(input.session, slot.stabilizationRelation);
		} catch (error) {
			if (
				error instanceof PgResolvableRelationLockError &&
				isRecord(error.cause) &&
				error.cause.code === '42P01'
			)
				throw bindingResolutionFailure({
					sought: slot.sought,
					found: 'absent',
				});
			throw error;
		}
	const row = (
		await input.session.query(
			`${INDEX_PROJECTION_SELECT} WHERE namespace.nspname = $1 AND index_relation.relname = $2`,
			[slot.target.schema, slot.target.name],
		)
	).rows[0];
	if (!row || row.database_name !== input.address.database)
		throw bindingResolutionFailure({
			sought: slot.sought,
			found: !row ? 'absent' : `database ${String(row.database_name)}`,
		});
	const found = relationBindingFound('index', slot.target, row);
	if (found !== undefined)
		throw bindingResolutionFailure({
			sought: slot.sought,
			found,
		});
	return {
		target: bindingIdentity('index', slot.target, row),
		projection: indexProjection(row),
	};
}

async function readScratchIndexProjection(
	session: GeneratedPostconditionSession,
	table: string,
	index: string,
): Promise<IndexProjection> {
	const row = (
		await session.query(
			`${INDEX_PROJECTION_SELECT} WHERE relation.oid = $1::pg_catalog.regclass AND index_relation.relname = $2`,
			[table, index],
		)
	).rows[0];
	if (!row)
		throw new Error('generated index verifier could not read staged index');
	return indexProjection(row);
}

async function scratchScope<T>(
	session: GeneratedPostconditionSession,
	work: () => Promise<T>,
): Promise<T> {
	const savepoint = nextScratchName('scope');
	let savepointActive = false;
	let transactionStarted = false;
	let result!: T;
	let workError: unknown;
	let workFailed = false;
	try {
		try {
			await session.query(`SAVEPOINT ${quoteIdent(savepoint, 'table')}`);
			savepointActive = true;
		} catch (error) {
			if (!isRecord(error) || error.code !== '25P01') throw error;
			await session.query('BEGIN');
			transactionStarted = true;
			await session.query(`SAVEPOINT ${quoteIdent(savepoint, 'table')}`);
			savepointActive = true;
		}
		const lockTimeoutMs =
			generatedPostconditionSessionLockTimeouts.get(session);
		if (lockTimeoutMs !== undefined || transactionStarted)
			await session.query(
				`SET LOCAL lock_timeout = '${lockTimeoutMs ?? DEFAULT_DDL_LOCK_TIMEOUT_MS}ms'`,
			);
		result = await work();
	} catch (error) {
		workFailed = true;
		workError = error;
	}
	const cleanupErrors: unknown[] = [];
	const cleanup = async (sql: string) => {
		try {
			await session.query(sql);
		} catch (error) {
			cleanupErrors.push(error);
		}
	};
	if (savepointActive) {
		await cleanup(`ROLLBACK TO SAVEPOINT ${quoteIdent(savepoint, 'table')}`);
		await cleanup(`RELEASE SAVEPOINT ${quoteIdent(savepoint, 'table')}`);
	}
	if (transactionStarted) await cleanup('ROLLBACK');
	if (workFailed && cleanupErrors.length > 0)
		throw new AggregateError(
			[workError, ...cleanupErrors],
			'generated postcondition verification failed and scratch cleanup failed',
		);
	if (workFailed) {
		if (
			isStructuralMismatchFailure(workError) ||
			isScratchRollbackSafeFailure(workError) ||
			isBindingResolutionFailure(workError)
		)
			markCleanScratchFailure(workError, session);
		throw workError;
	}
	if (cleanupErrors.length > 0)
		throw new AggregateError(
			cleanupErrors,
			'generated postcondition scratch cleanup failed',
		);
	return result;
}

function sameIndexStructure(
	left: IndexProjection,
	right: IndexProjection,
): boolean {
	return (
		left.method === right.method &&
		left.unique === right.unique &&
		left.valid === right.valid &&
		left.ready === right.ready &&
		left.live === right.live &&
		left.nullsNotDistinct === right.nullsNotDistinct &&
		left.primary === right.primary &&
		left.exclusion === right.exclusion &&
		left.immediate === right.immediate &&
		left.constraintOwned === right.constraintOwned &&
		JSON.stringify(left.keyColumns) === JSON.stringify(right.keyColumns) &&
		JSON.stringify(left.keyDefinitions) ===
			JSON.stringify(right.keyDefinitions) &&
		JSON.stringify(left.includeColumns) ===
			JSON.stringify(right.includeColumns) &&
		JSON.stringify(left.opclasses) === JSON.stringify(right.opclasses) &&
		JSON.stringify(left.keyOptions) === JSON.stringify(right.keyOptions) &&
		JSON.stringify([...left.reloptions].sort()) ===
			JSON.stringify([...right.reloptions].sort()) &&
		left.predicate === right.predicate
	);
}

function indexSource(expected: GeneratedIndexPostcondition, name: string) {
	return {
		name,
		columns: expected.columns,
		unique: expected.unique,
		method: expected.method,
		...(expected.expressions === undefined
			? {}
			: { expressions: expected.expressions }),
		...(expected.include === undefined ? {} : { include: expected.include }),
		nullsNotDistinct: expected.nullsNotDistinct,
		...(expected.opclass === undefined ? {} : { opclass: expected.opclass }),
		...(expected.with === undefined ? {} : { with: expected.with }),
		...(expected.where === undefined ? {} : { where: expected.where }),
	};
}

function requireGeneratedPostconditionSession(
	value: unknown,
): GeneratedPostconditionSession {
	if (!value || typeof value !== 'object')
		throw new Error(
			'generated postcondition verifier requires an adapter-minted exclusive session capability',
		);
	const state = generatedPostconditionSessionStates.get(value);
	if (!state)
		throw new Error(
			'generated postcondition verifier requires an adapter-minted exclusive session capability',
		);
	if (!state.active) throw new GeneratedPostconditionSessionDeactivatedError();
	return value as GeneratedPostconditionSession;
}

function markCleanScratchFailure(
	error: unknown,
	capability: GeneratedPostconditionSession,
): void {
	if (
		error !== null &&
		(typeof error === 'object' || typeof error === 'function')
	)
		cleanScratchFailures.set(error, safeFailure(capability));
}

function safeFailure(
	capability: GeneratedPostconditionSession,
): GeneratedPostconditionSafeFailure {
	return {
		capability,
		queryCountAtMark: generatedPostconditionQueryCounts.get(capability) ?? 0,
	};
}

function isSafeGeneratedPostconditionFailure(
	error: unknown,
	capability: GeneratedPostconditionSession | undefined,
): boolean {
	if (
		error === null ||
		(typeof error !== 'object' && typeof error !== 'function')
	)
		return false;
	const watermark =
		cleanScratchFailures.get(error) ?? preQueryFailures.get(error);
	if (!watermark || watermark.capability !== capability) return false;
	const state = generatedPostconditionSessionStates.get(watermark.capability);
	return (
		!state?.proofInFlight &&
		state?.queriesInFlight === 0 &&
		state.queriesOutsideProof === 0 &&
		(generatedPostconditionQueryCounts.get(watermark.capability) ?? 0) ===
			watermark.queryCountAtMark
	);
}

function structuralMismatch(message: string): Error {
	const error = new Error(message);
	structuralMismatchFailures.add(error);
	return error;
}

/**
 * Refusal text is an operator diagnostic, not a SQL/deparse transport. Keep
 * expected and live facts out of it: authored defaults can contain secrets.
 */
function structuralMismatchField(
	target: string,
	field: string,
	summary: 'count' | 'value' = 'value',
): Error {
	return structuralMismatch(
		`generated ${target} structural postcondition differs at ${field}: ${summary} mismatch (values redacted)`,
	);
}

function isStructuralMismatchFailure(error: unknown): boolean {
	return (
		error !== null &&
		(typeof error === 'object' || typeof error === 'function') &&
		structuralMismatchFailures.has(error)
	);
}

function isScratchRollbackSafeFailure(error: unknown): boolean {
	return (
		error !== null &&
		(typeof error === 'object' || typeof error === 'function') &&
		scratchRollbackSafeFailures.has(error)
	);
}

async function withGeneratedPostconditionProof<T>(
	input: GeneratedPostconditionSession,
	work: (session: GeneratedPostconditionSession) => Promise<T>,
): Promise<T> {
	const session = requireGeneratedPostconditionSession(input);
	const state = generatedPostconditionSessionStates.get(session);
	if (!state)
		throw new Error('generated postcondition session state is absent');
	// Public v3 entrypoints own one scope containing decoding, binding, locks,
	// and structure. Internal proof helpers may be reused without opening a
	// second scope on that same capability.
	if (state.proofInFlight) throw new GeneratedPostconditionProofInFlightError();
	state.proofInFlight = true;
	const queryCount = generatedPostconditionQueryCounts.get(session) ?? 0;
	let proofQueryCount = queryCount;
	let workError: unknown;
	let workErrorQueryCount = queryCount;
	try {
		// scratchScope owns a rollback-only transaction only when this exclusive
		// session is otherwise transactionless. It therefore also holds relation
		// locks through binding and structural proof, without taking ownership of
		// an enclosing DDL transaction.
		return await scratchScope(session, () => {
			proofQueryCount = generatedPostconditionQueryCounts.get(session) ?? 0;
			return work(session).catch((error: unknown) => {
				workError = error;
				workErrorQueryCount =
					generatedPostconditionQueryCounts.get(session) ?? 0;
				throw error;
			});
		});
	} catch (error) {
		if (
			isStructuralMismatchFailure(error) ||
			(error === workError && workErrorQueryCount === proofQueryCount)
		)
			markSafePreQueryFailure(error, session);
		throw error;
	} finally {
		state.proofInFlight = false;
	}
}

function markSafePreQueryFailure(
	error: unknown,
	capability: GeneratedPostconditionSession,
): void {
	if (
		error !== null &&
		(typeof error === 'object' || typeof error === 'function')
	)
		preQueryFailures.set(error, safeFailure(capability));
}

/** Refuse structural lookalikes before any proof or catalogue read. */
export function assertGeneratedPostconditionSession(
	value: unknown,
): GeneratedPostconditionSession {
	return requireGeneratedPostconditionSession(value);
}

function bindingSlot(
	address: GeneratedPostconditionBindingAddress,
	expectedKind: ResolvableGeneratedPostconditionKind,
): {
	readonly target: GeneratedPostconditionTarget;
	readonly sought: string;
	readonly found: string | undefined;
	readonly stabilizationRelation?: {
		readonly schema: string;
		readonly table: string;
	};
} {
	const schema = address.schema;
	const parent = address.parent;
	const parentSchema = parent?.schema;
	const parentName = parent?.name;
	const parentScope = parent
		? (parent as ResourceAddress & { readonly scope?: unknown }).scope
		: undefined;
	const name = address.name;
	const scope = address.scope;
	const expected = `${expectedKind} ${schema ?? '<database>'}.${parentName ?? name}${expectedKind === 'table' || expectedKind === 'enum' || expectedKind === 'sequence' || expectedKind === 'extension' ? '' : `.${name}`}`;
	const requiresTableParent =
		expectedKind === 'column' ||
		expectedKind === 'index' ||
		expectedKind === 'constraint';
	const schemaScoped = expectedKind !== 'extension';
	const parentMatches =
		parent !== undefined &&
		parent.engine === address.engine &&
		parent.database === address.database &&
		(parentScope === undefined || parentScope === scope) &&
		parentSchema === schema &&
		parent.kind === 'table' &&
		parent.parent === undefined;
	if (
		address.engine !== 'postgresql' ||
		address.kind !== expectedKind ||
		(schemaScoped && (scope !== 'schema' || !schema)) ||
		(!schemaScoped && (scope !== 'database' || schema !== undefined)) ||
		(requiresTableParent && !parentMatches) ||
		(!requiresTableParent && parent !== undefined)
	)
		return {
			target: {
				schema: schema ?? '',
				table: parentName ?? '',
				name,
			},
			sought: expected,
			found: `${address.engine}/${address.database} ${address.kind} ${schema ?? '<missing-schema>'}.${parentName ?? name}`,
		};
	return {
		target: {
			schema: schema ?? '',
			table:
				expectedKind === 'table' ||
				expectedKind === 'enum' ||
				expectedKind === 'sequence' ||
				expectedKind === 'extension'
					? name
					: (parentName ?? ''),
			name,
		},
		sought: expected,
		found: undefined,
		...(expectedKind === 'enum' ||
		expectedKind === 'sequence' ||
		expectedKind === 'extension'
			? {}
			: {
					stabilizationRelation: {
						schema: schema!,
						table: requiresTableParent ? parentName! : name,
					},
				}),
	};
}

function relationBindingFound(
	kind: ResolvableGeneratedPostconditionKind,
	target: GeneratedPostconditionTarget,
	row: Record<string, unknown> | undefined,
): string | undefined {
	if (!row) return 'absent';
	const relationKind = row.relation_kind;
	if (kind === 'table')
		return relationKind === 'r' || relationKind === 'p'
			? undefined
			: `relation ${target.schema}.${target.table} (relkind ${String(relationKind)})`;
	if (kind === 'column') {
		if (relationKind !== 'r' && relationKind !== 'p')
			return `relation ${target.schema}.${target.table} (relkind ${String(relationKind)})`;
		if (row.column_name === null || row.column_name === undefined)
			return 'absent';
		return row.column_name === target.name
			? undefined
			: `column ${target.schema}.${target.table}.${String(row.column_name)}`;
	}
	if (kind === 'index') {
		if (relationKind !== 'i' && relationKind !== 'I')
			return `relation ${target.schema}.${target.name} (relkind ${String(relationKind)})`;
		if (row.parent_relation_kind !== 'r' && row.parent_relation_kind !== 'p')
			return `relation ${target.schema}.${target.table} (relkind ${String(row.parent_relation_kind)})`;
		return row.table_name === target.table
			? undefined
			: `index ${target.schema}.${String(row.table_name)}.${target.name}`;
	}
	if (relationKind !== 'r' && relationKind !== 'p')
		return `relation ${target.schema}.${target.table} (relkind ${String(relationKind)})`;
	return row.constraint_name === target.name
		? undefined
		: `constraint ${target.schema}.${target.table}.${String(row.constraint_name)}`;
}

function bindingIdentity(
	kind: ResolvableGeneratedPostconditionKind,
	target: GeneratedPostconditionTarget,
	row: Record<string, unknown>,
): GeneratedPostconditionTarget {
	const relationOid = row.relation_oid;
	const objectOid = row.object_oid;
	if (typeof relationOid !== 'string' && typeof relationOid !== 'number')
		throw new Error(
			'generated postcondition binding did not return a relation identity',
		);
	if (
		(kind === 'index' ||
			kind === 'constraint' ||
			kind === 'enum' ||
			kind === 'extension') &&
		typeof objectOid !== 'string' &&
		typeof objectOid !== 'number'
	)
		throw new Error(
			'generated postcondition binding did not return an object identity',
		);
	if (kind === 'column' && !Number.isInteger(row.attribute_number))
		throw new Error(
			'generated postcondition binding did not return an attribute identity',
		);
	return {
		...target,
		relationOid: String(relationOid),
		...(objectOid === undefined ? {} : { objectOid: String(objectOid) }),
		...(typeof row.attribute_number === 'number'
			? { attributeNumber: row.attribute_number }
			: {}),
	};
}

/**
 * Resolves the complete managed-step address after its user-relation lock is
 * held. This helper is deliberately unscoped: only public verifier entries may
 * open a proof bracket.
 */
async function resolveGeneratedPostconditionBinding(input: {
	readonly session: GeneratedPostconditionSession;
	readonly targetBinding: TargetBinding;
	readonly address: GeneratedPostconditionBindingAddress;
	readonly expectedKind: ResolvableGeneratedPostconditionKind;
}): Promise<GeneratedPostconditionTarget> {
	const session = input.session;
	if (
		input.targetBinding.bindingVersion !== 1 ||
		input.targetBinding.bindingKind !== 'managed-step-address'
	)
		throw replan('generated postcondition target binding is unsupported');
	const slot = bindingSlot(input.address, input.expectedKind);
	if (slot.found !== undefined)
		throw bindingResolutionFailure({
			sought: slot.sought,
			found: slot.found,
		});
	const { target } = slot;
	let row: Record<string, unknown> | undefined;
	if (input.expectedKind === 'table')
		row = (
			await session.query(
				`SELECT pg_catalog.current_database() AS database_name, relation.relkind AS relation_kind, relation.oid::text AS relation_oid FROM pg_catalog.pg_class relation JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = $1 AND relation.relname = $2`,
				[target.schema, target.table],
			)
		).rows[0];
	else if (input.expectedKind === 'column')
		row = (
			await session.query(
				`SELECT pg_catalog.current_database() AS database_name, relation.relkind AS relation_kind, relation.oid::text AS relation_oid, attribute.attname AS column_name, attribute.attnum AS attribute_number FROM pg_catalog.pg_namespace namespace JOIN pg_catalog.pg_class relation ON relation.relnamespace = namespace.oid LEFT JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = relation.oid AND attribute.attname = $3 AND attribute.attnum > 0 AND NOT attribute.attisdropped WHERE namespace.nspname = $1 AND relation.relname = $2`,
				[target.schema, target.table, target.name],
			)
		).rows[0];
	else if (input.expectedKind === 'index')
		row = (
			await session.query(
				`SELECT pg_catalog.current_database() AS database_name, index_relation.relkind AS relation_kind, parent_relation.relkind AS parent_relation_kind, parent_relation.oid::text AS relation_oid, index_relation.oid::text AS object_oid, parent_relation.relname AS table_name FROM pg_catalog.pg_class index_relation JOIN pg_catalog.pg_namespace namespace ON namespace.oid = index_relation.relnamespace LEFT JOIN pg_catalog.pg_index index_definition ON index_definition.indexrelid = index_relation.oid LEFT JOIN pg_catalog.pg_class parent_relation ON parent_relation.oid = index_definition.indrelid WHERE namespace.nspname = $1 AND index_relation.relname = $2`,
				[target.schema, target.name],
			)
		).rows[0];
	else if (input.expectedKind === 'constraint')
		row = (
			await session.query(
				`SELECT pg_catalog.current_database() AS database_name, relation.relkind AS relation_kind, relation.oid::text AS relation_oid, constraint_item.oid::text AS object_oid, constraint_item.conname AS constraint_name FROM pg_catalog.pg_constraint constraint_item JOIN pg_catalog.pg_class relation ON relation.oid = constraint_item.conrelid JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = $1 AND relation.relname = $2 AND constraint_item.conname = $3`,
				[target.schema, target.table, target.name],
			)
		).rows[0];
	else if (input.expectedKind === 'enum')
		row = (
			await session.query(
				`SELECT pg_catalog.current_database() AS database_name, type_item.oid::text AS relation_oid, type_item.oid::text AS object_oid, 'e'::text AS relation_kind FROM pg_catalog.pg_type type_item JOIN pg_catalog.pg_namespace namespace ON namespace.oid = type_item.typnamespace WHERE namespace.nspname = $1 AND type_item.typname = $2 AND type_item.typtype = 'e'`,
				[target.schema, target.name],
			)
		).rows[0];
	else if (input.expectedKind === 'sequence')
		row = (
			await session.query(
				`SELECT pg_catalog.current_database() AS database_name, relation.oid::text AS relation_oid, relation.oid::text AS object_oid, relation.relkind AS relation_kind FROM pg_catalog.pg_class relation JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = $1 AND relation.relname = $2`,
				[target.schema, target.name],
			)
		).rows[0];
	else
		row = (
			await session.query(
				`SELECT pg_catalog.current_database() AS database_name, extension.oid::text AS relation_oid, extension.oid::text AS object_oid, 'x'::text AS relation_kind FROM pg_catalog.pg_extension extension WHERE extension.extname = $1`,
				[target.name],
			)
		).rows[0];
	if (!row || row.database_name !== input.address.database) {
		const failure = bindingResolutionFailure({
			sought: slot.sought,
			found: !row ? 'absent' : `database ${String(row.database_name)}`,
		});
		throw failure;
	}
	const found =
		input.expectedKind === 'enum'
			? row.relation_kind === 'e'
				? undefined
				: 'absent'
			: input.expectedKind === 'sequence'
				? row.relation_kind === 'S'
					? undefined
					: 'absent'
				: input.expectedKind === 'extension'
					? row.relation_kind === 'x'
						? undefined
						: 'absent'
					: relationBindingFound(input.expectedKind, target, row);
	if (found !== undefined) {
		const failure = bindingResolutionFailure({
			sought: slot.sought,
			found,
		});
		throw failure;
	}
	return bindingIdentity(input.expectedKind, target, row);
}

/** One lock acquisition, then one complete identity resolution under that lock. */
async function stabilizeGeneratedPostconditionBinding(input: {
	readonly session: GeneratedPostconditionSession;
	readonly targetBinding: TargetBinding;
	readonly address: GeneratedPostconditionBindingAddress;
	readonly expectedKind: ResolvableGeneratedPostconditionKind;
}): Promise<GeneratedPostconditionTarget> {
	if (
		input.targetBinding.bindingVersion !== 1 ||
		input.targetBinding.bindingKind !== 'managed-step-address'
	)
		throw replan('generated postcondition target binding is unsupported');
	const slot = bindingSlot(input.address, input.expectedKind);
	if (slot.found !== undefined)
		throw bindingResolutionFailure({
			sought: slot.sought,
			found: slot.found,
		});
	if (slot.stabilizationRelation)
		try {
			await lockPgRelation(input.session, slot.stabilizationRelation);
		} catch (error) {
			// A relation that vanished between address validation and LOCK is ordinary
			// stale-plan drift, not a poisoned client. Preserve every other lock error.
			if (
				error instanceof PgResolvableRelationLockError &&
				isRecord(error.cause) &&
				error.cause.code === '42P01'
			)
				throw bindingResolutionFailure({
					sought: slot.sought,
					found: 'absent',
				});
			throw error;
		}
	return resolveGeneratedPostconditionBinding(input);
}

/**
 * Enum and extension proof cannot hold a user-relation lock. Their binding and
 * structure must therefore be selected by one catalogue statement so READ
 * COMMITTED observes one snapshot rather than two independently-resolved names.
 */
function tableColumnProjection(
	row: Record<string, unknown>,
): TableColumnProjection {
	if (
		typeof row.column_name !== 'string' ||
		typeof row.column_type !== 'string' ||
		typeof row.is_not_null !== 'boolean' ||
		(typeof row.column_default !== 'string' && row.column_default !== null) ||
		(typeof row.collation_name !== 'string' && row.collation_name !== null) ||
		(row.identity_kind !== '' &&
			row.identity_kind !== 'a' &&
			row.identity_kind !== 'd')
	)
		throw new Error(
			'generated table verifier could not read a complete projection',
		);
	return {
		name: row.column_name,
		type: row.column_type,
		nullable: !row.is_not_null,
		default: row.column_default === null ? undefined : row.column_default,
		generatedSequenceDefault: row.generated_sequence_default === true,
		// PostgreSQL names the built-in collation `default`; DBSP represents no
		// explicit collation as null.
		collation: row.collation_name === 'default' ? null : row.collation_name,
		identity:
			row.identity_kind === 'a'
				? 'always'
				: row.identity_kind === 'd'
					? 'byDefault'
					: null,
	};
}

function generatedColumnProjection(
	row: Record<string, unknown>,
	name: string,
): GeneratedColumnProjection {
	const projection = tableColumnProjection({ ...row, column_name: name });
	return {
		type: projection.type,
		nullable: projection.nullable,
		default: projection.default,
		generatedSequenceDefault: projection.generatedSequenceDefault,
		collation: projection.collation,
		identity: projection.identity,
	};
}

// The deparse is PostgreSQL's canonical form.  The sequence name is deliberately
// not compared, but the entire expression must be the top-level SERIAL nextval
// shape and the referenced sequence must be owned by this exact column.
const GENERATED_SEQUENCE_EVIDENCE_SQL =
	"(pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid, false) ~ $dbsp_serial$^nextval\\('([^']|'')*'::regclass\\)$dbsp_serial$ AND EXISTS (SELECT 1 FROM pg_catalog.pg_depend default_sequence JOIN pg_catalog.pg_class sequence_relation ON sequence_relation.oid = default_sequence.refobjid WHERE default_sequence.classid = 'pg_catalog.pg_attrdef'::pg_catalog.regclass AND default_sequence.objid = default_value.oid AND default_sequence.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass AND default_sequence.deptype = 'n' AND sequence_relation.relkind = 'S' AND EXISTS (SELECT 1 FROM pg_catalog.pg_depend ownership WHERE ownership.classid = 'pg_catalog.pg_class'::pg_catalog.regclass AND ownership.objid = sequence_relation.oid AND ownership.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass AND ownership.refobjid = relation.oid AND ownership.refobjsubid = attribute.attnum AND ownership.deptype = 'a'))) AS generated_sequence_default";

const TABLE_COLUMN_PROJECTION_SELECT = `SELECT relation.relkind AS relation_kind, attribute.attname AS column_name, pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) AS column_type, attribute.attnotnull AS is_not_null, pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid) AS column_default, ${GENERATED_SEQUENCE_EVIDENCE_SQL}, column_collation.collname AS collation_name, attribute.attidentity AS identity_kind FROM pg_catalog.pg_namespace namespace JOIN pg_catalog.pg_class relation ON relation.relnamespace = namespace.oid LEFT JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = relation.oid AND attribute.attnum > 0 AND NOT attribute.attisdropped LEFT JOIN pg_catalog.pg_attrdef default_value ON default_value.adrelid = attribute.attrelid AND default_value.adnum = attribute.attnum LEFT JOIN pg_catalog.pg_collation column_collation ON column_collation.oid = attribute.attcollation`;

function isGeneratedSequenceDefault(
	specification: GeneratedColumnPostcondition,
): boolean {
	return specification.defaultKind === 'generated-sequence';
}

function requiresStagedDefault(
	specification: GeneratedColumnPostcondition,
): boolean {
	return (
		specification.hasDefault === true &&
		!isGeneratedSequenceDefault(specification)
	);
}

function scratchRollbackSafe(error: Error): Error {
	scratchRollbackSafeFailures.add(error);
	return error;
}

async function assertTemporaryTablePrivilege(
	session: GeneratedPostconditionSession,
): Promise<void> {
	const row = (
		await session.query(
			"SELECT pg_catalog.has_database_privilege(pg_catalog.current_database(), 'TEMP') AS has_temp_privilege",
		)
	).rows[0];
	if (row?.has_temp_privilege === false)
		throw scratchRollbackSafe(
			new Error(
				'generated postcondition verification requires database TEMP privilege before scratch-table DDL; grant TEMP and re-plan before applying managed DDL',
			),
		);
}

async function stageAuthoredDefaults(
	session: GeneratedPostconditionSession,
	target: GeneratedPostconditionTarget,
	columns: readonly GeneratedColumnPostcondition[],
): Promise<ReadonlyMap<string, string>> {
	const expected = columns.filter(requiresStagedDefault);
	if (expected.length === 0) return new Map();
	const scratchTable = nextScratchName('table');
	await assertTemporaryTablePrivilege(session);
	await session.query(
		`CREATE TEMP TABLE ${quoteIdent(scratchTable, 'table')} (LIKE ${quoteIdent(target.schema, 'schema')}.${quoteIdent(target.table, 'table')} INCLUDING DEFAULTS INCLUDING IDENTITY)`,
	);
	const staged = new Map<string, string>();
	for (const column of expected) {
		if (column.default === undefined)
			throw replan('generated column postcondition is unsupported');
		validateCheckExpression(column.default, 'generated column default');
	}
	await session.query(
		`ALTER TABLE ${quoteIdent(scratchTable, 'table')} ${expected
			.map(
				(column) =>
					`ALTER COLUMN ${quoteIdent(column.name, 'column')} SET DEFAULT ${column.default}`,
			)
			.join(', ')}`,
	);
	const stagedRows = (
		await session.query(
			'SELECT attribute.attname AS column_name, pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid) AS column_default FROM pg_catalog.pg_attrdef default_value JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = default_value.adrelid AND attribute.attnum = default_value.adnum WHERE default_value.adrelid = $1::pg_catalog.regclass AND attribute.attname = ANY($2::text[])',
			[scratchTable, expected.map((column) => column.name)],
		)
	).rows;
	for (const row of stagedRows) {
		if (
			typeof row.column_name !== 'string' ||
			typeof row.column_default !== 'string'
		)
			throw new Error(
				'generated column verifier could not read staged default',
			);
		staged.set(row.column_name, row.column_default);
	}
	if (staged.size !== expected.length)
		throw new Error('generated column verifier could not read staged default');
	return staged;
}

type ColumnPostconditionMismatch =
	| 'type'
	| 'nullability'
	| 'default'
	| 'collation'
	| 'identity';

async function defaultPostconditionMatches(
	actual: GeneratedColumnProjection,
	specification: GeneratedColumnPostcondition,
	stagedDefaults: ReadonlyMap<string, string>,
): Promise<boolean> {
	if (specification.hasDefault === false) return actual.default === undefined;
	if (specification.hasDefault !== true) return true;
	if (actual.default === undefined) return false;
	if (isGeneratedSequenceDefault(specification))
		return actual.generatedSequenceDefault;
	return stagedDefaults.get(specification.name) === actual.default;
}

async function columnPostconditionMatches(
	actual: GeneratedColumnProjection,
	specification: GeneratedColumnPostcondition,
	stagedDefaults: ReadonlyMap<string, string>,
): Promise<ColumnPostconditionMismatch | undefined> {
	if (
		specification.type !== undefined &&
		!dbTypesEqual(actual.type, specification.type)
	)
		return 'type';
	if (
		specification.nullable !== undefined &&
		actual.nullable !== specification.nullable
	)
		return 'nullability';
	if (
		!(await defaultPostconditionMatches(actual, specification, stagedDefaults))
	)
		return 'default';
	if (
		specification.collation !== undefined &&
		actual.collation !== specification.collation
	)
		return 'collation';
	if (
		specification.identity !== undefined &&
		actual.identity !== specification.identity
	)
		return 'identity';
	return undefined;
}

/**
 * Proves the supported COLUMN projection of a table, not every table property.
 * Inline primary keys, indexes, and constraints are proved by their own
 * postconditions and are never implied by this proof.
 */
async function verifyTableStructure(input: {
	readonly session: GeneratedPostconditionSession;
	readonly columns: readonly GeneratedColumnPostcondition[];
	readonly target: GeneratedPostconditionTarget;
}): Promise<{ readonly kind: 'table'; readonly projection: TableProjection }> {
	return (async (session) => {
		const verify = async () => {
			const rows = (
				await session.query(
					`${TABLE_COLUMN_PROJECTION_SELECT} WHERE relation.oid = $1::pg_catalog.oid ORDER BY attribute.attnum`,
					[input.target.relationOid],
				)
			).rows;
			const expected = input.columns;
			if (rows.length === 0)
				throw structuralMismatch(
					`generated table ${input.target.name} is absent`,
				);
			const relationKind = rows[0]?.relation_kind;
			if (typeof relationKind !== 'string')
				throw new Error(
					'generated table verifier could not read a complete projection',
				);
			if (relationKind !== 'r' && relationKind !== 'p')
				throw new Error(`generated table ${input.target.name} is not a table`);
			if (rows.some((row) => row.relation_kind !== relationKind))
				throw new Error(
					'generated table verifier could not read a complete projection',
				);
			const columnRows = rows.filter((row) => row.column_name !== null);
			if (columnRows.length !== expected.length)
				throw structuralMismatchField(
					`table ${input.target.name}`,
					'columns.count',
					'count',
				);
			const live = columnRows.map(tableColumnProjection);
			const stagedDefaults = await stageAuthoredDefaults(
				session,
				input.target,
				expected,
			);
			for (const [ordinal, specification] of expected.entries()) {
				const actual = live[ordinal];
				const mismatch = actual
					? await columnPostconditionMatches(
							actual,
							specification,
							stagedDefaults,
						)
					: 'presence';
				if (
					!actual ||
					actual.name !== specification.name ||
					mismatch !== undefined
				)
					throw structuralMismatchField(
						`table ${input.target.name}`,
						!actual
							? `columns[${ordinal}].presence`
							: actual.name !== specification.name
								? `columns[${ordinal}].name`
								: `columns[${ordinal}].${mismatch}`,
					);
			}
			return { kind: 'table' as const, projection: { columns: live } };
		};
		return verify();
	})(input.session);
}

async function verifyColumnStructure(input: {
	readonly session: GeneratedPostconditionSession;
	readonly column: GeneratedColumnPostcondition;
	readonly target: GeneratedPostconditionTarget;
}): Promise<{
	readonly kind: 'column';
	readonly projection: GeneratedColumnProjection;
}> {
	return (async (session) => {
		const expected = input.column;
		if (expected.name !== input.target.name)
			throw new Error(
				`generated column ${input.target.name} structural postcondition names another column`,
			);
		const verify = async () => {
			const row = (
				await session.query(
					`${TABLE_COLUMN_PROJECTION_SELECT} WHERE relation.oid = $1::pg_catalog.oid AND attribute.attnum = $2`,
					[input.target.relationOid, input.target.attributeNumber],
				)
			).rows[0];
			if (!row)
				throw structuralMismatch(
					`generated column ${input.target.name} is absent`,
				);
			if (row.relation_kind !== 'r' && row.relation_kind !== 'p')
				throw structuralMismatch(
					`generated column ${input.target.name} parent is not a table`,
				);
			if (row.column_name !== input.target.name)
				throw structuralMismatch(
					`generated column ${input.target.name} projection names another column`,
				);
			let projection: GeneratedColumnProjection;
			try {
				projection = generatedColumnProjection(row, input.target.name);
			} catch {
				throw new Error(
					`generated column ${input.target.name} has an incomplete projection`,
				);
			}
			const stagedDefaults = await stageAuthoredDefaults(
				session,
				input.target,
				[expected],
			);
			const mismatch = await columnPostconditionMatches(
				projection,
				expected,
				stagedDefaults,
			);
			if (mismatch !== undefined)
				throw structuralMismatch(
					`generated column ${input.target.name} ${mismatch} postcondition differs`,
				);
			return { kind: 'column' as const, projection };
		};
		return verify();
	})(input.session);
}

async function verifyIndexStructure(input: {
	readonly session: GeneratedPostconditionSession;
	readonly index: GeneratedIndexPostcondition;
	readonly target: GeneratedPostconditionTarget;
	readonly live: IndexProjection;
}): Promise<{ readonly kind: 'index'; readonly projection: IndexProjection }> {
	return (async (session) => {
		const expected = input.index;
		const scratchTable = nextScratchName('table');
		const scratchIndex = nextScratchName('index');
		// Render before acquiring/using the capability: malformed index material must
		// refuse before any live catalogue query.
		const scratchSql = generateCreateIndex(
			scratchTable,
			indexSource(expected, scratchIndex),
			undefined,
			identityNaming,
		);
		return (async () => {
			const live = input.live;
			if (
				live.schema !== expected.schema ||
				live.table !== expected.table ||
				live.name !== expected.name ||
				live.valid !== expected.valid ||
				live.ready !== expected.ready ||
				live.live !== expected.live
			)
				throw structuralMismatch(
					`generated index ${input.target.name} postcondition differs`,
				);
			const staged = await (async () => {
				await assertTemporaryTablePrivilege(session);
				await session.query(
					`CREATE TEMP TABLE ${quoteIdent(scratchTable, 'table')} (LIKE ${quoteIdent(expected.schema, 'schema')}.${quoteIdent(expected.table, 'table')} INCLUDING DEFAULTS INCLUDING IDENTITY)`,
				);
				await session.query(scratchSql);
				return readScratchIndexProjection(session, scratchTable, scratchIndex);
			})();
			if (!sameIndexStructure(live, staged))
				throw structuralMismatch(
					`generated index ${input.target.name} postcondition differs`,
				);
			return { kind: 'index', projection: live };
		})();
	})(input.session);
}

const CHECK_PROJECTION_SELECT =
	"SELECT pg_catalog.pg_get_expr(constraint_item.conbin, constraint_item.conrelid, false) AS expression, constraint_item.convalidated AS validated, constraint_item.connoinherit AS no_inherit, constraint_item.conislocal AS is_local, constraint_item.coninhcount AS inheritance_count, CASE WHEN constraint_item_json.value ? 'conparentid' THEN (constraint_item_json.value ->> 'conparentid')::oid ELSE 0::oid END AS parent_id, CASE WHEN constraint_item_json.value ? 'conenforced' THEN (constraint_item_json.value ->> 'conenforced')::boolean ELSE true END AS enforced FROM pg_catalog.pg_constraint constraint_item CROSS JOIN LATERAL (SELECT pg_catalog.to_jsonb(constraint_item) AS value) constraint_item_json";

function checkProjection(
	row: Record<string, unknown>,
	absent: string,
): CheckProjection {
	if (typeof row.expression !== 'string') throw new Error(absent);
	if (
		typeof row.validated !== 'boolean' ||
		typeof row.no_inherit !== 'boolean' ||
		typeof row.enforced !== 'boolean' ||
		typeof row.is_local !== 'boolean' ||
		typeof row.inheritance_count !== 'number' ||
		!Number.isInteger(row.inheritance_count) ||
		typeof row.parent_id !== 'number' ||
		!Number.isInteger(row.parent_id)
	)
		throw new Error(
			'generated CHECK verifier could not read a complete projection',
		);
	return {
		expression: row.expression,
		validated: row.validated,
		noInherit: row.no_inherit,
		enforced: row.enforced,
		isLocal: row.is_local,
		inheritanceCount: row.inheritance_count,
		parentId: row.parent_id,
	};
}

async function readLiveCheckProjection(
	session: GeneratedPostconditionSession,
	target: GeneratedPostconditionTarget,
): Promise<CheckProjection> {
	const row = (
		await session.query(
			`${CHECK_PROJECTION_SELECT} WHERE constraint_item.conrelid = $1::pg_catalog.oid AND constraint_item.oid = $2::pg_catalog.oid AND constraint_item.contype = 'c'`,
			[target.relationOid, target.objectOid],
		)
	).rows[0];
	if (!row) throw new Error(`generated constraint ${target.name} is absent`);
	return checkProjection(row, `generated constraint ${target.name} is absent`);
}

async function readScratchCheckProjection(
	session: GeneratedPostconditionSession,
	table: string,
	constraint: string,
): Promise<CheckProjection> {
	const row = (
		await session.query(
			`${CHECK_PROJECTION_SELECT} WHERE constraint_item.conrelid = $1::pg_catalog.regclass AND constraint_item.conname = $2 AND constraint_item.contype = 'c'`,
			[table, constraint],
		)
	).rows[0];
	if (!row)
		throw new Error(
			'generated CHECK verifier could not read staged constraint',
		);
	return checkProjection(
		row,
		'generated CHECK verifier could not read staged constraint',
	);
}

async function verifyCheckStructure(input: {
	readonly session: GeneratedPostconditionSession;
	readonly check: Extract<
		GeneratedConstraintPostcondition,
		{ readonly type: 'c' }
	>;
	readonly target: GeneratedPostconditionTarget;
}): Promise<{
	readonly kind: 'constraint';
	readonly projection: CheckProjection;
}> {
	return (async (session) => {
		const expected = input.check;
		const clause = renderCheckConstraintClause({
			expression: expected.expression,
			notValid: expected.notValid,
		});
		validateCheckExpression(clause, 'generated CHECK postcondition');
		return (async () => {
			const live = await readLiveCheckProjection(session, input.target);
			if (live.validated !== !expected.notValid)
				throw structuralMismatch(
					`generated constraint ${input.target.name} postcondition differs`,
				);
			const scratchTable = nextScratchName('table');
			const scratchConstraint = nextScratchName('constraint');
			const staged = await (async () => {
				await assertTemporaryTablePrivilege(session);
				await session.query(
					`CREATE TEMP TABLE ${quoteIdent(scratchTable, 'table')} (LIKE ${quoteIdent(input.target.schema, 'schema')}.${quoteIdent(input.target.table, 'table')} INCLUDING DEFAULTS INCLUDING IDENTITY)`,
				);
				await session.query(
					`ALTER TABLE ${quoteIdent(scratchTable, 'table')} ADD CONSTRAINT ${quoteIdent(scratchConstraint, 'alias')} ${clause}`,
				);
				return readScratchCheckProjection(
					session,
					scratchTable,
					scratchConstraint,
				);
			})();
			if (
				live.expression !== staged.expression ||
				live.validated !== staged.validated ||
				live.noInherit !== staged.noInherit ||
				live.enforced !== staged.enforced ||
				live.isLocal !== staged.isLocal ||
				live.inheritanceCount !== staged.inheritanceCount ||
				live.parentId !== staged.parentId
			)
				throw structuralMismatch(
					`generated constraint ${input.target.name} postcondition differs`,
				);
			return { kind: 'constraint', projection: live };
		})();
	})(input.session);
}

function v3ColumnPostcondition(
	declaration: Extract<
		GeneratedPostconditionDeclarationV3,
		{ readonly kind: 'column' }
	>['column'],
	name: string,
): GeneratedColumnPostcondition {
	const defaultState = declaration.default;
	return {
		name,
		...(declaration.type === undefined ? {} : { type: declaration.type }),
		...(declaration.nullable === undefined
			? {}
			: { nullable: declaration.nullable }),
		// A null authored collation means no COLLATE clause, not the catalogue's
		// effective default; only an authored name participates in the old proof.
		...(typeof declaration.authoredCollation === 'string'
			? { collation: declaration.authoredCollation }
			: {}),
		...(defaultState === undefined
			? {}
			: defaultState.defaultKind === 'none'
				? { hasDefault: false, identity: null }
				: defaultState.defaultKind === 'identity'
					? {
							hasDefault: false,
							identity: defaultState.identity,
						}
					: defaultState.defaultKind === 'generated-sequence'
						? {
								hasDefault: true,
								defaultKind: 'generated-sequence' as const,
								identity: null,
							}
						: {
								hasDefault: true,
								defaultKind: 'authored' as const,
								default: defaultState.defaultExpression.sql,
								identity: null,
							}),
	};
}

function decodeV3PostconditionKind<
	K extends GeneratedPostconditionDeclarationV3['kind'],
>(
	value: unknown,
	kind: K,
): GeneratedPostconditionV3 & {
	readonly declaration: Extract<
		GeneratedPostconditionDeclarationV3,
		{ readonly kind: K }
	>;
} {
	const postcondition = decodeGeneratedPostcondition(value);
	if (
		postcondition.postconditionVersion !== 3 ||
		postcondition.declaration.kind !== kind
	)
		throw replan(`generated v3 ${kind} postcondition is unsupported`);
	return postcondition as GeneratedPostconditionV3 & {
		readonly declaration: Extract<
			GeneratedPostconditionDeclarationV3,
			{ readonly kind: K }
		>;
	};
}

/** Resolves the v3 table binding, then delegates its shared structural proof. */
export async function verifyGeneratedTablePostcondition(input: {
	readonly session: GeneratedPostconditionSession;
	readonly postcondition: unknown;
	readonly address: GeneratedPostconditionBindingAddress;
}): Promise<{ readonly kind: 'table'; readonly projection: TableProjection }> {
	return withGeneratedPostconditionProof(input.session, async (session) => {
		const postcondition = decodeV3PostconditionKind(
			input.postcondition,
			'table',
		);
		const target = await stabilizeGeneratedPostconditionBinding({
			session,
			targetBinding: postcondition.targetBinding,
			address: input.address,
			expectedKind: 'table',
		});
		return verifyTableStructure({
			session,
			columns: postcondition.declaration.columns.map((column) =>
				v3ColumnPostcondition(column, column.name),
			),
			target,
		});
	});
}

/** Resolves the v3 column binding, then delegates its shared structural proof. */
export async function verifyGeneratedColumnPostcondition(input: {
	readonly session: GeneratedPostconditionSession;
	readonly postcondition: unknown;
	readonly address: GeneratedPostconditionBindingAddress;
}): Promise<{
	readonly kind: 'column';
	readonly projection: GeneratedColumnProjection;
}> {
	return withGeneratedPostconditionProof(input.session, async (session) => {
		const postcondition = decodeV3PostconditionKind(
			input.postcondition,
			'column',
		);
		const target = await stabilizeGeneratedPostconditionBinding({
			session,
			targetBinding: postcondition.targetBinding,
			address: input.address,
			expectedKind: 'column',
		});
		return verifyColumnStructure({
			session,
			column: v3ColumnPostcondition(
				postcondition.declaration.column,
				target.name,
			),
			target,
		});
	});
}

/** Resolves the v3 index binding, then delegates its shared structural proof. */
export async function verifyGeneratedIndexPostcondition(input: {
	readonly session: GeneratedPostconditionSession;
	readonly postcondition: unknown;
	readonly address: GeneratedPostconditionBindingAddress;
}): Promise<{ readonly kind: 'index'; readonly projection: IndexProjection }> {
	return withGeneratedPostconditionProof(input.session, async (session) => {
		const postcondition = decodeV3PostconditionKind(
			input.postcondition,
			'index',
		);
		const bound = await stabilizeGeneratedIndexBindingAndProjection({
			session,
			targetBinding: postcondition.targetBinding,
			address: input.address,
		});
		const { target } = bound;
		const index = postcondition.declaration.index;
		const { expressions, where, ...indexFacts } = index;
		return verifyIndexStructure({
			session,
			index: {
				schema: target.schema,
				table: target.table,
				name: target.name,
				...indexFacts,
				...(expressions === undefined
					? {}
					: {
							expressions: expressions.map((expression) => expression.sql),
						}),
				...(where === undefined ? {} : { where: where.sql }),
			},
			target,
			live: bound.projection,
		});
	});
}

/** Resolves the v3 CHECK binding, then delegates its shared structural proof. */
export async function verifyGeneratedCheckPostcondition(input: {
	readonly session: GeneratedPostconditionSession;
	readonly postcondition: unknown;
	readonly address: GeneratedPostconditionBindingAddress;
}): Promise<{
	readonly kind: 'constraint';
	readonly projection: CheckProjection;
}> {
	return withGeneratedPostconditionProof(input.session, async (session) => {
		const postcondition = decodeV3PostconditionKind(
			input.postcondition,
			'check',
		);
		const target = await stabilizeGeneratedPostconditionBinding({
			session,
			targetBinding: postcondition.targetBinding,
			address: input.address,
			expectedKind: 'constraint',
		});
		return verifyCheckStructure({
			session,
			check: {
				type: 'c',
				expression: postcondition.declaration.check.expression.sql,
				notValid: postcondition.declaration.check.notValid,
			},
			target,
		});
	});
}

/**
 * Binds the deliberately non-structural v3 kinds under the same rollback-only
 * proof bracket as structural verifiers.  The declaration kind is the binding
 * expectation, so a sequence slot can never observe an enum declaration (or
 * vice versa) merely because the address happens to resolve.
 */
export async function verifyGeneratedIdentityPostcondition(input: {
	readonly session: GeneratedPostconditionSession;
	readonly postcondition: unknown;
	readonly address: GeneratedPostconditionBindingAddress;
	readonly kind: 'constraint' | 'enum' | 'sequence' | 'extension';
}): Promise<{
	readonly kind: 'constraint' | 'enum' | 'sequence' | 'extension';
	readonly identity: Readonly<{
		readonly relationOid: string;
		readonly objectOid?: string;
	}>;
}> {
	return withGeneratedPostconditionProof(input.session, async (session) => {
		const postcondition = decodeV3PostconditionKind(
			input.postcondition,
			input.kind,
		);
		const target = await stabilizeGeneratedPostconditionBinding({
			session,
			targetBinding: postcondition.targetBinding,
			address: input.address,
			expectedKind: input.kind,
		});
		if (target.relationOid === undefined)
			throw new Error(
				'generated postcondition binding did not return a relation identity',
			);
		return {
			kind: input.kind,
			identity: {
				relationOid: target.relationOid,
				...(target.objectOid === undefined
					? {}
					: { objectOid: target.objectOid }),
			},
		};
	});
}
