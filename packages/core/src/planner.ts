/**
 * @module planner
 * Semantic Planner - Decision engine for query planning.
 * Transforms QueryIntent + ModelIR into PlanReport with strategic decisions.
 *
 * Type definitions live in @dbsp/types. This module re-exports them
 * and provides runtime functions.
 */

import type {
	CTEDefinition,
	DecisionType,
	DialectCapabilities,
	PlanDecision,
	PlanOptions,
	PlanReport,
	PlanWarning,
	RecursivePlanOptions,
	RecursivePlanReport,
	ResolvedIncludeStrategy,
} from '@dbsp/types';
import { resolveJsonAggOrderKey, toColumnList } from '@dbsp/types';
import { resolveIncludeRelationName } from '@dbsp/types/internal';
import { InvalidOperationError } from './dx/errors.js';
import { validateLimit } from './dx/limit-validation.js';
import {
	getNodeIdAlias,
	type IncludeIntent,
	isRawExpression,
	type QueryIntent,
	type RecursiveIntent,
	type WhereAndIntent,
	type WhereInIntent,
	type WhereIntent,
	type WhereNotIntent,
	type WhereOrIntent,
} from './intent-ast.js';
import type { ModelIR, RelationIR } from './model-ir.js';

// Re-export all planner types from @dbsp/types for backward compatibility
export type {
	CTEDefinition,
	DecisionType,
	PlanDecision,
	PlanOptions,
	PlanReport,
	PlanWarning,
	RecursivePlanOptions,
	RecursivePlanReport,
	ResolvedIncludeStrategy,
} from '@dbsp/types';

// ============================================================================
// Warning Types
// ============================================================================

/**
 * Warning codes for planning issues
 */

/**
 * A warning about the query plan
 */

// ============================================================================
// CTE Types
// ============================================================================

/**
 * CTE definition for extracted subqueries
 */

// ============================================================================
// Plan Report
// ============================================================================

/**
 * Complete plan report
 */

// ============================================================================
// Plan Options
// ============================================================================

/**
 * Planning options for customization
 */

// ============================================================================
// Errors
// ============================================================================

/**
 * Error thrown when plan cannot be created due to ambiguity
 */
export class AmbiguousPlanError extends Error {
	readonly sourceTable: string;
	readonly targetTable: string;
	readonly options: readonly string[];

	constructor(
		sourceTable: string,
		targetTable: string,
		options: readonly string[],
		intentPath?: string,
	) {
		super(
			`Ambiguous relation from "${sourceTable}" to "${targetTable}"${intentPath ? ` at "${intentPath}"` : ''}. ` +
				`Use "via" to specify one of: ${options.join(', ')}`,
		);
		this.name = 'AmbiguousPlanError';
		this.sourceTable = sourceTable;
		this.targetTable = targetTable;
		this.options = options;
	}
}

/**
 * Error thrown when recursive CTE base/recursive cases have incompatible shapes.
 * Per RFC-001: columns must match in count, order, and be type-compatible.
 */
export class RecursiveShapeMismatchError extends Error {
	readonly cteName: string;
	readonly baseColumns: readonly string[];
	readonly recursiveColumns: readonly string[];
	readonly mismatchDetails: string;

	constructor(
		cteName: string,
		baseColumns: readonly string[],
		recursiveColumns: readonly string[],
		mismatchDetails: string,
	) {
		super(
			`Recursive CTE "${cteName}" shape mismatch: ${mismatchDetails}. ` +
				`Base columns: [${baseColumns.join(', ')}], ` +
				`Recursive columns: [${recursiveColumns.join(', ')}]`,
		);
		this.name = 'RecursiveShapeMismatchError';
		this.cteName = cteName;
		this.baseColumns = baseColumns;
		this.recursiveColumns = recursiveColumns;
		this.mismatchDetails = mismatchDetails;
	}
}

// ============================================================================
// Recursive CTE Shape Validation Helpers
// ============================================================================

/**
 * Computes expected base case columns from RecursiveIntent.
 * Order: [node_id_alias, ...select_fields, depth (if track.depth), path (if track.path)]
 */
function computeBaseColumns(intent: RecursiveIntent): readonly string[] {
	const columns: string[] = [];

	// node_id is always first
	columns.push(getNodeIdAlias(intent.start.nodeIdExpr));

	// select fields (if specified)
	if (intent.start.select) {
		columns.push(...intent.start.select);
	}

	// tracked columns
	if (intent.track?.depth) {
		columns.push('depth');
	}
	if (intent.track?.path) {
		columns.push('path');
	}

	return Object.freeze(columns);
}

/**
 * Computes expected recursive step columns from RecursiveIntent.
 * Must match base columns in count and order.
 */
function computeRecursiveColumns(intent: RecursiveIntent): readonly string[] {
	const columns: string[] = [];

	// node_id is always first (from traversal)
	columns.push(getNodeIdAlias(intent.start.nodeIdExpr));

	// select fields must match base
	if (intent.start.select) {
		columns.push(...intent.start.select);
	}

	// tracked columns with expressions
	if (intent.track?.depth) {
		columns.push('depth'); // Will be `prev.depth + 1`
	}
	if (intent.track?.path) {
		columns.push('path'); // Will be `prev.path || id`
	}

	return Object.freeze(columns);
}

/**
 * Validates that base and recursive columns are shape-compatible.
 * Throws RecursiveShapeMismatchError if validation fails.
 */
export function validateRecursiveShape(intent: RecursiveIntent): void {
	const baseColumns = computeBaseColumns(intent);
	const recursiveColumns = computeRecursiveColumns(intent);

	// Check column count
	if (baseColumns.length !== recursiveColumns.length) {
		throw new RecursiveShapeMismatchError(
			intent.cteName,
			baseColumns,
			recursiveColumns,
			`column count mismatch: base has ${baseColumns.length}, recursive has ${recursiveColumns.length}`,
		);
	}

	// Check column order (names must match at each position)
	for (let i = 0; i < baseColumns.length; i++) {
		if (baseColumns[i] !== recursiveColumns[i]) {
			throw new RecursiveShapeMismatchError(
				intent.cteName,
				baseColumns,
				recursiveColumns,
				`column ${i} name mismatch: base has "${baseColumns[i]}", recursive has "${recursiveColumns[i]}"`,
			);
		}
	}
}

// ============================================================================
// Planner State (Internal)
// ============================================================================

interface PlannerState {
	decisions: PlanDecision[];
	warnings: PlanWarning[];
	ctes: CTEDefinition[];
	relationsAnalyzed: number;
	decisionCounters: Record<DecisionType, number>;
	relationAccessCounts: Map<string, string[]>; // relation path -> intent paths
	visitedIncludes: Set<string>; // For circular detection
}

// ============================================================================
// Planner Implementation
// ============================================================================

/**
 * Create a query plan from an intent and model
 */
