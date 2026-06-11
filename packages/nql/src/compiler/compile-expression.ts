/* biome-ignore-all lint/style/noNonNullAssertion: NQL AST node access requires non-null assertions on validated parse tree */
/**
 * @module compiler/compile-expression
 * Compiles NQL boolean expressions to WhereIntent (WHERE/HAVING clauses).
 */

import type {
	QueryIntent,
	WhereAnyIntent,
	WhereComparisonIntent,
	WhereInIntent,
	WhereIntent,
	WhereJsonContainsIntent,
	WhereJsonExistsIntent,
	WhereRangeIntent,
} from '@dbsp/types';
import { NqlErrorCodes, NqlSemanticException } from '../errors/types.js';
import type {
	NqlAnyExpression,
	NqlBetweenExpression,
	NqlBinaryExpression,
	NqlComparisonExpression,
	NqlExpression,
	NqlInExpression,
	NqlIsNullExpression,
	NqlJsonAccessExpression,
	NqlJsonComparisonExpression,
	NqlRangeOpExpression,
	NqlRelationFilterExpression,
	NqlUnaryExpression,
} from '../parser/ast.js';
import { compileNestedQuery } from './compile-query.js';
import { expandDateRange, isDateRangePattern } from './date-range-patterns.js';
import {
	coerceToStringKey,
	expressionToField,
	expressionToRangeValue,
	mapComparisonOperator,
	resolveFilterValue,
	resolveNamedParamArray,
	validateWhereField,
} from './expression-utils.js';
import type { CompilerContext, CompilerFns } from './types.js';

// ---------------------------------------------------------------------------
// Handler functions (extracted from switch cases)
// ---------------------------------------------------------------------------

/** Maximum number of items allowed in an ANY(:param) array to prevent memory pressure. */
export const MAX_ANY_ITEMS = 10000;

function compileLogical(
	expr: NqlExpression,
	ctx: CompilerContext,
	fns: CompilerFns,
	aliasContext?: string,
	outerAliases?: string[],
): WhereIntent {
	if (expr.type === 'binary') {
		const binary = expr as NqlBinaryExpression;
		if (binary.operator === 'and') {
			return {
				kind: 'and',
				conditions: [
					compileExpression(binary.left, ctx, fns, aliasContext, outerAliases),
					compileExpression(binary.right, ctx, fns, aliasContext, outerAliases),
				],
			};
		}
		if (binary.operator === 'or') {
			return {
				kind: 'or',
				conditions: [
					compileExpression(binary.left, ctx, fns, aliasContext, outerAliases),
					compileExpression(binary.right, ctx, fns, aliasContext, outerAliases),
				],
			};
		}
		/* v8 ignore start — defensive: only and/or reach here; arithmetic is in SELECT context -- @preserve */
		// Arithmetic binary → comparison context shouldn't reach here
		throw new NqlSemanticException(
			NqlErrorCodes.SEM_INVALID_SYNTAX,
			`Unsupported binary operator in WHERE: ${binary.operator}`,
		);
		/* v8 ignore stop -- @preserve */
	}

	// unary
	const unary = expr as NqlUnaryExpression;
	if (unary.operator === 'not') {
		return {
			kind: 'not',
			condition: compileExpression(
				unary.operand,
				ctx,
				fns,
				aliasContext,
				outerAliases,
			),
		};
	}
	/* v8 ignore next — defensive: only 'not' unary reaches WHERE context -- @preserve */
	throw new NqlSemanticException(
		NqlErrorCodes.SEM_INVALID_SYNTAX,
		`Unsupported unary operator: ${unary.operator}`,
	);
}

