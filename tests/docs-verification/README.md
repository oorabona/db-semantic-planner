# Docs verification (doctest)

Validates every TypeScript code block in project documentation against the real
`@dbsp/*` API surface, so users copy-pasting from docs get code that actually
compiles and executes.

## Scope

Scanned markdown sources (see `generate-tests.ts`):

- `README.md`
- `packages/*/README.md` (6 publishable packages)
- `packages/docs/index.md`, `patterns.md`, `comparison.md`, `roadmap.md`
- `packages/docs/guide/*.md`
- `packages/docs/api/*.md`
- `packages/docs/nql/*.md`

Total: 28 files, ~260 code blocks at the time of writing.

## How it works

1. `doctest.ts` parses markdown and extracts every `\`\`\`typescript` / `\`\`\`ts`
   block, capturing file path, line number, block index, and optional
   annotations (`// expected sql:`, `// expected params:`, `// doctest: skip`).

2. `generate-tests.ts` emits one `*.test.ts` per source bucket into
   `__generated__/` (gitignored). Each block becomes an `it(...)` so a single
   broken block does not abort other tests in the same file.

3. `runner.ts` evaluates a block by writing it to a scratch file inside
   `__generated__/.tmp/`, wrapping it in an async IIFE with every public
   `@dbsp` symbol pre-imported, then dynamic-importing it. Any parse error,
   type error, or runtime throw becomes a test failure with the original
   markdown file and line.

The runner mocks `pg.Pool` so blocks that allocate a Pool never open a real
network connection. Query execution paths (`.all()`, `.execute()`) rely on the
compile-only adapter throwing a clear error — doc authors should prefer
`.dump()` in examples to illustrate the SQL the planner produces.

## Running

```bash
pnpm test:docs                 # generate + run
pnpm test:docs:generate        # just regenerate the *.test.ts files
pnpm vitest run tests/docs-verification/__generated__/  # run the generated suite directly
```

## Annotations

Add these as comments inside a block to control how it's tested:

```typescript
// doctest: skip                              — skip this block entirely
// doctest: dry-run                           — compile/import only, no SQL assertion
// expected sql: SELECT "u".* FROM "users"…  — strict SQL match
// expected params: [1, "alice"]             — strict params match
```

Blocks that start with a `.methodName(...)` or a binary operator are auto-
detected as fragment continuations and skipped.

## When CI fails

A failing doctest means the documentation example no longer matches the API.
Two kinds of fixes:

1. **API changed, docs are stale** — update the doc block to use the current
   API. This is the common case and the whole point of this framework.

2. **Doc block depends on a live database** — convert the block to use
   `.dump()` (shows compiled SQL) instead of `.all()`/`.execute()`, or mark
   it `// doctest: skip` if the block intentionally demonstrates execution.
