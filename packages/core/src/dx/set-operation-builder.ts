/**
 * @fileoverview SetOperationBuilder — fluent API for UNION / INTERSECT / EXCEPT.
 *
 * Returned by `.union()`, `.unionAll()`, `.intersect()`, `.except()` on QueryBuilder.
 * Stores a SetOperationIntent tree and provides dump() + execute helpers.
 *
 * Architecture note: SQL compilation is delegated to the adapter via
 * `adapter.compileSetOperation()` so that `@dbsp/core` remains DB-agnostic.
 */

import {
	type Adapter,
	type Dump,
	type DumpMeta,
	executeCompiledQuery,
} from '../adapter.js';
import type {
	QueryIntent,
	SetOperationIntent,
	SetOperationType,
} from '../intent-ast.js';
import type { ModelIR } from '../model-ir.js';
import { ExecutionError } from './errors.js';
import type { QueryBuilder } from './types.js';

// ============================================================================
// Public interface
// ============================================================================

/**
 * Fluent builder for set operations (UNION / INTERSECT / EXCEPT).
 *
 * @typeParam TResult - Result row type
 *
 * @example
 * ```typescript
 * const q1 = orm.select('employees').where(eq('active', true));
 * const q2 = orm.select('contractors').where(eq('active', true));
 *
 * // UNION (deduplicates rows)
 * const dump = q1.union(q2).dump();
 *
 * // UNION ALL (keeps duplicates)
 * const rows = await q1.unionAll(q2).all();
 *
 * // Chain: (q1 UNION q2) INTERSECT q3
 * const nested = q1.union(q2).intersect(q3);
 * ```
 */
export interface SetOperationBuilder<TResult = unknown> {
	/** Combine via UNION (deduplicates rows). */
	union(other: QueryBuilder<TResult>): SetOperationBuilder<TResult>;

	/** Combine via UNION ALL (keeps duplicates). */
	unionAll(other: QueryBuilder<TResult>): SetOperationBuilder<TResult>;

	/** Combine via INTERSECT (rows in both). */
	intersect(other: QueryBuilder<TResult>): SetOperationBuilder<TResult>;

	/** Combine via INTERSECT ALL (rows in both, with duplicates). */
	intersectAll(other: QueryBuilder<TResult>): SetOperationBuilder<TResult>;

	/** Combine via EXCEPT (rows in left but not right). */
	except(other: QueryBuilder<TResult>): SetOperationBuilder<TResult>;

	/** Combine via EXCEPT ALL (rows in left but not right, with duplicates). */
	exceptAll(other: QueryBuilder<TResult>): SetOperationBuilder<TResult>;

	/** Compile to SQL and return a Dump (no execution). Requires adapter. */
	dump(): Dump;

	/** Execute and return all rows. Requires adapter. */
	all(): Promise<TResult[]>;

	/** Execute and return first row. Requires adapter. */
	first(): Promise<TResult | undefined>;

	/** The underlying SetOperationIntent (for inspection / testing). */
	readonly intent: SetOperationIntent;
}

// ============================================================================
// Builder context interface
// ============================================================================

/** Minimal interface to extract a QueryIntent from a builder. @internal */
export interface QueryIntentSource {
	buildIntent(): QueryIntent;
}

// ============================================================================
// Implementation
// ============================================================================

/** @internal */
export class SetOperationBuilderImpl<TResult = unknown>
	implements SetOperationBuilder<TResult>
{
	readonly intent: SetOperationIntent;
	private readonly model: ModelIR;
	private readonly adapter: Adapter | undefined;
	private readonly schemaName: string | undefined;

	constructor(
		intent: SetOperationIntent,
		model: ModelIR,
		adapter?: Adapter,
		schemaName?: string,
	) {
		this.intent = intent;
		this.model = model;
		this.adapter = adapter;
		this.schemaName = schemaName;
	}

	union(other: QueryBuilder<TResult>): SetOperationBuilder<TResult> {
		return this.combine('union', false, other);
	}

	unionAll(other: QueryBuilder<TResult>): SetOperationBuilder<TResult> {
		return this.combine('union', true, other);
	}

	intersect(other: QueryBuilder<TResult>): SetOperationBuilder<TResult> {
		return this.combine('intersect', false, other);
	}

	intersectAll(other: QueryBuilder<TResult>): SetOperationBuilder<TResult> {
		return this.combine('intersect', true, other);
	}

	except(other: QueryBuilder<TResult>): SetOperationBuilder<TResult> {
		return this.combine('except', false, other);
	}

	exceptAll(other: QueryBuilder<TResult>): SetOperationBuilder<TResult> {
		return this.combine('except', true, other);
	}

	private combine(
		op: SetOperationType,
		all: boolean,
		other: QueryBuilder<TResult>,
	): SetOperationBuilder<TResult> {
		const rightIntent = (other as unknown as QueryIntentSource).buildIntent();
		const newIntent: SetOperationIntent = {
			kind: 'setOperation',
			op,
			all,
			left: this.intent,
			right: rightIntent,
		};
		return new SetOperationBuilderImpl<TResult>(
			newIntent,
			this.model,
			this.adapter,
			this.schemaName,
		);
	}

	dump(): Dump {
		const adapter = this.requireAdapter();
		const compiled = adapter.compileSetOperation(this.intent, this.model);
		// Set operations bypass the semantic planner — no PlanReport is produced.
		// compiledAt is always included so observability hooks that read
		// dump.meta?.compiledAt receive a consistent shape regardless of query type.
		const meta: DumpMeta = {
			compiledAt: new Date(),
			...(this.schemaName !== undefined ? { schema: this.schemaName } : {}),
		};
		return {
			sql: compiled.sql,
			params: compiled.parameters,
			meta,
		};
	}

	async all(): Promise<TResult[]> {
		const adapter = this.requireAdapter();
		const compiled = adapter.compileSetOperation<TResult>(
			this.intent,
			this.model,
		);
		return executeCompiledQuery(adapter, compiled, 'set operation all()');
	}

	async first(): Promise<TResult | undefined> {
		const rows = await this.all();
		return rows[0];
	}

	private requireAdapter(): Adapter {
		if (!this.adapter) {
			throw new ExecutionError({
				operation: 'set operation execution',
				reason: 'Adapter not configured',
				fix: 'Pass an adapter to createOrm({ adapter: yourAdapter })',
			});
		}
		return this.adapter;
	}
}

// ============================================================================
// Factory helper
// ============================================================================

/**
 * Build a SetOperationIntent from two query intent sources.
 * @internal
 */
export function buildSetOperationIntent(
	op: SetOperationType,
	all: boolean,
	left: QueryIntentSource,
	right: QueryIntentSource,
): SetOperationIntent {
	return {
		kind: 'setOperation',
		op,
		all,
		left: left.buildIntent(),
		right: right.buildIntent(),
	};
}
