/**
 * PostgreSQL CHECK constraint and column-default canonicalisation.
 */
import { randomUUID } from 'node:crypto';
import { ModelIRImpl } from '@dbsp/core';
import type {
	Adapter,
	CheckConstraintIR,
	DbCasing,
	EnumIR,
	ModelIR,
	TableIR,
} from '@dbsp/types';
import { getCheckConstraintDatabaseName } from './check-constraint-name.js';
import {
	isCheckConstraintNotValid,
	renderCheckConstraintClause,
	stripNotValidSuffix,
} from './check-expression.js';
import { generateEnumTypesPhase } from './ddl/phases/enum-types.js';
import type { PhaseContext } from './ddl/phases/types.js';
import { formatSqlDefault, quoteIdent } from './ddl/phases/utils.js';
import { mapColumnType } from './ddl/type-mapping.js';
import {
	type EngineCanonicalExpression,
	engineCanonicalSqlDefault,
	isEngineCanonicalCheck,
	markEngineCanonicalCheck,
} from './expression-provenance.js';
import {
	getNamingPluginForDbCasing,
	identityNaming,
	type NamingPlugin,
} from './naming-plugin.js';
import type { RollbackOnlyPgsqlScope } from './pgsql-adapter.js';
import { escapeDiagnosticText, validateCheckExpression } from './validate.js';

export interface CheckConstraintCanonicalizationWarning {
	readonly table: string;
	readonly kind: 'check_constraint';
	readonly name: string;
	readonly constraint: string;
	readonly message: string;
	readonly cause: unknown;
}

export interface ColumnDefaultCanonicalizationWarning {
	readonly table: string;
	readonly kind: 'column_default';
	readonly name: string;
	readonly message: string;
	readonly cause: unknown;
	readonly outcome?: 'unavailable' | 'rejected' | 'refused';
}

export type ExpressionCanonicalizationWarning =
	| CheckConstraintCanonicalizationWarning
	| ColumnDefaultCanonicalizationWarning;

export interface CanonicalizeCheckConstraintsOptions {
	/** Database schema that owns the target tables and target-scoped enum types. */
	readonly schemaName?: string;
	/** Naming convention used when matching desired table names to DB table names. */
	readonly dbCasing?: DbCasing;
	/** Called when PostgreSQL CHECK canonicalisation fails and raw comparison is used. */
	readonly onWarning?: (
		warning: CheckConstraintCanonicalizationWarning,
	) => void;
	/** Throw instead of falling back to raw comparison when canonicalisation fails. */
	readonly requireCanonicalization?: boolean;
	/** Skip CHECK scratch work when the caller's dialect does not support CHECK DDL. */
	readonly canonicalizeCheckConstraints?: boolean;
}

export interface CanonicalizeExpressionSurfacesOptions
	extends Omit<CanonicalizeCheckConstraintsOptions, 'onWarning'> {
	/** Called when PostgreSQL cannot canonicalise a CHECK or column default. */
	readonly onWarning?: (warning: ExpressionCanonicalizationWarning) => void;
}

type CanonicalizationOptions =
	| CanonicalizeCheckConstraintsOptions
	| CanonicalizeExpressionSurfacesOptions;

interface CheckConstraintTarget {
	readonly modelKey: string;
	readonly modelTable: TableIR;
	readonly dbTable?: TableIR;
	readonly dbTableName: string;
	readonly checks: readonly CheckConstraintIR[];
	readonly dbCheckNames: readonly string[];
}

interface ColumnDefaultTarget {
	readonly modelKey: string;
	readonly dbTable: TableIR;
	readonly dbTableName: string;
	readonly columns: readonly TableIR['columns'][number][];
}

type PgsqlCanonicalizationScope = Pick<Adapter, 'executeRaw' | 'transaction'>;

/** Only deparse readers below may mint this provenance brand. */
function engineCanonicalExpression(value: string): EngineCanonicalExpression {
	return value as EngineCanonicalExpression;
}

interface CheckCanonicalizationNameScope {
	readonly tempPrefix: string;
}

const TEMP_TABLE_UNAVAILABLE_SQLSTATE_CODES = new Set([
	'42501', // insufficient_privilege
	'0A000', // feature_not_supported, e.g. temporary tables during recovery
]);

const TRANSACTION_INTEGRITY_OR_CLEANUP_SQLSTATE_CODES = new Set([
	'25P01', // no_active_sql_transaction
	'25P02', // in_failed_sql_transaction
	'3B001', // invalid_savepoint_specification
	'25006', // read_only_sql_transaction
]);

type ExpressionStatement = 'alter_column_set_default' | 'add_check_constraint';

/**
 * Keep the source statement in a wrapper we own. PostgreSQL errors can be
 * frozen or non-extensible, and transaction cleanup may wrap them.
 */
class TaggedExpressionRejection extends Error {
	constructor(
		readonly statement: ExpressionStatement,
		readonly cause: unknown,
	) {
		super(`PostgreSQL rejected expression while executing ${statement}`);
		this.name = 'TaggedExpressionRejection';
	}
}

export class CheckConstraintCanonicalizationError extends Error {
	constructor(
		readonly table: string,
		readonly constraints: readonly string[],
		readonly cause: unknown,
	) {
		super(
			`Could not canonicalize ${constraints.length} CHECK constraint expression(s). ` +
				'Inspect the table and constraints fields for their identities.',
		);
		this.name = 'CheckConstraintCanonicalizationError';
	}
}

export class ColumnDefaultCanonicalizationError extends Error {
	constructor(
		readonly table: string,
		readonly column: string,
		readonly cause: unknown,
	) {
		super(
			'Could not canonicalize one column default. Inspect the table and column fields for its identity.',
		);
		this.name = 'ColumnDefaultCanonicalizationError';
	}
}

export interface CanonicalizedExpressionModels {
	readonly desired: ModelIR;
	readonly database: ModelIR;
	/** The observed outcome for every column-default surface considered here. */
	readonly defaultOutcomes: readonly ColumnDefaultCanonicalizationOutcome[];
}

export interface ColumnDefaultCanonicalizationOutcome {
	/** The model side whose default could not be canonicalized. */
	readonly side: 'desired' | 'database';
	readonly table: string;
	readonly column: string;
	readonly status: 'canonicalised' | 'unavailable' | 'rejected';
	readonly reason?: unknown;
}

interface CanonicalizedTableChecks {
	readonly desired: readonly CheckConstraintIR[];
	/** Present only when the live database CHECKs were deparsed in this scope. */
	readonly database?: readonly CheckConstraintIR[];
}

