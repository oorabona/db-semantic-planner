/**
 * PostgreSQL CHECK constraint expression canonicalisation.
 *
 * CHECK scratch tables intentionally use only the desired column names and
 * PostgreSQL types. Defaults, identity, uniqueness, nullability, and other
 * table-shape clauses are not needed for `pg_get_constraintdef()` rendering and
 * must not be allowed to block expression canonicalisation.
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
	CheckConstraintIR,
	DbCasing,
	EnumIR,
	ModelIR,
	TableIR,
} from '@dbsp/types';
import type { Pool, PoolClient } from 'pg';
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
	readonly dbTableName: string;
	readonly checks: readonly CheckConstraintIR[];
	readonly dbCheckNames: readonly string[];
}

type PgsqlCanonicalizationConnection = Pool | PoolClient;

interface CheckCanonicalizationNameScope {
	readonly savepointPrefix: string;
	readonly tempPrefix: string;
}

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
 * Canonicalise PostgreSQL CHECK constraint expressions in a desired model.
 *
 * CHECK constraints are canonicalised by creating a transaction-local temp table
 * with the desired table's column definitions, adding the authored CHECK
 * constraints to that temp table, reading PostgreSQL's `pg_get_constraintdef()`
 * rendering, then rolling the transaction back. Missing desired enum types are
 * also created inside the same rolled-back transaction before scratch tables.
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
	connection: PgsqlCanonicalizationConnection,
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
	const ownsClient = isPool(connection);
	const client = ownsClient ? await connection.connect() : connection;
	const names = createCheckCanonicalizationNameScope();
	const rootSavepoint = `${names.savepointPrefix}_root`;
	let rootSavepointOpen = false;
	let releaseError: Error | undefined;
	try {
		if (ownsClient) {
			await client.query('BEGIN');
		} else {
			await client.query(`SAVEPOINT ${rootSavepoint}`);
			rootSavepointOpen = true;
		}
		await createMissingDesiredEnumTypes(
			client,
			desired,
			dbModel,
			options,
			names,
		);
		for (let i = 0; i < targets.length; i++) {
			const target = targets[i]!;
			const canonicalChecks = await canonicalizeTableChecksBestEffort(
				client,
				target,
				i,
				options,
				names,
			);
			if (canonicalChecks !== undefined) {
				canonicalChecksByTable.set(target.modelKey, canonicalChecks);
			}
		}
		if (ownsClient) {
			try {
				await client.query('ROLLBACK');
			} catch (rollbackError) {
				releaseError = toError(rollbackError);
				throw rollbackError;
			}
		} else {
			await client.query(`ROLLBACK TO SAVEPOINT ${rootSavepoint}`);
			await client.query(`RELEASE SAVEPOINT ${rootSavepoint}`);
			rootSavepointOpen = false;
		}
	} catch (error) {
		if (ownsClient && releaseError === undefined) {
			try {
				await client.query('ROLLBACK');
			} catch (rollbackError) {
				releaseError = toError(rollbackError);
			}
		} else if (!ownsClient && rootSavepointOpen) {
			try {
				await client.query(`ROLLBACK TO SAVEPOINT ${rootSavepoint}`);
				await client.query(`RELEASE SAVEPOINT ${rootSavepoint}`);
				rootSavepointOpen = false;
			} catch (cleanupError) {
				throw cleanupError;
			}
		}
		if (options?.requireCanonicalization) {
			throw error;
		}
		for (const target of targets) {
			if (!canonicalChecksByTable.has(target.modelKey)) {
				reportCanonicalizationFailure(target, error, options);
			}
		}
	} finally {
		if (ownsClient) {
			if (releaseError !== undefined) {
				client.release(releaseError);
			} else {
				client.release();
			}
		}
	}

	return cloneModelWithCanonicalChecks(desired, canonicalChecksByTable);
}

function collectCheckConstraintTargets(
	desired: ModelIR,
	_dbModel: ModelIR,
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

		targets.push({
			modelKey,
			modelTable: table,
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
	client: PoolClient,
	target: CheckConstraintTarget,
	targetIndex: number,
	options: CanonicalizeCheckConstraintsOptions | undefined,
	names: CheckCanonicalizationNameScope,
): Promise<readonly CheckConstraintIR[] | undefined> {
	const savepoint = `${names.savepointPrefix}_sp_${targetIndex}`;
	await client.query(`SAVEPOINT ${savepoint}`);
	try {
		const canonical = await canonicalizeTableChecks(
			client,
			target,
			targetIndex,
			options,
			names,
		);
		await client.query(`RELEASE SAVEPOINT ${savepoint}`);
		return canonical;
	} catch (error) {
		await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
		await client.query(`RELEASE SAVEPOINT ${savepoint}`);
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
	client: PoolClient,
	target: CheckConstraintTarget,
	targetIndex: number,
	options: CanonicalizeCheckConstraintsOptions | undefined,
	names: CheckCanonicalizationNameScope,
): Promise<readonly CheckConstraintIR[]> {
	const tempTableName = `${names.tempPrefix}_${targetIndex}`;
	const tempTable = quoteIdent(tempTableName, 'table');
	const naming = namingForOptions(options);
	const targetSchema =
		options?.schemaName !== undefined
			? naming.toDatabase(options.schemaName)
			: undefined;
	const columnDefs = target.modelTable.columns.map((column) =>
		generateScratchColumnDef(column, naming, targetSchema),
	);

	await client.query(
		`CREATE TEMP TABLE ${tempTable} (${columnDefs.join(', ')}) ON COMMIT DROP`,
	);

	const tempConstraintNames: string[] = [];
	for (let i = 0; i < target.checks.length; i++) {
		const check = target.checks[i]!;
		const tempConstraintName = `${names.tempPrefix}_${targetIndex}_${i}`;
		tempConstraintNames.push(tempConstraintName);
		const expression = renderCheckConstraintClause(check);
		validateCheckExpression(expression, 'canonicalized check constraint');
		await client.query(
			`ALTER TABLE ${tempTable} ADD CONSTRAINT ${quoteIdent(tempConstraintName, 'alias')} ${expression}`,
		);
	}

	const result = await client.query<{
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
		result.rows.map((row) => [row.name, stripNotValidSuffix(row.expression)]),
	);

	return target.checks.map((check, i) => {
		const tempConstraintName = tempConstraintNames[i]!;
		const expression = canonicalByTempName.get(tempConstraintName);
		if (expression === undefined) {
			throw new Error(
				`PostgreSQL did not return canonical CHECK expression for "${target.modelTable.name}" constraint "${check.name}"`,
			);
		}
		const notValid = isCheckConstraintNotValid(check);
		return {
			...check,
			expression,
			...(notValid ? { notValid: true } : {}),
		};
	});
}

function generateScratchColumnDef(
	column: TableIR['columns'][number],
	naming: NamingPlugin,
	targetSchema: string | undefined,
): string {
	const typeColumn =
		column.autoIncrement === true
			? { ...column, autoIncrement: false }
			: column;
	return `${quoteIdent(naming.toDatabase(column.name), 'column')} ${mapColumnType(typeColumn, targetSchema)}`;
}

async function createMissingDesiredEnumTypes(
	client: PoolClient,
	desired: ModelIR,
	dbModel: ModelIR,
	options: CanonicalizeCheckConstraintsOptions | undefined,
	names: CheckCanonicalizationNameScope,
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
	for (let i = 0; i < statements.length; i++) {
		const savepoint = `${names.savepointPrefix}_enum_${i}`;
		await client.query(`SAVEPOINT ${savepoint}`);
		try {
			await client.query(statements[i]!);
			await client.query(`RELEASE SAVEPOINT ${savepoint}`);
		} catch {
			await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
			await client.query(`RELEASE SAVEPOINT ${savepoint}`);
		}
	}
}

function createCheckCanonicalizationNameScope(): CheckCanonicalizationNameScope {
	const callId = randomUUID().replace(/-/gu, '').slice(0, 12);
	return {
		savepointPrefix: `dbsp_check_canon_${callId}`,
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
		const dbCheckName = target.dbCheckNames[i]!;
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
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function isPool(
	connection: PgsqlCanonicalizationConnection,
): connection is Pool {
	return typeof (connection as { connect?: unknown }).connect === 'function';
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
