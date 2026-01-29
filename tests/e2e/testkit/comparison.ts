/**
 * Result-Based Comparison Utilities
 *
 * Provides tools for comparing query execution results between
 * KyselyAdapter and PgsqlAdapter during migration validation.
 *
 * The comparison is result-based, not SQL-based - what matters is
 * that both adapters produce identical data from the database.
 */

import { getComparisonMode } from '@dbsp/adapter-pgsql';
import type { Adapter, CompiledQuery } from '@dbsp/core';

// ============================================================================
// Types
// ============================================================================

/**
 * Result of comparing execution between two adapters.
 */
export interface ComparisonExecutionResult<T = unknown> {
	/** Whether the results match */
	match: boolean;
	/** Result from Kysely adapter */
	kyselyResult: T[];
	/** Result from Pgsql adapter */
	pgsqlResult: T[];
	/** SQL from Kysely adapter (for debugging) */
	kyselySql: string;
	/** SQL from Pgsql adapter (for debugging) */
	pgsqlSql: string;
	/** Execution time for Kysely (ms) */
	kyselyTimeMs: number;
	/** Execution time for Pgsql (ms) */
	pgsqlTimeMs: number;
	/** Diff details if mismatch (undefined when match=true) */
	diff: ResultDiff | undefined;
}

/**
 * Detailed diff when results don't match.
 */
export interface ResultDiff {
	/** Number of rows in Kysely result */
	kyselyRowCount: number;
	/** Number of rows in Pgsql result */
	pgsqlRowCount: number;
	/** First row that differs (0-indexed) */
	firstDiffRowIndex?: number;
	/** Description of the difference */
	description: string;
}

/**
 * Comparison mode for current execution.
 */
export type ComparisonMode = 'kysely' | 'pgsql' | 'compare' | 'strict';

// ============================================================================
// Result Comparison
// ============================================================================

/**
 * Deep equality check for result comparison.
 * Handles common type coercion issues between adapters.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
	// Same reference or primitive equality
	if (a === b) return true;

	// Handle null/undefined
	if (a == null || b == null) return a === b;

	// Handle Date comparison
	if (a instanceof Date && b instanceof Date) {
		return a.getTime() === b.getTime();
	}

	// Handle BigInt vs number (common pg difference)
	if (typeof a === 'bigint' && typeof b === 'number') {
		return a === BigInt(b);
	}
	if (typeof a === 'number' && typeof b === 'bigint') {
		return BigInt(a) === b;
	}

	// Handle arrays
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) {
			if (!deepEqual(a[i], b[i])) return false;
		}
		return true;
	}

	// Handle objects
	if (typeof a === 'object' && typeof b === 'object') {
		const aKeys = Object.keys(a as object);
		const bKeys = Object.keys(b as object);

		if (aKeys.length !== bKeys.length) return false;

		for (const key of aKeys) {
			if (
				!deepEqual(
					(a as Record<string, unknown>)[key],
					(b as Record<string, unknown>)[key],
				)
			) {
				return false;
			}
		}
		return true;
	}

	return false;
}

/**
 * Compare two result sets.
 */
export function compareResults<T>(
	kyselyResult: T[],
	pgsqlResult: T[],
): { match: boolean; diff?: ResultDiff } {
	if (kyselyResult.length !== pgsqlResult.length) {
		return {
			match: false,
			diff: {
				kyselyRowCount: kyselyResult.length,
				pgsqlRowCount: pgsqlResult.length,
				description: `Row count mismatch: Kysely=${kyselyResult.length}, Pgsql=${pgsqlResult.length}`,
			},
		};
	}

	for (let i = 0; i < kyselyResult.length; i++) {
		if (!deepEqual(kyselyResult[i], pgsqlResult[i])) {
			return {
				match: false,
				diff: {
					kyselyRowCount: kyselyResult.length,
					pgsqlRowCount: pgsqlResult.length,
					firstDiffRowIndex: i,
					description: `Row ${i} differs: Kysely=${JSON.stringify(kyselyResult[i])}, Pgsql=${JSON.stringify(pgsqlResult[i])}`,
				},
			};
		}
	}

	return { match: true };
}

// ============================================================================
// Comparison Executor
// ============================================================================

/**
 * Execute a query on both adapters and compare results.
 */
export async function compareExecution<T>(
	kyselyAdapter: Adapter,
	pgsqlAdapter: Adapter,
	kyselyQuery: CompiledQuery<T>,
	pgsqlQuery: CompiledQuery<T>,
): Promise<ComparisonExecutionResult<T>> {
	// Execute in parallel for performance
	const kyselyStart = performance.now();
	const kyselyResultPromise = kyselyAdapter.execute(kyselyQuery);

	const pgsqlStart = performance.now();
	const pgsqlResultPromise = pgsqlAdapter.execute(pgsqlQuery);

	const [kyselyResult, pgsqlResult] = await Promise.all([
		kyselyResultPromise,
		pgsqlResultPromise,
	]);

	const kyselyTimeMs = performance.now() - kyselyStart;
	const pgsqlTimeMs = performance.now() - pgsqlStart;

	// Compare results
	const comparison = compareResults(kyselyResult, pgsqlResult);

	return {
		match: comparison.match,
		kyselyResult,
		pgsqlResult,
		kyselySql: kyselyQuery.sql,
		pgsqlSql: pgsqlQuery.sql,
		kyselyTimeMs,
		pgsqlTimeMs,
		diff: comparison.diff,
	};
}

