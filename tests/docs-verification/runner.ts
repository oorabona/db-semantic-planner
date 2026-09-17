/**
 * Runtime doctest evaluator.
 *
 * Given an already-clean TypeScript block string, hoist its supported static
 * imports, wrap it in an async IIFE with fixed ambient bindings, transpile on
 * the fly via `tsx`-style dynamic import, and report pass/fail.
 *
 * Strategy: write each block to a unique file inside the project tree, then
 * `await import()` it. The filesystem indirection is cheap (~10ms) and gives
 * us real parse errors with accurate line numbers from the TS compiler.
 */
import { randomUUID } from 'node:crypto';
import { unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BlockImport } from './block-source.js';
import {
	ensureOwnedGeneratedDirectory,
	generatedSuitesRootDirectory,
} from './generated-suite-path.js';

/** When true, blocks tagged `real-db-only` run against a real PostgreSQL instance. */
const REAL_DB = process.env.DBSP_DOCTEST_REAL_DB === '1';
const TMP_ROOT = ensureOwnedGeneratedDirectory(
	process.cwd(),
	join(generatedSuitesRootDirectory(), '.tmp'),
);
const KEEP_FAILED_MODULES =
	process.env.DBSP_DOCTEST_KEEP_FAILED_MODULES === '1';
const CORE_AMBIENT_NAMES = [
	'schema',
	'ref',
	'outerRef',
	'createOrm',
	'eq',
	'neq',
	'gt',
	'gte',
	'lt',
	'lte',
	'like',
	'and',
	'or',
	'not',
	'some',
	'every',
	'none',
	'exists',
	'notExists',
	'inArray',
	'isNull',
	'isNotNull',
	'op',
	'fn',
	'boolFn',
	'unsafeAsPredicate',
	'createHookManager',
	'cast',
	'param',
	'literal',
	'unary',
	'namedArg',
	'caseWhen',
	'isDistinctFrom',
	'inSubquery',
	'subquery',
	'batchValues',
	'star',
	'array',
	'fullTextSearch',
	'textScore',
	'rangeContainedBy',
	'rangeContains',
	'rangeOverlaps',
	'exprRef',
] as const;
const ADAPTER_AMBIENT_NAMES = [
	'createPgsqlCompileOnlyAdapter',
	'createPgsqlAdapter',
	'bm25Search',
	'booleanSearch',
	'boost',
	'parse',
	'score',
	'generateSeries',
	'nextval',
	'cosineDistance',
	'innerProduct',
	'l2Distance',
	'rawDistance',
	'vectorDims',
	'generateDDL',
	'redactParams',
	'DEFAULT_REDACTION_PATTERNS',
] as const;

function describeThrownValue(value: unknown): string {
	try {
		if (value instanceof Error) {
			const message = value.message;
			if (typeof message === 'string') return message;
		}
		return String(value);
	} catch {
		return '<non-stringifiable thrown value>';
	}
}

function filteredImport(
	module: string,
	names: readonly string[],
	locals: ReadonlySet<string>,
): string {
	const available = names.filter((name) => !locals.has(name));
	return available.length === 0
		? ''
		: `import { ${available.join(', ')} } from '${module}';\n`;
}

function emittedImports(
	imports: readonly BlockImport[],
	realDb: boolean,
): readonly BlockImport[] {
	return imports.filter((blockImport) => blockImport.module !== 'pg' || realDb);
}

/**
 * Shared __defaultDb schema literal injected into both compile-only and real-DB setups.
 * All id columns carry primaryKey: true so FK references are valid in a real PG.
 * Blocks that need exotic tables can shadow `db` / `orm` with their own declarations.
 */
