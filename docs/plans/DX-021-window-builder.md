---
doc-meta:
  status: complete
  scope: dx
  type: specification
  created: 2026-01-09
  updated: 2026-01-10
---

# Specification: DX-021 Window Functions Builder Pattern

## 1. User Stories

### US-1: Fluent Window Function API

**AS A** developer using the query builder
**I WANT** fluent factory functions for window operations (rowNumber, rank, sum, etc.)
**SO THAT** I can compose window expressions naturally without verbose options objects

**ACCEPTANCE:** Window functions integrate with `columns()` via ExpressionSpec pattern

### US-2: Composable Partition and Order

**AS A** developer building complex analytics queries
**I WANT** chainable `.partitionBy()` and `.orderBy()` methods
**SO THAT** I can build window expressions incrementally

**ACCEPTANCE:** Methods are chainable and produce correct SQL

## 2. Business Rules

### Invariants

- **INV-1:** WindowBuilder methods MUST return new instances (immutable pattern)
- **INV-2:** `.as()` is REQUIRED before use in `columns()` - it returns ExpressionSpec
- **INV-3:** Multiple `.partitionBy()` calls APPEND fields (not replace)
- **INV-4:** Multiple `.orderBy()` calls APPEND fields (not replace)
- **INV-5:** Window functions without `.as()` are TypeScript errors (no runtime check needed)

### Preconditions

- **PRE-1:** Aggregate functions (sum, avg, count, min, max) REQUIRE a field parameter
- **PRE-2:** Ranking functions (row_number, rank, dense_rank) DO NOT accept field
- **PRE-3:** Offset functions (lag, lead) REQUIRE a field parameter

### Effects

- **EFF-1:** `.as(alias)` produces `ExpressionSpec` with `WindowIntent`
- **EFF-2:** WindowIntent is added to ExpressionIntent union type
- **EFF-3:** Old `.window()` method is REMOVED (BREAKING CHANGE)

### Errors

- **ERR-1:** TypeScript error if aggregate/offset function called without field
- **ERR-2:** TypeScript error if ranking function called with field

## 3. Technical Impact

| Layer | Changes | Validation |
|-------|---------|------------|
| packages/core | Add WindowIntent to ExpressionIntent union | Type extends correctly |
| packages/dx/types.ts | Export WindowBuilder type | No runtime change |
| packages/dx/filters.ts | Add factory functions + WindowBuilder class | Unit tests |
| packages/dx/orm.ts | Remove old .window() method | Integration tests |
| packages/dx/index.ts | Export new window factory functions | API surface |

## 4. Acceptance Criteria (BDD Scenarios)

### Scenario 1: Basic rowNumber with orderBy

```gherkin
Scenario: Create ROW_NUMBER window function
  Given a query builder for 'products'
  When I call columns(['id', rowNumber().orderBy('price', 'desc').as('rn')])
  Then the SQL should contain 'ROW_NUMBER() OVER (ORDER BY "price" DESC) AS "rn"'
  And the plan should include a WindowIntent with function='row_number'
```

### Scenario 2: rank with partitionBy and orderBy

```gherkin
Scenario: Create RANK with partition
  Given a query builder for 'products'
  When I call columns(['id', rank().partitionBy('categoryId').orderBy('price').as('price_rank')])
  Then the SQL should contain 'RANK() OVER (PARTITION BY "categoryId" ORDER BY "price" ASC)'
  And the alias should be "price_rank"
```

### Scenario 3: Aggregate window function with field

```gherkin
Scenario: Create SUM window function
  Given a query builder for 'sales'
  When I call columns(['id', sum('amount').partitionBy('userId').orderBy('date').as('running_total')])
  Then the SQL should contain 'SUM("amount") OVER (PARTITION BY "userId" ORDER BY "date" ASC)'
  And WindowIntent.field should be 'amount'
```

### Scenario 4: Multiple partitionBy calls append

```gherkin
Scenario: Chain multiple partitionBy calls
  Given a WindowBuilder from rank()
  When I call .partitionBy('region').partitionBy('year')
  Then both 'region' and 'year' should be in the partition clause
  And SQL should contain 'PARTITION BY "region", "year"'
```

### Scenario 5: Multiple orderBy calls append

```gherkin
Scenario: Chain multiple orderBy calls
  Given a WindowBuilder from rowNumber()
  When I call .orderBy('date').orderBy('id', 'desc')
  Then both fields should be in the order clause
  And SQL should contain 'ORDER BY "date" ASC, "id" DESC'
```

### Scenario 6: Immutability - builder not mutated

