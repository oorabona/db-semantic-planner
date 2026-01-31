/**
 * CLI-022: Batch Mode for REPL
 *
 * Executes queries from files or command line without interactive UI.
 * Supports dot commands and natural queries.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ModelIR } from '@dbsp/core';
import type { LoadedSchema } from '../utils/schema-loader.js';
import {
	parseAssertionFile,
	validateAssertionBlocks,
} from './assertion-parser.js';
import { type AssertionSummary, runAssertions } from './assertion-runner.js';
import { createDbConnection, type DbConnection } from './db-connection.js';
import { parseInputMode } from './mode-escape.js';
// NQL v2: Pure NQL - no legacy parser
import {
	compileNqlToSql,
	NqlCompileError,
	type NqlCompileOnlyResult,
	NqlParseError,
} from './nql-executor.js';
import { formatOutput } from './output-formatter.js';
import type { QueryMode } from './types.js';

export interface BatchModeOptions {
	queries: string[];
	schema: LoadedSchema;
	schemaPath: string;
	format: 'text' | 'json';
	databaseUrl?: string;
	/** DEMO-E2E: Path to assertion file (.assert.dbsp) */
	assertFile?: string;
	/** Naming convention for identifier mapping (default: 'preserve') */
	namingConvention?: 'camelCase' | 'snake_case' | 'preserve';
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
	intent?: {
		type: 'query' | 'insert' | 'update' | 'delete' | 'upsert';
		table: string;
		with: string[];
		hasWhere: boolean;
		hasGroupBy: boolean;
		hasOrderBy: boolean;
	};
}

/** @internal - Exported for testing */
export interface BatchState {
	mode: QueryMode;
	execEnabled: boolean;
	schemaName: string | undefined;
	dbConnection: DbConnection | undefined;
	/** CLI-MUT: Show EXPLAIN output with query results */
	explainMode: boolean;
	/** CLI-NQL: Show parse tree (AST) for queries */
	parseMode: boolean;
	/** NQL v2: ModelIR built from schema for NQL compilation */
	model: ModelIR | undefined;
	/** NQL v2.1: Output display format (json|table|csv) */
	outputMode: 'json' | 'table' | 'csv';
	/** Naming convention for identifier mapping */
	namingConvention?: 'camelCase' | 'snake_case' | 'preserve';
}

/**
 * NQL v2: Format NQL compilation result for display
 */
function formatNqlResult(result: NqlCompileOnlyResult): string {
	const lines: string[] = [];

	// Operation type
	const opType = result.intentType.toUpperCase();
	lines.push(`[${opType}]`);
	lines.push('');

	// SQL
	lines.push('SQL:');
	lines.push(result.sql);

	// Parameters
	if (result.params.length > 0) {
		lines.push('');
		lines.push(
			`Parameters: [${result.params.map((p) => JSON.stringify(p)).join(', ')}]`,
		);
	}

	return lines.join('\n');
}

/**
 * Format table list as text
 * ARCH-005: Uses schema.model (ModelIR) instead of ResolvedSchema
 */
function formatTables(schema: LoadedSchema): string {
	const tables = schema.tableNames;
	return `Tables (${tables.length}):\n${tables.map((t) => `  - ${t}`).join('\n')}`;
}

/**
 * Format table schema as text
 * ARCH-005: Uses schema.model (ModelIR) instead of ResolvedSchema
 */
function formatTableSchema(schema: LoadedSchema, tableName: string): string {
	const table = schema.model.tables.get(tableName);
	if (!table) {
		return `❌ Table not found: ${tableName}`;
	}

	const lines = [`Table: ${tableName}`, 'Columns:'];
	for (const col of table.columns) {
		const nullable = col.nullable ? '' : ' (NOT NULL)';
		lines.push(`  - ${col.name}: ${col.type}${nullable}`);
	}
	return lines.join('\n');
}

/**
 * Get relation description
 * ARCH-005: RelationIR has 'type' and 'target' fields
 */
function getRelationDescription(rel: { type: string; target: string }): string {
	return `${rel.type} → ${rel.target}`;
}

/**
 * Format relations as text
 * ARCH-005: Uses schema.model (ModelIR) instead of ResolvedSchema
 */
