# TODO: adapter-pgsql

**Goal:** Sunset adapter-kysely → adapter-pgsql devient l'unique adapter

## Phase 1: Full Forward ✅ Complete (2026-01-29)

**Spec:** docs/plans/ADAPTER-PGSQL-FULL-FORWARD.md
**Tests:** 413 tests passing

- [x] Block 1: Package scaffold + AST helpers
- [x] Block 2: Handler registry + WHERE handlers
- [x] Block 3: Expression handlers
- [x] Block 4: Include strategies (JOIN, SUBQUERY, LATERAL, CTE)
- [x] Block 5: Plan Compiler foundation
- [x] Block 6: Naming plugins (camelCase ↔ snake_case)
- [x] Block 7: Recursive CTE compiler
- [x] Block 8: Mutation compiler (INSERT/UPDATE/DELETE/UPSERT)
- [x] Block 9: EXPLAIN + Streaming (cursors)
- [x] Block 10: ComparisonAdapter + Integration

---

## Phase 2: Parity Validation ✅ Complete (2026-01-29)

**Goal:** Ensure adapter-pgsql produces identical SQL to adapter-kysely
**Spec:** docs/plans/ADAPTER-PGSQL-PHASE2-PARITY.md
**Result:** Full parity achieved - 291 E2E tests, 0 mismatches, 464 unit tests

- [x] ✅ Wire PgsqlAdapter to core's Adapter interface (2026-01-29)
- [x] ✅ Enable DBSP_COMPARISON_MODE=compare in E2E tests (2026-01-29)
- [x] ✅ Run full E2E suite with comparison mode (2026-01-29) - 291 tests, 0 mismatches
- [x] ✅ Fix any SQL mismatches found (2026-01-29) - none found, adapters are at parity
- [x] ✅ Enable DBSP_COMPARISON_MODE=strict (2026-01-29) - all tests pass
- [x] ✅ Document any intentional divergences (2026-01-29) - none, full parity achieved
- [x] ✅ DDL generation (CREATE TABLE, ALTER, DROP) (2026-01-29)

---

## Phase 3: Migration & Sunset

**Goal:** Replace adapter-kysely with adapter-pgsql

- [ ] Update all imports to use @dbsp/adapter-pgsql
- [ ] Update createOrm() to use PgsqlAdapter by default
- [ ] Update documentation and examples
- [ ] Deprecation notice in adapter-kysely
- [ ] Remove adapter-kysely package
- [ ] Delete ComparisonAdapter (no longer needed)
- [ ] Delete DBSP_COMPARISON_MODE handling

---

## Phase 4: Introspection (Post-Sunset)

**Goal:** pg_catalog → ModelIR (schema discovery from live DB)

- [ ] Query pg_catalog for tables, columns, types
- [ ] Query pg_catalog for primary keys, foreign keys
- [ ] Query pg_catalog for indexes, constraints
- [ ] Build ModelIR from introspection results
- [ ] Support schema filtering (public, tenant_*)
- [ ] Caching strategy for introspected schema

---

## Deferred

- [ ] Migration generation (diff-based ALTER statements)
- [ ] AST object pooling (if perf issue measured)
- [ ] Async deparse optimization (if perf issue measured)
