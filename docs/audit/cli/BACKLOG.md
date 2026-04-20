# CLI Package — Full Deduped Findings Backlog
> Generated: 2026-04-20 | 60 unique findings (14 S + 29 M + 17 L)
> C = Cost (1=trivial, 5=major rewrite) | I = Impact (1=cosmetic, 5=data loss/security) | R = Risk (1=safe, 5=breaks API)

## Cluster 1: migrate — lock integrity + split-transaction

- [ ] M1-S1 | S | `commands/migrate.ts:167` | SEC-1+EH-4+CC-3+CODEX-1 | sources: [security, errors, correctness, codex] | `acquireMigrationLock` uses pool (not dedicated client) — advisory lock released when connection returns to pool before `releaseMigrationLock`; concurrent apply runs can both believe they hold the lock | **C:3 I:5 R:4** | Fix: replace with `withMigrationLock` dedicated-client pattern already present; pass client to all inner calls
- [ ] M1-S2 | S | `commands/migrate.ts:226` | CODEX-1+CODEX-2 | sources: [codex] | `executeDdl` commits on its own client; `recordMigration` runs afterward on separate pooled query — crash between the two leaves DDL applied but migration still pending | **C:3 I:5 R:3** | Fix: wrap lock acquisition, DDL, version calc, and record insert in single transaction on one dedicated client
- [ ] M1-S3 | S | `commands/migrate.ts:374` | CODEX-2 | sources: [codex] | Same split-transaction on rollback: DOWN SQL committed, then `removeMigrationRecord` separate query — rollback applied but record stays | **C:3 I:5 R:3** | Fix: same pattern as M1-S2
- [ ] M1-S4 | S | `commands/migrate.ts:204` | CC-3+EH-4 | sources: [correctness, errors] | `process.exit(0)` in `--dry-run` path bypasses `finally` block containing `releaseMigrationLock` — advisory lock held until session timeout | **C:2 I:4 R:2** | Fix: replace internal `process.exit()` with `throw`; call exit only in outer catch
- [ ] M1-M1 | M | `commands/migrate.ts:248` | CODEX-3 | sources: [codex] | `finally` block cleanup (releaseMigrationLock, pool.end) unguarded — cleanup exception replaces original migration error | **C:2 I:3 R:2** | Fix: capture original error, wrap cleanup in try/catch, rethrow original
- [ ] M1-M2 | M | `commands/migrate.ts:292` | SEC-14 | sources: [security] | `rollbackCommand` uses `withMigrationLock` but ignores the passed `client`, using `pool` for all inner queries — re-introduces session lock drift for rollback path | **C:2 I:4 R:2** | Fix: thread `client` into `getAppliedMigrations`, `executeDdl`, `removeMigrationRecord`
- [ ] M1-M3 | M | `commands/migrate.ts:41` | SC-5 | sources: [solid] | 4 Commander callbacks repeat same `try { ... } finally { pool.end() }` shell (~30 lines each) | **C:2 I:2 R:1** | Fix: extract `withMigratePool<T>(url, fn)` lifecycle wrapper
- [ ] M1-M4 | M | `commands/migrate.ts:256` | SEC-9 | sources: [security] | `error.message` from pg may contain SQL fragments; emitted to stderr in shared CI | **C:1 I:2 R:1** | Fix: distinguish pg errors (check `error.code` SQLSTATE); emit sanitized message
- [ ] M1-M5 | M | `commands/migrate.ts:304+` | EH-8 | sources: [errors] | `rollbackCommand` has 6x `process.exit(1)` inside `withMigrationLock` callback, bypassing lock release | **C:2 I:4 R:2** | Fix: same as M1-S4 — throw instead of exit inside lock scope
- [ ] M1-L1 | L | `commands/migrate.ts:221` | CC-6 | sources: [correctness] | Statement count in success message includes comment-only lines; inflated display | **C:1 I:1 R:1** | Fix: use `statements.filter(...)` length, not `parsed.upStatements.length`
- [ ] M1-L2 | L | `commands/migrate.ts:292` | CC-12 | sources: [correctness] | `devCommand` has no `--dry-run` or `--json` options | **C:2 I:1 R:1** | Fix: add both options

---

## Cluster 2: batch — exit code semantics + continuation