```gherkin
Scenario: Builder immutability
  Given a WindowBuilder instance 'b1' from rowNumber()
  When I call b1.orderBy('price') to get 'b2'
  And I call b1.orderBy('name') to get 'b3'
  Then b2 and b3 should have different order clauses
  And b1 should have no order clause
```

### Scenario 7: denseRank function

```gherkin
Scenario: Create DENSE_RANK
  Given a query builder for 'employees'
  When I call columns([denseRank().partitionBy('dept').orderBy('salary', 'desc').as('salary_rank')])
  Then the SQL should contain 'DENSE_RANK() OVER'
```

### Scenario 8: avg, count, min, max functions

```gherkin
Scenario: Aggregate window functions
  Given a query builder for 'employees'
  When I use avg('salary'), count('id'), min('salary'), max('salary')
  Then each should produce correct SQL: AVG("salary"), COUNT("id"), MIN("salary"), MAX("salary")
```

### Scenario 9: lag and lead offset functions

```gherkin
Scenario: LAG/LEAD functions
  Given a query builder for 'sales'
  When I call lag('amount').orderBy('date').as('prev_amount')
  And I call lead('amount').orderBy('date').as('next_amount')
  Then SQL should contain 'LAG("amount") OVER' and 'LEAD("amount") OVER'
```

### Scenario 10: Integration with existing columns API (DX-020)

```gherkin
Scenario: Mix strings and window expressions in columns()
  Given a query builder for 'products'
  When I call columns(['id', 'name', rowNumber().orderBy('price').as('rn'), sum('price').partitionBy('categoryId').as('cat_total')])
  Then SQL should select id, name, and both window expressions
```

### Scenario 11: Error - old .window() method removed

```gherkin
Scenario: Old API removed
  Given a query builder
  When I try to call .window('alias', options)
  Then TypeScript should error (method doesn't exist)
```

### Edge Case Scenarios

### Scenario E1: No partitionBy (entire result set)

```gherkin
Scenario: Window over entire result set
  Given a WindowBuilder from rowNumber()
  When I only call .orderBy('id').as('global_rn')
  Then SQL should have 'OVER (ORDER BY "id" ASC)' with no PARTITION BY
```

### Scenario E2: No orderBy (unordered partition)

```gherkin
Scenario: Unordered partition
  Given a WindowBuilder from count('id')
  When I only call .partitionBy('category').as('cat_count')
  Then SQL should have 'OVER (PARTITION BY "category")' with no ORDER BY
```

### Scenario E3: Empty window (neither partition nor order)

```gherkin
Scenario: Window over entire unordered set
  Given a WindowBuilder from count('id')
  When I only call .as('total_count')
  Then SQL should have 'OVER ()' (empty over clause)
```

## 5. Implementation Plan

### Block 1: Core Type Updates

**Package:** packages/core
**Complexity:** S (Small)

**Tasks:**
1. Add WindowIntent to ExpressionIntent union in `intent-ast.ts`

```typescript
// intent-ast.ts
export type ExpressionIntent =
  | CoalesceExpressionIntent
  | RawExpressionIntent
  | WindowIntent;  // Add this
```

**Test:** TypeScript compilation passes, existing tests pass

---

### Block 2: WindowBuilder Class

**Package:** packages/dx
**Complexity:** M (Medium)

**Tasks:**
1. Create `WindowBuilder` class in `filters.ts`
2. Implement `.partitionBy(...fields)` - appends fields, returns new builder
3. Implement `.orderBy(field, direction?)` - appends, returns new builder
4. Implement `.as(alias)` - returns ExpressionSpec with WindowIntent

**Design:**

```typescript
// Types for builder state
type WindowFunctionKind =
  | { type: 'ranking'; fn: 'row_number' | 'rank' | 'dense_rank' }
  | { type: 'aggregate'; fn: 'sum' | 'avg' | 'count' | 'min' | 'max'; field: string }
  | { type: 'offset'; fn: 'lag' | 'lead'; field: string };

class WindowBuilder {
  private readonly fnKind: WindowFunctionKind;
  private readonly partitions: readonly string[];
  private readonly orders: readonly { field: string; direction: 'asc' | 'desc' }[];

  private constructor(
    fnKind: WindowFunctionKind,
    partitions: readonly string[] = [],
    orders: readonly { field: string; direction: 'asc' | 'desc' }[] = []
  ) { ... }

  partitionBy(...fields: string[]): WindowBuilder {
    return new WindowBuilder(this.fnKind, [...this.partitions, ...fields], this.orders);
  }

  orderBy(field: string, direction: 'asc' | 'desc' = 'asc'): WindowBuilder {
    return new WindowBuilder(this.fnKind, this.partitions, [...this.orders, { field, direction }]);
  }

  as(alias: string): ExpressionSpec {
    return {
      __expr: true,
      intent: this.toWindowIntent(alias)
    };
  }

  private toWindowIntent(alias: string): WindowIntent { ... }
}
```

