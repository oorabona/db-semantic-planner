/**
 * Relation Filter Handler
 *
 * Handles filtering by related records using:
 * - some: At least one related record matches (EXISTS)
 * - none: No related records match (NOT EXISTS)
 * - every: All related records match (NOT EXISTS ... WHERE NOT)
 * - is: Related record matches exactly (JOIN + conditions)
 *
 * This handler acts as a higher-level abstraction that routes to
 * the appropriate underlying handler (EXISTS, JOIN, etc.)
 */

import { toColumnList } from '@dbsp/types';
import type { JoinExpr, Node } from '@pgsql/types';
import { DEFAULT_PK_COLUMN, defaultFkDerivation } from '../../assert-field.js';
import { rangeVar } from '../../ast-helpers.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	WhereDispatcher,
	WhereHandler,
} from '../types.js';
import { buildKeyCorrelation } from './exists.js';

/**
 * Relation filter mode
 */
type FilterMode = 'some' | 'none' | 'every' | 'is' | 'isNot';

/**
 * Determine the filter mode from the decision
 */
function getFilterMode(decision: Decision): FilterMode {
	const operator = decision.operator;
	if (operator === 'some' || operator === 'exists') return 'some';
	if (operator === 'none' || operator === 'notExists') return 'none';
	if (operator === 'every') return 'every';
	if (operator === 'isNot') return 'isNot';
	return 'is';
}

/**
 * Build a JOIN-based filter for 'is' mode (single related record match)
 *
 * This produces a JOIN condition rather than a subquery, which can be
 * more efficient for single-record relationships (belongsTo, hasOne)
 */
function buildJoinFilter(
	decision: Decision,
	ctx: CompilerContext,
	state: CompilerState,
	dispatch: WhereDispatcher,
): Node {
	const relation = decision.relation;
	const targetTable = decision.targetTable ?? relation;
	const sourceColumn = toColumnList(decision.sourceColumn);
	if (sourceColumn.length === 0) {
		throw new Error(
			"Missing required column 'sourceColumn' in relation filter",
		);
	}
	const targetColumn = decision.targetColumn ?? [
		(ctx.deriveFkColumnName ?? defaultFkDerivation)(
			ctx.rootTable,
			ctx.defaultPkColumnName ?? DEFAULT_PK_COLUMN,
		),
	];

	if (!targetTable) {
		throw new Error('Relation filter requires targetTable');
	}

	// Generate unique alias
	const existingAliases = state.aliases.size;
	const targetAlias = `${targetTable}_rel_${existingAliases}`;
	state.aliases.set(`rel_${targetTable}`, targetAlias);

	const sourceAlias = ctx.currentAlias ?? ctx.rootTable;

	// Build join condition: source.column = target.column
	const joinCondition = buildKeyCorrelation(
		sourceAlias,
		sourceColumn,
		targetAlias,
		targetColumn,
		ctx,
	);

	// Build a proper JoinExpr node
	// Note: The left arg (larg) will be set by the compiler when constructing the full FROM clause
	const joinExpr: JoinExpr = {
		jointype: 'JOIN_INNER',
		rarg: rangeVar(targetTable, targetAlias, ctx.schema, ctx.naming),
		quals: joinCondition,
	};

	// Track the join for the compiler
	state.joins.push({ JoinExpr: joinExpr });

	// If there are additional conditions on the relation, compile them
	if (decision.conditions && decision.conditions.length > 0) {
		const subCtx: CompilerContext = {
			...ctx,
			rootTable: targetTable,
			currentAlias: targetAlias,
		};

		if (decision.conditions.length === 1) {
			return dispatch(decision.conditions[0]!, subCtx, state);
		}

		const compiledConditions = decision.conditions.map((cond) =>
			dispatch(cond, subCtx, state),
		);

		return {
			BoolExpr: {
				boolop: 'AND_EXPR',
				args: compiledConditions,
			},
		};
	}

	// No additional conditions, return a TRUE constant
	// (the join itself is the filter)
	return { A_Const: { boolval: { boolval: true } } };
}

/**
 * Relation filter handler
 *
 * Routes to EXISTS-based or JOIN-based filtering depending on the mode
 */
export const relationFilterHandler: WhereHandler = {
	operators: ['relationFilter', 'relation', 'is', 'isNot'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
		dispatch: WhereDispatcher,
	): Node {
		const mode = getFilterMode(decision);

		// For 'some', 'none', 'every' - delegate to EXISTS handlers
		// These are registered separately and will be dispatched by the main dispatcher
		if (mode === 'some' || mode === 'none' || mode === 'every') {
			// Transform to EXISTS-style decision
			const existsDecision: Decision = {
				...decision,
				type: 'exists',
				operator:
					mode === 'some' ? 'exists' : mode === 'none' ? 'notExists' : 'every',
			};
			return dispatch(existsDecision, ctx, state);
		}

		// For 'is' or 'isNot' - use JOIN-based filtering
		const joinFilter = buildJoinFilter(decision, ctx, state, dispatch);

		if (mode === 'isNot') {
			// Negate the condition
			return {
				BoolExpr: {
					boolop: 'NOT_EXPR',
					args: [joinFilter],
				},
			};
		}

		return joinFilter;
	},
};

/**
 * Has-relation filter (sugar for relationFilter with some mode)
 */
export const hasRelationHandler: WhereHandler = {
	operators: ['has', 'hasRelation'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
		dispatch: WhereDispatcher,
	): Node {
		const existsDecision: Decision = {
			...decision,
			type: 'exists',
			operator: 'exists',
		};
		return dispatch(existsDecision, ctx, state);
	},
};

/**
 * Has-no-relation filter (sugar for relationFilter with none mode)
 */
export const hasNoRelationHandler: WhereHandler = {
	operators: ['hasNo', 'hasNoRelation'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
		dispatch: WhereDispatcher,
	): Node {
		const notExistsDecision: Decision = {
			...decision,
			type: 'exists',
			operator: 'notExists',
		};
		return dispatch(notExistsDecision, ctx, state);
	},
};
