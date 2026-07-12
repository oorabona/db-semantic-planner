import type { CheckConstraintIR, EnumIR, ModelIR, TableIR } from '@dbsp/types';
import type { Pool, PoolClient } from 'pg';
import { enumReferenceKind } from '../db-type.js';
import {
	type CanonicalizeCheckConstraintsOptions,
	type CheckConstraintCanonicalizationWarning,
	canonicalizeCheckConstraints,
} from '../expression-canonicalizer.js';
import { type IntrospectionOptions, introspect } from '../introspection.js';
import { getNamingPluginForDbCasing } from '../naming-plugin.js';
import {
	type CompareSchemataOptions,
	collectExpressionSurfaces,
	compareSchemata,
	ExpressionCanonicalizationUnavailableError,
	type SchemaChange,
	type SchemaDiff,
} from './schema-diff.js';

export interface ComparePgsqlDatabaseSchemaOptions
	extends CompareSchemataOptions,
		IntrospectionOptions {
	/**
	 * Whether to canonicalise PostgreSQL CHECK constraint expressions before
	 * comparing. Defaults to `true`. Set to `false` only for compatibility with
	 * legacy raw-string live diffs.
	 *
	 * Live canonicalisation creates temporary scratch tables and missing desired
	 * enum types inside a transaction that is always rolled back. The database
	 * role needs permission to create temporary tables, and enum-dependent checks
	 * may need permission to create the pending enum type. If PostgreSQL refuses
	 * that scratch DDL, non-strict mode warns and falls back to best-effort raw
	 * string comparison for the affected CHECK constraints.
	 */
	readonly canonicalizeExpressions?: boolean;
	/**
	 * Receives live CHECK canonicalisation warnings. Defaults to console.warn.
	 */
	readonly onWarning?: (message: string) => void;
	/**
	 * Diff that the caller just applied before this live re-diff. Used only when
	 * CHECK expressions are compared by raw text to fail loudly if the exact same
	 * expression-surface drift appears again after re-introspection.
	 */
	readonly previouslyAppliedDiff?: SchemaDiff;
}

export class NonConvergentSchemaDiffError extends Error {
	constructor(
		public readonly table: string,
		public readonly constraint: string,
		public readonly desiredExpression: string,
		public readonly databaseExpression: string,
	) {
		super(
			`Non-convergent CHECK constraint diff for "${table}"."${constraint}": ` +
				'the same expression drift was reported after applying the previous diff. ' +
				`Desired expression: ${desiredExpression}. Database expression: ${databaseExpression}.`,
		);
		this.name = 'NonConvergentSchemaDiffError';
	}
}

export class CheckConstraintNewEnumValueError extends Error {
	constructor(
		public readonly table: string,
		public readonly constraint: string,
		public readonly enumName: string,
		public readonly value: string,
	) {
		super(
			`CHECK constraint "${table}"."${constraint}" references enum value ` +
				`"${value}" for enum "${enumName}", but this migration also adds ` +
				'that enum value. PostgreSQL cannot use a new enum value in the ' +
				'transaction that adds it. Apply the enum change on its own first, ' +
				'then add or update the constraint.',
		);
		this.name = 'CheckConstraintNewEnumValueError';
	}
}

/**
 * Live PostgreSQL schema diff: introspect, canonicalise desired CHECK
 * constraint expressions through PostgreSQL, then call the pure synchronous
 * schema comparator.
 *
 * If CHECK canonicalisation falls back while the same diff adds a plausibly
 * referenced enum value, the diff is refused. dbsp currently applies each
 * migration in one transaction, and PostgreSQL forbids using a newly added enum
 * value in that same transaction; emitting the CHECK would produce a migration
 * that cannot run. Apply the enum addition by itself first, then add or update
 * the CHECK constraint in a later migration.
 *
 * Partial-index predicates and index expressions are intentionally not
 * canonicalised here; non-strict diffs compare them by raw string, and strict
 * diffs reject them.
 */
export async function comparePgsqlDatabaseSchema(
	pool: Pool | PoolClient,
	desired: ModelIR,
	options?: ComparePgsqlDatabaseSchemaOptions,
): Promise<SchemaDiff> {
	const dbModel = await introspect(pool, toIntrospectionOptions(options));
	const useCanonicalizer = options?.canonicalizeExpressions ?? true;
	const rawCheckExpressionSurfaces = new Set<string>();
	const desiredForCompare = useCanonicalizer
		? await canonicalizeCheckConstraints(
				pool,
				desired,
				dbModel,
				toCanonicalizerOptions(options, rawCheckExpressionSurfaces),
			)
		: desired;
	if (useCanonicalizer && options?.requireExpressionCanonicalization) {
		assertNoUncanonicalizedLiveExpressionSurfaces(desiredForCompare, dbModel);
	}
	const diff = compareSchemata(
		desiredForCompare,
		dbModel,
		toCompareOptions(options, useCanonicalizer),
	);

	if (useCanonicalizer && rawCheckExpressionSurfaces.size > 0) {
		assertNoCheckFallbackUsesAddedEnumValue(
			diff,
			desiredForCompare,
			dbModel,
			rawCheckExpressionSurfaces,
			options,
		);
	}

	if (options?.previouslyAppliedDiff !== undefined) {
		if (!useCanonicalizer) {
			assertNoRepeatedExpressionSurfaceDrift(
				options.previouslyAppliedDiff,
				diff,
			);
		} else if (rawCheckExpressionSurfaces.size > 0) {
			assertNoRepeatedExpressionSurfaceDrift(
				options.previouslyAppliedDiff,
				diff,
				rawCheckExpressionSurfaces,
			);
		}
	}

	return diff;
}

