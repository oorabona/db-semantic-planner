import { createHash } from 'node:crypto';
import type { CheckConstraintIR, EnumIR, ModelIR } from '@dbsp/types';
import { getCheckConstraintDatabaseName } from '../check-constraint-name.js';
import {
	type CanonicalizeExpressionSurfacesOptions,
	type CheckConstraintCanonicalizationWarning,
	type ColumnDefaultCanonicalizationWarning,
	canonicalizeExpressionSurfaces,
	type ExpressionCanonicalizationWarning,
	fallbackToRawExpressionComparison,
	isCheckCanonicalizationTempTableUnavailableError,
} from '../expression-canonicalizer.js';
import type {
	IntrospectionOptions,
	SchemaScopeOptions,
} from '../introspection.js';
import {
	getNamingPluginForDbCasing,
	identityNaming,
} from '../naming-plugin.js';
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
	 * Whether to canonicalise PostgreSQL CHECK constraint expressions and column defaults before
	 * comparing. Defaults to `true`. Set to `false` only for compatibility with
	 * legacy raw-string live diffs.
	 *
	 * Live canonicalisation creates temporary scratch tables inside an adapter
	 * scratch scope whose successful cleanup is rollback. The database role needs
	 * permission to create temporary tables and use the scratch column types. If
	 * PostgreSQL refuses that scratch DDL, non-strict mode warns and falls back to
	 * best-effort raw string comparison for the affected expression surfaces.
	 */
	readonly canonicalizeExpressions?: boolean;
	/**
	 * Receives live expression canonicalisation warnings. Defaults to console.warn.
	 */
	readonly onWarning?: (message: string) => void;
	/** Receives the identity-bearing canonicalisation warning before its string form. */
	readonly onExpressionCanonicalizationWarning?: (
		warning: ExpressionCanonicalizationWarning,
	) => void;
	/**
	 * Diff that the caller just applied before this live re-diff. Used only when
	 * CHECK expressions or column defaults are compared by raw text to fail loudly if the exact same
	 * expression-surface drift appears again after re-introspection.
	 */
	readonly previouslyAppliedDiff?: SchemaDiff;
}

export type NonConvergentSchemaDiffSurface =
	| {
			readonly kind: 'check_constraint';
			readonly table: string;
			readonly constraint: string;
	  }
	| {
			readonly kind: 'column_default';
			readonly table: string;
			readonly column: string;
	  };

export class NonConvergentSchemaDiffError extends Error {
	constructor(
		public readonly surface: NonConvergentSchemaDiffSurface,
		public readonly desiredExpressionHash: string,
		public readonly databaseExpressionHash: string,
	) {
		const surfaceKind =
			surface.kind === 'column_default' ? 'column default' : 'CHECK constraint';
		const identityField =
			surface.kind === 'column_default' ? 'column' : 'constraint';
		super(
			`Non-convergent ${surfaceKind} diff: the same expression drift was reported after applying the previous diff. ` +
				`Desired expression SHA-256: ${desiredExpressionHash}. ` +
				`Database expression SHA-256: ${databaseExpressionHash}. Inspect the table and ${identityField} fields for the identity.`,
		);
		this.name = 'NonConvergentSchemaDiffError';
	}
}

/** An enum value this diff adds, reported as a candidate cause — never asserted. */
export interface AddedEnumValue {
	readonly enumName: string;
	readonly value: string;
}

export class CheckConstraintNewEnumValueError extends Error {
	constructor(
		public readonly table: string,
		public readonly constraint: string,
		public readonly addedEnumValues: readonly AddedEnumValue[],
		public readonly surfaceKind:
			| 'CHECK constraint'
			| 'column default' = 'CHECK constraint',
	) {
		super(
			`PostgreSQL could not canonicalise one ${surfaceKind}, ` +
				`and this migration also adds ${addedEnumValues.length} enum value(s). PostgreSQL ` +
				'cannot use an enum value in the transaction that adds it, and dbsp applies ' +
				'each migration in one transaction, so this constraint cannot be proven ' +
				'applicable. Apply the enum change on its own first, then add or update the ' +
				'constraint. Inspect the table, constraint, and addedEnumValues fields for identities.',
		);
		this.name = 'CheckConstraintNewEnumValueError';
	}
}

