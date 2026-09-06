import assert from 'node:assert/strict';
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cleanBlockSource } from './block-source.js';

const OUTPUT_TAIL_BYTES = 16 * 1024;

type GeneratorResult = Pick<
	SpawnSyncReturns<string>,
	'error' | 'signal' | 'status' | 'stdout' | 'stderr'
>;

function outputTail(name: string, output: string): string {
	const bytes = Buffer.from(output);
	const truncated = bytes.length > OUTPUT_TAIL_BYTES;
	const tail = truncated
		? bytes.subarray(bytes.length - OUTPUT_TAIL_BYTES)
		: bytes;
	const suffix = truncated ? ` (last ${OUTPUT_TAIL_BYTES} bytes)` : '';
	return `${name}${suffix}:\n${tail.toString()}`;
}

function assertGeneratorSucceeded(result: GeneratorResult): void {
	assert.equal(
		result.error,
		undefined,
		`generation failed to launch: ${result.error?.message ?? String(result.error)}`,
	);
	assert.equal(
		result.signal,
		null,
		`generation process was terminated by signal ${result.signal ?? 'unknown'}.`,
	);
	assert.equal(
		result.status,
		0,
		[
			`generation exited with status ${String(result.status)}.`,
			outputTail('stdout', result.stdout),
			outputTail('stderr', result.stderr),
		].join('\n'),
	);
}

test('module syntax removal leaves import-like template literal text intact', () => {
	const source = "const example = `\nimport x from 'pkg';\n`;";

	assert.equal(
		cleanBlockSource(source, 'template.md', 4),
		source,
		'template contents must not be treated as module syntax',
	);
});

test('module syntax removal leaves export-like template literal text intact', () => {
	const source = 'const example = `\nexport const y = 1;\n`;';

	assert.equal(cleanBlockSource(source, 'template.md', 4), source);
});

test('module syntax removal drops a multiline named import only', () => {
	const source =
		"import {\n\tfirst,\n\tsecond,\n} from 'pkg';\nconst value = first;";
	const cleaned = cleanBlockSource(source, 'imports.md', 7);

	assert.doesNotMatch(cleaned, /from 'pkg';/);
	assert.match(cleaned, /const value = first;/);
});

test('module syntax removal preserves every ECMAScript line terminator', () => {
	const source =
		"import /* first\r\nsecond\u2028third\u2029fourth */ { value } from 'pkg';\nconst after = value;";
	const cleaned = cleanBlockSource(source, 'terminators.md', 8);

	assert.equal(
		cleaned,
		'\r\n\u2028\u2029\nconst after = value;',
		'must retain CR, LF, U+2028, and U+2029 inside removed ranges',
	);
});

test('module syntax removal preserves async when removing export', () => {
	const cleaned = cleanBlockSource(
		'export async function f() {}',
		'exports.md',
		3,
	);

	assert.match(cleaned, /async function f\(\) \{\}/);
	assert.doesNotMatch(cleaned, /export async function f/);
});

test('parser diagnostics name the markdown file and original location', () => {
	assert.throws(
		() => cleanBlockSource('import x "m";', 'guide/invalid.md', 28),
		/guide\/invalid\.md:28:\d+ — /,
	);
});

test('generator subprocess assertion names a launch failure before its null status', () => {
	assert.throws(
		() =>
			assertGeneratorSucceeded({
				error: new Error('tsx executable is unavailable'),
				signal: null,
				status: null,
				stdout: '',
				stderr: '',
			}),
		/generation failed to launch: tsx executable is unavailable/,
	);
});

test('generator subprocess assertion names a terminating signal', () => {
	assert.throws(
		() =>
			assertGeneratorSucceeded({
				signal: 'SIGKILL',
				status: null,
				stdout: '',
				stderr: '',
			}),
		/generation process was terminated by signal SIGKILL/,
	);
});

test('generator subprocess assertion includes the stderr tail after a nonzero status', () => {
	const marker = 'generator summary at the end';
	assert.throws(
		() =>
			assertGeneratorSucceeded({
				signal: null,
				status: 1,
				stdout: '',
				stderr: `${'x'.repeat(OUTPUT_TAIL_BYTES)}${marker}`,
			}),
		new RegExp(`stderr \\(last ${OUTPUT_TAIL_BYTES} bytes\\):\\n.*${marker}`),
	);
});

test('generation emits one transform failure and continues with other blocks', () => {
	const root = mkdtempSync(join(tmpdir(), 'dbsp-docs-generator-'));
	const markdownFiles = [
		'packages/types/README.md',
		'packages/nql/README.md',
		'packages/core/README.md',
		'packages/adapter-pgsql/README.md',
		'packages/cli/README.md',
		'packages/mcp-server/README.md',
		'packages/docs/index.md',
		'packages/docs/patterns.md',
		'packages/docs/comparison.md',
		'packages/docs/roadmap.md',
	];

	try {
		mkdirSync(join(root, 'packages/docs/guide'), { recursive: true });
		mkdirSync(join(root, 'packages/docs/api'), { recursive: true });
		mkdirSync(join(root, 'packages/docs/nql'), { recursive: true });
		for (const file of markdownFiles) {
			const path = join(root, file);
			mkdirSync(join(path, '..'), { recursive: true });
			writeFileSync(path, '');
		}
		const fixtureMarkdown =
			'Prose before the example.\n\n```ts\nconst generated = true;\n\nimport x "m";\n```\n';
		const fixtureLines = fixtureMarkdown.split('\n');
		const invalidSourceLine = fixtureLines.indexOf('import x "m";') + 1;
		assert.notEqual(
			invalidSourceLine,
			0,
			'fixture must contain invalid source',
		);
		writeFileSync(join(root, 'README.md'), fixtureMarkdown);
		writeFileSync(
			join(root, 'packages/types/README.md'),
			'```ts\nconst generated = true;\n```\n',
		);

		const env = { ...process.env };
		delete env.DBSP_DOCTEST_REAL_DB;
		const result = spawnSync(
			join(process.cwd(), 'node_modules/.bin/tsx'),
			['tests/docs-verification/generate-tests.ts', root],
			{
				cwd: process.cwd(),
				encoding: 'utf8',
				env,
				maxBuffer: 256 * 1024,
			},
		);
		assertGeneratorSucceeded(result);

		const failureSuite = readFileSync(
			join(
				root,
				'tests/docs-verification/__generated__/compile-only/readme.test.ts',
			),
			'utf8',
		);
		const generatedLabel = failureSuite.match(/it\("([^"]+)"/)?.[1];
		assert.ok(generatedLabel, 'generated suite must contain a test label');
		assert.equal(generatedLabel, 'README.md:3 (block 1)');
		assert.doesNotMatch(
			generatedLabel,
			new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
			'generated labels must not expose the workspace root',
		);

		const parserDiagnostic = failureSuite.match(
			new RegExp(`(README\\.md:${invalidSourceLine}:\\d+ — [^"]+)`),
		)?.[1];
		assert.ok(
			parserDiagnostic,
			'generated suite must contain the parser diagnostic',
		);
		assert.match(
			parserDiagnostic,
			new RegExp(`^README\\.md:${invalidSourceLine}:\\d+ — `),
		);
		assert.doesNotMatch(
			parserDiagnostic,
			new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
			'parser diagnostics must not expose the workspace root',
		);
		const successfulSuite = readFileSync(
			join(
				root,
				'tests/docs-verification/__generated__/compile-only/package-readmes.test.ts',
			),
			'utf8',
		);
		assert.match(successfulSuite, /await runBlock\("const generated = true;"/);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});
