/**
 * PostgreSQL CHECK constraint expression canonicalisation.
 *
 * CHECK scratch tables intentionally use only column names and PostgreSQL types.
 * Desired column types are preferred; existing database column types are used
 * when the desired column omits `originalDbType` and the base type is unchanged.
 * Defaults, identity, uniqueness, nullability, and other table-shape clauses are
 * not needed for `pg_get_constraintdef()` rendering and must not be allowed to
 * block expression canonicalisation.
 *
 * Deliberate bound: a CHECK that references an enum value being added to an
 * existing enum by the same migration cannot produce an executable PostgreSQL
 * migration in dbsp's current single-transaction runner. PostgreSQL forbids
 * using an enum value added by `ALTER TYPE ... ADD VALUE` in the same
 * transaction that added it. The live diff layer refuses that combination with
 * an actionable error instead of letting this helper's non-strict fallback emit
 * a migration that would fail at apply time.
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
import { quoteIdent } from './ddl/phases/utils.js';
import { mapColumnType } from './ddl/type-mapping.js';
import {
	getNamingPluginForDbCasing,
	identityNaming,
	type NamingPlugin,
} from './naming-plugin.js';
import { validateCheckExpression } from './validate.js';

export interface CheckConstraintCanonicalizationWarning {
	readonly table: string;
	readonly constraint: string;
	readonly message: string;
	readonly cause: unknown;
}

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
}

interface CheckConstraintTarget {
	readonly modelKey: string;
	readonly modelTable: TableIR;
	readonly dbTable?: TableIR;
	readonly dbTableName: string;
	readonly checks: readonly CheckConstraintIR[];
	readonly dbCheckNames: readonly string[];
}

type PgsqlCanonicalizationScope = Pick<Adapter, 'executeRaw' | 'transaction'>;

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

export class CheckConstraintCanonicalizationError extends Error {
	constructor(
		readonly table: string,
		readonly constraints: readonly string[],
		readonly cause: unknown,
	) {
		super(
			`Could not canonicalize CHECK constraint expression(s) for table "${table}" ` +
				`(${constraints.map((name) => `"${name}"`).join(', ')}), and strict ` +
				`expression canonicalization was requested: ${errorMessage(cause)}`,
		);
		this.name = 'CheckConstraintCanonicalizationError';
	}
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
	options?: CanonicalizeCheckConstraintsOptions,
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

/**
 * Canonicalise PostgreSQL CHECK constraint expressions in a desired model.
 *
 * CHECK constraints are canonicalised by creating a transaction-local temp table
 * with the desired table's column definitions (borrowing live database type
 * detail for existing columns when the desired model omits it), adding the
 * authored CHECK constraints to that temp table, and reading PostgreSQL's
 * `pg_get_constraintdef()` rendering. The caller must provide a rollback-only
 * scratch scope; that rollback is cleanup for dbsp-created scratch objects, not
 * a sandbox for arbitrary session effects.
 * Missing desired enum types are also created inside that scratch scope before
 * scratch tables.
 * Scratch columns include only names and types; defaults, identity, uniqueness,
 * nullability, and other table-shape clauses are deliberately omitted.
 *
 * The returned expression is the full `CHECK (...)` clause. Bare authored
 * predicates are accepted and become full CHECK clauses.
 *
 * PostgreSQL does not allow an enum value added by `ALTER TYPE ... ADD VALUE`
 * to be used in the same transaction that added it. Because dbsp currently
 * emits and applies each migration in one transaction, the live diff layer
 * deliberately refuses CHECK constraints that fall back while the same diff adds
 * a plausibly referenced enum value. Splitting that into multiple transaction
 * phases is a separate migration-runner feature.
 *
 * This does not canonicalise partial-index predicates or index expressions, so
 * those surfaces may still compare by raw text in non-strict diffs.
 */
export async function canonicalizeCheckConstraints(
	adapter: PgsqlCanonicalizationScope,
	desired: ModelIR,
	dbModel: ModelIR,
	options?: CanonicalizeCheckConstraintsOptions,
): Promise<ModelIR> {
	const targets = collectCheckConstraintTargets(desired, dbModel, options);
	if (targets.length === 0) {
		return desired;
	}

	const canonicalChecksByTable = new Map<
		string,
		readonly CheckConstraintIR[]
	>();
	const names = createCheckCanonicalizationNameScope();
	let workError: unknown;

	try {
		// The scratch work is best-effort: a role that may not create temp tables,
		// or an expression PostgreSQL refuses, degrades to raw comparison.
		try {
			await createMissingDesiredEnumTypes(adapter, desired, dbModel, options);
			for (let i = 0; i < targets.length; i++) {
				const target = targets[i]!;
				const canonicalChecks = await canonicalizeTableChecksBestEffort(
					adapter,
					target,
					i,
					options,
					names,
				);
				if (canonicalChecks !== undefined) {
					canonicalChecksByTable.set(target.modelKey, canonicalChecks);
				}
			}
		} catch (error) {
			workError = error;
		}
	} catch (error) {
		workError = error;
	}

	if (workError !== undefined) {
		if (options?.requireCanonicalization) {
			throw workError;
		}
		for (const target of targets) {
			if (!canonicalChecksByTable.has(target.modelKey)) {
				reportCanonicalizationFailure(target, workError, options);
			}
		}
	}

	return cloneModelWithCanonicalChecks(desired, canonicalChecksByTable);
}

