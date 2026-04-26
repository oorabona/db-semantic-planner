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

import { type NqlCompilerOptions, compile as nqlCompile } from '@dbsp/nql';
import type { Adapter, Dump } from '../adapter.js';
import type { QueryIntent } from '../intent-ast.js';
import type { ModelIR } from '../model-ir.js';
import type { PlanReport } from '../planner.js';
import { plan as executePlan } from '../planner.js';
import type { DumpMetaInput } from './query-builder-types.js';

// ============================================================================
// Types
// ============================================================================

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
	dump(meta?: DumpMetaInput): Dump;
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
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: Reserved for future schema-scoping support
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

		// Extract dynamic pseudo-column keywords from model configuration
		const compilerOptions = extractPseudoColumnKeywords(this.model);

		// Use integrated @dbsp/nql compiler with dynamic keywords
		const result = nqlCompile(
			this.query,
			this.schemaDefinition,
			undefined,
			compilerOptions,
		);
		if (!result.success || !result.ast?.query) {
			const errors =
				result.errors?.map((e) => e.message).join(', ') ?? 'Unknown error';
			throw new Error(`NQL compilation failed: ${errors}`);
		}

		// Type assertion: NQL imports QueryIntent from @dbsp/types (ARCH-007),
		// structurally identical to core's re-export.
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

	dump(meta?: DumpMetaInput): Dump {
		const planReport = this.plan();

		if (!this.adapter) {
			return {
				plan: planReport,
				sql: '[No adapter - SQL not available]',
				params: [],
				...(meta !== undefined && { meta }),
			};
		}

		const compiled = this.adapter.compile<T>(planReport);

		try {
			return this.adapter.createDump(planReport, compiled, meta);
		} catch (err) {
			if (
				err instanceof Error &&
				err.message.toLowerCase().includes('not implemented')
			) {
				// Fallback for mock adapters that don't implement createDump
				const base: Dump = {
					plan: planReport,
					sql: compiled.sql,
					params: compiled.parameters as readonly unknown[],
				};
				if (meta !== undefined) {
					return {
						...base,
						meta: {
							...(meta.queryName !== undefined && {
								queryName: meta.queryName,
							}),
							...(meta.correlationId !== undefined && {
								correlationId: meta.correlationId,
							}),
						},
					};
				}
				return base;
			}
			throw err;
		}
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

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extract pseudo-column keywords from model configuration.
 * Collects all configured roles and recursive keywords from all tables'
 * pseudoColumns metadata, falling back to defaults if no configuration exists.
 */
export function extractPseudoColumnKeywords(
	model: ModelIR,
): NqlCompilerOptions | undefined {
	const allKeywords = new Set<string>();
	const recursiveKeywords = new Set<string>();

	for (const table of model.tables.values()) {
		if (!table.pseudoColumns) continue;
		for (const pc of table.pseudoColumns) {
			allKeywords.add(pc.parentRole.toLowerCase());
			allKeywords.add(pc.childRole.toLowerCase());
			allKeywords.add(pc.ascendantKeyword.toLowerCase());
			allKeywords.add(pc.descendantKeyword.toLowerCase());
			recursiveKeywords.add(pc.ascendantKeyword.toLowerCase());
			recursiveKeywords.add(pc.descendantKeyword.toLowerCase());
		}
	}

	// No pseudo-columns configured → let compiler use defaults
	if (allKeywords.size === 0) return undefined;

	return {
		pseudoColumnKeywords: [...allKeywords],
		recursiveKeywords: [...recursiveKeywords],
	};
}
