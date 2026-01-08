---
doc-meta:
  status: canonical
  scope: core, adapter
  type: specification
  created: 2026-01-08
  updated: 2026-01-08
---

# Specification: ARCH-001 Dialect-Agnostic Recursive CTE

## 1. User Stories

### US-001: Multi-Dialect Path Tracking

```
AS A developer using db-semantic-planner with MySQL or SQLite
I WANT recursive CTE path tracking to work without PostgreSQL-specific arrays
SO THAT I can use hierarchy queries on any supported database
```

**ACCEPTANCE:** Path tracking works with `strategy: 'string'` on dialects lacking array support.

---

## 2. Business Rules

### Invariants

| Rule | Description |
|------|-------------|
| INV-001 | Core MUST NOT contain any dialect-specific SQL syntax |
| INV-002 | Adapter MUST respect `track.path.strategy` from intent |
| INV-003 | Default strategy MUST remain `'array'` for backward compatibility |
| INV-004 | String strategy MUST use configurable separator (default: `/`) |

### Preconditions

| Precondition | Validation |
|--------------|------------|
| PRE-001 | Dialect capabilities MUST be detected before recursive CTE compilation |
| PRE-002 | If `strategy: 'array'` requested on non-PostgreSQL, MUST throw `UnsupportedOperationError` |

### Effects

| Effect | Description |
|--------|-------------|
| EFF-001 | `strategy: 'array'` → PostgreSQL `ARRAY[...]` + `||` operator |
| EFF-002 | `strategy: 'string'` → String concat with separator |
| EFF-003 | Default (undefined) → Inferred from dialect capabilities |

### Errors

| Error | Condition | Message |
|-------|-----------|---------|
| ERR-001 | `strategy: 'array'` on MySQL/SQLite | `Array path tracking requires PostgreSQL. Use strategy: 'string' or remove path tracking.` |
| ERR-002 | Recursive CTE on dialect without CTE support | `Recursive CTEs are not supported by {dialect}` |

---

## 3. Technical Impact

### Core Package (`packages/core`)

| Change | Description | Files |
|--------|-------------|-------|
| Extend `RecursiveTrackOptions.path` | Add `separator?: string` option | `intent-ast.ts` |
| Export type | Ensure public API access | `index.ts` |

**New interface shape:**
```typescript
export interface RecursiveTrackOptions {
  readonly path?: {
    readonly by?: 'nodeId' | readonly string[];
    readonly as?: string;
    readonly strategy?: 'array' | 'string';
    readonly separator?: string; // NEW: Default '/' for string strategy
  };
  // ... depth, isCycle unchanged
}
```

### Adapter Package (`packages/adapter-kysely`)

| Change | Description | Files |
|--------|-------------|-------|
| Add `supportsArrayType` capability | Detect PostgreSQL array support | `dialect.ts` |
| Implement `PathTrackingCompiler` | Strategy-based path compilation | `compiler.ts` |
| Capability check before compilation | Guard against unsupported operations | `compiler.ts` |

**Capability addition:**
```typescript
export interface DialectCapabilities {
  // ... existing
  readonly supportsArrayType: boolean; // NEW
}
```

**Strategy implementation logic:**
```typescript
function getPathStrategy(
  intent: RecursiveTrackOptions['path'],
  capabilities: DialectCapabilities
): 'array' | 'string' {
  if (intent?.strategy) return intent.strategy;
  return capabilities.supportsArrayType ? 'array' : 'string';
}
```

### DX Package (`packages/dx`)

No changes required. DX builds on top of adapter, inherits behavior.

---

## 4. Acceptance Criteria (BDD Scenarios)

### Scenario 1: Array Strategy on PostgreSQL (Nominal)

```gherkin
Scenario: Array path tracking on PostgreSQL
  Given a RecursiveIntent with track.path.strategy = 'array'
  And the database dialect is PostgreSQL
  When the compiler generates the recursive CTE
  Then the base case uses ARRAY[node_id]
  And the recursive step uses prev.path || node_id
  And the query executes successfully
```

### Scenario 2: String Strategy on MySQL (Nominal)

```gherkin
Scenario: String path tracking on MySQL
  Given a RecursiveIntent with track.path.strategy = 'string'
  And track.path.separator = '/'
  And the database dialect is MySQL
  When the compiler generates the recursive CTE
  Then the base case uses CAST(node_id AS CHAR)
  And the recursive step uses CONCAT(prev.path, '/', node_id)
  And the query executes successfully
```

