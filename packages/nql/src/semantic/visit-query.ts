// @ts-nocheck — Chevrotain CST visitor: ctx.rule properties guaranteed present
/* biome-ignore-all lint/style/noNonNullAssertion: Chevrotain CST access requires non-null assertions on ctx.rule[0] patterns */
/**
 * @module semantic/visit-query
 * Query structure visitors: program, statement, query, clauses, select, order, join, params.
 */

import type {
	NqlClause,
	NqlExpression,
	NqlJoinParam,
	NqlJoinSpec,
	NqlLockClause,
	NqlOrderItem,
	NqlProgram,
	NqlQuery,
	NqlSelectItem,
	NqlSetClause,
	NqlStatement,
} from '../parser/ast.js';
import type { CstContext, VisitFn } from './helpers.js';
import {
	asCstNode,
	getImage,
	requireFields,
	requireFirst,
	unreachable,
} from './helpers.js';

export function visitProgram(ctx: CstContext, visit: VisitFn): NqlProgram {
	const statements: NqlStatement[] = [];
	if (ctx.statement) {
		for (const stmtCtx of ctx.statement) {
			statements.push(visit(asCstNode(stmtCtx)));
		}
	}
	return { type: 'program', statements };
}

export function visitStatement(ctx: CstContext, visit: VisitFn): NqlStatement {
	if (ctx.withQuery) return visit(asCstNode(ctx.withQuery[0]!));
	if (ctx.query) return visit(asCstNode(ctx.query[0]!));
	if (ctx.mutationPipeline) return visit(asCstNode(ctx.mutationPipeline[0]!));
	/* v8 ignore next — defensive: parser guarantees withQuery, query, or mutationPipeline -- @preserve */
	unreachable('Invalid statement');
}

export function visitQuery(ctx: CstContext, visit: VisitFn): NqlQuery {
	requireFirst(ctx, 'tableRef', 'Query missing table');
	const table = visit(asCstNode(ctx.tableRef[0]!));
	const clauses: NqlClause[] = [];
	if (ctx.queryClause) {
		for (const clauseCtx of ctx.queryClause) {
			clauses.push(visit(asCstNode(clauseCtx)));
		}
	}
	return { type: 'query', table, clauses };
}

export function visitTableRef(ctx: CstContext, visit: VisitFn): string {
	requireFirst(ctx, 'identSegment', 'Table ref missing identifier');
	return visit(asCstNode(ctx.identSegment[0]!));
}

export function visitQueryClause(ctx: CstContext, visit: VisitFn): NqlClause {
	if (ctx.whereClause) return visit(asCstNode(ctx.whereClause[0]!));
	if (ctx.selectClause) return visit(asCstNode(ctx.selectClause[0]!));
	if (ctx.flatClause) return visit(asCstNode(ctx.flatClause[0]!));
	if (ctx.groupClause) return visit(asCstNode(ctx.groupClause[0]!));
	if (ctx.orderClause) return visit(asCstNode(ctx.orderClause[0]!));
	if (ctx.limitClause) return visit(asCstNode(ctx.limitClause[0]!));
	if (ctx.offsetClause) return visit(asCstNode(ctx.offsetClause[0]!));
	if (ctx.setClause) return visit(asCstNode(ctx.setClause[0]!));
	if (ctx.bindClause) return visit(asCstNode(ctx.bindClause[0]!));
	if (ctx.lockClause) return visit(asCstNode(ctx.lockClause[0]!));
	/* v8 ignore next — defensive: parser guarantees one of the clause alternatives -- @preserve */
	unreachable('Unknown query clause');
}

export function visitWhereClause(ctx: CstContext, visit: VisitFn): NqlClause {
	requireFirst(ctx, 'booleanExpr', 'Where clause missing expression');
	return {
		type: 'where',
		condition: visit(asCstNode(ctx.booleanExpr[0]!)),
	};
}

export function visitSelectClause(ctx: CstContext, visit: VisitFn): NqlClause {
	const distinct = !!ctx.Distinct;
	const items: NqlSelectItem[] = [];
	if (ctx.selectList) {
		const listItems = visit(asCstNode(ctx.selectList[0]!)) as NqlSelectItem[];
		items.push(...listItems);
	}
	return { type: 'select', distinct, items };
}

export function visitFlatClause(): NqlClause {
	return { type: 'flat' };
}

export function visitGroupClause(ctx: CstContext, visit: VisitFn): NqlClause {
	const expressions: NqlExpression[] = [];
	if (ctx.exprList) {
		const exprs = visit(asCstNode(ctx.exprList[0]!)) as NqlExpression[];
		expressions.push(...exprs);
	}
	return { type: 'groupBy', expressions };
}

export function visitOrderClause(ctx: CstContext, visit: VisitFn): NqlClause {
	const items: NqlOrderItem[] = [];
	if (ctx.orderList) {
		const orderItems = visit(asCstNode(ctx.orderList[0]!)) as NqlOrderItem[];
		items.push(...orderItems);
	}
	return { type: 'orderBy', items };
}

export function visitLimitClause(ctx: CstContext, visit: VisitFn): NqlClause {
	requireFirst(ctx, 'NumberLiteral', 'Limit clause missing number');
	const count = parseInt(getImage(ctx.NumberLiteral[0]!), 10);
	const segments = ctx.identSegment;
	if (segments && segments.length > 0) {
		const parts: string[] = [];
		for (const seg of segments) {
			parts.push(visit(asCstNode(seg)));
		}
		return { type: 'limit', count, relation: parts.join('.') };
	}
	return { type: 'limit', count };
}

