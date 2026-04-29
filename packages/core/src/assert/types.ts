/**
 * Shared assertion types for .assert.dbsp evaluation.
 *
 * Used by both CLI (assertion-runner) and GUI sidecar (assertion-handler).
 */

import type { AssertionType } from './assertion-parser.js';

// ── Intent summary (inline — no dependency on CLI's nql-executor) ──

/**
 * Lightweight summary of a compiled query intent.
 * Populated by the NQL executor after compilation.
 */
export interface IntentSummary {
	type: 'query' | 'insert' | 'update' | 'delete' | 'upsert' | 'setOperation';
	table: string;
	with: string[];
	hasWhere: boolean;
	hasGroupBy: boolean;
	hasOrderBy: boolean;
	ctes: string[];
}

// ── Query result (sidecar-friendly version of CLI's BatchResult) ──

/**
 * Portable query result for assertion evaluation.
 * Both CLI (via BatchResult adapter) and sidecar produce this shape.
 */
export interface AssertionQueryResult {
	query: string;
	success: boolean;
	dbSuccess?: boolean;
	output?: string;
	sql?: string;
	params?: readonly unknown[];
	error?: string;
	rowCount?: number;
	columns?: string[];
	rows?: unknown[];
	intent?: IntentSummary;
}

// ── Assertion outcome ──

/**
 * Result of running a single assertion.
 */
export interface AssertionOutcome {
	type: AssertionType;
	expected: unknown;
	actual: unknown;
	passed: boolean;
	message: string | undefined;
	/** True if assertion was skipped (e.g., db.* without DB connection) */
	skipped?: boolean;
	/** Reason for skipping */
	skipReason?: string;
}

// ── Aggregated results ──

/**
 * Result of running all assertions for a single query.
 */
export interface QueryAssertionResult {
	queryIndex: number;
	query: string;
	querySuccess: boolean;
	assertions: AssertionOutcome[];
	passed: boolean;
}

/**
 * Summary of all assertion results.
 */
export interface AssertionSummary {
	total: number;
	passed: number;
	failed: number;
	skipped: number;
	results: QueryAssertionResult[];
}

/**
 * Determine whether a query result represents end-to-end success
 * (compile + DB execution combined).
 *
 * Truth table:
 * | success | dbSuccess  | result |
 * |---------|------------|--------|
 * | false   | (any)      | false  |
 * | true    | undefined  | true   | (compile-only mode — no DB)
 * | true    | true       | true   |
 * | true    | false      | false  |
 *
 * Contract: conforming producers either omit `dbSuccess` (compile-only
 * mode — no DB execution) or set it to a real boolean reflecting DB
 * outcome.
 *
 * Stable predicate — the truth table above IS the contract; callers may
 * rely on its exact behavior. As a `@public` helper, the implementation
 * is also defensive: malformed input (`null`, `undefined`, missing
 * `success`, non-boolean `success`) returns `false` rather than throwing
 * or returning a non-boolean.
 *
 * @public
 */
export function isOverallSuccess(r: {
	success: boolean;
	dbSuccess?: boolean;
}): boolean {
	return Boolean(r) && r.success === true && r.dbSuccess !== false;
}
