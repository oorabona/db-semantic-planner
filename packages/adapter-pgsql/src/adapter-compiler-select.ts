import {
	assertNoManyToManyRootRelations,
	assertNoRecursiveRootRelations,
} from './condition-compiler-factory.js';
import { lowerResolvedIncludes } from './resolved-include-decisions.js';
/**
 * SELECT compilation: converts PlanReport to CompiledQuery.
 * Extracted from PgAdapter.compile().
 *
 * @internal
 */

import { POSTGRESQL_CAPABILITIES } from '@dbsp/core';
import {
	countDistinctRelationPathsByName,
	normalizeRecursiveIncludeOptions,
	observeIncludeDecisions,
	resolveReportIncludes,
	validateIncludeInput,
	validateIncludeOptions,
	validateIncludeOrdering,
	validateRecursiveIncludeStrategy,
	validateResolvedIncludeStrategy,
} from '@dbsp/core/internal';
import type {
	CompiledQuery,
	CompileOptions,
	IncludeIntent,
	JoinIntent,
	ModelIR,
	OutputDescriptor,
	OutputValueShape,
	PlanReport,
	QueryIntent,
	WhereIntent,
} from '@dbsp/types';
import { resolveOutputReadHandling, toColumnList } from '@dbsp/types';
import {
	belongsToManyJoinIncludeRefusal,
	getTrustedNqlRelationFilterFields,
	type Mutable,
	resolveIncludeRelationName,
} from '@dbsp/types/internal';
import type { Node } from '@pgsql/types';
import type { AdapterCompilerDeps } from './adapter-compiler-deps.js';
import { defaultFkDerivation } from './assert-field.js';
import { funcCall, sqlRangeVar } from './ast-helpers.js';
import {
	declaredRelationBindingFor,
	queryScope,
	relationBinding,
	relationBindingFor,
} from './binding-registry.js';
import {
	aggregateProjectionIdentity,
	compiledProjectionLabels,
	rootProjectionLabels,
} from './column-metadata.js';
import { compileWhereIntent, type WhereCompilerCtx } from './compile-where.js';
import {
	type CompilerOptions,
	compilePlan,
	type PlanDecision,
	type PrecompiledJoinDecision,
	type SimplifiedPlanReport,
} from './compiler.js';
import { inferPgArrayType, stripArraySuffix } from './compiler-utils.js';
import { validateDbType } from './db-type.js';
import { declaredColumnName } from './declared-name-resolver.js';
import { createCompilerState } from './handlers/types.js';
import { resolveIncludePayloadShapes } from './include-payload-shape.js';
import { intentToDecisions } from './intent-to-decisions.js';
import {
	jsonAggColumnDescriptor,
	jsonAggContainerShape,
	resolveJsonAggColumnReadHandling,
} from './json-agg-read-handling.js';
import { createTypeCastParamRef } from './param-ref.js';
import {
	convertDottedFieldsToExists,
	enrichExistsDecisionsInPlace,
} from './plan-decision-extractor.js';
import {
	finalizeEnvelope,
	fromAstProjection,
	type ProjectionEnvelope,
	supplementOutputDescriptors,
} from './projection-envelope.js';
import {
	assertProjectedJsonContainerCanBeAggregated,
	resolveRelationTarget,
} from './relation-target-projection.js';
import {
	identifierText,
	queryLocal,
	resolveDeclaredIdentifier,
} from './sql-identifier.js';
import { stableJson } from './transition/stable-json.js';

/** Exact source/key duplicates have one SQL projection, including at the root. */
function deduplicateRootProjection(
	intent: QueryIntent | undefined,
): QueryIntent | undefined {
	const select = intent?.select;
	if (!intent || !select) return intent;
	if (select.type === 'fields')
		return {
			...intent,
			select: { ...select, fields: [...new Set(select.fields)] },
		};
	if (select.type === 'aggregate') {
		const seen = new Set<string>();
		const aliased = new Map(
			select.aggregates
				.filter((aggregate) => aggregate.as !== undefined)
				.map((aggregate) => [
					aggregateProjectionIdentity(aggregate),
					aggregate,
				]),
		);
		return {
			...intent,
			select: {
				...select,
				...(select.fields !== undefined && {
					fields: [...new Set(select.fields)],
				}),
				aggregates: select.aggregates
					.map(
						(aggregate) =>
							aliased.get(aggregateProjectionIdentity(aggregate)) ?? aggregate,
					)
					.filter((aggregate) => {
						const identity = aggregateProjectionIdentity(aggregate);
						if (seen.has(identity)) return false;
						seen.add(identity);
						return true;
					}),
			},
		};
	}
	if (select.type !== 'expressions' || !Array.isArray(select.columns))
		return intent;
	const seen = new Set<string>();
	return {
		...intent,
		select: {
			...select,
			columns: select.columns.filter((expr) => {
				const identity =
					expr.kind === 'column' || expr.kind === 'columnAlias'
						? stableJson([
								expr.column,
								expr.kind === 'column' ? (expr.as ?? expr.column) : expr.alias,
							])
						: expr.kind === 'aggregate'
							? aggregateProjectionIdentity(expr)
							: stableJson(expr);
				if (seen.has(identity)) return false;
				seen.add(identity);
				return true;
			}),
		},
	};
}

/** Establish the output authority of an unnest() range at the point it enters. */
function batchValuesBinding(
	alias: string,
	columns: readonly string[],
): ReturnType<typeof relationBinding> {
	return relationBinding({
		qualifier: queryLocal(alias),
		kind: 'batch-values',
		outputs: new Map(
			columns.map((column) => [
				queryLocal(column),
				{
					outputKey: queryLocal(column),
					logicalKey: column,
					source: { kind: 'expression', reason: 'BatchValues output' },
					shape: { kind: 'scalar', cardinality: 'one' },
				},
			]),
		),
	});
}

/** Root relations enter every SELECT scope before any JOIN/WHERE reference. */
function sourceBinding(
	rootTable: string,
	deps: AdapterCompilerDeps,
): ReturnType<typeof relationBinding> {
	const existing =
		relationBindingFor(deps.scope, queryLocal(rootTable)) ??
		declaredRelationBindingFor(deps.scope, rootTable);
	if (existing !== undefined) return existing;
	return relationBinding({
		qualifier: resolveDeclaredIdentifier(
			deps.declaredNames,
			deps.dbCasing ?? 'preserve',
			{ kind: 'table', table: rootTable },
		),
		kind: 'declared-table',
		logicalTable: rootTable,
	});
}

function hasSourceBinding(
	rootTable: string,
	deps: AdapterCompilerDeps,
): boolean {
	return (
		relationBindingFor(deps.scope, queryLocal(rootTable)) !== undefined ||
		declaredRelationBindingFor(deps.scope, rootTable) !== undefined
	);
}

// ============================================================================
// Compile-time type-name safety guard (covers forged BatchValuesRef vector)
// ============================================================================

/**
 * Validate a PostgreSQL type name at compile time using the adapter db-type guard.
 */
function assertSafeTypeName(typeName: string, colIndex: number): void {
	const raw = typeName.trim();
	if (raw.length === 0) {
		throw new Error(
			`BatchValues compile error: type name at column index ${colIndex} must not be empty.`,
		);
	}

	try {
		validateDbType(raw);
	} catch (error) {
		const reason = error instanceof Error ? ` ${error.message}` : '';
		throw new Error(
			`BatchValues compile error: unsafe type name '${typeName}' at column index ${colIndex}.${reason}`,
		);
	}
}

/**
 * Compile JoinIntent[] from a QueryIntent into PlanDecision[] of type 'join'.
 *
 * Two modes:
 * - Relation mode (no `on`): FK auto-resolved from model, like `include` but flat (no hydration).
 * - Table mode (`on` present): Explicit ON condition compiled via compileWhereIntent().
 *
 * The resulting decisions are appended to `allDecisions` before `compilePlan()`.
 */

// ============================================================================
// Batch Values RangeFunction builder (shared by JOIN and FROM cases)
// ============================================================================

type BatchValuesRangeFnResult = {
	rangeFunction: Node;
	params: unknown[];
};

/**
 * Build a `unnest($1::type[], ...) AS alias(col1, col2 [, ord])` RangeFunction node
 * from a BatchValuesJoinPayload.
 *
 * The returned `params` array contains the column data arrays in order; they must
 * be spliced into CompilerState.parameters BEFORE other query params so that the
 * $N refs in the AST node match the right positions.
 *
 * @param bv - The batch values payload (columns, data, types, alias, ordinality).
 * @param startParamIndex - The 1-based index for the first ParamRef ($N).
 *   Pass 1 when the batch params are first; pass current paramIndex+1 otherwise.
 */
