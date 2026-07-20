/**
 * Stable SPI for implementing the `Adapter` port. Only stable helpers required to construct/validate a
 * `CompiledQuery` belong here — not general internals.
 *
 * The `CompiledQuery` brand certifies that a query was built through the adapter SDK, so
 * `execute()` and `stream()` reject stray consumer objects that would drop read-side metadata.
 * It is not a SQL-safety or trust boundary: SQL safety comes from parameter binding, and code
 * importing this SDK is trusted adapter-implementation code. Raw SQL uses `executeRaw()` or
 * `streamRaw()`.
 */

import type { CompiledColumnMetadata, CompiledQuery } from './adapter.js';
import type { PlanReport } from './planner.js';

const COMPILED_QUERY_ASSERTION_MESSAGE =
	'CompiledQuery must be produced by an adapter constructor — use executeRaw() or streamRaw() for raw SQL. If this query WAS produced by an adapter, check for duplicate or version-mismatched @dbsp/types in your dependency tree: the runtime brand is scoped to one installed copy of @dbsp/types.';

const compiledQueryRegistry = new WeakSet<object>();

export function compiledQueryFromProjection<T>(fields: {
	sql: string;
	parameters: readonly unknown[];
	columnMetadata: ReadonlyMap<string, CompiledColumnMetadata>;
	hydrationPlan?: PlanReport;
}): CompiledQuery<T> {
	const query = Object.freeze({
		sql: fields.sql,
		parameters: Object.freeze([...fields.parameters]),
		columnMetadata: fields.columnMetadata,
		...(fields.hydrationPlan !== undefined
			? { hydrationPlan: fields.hydrationPlan }
			: {}),
	});
	compiledQueryRegistry.add(query);
	return query as CompiledQuery<T>;
}

/**
 * Builds an explicit projectionless query. These queries intentionally omit
 * columnMetadata because no projection-derived read provenance exists.
 */
export function projectionlessCompiledQuery<T>(
	fields: { sql: string; parameters: readonly unknown[] },
	reason: string,
): CompiledQuery<T> {
	if (reason.trim().length === 0) {
		throw new Error('projectionlessCompiledQuery requires a non-empty reason.');
	}
	const query = Object.freeze({
		sql: fields.sql,
		parameters: Object.freeze([...fields.parameters]),
	});
	compiledQueryRegistry.add(query);
	return query as CompiledQuery<T>;
}

export function rebuildCompiledQuery<T>(
	prior: CompiledQuery<T>,
	patch: { sql: string; parameters: readonly unknown[] },
): CompiledQuery<T> {
	const query = Object.freeze({
		sql: patch.sql,
		parameters: Object.freeze([...patch.parameters]),
		...(prior.columnMetadata !== undefined
			? { columnMetadata: prior.columnMetadata }
			: {}),
		...(prior.hydrationPlan !== undefined
			? { hydrationPlan: prior.hydrationPlan }
			: {}),
	});
	compiledQueryRegistry.add(query);
	return query as CompiledQuery<T>;
}

export function isCompiledQuery(x: unknown): boolean {
	return typeof x === 'object' && x !== null && compiledQueryRegistry.has(x);
}

export function assertCompiledQuery(x: unknown): asserts x is CompiledQuery {
	if (!isCompiledQuery(x)) {
		throw new Error(COMPILED_QUERY_ASSERTION_MESSAGE);
	}
}
