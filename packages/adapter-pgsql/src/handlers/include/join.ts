/**
 * JOIN Include Strategy Handler
 *
 * Implements the 'join' include strategy using LEFT JOIN.
 * This is the simplest strategy: adds a LEFT JOIN to the FROM clause.
 *
 * Produces: LEFT JOIN related_table AS relation ON source.fk = related.pk
 * With aliased columns: "relation.column" for hydration
 */

import type { JoinExpr, Node } from '@pgsql/types';
import { columnTarget, fkCorrelation, rangeVar } from '../../ast-helpers.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	IncludeHandler,
	IncludeResult,
} from '../types.js';

/**
 * Build a LEFT JOIN expression
 */
function buildLeftJoin(
	targetTable: string,
	targetAlias: string,
	sourceAlias: string,
	sourceColumn: string,
	targetColumn: string,
	ctx: CompilerContext,
): Node {
	// Build the join condition: source.sourceColumn = target.targetColumn
	const joinCondition = fkCorrelation(
		sourceColumn,
		sourceAlias,
		targetColumn,
		targetAlias,
		ctx.naming,
	);

	const joinExpr: JoinExpr = {
		jointype: 'JOIN_LEFT',
		rarg: rangeVar(targetTable, targetAlias, ctx.schema, ctx.naming),
		quals: joinCondition,
	};

	return { JoinExpr: joinExpr };
}

/**
 * JOIN strategy include handler
 *
 * Adds a LEFT JOIN to fetch related records.
 * Best for: hasOne, belongsTo relationships (1:1 or N:1)
 *
 * Note: May cause row explosion for hasMany (1:N) relationships.
 */
export const joinIncludeHandler: IncludeHandler = {
	strategy: 'join',

	compile(
		decision: Decision,
		ctx: CompilerContext,
		_state: CompilerState,
	): IncludeResult {
		const relation = decision.relation;
		const targetTable = decision.targetTable ?? relation;

		if (!targetTable) {
			throw new Error('JOIN include requires targetTable');
		}

		// Use relationName as alias for uniqueness
		// (e.g., "author" and "editor" both from "users")
		const targetAlias = relation ?? targetTable;
		const sourceAlias = ctx.currentAlias ?? ctx.rootTable;
		const sourceColumn = decision.sourceColumn ?? 'id';
		const targetColumn = decision.targetColumn ?? `${ctx.rootTable}_id`;

		// Build the LEFT JOIN
		const join = buildLeftJoin(
			targetTable,
			targetAlias,
			sourceAlias,
			sourceColumn,
			targetColumn,
			ctx,
		);

		// Build column targets with "relation.column" aliases for hydration
		const targets: Node[] = [];
		const columns = decision.columns;
		if (columns && columns.length > 0) {
			for (const col of columns) {
				targets.push(
					columnTarget(col, `${relation}.${col}`, targetAlias, ctx.naming),
				);
			}
		}

		return {
			join,
			...(targets.length > 0 && { targets }),
		};
	},
};
