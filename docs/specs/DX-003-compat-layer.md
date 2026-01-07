---
doc-meta:
  status: canonical
  scope: dx
  type: specification
  created: 2026-01-07
  updated: 2026-01-07
---

# Specification: DX-003 Compat Layer

## 1. User Stories

### US1: Filter Helpers
**AS A** developer familiar with Drizzle/Prisma
**I WANT** to use `eq()`, `and()`, `or()` helper functions
**SO THAT** I can build WHERE clauses ergonomically without verbose object literals

**ACCEPTANCE:** `where(eq('status', 'active'))` produces valid WhereIntent

### US2: Query Execution
**AS A** developer
**I WANT** to call `findMany()` and `findFirst()` on my query builder
**SO THAT** I can execute queries and get results directly

**ACCEPTANCE:** `orm.query('users').findMany()` returns array of rows from database

### US3: Error on Missing DB
**AS A** developer
**I WANT** a clear error when I try to execute without a database configured
**SO THAT** I know what's wrong and how to fix it

**ACCEPTANCE:** Error message includes solution hint

---

## 2. Business Rules

### Filter Helpers
- **BR1:** Each filter helper MUST return a valid WhereIntent that passes to `plan()`
- **BR2:** Filter helpers are pure functions with no side effects
- **BR3:** `and()` and `or()` accept variadic arguments OR array of conditions
- **BR4:** All filter helpers are tree-shakeable (individual exports)

### Query Execution
- **BR5:** `findMany()` MUST return `Promise<unknown[]>` (array, possibly empty)
- **BR6:** `findFirst()` MUST return `Promise<unknown | undefined>`
- **BR7:** `findFirstOrThrow()` MUST throw `NotFoundError` if no results
- **BR8:** Execution REQUIRES `db` option in `createOrm()` or throws `ExecutionError`
- **BR9:** Multi-tenant queries (via `forTenant()`) MUST include schema prefix

### Error Handling
- **BR10:** `ExecutionError` thrown when `db` not configured
- **BR11:** `NotFoundError` thrown by `findFirstOrThrow()` when no results
- **BR12:** Database errors propagate as-is (no wrapping)

---

## 3. Technical Impact

| Layer | Changes | Validation |
|-------|---------|------------|
| packages/dx/src/filters.ts | NEW - 14 filter helper functions | Type-safe return values |
| packages/dx/src/types.ts | Add `db` to OrmOptions, execution methods to QueryBuilder | Type compatibility |
| packages/dx/src/orm.ts | Implement findMany/findFirst/findFirstOrThrow | Integration tests |
| packages/dx/src/errors.ts | Add ExecutionError, NotFoundError | Error handling tests |
| packages/dx/src/index.ts | Export filter helpers | Import verification |

---

## 4. Acceptance Criteria (BDD Scenarios)

### Feature 1: Filter Helpers

#### Scenario 1.1: eq() creates comparison intent
```gherkin
Given filter helpers are imported
When eq('status', 'active') is called
Then it returns { kind: 'comparison', field: 'status', operator: 'eq', value: 'active' }
```

#### Scenario 1.2: Comparison operators
```gherkin
Given filter helpers are imported
When neq, gt, gte, lt, lte are called with field and value
Then each returns WhereComparisonIntent with correct operator
```

#### Scenario 1.3: like() creates like intent
```gherkin
Given filter helpers are imported
When like('name', '%john%') is called
Then it returns { kind: 'like', field: 'name', pattern: '%john%' }
```

#### Scenario 1.4: isNull and isNotNull
```gherkin
Given filter helpers are imported
When isNull('deletedAt') is called
Then it returns { kind: 'null', field: 'deletedAt', operator: 'isNull' }
When isNotNull('email') is called
Then it returns { kind: 'null', field: 'email', operator: 'isNotNull' }
```

#### Scenario 1.5: inArray creates in intent
```gherkin
Given filter helpers are imported
When inArray('status', ['active', 'pending']) is called
Then it returns { kind: 'in', field: 'status', values: ['active', 'pending'] }
```

#### Scenario 1.6: and() combines conditions
```gherkin
Given filter helpers are imported
When and(eq('a', 1), gt('b', 2)) is called
Then it returns { kind: 'and', conditions: [<eq result>, <gt result>] }
```

#### Scenario 1.7: or() combines conditions
```gherkin
Given filter helpers are imported
When or(eq('status', 'active'), eq('status', 'pending')) is called
Then it returns { kind: 'or', conditions: [<eq1>, <eq2>] }
```

#### Scenario 1.8: not() negates condition
```gherkin
Given filter helpers are imported
When not(eq('deleted', true)) is called
Then it returns { kind: 'not', condition: <eq result> }
```

#### Scenario 1.9: exists() creates exists intent
```gherkin
Given filter helpers are imported
When exists('posts') is called
Then it returns { kind: 'exists', relation: 'posts' }
When exists('posts', { where: eq('published', true) }) is called
Then it returns { kind: 'exists', relation: 'posts', where: <eq result> }
```

#### Scenario 1.10: notExists() creates notExists intent
```gherkin
Given filter helpers are imported
When notExists('comments') is called
Then it returns { kind: 'notExists', relation: 'comments' }
```