function compileComparison(
	expr: NqlExpression,
	ctx: CompilerContext,
	_fns: CompilerFns,
	aliasContext?: string,
	outerAliases?: string[],
): WhereIntent {
	const comp = expr as NqlComparisonExpression;

	// JSON access on LHS: data->'key' = 'val'
	if (comp.left.type === 'jsonAccess') {
		const jsonLeft = comp.left as NqlJsonAccessExpression;
		const baseField = expressionToField(jsonLeft.base, aliasContext);
		/* v8 ignore start — defensive: jsonAccess base is always a path expression -- @preserve */
		if (!baseField) {
			throw new NqlSemanticException(
				NqlErrorCodes.SEM_INVALID_SYNTAX,
				'JSON access base must be a field reference',
			);
		}
		/* v8 ignore stop -- @preserve */
		const operator = mapComparisonOperator(comp.operator);
		const value = resolveFilterValue(
			comp.right,
			ctx,
			aliasContext,
			outerAliases,
		);
		const intent = {
			kind: 'comparison',
			field: baseField,
			operator,
			value,
			jsonPath: jsonLeft.path,
			jsonMode: jsonLeft.mode,
		} satisfies WhereComparisonIntent;
		if (comp.right.type === 'namedParam') {
			ctx.paramProvenance.markParamValue(intent, 'value');
		}
		return intent;
	}

	// JSON function on LHS: json_extract_text(data, 'key') = 'val'
	if (comp.left.type === 'function') {
		const fn = comp.left.name.toLowerCase();
		if (fn === 'json_extract' || fn === 'json_extract_text') {
			/* v8 ignore start — defensive: parser guarantees at least 2 args for json_extract -- @preserve */
			if (comp.left.args.length < 2) {
				throw new NqlSemanticException(
					NqlErrorCodes.SEM_INVALID_SYNTAX,
					`${fn}() requires at least 2 arguments`,
				);
			}
			/* v8 ignore stop -- @preserve */
			const baseField = expressionToField(comp.left.args[0]!, aliasContext);
			/* v8 ignore start — defensive: first arg is always a field reference -- @preserve */
			if (!baseField) {
				throw new NqlSemanticException(
					NqlErrorCodes.SEM_INVALID_SYNTAX,
					`${fn}() first argument must be a field reference`,
				);
			}
			/* v8 ignore stop -- @preserve */
			// Each path argument after the first is a JSON key: must be a string literal
			// or a single identifier. String(resolveFilterValue(...)) would silently emit
			// '[object Object]' for path expressions — use coerceToStringKey instead.
			const keys = comp.left.args
				.slice(1)
				.map((a) => coerceToStringKey(a, `${fn}() path argument`, ctx));
			const operator = mapComparisonOperator(comp.operator);
			const value = resolveFilterValue(
				comp.right,
				ctx,
				aliasContext,
				outerAliases,
			);
			const intent = {
				kind: 'comparison',
				field: baseField,
				operator,
				value,
				jsonPath: keys,
				jsonMode: fn === 'json_extract' ? 'json' : 'text',
			} satisfies WhereComparisonIntent;
			if (comp.right.type === 'namedParam') {
				ctx.paramProvenance.markParamValue(intent, 'value');
			}
			return intent;
		}
	}

	const field = expressionToField(comp.left, aliasContext);
	/* v8 ignore start — defensive: parser guarantees LHS is a path expression -- @preserve */
	if (!field) {
		throw new NqlSemanticException(
			NqlErrorCodes.SEM_INVALID_SYNTAX,
			'Left side of comparison must be a field reference',
		);
	}
	/* v8 ignore stop -- @preserve */
	// Validate WHERE column on current table context
	validateWhereField(ctx, field, aliasContext, comp.left);

	// Handle LIKE specially: RHS must be a string literal or single-segment identifier path.
	// Dotted paths and expression nodes are rejected by coerceToStringKey().
	// String(resolveFilterValue(...)) would silently yield '[object Object]' for path refs.
	if (comp.operator === 'like') {
		const pattern = coerceToStringKey(comp.right, 'LIKE pattern', ctx);
		return {
			kind: 'like',
			field,
			pattern,
		};
	}

	const operator = mapComparisonOperator(comp.operator);
	const value = resolveFilterValue(comp.right, ctx, aliasContext, outerAliases);

	const intent: WhereComparisonIntent = {
		kind: 'comparison',
		field,
		operator,
		value,
	};
	if (comp.right.type === 'namedParam') {
		ctx.paramProvenance.markParamValue(intent, 'value');
	}
	return intent;
}

