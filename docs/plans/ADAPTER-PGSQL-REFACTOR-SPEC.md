# ADAPTER-PGSQL-REFACTOR — Specification

**Story ID:** ADAPTER-PGSQL-REFACTOR
**Created:** 2026-01-30
**Status:** Approved
**Hardened:** Yes (adversarial 5/5 + multi-LLM consensus Codex/Gemini)

---

## Summary

Four backlog items for adapter-pgsql discovered during Phase 3:

| ID | Type | Title |
|----|------|-------|
| F-003 | Feature (CLI + E2E) | Row-level result assertions (`db.output` table) |
| F-004 | Refactor | `getTable()` naming resolution utility |
| F-005 | Feature | JOIN compilation for filter-strategy |
| F-006 | Feature | LEFT JOIN compilation for include-strategy |

---

## F-003: Row-Level Result Assertions

### Problem

E2E tests use fragile `toContain('EXISTS')` string assertions on SQL. The real validation should be on **query results** — the actual rows returned by PostgreSQL.

### Solution

Two parts:

#### Part A: `db.output` Table Assertion in `.assert.dbsp`

New assertion type that compares actual DB query results row-by-row using a markdown table format:

```
--- query: 6
success: true
db.output:
| id | name          | email             |
| 1  | Alice Johnson | alice@example.com |
| 2  | Bob Smith     | bob@example.com   |
| 3  | Charlie Brown | charlie@test.com  |
```

**Semantics:**
- Header row defines expected columns (order matters for display, not matching)
- Each data row is compared against actual result rows
- Row count must match exactly (no more, no fewer)
- Column values are compared as trimmed strings
- Missing columns in actual results → assertion failure
- Extra columns in actual results → ignored (only listed columns checked)
- Rows are matched **in order** (ORDER BY in query determines order)
- NULL values represented as `NULL` (literal string)
- JSON values represented as JSON string (e.g. `[{"id":1}]`)

**Parsing Rules (GFM-inspired):**
- Lines starting with `|` are table rows
- Separator rows (`|---|---|`) are **optional** and ignored if present
- Leading/trailing pipes are required: `| val1 | val2 |`
- Pipes in values escaped as `\|`
- Whitespace around values is trimmed
- Empty cell = empty string; `NULL` (case-sensitive) = SQL NULL
- Block terminates at: next `---` header, next non-pipe assertion line, or EOF
- Blank lines within the table block are ignored (not terminators)

**Value Normalization:**
- All values compared as trimmed strings (PostgreSQL driver returns strings)
- Booleans: `true`/`false` (lowercase, as pg returns)
- Numbers: compared as-is (string comparison, `1` ≠ `1.0`)
- JSON: compared as-is (driver returns canonical JSON string)
- Timestamps: compared as-is (test queries should use explicit format)

**Multiline block rule:**
- `db.output:` (with colon, no value) starts a table block
- Existing `db.output.contains: text` remains unchanged (substring check)

#### Part B: Migrate E2E Tests

Replace fragile `toContain` SQL assertions in `tests/e2e/` with concrete result validation using `db.output` tables or `db.rows.equals` + `db.output.contains` where full table comparison is overkill.

### Acceptance Criteria (BDD)

```gherkin
Feature: db.output table assertion

  Scenario: Exact row match
    Given a query "authors" that returns 3 rows
    And an assertion block with db.output table of 3 rows
    When the assertion runner validates
    Then all 3 rows match and assertion passes

  Scenario: Row count mismatch
    Given a query returns 3 rows
    And db.output table has 2 rows
    When validated
    Then assertion fails with "Expected 2 rows, got 3"

  Scenario: Column value mismatch
    Given a query returns name="Alice"
    And db.output expects name="Bob"
    When validated
    Then assertion fails showing expected vs actual for that cell

  Scenario: NULL handling
    Given a query returns null for bio column
    And db.output expects "NULL" for bio
    When validated
    Then assertion passes

  Scenario: Column subset
    Given a query returns id, name, email, created_at
    And db.output only lists id, name
    When validated
    Then only id and name are compared, created_at ignored

  Scenario: Existing db.output.contains unchanged
    Given an assertion "db.output.contains: Alice"
    When validated
    Then it checks substring presence (existing behavior)

  Scenario: Separator row ignored
    Given a table with |---|---| between header and data
    When parsed
    Then separator row is skipped, data rows parsed normally

  Scenario: Escaped pipe in value
    Given a value containing "foo\|bar"
    When parsed
    Then cell value is "foo|bar"

  Scenario: Blank lines within table
    Given blank lines between data rows
    When parsed
    Then blank lines are ignored, all data rows collected
```

