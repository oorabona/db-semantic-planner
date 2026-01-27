---
doc-meta:
  status: draft
  scope: nql, core, adapter-kysely
  type: specification
  created: 2026-01-27
  updated: 2026-01-27
  complexity: COMPLEX
  time-budget: 9h
---

# Specification: NQL-ALIGN — Spec/Implementation Alignment

## 0. Quick Reference

| Item | Value |
|------|-------|
| Story ID | NQL-ALIGN |
| Scope | nql, core, adapter-kysely |
| Complexity | COMPLEX |
| Time budget | ~9h |
| Blocks | 6 |
| BDD scenarios | 24 |
| Risk level | MEDIUM |

## 1. Problem Statement

Multiple gaps exist between NQL specification and implementation:
1. **CASE expressions** — Defined in EBNF but not implemented
2. **Global options** — No centralized limits for recursion/depth
3. **INSERT FROM** — Subquery-based insert not implemented
4. **SEPARATE strategy** — Uses 2-query pattern instead of subquery
5. **Performance warnings** — No guidance for suboptimal query patterns

## 2. User Stories

### US-01: Conditional Logic
```
AS A developer writing NQL queries
I WANT to use CASE expressions
SO THAT I can transform values based on conditions without raw SQL
```

### US-02: Safe Defaults
```
AS A developer configuring the ORM
I WANT to set global limits (maxDepth, maxTableHops, maxNestedCase)
SO THAT queries have safe defaults without per-query configuration
```

### US-03: Bulk Insert from Query
```
AS A developer archiving or copying data
I WANT to INSERT FROM a subquery
SO THAT I can efficiently copy/transform data in a single statement
```

### US-04: Efficient Relation Loading
```
AS a developer using SEPARATE strategy
I WANT relation loading to use subqueries instead of 2 queries
SO THAT performance is optimal with fewer round-trips
```

### US-05: Performance Guidance
```
AS A developer writing queries
I WANT warnings when my query pattern is suboptimal
SO THAT I can improve performance before production
```

## 3. Business Rules

### 3.1 CASE Expression
- **INV-01:** CASE MUST have at least one WHEN clause
- **INV-02:** CASE MUST end with END keyword
- **INV-03:** CASE without ELSE returns NULL for non-matching rows
- **ERR-01:** Nested CASE depth > options.maxNestedCase → Compile error

### 3.2 Global Options
- **INV-04:** Options have sensible defaults if not provided
- **INV-05:** Per-query options override global options
- **DEF-01:** Default maxDepth = 10
- **DEF-02:** Default maxTableHops = 5
- **DEF-03:** Default maxNestedCase = 10

### 3.3 INSERT FROM
- **INV-06:** Source query MUST be a valid QueryIntent
- **INV-07:** Column count MUST match between target and source
- **ERR-02:** Column mismatch → Compile error with helpful message

### 3.4 SEPARATE Optimization
- **INV-08:** SEPARATE strategy SHOULD use subquery when possible
- **INV-09:** Fallback to 2-query pattern if subquery not supported

### 3.5 Performance Warnings
- **WARN-01:** WHERE on non-GROUP-BY column after GROUP BY
- **WARN-02:** Include without limit on large relations (if detectable)

## 4. Technical Design

### 4.1 CASE Expression

**Tokens (+5):**
```typescript
// packages/nql/src/lexer/tokens.ts
Case, When, Then, Else, End
```

**AST:**
```typescript
// packages/nql/src/parser/ast.ts
interface NqlCaseExpression {
  kind: 'case';
  whenClauses: Array<{ condition: NqlExpression; result: NqlExpression }>;
  elseClause?: NqlExpression;
  alias?: string;
}
```

**Intent:**
```typescript
// packages/core/src/intent/expressions.ts
interface CaseExpressionIntent {
  kind: 'case';
  when: Array<{ condition: ExpressionIntent; result: ExpressionIntent }>;
  else?: ExpressionIntent;
  as?: string;
}
```

### 4.2 Global Options

