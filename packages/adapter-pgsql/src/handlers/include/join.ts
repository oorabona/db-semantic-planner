import { andExpr } from '../../ast-helpers.js';
import { compileResolvedCondition } from '../../resolved-condition-compiler.js';
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
import type {
	ColumnRef,
	JoinExpr,
	Node,
	ResTarget,
	SelectStmt,
} from '@pgsql/types';
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
import { queryLocal, resolveDeclaredIdentifier } from '../../sql-identifier.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	IncludeHandler,
	IncludeResult,
} from '../types.js';
import { expressionQualifiedColumnRef } from '../types.js';
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
		state: CompilerState,
	): IncludeResult {
		const relation = decision.relation;
		const targetTable = decision.targetTable ?? relation;

		if (!targetTable) {
			throw new Error('JOIN include requires targetTable');
		}

		// Use relationName as alias for uniqueness
		// (e.g., "author" and "editor" both from "users")
		const targetAlias =
			decision.resolvedInclude?.targetRange.alias ?? relation ?? targetTable;
		const sourceAlias = ctx.currentAlias ?? ctx.rootTable;
		const sourceColumn = toColumnList(decision.sourceColumn);
		const columns = decision.columns;
		if (sourceColumn.length === 0) {
			throw new Error("Missing required column 'sourceColumn' in JOIN include");
		}
		const targetColumn = decision.targetColumn;
		if (!targetColumn)
			throw new Error("Missing required column 'targetColumn' in join include");
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

		const defaultFilter = decision.resolvedInclude?.defaultFilter;
		if (defaultFilter)
			join.JoinExpr.quals = andExpr(
				join.JoinExpr.quals!,
				compileResolvedCondition(defaultFilter, scopedCtx, state),
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
				// The wrapper exposes only columns used outside it, plus its marker.
				const required = new Set(toColumnList(targetColumn));
				for (const column of decision.payloadShape?.columns ?? [])
					required.add(column.logicalName);
				const expr = join.JoinExpr;
				expr.rarg = {
					RangeSubselect: {
						subquery: {
							SelectStmt: {
								targetList: [
									...Array.from(required, (column) =>
										sqlResTarget(
											expressionQualifiedColumnRef(
												column,
												targetAlias,
												scopedCtx,
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

/** Finish keyless wrappers from emitted SQL references, including expressions and ordering. */
export function completeKeylessJoinProjection(
	targets: Node[],
	alias: string,
	nodes: readonly unknown[],
	includeWhere = false,
): void {
	completeKeylessJoinProjections(
		new Map([[alias, targets]]),
		nodes,
		includeWhere,
	);
}

/** Discover references once for all keyless include wrappers in a query. */
export function completeKeylessJoinProjections(
	projections: ReadonlyMap<string, Node[]>,
	nodes: readonly unknown[],
	includeWhere = false,
): void {
	if (projections.size === 0) return;
	const fieldName = (field: Node | undefined): string | undefined =>
		field && 'String' in field ? field.String.sval : undefined;
	const entries = new Map(
		[...projections].map(([alias, targets]) => {
			const last = targets.at(-1);
			return [
				alias,
				{
					targets,
					marker: last && 'ResTarget' in last ? last.ResTarget.name : undefined,
					projected: new Set(
						targets.map((target) => {
							const value = (target as { ResTarget?: ResTarget }).ResTarget
								?.val;
							return value && 'ColumnRef' in value
								? fieldName(value.ColumnRef.fields?.at(-1))
								: undefined;
						}),
					),
				},
			];
		}),
	);
	const bindings = (node: unknown, aliases: Set<string>): void => {
		if (!node || typeof node !== 'object') return;
		if (Array.isArray(node)) {
			for (const child of node) bindings(child, aliases);
			return;
		}
		const record = node as Record<string, unknown>;
		for (const kind of [
			'RangeVar',
			'RangeSubselect',
			'RangeFunction',
			'JoinExpr',
		]) {
			const binding = record[kind] as
				| {
						alias?: { aliasname?: string };
						relname?: string;
						larg?: unknown;
						rarg?: unknown;
				  }
				| undefined;
			if (!binding) continue;
			const name = binding.alias?.aliasname ?? binding.relname;
			if (name) aliases.add(name);
			if (kind === 'JoinExpr') {
				bindings(binding.larg, aliases);
				bindings(binding.rarg, aliases);
			}
		}
	};
	const visit = (node: unknown, hidden: ReadonlySet<string>): void => {
		if (!node || typeof node !== 'object') return;
		if (Array.isArray(node)) {
			for (const child of node) visit(child, hidden);
			return;
		}
		const ast = node as { SelectStmt?: SelectStmt; ColumnRef?: ColumnRef };
		if (ast.SelectStmt) {
			if (includeWhere) return;
			const scoped = new Set(hidden);
			bindings(ast.SelectStmt.fromClause, scoped);
			for (const child of Object.values(ast.SelectStmt)) visit(child, scoped);
			return;
		}
		const fields = ast.ColumnRef?.fields;
		const unqualified = includeWhere && fields?.length === 1;
		const alias = unqualified
			? projections.keys().next().value
			: fields && fieldName(fields[0]);
		const entry = alias && !hidden.has(alias) ? entries.get(alias) : undefined;
		const column = fieldName(fields?.[unqualified ? 0 : 1]);
		if (
			alias &&
			entry &&
			(unqualified || fields?.length === 2) &&
			column &&
			column !== entry.marker &&
			!entry.projected.has(column)
		) {
			entry.projected.add(column);
			entry.targets.splice(
				entry.targets.length - 1,
				0,
				sqlResTarget(sqlColumnRef(queryLocal(column), queryLocal(alias))),
			);
		}
		for (const child of Object.values(node)) visit(child, hidden);
	};
	for (const node of nodes) visit(node, new Set());
}