function buildBatchValuesRangeFn(
	bv: import('@dbsp/types').BatchValuesJoinPayload,
	startParamIndex: number,
	aliasOverride?: string,
): BatchValuesRangeFnResult {
	const params: unknown[] = [];
	let paramIdx = startParamIndex - 1;
	const effectiveAlias = aliasOverride ?? bv.alias;

	// Compile-time revalidation: covers the forged-ref vector where a
	// BatchValuesRef is constructed directly without going through batchValues().
	for (let ci = 0; ci < bv.columns.length; ci++) {
		const rawType = bv.types[ci];
		if (rawType) assertSafeTypeName(rawType, ci);
	}

	const unnestArgs: Node[] = bv.columns.map((col, i) => {
		const colArray: unknown[] = (bv.data[i] as unknown[]) ?? [];

		let pgBaseType: string;
		if (bv.types[i]) {
			// Explicit type provided by caller: preserve faithfully — do NOT route
			// through mapToPgBaseType() which normalises numeric→float8, varchar→text,
			// etc.  Only strip a single trailing "[]" the user may have written (the
			// cast layer appends exactly one "[]" via createTypeCastParamRef isArray=true),
			// so "int4[]" → base "int4" → emits CAST($N AS int4[]) not int4[][].
			const rawType = bv.types[i] as string;
			pgBaseType = rawType.endsWith('[]') ? rawType.slice(0, -2) : rawType;
		} else {
			// No explicit type: infer from the schema or sample value (existing behavior).
			const sampleValue = colArray.find((v) => v !== null && v !== undefined);
			const pgArrayType = inferPgArrayType(col, {}, sampleValue);
			pgBaseType = stripArraySuffix(pgArrayType);
		}

		params.push(colArray);
		paramIdx++;
		return createTypeCastParamRef(paramIdx, pgBaseType, true);
	});

	const unnestCall = funcCall('unnest', unnestArgs);
	const colnames = [...bv.columns, ...(bv.ordinality ? ['ord'] : [])].map(
		(c) => ({ String: { sval: c } }),
	);

	const rangeFunction: Node = {
		RangeFunction: {
			functions: [{ List: { items: [unnestCall] } }],
			ordinality: bv.ordinality,
			alias: { aliasname: effectiveAlias, colnames },
		},
	};

	return { rangeFunction, params };
}

function compileJoinIntents(
	joins: readonly JoinIntent[],
	rootTable: string,
	schemaName: string | undefined,
	deps: AdapterCompilerDeps,
): PlanDecision[] {
	if (joins.length === 0) return [];

	const model = deps.model;
	const deriveFk = deps.deriveFk ?? defaultFkDerivation;
	const defaultPk = deps.defaultPk;
	const results: PlanDecision[] = [];
	let joinScope = queryScope([
		...(deps.scope?.bindings.values() ?? []),
		...(!hasSourceBinding(rootTable, deps)
			? [sourceBinding(rootTable, deps)]
			: []),
	]);

	// Reserve both public and emitted root names before binding manual joins.
	const occupiedQualifiers = new Set<string>([
		rootTable,
		sourceBinding(rootTable, deps).qualifier,
	]);
	for (const intent of joins) {
		const qualifier =
			intent.alias ??
			intent.relation ??
			intent.batchValues?.alias ??
			intent.table;
		if (qualifier !== undefined && occupiedQualifiers.has(qualifier)) {
			throw new Error(`Query scope already binds qualifier '${qualifier}'.`);
		}
		if (qualifier !== undefined) occupiedQualifiers.add(qualifier);
		if (intent.relation !== undefined) {
			// ── Relation mode: resolve FK from model ──────────────────────────
			// If no model available, we can't resolve the FK — skip with warning.
			if (!model) {
				throw new Error(
					`join('${intent.relation}'): relation-mode join requires a model for FK resolution.`,
				);
			}

			const relationsFromRoot = model.getRelationsFrom(rootTable);
			// Match only by relation name for FK resolution.
			// The alias is only used for the output JOIN alias — using it for FK lookup
			// would allow `.join('callee', { as: 'caller' })` to resolve against the
			// wrong relation when 'caller' happens to be another relation name.
			const rel = relationsFromRoot.find((r) => r.name === intent.relation);

			if (!rel) {
				throw new Error(
					`join('${intent.relation}'): relation not found on table '${rootTable}'. ` +
						`Available: ${relationsFromRoot.map((r) => r.name).join(', ')}`,
				);
			}

			if (rel.type === 'belongsToMany')
				throw new Error(
					belongsToManyJoinIncludeRefusal(`${rootTable}.${rel.name}`),
				);
			// Derive FK direction from relation type
			// - belongsTo: FK is on the source (root) table → sourceColumn=FK, targetColumn=PK
			// - hasMany/hasOne: FK is on the target table → sourceColumn=PK, targetColumn=FK
			const isBelongsTo = rel.type === 'belongsTo';
			const rawFk = toColumnList(rel.foreignKey);
			const fkColumns =
				rawFk.length > 0
					? rawFk
					: [deriveFk(isBelongsTo ? rootTable : rel.target, defaultPk)];
			const sourceKey = toColumnList(rel.sourceKey);
			const targetKey = toColumnList(rel.targetKey);
			const sourceColumn = isBelongsTo
				? fkColumns
				: sourceKey.length > 0
					? sourceKey
					: [defaultPk];
			const targetColumn = isBelongsTo
				? targetKey.length > 0
					? targetKey
					: [defaultPk]
				: fkColumns;
			const alias = intent.alias ?? intent.relation;

			joinScope = queryScope([
				...Array.from(joinScope.bindings.values()).filter(
					(binding) => identifierText(binding.qualifier) !== alias,
				),
				relationBinding({
					qualifier: queryLocal(alias),
					kind: 'declared-table',
					logicalTable: rel.target,
				}),
			]);

			results.push({
				type: 'join',
				targetTable: rel.target,
				alias,
				relationName: intent.relation,
				sourceColumn,
				targetColumn,
				joinType: intent.type,
			});
		} else if (intent.batchValues !== undefined) {
			// ── BatchValues mode: unnest($N::type[], ...) AS alias(col1, col2) ──
			// Compiles a batch-values join: the rarg is a RangeFunction wrapping
			// unnest() instead of a plain RangeVar.
			// Params are $1, $2, ... (1-indexed); compiler.ts splices them first.
			const bv = intent.batchValues;
			const alias = intent.alias ?? bv.alias;

			const { rangeFunction, params: bvParams } = buildBatchValuesRangeFn(
				bv,
				1,
				alias,
			);

			// Compile the ON condition.
			// We use a minimal param state with paramIndex already advanced past bvParams
			// so that any ON condition params (rare for batch joins) get correct indices.
			// The ON params start at bvParams.length + 1 (1-indexed).
			const bvOnParamState = createCompilerState();
			bvOnParamState.paramIndex = bvParams.length;

			joinScope = queryScope([
				...Array.from(joinScope.bindings.values()).filter(
					(binding) => identifierText(binding.qualifier) !== alias,
				),
				batchValuesBinding(alias, [
					...bv.columns,
					...(bv.ordinality ? ['ord'] : []),
				]),
			]);
			const bvCtx: WhereCompilerCtx = {
				rootTable,
				aliases: new Map<string, string>(),
				paramState: bvOnParamState,
				outerTable: alias,
				...(schemaName !== undefined && { schemaName }),
				scope: joinScope,
				dbCasing: deps.dbCasing ?? 'preserve',
				...(deps.declaredNames !== undefined && {
					declaredNames: deps.declaredNames,
				}),
				...(deps.relationTargetProjections !== undefined && {
					relationTargetProjections: deps.relationTargetProjections,
				}),
				...(model !== undefined && { model }),
				...(deps.dialectCapabilities !== undefined && {
					dialectCapabilities: deps.dialectCapabilities,
				}),
				compileSubquery: () => {
					throw new Error(
						'Subquery in BatchValues JOIN ON condition is not supported.',
					);
				},
			};

			const onNode: Node = compileWhereIntent(intent.on, bvCtx);

			// Combine bv unnest params + any ON condition params into batchValuesParams.
			// compiler.ts splices all of these BEFORE other query params so that $1/$2/...
			// in the RangeFunction and ON condition align with parameters[0], [1], ...
			const allBvParams: unknown[] = [
				...bvParams,
				...bvOnParamState.parameters,
			];

			results.push({
				type: 'join',
				targetTable: alias,
				alias,
				joinType: intent.type,
				joinRarg: rangeFunction,
				joinOnNode: onNode,
				// batchValuesParams are spliced into this.state.parameters BEFORE
				// other params in compiler.ts, so $1/$2/... refs align correctly.
				batchValuesParams: allBvParams,
			});
		} else {
			// ── Table mode: explicit ON condition ─────────────────────────────
			// Compile the ON WhereIntent to an AST Node via compileWhereIntent.
			// ON conditions may include bound params; capture them with the precompiled
			// join so compiler.ts can merge them into the query's live param sequence.
			const paramState = createCompilerState();

			const tableAlias = intent.alias ?? intent.table;

			// Pre-populate aliases so ref("rootTable.col") and similar expressions
			// resolve the correct table qualifier when the alias differs from the
			// base table name.
			const tableAliasMap = new Map<string, string>();
			tableAliasMap.set(rootTable, rootTable);
			if (tableAlias !== rootTable) {
				// A manual join alias is query-local. Preserve it in ON references;
				// rangeVar() emits the same spelling rather than a physical table name.
				tableAliasMap.set(tableAlias, tableAlias);
			}
			const joinedSource = relationBindingFor(
				deps.scope,
				queryLocal(intent.table),
			);
			const joinedBinding =
				joinedSource?.kind === 'declared-table'
					? relationBinding({
							qualifier: queryLocal(tableAlias),
							kind: 'declared-table',
							logicalTable: joinedSource.logicalTable ?? intent.table,
						})
					: joinedSource !== undefined
						? relationBinding({
								qualifier: queryLocal(tableAlias),
								kind: 'join-alias',
								...(joinedSource.outputs !== undefined && {
									outputs: joinedSource.outputs,
								}),
							})
						: relationBinding({
								qualifier: queryLocal(tableAlias),
								kind: 'declared-table',
								logicalTable: intent.table,
							});
			joinScope = queryScope([
				...Array.from(joinScope.bindings.values()).filter(
					(binding) => identifierText(binding.qualifier) !== tableAlias,
				),
				joinedBinding,
			]);
			const ctx: WhereCompilerCtx = {
				rootTable,
				aliases: tableAliasMap,
				paramState,
				// outerTable = tableAlias so FieldRef(scope:'outer') resolves to the
				// joined alias (e.g. 'e2' in self-join ON conditions).
				outerTable: tableAlias,
				...(schemaName !== undefined && { schemaName }),
				scope: joinScope,
				dbCasing: deps.dbCasing ?? 'preserve',
				...(deps.declaredNames !== undefined && {
					declaredNames: deps.declaredNames,
				}),
				...(deps.relationTargetProjections !== undefined && {
					relationTargetProjections: deps.relationTargetProjections,
				}),
				...(model !== undefined && { model }),
				...(deps.dialectCapabilities !== undefined && {
					dialectCapabilities: deps.dialectCapabilities,
				}),
				compileSubquery: () => {
					throw new Error('Subquery in JOIN ON condition is not supported.');
				},
			};

			const onNode: Node = compileWhereIntent(intent.on, ctx);

			// Store rarg + onNode separately — the 'join' case in compiler.ts wraps
			// from[0] as larg so multiple .join() calls chain correctly.
			const joinedRangeVar = sqlRangeVar(
				joinedSource?.qualifier ??
					resolveDeclaredIdentifier(
						deps.declaredNames,
						deps.dbCasing ?? 'preserve',
						{ kind: 'table', table: intent.table },
					),
				queryLocal(tableAlias),
				joinedSource?.kind === 'cte-bind' ||
					joinedSource?.kind === 'batch-values'
					? undefined
					: schemaName === undefined
						? undefined
						: queryLocal(schemaName),
			);

			const joinDecision: PrecompiledJoinDecision = {
				type: 'join',
				targetTable: intent.table,
				alias: tableAlias,
				joinType: intent.type,
				joinRarg: joinedRangeVar,
				joinOnNode: onNode,
				joinOnParams: paramState.parameters,
			};
			results.push(joinDecision);
		}
	}

	return results;
}

