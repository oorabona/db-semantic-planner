/**
 * @module compiler/types
 * Compiler context and handler type definitions.
 */

import type {
	DialectCapabilities as CoreDialectCapabilities,
	ExpressionIntent,
	IncludeIntent,
	ModelIR,
	PlanReport,
	WhereIntent,
} from '@dbsp/core';
import type { ExpressionBuilder, Kysely, SelectQueryBuilder } from 'kysely';

// ============================================================================
// Compiler State (moved from compiler.ts)
// ============================================================================

/**
 * Mutable state maintained during query compilation.
 * This is the internal state passed between handler functions.
 */
export interface CompilerState {
	/** Current table alias counter */
	aliasCounter: number;
	/** Map of table name to alias */
	tableAliases: Map<string, string>;
	/** Collected parameters */
	parameters: unknown[];
	/** Track relations that have been JOINed for filter-strategy: 'join' */
	joinedFilterRelations: Map<string, { alias: string; targetTable: string }>;
	/** Track relations that have been JOINed for include-strategy: 'join' or 'json_agg' */
	joinedIncludeRelations: Map<
		string,
		{
			alias: string;
			targetTable: string;
			relationName: string;
			strategy: 'join' | 'json_agg';
		}
	>;
	/** Dialect capabilities for feature validation (CORE-004) */
	coreCapabilities?: CoreDialectCapabilities;
	/** Dialect name for error messages */
	dialect?: string;
	/** Pending pseudo-column JOINs to be applied */
	pendingPseudoJoins?: Map<
		string,
		{
			traversal: 'parent' | 'child';
			joinAlias: string;
			targetTable: string;
			fkColumn: string;
			pkColumn: string;
			schemaName?: string;
			sourceAlias: string;
		}
	>;
	/**
	 * SPEC-002: Track relation filters applied in WHERE clause.
	 * Used for shared filter optimization in json_agg SELECT.
	 * Key: relation name (e.g., 'posts')
	 * Value: WhereIntent to apply as shared filter
	 */
	relationFilters?: Map<string, WhereIntent>;

	/**
	 * FLAT-BUG-001: Relations whose columns were explicitly selected via `relation.*`
	 * in the SELECT clause by relationColumnHandler. addIncludeSelectColumns
	 * must skip these to avoid duplicate column output.
	 */
	explicitlySelectedRelations?: Set<string>;

	// ============================================================
	// Global Limits (NQL-ALIGN Block 3)
	// ============================================================

	/** Maximum depth for recursive CTE queries. @default 10 */
	maxDepth?: number;
	/** Maximum number of relation hops. @default 5 */
	maxTableHops?: number;
	/** Maximum nesting depth for CASE expressions. @default 10 */
	maxNestedCase?: number;
}

// ============================================================================
// Compiler Context
// ============================================================================

/**
 * Immutable context passed to all handlers.
 * Contains all dependencies needed for compilation.
 */
export interface CompilerContext {
	/** Kysely database instance (optional - not all handlers need it) */
	db?: Kysely<any>;
	/** Model IR for schema information */
	model: ModelIR;
	/** Plan report with decisions */
	plan: PlanReport;
	/** Current compiler state (mutable) */
	state: CompilerState;
	/** Optional schema name for multi-tenant */
	schemaName?: string;
	/** Dispatcher for compiling nested WHERE clauses (recursive handlers) */
	compileWhere?: WhereDispatcher;

	// ============================================================
	// Global Limits (NQL-ALIGN Block 3)
	// ============================================================

	/** Maximum depth for recursive CTE queries. @default 10 */
	maxDepth?: number;
	/** Maximum number of relation hops. @default 5 */
	maxTableHops?: number;
	/** Maximum nesting depth for CASE expressions. @default 10 */
	maxNestedCase?: number;
}

// ============================================================================
// Handler Types
// ============================================================================

/**
 * WHERE clause handler - takes ExpressionBuilder, returns expression.
 * Handlers are responsible for compiling a specific WhereIntent kind.
 */
export type WhereHandler<T extends WhereIntent = WhereIntent> = (
	ctx: CompilerContext,
	eb: ExpressionBuilder<any, any>,
	intent: T,
	alias: string,
) => any;

/**
 * SELECT expression handler - takes query, returns modified query.
 * Handlers are responsible for adding expression selects.
 */
export type ExpressionHandler<T extends ExpressionIntent = ExpressionIntent> = (
	ctx: CompilerContext,
	query: SelectQueryBuilder<any, any, any>,
	intent: T,
	alias: string,
) => SelectQueryBuilder<any, any, any>;

/**
 * Include strategy handler - applies include to query.
 * Handlers are responsible for implementing a specific include strategy.
 */
export type IncludeHandler = (
	ctx: CompilerContext,
	query: SelectQueryBuilder<any, any, any>,
	includes: IncludeIntent[],
	rootTable: string,
	rootAlias: string,
) => SelectQueryBuilder<any, any, any>;

/**
 * Dispatcher function type for recursive WHERE compilation.
 * Passed to handlers that need to compile nested conditions.
 */
export type WhereDispatcher = (
	ctx: CompilerContext,
	eb: ExpressionBuilder<any, any>,
	where: WhereIntent,
	alias: string,
) => any;
