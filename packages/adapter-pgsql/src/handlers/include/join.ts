/**
 * JOIN Include Strategy Handler
 *
 * Implements the 'join' include strategy using LEFT JOIN.
 * This is the simplest strategy: adds a LEFT JOIN to the FROM clause.
 *
 * Produces: LEFT JOIN related_table ON source.fk = related.pk
 */

import type { JoinExpr, Node } from '@pgsql/types';
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
	// Build the join condition: source.fk = target.pk
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
 * Build select targets for included columns
 */
function buildIncludeTargets(
	includeDecisions: readonly Decision[],
	targetAlias: string,
	ctx: CompilerContext,
): Node[] {
	const targets: Node[] = [];

	for (const incl of includeDecisions) {
		const columns = incl.columns;
		if (columns && columns.length > 0) {
			// Select specific columns
			for (const col of columns) {
				const colRef = columnRef(col, targetAlias, undefined, ctx.naming);
				targets.push({
					ResTarget: {
						val: colRef,
						name: ctx.naming.toDatabase(`${incl.relation}_${col}`),
					},
				});
			}
		} else {
			// Select all columns from the relation (relation.*)
			targets.push(starTarget(targetAlias, ctx.naming));
		}
	}

	return targets;
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
		state: CompilerState,
	): IncludeResult {
		const relation = decision.relation;
		const targetTable = decision.targetTable ?? relation;
		const sourceColumn = decision.sourceColumn ?? 'id';
		const targetColumn = decision.targetColumn ?? `${ctx.rootTable}_id`;

		if (!targetTable) {
			throw new Error('JOIN include requires targetTable');
		}

		// Generate unique alias
		const existingAliases = state.aliases.size;
		const targetAlias = `${targetTable}_join_${existingAliases}`;
		state.aliases.set(`join_${targetTable}`, targetAlias);

		const sourceAlias = ctx.currentAlias ?? ctx.rootTable;

		// Build the JOIN
		const join = buildLeftJoin(
			targetTable,
			targetAlias,
			sourceAlias,
			sourceColumn,
			targetColumn,
			ctx,
		);

		// Build targets for nested includes if present
		const includeDecisions = decision.include;
		const targets = includeDecisions
			? buildIncludeTargets(includeDecisions, targetAlias, ctx)
			: undefined;

		return {
			join,
			...(targets && targets.length > 0 && { targets }),
		};
	},
};