**API Change:**
```typescript
// packages/core/src/dx/orm.ts
interface OrmOptions {
  maxDepth?: number;        // Default: 10 — recursive CTE depth
  maxTableHops?: number;    // Default: 5 — relation path length
  maxNestedCase?: number;   // Default: 10 — CASE nesting depth
}

interface SimplifiedOrmOptions<T> {
  schema?: Schema<T>;
  model?: ModelIR;
  adapter?: Adapter;
  options?: OrmOptions;     // NEW
  strictMode?: boolean;
  dialectCapabilities?: DialectCapabilities;
}
```

**Propagation:** Options stored in OrmInstance, passed to compiler context.

### 4.3 INSERT FROM

**NQL Syntax:**
```nql
insert into archiveOrders from (orders | where date < '2024-01-01')
insert into archiveOrders (id, total) from (orders | select id, total | where archived = false)
```

**AST:**
```typescript
// packages/nql/src/parser/ast.ts
interface NqlInsertFromStatement {
  kind: 'insertFrom';
  into: string;
  columns?: string[];
  source: NqlQuery;
}
```

**Intent:**
```typescript
// packages/core/src/intent/mutations.ts
interface InsertFromIntent {
  kind: 'insertFrom';
  into: string;
  columns?: string[];
  source: QueryIntent;
}
```

**SQL Output:**
```sql
INSERT INTO archive_orders (id, total)
SELECT id, total FROM orders WHERE date < '2024-01-01'
```

### 4.4 SEPARATE Strategy Optimization

**Current (2 queries):**
```typescript
// Query 1
const users = await db.selectFrom('users').where('active', '=', true).execute();
const ids = users.map(u => u.id);

// Query 2
const posts = await db.selectFrom('posts').where('userId', 'in', ids).execute();
```

**Optimized (1 subquery):**
```typescript
// Single query with subquery
const posts = await db
  .selectFrom('posts')
  .where('userId', 'in',
    db.selectFrom('users').select('id').where('active', '=', true)
  )
  .execute();
```

**Implementation:** Modify `compileSeparateInclude()` in adapter-kysely to use Kysely's subquery builder instead of collecting IDs.

### 4.5 Performance Warnings

**Warning in PlanReport:**
```typescript
// packages/core/src/planner.ts
interface PlanWarning {
  code: 'PERF_WHERE_AFTER_GROUP' | 'PERF_UNBOUNDED_INCLUDE';
  message: string;
  suggestion: string;
  location?: { clause: string; position: number };
}

interface PlanReport {
  // ... existing fields
  warnings?: PlanWarning[];
}
```

**Example warning:**
```
⚠️ PERF_WHERE_AFTER_GROUP: WHERE 'status = done' appears after GROUP BY.
   This filters post-aggregation (less efficient).
   Suggestion: Move 'where status = done' before 'group by' if filtering individual rows.
```

## 5. Acceptance Criteria (BDD)

### CASE Expression (6 scenarios)

```gherkin
@priority:high @type:nominal
Scenario: Simple CASE expression
  Given NQL "products | select case when price > 100 then 'high' else 'low' end as tier"
  When compiled
  Then SQL contains "CASE WHEN ... THEN ... ELSE ... END AS"

@priority:high @type:nominal
Scenario: CASE with multiple WHEN
  Given NQL with 3 WHEN clauses
  When compiled
  Then SQL contains 3 WHEN clauses

@priority:high @type:edge
Scenario: CASE without ELSE
  Given NQL "select case when x then y end"
  When compiled
  Then SQL CASE has no ELSE (implicit NULL)

@priority:high @type:error
Scenario: CASE without WHEN fails
  Given NQL "select case else 'x' end"
  When parsed
  Then error contains "CASE requires at least one WHEN"

@priority:medium @type:error
Scenario: CASE nesting exceeds limit
  Given NQL with CASE nested 11 levels
  And options.maxNestedCase = 10
  When compiled
  Then error contains "nesting limit exceeded"

@priority:high @type:integration
Scenario: CASE uses table alias
  Given NQL with CASE referencing columns
  When compiled with tableAlias
  Then SQL uses qualified column references
```

### Global Options (4 scenarios)

