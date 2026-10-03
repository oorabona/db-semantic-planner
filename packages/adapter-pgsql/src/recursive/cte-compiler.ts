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
import { andExpr, binaryExpr, eqExpr, integerNode } from '../ast-helpers.js';
import type { CompilerContext } from '../handlers/types.js';
import { queryLocal, type SqlIdentifier } from '../sql-identifier.js';
import {
	buildCycleDetection,
	buildPg14CycleClause,
} from './cycle-detection.js';
import { appendPathColumn, buildPathColumn } from './path-tracking.js';

// ============================================================================
// Configuration
// ============================================================================

/**
 * Default maximum recursion depth applied when a caller does not supply an
 * explicit `maxDepth` / `maxRecursiveDepth` (see e.g. pgsql-adapter.ts,
 * compiler.ts, adapter-compiler-mutations.ts).
 */
export const MAX_DEPTH_LIMIT = 100;

/**
 * Configuration for recursive CTE compilation
 */
export interface RecursiveCteConfig {
	/** Unique CTE name (e.g., '__rc_0') */
	cteAlias: SqlIdentifier;
	/** Table to traverse */
	table: SqlIdentifier;
	/** Primary key column */
	pkColumn: SqlIdentifier;
	/** Foreign key column for self-reference (adjacency mode only) */
	fkColumn?: SqlIdentifier;
	/** Standalone scans node rows with anchorWhere; correlated adjacency adds the outer-row key. Edge-table anchors scan node rows with anchorWhere. */
	anchor:
		| { mode: 'standalone' }
		| { mode: 'correlated'; outerAlias: SqlIdentifier };
	/** true = traverse up (ancestors), false = traverse down (descendants) */
	isAncestors: boolean;
	/** Maximum recursion depth (default: {@link MAX_DEPTH_LIMIT}) */
	maxDepth: number;
	/** Column(s) to select from each row */
	selectColumns: SqlIdentifier[];
	/** Logical model addresses retained for result metadata construction. */
	logicalTable?: string;
	logicalSelectColumns?: string[];
	/** Whether to track traversal path */
	trackPath?: boolean;
	/** Whether to use PG14+ CYCLE clause (vs __visited array) */
	usePg14Cycle?: boolean;
	/** Compiler context */
	ctx: CompilerContext;

	// Edge-table mode (optional — when set, uses edge-table traversal)
	/** Edge table name (e.g., "role_edges") */
	edgeTable?: SqlIdentifier;
	/** Source column in edge table (e.g., "parent_role_id") */
	edgeFrom?: SqlIdentifier;
	/** Target column in edge table (e.g., "child_role_id") */
	edgeTo?: SqlIdentifier;
	/** Bidirectional strategy: 'union' (safe, dedup) or 'union-all' (no dedup) */
	bidirectionalStrategy?: 'union' | 'union-all';

	// Anchor filter on the node table for either traversal
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
	if (config.fkColumn === undefined) {
		throw new Error('fkColumn is required for adjacency-list traversal.');
	}

	const {
		cteAlias,
		table,
		pkColumn,
		fkColumn,
		isAncestors,
		maxDepth,
		selectColumns,
		trackPath = false,
		usePg14Cycle = false,
		ctx,
	} = config;

	const dbTable = table;
	const dbPk = pkColumn;
	const dbFk = fkColumn;
	const innerAlias = queryLocal('__n');

	// Ancestor joins read the parent key from the preceding CTE row.
	const traversalColumns = isAncestors
		? Array.from(new Set([...selectColumns, dbFk]))
		: selectColumns;

	// Build anchor target list
	const anchorTargets: Node[] = buildTargetList(traversalColumns, innerAlias, {
		isAnchor: true,
		trackPath,
		pkColumn: dbPk,
		usePg14Cycle,
	});

	// Build anchor WHERE clause
	const structuralAnchorWhere =
		config.anchor.mode === 'correlated'
			? buildAnchorWhere(
					innerAlias,
					config.anchor.outerAlias,
					dbPk,
					dbFk,
					isAncestors,
				)
			: undefined;
	const anchorWhere =
		structuralAnchorWhere && config.anchorWhere
			? andExpr(structuralAnchorWhere, config.anchorWhere)
			: (structuralAnchorWhere ?? config.anchorWhere);

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
		...(anchorWhere !== undefined && { whereClause: anchorWhere }),
	};

	// Build recursive target list
	const recursiveTargets: Node[] = buildTargetList(
		traversalColumns,
		innerAlias,
		{
			isAnchor: false,
			trackPath,
			pkColumn: dbPk,
			cteAlias,
			usePg14Cycle,
		},
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
		fromClause: [recursiveJoin],
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
	columns: SqlIdentifier[],
	alias: SqlIdentifier,
	options: {
		isAnchor: boolean;
		trackPath: boolean;
		pkColumn: SqlIdentifier;
		cteAlias?: SqlIdentifier;
		usePg14Cycle?: boolean;
	},
): Node[] {
	const targets: Node[] = [];

	// Add requested columns
	for (const col of columns) {
		const dbCol = col;
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
	innerAlias: SqlIdentifier,
	outerAlias: SqlIdentifier,
	pkColumn: SqlIdentifier,
	fkColumn: SqlIdentifier,
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
	cteAlias: SqlIdentifier,
	innerAlias: SqlIdentifier,
	pkColumn: SqlIdentifier,
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
	cteAlias: SqlIdentifier,
	innerAlias: SqlIdentifier,
	dbTable: SqlIdentifier,
	pkColumn: SqlIdentifier,
	fkColumn: SqlIdentifier,
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

	const dbTable = table;
	const dbPk = pkColumn;
	const dbEdgeTable = edgeTable;
	const dbEdgeFrom = edgeFrom;
	const dbEdgeTo = edgeTo;
	const innerAlias = queryLocal('__n');
	const edgeAlias = queryLocal('__e');
	const isBidirectional = bidirectionalStrategy !== undefined;
	const bidirCteAlias = '__edges_bidir';

	// ── Anchor SELECT ───────────────────────────────────────────────────────

	const anchorTargets: Node[] = buildTargetList(selectColumns, innerAlias, {
		isAnchor: true,
		trackPath,
		pkColumn: dbPk,
		usePg14Cycle,
	});

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

	const recursiveTargets: Node[] = buildTargetList(selectColumns, innerAlias, {
		isAnchor: false,
		trackPath,
		pkColumn: dbPk,
		cteAlias,
		usePg14Cycle,
	});

	const recursiveWhere = buildRecursiveWhere(
		cteAlias,
		innerAlias,
		dbPk,
		maxDepth,
		usePg14Cycle,
	);

	// FROM cte JOIN edge ON edge.from = cte.pk JOIN node ON node.pk = edge.to
	const edgeJoinSource = isBidirectional
		? queryLocal(bidirCteAlias)
		: dbEdgeTable;
	const edgeJoinFromCol = isBidirectional ? queryLocal('from_id') : dbEdgeFrom;
	const edgeJoinToCol = isBidirectional ? queryLocal('to_id') : dbEdgeTo;

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
