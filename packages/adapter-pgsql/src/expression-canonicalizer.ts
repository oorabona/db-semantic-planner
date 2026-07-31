/**
 * PostgreSQL CHECK constraint and column-default canonicalisation.
 */
import { randomUUID } from 'node:crypto';
import { ModelIRImpl } from '@dbsp/core';
import type {
	CheckConstraintIR,
	DbCasing,
	DialectCapabilities,
	EnumIR,
	IndexIR,
	ModelIR,
	SequenceIR,
	TableIR,
} from '@dbsp/types';
import { getCheckConstraintDatabaseName } from './check-constraint-name.js';
import {
	isCheckConstraintNotValid,
	renderCheckConstraintClause,
	stripNotValidSuffix,
} from './check-expression.js';
import {
	columnDbTypeSchemaIdentity,
	dbTypesEqual,
	stripDbTypeSchema,
} from './db-type.js';
import { generateColumnDef } from './ddl/ddl-generator.js';
import { generateEnumTypesPhase } from './ddl/phases/enum-types.js';
import { generateSequencesPhase } from './ddl/phases/sequences.js';
import type { PhaseContext } from './ddl/phases/types.js';
import {
	formatSqlDefault,
	quoteCollation,
	quoteIdent,
} from './ddl/phases/utils.js';
import { mapColumnType } from './ddl/type-mapping.js';
import {
	type EngineCanonicalExpression,
	engineCanonicalSqlDefault,
	isEngineCanonicalCheck,
	markEngineCanonicalCheck,
	markEngineCanonicalIndex,
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
	/** Whether this warning represents a raw fallback or absent counterpart. */
	readonly comparison: 'raw' | 'unpaired';
	/** Present when the default could not be paired with the opposite model side. */
	readonly side?: 'desired' | 'database';
}

export interface IndexPredicateCanonicalizationWarning {
	readonly table: string;
	readonly kind: 'index_predicate';
	readonly name: string;
	readonly message: string;
	readonly cause: unknown;
	readonly outcome: 'unavailable' | 'rejected' | 'refused';
	/** Predicate fallback always compares both complete models raw. */
	readonly comparison: 'raw';
	readonly side?: 'desired' | 'database';
}

export type ExpressionCanonicalizationWarning =
	| CheckConstraintCanonicalizationWarning
	| ColumnDefaultCanonicalizationWarning
	| IndexPredicateCanonicalizationWarning;

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
	/** Capabilities used to generate the migration this scope is staging for. */
	readonly dialectCapabilities?: DialectCapabilities;
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
	readonly modelTable: TableIR;
	readonly dbTable: TableIR;
	readonly dbTableName: string;
	readonly columns: readonly TableIR['columns'][number][];
}

interface DesiredIndexPredicateTarget {
	readonly modelKey: string;
	readonly modelTable: TableIR;
	readonly dbTable?: TableIR;
	readonly dbTableName: string;
	readonly index: IndexIR;
	readonly predicate: string;
}

interface DatabaseIndexPredicateTarget {
	readonly tableName: string;
	readonly index: IndexIR;
	readonly predicate: string;
}

const pgsqlCanonicalizationScopeBrand: unique symbol = Symbol(
	'dbsp.pgsql.canonicalization-scope',
);

const expressionIndexPredicateCanonicalizationUnavailable = new Error(
	'Partial-index predicates on expression-keyed indexes are not canonicalized.',
);

/**
 * The rollback-only PostgreSQL scope required by canonicalization scratch DDL.
 *
 * `SET LOCAL` and `ON COMMIT DROP` only have the required lifetime inside this
 * branded scope.  A plain auto-commit implementation cannot satisfy it.
 */
export type PgsqlCanonicalizationScope = {
	executeRaw<T = unknown>(
		sql: string,
		parameters?: readonly unknown[],
	): Promise<T[]>;
	transaction<T>(
		fn: (scope: PgsqlCanonicalizationScope) => Promise<T>,
	): Promise<T>;
	readonly [pgsqlCanonicalizationScopeBrand]: typeof pgsqlCanonicalizationScopeBrand;
};

/** Mint canonicalization provenance from the adapter's rollback-only scope. */
function canonicalizationScope(
	adapter: RollbackOnlyPgsqlScope,
): PgsqlCanonicalizationScope {
	return adapter as unknown as PgsqlCanonicalizationScope;
}

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

type ExpressionStatement =
	| 'alter_column_set_default'
	| 'add_check_constraint'
	| 'create_partial_index';

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

class IndexPredicateCanonicalizationUnavailableError extends Error {
	constructor(readonly cause: unknown) {
		super(
			'PostgreSQL could not build the scratch relation for a partial-index predicate. ' +
				`Reason: ${errorMessage(cause)}`,
		);
		this.name = 'IndexPredicateCanonicalizationUnavailableError';
	}
}

