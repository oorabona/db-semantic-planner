/**
 * CLI-022: Batch Mode for REPL
 *
 * Executes queries from files or command line without interactive UI.
 * Routes all input through ReplEngine.submit() for a single processing path.
 */

import { readFileSync } from 'node:fs';
import type { IntentSummary } from '@dbsp/core';
import type { LoadedSchema } from '@dbsp/types';
import {
	parseAssertionFile,
	validateAssertionBlocks,
} from './assertion-parser.js';
import { type AssertionSummary, runAssertions } from './assertion-runner.js';
import type { EngineEvent } from './engine/engine-types.js';
import { ReplEngine } from './engine/repl-engine.js';
import { formatOutput } from './output-formatter.js';

export interface BatchModeOptions {
	queries: string[];
	schema: LoadedSchema;
	schemaPath: string;
	format: 'text' | 'json';
	databaseUrl?: string;
	/** DEMO-E2E: Path to assertion file (.assert.dbsp) */
	assertFile?: string;
	/** DB column casing (intuitive: describes what the DB looks like). */
	dbCasing?: 'snake_case' | 'camelCase' | 'preserve';
}

export interface BatchResult {
	query: string;
	/** Compile-only success of the query (NQL compilation passed).
	 *
	 * Does NOT reflect DB execution outcome — see `dbSuccess` for that.
	 * Exit code logic in `runBatchMode` checks both fields, so a DB error
	 * still produces non-zero exit even though `success` stays true.
	 *
	 * The unified `overallSuccess` field (combining compile + DB) is a
	 * planned redesign — see TODO follow-up. */
	success: boolean;
	/** DB execution success only (compile-only mode leaves this undefined).
	 * When present: `true` = DB query executed without error. */
	dbSuccess?: boolean;
	output?: string;
	sql?: string;
	params?: readonly unknown[];
	error?: string;
	type: 'command' | 'query' | 'mutation';
	/** Row count from DB execution (for db.* assertions) */
	rowCount?: number;
	/** Column names from DB result (for db.column.exists) */
	columns?: string[];
	/** Row data from DB result (for db.value.equals) */
	rows?: unknown[];
	/** Intent summary for intent.* assertions */
	intent?: IntentSummary;
}

/**
 * Result of executing a batch of queries (without side effects).
 * Used by tests to programmatically run examples.
 */
export interface BatchExecutionResult {
	results: BatchResult[];
	assertionSummary?: AssertionSummary | undefined;
}

// Re-export BatchState type for dot-commands compatibility
export type { BatchState } from './dot-commands.js';
// Re-export processDotCommand from dot-commands (used by batch.test.ts)
export { processDotCommand } from './dot-commands.js';

/**
 * Map collected engine events to a BatchResult for a single query.
 *
 * Event patterns:
 *   NQL success:  query-result → [execution-result]
 *   NQL error:    query-result (with .error)
 *   Raw SQL:      query-result → [execution-result]
 *   Dot command:  info | error [+ state-change]
 *
 * @internal Exported for unit testing — not part of the public API.
 */