/**
 * Returns true for the PostgreSQL failure class where CHECK canonicalisation
 * could not create or use its scratch temp table. These failures are expected in
 * restricted roles and should degrade to raw CHECK comparison in non-strict
 * live diffs.
 */
export function isCheckCanonicalizationTempTableUnavailableError(
	error: unknown,
): boolean {
	const chain = errorChain(error);
	// Fail closed: if the error chain also carries a genuine cleanup/rollback or
	// transaction-integrity failure, the caller transaction state is unknown —
	// raw-CHECK fallback is NOT a valid recovery, even when a temp-table denial is
	// also present. Surface it instead of masking it.
	if (chain.some(isTransactionIntegrityOrCleanupFailureItem)) return false;
	return chain.some(isTempTableUnavailableErrorItem);
}

export function fallbackToRawCheckConstraintComparison(
	desired: ModelIR,
	dbModel: ModelIR,
	cause: unknown,
	options?: CanonicalizationOptions,
): ModelIR {
	const targets = collectCheckConstraintTargets(desired, dbModel, options);
	if (targets.length === 0) {
		return desired;
	}
	for (const target of targets) {
		reportCanonicalizationFailure(target, cause, options);
	}
	return cloneModelWithCanonicalChecks(desired, new Map());
}

export function fallbackToRawExpressionComparison(
	desired: ModelIR,
	dbModel: ModelIR,
	cause: unknown,
	options?: CanonicalizeExpressionSurfacesOptions,
): CanonicalizedExpressionModels {
	const desiredWithRawChecks =
		options?.canonicalizeCheckConstraints === false
			? desired
			: fallbackToRawCheckConstraintComparison(
					desired,
					dbModel,
					cause,
					options,
				);
	const defaultOutcomes = collectUnavailableColumnDefaultOutcomes(
		desired,
		dbModel,
		options,
	);
	const recordedDefaultOutcomes = new Set(
		defaultOutcomes.map(defaultOutcomeKey),
	);
	for (const outcome of defaultOutcomes) {
		reportUnavailableColumnDefault(outcome, options);
	}
	for (const target of collectColumnDefaultTargets(desired, dbModel, options)) {
		for (const column of target.columns) {
			reportColumnDefaultCanonicalizationFailure(
				target,
				column,
				cause,
				options,
				'unavailable',
			);
			const outcome = {
				side: 'desired',
				table: target.dbTableName,
				column: namingForOptions(options).toDatabase(column.name),
				status: 'unavailable',
				reason: cause,
			} as const;
			if (!recordedDefaultOutcomes.has(defaultOutcomeKey(outcome))) {
				defaultOutcomes.push(outcome);
				recordedDefaultOutcomes.add(defaultOutcomeKey(outcome));
			}
			const databaseColumn = target.dbTable.columns.find(
				(candidate) =>
					candidate.name === namingForOptions(options).toDatabase(column.name),
			);
			if (
				databaseColumn?.default !== undefined &&
				databaseColumn.default !== null
			) {
				const databaseOutcome = {
					side: 'database',
					table: target.dbTableName,
					column: databaseColumn.name,
					status: 'unavailable',
					reason: cause,
				} as const;
				if (!recordedDefaultOutcomes.has(defaultOutcomeKey(databaseOutcome))) {
					defaultOutcomes.push(databaseOutcome);
					recordedDefaultOutcomes.add(defaultOutcomeKey(databaseOutcome));
				}
			}
		}
	}
	return { desired: desiredWithRawChecks, database: dbModel, defaultOutcomes };
}

/**
 * Canonicalise PostgreSQL CHECK constraint expressions in a desired model.
 */
export async function canonicalizeCheckConstraints(
	adapter: RollbackOnlyPgsqlScope,
	desired: ModelIR,
	dbModel: ModelIR,
	options?: CanonicalizeCheckConstraintsOptions,
): Promise<ModelIR> {
	if (options?.canonicalizeCheckConstraints === false) return desired;
	return (
		await canonicalizeCheckConstraintModels(
			adapter,
			desired,
			dbModel,
			options,
			false,
		)
	).desired;
}

/**
 * Canonicalize desired CHECKs and, when requested, matching live CHECKs.
 *
 * The public CHECK-only helper retains its historic desired-model return shape.
 * Live schema comparison uses the pair so every comparable CHECK expression is
 * rendered by PostgreSQL in the same pinned-search-path scratch session.
 */
async function canonicalizeCheckConstraintModels(
	adapter: PgsqlCanonicalizationScope,
	desired: ModelIR,
	dbModel: ModelIR,
	options: CanonicalizationOptions | undefined,
	canonicalizeDatabaseChecks: boolean,
	createEnumTypes = true,
): Promise<CanonicalizedExpressionModels> {
	const targets = collectCheckConstraintTargets(desired, dbModel, options);
	if (targets.length === 0) {
		return { desired, database: dbModel, defaultOutcomes: [] };
	}

	const canonicalChecksByTable = new Map<
		string,
		readonly CheckConstraintIR[]
	>();
	const canonicalDatabaseChecksByTable = new Map<
		string,
		readonly CheckConstraintIR[]
	>();
	const names = createCheckCanonicalizationNameScope();
	let workError: unknown;

	try {
		if (createEnumTypes) {
			const enumCreationFailure = await createMissingDesiredEnumTypes(
				adapter,
				desired,
				dbModel,
				options,
			);
			if (enumCreationFailure !== undefined) {
				for (const target of targets) {
					reportCanonicalizationFailure(target, enumCreationFailure, options);
				}
				return { desired, database: dbModel, defaultOutcomes: [] };
			}
		}
		for (let i = 0; i < targets.length; i++) {
			const target = targets[i]!;
			const canonicalChecks = await canonicalizeTableChecksBestEffort(
				adapter,
				target,
				i,
				options,
				names,
				canonicalizeDatabaseChecks,
			);
			if (canonicalChecks !== undefined) {
				canonicalChecksByTable.set(target.modelKey, canonicalChecks.desired);
				if (canonicalChecks.database !== undefined) {
					canonicalDatabaseChecksByTable.set(
						target.dbTableName,
						canonicalChecks.database,
					);
				}
			}
		}
	} catch (error) {
		workError = error;
	}

	if (workError !== undefined) {
		if (
			options?.requireCanonicalization ||
			!isCheckCanonicalizationTempTableUnavailableError(workError)
		) {
			throw workError;
		}
		for (const target of targets) {
			if (!canonicalChecksByTable.has(target.modelKey)) {
				reportCanonicalizationFailure(target, workError, options);
			}
		}
	}

	return {
		desired: cloneModelWithCanonicalChecks(desired, canonicalChecksByTable),
		database: cloneModelWithCanonicalChecks(
			dbModel,
			canonicalDatabaseChecksByTable,
		),
		defaultOutcomes: [],
	};
}

