import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs, {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { doctestSourceFiles } from './doc-sources.js';
import { generatedSuiteDirectory } from './generated-suite-path.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const CHECKER = join(ROOT, 'tests/docs-verification/check-claim-ledger.ts');
const GENERATOR = join(ROOT, 'tests/docs-verification/generate-tests.ts');
const TSX = process.env.DOCS_LEDGER_TSX ?? join(ROOT, 'node_modules/.bin/tsx');
const PATTERNS = 'packages/docs/patterns.md';
const COMPILE_ONLY_GENERATED = generatedSuiteDirectory('compile-only');
const REAL_DB_GENERATED = generatedSuiteDirectory('real-db');
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

function runGenerator(dir: string, realDb = false) {
	const env = { ...process.env };
	if (realDb) env.DBSP_DOCTEST_REAL_DB = '1';
	else delete env.DBSP_DOCTEST_REAL_DB;
	try {
		return {
			code: 0,
			output: execFileSync(TSX, [GENERATOR, dir], {
				cwd: ROOT,
				env,
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

function createDirectoryLink(
	target: string,
	path: string,
	type: 'dir' | 'junction',
	createLink: typeof symlinkSync = symlinkSync,
): boolean {
	try {
		createLink(target, path, type);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'EPERM' || code === 'EACCES') return false;
		throw error;
	}
}

function fixture(
	contents: Record<string, string> = {},
	afterCreate?: (dir: string) => void,
) {
	const dir = mkdtempSync(join(tmpdir(), 'docs-ledger-'));
	const cleanup = () => {
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	};
	try {
		afterCreate?.(dir);
		for (const source of doctestSourceFiles(ROOT)) {
			const file = join(dir, source);
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, contents[source] ?? '');
		}
		mkdirSync(join(dir, 'tests/docs-verification'), { recursive: true });
		const generated = run(dir, '--write-baseline');
		assert.equal(generated.code, 0, generated.output);
	} catch (error) {
		cleanup();
		throw error;
	}
	return {
		dir,
		file: (relative: string) => join(dir, relative),
		baseline: join(dir, 'tests/docs-verification/bypass-ledger-baseline.json'),
		cleanup,
	};
}

test('cleans up a temporary fixture when setup fails', () => {
	let dir = '';
	assert.throws(
		() =>
			fixture({}, (created) => {
				dir = created;
				throw new Error('simulated fixture setup failure');
			}),
		/simulated fixture setup failure/,
	);
	assert.equal(existsSync(dir), false);
});

test('treats unavailable directory linking as a filesystem-capability fallback', () => {
	const denied = () => {
		const error = new Error(
			'directory links unavailable',
		) as NodeJS.ErrnoException;
		error.code = 'EPERM';
		throw error;
	};
	let capabilityAvailable: boolean | undefined;
	assert.doesNotThrow(() => {
		capabilityAvailable = createDirectoryLink(
			'outside',
			'mode-directory',
			'dir',
			denied,
		);
	}, 'EPERM is a filesystem-capability fallback');
	assert.equal(capabilityAvailable, false);
	assert.throws(
		() =>
			createDirectoryLink('outside', 'mode-directory', 'dir', () => {
				const error = new Error(
					'unexpected link failure',
				) as NodeJS.ErrnoException;
				error.code = 'EIO';
				throw error;
			}),
		(error: NodeJS.ErrnoException) => error.code === 'EIO',
	);
});

test('emits a failing generated case when a source cannot be read', () => {
	const subject = fixture();
	try {
		rmSync(subject.file(PATTERNS));
		const generated = runGenerator(subject.dir);
		assert.equal(generated.code, 0, generated.output);
		const suite = readFileSync(
			join(subject.dir, COMPILE_ONLY_GENERATED, 'site-index.test.ts'),
			'utf8',
		);
		assert.match(
			suite,
			/packages\/docs\/patterns\.md — cannot read documentation source: ENOENT:/,
		);
		assert.match(suite, /throw new Error\(/);
		assert.doesNotMatch(suite, /it\.skip\(/);
	} finally {
		subject.cleanup();
	}
});

test('removes a stale generated suite when its bucket loses its last block', () => {
	const subject = fixture();
	const stale = join(subject.dir, COMPILE_ONLY_GENERATED, 'site-index.test.ts');
	try {
		mkdirSync(dirname(stale), { recursive: true });
		writeFileSync(stale, '// stale generated suite\n');
		const generated = runGenerator(subject.dir);
		assert.equal(generated.code, 0, generated.output);
		assert.equal(existsSync(stale), false);
	} finally {
		subject.cleanup();
	}
});

test('unlinks a stale generated-suite symlink without removing its target', () => {
	const subject = fixture();
	const generatedDirectory = join(subject.dir, COMPILE_ONLY_GENERATED);
	const stale = join(generatedDirectory, 'retired.test.ts');
	const target = join(subject.dir, 'retired-suite-target.test.ts');
	try {
		mkdirSync(generatedDirectory, { recursive: true });
		writeFileSync(target, '// retained symlink target\n');
		symlinkSync(target, stale);
		const generated = runGenerator(subject.dir);
		assert.equal(generated.code, 0, generated.output);
		assert.equal(existsSync(stale), false);
		assert.equal(existsSync(target), true);
		assert.match(
			generated.output,
			/Removed stale generated suite: .*retired\.test\.ts/,
		);
	} finally {
		subject.cleanup();
	}
});

test('refuses a generated mode directory symlink before writing outside it', (t) => {
	const subject = fixture({
		[PATTERNS]: `${FENCE}typescript\nconst generatedOutside = true;\n${FENCE}\n`,
	});
	const generatedDirectory = join(subject.dir, COMPILE_ONLY_GENERATED);
	const outside = mkdtempSync(join(tmpdir(), 'docs-generated-outside-'));
	const retired = join(outside, 'retired.test.ts');
	try {
		mkdirSync(dirname(generatedDirectory), { recursive: true });
		writeFileSync(retired, '// must survive a refused generation\n');
		writeFileSync(join(outside, 'witness.txt'), 'must remain untouched\n');
		if (
			!createDirectoryLink(
				outside,
				generatedDirectory,
				process.platform === 'win32' ? 'junction' : 'dir',
			)
		) {
			t.skip('filesystem does not permit directory links or junctions');
			return;
		}

		const generated = runGenerator(subject.dir);
		assert.equal(existsSync(retired), true);
		assert.deepEqual(readdirSync(outside).sort(), [
			'retired.test.ts',
			'witness.txt',
		]);
		assert.equal(generated.code, 1, generated.output);
		assert.match(
			generated.output,
			/Generated directory component must not be a symbolic link:/,
		);
	} finally {
		rmSync(outside, { recursive: true, force: true });
		subject.cleanup();
	}
});

test('refuses a subdirectory in the flat generated-suite directory', () => {
	const subject = fixture();
	const generatedDirectory = join(subject.dir, COMPILE_ONLY_GENERATED);
	const stale = join(generatedDirectory, 'retired.test.ts');
	try {
		mkdirSync(generatedDirectory, { recursive: true });
		writeFileSync(stale, '// must survive failed flatness validation\n');
		mkdirSync(join(generatedDirectory, 'retired'), { recursive: true });
		const generated = runGenerator(subject.dir);
		assert.equal(existsSync(stale), true);
		assert.equal(generated.code, 1, generated.output);
		assert.match(
			generated.output,
			new RegExp(
				`Generated suite directory must be flat; found subdirectory: ${join(generatedDirectory, 'retired').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
			),
		);
	} finally {
		subject.cleanup();
	}
});

test('accepts a readable source file with no fences', () => {
	const subject = fixture({ [PATTERNS]: 'Narrative only.\n' });
	try {
		const generated = runGenerator(subject.dir);
		assert.equal(generated.code, 0, generated.output);
		assert.equal(
			existsSync(
				join(subject.dir, COMPILE_ONLY_GENERATED, 'site-index.test.ts'),
			),
			false,
		);
	} finally {
		subject.cleanup();
	}
});

test('reconciles a suite for a bucket no longer in the source map', () => {
	const subject = fixture();
	const stale = join(
		subject.dir,
		COMPILE_ONLY_GENERATED,
		'retired-bucket.test.ts',
	);
	try {
		mkdirSync(dirname(stale), { recursive: true });
		writeFileSync(stale, '// stale generated suite\n');
		const generated = runGenerator(subject.dir);
		assert.equal(generated.code, 0, generated.output);
		assert.equal(existsSync(stale), false);
	} finally {
		subject.cleanup();
	}
});

test('keeps generated suites separate for compile-only and real-db modes', () => {
	const subject = fixture({
		[PATTERNS]: `${FENCE}typescript\n// doctest: real-db-only — connection required\nconst x = 1;\n${FENCE}\n`,
	});
	const compileOnly = join(
		subject.dir,
		COMPILE_ONLY_GENERATED,
		'site-index.test.ts',
	);
	const realDb = join(subject.dir, REAL_DB_GENERATED, 'site-index.test.ts');
	const staleCompileOnly = join(
		subject.dir,
		COMPILE_ONLY_GENERATED,
		'retired-bucket.test.ts',
	);
	const staleRealDb = join(
		subject.dir,
		REAL_DB_GENERATED,
		'retired-bucket.test.ts',
	);
	try {
		mkdirSync(dirname(staleCompileOnly), { recursive: true });
		mkdirSync(dirname(staleRealDb), { recursive: true });
		writeFileSync(staleCompileOnly, '// stale compile-only suite\n');
		writeFileSync(staleRealDb, '// stale real-db suite\n');
		assert.equal(runGenerator(subject.dir).code, 0);
		assert.equal(existsSync(staleCompileOnly), false);
		assert.equal(existsSync(staleRealDb), true);
		assert.equal(runGenerator(subject.dir, true).code, 0);
		assert.equal(existsSync(staleRealDb), false);
		assert.equal(existsSync(compileOnly), true);
		assert.equal(existsSync(realDb), true);
		assert.match(readFileSync(compileOnly, 'utf8'), /it\.skip\(/);
		assert.match(readFileSync(realDb, 'utf8'), /await runBlock\(/);
		assert.match(
			readFileSync(realDb, 'utf8'),
			/Regenerate with: Set DBSP_DOCTEST_REAL_DB=1, then run pnpm test:docs:generate/,
		);
	} finally {
		subject.cleanup();
	}
});

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

test('recognizes bare-CR control markers as the extractor does', () => {
	const subject = fixture({
		[PATTERNS]: `${FENCE}typescript\n// doctest: skip — bare-CR marker\rconst x = 1;\n${FENCE}\n`,
	});
	try {
		const result = run(subject.dir);
		assert.equal(result.code, 0, result.output);
		assert.match(
			result.output,
			/packages\/docs\/patterns\.md: fences=1; explicit-skip=1, deferred real-db-only=0, heuristic-fragment=0/,
		);
		writeFileSync(
			subject.file(PATTERNS),
			`${FENCE}typescript\n// doctest: skip\rconst x = 1;\n${FENCE}\n`,
		);
		const missingReason = run(subject.dir);
		assert.equal(missingReason.code, 1, missingReason.output);
		assert.match(
			missingReason.output,
			/bypass marker has no reason after an em dash at packages\/docs\/patterns\.md:2 \(explicit-skip\)/,
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

test('reports an atomic-write cleanup failure with the temporary path', async () => {
	const subject = fixture({ [PATTERNS]: SKIP });
	const originalArgv = process.argv;
	const originalError = console.error;
	const originalLog = console.log;
	const originalExit = process.exit;
	const originalWriteFileSync = fs.writeFileSync;
	const originalRmSync = fs.rmSync;
	let temporary = '';
	let output = '';
	try {
		fs.writeFileSync = ((...arguments_: Parameters<typeof writeFileSync>) => {
			originalWriteFileSync(...arguments_);
			if (typeof arguments_[0] === 'string' && arguments_[0].endsWith('.tmp')) {
				temporary = arguments_[0];
				throw new Error('simulated write failure');
			}
		}) as typeof writeFileSync;
		fs.rmSync = ((...arguments_: Parameters<typeof rmSync>) => {
			if (arguments_[0] === temporary)
				throw new Error('simulated cleanup failure');
			return originalRmSync(...arguments_);
		}) as typeof rmSync;
		syncBuiltinESMExports();
		process.argv = [process.execPath, CHECKER, subject.dir, '--write-baseline'];
		console.error = ((...messages: unknown[]) => {
			output += `${messages.join(' ')}\n`;
		}) as typeof console.error;
		console.log = (() => {}) as typeof console.log;
		process.exit = ((code?: number | string | null) => {
			throw new Error(`checker exited ${code}`);
		}) as typeof process.exit;
		await assert.rejects(
			import(`${pathToFileURL(CHECKER).href}?cleanup-failure=${Date.now()}`),
			/checker exited 1/,
		);
		assert.notEqual(temporary, '');
		assert.equal(existsSync(temporary), true);
		assert.match(
			output,
			new RegExp(
				`cannot write temporary file for ${subject.baseline.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: simulated write failure; temporary file left behind at ${temporary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: simulated cleanup failure`,
			),
		);
	} finally {
		process.argv = originalArgv;
		console.error = originalError;
		console.log = originalLog;
		process.exit = originalExit;
		fs.writeFileSync = originalWriteFileSync;
		fs.rmSync = originalRmSync;
		syncBuiltinESMExports();
		if (temporary !== '' && existsSync(temporary)) originalRmSync(temporary);
		subject.cleanup();
	}
});
