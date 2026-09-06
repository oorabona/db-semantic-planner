/**
 * Scans markdown sources and emits one test file per markdown bucket
 * into __generated__/, with ONE test PER BLOCK (not per file).
 *
 * Each block is wrapped in its own `it(...)` so a single bad block cannot
 * prevent other blocks from being checked. Blocks execute via a dynamic
 * import that wraps the code in an async IIFE with the standard @dbsp API
 * surface pre-imported.
 *
 * Run: `pnpm tsx tests/docs-verification/generate-tests.ts`
 */
import { randomUUID } from 'node:crypto';
import {
	type Dirent,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { doctestSources, looksLikeFragment } from './doc-sources.js';
import { extractBlocks } from './doctest.js';
import {
	type DoctestMode,
	doctestMode,
	ensureOwnedGeneratedDirectory,
	generatedSuiteDirectory,
	relativeModuleSpecifier,
} from './generated-suite-path.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootArgument = process.argv
	.slice(2)
	.find((argument) => !argument.startsWith('--'));
const ROOT = resolve(rootArgument ?? resolve(__dirname, '../..'));
/** When true, blocks annotated with `// doctest: real-db-only` are included as runnable tests. */
const mode = doctestMode();
const REAL_DB = mode === 'real-db';
const GENERATED = ensureOwnedGeneratedDirectory(
	ROOT,
	generatedSuiteDirectory(mode),
);

const SOURCES = doctestSources(ROOT);
const desiredSuiteFiles = new Set<string>();

let totalBlocks = 0;
let skippedBlocks = 0;
let skippedFragment = 0;
let skippedExplicit = 0;
let skippedRealDbOnly = 0;
let runnableBlocks = 0;
const generatedSuites: Array<{ file: string; contents: string }> = [];

for (const [bucket, mdFiles] of Object.entries(SOURCES)) {
	const cases: string[] = [];
	for (const mdFile of mdFiles) {
		const absMd = join(ROOT, mdFile);
		let blocks: ReturnType<typeof extractBlocks>;
		try {
			blocks = extractBlocks(absMd);
		} catch (error) {
			const cause = error instanceof Error ? error.message : String(error);
			const failure = JSON.stringify(
				`${mdFile} — cannot read documentation source: ${cause}`,
			);
			cases.push(`it(${failure}, () => { throw new Error(${failure}); });`);
			continue;
		}
		if (blocks.length === 0) continue;

		for (const block of blocks) {
			totalBlocks++;
			const label = JSON.stringify(
				`${block.file}:${block.line} (block ${block.index})`,
			);

			if (block.annotations.skip) {
				skippedBlocks++;
				skippedExplicit++;
				cases.push(`it.skip(${label}, () => {});`);
				continue;
			}
			if (block.annotations.realDbOnly === true && !REAL_DB) {
				skippedBlocks++;
				skippedRealDbOnly++;
				cases.push(`it.skip(${label}, () => {});`);
				continue;
			}
			if (looksLikeFragment(block.code)) {
				skippedBlocks++;
				skippedFragment++;
				cases.push(`it.skip(${label} + ' — fragment', () => {});`);
				continue;
			}

			runnableBlocks++;
			// The block body is passed AS A STRING to runBlock, which wraps it
			// in an async IIFE and evaluates via dynamic import. That way parse
			// errors in one block don't abort other blocks' tests.
			const encoded = JSON.stringify(block.code);
			cases.push(
				`it(${label}, async () => { await runBlock(${encoded}, ${JSON.stringify(block.file)}, ${block.line}, { realDbOnly: ${block.annotations.realDbOnly === true} }); });`,
			);
		}
	}

	if (cases.length === 0) continue;

	const header = generatedHeader(GENERATED, mode);
	const body = `describe(${JSON.stringify(bucket)}, () => {\n\t${cases.join('\n\t')}\n});\n`;
	const file = `${bucket}.test.ts`;
	generatedSuites.push({ file, contents: `${header}${body}` });
	desiredSuiteFiles.add(file);
}

const existingSuites = snapshotFlatGeneratedSuites(GENERATED);

for (const suite of generatedSuites) {
	writeGeneratedFileAtomically(join(GENERATED, suite.file), suite.contents);
}

const reconciledGeneratedDirectory = ensureOwnedGeneratedDirectory(
	ROOT,
	generatedSuiteDirectory(mode),
);
reconcileGeneratedSuites(
	reconciledGeneratedDirectory,
	desiredSuiteFiles,
	existingSuites,
);

function writeGeneratedFileAtomically(
	destination: string,
	contents: string,
): void {
	const temporary = join(
		dirname(destination),
		`.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`,
	);
	try {
		writeFileSync(temporary, contents);
		renameSync(temporary, destination);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

function reconcileGeneratedSuites(
	directory: string,
	desired: ReadonlySet<string>,
	entries: readonly Dirent[],
): void {
	for (const entry of entries) {
		if (!entry.name.endsWith('.test.ts') || desired.has(entry.name)) continue;
		const staleSuite = join(directory, entry.name);
		rmSync(staleSuite);
		console.log(`Removed stale generated suite: ${staleSuite}`);
	}
}

function snapshotFlatGeneratedSuites(directory: string): Dirent[] {
	const entries = readdirSync(directory, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		throw new Error(
			`Generated suite directory must be flat; found subdirectory: ${join(directory, entry.name)}`,
		);
	}
	return entries;
}

function generatedHeader(
	generatedDirectory: string,
	mode: DoctestMode,
): string {
	const runnerSpecifier = relativeModuleSpecifier(
		generatedDirectory,
		join(ROOT, 'tests/docs-verification/runner.js'),
	);
	const regenerate =
		mode === 'real-db'
			? 'Set DBSP_DOCTEST_REAL_DB=1, then run pnpm test:docs:generate'
			: 'pnpm tsx tests/docs-verification/generate-tests.ts';
	return `// GENERATED by tests/docs-verification/generate-tests.ts — DO NOT EDIT.
// Regenerate with: ${regenerate}
import { describe, it } from 'vitest';
import { runBlock } from '${runnerSpecifier}';

`;
}

const realDbSuffix =
	skippedRealDbOnly > 0
		? `, real-db-only: ${skippedRealDbOnly} [REAL_DB=0]`
		: '';
console.log(
	`Generated ${totalBlocks} block cases across ${Object.keys(SOURCES).length} buckets: ${runnableBlocks} runnable, ${skippedBlocks} skipped` +
		` (fragment: ${skippedFragment}, explicit-skip: ${skippedExplicit}${realDbSuffix}) [mode: ${mode}].`,
);
