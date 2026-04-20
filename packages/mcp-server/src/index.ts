#!/usr/bin/env node
/**
 * @dbsp/mcp-server
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
export function parseArgs(args: string[]): CliArgs {
	const result: CliArgs = {
		schemaPath: '',
		help: false,
	};

	// Normalize --foo=bar form → ['--foo', 'bar'] before main loop
	const normalized: string[] = [];
	for (const arg of args) {
		if (arg.startsWith('--') && arg.includes('=')) {
			const eqIdx = arg.indexOf('=');
			normalized.push(arg.slice(0, eqIdx), arg.slice(eqIdx + 1));
		} else if (
			arg.startsWith('-') &&
			!arg.startsWith('--') &&
			arg.includes('=')
		) {
			const eqIdx = arg.indexOf('=');
			normalized.push(arg.slice(0, eqIdx), arg.slice(eqIdx + 1));
		} else {
			normalized.push(arg);
		}
	}

	for (let i = 0; i < normalized.length; i++) {
		const arg = normalized[i];

		if (arg === undefined) {
			continue;
		}

		if (arg === '--help' || arg === '-h') {
			result.help = true;
		} else if (arg === '--schema' || arg === '-s') {
			const nextArg = normalized[i + 1];
			if (nextArg === undefined || nextArg.startsWith('-')) {
				throw new Error('--schema requires a path argument');
			}
			result.schemaPath = nextArg;
			i++; // Skip next arg
		} else if (arg === '--allowed-root' || arg === '-r') {
			const nextArg = normalized[i + 1];
			if (nextArg === undefined || nextArg.startsWith('-')) {
				throw new Error('--allowed-root requires a path argument');
			}
			result.allowedRoots = result.allowedRoots ?? [];
			result.allowedRoots.push(nextArg);
			i++; // Skip next arg
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}

	return result;
}

/**
 * Print usage help.
 */
function printHelp(): void {
	console.log(`
@dbsp/mcp-server

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
    import { defineSchema } from '@dbsp/core';

    export const schema = defineSchema({
      users: {
        id: { type: 'uuid', primaryKey: true },
        email: { type: 'string', unique: true },
        // ...
      },
    });

MCP CONFIGURATION:
  Add to your MCP settings (claude_desktop_config.json or .mcp.json):

    {
      "mcpServers": {
        "dbsp": {
          "command": "npx",
          "args": ["@dbsp/mcp-server", "--schema", "./dbsp.schema.ts"]
        }
      }
    }
`);
}

/**
 * Main entry point.
 */
async function main(): Promise<void> {
	let args: CliArgs;
	try {
		args = parseArgs(process.argv.slice(2));
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`Error: ${msg}`);
		console.error('');
		console.error('Run "dbsp-mcp --help" for usage information.');
		process.exit(1);
	}

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
		// Log basename only before load (avoid leaking absolute path pre-validation)
		const { basename } = await import('node:path');
		console.error(
			`[dbsp-mcp] Loading schema from: ${basename(args.schemaPath)}`,
		);

		const loaderOptions = {
			schemaPath: args.schemaPath,
			...(args.allowedRoots && { allowedRoots: args.allowedRoots }),
		};
		const { schema, resolvedPath } = await loadSchema(loaderOptions);

		// Log resolved (canonical) path after successful load
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

// Run main only when executed directly (not when imported by tests or other modules).
// Compare the resolved path of this module against process.argv[1] (the entry script).
if (process.argv[1] !== undefined) {
	const _thisFile = new URL(import.meta.url).pathname;
	// tsx may pass the .ts source path; normalise both sides for comparison
	const _mainFile = process.argv[1].replace(/\.[cm]?[jt]s$/, '');
	if (_thisFile.replace(/\.[cm]?[jt]s$/, '') === _mainFile) {
		main().catch((error) => {
			console.error('[dbsp-mcp] Fatal error:', error);
			process.exit(1);
		});
	}
}