export function plan(
	intent: QueryIntent,
	model: ModelIR,
	options: PlanOptions = {},
): PlanReport {
	const startTime = performance.now();

	const state: PlannerState = {
		decisions: [],
		warnings: [],
		ctes: [],
		relationsAnalyzed: 0,
		decisionCounters: {
			'filter-strategy': 0,
			'join-type': 0,
			'include-strategy': 0,
			'cte-extraction': 0,
			ambiguity: 0,
			'recursive-cte': 0,
			'bidirectional-edges': 0,
		},
		relationAccessCounts: new Map(),
		visitedIncludes: new Set(),
	};

	const opts: Required<PlanOptions> = {
		forceFilterStrategy: options.forceFilterStrategy as 'exists' | 'join',
		forceJoinType: options.forceJoinType as 'left' | 'inner',
		enableCTEs: options.enableCTEs ?? true,
		cteThreshold: options.cteThreshold ?? 2,
		maxIncludeDepth: options.maxIncludeDepth ?? 5,
		disambiguate: options.disambiguate ?? {},
		defaultIncludeStrategy: options.defaultIncludeStrategy ?? 'auto',
		dialectCapabilities: options.dialectCapabilities as DialectCapabilities,
	};

	validateIncludeStrategy(
		opts.defaultIncludeStrategy,
		opts.dialectCapabilities,
		false,
	);

	// Validate root table — skip when the FROM is a BatchValues unnest() source
	// (the alias is not a real table; schema validation would incorrectly fail)
	const rootTable = intent.batchValuesSource
		? null
		: model.getTable(intent.from);
	if (!intent.batchValuesSource && !rootTable) {
		throw new Error(`Unknown table: ${intent.from}`);
	}

	// Optimize IN-subquery → EXISTS when the relation is known in schema.
	// The optimized WHERE goes into `executableIntent` (adapter compiles from it),
	// while `intent` stays as the original submitted intent (observable via dump()).
	// `plannedIntent` is only used locally to decide whether to emit executableIntent.
	const optimizedWhere = intent.where
		? optimizeInToExists(intent.where, intent.from, model)
		: undefined;

	// Build the post-optimization intent (used as executableIntent when optimization ran)
	const plannedIntent: QueryIntent =
		optimizedWhere !== undefined && optimizedWhere !== intent.where
			? { ...intent, where: optimizedWhere }
			: intent;

	// Process where clause
	if (optimizedWhere) {
		processWhere(optimizedWhere, intent.from, model, state, opts, 'where');
	}

	// Process includes
	if (intent.include) {
		for (let i = 0; i < intent.include.length; i++) {
			const inc = intent.include[i];
			if (inc) {
				processInclude(
					inc,
					intent.from,
					model,
					state,
					opts,
					`include[${i}]`,
					0,
					false,
					'',
					intent,
				);
			}
		}
	}

	// An alternative changes one decision only: resolved neighbors must still
	// form a homogeneous include chain, and CTE cannot have include children.
	const includeDecisions = state.decisions.filter(
		(d) => d.type === 'include-strategy',
	);
	const decisionsByPath = new Map(
		includeDecisions.map((decision) => [
			String(decision.context.intentPath),
			decision,
		]),
	);
	const childrenByPath = new Map<string, PlanDecision[]>();
	for (const decision of includeDecisions) {
		const path = String(decision.context.intentPath);
		if (!path.includes('.')) continue;
		const parentPath = path.slice(0, path.lastIndexOf('.'));
		const children = childrenByPath.get(parentPath) ?? [];
		children.push(decision);
		childrenByPath.set(parentPath, children);
	}
	state.decisions = state.decisions.map((decision) => {
		if (decision.type !== 'include-strategy') return decision;
		const path = String(decision.context.intentPath);
		const parent = path.includes('.')
			? decisionsByPath.get(path.slice(0, path.lastIndexOf('.')))
			: undefined;
		const children = childrenByPath.get(path) ?? [];
		return {
			...decision,
			alternatives: decision.alternatives.filter(
				(candidate) =>
					(!parent ||
						(parent.choice !== 'cte' && candidate === parent.choice)) &&
					children.every(
						(child) => candidate !== 'cte' && candidate === child.choice,
					),
			),
		};
	});

	// Extract CTEs if enabled
	if (opts.enableCTEs) {
		extractCTEs(state, opts.cteThreshold);
	}

	// Detect raw SQL usage and add security warnings
	detectRawSqlUsage(intent, state);

	const planningTimeMs = performance.now() - startTime;

	// PERF (FIND-051): use .slice() instead of spread ([...arr]) — avoids the extra
	// iterable-protocol overhead; semantically identical for plain arrays.
	const ambiguousDecision = state.decisions.find(
		(d) => d.type === 'ambiguity' && d.choice === 'unresolved',
	);

	const metadata: PlanReport['metadata'] = ambiguousDecision
		? Object.freeze({
				planningTimeMs,
				relationsAnalyzed: state.relationsAnalyzed,
				isAmbiguous: true,
				ambiguousOptions: ambiguousDecision.alternatives as readonly string[],
			})
		: Object.freeze({
				planningTimeMs,
				relationsAnalyzed: state.relationsAnalyzed,
				isAmbiguous: false,
			});

	const report: PlanReport = {
		rootTable: intent.from,
		decisions: Object.freeze(state.decisions.slice()),
		warnings: Object.freeze(state.warnings.slice()),
		ctes: Object.freeze(state.ctes.slice()),
		// intent is ALWAYS the original submitted intent (contract: observable via dump()).
		// executableIntent carries the optimized WHERE (e.g. IN→EXISTS) when the
		// optimizer rewrote it, so the adapter compiles the correct SQL from that field.
		// When no optimization applies, executableIntent is left undefined and the
		// adapter falls back to intent.
		intent,
		...(plannedIntent !== intent && { executableIntent: plannedIntent }),
		metadata,
	};

	return Object.freeze(report);
}

// ============================================================================
// Recursive Intent Planning
// ============================================================================

/**
 * RecursivePlanReport extends PlanReport with recursive-specific metadata.
 */

/**
 * Options specific to recursive CTE planning.
 */

/**
 * Create a plan for a recursive CTE intent.
 * Per RFC-001: validates shape, generates decisions for traversal strategy.
 */
export function planRecursive(
	intent: RecursiveIntent,
	model: ModelIR,
	options: RecursivePlanOptions = {},
): RecursivePlanReport {
	const nodeTable =
		intent.traversal.kind === 'custom'
			? intent.start.from
			: intent.traversal.nodeTable;
	const startFrom = intent.start.from ?? nodeTable;
	if (startFrom !== nodeTable) {
		throw new Error(
			`Recursive start.from '${startFrom}' must match traversal.nodeTable '${nodeTable}'.`,
		);
	}

	const startTime = performance.now();

	// Step 1: Validate shape compatibility
	validateRecursiveShape(intent);

	const state: PlannerState = {
		decisions: [],
		warnings: [],
		ctes: [],
		relationsAnalyzed: 0,
		decisionCounters: {
			'filter-strategy': 0,
			'join-type': 0,
			'include-strategy': 0,
			'cte-extraction': 0,
			ambiguity: 0,
			'recursive-cte': 0,
			'bidirectional-edges': 0,
		},
		relationAccessCounts: new Map(),
		visitedIncludes: new Set(),
	};

	// Validate that start table exists
	const startTable = model.getTable(startFrom);
	if (!startTable) {
		throw new Error(`Unknown table: ${startFrom}`);
	}

	// Step 2: Generate recursive-cte decision
	const traversalKind = intent.traversal.kind;

	const recursiveCteDecision: PlanDecision = {
		id: generateDecisionId(state, 'recursive-cte'),
		type: 'recursive-cte',
		context: {
			sourceTable: startFrom,
			intentPath: `recursive:${intent.cteName}`,
		},
		choice: 'with-recursive',
		reasoning: generateRecursiveReasoning(intent),
		alternatives: ['with-recursive', 'iterative'],
	};
	state.decisions.push(recursiveCteDecision);

	// Step 3: Handle bidirectional edges (for edge-table traversal)
	let usesBidirectional = false;
	if (
		traversalKind === 'edge-table' &&
		intent.traversal.kind === 'edge-table'
	) {
		const edgeTraversal = intent.traversal;
		if (edgeTraversal.direction === 'both') {
			usesBidirectional = true;

			const storageHint = edgeTraversal.edgeStorageHint ?? 'unknown';
			const strategy =
				options.forceBidirectionalStrategy ??
				(storageHint === 'directed-only' ? 'union-all' : 'union');

			const bidirectionalDecision: PlanDecision = {
				id: generateDecisionId(state, 'bidirectional-edges'),
				type: 'bidirectional-edges',
				context: {
					sourceTable: startFrom,
					target: edgeTraversal.edgeTable,
					intentPath: `recursive:${intent.cteName}:edges`,
				},
				choice: strategy,
				reasoning: generateBidirectionalReasoning(storageHint, strategy),
				alternatives: ['union', 'union-all'],
			};
			state.decisions.push(bidirectionalDecision);

			// Add warning if using union-all with unknown storage
			if (strategy === 'union-all' && storageHint === 'unknown') {
				state.warnings.push({
					code: 'POTENTIAL_ROW_EXPLOSION',
					message: `Bidirectional edge traversal with UNION ALL on unknown storage hint may produce duplicates`,
					suggestion: `Set edgeStorageHint: 'directed-only' if edges are guaranteed uni-directional, or use dedupe: 'final'`,
				});
			}
		}
	}

	// Step 4: Validate maxDepth
	if (intent.maxDepth < 1) {
		throw new Error(`maxDepth must be >= 1, got ${intent.maxDepth}`);
	}

	if (intent.maxDepth > 100) {
		state.warnings.push({
			code: 'DEEP_NESTING',
			message: `maxDepth of ${intent.maxDepth} is unusually high`,
			suggestion: `Consider if you really need traversal depth > 100. Large values may cause performance issues.`,
		});
	}

	const planningTimeMs = performance.now() - startTime;

	const dedupeStrategy = intent.dedupe ?? 'none';

	// PERF (FIND-051): use .slice() instead of spread — avoids iterable-protocol overhead.
	const report: RecursivePlanReport = {
		rootTable: startFrom,
		decisions: Object.freeze(state.decisions.slice()),
		warnings: Object.freeze(state.warnings.slice()),
		ctes: Object.freeze(state.ctes.slice()),
		intent,
		metadata: Object.freeze({
			planningTimeMs,
			relationsAnalyzed: state.relationsAnalyzed,
			isAmbiguous: false,
			isRecursive: true as const,
			traversalKind,
			usesBidirectional,
			dedupeStrategy,
		}),
	};

	return Object.freeze(report) as RecursivePlanReport;
}