// ============================================================================
// Phase helpers — extracted from compileSelect for CC reduction
// ============================================================================

/** Visit the exact-path consumers retained in include decision trees. */
function* includeDecisions(
	decisions: readonly PlanDecision[],
): Generator<PlanDecision> {
	for (const decision of decisions) {
		if (decision.type !== 'includeStrategy') continue;
		yield decision;
		yield* includeDecisions(decision.children ?? []);
	}
}

function includedRelationPaths(
	decisions: readonly PlanDecision[],
): Set<string> {
	const paths = new Set<string>();
	for (const decision of includeDecisions(decisions)) {
		const path = decision.relationPath ?? decision.relationName;
		if (path) paths.add(path);
	}
	return paths;
}

type RelationColumnEntry = {
	col: string;
	alias?: string;
	defaultLabel?: boolean;
	nqlLabel?: boolean;
};

/**
 * Collect specific columns per relation from selectRelationColumn decisions.
 *
 * Key: full relation path (e.g. 'callee' for 1-hop, 'callee.file' for 2-hop).
 * This lets relationColumn('callee.file', 'path', 'fp') target the leaf
 * includeStrategy decision rather than the 1st-hop one.
 */
function buildRelationColumnsMap(
	decisions: PlanDecision[],
): Map<string, RelationColumnEntry[]> {
	const map = new Map<string, RelationColumnEntry[]>();
	for (const decision of includeDecisions(decisions)) {
		const requests = decision.resolvedInclude?.projectionRequests;
		const path = decision.relationPath ?? decision.relationName;
		if (requests?.length && path) map.set(path, [...requests]);
	}
	return map;
}

/**
 * Inject user-specified columns from relationColumnsMap into matching
 * includeStrategy decisions, then validate them against the model schema.
 */
function injectAndValidateRelationColumns(
	enrichedUnifiedDecisions: PlanDecision[],
	relationColumnsMap: Map<string, RelationColumnEntry[]>,
	model: import('@dbsp/types').ModelIR | undefined,
): void {
	if (relationColumnsMap.size === 0) return;

	// Inject collected columns and aliases into matching includeStrategy decisions
	for (const d of includeDecisions(enrichedUnifiedDecisions)) {
		if (d.type === 'includeStrategy' && d.relationName) {
			const mapKey = (d.relationPath as string | undefined) ?? d.relationName;
			const entries = mapKey ? relationColumnsMap.get(mapKey) : undefined;
			if (entries) {
				const mut = d as Mutable<PlanDecision>;
				// columns: plain string array (preserves existing contract)
				mut.columns = entries.map((e) => e.col);
				mut.payloadColumnRequests = entries;
				// columnAliases: map col -> user alias (only non-trivial aliases)
				const aliasMap: Record<string, string> = {};
				mut.defaultRelationColumnLabels = Object.fromEntries(
					entries.map((e) => [e.col, e.defaultLabel === true]),
				);
				for (const { col, alias } of entries) {
					if (alias) aliasMap[col] = alias;
				}
				if (Object.keys(aliasMap).length > 0) {
					mut.columnAliases = aliasMap;
				}
			}
		}
	}

	// Validate injected columns exist in target table schema
	if (!model) return;
	for (const d of includeDecisions(enrichedUnifiedDecisions)) {
		if (
			d.type === 'includeStrategy' &&
			d.columns &&
			d.targetTable &&
			!(
				(d.columns as string[]).length === 1 &&
				(d.columns as string[])[0] === '*'
			)
		) {
			const targetTable = model.getTable(d.targetTable as string);
			if (targetTable) {
				const validColumnNames = new Set(
					targetTable.columns.map((c) => c.name),
				);
				const invalid = (d.columns as string[]).filter(
					(c) => c !== '*' && !validColumnNames.has(c),
				);
				if (invalid.length > 0) {
					throw new Error(
						`Unknown column(s) ${invalid.map((c) => `'${c}'`).join(', ')} ` +
							`in relation '${d.relationName}' (table '${d.targetTable}'). ` +
							`Available: ${[...validColumnNames].join(', ')}`,
					);
				}
			}
		}
	}
}

/**
 * Set the auto-hydration prefix for join includes.
 *
 * Explicit relationColumn(..., as) aliases are preserved by columnAliases. For
 * fallback aliases, keep the historical relation-name prefix when that relation
 * name appears through a single include path; use the full relation-dotted path
 * when the same relation name appears through multiple paths.
 */