const DEFAULT_SCHEMA_DEFINITION = `
// Default schema — rich enough to cover most doc scenarios without redeclaration.
// All id columns carry primaryKey: true so FK references satisfy PG uniqueness checks.
// Blocks that need exotic tables (embeddings, vector search, FTS index etc.)
// can shadow \`db\` / \`orm\` with their own declarations.
const __defaultDb = __doctestSchema({
	users: {
		id: { type: 'uuid', primaryKey: true },
		name: 'string',
		email: 'string',
		createdAt: 'timestamp',
		active: 'boolean',
	},
	posts: {
		id: { type: 'uuid', primaryKey: true },
		title: 'string',
		content: { type: 'text', nullable: true },
		authorId: __doctestRef('users'),
		published: 'boolean',
		createdAt: 'timestamp',
		searchVector: { type: 'tsvector', nullable: true },
	},
	comments: {
		id: { type: 'uuid', primaryKey: true },
		postId: __doctestRef('posts'),
		body: 'string',
	},
	categories: {
		id: { type: 'uuid', primaryKey: true },
		name: 'string',
		parentId: { type: __doctestRef('categories'), nullable: true },
	},
	documents: {
		id: { type: 'uuid', primaryKey: true },
		title: 'string',
		body: 'text',
		embedding: { type: 'vector', nullable: true },
	},
} as const);
`;
const COMPILE_ONLY_SETUP = `
// Mocked Pool avoids real DB connections in doctests.
//
// A Pool must NOT have release() and connect() must NOT return the pool itself.
// That is the whole difference between a pool and a checked-out client, and the
// adapter reads it to refuse a client that was handed over without being declared
// (#322). A fake that conflates the two is a fake that cannot exercise the check —
// and it made every doctest look like it was passing a client.
// biome-ignore lint/suspicious/noExplicitAny: doctest stub
class __DoctestPoolClient { async query() { return { rows: [], rowCount: 0 }; } release() {} }
// biome-ignore lint/suspicious/noExplicitAny: doctest stub
class __DoctestPool { constructor(_: any) {} async query() { return { rows: [], rowCount: 0 }; } async connect() { return new __DoctestPoolClient(); } async end() {} }
// Deterministic fake env for blocks referencing process.env
process.env.DATABASE_URL ||= 'postgres://doctest:doctest@localhost:5432/doctest';
const __defaultOrm = __doctestCreateOrm({ schema: __defaultDb, adapter: __doctestCreatePgsqlCompileOnlyAdapter() });
const __doctestPool: any = undefined;
const __doctestAdapter: any = __doctestCreatePgsqlCompileOnlyAdapter();
`;
const REAL_DB_SETUP = `
// Deterministic fake env for blocks referencing process.env
process.env.DATABASE_URL ||= 'postgres://doctest:doctest@localhost:5432/doctest';
// One Pool per block-module (each temp file is a fresh module).
// Pool is ended at the bottom of __main() to avoid leaked connections.
const __doctestPool = new __doctestPgPool({ connectionString: process.env.DATABASE_URL, max: 2, min: 0, idleTimeoutMillis: 1000 });
const __doctestAdapter = __doctestCreatePgsqlAdapter(__doctestPool);
const __defaultOrm = __doctestCreateOrm({ schema: __defaultDb, adapter: __doctestAdapter });
// DDL statements for the default schema — computed once per block.
const __bootstrapDDL: string[] = __doctestGenerateDDL(__defaultDb.model);
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
	// Derive table names from the schema object — no hardcoding needed.
	const tableNames: string[] = [...__defaultDb.tableNames] as string[];
	if (tableNames.length > 0) {
		const quoted = tableNames.map((n) => '"' + n + '"').join(', ');
		await __doctestPool.query('DROP TABLE IF EXISTS ' + quoted + ' CASCADE');
	}
	// Each generated statement is independently executable.
	for (const stmt of __bootstrapDDL) {
		await __doctestPool.query(stmt);
	}
}
`;

function renderPreamble(
	imports: readonly BlockImport[],
	realDb: boolean,
): string {
	const emitted = emittedImports(imports, realDb);
	const locals = new Set(
		emitted.flatMap((blockImport) => blockImport.runtimeLocalNames),
	);
	const blockImports = emitted
		.map((blockImport) => blockImport.text)
		.join('\n');
	const privateImports = realDb
		? `import { schema as __doctestSchema, ref as __doctestRef, createOrm as __doctestCreateOrm, resetLogger as __doctestResetLogger } from '@dbsp/core';
import { createPgsqlAdapter as __doctestCreatePgsqlAdapter, generateDDL as __doctestGenerateDDL } from '@dbsp/adapter-pgsql';
import { Pool as __doctestPgPool } from 'pg';
`
		: `import { schema as __doctestSchema, ref as __doctestRef, createOrm as __doctestCreateOrm, resetLogger as __doctestResetLogger } from '@dbsp/core';
import { createPgsqlCompileOnlyAdapter as __doctestCreatePgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';
`;
	const fixture = (name: string, declaration: string) =>
		locals.has(name) ? '' : declaration;
	const fixtures = [
		fixture(
			'db',
			'// Expose as the names many blocks use without redeclaring.\n// Blocks that declare their own `db` / `orm` shadow these.\n// biome-ignore lint/suspicious/noExplicitAny: doctest-scoped escape hatch\nconst db: any = __defaultDb;\n',
		),
		fixture('orm', 'const orm: any = __defaultOrm;\n'),
		fixture(
			'Pool',
			realDb
				? 'const Pool = __doctestPgPool;\n'
				: 'const Pool = __DoctestPool;\n',
		),
		fixture(
			'pool',
			realDb
				? "// User-facing alias — doctest blocks reading 'pool' get the preamble pool.\n// Blocks that redeclare 'const pool = ...' shadow this binding, leaving\n// '__doctestPool' unaffected.\nconst pool: any = __doctestPool;\n"
				: 'const pool: any = __doctestPool;\n',
		),
		fixture('adapter', 'const adapter: any = __doctestAdapter;\n'),
		fixture(
			'queryVec',
			'// Stub helpers many blocks reference\nconst queryVec: number[] = [0.1, 0.2, 0.3];\n',
		),
		fixture('query', "const query = 'example search query';\n"),
		fixture('searchTerm', "const searchTerm = 'example';\n"),
		fixture(
			'processRow',
			'// Stub helpers for blocks that reference processRow / logger / metrics\nasync function processRow(_row: unknown): Promise<void> {}\n',
		),
		fixture(
			'logger',
			'const logger = { info: (..._args: unknown[]) => {}, warn: (..._args: unknown[]) => {}, debug: (..._args: unknown[]) => {}, error: (..._args: unknown[]) => {} };\n',
		),
	].join('');
	const publicImports = [
		locals.has('expect') ? '' : "import { expect } from 'vitest';\n",
		filteredImport('@dbsp/core', CORE_AMBIENT_NAMES, locals),
		filteredImport('@dbsp/adapter-pgsql', ADAPTER_AMBIENT_NAMES, locals),
	].join('');
	return `${blockImports}${blockImports === '' ? '' : '\n'}${privateImports}${publicImports}${DEFAULT_SCHEMA_DEFINITION}\n${realDb ? REAL_DB_SETUP : COMPILE_ONLY_SETUP}\n${fixtures}`;
}

