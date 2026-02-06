/**
 * WITH RECURSIVE CTE Compiler
 *
 * Compiles recursive CTEs for hierarchical data traversal.
 * Supports:
 * - Upward traversal (ancestors, parent chain)
 * - Downward traversal (descendants, children tree)
 * - Path tracking
 * - Cycle detection
 * - Depth limiting
 */

import type { CommonTableExpr, Node, SelectStmt } from '@pgsql/types';
import {
	binaryExpr,
	coalesce,
	eqExpr,
	funcCall,
	integerNode,
	stringNode,
	typeCast,
} from '../ast-helpers.js';
import type { CompilerContext } from '../handlers/types.js';
import {
	buildCycleDetection,
	buildPg14CycleClause,
} from './cycle-detection.js';
import { appendPathColumn, buildPathColumn } from './path-tracking.js';

// ============================================================================
// Configuration
// ============================================================================

/**
 * Configuration for recursive CTE compilation
 */
export interface RecursiveCteConfig {
	/** Unique CTE name (e.g., '__rc_0') */
	cteAlias: string;
	/** Table to traverse */
	table: string;
	/** Primary key column */
	pkColumn: string;
	/** Foreign key column for self-reference (adjacency mode only) */
	fkColumn: string;
	/** Outer query alias to correlate with */
	outerAlias: string;
	/** true = traverse up (ancestors), false = traverse down (descendants) */
	isAncestors: boolean;
	/** Maximum recursion depth (default: 100) */
	maxDepth: number;
	/** Column(s) to select from each row */
	selectColumns: string[];
	/** Whether to track traversal path */
	trackPath?: boolean;
	/** Whether to use PG14+ CYCLE clause (vs __visited array) */
	usePg14Cycle?: boolean;
	/** Compiler context */
	ctx: CompilerContext;

	// Edge-table mode (optional — when set, uses edge-table traversal)
	/** Edge table name (e.g., "role_edges") */
	edgeTable?: string;
	/** Source column in edge table (e.g., "parent_role_id") */
	edgeFrom?: string;
	/** Target column in edge table (e.g., "child_role_id") */
	edgeTo?: string;
	/** Bidirectional strategy: 'union' (safe, dedup) or 'union-all' (no dedup) */
	bidirectionalStrategy?: 'union' | 'union-all';

	// Anchor filter (for edge-table mode — WHERE on anchor node)
	/** Anchor WHERE clause node (pre-built AST) */
	anchorWhere?: Node;
}

// ============================================================================
// CTE Builder
// ============================================================================

/**
 * Build a complete WITH RECURSIVE CTE for hierarchical traversal.
 *
 * Structure:
 * ```sql
 * WITH RECURSIVE cteAlias AS (
 *   -- Anchor: entry point(s)
 *   SELECT cols, 1 AS __depth, ARRAY[pk] AS __visited [, ARRAY[pk::text] AS __path]
 *   FROM table t
 *   WHERE t.pk = outer.fk (ancestors) OR t.fk = outer.pk (descendants)
 *
 *   UNION ALL
 *
 *   -- Recursive step
 *   SELECT cols, __depth + 1, __visited || pk [, __path || pk::text]
 *   FROM cteAlias
 *   INNER JOIN table t ON ...
 *   WHERE __depth < maxDepth AND pk <> ALL(__visited)
 * )
 * [CYCLE pk SET is_cycle USING path] -- PG14+ only
 * SELECT ... FROM cteAlias
 * ```
 */
