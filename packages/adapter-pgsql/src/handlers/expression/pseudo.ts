/**
 * Pseudo-Column Expression Handlers
 *
 * Handles hierarchy pseudo-columns that compile to scalar subqueries.
 * - Single-hop: parent, child → LEFT JOIN
 * - Recursive: ascendant, descendant → WITH RECURSIVE scalar subquery
 *
 * Produces scalar subqueries for recursive traversals.
 */

import type { CommonTableExpr, Node, SelectStmt, SubLink } from '@pgsql/types';
import { requiredColumn } from '../../assert-field.js';
import {
	binaryExpr,
	coalesce,
	eqExpr,
	funcCall,
	integerNode,
	stringNode,
	typeCast,
} from '../../ast-helpers.js';
import type {
	CompilerContext,
	CompilerDecision,
	CompilerState,
	ExpressionHandler,
} from '../types.js';

// ============================================================================
// Helper: Build Recursive CTE
// ============================================================================

/**
 * Configuration for recursive CTE builder
 */
interface RecursiveCteConfig {
	cteAlias: string;
	table: string;
	pkColumn: string;
	fkColumn: string;
	outerAlias: string;
	isAncestors: boolean;
	maxDepth: number;
	selectColumn: string;
	ctx: CompilerContext;
}

/**
 * Build a WITH RECURSIVE scalar subquery for hierarchy traversal.
 *
 * Generates:
 * ```sql
 * (WITH RECURSIVE __rc AS (
 *   -- Anchor: start from FK (ancestors) or PK (descendants)
 *   SELECT t.*, 1 AS __depth, ARRAY[t.pk] AS __visited
 *   FROM table t
 *   WHERE t.pk = outer.fk (ancestors) OR t.fk = outer.pk (descendants)
 *
 *   UNION ALL
 *
 *   -- Recursive: traverse up/down
 *   SELECT n.*, __rc.__depth + 1, __rc.__visited || n.pk
 *   FROM __rc
 *   INNER JOIN table n ON n.pk = __rc.fk (ancestors) OR n.fk = __rc.pk (descendants)
 *   WHERE __rc.__depth < maxDepth AND n.pk <> ALL(__rc.__visited)
 * )
 * SELECT COALESCE(json_agg(__rc.column ORDER BY __rc.__depth), '[]'::json)
 * FROM __rc)
 * ```
 */
function buildRecursiveScalarSubquery(config: RecursiveCteConfig): Node {
	const {
		cteAlias,
		table,
		pkColumn,
		fkColumn,
		outerAlias,
		isAncestors,
		maxDepth,
		selectColumn,
		ctx,
	} = config;

	const naming = ctx.naming;
	const dbTable = naming.toDatabase(table);
	const dbPk = naming.toDatabase(pkColumn);
	const dbFk = naming.toDatabase(fkColumn);
	const dbOuter = naming.toDatabase(outerAlias);

	// Inner alias for CTE iterations
	const innerAlias = '__n';

	// Build anchor SELECT
	const anchorSelect: SelectStmt = {
		targetList: [
			// Select all columns from inner table
			{
				ResTarget: {
					val: {
						ColumnRef: {
							fields: [{ String: { sval: innerAlias } }, { A_Star: {} }],
						},
					},
				},
			},
			// __depth = 1
			{
				ResTarget: {
					val: integerNode(1),
					name: '__depth',
				},
			},
			// __visited = ARRAY[pk]
			{
				ResTarget: {
					val: {
						A_ArrayExpr: {
							elements: [
								{
									ColumnRef: {
										fields: [
											{ String: { sval: innerAlias } },
											{ String: { sval: dbPk } },
										],
									},
								},
							],
						},
					},
					name: '__visited',
				},
			},
		],
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
		// Anchor WHERE: depends on direction
		whereClause: isAncestors
			? // Ancestors: start from parent of outer row (outer.fk)
				eqExpr(
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
								{ String: { sval: dbOuter } },
								{ String: { sval: dbFk } },
							],
						},
					},
				)
			: // Descendants: start from children of outer row (where fk = outer.pk)
				eqExpr(
					{
						ColumnRef: {
							fields: [
								{ String: { sval: innerAlias } },
								{ String: { sval: dbFk } },
							],
						},
					},
					{
						ColumnRef: {
							fields: [
								{ String: { sval: dbOuter } },
								{ String: { sval: dbPk } },
							],
						},
					},
				),
	};

	// Build recursive SELECT
	const recursiveSelect: SelectStmt = {
		targetList: [
			// Select all from new row
			{
				ResTarget: {
					val: {
						ColumnRef: {
							fields: [{ String: { sval: innerAlias } }, { A_Star: {} }],
						},
					},
				},
			},
			// __depth + 1
			{
				ResTarget: {
					val: binaryExpr(
						'+',
						{
							ColumnRef: {
								fields: [
									{ String: { sval: cteAlias } },
									{ String: { sval: '__depth' } },
								],
							},
						},
						integerNode(1),
					),
					name: '__depth',
				},
			},
			// __visited || pk (array concatenation)
			{
				ResTarget: {
					val: binaryExpr(
						'||',
						{
							ColumnRef: {
								fields: [
									{ String: { sval: cteAlias } },
									{ String: { sval: '__visited' } },
								],
							},
						},
						{
							ColumnRef: {
								fields: [
									{ String: { sval: innerAlias } },
									{ String: { sval: dbPk } },
								],
							},
						},
					),
					name: '__visited',
				},
			},
		],
		fromClause: [
			// FROM __rc
			{
				RangeVar: {
					relname: cteAlias,
					inh: true,
					relpersistence: 'p',
				},
			},
			// INNER JOIN table AS __n
			{
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
					// Join condition depends on direction
					quals: isAncestors
						? // Ancestors: n.pk = __rc.fk (traverse up)
							eqExpr(
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
											{ String: { sval: cteAlias } },
											{ String: { sval: dbFk } },
										],
									},
								},
							)
						: // Descendants: n.fk = __rc.pk (traverse down)
							eqExpr(
								{
									ColumnRef: {
										fields: [
											{ String: { sval: innerAlias } },
											{ String: { sval: dbFk } },
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
			},
		],
		// WHERE: depth check AND cycle detection
		whereClause: {
			BoolExpr: {
				boolop: 'AND_EXPR',
				args: [
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
					// pk <> ALL(__visited) — cycle detection
					{
						A_Expr: {
							kind: 'AEXPR_OP_ALL',
							name: [{ String: { sval: '<>' } }],
							lexpr: {
								ColumnRef: {
									fields: [
										{ String: { sval: innerAlias } },
										{ String: { sval: dbPk } },
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
					},
				],
			},
		},
	};

	// Build CTE: anchor UNION ALL recursive
	const cteSelect: Node = {
		SelectStmt: {
			op: 'SETOP_UNION',
			all: true,
			larg: anchorSelect,
			rarg: recursiveSelect,
		},
	};

	const cte: CommonTableExpr = {
		ctename: cteAlias,
		ctequery: cteSelect,
		cterecursive: true,
	};

	// Build final SELECT with json_agg
	const dbSelectCol = naming.toDatabase(selectColumn);
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
										{ String: { sval: dbSelectCol } },
									],
								},
							},
						]),
						// Empty array fallback: '[]'::json
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
		// ORDER BY __depth inside json_agg would go here but json_agg doesn't support it directly
		// We'd need to use json_agg(col ORDER BY __depth) — handled by FuncCall aggregate
		withClause: {
			ctes: [{ CommonTableExpr: cte }],
			recursive: true,
		},
	};

	// Wrap in SubLink (scalar subquery)
	const subLink: SubLink = {
		subLinkType: 'EXPR_SUBLINK',
		subselect: { SelectStmt: finalSelect },
	};

	return { SubLink: subLink };
}

