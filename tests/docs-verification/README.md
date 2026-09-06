# Docs verification (doctest)

For the markdown sources listed below, runnable TypeScript blocks are parsed,
imported, and executed; a parse error, import failure, or runtime throw fails
the suite. Blocks marked `real-db-only` run in the separate real-database
workflow, not the compile-only run. Blocks marked `skip`, and blocks rejected
as fragment continuations by the heuristic, are not executed; `pnpm
check:docs-ledger` counts them and nothing more. This harness does not
type-check blocks.

## Scope

Scanned markdown sources (see `generate-tests.ts`):

- `README.md`
- `packages/*/README.md` (6 publishable packages)
- `packages/docs/index.md`, `patterns.md`, `comparison.md`, `roadmap.md`
- `packages/docs/guide/*.md`
- `packages/docs/api/*.md`
- `packages/docs/nql/*.md`

Run `pnpm check:docs-ledger` to print the live source and code-block totals.

## How it works

1. `doctest.ts` extracts column-zero `\`\`\`typescript` / `\`\`\`ts` blocks,
   capturing file path, line number, block index, and optional
   annotations (`// doctest: skip — <reason>`, `// doctest: real-db-only — <reason>`).

2. `generate-tests.ts` emits one `*.test.ts` per source bucket that produces at
   least one test case into the active mode's flat `__generated__/compile-only/`
   or `__generated__/real-db/` directory (gitignored). Each block becomes an
   `it(...)` so a single broken block does not abort other tests in the same file.

3. `runner.ts` evaluates a block by writing it to a scratch file inside
   `__generated__/.tmp/`, wrapping it in an async IIFE with every public
	`@dbsp` symbol pre-imported, then dynamic-importing it. Any parse error,
	import failure, or runtime throw becomes a test failure with the original
   markdown file and line.

The generator rejects an already-invalid generated-path layout before mutation. It does not
protect against a concurrent process that can rename or replace a validated path component or
entry between validation and any subsequent path-based `mkdir`, write, rename, temporary cleanup,
or unlink operation.

In compile-only mode, the runner supplies a mocked `Pool` preamble binding, so
an example using that binding creates no real PostgreSQL connection. Authors of
compile-only examples must not load `pg` or another network-capable module at
runtime: dynamic and other runtime module loading is not intercepted. Mark an
example that needs a connection `real-db-only`. Query execution paths (`.all()`,
`.execute()`) rely on the compile-only adapter throwing a clear error — doc
authors should prefer `.dump()` in examples to illustrate the SQL the planner
produces. Set `DBSP_DOCTEST_KEEP_FAILED_MODULES=1` to retain a failed block's
scratch module for inspection.
The runner unlinks each scratch module after its import settles; modules retained with `DBSP_DOCTEST_KEEP_FAILED_MODULES=1` are named `block-<pid>-<uuid>.ts` directly in `__generated__/.tmp/`. Run this command only when no docs-verification runner, docs test, or watch process is active in this checkout — otherwise it can delete a module between its write and its import:

`find tests/docs-verification/__generated__/.tmp -mindepth 1 -delete`

It clears retained modules and artifacts left by earlier runner versions, because `pnpm clean:artifacts` covers neither and only matches compiled `.js`/`.d.ts` siblings.

## Running

```bash
pnpm test:docs                 # generate + run
pnpm test:docs:generate        # just regenerate the *.test.ts files
pnpm vitest run --config tests/docs-verification/vitest.config.docs.ts  # run the active mode directly
```

## Annotations

Add these comments inside a block to control whether it runs:

```typescript
// doctest: skip — <reason>                   // skip this block entirely
// doctest: real-db-only — <reason>           // skip in compile-only mode; run when DBSP_DOCTEST_REAL_DB=1
```

Blocks that start with a `.methodName(...)` or a binary operator are auto-
detected as fragment continuations and skipped.

`real-db-only` is the right annotation for blocks that call `.all()`, `.execute()`,
`.stream()`, `.transaction()`, or any DDL helper. The CI job `test-docs-real-db`
runs these blocks against a real PostgreSQL instance (`ghcr.io/oorabona/postgres:18-alpine-full`).

## Real-DB mode

```bash
pnpm test:docs                 # generate + run (compile-only)
pnpm test:docs:generate        # just regenerate the *.test.ts files

# Real-DB mode (requires a running PostgreSQL instance):
DBSP_DOCTEST_REAL_DB=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/doctest \
  pnpm test:docs
```

## When CI fails

A failing doctest means the documentation example no longer matches the API.
Typical fixes:

1. **API changed, docs are stale** — update the doc block to use the current
   API. This is the common case and the whole point of this framework.

2. **Doc block depends on a live database** — annotate the block with
   `// doctest: real-db-only — <reason>` (if it uses standard schema tables) so
   it runs in the `test-docs-real-db` CI job. Use `// doctest: skip — <reason>`
   only for blocks that genuinely cannot execute even with a real DB
   (pseudo-code, non-standard tables, feature gaps).

3. **Expected documentation source cannot be read** — restore that source or
   repair its accessibility, then regenerate the doctest suites.