function assertNoUncanonicalizedLiveExpressionSurfaces(
	desired: ModelIR,
	dbModel: ModelIR,
): void {
	const surfaces = [
		...collectExpressionSurfaces('schema', desired, {
			includeCheckConstraints: false,
		}),
		...collectExpressionSurfaces('database', dbModel, {
			includeCheckConstraints: false,
		}),
	];
	if (surfaces.length > 0) {
		throw new ExpressionCanonicalizationUnavailableError(surfaces);
	}
}

export function assertNoRepeatedExpressionSurfaceDrift(
	previouslyAppliedDiff: SchemaDiff,
	currentDiff: SchemaDiff,
	rawCheckExpressionSurfaces?: ReadonlySet<string>,
): void {
	const previousDrifts = collectCheckExpressionDrifts(previouslyAppliedDiff);
	if (previousDrifts.size === 0) return;

	for (const [key, current] of collectCheckExpressionDrifts(currentDiff)) {
		if (
			rawCheckExpressionSurfaces !== undefined &&
			!rawCheckExpressionSurfaces.has(key)
		) {
			continue;
		}
		const previous = previousDrifts.get(key);
		if (
			previous !== undefined &&
			previous.desiredExpression === current.desiredExpression &&
			previous.databaseExpression === current.databaseExpression
		) {
			throw new NonConvergentSchemaDiffError(
				current.table,
				current.constraint,
				current.desiredExpression,
				current.databaseExpression,
			);
		}
	}
}

interface CheckExpressionDrift {
	readonly table: string;
	readonly constraint: string;
	readonly desiredExpression: string;
	readonly databaseExpression: string;
}

function collectCheckExpressionDrifts(
	diff: SchemaDiff,
): Map<string, CheckExpressionDrift> {
	const dropped = new Map<string, string>();
	const drifts = new Map<string, CheckExpressionDrift>();

	for (const change of diff.changes) {
		if (change.kind === 'drop_check_constraint') {
			const check = checkFromChange(change);
			if (check === undefined) continue;
			dropped.set(driftKey(change.table, check.name), check.expression);
			continue;
		}

		if (change.kind === 'add_check_constraint') {
			const check = checkFromChange(change);
			if (check === undefined) continue;
			const key = driftKey(change.table, check.name);
			const databaseExpression = dropped.get(key);
			if (databaseExpression === undefined) continue;
			drifts.set(key, {
				table: change.table,
				constraint: check.name,
				desiredExpression: check.expression,
				databaseExpression,
			});
		}
	}

	return drifts;
}

function checkFromChange(change: SchemaChange): CheckConstraintIR | undefined {
	const check = change.meta?.check as CheckConstraintIR | undefined;
	if (
		check === undefined ||
		typeof check.name !== 'string' ||
		typeof check.expression !== 'string'
	) {
		return undefined;
	}
	return check;
}

function driftKey(table: string, constraint: string): string {
	return JSON.stringify([table, constraint]);
}

interface AddedEnumValue {
	readonly enumDef: EnumIR;
	readonly enumName: string;
	readonly value: string;
}

function assertNoCheckFallbackUsesAddedEnumValue(
	diff: SchemaDiff,
	desired: ModelIR,
	dbModel: ModelIR,
	rawCheckExpressionSurfaces: ReadonlySet<string>,
	options: ComparePgsqlDatabaseSchemaOptions | undefined,
): void {
	const addedEnumValues = collectAddedEnumValues(diff);
	if (addedEnumValues.length === 0) return;

	for (const change of diff.changes) {
		if (change.kind !== 'add_check_constraint') continue;
		const check = checkFromChange(change);
		if (check === undefined) continue;
		if (!rawCheckExpressionSurfaces.has(driftKey(change.table, check.name))) {
			continue;
		}

		const table =
			findTableByDatabaseName(desired, change.table, options) ??
			findTableByDatabaseName(dbModel, change.table, options);
		for (const addedEnum of addedEnumValues) {
			if (
				checkCouldPlausiblyUseAddedEnumValue(
					check,
					table,
					addedEnum.enumDef,
					addedEnum.value,
				)
			) {
				throw new CheckConstraintNewEnumValueError(
					change.table,
					check.name,
					addedEnum.enumName,
					addedEnum.value,
				);
			}
		}
	}
}

