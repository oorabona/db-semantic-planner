import { createHash } from 'node:crypto';
import { defaultIndexName } from '@dbsp/core';
import { assertDeclaredEnumMapIdentity } from '@dbsp/core/internal';
import type {
	CheckConstraintIR,
	DbCasing,
	EnumIR,
	IndexIR,
	ModelIR,
	TableIR,
} from '@dbsp/types';
import type { Pool, PoolClient } from 'pg';
import { getCheckConstraintDatabaseName } from '../check-constraint-name.js';
import {
	type CanonicalizeExpressionSurfacesOptions,
	type CheckConstraintCanonicalizationWarning,
	canonicalizeExpressionSurfaces,
	type ExpressionCanonicalizationWarning,
	fallbackToRawExpressionComparison,
	isExpressionCanonicalizationInfrastructureUnavailableError,
	PlannedSchemaStagingError,
} from '../expression-canonicalizer.js';
import type {
	IntrospectionOptions,
	SchemaScopeOptions,
} from '../introspection.js';
import {
	getNamingPluginForDbCasing,
	identityNaming,
} from '../naming-plugin.js';
import { createPgsqlAdapter, type PgsqlAdapter } from '../pgsql-adapter.js';
import { createPgPhysicalModel } from '../physical-model/index.js';
import {
	declaredSequenceNamesFromInventory,
	LegacySequenceNameError,
} from '../sequence-name.js';
import { escapeDiagnosticText } from '../validate.js';
import { generateDownSQL, generateMigrationSQL } from './migration-sql.js';
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
	 * Whether to canonicalise PostgreSQL CHECK constraint expressions, column defaults, and predicates on column-keyed
	 * partial indexes before comparing. Defaults to `true`. Expression-keyed
	 * partial-index predicates are reported as unavailable. Set to `false` only for compatibility with
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
	 * expression surfaces are compared by raw text to fail loudly if the exact same
	 * expression-surface drift appears again after re-introspection.
	 */
	readonly previouslyAppliedDiff?: SchemaDiff;
	/** Internal physical-to-authored sequence provenance for legacy-name refusal. */
	readonly declaredSequenceNames?: ReadonlyMap<string, string>;
}

/**
 * Compare the declared shape of an adopted table against its live PostgreSQL
 * counterpart. The supplied model is deliberately declaration-scoped: the whole
 * schema is introspected, so an adopted table's foreign keys to any table are
 * seen, and the comparison then keeps only the declared physical tables (with
 * the relations between them), so drift on other tables is not reported.
 */
export interface ComparePgsqlDeclaredAdoptionSchemaInput {
	readonly executor: PgsqlAdoptionComparisonExecutor;
	readonly model: ModelIR;
	readonly schema: string;
	readonly dbCasing: DbCasing;
	/** Physical [table, index] JSON keys whose drop drift is unmanaged. */
	readonly externalIndexMask?: ReadonlySet<string>;
	/** Physical [table, surface] JSON keys maintained by application assertions. */
	readonly ownershipMask?: PgsqlDeclaredAdoptionOwnershipMask;
	/** Internal physical-to-authored sequence provenance for legacy-name refusal. */
	readonly declaredSequenceNames?: ReadonlyMap<string, string>;
}

/** Internal converge-only declaration mask; public database comparison is unchanged. */
export interface PgsqlDeclaredAdoptionOwnershipMask {
	readonly checks: ReadonlySet<string>;
	readonly columnTypes: ReadonlySet<string>;
	readonly indexes: ReadonlySet<string>;
}

/** Minimal pool surface retained so callers can keep their executor opaque. */
export interface PgsqlAdoptionComparisonExecutor {
	query(
		sql: string,
		parameters?: readonly unknown[],
	): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}

