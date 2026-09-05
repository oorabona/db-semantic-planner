import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
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
const TSX = process.env.DOCS_LEDGER_TSX ?? join(ROOT, 'node_modules/.bin/tsx');
const PATTERNS = 'packages/docs/patterns.md';
const FENCE = String.fromCharCode(96).repeat(3);
const SKIP =
	FENCE +
	'typescript\n// doctest: skip — illustrative signature\nconst x = 1;\n' +
	FENCE +
	'\n';

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
			output: (failure.stdout ?? '') + (failure.stderr ?? ''),
		};
	}
}

function fixture(contents: Record<string, string> = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'docs-ledger-'));
	for (const source of doctestSourceFiles(ROOT)) {
		const file = join(dir, source);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, contents[source] ?? '');
	}
	mkdirSync(join(dir, 'tests/docs-verification'), { recursive: true });
	const generated = run(dir, '--write-baseline', '--write-inventory');
	assert.equal(generated.code, 0, generated.output);
	return {
		dir,
		file: (relative: string) => join(dir, relative),
		baseline: join(dir, 'tests/docs-verification/bypass-ledger-baseline.json'),
		inventory: join(dir, 'tests/docs-verification/claim-inventory.json'),
		cleanup() {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		},
	};
}

test('accepts a file exactly at its per-kind baseline', () => {
	const subject = fixture({ [PATTERNS]: SKIP });
	try {
		assert.equal(run(subject.dir).code, 0);
	} finally {
		subject.cleanup();
	}
});

test('refuses a decrease and allows its rebound only at the exact baseline', () => {
	const twice = SKIP + SKIP.replace('const x', 'const y');
	const subject = fixture({ [PATTERNS]: twice });
	try {
		writeFileSync(subject.file(PATTERNS), SKIP);
		const decrease = run(subject.dir);
		assert.equal(decrease.code, 1, decrease.output);
		assert.match(
			decrease.output,
			/packages\/docs\/patterns\.md: explicit-skip baseline 2, actual 1/,
		);
		writeFileSync(subject.file(PATTERNS), twice);
		assert.equal(run(subject.dir).code, 0);
	} finally {
		subject.cleanup();
	}
});

test('refuses default-ignorable-only reasons', () => {
	for (const invisible of ['​', '‌', '⁠']) {
		const subject = fixture({ [PATTERNS]: SKIP });
		try {
			writeFileSync(
				subject.file(PATTERNS),
				FENCE +
					'typescript\n// doctest: skip — ' +
					invisible +
					'\nconst x = 1;\n' +
					FENCE +
					'\n',
			);
			const result = run(subject.dir);
			assert.equal(result.code, 1, result.output);
			assert.match(
				result.output,
				/bypass marker has no reason after an em dash at packages\/docs\/patterns\.md:2/,
			);
		} finally {
			subject.cleanup();
		}
	}
});

test('refuses conflicting control markers instead of counting both', () => {
	const subject = fixture();
	try {
		writeFileSync(
			subject.file(PATTERNS),
			FENCE +
				'typescript\n// doctest: skip — not executable\n// doctest: real-db-only — connection required\nconst x = 1;\n' +
				FENCE +
				'\n',
		);
		const result = run(subject.dir);
		assert.equal(result.code, 1, result.output);
		assert.match(
			result.output,
			/conflicting control markers: packages\/docs\/patterns\.md:2 has conflicting control markers: explicit-skip, real-db-only/,
		);
	} finally {
		subject.cleanup();
	}
});

test('reports one baseline schema diagnostic and continues reporting', () => {
	const subject = fixture();
	try {
		writeFileSync(
			subject.baseline,
			'{"version":1,"files":{"README.md":null}}\n',
		);
		const result = run(subject.dir);
		assert.equal(result.code, 1, result.output);
		assert.match(
			result.output,
			/baseline schema is invalid: README\.md must be a plain object/,
		);
		assert.doesNotMatch(result.output, /TypeError/);
		assert.match(result.output, /docs ledger: README\.md: fences=0;/);
	} finally {
		subject.cleanup();
	}
});

test('does not rewrite either artifact when a write run fails', () => {
	const subject = fixture({ [PATTERNS]: SKIP });
	try {
		writeFileSync(
			subject.baseline,
			`${readFileSync(subject.baseline, 'utf8')}\n`,
		);
		writeFileSync(
			subject.inventory,
			`${readFileSync(subject.inventory, 'utf8')}\n`,
		);
		const baseline = readFileSync(subject.baseline);
		const inventory = readFileSync(subject.inventory);
		writeFileSync(
			subject.file(PATTERNS),
			SKIP.replace(' — illustrative signature', ''),
		);
		const result = run(subject.dir, '--write-baseline', '--write-inventory');
		assert.equal(result.code, 1, result.output);
		assert.deepEqual(readFileSync(subject.baseline), baseline);
		assert.deepEqual(readFileSync(subject.inventory), inventory);
	} finally {
		subject.cleanup();
	}
});

test('records TypeScript path line ranges apart from repository paths', () => {
	const file = 'packages/docs/guide/locking.md';
	const tick = String.fromCharCode(96);
	const subject = fixture({
		[file]:
			'All four are defined in ' +
			tick +
			'packages/core/src/dx/query-builder-types.ts:372-381' +
			tick +
			'.\n',
	});
	try {
		const parsed = JSON.parse(readFileSync(subject.inventory, 'utf8'));
		const entry = parsed.files.find(
			(item: { file: string }) => item.file === file,
		);
		assert.deepEqual(entry.claims['typescript-path'], [
			{
				path: 'packages/core/src/dx/query-builder-types.ts',
				lineRange: '372-381',
				line: 1,
			},
		]);
	} finally {
		subject.cleanup();
	}
});

test('normalizes argument-bearing dbsp calls while preserving raw spans', () => {
	const file = 'packages/docs/guide/migrating-from-prisma.md';
	const tick = String.fromCharCode(96);
	const subject = fixture({
		[file]:
			tick +
			".include('posts')" +
			tick +
			' and ' +
			tick +
			'orm.transaction(async () => {})' +
			tick +
			' and ' +
			tick +
			"orm.select('users').all()" +
			tick +
			'.\n',
	});
	try {
		const parsed = JSON.parse(readFileSync(subject.inventory, 'utf8'));
		const entry = parsed.files.find(
			(item: { file: string }) => item.file === file,
		);
		assert.deepEqual(entry.claims['method-mention'], [
			{ token: '.include()', raw: ".include('posts')", line: 1 },
			{ token: '.transaction()', raw: '.transaction(async () => {})', line: 1 },
			{ token: '.select()', raw: ".select('users')", line: 1 },
			{ token: '.all()', raw: '.all()', line: 1 },
		]);
	} finally {
		subject.cleanup();
	}
});

test('does not classify dry-run as a bypass', () => {
	const subject = fixture();
	try {
		writeFileSync(
			subject.file(PATTERNS),
			`${FENCE}typescript\n// doctest: dry-run\nconst x = 1;\n${FENCE}\n`,
		);
		const result = run(subject.dir);
		assert.equal(result.code, 0, result.output);
		assert.doesNotMatch(result.output, /dry-run=/);
	} finally {
		subject.cleanup();
	}
});