export function mapEventsToBatchResult(
	query: string,
	events: EngineEvent[],
	outputMode: 'json' | 'table' | 'csv',
): BatchResult {
	const queryResultEvent = events.find((e) => e.type === 'query-result');
	const execResultEvent = events.find((e) => e.type === 'execution-result');
	const infoEvent = events.find((e) => e.type === 'info');
	const errorEvent = events.find((e) => e.type === 'error');

	// --- Query result (NQL or raw SQL) ---
	if (queryResultEvent?.type === 'query-result') {
		const qr = queryResultEvent.result;

		// Compilation error
		if (qr.error) {
			return {
				query,
				success: false,
				error: qr.error,
				output: qr.error,
				type: 'query',
			};
		}

		// Determine type from intent
		const resultType: 'query' | 'mutation' =
			qr.intent &&
			qr.intent.type !== 'query' &&
			qr.intent.type !== 'setOperation'
				? 'mutation'
				: 'query';

		// Build output text (compile-only display)
		const opLabel = qr.plan?.strategy ?? 'QUERY';
		const outputLines = [`[${opLabel}]`, '', 'SQL:', qr.sql];
		if (qr.params.length > 0) {
			outputLines.push(
				'',
				`Parameters: [${qr.params.map((p) => JSON.stringify(p)).join(', ')}]`,
			);
		}

		const base: BatchResult = {
			query,
			success: true,
			output: outputLines.join('\n'),
			sql: qr.sql,
			params: qr.params,
			type: resultType,
			...(qr.intent && { intent: qr.intent }),
		};

		// Augment with execution result if present
		if (execResultEvent?.type === 'execution-result') {
			const er = execResultEvent.result;

			if (er.error) {
				// Note: `success` is intentionally left as compile-success (true here).
				// `dbSuccess: false` signals DB execution failure separately. The
				// `overallSuccess` redesign (combining compile + db) is tracked as
				// a follow-up — until then, `success` retains compile-only semantics
				// to match the GUI sidecar and existing .assert.dbsp files.
				base.dbSuccess = false;
				base.error = `Database error: ${er.error}`;
				base.output = `❌ Error: Database error: ${er.error}`;
			} else {
				base.dbSuccess = true;
				base.rowCount = er.rowCount;
				base.rows = er.rows;
				base.columns = er.columns;
				base.output = [
					...outputLines,
					'',
					`Rows: ${er.rowCount}`,
					formatOutput(er.rows, er.columns, outputMode),
				].join('\n');
			}
		}

		return base;
	}

	// --- Dot command (info/error events) ---
	if (errorEvent?.type === 'error') {
		return {
			query,
			success: false,
			error: errorEvent.message,
			output: errorEvent.message,
			type: 'command',
		};
	}

	if (infoEvent?.type === 'info') {
		return {
			query,
			success: true,
			output: infoEvent.message,
			type: 'command',
		};
	}

	// Fallback: events we don't map (exit, clear, show-panel, etc.)
	return {
		query,
		success: true,
		output: '',
		type: 'command',
	};
}

/**
 * Coalesce backslash-continuation lines into single logical query strings,
 * mirroring ReplEngine.submit() semantics:
 *   - Lines ending in '\' are joined with '\n' to the next non-continuation line
 *   - Blank lines and comment lines (starting with '#') flush the continuation
 *     buffer and are dropped from the output
 *   - Trailing pending text at EOF is emitted as a final entry (so malformed
 *     input ending on a continuation is still observable to validators)
 *
 * Used by batch mode to count distinct executable queries before passing them
 * to engine.submit() so that assertion validation counts match what the
 * engine actually executes.
 *
 * @internal
 */
export function coalesceContinuations(lines: string[]): string[] {
	const result: string[] = [];
	let pending = '';
	for (const q of lines) {
		const trimmed = q.trim();

		// Blank or comment — flush continuation buffer (separator) and skip
		if (!trimmed || trimmed.startsWith('#')) {
			pending = '';
			continue;
		}

		// Backslash continuation — accumulate and wait for next line
		if (trimmed.endsWith('\\')) {
			pending += (pending ? '\n' : '') + trimmed.slice(0, -1).trimEnd();
			continue;
		}

		// Merge pending + current
		result.push(pending ? `${pending}\n${trimmed}` : trimmed);
		pending = '';
	}
	// EOF flush — only emit if there's accumulated text (matches engine: dangling
	// continuation buffer at end-of-input has nothing to merge with, but we keep
	// its content available so callers can detect malformed input.)
	if (pending) result.push(pending);
	return result;
}

/**
 * Core batch execution logic — runs queries and optional assertions,
 * returning structured results without printing or calling process.exit().
 *
 * All input is routed through ReplEngine.submit() for a single processing path.
 */