/** Builds the declaration-scoped model used by every adoption shape check. */
export function modelForDeclaredAdoption(table: TableIR): ModelIR {
	const tables = new Map([[table.name, table]]);
	const relations = new Map();
	const externalTables = new Set(
		table.foreignKeys
			.map((foreignKey) => foreignKey.references.table)
			.filter((referencedTable) => referencedTable !== table.name),
	);
	return {
		tables,
		relations,
		...(externalTables.size > 0 ? { externalTables } : {}),
		getTable: (name) => tables.get(name),
		getRelation: (name) => relations.get(name),
		getRelationsFrom: () => [],
		getRelationsTo: () => [],
		isAmbiguous: () => ({ ambiguous: false, options: [] }),
	};
}

function isPoolClient(
	executor: PgsqlAdoptionComparisonExecutor,
): executor is PoolClient {
	return 'release' in executor && typeof executor.release === 'function';
}

function isPool(executor: PgsqlAdoptionComparisonExecutor): executor is Pool {
	return (
		'connect' in executor &&
		typeof executor.connect === 'function' &&
		'totalCount' in executor &&
		typeof executor.totalCount === 'number' &&
		!isPoolClient(executor)
	);
}

function indexNameForChange(change: SchemaChange): string | undefined {
	if (change.kind !== 'drop_index') return undefined;
	const index = change.meta?.index;
	if (!index || typeof index !== 'object' || Array.isArray(index))
		return undefined;
	return 'name' in index && typeof index.name === 'string'
		? index.name
		: undefined;
}

/** Stable physical [table, name] key shared by converge's index masks. */
export function pgsqlSurfaceKey(table: string, name: string): string {
	return JSON.stringify([table, name]);
}

/** Resolve a declared index to the exact name PostgreSQL will receive. */
export function resolvePgsqlDeclaredIndexName(
	table: TableIR,
	index: IndexIR,
	naming: ReturnType<typeof getNamingPluginForDbCasing>,
): string {
	const physicalTable = naming.toDatabase(table.name);
	return defaultIndexName(physicalTable, {
		...index,
		...(index.name === undefined
			? {}
			: { name: naming.toDatabase(index.name) }),
		columns: index.columns.map((column) => naming.toDatabase(column)),
	});
}

function modelWithOwnedSurfacesRemoved(
	model: ModelIR,
	mask: PgsqlDeclaredAdoptionOwnershipMask | undefined,
	naming: ReturnType<typeof getNamingPluginForDbCasing>,
): ModelIR {
	if (!mask) return model;
	const tables = new Map(
		[...model.tables.values()].map((table) => {
			const physicalTable = naming.toDatabase(table.name);
			return [
				table.name,
				{
					...table,
					checkConstraints: (table.checkConstraints ?? []).filter(
						(check) =>
							!mask.checks.has(
								pgsqlSurfaceKey(
									physicalTable,
									getCheckConstraintDatabaseName(check, naming),
								),
							),
					),
					indexes: table.indexes.filter(
						(index) =>
							!mask.indexes.has(
								pgsqlSurfaceKey(
									physicalTable,
									resolvePgsqlDeclaredIndexName(table, index, naming),
								),
							),
					),
				},
			] as const;
		}),
	);
	return {
		...model,
		tables,
		getTable: (name) => tables.get(name),
	};
}

function maskOwnedLiveSurfaces(
	model: ModelIR,
	mask: PgsqlDeclaredAdoptionOwnershipMask | undefined,
): ModelIR {
	if (!mask) return model;
	return {
		...model,
		tables: new Map(
			[...model.tables].map(
				([name, table]) =>
					[
						name,
						{
							...table,
							checkConstraints: (table.checkConstraints ?? []).filter(
								(check) => !mask.checks.has(pgsqlSurfaceKey(name, check.name)),
							),
							indexes: table.indexes.filter(
								(index) =>
									index.name === undefined ||
									!mask.indexes.has(pgsqlSurfaceKey(name, index.name)),
							),
						},
					] as const,
			),
		),
	};
}

