/**
 * Runtime doctest evaluator.
 *
 * Given a raw TypeScript block string, wrap it in an async IIFE that has
 * every public @dbsp API pre-imported, transpile on the fly via `tsx`-style
 * dynamic import, and report pass/fail.
 *
 * Strategy: write each block to a unique file inside the project tree, then
 * `await import()` it. The filesystem indirection is cheap (~10ms) and gives
 * us real parse errors with accurate line numbers from the TS compiler.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TMP_ROOT = join(
	process.cwd(),
	'tests/docs-verification/__generated__/.tmp',
);
mkdirSync(TMP_ROOT, { recursive: true });

const PREAMBLE = `
// === Core DX surface ===
import {
\tschema,
\tref,
\touterRef,
\tcreateOrm,
\teq,
\tneq,
\tgt,
\tgte,
\tlt,
\tlte,
\tlike,
\tand,
\tor,
\tnot,
\tsome,
\tevery,
\tnone,
\texists,
\tnotExists,
\tinArray,
\tisNull,
\tisNotNull,
\top,
\tfn,
\tcast,
\tparam,
\tliteral,
\tunary,
\tnamedArg,
\tcaseWhen,
\tisDistinctFrom,
\tinSubquery,
\tsubquery,
\tbatchValues,
\tstar,
\tarray,
\tfullTextSearch,
\ttextScore,
} from '@dbsp/core';

// === PG-specific helpers (live in the adapter, not core) ===
import {
\tcreatePgsqlCompileOnlyAdapter,
\tcreatePgsqlAdapter,
\tbm25Search,
\tbooleanSearch,
\tboost,
\tparse,
\tscore,
\tgenerateSeries,
\tnextval,
\tcosineDistance,
\tinnerProduct,
\tl2Distance,
\trawDistance,
\tvectorDims,
} from '@dbsp/adapter-pgsql';

// Mocked Pool avoids real DB connections in doctests.
// biome-ignore lint/suspicious/noExplicitAny: stub
class Pool { constructor(_: any) {} async query() { return { rows: [], rowCount: 0 }; } async connect() { return this; } async end() {} release() {} }

// Deterministic fake env for blocks referencing process.env
process.env.DATABASE_URL ||= 'postgres://doctest:doctest@localhost:5432/doctest';

// Default schema — rich enough to cover most doc scenarios without redeclaration.
// Blocks that need exotic tables (embeddings, vector search, FTS index etc.)
// can shadow \`db\` / \`orm\` with their own declarations.
const __defaultDb = schema({
\tusers: {
\t\tid: 'uuid',
\t\tname: 'string',
\t\temail: 'string',
\t\tcreatedAt: 'timestamp',
\t\tactive: 'boolean',
\t},
\tposts: {
\t\tid: 'uuid',
\t\ttitle: 'string',
\t\tcontent: { type: 'text', nullable: true },
\t\tauthorId: ref('users'),
\t\tpublished: 'boolean',
\t\tcreatedAt: 'timestamp',
\t\tsearchVector: { type: 'tsvector', nullable: true },
\t},
\tcomments: {
\t\tid: 'uuid',
\t\tpostId: ref('posts'),
\t\tbody: 'string',
\t},
\tcategories: {
\t\tid: 'uuid',
\t\tname: 'string',
\t\tparentId: { type: ref('categories'), nullable: true },
\t},
\tdocuments: {
\t\tid: 'uuid',
\t\ttitle: 'string',
\t\tbody: 'text',
\t\tembedding: { type: 'vector', nullable: true },
\t},
} as const);
const __defaultOrm = createOrm({
\tschema: __defaultDb,
\tadapter: createPgsqlCompileOnlyAdapter(),
});

// Expose as the names many blocks use without redeclaring.
// Blocks that declare their own \`db\` / \`orm\` shadow these.
// biome-ignore lint/suspicious/noExplicitAny: doctest-scoped escape hatch
const db: any = __defaultDb;
// biome-ignore lint/suspicious/noExplicitAny: doctest-scoped escape hatch
const orm: any = __defaultOrm;
// biome-ignore lint/suspicious/noExplicitAny: doctest-scoped escape hatch
const pool: any = undefined;
// biome-ignore lint/suspicious/noExplicitAny: doctest-scoped escape hatch
const adapter: any = createPgsqlCompileOnlyAdapter();

// Stub helpers many blocks reference
const queryVec: number[] = [0.1, 0.2, 0.3];
const query = 'example search query';
const searchTerm = 'example';

`;

/**
 * Strip all import statements from a code block (single-line and multi-line).
 * The preamble already provides every symbol the block needs.
 */
