/**
 * PgsqlAdapter - Implements the Adapter interface for PostgreSQL using native pg driver.
 *
 * This adapter wraps a pg Pool instance and provides the unified
 * adapter interface for the db-semantic-planner ORM.
 *
 * @module pgsql-adapter
 */

import { randomBytes } from 'node:crypto';
import { isProxy } from 'node:util/types';
import type {
	AlterColumnOptions,
	CreateIndexOptions,
	DropIndexOptions,
	IndexInfo,
	TruncateOptions,
	VacuumOptions,
} from '@dbsp/core';
import { POSTGRESQL_CAPABILITIES, plan as planFn } from '@dbsp/core';
import type {
	Adapter,
	AdapterCapabilities,
	AdapterLogger,
	AdapterStreamOptions,
	BatchUpdateIntent,
	ColumnType,
	CompiledNqlQuery,
	CompiledQuery,
	CompileOptions,
	CompileResultWithIncludes,
	ConnectionAvailability,
	CteQueryIntent,
	DbCasing,
	DeleteIntent,
	DialectCapabilities,
	Dump,
	DumpMeta,
	ExpressionIntent,
	InsertFromIntent,
	InsertIntent,
	ModelIR,
	MutationReturningItem,
	NqlBindingColumnTypeInfo,
	NqlRuntimeBinding,
	OutputDescriptor,
	PinnedConnectionOptions,
	PlanReport,
	QueryIntent,
	RecursivePlanReport,
	SelectIntent,
	SetOperationIntent,
	SubqueryIncludeInfo,
	TableIR,
	TransactionBeginOptions,
	TransactionOptions,
	UpdateIntent,
	UpsertFromIntent,
	UpsertIntent,
} from '@dbsp/types';
import { convertBigintJsReadValue } from '@dbsp/types';
import {
	assertCompiledQuery,
	projectionlessCompiledQuery,
	rebuildCompiledQuery,
} from '@dbsp/types/adapter-sdk';
import { getNqlBindingRefName, isNqlBindingRef } from '@dbsp/types/internal';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import type { AdapterCompilerDeps } from './adapter-compiler-deps.js';
import { compileSubqueryInclude as compileSubqueryIncludeImpl } from './adapter-compiler-includes.js';
import {
	compileBatchUpdate as compileBatchUpdateImpl,
	compileDelete as compileDeleteImpl,
	compileInsertFrom as compileInsertFromImpl,
	compileInsert as compileInsertImpl,
	compileUpdate as compileUpdateImpl,
	compileUpsertFrom as compileUpsertFromImpl,
	compileUpsert as compileUpsertImpl,
} from './adapter-compiler-mutations.js';
import {
	compileCteQuery as compileCteQueryImpl,
	compileRecursive as compileRecursiveImpl,
} from './adapter-compiler-recursive.js';
import {
	compileSelect,
	compileSelectEnvelope,
	compileWithIncludes as compileWithIncludesImpl,
} from './adapter-compiler-select.js';
import {
	DEFAULT_PK_COLUMN,
	defaultFkDerivation,
	type FkColumnDerivation,
} from './assert-field.js';
import { selectStmt } from './ast-helpers.js';
import {
	type BindingNameRegistry,
	emittedBindName,
	hasBindingName,
} from './binding-registry.js';
import {
	buildCustomFnFilter,
	PlanCompiler,
	renumberParamRefsInAst,
} from './compiler.js';
import {
	dbTypeCastTarget,
	renderColumnDbType,
	validateDbType,
} from './db-type.js';
import {
	type GenerateDDLOptions,
	generateDDL as generateDDLStatements,
} from './ddl/index.js';
import {
	generateCreateIndexSQL,
	generateDropIndexSQL,
} from './ddl/index-operations.js';
import { qualifyTableIdent, quoteIdent } from './ddl/phases/utils.js';
import {
	generateAlterColumnSQL,
	generateTruncateSQL,
	generateVacuumSQL,
} from './ddl/table-operations.js';
import { deparseQuoted } from './deparse.js';
import { compileExpressionIntent } from './handlers/expression/custom.js';
import { createCompilerState } from './handlers/types.js';
import { intentToDecisions } from './intent-to-decisions.js';
import {
	type IntrospectedModelIR,
	type IntrospectionOptions,
	introspectWithExecutor as introspectDb,
} from './introspection.js';
import {
	getNamingPluginForDbCasing,
	type NamingPlugin,
} from './naming-plugin.js';
import { getPostgresqlCapabilitiesTargetVersion } from './postgresql-capabilities.js';
import {
	derivePreparedStatementFingerprint,
	normalizeMaxPreparedStatements,
	PreparedStatementRegistry,
} from './prepared-statements.js';
import {
	finalizeEnvelope,
	fromCompiledQuery,
	fromOutputDescriptors,
	type ProjectionEnvelope,
	type ProjectNamedFieldsExpression,
	type ProjectNamedFieldsSelection,
	preserveOneToOne,
	projectNamedFields,
} from './projection-envelope.js';
import { MAX_DEPTH_LIMIT } from './recursive/cte-compiler.js';
import {
	compileSetOperationEnvelope as compileSetOperationEnvelopeImpl,
	type LeafCompileFn,
} from './set-operation.js';
import { generateCursorName } from './streaming/cursor.js';
import {
	type PgsqlTransactionTimeoutParameter,
	type PgsqlTransactionTimeoutStatement,
	setLocalTransactionTimeoutSql,
	transactionTimeoutStatements,
} from './transaction-timeouts.js';
import { validateIdentifier } from './validate.js';

// ============================================================================
// Internal types
// ============================================================================

type CompileSubqueryResult = {
	ast: import('@pgsql/types').Node;
	parameters: readonly unknown[];
};

type PgsqlInternalCompileOptions = CompileOptions & {
	readonly naming?: NamingPlugin;
};

type StreamRowMapper<T> = (rows: Record<string, unknown>[]) => T[];

const MAX_NQL_RUNTIME_BINDING_VALUES_PARAMETERS = 32_000;

const PGSQL_CONNECTION_AVAILABLE: ConnectionAvailability = {
	status: 'available',
};

const PGSQL_CONNECTION_UNAVAILABLE: ConnectionAvailability = {
	status: 'unavailable',
	reason: 'this PgsqlAdapter was constructed without a connection.',
	fix: 'Use createPgsqlAdapter(pool) to execute database operations.',
};

/**
 * SQL that resolves a table name (bound as the given positional param, e.g. '$1')
 * to its schema the way an unqualified reference does — the first search_path
 * schema containing it — for catalog reads with no explicit schema. Evaluates to
 * NULL when the table is not visible on the current search_path. Runs in the same
 * query as the catalog read, so a pooled connection cannot resolve against one
 * session and read against another.
 */
const RESOLVE_TABLE_SCHEMA_SQL = (tableParam: string): string =>
	'(SELECT n.nspname FROM pg_catalog.pg_class c ' +
	'JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace ' +
	`WHERE c.oid = to_regclass(quote_ident(${tableParam})))`;

const NO_ACTIVE_SQL_TRANSACTION = '25P01';
const IN_FAILED_SQL_TRANSACTION = '25P02';
const INVALID_SAVEPOINT_SPECIFICATION = '3B001';
const SAVEPOINT_RANDOM_BYTES = 16;

const RAW_SQL_TRANSACTION_CONTROL_MESSAGE =
	'Transaction control through raw SQL inside a scope dbsp is managing is unsupported. ' +
	'`COMMIT`, `ROLLBACK`, and `PREPARE TRANSACTION` end the transaction dbsp is working inside; dbsp detects that and fails loudly, but the data is already whatever your statement made it. ' +
	'Raw savepoint control (`SAVEPOINT`, `RELEASE SAVEPOINT`, `ROLLBACK TO SAVEPOINT`) can alter the savepoint stack before dbsp sees the command tag; dbsp poisons the scope, but it cannot make that command un-run. ' +
	"Manage your transaction outside dbsp's calls.";

const RAW_SQL_MULTI_COMMAND_MESSAGE =
	'dbsp cannot reason about a multi-command raw call inside a transaction it manages. ' +
	'Those commands have already run, and dbsp cannot undo what they already did. ' +
	'Send one command per call, or manage the transaction yourself.';

const ABORTED_COMMIT_MESSAGE =
	'PostgreSQL returned ROLLBACK for COMMIT. The transaction was already aborted, no changes were committed, and dbsp is reporting that failed commit explicitly.';

const TRANSACTION_ABORTED_MESSAGE =
	'PostgreSQL transaction is aborted because a statement failed inside a dbsp-managed scope and that failure was caught. Roll back the surrounding transaction; the swallowed statement failure is the cause worth reporting.';

const TRANSACTION_ABORT_SIGNAL_MESSAGE =
	'transaction aborted via AbortSignal before it committed';

const PINNED_CONNECTION_ABORT_SIGNAL_MESSAGE =
	'pinned connection aborted via AbortSignal before the callback completed';

const BORROWED_TRANSACTION_ABORT_SIGNAL_MESSAGE =
	'AbortSignal is only supported for a pool-owned top-level transaction; it cannot be used with a borrowed or nested transaction because dbsp does not own that connection.';

const BORROWED_PINNED_CONNECTION_ABORT_SIGNAL_MESSAGE =
	'AbortSignal is only supported for a pool-owned withPinnedConnection(); it cannot be used with a borrowed or nested pinned connection because dbsp does not own that connection.';

const ADVISORY_LOCK_CLEANUP_OWNERSHIP_MESSAGE =
	'the session may still hold the advisory lock; pool-owned connections are destroyed to free it, but borrowed connections remain caller-owned and must not be returned to a pool while they may still hold the lock';

const NESTED_TRANSACTION_OPTIONS_MESSAGE =
	'isolationLevel/readOnly apply only to a top-level transaction, not a nested savepoint';

const TRANSACTION_TIMEOUT_MESSAGE =
	'PostgreSQL transaction timeout elapsed inside a dbsp-managed transaction.';

const SAVEPOINT_SCOPE_BUSY_MESSAGE =
	'Cannot start another dbsp savepoint scope on this PostgreSQL connection because one is already active. Savepoint scopes are single-flight per connection; await the active dbsp operation before starting another.';

const SAVEPOINT_SCOPE_OWNER_MESSAGE =
	'This PostgreSQL connection is currently inside a dbsp-managed scope owned by another transaction adapter. Use the transaction adapter passed to the callback instead of an ancestor adapter.';

const TRANSACTION_SCOPE_ENDED_MESSAGE =
	'This PostgreSQL transaction adapter belongs to a transaction that has ended.';

const PINNED_CONNECTION_SCOPE_ENDED_MESSAGE =
	'This PostgreSQL pinned connection adapter belongs to a withPinnedConnection() scope that has ended.';

const NESTED_TRANSACTION_NOT_AWAITED_MESSAGE =
	'Nested transactions must be awaited before the transaction callback returns.';

const TRANSACTION_CONTROL_COMMAND_TAGS = new Set([
	'BEGIN',
	'START',
	'START TRANSACTION',
	'COMMIT',
	'ROLLBACK',
	'SAVEPOINT',
	'RELEASE',
	'PREPARE',
	'PREPARE TRANSACTION',
]);
const PREPARE_COMMAND_TAG = 'PREPARE';
const pgsqlAdapterInternalOptionsKey: unique symbol = Symbol(
	'dbsp-pgsql-adapter-internal-options',
);
const rollbackOnlyPgsqlScopeBrand: unique symbol = Symbol(
	'dbsp.pgsql.rollback-only-scope',
);

/** A scope minted by withScratchScope and guaranteed to roll back on success. */
export type RollbackOnlyPgsqlScope<DB = unknown> = PgsqlAdapter<DB> & {
	readonly [rollbackOnlyPgsqlScopeBrand]: typeof rollbackOnlyPgsqlScopeBrand;
};

type DbspClientScopeKind =
	| 'transaction'
	| 'pinned-connection'
	| 'transaction-savepoint'
	| 'statement-savepoint';

type DbspScopeToken = symbol;

type DbspClientScope = {
	readonly kind: DbspClientScopeKind;
	readonly token: DbspScopeToken;
	readonly state: DbspScopeState;
};

type DbspScopeState = {
	poisoned: DbspScopePoison | undefined;
	statementLock: DbspScopeStatementLock;
	children: DbspScopeChildren;
	closing: boolean;
	streamFailureRecovery: (() => Promise<void>) | undefined;
};

type DbspScopeChildren = {
	open: number;
	failure: DbspScopeFailure | undefined;
	transactions: Set<DbspChildTransaction>;
};

type DbspChildTransaction = {
	observed: boolean;
	failure: DbspScopeFailure | undefined;
	settled: boolean;
	settledPromise: Promise<void>;
	resolveSettled: () => void;
};

type DbspChildTransactionObserver = {
	observed: boolean;
	child: DbspChildTransaction;
	parentChildren: DbspScopeChildren;
	release: (failure?: DbspScopeFailure) => void;
};

type DbspScopePoisonOrigin = 'caller' | 'cleanup';

type DbspScopePoison = {
	readonly error: Error;
	readonly origin: DbspScopePoisonOrigin;
};

type DbspScopeFailure = {
	readonly error: unknown;
};

type DbspScopeStatementLock = {
	tail: Promise<void> | undefined;
};

type QueryResultMetadata = {
	readonly command: string | undefined;
	readonly rowCount: number | null;
};

const activeClientScopes = new WeakMap<PoolClient, DbspClientScope[]>();

// Raw aliases can outlive the adapter scope that exposed them. Keep this taint
// on the physical connection so a later pool checkout cannot replay on a
// session another caller may have changed.
const rawClientExposures = new WeakSet<PoolClient>();
const preparedStatementRegistries = new WeakMap<
	Pool | PoolClient,
	{
		readonly maxStatements: number;
		readonly registry: PreparedStatementRegistry;
	}
>();

/**
 * Named statements that a specific physical client can no longer execute.
 *
 * This is deliberately client-local: a pooled query releases its errored
 * client, so no failure state must outlive that client through the pool.
 */
type PreparedStatementQuarantine = {
	allStatements: boolean;
	readonly fingerprints: Set<string>;
};

const preparedStatementQuarantines = new WeakMap<
	PoolClient,
	PreparedStatementQuarantine
>();

type StatementExecutionOptions = {
	readonly allowedScopeToken?: DbspScopeToken;
	readonly allowAncestorScopeToken?: boolean;
	readonly allowClosingScope?: boolean;
	readonly allowPoisonedScope?: boolean;
	readonly inspectTransactionControl?: boolean;
	readonly protectBorrowedClientTransaction?: boolean;
	/** Set only by execute()/executeWithMeta() for compiled parameterized SQL. */
	readonly prepareEligible?: boolean;
	readonly rawSqlStatement?: boolean;
};

type ClientTransactionSuccessAction = 'commit' | 'rollback';
type SavepointTransactionSuccessAction = 'release' | 'rollback' | 'keep';

type MaybeMultipleQueryResults<T extends QueryResultRow = QueryResultRow> =
	| QueryResult<T>
	| QueryResult<T>[];

type CleanupFailureError = AggregateError & {
	readonly cleanupError: unknown;
	readonly originalError?: unknown;
};

export type PgAdvisoryLockKey =
	| bigint
	| { readonly classId: number; readonly objId: number };

export type PgAdvisoryLockResult<T> =
	| { readonly acquired: true; readonly value: T }
	| { readonly acquired: false };

type ResolvedPgAdvisoryLockKey =
	| {
			readonly kind: 'bigint';
			readonly parameters: readonly [bigint];
			readonly lockSql: 'SELECT pg_advisory_lock($1)';
			readonly tryLockSql: 'SELECT pg_try_advisory_lock($1) AS acquired';
			readonly unlockSql: 'SELECT pg_advisory_unlock($1) AS unlocked';
			readonly description: string;
	  }
	| {
			readonly kind: 'pair';
			readonly parameters: readonly [number, number];
			readonly lockSql: 'SELECT pg_advisory_lock($1, $2)';
			readonly tryLockSql: 'SELECT pg_try_advisory_lock($1, $2) AS acquired';
			readonly unlockSql: 'SELECT pg_advisory_unlock($1, $2) AS unlocked';
			readonly description: string;
	  };

type PgsqlTransactionTimeoutSnapshot = readonly {
	readonly parameter: PgsqlTransactionTimeoutParameter;
	readonly value: string;
}[];

export interface ResolvedPgsqlTransactionBeginOptions {
	readonly isolationLevel?:
		| 'read committed'
		| 'repeatable read'
		| 'serializable';
	readonly readOnly?: boolean;
	readonly lockTimeoutMs?: number;
	readonly statementTimeoutMs?: number;
	readonly timeoutStatements: readonly PgsqlTransactionTimeoutStatement[];
	readonly hasLockTimeout: boolean;
	readonly hasStatementTimeout: boolean;
}

interface ResolvedPgsqlTransactionOptions
	extends ResolvedPgsqlTransactionBeginOptions {
	readonly signal?: AbortSignal;
}

export class PgsqlRawSqlTransactionControlError extends Error {
	readonly dbspRawSqlTransactionControl = true;

	constructor(cause: unknown) {
		super(RAW_SQL_TRANSACTION_CONTROL_MESSAGE, { cause });
		this.name = 'PgsqlRawSqlTransactionControlError';
	}
}

export class PgsqlTransactionAbortedCommitError extends Error {
	readonly dbspTransactionAbortedCommit = true;

	constructor(cause: unknown) {
		super(ABORTED_COMMIT_MESSAGE, { cause });
		this.name = 'PgsqlTransactionAbortedCommitError';
	}
}

export class PgsqlTransactionAbortedError extends Error {
	readonly dbspTransactionAborted = true;

	constructor(cause: unknown) {
		super(TRANSACTION_ABORTED_MESSAGE, { cause });
		this.name = 'PgsqlTransactionAbortedError';
	}
}

/**
 * Raised when a pool-owned top-level transaction is aborted through
 * `TransactionOptions.signal`. If the signal aborts while `pool.connect()` is
 * still pending, dbsp honors it only after a client is acquired.
 */
export class PgsqlTransactionAbortSignalError extends Error {
	readonly dbspTransactionAbortSignal = true;

	constructor() {
		super(TRANSACTION_ABORT_SIGNAL_MESSAGE);
		this.name = 'PgsqlTransactionAbortSignalError';
	}
}

export class PgsqlPinnedConnectionAbortSignalError extends Error {
	readonly dbspPinnedConnectionAbortSignal = true;

	constructor() {
		super(PINNED_CONNECTION_ABORT_SIGNAL_MESSAGE);
		this.name = 'PgsqlPinnedConnectionAbortSignalError';
	}
}

export class PgsqlTransactionOptionsError extends Error {
	readonly dbspTransactionOptions = true;

	constructor(message: string) {
		super(message);
		this.name = 'PgsqlTransactionOptionsError';
	}
}

export class PgsqlAdvisoryLockOptionsError extends Error {
	readonly dbspAdvisoryLockOptions = true;

	constructor(message: string) {
		super(message);
		this.name = 'PgsqlAdvisoryLockOptionsError';
	}
}

/**
 * Raised when a statement inside a dbsp-managed transaction fails with a SQLSTATE
 * that matches a timeout the caller configured for that transaction: `55P03`
 * (`lock_not_available`) when `lockTimeoutMs` was set, or `57014` (`query_canceled`)
 * when `statementTimeoutMs` was set. The original PostgreSQL error is preserved as
 * `cause`.
 *
 * Classification is by SQLSTATE only. PostgreSQL assigns these codes to the OUTCOME,
 * not the cause: `55P03` is also raised by `FOR UPDATE NOWAIT`, and `57014` is also
 * raised by an external cancel (e.g. `pg_cancel_backend`). There is no locale-stable
 * structured field that separates the timeout from the other cause, so the message
 * text is deliberately NOT parsed. dbsp never emits `NOWAIT` itself, so a `55P03`
 * here is the configured `lock_timeout` unless the caller's own raw SQL used
 * `NOWAIT`; a `57014` is the configured `statement_timeout` unless the backend was
 * cancelled from outside. Inspect `cause` when that distinction matters.
 */
export class PgsqlTransactionTimeoutError extends Error {
	readonly dbspTransactionTimeout = true;

	constructor(
		cause: unknown,
		readonly timeout: PgsqlTransactionTimeoutParameter,
	) {
		super(TRANSACTION_TIMEOUT_MESSAGE, { cause });
		this.name = 'PgsqlTransactionTimeoutError';
	}
}

/**
 * Raised when the single safe unnamed replay after a prepared-statement
 * infrastructure failure also fails. `message` is always the safe constant
 * `Prepared statement recovery replay failed.`; `cause` is the replay error;
 * `infrastructureError` is the original infrastructure error; and
 * `admissionFingerprint` identifies the admitted statement. DBSP-authored
 * messages carry no parameter values; preserved upstream errors, including the
 * standard Error `cause`, are unsanitized.
 */
export class PgsqlPreparedStatementReplayError extends Error {
	readonly dbspPreparedStatementReplay = true;
	readonly originalInfrastructureError: unknown;
	readonly originalError: unknown;

	constructor(
		readonly admissionFingerprint: string,
		readonly infrastructureError: unknown,
		cause: unknown,
	) {
		super('Prepared statement recovery replay failed.', { cause });
		this.name = 'PgsqlPreparedStatementReplayError';
		this.originalInfrastructureError = infrastructureError;
		this.originalError = infrastructureError;
	}
}

/**
 * A `pg.PoolClient` is a `pg.Pool` plus `release()`, and that structural shape
 * identifies the physical executor form. The validated structural form selects
 * executor-specific prepared-statement behavior; the caller's declaration controls
 * ownership and lifecycle.
 *
 * It must not throw: the type says `Pool | PoolClient`, but a JavaScript caller
 * reaches this with whatever they like, and a shape check that raises a TypeError
 * on `undefined` tells them nothing about what they did wrong.
 */
function isPoolClientLike(
	connection: Pool | PoolClient | undefined,
): connection is PoolClient {
	return (
		typeof connection === 'object' &&
		connection !== null &&
		'release' in connection &&
		typeof connection.release === 'function'
	);
}

function poolClientTransactionOpen(client: PoolClient): boolean | undefined {
	const status = (client as { readonly _txStatus?: unknown })._txStatus;
	if (status === 'T' || status === 'E') return true;
	if (status === 'I') return false;
	return undefined;
}

function isPgErrorWithCode(error: unknown, code: string): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		(error as { code?: unknown }).code === code
	);
}

/**
 * node-postgres throws this before sending a query when its client-local parsed
 * statement map already associates our exact name with other SQL. It has no
 * SQLSTATE, so recognize only its canonical message for the attempted name.
 */
function isDriverLocalPreparedStatementNameCollision(
	error: unknown,
	attemptedName: string,
): boolean {
	const message = `Prepared statements must be unique - '${attemptedName}' was used for a different statement`;
	return (
		error instanceof Error && !('code' in error) && error.message === message
	);
}

function isVerifiedPreparedStatementInfrastructureError(
	error: unknown,
): boolean {
	if (!hasPostgresSqlStateCode(error)) return false;
	if (typeof error !== 'object' || error === null) return false;
	const { code, routine } = error as {
		readonly code?: unknown;
		readonly routine?: unknown;
	};
	return (
		(code === '0A000' && routine === 'RevalidateCachedQuery') ||
		(code === '26000' && routine === 'FetchPreparedStatement') ||
		(code === '42P05' && routine === 'StorePreparedStatement')
	);
}

/**
 * Read the statement identity PostgreSQL reports in its top-level `message`
 * field for server-side prepared statement errors. The same extractor serves
 * missing- and duplicate-name errors: either can arise from a prepared-
 * statement operation nested inside the outer named statement, so the
 * code/routine pair alone cannot authorize replaying or quarantining that
 * outer statement. Do not consult diagnostic text from nested execution.
 *
 * This recognizes canonical/C-locale PostgreSQL messages only, and correlates
 * `does not exist` to 26000 and `already exists` to 42P05. Localized or
 * cross-paired deployments propagate 26000/42P05 failures without replay or
 * quarantine.
 */
function reportedPreparedStatementName(error: unknown): string | undefined {
	if (typeof error !== 'object' || error === null) return undefined;
	const { code, message } = error as {
		readonly code?: unknown;
		readonly message?: unknown;
	};
	if (typeof message !== 'string') return undefined;
	const match =
		/^prepared statement "([^"]+)" (does not exist|already exists)$/.exec(
			message,
		);
	if (match === null) return undefined;
	const [, name, suffix] = match;
	if (
		(code === '26000' && suffix === 'does not exist') ||
		(code === '42P05' && suffix === 'already exists')
	)
		return name;
	return undefined;
}

/**
 * 0A000 does not report a prepared-statement identity, so preserve its
 * existing conservative text-scoped quarantine. 26000 and 42P05 must name
 * precisely the statement this adapter submitted before either can affect
 * client state.
 */
function shouldQuarantinePreparedStatementInfrastructureError(
	error: unknown,
	attemptedName: string,
): boolean {
	if (!isVerifiedPreparedStatementInfrastructureError(error)) return false;
	const { code, routine } = error as {
		readonly code?: unknown;
		readonly routine?: unknown;
	};
	if (code === '0A000' && routine === 'RevalidateCachedQuery') return true;
	return reportedPreparedStatementName(error) === attemptedName;
}

function canReplayPreparedStatementInfrastructureError(
	error: unknown,
	attemptedName: string,
	replayInvalidatedPlans: boolean,
): boolean {
	if (!isVerifiedPreparedStatementInfrastructureError(error)) return false;
	const { code, routine } = error as {
		readonly code?: unknown;
		readonly routine?: unknown;
	};
	if (code === '0A000' && routine === 'RevalidateCachedQuery')
		return replayInvalidatedPlans;
	if (
		(code === '26000' && routine === 'FetchPreparedStatement') ||
		(code === '42P05' && routine === 'StorePreparedStatement')
	)
		return reportedPreparedStatementName(error) === attemptedName;
	return false;
}

type ReplayableParameterSnapshot = unknown[];

/**
 * Replay is an optional recovery path, so its defensive copy must remain
 * bounded. These limits apply independently to each snapshot or replay copy:
 * 64 Ki visited values, 16 MiB of UTF-8 string data, and 16 MiB of Buffer
 * data. Parameters above a limit remain valid for the named submission but
 * decline transparent replay.
 */
const REPLAY_SNAPSHOT_MAX_VISITED_NODES = 64 * 1024;
const REPLAY_SNAPSHOT_MAX_STRING_BYTES = 16 * 1024 * 1024;
const REPLAY_SNAPSHOT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
	Object.getPrototypeOf(Uint8Array.prototype),
	'byteLength',
)!.get!;

type ReplayableParameterSnapshotBudget = {
	visitedNodes: number;
	stringBytes: number;
	bufferBytes: number;
};

function createReplayableParameterSnapshotBudget(): ReplayableParameterSnapshotBudget {
	return {
		visitedNodes: REPLAY_SNAPSHOT_MAX_VISITED_NODES,
		stringBytes: REPLAY_SNAPSHOT_MAX_STRING_BYTES,
		bufferBytes: REPLAY_SNAPSHOT_MAX_BUFFER_BYTES,
	};
}

function consumeReplayableParameterSnapshotNode(
	budget: ReplayableParameterSnapshotBudget,
): void {
	if (budget.visitedNodes === 0)
		throw new TypeError('replayable parameter snapshot node budget exceeded');
	budget.visitedNodes -= 1;
}

function consumeReplayableParameterSnapshotString(
	value: string,
	budget: ReplayableParameterSnapshotBudget,
): void {
	// Every UTF-8 code unit occupies at least one byte. Refuse oversized
	// strings before Buffer.byteLength() scans their full contents.
	if (value.length > budget.stringBytes)
		throw new TypeError('replayable parameter snapshot string budget exceeded');
	const bytes = Buffer.byteLength(value);
	if (bytes > budget.stringBytes)
		throw new TypeError('replayable parameter snapshot string budget exceeded');
	budget.stringBytes -= bytes;
}

function consumeReplayableParameterSnapshotBuffer(
	value: Buffer,
	budget: ReplayableParameterSnapshotBudget,
): void {
	// Check before Buffer.from() allocates its copy.
	const byteLength = Reflect.apply(
		TYPED_ARRAY_BYTE_LENGTH_GETTER,
		value,
		[],
	) as number;
	if (byteLength > budget.bufferBytes)
		throw new TypeError('replayable parameter snapshot Buffer budget exceeded');
	budget.bufferBytes -= byteLength;
}