---

## F-004: getTable() Naming Resolution Utility

### Problem

`Model.getTable()` expects logical camelCase names (`postComments`) but the adapter-pgsql often works with snake_case DB names (`post_comments`). This requires manual conversion.

### Solution

Add a utility function in adapter-pgsql (NOT in core — core stays DB-agnostic):

```typescript
// packages/adapter-pgsql/src/naming.ts
export function resolveLogicalName(
  model: ModelIR,
  dbName: string,
  convention: NamingConvention
): string | undefined
```

- Converts `snake_case` DB name → `camelCase` logical name using the naming convention
- Falls back to exact match if conversion fails
- Returns `undefined` if no table found

Also: Add JSDoc to `ModelIR.getTable()` documenting that it expects logical names.

### Acceptance Criteria

```gherkin
Feature: Naming resolution utility

  Scenario: snake_case to camelCase
    Given a model with table "postComments"
    When resolveLogicalName(model, "post_comments", "camelCase")
    Then returns "postComments"

  Scenario: Already camelCase
    Given a model with table "posts"
    When resolveLogicalName(model, "posts", "camelCase")
    Then returns "posts"

  Scenario: Unknown table
    Given a model without table "fooBar"
    When resolveLogicalName(model, "foo_bar", "camelCase")
    Then returns undefined

  Scenario: No convention (identity)
    Given a model with table "post_comments"
    When resolveLogicalName(model, "post_comments", "identity")
    Then returns "post_comments"
```

---

## F-005: JOIN Compilation for Filter-Strategy

### Problem

The pgsql compiler compiles ALL filter-strategy decisions as EXISTS subqueries, even when the planner chooses `choice: 'join'` for `belongsTo` (to-one) relations. This ignores the planner's optimization decision.

### Current Behavior

```sql
-- Planner says choice: 'join' for belongsTo, but compiler generates:
SELECT posts.* FROM posts
WHERE EXISTS (SELECT 1 FROM authors WHERE authors.id = posts.author_id AND authors.name = 'Alice')
```

### Target Behavior

```sql
-- When choice: 'join' for belongsTo:
SELECT posts.* FROM posts
JOIN authors ON authors.id = posts.author_id
WHERE authors.name = 'Alice'
```

### Constraints (from adversarial + LLM review)

- **Only `belongsTo` (to-one):** JOIN for hasMany would cause row explosion
- **FK composite support:** Handle `foreignKey: string | string[]` with paired `references` array
- **Self-referential:** Use table aliases to avoid ambiguity
- **Nested filters:** If a JOIN target also has sub-filters, nest them in WHERE
- **Fallback:** If `choice !== 'join'`, keep existing EXISTS behavior
- **AND-only guard:** The planner MUST only emit `choice: 'join'` when the relation filter is in a pure AND context. OR/NOT around a relation filter requires EXISTS (JOIN changes semantics). This is a **planner constraint**, not a compiler constraint — verify it holds.
- **FK uniqueness invariant:** `belongsTo` → FK references PK (unique by definition). No DISTINCT needed.

### Architecture: Join Registry Pattern (from LLM review)

`compileCondition()` cannot modify the FROM clause. Solution:

1. Add `pendingJoins: JoinClause[]` to compilation context
2. `compileCondition()` registers JOIN in context, returns the WHERE boolean expression
3. `compileSelect()` flushes `pendingJoins` into the FROM/JOIN list after building base SELECT

```typescript
interface JoinClause {
  type: 'JOIN' | 'LEFT JOIN';
  table: string;
  alias: string;
  on: BoolExpr;  // ON condition as AST node
}
```

### Acceptance Criteria

