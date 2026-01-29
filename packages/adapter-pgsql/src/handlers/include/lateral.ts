/**
 * LATERAL Include Strategy Handler
 *
 * Implements the 'lateral' include strategy using LATERAL subquery.
 * This allows row-by-row evaluation with access to outer query columns.
 *
 * Produces: LEFT JOIN LATERAL (SELECT ... WHERE fk = outer.pk) AS alias ON true
 */

import type { JoinExpr, Node, SelectStmt } from '@pgsql/types';
import { columnRef, eqExpr, rangeVar } from '../../ast-helpers.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	IncludeHandler,
	IncludeResult,
} from '../types.js';

/**
 * Build column targets for the LATERAL subquery
 */
function buildLateralTargets(
	columns: readonly string[] | undefined,
	alias: string,
	ctx: CompilerContext,
): Node[] {
	if (columns && columns.length > 0) {
		return columns.map((col) => ({
			ResTarget: {
				val: columnRef(col, alias, ctx.schema, ctx.naming),
			},
		}));
	}

	// Select all columns
	return [
		{
			ResTarget: {
				val: {
					ColumnRef: {
						fields: [
							{ String: { sval: ctx.naming.toDatabase(alias) } },
							{ A_Star: {} },
						],
					},
				},
			},
		},
	];
}

/**
 * Build a LATERAL subquery
 */
function buildLateralSubquery(
	targetTable: string,
	innerAlias: string,
	outerAlias: string,
	sourceColumn: string,
	targetColumn: string,
	columns: readonly string[] | undefined,
	limit: number | undefined,
	ctx: CompilerContext,
): Node {
	// Build the correlation condition
	// LATERAL can reference outer columns directly
	const whereClause = eqExpr(
		columnRef(targetColumn, innerAlias, ctx.schema, ctx.naming),
		columnRef(sourceColumn, outerAlias, ctx.schema, ctx.naming),
	);

	// Build target list
	const targetList = buildLateralTargets(columns, innerAlias, ctx);

	const stmt: SelectStmt = {
		targetList,
		fromClause: [rangeVar(targetTable, innerAlias, ctx.schema, ctx.naming)],
		whereClause,
		...(limit !== undefined && {
			limitCount: { A_Const: { ival: { ival: limit } } },
		}),
	};

	return { SelectStmt: stmt };
}

/**
 * Build a LEFT JOIN LATERAL expression
 */
function buildLateralJoin(
	subquery: Node,
	lateralAlias: string,
	ctx: CompilerContext,
): Node {
	// Wrap subquery as a RangeSubselect
	const rangeSubselect: Node = {
		RangeSubselect: {
			lateral: true,
			subquery,
			alias: { aliasname: ctx.naming.toDatabase(lateralAlias) },
		},
	};

	// LEFT JOIN LATERAL ... ON true
	const joinExpr: JoinExpr = {
		jointype: 'JOIN_LEFT',
		rarg: rangeSubselect,
		quals: { A_Const: { boolval: { boolval: true } } },
	};

	return { JoinExpr: joinExpr };
}

/**
 * LATERAL strategy include handler
 *
 * Uses LATERAL subquery to fetch related records row-by-row.
 * Best for: Complex includes with LIMIT, or when you need correlated access.
 *
 * Advantages:
 * - Can apply LIMIT per parent row
 * - Avoids row explosion
 * - Can apply complex filtering per row
 */
export const lateralIncludeHandler: IncludeHandler = {
	strategy: 'lateral',

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
	): IncludeResult {
		const relation = decision.relation;
		const targetTable = decision.targetTable ?? relation;
		const sourceColumn = decision.sourceColumn ?? 'id';
		const targetColumn = decision.targetColumn ?? `${ctx.rootTable}_id`;
		const columns = decision.columns;
		const limit =
			typeof decision.limit === 'number' ? decision.limit : undefined;

		if (!targetTable) {
			throw new Error('LATERAL include requires targetTable');
		}

		// Generate unique aliases
		const existingAliases = state.aliases.size;
		const innerAlias = `${targetTable}_inner_${existingAliases}`;
		const lateralAlias = `${targetTable}_lat_${existingAliases}`;
		state.aliases.set(`lateral_${targetTable}`, lateralAlias);

		const outerAlias = ctx.currentAlias ?? ctx.rootTable;

		// Build the LATERAL subquery
		const subquery = buildLateralSubquery(
			targetTable,
			innerAlias,
			outerAlias,
			sourceColumn,
			targetColumn,
			columns,
			limit,
			ctx,
		);

		// Build the JOIN LATERAL
		const lateral = buildLateralJoin(subquery, lateralAlias, ctx);

		return {
			lateral,
			join: lateral, // Also return as join for compatibility
		};
	},
};
