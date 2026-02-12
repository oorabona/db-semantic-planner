# db-semantic-planner TODO

> Consolidated 2026-02-05 from BACKLOG*.md + audit findings + legacy TODOs

## In Progress

(Archived → docs/historic/done-2026-02.md)

- [x] ✅ [Docs] Document DATABASE_URL env for E2E locking tests — verified: both modes work (2026-02-11)

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

### MCP Server (Category C)

- [ ] **E06** [MCP] Implement v1 tools — `schema_list_tables`, `schema_get_relations`, `query_plan`, `intent_validate`
  - Ref: `packages/mcp-server/src/server.ts:55`
- [ ] **E06b** [MCP] Implement v1 resources — `schema://manifest`, `schema://intent-schema`, `schema://cookbook`
  - Ref: `packages/mcp-server/src/server.ts:60`

(E06c, E08 archived → docs/historic/done-2026-02.md)

### Documentation

- [ ] **DOCS-002** [Docs] Migration guides (from-prisma, from-drizzle, from-kysely)
- [ ] **DOCS-003** [Docs] Pattern guides (multi-tenant, recursive queries, window functions)

(E11, E11b archived → docs/historic/done-2026-02.md)

### DX Convenience (Category A)

- [ ] **E17c** [DX] `dbsp init` wizard (like Prisma) — Effort: M

(E17, E17b archived → docs/historic/done-2026-02.md)

### Infrastructure

(E09, E09b, E10 archived → docs/historic/done-2026-02.md)

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

### Dead Code

(All items verified as false positives 2026-02-06: A-26 NqlLimitError doesn't exist / NqlWarning is active; #21 is in use; #29 no factory found; CLI plan summary embedded)

---

## Blocked / Deferred

> Explicitly parked. Requires external dependency or not planned.

### Performance-Gated

- [-] ⏭️ [Adapter] AST object pooling — perf-gated, measure first
- [-] ⏭️ [Adapter] Async deparse optimization — perf-gated

### Dependency-Blocked

- [-] ⏭️ [Adapter] Migration generation — depends on DDL generator maturity
(Cycle detection + compileWithIncludes archived → docs/historic/done-2026-02.md)
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
