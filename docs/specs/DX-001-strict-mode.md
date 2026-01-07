---
doc-meta:
  status: canonical
  scope: dx
  type: specification
  created: 2026-01-07
  updated: 2026-01-07
---

# Specification: DX-001 - Strict Mode

## Overview

Implement configurable strict mode for ambiguous relation handling in a new `packages/dx` package.

**Clarifications Applied:**
- No backward compatibility with `AmbiguousPlanError` - fresh `AmbiguousRelationError` class
- No `console.warn` - leverage existing `PlanReport.warnings` for lenient mode
- Per-query `strictMode` override is DX-002 scope (not this spec)

---

## 1. User Stories

### US-1: Strict Mode for Development Safety

```
AS A developer building queries against complex schemas
I WANT strict mode to fail-fast on ambiguous relations
SO THAT I catch configuration errors during development rather than production
```

**ACCEPTANCE:** When `strictMode: true` and relation is ambiguous, `AmbiguousRelationError` is thrown with available options.

### US-2: Lenient Mode for Graceful Degradation

```
AS A developer deploying to production
I WANT lenient mode to resolve ambiguity automatically with warnings
SO THAT my application doesn't crash on edge cases while I can still audit issues
```

**ACCEPTANCE:** When `strictMode: false` and relation is ambiguous, first relation is used and warning is recorded in `plan.warnings`.

### US-3: Explicit Disambiguation

```
AS A developer with ambiguous relations
I WANT to specify which relation to use via `{ via: 'relationName' }`
SO THAT I can be explicit without relying on automatic resolution
```

**ACCEPTANCE:** `include('target', { via: 'relationName' })` resolves ambiguity in both strict and lenient modes.

---

## 2. Business Rules

### Invariants (always true)

| ID | Rule |
|----|------|
| INV-1 | `AmbiguousRelationError` must include `sourceTable`, `targetTable`, and `options` array |
| INV-2 | `options` array must contain all valid relation names to the target |
| INV-3 | Lenient mode warnings must appear in `PlanReport.warnings` with code `AMBIGUOUS_RELATION` |
| INV-4 | Unambiguous relations work identically in both modes |
| INV-5 | `via` hint must match an existing relation name |

### Behavior Matrix

| Scenario | `strictMode: true` | `strictMode: false` (default) |
|----------|--------------------|-----------------------------|
| Ambiguous relation, no `via` | Throws `AmbiguousRelationError` | Uses first relation, adds warning |
| Ambiguous relation, with `via` | Resolves to specified relation | Resolves to specified relation |
| Unambiguous relation | Works normally | Works normally |
| Invalid `via` (non-existent) | Throws error (from planner) | Throws error (from planner) |

### Default Behavior

- `strictMode` defaults to `false` (lenient)
- First relation is determined by schema definition order (stable, deterministic)

### Error Contract

```typescript
class AmbiguousRelationError extends Error {
  readonly name = 'AmbiguousRelationError';
  readonly sourceTable: string;
  readonly targetTable: string;
  readonly options: readonly string[];

  // Message format:
  // "Ambiguous relation to 'posts' from 'users'. Available relations: authoredPosts, reviewedPosts. Use { via: 'relationName' } to disambiguate."
}
```

---

## 3. Technical Impact

### Package Structure: `packages/dx`

```
packages/dx/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts           # Public exports
│   ├── types.ts           # OrmOptions, StrictModeConfig
│   ├── errors.ts          # AmbiguousRelationError
│   ├── orm.ts             # createOrm() factory
│   ├── query-builder.ts   # Query builder wrapper
│   └── orm.test.ts        # Unit tests
│   └── strict-mode.test.ts # Strict mode specific tests
└── vitest.config.ts
```

### Layer Impact

| Layer | Changes | Validation |
|-------|---------|------------|
| Types | `OrmOptions`, `IncludeOptions` | Type inference works |
| Errors | `AmbiguousRelationError` class | `instanceof` works correctly |
| Factory | `createOrm()` with `strictMode` | Returns configured ORM |
| Query Builder | `include()` with `{ via }` option | Passes hint to planner |
| Integration | Uses `@db-semantic-planner/core` planner | Catches `AmbiguousPlanError`, converts/re-throws |

### Dependency Flow

```
packages/dx
  ├── imports: @db-semantic-planner/core (plan, AmbiguousPlanError, types)
  └── peer: kysely (for type inference only)
```

### Public API

```typescript
// packages/dx/src/index.ts
export { createOrm } from './orm.js';
export { AmbiguousRelationError } from './errors.js';
export type { OrmOptions, OrmInstance, IncludeOptions } from './types.js';
```

