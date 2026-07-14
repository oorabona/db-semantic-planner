/**
 * DX-030 Block 1: REPL Command
 *
 * dbsp repl [--schema <path>] - Launch interactive REPL.
 * CLI-022: Batch mode support with --eval and --input options.
 */

import { readFileSync } from 'node:fs';
import type { DbCasing } from '@dbsp/types';
import { Command } from 'commander';
import { config } from '../config.js';
import { validateIdentifier } from '../utils/identifier-validation.js';
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
	/** CLI-IMPORT: SQL files to import before queries (injected as .import commands) */
	import?: string[];
	/** CLI-USE: PostgreSQL schema to use (injected as .use command) */
	use?: string;
	/** CLI-MUT: Start REPL with parse mode enabled */
	parse?: boolean;
	/** CLI-MUT: Start REPL with exec mode enabled */
	exec?: boolean;
	/** CLI-CONFIG: Custom config file path (default: ~/.dbsp/config.json) */
	config?: string;
	/** CLI-CASING: Column naming convention (describes DB column casing) */
	casing?: 'snake' | 'camel' | 'none';
}

export const replCommand = new Command('repl')
	.description('Launch interactive REPL for exploring schema and queries')
	.option('-s, --schema <path>', 'Path to schema file (default: auto-detect)')
	.option(
		'-d, --db <url>',
		'PostgreSQL connection URL for execution mode (e.g., postgres://localhost/mydb)',
	)
	.option('-e, --eval <query>', 'Execute a single query and exit (batch mode)')
	.option(
		'-i, --input <file>',
		'Execute queries from file, one per line (batch mode)',
	)
	.option(
		'-f, --format <format>',
		'Output format for batch mode: text (default) or json',
		'text',
	)
	.option(
		'-a, --assert <file>',
		'Assertion file to validate query output (requires --input)',
	)
	.option(
		'--import <files...>',
		'SQL files to import before queries (equivalent to .import commands)',
	)
	.option(
		'--use <schema>',
		'PostgreSQL schema to use (equivalent to .use command)',
	)
	.option('--parse', 'Start REPL with parse mode enabled (.parse toggle)')
	.option('--exec', 'Start REPL with exec mode enabled (.exec toggle)')
	.option(
		'--casing <type>',
		'Column naming convention: snake (DB uses snake_case), camel (DB uses camelCase), none (preserve as-is)',
	)
	.option(
		'-c, --config <path>',
		'Custom config file path (default: ~/.dbsp/config.json)',
	)
	.action(async (options: ReplOptions) => {
		// Set custom config path if provided
		if (options.config) {
			config.setConfigPath(options.config);
		}
		// Load config
		config.load();
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
				throw new Error(
					'--assert requires --input (assertion files validate query output from input files)',
				);
			}

			// CLI-IMPORT: Validate that --import requires batch mode (SQL file execution)
			// Note: --use, --parse, --exec work in interactive mode (REPL state setup)
			if (options.import && !options.eval && !options.input) {
				throw new Error('--import requires batch mode (--eval or --input)');
			}

			// SEC: Validate --use schema name at the entry point so both the batch path
			// (which injects `.use <schema>`) and the interactive path (which passes
			// initialSchemaName) are protected against SQL injection.
			if (options.use) {
				validateIdentifier(options.use, 'schema');
			}

			// CLI-CASING: explicit flag wins; otherwise use the schema declaration.
			const dbCasing = mapReplCasingOption(options.casing) ?? schema.dbCasing;

			// CLI-022: Batch mode - execute queries without interactive UI
			if (options.eval || options.input) {
				const { runBatchMode } = await import('../repl/batch.js');
				const queries: string[] = [];

				// CLI-USE: Inject .use command first (schema scoping)
				if (options.use) {
					queries.push(`.use ${options.use}`);
				}

				// CLI-IMPORT: Inject .import commands for SQL files
				if (options.import) {
					for (const file of options.import) {
						queries.push(`.import ${file}`);
					}
				}

				if (options.eval) {
					queries.push(options.eval);
				}

				if (options.input) {
					// EH-2: Map ENOENT to a friendly error instead of raw stack trace
					let content: string;
					try {
						content = readFileSync(options.input, 'utf-8');
					} catch (err) {
						const isNotFound =
							err instanceof Error &&
							'code' in err &&
							(err as NodeJS.ErrnoException).code === 'ENOENT';
						throw new Error(
							isNotFound
								? `Input file not found: ${options.input}`
								: `Failed to read input file: ${err instanceof Error ? err.message : String(err)}`,
						);
					}
					queries.push(...content.split('\n'));
				}

				await runBatchMode({
					queries,
					schema,
					schemaPath,
					format: options.format ?? 'text',
					...(options.db && { databaseUrl: options.db }),
					...(options.assert && { assertFile: options.assert }),
					...(dbCasing && { dbCasing }),
				});
				return;
			}

			// Dynamic import to avoid loading React/Ink for other commands
			const { startRepl } = await import('../repl/index.js');
			// CLI-020: Pass database URL if provided
			// CLI-MUT: Pass initial REPL state options
			await startRepl({
				schema,
				schemaPath,
				...(options.db && { databaseUrl: options.db }),
				...(options.use && { initialSchemaName: options.use }),
				...(options.parse && { initialParseMode: true }),
				...(options.exec && { initialExecMode: true }),
				...(dbCasing && { dbCasing }),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`❌ ${message}`);
			process.exit(1);
		}
	});

function mapReplCasingOption(
	casing: ReplOptions['casing'],
): DbCasing | undefined {
	switch (casing) {
		case 'snake':
			return 'snake_case';
		case 'camel':
			return 'camelCase';
		case 'none':
			return 'preserve';
		default:
			return undefined;
	}
}