/** A schema object needed by expression staging could not be created. */
export class PlannedSchemaStagingError extends Error {
	constructor(
		readonly statement: 'CREATE TYPE' | 'CREATE SEQUENCE',
		readonly cause: unknown,
	) {
		super(
			`PostgreSQL could not stage ${statement} for expression canonicalization. ` +
				`Reason: ${errorMessage(cause)}`,
			{ cause },
		);
		this.name = 'PlannedSchemaStagingError';
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
	/** The observed outcome for every partial-index predicate considered here. */
	readonly indexPredicateOutcomes: readonly IndexPredicateCanonicalizationOutcome[];
}

interface ColumnDefaultCanonicalizationOutcomeIdentity {
	/** The model side whose default could not be canonicalized. */
	readonly side: 'desired' | 'database';
	readonly table: string;
	readonly column: string;
}

type ColumnDefaultFallbackOutcome =
	ColumnDefaultCanonicalizationOutcomeIdentity & {
		/** Whether this fallback uses raw comparison or has no counterpart. */
		readonly status: 'unavailable' | 'rejected';
		readonly comparison: 'raw' | 'unpaired';
		readonly reason: unknown;
	};

type CanonicalizedColumnDefaultOutcome =
	ColumnDefaultCanonicalizationOutcomeIdentity & {
		readonly status: 'canonicalised';
	};

export type ColumnDefaultCanonicalizationOutcome =
	| CanonicalizedColumnDefaultOutcome
	| ColumnDefaultFallbackOutcome;

export type IndexPredicateCanonicalizationOutcome =
	| {
			readonly side: 'desired' | 'database';
			readonly table: string;
			readonly index: string;
			readonly status: 'canonicalised';
	  }
	| {
			readonly side: 'desired' | 'database';
			readonly table: string;
			readonly index: string;
			readonly status: 'unavailable' | 'rejected';
			readonly comparison: 'raw';
			readonly reason: unknown;
			/** Why an unavailable predicate was not canonicalized. */
			readonly unavailableCause?: 'infrastructure' | 'expression-keyed';
	  };

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

/**
 * Classifies only failures while constructing a scratch relation. `42501` may
 * deny TEMP or a scratch dependency, while `42704` identifies an unavailable
 * scratch type or operator class. The same SQLSTATE from an expression
 * statement is not evidence that raw comparison is safe.
 */
function isScratchRelationSetupUnavailableError(error: unknown): boolean {
	const chain = errorChain(error);
	if (chain.some(isTransactionIntegrityOrCleanupFailureItem)) return false;
	return chain.some((item) => {
		const code = pgErrorCode(item);
		return (
			code === '42501' ||
			code === '42704' ||
			isTempTableUnavailableErrorItem(item)
		);
	});
}

function throwIndexPredicateScratchRelationSetupFailure(error: unknown): never {
	if (isScratchRelationSetupUnavailableError(error)) {
		throw new IndexPredicateCanonicalizationUnavailableError(error);
	}
	throw error;
}

/** True when the full live comparison can safely restart from both raw models. */
export function isExpressionCanonicalizationInfrastructureUnavailableError(
	error: unknown,
): boolean {
	return (
		error instanceof IndexPredicateCanonicalizationUnavailableError ||
		isCheckCanonicalizationTempTableUnavailableError(error)
	);
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
	const desiredPredicateTargets = collectDesiredIndexPredicateTargets(
		desired,
		dbModel,
		options,
	);
	const databasePredicateTargets =
		collectDatabaseIndexPredicateTargets(dbModel);
	const indexPredicateOutcomes = unavailableIndexPredicateOutcomes(
		desiredPredicateTargets,
		databasePredicateTargets,
		cause,
		options,
		'infrastructure',
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
			const outcome = fallbackColumnDefaultOutcome(
				'desired',
				target.dbTableName,
				namingForOptions(options).toDatabase(column.name),
				'unavailable',
				'raw',
				cause,
			);
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
				const databaseOutcome = fallbackColumnDefaultOutcome(
					'database',
					target.dbTableName,
					databaseColumn.name,
					'unavailable',
					'raw',
					cause,
				);
				if (!recordedDefaultOutcomes.has(defaultOutcomeKey(databaseOutcome))) {
					defaultOutcomes.push(databaseOutcome);
					recordedDefaultOutcomes.add(defaultOutcomeKey(databaseOutcome));
				}
			}
		}
	}
	return {
		desired: desiredWithRawChecks,
		database: dbModel,
		defaultOutcomes,
		indexPredicateOutcomes,
	};
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
			canonicalizationScope(adapter),
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
		return {
			desired,
			database: dbModel,
			defaultOutcomes: [],
			indexPredicateOutcomes: [],
		};
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
				return {
					desired,
					database: dbModel,
					defaultOutcomes: [],
					indexPredicateOutcomes: [],
				};
			}
			const sequenceCreationFailure = await createMissingDesiredSequences(
				adapter,
				desired,
				dbModel,
				options,
			);
			if (sequenceCreationFailure !== undefined) {
				for (const target of targets) {
					reportCanonicalizationFailure(
						target,
						sequenceCreationFailure,
						options,
					);
				}
				return {
					desired,
					database: dbModel,
					defaultOutcomes: [],
					indexPredicateOutcomes: [],
				};
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
		indexPredicateOutcomes: [],
	};
}

/**
 * Canonicalise CHECK constraints and column defaults through PostgreSQL.
 *
 * Both models returned here are clones. Expressions are resolved under the
 * planning lease's unmodified session path, then deparsed with only `pg_catalog` in
 * the path so target-scoped names are qualified in
 * text that later reaches emitted DDL. The introspection-time `{ sql }`
 * rendering is deliberately never parsed again. The migration may use a
 * different lease; #473 tracks binding its resolution path to this planning
 * lease.
 */
