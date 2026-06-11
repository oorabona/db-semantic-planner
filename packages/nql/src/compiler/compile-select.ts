/* biome-ignore-all lint/style/noNonNullAssertion: NQL AST node access requires non-null assertions on validated parse tree */
/**
 * @module compiler/compile-select
 * Compiles NQL SELECT clauses to SelectIntent and ExpressionIntent.
 */

import type {
	AggregateFunction,
	AggregateWindowIntent,
	ExpressionIntent,
	OffsetWindowIntent,
	PseudoColumnTraversal,
	QueryIntent,
	RankingWindowIntent,
	SelectIntent,
	WindowFunction,
} from '@dbsp/types';
import { isRankingWindowFunction } from '@dbsp/types';
import { NqlErrorCodes, NqlSemanticException } from '../errors/types.js';
import type {
	NqlCaseExpression,
	NqlComparisonExpression,
	NqlExpression,
	NqlPathExpression,
	NqlSelectClause,
	NqlSelectExpression,
	NqlSelectItem,
	NqlUnaryExpression,
	NqlWindowExpression,
} from '../parser/ast.js';
import { compileNestedQuery } from './compile-query.js';
import {
	coerceToStringKey,
	expressionToField,
	expressionToSql,
	expressionToValue,
	isAggregateFunction,
} from './expression-utils.js';
import type { CompilerContext, CompilerFns } from './types.js';

/**
 * Compile a SELECT clause to a SelectIntent.
 */
export function compileSelectClause(
	clause: NqlSelectClause,
	ctx: CompilerContext,
	fns: CompilerFns,
): SelectIntent {
	if (clause.items.length === 1 && clause.items[0]?.type === 'star') {
		return { type: 'all' };
	}

	// Check if all items are simple field references
	const simpleFields: string[] = [];
	const expressions: ExpressionIntent[] = [];
	let hasExpressions = false;

	for (const item of clause.items) {
		if (item.type === 'star') {
			// Star in multi-item select → use column with special '*' marker
			hasExpressions = true;
			expressions.push({ kind: 'column', column: '*' });
		} else if (item.type === 'relationStar') {
			// relation.* → use relationColumn with '*' as column
			hasExpressions = true;
			const relation = item.relation.join('.');
			expressions.push({
				kind: 'relationColumn',
				relation,
				column: '*',
				as: `${relation}.*`,
			});
		} else if (item.type === 'expression') {
			const expr = item.expression;
			if (expr.type === 'path' && expr.segments.length === 1 && !item.alias) {
				// Simple field reference
				if (ctx.currentFromTable) {
					ctx.validator?.validateColumn(
						ctx.currentFromTable,
						expr.segments[0]!,
					);
				}
				simpleFields.push(expr.segments[0]!);
			} else {
				hasExpressions = true;
			}
			expressions.push(compileSelectExpression(item, ctx, fns));
		}
	}

	if (!hasExpressions) {
		return { type: 'fields', fields: simpleFields };
	}

	return { type: 'expressions', columns: expressions };
}

/**
 * Compile a single SELECT item to an ExpressionIntent.
 */
