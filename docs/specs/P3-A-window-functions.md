---
doc-meta:
  status: canonical
  scope: core, adapter, dx
  type: specification
  created: 2026-01-09
  updated: 2026-01-09
---

# Specification: P3-A Window Functions

## 1. User Stories

### US-1: Analytics Developer

**AS A** developer building analytics dashboards
**I WANT** to compute row numbers, rankings, and running totals
**SO THAT** I can paginate results and show trends without raw SQL

**ACCEPTANCE:** Window functions compile to correct SQL with proper escaping

### US-2: Report Builder

**AS A** developer creating financial reports
**I WANT** to calculate running sums and averages partitioned by account
**SO THAT** I can show cumulative balances per entity

**ACCEPTANCE:** Aggregate window functions work with PARTITION BY

## 2. Business Rules

### Invariants

- Window function names MUST be from the allowlisted union type
- Column references MUST be escaped through Kysely's identifier handling
- Aggregate window functions (sum, avg, count, min, max) REQUIRE a field
- Ranking functions (row_number, rank, dense_rank) do NOT take a field

### Preconditions

- QueryBuilder must have a valid `from` table set
- WindowIntent must have a unique alias (not conflicting with other selects)

### Effects

- Window intent is added to the SELECT clause of the compiled SQL
- OVER clause is generated with PARTITION BY and/or ORDER BY as specified

### Errors

| Error | Condition | Recovery |
|-------|-----------|----------|
| TypeScript compilation | Aggregate function without field | Add field parameter |
| TypeScript compilation | Invalid function name | Use valid WindowFunction |
| UnsupportedOperationError | Dialect without window support | Use supported dialect |
| SQL Error | Duplicate alias | Change alias name |

## 3. Technical Impact

### Core Package (`packages/core`)

| Component | Changes |
|-----------|---------|
| `intent-ast.ts` | Add `WindowFunction`, `WindowIntent`, `isWindowIntent` |
| `planner.ts` | Pass WindowIntent through to plan (no transformation needed) |
| Type exports | Export new types from index.ts |

### Adapter Package (`packages/adapter-kysely`)

| Component | Changes |
|-----------|---------|
| `compiler.ts` | Add `compileWindowSelect()` function |
| `dialect.ts` | Add `supportsWindowFunctions` capability |
| Type exports | Export new function from index.ts |

### DX Package (`packages/dx`)

| Component | Changes |
|-----------|---------|
| `query-builder.ts` | Add `window()` method to QueryBuilder |
| `types.ts` | Add `WindowOptions` interface |
| Type exports | Export from index.ts |

### Observability

- WindowIntent visible in `dump().plan`
- Generated SQL visible in `dump().sql`
- No PII concerns (function names + column refs only)

## 4. Acceptance Criteria (BDD Scenarios)

### Feature: Window Intent Type System

```gherkin
Scenario: Create row_number window intent
  Given a WindowIntent with function 'row_number'
  And orderBy: [{ field: 'created_at', direction: 'desc' }]
  And alias: 'row_num'
  When isWindowIntent is called
  Then it returns true
  And the intent has kind 'window'

Scenario: Create aggregate window intent with field
  Given a WindowIntent with function 'sum'
  And field: 'amount'
  And partitionBy: ['user_id']
  And alias: 'running_total'
  When the intent is created
  Then it is valid TypeScript
  And field is required

Scenario: Aggregate window without field fails
  Given an attempt to create WindowIntent with function 'sum'
  And no field specified
  When TypeScript compilation runs
  Then it fails with type error
```

### Feature: Window Function Compilation