function applyOwnedColumnTypeMask(
	desired: ModelIR,
	live: ModelIR,
	mask: PgsqlDeclaredAdoptionOwnershipMask | undefined,
	naming: ReturnType<typeof getNamingPluginForDbCasing>,
): void {
	if (!mask) return;
	for (const [logicalName, table] of desired.tables) {
		const physicalTable = naming.toDatabase(logicalName);
		const liveTable = live.tables.get(physicalTable);
		if (!liveTable) continue;
		const columns = table.columns.map((column) => {
			const physicalColumn = naming.toDatabase(column.name);
			if (!mask.columnTypes.has(pgsqlSurfaceKey(physicalTable, physicalColumn)))
				return column;
			const liveColumn = liveTable.columns.find(
				(candidate) => candidate.name === physicalColumn,
			);
			if (!liveColumn) return column;
			const {
				type: _type,
				originalDbType: _originalDbType,
				originalDbTypeSchema: _originalDbTypeSchema,
				originalDbTypeSchemaScope: _originalDbTypeSchemaScope,
				...other
			} = column;
			return {
				...other,
				type: liveColumn.type,
				...(liveColumn.originalDbType === undefined
					? {}
					: { originalDbType: liveColumn.originalDbType }),
				...(liveColumn.originalDbTypeSchema === undefined
					? {}
					: { originalDbTypeSchema: liveColumn.originalDbTypeSchema }),
				...(liveColumn.originalDbTypeSchemaScope === undefined
					? {}
					: {
							originalDbTypeSchemaScope: liveColumn.originalDbTypeSchemaScope,
						}),
			};
		});
		(desired.tables as Map<string, TableIR>).set(logicalName, {
			...table,
			columns,
		});
	}
}

/**
 * PostgreSQL-aware comparison used to admit a declared table adoption. A
 * claimed session remains pinned by constructing a borrowed, transaction-aware
 * adapter from that exact executor.
 */
