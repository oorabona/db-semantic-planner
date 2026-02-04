/**
 * Shared helpers for WHERE handlers.
 * @internal Extracted from comparison, in, like, null handlers (PGSQL-008, PGSQL-009).
 */

import { isFieldRef } from '@dbsp/types';
import type { Node } from '@pgsql/types';
import { columnRef, nullConstNode } from '../../ast-helpers.js';
import { createParamRef } from '../../param-ref.js';
import type { CompilerContext, CompilerState } from '../types.js';

/**
 * Build column reference from decision column, using current alias or root table.
 */
export function buildColumnRef(column: string, ctx: CompilerContext): Node {
	const alias = ctx.currentAlias ?? ctx.rootTable;
	// Schema is NOT used for column references — aliases and table names in WHERE
	// are query-scoped, not schema-qualified. Schema is only for FROM/JOIN entries.
	return columnRef(column, alias, undefined, ctx.naming);
}

/**
 * Build parameter reference and register value in compiler state.
 * If value has a pre-assigned `paramIndex` (from PlanDecision), use it directly.
 */
export function buildParamRef(value: unknown, state: CompilerState): Node {
	if (
		value !== null &&
		value !== undefined &&
		typeof value === 'object' &&
		'paramIndex' in (value as object)
	) {
		const paramValue = value as { paramIndex: number; value?: unknown };
		state.parameters.push(paramValue.value);
		return createParamRef(paramValue.paramIndex);
	}
	state.paramIndex++;
	state.parameters.push(value);
	return createParamRef(state.paramIndex);
}

/**
 * Compile a value into a parameterized AST node.
 * Handles null, pre-assigned paramIndex, and normal values.
 * Ported from compiler-conditions.ts for DRY consolidation.
 */
export function compileValue(
	value: unknown,
	state: Pick<CompilerState, 'parameters' | 'paramIndex'>,
): Node {
	if (value === null || value === undefined) {
		return nullConstNode();
	}

	if (typeof value === 'object' && 'paramIndex' in (value as object)) {
		const paramValue = value as { paramIndex: number; value?: unknown };
		state.parameters.push(paramValue.value);
		return createParamRef(paramValue.paramIndex);
	}

	const idx = ++state.paramIndex;
	state.parameters.push(value);
	return createParamRef(idx);
}

/**
 * Compile a value that may be a FieldRef (column-to-column comparison) or a regular value.
 * FieldRef with scope:'inner' resolves to the current context alias.
 * FieldRef with scope:'outer' resolves to the outer query alias (for EXISTS subqueries).
 */
export function compileValueOrFieldRef(
	value: unknown,
	ctx: CompilerContext,
	state: Pick<CompilerState, 'parameters' | 'paramIndex'>,
): Node {
	if (isFieldRef(value)) {
		const alias =
			value.scope === 'outer'
				? (ctx.outerAlias ?? ctx.rootTable)
				: (ctx.currentAlias ?? ctx.rootTable);
		return columnRef(value.column, alias, undefined, ctx.naming);
	}
	return compileValue(value, state);
}