function compileSelectExpression(
	item: NqlSelectItem,
	ctx: CompilerContext,
	fns: CompilerFns,
): ExpressionIntent {
	/* v8 ignore start — defensive: star items are handled in compileSelectClause before reaching here -- @preserve */
	if (item.type === 'star') {
		return { kind: 'column', column: '*' };
	}
	/* v8 ignore stop -- @preserve */

	/* v8 ignore next — defensive: relationStar items are handled in compileSelectClause -- @preserve */
	if (item.type === 'relationStar') {
		const relation = item.relation.join('.');
		return {
			kind: 'relationColumn',
			relation,
			column: '*',
			as: `${relation}.*`,
		};
	}

	// From here item.type === 'expression', alias is available
	const exprItem = item as NqlSelectExpression;
	const expr = exprItem.expression;

	const expressionToSelectValue = (valueExpr: NqlExpression): unknown => {
		if (valueExpr.type === 'namedParam') {
			return { kind: 'param', value: expressionToValue(valueExpr, ctx) };
		}
		return expressionToValue(valueExpr, ctx);
	};

	// Check for functions (aggregate or regular)
	if (expr.type === 'function') {
		const fn = expr.name.toLowerCase();
		if (isAggregateFunction(fn)) {
			let field: string;
			if (expr.args.length === 0) {
				if (fn === 'count') {
					field = '*';
				} else {
					throw new Error(
						`Aggregate function ${fn}() requires at least one argument`,
					);
				}
			} else {
				field =
					expressionToField(expr.args[0]!) ?? expressionToSql(expr.args[0]!);
				if (ctx.currentFromTable && field !== '*' && !field.includes('.')) {
					ctx.validator?.validateColumn(ctx.currentFromTable, field);
				}
			}
			const extraArgs =
				expr.args.length > 1
					? expr.args
							.slice(1)
							.map((a) => expressionToField(a) ?? expressionToSelectValue(a))
					: undefined;
			return {
				kind: 'aggregate',
				function: fn as AggregateFunction,
				field,
				...(exprItem.alias !== undefined && { as: exprItem.alias }),
				...(expr.distinct && { distinct: true }),
				...(extraArgs && { extraArgs }),
			};
		}
		// JSON function notation → same intent as operator notation
		const jsonIntent = compileJsonFunction(fn, expr.args, exprItem.alias);
		if (jsonIntent) return jsonIntent;

		// Non-aggregate function (e.g., now(), upper(), coalesce())
		return {
			kind: 'function',
			name: expr.name,
			args: expr.args.map(
				(a) => expressionToField(a) ?? expressionToSelectValue(a),
			),
			...(exprItem.alias !== undefined && { as: exprItem.alias }),
		};
	}

	// Window expression
	if (expr.type === 'window') {
		const windowExpr = expr as NqlWindowExpression;
		const fn = windowExpr.function.toLowerCase() as WindowFunction;

		let field: string | undefined;
		if (windowExpr.args.length > 0) {
			field =
				expressionToField(windowExpr.args[0]!) ??
				expressionToSql(windowExpr.args[0]!);
		}

		// Extract offset and defaultValue for lag/lead (args[1] and args[2])
		let offset: number | undefined;
		let defaultValue: unknown;
		if (fn === 'lag' || fn === 'lead') {
			if (windowExpr.args.length > 1) {
				offset = expressionToValue(windowExpr.args[1]!, ctx) as number;
			}
			if (windowExpr.args.length > 2) {
				defaultValue = expressionToValue(windowExpr.args[2]!, ctx);
			}
		}

		const partitionBy =
			windowExpr.partitionBy.length > 0
				? windowExpr.partitionBy.map((e) => {
						const f = expressionToField(e) ?? expressionToSql(e);
						if (ctx.currentFromTable && !f.includes('.') && !f.includes('(')) {
							ctx.validator?.validateColumn(ctx.currentFromTable, f);
						}
						return f;
					})
				: undefined;

		const orderBy =
			windowExpr.orderBy.length > 0
				? windowExpr.orderBy.map((o) => {
						const f =
							expressionToField(o.expression) ?? expressionToSql(o.expression);
						if (ctx.currentFromTable && !f.includes('.') && !f.includes('(')) {
							ctx.validator?.validateColumn(ctx.currentFromTable, f);
						}
						return { field: f, direction: o.direction };
					})
				: undefined;

		const over = {
			...(partitionBy && { partitionBy }),
			...(orderBy && { orderBy }),
		} as const;
		const alias = exprItem.alias ?? fn;

		if (isRankingWindowFunction(fn)) {
			return {
				kind: 'window',
				function: fn,
				alias,
				over,
			} satisfies RankingWindowIntent;
		}

		if (fn === 'lag' || fn === 'lead') {
			return {
				kind: 'window',
				function: fn,
				field: field ?? '',
				alias,
				...(offset !== undefined && { offset }),
				...(defaultValue !== undefined && { defaultValue }),
				over,
			} satisfies OffsetWindowIntent;
		}

		// aggregate branch: sum / avg / count / min / max
		// COUNT(*) omits field (undefined); others always have a field from the parser
		return {
			kind: 'window',
			function: fn,
			...(field !== undefined && { field }),
			alias,
			over,
		} satisfies AggregateWindowIntent;
	}

	// Subquery in SELECT (scalar subquery)
	if (expr.type === 'subquery') {
		return {
			kind: 'subquery',
			query: compileNestedQuery(expr.query, ctx, fns) as QueryIntent,
			...(exprItem.alias !== undefined && { as: exprItem.alias }),
		};
	}

	// Simple path expression (single segment, e.g., "name")
	if (expr.type === 'path' && expr.segments.length === 1) {
		const column = expr.segments[0]!;
		if (ctx.currentFromTable) {
			ctx.validator?.validateColumn(ctx.currentFromTable, column);
		}
		if (exprItem.alias) {
			return { kind: 'columnAlias', column, alias: exprItem.alias };
		}
		return { kind: 'column', column };
	}

	// Path expression with multiple segments
	if (expr.type === 'path' && expr.segments.length > 1) {
		return compileMultiSegmentPath(expr, exprItem, ctx);
	}

	// Binary arithmetic expression
	if (
		expr.type === 'binary' &&
		['+', '-', '*', '/', '%'].includes(expr.operator)
	) {
		const leftField = expressionToField(expr.left);
		const rightField = expressionToField(expr.right);
		return {
			kind: 'arithmetic',
			left: leftField ?? expressionToSelectValue(expr.left),
			operator: expr.operator as '+' | '-' | '*' | '/' | '%',
			right: rightField ?? expressionToSelectValue(expr.right),
			...(exprItem.alias !== undefined && { as: exprItem.alias }),
		};
	}

	// Unary minus expression
	if (expr.type === 'unary') {
		const unary = expr as NqlUnaryExpression;
		if (unary.operator === '-') {
			const operandField = expressionToField(unary.operand);
			return {
				kind: 'arithmetic',
				left: -1,
				operator: '*',
				right: operandField ?? expressionToSelectValue(unary.operand),
				...(exprItem.alias !== undefined && { as: exprItem.alias }),
			};
		}
		throw new Error(`Unsupported unary operator in SELECT: ${unary.operator}`);
	}

	// CASE expression
	if (expr.type === 'case') {
		return compileCaseExpression(expr as NqlCaseExpression, exprItem, ctx, fns);
	}

	// JSON access expression: data->'key'->>'nested' as alias
	if (expr.type === 'jsonAccess') {
		const baseField = expressionToField(expr.base);
		/* v8 ignore start — defensive: jsonAccess base is always a path expression -- @preserve */
		if (!baseField) {
			throw new Error('JSON access base must be a field reference');
		}
		/* v8 ignore stop -- @preserve */
		return {
			kind: 'jsonExtract',
			field: baseField,
			path: expr.path,
			mode: expr.mode,
			...(exprItem.alias !== undefined && { as: exprItem.alias }),
		};
	}

	/* v8 ignore start — defensive: all parser-produced SELECT expression types are handled above -- @preserve */
	throw new Error(
		`Unsupported expression type in SELECT: ${expr.type}. ` +
			`This expression cannot be compiled to IntentAST. ` +
			`Consider extending the grammar or using a supported expression.`,
	);
	/* v8 ignore stop -- @preserve */
}