function collectCheckConstraintTargets(
	desired: ModelIR,
	dbModel: ModelIR,
	options: CanonicalizeCheckConstraintsOptions | undefined,
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
	options: CanonicalizeCheckConstraintsOptions | undefined,
	names: CheckCanonicalizationNameScope,
): Promise<readonly CheckConstraintIR[] | undefined> {
	try {
		return await adapter.transaction((tx) =>
			canonicalizeTableChecks(tx, target, targetIndex, options, names),
		);
	} catch (error) {
		if (error instanceof CheckConstraintCanonicalizationError) {
			throw error;
		}
		if (options?.requireCanonicalization) {
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
	options: CanonicalizeCheckConstraintsOptions | undefined,
	names: CheckCanonicalizationNameScope,
): Promise<readonly CheckConstraintIR[]> {
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

	await adapter.executeRaw(
		`CREATE TEMP TABLE ${tempTable} (${columnDefs.join(', ')}) ON COMMIT DROP`,
	);

	const tempConstraintNamesByIndex = new Map<number, string>();
	const canonicalChecks = [...target.checks];
	for (let i = 0; i < target.checks.length; i++) {
		const check = target.checks[i]!;
		const tempConstraintName = `${names.tempPrefix}_${targetIndex}_${i}`;
		try {
			await adapter.transaction(async (tx) => {
				const expression = renderCheckConstraintClause(check);
				validateCheckExpression(expression, 'canonicalized check constraint');
				await tx.executeRaw(
					`ALTER TABLE ${tempTable} ADD CONSTRAINT ${quoteIdent(tempConstraintName, 'alias')} ${expression}`,
				);
			});
			tempConstraintNamesByIndex.set(i, tempConstraintName);
		} catch (error) {
			if (options?.requireCanonicalization) {
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
		return canonicalChecks;
	}

	const rows = await adapter.executeRaw<{
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
	);

	const canonicalByTempName = new Map(
		rows.map((row) => [row.name, stripNotValidSuffix(row.expression)]),
	);

	for (const [i, tempConstraintName] of tempConstraintNamesByIndex) {
		const check = target.checks[i]!;
		const expression = canonicalByTempName.get(tempConstraintName);
		if (expression === undefined) {
			const error = new Error(
				`PostgreSQL did not return canonical CHECK expression for "${target.modelTable.name}" constraint "${check.name}"`,
			);
			if (options?.requireCanonicalization) {
				throw new CheckConstraintCanonicalizationError(
					target.dbTableName,
					[target.dbCheckNames[i]!],
					error,
				);
			}
			reportConstraintCanonicalizationFailure(target, i, error, options);
			continue;
		}
		const notValid = isCheckConstraintNotValid(check);
		canonicalChecks[i] = {
			...check,
			expression,
			...(notValid ? { notValid: true } : {}),
		};
	}

	return canonicalChecks;
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

async function createMissingDesiredEnumTypes(
	adapter: PgsqlCanonicalizationScope,
	desired: ModelIR,
	dbModel: ModelIR,
	options: CanonicalizeCheckConstraintsOptions | undefined,
): Promise<void> {
	const missingEnums = missingDesiredEnums(desired, dbModel);
	if (missingEnums.size === 0) return;

	const naming = namingForOptions(options);
	const enumModel = new ModelIRImpl(new Map(), new Map(), missingEnums);
	const phaseContext: PhaseContext = {
		schema: enumModel,
		tables: [],
		schemaName: options?.schemaName,
		naming,
		caps: undefined,
		fkAutoIndex: false,
		includeDropStatements: false,
	};
	const statements = generateEnumTypesPhase(phaseContext);
	for (const statement of statements) {
		try {
			await adapter.transaction(async (tx) => {
				await tx.executeRaw(statement);
			});
		} catch {
			// Missing enum scratch DDL is opportunistic. If PostgreSQL refuses one
			// statement, CHECK canonicalization can still fall back per constraint.
		}
	}
}

function createCheckCanonicalizationNameScope(): CheckCanonicalizationNameScope {
	const callId = randomUUID().replace(/-/gu, '').slice(0, 12);
	return {
		tempPrefix: `_dbsp_check_canon_${callId}`,
	};
}

function missingDesiredEnums(
	desired: ModelIR,
	dbModel: ModelIR,
): Map<string, EnumIR> {
	const desiredEnums = desired.enums ?? new Map();
	const dbEnums = dbModel.enums ?? new Map();
	const missing = new Map<string, EnumIR>();
	for (const [name, enumDef] of desiredEnums) {
		if (!dbEnums.has(name)) {
			missing.set(name, enumDef);
		}
	}
	return missing;
}

function namingForOptions(
	options: CanonicalizeCheckConstraintsOptions | undefined,
): NamingPlugin {
	return options?.dbCasing !== undefined
		? getNamingPluginForDbCasing(options.dbCasing)
		: identityNaming;
}

function reportCanonicalizationFailure(
	target: CheckConstraintTarget,
	cause: unknown,
	options: CanonicalizeCheckConstraintsOptions | undefined,
): void {
	for (let i = 0; i < target.checks.length; i++) {
		reportConstraintCanonicalizationFailure(target, i, cause, options);
	}
}

function reportConstraintCanonicalizationFailure(
	target: CheckConstraintTarget,
	checkIndex: number,
	cause: unknown,
	options: CanonicalizeCheckConstraintsOptions | undefined,
): void {
	const dbCheckName = target.dbCheckNames[checkIndex]!;
	const message =
		`Could not canonicalize CHECK constraint "${target.dbTableName}"."${dbCheckName}" ` +
		`with PostgreSQL; falling back to best-effort raw string comparison. ` +
		`Reason: ${errorMessage(cause)}`;
	const warning: CheckConstraintCanonicalizationWarning = {
		table: target.dbTableName,
		constraint: dbCheckName,
		message,
		cause,
	};
	if (options?.onWarning) {
		options.onWarning(warning);
	} else {
		console.warn(`Warning: ${message}`);
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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