export async function comparePgsqlDeclaredAdoptionSchema(
	input: ComparePgsqlDeclaredAdoptionSchemaInput,
): Promise<SchemaDiff> {
	const adapter = isPoolClient(input.executor)
		? createPgsqlAdapter(input.executor, {
				borrowedClient: true,
				managedTransactions: true,
				dbCasing: input.dbCasing,
			})
		: isPool(input.executor)
			? createPgsqlAdapter(input.executor, {
					dbCasing: input.dbCasing,
				})
			: (() => {
					throw new Error(
						'comparePgsqlDeclaredAdoptionSchema() requires a pg Pool or checked-out PoolClient executor',
					);
				})();
	const naming = getNamingPluginForDbCasing(input.dbCasing);
	const ownershipMask =
		input.ownershipMask !== undefined &&
		(input.ownershipMask.checks.size > 0 ||
			input.ownershipMask.columnTypes.size > 0 ||
			input.ownershipMask.indexes.size > 0)
			? input.ownershipMask
			: undefined;
	const logicalDesired = modelWithOwnedSurfacesRemoved(
		input.model,
		ownershipMask,
		naming,
	);
	const physicalDesired = createPgPhysicalModel({
		mode: 'logical',
		model: logicalDesired,
		schema: input.schema,
		dbCasing: input.dbCasing,
	});
	const desired = physicalDesired.model;
	const declaredSequenceNames =
		input.declaredSequenceNames ??
		declaredSequenceNamesFromInventory(physicalDesired.inventory);
	const declaredTables = new Set(desired.tables.keys());
	const declaredSequences = new Set(desired.sequences?.keys() ?? []);
	const legacyRawSequencePhysicalNames = new Map(
		[...declaredSequenceNames].flatMap(([physicalName, authoredName]) =>
			physicalName === authoredName
				? []
				: ([[authoredName, physicalName]] as const),
		),
	);
	assertDeclaredEnumMapIdentity(input.model.enums);
	const declaredEnums = new Set(input.model.enums?.keys() ?? []);
	const declarationScopedAdapter = new Proxy(adapter, {
		get(target, property, receiver) {
			if (property === 'introspect')
				return (
					introspectionOptions?: Parameters<typeof target.introspect>[0],
				) =>
					target.introspect(introspectionOptions).then((introspected) => {
						const tables = new Map(
							[...introspected.tables].filter(([name]) =>
								declaredTables.has(name),
							),
						);
						const externalTables = new Set(
							[...(introspected.externalTables ?? [])].filter(
								(name) => !tables.has(name),
							),
						);
						for (const table of tables.values()) {
							for (const foreignKey of table.foreignKeys) {
								if (!tables.has(foreignKey.references.table)) {
									externalTables.add(foreignKey.references.table);
								}
							}
						}
						const scoped = {
							...introspected,
							tables,
							relations: new Map(
								[...introspected.relations].filter(
									([, relation]) =>
										tables.has(relation.source) && tables.has(relation.target),
								),
							),
							externalTables,
							sequences: new Map(
								[...(introspected.sequences ?? [])].filter(
									([name]) =>
										declaredSequences.has(name) ||
										(legacyRawSequencePhysicalNames.has(name) &&
											!introspected.sequences?.has(
												legacyRawSequencePhysicalNames.get(name)!,
											)),
								),
							),
							enums: new Map(
								[...(introspected.enums ?? [])].filter(([name]) =>
									declaredEnums.has(name),
								),
							),
						};
						const masked = maskOwnedLiveSurfaces(scoped, ownershipMask);
						applyOwnedColumnTypeMask(
							desired,
							masked,
							ownershipMask,
							identityNaming,
						);
						return masked;
					});
			return Reflect.get(target, property, receiver);
		},
	});
	const compared = await comparePgsqlDatabaseSchema(
		declarationScopedAdapter,
		desired,
		{
			schema: input.schema,
			ignoreUnmanagedExtensions: true,
			declaredSequenceNames,
		},
	);
	return {
		...compared,
		changes: compared.changes.filter((change) => {
			const indexName = indexNameForChange(change);
			return (
				indexName === undefined ||
				!input.externalIndexMask?.has(pgsqlSurfaceKey(change.table, indexName))
			);
		}),
	};
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
	) {
		super(
			'PostgreSQL could not canonicalise one CHECK constraint, ' +
				`and this migration also adds ${addedEnumValues.length} enum value(s). PostgreSQL ` +
				'cannot use an enum value in the transaction that adds it, and dbsp applies ' +
				'each migration in one transaction, so this schema change cannot be proven ' +
				'applicable. Apply the enum change on its own first, then apply the ' +
				'dependent schema change. Inspect addedEnumValues for candidate labels.' +
				' Inspect the table and constraint fields for the affected CHECK.',
		);
		this.name = 'CheckConstraintNewEnumValueError';
	}
}

/** A raw partial-index predicate and added enum values cannot share one migration. */
export class PartialIndexPredicateNewEnumValueError extends Error {
	constructor(public readonly addedEnumValues: readonly AddedEnumValue[]) {
		super(
			'PostgreSQL could not canonicalise at least one partial-index predicate, ' +
				`and this migration also adds ${addedEnumValues.length} enum value(s). PostgreSQL ` +
				'cannot use an enum value in the transaction that adds it, and dbsp applies ' +
				'each migration in one transaction, so this schema change cannot be proven ' +
				'applicable. Apply the enum change on its own first, then apply the ' +
				'dependent index migration. Inspect addedEnumValues for candidate labels.',
		);
		this.name = 'PartialIndexPredicateNewEnumValueError';
	}
}

/** #454: Predicate canonicalization is not implemented for indexes with expression keys. */
export class ExpressionKeyedIndexPredicateCanonicalizationUnsupportedError extends Error {
	constructor(
		public readonly predicates: readonly {
			readonly side: 'desired' | 'database';
			readonly table: string;
			readonly index: string;
		}[],
	) {
		super(
			'Partial-index predicates on indexes with expression keys cannot be canonicalized. Use a column-keyed partial index instead.',
		);
		this.name = 'ExpressionKeyedIndexPredicateCanonicalizationUnsupportedError';
	}
}