/**
 * Compile a multi-segment path expression in SELECT context.
 */
function compileMultiSegmentPath(
	expr: NqlPathExpression,
	item: NqlSelectExpression,
	ctx: CompilerContext,
): ExpressionIntent {
	const segments = expr.segments;
	const firstSegmentLower = (segments[0] as string).toLowerCase();

	// Check for pseudo-column traversal
	if (ctx.pseudoColumnKeywords.has(firstSegmentLower)) {
		const firstSegment: string = firstSegmentLower;
		const depthHint = expr.depthHint;

		if (depthHint !== undefined) {
			if (!ctx.recursiveKeywords.has(firstSegment)) {
				throw new Error(
					`Scoped depth [${depthHint}] is not supported on '${firstSegment}'. ` +
						`Only recursive traversals support depth hints.`,
				);
			}
			/* v8 ignore start — defensive: parser produces valid finite integers for depth hints -- @preserve */
			if (!Number.isFinite(depthHint) || depthHint < 1 || depthHint > 100) {
				throw new Error(
					`Invalid depth hint [${depthHint}]: must be an integer between 1 and 100.`,
				);
			}
			/* v8 ignore stop -- @preserve */
		}

		const traversals: string[] = [firstSegment];
		let i = 1;
		while (
			i < segments.length &&
			ctx.pseudoColumnKeywords.has((segments[i] as string).toLowerCase())
		) {
			traversals.push((segments[i] as string).toLowerCase());
			i++;
		}

		/* v8 ignore start — defensive: parser always produces at least one column segment after traversals -- @preserve */
		if (i >= segments.length) {
			throw new Error(
				`Pseudo-column path must end with a column name: ${segments.join('.')}`,
			);
		}
		/* v8 ignore stop -- @preserve */
		const targetColumn = segments[i]!;
		if (ctx.currentFromTable) {
			ctx.validator?.validateColumn(ctx.currentFromTable, targetColumn);
		}
		const defaultAlias = segments.map((s) => s.toLowerCase()).join('.');

		if (traversals.length === 1) {
			return {
				kind: 'pseudoColumn',
				traversal: firstSegment as PseudoColumnTraversal,
				targetColumn,
				as: item.alias ?? defaultAlias,
				...(depthHint !== undefined && { depth: depthHint }),
			};
		}

		return {
			kind: 'pseudoColumn',
			traversal: traversals[0]! as PseudoColumnTraversal,
			traversals: traversals as PseudoColumnTraversal[],
			targetColumn,
			as: item.alias ?? defaultAlias,
		};
	}

	// Regular relation path (e.g., customer.name)
	const column = segments[segments.length - 1]!;
	const relation = segments.slice(0, -1).join('.');
	if (ctx.currentFromTable && ctx.validator) {
		const targetTable = ctx.validator.resolveRelationTarget(
			ctx.currentFromTable,
			segments[0]!,
		);
		if (targetTable) {
			ctx.validator.validateColumn(targetTable, column);
		}
	}
	return {
		kind: 'relationColumn',
		relation,
		column,
		as: item.alias ?? `${relation}.${column}`,
	};
}

