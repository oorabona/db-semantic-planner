---
doc-meta:
  status: draft
  scope: adapter-pgsql
  type: specification
  created: 2026-01-29
  updated: 2026-01-29
  complexity: ENTERPRISE
  time-budget: 8-12h
  hardened-by: /adversarial (5 perspectives, 14 challenges resolved)
---

# Specification: Full Forward Adapter Phase 1

## 0. Quick Reference (ALWAYS VISIBLE)

| Item | Value |
|------|-------|
| Scope | adapter-pgsql (extends spike) |
| Complexity | ENTERPRISE |
| Time budget | 8-12h (multiple sessions) |
| Blocks | 10 |
| BDD scenarios | 24 |
| Risk level | MEDIUM |
| Prerequisite | Spike complete (201 tests passing) |

## 1. Problem Statement

adapter-kysely uses Kysely as an intermediate layer (Plan → Kysely API → SQL), adding abstraction overhead and limiting PostgreSQL-specific optimizations. We need a native PostgreSQL compiler that transforms Plan → PostgreSQL AST → SQL directly via pgsql-deparser, with ComparisonAdapter to validate equivalence before migration.

## 2. User Stories

### US-01: Native PostgreSQL Compilation
```
AS A developer using db-semantic-planner
I WANT queries compiled directly to PostgreSQL AST
SO THAT I get optimized, predictable SQL without Kysely abstraction
```
**ACCEPTANCE:** Same SQL output as adapter-kysely for all query types

### US-02: Safe Migration Path
```
AS A project maintainer
I WANT a ComparisonAdapter that validates both adapters produce equivalent SQL
SO THAT I can migrate confidently without regressions
```
**ACCEPTANCE:** ComparisonAdapter runs both adapters and asserts equivalence

### US-03: Feature Parity
```
AS a developer
I WANT all adapter-kysely features available in adapter-pgsql
SO THAT I can switch adapters without losing functionality
```
**ACCEPTANCE:** All 770 adapter-kysely tests pass via ComparisonAdapter

## 3. Business Rules

### 3.1 Invariants (always true)
- INV-01: All identifiers MUST pass `validateIdentifier()` before use in AST
- INV-02: Parameter indices MUST be sequential starting from $1
- INV-03: Empty `IN ()` clause MUST compile to `FALSE`
- INV-04: `json_agg()` results MUST use `COALESCE(..., '[]'::json)` for empty arrays
- INV-05: Recursive CTE MUST have `maxDepth` (default: 100)

### 3.2 Preconditions (required before action)
- PRE-01: `ModelIR` must be provided for compilation
- PRE-02: Schema name (if provided) must be valid identifier
- PRE-03: NamingPlugin must be configured (default: identity)

### 3.3 Effects (what changes)
- EFF-01: `compile()` produces `{ sql: string, parameters: unknown[], ast: Node }`
- EFF-02: ComparisonAdapter logs diff on mismatch (dev mode only)
- EFF-03: Handler registry is immutable after initialization

### 3.4 Error Handling
- ERR-01: Invalid identifier → `InvalidIdentifierError` with offending value
- ERR-02: Unsupported decision type → `UnsupportedDecisionError` with type name
- ERR-03: SQL mismatch in ComparisonAdapter → `SqlMismatchError` with both SQLs
- ERR-04: Recursive depth exceeded → `MaxRecursiveDepthError`

## 4. Technical Design

### 4.1 Architecture Decision

**Pattern:** Handler Registry (like adapter-kysely)

