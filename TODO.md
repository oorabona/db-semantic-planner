# db-semantic-planner TODO

## In Progress

(Archived → docs/historic/done-2026-02.md)

---

## Pending — HIGH Priority

> Audit items with Score ≥ 3.0 — details in `docs/audit/BACKLOG.md`

### ~[Security] #2: Fix 8 dependency vulnerabilities~ — ✅ Already clean (pnpm audit: 0 vulns)

### ~[NQL] #9: Remove `format()` stub~ — ✅ DONE (2026-02-01)

### ~[Adapter+CLI] #7: Consolidate `normalizeSQL()`~ — ✅ DONE (2026-02-01)

### [MCP] #6: Replace MCP server placeholder test — Score 4.5 — Effort: M
- Only 1 placeholder test exists for the entire MCP server package
- 7 TODO stubs in `server.ts`: MCP-003 (schema_list_tables), MCP-004 (schema_get_relations), MCP-005 (query_plan), MCP-006 (intent_validate), MCP-007/a/b (resources: manifest, intent-schema, cookbook)

### ~[Core] #5: Comparison filter factory~ — ✅ Already done (createComparisonFilter exists)

---

## Pending — MEDIUM Priority

> Audit items Score 2.0–2.9 + existing feature requests

### [NQL] JSONB Operators Support — Effort: M (~4h)
- Operators: `->`, `->>`, `@>`, `<@`, `?`, `#>`, `#>>`
- Workaround: `raw()` escape hatch

### ~[Adapter] #8: Extract `buildReturningList()` helper~ — ✅ Already done (shared in mutation-compiler.ts)
### ~[Core] #28: Remove duplicate `isRecursiveIncludeOptions()`~ — ✅ Already clean (1 definition only)
### ~[Adapter] #11: Move AST helpers to internal export path~ — ✅ DONE (2026-02-01)
### ~[Adapter] #12: Move handler registry to internal export path~ — ✅ DONE (2026-02-01)
### [Core] IN subquery → relation traversal normalization — Effort: M
- `where id in (orders | select customerId | where ...)` is semantically identical to `where orders.status = ...`
- Planner should recognize IN-subquery patterns reducible to relation traversal and normalize
- Lets planner choose optimal strategy (JOIN, EXISTS, lateral) instead of forcing IN (SELECT ...)

### [Adapter] Enhance `singularize()` for irregular plurals — Effort: M
- `assert-field.ts:singularize()` handles basic English plurals only (trailing `s`, `ies`)
- Doesn't handle: children→child, people→person, data→datum, etc.
- Current behavior is sufficient for common table names (users, posts, categories)
- Enhancement: add lookup table for common irregular plurals or allow user override

### [Adapter] ON CONFLICT / Upsert support — Effort: M
- `ast-helpers.ts:668`: `// ON CONFLICT handling would go here (complex, defer for now)`
- Currently no upsert compilation; `compileUpsert()` exists but ON CONFLICT clause not built

### ~[Core] Type inference gaps (nullable refs, relations)~ — ✅ DONE (2026-02-02)
- Made `RefDefinition` and `ref()` generic to preserve literal option types
- Fixed: nullable FK inference, relation column access, inverse relations, custom relation names

### [Docs] DOCS-001: User documentation (Getting Started, API Guide)
### [Docs] DOCS-002: Migration guides (from-prisma, from-drizzle, from-kysely)
### [Docs] DOCS-003: Pattern guides (multi-tenant, recursive queries, window functions)

---

## Pending — LOW Priority

> Audit P2 items (Score < 2.0) — grouped by axis

### DRY Consolidation (2 remaining of 8)
- [-] ⏭️ Deferred: #29 CLI assertion factory — lower value, standalone story
- [-] ⏭️ Deferred: #33 adapter-pgsql test ratio — L-size, standalone story

