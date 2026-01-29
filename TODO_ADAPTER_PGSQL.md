# TODO: adapter-pgsql Full Forward Phase 1

**Spec:** docs/plans/ADAPTER-PGSQL-FULL-FORWARD.md
**Status:** 🟡 IN PROGRESS
**Started:** 2026-01-29

## Pending

- [ ] Block 1: Handler Infrastructure (registry, types, validateIdentifier)
- [ ] Block 2: WHERE Handlers Simple (comparison, like, in, null, range, logical)
- [ ] Block 3: WHERE Handlers Complex (exists, subquery, relation-filter)
- [ ] Block 4: EXPRESSION Handlers (column, aggregate, case, coalesce, window, raw)
- [ ] Block 5: INCLUDE Strategies (join, lateral, json-agg, cte)
- [ ] Block 6: Pseudo-Columns + Relation Columns
- [ ] Block 7: Recursive CTE Compiler
- [ ] Block 8: Mutation Compiler (insert, update, delete, upsert)
- [ ] Block 9: Streaming + EXPLAIN
- [ ] Block 10: ComparisonAdapter + Integration

## In Progress

(none)

## Completed

- [x] Spike complete (201 tests) — 2026-01-29

## Deferred (Phase 2+)

- [ ] Introspection (pg_catalog → ModelIR)
- [ ] DDL generation
- [ ] AST object pooling (if perf issue measured)
- [ ] Async deparse (if perf issue measured)

## Sunset (when adapter-kysely is removed)

- [ ] Delete `ComparisonAdapter` (temporary migration tool)
- [ ] Delete `DBSP_COMPARISON_MODE` env var handling
- [ ] Delete `packages/adapter-kysely/` entirely
- [ ] Update all imports to use `@dbsp/adapter-pgsql`
