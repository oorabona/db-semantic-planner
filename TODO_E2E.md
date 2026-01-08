# TODO: E2E Tests

**Phase:** P2
**Updated:** 2026-01-08

---

## In Progress

(empty)

---

## Completed

### E2E-003: IAM/RBAC Recursive CTE Validation ✅

**Spec:** docs/specs/E2E-003-iam-rbac-recursive.md
**Status:** ✅ COMPLETE
**Created:** 2026-01-08
**Completed:** 2026-01-08

- [x] ✅ Block 1: IAM Schema DDL + Seed + Model (2026-01-08)
- [x] ✅ Block 2: Effective Permissions E2E Test (2026-01-08)
- [x] ✅ Block 3: Role Hierarchy Traversal E2E Test (2026-01-08)
- [x] ✅ Block 4: Separation of Duty E2E Test (2026-01-08)

**Summary:** 9 E2E tests validating recursive CTE queries for IAM/RBAC scenarios:
- Effective permissions via role hierarchy (3 tests)
- Role hierarchy traversal with depth/path tracking (3 tests)
- Separation of Duty detection (3 tests)

---

### E2E-002: PIM/DAM Realistic Scenarios ✅

**Spec:** docs/specs/E2E-002-pimdam-realistic-scenarios.md
**Status:** ✅ PHASE 1 COMPLETE (COALESCE API)
**Created:** 2026-01-08
**Updated:** 2026-01-08

## Summary

Implement 10 realistic PIM/DAM use cases as E2E tests to validate API capabilities:
- P0 (discriminating): Q1-Q5 (completeness, fallback, variants, assets)
- P1 (enterprise): Q6-Q8 (category tree, BOM, ambiguity)
- P2 (robustness): Q9-Q10 (multi-tenant, capabilities)

**Blocker RESOLVED:** COALESCE expressions API implemented (Blocks 1-3)

---

## Pending (Phase 2 - Deferred)

### E2E Test Files

- [ ] Block 5: Q1 Completeness tests (M)
- [ ] Block 7: Q3-Q5 Variants and assets tests (M)
- [ ] Block 8: Q6 Category tree tests (S)
- [ ] Block 9: Q7 BOM/Bundle tests (M)
- [ ] Block 10: Q8 Ambiguity via/role tests (S)

### Verification

- [ ] Block 11: Verify Q9 multi-tenant coverage (S)
- [ ] Block 12: Verify Q10 capabilities coverage (S)

---

## In Progress

(empty)

---

## Completed

- [x] ✅ Phase 0: Knowledge discovery (2026-01-08)
- [x] ✅ Stage 1: /clarify - Requirements analysis (2026-01-08)
- [x] ✅ Stage 2: /spec - E2E-002 specification created (2026-01-08)
- [x] ✅ Block 1: Core expression types in intent-ast.ts (2026-01-08)
- [x] ✅ Block 2: Adapter expression compiler (2026-01-08)
- [x] ✅ Block 3: DX coalesce() helper + unit tests (2026-01-08)
- [x] ✅ Block 6: Q2 Locale fallback E2E test structure (2026-01-08)

---

## Dependencies

| Block | Depends On |
|-------|------------|
| Block 2 | Block 1 |
| Block 3 | Block 1 |
| Block 5 | Block 4 |
| Block 6 | Blocks 1, 2, 3, 4 |
| Block 7 | Block 4 |
| Block 8 | Block 4 |
| Block 9 | Block 4 |
| Block 10 | Block 4 |

---

## Test Counts (Target)

| File | Tests | Status |
|------|-------|--------|
| q1.completeness | 3 | pending |
| q2.cte-multilocale | 8 | exists (extend) |
| q3.variants | 3 | pending |
| q4.expiring-assets | 3 | pending |
| q5.unused-assets | 3 | pending |
| q6.category-tree | 3 | pending |
| q7.bundles | 3 | pending |
| q8.ambiguity | 3 | pending |
| q9.multitenant | 9 | exists (verify) |
| q10.capabilities | 3 | partial (verify) |
| **Total** | **~41** | |