/**
 * Generate reasoning for recursive CTE decision.
 */
function generateRecursiveReasoning(intent: RecursiveIntent): string {
	const parts: string[] = [];

	parts.push(
		`Recursive CTE "${intent.cteName}" using ${intent.traversal.kind} traversal`,
	);

	if (intent.traversal.kind === 'adjacency') {
		parts.push(
			`direction=${intent.traversal.direction}, parentId=${intent.traversal.parentId}`,
		);
	} else if (intent.traversal.kind === 'edge-table') {
		parts.push(
			`edgeTable=${intent.traversal.edgeTable}, direction=${intent.traversal.direction}`,
		);
	}

	parts.push(`maxDepth=${intent.maxDepth}`);

	if (intent.dedupe && intent.dedupe !== 'none') {
		parts.push(`dedupe=${intent.dedupe}`);
	}

	return parts.join(', ');
}

/**
 * Generate reasoning for bidirectional edge decision.
 */
function generateBidirectionalReasoning(
	storageHint: 'unknown' | 'directed-only',
	strategy: 'union' | 'union-all',
): string {
	if (storageHint === 'directed-only') {
		return strategy === 'union-all'
			? 'edgeStorageHint=directed-only guarantees no reverse duplicates, UNION ALL is safe'
			: 'UNION used despite directed-only hint (forced or conservative)';
	}
	return strategy === 'union'
		? 'edgeStorageHint=unknown, using UNION to eliminate potential duplicates'
		: 'UNION ALL used despite unknown storage hint (may produce duplicates)';
}

// ============================================================================
// IN → EXISTS Optimization
// ============================================================================

/**
 * Optimize IN (subquery) → EXISTS when the subquery targets a known relation.
 *
 * Pattern detected:
 *   WHERE id IN (SELECT customer_id FROM orders WHERE ...)
 * Rewritten to:
 *   WHERE EXISTS (SELECT 1 FROM orders WHERE orders.customer_id = outer.id AND ...)
 *
 * This is a standard SQL optimization: EXISTS short-circuits on first match,
 * while IN materializes the full set. The rewrite is valid when the subquery
 * selects a FK column that references the outer table's PK.
 */

/**
 * Check whether the FK column resolved by a WHERE EXISTS rewrite is provably
 * non-nullable in the ModelIR.
 *
 * Used to guard NOT(IN-subquery) → NOT EXISTS rewrites: SQL's three-valued logic
 * means `x NOT IN (SELECT y ...)` returns UNKNOWN (not TRUE) when y can be NULL,
 * so it excludes the row.  NOT EXISTS does not have this behavior — it returns
 * TRUE when the subquery is empty.  The rewrite is only semantically equivalent
 * when the FK column is NOT NULL.
 *
 * Returns `false` (conservative) when the relation or column cannot be resolved.
 */
function isSubquerySelectedColumnNonNullable(
	existsIntent: { relation: string },
	sourceTable: string,
	model: ModelIR,
): boolean {
	const rel = model.getRelation(`${sourceTable}.${existsIntent.relation}`);
	if (!rel) return false;

	const fkColumns = toColumnList(rel.foreignKey);
	if (fkColumns.length !== 1) return false;
	// biome-ignore lint/style/noNonNullAssertion: fkColumns.length === 1 guaranteed by the return-false guard above
	const fk = fkColumns[0]!;

	const targetTableIR = model.getTable(rel.target);
	if (!targetTableIR) return false;

	const column = targetTableIR.columns.find((c) => c.name === fk);
	if (!column) return false;

	return !column.nullable;
}

function optimizeInToExists(
	where: WhereIntent,
	sourceTable: string,
	model: ModelIR,
	// negated tracks whether this node is under an odd number of NOT wrappers.
	// It is used ONLY for the NULL-safety guard — it never determines the rewrite
	// form (exists vs notExists).
	//
	// The rewrite form is determined solely by the in-intent's OWN `not` flag:
	//   • inWhere.not === false → rewrite to { kind: 'exists' }
	//   • inWhere.not === true  → rewrite to { kind: 'notExists' }
	//
	// The outer boolean structure (not/and/or wrappers) is PRESERVED by recursion,
	// so the form must mirror only the in-intent's own polarity.  The `negated`
	// parity is XOR'd with `inWhere.not` to compute whether the rewrite would
	// occur in a negated context — used ONLY to block rewrites where the FK is
	// nullable (NULL-unsafe under effective negation).
	//
	// Examples at the 'in' leaf:
	//   • inSubquery(...)  at negated=false  → effectiveNeg=false, form=exists     → exists
	//   • inSubquery(...)  at negated=true   → effectiveNeg=true,  nullable?keep:form=exists  → exists (outer not preserved)
	//   • {not:true}       at negated=false  → effectiveNeg=true,  nullable?keep:form=notExists
	//   • {not:true}       at negated=true   → effectiveNeg=false, form=exists (double-neg, outer not preserved)
	negated = false,
): WhereIntent {
	switch (where.kind) {
		case 'in': {
			const inWhere = where as WhereInIntent;
			if (!inWhere.subquery) return where;

			// Only rewrite when the subquery is SIMPLE: single source table, one
			// selected column (the FK), and NO modifiers that change the result set.
			// Any of the following make the subquery non-simple — keep IN unchanged:
			//   limit / orderBy   — LIMIT n restricts which rows satisfy IN, can't be
			//                       expressed in EXISTS form
			//   offset             — similar row-restriction semantics
			//   groupBy / having   — HAVING count(*)>1 restricts to duplicates etc.;
			//                       EXISTS (SELECT 1 ... GROUP BY x HAVING ...) drops
			//                       the HAVING restriction and matches MORE rows
			//   distinct / distinctOn — deduplicate semantics lost in EXISTS
			//   joins / include    — extra tables in the subquery aren't propagated
			//   batchValuesSource  — unnest() source, not a real table
			//   aggregate select   — SELECT max(price) is not a simple FK projection
			const sq = inWhere.subquery;
			if (
				sq.limit != null ||
				sq.orderBy?.length ||
				sq.offset != null ||
				sq.groupBy?.length ||
				sq.having != null ||
				sq.distinct ||
				sq.distinctOn?.length ||
				sq.joins?.length ||
				sq.include?.length ||
				sq.batchValuesSource != null ||
				sq.existsWrap ||
				sq.lock != null ||
				(sq.select != null && sq.select.type !== 'fields')
			) {
				return where;
			}

			// Extract the single column from the subquery's select
			const subSelect = inWhere.subquery.select;
			if (subSelect?.type !== 'fields') return where;
			const fields = 'fields' in subSelect ? subSelect.fields : undefined;
			if (fields?.length !== 1) return where;
			const subColumn = fields[0];
			if (!subColumn) return where;

			// Look for a relation from sourceTable to subquery's table
			// where the FK column matches the subquery's selected column
			const relationsFrom = model.getRelationsFrom(sourceTable);
			const sourceTableIR = model.getTable(sourceTable);
			const sourcePkColumns = toColumnList(sourceTableIR?.primaryKey);
			if (sourcePkColumns.length > 1) return where;
			const sourcePk = sourcePkColumns[0] ?? 'id';

			let matchedRelation: string | undefined;

			for (const rel of relationsFrom) {
				if (rel.target !== inWhere.subquery.from) continue;
				const fkColumns = toColumnList(rel.foreignKey);
				if (fkColumns.length !== 1) continue;
				// biome-ignore lint/style/noNonNullAssertion: fkColumns.length === 1 guaranteed by the continue guard above
				const fk = fkColumns[0]!;

				// hasMany: outer.pk IN (SELECT fk FROM target WHERE ...)
				// The subquery selects the FK column, outer field is PK
				if (
					rel.type === 'hasMany' &&
					fk === subColumn &&
					inWhere.field === sourcePk
				) {
					matchedRelation = rel.name;
					break;
				}
			}

			if (!matchedRelation) return where;

			// NULL-safety guard: compute effective negation (XOR of outer context parity
			// and the in-intent's own `not` flag) to determine whether this rewrite
			// occurs under effective negation.  Under effective negation with a nullable
			// FK, `x NOT IN (SELECT y ...)` returns UNKNOWN (row excluded) when y is NULL,
			// whereas `NOT EXISTS` always returns TRUE — so the rewrite would BROADEN the
			// filter.  Block the rewrite in that case.
			const effectiveNegated = negated !== Boolean(inWhere.not);
			if (effectiveNegated) {
				const existsIntent = { relation: matchedRelation };
				if (
					!isSubquerySelectedColumnNonNullable(existsIntent, sourceTable, model)
				) {
					// Nullable FK under effective negation — keep original IN (correct SQL semantics)
					return where;
				}
			}

			// Rewrite form is determined SOLELY by the in-intent's own `not` flag,
			// NOT by `effectiveNegated`.  The outer boolean structure (not/and/or
			// wrappers) is preserved by the recursion, so the form must mirror only
			// the in-intent's own polarity:
			//   • inWhere.not === false → { kind: 'exists'    } — outer NOT wraps it if present
			//   • inWhere.not === true  → { kind: 'notExists' } — outer NOT wraps it if present
			const targetKind = inWhere.not ? 'notExists' : 'exists';
			return {
				kind: targetKind,
				relation: matchedRelation,
				...(inWhere.subquery.where && { where: inWhere.subquery.where }),
			} as unknown as WhereIntent;
		}

		case 'and': {
			const andWhere = where as WhereAndIntent;
			const optimized = andWhere.conditions.map((c) =>
				optimizeInToExists(c, sourceTable, model, negated),
			);
			if (optimized.every((c, i) => c === andWhere.conditions[i])) return where;
			return { kind: 'and', conditions: optimized } as WhereAndIntent;
		}

		case 'or': {
			// The adapter now compiles EXISTS inline at its boolean tree position
			// (enrichExistsDecisionsInPlace replaces stubs in-place rather than hoisting
			// to top-level AND).  Recursing here is safe: an exists inside an OR
			// becomes a whereOr stub that is enriched in-place, preserving OR semantics.
			const orWhere = where as WhereOrIntent;
			const optimized = orWhere.conditions.map((c) =>
				optimizeInToExists(c, sourceTable, model, negated),
			);
			if (optimized.every((c, i) => c === orWhere.conditions[i])) return where;
			return { kind: 'or', conditions: optimized } as WhereOrIntent;
		}

		case 'not': {
			const notWhere = where as WhereNotIntent;
			// Flip negation parity for the child (used only for the null-safety guard
			// inside 'case in').  The outer 'not' wrapper is ALWAYS preserved: after
			// the child rewrites its 'in' leaf to 'exists' or 'notExists', the outer
			// not() remains to produce the correct SQL structure:
			//   not(in_not=false) → child becomes exists    → not(exists)    = NOT EXISTS   ✓
			//   not(in_not=true)  → child becomes notExists → not(notExists) = NOT NOT EXISTS = EXISTS  (adapter compiles correctly)
			const optimized = optimizeInToExists(
				notWhere.condition,
				sourceTable,
				model,
				!negated,
			);
			if (optimized === notWhere.condition) return where;
			return { kind: 'not', condition: optimized } as WhereNotIntent;
		}

		default:
			return where;
	}
}