```
packages/adapter-pgsql/src/
├── index.ts                 # Public exports
├── compiler.ts              # PlanCompiler (extended from spike)
├── comparison-adapter.ts    # ComparisonAdapter for validation
├── validate.ts              # validateIdentifier(), security checks
├── handlers/
│   ├── index.ts             # Registry + types
│   ├── where/
│   │   ├── comparison.ts    # eq, neq, gt, gte, lt, lte
│   │   ├── like.ts          # like, ilike
│   │   ├── in.ts            # in, notIn
│   │   ├── null.ts          # isNull, isNotNull
│   │   ├── range.ts         # between, PostgreSQL range ops
│   │   ├── logical.ts       # and, or, not
│   │   ├── exists.ts        # exists, notExists
│   │   └── subquery.ts      # subquery conditions
│   ├── expression/
│   │   ├── column.ts        # column, columnAlias
│   │   ├── aggregate.ts     # count, sum, avg, min, max
│   │   ├── case.ts          # CASE WHEN
│   │   ├── coalesce.ts      # COALESCE
│   │   ├── window.ts        # ROW_NUMBER, RANK, etc.
│   │   ├── relation.ts      # relation.* columns
│   │   ├── pseudo.ts        # hierarchy pseudo-columns
│   │   └── raw.ts           # raw SQL escape hatch
│   └── include/
│       ├── join.ts          # standard JOIN
│       ├── lateral.ts       # LATERAL subquery
│       ├── json-agg.ts      # json_agg aggregation
│       └── cte.ts           # CTE-based includes
├── recursive/
│   └── cte-compiler.ts      # WITH RECURSIVE compilation
├── mutations/
│   └── mutation-compiler.ts # INSERT, UPDATE, DELETE, UPSERT
├── streaming/
│   └── cursor.ts            # Cursor-based streaming
└── explain/
    └── explain.ts           # EXPLAIN support
```

**WHY this pattern:**
- Matches adapter-kysely structure for easy comparison
- Each handler is independently testable
- Easy to add new handlers without touching core
- Clear separation of concerns

### 4.2 Data Model Changes

| Entity | Change | Migration needed |
|--------|--------|------------------|
| None | No DB changes | No |

### 4.3 ComparisonAdapter Contract

```typescript
interface ComparisonAdapter {
  // Wraps both adapters, compares output
  compile(plan: PlanReport, options?: CompileOptions): CompiledResult;

  // Comparison mode control
  readonly comparisonEnabled: boolean;

  // Get underlying adapters
  readonly kyselyAdapter: KyselyAdapter;
  readonly pgsqlAdapter: PgsqlAdapter;
}

// Environment variable
// DBSP_COMPARISON_MODE=on|off (default: off in prod, on in test)
```

## 5. Acceptance Criteria (BDD)

### Scenario Group: WHERE Handlers

```gherkin
@priority:high @type:nominal
Scenario: SC-01 Simple equality comparison
  Given a plan with WHERE "status = 'active'"
  When compiled by adapter-pgsql
  Then SQL contains "status" = $1
  And parameters contain ['active']

@priority:high @type:nominal
Scenario: SC-02 Multiple AND conditions
  Given a plan with WHERE "active = true AND role = 'admin'"
  When compiled
  Then SQL contains ("active" = $1 AND "role" = $2)

@priority:high @type:edge
Scenario: SC-03 Empty IN clause
  Given a plan with WHERE "id IN []"
  When compiled
  Then SQL contains FALSE
  And no parameters added

@priority:high @type:nominal
Scenario: SC-04 LIKE with pattern
  Given a plan with WHERE "name LIKE '%john%'"
  When compiled
  Then SQL contains "name" LIKE $1
  And parameters contain ['%john%']

@priority:medium @type:nominal
Scenario: SC-05 IS NULL / IS NOT NULL
  Given a plan with WHERE "deleted_at IS NULL"
  When compiled
  Then SQL contains "deleted_at" IS NULL

@priority:medium @type:nominal
Scenario: SC-06 EXISTS subquery
  Given a plan with EXISTS on relation "posts"
  When compiled
  Then SQL contains EXISTS (SELECT 1 FROM "posts" ...)

@priority:medium @type:nominal
Scenario: SC-07 Range operators
  Given a plan with WHERE "age BETWEEN 18 AND 65"
  When compiled
  Then SQL contains "age" >= $1 AND "age" <= $2
```

### Scenario Group: EXPRESSION Handlers

