# CLI-012: CTE Include Strategy Implementation

---
doc-meta:
  status: active
  scope: core, adapter
  type: plan
  created: 2026-01-12
  parent: CORE-006-smart-include-strategies.md
---

## Overview

Implement real CTE-based includes to replace the LEFT JOIN placeholders in `applyCteIncludes`. When `includeStrategy === 'cte'`, the system should generate actual WITH clauses.

## BDD Scenarios

### Scenario 1: CTE strategy generates WITH clause
```gherkin
Given a schema with a hasMany relation "users → posts"
And include strategy is explicitly set to "cte"
When I query users with include("posts")
Then the SQL should contain "WITH cte_users_posts AS"
And the SQL should contain "SELECT * FROM posts" in the CTE
And the SQL should JOIN to "cte_users_posts" not "posts"
```

### Scenario 2: CTE includes preserve filters
```gherkin
Given a schema with a hasMany relation "users → posts"
And include strategy is "cte"
When I query users with include("posts", { where: { published: true } })
Then the CTE should contain "WHERE published = $1"
And the main query should JOIN to the filtered CTE
```

### Scenario 3: Planner adds CTE definition for CTE strategy
```gherkin
Given a schema with relation "categories → parent" (self-referential)
When I query categories with include("parent")
And the planner selects "cte" strategy
Then plan.ctes should contain a CTE definition
And the CTE name should be "cte_categories_parent"
And the CTE purpose should describe the include
```

### Scenario 4: Multiple CTE includes
```gherkin
Given a schema with relations "users → posts" and "users → comments"
And both are configured with "cte" strategy
When I query users with include("posts").include("comments")
Then the SQL should contain two WITH clauses
And each should have a unique CTE name
```

### Scenario 5: Nested CTE includes
```gherkin
Given a schema with "users → posts → comments"
And all relations use "cte" strategy
When I query users with include("posts", { include: ["comments"] })
Then CTEs should be generated for both levels
And the posts CTE should reference the comments CTE
```

## Implementation Plan

### Block 1: Planner - Add CTE to state.ctes (packages/core)

**File:** `packages/core/src/planner.ts`

**Change:** In `processInclude`, after determining `includeStrategy === 'cte'`, add:

```typescript
if (includeStrategy === 'cte') {
  const cteName = `cte_${sourceTable}_${relation.name}`;
  state.ctes.push({
    name: cteName,
    purpose: `Include ${relation.name} via CTE strategy`,
    referencedBy: [intentPath],
    sourceIntent: `${sourceTable}.${relation.name}`,
  });
}
```

**Tests:**
- Unit test: CTE added to plan when strategy is 'cte'
- Unit test: CTE not added when strategy is 'join'

### Block 2: Compiler - Update applyCteIncludes (packages/adapter-kysely)

**File:** `packages/adapter-kysely/src/compiler.ts`

**Changes:**
1. In `collectCteIncludes`, check if CTE exists in `plan.ctes`
2. In `applyCteIncludes`, JOIN to CTE name instead of table name
3. The CTE itself is already created by `buildCTEs` (no change needed there)

**Key change in applyCteIncludes:**
```typescript
// BEFORE (current)
result = result.leftJoin(`${targetTable} as ${cteAlias}`, ...);

// AFTER (with CTE)
const cteRef = findCteForInclude(plan.ctes, sourceTable, include.relation);
if (cteRef) {
  result = result.leftJoin(`${cteRef.name} as ${cteAlias}`, ...);
} else {
  // Fallback to direct table join
  result = result.leftJoin(`${targetTable} as ${cteAlias}`, ...);
}
```

**Tests:**
- Golden test: SQL output contains WITH clause
- Golden test: JOIN references CTE name

### Block 3: Integration Tests

**File:** `packages/adapter-kysely/src/compiler.test.ts`

**Tests to add:**
1. CTE include generates WITH clause
2. CTE include with filters
3. Multiple CTE includes
4. Nested CTE includes (if supported)

## Technical Notes

### CTE vs Recursive CTE

- **CTE Include Strategy** (this ticket): Non-recursive WITH clause for includes
- **Recursive CTE** (RFC-001, done): WITH RECURSIVE for hierarchy traversal

### When to use CTE strategy

The planner selects CTE strategy when:
1. Relation is self-referential (e.g., categories.parent)
2. User explicitly requests `includeStrategy: 'cte'`
3. Relation is accessed multiple times (via extractCTEs threshold)

### Build order

CTEs must be created BEFORE `selectFrom`:
1. `buildCTEs()` - creates all CTEs from `plan.ctes`
2. `selectFrom()` - main query
3. `applyCteIncludes()` - JOINs to CTEs (not to tables)

## Acceptance Criteria

- [x] When `includeStrategy === 'cte'`, planner adds CTE to `state.ctes` (2026-01-12)
- [x] Compiler generates `WITH cte_X AS (...)` clause (2026-01-12)
- [x] Compiler JOINs to CTE name, not raw table (2026-01-12)
- [x] All existing tests pass (665 tests passing) (2026-01-12)
- [x] New tests cover CTE include scenarios (4 new tests) (2026-01-12)

## Implementation Status: COMPLETE

Implementation completed on 2026-01-12 with:
- **Planner change**: `packages/core/src/planner.ts` lines 947-956
- **Compiler change**: `packages/adapter-kysely/src/compiler.ts` - `collectCteIncludes`, `applyCteIncludes`, `buildCTEs`
- **Tests**: 4 new tests in `packages/adapter-kysely/src/compiler.test.ts`