// ============================================================================
// Where Processing
// ============================================================================

function processWhere(
	where: WhereIntent,
	sourceTable: string,
	model: ModelIR,
	state: PlannerState,
	opts: Required<PlanOptions>,
	intentPath: string,
): void {
	switch (where.kind) {
		case 'exists':
		case 'notExists':
			processRelationFilter(
				where.relation,
				sourceTable,
				model,
				state,
				opts,
				`${intentPath}.${where.kind}`,
				where.where,
			);
			break;

		case 'relationFilter':
			processRelationFilter(
				where.relation,
				sourceTable,
				model,
				state,
				opts,
				`${intentPath}.relationFilter`,
				where.where,
				where.mode,
			);
			break;

		case 'and':
			for (let i = 0; i < where.conditions.length; i++) {
				const cond = where.conditions[i];
				if (cond) {
					processWhere(
						cond,
						sourceTable,
						model,
						state,
						opts,
						`${intentPath}.and[${i}]`,
					);
				}
			}
			break;

		case 'or':
			for (let i = 0; i < where.conditions.length; i++) {
				const cond = where.conditions[i];
				if (cond) {
					processWhere(
						cond,
						sourceTable,
						model,
						state,
						opts,
						`${intentPath}.or[${i}]`,
					);
				}
			}
			break;

		case 'not':
			processWhere(
				where.condition,
				sourceTable,
				model,
				state,
				opts,
				`${intentPath}.not`,
			);
			break;

		// Scalar conditions don't need relation analysis
		case 'comparison':
		case 'like':
		case 'in':
		case 'any':
		case 'null':
			// No relation analysis needed
			break;

		case 'expression':
			break; // Custom expression — no relation analysis, pass through

		// Adapter-only kinds: planner records no decisions; the adapter compiles
		// them directly from the intent. Explicit cases here prevent silent
		// fallthrough and keep the switch exhaustive.

		case 'rawExists':
		case 'rawNotExists':
			// The subquery is an arbitrary QueryIntent — no FK-based relation
			// resolution to perform at plan time. The adapter handles compilation.
			break;

		case 'subquery':
			// Scalar subquery comparison — the adapter resolves the inner
			// QueryIntent directly; no planner-level relation analysis needed.
			break;

		case 'range':
			// PostgreSQL range operator — scalar field check, no relation
			// analysis required; adapter emits the range SQL.
			break;

		case 'jsonContains':
		case 'jsonExists':
			// JSON containment / key-existence operators — scalar field checks
			// compiled entirely by the adapter.
			break;

		default: {
			// Exhaustiveness guard: if a new WhereIntent kind is added to the
			// union without a matching case here, TypeScript will flag this as
			// a type error at compile time, preventing silent no-ops.
			const _exhaustive: never = where;
			throw new Error(
				`processWhere: unhandled WhereIntent kind '${(_exhaustive as { kind: string }).kind}'`,
			);
		}
	}
}

function processRelationFilter(
	relationPath: string | readonly string[],
	sourceTable: string,
	model: ModelIR,
	state: PlannerState,
	opts: Required<PlanOptions>,
	intentPath: string,
	nestedWhere?: WhereIntent,
	mode?: 'some' | 'every' | 'none',
): void {
	state.relationsAnalyzed++;

	// Normalize relation path to array (SPEC-002: multi-hop support)
	const relations = Array.isArray(relationPath) ? relationPath : [relationPath];

	// Process each relation in the chain
	let currentSource = sourceTable;
	for (let i = 0; i < relations.length; i++) {
		const relationName = relations[i];
		if (!relationName) continue;

		const isLastInChain = i === relations.length - 1;
		const chainPath = `${intentPath}[${i}]`;

		// Find the relation
		const relation = disambiguateRelation(
			relationName,
			currentSource,
			model,
			state,
			opts,
			chainPath,
		);

		if (!relation) {
			return; // Error already added to warnings or exception thrown
		}

		// Track relation access for CTE extraction
		const relPath = `${currentSource}.${relation.name}`;
		const paths = state.relationAccessCounts.get(relPath) ?? [];
		paths.push(chainPath);
		state.relationAccessCounts.set(relPath, paths);

		// Determine filter strategy (only for last relation in chain)
		if (isLastInChain) {
			const filterStrategy = determineFilterStrategy(
				relation,
				opts,
				mode ?? 'some',
			);

			const decisionId = generateDecisionId(state, 'filter-strategy');
			// Detect self-referential relation (source === target)
			const isSelfRef = relation.source === relation.target;
			// SPEC-002: Include full path in context for multi-hop
			const context: PlanDecision['context'] = {
				sourceTable: currentSource,
				target: relation.target,
				relation: relation.name,
				intentPath: chainPath,
				...(relations.length > 1 && { relationPath: relations.join('.') }),
				...(isSelfRef && { isSelfRef }),
			};
			state.decisions.push({
				id: decisionId,
				type: 'filter-strategy',
				context,
				choice: filterStrategy,
				reasoning: generateFilterReasoning(
					relation,
					filterStrategy,
					mode,
					isSelfRef,
				),
				alternatives: filterStrategy === 'exists' ? ['join'] : ['exists'],
			});

			// Check for potential row explosion warning
			if (filterStrategy === 'join' && relation.cardinality === 'many') {
				state.warnings.push({
					code: 'POTENTIAL_ROW_EXPLOSION',
					message: `Using JOIN on to-many relation "${relation.name}" may cause row multiplication`,
					suggestion: `Consider using EXISTS strategy for relation "${relation.name}"`,
					relatedDecision: decisionId,
				});
			}

			// Process nested where on the final target
			if (nestedWhere) {
				processWhere(
					nestedWhere,
					relation.target,
					model,
					state,
					opts,
					`${intentPath}.where`,
				);
			}
		}

		// Move to next table in chain
		currentSource = relation.target;
	}
}

