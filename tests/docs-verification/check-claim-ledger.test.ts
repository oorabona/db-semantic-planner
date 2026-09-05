import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { doctestSourceFiles } from './doc-sources.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const CHECKER = join(ROOT, 'tests/docs-verification/check-claim-ledger.ts');
// Mutation proof runs in a tracked-files projection; this points child checks
// at the already-installed tsx without copying node_modules into each fixture.
const TSX = process.env.DOCS_LEDGER_TSX ?? join(ROOT, 'node_modules/.bin/tsx');

function run(dir: string, ...args: string[]) {
	try {
		return {
			code: 0,
			output: execFileSync(TSX, [CHECKER, dir, ...args], {
				cwd: ROOT,
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
			}),
		};
	} catch (error) {
		const failure = error as {
			status?: number;
			stdout?: string;
			stderr?: string;
		};
		return {
			code: failure.status ?? 1,
			output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
		};
	}
}

/** Materialise all and only the source paths the real generator selects. */
function fixture(block = '') {
	const dir = mkdtempSync(join(tmpdir(), 'docs-ledger-'));
	for (const source of doctestSourceFiles(ROOT)) {
		const file = join(dir, source);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, source === 'packages/docs/patterns.md' ? block : '');
	}
	const baselineDir = join(dir, 'tests/docs-verification');
	mkdirSync(baselineDir, { recursive: true });
	const generated = run(dir, '--write-baseline', '--write-inventory');
	assert.equal(generated.code, 0, generated.output);
	return {
		dir,
		patterns: join(dir, 'packages/docs/patterns.md'),
		cleanup() {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		},
	};
}

const SKIP =
	'```typescript\n// doctest: skip — illustrative signature\nconst x = 1;\n```\n';

test('accepts a file exactly at its per-kind baseline', () => {
	const subject = fixture(SKIP);
	try {
		const result = run(subject.dir);
		assert.equal(
			result.code,
			0,
			`expected exact baseline to pass, got exit ${result.code}`,
		);
	} finally {
		subject.cleanup();
	}
});

test('refuses one more bypass than a file baseline permits', () => {
	const subject = fixture(SKIP);
	try {
		writeFileSync(
			subject.patterns,
			`${SKIP}${SKIP.replace('const x', 'const y')}`,
		);
		const result = run(subject.dir);
		assert.equal(
			result.code,
			1,
			`expected per-file baseline refusal, got exit ${result.code}`,
		);
		assert.match(
			result.output,
			/packages\/docs\/patterns\.md: explicit-skip baseline 1, actual 2/,
		);
	} finally {
		subject.cleanup();
	}
});

test('refuses a bypass marker with no reason even when its count matches', () => {
	const subject = fixture(SKIP);
	try {
		writeFileSync(
			subject.patterns,
			SKIP.replace(' — illustrative signature', ''),
		);
		const result = run(subject.dir);
		assert.equal(
			result.code,
			1,
			`expected missing-reason refusal, got exit ${result.code}`,
		);
		assert.match(
			result.output,
			/bypass marker has no reason after an em dash at packages\/docs\/patterns\.md:2/,
		);
	} finally {
		subject.cleanup();
	}
});
