/**
 * SELECT compilation: converts PlanReport to CompiledQuery.
 * Extracted from PgsqlAdapter.compile() and PgsqlAdapter.compileWithIncludes().
 *
 * @internal
 */

import type {
	CompiledQuery,
	CompileOptions,
	CompileResultWithIncludes,
	JoinIntent,
	PlanReport,
	SubqueryIncludeInfo,
} from '@dbsp/types';
import type { Mutable } from '@dbsp/types/internal';
import type { Node } from '@pgsql/types';
import type { AdapterCompilerDeps } from './adapter-compiler-deps.js';
import { defaultFkDerivation } from './assert-field.js';
import { funcCall, rangeVar } from './ast-helpers.js';
import { compileWhereIntent, type WhereCompilerCtx } from './compile-where.js';
import {
	type CompilerOptions,
	compilePlan,
	type PlanDecision,
	type SimplifiedPlanReport,
} from './compiler.js';
import { inferPgArrayType, stripArraySuffix } from './compiler-utils.js';
import { createCompilerState } from './handlers/types.js';
import { intentToDecisions } from './intent-to-decisions.js';
import { createTypeCastParamRef } from './param-ref.js';
import {
	convertDottedFieldsToExists,
	deriveForeignKey,
	extractAllIncludeDecisions,
	extractExistsDecisions,
	synthesizeMissingJoinDecisions,
} from './plan-decision-extractor.js';

// ============================================================================
// Internal: legacy bridge
// ============================================================================

/**
 * Bridge core's PlanDecision[] (observability format) to adapter's PlanDecision[].
 * Used only in the legacy/test path where mock plans carry adapter-format decisions
 * inside a core PlanReport. At runtime the data is already in adapter format.
 */
/**
 * Recursively strip exists/notExists decisions from a decision tree.
 * Handles top-level decisions and those nested inside whereAnd/whereOr/whereNot.
 * Returns null when the decision itself should be removed.
 * Containers (whereAnd/whereOr/whereNot) that become empty after stripping are also removed.
 */
function stripExistsFromDecision(d: PlanDecision): PlanDecision | null {
	if (
		d.type === 'where' &&
		(d.operator === 'exists' || d.operator === 'notExists')
	) {
		return null;
	}
	if (
		(d.type === 'whereAnd' || d.type === 'whereOr' || d.type === 'whereNot') &&
		d.conditions
	) {
		const stripped = (d.conditions as PlanDecision[])
			.map(stripExistsFromDecision)
			.filter((c): c is PlanDecision => c !== null);
		if (stripped.length === 0) return null;
		return { ...d, conditions: stripped };
	}
	return d;
}