export async function canonicalizeExpressionSurfaces(
	adapter: RollbackOnlyPgsqlScope,
	desired: ModelIR,
	dbModel: ModelIR,
	options?: CanonicalizeExpressionSurfacesOptions,
): Promise<CanonicalizedExpressionModels> {
	const scope = canonicalizationScope(adapter);
	const defaultTargets = collectColumnDefaultTargets(desired, dbModel, options);
	const desiredPredicateTargets = collectDesiredIndexPredicateTargets(
		desired,
		dbModel,
		options,
	);
	const databasePredicateTargets =
		collectDatabaseIndexPredicateTargets(dbModel);
	const expressionIndexPredicateOutcomes =
		unavailableExpressionIndexPredicateOutcomes(
			desiredPredicateTargets,
			databasePredicateTargets,
			options,
		);
	const canonicalDesiredPredicateTargets = desiredPredicateTargets.filter(
		(target) => !hasIndexExpressions(target.index),
	);
	const canonicalDatabasePredicateTargets = databasePredicateTargets.filter(
		(target) => !hasIndexExpressions(target.index),
	);
	const unavailableDefaultOutcomes = collectUnavailableColumnDefaultOutcomes(
		desired,
		dbModel,
		options,
	);
	const hasChecks =
		options?.canonicalizeCheckConstraints !== false &&
		collectCheckConstraintTargets(desired, dbModel, options).length > 0;
	if (
		!hasChecks &&
		defaultTargets.length === 0 &&
		canonicalDesiredPredicateTargets.length === 0 &&
		canonicalDatabasePredicateTargets.length === 0
	) {
		for (const outcome of unavailableDefaultOutcomes) {
			reportUnavailableColumnDefault(outcome, options);
		}
		return {
			desired,
			database: dbModel,
			defaultOutcomes: unavailableDefaultOutcomes,
			indexPredicateOutcomes: expressionIndexPredicateOutcomes,
		};
	}
	const enumCreationFailure = await createMissingDesiredEnumTypes(
		scope,
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
		const failedPredicates = unavailableIndexPredicateOutcomes(
			canonicalDesiredPredicateTargets,
			canonicalDatabasePredicateTargets,
			enumCreationFailure,
			options,
			'infrastructure',
		);
		for (const outcome of unavailableDefaultOutcomes) {
			reportUnavailableColumnDefault(outcome, options);
		}
		return {
			desired,
			database: dbModel,
			defaultOutcomes: [...unavailableDefaultOutcomes, ...failedDefaults],
			indexPredicateOutcomes: [
				...expressionIndexPredicateOutcomes,
				...failedPredicates,
			],
		};
	}
	const sequenceCreationFailure = await createMissingDesiredSequences(
		scope,
		desired,
		dbModel,
		options,
	);
	if (sequenceCreationFailure !== undefined) {
		if (hasChecks) {
			for (const target of collectCheckConstraintTargets(
				desired,
				dbModel,
				options,
			)) {
				reportCanonicalizationFailure(target, sequenceCreationFailure, options);
			}
		}
		const failedDefaults = unavailableDefaultOutcomesForEnumCreation(
			defaultTargets,
			sequenceCreationFailure,
			options,
		);
		const failedPredicates = unavailableIndexPredicateOutcomes(
			canonicalDesiredPredicateTargets,
			canonicalDatabasePredicateTargets,
			sequenceCreationFailure,
			options,
			'infrastructure',
		);
		for (const outcome of unavailableDefaultOutcomes) {
			reportUnavailableColumnDefault(outcome, options);
		}
		return {
			desired,
			database: dbModel,
			defaultOutcomes: [...unavailableDefaultOutcomes, ...failedDefaults],
			indexPredicateOutcomes: [
				...expressionIndexPredicateOutcomes,
				...failedPredicates,
			],
		};
	}

	const canonicalPredicates = await canonicalizeIndexPredicates(
		scope,
		desired,
		dbModel,
		canonicalDesiredPredicateTargets,
		canonicalDatabasePredicateTargets,
		options,
	);
	let checkModels: CanonicalizedExpressionModels = {
		desired: canonicalPredicates.desired,
		database: canonicalPredicates.database,
		defaultOutcomes: [],
		indexPredicateOutcomes: [],
	};
	if (hasChecks) {
		checkModels = await canonicalizeCheckConstraintModels(
			scope,
			canonicalPredicates.desired,
			canonicalPredicates.database,
			options,
			true,
			false,
		);
	} else if (defaultTargets.length > 0) {
		await pinCanonicalizationSettings(scope);
	}
	const canonicalDefaults = await canonicalizeColumnDefaults(
		scope,
		checkModels.desired,
		checkModels.database,
		defaultTargets,
		options,
	);
	for (const outcome of unavailableDefaultOutcomes) {
		reportUnavailableColumnDefault(outcome, options);
	}
	return {
		desired: canonicalDefaults.desired,
		database: canonicalDefaults.database,
		defaultOutcomes: [
			...unavailableDefaultOutcomes,
			...canonicalDefaults.defaultOutcomes,
		],
		indexPredicateOutcomes: [
			...expressionIndexPredicateOutcomes,
			...canonicalPredicates.indexPredicateOutcomes,
		],
	};
}

function unavailableExpressionIndexPredicateOutcomes(
	desiredTargets: readonly DesiredIndexPredicateTarget[],
	databaseTargets: readonly DatabaseIndexPredicateTarget[],
	options: CanonicalizeExpressionSurfacesOptions | undefined,
): IndexPredicateCanonicalizationOutcome[] {
	return unavailableIndexPredicateOutcomes(
		desiredTargets.filter((target) => hasIndexExpressions(target.index)),
		databaseTargets.filter((target) => hasIndexExpressions(target.index)),
		expressionIndexPredicateCanonicalizationUnavailable,
		options,
		'expression-keyed',
	);
}

function unavailableIndexPredicateOutcomes(
	desiredTargets: readonly DesiredIndexPredicateTarget[],
	databaseTargets: readonly DatabaseIndexPredicateTarget[],
	cause: unknown,
	options: CanonicalizeExpressionSurfacesOptions | undefined,
	unavailableCause: 'infrastructure' | 'expression-keyed',
): IndexPredicateCanonicalizationOutcome[] {
	const outcomes: IndexPredicateCanonicalizationOutcome[] = [];
	for (const target of desiredTargets) {
		const desiredOutcome: IndexPredicateCanonicalizationOutcome = {
			side: 'desired',
			table: target.dbTableName,
			index: indexPredicateName(target.index),
			status: 'unavailable',
			comparison: 'raw',
			reason: cause,
			unavailableCause,
		};
		outcomes.push(desiredOutcome);
		reportIndexPredicateCanonicalizationFailure(desiredOutcome, options);
	}
	for (const target of databaseTargets) {
		const databaseOutcome: IndexPredicateCanonicalizationOutcome = {
			side: 'database',
			table: target.tableName,
			index: indexPredicateName(target.index),
			status: 'unavailable',
			comparison: 'raw',
			reason: cause,
			unavailableCause,
		};
		outcomes.push(databaseOutcome);
		reportIndexPredicateCanonicalizationFailure(databaseOutcome, options);
	}
	return outcomes;
}

function unavailableDefaultOutcomesForEnumCreation(
	targets: readonly ColumnDefaultTarget[],
	cause: unknown,
	options: CanonicalizeExpressionSurfacesOptions | undefined,
): ColumnDefaultFallbackOutcome[] {
	const outcomes: ColumnDefaultFallbackOutcome[] = [];
	for (const target of targets) {
		for (const column of target.columns) {
			reportColumnDefaultCanonicalizationFailure(
				target,
				column,
				cause,
				options,
				'unavailable',
			);
			outcomes.push(
				fallbackColumnDefaultOutcome(
					'desired',
					target.dbTableName,
					namingForOptions(options).toDatabase(column.name),
					'unavailable',
					'raw',
					cause,
				),
			);
		}
	}
	return outcomes;
}

