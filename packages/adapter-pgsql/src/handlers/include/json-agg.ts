/**
 * JSON_AGG Include Strategy Handler
 *
 * Implements the 'json_agg' include strategy using PostgreSQL's json_agg.
 * Uses to_jsonb(__t__) for wildcard row selection, with recursive nesting
 * via jsonb_build_object merge for child relations.
 *
 * Produces: COALESCE((SELECT json_agg(to_jsonb(__t__) [|| jsonb_build_object(...)] ORDER BY __t__.pk ASC NULLS LAST) FROM target AS __t__ WHERE ...), '[]'::json) AS relation
 */

import { resolveOutputReadHandling, toColumnList } from '@dbsp/types';
import type { Node } from '@pgsql/types';
import {
	andExpr,
	sqlColumnRef,
	sqlJsonAggSubquery,
	typeCast,
} from '../../ast-helpers.js';
import { queryScope, relationBinding } from '../../binding-registry.js';
import {
	jsonAggContainerShape,
	resolveJsonAggColumnReadHandling,
} from '../../json-agg-read-handling.js';
import {
	assertProjectedJsonContainerCanBeAggregated,
	bindAliasAuthority,
	emittedColumnReference,
	queryScopeForBindingProjections,
	requireEmittedRelationTargetColumn,
	requireRelationTargetColumn,
	requireRelationTargetColumns,
	resolveRelationTarget,
} from '../../relation-target-projection.js';
import {
	identifierText,
	queryLocal,
	resolveDeclaredIdentifier,
	type SqlIdentifier,
} from '../../sql-identifier.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	IncludeHandler,
	IncludeResult,
	ResTargetNode,
} from '../types.js';
import { buildKeyCorrelation } from '../where/exists.js';
import { deriveFkColumns, resolveIncludeOrder } from './shared.js';

// NQL compile-select.ts labels unaliased relation columns `${relationPath}.${column}`.
// ORM relationColumn aliases must be identifiers, so a dotted default label cannot
// be a chosen ORM alias and must not become a nested JSON key.
export function chosenRelationColumnAlias(
	relationPath: string,
	column: string,
	alias: string | undefined,
): string | undefined {
	return alias === `${relationPath}.${column}` ? undefined : alias;
}