export function bridgeLegacyDecisions(
	decisions: readonly unknown[],
): SimplifiedPlanReport['decisions'] {
	return decisions as SimplifiedPlanReport['decisions'];
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

	const unnestArgs: Node[] = bv.columns.map((col, i) => {
		const colArray: unknown[] = (bv.data[i] as unknown[]) ?? [];
		const sampleValue = colArray.find((v) => v !== null && v !== undefined);
		const colTypes: Record<string, string> = {};
		if (bv.types[i]) colTypes[col] = bv.types[i] as string;
		const pgArrayType = inferPgArrayType(col, colTypes, sampleValue);
		const pgBaseType = stripArraySuffix(pgArrayType);

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
	const naming = deps.naming;
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
			const rawFk = rel.foreignKey
				? Array.isArray(rel.foreignKey)
					? rel.foreignKey[0]!
					: rel.foreignKey
				: deriveFk(isBelongsTo ? rootTable : rel.target, defaultPk);

			const sourceColumn = isBelongsTo ? rawFk : defaultPk;
			const targetColumn = isBelongsTo ? defaultPk : rawFk;
			const alias = intent.alias ?? intent.relation;

			results.push({
				type: 'join',
				targetTable: rel.target,
				alias,
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
				naming,
				outerTable: alias,
				...(schemaName !== undefined && { schemaName }),
				...(model !== undefined && { model }),
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
			// ON conditions for joins are typically column-to-column comparisons
			// (no $N parameters), so a fresh param state is safe.
			const paramState = createCompilerState();

			const tableAlias = intent.alias ?? intent.table;

			// Pre-populate aliases so ref("rootTable.col") and similar expressions
			// resolve the correct table qualifier when the alias differs from the
			// base table name.
			const tableAliasMap = new Map<string, string>();
			tableAliasMap.set(rootTable, rootTable);
			if (tableAlias !== rootTable) {
				tableAliasMap.set(tableAlias, intent.table);
			}

			const ctx: WhereCompilerCtx = {
				rootTable,
				aliases: tableAliasMap,
				paramState,
				naming,
				// outerTable = tableAlias so FieldRef(scope:'outer') resolves to the
				// joined alias (e.g. 'e2' in self-join ON conditions).
				outerTable: tableAlias,
				...(schemaName !== undefined && { schemaName }),
				...(model !== undefined && { model }),
				compileSubquery: () => {
					throw new Error('Subquery in JOIN ON condition is not supported.');
				},
			};

			const onNode: Node = compileWhereIntent(intent.on, ctx);

			// Store rarg + onNode separately — the 'join' case in compiler.ts wraps
			// from[0] as larg so multiple .join() calls chain correctly.
			const joinedRangeVar = rangeVar(
				intent.table,
				tableAlias,
				schemaName,
				naming,
			);

			results.push({
				type: 'join',
				targetTable: intent.table,
				alias: tableAlias,
				joinType: intent.type,
				joinRarg: joinedRangeVar,
				joinOnNode: onNode,
			});
		}
	}

	return results;
}

// ============================================================================
// Phase helpers — extracted from compileSelect for CC reduction
// ============================================================================

/**
 * Propagate filter conditions from EXISTS decisions to matching includeStrategy decisions.
 * When a relation is both filtered (EXISTS) and included, the filter appears in both
 * the EXISTS subquery AND the include subquery.
 */
function propagateExistsConditions(
	includeDecisions: readonly PlanDecision[],
	existsDecisions: readonly PlanDecision[],
): PlanDecision[] {
	return includeDecisions.map((jd) => {
		if (jd.type !== 'includeStrategy' || !jd.relationName) return jd;

		const matchingExists = existsDecisions.find(
			(ed) =>
				ed.type === 'where' &&
				(ed.operator === 'exists' || ed.operator === 'notExists') &&
				(ed.relationName === jd.relationName ||
					ed.targetTable === jd.targetTable) &&
				ed.conditions &&
				(ed.conditions as PlanDecision[]).length > 0,
		);

		if (matchingExists?.conditions) {
			return { ...jd, conditions: matchingExists.conditions };
		}
		return jd;
	});
}

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

/**
 * Find the map key for a given includeStrategy relationName.
 * Exact match first (1-hop); then suffix match '.relationName' (2-hop+).
 */
function findRelationMapKey(
	map: Map<string, RelationColumnEntry[]>,
	relationName: string,
): string | undefined {
	if (map.has(relationName)) return relationName;
	const suffix = `.${relationName}`;
	for (const key of map.keys()) {
		if (key.endsWith(suffix)) return key;
	}
	return undefined;
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
			const mapKey = findRelationMapKey(
				relationColumnsMap,
				d.relationName as string,
			);
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

/**
 * Compile a PlanReport to a parameterised SELECT query.
 * Extracted body of PgsqlAdapter.compile().
 */
export function compileSelect<T = unknown>(
	plan: PlanReport,
	options: CompileOptions | undefined,
	deps: AdapterCompilerDeps,
): CompiledQuery<T> {
	const schemaName = deps.schemaName ?? options?.schemaName;

	const resolvedModelForCompiler = options?.model ?? deps.model;
	const compilerOptions: CompilerOptions = {
		naming: deps.naming,
		...(schemaName && { schema: schemaName }),
		defaultPkColumnName: deps.defaultPk,
		deriveFkColumnName: deps.deriveFk,
		...(resolvedModelForCompiler != null && {
			model: resolvedModelForCompiler,
		}),
	};

	// Convert PlanReport (core) → SimplifiedPlanReport (pgsql compiler)
	// The core's plan.decisions contain observability data, not SQL instructions.
	// The actual query structure is in plan.intent (QueryIntent).
	// Note: For unit tests with mock plans (no intent), fall back to plan.decisions directly.
	let simplifiedPlan: SimplifiedPlanReport;

	if (plan.intent) {
		// Real usage: convert intent to decisions
		let decisions = intentToDecisions(plan.intent, plan.rootTable);

		// Strip exists/notExists decisions from intentToDecisions — they use the
		// relation name as targetTable (unresolved). extractExistsDecisions (below)
		// provides the correct decisions with the actual table name from the planner.
		// Must recurse into whereAnd/whereOr/whereNot to catch nested occurrences
		// (e.g. notExists inside and() produces a whereAnd containing a notExists).
		decisions = decisions
			.map(stripExistsFromDecision)
			.filter((d): d is PlanDecision => d !== null);

		// Convert dotted-field comparisons (e.g., "parent.name") to EXISTS subqueries
		// NQL compiles relation-path filters as plain comparisons with dotted field names
		const resolvedModel = options?.model ?? deps.model;
		if (resolvedModel) {
			decisions = convertDottedFieldsToExists(
				decisions,
				plan.rootTable,
				resolvedModel,
			);
		}

		// Add correct EXISTS decisions from planner's filter-strategy decisions
		// (they have the actual target table in context.target)
		const existsDecisions = extractExistsDecisions(plan, options?.model);

		// Phase 3: Extract ALL include decisions (json_agg, join, lateral, cte, subquery)
		const unifiedIncludeDecisions = extractAllIncludeDecisions(
			plan,
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
					plan,
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

		// Propagate filter conditions from EXISTS to matching include decisions.
		// When a relation is both filtered and included, the filter appears in both
		// the EXISTS subquery AND the include subquery.
		const enrichedUnifiedDecisions = propagateExistsConditions(
			allUnifiedIncludeDecisions,
			existsDecisions,
		);

		// Strip auto-selected columns from join includes when aggregation, DISTINCT,
		// GROUP BY, or explicit column selection is active. Keeps the JOIN for
		// filtering/inner join semantics but prevents invalid SELECT column lists.
		stripJoinColumnsForAggregation(enrichedUnifiedDecisions, plan.intent);

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
							const rootRelation = rel.split('.')[0] ?? rel;
							if (includedRelations.has(rootRelation)) {
								return false; // covered by include strategy
							}
						}
						return true;
					})
				: decisions;

		// Compile explicit JoinIntent[] from plan.intent.joins into 'join' decisions.
		// These are non-hydrating SQL JOINs (flat result, no relation columns added).
		const joinIntentDecisions =
			plan.intent?.joins && (plan.intent.joins as JoinIntent[]).length > 0
				? compileJoinIntents(
						plan.intent.joins as JoinIntent[],
						plan.rootTable,
						schemaName,
						deps,
					)
				: [];

		const allDecisions = [
			...deduplicatedDecisions,
			...existsDecisions,
			...enrichedUnifiedDecisions,
			...joinIntentDecisions,
		];

		// Enrich range operator decisions with dataType from model
		// (PostgreSQL requires explicit type casts for range parameters)
		enrichRangeDecisions(allDecisions, options?.model, plan.rootTable);

		simplifiedPlan = buildSimplifiedPlanReport(plan, allDecisions, schemaName);
	} else {
		// Unit test with mock data: use decisions directly (legacy format).
		// Tests supply adapter-format PlanDecisions inside a core PlanReport,
		// so the runtime data is already in the right shape — bridge the type gap.
		simplifiedPlan = {
			rootTable: plan.rootTable,
			decisions: bridgeLegacyDecisions(plan.decisions),
			...(schemaName ? { schema: schemaName } : {}),
		};
	}

	const result = compilePlan(simplifiedPlan, compilerOptions);

	return {
		sql: result.sql,
		parameters: result.parameters,
	};
}

export function compileWithIncludes<T = unknown>(
	plan: PlanReport,
	options: CompileOptions | undefined,
	deps: AdapterCompilerDeps,
): CompileResultWithIncludes<T> {
	const main = compileSelect<T>(plan, options, deps);

	// Extract subquery include info from planner decisions
	// Decisions with choice === 'subquery' need separate execution
	const subqueryIncludes: SubqueryIncludeInfo[] = [];

	for (const d of plan.decisions) {
		if (d.type !== 'include-strategy' || d.choice !== 'subquery') continue;

		const ctx = d.context;
		if (!ctx.target) continue;

		const relationName = ctx.includeAlias ?? ctx.relation;
		if (!relationName) continue;

		// Derive FK using shared helper
		const rawFk =
			deriveForeignKey(ctx, deps.deriveFk, deps.defaultPk) ?? deps.defaultPk;
		const fk = Array.isArray(rawFk) ? rawFk[0]! : rawFk;

		// For subquery include, we need:
		// - sourceKey: column on the parent result to extract IDs from
		// - foreignKey: column on the target table to match via WHERE ... IN
		//
		// belongsTo (posts → author): FK=authorId is on source.
		//   Extract authorId from parents → SELECT * FROM authors WHERE id IN (...)
		//   sourceKey=authorId, foreignKey=id (target PK)
		//
		// hasMany (authors → posts): FK=authorId is on target.
		//   Extract id from parents → SELECT * FROM posts WHERE author_id IN (...)
		//   sourceKey=id, foreignKey=authorId (target FK)
		const isBelongsTo = ctx.relationType === 'belongsTo';
		const sourceKey = isBelongsTo ? fk : 'id';
		const targetFk = isBelongsTo ? 'id' : fk;

		// Find matching include intent for select/where passthrough
		const includeIntent = (
			plan.intent?.include as Array<Record<string, unknown>> | undefined
		)?.find(
			(i) => i.relation === relationName || i.relation === ctx.includeAlias,
		);

		const entry: Mutable<SubqueryIncludeInfo> = {
			relationName,
			targetTable: ctx.target,
			foreignKey: targetFk,
			sourceKey,
			sourceTable: ctx.sourceTable ?? plan.rootTable,
		};
		if (typeof ctx.relationType === 'string') {
			entry.relationType = ctx.relationType;
		}
		if (includeIntent?.select != null) {
			entry.select = includeIntent.select as NonNullable<
				SubqueryIncludeInfo['select']
			>;
		}
		if (includeIntent?.where != null) {
			entry.where = includeIntent.where as NonNullable<
				SubqueryIncludeInfo['where']
			>;
		}
		subqueryIncludes.push(entry);
	}

	return { main, subqueryIncludes };
}
