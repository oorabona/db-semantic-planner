# DX (Developer Experience) Scope Backlog (`packages/dx`)

**Package:** `packages/dx`
**Phase:** P1 (after MVP)
**Dependencies:** `packages/core`, `packages/adapter-kysely`

## Architecture Constraint

```
Imports from: packages/core, packages/adapter-kysely
This is a LEAF package (nothing depends on it)
```

---

## In Progress

(none)

---

## Pending - P1

(none)

---

## Completed

### DX-003: Compat Layer ✅ (2026-01-07)

**Spec:** [docs/specs/DX-003-compat-layer.md](docs/specs/DX-003-compat-layer.md)

#### Filter Helpers (14 functions)

- [x] ✅ eq(field, value): WhereComparisonIntent
- [x] ✅ neq(field, value): WhereComparisonIntent
- [x] ✅ gt(field, value): WhereComparisonIntent
- [x] ✅ gte(field, value): WhereComparisonIntent
- [x] ✅ lt(field, value): WhereComparisonIntent
- [x] ✅ lte(field, value): WhereComparisonIntent
- [x] ✅ like(field, pattern, caseInsensitive?): WhereLikeIntent
- [x] ✅ isNull(field): WhereNullIntent
- [x] ✅ isNotNull(field): WhereNullIntent
- [x] ✅ inArray(field, values): WhereInIntent
- [x] ✅ and(...conditions): WhereAndIntent
- [x] ✅ or(...conditions): WhereOrIntent
- [x] ✅ not(condition): WhereNotIntent
- [x] ✅ exists(relation, { where? }): WhereExistsIntent
- [x] ✅ notExists(relation, { where? }): WhereNotExistsIntent

#### Query Execution Methods

- [x] ✅ findMany(): Promise<unknown[]>
- [x] ✅ findFirst(): Promise<unknown | undefined>
- [x] ✅ findFirstOrThrow(): Promise<unknown>
- [x] ✅ `db` option in `OrmOptions` for Kysely instance

#### Multi-tenant Execution

- [x] ✅ forTenant(schemaName): OrmInstance - scoped to tenant schema

#### Error Classes

- [x] ✅ ExecutionError - thrown when db not configured
- [x] ✅ NotFoundError - thrown by findFirstOrThrow() when no results

#### Tests

- [x] ✅ 106 tests passing (30 filters + 12 errors + 27 strict-mode + 21 override + 16 execution)

### DX-002: Override API ✅ (2026-01-07)

- [x] ✅ Per-query `strictMode` override: `query.withStrictMode(true)`
- [x] ✅ include(relation, { via: 'relationName' }) - Already existed from DX-001
- [x] ✅ withRelationHint(targetTable, relationName)
  - Per-query default for a target
- [x] ✅ Global `relationHints` in `OrmOptions`
- [x] ✅ Integration with planner
  - Hints applied to includes before planning
  - Explicit via takes precedence over hints
  - Nested includes supported
- [x] ✅ 21 tests passing (override-api.test.ts)

### DX-001: Strict Mode ✅ (2026-01-07)

**Spec:** [docs/specs/DX-001-strict-mode.md](docs/specs/DX-001-strict-mode.md)

#### Delivered

- [x] ✅ `strictMode` option in `createOrm()` (default: false)
- [x] ✅ `AmbiguousRelationError` class with:
  - `sourceTable`, `targetTable`, `options` properties
  - Proper `instanceof` support
  - Disambiguation hint in message
- [x] ✅ Behavior matrix:
  | Scenario | strictMode: true | strictMode: false |
  |----------|------------------|-------------------|
  | Ambiguous | Throws `AmbiguousRelationError` | Warn + use first |
  | With via | Works | Works |
  | Unambiguous | Works | Works |
- [x] ✅ `include({ via })` syntax for disambiguation
- [x] ✅ 33 passing tests (9 BDD scenarios + additional edge cases)
- [x] ✅ Integration verified: `pnpm -r test` and `pnpm -r typecheck` pass

## Blocked / Deferred

(none)

---

## Golden Test Owned by DX

| Test | Component | Validation |
|------|-----------|------------|
| Q3 | Strict mode | Throws AmbiguousRelationError with options |

## Non-Goals (P1)

- No Prisma-like nested writes
- No automatic relation inference
- No runtime type validation

## Open Questions

- [x] Should compat layer be a separate package? → **No, part of packages/dx**
- [x] Strict mode: warn vs error? → **error in strict mode, warning in plan.warnings otherwise**
- [x] Console.warn for lenient mode? → **No, use existing PlanReport.warnings**
- [x] Which Drizzle helpers to prioritize? → ✅ Implemented all 14 in DX-003