- [ ] M2-S1 | S | `repl/batch.ts:406` | CODEX-6 | sources: [codex] | Assertion-present batch exits 0 even when queries failed; `results.some(r => !r.success)` ignored when `assertionSummary` exists | **C:2 I:5 R:3** | Fix: fail if any executable query failed regardless of assertion presence
- [ ] M2-S2 | S | `repl/batch.ts:317` | EH-3 | sources: [errors] | `process.exit(1)` in `runBatchMode` kills test runner; pool leaked in E2E tests | **C:2 I:4 R:2** | Fix: rethrow error; let entry point call exit
- [ ] M2-M1 | M | `repl/batch.ts:282` | CODEX-4 | sources: [codex] | Batch records synthetic "success" for continuation lines (`\` suffix) that emit no events — shifts assertion indexes | **C:3 I:3 R:3** | Fix: coalesce continuation lines before submission; only append result when a query actually emitted
- [ ] M2-M2 | M | `repl/batch.ts:176` | CODEX-5 | sources: [codex] | `.exit`/`.quit` inside batch input do not terminate execution; subsequent queries still run | **C:1 I:3 R:1** | Fix: treat `exit` as first-class batch result; break iteration
- [ ] M2-M3 | M | `repl/batch.ts:213` | CC-5+EH-6 | sources: [correctness, errors] | DB connection failure detected by `message.includes('Connection failed')` string match — fragile; silently misses errors | **C:1 I:4 R:2** | Fix: emit typed `init-error` event; check `event.type === 'init-error'` in executeBatch
- [ ] M2-M4 | M | `repl/batch.ts:313` | SC-6 | sources: [solid] | `runBatchMode` (CC=53) mixes text output, JSON output, assertion summary, and exit-code decision | **C:2 I:2 R:1** | Fix: extract `printTextResults`, `printAssertionSummary`, `resolveExitCode` helpers
- [ ] M2-M5 | M | `repl/batch.ts:321` | EH-11 | sources: [errors] | `--json` batch error emitted as plain text to stderr, breaking JSON consumers | **C:1 I:3 R:1** | Fix: `console.error(JSON.stringify({ error: message }))` when `--json`
- [ ] M2-L1 | L | `repl/batch.ts:332` | CC-14 | sources: [correctness] | Unknown dot commands in batch silently succeed (exit 0, empty output) | **C:1 I:2 R:1** | Fix: unknown-event fallback returns `success: false` when any error event was emitted
- [ ] M2-L2 | L | `repl/batch.ts:77` | SC-15 | sources: [solid] | `mapEventsToBatchResult` 8-handler for-loop inline; OCP violation | **C:2 I:1 R:1** | Fix: `Map<EventType, handler>` registry

---

## Cluster 3: csv — RFC 4180 parser rewrite

- [ ] M3-S1 | S | `repl/csv.ts:168` | CC-9+CODEX-7 | sources: [correctness, codex] | RFC 4180 multiline quoted fields silently truncated — readline splits before quote-state tracking; dump→load round-trips corrupt data | **C:4 I:5 R:2** | Fix: stateful CSV parser tracking quote state across readline events; document limitation if deferred
- [ ] M3-M1 | M | `repl/csv.ts:270` | CC-8+CODEX-8 | sources: [correctness, codex] | Rows with too many/few fields silently truncated/padded — no field-count validation per row | **C:2 I:4 R:1** | Fix: validate `fields.length === format.columns.length`; throw line-numbered parse error on mismatch
- [ ] M3-M2 | M | `repl/csv.ts:133` | CC-10+CODEX-9 | sources: [correctness, codex] | Header detection too aggressive: CSV with all-text short data rows drops first data row; leading blank lines cause header mis-skip | **C:2 I:4 R:1** | Fix: align blank-line normalization between sniffing and full parsing; improve heuristic with schema-column matching
- [ ] M3-M3 | M | `repl/csv.ts:181` | CODEX-10 | sources: [codex] | Malformed quoted rows accepted as valid: unterminated quotes or characters after closing quote not rejected | **C:2 I:3 R:1** | Fix: validate EOF-in-quote; reject non-separator trailing chars after quoted field
- [ ] M3-M4 | M | `repl/csv.ts:231` | CC-8 (TOCTOU) | sources: [correctness] | Double-read: sniff + full parse open same file twice; TOCTOU risk on busy filesystems | **C:2 I:2 R:1** | Fix: buffer first 10 lines, sniff format, continue same stream
- [ ] M3-L1 | L | `repl/csv.ts:330` | SEC-12 | sources: [security] | `escapeCsvField` doesn't quote `\r`-only values — violates RFC 4180 | **C:1 I:1 R:1** | Fix: add `|| value.includes('\r')` to quoting condition

---

## Cluster 4: dot-commands — SQL injection + path containment

- [ ] M4-S1 | S | `repl/dot-commands.ts:369` | SEC-2+CC-7 | sources: [security, correctness] | `.import` injects `state.schemaName` unsanitized into `SET search_path TO "..."` SQL — enables arbitrary SQL injection via `.use` | **C:1 I:5 R:2** | Fix: validate schemaName in `.use` handler with shared `validateIdentifier` utility; reject on failure
- [ ] M4-S2 | S | `repl/dot-commands.ts:462` | SEC-3+CC-7 | sources: [security, correctness] | `.load`/`.dump` tableName double-quoted but not validated — `"` or zero-width chars break context; column names from CSV headers unvalidated | **C:2 I:5 R:2** | Fix: validate tableName + each header column against identifier pattern before SQL use
- [ ] M4-S3 | S | `repl/dot-commands.ts:113` | SC-1 | sources: [solid] | `processDotCommand` 444-line god switch (CC=113) — largest SRP violation in package | **C:5 I:2 R:3** | Fix: command-registry map `{ handler: (arg, state, schema) => Promise<DotCommandResult> }`; each command ≤30 lines in `handlers/`
- [ ] M4-M1 | M | `repl/dot-commands.ts:356` | SEC-6 | sources: [security] | `.import`/`.load`/`.dump` path not containment-checked — accepts `../../etc/passwd` | **C:1 I:3 R:1** | Fix: warn if resolved path escapes cwd; optionally restrict to `.sql`/`.csv` extensions
- [ ] M4-M2 | M | `repl/dot-commands.ts:170` | SC-11 | sources: [solid] | `.exec`/`.explain`/`.parse` each repeat same 15-line boolean-toggle pattern | **C:1 I:1 R:1** | Fix: extract `handleBooleanToggle(arg, key, label, state)`
- [ ] M4-L1 | L | `repl/dot-commands.ts:113` | CC-13 | sources: [correctness] | `.help` text missing `.natural` and `.sql` commands | **C:1 I:1 R:1** | Fix: add rows to .help string
- [ ] M4-L2 | L | `repl/dot-commands.ts:124` | SEC-15 | sources: [security] | Null bytes in `arg` not stripped before path comparisons | **C:1 I:1 R:1** | Fix: `arg.replace(/\0/g, '')`

---

## Cluster 5: schema-codegen — defaults + FK round-trip

- [ ] M5-S1 | S | `generators/schema-codegen.ts:91` | CODEX-11 | sources: [codex] | SQL defaults serialized as `[object Object]` — generates invalid TS; introspect → codegen → migrate broken | **C:3 I:5 R:3** | Fix: serialize by type: `{ sql: <escaped> }` for SQL defaults, `JSON.stringify()` for strings, preserve numbers/booleans/null
- [ ] M5-M1 | M | `generators/schema-codegen.ts:211` | CODEX-12 | sources: [codex] | FK `onUpdate` behavior lost in generated schema — `fkInfo` projection never carries `onUpdate` | **C:2 I:3 R:2** | Fix: add `onUpdate` to projected FK info; emit `onUpdate: '...'` in `generateRefCode()`
- [ ] M5-M2 | M | `generators/schema-codegen.ts:58` | CODEX-13 | sources: [codex] | FK columns that are also PKs lose PK semantics — `generateColumnCode` routes FK to `generateRefCode` early-return, skipping `isPrimaryKey` | **C:2 I:4 R:2** | Fix: emit PK-preserving representation for FK columns, or fail loudly
- [ ] M5-M3 | M | `generators/schema-codegen.ts:93` | CODEX-14 | sources: [codex] | String defaults with quotes/backslashes/newlines generate invalid TS — raw strings wrapped in single quotes without escaping | **C:1 I:4 R:2** | Fix: use `JSON.stringify()` when emitting string defaults

---

## Cluster 6: repl-engine — safety + refactor hotspots

- [ ] M6-S1 | S | `repl/engine/repl-engine.ts:643` | EH-1 | sources: [errors] | `handleRawSql` has no try/catch — DB errors crash REPL session instead of emitting query-error event | **C:1 I:5 R:1** | Fix: wrap `executeRaw` in try/catch; emit `{ type: 'query-result', result: { error: message } }` on failure
- [ ] M6-S2 | S | `repl/engine/repl-engine.ts:56` | CC-4 | sources: [correctness] | `isInsideStringLiteral` off-by-one: mutations ending in `'val'!` never execute; silently treated as dry-run | **C:2 I:5 R:2** | Fix: fix loop bounds to correctly handle quote at `length-2`; add regression tests
- [ ] M6-S3 | S | `repl/engine/repl-engine.ts:247` | SC-2 | sources: [solid] | Second 261-line god switch (CC=91) in `ReplEngine.processDotCommand` duplicating dot-commands.ts dispatcher | **C:4 I:2 R:3** | Fix: extract each case to private `handle*` method ≤30 lines
- [ ] M6-M1 | M | `repl/engine/repl-engine.ts:513` | SC-3 | sources: [solid] | `handleTableConfig` 103-line if-chain (CC=52) — 4 identical show/validate/apply blocks for borders/overflow/headers/padding | **C:2 I:1 R:1** | Fix: model as option-map; loop once
- [ ] M6-M2 | M | `repl/engine/repl-engine.ts:658` | SC-4 | sources: [solid] | `handleNql` 157-line function (CC=45) — inline 80-line `QueryResult` construction interleaved with execution control | **C:2 I:2 R:1** | Fix: extract `buildQueryResult(...)` and `shouldExecuteQuery(...)` pure helpers
- [ ] M6-M3 | M | `repl/engine/repl-engine.ts:113` | EH-6+EH-9 | sources: [errors] | `init()` emits generic 'error' event for connection failure; no `emitStateChange()` after `connected = false` | **C:1 I:2 R:1** | Fix: emit typed `init-error` event; call `emitStateChange()` in catch
- [ ] M6-M4 | M | `repl/engine/repl-engine.ts:460` | SC-9 | sources: [solid] | 8-field manual projection `EngineState → BatchState` — no compile-time safety when fields are added | **C:2 I:2 R:2** | Fix: `toBatchState()` method + `applyBatchStateChange()` method on `ReplEngine`
- [ ] M6-L1 | L | `repl/engine/repl-engine.ts:70` | SC-14 | sources: [solid] | Wide public API exposes `getCompletionProvider()`, `getSchema()` etc. — ISP violation | **C:2 I:1 R:2** | Fix: define `ReplEnginePublicAPI` interface; expose only `submit`/`on`/`getState`/`init`/`destroy`
- [ ] M6-L2 | L | `repl/engine/repl-engine.ts:805` | EH-15 | sources: [errors] | `handleNql` catch drops stack trace; no `--debug` / `DEBUG=dbsp` escape hatch | **C:1 I:1 R:1** | Fix: include full stack when `DEBUG=dbsp` or `--debug` set

---

## Cluster 7: cross-cutting — --json error paths + process.exit scope

- [ ] M7-S1 | S | `commands/repl.ts:144` | EH-2 | sources: [errors] | `readFileSync(--input)` outside try/catch — ENOENT prints raw stack trace | **C:1 I:3 R:1** | Fix: move inside try block or add own try/catch with friendly message
- [ ] M7-M1 | M | `commands/push.ts:175` | CC-2+EH-7 | sources: [correctness, errors] | Error in catch always plain text — ignores `--json` flag; breaks JSON consumers | **C:1 I:4 R:1** | Fix: if `options.json`, emit `{ error, status: 'error' }` JSON; same in `verify.ts:92`, `introspect.ts:114`
- [ ] M7-M2 | M | `commands/push.ts:83` | CC-1 | sources: [correctness] | `--drop --json` exits 0 with empty stdout — no JSON success output in drop path | **C:1 I:3 R:1** | Fix: add JSON emission block after `executeDdl` in drop branch matching additive branch (lines 150-159)
- [ ] M7-M3 | M | `commands/push.ts:75` | CC-11 | sources: [correctness] | Greedy `.*` in DROP TABLE filter regex: `DROP TABLE "migrations","users"` may filter both or miss migrations table depending on ordering | **C:2 I:4 R:2** | Fix: token-based check or non-greedy pattern with anchors
- [ ] M7-M4 | M | `commands/push.ts:73` | SEC-7 | sources: [security] | `MIGRATIONS_TABLE` interpolated into `RegExp` without escaping — future values with special chars would silently fail the filter | **C:1 I:2 R:1** | Fix: `MIGRATIONS_TABLE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')`
- [ ] M7-M5 | M | `commands/generate.ts:147` | EH-10 | sources: [errors] | `process.exit(1)` inside try for manifest/kysely branches — outer catch unreachable; confusing control flow | **C:1 I:1 R:1** | Fix: throw `UserError`; handle exit in outer catch
- [ ] M7-M6 | M | `index.ts:31` | CC-15 | sources: [correctness] | Commander parse errors always plain text — no JSON fallback when `--json` passed to subcommand | **C:2 I:2 R:1** | Fix: `program.exitOverride()` + try/catch; emit JSON error if `--json` in `process.argv`
- [ ] M7-M7 | M | `utils/db-utils.ts:43` | SEC-4 | sources: [security] | `redactDbUrl` regex fails on encoded passwords (`%40`) or `user:pass@host:port` patterns | **C:1 I:3 R:1** | Fix: use WHATWG `URL` API; fall back to regex for non-URL strings
- [ ] M7-M8 | M | `utils/db-utils.ts:25` | EH-5 | sources: [errors] | Pool construction errors caught alongside import errors; always shows "pg not installed" message | **C:1 I:2 R:1** | Fix: catch only import error for that message; rethrow Pool errors with original message
- [ ] M7-M9 | M | `utils/schema-loader.ts:95` | SEC-8 | sources: [security] | `import(fileUrl)` on arbitrary path — no cwd containment check; code injection risk | **C:1 I:4 R:1** | Fix: validate `resolvedPath.startsWith(cwd + '/')` before import
- [ ] M7-L1 | L | `repl/history.ts:11` | SEC-5 | sources: [security] | History file created with default umask (0644) — world-readable on Linux | **C:1 I:2 R:1** | Fix: `mode: 0o600` in `writeFileSync`; `chmodSync` on existing file
- [ ] M7-L2 | L | `repl/history.ts:56` | SEC-13 | sources: [security] | Batch mode queries persisted to history unconditionally | **C:1 I:1 R:1** | Fix: `persist: boolean` option in `CommandHistory.add()`; pass `persist: false` from batch paths
- [ ] M7-L3 | L | `repl/db-connection.ts:167` | SC-7 | sources: [solid] | `commitTransaction`/`rollbackTransaction` structural clones | **C:1 I:1 R:1** | Fix: extract `runTransactionControl(sql: 'COMMIT' | 'ROLLBACK')`
- [ ] M7-L4 | L | `utils/schema-loader.ts:32` | SC-8 | sources: [solid] | `isValidSchema` duplicated in `cli` and `gui/sidecar` (similarity=1.0) | **C:1 I:1 R:2** | Fix: move to `packages/types`
- [ ] M7-L5 | L | `commands/repl.ts:144` | EH-12 | sources: [errors] | `introspect.ts` catch format: `❌ <msg>` instead of `❌ Error: <msg>` — inconsistent | **C:1 I:1 R:1** | Fix: standardize format across all CLI catch blocks
- [ ] M7-L6 | L | `utils/schema-loader.ts:130` | EH-13 | sources: [errors] | tsx hint triggered by `message.includes('Cannot find module')` — fragile if Node changes message | **C:1 I:1 R:1** | Fix: add `err.code === 'ERR_MODULE_NOT_FOUND'` as secondary check
- [ ] M7-L7 | L | `commands/push.ts:139` | EH-14 | sources: [errors] | `process.exit(0)` in try while holding pool — `finally` cleanup may not run | **C:1 I:1 R:1** | Fix: return early; await `pool.end()` before exit

---

## Cluster 8: docs — CLI_USAGE sync + stale examples

- [ ] M8-S1 | S | `docs/CLI_USAGE.md:29` | DOC-1 | sources: [docs] | Commands table omits `push` and `migrate` entirely | **C:2 I:3 R:1** | Fix: add rows to commands table
- [ ] M8-S2 | S | `docs/CLI_USAGE.md:46+360` | DOC-2+DOC-3 | sources: [docs] | `manifest` target listed as valid; CI example uses it; runtime → exit(1) | **C:1 I:3 R:1** | Fix: remove manifest row; update CI example to `generate ddl`
- [ ] M8-M1 | M | `docs/CLI_USAGE.md:1` | DOC-7 | sources: [docs] | `push` command entirely absent | **C:3 I:3 R:1** | Fix: add full section with flags and examples
- [ ] M8-M2 | M | `docs/CLI_USAGE.md:1` | DOC-8 | sources: [docs] | `migrate` command entirely absent | **C:3 I:3 R:1** | Fix: add section for dev/apply/rollback/status
- [ ] M8-M3 | M | `docs/CLI_USAGE.md:57` | DOC-4 | sources: [docs] | `--dialect` claims multi-dialect support; code warns only postgresql | **C:1 I:2 R:1** | Fix: update description to reflect only-postgresql reality
- [ ] M8-M4 | M | `docs/CLI_USAGE.md:295` | DOC-5 | sources: [docs] | `verify --json` undocumented | **C:1 I:1 R:1** | Fix: add flag row
- [ ] M8-M5 | M | `docs/CLI_USAGE.md:263` | DOC-6 | sources: [docs] | `introspect --db-casing` undocumented | **C:1 I:1 R:1** | Fix: add flag row
- [ ] M8-M6 | M | `packages/cli/README.md:42` | DOC-10 | sources: [docs] | `dbsp batch` listed as top-level command; doesn't exist | **C:1 I:2 R:1** | Fix: remove row; add note about `repl --eval/--input`
- [ ] M8-M7 | M | `packages/cli/README.md:30` | DOC-9 | sources: [docs] | Quick-start example uses removed `generate manifest` target | **C:1 I:2 R:1** | Fix: replace with `generate ddl`
- [ ] M8-M8 | M | `docs/CLI_USAGE.md:135` | DOC-11 | sources: [docs] | `.sql` described as "Toggle SQL output" — wrong | **C:1 I:1 R:1** | Fix: "Switch input to raw SQL mode (vs NQL mode)"
- [ ] M8-L1 | L | `docs/CLI_USAGE.md:91` | DOC-12 | sources: [docs] | `--parse`, `--exec`, `-c/--config` REPL flags undocumented | **C:1 I:1 R:1** | Fix: add three rows to REPL Options table
- [ ] M8-L2 | L | `docs/CLI_USAGE.md:145` | DOC-15 | sources: [docs] | `.parse [on|off]` dot-command absent from docs | **C:1 I:1 R:1** | Fix: add row
- [ ] M8-L3 | L | `docs/CLI_USAGE.md:56` | DOC-14 | sources: [docs] | `--output` alias for `--out` not documented | **C:1 I:1 R:1** | Fix: update flag row

---

## Cluster 9: other / repl miscellaneous

- [ ] M9-M1 | M | `repl/completion.ts:355` | SC-10 | sources: [solid] | `CompletionProvider` mixes schema indexing, input parsing, completion generation, result filtering (SRP) | **C:3 I:1 R:2** | Fix: extract `parseCompletionContext` as module-level pure function; `buildSchemaIndex` factory
- [ ] M9-M2 | M | `repl/db-connection.ts:78` | SEC-10 | sources: [security] | Connection error `message` may include pg host/DSN details; propagates to batch output | **C:1 I:2 R:1** | Fix: apply `redactDbUrl()` to error message before rethrowing
- [ ] M9-M3 | M | `repl/dot-commands.ts:459` | SEC-11 | sources: [security] | No upper bound on CSV columns/rows in `.load` — 10K columns × 100K rows → memory exhaustion or pg $65535 limit crash | **C:1 I:2 R:1** | Fix: max column count guard (500); validate `cols × batch ≤ 65535`
- [ ] M9-L1 | L | `repl/output-formatter.ts:43` | SC-13 | sources: [solid] | `formatAsTable`/`formatAsCsv` shared 4-line preamble duplicated | **C:1 I:1 R:1** | Fix: extract `prepareRowData(rows, columns)`
- [ ] M9-L2 | L | `repl/batch.ts:190` | SC-12 | sources: [solid] | `executeBatch` inlines assertion parsing + validation + query-index filtering in same function | **C:2 I:1 R:1** | Fix: extract `loadAndValidateAssertions` and `filterExecutableResults` pure helpers

---

## PR Bundling Proposal

**Recommendation: Single PR `fix/audit-cli-20260420` with 8 thematic commits** (see OVERVIEW.md for LoC estimates).

If team throughput requires splitting:
- **PR-A** (commits 1+2+7): `migrate` + `batch` + cross-cutting — security/correctness core
- **PR-B** (commits 3+4+6): `csv` + `dot-commands` + `repl-engine` — parser + injection + refactor
- **PR-C** (commits 5+8): `schema-codegen` + `docs` — generation quality + knowledge sync