```gherkin
@priority:high @type:nominal
Scenario: SC-08 Aggregate COUNT(*)
  Given a plan with SELECT COUNT(*)
  When compiled
  Then SQL contains count(*)

@priority:high @type:nominal
Scenario: SC-09 Aggregate with alias
  Given a plan with SELECT COUNT(*) AS total
  When compiled
  Then SQL contains count(*) AS "total"

@priority:medium @type:nominal
Scenario: SC-10 CASE WHEN expression
  Given a plan with CASE WHEN status='active' THEN 1 ELSE 0
  When compiled
  Then SQL contains CASE WHEN ... THEN ... ELSE ... END

@priority:medium @type:nominal
Scenario: SC-11 Window function ROW_NUMBER
  Given a plan with ROW_NUMBER() OVER (PARTITION BY category ORDER BY date)
  When compiled
  Then SQL contains row_number() OVER (PARTITION BY ... ORDER BY ...)

@priority:medium @type:nominal
Scenario: SC-12 COALESCE expression
  Given a plan with COALESCE(name, 'Unknown')
  When compiled
  Then SQL contains COALESCE("name", $1)
```

### Scenario Group: INCLUDE Strategies

```gherkin
@priority:high @type:nominal
Scenario: SC-13 json_agg include strategy
  Given a plan with include "posts" using json_agg
  When compiled
  Then SQL contains json_agg(...)
  And result wrapped in COALESCE(..., '[]'::json)

@priority:high @type:nominal
Scenario: SC-14 JOIN include strategy
  Given a plan with include "author" using join
  When compiled
  Then SQL contains LEFT JOIN "authors" ON ...

@priority:medium @type:nominal
Scenario: SC-15 LATERAL include strategy
  Given a plan with include using lateral subquery
  When compiled
  Then SQL contains LATERAL (SELECT ...)

@priority:medium @type:nominal
Scenario: SC-16 CTE include strategy
  Given a plan with include using CTE
  When compiled
  Then SQL contains WITH "relation_cte" AS (...)
```

### Scenario Group: Recursive CTE

```gherkin
@priority:high @type:nominal
Scenario: SC-17 Recursive CTE with depth limit
  Given a recursive plan for hierarchy traversal
  When compiled without explicit maxDepth
  Then SQL contains WITH RECURSIVE
  And depth limit clause with default 100

@priority:high @type:edge
Scenario: SC-18 Recursive CTE cycle detection
  Given a recursive plan with potential cycles
  When compiled
  Then SQL contains CYCLE detection clause (PG14+)

@priority:medium @type:nominal
Scenario: SC-19 Recursive CTE path tracking
  Given a recursive plan with path column
  When compiled
  Then SQL contains array path accumulation
```

### Scenario Group: Mutations

```gherkin
@priority:high @type:nominal
Scenario: SC-20 INSERT with RETURNING
  Given an insert plan for users table
  When compiled
  Then SQL contains INSERT INTO "users" (...) VALUES (...) RETURNING *

@priority:high @type:nominal
Scenario: SC-21 UPDATE with WHERE
  Given an update plan with WHERE id = 1
  When compiled
  Then SQL contains UPDATE "users" SET ... WHERE "id" = $1

@priority:high @type:nominal
Scenario: SC-22 DELETE with RETURNING
  Given a delete plan with RETURNING
  When compiled
  Then SQL contains DELETE FROM "users" WHERE ... RETURNING *

@priority:medium @type:nominal
Scenario: SC-23 UPSERT (ON CONFLICT)
  Given an upsert plan with conflict on email
  When compiled
  Then SQL contains ON CONFLICT ("email") DO UPDATE SET ...
```

### Scenario Group: ComparisonAdapter

```gherkin
@priority:critical @type:nominal
Scenario: SC-24 SQL equivalence validation
  Given the same PlanReport
  When compiled by both adapter-kysely and adapter-pgsql
  Then SQLs are semantically equivalent (AST comparison)
  And parameters match in order and value
```

**Coverage matrix:**

| Scenario | Nominal | Edge | Error | Security |
|----------|---------|------|-------|----------|
| SC-01 | ✓ | | | |
| SC-02 | ✓ | | | |
| SC-03 | | ✓ | | |
| SC-04 | ✓ | | | |
| SC-05 | ✓ | | | |
| SC-06 | ✓ | | | |
| SC-07 | ✓ | | | |
| SC-08 | ✓ | | | |
| SC-09 | ✓ | | | |
| SC-10 | ✓ | | | |
| SC-11 | ✓ | | | |
| SC-12 | ✓ | | | |
| SC-13 | ✓ | | | |
| SC-14 | ✓ | | | |
| SC-15 | ✓ | | | |
| SC-16 | ✓ | | | |
| SC-17 | ✓ | | | |
| SC-18 | | ✓ | | |
| SC-19 | ✓ | | | |
| SC-20 | ✓ | | | |
| SC-21 | ✓ | | | |
| SC-22 | ✓ | | | |
| SC-23 | ✓ | | | |
| SC-24 | ✓ | | | ✓ |

