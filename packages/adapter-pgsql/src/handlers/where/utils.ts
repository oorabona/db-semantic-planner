/**
 * Shared helpers for WHERE handlers.
 * @internal Extracted from comparison, in, like, null handlers (PGSQL-008, PGSQL-009).
 */

import { isParamIntent, type ResolvedColumnOperand } from '@dbsp/types';
import type { Node } from '@pgsql/types';
import { nullConstNode } from '../../ast-helpers.js';
import {
	declaredRelationBindingFor,
	type RelationBinding,
	relationBinding,
	relationBindingFor,
} from '../../binding-registry.js';
import { normalizeParamIntent, unwrapParamIntent } from '../../param-intent.js';
import { createParamRef, createTypeCastParamRef } from '../../param-ref.js';
import {
	requireRelationTargetColumn,
	resolveRelationTarget,
} from '../../relation-target-projection.js';
import { queryLocal, type SqlIdentifier } from '../../sql-identifier.js';
import type { CompilerContext, CompilerState } from '../types.js';
import {
	currentExpressionBinding,
	expressionColumnIdentifier,
	expressionColumnRef,
	expressionQualifiedColumnRef,
	expressionResolvedColumnRef,
	isParamRef,
} from '../types.js';

export { unwrapParamIntent } from '../../param-intent.js';

/**
 * Emit a WHERE column only after its caller has classified the identifier.
 * This narrow export is also the typed boundary used by direct WHERE helpers.
 */
export function resolvedWhereColumnRef(
	column: SqlIdentifier,
	binding: RelationBinding,
): Node {
	return expressionResolvedColumnRef(column, binding);
}

/** Resolve an addressed anchor binding without inventing an invisible range. */
function anchorQualifiedBinding(
	qualifier: string,
	ctx: CompilerContext,
): RelationBinding {
	const binding =
		relationBindingFor(ctx.scope, queryLocal(qualifier)) ??
		declaredRelationBindingFor(ctx.scope, qualifier);
	if (!binding)
		throw new Error(
			`start.where qualifier '${qualifier}' is not visible in the recursive anchor scope.`,
		);
	return binding;
}

/**
 * Build column reference from decision column, using current alias or root table.
 */
export function buildColumnRef(column: string, ctx: CompilerContext): Node {
	// Handle qualified names like 'alias.column' — split and use the explicit table qualifier.
	// This is required when ref('alias.col') is used inside filter conditions (e.g. isNotNull).
	// Without splitting, the full dotted string becomes a column name and the root table is
	// prepended, producing "root"."alias.col" (3-part) instead of "alias"."col" (2-part).
	if (column.includes('.')) {
		const dotIndex = column.lastIndexOf('.');
		const relation = column.substring(0, dotIndex);
		const table = ctx.aliases?.get(relation) ?? relation;
		const col = column.substring(dotIndex + 1);
		if (ctx.position === 'recursive-anchor')
			return expressionColumnRef(
				col,
				ctx,
				anchorQualifiedBinding(relation, ctx),
			);
		return expressionQualifiedColumnRef(col, table, ctx);
	}
	return expressionColumnRef(column, ctx, currentExpressionBinding(ctx));
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
	value = normalizeParamIntent(value);
	const boundValue = unwrapParamIntent(value);
	if (isParamIntent(value)) {
		const idx = ++state.paramIndex;
		state.parameters.push(boundValue);
		return columnType
			? createTypeCastParamRef(idx, columnType)
			: createParamRef(idx);
	}

	if (forceParam) {
		const idx = ++state.paramIndex;
		state.parameters.push(boundValue);
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

/** The only model/name lookup seam for a resolved WHERE column. */
export function resolveAddressedColumn(
	operand: ResolvedColumnOperand,
	ctx: CompilerContext,
	correlationRelation?: string,
) {
	const range = operand.range;
	const source = relationBindingFor(ctx.scope, queryLocal(range.table));
	const binding =
		relationBindingFor(ctx.scope, queryLocal(range.alias)) ??
		(source && source.kind !== 'declared-table'
			? { ...source, qualifier: queryLocal(range.alias) }
			: relationBinding({
					kind: 'declared-table',
					logicalTable: range.table,
					qualifier: queryLocal(range.alias),
				}));
	if (correlationRelation !== undefined)
		requireRelationTargetColumn(
			resolveRelationTarget(queryLocal(range.table), ctx),
			queryLocal(operand.column),
			'join key',
			correlationRelation,
		);
	const identifier =
		operand.column === '*'
			? queryLocal('*')
			: expressionColumnIdentifier(
					operand.column,
					binding,
					ctx.declaredNames,
					ctx.dbCasing,
				);
	return { binding, identifier };
}

/** Index metadata once per logical table, independently of identifier resolution. */
export function resolveAddressedColumnMetadata(
	logicalTable: string | undefined,
	columnName: string,
	ctx: CompilerContext,
	state: CompilerState,
): import('@dbsp/types').ColumnIR | undefined {
	if (logicalTable === undefined || columnName === '*') return undefined;
	if (!state.addressedColumns) state.addressedColumns = new Map();
	let columns = state.addressedColumns.get(logicalTable);
	if (!columns) {
		columns = new Map(
			ctx.model?.getTable(logicalTable)?.columns.map((col) => [col.name, col]),
		);
		state.addressedColumns.set(logicalTable, columns);
	}
	return columns.get(columnName);
}