export function renderBlockModule(
	code: string,
	imports: readonly BlockImport[],
	isRealDbOnly: boolean,
	file = '<unknown file>',
	line = 0,
): string {
	if (isRealDbOnly) {
		// Keep both the execution failure and a shutdown failure. The reset belongs
		// inside the lifecycle so every outcome after Pool construction ends it.
		const blockWithLifecycle = `async function __documentationBody() {
${code}
}

let __primaryValue: unknown;
let __hasPrimaryValue = false;
try {
	await __resetSchema();
	await __documentationBody();
} catch (error) {
	__primaryValue = error;
	__hasPrimaryValue = true;
} finally {
	try {
		await __doctestPool.end();
	} catch (error) {
		if (__hasPrimaryValue) {
			throw new AggregateError(
				[__primaryValue, error],
				${JSON.stringify(`${file}:${line} — documentation block and mandatory cleanup both failed`)},
			);
		}
		throw error;
	}
}
if (__hasPrimaryValue) throw __primaryValue;`;
		return `${renderPreamble(imports, true)}\nasync function __main() {\n${blockWithLifecycle}\n}\ntry { await __main(); } finally { __doctestResetLogger(); }\n`;
	}

	return `${renderPreamble(imports, false)}\nasync function __main() {\n${code}\n}\ntry { await __main(); } finally { __doctestResetLogger(); }\n`;
}

export async function runBlock(
	code: string,
	imports: readonly BlockImport[],
	file: string,
	line: number,
	options?: { realDbOnly?: boolean },
): Promise<void> {
	// Use the pre-parsed annotation flag passed by the generator.
	// Avoids dual-parsing risk (regex anchor vs trim-line mismatch).
	const isRealDbOnly = REAL_DB && (options?.realDbOnly ?? false);
	const body = renderBlockModule(code, imports, isRealDbOnly, file, line);
	const tmpFile = join(TMP_ROOT, `block-${process.pid}-${randomUUID()}.ts`);

	let primaryError: unknown;
	let hasPrimaryError = false;
	let retainFailedModule = false;
	let cleanupError: unknown;
	let hasCleanupError = false;
	try {
		writeFileSync(tmpFile, body);
		try {
			await import(pathToFileURL(tmpFile).href);
		} catch (error) {
			retainFailedModule = true;
			throw error;
		}
	} catch (error) {
		primaryError = error;
		hasPrimaryError = true;
	} finally {
		if (!(retainFailedModule && KEEP_FAILED_MODULES)) {
			try {
				unlinkSync(tmpFile);
			} catch (error) {
				if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
					cleanupError = error;
					hasCleanupError = true;
				}
			}
		}
	}

	if (hasPrimaryError) {
		const prefix = `${file}:${line} — `;
		const diagnostic = describeThrownValue(primaryError);
		const message = diagnostic.startsWith(prefix)
			? diagnostic
			: `${prefix}${diagnostic}`;
		if (hasCleanupError) {
			throw new AggregateError(
				[primaryError, cleanupError],
				`${file}:${line} — documentation block and scratch cleanup both failed`,
			);
		}
		throw new Error(message, { cause: primaryError });
	}
	if (hasCleanupError) {
		throw new Error(`${file}:${line} — mandatory scratch cleanup failed`, {
			cause: cleanupError,
		});
	}
}
