/**
 * @module dot-commands
 * Interactive REPL dot-command processing (`.tables`, `.schema`, `.exec`, etc.).
 *
 * Extracted from batch.ts for SRP (Phase 5.5).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ModelIR } from '@dbsp/core';
import type { LoadedSchema } from '../utils/schema-loader.js';
import { formatCsv, parseCsvFile } from './csv.js';
import type { DbConnection } from './db-connection.js';
import type { QueryMode } from './types.js';

/** Shared state interface used by dot-commands and batch mode. */
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
	/** DB column casing (intuitive). */
	dbCasing?: 'snake_case' | 'camelCase' | 'preserve';
	/** E16c: Whether a transaction is currently active */
	inTransaction: boolean;
}

// ============================================================================
// Format Helpers
// ============================================================================

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

// ============================================================================
// Dot Command Processor
// ============================================================================

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
  .load <table> <f> - Import CSV file into table
  .dump <table> <f> - Export table to CSV file
  .begin            - Start a transaction
  .commit           - Commit the active transaction
  .rollback         - Rollback the active transaction
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

		case '.begin': {
			if (!state.dbConnection) {
				return { output: '❌ No database connection. Use --db option.' };
			}
			if (state.dbConnection.inTransaction) {
				return {
					output:
						'❌ Transaction already active. Use .commit or .rollback first.',
				};
			}
			try {
				await state.dbConnection.beginTransaction();
				return {
					output: '✓ Transaction started (BEGIN)',
					stateChange: { inTransaction: true },
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return { output: `❌ Failed to begin transaction: ${message}` };
			}
		}

		case '.commit': {
			if (!state.dbConnection) {
				return { output: '❌ No database connection. Use --db option.' };
			}
			if (!state.dbConnection.inTransaction) {
				return { output: '❌ No active transaction. Use .begin first.' };
			}
			try {
				await state.dbConnection.commitTransaction();
				return {
					output: '✓ Transaction committed (COMMIT)',
					stateChange: { inTransaction: false },
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return { output: `❌ Commit failed: ${message}` };
			}
		}

		case '.rollback': {
			if (!state.dbConnection) {
				return { output: '❌ No database connection. Use --db option.' };
			}
			if (!state.dbConnection.inTransaction) {
				return { output: '❌ No active transaction. Use .begin first.' };
			}
			try {
				await state.dbConnection.rollbackTransaction();
				return {
					output: '✓ Transaction rolled back (ROLLBACK)',
					stateChange: { inTransaction: false },
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return { output: `❌ Rollback failed: ${message}` };
			}
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

		case '.load': {
			// E16: Bulk CSV import into a table
			const loadParts = arg.split(/\s+/);
			const tableName = loadParts[0];
			const filePath = loadParts.slice(1).join(' ');

			if (!tableName || !filePath) {
				return { output: '❌ Usage: .load <table> <file.csv>' };
			}

			if (!state.dbConnection) {
				return { output: '❌ .load requires database connection (--db)' };
			}

			// Verify table exists in schema
			const loadTable = schema.model.tables.get(tableName);
			if (!loadTable) {
				return { output: `❌ Table not found: ${tableName}` };
			}

			const loadFilePath = resolve(process.cwd(), filePath);
			if (!existsSync(loadFilePath)) {
				return { output: `❌ File not found: ${filePath}` };
			}

			try {
				const schemaColumns = loadTable.columns.map((c) => c.name);
				const csvData = await parseCsvFile(loadFilePath, schemaColumns);

				if (csvData.rows.length === 0) {
					return { output: '⚠️ CSV file is empty — no rows to import' };
				}

				// Build multi-row INSERT using CSV columns
				const csvColumns = [...csvData.format.columns];
				// Filter to columns that exist in the table
				const validColumns = csvColumns.filter((c) =>
					schemaColumns.includes(c),
				);
				if (validColumns.length === 0) {
					return {
						output: `❌ No matching columns found between CSV (${csvColumns.join(', ')}) and table ${tableName} (${schemaColumns.join(', ')})`,
					};
				}

				// Batch insert (100 rows per batch to avoid parameter limit)
				const BATCH_SIZE = 100;
				let totalInserted = 0;

				for (let i = 0; i < csvData.rows.length; i += BATCH_SIZE) {
					const batch = csvData.rows.slice(i, i + BATCH_SIZE);
					const params: unknown[] = [];
					const valueRows: string[] = [];

					for (const row of batch) {
						const placeholders: string[] = [];
						for (const col of validColumns) {
							params.push(row[col] ?? null);
							placeholders.push(`$${params.length}`);
						}
						valueRows.push(`(${placeholders.join(', ')})`);
					}

					const quotedCols = validColumns.map((c) => `"${c}"`).join(', ');
					const schemaPrefix = state.schemaName ? `"${state.schemaName}".` : '';
					const sql = `INSERT INTO ${schemaPrefix}"${tableName}" (${quotedCols}) VALUES ${valueRows.join(', ')}`;

					const result = await state.dbConnection.executeRaw(sql, params);
					if (result.error) {
						return {
							output: `❌ Insert failed at row ${totalInserted + 1}: ${result.error}`,
							success: false,
							error: result.error,
						};
					}
					totalInserted += batch.length;
				}

				const formatInfo = `separator: '${csvData.format.separator === '\t' ? '\\t' : csvData.format.separator}', header: ${csvData.format.hasHeader ? 'yes' : 'no'}`;
				return {
					output: `✅ Loaded ${totalInserted} rows into ${tableName} (${formatInfo})`,
					success: true,
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					output: `❌ Load failed: ${message}`,
					success: false,
					error: message,
				};
			}
		}

		case '.dump': {
			// E16e: Export table to CSV file
			const dumpParts = arg.split(/\s+/);
			const dumpTableName = dumpParts[0];
			const dumpFilePath = dumpParts.slice(1).join(' ');

			if (!dumpTableName || !dumpFilePath) {
				return { output: '❌ Usage: .dump <table> <file.csv>' };
			}

			if (!state.dbConnection) {
				return { output: '❌ .dump requires database connection (--db)' };
			}

			// Verify table exists in schema
			const dumpTable = schema.model.tables.get(dumpTableName);
			if (!dumpTable) {
				return { output: `❌ Table not found: ${dumpTableName}` };
			}

			try {
				const schemaPrefix = state.schemaName ? `"${state.schemaName}".` : '';
				const result = await state.dbConnection.executeRaw(
					`SELECT * FROM ${schemaPrefix}"${dumpTableName}"`,
				);

				if (result.error) {
					return {
						output: `❌ Query failed: ${result.error}`,
						success: false,
						error: result.error,
					};
				}

				const columns =
					result.columns.length > 0
						? result.columns
						: dumpTable.columns.map((c) => c.name);

				const csv = formatCsv(result.rows, columns);
				const resolvedDumpPath = resolve(process.cwd(), dumpFilePath);
				writeFileSync(resolvedDumpPath, `${csv}\n`, 'utf-8');

				return {
					output: `✅ Dumped ${result.rows.length} rows from ${dumpTableName} to ${dumpFilePath}`,
					success: true,
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					output: `❌ Dump failed: ${message}`,
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
