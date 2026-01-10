# CORE-002: Relation Resolution Correctness

---
doc-meta:
  status: canonical
  scope: adapter-kysely
  type: specification
  created: 2026-01-09
  updated: 2026-01-09
---

## 1. Problem Statement

The compiler generates incorrect SQL for **belongsTo** relations in filter contexts. While `applyIncludeJoins` correctly differentiates belongsTo vs hasMany, `applyJoinFilters` and `compileExists` do not.

### Current State (Broken)

```sql
-- Query: posts WHERE author.role = 'admin' (posts belongsTo users)

-- EXPECTED (belongsTo: source.fk = target.pk)
SELECT * FROM posts t0
INNER JOIN users t1 ON t0.authorId = t1.id
WHERE t1.role = $1

-- ACTUAL (hasMany pattern incorrectly applied)
SELECT * FROM posts t0
INNER JOIN users t1 ON t1.authorId = t0.id  -- WRONG!
WHERE t1.role = $1
```

### Audit Findings

| Function | belongsTo Handling | Status |
|----------|-------------------|--------|
| `applyIncludeJoins` | ✅ Checks `relation.type` | OK |
| `applyJoinFilters` | ❌ Always uses hasMany pattern | BUG |
| `compileExists` | ❌ Always uses hasMany pattern | BUG |

### Evidence

```typescript
// applyJoinFilters (lines 2209-2214) - BROKEN
result = result.innerJoin(
    `${targetTable} as ${joinAlias}`,
    `${joinAlias}.${fk}`,        // Always target.fk
    `${rootAlias}.${sourceKey}`, // Always source.pk
);
// No relation.type check!

// applyIncludeJoins (lines 1997-2012) - CORRECT
if (relation.type === 'belongsTo') {
    result = result.leftJoin(..., `${rootAlias}.${fk}`, `${joinAlias}.${targetKey}`);
} else {
    result = result.leftJoin(..., `${joinAlias}.${fk}`, `${rootAlias}.${sourceKey}`);
}
```

---

## 2. User Stories

### US-1: BelongsTo Filter Correctness

```
AS A developer using db-semantic-planner
I WANT filters on belongsTo relations to generate correct SQL
SO THAT my queries return accurate results
```

**Acceptance:** When filtering posts by author attributes (belongsTo), SQL uses `posts.authorId = users.id`, not `users.authorId = posts.id`.

### US-2: M:N Through Table Support (Deferred)

```
AS A developer using db-semantic-planner
I WANT to filter/include through M:N junction tables
SO THAT I can query many-to-many relationships
```

**Acceptance:** When filtering users by tags (M:N), SQL generates double JOIN through junction table.

**Status:** Deferred to CORE-002-B (separate story)

---

## 3. Business Rules

### BR-1: FK Direction by Relation Type

| Relation Type | FK Location | JOIN Condition |
|---------------|-------------|----------------|
| `belongsTo` | Source table | `source.fk = target.pk` |
| `hasMany` | Target table | `target.fk = source.pk` |
| `hasOne` | Target table | `target.fk = source.pk` |

### BR-2: Examples

```
posts belongsTo users (FK: posts.authorId)
→ JOIN users ON posts.authorId = users.id

users hasMany posts (FK: posts.userId)
→ JOIN posts ON posts.userId = users.id
```

### BR-3: Consistency Rule

All relation filter/include functions MUST use the same FK direction logic. The reference implementation is `applyIncludeJoins`.

---

## 4. Technical Impact

### Packages Affected

| Package | Changes |
|---------|---------|
| `adapter-kysely` | Fix `applyJoinFilters`, `compileExists` |
| `core` | No changes |
| `dx` | No changes |

### Files to Modify

| File | Changes |
|------|---------|
| `packages/adapter-kysely/src/compiler.ts` | Add `relation.type` check to 2 functions |
| `packages/adapter-kysely/src/compiler.test.ts` | Add FK direction verification tests |

---

## 5. Acceptance Criteria (BDD Scenarios)

### Feature: FK Direction Correctness

#### Scenario 1: belongsTo filter with JOIN strategy

```gherkin
Given a schema with posts belongsTo users (FK: authorId)
And filter-strategy is 'join' for the relation
When I filter posts by author.role = 'admin'
Then the SQL contains "posts"."authorId" = "users"."id"
And the SQL does NOT contain "users"."authorId"
```

#### Scenario 2: belongsTo filter with EXISTS strategy

```gherkin
Given a schema with posts belongsTo users (FK: authorId)
And filter-strategy is 'exists' for the relation
When I filter posts by author.role = 'admin'
Then the EXISTS subquery correlates posts.authorId = users.id
And the SQL does NOT contain "users"."authorId" = "posts"."id"
```

#### Scenario 3: hasMany filter with EXISTS strategy (regression)

```gherkin
Given a schema with users hasMany posts (FK: userId)
And filter-strategy is 'exists' (default for hasMany)
When I filter users by posts.status = 'published'
Then the EXISTS subquery correlates posts.userId = users.id
And behavior is unchanged from current implementation
```

#### Scenario 4: hasMany filter with JOIN strategy (regression)

```gherkin
Given a schema with users hasMany posts (FK: userId)
And filter-strategy is 'join' (explicit override)
When I filter users by posts.status = 'published'
Then the SQL contains "posts"."userId" = "users"."id"
And behavior is unchanged from current implementation
```

