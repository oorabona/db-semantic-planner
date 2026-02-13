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

- [x] ✅ **GUI-001** [GUI] Scaffold packages/gui (Tauri v2 + React + ShadCN/UI + Vite) (2026-02-12)
- [x] ✅ **GUI-002** [GUI] Node.js SEA sidecar (bundle dbsp engine, JSON-RPC IPC) (2026-02-12)
- [x] ✅ **GUI-003** [GUI] Connection Manager (PostgreSQL connect, save/switch profiles) (2026-02-12)
- [x] ✅ **GUI-004** [GUI] Schema Treeview (introspect DB, tables/columns/indexes/FKs) (2026-02-12)
- [x] ✅ **GUI-005** [GUI] Monaco SQL Editor (syntax highlight, table/column autocomplete) (2026-02-12)
- [x] ✅ **GUI-006** [GUI] Monaco NQL Editor (TextMate grammar from Chevrotain, .dbsp support) (2026-02-12)
- [x] ✅ **GUI-007** [GUI] Results Table (TanStack virtual scroll, sort, type-aware display) (2026-02-13)
- [x] ✅ **GUI-008** [GUI] Plan Inspector (visual dump: decisions, warnings, CTEs, timing) (2026-02-13)
- [x] ✅ **GUI-009** [GUI] Distribution (Tauri bundle: .msi/.dmg/.deb, auto-updater, CI) (2026-02-13)
- [ ] 🔧 **GUI-F002** [GUI] Missing test coverage: hooks (useConnection, useSchema, useMonacoSetup), ipc.ts, sql-completions.ts, sidecar/index.ts — Priority: M

### Later

- [ ] 💡 **GUI-010** [GUI] .assert.dbsp runner with inline pass/fail
- [ ] 💡 **GUI-011** [GUI] Schema diff (live DB vs schema.ts via compareSchemata)
- [ ] 💡 **GUI-012** [GUI] Query history with search and re-run
- [ ] 💡 **GUI-013** [GUI] Theme system (dark/light + custom accent colors)
- [ ] 💡 **GUI-014** [GUI] Welcome screen with quick connect + sample queries
- [ ] 💡 **GUI-015** [GUI] Web version (@dbsp/web — same React frontend, HTTP/WS transport, phpMyAdmin-like)
- [ ] 💡 **GUI-016** [GUI] Status bar "+" → loupe icon, ouvre un panneau de logs applicatifs (sidecar stdout/stderr, IPC messages, query timing). Format: drawer coulissant depuis la barre de statut (style VS Code Output panel) ou onglet "Logs" dans le panneau results

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

---

## Completed

(Archived → docs/historic/done-2026-02.md)
