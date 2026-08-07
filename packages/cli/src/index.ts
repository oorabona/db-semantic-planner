#!/usr/bin/env node
/**
 * ARCH-002 Block 3: CLI Scaffold
 *
 * dbsp CLI - Schema-first code generation for db-semantic-planner.
 */

import { Command, CommanderError } from 'commander';
import { applyCommand } from './commands/apply.js';
import { generateCommand } from './commands/generate.js';
import { inspectCommand } from './commands/inspect.js';
import { introspectCommand } from './commands/introspect.js';
import { migrateCommand } from './commands/migrate.js';
import { planCommand } from './commands/plan.js';
import { preflightCommand } from './commands/preflight.js';
import { pushCommand } from './commands/push.js';
import { reconcileCommand } from './commands/reconcile.js';
import { recoverCommand } from './commands/recover.js';
import { replCommand } from './commands/repl.js';
import { verifyCommand } from './commands/verify.js';

const program = new Command();

function selectedCommand(
	argv: readonly string[],
	commands: readonly Command[],
): { readonly command: Command; readonly index: number } | undefined {
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === '--') return undefined;
		if (argument?.startsWith('-')) continue;
		const command = commands.find((candidate) => candidate.name() === argument);
		return command === undefined ? undefined : { command, index };
	}
	return undefined;
}

function requestsPlanJson(
	argv: readonly string[],
	commands: readonly Command[],
): boolean {
	const selected = selectedCommand(argv, commands);
	if (selected?.command !== planCommand) return false;

	for (let index = selected.index + 1; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === '--') break;
		if (
			(argument === '--format' && argv[index + 1] === 'json') ||
			argument === '--format=json'
		) {
			return true;
		}
	}
	return false;
}

program
	.name('dbsp')
	.description('Schema-first code generation for db-semantic-planner')
	.version('0.0.1');

// Register commands
program.addCommand(generateCommand);
program.addCommand(introspectCommand);
program.addCommand(migrateCommand);
program.addCommand(planCommand);
program.addCommand(preflightCommand);
program.addCommand(applyCommand);
program.addCommand(inspectCommand);
program.addCommand(recoverCommand);
program.addCommand(reconcileCommand);
program.addCommand(pushCommand);
program.addCommand(replCommand);
program.addCommand(verifyCommand);

const planJsonRequested = requestsPlanJson(
	process.argv.slice(2),
	program.commands,
);

// Commander validates root options before transferring control to a subcommand.
// For a resolved `plan --format json` invocation, avoid emitting its eager
// plaintext diagnostic alongside the JSON error document produced below.
if (planJsonRequested) {
	program.configureOutput({ writeErr: () => {} });
}

// CC-15: Intercept Commander parse errors so --json commands receive a JSON
// error object on stdout instead of a plain-text usage message.
program.exitOverride();

try {
	program.parse();
} catch (err) {
	// Commander throws CommanderError for --help, --version, and parse errors.
	// Exit 0 for informational outputs (help/version); only exit 1 for real errors.
	if (err instanceof CommanderError && err.exitCode === 0) {
		process.exit(0);
	}
	const message = err instanceof Error ? err.message : 'Command parse error';
	if (process.argv.includes('--json') || planJsonRequested) {
		console.log(JSON.stringify({ status: 'error', error: message }, null, 2));
	} else {
		console.error(`❌ ${message}`);
	}
	process.exit(1);
}
