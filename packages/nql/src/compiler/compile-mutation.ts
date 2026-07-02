/* biome-ignore-all lint/style/noNonNullAssertion: NQL AST node access requires non-null assertions on validated parse tree */
/**
 * @module compiler/compile-mutation
 * Compiles NQL mutations (INSERT, UPDATE, DELETE, UPSERT) to MutationIntent.
 */

import type {
	DeleteIntent,
	InsertFromIntent,
	InsertIntent,
	MutationIntent,
	QueryIntent,
	SelectFieldsIntent,
	UpdateIntent,
	UpsertFromIntent,
	UpsertIntent,
	WhereAndIntent,
	WhereInIntent,
	WhereIntent,
	WhereInValueIntent,
	WhereNotIntent,
	WhereOrIntent,
} from '@dbsp/types';
import { isParamIntent } from '@dbsp/types';
import { getNqlBindingRefName, isNqlBindingRef } from '@dbsp/types/internal';
import { NqlErrorCodes, NqlSemanticException } from '../errors/types.js';
import type {
	NqlDelete,
	NqlExpression,
	NqlInsert,
	NqlInsertFrom,
	NqlMutation,
	NqlMutationPipeline,
	NqlSelectClause,
	NqlStatement,
	NqlUpdate,
	NqlUpsert,
	NqlUpsertFrom,
} from '../parser/ast.js';
import {
	expressionToField,
	expressionToValue,
	resolveIntegerCount,
} from './expression-utils.js';
import type {
	CompilerContext,
	CompilerFns,
	ReturningColumnInfo,
} from './types.js';

function assignMutationValue(
	target: Record<string, unknown>,
	column: string,
	value: NqlExpression,
	ctx: CompilerContext,
): void {
	target[column] = expressionToValue(value, ctx);
}

/**
 * Compile a mutation pipeline (mutation + clauses like RETURNING).
 */
export function compileMutationPipeline(
	pipeline: NqlMutationPipeline,
	ctx: CompilerContext,
	fns: CompilerFns,
	bindings?: Map<string, QueryIntent>,
): { mutation: MutationIntent; returning?: readonly string[] } {
	ctx.currentFromTable = pipeline.mutation.table;

	const mutation = compileMutation(pipeline.mutation, ctx, fns, bindings);

	// RETURNING always projects the mutation's TARGET table. insert-from /
	// upsert-from compilation repoints currentFromTable at the SOURCE for
	// their WHERE clauses — restore the target before extracting RETURNING
	// so source validation and alias sources resolve against the emitted
	// table (#217).
	ctx.currentFromTable = pipeline.mutation.table;

	// Extract RETURNING from select clauses
	let returning: readonly string[] | undefined;
	let returningItems: readonly ReturningColumnInfo[] | 'star' | undefined;
	for (const clause of pipeline.clauses) {
		if (clause.type === 'select') {
			returningItems = extractReturningItems(clause, ctx);
			returning =
				returningItems === 'star'
					? ['*']
					: returningItems.map((item) => item.output);
		}
	}

	// #213 B2: stash the alias-aware RETURNING info for the schema producer
	// (`getMutationBindingOutputSchema`), consumed immediately after this
	// call returns — never re-derived from the collapsed `returning` names.
	ctx.lastMutationReturningItems = returningItems;

	if (returning) {
		const aliasAwareReturningItems =
			returningItems !== undefined &&
			returningItems !== 'star' &&
			returningItems.some((item) => item.aliased)
				? returningItems.map((item) => ({
						source: item.source,
						output: item.output,
					}))
				: undefined;
		return {
			mutation: {
				...mutation,
				returning,
				...(aliasAwareReturningItems !== undefined && {
					returningItems: aliasAwareReturningItems,
				}),
			} as MutationIntent,
		};
	}

	return { mutation };
}

/**
 * Compile a single mutation to MutationIntent.
 */
