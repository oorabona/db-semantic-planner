/**
 * CLI-022: Batch Mode for REPL
 *
 * Executes queries from files or command line without interactive UI.
 * Supports dot commands and natural queries.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
	assertResolvedSchemaToGeneratedSchema,
	buildModelFromSchema,
	type ModelIR,
	type ResolvedSchema,
} from '@dbsp/core';
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
import type { QueryMode } from './types.js';

export interface BatchModeOptions {
	queries: string[];
	schema: ResolvedSchema;
	schemaPath: string;
	format: 'text' | 'json';
	databaseUrl?: string;
	/** DEMO-E2E: Path to assertion file (.assert.dbsp) */
	assertFile?: string;
}

export interface BatchResult {
	query: string;
	success: boolean;
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
}

/**
 * NQL v2: Convert ResolvedSchema to ModelIR for NQL compilation
 */
function buildModelFromResolvedSchema(schema: ResolvedSchema): ModelIR {
	const generatedSchema = assertResolvedSchemaToGeneratedSchema(schema);
	return buildModelFromSchema(generatedSchema);
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
 */
function formatTables(schema: ResolvedSchema): string {
	const tables = Object.keys(schema.tables);
	return `Tables (${tables.length}):\n${tables.map((t) => `  - ${t}`).join('\n')}`;
}

/**
 * Format table schema as text
 * TableDefinition IS the columns map (Record<string, ColumnDefinition>)
 */
function formatTableSchema(schema: ResolvedSchema, tableName: string): string {
	const table = schema.tables[tableName];
	if (!table) {
		return `❌ Table not found: ${tableName}`;
	}

	const lines = [`Table: ${tableName}`, 'Columns:'];
	// table is directly Record<string, ColumnDefinition>
	for (const [colName, col] of Object.entries(table)) {
		if (!col) continue;
		const nullable = col.nullable ? '' : ' (NOT NULL)';
		lines.push(`  - ${colName}: ${col.type}${nullable}`);
	}
	return lines.join('\n');
}

/**
 * Get relation description
 */
function getRelationDescription(rel: { kind: string; target: string }): string {
	return `${rel.kind} → ${rel.target}`;
}

/**
 * Format relations as text
 */
function formatRelations(schema: ResolvedSchema, tableName?: string): string {
	const relations = Object.entries(schema.relations);

	if (tableName) {
		// Filter relations involving this table
		const tableRelations = relations.filter(
			([, rel]) =>
				rel.target === tableName ||
				Object.keys(schema.tables).some((_t) => {
					const tableRels = schema.relations;
					// Check if relation is from this table
					return (
						tableRels[
							`${tableName}.${(rel as { kind: string; target: string }).kind}`
						] !== undefined
					);
				}),
		);
		if (tableRelations.length === 0) {
			return `No relations found for table: ${tableName}`;
		}
		const lines = [`Relations for ${tableName}:`];
		for (const [name, rel] of tableRelations) {
			lines.push(
				`  - ${name}: ${getRelationDescription(rel as { kind: string; target: string })}`,
			);
		}
		return lines.join('\n');
	}

	const lines = [`Relations (${relations.length}):`];
	for (const [name, rel] of relations) {
		lines.push(
			`  - ${name}: ${getRelationDescription(rel as { kind: string; target: string })}`,
		);
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
 * @internal - Exported for testing
 */
export async function processDotCommand(
	input: string,
	schema: ResolvedSchema,
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
  .import <file>    - Execute SQL file (DDL, seed data)
  .natural          - Switch to natural query mode
  .sql              - Switch to SQL mode
  .help             - Show this help`,
			};

		case '.tables':
			return { output: formatTables(schema) };

		case '.schema':
			if (!arg) {
				const tableCount = Object.keys(schema.tables).length;
				const relationCount = Object.keys(schema.relations).length;
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
		const result = compileNqlToSql(
			input,
			state.model,
			state.schemaName ? { schemaName: state.schemaName } : undefined,
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
						success: false,
						error: `Database error: ${execResult.error}`,
						sql: result.sql,
						params: result.params,
						type: resultType,
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
					formatRows(execResult.rows, execResult.columns),
				);
				return {
					query: input,
					success: true,
					output: outputParts.join('\n'),
					sql: result.sql,
					params: result.params,
					type: resultType,
				};
			} catch (execError) {
				const message =
					execError instanceof Error ? execError.message : String(execError);
				return {
					query: input,
					success: false,
					error: `Execution error: ${message}`,
					sql: result.sql,
					params: result.params,
					type: resultType,
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
		};
	} catch (error) {
		// Handle NQL-specific errors
		if (error instanceof NqlParseError) {
			return {
				query: input,
				success: false,
				error: error.message,
				type: 'query',
			};
		}
		if (error instanceof NqlCompileError) {
			return {
				query: input,
				success: false,
				error: error.message,
				type: 'query',
			};
		}
		const message = error instanceof Error ? error.message : String(error);
		return {
			query: input,
			success: false,
			error: message,
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
				success: false,
				error: `Database error: ${result.error}`,
				sql: input,
				type: 'query',
			};
		}

		return {
			query: input,
			success: true,
			output: `Executed SQL: ${result.rowCount ?? 0} rows affected`,
			sql: input,
			type: 'query',
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			query: input,
			success: false,
			error: message,
			sql: input,
			type: 'query',
		};
	}
}

/**
 * Format rows as a simple text table
 */
function formatRows(
	rows: Record<string, unknown>[],
	columns: string[],
): string {
	if (rows.length === 0) {
		return '(empty result set)';
	}

	// Calculate column widths
	const widths = columns.map((col) => {
		const maxDataWidth = Math.max(
			...rows.map((row) => String(row[col] ?? 'null').length),
		);
		return Math.max(col.length, maxDataWidth);
	});

	// Header row
	const header = columns
		.map((col, i) => col.padEnd(widths[i] ?? 0))
		.join(' | ');
	const separator = widths.map((w) => '-'.repeat(w)).join('-+-');

	// Data rows
	const dataRows = rows.map((row) =>
		columns
			.map((col, i) => String(row[col] ?? 'null').padEnd(widths[i] ?? 0))
			.join(' | '),
	);

	return [header, separator, ...dataRows].join('\n');
}

/**
 * Run batch mode execution
 */
export async function runBatchMode(options: BatchModeOptions): Promise<void> {
	const { queries, schema, format, databaseUrl, assertFile } = options;

	// Initialize state
	// NQL v2: Build ModelIR for NQL compilation
	const model = buildModelFromResolvedSchema(schema);

	const state: BatchState = {
		mode: 'natural',
		execEnabled: false,
		schemaName: undefined,
		dbConnection: undefined,
		explainMode: false,
		parseMode: false,
		model, // NQL v2: ModelIR for compileNqlToSql
	};

	// Connect to database if URL provided
	if (databaseUrl) {
		try {
			state.dbConnection = await createDbConnection(databaseUrl);
			state.execEnabled = true; // Enable execution mode when DB is connected
			console.error(`✅ Connected to database`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`⚠️  Database connection failed: ${message}`);
			console.error('Continuing in compile-only mode.\n');
		}
	}

	// DEMO-E2E: Parse assertion file if provided
	let assertionSummary: AssertionSummary | undefined;
	if (assertFile) {
		try {
			const assertContent = readFileSync(assertFile, 'utf-8');
			const parseResult = parseAssertionFile(assertContent);

			if (parseResult.errors.length > 0) {
				console.error(`❌ Assertion file parse errors:`);
				for (const err of parseResult.errors) {
					console.error(`  Line ${err.line}: ${err.message}`);
				}
				process.exit(1);
			}

			// Validate query references
			const validationErrors = validateAssertionBlocks(
				parseResult.blocks,
				queries.length,
				queries,
			);
			if (validationErrors.length > 0) {
				console.error(`❌ Assertion validation errors:`);
				for (const err of validationErrors) {
					console.error(`  Line ${err.line}: ${err.message}`);
				}
				process.exit(1);
			}

			// Store blocks for later execution
			(
				state as BatchState & { assertionBlocks?: typeof parseResult.blocks }
			).assertionBlocks = parseResult.blocks;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`❌ Failed to read assertion file: ${message}`);
			process.exit(1);
		}
	}

	const results: BatchResult[] = [];

	for (const query of queries) {
		// Check for mode escape (! prefix)
		const { content: effectiveQuery, isRawSql } = parseInputMode(
			query,
			state.mode,
		);

		let result: BatchResult;

		// Process dot commands (async for .import support)
		if (effectiveQuery.startsWith('.')) {
			const cmdResult = await processDotCommand(effectiveQuery, schema, state);
			if (cmdResult.stateChange) {
				Object.assign(state, cmdResult.stateChange);
			}
			// Extract error from cmdResult if present (e.g., from .import)
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

		// Output in text format
		if (format === 'text') {
			console.log(`\n> ${query}`);
			if (result.success) {
				console.log(result.output);
			} else {
				// Use error field if set, otherwise output already contains the error message
				console.error(
					result.error ? `❌ Error: ${result.error}` : result.output,
				);
			}
		}
	}

	// DEMO-E2E: Run assertions if provided
	const assertionBlocks = (
		state as BatchState & {
			assertionBlocks?: Parameters<typeof runAssertions>[0];
		}
	).assertionBlocks;
	if (assertionBlocks) {
		const hasDb = !!state.dbConnection;
		assertionSummary = runAssertions(assertionBlocks, results, queries, hasDb);

		// Output assertion results in text format
		if (format === 'text') {
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
						console.log(`  ✗ ${assertion.type}: ${assertion.message}`);
						if (assertion.actual !== undefined) {
							const actualStr =
								typeof assertion.actual === 'string'
									? assertion.actual.slice(0, 100)
									: JSON.stringify(assertion.actual);
							console.log(`      actual: ${actualStr}`);
						}
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

	// Cleanup
	if (state.dbConnection) {
		await state.dbConnection.close();
	}

	// Exit with error code:
	// - If assertions provided: exit 1 only if any assertion failed (query failures are expected if asserted)
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
