import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
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
	const generated = run(dir, '--write-baseline');
	assert.equal(generated.code, 0, generated.output);
	return {
		dir,
		file: (relative: string) => join(dir, relative),
		baseline: join(dir, 'tests/docs-verification/bypass-ledger-baseline.json'),
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

test('refuses an increase above a per-file, per-kind baseline', () => {
	const subject = fixture({ [PATTERNS]: SKIP });
	try {
		writeFileSync(
			subject.file(PATTERNS),
			SKIP + SKIP.replace('const x', 'const y'),
		);
		const increase = run(subject.dir);
		assert.match(
			increase.output,
			/packages\/docs\/patterns\.md: explicit-skip baseline 1, actual 2/,
		);
		assert.equal(increase.code, 1, increase.output);
	} finally {
		subject.cleanup();
	}
});

test('refuses a redistribution across files even when the global total is unchanged', () => {
	const comparison = 'packages/docs/comparison.md';
	const subject = fixture({ [PATTERNS]: SKIP, [comparison]: SKIP });
	try {
		writeFileSync(
			subject.file(PATTERNS),
			SKIP + SKIP.replace('const x', 'const y'),
		);
		writeFileSync(subject.file(comparison), '');
		const redistribution = run(subject.dir);
		assert.match(
			redistribution.output,
			/packages\/docs\/patterns\.md: explicit-skip baseline 1, actual 2/,
		);
		assert.match(
			redistribution.output,
			/packages\/docs\/comparison\.md: explicit-skip baseline 1, actual 0/,
		);
		assert.equal(redistribution.code, 1, redistribution.output);
	} finally {
		subject.cleanup();
	}
});

test('refuses kind substitution within a file even when its total is unchanged', () => {
	const subject = fixture({ [PATTERNS]: SKIP });
	try {
		writeFileSync(
			subject.file(PATTERNS),
			SKIP.replace('doctest: skip', 'doctest: real-db-only'),
		);
		const substitution = run(subject.dir);
		assert.match(
			substitution.output,
			/packages\/docs\/patterns\.md: explicit-skip baseline 1, actual 0/,
		);
		assert.match(
			substitution.output,
			/packages\/docs\/patterns\.md: real-db-only baseline 0, actual 1/,
		);
		assert.equal(substitution.code, 1, substitution.output);
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

test('does not rewrite the baseline when a write run fails', () => {
	const subject = fixture({ [PATTERNS]: SKIP });
	try {
		writeFileSync(
			subject.baseline,
			`${readFileSync(subject.baseline, 'utf8')}\n`,
		);
		const baseline = readFileSync(subject.baseline);
		writeFileSync(
			subject.file(PATTERNS),
			SKIP.replace(' — illustrative signature', ''),
		);
		const result = run(subject.dir, '--write-baseline');
		assert.equal(result.code, 1, result.output);
		assert.deepEqual(readFileSync(subject.baseline), baseline);
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

test('recognizes CRLF control markers as the extractor does', () => {
	const subject = fixture({
		[PATTERNS]: `${FENCE}typescript\r\n// doctest: skip — CRLF marker\r\nconst x = 1;\r\n${FENCE}\r\n`,
	});
	try {
		const result = run(subject.dir);
		assert.equal(result.code, 0, result.output);
		assert.match(
			result.output,
			/packages\/docs\/patterns\.md: fences=1; explicit-skip=1, deferred real-db-only=0, heuristic-fragment=0/,
		);
	} finally {
		subject.cleanup();
	}
});

test('requires a reason for a CRLF control marker', () => {
	const subject = fixture();
	try {
		writeFileSync(
			subject.file(PATTERNS),
			`${FENCE}typescript\r\n// doctest: skip\r\nconst x = 1;\r\n${FENCE}\r\n`,
		);
		const result = run(subject.dir);
		assert.equal(result.code, 1, result.output);
		assert.match(
			result.output,
			/bypass marker has no reason after an em dash at packages\/docs\/patterns\.md:2 \(explicit-skip\)/,
		);
	} finally {
		subject.cleanup();
	}
});

test('classifies marked real-db fragments as fragments, not deferred blocks', () => {
	const subject = fixture({
		[PATTERNS]: `${FENCE}typescript\n.method()\n// doctest: real-db-only — fragment remains a fragment in real-db mode\n${FENCE}\n`,
	});
	try {
		const result = run(subject.dir);
		assert.equal(result.code, 0, result.output);
		assert.match(
			result.output,
			/packages\/docs\/patterns\.md: fences=1; explicit-skip=0, deferred real-db-only=0, heuristic-fragment=1/,
		);
	} finally {
		subject.cleanup();
	}
});

test('reports an atomic-write failure without leaving a temporary file', () => {
	const subject = fixture({ [PATTERNS]: SKIP });
	try {
		rmSync(subject.baseline);
		mkdirSync(subject.baseline);
		const result = run(subject.dir, '--write-baseline');
		assert.equal(result.code, 1, result.output);
		assert.match(
			result.output,
			new RegExp(
				`docs ledger: cannot rename temporary file for ${subject.baseline.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`,
			),
		);
		assert.doesNotMatch(result.output, /Error:/);
		assert.equal(
			readdirSync(dirname(subject.baseline)).filter((file) =>
				file.startsWith(`.${basename(subject.baseline)}.`),
			).length,
			0,
		);
	} finally {
		subject.cleanup();
	}
});
