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
	PlanReport,
	SubqueryIncludeInfo,
} from '@dbsp/types';
import type { Mutable } from '@dbsp/types/internal';
import type { AdapterCompilerDeps } from './adapter-compiler-deps.js';
import {
	type CompilerOptions,
	compilePlan,
	type PlanDecision,
	type SimplifiedPlanReport,
} from './compiler.js';
import { intentToDecisions } from './intent-to-decisions.js';
import {
	convertDottedFieldsToExists,
	deriveForeignKey,
	extractAllIncludeDecisions,
	extractExistsDecisions,
} from './plan-decision-extractor.js';

// ============================================================================
// Internal: legacy bridge
// ============================================================================

/**
 * Bridge core's PlanDecision[] (observability format) to adapter's PlanDecision[].
 * Used only in the legacy/test path where mock plans carry adapter-format decisions
 * inside a core PlanReport. At runtime the data is already in adapter format.
 */
export function bridgeLegacyDecisions(
	decisions: readonly unknown[],
): SimplifiedPlanReport['decisions'] {
	return decisions as SimplifiedPlanReport['decisions'];
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

		// Filter out broken EXISTS decisions from intentToDecisions
		// (they use relation name as targetTable instead of actual table name)
		decisions = decisions.filter(
			(d) =>
				!(
					d.type === 'where' &&
					(d.operator === 'exists' || d.operator === 'notExists')
				),
		);

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

		// Propagate filter conditions from EXISTS to matching include decisions
		// When a relation is both filtered and included, the filter should appear
		// in both the EXISTS subquery AND the include subquery
		const enrichedUnifiedDecisions = unifiedIncludeDecisions.map((jd) => {
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

		// INCLUDE-COUNT: When the query is aggregate-only (no GROUP BY fields),
		// join includes must not contribute SELECT columns — only the JOIN itself
		// is needed (for filtering). Strip `columns` from join includeStrategy
		// decisions so the join handler emits only the JoinExpr, not ResTargets.
		// Without this fix, mixing COUNT(*) with a join include produces invalid SQL:
		//   SELECT COUNT(*), "file"."id" AS "file.id" FROM ... -- PG rejects this
		const isAggregateOnly =
			plan.intent?.select &&
			'type' in plan.intent.select &&
			plan.intent.select.type === 'aggregate' &&
			!(
				'fields' in plan.intent.select &&
				(plan.intent.select as { fields?: unknown }).fields
			);
		if (isAggregateOnly) {
			for (const d of enrichedUnifiedDecisions) {
				if (d.type === 'includeStrategy' && d.choice === 'join') {
					(d as Mutable<PlanDecision>).columns = [];
				}
			}
		}

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

		// Collect specific columns per relation from selectRelationColumn
		// decisions that will be deduplicated. This preserves column info
		// (including user-supplied aliases) that would otherwise be lost
		// when selectRelationColumn decisions are removed.
		//
		// Key: full relation path (e.g. 'callee' for 1-hop, 'callee.file' for
		// 2-hop). This lets relationColumn('callee.file', 'path', 'fp') target
		// the leaf includeStrategy decision (relationName='file') rather than
		// the 1st-hop one (relationName='callee').
		type RelationColumnEntry = { col: string; alias?: string };
		const relationColumnsMap = new Map<string, RelationColumnEntry[]>();

		/**
		 * Find the relationColumnsMap key for a given includeStrategy relationName.
		 * Exact match first (1-hop); then suffix match '.relationName' (2-hop+).
		 */
		function findRelationMapKey(relationName: string): string | undefined {
			if (relationColumnsMap.has(relationName)) return relationName;
			const suffix = `.${relationName}`;
			for (const key of relationColumnsMap.keys()) {
				if (key.endsWith(suffix)) return key;
			}
			return undefined;
		}

		if (includedRelations.size > 0) {
			for (const d of decisions) {
				if (d.type === 'selectRelationColumn' && d.relation && d.column) {
					const col = d.column as string;
					const alias = d.alias as string | undefined;
					const fullRelation = d.relation as string;
					const rootRelation = fullRelation.split('.')[0] ?? '';
					if (includedRelations.has(rootRelation)) {
						// Use full path as map key so 'callee.file' is stored separately
						// from 'callee' — avoids injecting 2-hop columns into 1-hop includes.
						const mapKey = fullRelation;
						if (col === '*') {
							// Wildcard: select all columns from relation (no aliases)
							relationColumnsMap.set(mapKey, [{ col: '*' }]);
							continue;
						}
						const existing = relationColumnsMap.get(mapKey);
						if (existing) {
							if (existing.length === 1 && existing[0]?.col === '*') {
								// Wildcard already set — skip
								continue;
							}
							if (!existing.some((e) => e.col === col)) {
								existing.push({ col, alias });
							}
						} else {
							relationColumnsMap.set(mapKey, [{ col, alias }]);
						}
					}
				}
			}

			// Inject collected columns and aliases into matching includeStrategy decisions
			if (relationColumnsMap.size > 0) {
				for (const d of enrichedUnifiedDecisions) {
					if (d.type === 'includeStrategy' && d.relationName) {
						const mapKey = findRelationMapKey(d.relationName as string);
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
			}

			// Validate injected columns exist in target table schema
			const validationModel = options?.model ?? deps.model;
			if (validationModel && relationColumnsMap.size > 0) {
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
						const targetTable = validationModel.getTable(
							d.targetTable as string,
						);
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

		const allDecisions = [
			...deduplicatedDecisions,
			...existsDecisions,
			...enrichedUnifiedDecisions,
		];

		// Enrich range operator decisions with dataType from model
		// (PostgreSQL requires explicit type casts for range parameters)
		const model = options?.model;
		if (model) {
			for (let i = 0; i < allDecisions.length; i++) {
				const d = allDecisions[i];
				if (
					d &&
					d.type === 'where' &&
					(d.operator === 'contains' ||
						d.operator === 'containedBy' ||
						d.operator === 'overlaps')
				) {
					const tableName = d.table || plan.rootTable;
					const table = model.getTable(tableName);
					if (table) {
						const col = table.columns.find((c) => c.name === d.column);
						if (col?.type.endsWith('range')) {
							allDecisions[i] = {
								...d,
								dataType: col.type,
							} as typeof d;
						}
					}
				}
			}
		}

		simplifiedPlan = {
			rootTable: plan.rootTable,
			decisions: allDecisions,
			...(schemaName ? { schema: schemaName } : {}),
			...(plan.intent?.existsWrap ? { existsWrap: true } : {}),
			...(plan.intent?.lock ? { lock: plan.intent.lock } : {}),
		};
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

// ============================================================================
// compileWithIncludes
// ============================================================================

/**
 * Compile a plan with includes, returning subquery include metadata (DX-033).
 * Extracted body of PgsqlAdapter.compileWithIncludes().
 */
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
