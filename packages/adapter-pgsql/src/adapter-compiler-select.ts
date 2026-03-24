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
import type { Node } from '@pgsql/types';
import {
	type CompilerOptions,
	compilePlan,
	type PlanDecision,
	type SimplifiedPlanReport,
} from './compiler.js';
import { buildSubqueryFromIntent, compileWhereIntent, type WhereCompilerCtx } from './compile-where.js';
import { andExpr } from './ast-helpers.js';
import { deparseQuoted } from './deparse.js';
import { createCompilerState } from './handlers/types.js';
import { buildClauseDecisions, convertSelectIntent } from './intent-to-decisions.js';
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
/**
 * Recursively strip exists/notExists decisions from a decision tree.
 * Handles top-level decisions and those nested inside whereAnd/whereOr/whereNot.
 * Returns null when the decision itself should be removed.
 * Containers (whereAnd/whereOr/whereNot) that become empty after stripping are also removed.
 */
function stripExistsFromDecision(
	d: PlanDecision,
): PlanDecision | null {
	if (d.type === 'where' && (d.operator === 'exists' || d.operator === 'notExists')) {
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
		// Real usage: compile SELECT-list decisions from intent.
		// ORDER BY, GROUP BY, DISTINCT, LIMIT, OFFSET are compiled via buildClauseDecisions below.
		// WHERE and HAVING are compiled separately via compileWhereIntent (injected into AST after compilePlan).
		let decisions = convertSelectIntent(plan.intent.select, plan.rootTable);

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

		// DISTINCT-VECTOR: When SELECT DISTINCT is active, join includes must NOT
		// contribute their full column list to the SELECT. PostgreSQL requires all
		// expressions in the SELECT list to be comparable for DISTINCT; vector-type
		// columns have no equality operator and cause "ERROR: could not identify an
		// equality operator for type vector".
		// Keep the JOIN (for filtering) but strip the auto-selected columns.
		// Explicitly requested columns (via relationColumn()) are still injected
		// below via relationColumnsMap — they are the caller's responsibility to
		// make DISTINCT-safe.
		const isDistinct = plan.intent?.distinct === true;
		if (isDistinct) {
			for (const d of enrichedUnifiedDecisions) {
				if (d.type === 'includeStrategy' && d.choice === 'join') {
					(d as Mutable<PlanDecision>).columns = [];
				}
			}
		}

		// GROUP-BY-JOIN: When GROUP BY is active, join includes must NOT contribute
		// their hydration columns to the SELECT. PostgreSQL requires all non-aggregate
		// expressions in the SELECT list to appear in the GROUP BY clause; auto-selected
		// join columns (e.g. "file"."id" AS "file.id") are not in GROUP BY and cause
		// "ERROR: column must appear in the GROUP BY clause".
		// Keep the JOIN (for filtering/inner join semantics) but strip auto-columns.
		// Explicitly requested columns (via relationColumn()) are still preserved —
		// the caller is responsible for including them in groupBy().
		const hasGroupBy =
			plan.intent?.groupBy && plan.intent.groupBy.length > 0;
		if (hasGroupBy) {
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
								existing.push({ col, ...(alias !== undefined && { alias }) });
							}
						} else {
							relationColumnsMap.set(mapKey, [{ col, ...(alias !== undefined && { alias }) }]);
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

		// -----------------------------------------------------------------------
		// PRIMARY PATH: compileWhereIntent is now the canonical WHERE/HAVING path.
		//
		// Strategy (Option B):
		//   1. Strip WHERE/HAVING decisions from allDecisions before compilePlan.
		//      compilePlan generates SELECT columns, JOINs, ORDER BY, GROUP BY,
		//      LIMIT, OFFSET params — but NOT WHERE/HAVING params.
		//   2. After compilePlan, seed a shared CompilerState from result.parameters
		//      so that $N indices from compileWhereIntent continue from the correct
		//      offset (e.g. if compilePlan used $1..$3, WHERE params start at $4).
		//   3. Inject the resulting AST nodes into result.ast.SelectStmt and
		//      re-deparse to produce the final SQL.
		//
		// The `compileSubquery` callback throws for SubqueryExpressionIntent inside
		// WHERE — this is not used by any of the 16 standard WHERE kinds (comparison,
		// like, in, any, null, range, and, or, not, exists, notExists, expression,
		// jsonContains, jsonExists, subquery, relationFilter). It remains a throw
		// only for the rare SubqueryExpression-inside-WHERE edge case which was
		// never supported by the decision path either.
		// -----------------------------------------------------------------------

		// -----------------------------------------------------------------------
		// Filter WHERE/HAVING decisions from compilePlan — they will be compiled
		// separately via compileWhereIntent below.
		//
		// IMPORTANT: existsDecisions (from extractExistsDecisions) have
		// type='where' but carry RESOLVED target table names from the planner.
		// They must NOT be filtered — compilePlan must still process them so
		// that EXISTS/NOT EXISTS subqueries use the correct table names.
		//
		// Only filter where/whereAnd/whereOr/whereNot/having decisions that
		// originated from deduplicatedDecisions (i.e. from intentToDecisions).
		// -----------------------------------------------------------------------
		const whereDecisionTypes = new Set([
			'where',
			'whereAnd',
			'whereOr',
			'whereNot',
			'having',
			// PIPE-001: whereRaw/havingRaw emitted by intentToDecisions — filter before
			// compilePlan since plan.intent.where/having are compiled separately below
			// via compileWhereIntent. Without this, WHERE is generated twice.
			'whereRaw',
			'havingRaw',
		]);
		const nonWhereDecisions = [
			...deduplicatedDecisions.filter((d) => {
				if (!whereDecisionTypes.has(d.type)) return true;
				// P1-2 fix: keep type:'where' decisions with operator:'exists' or
				// operator:'notExists' — these were added by convertDottedFieldsToExists
				// and must reach compilePlan to generate the EXISTS subquery SQL.
				// Plain comparison / logical decisions from convertSelectIntent are
				// compiled separately by compileWhereIntent and must be filtered out
				// to avoid duplicates.
				if (
					d.type === 'where' &&
					(d.operator === 'exists' || d.operator === 'notExists')
				) {
					return true;
				}
				return false;
			}),
			...buildClauseDecisions(plan.intent, plan.rootTable), // ORDER BY, GROUP BY, DISTINCT, LIMIT, OFFSET
			...existsDecisions,          // keep — already resolved by planner
			...enrichedUnifiedDecisions, // keep — include strategies (JOINs, json_agg, etc.)
		];

		simplifiedPlan = {
			rootTable: plan.rootTable,
			decisions: nonWhereDecisions,
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

	// For the legacy/test path (no plan.intent), compilePlan handles everything.
	if (!plan.intent) {
		return {
			sql: result.sql,
			parameters: result.parameters,
		};
	}

	// -----------------------------------------------------------------------
	// Inject WHERE / HAVING via compileWhereIntent (primary path).
	//
	// Build a CompilerState seeded from the parameters compilePlan already
	// produced so that $N indices for WHERE params are contiguous.
	// result.parameters is readonly — cast to mutable for sharing.
	// -----------------------------------------------------------------------
	const sharedParams = result.parameters as unknown[];
	const sharedState = {
		...createCompilerState(),
		parameters: sharedParams,
		paramIndex: sharedParams.length,
	};

	const makeWhereCtx = (): WhereCompilerCtx => ({
		rootTable: plan.rootTable,
		aliases: new Map(),
		paramState: sharedState,
		naming: deps.naming,
		...(schemaName && { schemaName }),
		...(resolvedModelForCompiler != null && { model: resolvedModelForCompiler }),
		// Bug 3 fix: pass schemaName through so scalar subqueries are schema-qualified
	compileSubquery: (intent, offset) =>
			buildSubqueryFromIntent(intent, offset, deps.naming, schemaName),
	});

	// Resolve the SelectStmt node for WHERE/HAVING injection.
	// result.ast is a { SelectStmt: ... } Node.
	//
	// P2-4 fix: when existsWrap is active, the outer SelectStmt is a bare wrapper:
	//   SELECT EXISTS(SELECT 1 FROM t WHERE ...) AS "exists"
	// The inner SelectStmt (with the actual FROM clause) is:
	//   result.ast.SelectStmt.targetList[0].ResTarget.val.SubLink.subselect.SelectStmt
	// WHERE/HAVING must be injected into the INNER SelectStmt, not the outer wrapper
	// (which has no FROM clause and would produce invalid SQL).
	const selectNode = result.ast as { SelectStmt?: Record<string, unknown> };
	const outerStmt = selectNode.SelectStmt as Record<string, unknown> | undefined;

	let stmtTarget: Record<string, unknown> | undefined;
	if (plan.intent.existsWrap && outerStmt) {
		// Navigate: outer.targetList[0].ResTarget.val.SubLink.subselect.SelectStmt
		const outerTargetList = outerStmt['targetList'] as Array<{ ResTarget?: { val?: { SubLink?: { subselect?: { SelectStmt?: Record<string, unknown> } } } } }> | undefined;
		const innerSelectStmt = outerTargetList?.[0]?.ResTarget?.val?.SubLink?.subselect?.SelectStmt;
		stmtTarget = innerSelectStmt ?? outerStmt;
	} else {
		stmtTarget = outerStmt;
	}

	// -----------------------------------------------------------------------
	// stripExistsFromIntent: extract only non-exists/notExists/relationFilter
	// conditions from the intent tree so that compileWhereIntent doesn't
	// duplicate the EXISTS nodes that compilePlan already produced.
	// Returns null if the entire intent is existence-related.
	// -----------------------------------------------------------------------
	function stripExistsFromIntent(
		intent: import('@dbsp/types').WhereIntent,
	): import('@dbsp/types').WhereIntent | null {
		const k = intent.kind;
		if (k === 'exists' || k === 'notExists' || k === 'relationFilter') {
			return null;
		}
		// Bug 1 fix: dotted comparisons (e.g. eq('author.name', 'X')) are converted
		// to EXISTS decisions by convertDottedFieldsToExists → compilePlan handles them.
		// compileWhereIntent must NOT also emit them or the WHERE is duplicated/broken.
		if (
			(k === 'comparison' || k === 'like' || k === 'null' || k === 'any' || k === 'in') &&
			'field' in intent &&
			typeof (intent as { field?: unknown }).field === 'string' &&
			(intent as { field: string }).field.includes('.')
		) {
			return null;
		}
		if (k === 'and') {
			const kept = intent.conditions
				.map(stripExistsFromIntent)
				.filter((c): c is import('@dbsp/types').WhereIntent => c !== null);
			if (kept.length === 0) return null;
			if (kept.length === 1) return kept[0]!;
			return { kind: 'and', conditions: kept };
		}
		if (k === 'or') {
			// OR: strip exists branches, keep non-exists branches.
			// Example: or(eq('status','active'), exists('posts')) → eq('status','active')
			// exists() branches are handled by compilePlan (via existsDecisions) separately.
			// Only return null when ALL branches are exists-type (nothing left to compile).
			const kept = intent.conditions
				.map(stripExistsFromIntent)
				.filter((c): c is import('@dbsp/types').WhereIntent => c !== null);
			if (kept.length === 0) return null;
			if (kept.length === 1) return kept[0]!;
			return { kind: 'or', conditions: kept };
		}
		if (k === 'not') {
			const inner = stripExistsFromIntent(intent.condition);
			if (inner === null) return null;
			return { kind: 'not', condition: inner };
		}
		return intent;
	}

	let didInject = false;
	if (stmtTarget) {
		if (plan.intent.where) {
			// Compile only non-exists conditions — compilePlan already handled exists
			// via existsDecisions (resolved target tables from the planner).
			const nonExistsWhere = stripExistsFromIntent(plan.intent.where);
			if (nonExistsWhere !== null) {
				const whereNode: Node = compileWhereIntent(nonExistsWhere, makeWhereCtx());
				// AND with existing whereClause (EXISTS nodes from compilePlan).
				const existing = stmtTarget['whereClause'] as Node | undefined;
				stmtTarget['whereClause'] = existing
					? andExpr(existing, whereNode)
					: whereNode;
				didInject = true;
			}
		}
		if (plan.intent.having) {
			// HAVING has no exists/notExists — compile directly.
			const havingNode: Node = compileWhereIntent(plan.intent.having, makeWhereCtx());
			stmtTarget['havingClause'] = havingNode;
			didInject = true;
		}
	}

	// Re-deparse only when we injected something new.
	const finalSql = didInject ? deparseQuoted(result.ast) : result.sql;

	return {
		sql: finalSql,
		parameters: sharedParams,
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