function resolveJsonAggProjection(
	decision: Decision,
	targetTable: string,
	ctx: CompilerContext,
	shape: ReturnType<typeof jsonAggContainerShape>,
): readonly SqlIdentifier[] | undefined {
	const requested = decision.columns;
	const hasExplicitProjection =
		requested !== undefined &&
		(requested.length > 0 || decision.emptyProjection === true) &&
		!(requested.length === 1 && requested[0] === '*');
	const target = resolveRelationTarget(queryLocal(targetTable), ctx);
	if (hasExplicitProjection) {
		return requested.map((column) =>
			column === '*'
				? queryLocal(column)
				: (requireRelationTargetColumn(
						target,
						queryLocal(column),
						'selected column',
						decision.relation,
					)?.outputKey ??
					resolveDeclaredIdentifier(
						ctx.declaredNames,
						ctx.dbCasing ?? 'preserve',
						{
							kind: 'column',
							table: targetTable,
							column,
						},
					)),
		);
	}
	if (target.outputs !== undefined) {
		// Preserve the historical to_jsonb(alias) SQL for a full physical-table
		// projection.  A reduced CTE must be explicit so PostgreSQL cannot expose
		// columns the CTE did not produce.
		const physical = ctx.model?.getTable(targetTable);
		const physicalKeys = new Set(
			physical?.columns.map((column) =>
				resolveDeclaredIdentifier(
					ctx.declaredNames,
					ctx.dbCasing ?? 'preserve',
					{
						kind: 'column',
						table: targetTable,
						column: column.name,
					},
				),
			),
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
		if (!isFullPhysicalProjection)
			return [...target.outputs.keys()].map(queryLocal);
	}

	const table = ctx.model?.getTable(targetTable);
	const needsExplicitProjection =
		table?.columns.some(
			(column) =>
				resolveJsonAggColumnReadHandling(targetTable, column, shape) !==
				undefined,
		) ?? false;
	if (!needsExplicitProjection || !table) return requested?.map(queryLocal);
	return table.columns.map((column) =>
		resolveDeclaredIdentifier(ctx.declaredNames, ctx.dbCasing ?? 'preserve', {
			kind: 'column',
			table: targetTable,
			column: column.name,
		}),
	);
}

function buildJsonAggColumnValueOverrides(
	targetTable: string,
	columns: readonly SqlIdentifier[] | undefined,
	innerAlias: string,
	ctx: CompilerContext,
	shape: ReturnType<typeof jsonAggContainerShape>,
): ReadonlyMap<string, Node> | undefined {
	if (
		!columns ||
		columns.length === 0 ||
		(columns.length === 1 && identifierText(columns[0]!) === '*')
	)
		return undefined;
	const target = resolveRelationTarget(queryLocal(targetTable), ctx);
	if (target.outputs !== undefined) {
		const overrides = new Map<string, Node>();
		for (const columnName of columns) {
			if (identifierText(columnName) === '*') continue;
			// `columns` comes from the target projection here, so its keys are
			// already emitted SQL identifiers rather than logical input names.
			const emittedColumn = emittedColumnReference(
				queryLocal(identifierText(columnName)),
			);
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
					identifierText(columnName),
					typeCast(sqlColumnRef(columnName, queryLocal(innerAlias)), 'text'),
				);
			}
		}
		return overrides.size > 0 ? overrides : undefined;
	}
	const table = ctx.model?.getTable(targetTable);
	if (!table) return undefined;
	const overrides = new Map<string, Node>();
	for (const columnName of columns) {
		const logicalColumn =
			ctx.declaredNames?.logicalColumn(
				targetTable,
				identifierText(columnName),
			) ?? identifierText(columnName);
		const column = table.columns.find(
			(candidate) => candidate.name === logicalColumn,
		);
		if (
			!column ||
			resolveJsonAggColumnReadHandling(targetTable, column, shape) === undefined
		) {
			continue;
		}
		overrides.set(
			identifierText(columnName),
			typeCast(sqlColumnRef(columnName, queryLocal(innerAlias)), 'text'),
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

	if (
		decision.includeSelectForm !== undefined &&
		decision.includeSelectForm !== 'fields' &&
		decision.includeSelectForm !== 'all'
	) {
		throw new Error(
			`JSON_AGG include '${relation}' does not support select form '${decision.includeSelectForm}'`,
		);
	}

	// Build correlation WHERE based on relation type
	const { sourceColumn, targetColumn } = deriveFkColumns(
		decision,
		parentAlias,
		ctx.defaultPkColumnName,
		ctx.deriveFkColumnName,
	);
	// Planner include decisions created before the typed boundary can carry an
	// already-rendered FK spelling. The ModelIR relation remains the declared
	// address, so use it for the correlation when present.
	const declaredRelation = ctx.model?.getRelation(
		`${(decision as { sourceTable?: string }).sourceTable ?? ctx.rootTable}.${relation}`,
	);
	const resolvedTargetColumn =
		declaredRelation?.type === 'belongsTo'
			? toColumnList(declaredRelation.targetKey).length > 0
				? declaredRelation.targetKey
				: targetColumn
			: toColumnList(declaredRelation?.foreignKey).length > 0
				? declaredRelation!.foreignKey
				: targetColumn;
	const sourceTarget = resolveRelationTarget(queryLocal(targetTable), ctx);
	// Preserve the container-conversion refusal before validating correlation
	// keys: its diagnostic is more specific for a projected JSON output.
	for (const column of decision.columns ?? []) {
		if (column === '*') continue;
		const descriptor = requireRelationTargetColumn(
			sourceTarget,
			queryLocal(column),
			'selected column',
			relation,
		);
		if (descriptor)
			assertProjectedJsonContainerCanBeAggregated(sourceTarget, descriptor);
	}
	// A CTE target owns only its declared projection. Reject a missing join key
	// before an inner alias can obscure the relation and its available outputs.
	requireRelationTargetColumns(
		sourceTarget,
		toColumnList(resolvedTargetColumn).map(queryLocal),
		'column reference',
		relation,
	);
	const innerCtx: CompilerContext = {
		...ctx,
		rootTable: targetTable,
		currentAlias: innerAlias,
		outerAlias: parentAlias,
		aliasColumnAuthorities: bindAliasAuthority(
			ctx.aliasColumnAuthorities,
			queryLocal(innerAlias),
			resolveRelationTarget(queryLocal(targetTable), ctx),
		),
		scope: queryScope([
			...((
				ctx.scope ??
				queryScopeForBindingProjections(
					ctx.bindingNames,
					ctx.relationTargetProjections,
				)
			)?.bindings.values() ?? []),
			relationBinding({
				qualifier: queryLocal(innerAlias),
				kind: 'declared-table',
				logicalTable: targetTable,
			}),
		]),
	};
	let whereExpr: Node = buildKeyCorrelation(
		innerAlias,
		resolvedTargetColumn,
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
	let childNodes: { key: SqlIdentifier; node: Node }[] | undefined;
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
						key: queryLocal(childRelation),
						node: resTarget.ResTarget.val,
					});
				}
			}
		}
		if (childNodes.length === 0) childNodes = undefined;
	}

	const limit = typeof decision.limit === 'number' ? decision.limit : undefined;
	const resolvedOrder = resolveIncludeOrder(decision, targetTable, innerCtx);
	const limitedOrder = resolvedOrder.entries;

	const resolvedTarget = resolveRelationTarget(
		queryLocal(targetTable),
		innerCtx,
	);
	const shape = jsonAggContainerShape(decision.relationType);
	let columns = resolveJsonAggProjection(
		decision,
		targetTable,
		innerCtx,
		shape,
	);
	let columnValueOverrides = buildJsonAggColumnValueOverrides(
		targetTable,
		columns,
		innerAlias,
		innerCtx,
		shape,
	);

	if (decision.columnAliases && columns) {
		const values = new Map<string, Node>();
		columns = columns.map((column, index) => {
			const requested = decision.columns?.[index];
			const alias = requested
				? chosenRelationColumnAlias(
						decision.relationPath ?? relation,
						requested,
						decision.columnAliases?.[requested],
					)
				: undefined;
			const key = identifierText(column);
			const output = alias ?? key;
			values.set(
				output,
				columnValueOverrides?.get(key) ??
					sqlColumnRef(column, queryLocal(innerAlias)),
			);
			return alias ? queryLocal(alias) : column;
		});
		columnValueOverrides = values;
	}

	// Child relation values and projected columns share one JSON object.
	const projectedKeyNames =
		columns && !columns.some((column) => identifierText(column) === '*')
			? columns.map(identifierText)
			: resolvedTarget.outputs !== undefined
				? [...resolvedTarget.outputs.keys()]
				: (ctx.model?.getTable(targetTable)?.columns ?? []).map((column) =>
						identifierText(
							resolveDeclaredIdentifier(
								ctx.declaredNames,
								ctx.dbCasing ?? 'preserve',
								{
									kind: 'column',
									table: targetTable,
									column: column.name,
								},
							),
						),
					);
	const projectedKeys = new Set<string>();
	for (const key of projectedKeyNames) {
		if (projectedKeys.has(key)) {
			throw new Error(
				`JSON_AGG relation projection '${decision.relationPath ?? relation}' has conflicting output key '${key}'.`,
			);
		}
		projectedKeys.add(key);
	}
	for (const child of childNodes ?? []) {
		const key = identifierText(child.key);
		if (projectedKeys.has(key)) {
			throw new Error(
				`JSON_AGG relation projection '${decision.relationPath ?? relation}' has conflicting output key '${key}'.`,
			);
		}
	}

	return sqlJsonAggSubquery(
		resolvedTarget.cteName ??
			resolveDeclaredIdentifier(ctx.declaredNames, ctx.dbCasing ?? 'preserve', {
				kind: 'table',
				table: targetTable,
			}),
		whereExpr,
		queryLocal(`${relation}_json`),
		resolvedTarget.cteName === undefined && ctx.schema !== undefined
			? queryLocal(ctx.schema)
			: undefined,
		{
			...(childNodes && { childNodes }),
			innerAlias: queryLocal(innerAlias),
			...(limit !== undefined && { limit }),
			...(columns && { columns }),
			...(decision.emptyProjection && { emptyProjection: true }),
			...(columnValueOverrides && { columnValueOverrides }),
			...(limitedOrder && {
				limitedOrder: limitedOrder.map((entry) => ({
					column:
						requireRelationTargetColumn(
							resolvedTarget,
							queryLocal(entry.field),
							'order key',
							relation,
						)?.outputKey ??
						resolveDeclaredIdentifier(
							innerCtx.declaredNames,
							innerCtx.dbCasing ?? 'preserve',
							{ kind: 'column', table: targetTable, column: entry.field },
						),
					direction: entry.direction,
					nulls: entry.nulls,
				})),
			}),
			...(resolvedOrder.fallback && { orderByFallback: true }),
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