function compileRange(
	expr: NqlExpression,
	ctx: CompilerContext,
	_fns: CompilerFns,
	aliasContext?: string,
	outerAliases?: string[],
): WhereIntent {
	const rangeExpr = expr as NqlRangeOpExpression;
	const field = expressionToField(rangeExpr.left, aliasContext);
	/* v8 ignore start — defensive: parser guarantees LHS is a path expression -- @preserve */
	if (!field) {
		throw new NqlSemanticException(
			NqlErrorCodes.SEM_INVALID_SYNTAX,
			'Left side of range operator must be a field reference',
		);
	}
	/* v8 ignore stop -- @preserve */
	validateWhereField(ctx, field, aliasContext, rangeExpr.left);
	// Handle both range literals and scalar values
	let rangeValue: string | unknown;
	if (rangeExpr.range) {
		rangeValue = expressionToRangeValue(rangeExpr.range);
	} else if (rangeExpr.scalar) {
		// Scalar value for "contains" operator (e.g., contains 25)
		rangeValue = resolveFilterValue(
			rangeExpr.scalar,
			ctx,
			aliasContext,
			outerAliases,
		);
	} /* v8 ignore start — defensive: parser guarantees range or scalar -- @preserve */ else {
		throw new NqlSemanticException(
			NqlErrorCodes.SEM_INVALID_SYNTAX,
			'Range operator requires either a range literal or scalar value',
		);
	}
	/* v8 ignore stop -- @preserve */
	const result: WhereRangeIntent = {
		kind: 'range',
		field,
		operator: rangeExpr.operator,
		value: rangeValue as WhereRangeIntent['value'],
	};
	if (rangeExpr.scalar?.type === 'namedParam') {
		ctx.paramProvenance.markParamValue(result, 'value');
	}
	return result;
}

function compileMembership(
	expr: NqlExpression,
	ctx: CompilerContext,
	fns: CompilerFns,
	aliasContext?: string,
	outerAliases?: string[],
): WhereIntent {
	if (expr.type === 'any') {
		const anyExpr = expr as NqlAnyExpression;
		const field = expressionToField(anyExpr.column, aliasContext);
		/* v8 ignore start — defensive: parser guarantees ANY LHS is a path expression -- @preserve */
		if (!field) {
			throw new NqlSemanticException(
				NqlErrorCodes.SEM_INVALID_SYNTAX,
				'ANY expression must reference a field',
			);
		}
		/* v8 ignore stop -- @preserve */
		validateWhereField(ctx, field, aliasContext, anyExpr.column);
		const rawValues = resolveNamedParamArray(ctx, anyExpr.paramName);
		if (rawValues.length > ctx.maxAnyItems) {
			throw new NqlSemanticException(
				NqlErrorCodes.SEM_INVALID_SYNTAX,
				`ANY(:${anyExpr.paramName}) array length ${rawValues.length} exceeds maximum of ${ctx.maxAnyItems}`,
			);
		}
		const values: readonly unknown[] = rawValues;
		const result = { kind: 'any', field, values } satisfies WhereAnyIntent;
		ctx.paramProvenance.markParamValue(result, 'values');
		return result;
	}

	// in
	const inExpr = expr as NqlInExpression;
	const field = expressionToField(inExpr.expression, aliasContext);
	/* v8 ignore start — defensive: parser guarantees IN LHS is a path expression -- @preserve */
	if (!field) {
		throw new NqlSemanticException(
			NqlErrorCodes.SEM_INVALID_SYNTAX,
			'IN expression must reference a field',
		);
	}
	/* v8 ignore stop -- @preserve */
	validateWhereField(ctx, field, aliasContext, inExpr.expression);

	let values: unknown[];
	if (Array.isArray(inExpr.values)) {
		values = inExpr.values.map((v) =>
			resolveFilterValue(v, ctx, aliasContext, outerAliases),
		);
		for (let i = 0; i < inExpr.values.length; i++) {
			if (inExpr.values[i]?.type === 'namedParam') {
				ctx.paramProvenance.markParamValue(values, i);
			}
		}

		// Amendment 11: detect if ALL values are date range patterns → expand to OR of ANDs
		const dateRangeValues = values.filter(
			(v): v is string => typeof v === 'string' && isDateRangePattern(v),
		);
		if (dateRangeValues.length > 0) {
			if (dateRangeValues.length !== values.length) {
				throw new NqlSemanticException(
					NqlErrorCodes.SEM_INVALID_SYNTAX,
					'Cannot mix date range patterns with regular values in IN list. ' +
						'Use all date ranges or all literals.',
				);
			}
			return expandDateRangeList(field, dateRangeValues, inExpr.negated);
		}
	} else if ('type' in inExpr.values && inExpr.values.type === 'subquery') {
		// Subquery is a full QueryIntent — contextual validation at adapter level
		// Subqueries in IN clauses are always simple queries, never set operations.
		const subquery = compileNestedQuery(
			inExpr.values.query,
			ctx,
			fns,
		) as QueryIntent;

		// Subquery branch: omit `values` per XOR constraint on WhereInIntent
		const result: WhereInIntent = {
			kind: 'in',
			field,
			subquery,
		};

		if (inExpr.negated) {
			return { kind: 'not', condition: result };
		}

		return result;
	} else if ('type' in inExpr.values && inExpr.values.type === 'dateRange') {
		// Single date range: 'YYYY-Q1' → >= start AND < end (half-open)
		return expandDateRangeList(field, [inExpr.values.value], inExpr.negated);
	} else {
		values = [];
	}

	// Values branch: omit `subquery` per XOR constraint on WhereInIntent
	const result: WhereInIntent = {
		kind: 'in',
		field,
		values,
	};

	if (inExpr.negated) {
		return { kind: 'not', condition: result };
	}

	return result;
}