export function buildRecursiveCte(config: RecursiveCteConfig): {
	cte: Node;
	cteSelect: Node;
	/** Additional CTEs needed (e.g., __edges_bidir for bidirectional) */
	extraCtes?: Node[];
} {
	// Delegate to edge-table builder if edge-table mode
	if (config.edgeTable) {
		return buildEdgeTableRecursiveCte(config);
	}

	const {
		cteAlias,
		table,
		pkColumn,
		fkColumn,
		outerAlias,
		isAncestors,
		maxDepth,
		selectColumns,
		trackPath = false,
		usePg14Cycle = false,
		ctx,
	} = config;

	const naming = ctx.naming;
	const dbTable = naming.toDatabase(table);
	const dbPk = naming.toDatabase(pkColumn);
	const dbFk = naming.toDatabase(fkColumn);
	const dbOuter = naming.toDatabase(outerAlias);
	const innerAlias = '__n';

	// Build anchor target list
	const anchorTargets: Node[] = buildTargetList(
		selectColumns,
		innerAlias,
		ctx,
		{ isAnchor: true, trackPath, pkColumn: dbPk, usePg14Cycle },
	);

	// Build anchor WHERE clause
	const anchorWhere = buildAnchorWhere(
		innerAlias,
		dbOuter,
		dbPk,
		dbFk,
		isAncestors,
	);

	// Build anchor SELECT
	const anchorSelect: SelectStmt = {
		targetList: anchorTargets,
		fromClause: [
			{
				RangeVar: {
					relname: dbTable,
					...(ctx.schema && { schemaname: ctx.schema }),
					inh: true,
					relpersistence: 'p',
					alias: { aliasname: innerAlias },
				},
			},
		],
		whereClause: anchorWhere,
	};

	// Build recursive target list
	const recursiveTargets: Node[] = buildTargetList(
		selectColumns,
		innerAlias,
		ctx,
		{ isAnchor: false, trackPath, pkColumn: dbPk, cteAlias, usePg14Cycle },
	);

	// Build recursive WHERE clause (depth limit + cycle detection)
	const recursiveWhere = buildRecursiveWhere(
		cteAlias,
		innerAlias,
		dbPk,
		maxDepth,
		usePg14Cycle,
	);

	// Build recursive JOIN condition
	const recursiveJoin = buildRecursiveJoin(
		cteAlias,
		innerAlias,
		dbTable,
		dbPk,
		dbFk,
		isAncestors,
		ctx,
	);

	// Build recursive SELECT
	const recursiveSelect: SelectStmt = {
		targetList: recursiveTargets,
		fromClause: [
			{
				RangeVar: {
					relname: cteAlias,
					inh: true,
					relpersistence: 'p',
				},
			},
			recursiveJoin,
		],
		whereClause: recursiveWhere,
	};

	// Build UNION ALL
	const unionSelect: Node = {
		SelectStmt: {
			op: 'SETOP_UNION',
			all: true,
			larg: anchorSelect,
			rarg: recursiveSelect,
		},
	};

	// Build CTE
	const cte: CommonTableExpr = {
		ctename: cteAlias,
		ctequery: unionSelect,
		cterecursive: true,
	};

	// Attach PG14 CYCLE clause if enabled
	if (usePg14Cycle) {
		const cycleNode = buildPg14CycleClause(dbPk);
		if (cycleNode && 'CTECycleClause' in cycleNode) {
			cte.cycle_clause = cycleNode.CTECycleClause;
		}
	}

	return {
		cte: { CommonTableExpr: cte },
		cteSelect: unionSelect,
	};
}

// ============================================================================
// Target List Builders
// ============================================================================

/**
 * Build the target list for anchor or recursive SELECT
 */
