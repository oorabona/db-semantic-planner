# db-semantic-planner TODO

> Consolidated 2026-02-05 from BACKLOG*.md + audit findings + legacy TODOs

## In Progress

- [ ] 🟡 **GUI-026** [GUI] Dirty tab confirmation + session persistence + app close guard — Priority: P1
  - [ ] GUI-026a: Confirm before closing dirty tab (call confirmUnsavedChanges)
  - [ ] GUI-026b: Confirm before closing app with dirty tabs (Tauri window close event)
  - [ ] GUI-026c: Persist editor tabs across sessions (Zustand persist middleware)

(GUI-025 archived → docs/historic/done-2026-02.md)

(Archived → docs/historic/done-2026-02.md)

---

## P0 — Core Features Required by astix ORM Migration (2026-03-15)

> Blockers identified from astix ORM migration re-assessment (72 `executeRaw` calls, 12 files).
> Spec: `astix/docs/plans/migrate-raw-sql-to-dbsp.md § Re-Assessment (2026-03-15)`

(DX-050 archived → docs/historic/done-2026-03.md)
- [ ] 🔧 **CTE-001** [Adapter] WITH RECURSIVE implementation — `compileRecursive()` in PgsqlAdapter. RFC-001 stub exists but Phase 2 not implemented. Blocks 10 CTE/recursive query migrations. — Priority: P0 (from astix ORM migration assessment 2026-03-15)
- [ ] 🔧 **BATCH-001** [Adapter] Batch unnest API — `INSERT ... SELECT unnest($1::type[])` and `UPDATE ... FROM unnest()` patterns. Not yet designed. Blocks 8 batch/unnest query migrations. — Priority: P0 (from astix ORM migration assessment 2026-03-15)
- [ ] 💡 **EXT-001** [Extensions] `@dbsp/pgvector` package — vector type, distance operators (`<=>`, `<->`), HNSW/IVFFlat index DDL. Blocks 2 cosine-distance queries + 3 vector search queries. — Priority: P1 (from astix ORM migration assessment 2026-03-15)
- [ ] 💡 **EXT-002** [Extensions] `@dbsp/paradedb` package — BM25 `@@@` operator, `paradedb.score()`, index management. Blocks 3 full-text/BM25 search queries. — Priority: P2 (from astix ORM migration assessment 2026-03-15)

---

## P0 — Architecture Assessment Findings (2026-03-14)

> From astix-powered architecture audit. God functions + monolithic classes = growth bottleneck.

### CRITICAL — Decompose god functions

- [ ] 🔧 **ARCH-001** [Adapter] Decompose `convertSelect` (complexity **356**, 240 LOC) in `packages/adapter-pgsql/src/intent-to-decisions.ts` — split into decision-type-specific strategy builders. Highest complexity in codebase. — Priority: CRITICAL
- [ ] 🔧 **ARCH-002** [Adapter] Decompose `PgsqlAdapter` (1780 LOC monolithic class) in `packages/adapter-pgsql/src/pgsql-adapter.ts` — extract DDL, introspection, transactions, compilation into focused modules. 30 direct callers, risk=HIGH. — Priority: CRITICAL
- [ ] 🔧 **ARCH-003** [Adapter] Decompose `compileSelect` (complexity **163**, 429 LOC) in `packages/adapter-pgsql/src/compiler.ts` — extract per-clause compilation (WHERE, JOIN, ORDER BY, GROUP BY). — Priority: CRITICAL

### HIGH — GUI + handler duplication

- [ ] 🔧 **ARCH-004** [GUI] Refactor `App.tsx` (1056 LOC, complexity **171**) — extract into sub-components (Editor, ResultsPanel, SettingsPanel) + custom hooks (useQueryExecution, useResultsViewer). — Priority: H
- [ ] 🔧 **ARCH-005** [Adapter] Consolidate 10 semantically duplicate `compile()` handler methods across `packages/adapter-pgsql/src/handlers/` — extract dispatch template or use code generation. Similarity=1.0 (exact copies). — Priority: H
- [ ] 🔧 **ARCH-006** [NQL] Decompose `compileExpression` (complexity **109**, 195 callees) in `packages/nql/src/compiler/compile-expression.ts` — split by expression type. — Priority: H

### MEDIUM — Code health findings (2026-03-14)