/**
 * A raw partial-index predicate cannot be proven to converge after PostgreSQL
 * deparses it, so emitting its CREATE statement is unsafe.
 */
export class RawIndexPredicateFallbackError extends Error {
	constructor(cause?: unknown) {
		const stagingFailure =
			cause instanceof PlannedSchemaStagingError ? cause : undefined;
		super(
			stagingFailure === undefined
				? 'PostgreSQL could not create a temporary scratch relation while canonicalising at least one partial-index predicate. ' +
						`Grant TEMP so PostgreSQL can canonicalise the predicate. PostgreSQL reported: ${errorMessage(cause)}. ` +
						'This migration emits a partial-index CREATE in UP or DOWN SQL, so dbsp refuses it because it cannot prove the index will converge. Apply the index in a migration of its own if needed.'
				: `PostgreSQL could not stage ${stagingFailure.statement} while canonicalising at least one partial-index predicate. ` +
						`${stagingFailure.statement} requires CREATE on the target schema, not TEMP. PostgreSQL reported: ${errorMessage(stagingFailure.cause)}. ` +
						'This migration emits a partial-index CREATE in UP or DOWN SQL, so dbsp refuses it because it cannot prove the index will converge.',
		);
		this.name = 'RawIndexPredicateFallbackError';
	}
}

function errorMessage(error: unknown): string {
	return escapeDiagnosticText(
		error instanceof Error ? error.message : String(error),
	);
}

export class IndexPredicateCanonicalizationError extends Error {
	constructor(
		public readonly rejectedPredicates: readonly {
			readonly side: 'desired' | 'database';
			readonly table: string;
			readonly index: string;
			readonly reason?: unknown;
		}[],
		/**
		 * Enum values added by this migration are diagnostic candidates only. They
		 * are collected from the schema diff, never matched to a rejected index.
		 */
		public readonly addedEnumValues: readonly AddedEnumValue[] = [],
	) {
		super(
			`PostgreSQL rejected ${rejectedPredicates.length} partial-index predicate(s); ` +
				'no migration was emitted. If the predicate uses a function from an extension added by this migration, add that extension in a separate migration before the predicate. ' +
				'Inspect rejectedPredicates for identities and causes.' +
				(addedEnumValues.length === 0
					? ''
					: ' Inspect addedEnumValues for same-migration enum candidate labels.'),
		);
		this.name = 'IndexPredicateCanonicalizationError';
	}
}

/**
 * Live PostgreSQL schema diff: introspect, canonicalise desired CHECK
 * constraint expressions, column defaults, and predicates on column-keyed
 * partial indexes through PostgreSQL, then call the pure synchronous
 * schema comparator.
 *
 * If CHECK canonicalisation falls back while the same diff adds a plausibly
 * referenced enum value, the diff is refused. dbsp currently applies each
 * migration in one transaction, and PostgreSQL forbids using a newly added enum
 * value in that same transaction; emitting the CHECK would produce a migration
 * that cannot run. Apply the enum addition by itself first, then add or update
 * the CHECK constraint in a later migration.
 *
 * Index expressions are intentionally not canonicalised here; partial-index
 * predicates on expression-keyed indexes are reported as unavailable and are
 * therefore rejected by strict mode. They need their own key-shape substrate.
 */
