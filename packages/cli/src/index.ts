#!/usr/bin/env node
/**
 * ARCH-002 Block 3: CLI Scaffold
 *
 * dbsp CLI - Schema-first code generation for db-semantic-planner.
 */

import { Command } from 'commander';
import { generateCommand } from './commands/generate.js';
import { introspectCommand } from './commands/introspect.js';
import { migrateCommand } from './commands/migrate.js';
import { pushCommand } from './commands/push.js';
import { replCommand } from './commands/repl.js';
import { verifyCommand } from './commands/verify.js';

const program = new Command();

program
	.name('dbsp')
	.description('Schema-first code generation for db-semantic-planner')
	.version('0.0.1');

// Register commands
program.addCommand(generateCommand);
program.addCommand(introspectCommand);
program.addCommand(migrateCommand);
program.addCommand(pushCommand);
program.addCommand(replCommand);
program.addCommand(verifyCommand);

// CC-15: Intercept Commander parse errors so --json commands receive a JSON
// error object on stdout instead of a plain-text usage message.
program.exitOverride();

try {
	program.parse();
} catch (err) {
	const message = err instanceof Error ? err.message : 'Command parse error';
	if (process.argv.includes('--json')) {
		console.log(JSON.stringify({ status: 'error', error: message }, null, 2));
	} else {
		console.error(`❌ ${message}`);
	}
	process.exit(1);
}