- [ ] 🐛 **ARCH-CH1** [GUI] `packages/gui/src/lib/log-utils.ts` is orphan — no incoming imports or calls. Verify if dead code and remove. — Priority: M
- [ ] 💡 **ARCH-CH2** [Adapter] 450 dead_code findings — mostly expression handlers (`countHandler`, `sumHandler`...) flagged because they're consumed via dynamic dispatch (`handlers[type]`). Investigate: are they truly dead, or is this an astix false positive from unresolved computed property access? — Priority: M
- [ ] 💡 **ARCH-CH3** [Core] 4 circular import cycles detected:
  - `handlers/index.ts` ↔ `handlers/where/index.ts` (barrel re-exports)
  - `column-validator.ts` ↔ `types.ts` (mutual type deps)
  - 5-file DX cluster: `filters → orm-instance-types → query-builder-types → types → window-functions`
  - 5-file Intent AST cluster: `expression → include → query → select → where` (by design — recursive AST)
  Priority: L (first two fixable, last two by-design)

### MEDIUM — Design debt

- [ ] 💡 **ARCH-007** [Core] Document result hydration design — brittle column aliasing (dot separator convention), row explosion risks, recursive include depth. Needs design doc before adding features. — Priority: M
- [ ] 💡 **ARCH-008** [Core] Add hook composition utilities (compose, pipe) + priority ordering (CRITICAL/HIGH/NORMAL/LOW). Current: implicit FIFO/LIFO only. — Priority: M
- [ ] 💡 **ARCH-009** [Core] Schema versioning + diffing — detect changes between schema versions for migration generation. Currently manual. — Priority: M
- [ ] 💡 **ARCH-010** [GUI] IPC error handling — JSON over stdio can fail silently. Add retry logic, timeout management, message queue for out-of-order responses. — Priority: M
- [ ] 💡 **ARCH-011** [Docs] Create PATTERNS.md — document Handler/Factory/Plugin/Strategy/Builder usage conventions. Inconsistent terminology confuses contributors. — Priority: M

---

## P1 — Critical (Functional Bugs)

> These are confirmed bugs that affect correctness. Fix before new features.

### Core Correctness

(Archived → docs/historic/done-2026-02.md)

### E2E Regressions (discovered via globalSetup fix)

(Archived → docs/historic/done-2026-02.md)

### Introspection

(Archived → docs/historic/done-2026-02.md)

---

## P2 — High (Product & DX)

> MCP operability, key DX features, documentation.

### MCP Server (Category C) — Deprioritized to P4 (2026-02-12)

(E06, E06b moved to P4 — CLI binary accessible to AI agents, MCP redundant for shell contexts)
(E06c, E08 archived → docs/historic/done-2026-02.md)

### Documentation

- [ ] **DOCS-002** [Docs] Migration guides (from-prisma, from-drizzle, from-kysely)
- [ ] **DOCS-003** [Docs] Pattern guides (multi-tenant, recursive queries, window functions)

(E11, E11b archived → docs/historic/done-2026-02.md)

### DX Convenience (Category A)

(E17c moved to P4 — GUI explorer prioritized over CLI wizard)
(E17, E17b archived → docs/historic/done-2026-02.md)

### Infrastructure

(E09, E09b, E10 archived → docs/historic/done-2026-02.md)

---

## P2 — GUI Desktop Explorer (New Product)

> Tauri v2 desktop app — visual schema exploration, SQL/NQL editing, plan inspection.
> Brief: docs/briefs/gui-explorer.md | Overview: docs/plans/gui-overview.md

### MVP

(GUI-001 to GUI-009, GUI-MW archived → docs/historic/done-2026-02.md)

(GUI-F002, GUI-F003 archived → docs/historic/done-2026-02.md)

(GUI-BRIDGE archived → docs/historic/done-2026-02.md)

### Later