/**
 * Produces the deliberately small parameter domain that can be replayed
 * without consulting caller-owned state. JSON-like arrays/plain objects are
 * copied recursively; Date and Buffer are the only supported object built-ins.
 * Everything else is intentionally replay-ineligible while still being valid
 * for the initial node-postgres submission.
 */
function captureReplayableParameterSnapshot(
	parameters: readonly unknown[],
): ReplayableParameterSnapshot | undefined {
	try {
		return cloneReplayableParameterValues(parameters);
	} catch {
		return undefined;
	}
}

function cloneReplayableParameterValues(
	parameters: readonly unknown[],
): ReplayableParameterSnapshot {
	const active = new WeakSet<object>();
	const copies = new WeakMap<object, unknown>();
	const budget = createReplayableParameterSnapshotBudget();
	const copy: unknown[] = [];
	for (const parameter of parameters) {
		copy.push(cloneReplayableParameterValue(parameter, active, copies, budget));
	}
	return copy;
}

function cloneReplayableParameterValue(
	value: unknown,
	active: WeakSet<object>,
	copies: WeakMap<object, unknown>,
	budget: ReplayableParameterSnapshotBudget,
): unknown {
	consumeReplayableParameterSnapshotNode(budget);
	if (value === null || typeof value === 'boolean') return value;
	if (typeof value === 'string') {
		consumeReplayableParameterSnapshotString(value, budget);
		return value;
	}
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value !== 'object')
		throw new TypeError('parameter is outside the replayable value domain');
	if (isProxy(value)) throw new TypeError('Proxy parameter is not replayable');
	if (active.has(value))
		throw new TypeError('cyclic parameter graph is not replayable');
	const priorCopy = copies.get(value);
	if (priorCopy !== undefined) return priorCopy;

	if (value instanceof Date) {
		if (Object.getPrototypeOf(value) !== Date.prototype)
			throw new TypeError('custom Date is not replayable');
		if (Reflect.ownKeys(value).length !== 0)
			throw new TypeError('custom Date is not replayable');
		return new Date(Date.prototype.getTime.call(value));
	}
	if (Buffer.isBuffer(value)) {
		if (Object.getPrototypeOf(value) !== Buffer.prototype)
			throw new TypeError('custom Buffer is not replayable');
		consumeReplayableParameterSnapshotBuffer(value, budget);
		return Buffer.from(value);
	}

	active.add(value);
	try {
		if (Array.isArray(value)) {
			if (Object.getPrototypeOf(value) !== Array.prototype)
				throw new TypeError('custom array is not replayable');
			// Refuse before descriptor inspection or new Array(length) can allocate
			// for more child values than this copy may visit.
			if (value.length > budget.visitedNodes)
				throw new TypeError(
					'replayable parameter snapshot node budget exceeded',
				);
			assertReplayableArrayProperties(value);
			const copy: unknown[] = new Array(value.length);
			copies.set(value, copy);
			for (let index = 0; index < value.length; index += 1) {
				copy[index] = cloneReplayableParameterValue(
					value[index],
					active,
					copies,
					budget,
				);
			}
			return copy;
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null)
			throw new TypeError('custom object is not replayable');
		const descriptors = Object.getOwnPropertyDescriptors(value);
		if (Object.getOwnPropertySymbols(value).length !== 0)
			throw new TypeError('symbol-keyed parameter is not replayable');
		const copy: Record<string, unknown> =
			prototype === null ? Object.create(null) : {};
		copies.set(value, copy);
		for (const [key, descriptor] of Object.entries(descriptors)) {
			if (!descriptor.enumerable || !('value' in descriptor))
				throw new TypeError('non-JSON parameter property is not replayable');
			consumeReplayableParameterSnapshotString(key, budget);
			Object.defineProperty(copy, key, {
				value: cloneReplayableParameterValue(
					descriptor.value,
					active,
					copies,
					budget,
				),
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
		return copy;
	} finally {
		active.delete(value);
	}
}

function assertReplayableArrayProperties(value: unknown[]): void {
	for (let index = 0; index < value.length; index += 1) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (
			descriptor === undefined ||
			!descriptor.enumerable ||
			!('value' in descriptor)
		)
			throw new TypeError('non-JSON array parameter is not replayable');
	}
}

/**
 * A protocol-shaped, positionless failure is conservatively treated as
 * server-reported for reservation accounting. Its shape does not prove which
 * protocol phase was reached.
 */
function isPositionlessProtocolShapedFailure(error: unknown): boolean {
	return (
		hasPostgresSqlStateCode(error) &&
		(error as { readonly position?: unknown }).position === undefined &&
		!isVerifiedPreparedStatementInfrastructureError(error)
	);
}

function hasPostgresSqlStateCode(error: unknown): boolean {
	if (typeof error !== 'object' || error === null) return false;
	const { code, severity } = error as {
		readonly code?: unknown;
		readonly severity?: unknown;
	};
	return (
		typeof severity === 'string' &&
		typeof code === 'string' &&
		/^[0-9A-Z]{5}$/.test(code)
	);
}

function shouldAbortPreparedStatementReservation(
	error: unknown,
	executor: Pool | PoolClient,
	attemptedName: string,
): boolean {
	if (
		typeof error === 'object' &&
		error !== null &&
		'position' in error &&
		(error as { readonly position?: unknown }).position !== undefined
	)
		return true;
	if (isDriverLocalPreparedStatementNameCollision(error, attemptedName))
		return true;
	// A pool may have accepted this name on a different physical client before a
	// later client reports missing state; retain the executor-scoped name there.
	if (!isPoolClientLike(executor)) return !hasPostgresSqlStateCode(error);
	if (isPositionlessProtocolShapedFailure(error)) return false;
	return true;
}

function isVerifiedClientWidePreparedStatementLoss(error: unknown): boolean {
	if (!hasPostgresSqlStateCode(error)) return false;
	if (typeof error !== 'object' || error === null) return false;
	const { code, routine } = error as {
		readonly code?: unknown;
		readonly routine?: unknown;
	};
	return code === '26000' && routine === 'FetchPreparedStatement';
}

function isPreparedStatementQuarantined(
	client: PoolClient,
	sql: string,
): boolean {
	const quarantine = preparedStatementQuarantines.get(client);
	return (
		quarantine?.allStatements === true ||
		quarantine?.fingerprints.has(derivePreparedStatementFingerprint(sql)) ===
			true
	);
}

function hasPreparedStatementQuarantine(client: PoolClient): boolean {
	return preparedStatementQuarantines.has(client);
}

function quarantinePreparedStatement(
	client: PoolClient,
	sql: string,
	clientWide: boolean,
): void {
	const quarantine = preparedStatementQuarantines.get(client);
	if (quarantine !== undefined) {
		if (clientWide) {
			quarantine.allStatements = true;
			quarantine.fingerprints.clear();
		} else if (!quarantine.allStatements) {
			quarantine.fingerprints.add(derivePreparedStatementFingerprint(sql));
		}
		return;
	}
	preparedStatementQuarantines.set(client, {
		allStatements: clientWide,
		fingerprints: clientWide
			? new Set()
			: new Set([derivePreparedStatementFingerprint(sql)]),
	});
}

function describeTransactionOptionValue(value: unknown): string {
	if (value === null) return 'null';
	if (typeof value === 'string') return `string ${JSON.stringify(value)}`;
	if (typeof value === 'number' && Number.isNaN(value)) return 'number NaN';
	try {
		return `${typeof value} ${String(value)}`;
	} catch {
		return typeof value;
	}
}

function resolvePgsqlTransactionIsolationLevel(
	value: unknown,
): ResolvedPgsqlTransactionBeginOptions['isolationLevel'] {
	if (value === undefined) return undefined;
	if (
		value === 'read committed' ||
		value === 'repeatable read' ||
		value === 'serializable'
	) {
		return value;
	}
	throw new PgsqlTransactionOptionsError(
		`Unsupported transaction isolationLevel: ${describeTransactionOptionValue(value)}`,
	);
}

function resolvePgsqlTransactionReadOnly(
	value: unknown,
): ResolvedPgsqlTransactionBeginOptions['readOnly'] {
	if (value === undefined) return undefined;
	if (typeof value === 'boolean') return value;
	throw new PgsqlTransactionOptionsError(
		`transaction readOnly must be a boolean when defined; received ${describeTransactionOptionValue(value)}`,
	);
}

function resolvePgsqlTransactionTimeoutMs(
	optionName: 'lockTimeoutMs' | 'statementTimeoutMs',
	value: unknown,
): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	throw new PgsqlTransactionOptionsError(
		`transaction ${optionName} must be a finite number when defined; received ${describeTransactionOptionValue(value)}`,
	);
}

function resolvePgsqlTransactionSignal(
	value: unknown,
): ResolvedPgsqlTransactionOptions['signal'] {
	if (value === undefined) return undefined;
	if (value instanceof AbortSignal) return value;
	throw new PgsqlTransactionOptionsError(
		`transaction signal must be an AbortSignal when defined; received ${describeTransactionOptionValue(value)}`,
	);
}

type PgsqlTransactionBeginOptionRecord =
	| {
			readonly isolationLevel?: unknown;
			readonly readOnly?: unknown;
			readonly lockTimeoutMs?: unknown;
			readonly statementTimeoutMs?: unknown;
			readonly signal?: unknown;
	  }
	| null
	| undefined;

function transactionBeginOptionRecord(
	options: TransactionBeginOptions | TransactionOptions | undefined,
): PgsqlTransactionBeginOptionRecord {
	return options as PgsqlTransactionBeginOptionRecord;
}

function resolveTransactionBeginOptionsCore(
	optionRecord: PgsqlTransactionBeginOptionRecord,
): ResolvedPgsqlTransactionBeginOptions {
	const rawIsolationLevel = optionRecord?.isolationLevel;
	const rawReadOnly = optionRecord?.readOnly;
	const rawLockTimeoutMs = optionRecord?.lockTimeoutMs;
	const rawStatementTimeoutMs = optionRecord?.statementTimeoutMs;

	const isolationLevel =
		resolvePgsqlTransactionIsolationLevel(rawIsolationLevel);
	const readOnly = resolvePgsqlTransactionReadOnly(rawReadOnly);
	const lockTimeoutMs = resolvePgsqlTransactionTimeoutMs(
		'lockTimeoutMs',
		rawLockTimeoutMs,
	);
	const statementTimeoutMs = resolvePgsqlTransactionTimeoutMs(
		'statementTimeoutMs',
		rawStatementTimeoutMs,
	);
	const timeoutOptions: TransactionOptions = {
		...(lockTimeoutMs !== undefined && { lockTimeoutMs }),
		...(statementTimeoutMs !== undefined && { statementTimeoutMs }),
	};
	const timeoutStatements: readonly PgsqlTransactionTimeoutStatement[] =
		Object.freeze([...transactionTimeoutStatements(timeoutOptions)]);

	return Object.freeze({
		...(isolationLevel !== undefined && { isolationLevel }),
		...(readOnly !== undefined && { readOnly }),
		...(lockTimeoutMs !== undefined && { lockTimeoutMs }),
		...(statementTimeoutMs !== undefined && { statementTimeoutMs }),
		timeoutStatements,
		hasLockTimeout: lockTimeoutMs !== undefined,
		hasStatementTimeout: statementTimeoutMs !== undefined,
	});
}

export function resolveTransactionBeginOptions(
	options: TransactionBeginOptions | undefined,
): ResolvedPgsqlTransactionBeginOptions {
	const optionRecord = transactionBeginOptionRecord(options);
	if (
		optionRecord !== null &&
		optionRecord !== undefined &&
		'signal' in optionRecord
	) {
		throw new PgsqlTransactionOptionsError(
			'stream transaction options do not support signal; AbortSignal is only supported by transaction()',
		);
	}
	return resolveTransactionBeginOptionsCore(optionRecord);
}

function resolveTransactionOptions(
	options: TransactionOptions | undefined,
): ResolvedPgsqlTransactionOptions {
	const optionRecord = transactionBeginOptionRecord(options) as
		| {
				readonly signal?: unknown;
		  }
		| null
		| undefined;
	const beginOptions = resolveTransactionBeginOptionsCore(optionRecord);
	const rawSignal = optionRecord?.signal;

	const signal = resolvePgsqlTransactionSignal(rawSignal);

	return Object.freeze({
		...beginOptions,
		...(signal !== undefined && { signal }),
	});
}

function renderTransactionIsolationLevel(
	isolationLevel: ResolvedPgsqlTransactionBeginOptions['isolationLevel'],
): string {
	switch (isolationLevel) {
		case 'read committed':
			return 'READ COMMITTED';
		case 'repeatable read':
			return 'REPEATABLE READ';
		case 'serializable':
			return 'SERIALIZABLE';
		case undefined:
			throw new PgsqlTransactionOptionsError(
				'transaction isolationLevel cannot be undefined when rendering BEGIN',
			);
		default:
			throw new PgsqlTransactionOptionsError(
				`Unsupported transaction isolationLevel: ${String(isolationLevel)}`,
			);
	}
}

function transactionBeginSql(
	options: ResolvedPgsqlTransactionBeginOptions | undefined,
): string {
	const parts = ['BEGIN'];
	if (options?.isolationLevel !== undefined) {
		parts.push(
			`ISOLATION LEVEL ${renderTransactionIsolationLevel(
				options.isolationLevel,
			)}`,
		);
	}
	if (options?.readOnly === true) {
		parts.push('READ ONLY');
	} else if (options?.readOnly === false) {
		parts.push('READ WRITE');
	}
	return parts.join(' ');
}

function assertTopLevelOnlyTransactionOptionsAreAbsent(
	options: ResolvedPgsqlTransactionBeginOptions | undefined,
): void {
	if (
		options?.isolationLevel !== undefined ||
		options?.readOnly !== undefined
	) {
		throw new PgsqlTransactionOptionsError(NESTED_TRANSACTION_OPTIONS_MESSAGE);
	}
}

function classifyPgsqlTransactionTimeout(
	error: unknown,
	options: ResolvedPgsqlTransactionBeginOptions | undefined,
): PgsqlTransactionTimeoutError | undefined {
	if (error instanceof PgsqlTransactionTimeoutError) {
		return error;
	}
	if (options === undefined) return undefined;
	// Classify by SQLSTATE only, gated on the caller having configured that timeout.
	// PostgreSQL overloads 55P03 (also NOWAIT) and 57014 (also external cancel) and
	// exposes no locale-stable field to separate the causes; see the JSDoc on
	// PgsqlTransactionTimeoutError for the boundary. The original error is the `cause`.
	if (options.hasLockTimeout && isPgErrorWithCode(error, '55P03')) {
		return new PgsqlTransactionTimeoutError(error, 'lock_timeout');
	}
	if (options.hasStatementTimeout && isPgErrorWithCode(error, '57014')) {
		return new PgsqlTransactionTimeoutError(error, 'statement_timeout');
	}
	return undefined;
}

function transactionTimeoutErrorOrOriginal(
	error: unknown,
	options: ResolvedPgsqlTransactionBeginOptions | undefined,
): unknown {
	return classifyPgsqlTransactionTimeout(error, options) ?? error;
}

function nextSavepointName(): string {
	return `dbsp_savepoint_${randomBytes(SAVEPOINT_RANDOM_BYTES).toString('hex')}`;
}

function createScopeToken(): DbspScopeToken {
	return Symbol('dbsp-pgsql-scope');
}

function createScopeState(
	statementLock: DbspScopeStatementLock = { tail: undefined },
): DbspScopeState {
	return {
		poisoned: undefined,
		statementLock,
		children: {
			open: 0,
			failure: undefined,
			transactions: new Set(),
		},
		closing: false,
		streamFailureRecovery: undefined,
	};
}

class ObservedChildTransactionPromise<T> extends Promise<T> {
	static override get [Symbol.species](): PromiseConstructor {
		return Promise;
	}

	readonly #markObserved: () => void;

	constructor(promise: Promise<T>, markObserved: () => void) {
		super((resolve, reject) => {
			promise.then(resolve, reject);
		});
		this.#markObserved = markObserved;
	}

	// biome-ignore lint/suspicious/noThenProperty: await and Promise.all must mark nested transaction promises observed.
	override then<TResult1 = T, TResult2 = never>(
		onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
		onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
	): Promise<TResult1 | TResult2> {
		this.#markObserved();
		return super.then(onfulfilled, onrejected);
	}

	override catch<TResult = never>(
		onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
	): Promise<T | TResult> {
		this.#markObserved();
		return super.catch(onrejected);
	}

	override finally(onfinally?: (() => void) | null): Promise<T> {
		this.#markObserved();
		return super.finally(onfinally);
	}
}

function normalizeCommandTag(command: string | undefined): string | undefined {
	return command?.trim().toUpperCase();
}

function isTransactionControlCommandTag(command: string | undefined): boolean {
	const normalized = normalizeCommandTag(command);
	return (
		normalized !== undefined && TRANSACTION_CONTROL_COMMAND_TAGS.has(normalized)
	);
}

function isPrepareCommandTag(command: string | undefined): boolean {
	return normalizeCommandTag(command) === PREPARE_COMMAND_TAG;
}

function queryResults<T extends QueryResultRow>(
	result: MaybeMultipleQueryResults<T>,
): readonly QueryResult<T>[] {
	return Array.isArray(result) ? result : [result];
}

function queryResultMetadata<T extends QueryResultRow>(
	result: QueryResult<T>,
): QueryResultMetadata {
	return {
		command: result.command,
		rowCount: result.rowCount,
	};
}

function queryResultsMetadata<T extends QueryResultRow>(
	result: MaybeMultipleQueryResults<T>,
): readonly QueryResultMetadata[] {
	return queryResults(result).map(queryResultMetadata);
}

function lastQueryResult<T extends QueryResultRow>(
	result: MaybeMultipleQueryResults<T>,
): QueryResult<T> {
	if (Array.isArray(result)) {
		const last = result.at(-1);
		if (last === undefined) {
			throw new Error('PostgreSQL returned no query results');
		}
		return last;
	}
	return result;
}

function describeThrown(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	if (typeof error === 'string') return error;
	return String(error);
}

function createCleanupFailureError(
	action: string,
	originalError: unknown,
	cleanupError: unknown,
): CleanupFailureError {
	const error = new AggregateError(
		[originalError, cleanupError],
		`${action}: ${describeThrown(cleanupError)}. The original failure is available as cause.`,
	) as CleanupFailureError;
	Object.defineProperties(error, {
		cause: { value: originalError, configurable: true },
		cleanupError: { value: cleanupError, configurable: true },
		originalError: { value: originalError, configurable: true },
	});
	return error;
}

function createCleanupOnlyError(
	action: string,
	cleanupError: unknown,
): CleanupFailureError {
	const error = new AggregateError(
		[cleanupError],
		`${action}: ${describeThrown(cleanupError)}.`,
	) as CleanupFailureError;
	Object.defineProperty(error, 'cleanupError', {
		value: cleanupError,
		configurable: true,
	});
	return error;
}

function addCleanupErrorToOriginal(
	originalError: unknown,
	cleanupError: unknown,
): unknown {
	if (originalError instanceof Error) {
		if (!Object.hasOwn(originalError, 'cause')) {
			Object.defineProperty(originalError, 'cause', {
				value: cleanupError,
				configurable: true,
			});
		}
		if (!Object.hasOwn(originalError, 'cleanupError')) {
			Object.defineProperty(originalError, 'cleanupError', {
				value: cleanupError,
				configurable: true,
			});
		}
		return originalError;
	}
	return createCleanupFailureError(
		'PostgreSQL stream cleanup failed: CLOSE cursor failed after the stream failed',
		originalError,
		cleanupError,
	);
}

function cleanupReleaseReason(error: unknown): Error | boolean | undefined {
	if (
		typeof error !== 'object' ||
		error === null ||
		!('cleanupError' in error)
	) {
		return undefined;
	}
	const cleanupError = (error as { readonly cleanupError?: unknown })
		.cleanupError;
	return cleanupError instanceof Error ? cleanupError : true;
}

const PG_ADVISORY_LOCK_INT64_MIN = -(1n << 63n);
const PG_ADVISORY_LOCK_INT64_MAX = (1n << 63n) - 1n;
const PG_ADVISORY_LOCK_INT32_MIN = -(2 ** 31);
const PG_ADVISORY_LOCK_INT32_MAX = 2 ** 31 - 1;

function resolvePgAdvisoryLockWait(wait: unknown): 'block' | 'try' {
	if (wait === undefined) return 'block';
	if (wait === 'block' || wait === 'try') return wait;
	throw new PgsqlAdvisoryLockOptionsError(
		"PostgreSQL advisory lock wait option must be 'block' or 'try'.",
	);
}

function assertPgAdvisoryLockBigintKey(key: bigint): void {
	if (key < PG_ADVISORY_LOCK_INT64_MIN || key > PG_ADVISORY_LOCK_INT64_MAX) {
		throw new PgsqlAdvisoryLockOptionsError(
			`PostgreSQL advisory lock bigint key must fit signed int64 (${PG_ADVISORY_LOCK_INT64_MIN} to ${PG_ADVISORY_LOCK_INT64_MAX}).`,
		);
	}
}

function assertPgAdvisoryLockInt32KeyPart(
	value: unknown,
	name: 'classId' | 'objId',
): asserts value is number {
	if (
		typeof value !== 'number' ||
		!Number.isInteger(value) ||
		value < PG_ADVISORY_LOCK_INT32_MIN ||
		value > PG_ADVISORY_LOCK_INT32_MAX
	) {
		throw new PgsqlAdvisoryLockOptionsError(
			`PostgreSQL advisory lock ${name} must fit signed int32 (${PG_ADVISORY_LOCK_INT32_MIN} to ${PG_ADVISORY_LOCK_INT32_MAX}).`,
		);
	}
}

function resolvePgAdvisoryLockKey(
	key: PgAdvisoryLockKey,
): ResolvedPgAdvisoryLockKey {
	if (typeof key === 'bigint') {
		assertPgAdvisoryLockBigintKey(key);
		return {
			kind: 'bigint',
			parameters: [key],
			lockSql: 'SELECT pg_advisory_lock($1)',
			tryLockSql: 'SELECT pg_try_advisory_lock($1) AS acquired',
			unlockSql: 'SELECT pg_advisory_unlock($1) AS unlocked',
			description: `bigint key ${key}`,
		};
	}

	if (typeof key === 'object' && key !== null) {
		const classId = (key as { readonly classId?: unknown }).classId;
		const objId = (key as { readonly objId?: unknown }).objId;
		assertPgAdvisoryLockInt32KeyPart(classId, 'classId');
		assertPgAdvisoryLockInt32KeyPart(objId, 'objId');
		return {
			kind: 'pair',
			parameters: [classId, objId],
			lockSql: 'SELECT pg_advisory_lock($1, $2)',
			tryLockSql: 'SELECT pg_try_advisory_lock($1, $2) AS acquired',
			unlockSql: 'SELECT pg_advisory_unlock($1, $2) AS unlocked',
			description: `classId ${classId}, objId ${objId}`,
		};
	}

	throw new PgsqlAdvisoryLockOptionsError(
		'PostgreSQL advisory lock key must be a bigint or { classId, objId }; strings are not accepted and dbsp does not hash lock keys.',
	);
}

function isRawSqlTransactionControlError(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'dbspRawSqlTransactionControl' in error &&
		(error as { readonly dbspRawSqlTransactionControl?: unknown })
			.dbspRawSqlTransactionControl === true
	);
}

function isSavepointUnavailableError(error: unknown): boolean {
	return (
		isPgErrorWithCode(error, NO_ACTIVE_SQL_TRANSACTION) ||
		isPgErrorWithCode(error, INVALID_SAVEPOINT_SPECIFICATION)
	);
}

function addRawSqlTransactionContext(error: unknown): unknown {
	const context =
		'dbsp rolled back the failed raw SQL to a savepoint, so the surrounding transaction is still usable. Side effects that do not participate in transactional rollback, including sequence advancement and session-level advisory locks, are not undone.';
	if (error instanceof Error) {
		error.message = `${error.message}; ${context}`;
		Object.defineProperty(error, 'dbspRawSqlContext', {
			value: context,
			configurable: true,
		});
	}
	return error;
}

function protectedStatementCleanupAction(
	rawSqlStatement: boolean,
	detail: string,
): string {
	const prefix = rawSqlStatement
		? 'PostgreSQL raw SQL cleanup failed'
		: 'PostgreSQL protected statement cleanup failed';
	return `${prefix}: ${detail}`;
}

function raise(error: unknown): never {
	throw error;
}

function renumberSqlParams(sql: string, offset: number): string {
	if (offset === 0) return sql;
	return sql.replace(/\$(\d+)/g, (_match, num) => {
		return `$${Number.parseInt(num, 10) + offset}`;
	});
}

function prefixNqlBindingCtes(
	bindingCtes: readonly string[],
	sql: string,
): string {
	if (bindingCtes.length === 0) return sql;
	const withMatch = /^(WITH\s+RECURSIVE\s+|WITH\s+)/i.exec(sql);
	if (!withMatch) {
		return `WITH ${bindingCtes.join(', ')} ${sql}`;
	}
	const [prefix] = withMatch;
	const withKeyword = /^WITH\s+RECURSIVE\s+/i.test(prefix)
		? 'WITH RECURSIVE'
		: 'WITH';
	return `${withKeyword} ${bindingCtes.join(', ')}, ${sql.slice(prefix.length)}`;
}

function isCompiledNqlQuery(
	input: PlanReport | CompiledNqlQuery,
): input is CompiledNqlQuery {
	return (
		!('intent' in input) &&
		('query' in input ||
			'cteQuery' in input ||
			'mutation' in input ||
			'setOperation' in input ||
			'bindings' in input ||
			'mutationBindings' in input ||
			'runtimeBindings' in input)
	);
}

function formatGuardPathSegment(key: string): string {
	return /^[A-Za-z_$][\w$]*$/.test(key)
		? `.${key}`
		: `[${JSON.stringify(key)}]`;
}

function findNqlBindingRefMarker(
	value: unknown,
	path: string,
	seen = new WeakSet<object>(),
): { ref: string; path: string } | undefined {
	if (value === null || typeof value !== 'object') {
		return undefined;
	}

	if (isNqlBindingRef(value)) {
		return {
			ref: getNqlBindingRefName(value),
			path,
		};
	}

	if (seen.has(value)) {
		return undefined;
	}
	seen.add(value);

	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			const found = findNqlBindingRefMarker(value[i], `${path}[${i}]`, seen);
			if (found) return found;
		}
		return undefined;
	}

	const record = value as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		const found = findNqlBindingRefMarker(
			record[key],
			`${path}${formatGuardPathSegment(key)}`,
			seen,
		);
		if (found) return found;
	}

	return undefined;
}

function guardCompiledQuery<T>(
	query: CompiledQuery<T>,
	context: string,
): CompiledQuery<T> {
	assertCompiledQuery(query);
	const found = findNqlBindingRefMarker(query.parameters, 'parameters');
	if (found) {
		throw new Error(
			`NQL binding reference marker '${found.ref}' survived into emitted SQL parameters at ${found.path} while compiling ${context}. ` +
				'Binding references must resolve to CTE subqueries before SQL emission.',
		);
	}

	return query;
}

function guardCompileResultWithIncludes<T>(
	result: CompileResultWithIncludes<T>,
	context: string,
): CompileResultWithIncludes<T> {
	return {
		...result,
		main: guardCompiledQuery(result.main, context),
	};
}

function findPhysicalTableNameCollision(
	model: ModelIR,
	bindingName: string,
	naming: NamingPlugin,
): string | undefined {
	for (const [modelTableName, table] of model.tables) {
		if (bindingName === table.name) return table.name;
		if (bindingName === modelTableName) return table.name;
		const emittedTableName = naming.toDatabase(table.name);
		if (bindingName === emittedTableName) return emittedTableName;
		const emittedModelTableName = naming.toDatabase(modelTableName);
		if (bindingName === emittedModelTableName) return emittedModelTableName;
	}
	return undefined;
}

