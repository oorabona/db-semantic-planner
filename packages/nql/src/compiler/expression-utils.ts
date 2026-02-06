/**
 * @module compiler/expression-utils
 * Pure expression utility functions for the NQL compiler.
 * No shared state — all functions are stateless.
 */

import type { ComparisonOperator, FieldRef } from '@dbsp/types';
import type {
	NqlBinaryExpression,
	NqlExpression,
	NqlPathExpression,
	NqlRangeLiteral,
	NqlUnaryExpression,
} from '../parser/ast.js';
import type { CompilerContext } from './types.js';

/**
 * Extract a field name from an expression, or null if not a simple field reference.
 */
export function expressionToField(
	expr: NqlExpression,
	aliasContext?: string,
): string | null {
	if (expr.type === 'path') {
		const segments = expr.segments;
		// Strip relation filter alias prefix (e.g., "o.status" → "status" when alias is "o")
		if (aliasContext && segments.length > 1 && segments[0] === aliasContext) {
			return segments.slice(1).join('.');
		}
		return segments.join('.');
	}
	return null;
}

/**
 * Convert an expression to a plain value for use in intents.
 */
export function expressionToValue(expr: NqlExpression): unknown {
	switch (expr.type) {
		case 'string':
			return expr.value;
		case 'number':
			return expr.value;
		case 'boolean':
			return expr.value;
		case 'null':
			return null;
		case 'path':
			// Path in value context → treat as field reference (for computed columns)
			return { $ref: expr.segments.join('.') };
		case 'function': {
			// Function call in value context → special value
			return {
				$fn: expr.name,
				$args: expr.args.map((a) => expressionToValue(a)),
			};
		}
		case 'binary': {
			// Arithmetic expression → special value
			const binary = expr as NqlBinaryExpression;
			return {
				$op: binary.operator,
				$left: expressionToValue(binary.left),
				$right: expressionToValue(binary.right),
			};
		}
		case 'unary': {
			// Unary expression (e.g., -price, -5)
			const unary = expr as NqlUnaryExpression;
			if (unary.operator === '-') {
				const operand = expressionToValue(unary.operand);
				// Optimize: if operand is a number, negate it directly
				if (typeof operand === 'number') {
					return -operand;
				}
				// Otherwise, represent as multiplication by -1
				return {
					$op: '*',
					$left: -1,
					$right: operand,
				};
			}
			// 'not' operator shouldn't reach here (handled in compileExpression)
			throw new Error(
				`Unsupported unary operator in value context: ${unary.operator}`,
			);
		}
		default:
			throw new Error(`Cannot convert ${expr.type} to value`);
	}
}

/**
 * Convert an expression to a SQL-like string representation.
 */
export function expressionToSql(expr: NqlExpression): string {
	switch (expr.type) {
		case 'path':
			return expr.segments.join('.');
		case 'string':
			return `'${expr.value.replace(/'/g, "''")}'`;
		case 'number':
			return String(expr.value);
		case 'boolean':
			return expr.value ? 'true' : 'false';
		case 'null':
			return 'NULL';
		case 'function':
			return `${expr.name}(${expr.args.map((a) => expressionToSql(a)).join(', ')})`;
		case 'binary': {
			const binary = expr as NqlBinaryExpression;
			return `(${expressionToSql(binary.left)} ${binary.operator} ${expressionToSql(binary.right)})`;
		}
		case 'unary': {
			const unary = expr as NqlUnaryExpression;
			return `${unary.operator} ${expressionToSql(unary.operand)}`;
		}
		default:
			return String(expr);
	}
}

/**
 * Extract range value from expression (for range operators).
 * Returns either the raw range literal string or a scalar value.
 */
export function expressionToRangeValue(expr: NqlExpression): string {
	if (expr.type === 'rangeLiteral') {
		const range = expr as NqlRangeLiteral;
		return range.value;
	}
	// For scalar values (e.g., `contains 25`), convert to string
	if (expr.type === 'number') {
		return String(expr.value);
	}
	if (expr.type === 'string') {
		return expr.value;
	}
	throw new Error(
		`Range operator requires a range literal or scalar value, got ${expr.type}`,
	);
}

/**
 * Resolve a filter RHS value, producing FieldRef when inside an aliased relation filter.
 * Outside alias context, delegates to expressionToValue().
 */
