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

/**
 * Parse command line arguments.
 */
export function parseArgs(args: string[]): CliArgs {
	const result: CliArgs = {
		schemaPath: '',
		help: false,
	};

	// Normalize --foo=bar form → ['--foo', 'bar'] before main loop.
	// Detect empty value (--schema=) immediately — the sliced value would be ''
	// which silently passes as schemaPath='' and triggers a misleading "required" error.
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

	// The set of flags that consume the next argument as a value.
	// Used to distinguish "missing value" from a legitimate hyphen-leading path (M-A).
	const VALUE_FLAGS = new Set(['--schema', '-s', '--allowed-root', '-r']);
	const KNOWN_FLAGS = new Set([
		...VALUE_FLAGS,
		'--help',
		'-h',
		'--verbose',
		'-v',
	]);

	// POSIX-style end-of-options marker. We do NOT support positional args (this CLI
	// has no positionals), so any token after a bare '--' is rejected as 'Unknown argument'.
	// The '--' marker only escapes a value that starts with '-' when consumed inline by
	// --schema/--allowed-root (e.g. '--schema -- -my.ts' assigns '-my.ts' to schemaPath).
	let endOfOptions = false;

	for (let i = 0; i < normalized.length; i++) {
		const arg = normalized[i];

		if (arg === undefined) {
			continue;
		}

		// POSIX end-of-options marker: after '--', treat remaining tokens as values.
		if (!endOfOptions && arg === '--') {
			endOfOptions = true;
			continue;
		}

		// After '--' with no pending value flag, all remaining tokens are unexpected positionals.
		if (endOfOptions) {
			throw new Error(`Unknown argument: ${arg}`);
		}

		if (arg === '--help' || arg === '-h') {
			result.help = true;
		} else if (arg === '--verbose' || arg === '-v') {
			result.verbose = true;
		} else if (arg === '--schema' || arg === '-s') {
			const nextArg = normalized[i + 1];
			// Check if next token is '--' (POSIX end-of-options) — consume it
			// and treat the token after it as the value.
			if (nextArg === '--') {
				// Consume '--' inline and take the token after it as the literal value.
				i++; // skip '--'
				const valueArg = normalized[i + 1];
				if (valueArg === undefined) {
					throw new Error('--schema requires a path argument');
				}
				result.schemaPath = valueArg;
				i++; // skip value
				endOfOptions = true;
			} else if (nextArg === undefined || KNOWN_FLAGS.has(nextArg)) {
				// Only reject if the next token is itself a known flag or missing.
				// A value like '-my-file.ts' is a legitimate relative path (M-A).
				throw new Error('--schema requires a path argument');
			} else {
				result.schemaPath = nextArg;
				i++; // Skip next arg
			}
		} else if (arg === '--allowed-root' || arg === '-r') {
			const nextArg = normalized[i + 1];
			if (nextArg === '--') {
				const valueArg = normalized[i + 2];
				if (valueArg === undefined) {
					throw new Error('--allowed-root requires a path argument');
				}
				result.allowedRoots = result.allowedRoots ?? [];
				result.allowedRoots.push(valueArg);
				i += 2; // skip '--' and value
				endOfOptions = true;
			} else if (nextArg === undefined || KNOWN_FLAGS.has(nextArg)) {
				throw new Error('--allowed-root requires a path argument');
			} else {
				result.allowedRoots = result.allowedRoots ?? [];
				result.allowedRoots.push(nextArg);
				i++; // Skip next arg
			}
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
