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

### Block 1: E2E Parity ✅ Complete (2026-01-29)

- [x] ✅ Wire PgsqlAdapter as default in E2E testkit (2026-01-29)
- [x] ✅ Fix intent-to-decisions converter for E2E integration (2026-01-29)
- [x] ✅ Fix nested AND/OR/NOT condition compilation (2026-01-29)
- [x] ✅ Fix COALESCE using proper CoalesceExpr AST node (2026-01-29)
- [x] ✅ Fix EXISTS/NOT EXISTS compilation with FK resolution from model (2026-01-29)
- [x] ✅ Fix json_agg relationName priority (includeAlias ?? relation) (2026-01-29)
- [x] ✅ Fix range type enrichment with model-based dataType (2026-01-29)
- [x] ✅ Fix scalar type casting for @> point containment (2026-01-29)
- [x] ✅ Achieve 291/291 E2E test parity (87 → 0 failures) (2026-01-29)

### Block 2-4: Migration (pending)

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

## Refactoring Backlog (discovered during Phase 3)

- [ ] **Single source of truth for json_agg relation name**: Currently `extractJsonAggDecisions` (adapter) and `hydration-utils.ts` (core) both compute the relation alias independently with `includeAlias ?? relation`. Centraliser la décision dans le PlanReport pour éliminer la duplication.
- [x] ✅ **Remove duplicate range operator switch cases** (2026-01-30): Dead code removed from `compileCondition` switch — range ops handled by early return.
- [x] ✅ **Fragile SQL assertions (`toContain`)** (2026-01-30): `db.output` table assertion added to CLI parser+runner with 19 unit tests. Fixed `batch.ts` to forward `rows`/`columns` from `ExecutionResult` to `BatchResult`. Validated E2E against real PostgreSQL — `blog-extended.assert.dbsp` uses `db.output:` table block for authors query (291/291 E2E pass).
- [x] ✅ **Model.getTable() naming confusion** (2026-01-30): `resolveLogicalName()` utility added in `naming.ts` with 11 unit tests.
- [x] ✅ **JOIN compilation for filter-strategy** (2026-01-30): JOIN filter dispatch added to compiler for `choice === 'join'` decisions. 8 unit tests.
- [x] ✅ **LEFT JOIN compilation for include-strategy** (2026-01-30): LEFT JOIN include dispatch added for `selectLeftJoinInclude` decisions. 6 unit tests.
- [x] ✅ **BUG: Pseudo-column filter on relation path generates invalid SQL** (2026-01-30): Fixed in adapter-kysely — relation-path fields (e.g., `roomBookings.bookingPeriod`) now compile as EXISTS subqueries instead of invalid 3-level column refs. Added `parseRelationPathField()` helper, converted comparison/range handlers to factory pattern. Updated `scheduling.assert.dbsp` Q15. 290/291 E2E pass.
- [x] ✅ **BUG: LATERAL JOIN schema qualification** (2026-01-30): Fixed in `adapter-kysely/lateral.ts` — separate schema/table identifiers + inner alias for WHERE clause. Updated assertions in `ecommerce.assert.dbsp` (Q10/Q11) and `test-blog.assert.dbsp` (Q8/Q9). 290/291 E2E pass.
- [ ] **BUG: `via` hint ambiguity resolution generates invalid SQL**: `pimdam.q8.ambiguity.test.ts` Q8-07 — query with `via` hint to resolve ambiguous relations produces `invalid reference to FROM-clause entry for table "products"`. The compiler emits a table reference that PostgreSQL rejects because the alias/scope is incorrect. Repro: `pimdam.q8.ambiguity.test.ts > Q8-07: should execute query successfully when ambiguity is resolved with via hint`.
- [ ] **CTE/WITH clause generation**: Multi-EXISTS patterns are compiled as flat WHERE conditions. Implement CTE extraction for complex multi-locale/multi-filter patterns.
- [ ] **Split extractExistsDecisions**: Method does 3 things (filter decisions, find intents, resolve FK). Extract into smaller focused functions for readability.
- [ ] **Refactor: extract relation-path detection to shared helper**: `comparison.ts` and `range.ts` both duplicate identical relation-path → EXISTS logic (lines 37-67). Extract to a shared `compileRelationPathAsExists()` helper. Low priority.

---

## Deferred

- [ ] Migration generation (diff-based ALTER statements)
- [ ] AST object pooling (if perf issue measured)
- [ ] Async deparse optimization (if perf issue measured)
