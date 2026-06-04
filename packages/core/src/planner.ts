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
	IncludeStrategy,
	PlanDecision,
	PlanOptions,
	PlanReport,
	PlanWarning,
	RecursivePlanOptions,
	RecursivePlanReport,
	ResolvedIncludeStrategy,
} from '@dbsp/types';
import { InvalidOperationError } from './dx/errors.js';
import {
	getNodeIdAlias,
	type IncludeIntent,
	isRawExpression,
	type QueryIntent,
	type RecursiveIntent,
	type WhereAndIntent,
	type WhereExistsIntent,
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
	PlanWarningCode,
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
	) {
		super(
			`Ambiguous relation from "${sourceTable}" to "${targetTable}". ` +
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

	// Validate root table — skip when the FROM is a BatchValues unnest() source
	// (the alias is not a real table; schema validation would incorrectly fail)
	const rootTable = intent.batchValuesSource
		? null
		: model.getTable(intent.from);
	if (!intent.batchValuesSource && !rootTable) {
		throw new Error(`Unknown table: ${intent.from}`);
	}

	// Optimize IN-subquery → EXISTS when relation is known in schema
	const optimizedWhere = intent.where
		? optimizeInToExists(intent.where, intent.from, model)
		: undefined;

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
				);
			}
		}
	}

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
		intent,
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
	const startTable = model.getTable(intent.start.from);
	if (!startTable) {
		throw new Error(`Unknown table: ${intent.start.from}`);
	}

	// Step 2: Generate recursive-cte decision
	const traversalKind = intent.traversal.kind;

	const recursiveCteDecision: PlanDecision = {
		id: generateDecisionId(state, 'recursive-cte'),
		type: 'recursive-cte',
		context: {
			sourceTable: intent.start.from,
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
					sourceTable: intent.start.from,
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
		rootTable: intent.start.from,
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

	const fk =
		typeof rel.foreignKey === 'string' ? rel.foreignKey : rel.foreignKey?.[0];
	if (!fk) return false;

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
): WhereIntent {
	switch (where.kind) {
		case 'in': {
			const inWhere = where as WhereInIntent;
			if (!inWhere.subquery) return where;

			// Extract the single column from the subquery's select
			const subSelect = inWhere.subquery.select;
			if (!subSelect || subSelect.type !== 'fields') return where;
			const fields = 'fields' in subSelect ? subSelect.fields : undefined;
			if (!fields || fields.length !== 1) return where;
			const subColumn = fields[0];
			if (!subColumn) return where;

			// Look for a relation from sourceTable to subquery's table
			// where the FK column matches the subquery's selected column
			const relationsFrom = model.getRelationsFrom(sourceTable);
			const sourceTableIR = model.getTable(sourceTable);
			// For composite PKs, only the first column is checked — multi-column
			// IN-subquery optimization is not supported (falls through as-is).
			const sourcePk =
				typeof sourceTableIR?.primaryKey === 'string'
					? sourceTableIR.primaryKey
					: (sourceTableIR?.primaryKey?.[0] ?? 'id');

			let matchedRelation: string | undefined;

			for (const rel of relationsFrom) {
				if (rel.target !== inWhere.subquery.from) continue;
				const fk =
					typeof rel.foreignKey === 'string'
						? rel.foreignKey
						: rel.foreignKey?.[0];

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

			// Rewrite to EXISTS (NOT IN is handled by the 'not' case below)
			const existsWhere: WhereExistsIntent = {
				kind: 'exists',
				relation: matchedRelation,
				// Forward the subquery's inner WHERE conditions
				...(inWhere.subquery.where && { where: inWhere.subquery.where }),
			} as WhereExistsIntent;

			return existsWhere;
		}

		case 'and': {
			const andWhere = where as WhereAndIntent;
			const optimized = andWhere.conditions.map((c) =>
				optimizeInToExists(c, sourceTable, model),
			);
			if (optimized.every((c, i) => c === andWhere.conditions[i])) return where;
			return { kind: 'and', conditions: optimized } as WhereAndIntent;
		}

		case 'or': {
			const orWhere = where as WhereOrIntent;
			const optimized = orWhere.conditions.map((c) =>
				optimizeInToExists(c, sourceTable, model),
			);
			if (optimized.every((c, i) => c === orWhere.conditions[i])) return where;
			return { kind: 'or', conditions: optimized } as WhereOrIntent;
		}

		case 'not': {
			const notWhere = where as WhereNotIntent;
			const optimized = optimizeInToExists(
				notWhere.condition,
				sourceTable,
				model,
			);
			if (optimized === notWhere.condition) return where;
			// NOT(EXISTS) → notExists (direct, no wrapper)
			// Guard: only convert when the FK column is provably non-nullable.
			// SQL's three-valued logic means NOT IN returns UNKNOWN (excludes row)
			// when the subquery can produce NULLs, whereas NOT EXISTS always
			// returns TRUE for an empty subquery.  The rewrite is only valid when
			// the selected column is NOT NULL.
			if (optimized.kind === 'exists') {
				if (
					!isSubquerySelectedColumnNonNullable(
						optimized as { relation: string },
						sourceTable,
						model,
					)
				) {
					// Column is nullable or unknown — preserve NOT(IN) semantics
					return where;
				}
				return {
					...optimized,
					kind: 'notExists',
				} as unknown as WhereIntent;
			}
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
): void {
	state.relationsAnalyzed++;

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

	// Resolve the relation
	const relation = disambiguateRelation(
		relationName,
		sourceTable,
		model,
		state,
		opts,
		intentPath,
		include.via,
	);

	if (!relation) {
		return;
	}

	// Check for circular includes
	const includePath = `${sourceTable}.${relation.name}`;
	if (state.visitedIncludes.has(includePath)) {
		state.warnings.push({
			code: 'CIRCULAR_INCLUDE',
			message: `Circular include detected: ${includePath}`,
			suggestion: 'Remove circular include to prevent infinite recursion',
		});
		return;
	}
	state.visitedIncludes.add(includePath);

	// Track relation access for CTE extraction
	const relationPath = `${sourceTable}.${relation.name}`;
	const paths = state.relationAccessCounts.get(relationPath) ?? [];
	paths.push(intentPath);
	state.relationAccessCounts.set(relationPath, paths);

	// CLI-012c: Check for recursive include on self-referential relations
	const isRecursiveInclude =
		(!!include.recursive || !!relation.recursive) &&
		relation.source === relation.target;

	// Determine include strategy
	// Priority: 1) recursive → cte (if dialect supports it), 2) include.join → forces join strategy, 3) include.strategy override, 4) auto-detect
	let includeStrategy: ResolvedIncludeStrategy;
	if (isRecursiveInclude) {
		// FIND-013: Guard recursive → cte against dialect capability.
		// selectSmartStrategy handles the general case, but processInclude has
		// an early-exit path that forces 'cte' before reaching it.  A dialect
		// that declared supportsRecursiveCTE=false must not silently receive an
		// invalid plan.
		if (opts.dialectCapabilities?.supportsRecursiveCTE === false) {
			throw new UnsupportedStrategyError(
				`Recursive includes require a dialect with supportsRecursiveCTE; ` +
					`current dialect (${opts.dialectCapabilities.name}) declared it unsupported.`,
			);
		}
		includeStrategy = 'cte';
	} else if (include.join !== undefined) {
		// Explicit join type forces the 'join' strategy (inner or left JOIN)
		if (include.limit != null) {
			throw new InvalidOperationError(
				'include',
				`include.limit cannot be applied with the 'join' strategy because join ` +
					`cannot enforce per-parent-row limits. ` +
					`Use strategy: 'flat' (→ LATERAL) or strategy: 'cte' explicitly.`,
			);
		}
		includeStrategy = 'join';
	} else if (include.strategy === 'flat') {
		// NQL v2.1: flat = exclude nested output (json_agg), planner picks best flat strategy
		// lateral only when per-row LIMIT is needed; otherwise join is simpler
		// Also use lateral when any nested child has a limit (LATERAL cascade required)
		const needsLateral = include.limit != null || hasNestedLimit(include);
		includeStrategy = selectSmartStrategy(
			relation,
			opts.dialectCapabilities,
			false,
			/* excludeNested */ true,
			/* hasLimit */ needsLateral,
		);
	} else {
		includeStrategy = determineIncludeStrategy(relation, opts);
		// FIND-014: include.limit cannot be enforced by the join strategy (which
		// performs a flat JOIN without per-parent-row limiting).  Silently
		// dropping the limit produces unlimited children — incorrect behaviour.
		// Callers must explicitly request 'flat' (→ lateral) or 'cte' to get
		// per-parent limiting.
		if (include.limit != null && includeStrategy === 'join') {
			throw new InvalidOperationError(
				'include',
				`include.limit cannot be applied with the 'join' strategy because join ` +
					`cannot enforce per-parent-row limits. ` +
					`Use strategy: 'flat' (→ LATERAL) or strategy: 'cte' explicitly.`,
			);
		}
	}

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
		},
		choice: includeStrategy,
		// Embed joinType so the adapter's join handler can use it directly
		...(explicitJoinType !== undefined && { joinType: explicitJoinType }),
		reasoning: isRecursiveInclude
			? `Recursive include on self-referential relation "${relation.name}" → forced CTE strategy`
			: generateIncludeReasoning(relation, includeStrategy),
		alternatives: getAlternativeStrategies(
			includeStrategy,
			opts.dialectCapabilities,
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
				);
			}
		}
	}

	// Remove from visited after processing (allow same relation at different depths)
	state.visitedIncludes.delete(includePath);
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
	_intentPath: string,
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
	throw new AmbiguousPlanError(sourceTable, relationName, options);
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
 * 1. If relation has explicit strategy (not 'auto'), use it (after validation)
 * 2. If planner option has explicit strategy (not 'auto'), use it
 * 3. Smart auto selection based on:
 *    - Relation type (hasOne/belongsTo → join, hasMany/belongsToMany → depends)
 *    - Dialect capabilities (lateral, json_agg support)
 *    - Recursive relations → cte
 *
 * @throws {UnsupportedStrategyError} if requested strategy not supported by dialect
 */
function determineIncludeStrategy(
	relation: RelationIR,
	opts: Required<PlanOptions>,
	isRecursive = false,
): ResolvedIncludeStrategy {
	const capabilities = opts.dialectCapabilities;

	// Helper to validate strategy against dialect capabilities
	const validateStrategy = (
		strategy: IncludeStrategy,
	): ResolvedIncludeStrategy => {
		if (strategy === 'auto') {
			// Should not happen, but fallback to join
			return 'join';
		}

		// Validate against dialect capabilities if available
		if (capabilities) {
			if (strategy === 'lateral' && !capabilities.supportsLateralJoin) {
				throw new UnsupportedStrategyError(
					`Strategy 'lateral' is not supported by ${capabilities.name}. ` +
						`Use 'join', 'subquery', or 'json_agg' instead.`,
				);
			}
			if (strategy === 'json_agg' && !capabilities.supportsJsonAgg) {
				throw new UnsupportedStrategyError(
					`Strategy 'json_agg' is not supported by ${capabilities.name}. ` +
						`Use 'join', 'subquery', or 'lateral' instead.`,
				);
			}
			if (strategy === 'cte' && !capabilities.supportsRecursiveCTE) {
				throw new UnsupportedStrategyError(
					`Strategy 'cte' is not supported by ${capabilities.name}. ` +
						`Use 'join' or 'subquery' instead.`,
				);
			}
		}

		return strategy;
	};

	// 1. Use relation hint if not auto (explicit override)
	if (relation.includeStrategy !== 'auto') {
		return validateStrategy(relation.includeStrategy);
	}

	// 2. Use planner option if specified (CLI-010: runtime override)
	if (opts.defaultIncludeStrategy && opts.defaultIncludeStrategy !== 'auto') {
		return validateStrategy(opts.defaultIncludeStrategy);
	}

	// 3. Smart auto selection based on relation type + dialect
	return selectSmartStrategy(relation, capabilities, isRecursive);
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

/**
 * Smart strategy selection based on relation characteristics and dialect.
 *
 * Selection algorithm:
 * - Recursive relations → 'cte' (if supported) or 'subquery'
 * - hasOne/belongsTo (to-one) → 'join' (always safe, single row)
 * - hasMany/belongsToMany (to-many):
 *   - If dialect supports json_agg → 'json_agg' (single row per parent, no explosion)
 *   - Else if dialect supports lateral → 'lateral' (good with LIMIT)
 *   - Else → 'join' (let DB optimize, user can override to 'subquery' if needed)
 */
function selectSmartStrategy(
	_relation: RelationIR,
	capabilities: DialectCapabilities | undefined,
	isRecursive: boolean,
	excludeNested = false,
	hasLimit = false,
): ResolvedIncludeStrategy {
	// Recursive relations should use CTE
	if (isRecursive) {
		if (capabilities?.supportsRecursiveCTE !== false) {
			return 'cte';
		}
		// Fallback for dialects without CTE support (rare)
		return 'subquery';
	}

	// Default strategy for ALL relation types: json_agg
	// Rationale:
	// - json_agg: aggregates children into single JSON array, no row explosion
	// - Works for both to-one (hasOne, belongsTo) and to-many (hasMany)
	// - User can force JOIN via | flat modifier if data is too large for JSON
	// - lateral: only when per-row LIMIT is needed (top N children pattern)
	// - join: simple flat strategy, well-optimized by the database

	if (capabilities?.supportsJsonAgg && !excludeNested) {
		return 'json_agg';
	}

	// LATERAL only when per-row LIMIT is needed — otherwise join is simpler and faster
	if (hasLimit && capabilities?.supportsLateralJoin) {
		return 'lateral';
	}

	// Fallback: use join (database optimizer handles it)
	// User can explicitly request 'subquery' if row explosion is a concern
	return 'join';
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

/**
 * Get alternative strategies for a given strategy based on dialect capabilities.
 */
function getAlternativeStrategies(
	strategy: ResolvedIncludeStrategy,
	capabilities: DialectCapabilities | undefined,
): string[] {
	const allStrategies: ResolvedIncludeStrategy[] = [
		'join',
		'subquery',
		'cte',
		'lateral',
		'json_agg',
	];

	// Filter out current strategy and unsupported ones
	return allStrategies.filter((s) => {
		if (s === strategy) return false;
		if (!capabilities) return s === 'join' || s === 'subquery'; // No capabilities = only basic strategies
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
	strategy: ResolvedIncludeStrategy,
): string {
	const prefix = `Relation ${relation.source}.${relation.name} (${relation.type}, cardinality: ${relation.cardinality})`;

	switch (strategy) {
		case 'join':
			return `${prefix} - using JOIN for efficient single-query fetch`;
		case 'subquery':
			return `${prefix} - using subquery query to avoid row multiplication`;
		case 'cte':
			return `${prefix} - using CTE for recursive/hierarchical traversal`;
		case 'lateral':
			return `${prefix} - using LATERAL JOIN for per-row correlated subquery (LIMIT per parent)`;
		case 'json_agg':
			return `${prefix} - using JSON aggregation to avoid row explosion`;
	}
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
