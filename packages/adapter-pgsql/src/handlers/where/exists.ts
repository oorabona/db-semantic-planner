/**
 * EXISTS Operators Handler
 *
 * Handles: exists, notExists (some, none modes)
 *
 * EXISTS checks if at least one related record exists.
 * NOT EXISTS checks that no related records exist.
 */

import { type ColumnListInput, toColumnList } from '@dbsp/types';
import type { Node, SelectStmt, SubLink } from '@pgsql/types';
import { DEFAULT_PK_COLUMN, defaultFkDerivation } from '../../assert-field.js';
import {
	andExpr,
	columnRef,
	eqExpr,
	joinExpr,
	rangeVar,
} from '../../ast-helpers.js';
import { schemaForFromName } from '../../binding-registry.js';
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

export function buildKeyCorrelation(
	sourceAlias: string,
	sourceCols: ColumnListInput,
	targetAlias: string,
	targetCols: ColumnListInput,
	ctx: CompilerContext,
): Node {
	const normalizedSourceCols = toColumnList(sourceCols);
	const normalizedTargetCols = toColumnList(targetCols);
	if (
		normalizedSourceCols.length === 0 ||
		normalizedTargetCols.length === 0 ||
		normalizedSourceCols.length !== normalizedTargetCols.length ||
		normalizedSourceCols.some((column) => column.length === 0) ||
		normalizedTargetCols.some((column) => column.length === 0)
	) {
		throw new Error(
			`Invalid relation correlation: source columns (${normalizedSourceCols.length}) must match target columns (${normalizedTargetCols.length}) and both must be non-empty.`,
		);
	}

	const comparisons = normalizedSourceCols.map((sourceColumn, index) =>
		eqExpr(
			columnRef(sourceColumn, sourceAlias, undefined, ctx.naming),
			columnRef(
				normalizedTargetCols[index]!,
				targetAlias,
				undefined,
				ctx.naming,
			),
		),
	);
	if (comparisons.length === 1) return comparisons[0]!;
	return andExpr(...comparisons);
}

/**
 * Build correlation condition: source.column = target.column
 */
function _buildCorrelation(
	sourceAlias: string,
	sourceColumn: string,
	targetAlias: string,
	targetColumn: string,
	ctx: CompilerContext,
): Node {
	return buildKeyCorrelation(
		sourceAlias,
		[sourceColumn],
		targetAlias,
		[targetColumn],
		ctx,
	);
}

