---
doc-meta:
  status: canonical
  scope: cli
  type: specification
  created: 2026-01-24
  updated: 2026-01-24
  completed: 2026-01-24
  complexity: COMPLEX
  time-budget: 60min
---

# Specification: Typed Assertion System

## 0. Quick Reference (ALWAYS VISIBLE)

| Item | Value |
|------|-------|
| Scope | cli |
| Complexity | COMPLEX |
| Time budget | 60 min |
| Blocks | 3 |
| BDD scenarios | 12 |
| Risk level | LOW |

## 1. Problem Statement

The current assertion system uses generic `output.contains` for all validations, leading to:
- **False positives**: Substring matches unrelated text
- **Mode confusion**: Mixing dry-run tests (SQL) with DB tests (execution results)
- **CI failures**: 174 assertions fail when running without `--db` because they expect row counts

This spec introduces typed primitives that separate concerns and enable reliable CI.

## 2. User Stories

### US-01: CI Engineer
AS A CI engineer
I WANT assertions to pass in dry-run mode
SO THAT I can validate SQL generation without a database

ACCEPTANCE: Running without `--db` skips DB assertions gracefully (not fails)

### US-02: Schema Developer
AS A schema developer
I WANT to validate exact row counts
SO THAT I can catch regressions in query results

ACCEPTANCE: `db.rows.equals: 5` fails if query returns 3 rows

### US-03: Test Author
AS A test author
I WANT assertions to handle logical/physical naming
SO THAT `sql.table: "productImages"` works regardless of snake_case conversion

ACCEPTANCE: `sql.table: "productImages"` matches `product_images` in SQL

## 3. Business Rules

### 3.1 Invariants (always true)
- INV-01: All `db.*` assertions require successful query execution
- INV-02: Assertion files without `mode` field default to `mode: both`
- INV-03: Existing assertion types (`output.contains`, etc.) remain functional
- INV-04: `sql.table` comparison is case-insensitive

### 3.2 Preconditions (required before action)
- PRE-01: `db.*` assertions require `--db` connection OR are skipped
- PRE-02: `params.type` requires params array to exist

### 3.3 Effects (what changes)
- EFF-01: New assertion types added to `ASSERTION_TYPES`
- EFF-02: Runner checks mode before executing assertions
- EFF-03: Summary includes "X skipped" count for dry-run mode

### 3.4 Error Handling
- ERR-01: When `db.*` assertion in dry-run mode → skip with reason
- ERR-02: When `params.type` finds object instead of primitive → fail with type info
- ERR-03: When `db.rows.equals` on failed query → skip with warning

## 4. Technical Design

### 4.1 Architecture Decision

Extend existing assertion system (not replace) with:
1. New assertion types in `ASSERTION_TYPES` array
2. Mode-aware execution in runner
3. Backward compatibility via deprecation warnings (not errors)

### 4.2 Data Model Changes

```typescript
// assertion-parser.ts additions
export const ASSERTION_TYPES = [
  // Existing (keep for backward compat)
  'output.contains', 'output.equals', 'output.matches',
  'sql.contains', 'sql.equals', 'sql.matches',
  'params.equals', 'params.length',
  'plan.contains', 'success', 'error.contains',

  // NEW: Typed SQL assertions
  'sql.table',      // Table name (logical or physical)
  'sql.column',     // Column name in SQL
  'sql.join',       // JOIN clause present

  // NEW: Typed params assertions
  'params.type',    // Type validation per param
  'params.value',   // Specific param value by index

  // NEW: DB-only assertions (skipped in dry-run)
  'db.rows.equals', // Exact row count
  'db.rows.min',    // At least N rows
  'db.rows.max',    // At most N rows
  'db.column.exists', // Column in result
  'db.value.equals',  // Specific cell value
] as const;

export type AssertionMode = 'dry-run' | 'db-required' | 'both';

export interface AssertionBlock {
  queryIndex?: number;
  queryMatch?: string;
  startLine: number;
  assertions: Assertion[];
  mode?: AssertionMode; // NEW: defaults to 'both'
}
```

### 4.3 Runner Changes

```typescript
// assertion-runner.ts additions
export interface AssertionOutcome {
  type: AssertionType;
  expected: unknown;
  actual: unknown;
  passed: boolean;
  skipped?: boolean;   // NEW: true if skipped due to mode
  skipReason?: string; // NEW: why it was skipped
  message?: string;
}

export interface AssertionSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;     // NEW
  results: QueryAssertionResult[];
}
```

## 5. Acceptance Criteria (BDD)

### Scenario Group: Mode-Based Execution

```gherkin
@priority:high @type:nominal
Scenario: SC-01 Dry-run skips DB assertions
  Given assertion file with "db.rows.equals: 5"
  And mode is not specified (defaults to 'both')
  When running without --db flag
  Then assertion is skipped (not failed)
  And outcome.skipped = true
  And outcome.skipReason = "No DB connection"
  And summary shows skipped count

@priority:high @type:nominal
Scenario: SC-02 DB mode runs DB assertions
  Given assertion file with "db.rows.equals: 5"
  When running with --db flag
  And query returns 5 rows
  Then assertion passes
  And outcome.passed = true

@priority:high @type:error
Scenario: SC-03 DB assertion fails on count mismatch
  Given assertion "db.rows.equals: 5"
  When running with --db flag
  And query returns 3 rows
  Then assertion fails
  And outcome.message = "Expected 5 rows, got 3"
```

