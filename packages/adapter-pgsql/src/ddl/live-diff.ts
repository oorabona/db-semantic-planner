import type { CheckConstraintIR, ModelIR } from '@dbsp/types';
import {
	type CanonicalizeCheckConstraintsOptions,
	type CheckConstraintCanonicalizationWarning,
	canonicalizeCheckConstraints,
	fallbackToRawCheckConstraintComparison,
	isCheckCanonicalizationTempTableUnavailableError,
} from '../expression-canonicalizer.js';
import type {
	IntrospectionOptions,
	SchemaScopeOptions,
} from '../introspection.js';
import type { PgsqlAdapter } from '../pgsql-adapter.js';
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
		SchemaScopeOptions {
	/**
	 * Whether to canonicalise PostgreSQL CHECK constraint expressions before
	 * comparing. Defaults to `true`. Set to `false` only for compatibility with
	 * legacy raw-string live diffs.
	 *
	 * Live canonicalisation creates temporary scratch tables and missing desired
	 * enum types inside an adapter scratch scope whose successful cleanup is
	 * rollback. The database role needs permission to create temporary tables,
	 * and enum-dependent checks may need permission to create the pending enum
	 * type. If PostgreSQL refuses that scratch DDL, non-strict mode warns and
	 * falls back to best-effort raw string comparison for the affected CHECK
	 * constraints.
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

// v4 (#389): remove — retained only for source compatibility; dbsp no longer
// produces this condition.
/** @deprecated Retained only for source compatibility; dbsp no longer produces this condition. */
export interface AddedEnumValue {
	readonly enumName: string;
	readonly value: string;
}

// v4 (#389): remove — retained only for source compatibility; dbsp no longer
// produces this condition.
/** @deprecated Retained only for source compatibility; dbsp no longer produces this condition. */
export class CheckConstraintNewEnumValueError extends Error {
	constructor(
		public readonly table: string,
		public readonly constraint: string,
		public readonly addedEnumValues: readonly AddedEnumValue[],
	) {
		const candidates = addedEnumValues
			.map(({ enumName, value }) => `"${value}" (enum "${enumName}")`)
			.join(', ');
		super(
			`PostgreSQL could not canonicalise CHECK constraint "${table}"."${constraint}", ` +
				`and the migration adds enum value(s): ${candidates}. This legacy error ` +
				'does not describe a condition dbsp now produces; reconcile the enum and ' +
				'constraint changes before applying them.',
		);
		this.name = 'CheckConstraintNewEnumValueError';
	}
}

/**
 * Live PostgreSQL schema diff: introspect, canonicalise desired CHECK
 * constraint expressions through PostgreSQL, then call the pure synchronous
 * schema comparator.
 *
 * Partial-index predicates and index expressions are intentionally not
 * canonicalised here; non-strict diffs compare them by raw string, and strict
 * diffs reject them.
 */
export async function comparePgsqlDatabaseSchema(
	adapter: PgsqlAdapter,
	desired: ModelIR,
	options?: ComparePgsqlDatabaseSchemaOptions,
): Promise<SchemaDiff> {
	const dbModel = await adapter.introspect(toIntrospectionOptions(options));
	const compareCheckConstraints = supportsDDLCheckConstraints(options);
	const useCanonicalizer =
		compareCheckConstraints && (options?.canonicalizeExpressions ?? true);
	const rawCheckExpressionSurfaces = new Set<string>();
	const desiredForCompare = useCanonicalizer
		? await canonicalizeLiveCheckConstraints(
				adapter,
				desired,
				dbModel,
				options,
				rawCheckExpressionSurfaces,
			)
		: desired;
	if (
		options?.requireExpressionCanonicalization &&
		(useCanonicalizer || !compareCheckConstraints)
	) {
		assertNoUncanonicalizedLiveExpressionSurfaces(desiredForCompare, dbModel);
	}
	const diff = compareSchemata(
		desiredForCompare,
		dbModel,
		toCompareOptions(options, {
			delegateExpressionCanonicalization:
				options?.requireExpressionCanonicalization === true &&
				!useCanonicalizer &&
				compareCheckConstraints,
		}),
	);

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

async function canonicalizeLiveCheckConstraints(
	adapter: PgsqlAdapter,
	desired: ModelIR,
	dbModel: ModelIR,
	options: ComparePgsqlDatabaseSchemaOptions | undefined,
	rawCheckExpressionSurfaces: Set<string>,
): Promise<ModelIR> {
	const canonicalizerOptions = toCanonicalizerOptions(
		options,
		rawCheckExpressionSurfaces,
	);
	try {
		return await adapter.withScratchScope((scratch) =>
			canonicalizeCheckConstraints(
				scratch,
				desired,
				dbModel,
				canonicalizerOptions,
			),
		);
	} catch (error) {
		if (
			options?.requireExpressionCanonicalization === true ||
			!isCheckCanonicalizationTempTableUnavailableError(error)
		) {
			throw error;
		}
		return fallbackToRawCheckConstraintComparison(
			desired,
			dbModel,
			error,
			canonicalizerOptions,
		);
	}
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

function toIntrospectionOptions(
	options: ComparePgsqlDatabaseSchemaOptions | undefined,
): IntrospectionOptions {
	return {
		...(options?.schema !== undefined ? { schema: options.schema } : {}),
	};
}

function supportsDDLCheckConstraints(
	options: ComparePgsqlDatabaseSchemaOptions | undefined,
): boolean {
	const caps = options?.dialectCapabilities;
	return caps === undefined || caps.supportsDDLCheckConstraints === true;
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
	strictness: {
		readonly delegateExpressionCanonicalization: boolean;
	},
): CompareSchemataOptions {
	return {
		...(options?.dbCasing !== undefined ? { dbCasing: options.dbCasing } : {}),
		...(options?.dialectCapabilities !== undefined
			? { dialectCapabilities: options.dialectCapabilities }
			: {}),
		...(options?.ignoreUnmanagedExtensions !== undefined
			? { ignoreUnmanagedExtensions: options.ignoreUnmanagedExtensions }
			: {}),
		...(strictness.delegateExpressionCanonicalization
			? {
					requireExpressionCanonicalization: true,
				}
			: {}),
	};
}
