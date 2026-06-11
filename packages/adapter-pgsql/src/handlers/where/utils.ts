/**
 * Shared helpers for WHERE handlers.
 * @internal Extracted from comparison, in, like, null handlers (PGSQL-008, PGSQL-009).
 */

import { isFieldRef } from '@dbsp/types';
import type { Node } from '@pgsql/types';
import { columnRef, nullConstNode } from '../../ast-helpers.js';
import { createParamRef, createTypeCastParamRef } from '../../param-ref.js';
import { validateDbTypeName } from '../../validate.js';
import type { CompilerContext, CompilerState } from '../types.js';
import { isParamRef } from '../types.js';

/**
 * Build column reference from decision column, using current alias or root table.
 */
export function buildColumnRef(column: string, ctx: CompilerContext): Node {
	// Handle qualified names like 'alias.column' — split and use the explicit table qualifier.
	// This is required when ref('alias.col') is used inside filter conditions (e.g. isNotNull).
	// Without splitting, the full dotted string becomes a column name and the root table is
	// prepended, producing "root"."alias.col" (3-part) instead of "alias"."col" (2-part).
	if (column.includes('.')) {
		const dotIndex = column.indexOf('.');
		const table = column.substring(0, dotIndex);
		const col = column.substring(dotIndex + 1);
		return columnRef(col, table, undefined, ctx.naming);
	}
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
	if (isParamRef(value)) {
		state.parameters.push(value.value);
		return createParamRef(value.paramIndex);
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
	columnType?: string,
	forceParam = false,
): Node {
	if (forceParam) {
		const idx = ++state.paramIndex;
		state.parameters.push(value);
		return columnType
			? createTypeCastParamRef(idx, columnType)
			: createParamRef(idx);
	}

	if (value === null || value === undefined) {
		return nullConstNode();
	}

	if (isParamRef(value)) {
		state.parameters.push(value.value);
		return columnType
			? createTypeCastParamRef(value.paramIndex, columnType)
			: createParamRef(value.paramIndex);
	}

	const idx = ++state.paramIndex;
	state.parameters.push(value);
	return columnType
		? createTypeCastParamRef(idx, columnType)
		: createParamRef(idx);
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
	columnType?: string,
	forceParam = false,
): Node {
	if (forceParam) {
		return compileValue(value, state, columnType, true);
	}
	if (isFieldRef(value)) {
		const alias =
			value.scope === 'outer'
				? (ctx.outerAlias ?? ctx.rootTable)
				: (ctx.currentAlias ?? ctx.rootTable);
		return columnRef(value.column, alias, undefined, ctx.naming);
	}
	return compileValue(value, state, columnType);
}

/**
 * Resolve the PostgreSQL type for a column from the ModelIR in the context.
 * Returns undefined when model is absent or column is not found.
 */
export function resolveColumnPgType(
	columnName: string,
	ctx: CompilerContext,
): string | undefined {
	if (!ctx.model) return undefined;
	const table = ctx.model.getTable(ctx.rootTable);
	if (!table) return undefined;
	const column = table.columns.find((c) => c.name === columnName);
	if (!column) return undefined;
	// Only cast when originalDbType is explicitly set (populated by introspection).
	// Manually defined schemas omit this field — we do not guess the PG type from
	// the abstract ColumnType to avoid breaking queries on non-introspected schemas.
	if (column.originalDbType) return validateDbTypeName(column.originalDbType);
	return undefined;
}