```gherkin
@priority:high @type:nominal
Scenario: Options passed to createOrm
  Given createOrm({ schema, options: { maxDepth: 5 } })
  When recursive include exceeds depth 5
  Then error contains "maxDepth exceeded"

@priority:high @type:nominal
Scenario: Default options applied
  Given createOrm({ schema }) without options
  When checking defaults
  Then maxDepth = 10, maxTableHops = 5, maxNestedCase = 10

@priority:medium @type:nominal
Scenario: Per-query override
  Given global maxDepth = 5
  When query specifies include({ maxDepth: 10 })
  Then query uses maxDepth = 10

@priority:medium @type:edge
Scenario: Options validation
  Given createOrm({ options: { maxDepth: -1 } })
  When ORM created
  Then error contains "maxDepth must be positive"
```

### INSERT FROM (5 scenarios)

```gherkin
@priority:high @type:nominal
Scenario: Basic INSERT FROM
  Given NQL "insert into archive from (orders | where year < 2024)"
  When compiled
  Then SQL is "INSERT INTO archive SELECT * FROM orders WHERE year < 2024"

@priority:high @type:nominal
Scenario: INSERT FROM with column list
  Given NQL "insert into archive (id, total) from (orders | select id, total)"
  When compiled
  Then SQL specifies columns in INSERT and SELECT

@priority:medium @type:nominal
Scenario: INSERT FROM with transformation
  Given NQL "insert into summary from (orders | group by status | select status, count(*))"
  When compiled
  Then SQL INSERT uses aggregate SELECT

@priority:high @type:error
Scenario: INSERT FROM column mismatch
  Given target has 3 columns, source SELECT has 2
  When compiled
  Then error contains "column count mismatch"

@priority:medium @type:integration
Scenario: INSERT FROM executes correctly
  Given source query returns 10 rows
  When INSERT FROM executed on PostgreSQL
  Then 10 rows inserted into target
```

### SEPARATE Optimization (4 scenarios)

```gherkin
@priority:high @type:nominal
Scenario: SEPARATE uses subquery
  Given query with includeStrategy: 'separate'
  When compiled
  Then SQL uses "WHERE foreign_key IN (SELECT ...)"
  And only 1 query executed (not 2)

@priority:high @type:nominal
Scenario: SEPARATE subquery with WHERE
  Given users with posts, where users filtered by active = true
  When compiled with SEPARATE strategy
  Then posts query has "WHERE user_id IN (SELECT id FROM users WHERE active)"

@priority:medium @type:edge
Scenario: SEPARATE with composite keys
  Given relation with composite foreign key (a, b)
  When compiled
  Then subquery handles composite key correctly

@priority:medium @type:integration
Scenario: SEPARATE subquery performance
  Given 1000 parent rows, 10000 child rows
  When executed with SEPARATE subquery
  Then single query, no N+1
```

### Performance Warnings (3 scenarios)

```gherkin
@priority:medium @type:nominal
Scenario: Warning for WHERE after GROUP BY
  Given NQL "orders | group by status | where status = 'done'"
  When planned
  Then PlanReport.warnings contains PERF_WHERE_AFTER_GROUP
  And suggestion mentions "move before group by"

@priority:medium @type:nominal
Scenario: No warning for aggregate in WHERE after GROUP BY
  Given NQL "orders | group by status | where count(*) > 10"
  When planned
  Then no PERF_WHERE_AFTER_GROUP warning (aggregate is valid)

@priority:low @type:nominal
Scenario: Warning visible in dump()
  Given query with performance warning
  When dump() called
  Then warnings displayed in output
```

### Documentation (2 scenarios)

```gherkin
@priority:high @type:docs
Scenario: NQL-DIVERGENCES.md exists
  Given the divergences document
  Then it lists all deferred features with reasons

@priority:medium @type:docs
Scenario: Options documented
  Given README or API docs
  Then OrmOptions interface is documented with defaults
```

## 6. Implementation Plan

### Block 1: CASE Expression — Lexer + AST (~1h)
**Dependencies:** None
**Files:**
- `packages/nql/src/lexer/tokens.ts` — +5 tokens
- `packages/nql/src/parser/ast.ts` — +NqlCaseExpression
- `packages/nql/tests/lexer.test.ts` — +6 tests

**Exit criteria:** Tokens recognized, AST type defined