function applyJoinHydrationPrefixes(decisions: PlanDecision[]): void {
	const usages: Array<{ relationName: string; relationPath: string }> = [];
	for (const d of decisions) {
		if (
			d.type !== 'includeStrategy' ||
			d.choice !== 'join' ||
			!d.relationName
		) {
			continue;
		}
		const relationName = d.relationName as string;
		const relationPath = (d.relationPath as string | undefined) ?? relationName;
		usages.push({ relationName, relationPath });
	}

	const pathCountsByRelation = countDistinctRelationPathsByName(usages);
	for (const d of decisions) {
		if (
			d.type !== 'includeStrategy' ||
			d.choice !== 'join' ||
			!d.relationName
		) {
			continue;
		}
		const relationName = d.relationName as string;
		const relationPath = (d.relationPath as string | undefined) ?? relationName;
		const usesFullPath = (pathCountsByRelation.get(relationName) ?? 0) > 1;
		(d as Mutable<PlanDecision>).hydrationPrefix = usesFullPath
			? relationPath
			: relationName;
	}
}

/**
 * Enrich range operator decisions with `dataType` from the model.
 * PostgreSQL requires explicit type casts for range parameters (contains/containedBy/overlaps).
 * Mutates `allDecisions` in place.
 */
function enrichRangeDecisions(
	allDecisions: PlanDecision[],
	model: import('@dbsp/types').ModelIR | undefined,
	rootTable: string,
): void {
	if (!model) return;
	for (let i = 0; i < allDecisions.length; i++) {
		const d = allDecisions[i];
		if (
			d &&
			d.type === 'where' &&
			(d.operator === 'contains' ||
				d.operator === 'containedBy' ||
				d.operator === 'overlaps')
		) {
			const tableName = d.table || rootTable;
			const table = model.getTable(tableName);
			if (table) {
				const col = table.columns.find((c) => c.name === d.column);
				if (col?.type.endsWith('range')) {
					allDecisions[i] = { ...d, dataType: col.type } as typeof d;
				}
			}
		}
	}
}

function jsonAggProjectedColumns(
	decision: PlanDecision,
	targetTable: string,
	model: ModelIR | undefined,
	deps?: AdapterCompilerDeps,
): readonly string[] | undefined {
	if (decision.emptyProjection === true) return [];
	const requested = decision.columns;
	const hasExplicitProjection =
		requested &&
		requested.length > 0 &&
		!(requested.length === 1 && requested[0] === '*');
	if (hasExplicitProjection) return requested;
	const projected = deps
		? resolveRelationTarget(queryLocal(targetTable), deps).outputs
		: undefined;
	if (projected !== undefined) return [...projected.keys()];

	const table = model?.getTable(targetTable);
	return table ? table.columns.map((column) => column.name) : requested;
}

function buildJsonAggOutputDescriptor(
	decision: PlanDecision,
	targetTable: string,
	model: ModelIR | undefined,
	deps?: AdapterCompilerDeps,
): OutputDescriptor | undefined {
	const relation = decision.relation ?? decision.relationName;
	if (!relation) return undefined;
	const shape = jsonAggContainerShape(decision.relationType);
	const columns = jsonAggProjectedColumns(decision, targetTable, model, deps);
	if (!columns || columns.length === 0) return undefined;
	const projected = deps
		? resolveRelationTarget(queryLocal(targetTable), deps).outputs
		: undefined;
	if (projected !== undefined) {
		for (const columnName of columns) {
			const descriptor = projected.get(columnName);
			if (!descriptor) continue;
			assertProjectedJsonContainerCanBeAggregated(
				resolveRelationTarget(queryLocal(targetTable), deps!),
				descriptor,
			);
			if (resolveOutputReadHandling({ ...descriptor, shape }).kind !== 'none') {
				return { ...descriptor, outputKey: `${relation}_json`, shape };
			}
		}
		return undefined;
	}
	const table = model?.getTable(targetTable);
	if (!table) return undefined;

	for (const columnName of columns) {
		if (columnName === '*') continue;
		const column = table.columns.find(
			(candidate) => candidate.name === columnName,
		);
		if (!column) continue;
		const descriptor = jsonAggColumnDescriptor(targetTable, column, shape);
		if (resolveJsonAggColumnReadHandling(targetTable, column, shape)) {
			return {
				...descriptor,
				outputKey: `${relation}_json`,
			};
		}
	}
	return undefined;
}

function buildJsonAggOutputDescriptors(
	decisions: readonly PlanDecision[],
	model: ModelIR | undefined,
	deps?: AdapterCompilerDeps,
): readonly OutputDescriptor[] {
	const descriptors: OutputDescriptor[] = [];
	for (const decision of decisions) {
		if (decision.type !== 'includeStrategy' || decision.choice !== 'json_agg') {
			continue;
		}
		const targetTable = decision.targetTable;
		const descriptor = targetTable
			? buildJsonAggOutputDescriptor(decision, targetTable, model, deps)
			: undefined;
		if (descriptor) descriptors.push(descriptor);
	}
	return descriptors;
}

function trustedRelationColumnShape(
	cardinality: 'one' | 'many' | undefined,
): OutputValueShape | undefined {
	if (cardinality === 'one') {
		return { kind: 'scalar', cardinality: 'one' };
	}
	if (cardinality === 'many') {
		return { kind: 'array', cardinality: 'many', aggregate: 'json_agg' };
	}
	return undefined;
}

function buildTrustedRelationColumnOutputDescriptor(
	decision: PlanDecision,
	model: ModelIR | undefined,
	deps: AdapterCompilerDeps,
): OutputDescriptor | undefined {
	if (decision.type !== 'selectRelationColumn') return undefined;
	const trusted = getTrustedNqlRelationFilterFields(decision);
	if (trusted?.selectedColumn === undefined) return undefined;
	const shape = trustedRelationColumnShape(trusted.cardinality);
	if (shape === undefined) return undefined;
	const sourceTable = trusted.hops.at(-1)?.target ?? trusted.targetTable;
	const table = model?.getTable(sourceTable);
	const column = table?.columns.find(
		(candidate) =>
			candidate.name === trusted.selectedColumn ||
			declaredColumnName(deps.declaredNames, sourceTable, candidate.name) ===
				trusted.selectedColumn,
	);
	if (table === undefined || column === undefined) return undefined;
	const js = column.type === 'bigint' ? column.js : undefined;
	return {
		outputKey:
			decision.alias ??
			declaredColumnName(deps.declaredNames, table.name, column.name),
		logicalKey: decision.alias ?? column.name,
		source: {
			kind: 'modelColumn',
			table: table.name,
			column: column.name,
			...(js !== undefined ? { js } : {}),
		},
		shape,
	};
}

function buildTrustedRelationColumnOutputDescriptors(
	decisions: readonly PlanDecision[],
	model: ModelIR | undefined,
	deps: AdapterCompilerDeps,
): readonly OutputDescriptor[] {
	const descriptors: OutputDescriptor[] = [];
	for (const decision of decisions) {
		const descriptor = buildTrustedRelationColumnOutputDescriptor(
			decision,
			model,
			deps,
		);
		if (descriptor) descriptors.push(descriptor);
	}
	return descriptors;
}

function physicalScalarRelationColumnTarget(
	relationPath: string,
	rootTable: string,
	model: ModelIR | undefined,
): string | undefined {
	if (model === undefined) return undefined;
	const segments = relationPath.split('.').filter(Boolean);
	if (segments.length === 0) return undefined;

	let currentTable = rootTable;
	for (const segment of segments) {
		const relation = model.getRelation(`${currentTable}.${segment}`);
		if (
			relation === undefined ||
			relation.recursive !== undefined ||
			relation.cardinality !== 'one' ||
			(relation.type !== 'belongsTo' && relation.type !== 'hasOne')
		) {
			return undefined;
		}
		currentTable = relation.target;
	}
	return currentTable;
}

function buildPhysicalRelationColumnOutputDescriptor(
	decision: PlanDecision,
	rootTable: string,
	model: ModelIR | undefined,
	deps: AdapterCompilerDeps,
): OutputDescriptor | undefined {
	if (
		decision.type !== 'selectRelationColumn' ||
		decision.relation === undefined ||
		decision.column === undefined ||
		decision.column === '*' ||
		getTrustedNqlRelationFilterFields(decision) !== undefined
	) {
		return undefined;
	}

	const targetTable = physicalScalarRelationColumnTarget(
		decision.relation,
		rootTable,
		model,
	);
	if (targetTable) {
		const target = resolveRelationTarget(queryLocal(targetTable), deps);
		const descriptor =
			target.outputs?.get(decision.column) ??
			target.outputsByLogicalKey?.get(decision.column);
		if (descriptor) {
			return {
				...descriptor,
				outputKey: decision.alias ?? descriptor.outputKey,
				logicalKey:
					decision.alias ??
					(descriptor.source.kind === 'modelColumn'
						? descriptor.source.column
						: decision.column),
				shape: { kind: 'scalar', cardinality: 'one' },
			};
		}
	}
	const table = targetTable ? model?.getTable(targetTable) : undefined;
	const column = table?.columns.find(
		(candidate) =>
			candidate.name === decision.column ||
			declaredColumnName(deps.declaredNames, targetTable!, candidate.name) ===
				decision.column,
	);
	if (table === undefined || column === undefined) return undefined;

	return {
		outputKey:
			decision.alias ??
			declaredColumnName(deps.declaredNames, table.name, column.name),
		logicalKey: decision.alias ?? column.name,
		source: {
			kind: 'modelColumn',
			table: table.name,
			column: column.name,
			...(column.js !== undefined ? { js: column.js } : {}),
		},
		shape: { kind: 'scalar', cardinality: 'one' },
	};
}

