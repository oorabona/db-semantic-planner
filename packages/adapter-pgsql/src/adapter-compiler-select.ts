/**
 * SELECT compilation: converts PlanReport to CompiledQuery.
 * Extracted from PgAdapter.compile().
 *
 * @internal
 */

import {
	countDistinctRelationPathsByName,
	validateResolvedIncludeStrategy,
} from '@dbsp/core/internal';
import type {
	CompiledQuery,
	CompileOptions,
	IncludeIntent,
	JoinIntent,
	ModelIR,
	NestedOutputReadHandling,
	OutputDescriptor,
	OutputValueShape,
	PlanReport,
} from '@dbsp/types';
import { resolveOutputReadHandling, toColumnList } from '@dbsp/types';
import {
	getTrustedNqlRelationFilterFields,
	type Mutable,
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
	extractAllIncludeDecisions,
	synthesizeMissingJoinDecisions,
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
import { queryLocal, resolveDeclaredIdentifier } from './sql-identifier.js';

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

	for (const intent of joins) {
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

			const bvCtx: WhereCompilerCtx = {
				rootTable,
				aliases: new Map<string, string>(),
				paramState: bvOnParamState,
				outerTable: alias,
				...(schemaName !== undefined && { schemaName }),
				scope: queryScope([
					...(deps.scope?.bindings.values() ?? []),
					...(!hasSourceBinding(rootTable, deps)
						? [sourceBinding(rootTable, deps)]
						: []),
					batchValuesBinding(alias, [
						...bv.columns,
						...(bv.ordinality ? ['ord'] : []),
					]),
				]),
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
			const scopeBindings = [
				...(deps.scope?.bindings.values() ?? []),
				...(!hasSourceBinding(rootTable, deps)
					? [sourceBinding(rootTable, deps)]
					: []),
				...(relationBindingFor(deps.scope, joinedBinding.qualifier) ===
					undefined && tableAlias !== rootTable
					? [joinedBinding]
					: []),
			];
			const ctx: WhereCompilerCtx = {
				rootTable,
				aliases: tableAliasMap,
				paramState,
				// outerTable = tableAlias so FieldRef(scope:'outer') resolves to the
				// joined alias (e.g. 'e2' in self-join ON conditions).
				outerTable: tableAlias,
				...(schemaName !== undefined && { schemaName }),
				scope: queryScope([...scopeBindings]),
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

/**
 * Strip auto-selected columns from join includeStrategy decisions when the query
 * uses aggregation, DISTINCT, GROUP BY, or explicit column selection.
 *
 * In all four cases the JOIN itself is kept (for filtering / INNER JOIN semantics)
 * but its auto-hydration columns would produce invalid SQL — they are cleared.
 * Explicitly requested columns (via relationColumn()) are re-injected later by
 * injectAndValidateRelationColumns().
 *
 * Mutates `decisions` in place (same pattern as the original code).
 */
function stripJoinColumnsForAggregation(
	decisions: PlanDecision[],
	intent: NonNullable<PlanReport['intent']>,
): void {
	// INCLUDE-COUNT: aggregate-only query (COUNT(*), no GROUP BY fields)
	const isAggregateOnly =
		intent.select &&
		'type' in intent.select &&
		intent.select.type === 'aggregate' &&
		!(
			'fields' in intent.select &&
			(intent.select as { fields?: unknown }).fields
		);

	// DISTINCT-VECTOR: SELECT DISTINCT — vector cols have no equality operator
	const isDistinct = intent.distinct === true;

	// GROUP-BY-JOIN: GROUP BY — non-aggregate cols must appear in GROUP BY
	const hasGroupBy = intent.groupBy && intent.groupBy.length > 0;

	// EXPLICIT-COLUMNS: .columns([...]) — user declared exactly what they want
	const hasExplicitColumns =
		intent.select &&
		'type' in intent.select &&
		intent.select.type === 'expressions';

	if (isAggregateOnly || isDistinct || hasGroupBy || hasExplicitColumns) {
		for (const d of decisions) {
			if (d.type === 'includeStrategy' && d.choice === 'join') {
				(d as Mutable<PlanDecision>).columns = [];
			}
		}
	}
}

type RelationColumnEntry = { col: string; alias?: string };

/**
 * Collect specific columns per relation from selectRelationColumn decisions.
 *
 * Key: full relation path (e.g. 'callee' for 1-hop, 'callee.file' for 2-hop).
 * This lets relationColumn('callee.file', 'path', 'fp') target the leaf
 * includeStrategy decision rather than the 1st-hop one.
 */
function buildRelationColumnsMap(
	decisions: PlanDecision[],
	includedRelations: Set<string>,
): Map<string, RelationColumnEntry[]> {
	const map = new Map<string, RelationColumnEntry[]>();

	for (const d of decisions) {
		if (!(d.type === 'selectRelationColumn' && d.relation && d.column))
			continue;

		const col = d.column as string;
		const alias = d.alias as string | undefined;
		const fullRelation = d.relation as string;
		const rootRelation = fullRelation.split('.')[0] ?? '';
		if (!includedRelations.has(rootRelation)) continue;

		// Use full path as map key so 'callee.file' is stored separately
		// from 'callee' — avoids injecting 2-hop columns into 1-hop includes.
		const mapKey = fullRelation;
		if (col === '*') {
			// Wildcard: select all columns from relation (no aliases)
			map.set(mapKey, [{ col: '*' }]);
			continue;
		}
		const existing = map.get(mapKey);
		if (existing) {
			if (existing.length === 1 && existing[0]?.col === '*') continue; // wildcard already set
			if (!existing.some((e) => e.col === col)) {
				existing.push({ col, ...(alias !== undefined && { alias }) });
			}
		} else {
			map.set(mapKey, [{ col, ...(alias !== undefined && { alias }) }]);
		}
	}

	return map;
}

function rootRelationName(relation: string): string {
	return relation.split('.')[0] ?? relation;
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
	for (const d of enrichedUnifiedDecisions) {
		if (d.type === 'includeStrategy' && d.relationName) {
			const mapKey = (d.relationPath as string | undefined) ?? d.relationName;
			const entries = mapKey ? relationColumnsMap.get(mapKey) : undefined;
			if (entries) {
				const mut = d as Mutable<PlanDecision>;
				// columns: plain string array (preserves existing contract)
				mut.columns = entries.map((e) => e.col);
				// columnAliases: map col -> user alias (only non-trivial aliases)
				const aliasMap: Record<string, string> = {};
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
	for (const d of enrichedUnifiedDecisions) {
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
					(c) => !validColumnNames.has(c),
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

function buildJsonAggColumnKeyMap(
	decision: PlanDecision,
	targetTable: string,
	model: ModelIR | undefined,
	deps?: AdapterCompilerDeps,
): Record<string, string> | undefined {
	const columns = jsonAggProjectedColumns(decision, targetTable, model, deps);
	if (!columns || columns.length === 0) return undefined;
	const projected = deps
		? resolveRelationTarget(queryLocal(targetTable), deps).outputs
		: undefined;
	if (projected !== undefined) {
		const map: Record<string, string> = {};
		for (const outputKey of columns) {
			const descriptor = projected.get(outputKey);
			if (descriptor) {
				const logicalKey = (
					descriptor as OutputDescriptor & { logicalKey?: string }
				).logicalKey;
				map[outputKey] =
					logicalKey ??
					(descriptor.source.kind === 'modelColumn'
						? descriptor.source.column
						: outputKey);
			}
		}
		return Object.keys(map).length > 0 ? map : undefined;
	}
	const table = model?.getTable(targetTable);
	const map: Record<string, string> = {};
	for (const columnName of columns) {
		if (columnName === '*') continue;
		const modelColumn =
			table?.columns.find((column) => column.name === columnName)?.name ??
			columnName;
		map[declaredColumnName(deps?.declaredNames, targetTable, modelColumn)] =
			modelColumn;
	}
	return Object.keys(map).length > 0 ? map : undefined;
}

function buildJsonAggNestedReadTransforms(
	decision: PlanDecision,
	targetTable: string,
	model: ModelIR | undefined,
	deps?: AdapterCompilerDeps,
): readonly NestedOutputReadHandling[] | undefined {
	const columns = jsonAggProjectedColumns(decision, targetTable, model, deps);
	if (!columns || columns.length === 0) return undefined;
	const projected = deps
		? resolveRelationTarget(queryLocal(targetTable), deps).outputs
		: undefined;
	if (projected !== undefined) {
		const shape = jsonAggContainerShape(decision.relationType);
		const transforms: NestedOutputReadHandling[] = [];
		for (const columnName of columns) {
			const descriptor = projected.get(columnName);
			if (!descriptor) continue;
			assertProjectedJsonContainerCanBeAggregated(
				resolveRelationTarget(queryLocal(targetTable), deps!),
				descriptor,
			);
			const handling = resolveOutputReadHandling({ ...descriptor, shape });
			if (handling.kind === 'nestedTransform') {
				transforms.push({
					kind: handling.kind,
					table: handling.table,
					column: handling.column,
					js: handling.js,
					...(descriptor.outputKey !== handling.column
						? { outputKey: descriptor.outputKey }
						: {}),
				});
			}
		}
		return transforms.length > 0 ? transforms : undefined;
	}
	const table = model?.getTable(targetTable);
	if (!table) return undefined;
	const shape = jsonAggContainerShape(decision.relationType);
	const transforms: NestedOutputReadHandling[] = [];
	for (const columnName of columns) {
		if (columnName === '*') continue;
		const column = table.columns.find(
			(candidate) => candidate.name === columnName,
		);
		if (!column) continue;
		const handling = resolveJsonAggColumnReadHandling(
			targetTable,
			column,
			shape,
		);
		if (handling) {
			transforms.push({
				kind: handling.kind,
				table: handling.table,
				column: handling.column,
				js: handling.js,
			});
		}
	}
	return transforms.length > 0 ? transforms : undefined;
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

function findJsonAggPlanDecision(
	plan: PlanReport,
	decision: PlanDecision,
): PlanReport['decisions'][number] | undefined {
	if (decision.intentPath) {
		const byIntentPath = plan.decisions.find(
			(candidate) =>
				candidate.type === 'include-strategy' &&
				candidate.choice === 'json_agg' &&
				candidate.context.intentPath === decision.intentPath,
		);
		if (byIntentPath) return byIntentPath;
	}
	return plan.decisions.find((candidate) => {
		if (candidate.type !== 'include-strategy') return false;
		if (candidate.choice !== 'json_agg') return false;
		const relationName =
			candidate.context.relation ?? candidate.context.includeAlias;
		return (
			relationName === decision.relationName &&
			candidate.context.target === decision.targetTable
		);
	});
}

function annotateJsonAggColumnKeyMaps(
	plan: PlanReport,
	decisions: readonly PlanDecision[],
	model: ModelIR | undefined,
	deps?: AdapterCompilerDeps,
): boolean {
	let annotated = false;
	for (const decision of decisions) {
		if (decision.type === 'includeStrategy' && decision.choice === 'json_agg') {
			const targetTable = decision.targetTable;
			const planDecision = targetTable
				? findJsonAggPlanDecision(plan, decision)
				: undefined;
			const keyMap =
				targetTable && planDecision
					? buildJsonAggColumnKeyMap(decision, targetTable, model, deps)
					: undefined;
			const nestedReadTransforms =
				targetTable && planDecision
					? buildJsonAggNestedReadTransforms(decision, targetTable, model, deps)
					: undefined;
			if ((keyMap || nestedReadTransforms) && planDecision) {
				const context = planDecision.context as Mutable<
					PlanReport['decisions'][number]['context']
				>;
				if (keyMap) {
					context.jsonAggColumnKeyMap = keyMap;
				}
				if (nestedReadTransforms) {
					context.jsonAggNestedReadTransforms = nestedReadTransforms;
				}
				annotated = true;
			}
		}
		if (decision.children && decision.children.length > 0) {
			annotated =
				annotateJsonAggColumnKeyMaps(plan, decision.children, model, deps) ||
				annotated;
		}
	}
	return annotated;
}

function clonePlanReportForHydration(plan: PlanReport): PlanReport {
	return {
		...plan,
		decisions: plan.decisions.map((decision) => {
			const context = (decision as { context?: unknown }).context;
			if (context === null || typeof context !== 'object') return decision;
			return {
				...decision,
				context: { ...(context as Record<string, unknown>) },
			};
		}) as PlanReport['decisions'],
	};
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
	const execIntent = plan.executableIntent ?? plan.intent;
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
	// Passed to extractor helpers (extractExistsDecisions, synthesizeMissingJoinDecisions,
	// extractAllIncludeDecisions) so they read the correct WHERE for SQL generation.
	// buildSimplifiedPlanReport also uses it for batchValuesSource / existsWrap / lock.
	const planForCompilation: PlanReport =
		plan.executableIntent !== undefined
			? { ...plan, intent: plan.executableIntent }
			: plan;
	let simplifiedPlan: SimplifiedPlanReport;

	if (execIntent) {
		const strategies = new Map<string, string>();
		// Older externally constructed plans may omit intentPath. Index their
		// aliases once; refuse assignments that cannot identify a unique include.
		const legacyStrategies = new Map<
			string,
			{ strategy: string; decision: object }
		>();
		for (const decision of planForCompilation.decisions) {
			if (decision.type !== 'include-strategy') continue;
			const strategy = validateResolvedIncludeStrategy(
				decision.choice,
				deps.dialectCapabilities,
			);
			if (decision.context.intentPath) {
				strategies.set(decision.context.intentPath, strategy);
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
					const legacy = legacyStrategies.get(include.relation);
					if (!strategies.has(path) && legacy) {
						if (assignedDecisions.has(legacy.decision)) {
							throw new Error(
								`Ambiguous include relation '${include.relation}': context.intentPath is required for unique strategy assignment (#894).`,
							);
						}
						assignedDecisions.add(legacy.decision);
						strategies.set(path, legacy.strategy);
					}
					indexLegacy(include.include, `${path}.`);
				}
			};
			indexLegacy(execIntent.include);
		}
		assertSupportedIncludeWhere(execIntent.include, strategies);
		// Real usage: convert intent to decisions
		let decisions = intentToDecisions(execIntent, plan.rootTable);
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
		enrichExistsDecisionsInPlace(
			decisions,
			planForCompilation,
			options?.model ?? deps.model,
		);

		// Phase 3: Extract ALL include decisions (json_agg, join, lateral, cte)
		const unifiedIncludeDecisions = extractAllIncludeDecisions(
			planForCompilation,
			deps.defaultPk,
			deps.deriveFk,
		);

		// Synthesize join decisions for intent-based includes the planner couldn't resolve
		// (e.g. camelCase alias 'enclosingSymbol' for model relation 'enclosing_symbol').
		const coveredByPlanner = new Set(
			unifiedIncludeDecisions
				.filter((d) => d.type === 'includeStrategy')
				.map((d) => d.relationName as string)
				.filter(Boolean),
		);
		const synthesizedModel = options?.model ?? deps.model;
		const synthesizedJoins = synthesizedModel
			? synthesizeMissingJoinDecisions(
					planForCompilation,
					coveredByPlanner,
					synthesizedModel,
					deps.defaultPk,
					deps.deriveFk,
				)
			: [];
		const allUnifiedIncludeDecisions =
			synthesizedJoins.length > 0
				? [...unifiedIncludeDecisions, ...synthesizedJoins]
				: unifiedIncludeDecisions;

		// Include decisions are independent of any sibling exists() filter.
		// The exists() only filters which root rows are selected; the include
		// subquery correlates on the FK only and returns ALL related rows.
		// Spread to mutable array — downstream helpers mutate in-place.
		const enrichedUnifiedDecisions: PlanDecision[] = [
			...allUnifiedIncludeDecisions,
		];

		// Strip auto-selected columns from join includes when aggregation, DISTINCT,
		// GROUP BY, or explicit column selection is active. Keeps the JOIN for
		// filtering/inner join semantics but prevents invalid SELECT column lists.
		// select/distinct/groupBy fields are unchanged by the IN→EXISTS WHERE optimization,
		// so execIntent and plan.intent are equivalent here; execIntent is used for consistency.
		stripJoinColumnsForAggregation(enrichedUnifiedDecisions, execIntent);
		applyJoinHydrationPrefixes(enrichedUnifiedDecisions);

		// Deduplicate: remove selectRelationColumn decisions for relations
		// already covered by an include strategy.
		// Include handlers (json_agg, lateral, CTE, join) already compile the
		// relation's columns — emitting both would produce duplicate columns.
		// Standalone relation expressions (no matching include) are kept.
		// Note: selectPseudoColumn (recursive traversals like manager.name)
		// are never covered by includes — they always compile independently.
		const includedRelations = new Set(
			enrichedUnifiedDecisions
				.filter((d) => d.type === 'includeStrategy')
				.map((d) => d.relationName as string)
				.filter(Boolean),
		);

		if (includedRelations.size > 0) {
			// Collect specific columns from selectRelationColumn decisions and inject
			// them into matching includeStrategy decisions, then validate against schema.
			const relationColumnsMap = buildRelationColumnsMap(
				decisions,
				includedRelations,
			);
			injectAndValidateRelationColumns(
				enrichedUnifiedDecisions,
				relationColumnsMap,
				options?.model ?? deps.model,
			);
		}

		const deduplicatedDecisions =
			includedRelations.size > 0
				? decisions.filter((d) => {
						if (d.type === 'selectRelationColumn' && d.relation) {
							// relation may be a dotted path (e.g. "userRoles.role.permissions")
							// — check if the root segment is covered by an include
							const rel = d.relation as string;
							const rootRelation = rootRelationName(rel);
							if (includedRelations.has(rootRelation)) {
								return false; // covered by include strategy
							}
						}
						return true;
					})
				: decisions;

		// Compile explicit JoinIntent[] from execIntent.joins into 'join' decisions.
		// These are non-hydrating SQL JOINs (flat result, no relation columns added).
		// joins are not affected by the IN→EXISTS WHERE optimization; execIntent and
		// plan.intent carry the same joins value.
		const joinIntentDecisions =
			execIntent?.joins && (execIntent.joins as JoinIntent[]).length > 0
				? compileJoinIntents(
						execIntent.joins as JoinIntent[],
						plan.rootTable,
						schemaName,
						deps,
					)
				: [];

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
		const candidateHydrationPlan = clonePlanReportForHydration(plan);
		const hasJsonAggColumnKeyMaps = annotateJsonAggColumnKeyMaps(
			candidateHydrationPlan,
			allDecisions,
			resolvedModelForCompiler,
			deps,
		);
		if (hasJsonAggColumnKeyMaps) {
			hydrationPlan = candidateHydrationPlan;
		}

		// planForCompilation carries executableIntent as .intent, so
		// buildSimplifiedPlanReport reads batchValuesSource / existsWrap / lock
		// from the executable intent rather than the original.
		simplifiedPlan = buildSimplifiedPlanReport(
			planForCompilation,
			allDecisions,
			schemaName,
		);
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
