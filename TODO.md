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

> Re-assessment 2026-03-20: 108 `orm.raw()` calls. Inventory: `astix/docs/orm-raw-inventory.md`
> After rigorous audit: dbsp already covers ~94/108 calls via existing features.
> Remaining raw: DDL (10) + system catalogs (4) = always raw by design.
> Migration work is ASTIX-SIDE (use include/returning/notExists/distinct), not new dbsp features.

### Assessment summary (2026-03-20)
> - §1 JOINs (~50): ✅ Covered by `include('relation', { select, where })` — all FK relations declared
> - §2 WITH RECURSIVE (9): ✅ Covered by recursive includes (DX-017)
> - §3 CTE mutations (8): ✅ Covered by `.delete().returning()` — count client-side, no CTE needed
> - §4 UPDATE...FROM unnest (5): ✅ Covered by `batchSet()` (BATCH-001)
> - §5 DDL (10): 🚫 Always raw by design
> - §6 pgvector (2): ✅ EXT-001 (cosineDistance etc.) + include for JOINs
> - §7 ParadeDB (4): ✅ EXT-002 (bm25Search etc.) + include for JOINs
> - §8 sql() in set (4): ✅ UPSERT-RAW (sql('now()') in .set())
> - §9 NOT EXISTS (4): ✅ `notExists('relation')` works on delete builder — FK declared
> - §10 System catalogs (4): 🚫 Always raw by design
> Only DISTINCT ON (PostgreSQL-specific) is a minor gap — .distinct() covers most cases.

- [x] ✅ **DISTINCT-ON** [Adapter] PostgreSQL DISTINCT ON support — `orm.select().distinctOn('column')` for `SELECT DISTINCT ON (col)`. (2026-03-20)

(DX-050 archived → docs/historic/done-2026-03.md)
(CTE-001 archived → docs/historic/done-2026-03.md)
(BATCH-001 archived → docs/historic/done-2026-03.md)
(AGG-001 archived → docs/historic/done-2026-03.md)
(DDL-FK-IDX archived → docs/historic/done-2026-03.md)
(DDL-COMPLETE archived → docs/historic/done-2026-03.md)
(SCHEMA-DSL-EXT archived → docs/historic/done-2026-03.md)
- [ ] 💡 **DDL-VIEWS** [Adapter] VIEW support — CREATE/DROP VIEW, materialized views, introspection, diff. — Priority: P1 (deferred from DDL-COMPLETE)
- [ ] 💡 **DDL-TRIGGERS** [Adapter] TRIGGER support — CREATE/DROP TRIGGER, trigger functions, introspection, diff. — Priority: P2 (deferred from DDL-COMPLETE)
- [ ] 💡 **DDL-PARTITION-MGMT** [Adapter] Partition child table management — CREATE TABLE ... PARTITION OF ... FOR VALUES, partition addition/removal/split. Parent PARTITION BY handled in DDL-COMPLETE. — Priority: P2 (deferred from /adversarial DDL-COMPLETE)
- [ ] 💡 **DDL-EXT-SCHEMA** [Adapter] Extension schema qualification — CREATE EXTENSION ... SCHEMA pg_catalog. — Priority: L (deferred from /adversarial DDL-COMPLETE)
- [x] ✅ **DDL-VALIDATE** [Adapter] NOT VALID / VALIDATE CONSTRAINT for FK and CHECK — `notValid?: boolean` on `ForeignKeyIR`/`CheckConstraintIR`, `validate_constraint` ChangeKind, `compareSchemata` emits it on notValid→valid transition, phase 16 in migration ordering. 20 new tests. (2026-03-20)
- [ ] 💡 **DDL-RLS** [Adapter] Row-Level Security policies — CREATE/DROP POLICY, introspect pg_policy. — Priority: M (from /llm Copilot DDL-COMPLETE)
- [ ] 💡 **DDL-DOMAINS** [Adapter] Custom domain types — CREATE DOMAIN with constraints. — Priority: L (from /llm Copilot DDL-COMPLETE)
- [x] ✅ **DDL-OPCLASS-INTRO** [Adapter] Index introspection: added opclass/include/expressions — pg_opclass join on indclass, pg_get_expr(indexprs), indnkeyatts for INCLUDE columns. 5 new unit tests. (2026-03-20)
- [x] ✅ **DDL-ENUM-DEPCHECK** [Adapter] drop_enum column dependency check — scan DB ModelIR tables for columns with `originalDbType === enumName`, emit `ALTER TABLE ... TYPE text` before `DROP TYPE`. 5 tests (unit + e2e). (2026-03-20)
- [x] ✅ **DDL-SEQ-DRY** [Adapter] Extract `buildSequenceClause()` shared helper — eliminates 4× duplicated sequence SQL generation. (2026-03-20)
(CAPS-VERSION, UPSERT-RAW, EDGE-001, EDGE-002 archived → docs/historic/done-2026-03.md)
- [ ] 💡 **NQL-WITH** [NQL] WITH ... AS (...) non-recursive CTE syntax in NQL parser — deferred from BATCH-001. — Priority: P1 (from /adversarial 2026-03-18)
- [x] ✅ **BATCH-DRY-001** [Adapter] Extract shared `mapModelIRTypeToPgBase()` to `compiler-utils.ts` — removed local duplicate in `any.ts`. (2026-03-20)
- [x] ✅ **EDGE-FLOAT** [Adapter] Float literal support in raw-expression-parser — `tokenise()` produces FLOAT tokens, `parsePrimary()` emits `A_Const.fval` nodes, 7 new tests. (2026-03-20)
- [x] ✅ **BATCH-DRY-002** [Adapter] Extract `stripArraySuffix()` helper to `compiler-utils.ts` — eliminated 4× inline pattern. (2026-03-20)
- [x] ✅ **BATCH-FIX-001** [Adapter] Add `bigint` to `inferPgArrayType` runtime fallback → `int8[]`. (2026-03-20)
- [x] ✅ **BATCH-FIX-002** [Adapter] Fix `mapModelIRTypeToPgBase`: `timestamp` → `timestamptz`, `date` → `date` (was `text`). (2026-03-20)
- [x] ✅ **EXT-001** [Extensions] Generic expression primitives (op/fn/ref/param/cast/literal/unary) in `@dbsp/core` + pgvector extension wrappers (cosineDistance, rawDistance, l2Distance, innerProduct) in `adapter-pgsql/extensions/`. Full SELECT/WHERE/ORDER BY pipeline. 2455 tests passing. (2026-03-20)
- [x] ✅ **EXT-002** [Extensions] ParadeDB extension wrappers (score, parse, boost, booleanSearch, bm25Search) in adapter-pgsql/extensions/paradedb.ts. 16 tests. (2026-03-20)