function compileMutation(
	mutation: NqlMutation,
	ctx: CompilerContext,
	fns: CompilerFns,
	bindings?: Map<string, QueryIntent>,
): MutationIntent {
	switch (mutation.type) {
		case 'insert':
			return compileInsert(mutation, ctx);
		case 'insert_from':
			return compileInsertFrom(mutation, ctx, fns, bindings);
		case 'update':
			return compileUpdate(mutation, ctx, fns, bindings);
		case 'delete':
			return compileDelete(mutation, ctx, fns, bindings);
		case 'upsert':
			return compileUpsert(mutation, ctx, fns, bindings);
		case 'upsert_from':
			return compileUpsertFrom(mutation, ctx, fns, bindings);
	}
}

function compileInsert(insert: NqlInsert, ctx: CompilerContext): InsertIntent {
	ctx.validator?.validateTable(insert.table);

	// Collect all unique columns across all rows (column normalization)
	const allColumns = new Set<string>();
	for (const row of insert.rows) {
		for (const assignment of row) {
			ctx.validator?.validateColumn(insert.table, assignment.column);
			allColumns.add(assignment.column);
		}
	}

	// Build values array with normalized columns (missing → undefined → NULL)
	const values: Record<string, unknown>[] = [];
	for (const row of insert.rows) {
		const rowValues: Record<string, unknown> = {};
		const rowColumns = new Set<string>();
		for (const assignment of row) {
			rowColumns.add(assignment.column);
			assignMutationValue(rowValues, assignment.column, assignment.value, ctx);
		}
		for (const col of allColumns) {
			if (!rowColumns.has(col)) {
				rowValues[col] = undefined;
			}
		}
		values.push(rowValues);
	}

	return {
		type: 'insert',
		table: insert.table,
		values,
	};
}

function compileInsertFrom(
	insertFrom: NqlInsertFrom,
	ctx: CompilerContext,
	fns: CompilerFns,
	bindings?: Map<string, QueryIntent>,
): InsertFromIntent {
	// Validate target table unconditionally
	ctx.validator?.validateTable(insertFrom.table);
	const sourceQuery = bindings?.get(insertFrom.source);
	// Validate source table only when it is not already a bound/known reference
	if (!sourceQuery) {
		ctx.validator?.validateTable(insertFrom.source);
	}
	ctx.currentFromTable = insertFrom.source;

	return {
		type: 'insert_from',
		table: insertFrom.table,
		source: insertFrom.source,
		...(sourceQuery !== undefined && { sourceQuery }),
		/* v8 ignore next — NQL grammar does not produce explicit column lists for INSERT FROM -- @preserve */
		...(insertFrom.columns !== undefined && { columns: insertFrom.columns }),
		...(insertFrom.where !== undefined && {
			where: fns.compileExpression(insertFrom.where, ctx, fns),
		}),
		...(insertFrom.limit !== undefined && {
			limit: resolveIntegerCount(insertFrom.limit, ctx, 'insert-from limit'),
		}),
	};
}

function compileUpdate(
	update: NqlUpdate,
	ctx: CompilerContext,
	fns: CompilerFns,
	bindings?: Map<string, QueryIntent>,
): UpdateIntent {
	ctx.currentFromTable = update.table;
	ctx.validator?.validateTable(update.table);
	const set: Record<string, unknown> = {};
	for (const assignment of update.assignments) {
		ctx.validator?.validateColumn(update.table, assignment.column);
		assignMutationValue(set, assignment.column, assignment.value, ctx);
	}

	if (update.where) {
		return {
			type: 'update',
			table: update.table,
			set,
			where: resolveBindingsInWhere(
				fns.compileExpression(update.where, ctx, fns),
				bindings,
			),
		};
	}

	if (!ctx.allowUnfilteredMutations) {
		throw new Error(
			'update without a where clause would affect all rows; pass { allowUnfilteredMutations: true } to the compiler to allow an unfiltered update',
		);
	}

	return {
		type: 'update',
		table: update.table,
		set,
		allowAll: true,
	};
}

