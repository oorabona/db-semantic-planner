import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'npm-published-state.sh');

/**
 * Runs the script against a stub `npm` on PATH. The stub is the whole point:
 * the decision under test is how a registry answer is classified, so the answer
 * has to be dictated rather than fetched.
 */
function run(stub) {
	const dir = mkdtempSync(join(tmpdir(), 'npm-published-state-'));
	try {
		const fake = join(dir, 'npm');
		writeFileSync(fake, `#!/usr/bin/env bash\n${stub}\n`);
		chmodSync(fake, 0o755);
		try {
			const stdout = execFileSync('bash', [SCRIPT, '@dbsp/core@3.2.0'], {
				encoding: 'utf8',
				env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			return { code: 0, stdout };
		} catch (error) {
			return { code: error.status ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test('reports a version the registry knows as published', () => {
	const { code, stdout } = run('echo 3.2.0; exit 0');
	assert.equal(code, 0);
	assert.equal(stdout.trim(), 'published');
});

test('reports an explicit E404 as unpublished', () => {
	const { code, stdout } = run(`echo 'npm error code E404' >&2; exit 1`);
	assert.equal(code, 0);
	assert.equal(stdout.trim(), 'unpublished');
});

test('refuses to answer when the registry fails for any other reason', () => {
	for (const stub of [
		`echo 'npm error code E500' >&2; exit 1`,
		`echo 'npm error code ENEEDAUTH' >&2; exit 1`,
		`echo 'npm error network request to https://registry.npmjs.org failed' >&2; exit 1`,
		`echo 'npm error code E429' >&2; exit 1`,
	]) {
		const { code, stdout, stderr } = run(stub);
		assert.notEqual(code, 0, `expected a refusal for stub: ${stub}`);
		assert.equal(stdout.trim(), '', 'an undetermined answer must print no state');
		assert.match(stderr, /refusing to guess/);
	}
});

test('does not read a version string that merely contains E404 as not found', () => {
	const { code, stdout } = run('echo 1.0.0-E404beta; exit 0');
	assert.equal(code, 0);
	assert.equal(stdout.trim(), 'published');
});

test('refuses an error mentioning E404 only inside a longer token', () => {
	const { code, stdout, stderr } = run(`echo 'npm error code XE404Y' >&2; exit 1`);
	assert.notEqual(code, 0);
	assert.equal(stdout.trim(), '');
	assert.match(stderr, /refusing to guess/);
});

test('refuses a call that does not name exactly one package version', () => {
	for (const args of [[], ['a', 'b']]) {
		let code = 0;
		try {
			execFileSync('bash', [SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
		} catch (error) {
			code = error.status ?? 1;
		}
		assert.notEqual(code, 0, `expected a refusal for ${args.length} argument(s)`);
	}
});
