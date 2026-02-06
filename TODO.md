# db-semantic-planner TODO

> Consolidated 2026-02-05 from BACKLOG*.md + audit findings + legacy TODOs

## In Progress

(None active)

---

## P1 — Critical (Functional Bugs)

> These are confirmed bugs that affect correctness. Fix before new features.

### Core Correctness

(Archived → docs/historic/done-2026-02.md)

### E2E Regressions (discovered via globalSetup fix)

- [x] ✅ **E2E-1** [Adapter] Schema-qualified columns in expression handlers — removed `ctx.schema` from `columnRef()` in 7 handlers (aggregate, window, column, coalesce, case, arithmetic, relation); also fixed window `selectWindow` dispatch to always use `genericWindowHandler` (2026-02-06)
- [x] ✅ **E2E-2** [Adapter] Expression alias not transformed by naming plugin — added `this.naming.toDatabase()` to 4 alias sites in compiler.ts (selectFunction, selectExpression, selectArithmetic, selectWindow) (2026-02-06)

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

- [ ] **E13** [NQL] JSONB operators — `->`, `->>`, `@>`, `<@`, `?`, `#>`, `#>>` — Effort: M
- [ ] **E13b** [NQL] Set operations (UNION, INTERSECT, EXCEPT) — partially deferred
(E13c, DRY case-value, CASE tests archived → docs/historic/done-2026-02.md)

- [ ] **E13d** [NQL] Window fn lag/lead offset/default — P3+
- [ ] **E13e** [NQL] IN (dateRange) — requires semantic date expansion
- [ ] **E13f** [NQL] Range literal in INSERT — parsing OK but not compiled
  - Ref: legacy TODO_NQL.md:201

### Full-Text Search

- [ ] **E14** [Core] FTSIntent type + planner support — Effort: L
- [ ] **E14b** [Adapter] FTS Compiler (PostgreSQL) + ranking — Effort: L

### Locking & Transactions

- [ ] **E15** [Adapter] FOR UPDATE SKIP LOCKED (Job Queue pattern) — Effort: M
- [ ] **E15b** [Adapter] Atomic lock+update syntax

### CLI Data Plane

- [ ] **E16** [CLI] `.load <table> <file>` — Bulk CSV/JSON import
- [ ] **E16b** [CLI] RETURNING clause support in REPL
- [ ] **E16c** [CLI] Transaction support (BEGIN/COMMIT/ROLLBACK)
- [ ] **E16d** [CLI] Set operations exposed in REPL

---

## P2.5 — Type Rationalization (Refactoring)

> Structural type health: 233→0 production casts remaining, contracts centralized, god files split.

(All R01 tasks archived → docs/historic/done-2026-02.md)

(R02 archived → docs/historic/done-2026-02.md)

---

## P4 — Low (Code Health)

> Tech debt to tackle when pain becomes real. No urgency.

### DRY Refactors (Category D)

- [x] ✅ **A-7** [DRY] Comparison filters — false positive: factory `createComparisonFilter()` already exists (2026-02-06)
- [x] ✅ **A-9** [DRY] `normalizeSQL()` → moved to `@dbsp/core/sql-utils.ts`, adapter re-exports (2026-02-06)
- [x] ✅ **A-12** [DRY] `buildParamRef()` — already consolidated in handlers/where/utils.ts (2026-02-06)
- [x] ✅ **A-15** [DRY] Mutation builder — false positive: 15 LOC marginal, unique per builder (2026-02-06)
- [x] ✅ **A-16** [DRY] Column target building — already centralized via buildColumnRef() (2026-02-06)
- [x] ✅ **A-17** [DRY] FK direction — compiler.ts now calls `deriveFkColumns()` from shared.ts; `FkColumnSource` interface (2026-02-06)
- [x] ✅ **A-24** [DRY] Clone methods — changed 4 optional fields from `?:` to `: X | undefined`, simplified clone() from 46→34 LOC (2026-02-06)
- [x] ✅ **A-25** [DRY] NQL context validation — false positive: 0 `this.validator` calls found (2026-02-06)
- [x] ✅ **A-30** [DRY] `isRecursiveIncludeOptions()` — single def + re-export, correct (2026-02-06)
- [x] ✅ **A-31** [DRY] CLI assertion functions — false positive: 3 factories exist, remaining 16 have unique logic (2026-02-06)

### SRP / God Classes

- [ ] **#16** [SRP] NqlCstVisitor (1,349 LOC) — L-size, dedicated story
- [ ] **#17** [SRP] NQL compiler (1,142 LOC) — L-size, dedicated story
- [ ] **#18** [SRP] PgsqlAdapter (1,592 LOC) — L-size, dedicated story
- [ ] **#19** [SRP] QueryBuilderImpl extraction (1,091 LOC) — L
- [ ] **#34** [SRP] intent-ast.ts (1,750 LOC) — L

### SOLID Violations

- [-] ⏭️ **#30** [ISP] QueryBuilder<T> 33 methods — WON'T FIX: all consumers use full interface, no subset usage found (2026-02-06)

(A-22/#20, #31 archived → docs/historic/done-2026-02.md)

### Test Coverage

(#33, A-34 archived → docs/historic/done-2026-02.md)

### API Surface

- [x] ✅ **A-13** [API] AST helpers — false positive: 44 exports are package-internal, not in public API, 0 cross-package (2026-02-06)
- [x] ✅ **A-14** [API] Handler registry — false positive: 18 exports are package-internal, types exposed read-only (2026-02-06)

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
- [-] ⏭️ [Adapter] Cycle detection placeholder — depends on `@pgsql/types` version
- [-] ⏭️ [Adapter] `compileWithIncludes()` Phase 3 — partially implemented
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
