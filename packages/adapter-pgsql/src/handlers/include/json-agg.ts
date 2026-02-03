/**
 * JSON_AGG Include Strategy Handler
 *
 * Implements the 'json_agg' include strategy using PostgreSQL's json_agg.
 * Uses to_jsonb(__t__) for wildcard row selection, with recursive nesting
 * via jsonb_build_object merge for child relations.
 *
 * Produces: COALESCE((SELECT json_agg(to_jsonb(__t__) [|| jsonb_build_object(...)]) FROM target AS __t__ WHERE ...), '[]'::json) AS relation
 */

import type { Node } from '@pgsql/types';
import {
	andExpr,
	jsonAggCorrelation,
	jsonAggSubquery,
} from '../../ast-helpers.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	IncludeHandler,
	IncludeResult,
} from '../types.js';
import { deriveFkColumns } from './shared.js';

/**
 * Recursively compile a json_agg decision into a ResTarget node.
 * For nested includes, produces nested json_agg with jsonb_build_object merging.
 * Each depth level uses a unique alias (__t0__, __t1__, etc.) to avoid conflicts.
 */
function compileJsonAggRecursive(
	decision: Decision,
	parentAlias: string,
	depth: number,
	ctx: CompilerContext,
	_state: CompilerState,
): Node {
	const innerAlias = depth === 0 ? '__t__' : `__t${depth}__`;

	const relation = decision.relation ?? decision.relationName;
	const targetTable = decision.targetTable ?? relation;

	if (!targetTable) {
		throw new Error('JSON_AGG include requires targetTable');
	}
	if (!relation) {
		throw new Error('JSON_AGG include requires relation name');
	}

	// Build correlation WHERE based on relation type
	const { sourceColumn, targetColumn } = deriveFkColumns(
		decision,
		parentAlias,
		ctx.defaultPkColumnName,
		ctx.deriveFkColumnName,
	);
	let whereExpr: Node = jsonAggCorrelation(
		parentAlias,
		sourceColumn,
		innerAlias,
		targetColumn,
		ctx.naming,
	);

	// Merge pre-compiled filter conditions (from EXISTS propagation via bridge)
	const compiledFilter = (decision as unknown as Record<string, unknown>)
		._compiledFilterWhere as Node | undefined;
	if (compiledFilter) {
		whereExpr = andExpr(whereExpr, compiledFilter);
	}

	// Recursively compile children
	let childNodes: { key: string; node: Node }[] | undefined;
	if (decision.children && decision.children.length > 0) {
		childNodes = [];
		for (const child of decision.children) {
			const childRelation = child.relation ?? child.relationName;
			if (childRelation && child.targetTable && child.relationType) {
				const childResTarget = compileJsonAggRecursive(
					child,
					innerAlias,
					depth + 1,
					ctx,
					_state,
				);
				// Extract the COALESCE node from the ResTarget wrapper
				const resTarget = childResTarget as { ResTarget?: { val: Node } };
				if (resTarget.ResTarget?.val) {
					childNodes.push({
						key: childRelation,
						node: resTarget.ResTarget.val,
					});
				}
			}
		}
		if (childNodes.length === 0) childNodes = undefined;
	}

	const limit = typeof decision.limit === 'number' ? decision.limit : undefined;

	return jsonAggSubquery(
		targetTable,
		whereExpr,
		`${relation}_json`,
		ctx.schema,
		ctx.naming,
		{
			...(childNodes && { childNodes }),
			innerAlias,
			...(limit !== undefined && { limit }),
		},
	);
}

/**
 * JSON_AGG strategy include handler
 *
 * Uses correlated subquery with json_agg + to_jsonb to embed related records as JSON array.
 * Supports recursive nesting for deep relation traversal.
 *
 * Advantages:
 * - No row explosion (parent row count is preserved)
 * - Full related data in a single column
 * - Recursive nesting via jsonb_build_object merge
 *
 * Disadvantages:
 * - Correlated subquery can be slower for large datasets
 * - JSON manipulation required on client
 */
export const jsonAggIncludeHandler: IncludeHandler = {
	strategy: 'json_agg',

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
	): IncludeResult {
		const outerAlias = ctx.currentAlias ?? ctx.rootTable;

		const resTarget = compileJsonAggRecursive(
			decision,
			outerAlias,
			0,
			ctx,
			state,
		);

		return {
			targets: [resTarget],
		};
	},
};