function compileBetween(
	expr: NqlExpression,
	ctx: CompilerContext,
	_fns: CompilerFns,
	aliasContext?: string,
	outerAliases?: string[],
): WhereIntent {
	const between = expr as NqlBetweenExpression;
	const field = expressionToField(between.expression, aliasContext);
	/* v8 ignore start — defensive: parser guarantees BETWEEN LHS is a path -- @preserve */
	if (!field) {
		throw new NqlSemanticException(
			NqlErrorCodes.SEM_INVALID_SYNTAX,
			'BETWEEN expression must reference a field',
		);
	}
	/* v8 ignore stop -- @preserve */
	validateWhereField(ctx, field, aliasContext, between.expression);

	const lower = resolveFilterValue(
		between.low,
		ctx,
		aliasContext,
		outerAliases,
	);
	const upper = resolveFilterValue(
		between.high,
		ctx,
		aliasContext,
		outerAliases,
	);
	const lowerValue = lower;
	const upperValue = upper;

	assertBetweenBoundValueAllowed('lower', between.low, lowerValue);
	assertBetweenBoundValueAllowed('upper', between.high, upperValue);

	const value = { lower, upper };
	if (between.low.type === 'namedParam') {
		ctx.paramProvenance.markParamValue(value, 'lower');
	}
	if (between.high.type === 'namedParam') {
		ctx.paramProvenance.markParamValue(value, 'upper');
	}
	return {
		kind: 'range',
		field,
		operator: 'between',
		value,
	};
}

function assertBetweenBoundValueAllowed(
	position: 'lower' | 'upper',
	expr: NqlExpression,
	value: unknown,
): void {
	if (
		value === null ||
		typeof value === 'number' ||
		typeof value === 'string' ||
		typeof value === 'bigint' ||
		value instanceof Date
	) {
		return;
	}

	const paramSuffix = expr.type === 'namedParam' ? `; param :${expr.name}` : '';
	throw new NqlSemanticException(
		NqlErrorCodes.SEM_INVALID_SYNTAX,
		`BETWEEN ${position} bound must be a literal number, string, or date, or a bigint param; got type ${typeof value}${paramSuffix}.`,
	);
}

function compileNull(
	expr: NqlExpression,
	ctx: CompilerContext,
	aliasContext?: string,
): WhereIntent {
	const isNull = expr as NqlIsNullExpression;
	const field = expressionToField(isNull.expression, aliasContext);
	/* v8 ignore start — defensive: parser guarantees IS NULL LHS is a path -- @preserve */
	if (!field) {
		throw new NqlSemanticException(
			NqlErrorCodes.SEM_INVALID_SYNTAX,
			'IS NULL expression must reference a field',
		);
	}
	/* v8 ignore stop -- @preserve */
	validateWhereField(ctx, field, aliasContext, isNull.expression);

	return {
		kind: 'null',
		field,
		operator: isNull.negated ? 'isNotNull' : 'isNull',
	};
}

