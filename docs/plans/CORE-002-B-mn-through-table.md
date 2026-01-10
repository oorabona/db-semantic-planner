---
doc-meta:
  status: canonical
  scope: core, adapter-kysely
  type: specification
  created: 2026-01-10
  updated: 2026-01-10
---

# CORE-002-B: M:N Through Table Support

## 1. Overview

Implement M:N (many-to-many) relation support via junction tables. This enables
querying relations like `posts.tags` where the relationship is mediated by a
junction table (`postTags`).

**Prerequisite:** CORE-002 (FK direction correctness) - completed

## 2. Problem Statement

The core package defines `belongsToMany` relations with `through` tables, but:
1. `otherKey` is NOT passed from RelationDef to RelationIR (bug)
2. The compiler has zero handling for `belongsToMany` or `through` tables
3. M:N queries fail silently or produce incorrect SQL

## 3. Solution

### 3.1 Core Changes

Add `otherKey` to `RelationIR` interface and ensure schema builder passes it.

### 3.2 Compiler Changes

Implement two-JOIN pattern for M:N relations:

```
source → junction (via foreignKey) → target (via otherKey)
```

## 4. BDD Scenarios

### Scenario 1: M:N filter with JOIN strategy

```gherkin
Given a schema with posts belongsToMany tags through postTags
And a query: select from posts where tags.name = 'typescript'
And the planner chooses filter-strategy: 'join'
When the compiler generates SQL
Then it should produce:
  SELECT "t0".* FROM "posts" AS "t0"
  INNER JOIN "postTags" AS "t1" ON "t0"."id" = "t1"."postId"
  INNER JOIN "tags" AS "t2" ON "t1"."tagId" = "t2"."id"
  WHERE "t2"."name" = $1
```

### Scenario 2: M:N filter with EXISTS strategy

```gherkin
Given a schema with posts belongsToMany tags through postTags
And a query: select from posts where EXISTS tags with name = 'typescript'
And the planner chooses filter-strategy: 'exists'
When the compiler generates SQL
Then it should produce:
  SELECT "t0".* FROM "posts" AS "t0"
  WHERE EXISTS (
    SELECT 1 FROM "postTags" AS "t1"
    INNER JOIN "tags" AS "t2" ON "t1"."tagId" = "t2"."id"
    WHERE "t1"."postId" = "t0"."id"
      AND "t2"."name" = $1
  )
```

### Scenario 3: M:N include with JOIN strategy

```gherkin
Given a schema with posts belongsToMany tags through postTags
And a query: select from posts include tags
And the planner chooses include-strategy: 'join'
When the compiler generates SQL
Then it should produce:
  SELECT "t0".*, "t2"."id" AS "tags.id", "t2"."name" AS "tags.name"
  FROM "posts" AS "t0"
  LEFT JOIN "postTags" AS "t1" ON "t0"."id" = "t1"."postId"
  LEFT JOIN "tags" AS "t2" ON "t1"."tagId" = "t2"."id"
```

### Scenario 4: M:N with custom FK names

```gherkin
Given a schema with users belongsToMany roles through userRoles
  with foreignKey: 'user_id' and otherKey: 'role_id'
And a query: select from users where roles.name = 'admin'
When the compiler generates SQL
Then it should use "user_id" and "role_id" in JOIN conditions
```

### Scenario 5: M:N with schema prefix (multi-tenant)

```gherkin
Given a multi-tenant context with schema 'tenant_123'
And a query: select from posts where tags.name = 'typescript'
When the compiler generates SQL
Then all tables should be prefixed with schema:
  - "tenant_123"."posts"
  - "tenant_123"."postTags"
  - "tenant_123"."tags"
```

## 5. Implementation Plan

### Block 1: Core - Add otherKey to RelationIR

**Files:**
- `packages/core/src/model-ir.ts` - Add `otherKey` property
- `packages/core/src/schema-builder.ts` - Pass `otherKey` to RelationIR

**Tests:**
- Verify `otherKey` is accessible on RelationIR

### Block 2: Adapter - M:N filter with JOIN

**Files:**
- `packages/adapter-kysely/src/compiler.ts` - Update `applyJoinFilters`

**Pattern:**
```typescript
if (relation.through) {
  // JOIN junction table
  result = result.innerJoin(
    `${throughTable} as ${junctionAlias}`,
    `${rootAlias}.${sourceKey}`,
    `${junctionAlias}.${foreignKey}`,
  );
  // JOIN target table
  result = result.innerJoin(
    `${targetTable} as ${targetAlias}`,
    `${junctionAlias}.${otherKey}`,
    `${targetAlias}.${targetKey}`,
  );
}
```

### Block 3: Adapter - M:N filter with EXISTS

**Files:**
- `packages/adapter-kysely/src/compiler.ts` - Update `compileExists`

**Pattern:**
```typescript
if (relation.through) {
  // Start from junction table
  subquery = eb.selectFrom(`${throughTable} as ${junctionAlias}`)
    .select(eb => eb.lit(1).as('_exists'))
    // JOIN target table in subquery
    .innerJoin(
      `${targetTable} as ${targetAlias}`,
      `${junctionAlias}.${otherKey}`,
      `${targetAlias}.${targetKey}`,
    )
    // Correlate junction to source
    .whereRef(
      `${junctionAlias}.${foreignKey}`,
      '=',
      `${sourceAlias}.${sourceKey}`,
    );
}
```

### Block 4: Adapter - M:N include with JOIN

**Files:**
- `packages/adapter-kysely/src/compiler.ts` - Update `applyIncludeJoins`

**Pattern:** Same as Block 2 but with LEFT JOINs.

### Block 5: Tests

**Files:**
- `packages/adapter-kysely/src/golden.test.ts` - Q7: M:N Through Table Support
- `packages/core/src/model-ir.test.ts` - Verify otherKey

## 6. FK Inference Rules

When `foreignKey` or `otherKey` are not provided:

| Property | Default | Example |
|----------|---------|---------|
| `foreignKey` | `${sourceTable}Id` | `postId` |
| `otherKey` | `${targetTable}Id` | `tagId` |

## 7. Test Requirements

| Scenario | Test File | Test Name |
|----------|-----------|-----------|
| S1 | golden.test.ts | M:N filter with JOIN |
| S2 | golden.test.ts | M:N filter with EXISTS |
| S3 | golden.test.ts | M:N include with JOIN |
| S4 | golden.test.ts | M:N with custom FK names |
| S5 | golden.test.ts | M:N with schema prefix |

## 8. Out of Scope

- Composite foreign keys in M:N relations
- Pivot data (additional columns on junction table)
- Self-referential M:N (e.g., users following users)

## 9. Definition of Done

- [x] ✅ Block 1: otherKey in RelationIR (2026-01-10)
- [x] ✅ Block 2: M:N filter with JOIN (2026-01-10)
- [x] ✅ Block 3: M:N filter with EXISTS (2026-01-10)
- [x] ✅ Block 4: M:N include with JOIN (2026-01-10)
- [x] ✅ Block 5: All 5 BDD scenarios have tests (6 tests) (2026-01-10)
- [x] ✅ All existing tests pass - 1010 total (no regressions) (2026-01-10)
- [x] ✅ TODO.md updated (2026-01-10)
