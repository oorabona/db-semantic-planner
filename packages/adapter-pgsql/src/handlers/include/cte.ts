/**
 * CTE Include Strategy Handler
 *
 * Implements the 'cte' include strategy using Common Table Expressions.
 * Pre-fetches related data in a CTE, then joins with the main query.
 *
 * Produces: WITH relation_cte AS (SELECT ... FROM related) SELECT ... JOIN relation_cte
 */

import { type ColumnListInput, toColumnList } from '@dbsp/types';
import type { CommonTableExpr, JoinExpr, Node, SelectStmt } from '@pgsql/types';
import { DEFAULT_PK_COLUMN, defaultFkDerivation } from '../../assert-field.js';
import { columnRef, rangeVar, starTarget } from '../../ast-helpers.js';
import { createWhereDispatcher } from '../index.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	IncludeHandler,
	IncludeResult,
} from '../types.js';
import { buildKeyCorrelation } from '../where/exists.js';

/**
 * Build column targets for CTE
 */
function buildCteTargets(
	columns: readonly string[] | undefined,
	alias: string,
	ctx: CompilerContext,
): Node[] {
	if (columns && columns.length > 0 && !columns.every((c) => c === '*')) {
		return columns
			.filter((col) => col !== '*')
			.map((col) => ({
				ResTarget: {
					val: columnRef(col, alias, undefined, ctx.naming),
					name: ctx.naming.toDatabase(col),
				},
			}));
	}

	// Select all columns
	return [starTarget(alias, ctx.naming)];
}

/**
 * Build the CTE SELECT statement
 */
function buildCteSelect(
	targetTable: string,
	innerAlias: string,
	columns: readonly string[] | undefined,
	whereConditions: readonly Decision[] | undefined,
	ctx: CompilerContext,
	state: CompilerState,
): Node {
	const targetList = buildCteTargets(columns, innerAlias, ctx);

	// Build WHERE if conditions exist
	let whereClause: Node | undefined;
	if (whereConditions && whereConditions.length > 0) {
		const dispatch = createWhereDispatcher();

		const subCtx: CompilerContext = {
			...ctx,
			rootTable: targetTable,
			currentAlias: innerAlias,
		};

		if (whereConditions.length === 1) {
			whereClause = dispatch(whereConditions[0]!, subCtx, state);
		} else {
			const conditions = whereConditions.map((cond) =>
				dispatch(cond, subCtx, state),
			);
			whereClause = {
				BoolExpr: {
					boolop: 'AND_EXPR',
					args: conditions,
				},
			};
		}
	}

	const stmt: SelectStmt = {
		targetList,
		fromClause: [rangeVar(targetTable, innerAlias, ctx.schema, ctx.naming)],
		...(whereClause && { whereClause }),
	};

	return { SelectStmt: stmt };
}

/**
 * Build a CommonTableExpr node
 */
function buildCTE(
	cteName: string,
	cteSelect: Node,
	ctx: CompilerContext,
): Node {
	const cte: CommonTableExpr = {
		ctename: ctx.naming.toDatabase(cteName),
		ctequery: cteSelect,
	};

	return { CommonTableExpr: cte };
}

/**
 * Build a LEFT JOIN to the CTE
 */
function buildCteJoin(
	cteName: string,
	cteAlias: string,
	sourceAlias: string,
	sourceColumn: ColumnListInput,
	targetColumn: ColumnListInput,
	ctx: CompilerContext,
): Node {
	// Join condition: source.fk = cte.pk
	const joinCondition = buildKeyCorrelation(
		sourceAlias,
		sourceColumn,
		cteAlias,
		targetColumn,
		ctx,
	);

	// Reference the CTE as if it were a table
	const cteRef: Node = {
		RangeVar: {
			relname: ctx.naming.toDatabase(cteName),
			inh: true,
			relpersistence: 'p',
			alias: { aliasname: ctx.naming.toDatabase(cteAlias) },
		},
	};

	const joinExpr: JoinExpr = {
		jointype: 'JOIN_LEFT',
		rarg: cteRef,
		quals: joinCondition,
	};

	return { JoinExpr: joinExpr };
}

/**
 * CTE strategy include handler
 *
 * Uses Common Table Expression to pre-fetch related data.
 * Best for: Complex filtering or multiple references to same relation.
 *
 * Advantages:
 * - CTE is computed once, can be referenced multiple times
 * - Clear query structure
 * - Good for complex transformations on related data
 *
 * Disadvantages:
 * - PostgreSQL CTEs are optimization barriers (before PG12)
 * - More verbose SQL
 */
export const cteIncludeHandler: IncludeHandler = {
	strategy: 'cte',

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
	): IncludeResult {
		const relation = decision.relation;
		const targetTable = decision.targetTable ?? relation;
		const sourceColumn = toColumnList(decision.sourceColumn);
		if (sourceColumn.length === 0 || sourceColumn.some((col) => col === '')) {
			throw new Error("Missing required column 'sourceColumn' in CTE include");
		}
		const targetColumn = decision.targetColumn ?? [
			(ctx.deriveFkColumnName ?? defaultFkDerivation)(
				ctx.rootTable,
				ctx.defaultPkColumnName ?? DEFAULT_PK_COLUMN,
			),
		];
		const columns = decision.columns;
		const conditions = decision.conditions;

		if (!targetTable) {
			throw new Error('CTE include requires targetTable');
		}

		if (!relation) {
			throw new Error('CTE include requires relation name');
		}

		// Generate unique names
		const existingAliases = state.aliases.size;
		const cteName = `${relation}_cte`;
		const innerAlias = `${targetTable}_inner_${existingAliases}`;
		const cteAlias = `${relation}_ref_${existingAliases}`;
		state.aliases.set(`cte_${targetTable}`, cteName);

		const outerAlias = ctx.currentAlias ?? ctx.rootTable;

		// Build the CTE SELECT
		const cteSelect = buildCteSelect(
			targetTable,
			innerAlias,
			columns,
			conditions,
			ctx,
			state,
		);

		// Build the CTE node
		const cte = buildCTE(cteName, cteSelect, ctx);

		// Register CTE in state for WITH clause
		state.ctes.set(cteName, cte);

		// Build JOIN to the CTE
		const join = buildCteJoin(
			cteName,
			cteAlias,
			outerAlias,
			sourceColumn,
			targetColumn,
			ctx,
		);

		return {
			cte,
			join,
		};
	},
};