/**
 * Compile a CASE expression in SELECT context.
 */
function compileCaseExpression(
	caseExpr: NqlCaseExpression,
	item: NqlSelectExpression,
	ctx: CompilerContext,
	fns: CompilerFns,
): ExpressionIntent {
	if (caseExpr.subject) {
		// Simple CASE: normalize to searched CASE
		const subjectField = expressionToField(caseExpr.subject);
		/* v8 ignore start — defensive: simple CASE subject is always a path expression -- @preserve */
		if (!subjectField) {
			throw new Error('Simple CASE subject must be a column reference');
		}
		/* v8 ignore stop -- @preserve */
		return {
			kind: 'case' as const,
			when: caseExpr.whenClauses.map((wc) => ({
				condition: {
					kind: 'comparison' as const,
					field: subjectField,
					operator: 'eq',
					value: expressionToValue(wc.condition, ctx),
				},
				result: compileExpressionToIntent(wc.result, ctx, fns),
			})),
			...(caseExpr.elseClause && {
				else: compileExpressionToIntent(caseExpr.elseClause, ctx, fns),
			}),
			...(item.alias !== undefined && { as: item.alias }),
		};
	}

	// Searched CASE: CASE WHEN boolExpr THEN expr ...
	return {
		kind: 'case' as const,
		when: caseExpr.whenClauses.map((wc) => ({
			condition: fns.compileExpression(wc.condition, ctx, fns),
			result: compileExpressionToIntent(wc.result, ctx, fns),
		})),
		...(caseExpr.elseClause && {
			else: compileExpressionToIntent(caseExpr.elseClause, ctx, fns),
		}),
		...(item.alias !== undefined && { as: item.alias }),
	};
}

/**
 * Compile an NqlExpression to ExpressionIntent for use in CASE results.
 */
