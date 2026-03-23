import type { Adapter } from '../adapter.js';
import type { ModelIR } from '../model-ir.js';
import type { PlanOptions } from '../planner.js';
import type {
	FeatureBehaviorConfig,
	UnsupportedFeatureBehavior,
} from '@dbsp/types';

import { negotiateFeatures } from './negotiate-features.js';

import { NamingConventionMismatchError } from './errors.js';
import {
	getHookStore,
	type HookErrorHandler,
	type HookManager,
} from './hooks.js';
import { createOrmInstance } from './orm-instance.js';
import type {
	DefaultFilters,
	InferDB,
	Schema,
	SchemaDefinition,
} from './schema.js';
import { createTablesProxy } from './table-ref-factory.js';
import type { OrmInstance } from './types.js';

// ============================================================================
// ARCH-006: Simplified ORM Entry Point
// ============================================================================

/**
 * ARCH-006: Simplified ORM options.
 *
 * Uses the unified Schema API with required schema and adapter.
 * The schema must be created with `schema()` + `ref()`.
 *
 * @example Full ORM with adapter
 * ```typescript
 * const orm = createOrm({ schema: mySchema, adapter });
 * const users = await orm.select('users').all();
 * ```
 *
 * @example Tests with mock adapter
 * ```typescript
 * import { createMockAdapter } from './test-utils.js';
 * const orm = createOrm({ schema: mySchema, adapter: createMockAdapter() });
 * ```
 */
export interface SimplifiedOrmOptions<
	T extends SchemaDefinition = SchemaDefinition,
> {
	/**
	 * Schema created with schema() + ref().
	 * Either schema or model is required.
	 */
	readonly schema?: Schema<T>;

	/**
	 * ModelIR directly (alternative to schema).
	 * Use this when you have ModelIR from introspection or external source.
	 * Either schema or model is required.
	 */
	readonly model?: ModelIR;

	/**
	 * Adapter for database operations.
	 *
	 * Required — provides dialect capabilities for planner strategy selection.
	 * For compile-only usage (no DB), use `createMockAdapter()` from test-utils
	 * or `createPgsqlCompileOnlyAdapter()` from adapter-pgsql.
	 */
	readonly adapter: Adapter<unknown>;

	/**
	 * Enable strict mode validation (default: false).
	 */
	readonly strictMode?: boolean;

	// ============================================================
	// Global Limits (NQL-ALIGN Block 3)
	// ============================================================

	/**
	 * Maximum depth for recursive CTE queries.
	 * Prevents infinite recursion in tree/graph traversals.
	 * @default 10
	 */
	readonly maxDepth?: number;

	/**
	 * Maximum number of relation hops in a single query.
	 * Limits paths like `user.posts.comments.author.profile`.
	 * @default 5
	 */
	readonly maxTableHops?: number;

	/**
	 * Maximum nesting depth for CASE expressions.
	 * Prevents overly complex conditional logic.
	 * @default 10
	 */
	readonly maxNestedCase?: number;

	/**
	 * Global plan options passed to the semantic planner for every query.
	 * Per-query overrides via `.withPlanOptions()` take precedence.
	 *
	 * @example
	 * ```typescript
	 * const orm = createOrm({
	 *   schema,
	 *   adapter,
	 *   planOptions: {
	 *     defaultIncludeStrategy: 'subquery',
	 *     enableCTEs: true,
	 *     maxIncludeDepth: 3,
	 *   },
	 * });
	 * ```
	 */
	readonly planOptions?: PlanOptions;

	/**
	 * Hook manager for query/mutation interception (E17b).
	 * Created via `createHookManager()`.
	 * Hooks are frozen on ORM creation — no hooks can be added after.
	 */
	readonly hooks?: HookManager;

	/**
	 * Error handler for hook failures (E17b).
	 * Called when a hook throws. Returns 'continue' to skip the failed hook,
	 * or 'abort' to propagate the error.
	 */
	readonly onHookError?: HookErrorHandler;

	/**
	 * Behavior when schema uses features the adapter doesn't support.
	 * Default: 'warning' (emit warning + skip).
	 * Use 'error' for strict environments, 'ignore' to suppress.
	 * Pass FeatureBehaviorConfig for per-feature overrides.
	 */
	readonly unsupportedFeatures?: UnsupportedFeatureBehavior | FeatureBehaviorConfig;
}

