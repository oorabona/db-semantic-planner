/**
 * JOIN Include Strategy Handler
 *
 * Implements the 'join' include strategy using LEFT JOIN (default) or INNER JOIN.
 * This is the simplest strategy: adds a JOIN to the FROM clause.
 *
 * Produces: LEFT JOIN related_table AS relation ON source.fk = related.pk  (default)
 *       or: INNER JOIN related_table AS relation ON source.fk = related.pk  (join: 'inner')
 * With aliased columns: "relation.column" for hydration
 */

import type { JoinExpr, Node } from '@pgsql/types';
import {
	DEFAULT_PK_COLUMN,
	defaultFkDerivation,
	requiredColumn,
} from '../../assert-field.js';
import {
	columnTarget,
	fkCorrelation,
	rangeVar,
	starTarget,
} from '../../ast-helpers.js';
import type {
	CompilerContext,
	CompilerDecision,
	CompilerState,
	IncludeHandler,
	IncludeResult,
} from '../types.js';

/**
 * Build a JOIN expression (LEFT JOIN by default, INNER JOIN when joinType='inner').
 */
function buildJoin(
	targetTable: string,
	targetAlias: string,
	sourceAlias: string,
	sourceColumn: string,
	targetColumn: string,
	ctx: CompilerContext,
	joinType: 'inner' | 'left' = 'left',
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
		jointype: joinType === 'inner' ? 'JOIN_INNER' : 'JOIN_LEFT',
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
		decision: CompilerDecision,
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
		const sourceColumn = requiredColumn(
			decision.sourceColumn,
			'sourceColumn',
			'JOIN include',
		);
		const targetColumn =
			decision.targetColumn ??
			(ctx.deriveFkColumnName ?? defaultFkDerivation)(
				ctx.rootTable,
				ctx.defaultPkColumnName ?? DEFAULT_PK_COLUMN,
			);

		// Build the JOIN (LEFT or INNER based on decision.joinType)
		const join = buildJoin(
			targetTable,
			targetAlias,
			sourceAlias,
			sourceColumn,
			targetColumn,
			ctx,
			decision.joinType ?? 'left',
		);

		// Build column targets with output aliases for hydration.
		// Prefer user-supplied alias from columnAliases; fall back to
		// the "relation.column" convention used by the hydration layer.
		const targets: Node[] = [];
		const columns = decision.columns;
		const columnAliases = decision.columnAliases;
		if (columns && columns.length > 0) {
			if (columns.length === 1 && columns[0] === '*') {
				// Wildcard: select all columns from the joined relation
				targets.push(starTarget(targetAlias, ctx.naming));
			} else {
				for (const col of columns) {
					const outputAlias = columnAliases?.[col] ?? `${relation}.${col}`;
					targets.push(columnTarget(col, outputAlias, targetAlias, ctx.naming));
				}
			}
		}

		return {
			join,
			...(targets.length > 0 && { targets }),
		};
	},
};
