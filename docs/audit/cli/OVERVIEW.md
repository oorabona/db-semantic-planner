# CLI Package Audit — Executive Overview
> Generated: 2026-04-20 | Sources: 5 Sonnet concerns + Codex xhigh | Phase: 2 (consolidation)

## Scores

| Dimension | Score | Justification |
|-----------|-------|---------------|
| Architecture | 5/10 | Two god-switch dispatchers (CC=113 + CC=91), no command registry; clear SRP failures at every layer |
| Correctness | 6/10 | Four S-class logic bugs: lock-bypass dry-run exits, `isInsideStringLiteral` off-by-one, CSV multiline, batch assertion-only exit-0 |
| Security | 5/10 | SQL injection via unvalidated schemaName + tableName; advisory-lock race on apply; code injection via dynamic import of arbitrary schema path |
| Performance | 8/10 | No hot paths; CSV double-read is a minor concern; no N+1 patterns found |
| Docs | 3/10 | push + migrate entirely absent; manifest target documented after removal; dialect claims false; 7+ flag drift items |
| Types | 7/10 | Strict mode on; main gaps are event-type union narrowing and `PoolClient | Pool` threading in migrate |

---

## Top-10 Priority Findings

| # | ID | Sev | File | Summary |
|---|-----|-----|------|---------|
| 1 | SEC-1 + EH-4 + CC-3 + CODEX-1/2 | **S** | `commands/migrate.ts:167` | Advisory lock held on pool (not dedicated client) + process.exit inside lock scope bypasses finally → lock leaks; DDL committed before migration record → split-transaction corruption |
| 2 | CODEX-6 + batch exit | **S** | `repl/batch.ts:406` | Assertion-present batch exits 0 even when queries failed; query failures are completely ignored |
| 3 | CC-4 | **S** | `repl/engine/repl-engine.ts:56` | `isInsideStringLiteral` off-by-one: mutations ending in `'val'!` never execute; silently dropped |
| 4 | EH-1 | **S** | `repl/engine/repl-engine.ts:643` | `handleRawSql` has no try/catch; DB errors crash REPL session entirely |
| 5 | SEC-2 + CC-7 | **S** | `repl/dot-commands.ts:369` | `.import` injects unvalidated `schemaName` into `SET search_path` SQL — arbitrary SQL injection |
| 6 | CODEX-11 | **S** | `generators/schema-codegen.ts:91` | `[object Object]` in generated TS for SQL defaults; round-trip from introspect → codegen → migrate is broken |
| 7 | CC-9 + CODEX-7 | **S** | `repl/csv.ts:168` | RFC 4180 multiline CSV fields silently truncated; `.dump` → `.load` round-trips corrupt data |
| 8 | SEC-3 | **S** | `repl/dot-commands.ts:462` | `.load`/`.dump` tableName not validated; double-quote escape allows SQL injection |
| 9 | EH-2 | **S** | `commands/repl.ts:144` | `readFileSync` for `--input` is outside try/catch; raw stack trace instead of friendly error |
| 10 | EH-3 | **S** | `repl/batch.ts:317` | `process.exit(1)` in `runBatchMode` kills test runner; pool leaked in E2E tests |

---

## PR Bundling Recommendation

**Estimated total LoC changed: ~400–600 lines across 12 files.**

### Option A — Single PR, 8 thematic commits (RECOMMENDED)

All changes are in the `packages/cli` scope with no cross-package API changes (except SC-8 `isValidSchema` move to `packages/types`). A single PR keeps Copilot context unified and prevents partial states where commit 4 depends on identifiers introduced in commit 2.

| Commit | Theme | Approx LoC | Files |
|--------|-------|-----------|-------|
| 1 | migrate: lock integrity + split-transaction | ~80 | `commands/migrate.ts` |
| 2 | batch: exit code semantics + continuation | ~60 | `repl/batch.ts` |
| 3 | csv: RFC 4180 parser rewrite | ~120 | `repl/csv.ts` |
| 4 | dot-commands: SQL injection + path containment | ~40 | `repl/dot-commands.ts` |
| 5 | schema-codegen: defaults + FK round-trip | ~80 | `generators/schema-codegen.ts` |
| 6 | repl-engine: handleRawSql catch + refactor | ~60 | `repl/engine/repl-engine.ts` |
| 7 | cross-cutting: --json error paths + process.exit scope | ~50 | `commands/push.ts`, `commands/repl.ts`, `commands/generate.ts` |
| 8 | docs: CLI_USAGE sync + README fixes | ~80 | `docs/CLI_USAGE.md`, `packages/cli/README.md` |

### Option B — 3 sub-PRs (use only if team size > 3 reviewers working in parallel)

- PR-A: migrate + batch + cross-cutting (commit 1, 2, 7) — pure correctness/security
- PR-B: csv + dot-commands + repl-engine (commit 3, 4, 6) — parser + injection
- PR-C: schema-codegen + docs (commit 5, 8) — generation quality

Option B increases merge coordination cost. Recommend Option A.

---

## Dedup Summary

- Raw: 17 S + 37 M + 21 L = 75 findings across 6 sources
- After dedup: **14 S + 29 M + 17 L = 60 unique findings**
- Collapsed families: 5 (migrate-lock, dot-schemaName-injection, dot-tableName-injection, csv-multiline, csv-header)
- High-confidence (2+ sources): 8 findings