/**
 * Canonicalise CHECK constraints and column defaults through PostgreSQL.
 *
 * Both models returned here are clones. Expressions are resolved while the
 * target schema is pinned in `search_path`, then deparsed with only
 * `pg_catalog` in that path so target-scoped names are schema-qualified in the
 * text that later reaches emitted DDL. The introspection-time `{ sql }`
 * rendering is deliberately never parsed again.
 */
export async function canonicalizeExpressionSurfaces(
	adapter: RollbackOnlyPgsqlScope,
	desired: ModelIR,
	dbModel: ModelIR,
	options?: CanonicalizeExpressionSurfacesOptions,
): Promise<CanonicalizedExpressionModels> {
	const defaultTargets = collectColumnDefaultTargets(desired, dbModel, options);
	const unavailableDefaultOutcomes = collectUnavailableColumnDefaultOutcomes(
		desired,
		dbModel,
		options,
	);
	const hasChecks =
		options?.canonicalizeCheckConstraints !== false &&
		collectCheckConstraintTargets(desired, dbModel, options).length > 0;
	if (!hasChecks && defaultTargets.length === 0) {
		for (const outcome of unavailableDefaultOutcomes) {
			reportUnavailableColumnDefault(outcome, options);
		}
		return {
			desired,
			database: dbModel,
			defaultOutcomes: unavailableDefaultOutcomes,
		};
	}
	const enumCreationFailure = await createMissingDesiredEnumTypes(
		adapter,
		desired,
		dbModel,
		options,
	);
	if (enumCreationFailure !== undefined) {
		if (hasChecks) {
			for (const target of collectCheckConstraintTargets(
				desired,
				dbModel,
				options,
			)) {
				reportCanonicalizationFailure(target, enumCreationFailure, options);
			}
		}
		const failedDefaults = unavailableDefaultOutcomesForEnumCreation(
			defaultTargets,
			enumCreationFailure,
			options,
		);
		for (const outcome of unavailableDefaultOutcomes) {
			reportUnavailableColumnDefault(outcome, options);
		}
		return {
			desired,
			database: dbModel,
			defaultOutcomes: [...unavailableDefaultOutcomes, ...failedDefaults],
		};
	}

	let checkModels: CanonicalizedExpressionModels = {
		desired,
		database: dbModel,
		defaultOutcomes: [],
	};
	if (hasChecks) {
		checkModels = await canonicalizeCheckConstraintModels(
			adapter,
			desired,
			dbModel,
			options,
			true,
			false,
		);
	} else {
		await pinCanonicalizationSearchPath(adapter, options);
	}
	const canonicalDefaults = await canonicalizeColumnDefaults(
		adapter,
		checkModels.desired,
		checkModels.database,
		defaultTargets,
		options,
	);
	for (const outcome of unavailableDefaultOutcomes) {
		reportUnavailableColumnDefault(outcome, options);
	}
	return {
		...canonicalDefaults,
		defaultOutcomes: [
			...unavailableDefaultOutcomes,
			...canonicalDefaults.defaultOutcomes,
		],
	};
}

function unavailableDefaultOutcomesForEnumCreation(
	targets: readonly ColumnDefaultTarget[],
	cause: unknown,
	options: CanonicalizeExpressionSurfacesOptions | undefined,
): ColumnDefaultCanonicalizationOutcome[] {
	const outcomes: ColumnDefaultCanonicalizationOutcome[] = [];
	for (const target of targets) {
		for (const column of target.columns) {
			reportColumnDefaultCanonicalizationFailure(
				target,
				column,
				cause,
				options,
				'unavailable',
			);
			outcomes.push({
				side: 'desired',
				table: target.dbTableName,
				column: namingForOptions(options).toDatabase(column.name),
				status: 'unavailable',
				reason: cause,
			});
		}
	}
	return outcomes;
}

function collectUnavailableColumnDefaultOutcomes(
	desired: ModelIR,
	dbModel: ModelIR,
	options: CanonicalizationOptions | undefined,
): ColumnDefaultCanonicalizationOutcome[] {
	const naming = namingForOptions(options);
	const outcomes: ColumnDefaultCanonicalizationOutcome[] = [];
	const desiredTablesByDatabaseName = new Map<string, TableIR>(
		[...desired.tables.values()].map((table) => [
			naming.toDatabase(table.name),
			table,
		]),
	);
	for (const table of desired.tables.values()) {
		const dbTableName = naming.toDatabase(table.name);
		const dbTable = dbModel.tables.get(dbTableName);
		for (const column of table.columns) {
			if (column.default === undefined || column.default === null) continue;
			const columnName = naming.toDatabase(column.name);
			if (dbTable === undefined) {
				outcomes.push(
					unavailableDefaultOutcome(
						'desired',
						dbTableName,
						columnName,
						'the table is absent from the database',
					),
				);
			} else if (
				!dbTable.columns.some((candidate) => candidate.name === columnName)
			) {
				outcomes.push(
					unavailableDefaultOutcome(
						'desired',
						dbTableName,
						columnName,
						'the column is absent from the database',
					),
				);
			}
		}
	}
	for (const dbTable of dbModel.tables.values()) {
		const desiredTable = desiredTablesByDatabaseName.get(dbTable.name);
		for (const dbColumn of dbTable.columns) {
			if (dbColumn.default === undefined || dbColumn.default === null) continue;
			const desiredColumn = desiredTable?.columns.find(
				(column) => naming.toDatabase(column.name) === dbColumn.name,
			);
			if (
				desiredColumn?.default === undefined ||
				desiredColumn.default === null
			) {
				outcomes.push(
					unavailableDefaultOutcome(
						'database',
						dbTable.name,
						dbColumn.name,
						'the default exists only in the database',
					),
				);
			}
		}
	}
	return outcomes;
}

function unavailableDefaultOutcome(
	side: 'desired' | 'database',
	table: string,
	column: string,
	reason: string,
): ColumnDefaultCanonicalizationOutcome {
	return { side, table, column, status: 'unavailable', reason };
}

