/**
 * Tests for CLI entry-point bootstrap — help/version output and --json flag interaction.
 *
 * CC-15 design: Commander's --help and --version output is intentionally NOT
 * JSON-wrapped even when --json is also present. These are human-readable
 * informational outputs, not data responses. The --json flag only affects
 * error objects emitted on parse failures (exitCode !== 0).
 *
 * This test recreates the same program setup as index.ts using exported command
 * objects, then verifies the documented behaviour.
 */

import { Command, CommanderError } from 'commander';
import { describe, expect, it } from 'vitest';
import { generateCommand } from './generate.js';
import { introspectCommand } from './introspect.js';
import { migrateCommand } from './migrate.js';
import { pushCommand } from './push.js';
import { replCommand } from './repl.js';
import { verifyCommand } from './verify.js';

/**
 * Build a fresh program instance matching index.ts setup.
 * Uses exitOverride() so Commander throws instead of calling process.exit.
 */
function buildProgram(): Command {
	const p = new Command();
	p.name('dbsp')
		.description('Schema-first code generation for db-semantic-planner')
		.version('0.0.1')
		.exitOverride();

	for (const cmd of [
		generateCommand,
		introspectCommand,
		migrateCommand,
		pushCommand,
		replCommand,
		verifyCommand,
	]) {
		p.addCommand(cmd);
	}
	return p;
}

describe('CLI entry-point — help/version with --json flag (CC-15)', () => {
	it('--help throws CommanderError with exitCode 0 (informational, not JSON-wrapped)', () => {
		const p = buildProgram();

		let caughtErr: unknown;
		try {
			p.parse(['node', 'dbsp', '--help']);
		} catch (err) {
			caughtErr = err;
		}

		// Commander must throw CommanderError (commander.helpDisplayed) with exit 0
		expect(caughtErr).toBeInstanceOf(CommanderError);
		const ce = caughtErr as CommanderError;
		expect(ce.exitCode).toBe(0);
		expect(ce.code).toBe('commander.helpDisplayed');
	});

	it('--version throws CommanderError with exitCode 0 (informational, not JSON-wrapped)', () => {
		const p = buildProgram();

		let caughtErr: unknown;
		try {
			p.parse(['node', 'dbsp', '--version']);
		} catch (err) {
			caughtErr = err;
		}

		expect(caughtErr).toBeInstanceOf(CommanderError);
		const ce = caughtErr as CommanderError;
		expect(ce.exitCode).toBe(0);
		expect(ce.code).toBe('commander.version');
	});

	it('--help --json still exits 0 — --json does not wrap help output as JSON', () => {
		// Design intent: --help output is plain text regardless of --json.
		// In index.ts the catch block calls process.exit(0) for exitCode 0,
		// so the JSON error path is never reached for help/version.
		const p = buildProgram();

		let caughtErr: unknown;
		try {
			p.parse(['node', 'dbsp', '--help', '--json']);
		} catch (err) {
			caughtErr = err;
		}

		expect(caughtErr).toBeInstanceOf(CommanderError);
		const ce = caughtErr as CommanderError;
		expect(ce.exitCode).toBe(0);
		// Error code must be help-related, NOT a parse error (exitCode 1)
		expect(ce.code).toBe('commander.helpDisplayed');
	});

	it('--version --json still exits 0 — --json does not wrap version output as JSON', () => {
		const p = buildProgram();

		let caughtErr: unknown;
		try {
			p.parse(['node', 'dbsp', '--version', '--json']);
		} catch (err) {
			caughtErr = err;
		}

		expect(caughtErr).toBeInstanceOf(CommanderError);
		const ce = caughtErr as CommanderError;
		expect(ce.exitCode).toBe(0);
		expect(ce.code).toBe('commander.version');
	});

	it('unknown command throws CommanderError with exitCode 1 — JSON-wrappable error path', () => {
		// Contrast case: an unknown command IS a real error (exitCode 1).
		// In index.ts, this reaches the JSON-error branch when --json is present.
		const p = buildProgram();

		let caughtErr: unknown;
		try {
			p.parse(['node', 'dbsp', 'nonexistent-command']);
		} catch (err) {
			caughtErr = err;
		}

		expect(caughtErr).toBeInstanceOf(CommanderError);
		const ce = caughtErr as CommanderError;
		expect(ce.exitCode).toBe(1);
	});
});
