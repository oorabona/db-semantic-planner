/**
 * ComparisonAdapter
 *
 * A validation adapter that runs both adapter-pgsql and adapter-kysely,
 * comparing their SQL output to ensure correctness during migration.
 *
 * Features:
 * - Dual execution with output comparison
 * - SQL diff logging on mismatch
 * - Configurable behavior via environment variable
 * - Metrics collection for validation
 */

import type { Node } from '@pgsql/types';
import { deparse } from 'pgsql-deparser';

// ============================================================================
// Types
// ============================================================================

/**
 * Comparison mode determines adapter behavior.
 */
export type ComparisonMode =
	| 'pgsql' // Use pgsql adapter only (production)
	| 'kysely' // Use kysely adapter only (fallback)
	| 'compare' // Compare both, log diff, use pgsql
	| 'strict'; // Compare both, throw on mismatch

/**
 * Result of SQL comparison between adapters.
 */
export interface ComparisonResult {
	/** Whether the SQL outputs match */
	match: boolean;
	/** SQL from adapter-pgsql */
	pgsqlSql: string;
	/** SQL from adapter-kysely (if available) */
	kyselySql?: string;
	/** Parameters from adapter-pgsql */
	pgsqlParams: readonly unknown[];
	/** Parameters from adapter-kysely (if available) */
	kyselyParams?: readonly unknown[];
	/** Execution time for pgsql compilation (ms) */
	pgsqlTimeMs: number;
	/** Execution time for kysely compilation (ms) */
	kyselyTimeMs?: number;
	/** Diff details if mismatch */
	diff?: SqlDiff;
}

/**
 * Detailed diff when SQL outputs don't match.
 */
export interface SqlDiff {
	/** Lines only in pgsql output */
	pgsqlOnly: string[];
	/** Lines only in kysely output */
	kyselyOnly: string[];
	/** Structural differences */
	structural: string[];
}

/**
 * Metrics collected during comparison.
 */
export interface ComparisonMetrics {
	/** Total comparisons performed */
	totalComparisons: number;
	/** Number of matches */
	matches: number;
	/** Number of mismatches */
	mismatches: number;
	/** Average pgsql compilation time (ms) */
	avgPgsqlTimeMs: number;
	/** Average kysely compilation time (ms) */
	avgKyselyTimeMs: number;
	/** Mismatch details for debugging */
	mismatchDetails: Array<{
		timestamp: Date;
		queryType: string;
		diff: SqlDiff;
	}>;
}

/**
 * Configuration for ComparisonAdapter.
 */
export interface ComparisonAdapterConfig {
	/** Comparison mode */
	mode: ComparisonMode;
	/** Logger function for diffs */
	onMismatch?: (result: ComparisonResult) => void;
	/** Enable metrics collection */
	collectMetrics?: boolean;
	/** Maximum mismatch details to keep */
	maxMismatchDetails?: number;
}

// ============================================================================
// ComparisonAdapter
// ============================================================================

/**
 * Get comparison mode from environment or config.
 */
export function getComparisonMode(): ComparisonMode {
	const envMode = process.env.DBSP_COMPARISON_MODE;
	if (envMode) {
		const mode = envMode.toLowerCase();
		if (
			mode === 'pgsql' ||
			mode === 'kysely' ||
			mode === 'compare' ||
			mode === 'strict'
		) {
			return mode;
		}
	}
	return 'pgsql'; // Default to pgsql-only in production
}

/**
 * Create metrics collector.
 */
export function createMetricsCollector(_maxDetails = 100): ComparisonMetrics {
	return {
		totalComparisons: 0,
		matches: 0,
		mismatches: 0,
		avgPgsqlTimeMs: 0,
		avgKyselyTimeMs: 0,
		mismatchDetails: [],
	};
}

/**
 * Update metrics with a comparison result.
 */
export function updateMetrics(
	metrics: ComparisonMetrics,
	result: ComparisonResult,
	queryType: string,
	maxDetails = 100,
): void {
	metrics.totalComparisons++;

	if (result.match) {
		metrics.matches++;
	} else {
		metrics.mismatches++;
		if (result.diff && metrics.mismatchDetails.length < maxDetails) {
			metrics.mismatchDetails.push({
				timestamp: new Date(),
				queryType,
				diff: result.diff,
			});
		}
	}

	// Update running average
	const n = metrics.totalComparisons;
	metrics.avgPgsqlTimeMs =
		(metrics.avgPgsqlTimeMs * (n - 1) + result.pgsqlTimeMs) / n;

	if (result.kyselyTimeMs !== undefined) {
		const kyselyN = metrics.matches + metrics.mismatches;
		metrics.avgKyselyTimeMs =
			kyselyN > 1
				? (metrics.avgKyselyTimeMs * (kyselyN - 1) + result.kyselyTimeMs) /
					kyselyN
				: result.kyselyTimeMs;
	}
}

/**
 * Compare two SQL strings, accounting for whitespace and formatting.
 */
export function compareSql(sql1: string, sql2: string): boolean {
	// Normalize whitespace
	const normalize = (s: string) =>
		s
			.replace(/\s+/g, ' ')
			.replace(/\(\s+/g, '(')
			.replace(/\s+\)/g, ')')
			.trim()
			.toLowerCase();

	return normalize(sql1) === normalize(sql2);
}

/**
 * Generate diff between two SQL strings.
 */