function defaultOutcomeKey(
	outcome: Pick<
		ColumnDefaultCanonicalizationOutcome,
		'side' | 'table' | 'column'
	>,
): string {
	return JSON.stringify([outcome.side, outcome.table, outcome.column]);
}

function collectColumnDefaultTargets(
	desired: ModelIR,
	dbModel: ModelIR,
	options: CanonicalizationOptions | undefined,
): ColumnDefaultTarget[] {
	const naming = namingForOptions(options);
	const targets: ColumnDefaultTarget[] = [];
	for (const [modelKey, table] of desired.tables) {
		const dbTableName = naming.toDatabase(table.name);
		const dbTable = dbModel.tables.get(dbTableName);
		if (dbTable === undefined) continue;
		const dbColumnNames = new Set(dbTable.columns.map((column) => column.name));
		const columns = table.columns.filter(
			(column) =>
				column.default !== undefined &&
				column.default !== null &&
				dbColumnNames.has(naming.toDatabase(column.name)),
		);
		if (columns.length === 0) continue;
		targets.push({
			modelKey,
			dbTable,
			dbTableName,
			columns,
		});
	}
	return targets;
}

async function canonicalizeColumnDefaults(
	adapter: PgsqlCanonicalizationScope,
	desired: ModelIR,
	dbModel: ModelIR,
	targets: readonly ColumnDefaultTarget[],
	options: CanonicalizeExpressionSurfacesOptions | undefined,
): Promise<CanonicalizedExpressionModels> {
	const desiredDefaults = new Map<
		string,
		Map<string, EngineCanonicalExpression>
	>();
	const databaseDefaults = new Map<
		string,
		Map<string, EngineCanonicalExpression>
	>();
	const names = createCheckCanonicalizationNameScope();
	const defaultOutcomes: ColumnDefaultCanonicalizationOutcome[] = [];

	for (let targetIndex = 0; targetIndex < targets.length; targetIndex++) {
		const target = targets[targetIndex]!;
		const targetDefaults = await canonicalizeTableDefaultsBestEffort(
			adapter,
			target,
			targetIndex,
			options,
			names,
		);
		for (const result of targetDefaults) {
			defaultOutcomes.push({
				side: result.side,
				table: target.dbTableName,
				column: result.databaseColumnName,
				status: result.status,
				...(result.reason === undefined ? {} : { reason: result.reason }),
			});
			if (result.desired !== undefined) {
				let defaults = desiredDefaults.get(target.modelKey);
				if (defaults === undefined) {
					defaults = new Map();
					desiredDefaults.set(target.modelKey, defaults);
				}
				defaults.set(result.modelColumnName, result.desired);
			}
			if (result.database !== undefined) {
				let defaults = databaseDefaults.get(target.dbTableName);
				if (defaults === undefined) {
					defaults = new Map();
					databaseDefaults.set(target.dbTableName, defaults);
				}
				defaults.set(result.databaseColumnName, result.database);
			}
		}
	}

	return {
		desired: cloneModelWithCanonicalDefaults(desired, desiredDefaults),
		database: cloneModelWithCanonicalDefaults(dbModel, databaseDefaults),
		defaultOutcomes,
	};
}

interface CanonicalColumnDefault {
	readonly side: 'desired' | 'database';
	readonly modelColumnName: string;
	readonly databaseColumnName: string;
	readonly desired?: EngineCanonicalExpression;
	readonly database?: EngineCanonicalExpression;
	readonly status: 'canonicalised' | 'unavailable' | 'rejected';
	readonly reason?: unknown;
}

async function canonicalizeTableDefaultsBestEffort(
	adapter: PgsqlCanonicalizationScope,
	target: ColumnDefaultTarget,
	targetIndex: number,
	options: CanonicalizeExpressionSurfacesOptions | undefined,
	names: CheckCanonicalizationNameScope,
): Promise<CanonicalColumnDefault[]> {
	const results: CanonicalColumnDefault[] = [];
	for (
		let columnIndex = 0;
		columnIndex < target.columns.length;
		columnIndex++
	) {
		const column = target.columns[columnIndex]!;
		const databaseColumnName = namingForOptions(options).toDatabase(
			column.name,
		);
		try {
			results.push(
				await adapter.transaction((tx) =>
					canonicalizeColumnDefault(
						tx,
						target,
						targetIndex,
						column,
						columnIndex,
						options,
						names,
					),
				),
			);
		} catch (error) {
			throw new ColumnDefaultCanonicalizationError(
				target.dbTableName,
				databaseColumnName,
				error,
			);
		}
	}
	return results;
}

async function canonicalizeColumnDefault(
	adapter: PgsqlCanonicalizationScope,
	target: ColumnDefaultTarget,
	targetIndex: number,
	column: TableIR['columns'][number],
	columnIndex: number,
	options: CanonicalizeExpressionSurfacesOptions | undefined,
	names: CheckCanonicalizationNameScope,
): Promise<CanonicalColumnDefault> {
	const naming = namingForOptions(options);
	const databaseColumnName = naming.toDatabase(column.name);
	const dbColumn = target.dbTable.columns.find(
		(candidate) => candidate.name === databaseColumnName,
	)!;
	const tempTableName = `${names.tempPrefix}_defaults_${targetIndex}_${columnIndex}`;
	const tempTable = quoteIdent(tempTableName, 'table');
	try {
		await adapter.transaction((tx) =>
			tx.executeRaw(
				`CREATE TEMP TABLE ${tempTable} (${generateScratchColumnDef(
					column,
					new Map([[databaseColumnName, dbColumn]]),
					naming,
					options?.schemaName,
				)}) ON COMMIT DROP`,
			),
		);
	} catch (error) {
		if (
			!options?.requireCanonicalization &&
			(isCheckCanonicalizationTempTableUnavailableError(error) ||
				pgErrorCode(error) === '42501' ||
				pgErrorCode(error) === '42704')
		) {
			reportColumnDefaultCanonicalizationFailure(
				target,
				column,
				error,
				options,
				'unavailable',
			);
			return {
				side: 'desired',
				modelColumnName: column.name,
				databaseColumnName,
				status: 'unavailable',
				reason: error,
			};
		}
		throw error;
	}
	try {
		// Validation is local author-input validation, not a PostgreSQL refusal.
		const formattedDefault = formatSqlDefault(
			column.default,
			'canonicalized column default',
		);
		try {
			await adapter.transaction((tx) =>
				tx.executeRaw(
					`ALTER TABLE ${tempTable} ALTER COLUMN ${quoteIdent(databaseColumnName, 'column')} SET DEFAULT ${formattedDefault}`,
				),
			);
		} catch (error) {
			throw markExpressionRejection(error, 'alter_column_set_default');
		}
	} catch (error) {
		if (
			options?.requireCanonicalization ||
			!isSemanticExpressionRejection(error, 'alter_column_set_default')
		) {
			throw error;
		}
		// Preserve the classified PostgreSQL result if best-effort cleanup also fails.
		reportColumnDefaultCanonicalizationFailure(
			target,
			column,
			error,
			options,
			'rejected',
		);
		return {
			side: 'desired',
			modelColumnName: column.name,
			databaseColumnName,
			status: 'rejected',
			reason: error,
		};
	}

	const defaults = await deparseWithCatalogSearchPath(adapter, options, (tx) =>
		deparseColumnDefaults(
			tx,
			tempTableName,
			databaseColumnName,
			dbColumn.default === undefined || dbColumn.default === null
				? undefined
				: qualifiedRelationName(target.dbTableName, options),
		),
	);
	if (
		dbColumn.default !== undefined &&
		dbColumn.default !== null &&
		defaults.database === undefined
	) {
		const outcome = unavailableDefaultOutcome(
			'database',
			target.dbTableName,
			databaseColumnName,
			'PostgreSQL default disappeared before paired deparse',
		);
		reportUnavailableColumnDefault(outcome, options);
		return {
			side: 'database',
			modelColumnName: column.name,
			databaseColumnName,
			status: 'unavailable',
			reason: outcome.reason,
		};
	}
	return {
		side: 'desired',
		modelColumnName: column.name,
		databaseColumnName,
		desired: defaults.desired,
		...(defaults.database === undefined ? {} : { database: defaults.database }),
		status: 'canonicalised',
	};
}

