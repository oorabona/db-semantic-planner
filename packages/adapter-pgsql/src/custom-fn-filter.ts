/** Legacy FILTER lowering, shared without importing the plan compiler. */
import type { WhereIntent } from '@dbsp/types';
import type { JsonAggOrderByEntry } from '@dbsp/types/internal';
import type { Node } from '@pgsql/types';
import {
	defaultFkDerivation,
	type FkColumnDerivation,
} from './assert-field.js';
import { deriveFkColumns } from './handlers/include/shared.js';
import { createWhereDispatcher } from './handlers/index.js';
import type {
	CompilerContext as HandlerCompilerContext,
	CompilerState as HandlerCompilerState,
	Decision as HandlerDecision,
} from './handlers/types.js';
import { convertWhereCondition } from './intent-to-decisions.js';
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
		strategy: (pd.choice === 'subquery'
			? 'json_agg'
			: pd.choice) as HandlerDecision['strategy'],
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
	dispatcher: ReturnType<typeof createWhereDispatcher>,
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

export function buildCustomFnFilter(
	filterIntent: WhereIntent,
	ctx: HandlerCompilerContext,
	state: HandlerCompilerState,
): Node {
	// Fail loud rather than treat "could not lower" as "no filter": a filter that
	// lowers to nothing (a malformed or unsupported condition) must NOT silently
	// drop to an unfiltered aggregate, which would broaden results. An empty or()
	// lowers to FALSE and an empty and() to TRUE, so neither reaches this branch.
	const filterDecision = convertWhereCondition(filterIntent, ctx.rootTable);
	const filterNode = filterDecision
		? compileFilterCondition(
				filterDecision,
				createWhereDispatcher(),
				ctx,
				state,
			)
		: undefined;
	if (!filterNode) {
		throw new Error(
			'fn().filter(): the FILTER (WHERE ...) condition could not be compiled ' +
				'(a malformed or unsupported condition). ' +
				'Provide a concrete filter condition.',
		);
	}
	return filterNode;
}