function findDuplicateEmittedNqlBindingName(
	bindingNames: Iterable<string>,
	naming: NamingPlugin,
):
	| { originalName: string; duplicateName: string; emittedName: string }
	| undefined {
	const seen = new Map<string, string>();
	for (const bindingName of bindingNames) {
		const emittedName = emittedBindName(bindingName, naming);
		const originalName = seen.get(emittedName);
		if (originalName !== undefined && originalName !== bindingName) {
			return { originalName, duplicateName: bindingName, emittedName };
		}
		seen.set(emittedName, bindingName);
	}
	return undefined;
}

function orderedNqlBindingNames(bundle: CompiledNqlQuery): string[] {
	const names: string[] = [];
	const seen = new Set<string>();
	for (const name of bundle.bindings?.keys() ?? []) {
		names.push(name);
		seen.add(name);
	}
	for (const name of bundle.runtimeBindings?.keys() ?? []) {
		if (!seen.has(name)) {
			names.push(name);
			seen.add(name);
		}
	}
	return names;
}

function shadowingLocalCteNames(bundle: CompiledNqlQuery): readonly string[] {
	return bundle.cteQuery?.ctes.map((cte) => cte.name) ?? [];
}

function removeShadowedNqlBindingNames(
	bindingNames: readonly string[],
	localCteNames: readonly string[],
	naming: NamingPlugin,
): string[] {
	if (bindingNames.length === 0 || localCteNames.length === 0) {
		return [...bindingNames];
	}
	const localLogicalNames = new Set(localCteNames);
	const localEmittedNames = new Set(
		localCteNames.map((name) => emittedBindName(name, naming)),
	);
	return bindingNames.filter(
		(name) =>
			!localLogicalNames.has(name) &&
			!localEmittedNames.has(emittedBindName(name, naming)),
	);
}

function runtimeBindingSourceTable(
	bundle: CompiledNqlQuery,
	name: string,
): string | undefined {
	return (
		bundle.mutationBindings?.get(name)?.table ??
		bundle.bindings?.get(name)?.from
	);
}

function mapRuntimeBindingColumnType(type: ColumnType): string | undefined {
	switch (type) {
		case 'string':
			return 'text';
		case 'text':
			return 'text';
		case 'number':
		case 'integer':
			return 'integer';
		case 'bigint':
			return 'bigint';
		case 'decimal':
			return 'numeric';
		case 'boolean':
			return 'boolean';
		case 'date':
			return 'date';
		case 'time':
			return 'time';
		case 'datetime':
		case 'timestamp':
			return 'timestamptz';
		case 'json':
		case 'jsonb':
			return 'jsonb';
		case 'uuid':
			return 'uuid';
		case 'daterange':
			return 'daterange';
		case 'tsrange':
			return 'tsrange';
		case 'tstzrange':
			return 'tstzrange';
		case 'int4range':
			return 'int4range';
		case 'int8range':
			return 'int8range';
		case 'numrange':
			return 'numrange';
		default:
			return undefined;
	}
}

function findRuntimeBindingSourceTable(
	model: ModelIR,
	sourceTable: string,
	naming?: NamingPlugin,
): TableIR | undefined {
	return (
		model.getTable(sourceTable) ??
		[...model.tables.values()].find(
			(table) =>
				table.name === sourceTable ||
				(naming !== undefined && naming.toDatabase(table.name) === sourceTable),
		)
	);
}

function runtimeCastTargetSchema(
	schemaName: string | undefined,
	_naming: NamingPlugin,
): string | undefined {
	return schemaName;
}

function resolveRuntimeBindingColumnType(
	bindingName: string,
	sourceTable: TableIR,
	columnName: string,
	schemaName: string | undefined,
	naming: NamingPlugin,
): string {
	const column = sourceTable.columns.find(
		(candidate) =>
			candidate.name === columnName ||
			naming.toDatabase(candidate.name) === columnName,
	);
	if (column === undefined) {
		throw new Error(
			`NQL runtime binding '${bindingName}' cannot resolve projected column '${columnName}' on source table '${sourceTable.name}'.`,
		);
	}
	const originalDbType = column.originalDbType?.trim();
	const dbType =
		originalDbType !== undefined
			? renderColumnDbType(column, runtimeCastTargetSchema(schemaName, naming))
			: mapRuntimeBindingColumnType(column.type);
	if (dbType === undefined || dbType.trim() === '') {
		throw new Error(
			`NQL runtime binding '${bindingName}' cannot resolve a PostgreSQL type for projected column '${columnName}' on source table '${sourceTable.name}'.`,
		);
	}
	const typeName = dbType.trim();
	try {
		validateDbType(typeName);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(
			`NQL runtime binding '${bindingName}' cannot use PostgreSQL cast type for projected column '${columnName}': ${reason}`,
		);
	}
	return originalDbType !== undefined ? dbTypeCastTarget(typeName) : typeName;
}

function resolveRuntimeBindingColumnTypes(
	name: string,
	binding: NqlRuntimeBinding,
	model: ModelIR | undefined,
	sourceTableName: string,
	schemaName: string | undefined,
	naming: NamingPlugin,
): readonly string[] {
	if (model === undefined) {
		throw new Error(
			`NQL runtime binding '${name}' cannot materialize non-empty rows because no model is available for source-table column type resolution.`,
		);
	}
	const sourceTable = findRuntimeBindingSourceTable(
		model,
		sourceTableName,
		naming,
	);
	if (sourceTable === undefined) {
		throw new Error(
			`NQL runtime binding '${name}' cannot resolve source table '${sourceTableName}' in the model.`,
		);
	}
	return binding.columns.map((column) =>
		resolveRuntimeBindingColumnType(
			name,
			sourceTable,
			column,
			schemaName,
			naming,
		),
	);
}

function runtimeBindingDeclaredOutputsByColumn(
	declaredOutputs: readonly OutputDescriptor[],
	naming: NamingPlugin,
): ReadonlyMap<string, OutputDescriptor[]> {
	const byColumn = new Map<string, OutputDescriptor[]>();
	for (const entry of declaredOutputs) {
		const outputKey = naming.toDatabase(entry.outputKey);
		const entries = byColumn.get(outputKey) ?? [];
		entries.push(entry);
		byColumn.set(outputKey, entries);
	}
	return byColumn;
}

function resolveRuntimeBindingDeclaredOutputColumnTypes(
	name: string,
	binding: NqlRuntimeBinding,
	model: ModelIR | undefined,
	schemaName: string | undefined,
	naming: NamingPlugin,
): readonly (string | undefined)[] | undefined {
	if (binding.declaredOutputs === undefined) return undefined;
	const descriptorsByColumn = runtimeBindingDeclaredOutputsByColumn(
		binding.declaredOutputs,
		naming,
	);
	const pgTypes: (string | undefined)[] = [];
	for (const column of binding.columns) {
		const entries = descriptorsByColumn.get(naming.toDatabase(column)) ?? [];
		if (entries.length === 0) return undefined;
		if (entries.length > 1) {
			throw new Error(
				`NQL runtime binding '${name}' cannot materialize output column '${column}' because its declared outputs are ambiguous.`,
			);
		}
		const [descriptor] = entries;
		if (descriptor === undefined) return undefined;
		if (
			descriptor.source.kind !== 'modelColumn' ||
			descriptor.shape.kind !== 'scalar'
		) {
			pgTypes.push(undefined);
			continue;
		}
		if (model === undefined) {
			throw new Error(
				`NQL runtime binding '${name}' cannot materialize declared output rows because no model is available for column type resolution.`,
			);
		}
		const sourceTable = findRuntimeBindingSourceTable(
			model,
			descriptor.source.table,
			naming,
		);
		if (sourceTable === undefined) {
			throw new Error(
				`NQL runtime binding '${name}' cannot resolve declared output table '${descriptor.source.table}' in the model.`,
			);
		}
		pgTypes.push(
			resolveRuntimeBindingColumnType(
				name,
				sourceTable,
				descriptor.source.column,
				schemaName,
				naming,
			),
		);
	}
	return pgTypes;
}

function assertRuntimeBindingValuesParameterCount(
	name: string,
	binding: NqlRuntimeBinding,
	parameterOffset: number,
): void {
	const valueParameterCount = binding.rows.length * binding.columns.length;
	if (
		valueParameterCount <= MAX_NQL_RUNTIME_BINDING_VALUES_PARAMETERS &&
		parameterOffset + valueParameterCount <=
			MAX_NQL_RUNTIME_BINDING_VALUES_PARAMETERS
	) {
		return;
	}
	const totalParameterCount = parameterOffset + valueParameterCount;
	throw new Error(
		`NQL runtime binding '${name}' would materialize ${valueParameterCount} VALUES parameters; ` +
			`limit is ${MAX_NQL_RUNTIME_BINDING_VALUES_PARAMETERS}. ` +
			`Current parameter offset is ${parameterOffset}, which would make ${totalParameterCount} total parameters before compiling the final statement.`,
	);
}

/**
 * Resolve the PostgreSQL cast type name for one binding column's neutral
 * type info (#213). `kind: 'aggregate'` maps `count` to `bigint`; any other
 * aggregate kind throws, so a forged or future aggregate variant fails loud
 * here instead of silently mis-typing. Every
 * resolved type name is re-validated via validateDbType — the compiler is
 * never trusted, since PlanCompiler is a public export.
 */
function resolvePgTypeForColumnTypeInfo(
	bindingName: string,
	column: string,
	info: NqlBindingColumnTypeInfo,
	schemaName: string | undefined,
	naming: NamingPlugin,
): string {
	if (info.kind === 'aggregate' && info.fn !== 'count') {
		throw new Error(
			`NQL runtime binding '${bindingName}' cannot resolve a PostgreSQL type for projected column '${column}': unsupported aggregate kind '${String(info.fn)}'.`,
		);
	}
	const originalDbType =
		info.kind === 'aggregate' ? undefined : info.originalDbType?.trim();
	const rawType =
		info.kind === 'aggregate'
			? 'bigint'
			: originalDbType !== undefined
				? renderColumnDbType(
						{
							name: column,
							type: info.type,
							nullable: true,
							originalDbType,
							...(info.originalDbTypeSchema !== undefined && {
								originalDbTypeSchema: info.originalDbTypeSchema,
							}),
							...(info.originalDbTypeSchemaScope !== undefined && {
								originalDbTypeSchemaScope: info.originalDbTypeSchemaScope,
							}),
						},
						runtimeCastTargetSchema(schemaName, naming),
					)
				: mapRuntimeBindingColumnType(info.type);
	if (rawType === undefined || rawType.trim() === '') {
		throw new Error(
			`NQL runtime binding '${bindingName}' cannot resolve a PostgreSQL type for projected column '${column}'.`,
		);
	}
	const typeName = rawType.trim();
	try {
		validateDbType(typeName);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(
			`NQL runtime binding '${bindingName}' cannot use PostgreSQL cast type for projected column '${column}': ${reason}`,
		);
	}
	return originalDbType !== undefined ? dbTypeCastTarget(typeName) : typeName;
}

/** Resolve PostgreSQL cast types for every column of a typed runtime binding, in column order. */
function resolveRuntimeBindingCteColumnTypes(
	name: string,
	binding: NqlRuntimeBinding,
	schemaName: string | undefined,
	naming: NamingPlugin,
): readonly string[] {
	const columnTypes = binding.columnTypes;
	if (columnTypes === undefined) {
		throw new Error(
			`NQL runtime binding '${name}' cannot resolve typed columns without a columnTypes map.`,
		);
	}
	return binding.columns.map((column) => {
		const info = columnTypes[column];
		if (info === undefined) {
			throw new Error(
				`NQL runtime binding '${name}' is missing type info for projected column '${column}'.`,
			);
		}
		return resolvePgTypeForColumnTypeInfo(
			name,
			column,
			info,
			schemaName,
			naming,
		);
	});
}

/**
 * Compile a runtime-binding CTE anchored on a SYNTHETIC typed NULL row
 * (`SELECT CAST(NULL AS <t>) AS "<col>", ... WHERE false`) rather than the
 * source table. Used when the binding carries per-column type info
 * (#213) — the source-table anchor cannot be reused because aliased/typed
 * output column names may not exist as physical columns on any one table.
 */
function compileTypedNqlRuntimeBindingCte(
	name: string,
	binding: NqlRuntimeBinding,
	naming: NamingPlugin,
	parameterOffset: number,
	cteName: string,
	columnSql: string,
	targetSchema: string | undefined,
): { cte: string; parameters: readonly unknown[] } {
	const pgTypes = resolveRuntimeBindingCteColumnTypes(
		name,
		binding,
		targetSchema,
		naming,
	);
	return compileNqlRuntimeBindingCteWithPgTypes(
		name,
		binding,
		naming,
		parameterOffset,
		cteName,
		columnSql,
		pgTypes,
	);
}

function compileNqlRuntimeBindingCteWithPgTypes(
	name: string,
	binding: NqlRuntimeBinding,
	naming: NamingPlugin,
	parameterOffset: number,
	cteName: string,
	columnSql: string,
	pgTypes: readonly (string | undefined)[],
): { cte: string; parameters: readonly unknown[] } {
	const anchorColumns = binding.columns
		.map((column, columnIndex) => {
			const columnAlias = quoteIdent(naming.toDatabase(column), 'column');
			const pgType = pgTypes[columnIndex];
			return pgType === undefined
				? `NULL AS ${columnAlias}`
				: `CAST(NULL AS ${pgType}) AS ${columnAlias}`;
		})
		.join(', ');
	const sourceAnchorSql = `SELECT ${anchorColumns} WHERE false`;
	if (binding.rows.length === 0) {
		return {
			cte: `${cteName} (${columnSql}) as (${sourceAnchorSql})`,
			parameters: [],
		};
	}
	assertRuntimeBindingValuesParameterCount(name, binding, parameterOffset);
	const parameters: unknown[] = [];
	let nextParam = parameterOffset + 1;
	const valuesSql = binding.rows
		.map((row) => {
			const placeholders = binding.columns.map((column, columnIndex) => {
				parameters.push(row[column]);
				const paramRef = `$${nextParam++}`;
				const pgType = pgTypes[columnIndex];
				return pgType === undefined ? paramRef : `${paramRef}::${pgType}`;
			});
			return `(${placeholders.join(', ')})`;
		})
		.join(', ');
	return {
		cte: `${cteName} (${columnSql}) as (${sourceAnchorSql} UNION ALL VALUES ${valuesSql})`,
		parameters,
	};
}

function compileNqlRuntimeBindingCte(
	name: string,
	binding: NqlRuntimeBinding,
	naming: NamingPlugin,
	parameterOffset: number,
	sourceTable: string | undefined,
	schemaName: string | undefined,
	model: ModelIR | undefined,
	returningItems?: readonly MutationReturningItem[],
): { cte: string; parameters: readonly unknown[] } {
	// #217: an aliased mutation RETURNING projects OUTPUT names that are not
	// physical columns of the source table. The CTE header (columnSql) names
	// the outputs positionally, so the source-table anchor and the type walk
	// both resolve through the SOURCE column of each output instead.
	if (returningItems !== undefined) {
		if (
			returningItems.length !== binding.columns.length ||
			returningItems.some((item, i) => item.output !== binding.columns[i])
		) {
			throw new Error(
				`NQL runtime binding '${name}' has returningItems desynced from its projected columns.`,
			);
		}
	}
	const sourceColumnFor = (output: string): string =>
		returningItems?.find((item) => item.output === output)?.source ?? output;
	if (binding.columns.length === 0) {
		throw new Error(
			`NQL runtime binding '${name}' cannot be materialized without projected columns.`,
		);
	}
	const cteName = quoteIdent(emittedBindName(name, naming), 'alias');
	const emittedColumnNames = binding.columns.map((column) =>
		naming.toDatabase(column),
	);
	if (new Set(emittedColumnNames).size !== emittedColumnNames.length) {
		throw new Error(
			`NQL runtime binding '${name}' emits duplicate column names after database naming.`,
		);
	}
	const columnSql = binding.columns
		.map((column) => quoteIdent(naming.toDatabase(column), 'column'))
		.join(', ');

	// #213: a binding carrying per-column type info (currently: snapshotted
	// read-bindings) anchors on a synthetic typed NULL row instead of the
	// source table, because aliased output names may not exist as physical
	// columns on it. Mutation bindings (no columnTypes in B1) keep the
	// existing model-walk + FROM-source anchor below, byte-for-byte.
	if (binding.columnTypes !== undefined) {
		return compileTypedNqlRuntimeBindingCte(
			name,
			binding,
			naming,
			parameterOffset,
			cteName,
			columnSql,
			schemaName,
		);
	}
	const declaredOutputPgTypes = resolveRuntimeBindingDeclaredOutputColumnTypes(
		name,
		binding,
		model,
		schemaName,
		naming,
	);
	if (declaredOutputPgTypes !== undefined) {
		return compileNqlRuntimeBindingCteWithPgTypes(
			name,
			binding,
			naming,
			parameterOffset,
			cteName,
			columnSql,
			declaredOutputPgTypes,
		);
	}

	if (sourceTable === undefined) {
		throw new Error(
			`NQL runtime binding '${name}' cannot materialize a typed relation because its source table is unavailable.`,
		);
	}
	const projectedColumns = binding.columns
		.map((column) =>
			quoteIdent(naming.toDatabase(sourceColumnFor(column)), 'column'),
		)
		.join(', ');
	const sourceAnchorSql = `SELECT ${projectedColumns} FROM ${qualifyTableIdent(sourceTable, schemaName, naming)} WHERE false`;
	if (binding.rows.length === 0) {
		return {
			cte: `${cteName} (${columnSql}) as (${sourceAnchorSql})`,
			parameters: [],
		};
	}
	assertRuntimeBindingValuesParameterCount(name, binding, parameterOffset);

	const columnTypes = resolveRuntimeBindingColumnTypes(
		name,
		{ ...binding, columns: binding.columns.map(sourceColumnFor) },
		model,
		sourceTable,
		schemaName,
		naming,
	);
	const parameters: unknown[] = [];
	let nextParam = parameterOffset + 1;
	const valuesSql = binding.rows
		.map((row) => {
			const placeholders = binding.columns.map((column, columnIndex) => {
				parameters.push(row[column]);
				return `$${nextParam++}::${columnTypes[columnIndex]}`;
			});
			return `(${placeholders.join(', ')})`;
		})
		.join(', ');
	return {
		cte: `${cteName} (${columnSql}) as (${sourceAnchorSql} UNION ALL VALUES ${valuesSql})`,
		parameters,
	};
}

function createNqlBindingSelectPlan(query: QueryIntent): PlanReport {
	return {
		rootTable: query.from,
		decisions: [],
		warnings: [],
		ctes: [],
		intent: query,
		metadata: {
			planningTimeMs: 0,
			relationsAnalyzed: 0,
			isAmbiguous: false,
		},
	};
}

type NqlBindingProjectionRegistry = ReadonlyMap<string, ProjectionEnvelope>;

function nqlBindingOutputKey(name: string, naming: NamingPlugin): string {
	return naming.toDatabase(name);
}

function addNqlBindingSelection(
	selections: ProjectNamedFieldsSelection[],
	inputKey: string,
	outputKey: string,
): void {
	selections.push({ inputKey, outputKey });
}

function addNqlBindingExpression(
	expressions: ProjectNamedFieldsExpression[],
	outputKey: string | undefined,
	reason: string,
): void {
	if (outputKey === undefined) return;
	expressions.push({ outputKey, reason });
}

function addNqlBindingStarSelections(
	source: ProjectionEnvelope,
	selections: ProjectNamedFieldsSelection[],
): void {
	if (source.projection.kind === 'dropped') return;
	for (const outputKey of source.projection.outputs.keys()) {
		addNqlBindingSelection(selections, outputKey, outputKey);
	}
}

function nqlBindingAliasOutputKey(
	value: unknown,
	naming: NamingPlugin,
): string | undefined {
	return typeof value === 'string'
		? nqlBindingOutputKey(value, naming)
		: undefined;
}

function nqlBindingExpressionOutputKey(
	expr: ExpressionIntent,
	naming: NamingPlugin,
): string | undefined {
	const record = expr as unknown as Record<string, unknown>;
	return nqlBindingAliasOutputKey(record.as ?? record.alias, naming);
}

function buildNqlBindingProjectionShape(
	source: ProjectionEnvelope,
	select: SelectIntent | undefined,
	naming: NamingPlugin,
): {
	selections: ProjectNamedFieldsSelection[];
	expressions: ProjectNamedFieldsExpression[];
	preserveOneToOne: boolean;
} {
	if (
		!select ||
		typeof select !== 'object' ||
		!('type' in select) ||
		select.type === 'all'
	) {
		return { selections: [], expressions: [], preserveOneToOne: true };
	}

	const selections: ProjectNamedFieldsSelection[] = [];
	const expressions: ProjectNamedFieldsExpression[] = [];

	if (select.type === 'fields') {
		for (const field of select.fields) {
			if (field === '*') {
				addNqlBindingStarSelections(source, selections);
				continue;
			}
			const outputKey = nqlBindingOutputKey(field, naming);
			addNqlBindingSelection(selections, outputKey, outputKey);
		}
		return { selections, expressions, preserveOneToOne: false };
	}

	if (select.type === 'aggregate') {
		for (const field of select.fields ?? []) {
			const outputKey = nqlBindingOutputKey(field, naming);
			addNqlBindingSelection(selections, outputKey, outputKey);
		}
		for (const aggregate of select.aggregates) {
			addNqlBindingExpression(
				expressions,
				nqlBindingAliasOutputKey(aggregate.as, naming),
				'aggregate projection has no raw column provenance',
			);
		}
		return { selections, expressions, preserveOneToOne: false };
	}

	for (const expr of select.columns) {
		const record = expr as unknown as Record<string, unknown>;
		switch (expr.kind) {
			case 'column': {
				const column = record.column;
				if (column === '*') {
					addNqlBindingStarSelections(source, selections);
					break;
				}
				if (typeof column !== 'string') {
					addNqlBindingExpression(
						expressions,
						nqlBindingExpressionOutputKey(expr, naming),
						'column projection could not be resolved',
					);
					break;
				}
				addNqlBindingSelection(
					selections,
					nqlBindingOutputKey(column, naming),
					nqlBindingAliasOutputKey(record.as, naming) ??
						nqlBindingOutputKey(column, naming),
				);
				break;
			}
			case 'columnAlias': {
				const column = record.column;
				const alias = record.alias;
				if (typeof column !== 'string' || typeof alias !== 'string') {
					addNqlBindingExpression(
						expressions,
						nqlBindingExpressionOutputKey(expr, naming),
						'column alias projection could not be resolved',
					);
					break;
				}
				addNqlBindingSelection(
					selections,
					nqlBindingOutputKey(column, naming),
					nqlBindingOutputKey(alias, naming),
				);
				break;
			}
			default:
				addNqlBindingExpression(
					expressions,
					nqlBindingExpressionOutputKey(expr, naming),
					'expression projection has no raw column provenance',
				);
				break;
		}
	}

	return { selections, expressions, preserveOneToOne: false };
}

function projectNqlBindingQueryEnvelope<T = unknown>(
	source: ProjectionEnvelope<T>,
	query: QueryIntent,
	sql: string,
	parameters: readonly unknown[],
	naming: NamingPlugin,
	hydrationPlan: PlanReport | undefined,
): ProjectionEnvelope<T> {
	const shape = buildNqlBindingProjectionShape(source, query.select, naming);
	if (shape.preserveOneToOne) {
		return preserveOneToOne(source, {
			sql,
			parameters,
			...(hydrationPlan !== undefined ? { hydrationPlan } : {}),
			preserveHydrationPlan: false,
		});
	}
	return projectNamedFields(source, {
		sql,
		parameters,
		selections: shape.selections,
		expressions: shape.expressions,
		...(hydrationPlan !== undefined ? { hydrationPlan } : {}),
		preserveHydrationPlan: false,
	});
}

function getNqlBindingProjection(
	registry: NqlBindingProjectionRegistry | undefined,
	name: string,
	naming: NamingPlugin,
): ProjectionEnvelope | undefined {
	return registry?.get(emittedBindName(name, naming));
}
// ============================================================================
// Options
// ============================================================================

/**
 * Options for PgsqlAdapter.
 */
export interface PgsqlPreparedStatementsOptions {
	/** Maximum distinct compiled statements admitted per executor (default: 500). */
	readonly maxStatements?: number;
}

export interface PgsqlAdapterOptions {
	/** Schema name for multi-tenant queries */
	readonly schemaName?: string;
	/**
	 * DB column casing convention (intuitive semantics).
	 * - `'snake_case'`: DB columns are snake_case → transform to camelCase for JS
	 * - `'camelCase'`: DB columns are camelCase → no transformation
	 * - `'preserve'`: No transformation
	 */
	readonly dbCasing?: DbCasing;
	/** Optional model for WHERE compilation */
	readonly model?: ModelIR;
	/** Optional logger for debug/error messages */
	readonly logger?: AdapterLogger;
	/** Default primary key column name for convention fallbacks (default: 'id') */
	readonly defaultPkColumnName?: string;
	/** Convention for deriving FK column names: (tableName, pkName) => fkColumnName */
	readonly deriveFkColumnName?: FkColumnDerivation;
	/**
	 * Opt in to node-postgres named prepared statements for compiled queries with
	 * parameters. `true` uses the default statement cap; an object overrides it.
	 */
	readonly preparedStatements?: boolean | PgsqlPreparedStatementsOptions;
}

interface PgsqlPoolAdapterOptionsBase extends PgsqlAdapterOptions {
	readonly borrowedClient?: false;
}

export type PgsqlPoolAdapterOptions =
	| (PgsqlPoolAdapterOptionsBase & {
			readonly replayInvalidatedPlans?: false | undefined;
	  })
	| (Omit<PgsqlPoolAdapterOptionsBase, 'preparedStatements'> & {
			readonly preparedStatements: true | PgsqlPreparedStatementsOptions;
			/**
			 * Enable one unnamed replay after `0A000`/`RevalidateCachedQuery` only when
			 * you assert that your statements do not invoke functions performing
			 * effectful work before nested prepared-statement operations. This requires
			 * `preparedStatements: true` (or a prepared-statements options object).
			 *
			 * Replay snapshots JSON-like values (finite numbers, strings, booleans,
			 * `null`, arrays, plain or null-prototype objects) and clean `Date`/`Buffer`
			 * instances. It excludes non-finite numbers, `undefined`, `bigint`, functions,
			 * proxies, cycles, sparse arrays, accessors, symbol-valued
			 * parameters, symbol keys on plain objects, exotic prototypes, custom built-ins,
			 * and values with their own node-postgres
			 * `toPostgres` behavior.
			 * Serialization-irrelevant symbol metadata on arrays and Buffers is ignored.
			 * The detached snapshot covers later mutations to the supplied value graph,
			 * not built-in prototypes, timezone state, or node-postgres serialization
			 * configuration; a process-global `toPostgres` or `toJSON` installed while
			 * the call is in flight is outside the guarantee. Each capture or replay copy
			 * is independently limited to 64 Ki visited values, 16 MiB of UTF-8 strings,
			 * and 16 MiB of Buffer data. An ineligible or over-budget value still receives
			 * the initial named submission, but disables transparent replay.
			 * These budgets bound copied nodes and payload bytes; enumerating a plain
			 * object's existing property table is proportional to the caller's own object.
			 *
			 * Replay needs the adapter-owned serialized physical client available from a
			 * pool; it is therefore not supported by borrowed or compile-only adapters.
			 */
			readonly replayInvalidatedPlans: true;
	  });

export interface PgsqlBorrowedClientAdapterOptions extends PgsqlAdapterOptions {
	/** Replay is only available to a pool-owned pinned scope. */
	readonly replayInvalidatedPlans?: never;
	/** This connection belongs to the caller. dbsp never releases it. */
	readonly borrowedClient: true;

