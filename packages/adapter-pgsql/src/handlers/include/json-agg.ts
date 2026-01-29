/**
 * JSON_AGG Include Strategy Handler
 *
 * Implements the 'json_agg' include strategy using PostgreSQL's json_agg.
 * Aggregates related records into a JSON array in a single query.
 *
 * Produces: (SELECT json_agg(json_build_object(...)) FROM related WHERE fk = source.pk) AS relation
 */

import type { Node, SelectStmt } from '@pgsql/types';
import { columnRef, eqExpr, rangeVar } from '../../ast-helpers.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	IncludeHandler,
	IncludeResult,
} from '../types.js';

/**
 * Build json_build_object call for selected columns
 *
 * json_build_object('col1', t.col1, 'col2', t.col2, ...)
 */
function buildJsonBuildObject(
	columns: readonly string[],
	alias: string,
	ctx: CompilerContext,
): Node {
	const args: Node[] = [];

	for (const col of columns) {
		// Add key (column name)
		args.push({
			A_Const: { sval: { sval: ctx.naming.toDatabase(col) } },
		});
		// Add value (column reference)
		args.push(columnRef(col, alias, ctx.schema, ctx.naming));
	}

	return {
		FuncCall: {
			funcname: [{ String: { sval: 'json_build_object' } }],
			args,
		},
	};
}

/**
 * Build json_agg call
 *
 * json_agg(expression) or json_agg(expression ORDER BY ...)
 */
function buildJsonAgg(
	expression: Node,
	orderBy?: readonly { column: string; direction?: 'ASC' | 'DESC' }[],
	alias?: string,
	ctx?: CompilerContext,
): Node {
	const funcCall: {
		funcname: Node[];
		args: Node[];
		agg_order?: Node[];
	} = {
		funcname: [{ String: { sval: 'json_agg' } }],
		args: [expression],
	};

	// Add ORDER BY if specified
	if (orderBy && orderBy.length > 0 && alias && ctx) {
		funcCall.agg_order = orderBy.map((item) => ({
			SortBy: {
				node: columnRef(item.column, alias, ctx.schema, ctx.naming),
				sortby_dir: item.direction === 'DESC' ? 'SORTBY_DESC' : 'SORTBY_ASC',
				sortby_nulls: 'SORTBY_NULLS_DEFAULT',
			},
		}));
	}

	return { FuncCall: funcCall };
}

/**
 * Build COALESCE to handle NULL (no related records)
 *
 * COALESCE(json_agg(...), '[]'::json)
 */
function wrapWithCoalesce(jsonAgg: Node): Node {
	return {
		CoalesceExpr: {
			args: [
				jsonAgg,
				{
					TypeCast: {
						arg: { A_Const: { sval: { sval: '[]' } } },
						typeName: {
							names: [{ String: { sval: 'json' } }],
						},
					},
				},
			],
		},
	};
}

/**
 * Build a correlated subquery for json_agg
 */
function buildJsonAggSubquery(
	targetTable: string,
	innerAlias: string,
	outerAlias: string,
	sourceColumn: string,
	targetColumn: string,
	columns: readonly string[],
	orderBy:
		| readonly { column: string; direction?: 'ASC' | 'DESC' }[]
		| undefined,
	ctx: CompilerContext,
): Node {
	// Build WHERE correlation
	const whereClause = eqExpr(
		columnRef(targetColumn, innerAlias, ctx.schema, ctx.naming),
		columnRef(sourceColumn, outerAlias, ctx.schema, ctx.naming),
	);

	// Build json_build_object for each row
	const jsonObject = buildJsonBuildObject(columns, innerAlias, ctx);

	// Wrap in json_agg
	const jsonAgg = buildJsonAgg(jsonObject, orderBy, innerAlias, ctx);

	// Wrap in COALESCE to return [] instead of NULL
	const coalesced = wrapWithCoalesce(jsonAgg);

	const stmt: SelectStmt = {
		targetList: [{ ResTarget: { val: coalesced } }],
		fromClause: [rangeVar(targetTable, innerAlias, ctx.schema, ctx.naming)],
		whereClause,
	};

	return { SelectStmt: stmt };
}

/**
 * JSON_AGG strategy include handler
 *
 * Uses correlated subquery with json_agg to embed related records as JSON array.
 * Best for: hasMany relationships (1:N)
 *
 * Advantages:
 * - No row explosion (parent row count is preserved)
 * - Full related data in a single column
 * - Result is immediately usable as JSON
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
		const relation = decision.relation;
		const targetTable = decision.targetTable ?? relation;
		const sourceColumn = decision.sourceColumn ?? 'id';
		const targetColumn = decision.targetColumn ?? `${ctx.rootTable}_id`;
		const columns = decision.columns ?? ['id']; // Default to id if no columns specified
		const orderBy = decision.orderBy;

		if (!targetTable) {
			throw new Error('JSON_AGG include requires targetTable');
		}

		if (!relation) {
			throw new Error('JSON_AGG include requires relation name');
		}

		// Generate unique alias
		const existingAliases = state.aliases.size;
		const innerAlias = `${targetTable}_json_${existingAliases}`;
		state.aliases.set(`json_${targetTable}`, innerAlias);

		const outerAlias = ctx.currentAlias ?? ctx.rootTable;

		// Build the correlated subquery
		const subquery = buildJsonAggSubquery(
			targetTable,
			innerAlias,
			outerAlias,
			sourceColumn,
			targetColumn,
			columns,
			orderBy,
			ctx,
		);

		// Wrap subquery as a scalar subquery in SELECT list
		const target: Node = {
			ResTarget: {
				val: {
					SubLink: {
						subLinkType: 'EXPR_SUBLINK',
						subselect: subquery,
					},
				},
				name: ctx.naming.toDatabase(relation),
			},
		};

		return {
			targets: [target],
		};
	},
};