---

## 4. Acceptance Criteria (BDD Scenarios)

### Feature: Strict Mode Ambiguity Detection

#### Scenario 1: Strict mode throws on ambiguous relation (nominal)

```gherkin
Scenario: Strict mode throws on ambiguous relation
  Given a schema with User having "authoredPosts" and "reviewedPosts" to Post
  And an ORM created with strictMode: true
  When I query User and include "posts" without via hint
  Then AmbiguousRelationError is thrown
  And error.sourceTable equals "users"
  And error.targetTable equals "posts"
  And error.options contains "authoredPosts" and "reviewedPosts"
  And error.message contains "Use { via: 'relationName' }"
```

#### Scenario 2: Lenient mode resolves with warning (nominal)

```gherkin
Scenario: Lenient mode resolves ambiguity with warning
  Given a schema with User having "authoredPosts" and "reviewedPosts" to Post
  And an ORM created with strictMode: false
  When I query User and include "posts" without via hint
  Then query succeeds without throwing
  And plan.warnings contains entry with code "AMBIGUOUS_RELATION"
  And the warning message mentions "authoredPosts" (first relation used)
```

#### Scenario 3: Via hint resolves ambiguity in strict mode (nominal)

```gherkin
Scenario: Via hint resolves ambiguity in strict mode
  Given a schema with User having "authoredPosts" and "reviewedPosts" to Post
  And an ORM created with strictMode: true
  When I query User and include("posts", { via: "reviewedPosts" })
  Then query succeeds without throwing
  And plan uses "reviewedPosts" relation
```

#### Scenario 4: Via hint works in lenient mode (nominal)

```gherkin
Scenario: Via hint works in lenient mode
  Given a schema with User having "authoredPosts" and "reviewedPosts" to Post
  And an ORM created with strictMode: false
  When I query User and include("posts", { via: "authoredPosts" })
  Then query succeeds without throwing
  And plan.warnings is empty (no ambiguity warning)
  And plan uses "authoredPosts" relation
```

#### Scenario 5: Unambiguous relation works in strict mode (edge)

```gherkin
Scenario: Unambiguous relation works in strict mode
  Given a schema with Post having single "author" relation to User
  And an ORM created with strictMode: true
  When I query Post and include "author"
  Then query succeeds without throwing
  And plan.warnings is empty
```

#### Scenario 6: Default strictMode is false (edge)

```gherkin
Scenario: Default strictMode is lenient
  Given a schema with ambiguous relations
  And an ORM created without specifying strictMode
  When I query with ambiguous include
  Then query succeeds (lenient behavior)
  And plan.warnings contains ambiguity warning
```

#### Scenario 7: Invalid via hint throws error (error)

```gherkin
Scenario: Invalid via hint throws error
  Given a schema with User having "authoredPosts" and "reviewedPosts" to Post
  And an ORM created with any strictMode
  When I query User and include("posts", { via: "nonExistentRelation" })
  Then error is thrown (from planner - unknown relation)
```

#### Scenario 8: Nested include with ambiguity (edge)

```gherkin
Scenario: Nested include respects strict mode
  Given a schema with nested ambiguous relations
  And an ORM created with strictMode: true
  When I query with nested include containing ambiguity
  Then AmbiguousRelationError is thrown for the nested include
```

#### Scenario 9: Multiple includes, one ambiguous (edge)

```gherkin
Scenario: Multiple includes with one ambiguous in strict mode
  Given a schema with User having ambiguous "posts" and unambiguous "profile"
  And an ORM created with strictMode: true
  When I query User and include both "profile" and "posts"
  Then AmbiguousRelationError is thrown for "posts"
  And "profile" include is not mentioned in error
```

---

## 5. Implementation Plan

### Block 1: Package Scaffold

**Packages:** `packages/dx`

- **package.json:** Create with dependencies on `@db-semantic-planner/core`, peer dep on `kysely`
- **tsconfig.json:** Extend root, reference `packages/core`
- **vitest.config.ts:** Configure for package
- **src/index.ts:** Empty exports placeholder

**Complexity:** S
**Dependencies:** None
**Acceptance criteria covered:** None (infrastructure)

### Block 2: Error Class

**Packages:** `packages/dx`

- **src/errors.ts:** `AmbiguousRelationError` class
  - Properties: `sourceTable`, `targetTable`, `options`
  - Proper `Object.setPrototypeOf` for `instanceof`
  - Formatted message with disambiguation hint

**Complexity:** S
**Dependencies:** Block 1
**Acceptance criteria covered:** INV-1, INV-2

### Block 3: Types

**Packages:** `packages/dx`