function schemaForExistsFromName(
	ctx: CompilerContext,
	fromName: string,
): string | undefined {
	return schemaForFromName(ctx.schema, fromName, ctx.bindingNames, ctx.naming);
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
	const sourceColumn = decision.sourceColumn ?? [
		ctx.defaultPkColumnName ?? DEFAULT_PK_COLUMN,
	];
	const targetColumn = decision.targetColumn ?? [
		(ctx.deriveFkColumnName ?? defaultFkDerivation)(
			ctx.rootTable,
			ctx.defaultPkColumnName ?? DEFAULT_PK_COLUMN,
		),
	];

	if (!targetTable) {
		throw new Error('EXISTS handler requires targetTable or relation');
	}

	// Generate unique alias
	const existingAliases = state.aliases.size;
	const targetAlias = `${targetTable}_exists_${existingAliases}`;
	state.aliases.set(`exists_${targetTable}`, targetAlias);

	const sourceAlias = ctx.currentAlias ?? ctx.rootTable;

	// Build correlation condition
	const correlation = buildKeyCorrelation(
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
		// NOTE: schema is intentionally KEPT in subCtx so that any nested EXISTS
		// conditions can qualify their own FROM tables (rangeVar) with the schema
		// name.  Column references are always query-scoped (alias-prefixed, no
		// schema) — buildCorrelation and columnRef already pass undefined for schema
		// independently of the context.  Stripping schema here was the root cause of
		// the nested-exists schema-scoping bug: the inner rangeVar would receive
		// undefined as schema and emit an unqualified table name.
		const subCtx: CompilerContext = {
			...ctx,
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
		schemaForExistsFromName(ctx, targetTable),
		ctx.naming,
	);

	// Add JOIN clauses for each include entry.
	// Each include entry in decision.include has shape: { type:'existsInclude', relation, joinType }
	// The relation is used as the join alias so dotted WHERE references (e.g. callerFile.project_id) resolve.
	const includeDecisions = decision.include as
		| readonly { relation?: string; joinType?: string }[]
		| undefined;
	if (includeDecisions && includeDecisions.length > 0) {
		// Track alias → realTableName for multi-hop FK resolution.
		// When the 2nd+ include is a relation on an intermediate joined table
		// (not the root targetTable), we find the correct FK by scanning
		// previously joined tables first, then falling back to root.
		const joinedTables = new Map<string, string>(); // alias → realTableName

		for (const inc of includeDecisions) {
			const joinRelation = inc.relation;
			if (!joinRelation) continue;

			// Resolve the join target table and FK columns from ModelIR when available.
			let joinTargetTable: string = joinRelation;
			let joinSourceCols: readonly string[] | undefined;
			let joinTargetCols: readonly string[] | undefined;
			// sourceAliasForJoin: alias to use on the LEFT side of the JOIN ON.
			// Defaults to the root EXISTS alias; overridden when FK is found on an
			// intermediate table (multi-hop).
			let sourceAliasForJoin: string = targetAlias;

			const model = ctx.model;
			if (model) {
				let rel = null;

				// 1. Try each previously joined table (in insertion order).
				for (const [prevAlias, prevRealTable] of joinedTables) {
					rel = model.getRelation(`${prevRealTable}.${joinRelation}`);
					if (rel) {
						sourceAliasForJoin = prevAlias;
						break;
					}
				}

				// 2. Fallback: root target table.
				if (!rel) {
					rel = model.getRelation(`${targetTable}.${joinRelation}`);
					// sourceAliasForJoin stays as targetAlias (root EXISTS alias)
				}

				if (rel) {
					joinTargetTable = rel.target;
					if (rel.type === 'belongsTo') {
						// FK is on the source side (sourceTable.fkCol → joinTargetTable.id)
						const fk = toColumnList(rel.foreignKey);
						joinSourceCols = fk.length > 0 ? fk : undefined;
						const targetKey = toColumnList(rel.targetKey);
						joinTargetCols =
							targetKey.length > 0
								? targetKey
								: [
										(ctx.defaultPkColumnName as string | undefined) ??
											DEFAULT_PK_COLUMN,
									];
					} else {
						// hasMany/hasOne: FK is on the target side (joinTargetTable.fkCol → sourceTable.id)
						const fk = toColumnList(rel.foreignKey);
						const sourceKey = toColumnList(rel.sourceKey);
						joinSourceCols =
							sourceKey.length > 0
								? sourceKey
								: [
										(ctx.defaultPkColumnName as string | undefined) ??
											DEFAULT_PK_COLUMN,
									];
						joinTargetCols = fk.length > 0 ? fk : undefined;
					}
				}
			}

			// Fall back to FK derivation convention when ModelIR didn't resolve columns.
			if (!joinSourceCols || joinSourceCols.length === 0) {
				// Assume belongsTo: FK on source table = joinRelation + '_id'
				joinSourceCols = [
					(ctx.deriveFkColumnName ?? defaultFkDerivation)(
						joinRelation,
						(ctx.defaultPkColumnName as string | undefined) ??
							DEFAULT_PK_COLUMN,
					),
				];
				joinTargetCols = [
					(ctx.defaultPkColumnName as string | undefined) ?? DEFAULT_PK_COLUMN,
				];
			}

			const joinAlias = joinRelation; // e.g. 'callerFile'
			const joinQuals = buildKeyCorrelation(
				sourceAliasForJoin, // resolved source alias (root or intermediate)
				joinSourceCols,
				joinAlias,
				joinTargetCols,
				ctx,
			);

			const joinType =
				(inc.joinType as string | undefined) === 'left'
					? 'JOIN_LEFT'
					: 'JOIN_INNER';

			const joinRangeVar = rangeVar(
				joinTargetTable,
				joinAlias,
				schemaForExistsFromName(ctx, joinTargetTable),
				ctx.naming,
			);

			// Wrap current fromNode with the new join: JoinExpr { larg: fromNode, rarg: joinRangeVar }
			fromNode = joinExpr(joinType, fromNode, joinRangeVar, joinQuals);

			// Track this join for subsequent iterations (multi-hop resolution).
			joinedTables.set(joinAlias, joinTargetTable);
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