async function deparseColumnDefaults(
	adapter: PgsqlCanonicalizationScope,
	tempTableName: string,
	columnName: string,
	databaseRelationName: string | undefined,
): Promise<{
	readonly desired: EngineCanonicalExpression;
	readonly database?: EngineCanonicalExpression;
}> {
	const relations = [
		['desired', tempTableName],
		...(databaseRelationName === undefined
			? []
			: [['database', databaseRelationName]]),
	] as const;
	const rows = await adapter.executeRaw<{ source: string; expression: string }>(
		`SELECT source, pg_get_expr(d.adbin, d.adrelid, false) AS expression
		   FROM unnest($1::text[], $2::text[]) AS relation(source, name)
		   JOIN pg_attrdef d ON d.adrelid = relation.name::regclass
		   JOIN pg_attribute a
		     ON a.attrelid = d.adrelid
		    AND a.attnum = d.adnum
		  WHERE a.attname = $3`,
		[
			relations.map(([source]) => source),
			relations.map(([, relationName]) => relationName),
			columnName,
		],
	);
	const defaults = new Map(
		rows.map((row) => [row.source, engineCanonicalExpression(row.expression)]),
	);
	const desired = defaults.get('desired');
	if (typeof desired !== 'string') {
		throw new Error('PostgreSQL did not return a canonical default.');
	}
	const database = defaults.get('database');
	return {
		desired,
		...(database === undefined ? {} : { database }),
	};
}

function collectCheckConstraintTargets(
	desired: ModelIR,
	dbModel: ModelIR,
	options: CanonicalizationOptions | undefined,
): CheckConstraintTarget[] {
	const plugin =
		options?.dbCasing !== undefined
			? getNamingPluginForDbCasing(options.dbCasing)
			: identityNaming;
	const targets: CheckConstraintTarget[] = [];

	for (const [modelKey, table] of desired.tables) {
		const checks = table.checkConstraints ?? [];
		if (checks.length === 0) continue;

		const dbTableName = plugin.toDatabase(table.name);
		const dbTable = dbModel.tables.get(dbTableName);

		targets.push({
			modelKey,
			modelTable: table,
			...(dbTable !== undefined ? { dbTable } : {}),
			dbTableName,
			checks,
			dbCheckNames: checks.map((check) =>
				getCheckConstraintDatabaseName(check, plugin),
			),
		});
	}

	return targets;
}

async function canonicalizeTableChecksBestEffort(
	adapter: PgsqlCanonicalizationScope,
	target: CheckConstraintTarget,
	targetIndex: number,
	options: CanonicalizationOptions | undefined,
	names: CheckCanonicalizationNameScope,
	canonicalizeDatabaseChecks: boolean,
): Promise<CanonicalizedTableChecks | undefined> {
	try {
		return await adapter.transaction(async (tx) => {
			await pinCanonicalizationSearchPath(tx, options);
			return canonicalizeTableChecks(
				tx,
				target,
				targetIndex,
				options,
				names,
				canonicalizeDatabaseChecks,
			);
		});
	} catch (error) {
		if (error instanceof CheckConstraintCanonicalizationError) {
			throw error;
		}
		if (
			options?.requireCanonicalization ||
			!isCheckCanonicalizationTempTableUnavailableError(error)
		) {
			throw new CheckConstraintCanonicalizationError(
				target.dbTableName,
				target.dbCheckNames,
				error,
			);
		}
		reportCanonicalizationFailure(target, error, options);
		return undefined;
	}
}