export async function executeBatch(
	options: BatchModeOptions,
): Promise<BatchExecutionResult> {
	const { queries, schema, schemaPath, databaseUrl, assertFile, dbCasing } =
		options;

	// Create engine with same config as interactive REPL
	const engine = new ReplEngine({
		schema,
		schemaPath,
		...(databaseUrl && { databaseUrl }),
		...(dbCasing && { dbCasing }),
		initialExecMode: !!databaseUrl,
	});

	// Initialize (connects to DB if configured)
	// Suppress init events (connection messages) — batch doesn't display them
	const initEvents: EngineEvent[] = [];
	const unsubInit = engine.on((e) => initEvents.push(e));
	await engine.init();
	unsubInit();

	// Check for DB connection failure during init (typed event check)
	const initError = initEvents.find((e) => e.type === 'init-error');
	if (initError) {
		await engine.destroy();
		throw new Error(`Database connection failed: ${initError.message}`);
	}

	// Parse assertion file if provided
	let assertionBlocks: Parameters<typeof runAssertions>[0] | undefined;
	if (assertFile) {
		let assertContent: string;
		try {
			assertContent = readFileSync(assertFile, 'utf-8');
		} catch (error) {
			await engine.destroy();
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`Failed to read assertion file: ${assertFile} — ${message}`,
			);
		}
		const parseResult = parseAssertionFile(assertContent);

		if (parseResult.errors.length > 0) {
			await engine.destroy();
			const errorMessages = parseResult.errors
				.map((err) => `Line ${err.line}: ${err.message}`)
				.join('\n');
			throw new Error(`Assertion file parse errors:\n${errorMessages}`);
		}

		// C4: Validate against executable queries (strips comments + blanks) so
		// assertion indexes align with what runAssertions receives at runtime.
		// Raw `queries` includes comment lines (#...) and blank lines that the
		// engine skips — validating against them lets queryIndex N pass for a
		// comment slot, then fail silently at runtime when executable[N] is a
		// different query.
		// F2: Coalesce continuation lines before counting executable queries.
		// engine.submit() internally accumulates lines ending with '\' and emits
		// no events until the full statement arrives. Without coalescing here,
		// the validation count would include each continuation fragment as a
		// separate query slot, causing assertion index misalignment at runtime.
		const preExecExecutableQueries = coalesceContinuations(
			queries.filter((q) => {
				const t = q.trim();
				return t.length > 0 && !t.startsWith('#');
			}),
		);
		const validationErrors = validateAssertionBlocks(
			parseResult.blocks,
			preExecExecutableQueries.length,
			preExecExecutableQueries,
		);
		if (validationErrors.length > 0) {
			await engine.destroy();
			const errorMessages = validationErrors
				.map((err) => `Line ${err.line}: ${err.message}`)
				.join('\n');
			throw new Error(`Assertion validation errors:\n${errorMessages}`);
		}

		assertionBlocks = parseResult.blocks;
	}

	const results: BatchResult[] = [];
	// Track output mode from engine state for formatting
	let outputMode: 'json' | 'table' | 'csv' =
		engine.getState().outputMode ?? 'json';

	try {
		for (const query of queries) {
			// M-2 (CODEX-4): Coalesce continuation lines before submit.
			// engine.submit() accumulates lines ending with '\' internally and emits
			// no events until the full statement is submitted. We track whether any
			// events were emitted to skip the synthetic success result for
			// continuation lines.
			const events: EngineEvent[] = [];
			const unsub = engine.on((e) => {
				events.push(e);
				// Track output mode changes from .output command
				if (e.type === 'state-change') {
					outputMode = e.state.outputMode ?? outputMode;
				}
			});

			await engine.submit(query);
			unsub();

			// If no events were emitted, this was a continuation line (backslash
			// continuation accumulation inside the engine) — do not add a result.
			if (events.length === 0) {
				continue;
			}

			// Map events → BatchResult
			const result = mapEventsToBatchResult(query, events, outputMode);
			results.push(result);

			// M-2 (CODEX-5): '.exit'/'.quit' inside batch terminates the run.
			// The exit event is emitted for .exit/.quit dot commands.
			if (events.some((e) => e.type === 'exit')) {
				break;
			}
		}
	} finally {
		await engine.destroy();
	}

	// Run assertions if provided
	// Assertion query indexes count only executable queries (skip comments and blank lines)
	let assertionSummary: AssertionSummary | undefined;
	if (assertionBlocks) {
		const hasDb = !!databaseUrl;
		const executableResults: BatchResult[] = [];
		const executableQueries: string[] = [];
		// Results no longer map 1:1 with queries (continuation lines are skipped),
		// so filter by result.query directly rather than by queries[i] index.
		for (const result of results) {
			const q = result.query.trim();
			if (q.length > 0 && !q.startsWith('#')) {
				executableResults.push(result);
				executableQueries.push(result.query);
			}
		}
		assertionSummary = runAssertions(
			assertionBlocks,
			executableResults,
			executableQueries,
			hasDb,
		);
	}

	return { results, assertionSummary };
}

