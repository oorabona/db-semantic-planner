/**
 * LATERAL Include Strategy Handler
 *
 * Implements the 'lateral' include strategy using LATERAL subquery.
 * This allows row-by-row evaluation with access to outer query columns.
 *
 * Supports deep nesting via recursive child compilation — each child
 * becomes an additional LEFT JOIN LATERAL that correlates with its parent's alias.
 *
 * Produces: LEFT JOIN LATERAL (SELECT ... WHERE fk = outer.pk) AS alias ON true
 */

import type { JoinExpr, Node, SelectStmt } from '@pgsql/types';
import {
	columnRef,
	fkCorrelation,
	rangeVar,
	starTarget,
} from '../../ast-helpers.js';
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
				val: columnRef(col, alias, undefined, ctx.naming),
			},
		}));
	}

	// Select all columns
	return [starTarget(alias, ctx.naming)];
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
	const whereClause = fkCorrelation(
		targetColumn,
		innerAlias,
		sourceColumn,
		outerAlias,
		ctx.naming,
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
 * Derive source and target columns for a child decision based on its relation type.
 *
 * For belongsTo: the FK is on the parent side (e.g., user_roles.role_id → roles.id)
 *   → sourceColumn = foreignKey (role_id), targetColumn = parentKey (id)
 * For hasMany/hasOne: the FK is on the child side (e.g., roles.id ← role_permissions.role_id)
 *   → sourceColumn = parentKey (id), targetColumn = foreignKey (role_id)
 */
function deriveChildColumns(
	child: Decision,
	parentTable: string,
): { sourceColumn: string; targetColumn: string } {
	if (child.relationType === 'belongsTo') {
		return {
			sourceColumn: child.foreignKey ?? `${child.targetTable}_id`,
			targetColumn: child.parentKey ?? 'id',
		};
	}
	// hasMany or hasOne
	return {
		sourceColumn: child.parentKey ?? 'id',
		targetColumn: child.foreignKey ?? `${parentTable}_id`,
	};
}

/**
 * Recursively compile a decision and its children into a cascade of LATERAL JOINs.
 *
 * Returns an array of JOIN nodes: [self, child1, grandchild1, child2, ...]
 */
function compileLateralCascade(
	decision: Decision,
	outerAlias: string,
	sourceColumn: string,
	targetColumn: string,
	ctx: CompilerContext,
	state: CompilerState,
): { joins: Node[]; lateralAlias: string } {
	const targetTable = decision.targetTable ?? decision.relation;
	const columns = decision.columns;
	const limit = typeof decision.limit === 'number' ? decision.limit : undefined;

	if (!targetTable) {
		throw new Error('LATERAL include requires targetTable');
	}

	// Generate unique aliases
	const existingAliases = state.aliases.size;
	const innerAlias = `${targetTable}_inner_${existingAliases}`;
	const lateralAlias = `${targetTable}_lat_${existingAliases}`;
	state.aliases.set(`lateral_${targetTable}_${existingAliases}`, lateralAlias);

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
	const join = buildLateralJoin(subquery, lateralAlias, ctx);
	const joins: Node[] = [join];

	// Recursively compile children
	if (decision.children && decision.children.length > 0) {
		for (const child of decision.children) {
			const { sourceColumn: childSrc, targetColumn: childTgt } =
				deriveChildColumns(child, targetTable);
			const childResult = compileLateralCascade(
				child,
				lateralAlias,
				childSrc,
				childTgt,
				ctx,
				state,
			);
			joins.push(...childResult.joins);
		}
	}

	return { joins, lateralAlias };
}

/**
 * LATERAL strategy include handler
 *
 * Uses LATERAL subquery to fetch related records row-by-row.
 * Best for: Complex includes with LIMIT, or when you need correlated access.
 *
 * Supports deep nesting: each child relation produces an additional
 * LEFT JOIN LATERAL that correlates with its parent's lateral alias.
 *
 * Advantages:
 * - Can apply LIMIT per parent row
 * - Avoids row explosion
 * - Can apply complex filtering per row
 * - Supports arbitrarily deep relation chains (| flat)
 */
export const lateralIncludeHandler: IncludeHandler = {
	strategy: 'lateral',

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
	): IncludeResult {
		const sourceColumn = decision.sourceColumn ?? 'id';
		const targetColumn = decision.targetColumn ?? `${ctx.rootTable}_id`;
		const outerAlias = ctx.currentAlias ?? ctx.rootTable;

		const { joins } = compileLateralCascade(
			decision,
			outerAlias,
			sourceColumn,
			targetColumn,
			ctx,
			state,
		);

		// First join is the primary, rest are additional (for children)
		const [primary, ...additional] = joins as [Node, ...Node[]];

		return {
			lateral: primary,
			join: primary,
			...(additional.length > 0 && { additionalJoins: additional }),
		};
	},
};