```gherkin
Feature: JOIN compilation for filter-strategy

  Scenario: belongsTo filter with choice=join
    Given a filter on posts WHERE author.name = 'Alice'
    And planner emits choice: 'join' for the author relation
    When compiled by adapter-pgsql
    Then SQL contains "JOIN authors ON authors.id = posts.author_id"
    And SQL contains "WHERE authors.name = $1"

  Scenario: hasMany filter stays EXISTS
    Given a filter on authors WHERE posts.published = true
    And planner emits choice: 'exists' (hasMany)
    When compiled
    Then SQL contains "EXISTS (SELECT 1 FROM posts"

  Scenario: belongsTo with composite FK
    Given a relation with foreignKey: ['org_id', 'dept_id'] referencing ['org_id', 'dept_id']
    When compiled with choice: 'join'
    Then SQL contains "JOIN target ON target.org_id = source.org_id AND target.dept_id = source.dept_id"

  Scenario: Self-referential relation
    Given categories with parent_id self-reference
    And planner emits choice: 'join'
    When compiled
    Then SQL uses alias to avoid ambiguity

  Scenario: Fallback to EXISTS when choice != 'join'
    Given a filter with choice: 'exists'
    When compiled
    Then SQL contains "EXISTS (SELECT 1 FROM" (unchanged behavior)

  Scenario: Multiple JOINs from different filters
    Given filters on posts WHERE author.name = 'Alice' AND category.slug = 'tech'
    And both relations emit choice: 'join'
    When compiled
    Then SQL contains two JOIN clauses, one for authors and one for categories
```

---

## F-006: LEFT JOIN Compilation for Include-Strategy

### Problem

The pgsql compiler always uses `json_agg` correlated subqueries for includes, even when the planner chooses `choice: 'join'` for to-one relations. For `belongsTo` or `hasOne`, LEFT JOIN is more efficient.

### Current Behavior

```sql
-- Planner says choice: 'join' for belongsTo include, but compiler generates:
SELECT posts.*,
  COALESCE((SELECT json_agg(json_build_object('id', __t__.id, 'name', __t__.name))
    FROM authors AS __t__ WHERE __t__.id = posts.author_id), '[]'::json) AS author_json
FROM posts
```

### Target Behavior

```sql
-- When choice: 'join' for belongsTo include:
SELECT posts.*,
  authors.id AS "author.id",
  authors.name AS "author.name"
FROM posts
LEFT JOIN authors ON authors.id = posts.author_id
```

### Constraints (from adversarial + LLM review)

- **Only to-one relations:** `belongsTo` and `hasOne`. hasMany stays json_agg (row explosion)
- **Column selection:** Respect the `columns` list from the include decision
- **Column aliasing:** Use `relation.column` format for included columns (e.g. `author.id`)
- **NULL handling:** LEFT JOIN naturally returns NULL for missing relations — correct
- **PK mandatory:** Always include the relation's PK in selected columns (even if not explicitly requested). This disambiguates "relation missing" (PK=NULL) from "relation exists, column=NULL".
- **Result hydration:** Core's `hydrateJoinIncludes` already expects `relation.column` format — confirmed compatible.
- **Fallback:** If `choice !== 'join'`, keep existing json_agg behavior
- **Alias uniqueness:** Multiple LEFT JOINs to same table (e.g. `author` + `editor` both from `users`) use relation-name-based aliases
- **Reuses Join Registry:** Uses same `pendingJoins` mechanism as F-005

### Acceptance Criteria

```gherkin
Feature: LEFT JOIN compilation for include-strategy

  Scenario: belongsTo include with choice=join
    Given posts include author (belongsTo)
    And planner emits include-strategy choice: 'join'
    When compiled
    Then SQL contains "LEFT JOIN authors ON authors.id = posts.author_id"
    And SQL contains 'authors.id AS "author.id"'
    And SQL does NOT contain "json_agg"

  Scenario: hasMany include stays json_agg
    Given authors include posts (hasMany)
    And planner emits include-strategy choice: 'json_agg'
    When compiled
    Then SQL contains "json_agg(json_build_object"

  Scenario: Include with specific columns
    Given posts include author with columns [name, email]
    And planner emits choice: 'join'
    When compiled
    Then SQL selects authors.id (PK always), authors.name, authors.email
    And SQL does NOT select authors.*

  Scenario: Missing relation returns NULL
    Given a post with no author (author_id = NULL)
    And include uses LEFT JOIN
    When executed
    Then author.id is NULL (signals missing relation)

  Scenario: Fallback to json_agg when choice != 'join'
    Given an include with choice: 'json_agg'
    When compiled
    Then SQL uses COALESCE + json_agg subquery (unchanged)

  Scenario: Multiple to-one includes to same table
    Given posts include author and editor (both from users table)
    When compiled with choice: 'join'
    Then SQL has two LEFT JOINs with different aliases
    And columns use "author.name" and "editor.name" respectively
```