export async function comparePgsqlDatabaseSchema(
	adapter: PgsqlAdapter,
	desired: ModelIR,
	options?: ComparePgsqlDatabaseSchemaOptions,
): Promise<SchemaDiff> {
	const physicalDesired =
		options?.dbCasing === undefined
			? undefined
			: createPgPhysicalModel({
					mode: 'logical',
					model: desired,
					schema: options.schema ?? 'public',
					dbCasing: options.dbCasing,
				});
	const desiredModel = physicalDesired?.model ?? desired;
	const declaredSequenceNames =
		options?.declaredSequenceNames ??
		(physicalDesired === undefined
			? undefined
			: declaredSequenceNamesFromInventory(physicalDesired.inventory));
	const rawDatabaseModel = await adapter.introspect(
		toIntrospectionOptions(options),
	);
	for (const [physicalName, authoredName] of declaredSequenceNames ?? []) {
		if (
			physicalName !== authoredName &&
			rawDatabaseModel.sequences?.has(authoredName) === true &&
			rawDatabaseModel.sequences?.has(physicalName) !== true
		)
			throw new LegacySequenceNameError(
				authoredName,
				physicalName,
				options?.schema ?? 'public',
			);
	}
	// Introspection is already in PostgreSQL spelling.  Route it through the
	// physical authority to claim its names without applying a naming plugin.
	const dbModel = createPgPhysicalModel({
		mode: 'physical',
		model: rawDatabaseModel,
		schema: options?.schema ?? 'public',
	}).model;
	const compareCheckConstraints = supportsDDLCheckConstraints(options);
	const useCanonicalizer = options?.canonicalizeExpressions ?? true;
	const rawExpressionSurfaces = new Set<string>();
	let hasRawIndexPredicateFallback = false;
	let rawIndexPredicateFallbackCause: unknown;
	const physicalOptions: ComparePgsqlDatabaseSchemaOptions | undefined =
		physicalDesired === undefined
			? options
			: (() => {
					const { dbCasing: _dbCasing, ...remaining } = options ?? {};
					return remaining;
				})();
	const canonicalModels = useCanonicalizer
		? await canonicalizeLiveExpressions(
				adapter,
				desiredModel,
				dbModel,
				physicalOptions,
				rawExpressionSurfaces,
				(rawFallback, cause) => {
					hasRawIndexPredicateFallback = rawFallback;
					rawIndexPredicateFallbackCause = cause;
				},
			)
		: {
				desired: desiredModel,
				database: dbModel,
				defaultOutcomes: [],
				indexPredicateOutcomes: [],
			};
	const desiredForCompare = canonicalModels.desired;
	const dbModelForCompare = canonicalModels.database;
	if (options?.requireExpressionCanonicalization) {
		if (useCanonicalizer) {
			assertStrictDefaultCanonicalization(
				canonicalModels.defaultOutcomes ?? [],
			);
			assertStrictIndexPredicateCanonicalization(
				canonicalModels.indexPredicateOutcomes ?? [],
			);
			assertNoUncanonicalizedLiveExpressionSurfaces(
				desiredForCompare,
				dbModelForCompare,
				compareCheckConstraints,
				physicalOptions?.dbCasing,
			);
		} else {
			assertNoRawLiveExpressionSurfaces(
				desiredForCompare,
				dbModelForCompare,
				compareCheckConstraints,
			);
		}
	}
	let diff: SchemaDiff;
	try {
		diff = compareSchemata(
			desiredForCompare,
			dbModelForCompare,
			toCompareOptions(physicalOptions, {
				delegateExpressionCanonicalization:
					options?.requireExpressionCanonicalization === true &&
					!useCanonicalizer &&
					compareCheckConstraints,
			}),
		);
	} catch (error) {
		if (
			error instanceof LegacySequenceNameError &&
			error.schema === undefined
		) {
			throw new LegacySequenceNameError(
				error.authoredName,
				error.databaseName,
				options?.schema ?? 'public',
			);
		}
		throw error;
	}
	assertNoRejectedIndexPredicates(
		canonicalModels.indexPredicateOutcomes ?? [],
		diff,
	);

	if (useCanonicalizer) {
		assertNoExpressionKeyedIndexPredicateExclusionWithCreate(diff, options);
	}

	if (
		useCanonicalizer &&
		(rawExpressionSurfaces.size > 0 || hasRawIndexPredicateFallback)
	) {
		assertNoFallbackUsesAddedEnumValue(
			diff,
			rawExpressionSurfaces,
			hasRawIndexPredicateFallback,
			options,
		);
	}

	if (useCanonicalizer && hasRawIndexPredicateFallback) {
		assertNoRawIndexPredicateFallbackWithCreate(
			diff,
			options,
			rawIndexPredicateFallbackCause,
		);
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

function assertStrictIndexPredicateCanonicalization(
	outcomes: readonly {
		readonly side: 'desired' | 'database';
		readonly table: string;
		readonly index: string;
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
					`${outcome.side}.${outcome.table}.INDEX(${outcome.index}).WHERE`,
			),
		);
	}
}