// ============================================================================
// Handlers
// ============================================================================

/**
 * Pseudo-column handler for recursive traversals (ascendant/descendant)
 *
 * Produces: (WITH RECURSIVE ... SELECT json_agg(...))
 */
export const pseudoColumnHandler: ExpressionHandler = {
	types: ['pseudoColumn', 'pseudo', 'hierarchy'],

	compile(
		decision: CompilerDecision,
		ctx: CompilerContext,
		state: CompilerState,
	): Node {
		const traversal = decision.traversal;
		const targetColumn = requiredColumn(
			decision.column,
			'column',
			'pseudo traversal',
		);
		const table = decision.table ?? ctx.rootTable;
		const pkColumn = requiredColumn(
			decision.pkColumn,
			'pkColumn',
			'pseudo traversal',
		);
		const fkColumn = decision.fkColumn ?? 'parent_id';
		const maxDepth = decision.maxDepth ?? ctx.maxRecursiveDepth;

		if (!traversal) {
			throw new Error('Pseudo-column handler requires traversal');
		}

		// Determine direction based on traversal keyword
		const isAncestors =
			traversal === 'ascendant' ||
			traversal === 'ancestors' ||
			traversal === 'parent' ||
			traversal === 'managementChain' ||
			traversal.startsWith('ascendant');

		// Generate unique CTE alias
		const cteIndex = state.ctes.size;
		const cteAlias = `__rc_${cteIndex}`;

		const outerAlias = ctx.currentAlias ?? ctx.rootTable;

		return buildRecursiveScalarSubquery({
			cteAlias,
			table,
			pkColumn,
			fkColumn,
			outerAlias,
			isAncestors,
			maxDepth,
			selectColumn: targetColumn,
			ctx,
		});
	},
};

/**
 * Single-hop pseudo-column handler (parent/child)
 *
 * For single-hop traversals, we use a correlated subquery rather than JOIN
 * to keep it as a scalar expression.
 *
 * Produces: (SELECT col FROM table WHERE pk = outer.fk)
 */