function formatRelations(schema: LoadedSchema, tableName?: string): string {
	const relations = Array.from(schema.model.relations.entries());

	if (tableName) {
		// Filter relations involving this table
		const tableRelations = relations.filter(
			([, rel]) => rel.target === tableName || rel.source === tableName,
		);
		if (tableRelations.length === 0) {
			return `No relations found for table: ${tableName}`;
		}
		const lines = [`Relations for ${tableName}:`];
		for (const [name, rel] of tableRelations) {
			lines.push(`  - ${name}: ${getRelationDescription(rel)}`);
		}
		return lines.join('\n');
	}

	const lines = [`Relations (${relations.length}):`];
	for (const [name, rel] of relations) {
		lines.push(`  - ${name}: ${getRelationDescription(rel)}`);
	}
	return lines.join('\n');
}

/**
 * CLI-NQL Block 12: Format a parsed query as a tree for .parse mode
 */
function formatParseTree(parsed: unknown): string {
	const lines = ['─'.repeat(50), 'ParsedQuery {'];

	// Format the parsed object with proper indentation
	const formatValue = (value: unknown, indent = 2): string => {
		const pad = ' '.repeat(indent);
		if (value === null) return 'null';
		if (value === undefined) return 'undefined';
		if (typeof value === 'string') return `"${value}"`;
		if (typeof value === 'number' || typeof value === 'boolean')
			return String(value);
		if (Array.isArray(value)) {
			if (value.length === 0) return '[]';
			const items = value.map((v) => formatValue(v, indent + 2)).join(', ');
			return `[${items}]`;
		}
		if (typeof value === 'object') {
			const entries = Object.entries(value);
			if (entries.length === 0) return '{}';
			const formatted = entries
				.map(([k, v]) => `${pad}  ${k}: ${formatValue(v, indent + 2)}`)
				.join('\n');
			return `{\n${formatted}\n${pad}}`;
		}
		return String(value);
	};

	// Format top-level properties
	const obj = parsed as Record<string, unknown>;
	for (const [key, value] of Object.entries(obj)) {
		if (value !== undefined) {
			lines.push(`  ${key}: ${formatValue(value)}`);
		}
	}

	lines.push('}');
	lines.push('─'.repeat(50));
	return lines.join('\n');
}

/**
 * Process a dot command (async to support .import)
 * ARCH-005: Uses LoadedSchema instead of ResolvedSchema
 * @internal - Exported for testing
 */
