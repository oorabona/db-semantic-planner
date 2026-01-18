#!/usr/bin/env node
/**
 * ARCH-002 Block 3: CLI Scaffold
 *
 * dbsp CLI - Schema-first code generation for db-semantic-planner.
 */

import { Command } from 'commander';
import { generateCommand } from './commands/generate.js';
import { introspectCommand } from './commands/introspect.js';
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
program.addCommand(replCommand);
program.addCommand(verifyCommand);

program.parse();
