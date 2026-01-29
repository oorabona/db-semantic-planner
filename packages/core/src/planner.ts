/**
 * @module planner
 * Semantic Planner - Decision engine for query planning.
 * Transforms QueryIntent + ModelIR into PlanReport with strategic decisions.
 */

import type { DialectCapabilities } from './dialects/index.js';
import {
	getNodeIdAlias,
	type IncludeIntent,
	isRawExpression,
	type QueryIntent,
	type RecursiveIntent,
	type WhereIntent,
} from './intent-ast.js';
import type { IncludeStrategy, ModelIR, RelationIR } from './model-ir.js';

// ============================================================================
// Decision Types
// ============================================================================

/**
 * Decision types made by the planner
 */
export type DecisionType =
	| 'filter-strategy'
	| 'join-type'
	| 'include-strategy'
	| 'cte-extraction'
	| 'ambiguity'
	| 'recursive-cte'
	| 'bidirectional-edges';

/**
 * A single planning decision with full reasoning
 */
export interface PlanDecision {
	/** Unique identifier for the decision */
	readonly id: string;

	/** Type of decision */
	readonly type: DecisionType;

	/** Context: what triggered this decision */
	readonly context: {
		/** Source table in the decision */
		readonly sourceTable: string;
		/** Target table or relation name */
		readonly target?: string;
		/** Relation name if applicable */
		readonly relation?: string;
		/** Relation type (belongsTo, hasMany, hasOne, manyToMany) */
		readonly relationType?: string;
		/** Intent path (e.g., "where.exists.posts") */
		readonly intentPath?: string;
		/** Full relation path for multi-hop (SPEC-002), e.g., "author.company" */
		readonly relationPath?: string;
		/** User-provided include alias (e.g., 'author' from .include('author')) */
		readonly includeAlias?: string;
		/** Foreign key column(s) for include-strategy (Phase 3) */
		readonly foreignKey?: string | readonly string[];
	};

	/** The choice made */
	readonly choice: string;

	/** Human-readable reasoning */
	readonly reasoning: string;

	/** Other options that were available */
	readonly alternatives: readonly string[];
}

// ============================================================================
// Warning Types
// ============================================================================

/**
 * Warning codes for planning issues
 */
export type PlanWarningCode =
	| 'AMBIGUOUS_RELATION'
	| 'POTENTIAL_ROW_EXPLOSION'
	| 'CIRCULAR_INCLUDE'
	| 'MISSING_INDEX_HINT'
	| 'DEEP_NESTING'
	| 'INVALID_RECURSIVE_INCLUDE'
	| 'RAW_SQL_USAGE';

/**
 * A warning about the query plan
 */
export interface PlanWarning {
	/** Warning code for programmatic handling */
	readonly code: PlanWarningCode;

	/** Human-readable message */
	readonly message: string;

	/** Suggested action to resolve */
	readonly suggestion?: string;

	/** Related decision ID if applicable */
	readonly relatedDecision?: string;
}

// ============================================================================
// CTE Types
// ============================================================================

/**
 * CTE definition for extracted subqueries
 */
export interface CTEDefinition {
	/** CTE name (used in WITH clause) */
	readonly name: string;

	/** Purpose of this CTE */
	readonly purpose: string;

	/** Which query parts reference this CTE */
	readonly referencedBy: readonly string[];

	/** The intent fragment this CTE represents */
	readonly sourceIntent: string;

	/**
	 * CLI-012c: Whether this CTE should use WITH RECURSIVE.
	 * Set when include.recursive is specified and relation is self-referential.
	 */
	readonly recursive?: boolean;
}

// ============================================================================
// Plan Report
// ============================================================================

/**
 * Complete plan report
 */
export interface PlanReport {
	/** Root table for the query */
	readonly rootTable: string;

	/** All decisions made during planning */
	readonly decisions: readonly PlanDecision[];

	/** Warnings about the plan */
	readonly warnings: readonly PlanWarning[];

	/** CTEs to be extracted */
	readonly ctes: readonly CTEDefinition[];

	/** Original intent (for reference) */
	readonly intent: QueryIntent;

	/** Planning metadata */
	readonly metadata: {
		/** Planning duration in ms */
		readonly planningTimeMs: number;
		/** Number of relations traversed */
		readonly relationsAnalyzed: number;
		/** Whether the plan is ambiguous */
		readonly isAmbiguous: boolean;
		/** Ambiguous relation options (if isAmbiguous) */
		readonly ambiguousOptions?: readonly string[];
	};
}

// ============================================================================
// Plan Options
// ============================================================================

/**
 * Planning options for customization
 */
export interface PlanOptions {
	/**
	 * Force a specific filter strategy (overrides auto-detection)
	 */
	forceFilterStrategy?: 'exists' | 'join';

	/**
	 * Force a specific join type (overrides auto-detection)
	 */
	forceJoinType?: 'left' | 'inner';

	/**
	 * Enable CTE extraction for repeated subqueries
	 * @default true
	 */
	enableCTEs?: boolean;

	/**
	 * Threshold for CTE extraction (min references)
	 * @default 2
	 */
	cteThreshold?: number;

	/**
	 * Maximum include depth before warning
	 * @default 5
	 */
	maxIncludeDepth?: number;

	/**
	 * Disambiguation hints for ambiguous relations
	 * Map of "sourceTable.targetTable" -> relation name
	 */
	disambiguate?: Record<string, string>;

