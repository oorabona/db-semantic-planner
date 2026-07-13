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
import type { Pool, PoolClient, QueryResult } from 'pg';
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
	introspect as introspectDb,
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

let savepointCounter = 0;

const RAW_SQL_TRANSACTION_CONTROL_MESSAGE =
	'PostgreSQL raw SQL performed transaction control inside a dbsp-managed scope. ' +
	'The transaction dbsp was working inside no longer exists. ' +
	"The state of the caller's data is whatever their own raw SQL statement made it. " +
	'Do not continue as if the surrounding transaction is still alive.';

type CleanupFailureError = AggregateError & {
	readonly cleanupError: unknown;
	readonly originalError?: unknown;
};

type SavepointHandle = {
	readonly client: PoolClient;
	readonly name: string;
};

export class PgsqlRawSqlTransactionControlError extends Error {
	readonly dbspRawSqlTransactionControl = true;

	constructor(cause: unknown) {
		super(RAW_SQL_TRANSACTION_CONTROL_MESSAGE, { cause });
		this.name = 'PgsqlRawSqlTransactionControlError';
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

function nextSavepointName(): string {
	savepointCounter = (savepointCounter + 1) % Number.MAX_SAFE_INTEGER;
	return `dbsp_savepoint_${savepointCounter}`;
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

function addRawSqlTransactionContext(error: unknown): unknown {
	const context =
		'dbsp rolled back the failed raw SQL to a savepoint, so the surrounding transaction is still usable.';
	if (error instanceof Error) {
		error.message = `${error.message}; ${context}`;
		Object.defineProperty(error, 'dbspRawSqlContext', {
			value: context,
			configurable: true,
		});
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
	 * successful callback last until your transaction ends. Transaction control
	 * issued through raw SQL inside a dbsp-managed scope is unsupported: dbsp
	 * cannot stop it and cannot undo it. If PostgreSQL destroys dbsp's savepoint,
	 * dbsp reports PgsqlRawSqlTransactionControlError; the transaction dbsp was
	 * working inside is already gone, and your data state is whatever your own
	 * statement made it.
	 */
	readonly managedTransactions?: true;
}

interface PgsqlAdapterInternalOptions
	extends PgsqlBorrowedClientAdapterOptions {
	readonly adapterManagedTransaction?: true;
}

type PgsqlAdapterConstructionOptions =
	| PgsqlAdapterOptions
	| PgsqlPoolAdapterOptions
	| PgsqlBorrowedClientAdapterOptions
	| PgsqlAdapterInternalOptions;

type PgsqlAdapterConstructionOverrides = Partial<PgsqlAdapterOptions> & {
	readonly borrowedClient?: true | false;
	readonly managedTransactions?: true;
	readonly adapterManagedTransaction?: true;
};

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
		typeof options === 'object' &&
		options !== null &&
		'adapterManagedTransaction' in options &&
		options.adapterManagedTransaction === true
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
		overrides: PgsqlAdapterConstructionOverrides,
	): PgsqlAdapterConstructionOptions {
		return {
			...(this.schemaName !== undefined && { schemaName: this.schemaName }),
			...(this._dbCasing !== undefined && { dbCasing: this._dbCasing }),
			...(this.model !== undefined && { model: this.model }),
			...(this.logger !== undefined && { logger: this.logger }),
			defaultPkColumnName: this.defaultPk,
			deriveFkColumnName: this.deriveFk,
			...(this.borrowedClient && { borrowedClient: true as const }),
			...(this.managedTransactions && { managedTransactions: true as const }),
			...(this.adapterManagedTransaction && {
				adapterManagedTransaction: true as const,
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
		const executor = this.requireConnection();
		const result = await executor.query(query.sql, [...query.parameters]);
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
			let releaseError: Error | boolean | undefined;
			let cleanupErrorToThrow: unknown;
			try {
				await client.query('BEGIN');
				begun = true;
				yield* adapter.streamWithClient<T>(client, query, chunkSize);
				await client.query('COMMIT');
				committed = true;
			} catch (error) {
				streamFailed = true;
				if (begun && !committed) {
					try {
						await client.query('ROLLBACK');
					} catch (rollbackErr) {
						releaseError = rollbackErr instanceof Error ? rollbackErr : true;
						throw createCleanupFailureError(
							'PostgreSQL stream cleanup failed: ROLLBACK failed after the stream failed',
							error,
							rollbackErr,
						);
					}
				}
				throw error;
			} finally {
				// On early break, yield* returns without reaching COMMIT.
				// ROLLBACK the open transaction to avoid leaking it to the pool.
				if (begun && !committed && !streamFailed) {
					try {
						await client.query('ROLLBACK');
					} catch (rollbackErr) {
						releaseError = rollbackErr instanceof Error ? rollbackErr : true;
						cleanupErrorToThrow = createCleanupOnlyError(
							'PostgreSQL stream cleanup failed: ROLLBACK failed after the stream was closed early',
							rollbackErr,
						);
					}
				}
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
	): AsyncIterableIterator<T> {
		// Generate unique cursor name
		const cursorName = generateCursorName();

		// Declare cursor
		await client.query(
			`DECLARE ${cursorName} NO SCROLL CURSOR FOR ${query.sql}`,
			query.parameters as unknown[],
		);

		try {
			// Fetch in batches
			while (true) {
				const result = await client.query(
					`FETCH FORWARD ${chunkSize} FROM ${cursorName}`,
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
		} finally {
			// Always close the cursor
			await client.query(`CLOSE ${cursorName}`);
		}
	}

	private async *streamWithManagedClient<T>(
		client: PoolClient,
		query: CompiledQuery<T>,
		chunkSize: number,
	): AsyncIterableIterator<T> {
		const savepointName = nextSavepointName();
		try {
			await client.query(`SAVEPOINT ${savepointName}`);
		} catch (error) {
			if (isPgErrorWithCode(error, NO_ACTIVE_SQL_TRANSACTION)) {
				yield* this.streamWithClientTransaction(client, query, chunkSize);
				return;
			}
			throw error;
		}

		let completed = false;
		let streamError: unknown;
		try {
			yield* this.streamWithClient<T>(client, query, chunkSize);
			completed = true;
		} catch (error) {
			streamError = error;
			throw error;
		} finally {
			if (completed) {
				await client.query(`RELEASE SAVEPOINT ${savepointName}`);
			} else {
				try {
					await this.rollbackAndReleaseSavepoint(client, savepointName);
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
		try {
			await client.query('BEGIN');
			begun = true;
			yield* this.streamWithClient<T>(client, query, chunkSize);
			await client.query('COMMIT');
			committed = true;
		} catch (error) {
			streamFailed = true;
			if (begun && !committed) {
				try {
					await client.query('ROLLBACK');
				} catch (rollbackErr) {
					throw createCleanupFailureError(
						'PostgreSQL stream cleanup failed: ROLLBACK failed after the stream failed',
						error,
						rollbackErr,
					);
				}
			}
			throw error;
		} finally {
			if (begun && !committed && !streamFailed) {
				try {
					await client.query('ROLLBACK');
				} catch (rollbackErr) {
					cleanupErrorToThrow = createCleanupOnlyError(
						'PostgreSQL stream cleanup failed: ROLLBACK failed after the stream was closed early',
						rollbackErr,
					);
				}
			}
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
		return introspectDb(executor, options);
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

	private createManagedClientAdapter(client: PoolClient): PgsqlAdapter<DB> {
		return new PgsqlAdapter<DB>(
			client,
			this.cloneOptions({
				borrowedClient: true,
				managedTransactions: true,
				adapterManagedTransaction: true,
			}),
		);
	}

	private async transactionWithManagedClient<T>(
		client: PoolClient,
		fn: (adapter: Adapter<DB>) => Promise<T>,
	): Promise<T> {
		const savepointName = nextSavepointName();
		try {
			await client.query(`SAVEPOINT ${savepointName}`);
		} catch (error) {
			if (isPgErrorWithCode(error, NO_ACTIVE_SQL_TRANSACTION)) {
				return this.transactionWithClientTransaction(client, fn);
			}
			throw error;
		}

		const txAdapter = this.createManagedClientAdapter(client);
		try {
			const result = await fn(txAdapter);
			await client.query(`RELEASE SAVEPOINT ${savepointName}`);
			return result;
		} catch (error) {
			if (isRawSqlTransactionControlError(error)) {
				throw error;
			}
			try {
				await this.rollbackAndReleaseSavepoint(client, savepointName);
			} catch (cleanupErr) {
				throw createCleanupFailureError(
					'PostgreSQL transaction cleanup failed: savepoint cleanup failed after the transaction body failed',
					error,
					cleanupErr,
				);
			}
			throw error;
		}
	}

	private async transactionWithClientTransaction<T>(
		client: PoolClient,
		fn: (adapter: Adapter<DB>) => Promise<T>,
	): Promise<T> {
		let begun = false;
		let committed = false;
		try {
			await client.query('BEGIN');
			begun = true;
			const txAdapter = this.createManagedClientAdapter(client);
			const result = await fn(txAdapter);
			await client.query('COMMIT');
			committed = true;
			return result;
		} catch (error) {
			if (begun && !committed) {
				try {
					await client.query('ROLLBACK');
				} catch (rollbackErr) {
					throw createCleanupFailureError(
						'PostgreSQL transaction cleanup failed: ROLLBACK failed after the transaction body failed',
						error,
						rollbackErr,
					);
				}
			}
			throw error;
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
	): Promise<void> {
		await client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
		await client.query(`RELEASE SAVEPOINT ${savepointName}`);
	}

	/**
	 * Create a schema-scoped adapter for multi-tenant queries.
	 */
	withSchema(schemaName: string): Adapter<DB> {
		// Validate schema name
		validateIdentifier(schemaName, 'schema');

		// Create new adapter preserving all configuration, only overriding schemaName
		const options = this.cloneOptions({ schemaName });
		return new PgsqlAdapter<DB>(this.client ?? this.pool ?? undefined, options);
	}

	// =========================================================================
	// RawSqlAdapter Methods
	// =========================================================================

	/**
	 * Execute raw SQL directly.
	 *
	 * ⚠️  WARNING: Use parameter placeholders ($1, $2, etc.) for all values.
	 * Transaction control inside a dbsp-managed scope is unsupported: dbsp
	 * cannot stop it, cannot undo it, and reports it only after PostgreSQL has
	 * already destroyed the savepoint.
	 */
	async executeRaw<T = unknown>(
		sql: string,
		parameters: readonly unknown[] = [],
	): Promise<T[]> {
		const result = await this.executeQueryProtectingOpenTransaction(
			sql,
			parameters,
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
		await this.executeQueryProtectingOpenTransaction(sql);
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

	private async executeQueryProtectingOpenTransaction(
		sql: string,
		parameters?: readonly unknown[],
	): Promise<QueryResult> {
		const executor = this.requireConnection();
		const savepoint = await this.openRawSqlSavepointIfInTransaction();
		if (savepoint === undefined) {
			return this.queryExecutor(executor, sql, parameters);
		}

		let result: QueryResult;
		try {
			result = await this.queryExecutor(executor, sql, parameters);
		} catch (error) {
			try {
				await this.rollbackAndReleaseSavepoint(
					savepoint.client,
					savepoint.name,
				);
			} catch (cleanupErr) {
				throw createCleanupFailureError(
					'PostgreSQL raw SQL cleanup failed: savepoint cleanup failed after PostgreSQL rejected the statement',
					error,
					cleanupErr,
				);
			}
			throw addRawSqlTransactionContext(error);
		}
		try {
			await savepoint.client.query(`RELEASE SAVEPOINT ${savepoint.name}`);
		} catch (releaseErr) {
			throw new PgsqlRawSqlTransactionControlError(releaseErr);
		}
		return result;
	}

	private async queryExecutor(
		executor: Pool | PoolClient,
		sql: string,
		parameters: readonly unknown[] | undefined,
	): Promise<QueryResult> {
		if (parameters === undefined) {
			return executor.query(sql);
		}
		return executor.query(sql, [...parameters]);
	}

	private async openRawSqlSavepointIfInTransaction(): Promise<
		SavepointHandle | undefined
	> {
		const client = this.client;
		if (!client) return undefined;

		const savepointName = nextSavepointName();
		if (this.inTransaction) {
			await client.query(`SAVEPOINT ${savepointName}`);
			return { client, name: savepointName };
		}

		try {
			await client.query(`SAVEPOINT ${savepointName}`);
		} catch (error) {
			if (isPgErrorWithCode(error, NO_ACTIVE_SQL_TRANSACTION)) {
				return undefined;
			}
			throw error;
		}
		return { client, name: savepointName };
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
		const executor = this.requireConnection();
		const params: unknown[] = [table, this.explicitSchema(schema) ?? null];
		let sql =
			'SELECT indexname, indexdef FROM pg_indexes ' +
			`WHERE tablename = $1 AND schemaname = COALESCE($2, ${RESOLVE_TABLE_SCHEMA_SQL('$1')})`;
		if (options?.namePattern) {
			sql += ' AND indexname LIKE $3';
			params.push(options.namePattern);
		}
		sql += ' ORDER BY indexname';
		const result = await executor.query<{
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
		const executor = this.requireConnection();
		const result = await executor.query<{ exists: boolean }>(
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
		const executor = this.requireConnection();
		const schemaName = this.explicitSchema(schema);
		// Double any embedded double-quotes to prevent injection.
		const quotedTable = `"${table.replace(/"/g, '""')}"`;
		const identifier =
			schemaName !== undefined
				? `"${schemaName.replace(/"/g, '""')}".${quotedTable}`
				: quotedTable;
		const result = await executor.query<{ size: string }>(
			`SELECT pg_total_relation_size($1::regclass)::bigint AS size`,
			[identifier],
		);
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
	return new PgsqlAdapter<DB>(connection, options);
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
