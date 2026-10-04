/**
 * Shared helpers for WHERE handlers.
 * @internal Extracted from comparison, in, like, null handlers (PGSQL-008, PGSQL-009).
 */

import { isParamIntent } from '@dbsp/types';
import { isFieldRef } from '@dbsp/types/internal';
import type { Node } from '@pgsql/types';
import { nullConstNode } from '../../ast-helpers.js';
import {
	declaredRelationBindingFor,
	type RelationBinding,
	relationBindingFor,
} from '../../binding-registry.js';
import { mapModelIRTypeToPgBase } from '../../compiler-utils.js';
import {
	dbTypeCastTarget,
	renderColumnDbType,
	validateDbType,
} from '../../db-type.js';
import { normalizeParamIntent, unwrapParamIntent } from '../../param-intent.js';
import { createParamRef, createTypeCastParamRef } from '../../param-ref.js';
import { queryLocal, type SqlIdentifier } from '../../sql-identifier.js';
import type { CompilerContext, CompilerState } from '../types.js';
import {
	currentExpressionBinding,
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

/** Type authority follows the same visible binding as SQL emission. */
export function resolveWhereModelColumn(
	columnName: string,
	ctx: CompilerContext,
) {
	let binding = currentExpressionBinding(ctx);
	if (ctx.position === 'recursive-anchor' && columnName.includes('.')) {
		const dot = columnName.lastIndexOf('.');
		binding = anchorQualifiedBinding(columnName.slice(0, dot), ctx);
		columnName = columnName.slice(dot + 1);
	}
	return ctx.model
		?.getTable(binding.logicalTable ?? ctx.rootTable)
		?.columns.find((column) => column.name === columnName);
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
 * Build parameter reference and register value in compiler state.
 * If value has a pre-assigned `paramIndex` (from PlanDecision), use it directly.
 */
export function buildParamRef(value: unknown, state: CompilerState): Node {
	const boundValue = unwrapParamIntent(value);
	if (isParamRef(boundValue)) {
		state.parameters.push(boundValue.value);
		return createParamRef(boundValue.paramIndex);
	}
	state.paramIndex++;
	state.parameters.push(boundValue);
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
	if (forceParam || isParamIntent(value)) {
		return compileValue(value, state, columnType, true);
	}
	if (isFieldRef(value)) {
		// A qualified field reference establishes its own addressed binding; the
		// scope marker only applies to an unqualified field.
		if (ctx.position === 'recursive-anchor' && value.alias !== undefined) {
			return expressionColumnRef(
				value.column,
				ctx,
				anchorQualifiedBinding(value.alias, ctx),
			);
		}
		if (
			value.scope === 'outer' &&
			ctx.position === 'subquery' &&
			value.column.includes('.')
		) {
			const dot = value.column.lastIndexOf('.');
			const qualifier = value.column.slice(0, dot);
			let binding: RelationBinding | undefined;
			for (const ranges of ctx.enclosingRanges ?? []) {
				binding = ranges.find((candidate) => candidate.qualifier === qualifier);
				if (binding) break;
				const candidates = ranges.filter(
					(candidate) => candidate.logicalTable === qualifier,
				);
				if (candidates.length > 1)
					throw new Error(
						`outerRef qualifier '${qualifier}' is ambiguous between ${candidates
							.map((candidate) => `'${candidate.qualifier}'`)
							.sort()
							.join(', ')} in an enclosing query.`,
					);
				binding = candidates[0];
				if (binding) break;
			}
			if (!binding)
				throw new Error(
					`outerRef qualifier '${qualifier}' is not visible in an enclosing query.`,
				);
			return expressionColumnRef(value.column.slice(dot + 1), ctx, binding);
		}
		if (value.column.includes('.')) return buildColumnRef(value.column, ctx);
		const alias =
			value.scope === 'outer'
				? (ctx.outerAlias ?? ctx.rootTable)
				: (ctx.currentAlias ?? ctx.rootTable);
		return expressionQualifiedColumnRef(value.column, alias, ctx);
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
	const column = resolveWhereModelColumn(columnName, ctx);
	if (!column) return undefined;
	// Only cast when originalDbType is explicitly set (populated by introspection).
	// Manually defined schemas omit this field — we do not guess the PG type from
	// the abstract ColumnType to avoid breaking queries on non-introspected schemas.
	if (column.originalDbType) {
		const targetSchema = ctx.schema;
		const typeName = renderColumnDbType(column, targetSchema).trim();
		// Validate with the adapter's PG-aware validator (accepts faithful
		// format_type shapes like `timestamp(3) with time zone`), then emit the
		// truncation-safe cast target — NOT core's DB-agnostic validateTypeName.
		validateDbType(typeName);
		return dbTypeCastTarget(typeName);
	}
	return undefined;
}

/**
 * Resolve the PostgreSQL base type for a column's array cast from its DECLARED
 * abstract {@link ColumnType}, for the `any(col, array)` element cast.
 *
 * `resolveColumnPgType` deliberately trusts only an introspection-populated
 * `originalDbType` and returns `undefined` for manually defined schemas, so that
 * the scalar comparison path never guesses a type. But the `any(col, array)`
 * element cast is not optional — without it, ids that read back from PostgreSQL
 * as JS strings make the builder emit `col = ANY($1::text[])`, which fails with
 * `operator does not exist: integer = text` on an integer column of a manually
 * defined schema. There, the declared column type IS the authoritative target,
 * so map it through the safe `mapModelIRTypeToPgBase` whitelist (which returns
 * `undefined` for anything outside a known scalar type, leaving the caller's
 * runtime-inference fallback intact). PostgreSQL coerces across compatible
 * integer widths, so a declared `integer` on a `bigint` column still resolves.
 *
 * Returns the base type name (without `[]`); the caller appends the array cast.
 */
export function resolveColumnAbstractPgBase(
	columnName: string,
	ctx: CompilerContext,
): string | undefined {
	if (!ctx.model) return undefined;
	const column = resolveWhereModelColumn(columnName, ctx);
	if (!column) return undefined;
	return mapModelIRTypeToPgBase(column.type);
}