## 6. Implementation Plan

### Block 1: Handler Infrastructure — 1h
**Type:** Infra
**Dependencies:** None (spike complete)
**Files:**
- `src/handlers/index.ts` — Handler registry + types
- `src/handlers/types.ts` — WhereHandler, ExpressionHandler, IncludeHandler interfaces
- `src/validate.ts` — validateIdentifier() function

**Exit criteria:**
- [ ] Handler registry pattern implemented
- [ ] validateIdentifier() rejects SQL keywords and special chars
- [ ] Types exported from package

---

### Block 2: WHERE Handlers (Simple) — 1.5h
**Type:** Feature slice
**Dependencies:** Block 1
**Files:**
- `src/handlers/where/comparison.ts` — eq, neq, gt, gte, lt, lte
- `src/handlers/where/like.ts` — like, ilike
- `src/handlers/where/in.ts` — in, notIn (with empty array → FALSE)
- `src/handlers/where/null.ts` — isNull, isNotNull
- `src/handlers/where/range.ts` — between, range operators
- `src/handlers/where/logical.ts` — and, or, not

**Exit criteria:**
- [ ] All simple WHERE operators compile correctly
- [ ] Empty IN() produces FALSE
- [ ] Unit tests for each handler
- [ ] SC-01 through SC-07 passing

---

### Block 3: WHERE Handlers (Complex) — 1h
**Type:** Feature slice
**Dependencies:** Block 2
**Files:**
- `src/handlers/where/exists.ts` — exists, notExists
- `src/handlers/where/subquery.ts` — subquery conditions
- `src/handlers/where/relation-filter.ts` — relation-based filters

**Exit criteria:**
- [ ] EXISTS subqueries compile correctly
- [ ] Nested subqueries work
- [ ] Relation filters produce correct JOINs

---

### Block 4: EXPRESSION Handlers — 1.5h
**Type:** Feature slice
**Dependencies:** Block 1
**Files:**
- `src/handlers/expression/column.ts` — column, columnAlias
- `src/handlers/expression/aggregate.ts` — count, sum, avg, min, max
- `src/handlers/expression/case.ts` — CASE WHEN
- `src/handlers/expression/coalesce.ts` — COALESCE
- `src/handlers/expression/window.ts` — ROW_NUMBER, RANK, DENSE_RANK, LEAD, LAG
- `src/handlers/expression/raw.ts` — raw SQL escape hatch (marked dangerous)

**Exit criteria:**
- [ ] All aggregate functions compile
- [ ] Window functions with OVER clause work
- [ ] CASE WHEN produces correct AST
- [ ] SC-08 through SC-12 passing

---

### Block 5: INCLUDE Strategies — 2h
**Type:** Feature slice
**Dependencies:** Block 2, Block 4
**Files:**
- `src/handlers/include/join.ts` — standard JOIN strategy
- `src/handlers/include/lateral.ts` — LATERAL subquery
- `src/handlers/include/json-agg.ts` — json_agg with COALESCE for empty
- `src/handlers/include/cte.ts` — CTE-based includes

**Exit criteria:**
- [ ] All 4 include strategies compile correctly
- [ ] json_agg wrapped in COALESCE(..., '[]'::json)
- [ ] LATERAL produces correct PostgreSQL syntax
- [ ] SC-13 through SC-16 passing

---

### Block 6: Pseudo-Columns + Relation Columns — 1h
**Type:** Feature slice
**Dependencies:** Block 5
**Files:**
- `src/handlers/expression/pseudo.ts` — hierarchy pseudo-columns
- `src/handlers/expression/relation.ts` — relation.* column expansion

