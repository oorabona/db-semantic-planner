#!/usr/bin/env node

/**
 * ARCH-002 Block 3: CLI Scaffold
 *
 * dbsp CLI - Schema-first code generation for db-semantic-planner.
 */

import { createRequire } from 'node:module';
import { Command, CommanderError } from 'commander';
import { applyCommand } from './commands/apply.js';
import { generateCommand } from './commands/generate.js';
import { inspectCommand } from './commands/inspect.js';
import { introspectCommand } from './commands/introspect.js';
import { planCommand } from './commands/plan.js';
import { preflightCommand } from './commands/preflight.js';
import { reconcileCommand } from './commands/reconcile.js';
import { recoverCommand } from './commands/recover.js';

import { releaseCommand } from './commands/release.js';
import { replCommand } from './commands/repl.js';
import { verifyCommand } from './commands/verify.js';
import { printCliJson } from './utils/output.js';

const program = new Command();
const packageJson = createRequire(import.meta.url)('../package.json') as {
	readonly version: string;
};

const jsonFormatCommands = new Set([
	'apply',
	'inspect',
	'plan',
	'recover',
	'reconcile',
	'release',
]);

function requestsJson(argv: readonly string[]): boolean {
	// The initial positional token is the command Commander will try to run.
	// Do not let a typo such as `plna --format json` opt into a JSON envelope.
	let command: string | undefined;
	for (const argument of argv) {
		if (argument === '--') break;
		if (!argument.startsWith('-')) {
			command = argument;
			break;
		}
	}
	if (command === undefined || !jsonFormatCommands.has(command)) return false;

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === '--') break;
		if (
			(argument === '--format' && argv[index + 1] === 'json') ||
			argument === '--format=json' ||
			argument === '--json'
		) {
			return true;
		}
	}
	return false;
}

program
	.name('dbsp')
	.description('Schema-first code generation for db-semantic-planner')
	.version(packageJson.version);

// Register commands
program.addCommand(generateCommand);
program.addCommand(introspectCommand);
program.addCommand(planCommand);
program.addCommand(preflightCommand);
program.addCommand(applyCommand);
program.addCommand(inspectCommand);
program.addCommand(recoverCommand);
program.addCommand(releaseCommand);
program.addCommand(reconcileCommand);
program.addCommand(replCommand);
program.addCommand(verifyCommand);

const jsonRequested = requestsJson(process.argv.slice(2));

// Commander validates options before transferring control to a subcommand.
// Suppress its eager plaintext diagnostic whenever the request chose JSON.
if (jsonRequested) {
	for (const command of [program, ...program.commands])
		command.configureOutput({ writeErr: () => {} });
}

// CC-15: Intercept parse errors so recognized JSON-capable commands receive a
// JSON error object on stdout instead of a plain-text usage message.
for (const command of [program, ...program.commands]) command.exitOverride();

try {
	program.parse();
} catch (err) {
	// Commander throws CommanderError for --help, --version, and parse errors.
	// Exit 0 for informational outputs (help/version); only exit 1 for real errors.
	if (err instanceof CommanderError && err.exitCode === 0) {
		process.exit(0);
	}
	const message = err instanceof Error ? err.message : 'Command parse error';
	if (jsonRequested) {
		printCliJson({ status: 'error', error: message });
	} else {
		console.error(`❌ ${message}`);
	}
	process.exit(1);
}
