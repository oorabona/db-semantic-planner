/** FILTER bridge and legacy decision helpers, without compiler import cycles. */
import type { WhereIntent } from '@dbsp/types';
import type { JsonAggOrderByEntry } from '@dbsp/types/internal';
import type { Node } from '@pgsql/types';
import {
	defaultFkDerivation,
	type FkColumnDerivation,
} from './assert-field.js';
import type { ConditionCompilerCtx } from './condition-context.js';
import { createSubqueryBuilder } from './condition-subquery.js';
import { deriveFkColumns } from './handlers/include/shared.js';
import type {
	CompilerContext as HandlerCompilerContext,
	CompilerState as HandlerCompilerState,
	Decision as HandlerDecision,
} from './handlers/types.js';
import type { PlanDecision, PlanExpressionOrderBy } from './plan-decision.js';

function isJsonAggOrderBy(
	orderBy: PlanDecision['orderBy'],
): orderBy is readonly JsonAggOrderByEntry[] {
	return (
		Array.isArray(orderBy) && orderBy.every((item) => typeof item === 'string')
	);
}

function isExpressionOrderBy(
	orderBy: PlanDecision['orderBy'],
): orderBy is PlanExpressionOrderBy {
	return (
		Array.isArray(orderBy) &&
		orderBy.every(
			(item) =>
				typeof item === 'object' &&
				item !== null &&
				'field' in item &&
				typeof item.field === 'string',
		)
	);
}

/**
 * Recursively map a PlanDecision tree to a HandlerDecision tree.
 *
 * Both types are structurally similar but nominally distinct. This explicit
 * mapper avoids `as unknown as` double casts by doing the conversion
 * field-by-field, including recursive children/conditions.
 */
export function mapToHandlerDecision(
	pd: PlanDecision,
	rootTable: string,
	defaultPk: string,
	deriveFk: FkColumnDerivation,
): HandlerDecision {
	const jsonAggOrderBy = isJsonAggOrderBy(pd.orderBy) ? pd.orderBy : undefined;
	const expressionOrderBy = isExpressionOrderBy(pd.orderBy)
		? pd.orderBy
		: undefined;
	const handlerOrderBy =
		jsonAggOrderBy ??
		expressionOrderBy?.map((o) => ({
			column: o.field,
			direction: (o.direction?.toUpperCase() ?? 'ASC') as 'ASC' | 'DESC',
		}));
	const derivedFkColumns = deriveFkColumns(
		pd,
		pd.sourceTable ?? rootTable,
		defaultPk,
		deriveFk,
	);
	const subqueryOperator = pd.subqueryOperator;
	return {
		type: pd.type,
		table: pd.table,
		column: pd.column ?? pd.field,
		alias: pd.alias,
		operator: pd.operator,
		value: pd.value,
		paramIndex: pd.paramIndex,
		direction: pd.direction,
		joinType: pd.joinType,
		sourceColumn: pd.sourceColumn ?? derivedFkColumns.sourceColumn,
		targetColumn: pd.targetColumn ?? derivedFkColumns.targetColumn,
		targetTable: pd.targetTable,
		function: pd.function,
		distinct: pd.distinct,
		args: pd.args,
		columns: pd.columns,
		values: pd.values,
		set: pd.set,
		limit: pd.limit,
		offset: pd.offset,
		strategy: pd.choice as HandlerDecision['strategy'],
		relation: pd.relation ?? pd.relationName,
		relationName: pd.relationName,
		relationPath: pd.relationPath,
		hydrationPrefix: pd.hydrationPrefix,
		relationType: pd.relationType,
		foreignKey: pd.foreignKey,
		parentKey: pd.parentKey,
		orderByFallback: pd.orderByFallback,
		dataType: pd.dataType,
		traversal: pd.traversal,
		pkColumn: pd.pkColumn,
		fkColumn: pd.fkColumn,
		maxDepth: pd.maxDepth,
		children: pd.children?.map((c) =>
			mapToHandlerDecision(c, pd.targetTable ?? rootTable, defaultPk, deriveFk),
		),
		conditions: pd.conditions?.map((c) =>
			mapToHandlerDecision(c, rootTable, defaultPk, deriveFk),
		),
		include: pd.include?.map((c) =>
			mapToHandlerDecision(c, rootTable, defaultPk, deriveFk),
		),
		orderBy: handlerOrderBy,
		partition: pd.partitionBy,
		jsonPath: pd.jsonPath,
		jsonMode: pd.jsonMode,
		expressionIntent: pd.expressionIntent,
		...(subqueryOperator !== undefined && {
			subqueryOperator,
		}),
		selectColumn: pd.selectColumn,
		aggregate: pd.aggregate,
		aggregateDistinct: pd.aggregateDistinct,
		columnAliases: pd.columnAliases,
		escape: pd.escape,
		subqueryIntent: pd.subqueryIntent,
	} as HandlerDecision;
}

