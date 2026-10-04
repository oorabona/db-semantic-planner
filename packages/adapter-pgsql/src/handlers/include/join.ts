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

import { type ColumnListInput, toColumnList } from '@dbsp/types';
import type { JoinExpr, Node } from '@pgsql/types';
import { DEFAULT_PK_COLUMN, defaultFkDerivation } from '../../assert-field.js';
import {
	sqlColumnRef,
	sqlColumnRefStar,
	sqlRangeVar,
	sqlResTarget,
} from '../../ast-helpers.js';
import {
	queryScope,
	relationBinding,
	relationBindingFor,
} from '../../binding-registry.js';
import {
	queryScopeForBindingProjections,
	requireRelationTargetColumns,
	resolveRelationTarget,
} from '../../relation-target-projection.js';
import {
	identifierText,
	queryLocal,
	resolveDeclaredIdentifier,
} from '../../sql-identifier.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	IncludeHandler,
	IncludeResult,
} from '../types.js';
import {
	expressionColumnIdentifier,
	expressionQualifiedColumnRef,
	expressionRelationBinding,
} from '../types.js';
import { buildKeyCorrelation } from '../where/exists.js';

/**
 * Build a JOIN expression (LEFT JOIN by default, INNER JOIN when joinType='inner').
 */
function buildJoin(
	targetTable: string,
	targetAlias: string,
	sourceAlias: string,
	sourceColumn: ColumnListInput,
	targetColumn: ColumnListInput,
	ctx: CompilerContext,
	joinType: 'inner' | 'left' = 'left',
): { JoinExpr: JoinExpr } {
	// Build the join condition: source.sourceColumn = target.targetColumn
	const joinCondition = buildKeyCorrelation(
		sourceAlias,
		sourceColumn,
		targetAlias,
		targetColumn,
		ctx,
	);

	const joinExpr: JoinExpr = {
		jointype: joinType === 'inner' ? 'JOIN_INNER' : 'JOIN_LEFT',
		rarg: sqlRangeVar(
			resolveRelationTarget(queryLocal(targetTable), ctx).cteName ??
				resolveDeclaredIdentifier(
					ctx.declaredNames,
					ctx.dbCasing ?? 'preserve',
					{
						kind: 'table',
						table: targetTable,
					},
				),
			queryLocal(targetAlias),
			resolveRelationTarget(queryLocal(targetTable), ctx).cteName ===
				undefined && ctx.schema !== undefined
				? queryLocal(ctx.schema)
				: undefined,
		),
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
 * To-many nested includes are refused before handler dispatch; NQL flat remains a rowset.
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
		const sourceColumn = toColumnList(decision.sourceColumn);
		const columns = decision.columns;
		if (sourceColumn.length === 0) {
			throw new Error("Missing required column 'sourceColumn' in JOIN include");
		}
		const targetColumn = decision.targetColumn ?? [
			(ctx.deriveFkColumnName ?? defaultFkDerivation)(
				ctx.rootTable,
				ctx.defaultPkColumnName ?? DEFAULT_PK_COLUMN,
			),
		];
		const target = resolveRelationTarget(queryLocal(targetTable), ctx);
		requireRelationTargetColumns(
			target,
			toColumnList(targetColumn).map(queryLocal),
			'join key',
			relation,
		);
		if (columns) {
			requireRelationTargetColumns(
				target,
				columns.filter((column) => column !== '*').map(queryLocal),
				'selected column',
				relation,
			);
		}

		// Build the JOIN (LEFT or INNER based on decision.joinType)
		const targetBinding = relationBinding({
			qualifier: queryLocal(targetAlias),
			kind: 'declared-table',
			logicalTable: targetTable,
		});
		const scopedCtx: CompilerContext = {
			...ctx,
			scope: queryScope([
				...((
					ctx.scope ??
					queryScopeForBindingProjections(
						ctx.bindingNames,
						ctx.relationTargetProjections,
					)
				)?.bindings.values() ?? []),
				...(relationBindingFor(ctx.scope, targetBinding.qualifier) === undefined
					? [targetBinding]
					: []),
			]),
		};
		const join = buildJoin(
			targetTable,
			targetAlias,
			sourceAlias,
			sourceColumn,
			targetColumn,
			scopedCtx,
			decision.joinType ?? 'left',
		);

		// Build column targets with output aliases for hydration.
		// Prefer user-supplied alias from columnAliases; fall back to
		// the "relation.column" convention used by the hydration layer.
		const targets: Node[] = [];
		const columnAliases = decision.columnAliases;
		const hydrationPrefix = decision.hydrationPrefix ?? relation ?? targetAlias;
		if (columns && columns.length > 0) {
			if (columns.length === 1 && columns[0] === '*') {
				// Wildcard: select all columns from the joined relation
				targets.push(sqlResTarget(sqlColumnRefStar(queryLocal(targetAlias))));
			} else {
				for (const col of columns) {
					const outputAlias =
						columnAliases?.[col] ?? `${hydrationPrefix}.${col}`;
					targets.push(
						sqlResTarget(
							expressionQualifiedColumnRef(col, targetAlias, scopedCtx),
							queryLocal(outputAlias),
						),
					);
				}
			}
		}

		if (decision.payloadShape) {
			targets.splice(
				0,
				targets.length,
				...decision.payloadShape.columns.map((column) =>
					sqlResTarget(
						sqlColumnRef(
							queryLocal(column.physicalName),
							queryLocal(targetAlias),
						),
						queryLocal(column.outputLabel),
					),
				),
			);
		}
		const presence = decision.payloadShape?.presence;
		if (presence) {
			if (!presence.physicalName) {
				const expr = join.JoinExpr;
				expr.rarg = {
					RangeSubselect: {
						subquery: {
							SelectStmt: {
								targetList: [
									...Array.from(
										new Set([
											...toColumnList(targetColumn).map((column) =>
												identifierText(
													expressionColumnIdentifier(
														column,
														expressionRelationBinding(targetAlias, scopedCtx),
														scopedCtx.declaredNames,
														scopedCtx.dbCasing,
													),
												),
											),
											...decision.payloadShape!.columns.map(
												(column) => column.physicalName,
											),
										]),
										(column) =>
											sqlResTarget(
												sqlColumnRef(
													queryLocal(column),
													queryLocal(targetAlias),
												),
											),
									),
									sqlResTarget(
										{ A_Const: { ival: { ival: 1 } } },
										queryLocal(presence.outputLabel),
									),
								],
								fromClause: [expr.rarg!],
							},
						},
						alias: { aliasname: targetAlias },
					},
				};
			}
			targets.push(
				sqlResTarget(
					sqlColumnRef(
						queryLocal(presence.physicalName ?? presence.outputLabel),
						queryLocal(targetAlias),
					),
					queryLocal(presence.outputLabel),
				),
			);
		}
		return {
			join,
			...(targets.length > 0 && { targets }),
		};
	},
};
