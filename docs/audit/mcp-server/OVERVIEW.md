# mcp-server — Audit 2026-04-20

## Executive summary

`@dbsp/mcp-server` is a 518-LoC scaffold (3 impl files) intended to expose `@dbsp/core` to MCP clients (Claude/Cursor). The package is tagged at `1.0.0` and publishes CLI + library entry, but the audit surfaced a structural gap: the server registers **zero tools** (all `MCP-003…MCP-007b` are TODO comments), while the README advertises "Schema exposure / Query planning / Intent validation" as current features.

Beyond the scaffold/doc mismatch, the schema loader has exploitable security gaps (inverted path-traversal guard + opt-in `allowedRoots` + arbitrary dynamic `import()` of user-supplied paths) and the CLI layer crashes ungracefully on malformed flags.

## Scores

| Axis | Score | Notes |
|---|---|---|
| Architecture | 6/10 | Correct separation (loader / server / CLI) but scaffold is incomplete relative to its published version |
| Correctness | 5/10 | S-class path-traversal bypass + TOCTOU race + uncaught parseArgs throws |
| Security | 4/10 | RCE vector via unrestricted dynamic import; info leaks in error messages |
| Performance | 9/10 | N/A meaningful at this scale; cold-path only |
| Docs | 3/10 | README documents CLI form (`DBSP_SCHEMA=`) that the code never parses; features claimed are not implemented |
| Types | 6/10 | Shallow duck-check cast to `ResolvedSchema`; `exports["."]` points to CLI binary; version default diverges from package.json |

## Top-10 findings by priority

| # | Sev | File | Concern | Title |
|---|---|---|---|---|
| 1 | **S** | schema-loader.ts:89 | correctness/security | Path-traversal guard fires only when file is missing — existing `..`-traversed paths bypass the check |
| 2 | **S** | schema-loader.ts:166 | security/rce | `await import(fileUrl)` with opt-in `allowedRoots` — arbitrary JS execution on any file reachable by the process |
| 3 | **S** | index.ts:137 | correctness | `parseArgs` throws propagate uncaught — raw stack trace with no `process.exit(1)` for malformed CLI |
| 4 | **S** | README.md:24-25 | doc-coherence | Quick Start uses `DBSP_SCHEMA` env var that is never parsed — copy-paste from docs fails immediately |
| 5 | **S** | README.md:35 | doc-coherence | `npx` invocation form uses the same broken env var |
| 6 | M | schema-loader.ts:114 | security | `relativePath.startsWith('..')` rejects legitimate filenames like `..backup/schema.js` (codex-only) |
| 7 | M | schema-loader.ts:153 | security | TOCTOU: realpath is checked only when file pre-exists; symlink substitution between `validatePath` and `import()` escapes `allowedRoots` (codex-only) |
| 8 | M | schema-loader.ts:178 | type-safety | `schema as ResolvedSchema` — duck-check validates only `tables`/`relations`; arrays and objects missing `hints`/`conventions`/`indexes`/`defaultFilters` pass |
| 9 | M | index.ts:55 | correctness/ux | Unrecognised CLI flags silently dropped — typos surface as "required" errors |
| 10 | M | server.ts:46 | api-contract | Default version `'0.0.1'` diverges from `package.json` version `'1.0.0'` — MCP clients see the wrong value |

## PR plan

**Single PR `fix/audit-mcp-server-20260420`** (small scope, per-scope worklist, 1 branch, 6 thematic commits):

| # | Commit | Fixes | Scope |
|---|---|---|---|
| C1 | `fix(mcp-server): harden schema-loader path validation` | S1 S2 M10 M11 M13 L3 L4 | `validatePath` structural rewrite |
| C2 | `fix(mcp-server): CLI argument parsing + error propagation` | S3 M1 M2 | `parseArgs` + `main` |
| C3 | `fix(mcp-server): sanitize error messages and log points` | M4 M5 M6 | `SchemaLoadError` + `main` |
| C4 | `fix(mcp-server): version sync + library entry point` | M7 M9 L1 L5 | `package.json` exports, version import |
| C5 | `fix(mcp-server): deeper schema structure validation` | M8 | `validateSchemaStructure` |
| C6 | `docs(mcp-server): align README with scaffold state + remove dead context` | S4 S5 M3 M12 L2 | README + `server.ts` |

Total findings: **22** (5 S + 12 M + 5 L). Deferred L items go to TODO.md follow-up post-merge.

## Method signals

| Signal | Note |
|---|---|
| Cross-reviewer agreement | Path-traversal bypass (S1) flagged by all 3 sonnet concerns independently |
| Codex orthogonal finds | 3 new M findings that sonnet missed entirely: over-strict startsWith (M10), TOCTOU symlink race (M11), shallow-validation specific fields (strengthened M8) |
| Doc coherence | ROI surprisingly high — 2 S findings from a single 59-line README read |
