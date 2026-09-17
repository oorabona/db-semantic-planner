/**
 * Doctest framework for validating TypeScript code blocks in documentation.
 *
 * Extracts markdown-it-tokenized `typescript` and `ts` fences from Markdown.
 *
 * Goal: prevent documentation drift by transpiling and executing runnable
 * TypeScript fences from configured sources without type-checking.
 */
import { readFileSync } from 'node:fs';
import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({ html: true });

export interface Annotation {
	skip?: boolean;
	/** When true, the block is skipped in compile-only mode and runs only when DBSP_DOCTEST_REAL_DB=1. */
	realDbOnly?: boolean;
}

export interface ExtractedBlock {
	file: string; // root-relative documentation source identity, e.g. "packages/docs/guide/joins.md"
	line: number; // 1-based line where the block opens
	codeStartLine: number; // 1-based line where the block's code begins
	sourceColumnReliable: boolean; // whether code columns retain their source-file meaning
	index: number; // 1-based block counter within the file
	language: string; // "typescript" | "ts" | "bash" | ...
	code: string; // markdown-it fence-token content, with one trailing newline removed if present
	annotations: Annotation; // parsed from `// doctest: skip` and `// doctest: real-db-only` markers
}

/**
 * Parse inline doctest annotations from block code.
 * Recognised forms (each on its own line, anywhere in the block):
 *   // doctest: skip        — skip this block entirely
 *   // doctest: real-db-only — runs only when DBSP_DOCTEST_REAL_DB=1
 */
function parseAnnotations(code: string): Annotation {
	const lines = code.split('\n');
	const ann: Annotation = {};
	for (const raw of lines) {
		const line = raw.trim();
		if (/^\/\/\s*doctest:\s*skip\b/i.test(line)) ann.skip = true;
		if (/^\/\/\s*doctest:\s*real-db-only\b/i.test(line)) ann.realDbOnly = true;
	}
	return ann;
}

/**
 * Extract markdown-it-tokenized `typescript` and `ts` fences, recording annotations
 * for callers to decide how to handle each block.
 */
export function extractBlocks(
	markdownPath: string,
	file = markdownPath,
): ExtractedBlock[] {
	const text = readFileSync(markdownPath, 'utf-8');
	const sourceLines = text.split(/\r\n?|\n/);
	const out: ExtractedBlock[] = [];
	let idx = 0;

	for (const token of markdown.parse(text, {})) {
		if (token.type !== 'fence') continue;
		idx++;

		const language =
			markdown.utils.unescapeAll(token.info).trim().match(/^\w+/)?.[0] ?? '';
		if (language !== 'typescript' && language !== 'ts') continue;
		if (token.map === null)
			throw new Error(`fence token has no source map for ${file}`);

		const code = token.content.endsWith('\n')
			? token.content.slice(0, -1)
			: token.content;
		const line = token.map[0] + 1;
		out.push({
			file,
			line,
			codeStartLine: line + 1,
			sourceColumnReliable:
				sourceLines[token.map[0]]?.startsWith(token.markup) === true,
			index: idx,
			language,
			code,
			annotations: parseAnnotations(code),
		});
	}

	return out;
}
