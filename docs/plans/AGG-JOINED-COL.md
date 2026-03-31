---
doc-meta:
  status: canonical
  scope: core, adapter
  type: specification
  target_project: /mnt/wsl/shared/dev/db-semantic-planner
  created: 2026-03-27
  updated: 2026-03-27
  complexity: SIMPLE
  time-budget: 30min
---

# Specification: AGG-JOINED-COL — Aggregate Functions on Joined Columns

## 0. Quick Reference

| Item | Value |
|------|-------|
| Scope | core + adapter-pgsql |
| Complexity | SIMPLE |
| Time budget | 30 min |
| Blocks | 1 |
| BDD scenarios | 6 |
| Risk level | LOW |

## 1. Problem Statement

Aggregate shorthand functions (`count()`, `sum()`, `min()`, `max()`, `avg()`) don't handle dotted column references (`'relation.col'`). The generic `fn('count', ref('relation.col'))` works correctly, but the DX shorthands pass the dotted string as-is to `columnRef()` which produces `"rootTable"."relation.col"` instead of `"relation"."col"`.

This blocks 4 astix code-health checks that need patterns like `count(ref('callers.id'))` with `include('callers', { join: 'inner' })`.

## 2. User Stories

### US-1: Aggregate on Joined Column
AS A developer using dbsp with JOINed tables
I WANT `count('callers.id')` and `min('file.path')` to work in `.columns()`
SO THAT I can use DX shortcuts instead of verbose `fn('count', ref('callers.id'))`

ACCEPTANCE: `count('callers.id')` produces `COUNT("callers"."id")` in compiled SQL

### US-2: HAVING with Joined Aggregate
AS A developer writing grouped queries
I WANT to use `.having(gt(count('callers.id'), 10))` or `.having(gt('call_count', 10))`
SO THAT I can filter groups by aggregate values on joined columns

ACCEPTANCE: HAVING clause references the correct aggregate expression

## 3. Business Rules

### 3.1 Invariants
- INV-01: `fn('count', ref('t.col'))` behavior MUST NOT change (already correct)
- INV-02: Non-dotted aggregate shortcuts MUST NOT change behavior (`count('id')` → same as before)
- INV-03: Core remains DB-agnostic — no adapter imports

### 3.2 Preconditions
- PRE-01: The relation must be JOINed via `include(rel, { join })` or `.join(rel)` for the column to exist in SQL

### 3.3 Effects
- EFF-01: `count('relation.col')` produces `COUNT("relation"."col")`
- EFF-02: `min('relation.col')` produces `MIN("relation"."col")`
- EFF-03: Works in `.columns([count('rel.col').as('cnt')])` and `.having(gt(count('rel.col'), N))`

### 3.4 Error Handling
- ERR-01: If the joined table alias doesn't exist in the query → PostgreSQL error at runtime (same as `ref()` behavior — no dbsp-level validation)

## 4. Technical Design

### 4.1 Architecture Decision

**Option A (chosen): Fix `buildAggregate()` to split dotted column refs** — minimal change, same pattern as `ref()` in `compileExpressionIntent`.

**Option B (rejected): Make shortcuts emit `CustomFnExpressionIntent`** — would change the entire intent type, breaking existing handlers and test assertions.

### 4.2 Changes

| File | Change | Migration |
|------|--------|-----------|
| `adapter-pgsql/src/handlers/expression/aggregate.ts` | `buildAggregate()`: split dotted column on `.` | No |
| Tests (new or existing) | Add tests for dotted column aggregates + HAVING | No |

**No core changes needed.** The aggregate DX functions (`count()`, `sum()`, etc.) already produce `AggregateExpressionIntent` with `field: 'relation.col'` — only the adapter compilation is broken.

### 4.3 The Fix (3-5 lines)