function compileDelete(
	del: NqlDelete,
	ctx: CompilerContext,
	fns: CompilerFns,
	bindings?: Map<string, QueryIntent>,
): DeleteIntent {
	ctx.currentFromTable = del.table;
	ctx.validator?.validateTable(del.table);
	if (del.where) {
		return {
			type: 'delete',
			table: del.table,
			where: resolveBindingsInWhere(
				fns.compileExpression(del.where, ctx, fns),
				bindings,
			),
		};
	}

	if (!ctx.allowUnfilteredMutations) {
		throw new Error(
			'delete without a where clause would affect all rows; pass { allowUnfilteredMutations: true } to the compiler to allow an unfiltered delete',
		);
	}

	return {
		type: 'delete',
		table: del.table,
		allowAll: true,
	};
}

function compileUpsert(
	upsert: NqlUpsert,
	ctx: CompilerContext,
	fns: CompilerFns,
	bindings?: Map<string, QueryIntent>,
): UpsertIntent {
	ctx.currentFromTable = upsert.table;
	ctx.validator?.validateTable(upsert.table);
	const values: Record<string, unknown> = {};
	for (const assignment of upsert.assignments) {
		ctx.validator?.validateColumn(upsert.table, assignment.column);
		assignMutationValue(values, assignment.column, assignment.value, ctx);
	}

	for (const col of upsert.conflictColumns) {
		ctx.validator?.validateColumn(upsert.table, col);
	}

	return {
		type: 'upsert',
		table: upsert.table,
		values: [values],
		onConflict: { columns: upsert.conflictColumns },
		action: {
			type: 'doUpdate',
			set: values,
			...(upsert.where !== undefined && {
				where: resolveBindingsInWhere(
					fns.compileExpression(upsert.where, ctx, fns),
					bindings,
				),
			}),
		},
	};
}

function compileUpsertFrom(
	upsertFrom: NqlUpsertFrom,
	ctx: CompilerContext,
	fns: CompilerFns,
	bindings?: Map<string, QueryIntent>,
): UpsertFromIntent {
	// Validate target table unconditionally
	ctx.validator?.validateTable(upsertFrom.table);
	const sourceQuery = bindings?.get(upsertFrom.source);
	// Validate source table only when it is not already a bound/known reference
	if (!sourceQuery) {
		ctx.validator?.validateTable(upsertFrom.source);
	}
	// Validate conflict columns against the target table schema
	for (const col of upsertFrom.conflictColumns) {
		ctx.validator?.validateColumn(upsertFrom.table, col);
	}
	ctx.currentFromTable = upsertFrom.source;

	return {
		type: 'upsert_from',
		table: upsertFrom.table,
		source: upsertFrom.source,
		conflictColumns: upsertFrom.conflictColumns,
		...(sourceQuery !== undefined && { sourceQuery }),
		/* v8 ignore start — NQL grammar does not produce explicit column lists for UPSERT FROM -- @preserve */
		...(upsertFrom.columns !== undefined && {
			columns: upsertFrom.columns,
		}),
		/* v8 ignore stop -- @preserve */
		...(upsertFrom.where !== undefined && {
			where: fns.compileExpression(upsertFrom.where, ctx, fns),
		}),
		...(upsertFrom.limit !== undefined && {
			limit: resolveIntegerCount(upsertFrom.limit, ctx, 'upsert-from limit'),
		}),
	};
}

/**
 * Extract RETURNING column names from a SELECT clause after a mutation.
 */

/**
 * Alias-aware extraction of RETURNING items from a SELECT clause after a
 * mutation. Returns the 'star' sentinel for `RETURNING *`. #213 B2: this is
 * the ONLY producer of alias info — `extractReturningColumns` derives its
 * collapsed name list from this, never the other way around.
 */