function buildTargetList(
	columns: string[],
	alias: string,
	ctx: CompilerContext,
	options: {
		isAnchor: boolean;
		trackPath: boolean;
		pkColumn: string;
		cteAlias?: string;
		usePg14Cycle?: boolean;
	},
): Node[] {
	const targets: Node[] = [];

	// Add requested columns
	for (const col of columns) {
		const dbCol = ctx.naming.toDatabase(col);
		targets.push({
			ResTarget: {
				val: {
					ColumnRef: {
						fields: [{ String: { sval: alias } }, { String: { sval: dbCol } }],
					},
				},
				name: dbCol,
			},
		});
	}

	// Add __depth
	if (options.isAnchor) {
		targets.push({
			ResTarget: {
				val: integerNode(1),
				name: '__depth',
			},
		});
	} else if (options.cteAlias) {
		targets.push({
			ResTarget: {
				val: binaryExpr(
					'+',
					{
						ColumnRef: {
							fields: [
								{ String: { sval: options.cteAlias } },
								{ String: { sval: '__depth' } },
							],
						},
					},
					integerNode(1),
				),
				name: '__depth',
			},
		});
	}

	// Add __visited for cycle detection (skipped when using PG14 CYCLE clause)
	if (!options.usePg14Cycle) {
		targets.push(
			buildCycleDetection(
				alias,
				options.pkColumn,
				options.isAnchor,
				options.cteAlias,
			),
		);
	}

	// Add __path if tracking
	if (options.trackPath) {
		if (options.isAnchor) {
			targets.push(buildPathColumn(alias, options.pkColumn));
		} else if (options.cteAlias) {
			targets.push(appendPathColumn(options.cteAlias, alias, options.pkColumn));
		}
	}

	return targets;
}

// ============================================================================
// WHERE Clause Builders
// ============================================================================

/**
 * Build anchor WHERE clause
 */
function buildAnchorWhere(
	innerAlias: string,
	outerAlias: string,
	pkColumn: string,
	fkColumn: string,
	isAncestors: boolean,
): Node {
	if (isAncestors) {
		// Ancestors: inner.pk = outer.fk (start from parent)
		return eqExpr(
			{
				ColumnRef: {
					fields: [
						{ String: { sval: innerAlias } },
						{ String: { sval: pkColumn } },
					],
				},
			},
			{
				ColumnRef: {
					fields: [
						{ String: { sval: outerAlias } },
						{ String: { sval: fkColumn } },
					],
				},
			},
		);
	} else {
		// Descendants: inner.fk = outer.pk (start from children)
		return eqExpr(
			{
				ColumnRef: {
					fields: [
						{ String: { sval: innerAlias } },
						{ String: { sval: fkColumn } },
					],
				},
			},
			{
				ColumnRef: {
					fields: [
						{ String: { sval: outerAlias } },
						{ String: { sval: pkColumn } },
					],
				},
			},
		);
	}
}

/**
 * Build recursive WHERE clause with depth limit and cycle check
 */
function buildRecursiveWhere(
	cteAlias: string,
	innerAlias: string,
	pkColumn: string,
	maxDepth: number,
	usePg14Cycle: boolean,
): Node {
	const conditions: Node[] = [
		// __depth < maxDepth
		binaryExpr(
			'<',
			{
				ColumnRef: {
					fields: [
						{ String: { sval: cteAlias } },
						{ String: { sval: '__depth' } },
					],
				},
			},
			integerNode(maxDepth),
		),
	];

	// Add cycle check unless using PG14 CYCLE clause
	if (!usePg14Cycle) {
		conditions.push({
			A_Expr: {
				kind: 'AEXPR_OP_ALL',
				name: [{ String: { sval: '<>' } }],
				lexpr: {
					ColumnRef: {
						fields: [
							{ String: { sval: innerAlias } },
							{ String: { sval: pkColumn } },
						],
					},
				},
				rexpr: {
					ColumnRef: {
						fields: [
							{ String: { sval: cteAlias } },
							{ String: { sval: '__visited' } },
						],
					},
				},
			},
		});
	}

	return {
		BoolExpr: {
			boolop: 'AND_EXPR',
			args: conditions,
		},
	};
}

// ============================================================================
// JOIN Builder
// ============================================================================

/**
 * Build the JOIN for recursive step
 */
