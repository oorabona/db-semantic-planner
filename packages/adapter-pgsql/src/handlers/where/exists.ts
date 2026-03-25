/**
 * EXISTS Operators Handler
 *
 * Handles: exists, notExists (some, none modes)
 *
 * EXISTS checks if at least one related record exists.
 * NOT EXISTS checks that no related records exist.
 */

import type { Node, SelectStmt, SubLink } from '@pgsql/types';
import { DEFAULT_PK_COLUMN, defaultFkDerivation } from '../../assert-field.js';
import {
	columnRef,
	eqExpr,
	fkCorrelation,
	joinExpr,
	rangeVar,
} from '../../ast-helpers.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	WhereDispatcher,
	WhereHandler,
} from '../types.js';

/**
 * Create a SubLink node for EXISTS/NOT EXISTS
 * Note: SubLinkType only has EXISTS_SUBLINK, so we wrap with NOT BoolExpr for negation
 */
function createSubLinkExists(subquery: Node, negated: boolean): Node {
	const subLink: SubLink = {
		subLinkType: 'EXISTS_SUBLINK',
		subselect: subquery,
	};
	const existsNode: Node = { SubLink: subLink };

	if (negated) {
		return {
			BoolExpr: {
				boolop: 'NOT_EXPR',
				args: [existsNode],
			},
		};
	}

	return existsNode;
}

/**
 * Build correlation condition: source.column = target.column
 */
function buildCorrelation(
	sourceAlias: string,
	sourceColumn: string,
	targetAlias: string,
	targetColumn: string,
	ctx: CompilerContext,
): Node {
	// Neither source nor target uses schema — column references are query-scoped.
	// Schema is only for FROM/JOIN clause table entries (rangeVar).
	const left = columnRef(sourceColumn, sourceAlias, undefined, ctx.naming);
	const right = columnRef(targetColumn, targetAlias, undefined, ctx.naming);
	return eqExpr(left, right);
}

/**
 * Build a basic EXISTS subquery
 *
 * SELECT 1 FROM targetTable AS targetAlias
 * WHERE targetAlias.fk = sourceAlias.pk [AND additional conditions]
 */
