/**
 * DX-030 Block 1: REPL Command
 *
 * dbsp repl [--schema <path>] - Launch interactive REPL.
 * CLI-022: Batch mode support with --eval and --input options.
 */

import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { loadSchema, loadSchemaFromCwd } from '../utils/schema-loader.js';

export interface ReplOptions {
	schema?: string;
	/** CLI-020: Database connection URL for execution mode */
	db?: string;
	/** CLI-022: Single query to evaluate (batch mode) */
	eval?: string;
	/** CLI-022: File containing queries to execute (batch mode, one per line) */
	input?: string;
	/** CLI-022: Output format for batch mode */
	format?: 'text' | 'json';
	/** DEMO-E2E: Assertion file for validating query output */
	assert?: string;
}

export const replCommand = new Command('repl')
	.description('Launch interactive REPL for exploring schema and queries')
	.option('-s, --schema <path>', 'Path to schema file (default: auto-detect)')
	.option('-d, --db <url>', 'PostgreSQL connection URL for execution mode (e.g., postgres://localhost/mydb)')
	.option('-e, --eval <query>', 'Execute a single query and exit (batch mode)')
	.option('-i, --input <file>', 'Execute queries from file, one per line (batch mode)')
	.option('-f, --format <format>', 'Output format for batch mode: text (default) or json', 'text')
	.option('-a, --assert <file>', 'Assertion file to validate query output (requires --input)')
	.action(async (options: ReplOptions) => {
		try {
			// Load schema
			let schemaPath: string;
			let schema: Awaited<ReturnType<typeof loadSchema>>;

			if (options.schema) {
				schema = await loadSchema(options.schema);
				schemaPath = options.schema;
			} else {
				const result = await loadSchemaFromCwd();
				schema = result.schema;
				schemaPath = result.path;
			}

			// DEMO-E2E: Validate --assert requires --input
			if (options.assert && !options.input) {
				throw new Error('--assert requires --input (assertion files validate query output from input files)');
			}

			// CLI-022: Batch mode - execute queries without interactive UI
			if (options.eval || options.input) {
				const { runBatchMode } = await import('../repl/batch.js');
				const queries: string[] = [];

				if (options.eval) {
					queries.push(options.eval);
				}

				if (options.input) {
					const content = readFileSync(options.input, 'utf-8');
					const lines = content
						.split('\n')
						.map((line) => line.trim())
						.filter((line) => line && !line.startsWith('#')); // Skip empty and comments
					queries.push(...lines);
				}

				await runBatchMode({
					queries,
					schema,
					schemaPath,
					format: options.format ?? 'text',
					...(options.db && { databaseUrl: options.db }),
					...(options.assert && { assertFile: options.assert }),
				});
				return;
			}

			// Dynamic import to avoid loading React/Ink for other commands
			const { startRepl } = await import('../repl/index.js');
			// CLI-020: Pass database URL if provided
			await startRepl({
				schema,
				schemaPath,
				...(options.db && { databaseUrl: options.db }),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`❌ ${message}`);
			process.exit(1);
		}
	});
