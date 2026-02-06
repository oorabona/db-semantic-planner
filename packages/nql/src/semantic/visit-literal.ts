// @ts-nocheck — Chevrotain CST visitor: ctx.rule properties guaranteed present
/* biome-ignore-all lint/style/noNonNullAssertion: Chevrotain CST access requires non-null assertions on ctx.rule[0] patterns */
/**
 * @module semantic/visit-literal
 * Literal, identifier, and value visitors for NQL CST-to-AST.
 */

import { NqlErrorCodes, NqlSemanticException } from '../errors/index.js';
import type { NqlLiteral, NqlRangeLiteral } from '../parser/ast.js';
import type { CstContext, VisitFn } from './helpers.js';
import { asCstNode, getImage, requireFields, unreachable } from './helpers.js';

export function visitLiteral(ctx: CstContext, visit: VisitFn): NqlLiteral {
	if (ctx.StringLiteral) {
		const raw = getImage(ctx.StringLiteral[0]!);
		return { type: 'string', value: raw.slice(1, -1).replace(/''/g, "'") };
	}
	if (ctx.NumberLiteral) {
		return {
			type: 'number',
			value: parseFloat(getImage(ctx.NumberLiteral[0]!)),
		};
	}
	if (ctx.True) {
		return { type: 'boolean', value: true };
	}
	if (ctx.False) {
		return { type: 'boolean', value: false };
	}
	if (ctx.Null) {
		return { type: 'null' };
	}
	if (ctx.rangeLiteral) {
		return visit(asCstNode(ctx.rangeLiteral[0]!)) as NqlRangeLiteral;
	}
	unreachable('Invalid literal');
}

export function visitRangeLiteral(
	ctx: CstContext,
	visit: VisitFn,
): NqlRangeLiteral {
	const lowerInclusive = ctx.LBracket !== undefined;
	const upperInclusive = ctx.RBracket !== undefined;

	requireFields(
		ctx,
		['lower', 'upper'],
		'Range literal missing lower or upper bound',
	);
	const lower = visit(asCstNode(ctx.lower[0]!)) as string;
	const upper = visit(asCstNode(ctx.upper[0]!)) as string;

	const openBracket = lowerInclusive ? '[' : '(';
	const closeBracket = upperInclusive ? ']' : ')';
	const value = `${openBracket}${lower},${upper}${closeBracket}`;

	return {
		type: 'rangeLiteral',
		value,
		lowerInclusive,
		upperInclusive,
		lower,
		upper,
	};
}

export function visitRangeValue(ctx: CstContext): string {
	if (ctx.RangeValue) {
		return getImage(ctx.RangeValue[0]!);
	}
	const numToken = ctx.NumberLiteral;
	if (!numToken) {
		throw new NqlSemanticException(
			NqlErrorCodes.SEM_INVALID_SYNTAX,
			'Range value must contain RangeValue or NumberLiteral',
		);
	}
	const minus = ctx.Minus ? '-' : '';
	const num = getImage(numToken[0]!);
	return `${minus}${num}`;
}

export function visitIdentSegment(ctx: CstContext): string {
	if (ctx.Identifier) {
		return getImage(ctx.Identifier[0]!);
	}
	if (ctx.QuotedIdentifier) {
		const raw = getImage(ctx.QuotedIdentifier[0]!);
		return raw.slice(1, -1).replace(/""/g, '"');
	}
	if (ctx.Parent) return getImage(ctx.Parent[0]!);
	if (ctx.Child) return getImage(ctx.Child[0]!);
	if (ctx.Ascendant) return getImage(ctx.Ascendant[0]!);
	if (ctx.Descendant) return getImage(ctx.Descendant[0]!);
	throw new NqlSemanticException(
		NqlErrorCodes.SEM_INVALID_SYNTAX,
		'Invalid identifier',
	);
}

export function visitIdentList(ctx: CstContext, visit: VisitFn): string[] {
	const idents: string[] = [];
	if (ctx.identSegment) {
		for (const segCtx of ctx.identSegment) {
			idents.push(visit(asCstNode(segCtx)));
		}
	}
	return idents;
}

export function visitValueList(
	ctx: CstContext,
	visit: VisitFn,
): import('../parser/ast.js').NqlExpression[] {
	const values: import('../parser/ast.js').NqlExpression[] = [];
	if (ctx.expression) {
		for (const exprCtx of ctx.expression) {
			values.push(visit(asCstNode(exprCtx)));
		}
	}
	return values;
}