function buildExistsSubquery(
	decision: Decision,
	ctx: CompilerContext,
	state: CompilerState,
	dispatch: WhereDispatcher,
): Node {
	const relation = decision.relation;
	const targetTable = decision.targetTable ?? relation;
	// sourceColumn: prefer explicit value from decision (set by planner's mapToHandlerDecision).
	// When called directly from mutation WHERE (DELETE/UPDATE), the planner is bypassed and
	// sourceColumn is absent — fall back to the PK convention (typically 'id' for hasMany).
	const sourceColumn =
		decision.sourceColumn ?? ctx.defaultPkColumnName ?? DEFAULT_PK_COLUMN;
	const targetColumn =
		decision.targetColumn ??
		(ctx.deriveFkColumnName ?? defaultFkDerivation)(
			ctx.rootTable,
			ctx.defaultPkColumnName ?? DEFAULT_PK_COLUMN,
		);

	if (!targetTable) {
		throw new Error('EXISTS handler requires targetTable or relation');
	}

	// Generate unique alias
	const existingAliases = state.aliases.size;
	const targetAlias = `${targetTable}_exists_${existingAliases}`;
	state.aliases.set(`exists_${targetTable}`, targetAlias);

	const sourceAlias = ctx.currentAlias ?? ctx.rootTable;

	// Build correlation condition
	const correlation = buildCorrelation(
		sourceAlias,
		sourceColumn,
		targetAlias,
		targetColumn,
		ctx,
	);

	// Build WHERE clause (correlation + nested conditions)
	let whereClause = correlation;
	if (decision.conditions && decision.conditions.length > 0) {
		// Create context for subquery with target alias.
		// Schema is stripped because nested conditions reference the aliased table,
		// and aliases are query-scoped (not schema-qualified).
		const { schema: _schema, ...ctxWithoutSchema } = ctx;
		const subCtx: CompilerContext = {
			...ctxWithoutSchema,
			rootTable: targetTable,
			currentAlias: targetAlias,
			outerAlias: sourceAlias,
		};

		// Compile nested conditions
		const nestedConditions = decision.conditions.map((cond) =>
			dispatch(cond, subCtx, state),
		);

		// AND correlation with nested conditions
		whereClause = {
			BoolExpr: {
				boolop: 'AND_EXPR',
				args: [correlation, ...nestedConditions],
			},
		};
	}

	// Build SELECT 1 FROM targetTable AS targetAlias [JOIN ...] WHERE ...
	let fromNode: Node = rangeVar(
		targetTable,
		targetAlias,
		ctx.schema,
		ctx.naming,
	);

	// Add JOIN clauses for each include entry.
	// Each include entry in decision.include has shape: { type:'existsInclude', relation, joinType }
	// The relation is used as the join alias so dotted WHERE references (e.g. callerFile.project_id) resolve.
	const includeDecisions = decision.include as
		| readonly { relation?: string; joinType?: string }[]
		| undefined;
	if (includeDecisions && includeDecisions.length > 0) {
		for (const inc of includeDecisions) {
			const joinRelation = inc.relation;
			if (!joinRelation) continue;

			// Resolve the join target table and FK columns from ModelIR when available.
			// The relation is on the subquery's table (targetTable), e.g. calls.callerFile.
			let joinTargetTable: string = joinRelation;
			let joinSourceCol: string | undefined;
			let joinTargetCol: string | undefined;

			const model = ctx.model;
			if (model) {
				const rel = model.getRelation(`${targetTable}.${joinRelation}`);
				if (rel) {
					joinTargetTable = rel.target;
					if (rel.type === 'belongsTo') {
						// FK is on the source side (targetTable.fkCol → joinTargetTable.id)
						const fk =
							typeof rel.foreignKey === 'string'
								? rel.foreignKey
								: Array.isArray(rel.foreignKey)
									? rel.foreignKey[0]
									: undefined;
						joinSourceCol = fk;
						joinTargetCol =
							(ctx.defaultPkColumnName as string | undefined) ??
							DEFAULT_PK_COLUMN;
					} else {
						// hasMany/hasOne: FK is on the target side (joinTargetTable.fkCol → targetTable.id)
						const fk =
							typeof rel.foreignKey === 'string'
								? rel.foreignKey
								: Array.isArray(rel.foreignKey)
									? rel.foreignKey[0]
									: undefined;
						joinSourceCol =
							(ctx.defaultPkColumnName as string | undefined) ??
							DEFAULT_PK_COLUMN;
						joinTargetCol = fk;
					}
				}
			}

			// Fall back to FK derivation convention when ModelIR didn't resolve columns.
			if (!joinSourceCol) {
				// Assume belongsTo: FK on targetTable = joinRelation + '_id'
				joinSourceCol = (ctx.deriveFkColumnName ?? defaultFkDerivation)(
					joinRelation,
					(ctx.defaultPkColumnName as string | undefined) ?? DEFAULT_PK_COLUMN,
				);
				joinTargetCol =
					(ctx.defaultPkColumnName as string | undefined) ?? DEFAULT_PK_COLUMN;
			}

			const joinAlias = joinRelation; // e.g. 'callerFile'
			const joinQuals = fkCorrelation(
				joinSourceCol,
				targetAlias,
				joinTargetCol ?? DEFAULT_PK_COLUMN,
				joinAlias,
				ctx.naming,
			);

			const joinType =
				(inc.joinType as string | undefined) === 'left'
					? 'JOIN_LEFT'
					: 'JOIN_INNER';

			const joinRangeVar = rangeVar(
				joinTargetTable,
				joinAlias,
				ctx.schema,
				ctx.naming,
			);

			// Wrap current fromNode with the new join: JoinExpr { larg: fromNode, rarg: joinRangeVar }
			fromNode = joinExpr(joinType, fromNode, joinRangeVar, joinQuals);
		}
	}

	const stmt: SelectStmt = {
		targetList: [
			{
				ResTarget: {
					val: { A_Const: { ival: { ival: 1 } } },
				},
			},
		],
		fromClause: [fromNode],
		whereClause,
	};

	return { SelectStmt: stmt };
}

/**
 * EXISTS handler (mode: some)
 *
 * Returns rows where at least one related record exists.
 */
export const existsHandler: WhereHandler = {
	operators: ['exists', 'some'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
		dispatch: WhereDispatcher,
	): Node {
		const subquery = buildExistsSubquery(decision, ctx, state, dispatch);
		return createSubLinkExists(subquery, false);
	},
};

/**
 * NOT EXISTS handler (mode: none)
 *
 * Returns rows where no related records exist.
 */
export const notExistsHandler: WhereHandler = {
	operators: ['notExists', 'none'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
		dispatch: WhereDispatcher,
	): Node {
		const subquery = buildExistsSubquery(decision, ctx, state, dispatch);
		return createSubLinkExists(subquery, true);
	},
};

/**
 * EVERY handler (mode: every)
 *
 * Returns rows where ALL related records match.
 * Implemented as NOT EXISTS (... WHERE NOT condition)
 */
export const everyHandler: WhereHandler = {
	operators: ['every'],

	compile(
		decision: Decision,
		ctx: CompilerContext,
		state: CompilerState,
		dispatch: WhereDispatcher,
	): Node {
		// For 'every', we invert the WHERE condition and use NOT EXISTS
		// every(condition) = NOT EXISTS (SELECT 1 ... WHERE NOT condition)

		if (!decision.conditions || decision.conditions.length === 0) {
			// If no condition, every always matches (vacuous truth)
			return { A_Const: { boolval: { boolval: true } } };
		}

		// Wrap conditions in NOT
		const invertedDecision: Decision = {
			...decision,
			conditions: [
				{
					type: 'logical',
					operator: 'not',
					conditions: decision.conditions,
				},
			],
		};

		const subquery = buildExistsSubquery(
			invertedDecision,
			ctx,
			state,
			dispatch,
		);
		return createSubLinkExists(subquery, true);
	},
};
