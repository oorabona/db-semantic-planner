/**
 * PgsqlAdapter - Implements the Adapter interface for PostgreSQL using native pg driver.
 *
 * This adapter wraps a pg Pool instance and provides the unified
 * adapter interface for the db-semantic-planner ORM.
 *
 * @module pgsql-adapter
 */

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
	CompileOnlyAdapter,
	CompileOptions,
	CompileResultWithIncludes,
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
	PlanReport,
	QueryIntent,
	RecursivePlanReport,
	SetOperationIntent,
	SubqueryIncludeInfo,
	TableIR,
	UpdateIntent,
	UpsertFromIntent,
	UpsertIntent,
} from '@dbsp/types';
import { getNqlBindingRefName, isNqlBindingRef } from '@dbsp/types/internal';
import type {
	Pool,
	PoolClient,
	QueryConfig,
	QueryResult,
	QueryResultRow,
} from 'pg';
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
import { MAX_DEPTH_LIMIT } from './recursive/cte-compiler.js';
import {
	compileSetOperation as compileSetOperationImpl,
	type LeafCompileFn,
} from './set-operation.js';
import { generateCursorName } from './streaming/cursor.js';
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

const MAX_NQL_RUNTIME_BINDING_VALUES_PARAMETERS = 32_000;

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

let savepointCounter = 0;
let preparedStatementCounter = 0;

const RAW_SQL_TRANSACTION_CONTROL_MESSAGE =
	'Transaction control through raw SQL inside a scope dbsp is managing is unsupported. ' +
	'`COMMIT`, `ROLLBACK`, and `PREPARE TRANSACTION` end the transaction dbsp is working inside; dbsp detects that and fails loudly, but the data is already whatever your statement made it. ' +
	'Raw savepoint control (`SAVEPOINT`, `RELEASE SAVEPOINT`, `ROLLBACK TO SAVEPOINT`) can alter the savepoint stack before dbsp sees the command tag; dbsp poisons the scope, but it cannot make that command un-run. ' +
	"Manage your transaction outside dbsp's calls.";

const RAW_SQL_SINGLE_COMMAND_MESSAGE =
	'PostgreSQL rejected this raw SQL because dbsp sends one command per raw call inside a transaction it manages, and the caller passed several commands.';

const ABORTED_COMMIT_MESSAGE =
	'PostgreSQL returned ROLLBACK for COMMIT. The transaction was already aborted, no changes were committed, and dbsp is reporting that failed commit explicitly.';

const TRANSACTION_ABORTED_MESSAGE =
	'PostgreSQL transaction is aborted because a statement failed inside a dbsp-managed scope and that failure was caught. Roll back the surrounding transaction; the swallowed statement failure is the cause worth reporting.';

const SAVEPOINT_SCOPE_BUSY_MESSAGE =
	'Cannot start another dbsp savepoint scope on this PostgreSQL connection because one is already active. Savepoint scopes are single-flight per connection; await the active dbsp operation before starting another.';

const SAVEPOINT_SCOPE_OWNER_MESSAGE =
	'This PostgreSQL connection is currently inside a dbsp-managed scope owned by another transaction adapter. Use the transaction adapter passed to the callback instead of an ancestor adapter.';

const TRANSACTION_SCOPE_ENDED_MESSAGE =
	'This PostgreSQL transaction adapter belongs to a transaction that has ended.';

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

type DbspClientScopeKind =
	| 'transaction'
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
	childScopes: Set<Promise<void>>;
	closing: boolean;
};

type DbspScopePoison = {
	readonly error: Error;
};

type DbspScopeStatementLock = {
	tail: Promise<void> | undefined;
};

const activeClientScopes = new WeakMap<PoolClient, DbspClientScope[]>();
const preparedStatementObligations = new WeakMap<PoolClient, Set<string>>();

type StatementExecutionOptions = {
	readonly allowedScopeToken?: DbspScopeToken;
	readonly allowAncestorScopeToken?: boolean;
	readonly allowClosingScope?: boolean;
	readonly allowPoisonedScope?: boolean;
	readonly inspectTransactionControl?: boolean;
	readonly protectBorrowedClientTransaction?: boolean;
	readonly forceSingleCommand?: boolean;
};

type MaybeMultipleQueryResults<T extends QueryResultRow = QueryResultRow> =
	| QueryResult<T>
	| QueryResult<T>[];

type CleanupFailureError = AggregateError & {
	readonly cleanupError: unknown;
	readonly originalError?: unknown;
};

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

function isPoolClientLike(
	connection: Pool | PoolClient,
): connection is PoolClient {
	return 'release' in connection && typeof connection.release === 'function';
}

function isPgErrorWithCode(error: unknown, code: string): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		(error as { code?: unknown }).code === code
	);
}

function isPgErrorWithMessage(error: unknown, pattern: RegExp): boolean {
	return (
		error instanceof Error &&
		typeof (error as { code?: unknown }).code === 'string' &&
		pattern.test(error.message)
	);
}

function nextSavepointName(): string {
	savepointCounter = (savepointCounter + 1) % Number.MAX_SAFE_INTEGER;
	return `dbsp_savepoint_${savepointCounter}`;
}

function nextPreparedStatementName(): string {
	preparedStatementCounter =
		(preparedStatementCounter + 1) % Number.MAX_SAFE_INTEGER;
	return `dbsp_raw_${process.pid}_${preparedStatementCounter}`;
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
		childScopes: new Set(),
		closing: false,
	};
}

function rememberPreparedStatementObligation(
	client: PoolClient,
	statementName: string,
): void {
	let statements = preparedStatementObligations.get(client);
	if (statements === undefined) {
		statements = new Set();
		preparedStatementObligations.set(client, statements);
	}
	statements.add(statementName);
}

function forgetPreparedStatementObligation(
	client: PoolClient,
	statementName: string,
): void {
	const statements = preparedStatementObligations.get(client);
	if (statements === undefined) return;
	statements.delete(statementName);
	if (statements.size === 0) {
		preparedStatementObligations.delete(client);
	}
}