function collectAddedEnumValues(diff: SchemaDiff): AddedEnumValue[] {
	const added: AddedEnumValue[] = [];
	for (const change of diff.changes) {
		if (change.kind !== 'alter_enum_add_value') continue;
		const enumDef = change.meta?.enum as EnumIR | undefined;
		const value = change.meta?.value;
		if (enumDef === undefined || typeof value !== 'string') continue;
		added.push({
			enumDef,
			enumName: formatEnumName(enumDef),
			value,
		});
	}
	return added;
}

function checkCouldPlausiblyUseAddedEnumValue(
	check: CheckConstraintIR,
	table: TableIR | undefined,
	enumDef: EnumIR,
	value: string,
): boolean {
	if (!expressionMentionsEnumValue(check.expression, value)) {
		return false;
	}
	if (table === undefined) {
		return true;
	}
	if (table.columns.some((column) => columnReferencesEnum(column, enumDef))) {
		return true;
	}
	return check.expression.includes(enumDef.name);
}

function expressionMentionsEnumValue(
	expression: string,
	value: string,
): boolean {
	const sqlLiteral = `'${value.replace(/'/gu, "''")}'`;
	return expression.includes(sqlLiteral);
}

function columnReferencesEnum(
	column: TableIR['columns'][number],
	enumDef: EnumIR,
): boolean {
	if (
		column.originalDbType !== undefined &&
		enumReferenceKind(
			column.originalDbType,
			enumDef.name,
			enumDef.schema,
			column.originalDbTypeSchema,
		) !== null
	) {
		return true;
	}
	return column.type === enumDef.name;
}

function findTableByDatabaseName(
	model: ModelIR,
	dbTableName: string,
	options: ComparePgsqlDatabaseSchemaOptions | undefined,
): TableIR | undefined {
	const plugin =
		options?.dbCasing !== undefined
			? getNamingPluginForDbCasing(options.dbCasing)
			: undefined;
	for (const table of model.tables.values()) {
		const candidate = plugin ? plugin.toDatabase(table.name) : table.name;
		if (candidate === dbTableName) {
			return table;
		}
	}
	return undefined;
}

function formatEnumName(enumDef: EnumIR): string {
	return enumDef.schema !== undefined
		? `${enumDef.schema}.${enumDef.name}`
		: enumDef.name;
}

function toIntrospectionOptions(
	options: ComparePgsqlDatabaseSchemaOptions | undefined,
): IntrospectionOptions {
	return {
		...(options?.schema !== undefined ? { schema: options.schema } : {}),
		...(options?.include !== undefined ? { include: options.include } : {}),
		...(options?.exclude !== undefined ? { exclude: options.exclude } : {}),
	};
}

function toCanonicalizerOptions(
	options: ComparePgsqlDatabaseSchemaOptions | undefined,
	rawCheckExpressionSurfaces: Set<string>,
): CanonicalizeCheckConstraintsOptions {
	return {
		...(options?.schema !== undefined ? { schemaName: options.schema } : {}),
		...(options?.dbCasing !== undefined ? { dbCasing: options.dbCasing } : {}),
		...(options?.requireExpressionCanonicalization !== undefined
			? { requireCanonicalization: options.requireExpressionCanonicalization }
			: {}),
		onWarning: (warning) => {
			recordRawCheckExpressionSurface(rawCheckExpressionSurfaces, warning);
			if (options?.onWarning !== undefined) {
				options.onWarning(warning.message);
			} else {
				console.warn(`Warning: ${warning.message}`);
			}
		},
	};
}

function recordRawCheckExpressionSurface(
	rawCheckExpressionSurfaces: Set<string>,
	warning: CheckConstraintCanonicalizationWarning,
): void {
	rawCheckExpressionSurfaces.add(driftKey(warning.table, warning.constraint));
}

function toCompareOptions(
	options: ComparePgsqlDatabaseSchemaOptions | undefined,
	useCanonicalizer: boolean,
): CompareSchemataOptions {
	return {
		...(options?.dbCasing !== undefined ? { dbCasing: options.dbCasing } : {}),
		...(options?.dialectCapabilities !== undefined
			? { dialectCapabilities: options.dialectCapabilities }
			: {}),
		...(options?.ignoreUnmanagedExtensions !== undefined
			? { ignoreUnmanagedExtensions: options.ignoreUnmanagedExtensions }
			: {}),
		...(!useCanonicalizer &&
		options?.requireExpressionCanonicalization !== undefined
			? {
					requireExpressionCanonicalization:
						options.requireExpressionCanonicalization,
				}
			: {}),
	};
}