function collectUnavailableColumnDefaultOutcomes(
	desired: ModelIR,
	dbModel: ModelIR,
	options: CanonicalizationOptions | undefined,
): ColumnDefaultFallbackOutcome[] {
	const naming = namingForOptions(options);
	const outcomes: ColumnDefaultFallbackOutcome[] = [];
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
					fallbackColumnDefaultOutcome(
						'desired',
						dbTableName,
						columnName,
						'unavailable',
						'unpaired',
						'the table is absent from the database',
					),
				);
			} else if (
				!dbTable.columns.some((candidate) => candidate.name === columnName)
			) {
				outcomes.push(
					fallbackColumnDefaultOutcome(
						'desired',
						dbTableName,
						columnName,
						'unavailable',
						'unpaired',
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
					fallbackColumnDefaultOutcome(
						'database',
						dbTable.name,
						dbColumn.name,
						'unavailable',
						'unpaired',
						'the default exists only in the database',
					),
				);
			}
		}
	}
	return outcomes;
}

function fallbackColumnDefaultOutcome(
	side: 'desired' | 'database',
	table: string,
	column: string,
	status: ColumnDefaultFallbackOutcome['status'],
	comparison: ColumnDefaultFallbackOutcome['comparison'],
	reason: unknown,
): ColumnDefaultFallbackOutcome {
	return { side, table, column, status, comparison, reason };
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
			modelTable: table,
			dbTable,
			dbTableName,
			columns,
		});
	}
	return targets;
}

function collectDesiredIndexPredicateTargets(
	desired: ModelIR,
	database: ModelIR,
	options: CanonicalizationOptions | undefined,
): DesiredIndexPredicateTarget[] {
	const naming = namingForOptions(options);
	const targets: DesiredIndexPredicateTarget[] = [];
	for (const [modelKey, modelTable] of desired.tables) {
		const dbTableName = naming.toDatabase(modelTable.name);
		const dbTable = database.tables.get(dbTableName);
		for (const index of modelTable.indexes) {
			const predicate = index.where;
			if (predicate === undefined) continue;
			targets.push({
				modelKey,
				modelTable,
				...(dbTable === undefined ? {} : { dbTable }),
				dbTableName,
				index,
				predicate,
			});
		}
	}
	return targets;
}

function collectDatabaseIndexPredicateTargets(
	database: ModelIR,
): DatabaseIndexPredicateTarget[] {
	const targets: DatabaseIndexPredicateTarget[] = [];
	for (const table of database.tables.values()) {
		for (const index of table.indexes) {
			const predicate = index.where;
			if (predicate !== undefined) {
				targets.push({ tableName: table.name, index, predicate });
			}
		}
	}
	return targets;
}

function hasIndexExpressions(index: IndexIR): boolean {
	return (index.expressions?.length ?? 0) > 0;
}

function indexPredicateName(index: IndexIR): string {
	return index.name ?? `<unnamed:${index.columns.join(',')}>`;
}

function setCanonicalIndexPredicate(
	canonical: Map<string, Map<IndexIR, EngineCanonicalExpression>>,
	table: string,
	index: IndexIR,
	predicate: EngineCanonicalExpression,
): void {
	let tablePredicates = canonical.get(table);
	if (tablePredicates === undefined) {
		tablePredicates = new Map();
		canonical.set(table, tablePredicates);
	}
	tablePredicates.set(index, predicate);
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
			if (result.status === 'canonicalised') {
				defaultOutcomes.push({
					side: result.side,
					table: target.dbTableName,
					column: result.databaseColumnName,
					status: 'canonicalised',
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
			} else {
				defaultOutcomes.push(
					fallbackColumnDefaultOutcome(
						result.side,
						target.dbTableName,
						result.databaseColumnName,
						result.status,
						result.comparison,
						result.reason,
					),
				);
			}
		}
	}

	return {
		desired: cloneModelWithCanonicalDefaults(desired, desiredDefaults),
		database: cloneModelWithCanonicalDefaults(dbModel, databaseDefaults),
		defaultOutcomes,
		indexPredicateOutcomes: [],
	};
}

/**
 * Canonicalise a partial-index predicate by letting PostgreSQL bind it against
 * a rollback-only scratch relation and then reading `pg_index.indpred`.  The
 * index key is a private btree marker: predicates may reference any table
 * column, so using the authored key would accidentally make expression-keyed
 * index support part of this column-keyed predicate-only boundary.
 */
async function canonicalizeIndexPredicates(
	adapter: PgsqlCanonicalizationScope,
	desired: ModelIR,
	database: ModelIR,
	desiredTargets: readonly DesiredIndexPredicateTarget[],
	databaseTargets: readonly DatabaseIndexPredicateTarget[],
	options: CanonicalizeExpressionSurfacesOptions | undefined,
): Promise<
	Pick<
		CanonicalizedExpressionModels,
		'desired' | 'database' | 'indexPredicateOutcomes'
	>