**Exit criteria:**
- [ ] Pseudo-columns compile to scalar subqueries
- [ ] relation.* expands to correct column list
- [ ] Integration with include strategies

---

### Block 7: Recursive CTE Compiler — 1.5h
**Type:** Feature slice
**Dependencies:** Block 3, Block 6
**Files:**
- `src/recursive/cte-compiler.ts` — WITH RECURSIVE compilation
- `src/recursive/path-tracking.ts` — Path array building
- `src/recursive/cycle-detection.ts` — CYCLE clause (PG14+)

**Exit criteria:**
- [ ] Basic recursive CTE compiles
- [ ] maxDepth enforced (default: 100)
- [ ] Path tracking works
- [ ] Cycle detection for PG14+
- [ ] SC-17 through SC-19 passing

---

### Block 8: Mutation Compiler — 1h
**Type:** Feature slice
**Dependencies:** Block 1, Block 2
**Files:**
- `src/mutations/mutation-compiler.ts` — INSERT, UPDATE, DELETE
- `src/mutations/upsert.ts` — ON CONFLICT handling

**Exit criteria:**
- [ ] INSERT with RETURNING compiles
- [ ] UPDATE with WHERE compiles
- [ ] DELETE with RETURNING compiles
- [ ] UPSERT with ON CONFLICT compiles
- [ ] SC-20 through SC-23 passing

---

### Block 9: Streaming + EXPLAIN — 0.5h
**Type:** Feature slice
**Dependencies:** Block 1
**Files:**
- `src/streaming/cursor.ts` — Cursor-based streaming
- `src/explain/explain.ts` — EXPLAIN with options

**Exit criteria:**
- [ ] Streaming iterator produces rows
- [ ] EXPLAIN with ANALYZE option works
- [ ] Format options (text, json) work

---

### Block 10: ComparisonAdapter + Integration — 1h
**Type:** Integration
**Dependencies:** All previous blocks
**Files:**
- `src/comparison-adapter.ts` — Runs both adapters, compares output
- `src/__tests__/comparison.test.ts` — Integration tests

**Exit criteria:**
- [ ] ComparisonAdapter wraps both adapters
- [ ] DBSP_COMPARISON_MODE env var respected
- [ ] SQL diff logged on mismatch
- [ ] SC-24 passing
- [ ] All 770 adapter-kysely tests pass via comparison

---

## 7. Test Strategy

### Test pyramid:

| Level | Count | Focus |
|-------|-------|-------|
| Unit | ~200 | Handler logic, AST generation |
| Integration | ~50 | Cross-handler compilation |
| E2E | ~24 | Full query execution via ComparisonAdapter |

### Test data requirements:
- **Fixtures:** Reuse adapter-kysely test fixtures where possible
- **Shared:** Create `packages/adapter-pgsql/src/__tests__/fixtures/` mirroring adapter-kysely
- **Mocks:** Mock Kysely instance for ComparisonAdapter unit tests

### Validation approach:
1. Each block adds unit tests for its handlers
2. ComparisonAdapter runs ALL adapter-kysely tests
3. E2E tests validate actual PostgreSQL execution

## 8. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| pgsql-deparser edge cases | H | M | Golden SQL tests, roundtrip validation |
| AST type mismatches | M | M | TypeScript strict mode, runtime validation |
| Performance regression | M | L | Benchmark before/after, profile hot paths |
| Subtle SQL differences | H | M | ComparisonAdapter catches before prod |
| Large scope creep | H | M | Strict block boundaries, defer to Phase 2 |

## 9. Definition of Done

- [ ] All 10 blocks implemented
- [ ] All 24 BDD scenarios have passing tests
- [ ] All adapter-pgsql tests pass (target: 400+ unit tests)
- [ ] All adapter-kysely tests pass via ComparisonAdapter
- [ ] Lint/typecheck pass
- [ ] ARCHITECTURE.md created
- [ ] TODO.md updated
- [ ] /review clean (no blocking findings)

## 10. Out of Scope (Phase 2+)

- Introspection (pg_catalog → ModelIR)
- DDL generation
- Multi-dialect support (PostgreSQL only)
- AST object pooling (premature optimization)
- Async deparse (no measured need)
