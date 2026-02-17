# db-semantic-planner TODO

> Consolidated 2026-02-05 from BACKLOG*.md + audit findings + legacy TODOs

## In Progress

(Archived → docs/historic/done-2026-02.md)

(Archived → docs/historic/done-2026-02.md)

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
- [ ] 🔧 **GUI-024-F009** [GUI] Extract AppLogPopover to own file + test AC-1/AC-2 (expand icon, popover→modal wiring) — Priority: M (from /review F-009)
- [ ] 🔧 **GUI-021** [GUI] Authorization check on schema.apply sidecar endpoint (desktop-only, lower risk) — Priority: M (from /review F-007)
- [ ] 🔧 **CLI-001** [CLI] Integration test for rollback flow with real DB (SC-16) — Priority: M (from /review F-002)
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
