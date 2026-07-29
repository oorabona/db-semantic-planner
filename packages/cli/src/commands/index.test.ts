/**
 * Tests for Commander CLI parse — help/version exit behaviour.
 *
 * These tests verify that Commander throws CommanderError with the correct
 * exit codes and error codes when --help, --version, or an unknown command is
 * parsed. They do NOT exercise the real CLI entry-point in index.ts (which
 * is a top-level script — no exported main() — with side effects that require
 * a spawn-based integration harness).
 *
 * What IS covered here:
 *   - Commander exits 0 for --help and --version (human-readable output, not errors)
 *   - Commander exits 1 for an unknown command (real error path)
 *   - These exit-code distinctions are what the real entry-point branches
 *     on to decide whether to JSON-wrap the error.
 *
 * What is NOT covered here:
 *   - The JSON-wrap decision logic in the real index.ts entry-point
 *   - Real process.exit() calls
 *
 * TODO: A full entry-point integration test (spawn the CLI binary with
 * process.argv and assert stdout/stderr shape + exit code) would require
 * a spawn-based harness — see TODO.md § "CLI integration test harness"
 * for follow-up.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateCommand } from './generate.js';
import { introspectCommand } from './introspect.js';
import { migrateCommand } from './migrate.js';
import { pushCommand } from './push.js';
import { replCommand } from './repl.js';
import { verifyCommand } from './verify.js';

/**
 * Build a fresh program instance matching index.ts setup.
 * Uses exitOverride() so Commander throws instead of calling process.exit.
 * Uses configureOutput() to suppress stdout/stderr during parse (avoids
 * noise in test output when --help or --version is triggered).
 */
function buildProgram(): Command {
	const p = new Command();
	p.name('dbsp')
		.description('Schema-first code generation for db-semantic-planner')
		.version('0.0.1')
		.exitOverride()
		.configureOutput({ writeOut: () => {}, writeErr: () => {} });

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

describe('Commander CLI parse — help/version exit behaviour (CC-15)', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});
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

	it('--help positioned before unknown flags still exits 0 (Commander evaluates --help eagerly)', () => {
		// Commander processes --help before unknown flags — the unknown --json
		// flag is never reached. This verifies Commander's eager --help evaluation,
		// NOT that main() ignores --json for help output (that requires a spawn harness).
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
		expect(ce.code).toBe('commander.helpDisplayed');
	});

	it('--version positioned before unknown flags still exits 0 (Commander evaluates --version eagerly)', () => {
		// Same eager-evaluation pattern as above, for --version.
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

	it('emits JSON for plan required-option failures with --format json [mutation: recognize only --json]', () => {
		const cliPath = fileURLToPath(new URL('../index.ts', import.meta.url));
		const repositoryRoot = fileURLToPath(
			new URL('../../../../', import.meta.url),
		);
		const completed = spawnSync(
			process.execPath,
			['--import', 'tsx', cliPath, 'plan', 'schema.ts', '--format', 'json'],
			{
				cwd: repositoryRoot,
				encoding: 'utf8',
				env: { ...process.env, NO_COLOR: '' },
			},
		);

		expect(completed.status).toBe(1);
		expect(JSON.parse(completed.stdout)).toMatchObject({
			status: 'error',
			error: expect.stringContaining("required option '-d, --db <url>'"),
		});
		expect(completed.stderr).toBe('');
	});

	it('emits one JSON document without root stderr for plan JSON selected after an unknown root option [mutation: let root Commander write stderr]', () => {
		const cliPath = fileURLToPath(new URL('../index.ts', import.meta.url));
		const repositoryRoot = fileURLToPath(
			new URL('../../../../', import.meta.url),
		);
		const completed = spawnSync(
			process.execPath,
			[
				'--import',
				'tsx',
				cliPath,
				'--bogus',
				'plan',
				'schema.ts',
				'--format',
				'json',
			],
			{
				cwd: repositoryRoot,
				encoding: 'utf8',
				env: { ...process.env, NO_COLOR: '' },
			},
		);

		expect(completed.status).toBe(1);
		expect(JSON.parse(completed.stdout)).toMatchObject({
			status: 'error',
			error: expect.stringContaining("unknown option '--bogus'"),
		});
		expect(completed.stderr).toBe('');
	});

	it('does not emit JSON for an unknown command that merely carries plan format arguments [mutation: scan every raw argument]', () => {
		const cliPath = fileURLToPath(new URL('../index.ts', import.meta.url));
		const repositoryRoot = fileURLToPath(
			new URL('../../../../', import.meta.url),
		);
		const completed = spawnSync(
			process.execPath,
			['--import', 'tsx', cliPath, 'plna', 'schema.ts', '--format', 'json'],
			{ cwd: repositoryRoot, encoding: 'utf8' },
		);

		expect(completed.status).toBe(1);
		expect(completed.stdout).toBe('');
		expect(completed.stderr).toContain("unknown command 'plna'");
	});
});
