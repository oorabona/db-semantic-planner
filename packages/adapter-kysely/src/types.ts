/**
 * @module types
 * Core types for the Kysely adapter.
 */

import type { PlanReport } from '@db-semantic-planner/core';

// ============================================================================
// Dump Types
// ============================================================================

/**
 * Metadata for correlation and debugging
 */
export interface DumpMeta {
	/** Tenant schema name (if multi-tenant) */
	readonly tenant?: string;

	/** User-provided query label */
	readonly queryName?: string;

	/** Correlation ID for distributed tracing */
	readonly correlationId?: string;

	/** When the query was compiled */
	readonly compiledAt?: Date;
}

/**
 * Complete observability output for any query.
 * Produced by compile()/dump() without executing.
 */
export interface Dump {
	/**
	 * Planner decisions with reasoning.
	 * From @db-semantic-planner/core Semantic Planner.
	 */
	readonly plan: PlanReport;

	/**
	 * Compiled SQL string.
	 * Source: Kysely CompiledQuery.sql
	 */
	readonly sql: string;

	/**
	 * Bound parameter values.
	 * Source: Kysely CompiledQuery.parameters
	 * Order matches $1, $2, $3... in SQL.
	 */
	readonly params: readonly unknown[];

	/**
	 * Optional metadata for logging/tracing.
	 */
	readonly meta?: DumpMeta;
}

// ============================================================================
// Compiler Options
// ============================================================================

/**
 * Options for SQL compilation
 */
export interface CompileOptions {
	/** Tenant schema name for multi-tenant queries */
	readonly tenant?: string;

	/** Query name for logging */
	readonly queryName?: string;

	/** Correlation ID for tracing */
	readonly correlationId?: string;

	/** Enable CTE extraction for repeated relation access */
	readonly enableCTEs?: boolean;

	/** Minimum access count to trigger CTE extraction (default: 2) */
	readonly cteThreshold?: number;
}