(GUI-010 archived → docs/historic/done-2026-02.md)
(GUI-011, GUI-012 archived → docs/historic/done-2026-02.md)
(GUI-013, GUI-014 archived → docs/historic/done-2026-02.md)
- [ ] 💡 **GUI-015** [GUI] Web version (@dbsp/web — same React frontend, HTTP/WS transport, phpMyAdmin-like)
(GUI-016, GUI-016b, GUI-016a+c archived → docs/historic/done-2026-02.md)
(GUI-MW-D01, GUI-MW-D02, GUI-MW-D04, GUI-MW-D05, GUI-MW-D06 archived → docs/historic/done-2026-02.md)
- [ ] 💡 **GUI-MW-D03** [GUI] Per-connection SSL/params overrides in dbsp.settings.json — Priority: L
- [ ] 🔧 **GUI-F004** [GUI] TauriTransport edge case tests — race condition (close during pending listen), listen() rejection, reconnect timer cleanup, double reconnect — Priority: L
- [ ] 💡 **GUI-017** [GUI] Assertion file editing with syntax highlighting (write/edit .assert.dbsp, not just run) — Priority: L
- [ ] 💡 **GUI-018** [GUI] Auto-discovery of .assert.dbsp files from project tree (scan + run all) — Priority: L
- [ ] 💡 **GUI-019** [GUI] Live assertion re-run on file change (watch mode) — Priority: L
- [ ] 💡 **GUI-020** [GUI] Assertion coverage reporting (queries with/without assertions) — Priority: L
(Log rotation configurable, toast notifications, LogPanel virtualized list archived → docs/historic/done-2026-02.md)
(GUI-022, GUI-023 archived → docs/historic/done-2026-02.md)
- [ ] 💡 **GUI-022-F002** [GUI] `generateSchema` wizard option not wired (reverse-engineer endpoint needed) — Priority: L (from /review F-002)
- [ ] 💡 **GUI-022-F003** [GUI] NQL file menu item needs Rust-side Tauri menu + `fs.write` — Priority: L (from /review F-003)
(GUI-022-F004, F007, F009, F011, F014 archived → docs/historic/done-2026-02.md)
(GUI-025 archived → docs/historic/done-2026-02.md)
(GUI-025-OOS1, GUI-025-OOS2, GUI-025-F002 archived → docs/historic/done-2026-02.md)
(GUI-025-OOS3, OOS4, OOS5 promoted back to in-scope per user decision 2026-02-25)
- [ ] 🔧 **GUI-025-F008** [GUI] Replace unsafe double-cast in TauriFileWatcher with runtime schema validation (zod/manual) — Priority: M (from /review F-008)
- [ ] 🔧 **GUI-025-F016** [GUI] buildPairedTree single-root mode should strip root prefix (currently ignores roots[0]) — Priority: M (from /review F-016)
- [ ] 🔧 **GUI-027-F003** [GUI] ProfileManager.handleSetDefault should readSettings() first to avoid stale write — Priority: M (from /review F-003)
- [ ] 🔧 **GUI-027-F008** [GUI] `/mnt/**` scope in Tauri capabilities is dev-only — document or gate behind dev profile — Priority: M (from /review F-008)
- [ ] 🔧 **GUI-025-F018** [GUI] Auto-reload file watcher should skip dirty tabs (check tab.dirty before overwrite) — Priority: M (from /review F-018)
- [ ] 🔧 **GUI-024-F009** [GUI] Extract AppLogPopover to own file + test AC-1/AC-2 (expand icon, popover→modal wiring) — Priority: M (from /review F-009)
- [ ] 🔧 **GUI-021** [GUI] Authorization check on schema.apply sidecar endpoint (desktop-only, lower risk) — Priority: M (from /review F-007)
- [ ] 🔧 **CLI-001** [CLI] Integration test for rollback flow with real DB (SC-16) — Priority: M (from /review F-002)
(GUI-027 archived → docs/historic/done-2026-02.md)
(GUI-027-UX archived → docs/historic/done-2026-03.md)
  - [-] ⏭️ GUI-027-v2: Multi-connection per tab routing — deferred to v2