### Scenario Group: SQL Table Matching

```gherkin
@priority:high @type:nominal
Scenario: SC-04 sql.table matches logical name
  Given assertion "sql.table: productImages"
  When SQL contains "product_images"
  Then assertion passes (snake_case conversion)

@priority:high @type:nominal
Scenario: SC-05 sql.table matches with schema
  Given assertion "sql.table: productImages"
  When SQL contains "ch6_pimdam.product_images"
  Then assertion passes

@priority:medium @type:edge
Scenario: SC-06 sql.table case insensitive
  Given assertion "sql.table: ProductImages"
  When SQL contains "productimages"
  Then assertion passes
```

### Scenario Group: Parameter Type Validation

```gherkin
@priority:high @type:nominal
Scenario: SC-07 params.type validates primitives
  Given assertion "params.type: [string, number]"
  When params = ["hello", 42]
  Then assertion passes

@priority:high @type:error
Scenario: SC-08 params.type detects objects
  Given assertion "params.type: [string, number]"
  When params = [{"$ref": "value"}, 42]
  Then assertion fails
  And outcome.message contains "Expected string at index 0, got object"

@priority:medium @type:edge
Scenario: SC-09 params.type handles null
  Given assertion "params.type: [string, null]"
  When params = ["hello", null]
  Then assertion passes
```

### Scenario Group: Row Count Assertions

```gherkin
@priority:high @type:nominal
Scenario: SC-10 db.rows.min validates minimum
  Given assertion "db.rows.min: 3"
  When query returns 5 rows
  Then assertion passes

@priority:high @type:error
Scenario: SC-11 db.rows.min fails below threshold
  Given assertion "db.rows.min: 3"
  When query returns 1 row
  Then assertion fails
  And outcome.message = "Expected at least 3 rows, got 1"

@priority:medium @type:edge
Scenario: SC-12 db.rows.equals handles zero
  Given assertion "db.rows.equals: 0"
  When query returns 0 rows
  Then assertion passes
```

**Coverage matrix:**

| Scenario | Nominal | Edge | Error |
|----------|---------|------|-------|
| SC-01 | ✓ | | |
| SC-02 | ✓ | | |
| SC-03 | | | ✓ |
| SC-04 | ✓ | | |
| SC-05 | ✓ | | |
| SC-06 | | ✓ | |
| SC-07 | ✓ | | |
| SC-08 | | | ✓ |
| SC-09 | | ✓ | |
| SC-10 | ✓ | | |
| SC-11 | | | ✓ |
| SC-12 | | ✓ | |

## 6. Implementation Plan

### Block 1: Types & Parser — 20 min
**Type:** Feature slice
**Dependencies:** None
**Files:**
- `packages/cli/src/repl/assertion-parser.ts` — Add new types, mode field

**Exit criteria:**
- [ ] New assertion types in `ASSERTION_TYPES`
- [ ] `AssertionMode` type exported
- [ ] `AssertionBlock.mode` field added
- [ ] Parser extracts `mode:` field from blocks
- [ ] Unit tests pass

### Block 2: Runner Implementation — 25 min
**Type:** Feature slice
**Dependencies:** Block 1
**Files:**
- `packages/cli/src/repl/assertion-runner.ts` — Implement new assertions

**Exit criteria:**
- [ ] `runAssertion()` handles all new types
- [ ] Mode checking skips `db.*` when no DB
- [ ] `AssertionSummary.skipped` count works
- [ ] Snake_case conversion for `sql.table`
- [ ] Type validation for `params.type`
- [ ] Unit tests pass

### Block 3: Integration & Summary — 15 min
**Type:** Integration
**Dependencies:** Block 2
**Files:**
- `packages/cli/src/repl/batch.ts` — Pass DB flag to runner
- `packages/cli/src/repl/result-formatter.tsx` — Display skipped count

**Exit criteria:**
- [ ] Summary shows "X passed, Y failed, Z skipped"
- [ ] Existing example assertions still work
- [ ] `test-minimal.assert.dbsp` passes
- [ ] Build passes

## 7. Test Strategy

### Test pyramid:

| Level | Count | Focus |
|-------|-------|-------|
| Unit | 12 | Assertion logic |
| Integration | 4 | Parser + Runner |
| E2E | 2 | Full example files |

### Test data requirements:
- Fixtures: Mock `BatchResult` with various row counts
- Mocks: None needed (pure functions)

### Test file additions:
- `assertion-parser.test.ts` — Add mode parsing tests
- `assertion-runner.test.ts` — Add new assertion type tests

## 8. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Breaking existing assertions | HIGH | LOW | Keep old types, add deprecation warning only |
| Complex snake_case logic | MEDIUM | MEDIUM | Use simple regex, test thoroughly |
| Performance regression | LOW | LOW | Assertions are O(1), no loops |

## 9. Definition of Done

- [ ] All blocks implemented
- [ ] All 12 BDD scenarios have passing tests
- [ ] All tests pass (unit + integration)
- [ ] Lint/typecheck pass
- [ ] `test-minimal.assert.dbsp` passes (existing)
- [ ] /review clean (no blocking findings)