function compileJson(
	expr: NqlExpression,
	ctx: CompilerContext,
	_fns: CompilerFns,
	aliasContext?: string,
	outerAliases?: string[],
): WhereIntent {
	if (expr.type === 'function') {
		// JSON function notation in WHERE context
		const fn = expr.name.toLowerCase();
		if (fn === 'json_contains' || fn === 'json_contained_by') {
			/* v8 ignore start — defensive: parser guarantees at least 2 args -- @preserve */
			if (expr.args.length < 2) {
				throw new NqlSemanticException(
					NqlErrorCodes.SEM_INVALID_SYNTAX,
					`${fn}() requires 2 arguments: field and value`,
				);
			}
			/* v8 ignore stop -- @preserve */
			const jsonField = expressionToField(expr.args[0]!, aliasContext);
			/* v8 ignore start — defensive: first arg is always a field reference -- @preserve */
			if (!jsonField) {
				throw new NqlSemanticException(
					NqlErrorCodes.SEM_INVALID_SYNTAX,
					`${fn}() first argument must be a field reference`,
				);
			}
			/* v8 ignore stop -- @preserve */
			const jsonValue = resolveFilterValue(
				expr.args[1]!,
				ctx,
				aliasContext,
				outerAliases,
			);
			const intent = {
				kind: 'jsonContains',
				field: jsonField,
				value: jsonValue,
				reversed: fn === 'json_contained_by',
			} satisfies WhereJsonContainsIntent;
			if (expr.args[1]?.type === 'namedParam') {
				ctx.paramProvenance.markParamValue(intent, 'value');
			}
			return intent;
		}
		if (fn === 'json_exists') {
			/* v8 ignore start — defensive: parser guarantees at least 2 args -- @preserve */
			if (expr.args.length < 2) {
				throw new NqlSemanticException(
					NqlErrorCodes.SEM_INVALID_SYNTAX,
					`${fn}() requires 2 arguments: field and key`,
				);
			}
			/* v8 ignore stop -- @preserve */
			const jsonField = expressionToField(expr.args[0]!, aliasContext);
			/* v8 ignore start — defensive: first arg is always a field reference -- @preserve */
			if (!jsonField) {
				throw new NqlSemanticException(
					NqlErrorCodes.SEM_INVALID_SYNTAX,
					`${fn}() first argument must be a field reference`,
				);
			}
			/* v8 ignore stop -- @preserve */
			// Route through coerceToStringKey: handles single-segment path identifiers
			// (e.g. json_exists(data, email) → key='email') and rejects dotted paths
			// and non-string values that would silently yield '[object Object]'.
			const key = coerceToStringKey(expr.args[1]!, `${fn}() key`, ctx);
			return {
				kind: 'jsonExists',
				field: jsonField,
				key,
			} satisfies WhereJsonExistsIntent;
		}
		/* v8 ignore next — defensive: only json_* functions reach WHERE context -- @preserve */
		throw new NqlSemanticException(
			NqlErrorCodes.SEM_INVALID_SYNTAX,
			`Unsupported function in WHERE context: ${fn}()`,
		);
	}

	// jsonComparison
	const jsonComp = expr as NqlJsonComparisonExpression;
	const jsonField = expressionToField(jsonComp.left, aliasContext);
	/* v8 ignore start — defensive: parser guarantees LHS is a path expression -- @preserve */
	if (!jsonField) {
		throw new NqlSemanticException(
			NqlErrorCodes.SEM_INVALID_SYNTAX,
			'Left side of JSON comparison must be a field reference',
		);
	}
	/* v8 ignore stop -- @preserve */

	if (jsonComp.operator === '?') {
		// S-3: String(resolveFilterValue(...)) would silently yield '[object Object]'
		// for path expressions — use coerceToStringKey to reject non-string RHS.
		const key = coerceToStringKey(jsonComp.right, '? operator key', ctx);
		return {
			kind: 'jsonExists',
			field: jsonField,
			key,
		} satisfies WhereJsonExistsIntent;
	}

	// @> or <@
	const jsonValue = resolveFilterValue(
		jsonComp.right,
		ctx,
		aliasContext,
		outerAliases,
	);
	const intent = {
		kind: 'jsonContains',
		field: jsonField,
		value: jsonValue,
		reversed: jsonComp.operator === '<@',
	} satisfies WhereJsonContainsIntent;
	if (jsonComp.right.type === 'namedParam') {
		ctx.paramProvenance.markParamValue(intent, 'value');
	}
	return intent;
}