	/**
	 * Let dbsp run transactions on your connection, through a savepoint.
	 *
	 * When your connection is already inside a transaction, dbsp creates a
	 * savepoint and rolls back dbsp's changes after that savepoint if the callback
	 * fails. `RELEASE SAVEPOINT` does not commit; it merges the work into your
	 * surrounding transaction, so a callback that succeeded is still undone if you
	 * later roll back. Deferred constraints or triggers can still make your outer
	 * `COMMIT` fail after dbsp has returned. `SET LOCAL` changes inside the callback
	 * remain in effect for the rest of your transaction after the savepoint is
	 * released. `ON COMMIT DROP` and `ON COMMIT DELETE ROWS` fire at your transaction
	 * boundary, not at the savepoint. Sequences are not transactional:
	 * `nextval`/`setval` are not reclaimed by a savepoint rollback. Session-level
	 * advisory locks ignore rollback; transaction-level advisory locks taken by a
	 * successful callback last until your transaction ends.
	 *
	 * Transaction control through raw SQL inside a scope dbsp is managing is
	 * unsupported. `COMMIT`, `ROLLBACK`, and `PREPARE TRANSACTION` end the
	 * transaction dbsp is working inside; dbsp detects that and fails loudly, but
	 * the data is already whatever your statement made it. Raw savepoint control
	 * (`SAVEPOINT`, `RELEASE SAVEPOINT`, `ROLLBACK TO SAVEPOINT`) can alter the
	 * savepoint stack before dbsp sees the command tag; dbsp poisons the scope, but
	 * it cannot make that command un-run. Manage your transaction outside dbsp's
	 * calls.
	 */
	readonly managedTransactions?: true;
}

/** Options for a connectionless adapter, which cannot own replay serialization. */
export interface PgsqlCompileOnlyAdapterOptions extends PgsqlAdapterOptions {
	readonly replayInvalidatedPlans?: never;
}

interface PgsqlAdapterInternalOptions extends PgsqlAdapterOptions {
	readonly [pgsqlAdapterInternalOptionsKey]: true;
	/** Propagated only to adapter-owned client scopes created from a pool. */
	readonly replayInvalidatedPlans?: boolean;
	readonly borrowedClient: true;
	readonly managedTransactions?: true;
	readonly adapterManagedTransaction?: true;
	readonly adapterManagedPinnedConnection?: true;
	readonly rollbackOnlyScope?: true;
	readonly dbspScopeToken?: DbspScopeToken;
	readonly dbspScopeState?: DbspScopeState;
	readonly preparedStatementRegistry?: PreparedStatementRegistry;
}

type PgsqlPublicAdapterConstructionOptions =
	| PgsqlAdapterOptions
	| PgsqlPoolAdapterOptions
	| PgsqlBorrowedClientAdapterOptions;

type PgsqlAdapterConstructionOptions =
	| PgsqlPublicAdapterConstructionOptions
	| PgsqlAdapterInternalOptions;

type PgsqlAdapterConstructionOverrides = Partial<PgsqlAdapterOptions> & {
	readonly borrowedClient?: true | false;
	readonly managedTransactions?: true;
};

type PgsqlAdapterInternalConstructionOverrides =
	PgsqlAdapterConstructionOverrides & {
		readonly adapterManagedTransaction?: true;
		readonly adapterManagedPinnedConnection?: true;
		readonly rollbackOnlyScope?: true;
		readonly dbspScopeToken?: DbspScopeToken;
		readonly dbspScopeState?: DbspScopeState;
		readonly preparedStatementRegistry?: PreparedStatementRegistry;
	};

function isPropertyContainer(value: unknown): value is object {
	return (
		value !== null && (typeof value === 'object' || typeof value === 'function')
	);
}

function isPgsqlAdapterInternalOptions(
	options: PgsqlAdapterConstructionOptions | undefined,
): options is PgsqlAdapterInternalOptions {
	return (
		isPropertyContainer(options) &&
		!isProxy(options) &&
		pgsqlAdapterInternalOptionsKey in options &&
		options[pgsqlAdapterInternalOptionsKey] === true
	);
}

function hasBorrowedClientOption(
	options: PgsqlAdapterConstructionOptions | undefined,
): options is PgsqlBorrowedClientAdapterOptions | PgsqlAdapterInternalOptions {
	return (
		isPropertyContainer(options) &&
		!isProxy(options) &&
		'borrowedClient' in options &&
		options.borrowedClient === true
	);
}

function hasManagedTransactionsOption(
	options: PgsqlAdapterConstructionOptions | undefined,
): boolean {
	return (
		isPropertyContainer(options) &&
		!isProxy(options) &&
		'managedTransactions' in options &&
		options.managedTransactions === true
	);
}

type ReplayInvalidatedPlansOption =
	| { readonly present: false }
	| { readonly present: true; readonly value: boolean };

function readReplayInvalidatedPlansOption(
	options: PgsqlAdapterConstructionOptions | undefined,
): ReplayInvalidatedPlansOption {
	if (!isPropertyContainer(options)) return { present: false };
	if (isProxy(options)) {
		throw new Error('replayInvalidatedPlans: expected a boolean.');
	}
	try {
		// A revoked Proxy is no longer reported by isProxy(), but this check still
		// precedes descriptor access and lets the option reader keep its own error.
		'replayInvalidatedPlans' in options;
	} catch {
		throw new Error('replayInvalidatedPlans: expected a boolean.');
	}
	const descriptor = Object.getOwnPropertyDescriptor(
		options,
		'replayInvalidatedPlans',
	);
	if (descriptor === undefined) return { present: false };
	if (!('value' in descriptor) || typeof descriptor.value !== 'boolean') {
		throw new Error('replayInvalidatedPlans: expected a boolean.');
	}
	return { present: true, value: descriptor.value };
}

function isAdapterManagedTransactionOption(
	options: PgsqlAdapterConstructionOptions | undefined,
): boolean {
	return (
		isPgsqlAdapterInternalOptions(options) &&
		options.adapterManagedTransaction === true
	);
}

function isAdapterManagedPinnedConnectionOption(
	options: PgsqlAdapterConstructionOptions | undefined,
): boolean {
	return (
		isPgsqlAdapterInternalOptions(options) &&
		options.adapterManagedPinnedConnection === true
	);
}

function isRollbackOnlyScopeOption(
	options: PgsqlAdapterConstructionOptions | undefined,
): boolean {
	return (
		isPgsqlAdapterInternalOptions(options) && options.rollbackOnlyScope === true
	);
}

function getDbspScopeTokenOption(
	options: PgsqlAdapterConstructionOptions | undefined,
): DbspScopeToken | undefined {
	return isPgsqlAdapterInternalOptions(options)
		? options.dbspScopeToken
		: undefined;
}

function getDbspScopeStateOption(
	options: PgsqlAdapterConstructionOptions | undefined,
): DbspScopeState | undefined {
	return isPgsqlAdapterInternalOptions(options)
		? options.dbspScopeState
		: undefined;
}

function getPreparedStatementRegistryOption(
	options: PgsqlAdapterConstructionOptions | undefined,
): PreparedStatementRegistry | undefined {
	return isPgsqlAdapterInternalOptions(options)
		? options.preparedStatementRegistry
		: undefined;
}

function getOrCreatePreparedStatementRegistry(
	executor: Pool | PoolClient,
	maxStatements: number,
): PreparedStatementRegistry {
	const configured = preparedStatementRegistries.get(executor);
	if (configured === undefined) {
		const registry = new PreparedStatementRegistry(maxStatements);
		preparedStatementRegistries.set(executor, { maxStatements, registry });
		return registry;
	}
	if (configured.maxStatements !== maxStatements) {
		const executorKind = isPoolClientLike(executor)
			? 'borrowed client'
			: 'pool';
		throw new Error(
			`preparedStatements.maxStatements is configured ${executorKind}-wide: ` +
				`expected ${configured.maxStatements}, received ${maxStatements}.`,
		);
	}
	return configured.registry;
}

type NormalizedPreparedStatementsConfig =
	| false
	| Readonly<{ maxStatements: number }>;

function normalizePreparedStatements(
	value: unknown,
): NormalizedPreparedStatementsConfig {
	if (value === undefined || value === false) return false;
	if (value === true) {
		return Object.freeze({
			maxStatements: normalizeMaxPreparedStatements(undefined),
		});
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error(
			'preparedStatements must be true, false, or a non-null options object.',
		);
	}
	return Object.freeze({
		maxStatements: normalizeMaxPreparedStatements(
			(value as PgsqlPreparedStatementsOptions).maxStatements,
		),
	});
}

function clonePreparedStatements(
	config: NormalizedPreparedStatementsConfig,
): false | PgsqlPreparedStatementsOptions {
	return config === false ? false : { maxStatements: config.maxStatements };
}

function createPgsqlAdapterFromConstructionOptions<DB = unknown>(
	connection: Pool | PoolClient | undefined,
	options: PgsqlAdapterConstructionOptions,
): PgsqlAdapter<DB> {
	return new PgsqlAdapter<DB>(
		connection as Pool,
		options as PgsqlPoolAdapterOptions,
	);
}

// ============================================================================
// PgsqlAdapter
// ============================================================================

/**
 * Adapter implementation for PostgreSQL using native pg driver.
 *
 * @typeParam DB - Database schema type
 *
 * @example
 * ```typescript
 * import { Pool } from 'pg';
 * import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const adapter = createPgsqlAdapter(pool);
 * const orm = createOrm({ model, adapter });
 * ```
 */
export class PgsqlAdapter<DB = unknown> implements Adapter<DB> {
	private readonly pool: Pool | undefined;
	private readonly client: PoolClient | undefined;
	private readonly borrowedClient: boolean;
	private readonly managedTransactions: boolean;
	private readonly adapterManagedTransaction: boolean;
	private readonly adapterManagedPinnedConnection: boolean;
	private readonly rollbackOnlyScope: boolean;
	private readonly scopeToken: DbspScopeToken | undefined;
	private readonly scopeState: DbspScopeState | undefined;
	private readonly schemaName: string | undefined;
	private readonly _dbCasing: DbCasing;
	private readonly naming: NamingPlugin;
	private readonly model: ModelIR | undefined;
	private readonly logger: AdapterLogger | undefined;
	private readonly replayInvalidatedPlans: boolean;
	private readonly preparedStatements: NormalizedPreparedStatementsConfig;
	private readonly preparedStatementRegistry:
		| PreparedStatementRegistry
		| undefined;
	private readonly _capabilities: AdapterCapabilities;
	private readonly defaultPk: string;
	private readonly deriveFk: FkColumnDerivation;

	/**
	 * Create a new PgsqlAdapter.
	 *
	 * Ownership of the connection is **declared**, never inferred. Handing over a
	 * `PoolClient` means nothing on its own — it says the object has a `release()`
	 * method, not that a transaction is open or that the caller owns the lifecycle.
	 * Pass `borrowedClient: true` to say so.
	 *
	 * @param pool - a pg.Pool, a caller-owned pg.PoolClient (with `borrowedClient: true`),
	 *   or nothing at all for compile-only mode
	 * @param options - configuration; declares connection ownership
	 */
	constructor(pool: Pool, options?: PgsqlPoolAdapterOptions);
	constructor(client: PoolClient, options: PgsqlBorrowedClientAdapterOptions);
	constructor(pool?: undefined, options?: PgsqlCompileOnlyAdapterOptions);
	constructor(
		pool?: Pool | PoolClient | undefined,
		options?: PgsqlAdapterConstructionOptions,
	) {
		const replayInvalidatedPlansOption =
			readReplayInvalidatedPlansOption(options);
		const declaredBorrowed = hasBorrowedClientOption(options);

		if (pool != null) {
			// The validated structural form selects executor-specific prepared-statement
			// behavior. The declaration controls ownership and lifecycle.
			if (isPoolClientLike(pool)) {
				if (!declaredBorrowed) {
					throw new Error(
						'PgsqlAdapter received a pg PoolClient without borrowedClient: true. ' +
							'A checked-out client belongs to whoever checked it out: declare it with ' +
							'borrowedClient: true, and pass managedTransactions: true if dbsp should run ' +
							'transactions on it.',
					);
				}
				this.client = pool;
				this.pool = undefined;
				this.borrowedClient = true;
			} else {
				if (declaredBorrowed) {
					throw new Error(
						'borrowedClient: true requires a pg PoolClient, not a pg Pool.',
					);
				}
				this.pool = pool;
				this.client = undefined;
				this.borrowedClient = false;
			}
		} else {
			if (declaredBorrowed) {
				throw new Error(
					'borrowedClient: true requires a pg PoolClient; no connection was given.',
				);
			}
			// Compile-only mode — no pool/client
			this.pool = undefined;
			this.client = undefined;
			this.borrowedClient = false;
		}
		if (
			replayInvalidatedPlansOption.present &&
			this.pool === undefined &&
			!isPgsqlAdapterInternalOptions(options)
		) {
			throw new Error(
				'replayInvalidatedPlans requires a pg Pool-owned adapter; it is not supported by borrowed-client or compile-only adapters.',
			);
		}
		this.managedTransactions = hasManagedTransactionsOption(options);
		this.adapterManagedTransaction = isAdapterManagedTransactionOption(options);
		this.adapterManagedPinnedConnection =
			isAdapterManagedPinnedConnectionOption(options);
		this.rollbackOnlyScope = isRollbackOnlyScopeOption(options);
		this.scopeToken = getDbspScopeTokenOption(options);
		this.scopeState = getDbspScopeStateOption(options);

		this.schemaName = options?.schemaName;
		this._dbCasing = options?.dbCasing ?? 'preserve';
		this.naming = getNamingPluginForDbCasing(this._dbCasing);
		this.model = options?.model;
		this.logger = options?.logger;
		this.replayInvalidatedPlans =
			replayInvalidatedPlansOption.present &&
			replayInvalidatedPlansOption.value;
		this.preparedStatements = normalizePreparedStatements(
			options?.preparedStatements,
		);
		if (this.replayInvalidatedPlans && this.preparedStatements === false) {
			throw new Error(
				'replayInvalidatedPlans: true requires preparedStatements: true or a preparedStatements options object.',
			);
		}
		if (this.preparedStatements !== false) {
			const { maxStatements } = this.preparedStatements;
			this.preparedStatementRegistry =
				getPreparedStatementRegistryOption(options) ??
				(this.pool !== undefined
					? getOrCreatePreparedStatementRegistry(this.pool, maxStatements)
					: this.client !== undefined
						? getOrCreatePreparedStatementRegistry(this.client, maxStatements)
						: undefined);
		} else {
			this.preparedStatementRegistry = undefined;
		}
		this.defaultPk = options?.defaultPkColumnName ?? DEFAULT_PK_COLUMN;
		this.deriveFk = options?.deriveFkColumnName ?? defaultFkDerivation;

		const supportsManagedTransactions =
			this.pool != null || (this.client != null && this.managedTransactions);

		// PostgreSQL capabilities — streaming requires a managed transaction.
		this._capabilities = {
			supportsReturning: true,
			supportsSchemas: true,
			supportsStreaming: supportsManagedTransactions,
			supportsTransactions: supportsManagedTransactions,
			supportsTransactionOptions: supportsManagedTransactions,
			supportsPinnedConnections: supportsManagedTransactions,
			supportsRecursiveCTE: true,
			supportsWindowFunctions: true,
			supportsArrayType: true,
		};
	}

	/**
	 * Shared compilation dependencies — built lazily from adapter fields.
	 * Passed to compiler sub-modules instead of `this`.
	 */

	/**
	 * Return a new PgsqlAdapterOptions that merges current config with overrides.
	 * Ensures that all configuration fields (logger, defaultPkColumnName,
	 * deriveFkColumnName, etc.) are propagated to scoped/transactional adapters.
	 */
	private cloneOptions(
		overrides: PgsqlAdapterInternalConstructionOverrides,
	): PgsqlAdapterConstructionOptions {
		const adapterManagedTransaction =
			(overrides.adapterManagedTransaction ?? this.adapterManagedTransaction)
				? true
				: undefined;
		const adapterManagedPinnedConnection =
			adapterManagedTransaction === true
				? undefined
				: (overrides.adapterManagedPinnedConnection ??
						this.adapterManagedPinnedConnection)
					? true
					: undefined;
		const scopeToken = overrides.dbspScopeToken ?? this.scopeToken;
		const scopeState = overrides.dbspScopeState ?? this.scopeState;
		const rollbackOnlyScope =
			(overrides.rollbackOnlyScope ?? this.rollbackOnlyScope)
				? true
				: undefined;
		const preparedStatementRegistry = this.preparedStatementRegistry;
		const hasInternalOptions =
			adapterManagedTransaction === true ||
			adapterManagedPinnedConnection === true ||
			rollbackOnlyScope === true ||
			scopeToken !== undefined ||
			scopeState !== undefined ||
			preparedStatementRegistry !== undefined;
		return {
			...(hasInternalOptions && {
				[pgsqlAdapterInternalOptionsKey]: true as const,
			}),
			...(this.schemaName !== undefined && { schemaName: this.schemaName }),
			...(this._dbCasing !== undefined && { dbCasing: this._dbCasing }),
			...(this.model !== undefined && { model: this.model }),
			...(this.logger !== undefined && { logger: this.logger }),
			...(this.replayInvalidatedPlans && { replayInvalidatedPlans: true }),
			...(this.preparedStatements !== false && {
				preparedStatements: clonePreparedStatements(this.preparedStatements),
			}),
			defaultPkColumnName: this.defaultPk,
			deriveFkColumnName: this.deriveFk,
			...(this.borrowedClient && { borrowedClient: true as const }),
			...(this.managedTransactions && { managedTransactions: true as const }),
			...(adapterManagedTransaction === true && { adapterManagedTransaction }),
			...(adapterManagedPinnedConnection === true && {
				adapterManagedPinnedConnection,
			}),
			...(rollbackOnlyScope === true && { rollbackOnlyScope }),
			...(scopeToken !== undefined && { dbspScopeToken: scopeToken }),
			...(scopeState !== undefined && { dbspScopeState: scopeState }),
			...(preparedStatementRegistry !== undefined && {
				preparedStatementRegistry,
			}),
			...overrides,
		};
	}

	private buildCompileDeps(
		options?: CompileOptions,
		bindingNames?: BindingNameRegistry,
	): AdapterCompilerDeps {
		// Validate schemaName from CompileOptions before use — prevents SQL injection
		// via direct callers of adapter.compile().  Empty string is treated as "no
		// override" (falls through to this.schemaName via ||), so we skip it here;
		// the empty-string → fallback behaviour is covered by existing tests.
		if (options?.schemaName) {
			validateIdentifier(options.schemaName, 'schema');
		}
		const naming =
			(options as PgsqlInternalCompileOptions | undefined)?.naming ??
			this.naming;
		return {
			naming,
			// `||` (not `??`): empty string is treated as "no override" and falls back to this.schemaName (which may be a configured schema or undefined)
			schemaName: options?.schemaName || this.schemaName,
			model: options?.model ?? this.model,
			dialectCapabilities:
				options?.dialectCapabilities ?? this.dialectCapabilities,
			defaultPk: this.defaultPk,
			deriveFk: this.deriveFk,
			...(bindingNames !== undefined && { bindingNames }),
		};
	}

	private requireNqlCompileModel(options?: CompileOptions): ModelIR {
		const model = options?.model ?? this.model;
		if (model === undefined) {
			throw new Error(
				'Compiling an NQL bundle requires a model. Pass { model } to adapter.compile(compiledNql, { model }) or configure the adapter with a model.',
			);
		}
		return model;
	}

	private assertNqlBindingNamesDisjointFromTables(
		bindingNames: BindingNameRegistry | undefined,
		options?: CompileOptions,
	): void {
		if (bindingNames === undefined || bindingNames.size === 0) return;
		const model = this.requireNqlCompileModel(options);
		const naming = this.buildCompileDeps(options, bindingNames).naming;
		for (const bindingName of bindingNames) {
			const physicalTableName = findPhysicalTableNameCollision(
				model,
				bindingName,
				naming,
			);
			if (physicalTableName !== undefined) {
				throw new Error(
					`NQL binding '${bindingName}' collides with physical table name '${physicalTableName}'. ` +
						'NQL binding names must be disjoint from model table names.',
				);
			}
		}
	}

	private compileNqlMutation(
		bundle: CompiledNqlQuery,
		options?: CompileOptions,
		bindingNames?: BindingNameRegistry,
	): CompiledQuery {
		const mutation = bundle.mutation;
		if (mutation === undefined) {
			throw new Error('NQL bundle did not contain a mutation intent.');
		}

		switch (mutation.type) {
			case 'insert':
				return compileInsertImpl(
					mutation,
					options,
					this.buildCompileDeps(options, bindingNames),
				);
			case 'insert_from':
				return compileInsertFromImpl(
					mutation,
					options,
					this.buildCompileDeps(options, bindingNames),
				);
			case 'update':
				return compileUpdateImpl(
					mutation,
					options,
					this.buildCompileDeps(options, bindingNames),
				);
			case 'delete':
				return compileDeleteImpl(
					mutation,
					options,
					this.buildCompileDeps(options, bindingNames),
				);
			case 'upsert':
				return compileUpsertImpl(
					mutation,
					options,
					this.buildCompileDeps(options, bindingNames),
				);
			case 'upsert_from':
				return compileUpsertFromImpl(
					mutation,
					options,
					this.buildCompileDeps(options, bindingNames),
				);
		}
		throw new Error(
			`Unsupported NQL mutation type: ${(mutation as { type: string }).type}`,
		);
	}

	private compileNqlBundleLeafEnvelope<T = unknown>(
		bundle: CompiledNqlQuery,
		options?: CompileOptions,
		bindingNames?: BindingNameRegistry,
		bindingProjections?: NqlBindingProjectionRegistry,
	): ProjectionEnvelope<T> {
		if (bundle.query !== undefined) {
			const deps = this.buildCompileDeps(options, bindingNames);
			const queryFromBinding = hasBindingName(
				bindingNames,
				bundle.query.from,
				deps.naming,
			);
			const planReport = queryFromBinding
				? (bundle.plan ??
					createNqlBindingSelectPlan(bundle.query as QueryIntent))
				: planFn(bundle.query, this.requireNqlCompileModel(options), {
						dialectCapabilities:
							options?.dialectCapabilities ?? this.dialectCapabilities,
					});
			const compiled = compileSelectEnvelope<T>(planReport, options, deps);
			const registeredSource = getNqlBindingProjection(
				bindingProjections,
				bundle.query.from,
				deps.naming,
			);
			return registeredSource
				? projectNqlBindingQueryEnvelope<T>(
						registeredSource as ProjectionEnvelope<T>,
						bundle.query,
						compiled.sql,
						compiled.parameters,
						deps.naming,
						compiled.hydrationPlan,
					)
				: compiled;
		}
		if (bundle.cteQuery !== undefined) {
			return fromCompiledQuery<T>(
				guardCompiledQuery(
					compileCteQueryImpl<T>(
						bundle.cteQuery,
						options,
						this.buildCompileDeps(options, bindingNames),
						bindingProjections,
					),
					'NQL CTE query',
				),
			);
		}
		if (bundle.setOperation !== undefined) {
			const model = this.requireNqlCompileModel(options);
			return fromCompiledQuery<T>(
				guardCompiledQuery(
					this.compileSetOperationWithBindings<T>(
						bundle.setOperation,
						model,
						options,
						bindingNames,
						bindingProjections,
					),
					'NQL set operation',
				),
			);
		}
		if (bundle.mutation !== undefined) {
			return fromCompiledQuery<T>(
				guardCompiledQuery(
					this.compileNqlMutation(bundle, options, bindingNames),
					'NQL mutation',
				),
			);
		}
		throw new Error('NQL bundle did not contain a compilable intent.');
	}

	private compileNqlBundle<T = unknown>(
		bundle: CompiledNqlQuery,
		options?: CompileOptions,
	): CompiledQuery<T> {
		const ctes: string[] = [];
		const parameters: unknown[] = [];
		const deps = this.buildCompileDeps(options);
		const { naming } = deps;
		const bindingNamesInOrder = removeShadowedNqlBindingNames(
			orderedNqlBindingNames(bundle),
			shadowingLocalCteNames(bundle),
			naming,
		);
		const duplicateEmittedBinding =
			bindingNamesInOrder.length > 0
				? findDuplicateEmittedNqlBindingName(bindingNamesInOrder, naming)
				: undefined;
		if (duplicateEmittedBinding !== undefined) {
			throw new Error(
				`NQL bindings '${duplicateEmittedBinding.originalName}' and '${duplicateEmittedBinding.duplicateName}' emit to duplicate CTE name '${duplicateEmittedBinding.emittedName}'. ` +
					'NQL binding names must be unique after database naming.',
			);
		}
		const bindingNames =
			bindingNamesInOrder.length > 0
				? new Set(
						bindingNamesInOrder.map((name) => emittedBindName(name, naming)),
					)
				: undefined;
		this.assertNqlBindingNamesDisjointFromTables(bindingNames, options);
		const bindingProjections = new Map<string, ProjectionEnvelope>();

		for (const name of bindingNamesInOrder) {
			const runtimeBinding = bundle.runtimeBindings?.get(name);
			if (runtimeBinding !== undefined) {
				const declaredOutputs =
					runtimeBinding.declaredOutputs ??
					bundle.bindingOutputSchemas?.get(name)?.declaredOutputs;
				const materializedRuntimeBinding =
					declaredOutputs !== undefined &&
					runtimeBinding.declaredOutputs === undefined
						? { ...runtimeBinding, declaredOutputs }
						: runtimeBinding;
				const compiledRuntimeBinding = compileNqlRuntimeBindingCte(
					name,
					materializedRuntimeBinding,
					naming,
					parameters.length,
					runtimeBindingSourceTable(bundle, name),
					deps.schemaName,
					deps.model,
					bundle.mutationBindings?.get(name)?.returningItems,
				);
				ctes.push(compiledRuntimeBinding.cte);
				parameters.push(...compiledRuntimeBinding.parameters);
				bindingProjections.set(
					emittedBindName(name, naming),
					fromOutputDescriptors({
						sql: '',
						parameters: [],
						columns: runtimeBinding.columns,
						...(declaredOutputs !== undefined && { declaredOutputs }),
						naming,
					}),
				);
				continue;
			}

			const queryIntent = bundle.bindings?.get(name);
			if (queryIntent === undefined) {
				throw new Error(
					`NQL binding '${name}' has no query intent or runtime rows to materialize.`,
				);
			}
			const cteName = quoteIdent(emittedBindName(name, naming), 'alias');
			const bindingBundle: CompiledNqlQuery = bundle.mutationBindings?.has(name)
				? { mutation: bundle.mutationBindings.get(name)! }
				: { query: queryIntent };
			const compiled = this.compileNqlBundleLeafEnvelope(
				bindingBundle,
				options,
				bindingNames,
				bindingProjections,
			);
			const outputSchema = bundle.bindingOutputSchemas?.get(name);
			const bindingProjection =
				outputSchema?.declaredOutputs !== undefined
					? fromOutputDescriptors({
							sql: compiled.sql,
							parameters: compiled.parameters,
							columns: outputSchema.columns,
							declaredOutputs: outputSchema.declaredOutputs,
							naming,
							...(compiled.hydrationPlan !== undefined && {
								hydrationPlan: compiled.hydrationPlan,
							}),
						})
					: compiled;
			ctes.push(
				`${cteName} as (${renumberSqlParams(compiled.sql, parameters.length)})`,
			);
			parameters.push(...compiled.parameters);
			bindingProjections.set(emittedBindName(name, naming), bindingProjection);
		}

		const leafBundle: CompiledNqlQuery = {
			...(bundle.query !== undefined && { query: bundle.query }),
			...(bundle.plan !== undefined && { plan: bundle.plan }),
			...(bundle.cteQuery !== undefined && { cteQuery: bundle.cteQuery }),
			...(bundle.mutation !== undefined && { mutation: bundle.mutation }),
			...(bundle.returning !== undefined && { returning: bundle.returning }),
			...(bundle.setOperation !== undefined && {
				setOperation: bundle.setOperation,
			}),
		};
		const compiledEnvelope = this.compileNqlBundleLeafEnvelope<T>(
			leafBundle,
			options,
			bindingNames,
			bindingProjections,
		);
		const compiled = finalizeEnvelope<T>(compiledEnvelope);
		if (ctes.length === 0) {
			return guardCompiledQuery(compiled, 'NQL bundle');
		}

		return guardCompiledQuery(
			rebuildCompiledQuery(compiled, {
				sql: prefixNqlBindingCtes(
					ctes,
					renumberSqlParams(compiled.sql, parameters.length),
				),
				parameters: [...parameters, ...compiled.parameters],
			}),
			'NQL bundle',
		);
	}