async function canonicalizeLiveExpressions(
	adapter: PgsqlAdapter,
	desired: ModelIR,
	dbModel: ModelIR,
	options: ComparePgsqlDatabaseSchemaOptions | undefined,
	rawExpressionSurfaces: Set<string>,
	recordRawIndexPredicateFallback: (
		rawFallback: boolean,
		cause?: unknown,
	) => void,
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
	readonly indexPredicateOutcomes: readonly {
		readonly side: 'desired' | 'database';
		readonly table: string;
		readonly index: string;
		readonly status: 'canonicalised' | 'unavailable' | 'rejected';
		readonly reason?: unknown;
		readonly unavailableCause?: 'infrastructure' | 'expression-keyed';
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
		const rawFallback = rawIndexPredicateFallbackOutcome(
			canonicalModels.indexPredicateOutcomes ?? [],
		);
		recordRawIndexPredicateFallback(
			rawFallback !== undefined,
			rawFallback?.reason,
		);
		return canonicalModels;
	} catch (error) {
		if (
			options?.requireExpressionCanonicalization === true ||
			!isExpressionCanonicalizationInfrastructureUnavailableError(error)
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
		const rawFallback = rawIndexPredicateFallbackOutcome(
			fallback.indexPredicateOutcomes ?? [],
		);
		recordRawIndexPredicateFallback(
			rawFallback !== undefined,
			rawFallback?.reason,
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
			includeIndexPredicates: false,
		}),
		...collectExpressionSurfaces('database', dbModel, {
			includeColumnDefaults: false,
			includeCheckConstraints: false,
			includeIndexPredicates: false,
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
							column: current.name,
						}
					: {
							kind: 'check_constraint',
							table: current.table,
							constraint: current.name,
						},
				current.desiredExpressionHash,
				current.databaseExpressionHash,
			);
		}
	}
}

interface ExpressionSurfaceDrift {
	readonly kind: 'check_constraint' | 'column_default';
	readonly table: string;
	readonly name: string;
	readonly desiredExpressionHash: string;
	readonly databaseExpressionHash: string;
}