function compileExpressionToIntent(
	expr: NqlExpression,
	ctx: CompilerContext,
	fns: CompilerFns,
): ExpressionIntent {
	// Handle comparison expressions
	if (expr.type === 'comparison') {
		const cmp = expr as NqlComparisonExpression;
		/* v8 ignore start — defensive: CASE conditions always have path on LHS from parser -- @preserve */
		if (cmp.left.type !== 'path') {
			throw new Error(
				`CASE WHEN condition left side must be a column path, got ${cmp.left.type}`,
			);
		}
		/* v8 ignore stop -- @preserve */
		const column = (cmp.left as NqlPathExpression).segments.join('.');
		const value = expressionToValue(cmp.right, ctx);
		return {
			kind: 'comparison',
			column,
			operator: cmp.operator,
			value,
		};
	}

	// Handle literal values
	if (
		expr.type === 'string' ||
		expr.type === 'number' ||
		expr.type === 'boolean' ||
		expr.type === 'null' ||
		expr.type === 'namedParam'
	) {
		if (expr.type === 'namedParam') {
			return { kind: 'param', value: expressionToValue(expr, ctx) };
		}
		if (expr.type === 'null') {
			return { kind: 'literal', value: null };
		}
		return { kind: 'literal', value: expr.value };
	}

	// For other expressions, wrap and use compileSelectExpression
	const selectItem: NqlSelectItem = {
		type: 'expression',
		expression: expr,
	};
	return compileSelectExpression(selectItem, ctx, fns);
}

// ============================================================================
// JSON Function Notation → Same intents as operator notation
// ============================================================================

const JSON_FUNCTION_NAMES: ReadonlySet<string> = new Set([
	'json_extract',
	'json_extract_text',
	'json_path',
	'json_path_text',
]);

/**
 * Compile JSON function notation to the same intent as operator notation.
 * Returns null if the function is not a known JSON function.
 */
function compileJsonFunction(
	fn: string,
	args: NqlExpression[],
	alias: string | undefined,
): ExpressionIntent | null {
	if (!JSON_FUNCTION_NAMES.has(fn)) return null;

	if (args.length < 2) {
		throw new NqlSemanticException(
			NqlErrorCodes.SEM_INVALID_SYNTAX,
			`${fn}() requires at least 2 arguments: field and key`,
		);
	}

	const field = expressionToField(args[0]!);
	/* v8 ignore start — defensive: first arg is always a field reference -- @preserve */
	if (!field) {
		throw new NqlSemanticException(
			NqlErrorCodes.SEM_INVALID_SYNTAX,
			`${fn}() first argument must be a field reference`,
		);
	}
	/* v8 ignore stop -- @preserve */

	if (fn === 'json_extract' || fn === 'json_extract_text') {
		// json_extract(col, 'key') → JsonExtractIntent
		// M-1: String(expressionToValue(a)) → '[object Object]' for path expressions.
		// coerceToStringKey prevents silent coercion: single-segment identifiers are
		// treated as string keys; dotted paths and non-string args throw SEM_INVALID_SYNTAX.
		const keys = args
			.slice(1)
			.map((a) => coerceToStringKey(a, `${fn}() path argument`));
		return {
			kind: 'jsonExtract',
			field,
			path: keys,
			mode: fn === 'json_extract' ? 'json' : 'text',
			...(alias !== undefined && { as: alias }),
		};
	}

	if (fn === 'json_path' || fn === 'json_path_text') {
		// json_path(col, 'a', 'b') → JsonPathExtractIntent with array literal '{a,b}'
		// Also supports pre-built literal: json_path(col, '{a,b}')
		// M-1: same coercion fix — reject path expressions and non-string args.
		const keys = args
			.slice(1)
			.map((a) => coerceToStringKey(a, `${fn}() path argument`));
		const first = keys[0];
		const pathStr =
			keys.length === 1 && first?.startsWith('{') && first.endsWith('}')
				? first
				: `{${keys.join(',')}}`;
		return {
			kind: 'jsonPathExtract',
			field,
			path: pathStr,
			mode: fn === 'json_path' ? 'json' : 'text',
			...(alias !== undefined && { as: alias }),
		};
	}

	return null;
}