// ============================================================================
// Include Processing
// ============================================================================

function processInclude(
	include: IncludeIntent,
	sourceTable: string,
	model: ModelIR,
	state: PlannerState,
	opts: Required<PlanOptions>,
	intentPath: string,
	depth: number,
	ancestorIsLeftJoin = false,
	parentIncludePath = '',
	queryIntent?: QueryIntent,
): void {
	state.relationsAnalyzed++;
	const pathSegment = include.via || include.relation;
	const fullPath = parentIncludePath
		? `${parentIncludePath}.${pathSegment}`
		: pathSegment;
	if (
		include.select?.type === 'fields' &&
		!Array.isArray(include.select.fields)
	)
		throw new Error(`Include ${fullPath} select fields must be an array`);
	if (include.limit !== undefined)
		validateLimit(include.limit, `Include ${intentPath}(${fullPath}) limit`);

	// Check depth
	if (depth > opts.maxIncludeDepth) {
		state.warnings.push({
			code: 'DEEP_NESTING',
			message: `Include depth ${depth} exceeds maximum ${opts.maxIncludeDepth}`,
			suggestion: 'Consider flattening the query or increasing maxIncludeDepth',
		});
	}

	// Use via hint if provided, otherwise use relation name
	const relationName = include.via ?? include.relation;

	// Resolve exact names, target-table names, then camelCase aliases through the shared helper.
	const relation = resolveIncludeRelationName(
		model,
		sourceTable,
		relationName,
		() =>
			disambiguateRelation(
				relationName,
				sourceTable,
				model,
				state,
				opts,
				fullPath,
				include.via,
			),
		fullPath,
	);

	if (!relation) {
		return;
	}

	// Check for circular includes
	const includePath = `${sourceTable}.${relation.name}`;
	const isSelfReferentialRelation = relation.source === relation.target;
	if (!isSelfReferentialRelation && state.visitedIncludes.has(includePath)) {
		state.warnings.push({
			code: 'CIRCULAR_INCLUDE',
			message: `Circular include detected: ${includePath}`,
			suggestion: 'Remove circular include to prevent infinite recursion',
		});
		return;
	}
	if (!isSelfReferentialRelation) state.visitedIncludes.add(includePath);

	// Track relation access for CTE extraction
	const relationPath = `${sourceTable}.${relation.name}`;
	const paths = state.relationAccessCounts.get(relationPath) ?? [];
	paths.push(intentPath);
	state.relationAccessCounts.set(relationPath, paths);

	// CLI-012c: Check for recursive include on self-referential relations
	const isRecursiveInclude =
		(!!include.recursive || !!relation.recursive) && isSelfReferentialRelation;

	// Recursive hints have a narrower contract than generic include strategies.
	if (isRecursiveInclude) {
		if (
			relation.includeStrategy !== 'auto' &&
			relation.includeStrategy !== 'cte'
		) {
			throw new UnsupportedStrategyError(
				`Recursive include at ${intentPath}(${fullPath}) requires strategy 'cte', but relation '${relation.name}' declares includeStrategy '${relation.includeStrategy}'. Use 'auto' or 'cte'.`,
			);
		}
	} else {
		validateIncludeStrategy(
			relation.includeStrategy,
			opts.dialectCapabilities,
			false,
		);
	}
	// Validate runtime strategy inputs before recursive/join shortcuts can discard them.
	if (include.strategy !== undefined && include.strategy !== 'flat') {
		validateIncludeStrategy(include.strategy, opts.dialectCapabilities);
	}
	let resolution: IncludeStrategyResolution;
	if (isRecursiveInclude) {
		if (include.join !== undefined) {
			throw new UnsupportedStrategyError(
				`Recursive include at ${intentPath}(${fullPath}) cannot use join: recursive includes compile as a CTE (oorabona/db-semantic-planner#894).`,
			);
		}
		// FIND-013: Guard recursive → cte against dialect capability.
		// Recursive resolution requires explicit capability validation. A dialect
		// that declared supportsRecursiveCTE=false must not silently receive an
		// invalid plan.
		if (!opts.dialectCapabilities?.supportsRecursiveCTE) {
			throw new UnsupportedStrategyError(
				`Recursive include at ${intentPath}(${fullPath}) requires a dialect with supportsRecursiveCTE; current dialect (${opts.dialectCapabilities?.name ?? 'no capabilities'}) does not support it.`,
			);
		}
		resolution = { strategy: 'cte', source: 'recursive' };
	} else {
		resolution =
			include.strategy === 'flat'
				? determineFlatIncludeStrategy(
						relation,
						include,
						opts,
						intentPath,
						fullPath,
					)
				: determineIncludeStrategy(
						relation,
						include,
						opts,
						intentPath,
						fullPath,
					);
	}
	const includeStrategy = resolution.strategy;

	const optionPath = `${intentPath}(${fullPath})`;
	if (includeStrategy === 'cte' || includeStrategy === 'join') {
		for (const option of ['limit', 'orderBy'] as const) {
			if (include[option] !== undefined) {
				throw new InvalidOperationError(
					'include',
					`Include ${optionPath} ${option} is not supported by '${includeStrategy}' strategy.` +
						(includeStrategy === 'join' && option === 'limit'
							? ' Remove the explicit join or use a strategy that limits per parent (json_agg, lateral).'
							: ''),
				);
			}
		}
	}
	if (includeStrategy === 'lateral') {
		if (include.orderBy !== undefined && include.limit === undefined)
			throw new InvalidOperationError(
				'include',
				`Include ${optionPath} orderBy requires limit with 'lateral' strategy`,
			);
	}
	if (
		include.select?.type === 'fields' &&
		include.select.fields.length > 1 &&
		include.select.fields.includes('*')
	)
		throw new Error(
			`Include ${fullPath} select cannot mix '*' with other fields`,
		);
	if (
		includeStrategy === 'json_agg' &&
		include.select !== undefined &&
		include.select.type !== 'fields' &&
		include.select.type !== 'all'
	)
		throw new Error(
			`JSON_AGG include '${fullPath}' does not support select form '${include.select.type}'`,
		);
	if (
		include.select !== undefined &&
		(includeStrategy === 'cte' ||
			(includeStrategy === 'join' && !supportsJoinIncludeSelect(include)))
	)
		throw new InvalidOperationError(
			'include',
			`Include ${optionPath} select is not supported by '${includeStrategy}' strategy.` +
				(includeStrategy === 'join'
					? ` Received select form: ${include.select.type}${include.select.type === 'fields' ? ` ${JSON.stringify(include.select.fields)}` : ''}.`
					: ''),
		);
	if (includeStrategy === 'lateral' && !selectsWholeIncludeRow(include))
		throw new InvalidOperationError(
			'include',
			`Include ${optionPath} select must select all columns with '${includeStrategy}' strategy`,
		);

	if (
		includeStrategy === 'join' &&
		isToManyInclude(relation) &&
		include.strategy !== 'flat'
	)
		throw new InvalidOperationError(
			'include',
			`Include ${optionPath} cannot use 'join' for a to-many relation. Use .join(), NQL | flat, or a json_agg/lateral include.`,
		);
	if (
		includeStrategy === 'join' &&
		include.strategy !== 'flat' &&
		dropsJoinIncludeData(queryIntent)
	)
		throw new InvalidOperationError(
			'include',
			`Include ${optionPath} cannot use 'join' with aggregation, groupBy or DISTINCT because its data would be dropped. Use .join() for relational columns, grouping or ordering.`,
		);
	// Pre-compute join type for include-strategy decision embedding
	// (only relevant when strategy is 'join')
	// When an ancestor used LEFT JOIN (optional relation), cascade LEFT to preserve
	// parent rows — even for relations that would normally be INNER (required).
	// An explicit join: 'inner' override on THIS hop resets the cascade for children.
	const autoJoinType = determineJoinType(relation, opts, !!include.where);
	const cascadedJoinType: 'inner' | 'left' =
		ancestorIsLeftJoin && include.join === undefined ? 'left' : autoJoinType;
	const explicitJoinType: 'inner' | 'left' | undefined =
		includeStrategy === 'join' ? (include.join ?? cascadedJoinType) : undefined;

	const includeDecisionId = generateDecisionId(state, 'include-strategy');
	const parentKey =
		relation.type === 'belongsTo' ? relation.targetKey : relation.sourceKey;
	const targetTable = model.getTable(relation.target);
	let targetOrder = targetTable
		? resolveJsonAggOrderKey(targetTable)
		: undefined;

	if (include.orderBy !== undefined || include.limit !== undefined) {
		const entries = include.orderBy ?? [];
		if (
			!Array.isArray(entries) ||
			Array.from(entries).some(
				(entry) =>
					!entry ||
					typeof entry.field !== 'string' ||
					!entry.field ||
					entry.expression !== undefined ||
					!['asc', 'desc'].includes(entry.direction) ||
					(entry.nulls !== undefined &&
						!['first', 'last'].includes(entry.nulls)),
			)
		)
			throw new Error(
				`Include ${fullPath} orderBy requires fields, asc/desc direction and first/last nulls`,
			);
		for (const entry of entries) {
			if (!targetTable?.columns.some((column) => column.name === entry.field))
				throw new Error(
					`Include ${fullPath} orderBy field "${entry.field}" is not a column of target table "${relation.target}"`,
				);
		}
		const ordered = new Set(entries.map((entry) => entry.field));
		const unique =
			targetTable?.columns.some(
				(column) =>
					column.unique && !column.nullable && ordered.has(column.name),
			) ||
			targetTable?.indexes.some(
				(index) =>
					index.unique &&
					index.valid !== false &&
					index.ready !== false &&
					index.where === undefined &&
					!index.expressions?.length &&
					index.columns.length > 0 &&
					index.columns.every(
						(column) =>
							ordered.has(column) &&
							(index.nullsNotDistinct ||
								targetTable.columns.some(
									(entry) => entry.name === column && !entry.nullable,
								)),
					),
			);
		if (!toColumnList(targetTable?.primaryKey).length && !unique)
			throw new Error(
				`Include ${fullPath} ${include.limit !== undefined ? 'limit' : 'orderBy'} requires a primary key or unique ordering for a total order`,
			);
		if (unique && targetOrder?.fallback)
			targetOrder = { columns: [...ordered], fallback: false };
	}

	state.decisions.push({
		id: includeDecisionId,
		type: 'include-strategy',
		context: {
			sourceTable,
			target: relation.target,
			relation: relation.name,
			relationType: relation.type,
			includeAlias: include.relation,
			intentPath,
			// Foreign key info for json_agg compilation (Phase 3)
			...(relation.foreignKey !== undefined && {
				foreignKey: relation.foreignKey,
			}),
			...(parentKey !== undefined && { parentKey }),
			...(targetOrder &&
				targetOrder.columns.length > 0 && {
					targetOrderKey: targetOrder.columns,
				}),
			...(targetOrder?.fallback && { orderByFallback: true }),
			...(include.orderBy && { includeOrderBy: include.orderBy }),
		},
		choice: includeStrategy,
		// Embed joinType so the adapter's join handler can use it directly
		...(explicitJoinType !== undefined && { joinType: explicitJoinType }),
		reasoning: generateIncludeReasoning(relation, resolution),
		alternatives: isRecursiveInclude
			? []
			: getAlternativeStrategies(
					includeStrategy,
					opts.dialectCapabilities,
					include,
					relation,
					queryIntent,
				),
	});

	// CLI-012c: Warn if recursive is set but relation is not self-referential
	if (include.recursive && !isRecursiveInclude) {
		state.warnings.push({
			code: 'INVALID_RECURSIVE_INCLUDE',
			message: `recursive option on "${relation.name}" ignored: relation is not self-referential (source=${relation.source}, target=${relation.target})`,
			suggestion: `Remove recursive option or use RecursiveIntent for cross-table recursion`,
		});
	}

	// CLI-012/CLI-012c: Create CTE when strategy is 'cte' (recursive or not)
	if (includeStrategy === 'cte') {
		const cteName = `cte_${sourceTable}_${relation.name}`;
		// Check if CTE already exists (avoid duplicates from nested includes)
		const existingCte = state.ctes.find((c) => c.name === cteName);
		if (!existingCte) {
			state.ctes.push({
				name: cteName,
				purpose: isRecursiveInclude
					? `Recursive include for self-referential "${relation.name}"`
					: `CTE for "${relation.name}" include`,
				referencedBy: [intentPath],
				sourceIntent: `${sourceTable}.${relation.name}`,
				recursive: isRecursiveInclude,
			});
		} else {
			// Add intentPath to existing CTE's referencedBy
			(existingCte.referencedBy as string[]).push(intentPath);
		}
	}

	// Emit join-type decision (only if using join strategy)
	if (includeStrategy === 'join' && explicitJoinType !== undefined) {
		const joinDecisionId = generateDecisionId(state, 'join-type');

		state.decisions.push({
			id: joinDecisionId,
			type: 'join-type',
			context: {
				sourceTable,
				target: relation.target,
				relation: relation.name,
				intentPath,
			},
			choice: explicitJoinType,
			reasoning: generateJoinReasoning(
				relation,
				explicitJoinType,
				!!include.where,
			),
			alternatives: explicitJoinType === 'left' ? ['inner'] : ['left'],
		});
	}

	// Process nested where
	if (include.where) {
		processWhere(
			include.where,
			relation.target,
			model,
			state,
			opts,
			`${intentPath}.where`,
		);
	}

	// Process nested includes
	if (include.include) {
		// Propagate LEFT JOIN cascade to children based on THIS hop's actual join type.
		// - If this hop emits LEFT JOIN → children inherit the cascade
		// - If this hop emits INNER JOIN (explicit or auto) → cascade resets
		// When strategy is not 'join' (json_agg, lateral, cte), explicitJoinType is
		// undefined → false → no cascade (non-join strategies don't affect the chain).
		const nextAncestorIsLeftJoin = explicitJoinType === 'left';
		for (let i = 0; i < include.include.length; i++) {
			const nestedInc = include.include[i];
			if (nestedInc) {
				processInclude(
					nestedInc,
					relation.target,
					model,
					state,
					opts,
					`${intentPath}.include[${i}]`,
					depth + 1,
					nextAncestorIsLeftJoin,
					fullPath,
					queryIntent,
				);
			}
		}
	}

	// Remove from visited after processing (allow same relation at different depths)
	if (!isSelfReferentialRelation) state.visitedIncludes.delete(includePath);
}

