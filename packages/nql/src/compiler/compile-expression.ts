/* biome-ignore-all lint/style/noNonNullAssertion: NQL AST node access requires non-null assertions on validated parse tree */
/**
 * @module compiler/compile-expression
 * Compiles NQL boolean expressions to WhereIntent (WHERE/HAVING clauses).
 */

import type {
	QueryIntent,
	WhereComparisonIntent,
	WhereInIntent,
	WhereIntent,
	WhereJsonContainsIntent,
	WhereJsonExistsIntent,
	WhereRangeIntent,
} from '@dbsp/types';
import type {
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
import { expandDateRange, isDateRangePattern } from './date-range-patterns.js';
import {
	expressionToField,
	expressionToRangeValue,
	mapComparisonOperator,
	resolveFilterValue,
	validateWhereField,
} from './expression-utils.js';
import type { CompilerContext, CompilerFns } from './types.js';

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
		case 'binary': {
			const binary = expr as NqlBinaryExpression;
			if (binary.operator === 'and') {
				return {
					kind: 'and',
					conditions: [
						compileExpression(
							binary.left,
							ctx,
							fns,
							aliasContext,
							outerAliases,
						),
						compileExpression(
							binary.right,
							ctx,
							fns,
							aliasContext,
							outerAliases,
						),
					],
				};
			}
			if (binary.operator === 'or') {
				return {
					kind: 'or',
					conditions: [
						compileExpression(
							binary.left,
							ctx,
							fns,
							aliasContext,
							outerAliases,
						),
						compileExpression(
							binary.right,
							ctx,
							fns,
							aliasContext,
							outerAliases,
						),
					],
				};
			}
			/* v8 ignore start — defensive: only and/or reach here; arithmetic is in SELECT context -- @preserve */
			// Arithmetic binary → comparison context shouldn't reach here
			throw new Error(
				`Unsupported binary operator in WHERE: ${binary.operator}`,
			);
			/* v8 ignore stop -- @preserve */
		}

		case 'unary': {
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
			throw new Error(`Unsupported unary operator: ${unary.operator}`);
		}

		case 'comparison': {
			const comp = expr as NqlComparisonExpression;

			// JSON access on LHS: data->'key' = 'val'
			if (comp.left.type === 'jsonAccess') {
				const jsonLeft = comp.left as NqlJsonAccessExpression;
				const baseField = expressionToField(jsonLeft.base, aliasContext);
				/* v8 ignore start — defensive: jsonAccess base is always a path expression -- @preserve */
				if (!baseField) {
					throw new Error('JSON access base must be a field reference');
				}
				/* v8 ignore stop -- @preserve */
				const operator = mapComparisonOperator(comp.operator);
				const value = resolveFilterValue(
					comp.right,
					ctx,
					aliasContext,
					outerAliases,
				);
				return {
					kind: 'comparison',
					field: baseField,
					operator,
					value,
					jsonPath: jsonLeft.path,
					jsonMode: jsonLeft.mode,
				} satisfies WhereComparisonIntent;
			}

			// JSON function on LHS: json_extract_text(data, 'key') = 'val'
			if (comp.left.type === 'function') {
				const fn = comp.left.name.toLowerCase();
				if (fn === 'json_extract' || fn === 'json_extract_text') {
					/* v8 ignore start — defensive: parser guarantees at least 2 args for json_extract -- @preserve */
					if (comp.left.args.length < 2) {
						throw new Error(`${fn}() requires at least 2 arguments`);
					}
					/* v8 ignore stop -- @preserve */
					const baseField = expressionToField(comp.left.args[0]!, aliasContext);
					/* v8 ignore start — defensive: first arg is always a field reference -- @preserve */
					if (!baseField) {
						throw new Error(`${fn}() first argument must be a field reference`);
					}
					/* v8 ignore stop -- @preserve */
					const keys = comp.left.args
						.slice(1)
						.map((a) =>
							String(resolveFilterValue(a, ctx, aliasContext, outerAliases)),
						);
					const operator = mapComparisonOperator(comp.operator);
					const value = resolveFilterValue(
						comp.right,
						ctx,
						aliasContext,
						outerAliases,
					);
					return {
						kind: 'comparison',
						field: baseField,
						operator,
						value,
						jsonPath: keys,
						jsonMode: fn === 'json_extract' ? 'json' : 'text',
					} satisfies WhereComparisonIntent;
				}
			}

			const field = expressionToField(comp.left, aliasContext);
			/* v8 ignore start — defensive: parser guarantees LHS is a path expression -- @preserve */
			if (!field) {
				throw new Error('Left side of comparison must be a field reference');
			}
			/* v8 ignore stop -- @preserve */
			// Validate WHERE column on current table context
			validateWhereField(ctx, field, aliasContext, comp.left);

			// Handle LIKE specially
			if (comp.operator === 'like') {
				const pattern = resolveFilterValue(
					comp.right,
					ctx,
					aliasContext,
					outerAliases,
				);
				return {
					kind: 'like',
					field,
					pattern: String(pattern),
				};
			}

			const operator = mapComparisonOperator(comp.operator);
			const value = resolveFilterValue(
				comp.right,
				ctx,
				aliasContext,
				outerAliases,
			);

			return {
				kind: 'comparison',
				field,
				operator,
				value,
			};
		}

		case 'rangeOp': {
			const rangeExpr = expr as NqlRangeOpExpression;
			const field = expressionToField(rangeExpr.left, aliasContext);
			/* v8 ignore start — defensive: parser guarantees LHS is a path expression -- @preserve */
			if (!field) {
				throw new Error(
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
				throw new Error(
					'Range operator requires either a range literal or scalar value',
				);
			}
			/* v8 ignore stop -- @preserve */
			return {
				kind: 'range',
				field,
				operator: rangeExpr.operator,
				value: rangeValue,
			} as WhereRangeIntent;
		}

		case 'in': {
			const inExpr = expr as NqlInExpression;
			const field = expressionToField(inExpr.expression, aliasContext);
			/* v8 ignore start — defensive: parser guarantees IN LHS is a path expression -- @preserve */
			if (!field) {
				throw new Error('IN expression must reference a field');
			}
			/* v8 ignore stop -- @preserve */
			validateWhereField(ctx, field, aliasContext, inExpr.expression);

			let values: unknown[];
			if (Array.isArray(inExpr.values)) {
				values = inExpr.values.map((v) =>
					resolveFilterValue(v, ctx, aliasContext, outerAliases),
				);

				// Amendment 11: detect if ALL values are date range patterns → expand to OR of ANDs
				const dateRangeValues = values.filter(
					(v): v is string => typeof v === 'string' && isDateRangePattern(v),
				);
				if (dateRangeValues.length > 0) {
					if (dateRangeValues.length !== values.length) {
						throw new Error(
							'Cannot mix date range patterns with regular values in IN list. ' +
								'Use all date ranges or all literals.',
						);
					}
					return expandDateRangeList(field, dateRangeValues, inExpr.negated);
				}
			} else if ('type' in inExpr.values && inExpr.values.type === 'subquery') {
				// Subquery is a full QueryIntent — contextual validation at adapter level
				// Subqueries in IN clauses are always simple queries, never set operations
				const subquery = fns.compileQuery(
					inExpr.values.query,
					ctx,
				) as QueryIntent;

				const result: WhereInIntent = {
					kind: 'in',
					field,
					values: [],
					subquery,
				};

				if (inExpr.negated) {
					return { kind: 'not', condition: result };
				}

				return result;
			} else if (
				'type' in inExpr.values &&
				inExpr.values.type === 'dateRange'
			) {
				// Single date range: 'YYYY-Q1' → >= start AND < end (half-open)
				return expandDateRangeList(
					field,
					[inExpr.values.value],
					inExpr.negated,
				);
			} else {
				values = [];
			}

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

		case 'between': {
			const between = expr as NqlBetweenExpression;
			const field = expressionToField(between.expression, aliasContext);
			/* v8 ignore start — defensive: parser guarantees BETWEEN LHS is a path -- @preserve */
			if (!field) {
				throw new Error('BETWEEN expression must reference a field');
			}
			/* v8 ignore stop -- @preserve */
			validateWhereField(ctx, field, aliasContext, between.expression);

			return {
				kind: 'range',
				field,
				operator: 'between',
				value: {
					lower: resolveFilterValue(
						between.low,
						ctx,
						aliasContext,
						outerAliases,
					),
					upper: resolveFilterValue(
						between.high,
						ctx,
						aliasContext,
						outerAliases,
					),
				},
			};
		}

		case 'isNull': {
			const isNull = expr as NqlIsNullExpression;
			const field = expressionToField(isNull.expression, aliasContext);
			/* v8 ignore start — defensive: parser guarantees IS NULL LHS is a path -- @preserve */
			if (!field) {
				throw new Error('IS NULL expression must reference a field');
			}
			/* v8 ignore stop -- @preserve */
			validateWhereField(ctx, field, aliasContext, isNull.expression);

			return {
				kind: 'null',
				field,
				operator: isNull.negated ? 'isNotNull' : 'isNull',
			};
		}

		case 'exists': {
			// EXISTS (subquery) syntax is parsed but not yet fully supported
			throw new Error(
				'EXISTS (subquery) is not supported in NQL. ' +
					'Use relation filters instead:\n' +
					'  orders | with customer | where customer.active = true\n' +
					'  orders | where exists(customer, active = true)\n' +
					'These compile to efficient EXISTS subqueries automatically.',
			);
		}

		case 'relationFilter': {
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

		case 'function': {
			// JSON function notation in WHERE context
			const fn = expr.name.toLowerCase();
			if (fn === 'json_contains' || fn === 'json_contained_by') {
				/* v8 ignore start — defensive: parser guarantees at least 2 args -- @preserve */
				if (expr.args.length < 2) {
					throw new Error(`${fn}() requires 2 arguments: field and value`);
				}
				/* v8 ignore stop -- @preserve */
				const jsonField = expressionToField(expr.args[0]!, aliasContext);
				/* v8 ignore start — defensive: first arg is always a field reference -- @preserve */
				if (!jsonField) {
					throw new Error(`${fn}() first argument must be a field reference`);
				}
				/* v8 ignore stop -- @preserve */
				const jsonValue = resolveFilterValue(
					expr.args[1]!,
					ctx,
					aliasContext,
					outerAliases,
				);
				return {
					kind: 'jsonContains',
					field: jsonField,
					value: jsonValue,
					reversed: fn === 'json_contained_by',
				} satisfies WhereJsonContainsIntent;
			}
			if (fn === 'json_exists') {
				/* v8 ignore start — defensive: parser guarantees at least 2 args -- @preserve */
				if (expr.args.length < 2) {
					throw new Error(`${fn}() requires 2 arguments: field and key`);
				}
				/* v8 ignore stop -- @preserve */
				const jsonField = expressionToField(expr.args[0]!, aliasContext);
				/* v8 ignore start — defensive: first arg is always a field reference -- @preserve */
				if (!jsonField) {
					throw new Error(`${fn}() first argument must be a field reference`);
				}
				/* v8 ignore stop -- @preserve */
				const key = resolveFilterValue(
					expr.args[1]!,
					ctx,
					aliasContext,
					outerAliases,
				);
				return {
					kind: 'jsonExists',
					field: jsonField,
					key: String(key),
				} satisfies WhereJsonExistsIntent;
			}
			/* v8 ignore next — defensive: only json_* functions reach WHERE context -- @preserve */
			throw new Error(`Unsupported function in WHERE context: ${fn}()`);
		}

		case 'jsonComparison': {
			const jsonComp = expr as NqlJsonComparisonExpression;
			const jsonField = expressionToField(jsonComp.left, aliasContext);
			/* v8 ignore start — defensive: parser guarantees LHS is a path expression -- @preserve */
			if (!jsonField) {
				throw new Error(
					'Left side of JSON comparison must be a field reference',
				);
			}
			/* v8 ignore stop -- @preserve */

			if (jsonComp.operator === '?') {
				const key = resolveFilterValue(
					jsonComp.right,
					ctx,
					aliasContext,
					outerAliases,
				);
				return {
					kind: 'jsonExists',
					field: jsonField,
					key: String(key),
				} satisfies WhereJsonExistsIntent;
			}

			// @> or <@
			const jsonValue = resolveFilterValue(
				jsonComp.right,
				ctx,
				aliasContext,
				outerAliases,
			);
			return {
				kind: 'jsonContains',
				field: jsonField,
				value: jsonValue,
				reversed: jsonComp.operator === '<@',
			} satisfies WhereJsonContainsIntent;
		}

		/* v8 ignore next — defensive: all parser-produced expression types are handled above -- @preserve */
		default:
			throw new Error(`Unsupported expression type in WHERE: ${expr.type}`);
	}
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