/**
 * Create an ORM instance with the specified configuration.
 *
 * @typeParam DB - Database schema type (Kysely-like).
 *   Keys are table names, values are row types.
 *   When provided, query() provides autocomplete and type inference.
 *
 * @param options - Configuration options including model and strictMode
 * @returns An ORM instance for building and planning queries
 *
 * @example With schema() + ref() API (recommended)
 * ```typescript
 * import { schema, ref, createOrm } from '@dbsp/core';
 *
 * const mySchema = schema({
 *   users: {
 *     id: 'uuid',
 *     name: 'string',
 *   },
 *   posts: {
 *     id: 'uuid',
 *     title: 'string',
 *     authorId: ref('users.id'),
 *   },
 * });
 *
 * const orm = createOrm({ schema: mySchema, adapter });
 *
 * // Table names autocomplete, results are typed!
 * const users = await orm.select('users').all();
 *
 * // Include relations with type inference
 * const usersWithPosts = await orm.select('users').include('posts').all();
 * ```
 */
/**
 * ARCH-006: Creates an ORM instance from a schema.
 *
 * This is the single entry point for creating ORM instances.
 * The schema must be created with `schema()` + `ref()`.
 *
 * For database introspection (when available), use the adapter's introspect method:
 * ```typescript
 * const model = await adapter.introspect({ schema: 'public' });
 * const orm = createOrm({ schema: model, adapter });
 * ```
 *
 * @param options - ORM options with required schema
 * @returns ORM instance for querying
 *
 * @example With database adapter
 * ```typescript
 * const orm = createOrm({ schema: mySchema, adapter });
 * const users = await orm.select('users').all();
 * ```
 */
export function createOrm<T extends SchemaDefinition>(
	options: SimplifiedOrmOptions<T>,
): OrmInstance<InferDB<T>> {
	const {
		schema: schemaObj,
		model: modelDirect,
		adapter,
		strictMode = false,
		planOptions: globalPlanOptions,
		hooks: hookManager,
		onHookError,
		unsupportedFeatures,
	} = options;

	// ARCH-006: Either schema or model is required
	// Schema provides full type inference; model is simpler for introspection/tests
	let model: ModelIR;
	let schemaDefinition: unknown;
	let defaultFilters: DefaultFilters | undefined;

	if (schemaObj && 'model' in schemaObj) {
		// Full schema object provided
		model = schemaObj.model;
		schemaDefinition = schemaObj.definition;
		defaultFilters = schemaObj.defaultFilters;

		// ARCH-006: Validate casing consistency
		if (
			adapter &&
			schemaObj.dbCasing &&
			adapter.dbCasing &&
			schemaObj.dbCasing !== adapter.dbCasing
		) {
			throw new NamingConventionMismatchError({
				schemaCasing: schemaObj.dbCasing,
				adapterCasing: adapter.dbCasing,
			});
		}
	} else if (modelDirect) {
		// ModelIR provided directly (simpler API for introspection/tests)
		model = modelDirect;
		schemaDefinition = undefined; // NQL will work without schema validation
		defaultFilters = undefined;
	} else {
		throw new Error(
			'Invalid options: must provide either schema (from schema() function) ' +
				'or model (ModelIR). For database introspection, use getSchemaFromDb() ' +
				'from the adapter (e.g. adapter.introspect()).',
		);
	}

	// CAPS-003: Feature negotiation — cross-check ModelIR against adapter capabilities
	if (adapter?.dialectCapabilities) {
		const result = negotiateFeatures(
			model,
			adapter.dialectCapabilities,
			unsupportedFeatures ?? 'warning',
		);
		for (const w of result.warnings) {
			console.warn(`[dbsp] ${w.message}`);
		}
	}

	// E17b: Freeze hook manager on ORM creation — no hooks can be added after
	const frozenHookStore = hookManager
		? getHookStore(hookManager.freeze())
		: undefined;

	// DX-040-SURFACE: Build tables proxy for type-safe table access
	// Use schema's pre-built proxy if available, otherwise build from model
	const tablesProxy: object =
		schemaObj && 'tables' in schemaObj
			? (schemaObj.tables as object)
			: createTablesProxy(model, model.tables ? [...model.tables.keys()] : []);

	// Create ORM instance with ModelIR
	// Cast to InferDB<T> since createOrmInstance uses internal types
	return createOrmInstance(
		model,
		strictMode,
		{}, // relationHints removed in ARCH-006
		adapter,
		undefined, // schemaName
		adapter.dialectCapabilities,
		schemaDefinition,
		globalPlanOptions,
		defaultFilters,
		frozenHookStore,
		onHookError,
		undefined, // inTransaction
		tablesProxy,
	) as unknown as OrmInstance<InferDB<T>>;
}
