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

## Pending - P1

### DX-001: Strict Mode

- [ ] :red_circle: [HIGH] strictMode option in createOrm()
- [ ] :red_circle: [HIGH] AmbiguousRelationError class
  - message: "Ambiguous relation 'X' on Y. Available: [...]"
  - options: string[] (available relation names)
  - source: string (source table)
  - target: string (target table hint)
- [ ] :red_circle: [HIGH] Q3 golden test validation
  - Throws when include('posts') with multiple relations to Post
  - Error includes ['createdPosts', 'editedPosts']
- [ ] Behavior matrix:
  | Scenario | strictMode: true | strictMode: false |
  |----------|------------------|-------------------|
  | Ambiguous | Throws | Warn + use first |
  | With via | Works | Works |
  | Unambiguous | Works | Works |

### DX-002: Override API

- [ ] include(relation, { via: 'relationName' })
  - Disambiguates which path to use
- [ ] withRelationHint(targetTable, relationName)
  - Per-query default for a target
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

(none)

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
- [x] Strict mode: warn vs error? → **error in strict mode, warn otherwise**
- [ ] Which Drizzle helpers to prioritize? → Start with eq/and/or/exists
