// @ts-nocheck — Chevrotain CST visitor: ctx.rule properties guaranteed present
/* biome-ignore-all lint/style/noNonNullAssertion: Chevrotain CST access requires non-null assertions on ctx.rule[0] patterns */
/**
 * @module semantic/visit-expression
 * Boolean expressions, arithmetic, primary, case, scalar subquery, relation filters.
 */

import type { CstNode, IToken } from 'chevrotain';
import { NqlErrorCodes, NqlSemanticException } from '../errors/index.js';
import type {
	NqlBetweenExpression,
	NqlCaseExpression,
	NqlExistsExpression,
	NqlExpression,
	NqlInExpression,
	NqlIsNullExpression,
	NqlLiteral,
	NqlPathExpression,
	NqlRangeLiteral,
	NqlRangeOpExpression,
	NqlRelationFilterExpression,
	NqlSubquery,
} from '../parser/ast.js';
import type { CstContext, VisitFn } from './helpers.js';
import { asCstNode, getImage, requireFirst, unreachable } from './helpers.js';

// ============================================================
// BOOLEAN EXPRESSIONS
// ============================================================

export function visitBooleanExpr(
	ctx: CstContext,
	visit: VisitFn,
): NqlExpression {
	requireFirst(ctx, 'orExpr', 'Boolean expr missing orExpr');
	return visit(asCstNode(ctx.orExpr[0]!));
}

export function visitOrExpr(ctx: CstContext, visit: VisitFn): NqlExpression {
	requireFirst(ctx, 'andExpr', 'Or expr missing andExpr');
	let left = visit(asCstNode(ctx.andExpr[0]!));
	if (ctx.andExpr.length > 1) {
		for (let i = 1; i < ctx.andExpr.length; i++) {
			const right = visit(asCstNode(ctx.andExpr[i]!));
			left = { type: 'binary', operator: 'or', left, right };
		}
	}
	return left;
}

export function visitAndExpr(ctx: CstContext, visit: VisitFn): NqlExpression {
	requireFirst(ctx, 'notExpr', 'And expr missing notExpr');
	let left = visit(asCstNode(ctx.notExpr[0]!));
	if (ctx.notExpr.length > 1) {
		for (let i = 1; i < ctx.notExpr.length; i++) {
			const right = visit(asCstNode(ctx.notExpr[i]!));
			left = { type: 'binary', operator: 'and', left, right };
		}
	}
	return left;
}

export function visitNotExpr(ctx: CstContext, visit: VisitFn): NqlExpression {
	requireFirst(ctx, 'primaryCond', 'Not expr missing primaryCond');
	const expr = visit(asCstNode(ctx.primaryCond[0]!));
	if (ctx.Not) {
		return { type: 'unary', operator: 'not', operand: expr };
	}
	return expr;
}

export function visitPrimaryCond(
	ctx: CstContext,
	visit: VisitFn,
): NqlExpression {
	if (ctx.booleanExpr) {
		return visit(asCstNode(ctx.booleanExpr[0]!));
	}
	if (ctx.existsCheck) {
		return visit(asCstNode(ctx.existsCheck[0]!));
	}
	if (ctx.quantifiedRelationFilter) {
		return visit(asCstNode(ctx.quantifiedRelationFilter[0]!));
	}
	if (ctx.allRelationFilter) {
		return visit(asCstNode(ctx.allRelationFilter[0]!));
	}

	requireFirst(ctx, 'expression', 'PrimaryCond missing expression');
	const left = visit(asCstNode(ctx.expression[0]!));

	if (ctx.comparisonSuffix) {
		return buildComparison(left, asCstNode(ctx.comparisonSuffix[0]!), visit);
	}
	if (ctx.betweenSuffix) {
		return buildBetween(left, asCstNode(ctx.betweenSuffix[0]!), visit);
	}
	if (ctx.inSuffix) {
		return buildIn(left, asCstNode(ctx.inSuffix[0]!), visit);
	}
	if (ctx.isNullSuffix) {
		return buildIsNull(left, asCstNode(ctx.isNullSuffix[0]!));
	}
	if (ctx.rangeOpSuffix) {
		return buildRangeOp(left, asCstNode(ctx.rangeOpSuffix[0]!), visit);
	}

	return left;
}