// ============================================================================
// Relation Resolution
// ============================================================================

function disambiguateRelation(
	relationName: string,
	sourceTable: string,
	model: ModelIR,
	state: PlannerState,
	opts: Required<PlanOptions>,
	intentPath: string,
	viaHint?: string,
): RelationIR | undefined {
	// Try direct lookup first
	const directRelation = model.getRelation(`${sourceTable}.${relationName}`);
	if (directRelation) {
		return directRelation;
	}

	// Check if this might be a target table name (ambiguous case)
	const relationsToTarget = model
		.getRelationsFrom(sourceTable)
		.filter((r) => r.target === relationName);

	if (relationsToTarget.length === 0) {
		// Check for virtual recursive relations (ancestors/descendants)
		// These are auto-inferred from self-referential relations and handled by the compiler
		if (relationName === 'ancestors' || relationName === 'descendants') {
			const selfReferentialRelations = model
				.getRelationsFrom(sourceTable)
				.filter((r) => r.source === r.target);
			if (selfReferentialRelations.length > 0) {
				// Virtual recursive relation - return the underlying self-referential relation
				// The compiler will handle the actual recursive CTE generation
				return selfReferentialRelations[0];
			}
		}

		// No relation found
		state.warnings.push({
			code: 'AMBIGUOUS_RELATION',
			message: `Unknown relation "${relationName}" from table "${sourceTable}"`,
			suggestion: `Check that the relation exists in the schema`,
		});
		return undefined;
	}

	if (relationsToTarget.length === 1) {
		// Unambiguous - only one relation to target
		return relationsToTarget[0];
	}

	// Multiple relations - need disambiguation
	const options = relationsToTarget.map((r) => r.name);

	// Check for via hint
	if (viaHint) {
		const resolved = relationsToTarget.find((r) => r.name === viaHint);
		if (resolved) {
			return resolved;
		}
	}

	// Check disambiguate option
	const disambiguateKey = `${sourceTable}.${relationName}`;
	const disambiguated = opts.disambiguate[disambiguateKey];
	if (disambiguated) {
		const resolved = relationsToTarget.find((r) => r.name === disambiguated);
		if (resolved) {
			return resolved;
		}
	}

	// Ambiguous - throw error
	throw new AmbiguousPlanError(sourceTable, relationName, options, intentPath);
}

