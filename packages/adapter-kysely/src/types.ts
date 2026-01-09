/**
 * @module types
 * Core types for the Kysely adapter.
 */

import type { PlanReport, WindowIntent } from '@db-semantic-planner/core';

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

	/** Window functions to add to SELECT clause (P3-A) */
	readonly windows?: readonly WindowIntent[];
}

// ============================================================================
// EXPLAIN Types (ADAPTER-004)
// ============================================================================

/**
 * Output format for PostgreSQL EXPLAIN.
 */
export type ExplainFormat = 'text' | 'json' | 'xml' | 'yaml';

/**
 * Options for EXPLAIN execution.
 */
export interface ExplainOptions {
	/**
	 * Execute the query and show actual runtime statistics.
	 * WARNING: This WILL execute the query (including side effects for INSERT/UPDATE/DELETE).
	 * @default false
	 */
	readonly analyze?: boolean;

	/**
	 * Output format for the execution plan.
	 * @default 'text'
	 */
	readonly format?: ExplainFormat;

	/**
	 * Include estimated costs in the output.
	 * @default true
	 */
	readonly costs?: boolean;

	/**
	 * Include buffer usage statistics (requires analyze: true).
	 * @default false
	 */
	readonly buffers?: boolean;

	/**
	 * Include timing information (requires analyze: true).
	 * @default true when analyze is true
	 */
	readonly timing?: boolean;
}

/**
 * Result of EXPLAIN command.
 */
export interface ExplainResult {
	/**
	 * Raw EXPLAIN output as string (for text format).
	 */
	readonly plan: string;

	/**
	 * Parsed JSON plan (only when format: 'json').
	 */
	readonly jsonPlan?: unknown;

	/**
	 * Actual execution time in milliseconds (only when analyze: true).
	 */
	readonly executionTime?: number;

	/**
	 * Options used for this EXPLAIN.
	 */
	readonly options: ExplainOptions;
}

// ============================================================================
// Redaction Types (ADAPTER-004)
// ============================================================================

/**
 * Default patterns for automatic parameter redaction.
 * Case-insensitive matching against field names.
 */
export const DEFAULT_REDACTION_PATTERNS = [
	'password',
	'secret',
	'token',
	'key',
	'auth',
	'credential',
	'api_key',
	'apikey',
	'private',
] as const;

/**
 * Placeholder string used for redacted values.
 */
export const REDACTED_PLACEHOLDER = '[REDACTED]' as const;

/**
 * Options for parameter redaction.
 */
export interface RedactionOptions {
	/**
	 * Custom patterns to match against field names (case-insensitive).
	 * Replaces default patterns if provided.
	 */
	readonly patterns?: readonly string[];

	/**
	 * Additional patterns to add to defaults.
	 */
	readonly additionalPatterns?: readonly string[];

	/**
	 * Field names that should never be redacted.
	 */
	readonly whitelist?: readonly string[];
}

// ============================================================================
// JSON Dump Types (ADAPTER-004)
// ============================================================================

/**
 * Decision summary for JSON output.
 */
export interface JsonDecision {
	readonly type: string;
	readonly choice: string;
}

/**
 * Structured JSON output for logging.
 * Suitable for log aggregation systems (Datadog, ELK, etc.).
 */
export interface JsonDump {
	/** Compiled SQL string */
	readonly sql: string;

	/** Bound parameter values (possibly redacted) */
	readonly params: readonly unknown[];

	/** Root table being queried */
	readonly rootTable: string;

	/** Planner decisions summary */
	readonly decisions: readonly JsonDecision[];

	/** Warning messages (if any) */
	readonly warnings: readonly string[];

	/** Tenant schema name (if multi-tenant) */
	readonly tenant?: string;

	/** User-provided query label */
	readonly queryName?: string;

	/** Correlation ID for distributed tracing */
	readonly correlationId?: string;

	/** When the query was compiled (ISO 8601) */
	readonly compiledAt?: string;

	/** Number of CTEs extracted */
	readonly cteCount?: number;
}

/**
 * Options for JSON dump formatting.
 */
export interface FormatDumpJsonOptions {
	/**
	 * Redact sensitive parameter values.
	 * @default false
	 */
	readonly redact?: boolean;

	/**
	 * Field hints for parameter redaction (in order of params array).
	 * Required when redact: true to identify which params to redact.
	 */
	readonly fieldHints?: readonly string[];

	/**
	 * Custom redaction options.
	 */
	readonly redactionOptions?: RedactionOptions;

	/**
	 * Include full plan decisions with reasoning (verbose).
	 * @default false (summary only)
	 */
	readonly verbose?: boolean;
}