---

## P1 — Multi-Adapter Capability Negotiation (2026-03-19)

> ModelIR = universal representation. Each adapter interprets features per its capabilities.
> Unsupported features: configurable behavior (warn+skip OR error/throw).
> Tier 1 (OSS baseline): PostgreSQL, MySQL, SQLite, DuckDB. Tier 2 (best-effort): Oracle, MSSQL, CouchDB.

(CAPS-001→005 archived → docs/historic/done-2026-03.md)
(EDGE-001, EDGE-002, EDGE-002/F-001, EDGE-002/F-002, EDGE-002/LINT archived → docs/historic/done-2026-03.md)
- [x] ⏭️ **DX-WARMUP** [Adapter] Obsolete — EDGE-001 eliminated WASM, warmup() no longer needed. (2026-03-20)
- [ ] 💡 **EDGE-FLOAT** [Adapter] raw-expression-parser: add float literal support (e.g. `sql('3.14')`) — Priority: L (from /review EDGE-002 F-005)
- [x] ✅ **EXT-001** [Core+Adapter] Generic expression primitives (op/fn/ref/param/cast/literal/unary) + pgvector extension (cosineDistance, rawDistance, l2Distance, innerProduct). 2455 tests. (2026-03-20)
- [ ] 💡 **EXT-PARAM-DEDUP** [Core] Param deduplication — same expression in SELECT+WHERE+ORDER BY produces 3 params instead of 1. — Priority: L (from /adversarial EXT-001)
- [ ] 💡 **EXT-NAMED-PARAMS** [Core] Named parameter syntax (`field => 'name'`) for ParadeDB functions — Priority: M (from /adversarial EXT-001, deferred to EXT-002)
- [x] ✅ **EXT-TEMPLATE** [Docs] Extension developer guide/template — `packages/adapter-pgsql/src/extensions/README.md` (2026-03-20)
- [x] ✅ **CAPS-DRY-001** [Adapter] `isChangeSupported()` — added `alter_column_collation`/`alter_column_identity` cases. (2026-03-20)
- [x] ✅ **CAPS-DOC-001** [Adapter] Add JSDoc to `sup()` helper in `ddl-generator.ts` and `schema-diff.ts` explaining undefined/false/true semantics. (2026-03-20)

---

## P0 — Architecture Assessment Findings (2026-03-14)

> From astix-powered architecture audit. God functions + monolithic classes = growth bottleneck.

### CRITICAL — Decompose god functions

- [x] ✅ **ARCH-001** [Adapter] Decompose `convertSelect` — 13 expression handlers extracted into dispatch map, 245→78 LOC. (2026-03-19)
- [x] ✅ **ARCH-002** [Adapter] Decompose `PgsqlAdapter` compilation domain — 15 methods (568 LOC) extracted into 4 modules (adapter-compiler-select, -includes, -mutations, -recursive) + deps type. pgsql-adapter.ts: 1985→745 LOC. 2416 tests pass. (2026-03-19)
- [x] ✅ **ARCH-003** [Adapter] Decompose `compileSelect` — 7 helpers extracted (createHandlerContext, createHandlerState, compileSelectTarget, compileIncludeDecision, compileWhereDecision, flushPendingJoins, buildSelectStmt), 439→122 LOC. (2026-03-19)

### HIGH — GUI + handler duplication

- [ ] 🔧 **ARCH-004** [GUI] Refactor `App.tsx` (1056 LOC, complexity **171**) — extract into sub-components (Editor, ResultsPanel, SettingsPanel) + custom hooks (useQueryExecution, useResultsViewer). — Priority: H
- [x] ✅ **ARCH-005** [Adapter] Consolidate duplicate `compile()` handler methods — extracted 4 factory functions (`createSimpleAggregateHandler`, `createNoArgWindowHandler`, `createLagLeadHandler`, `createColumnWindowHandler`) eliminating 10 duplicate bodies across aggregate.ts and window.ts. (2026-03-20)
- [x] ✅ **ARCH-006** [NQL] Decompose `compileExpression` (complexity **109**, 195 callees) — 8 handler functions extracted (`compileLogical`, `compileComparison`, `compileRange`, `compileMembership`, `compileBetween`, `compileNull`, `compileJson`, `compileRelationFilter`), dispatcher thinned to ~30 LOC. 1111+2575+1042 tests pass. (2026-03-20)

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