export async function processDotCommand(
	input: string,
	schema: LoadedSchema,
	state: BatchState,
): Promise<{
	output: string;
	stateChange?: Partial<BatchState>;
	success?: boolean;
	error?: string;
}> {
	const parts = input.split(/\s+/);
	const command = (parts[0] ?? '').toLowerCase();
	const arg = parts.slice(1).join(' ').trim();

	switch (command) {
		case '.help':
			return {
				output: `Available commands:
  .tables           - List all tables
  .schema <table>   - Show table schema
  .relations [table]- Show relations (optionally for a specific table)
  .use [schema]     - Set/clear PostgreSQL schema for multi-tenant
  .exec [on|off]    - Toggle or set execution mode (requires --db)
  .explain [on|off] - Toggle EXPLAIN output for queries
  .parse [on|off]   - Toggle parse tree (AST) output for queries
  .output [mode]    - Set output format (json|table|csv)
  .import <file>    - Execute SQL file (DDL, seed data)
  .natural          - Switch to natural query mode
  .sql              - Switch to SQL mode
  .help             - Show this help`,
			};

		case '.tables':
			return { output: formatTables(schema) };

		case '.schema':
			if (!arg) {
				const tableCount = schema.tableNames.length;
				const relationCount = schema.model.relations.size;
				return {
					output: `Schema Summary:\n  - Tables: ${tableCount}\n  - Relations: ${relationCount}\n  Use .schema <table> for details`,
				};
			}
			return { output: formatTableSchema(schema, arg) };

		case '.relations':
			return { output: formatRelations(schema, arg || undefined) };

		case '.use':
			if (!arg) {
				return {
					output: 'Cleared schema scope. Queries now use default schema.',
					stateChange: { schemaName: undefined },
				};
			}
			return {
				output: `Using schema: ${arg}`,
				stateChange: { schemaName: arg },
			};

		case '.exec': {
			if (arg === 'on') {
				if (!state.dbConnection) {
					return { output: '❌ No database connection. Use --db option.' };
				}
				return {
					output: '✓ Execution mode: ON',
					stateChange: { execEnabled: true },
				};
			}
			if (arg === 'off') {
				return {
					output: '✓ Execution mode: OFF',
					stateChange: { execEnabled: false },
				};
			}
			// Toggle when no argument provided
			if (!state.dbConnection) {
				return { output: '❌ No database connection. Use --db option.' };
			}
			const newMode = !state.execEnabled;
			return {
				output: `✓ Execution mode: ${newMode ? 'ON' : 'OFF'}`,
				stateChange: { execEnabled: newMode },
			};
		}

		case '.natural':
			return {
				output: 'Switched to natural query mode',
				stateChange: { mode: 'natural' },
			};

		case '.sql':
			return {
				output: 'Switched to SQL mode',
				stateChange: { mode: 'sql' },
			};

		case '.explain': {
			// CLI-MUT: Toggle EXPLAIN mode (SC-15 to SC-17)
			if (arg === 'on') {
				return {
					output: '✓ EXPLAIN mode: ON',
					stateChange: { explainMode: true },
				};
			}
			if (arg === 'off') {
				return {
					output: '✓ EXPLAIN mode: OFF',
					stateChange: { explainMode: false },
				};
			}
			// Toggle when no argument provided
			const newMode = !state.explainMode;
			return {
				output: `✓ EXPLAIN mode: ${newMode ? 'ON' : 'OFF'}`,
				stateChange: { explainMode: newMode },
			};
		}

		case '.parse': {
			// CLI-NQL: Toggle parse tree (AST) output (SC-21 to SC-23)
			if (arg === 'on') {
				return {
					output: '✓ Parse mode: ON - Queries will show parse tree (AST)',
					stateChange: { parseMode: true },
				};
			}
			if (arg === 'off') {
				return {
					output: '✓ Parse mode: OFF',
					stateChange: { parseMode: false },
				};
			}
			// Toggle when no argument provided
			const newParseMode = !state.parseMode;
			return {
				output: `✓ Parse mode: ${newParseMode ? 'ON' : 'OFF'}`,
				stateChange: { parseMode: newParseMode },
			};
		}

		case '.output': {
			// NQL v2.1: Set output display format (json|table|csv)
			const validModes = ['json', 'table', 'csv'] as const;
			type OutputMode = (typeof validModes)[number];

			if (!arg) {
				// Show current mode
				return {
					output: `Current output mode: ${state.outputMode}`,
				};
			}

			const requestedMode = arg.toLowerCase();
			if (!validModes.includes(requestedMode as OutputMode)) {
				return {
					output: `❌ Invalid output mode: ${arg}. Use: json, table, csv`,
				};
			}

			return {
				output: `✓ Output mode: ${requestedMode}`,
				stateChange: { outputMode: requestedMode as OutputMode },
			};
		}

		case '.import': {
			// Import and execute a SQL file
			if (!arg) {
				return { output: '❌ Usage: .import <file.sql>' };
			}

			if (!state.dbConnection) {
				return { output: '❌ .import requires database connection (--db)' };
			}

			const resolvedPath = resolve(process.cwd(), arg);
			if (!existsSync(resolvedPath)) {
				return { output: `❌ File not found: ${arg}` };
			}

			try {
				let sqlContent = readFileSync(resolvedPath, 'utf-8');

				// If schema is set via .use, prefix with SET search_path
				if (state.schemaName) {
					sqlContent = `SET search_path TO "${state.schemaName}", public;\n${sqlContent}`;
				}

				const result = await state.dbConnection.executeRaw(sqlContent, []);

				// Check for execution errors (returned as result.error, not thrown)
				if (result.error) {
					return {
						output: `❌ Import failed: ${result.error}`,
						success: false,
						error: result.error,
					};
				}

				const rowInfo =
					result.rowCount !== undefined
						? ` (${result.rowCount} rows affected)`
						: '';
				const schemaInfo = state.schemaName
					? ` (schema: ${state.schemaName})`
					: '';
				return {
					output: `✅ Imported: ${arg}${rowInfo}${schemaInfo}`,
					success: true,
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					output: `❌ Import failed: ${message}`,
					success: false,
					error: message,
				};
			}
		}

		case '.exit':
		case '.quit':
			return { output: 'Exiting...' };

		default:
			return { output: `❌ Unknown command: ${command}` };
	}
}