	/**
	 * Default include strategy for relations when set to 'auto'.
	 * - 'join': Use JOIN (single query, database optimizes) - RECOMMENDED for to-one
	 * - 'subquery': Use subquery queries (N+1 style with batching) - safe for to-many
	 * - 'cte': Use CTE-based include (good for recursive/hierarchical)
	 * - 'lateral': Use LATERAL JOIN (PostgreSQL) / CROSS APPLY (MSSQL)
	 * - 'json_agg': Use JSON aggregation (PostgreSQL/MySQL/DuckDB)
	 * - 'auto': Smart selection based on relation type + dialect capabilities
	 * @default 'auto'
	 */
	defaultIncludeStrategy?: IncludeStrategy;

	/**
	 * Dialect capabilities for smart strategy selection.
	 * When provided, 'auto' strategy uses dialect-aware selection.
	 * When absent, 'auto' falls back to 'join'.
	 */
	dialectCapabilities?: DialectCapabilities;
}

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

	// Validate root table
	const rootTable = model.getTable(intent.from);
	if (!rootTable) {
		throw new Error(`Unknown table: ${intent.from}`);
	}

	// Process where clause
	if (intent.where) {
		processWhere(intent.where, intent.from, model, state, opts, 'where');
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

	// Check for overall ambiguity
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
		decisions: Object.freeze([...state.decisions]),
		warnings: Object.freeze([...state.warnings]),
		ctes: Object.freeze([...state.ctes]),
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
export interface RecursivePlanReport
	extends Omit<PlanReport, 'intent' | 'metadata'> {
	readonly intent: RecursiveIntent;
	readonly metadata: PlanReport['metadata'] & {
		readonly isRecursive: true;
		readonly traversalKind: 'adjacency' | 'edge-table' | 'custom';
		readonly usesBidirectional: boolean;
		readonly dedupeStrategy: 'none' | 'final';
	};
}

/**
 * Options specific to recursive CTE planning.
 */
export interface RecursivePlanOptions {
	/** Force bidirectional edge handling strategy */
	readonly forceBidirectionalStrategy?: 'union' | 'union-all';
}

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

	const report: RecursivePlanReport = {
		rootTable: intent.start.from,
		decisions: Object.freeze([...state.decisions]),
		warnings: Object.freeze([...state.warnings]),
		ctes: Object.freeze([...state.ctes]),
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
		case 'null':
			// No relation analysis needed
			break;
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
			// SPEC-002: Include full path in context for multi-hop
			const context: PlanDecision['context'] =
				relations.length > 1
					? {
							sourceTable: currentSource,
							target: relation.target,
							relation: relation.name,
							intentPath: chainPath,
							relationPath: relations.join('.'),
						}
					: {
							sourceTable: currentSource,
							target: relation.target,
							relation: relation.name,
							intentPath: chainPath,
						};
			state.decisions.push({
				id: decisionId,
				type: 'filter-strategy',
				context,
				choice: filterStrategy,
				reasoning: generateFilterReasoning(relation, filterStrategy, mode),
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
	// Priority: 1) recursive → cte, 2) include.strategy override, 3) auto-detect
	let includeStrategy: ResolvedIncludeStrategy;
	if (isRecursiveInclude) {
		includeStrategy = 'cte';
	} else if (include.strategy === 'flat') {
		// NQL v2.1: flat = exclude nested output (json_agg), planner picks best flat strategy
		includeStrategy = selectSmartStrategy(
			relation,
			opts.dialectCapabilities,
			false,
			/* excludeNested */ true,
		);
	} else {
		includeStrategy = determineIncludeStrategy(relation, opts);
	}
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

	// Determine join type (only if using join strategy)
	if (includeStrategy === 'join') {
		const hasFilter = !!include.where;
		const joinType = determineJoinType(relation, opts, hasFilter);
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
			choice: joinType,
			reasoning: generateJoinReasoning(relation, joinType, hasFilter),
			alternatives: joinType === 'left' ? ['inner'] : ['left'],
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
export type ResolvedIncludeStrategy = Exclude<IncludeStrategy, 'auto'>;

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
	// - lateral: allows per-row subquery with LIMIT, good for "top N children"
	// - join: fallback when json_agg not supported

	if (capabilities?.supportsJsonAgg && !excludeNested) {
		return 'json_agg';
	}

	if (capabilities?.supportsLateralJoin) {
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
	for (const [relationPath, intentPaths] of state.relationAccessCounts) {
		if (intentPaths.length >= threshold) {
			const parts = relationPath.split('.');
			const table = parts[0] ?? 'unknown';
			const relation = parts[1] ?? 'unknown';
			const cteName = `cte_${table}_${relation}`;

			// SPEC-002: Skip CTE extraction if the include strategy is 'json_agg'.
			// json_agg uses a subquery that doesn't benefit from CTEs and would conflict.
			// Other strategies (join, cte, separate) can still use CTE extraction.
			const includeStrategyDecision = state.decisions.find(
				(d) =>
					d.type === 'include-strategy' &&
					d.context?.sourceTable === table &&
					d.context?.relation === relation,
			);
			if (includeStrategyDecision?.choice === 'json_agg') {
				// json_agg strategy uses its own subquery - CTE extraction not needed
				continue;
			}

			// Skip if CTE already exists (from include processing)
			if (state.ctes.some((c) => c.name === cteName)) {
				continue;
			}

			state.ctes.push({
				name: cteName,
				purpose: `${relation} relation accessed ${intentPaths.length} times`,
				referencedBy: Object.freeze([...intentPaths]),
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
): string {
	const modeText = mode ? ` (mode: ${mode})` : '';

	if (strategy === 'exists') {
		return (
			`Relation ${relation.source}.${relation.name} has cardinality "${relation.cardinality}"${modeText} - ` +
			`using EXISTS to avoid row explosion`
		);
	}

	return (
		`Relation ${relation.source}.${relation.name} has cardinality "${relation.cardinality}"${modeText} - ` +
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
			return `${prefix} - using LATERAL JOIN for per-row subquery with LIMIT support`;
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
