/**
 * Set operation compiler (UNION / INTERSECT / EXCEPT)
 *
 * Recursively compiles a SetOperationIntent tree into a single SQL string
 * with correctly renumbered positional parameters ($1, $2, ...).
 */

import type { ModelIR } from '@dbsp/core';
import type {
	CompiledQuery,
	CompileOptions,
	DialectCapabilities,
	PlanReport,
	QueryIntent,
	SetOperationIntent,
} from '@dbsp/types';
import {
	dropPositionalUnion,
	finalizeEnvelope,
	fromCompiledQuery,
	type ProjectionEnvelope,
} from './projection-envelope.js';

/**
 * Compiled set-operation SQL with positional parameters.
 */
export type SetOperationResult<T = unknown> = CompiledQuery<T>;

/**
 * Function that compiles a single QueryIntent leaf to a projection envelope, or
 * a compiled query that can be bridged into one.
 * Provided by the caller to decouple from adapter internals.
 */
type LeafCompileResult = ProjectionEnvelope | CompiledQuery;
export type LeafCompileFn = (query: QueryIntent) => LeafCompileResult;

function isProjectionEnvelope(
	result: LeafCompileResult,
): result is ProjectionEnvelope {
	return 'projection' in result;
}

function toProjectionEnvelope(result: LeafCompileResult): ProjectionEnvelope {
	return isProjectionEnvelope(result) ? result : fromCompiledQuery(result);
}

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
 * Each leaf QueryIntent is compiled via `compileFn` to a projection envelope.
 * When merging left and right branches, the right side's `$N` placeholders are
 * renumbered so they don't collide with the left side's parameters. The final
 * set operation drops positional projection provenance through the envelope so
 * `finalizeEnvelope` owns the set-operation `js` fail-loud behavior.
 *
 * @param intent - The set operation intent (recursive tree)
 * @param compileFn - Compiles a single QueryIntent to an envelope-compatible result
 * @returns Combined SQL string and merged parameter array
 *
 * @example
 * ```typescript
 * const compileFn = createLeafCompileFn(adapter, model, plan);
 * const result = compileSetOperation(setOpIntent, compileFn);
 * console.log(result.sql);        // (SELECT ...) UNION (SELECT ...)
 * console.log(result.parameters);  // [...leftParams, ...rightParams]
 * ```
 */
export function compileSetOperation(
	intent: SetOperationIntent,
	compileFn: LeafCompileFn,
): SetOperationResult {
	return finalizeEnvelope(compileSetOperationEnvelope(intent, compileFn));
}

export function compileSetOperationEnvelope(
	intent: SetOperationIntent,
	compileFn: LeafCompileFn,
): ProjectionEnvelope {
	// Compile left side (always a QueryIntent)
	const left = compileLeafOrBranch(intent.left, compileFn);

	// Compile right side (QueryIntent or nested SetOperationIntent)
	const right = compileLeafOrBranch(intent.right, compileFn);

	// Renumber right-side parameters to avoid $N collisions
	const rightSQL = renumberParams(right.sql, left.parameters.length);

	// Build the set operation keyword
	const opKeyword = intent.op.toUpperCase() + (intent.all ? ' ALL' : '');

	const sql = `(${left.sql}) ${opKeyword} (${rightSQL})`;
	const parameters = [...left.parameters, ...right.parameters];

	return dropPositionalUnion([left, right], {
		sql,
		parameters,
		reason: 'set-operation-positional-merge',
	});
}

/**
 * Compile either a leaf QueryIntent or a nested SetOperationIntent branch.
 */
function compileLeafOrBranch(
	intent: QueryIntent | SetOperationIntent,
	compileFn: LeafCompileFn,
): ProjectionEnvelope {
	if ('kind' in intent && intent.kind === 'setOperation') {
		return compileSetOperationEnvelope(intent as SetOperationIntent, compileFn);
	}
	return toProjectionEnvelope(compileFn(intent as QueryIntent));
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
		): CompiledQuery;
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
		return fromCompiledQuery(
			adapter.compile(planReport, { ...options, model }),
		);
	};
}
