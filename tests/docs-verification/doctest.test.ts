import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { extractBlocks } from './doctest.js';

function withMarkdown<T>(markdown: string, callback: (path: string) => T): T {
	const directory = mkdtempSync(join(tmpdir(), 'dbsp-doctest-'));
	try {
		const path = join(directory, 'fixture.md');
		writeFileSync(path, markdown);
		return callback(path);
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
}

function lineOf(markdown: string, text: string): number {
	const offset = markdown.indexOf(text);
	assert.notEqual(offset, -1, `fixture must contain ${JSON.stringify(text)}`);
	return markdown.slice(0, offset).split(/\r\n|\r|\n/).length;
}

test('extracts a TypeScript fence inside a blockquote with its source location', () => {
	const source = [
		'Introduction.',
		'',
		'> Context for the example.',
		'>',
		'> ```typescript',
		'> const insideQuote = true;',
		'> ```',
	].join('\n');
	const fence = '> ```typescript';

	withMarkdown(source, (path) => {
		assert.deepEqual(extractBlocks(path, 'fixtures/quote.md'), [
			{
				file: 'fixtures/quote.md',
				line: lineOf(source, fence),
				codeStartLine: lineOf(source, fence) + 1,
				sourceColumnReliable: false,
				index: 1,
				language: 'typescript',
				code: 'const insideQuote = true;',
				annotations: {},
			},
		]);
	});
});

test('extracts a TypeScript fence inside a list item', () => {
	const source = [
		'- A documented example:',
		'',
		'  ```ts',
		'  const insideList = true;',
		'  ```',
	].join('\n');

	withMarkdown(source, (path) => {
		const [block] = extractBlocks(path);
		assert.equal(block?.code, 'const insideList = true;');
		assert.equal(block?.line, lineOf(source, '  ```ts'));
		assert.equal(block?.sourceColumnReliable, false);
	});
});

test('marks an isolated indented top-level fence as column-unreliable', () => {
	const source = ['  ```ts', '  const indentedTopLevel = true;', '  ```'].join(
		'\n',
	);

	withMarkdown(source, (path) => {
		const [block] = extractBlocks(path);
		assert.equal(block?.code, 'const indentedTopLevel = true;');
		assert.equal(block?.line, lineOf(source, '  ```ts'));
		assert.equal(block?.sourceColumnReliable, false);
	});
});

test('normalizes whitespace and entities in TypeScript fence info strings', () => {
	const source = [
		'``` ts',
		'const backtickWhitespace = true;',
		'```',
		'',
		'~~~ ts',
		'const tildeWhitespace = true;',
		'~~~',
		'',
		'```t&#115;',
		'const escapedEntity = true;',
		'```',
	].join('\n');

	withMarkdown(source, (path) => {
		assert.deepEqual(
			extractBlocks(path).map((block) => ({
				language: block.language,
				line: block.line,
				code: block.code,
			})),
			[
				{
					language: 'ts',
					line: lineOf(source, '``` ts'),
					code: 'const backtickWhitespace = true;',
				},
				{
					language: 'ts',
					line: lineOf(source, '~~~ ts'),
					code: 'const tildeWhitespace = true;',
				},
				{
					language: 'ts',
					line: lineOf(source, '```t&#115;'),
					code: 'const escapedEntity = true;',
				},
			],
		);
	});
});

test('keeps shorter backticks inside a four-backtick fence body', () => {
	const source = ['````ts', "const nestedFence = '```';", '```', '````'].join(
		'\n',
	);

	withMarkdown(source, (path) => {
		assert.deepEqual(
			extractBlocks(path).map((block) => block.code),
			["const nestedFence = '```';\n```"],
		);
	});
});

test('extracts a TypeScript fence left open at end of file', () => {
	const source = ['Before.', '', '```ts', 'const atEnd = true;'].join('\n');

	withMarkdown(source, (path) => {
		const [block] = extractBlocks(path);
		assert.equal(block?.code, 'const atEnd = true;');
		assert.equal(block?.line, lineOf(source, '```ts'));
		assert.equal(block?.sourceColumnReliable, true);
	});
});

test('counts non-TypeScript fences in the per-file fence index', () => {
	const source = [
		'```bash',
		'echo ignored',
		'```',
		'',
		'```ts',
		'const secondFence = true;',
		'```',
	].join('\n');

	withMarkdown(source, (path) => {
		const [block] = extractBlocks(path);
		assert.equal(block?.index, 2);
	});
});

test('removes markdown-it’s single trailing newline from extracted code', () => {
	const source = ['```ts', 'const noTrailingNewline = true;', '```'].join('\n');

	withMarkdown(source, (path) => {
		const [block] = extractBlocks(path);
		assert.equal(block?.code.endsWith('\n'), false);
	});
});

test('requires a language at the start of a fence info string', () => {
	const source = [
		'```{.ts}',
		'const attributeSyntax = true;',
		'```',
		'',
		'```ts{1,3}',
		'const quantified = true;',
		'```',
	].join('\n');

	withMarkdown(source, (path) => {
		const blocks = extractBlocks(path);
		const [block] = blocks;
		assert.equal(blocks.length, 1);
		assert.equal(block?.language, 'ts');
		assert.equal(block?.line, lineOf(source, '```ts{1,3}'));
		assert.equal(block?.code, 'const quantified = true;');
	});
});

test('normalizes bare carriage-return line endings before locating fences', () => {
	const source = ['Before.', '```ts', 'const bareCr = true;', '```'].join('\r');

	withMarkdown(source, (path) => {
		const [block] = extractBlocks(path);
		assert.equal(block?.line, lineOf(source, '```ts'));
		assert.equal(block?.code, 'const bareCr = true;');
	});
});
