# mcp-server — Audit backlog 2026-04-20

Total findings: **22** (5 S + 12 M + 5 L). Sources: 3 parallel sonnet concerns (SOLID/correctness, security, API+types+docs) + 1 codex xhigh orthogonal pass. Dedupe key: `(file:line, issue class)`. `src:` tag shows which reviewers flagged each item.

## S — must fix

| # | File:Line | Title | Fix | Src |
|---|---|---|---|---|
| S1 | schema-loader.ts:89 | Path-traversal guard gated on `!existsSync(resolvedPath)` — existing `..`-traversed paths bypass | Remove `!existsSync` gate; reject unconditionally on raw input `includes('..')` OR rely solely on mandatory `allowedRoots` containment | solid+sec+api |
| S2 | schema-loader.ts:166 | `await import(fileUrl)` with opt-in `allowedRoots` — arbitrary RCE on any reachable `.js`/`.mjs` | Default `allowedRoots` to `[process.cwd()]`, emit stderr warning when opted out; add extension allow-list (`.js`/`.mjs`/`.cjs`/`.ts`) | sec |
| S3 | index.ts:137 | `parseArgs` throws propagate uncaught — raw stack, no `process.exit(1)` | Move `parseArgs` inside `main()`'s try/catch; handle `Error` → clean usage message + exit 1 | solid+codex |
| S4 | README.md:24-25 | Quick Start uses `DBSP_SCHEMA` env var that code never parses | Replace env-var block with `"args": ["./node_modules/@dbsp/mcp-server/dist/index.js", "--schema", "./dbsp.schema.ts"]` | api |
| S5 | README.md:35 | `npx` invocation also uses `DBSP_SCHEMA` env var | Replace with `npx dbsp-mcp --schema ./dbsp.schema.ts` | api |

## M — design / correctness smells

| # | File:Line | Title | Fix | Src |
|---|---|---|---|---|
| M1 | index.ts:55 | Unrecognised CLI flags silently dropped — `--shema` typo hidden | Add `else` branch → throw `Unknown argument: <flag>` with usage hint | solid+api |
| M2 | index.ts:31 | `parseArgs` cognitive complexity 51 — dual `=` / space syntax duplicated | Normalize `--foo=bar` → `['--foo','bar']` pre-loop; halves branches | solid |
| M3 | server.ts:51 | `serverContext` dead scaffolding — built but nothing reads it | Either remove until tools exist, OR register a minimal `schema_info` tool that reads it (scope-check: feature creep) — recommend remove + comment | solid |
| M4 | schema-loader.ts:183 | `loadSchema` catch re-wraps error without preserving original stack | Extend `SchemaLoadError` constructor to accept `{ cause }` option; pass `cause: error` | solid |
| M5 | schema-loader.ts:192 | Raw `error.message` from dynamic import forwarded — leaks absolute paths | Sanitize: replace absolute paths with basename; cap length | sec |
| M6 | index.ts:153 | Raw `args.schemaPath` logged before validation — leaks pre-normalization input | Move log to after `loadSchema` returns; log `resolvedPath` | sec |
| M7 | server.ts:46 | Default `version = '0.0.1'` diverges from package.json `1.0.0` | `import pkg from '../package.json' with { type: 'json' }`; default `version = pkg.version` | api |
| M8 | schema-loader.ts:178, 217 | Duck-check validates only `tables`/`relations` as objects; arrays pass; missing `hints`/`conventions`/`indexes`/`defaultFilters` pass | Expand `validateSchemaStructure`: reject arrays explicitly; verify presence + shape of all required `ResolvedSchema` fields | api+codex |
| M9 | package.json:33-38 | `exports["."]` points to CLI binary — library import gets shebang module | Add `src/api.ts` re-exports; point `exports["."]` at its dist output; keep `bin` → `dist/index.js` | api |
| M10 | schema-loader.ts:114 | `relativePath.startsWith('..')` rejects legitimate `..backup/schema.js` | Use separator-aware check: `relativePath === '..' \|\| relativePath.startsWith('..' + path.sep)` | codex |
| M11 | schema-loader.ts:153 | TOCTOU: realpath only when pre-existing; symlink substitution between validate and import escapes `allowedRoots` | After `existsSync` re-check in `loadSchema`, re-resolve `realpathSync` and re-run containment immediately before `import()`; import the canonical path | codex |
| M12 | server.ts:46 + README.md:38-45 | Zero MCP tools registered, but README advertises "Schema exposure / Query planning / Intent validation" | README: reclassify features as **Planned**, add "⚠️ Status: pre-release scaffold" banner until tools ship. Do NOT implement tools in this audit (scope creep) | api |
| M13 | schema-loader.ts:87 | `allowedRoots` is optional — path traversal protection opt-in | Folded into S2 fix (default to `[process.cwd()]`) | sec |

## L — defer or bundle

| # | File:Line | Title | Disposition |
|---|---|---|---|
| L1 | schema-loader.ts:23, server.ts | Exported types (`SchemaLoaderOptions`, `SchemaLoaderResult`, `McpServerOptions`) never imported externally | Re-export via `src/api.ts` (part of M9 fix) OR unexport if kept package-private |
| L2 | server.ts:65-70 | `console.error` advertises table/relation counts before any tool is registered | Remove or rewrite to "Schema loaded (N tables, M relations) — tools pending registration" |
| L3 | schema-loader.ts:97 | `allowedRoots` entries not validated for `..` sequences | Loop: reject any root with `..` post-normalize |
| L4 | schema-loader.ts:121 | `relativePath === ''` exclusion undocumented | Add one-line comment explaining directory-root semantics |
| L5 | schema-loader.ts:217 | `validateSchemaStructure` is unexported — downstream consumers can't call | Export as `validateResolvedSchema` via `src/api.ts` (M9 fix) |

## Improvement axes (non-findings — future work)

- **Register at least one MCP tool** — `schema_info` or `list_tables` — before claiming 1.0.0. Out of audit scope; file as feature TODO.
- **Integration test against Claude Desktop config** — verify end-to-end that an MCP client can connect. Out of scope.
- **Sandboxed schema loading** — consider running the dynamic `import()` in a worker with restricted globals. Defer to a future security hardening pass.

## PR bundling

6 thematic commits in a single PR (`fix/audit-mcp-server-20260420`):

- [ ] C1 path validation — S1 S2 M10 M11 M13 L3 L4
- [ ] C2 CLI hardening — S3 M1 M2
- [ ] C3 error sanitization — M4 M5 M6
- [ ] C4 package surface — M7 M9 L1 L5
- [ ] C5 schema validation depth — M8
- [ ] C6 docs + scaffold truth — S4 S5 M3 M12 L2

## Round tracking (to be updated in Phase 3)

- [ ] Implementer R1 — 6 commits scoped
- [ ] Pre-PR senior review
- [ ] (pre-push codex gate NOT required — Phase 1 ran full codex pass)
- [ ] Copilot R1
- [ ] Copilot R2 (if needed)
- [ ] Copilot R3 / cap escalation (if needed)
- [ ] Merge

## Calibration

| Signal | Value |
|---|---|
| Total raw findings (pre-dedupe) | 28 (sonnet 24 + codex 4) |
| Cross-confirmed findings | 3 (S1 × 3, S3 × 2, M8 × 2) |
| Codex-only new findings | 3 (M10, M11, strengthened M8) |
| Sonnet-only findings | 18 |
| Dedupe reduction | 28 → 22 (21% redundancy, lower than PR #50 cli's 40% — reflects small surface + distinct concerns) |
