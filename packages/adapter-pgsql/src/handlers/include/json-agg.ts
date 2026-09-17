/**
 * JSON_AGG Include Strategy Handler
 *
 * Implements the 'json_agg' include strategy using PostgreSQL's json_agg.
 * Uses to_jsonb(__t__) for wildcard row selection, with recursive nesting
 * via jsonb_build_object merge for child relations.
 *
 * Produces: COALESCE((SELECT json_agg(to_jsonb(__t__) [|| jsonb_build_object(...)] ORDER BY __t__.pk ASC NULLS LAST) FROM target AS __t__ WHERE ...), '[]'::json) AS relation
 */

import {
	type JsonAggOrderByEntry,
	resolveJsonAggOrderKey,
	resolveOutputReadHandling,
} from '@dbsp/types';
import type { Node } from '@pgsql/types';
import {
	andExpr,
	columnRef,
	jsonAggSubquery,
	typeCast,
} from '../../ast-helpers.js';
import { schemaForFromName } from '../../binding-registry.js';
import {
	jsonAggContainerShape,
	resolveJsonAggColumnReadHandling,
} from '../../json-agg-read-handling.js';
import {
	assertProjectedJsonContainerCanBeAggregated,
	bindAliasAuthority,
	emittedColumnReference,
	requireEmittedRelationTargetColumn,
	requireRelationTargetColumn,
	requireRelationTargetColumns,
	resolveRelationTarget,
} from '../../relation-target-projection.js';
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

function resolveJsonAggProjection(
	decision: Decision,
	targetTable: string,
	ctx: CompilerContext,
	shape: ReturnType<typeof jsonAggContainerShape>,
): readonly string[] | undefined {
	const requested = decision.columns;
	const hasExplicitProjection =
		requested &&
		requested.length > 0 &&
		!(requested.length === 1 && requested[0] === '*');
	const target = resolveRelationTarget(targetTable, ctx);
	if (hasExplicitProjection) {
		return requested.map((column) =>
			column === '*'
				? column
				: (requireRelationTargetColumn(
						target,
						column,
						ctx,
						'selected column',
						decision.relation,
					)?.outputKey ?? ctx.naming.toDatabase(column)),
		);
	}
	if (target.outputs !== undefined) {
		// Preserve the historical to_jsonb(alias) SQL for a full physical-table
		// projection.  A reduced CTE must be explicit so PostgreSQL cannot expose
		// columns the CTE did not produce.
		const physical = ctx.model?.getTable(targetTable);
		const physicalKeys = new Set(
			physical?.columns.map((column) => ctx.naming.toDatabase(column.name)),
		);
		const isFullPhysicalProjection =
			physical !== undefined &&
			target.outputs.size === physicalKeys.size &&
			[...physicalKeys].every((column) => {
				const descriptor = target.outputs?.get(column);
				return (
					descriptor !== undefined && descriptor.source.kind !== 'ambiguous'
				);
			});
		if (!isFullPhysicalProjection) return [...target.outputs.keys()];
	}

	const table = ctx.model?.getTable(targetTable);
	const needsExplicitProjection =
		table?.columns.some(
			(column) =>
				resolveJsonAggColumnReadHandling(targetTable, column, shape) !==
				undefined,
		) ?? false;
	if (!needsExplicitProjection || !table) return requested;
	return table.columns.map((column) => column.name);
}

function buildJsonAggColumnValueOverrides(
	targetTable: string,
	columns: readonly string[] | undefined,
	innerAlias: string,
	ctx: CompilerContext,
	shape: ReturnType<typeof jsonAggContainerShape>,
): ReadonlyMap<string, Node> | undefined {
	if (
		!columns ||
		columns.length === 0 ||
		(columns.length === 1 && columns[0] === '*')
	)
		return undefined;
	const target = resolveRelationTarget(targetTable, ctx);
	if (target.outputs !== undefined) {
		const overrides = new Map<string, Node>();
		for (const columnName of columns) {
			if (columnName === '*') continue;
			// `columns` comes from the target projection here, so its keys are
			// already emitted SQL identifiers rather than logical input names.
			const emittedColumn = emittedColumnReference(columnName);
			const descriptor = requireEmittedRelationTargetColumn(
				target,
				emittedColumn,
				'selected column',
				undefined,
			);
			if (descriptor) {
				assertProjectedJsonContainerCanBeAggregated(target, descriptor);
			}
			if (descriptor && resolveOutputReadHandling(descriptor).kind !== 'none') {
				overrides.set(
					columnName,
					typeCast(
						columnRef(
							emittedColumn,
							innerAlias,
							undefined,
							ctx.naming,
							ctx.aliasColumnAuthorities,
						),
						'text',
					),
				);
			}
		}
		return overrides.size > 0 ? overrides : undefined;
	}
	const table = ctx.model?.getTable(targetTable);
	if (!table) return undefined;
	const overrides = new Map<string, Node>();
	for (const columnName of columns) {
		const column = table.columns.find(
			(candidate) => candidate.name === columnName,
		);
		if (
			!column ||
			resolveJsonAggColumnReadHandling(targetTable, column, shape) === undefined
		) {
			continue;
		}
		overrides.set(
			columnName,
			typeCast(
				columnRef(
					columnName,
					innerAlias,
					undefined,
					ctx.naming,
					ctx.aliasColumnAuthorities,
				),
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
	const innerCtx: CompilerContext = {
		...ctx,
		rootTable: targetTable,
		currentAlias: innerAlias,
		outerAlias: parentAlias,
		aliasColumnAuthorities: bindAliasAuthority(
			ctx.aliasColumnAuthorities,
			innerAlias,
			resolveRelationTarget(targetTable, ctx),
			ctx,
		),
	};
	let whereExpr: Node = buildKeyCorrelation(
		innerAlias,
		targetColumn,
		parentAlias,
		sourceColumn,
		innerCtx,
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
					innerCtx,
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
	const orderBy = resolveJsonAggOrderBy(decision, targetTable, innerCtx);
	const resolvedTarget = resolveRelationTarget(targetTable, innerCtx);
	if (orderBy) {
		requireRelationTargetColumns(
			resolvedTarget,
			orderBy.columns,
			innerCtx,
			'order key',
			relation,
		);
	}
	const shape = jsonAggContainerShape(decision.relationType);
	const columns = resolveJsonAggProjection(
		decision,
		targetTable,
		innerCtx,
		shape,
	);
	const columnValueOverrides = buildJsonAggColumnValueOverrides(
		targetTable,
		columns,
		innerAlias,
		innerCtx,
		shape,
	);

	return jsonAggSubquery(
		targetTable,
		whereExpr,
		`${relation}_json`,
		schemaForFromName(ctx.schema, targetTable, ctx.bindingNames, ctx.naming),
		ctx.naming,
		{
			...(childNodes && { childNodes }),
			innerAlias,
			...(limit !== undefined && { limit }),
			...(columns && { columns }),
			...(resolvedTarget.outputs !== undefined && { columnsAreEmitted: true }),
			...(innerCtx.aliasColumnAuthorities !== undefined && {
				aliasColumnAuthorities: innerCtx.aliasColumnAuthorities,
			}),
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
