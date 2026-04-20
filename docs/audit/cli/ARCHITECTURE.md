# CLI Package — Architecture Audit
> Generated: 2026-04-20

## Layer Diagram

```mermaid
graph TD
    subgraph "CLI Entry (packages/cli/src)"
        idx[index.ts\nCommander setup]
    end

    subgraph "Commands (commands/)"
        repl_cmd[repl.ts]
        gen_cmd[generate.ts]
        intr_cmd[introspect.ts]
        push_cmd[push.ts]
        mig_cmd[migrate.ts]
        ver_cmd[verify.ts]
    end

    subgraph "REPL Engine (repl/engine/)"
        re[repl-engine.ts\nCC=113+91+52+45\n745 lines total]
    end

    subgraph "Dot Commands (repl/)"
        dc[dot-commands.ts\nprocessDotCommand CC=113\n444-line god-switch]
        batch[batch.ts\nexecuteBatch + runBatchMode\nCC=53]
        csv[csv.ts\nparseCsvFile / parseCsvLine\nRFC 4180 incomplete]
        hist[history.ts]
        comp[completion.ts\n268 lines]
        dbconn[db-connection.ts]
        outfmt[output-formatter.ts]
    end

    subgraph "Generators (generators/)"
        codegen[schema-codegen.ts\ndefault + FK bugs]
    end

    subgraph "Utils (utils/)"
        dbutil[db-utils.ts\nredactDbUrl]
        schemal[schema-loader.ts\ndynamic import]
    end

    subgraph "External"
        core[@dbsp/core\nPlanner + DX layer]
        pgsql[@dbsp/adapter-pgsql\nSQL compiler]
        pg[pg Pool]
    end

    idx --> repl_cmd & gen_cmd & intr_cmd & push_cmd & mig_cmd & ver_cmd
    repl_cmd --> re
    re --> dc
    re --> batch
    batch --> csv
    re --> hist
    re --> comp
    re --> dbconn
    re --> outfmt
    gen_cmd --> codegen
    intr_cmd --> pgsql
    push_cmd --> pgsql
    mig_cmd --> dbutil
    dbconn --> pg
    mig_cmd --> pg
    push_cmd --> core
    re --> core
    schemal -.->|dynamic import| core
```

### Structural Problems

1. **Two god-switch dispatchers** (SC-1 + SC-2): `dot-commands.ts:processDotCommand` (CC=113) and `repl-engine.ts:processDotCommand` (CC=91) implement overlapping command-dispatch logic independently.
2. **Missing command registry**: No `CommandRegistry` abstraction — adding a new dot command requires editing two switch statements.
3. **State projection coupling** (SC-9): `ReplEngine` manually copies 8 fields to build `BatchState` before delegating to `dot-commands.ts`, with no compile-time guarantee the projection stays in sync.

---

## Error Handling Classification

### process.exit() Sites

| File | Line(s) | Context | Problem |
|------|---------|---------|---------|
| `commands/migrate.ts` | 179, 195, 204, 212 | Inside `acquireMigrationLock` scope | Bypasses `finally` → lock leaks (S) |
| `commands/migrate.ts` | 304, 320, 331, 345, 357, 368 | Inside `withMigrationLock` callback | Same bypass via callback (S) |
| `commands/push.ts` | 139 | Inside try, holds pool | `pool.end()` in finally may not run |
| `commands/generate.ts` | 147 | Inside try (manifest/kysely branches) | Outer catch unreachable for those branches |
| `repl/batch.ts` | 317 | `runBatchMode` error path | Kills test runner in E2E tests (S) |
| Multiple commands | Various | `--dry-run` success paths | `process.exit(0)` inside try, skips finally |

### try/catch Coverage Gaps

| File | Gap | Severity |
|------|-----|---------|
| `repl/engine/repl-engine.ts:643` | `handleRawSql` — `executeRaw()` unguarded | S |
| `commands/repl.ts:144` | `readFileSync(--input)` outside try | S |
| `commands/migrate.ts:248` | cleanup in `finally` unguarded — masks original error | M |
| `utils/db-utils.ts:25` | catches both import error + Pool construction error with same message | M |
| `repl/engine/repl-engine.ts:120` | init error: no `emitStateChange()` after `connected = false` | M |

### JSON Mode / stderr Inconsistencies

| File | Issue |
|------|-------|
| `commands/push.ts:175` | Error always to `console.error`, never JSON |
| `commands/verify.ts:92` | Same — `--json` flag but plain-text errors |
| `commands/introspect.ts:114` | Same |
| `repl/batch.ts:321` | `--json` batch error to plain stderr |
| `index.ts:31` | Commander parse error always plain text, no JSON fallback |

---

## Consumer Map

| Consumer | Imports | Notes |
|----------|---------|-------|
| `commands/repl.ts` | `ReplEngine`, `CompletionProvider` | Entry for interactive + batch modes |
| `repl/batch.ts` | `ReplEngine`, `parseCsvFile` | Batch execution + CSV import |
| `repl/engine/repl-engine.ts` | `processDotCommand`, `db-connection`, `completion`, `output-formatter`, `history` | Central hub — 745 lines |
| `commands/migrate.ts` | `pg.Pool` directly | No adapter abstraction; advisory lock via raw pool |
| `commands/push.ts` | `@dbsp/core`, `@dbsp/adapter-pgsql` | Schema push + DDL diff |
| `generators/schema-codegen.ts` | `@dbsp/types` | Codegen for introspect output |
| E2E tests | `executeBatch` (direct import) | `process.exit` in `runBatchMode` kills test runner (EH-3) |
