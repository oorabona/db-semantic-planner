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
	WhereNotIntent,
	WhereOrIntent,
} from '@dbsp/types';
import type {
	NqlDelete,
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
import { expressionToField, expressionToValue } from './expression-utils.js';
import type { CompilerContext, CompilerFns } from './types.js';

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

	// Extract RETURNING from select clauses
	let returning: readonly string[] | undefined;
	for (const clause of pipeline.clauses) {
		if (clause.type === 'select') {
			returning = extractReturningColumns(clause, ctx);
		}
	}

	if (returning) {
		return {
			mutation: { ...mutation, returning } as MutationIntent,
		};
	}

	return { mutation };
}

/**
 * Compile a single mutation to MutationIntent.
 */
export function compileMutation(
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
			return compileUpsert(mutation, ctx);
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
			rowValues[assignment.column] = expressionToValue(assignment.value);
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
	const sourceQuery = bindings?.get(insertFrom.source);
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
		...(insertFrom.limit !== undefined && { limit: insertFrom.limit }),
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
		set[assignment.column] = expressionToValue(assignment.value);
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

	return {
		type: 'delete',
		table: del.table,
		allowAll: true,
	};
}

function compileUpsert(upsert: NqlUpsert, ctx: CompilerContext): UpsertIntent {
	ctx.validator?.validateTable(upsert.table);
	const values: Record<string, unknown> = {};
	for (const assignment of upsert.assignments) {
		ctx.validator?.validateColumn(upsert.table, assignment.column);
		values[assignment.column] = expressionToValue(assignment.value);
	}

	for (const col of upsert.conflictColumns) {
		ctx.validator?.validateColumn(upsert.table, col);
	}

	return {
		type: 'upsert',
		table: upsert.table,
		values: [values],
		onConflict: { columns: upsert.conflictColumns },
		action: { type: 'doUpdate', set: values },
	};
}

function compileUpsertFrom(
	upsertFrom: NqlUpsertFrom,
	ctx: CompilerContext,
	fns: CompilerFns,
	bindings?: Map<string, QueryIntent>,
): UpsertFromIntent {
	const sourceQuery = bindings?.get(upsertFrom.source);
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
		...(upsertFrom.limit !== undefined && { limit: upsertFrom.limit }),
	};
}

/**
 * Extract RETURNING column names from a SELECT clause after a mutation.
 */
function extractReturningColumns(
	clause: NqlSelectClause,
	ctx: CompilerContext,
): readonly string[] {
	const columns: string[] = [];

	for (const item of clause.items) {
		if (item.type === 'star') {
			return ['*'];
		}
		if (item.type === 'expression') {
			const field = expressionToField(item.expression);
			if (field) {
				if (ctx.currentFromTable && !field.includes('.')) {
					ctx.validator?.validateColumn(ctx.currentFromTable, field);
				}
				columns.push(item.alias ?? field);
			}
		}
	}

	return columns;
}

/**
 * Walk a WhereIntent tree and resolve any IN clause whose values contain
 * a $ref matching a bound CTE name → convert to subquery.
 */
function resolveBindingsInWhere(
	where: WhereIntent,
	bindings?: Map<string, QueryIntent>,
): WhereIntent {
	if (!bindings || bindings.size === 0) return where;

	if (where.kind === 'in') {
		const inWhere = where as WhereInIntent;
		if (inWhere.values && inWhere.values.length === 1) {
			const val = inWhere.values[0];
			if (
				val &&
				typeof val === 'object' &&
				'$ref' in (val as Record<string, unknown>)
			) {
				const ref = (val as Record<string, unknown>).$ref as string;
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
					return {
						kind: 'in',
						field: inWhere.field,
						values: [],
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
