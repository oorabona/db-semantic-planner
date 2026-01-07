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

### DX-002: Override API

**Note:** Per-query `strictMode` override explicitly deferred here from DX-001.

- [ ] Per-query `strictMode` override: `query.withStrictMode(true)`
- [ ] include(relation, { via: 'relationName' })
  - Disambiguates which path to use
- [ ] withRelationHint(targetTable, relationName)
  - Per-query default for a target
- [ ] Global relation hints in `OrmOptions`
- [ ] Integration with planner
  - Pass hints to planner, skip ambiguity error

### DX-003: Compat Layer (Drizzle-like)

#### Filter Helpers

- [ ] eq(field, value): WhereIntent
- [ ] neq(field, value): WhereIntent
- [ ] gt(field, value): WhereIntent
- [ ] gte(field, value): WhereIntent
- [ ] lt(field, value): WhereIntent
- [ ] lte(field, value): WhereIntent
- [ ] like(field, pattern): WhereIntent
- [ ] isNull(field): WhereIntent
- [ ] isNotNull(field): WhereIntent
- [ ] inArray(field, values): WhereIntent
- [ ] and(...conditions): WhereIntent
- [ ] or(...conditions): WhereIntent
- [ ] not(condition): WhereIntent

#### Query Shortcuts

- [ ] Model.findMany(options): Promise<T[]>
- [ ] Model.findFirst(options): Promise<T | undefined>
- [ ] Model.findFirstOrThrow(options): Promise<T>
- [ ] Options: { where?, select?, include?, orderBy?, limit?, offset? }

#### Exists Helper

- [ ] exists(relation, options): WhereIntent
  - Convenience wrapper for { type: 'exists', ... }

---

## Completed

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
- [ ] Which Drizzle helpers to prioritize? → Start with eq/and/or/exists
