# db-semantic-planner TODO

## In Progress

(None - all active work completed)

---

## Pending

(None)

---

## Completed

(Archived → docs/historic/done-2026-02.md)

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

### [Core] ✅ BUG: Deep relation traversal (4+ levels) returns 0 rows in IAM example — FIXED (2026-02-01)
- Root cause: extractJsonAggDecisions flattened nested includes into siblings; compiler correlated all to root table
- Fix: Tree-structured decisions (intentPath-based) + recursive compileJsonAggDecision with nested json_agg subqueries
- Query 27 now returns 5 rows correctly with depth-based aliases (__t__, __t1__, __t2__, __t3__)

### [Infra] pnpm test at root should run ALL package tests — Priority: MEDIUM
- Currently: `pnpm test` root runs only ~295 tests (some workspaces)
- Expected: should run all ~1900+ tests across core, nql, adapter-pgsql, cli, mcp-server
- `pnpm test -F <package>` should filter to a single package

(Phase 5 SRP archived → docs/historic/done-2026-02.md)

---

## Completed

(Archived → docs/historic/done-2026-02.md)