async function canonicalizeTableChecks(
	adapter: PgsqlCanonicalizationScope,
	target: CheckConstraintTarget,
	targetIndex: number,
	options: CanonicalizationOptions | undefined,
	names: CheckCanonicalizationNameScope,
	canonicalizeDatabaseChecks: boolean,
): Promise<CanonicalizedTableChecks> {
	const tempTableName = `${names.tempPrefix}_${targetIndex}`;
	const tempTable = quoteIdent(tempTableName, 'table');
	const naming = namingForOptions(options);
	const targetSchema = options?.schemaName;
	const dbColumnsByName = new Map(
		(target.dbTable?.columns ?? []).map((column) => [column.name, column]),
	);
	const columnDefs = target.modelTable.columns.map((column) =>
		generateScratchColumnDef(column, dbColumnsByName, naming, targetSchema),
	);
	const canonicalChecks = [...target.checks];

	try {
		await adapter.transaction((tx) =>
			tx.executeRaw(
				`CREATE TEMP TABLE ${tempTable} (${columnDefs.join(', ')}) ON COMMIT DROP`,
			),
		);
	} catch (error) {
		if (
			!options?.requireCanonicalization &&
			(isCheckCanonicalizationTempTableUnavailableError(error) ||
				pgErrorCode(error) === '42501' ||
				pgErrorCode(error) === '42704')
		) {
			reportCanonicalizationFailure(target, error, options);
			return { desired: canonicalChecks };
		}
		throw error;
	}

	const tempConstraintNamesByIndex = new Map<number, string>();
	for (let i = 0; i < target.checks.length; i++) {
		const check = target.checks[i]!;
		const tempConstraintName = `${names.tempPrefix}_${targetIndex}_${i}`;
		const expression = renderCheckConstraintClause(check);
		if (!isEngineCanonicalCheck(check)) {
			validateCheckExpression(expression, 'canonicalized check constraint');
		}
		try {
			try {
				await adapter.transaction((tx) =>
					tx.executeRaw(
						`ALTER TABLE ${tempTable} ADD CONSTRAINT ${quoteIdent(tempConstraintName, 'alias')} ${expression}`,
					),
				);
			} catch (error) {
				throw markExpressionRejection(error, 'add_check_constraint');
			}
			tempConstraintNamesByIndex.set(i, tempConstraintName);
		} catch (error) {
			if (
				options?.requireCanonicalization ||
				!isSemanticExpressionRejection(error, 'add_check_constraint')
			) {
				throw new CheckConstraintCanonicalizationError(
					target.dbTableName,
					[target.dbCheckNames[i]!],
					error,
				);
			}
			reportConstraintCanonicalizationFailure(target, i, error, options);
		}
	}

	const tempConstraintNames = [...tempConstraintNamesByIndex.values()];
	if (tempConstraintNames.length === 0) {
		return { desired: canonicalChecks };
	}

	const rows = await deparseWithCatalogSearchPath(adapter, options, (tx) =>
		tx.executeRaw<{
			name: string;
			expression: string;
		}>(
			`SELECT conname AS name,
		        pg_get_constraintdef(oid, false) AS expression
		   FROM pg_constraint
		  WHERE conrelid = $1::regclass
		    AND conname = ANY($2::text[])
		  ORDER BY array_position($2::text[], conname)`,
			[tempTableName, tempConstraintNames],
		),
	);

	const canonicalByTempName = new Map(
		rows.map((row) => [
			row.name,
			engineCanonicalExpression(stripNotValidSuffix(row.expression)),
		]),
	);

	for (const [i, tempConstraintName] of tempConstraintNamesByIndex) {
		const check = target.checks[i]!;
		const expression = canonicalByTempName.get(tempConstraintName);
		if (expression === undefined) {
			const error = new Error(
				'PostgreSQL did not return a canonical CHECK expression.',
			);
			throw new CheckConstraintCanonicalizationError(
				target.dbTableName,
				[target.dbCheckNames[i]!],
				error,
			);
		}
		const notValid = isCheckConstraintNotValid(check);
		canonicalChecks[i] = markEngineCanonicalCheck({
			...check,
			expression,
			...(notValid ? { notValid: true } : {}),
		});
	}

	if (!canonicalizeDatabaseChecks || target.dbTable === undefined) {
		return { desired: canonicalChecks };
	}

	const canonicalDatabaseChecks = [...(target.dbTable.checkConstraints ?? [])];
	const matchingDatabaseCheckNames = [...tempConstraintNamesByIndex.keys()]
		.map((index) => target.dbCheckNames[index]!)
		.filter((name) =>
			canonicalDatabaseChecks.some((check) => check.name === name),
		);
	if (matchingDatabaseCheckNames.length > 0) {
		const databaseExpressions = await deparseWithCatalogSearchPath(
			adapter,
			options,
			(tx) =>
				deparseDatabaseChecks(
					tx,
					qualifiedRelationName(target.dbTableName, options),
					matchingDatabaseCheckNames,
				),
		);
		for (let i = 0; i < canonicalDatabaseChecks.length; i++) {
			const databaseCheck = canonicalDatabaseChecks[i]!;
			const expression = databaseExpressions.get(databaseCheck.name);
			if (expression === undefined) continue;
			canonicalDatabaseChecks[i] = markEngineCanonicalCheck({
				...databaseCheck,
				expression: engineCanonicalExpression(stripNotValidSuffix(expression)),
			});
		}
	}

	return { desired: canonicalChecks, database: canonicalDatabaseChecks };
}

async function deparseDatabaseChecks(
	adapter: PgsqlCanonicalizationScope,
	relationName: string,
	constraintNames: readonly string[],
): Promise<Map<string, string>> {
	const rows = await adapter.executeRaw<{ name: string; expression: string }>(
		`SELECT conname AS name,
		        pg_get_constraintdef(oid, false) AS expression
		   FROM pg_constraint
		  WHERE conrelid = $1::regclass
		    AND conname = ANY($2::text[])`,
		[relationName, constraintNames],
	);
	const expressions = new Map<string, string>();
	for (const row of rows) {
		if (typeof row.name === 'string' && typeof row.expression === 'string') {
			expressions.set(row.name, row.expression);
		}
	}
	return expressions;
}

function generateScratchColumnDef(
	column: TableIR['columns'][number],
	dbColumnsByName: ReadonlyMap<string, TableIR['columns'][number]>,
	naming: NamingPlugin,
	targetSchema: string | undefined,
): string {
	const dbColumn = dbColumnsByName.get(naming.toDatabase(column.name));
	const typeColumn =
		!column.originalDbType?.trim() &&
		dbColumn?.originalDbType?.trim() &&
		column.type === dbColumn.type
			? dbColumn
			: column;
	const scratchColumn =
		typeColumn.autoIncrement === true
			? { ...typeColumn, autoIncrement: false }
			: typeColumn;
	return `${quoteIdent(naming.toDatabase(column.name), 'column')} ${mapColumnType(scratchColumn, targetSchema)}`;
}

/**
 * Install enum types newly declared by the desired model in the rollback-only
 * scratch scope before any scratch table refers to them. A failed CREATE TYPE
 * makes those expression surfaces unavailable; it is never an expression
 * rejection and never escapes this classifier.
 */
