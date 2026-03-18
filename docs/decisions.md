# Architecture Decisions

Decisions archived from workflow — newest first.

---

## DDL-FK-IDX — emit FK + indexes for new tables in migration SQL (2026-03-18)

- Fix in compareSchemata: emit add_foreign_key + create_index changes for new tables before the continue statement
- No changes to generateCreateTableSQL — composite UNIQUE handled via CREATE UNIQUE INDEX path
- Topological order preserved naturally via existing getPhase() dispatcher (create_table=5, add_fk=9, create_index=11)

---

## AGG-001 — FILTER clause support in aggregates (2026-03-18)

- Reuse existing `funcCall()` helper's `filter?: Node` param (sets `agg_filter` on FuncCall AST) — no new AST work
- Added `filter?: WhereIntent` to `AggregateExpressionIntent` — compiled via same pipeline as WHERE clauses
- NQL grammar extension for FILTER out of scope — API/intent only for now
- DX builder `.filter()` returns immutable copy via spread pattern (consistent with existing builders)

---

## DX-050 — dbType escape hatch for schema DSL (2026-03-18)

- Reuse existing `ColumnIR.originalDbType` field (populated by introspection) — no new IR field needed
- Case-insensitive comparison in schema-diff via `.toLowerCase()`
- Fallback to base type comparison when `originalDbType` absent on either side
- Used `areTypesEquivalent()` for base type fallback (existing function handles type aliases)
- No `dbType` validation — developer-only input, same trust level as table/column names