function buildRecursiveJoin(
	cteAlias: string,
	innerAlias: string,
	dbTable: string,
	pkColumn: string,
	fkColumn: string,
	isAncestors: boolean,
	ctx: CompilerContext,
): Node {
	const joinCondition = isAncestors
		? // Ancestors: inner.pk = cte.fk (traverse up)
			eqExpr(
				{
					ColumnRef: {
						fields: [
							{ String: { sval: innerAlias } },
							{ String: { sval: pkColumn } },
						],
					},
				},
				{
					ColumnRef: {
						fields: [
							{ String: { sval: cteAlias } },
							{ String: { sval: fkColumn } },
						],
					},
				},
			)
		: // Descendants: inner.fk = cte.pk (traverse down)
			eqExpr(
				{
					ColumnRef: {
						fields: [
							{ String: { sval: innerAlias } },
							{ String: { sval: fkColumn } },
						],
					},
				},
				{
					ColumnRef: {
						fields: [
							{ String: { sval: cteAlias } },
							{ String: { sval: pkColumn } },
						],
					},
				},
			);

	return {
		JoinExpr: {
			jointype: 'JOIN_INNER',
			larg: {
				RangeVar: {
					relname: cteAlias,
					inh: true,
					relpersistence: 'p',
				},
			},
			rarg: {
				RangeVar: {
					relname: dbTable,
					...(ctx.schema && { schemaname: ctx.schema }),
					inh: true,
					relpersistence: 'p',
					alias: { aliasname: innerAlias },
				},
			},
			quals: joinCondition,
		},
	};
}

// ============================================================================
// Edge-Table CTE Builder
// ============================================================================

/**
 * Build a recursive CTE that traverses through an edge (junction) table.
 *
 * Edge-table (direction: out):
 * ```sql
 * WITH RECURSIVE cte AS (
 *   SELECT n.cols, 1 AS __depth, ARRAY[n.id] AS __visited
 *   FROM nodeTable n WHERE <anchor>
 *   UNION ALL
 *   SELECT n.cols, __depth+1, __visited || n.id
 *   FROM cte
 *   INNER JOIN edgeTable e ON e.edgeFrom = cte.id
 *   INNER JOIN nodeTable n ON n.id = e.edgeTo
 *   WHERE __depth < maxDepth AND n.id <> ALL(__visited)
 * )
 * ```
 *
 * Bidirectional (direction: both) prepends a `__edges_bidir` CTE:
 * ```sql
 * WITH RECURSIVE
 *   __edges_bidir AS (
 *     SELECT edgeFrom AS from_id, edgeTo AS to_id FROM edgeTable
 *     UNION [ALL]
 *     SELECT edgeTo AS from_id, edgeFrom AS to_id FROM edgeTable
 *   ),
 *   cte AS (... INNER JOIN __edges_bidir e ON e.from_id = cte.id ...)
 * ```
 */