function extractReturningItems(
	clause: NqlSelectClause,
	ctx: CompilerContext,
): readonly ReturningColumnInfo[] | 'star' {
	const items: ReturningColumnInfo[] = [];
	const outputs = new Set<string>();

	for (const item of clause.items) {
		if (item.type === 'star') {
			if (clause.items.length > 1) {
				throw new NqlSemanticException(
					NqlErrorCodes.SEM_INVALID_SYNTAX,
					'Mutation RETURNING cannot mix `select *` with explicit projection items.',
				);
			}
			return 'star';
		}
		if (item.type === 'expression') {
			const field = expressionToField(item.expression);
			if (field) {
				const aliased = item.alias !== undefined;
				if (aliased && field.includes('.')) {
					throw new NqlSemanticException(
						NqlErrorCodes.SEM_INVALID_SYNTAX,
						`Mutation RETURNING alias cannot use dotted source '${field}'.`,
					);
				}
				if (ctx.currentFromTable && !field.includes('.')) {
					ctx.validator?.validateColumn(ctx.currentFromTable, field);
				}
				const output = item.alias ?? field;
				if (outputs.has(output)) {
					throw new NqlSemanticException(
						NqlErrorCodes.SEM_INVALID_SYNTAX,
						`Mutation RETURNING has duplicate output name '${output}'.`,
					);
				}
				outputs.add(output);
				items.push({
					source: field,
					output,
					aliased,
				});
			}
		}
	}

	return items;
}

/**
 * Extract RETURNING column names from a SELECT clause after a mutation.
 */

/**
 * Walk a WhereIntent tree and resolve any IN clause whose values contain
 * a branded binding reference matching a bound CTE name -> convert to subquery.
 */
export function resolveBindingsInWhere(
	where: WhereIntent,
	bindings?: ReadonlyMap<string, QueryIntent>,
): WhereIntent {
	if (!bindings || bindings.size === 0) return where;

	if (where.kind === 'in') {
		// Narrow to the values branch before accessing .values (XOR: subquery branch has values?: never)
		const inWhere = where as WhereInIntent;
		const inValues = inWhere.subquery
			? undefined
			: (inWhere as WhereInValueIntent).values;
		if (inValues && inValues.length === 1) {
			const val = inValues[0];
			if (!isParamIntent(val) && isNqlBindingRef(val)) {
				const ref = getNqlBindingRefName(val);
				if (bindings.has(ref)) {
					const boundQuery = bindings.get(ref)!;
					const boundSelect = boundQuery.select;
					/* v8 ignore next — defensive: bound queries from NQL always have select.fields -- @preserve */
					const selectFields: readonly string[] | undefined =
						boundSelect && 'fields' in boundSelect
							? (boundSelect as SelectFieldsIntent).fields
							: undefined;
					const cteRef: QueryIntent = {
						type: 'select',
						from: ref,
						...(selectFields && {
							select: {
								type: 'fields' as const,
								fields: selectFields,
							},
						}),
					};
					// Subquery branch: omit `values` per XOR constraint on WhereInIntent
					return {
						kind: 'in',
						field: inWhere.field,
						subquery: cteRef,
					} as WhereInIntent;
				}
			}
		}
		return where;
	}

	if (where.kind === 'not') {
		const notWhere = where as WhereNotIntent;
		const resolved = resolveBindingsInWhere(notWhere.condition, bindings);
		return resolved === notWhere.condition
			? where
			: { kind: 'not', condition: resolved };
	}

	if (where.kind === 'and' || where.kind === 'or') {
		const compound = where as WhereAndIntent | WhereOrIntent;
		const resolved = compound.conditions.map((c) =>
			resolveBindingsInWhere(c, bindings),
		);
		const changed = resolved.some((r, i) => r !== compound.conditions[i]);
		return changed ? { kind: compound.kind, conditions: resolved } : where;
	}

	return where;
}

/**
 * Extract the bind name from a statement's clauses, if any.
 */
export function extractBindName(stmt: NqlStatement): string | undefined {
	if (stmt.type === 'query') {
		for (const clause of stmt.clauses) {
			if (clause.type === 'bind') return clause.name;
		}
	} else if (stmt.type === 'mutationPipeline') {
		for (const clause of stmt.clauses) {
			if (clause.type === 'bind') return clause.name;
		}
	}
	return undefined;
}
