# db-semantic-planner TODO

## In Progress

(None - all active work completed)

---

## Pending

### [NQL] Range literal in INSERT not converted
- **Example:** `insert into priceTiers set quantityRange = "[1,50)"`
- **Error:** `malformed range literal`
- **Root cause:** Range string value passed as-is instead of PostgreSQL range syntax
- **Solution:** Detect range pattern in mutation-compiler `valueToNode()` for range columns
- **Files:** `packages/adapter-pgsql/src/mutations/mutation-compiler.ts`

---

## Blocked / Deferred

### [Adapter] Migration generation (diff-based ALTER statements) — Deferred
- **Goal:** Generate ALTER TABLE statements from schema diffs
- **Depends on:** DDL generator maturity

### [Adapter] AST object pooling — Deferred
- **Goal:** Reduce GC pressure on high-throughput query compilation
- **Condition:** Only if perf issue measured via benchmarks

### [Adapter] Async deparse optimization — Deferred
- **Goal:** Non-blocking SQL deparsing for streaming scenarios
- **Condition:** Only if perf issue measured via benchmarks

### [NQL] JSONB Operators Support — Effort: M (~4h) — Priority: MEDIUM
- **Required operators:** `->`, `->>`, `@>`, `<@`, `?`, `#>`, `#>>`
- **Implementation:** Add lexer tokens, parser grammar, AST types, compiler
- **Workaround:** Use `raw()` escape hatch until implemented

### [NQL] CASE Expression Enhancements — Priority: LOW
- **Deferred:** Simple CASE, nested CASE, column/function in THEN/ELSE, CASE in WHERE

### [CLI] .load <table> <file> — Bulk CSV/JSON import — Priority: LOW

### [CLI] RETURNING clause support — Priority: LOW

### [CLI] Transaction support (BEGIN/COMMIT/ROLLBACK) — Priority: LOW

### [CLI] Set operations (UNION, INTERSECT, EXCEPT) — Priority: LOW

### [Docs] DOCS-001: User documentation (Getting Started, API Guide) — Priority: MEDIUM

### [Docs] DOCS-002: Migration guides (from-prisma, from-drizzle, from-kysely) — Priority: MEDIUM

### [Docs] DOCS-003: Pattern guides (multi-tenant, recursive queries, window functions) — Priority: MEDIUM

### [Core] P3-B: FTSIntent (PostgreSQL Full-Text Search) — Priority: LOW

### [Adapter] P3-B: FTS Compiler (PostgreSQL) — Priority: LOW

### [Adapter] P3-D: FOR UPDATE SKIP LOCKED (Job Queue pattern) — Priority: LOW

### [Adapter] P3-E: Multi-dialect FTS (MySQL, SQLite) — Priority: LOW

### [Core] Future Native Adapters
- [ ] `adapter-mysql` — MySQL native (mysql2)
- [ ] `adapter-sqlite` — SQLite native (better-sqlite3)

### [Architecture] DX-032: Conformance Test Framework — Priority: HIGH — Effort: M (~12h)
- **Depends on:** Multi-adapter support
- **Goal:** DRY framework for multi-adapter testing

---

## Backlog

### [Refactor] SRP Extractions - Phase 5 L/XL Items
- [ ] **5.1** Split `NqlCstVisitor` into specialized visitors (~1300 lines, L effort)
- [ ] **5.2** Refactor `PgsqlAdapter` — extract services (~2012 lines, XL effort)
- [ ] **5.3** Refactor `QueryBuilderImpl` — extract concerns (~1028 lines, L effort)
- [ ] **5.4** Extend handler pattern to all 44 compiler decisions (~1250 lines, L effort)

---

## Completed

(Archived → docs/historic/done-2026-02.md)