- **src/types.ts:**
  ```typescript
  interface OrmOptions {
    model: ModelIR;
    strictMode?: boolean; // default: false
  }

  interface IncludeOptions {
    via?: string;
    where?: WhereIntent;
    include?: IncludeIntent[];
  }

  interface OrmInstance {
    query(from: string): QueryBuilder;
  }

  interface QueryBuilder {
    include(relation: string, options?: IncludeOptions): QueryBuilder;
    select(fields: string[]): QueryBuilder;
    where(condition: WhereIntent): QueryBuilder;
    plan(): PlanReport;
    // Note: execute() is NOT part of DX-001, just planning
  }
  ```

**Complexity:** S
**Dependencies:** Block 1
**Acceptance criteria covered:** None (types only)

### Block 4: ORM Factory + Strict Mode Logic

**Packages:** `packages/dx`

- **src/orm.ts:** `createOrm(options: OrmOptions): OrmInstance`
  - Store `strictMode` config
  - Create query builder factory

- **src/query-builder.ts:** Query builder implementation
  - `include()` method with `via` support
  - `plan()` method that:
    1. Builds `QueryIntent` with `include.via` hints
    2. Calls core `plan()` in try/catch
    3. If `AmbiguousPlanError` caught:
       - **Strict mode:** Convert to `AmbiguousRelationError`, throw
       - **Lenient mode:** Re-plan with `disambiguate` option (first relation), return result
    4. Warning already in `PlanReport.warnings` from core planner

**Complexity:** M
**Dependencies:** Block 2, Block 3
**Acceptance criteria covered:** Scenarios 1-6, 8-9

### Block 5: Tests

**Packages:** `packages/dx`

- **src/strict-mode.test.ts:** BDD scenarios as tests
  - Use Q3 schema (User with authoredPosts/reviewedPosts to Post)
  - Test all 9 scenarios
  - Save logs with `tee`

**Complexity:** M
**Dependencies:** Block 4
**Acceptance criteria covered:** All scenarios verified

### Block 6: Integration Verification

**Packages:** `packages/dx`, root

- Run `pnpm -r test` from root
- Run `pnpm -r typecheck` from root
- Verify Q3 golden tests still pass (no regression)
- Update `TODO_DX.md` with completion status

**Complexity:** S
**Dependencies:** Block 5
**Acceptance criteria covered:** AC-6, AC-7

---

## 6. Test Strategy

### Test Matrix

| Scenario | Unit | Integration | Notes |
|----------|------|-------------|-------|
| 1. Strict throws on ambiguous | Yes | - | Core behavior |
| 2. Lenient resolves with warning | Yes | - | Core behavior |
| 3. Via hint in strict | Yes | - | Core behavior |
| 4. Via hint in lenient | Yes | - | Core behavior |
| 5. Unambiguous in strict | Yes | - | Edge case |
| 6. Default strictMode | Yes | - | Config |
| 7. Invalid via | Yes | - | Error case |
| 8. Nested ambiguity | Yes | - | Edge case |
| 9. Multiple includes | Yes | - | Edge case |

### Test Data Strategy

**Reuse Q3 Schema from golden tests:**

```typescript
const testSchema = defineSchema({
  users: { id: 'number', name: 'string' },
  posts: { id: 'number', title: 'string', authorId: 'number', reviewerId: 'number' },
})
.relations({
  users: {
    authoredPosts: hasMany('posts', { foreignKey: 'authorId' }),
    reviewedPosts: hasMany('posts', { foreignKey: 'reviewerId' }),
  },
  posts: {
    author: belongsTo('users', { foreignKey: 'authorId' }),
    reviewer: belongsTo('users', { foreignKey: 'reviewerId' }),
  },
})
.build();
```

### No Mocks Needed

All tests use real `plan()` function from core. No external services involved.

---

## 7. Future Scope (DX-002)

**Explicitly deferred to DX-002:**

- Per-query `strictMode` override: `query.withStrictMode(true)`
- `withRelationHint(targetTable, relationName)` for query-level defaults
- Global relation hints in `OrmOptions`

---

## Definition of Done

- [x] Block 1: Package scaffold created and builds
- [x] Block 2: `AmbiguousRelationError` class implemented
- [x] Block 3: Types defined and exported
- [x] Block 4: `createOrm()` and query builder implemented
- [x] Block 5: All 9 BDD scenarios have passing tests (33 total tests)
- [x] Block 6: `pnpm -r test` passes (185 tests, 0 failures)
- [x] Block 6: `pnpm -r typecheck` passes (0 errors)
- [x] Block 6: Q3 golden tests still pass (no regression)
- [x] TODO_DX.md updated with completion status
