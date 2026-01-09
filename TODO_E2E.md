# TODO: E2E Tests

**Phase:** P2
**Updated:** 2026-01-09

---

## Pending (Backlogged from Review)

### E2E-002 Edge Case: Q8-03 Strict Mode Ambiguity Error

**Source:** Review finding F-001 (NON-BLOCKING, LOW, Size M)
**Added:** 2026-01-09

- [ ] Implement strict mode in ORM config
- [ ] Add test: `should throw AmbiguousRelationError when querying 'users' without via hint`
- [ ] Add test: `should provide helpful error message with available relations`

**Blocked by:** DX-011 (strict mode implementation)

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
**Status:** ✅ COMPLETE (Phase 1 + Phase 2)
**Created:** 2026-01-08
**Completed:** 2026-01-09

## Summary

Implemented 10 realistic PIM/DAM use cases as E2E tests validating API capabilities:
- P0 (discriminating): Q1-Q5 (completeness, fallback, variants, assets)
- P1 (enterprise): Q6-Q8 (category tree, BOM, ambiguity)
- P2 (robustness): Q9-Q10 (multi-tenant, capabilities)

**Total E2E Tests:** 192 (186 + 6 Q8-06 junction tests)

---

## Phase 2 Completed (2026-01-09)

### E2E Test Files

- [x] ✅ Block 5: Q1 Completeness tests - 12 tests (2026-01-09)
- [x] ✅ Block 7: Q3-Q5 Variants and assets tests - 12 tests (2026-01-09)
- [x] ✅ Block 8: Q6 Category tree tests - 8 tests (2026-01-09)
- [x] ✅ Block 9: Q7 BOM/Bundle tests - 7 tests (2026-01-09)
- [x] ✅ Block 10: Q8 Ambiguity via/role tests - 20 tests (2026-01-09)
  - Q8-01 to Q8-05: FK-based disambiguation (author_id/reviewer_id → users)
  - Q8-06: Junction table with role column (product_images.role → main/gallery/thumbnail)

### Verification

- [x] ✅ Block 11: Q9 multi-tenant coverage verified - 9 tests in pimdam.q4.multitenant.test.ts (2026-01-09)
- [x] ✅ Block 12: Q10 capabilities coverage verified - 56+ tests in dialect.test.ts (2026-01-09)

---

## Phase 1 Completed (2026-01-08)

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