/**
 * Live PostgreSQL schema diff: introspect, canonicalise desired CHECK
 * constraint expressions and column defaults through PostgreSQL, then call the pure synchronous
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
	adapter: PgsqlAdapter,
	desired: ModelIR,
	options?: ComparePgsqlDatabaseSchemaOptions,
): Promise<SchemaDiff> {
	const dbModel = await adapter.introspect(toIntrospectionOptions(options));
	const compareCheckConstraints = supportsDDLCheckConstraints(options);
	const useCanonicalizer = options?.canonicalizeExpressions ?? true;
	const rawExpressionSurfaces = new Set<string>();
	const canonicalModels = useCanonicalizer
		? await canonicalizeLiveExpressions(
				adapter,
				desired,
				dbModel,
				options,
				rawExpressionSurfaces,
			)
		: { desired, database: dbModel, defaultOutcomes: [] };
	const desiredForCompare = canonicalModels.desired;
	const dbModelForCompare = canonicalModels.database;
	if (options?.requireExpressionCanonicalization) {
		if (useCanonicalizer) {
			assertStrictDefaultCanonicalization(
				canonicalModels.defaultOutcomes ?? [],
			);
			assertNoUncanonicalizedLiveExpressionSurfaces(
				desiredForCompare,
				dbModelForCompare,
				compareCheckConstraints,
				options?.dbCasing,
			);
		} else {
			assertNoRawLiveExpressionSurfaces(
				desiredForCompare,
				dbModelForCompare,
				compareCheckConstraints,
			);
		}
	}
	const diff = compareSchemata(
		desiredForCompare,
		dbModelForCompare,
		toCompareOptions(options, {
			delegateExpressionCanonicalization:
				options?.requireExpressionCanonicalization === true &&
				!useCanonicalizer &&
				compareCheckConstraints,
		}),
	);

	if (useCanonicalizer && rawExpressionSurfaces.size > 0) {
		assertNoCheckFallbackUsesAddedEnumValue(diff, rawExpressionSurfaces);
	}

	if (options?.previouslyAppliedDiff !== undefined) {
		if (!useCanonicalizer) {
			assertNoRepeatedExpressionSurfaceDrift(
				options.previouslyAppliedDiff,
				diff,
			);
		} else if (rawExpressionSurfaces.size > 0) {
			assertNoRepeatedExpressionSurfaceDrift(
				options.previouslyAppliedDiff,
				diff,
				rawExpressionSurfaces,
			);
		}
	}

	return diff;
}

function assertStrictDefaultCanonicalization(
	outcomes: readonly {
		readonly side: 'desired' | 'database';
		readonly table: string;
		readonly column: string;
		readonly status: 'canonicalised' | 'unavailable' | 'rejected';
		readonly reason?: unknown;
	}[],
): void {
	const unavailable = outcomes.filter(
		(outcome) => outcome.status === 'unavailable',
	);
	if (unavailable.length > 0) {
		throw new ExpressionCanonicalizationUnavailableError(
			unavailable.map(
				(outcome) =>
					`${outcome.side}.${outcome.table}.${outcome.column}.DEFAULT`,
			),
		);
	}
	const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
	if (rejected !== undefined) {
		throw rejected.reason;
	}
}

async function canonicalizeLiveExpressions(
	adapter: PgsqlAdapter,
	desired: ModelIR,
	dbModel: ModelIR,
	options: ComparePgsqlDatabaseSchemaOptions | undefined,
	rawExpressionSurfaces: Set<string>,
): Promise<{
	readonly desired: ModelIR;
	readonly database: ModelIR;
	readonly defaultOutcomes: readonly {
		readonly side: 'desired' | 'database';
		readonly table: string;
		readonly column: string;
		readonly status: 'canonicalised' | 'unavailable' | 'rejected';
		readonly reason?: unknown;
	}[];
}> {
	const canonicalizerOptions = toCanonicalizerOptions(
		options,
		rawExpressionSurfaces,
	);
	try {
		const canonicalModels = await adapter.withScratchScope((scratch) =>
			canonicalizeExpressionSurfaces(
				scratch,
				desired,
				dbModel,
				canonicalizerOptions,
			),
		);
		recordRawDefaultExpressionSurfaces(
			rawExpressionSurfaces,
			canonicalModels.defaultOutcomes ?? [],
		);
		return canonicalModels;
	} catch (error) {
		if (
			options?.requireExpressionCanonicalization === true ||
			!isCheckCanonicalizationTempTableUnavailableError(error)
		) {
			throw error;
		}
		const fallback = fallbackToRawExpressionComparison(
			desired,
			dbModel,
			error,
			canonicalizerOptions,
		);
		recordRawDefaultExpressionSurfaces(
			rawExpressionSurfaces,
			fallback.defaultOutcomes ?? [],
		);
		return fallback;
	}
}

function assertNoUncanonicalizedLiveExpressionSurfaces(
	desired: ModelIR,
	dbModel: ModelIR,
	includeCheckConstraints: boolean,
	dbCasing: ComparePgsqlDatabaseSchemaOptions['dbCasing'],
): void {
	const surfaces = [
		...collectExpressionSurfaces('schema', desired, {
			includeColumnDefaults: false,
			includeCheckConstraints: false,
		}),
		...collectExpressionSurfaces('database', dbModel, {
			includeColumnDefaults: false,
			includeCheckConstraints: false,
		}),
		...collectDatabaseOnlyExpressionSurfaces(
			desired,
			dbModel,
			includeCheckConstraints,
			dbCasing,
		),
	];
	if (surfaces.length > 0) {
		throw new ExpressionCanonicalizationUnavailableError(surfaces);
	}
}

function collectDatabaseOnlyExpressionSurfaces(
	desired: ModelIR,
	dbModel: ModelIR,
	includeCheckConstraints: boolean,
	dbCasing: ComparePgsqlDatabaseSchemaOptions['dbCasing'],
): string[] {
	const naming =
		dbCasing === undefined
			? identityNaming
			: getNamingPluginForDbCasing(dbCasing);
	const desiredTables = new Map(
		[...desired.tables.values()].map((table) => [
			naming.toDatabase(table.name),
			table,
		]),
	);
	const surfaces: string[] = [];

	for (const dbTable of dbModel.tables.values()) {
		const desiredTable = desiredTables.get(dbTable.name);
		if (!includeCheckConstraints) continue;
		const desiredChecks = new Set(
			(desiredTable?.checkConstraints ?? []).map((check) =>
				getCheckConstraintDatabaseName(check, naming),
			),
		);
		for (const dbCheck of dbTable.checkConstraints ?? []) {
			if (!desiredChecks.has(dbCheck.name)) {
				surfaces.push(`database.${dbTable.name}.CHECK(${dbCheck.name})`);
			}
		}
	}

	return surfaces;
}

function assertNoRawLiveExpressionSurfaces(
	desired: ModelIR,
	dbModel: ModelIR,
	includeCheckConstraints: boolean,
): void {
	const surfaces = [
		...collectExpressionSurfaces('schema', desired, {
			includeCheckConstraints,
		}),
		...collectExpressionSurfaces('database', dbModel, {
			includeCheckConstraints,
		}),
	];
	if (surfaces.length > 0) {
		throw new ExpressionCanonicalizationUnavailableError(surfaces);
	}
}

export function assertNoRepeatedExpressionSurfaceDrift(
	previouslyAppliedDiff: SchemaDiff,
	currentDiff: SchemaDiff,
	rawExpressionSurfaces?: ReadonlySet<string>,
): void {
	const previousDrifts = collectCheckExpressionDrifts(previouslyAppliedDiff);
	if (previousDrifts.size === 0) return;

	for (const [key, current] of collectCheckExpressionDrifts(currentDiff)) {
		if (
			rawExpressionSurfaces !== undefined &&
			!rawExpressionSurfaces.has(key)
		) {
			continue;
		}
		const previous = previousDrifts.get(key);
		if (
			previous !== undefined &&
			previous.desiredExpressionHash === current.desiredExpressionHash &&
			previous.databaseExpressionHash === current.databaseExpressionHash
		) {
			throw new NonConvergentSchemaDiffError(
				current.kind === 'column_default'
					? {
							kind: 'column_default',
							table: current.table,
							column: current.constraint,
						}
					: {
							kind: 'check_constraint',
							table: current.table,
							constraint: current.constraint,
						},
				current.desiredExpressionHash,
				current.databaseExpressionHash,
			);
		}
	}
}

interface CheckExpressionDrift {
	readonly kind: 'check_constraint' | 'column_default';
	readonly table: string;
	readonly constraint: string;
	readonly desiredExpressionHash: string;
	readonly databaseExpressionHash: string;
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
			dropped.set(
				driftKey('check_constraint', change.table, check.name),
				check.expression,
			);
			continue;
		}

		if (change.kind === 'add_check_constraint') {
			const check = checkFromChange(change);
			if (check === undefined) continue;
			const key = driftKey('check_constraint', change.table, check.name);
			const databaseExpression = dropped.get(key);
			if (databaseExpression === undefined) continue;
			drifts.set(key, {
				kind: 'check_constraint',
				table: change.table,
				constraint: check.name,
				desiredExpressionHash: hashExpression(check.expression),
				databaseExpressionHash: hashExpression(databaseExpression),
			});
		}

		if (change.kind === 'alter_column_default' && change.column !== undefined) {
			const key = driftKey('column_default', change.table, change.column);
			drifts.set(key, {
				kind: 'column_default',
				table: change.table,
				constraint: change.column,
				desiredExpressionHash: hashExpression(
					defaultFromChange(change.meta?.default),
				),
				databaseExpressionHash: hashExpression(
					defaultFromChange(change.meta?.oldDefault),
				),
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

function defaultFromChange(value: unknown): unknown {
	return value;
}

function hashExpression(expression: unknown): string {
	const representation =
		typeof expression === 'object' &&
		expression !== null &&
		'sql' in expression &&
		typeof (expression as Record<string, unknown>).sql === 'string'
			? {
					kind: 'sql_fragment',
					sql: (expression as Record<string, string>).sql,
				}
			: { kind: 'scalar', type: typeof expression, value: expression };
	return createHash('sha256')
		.update(JSON.stringify(representation))
		.digest('hex');
}

function driftKey(
	kind: 'check_constraint' | 'column_default',
	table: string,
	name: string,
): string {
	return JSON.stringify([kind, table, name]);
}

/**
 * Refuse a CHECK constraint the diff intends to ADD when PostgreSQL itself
 * refused to canonicalise it while the same diff adds enum values.
 *
 * The trigger is the engine's own verdict: `rawCheckExpressionSurfaces` holds
 * exactly the constraints PostgreSQL would not accept against a scratch table
 * carrying the desired columns and types. Reading the expression text to work
 * out *which* added enum value is to blame would be a heuristic, and every
 * literal spelling PostgreSQL accepts — single-quoted, dollar-quoted,
 * Unicode-escaped, concatenated — would be another way past it. So the text is
 * not read at all.
 *
 * Declared bound: a CHECK that failed canonicalisation for an unrelated reason,
 * in a diff that happens to also add an enum value elsewhere, is refused too.
 * That is deliberate — an expression PostgreSQL rejected in the scratch table is
 * not one this layer can prove executable — and it is why the added values are
 * reported as candidates rather than as an asserted cause.
 */