function buildComparison(
	left: NqlExpression,
	suffixNode: CstNode,
	visit: VisitFn,
): NqlExpression {
	const suffixCtx = suffixNode.children as CstContext;
	if (!suffixCtx.compOp || !suffixCtx.expression) {
		throw new NqlSemanticException(
			NqlErrorCodes.SEM_INVALID_SYNTAX,
			'Comparison suffix missing operator or expression',
		);
	}
	const operator = visit(asCstNode(suffixCtx.compOp[0]!)) as
		| '='
		| '!='
		| '<'
		| '>'
		| '<='
		| '>='
		| 'like';
	const right = visit(asCstNode(suffixCtx.expression[0]!));
	return { type: 'comparison', operator, left, right };
}

function buildBetween(
	left: NqlExpression,
	suffixNode: CstNode,
	visit: VisitFn,
): NqlBetweenExpression {
	const suffixCtx = suffixNode.children as CstContext;
	if (!suffixCtx.expression || suffixCtx.expression.length < 2) {
		throw new NqlSemanticException(
			NqlErrorCodes.SEM_INVALID_SYNTAX,
			'Between suffix missing expressions',
		);
	}
	return {
		type: 'between',
		expression: left,
		low: visit(asCstNode(suffixCtx.expression[0]!)),
		high: visit(asCstNode(suffixCtx.expression[1]!)),
	};
}

function buildIn(
	left: NqlExpression,
	suffixNode: CstNode,
	visit: VisitFn,
): NqlInExpression {
	const suffixCtx = suffixNode.children as CstContext;
	const negated = !!suffixCtx.Not;

	if (suffixCtx.StringLiteral) {
		const raw = getImage(suffixCtx.StringLiteral[0]!);
		const value = raw.slice(1, -1).replace(/''/g, "'");
		return {
			type: 'in',
			negated,
			expression: left,
			values: { type: 'dateRange', value },
		};
	}

	if (suffixCtx.scalarSubquery) {
		return {
			type: 'in',
			negated,
			expression: left,
			values: visit(asCstNode(suffixCtx.scalarSubquery[0]!)),
		};
	}

	const values: NqlExpression[] = [];
	if (suffixCtx.valueList) {
		const listValues = visit(
			asCstNode(suffixCtx.valueList[0]!),
		) as NqlExpression[];
		values.push(...listValues);
	}

	return { type: 'in', negated, expression: left, values };
}

function buildIsNull(
	left: NqlExpression,
	suffixNode: CstNode,
): NqlIsNullExpression {
	const suffixCtx = suffixNode.children as CstContext;
	return {
		type: 'isNull',
		expression: left,
		negated: !!suffixCtx.Not,
	};
}

function buildRangeOp(
	left: NqlExpression,
	suffixNode: CstNode,
	visit: VisitFn,
): NqlRangeOpExpression {
	const suffixCtx = suffixNode.children as CstContext;
	if (!suffixCtx.rangeOp) {
		throw new NqlSemanticException(
			NqlErrorCodes.SEM_INVALID_SYNTAX,
			'Range op suffix missing operator',
		);
	}
	const operator = visit(asCstNode(suffixCtx.rangeOp[0]!)) as
		| 'overlaps'
		| 'contains'
		| 'containedBy';

	if (suffixCtx.rangeLiteral) {
		const range = visit(
			asCstNode(suffixCtx.rangeLiteral[0]!),
		) as NqlRangeLiteral;
		return { type: 'rangeOp', operator, left, range };
	}
	if (suffixCtx.literal) {
		const scalar = visit(asCstNode(suffixCtx.literal[0]!)) as NqlLiteral;
		return { type: 'rangeOp', operator, left, scalar };
	}

	throw new NqlSemanticException(
		NqlErrorCodes.SEM_INVALID_SYNTAX,
		'Range op suffix missing range literal or scalar value',
	);
}

