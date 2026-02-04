/**
 * CLI-022: Batch Mode for REPL
 *
 * Executes queries from files or command line without interactive UI.
 * Routes all input through ReplEngine.submit() for a single processing path.
 */

import { readFileSync } from 'node:fs';
import {
	parseAssertionFile,
	validateAssertionBlocks,
} from './assertion-parser.js';
import { type AssertionSummary, runAssertions } from './assertion-runner.js';
import type { EngineEvent } from './engine/engine-types.js';
import { ReplEngine } from './engine/repl-engine.js';
import type { IntentSummary } from './nql-executor.js';
import { formatOutput } from './output-formatter.js';

export interface BatchModeOptions {
	queries: string[];
	schema: import('../utils/schema-loader.js').LoadedSchema;
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
	/** NQL compilation success (parsing + semantic analysis) */
	success: boolean;
	/** DB execution success (only set when database is connected) */
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
 */
function mapEventsToBatchResult(
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
			qr.intent && qr.intent.type !== 'query' ? 'mutation' : 'query';

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

	// Check for DB connection failure during init
	const initError = initEvents.find(
		(e) => e.type === 'error' && e.message.includes('Connection failed'),
	);
	if (initError?.type === 'error') {
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

		// Validate query references
		const validationErrors = validateAssertionBlocks(
			parseResult.blocks,
			queries.length,
			queries,
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
			// Collect events for this query
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

			// Map events → BatchResult
			results.push(mapEventsToBatchResult(query, events, outputMode));
		}
	} finally {
		await engine.destroy();
	}

	// Run assertions if provided
	let assertionSummary: AssertionSummary | undefined;
	if (assertionBlocks) {
		const hasDb = !!databaseUrl;
		assertionSummary = runAssertions(assertionBlocks, results, queries, hasDb);
	}

	return { results, assertionSummary };
}

export async function runBatchMode(options: BatchModeOptions): Promise<void> {
	const { queries, format } = options;

	let execution: BatchExecutionResult;
	try {
		execution = await executeBatch(options);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`❌ ${message}`);
		process.exit(1);
	}

	const { results, assertionSummary } = execution;

	// Output results in text format
	if (format === 'text') {
		for (let i = 0; i < results.length; i++) {
			const result = results[i]!;
			console.log(`\n> ${queries[i]}`);
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

	// Exit with error code:
	// - If assertions provided: exit 1 only if any assertion failed
	// - If no assertions: exit 1 if any query failed
	if (assertionSummary) {
		if (assertionSummary.failed > 0) {
			process.exit(1);
		}
	} else {
		const hasErrors = results.some((r) => !r.success);
		if (hasErrors) {
			process.exit(1);
		}
	}
}