function assertNoCheckFallbackUsesAddedEnumValue(
	diff: SchemaDiff,
	rawExpressionSurfaces: ReadonlySet<string>,
): void {
	const addedEnumValues = collectAddedEnumValues(diff);
	if (addedEnumValues.length === 0) return;

	for (const change of diff.changes) {
		if (change.kind === 'add_check_constraint') {
			const check = checkFromChange(change);
			if (check === undefined) continue;
			if (
				rawExpressionSurfaces.has(
					driftKey('check_constraint', change.table, check.name),
				)
			) {
				throw new CheckConstraintNewEnumValueError(
					change.table,
					check.name,
					addedEnumValues,
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
		added.push({ enumName: formatEnumName(enumDef), value });
	}
	return added;
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
	rawExpressionSurfaces: Set<string>,
): CanonicalizeExpressionSurfacesOptions {
	return {
		...(options?.schema !== undefined ? { schemaName: options.schema } : {}),
		...(options?.dbCasing !== undefined ? { dbCasing: options.dbCasing } : {}),
		...(options?.requireExpressionCanonicalization !== undefined
			? { requireCanonicalization: options.requireExpressionCanonicalization }
			: {}),
		canonicalizeCheckConstraints: supportsDDLCheckConstraints(options),
		onWarning: (warning) => {
			if (warning.kind === 'check_constraint') {
				recordRawCheckExpressionSurface(rawExpressionSurfaces, warning);
			}
			const onStructuredWarning = options?.onExpressionCanonicalizationWarning;
			onStructuredWarning?.(warning);
			if (options?.onWarning !== undefined) {
				options.onWarning(warning.message);
			} else if (onStructuredWarning === undefined) {
				console.warn(`Warning: ${warning.message}`);
			}
		},
	};
}

function recordRawDefaultExpressionSurfaces(
	rawExpressionSurfaces: Set<string>,
	outcomes: readonly {
		readonly side: 'desired' | 'database';
		readonly table: string;
		readonly column: string;
		readonly status: 'canonicalised' | 'unavailable' | 'rejected';
	}[],
): void {
	for (const outcome of outcomes) {
		if (outcome.status !== 'canonicalised') {
			rawExpressionSurfaces.add(
				driftKey('column_default', outcome.table, outcome.column),
			);
		}
	}
}

function recordRawCheckExpressionSurface(
	rawExpressionSurfaces: Set<string>,
	warning:
		| CheckConstraintCanonicalizationWarning
		| ColumnDefaultCanonicalizationWarning,
): void {
	rawExpressionSurfaces.add(
		driftKey(warning.kind, warning.table, warning.name),
	);
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