#### Scenario 5: belongsTo include (regression)

```gherkin
Given a schema with posts belongsTo users (FK: authorId)
And include-strategy is 'join' (default for belongsTo)
When I include author on posts
Then the LEFT JOIN uses posts.authorId = users.id
And behavior is unchanged from current implementation
```

---

## 6. Implementation Plan (Vertical Slices)

### Block 1: Fix applyJoinFilters

**Scope:** Add `relation.type` check to differentiate belongsTo vs hasMany

**File:** `packages/adapter-kysely/src/compiler.ts`

**Changes:**
```typescript
// Before (lines 2209-2214)
result = result.innerJoin(
    `${targetTable} as ${joinAlias}`,
    `${joinAlias}.${fk}`,
    `${rootAlias}.${sourceKey}`,
);

// After
if (relation.type === 'belongsTo') {
    // belongsTo: source.fk = target.pk
    const targetTableDef = model.getTable(relation.target);
    const targetPk = targetTableDef?.primaryKey;
    const targetKey = Array.isArray(targetPk)
        ? (targetPk[0] ?? 'id')
        : (targetPk ?? 'id');

    result = result.innerJoin(
        `${targetTable} as ${joinAlias}`,
        `${rootAlias}.${fk}`,
        `${joinAlias}.${targetKey}`,
    );
} else {
    // hasMany/hasOne: target.fk = source.pk
    result = result.innerJoin(
        `${targetTable} as ${joinAlias}`,
        `${joinAlias}.${fk}`,
        `${rootAlias}.${sourceKey}`,
    );
}
```

**Tests:** Scenarios 1, 4

**Complexity:** S

---

### Block 2: Fix compileExists

**Scope:** Add `relation.type` check to differentiate belongsTo vs hasMany

**File:** `packages/adapter-kysely/src/compiler.ts`

**Changes:**
```typescript
// Before (line 1843)
.whereRef(`${relatedAlias}.${fk}`, '=', `${sourceAlias}.${sourceKey}`);

// After
if (relation.type === 'belongsTo') {
    // belongsTo: source.fk = target.pk
    const targetTableDef = model.getTable(relation.target);
    const targetPk = targetTableDef?.primaryKey;
    const targetKey = Array.isArray(targetPk)
        ? (targetPk[0] ?? 'id')
        : (targetPk ?? 'id');

    subquery = subquery.whereRef(
        `${sourceAlias}.${fk}`,
        '=',
        `${relatedAlias}.${targetKey}`,
    );
} else {
    // hasMany/hasOne: target.fk = source.pk
    subquery = subquery.whereRef(
        `${relatedAlias}.${fk}`,
        '=',
        `${sourceAlias}.${sourceKey}`,
    );
}
```

**Tests:** Scenarios 2, 3

**Complexity:** S

---

### Block 3: Add FK Direction Verification Tests

**Scope:** Add explicit tests that verify SQL JOIN condition direction

**File:** `packages/adapter-kysely/src/compiler.test.ts`

**Tests:**
- Test belongsTo JOIN: assert `posts.authorId = users.id` pattern
- Test belongsTo EXISTS: assert correct correlation in subquery
- Test hasMany JOIN: regression (unchanged)
- Test hasMany EXISTS: regression (unchanged)

**Complexity:** S

---

### Block 4: Regression Tests

**Scope:** Verify existing tests still pass, add golden test assertions

**Files:**
- `packages/adapter-kysely/src/golden.test.ts`
- Run full test suite

**Tests:** All 5 scenarios

**Complexity:** S

---

## 7. Test Strategy

### Test Matrix

| Scenario | Unit | Integration | E2E |
|----------|------|-------------|-----|
| S1: belongsTo JOIN | Yes | Yes | - |
| S2: belongsTo EXISTS | Yes | Yes | - |
| S3: hasMany EXISTS (regression) | Yes | Yes | - |
| S4: hasMany JOIN (regression) | Yes | Yes | - |
| S5: belongsTo include (regression) | Yes | Yes | - |

### Test Data

- Existing `filterContractSchema` in golden.test.ts (posts, users, comments)
- Existing models in compiler.test.ts

---

## 8. Out of Scope

### Deferred to CORE-002-B: M:N Through Table Support

The `relation.through` property exists in ModelIR but is not implemented in the compiler. This requires:

1. Double JOIN through junction table
2. Handling both FK columns in junction
3. Tests for M:N filters and includes

**Recommendation:** Separate story due to complexity.

---

## 9. Definition of Done

- [x] Block 1: applyJoinFilters fixed (2026-01-09)
- [x] Block 2: compileExists fixed (2026-01-09)
- [x] Block 3: FK direction tests added (2026-01-09) - Q6 test suite with 6 tests
- [x] Block 4: Regression tests pass (2026-01-09) - 402/402 tests pass
- [x] All 5 BDD scenarios have passing tests (2026-01-09)
- [x] No regressions in existing tests (2026-01-09)
- [x] TODO.md updated (2026-01-09)

---

## 10. Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| SQL output change breaks existing queries | MEDIUM | Only affects belongsTo filters (rare usage), tests verify |
| Regression in hasMany | LOW | Explicit regression tests |
| Missing edge cases | LOW | Comprehensive test coverage |
