import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'scripts/probe-dump.mjs');
const fixture = join(root, 'scripts/fixtures/probe-cases.mjs');

function run(args) {
	return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

test('prints exact built SQL and parameters, preserving order across build and dump errors', () => {
	const result = run([root, fixture]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stderr, '');
	assert.equal(
		result.stdout,
		[
			'{"case":"select","sql":"SELECT users.* FROM users WHERE users.id = $1","params":[7]}',
			'{"case":"throwing","error":"intentional build failure"}',
			'{"case":"insert","sql":"INSERT INTO users (id, name) VALUES ($1, $2)","params":[8,"Ada"]}',
			'{"case":"dumpThrowing","error":"intentional dump failure"}',
			'',
		].join('\n'),
	);
});

test('names missing arguments and exits 2', () => {
	for (const [args, missing] of [[[], '<checkout-dir>'], [[root], '<cases-module>']]) {
		const result = run(args);
		assert.equal(result.status, 2, result.stderr);
		assert.ok(result.stderr.includes(missing), result.stderr);
		assert.equal(result.stdout, '');
	}
});

test('names missing schema or cases exports and exits 2', () => {
	const dir = mkdtempSync(join(tmpdir(), 'probe-cases-'));
	try {
		const module = join(dir, 'cases.mjs');
		for (const [source, missing] of [['export const schema = {};', 'cases'], ['export const cases = {};', 'schema']]) {
			writeFileSync(module, source);
			const result = run([root, module]);
			assert.equal(result.status, 2, result.stderr);
			assert.match(result.stderr, new RegExp(`missing or invalid ${missing} export`));
			assert.equal(result.stdout, '');
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('names the missing dist entry and exits 2', () => {
	const dir = mkdtempSync(join(tmpdir(), 'probe-dist-'));
	try {
		const result = run([dir, fixture]);
		assert.equal(result.status, 2, result.stderr);
		assert.ok(result.stderr.includes(join(dir, 'packages/core/dist/index.js')), result.stderr);
		assert.equal(result.stdout, '');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