// ============================================================================
// Strategy Determination
// ============================================================================

function determineFilterStrategy(
	relation: RelationIR,
	opts: Required<PlanOptions>,
	_mode: 'some' | 'every' | 'none',
): 'exists' | 'join' {
	// Forced strategy takes precedence
	if (opts.forceFilterStrategy) {
		return opts.forceFilterStrategy;
	}

	// Use relation hint if not auto
	if (relation.filterStrategy !== 'auto') {
		return relation.filterStrategy;
	}

	// Auto-determine based on cardinality and mode
	if (relation.cardinality === 'one') {
		return 'join';
	}

	// For cardinality 'many', EXISTS is generally better
	// (avoids row explosion)
	return 'exists';
}

/**
 * Resolved include strategy - the actual strategy to use (never 'auto').
 * This is what the compiler receives after planner decision.
 */

/**
 * Determine the include strategy for a relation.
 *
 * Strategy selection logic (CORE-006):
 * 1. Explicit include.join (refuse conflicting concrete relation hints)
 * 2. Concrete relation hint, then applicable planner default
 * 3. Shape selection based on:
 *    - Query shape (flat output and per-parent limits)
 *    - Dialect capabilities (json_agg, lateral support)
 *    - Recursive relations → cte
 *
 * @throws {UnsupportedStrategyError} if requested strategy not supported by dialect
 */
/** Validate planner-facing inputs, including the unresolved 'auto' choice. */
export function validateIncludeStrategy(
	strategy: string,
	capabilities: DialectCapabilities | undefined,
	validateCapabilities = true,
): ResolvedIncludeStrategy {
	return validateStrategy(strategy, capabilities, validateCapabilities, true);
}

/** Validate adapter-facing decisions: only resolved strategies are accepted. */
export function validateResolvedIncludeStrategy(
	strategy: string,
	capabilities: DialectCapabilities | undefined,
): ResolvedIncludeStrategy {
	return validateStrategy(strategy, capabilities, true, false);
}

function validateStrategy(
	strategy: string,
	capabilities: DialectCapabilities | undefined,
	validateCapabilities: boolean,
	allowAuto: boolean,
): ResolvedIncludeStrategy {
	const checkCapabilities = validateCapabilities && capabilities !== undefined;
	const supported = [
		'join',
		...(!checkCapabilities || capabilities.supportsJsonAgg ? ['json_agg'] : []),
		...(!checkCapabilities || capabilities.supportsLateralJoin
			? ['lateral']
			: []),
		...(!checkCapabilities || capabilities.supportsRecursiveCTE ? ['cte'] : []),
		...(allowAuto ? ['auto'] : []),
	];
	if (!supported.includes(strategy)) {
		if (!validateCapabilities) {
			throw new UnsupportedStrategyError(
				`Unknown strategy '${strategy}'. Valid strategies: ${supported.map((s) => `'${s}'`).join(', ')}.`,
			);
		}
		throw new UnsupportedStrategyError(
			`Strategy '${strategy}' is not supported by ${capabilities?.name ?? 'a dialect without capabilities'}. Supported strategies: ${supported.map((s) => `'${s}'`).join(', ')}.`,
		);
	}
	return strategy === 'auto' ? 'join' : (strategy as ResolvedIncludeStrategy);
}

type IncludeStrategySource =
	| 'explicit join'
	| 'relation hint'
	| 'defaultIncludeStrategy'
	| 'per-parent limit'
	| 'nested output'
	| 'flat output'
	| 'recursive';
interface IncludeStrategyResolution {
	strategy: ResolvedIncludeStrategy;
	source: IncludeStrategySource;
}

/** Shared precedence for non-recursive includes, before branch selection. */
function resolveIncludeAuthority(
	relation: RelationIR,
	include: IncludeIntent,
	opts: Required<PlanOptions>,
	intentPath: string,
	fullPath = include.relation,
): IncludeStrategyResolution | undefined {
	if (include.join !== undefined) {
		if (
			relation.includeStrategy !== 'auto' &&
			relation.includeStrategy !== 'join'
		) {
			throw new UnsupportedStrategyError(
				`Include at ${intentPath}(${fullPath}) cannot use explicit join because relation '${relation.name}' declares includeStrategy '${relation.includeStrategy}'. Use 'auto' or 'join', or remove include.join.`,
			);
		}
		return { strategy: 'join', source: 'explicit join' };
	}
	if (relation.includeStrategy !== 'auto') {
		return { strategy: relation.includeStrategy, source: 'relation hint' };
	}
	const strategy = opts.defaultIncludeStrategy;
	if (
		strategy &&
		strategy !== 'auto' &&
		(include.strategy !== 'flat' ||
			strategy === 'join' ||
			strategy === 'lateral')
	) {
		return { strategy, source: 'defaultIncludeStrategy' };
	}
	return undefined;
}

function determineIncludeStrategy(
	relation: RelationIR,
	include: IncludeIntent,
	opts: Required<PlanOptions>,
	intentPath: string,
	fullPath = include.relation,
): IncludeStrategyResolution {
	const resolution = resolveIncludeAuthority(
		relation,
		include,
		opts,
		intentPath,
		fullPath,
	) ?? {
		strategy: selectNestedOutputStrategy(opts.dialectCapabilities),
		source: 'nested output' as const,
	};
	validateIncludeStrategy(resolution.strategy, opts.dialectCapabilities);
	return resolution;
}

/** Resolve applicable authority inputs before validating flat output and limits. */
function determineFlatIncludeStrategy(
	relation: RelationIR,
	include: IncludeIntent,
	opts: Required<PlanOptions>,
	intentPath: string,
	fullPath = include.relation,
): IncludeStrategyResolution {
	const needsLateral = include.limit != null || hasNestedLimit(include);
	const resolution = resolveIncludeAuthority(
		relation,
		include,
		opts,
		intentPath,
		fullPath,
	) ?? {
		strategy: needsLateral ? ('lateral' as const) : ('join' as const),
		source: needsLateral
			? ('per-parent limit' as const)
			: ('flat output' as const),
	};
	const { strategy: selected, source } = resolution;
	if (selected === 'json_agg' || selected === 'cte') {
		throw new UnsupportedStrategyError(
			`Flat output for relation '${fullPath}' cannot use relation includeStrategy hint '${selected}'. Use 'auto', 'join', or 'lateral'.`,
		);
	}
	if (selected === 'join' && needsLateral) {
		throw new InvalidOperationError(
			'include',
			`Flat output for relation '${fullPath}' cannot use 'join' selected by ${source === 'relation hint' ? 'relation includeStrategy hint' : source} because the include or a nested include has a per-parent limit. Accepted strategies for flat output: 'join', 'lateral'; per-parent limits require 'lateral' with a dialect that supports lateral joins.`,
		);
	}
	if (
		selected === 'lateral' &&
		!opts.dialectCapabilities?.supportsLateralJoin
	) {
		throw new UnsupportedStrategyError(
			`Flat output for relation '${fullPath}' requires a dialect with supportsLateralJoin; current dialect (${opts.dialectCapabilities?.name ?? 'no capabilities'}) does not support it. Accepted strategies for flat output: 'join', 'lateral'.`,
		);
	}
	validateIncludeStrategy(selected, opts.dialectCapabilities);
	return resolution;
}

/**
 * Check if any nested include (recursively) has a limit set.
 * Used to determine if an intermediate ancestor needs LATERAL for cascade.
 */
function hasNestedLimit(include: IncludeIntent): boolean {
	if (!include.include || include.include.length === 0) return false;
	for (const child of include.include) {
		if (child.limit != null) return true;
		if (hasNestedLimit(child)) return true;
	}
	return false;
}

/** Select nested output when no applicable authority overrides it. */
function selectNestedOutputStrategy(
	capabilities: DialectCapabilities | undefined,
): ResolvedIncludeStrategy {
	return capabilities?.supportsJsonAgg ? 'json_agg' : 'join';
}

/**
 * Error thrown when requested include strategy is not supported by dialect.
 */
export class UnsupportedStrategyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'UnsupportedStrategyError';
	}
}

/** Join includes honour omitted select, all, or plain field selections. */
function supportsJoinIncludeSelect(include: IncludeIntent): boolean {
	const select = include.select;
	return (
		select === undefined ||
		select.type === 'all' ||
		(select.type === 'fields' && !select.fields.includes('*'))
	);
}

