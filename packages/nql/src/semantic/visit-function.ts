// @ts-nocheck — Chevrotain CST visitor: ctx.rule properties guaranteed present
/* biome-ignore-all lint/style/noNonNullAssertion: Chevrotain CST access requires non-null assertions on ctx.rule[0] patterns */
/**
 * @module semantic/visit-function
 * Function call and window clause visitors for NQL CST-to-AST.
 */

import { NqlErrorCodes, NqlSemanticException } from '../errors/index.js';
import type {
	NqlExpression,
	NqlFunctionCall,
	NqlOrderItem,
	NqlWindowExpression,
} from '../parser/ast.js';
import type { CstContext, VisitFn, WindowSpec } from './helpers.js';
import { asCstNode } from './helpers.js';

export function visitFuncCall(
	ctx: CstContext,
	visit: VisitFn,
): NqlFunctionCall | NqlWindowExpression {
	let name: string;
	if (ctx.RowNumber) name = 'row_number';
	else if (ctx.Rank) name = 'rank';
	else if (ctx.DenseRank) name = 'dense_rank';
	else if (ctx.Lag) name = 'lag';
	else if (ctx.Lead) name = 'lead';
	else if (ctx.identSegment) name = visit(asCstNode(ctx.identSegment[0]!));
	/* v8 ignore start — defensive: parser guarantees a function name token -- @preserve */ else {
		throw new NqlSemanticException(
			NqlErrorCodes.SEM_INVALID_SYNTAX,
			'Function call missing name',
		);
	}
	/* v8 ignore stop -- @preserve */

	const args: NqlExpression[] = [];
	let distinct = false;

	if (ctx.Star) {
		args.push({ type: 'path', segments: ['*'] });
	} else if (ctx.funcArgList) {
		const argListCtx = asCstNode(ctx.funcArgList[0]!);
		if (argListCtx.children?.Distinct) {
			distinct = true;
		}
		const argList = visit(argListCtx) as NqlExpression[];
		args.push(...argList);
	}

	if (ctx.windowClause) {
		const windowSpec = visit(asCstNode(ctx.windowClause[0]!)) as WindowSpec;
		return {
			type: 'window',
			function: name,
			args,
			partitionBy: windowSpec.partitionBy,
			orderBy: windowSpec.orderBy,
		};
	}

	return distinct
		? { type: 'function' as const, name, args, distinct }
		: { type: 'function' as const, name, args };
}

export function visitWindowClause(ctx: CstContext, visit: VisitFn): WindowSpec {
	let partitionBy: NqlExpression[] = [];
	let orderBy: NqlOrderItem[] = [];

	if (ctx.partitionClause) {
		partitionBy = visit(asCstNode(ctx.partitionClause[0]!)) as NqlExpression[];
	}

	if (ctx.orderClauseInWindow) {
		orderBy = visit(asCstNode(ctx.orderClauseInWindow[0]!)) as NqlOrderItem[];
	}

	return { partitionBy, orderBy };
}

export function visitPartitionClause(
	ctx: CstContext,
	visit: VisitFn,
): NqlExpression[] {
	if (ctx.exprList) {
		return visit(asCstNode(ctx.exprList[0]!)) as NqlExpression[];
	}
	return [];
}

export function visitOrderClauseInWindow(
	ctx: CstContext,
	visit: VisitFn,
): NqlOrderItem[] {
	if (ctx.orderList) {
		return visit(asCstNode(ctx.orderList[0]!)) as NqlOrderItem[];
	}
	return [];
}

export function visitFuncArgList(
	ctx: CstContext,
	visit: VisitFn,
): NqlExpression[] {
	if (ctx.exprList) {
		return visit(asCstNode(ctx.exprList[0]!)) as NqlExpression[];
	}
	return [];
}
