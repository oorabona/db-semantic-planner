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

/** When true, blocks tagged `real-db-only` run against a real PostgreSQL instance. */
const REAL_DB = process.env.DBSP_DOCTEST_REAL_DB === '1';

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
\trangeContainedBy,
\trangeContains,
\trangeOverlaps,
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
\t\tid: { type: 'uuid', primaryKey: true },
\t\tname: 'string',
\t\temail: 'string',
\t\tcreatedAt: 'timestamp',
\t\tactive: 'boolean',
\t},
\tposts: {
\t\tid: { type: 'uuid', primaryKey: true },
\t\ttitle: 'string',
\t\tcontent: { type: 'text', nullable: true },
\t\tauthorId: ref('users'),
\t\tpublished: 'boolean',
\t\tcreatedAt: 'timestamp',
\t\tsearchVector: { type: 'tsvector', nullable: true },
\t},
\tcomments: {
\t\tid: { type: 'uuid', primaryKey: true },
\t\tpostId: ref('posts'),
\t\tbody: 'string',
\t},
\tcategories: {
\t\tid: { type: 'uuid', primaryKey: true },
\t\tname: 'string',
\t\tparentId: { type: ref('categories'), nullable: true },
\t},
\tdocuments: {
\t\tid: { type: 'uuid', primaryKey: true },
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

// Stub helpers for blocks that reference processRow / logger / metrics
async function processRow(_row: unknown): Promise<void> {}
const logger = {
  info: (..._args: unknown[]) => {},
  warn: (..._args: unknown[]) => {},
  debug: (..._args: unknown[]) => {},
  error: (..._args: unknown[]) => {},
};

`;

/**
 * Preamble for `real-db-only` blocks: uses a real pg.Pool + createPgsqlAdapter.
 * Provides __resetSchema() to drop-and-recreate all default tables before each block.
 * primaryKey: true on every id column so FK references satisfy PostgreSQL's uniqueness check.
 */
const REAL_DB_PREAMBLE = `
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
\trangeContainedBy,
\trangeContains,
\trangeOverlaps,
} from '@dbsp/core';

// === PG-specific helpers ===
import {
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
\tgenerateDDL,
} from '@dbsp/adapter-pgsql';

import { Pool } from 'pg';

// Deterministic fake env for blocks referencing process.env
process.env.DATABASE_URL ||= 'postgres://doctest:doctest@localhost:5432/doctest';

// All id columns carry primaryKey: true so FK references are valid in a real PG.
const __defaultDb = schema({
\tusers: {
\t\tid: { type: 'uuid', primaryKey: true },
\t\tname: 'string',
\t\temail: 'string',
\t\tcreatedAt: 'timestamp',
\t\tactive: 'boolean',
\t},
\tposts: {
\t\tid: { type: 'uuid', primaryKey: true },
\t\ttitle: 'string',
\t\tcontent: { type: 'text', nullable: true },
\t\tauthorId: ref('users'),
\t\tpublished: 'boolean',
\t\tcreatedAt: 'timestamp',
\t\tsearchVector: { type: 'tsvector', nullable: true },
\t},
\tcomments: {
\t\tid: { type: 'uuid', primaryKey: true },
\t\tpostId: ref('posts'),
\t\tbody: 'string',
\t},
\tcategories: {
\t\tid: { type: 'uuid', primaryKey: true },
\t\tname: 'string',
\t\tparentId: { type: ref('categories'), nullable: true },
\t},
\tdocuments: {
\t\tid: { type: 'uuid', primaryKey: true },
\t\ttitle: 'string',
\t\tbody: 'text',
\t\tembedding: { type: 'vector', nullable: true },
\t},
} as const);

// One Pool per block-module (each temp file is a fresh module).
// Pool is ended at the bottom of __main() to avoid leaked connections.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
  min: 0,
  idleTimeoutMillis: 1000,
});

const adapter = createPgsqlAdapter(pool);
// biome-ignore lint/suspicious/noExplicitAny: doctest-scoped escape hatch
const orm: any = createOrm({ schema: __defaultDb, adapter });
// biome-ignore lint/suspicious/noExplicitAny: doctest-scoped escape hatch
const db: any = __defaultDb;

// DDL statements for the default schema — computed once per block.
const __bootstrapDDL: string[] = generateDDL(__defaultDb.model);

/**
 * Drop all default tables then replay DDL so each block starts from a clean state.
 *
 * We MUST NOT use DROP SCHEMA public CASCADE because the CI image
 * (ghcr.io/oorabona/postgres:18-alpine-full) ships with the Citus extension
 * pre-installed.  Dropping the public schema invalidates Citus's internal
 * catalog (pg_dist_local_group) and causes every subsequent query on the same
 * connection to fail with "cache lookup failed for pg_dist_local_group, called
 * too early?".  Dropping only our own tables leaves Citus metadata untouched.
 *
 * Table names are derived from __defaultDb.tableNames (the array returned by
 * schema()) so this list stays in sync automatically with the schema object.
 */
async function __resetSchema(): Promise<void> {
\t// Derive table names from the schema object — no hardcoding needed.
\tconst tableNames: string[] = [...__defaultDb.tableNames] as string[];
\tif (tableNames.length > 0) {
\t\tconst quoted = tableNames.map((n) => '"' + n + '"').join(', ');
\t\tawait pool.query('DROP TABLE IF EXISTS ' + quoted + ' CASCADE');
\t}
\t// Replay all DDL statements (CREATE TABLE + FK constraints + indexes).
\tfor (const stmt of __bootstrapDDL) {
\t\tawait pool.query(stmt);
\t}
}

// Stub helpers many blocks reference
const queryVec: number[] = [0.1, 0.2, 0.3];
const query = 'example search query';
const searchTerm = 'example';

// Stub helpers for blocks that reference processRow / logger / metrics
async function processRow(_row: unknown): Promise<void> {}
const logger = {
  info: (..._args: unknown[]) => {},
  warn: (..._args: unknown[]) => {},
  debug: (..._args: unknown[]) => {},
  error: (..._args: unknown[]) => {},
};

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

	// Detect `// doctest: real-db-only` annotation (any position in the block).
	// Allow leading whitespace so indented annotations are also matched.
	const isRealDbOnly =
		REAL_DB && /^\s*\/\/\s*doctest:\s*real-db-only\b/im.test(code);

	let body: string;
	if (isRealDbOnly) {
		// Prepend schema reset; wrap block in try/finally so pool.end() always
		// runs even if the block throws or returns early (prevents leaked Pools).
		const blockWithReset = `await __resetSchema();\ntry {\n${cleaned}\n} finally {\n  await pool.end();\n}`;
		body = `${REAL_DB_PREAMBLE}\nasync function __main() {\n${blockWithReset}\n}\nawait __main();\n`;
	} else {
		body = `${PREAMBLE}\nasync function __main() {\n${cleaned}\n}\nawait __main();\n`;
	}

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