export async function runBatchMode(options: BatchModeOptions): Promise<void> {
	const { format } = options;

	let execution: BatchExecutionResult;
	try {
		execution = await executeBatch(options);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// EH-11: In JSON mode, errors go to stdout as JSON (not plain text to stderr)
		if (format === 'json') {
			console.log(JSON.stringify({ error: message, status: 'error' }));
		} else {
			console.error(`❌ ${message}`);
		}
		process.exit(1);
	}

	const { results, assertionSummary } = execution;

	// Output results in text format
	// M-3: use result.query — results is no longer 1:1 with queries after
	// continuation-line coalescing (CODEX-4). queries[i] would misalign labels.
	if (format === 'text') {
		for (const result of results) {
			console.log(`\n> ${result.query}`);
			if (result.success) {
				console.log(result.output);
			} else {
				console.error(
					result.error ? `❌ Error: ${result.error}` : result.output,
				);
			}
		}
	}

	// Output assertion results in text format
	if (assertionSummary && format === 'text') {
		console.log('\n─────────────────────────────────');
		console.log('ASSERTION RESULTS');
		console.log('─────────────────────────────────');

		for (const qResult of assertionSummary.results) {
			const icon = qResult.passed ? '✅' : '❌';
			console.log(
				`\n${icon} Query ${qResult.queryIndex}: ${qResult.query.slice(0, 50)}${qResult.query.length > 50 ? '...' : ''}`,
			);

			for (const assertion of qResult.assertions) {
				if (assertion.skipped) {
					console.log(
						`  ⏭ ${assertion.type} (skipped: ${assertion.skipReason})`,
					);
				} else if (assertion.passed) {
					console.log(`  ✓ ${assertion.type}`);
				} else {
					// Vitest-style expected vs actual output
					console.log(`  ✗ ${assertion.type}`);
					console.log('');
					console.log(`    Expected: ${JSON.stringify(assertion.expected)}`);
					if (assertion.actual !== undefined) {
						const actualStr =
							typeof assertion.actual === 'string'
								? assertion.actual
								: JSON.stringify(assertion.actual);
						console.log(`    Actual:   ${actualStr}`);
					}
					console.log('');
				}
			}
		}

		console.log('\n─────────────────────────────────');
		console.log(
			`Summary: ${assertionSummary.passed}/${assertionSummary.total} passed`,
		);
		if (assertionSummary.failed > 0) {
			console.log(`         ${assertionSummary.failed} FAILED`);
		}
		if (assertionSummary.skipped > 0) {
			console.log(`         ${assertionSummary.skipped} skipped (no DB)`);
		}
		console.log('─────────────────────────────────');
	}

	// Output in JSON format (all at once)
	if (format === 'json') {
		const output: { queries: BatchResult[]; assertions?: AssertionSummary } = {
			queries: results,
		};
		if (assertionSummary) {
			output.assertions = assertionSummary;
		}
		console.log(JSON.stringify(output, null, 2));
	}

	// CODEX-6: Exit code considers BOTH query failures AND assertion failures.
	// When assertions are present, exit 1 if any query failed OR any assertion failed.
	// When no assertions, exit 1 if any query failed.
	const hasFailedQueries = results.some(
		(r) => !r.success || r.dbSuccess === false,
	);
	const failed =
		hasFailedQueries ||
		(assertionSummary !== undefined && assertionSummary.failed > 0);
	if (failed) {
		process.exit(1);
	}
}