// ============================================================
// STUB VISITORS (required by Chevrotain but handled elsewhere)
// ============================================================

export function visitComparisonSuffix(): NqlExpression {
	unreachable('comparisonSuffix should not be visited directly');
}

export function visitBetweenSuffix(): NqlExpression {
	unreachable('betweenSuffix should not be visited directly');
}

export function visitRangeOpSuffix(): NqlExpression {
	unreachable('rangeOpSuffix should not be visited directly');
}

export function visitInSuffix(): NqlExpression {
	unreachable('inSuffix should not be visited directly');
}

export function visitIsNullSuffix(): NqlExpression {
	unreachable('isNullSuffix should not be visited directly');
}

export function visitCompOp(ctx: CstContext): string {
	if (ctx.Equals) return '=';
	if (ctx.NotEquals) return '!=';
	if (ctx.LessThan) return '<';
	if (ctx.GreaterThan) return '>';
	if (ctx.LessThanOrEqual) return '<=';
	if (ctx.GreaterThanOrEqual) return '>=';
	if (ctx.Like) return 'like';
	unreachable('Unknown comparison operator');
}

export function visitRangeOp(
	ctx: CstContext,
): 'overlaps' | 'contains' | 'containedBy' {
	if (ctx.Overlaps) return 'overlaps';
	if (ctx.Contains) return 'contains';
	if (ctx.ContainedBy) return 'containedBy';
	unreachable('Unknown range operator');
}

// ============================================================
// ARITHMETIC EXPRESSIONS
// ============================================================

export function visitExpression(
	ctx: CstContext,
	visit: VisitFn,
): NqlExpression {
	requireFirst(ctx, 'addExpr', 'Expression missing addExpr');
	return visit(asCstNode(ctx.addExpr[0]!));
}

export function visitAddExpr(ctx: CstContext, visit: VisitFn): NqlExpression {
	requireFirst(ctx, 'mulExpr', 'AddExpr missing mulExpr');
	let left = visit(asCstNode(ctx.mulExpr[0]!));

	if (ctx.mulExpr.length > 1) {
		const ops: { op: '+' | '-'; offset: number }[] = [];
		if (ctx.Plus) {
			for (const tok of ctx.Plus as IToken[]) {
				ops.push({ op: '+', offset: tok.startOffset });
			}
		}
		if (ctx.Minus) {
			for (const tok of ctx.Minus as IToken[]) {
				ops.push({ op: '-', offset: tok.startOffset });
			}
		}
		ops.sort((a, b) => a.offset - b.offset);

		for (let i = 1; i < ctx.mulExpr.length; i++) {
			const right = visit(asCstNode(ctx.mulExpr[i]!));
			const op = ops[i - 1]?.op || '+';
			left = { type: 'binary', operator: op, left, right };
		}
	}

	return left;
}

export function visitMulExpr(ctx: CstContext, visit: VisitFn): NqlExpression {
	requireFirst(ctx, 'unaryExpr', 'MulExpr missing unaryExpr');
	let left = visit(asCstNode(ctx.unaryExpr[0]!));

	if (ctx.unaryExpr.length > 1) {
		const ops: { op: '*' | '/' | '%'; offset: number }[] = [];
		if (ctx.Star) {
			for (const tok of ctx.Star as IToken[]) {
				ops.push({ op: '*', offset: tok.startOffset });
			}
		}
		if (ctx.Slash) {
			for (const tok of ctx.Slash as IToken[]) {
				ops.push({ op: '/', offset: tok.startOffset });
			}
		}
		if (ctx.Percent) {
			for (const tok of ctx.Percent as IToken[]) {
				ops.push({ op: '%', offset: tok.startOffset });
			}
		}
		ops.sort((a, b) => a.offset - b.offset);

		for (let i = 1; i < ctx.unaryExpr.length; i++) {
			const right = visit(asCstNode(ctx.unaryExpr[i]!));
			const op = ops[i - 1]?.op || '*';
			left = { type: 'binary', operator: op, left, right };
		}
	}

	return left;
}

