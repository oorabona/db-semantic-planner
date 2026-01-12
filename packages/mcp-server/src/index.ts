#!/usr/bin/env node
/**
 * @db-semantic-planner/mcp-server
 *
 * MCP Server entry point for db-semantic-planner.
 *
 * Usage:
 *   dbsp-mcp --schema ./path/to/schema.ts
 *   dbsp-mcp -s ./dbsp.schema.ts
 *
 * The server exposes db-semantic-planner schema and query planning capabilities
 * via the Model Context Protocol (MCP), enabling AI tools like Claude Code and
 * Cursor to understand database schemas and generate optimized queries.
 */

import { loadSchema, SchemaLoadError } from './schema-loader.js';
import { startMcpServer } from './server.js';

/**
 * CLI argument parsing result.
 */
interface CliArgs {
	schemaPath: string;
	allowedRoots?: string[];
	help: boolean;
}

/**
 * Parse command line arguments.
 */
function parseArgs(args: string[]): CliArgs {
	const result: CliArgs = {
		schemaPath: '',
		help: false,
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		if (arg === undefined) {
			continue;
		}

		if (arg === '--help' || arg === '-h') {
			result.help = true;
		} else if (arg === '--schema' || arg === '-s') {
			const nextArg = args[i + 1];
			if (nextArg === undefined || nextArg.startsWith('-')) {
				throw new Error('--schema requires a path argument');
			}
			result.schemaPath = nextArg;
			i++; // Skip next arg
		} else if (arg === '--allowed-root' || arg === '-r') {
			const nextArg = args[i + 1];
			if (nextArg === undefined || nextArg.startsWith('-')) {
				throw new Error('--allowed-root requires a path argument');
			}
			result.allowedRoots = result.allowedRoots ?? [];
			result.allowedRoots.push(nextArg);
			i++; // Skip next arg
		} else if (arg.startsWith('--schema=')) {
			result.schemaPath = arg.slice('--schema='.length);
		} else if (arg.startsWith('-s=')) {
			result.schemaPath = arg.slice('-s='.length);
		} else if (arg.startsWith('--allowed-root=')) {
			result.allowedRoots = result.allowedRoots ?? [];
			result.allowedRoots.push(arg.slice('--allowed-root='.length));
		}
	}

	return result;
}

/**
 * Print usage help.
 */
function printHelp(): void {
	console.log(`
@db-semantic-planner/mcp-server

MCP Server exposing db-semantic-planner schema and query planning capabilities.

USAGE:
  dbsp-mcp --schema <path>

OPTIONS:
  -s, --schema <path>       Path to the schema file (TypeScript or JavaScript)
                            Required. Must export 'schema' or default export.

  -r, --allowed-root <path> Restrict schema loading to this directory (repeatable)
                            Security: prevents loading files outside allowed roots.

  -h, --help                Show this help message

EXAMPLES:
  # Basic usage
  dbsp-mcp --schema ./dbsp.schema.ts

  # With security restrictions
  dbsp-mcp --schema ./dbsp.schema.ts --allowed-root ./

  # Short form
  dbsp-mcp -s ./schema.js

SCHEMA FILE FORMAT:
  The schema file must export a ResolvedSchema object:

    // dbsp.schema.ts
    import { defineSchema, table, column, relation } from '@db-semantic-planner/schema';

    export const schema = defineSchema({
      tables: {
        users: table({
          id: column.uuid().primaryKey(),
          email: column.text().unique(),
          // ...
        }),
      },
      relations: {
        // ...
      },
    });

MCP CONFIGURATION:
  Add to your MCP settings (claude_desktop_config.json or .mcp.json):

    {
      "mcpServers": {
        "dbsp": {
          "command": "npx",
          "args": ["@db-semantic-planner/mcp-server", "--schema", "./dbsp.schema.ts"]
        }
      }
    }
`);
}

/**
 * Main entry point.
 */
async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));

	if (args.help) {
		printHelp();
		process.exit(0);
	}

	if (!args.schemaPath) {
		console.error('Error: --schema argument is required');
		console.error('');
		console.error('Usage: dbsp-mcp --schema <path>');
		console.error('');
		console.error('Run "dbsp-mcp --help" for more information.');
		process.exit(1);
	}

	try {
		// Load and validate schema
		console.error(`[dbsp-mcp] Loading schema from: ${args.schemaPath}`);

		const loaderOptions = {
			schemaPath: args.schemaPath,
			...(args.allowedRoots && { allowedRoots: args.allowedRoots }),
		};
		const { schema, resolvedPath } = await loadSchema(loaderOptions);

		console.error(`[dbsp-mcp] Schema loaded from: ${resolvedPath}`);

		// Start MCP server
		await startMcpServer({ schema });
	} catch (error) {
		if (error instanceof SchemaLoadError) {
			console.error(
				`[dbsp-mcp] Schema error (${error.code}): ${error.message}`,
			);
		} else {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`[dbsp-mcp] Error: ${message}`);
		}
		process.exit(1);
	}
}

// Run main
main().catch((error) => {
	console.error('[dbsp-mcp] Fatal error:', error);
	process.exit(1);
});
