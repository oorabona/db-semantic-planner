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

import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs as parseNodeArgs } from 'node:util';
import { formatLogPath } from './format-error.js';
import { loadSchema, SchemaLoadError } from './schema-loader.js';
import { startMcpServer } from './server.js';

/**
 * CLI argument parsing result.
 */
interface CliArgs {
	schemaPath: string;
	allowedRoots?: string[];
	help: boolean;
	verbose?: boolean;
}

const CLI_PARSE_OPTIONS = {
	schema: {
		type: 'string',
		short: 's',
	},
	'allowed-root': {
		type: 'string',
		short: 'r',
		multiple: true,
	},
	help: {
		type: 'boolean',
		short: 'h',
	},
	verbose: {
		type: 'boolean',
		short: 'v',
	},
} as const;

const VALUE_FLAGS = new Set(['--schema', '-s', '--allowed-root', '-r']);
const KNOWN_FLAGS = new Set([
	...VALUE_FLAGS,
	'--help',
	'-h',
	'--verbose',
	'-v',
]);
const KNOWN_OPTION_NAMES = new Set([
	'schema',
	'allowed-root',
	'help',
	'verbose',
]);

function missingValueMessage(flag: string): string {
	return flag === '--allowed-root' || flag === '-r'
		? '--allowed-root requires a path argument'
		: '--schema requires a path argument';
}

function splitInlineValues(args: string[]): string[] {
	const normalized: string[] = [];

	for (const arg of args) {
		if (arg.startsWith('--') && arg.includes('=')) {
			const eqIdx = arg.indexOf('=');
			const flag = arg.slice(0, eqIdx);
			const value = arg.slice(eqIdx + 1);
			if (value === '' && (flag === '--schema' || flag === '--allowed-root')) {
				throw new Error(`${flag} requires a non-empty path argument`);
			}
			normalized.push(flag, value);
		} else if (
			arg.startsWith('-') &&
			!arg.startsWith('--') &&
			arg.includes('=')
		) {
			const eqIdx = arg.indexOf('=');
			const flag = arg.slice(0, eqIdx);
			const value = arg.slice(eqIdx + 1);
			if (value === '' && (flag === '-s' || flag === '-r')) {
				throw new Error(`${flag} requires a non-empty path argument`);
			}
			normalized.push(flag, value);
		} else {
			normalized.push(arg);
		}
	}

	return normalized;
}

function prepareArgsForNodeParse(args: string[]): string[] {
	const splitArgs = splitInlineValues(args);
	const normalized: string[] = [];
	let endOfOptions = false;

	for (let i = 0; i < splitArgs.length; i++) {
		const arg = splitArgs[i];

		if (arg === undefined) {
			continue;
		}

		if (endOfOptions) {
			throw new Error(`Unknown argument: ${arg}`);
		}

		if (arg === '--') {
			endOfOptions = true;
			continue;
		}

		if (!VALUE_FLAGS.has(arg)) {
			normalized.push(arg);
			continue;
		}

		const nextArg = splitArgs[i + 1];
		if (nextArg === '--') {
			const valueArg = splitArgs[i + 2];
			if (valueArg === undefined) {
				throw new Error(missingValueMessage(arg));
			}
			normalized.push(arg, valueArg);
			i += 2;
			endOfOptions = true;
			continue;
		}

		if (nextArg === undefined || KNOWN_FLAGS.has(nextArg)) {
			throw new Error(missingValueMessage(arg));
		}

		normalized.push(arg, nextArg);
		i++;
	}

	return normalized;
}

/**
 * Parse command line arguments.
 */
export function parseArgs(args: string[]): CliArgs {
	const normalized = prepareArgsForNodeParse(args);
	const parsed = parseNodeArgs({
		args: normalized,
		options: CLI_PARSE_OPTIONS,
		allowPositionals: true,
		strict: false,
		tokens: true,
	});

	for (const token of parsed.tokens) {
		if (token.kind === 'positional') {
			throw new Error(`Unknown argument: ${token.value}`);
		}

		if (token.kind !== 'option') {
			continue;
		}

		const originalArg = normalized[token.index];
		if (
			token.rawName.startsWith('-') &&
			!token.rawName.startsWith('--') &&
			originalArg !== token.rawName
		) {
			throw new Error(`Unknown argument: ${originalArg ?? token.rawName}`);
		}

		if (!KNOWN_OPTION_NAMES.has(token.name)) {
			throw new Error(`Unknown argument: ${token.rawName}`);
		}
	}

	const values = parsed.values;
	const result: CliArgs = {
		schemaPath: typeof values.schema === 'string' ? values.schema : '',
		help: values.help === true,
	};

	const allowedRoots = values['allowed-root'];
	if (Array.isArray(allowedRoots) && allowedRoots.length > 0) {
		result.allowedRoots = allowedRoots.filter(
			(root): root is string => typeof root === 'string',
		);
	}

	if (values.verbose === true) {
		result.verbose = true;
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

  -v, --verbose             Show full file paths in log output (default: basename only)

  -h, --help                Show this help message

EXAMPLES:
  # Basic usage
  dbsp-mcp --schema ./dbsp.schema.ts

  # With security restrictions
  dbsp-mcp --schema ./dbsp.schema.ts --allowed-root ./

  # Short form
  dbsp-mcp -s ./schema.js

SCHEMA FILE FORMAT:
  The schema file must export the result of schema():

    // dbsp.schema.ts
    import { schema as dbSchema } from '@dbsp/core';

    export const schema = dbSchema({
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
		// Log basename only before load (path is user input, not yet security-checked).
		// formatLogPath(p, verbose=false) always returns basename for pre-validation paths.
		console.error(
			`[dbsp-mcp] Loading schema from: ${basename(args.schemaPath)}`,
		);

		const loaderOptions = {
			schemaPath: args.schemaPath,
			...(args.allowedRoots && { allowedRoots: args.allowedRoots }),
		};
		const { schema, resolvedPath, canonicalRoots } =
			await loadSchema(loaderOptions);

		// Post-load log: respect --verbose for full path; default to basename only.
		console.error(
			`[dbsp-mcp] Schema loaded from: ${formatLogPath(resolvedPath, args.verbose ?? false)}`,
		);
		// Log the number of allowed roots that were validated against (re-emits the
		// diagnostic that validatePath's removed stderr write used to provide).
		console.error(
			`[dbsp-mcp] Schema validated against ${canonicalRoots.length} allowed root(s)`,
		);

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
// Use realpathSync on process.argv[1] to resolve pnpm shims and symlinks (M-B):
// without this, the shim path (/…/node_modules/.bin/dbsp-mcp) never matches
// import.meta.url which resolves to the real dist/index.js path.
if (process.argv[1] !== undefined) {
	try {
		const thisFile = fileURLToPath(import.meta.url);
		const entryFile = realpathSync(process.argv[1]);
		// tsx may pass the .ts source path; normalise both sides for comparison
		const thisBase = thisFile.replace(/\.[cm]?[jt]s$/, '');
		const entryBase = entryFile.replace(/\.[cm]?[jt]s$/, '');
		if (thisBase === entryBase) {
			main().catch((error) => {
				console.error('[dbsp-mcp] Fatal error:', error);
				process.exit(1);
			});
		}
	} catch {
		// process.argv[1] may not exist (unusual setups, test runners) — skip silently.
	}
}
