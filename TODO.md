# db-semantic-planner TODO

## In Progress

---

## Pending — HIGH

- [ ] [MCP] #6: Replace MCP server placeholder test — Score 4.5, Effort: M

---

## Pending — MEDIUM

### Documentation

- [ ] [Docs] DOCS-001: Complete user documentation — Effort: L
  - Getting Started guide (install → first query in 5 min)
  - Document undocumented features: batch insert `.values([])`, `.count()`, `.first()`/`.firstOrThrow()`, transactions (nested), `AdapterLogger`, `onStart` streaming, `NamingPlugin`
  - Type inference showcase (schema → typed results)
  - `dump()` workflow guide (plan → SQL → params)
  - E2E verification required for every documented feature
- [ ] [Docs] DOCS-002: Migration guides (from-prisma, from-drizzle, from-kysely)
- [ ] [Docs] DOCS-003: Pattern guides (multi-tenant, recursive queries, window functions)

### DX Convenience (Category A)

- [ ] [DX] `.exists()` query shortcut — Effort: S
- [ ] [DX] Soft delete convention (built-in `deletedAt` filtering) — Effort: M
- [ ] [DX] Query middleware/hooks system — Effort: L
- [ ] [NQL] Multi-row INSERT syntax (`insert into X values (…), (…)`) — Effort: M

### SQL Features

- [ ] [NQL] JSONB Operators Support — Effort: M

---

## Pending — LOW

### SQL Features (Category B)

- [ ] [NQL] Set operations (UNION, INTERSECT, EXCEPT) — partially deferred (`intent-ast.ts:1151`)
- [ ] [NQL] CASE Expression Enhancements
- [ ] [NQL] Window fn lag/lead offset/default — P3+ (`intent-ast.ts:399,474`)
- [ ] [NQL] IN (dateRange) — requires semantic date expansion (#NQL-GAP-3)
- [ ] [Core] FTSIntent (PostgreSQL Full-Text Search) — Effort: L
- [ ] [Adapter] FTS Compiler (PostgreSQL) — Effort: L
- [ ] [Adapter] FOR UPDATE SKIP LOCKED (Job Queue pattern) — Effort: M
- [ ] [CLI] .load \<table\> \<file\> — Bulk CSV/JSON import
- [ ] [CLI] RETURNING clause support
- [ ] [CLI] Transaction support (BEGIN/COMMIT/ROLLBACK)
- [ ] [CLI] Set operations (UNION, INTERSECT, EXCEPT)

### Code Health (Category D)

- [ ] #16 NqlCstVisitor SRP (1,349 LOC) — L-size, dedicated story
- [ ] #17 NQL compiler SRP (1,142 LOC) — L-size, dedicated story
- [ ] #18 PgsqlAdapter SRP (1,592 LOC) — L-size, dedicated story
- [ ] #19 QueryBuilderImpl extraction (1,091 LOC) — L
- [ ] #20 Extend handler pattern to remaining compiler switch cases — L
- [ ] #21 compileSubqueryIncludeManyToMany — 117 LOC, low value
- [ ] #29 CLI assertion factory — lower value, standalone story
- [ ] #30 QueryBuilder\<T\> interface ISP (30+ methods) — L
- [ ] #31 types.ts 26 exports in one file — M
- [ ] #33 adapter-pgsql test ratio — L-size, standalone story
- [ ] #34 intent-ast.ts 1,750 LOC single file — L
- [ ] [CLI] Extract shared plan summary formatting

---

## Blocked / Deferred

- [-] ⏭️ Deferred: [Adapter] Migration generation — depends on DDL generator maturity
- [-] ⏭️ Deferred: [Adapter] AST object pooling — perf-gated
- [-] ⏭️ Deferred: [Adapter] Async deparse optimization — perf-gated
- [-] ⏭️ Deferred: [Adapter] `compileWithIncludes()` Phase 3 — partially implemented (`pgsql-adapter.ts:422`)
- [-] ⏭️ Deferred: [Adapter] Cycle detection placeholder — depends on `@pgsql/types` version
- [-] ⏭️ Deferred: [Adapter] Multi-dialect FTS (MySQL, SQLite) — depends on multi-adapter
- [-] ⏭️ Deferred: [Core] Future Native Adapters (adapter-mysql, adapter-sqlite)
- [-] ⏭️ Deferred: [Core] Cascade delete (multi-statement) — single delete only (`mutation-builders.ts:586`)
- [-] ⏭️ Deferred: [Architecture] DX-032: Conformance Test Framework — depends on multi-adapter

---

## Completed

- [x] ✅ [Adapter] Enhance `singularize()` for irregular plurals (2026-02-05)

(Archived → docs/historic/done-2026-02.md)
