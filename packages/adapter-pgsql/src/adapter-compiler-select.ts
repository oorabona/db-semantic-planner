import { lowerResolvedIncludes } from './resolved-include-decisions.js';
/**
 * SELECT compilation: converts PlanReport to CompiledQuery.
 * Extracted from PgAdapter.compile().
 *
 * @internal
 */

import { countDistinctRelationPathsByName } from '@dbsp/core/internal';
import type {
	CompiledQuery,
	CompileOptions,
	JoinIntent,
	ModelIR,
	OutputDescriptor,
	OutputValueShape,
	PlanReport,
	QueryIntent,
	SelectExecution,
} from '@dbsp/types';
import { resolveOutputReadHandling } from '@dbsp/types';
import {
	getTrustedNqlRelationFilterFields,
	isPlannedReport,
	type Mutable,
	markPlannedReport,
} from '@dbsp/types/internal';
import type { Node } from '@pgsql/types';
import type { AdapterCompilerDeps } from './adapter-compiler-deps.js';
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
import { type CompilerContext, createCompilerState } from './handlers/types.js';
import { resolveIncludePayloadShapes } from './include-payload-shape.js';
import { intentToDecisions } from './intent-to-decisions.js';
import {
	jsonAggColumnDescriptor,
	jsonAggContainerShape,
	resolveJsonAggColumnReadHandling,
} from './json-agg-read-handling.js';
import { createTypeCastParamRef } from './param-ref.js';
import {
	finalizeEnvelope,
	fromAstProjection,
	type ProjectionEnvelope,
	supplementOutputDescriptors,
} from './projection-envelope.js';
import { MAX_DEPTH_LIMIT } from './recursive/cte-compiler.js';
import {
	assertProjectedJsonContainerCanBeAggregated,
	resolveRelationTarget,
} from './relation-target-projection.js';
import { compileResolvedCondition } from './resolved-condition-compiler.js';
import { queryLocal, resolveDeclaredIdentifier } from './sql-identifier.js';
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
 * - Table mode (`on` present): Explicit ON condition compiled from the resolved union.
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
 * The returned `params` array contains the column data arrays in order, numbered
 * from `startParamIndex`. A BatchValues FROM places them first in the query; a
 * BatchValues join numbers them locally and compileJoinDecision offsets them.
 *
 * @param bv - The batch values payload (columns, data, types, alias, ordinality).
 * @param startParamIndex - The 1-based index for the first ParamRef ($N).
 *   FROM and JOIN callers start at `$1`; compileJoinDecision offsets join placeholders.
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
	execution: SelectExecution,
	schemaName: string | undefined,
	deps: AdapterCompilerDeps,
): PlanDecision[] {
	if (execution.joins.length === 0) return [];
	const rootTable = execution.rootRange.table;
	const rootBinding = sourceBinding(rootTable, deps);

	const results: PlanDecision[] = [];
	const initialScope = queryScope([
		...(deps.scope?.bindings.values() ?? []),
		...(!hasSourceBinding(rootTable, deps) ? [rootBinding] : []),
	]);

	// One local scope grows in execution order; each ON sees itself and prior joins.
	const joinBindings = new Map(initialScope.bindings);
	const joinScope = { bindings: joinBindings };
	for (const join of execution.joins) {
		const range = join.range;
		if (join.kind === 'values') {
			const bv = joins[join.intentIndex]?.batchValues;
			if (!bv) throw new Error(`Join ${join.intentPath} has no values payload`);
			joinBindings.set(
				range.alias,
				batchValuesBinding(range.alias, [
					...bv.columns,
					...(bv.ordinality ? ['ord'] : []),
				]),
			);
		} else {
			const source = relationBindingFor(deps.scope, queryLocal(range.table));
			joinBindings.set(
				range.alias,
				relationBinding({
					qualifier: queryLocal(range.alias),
					...(source && source.kind !== 'declared-table'
						? {
								kind: 'join-alias' as const,
								...(source.outputs && { outputs: source.outputs }),
							}
						: {
								kind: 'declared-table' as const,
								logicalTable: source?.logicalTable ?? range.table,
							}),
				}),
			);
		}
		const onContext: CompilerContext = {
			rootTable,
			currentAlias: rootBinding.qualifier,
			scope: joinScope,
			...(schemaName !== undefined && { schema: schemaName }),
			dbCasing: deps.dbCasing ?? 'preserve',
			...(deps.declaredNames !== undefined && {
				declaredNames: deps.declaredNames,
			}),
			...(deps.relationTargetProjections !== undefined && {
				relationTargetProjections: deps.relationTargetProjections,
			}),
			...(deps.model !== undefined && { model: deps.model }),
			...(deps.dialectCapabilities !== undefined && {
				dialectCapabilities: deps.dialectCapabilities,
			}),
			maxRecursiveDepth: MAX_DEPTH_LIMIT,
		};
		const resolved = join;
		const alias = resolved.range.alias;

		if (alias === rootBinding.qualifier)
			throw new Error(`Query scope already binds qualifier '${alias}'.`);
		if (resolved.kind === 'relation') {
			const pairs = resolved.path!.hops[0]!.pairs;
			results.push({
				type: 'join',
				targetTable: resolved.range.table,
				alias,
				relationName: resolved.path!.logicalSegments.join('.'),
				sourceColumn: pairs.map((p) => p.fromColumn),
				targetColumn: pairs.map((p) => p.toColumn),
				joinType: resolved.type,
			});
		} else if (resolved.kind === 'values') {
			// ── BatchValues mode: unnest($N::type[], ...) AS alias(col1, col2) ──
			// Compiles a batch-values join: the rarg is a RangeFunction wrapping
			// unnest() instead of a plain RangeVar.
			// Params start locally at $1; compileJoinDecision offsets both fragments.
			const bv = joins[resolved.intentIndex]?.batchValues;
			if (!bv)
				throw new Error(`Join ${resolved.intentPath} has no values payload`);
			const alias = resolved.range.alias;

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

			const onNode = compileResolvedCondition(
				resolved.on!,
				onContext,
				bvOnParamState,
			);

			// Combine bv unnest params + any ON condition params into batchValuesParams.
			// compileJoinDecision appends these together and offsets the RangeFunction
			// and ON placeholders by the number of parameters already in the query.
			const allBvParams: unknown[] = [
				...bvParams,
				...bvOnParamState.parameters,
			];

			results.push({
				type: 'join',
				targetTable: alias,
				alias,
				joinType: resolved.type,
				joinRarg: rangeFunction,
				joinOnNode: onNode,
				// Arrays and ON values share one local parameter sequence.
				batchValuesParams: allBvParams,
			});
		} else {
			// ── Table mode: explicit ON condition ─────────────────────────────
			// Compile the planned ON condition to an AST node.
			// ON conditions may include bound params; capture them with the precompiled
			// join so compiler.ts can merge them into the query's live param sequence.
			const paramState = createCompilerState();

			const tableAlias = resolved.range.alias;

			const onNode = compileResolvedCondition(
				resolved.on!,
				onContext,
				paramState,
			);

			// Store rarg + onNode separately — the 'join' case in compiler.ts wraps
			// from[0] as larg so multiple .join() calls chain correctly.
			const joinedSource = relationBindingFor(
				deps.scope,
				queryLocal(resolved.range.table),
			);
			const joinedRangeVar = sqlRangeVar(
				joinedSource?.qualifier ??
					resolveDeclaredIdentifier(
						deps.declaredNames,
						deps.dbCasing ?? 'preserve',
						{ kind: 'table', table: resolved.range.table },
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
				targetTable: resolved.range.table,
				alias: tableAlias,
				joinType: resolved.type,
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

/** Public SELECT compilation requires authority from this loaded copy of dbsp (plan(), the ORM or NQL). */
export function assertPlannedReportAuthority(plan: PlanReport): void {
	if (!isPlannedReport(plan)) {
		throw new Error(
			'Adapter compilation requires a report planned by this loaded copy of dbsp (plan(), the ORM or NQL); plan the query with this loaded copy, or use compilePlan from @dbsp/adapter-pgsql/internal for decision-level compilation',
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
	if (
		[plan.intent, plan.executableIntent].some((intent) => {
			const count = intent?.joins?.length ?? 0;
			return count > 0 && plan.execution?.joins?.length !== count;
		})
	) {
		const error = new Error(
			'Planned joins require matching resolved execution joins',
		);
		error.name = 'InvalidResolvedJoinsError';
		throw error;
	}
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
	let hydrationPlan: PlanReport | undefined;
	// planForCompilation: a view of the plan where .intent is the executable intent.
	// Condition extraction still consumes executable WHERE until PR 3.
	// Includes consume execution nodes, independently of this intent view.
	// buildSimplifiedPlanReport also uses it for batchValuesSource / existsWrap / lock.
	const planForCompilation: PlanReport =
		plan.executableIntent !== undefined
			? { ...plan, intent: plan.executableIntent }
			: plan;
	let simplifiedPlan: SimplifiedPlanReport;

	if (execIntent) {
		const resolvedWhere = plan.execution?.where;
		const decisions = intentToDecisions(execIntent, plan.rootTable, {
			omitRootWhere: true,
			directConditions: true,
		});

		const enrichedUnifiedDecisions = planForCompilation.execution
			? lowerResolvedIncludes(planForCompilation.execution, deps.defaultPk)
			: [];

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

		// Lower resolved joins; the intent is read only for values payloads.
		// These are non-hydrating SQL JOINs (flat result, no relation columns added).
		// joins are not affected by the IN→EXISTS WHERE optimization; execIntent and
		// plan.intent carry the same joins value.
		const joinIntentDecisions = plan.execution?.joins?.length
			? compileJoinIntents(
					execIntent.joins ?? [],
					plan.execution!,
					schemaName,
					deps,
				)
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
				? markPlannedReport({
						...planForCompilation,
						intent: plan.intent,
						includePayloads,
						includePayloadsByNodeId: payloadsByNodeId(enrichedUnifiedDecisions),
					})
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
		if (resolvedWhere)
			simplifiedPlan = {
				...simplifiedPlan,
				resolvedWhere,
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
