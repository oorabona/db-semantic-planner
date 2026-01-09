# CORE-001: Planner → Compiler Contract Enforcement

---
doc-meta:
  status: canonical
  scope: core, adapter-kysely
  type: specification
  created: 2026-01-09
  updated: 2026-01-09
---

## 1. Problem Statement

The semantic planner makes strategic decisions (`filter-strategy`, `include-strategy`) that the compiler **currently ignores**. This defeats the purpose of semantic planning.

### Current State (Broken)

```
Intent → Planner (decides JOIN vs EXISTS) → Compiler → SQL
                   ↓                              ↓
              decision.choice = 'join'    ALWAYS generates EXISTS
```

### Audit Findings

| Decision Type | Planner | Compiler |
|---------------|---------|----------|
| `filter-strategy` | ✅ Decides `'exists'` or `'join'` | ❌ Always EXISTS |
| `include-strategy` | ✅ Decides `'join'` or `'separate'` | ❌ Not implemented |

### Evidence

```typescript
// compiler.ts:1561-1619 - compileRelationFilter
switch (where.mode) {
  case 'some':  return compileExists(...);  // HARDCODED
  case 'none':  return compileExists(...);  // HARDCODED
  case 'every': return compileExists(...);  // HARDCODED
}
// No compileJoinFilter exists!

// compiler.ts:184-270 - compile()
// Handles: CTEs, WHERE, GROUP BY, ORDER BY, LIMIT, OFFSET
// Missing: intent.include handling
```

---

## 2. User Stories

### US-1: Filter Strategy Enforcement

```
AS A developer using db-semantic-planner
I WANT the compiler to generate JOIN or EXISTS based on planner decision
SO THAT cardinality-optimized queries are produced automatically
```

**Acceptance:** When planner decides `filter-strategy: 'join'`, SQL contains JOIN, not EXISTS.

### US-2: Include Strategy Enforcement

```
AS A developer using db-semantic-planner
I WANT the compiler to fetch related data via JOIN or separate queries
SO THAT I can control N+1 vs row-explosion trade-offs
```

**Acceptance:** When planner decides `include-strategy: 'join'`, SQL contains LEFT JOIN with selected columns.

---

## 3. Business Rules

### BR-1: Filter Strategy Selection

| Cardinality | Default Strategy | Reasoning |
|-------------|------------------|-----------|
| `one` (belongsTo, hasOne) | `join` | No row explosion risk |
| `many` (hasMany) | `exists` | Avoids row multiplication |

**Override:** Explicit `filterStrategy` hint on relation takes precedence.

### BR-2: Include Strategy Selection

| Cardinality | Default Strategy | Reasoning |
|-------------|------------------|-----------|
| `one` | `join` | Single row, efficient |
| `many` | `separate` | Avoids Cartesian product |

**Override:** Explicit `includeStrategy` hint on relation takes precedence.

### BR-3: Decision-SQL Mapping

| Decision | SQL Pattern |
|----------|-------------|
| `filter-strategy: 'exists'` | `WHERE EXISTS (SELECT 1 FROM ...)` |
| `filter-strategy: 'join'` | `INNER JOIN ... ON ...` + `WHERE ...` |
| `include-strategy: 'join'` | `LEFT JOIN ... ON ...` + select columns |
| `include-strategy: 'separate'` | Main query + N follow-up queries |

---

## 4. Technical Impact

### Packages Affected

| Package | Changes |
|---------|---------|
| `adapter-kysely` | Compiler: add JOIN filter, implement includes |
| `core` | No changes (planner already correct) |
| `dx` | No changes (passes intents correctly) |

### Files to Modify

| File | Changes |
|------|---------|
| `packages/adapter-kysely/src/compiler.ts` | Add `compileJoinFilter`, `compileIncludes` |
| `packages/adapter-kysely/src/compiler.test.ts` | Integration tests |
| `tests/e2e/pimdam.q1.exists.test.ts` | Add JOIN strategy test |

---

## 5. Acceptance Criteria (BDD Scenarios)

### Feature: Filter Strategy Enforcement

#### Scenario 1: EXISTS strategy for hasMany (default)

```gherkin
Given a model with users hasMany posts
And no explicit filterStrategy hint
When I filter users by posts.status = 'published'
Then the planner decides filter-strategy: 'exists'
And the SQL contains "WHERE EXISTS (SELECT 1 FROM"
And the SQL does NOT contain "JOIN posts"
```

#### Scenario 2: JOIN strategy for belongsTo (default)

```gherkin
Given a model with posts belongsTo user
And no explicit filterStrategy hint
When I filter posts by user.role = 'admin'
Then the planner decides filter-strategy: 'join'
And the SQL contains "INNER JOIN" or "JOIN"
And the SQL does NOT contain "WHERE EXISTS"
```

#### Scenario 3: Explicit JOIN override for hasMany

```gherkin
Given a model with users hasMany posts (filterStrategy: 'join')
When I filter users by posts.status = 'published'
Then the planner decides filter-strategy: 'join'
And the SQL contains "JOIN posts"
```

#### Scenario 4: Explicit EXISTS override for belongsTo

```gherkin
Given a model with posts belongsTo user (filterStrategy: 'exists')
When I filter posts by user.role = 'admin'
Then the planner decides filter-strategy: 'exists'
And the SQL contains "WHERE EXISTS"
```

### Feature: Include Strategy Enforcement

#### Scenario 5: JOIN strategy for belongsTo include

```gherkin
Given a model with posts belongsTo user
When I select posts with include('user')
Then the planner decides include-strategy: 'join'
And the SQL contains "LEFT JOIN users"
And the SQL selects user columns
```