function buildPhysicalRelationColumnOutputDescriptors(
	decisions: readonly PlanDecision[],
	rootTable: string,
	model: ModelIR | undefined,
	deps: AdapterCompilerDeps,
): readonly OutputDescriptor[] {
	const descriptors: OutputDescriptor[] = [];
	for (const decision of decisions) {
		const descriptor = buildPhysicalRelationColumnOutputDescriptor(
			decision,
			rootTable,
			model,
			deps,
		);
		if (descriptor) descriptors.push(descriptor);
	}
	return descriptors;
}

/**
 * Assemble the SimplifiedPlanReport from the compiled decisions and plan metadata.
 * Handles BatchValues FROM source construction and optional fields (existsWrap, lock, schema).
 */
function buildSimplifiedPlanReport(
	plan: PlanReport,
	allDecisions: PlanDecision[],
	schemaName: string | undefined,
): SimplifiedPlanReport {
	// BatchValues FROM source: the FROM clause is an unnest() table function.
	// Build the RangeFunction and record params separately so compiler.ts can
	// inject them at the front of the parameter list.
	const bvFromSource = plan.intent?.batchValuesSource;
	const batchValuesFromFields = bvFromSource
		? (() => {
				const { rangeFunction, params } = buildBatchValuesRangeFn(
					bvFromSource,
					1,
				);
				return {
					batchValuesFromNode: rangeFunction,
					batchValuesFromParams: params,
					batchValuesFromAlias: bvFromSource.alias,
				};
			})()
		: {};

	return {
		rootTable: plan.rootTable,
		decisions: allDecisions,
		...(schemaName ? { schema: schemaName } : {}),
		...(plan.intent?.existsWrap ? { existsWrap: true } : {}),
		...(plan.intent?.lock ? { lock: plan.intent.lock } : {}),
		...batchValuesFromFields,
	};
}

// ============================================================================
// compile (SELECT)
// ============================================================================

/** Validate include predicates before lowering or allocating bindings. */
function assertSupportedIncludeWhere(
	includes: readonly IncludeIntent[] | undefined,
	strategies: ReadonlyMap<string, string>,
	parent = '',
	intentParent = '',
	parentStrategy?: string,
): void {
	for (const [index, include] of (includes ?? []).entries()) {
		const path = `${parent}include[${index}](${include.relation})`;
		const intentPath = `${intentParent}include[${index}]`;
		const strategy =
			strategies.get(intentPath) ?? (include.join ? 'join' : 'json_agg');
		if (
			parentStrategy &&
			(parentStrategy === 'cte' || strategy !== parentStrategy)
		) {
			throw new Error(
				`Nested include at ${path} has parent strategy ${parentStrategy} and child strategy ${strategy}; mixed strategies and includes under cte are refused (oorabona/db-semantic-planner#894).`,
			);
		}
		if (include.where) {
			// Walk the complete predicate intent, including query and expression bodies.
			const visit = (node: unknown): void => {
				if (!node || typeof node !== 'object') return;
				if (Array.isArray(node)) {
					for (const child of node) visit(child);
					return;
				}
				const record = node as Record<string, unknown>;
				if (
					record.kind === 'exists' ||
					record.kind === 'notExists' ||
					record.kind === 'relationFilter'
				) {
					throw new Error(
						`Relation predicates inside an include where are not supported yet at ${path}.where for strategy ${strategy} (oorabona/db-semantic-planner#892).`,
					);
				}
				for (const [key, child] of Object.entries(record)) {
					// Literal payloads are data, rather than query/expression intent.
					if (
						key === 'values' ||
						(key === 'value' && record.kind !== 'namedArg')
					)
						continue;
					visit(child);
				}
			};
			visit(include.where);

			if (strategy !== 'join') {
				throw new Error(
					`Include where is not supported for strategy ${strategy} at ${path}.where (oorabona/db-semantic-planner#892).`,
				);
			}
		}
		assertSupportedIncludeWhere(
			include.include,
			strategies,
			`${path}.`,
			`${intentPath}.`,
			strategy,
		);
	}
}

type IncludeAssignment = {
	strategy: string;
	decision: PlanReport['decisions'][number];
	context?: PlanReport['decisions'][number]['context'];
};

/** Apply the planner's option rules to external and legacy reports before lowering. */
function validateReportIncludes(
	includes: readonly IncludeIntent[] | undefined,
	model: ModelIR | undefined,
	sourceTable: string,
	assignments: Record<string, IncludeAssignment | undefined>,
	compilerOptions: CompilerOptions,
	rootIntent: QueryIntent,
	parent = '',
	intentParent = '',
	matched = new Set<object>(),
): void {
	for (const [index, include] of (includes ?? []).entries()) {
		const name = include.via ?? include.relation;
		const fullPath = parent ? `${parent}.${name}` : name;
		const intentPath = `${intentParent}include[${index}]`;
		validateIncludeInput(include, intentPath, fullPath);
		const assignment = assignments[intentPath];
		const chosen = assignment?.decision;
		if (chosen) {
			matched.add(chosen);
			assignments[intentPath] = {
				strategy: assignment!.strategy,
				decision: chosen,
				context: { ...chosen.context, intentPath },
			};
		}
		const declaredSource =
			model?.getTable(sourceTable) &&
			resolveRelationTarget(queryLocal(sourceTable), compilerOptions)
				.cteName === undefined;
		// Target-table includes may carry the planner's explicit disambiguation.
		// Exact relation names and via still resolve independently of the decision.
		const chosenRelation =
			model &&
			chosen?.context.target === name &&
			chosen.context.sourceTable === sourceTable &&
			chosen.context.relation
				? model.getRelation(`${sourceTable}.${chosen.context.relation}`)
				: undefined;
		const relation =
			declaredSource && model
				? resolveIncludeRelationName(
						model,
						sourceTable,
						name,
						chosenRelation?.target === name ? () => chosenRelation : undefined,
						fullPath,
					)
				: undefined;
		const virtualRelation =
			name === 'ancestors' || name === 'descendants'
				? model
						?.getRelationsFrom(sourceTable)
						.find((r) => r.source === r.target)
				: undefined;
		if (declaredSource && !relation && !virtualRelation)
			throw new Error(
				`Invalid include: Unknown relation "${name}" from table "${sourceTable}" at "${fullPath}"`,
			);
		const strategy =
			assignment?.strategy ??
			(!intentParent && include.join && relation ? 'join' : undefined);
		if (!strategy)
			throw new Error(
				`Include ${intentPath}(${fullPath}) has no resolved include-strategy decision`,
			);
		if (relation ?? virtualRelation)
			validateRecursiveIncludeStrategy(
				include,
				(relation ?? virtualRelation)!,
				intentPath,
				fullPath,
				POSTGRESQL_CAPABILITIES,
				strategy,
				rootIntent,
			);

		if (chosen && relation) {
			const context = chosen.context;
			const defaultPk = compilerOptions.defaultPkColumnName ?? 'id';
			const foreignKey = toColumnList(relation.foreignKey);
			const parentKey = toColumnList(
				relation.type === 'belongsTo' ? relation.targetKey : relation.sourceKey,
			);
			const resolvedForeignKey = foreignKey.length
				? foreignKey
				: [
						(compilerOptions.deriveFkColumnName ?? defaultFkDerivation)(
							relation.type === 'belongsTo' ? relation.target : sourceTable,
							defaultPk,
						),
					];
			const resolvedParentKey = parentKey.length ? parentKey : [defaultPk];
			for (const [supplied, declared] of [
				[context.foreignKey, resolvedForeignKey],
				[context.parentKey, resolvedParentKey],
			] as const) {
				if (
					supplied !== undefined &&
					JSON.stringify(toColumnList(supplied)) !== JSON.stringify(declared)
				)
					throw new Error(
						`Include ${intentPath}(${fullPath}) decision does not match its intent`,
					);
			}
			assignments[intentPath] = {
				strategy,
				decision: chosen,
				context: {
					...context,
					intentPath,
					foreignKey: resolvedForeignKey,
					parentKey: resolvedParentKey,
					...((include.recursive || relation.recursive) && {
						recursiveInclude: normalizeRecursiveIncludeOptions(
							include.recursive,
							relation,
						),
					}),
				},
			};
			if (
				context.sourceTable !== sourceTable ||
				context.relation !== relation.name ||
				context.target !== relation.target ||
				context.relationType !== relation.type ||
				(include.join !== undefined &&
					(strategy !== 'join' || chosen.joinType !== include.join)) ||
				(include.strategy === 'flat' &&
					strategy !== 'join' &&
					strategy !== 'lateral') ||
				(include.join === undefined &&
					relation.includeStrategy !== 'auto' &&
					strategy !== relation.includeStrategy)
			)
				throw new Error(
					`Include ${intentPath}(${fullPath}) decision does not match its intent`,
				);
		}
		validateIncludeOptions(
			include,
			strategy,
			intentPath,
			fullPath,
			!!(include.recursive || relation?.recursive),
		);
		if (strategy === 'json_agg' || strategy === 'lateral') {
			const targetOrder = validateIncludeOrdering(
				include,
				model,
				relation?.target ?? chosen?.context.target ?? name,
				fullPath,
				chosen?.context.orderByFallback
					? undefined
					: chosen?.context.targetOrderKey,
			);
			const resolved = assignments[intentPath];
			if (resolved && targetOrder)
				resolved.context = {
					...resolved.context!,
					targetOrderKey: targetOrder.columns,
					orderByFallback: targetOrder.fallback,
				};
		}
		validateReportIncludes(
			include.include,
			model,
			relation?.target ??
				virtualRelation?.target ??
				chosen?.context.target ??
				sourceTable,
			assignments,
			compilerOptions,
			rootIntent,
			fullPath,
			`${intentPath}.`,
			matched,
		);
	}
	if (!intentParent) {
		for (const [path, assignment] of Object.entries(assignments))
			if (assignment && !matched.has(assignment.decision))
				throw new Error(`Include ${path} has no matching intent include`);
	}
}

