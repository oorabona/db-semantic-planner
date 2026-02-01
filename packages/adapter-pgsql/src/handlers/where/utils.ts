/**
 * Shared helpers for WHERE handlers.
 * @internal Extracted from comparison, in, like, null handlers (PGSQL-008, PGSQL-009).
 */

import type { Node } from '@pgsql/types';
import { columnRef } from '../../ast-helpers.js';
import { createParamRef } from '../../param-ref.js';
import type { CompilerContext, CompilerState } from '../types.js';

/**
 * Build column reference from decision column, using current alias or root table.
 */
export function buildColumnRef(
	column: string,
	ctx: CompilerContext,
): Node {
	const alias = ctx.currentAlias ?? ctx.rootTable;
	return columnRef(column, alias, ctx.schema, ctx.naming);
}

/**
 * Build parameter reference and register value in compiler state.
 */
export function buildParamRef(
	value: unknown,
	state: CompilerState,
): Node {
	state.paramIndex++;
	state.parameters.push(value);
	return createParamRef(state.paramIndex);
}