- [ ] 💡 **GUI-028** [GUI] Keychain integration (store:// URI) — activate Tauri plugin-store for secure password storage, opt-in vs default — Priority: L (needs /ideate on GUI-027 first)
(GUI-F005, GUI-F006, GUI-F007 archived → docs/historic/done-2026-02.md)

---

## P3 — Medium (SQL Features)

> Language features with clear use cases but lower urgency.

### NQL Language (Category B)

(E13, E13b, E13c, E13d, E13e, E13f archived → docs/historic/done-2026-02.md)

### Full-Text Search

- [ ] **E14** [Core] FTSIntent type + planner support — Effort: L
- [ ] **E14b** [Adapter] FTS Compiler (PostgreSQL) + ranking — Effort: L

### Locking & Transactions

(E15, E15b archived → docs/historic/done-2026-02.md)

### CLI Data Plane

(Archived → docs/historic/done-2026-02.md)

---

## P2.5 — Type Rationalization (Refactoring)

> Structural type health: 233→0 production casts remaining, contracts centralized, god files split.

(All R01 tasks archived → docs/historic/done-2026-02.md)

(R02 archived → docs/historic/done-2026-02.md)

---

## P4 — Low (Code Health)

> Tech debt to tackle when pain becomes real. No urgency.

### DRY Refactors (Category D)

(All archived → docs/historic/done-2026-02.md)

### SRP / God Classes

(#16, #17, #19, #34 archived → docs/historic/done-2026-02.md)
- [-] ⏭️ **#18** [SRP] PgsqlAdapter — DEFERRED: well-structured, low entropy, highest blast radius

### SOLID Violations

- [-] ⏭️ **#30** [ISP] QueryBuilder<T> 33 methods — WON'T FIX: all consumers use full interface, no subset usage found (2026-02-06)

(A-22/#20, #31 archived → docs/historic/done-2026-02.md)

### Test Coverage

(#33, A-34 archived → docs/historic/done-2026-02.md)

### API Surface

(Archived → docs/historic/done-2026-02.md)

### E13-ALL Review Findings (2026-02-07)

(Archived → docs/historic/done-2026-02.md)

### DX Convenience (moved from P2, 2026-02-12)

- [-] ⏭️ **E17c** [DX] `dbsp init` wizard — deferred: GUI explorer prioritized over CLI wizard

### MCP Server (moved from P2, 2026-02-12)

- [-] ⏭️ **E06** [MCP] Implement v1 tools — deferred: CLI binary accessible, MCP redundant for shell contexts
- [-] ⏭️ **E06b** [MCP] Implement v1 resources — deferred: same rationale

### Dead Code

(All items verified as false positives 2026-02-06: A-26 NqlLimitError doesn't exist / NqlWarning is active; #21 is in use; #29 no factory found; CLI plan summary embedded)

---

## Blocked / Deferred

> Explicitly parked. Requires external dependency or not planned.

### Performance-Gated

- [-] ⏭️ [Adapter] AST object pooling — perf-gated, measure first
- [-] ⏭️ [Adapter] Async deparse optimization — perf-gated

### Dependency-Blocked

(Migration generation + Cycle detection + compileWithIncludes archived → docs/historic/done-2026-02.md)
- [-] ⏭️ [Architecture] DX-032: Conformance Test Framework — depends on multi-adapter

### Multi-Adapter (Future)

- [-] ⏭️ [Core] Future Native Adapters (adapter-mysql, adapter-sqlite)
- [-] ⏭️ [Adapter] Multi-dialect FTS (MySQL, SQLite) — depends on multi-adapter

### Explicitly Not Planned

- [-] ⏭️ [Core] Cascade delete (multi-statement) — single delete only
- [-] ⏭️ [DDL] Triggers and stored procedures — outside semantic planner scope

### Schema Diff (from khi dashboard integration)

(DDL compareSchemata fixes archived → docs/historic/done-2026-03.md)
- [ ] 🔧 [DDL] compareSchemata index awareness — schema `unique: true` and `ref()` generate implicit indexes, but ModelIR doesn't include them → 24 false `drop_index` on diff — Priority: M
- [ ] 💡 [DDL] Expose migration CLI utilities as public API — `scanMigrations()`, file I/O from @dbsp/cli currently not exportable — Priority: L

### DDL Extensions (Low Priority)

- [-] ⏭️ [DDL-001] Check constraints (`CHECK (price > 0)`) — requires expression parser
- [-] ⏭️ [DDL-002] Partial indexes / expression indexes — advanced PostgreSQL
- [-] ⏭️ [DDL-004] Sequence/auto-increment customization — DB defaults sufficient
- [-] ⏭️ [DDL-005] Column comments (`COMMENT ON COLUMN`) — documentation feature
- [-] ⏭️ [DDL-006] `onUpdate` action for FKs — uncommon in practice
- [-] ⏭️ [DDL-007] Composite indexes — needs table-level syntax design
- [ ] 💡 [DDL] Migration squash/rebase — consolidate migration files — Priority: L (from /clarify SCHEMA-EVO)
- [ ] 💡 [GUI] ER diagram visualization in schema diff — Priority: L (from /clarify SCHEMA-EVO)
- [ ] 💡 [GUI] Interactive migration editing in GUI — Priority: L (from /clarify SCHEMA-EVO)

---

## Completed

(GUI-016, GUI-016b, SCHEMA-EVO archived → docs/historic/done-2026-02.md)
(Archived → docs/historic/done-2026-02.md)
