/**
 * DX-030 Block 1: REPL Command
 *
 * dbsp repl [--schema <path>] - Launch interactive REPL.
 */

import { Command } from 'commander';
import { loadSchema, loadSchemaFromCwd } from '../utils/schema-loader.js';

export interface ReplOptions {
	schema?: string;
}

export const replCommand = new Command('repl')
	.description('Launch interactive REPL for exploring schema and queries')
	.option('-s, --schema <path>', 'Path to schema file (default: auto-detect)')
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
			await startRepl({ schema, schemaPath });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`❌ ${message}`);
			process.exit(1);
		}
	});
