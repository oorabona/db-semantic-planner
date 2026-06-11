/**
 * @module compiler/expression-utils
 * Pure expression utility functions for the NQL compiler.
 * No shared state — all functions are stateless.
 */

import {
	type ComparisonOperator,
	type FieldRef,
	NQL_SELECT_AGGREGATE_FUNCTIONS,
} from '@dbsp/types';
import { NqlErrorCodes, NqlSemanticException } from '../errors/types.js';
import type {
	NqlBinaryExpression,
	NqlExpression,
	NqlLimitCount,
	NqlNamedParamExpr,
	NqlPathExpression,
	NqlRangeLiteral,
	NqlUnaryExpression,
} from '../parser/ast.js';
import type { CompilerContext } from './types.js';

const FORBIDDEN_PARAM_NAMES = new Set([
	'__proto__',
	'constructor',
	'prototype',
]);

function isReservedAutoParamName(name: string): boolean {
	return name.startsWith('__p');
}

function assertParamNameAllowed(
	name: string,
	ctx?: Pick<CompilerContext, 'allowInternalParams'>,
): void {
	if (FORBIDDEN_PARAM_NAMES.has(name)) {
		throw new NqlSemanticException(
			NqlErrorCodes.SEM_INVALID_SYNTAX,
			`Named parameter :${name} is reserved and cannot be bound`,
		);
	}
	if (!ctx?.allowInternalParams && isReservedAutoParamName(name)) {
		throw new NqlSemanticException(
			NqlErrorCodes.SEM_INVALID_SYNTAX,
			`Named parameter :${name} uses the reserved __p namespace`,
		);
	}
}

function assertParamValueAllowed(name: string, value: unknown): void {
	if (value === undefined) {
		throw new NqlSemanticException(
			NqlErrorCodes.SEM_INVALID_SYNTAX,
			`Named parameter :${name} must not be undefined; use null to bind SQL NULL`,
		);
	}
	if (typeof value === 'number' && !Number.isFinite(value)) {
		throw new NqlSemanticException(
			NqlErrorCodes.SEM_INVALID_SYNTAX,
			`Named parameter :${name} must be a finite number`,
		);
	}
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			assertParamValueAllowed(`${name}[${i}]`, value[i]);
		}
	}
}

/**
 * Validate all caller-supplied params keys before compilation.
 */
export function validateParamsMap(
	params: Readonly<Record<string, unknown>>,
	ctx?: Pick<CompilerContext, 'allowInternalParams'>,
): void {
	for (const key of Object.getOwnPropertyNames(params)) {
		assertParamNameAllowed(key, ctx);
		assertParamValueAllowed(key, params[key]);
	}
}

/**
 * Resolve one NQL `:name` bound parameter from the compiler context.
 */
export function resolveNamedParam(ctx: CompilerContext, name: string): unknown {
	assertParamNameAllowed(name, ctx);
	if (!Object.hasOwn(ctx.params, name)) {
		throw new NqlSemanticException(
			NqlErrorCodes.SEM_INVALID_SYNTAX,
			`Named parameter :${name} is not bound`,
		);
	}
	const value = ctx.params[name];
	assertParamValueAllowed(name, value);
	return value;
}

/**
 * Resolve `ANY(:name)` and validate it as an array after the shared value checks.
 */
export function resolveNamedParamArray(
	ctx: CompilerContext,
	name: string,
): readonly unknown[] {
	const value = resolveNamedParam(ctx, name);
	if (!Array.isArray(value)) {
		throw new NqlSemanticException(
			NqlErrorCodes.SEM_INVALID_SYNTAX,
			`ANY(:${name}) requires an array argument`,
		);
	}
	return value;
}

