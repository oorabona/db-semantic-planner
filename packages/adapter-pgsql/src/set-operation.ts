/**
 * Set operation compiler (UNION / INTERSECT / EXCEPT)
 *
 * Recursively compiles a SetOperationIntent tree into a single SQL string
 * with correctly renumbered positional parameters ($1, $2, ...).
 */

import type { ModelIR } from '@dbsp/core';
import type {
	CompileOptions,
	DialectCapabilities,
	PlanReport,
	QueryIntent,
	SetOperationIntent,
} from '@dbsp/types';

/**
 * Compiled SQL with positional parameters.
 */
export interface SetOperationResult {
	readonly sql: string;
	readonly parameters: readonly unknown[];
}

/**
 * Function that compiles a single QueryIntent leaf to SQL + parameters.
 * Provided by the caller to decouple from adapter internals.
 */
export type LeafCompileFn = (query: QueryIntent) => {
	sql: string;
	parameters: readonly unknown[];
};

/**
 * Re-number positional parameter placeholders ($1, $2, ...) in a SQL string
 * by adding `offset` to each index.
 *
 * @example
 * renumberParams('SELECT * FROM t WHERE a = $1 AND b = $2', 3)
 * // → 'SELECT * FROM t WHERE a = $4 AND b = $5'
 */
function renumberParams(sql: string, offset: number): string {
	if (offset === 0) return sql;
	return sql.replace(/\$(\d+)/g, (_match, num) => {
		return `$${Number.parseInt(num, 10) + offset}`;
	});
}

/**
 * Recursively compile a SetOperationIntent to SQL with merged parameters.
 *
 * Each leaf QueryIntent is compiled via `compileFn`. When merging left and
 * right branches, the right side's `$N` placeholders are renumbered so they
 * don't collide with the left side's parameters.
 *
 * @param intent - The set operation intent (recursive tree)
 * @param compileFn - Compiles a single QueryIntent to SQL + params
 * @returns Combined SQL string and merged parameter array
 *
 * @example
 * ```typescript
 * const result = compileSetOperation(setOpIntent, (query) => {
 *   const planReport = plan(query, model, { dialectCapabilities });
 *   return adapter.compile(planReport, { model });
 * });
 * console.log(result.sql);        // (SELECT ...) UNION (SELECT ...)
 * console.log(result.parameters);  // [...leftParams, ...rightParams]
 * ```
 */
export function compileSetOperation(
	intent: SetOperationIntent,
	compileFn: LeafCompileFn,
): SetOperationResult {
	// Compile left side (always a QueryIntent)
	const left = compileLeafOrBranch(intent.left, compileFn);

	// Compile right side (QueryIntent or nested SetOperationIntent)
	const right = compileLeafOrBranch(intent.right, compileFn);

	// Renumber right-side parameters to avoid $N collisions
	const rightSQL = renumberParams(right.sql, left.parameters.length);

	// Build the set operation keyword
	const opKeyword = intent.op.toUpperCase() + (intent.all ? ' ALL' : '');

	return {
		sql: `(${left.sql}) ${opKeyword} (${rightSQL})`,
		parameters: [...left.parameters, ...right.parameters],
	};
}

/**
 * Compile either a leaf QueryIntent or a nested SetOperationIntent branch.
 */
function compileLeafOrBranch(
	intent: QueryIntent | SetOperationIntent,
	compileFn: LeafCompileFn,
): SetOperationResult {
	if ('kind' in intent && intent.kind === 'setOperation') {
		return compileSetOperation(intent as SetOperationIntent, compileFn);
	}
	const result = compileFn(intent as QueryIntent);
	return { sql: result.sql, parameters: result.parameters };
}

/**
 * Create a leaf compile function from adapter + model + capabilities.
 *
 * Convenience factory for the common case where you have a PgsqlAdapter
 * and need a compileFn for `compileSetOperation`.
 *
 * @param adapter - Adapter with compile() and dialectCapabilities
 * @param model - ModelIR schema
 * @param planFn - The plan() function from @dbsp/core
 */
export function createLeafCompileFn(
	adapter: {
		compile(
			plan: PlanReport,
			options: CompileOptions & { model: ModelIR },
		): { sql: string; parameters: readonly unknown[] };
		dialectCapabilities: DialectCapabilities;
	},
	model: ModelIR,
	planFn: (
		intent: QueryIntent,
		model: ModelIR,
		options: { dialectCapabilities: DialectCapabilities },
	) => PlanReport,
	options?: CompileOptions,
): LeafCompileFn {
	return (query: QueryIntent) => {
		const planReport = planFn(query, model, {
			dialectCapabilities: adapter.dialectCapabilities,
		});
		return adapter.compile(planReport, { ...options, model });
	};
}
