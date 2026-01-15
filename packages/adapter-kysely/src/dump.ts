/**
 * @module dump
 * Dump API - High-level compilation interface for observability.
 */

import type {
	ModelIR,
	PlanReport,
	QueryIntent,
} from '@dbsp/core';
import { plan } from '@dbsp/core';
import type { Kysely } from 'kysely';
import { compile } from './compiler.js';
import { redactParams } from './redact.js';
import type {
	CompileOptions,
	Dump,
	DumpMeta,
	FormatDumpJsonOptions,
	JsonDump,
} from './types.js';

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

// ============================================================================
// JSON Dump API (ADAPTER-004)
// ============================================================================

/**
 * Format a Dump as structured JSON for log aggregation.
 *
 * Suitable for logging systems like Datadog, ELK, Splunk, etc.
 *
 * @param dump - The dump to format
 * @param options - Formatting options including redaction settings
 * @returns JSON string ready for logging
 *
 * @example
 * ```ts
 * const dump = createDump(intent, model, kysely, { correlationId: 'abc-123' });
 *
 * // Basic JSON output
 * console.log(formatDumpJson(dump));
 *
 * // With parameter redaction
 * console.log(formatDumpJson(dump, {
 *   redact: true,
 *   fieldHints: ['email', 'password', 'userId']
 * }));
 * ```
 */
export function formatDumpJson(
	dump: Dump,
	options: FormatDumpJsonOptions = {},
): string {
	const jsonDump = toJsonDump(dump, options);
	return JSON.stringify(jsonDump);
}

/**
 * Convert a Dump to a JsonDump object.
 *
 * Use this when you need the structured object without stringifying.
 *
 * @param dump - The dump to convert
 * @param options - Conversion options
 * @returns JsonDump object
 */
export function toJsonDump(
	dump: Dump,
	options: FormatDumpJsonOptions = {},
): JsonDump {
	// Handle parameter redaction
	let params: readonly unknown[] = dump.params;
	if (options.redact && options.fieldHints) {
		params = redactParams(
			dump.params,
			options.fieldHints,
			options.redactionOptions,
		);
	}

	// Build decisions summary
	const decisions = dump.plan.decisions.map((d) => ({
		type: d.type,
		choice: d.choice,
	}));

	// Build warnings list
	const warnings = dump.plan.warnings.map((w) => w.message);

	// Build JSON structure
	const result: JsonDump = {
		sql: dump.sql,
		params,
		rootTable: dump.plan.rootTable,
		decisions,
		warnings,
		...(dump.meta?.tenant && { tenant: dump.meta.tenant }),
		...(dump.meta?.queryName && { queryName: dump.meta.queryName }),
		...(dump.meta?.correlationId && {
			correlationId: dump.meta.correlationId,
		}),
		...(dump.meta?.compiledAt && {
			compiledAt: dump.meta.compiledAt.toISOString(),
		}),
		...(dump.plan.ctes &&
			dump.plan.ctes.length > 0 && { cteCount: dump.plan.ctes.length }),
	};

	return result;
}