	/**
	 * Returns the pool/client executor, or refuses a connectionless adapter.
	 */
	private requireConnection(operation: string): Pool | PoolClient {
		const executor = this.client ?? this.pool;
		if (!executor) {
			throw new Error(
				`Cannot ${operation}: this PgsqlAdapter was constructed without a connection. ` +
					'Use createPgsqlAdapter(pool) to execute database operations.',
			);
		}
		return executor;
	}

	/** Adapter capabilities for feature detection */
	get capabilities(): AdapterCapabilities {
		return this._capabilities;
	}

	/** Per-instance connection state, distinct from PostgreSQL capabilities. */
	get connectionAvailability(): ConnectionAvailability {
		return (this.client ?? this.pool)
			? PGSQL_CONNECTION_AVAILABLE
			: PGSQL_CONNECTION_UNAVAILABLE;
	}

	/** Side-effect-free execution availability for core feature detection. */
	executionAvailable(): boolean {
		return (this.client ?? this.pool) !== undefined;
	}

	/** PostgreSQL dialect capabilities for planner strategy selection */
	get dialectCapabilities(): DialectCapabilities {
		return POSTGRESQL_CAPABILITIES;
	}

	/**
	 * DB column casing convention used by this adapter.
	 */
	get dbCasing(): DbCasing {
		return this._dbCasing;
	}

	/**
	 * Get the underlying pg Pool or borrowed PoolClient instance.
	 *
	 * Exposing raw access from a pool-owned dbsp-managed scope permanently taints that
	 * physical client: external callers can queue commands outside dbsp's statement
	 * lock, so replay is disabled and dbsp destroys the client at scope release.
	 * Expect pool churn; session state on that exposed connection does not survive the
	 * release. A borrowed client remains caller-owned: dbsp never releases it, and the
	 * caller decides its fate after raw exposure.
	 */
	getPoolInstance(): Pool | PoolClient {
		const executor = this.requireConnection('getPoolInstance()');
		if (
			isPoolClientLike(executor) &&
			(this.adapterManagedTransaction || this.adapterManagedPinnedConnection)
		) {
			if (!this.adapterManagedScopeIsLive()) {
				throw new Error(this.managedScopeEndedMessage());
			}
			rawClientExposures.add(executor);
		}
		return executor;
	}

	// =========================================================================
	// CompilingAdapter Methods
	// =========================================================================

	/**
	 * Compile a plan to executable SQL.
	 *
	 * When passed a direct `CompiledNqlQuery`, the adapter trusts that the bundle
	 * has already been semantically validated by the NQL compiler. This method
	 * still performs adapter-owned SQL safety checks for emitted binding names
	 * before CTE emission.
	 */
	compile<T = unknown>(
		plan: PlanReport | CompiledNqlQuery,
		options?: CompileOptions,
	): CompiledQuery<T> {
		if (isCompiledNqlQuery(plan)) {
			return this.compileNqlBundle<T>(plan, options);
		}
		return guardCompiledQuery(
			compileSelect<T>(plan, options, this.buildCompileDeps(options)),
			'select plan',
		);
	}

	/**
	 * Compile a plan with includes, returning subquery include metadata (DX-033).
	 */
	compileWithIncludes<T = unknown>(
		plan: PlanReport,
		options?: CompileOptions,
	): CompileResultWithIncludes<T> {
		return guardCompileResultWithIncludes(
			compileWithIncludesImpl<T>(plan, options, this.buildCompileDeps(options)),
			'select plan with includes',
		);
	}

	/**
	 * Compile a subquery include query for given parent IDs (DX-033).
	 * Generates: SELECT * FROM targetTable WHERE foreignKey IN ($1, $2, ...)
	 *
	 * @param info - Subquery include metadata
	 * @param parentIds - Parent record IDs to fetch related records for
	 * @param options - Compile options
	 * @returns Compiled query for fetching related records
	 */
	compileSubqueryInclude(
		info: SubqueryIncludeInfo,
		parentIds: readonly unknown[],
		options?: CompileOptions,
	): CompiledQuery {
		return guardCompiledQuery(
			compileSubqueryIncludeImpl(
				info,
				parentIds,
				options,
				this.buildCompileDeps(options),
			),
			'subquery include',
		);
	}

	/**
	 * Compile a FROM-less SELECT expression to SQL.
	 *
	 * Produces: SELECT <expr>
	 * Example: SELECT nextval('my_seq')
	 *
	 * @param expr - ExpressionIntent to evaluate
	 * @returns Compiled SQL and parameters
	 */
	compileSelectExpression<T = unknown>(
		expr: ExpressionIntent,
	): CompiledQuery<T> {
		const naming = this.naming;
		const schemaName = this.schemaName;
		const dialectCapabilities = this.dialectCapabilities;
		const state = createCompilerState();
		const ctx = {
			naming,
			...(schemaName !== undefined && { schema: schemaName }),
			dialectCapabilities,
			rootTable: '',
			maxRecursiveDepth: MAX_DEPTH_LIMIT,
			compileCustomFnFilter: buildCustomFnFilter,
			// Wire compileSubquery so that SubqueryExpressionIntent nested inside
			// expr (e.g. op('+', subquery(...).asExpr(), literal(1))) compiles
			// correctly via a fresh inner PlanCompiler (same pattern as PlanCompiler
			// case 'selectCustomExpression').
			compileSubquery(
				query: import('@dbsp/types').QueryIntent,
				paramOffset: number,
			): CompileSubqueryResult {
				const innerCompiler = new PlanCompiler({
					naming,
					...(schemaName !== undefined && { schema: schemaName }),
					dialectCapabilities,
				});
				const innerPlan = {
					rootTable: query.from,
					decisions: intentToDecisions(query, query.from),
				};
				const innerResult = innerCompiler.compile(innerPlan);
				const renumbered = renumberParamRefsInAst(innerResult.ast, paramOffset);
				return { ast: renumbered, parameters: innerResult.parameters };
			},
		};
		const node = compileExpressionIntent(expr, ctx, state);
		const ast = selectStmt({
			targetList: [{ ResTarget: { val: node } }],
		});
		const sql = deparseQuoted(ast);
		return guardCompiledQuery(
			projectionlessCompiledQuery(
				{ sql, parameters: state.parameters },
				'fromless-select-expression',
			),
			'select expression',
		);
	}

	/**
	 * Compile an insert intent to executable SQL.
	 *
	 * Strategy switch (per CompileOptions):
	 * - rows <= batchThreshold (default 50): VALUES ($1,$2),($3,$4),...
	 * - rows > batchThreshold OR batchThreshold === 0: SELECT unnest($1::type[]),...
	 */
	compileInsert(intent: InsertIntent, options?: CompileOptions): CompiledQuery {
		return guardCompiledQuery(
			compileInsertImpl(intent, options, this.buildCompileDeps(options)),
			'insert',
		);
	}

	/**
	 * Compile an insert-from intent to executable SQL (NQL-ALIGN).
	 * INSERT INTO target (cols) SELECT cols FROM source WHERE ... LIMIT ... RETURNING ...
	 */
	compileInsertFrom(
		intent: InsertFromIntent,
		options?: CompileOptions,
	): CompiledQuery {
		return guardCompiledQuery(
			compileInsertFromImpl(intent, options, this.buildCompileDeps(options)),
			'insert from',
		);
	}

	/**
	 * Compile an update intent to executable SQL.
	 */
	compileUpdate(intent: UpdateIntent, options?: CompileOptions): CompiledQuery {
		return guardCompiledQuery(
			compileUpdateImpl(intent, options, this.buildCompileDeps(options)),
			'update',
		);
	}

	/**
	 * Compile a batch update intent to executable SQL using unnest FROM strategy (BATCH-001).
	 *
	 * Generates:
	 *   UPDATE "table" SET "update_col" = t."update_col" [, "scalar_col" = $N]
	 *   FROM unnest(CAST($1 AS type[]), CAST($2 AS type[])) AS t("match_col", "update_col")
	 *   WHERE "table"."match_col" = t."match_col"
	 *   [RETURNING ...]
	 */
	compileBatchUpdate(
		intent: BatchUpdateIntent,
		options?: CompileOptions,
	): CompiledQuery {
		return guardCompiledQuery(
			compileBatchUpdateImpl(intent, options, this.buildCompileDeps(options)),
			'batch update',
		);
	}

	/**
	 * Compile a delete intent to executable SQL.
	 */
	compileDelete(intent: DeleteIntent, options?: CompileOptions): CompiledQuery {
		return guardCompiledQuery(
			compileDeleteImpl(intent, options, this.buildCompileDeps(options)),
			'delete',
		);
	}

	/**
	 * Compile an upsert intent to executable SQL (DX-026).
	 */
	compileUpsert(intent: UpsertIntent, options?: CompileOptions): CompiledQuery {
		return guardCompiledQuery(
			compileUpsertImpl(intent, options, this.buildCompileDeps(options)),
			'upsert',
		);
	}

	/**
	 * Compile an upsert-from intent to executable SQL (NQL-BIND).
	 * INSERT INTO target SELECT ... FROM source ON CONFLICT (cols) DO UPDATE SET ...
	 */
	compileUpsertFrom(
		intent: UpsertFromIntent,
		options?: CompileOptions,
	): CompiledQuery {
		return guardCompiledQuery(
			compileUpsertFromImpl(intent, options, this.buildCompileDeps(options)),
			'upsert from',
		);
	}

	/**
	 * Compile a recursive CTE plan to executable SQL.
	 * Supports adjacency-list and edge-table traversal modes.
	 */
	compileRecursive<T = unknown>(
		report: RecursivePlanReport,
		model: ModelIR,
		options?: CompileOptions,
	): CompiledQuery<T> {
		return guardCompiledQuery(
			compileRecursiveImpl<T>(
				report,
				model,
				options,
				this.buildCompileDeps(options),
			),
			'recursive query',
		);
	}

	/**
	 * Compile a CTE query backed by unnest() arrays (BATCH-001 Block 5).
	 *
	 * Strategy: compile CTE nodes to SQL fragments, compile outer query
	 * independently (parameters starting at $1), then renumber outer params
	 * to start after CTE params and prepend WITH clause.
	 */
	compileCteQuery<T = unknown>(
		intent: CteQueryIntent,
		options?: CompileOptions,
	): CompiledQuery<T> {
		return guardCompiledQuery(
			compileCteQueryImpl<T>(intent, options, this.buildCompileDeps(options)),
			'CTE query',
		);
	}

	/**
	 * Compile a set operation (UNION / INTERSECT / EXCEPT) to SQL.
	 */
	compileSetOperation<T = unknown>(
		intent: SetOperationIntent,
		model: ModelIR,
		options?: CompileOptions,
	): CompiledQuery<T> {
		return guardCompiledQuery(
			this.compileSetOperationWithBindings<T>(intent, model, options),
			'set operation',
		);
	}

	private compileSetOperationWithBindings<T = unknown>(
		intent: SetOperationIntent,
		model: ModelIR,
		options?: CompileOptions,
		bindingNames?: BindingNameRegistry,
		bindingProjections?: NqlBindingProjectionRegistry,
	): CompiledQuery<T> {
		const compileFn: LeafCompileFn = (query) => {
			const leafOptions: CompileOptions & { model: ModelIR } = {
				...options,
				model,
			};
			const deps = this.buildCompileDeps(leafOptions, bindingNames);
			const queryFromBinding = hasBindingName(
				bindingNames,
				query.from,
				deps.naming,
			);
			const planReport = queryFromBinding
				? createNqlBindingSelectPlan(query)
				: planFn(query, model, {
						dialectCapabilities:
							options?.dialectCapabilities ?? this.dialectCapabilities,
					});
			const compiled = compileSelectEnvelope(planReport, leafOptions, deps);
			const registeredSource = getNqlBindingProjection(
				bindingProjections,
				query.from,
				deps.naming,
			);
			return registeredSource
				? projectNqlBindingQueryEnvelope(
						registeredSource,
						query,
						compiled.sql,
						compiled.parameters,
						deps.naming,
						compiled.hydrationPlan,
					)
				: compiled;
		};
		const envelope = compileSetOperationEnvelopeImpl(intent, compileFn);
		return guardCompiledQuery(finalizeEnvelope<T>(envelope), 'set operation');
	}

	/**
	 * Create a dump for observability.
	 */
	createDump(plan: PlanReport, query: CompiledQuery, meta?: DumpMeta): Dump {
		return {
			plan,
			sql: query.sql,
			params: query.parameters,
			meta: {
				...(this.schemaName !== undefined && { schema: this.schemaName }),
				compiledAt: new Date(),
				...meta,
			},
		};
	}

	// =========================================================================
	// ExecutingAdapter Methods
	// =========================================================================

	/**
	 * Execute a query and return all results.
	 * Results are transformed to use model naming convention (e.g., snake_case → camelCase)
	 */
	async execute<T>(query: CompiledQuery<T>): Promise<T[]> {
		const result = await this.executeWithMeta(query);
		return result.rows as T[];
	}

	/**
	 * Execute a query and return rows plus PostgreSQL result metadata.
	 * Results are transformed to use model naming convention (e.g., snake_case → camelCase)
	 */
	async executeWithMeta(query: CompiledQuery): Promise<{
		readonly rows: readonly unknown[];
		readonly rowCount: number;
		readonly command?: string;
	}> {
		this.requireConnection('execute');
		const guardedQuery = guardCompiledQuery(query, 'execute');
		const result = await this.executeQueryProtectingOpenTransaction<
			Record<string, unknown>
		>(guardedQuery.sql, guardedQuery.parameters, { prepareEligible: true });
		const metadata = queryResultMetadata(result);
		const rows = this.transformResultRows(result.rows, guardedQuery);
		return {
			rows,
			rowCount: metadata.rowCount ?? 0,
			...(metadata.command !== undefined ? { command: metadata.command } : {}),
		};
	}