### ~Dead Code Cleanup (4 items, ~2h)~ — 4/4 DONE
- ~#24 Remove `NqlLimitError` unused interface~ — ✅ DONE (2026-02-01) (NqlWarning is used)
- ~#25 Remove `_getRelationPath()` + `hasRelationPath()` dead functions~ — ✅ DONE (2026-02-01)
- ~#26 Remove `@deprecated namingConvention`~ — ✅ DONE (2026-02-02)
- ~#27 Remove `validate()` stub~ — ✅ DONE (2026-02-01)

### SRP / God Classes (4 items, ~40h)
- [-] ⏭️ Deferred: #16 NqlCstVisitor 1,349 LOC (was 1,510) — L-size, dedicated story
- [-] ⏭️ Deferred: #17 NQL compiler 1,142 LOC — L-size, dedicated story
- [-] ⏭️ Deferred: #18 PgsqlAdapter 1,592 LOC — L-size, dedicated story
- [-] ⏭️ Deferred: #21 compileSubqueryIncludeManyToMany — only 117 LOC (audit overestimated), low value

### Other
(Archived → docs/historic/done-2026-02.md)

---

## Blocked / Deferred

### [Adapter] Migration generation (diff-based ALTER statements) — Deferred
- Depends on: DDL generator maturity

### [Adapter] AST object pooling — Deferred (perf-gated)
### [Adapter] Async deparse optimization — Deferred (perf-gated)
### [-] ⏭️ Deferred: [NQL] IN (dateRange) — requires semantic date expansion (#NQL-GAP-3)
### [-] ⏭️ Deferred: [NQL] Window fn lag/lead offset/default — P3+ (`intent-ast.ts:399,474`)
### [-] ⏭️ Deferred: [NQL] UNION mode (vs UNION ALL) — not implemented (`intent-ast.ts:1151`)
### [-] ⏭️ Deferred: [Core] Cascade delete (multi-statement) — single delete only (`mutation-builders.ts:586`)
### [-] ⏭️ Deferred: [Adapter] `compileWithIncludes()` Phase 3 completion — partially implemented (`pgsql-adapter.ts:422`)
### [-] ⏭️ Deferred: [Adapter] Cycle detection placeholder — depends on `@pgsql/types` version (`cycle-detection.ts:144`)
### [NQL] CASE Expression Enhancements — Priority: LOW
### [CLI] Extract shared plan summary formatting — Priority: LOW
QuerySummary in ConversationView.tsx duplicates plan summary logic from OutputDisplay. Extract to shared utility.

### [CLI] .load <table> <file> — Bulk CSV/JSON import — Priority: LOW
### [CLI] RETURNING clause support — Priority: LOW
### [CLI] Transaction support (BEGIN/COMMIT/ROLLBACK) — Priority: LOW
### [CLI] Set operations (UNION, INTERSECT, EXCEPT) — Priority: LOW
### [Core] P3-B: FTSIntent (PostgreSQL Full-Text Search) — Priority: LOW
### [Adapter] P3-B: FTS Compiler (PostgreSQL) — Priority: LOW
### [Adapter] P3-D: FOR UPDATE SKIP LOCKED (Job Queue pattern) — Priority: LOW
### [Adapter] P3-E: Multi-dialect FTS (MySQL, SQLite) — Priority: LOW
### [Core] Future Native Adapters (adapter-mysql, adapter-sqlite)
### [Architecture] DX-032: Conformance Test Framework — Effort: M (~12h) — Depends on: multi-adapter

### Audit P3 items (deferred, Score < 1.0)
- #19 QueryBuilderImpl extraction (1,091 LOC) — L
- #20 Extend handler pattern to remaining compiler switch cases — L
- #30 QueryBuilder<T> interface ISP (30+ methods) — L
- #31 types.ts 26 exports in one file — M
- #34 intent-ast.ts 1,750 LOC single file — L

---

## Completed

(Archived → docs/historic/done-2026-02.md)