---

## Implementation Plan

### Block 1: F-004 — Naming Utility (foundation)

**Files:**
- Create `packages/adapter-pgsql/src/naming.ts`
- Update `packages/adapter-pgsql/src/index.ts` (export)
- Add JSDoc to `packages/core/src/model-ir.ts` (getTable doc only)
- Create `packages/adapter-pgsql/src/__tests__/naming.test.ts`

**Tests:** Unit tests for resolveLogicalName()

### Block 2: F-005 — JOIN Filter Compilation

**Files:**
- `packages/adapter-pgsql/src/compiler.ts` — add Join Registry (`pendingJoins`), `compileJoinFilter()`, dispatch in `compileCondition()`, flush in `compileSelect()`
- `packages/adapter-pgsql/src/__tests__/compiler-join-filter.test.ts` — unit tests
- Verify planner AND-only guard for `choice: 'join'`

**Tests:** Unit tests for JOIN filter scenarios

### Block 3: F-006 — LEFT JOIN Include Compilation

**Files:**
- Create `packages/adapter-pgsql/src/handlers/include/left-join.ts` — LEFT JOIN handler
- `packages/adapter-pgsql/src/compiler.ts` — dispatch to LEFT JOIN handler when choice='join', reuse Join Registry
- `packages/adapter-pgsql/src/__tests__/compiler-left-join.test.ts` — unit tests
- Verify PK always included in LEFT JOIN columns

**Tests:** Unit tests for LEFT JOIN include scenarios

### Block 4: F-003 — db.output Table Assertion

**Files:**
- `packages/cli/src/repl/assertion-parser.ts` — parse `db.output:` table blocks
- `packages/cli/src/repl/assertion-runner.ts` — validate db.output table assertions
- `packages/cli/src/repl/assertion-parser.test.ts` — parser unit tests
- `packages/cli/src/repl/assertion-runner.test.ts` — runner unit tests
- Update `examples/*.assert.dbsp` — add db.output examples

**Tests:** Unit tests for parser + runner, E2E validation with real DB

### Block 5: Dead Code Cleanup + E2E Migration

**Files:**
- `packages/adapter-pgsql/src/compiler.ts` — remove dead range operator switch cases (lines 758-763)
- Migrate key E2E tests from `toContain` to result-based assertions where appropriate

**Tests:** Existing tests pass (no behavior change)

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| JOIN changes semantics under OR/NOT | Planner AND-only guard (verified, not compiler concern) |
| LEFT JOIN NULL ambiguity | PK always included — NULL PK = missing relation |
| F-006 result hydration | `hydrateJoinIncludes` already compatible (confirmed) |
| JOIN changes breaking E2E tests | Only when planner emits `choice: 'join'` — existing tests use `choice: 'exists'` |
| db.output table parsing edge cases | Comprehensive parser unit tests + GFM rules defined |
| F-005 composite FK | Explicit handling with paired foreignKey/references arrays |
| Alias collision (multi-include same table) | Relation-name-based aliases ensure uniqueness |

---

## LLM Review Amendments

Applied from Codex + Gemini consensus review (2026-01-30):

1. **F-003:** Added explicit GFM parsing rules, value normalization, separator handling, pipe escaping
2. **F-005:** Added AND-only guard constraint, Join Registry architecture pattern, multiple JOINs scenario
3. **F-006:** Added PK-mandatory rule, alias uniqueness for same-table includes, Join Registry reuse
4. **Deferred F-003 finding #5 (FK uniqueness):** Not applicable — belongsTo FK→PK is unique by definition