export function visitUnaryExpr(ctx: CstContext, visit: VisitFn): NqlExpression {
	requireFirst(ctx, 'primaryExpr', 'UnaryExpr missing primaryExpr');
	const expr = visit(asCstNode(ctx.primaryExpr[0]!));
	if (ctx.Minus) {
		return { type: 'unary', operator: '-', operand: expr };
	}
	return expr;
}

export function visitPrimaryExpr(
	ctx: CstContext,
	visit: VisitFn,
): NqlExpression {
	if (ctx.literal) return visit(asCstNode(ctx.literal[0]!));
	if (ctx.caseExpr) return visit(asCstNode(ctx.caseExpr[0]!));
	if (ctx.funcCall) return visit(asCstNode(ctx.funcCall[0]!));
	if (ctx.pathExpr) return visit(asCstNode(ctx.pathExpr[0]!));
	if (ctx.LParen && ctx.expression) {
		return visit(asCstNode(ctx.expression[0]!));
	}
	if (ctx.scalarSubquery) return visit(asCstNode(ctx.scalarSubquery[0]!));
	throw new NqlSemanticException(
		NqlErrorCodes.SEM_INVALID_SYNTAX,
		'Invalid primary expression',
	);
}

// ============================================================
// CASE / SUBQUERY / PATH
// ============================================================

export function visitCaseExpr(
	ctx: CstContext,
	visit: VisitFn,
): NqlCaseExpression {
	const whenClauses: Array<{
		condition: NqlExpression;
		result: NqlExpression;
	}> = [];
	let subject: NqlExpression | undefined;
	const hasElse = ctx.Else !== undefined;

	if (ctx.searchedCaseBody) {
		const bodyCtx = asCstNode(ctx.searchedCaseBody[0]!).children;
		const conditions = bodyCtx.booleanExpr ?? [];
		const results = bodyCtx.expression ?? [];
		const whenCount = bodyCtx.When?.length ?? 0;
		for (let i = 0; i < whenCount; i++) {
			whenClauses.push({
				condition: visit(asCstNode(conditions[i]!)),
				result: visit(asCstNode(results[i]!)),
			});
		}
	} else if (ctx.simpleCaseBody) {
		const bodyCtx = asCstNode(ctx.simpleCaseBody[0]!).children;
		const expressions = bodyCtx.expression ?? [];
		const whenCount = bodyCtx.When?.length ?? 0;
		subject = visit(asCstNode(expressions[0]!));
		for (let i = 0; i < whenCount; i++) {
			whenClauses.push({
				condition: visit(asCstNode(expressions[1 + i * 2]!)),
				result: visit(asCstNode(expressions[2 + i * 2]!)),
			});
		}
	}

	const elseExpressions = ctx.expression ?? [];
	if (hasElse && elseExpressions.length > 0) {
		return {
			type: 'case',
			...(subject && { subject }),
			whenClauses,
			elseClause: visit(
				asCstNode(elseExpressions[elseExpressions.length - 1]!),
			),
		};
	}

	return {
		type: 'case',
		...(subject && { subject }),
		whenClauses,
	};
}

export function visitSearchedCaseBody(): void {
	/* Handled by caseExpr */
}

export function visitSimpleCaseBody(): void {
	/* Handled by caseExpr */
}

export function visitScalarSubquery(
	ctx: CstContext,
	visit: VisitFn,
): NqlSubquery {
	requireFirst(ctx, 'query', 'Scalar subquery missing query');
	return {
		type: 'subquery',
		query: visit(asCstNode(ctx.query[0]!)),
	};
}

export function visitPathExpr(ctx: CstContext, visit: VisitFn): NqlExpression {
	const segments: string[] = [];
	if (ctx.identSegment) {
		for (const segCtx of ctx.identSegment) {
			segments.push(visit(asCstNode(segCtx)));
		}
	}
	let depthHint: number | undefined;
	if (ctx.NumberLiteral) {
		depthHint = Number.parseInt(getImage(ctx.NumberLiteral[0]!), 10);
	}
	return depthHint !== undefined
		? { type: 'path', segments, depthHint }
		: { type: 'path', segments };
}

