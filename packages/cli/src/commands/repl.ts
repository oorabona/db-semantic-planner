/**
 * DX-030 Block 1: REPL Command
 *
 * dbsp repl [--schema <path>] - Launch interactive REPL.
 */

import { Command } from 'commander';
import { loadSchema, loadSchemaFromCwd } from '../utils/schema-loader.js';

export interface ReplOptions {
	schema?: string;
	/** CLI-020: Database connection URL for execution mode */
	db?: string;
}

export const replCommand = new Command('repl')
	.description('Launch interactive REPL for exploring schema and queries')
	.option('-s, --schema <path>', 'Path to schema file (default: auto-detect)')
	.option('-d, --db <url>', 'PostgreSQL connection URL for execution mode (e.g., postgres://localhost/mydb)')
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