#### Scenario 6: Separate strategy for hasMany include

```gherkin
Given a model with users hasMany posts
When I select users with include('posts')
Then the planner decides include-strategy: 'separate'
And the main SQL does NOT contain "JOIN posts"
And a follow-up query fetches posts for returned user IDs
```

#### Scenario 7: Explicit JOIN override for hasMany include

```gherkin
Given a model with users hasMany posts (includeStrategy: 'join')
When I select users with include('posts')
Then the planner decides include-strategy: 'join'
And the SQL contains "LEFT JOIN posts"
```

---

## 6. Implementation Plan (Vertical Slices)

### Block 1: Filter Strategy - JOIN Implementation

**Scope:** Add JOIN filter compilation when `decision.choice === 'join'`

**Files:**
- `packages/adapter-kysely/src/compiler.ts`
  - Add `compileJoinFilter()` function
  - Modify `compileRelationFilter()` to check decision.choice
  - Add state tracking for joined tables

**Tests:**
- Unit: `compiler.test.ts` - JOIN filter generation
- Integration: planner decides JOIN → compiler generates JOIN

**Complexity:** M

**Deliverable:** `filter-strategy: 'join'` produces SQL with JOIN

---

### Block 2: Filter Strategy - Integration Tests

**Scope:** Prove planner→compiler contract for filters

**Files:**
- `packages/adapter-kysely/src/compiler.test.ts`
  - Test: belongsTo default → JOIN
  - Test: hasMany default → EXISTS
  - Test: explicit hint override

**Tests:**
- 4 integration tests matching scenarios 1-4

**Complexity:** S

**Deliverable:** Tests proving filter-strategy is respected

---

### Block 3: Include Strategy - JOIN Implementation

**Scope:** Implement LEFT JOIN for includes when `decision.choice === 'join'`

**Files:**
- `packages/adapter-kysely/src/compiler.ts`
  - Add `compileIncludeJoin()` function
  - Modify `compile()` to process `intent.include`
  - Handle column aliasing for included relations

**Tests:**
- Unit: include with JOIN generates LEFT JOIN SQL

**Complexity:** M

**Deliverable:** `include-strategy: 'join'` produces SQL with LEFT JOIN

---

### Block 4: Include Strategy - Separate Implementation

**Scope:** Implement separate queries for includes when `decision.choice === 'separate'`

**Files:**
- `packages/adapter-kysely/src/compiler.ts`
  - Add `compileSeparateInclude()` function
  - Return array of CompiledQuery or new type

**Design Decision:**
- Option A: Return `CompiledQuery[]` (breaking change)
- Option B: Return `{ main: CompiledQuery, includes: CompiledQuery[] }`
- Option C: Keep single query, document limitation

**Tests:**
- Unit: separate strategy generates multiple queries

**Complexity:** L (needs design decision)

**Deliverable:** `include-strategy: 'separate'` produces follow-up queries

---

### Block 5: Golden Tests & E2E Updates

**Scope:** Update existing tests to verify strategy enforcement

**Files:**
- `packages/adapter-kysely/src/golden.test.ts`
- `tests/e2e/pimdam.q1.exists.test.ts`

**Tests:**
- Golden: Assert `decision.choice` matches SQL pattern
- E2E: Add belongsTo filter test with JOIN

**Complexity:** S

**Deliverable:** Comprehensive test coverage

---

## 7. Test Strategy

### Test Matrix

| Scenario | Unit | Integration | E2E |
|----------|------|-------------|-----|
| S1: EXISTS for hasMany | Yes | Yes | Yes |
| S2: JOIN for belongsTo | Yes | Yes | Yes |
| S3: JOIN override hasMany | Yes | Yes | - |
| S4: EXISTS override belongsTo | Yes | Yes | - |
| S5: Include JOIN | Yes | Yes | - |
| S6: Include separate | Yes | Yes | - |
| S7: Include JOIN override | Yes | Yes | - |

### Test Data

- Existing `pimdamModel` (products, images, categories)
- Existing `testModel` in dx (users, posts)

---

## 8. Open Questions

### Q1: Include Separate - Return Type

**Options:**
1. `CompiledQuery[]` - Breaking change to compile signature
2. `{ main: CompiledQuery, includes: Map<string, CompiledQuery> }` - New type
3. Single query only, defer separate to future

**Recommendation:** Option 2 for future-proofing, but Option 3 for MVP.

### Q2: Nested Includes

Should `include('posts', { include: ['comments'] })` work?

**Recommendation:** Defer to future. Focus on single-level includes first.

---

## 9. Definition of Done

- [x] Block 1: JOIN filter implemented and tested ✅ (2026-01-09)
- [x] Block 2: Integration tests prove filter-strategy contract ✅ (2026-01-09)
- [x] Block 3: Include JOIN implemented and tested ✅ (2026-01-09)
- [x] Block 4: Include separate implemented (Option 2: { main, separateIncludes }) ✅ (2026-01-09)
- [x] Block 5: Golden tests updated (Q4, Q5 + E2E) ✅ (2026-01-09)
- [x] All 7 BDD scenarios have passing tests ✅ (2026-01-09)
- [x] No regressions in existing tests ✅ (2026-01-09)
- [x] TODO.md updated ✅ (2026-01-09)

---

## 10. Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| SQL output changes break users | HIGH | Version bump, changelog |
| JOIN filter slower than EXISTS in some cases | MEDIUM | Planner heuristics stay conservative |
| Separate includes complex | LOW | Defer to future, document |