> {
	const desiredPredicates = new Map<
		string,
		Map<IndexIR, EngineCanonicalExpression>
	>();
	const databasePredicates = new Map<
		string,
		Map<IndexIR, EngineCanonicalExpression>
	>();
	const outcomes: IndexPredicateCanonicalizationOutcome[] = [];
	const names = createCheckCanonicalizationNameScope();
	for (
		let targetIndex = 0;
		targetIndex < desiredTargets.length;
		targetIndex++
	) {
		const target = desiredTargets[targetIndex]!;
		const indexName = indexPredicateName(target.index);
		try {
			const canonical = await adapter.transaction(async (tx) => {
				return canonicalizeIndexPredicate(tx, {
					table: target.dbTableName,
					predicate: target.predicate,
					columns: target.modelTable.columns,
					...(target.dbTable === undefined
						? {}
						: {
								desiredTable: target.modelTable,
								databaseTable: target.dbTable,
							}),
					tempPrefix: `${names.tempPrefix}_predicate_${targetIndex}`,
					...(options === undefined ? {} : { options }),
				});
			});
			setCanonicalIndexPredicate(
				desiredPredicates,
				target.modelKey,
				target.index,
				canonical,
			);
			outcomes.push({
				side: 'desired',
				table: target.dbTableName,
				index: indexName,
				status: 'canonicalised',
			});
		} catch (error) {
			if (error instanceof IndexPredicateCanonicalizationUnavailableError) {
				// A recognised scratch-setup failure invalidates every canonical
				// substitution, so the live helper restarts from both raw models.
				throw error;
			}
			if (!isSemanticExpressionRejection(error, 'create_partial_index'))
				throw error;
			const outcome: IndexPredicateCanonicalizationOutcome = {
				side: 'desired',
				table: target.dbTableName,
				index: indexName,
				status: 'rejected',
				comparison: 'raw',
				reason: error,
			};
			outcomes.push(outcome);
			reportIndexPredicateCanonicalizationFailure(outcome, options);
		}
	}

	if (outcomes.some((outcome) => outcome.status !== 'canonicalised')) {
		// Never compare a partially canonical model after a semantic rejection.
		// The database predicates are still considered: record that the desired
		// rejection made their paired raw comparison unavailable to canonicalize.
		const rejection = outcomes.find((outcome) => outcome.status === 'rejected');
		if (rejection !== undefined && 'reason' in rejection) {
			for (const target of databaseTargets) {
				const outcome: IndexPredicateCanonicalizationOutcome = {
					side: 'database',
					table: target.tableName,
					index: indexPredicateName(target.index),
					status: 'rejected',
					comparison: 'raw',
					reason: rejection.reason,
				};
				outcomes.push(outcome);
				reportIndexPredicateCanonicalizationFailure(outcome, options);
			}
		}
		return { desired, database, indexPredicateOutcomes: outcomes };
	}

	for (const target of databaseTargets) {
		const canonical = await deparseWithCatalogSearchPath(adapter, (tx) =>
			deparseDatabaseIndexPredicate(
				tx,
				qualifiedRelationName(target.tableName, options),
				indexPredicateName(target.index),
			),
		);
		if (canonical === undefined) {
			throw new Error('PostgreSQL did not return a canonical index predicate.');
		}
		setCanonicalIndexPredicate(
			databasePredicates,
			target.tableName,
			target.index,
			canonical,
		);
		outcomes.push({
			side: 'database',
			table: target.tableName,
			index: indexPredicateName(target.index),
			status: 'canonicalised',
		});
	}

	return {
		desired: cloneModelWithCanonicalIndexPredicates(desired, desiredPredicates),
		database: cloneModelWithCanonicalIndexPredicates(
			database,
			databasePredicates,
		),
		indexPredicateOutcomes: outcomes,
	};
}

/** Adapter-level predicate round trip shared by live comparison and evidence. */
export async function canonicalizeIndexPredicate(
	adapter: PgsqlCanonicalizationScope,
	request: {
		readonly table: string;
		readonly predicate: string;
		readonly columns?: readonly TableIR['columns'][number][];
		/** Live columns used only to enrich incomplete desired column metadata. */
		readonly databaseColumns?: readonly TableIR['columns'][number][];
		/** Existing relation whose column context is faithful for evidence use. */
		readonly likeTable?: string;
		/** Desired and live tables used to project the migration's column changes. */
		readonly desiredTable?: TableIR;
		readonly databaseTable?: TableIR;
		readonly tempPrefix: string;
		readonly options?: CanonicalizationOptions;
	},
): Promise<EngineCanonicalExpression> {
	const requestedPredicate = request.predicate;
	if (requestedPredicate === undefined) {
		throw new Error(
			'Index predicate canonicalization requires a non-empty WHERE predicate.',
		);
	}
	validateCheckExpression(
		requestedPredicate,
		'canonicalized index WHERE predicate',
	);
	await adapter.executeRaw("SET LOCAL standard_conforming_strings TO 'on'");
	const tempTableName = `${request.tempPrefix}_table`;
	const tempIndexName = `${request.tempPrefix}_index`;
	const tempTable = quoteIdent(tempTableName, 'table');
	if (
		request.desiredTable !== undefined &&
		request.databaseTable !== undefined
	) {
		try {
			await createProjectedScratchRelation(adapter, {
				tempTable,
				desiredTable: request.desiredTable,
				databaseTable: request.databaseTable,
				liveRelation: qualifiedRelationName(request.table, request.options),
				options: request.options,
			});
		} catch (error) {
			throwIndexPredicateScratchRelationSetupFailure(error);
		}
	} else if (request.likeTable !== undefined) {
		try {
			await adapter.executeRaw(
				`CREATE TEMP TABLE ${tempTable} (LIKE ${request.likeTable}) ON COMMIT DROP`,
			);
		} catch (error) {
			throwIndexPredicateScratchRelationSetupFailure(error);
		}
	} else {
		if (request.columns === undefined) {
			throw new Error(
				'Index predicate canonicalization requires columns or a live scratch relation.',
			);
		}
		const naming = namingForOptions(request.options);
		const dbColumnsByName = new Map(
			(request.databaseColumns ?? []).map((column) => [column.name, column]),
		);
		const columns = request.columns.map((column) =>
			generateColumnDef(
				toScratchColumn(column, dbColumnsByName, naming),
				naming,
				request.options?.schemaName,
			),
		);
		try {
			await adapter.executeRaw(
				`CREATE TEMP TABLE ${tempTable} (${columns.join(', ')}) ON COMMIT DROP`,
			);
		} catch (error) {
			throwIndexPredicateScratchRelationSetupFailure(error);
		}
	}
	try {
		await adapter.executeRaw(
			`CREATE INDEX ${quoteIdent(tempIndexName, 'alias')} ON ${tempTable} ` +
				`((1)) WHERE ${requestedPredicate}`,
		);
	} catch (error) {
		throw markExpressionRejection(error, 'create_partial_index');
	}
	const rows = await deparseWithCatalogSearchPath(adapter, (tx) =>
		tx.executeRaw<{ predicate: string }>(
			`SELECT pg_catalog.pg_get_expr(ix.indpred, ix.indrelid, false) AS predicate
			   FROM pg_catalog.pg_index ix
			   JOIN pg_catalog.pg_class c ON c.oid = ix.indexrelid
			  WHERE ix.indrelid = $1::pg_catalog.regclass AND c.relname = $2`,
			[tempTableName, tempIndexName],
		),
	);
	const predicate = rows[0]?.predicate;
	if (typeof predicate !== 'string') {
		throw new Error('PostgreSQL did not return a canonical index predicate.');
	}
	return engineCanonicalExpression(predicate);
}