function stripImports(code: string): string {
	const lines = code.split('\n');
	const result: string[] = [];
	let inMultiLineImport = false;

	for (const line of lines) {
		if (inMultiLineImport) {
			// Skip until we find the closing `} from '...';` line
			if (/^\s*\}\s*from\s+['"]/.test(line)) {
				inMultiLineImport = false;
			}
			continue;
		}

		// Single-line import: matches the full pattern on one line
		if (
			/^\s*import\s+.*from\s+['"]/.test(line) &&
			/;\s*$/.test(line.trimEnd())
		) {
			continue;
		}

		// Multi-line import start: open-brace without `from` on the same line.
		// Covers:  `import {`           (named only)
		//          `import type {`      (type-only named)
		//          `import Default, {`  (default + named)
		//          `import type D, {`   (type default + named, rare but valid)
		if (
			/^\s*import\s+(type\s+)?(\w+\s*,\s*)?\{/.test(line) &&
			!/from\s+['"]/.test(line)
		) {
			inMultiLineImport = true;
			continue;
		}

		// Side-effect import or default import (single line)
		if (/^\s*import\s+/.test(line)) {
			continue;
		}

		result.push(line);
	}

	return result.join('\n');
}

/**
 * Strip the leading `export` keyword from top-level declarations so the code
 * can execute inside an async IIFE wrapper (which does not allow module-level
 * exports).
 *
 * Handles: interface, type, class, function (incl. async), const, enum,
 * abstract — with optional `default`/`declare` modifiers between `export`
 * and the declaration kind. The `async` modifier (if present) is preserved
 * in the output.
 *
 * Supported order: `export [default] [declare] [async] <kind>`
 *
 * Examples:
 *   export interface X { ... }        → interface X { ... }
 *   export async function f() { ... } → async function f() { ... }
 *   export default class Y { ... }    → class Y { ... }
 *   export declare const Z = 1;       → const Z = 1;
 */
function stripTopLevelExport(code: string): string {
	// Strip `export` and optionally `default`/`declare`, but preserve `async`
	// and the declaration keyword so semantics are unchanged.
	//
	// Examples handled:
	//   export interface X {}          → interface X {}
	//   export async function f() {}   → async function f() {}
	//   export default class Y {}      → class Y {}
	//   export declare const Z = 1;    → const Z = 1;
	//   export default async function  → async function
	return code.replace(
		/^(\s*)export\s+(?:default\s+)?(?:declare\s+)?((?:async\s+)?(?:interface|type|class|function|const|enum|abstract)\s)/gm,
		'$1$2',
	);
}

export async function runBlock(
	code: string,
	file: string,
	line: number,
): Promise<void> {
	// Strip imports (single-line and multi-line) then top-level `export` keywords
	// so the code can safely execute inside the async IIFE wrapper.
	const cleaned = stripTopLevelExport(stripImports(code));

	const body = `${PREAMBLE}\nasync function __main() {\n${cleaned}\n}\nawait __main();\n`;

	const slug = randomBytes(4).toString('hex');
	const tmpFile = join(TMP_ROOT, `block-${slug}.ts`);
	writeFileSync(tmpFile, body);

	try {
		await import(tmpFile);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`${file}:${line} — ${msg}`);
	}
}