/**
 * NQL v2: Execute a NQL query (handles both SELECT and mutations)
 */
async function executeNqlQuery(
	input: string,
	state: BatchState,
): Promise<BatchResult> {
	// NQL requires ModelIR
	if (!state.model) {
		return {
			query: input,
			success: false,
			error: 'No schema model available for NQL compilation',
			type: 'query',
		};
	}

	try {
		// Compile NQL to SQL
		const compileOptions: import('./nql-executor.js').NqlCompileOptions = {};
		if (state.schemaName) compileOptions.schemaName = state.schemaName;
		if (state.namingConvention)
			compileOptions.namingConvention = state.namingConvention;
		const result = await compileNqlToSql(
			input,
			state.model,
			Object.keys(compileOptions).length > 0 ? compileOptions : undefined,
		);

		// Determine result type for BatchResult
		const resultType: 'query' | 'mutation' =
			result.intentType === 'query' ? 'query' : 'mutation';

		// Format parse tree if parseMode is enabled
		const parseTreeOutput = state.parseMode ? formatParseTree(result) : '';

		// If exec mode is enabled and we have a DB connection, execute the query
		if (state.execEnabled && state.dbConnection) {
			try {
				const execResult = await state.dbConnection.executeRaw(
					result.sql,
					result.params as unknown[],
				);

				// Check for execution errors (returned as result.error, not thrown)
				if (execResult.error) {
					return {
						query: input,
						success: true, // NQL compiled successfully
						dbSuccess: false, // But DB execution failed
						error: `Database error: ${execResult.error}`,
						output: `❌ Error: Database error: ${execResult.error}`,
						sql: result.sql,
						params: result.params,
						type: resultType,
						intent: result.intent,
					};
				}

				const outputParts = [];
				if (parseTreeOutput) {
					outputParts.push(parseTreeOutput);
				}
				outputParts.push(
					formatNqlResult(result),
					'',
					`Rows: ${execResult.rowCount}`,
					formatOutput(execResult.rows, execResult.columns, state.outputMode),
				);
				return {
					query: input,
					success: true,
					dbSuccess: true, // DB execution succeeded
					output: outputParts.join('\n'),
					sql: result.sql,
					params: result.params,
					type: resultType,
					intent: result.intent,
					rowCount: execResult.rowCount,
					rows: execResult.rows,
					columns: execResult.columns,
				};
			} catch (execError) {
				const message =
					execError instanceof Error ? execError.message : String(execError);
				const errorOutput = `Execution error: ${message}`;
				return {
					query: input,
					success: true, // NQL compiled successfully
					dbSuccess: false, // But DB execution failed
					error: errorOutput,
					output: errorOutput, // For db.output.contains assertions
					sql: result.sql,
					params: result.params,
					type: resultType,
					intent: result.intent,
				};
			}
		}

		// Non-exec mode: return SQL only
		const dryRunOutput = parseTreeOutput
			? [parseTreeOutput, formatNqlResult(result)].join('\n')
			: formatNqlResult(result);
		return {
			query: input,
			success: true,
			output: dryRunOutput,
			sql: result.sql,
			params: result.params,
			type: resultType,
			intent: result.intent,
		};
	} catch (error) {
		// Handle NQL-specific errors
		if (error instanceof NqlParseError) {
			return {
				query: input,
				success: false,
				error: error.message,
				output: error.message, // For db.output.contains assertions
				type: 'query',
			};
		}
		if (error instanceof NqlCompileError) {
			return {
				query: input,
				success: false,
				error: error.message,
				output: error.message, // For db.output.contains assertions
				type: 'query',
			};
		}
		const message = error instanceof Error ? error.message : String(error);
		return {
			query: input,
			success: false,
			error: message,
			output: message, // For db.output.contains assertions
			type: 'query',
		};
	}
}

/**
 * Execute a raw SQL query (in SQL mode)
 */