### Block 2: CASE Expression — Parser + Compiler (~2h)
**Dependencies:** Block 1
**Files:**
- `packages/nql/src/parser/grammar.ts` — +caseExpression rule
- `packages/nql/src/semantic/visitor.ts` — +visitCaseExpression
- `packages/nql/src/compiler/index.ts` — +case compilation
- `packages/core/src/intent/expressions.ts` — +CaseExpressionIntent
- `packages/adapter-kysely/src/compiler/handlers/expression/case.ts` — +handler
- `packages/nql/tests/parser.test.ts` — +6 tests
- `packages/nql/tests/compiler.test.ts` — +6 tests

**Exit criteria:** Full CASE pipeline working

### Block 3: Global Options (~1.5h)
**Dependencies:** None (parallel with Block 1-2)
**Files:**
- `packages/core/src/dx/orm.ts` — +OrmOptions interface, update createOrm
- `packages/core/src/dx/context.ts` — Options propagation (if needed)
- `packages/adapter-kysely/src/compiler.ts` — Read options from context
- `packages/core/tests/dx/orm.test.ts` — +4 tests
- `packages/adapter-kysely/src/compiler.test.ts` — +2 tests

**Exit criteria:** Options accepted and enforced

### Block 4: INSERT FROM (~2h)
**Dependencies:** None (parallel)
**Files:**
- `packages/nql/src/lexer/tokens.ts` — +From token (if not exists)
- `packages/nql/src/parser/ast.ts` — +NqlInsertFromStatement
- `packages/nql/src/parser/grammar.ts` — +insertFromStatement rule
- `packages/nql/src/compiler/index.ts` — +insertFrom compilation
- `packages/core/src/intent/mutations.ts` — +InsertFromIntent
- `packages/adapter-kysely/src/compiler.ts` — +compileInsertFrom
- `packages/nql/tests/compiler.test.ts` — +5 tests

**Exit criteria:** INSERT FROM compiles and executes

### Block 5: SEPARATE Optimization (~1.5h)
**Dependencies:** Subquery infrastructure (already exists)
**Files:**
- `packages/adapter-kysely/src/compiler.ts` — Modify compileSeparateInclude
- `packages/adapter-kysely/src/compiler.test.ts` — +4 tests (update existing)

**Exit criteria:** SEPARATE uses subquery, 1 query instead of 2

### Block 6: Warnings + Documentation (~1h)
**Dependencies:** Blocks 1-5
**Files:**
- `packages/core/src/planner.ts` — +PlanWarning type, warning detection
- `packages/core/src/types/plan.ts` — +warnings field
- `docs/specs/NQL-DIVERGENCES.md` — Create
- `TODO_NQL.md` — Update

**Exit criteria:** Warnings in plan, divergences documented

## 7. Test Strategy

| Level | Count | Focus |
|-------|-------|-------|
| Unit (lexer) | 6 | CASE tokens |
| Unit (parser) | 10 | CASE + INSERT FROM parsing |
| Unit (compiler) | 15 | Intent generation |
| Unit (options) | 6 | Defaults, validation, override |
| Integration | 8 | Full pipelines |
| E2E | 3 | PostgreSQL execution |

**Total: ~48 new tests**

## 8. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| CASE token conflicts | M | L | Use longer_alt pattern |
| SEPARATE subquery breaks edge cases | M | M | Keep fallback to 2-query |
| Options not propagated correctly | M | L | Integration tests |
| INSERT FROM column inference | L | M | Require explicit columns initially |

## 9. Definition of Done

- [ ] All 6 blocks implemented
- [ ] All 24 BDD scenarios have tests
- [ ] All tests pass (existing + new)
- [ ] Lint/typecheck pass
- [ ] NQL-DIVERGENCES.md created
- [ ] TODO_NQL.md updated
- [ ] /review clean

## Appendix: Deferred Features

| Feature | Reason | Workaround |
|---------|--------|------------|
| Scoped traversal `[N]` | Complex CTE modification | Use maxDepth option |
| HAVING keyword | Position-based WHERE works | WHERE after GROUP BY |
| count(distinct col) | Parser limitation | `select distinct col \| select count(*)` |