### Scenario 3: Default Strategy Inference (Nominal)

```gherkin
Scenario: Strategy inferred from dialect capabilities
  Given a RecursiveIntent with track.path (no explicit strategy)
  And the database dialect is SQLite
  When the compiler generates the recursive CTE
  Then strategy 'string' is automatically selected
  And the path uses string concatenation with default separator '/'
```

### Scenario 4: Array Strategy on MySQL (Error)

```gherkin
Scenario: Array strategy fails on non-PostgreSQL
  Given a RecursiveIntent with track.path.strategy = 'array'
  And the database dialect is MySQL
  When the compiler attempts to generate the recursive CTE
  Then an UnsupportedOperationError is thrown
  And the error message contains "Array path tracking requires PostgreSQL"
  And the error suggests using strategy: 'string'
```

### Scenario 5: Custom Separator (Edge Case)

```gherkin
Scenario: Custom separator for string strategy
  Given a RecursiveIntent with track.path.strategy = 'string'
  And track.path.separator = '->'
  When the compiler generates the recursive CTE
  Then the recursive step uses CONCAT(prev.path, '->', node_id)
```

### Scenario 6: Backward Compatibility (Regression)

```gherkin
Scenario: Existing code without strategy continues to work
  Given a RecursiveIntent with track.path (no strategy specified)
  And the database dialect is PostgreSQL
  When the compiler generates the recursive CTE
  Then the behavior is identical to strategy: 'array'
  And all existing tests pass without modification
```

### Scenario 7: Path with Multiple Columns (Edge Case)

```gherkin
Scenario: Path tracking multiple columns with string strategy
  Given a RecursiveIntent with track.path.by = ['id', 'name']
  And track.path.strategy = 'string'
  And track.path.separator = '/'
  When the compiler generates the recursive CTE
  Then the base case concatenates id and name: 'id:name'
  And the recursive step appends new id:name pairs with separator
```

---

## 5. Implementation Plan

### Block 1: Extend Core Interface (Vertical Slice)

**Packages:** `packages/core`

**Changes:**
- **Model/Schema:** Add `separator?: string` to `RecursiveTrackOptions.path` in `intent-ast.ts`
- **Export:** Ensure type is exported from `index.ts` (already exported)
- **Tests:** Add type-level tests for new option (compilation check)

**Exit Criteria:**
- TypeScript compiles with new option
- Existing tests pass (backward compatible)

**Complexity:** S (< 30 min)
**Dependencies:** None

### Block 2: Add supportsArrayType Capability (Vertical Slice)

**Packages:** `packages/adapter-kysely`

**Changes:**
- **dialect.ts:** Add `supportsArrayType: boolean` to `DialectCapabilities`
- **dialect.ts:** Update dialect profiles (PostgreSQL: true, others: false)
- **Tests:** Add capability detection tests for each dialect

**Exit Criteria:**
- `getCapabilities('postgresql').supportsArrayType === true`
- `getCapabilities('mysql').supportsArrayType === false`
- `getCapabilities('sqlite').supportsArrayType === false`

**Acceptance criteria covered:** Prerequisite for #1, #2, #3, #4

**Complexity:** S (< 30 min)
**Dependencies:** None (parallel with Block 1)

### Block 3: Implement PathTrackingCompiler (Vertical Slice)

**Packages:** `packages/adapter-kysely`

**Changes:**
- **compiler.ts:** Extract path tracking logic into `compilePathTracking()` function
- **compiler.ts:** Implement strategy selection based on capabilities
- **compiler.ts:** Implement array strategy (existing code, refactored)
- **compiler.ts:** Implement string strategy (new code)
- **compiler.ts:** Add capability guard with `UnsupportedOperationError`
- **Tests:** Unit tests for each strategy