/** Dotted fields remain on the legacy lowering until step 5. Inspect predicates,
 * not bound values or unmoved expression/subquery bodies. */
function hasDottedRootField(where: WhereIntent): boolean {
	if (
		'field' in where &&
		typeof where.field === 'string' &&
		where.field.includes('.')
	)
		return true;
	if (where.kind === 'and' || where.kind === 'or')
		return where.conditions.some(hasDottedRootField);
	if (where.kind === 'not') return hasDottedRootField(where.condition);
	if (
		where.kind === 'exists' ||
		where.kind === 'notExists' ||
		where.kind === 'relationFilter'
	)
		return where.where !== undefined && hasDottedRootField(where.where);
	return false;
}

/**
 * Compile a PlanReport to a parameterised SELECT query.
 * Extracted body of PgAdapter.compile().
 */
export function compileSelectEnvelope<T = unknown>(
	plan: PlanReport,
	options: CompileOptions | undefined,
	deps: AdapterCompilerDeps,
): ProjectionEnvelope<T> {
	// schemaName precedence (options > adapter ctor) is resolved in PgAdapter.buildCompileDeps; deps.schemaName is authoritative here
	const schemaName = deps.schemaName;

	const resolvedModelForCompiler = options?.model ?? deps.model;
	const batchValuesSource = plan.intent?.batchValuesSource;
	const compilerScope =
		batchValuesSource === undefined
			? deps.scope
			: queryScope([
					...(deps.scope?.bindings.values() ?? []),
					batchValuesBinding(batchValuesSource.alias, [
						...batchValuesSource.columns,
						...(batchValuesSource.ordinality ? ['ord'] : []),
					]),
				]);
	const compilerOptions: CompilerOptions = {
		dbCasing: deps.dbCasing ?? 'preserve',
		...(deps.declaredNames !== undefined && {
			declaredNames: deps.declaredNames,
		}),
		...(schemaName && { schema: schemaName }),
		defaultPkColumnName: deps.defaultPk,
		deriveFkColumnName: deps.deriveFk,
		...(deps.bindingNames !== undefined && {
			bindingNames: deps.bindingNames,
		}),
		...(compilerScope !== undefined && { scope: compilerScope }),
		...(deps.relationTargetProjections !== undefined && {
			relationTargetProjections: deps.relationTargetProjections,
		}),
		...(deps.dialectCapabilities !== undefined && {
			dialectCapabilities: deps.dialectCapabilities,
		}),
		...(resolvedModelForCompiler != null && {
			model: resolvedModelForCompiler,
		}),
	};

	// Convert PlanReport (core) → SimplifiedPlanReport (pgsql compiler)
	// The core's plan.decisions contain observability data, not SQL instructions.
	// The actual query structure is in plan.intent (QueryIntent).
	// Note: For unit tests with mock plans (no intent), fall back to plan.decisions directly.
	//
	// execIntent: the intent the adapter should compile from.
	// When the planner ran the IN→EXISTS optimization, plan.executableIntent holds the
	// rewritten WHERE (EXISTS form); plan.intent retains the original submitted intent
	// (observable via dump()). All SQL-generation paths below use execIntent so that
	// compiled SQL matches plan.decisions (which were built from the optimized WHERE).
	const execIntent = deduplicateRootProjection(
		plan.executableIntent ?? plan.intent,
	);
	if (!execIntent) {
		for (const decision of plan.decisions) {
			if (decision.type === 'include-strategy')
				validateResolvedIncludeStrategy(
					decision.choice,
					deps.dialectCapabilities,
				);
		}
	}
	let hydrationPlan: PlanReport | undefined;
	// planForCompilation: a view of the plan where .intent is the executable intent.
	// Condition extraction still consumes executable WHERE until PR 3.
	// Includes consume execution nodes, independently of this intent view.
	// buildSimplifiedPlanReport also uses it for batchValuesSource / existsWrap / lock.
	let planForCompilation: PlanReport =
		plan.executableIntent !== undefined
			? { ...plan, intent: plan.executableIntent }
			: plan;
	let simplifiedPlan: SimplifiedPlanReport;

	if (execIntent) {
		if (!planForCompilation.execution) {
			const strategies = new Map<string, string>();
			const includeAssignments: Record<string, IncludeAssignment | undefined> =
				Object.create(null);
			// Older externally constructed plans may omit intentPath. Index their
			// aliases once; refuse assignments that cannot identify a unique include.
			const legacyStrategies = new Map<string, IncludeAssignment>();
			for (const decision of planForCompilation.decisions) {
				if (decision.type !== 'include-strategy') continue;
				const strategy = validateResolvedIncludeStrategy(
					decision.choice,
					deps.dialectCapabilities,
				);
				if (decision.context.intentPath) {
					if (includeAssignments[decision.context.intentPath])
						throw new Error(
							`Include ${decision.context.intentPath} has duplicate include-strategy decisions`,
						);
					strategies.set(decision.context.intentPath, strategy);
					includeAssignments[decision.context.intentPath] = {
						strategy,
						decision,
					};
				} else {
					for (const alias of new Set([
						decision.context.relation,
						decision.context.includeAlias,
					])) {
						if (!alias) continue;
						if (legacyStrategies.has(alias)) {
							throw new Error(
								`Ambiguous include relation '${alias}': context.intentPath is required for unique strategy assignment (#894).`,
							);
						}
						legacyStrategies.set(alias, { strategy, decision });
					}
				}
			}
			if (legacyStrategies.size > 0) {
				const assignedDecisions = new Set<object>();
				const indexLegacy = (
					includes: readonly IncludeIntent[] | undefined,
					parent = '',
				): void => {
					for (const [index, include] of (includes ?? []).entries()) {
						const path = `${parent}include[${index}]`;
						const legacy = legacyStrategies.get(
							include.via ?? include.relation,
						);
						if (legacy) {
							if (assignedDecisions.has(legacy.decision)) {
								throw new Error(
									`Ambiguous include relation '${include.relation}': context.intentPath is required for unique strategy assignment (#894).`,
								);
							}
							assignedDecisions.add(legacy.decision);
							if (!strategies.has(path)) {
								strategies.set(path, legacy.strategy);
								includeAssignments[path] = legacy;
							}
						}
						indexLegacy(include.include, `${path}.`);
					}
				};
				indexLegacy(execIntent.include);
			}
			const assignedLegacyDecisions = new Set(
				Object.values(includeAssignments).map((a) => a?.decision),
			);
			for (const legacy of new Set(legacyStrategies.values()))
				if (!assignedLegacyDecisions.has(legacy.decision))
					throw new Error(
						`Include ${legacy.decision.context.relation} has no matching intent include`,
					);
			validateReportIncludes(
				execIntent.include,
				resolvedModelForCompiler,
				plan.rootTable,
				includeAssignments,
				compilerOptions,
				execIntent,
			);
			assertSupportedIncludeWhere(execIntent.include, strategies);
			const resolvedByOriginal = new Map<
				PlanReport['decisions'][number],
				PlanReport['decisions'][number]
			>();
			for (const assignment of Object.values(includeAssignments)) {
				if (assignment?.context)
					resolvedByOriginal.set(assignment.decision, {
						...assignment.decision,
						context: assignment.context,
					});
			}
			planForCompilation = {
				...planForCompilation,
				decisions: planForCompilation.decisions.map(
					(d) => resolvedByOriginal.get(d) ?? d,
				),
			};
			planForCompilation = {
				...planForCompilation,
				execution: resolveReportIncludes(
					{ ...execIntent, from: execIntent.from ?? plan.rootTable },
					planForCompilation.decisions,
					resolvedModelForCompiler,
					{ defaultPk: deps.defaultPk, deriveFk: deps.deriveFk },
				),
				decisions: observeIncludeDecisions(planForCompilation.decisions),
			};
		}
		validateExecutionIncludes(
			planForCompilation.execution!,
			execIntent,
			resolvedModelForCompiler,
		);

		if (execIntent.where) {
			assertNoRecursiveRootRelations(execIntent.where);
			assertNoManyToManyRootRelations(
				execIntent.where,
				plan.rootTable,
				resolvedModelForCompiler,
			);
		}
		// Real usage: convert intent to decisions
		const rawWhere =
			execIntent.where &&
			!hasDottedRootField(execIntent.where) &&
			(!plan.intent?.where || !hasDottedRootField(plan.intent.where))
				? execIntent.where
				: undefined;
		let decisions = intentToDecisions(execIntent, plan.rootTable, {
			omitRootWhere: rawWhere !== undefined,
			directConditions: true,
		});
		const resolvedModel = options?.model ?? deps.model;

		// Convert dotted-field comparisons (e.g., "parent.name") to EXISTS subqueries
		// NQL compiles relation-path filters as plain comparisons with dotted field names
		if (resolvedModel) {
			decisions = convertDottedFieldsToExists(
				decisions,
				plan.rootTable,
				resolvedModel,
			);
		}

		// Enrich exists/notExists stub decisions in-place within their boolean tree
		// position.  The stubs produced by intentToDecisions use the relation name as
		// targetTable (unresolved); enrichExistsDecisionsInPlace replaces each stub with
		// the fully-resolved version (real targetTable, foreignKey, conditions, include)
		// from the planner's filter-strategy decisions — WITHOUT moving them to top level.
		// This preserves OR/AND/NOT structure, so "x=1 OR exists('posts')" compiles as
		// "x=1 OR EXISTS(...)" instead of "x=1 AND EXISTS(...)".
		// planForCompilation has .intent = executableIntent (post-optimization WHERE)
		// so findExistsIntents finds 'exists' intents rather than the original 'in'.
		// Side-effect: modifies `decisions` in-place (stub → enriched for each match).
		if (!rawWhere)
			enrichExistsDecisionsInPlace(
				decisions,
				planForCompilation,
				options?.model ?? deps.model,
			);

		const enrichedUnifiedDecisions = lowerResolvedIncludes(
			planForCompilation.execution!,
			deps.defaultPk,
		);

		applyJoinHydrationPrefixes(enrichedUnifiedDecisions);

		// Deduplicate: remove selectRelationColumn decisions for relations
		// whose exact path is consumed by an include strategy.
		// Include handlers (json_agg, lateral, CTE, join) already compile the
		// relation's columns — emitting both would produce duplicate columns.
		// Standalone relation expressions (no matching include) are kept.
		// Note: selectPseudoColumn (recursive traversals like manager.name)
		// are never covered by includes — they always compile independently.
		const includedRelations = includedRelationPaths(enrichedUnifiedDecisions);

		if (includedRelations.size > 0) {
			// Collect specific columns from selectRelationColumn decisions and inject
			// them into matching includeStrategy decisions, then validate against schema.
			const relationColumnsMap = buildRelationColumnsMap(
				enrichedUnifiedDecisions,
			);
			injectAndValidateRelationColumns(
				enrichedUnifiedDecisions,
				relationColumnsMap,
				options?.model ?? deps.model,
			);
		}

		// Compile explicit JoinIntent[] from execIntent.joins into 'join' decisions.
		// These are non-hydrating SQL JOINs (flat result, no relation columns added).
		// joins are not affected by the IN→EXISTS WHERE optimization; execIntent and
		// plan.intent carry the same joins value.
		const joinIntentDecisions = execIntent.joins?.length
			? compileJoinIntents(execIntent.joins, plan.rootTable, schemaName, deps)
			: [];

		const includePayloads = resolveIncludePayloadShapes(
			enrichedUnifiedDecisions,
			planForCompilation,
			resolvedModelForCompiler,
			deps,
			(rootColumns) =>
				rootProjectionLabels(
					planForCompilation.intent?.select,
					rootColumns,
					includedRelations,
					includedRelations.size > 0,
				),
			() => {
				// Lower the root projection through the SQL compiler before allocating
				// markers. Included relation columns are already owned by payload shapes.
				const withoutPayload = (d: PlanDecision): PlanDecision => {
					const relational: Mutable<PlanDecision> = {
						...d,
						columns: [],
						emptyProjection: false,
					};
					delete relational.payloadShape;
					if (d.children) relational.children = d.children.map(withoutPayload);
					return relational;
				};
				const projection = compilePlan(
					{
						rootTable: plan.rootTable,
						decisions: [
							...intentToDecisions(
								{
									type: 'select',
									from: plan.rootTable,
									...(execIntent.select && { select: execIntent.select }),
								},
								plan.rootTable,
							).filter(
								(d) =>
									d.type !== 'selectRelationColumn' ||
									!includedRelations.has(d.relation ?? ''),
							),
							...enrichedUnifiedDecisions.map(withoutPayload),
							...joinIntentDecisions,
						],
					},
					compilerOptions,
				);
				return compiledProjectionLabels(
					projection.ast,
					plan.rootTable,
					resolvedModelForCompiler,
					deps.declaredNames,
				);
			},
		);
		hydrationPlan =
			includePayloads.length > 0
				? {
						...planForCompilation,
						intent: plan.intent,
						includePayloads,
						includePayloadsByNodeId: payloadsByNodeId(enrichedUnifiedDecisions),
					}
				: undefined;

		const deduplicatedDecisions =
			includedRelations.size > 0
				? decisions.filter((d) => {
						if (d.type === 'selectRelationColumn' && d.relation) {
							if (includedRelations.has(d.relation as string)) {
								return false; // covered by include strategy
							}
						}
						return true;
					})
				: decisions;

		// exists decisions are now inline inside deduplicatedDecisions (in their boolean
		// tree position), so we no longer spread them separately here.
		const allDecisions = [
			...deduplicatedDecisions,
			...enrichedUnifiedDecisions,
			...joinIntentDecisions,
		];

		// Enrich range operator decisions with dataType from model
		// (PostgreSQL requires explicit type casts for range parameters).
		// Use deps.model as fallback so ORM queries through deps also get enriched.
		const rangeModel = options?.model ?? deps.model;
		enrichRangeDecisions(allDecisions, rangeModel, plan.rootTable);

		// planForCompilation carries executableIntent as .intent, so
		// buildSimplifiedPlanReport reads batchValuesSource / existsWrap / lock
		// from the executable intent rather than the original.
		simplifiedPlan = buildSimplifiedPlanReport(
			planForCompilation,
			allDecisions,
			schemaName,
		);
		simplifiedPlan = {
			...simplifiedPlan,
			directConditions: true,
			...(execIntent.having && { rawHaving: execIntent.having }),
		};
		if (rawWhere)
			simplifiedPlan = {
				...simplifiedPlan,
				rawWhere,
				rootWhereJoinRelations: new Set(
					planForCompilation.decisions
						.filter(
							(decision) =>
								decision.type === 'filter-strategy' &&
								decision.choice === 'join' &&
								(rawWhere.kind === 'exists' ||
									(rawWhere.kind === 'relationFilter' &&
										rawWhere.mode === 'some')) &&
								(decision.context.sourceTable ?? plan.rootTable) ===
									plan.rootTable &&
								(decision.context.relation === rawWhere.relation ||
									decision.context.target === rawWhere.relation ||
									(Array.isArray(rawWhere.relation) &&
										rawWhere.relation.length === 1 &&
										decision.context.relation === rawWhere.relation[0])),
						)
						.map(
							(decision) =>
								`${decision.context.sourceTable ?? plan.rootTable}.${decision.context.relation}`,
						),
				),
			};
	} else {
		// Unit test with mock data: use decisions directly (legacy format).
		// Tests supply adapter-format PlanDecisions inside a core PlanReport,
		// so the runtime data is already in the right shape — bridge the type gap.
		simplifiedPlan = {
			rootTable: plan.rootTable,
			decisions: plan.decisions as SimplifiedPlanReport['decisions'],
			...(schemaName ? { schema: schemaName } : {}),
		};
	}

	const result = compilePlan(simplifiedPlan, compilerOptions);
	const baseEnv = fromAstProjection<T>({
		sql: result.sql,
		parameters: result.parameters,
		ast: result.ast,
		rootTable: plan.rootTable,
		model: resolvedModelForCompiler,
		...(deps.declaredNames !== undefined && {
			declaredNames: deps.declaredNames,
		}),
		...(hydrationPlan ? { hydrationPlan } : {}),
	});
	return supplementOutputDescriptors(baseEnv, [
		...buildJsonAggOutputDescriptors(
			simplifiedPlan.decisions,
			resolvedModelForCompiler,
			deps,
		),
		...buildPhysicalRelationColumnOutputDescriptors(
			simplifiedPlan.decisions,
			plan.rootTable,
			resolvedModelForCompiler,
			deps,
		),
		...buildTrustedRelationColumnOutputDescriptors(
			simplifiedPlan.decisions,
			resolvedModelForCompiler,
			deps,
		),
	]);
}