### Feature 2: Query Execution

#### Scenario 2.1: findMany returns array
```gherkin
Given ORM configured with model and db (Kysely instance)
And database has 3 users
When orm.query('users').findMany() is called
Then Promise resolves with array of 3 rows
```

#### Scenario 2.2: findMany with filter
```gherkin
Given ORM configured with model and db
And database has users with various statuses
When orm.query('users').where(eq('status', 'active')).findMany() is called
Then Promise resolves with only active users
```

#### Scenario 2.3: findFirst returns single row
```gherkin
Given ORM configured with model and db
And database has matching rows
When orm.query('users').where(eq('id', 1)).findFirst() is called
Then Promise resolves with single row object
```

#### Scenario 2.4: findFirst returns undefined when no match
```gherkin
Given ORM configured with model and db
And database has no matching rows
When orm.query('users').where(eq('id', 999)).findFirst() is called
Then Promise resolves with undefined
```

#### Scenario 2.5: findFirstOrThrow throws on no match
```gherkin
Given ORM configured with model and db
And database has no matching rows
When orm.query('users').where(eq('id', 999)).findFirstOrThrow() is called
Then Promise rejects with NotFoundError
And error message includes table name 'users'
```

#### Scenario 2.6: Execution without db throws
```gherkin
Given ORM configured with model but NO db
When orm.query('users').findMany() is called
Then Promise rejects with ExecutionError
And error message includes hint about db option
```

#### Scenario 2.7: Multi-tenant execution
```gherkin
Given ORM configured with model and db
When orm.forTenant('tenant_123').query('users').findMany() is called
Then SQL includes schema prefix 'tenant_123'
And results come from tenant schema
```

### Feature 3: Integration with Existing API

#### Scenario 3.1: Filter helpers work with existing where()
```gherkin
Given ORM instance
When orm.query('users').where(and(eq('a', 1), gt('b', 2))).plan() is called
Then PlanReport is valid
And intent.where has correct structure
```

#### Scenario 3.2: Chaining preserved
```gherkin
Given ORM instance with db
When orm.query('users').select(['id', 'name']).where(eq('active', true)).findMany()
Then execution respects select and where
```

---

## 5. Implementation Plan

### Block 1: Filter Helpers (Pure Functions)

**Package:** packages/dx

**Files:**
- CREATE `src/filters.ts` - All 14 filter helper functions
- UPDATE `src/index.ts` - Export filter helpers

**Tests:**
- CREATE `src/filters.test.ts` - Unit tests for each helper

**Acceptance criteria covered:** 1.1-1.10, 3.1

**Complexity:** S

### Block 2: Error Classes

**Package:** packages/dx

**Files:**
- UPDATE `src/errors.ts` - Add ExecutionError, NotFoundError

**Tests:**
- UPDATE `src/errors.test.ts` - Error tests

**Acceptance criteria covered:** 2.5, 2.6

**Complexity:** S

### Block 3: Execution Layer

**Package:** packages/dx

**Files:**
- UPDATE `src/types.ts` - Add `db` to OrmOptions, execution methods to QueryBuilder
- UPDATE `src/orm.ts` - Implement findMany, findFirst, findFirstOrThrow

**Tests:**
- CREATE `src/execution.test.ts` - Execution tests (need mock or in-memory DB)

**Acceptance criteria covered:** 2.1-2.7, 3.2

**Complexity:** M

### Block 4: Multi-tenant Execution

**Package:** packages/dx

**Files:**
- UPDATE `src/orm.ts` - Ensure forTenant() passes schema to compile

**Tests:**
- UPDATE `src/execution.test.ts` - Multi-tenant tests

**Acceptance criteria covered:** 2.7

**Complexity:** S

---

## 6. Test Strategy

### Test Matrix

| Scenario | Unit | Integration |
|----------|------|-------------|
| Filter helpers (1.1-1.10) | Yes | - |
| Error classes | Yes | - |
| findMany/findFirst (2.1-2.5) | - | Yes (needs DB) |
| Execution without db (2.6) | Yes | - |
| Multi-tenant (2.7) | - | Yes |
| Chaining integration (3.1-3.2) | Yes | Yes |

### Test Data Strategy

**Unit tests:** No DB needed, just verify returned objects

**Integration tests:** Use in-memory SQLite or mock Kysely:
- Option A: sqlite3 with Kysely SQLite dialect (real execution)
- Option B: Mock Kysely's executeQuery (isolated)

**Recommendation:** Mock Kysely for unit-like isolation, with one golden integration test using SQLite.

---

## Definition of Done

- [x] All 14 filter helpers implemented and tested (30 tests)
- [x] ExecutionError and NotFoundError implemented (12 tests)
- [x] findMany, findFirst, findFirstOrThrow implemented
- [x] db option added to OrmOptions
- [x] Multi-tenant execution works with forTenant()
- [x] All BDD scenarios have passing tests (22 scenarios)
- [x] All tests pass (258 total: 93 core + 59 adapter + 106 dx)
- [x] Lint/typecheck pass
- [x] Documentation updated (exports in index.ts)

**Completed:** 2026-01-07