async function createMissingDesiredEnumTypes(
	adapter: PgsqlCanonicalizationScope,
	desired: ModelIR,
	dbModel: ModelIR,
	options: CanonicalizationOptions | undefined,
): Promise<unknown | undefined> {
	const missingEnums = missingDesiredEnums(desired, dbModel);
	if (missingEnums.size === 0) return undefined;
	const enumModel = new ModelIRImpl(new Map(), new Map(), missingEnums);
	const context: PhaseContext = {
		schema: enumModel,
		tables: [],
		schemaName: options?.schemaName,
		naming: namingForOptions(options),
		caps: undefined,
		fkAutoIndex: false,
		includeDropStatements: false,
	};
	for (const statement of generateEnumTypesPhase(context)) {
		try {
			await adapter.transaction((tx) => tx.executeRaw(statement));
		} catch (error) {
			return error;
		}
	}
	return undefined;
}

function missingDesiredEnums(
	desired: ModelIR,
	dbModel: ModelIR,
): Map<string, EnumIR> {
	const missing = new Map<string, EnumIR>();
	for (const [name, enumDef] of desired.enums ?? []) {
		if (!dbModel.enums?.has(name)) missing.set(name, enumDef);
	}
	return missing;
}

async function pinCanonicalizationSearchPath(
	adapter: PgsqlCanonicalizationScope,
	options: CanonicalizationOptions | undefined,
): Promise<void> {
	const schemaName = options?.schemaName ?? 'public';
	await adapter.executeRaw(
		`SET LOCAL search_path TO pg_catalog, ${quoteIdent(schemaName, 'schema')}`,
	);
}

/**
 * PostgreSQL's deparsers omit qualification for objects visible through the
 * current search path. Canonical expressions are later emitted by a different
 * session, so render them under `pg_catalog` only and restore the resolution
 * path before any further scratch DDL.
 *
 * Temporary relations remain addressable while this path is active: PostgreSQL
 * searches its temporary schema first for relation lookup even when `pg_temp`
 * is not listed explicitly.
 */
async function deparseWithCatalogSearchPath<T>(
	adapter: PgsqlCanonicalizationScope,
	options: CanonicalizationOptions | undefined,
	deparse: (adapter: PgsqlCanonicalizationScope) => Promise<T>,
): Promise<T> {
	await adapter.executeRaw('SET LOCAL search_path TO pg_catalog');
	try {
		const result = await adapter.transaction(deparse);
		await pinCanonicalizationSearchPath(adapter, options);
		return result;
	} catch (error) {
		try {
			await pinCanonicalizationSearchPath(adapter, options);
		} catch (restoreError) {
			throw new AggregateError(
				[error, restoreError],
				'PostgreSQL expression deparse failed and search_path restoration also failed',
			);
		}
		throw error;
	}
}

function qualifiedRelationName(
	tableName: string,
	options: CanonicalizationOptions | undefined,
): string {
	return `${quoteIdent(options?.schemaName ?? 'public', 'schema')}.${quoteIdent(tableName, 'table')}`;
}

function createCheckCanonicalizationNameScope(): CheckCanonicalizationNameScope {
	const callId = randomUUID().replace(/-/gu, '').slice(0, 12);
	return {
		tempPrefix: `_dbsp_check_canon_${callId}`,
	};
}

function namingForOptions(
	options: CanonicalizationOptions | undefined,
): NamingPlugin {
	return options?.dbCasing !== undefined
		? getNamingPluginForDbCasing(options.dbCasing)
		: identityNaming;
}

function reportCanonicalizationFailure(
	target: CheckConstraintTarget,
	cause: unknown,
	options: CanonicalizationOptions | undefined,
): void {
	for (let i = 0; i < target.checks.length; i++) {
		reportConstraintCanonicalizationFailure(target, i, cause, options);
	}
}

function reportConstraintCanonicalizationFailure(
	target: CheckConstraintTarget,
	checkIndex: number,
	cause: unknown,
	options: CanonicalizationOptions | undefined,
): void {
	const dbCheckName = target.dbCheckNames[checkIndex]!;
	const message =
		'Could not canonicalize one CHECK constraint with PostgreSQL; falling back to best-effort raw string comparison. ' +
		'Inspect the warning table and constraint fields for its identity. ' +
		`Reason: ${errorMessage(cause)}`;
	const warning: CheckConstraintCanonicalizationWarning = {
		table: target.dbTableName,
		kind: 'check_constraint',
		name: dbCheckName,
		constraint: dbCheckName,
		message,
		cause,
	};
	const onWarning = options?.onWarning as
		| ((warning: CheckConstraintCanonicalizationWarning) => void)
		| undefined;
	if (onWarning) {
		onWarning(warning);
	} else {
		console.warn(`Warning: ${message}`);
	}
}

function reportColumnDefaultCanonicalizationFailure(
	target: ColumnDefaultTarget,
	column: TableIR['columns'][number],
	cause: unknown,
	options: CanonicalizeExpressionSurfacesOptions | undefined,
	outcome: 'unavailable' | 'rejected',
): void {
	const columnName = namingForOptions(options).toDatabase(column.name);
	const message =
		'Could not canonicalize one column default with PostgreSQL; falling back to verbatim raw comparison. ' +
		'Inspect the warning table and name fields for its identity. ' +
		`Reason: ${errorMessage(cause)}`;
	const warning: ColumnDefaultCanonicalizationWarning = {
		table: target.dbTableName,
		kind: 'column_default',
		name: columnName,
		message,
		cause,
		outcome,
	};
	if (options?.onWarning) {
		options.onWarning(warning);
	} else {
		console.warn(`Warning: ${message}`);
	}
}

function reportUnavailableColumnDefault(
	outcome: ColumnDefaultCanonicalizationOutcome,
	options: CanonicalizeExpressionSurfacesOptions | undefined,
): void {
	const cause = outcome.reason;
	const refused = options?.requireCanonicalization === true;
	const message =
		'Could not canonicalize one column default ' +
		(refused
			? 'with PostgreSQL; strict canonicalization refused raw comparison for this column. '
			: 'with PostgreSQL; falling back to verbatim raw comparison for this column. ') +
		'Inspect the warning table and name fields for its identity. ' +
		`Reason: ${errorMessage(cause)}`;
	const warning: ColumnDefaultCanonicalizationWarning = {
		table: outcome.table,
		kind: 'column_default',
		name: outcome.column,
		message,
		cause,
		outcome: refused ? 'refused' : 'unavailable',
	};
	if (options?.onWarning) {
		options.onWarning(warning);
	} else {
		console.warn(`Warning: ${message}`);
	}
}

function errorMessage(error: unknown): string {
	if (error instanceof TaggedExpressionRejection) {
		return errorMessage(error.cause);
	}
	return escapeDiagnosticText(
		error instanceof Error ? error.message : String(error),
	);
}

