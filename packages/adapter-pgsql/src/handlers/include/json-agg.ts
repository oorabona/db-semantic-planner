/**
 * JSON_AGG Include Strategy Handler
 *
 * Implements the 'json_agg' include strategy using PostgreSQL's json_agg.
 * Uses to_jsonb(__t__) for wildcard row selection, with recursive nesting
 * via jsonb_build_object merge for child relations.
 *
 * Produces: COALESCE((SELECT json_agg(to_jsonb(__t__) [|| jsonb_build_object(...)] ORDER BY __t__.pk ASC NULLS LAST) FROM target AS __t__ WHERE ...), '[]'::json) AS relation
 */

import { type JsonAggOrderByEntry, resolveJsonAggOrderKey } from '@dbsp/types';
import type { Node } from '@pgsql/types';
import {
	andExpr,
	columnRef,
	jsonAggSubquery,
	typeCast,
} from '../../ast-helpers.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	IncludeHandler,
	IncludeResult,
	ResTargetNode,
} from '../types.js';
import { buildKeyCorrelation } from '../where/exists.js';
import { deriveFkColumns } from './shared.js';

interface JsonAggOrderIntent {
	readonly columns: readonly JsonAggOrderByEntry[];
	readonly fallback: boolean;
}

function isJsonAggOrderBy(
	orderBy: Decision['orderBy'],
): orderBy is readonly JsonAggOrderByEntry[] {
	return (
		Array.isArray(orderBy) && orderBy.every((item) => typeof item === 'string')
	);
}

function resolveJsonAggOrderBy(
	decision: Decision,
	targetTable: string,
	ctx: CompilerContext,
): JsonAggOrderIntent | undefined {
	const table = ctx.model?.getTable(targetTable);
	if (table) {
		// ctx.model is authoritative: with schema metadata available, resolve the
		// order key from the model rather than trusting decision-carried fallbacks.
		const orderKey = resolveJsonAggOrderKey(table);
		return orderKey.columns.length > 0 ? orderKey : undefined;
	}

	const decisionOrderBy = isJsonAggOrderBy(decision.orderBy)
		? decision.orderBy
		: undefined;
	return decisionOrderBy && decisionOrderBy.length > 0
		? {
				columns: decisionOrderBy,
				fallback: decision.orderByFallback === true,
			}
		: undefined;
}

function columnNeedsJsonTextCast(column: { readonly js?: string }): boolean {
	return (
		column.js === 'bigint' || column.js === 'number' || column.js === 'string'
	);
}

function resolveJsonAggProjection(
	decision: Decision,
	targetTable: string,
	ctx: CompilerContext,
): readonly string[] | undefined {
	const requested = decision.columns;
	const hasExplicitProjection =
		requested &&
		requested.length > 0 &&
		!(requested.length === 1 && requested[0] === '*');
	if (hasExplicitProjection) return requested;

	const table = ctx.model?.getTable(targetTable);
	const needsExplicitProjection =
		table?.columns.some((column) => columnNeedsJsonTextCast(column)) ?? false;
	if (!needsExplicitProjection || !table) return requested;
	return table.columns.map((column) => column.name);
}

function buildJsonAggColumnValueOverrides(
	targetTable: string,
	columns: readonly string[] | undefined,
	innerAlias: string,
	ctx: CompilerContext,
): ReadonlyMap<string, Node> | undefined {
	if (!columns || columns.length === 0) return undefined;
	const table = ctx.model?.getTable(targetTable);
	if (!table) return undefined;
	const overrides = new Map<string, Node>();
	for (const columnName of columns) {
		const column = table.columns.find(
			(candidate) => candidate.name === columnName,
		);
		if (!column || !columnNeedsJsonTextCast(column)) continue;
		overrides.set(
			columnName,
			typeCast(
				columnRef(columnName, innerAlias, undefined, ctx.naming),
				'text',
			),
		);
	}
	return overrides.size > 0 ? overrides : undefined;
}

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
	let whereExpr: Node = buildKeyCorrelation(
		innerAlias,
		targetColumn,
		parentAlias,
		sourceColumn,
		ctx,
	);

	// Merge pre-compiled filter conditions (from EXISTS propagation via bridge)
	const compiledFilter = decision._compiledFilterWhere;
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
				const resTarget = childResTarget as ResTargetNode;
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
	const orderBy = resolveJsonAggOrderBy(decision, targetTable, ctx);
	const columns = resolveJsonAggProjection(decision, targetTable, ctx);
	const columnValueOverrides = buildJsonAggColumnValueOverrides(
		targetTable,
		columns,
		innerAlias,
		ctx,
	);

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
			...(columns && { columns }),
			...(columnValueOverrides && { columnValueOverrides }),
			...(orderBy && { orderBy: orderBy.columns }),
			...(orderBy?.fallback && { orderByFallback: true }),
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
