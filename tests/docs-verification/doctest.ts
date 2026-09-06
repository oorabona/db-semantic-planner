/**
 * Doctest framework for validating TypeScript code blocks in documentation.
 *
 * Extracts ```typescript and ```ts blocks from markdown files, compiles them
 * against the real @dbsp APIs.
 *
 * Goal: prevent documentation drift by transpiling and executing runnable
 * TypeScript fences from configured sources without type-checking.
 */
import { readFileSync } from 'node:fs';

export interface Annotation {
	skip?: boolean;
	/** When true, the block is skipped in compile-only mode and runs only when DBSP_DOCTEST_REAL_DB=1. */
	realDbOnly?: boolean;
}

export interface ExtractedBlock {
	file: string; // relative path, e.g. "packages/docs/guide/joins.md"
	line: number; // 1-based line where the block opens
	index: number; // 1-based block counter within the file
	language: string; // "typescript" | "ts" | "bash" | ...
	code: string; // the raw block body (no backtick fences)
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
 * Extract all typescript code blocks from a markdown file, recording annotations
 * for callers to decide how to handle each block.
 */
export function extractBlocks(mdFile: string): ExtractedBlock[] {
	const text = readFileSync(mdFile, 'utf-8');
	const lines = text.split('\n');
	const out: ExtractedBlock[] = [];
	let inBlock = false;
	let lang = '';
	let startLine = 0;
	let buf: string[] = [];
	let idx = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const fenceMatch = line.match(/^```(\w+)?/);
		if (fenceMatch && !inBlock) {
			inBlock = true;
			lang = fenceMatch[1] ?? '';
			startLine = i + 1;
			buf = [];
		} else if (line.trim() === '```' && inBlock) {
			inBlock = false;
			idx++;
			if (lang === 'typescript' || lang === 'ts') {
				const code = buf.join('\n');
				const annotations = parseAnnotations(code);
				out.push({
					file: mdFile,
					line: startLine,
					index: idx,
					language: lang,
					code,
					annotations,
				});
			}
		} else if (inBlock) {
			buf.push(line);
		}
	}

	return out;
}