async function executeRawSql(
	input: string,
	state: BatchState,
): Promise<BatchResult> {
	if (!state.execEnabled || !state.dbConnection) {
		return {
			query: input,
			success: true,
			output: `[SQL Mode - Compile only]\n${input}`,
			sql: input,
			type: 'query',
		};
	}

	try {
		const result = await state.dbConnection.executeRaw(input, []);

		// Check for execution errors (returned as result.error, not thrown)
		if (result.error) {
			return {
				query: input,
				success: true, // SQL parsed successfully (! prefix)
				dbSuccess: false, // But DB execution failed
				error: `Database error: ${result.error}`,
				output: `❌ Error: Database error: ${result.error}`,
				sql: input,
				type: 'query',
			};
		}

		return {
			query: input,
			success: true,
			dbSuccess: true, // DB execution succeeded
			output: `Executed SQL: ${result.rowCount ?? 0} rows affected`,
			sql: input,
			type: 'query',
			rowCount: result.rowCount ?? 0,
			rows: result.rows,
			columns: result.columns,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			query: input,
			success: false,
			error: message,
			output: message, // For db.output.contains assertions
			sql: input,
			type: 'query',
		};
	}
}

/**
 * Run batch mode execution
 */
/**
 * Result of executing a batch of queries (without side effects).
 * Used by tests to programmatically run examples.
 */
export interface BatchExecutionResult {
	results: BatchResult[];
	assertionSummary?: AssertionSummary | undefined;
}

/**
 * Core batch execution logic — runs queries and optional assertions,
 * returning structured results without printing or calling process.exit().
 *
 * @param options - Batch mode configuration
 * @returns Execution results with optional assertion summary
 */
export async function executeBatch(
	options: BatchModeOptions,
): Promise<BatchExecutionResult> {
	const { queries, schema, databaseUrl, assertFile, namingConvention } =
		options;

	// Initialize state
	// ARCH-005: Use schema.model directly (already ModelIR)
	const model = schema.model;

	const state: BatchState = {
		mode: 'natural',
		execEnabled: false,
		schemaName: undefined,
		dbConnection: undefined,
		explainMode: false,
		parseMode: false,
		model, // NQL v2: ModelIR for compileNqlToSql
		...(namingConvention && { namingConvention }),
		outputMode: 'json', // NQL v2.1: Default output format
	};

	// Connect to database if URL provided
	if (databaseUrl) {
		try {
			state.dbConnection = await createDbConnection(databaseUrl);
			state.execEnabled = true; // Enable execution mode when DB is connected
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Database connection failed: ${message}`);
		}
	}

	// Parse assertion file if provided
	let assertionBlocks: Parameters<typeof runAssertions>[0] | undefined;
	if (assertFile) {
		let assertContent: string;
		try {
			assertContent = readFileSync(assertFile, 'utf-8');
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`Failed to read assertion file: ${assertFile} — ${message}`,
			);
		}
		const parseResult = parseAssertionFile(assertContent);

		if (parseResult.errors.length > 0) {
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
			const errorMessages = validationErrors
				.map((err) => `Line ${err.line}: ${err.message}`)
				.join('\n');
			throw new Error(`Assertion validation errors:\n${errorMessages}`);
		}

		assertionBlocks = parseResult.blocks;
	}

	const results: BatchResult[] = [];

	try {
		for (const query of queries) {
			// Check for mode escape (! prefix)
			const { content: effectiveQuery, isRawSql } = parseInputMode(
				query,
				state.mode,
			);

			let result: BatchResult;

			// Process dot commands (async for .import support)
			if (effectiveQuery.startsWith('.')) {
				const cmdResult = await processDotCommand(
					effectiveQuery,
					schema,
					state,
				);
				if (cmdResult.stateChange) {
					Object.assign(state, cmdResult.stateChange);
				}
				const cmdError = cmdResult.error;
				const cmdSuccess =
					cmdResult.success ?? !cmdResult.output.startsWith('❌');
				const baseResult: BatchResult = {
					query: effectiveQuery,
					success: cmdSuccess && !cmdError,
					output: cmdResult.output,
					type: 'command',
				};
				if (cmdError) {
					baseResult.error = cmdError;
				}
				result = baseResult;
			} else if (isRawSql) {
				// Raw SQL mode
				result = await executeRawSql(effectiveQuery, state);
			} else {
				// NQL v2: Unified execution for queries and mutations
				result = await executeNqlQuery(effectiveQuery, state);
			}

			results.push(result);
		}
	} finally {
		// Cleanup DB connection
		if (state.dbConnection) {
			await state.dbConnection.close();
		}
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