function compileRelationFilter(
	expr: NqlExpression,
	ctx: CompilerContext,
	fns: CompilerFns,
	aliasContext?: string,
	outerAliases?: string[],
): WhereIntent {
	// SPEC-002: Cross-table relation filters
	const relFilter = expr as NqlRelationFilterExpression;
	// Build alias stack: current aliasContext (if any) becomes an outer alias for nested filters
	const nestedOuterAliases = aliasContext
		? [...(outerAliases ?? []), aliasContext]
		: (outerAliases ?? []);
	// Resolve relation target for inner scope validation (first segment of relation path)
	const prevRelationTarget = ctx.currentRelationTarget;
	if (ctx.currentFromTable && ctx.validator && relFilter.relation[0]) {
		ctx.currentRelationTarget = ctx.validator.resolveRelationTarget(
			ctx.currentFromTable,
			relFilter.relation[0],
		);
	}
	const where = compileExpression(
		relFilter.condition,
		ctx,
		fns,
		relFilter.alias,
		nestedOuterAliases,
	);
	ctx.currentRelationTarget = prevRelationTarget;
	return {
		kind: 'relationFilter',
		relation: relFilter.relation,
		where,
		mode: relFilter.mode,
		...(relFilter.alias !== undefined && { alias: relFilter.alias }),
	};
}

// ---------------------------------------------------------------------------
// Date range helpers
// ---------------------------------------------------------------------------

/**
 * Expand one or more date range patterns into a WhereIntent.
 *
 * - Single pattern → WhereAndIntent (gte + lt)
 * - Multiple patterns → WhereOrIntent containing N WhereAndIntent children
 * - Negated → wraps in WhereNotIntent
 */
function expandDateRangeList(
	field: string,
	patterns: string[],
	negated: boolean,
): WhereIntent {
	const conditions = patterns.map((pattern) => {
		const { start, end } = expandDateRange(pattern);
		return {
			kind: 'and',
			conditions: [
				{
					kind: 'comparison',
					field,
					operator: 'gte',
					value: start,
				} satisfies WhereComparisonIntent,
				{
					kind: 'comparison',
					field,
					operator: 'lt',
					value: end,
				} satisfies WhereComparisonIntent,
			],
		} as WhereIntent;
	});

	const result: WhereIntent =
		conditions.length === 1 ? conditions[0]! : { kind: 'or', conditions };

	if (negated) {
		return { kind: 'not', condition: result };
	}

	return result;
}

// ---------------------------------------------------------------------------
// Main dispatcher (thin switch)
// ---------------------------------------------------------------------------

/**
 * Compile a boolean expression to a WhereIntent tree.
 */
export function compileExpression(
	expr: NqlExpression,
	ctx: CompilerContext,
	fns: CompilerFns,
	aliasContext?: string,
	outerAliases?: string[],
): WhereIntent {
	switch (expr.type) {
		case 'binary':
		case 'unary':
			return compileLogical(expr, ctx, fns, aliasContext, outerAliases);
		case 'comparison':
			return compileComparison(expr, ctx, fns, aliasContext, outerAliases);
		case 'rangeOp':
			return compileRange(expr, ctx, fns, aliasContext, outerAliases);
		case 'in':
		case 'any':
			return compileMembership(expr, ctx, fns, aliasContext, outerAliases);
		case 'between':
			return compileBetween(expr, ctx, fns, aliasContext, outerAliases);
		case 'isNull':
			return compileNull(expr, ctx, aliasContext);
		case 'jsonComparison':
		case 'function':
			return compileJson(expr, ctx, fns, aliasContext, outerAliases);
		case 'relationFilter':
			return compileRelationFilter(expr, ctx, fns, aliasContext, outerAliases);
		case 'case':
			throw new NqlSemanticException(
				NqlErrorCodes.SEM_INVALID_SYNTAX,
				'CASE in WHERE not supported. ' +
					'Use a computed column in SELECT or a relation filter instead.',
			);
		case 'exists':
			throw new NqlSemanticException(
				NqlErrorCodes.SEM_INVALID_SYNTAX,
				'EXISTS (subquery) is not supported in NQL. ' +
					'Use relation filters instead:\n' +
					'  orders | with customer | where customer.active = true\n' +
					'  orders | where exists(customer, active = true)\n' +
					'These compile to efficient EXISTS subqueries automatically.',
			);
		/* v8 ignore next — defensive: all parser-produced expression types are handled above -- @preserve */
		default:
			throw new NqlSemanticException(
				NqlErrorCodes.SEM_INVALID_SYNTAX,
				`Unsupported expression type in WHERE: ${expr.type}`,
			);
	}
}
