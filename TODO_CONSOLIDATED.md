# Consolidated Improvement Plan

**Created:** 2026-01-31
**Source:** Audit BACKLOG + all scope TODOs (excluding MCP)
**Tracking:** This file is the source of truth. Update after EVERY completion.

---

## Phase 1: P0 Documentation (Audit #1-3) — Score 16.0+

| # | Task | Audit # | Status |
|---|------|---------|--------|
| 1.1 | Rewrite README.md — remove `@dbsp/adapter-kysely` + `@dbsp/schema` refs, update examples to `createPgsqlAdapter` | #1, #3, #8 | ✅ (2026-01-31) |
| 1.2 | Update CLAUDE.md — fix architecture diagram, API examples, package refs | #2 | ✅ (2026-01-31) |
| 1.3 | Update DOCUMENTATION_INDEX.md — fix package list, test counts, architecture diagram | #4 | ✅ (2026-01-31) |

**Exit criteria:** All 3 user-facing docs reference `adapter-pgsql`, `@dbsp/core` (not `@dbsp/schema`), correct API patterns.

---

## Phase 2: P1 Spec Statuses + Bug Fix

| # | Task | Source | Status |
|---|------|--------|--------|
| 2.1 | ARCH-006 spec: change status "Draft" → "Canonical" | Audit #6 | ✅ (2026-01-31) |
| 2.2 | ARCH-002 spec: add note about packages/schema merge into core | Audit KNOWLEDGE | ✅ (2026-01-31) |
| 2.3 | DX-040 status: update from "draft" to "complete" in doc index | Audit KNOWLEDGE | ✅ (2026-01-31) |
| 2.4 | Fix bug: `via` hint ambiguity → invalid SQL (Q8-07) | TODO_ADAPTER_PGSQL | ✅ (2026-01-31) |

**Exit criteria:** Spec statuses accurate. Q8-07 test passes (`pimdam.q8.ambiguity.test.ts`).

---

## Phase 3: Quick Wins Audit P2 (Score ≥ 2.0, Effort S)

| # | Task | Audit # | Score | Status |
|---|------|---------|-------|--------|
| 3.1 | Extract shared RETURNING clause compilation (5 locations → 1 helper) | #15 | 2.0 | ✅ (2026-01-31) |
| 3.2 | Extract shared FK derivation utility (2 locations → 1) | #16 | 2.0 | ✅ (2026-01-31) |
| 3.3 | Replace `Math.random()` with `crypto.randomUUID()` for cursor names | #23 | 1.0 | ✅ (2026-01-31) |
| 3.4 | Log rollback errors at debug level (silent suppression) | #24 | 1.0 | ✅ (2026-01-31) |
| 3.5 | Mark `validate()` stub as @deprecated in NQL | #25 | 1.0 | ✅ (2026-01-31) |
| 3.6 | Remove deprecated exports (NqlCompilerFn, nqlCompiler option) | #26 | 1.0 | ✅ (2026-01-31) |
| 3.7 | Replace 61 `throw new Error()` with NqlError in visitor | #13 | 2.0 | ⏸️ Deferred — needs NqlError class (not just interface), sized M not S |

**Exit criteria:** All quick wins applied. Tests green. No regressions.

---

## Phase 4: Features (Priority Order)

### 4A: DX-033 Include Execution with Hydration (8 tasks)

| # | Task | Status |
|---|------|--------|
| 4A.1 | Add `executeWithIncludes()` function in orm.ts | - [ ] |
| 4A.2 | Execute main query via adapter | - [ ] |
| 4A.3 | Extract parent IDs from main result | - [ ] |
| 4A.4 | Execute separate include queries via `compileSeparateInclude()` | - [ ] |
| 4A.5 | Group child results by foreign key | - [ ] |
| 4A.6 | Hydrate parent objects with nested children | - [ ] |
| 4A.7 | Handle nested includes (recursive hydration) | - [ ] |
| 4A.8 | Add integration tests | - [ ] |

### 4B: DX-041 Subquery Include Strategy (5 tasks)

| # | Task | Status |
|---|------|--------|
| 4B.1 | Add `'subquery'` to IncludeStrategy type | - [ ] |
| 4B.2 | Implement in planner strategy selection | - [ ] |
| 4B.3 | Implement in adapter-pgsql compiler | - [ ] |
| 4B.4 | Re-enable skipped hydration tests in orm-execution.test.ts | - [ ] |
| 4B.5 | Add `defaultIncludeStrategy` back to SimplifiedOrmOptions | - [ ] |