In `buildAggregate()`:
```typescript
// Before:
const colRef = column === '*' ? star() : columnRef(column, tableAlias, undefined, ctx.naming);

// After:
let colRef: Node;
if (column === '*') {
  colRef = star();
} else if (column.includes('.')) {
  const [table, col] = column.split('.', 2);
  colRef = columnRef(col, table, undefined, ctx.naming);
} else {
  colRef = columnRef(column, tableAlias, undefined, ctx.naming);
}
```

## 5. Acceptance Criteria (BDD)

### Scenario Group: Aggregate on Joined Column

```gherkin
@priority:high @type:nominal
Scenario: SC-01 — count() with dotted column ref
  Given a query on 'symbols' with include('callee_calls', { join: 'inner' })
  When .columns([count('callee_calls.id').as('call_count')]) is called
  Then SQL contains COUNT("callee_calls"."id") AS "call_count"

@priority:high @type:nominal
Scenario: SC-02 — min() with dotted column ref
  Given a query on 'symbols' with include('file', { join: 'left' })
  When .columns([min('file.path').as('min_path')]) is called
  Then SQL contains MIN("file"."path") AS "min_path"

@priority:high @type:nominal
Scenario: SC-03 — HAVING with dotted aggregate
  Given a query with groupBy and joined aggregate
  When .having(gt(count('callee_calls.id'), 10)) is called
  Then SQL contains HAVING COUNT("callee_calls"."id") > $1

@priority:medium @type:edge
Scenario: SC-04 — Non-dotted aggregate unchanged (regression guard)
  Given a simple query on 'symbols'
  When .columns([count('id').as('total')]) is called
  Then SQL contains COUNT("symbols"."id") AS "total" (unchanged behavior)

@priority:medium @type:edge
Scenario: SC-05 — count(*) unchanged (regression guard)
  Given a simple query
  When .count() is called
  Then SQL contains COUNT(*) (unchanged)

@priority:medium @type:edge
Scenario: SC-06 — fn('count', ref('rel.col')) still works (INV-01)
  Given a query with include + fn() API
  When .columns([fn('count', ref('callee_calls.id')).as('cnt')]) is called
  Then SQL contains COUNT("callee_calls"."id") AS "cnt"
```

**Coverage matrix:**

| Scenario | Nominal | Edge | Error | Security |
|----------|---------|------|-------|----------|
| SC-01 | ✓ | | | |
| SC-02 | ✓ | | | |
| SC-03 | ✓ | | | |
| SC-04 | | ✓ | | |
| SC-05 | | ✓ | | |
| SC-06 | | ✓ | | |

## 6. Implementation Plan

### Block 1: Fix buildAggregate + Tests — 30min

**Type:** Bugfix
**Dependencies:** None
**Files:**
- `packages/adapter-pgsql/src/handlers/expression/aggregate.ts` — split dotted column in `buildAggregate()`
- `packages/adapter-pgsql/src/__tests__/agg-joined-col.test.ts` — 6 test cases (SC-01 to SC-06)

**Exit criteria:**
- [ ] `count('relation.col')` produces `COUNT("relation"."col")`
- [ ] `min('relation.col')` produces `MIN("relation"."col")`
- [ ] HAVING with dotted aggregate compiles correctly
- [ ] Non-dotted aggregates unchanged (regression)
- [ ] `fn('count', ref())` path unchanged (regression)
- [ ] All 3165+ adapter tests pass

## 7. Test Strategy

### Test pyramid:

| Level | Count | Focus |
|-------|-------|-------|
| Unit | 6 | Compiled SQL assertions |
| Integration | 0 | N/A (compile-only) |
| E2E | 0 | Covered by existing E2E when astix migrates |

### Test data: Use existing `astixModel` or spy adapter pattern from `dx-to-sql.test.ts`

## 8. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Dotted column in other contexts breaks | M | L | Regression guards SC-04, SC-05, SC-06 |
| Naming strategy not applied to split table name | L | L | Use `ctx.naming` in columnRef (already passed) |

## 9. Definition of Done

- [ ] Block 1 implemented
- [ ] All 6 BDD scenarios have passing tests
- [ ] All adapter tests pass
- [ ] Lint/typecheck pass
- [ ] /review clean