export function visitOffsetClause(ctx: CstContext): NqlClause {
	requireFirst(ctx, 'NumberLiteral', 'Offset clause missing number');
	return {
		type: 'offset',
		count: parseInt(getImage(ctx.NumberLiteral[0]!), 10),
	};
}

export function visitJoinSpec(ctx: CstContext, visit: VisitFn): NqlJoinSpec {
	requireFirst(ctx, 'identSegment', 'Join spec missing relation');
	const relation = visit(asCstNode(ctx.identSegment[0]!));
	let via: string | undefined;
	let condition: NqlExpression | undefined;
	let params: NqlJoinParam[] | undefined;

	if (ctx.Via && ctx.identSegment.length > 1) {
		via = visit(asCstNode(ctx.identSegment[1]!));
	}
	/* v8 ignore start — not yet reachable: JOIN params not exposed in current grammar -- @preserve */
	if (ctx.paramList) {
		params = visit(asCstNode(ctx.paramList[0]!));
	}
	/* v8 ignore stop -- @preserve */
	if (ctx.On && ctx.booleanExpr) {
		condition = visit(asCstNode(ctx.booleanExpr[0]!));
	}

	return { relation, via, condition, params };
}

export function visitParamList(
	ctx: CstContext,
	visit: VisitFn,
): NqlJoinParam[] {
	const params: NqlJoinParam[] = [];
	if (ctx.param) {
		for (const paramCtx of ctx.param) {
			params.push(visit(asCstNode(paramCtx)));
		}
	}
	return params;
}

export function visitParam(ctx: CstContext, visit: VisitFn): NqlJoinParam {
	requireFields(
		ctx,
		['identSegment', 'literal'],
		'Param missing name or value',
	);
	return {
		name: visit(asCstNode(ctx.identSegment[0]!)),
		value: visit(asCstNode(ctx.literal[0]!)),
	};
}

export function visitSelectList(
	ctx: CstContext,
	visit: VisitFn,
): NqlSelectItem[] {
	const items: NqlSelectItem[] = [];
	if (ctx.selectItem) {
		for (const itemCtx of ctx.selectItem) {
			items.push(visit(asCstNode(itemCtx)));
		}
	}
	return items;
}

export function visitSelectItem(
	ctx: CstContext,
	visit: VisitFn,
): NqlSelectItem {
	if (ctx.Star && !ctx.relationStarExpr) {
		return { type: 'star' };
	}
	if (ctx.relationStarExpr) {
		return visit(asCstNode(ctx.relationStarExpr[0]!));
	}
	requireFirst(ctx, 'expression', 'Select item missing expression');
	const expression = visit(asCstNode(ctx.expression[0]!));
	const alias = ctx.identSegment
		? visit(asCstNode(ctx.identSegment[0]!))
		: undefined;
	return { type: 'expression', expression, alias };
}

export function visitRelationStarExpr(
	ctx: CstContext,
	visit: VisitFn,
): NqlSelectItem {
	const segments: string[] = [];
	if (ctx.identSegment) {
		for (const segCtx of ctx.identSegment) {
			segments.push(visit(asCstNode(segCtx)));
		}
	}
	return { type: 'relationStar', relation: segments };
}

export function visitOrderList(
	ctx: CstContext,
	visit: VisitFn,
): NqlOrderItem[] {
	const items: NqlOrderItem[] = [];
	if (ctx.orderItem) {
		for (const itemCtx of ctx.orderItem) {
			items.push(visit(asCstNode(itemCtx)));
		}
	}
	return items;
}

export function visitOrderItem(ctx: CstContext, visit: VisitFn): NqlOrderItem {
	requireFirst(ctx, 'expression', 'Order item missing expression');
	const expression = visit(asCstNode(ctx.expression[0]!));
	const direction: 'asc' | 'desc' = ctx.Desc ? 'desc' : 'asc';
	return { expression, direction };
}

export function visitLockClause(ctx: CstContext): NqlLockClause {
	let strength: NqlLockClause['strength'];
	if (ctx.ForUpdate) strength = 'forUpdate';
	else if (ctx.ForShare) strength = 'forShare';
	else if (ctx.ForNoKeyUpdate) strength = 'forNoKeyUpdate';
	else if (ctx.ForKeyShare) strength = 'forKeyShare';
	/* v8 ignore next — defensive: parser guarantees one of the lock strength tokens -- @preserve */ else
		unreachable('Lock clause missing strength keyword');

	let waitPolicy: NqlLockClause['waitPolicy'] = 'block';
	if (ctx.SkipLocked) waitPolicy = 'skipLocked';
	else if (ctx.NoWait) waitPolicy = 'noWait';

	return { type: 'lock', strength, waitPolicy };
}

export function visitSetClause(ctx: CstContext, visit: VisitFn): NqlSetClause {
	// Determine set operation type from consumed token
	let op: NqlSetClause['op'];
	if (ctx.Union) op = 'union';
	else if (ctx.Intersect) op = 'intersect';
	else if (ctx.Except) op = 'except';
	/* v8 ignore next — defensive: parser guarantees Union/Intersect/Except token -- @preserve */ else
		unreachable('Set clause missing operation keyword');

	const all = !!ctx.All;

	// Right operand: parenthesized query or bound name
	if (ctx.query) {
		const right: NqlQuery = visit(asCstNode(ctx.query[0]!));
		return { type: 'setOperation', op, all, right };
	}
	if (ctx.identSegment) {
		const boundName: string = visit(asCstNode(ctx.identSegment[0]!));
		return { type: 'setOperation', op, all, boundName };
	}
	/* v8 ignore next — defensive: parser guarantees query or identSegment -- @preserve */
	unreachable('Set clause missing operand');
}