export function compileSelect<T = unknown>(
	plan: PlanReport,
	options: CompileOptions | undefined,
	deps: AdapterCompilerDeps,
): CompiledQuery<T> {
	return finalizeEnvelope(compileSelectEnvelope(plan, options, deps));
}

function payloadsByNodeId(
	decisions: readonly PlanDecision[],
): Readonly<Record<string, import('@dbsp/types').IncludePayloadShape>> {
	const result: Record<string, import('@dbsp/types').IncludePayloadShape> =
		Object.create(null);
	const visit = (items: readonly PlanDecision[]) => {
		for (const decision of items) {
			if (decision.resolvedInclude && decision.payloadShape)
				result[decision.resolvedInclude.nodeId] = decision.payloadShape;
			visit(decision.children ?? []);
		}
	};
	visit(decisions);
	return result;
}
function validateExecutionIncludes(
	execution: import('@dbsp/types').IncludeExecution,
	intent: QueryIntent,
	model: ModelIR | undefined,
): void {
	const strategies = new Map<string, string>();
	const inputs = (
		nodes: readonly import('@dbsp/types').ResolvedIncludeNode[],
	): IncludeIntent[] =>
		nodes.map((node) => {
			strategies.set(node.intentPath, node.strategy);
			return {
				relation: node.publicKey,
				...(node.predicate && { where: node.predicate.condition }),
				include: inputs(node.children),
			};
		});
	const resolvedInputs = inputs(execution.includes);
	const byPath = new Map<string, import('@dbsp/types').ResolvedIncludeNode>();
	const indexNodes = (
		nodes: readonly import('@dbsp/types').ResolvedIncludeNode[],
	) => {
		for (const node of nodes) {
			byPath.set(node.intentPath, node);
			indexNodes(node.children);
		}
	};
	indexNodes(execution.includes);
	const validateAuthored = (
		includes: readonly IncludeIntent[],
		parent = '',
		logicalParent = '',
	) => {
		for (const [index, include] of includes.entries()) {
			const path = `${parent}include[${index}]`;
			const name = include.via ?? include.relation;
			const fullPath = logicalParent ? `${logicalParent}.${name}` : name;
			const node = byPath.get(path);
			if (!node)
				throw new Error(
					`Invalid include: Unknown relation "${name}" from table "${execution.rootRange.table}" at "${fullPath}"`,
				);
			validateIncludeInput(include, path, fullPath);
			const relation = node.path.relations[0];
			if (relation)
				validateRecursiveIncludeStrategy(
					include,
					relation,
					path,
					fullPath,
					POSTGRESQL_CAPABILITIES,
					node.strategy,
					intent,
				);
			validateIncludeOptions(
				include,
				node.strategy,
				path,
				fullPath,
				!!node.recursion,
			);
			if (node.strategy === 'json_agg' || node.strategy === 'lateral') {
				const order = validateIncludeOrdering(
					include,
					model,
					node.targetRange.table,
					fullPath,
					node.ordering.usesFallback ? undefined : node.ordering.fallback,
				);
				if (
					order &&
					(JSON.stringify(order.columns) !==
						JSON.stringify(node.ordering.fallback) ||
						order.fallback !== node.ordering.usesFallback)
				)
					throw new Error(
						`Include ${path}(${fullPath}) resolved ordering does not match its intent`,
					);
			}

			validateAuthored(include.include ?? [], `${path}.`, fullPath);
		}
	};
	validateAuthored(intent.include ?? []);
	assertSupportedIncludeWhere(intent.include, strategies);
	assertSupportedIncludeWhere(resolvedInputs, strategies);

	if (
		(intent.from && execution.rootRange.table !== intent.from) ||
		!execution.rootRange.id ||
		!execution.rootRange.alias
	)
		throw new Error('Invalid resolved include root range');
	const ranges = new Map<string, import('@dbsp/types').ResolvedRange>();
	const registerRange = (range: import('@dbsp/types').ResolvedRange) => {
		const previous = ranges.get(range.id);
		if (
			!range.id ||
			!range.table ||
			!range.alias ||
			(previous &&
				(previous.table !== range.table || previous.alias !== range.alias))
		)
			throw new Error(`Invalid resolved range '${range.id}'`);
		ranges.set(range.id, range);
	};
	registerRange(execution.rootRange);
	const ids = new Set<string>();
	const visit = (
		nodes: readonly import('@dbsp/types').ResolvedIncludeNode[],
		source: import('@dbsp/types').ResolvedRange,
		parentStrategy?: string,
		parent = '',
	) => {
		for (const node of nodes) {
			if (ids.has(node.nodeId))
				throw new Error(`Duplicate resolved include node '${node.nodeId}'`);
			ids.add(node.nodeId);
			for (const range of [
				node.sourceRange,
				node.targetRange,
				node.outputRange,
				...(node.cteRange ? [node.cteRange] : []),
				...(node.recursiveRanges
					? [node.recursiveRanges.walk, node.recursiveRanges.next]
					: []),
			])
				registerRange(range);
			if (
				node.path.hops.some(
					(hop, index) =>
						hop.fromTable !== node.hopRanges[index]?.from.table ||
						hop.toTable !== node.hopRanges[index]?.to.table,
				) ||
				(node.predicate &&
					(node.predicate.currentRange.id !== node.targetRange.id ||
						node.predicate.outerRange.id !== execution.rootRange.id)) ||
				!['flat', 'nested'].includes(node.outputMode) ||
				node.cardinality !==
					(node.relationType === 'belongsTo' || node.relationType === 'hasOne'
						? 'one'
						: 'many')
			)
				throw new Error(
					`Invalid resolved include '${node.nodeId}' binding or cardinality`,
				);
			validateResolvedIncludeStrategy(node.strategy, POSTGRESQL_CAPABILITIES);
			if (
				node.sourceRange.id !== source.id ||
				node.sourceRange.table !== source.table ||
				node.path.targetTable !== node.targetRange.table ||
				node.path.hops.length !== node.hopRanges.length ||
				node.path.hops.some(
					(hop) =>
						hop.pairs.length === 0 ||
						hop.pairs.some((pair) => !pair.fromColumn || !pair.toColumn),
				)
			)
				throw new Error(
					`Invalid resolved include '${node.nodeId}' ranges or correlation`,
				);
			const path = `${parent}include[${node.intentPath.match(/include\[(\d+)\]$/)?.[1]}](${node.publicKey})`;
			if (
				parentStrategy &&
				(parentStrategy === 'cte' || node.strategy !== parentStrategy)
			)
				throw new Error(
					`Nested include at ${path} has parent strategy ${parentStrategy} and child strategy ${node.strategy}; mixed strategies and includes under cte are refused (oorabona/db-semantic-planner#894).`,
				);
			if (node.predicate && node.strategy !== 'join')
				throw new Error(
					`Include where is not supported for strategy ${node.strategy} at ${path}.where (oorabona/db-semantic-planner#892).`,
				);
			visit(node.children, node.outputRange, node.strategy, `${path}.`);
		}
	};
	visit(execution.includes, execution.rootRange);
}
