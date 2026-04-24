/**
 * Runtime doctest evaluator.
 *
 * Given a raw TypeScript block string, wrap it in an async IIFE that has
 * every public @dbsp API pre-imported, transpile on the fly via `tsx`-style
 * dynamic import, and report pass/fail.
 *
 * Strategy: write each block to a unique file under /tmp, then `await import()`
 * it. The filesystem indirection is cheap (~10ms) and gives us real parse
 * errors with accurate line numbers from the TS compiler.
 *
 * Failure modes surfaced:
 *   - Parse error (invalid TS syntax)       → test fails with compile error
 *   - Type error on import (API drift)       → test fails with module error
 *   - Runtime error (wrong method call)      → test fails with exception
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const TMP_ROOT = join(process.cwd(), 'tests/docs-verification/__generated__/.tmp');
mkdirSync(TMP_ROOT, { recursive: true });

const PREAMBLE = `
import {
\tschema,
\tref,
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
\tcosineDistance,
\trawDistance,
\tl2Distance,
\tinnerProduct,
\tbm25Search,
\tparse,
\tboost,
\tbooleanSearch,
\tscore,
\tfullTextSearch,
\ttextScore,
\tgenerateSeries,
\tnextval,
\tisDistinctFrom,
\tinSubquery,
\tsubquery,
} from '@dbsp/core';
import { createPgsqlCompileOnlyAdapter, createPgsqlAdapter } from '@dbsp/adapter-pgsql';
// Mocked Pool avoids real DB connections in doctests
class Pool { constructor(_: any) {} async query() { return { rows: [], rowCount: 0 }; } async connect() { return this; } async end() {} release() {} }

// Deterministic fake env for blocks referencing process.env
process.env.DATABASE_URL ||= 'postgres://doctest:doctest@localhost:5432/doctest';

// Default orm + schema that blocks can reference if they don't declare their own.
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
\t\tauthorId: ref('users'),
\t\tpublished: 'boolean',
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

`;

/**
 * Run a single doctest block. Writes the code to a temp file wrapped in an
 * async IIFE, then imports it dynamically so TS/JS parse + runtime errors
 * propagate through as regular exceptions.
 */
export async function runBlock(
	code: string,
	file: string,
	line: number,
): Promise<void> {
	// Strip \`import\` lines from the block; the preamble provides every symbol.
	const noImports = code
		.split('\n')
		.filter((l) => !/^\s*import\s+/.test(l))
		.join('\n');

	const body = `${PREAMBLE}\nasync function __main() {\n${noImports}\n}\nawait __main();\n`;

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