export function resolveFilterValue(
	expr: NqlExpression,
	ctx: CompilerContext,
	aliasContext?: string,
	outerAliases?: string[],
): unknown {
	// No alias context → standard value resolution (literals, $ref, etc.)
	if (!aliasContext) return expressionToValue(expr);

	// Only path expressions can produce FieldRef
	if (expr.type === 'path') {
		const segments = (expr as NqlPathExpression).segments;
		// alias-prefixed: e.g., "r.col" when aliasContext = "r"
		if (segments.length > 1 && segments[0] === aliasContext) {
			const column = segments.slice(1).join('.');
			// Validate inner scope column against relation's target table
			if (ctx.currentRelationTarget && !column.includes('.')) {
				ctx.validator?.validateColumn(ctx.currentRelationTarget, column);
			}
			return {
				kind: 'fieldRef',
				column,
				scope: 'inner',
			} satisfies FieldRef;
		}
		// outer alias-prefixed: e.g., "x.col" when outerAliases includes "x"
		const firstSegment = segments[0];
		if (
			outerAliases &&
			firstSegment &&
			segments.length > 1 &&
			outerAliases.includes(firstSegment)
		) {
			const column = segments.slice(1).join('.');
			// Outer alias → validate against root table
			if (ctx.currentFromTable && !column.includes('.')) {
				ctx.validator?.validateColumn(ctx.currentFromTable, column);
			}
			return {
				kind: 'fieldRef',
				column,
				scope: 'outer',
				alias: firstSegment,
			} satisfies FieldRef;
		}
		// bare column in aliased context → outer scope reference to root table
		const bareColumn = segments.join('.');
		if (ctx.currentFromTable && !bareColumn.includes('.')) {
			ctx.validator?.validateColumn(ctx.currentFromTable, bareColumn);
		}
		return {
			kind: 'fieldRef',
			column: bareColumn,
			scope: 'outer',
		} satisfies FieldRef;
	}

	// Non-path expressions (literals, functions, etc.) → standard value
	return expressionToValue(expr);
}

/**
 * Map a comparison operator string to a ComparisonOperator enum value.
 */
export function mapComparisonOperator(
	op: '=' | '!=' | '<' | '>' | '<=' | '>=' | 'like',
): ComparisonOperator {
	switch (op) {
		case '=':
			return 'eq';
		case '!=':
			return 'neq';
		case '<':
			return 'lt';
		case '>':
			return 'gt';
		case '<=':
			return 'lte';
		case '>=':
			return 'gte';
		default:
			throw new Error(`Cannot map operator ${op} to ComparisonOperator`);
	}
}

/**
 * Check if a function name is an aggregate function.
 */
export function isAggregateFunction(name: string): boolean {
	return [
		'count',
		'sum',
		'avg',
		'min',
		'max',
		'array_agg',
		'string_agg',
	].includes(name.toLowerCase());
}

/**
 * Validate a WHERE field reference against the current table context.
 * Handles dotted paths (relation.column) and aliased context (relation filters).
 */
export function validateWhereField(
	ctx: CompilerContext,
	field: string,
	aliasContext?: string,
	originalExpr?: NqlExpression,
): void {
	if (!ctx.validator) return;
	if (aliasContext) {
		// Inside relation filter — determine if field is inner or outer scope
		const isInnerScope =
			originalExpr?.type === 'path' &&
			(originalExpr as NqlPathExpression).segments.length > 1 &&
			(originalExpr as NqlPathExpression).segments[0] === aliasContext;
		if (isInnerScope) {
			// Inner scope → validate against relation's target table
			if (ctx.currentRelationTarget && !field.includes('.')) {
				ctx.validator.validateColumn(ctx.currentRelationTarget, field);
			}
		} else {
			// Outer scope (bare column or non-alias-prefixed) → validate against root table
			if (ctx.currentFromTable && !field.includes('.')) {
				ctx.validator.validateColumn(ctx.currentFromTable, field);
			}
		}
		return;
	}
	// If inside a relation filter (dot-syntax, no alias), validate against relation target
	if (ctx.currentRelationTarget && !field.includes('.')) {
		ctx.validator.validateColumn(ctx.currentRelationTarget, field);
		return;
	}
	// Simple column on root table
	if (ctx.currentFromTable && !field.includes('.')) {
		ctx.validator.validateColumn(ctx.currentFromTable, field);
	}
}