async function deparseDatabaseIndexPredicate(
	adapter: PgsqlCanonicalizationScope,
	relationName: string,
	indexName: string,
): Promise<EngineCanonicalExpression | undefined> {
	const rows = await adapter.executeRaw<{ predicate: string | null }>(
		`SELECT pg_catalog.pg_get_expr(ix.indpred, ix.indrelid, false) AS predicate
		   FROM pg_catalog.pg_index ix
		   JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid
		  WHERE ix.indrelid = $1::pg_catalog.regclass AND i.relname = $2`,
		[relationName, indexName],
	);
	return typeof rows[0]?.predicate === 'string'
		? engineCanonicalExpression(rows[0].predicate)
		: undefined;
}

/** Read an existing partial-index predicate under the canonical deparse path. */
export async function deparseIndexPredicate(
	adapter: PgsqlCanonicalizationScope,
	relationName: string,
	indexName: string,
	_options?: CanonicalizationOptions,
): Promise<EngineCanonicalExpression | undefined> {
	return deparseWithCatalogSearchPath(adapter, (tx) =>
		deparseDatabaseIndexPredicate(tx, relationName, indexName),
	);
}

type CanonicalColumnDefault =
	| {
			readonly side: 'desired' | 'database';
			readonly modelColumnName: string;
			readonly databaseColumnName: string;
			readonly desired?: EngineCanonicalExpression;
			readonly database?: EngineCanonicalExpression;
			readonly status: 'canonicalised';
	  }
	| {
			readonly side: 'desired' | 'database';
			readonly modelColumnName: string;
			readonly databaseColumnName: string;
			readonly status: 'unavailable' | 'rejected';
			readonly comparison: 'raw';
			readonly reason: unknown;
	  };

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
			createProjectedScratchRelation(tx, {
				tempTable,
				desiredTable: target.modelTable,
				databaseTable: target.dbTable,
				liveRelation: qualifiedRelationName(target.dbTableName, options),
				options,
			}),
		);
	} catch (error) {
		if (
			!options?.requireCanonicalization &&
			isScratchRelationSetupUnavailableError(error)
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
				comparison: 'raw',
				reason: error,
			};
		}
		throw error;
	}
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
		// An authored default that PostgreSQL rejects cannot run in the migration.
		// Unlike scratch infrastructure, this is never safe to compare as raw text.
		throw markExpressionRejection(error, 'alter_column_set_default');
	}

	const defaults = await deparseWithCatalogSearchPath(adapter, (tx) =>
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
		const outcome = fallbackColumnDefaultOutcome(
			'database',
			target.dbTableName,
			databaseColumnName,
			'unavailable',
			'raw',
			'PostgreSQL default disappeared before paired deparse',
		);
		reportUnavailableColumnDefault(outcome, options);
		return {
			side: 'database',
			modelColumnName: column.name,
			databaseColumnName,
			status: 'unavailable',
			comparison: 'raw',
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
			await pinCanonicalizationSettings(tx);
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
	const canonicalChecks = [...target.checks];

	try {
		if (target.dbTable === undefined) {
			await adapter.transaction((tx) =>
				createDesiredScratchRelation(tx, tempTable, target.modelTable, options),
			);
		} else {
			const databaseTable = target.dbTable;
			await adapter.transaction((tx) =>
				createProjectedScratchRelation(tx, {
					tempTable,
					desiredTable: target.modelTable,
					databaseTable,
					liveRelation: qualifiedRelationName(target.dbTableName, options),
					options,
				}),
			);
		}
	} catch (error) {
		if (
			!options?.requireCanonicalization &&
			isScratchRelationSetupUnavailableError(error)
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

	const rows = await deparseWithCatalogSearchPath(adapter, (tx) =>
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

function toScratchColumn(
	column: TableIR['columns'][number],
	dbColumnsByName: ReadonlyMap<string, TableIR['columns'][number]>,
	naming: NamingPlugin,
): TableIR['columns'][number] {
	const dbColumn = dbColumnsByName.get(naming.toDatabase(column.name));
	const dbOriginalDbType = dbColumn?.originalDbType;
	let typeColumn = column;
	if (
		!column.originalDbType?.trim() &&
		dbOriginalDbType?.trim() &&
		dbColumn !== undefined &&
		column.type === dbColumn.type
	) {
		const {
			originalDbType: _originalDbType,
			originalDbTypeSchema: _originalDbTypeSchema,
			originalDbTypeSchemaScope: _originalDbTypeSchemaScope,
			...desiredColumn
		} = column;
		// The database supplies only the precise type spelling the desired model
		// lacks. The scratch relation must otherwise reproduce the shape the
		// migration will produce.
		typeColumn = {
			...desiredColumn,
			originalDbType: dbOriginalDbType,
			...(dbColumn.originalDbTypeSchema === undefined
				? {}
				: { originalDbTypeSchema: dbColumn.originalDbTypeSchema }),
			...(dbColumn.originalDbTypeSchemaScope === undefined
				? {}
				: {
						originalDbTypeSchemaScope: dbColumn.originalDbTypeSchemaScope,
					}),
		};
	}
	const {
		// Scratch relations must not allocate sequences.
		autoIncrement: _autoIncrement,
		// Scratch relations must not allocate identity sequences.
		identity: _identity,
		// Defaults can reference sequences or functions unavailable in scratch scope.
		default: _default,
		// A scratch-only index cannot change the meaning of an expression.
		unique: _unique,
		...scratchColumn
	} = typeColumn;
	return { ...scratchColumn, name: column.name };
}

/**
 * Construct the final column context for an existing relation without asking
 * PostgreSQL to re-resolve its untouched types.  `LIKE` keeps catalog type OIDs,
 * collations, and NOT NULL exactly as they are on the live relation; the small
 * projection below mirrors only column operations the migration will emit.
 * Defaults are intentionally not copied and are never projected here: the
 * expression currently under proof is the sole SET DEFAULT operation.
 */
async function createProjectedScratchRelation(
	adapter: PgsqlCanonicalizationScope,
	request: {
		readonly tempTable: string;
		readonly desiredTable: TableIR;
		readonly databaseTable: TableIR;
		readonly liveRelation: string;
		readonly options: CanonicalizationOptions | undefined;
	},
): Promise<void> {
	await adapter.executeRaw(
		`CREATE TEMP TABLE ${request.tempTable} (LIKE ${request.liveRelation}) ON COMMIT DROP`,
	);

	const naming = namingForOptions(request.options);
	const desiredByDatabaseName = new Map(
		request.desiredTable.columns.map((column) => [
			naming.toDatabase(column.name),
			column,
		]),
	);
	const databaseByName = new Map(
		request.databaseTable.columns.map((column) => [column.name, column]),
	);

	for (const databaseColumn of request.databaseTable.columns) {
		if (desiredByDatabaseName.has(databaseColumn.name)) continue;
		await adapter.executeRaw(
			`ALTER TABLE ${request.tempTable} DROP COLUMN ${quoteIdent(databaseColumn.name, 'column')}`,
		);
	}

	for (const desiredColumn of request.desiredTable.columns) {
		const databaseName = naming.toDatabase(desiredColumn.name);
		const databaseColumn = databaseByName.get(databaseName);
		if (databaseColumn === undefined) {
			await adapter.executeRaw(
				`ALTER TABLE ${request.tempTable} ADD COLUMN ${generateColumnDef(
					toScratchColumn(desiredColumn, databaseByName, naming),
					naming,
					request.options?.schemaName,
				)}`,
			);
			continue;
		}

		const typeChanged = scratchColumnTypeChanged(desiredColumn, databaseColumn);
		const collationChanged =
			(desiredColumn.collation ?? null) !== (databaseColumn.collation ?? null);
		if (typeChanged || collationChanged) {
			const collation = desiredColumn.collation
				? ` COLLATE ${quoteCollation(desiredColumn.collation)}`
				: '';
			await adapter.executeRaw(
				`ALTER TABLE ${request.tempTable} ALTER COLUMN ${quoteIdent(databaseName, 'column')} TYPE ${mapColumnType(desiredColumn, request.options?.schemaName)}${collation}`,
			);
		}
		if (desiredColumn.nullable !== databaseColumn.nullable) {
			await adapter.executeRaw(
				`ALTER TABLE ${request.tempTable} ALTER COLUMN ${quoteIdent(databaseName, 'column')} ${desiredColumn.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'}`,
			);
		}
	}
}

/** Desired-shape construction remains necessary only when no live relation exists. */
async function createDesiredScratchRelation(
	adapter: PgsqlCanonicalizationScope,
	tempTable: string,
	table: TableIR,
	options: CanonicalizationOptions | undefined,
): Promise<void> {
	const naming = namingForOptions(options);
	const columns = table.columns.map((column) =>
		generateColumnDef(
			toScratchColumn(column, new Map(), naming),
			naming,
			options?.schemaName,
		),
	);
	await adapter.executeRaw(
		`CREATE TEMP TABLE ${tempTable} (${columns.join(', ')}) ON COMMIT DROP`,
	);
}

function scratchColumnTypeChanged(
	desired: TableIR['columns'][number],
	database: TableIR['columns'][number],
): boolean {
	const desiredIdentity = columnDbTypeSchemaIdentity(desired);
	const databaseIdentity = columnDbTypeSchemaIdentity(database);
	if (
		desired.originalDbType !== undefined &&
		database.originalDbType !== undefined
	) {
		return (
			!dbTypesEqual(
				stripDbTypeSchema(desired.originalDbType),
				stripDbTypeSchema(database.originalDbType),
			) ||
			(desiredIdentity !== undefined &&
				databaseIdentity !== undefined &&
				desiredIdentity !== databaseIdentity)
		);
	}
	return !scratchTypesEquivalent(desired.type, database.type);
}

function scratchTypesEquivalent(desired: string, database: string): boolean {
	const normalize = (type: string): string =>
		type === 'timestamp' || type === 'datetime' ? 'timestamptz' : type;
	return normalize(desired) === normalize(database);
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
		caps: options?.dialectCapabilities,
		fkAutoIndex: false,
		includeDropStatements: false,
	};
	for (const statement of generateEnumTypesPhase(context)) {
		try {
			await adapter.transaction((tx) => tx.executeRaw(statement));
		} catch (error) {
			return new PlannedSchemaStagingError('CREATE TYPE', error);
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

/**
 * Install desired sequences that phase 5 of the migration will create before
 * phase-8 expressions are bound. This is rollback-only staging: extensions,
 * destructive operations, and enum-value additions are deliberately excluded.
 * The real qualified name is required for a qualified reference to resolve; it
 * takes a catalogue lock for this scope's duration, so concurrent planners may
 * time out while staging the same absent sequence.
 */
async function createMissingDesiredSequences(
	adapter: PgsqlCanonicalizationScope,
	desired: ModelIR,
	dbModel: ModelIR,
	options: CanonicalizationOptions | undefined,
): Promise<unknown | undefined> {
	const missingSequences = missingDesiredSequences(desired, dbModel);
	if (missingSequences.size === 0) return undefined;
	const sequenceModel = new ModelIRImpl(
		new Map(),
		new Map(),
		undefined,
		undefined,
		missingSequences,
	);
	const context: PhaseContext = {
		schema: sequenceModel,
		tables: [],
		schemaName: options?.schemaName,
		naming: namingForOptions(options),
		caps: options?.dialectCapabilities,
		fkAutoIndex: false,
		includeDropStatements: false,
	};
	for (const statement of generateSequencesPhase(context)) {
		try {
			await adapter.transaction((tx) => tx.executeRaw(statement));
		} catch (error) {
			return new PlannedSchemaStagingError('CREATE SEQUENCE', error);
		}
	}
	return undefined;
}

function missingDesiredSequences(
	desired: ModelIR,
	dbModel: ModelIR,
): Map<string, SequenceIR> {
	const missing = new Map<string, SequenceIR>();
	for (const [name, sequence] of desired.sequences ?? []) {
		if (!dbModel.sequences?.has(name)) missing.set(name, sequence);
	}
	return missing;
}

async function pinCanonicalizationSettings(
	adapter: PgsqlCanonicalizationScope,
): Promise<void> {
	await adapter.executeRaw("SET LOCAL standard_conforming_strings TO 'on'");
}

/**
 * PostgreSQL's deparsers omit qualification for objects visible through the
 * current search path. Canonical expressions are later emitted by a different
 * session, so render them under `pg_catalog` only and restore the session's
 * exact setting before any further scratch DDL.
 *
 * Temporary relations remain addressable while this path is active: PostgreSQL
 * searches its temporary schema first for relation lookup even when `pg_temp`
 * is not listed explicitly.
 */
async function deparseWithCatalogSearchPath<T>(
	adapter: PgsqlCanonicalizationScope,
	deparse: (adapter: PgsqlCanonicalizationScope) => Promise<T>,
): Promise<T> {
	const rows = await adapter.executeRaw<{ search_path: string }>(
		"SELECT pg_catalog.current_setting('search_path') AS search_path",
	);
	const searchPath = rows[0]?.search_path;
	if (typeof searchPath !== 'string') {
		throw new Error('PostgreSQL did not return the session search path.');
	}
	await adapter.executeRaw('SET LOCAL search_path TO pg_catalog');
	try {
		const result = await adapter.transaction(deparse);
		await restoreSearchPath(adapter, searchPath);
		return result;
	} catch (error) {
		try {
			await restoreSearchPath(adapter, searchPath);
		} catch (restoreError) {
			throw new AggregateError(
				[error, restoreError],
				'PostgreSQL expression deparse failed and search_path restoration also failed',
			);
		}
		throw error;
	}
}

async function restoreSearchPath(
	adapter: PgsqlCanonicalizationScope,
	searchPath: string,
): Promise<void> {
	await adapter.executeRaw(
		"SELECT pg_catalog.set_config('search_path', $1, true)",
		[searchPath],
	);
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
		comparison: 'raw',
	};
	if (options?.onWarning) {
		options.onWarning(warning);
	} else {
		console.warn(`Warning: ${message}`);
	}
}

function reportUnavailableColumnDefault(
	outcome: ColumnDefaultFallbackOutcome,
	options: CanonicalizeExpressionSurfacesOptions | undefined,
): void {
	const cause = outcome.reason;
	const refused = options?.requireCanonicalization === true;
	const comparisonMessage =
		outcome.comparison === 'unpaired'
			? refused
				? 'with PostgreSQL because it has no matching default on the opposite model side; strict canonicalization cannot compare this column. '
				: 'with PostgreSQL because it has no matching default on the opposite model side; comparison is unavailable for this column. '
			: refused
				? 'with PostgreSQL; strict canonicalization refused raw comparison for this column. '
				: 'with PostgreSQL; falling back to verbatim raw comparison for this column. ';
	const message =
		'Could not canonicalize one column default ' +
		comparisonMessage +
		'Inspect the warning table and name fields for its identity. ' +
		`Reason: ${errorMessage(cause)}`;
	const warning: ColumnDefaultCanonicalizationWarning = {
		table: outcome.table,
		kind: 'column_default',
		name: outcome.column,
		message,
		cause,
		outcome: refused ? 'refused' : 'unavailable',
		comparison: outcome.comparison,
		side: outcome.side,
	};
	if (options?.onWarning) {
		options.onWarning(warning);
	} else {
		console.warn(`Warning: ${message}`);
	}
}

function reportIndexPredicateCanonicalizationFailure(
	outcome: Extract<
		IndexPredicateCanonicalizationOutcome,
		{ readonly status: 'unavailable' | 'rejected' }
	>,
	options: CanonicalizeExpressionSurfacesOptions | undefined,
): void {
	const refused = options?.requireCanonicalization === true;
	const message =
		'Could not canonicalize one partial-index predicate with PostgreSQL; ' +
		(outcome.status === 'rejected'
			? 'the live migration is refused. '
			: refused
				? 'strict canonicalization refused raw comparison. '
				: 'the live comparison restarts from both raw models. ') +
		'Inspect the warning table and name fields for its identity. ' +
		`Reason: ${errorMessage(outcome.reason)}`;
	const warning: IndexPredicateCanonicalizationWarning = {
		table: outcome.table,
		kind: 'index_predicate',
		name: outcome.index,
		message,
		cause: outcome.reason,
		outcome: refused ? 'refused' : outcome.status,
		comparison: outcome.comparison,
		side: outcome.side,
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
	if (error instanceof IndexPredicateCanonicalizationUnavailableError) {
		return errorMessage(error.cause);
	}
	if (error instanceof PlannedSchemaStagingError) {
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
					(code.startsWith('42') &&
						(code !== '42501' || statement === 'create_partial_index')) ||
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

function cloneModelWithCanonicalIndexPredicates(
	model: ModelIR,
	canonicalPredicatesByTable: ReadonlyMap<
		string,
		ReadonlyMap<IndexIR, EngineCanonicalExpression>
	>,
): ModelIR {
	const tables = new Map<string, TableIR>();
	for (const [key, table] of model.tables) {
		const predicates = canonicalPredicatesByTable.get(key);
		tables.set(
			key,
			predicates === undefined
				? table
				: {
						...table,
						indexes: table.indexes.map((index) => {
							const predicate = predicates.get(index);
							return predicate === undefined
								? index
								: markEngineCanonicalIndex({ ...index, where: predicate });
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
