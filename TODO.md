# db-semantic-planner TODO

## In Progress

(None)

---

## Pending — HIGH

- [ ] [MCP] #6: Replace MCP server placeholder test — Score 4.5, Effort: M

---

## Pending — MEDIUM

- [ ] [NQL] HAVING support (aggregate filter after GROUP BY) — Effort: S
- [ ] [Adapter] json_agg column projection — Effort: M
- [ ] [NQL] JSONB Operators Support — Effort: M
- [ ] [Core] IN subquery → relation traversal normalization — Effort: M
- [ ] [Adapter] Enhance `singularize()` for irregular plurals — Effort: M
- [ ] [Adapter] ON CONFLICT / Upsert support — Effort: M
- [ ] [CLI] Enrich query plan display — Effort: M
- [ ] [Docs] DOCS-001: User documentation (Getting Started, API Guide)
- [ ] [Docs] DOCS-002: Migration guides (from-prisma, from-drizzle, from-kysely)
- [ ] [Docs] DOCS-003: Pattern guides (multi-tenant, recursive queries, window functions)

---

## Pending — LOW

- [-] ⏭️ Deferred: #29 CLI assertion factory — lower value, standalone story
- [-] ⏭️ Deferred: #33 adapter-pgsql test ratio — L-size, standalone story

---

## Blocked / Deferred

- [-] ⏭️ Deferred: [Adapter] Migration generation — depends on DDL generator maturity
- [-] ⏭️ Deferred: [Adapter] AST object pooling — perf-gated
- [-] ⏭️ Deferred: [Adapter] Async deparse optimization — perf-gated
- [-] ⏭️ Deferred: [NQL] IN (dateRange) — requires semantic date expansion (#NQL-GAP-3)
- [-] ⏭️ Deferred: [NQL] Window fn lag/lead offset/default — P3+ (`intent-ast.ts:399,474`)
- [-] ⏭️ Deferred: [NQL] UNION mode (vs UNION ALL) — not implemented (`intent-ast.ts:1151`)
- [-] ⏭️ Deferred: [Core] Cascade delete (multi-statement) — single delete only (`mutation-builders.ts:586`)
- [-] ⏭️ Deferred: [Adapter] `compileWithIncludes()` Phase 3 — partially implemented (`pgsql-adapter.ts:422`)
- [-] ⏭️ Deferred: [Adapter] Cycle detection placeholder — depends on `@pgsql/types` version
- [-] ⏭️ Deferred: [NQL] CASE Expression Enhancements
- [-] ⏭️ Deferred: [CLI] Extract shared plan summary formatting
- [-] ⏭️ Deferred: [CLI] .load <table> <file> — Bulk CSV/JSON import
- [-] ⏭️ Deferred: [CLI] RETURNING clause support
- [-] ⏭️ Deferred: [CLI] Transaction support (BEGIN/COMMIT/ROLLBACK)
- [-] ⏭️ Deferred: [CLI] Set operations (UNION, INTERSECT, EXCEPT)
- [-] ⏭️ Deferred: [Core] P3-B: FTSIntent (PostgreSQL Full-Text Search)
- [-] ⏭️ Deferred: [Adapter] P3-B: FTS Compiler (PostgreSQL)
- [-] ⏭️ Deferred: [Adapter] P3-D: FOR UPDATE SKIP LOCKED (Job Queue pattern)
- [-] ⏭️ Deferred: [Adapter] P3-E: Multi-dialect FTS (MySQL, SQLite)
- [-] ⏭️ Deferred: [Core] Future Native Adapters (adapter-mysql, adapter-sqlite)
- [-] ⏭️ Deferred: [Architecture] DX-032: Conformance Test Framework — depends on multi-adapter
- [-] ⏭️ Deferred: #16 NqlCstVisitor SRP (1,349 LOC) — L-size, dedicated story
- [-] ⏭️ Deferred: #17 NQL compiler SRP (1,142 LOC) — L-size, dedicated story
- [-] ⏭️ Deferred: #18 PgsqlAdapter SRP (1,592 LOC) — L-size, dedicated story
- [-] ⏭️ Deferred: #21 compileSubqueryIncludeManyToMany — 117 LOC, low value
- [-] ⏭️ Deferred: #19 QueryBuilderImpl extraction (1,091 LOC) — L
- [-] ⏭️ Deferred: #20 Extend handler pattern to remaining compiler switch cases — L
- [-] ⏭️ Deferred: #30 QueryBuilder<T> interface ISP (30+ methods) — L
- [-] ⏭️ Deferred: #31 types.ts 26 exports in one file — M
- [-] ⏭️ Deferred: #34 intent-ast.ts 1,750 LOC single file — L

---

## Completed

- [x] ✅ [Adapter] Fix `relation.*` wildcard column propagation in flat/join includes (2026-02-03)
- [x] ✅ [Adapter] Replace hardcoded `'id'` with `defaultPk` in plan-decision-extractor (2026-02-03)
- [x] ✅ [CLI] Fix input wrapping — horizontal scrolling window for long input lines (2026-02-03)

(Archived → docs/historic/done-2026-02.md)