**Implementation detail:**
```typescript
function compilePathTracking(
  eb: ExpressionBuilder<any, any>,
  column: string,
  pathOptions: RecursiveTrackOptions['path'],
  capabilities: DialectCapabilities,
  isBaseCase: boolean
): AliasedExpression<any, string> {
  const strategy = pathOptions?.strategy ??
    (capabilities.supportsArrayType ? 'array' : 'string');
  const separator = pathOptions?.separator ?? '/';
  const alias = pathOptions?.as ?? 'path';

  if (strategy === 'array') {
    if (!capabilities.supportsArrayType) {
      throw new UnsupportedOperationError(
        'supportsArrayType',
        'unknown', // or actual dialect
        'Array path tracking requires PostgreSQL. Use strategy: \'string\' or remove path tracking.'
      );
    }
    return isBaseCase
      ? sql`ARRAY[${sql.ref(column)}]`.as(alias)
      : eb(eb.ref('prev.path'), '||', eb.ref(column)).as(alias);
  }

  // String strategy
  return isBaseCase
    ? eb.cast(eb.ref(column), 'text').as(alias)
    : eb.fn('concat', [
        eb.ref('prev.path'),
        eb.lit(separator),
        eb.ref(column)
      ]).as(alias);
}
```

**Exit Criteria:**
- Array strategy produces same SQL as current implementation
- String strategy produces valid SQL for MySQL/SQLite
- Capability guard throws correct error

**Acceptance criteria covered:** #1, #2, #3, #4, #5

**Complexity:** M (30 min - 2h)
**Dependencies:** Block 1, Block 2

### Block 4: Integration Tests (Vertical Slice)

**Packages:** `packages/adapter-kysely`

**Changes:**
- **compiler.test.ts:** Add test suite for path tracking strategies
- **compiler.test.ts:** Add error scenario tests
- **compiler.test.ts:** Add backward compatibility regression tests

**Test cases:**
1. `strategy: 'array'` on PostgreSQL → ARRAY syntax
2. `strategy: 'string'` on any dialect → CONCAT syntax
3. Default strategy on PostgreSQL → array
4. Default strategy on MySQL → string
5. `strategy: 'array'` on MySQL → UnsupportedOperationError
6. Custom separator → appears in SQL
7. Existing tests unchanged (regression)

**Exit Criteria:**
- All new tests pass
- All existing tests pass (0 regressions)
- Coverage for all scenarios

**Acceptance criteria covered:** All (validation layer)

**Complexity:** M (30 min - 2h)
**Dependencies:** Block 3

---

## 6. Test Strategy

### Test Matrix

| Scenario | Unit | Integration | E2E |
|----------|------|-------------|-----|
| Array strategy PostgreSQL | Yes | Yes | Deferred |
| String strategy MySQL | Yes | - | Deferred |
| String strategy SQLite | Yes | - | Deferred |
| Default inference | Yes | Yes | - |
| Error: array on MySQL | Yes | - | - |
| Custom separator | Yes | - | - |
| Backward compatibility | Yes | Yes | Yes (existing) |
| Multiple columns path | Yes | - | - |

### Test Data Strategy

**Fixtures:**
- Reuse existing `createTestModel()` for roles/roleEdges hierarchy
- Add `MockDialectDb` helper for dialect capability testing

**Mock requirements:**
- `withMockedCapabilities({ supportsArrayType: false })` for MySQL/SQLite simulation

### Test File Structure

```
packages/adapter-kysely/src/
├── compiler.test.ts
│   └── describe('Recursive CTE path tracking')
│       ├── describe('Array strategy')
│       │   ├── it('generates ARRAY[] base case')
│       │   └── it('generates || recursive step')
│       ├── describe('String strategy')
│       │   ├── it('generates CAST base case')
│       │   ├── it('generates CONCAT recursive step')
│       │   └── it('uses custom separator')
│       ├── describe('Strategy inference')
│       │   ├── it('defaults to array on PostgreSQL')
│       │   └── it('defaults to string on MySQL/SQLite')
│       └── describe('Error handling')
│           └── it('throws UnsupportedOperationError for array on MySQL')
```

---

## 7. Definition of Done

- [ ] All blocks implemented
- [ ] All BDD scenarios have passing tests
- [ ] All 553+ existing tests pass (0 regressions)
- [ ] Lint/typecheck pass
- [ ] Documentation updated (RFC-001, TODO_ADAPTER.md)
- [ ] Backward compatibility verified

---

## 8. Open Questions (Resolved)

| # | Question | Resolution |
|---|----------|------------|
| Q1 | Should we add `supportsRecursiveCTE` capability? | NO - CTE support already exists, array type is the differentiator |
| Q2 | Should separator be configurable or hardcoded? | CONFIGURABLE - Add `separator?: string` with default `/` |