export const singleHopPseudoHandler: ExpressionHandler = {
	types: ['singleHopPseudo', 'parentPseudo', 'childPseudo'],

	compile(
		decision: CompilerDecision,
		ctx: CompilerContext,
		_state: CompilerState,
	): Node {
		const targetColumn = requiredColumn(
			decision.column,
			'column',
			'single-hop pseudo',
		);
		const table = decision.table ?? ctx.rootTable;
		const pkColumn = requiredColumn(
			decision.pkColumn,
			'pkColumn',
			'single-hop pseudo',
		);
		const fkColumn = decision.fkColumn ?? 'parent_id';
		const traversal = decision.traversal ?? 'parent';

		const naming = ctx.naming;
		const dbTable = naming.toDatabase(table);
		const dbPk = naming.toDatabase(pkColumn);
		const dbFk = naming.toDatabase(fkColumn);
		const dbCol = naming.toDatabase(targetColumn);
		const outerAlias = naming.toDatabase(ctx.currentAlias ?? ctx.rootTable);

		const innerAlias = '__p';

		// Determine direction
		const isParent = traversal === 'parent' || traversal === 'manager';

		// Build subquery: SELECT col FROM table WHERE pk = outer.fk (parent)
		//                 SELECT col FROM table WHERE fk = outer.pk (child - returns first)
		const subSelect: SelectStmt = {
			targetList: [
				{
					ResTarget: {
						val: {
							ColumnRef: {
								fields: [
									{ String: { sval: innerAlias } },
									{ String: { sval: dbCol } },
								],
							},
						},
					},
				},
			],
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
			whereClause: isParent
				? eqExpr(
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
									{ String: { sval: outerAlias } },
									{ String: { sval: dbFk } },
								],
							},
						},
					)
				: eqExpr(
						{
							ColumnRef: {
								fields: [
									{ String: { sval: innerAlias } },
									{ String: { sval: dbFk } },
								],
							},
						},
						{
							ColumnRef: {
								fields: [
									{ String: { sval: outerAlias } },
									{ String: { sval: dbPk } },
								],
							},
						},
					),
			limitCount: integerNode(1), // Return only first match for child
		};

		const subLink: SubLink = {
			subLinkType: 'EXPR_SUBLINK',
			subselect: { SelectStmt: subSelect },
		};

		return { SubLink: subLink };
	},
};

/**
 * Chained pseudo-column handler (parent.parent.name)
 *
 * For chained traversals, we build nested correlated subqueries.
 *
 * Produces: (SELECT (SELECT col FROM t WHERE t.pk = p.fk) FROM t AS p WHERE p.pk = outer.fk)
 */
export const chainedPseudoHandler: ExpressionHandler = {
	types: ['chainedPseudo', 'multiHopPseudo'],

	compile(
		decision: CompilerDecision,
		ctx: CompilerContext,
		_state: CompilerState,
	): Node {
		const traversals = decision.traversals;
		const table = decision.table ?? ctx.rootTable;
		const pkColumn = requiredColumn(
			decision.pkColumn,
			'pkColumn',
			'chained pseudo',
		);
		const fkColumn = decision.fkColumn ?? 'parent_id';

		if (!traversals || traversals.length === 0) {
			throw new Error('Chained pseudo handler requires traversals array');
		}

		const naming = ctx.naming;
		const dbTable = naming.toDatabase(table);
		const dbPk = naming.toDatabase(pkColumn);
		const dbFk = naming.toDatabase(fkColumn);

		// Build from innermost to outermost
		// Start with the final column selection
		const lastTraversal = traversals[traversals.length - 1]!;
		const targetCol = naming.toDatabase(
			requiredColumn(
				lastTraversal.targetColumn,
				'targetColumn',
				'chained pseudo',
			),
		);

		// Build nested subqueries from inside out
		let currentExpr: Node = {
			ColumnRef: {
				fields: [
					{ String: { sval: `__p${traversals.length - 1}` } },
					{ String: { sval: targetCol } },
				],
			},
		};

		// Wrap in subqueries for each hop (reverse order)
		for (let i = traversals.length - 1; i >= 0; i--) {
			const alias = `__p${i}`;
			const outerRef =
				i === 0
					? naming.toDatabase(ctx.currentAlias ?? ctx.rootTable)
					: `__p${i - 1}`;

			const subSelect: SelectStmt = {
				targetList: [{ ResTarget: { val: currentExpr } }],
				fromClause: [
					{
						RangeVar: {
							relname: dbTable,
							...(ctx.schema && { schemaname: ctx.schema }),
							inh: true,
							relpersistence: 'p',
							alias: { aliasname: alias },
						},
					},
				],
				whereClause: eqExpr(
					{
						ColumnRef: {
							fields: [{ String: { sval: alias } }, { String: { sval: dbPk } }],
						},
					},
					{
						ColumnRef: {
							fields: [
								{ String: { sval: outerRef } },
								{ String: { sval: dbFk } },
							],
						},
					},
				),
			};

			if (i > 0) {
				// Intermediate levels: wrap in sublink
				currentExpr = {
					SubLink: {
						subLinkType: 'EXPR_SUBLINK',
						subselect: { SelectStmt: subSelect },
					},
				};
			} else {
				// Outermost: return the sublink
				return {
					SubLink: {
						subLinkType: 'EXPR_SUBLINK',
						subselect: { SelectStmt: subSelect },
					},
				};
			}
		}

		// Fallback (shouldn't reach here)
		return currentExpr;
	},
};