export function resolveIntegerCount(
	count: NqlLimitCount,
	ctx: CompilerContext,
	label: string,
): number {
	const value: unknown =
		typeof count === 'number' ? count : resolveNamedParam(ctx, count.name);
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
		throw new NqlSemanticException(
			NqlErrorCodes.SEM_INVALID_SYNTAX,
			`${label} must resolve to a non-negative safe integer`,
		);
	}
	return value;
}

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
export function expressionToValue(
	expr: NqlExpression,
	ctx?: CompilerContext,
): unknown {
	switch (expr.type) {
		case 'namedParam':
			if (!ctx) {
				throw new NqlSemanticException(
					NqlErrorCodes.SEM_UNREACHABLE,
					`Cannot resolve named parameter :${(expr as NqlNamedParamExpr).name} without compiler context`,
				);
			}
			return resolveNamedParam(ctx, (expr as NqlNamedParamExpr).name);
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
				$args: expr.args.map((a) => expressionToValue(a, ctx)),
			};
		}
		case 'binary': {
			// Arithmetic expression → special value
			const binary = expr as NqlBinaryExpression;
			return {
				$op: binary.operator,
				$left: expressionToValue(binary.left, ctx),
				$right: expressionToValue(binary.right, ctx),
			};
		}
		case 'unary': {
			// Unary expression (e.g., -price, -5)
			const unary = expr as NqlUnaryExpression;
			if (unary.operator === '-') {
				const operand = expressionToValue(unary.operand, ctx);
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
		case 'rangeLiteral': {
			const range = expr as NqlRangeLiteral;
			const lb = range.lowerInclusive ? '[' : '(';
			const ub = range.upperInclusive ? ']' : ')';
			return `${lb}${range.lower},${range.upper}${ub}`;
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
		case 'namedParam':
			throw new NqlSemanticException(
				NqlErrorCodes.SEM_INVALID_SYNTAX,
				`Named parameter :${(expr as NqlNamedParamExpr).name} cannot be used as SQL structure; use nqlRaw() for trusted dynamic structure`,
			);
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
		// L-7: the old default was `return String(expr)` which silently emitted
		// '[object Object]' for any unrecognised expression type. This is a
		// programming error (unreachable code path) — SEM_UNREACHABLE is the
		// correct code because a new expression type was added without a handler,
		// not because the user provided invalid NQL syntax.
		default:
			throw new NqlSemanticException(
				NqlErrorCodes.SEM_UNREACHABLE,
				`Cannot convert expression type '${(expr as { type?: unknown }).type ?? 'unknown'}' to SQL fragment`,
			);
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
	if (expr.type === 'namedParam') {
		throw new NqlSemanticException(
			NqlErrorCodes.SEM_UNREACHABLE,
			`Named parameter :${(expr as NqlNamedParamExpr).name} must be resolved by the caller`,
		);
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
	if (!aliasContext) return expressionToValue(expr, ctx);

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
	return expressionToValue(expr, ctx);
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
	return (NQL_SELECT_AGGREGATE_FUNCTIONS as readonly string[]).includes(
		name.toLowerCase(),
	);
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

/**
 * Coerce an NQL expression to a string key for use in JSON paths, LIKE patterns,
 * and similar positions that require a string literal.
 *
 * Dispatch rules:
 *   - string literal → use `.value` directly
 *   - named parameter → resolve through the shared param resolver and require a string value
 *   - single-segment path → treat the identifier name as the key (prevents `String({$ref:...})` → `'[object Object]'`)
 *   - multi-segment dotted path → throw SEM_INVALID_SYNTAX (ambiguous — caller cannot know which segment to use)
 *   - anything else → throw SEM_INVALID_SYNTAX
 *
 * @param expr - The NQL expression to coerce.
 * @param contextLabel - Human-readable label for the position (e.g. `"LIKE pattern"`, `"json_extract() path argument"`) used in error messages.
 * @param ctx - Compiler context used to resolve named params through the shared resolver.
 */
export function coerceToStringKey(
	expr: NqlExpression,
	contextLabel: string,
	ctx: CompilerContext,
): string {
	if (expr.type === 'path') {
		const segments = (expr as NqlPathExpression).segments;
		if (segments.length > 1) {
			throw new NqlSemanticException(
				NqlErrorCodes.SEM_INVALID_SYNTAX,
				`${contextLabel} must be a string literal or a single identifier, not a dotted path`,
			);
		}
		// Single-segment path: treat the identifier as the string key value.
		const key = expressionToField(expr);
		/* v8 ignore next — defensive: single-segment path always resolves to non-null */
		if (!key) {
			throw new NqlSemanticException(
				NqlErrorCodes.SEM_INVALID_SYNTAX,
				`${contextLabel} must be a string literal or a single identifier`,
			);
		}
		return key;
	}
	if (expr.type === 'string') {
		return (expr as { type: 'string'; value: string }).value;
	}
	if (expr.type === 'namedParam') {
		const value = resolveNamedParam(ctx, expr.name);
		if (typeof value !== 'string') {
			throw new NqlSemanticException(
				NqlErrorCodes.SEM_INVALID_SYNTAX,
				`${contextLabel} named parameter :${expr.name} must resolve to a string`,
			);
		}
		return value;
	}
	throw new NqlSemanticException(
		NqlErrorCodes.SEM_INVALID_SYNTAX,
		`${contextLabel} must be a string literal`,
	);
}
