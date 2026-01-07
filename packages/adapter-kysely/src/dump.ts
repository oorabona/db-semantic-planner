/**
 * @module dump
 * Dump API - High-level compilation interface for observability.
 */

import type {
	ModelIR,
	PlanReport,
	QueryIntent,
} from '@db-semantic-planner/core';
import { plan } from '@db-semantic-planner/core';
import type { Kysely } from 'kysely';
import { compile } from './compiler.js';
import type { CompileOptions, Dump, DumpMeta } from './types.js';

// ============================================================================
// Dump API
// ============================================================================

/**
 * Compile a QueryIntent into a Dump without execution.
 *
 * This is the main observability API - it produces:
 * - The planner's decisions and reasoning
 * - The compiled SQL string
 * - The bound parameters
 * - Optional metadata for tracing
 *
 * @example
 * ```ts
 * const dump = createDump(intent, model, kysely, { tenant: 'acme' });
 * console.log(dump.sql);     // SELECT * FROM "acme"."users" AS "t0"
 * console.log(dump.params);  // []
 * console.log(dump.plan);    // { rootTable: 'users', ... }
 * ```
 */
export function createDump(
	intent: QueryIntent,
	model: ModelIR,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any for database schema
	kysely: Kysely<any>,
	options?: CompileOptions,
): Dump {
	// Step 1: Plan the query with CTE options if specified
	const planOptions =
		options?.enableCTEs !== undefined || options?.cteThreshold !== undefined
			? {
					...(options.enableCTEs !== undefined && {
						enableCTEs: options.enableCTEs,
					}),
					...(options.cteThreshold !== undefined && {
						cteThreshold: options.cteThreshold,
					}),
				}
			: undefined;
	const planReport = plan(intent, model, planOptions);

	// Step 2: Compile to SQL
	const compiled = compile(planReport, model, kysely, options?.tenant);

	// Step 3: Build result
	if (options) {
		const meta: DumpMeta = {
			...(options.tenant && { tenant: options.tenant }),
			...(options.queryName && { queryName: options.queryName }),
			...(options.correlationId && { correlationId: options.correlationId }),
			compiledAt: new Date(),
		};
		return {
			plan: planReport,
			sql: compiled.sql,
			params: compiled.parameters,
			meta,
		};
	}

	return {
		plan: planReport,
		sql: compiled.sql,
		params: compiled.parameters,
	};
}

/**
 * Compile a PlanReport into a Dump without execution.
 *
 * Use this when you already have a PlanReport (e.g., from manual planning).
 *
 * @example
 * ```ts
 * const planReport = plan(intent, model);
 * // ... inspect/modify planReport ...
 * const dump = createDumpFromPlan(planReport, model, kysely);
 * ```
 */
export function createDumpFromPlan(
	planReport: PlanReport,
	model: ModelIR,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any for database schema
	kysely: Kysely<any>,
	options?: CompileOptions,
): Dump {
	// Compile to SQL
	const compiled = compile(planReport, model, kysely, options?.tenant);

	// Build result
	if (options) {
		const meta: DumpMeta = {
			...(options.tenant && { tenant: options.tenant }),
			...(options.queryName && { queryName: options.queryName }),
			...(options.correlationId && { correlationId: options.correlationId }),
			compiledAt: new Date(),
		};
		return {
			plan: planReport,
			sql: compiled.sql,
			params: compiled.parameters,
			meta,
		};
	}

	return {
		plan: planReport,
		sql: compiled.sql,
		params: compiled.parameters,
	};
}

/**
 * Format a Dump for logging/debugging.
 *
 * @example
 * ```ts
 * const dump = createDump(intent, model, kysely);
 * console.log(formatDump(dump));
 * // [users] SELECT * FROM "users" AS "t0" WHERE ...
 * // Params: [1, 'active']
 * // Decisions: rootStrategy=direct, whereStrategy=index
 * ```
 */
export function formatDump(dump: Dump): string {
	const lines: string[] = [];

	// Header with table name
	const label = dump.meta?.queryName ?? dump.plan.rootTable;
	lines.push(`[${label}] ${dump.sql}`);

	// Parameters
	if (dump.params.length > 0) {
		lines.push(`Params: ${JSON.stringify(dump.params)}`);
	}

	// Key decisions (if any)
	if (dump.plan.decisions.length > 0) {
		const decisions = dump.plan.decisions
			.map((d) => `${d.type}=${d.choice}`)
			.join(', ');
		lines.push(`Decisions: ${decisions}`);
	}

	// Warnings (if any)
	if (dump.plan.warnings.length > 0) {
		lines.push(
			`Warnings: ${dump.plan.warnings.map((w) => w.message).join('; ')}`,
		);
	}

	// Metadata
	if (dump.meta?.correlationId) {
		lines.push(`CorrelationId: ${dump.meta.correlationId}`);
	}

	return lines.join('\n');
}