function pendingPreparedStatementObligations(
	client: PoolClient,
): readonly string[] {
	return [...(preparedStatementObligations.get(client) ?? [])];
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

function addRawSqlSingleCommandContext(error: unknown): unknown {
	if (
		isPgErrorWithMessage(
			error,
			/cannot insert multiple commands into a prepared statement/i,
		)
	) {
		const context = RAW_SQL_SINGLE_COMMAND_MESSAGE;
		if (error instanceof Error && !error.message.includes(context)) {
			error.message = `${error.message}; ${context}`;
			Object.defineProperty(error, 'dbspRawSqlSingleCommandContext', {
				value: context,
				configurable: true,
			});
		}
	}
	return error;
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
): TableIR | undefined {
	return (
		model.getTable(sourceTable) ??
		[...model.tables.values()].find((table) => table.name === sourceTable)
	);
}

function runtimeCastTargetSchema(
	schemaName: string | undefined,
	naming: NamingPlugin,
): string | undefined {
	return schemaName !== undefined ? naming.toDatabase(schemaName) : undefined;
}

function resolveRuntimeBindingColumnType(
	bindingName: string,
	sourceTable: TableIR,
	columnName: string,
	schemaName: string | undefined,
	naming: NamingPlugin,
): string {
	const column = sourceTable.columns.find(
		(candidate) => candidate.name === columnName,
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
	const sourceTable = findRuntimeBindingSourceTable(model, sourceTableName);
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
	const anchorColumns = binding.columns
		.map(
			(column, columnIndex) =>
				`CAST(NULL AS ${pgTypes[columnIndex]}) AS ${quoteIdent(naming.toDatabase(column), 'column')}`,
		)
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
				return `$${nextParam++}::${pgTypes[columnIndex]}`;
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
// ============================================================================
// Options
// ============================================================================

/**
 * Options for PgsqlAdapter.
 */
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
}

export interface PgsqlPoolAdapterOptions extends PgsqlAdapterOptions {
	readonly borrowedClient?: false;
}

export interface PgsqlBorrowedClientAdapterOptions extends PgsqlAdapterOptions {
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

interface PgsqlAdapterInternalOptions
	extends PgsqlBorrowedClientAdapterOptions {
	readonly [pgsqlAdapterInternalOptionsKey]: true;
	readonly adapterManagedTransaction?: true;
	readonly dbspScopeToken?: DbspScopeToken;
	readonly dbspScopeState?: DbspScopeState;
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
		readonly dbspScopeToken?: DbspScopeToken;
		readonly dbspScopeState?: DbspScopeState;
	};

function isPgsqlAdapterInternalOptions(
	options: PgsqlAdapterConstructionOptions | undefined,
): options is PgsqlAdapterInternalOptions {
	return (
		typeof options === 'object' &&
		options !== null &&
		pgsqlAdapterInternalOptionsKey in options &&
		options[pgsqlAdapterInternalOptionsKey] === true
	);
}

function hasBorrowedClientOption(
	options: PgsqlAdapterConstructionOptions | undefined,
): options is PgsqlBorrowedClientAdapterOptions | PgsqlAdapterInternalOptions {
	return (
		typeof options === 'object' &&
		options !== null &&
		'borrowedClient' in options &&
		options.borrowedClient === true
	);
}

function hasManagedTransactionsOption(
	options: PgsqlAdapterConstructionOptions | undefined,
): boolean {
	return (
		typeof options === 'object' &&
		options !== null &&
		'managedTransactions' in options &&
		options.managedTransactions === true
	);
}

function isAdapterManagedTransactionOption(
	options: PgsqlAdapterConstructionOptions | undefined,
): boolean {
	return (
		isPgsqlAdapterInternalOptions(options) &&
		options.adapterManagedTransaction === true
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

function createPgsqlAdapterFromConstructionOptions<DB = unknown>(
	connection: Pool | PoolClient | undefined,
	options: PgsqlAdapterConstructionOptions,
): PgsqlAdapter<DB> {
	return new PgsqlAdapter<DB>(
		connection as Pool | undefined,
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
	private readonly scopeToken: DbspScopeToken | undefined;
	private readonly scopeState: DbspScopeState | undefined;
	private readonly schemaName: string | undefined;
	private readonly _dbCasing: DbCasing;
	private readonly naming: NamingPlugin;
	private readonly model: ModelIR | undefined;
	private readonly logger: AdapterLogger | undefined;
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
	constructor(pool?: Pool | undefined, options?: PgsqlPoolAdapterOptions);
	constructor(pool: Pool, options?: PgsqlPoolAdapterOptions);
	constructor(client: PoolClient, options: PgsqlBorrowedClientAdapterOptions);
	constructor(pool: undefined, options?: PgsqlAdapterOptions);
	constructor(
		pool?: Pool | PoolClient | undefined,
		options?: PgsqlAdapterConstructionOptions,
	) {
		const declaredBorrowed = hasBorrowedClientOption(options);

		if (pool != null) {
			// The shape is only ever used to *reject* a mismatch. It never decides how
			// the connection is treated — the declaration does.
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
		this.managedTransactions = hasManagedTransactionsOption(options);
		this.adapterManagedTransaction = isAdapterManagedTransactionOption(options);
		this.scopeToken = getDbspScopeTokenOption(options);
		this.scopeState = getDbspScopeStateOption(options);

		this.schemaName = options?.schemaName;
		this._dbCasing = options?.dbCasing ?? 'preserve';
		this.naming = getNamingPluginForDbCasing(this._dbCasing);
		this.model = options?.model;
		this.logger = options?.logger;
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
		const scopeToken = overrides.dbspScopeToken ?? this.scopeToken;
		const scopeState = overrides.dbspScopeState ?? this.scopeState;
		const hasInternalOptions =
			adapterManagedTransaction === true ||
			scopeToken !== undefined ||
			scopeState !== undefined;
		return {
			...(hasInternalOptions && {
				[pgsqlAdapterInternalOptionsKey]: true as const,
			}),
			...(this.schemaName !== undefined && { schemaName: this.schemaName }),
			...(this._dbCasing !== undefined && { dbCasing: this._dbCasing }),
			...(this.model !== undefined && { model: this.model }),
			...(this.logger !== undefined && { logger: this.logger }),
			defaultPkColumnName: this.defaultPk,
			deriveFkColumnName: this.deriveFk,
			...(this.borrowedClient && { borrowedClient: true as const }),
			...(this.managedTransactions && { managedTransactions: true as const }),
			...(adapterManagedTransaction === true && { adapterManagedTransaction }),
			...(scopeToken !== undefined && { dbspScopeToken: scopeToken }),
			...(scopeState !== undefined && { dbspScopeState: scopeState }),
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

	private compileNqlBundleLeaf<T = unknown>(
		bundle: CompiledNqlQuery,
		options?: CompileOptions,
		bindingNames?: BindingNameRegistry,
	): CompiledQuery<T> {
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
			return guardCompiledQuery(
				compileSelect<T>(planReport, options, deps),
				'NQL query',
			);
		}
		if (bundle.cteQuery !== undefined) {
			return guardCompiledQuery(
				compileCteQueryImpl(
					bundle.cteQuery,
					options,
					this.buildCompileDeps(options, bindingNames),
				) as CompiledQuery<T>,
				'NQL CTE query',
			) as CompiledQuery<T>;
		}
		if (bundle.setOperation !== undefined) {
			const model = this.requireNqlCompileModel(options);
			return guardCompiledQuery(
				this.compileSetOperationWithBindings(
					bundle.setOperation,
					model,
					options,
					bindingNames,
				) as CompiledQuery<T>,
				'NQL set operation',
			) as CompiledQuery<T>;
		}
		if (bundle.mutation !== undefined) {
			return guardCompiledQuery(
				this.compileNqlMutation(
					bundle,
					options,
					bindingNames,
				) as CompiledQuery<T>,
				'NQL mutation',
			) as CompiledQuery<T>;
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
		const bindingNamesInOrder = orderedNqlBindingNames(bundle);
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

		for (const name of bindingNamesInOrder) {
			const runtimeBinding = bundle.runtimeBindings?.get(name);
			if (runtimeBinding !== undefined) {
				const compiledRuntimeBinding = compileNqlRuntimeBindingCte(
					name,
					runtimeBinding,
					naming,
					parameters.length,
					runtimeBindingSourceTable(bundle, name),
					deps.schemaName,
					deps.model,
					bundle.mutationBindings?.get(name)?.returningItems,
				);
				ctes.push(compiledRuntimeBinding.cte);
				parameters.push(...compiledRuntimeBinding.parameters);
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
			const compiled = this.compileNqlBundleLeaf(
				bindingBundle,
				options,
				bindingNames,
			);
			ctes.push(
				`${cteName} as (${renumberSqlParams(compiled.sql, parameters.length)})`,
			);
			parameters.push(...compiled.parameters);
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
		const compiled = this.compileNqlBundleLeaf<T>(
			leafBundle,
			options,
			bindingNames,
		);
		if (ctes.length === 0) {
			return guardCompiledQuery(compiled, 'NQL bundle');
		}

		return guardCompiledQuery(
			{
				sql: `WITH ${ctes.join(', ')} ${renumberSqlParams(compiled.sql, parameters.length)}`,
				parameters: [...parameters, ...compiled.parameters],
			},
			'NQL bundle',
		);
	}

	/**
	 * Returns the pool/client executor, or throws if in compile-only mode.
	 */
	private requireConnection(): Pool | PoolClient {
		const executor = this.client ?? this.pool;
		if (!executor) {
			throw new Error(
				'PgsqlAdapter is in compile-only mode (no database connection). ' +
					'Use createPgsqlAdapter(pool) for a full adapter with execution capabilities.',
			);
		}
		return executor;
	}

	/** Adapter capabilities for feature detection */
	get capabilities(): AdapterCapabilities {
		return this._capabilities;
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
	 */
	getPoolInstance(): Pool | PoolClient {
		return this.requireConnection();
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
	compileSelectExpression(expr: ExpressionIntent): CompiledQuery {
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
			{ sql, parameters: state.parameters },
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
	compileRecursive(
		report: RecursivePlanReport,
		model: ModelIR,
		options?: CompileOptions,
	): CompiledQuery {
		return guardCompiledQuery(
			compileRecursiveImpl(
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
	compileCteQuery(
		intent: CteQueryIntent,
		options?: CompileOptions,
	): CompiledQuery {
		return guardCompiledQuery(
			compileCteQueryImpl(intent, options, this.buildCompileDeps(options)),
			'CTE query',
		);
	}

	/**
	 * Compile a set operation (UNION / INTERSECT / EXCEPT) to SQL.
	 */
	compileSetOperation(
		intent: SetOperationIntent,
		model: ModelIR,
		options?: CompileOptions,
	): CompiledQuery {
		return guardCompiledQuery(
			this.compileSetOperationWithBindings(intent, model, options),
			'set operation',
		);
	}

	private compileSetOperationWithBindings(
		intent: SetOperationIntent,
		model: ModelIR,
		options?: CompileOptions,
		bindingNames?: BindingNameRegistry,
	): CompiledQuery {
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
			return compileSelect(planReport, leafOptions, deps);
		};
		const result = compileSetOperationImpl(intent, compileFn);
		return guardCompiledQuery(
			{
				sql: result.sql,
				parameters: result.parameters,
			},
			'set operation',
		);
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
		const result = await this.executeQueryProtectingOpenTransaction<
			Record<string, unknown>
		>(query.sql, query.parameters, { forceSingleCommand: true });
		return this.transformResultRows(result.rows) as T[];
	}

	/**
	 * Transform result rows from database naming to model naming convention.
	 * For CamelCaseNamingPlugin: price_cents → priceCents
	 */
	private transformResultRows(
		rows: Record<string, unknown>[],
	): Record<string, unknown>[] {
		return rows.map((row) => {
			const transformed: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(row)) {
				// Use toModel to convert database column name to model column name
				const modelKey = this.naming.toModel(key);
				transformed[modelKey] = value;
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
		const chunkSize = options?.chunkSize ?? 100;
		if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
			throw new Error(
				`Invalid stream chunkSize: ${chunkSize}. Must be a positive integer.`,
			);
		}
		const adapter = this;

		// Use a wrapper to create the async generator
		async function* streamGenerator(): AsyncIterableIterator<T> {
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
					query,
					chunkSize,
				);
				return;
			}

			// Otherwise, acquire a client and create a transaction
			const pool = adapter.requireConnection() as Pool;
			const client = await pool.connect();
			let begun = false;
			let committed = false;
			let streamFailed = false;
			let releaseScope: (() => void) | undefined;
			let scopeToken: DbspScopeToken | undefined;
			let scopeState: DbspScopeState | undefined;
			let releaseError: Error | boolean | undefined;
			let cleanupErrorToThrow: unknown;
			try {
				scopeToken = createScopeToken();
				scopeState = createScopeState();
				await adapter.executeConnectionStatement(client, 'BEGIN', undefined, {
					inspectTransactionControl: false,
				});
				begun = true;
				releaseScope = adapter.enterTransactionScope(
					client,
					scopeToken,
					scopeState,
				);
				yield* adapter.streamWithClient<T>(
					client,
					query,
					chunkSize,
					scopeToken,
				);
				adapter.closeScope(scopeState);
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
				adapter.closeScope(scopeState);
				streamFailed = true;
				if (begun && !committed) {
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
							error,
							rollbackErr,
						);
					}
					try {
						await adapter.dischargePreparedStatementObligations(client);
					} catch (deallocateErr) {
						releaseError =
							deallocateErr instanceof Error ? deallocateErr : true;
						throw createCleanupFailureError(
							'PostgreSQL stream cleanup failed: DEALLOCATE prepared statement failed after ROLLBACK made the connection usable',
							error,
							deallocateErr,
						);
					}
				}
				throw error;
			} finally {
				// On early break, yield* returns without reaching COMMIT.
				// ROLLBACK the open transaction to avoid leaking it to the pool.
				if (begun && !committed && !streamFailed) {
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
					if (cleanupErrorToThrow === undefined) {
						try {
							await adapter.dischargePreparedStatementObligations(client);
						} catch (deallocateErr) {
							releaseError =
								deallocateErr instanceof Error ? deallocateErr : true;
							cleanupErrorToThrow = createCleanupOnlyError(
								'PostgreSQL stream cleanup failed: DEALLOCATE prepared statement failed after ROLLBACK made the connection usable',
								deallocateErr,
							);
						}
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
		query: CompiledQuery<T>,
		chunkSize: number,
		allowedScopeToken?: DbspScopeToken,
	): AsyncIterableIterator<T> {
		// Generate unique cursor name
		const cursorName = generateCursorName();

		// Declare cursor
		await this.executeConnectionStatement(
			client,
			`DECLARE ${cursorName} NO SCROLL CURSOR FOR ${query.sql}`,
			query.parameters as unknown[],
			{
				...(allowedScopeToken !== undefined && { allowedScopeToken }),
				forceSingleCommand: true,
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

				for (const row of result.rows) {
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
					raise(
						createCleanupFailureError(
							'PostgreSQL stream cleanup failed: CLOSE cursor failed after the stream failed',
							streamError,
							cleanupErr,
						),
					);
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
		query: CompiledQuery<T>,
		chunkSize: number,
	): AsyncIterableIterator<T> {
		if (this.adapterManagedTransaction) {
			this.assertCanUseClient(client, this.scopeToken);
			yield* this.streamWithClient<T>(
				client,
				query,
				chunkSize,
				this.scopeToken,
			);
			return;
		}
		yield* this.streamWithManagedClientSavepointScope<T>(
			client,
			query,
			chunkSize,
		);
	}

	private async *streamWithManagedClientSavepointScope<T>(
		client: PoolClient,
		query: CompiledQuery<T>,
		chunkSize: number,
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
				yield* this.streamWithClientTransaction(client, query, chunkSize);
				return;
			}
			throw error;
		}

		let completed = false;
		let streamError: unknown;
		try {
			yield* this.streamWithClient<T>(client, query, chunkSize, scopeToken);
			completed = true;
		} catch (error) {
			streamError = error;
			throw error;
		} finally {
			try {
				this.closeScope(scopeState);
				if (completed) {
					await this.drainScopeWork(scopeState);
					this.throwIfScopePoisoned(scopeState);
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
							await this.classifySavepointReleaseFailure(
								client,
								scopeToken,
								releaseErr,
								'PostgreSQL stream cleanup failed: RELEASE SAVEPOINT failed after the stream completed',
							),
						);
					}
				} else {
					try {
						await this.rollbackAndReleaseSavepoint(
							client,
							savepointName,
							scopeToken,
							scopeState,
						);
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
		query: CompiledQuery<T>,
		chunkSize: number,
	): AsyncIterableIterator<T> {
		let begun = false;
		let committed = false;
		let streamFailed = false;
		let cleanupErrorToThrow: unknown;
		let releaseScope: (() => void) | undefined;
		let scopeToken: DbspScopeToken | undefined;
		let scopeState: DbspScopeState | undefined;
		try {
			scopeToken = createScopeToken();
			scopeState = createScopeState();
			await this.executeConnectionStatement(client, 'BEGIN', undefined, {
				inspectTransactionControl: false,
			});
			begun = true;
			releaseScope = this.enterTransactionScope(client, scopeToken, scopeState);
			yield* this.streamWithClient<T>(client, query, chunkSize, scopeToken);
			this.closeScope(scopeState);
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
			this.closeScope(scopeState);
			streamFailed = true;
			if (begun && !committed) {
				try {
					await this.rollbackTransactionIfOpen(client, scopeToken, scopeState);
				} catch (rollbackErr) {
					throw createCleanupFailureError(
						'PostgreSQL stream cleanup failed: ROLLBACK failed after the stream failed',
						error,
						rollbackErr,
					);
				}
				try {
					await this.dischargePreparedStatementObligations(client);
				} catch (deallocateErr) {
					throw createCleanupFailureError(
						'PostgreSQL stream cleanup failed: DEALLOCATE prepared statement failed after ROLLBACK made the connection usable',
						error,
						deallocateErr,
					);
				}
			}
			throw error;
		} finally {
			if (begun && !committed && !streamFailed) {
				this.closeScope(scopeState);
				try {
					await this.rollbackTransactionIfOpen(client, scopeToken, scopeState);
				} catch (rollbackErr) {
					cleanupErrorToThrow = createCleanupOnlyError(
						'PostgreSQL stream cleanup failed: ROLLBACK failed after the stream was closed early',
						rollbackErr,
					);
				}
				if (cleanupErrorToThrow === undefined) {
					try {
						await this.dischargePreparedStatementObligations(client);
					} catch (deallocateErr) {
						cleanupErrorToThrow = createCleanupOnlyError(
							'PostgreSQL stream cleanup failed: DEALLOCATE prepared statement failed after ROLLBACK made the connection usable',
							deallocateErr,
						);
					}
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
		const executor = this.client ?? this.pool;
		if (!executor) {
			throw new Error(
				'Cannot introspect without a database connection (compile-only adapter)',
			);
		}
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
							this.client !== undefined && !this.adapterManagedTransaction,
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
	 * Execute a callback within a database transaction.
	 */
	async transaction<T>(fn: (adapter: Adapter<DB>) => Promise<T>): Promise<T> {
		if (this.client) {
			if (!this.managedTransactions) {
				throw new Error(
					'transaction() was called on a PgsqlAdapter created with a borrowed PoolClient. ' +
						'This connection is yours, so the transaction is yours. Pass managedTransactions: true ' +
						'to let dbsp run transactions on it through a savepoint, and read the managedTransactions option documentation for the limits of that contract.',
				);
			}
			return this.transactionWithManagedClient(this.client, fn);
		}

		// Otherwise, acquire a client and start transaction
		const pool = this.requireConnection() as Pool;
		const client = await pool.connect();
		let releaseError: Error | boolean | undefined;
		try {
			return await this.transactionWithClientTransaction(client, fn);
		} catch (error) {
			releaseError = cleanupReleaseReason(error);
			throw error;
		} finally {
			this.releaseClient(client, releaseError);
		}
	}

	private createManagedClientAdapter(
		client: PoolClient,
		scopeToken: DbspScopeToken,
		scopeState: DbspScopeState,
	): PgsqlAdapter<DB> {
		return createPgsqlAdapterFromConstructionOptions<DB>(
			client,
			this.cloneOptions({
				borrowedClient: true,
				managedTransactions: true,
				adapterManagedTransaction: true,
				dbspScopeToken: scopeToken,
				dbspScopeState: scopeState,
			}),
		);
	}

	private async transactionWithManagedClient<T>(
		client: PoolClient,
		fn: (adapter: Adapter<DB>) => Promise<T>,
	): Promise<T> {
		return this.transactionWithManagedClientSavepointScope(client, fn);
	}

	private async transactionWithManagedClientSavepointScope<T>(
		client: PoolClient,
		fn: (adapter: Adapter<DB>) => Promise<T>,
	): Promise<T> {
		const savepointName = nextSavepointName();
		const scopeToken = createScopeToken();
		const scopeState = createScopeState(this.scopeState?.statementLock);
		const txAdapter = this.createManagedClientAdapter(
			client,
			scopeToken,
			scopeState,
		);
		const releaseScope = this.enterSavepointScope(
			client,
			scopeToken,
			scopeState,
			'transaction',
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
				return this.transactionWithClientTransaction(client, fn);
			}
			throw error;
		}

		try {
			const result = await fn(txAdapter);
			this.closeScope(scopeState);
			await this.drainScopeWork(scopeState);
			this.throwIfScopePoisoned(scopeState);
			await this.dischargePreparedStatementObligations(client);
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
				throw await this.classifySavepointReleaseFailure(
					client,
					scopeToken,
					releaseErr,
					'PostgreSQL transaction cleanup failed: RELEASE SAVEPOINT failed after the transaction body returned',
				);
			}
			return result;
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
					'PostgreSQL transaction cleanup failed: savepoint cleanup failed after the transaction body failed; the caller transaction may now be in an unknown state',
					error,
					cleanupErr,
				);
			}
			throw error;
		} finally {
			releaseScope();
		}
	}

	private async transactionWithClientTransaction<T>(
		client: PoolClient,
		fn: (adapter: Adapter<DB>) => Promise<T>,
	): Promise<T> {
		let begun = false;
		let committed = false;
		let releaseScope: (() => void) | undefined;
		let scopeToken: DbspScopeToken | undefined;
		let scopeState: DbspScopeState | undefined;
		try {
			scopeToken = createScopeToken();
			scopeState = createScopeState();
			await this.executeConnectionStatement(client, 'BEGIN', undefined, {
				inspectTransactionControl: false,
			});
			begun = true;
			const txAdapter = this.createManagedClientAdapter(
				client,
				scopeToken,
				scopeState,
			);
			releaseScope = this.enterTransactionScope(client, scopeToken, scopeState);
			const result = await fn(txAdapter);
			this.closeScope(scopeState);
			await this.drainScopeWork(scopeState);
			this.throwIfScopePoisoned(scopeState);
			await this.dischargePreparedStatementObligations(client);
			const commitResult = await this.executeScopeBoundaryStatement(
				client,
				scopeToken,
				scopeState,
				'COMMIT',
			);
			committed = true;
			await this.dischargePreparedStatementObligations(client);
			this.assertCommitSucceeded(commitResult);
			return result;
		} catch (error) {
			this.closeScope(scopeState);
			if (begun && !committed) {
				try {
					await this.rollbackTransactionIfOpen(client, scopeToken, scopeState);
				} catch (rollbackErr) {
					throw createCleanupFailureError(
						'PostgreSQL transaction cleanup failed: ROLLBACK failed after the transaction body failed',
						error,
						rollbackErr,
					);
				}
				try {
					await this.dischargePreparedStatementObligations(client);
				} catch (deallocateErr) {
					throw createCleanupFailureError(
						'PostgreSQL transaction cleanup failed: DEALLOCATE prepared statement failed after ROLLBACK made the connection usable',
						error,
						deallocateErr,
					);
				}
			}
			throw error;
		} finally {
			releaseScope?.();
		}
	}

	private releaseClient(client: PoolClient, error?: Error | boolean): void {
		if (error === undefined) {
			client.release();
			return;
		}
		client.release(error);
	}

	private async rollbackAndReleaseSavepoint(
		client: PoolClient,
		savepointName: string,
		allowedScopeToken: DbspScopeToken,
		scopeState: DbspScopeState,
	): Promise<void> {
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
			if (isPgErrorWithCode(error, NO_ACTIVE_SQL_TRANSACTION)) {
				await this.dischargePreparedStatementObligations(client);
				return;
			}
			if (isPgErrorWithCode(error, INVALID_SAVEPOINT_SPECIFICATION)) {
				await this.dischargePreparedStatementObligations(client);
			}
			throw error;
		}
		await this.dischargePreparedStatementObligations(client);
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
	): Promise<void> {
		try {
			if (allowedScopeToken !== undefined && scopeState !== undefined) {
				await this.executeScopeBoundaryStatement(
					client,
					allowedScopeToken,
					scopeState,
					'ROLLBACK',
					{
						allowPoisonedScope: true,
					},
				);
			} else {
				await this.executeConnectionStatement(client, 'ROLLBACK', undefined, {
					...(allowedScopeToken !== undefined && { allowedScopeToken }),
					allowClosingScope: true,
					allowPoisonedScope: true,
					inspectTransactionControl: false,
				});
			}
		} catch (error) {
			if (isPgErrorWithCode(error, NO_ACTIVE_SQL_TRANSACTION)) {
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
				new PgsqlRawSqlTransactionControlError(releaseErr),
			);
		}
		if (directState === 'transaction-aborted') {
			return this.poisonClientScope(
				client,
				allowedScopeToken,
				new PgsqlTransactionAbortedError(releaseErr),
			);
		}

		const probedState = await this.probeTransactionState(
			client,
			allowedScopeToken,
		);
		if (probedState === 'no-active-transaction') {
			return this.poisonClientScopeStack(
				client,
				new PgsqlRawSqlTransactionControlError(releaseErr),
			);
		}
		if (probedState === 'transaction-aborted') {
			return this.poisonClientScope(
				client,
				allowedScopeToken,
				new PgsqlTransactionAbortedError(releaseErr),
			);
		}
		return createCleanupOnlyError(cleanupAction, releaseErr);
	}

	private enterTransactionScope(
		client: PoolClient,
		scopeToken: DbspScopeToken,
		scopeState: DbspScopeState,
	): () => void {
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
			throw new Error(SAVEPOINT_SCOPE_BUSY_MESSAGE);
		}
		return this.pushClientScope(client, {
			kind: 'transaction',
			token: scopeToken,
			state: scopeState,
		});
	}

	private enterSavepointScope(
		client: PoolClient,
		scopeToken: DbspScopeToken,
		scopeState: DbspScopeState,
		purpose: 'statement' | 'transaction',
	): () => void {
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
		return this.pushClientScope(client, {
			kind:
				purpose === 'transaction'
					? 'transaction-savepoint'
					: 'statement-savepoint',
			token: scopeToken,
			state: scopeState,
		});
	}

	private pushClientScope(
		client: PoolClient,
		scope: DbspClientScope,
	): () => void {
		const stack = activeClientScopes.get(client);
		const parentScope = stack?.at(-1);
		let resolveClosed!: () => void;
		const closed = new Promise<void>((resolve) => {
			resolveClosed = resolve;
		});
		parentScope?.state.childScopes.add(closed);
		if (stack === undefined) {
			activeClientScopes.set(client, [scope]);
		} else {
			stack.push(scope);
		}
		let released = false;
		return () => {
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
				parentScope?.state.childScopes.delete(closed);
				resolveClosed();
			}
		};
	}

	private currentClientScope(client: PoolClient): DbspClientScope | undefined {
		return activeClientScopes.get(client)?.at(-1);
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
			if (current.state.closing && !allowClosingScope) {
				throw new Error(TRANSACTION_SCOPE_ENDED_MESSAGE);
			}
			if (!allowPoisonedScope) {
				this.assertScopeNotPoisoned(current);
			}
			return;
		}
		const allowedScope = this.findClientScope(client, allowedScopeToken);
		if (allowedScope?.state.closing && !allowClosingScope) {
			throw new Error(TRANSACTION_SCOPE_ENDED_MESSAGE);
		}
		if (allowAncestorScopeToken && allowedScope !== undefined) {
			if (!allowPoisonedScope) {
				this.assertScopeNotPoisoned(allowedScope);
			}
			return;
		}
		if (allowedScope === undefined) {
			throw new Error(TRANSACTION_SCOPE_ENDED_MESSAGE);
		}
		throw new Error(SAVEPOINT_SCOPE_OWNER_MESSAGE);
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

	private poisonScopeState(scopeState: DbspScopeState, error: Error): Error {
		if (scopeState.poisoned === undefined) {
			scopeState.poisoned = { error };
		}
		return scopeState.poisoned.error;
	}

	private poisonClientScope(
		client: PoolClient,
		scopeToken: DbspScopeToken | undefined,
		error: Error,
	): Error {
		const scope = this.findClientScope(client, scopeToken);
		if (scope === undefined) return error;
		return this.poisonScopeState(scope.state, error);
	}

	private poisonClientScopeStack(client: PoolClient, error: Error): Error {
		const stack = activeClientScopes.get(client);
		if (stack === undefined || stack.length === 0) return error;
		let poisonedError: Error | undefined;
		for (const scope of stack) {
			const scopeError = this.poisonScopeState(scope.state, error);
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

	private async drainScopeStatements(
		scopeState: DbspScopeState,
	): Promise<void> {
		await scopeState.statementLock.tail?.catch(() => undefined);
	}

	private async drainScopeChildren(scopeState: DbspScopeState): Promise<void> {
		while (scopeState.childScopes.size > 0) {
			await Promise.all([...scopeState.childScopes]);
		}
	}

	private async drainScopeWork(scopeState: DbspScopeState): Promise<void> {
		await this.drainScopeChildren(scopeState);
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
		await this.drainScopeChildren(scopeState);
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
		const result =
			await this.executeQueryProtectingOpenTransaction<QueryResultRow>(
				sql,
				parameters,
				{ forceSingleCommand: true },
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
		if (!this.client && !this.pool) {
			throw new Error('Cannot execute DDL on compile-only adapter');
		}
		await this.executeQueryProtectingOpenTransaction(sql, undefined, {
			forceSingleCommand: true,
		});
	}

	/**
	 * Whether this adapter instance is scoped inside a transaction.
	 * True only while the adapter is inside a transaction it manages.
	 *
	 * @since DDL-TABLE-001
	 */
	get inTransaction(): boolean {
		return this.adapterManagedTransaction;
	}

	private async executeQueryProtectingOpenTransaction<
		T extends QueryResultRow = QueryResultRow,
	>(
		sql: string,
		parameters?: readonly unknown[],
		options: Pick<StatementExecutionOptions, 'forceSingleCommand'> = {},
	): Promise<QueryResult<T>> {
		return this.executeConnectionStatement<T>(
			this.requireConnection(),
			sql,
			parameters,
			{
				...options,
				protectBorrowedClientTransaction:
					this.client !== undefined && !this.adapterManagedTransaction,
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

		const preparedStatementName = this.shouldUseSingleCommandPreparedStatement(
			executor,
			parameters,
			options,
			allowedScopeToken,
		)
			? nextPreparedStatementName()
			: undefined;

		let pendingError: unknown;
		let result: QueryResult<T> | undefined;
		let statementCompleted = false;
		if (preparedStatementName !== undefined && isPoolClientLike(executor)) {
			rememberPreparedStatementObligation(executor, preparedStatementName);
		}
		try {
			const rawResult = await this.issueConnectionQuery<T>(
				executor,
				sql,
				parameters,
				preparedStatementName,
			);
			statementCompleted = true;
			if (options.inspectTransactionControl !== false) {
				await this.assertNoTransactionControlCommand(
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

		if (
			preparedStatementName !== undefined &&
			isPoolClientLike(executor) &&
			(pendingError === undefined || statementCompleted)
		) {
			try {
				await this.dischargePreparedStatementObligation(
					executor,
					preparedStatementName,
				);
			} catch (cleanupErr) {
				if (pendingError === undefined) {
					throw createCleanupOnlyError(
						'PostgreSQL raw SQL cleanup failed: DEALLOCATE prepared statement failed after the protected statement completed',
						cleanupErr,
					);
				}
			}
		}

		if (pendingError !== undefined) {
			throw addRawSqlSingleCommandContext(pendingError);
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
					'PostgreSQL raw SQL cleanup failed: savepoint cleanup failed after the protected statement failed; the caller transaction may now be in an unknown state',
					error,
					cleanupErr,
				);
			} finally {
				releaseScope();
			}
			if (isRawSqlTransactionControlError(error)) {
				throw error;
			}
			throw addRawSqlTransactionContext(error);
		}
		try {
			this.closeScope(scopeState);
			await this.drainScopeWork(scopeState);
			this.throwIfScopePoisoned(scopeState);
			await this.dischargePreparedStatementObligations(client);
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
			throw await this.classifySavepointReleaseFailure(
				client,
				scopeToken,
				releaseErr,
				'PostgreSQL raw SQL cleanup failed: RELEASE SAVEPOINT failed after the protected statement succeeded',
			);
		} finally {
			releaseScope();
		}
		return result;
	}

	private shouldUseSingleCommandPreparedStatement(
		executor: Pool | PoolClient,
		parameters: readonly unknown[] | undefined,
		options: StatementExecutionOptions,
		allowedScopeToken: DbspScopeToken | undefined,
	): boolean {
		return (
			options.forceSingleCommand === true &&
			isPoolClientLike(executor) &&
			this.findClientScope(executor, allowedScopeToken) !== undefined &&
			(parameters === undefined || parameters.length === 0)
		);
	}

	/**
	 * A statement dbsp prepared is an obligation dbsp owes — but only if it was
	 * ever prepared. When PostgreSQL rejects the statement while parsing it (a
	 * multi-command string, an unknown function, a syntax error), nothing was
	 * created, and dbsp cannot tell that apart from a statement that parsed and
	 * then failed while running.
	 *
	 * Sending the `DEALLOCATE` anyway and tolerating the error does NOT work, and
	 * the trace says why: inside a transaction, *any* failing command aborts it.
	 * So a `DEALLOCATE` that finds nothing to deallocate re-aborts a transaction
	 * that the savepoint rollback had just made usable again, and the `RELEASE`
	 * behind it dies with 25P02. Swallowing the error in JavaScript does not
	 * un-abort anything on the server.
	 *
	 * So ask, rather than guess: the catalog knows whether the statement exists.
	 * This runs only on cleanup paths, and only once the connection can accept a
	 * statement at all.
	 */
	private async deallocatePreparedStatement(
		client: PoolClient,
		statementName: string,
		mayNotExist = false,
	): Promise<void> {
		// After the statement ran, dbsp knows it exists — it just used it. The
		// question only arises where the answer is genuinely unknown: the statement
		// failed, and dbsp cannot tell a parse failure (nothing was created) from a
		// runtime one (it was).
		if (mayNotExist) {
			const existing = await client.query(
				'SELECT 1 FROM pg_prepared_statements WHERE name = $1',
				[statementName],
			);
			if (existing.rowCount === 0) return;
		}
		await client.query(`DEALLOCATE ${quoteIdent(statementName)}`);
	}

	private async dischargePreparedStatementObligation(
		client: PoolClient,
		statementName: string,
	): Promise<void> {
		await this.deallocatePreparedStatement(client, statementName);
		forgetPreparedStatementObligation(client, statementName);
	}

	/**
	 * The cleanup path, reached because something already failed — so dbsp cannot
	 * tell whether the statement was ever created. It asks the catalog first: a
	 * `DEALLOCATE` that finds nothing would itself fail, and a failing command
	 * inside a transaction aborts it again, right after the savepoint rollback had
	 * made it usable.
	 */
	private async dischargePreparedStatementObligations(
		client: PoolClient,
	): Promise<void> {
		for (const statementName of pendingPreparedStatementObligations(client)) {
			await this.deallocatePreparedStatement(client, statementName, true);
			forgetPreparedStatementObligation(client, statementName);
		}
	}

	private async issueConnectionQuery<T extends QueryResultRow>(
		executor: Pool | PoolClient,
		sql: string,
		parameters: readonly unknown[] | undefined,
		preparedStatementName: string | undefined,
	): Promise<MaybeMultipleQueryResults<T>> {
		if (preparedStatementName !== undefined) {
			const query: QueryConfig<unknown[]> = {
				name: preparedStatementName,
				text: sql,
				values: [],
			};
			return executor.query<T>(query) as Promise<MaybeMultipleQueryResults<T>>;
		}
		if (parameters === undefined) {
			return executor.query<T>(sql) as Promise<MaybeMultipleQueryResults<T>>;
		}
		return executor.query<T>(sql, [...parameters]) as Promise<
			MaybeMultipleQueryResults<T>
		>;
	}

	private async assertNoTransactionControlCommand<T extends QueryResultRow>(
		executor: Pool | PoolClient,
		result: MaybeMultipleQueryResults<T>,
		allowedScopeToken: DbspScopeToken | undefined,
	): Promise<void> {
		if (!isPoolClientLike(executor)) return;
		const current = this.currentClientScope(executor);
		if (current === undefined || current.token !== allowedScopeToken) return;
		for (const queryResult of queryResults(result)) {
			if (isPrepareCommandTag(queryResult.command)) {
				await this.assertPrepareDidNotEndTransaction(
					executor,
					allowedScopeToken,
					queryResult,
				);
				continue;
			}
			if (isTransactionControlCommandTag(queryResult.command)) {
				throw this.poisonClientScopeStack(
					executor,
					new PgsqlRawSqlTransactionControlError(queryResult),
				);
			}
		}
	}

	private async assertPrepareDidNotEndTransaction<T extends QueryResultRow>(
		client: PoolClient,
		allowedScopeToken: DbspScopeToken | undefined,
		queryResult: QueryResult<T>,
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
					new PgsqlRawSqlTransactionControlError(queryResult),
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
		schema?: string,
		options?: TruncateOptions,
	): string {
		return generateTruncateSQL(table, schema ?? this.schemaName, options);
	}

	/**
	 * Generate SQL for VACUUM.
	 * Implements TableDDLGeneratorAdapter.generateVacuum.
	 */
	generateVacuum(
		table: string,
		schema?: string,
		options?: VacuumOptions,
	): string {
		return generateVacuumSQL(table, schema ?? this.schemaName, options);
	}

	/**
	 * Generate SQL for ALTER TABLE ... ALTER COLUMN.
	 * Implements TableDDLGeneratorAdapter.generateAlterColumn.
	 */
	generateAlterColumn(
		table: string,
		column: string,
		options: AlterColumnOptions,
		schema?: string,
	): string {
		return generateAlterColumnSQL(
			table,
			column,
			options,
			schema ?? this.schemaName,
		);
	}

	/**
	 * Generate SQL for CREATE INDEX.
	 * Implements TableDDLGeneratorAdapter.generateCreateIndex.
	 */
	generateCreateIndex(
		table: string,
		options: CreateIndexOptions,
		schema?: string,
	): string {
		return generateCreateIndexSQL(table, options, schema ?? this.schemaName);
	}

	/**
	 * Generate SQL for DROP INDEX.
	 * Implements TableDDLGeneratorAdapter.generateDropIndex.
	 */
	generateDropIndex(name: string, options?: DropIndexOptions): string {
		return generateDropIndexSQL(name, options);
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
 * Creates a compile-only PgsqlAdapter for SQL generation without a database connection.
 *
 * All compilation methods (compile, compileInsert, etc.), createDump(), and generateDDL()
 * work normally. Execution methods (execute, stream, transaction, etc.) throw an error.
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
	options?: PgsqlAdapterOptions,
): CompileOnlyAdapter {
	// The `unknown` intermediate cast is required because TypeScript treats
	// `?: never` properties as non-overlapping with the concrete methods on
	// PgsqlAdapter<DB>. CompileOnlyAdapter uses `?: never` to exclude execution
	// methods at compile time; at runtime those methods throw ExecutionError
	// when no Pool is provided. The cast is intentional and safe.
	return new PgsqlAdapter<DB>(
		undefined,
		options,
	) as unknown as CompileOnlyAdapter;
}