/** Whether an include requests the entire related row. */
function selectsWholeIncludeRow(include: IncludeIntent): boolean {
	const select = include.select;
	return (
		!select ||
		select.type === 'all' ||
		(select.type === 'fields' &&
			select.fields.length === 1 &&
			select.fields[0] === '*')
	);
}

function isToManyInclude(relation: RelationIR): boolean {
	return relation.type === 'hasMany' || relation.type === 'belongsToMany';
}

function dropsJoinIncludeData(intent: QueryIntent | undefined): boolean {
	return (
		intent?.select?.type === 'aggregate' ||
		intent?.distinct === true ||
		(intent?.groupBy?.length ?? 0) > 0
	);
}

/** Get alternatives that honour the include options and dialect capabilities. */
function getAlternativeStrategies(
	strategy: ResolvedIncludeStrategy,
	capabilities: DialectCapabilities | undefined,
	include: IncludeIntent,
	relation: RelationIR,
	queryIntent: QueryIntent | undefined,
): string[] {
	const allStrategies: ResolvedIncludeStrategy[] =
		include.strategy === 'flat'
			? ['join', 'lateral']
			: ['join', 'cte', 'lateral', 'json_agg'];

	// Filter out current strategy and unsupported ones
	return allStrategies.filter((s) => {
		if (s === strategy) return false;
		if (
			s === 'join' &&
			include.strategy !== 'flat' &&
			(isToManyInclude(relation) || dropsJoinIncludeData(queryIntent))
		)
			return false;
		if (include.join !== undefined && s !== 'join') return false;
		if (include.where && s !== 'join') return false;
		if (
			(include.limit != null || include.orderBy !== undefined) &&
			(s === 'join' || s === 'cte')
		)
			return false;
		if (include.strategy === 'flat' && hasNestedLimit(include) && s === 'join')
			return false;
		if (s === 'cte' && include.include?.length) return false;
		if (s === 'lateral') {
			if (include.orderBy !== undefined && include.limit === undefined)
				return false;
		}
		if (include.select !== undefined) {
			if (s === 'cte') return false;
			if (s === 'join' && !supportsJoinIncludeSelect(include)) return false;
		}
		if (s === 'lateral' && !selectsWholeIncludeRow(include)) return false;
		if (!capabilities) return s === 'join'; // No capabilities = only basic strategies
		if (s === 'lateral' && !capabilities.supportsLateralJoin) return false;
		if (s === 'json_agg' && !capabilities.supportsJsonAgg) return false;
		if (s === 'cte' && !capabilities.supportsRecursiveCTE) return false;
		return true;
	});
}

function determineJoinType(
	relation: RelationIR,
	opts: Required<PlanOptions>,
	hasFilter: boolean,
): 'left' | 'inner' {
	// Forced join type takes precedence
	if (opts.forceJoinType) {
		return opts.forceJoinType;
	}

	// Use relation hint if not auto
	if (relation.joinDefault !== 'auto') {
		return relation.joinDefault;
	}

	// Auto-determine based on optionality and filter presence
	if (relation.optionality === 'required') {
		return 'inner';
	}

	// Optional relation with filter implies existence
	if (hasFilter) {
		return 'inner';
	}

	// Optional without filter -> LEFT to preserve parent rows
	return 'left';
}

// ============================================================================
// Raw SQL Detection (Security Observability)
// ============================================================================

/**
 * Detects raw SQL expressions in the query intent and adds security warnings.
 * This provides observability for potentially unsafe SQL usage.
 */
function detectRawSqlUsage(intent: QueryIntent, state: PlannerState): void {
	// Check SELECT expressions for raw SQL
	if (
		intent.select &&
		'type' in intent.select &&
		intent.select.type === 'expressions'
	) {
		for (const col of intent.select.columns) {
			// Direct ExpressionIntent format - check if it's a raw expression
			if (isRawExpression(col)) {
				state.warnings.push({
					code: 'RAW_SQL_USAGE',
					message: `Raw SQL expression detected: "${col.sql}" (alias: ${col.as})`,
					suggestion:
						'Raw SQL bypasses type safety and SQL injection protection. ' +
						'Ensure the SQL is safe and consider using built-in expression helpers instead.',
				});
			}
		}
	}
}

// ============================================================================
// CTE Extraction
// ============================================================================

function extractCTEs(state: PlannerState, threshold: number): void {
	// PERF (FIND-053): build O(1) lookup structures once before the R-relation loop,
	// replacing O(R×D) linear scans (decisions.find + ctes.some) inside the loop.
	const decisionByTableRelation = new Map<string, PlanDecision>();
	for (const d of state.decisions) {
		if (d.type === 'include-strategy') {
			const k = `${d.context?.sourceTable ?? ''}:${d.context?.relation ?? ''}`;
			// Keep first match (earliest decision wins)
			if (!decisionByTableRelation.has(k)) {
				decisionByTableRelation.set(k, d);
			}
		}
	}
	const cteNameSet = new Set(state.ctes.map((c) => c.name));

	for (const [relationPath, intentPaths] of state.relationAccessCounts) {
		if (intentPaths.length >= threshold) {
			const parts = relationPath.split('.');
			const table = parts[0] ?? 'unknown';
			const relation = parts[1] ?? 'unknown';
			const cteName = `cte_${table}_${relation}`;

			// SPEC-002: Skip CTE extraction if the include strategy is 'json_agg'.
			// json_agg uses a subquery that doesn't benefit from CTEs and would conflict.
			// Other strategies (join, cte, separate) can still use CTE extraction.
			const includeStrategyDecision = decisionByTableRelation.get(
				`${table}:${relation}`,
			);
			if (includeStrategyDecision?.choice === 'json_agg') {
				// json_agg strategy uses its own subquery - CTE extraction not needed
				continue;
			}

			// Skip if CTE already exists (from include processing)
			if (cteNameSet.has(cteName)) {
				continue;
			}

			state.ctes.push({
				name: cteName,
				purpose: `${relation} relation accessed ${intentPaths.length} times`,
				referencedBy: Object.freeze(intentPaths.slice()),
				sourceIntent: relationPath,
			});

			const decisionId = generateDecisionId(state, 'cte-extraction');
			state.decisions.push({
				id: decisionId,
				type: 'cte-extraction',
				context: {
					sourceTable: table,
					relation,
				},
				choice: cteName,
				reasoning: `Extracting ${relationPath} to CTE "${cteName}" because it is accessed ${intentPaths.length} times (threshold: ${threshold})`,
				alternatives: ['inline'],
			});
		}
	}
}

// ============================================================================
// Utilities
// ============================================================================

function generateDecisionId(state: PlannerState, type: DecisionType): string {
	state.decisionCounters[type]++;
	const counter = state.decisionCounters[type].toString().padStart(3, '0');
	return `${type.replace('-', '')}-${counter}`;
}

function generateFilterReasoning(
	relation: RelationIR,
	strategy: 'exists' | 'join',
	mode?: 'some' | 'every' | 'none',
	isSelfRef?: boolean,
): string {
	const modeText = mode ? ` (mode: ${mode})` : '';
	const selfRefText = isSelfRef ? ' [self-referential]' : '';

	if (strategy === 'exists') {
		return (
			`Relation ${relation.source}.${relation.name} has cardinality "${relation.cardinality}"${modeText}${selfRefText} - ` +
			`using EXISTS to avoid row explosion`
		);
	}

	return (
		`Relation ${relation.source}.${relation.name} has cardinality "${relation.cardinality}"${modeText}${selfRefText} - ` +
		`using JOIN for efficient single-row access`
	);
}

function generateIncludeReasoning(
	relation: RelationIR,
	resolution: IncludeStrategyResolution,
): string {
	if (resolution.source === 'recursive') {
		return `Recursive include on self-referential relation "${relation.name}" → forced CTE strategy`;
	}
	const prefix = `Relation ${relation.source}.${relation.name} (${relation.type}, cardinality: ${relation.cardinality})`;
	return `${prefix} - using ${resolution.strategy} selected by ${resolution.source}`;
}

function generateJoinReasoning(
	relation: RelationIR,
	joinType: 'left' | 'inner',
	_hasFilter: boolean,
): string {
	if (joinType === 'inner') {
		if (relation.optionality === 'required') {
			return (
				`Relation ${relation.source}.${relation.name} is required - ` +
				`using INNER JOIN`
			);
		}
		return (
			`Relation ${relation.source}.${relation.name} has filter - ` +
			`using INNER JOIN (filter implies existence)`
		);
	}

	return (
		`Relation ${relation.source}.${relation.name} is optional without filter - ` +
		`using LEFT JOIN to preserve parent rows without matches`
	);
}