function buildEdgeTableRecursiveCte(config: RecursiveCteConfig): {
	cte: Node;
	cteSelect: Node;
	extraCtes?: Node[];
} {
	const {
		cteAlias,
		table,
		pkColumn,
		edgeTable,
		edgeFrom,
		edgeTo,
		maxDepth,
		selectColumns,
		trackPath = false,
		usePg14Cycle = false,
		bidirectionalStrategy,
		anchorWhere: externalAnchorWhere,
		ctx,
	} = config;

	if (!edgeTable || !edgeFrom || !edgeTo) {
		throw new Error(
			'edgeTable, edgeFrom, and edgeTo are required for edge-table traversal',
		);
	}

	const naming = ctx.naming;
	const dbTable = naming.toDatabase(table);
	const dbPk = naming.toDatabase(pkColumn);
	const dbEdgeTable = naming.toDatabase(edgeTable);
	const dbEdgeFrom = naming.toDatabase(edgeFrom);
	const dbEdgeTo = naming.toDatabase(edgeTo);
	const innerAlias = '__n';
	const edgeAlias = '__e';
	const isBidirectional = bidirectionalStrategy !== undefined;
	const bidirCteAlias = '__edges_bidir';

	// ── Anchor SELECT ───────────────────────────────────────────────────────

	const anchorTargets: Node[] = buildTargetList(
		selectColumns,
		innerAlias,
		ctx,
		{ isAnchor: true, trackPath, pkColumn: dbPk, usePg14Cycle },
	);

	// Anchor WHERE: use external filter (from intent.start.where compilation)
	// or fall back to a trivial TRUE (should not happen in practice)
	const anchorWhere: Node = externalAnchorWhere ?? {
		A_Const: { boolval: { boolval: true } },
	};

	const anchorSelect: SelectStmt = {
		targetList: anchorTargets,
		fromClause: [
			{
				RangeVar: {
					relname: dbTable,
					...(ctx.schema && { schemaname: ctx.schema }),
					inh: true,
					relpersistence: 'p',
					alias: { aliasname: innerAlias },
				},
			},
		],
		whereClause: anchorWhere,
	};

	// ── Recursive SELECT ────────────────────────────────────────────────────

	const recursiveTargets: Node[] = buildTargetList(
		selectColumns,
		innerAlias,
		ctx,
		{ isAnchor: false, trackPath, pkColumn: dbPk, cteAlias, usePg14Cycle },
	);

	const recursiveWhere = buildRecursiveWhere(
		cteAlias,
		innerAlias,
		dbPk,
		maxDepth,
		usePg14Cycle,
	);

	// FROM cte JOIN edge ON edge.from = cte.pk JOIN node ON node.pk = edge.to
	const edgeJoinSource = isBidirectional ? bidirCteAlias : dbEdgeTable;
	const edgeJoinFromCol = isBidirectional ? 'from_id' : dbEdgeFrom;
	const edgeJoinToCol = isBidirectional ? 'to_id' : dbEdgeTo;

	// Build: cte JOIN edgeTable e ON e.edgeFrom = cte.pk
	const cteToEdgeJoin: Node = {
		JoinExpr: {
			jointype: 'JOIN_INNER',
			larg: {
				RangeVar: {
					relname: cteAlias,
					inh: true,
					relpersistence: 'p',
				},
			},
			rarg: {
				RangeVar: {
					relname: edgeJoinSource,
					...(!isBidirectional && ctx.schema && { schemaname: ctx.schema }),
					inh: true,
					relpersistence: 'p',
					alias: { aliasname: edgeAlias },
				},
			},
			quals: eqExpr(
				{
					ColumnRef: {
						fields: [
							{ String: { sval: edgeAlias } },
							{ String: { sval: edgeJoinFromCol } },
						],
					},
				},
				{
					ColumnRef: {
						fields: [
							{ String: { sval: cteAlias } },
							{ String: { sval: dbPk } },
						],
					},
				},
			),
		},
	};

	// Build: (cte JOIN edge) JOIN nodeTable n ON n.pk = e.edgeTo
	const fullRecursiveJoin: Node = {
		JoinExpr: {
			jointype: 'JOIN_INNER',
			larg: cteToEdgeJoin,
			rarg: {
				RangeVar: {
					relname: dbTable,
					...(ctx.schema && { schemaname: ctx.schema }),
					inh: true,
					relpersistence: 'p',
					alias: { aliasname: innerAlias },
				},
			},
			quals: eqExpr(
				{
					ColumnRef: {
						fields: [
							{ String: { sval: innerAlias } },
							{ String: { sval: dbPk } },
						],
					},
				},
				{
					ColumnRef: {
						fields: [
							{ String: { sval: edgeAlias } },
							{ String: { sval: edgeJoinToCol } },
						],
					},
				},
			),
		},
	};

	const recursiveSelect: SelectStmt = {
		targetList: recursiveTargets,
		fromClause: [fullRecursiveJoin],
		whereClause: recursiveWhere,
	};

	// ── UNION ALL ───────────────────────────────────────────────────────────

	const unionSelect: Node = {
		SelectStmt: {
			op: 'SETOP_UNION',
			all: true,
			larg: anchorSelect,
			rarg: recursiveSelect,
		},
	};

	const cte: CommonTableExpr = {
		ctename: cteAlias,
		ctequery: unionSelect,
		cterecursive: true,
	};

	// Attach PG14 CYCLE clause if enabled
	if (usePg14Cycle) {
		const cycleNode = buildPg14CycleClause(dbPk);
		if (cycleNode && 'CTECycleClause' in cycleNode) {
			cte.cycle_clause = cycleNode.CTECycleClause;
		}
	}

	// ── Bidirectional __edges_bidir CTE ─────────────────────────────────────

	const extraCtes: Node[] = [];

	if (isBidirectional) {
		const useUnionAll = bidirectionalStrategy === 'union-all';

		// SELECT edgeFrom AS from_id, edgeTo AS to_id FROM edgeTable
		const forwardSelect: SelectStmt = {
			targetList: [
				{
					ResTarget: {
						val: {
							ColumnRef: {
								fields: [{ String: { sval: dbEdgeFrom } }],
							},
						},
						name: 'from_id',
					},
				},
				{
					ResTarget: {
						val: {
							ColumnRef: {
								fields: [{ String: { sval: dbEdgeTo } }],
							},
						},
						name: 'to_id',
					},
				},
			],
			fromClause: [
				{
					RangeVar: {
						relname: dbEdgeTable,
						...(ctx.schema && { schemaname: ctx.schema }),
						inh: true,
						relpersistence: 'p',
					},
				},
			],
		};

		// SELECT edgeTo AS from_id, edgeFrom AS to_id FROM edgeTable (reversed)
		const reverseSelect: SelectStmt = {
			targetList: [
				{
					ResTarget: {
						val: {
							ColumnRef: {
								fields: [{ String: { sval: dbEdgeTo } }],
							},
						},
						name: 'from_id',
					},
				},
				{
					ResTarget: {
						val: {
							ColumnRef: {
								fields: [{ String: { sval: dbEdgeFrom } }],
							},
						},
						name: 'to_id',
					},
				},
			],
			fromClause: [
				{
					RangeVar: {
						relname: dbEdgeTable,
						...(ctx.schema && { schemaname: ctx.schema }),
						inh: true,
						relpersistence: 'p',
					},
				},
			],
		};

		const bidirUnion: Node = {
			SelectStmt: {
				op: 'SETOP_UNION',
				all: useUnionAll,
				larg: forwardSelect,
				rarg: reverseSelect,
			},
		};

		const bidirCte: CommonTableExpr = {
			ctename: bidirCteAlias,
			ctequery: bidirUnion,
			cterecursive: false,
		};

		extraCtes.push({ CommonTableExpr: bidirCte });
	}

	const result: { cte: Node; cteSelect: Node; extraCtes?: Node[] } = {
		cte: { CommonTableExpr: cte },
		cteSelect: unionSelect,
	};
	if (extraCtes.length > 0) {
		result.extraCtes = extraCtes;
	}
	return result;
}