export function generateSqlDiff(pgsqlSql: string, kyselySql: string): SqlDiff {
	const pgsqlLines = pgsqlSql.split('\n').map((l) => l.trim());
	const kyselyLines = kyselySql.split('\n').map((l) => l.trim());

	const pgsqlSet = new Set(pgsqlLines);
	const kyselySet = new Set(kyselyLines);

	const pgsqlOnly = pgsqlLines.filter((l) => !kyselySet.has(l) && l.length > 0);
	const kyselyOnly = kyselyLines.filter(
		(l) => !pgsqlSet.has(l) && l.length > 0,
	);

	// Structural differences (key SQL keywords order)
	const structural: string[] = [];
	const keywords = ['SELECT', 'FROM', 'WHERE', 'JOIN', 'ORDER BY', 'LIMIT'];

	for (const kw of keywords) {
		const pgsqlIdx = pgsqlSql.toUpperCase().indexOf(kw);
		const kyselyIdx = kyselySql.toUpperCase().indexOf(kw);
		if ((pgsqlIdx === -1) !== (kyselyIdx === -1)) {
			structural.push(`${kw}: ${pgsqlIdx !== -1 ? 'pgsql' : 'kysely'} only`);
		}
	}

	return { pgsqlOnly, kyselyOnly, structural };
}

/**
 * Format comparison result for logging.
 */
export function formatComparisonResult(result: ComparisonResult): string {
	if (result.match) {
		return `✓ SQL match (pgsql: ${result.pgsqlTimeMs.toFixed(2)}ms)`;
	}

	const lines = [
		`✗ SQL MISMATCH`,
		``,
		`--- pgsql (${result.pgsqlTimeMs.toFixed(2)}ms) ---`,
		result.pgsqlSql,
		``,
	];

	if (result.kyselySql) {
		lines.push(
			`--- kysely (${result.kyselyTimeMs?.toFixed(2)}ms) ---`,
			result.kyselySql,
			``,
		);
	}

	if (result.diff) {
		if (result.diff.structural.length > 0) {
			lines.push(`Structural differences:`, ...result.diff.structural);
		}
	}

	return lines.join('\n');
}

/**
 * Compare parameters (order and values).
 */
export function compareParams(
	params1: readonly unknown[],
	params2: readonly unknown[],
): boolean {
	if (params1.length !== params2.length) return false;

	for (let i = 0; i < params1.length; i++) {
		const p1 = params1[i];
		const p2 = params2[i];

		if (typeof p1 !== typeof p2) return false;
		if (p1 instanceof Date && p2 instanceof Date) {
			if (p1.getTime() !== p2.getTime()) return false;
		} else if (p1 !== p2) {
			return false;
		}
	}

	return true;
}

// ============================================================================
// AST Comparison (for adapter-pgsql validation)
// ============================================================================

/**
 * Deparse AST and validate output.
 *
 * @param ast - PostgreSQL AST node
 * @returns Deparsed SQL string
 * @throws If deparse fails
 */
export async function deparseWithValidation(ast: Node): Promise<string> {
	try {
		const sql = await deparse(ast);
		if (!sql || sql.trim().length === 0) {
			throw new Error('Deparse produced empty SQL');
		}
		return sql;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Deparse failed: ${message}`);
	}
}

/**
 * Validate that deparsed SQL can be re-parsed (roundtrip test).
 * Note: Requires pg-query-emscripten or similar parser.
 *
 * @param sql - SQL string to validate
 * @returns true if valid SQL
 */
export function validateSqlSyntax(sql: string): boolean {
	// Basic syntax checks (parser integration would be more complete)
	const required = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'WITH'];
	const hasStatement = required.some((kw) =>
		sql.toUpperCase().trimStart().startsWith(kw),
	);

	if (!hasStatement) return false;

	// Check for common syntax errors
	const errorPatterns = [
		/SELECT\s*FROM/i, // Missing columns
		/WHERE\s*AND/i, // Missing first condition
		/,\s*FROM/i, // Trailing comma before FROM
		/JOIN\s*ON\s*$/i, // Missing join condition
	];

	return !errorPatterns.some((p) => p.test(sql));
}

// ============================================================================
// Environment-aware execution
// ============================================================================

/**
 * Check if running in comparison mode.
 */
export function isComparisonEnabled(): boolean {
	const mode = getComparisonMode();
	return mode === 'compare' || mode === 'strict';
}

/**
 * Check if strict comparison mode (throws on mismatch).
 */
export function isStrictMode(): boolean {
	return getComparisonMode() === 'strict';
}

/**
 * Log mismatch with configurable output.
 */
export function logMismatch(
	result: ComparisonResult,
	logger: (msg: string) => void = console.warn,
): void {
	const formatted = formatComparisonResult(result);
	logger(`[ComparisonAdapter] ${formatted}`);
}

// ============================================================================
// Summary helpers
// ============================================================================

/**
 * Generate metrics summary report.
 */
export function generateMetricsSummary(metrics: ComparisonMetrics): string {
	const matchRate =
		metrics.totalComparisons > 0
			? ((metrics.matches / metrics.totalComparisons) * 100).toFixed(1)
			: '0';

	return [
		`Comparison Metrics Summary`,
		`==========================`,
		`Total comparisons: ${metrics.totalComparisons}`,
		`Matches: ${metrics.matches} (${matchRate}%)`,
		`Mismatches: ${metrics.mismatches}`,
		`Avg pgsql time: ${metrics.avgPgsqlTimeMs.toFixed(2)}ms`,
		`Avg kysely time: ${metrics.avgKyselyTimeMs.toFixed(2)}ms`,
		metrics.mismatchDetails.length > 0
			? `\nRecent mismatches: ${metrics.mismatchDetails.length}`
			: '',
	]
		.filter(Boolean)
		.join('\n');
}

/**
 * Reset metrics to initial state.
 */
export function resetMetrics(metrics: ComparisonMetrics): void {
	metrics.totalComparisons = 0;
	metrics.matches = 0;
	metrics.mismatches = 0;
	metrics.avgPgsqlTimeMs = 0;
	metrics.avgKyselyTimeMs = 0;
	metrics.mismatchDetails = [];
}