export function visitExprList(
	ctx: CstContext,
	visit: VisitFn,
): NqlExpression[] {
	const expressions: NqlExpression[] = [];
	if (ctx.expression) {
		for (const exprCtx of ctx.expression) {
			expressions.push(visit(asCstNode(exprCtx)));
		}
	}
	return expressions;
}

// ============================================================
// RELATION FILTER EXPRESSIONS (SPEC-002)
// ============================================================

export function visitExistsCheck(
	ctx: CstContext,
	visit: VisitFn,
): NqlExistsExpression {
	requireFirst(ctx, 'scalarSubquery', 'Exists missing subquery');
	return {
		type: 'exists',
		negated: !!ctx.Not,
		subquery: visit(asCstNode(ctx.scalarSubquery[0]!)),
	};
}

export function visitQuantifiedRelationFilter(
	ctx: CstContext,
	visit: VisitFn,
): NqlRelationFilterExpression {
	let mode: 'some' | 'none' | 'every';
	if (ctx.Some) mode = 'some';
	else if (ctx.None) mode = 'none';
	else if (ctx.Every) mode = 'every';
	else {
		throw new NqlSemanticException(
			NqlErrorCodes.SEM_INVALID_SYNTAX,
			'quantifiedRelationFilter missing quantifier',
		);
	}

	requireFirst(ctx, 'pathExpr', 'quantifiedRelationFilter missing pathExpr');
	const pathExpr = visit(asCstNode(ctx.pathExpr[0]!)) as NqlPathExpression;
	const relation = pathExpr.segments;

	if (ctx.booleanExpr) {
		const alias = ctx.identSegment
			? visit(asCstNode(ctx.identSegment[0]!))
			: undefined;
		const condition = visit(asCstNode(ctx.booleanExpr[0]!));
		return { type: 'relationFilter', relation, condition, mode, alias };
	}

	requireFirst(ctx, 'identSegment', 'quantifiedRelationFilter missing column');
	const column = visit(asCstNode(ctx.identSegment[0]!)) as string;
	requireFirst(ctx, 'compOp', 'quantifiedRelationFilter missing compOp');
	const operator = visit(asCstNode(ctx.compOp[0]!)) as string;
	requireFirst(
		ctx,
		'expression',
		'quantifiedRelationFilter missing expression',
	);
	const right = visit(asCstNode(ctx.expression[0]!));

	const condition = {
		type: 'comparison' as const,
		operator: operator as '=' | '!=' | '<' | '>' | '<=' | '>=' | 'like',
		left: { type: 'path' as const, segments: [column] as string[] },
		right,
	};

	return { type: 'relationFilter', relation, condition, mode };
}

export function visitAllRelationFilter(
	ctx: CstContext,
	visit: VisitFn,
): NqlRelationFilterExpression {
	requireFirst(ctx, 'pathExpr', 'allRelationFilter missing pathExpr');
	const pathExpr = visit(asCstNode(ctx.pathExpr[0]!)) as NqlPathExpression;
	const segments = pathExpr.segments;

	if (segments.length < 2) {
		throw new NqlSemanticException(
			NqlErrorCodes.SEM_INVALID_SYNTAX,
			`allRelationFilter requires at least relation.column (got: ${segments.join('.')})`,
		);
	}

	const relation = segments.slice(0, -1);
	const column = segments[segments.length - 1];

	requireFirst(ctx, 'compOp', 'allRelationFilter missing compOp');
	const operator = visit(asCstNode(ctx.compOp[0]!)) as string;
	requireFirst(ctx, 'expression', 'allRelationFilter missing expression');
	const right = visit(asCstNode(ctx.expression[0]!));

	const condition = {
		type: 'comparison' as const,
		operator: operator as '=' | '!=' | '<' | '>' | '<=' | '>=' | 'like',
		left: { type: 'path' as const, segments: [column] as string[] },
		right,
	};

	return { type: 'relationFilter', relation, condition, mode: 'every' };
}