/**
 * Compile an optional filterCondition (PlanDecision) to an AST Node.
 * Used to hydrate filterWhere on aggregate handler decisions.
 */
export function compileFilterCondition(
	filterCondition: PlanDecision | undefined,
	dispatcher: import('./handlers/types.js').WhereDispatcher,
	ctx: HandlerCompilerContext,
	state: HandlerCompilerState,
): import('@pgsql/types').Node | undefined {
	if (!filterCondition) return undefined;
	const mapped = mapToHandlerDecision(
		filterCondition,
		ctx.rootTable,
		ctx.defaultPkColumnName ?? 'id',
		ctx.deriveFkColumnName ?? defaultFkDerivation,
	);
	return dispatcher(mapped, ctx, state);
}

export type FilterConditionCompiler = (
	intent: WhereIntent,
	ctx: ConditionCompilerCtx,
) => Node;

export function buildCustomFnFilter(
	filterIntent: WhereIntent,
	ctx: HandlerCompilerContext,
	state: HandlerCompilerState,
	conditionCompiler: FilterConditionCompiler,
): Node {
	// Fail loud rather than treat "could not lower" as "no filter": a filter that
	// lowers to nothing (a malformed or unsupported condition) must NOT silently
	// drop to an unfiltered aggregate, which would broaden results. An empty or()
	// lowers to FALSE and an empty and() to TRUE, so neither reaches this branch.
	const filterNode = conditionCompiler(filterIntent, {
		logicalSourceTable: ctx.rootTable,
		emittedAlias: ctx.currentAlias ?? ctx.rootTable,
		visibleAliases: new Map(ctx.aliases ?? state.aliases),
		position: 'filter',
		...(ctx.defaultPkColumnName !== undefined && {
			defaultPkColumnName: ctx.defaultPkColumnName,
		}),
		...(ctx.deriveFkColumnName !== undefined && {
			deriveFkColumnName: ctx.deriveFkColumnName,
		}),
		compileExpressionSubquery: ctx.compileSubquery,
		paramState: state,
		...(ctx.model !== undefined && { model: ctx.model }),
		...(ctx.declaredNames !== undefined && {
			declaredNames: ctx.declaredNames,
		}),
		...(ctx.dbCasing !== undefined && { dbCasing: ctx.dbCasing }),
		...(ctx.schema !== undefined && { schemaName: ctx.schema }),
		...(ctx.dialectCapabilities !== undefined && {
			dialectCapabilities: ctx.dialectCapabilities,
		}),
		...(ctx.scope !== undefined && { scope: ctx.scope }),
		...(ctx.currentBinding !== undefined && {
			currentBinding: ctx.currentBinding,
		}),
		...(ctx.relationTargetProjections !== undefined && {
			relationTargetProjections: ctx.relationTargetProjections,
		}),
		...(ctx.aliasColumnAuthorities !== undefined && {
			aliasColumnAuthorities: ctx.aliasColumnAuthorities,
		}),
		...(ctx.outerAlias !== undefined && { outerTable: ctx.outerAlias }),
		compileSubquery: (intent, offset) => {
			return createSubqueryBuilder((innerIntent, inner) =>
				conditionCompiler(innerIntent, {
					...inner,
					logicalSourceTable: inner.rootTable,
					emittedAlias: inner.currentAlias ?? inner.rootTable,
					visibleAliases: inner.aliases,
					position: inner.position ?? 'subquery',
				}),
			)(
				intent,
				offset,
				ctx.declaredNames,
				ctx.schema,
				'rawExists',
				ctx.scope,
				ctx.dialectCapabilities,
				ctx.dbCasing,
			);
		},
	});
	if (!filterNode) {
		throw new Error(
			'fn().filter(): the FILTER (WHERE ...) condition could not be compiled ' +
				'(a malformed or unsupported condition). ' +
				'Provide a concrete filter condition.',
		);
	}
	return filterNode;
}
