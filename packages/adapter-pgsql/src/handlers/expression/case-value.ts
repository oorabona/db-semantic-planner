/**
 * Shared CASE value resolver.
 *
 * Resolves THEN/ELSE values in CASE expressions to AST nodes.
 * Used by both the compiler (compileCaseValue) and the DX handler (resolveCaseValue).
 */

import type { Node } from '@pgsql/types';
import { columnRef, nullConstNode } from '../../ast-helpers.js';
import type { NamingPlugin } from '../../naming-plugin.js';
import { createParamRef } from '../../param-ref.js';
import type { CompilerState } from '../types.js';

/**
 * Optional handler for nested CASE expressions.
 * The compiler provides this to delegate back to compileCaseExpression;
 * the DX handler omits it (nested CASE falls through to default parameterization).
 */
export type NestedCaseHandler = (expr: Record<string, unknown>) => Node;

/**
 * Resolve a CASE THEN/ELSE value to an AST node.
 *
 * Handles ExpressionIntent objects (column, literal, arithmetic, nested case)
 * and plain scalars (string → column ref, number/boolean → param).
 */
export function resolveCaseValue(
	value: unknown,
	alias: string,
	schema: string | undefined,
	naming: NamingPlugin | undefined,
	state: CompilerState,
	nestedCaseHandler?: NestedCaseHandler,
): Node {
	if (value === null || value === undefined) {
		return nullConstNode();
	}

	if (typeof value === 'string') {
		return columnRef(value, alias, schema, naming);
	}

	if (typeof value !== 'object') {
		const idx = ++state.paramIndex;
		state.parameters.push(value);
		return createParamRef(idx);
	}

	const expr = value as Record<string, unknown>;
	switch (expr.kind) {
		case 'literal':
			if (expr.value === null || expr.value === undefined)
				return nullConstNode();
			{
				const idx = ++state.paramIndex;
				state.parameters.push(expr.value);
				return createParamRef(idx);
			}

		case 'column':
			return columnRef(expr.column as string, alias, schema, naming);

		case 'arithmetic': {
			const left = resolveCaseValue(
				expr.left,
				alias,
				schema,
				naming,
				state,
				nestedCaseHandler,
			);
			const right = resolveCaseValue(
				expr.right,
				alias,
				schema,
				naming,
				state,
				nestedCaseHandler,
			);
			return {
				A_Expr: {
					kind: 'AEXPR_OP',
					name: [{ String: { sval: expr.operator as string } }],
					lexpr: left,
					rexpr: right,
				},
			};
		}

		case 'case':
			if (nestedCaseHandler) {
				return nestedCaseHandler(expr);
			}
		// falls through — no nested handler → parameterize
		default: {
			const idx = ++state.paramIndex;
			state.parameters.push(value);
			return createParamRef(idx);
		}
	}
}