	/**
	 * Transform result rows from database naming to model naming convention.
	 * For CamelCaseNamingPlugin: price_cents → priceCents
	 */
	private transformResultRows(
		rows: Record<string, unknown>[],
		query: CompiledQuery,
	): Record<string, unknown>[] {
		return rows.map((row) => {
			const transformed: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(row)) {
				const metadata = query.columnMetadata?.get(key);
				const converted =
					metadata !== undefined
						? convertBigintJsReadValue(value, metadata.js, {
								table: metadata.table,
								column: metadata.column,
								outputKey: key,
							})
						: value;
				// Use toModel to convert database column name to model column name
				const modelKey = this.naming.toModel(key);
				transformed[modelKey] = converted;
			}
			return transformed;
		});
	}

	/**
	 * Execute a query and return the first result or null.
	 */
	async executeOne<T>(query: CompiledQuery<T>): Promise<T | null> {
		const results = await this.execute<T>(query);
		return results[0] ?? null;
	}

	/**
	 * Execute a query and return the first result or throw.
	 */
	async executeOneOrThrow<T>(query: CompiledQuery<T>): Promise<T> {
		const result = await this.executeOne<T>(query);
		if (result === null) {
			throw new Error('No results found');
		}
		return result;
	}

	// =========================================================================
	// StreamingAdapter Methods
	// =========================================================================

	/**
	 * Stream query results as an async iterable iterator.
	 * Uses PostgreSQL cursors for efficient streaming.
	 *
	 * Note: The cursor must be used within a transaction. If not already
	 * in a transaction, this method wraps the streaming in one.
	 *
	 * @param query - Compiled query to stream
	 * @param options - Stream options (chunkSize)
	 * @returns AsyncIterableIterator that yields rows one by one
	 */
	stream<T>(
		query: CompiledQuery<T>,
		options?: AdapterStreamOptions,
	): AsyncIterableIterator<T> {
		const guardedQuery = guardCompiledQuery(query, 'stream');
		return this.streamCursor<T>(
			guardedQuery.sql,
			guardedQuery.parameters,
			options,
			(rows) => this.transformResultRows(rows, guardedQuery) as T[],
			'stream',
		);
	}

	/** Stream raw SQL directly using the same cursor machinery as stream(). */
	streamRaw<T = unknown>(
		sql: string,
		parameters: readonly unknown[] = [],
		options?: AdapterStreamOptions,
	): AsyncIterableIterator<T> {
		return this.streamCursor<T>(
			sql,
			parameters,
			options,
			(rows) => rows as T[],
			'streamRaw',
		);
	}

	private streamCursor<T>(
		sql: string,
		parameters: readonly unknown[],
		options: AdapterStreamOptions | undefined,
		mapRows: StreamRowMapper<T>,
		operation: 'stream' | 'streamRaw',
	): AsyncIterableIterator<T> {
		const chunkSize = options?.chunkSize ?? 100;
		if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
			throw new Error(
				`Invalid stream chunkSize: ${chunkSize}. Must be a positive integer.`,
			);
		}
		const resolvedOptions = resolveTransactionBeginOptions(options);
		const adapter = this;

		// Use a wrapper to create the async generator
		async function* streamGenerator(): AsyncIterableIterator<T> {
			adapter.requireConnection(operation);
			if (adapter.client) {
				if (!adapter.managedTransactions) {
					throw new Error(
						'stream() requires a PostgreSQL transaction because cursors do not survive outside one. ' +
							'This adapter uses a borrowed PoolClient; pass managedTransactions: true ' +
							'to let dbsp open a transaction or savepoint for the stream.',
					);
				}
				yield* adapter.streamWithManagedClient<T>(
					adapter.client,
					sql,
					parameters,
					chunkSize,
					mapRows,
					resolvedOptions,
				);
				return;
			}

			// Otherwise, acquire a client and create a transaction
			const pool = adapter.requireConnection(operation) as Pool;
			const client = await pool.connect();
			let begun = false;
			let committed = false;
			let streamFailed = false;
			let releaseScope: (() => void) | undefined;
			let scopeToken: DbspScopeToken | undefined;
			let scopeState: DbspScopeState | undefined;
			let releaseError: Error | boolean | undefined;
			let cleanupErrorToThrow: unknown;
			let streamRolledBackBeforeClose = false;
			try {
				scopeToken = createScopeToken();
				scopeState = createScopeState();
				releaseScope = adapter.enterTransactionScope(
					client,
					scopeToken,
					scopeState,
				);
				await adapter.executeScopeBoundaryStatement(
					client,
					scopeToken,
					scopeState,
					transactionBeginSql(resolvedOptions),
				);
				begun = true;
				await adapter.applyTransactionTimeouts(
					client,
					scopeToken,
					scopeState,
					resolvedOptions,
				);
				scopeState.streamFailureRecovery = async () => {
					await adapter.rollbackTransactionIfOpen(
						client,
						scopeToken,
						scopeState,
					);
					streamRolledBackBeforeClose = true;
				};
				yield* adapter.streamWithClient<T>(
					client,
					sql,
					parameters,
					chunkSize,
					mapRows,
					scopeToken,
					scopeState.streamFailureRecovery,
				);
				adapter.closeScopeAndAssertChildren(scopeState);
				await adapter.drainScopeWork(scopeState);
				adapter.throwIfScopePoisoned(scopeState);
				const commitResult = await adapter.executeScopeBoundaryStatement(
					client,
					scopeToken,
					scopeState,
					'COMMIT',
				);
				committed = true;
				adapter.assertCommitSucceeded(commitResult);
			} catch (error) {
				let transactionError = error;
				try {
					adapter.closeScopeAndAssertChildren(scopeState);
				} catch (scopeError) {
					transactionError = scopeError;
				}
				transactionError = transactionTimeoutErrorOrOriginal(
					transactionError,
					resolvedOptions,
				);
				streamFailed = true;
				if (begun && !committed && !streamRolledBackBeforeClose) {
					try {
						await adapter.rollbackTransactionIfOpen(
							client,
							scopeToken,
							scopeState,
						);
					} catch (rollbackErr) {
						releaseError = rollbackErr instanceof Error ? rollbackErr : true;
						throw createCleanupFailureError(
							'PostgreSQL stream cleanup failed: ROLLBACK failed after the stream failed',
							transactionError,
							rollbackErr,
						);
					}
				}
				throw transactionError;
			} finally {
				// On early break, yield* returns without reaching COMMIT.
				// ROLLBACK the open transaction to avoid leaking it to the pool.
				if (
					begun &&
					!committed &&
					!streamFailed &&
					!streamRolledBackBeforeClose
				) {
					adapter.closeScope(scopeState);
					try {
						await adapter.rollbackTransactionIfOpen(
							client,
							scopeToken,
							scopeState,
						);
					} catch (rollbackErr) {
						releaseError = rollbackErr instanceof Error ? rollbackErr : true;
						cleanupErrorToThrow = createCleanupOnlyError(
							'PostgreSQL stream cleanup failed: ROLLBACK failed after the stream was closed early',
							rollbackErr,
						);
					}
				}
				releaseScope?.();
				adapter.releaseClient(client, releaseError);
				if (cleanupErrorToThrow !== undefined) {
					raise(cleanupErrorToThrow);
				}
			}
		}

		return streamGenerator();
	}

	/**
	 * Internal: Stream with an existing client using cursors.
	 */
	private async *streamWithClient<T>(
		client: PoolClient,
		sql: string,
		parameters: readonly unknown[],
		chunkSize: number,
		mapRows: StreamRowMapper<T>,
		allowedScopeToken?: DbspScopeToken,
		recoverBeforeCloseOnError?: () => Promise<void>,
	): AsyncIterableIterator<T> {
		// Generate unique cursor name
		const cursorName = generateCursorName();

		// Declare cursor
		await this.executeConnectionStatement(
			client,
			`DECLARE ${cursorName} NO SCROLL CURSOR FOR ${sql}`,
			parameters as unknown[],
			{
				...(allowedScopeToken !== undefined && { allowedScopeToken }),
			},
		);

		let streamError: unknown;
		try {
			// Fetch in batches
			while (true) {
				const result = await this.executeConnectionStatement(
					client,
					`FETCH FORWARD ${chunkSize} FROM ${cursorName}`,
					undefined,
					{
						...(allowedScopeToken !== undefined && { allowedScopeToken }),
					},
				);

				if (result.rows.length === 0) {
					break;
				}

				const transformedRows = mapRows(
					result.rows as Record<string, unknown>[],
				);
				for (const row of transformedRows) {
					yield row as T;
				}

				// If we got fewer rows than batch size, we're done
				if (result.rows.length < chunkSize) {
					break;
				}
			}
		} catch (error) {
			streamError = error;
			throw error;
		} finally {
			if (
				streamError !== undefined &&
				recoverBeforeCloseOnError !== undefined
			) {
				try {
					await recoverBeforeCloseOnError();
				} catch (cleanupErr) {
					raise(
						createCleanupFailureError(
							'PostgreSQL stream cleanup failed: rollback before CLOSE cursor failed after the stream failed',
							streamError,
							cleanupErr,
						),
					);
				}
			}
			// Always close the cursor
			try {
				await this.executeConnectionStatement(
					client,
					`CLOSE ${cursorName}`,
					undefined,
					{
						...(allowedScopeToken !== undefined && { allowedScopeToken }),
						allowPoisonedScope: true,
					},
				);
			} catch (cleanupErr) {
				if (streamError !== undefined) {
					raise(addCleanupErrorToOriginal(streamError, cleanupErr));
				}
				raise(
					createCleanupOnlyError(
						'PostgreSQL stream cleanup failed: CLOSE cursor failed',
						cleanupErr,
					),
				);
			}
		}
	}

	private async *streamWithManagedClient<T>(
		client: PoolClient,
		sql: string,
		parameters: readonly unknown[],
		chunkSize: number,
		mapRows: StreamRowMapper<T>,
		options: ResolvedPgsqlTransactionBeginOptions,
	): AsyncIterableIterator<T> {
		if (this.adapterManagedPinnedConnection) {
			this.assertCanUseClient(client, this.scopeToken);
			yield* this.streamWithClientTransaction<T>(
				client,
				sql,
				parameters,
				chunkSize,
				mapRows,
				options,
			);
			return;
		}
		if (this.adapterManagedTransaction) {
			this.assertCanUseClient(client, this.scopeToken);
			if (
				options.isolationLevel !== undefined ||
				options.readOnly !== undefined ||
				options.timeoutStatements.length > 0
			) {
				yield* this.streamWithManagedClientSavepointScope<T>(
					client,
					sql,
					parameters,
					chunkSize,
					mapRows,
					options,
				);
				return;
			}
			yield* this.streamWithClient<T>(
				client,
				sql,
				parameters,
				chunkSize,
				mapRows,
				this.scopeToken,
				this.scopeState?.streamFailureRecovery,
			);
			return;
		}
		yield* this.streamWithManagedClientSavepointScope<T>(
			client,
			sql,
			parameters,
			chunkSize,
			mapRows,
			options,
		);
	}

	private async *streamWithManagedClientSavepointScope<T>(
		client: PoolClient,
		sql: string,
		parameters: readonly unknown[],
		chunkSize: number,
		mapRows: StreamRowMapper<T>,
		options: ResolvedPgsqlTransactionBeginOptions,
	): AsyncIterableIterator<T> {
		const savepointName = nextSavepointName();
		const scopeToken = this.scopeToken ?? createScopeToken();
		const scopeState = this.scopeState ?? createScopeState();
		const releaseScope = this.enterSavepointScope(
			client,
			scopeToken,
			scopeState,
			'statement',
		);
		try {
			await this.executeConnectionStatement(
				client,
				`SAVEPOINT ${savepointName}`,
				undefined,
				{
					allowedScopeToken: scopeToken,
					inspectTransactionControl: false,
				},
			);
		} catch (error) {
			releaseScope();
			if (isPgErrorWithCode(error, NO_ACTIVE_SQL_TRANSACTION)) {
				yield* this.streamWithClientTransaction(
					client,
					sql,
					parameters,
					chunkSize,
					mapRows,
					options,
				);
				return;
			}
			throw error;
		}

		let completed = false;
		let streamError: unknown;
		let timeoutSnapshot: PgsqlTransactionTimeoutSnapshot = [];
		let savepointRolledBackBeforeClose = false;
		const recoverStreamFailure = async () => {
			const rolledBack = await this.rollbackSavepoint(
				client,
				savepointName,
				scopeToken,
				scopeState,
			);
			savepointRolledBackBeforeClose ||= rolledBack;
		};
		try {
			assertTopLevelOnlyTransactionOptionsAreAbsent(options);
			timeoutSnapshot = await this.captureAndApplySavepointTimeouts(
				client,
				scopeToken,
				scopeState,
				options,
			);
			yield* this.streamWithClient<T>(
				client,
				sql,
				parameters,
				chunkSize,
				mapRows,
				scopeToken,
				recoverStreamFailure,
			);
			completed = true;
		} catch (error) {
			streamError = transactionTimeoutErrorOrOriginal(error, options);
			throw streamError;
		} finally {
			try {
				this.closeScope(scopeState);
				if (completed) {
					this.assertScopeChildrenSettled(scopeState);
					await this.drainScopeWork(scopeState);
					this.throwIfScopePoisoned(scopeState);
					try {
						await this.restoreSavepointTimeouts(
							client,
							scopeToken,
							scopeState,
							timeoutSnapshot,
						);
					} catch (restoreErr) {
						raise(
							await this.rollbackSavepointAfterReleaseFailure(
								client,
								savepointName,
								scopeToken,
								scopeState,
								restoreErr,
								'PostgreSQL stream cleanup failed: timeout restore failed before RELEASE SAVEPOINT after the stream completed',
							),
						);
					}
					try {
						await this.executeScopeBoundaryStatement(
							client,
							scopeToken,
							scopeState,
							`RELEASE SAVEPOINT ${savepointName}`,
							{
								allowAncestorScopeToken: true,
							},
						);
					} catch (releaseErr) {
						raise(
							await this.rollbackSavepointAfterReleaseFailure(
								client,
								savepointName,
								scopeToken,
								scopeState,
								releaseErr,
								'PostgreSQL stream cleanup failed: RELEASE SAVEPOINT failed after the stream completed',
							),
						);
					}
				} else {
					try {
						if (savepointRolledBackBeforeClose) {
							await this.releaseSavepoint(
								client,
								savepointName,
								scopeToken,
								scopeState,
							);
						} else {
							await this.rollbackAndReleaseSavepoint(
								client,
								savepointName,
								scopeToken,
								scopeState,
							);
						}
					} catch (cleanupErr) {
						if (streamError !== undefined) {
							raise(
								createCleanupFailureError(
									'PostgreSQL stream cleanup failed: savepoint cleanup failed after the stream failed',
									streamError,
									cleanupErr,
								),
							);
						}
						raise(
							createCleanupOnlyError(
								'PostgreSQL stream cleanup failed: savepoint cleanup failed after the stream was closed early',
								cleanupErr,
							),
						);
					}
				}
			} finally {
				releaseScope();
			}
		}
	}

	private async *streamWithClientTransaction<T>(
		client: PoolClient,
		sql: string,
		parameters: readonly unknown[],
		chunkSize: number,
		mapRows: StreamRowMapper<T>,
		options: ResolvedPgsqlTransactionBeginOptions,
	): AsyncIterableIterator<T> {
		let begun = false;
		let committed = false;
		let streamFailed = false;
		let cleanupErrorToThrow: unknown;
		let releaseScope: (() => void) | undefined;
		let scopeToken: DbspScopeToken | undefined;
		let scopeState: DbspScopeState | undefined;
		let streamRolledBackBeforeClose = false;
		try {
			scopeToken = createScopeToken();
			scopeState = createScopeState(this.scopeState?.statementLock);
			releaseScope = this.enterTransactionScope(client, scopeToken, scopeState);
			await this.executeScopeBoundaryStatement(
				client,
				scopeToken,
				scopeState,
				transactionBeginSql(options),
			);
			begun = true;
			await this.applyTransactionTimeouts(
				client,
				scopeToken,
				scopeState,
				options,
			);
			scopeState.streamFailureRecovery = async () => {
				await this.rollbackTransactionIfOpen(client, scopeToken, scopeState);
				streamRolledBackBeforeClose = true;
			};
			yield* this.streamWithClient<T>(
				client,
				sql,
				parameters,
				chunkSize,
				mapRows,
				scopeToken,
				scopeState.streamFailureRecovery,
			);
			this.closeScopeAndAssertChildren(scopeState);
			await this.drainScopeWork(scopeState);
			this.throwIfScopePoisoned(scopeState);
			const commitResult = await this.executeScopeBoundaryStatement(
				client,
				scopeToken,
				scopeState,
				'COMMIT',
			);
			committed = true;
			this.assertCommitSucceeded(commitResult);
		} catch (error) {
			let transactionError = error;
			try {
				this.closeScopeAndAssertChildren(scopeState);
			} catch (scopeError) {
				transactionError = scopeError;
			}
			transactionError = transactionTimeoutErrorOrOriginal(
				transactionError,
				options,
			);
			streamFailed = true;
			if (begun && !committed && !streamRolledBackBeforeClose) {
				try {
					await this.rollbackTransactionIfOpen(client, scopeToken, scopeState);
				} catch (rollbackErr) {
					throw createCleanupFailureError(
						'PostgreSQL stream cleanup failed: ROLLBACK failed after the stream failed',
						transactionError,
						rollbackErr,
					);
				}
			}
			throw transactionError;
		} finally {
			if (
				begun &&
				!committed &&
				!streamFailed &&
				!streamRolledBackBeforeClose
			) {
				this.closeScope(scopeState);
				try {
					await this.rollbackTransactionIfOpen(client, scopeToken, scopeState);
				} catch (rollbackErr) {
					cleanupErrorToThrow = createCleanupOnlyError(
						'PostgreSQL stream cleanup failed: ROLLBACK failed after the stream was closed early',
						rollbackErr,
					);
				}
			}
			releaseScope?.();
			if (cleanupErrorToThrow !== undefined) {
				raise(cleanupErrorToThrow);
			}
		}
	}

	// =========================================================================
	// IntrospectingAdapter Methods
	// =========================================================================

	/**
	 * Introspect the database schema and return a ModelIR.
	 *
	 * @param options - Optional introspection options (schema, include/exclude filters)
	 * @returns IntrospectedModelIR with tables, relations, and hierarchy metadata
	 *
	 * @example
	 * ```typescript
	 * const model = await adapter.introspect();
	 * const model = await adapter.introspect({ schema: 'tenant_1' });
	 * const model = await adapter.introspect({ exclude: ['_prisma*'] });
	 * ```
	 */
	async introspect(
		options?: IntrospectionOptions,
	): Promise<IntrospectedModelIR> {
		const executor = this.requireConnection('introspect');
		return introspectDb(
			{
				// The brand says this executor already carries the savepoint protection
				// the connection's ownership calls for. A bare PoolClient cannot get here.
				dbspProtectedCatalogExecutor: true as const,
				query: <T extends QueryResultRow = QueryResultRow>(
					sql: string,
					parameters?: readonly unknown[],
				) =>
					this.executeConnectionStatement<T>(executor, sql, parameters, {
						protectBorrowedClientTransaction:
							this.shouldProtectBorrowedClientTransaction(),
					}),
				sequentialCatalogReads: this.client !== undefined,
			},
			options,
		);
	}

	// =========================================================================
	// TransactionalAdapter Methods
	// =========================================================================

	/**
	 * Acquire an exclusive session-level PostgreSQL advisory lock for the callback.
	 *
	 * The lock, callback, and unlock run on one `withPinnedConnection()` adapter.
	 * dbsp performs one PostgreSQL acquire and one matching unlock per call. It
	 * does not track reentrant depth in v1; PostgreSQL's session-level stacking
	 * still applies when callers deliberately nest on the same pinned adapter.
	 */
	withAdvisoryLock<T>(
		key: PgAdvisoryLockKey,
		fn: (locked: Adapter<DB>) => Promise<T>,
	): Promise<T>;
	withAdvisoryLock<T>(
		key: PgAdvisoryLockKey,
		fn: (locked: Adapter<DB>) => Promise<T>,
		options: { readonly wait?: 'block'; readonly signal?: AbortSignal },
	): Promise<T>;
	withAdvisoryLock<T>(
		key: PgAdvisoryLockKey,
		fn: (locked: Adapter<DB>) => Promise<T>,
		options: { readonly wait: 'try'; readonly signal?: AbortSignal },
	): Promise<PgAdvisoryLockResult<T>>;
	withAdvisoryLock<T>(
		key: PgAdvisoryLockKey,
		fn: (locked: Adapter<DB>) => Promise<T>,
		options?: {
			readonly wait?: 'block' | 'try';
			readonly signal?: AbortSignal;
		},
	): Promise<T | PgAdvisoryLockResult<T>>;
	withAdvisoryLock<T>(
		key: PgAdvisoryLockKey,
		fn: (locked: Adapter<DB>) => Promise<T>,
		options?: {
			readonly wait?: 'block' | 'try';
			readonly signal?: AbortSignal;
		},
	): Promise<T | PgAdvisoryLockResult<T>> {
		const lockKey = resolvePgAdvisoryLockKey(key);
		const wait = resolvePgAdvisoryLockWait(options?.wait);
		const pinnedOptions =
			options?.signal === undefined ? undefined : { signal: options.signal };

		return this.withPinnedConnection(async (locked) => {
			const pgLocked = locked as PgsqlAdapter<DB>;
			let acquired = false;
			let hasOriginalError = false;
			let hasResult = false;
			let originalError: unknown;
			let result: T | PgAdvisoryLockResult<T> | undefined;

			try {
				if (wait === 'try') {
					const rows = await pgLocked.executeRaw<{ acquired: boolean }>(
						lockKey.tryLockSql,
						lockKey.parameters,
					);
					if (rows[0]?.acquired !== true) {
						result = { acquired: false };
						hasResult = true;
					} else {
						acquired = true;
						const value = await fn(locked);
						result = { acquired: true, value };
						hasResult = true;
					}
				} else {
					await pgLocked.executeRaw(lockKey.lockSql, lockKey.parameters);
					acquired = true;
					result = await fn(locked);
					hasResult = true;
				}
			} catch (error) {
				hasOriginalError = true;
				originalError = error;
			}

			if (acquired) {
				try {
					await this.unlockAdvisoryLock(pgLocked, lockKey);
				} catch (cleanupError) {
					if (hasOriginalError) {
						throw createCleanupFailureError(
							`PostgreSQL advisory lock cleanup failed: pg_advisory_unlock failed after the advisory lock body failed; ${ADVISORY_LOCK_CLEANUP_OWNERSHIP_MESSAGE}`,
							originalError,
							cleanupError,
						);
					}
					throw createCleanupOnlyError(
						`PostgreSQL advisory lock cleanup failed: pg_advisory_unlock failed after the advisory lock body returned; ${ADVISORY_LOCK_CLEANUP_OWNERSHIP_MESSAGE}`,
						cleanupError,
					);
				}
			}

			if (hasOriginalError) {
				throw originalError;
			}
			if (!hasResult) {
				throw new Error('PostgreSQL advisory lock callback did not settle.');
			}
			return result as T | PgAdvisoryLockResult<T>;
		}, pinnedOptions);
	}

	private async unlockAdvisoryLock(
		locked: PgsqlAdapter<DB>,
		lockKey: ResolvedPgAdvisoryLockKey,
	): Promise<void> {
		const rows = await locked.executeRaw<{ unlocked: boolean }>(
			lockKey.unlockSql,
			lockKey.parameters,
		);
		if (rows[0]?.unlocked !== true) {
			throw new Error(
				`pg_advisory_unlock returned false for ${lockKey.description}; the session did not hold the lock. Pool-owned connections are destroyed before reuse, but borrowed connections remain caller-owned.`,
			);
		}
	}

	withPinnedConnection<T>(
		fn: (adapter: Adapter<DB>) => Promise<T>,
		options?: PinnedConnectionOptions,
	): Promise<T> {
		if (this.client) {
			if (options?.signal !== undefined) {
				return Promise.reject(
					new PgsqlTransactionOptionsError(
						BORROWED_PINNED_CONNECTION_ABORT_SIGNAL_MESSAGE,
					),
				);
			}
			if (this.scopeToken !== undefined && !this.adapterManagedScopeIsLive()) {
				return Promise.reject(new Error(this.managedScopeEndedMessage()));
			}
			const childObserver = this.createChildTransactionObserver();
			return this.observeChildTransaction(
				(async () => {
					let scopeFailure: DbspScopeFailure | undefined;
					try {
						return await fn(this as unknown as Adapter<DB>);
					} catch (error) {
						scopeFailure = { error };
						throw error;
					} finally {
						childObserver?.release(scopeFailure);
					}
				})(),
				childObserver,
			);
		}

		let pool: Pool;
		try {
			pool = this.requireConnection('withPinnedConnection') as Pool;
		} catch (error) {
			return Promise.reject(error);
		}

		return (async () => {
			const signal = options?.signal;
			if (signal?.aborted) {
				throw new PgsqlPinnedConnectionAbortSignalError();
			}
			const client = await pool.connect();
			let released = false;
			const releaseOnce = (reason?: Error | boolean): void => {
				if (released) return;
				released = true;
				this.releaseClient(client, reason);
			};
			const abortErr =
				signal === undefined
					? undefined
					: new PgsqlPinnedConnectionAbortSignalError();
			if (signal?.aborted) {
				releaseOnce(abortErr);
				throw abortErr;
			}

			let callbackSettled = false;
			let onAbort: (() => void) | undefined;
			const removeAbortListener = (): void => {
				if (signal === undefined || onAbort === undefined) return;
				signal.removeEventListener('abort', onAbort);
				onAbort = undefined;
			};
			const abortPromise =
				signal === undefined || abortErr === undefined
					? undefined
					: new Promise<never>((_, reject) => {
							onAbort = () => {
								if (callbackSettled) return;
								try {
									releaseOnce(abortErr);
								} catch {
									// abort() must never throw out of the caller's stack.
								}
								reject(abortErr);
							};
							signal.addEventListener('abort', onAbort, { once: true });
						});

			let caughtError: unknown;
			try {
				const pinnedPromise = this.pinnedConnectionWithClient(
					client,
					async (pinnedAdapter) => {
						try {
							return await fn(pinnedAdapter);
						} finally {
							callbackSettled = true;
						}
					},
				);
				void pinnedPromise.catch(() => undefined);
				return await (abortPromise === undefined
					? pinnedPromise
					: Promise.race([pinnedPromise, abortPromise]));
			} catch (error) {
				caughtError = error;
				throw error;
			} finally {
				removeAbortListener();
				if (!released) {
					releaseOnce(this.pinnedConnectionReleaseReason(caughtError));
				}
			}
		})();
	}

	private pinnedConnectionReleaseReason(
		error: unknown,
	): Error | boolean | undefined {
		if (isRawSqlTransactionControlError(error)) {
			return error instanceof Error ? error : true;
		}
		return cleanupReleaseReason(error);
	}

	private async pinnedConnectionWithClient<T>(
		client: PoolClient,
		fn: (adapter: PgsqlAdapter<DB>) => Promise<T>,
		childObserver?: DbspChildTransactionObserver,
	): Promise<T> {
		let releaseScope: ((failure?: DbspScopeFailure) => void) | undefined;
		let scopeFailure: DbspScopeFailure | undefined;
		let scopeToken: DbspScopeToken | undefined;
		let scopeState: DbspScopeState | undefined;
		try {
			scopeToken = createScopeToken();
			scopeState = createScopeState();
			releaseScope = this.enterPinnedConnectionScope(
				client,
				scopeToken,
				scopeState,
				childObserver,
			);
			const pinnedAdapter = this.createPinnedConnectionAdapter(
				client,
				scopeToken,
				scopeState,
			);
			const result = await fn(pinnedAdapter);
			this.closeScopeAndAssertChildren(scopeState);
			await this.drainScopeWork(scopeState);
			this.throwIfScopePoisoned(scopeState);
			return result;
		} catch (error) {
			let pinnedError = error;
			try {
				this.closeScopeAndAssertChildren(scopeState);
			} catch (scopeError) {
				pinnedError = scopeError;
			}
			await this.drainScopeChildren(scopeState);
			if (scopeState !== undefined) {
				await this.drainScopeWork(scopeState);
				pinnedError = this.scopePoisonOutranksError(scopeState, pinnedError);
			}
			scopeFailure = { error: pinnedError };
			throw pinnedError;
		} finally {
			if (releaseScope === undefined) {
				if (scopeFailure !== undefined) {
					childObserver?.release(scopeFailure);
				}
			} else {
				releaseScope(scopeFailure);
			}
		}
	}

	/**
	 * Execute a callback within a database transaction.
	 *
	 * ## What this guarantees
	 *
	 * The callback's work commits together or not at all; a statement issued inside
	 * the transaction never executes after its boundary, even if you forget to
	 * `await` it; a nested `transaction()` is a real savepoint; and the connection
	 * never goes back to the pool with a transaction still open on it.
	 *
	 * ## What it cannot guarantee, and you should know before you reach for raw SQL
	 *
	 * **Raw SQL that ends the transaction ends it.** `COMMIT`, `ROLLBACK` and
	 * `PREPARE TRANSACTION` issued through `executeRaw` — or through several commands
	 * in one call — reach PostgreSQL and take effect *before* dbsp is told what they
	 * were: the command tag arrives after the statement has run. dbsp detects it, kills
	 * the scope so nothing else escapes, and throws — but **it cannot un-run what your
	 * statement already did**, and `transaction()` rejecting does not mean nothing was
	 * committed.
	 *
	 * The same holds for session state raw SQL creates: a sequence that advanced stays
	 * advanced, an advisory lock stays held, a `PREPARE` or a `SET` you issued survives
	 * on a pooled connection. dbsp cleans up only what dbsp created.
	 *
	 * This is the contract of an escape hatch, not an oversight — see #327. If you need
	 * transaction control, own the transaction: take a client, `BEGIN` on it yourself,
	 * and hand dbsp a `borrowedClient` **without** `managedTransactions`. dbsp will then
	 * contain its own statements inside *your* transaction instead of the other way round.
	 */
	transaction<T>(
		fn: (adapter: Adapter<DB>) => Promise<T>,
		options?: TransactionOptions,
	): Promise<T> {
		const resolvedOptions =
			options === undefined ? undefined : resolveTransactionOptions(options);
		const childObserver = this.createChildTransactionObserver();
		if (this.client) {
			if (resolvedOptions?.signal !== undefined) {
				return Promise.reject(
					new PgsqlTransactionOptionsError(
						BORROWED_TRANSACTION_ABORT_SIGNAL_MESSAGE,
					),
				);
			}
			if (!this.managedTransactions) {
				return Promise.reject(
					new Error(
						'transaction() was called on a PgsqlAdapter created with a borrowed PoolClient. ' +
							'This connection is yours, so the transaction is yours. Pass managedTransactions: true ' +
							'to let dbsp run transactions on it through a savepoint, and read the managedTransactions option documentation for the limits of that contract.',
					),
				);
			}
			if (this.adapterManagedPinnedConnection) {
				return this.observeChildTransaction(
					this.transactionWithClientTransaction(
						this.client,
						fn,
						childObserver,
						'commit',
						resolvedOptions,
					),
					childObserver,
				);
			}
			return this.observeChildTransaction(
				this.transactionWithManagedClient(
					this.client,
					fn,
					childObserver,
					'release',
					resolvedOptions,
				),
				childObserver,
			);
		}

		// Otherwise, acquire a client and start transaction
		let pool: Pool;
		try {
			pool = this.requireConnection('transaction') as Pool;
		} catch (error) {
			return Promise.reject(error);
		}
		return this.observeChildTransaction(
			(async () => {
				const signal = resolvedOptions?.signal;
				if (signal?.aborted) {
					throw new PgsqlTransactionAbortSignalError();
				}
				// Abort during pool.connect() is honored after acquisition; we do not
				// race pool.connect() itself.
				const client = await pool.connect();
				let released = false;
				const releaseOnce = (reason?: Error | boolean): void => {
					if (released) return;
					released = true;
					this.releaseClient(client, reason);
				};
				const abortErr =
					signal === undefined
						? undefined
						: new PgsqlTransactionAbortSignalError();
				if (signal?.aborted) {
					releaseOnce(abortErr);
					throw abortErr;
				}
				let commitStarted = false;
				let onAbort: (() => void) | undefined;
				const removeAbortListener = (): void => {
					if (signal === undefined || onAbort === undefined) return;
					signal.removeEventListener('abort', onAbort);
					onAbort = undefined;
				};
				const abortPromise =
					signal === undefined || abortErr === undefined
						? undefined
						: new Promise<never>((_, reject) => {
								onAbort = () => {
									if (commitStarted) return;
									try {
										releaseOnce(abortErr);
									} catch {
										// abort() must never throw out of the caller's stack.
									}
									reject(abortErr);
								};
								signal.addEventListener('abort', onAbort, { once: true });
							});
				const onCommitStart =
					signal === undefined
						? undefined
						: () => {
								commitStarted = true;
								removeAbortListener();
							};
				let caughtError: unknown;
				try {
					const txPromise = this.transactionWithClientTransaction(
						client,
						fn,
						childObserver,
						'commit',
						resolvedOptions,
						onCommitStart,
					);
					void txPromise.catch(() => undefined);
					return await (abortPromise === undefined
						? txPromise
						: Promise.race([txPromise, abortPromise]));
				} catch (error) {
					caughtError = error;
					throw error;
				} finally {
					removeAbortListener();
					if (!released) {
						releaseOnce(cleanupReleaseReason(caughtError));
					}
				}
			})(),
			childObserver,
		);
	}

	/**
	 * Execute scratch PostgreSQL work in a scope that always rolls back on success.
	 *
	 * This is intentionally PostgreSQL-adapter-specific. It is used for catalog
	 * shaped scratch DDL such as expression canonicalisation, where the caller
	 * needs PostgreSQL's rendering but must not keep the scratch objects. This
	 * scope has exactly one successful exit: rollback. In a caller transaction,
	 * only this outer savepoint is retained after rollback; nested work releases
	 * normally, so a large canonicalisation run cannot retain one subtransaction
	 * per expression.
	 * Rollback here is cleanup of dbsp-created work, not a sandbox for arbitrary
	 * session effects.
	 */
	withScratchScope<T>(
		fn: (adapter: RollbackOnlyPgsqlScope<DB>) => Promise<T>,
	): Promise<T> {
		const childObserver = this.createChildTransactionObserver();
		if (this.client) {
			return this.observeChildTransaction(
				this.transactionWithManagedClient(
					this.client,
					fn as (adapter: PgsqlAdapter<DB>) => Promise<T>,
					childObserver,
					'rollback',
				),
				childObserver,
			);
		}

		let pool: Pool;
		try {
			pool = this.requireConnection('withScratchScope') as Pool;
		} catch (error) {
			return Promise.reject(error);
		}
		return this.observeChildTransaction(
			(async () => {
				const client = await pool.connect();
				let releaseError: Error | boolean | undefined;
				try {
					return await this.transactionWithClientTransaction(
						client,
						fn as (adapter: PgsqlAdapter<DB>) => Promise<T>,
						childObserver,
						'rollback',
					);
				} catch (error) {
					releaseError = cleanupReleaseReason(error);
					throw error;
				} finally {
					this.releaseClient(client, releaseError);
				}
			})(),
			childObserver,
		);
	}

	private createManagedClientAdapter(
		client: PoolClient,
		scopeToken: DbspScopeToken,
		scopeState: DbspScopeState,
		rollbackOnlyScope = false,
	): PgsqlAdapter<DB> {
		return createPgsqlAdapterFromConstructionOptions<DB>(
			client,
			this.cloneOptions({
				borrowedClient: true,
				managedTransactions: true,
				adapterManagedTransaction: true,
				...(rollbackOnlyScope && { rollbackOnlyScope: true as const }),
				dbspScopeToken: scopeToken,
				dbspScopeState: scopeState,
			}),
		);
	}

	private createPinnedConnectionAdapter(
		client: PoolClient,
		scopeToken: DbspScopeToken,
		scopeState: DbspScopeState,
	): PgsqlAdapter<DB> {
		return createPgsqlAdapterFromConstructionOptions<DB>(
			client,
			this.cloneOptions({
				borrowedClient: true,
				managedTransactions: true,
				adapterManagedPinnedConnection: true,
				dbspScopeToken: scopeToken,
				dbspScopeState: scopeState,
			}),
		);
	}

	private createChildTransactionObserver():
		| DbspChildTransactionObserver
		| undefined {
		if (!this.adapterManagedScopeIsLive()) return undefined;
		const parentChildren = this.scopeState?.children;
		if (parentChildren === undefined) return undefined;

		let resolveSettled!: () => void;
		const settledPromise = new Promise<void>((resolve) => {
			resolveSettled = resolve;
		});
		const child: DbspChildTransaction = {
			observed: false,
			failure: undefined,
			settled: false,
			settledPromise,
			resolveSettled,
		};
		parentChildren.open++;
		parentChildren.transactions.add(child);

		let released = false;
		const release = (failure?: DbspScopeFailure) => {
			if (released) return;
			released = true;
			if (failure !== undefined && child.failure === undefined) {
				child.failure = failure;
				if (!child.observed && parentChildren.failure === undefined) {
					parentChildren.failure = failure;
				}
			}
			parentChildren.open--;
			child.settled = true;
			child.resolveSettled();
		};

		return { observed: false, child, parentChildren, release };
	}

	private observeChildTransaction<T>(
		promise: Promise<T>,
		observer: DbspChildTransactionObserver | undefined,
	): Promise<T> {
		if (observer === undefined) return promise;

		const observed = new ObservedChildTransactionPromise(promise, () => {
			this.markChildTransactionObserved(observer);
		});
		// The parent scope owns ignored child failures; suppress host-level
		// unhandled rejection reporting without marking the child observed.
		void Promise.prototype.then.call(observed, undefined, () => undefined);
		return observed;
	}

	private markChildTransactionObserved(
		observer: DbspChildTransactionObserver,
	): void {
		if (observer.observed) return;
		observer.observed = true;
		const child = observer.child;
		child.observed = true;
		const parentChildren = observer.parentChildren;
		if (
			child.failure !== undefined &&
			parentChildren.failure === child.failure
		) {
			this.refreshScopeChildrenFailure(parentChildren);
		}
	}

	private refreshScopeChildrenFailure(children: DbspScopeChildren): void {
		children.failure = undefined;
		for (const child of children.transactions) {
			if (!child.observed && child.failure !== undefined) {
				children.failure = child.failure;
				return;
			}
		}
	}

	private async transactionWithManagedClient<T>(
		client: PoolClient,
		fn: (adapter: PgsqlAdapter<DB>) => Promise<T>,
		childObserver?: DbspChildTransactionObserver,
		successAction: SavepointTransactionSuccessAction = 'release',
		options?: ResolvedPgsqlTransactionOptions,
	): Promise<T> {
		return this.transactionWithManagedClientSavepointScope(
			client,
			fn,
			childObserver,
			successAction,
			options,
		);
	}

	private async transactionWithManagedClientSavepointScope<T>(
		client: PoolClient,
		fn: (adapter: PgsqlAdapter<DB>) => Promise<T>,
		childObserver?: DbspChildTransactionObserver,
		successAction: SavepointTransactionSuccessAction = 'release',
		options?: ResolvedPgsqlTransactionOptions,
	): Promise<T> {
		const savepointName = nextSavepointName();
		const scopeToken = createScopeToken();
		const scopeState = createScopeState(this.scopeState?.statementLock);
		const txAdapter = this.createManagedClientAdapter(
			client,
			scopeToken,
			scopeState,
			successAction === 'rollback' || this.rollbackOnlyScope,
		);
		let releaseScope: (failure?: DbspScopeFailure) => void;
		try {
			releaseScope = this.enterSavepointScope(
				client,
				scopeToken,
				scopeState,
				'transaction',
				childObserver,
			);
		} catch (error) {
			childObserver?.release({ error });
			throw error;
		}
		let scopeFailure: DbspScopeFailure | undefined;
		let savepointRolledBackBeforeClose = false;
		try {
			await this.executeConnectionStatement(
				client,
				`SAVEPOINT ${savepointName}`,
				undefined,
				{
					allowedScopeToken: scopeToken,
					inspectTransactionControl: false,
				},
			);
		} catch (error) {
			if (isPgErrorWithCode(error, NO_ACTIVE_SQL_TRANSACTION)) {
				releaseScope();
				return this.transactionWithClientTransaction(
					client,
					fn,
					childObserver,
					successAction === 'rollback' ? 'rollback' : 'commit',
					options,
				);
			}
			releaseScope({ error });
			throw error;
		}
		scopeState.streamFailureRecovery = async () => {
			const rolledBack = await this.rollbackSavepoint(
				client,
				savepointName,
				scopeToken,
				scopeState,
			);
			savepointRolledBackBeforeClose ||= rolledBack;
		};

		try {
			let result: T;
			let timeoutSnapshot: PgsqlTransactionTimeoutSnapshot = [];
			try {
				assertTopLevelOnlyTransactionOptionsAreAbsent(options);
				timeoutSnapshot = await this.captureAndApplySavepointTimeouts(
					client,
					scopeToken,
					scopeState,
					options,
				);
				result = await fn(txAdapter);
				this.closeScopeAndAssertChildren(scopeState);
				await this.drainScopeWork(scopeState);
				this.throwIfScopePoisoned(scopeState);
			} catch (error) {
				let transactionError = transactionTimeoutErrorOrOriginal(
					error,
					options,
				);
				try {
					this.closeScopeAndAssertChildren(scopeState);
				} catch (scopeError) {
					transactionError = transactionTimeoutErrorOrOriginal(
						scopeError,
						options,
					);
				}
				let cleanupErr: unknown;
				try {
					let rolledBack = savepointRolledBackBeforeClose;
					if (!rolledBack) {
						rolledBack = await this.rollbackSavepoint(
							client,
							savepointName,
							scopeToken,
							scopeState,
						);
					}
					await this.drainScopeChildren(scopeState);
					if (rolledBack && successAction === 'release') {
						await this.releaseSavepoint(
							client,
							savepointName,
							scopeToken,
							scopeState,
						);
					}
				} catch (error) {
					cleanupErr = error;
				}
				if (cleanupErr !== undefined) {
					await this.drainScopeChildren(scopeState);
					if (
						isRawSqlTransactionControlError(transactionError) &&
						isSavepointUnavailableError(cleanupErr)
					) {
						scopeFailure = { error: transactionError };
						throw transactionError;
					}
					const cleanupFailure = createCleanupFailureError(
						'PostgreSQL transaction cleanup failed: savepoint cleanup failed after the transaction body failed; the caller transaction may now be in an unknown state',
						transactionError,
						cleanupErr,
					);
					scopeFailure = { error: cleanupFailure };
					throw cleanupFailure;
				}
				await this.drainScopeChildren(scopeState);
				transactionError = this.scopePoisonOutranksError(
					scopeState,
					transactionError,
				);
				transactionError = transactionTimeoutErrorOrOriginal(
					transactionError,
					options,
				);
				scopeFailure = { error: transactionError };
				throw transactionError;
			}
			try {
				if (successAction === 'rollback') {
					try {
						await this.rollbackSavepoint(
							client,
							savepointName,
							scopeToken,
							scopeState,
							{ ignoreNoActiveTransaction: false },
						);
					} catch (rollbackErr) {
						const cleanupFailure = createCleanupOnlyError(
							'PostgreSQL scratch scope cleanup failed: ROLLBACK TO SAVEPOINT failed after the scratch body returned',
							rollbackErr,
						);
						scopeFailure = { error: cleanupFailure };
						throw cleanupFailure;
					}
					return result;
				}
				if (successAction === 'keep') return result;
				try {
					await this.restoreSavepointTimeouts(
						client,
						scopeToken,
						scopeState,
						timeoutSnapshot,
					);
				} catch (restoreErr) {
					const cleanupFailure =
						await this.rollbackSavepointAfterReleaseFailure(
							client,
							savepointName,
							scopeToken,
							scopeState,
							restoreErr,
							'PostgreSQL transaction cleanup failed: timeout restore failed before RELEASE SAVEPOINT after the transaction body returned',
						);
					scopeFailure = { error: cleanupFailure };
					throw cleanupFailure;
				}
				await this.executeScopeBoundaryStatement(
					client,
					scopeToken,
					scopeState,
					`RELEASE SAVEPOINT ${savepointName}`,
					{
						allowAncestorScopeToken: true,
					},
				);
			} catch (releaseErr) {
				const cleanupFailure = await this.rollbackSavepointAfterReleaseFailure(
					client,
					savepointName,
					scopeToken,
					scopeState,
					releaseErr,
					'PostgreSQL transaction cleanup failed: RELEASE SAVEPOINT failed after the transaction body returned',
				);
				scopeFailure = { error: cleanupFailure };
				throw cleanupFailure;
			}
			return result;
		} finally {
			releaseScope(scopeFailure);
		}
	}

	private async applyTransactionTimeouts(
		client: PoolClient,
		scopeToken: DbspScopeToken,
		scopeState: DbspScopeState,
		options: ResolvedPgsqlTransactionBeginOptions | undefined,
	): Promise<void> {
		for (const statement of options?.timeoutStatements ?? []) {
			await this.executeScopeBoundaryStatement(
				client,
				scopeToken,
				scopeState,
				statement.sql,
			);
		}
	}

	private async captureAndApplySavepointTimeouts(
		client: PoolClient,
		scopeToken: DbspScopeToken,
		scopeState: DbspScopeState,
		options: ResolvedPgsqlTransactionBeginOptions | undefined,
	): Promise<PgsqlTransactionTimeoutSnapshot> {
		const statements = options?.timeoutStatements ?? [];
		if (statements.length === 0) return [];

		const snapshot: {
			readonly parameter: PgsqlTransactionTimeoutParameter;
			readonly value: string;
		}[] = [];
		for (const statement of statements) {
			const result = await this.executeScopeBoundaryStatement(
				client,
				scopeToken,
				scopeState,
				`SHOW ${statement.parameter}`,
			);
			const value = result.rows[0]?.[statement.parameter];
			if (typeof value !== 'string') {
				throw new Error(
					`SHOW ${statement.parameter} did not return a string value`,
				);
			}
			snapshot.push({ parameter: statement.parameter, value });
		}

		await this.applyTransactionTimeouts(
			client,
			scopeToken,
			scopeState,
			options,
		);
		return snapshot;
	}

	private async restoreSavepointTimeouts(
		client: PoolClient,
		scopeToken: DbspScopeToken,
		scopeState: DbspScopeState,
		snapshot: PgsqlTransactionTimeoutSnapshot,
	): Promise<void> {
		for (const setting of snapshot) {
			await this.executeScopeBoundaryStatement(
				client,
				scopeToken,
				scopeState,
				setLocalTransactionTimeoutSql(setting.parameter, setting.value),
			);
		}
	}

	private async transactionWithClientTransaction<T>(
		client: PoolClient,
		fn: (adapter: PgsqlAdapter<DB>) => Promise<T>,
		childObserver?: DbspChildTransactionObserver,
		successAction: ClientTransactionSuccessAction = 'commit',
		options?: ResolvedPgsqlTransactionOptions,
		onCommitStart?: () => void,
	): Promise<T> {
		let begun = false;
		let committed = false;
		let releaseScope: ((failure?: DbspScopeFailure) => void) | undefined;
		let scopeToken: DbspScopeToken | undefined;
		let scopeState: DbspScopeState | undefined;
		let scopeFailure: DbspScopeFailure | undefined;
		let transactionRolledBackBeforeClose = false;
		try {
			scopeToken = createScopeToken();
			scopeState = createScopeState(this.scopeState?.statementLock);
			releaseScope = this.enterTransactionScope(
				client,
				scopeToken,
				scopeState,
				childObserver,
			);
			await this.executeScopeBoundaryStatement(
				client,
				scopeToken,
				scopeState,
				transactionBeginSql(options),
			);
			begun = true;
			await this.applyTransactionTimeouts(
				client,
				scopeToken,
				scopeState,
				options,
			);
			scopeState.streamFailureRecovery = async () => {
				await this.rollbackTransactionIfOpen(client, scopeToken, scopeState);
				transactionRolledBackBeforeClose = true;
			};
			const txAdapter = this.createManagedClientAdapter(
				client,
				scopeToken,
				scopeState,
				successAction === 'rollback',
			);
			const result = await fn(txAdapter);
			this.closeScopeAndAssertChildren(scopeState);
			await this.drainScopeWork(scopeState);
			this.throwIfScopePoisoned(scopeState);
			if (successAction === 'rollback') {
				transactionRolledBackBeforeClose = true;
				try {
					await this.rollbackTransactionIfOpen(
						client,
						scopeToken,
						scopeState,
						false,
					);
				} catch (rollbackErr) {
					const cleanupFailure = createCleanupOnlyError(
						'PostgreSQL scratch scope cleanup failed: ROLLBACK failed after the scratch body returned',
						rollbackErr,
					);
					scopeFailure = { error: cleanupFailure };
					throw cleanupFailure;
				}
				return result;
			}
			onCommitStart?.();
			const commitResult = await this.executeScopeBoundaryStatement(
				client,
				scopeToken,
				scopeState,
				'COMMIT',
			);
			committed = true;
			this.assertCommitSucceeded(commitResult);
			return result;
		} catch (error) {
			let transactionError = transactionTimeoutErrorOrOriginal(error, options);
			try {
				this.closeScopeAndAssertChildren(scopeState);
			} catch (scopeError) {
				transactionError = transactionTimeoutErrorOrOriginal(
					scopeError,
					options,
				);
			}
			if (begun && !committed && !transactionRolledBackBeforeClose) {
				try {
					await this.rollbackTransactionIfOpen(client, scopeToken, scopeState);
				} catch (rollbackErr) {
					const cleanupFailure = createCleanupFailureError(
						'PostgreSQL transaction cleanup failed: ROLLBACK failed after the transaction body failed',
						transactionError,
						rollbackErr,
					);
					scopeFailure = { error: cleanupFailure };
					await this.drainScopeChildren(scopeState);
					throw cleanupFailure;
				}
			}
			await this.drainScopeChildren(scopeState);
			transactionError = this.scopePoisonOutranksError(
				scopeState,
				transactionError,
			);
			transactionError = transactionTimeoutErrorOrOriginal(
				transactionError,
				options,
			);
			scopeFailure = { error: transactionError };
			throw transactionError;
		} finally {
			if (releaseScope === undefined) {
				if (scopeFailure !== undefined) {
					childObserver?.release(scopeFailure);
				}
			} else {
				releaseScope(scopeFailure);
			}
		}
	}

	private releaseClient(client: PoolClient, error?: Error | boolean): void {
		if (
			error === undefined &&
			!hasPreparedStatementQuarantine(client) &&
			!rawClientExposures.has(client)
		) {
			client.release();
			return;
		}
		// A quarantined or externally aliased physical client must not return to
		// the pool as healthy.
		client.release(
			error ?? new Error('dbsp released an externally exposed pool client'),
		);
	}

	private async rollbackAndReleaseSavepoint(
		client: PoolClient,
		savepointName: string,
		allowedScopeToken: DbspScopeToken,
		scopeState: DbspScopeState,
		options?: { readonly ignoreNoActiveTransaction?: boolean },
	): Promise<void> {
		const rolledBack = await this.rollbackSavepoint(
			client,
			savepointName,
			allowedScopeToken,
			scopeState,
			options,
		);
		if (!rolledBack) return;
		await this.releaseSavepoint(
			client,
			savepointName,
			allowedScopeToken,
			scopeState,
		);
	}

	private async rollbackSavepoint(
		client: PoolClient,
		savepointName: string,
		allowedScopeToken: DbspScopeToken,
		scopeState: DbspScopeState,
		options?: { readonly ignoreNoActiveTransaction?: boolean },
	): Promise<boolean> {
		try {
			await this.executeScopeBoundaryStatement(
				client,
				allowedScopeToken,
				scopeState,
				`ROLLBACK TO SAVEPOINT ${savepointName}`,
				{
					allowAncestorScopeToken: true,
					allowPoisonedScope: true,
				},
			);
		} catch (error) {
			if (
				(options?.ignoreNoActiveTransaction ?? true) &&
				isPgErrorWithCode(error, NO_ACTIVE_SQL_TRANSACTION)
			) {
				return false;
			}
			throw error;
		}
		return true;
	}

	private async releaseSavepoint(
		client: PoolClient,
		savepointName: string,
		allowedScopeToken: DbspScopeToken,
		scopeState: DbspScopeState,
	): Promise<void> {
		await this.executeScopeBoundaryStatement(
			client,
			allowedScopeToken,
			scopeState,
			`RELEASE SAVEPOINT ${savepointName}`,
			{
				allowAncestorScopeToken: true,
				allowPoisonedScope: true,
			},
		);
	}

	private async rollbackTransactionIfOpen(
		client: PoolClient,
		allowedScopeToken: DbspScopeToken | undefined,
		scopeState: DbspScopeState | undefined,
		ignoreNoActiveTransaction = true,
	): Promise<void> {
		if (allowedScopeToken === undefined || scopeState === undefined) {
			throw new Error(
				'Cannot roll back a dbsp-managed PostgreSQL transaction without a registered dbsp scope.',
			);
		}
		try {
			await this.executeScopeBoundaryStatement(
				client,
				allowedScopeToken,
				scopeState,
				'ROLLBACK',
				{
					allowAncestorScopeToken: true,
					allowPoisonedScope: true,
				},
			);
		} catch (error) {
			if (
				ignoreNoActiveTransaction &&
				isPgErrorWithCode(error, NO_ACTIVE_SQL_TRANSACTION)
			) {
				return;
			}
			throw error;
		}
	}

	private classifyTransactionStateError(
		error: unknown,
	):
		| 'no-active-transaction'
		| 'transaction-aborted'
		| 'savepoint-gone'
		| undefined {
		if (isPgErrorWithCode(error, NO_ACTIVE_SQL_TRANSACTION)) {
			return 'no-active-transaction';
		}
		if (isPgErrorWithCode(error, IN_FAILED_SQL_TRANSACTION)) {
			return 'transaction-aborted';
		}
		if (isPgErrorWithCode(error, INVALID_SAVEPOINT_SPECIFICATION)) {
			return 'savepoint-gone';
		}
		return undefined;
	}

	private async probeTransactionState(
		client: PoolClient,
		allowedScopeToken: DbspScopeToken | undefined,
	): Promise<
		'live' | 'no-active-transaction' | 'transaction-aborted' | 'unknown'
	> {
		const probeSavepointName = nextSavepointName();
		try {
			await this.executeConnectionStatement(
				client,
				`SAVEPOINT ${probeSavepointName}`,
				undefined,
				{
					...(allowedScopeToken !== undefined && { allowedScopeToken }),
					allowClosingScope: true,
					allowPoisonedScope: true,
					inspectTransactionControl: false,
					protectBorrowedClientTransaction: false,
				},
			);
		} catch (error) {
			const state = this.classifyTransactionStateError(error);
			if (state === 'no-active-transaction' || state === 'savepoint-gone') {
				return 'no-active-transaction';
			}
			if (state === 'transaction-aborted') return 'transaction-aborted';
			return 'unknown';
		}

		try {
			await this.executeConnectionStatement(
				client,
				`RELEASE SAVEPOINT ${probeSavepointName}`,
				undefined,
				{
					...(allowedScopeToken !== undefined && { allowedScopeToken }),
					allowClosingScope: true,
					allowPoisonedScope: true,
					inspectTransactionControl: false,
					protectBorrowedClientTransaction: false,
				},
			);
		} catch {
			return 'unknown';
		}
		return 'live';
	}

	private async classifySavepointReleaseFailure(
		client: PoolClient,
		allowedScopeToken: DbspScopeToken | undefined,
		releaseErr: unknown,
		cleanupAction: string,
	): Promise<Error> {
		const directState = this.classifyTransactionStateError(releaseErr);
		if (
			directState === 'no-active-transaction' ||
			directState === 'savepoint-gone'
		) {
			return this.poisonClientScopeStack(
				client,
				createCleanupOnlyError(cleanupAction, releaseErr),
				'cleanup',
			);
		}
		if (directState === 'transaction-aborted') {
			return this.poisonClientScope(
				client,
				allowedScopeToken,
				new PgsqlTransactionAbortedError(releaseErr),
				'cleanup',
			);
		}

		const probedState = await this.probeTransactionState(
			client,
			allowedScopeToken,
		);
		if (probedState === 'no-active-transaction') {
			return this.poisonClientScopeStack(
				client,
				createCleanupOnlyError(cleanupAction, releaseErr),
				'cleanup',
			);
		}
		if (probedState === 'transaction-aborted') {
			return this.poisonClientScope(
				client,
				allowedScopeToken,
				new PgsqlTransactionAbortedError(releaseErr),
				'cleanup',
			);
		}
		return createCleanupOnlyError(cleanupAction, releaseErr);
	}

	private async rollbackSavepointAfterReleaseFailure(
		client: PoolClient,
		savepointName: string,
		allowedScopeToken: DbspScopeToken,
		scopeState: DbspScopeState,
		releaseErr: unknown,
		cleanupAction: string,
	): Promise<Error> {
		try {
			await this.executeScopeBoundaryStatement(
				client,
				allowedScopeToken,
				scopeState,
				`ROLLBACK TO SAVEPOINT ${savepointName}`,
				{
					allowAncestorScopeToken: true,
					allowPoisonedScope: true,
				},
			);
		} catch (rollbackErr) {
			const classifiedRollbackFailure =
				await this.classifySavepointReleaseFailure(
					client,
					allowedScopeToken,
					rollbackErr,
					cleanupAction,
				);
			if (
				isRawSqlTransactionControlError(classifiedRollbackFailure) ||
				classifiedRollbackFailure instanceof PgsqlTransactionAbortedError
			) {
				return classifiedRollbackFailure;
			}
			return createCleanupFailureError(
				`${cleanupAction}; ROLLBACK TO SAVEPOINT also failed and the caller transaction may now be in an unknown state`,
				releaseErr,
				rollbackErr,
			);
		}

		try {
			await this.releaseSavepoint(
				client,
				savepointName,
				allowedScopeToken,
				scopeState,
			);
		} catch (releaseAfterRollbackErr) {
			return createCleanupFailureError(
				`${cleanupAction}; RELEASE SAVEPOINT also failed after ROLLBACK TO SAVEPOINT and the caller transaction may now be in an unknown state`,
				releaseErr,
				releaseAfterRollbackErr,
			);
		}

		return createCleanupOnlyError(cleanupAction, releaseErr);
	}

	private enterTransactionScope(
		client: PoolClient,
		scopeToken: DbspScopeToken,
		scopeState: DbspScopeState,
		childObserver?: DbspChildTransactionObserver,
	): (failure?: DbspScopeFailure) => void {
		const current = this.currentClientScope(client);
		if (current === undefined && this.scopeToken !== undefined) {
			throw new Error(TRANSACTION_SCOPE_ENDED_MESSAGE);
		}
		if (current !== undefined) {
			const ownScope =
				this.scopeToken === undefined
					? undefined
					: this.findClientScope(client, this.scopeToken);
			if (ownScope?.state.closing) {
				throw new Error(TRANSACTION_SCOPE_ENDED_MESSAGE);
			}
			if (current.state.closing) {
				throw new Error(TRANSACTION_SCOPE_ENDED_MESSAGE);
			}
			this.assertScopeNotPoisoned(current);
			if (current.token !== this.scopeToken) {
				throw new Error(SAVEPOINT_SCOPE_OWNER_MESSAGE);
			}
			if (current.kind === 'pinned-connection') {
				return this.pushClientScope(
					client,
					{
						kind: 'transaction',
						token: scopeToken,
						state: scopeState,
					},
					childObserver,
				);
			}
			throw new Error(SAVEPOINT_SCOPE_BUSY_MESSAGE);
		}
		return this.pushClientScope(
			client,
			{
				kind: 'transaction',
				token: scopeToken,
				state: scopeState,
			},
			childObserver,
		);
	}

	private enterPinnedConnectionScope(
		client: PoolClient,
		scopeToken: DbspScopeToken,
		scopeState: DbspScopeState,
		childObserver?: DbspChildTransactionObserver,
	): (failure?: DbspScopeFailure) => void {
		const current = this.currentClientScope(client);
		if (current !== undefined) {
			if (current.state.closing) {
				throw new Error(TRANSACTION_SCOPE_ENDED_MESSAGE);
			}
			this.assertScopeNotPoisoned(current);
			throw new Error(SAVEPOINT_SCOPE_BUSY_MESSAGE);
		}
		return this.pushClientScope(
			client,
			{
				kind: 'pinned-connection',
				token: scopeToken,
				state: scopeState,
			},
			childObserver,
		);
	}

	private enterSavepointScope(
		client: PoolClient,
		scopeToken: DbspScopeToken,
		scopeState: DbspScopeState,
		purpose: 'statement' | 'transaction',
		childObserver?: DbspChildTransactionObserver,
	): (failure?: DbspScopeFailure) => void {
		const current = this.currentClientScope(client);
		if (current === undefined && this.scopeToken !== undefined) {
			throw new Error(TRANSACTION_SCOPE_ENDED_MESSAGE);
		}
		if (current !== undefined) {
			const ownScope =
				this.scopeToken === undefined
					? undefined
					: this.findClientScope(client, this.scopeToken);
			if (ownScope?.state.closing) {
				throw new Error(TRANSACTION_SCOPE_ENDED_MESSAGE);
			}
			if (current.state.closing) {
				throw new Error(TRANSACTION_SCOPE_ENDED_MESSAGE);
			}
			this.assertScopeNotPoisoned(current);
			if (current.state.statementLock.tail !== undefined) {
				throw new Error(SAVEPOINT_SCOPE_BUSY_MESSAGE);
			}
			if (current.kind === 'statement-savepoint') {
				throw new Error(SAVEPOINT_SCOPE_BUSY_MESSAGE);
			}
			if (current.token !== this.scopeToken) {
				throw new Error(SAVEPOINT_SCOPE_OWNER_MESSAGE);
			}
			if (purpose !== 'transaction') {
				throw new Error(SAVEPOINT_SCOPE_BUSY_MESSAGE);
			}
		}
		return this.pushClientScope(
			client,
			{
				kind:
					purpose === 'transaction'
						? 'transaction-savepoint'
						: 'statement-savepoint',
				token: scopeToken,
				state: scopeState,
			},
			childObserver,
		);
	}

	private pushClientScope(
		client: PoolClient,
		scope: DbspClientScope,
		childObserver?: DbspChildTransactionObserver,
	): (failure?: DbspScopeFailure) => void {
		const stack = activeClientScopes.get(client);
		if (stack === undefined) {
			activeClientScopes.set(client, [scope]);
		} else {
			stack.push(scope);
		}
		let released = false;
		return (failure?: DbspScopeFailure) => {
			if (released) return;
			released = true;
			try {
				const currentStack = activeClientScopes.get(client);
				if (currentStack === undefined) return;
				const index = currentStack.indexOf(scope);
				if (index === -1) return;
				currentStack.splice(index, 1);
				if (currentStack.length === 0) {
					activeClientScopes.delete(client);
				}
			} finally {
				childObserver?.release(failure);
			}
		};
	}

	private currentClientScope(client: PoolClient): DbspClientScope | undefined {
		return activeClientScopes.get(client)?.at(-1);
	}

	private managedScopeEndedMessage(): string {
		return this.adapterManagedPinnedConnection
			? PINNED_CONNECTION_SCOPE_ENDED_MESSAGE
			: TRANSACTION_SCOPE_ENDED_MESSAGE;
	}

	private assertCanUseClient(
		client: PoolClient,
		allowedScopeToken = this.scopeToken,
		allowAncestorScopeToken = false,
		allowClosingScope = false,
		allowPoisonedScope = false,
	): void {
		const stack = activeClientScopes.get(client);
		const current = stack?.at(-1);
		if (allowedScopeToken === undefined) {
			if (current === undefined) return;
			throw new Error(SAVEPOINT_SCOPE_OWNER_MESSAGE);
		}
		if (current?.token === allowedScopeToken) {
			this.assertUsableScopeAncestors(
				stack!,
				stack!.length - 1,
				allowClosingScope,
				allowPoisonedScope,
			);
			if (current.state.closing && !allowClosingScope) {
				throw new Error(this.managedScopeEndedMessage());
			}
			if (!allowPoisonedScope) {
				this.assertScopeNotPoisoned(current);
			}
			return;
		}
		const allowedScope = this.findClientScope(client, allowedScopeToken);
		if (allowedScope?.state.closing && !allowClosingScope) {
			throw new Error(this.managedScopeEndedMessage());
		}
		if (allowAncestorScopeToken && allowedScope !== undefined) {
			this.assertUsableScopeAncestors(
				stack!,
				stack!.indexOf(allowedScope),
				allowClosingScope,
				allowPoisonedScope,
			);
			if (!allowPoisonedScope) {
				this.assertScopeNotPoisoned(allowedScope);
			}
			return;
		}
		if (allowedScope === undefined) {
			throw new Error(this.managedScopeEndedMessage());
		}
		throw new Error(SAVEPOINT_SCOPE_OWNER_MESSAGE);
	}

	private assertUsableScopeAncestors(
		stack: DbspClientScope[],
		scopeIndex: number,
		allowClosingScope: boolean,
		allowPoisonedScope: boolean,
	): void {
		for (let index = 0; index < scopeIndex; index++) {
			const ancestor = stack[index];
			if (ancestor === undefined) continue;
			if (ancestor.state.closing && !allowClosingScope) {
				throw new Error(this.managedScopeEndedMessage());
			}
			if (!allowPoisonedScope) {
				this.assertScopeNotPoisoned(ancestor);
			}
		}
	}

	private findClientScope(
		client: PoolClient,
		scopeToken: DbspScopeToken | undefined,
	): DbspClientScope | undefined {
		const stack = activeClientScopes.get(client);
		if (stack === undefined) return undefined;
		if (scopeToken === undefined) return stack.at(-1);
		for (let index = stack.length - 1; index >= 0; index--) {
			const scope = stack[index];
			if (scope?.token === scopeToken) return scope;
		}
		return undefined;
	}

	private assertScopeNotPoisoned(scope: DbspClientScope): void {
		this.throwIfScopePoisoned(scope.state);
	}

	private throwIfScopePoisoned(scopeState: DbspScopeState): void {
		const poison = scopeState.poisoned;
		if (poison !== undefined) {
			throw poison.error;
		}
	}

	private scopePoisonOutranksError(
		scopeState: DbspScopeState | undefined,
		error: unknown,
	): unknown {
		const poison = scopeState?.poisoned;
		if (poison === undefined || poison.error === error) return error;
		if (poison.origin === 'cleanup') {
			if (error instanceof Error && !Object.hasOwn(error, 'cause')) {
				Object.defineProperty(error, 'cause', {
					value: poison.error,
					configurable: true,
				});
			}
			return error;
		}
		if (!isRawSqlTransactionControlError(poison.error)) {
			return error;
		}
		Object.defineProperty(poison.error, 'cause', {
			value: error,
			configurable: true,
		});
		return poison.error;
	}

	private poisonScopeState(
		scopeState: DbspScopeState,
		error: Error,
		origin: DbspScopePoisonOrigin = 'caller',
	): Error {
		const poison = scopeState.poisoned;
		if (
			poison === undefined ||
			(poison.origin === 'cleanup' && origin === 'caller')
		) {
			scopeState.poisoned = { error, origin };
			return error;
		}
		return poison.error;
	}

	private poisonClientScope(
		client: PoolClient,
		scopeToken: DbspScopeToken | undefined,
		error: Error,
		origin?: DbspScopePoisonOrigin,
	): Error {
		const scope = this.findClientScope(client, scopeToken);
		if (scope === undefined) return error;
		return this.poisonScopeState(scope.state, error, origin);
	}

	private poisonClientScopeStack(
		client: PoolClient,
		error: Error,
		origin?: DbspScopePoisonOrigin,
	): Error {
		const stack = activeClientScopes.get(client);
		if (stack === undefined || stack.length === 0) return error;
		let poisonedError: Error | undefined;
		for (const scope of stack) {
			const scopeError = this.poisonScopeState(scope.state, error, origin);
			poisonedError ??= scopeError;
		}
		return poisonedError ?? error;
	}

	private async runWithScopeStatementLock<T>(
		scopeState: DbspScopeState,
		fn: () => Promise<T>,
	): Promise<T> {
		const lock = scopeState.statementLock;
		const previous = lock.tail ?? Promise.resolve();
		let release!: () => void;
		const next = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = previous.catch(() => undefined).then(() => next);
		lock.tail = tail;

		await previous.catch(() => undefined);
		try {
			return await fn();
		} finally {
			release();
			if (lock.tail === tail) {
				lock.tail = undefined;
			}
		}
	}

	private closeScope(scopeState: DbspScopeState | undefined): void {
		if (scopeState !== undefined) {
			scopeState.closing = true;
		}
	}

	private closeScopeAndAssertChildren(
		scopeState: DbspScopeState | undefined,
	): void {
		this.closeScope(scopeState);
		if (scopeState !== undefined) {
			this.assertScopeChildrenSettled(scopeState);
		}
	}

	private async drainScopeStatements(
		scopeState: DbspScopeState,
	): Promise<void> {
		await scopeState.statementLock.tail?.catch(() => undefined);
	}

	private async drainScopeChildren(
		scopeState: DbspScopeState | undefined,
	): Promise<void> {
		if (scopeState === undefined) return;
		while (scopeState.children.open > 0) {
			const pending = [...scopeState.children.transactions].filter(
				(child) => !child.settled,
			);
			if (pending.length === 0) return;
			await Promise.all(pending.map((child) => child.settledPromise));
		}
	}

	private assertScopeChildrenSettled(scopeState: DbspScopeState): void {
		const failure = scopeState.children.failure;
		if (failure !== undefined) {
			throw failure.error;
		}
		if (scopeState.children.open > 0) {
			throw new Error(NESTED_TRANSACTION_NOT_AWAITED_MESSAGE);
		}
		for (const child of scopeState.children.transactions) {
			if (!child.observed) {
				throw new Error(NESTED_TRANSACTION_NOT_AWAITED_MESSAGE);
			}
		}
	}

	private async drainScopeWork(scopeState: DbspScopeState): Promise<void> {
		await this.drainScopeStatements(scopeState);
	}

	private async executeScopeBoundaryStatement<
		T extends QueryResultRow = QueryResultRow,
	>(
		client: PoolClient,
		scopeToken: DbspScopeToken,
		scopeState: DbspScopeState,
		sql: string,
		options: StatementExecutionOptions = {},
	): Promise<QueryResult<T>> {
		const boundaryOptions: StatementExecutionOptions = {
			...options,
			allowedScopeToken: scopeToken,
			allowClosingScope: true,
			inspectTransactionControl: false,
			protectBorrowedClientTransaction: false,
		};
		return this.runWithScopeStatementLock(scopeState, () =>
			this.executeConnectionStatementUnlocked<T>(
				client,
				sql,
				undefined,
				boundaryOptions,
				scopeToken,
			),
		);
	}

	private assertCommitSucceeded(result: QueryResult): void {
		if (result.command === 'ROLLBACK') {
			throw new PgsqlTransactionAbortedCommitError(result);
		}
	}

	/**
	 * Create a schema-scoped adapter for multi-tenant queries.
	 */
	withSchema(schemaName: string): Adapter<DB> {
		// Validate schema name
		validateIdentifier(schemaName, 'schema');

		// Create new adapter preserving all configuration, only overriding schemaName
		const options = this.cloneOptions({ schemaName });
		return createPgsqlAdapterFromConstructionOptions<DB>(
			this.client ?? this.pool ?? undefined,
			options,
		);
	}

	// =========================================================================
	// RawSqlAdapter Methods
	// =========================================================================

	/**
	 * Execute raw SQL directly.
	 *
	 * ⚠️  WARNING: Use parameter placeholders ($1, $2, etc.) for all values.
	 *
	 * Transaction control through raw SQL inside a scope dbsp is managing is
	 * unsupported. `COMMIT`, `ROLLBACK`, and `PREPARE TRANSACTION` end the
	 * transaction dbsp is working inside; dbsp detects that and fails loudly, but
	 * the data is already whatever your statement made it. Raw savepoint control
	 * (`SAVEPOINT`, `RELEASE SAVEPOINT`, `ROLLBACK TO SAVEPOINT`) can alter the
	 * savepoint stack before dbsp sees the command tag; dbsp poisons the scope, but
	 * it cannot make that command un-run. Manage your transaction outside dbsp's
	 * calls.
	 */
	async executeRaw<T = unknown>(
		sql: string,
		parameters: readonly unknown[] = [],
	): Promise<T[]> {
		this.requireConnection('executeRaw');
		const result =
			await this.executeQueryProtectingOpenTransaction<QueryResultRow>(
				sql,
				parameters,
				{ rawSqlStatement: true },
			);
		return result.rows as T[];
	}

	// =========================================================================
	// DDLGeneratingAdapter Methods
	// =========================================================================

	/**
	 * Generate DDL statements from a ModelIR schema.
	 *
	 * Uses PostgreSQL AST nodes and pgsql-deparser for consistent SQL generation.
	 * Applies the naming plugin for identifier transformation.
	 *
	 * @param schema - The ModelIR schema to generate DDL from
	 * @param overrideOptions - Optional overrides for DDL generation (e.g., includeDropStatements)
	 * @returns Array of DDL statements in dependency order
	 */
	generateDDL(
		schema: ModelIR,
		overrideOptions?: Partial<GenerateDDLOptions>,
	): string[] {
		const options: GenerateDDLOptions = {
			...(this.schemaName ? { schemaName: this.schemaName } : {}),
			naming: this.naming,
			...overrideOptions,
			dialectCapabilities:
				overrideOptions?.dialectCapabilities ?? this.dialectCapabilities,
		};
		return generateDDLStatements(schema, options);
	}

	/**
	 * Execute a DDL statement directly (e.g. TRUNCATE, VACUUM, ALTER TABLE, CREATE INDEX).
	 *
	 * @throws Error if called on a compile-only adapter (no pool)
	 * @since DDL-TABLE-001
	 */
	async executeDDL(sql: string): Promise<void> {
		this.requireConnection('executeDDL');
		await this.executeQueryProtectingOpenTransaction(sql);
	}

	/**
	 * Whether a transaction is open on this adapter's connection.
	 * This is true for dbsp-managed scopes and for borrowed pg clients whose
	 * ReadyForQuery status says the caller has an open transaction.
	 *
	 * @since DDL-TABLE-001
	 */
	get inTransaction(): boolean {
		if (this.adapterManagedTransaction) return this.adapterManagedScopeIsLive();
		if (this.adapterManagedPinnedConnection) return false;
		if (this.client === undefined) return false;
		return poolClientTransactionOpen(this.client) !== false;
	}

	private adapterManagedScopeIsLive(): boolean {
		if (
			(!this.adapterManagedTransaction &&
				!this.adapterManagedPinnedConnection) ||
			this.client === undefined ||
			this.scopeToken === undefined ||
			this.scopeState === undefined
		) {
			return false;
		}
		return (
			this.findClientScope(this.client, this.scopeToken)?.state ===
			this.scopeState
		);
	}

	private shouldProtectBorrowedClientTransaction(): boolean {
		return (
			this.client !== undefined &&
			!this.adapterManagedTransaction &&
			!this.adapterManagedPinnedConnection
		);
	}

	/**
	 * An idle ReadyForQuery status says nothing about commands another owner has
	 * already queued on a PoolClient. Only a dbsp-created pinned scope both owns
	 * the checked-out physical client and holds its statement lock across the
	 * failed named execution and any unnamed replay.
	 */
	private ownsSerializedClientForPreparedStatementReplay(
		executor: Pool | PoolClient,
	): boolean {
		return (
			isPoolClientLike(executor) &&
			this.adapterManagedPinnedConnection &&
			this.adapterManagedScopeIsLive() &&
			!rawClientExposures.has(executor)
		);
	}

	private async executeQueryProtectingOpenTransaction<
		T extends QueryResultRow = QueryResultRow,
	>(
		sql: string,
		parameters?: readonly unknown[],
		options: StatementExecutionOptions = {},
	): Promise<QueryResult<T>> {
		return this.executeConnectionStatement<T>(
			this.requireConnection('query execution'),
			sql,
			parameters,
			{
				...options,
				protectBorrowedClientTransaction:
					this.shouldProtectBorrowedClientTransaction(),
			},
		);
	}

	private async executeConnectionStatement<
		T extends QueryResultRow = QueryResultRow,
	>(
		executor: Pool | PoolClient,
		sql: string,
		parameters?: readonly unknown[],
		options: StatementExecutionOptions = {},
	): Promise<QueryResult<T>> {
		const shouldProtect = options.protectBorrowedClientTransaction ?? false;
		if (shouldProtect && isPoolClientLike(executor)) {
			return this.executeConnectionStatementInSavepoint<T>(
				executor,
				sql,
				parameters,
				options,
			);
		}

		const allowedScopeToken = options.allowedScopeToken ?? this.scopeToken;
		if (isPoolClientLike(executor)) {
			this.assertCanUseClient(
				executor,
				allowedScopeToken,
				options.allowAncestorScopeToken ?? false,
				options.allowClosingScope ?? false,
				options.allowPoisonedScope ?? false,
			);
		}

		const managedScope =
			isPoolClientLike(executor) &&
			options.inspectTransactionControl !== false &&
			options.allowPoisonedScope !== true
				? this.findClientScope(executor, allowedScopeToken)
				: undefined;
		if (managedScope !== undefined) {
			return this.runWithScopeStatementLock(managedScope.state, () =>
				this.executeConnectionStatementUnlocked<T>(
					executor,
					sql,
					parameters,
					{ ...options, allowClosingScope: true },
					allowedScopeToken,
				),
			);
		}

		return this.executeConnectionStatementUnlocked<T>(
			executor,
			sql,
			parameters,
			options,
			allowedScopeToken,
		);
	}

	private async executeConnectionStatementUnlocked<
		T extends QueryResultRow = QueryResultRow,
	>(
		executor: Pool | PoolClient,
		sql: string,
		parameters: readonly unknown[] | undefined,
		options: StatementExecutionOptions,
		allowedScopeToken: DbspScopeToken | undefined,
	): Promise<QueryResult<T>> {
		if (isPoolClientLike(executor)) {
			this.assertCanUseClient(
				executor,
				allowedScopeToken,
				options.allowAncestorScopeToken ?? false,
				options.allowClosingScope ?? false,
				options.allowPoisonedScope ?? false,
			);
		}

		let pendingError: unknown;
		let result: QueryResult<T> | undefined;
		try {
			const rawResult = await this.issueConnectionQuery<T>(
				executor,
				sql,
				parameters,
				options.prepareEligible ?? false,
				this.ownsSerializedClientForPreparedStatementReplay(executor),
			);
			if (options.inspectTransactionControl !== false) {
				await this.assertNoTransactionControlCommand(
					executor,
					rawResult,
					allowedScopeToken,
				);
				this.assertNoMultiCommandRawCall(
					executor,
					rawResult,
					allowedScopeToken,
				);
			}
			result = lastQueryResult(rawResult);
		} catch (error) {
			pendingError = error;
			if (
				isPoolClientLike(executor) &&
				options.inspectTransactionControl !== false &&
				options.allowPoisonedScope !== true
			) {
				this.poisonClientScope(
					executor,
					allowedScopeToken,
					new PgsqlTransactionAbortedError(error),
				);
			}
		}

		if (pendingError !== undefined) {
			throw pendingError;
		}
		if (result === undefined) {
			throw new Error('PostgreSQL returned no query results');
		}
		return result;
	}

	private async executeConnectionStatementInSavepoint<
		T extends QueryResultRow = QueryResultRow,
	>(
		client: PoolClient,
		sql: string,
		parameters?: readonly unknown[],
		options: StatementExecutionOptions = {},
	): Promise<QueryResult<T>> {
		const rawSqlStatement = options.rawSqlStatement ?? false;
		const savepointName = nextSavepointName();
		const scopeToken = this.scopeToken ?? createScopeToken();
		const scopeState = this.scopeState ?? createScopeState();
		const releaseScope = this.enterSavepointScope(
			client,
			scopeToken,
			scopeState,
			'statement',
		);
		try {
			await this.executeConnectionStatement(
				client,
				`SAVEPOINT ${savepointName}`,
				undefined,
				{
					allowedScopeToken: scopeToken,
					inspectTransactionControl: false,
					protectBorrowedClientTransaction: false,
				},
			);
		} catch (error) {
			releaseScope();
			if (isPgErrorWithCode(error, NO_ACTIVE_SQL_TRANSACTION)) {
				return this.executeConnectionStatement<T>(client, sql, parameters, {
					...options,
					inspectTransactionControl: options.inspectTransactionControl ?? true,
					protectBorrowedClientTransaction: false,
				});
			}
			throw error;
		}

		let result: QueryResult<T>;
		try {
			result = await this.executeConnectionStatement<T>(
				client,
				sql,
				parameters,
				{
					...options,
					allowedScopeToken: scopeToken,
					inspectTransactionControl: options.inspectTransactionControl ?? true,
					protectBorrowedClientTransaction: false,
				},
			);
		} catch (error) {
			this.closeScope(scopeState);
			try {
				await this.rollbackAndReleaseSavepoint(
					client,
					savepointName,
					scopeToken,
					scopeState,
				);
			} catch (cleanupErr) {
				if (
					isRawSqlTransactionControlError(error) &&
					isSavepointUnavailableError(cleanupErr)
				) {
					throw error;
				}
				throw createCleanupFailureError(
					protectedStatementCleanupAction(
						rawSqlStatement,
						'savepoint cleanup failed after the protected statement failed; the caller transaction may now be in an unknown state',
					),
					error,
					cleanupErr,
				);
			} finally {
				releaseScope();
			}
			if (isRawSqlTransactionControlError(error)) {
				throw error;
			}
			if (rawSqlStatement) {
				throw addRawSqlTransactionContext(error);
			}
			throw error;
		}
		try {
			this.closeScopeAndAssertChildren(scopeState);
			await this.drainScopeWork(scopeState);
			this.throwIfScopePoisoned(scopeState);
			await this.executeScopeBoundaryStatement(
				client,
				scopeToken,
				scopeState,
				`RELEASE SAVEPOINT ${savepointName}`,
				{
					protectBorrowedClientTransaction: false,
				},
			);
		} catch (releaseErr) {
			throw await this.rollbackSavepointAfterReleaseFailure(
				client,
				savepointName,
				scopeToken,
				scopeState,
				releaseErr,
				protectedStatementCleanupAction(
					rawSqlStatement,
					'RELEASE SAVEPOINT failed after the protected statement succeeded',
				),
			);
		} finally {
			releaseScope();
		}
		return result;
	}

	private async issueConnectionQuery<T extends QueryResultRow>(
		executor: Pool | PoolClient,
		sql: string,
		parameters: readonly unknown[] | undefined,
		prepareEligible: boolean,
		ownsSerializedClientForPreparedStatementReplay = false,
	): Promise<MaybeMultipleQueryResults<T>> {
		if (
			this.preparedStatementRegistry !== undefined &&
			prepareEligible &&
			parameters !== undefined &&
			parameters.length > 0
		) {
			if (
				isPoolClientLike(executor) &&
				isPreparedStatementQuarantined(executor, sql)
			) {
				return executor.query<T>(sql, [...parameters]) as Promise<
					MaybeMultipleQueryResults<T>
				>;
			}
			const admission = this.preparedStatementRegistry.admit(sql);
			if (admission === undefined) {
				return executor.query<T>(sql, [...parameters]) as Promise<
					MaybeMultipleQueryResults<T>
				>;
			}
			let parameterSnapshot: ReplayableParameterSnapshot | undefined;
			let namedAttemptParameters: unknown[];
			try {
				// Only a dbsp-owned serialized client can reach the replay branch. Other
				// modes retain the established shallow copy for their named submission.
				parameterSnapshot = ownsSerializedClientForPreparedStatementReplay
					? captureReplayableParameterSnapshot(parameters)
					: undefined;
				namedAttemptParameters =
					parameterSnapshot === undefined
						? [...parameters]
						: cloneReplayableParameterValues(parameterSnapshot);
			} catch (error) {
				if (admission.reservation !== undefined) {
					try {
						this.preparedStatementRegistry.abort(admission.reservation);
					} catch {
						// A local construction failure remains the observable failure.
					}
				}
				throw error;
			}
			try {
				const result = (await executor.query<T>({
					name: admission.name,
					text: sql,
					values: namedAttemptParameters,
				})) as MaybeMultipleQueryResults<T>;
				if (admission.reservation !== undefined)
					this.preparedStatementRegistry.confirm(admission.reservation);
				return result;
			} catch (error) {
				if (admission.reservation !== undefined) {
					try {
						if (
							shouldAbortPreparedStatementReservation(
								error,
								executor,
								admission.name,
							)
						) {
							this.preparedStatementRegistry.abort(admission.reservation);
						} else
							this.preparedStatementRegistry.confirm(admission.reservation);
					} catch {
						// Classifier failure cannot replace the query error or retain a
						// reservation whose outcome we could not establish.
						try {
							this.preparedStatementRegistry.abort(admission.reservation);
						} catch {
							// The original query error remains the observable failure.
						}
					}
				}
				let retryUnnamed = false;
				try {
					if (isPoolClientLike(executor)) {
						const localNameCollision =
							isDriverLocalPreparedStatementNameCollision(
								error,
								admission.name,
							);
						if (
							localNameCollision ||
							shouldQuarantinePreparedStatementInfrastructureError(
								error,
								admission.name,
							)
						) {
							// A verified 26000 is treated as possible client-wide loss because
							// SQLSTATE cannot distinguish a full reset from targeted deallocation;
							// the other verified failures remain text-scoped.
							quarantinePreparedStatement(
								executor,
								sql,
								!localNameCollision &&
									isVerifiedClientWidePreparedStatementLoss(error),
							);
						}
						// A matching 26000/42P05 reports this named statement itself. 0A000
						// has no statement identity, so its replay requires the caller's
						// explicit effect-safety assertion. An aborted or open transaction
						// cannot safely absorb a replay, and an unknown status is treated
						// conservatively as open. The status check is only safe while dbsp
						// owns and serializes this physical client's command queue.
						retryUnnamed =
							canReplayPreparedStatementInfrastructureError(
								error,
								admission.name,
								this.replayInvalidatedPlans,
							) &&
							parameterSnapshot !== undefined &&
							poolClientTransactionOpen(executor) === false &&
							// Entry-time ownership authorizes only the snapshot. Re-read
							// it immediately before queueing an unnamed replay because
							// getPoolInstance() can expose this client mid-flight.
							this.ownsSerializedClientForPreparedStatementReplay(executor);
					}
				} catch {
					// Quarantine classification cannot replace the query error.
				}
				if (retryUnnamed) {
					try {
						return (await executor.query<T>(
							sql,
							cloneReplayableParameterValues(parameterSnapshot!),
						)) as MaybeMultipleQueryResults<T>;
					} catch (replayError) {
						throw new PgsqlPreparedStatementReplayError(
							admission.reservation?.fingerprint ??
								derivePreparedStatementFingerprint(sql),
							error,
							replayError,
						);
					}
				}
				throw error;
			}
		}
		if (parameters === undefined) {
			return executor.query<T>(sql) as Promise<MaybeMultipleQueryResults<T>>;
		}
		return executor.query<T>(sql, [...parameters]) as Promise<
			MaybeMultipleQueryResults<T>
		>;
	}

	private assertNoMultiCommandRawCall<T extends QueryResultRow>(
		executor: Pool | PoolClient,
		result: MaybeMultipleQueryResults<T>,
		allowedScopeToken: DbspScopeToken | undefined,
	): void {
		if (!Array.isArray(result) || !isPoolClientLike(executor)) return;
		const current = this.currentClientScope(executor);
		if (current === undefined || current.token !== allowedScopeToken) return;
		throw this.poisonClientScope(
			executor,
			allowedScopeToken,
			new Error(RAW_SQL_MULTI_COMMAND_MESSAGE, {
				cause: queryResultsMetadata(result),
			}),
		);
	}

	private async assertNoTransactionControlCommand<T extends QueryResultRow>(
		executor: Pool | PoolClient,
		result: MaybeMultipleQueryResults<T>,
		allowedScopeToken: DbspScopeToken | undefined,
	): Promise<void> {
		if (!isPoolClientLike(executor)) return;
		const current = this.currentClientScope(executor);
		if (current === undefined || current.token !== allowedScopeToken) return;
		const controlCause = Array.isArray(result)
			? queryResultsMetadata(result)
			: undefined;
		for (const queryResult of queryResults(result)) {
			if (isPrepareCommandTag(queryResult.command)) {
				await this.assertPrepareDidNotEndTransaction(
					executor,
					allowedScopeToken,
					queryResult,
					controlCause,
				);
				continue;
			}
			if (isTransactionControlCommandTag(queryResult.command)) {
				throw this.poisonClientScopeStack(
					executor,
					new PgsqlRawSqlTransactionControlError(controlCause ?? queryResult),
				);
			}
		}
	}

	private async assertPrepareDidNotEndTransaction<T extends QueryResultRow>(
		client: PoolClient,
		allowedScopeToken: DbspScopeToken | undefined,
		queryResult: QueryResult<T>,
		cause: unknown = queryResult,
	): Promise<void> {
		const probeSavepointName = nextSavepointName();
		try {
			await this.executeConnectionStatement(
				client,
				`SAVEPOINT ${probeSavepointName}`,
				undefined,
				{
					...(allowedScopeToken !== undefined && { allowedScopeToken }),
					inspectTransactionControl: false,
					protectBorrowedClientTransaction: false,
				},
			);
		} catch (error) {
			if (isPgErrorWithCode(error, NO_ACTIVE_SQL_TRANSACTION)) {
				throw this.poisonClientScopeStack(
					client,
					new PgsqlRawSqlTransactionControlError(cause),
				);
			}
			throw error;
		}
		await this.executeConnectionStatement(
			client,
			`RELEASE SAVEPOINT ${probeSavepointName}`,
			undefined,
			{
				...(allowedScopeToken !== undefined && { allowedScopeToken }),
				inspectTransactionControl: false,
				protectBorrowedClientTransaction: false,
			},
		);
	}

	/**
	 * Resolve the explicit schema for a catalog read: an explicit argument, else
	 * the adapter's configured schema, else `undefined` (resolve in-query). NOT a
	 * hard-coded 'public' — an unresolved schema is handled by the SQL, which
	 * finds the table's schema search_path-aware, in the SAME session, so a
	 * non-public search_path and a pooled connection both stay correct.
	 */
	private explicitSchema(schema?: string): string | undefined {
		return schema ?? this.schemaName;
	}

	/**
	 * List all indexes on a table by querying pg_indexes.
	 *
	 * @param table - Table name
	 * @param schema - Schema name (defaults to the search_path-resolved schema)
	 */
	async listIndexes(
		table: string,
		schema?: string,
		options?: { namePattern?: string },
	): Promise<IndexInfo[]> {
		this.requireConnection('listIndexes');
		const params: unknown[] = [table, this.explicitSchema(schema) ?? null];
		let sql =
			'SELECT indexname, indexdef FROM pg_indexes ' +
			`WHERE tablename = $1 AND schemaname = COALESCE($2, ${RESOLVE_TABLE_SCHEMA_SQL('$1')})`;
		if (options?.namePattern) {
			sql += ' AND indexname LIKE $3';
			params.push(options.namePattern);
		}
		sql += ' ORDER BY indexname';
		const result = await this.executeQueryProtectingOpenTransaction<{
			indexname: string;
			indexdef: string;
		}>(sql, params);
		return result.rows.map((row) => {
			const def = row.indexdef;
			const unique = /\bCREATE UNIQUE INDEX\b/i.test(def);
			const methodMatch = /\bUSING\s+(\w+)/i.exec(def);
			const method = methodMatch?.[1] ?? 'btree';
			return { name: row.indexname, definition: def, unique, method };
		});
	}

	/**
	 * Check whether an index with the given name exists on a table.
	 *
	 * @param name - Index name
	 * @param table - Table name
	 * @param schema - Schema name (defaults to the search_path-resolved schema)
	 */
	async indexExists(
		name: string,
		table: string,
		schema?: string,
	): Promise<boolean> {
		this.requireConnection('indexExists');
		const result = await this.executeQueryProtectingOpenTransaction<{
			exists: boolean;
		}>(
			'SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = $1 AND tablename = $2 ' +
				`AND schemaname = COALESCE($3, ${RESOLVE_TABLE_SCHEMA_SQL('$2')})) AS exists`,
			[name, table, this.explicitSchema(schema) ?? null],
		);
		return result.rows[0]?.exists ?? false;
	}

	/**
	 * Return the total storage size of a table in bytes (includes indexes and TOAST).
	 *
	 * The table name is a SQL identifier — it is double-quoted, not parameterized,
	 * because PostgreSQL does not allow parameterized table names in FROM clauses.
	 * With no known schema the table is left unqualified so ::regclass resolves it
	 * through search_path (the same table an unqualified reference would hit).
	 *
	 * @param table - Table name
	 * @param schema - Schema name (defaults to the search_path-resolved schema)
	 */
	async storageSize(table: string, schema?: string): Promise<number> {
		this.requireConnection('storageSize');
		const schemaName = this.explicitSchema(schema);
		// Double any embedded double-quotes to prevent injection.
		const quotedTable = `"${table.replace(/"/g, '""')}"`;
		const identifier =
			schemaName !== undefined
				? `"${schemaName.replace(/"/g, '""')}".${quotedTable}`
				: quotedTable;
		const result = await this.executeQueryProtectingOpenTransaction<{
			size: string;
		}>(`SELECT pg_total_relation_size($1::regclass)::bigint AS size`, [
			identifier,
		]);
		return Number(result.rows[0]?.size ?? 0);
	}

	/**
	 * Generate SQL for TRUNCATE TABLE.
	 * Implements TableDDLGeneratorAdapter.generateTruncate.
	 */
	generateTruncate(
		table: string,
		schemaName: string,
		options?: TruncateOptions,
	): string {
		return generateTruncateSQL(table, schemaName ?? this.schemaName, options);
	}

	/**
	 * Generate SQL for VACUUM.
	 * Implements TableDDLGeneratorAdapter.generateVacuum.
	 */
	generateVacuum(
		table: string,
		schemaName: string,
		options?: VacuumOptions,
	): string {
		return generateVacuumSQL(table, schemaName ?? this.schemaName, options);
	}

	/**
	 * Generate SQL for ALTER TABLE ... ALTER COLUMN.
	 * Implements TableDDLGeneratorAdapter.generateAlterColumn.
	 */
	generateAlterColumn(
		table: string,
		schemaName: string,
		column: string,
		options: AlterColumnOptions,
	): string {
		return generateAlterColumnSQL(
			table,
			schemaName ?? this.schemaName,
			column,
			options,
		);
	}

	/**
	 * Generate SQL for CREATE INDEX.
	 * Implements TableDDLGeneratorAdapter.generateCreateIndex.
	 */
	generateCreateIndex(
		table: string,
		schemaName: string,
		options: CreateIndexOptions,
	): string {
		return generateCreateIndexSQL(
			table,
			schemaName ?? this.schemaName,
			options,
			{
				caps: this.dialectCapabilities,
				targetVersion: getPostgresqlCapabilitiesTargetVersion(
					this.dialectCapabilities,
				),
			},
		);
	}

	/**
	 * Generate SQL for DROP INDEX.
	 * Implements TableDDLGeneratorAdapter.generateDropIndex.
	 */
	generateDropIndex(
		name: string,
		schemaName: string,
		options?: DropIndexOptions,
	): string {
		return generateDropIndexSQL(name, schemaName ?? this.schemaName, options);
	}

	// =========================================================================
	// Validation
	// =========================================================================

	/**
	 * Validate an identifier (table name, column name, schema name).
	 */
	validateIdentifier(value: string, type: string): void {
		// Cast to expected type union
		const identifierType = type as 'table' | 'column' | 'schema' | 'alias';
		validateIdentifier(value, identifierType);
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a PgsqlAdapter from a pg Pool instance.
 *
 * @param pool - pg Pool instance
 * @param options - Optional configuration
 * @returns A new PgsqlAdapter instance
 *
 * @example
 * ```typescript
 * import { Pool } from 'pg';
 * import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const adapter = createPgsqlAdapter(pool);
 *
 * // With naming convention
 * const adapter = createPgsqlAdapter(pool, { dbCasing: 'snake_case' });
 * ```
 */
export function createPgsqlAdapter<DB = unknown>(
	pool: Pool,
	options?: PgsqlPoolAdapterOptions,
): PgsqlAdapter<DB>;
export function createPgsqlAdapter<DB = unknown>(
	client: PoolClient,
	options: PgsqlBorrowedClientAdapterOptions,
): PgsqlAdapter<DB>;
export function createPgsqlAdapter<DB = unknown>(
	connection: Pool | PoolClient,
	options?: PgsqlPoolAdapterOptions | PgsqlBorrowedClientAdapterOptions,
): PgsqlAdapter<DB> {
	// Validate this descriptor-backed option before the ownership guard performs
	// any `in` checks on caller-owned options.
	readReplayInvalidatedPlansOption(options);
	if (isPoolClientLike(connection)) {
		if (!hasBorrowedClientOption(options)) {
			throw new Error(
				'createPgsqlAdapter() received a pg PoolClient. Pass borrowedClient: true ' +
					'to declare that the caller owns this connection.',
			);
		}
	} else if (hasBorrowedClientOption(options)) {
		throw new Error(
			'createPgsqlAdapter() received borrowedClient: true with a pg Pool. ' +
				'Pass a PoolClient when borrowing a caller-owned connection.',
		);
	}
	return createPgsqlAdapterFromConstructionOptions<DB>(
		connection,
		options ?? {},
	);
}

/**
 * Creates a connectionless PgsqlAdapter for SQL generation without a database connection.
 *
 * All compilation methods (compile, compileInsert, etc.), createDump(), and generateDDL()
 * work normally. The adapter has the full PgsqlAdapter surface; database operations refuse
 * at runtime until it is constructed with a connection via createPgsqlAdapter(pool).
 *
 * @example
 * ```typescript
 * import { createPgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';
 * import { createOrm } from '@dbsp/core';
 *
 * const adapter = createPgsqlCompileOnlyAdapter();
 * const orm = createOrm({ model, adapter });
 * const dump = await orm.select('users').dump();
 * console.log(dump.sql);
 * ```
 */
export function createPgsqlCompileOnlyAdapter<DB = unknown>(
	options?: PgsqlCompileOnlyAdapterOptions,
): PgsqlAdapter<DB> {
	return new PgsqlAdapter<DB>(undefined, options);
}