function isTempTableUnavailableErrorItem(error: unknown): boolean {
	const code = pgErrorCode(error);
	const message = errorMessage(error).toLowerCase();
	if (TEMP_TABLE_UNAVAILABLE_SQLSTATE_CODES.has(code ?? '')) {
		return mentionsTemporaryTable(message);
	}
	if (code === '42P07') {
		return (
			message.includes('_dbsp_check_canon_') &&
			message.includes('already exists')
		);
	}
	return (
		message.includes('permission denied to create temporary tables') ||
		message.includes('permission denied to create temp tables') ||
		message.includes('cannot create temporary table') ||
		message.includes('cannot create temporary tables') ||
		message.includes('cannot create temp table') ||
		message.includes('cannot create temp tables') ||
		message.includes('temporary tables cannot be created') ||
		message.includes('temp tables cannot be created')
	);
}

function mentionsTemporaryTable(message: string): boolean {
	return (
		(message.includes('temporary') || message.includes('temp')) &&
		message.includes('table')
	);
}

function isTransactionIntegrityOrCleanupFailureItem(error: unknown): boolean {
	if (
		TRANSACTION_INTEGRITY_OR_CLEANUP_SQLSTATE_CODES.has(
			pgErrorCode(error) ?? '',
		)
	) {
		return true;
	}
	if (typeof error !== 'object' || error === null) return false;
	if (Object.hasOwn(error, 'cleanupError')) return true;
	return (
		hasTrueProperty(error, 'dbspTransactionAborted') ||
		hasTrueProperty(error, 'dbspTransactionAbortedCommit') ||
		hasTrueProperty(error, 'dbspRawSqlTransactionControl')
	);
}

function markExpressionRejection(
	error: unknown,
	statement: ExpressionStatement,
): TaggedExpressionRejection {
	return new TaggedExpressionRejection(statement, error);
}

/**
 * Raw comparison is only safe after PostgreSQL positively classified an error
 * from the authored expression as semantic. Missing/unknown SQLSTATEs and
 * operational failures remain observable to the caller.
 */
function isSemanticExpressionRejection(
	error: unknown,
	statement: ExpressionStatement,
): boolean {
	if (
		!errorChain(error).some(
			(item) =>
				item instanceof TaggedExpressionRejection &&
				item.statement === statement,
		)
	) {
		return false;
	}
	const chain = errorChain(error);
	if (chain.some(isTransactionIntegrityOrCleanupFailureItem)) return false;
	const leaves = chain.filter((item) => nestedErrors(item).length === 0);
	return (
		leaves.length > 0 &&
		leaves.every((item) => {
			const code = pgErrorCode(item);
			return (
				code !== undefined &&
				!isOperationalSqlState(code) &&
				(code.startsWith('22') ||
					code.startsWith('23') ||
					(code.startsWith('42') && code !== '42501') ||
					code === '0A000')
			);
		})
	);
}

function isOperationalSqlState(code: string): boolean {
	return (
		code.startsWith('08') ||
		code.startsWith('25') ||
		code.startsWith('3B') ||
		code.startsWith('40') ||
		code.startsWith('53') ||
		code.startsWith('54') ||
		code === '55P03' ||
		code === '55P04' ||
		code.startsWith('57') ||
		code.startsWith('58') ||
		code.startsWith('XX')
	);
}

function hasTrueProperty(error: object, property: string): boolean {
	return (
		Object.hasOwn(error, property) &&
		(error as Record<string, unknown>)[property] === true
	);
}

function pgErrorCode(error: unknown): string | undefined {
	if (typeof error !== 'object' || error === null || !('code' in error)) {
		return undefined;
	}
	const code = (error as { readonly code?: unknown }).code;
	return typeof code === 'string' ? code : undefined;
}

function errorChain(error: unknown): unknown[] {
	const items: unknown[] = [];
	const seen = new Set<unknown>();
	const pending: unknown[] = [error];
	while (pending.length > 0) {
		const item = pending.shift();
		if (item === undefined || seen.has(item)) continue;
		seen.add(item);
		items.push(item);
		for (const nested of nestedErrors(item)) {
			pending.push(nested);
		}
	}
	return items;
}

function nestedErrors(error: unknown): unknown[] {
	if (typeof error !== 'object' || error === null) {
		return [];
	}
	const nested: unknown[] = [];
	const withCause = error as {
		readonly cause?: unknown;
		readonly cleanupError?: unknown;
		readonly originalError?: unknown;
	};
	if (withCause.cause !== undefined) nested.push(withCause.cause);
	if (withCause.originalError !== undefined)
		nested.push(withCause.originalError);
	if (withCause.cleanupError !== undefined) nested.push(withCause.cleanupError);
	if (error instanceof AggregateError) {
		nested.push(...error.errors);
	}
	return nested;
}

function cloneModelWithCanonicalChecks(
	model: ModelIR,
	canonicalChecksByTable: ReadonlyMap<string, readonly CheckConstraintIR[]>,
): ModelIR {
	const tables = new Map<string, TableIR>();
	for (const [key, table] of model.tables) {
		const checks = canonicalChecksByTable.get(key);
		tables.set(
			key,
			checks === undefined
				? table
				: {
						...table,
						checkConstraints: checks,
					},
		);
	}

	return new ModelIRImpl(
		tables,
		new Map(model.relations),
		model.enums === undefined ? undefined : new Map(model.enums),
		model.extensions,
		model.sequences === undefined ? undefined : new Map(model.sequences),
		model.externalTables,
	);
}

function cloneModelWithCanonicalDefaults(
	model: ModelIR,
	canonicalDefaultsByTable: ReadonlyMap<
		string,
		ReadonlyMap<string, EngineCanonicalExpression>
	>,
): ModelIR {
	const tables = new Map<string, TableIR>();
	for (const [key, table] of model.tables) {
		const defaults = canonicalDefaultsByTable.get(key);
		tables.set(
			key,
			defaults === undefined
				? table
				: {
						...table,
						columns: table.columns.map((column) => {
							const expression = defaults.get(column.name);
							return expression === undefined
								? column
								: {
										...column,
										default: engineCanonicalSqlDefault(expression),
									};
						}),
					},
		);
	}

	return new ModelIRImpl(
		tables,
		new Map(model.relations),
		model.enums === undefined ? undefined : new Map(model.enums),
		model.extensions,
		model.sequences === undefined ? undefined : new Map(model.sequences),
		model.externalTables,
	);
}
