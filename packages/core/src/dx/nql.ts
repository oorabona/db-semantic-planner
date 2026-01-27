/**
 * @fileoverview NQL template literal integration for type-safe queries (DX-040 Block 8).
 *
 * Provides a type-safe way to use NQL queries with explicit type annotation:
 * ```typescript
 * const users = await orm.nql<{ name: string; email: string }>`users | select name, email`.all();
 * ```
 *
 * @module nql
 * @since DX-040
 */

import { compile as nqlCompile } from '@dbsp/nql';
import type { Adapter, Dump } from '../adapter.js';
import type { QueryIntent } from '../intent-ast.js';
import type { ModelIR } from '../model-ir.js';
import type { PlanReport } from '../planner.js';
import { plan as executePlan } from '../planner.js';

// ============================================================================
// Types
// ============================================================================

/**
 * NQL compiler function type.
 *
 * @deprecated Since DX-040: NQL compiler is now integrated directly.
 * This type is kept for backward compatibility but will be removed in a future version.
 * You no longer need to pass `nqlCompiler` to `createOrm()`.
 */
export type NqlCompilerFn = (
	query: string,
	schema: unknown,
) => {
	success: boolean;
	intent?: QueryIntent;
	errors?: Array<{ message: string }>;
};

/**
 * NQL query builder with type-safe result.
 *
 * @typeParam T - The expected result row type
 */
export interface NqlBuilder<T> {
	/** Execute query and return all results */
	all(): Promise<T[]>;
	/** Execute query and return first result or null */
	first(): Promise<T | null>;
	/** Get the IntentIR for debugging */
	toIntentIR(): QueryIntent;
	/** Get the execution plan */
	plan(): PlanReport;
	/** Get full dump (plan + SQL + params) */
	dump(): Dump;
}

/**
 * NQL template tag function type.
 *
 * @example
 * ```typescript
 * orm.nql<{ name: string }>`users | select name`
 * ```
 */
export type NqlTag = <T>(
	strings: TemplateStringsArray,
	...values: unknown[]
) => NqlBuilder<T>;

// ============================================================================
// Implementation
// ============================================================================

/**
 * Create an NQL template tag function.
 *
 * @param schemaDefinition - Schema definition for validation
 * @param model - ModelIR for plan execution
 * @param adapter - Optional adapter for query execution
 * @param schemaName - Optional schema name for multi-tenant queries
 * @returns NQL template tag function
 */
export function createNqlTag(
	schemaDefinition: unknown,
	model: ModelIR,
	adapter?: Adapter<unknown>,
	schemaName?: string,
): NqlTag {
	return function nql<T>(
		strings: TemplateStringsArray,
		...values: unknown[]
	): NqlBuilder<T> {
		// Reconstruct the query string from template literal
		// Note: strings[0] is always defined for template literals
		let query: string = strings[0] ?? '';
		for (let i = 0; i < values.length; i++) {
			query += String(values[i]) + (strings[i + 1] ?? '');
		}

		return new NqlBuilderImpl<T>(
			query,
			schemaDefinition,
			model,
			adapter,
			schemaName,
		);
	};
}

/**
 * NQL builder implementation.
 * @internal
 */
class NqlBuilderImpl<T> implements NqlBuilder<T> {
	private _intent: QueryIntent | undefined;
	private readonly query: string;
	private readonly schemaDefinition: unknown;
	private readonly model: ModelIR;
	private readonly _schemaName: string | undefined;
	private readonly adapter: Adapter<unknown> | undefined;

	constructor(
		query: string,
		schemaDefinition: unknown,
		model: ModelIR,
		adapter: Adapter<unknown> | undefined,
		schemaName: string | undefined,
	) {
		this.query = query;
		this.schemaDefinition = schemaDefinition;
		this.model = model;
		this.adapter = adapter;
		this._schemaName = schemaName;
	}

	private compile(): QueryIntent {
		if (this._intent) {
			return this._intent;
		}

		// Use integrated @dbsp/nql compiler
		const result = nqlCompile(this.query, this.schemaDefinition);
		if (!result.success || !result.ast?.query) {
			const errors =
				result.errors?.map((e) => e.message).join(', ') ?? 'Unknown error';
			throw new Error(`NQL compilation failed: ${errors}`);
		}

		// Type assertion: NQL's QueryIntent is structurally compatible with core's QueryIntent
		// The types are defined separately but have the same structure.
		// TODO: Unify types by having NQL import from core (ARCH issue)
		this._intent = result.ast.query as QueryIntent;
		return this._intent;
	}

	toIntentIR(): QueryIntent {
		return this.compile();
	}

	plan(): PlanReport {
		const intent = this.compile();
		return executePlan(intent, this.model);
	}

	dump(): Dump {
		const planReport = this.plan();

		if (!this.adapter) {
			return {
				plan: planReport,
				sql: '[No adapter - SQL not available]',
				params: [],
			};
		}

		const compiled = this.adapter.compile<T>(planReport);
		return {
			plan: planReport,
			sql: compiled.sql,
			params: compiled.parameters as readonly unknown[],
		};
	}

	async all(): Promise<T[]> {
		if (!this.adapter) {
			throw new Error(
				'Cannot execute query: no adapter configured. ' +
					'Pass an adapter to createOrm() or use .toIntentIR() / .plan() for debugging.',
			);
		}

		const planReport = this.plan();
		const compiled = this.adapter.compile<T>(planReport);
		return this.adapter.execute(compiled);
	}

	async first(): Promise<T | null> {
		const rows = await this.all();
		return rows[0] ?? null;
	}
}