function collectCheckExpressionDrifts(
	diff: SchemaDiff,
): Map<string, ExpressionSurfaceDrift> {
	const dropped = new Map<string, string>();
	const drifts = new Map<string, ExpressionSurfaceDrift>();

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
				name: check.name,
				desiredExpressionHash: hashExpression(check.expression),
				databaseExpressionHash: hashExpression(databaseExpression),
			});
		}

		if (change.kind === 'alter_column_default' && change.column !== undefined) {
			const key = driftKey('column_default', change.table, change.column);
			drifts.set(key, {
				kind: 'column_default',
				table: change.table,
				name: change.column,
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
 * A rejected predicate is terminal. Added enum values are reported only as
 * candidates: labels are display diagnostics, never a desired-to-database key
 * or evidence inferred by parsing predicate SQL.
 */
function assertNoRejectedIndexPredicates(
	outcomes: readonly {
		readonly side: 'desired' | 'database';
		readonly table: string;
		readonly index: string;
		readonly status: 'canonicalised' | 'unavailable' | 'rejected';
		readonly reason?: unknown;
	}[],
	diff: SchemaDiff,
): void {
	const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
	if (rejected.length === 0) return;

	throw new IndexPredicateCanonicalizationError(
		rejected,
		collectAddedEnumValues(diff),
	);
}

function assertNoFallbackUsesAddedEnumValue(
	diff: SchemaDiff,
	rawExpressionSurfaces: ReadonlySet<string>,
	hasRawIndexPredicateFallback: boolean,
	options: ComparePgsqlDatabaseSchemaOptions | undefined,
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

	if (
		hasRawIndexPredicateFallback &&
		hasEmittedPredicateBearingCreateIndex(diff, options)
	) {
		throw new PartialIndexPredicateNewEnumValueError(addedEnumValues);
	}
}

function assertNoExpressionKeyedIndexPredicateExclusionWithCreate(
	diff: SchemaDiff,
	options: ComparePgsqlDatabaseSchemaOptions | undefined,
): void {
	const changes = diff.changes.filter((change) => {
		if (change.kind !== 'create_index' && change.kind !== 'drop_index') {
			return false;
		}
		const index = change.meta?.index as IndexIR | undefined;
		return (
			index !== undefined &&
			index.where !== undefined &&
			(index.expressions?.length ?? 0) > 0
		);
	});
	if (changes.length === 0) return;
	if (!hasEmittedPredicateBearingCreateIndex({ ...diff, changes }, options)) {
		return;
	}
	throw new ExpressionKeyedIndexPredicateCanonicalizationUnsupportedError(
		changes.map((change) => {
			const index = change.meta?.index as IndexIR;
			return {
				side: change.kind === 'create_index' ? 'desired' : 'database',
				table: change.table,
				index: index.name ?? `<unnamed:${index.columns.join(',')}>`,
			};
		}),
	);
}

function assertNoRawIndexPredicateFallbackWithCreate(
	diff: SchemaDiff,
	options: ComparePgsqlDatabaseSchemaOptions | undefined,
	cause: unknown,
): void {
	if (hasEmittedPredicateBearingCreateIndex(diff, options)) {
		throw new RawIndexPredicateFallbackError(cause);
	}
}

/** True when UP or DOWN SQL emits a partial-index CREATE statement. */
function hasEmittedPredicateBearingCreateIndex(
	diff: SchemaDiff,
	options: ComparePgsqlDatabaseSchemaOptions | undefined,
): boolean {
	const migrationOptions = {
		...(options?.schema === undefined ? {} : { schemaName: options.schema }),
		...(options?.dialectCapabilities === undefined
			? {}
			: { dialectCapabilities: options.dialectCapabilities }),
	};
	return [
		...generateMigrationSQL(diff, migrationOptions),
		...generateDownSQL(diff, migrationOptions),
	].some((statement) =>
		/\bCREATE\s+(?:UNIQUE\s+)?INDEX\b[\s\S]*\bWHERE\b/iu.test(statement),
	);
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
		...(options?.dialectCapabilities !== undefined
			? { dialectCapabilities: options.dialectCapabilities }
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

function rawIndexPredicateFallbackOutcome(
	outcomes: readonly {
		readonly table: string;
		readonly index: string;
		readonly status: 'canonicalised' | 'unavailable' | 'rejected';
		readonly unavailableCause?: 'infrastructure' | 'expression-keyed';
		readonly reason?: unknown;
	}[],
):
	| {
			readonly table: string;
			readonly index: string;
			readonly status: 'canonicalised' | 'unavailable' | 'rejected';
			readonly unavailableCause?: 'infrastructure' | 'expression-keyed';
			readonly reason?: unknown;
	  }
	| undefined {
	return outcomes.find(
		(outcome) =>
			outcome.status === 'unavailable' &&
			outcome.unavailableCause !== 'expression-keyed',
	);
}

function recordRawCheckExpressionSurface(
	rawExpressionSurfaces: Set<string>,
	warning: CheckConstraintCanonicalizationWarning,
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
		...(options?.schema !== undefined ? { schema: options.schema } : {}),
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
