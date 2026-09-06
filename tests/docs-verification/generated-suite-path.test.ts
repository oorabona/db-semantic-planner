import assert from 'node:assert/strict';
import fs, {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	symlinkSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, win32 } from 'node:path';
import { test } from 'node:test';
import {
	ensureOwnedGeneratedDirectory,
	generatedSuiteDirectory,
	generatedSuitesRootDirectory,
	relativeModuleSpecifier,
} from './generated-suite-path.js';

function directoryFixture() {
	const root = mkdtempSync(join(tmpdir(), 'generated-suite-path-'));
	const owned = join(root, 'owned');
	mkdirSync(owned);
	return {
		owned,
		path: (relative: string) => join(root, relative),
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

test('refuses a lexical escape before creating a directory outside the owned root', () => {
	const subject = directoryFixture();
	const escaped = subject.path('created-by-helper');
	try {
		assert.throws(
			() =>
				ensureOwnedGeneratedDirectory(subject.owned, '../created-by-helper'),
			/Generated directory resolves outside the owned workspace root:/,
		);
		assert.equal(existsSync(escaped), false);
	} finally {
		subject.cleanup();
	}
});

test('refuses an absolute generated directory before creating it', () => {
	const subject = directoryFixture();
	const absolute = resolve(subject.owned, 'absolute-generated-directory');
	try {
		assert.throws(
			() => ensureOwnedGeneratedDirectory(subject.owned, absolute),
			/Generated directory resolves outside the owned workspace root:/,
		);
		assert.equal(existsSync(absolute), false);
	} finally {
		subject.cleanup();
	}
});

test('refuses a generated directory replaced by a symlink after creation', (t) => {
	const subject = directoryFixture();
	const outside = mkdtempSync(join(tmpdir(), 'generated-suite-outside-'));
	const linkedMode = join(subject.owned, 'mode');
	const originalLstatSync = fs.lstatSync;
	let replacementAttempted = false;
	try {
		try {
			fs.lstatSync = ((...arguments_: Parameters<typeof fs.lstatSync>) => {
				const stat = originalLstatSync(...arguments_);
				if (arguments_[0] === linkedMode && !replacementAttempted) {
					replacementAttempted = true;
					rmSync(linkedMode, { recursive: true });
					symlinkSync(
						outside,
						linkedMode,
						process.platform === 'win32' ? 'junction' : 'dir',
					);
				}
				return stat;
			}) as typeof fs.lstatSync;
			syncBuiltinESMExports();
			assert.throws(
				() => ensureOwnedGeneratedDirectory(subject.owned, 'mode'),
				/Generated directory resolves outside the owned workspace root:/,
			);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === 'EPERM' || code === 'EACCES') {
				t.skip('filesystem does not permit directory links or junctions');
				return;
			}
			throw error;
		}

		assert.equal(replacementAttempted, true);
		assert.deepEqual(readdirSync(outside), []);
	} finally {
		fs.lstatSync = originalLstatSync;
		syncBuiltinESMExports();
		rmSync(outside, { recursive: true, force: true });
		subject.cleanup();
	}
});

test('calculates ESM runner specifiers from generated suite directories', () => {
	assert.equal(
		generatedSuiteDirectory('compile-only'),
		'tests/docs-verification/__generated__/compile-only',
	);
	assert.equal(
		generatedSuitesRootDirectory(),
		'tests/docs-verification/__generated__',
	);
	const root = '/workspace/db-semantic-planner';
	const runner = join(root, 'tests/docs-verification/runner.js');
	const compileOnly = join(
		root,
		'tests/docs-verification/__generated__/compile-only',
	);

	assert.equal(relativeModuleSpecifier(compileOnly, runner), '../../runner.js');
	assert.equal(
		relativeModuleSpecifier(join(compileOnly, 'nested'), runner),
		'../../../runner.js',
	);

	const windowsRoot = 'C:\\db-semantic-planner';
	const windowsRunner = win32.join(
		windowsRoot,
		'tests/docs-verification/runner.js',
	);
	const windowsCompileOnly = win32.join(
		windowsRoot,
		'tests/docs-verification/__generated__/compile-only',
	);
	const windowsPathApi = {
		isAbsolute: win32.isAbsolute,
		relative: win32.relative,
		sep: win32.sep,
	};
	assert.equal(
		relativeModuleSpecifier(windowsCompileOnly, windowsRunner, windowsPathApi),
		'../../runner.js',
	);
	assert.equal(
		relativeModuleSpecifier(
			win32.join(windowsCompileOnly, 'nested'),
			windowsRunner,
			windowsPathApi,
		),
		'../../../runner.js',
	);

	assert.equal(
		relativeModuleSpecifier('generated', 'runner.js', {
			isAbsolute(path) {
				assert.equal(path, 'runner.js');
				return false;
			},
			relative(from, to) {
				assert.equal(from, 'generated');
				assert.equal(to, 'runner.js');
				return 'runner.js';
			},
			sep: '/',
		}),
		'./runner.js',
	);

	assert.equal(
		relativeModuleSpecifier('generated', 'generated/.runner.js'),
		'./.runner.js',
	);
	assert.equal(
		relativeModuleSpecifier('generated', 'generated/.support/runner.js'),
		'./.support/runner.js',
	);

	assert.throws(
		() => relativeModuleSpecifier('C:\\gen', 'D:\\runner.js', windowsPathApi),
		/Cannot create a relative module specifier from C:\\gen to D:\\runner\.js: paths must share a volume\./,
	);
	assert.throws(
		() =>
			relativeModuleSpecifier('C:\\gen', '\\\\server\\share\\runner.js', {
				...windowsPathApi,
				relative: () => '\\\\server\\share\\runner.js',
			}),
		/Cannot create a relative module specifier from C:\\gen to \\\\server\\share\\runner\.js: paths must share a volume\./,
	);
});