// ============================================================================
// Scalar Subquery Builder
// ============================================================================

/**
 * Build a scalar subquery that wraps a recursive CTE.
 *
 * Produces:
 * ```sql
 * (WITH RECURSIVE cteAlias AS (...)
 *  SELECT COALESCE(json_agg(col ORDER BY __depth), '[]'::json)
 *  FROM cteAlias)
 * ```
 */
export function buildRecursiveScalarSubquery(
	config: RecursiveCteConfig,
	aggregateColumn: string,
): Node {
	const { cte } = buildRecursiveCte(config);
	const cteAlias = config.cteAlias;
	const dbCol = config.ctx.naming.toDatabase(aggregateColumn);

	// Build final SELECT with json_agg
	const finalSelect: SelectStmt = {
		targetList: [
			{
				ResTarget: {
					val: coalesce(
						funcCall('json_agg', [
							{
								ColumnRef: {
									fields: [
										{ String: { sval: cteAlias } },
										{ String: { sval: dbCol } },
									],
								},
							},
						]),
						typeCast(stringNode('[]'), 'json'),
					),
				},
			},
		],
		fromClause: [
			{
				RangeVar: {
					relname: cteAlias,
					inh: true,
					relpersistence: 'p',
				},
			},
		],
		withClause: {
			ctes: [cte],
			recursive: true,
		},
	};

	return {
		SubLink: {
			subLinkType: 'EXPR_SUBLINK',
			subselect: { SelectStmt: finalSelect },
		},
	};
}
