import type { CheckConstraintIR, EnumIR, ModelIR } from '@dbsp/types';
import {
	type CanonicalizeCheckConstraintsOptions,
	type CheckConstraintCanonicalizationWarning,
	canonicalizeCheckConstraints,
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
	) {
		const candidates = addedEnumValues
			.map(({ enumName, value }) => `"${value}" (enum "${enumName}")`)
			.join(', ');
		super(
			`PostgreSQL could not canonicalise CHECK constraint "${table}"."${constraint}", ` +
				`and this migration also adds enum value(s): ${candidates}. PostgreSQL ` +
				'cannot use an enum value in the transaction that adds it, and dbsp applies ' +
				'each migration in one transaction, so this constraint cannot be proven ' +
				'applicable. Apply the enum change on its own first, then add or update the ' +
				'constraint.',
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
		? await adapter.withScratchScope((scratch) =>
				canonicalizeCheckConstraints(
					scratch,
					desired,
					dbModel,
					toCanonicalizerOptions(options, rawCheckExpressionSurfaces),
				),
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

	if (useCanonicalizer && rawCheckExpressionSurfaces.size > 0) {
		assertNoCheckFallbackUsesAddedEnumValue(diff, rawCheckExpressionSurfaces);
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
	rawCheckExpressionSurfaces: ReadonlySet<string>,
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
		throw new CheckConstraintNewEnumValueError(
			change.table,
			check.name,
			addedEnumValues,
		);
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