// ============================================================================
// Rollback Signal for Mutation Comparison
// ============================================================================

/**
 * Error class used to signal a rollback while preserving the result.
 */
export class RollbackSignal<T> extends Error {
	constructor(public readonly result: T) {
		super('Intentional rollback for comparison');
		this.name = 'RollbackSignal';
	}
}

/**
 * Compare mutation execution with automatic rollback.
 * Both adapters execute the mutation in a transaction that is rolled back.
 */
export async function compareMutationExecution<T>(
	kyselyAdapter: Adapter,
	pgsqlAdapter: Adapter,
	kyselyQuery: CompiledQuery<T>,
	pgsqlQuery: CompiledQuery<T>,
): Promise<ComparisonExecutionResult<T>> {
	// Execute mutations in parallel transactions, both will rollback
	const kyselyStart = performance.now();
	const pgsqlStart = performance.now();

	const [kyselyResult, pgsqlResult] = await Promise.all([
		// Kysely adapter transaction with forced rollback
		kyselyAdapter
			.transaction(async (tx) => {
				const result = await tx.execute(kyselyQuery);
				throw new RollbackSignal(result);
			})
			.catch((e: unknown) => {
				if (e instanceof RollbackSignal) return e.result as T[];
				throw e;
			}),

		// Pgsql adapter transaction with forced rollback
		pgsqlAdapter
			.transaction(async (tx) => {
				const result = await tx.execute(pgsqlQuery);
				throw new RollbackSignal(result);
			})
			.catch((e: unknown) => {
				if (e instanceof RollbackSignal) return e.result as T[];
				throw e;
			}),
	]);

	const kyselyTimeMs = performance.now() - kyselyStart;
	const pgsqlTimeMs = performance.now() - pgsqlStart;

	// Compare results
	const comparison = compareResults(kyselyResult, pgsqlResult);

	return {
		match: comparison.match,
		kyselyResult,
		pgsqlResult,
		kyselySql: kyselyQuery.sql,
		pgsqlSql: pgsqlQuery.sql,
		kyselyTimeMs,
		pgsqlTimeMs,
		diff: comparison.diff,
	};
}

// ============================================================================
// Logging and Reporting
// ============================================================================

/**
 * Format a comparison result for logging.
 */
export function formatComparisonResult<T>(
	result: ComparisonExecutionResult<T>,
): string {
	if (result.match) {
		return `✓ Results match (kysely: ${result.kyselyTimeMs.toFixed(1)}ms, pgsql: ${result.pgsqlTimeMs.toFixed(1)}ms)`;
	}

	const lines = [
		`✗ RESULT MISMATCH`,
		``,
		`--- Kysely (${result.kyselyTimeMs.toFixed(1)}ms) ---`,
		`SQL: ${result.kyselySql}`,
		`Rows: ${result.kyselyResult.length}`,
		``,
		`--- Pgsql (${result.pgsqlTimeMs.toFixed(1)}ms) ---`,
		`SQL: ${result.pgsqlSql}`,
		`Rows: ${result.pgsqlResult.length}`,
	];

	if (result.diff) {
		lines.push(``, `Diff: ${result.diff.description}`);
	}

	return lines.join('\n');
}

/**
 * Log a comparison mismatch.
 */
export function logComparisonMismatch<T>(
	result: ComparisonExecutionResult<T>,
	logger: (msg: string) => void = console.warn,
): void {
	logger(`[ComparisonExecutor] ${formatComparisonResult(result)}`);
}

/**
 * Assert comparison result based on current mode.
 * - 'compare': logs mismatch, doesn't throw
 * - 'strict': throws on mismatch
 */
export function assertComparison<T>(
	result: ComparisonExecutionResult<T>,
): void {
	if (result.match) return;

	const mode = getComparisonMode();

	if (mode === 'strict') {
		throw new Error(
			`Comparison mismatch in strict mode:\n${formatComparisonResult(result)}`,
		);
	}

	if (mode === 'compare') {
		logComparisonMismatch(result);
	}
}

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Convenience function for E2E tests that automatically handles comparison.
 * Returns the Kysely result (source of truth) but validates against Pgsql.
 */
export async function executeWithComparison<T>(
	kyselyAdapter: Adapter,
	pgsqlAdapter: Adapter,
	kyselyQuery: CompiledQuery<T>,
	pgsqlQuery: CompiledQuery<T>,
): Promise<T[]> {
	const result = await compareExecution(
		kyselyAdapter,
		pgsqlAdapter,
		kyselyQuery,
		pgsqlQuery,
	);

	assertComparison(result);

	// Return Kysely result as source of truth
	return result.kyselyResult;
}

/**
 * Same as executeWithComparison but for mutations (uses rollback).
 */
export async function executeMutationWithComparison<T>(
	kyselyAdapter: Adapter,
	pgsqlAdapter: Adapter,
	kyselyQuery: CompiledQuery<T>,
	pgsqlQuery: CompiledQuery<T>,
): Promise<T[]> {
	const result = await compareMutationExecution(
		kyselyAdapter,
		pgsqlAdapter,
		kyselyQuery,
		pgsqlQuery,
	);

	assertComparison(result);

	// Return Kysely result as source of truth
	return result.kyselyResult;
}