```gherkin
Scenario: Compile row_number with ORDER BY
  Given a WindowIntent:
    | function | row_number |
    | alias    | rn         |
    | orderBy  | [{ field: 'created_at', direction: 'desc' }] |
  When compileWindowSelect is called
  Then SQL contains 'ROW_NUMBER() OVER (ORDER BY "created_at" DESC) AS "rn"'

Scenario: Compile rank with PARTITION BY and ORDER BY
  Given a WindowIntent:
    | function    | rank |
    | alias       | category_rank |
    | partitionBy | ['category_id'] |
    | orderBy     | [{ field: 'sales', direction: 'desc' }] |
  When compileWindowSelect is called
  Then SQL contains 'RANK() OVER (PARTITION BY "category_id" ORDER BY "sales" DESC) AS "category_rank"'

Scenario: Compile SUM aggregate window
  Given a WindowIntent:
    | function    | sum |
    | field       | amount |
    | alias       | running_sum |
    | partitionBy | ['account_id'] |
    | orderBy     | [{ field: 'date', direction: 'asc' }] |
  When compileWindowSelect is called
  Then SQL contains 'SUM("amount") OVER (PARTITION BY "account_id" ORDER BY "date" ASC) AS "running_sum"'

Scenario: Compile window with multi-tenant schema
  Given a WindowIntent with function 'row_number' and alias 'rn'
  And tenant schema 'acme'
  When compileWindowSelect is called with schema prefix
  Then table references include schema prefix

Scenario: Empty partitionBy compiles without PARTITION BY
  Given a WindowIntent:
    | function    | row_number |
    | alias       | global_rn |
    | partitionBy | [] |
    | orderBy     | [{ field: 'id' }] |
  When compileWindowSelect is called
  Then SQL contains 'ROW_NUMBER() OVER (ORDER BY "id") AS "global_rn"'
  And SQL does NOT contain 'PARTITION BY'

Scenario: Unsupported dialect throws error
  Given a dialect with supportsWindowFunctions: false
  When compileWindowSelect is called
  Then UnsupportedOperationError is thrown
  And message contains 'window functions'
```

### Feature: DX Window Builder API

```gherkin
Scenario: Add window function via builder
  Given a QueryBuilder for 'products' table
  When .window('rn', { function: 'row_number', orderBy: [{ field: 'price' }] }) is called
  Then the builder contains a WindowIntent
  And the alias is 'rn'

Scenario: Chain multiple window functions
  Given a QueryBuilder for 'sales' table
  When .window('row_num', { function: 'row_number', orderBy: [{ field: 'date' }] })
  And .window('running_total', { function: 'sum', field: 'amount', partitionBy: ['product_id'] })
  Then both WindowIntents are in the compiled query

Scenario: Window function with dump
  Given a QueryBuilder with a window function
  When .dump() is called
  Then the dump contains the WindowIntent in plan
  And SQL shows the window function

Scenario: Window function execution
  Given a QueryBuilder with db configured
  And a window function for row_number
  When .findMany() is called
  Then results include the window column
```

## 5. Implementation Plan

### Block 1: Core WindowIntent Types

**Packages:** `packages/core`
**Complexity:** S
**Dependencies:** None

**Tasks:**
1. Add `WindowFunction` type to `intent-ast.ts`:
   ```typescript
   export type WindowFunction =
     | 'row_number' | 'rank' | 'dense_rank'
     | 'sum' | 'avg' | 'count' | 'min' | 'max'
     | 'lag' | 'lead';
   ```

2. Add `WindowIntent` interface:
   ```typescript
   export interface WindowIntent {
     kind: 'window';
     function: WindowFunction;
     field?: string;  // Required for aggregate functions
     alias: string;
     over: {
       partitionBy?: string[];
       orderBy?: Array<{ field: string; direction?: 'asc' | 'desc' }>;
     };
   }
   ```

3. Add `isWindowIntent` type guard

4. Export from `index.ts`

**Tests:**
- Unit tests for type guard
- Type-level tests for WindowIntent shape

**Acceptance criteria covered:** #1, #2, #3

---

### Block 2: Adapter Dialect Capability

**Packages:** `packages/adapter-kysely`
**Complexity:** S
**Dependencies:** Block 1

**Tasks:**
1. Add `supportsWindowFunctions: boolean` to `DialectCapabilities` interface
2. Update dialect profiles:
   - PostgreSQL: `true`
   - MySQL: `true` (8.0+)
   - SQLite: `true` (3.25+)
   - MSSQL: `true`