### 4C: Phase 4 Introspection PostgreSQL (8 tasks)

| # | Task | Status |
|---|------|--------|
| 4C.1 | Query pg_catalog for tables, columns, types | - [ ] |
| 4C.2 | Query pg_catalog for primary keys, foreign keys | - [ ] |
| 4C.3 | Query pg_catalog for indexes, constraints | - [ ] |
| 4C.4 | Build ModelIR from introspection results | - [ ] |
| 4C.5 | Support schema filtering (public, tenant_*) | - [ ] |
| 4C.6 | Caching strategy for introspected schema | - [ ] |
| 4C.7 | pg_catalog queries → ModelIR (core side) | - [ ] |
| 4C.8 | Full IntrospectingAdapter implementation | - [ ] |

**Exit criteria per feature:** Tests pass, dump() works, E2E validates.

---

## Phase 5: Refactors P2 Maintainability (Large, Low Priority)

| # | Task | Audit # | Score | Effort | Status |
|---|------|---------|-------|--------|--------|
| 5.1 | Split `NqlCstVisitor` into specialized visitors | #7 | 1.5 | L | - [ ] |
| 5.2 | Refactor `PgsqlAdapter` (extract services) | #8 | 1.2 | XL | - [ ] |
| 5.3 | Refactor `QueryBuilderImpl` (extract concerns) | #9 | 1.2 | L | - [ ] |
| 5.4 | Extend handler pattern to all 44 compiler decisions | #10 | 1.5 | L | - [ ] |
| 5.5 | Split `batch.ts` into command modules | #11 | 1.3 | M | - [ ] |
| 5.6 | Split `assertion-runner.ts` by assertion type | #12 | 1.3 | M | - [ ] |
| 5.7 | Extract window functions from `filters.ts` | #19 | 0.7 | M | - [ ] |

**Exit criteria:** Each refactor is behavior-preserving. All existing tests still pass.

---

## Not In Scope (tracked elsewhere)

| Item | Where | Why deferred |
|------|-------|--------------|
| MCP Server | TODO_MCP.md | Excluded per user request |
| CLI v2 features | TODO_CLI.md | Deferred to v2 |
| adapter-mysql / adapter-sqlite | TODO.md | Future adapters |
| NQL v2.2+ (batch streaming, per-relation pagination) | TODO_NQL.md | Deferred |
| FTS + JSONB (core + adapter + NQL) | TODO_CORE/ADAPTER/NQL | Medium priority, after Phase 4 |
| DX-032 Conformance Tests | TODO.md | After multi-adapter |
| DOCS-001/002/003 | TODO.md | After features stabilize |
| adapter-pgsql coverage 0.36→0.50 | Audit #27 | Progressive during features |
| types package: 0 tests | Audit #28 | P3, low score |
| `any` types in result-hydrator | Audit #20 | P3 |
| `unknown[]` in types | Audit #21 | P3 |
| `QueryBuilder<T>` 30+ methods ISP | Audit #17 | P3, architectural |
| `types.ts` 26 types split | Audit #18 | P3, cosmetic |
| `clone()` DRY (20+ occurrences) | Audit #14 | P3, needs decorator pattern |
| Raw SQL audit trail | Audit #22 | P2, after security review |

---

## Progress Log

| Date | Phase | Items Done | Notes |
|------|-------|------------|-------|
| 2026-01-31 | Setup | 0 | Plan created |
| 2026-01-31 | Phase 1 | 3/3 | README, CLAUDE.md, DOC_INDEX updated. Also fixed DX-040 status (Phase 2.3) |
| 2026-01-31 | Phase 2 | 4/4 | ARCH-006 Canonical, ARCH-002 merge note, DX-040 complete, Q8-07 via hint bug fixed (reversed priority in resolveIncludeAlias + extractLeftJoinIncludeDecisions). Also removed shouldSkipE2E from 22 test files. |
| 2026-01-31 | Phase 3 | 6/7 | RETURNING helper (5→1), FK derivation helper (2→1), crypto.randomUUID, rollback debug logging, validate() @deprecated, removed NqlCompilerFn+nqlCompiler. Item 3.7 deferred (needs NqlError class, sized M). All tests green: adapter 468, core 820, nql 257. |