**Tests:**
- Unit tests for builder immutability
- Unit tests for partition/order appending
- Unit tests for `.as()` returning correct ExpressionSpec

---

### Block 3: Factory Functions

**Package:** packages/dx
**Complexity:** S (Small)

**Tasks:**
1. Create ranking function factories (no field): `rowNumber()`, `rank()`, `denseRank()`
2. Create aggregate function factories (with field): `sum(field)`, `avg(field)`, `count(field)`, `min(field)`, `max(field)`
3. Create offset function factories (with field): `lag(field)`, `lead(field)`
4. Export all from `index.ts`

**Design:**

```typescript
// Ranking - no field parameter
export function rowNumber(): WindowBuilder {
  return WindowBuilder.ranking('row_number');
}
export function rank(): WindowBuilder {
  return WindowBuilder.ranking('rank');
}
export function denseRank(): WindowBuilder {
  return WindowBuilder.ranking('dense_rank');
}

// Aggregate - require field
export function sum(field: string): WindowBuilder {
  return WindowBuilder.aggregate('sum', field);
}
// ... avg, count, min, max

// Offset - require field
export function lag(field: string): WindowBuilder {
  return WindowBuilder.offset('lag', field);
}
export function lead(field: string): WindowBuilder {
  return WindowBuilder.offset('lead', field);
}
```

**Tests:** Unit tests for each factory function

---

### Block 4: Remove Old window() Method

**Package:** packages/dx
**Complexity:** S (Small)
**BREAKING CHANGE**

**Tasks:**
1. Remove `window()` method from QueryBuilderImpl
2. Remove `windowIntents` array from QueryBuilderImpl state
3. Keep `WindowOptions` type (may be useful internally)
4. Update existing tests to use new API

**Migration:**

```typescript
// Old API
.window('rn', { function: 'row_number', orderBy: [{ field: 'price' }] })

// New API
.columns([rowNumber().orderBy('price').as('rn')])
```

**Tests:** Update all window-functions.test.ts to use new API

---

### Block 5: Integration with columns() API

**Package:** packages/dx
**Complexity:** S (Small)

**Tasks:**
1. Ensure `isExpressionSpec()` works with WindowIntent
2. Verify `columns()` processes window ExpressionSpecs correctly
3. Verify compiler handles WindowIntent in select expressions

**Tests:**
- Integration test: mix strings + window expressions in columns()
- Verify SQL output from dump()

---

## 6. Test Strategy

### Test Matrix

| Scenario | Unit | Integration | E2E |
|----------|------|-------------|-----|
| S1: Basic rowNumber | Yes | Yes | - |
| S2: rank with partition | Yes | Yes | - |
| S3: sum aggregate | Yes | Yes | - |
| S4: Multiple partitionBy | Yes | - | - |
| S5: Multiple orderBy | Yes | - | - |
| S6: Immutability | Yes | - | - |
| S7: denseRank | Yes | Yes | - |
| S8: avg/count/min/max | Yes | Yes | - |
| S9: lag/lead | Yes | Yes | - |
| S10: columns() integration | - | Yes | - |
| S11: Old API removed | Yes | - | - |
| E1: No partitionBy | Yes | - | - |
| E2: No orderBy | Yes | - | - |
| E3: Empty window | Yes | - | - |

### Test Files

| File | Tests |
|------|-------|
| `packages/dx/src/window-builder.test.ts` | New file: WindowBuilder unit tests |
| `packages/dx/src/window-functions.test.ts` | Update: migrate to new API |

### Test Data

- Reuse existing test schema from window-functions.test.ts
- No new fixtures needed

---

## Definition of Done

- [x] Block 1: WindowIntent added to ExpressionIntent
- [x] Block 2: WindowBuilder class implemented with tests
- [x] Block 3: 10 factory functions exported
- [x] Block 4: Old .window() method removed
- [x] Block 5: Integration with columns() verified
- [x] All BDD scenarios have passing tests (21 tests)
- [x] All existing tests pass (or migrated)
- [x] Lint/typecheck pass
- [x] Documentation updated (if applicable)

**Completed:** 2026-01-10