3. Add `assertWindowFunctionSupport()` helper

**Tests:**
- Capability detection tests
- Assertion error tests

**Acceptance criteria covered:** #7

---

### Block 3: Adapter Window Compiler

**Packages:** `packages/adapter-kysely`
**Complexity:** M
**Dependencies:** Block 1, Block 2

**Tasks:**
1. Implement `compileWindowSelect()` function:
   ```typescript
   export function compileWindowSelect(
     intent: WindowIntent,
     options?: { schemaName?: string }
   ): RawBuilder<unknown>
   ```

2. Handle ranking functions (no field):
   - `ROW_NUMBER() OVER (...)`
   - `RANK() OVER (...)`
   - `DENSE_RANK() OVER (...)`

3. Handle aggregate functions (with field):
   - `SUM("field") OVER (...)`
   - `AVG("field") OVER (...)`
   - etc.

4. Build OVER clause:
   - PARTITION BY (if partitionBy provided and non-empty)
   - ORDER BY (if orderBy provided)

5. Integrate with main `compile()` function

**Tests:**
- Ranking function compilation
- Aggregate function compilation
- PARTITION BY + ORDER BY combinations
- Empty partitionBy handling
- Multi-tenant schema prefix
- Dialect capability guard

**Acceptance criteria covered:** #4, #5, #6, #7

---

### Block 4: DX Window Builder API

**Packages:** `packages/dx`
**Complexity:** M
**Dependencies:** Block 1, Block 3

**Tasks:**
1. Add `WindowOptions` interface:
   ```typescript
   export interface WindowOptions {
     function: WindowFunction;
     field?: string;
     partitionBy?: string[];
     orderBy?: Array<{ field: string; direction?: 'asc' | 'desc' }>;
   }
   ```

2. Add `window()` method to QueryBuilder:
   ```typescript
   window(alias: string, options: WindowOptions): QueryBuilder<TResult>
   ```

3. Store window intents in builder state

4. Pass window intents through to compiler

**Tests:**
- Builder method tests
- Chaining tests
- Integration with dump()
- Execution tests (mock)

**Acceptance criteria covered:** #8, #9, #10

---

## 6. Test Strategy

### Test Matrix

| Scenario | Unit | Integration | E2E |
|----------|------|-------------|-----|
| WindowIntent type guard | ✅ | - | - |
| compileWindowSelect ROW_NUMBER | ✅ | - | - |
| compileWindowSelect RANK | ✅ | - | - |
| compileWindowSelect SUM | ✅ | - | - |
| PARTITION BY + ORDER BY | ✅ | - | - |
| Multi-tenant schema | ✅ | - | - |
| Dialect capability guard | ✅ | - | - |
| DX window() method | ✅ | - | - |
| DX chaining | ✅ | - | - |
| DX dump() | ✅ | - | - |
| Real PostgreSQL window | - | - | ✅ |

### Test Data Strategy

- Use existing test fixtures (products, categories, users)
- Add `sales` fixture for running totals scenarios
- No special test tenant setup needed (unit tests only)

### Test Count Estimate

| Package | Estimated Tests |
|---------|-----------------|
| core | ~8 tests |
| adapter-kysely | ~20 tests |
| dx | ~15 tests |
| e2e (optional) | ~5 tests |
| **Total** | ~48 tests |

---

## 7. Security Considerations

| Concern | Mitigation |
|---------|------------|
| SQL Injection via function name | Union type allowlist (compile-time) |
| SQL Injection via column names | Kysely identifier escaping |
| SQL Injection via alias | Kysely identifier escaping |

---

## Definition of Done

- [x] All blocks implemented (2026-01-09)
- [x] All BDD scenarios have passing tests
- [x] All ~48 tests pass (40 window-specific tests: 8 core + 17 adapter + 15 dx)
- [x] Lint/typecheck pass across all 3 packages
- [x] Types exported from index.ts files
- [x] Documentation updated (TODO files)
