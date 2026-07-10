/**
 * SELECT compilation: converts PlanReport to CompiledQuery.
 * Extracted from PgsqlAdapter.compile() and PgsqlAdapter.compileWithIncludes().
 *
 * @internal
 */

import { countDistinctRelationPathsByName } from '@dbsp/core';
import type {
	CompiledQuery,
	CompileOptions,
	CompileResultWithIncludes,
	JoinIntent,
	PlanReport,
	SubqueryIncludeInfo,
} from '@dbsp/types';
import { toColumnList } from '@dbsp/types';
import type { Mutable } from '@dbsp/types/internal';
import type { Node } from '@pgsql/types';
import type { AdapterCompilerDeps } from './adapter-compiler-deps.js';
import { defaultFkDerivation } from './assert-field.js';
import { funcCall, rangeVar } from './ast-helpers.js';
import { schemaForFromName } from './binding-registry.js';
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
import { createCompilerState } from './handlers/types.js';
import { intentToDecisions } from './intent-to-decisions.js';
import { createTypeCastParamRef } from './param-ref.js';
import {
	convertDottedFieldsToExists,
	deriveForeignKey,
	enrichExistsDecisionsInPlace,
	extractAllIncludeDecisions,
	synthesizeMissingJoinDecisions,
} from './plan-decision-extractor.js';

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
				...(deps.bindingNames !== undefined && {
					bindingNames: deps.bindingNames,
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
				...(deps.bindingNames !== undefined && {
					bindingNames: deps.bindingNames,
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
			const joinedRangeVar = rangeVar(
				intent.table,
				tableAlias,
				schemaForFromName(schemaName, intent.table, deps.bindingNames, naming),
				naming,
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
	// schemaName precedence (options > adapter ctor) is resolved in PgsqlAdapter.buildCompileDeps; deps.schemaName is authoritative here
	const schemaName = deps.schemaName;

	const resolvedModelForCompiler = options?.model ?? deps.model;
	const compilerOptions: CompilerOptions = {
		naming: deps.naming,
		...(schemaName && { schema: schemaName }),
		defaultPkColumnName: deps.defaultPk,
		deriveFkColumnName: deps.deriveFk,
		...(deps.bindingNames !== undefined && {
			bindingNames: deps.bindingNames,
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
		// Real usage: convert intent to decisions
		let decisions = intentToDecisions(execIntent, plan.rootTable);

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

		// Phase 3: Extract ALL include decisions (json_agg, join, lateral, cte, subquery)
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
							const rootRelation = rel.split('.')[0] ?? rel;
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

	// Extract subquery include info from planner decisions.
	// Decisions with choice === 'subquery' need separate execution:
	// mapToHandlerDecision lowers them to json_agg at the SQL level so the main
	// query compiles, but hydrateJsonAggIncludes only processes decisions whose
	// planner choice is 'json_agg'. When the user sets defaultIncludeStrategy:
	// 'subquery', planner decisions carry choice === 'subquery', so hydration
	// must happen via the subquery path (separate query + hydrateIncludes).
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
		const fk = toColumnList(rawFk);
		const parentKey = toColumnList(ctx.parentKey);

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
		const sourceKey = isBelongsTo
			? fk
			: parentKey.length > 0
				? parentKey
				: [deps.defaultPk];
		const targetFk = isBelongsTo
			? parentKey.length > 0
				? parentKey
				: [deps.defaultPk]
			: fk;

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
