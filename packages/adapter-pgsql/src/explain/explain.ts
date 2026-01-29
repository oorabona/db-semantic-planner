/**
 * EXPLAIN Statement Compiler
 *
 * Generates PostgreSQL EXPLAIN statements with various options.
 * Supports:
 * - ANALYZE (execute and show actual run times)
 * - FORMAT (text, json, xml, yaml)
 * - VERBOSE, COSTS, BUFFERS, TIMING, SETTINGS
 */

import type { Node } from '@pgsql/types';

// ============================================================================
// Types
// ============================================================================

/**
 * Output format for EXPLAIN results.
 */
export type ExplainFormat = 'text' | 'json' | 'xml' | 'yaml';

/**
 * Options for EXPLAIN statement.
 */
export interface ExplainOptions {
	/** Execute the query and show actual run times */
	analyze?: boolean;
	/** Show more detailed output */
	verbose?: boolean;
	/** Show cost estimates (default: true) */
	costs?: boolean;
	/** Show buffer usage (requires analyze) */
	buffers?: boolean;
	/** Show actual timing (requires analyze) */
	timing?: boolean;
	/** Show non-default settings */
	settings?: boolean;
	/** Output format */
	format?: ExplainFormat;
}

// ============================================================================
// EXPLAIN Builder
// ============================================================================

/**
 * Build an EXPLAIN statement wrapping a query.
 *
 * @param query - The query to explain (SelectStmt, InsertStmt, etc.)
 * @param options - EXPLAIN options
 * @returns ExplainStmt AST node
 *
 * @example
 * ```typescript
 * const selectAst = { SelectStmt: { ... } };
 * const explainAst = buildExplain(selectAst, { analyze: true, format: 'json' });
 * // Produces: EXPLAIN (ANALYZE, FORMAT JSON) SELECT ...
 * ```
 */
export function buildExplain(query: Node, options: ExplainOptions = {}): Node {
	const defElems: Node[] = [];

	// Add options in standard order
	if (options.analyze !== undefined) {
		defElems.push(buildDefElem('analyze', options.analyze));
	}

	if (options.verbose !== undefined) {
		defElems.push(buildDefElem('verbose', options.verbose));
	}

	if (options.costs !== undefined) {
		defElems.push(buildDefElem('costs', options.costs));
	}

	if (options.buffers !== undefined) {
		defElems.push(buildDefElem('buffers', options.buffers));
	}

	if (options.timing !== undefined) {
		defElems.push(buildDefElem('timing', options.timing));
	}

	if (options.settings !== undefined) {
		defElems.push(buildDefElem('settings', options.settings));
	}

	if (options.format) {
		defElems.push(buildDefElem('format', options.format));
	}

	const explainStmt: { query: Node; options?: Node[] } = { query };
	if (defElems.length > 0) {
		explainStmt.options = defElems;
	}

	return { ExplainStmt: explainStmt };
}

/**
 * Build EXPLAIN ANALYZE with JSON format (common pattern).
 *
 * @param query - The query to explain
 * @returns ExplainStmt with ANALYZE and JSON format
 */
export function buildExplainAnalyzeJson(query: Node): Node {
	return buildExplain(query, {
		analyze: true,
		format: 'json',
	});
}

/**
 * Build simple EXPLAIN (plan only, no execution).
 *
 * @param query - The query to explain
 * @returns ExplainStmt with default options
 */
export function buildExplainPlan(query: Node): Node {
	return buildExplain(query);
}

/**
 * Build verbose EXPLAIN with costs and buffers.
 *
 * @param query - The query to explain
 * @returns ExplainStmt with verbose options
 */
export function buildExplainVerbose(query: Node): Node {
	return buildExplain(query, {
		analyze: true,
		verbose: true,
		buffers: true,
		timing: true,
	});
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build a DefElem node for EXPLAIN options.
 *
 * @param name - Option name (analyze, verbose, format, etc.)
 * @param value - Option value (boolean or string)
 * @returns DefElem AST node
 */
function buildDefElem(name: string, value: boolean | string): Node {
	let arg: Node | undefined;

	if (typeof value === 'boolean') {
		// Boolean options: ANALYZE TRUE/FALSE
		arg = {
			String: {
				sval: value ? 'true' : 'false',
			},
		};
	} else {
		// String options: FORMAT json
		arg = {
			String: {
				sval: value,
			},
		};
	}

	return {
		DefElem: {
			defname: name,
			arg,
			defaction: 'DEFELEM_UNSPEC',
		},
	};
}

/**
 * Parse EXPLAIN JSON output to get execution statistics.
 *
 * @param jsonOutput - The JSON string from EXPLAIN (ANALYZE, FORMAT JSON)
 * @returns Parsed plan with execution statistics
 */
export function parseExplainJson(jsonOutput: string): ExplainPlan[] {
	try {
		const parsed = JSON.parse(jsonOutput);
		return Array.isArray(parsed) ? parsed : [parsed];
	} catch {
		throw new Error('Failed to parse EXPLAIN JSON output');
	}
}

/**
 * Parsed EXPLAIN plan structure (simplified).
 */
export interface ExplainPlan {
	Plan: {
		'Node Type': string;
		'Relation Name'?: string;
		Alias?: string;
		'Startup Cost'?: number;
		'Total Cost'?: number;
		'Plan Rows'?: number;
		'Plan Width'?: number;
		'Actual Startup Time'?: number;
		'Actual Total Time'?: number;
		'Actual Rows'?: number;
		'Actual Loops'?: number;
		Plans?: ExplainPlan['Plan'][];
	};
	'Planning Time'?: number;
	'Execution Time'?: number;
	Triggers?: unknown[];
}

/**
 * Extract total execution time from EXPLAIN ANALYZE JSON output.
 *
 * @param plans - Parsed EXPLAIN plans
 * @returns Total execution time in milliseconds
 */
export function getTotalExecutionTime(plans: ExplainPlan[]): number {
	if (plans.length === 0) return 0;

	const plan = plans[0]!;
	const planning = plan['Planning Time'] ?? 0;
	const execution = plan['Execution Time'] ?? 0;

	return planning + execution;
}

/**
 * Extract row counts from EXPLAIN ANALYZE JSON output.
 *
 * @param plans - Parsed EXPLAIN plans
 * @returns Object with estimated and actual row counts
 */
export function getRowEstimates(plans: ExplainPlan[]): {
	estimated: number;
	actual: number;
} {
	if (plans.length === 0) return { estimated: 0, actual: 0 };

	const rootPlan = plans[0]?.Plan;
	return {
		estimated: rootPlan['Plan Rows'] ?? 0,
		actual: rootPlan['Actual Rows'] ?? 0,
	};
}
