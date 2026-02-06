/* biome-ignore-all lint/style/noNonNullAssertion: NQL AST node access requires non-null assertions on validated parse tree */
/**
 * @module compiler/compile-expression
 * Compiles NQL boolean expressions to WhereIntent (WHERE/HAVING clauses).
 */

import type { WhereInIntent, WhereIntent, WhereRangeIntent } from '@dbsp/types';
import type {
	NqlBetweenExpression,
	NqlBinaryExpression,
	NqlComparisonExpression,
	NqlExpression,
	NqlInExpression,
	NqlIsNullExpression,
	NqlRangeOpExpression,
	NqlRelationFilterExpression,
	NqlUnaryExpression,
} from '../parser/ast.js';
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
			// Arithmetic binary → comparison context shouldn't reach here
			throw new Error(
				`Unsupported binary operator in WHERE: ${binary.operator}`,
			);
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
			throw new Error(`Unsupported unary operator: ${unary.operator}`);
		}

		case 'comparison': {
			const comp = expr as NqlComparisonExpression;
			const field = expressionToField(comp.left, aliasContext);
			if (!field) {
				throw new Error('Left side of comparison must be a field reference');
			}
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
			if (!field) {
				throw new Error(
					'Left side of range operator must be a field reference',
				);
			}
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
			} else {
				throw new Error(
					'Range operator requires either a range literal or scalar value',
				);
			}
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
			if (!field) {
				throw new Error('IN expression must reference a field');
			}
			validateWhereField(ctx, field, aliasContext, inExpr.expression);

			let values: unknown[];
			if (Array.isArray(inExpr.values)) {
				values = inExpr.values.map((v) =>
					resolveFilterValue(v, ctx, aliasContext, outerAliases),
				);
			} else if ('type' in inExpr.values && inExpr.values.type === 'subquery') {
				// Subquery is a full QueryIntent — contextual validation at adapter level
				const subquery = fns.compileQuery(inExpr.values.query, ctx);

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
				// Date range requires semantic date expansion (planned for future release)
				throw new Error(
					'Date range in IN clause is not yet supported. ' +
						'Use explicit BETWEEN instead:\n' +
						'  table | where date between "2024-01-01" and "2024-12-31"',
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
			if (!field) {
				throw new Error('BETWEEN expression must reference a field');
			}
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
			if (!field) {
				throw new Error('IS NULL expression must reference a field');
			}
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

		default:
			throw new Error(`Unsupported expression type in WHERE: ${expr.type}`);
	}
}
