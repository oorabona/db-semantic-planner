---
doc-meta:
  status: canonical
  scope: cli
  type: specification
  created: 2026-01-20
  updated: 2026-01-20
  complexity: COMPLEX
  time-budget: 4h
---

# Specification: CLI-MUT - REPL Mutation Syntax

## 0. Quick Reference (ALWAYS VISIBLE)

| Item | Value |
|------|-------|
| Scope | cli |
| Complexity | COMPLEX |
| Time budget | ~4h |
| Blocks | 5 |
| BDD scenarios | 18 |
| Risk level | MEDIUM |

## 1. Problem Statement

The REPL currently only supports SELECT queries via natural language syntax. Users need to perform INSERT, UPDATE, DELETE, and UPSERT operations through the same intuitive interface. This extends the natural query language to support all CRUD operations while maintaining safety through dry-run defaults and explicit execution confirmation.

## 2. User Stories

### US-01: Insert Data
AS A developer using the REPL
I WANT to insert records using natural language syntax
SO THAT I can quickly test data creation without writing raw SQL

ACCEPTANCE: `users insert name = "Alice", email = "a@e.com"` produces valid INSERT SQL

### US-02: Update Data
AS A developer using the REPL
I WANT to update records with WHERE clauses
SO THAT I can modify existing data safely

ACCEPTANCE: `users update set active = false where id = 1` produces valid UPDATE SQL with WHERE

### US-03: Delete Data
AS A developer using the REPL
I WANT to delete records with safety guards
SO THAT I don't accidentally delete all rows

ACCEPTANCE: Bulk delete requires confirmation, single-row delete works immediately

### US-04: Upsert Data
AS A developer using the REPL
I WANT to perform upsert operations
SO THAT I can handle insert-or-update scenarios

ACCEPTANCE: `users upsert email = "a@e.com", name = "Alice" on email do nothing` produces valid UPSERT

## 3. Business Rules

### 3.1 Invariants (always true)

- INV-01: All mutations display SQL/params in dry-run mode by default
- INV-02: Column names MUST be validated against schema (security)
- INV-03: String values MUST use bound parameters (SQL injection prevention)
- INV-04: Parser state is independent from execution state
- INV-05: `.explain` toggle persists across queries like `.alias`

### 3.2 Preconditions (required before action)

- PRE-01: Schema must be loaded for column validation
- PRE-02: Database connection required for actual execution
- PRE-03: `execMode` must be true for `!` suffix to work

### 3.3 Effects (what changes)

- EFF-01: INSERT: Creates new row(s) in target table
- EFF-02: UPDATE: Modifies existing row(s) matching WHERE
- EFF-03: DELETE: Removes row(s) matching WHERE
- EFF-04: UPSERT: Inserts or updates based on conflict key

### 3.4 Error Handling

- ERR-01: Unknown column → `Column "foo" does not exist in table "users"`
- ERR-02: Invalid operator → `Invalid operator ">>". Expected: =, !=, <, >, <=, >=, like, in`
- ERR-03: Missing WHERE on UPDATE/DELETE → Warning + confirmation required
- ERR-04: Syntax error → `Parse error at position X: expected <what>`
- ERR-05: Type mismatch → `Cannot assign string to column "age" (type: integer)`

## 4. Technical Design

### 4.1 Architecture Decision

Extend existing parser.ts with new mutation parsers following the established pattern:
- `parseInsert()` - handles INSERT syntax
- `parseUpdate()` - handles UPDATE syntax
- `parseDelete()` - handles DELETE syntax
- `parseUpsert()` - handles UPSERT syntax

This follows the Single Responsibility principle - each parser handles one mutation type.

### 4.2 Syntax Design (Hardened via /adversarial)

```
# INSERT - single row
users insert name = "Alice", email = "a@e.com"
users insert name = "Alice", meta = '{"role": "admin"}'  # JSONB as quoted string

# INSERT - explicit columns (when not all columns)
users insert (name, email) values ("Alice", "a@e.com")

# UPDATE - requires WHERE (safety)
users update set active = false where id = 1
users update set name = "Bob", updated_at = now() where email = "a@e.com"

# DELETE - requires WHERE or ! for bulk
users delete where id = 1
users delete where id = 1 !        # ! = execute immediately
users delete where active = false  # Dry-run (shows affected count)

# UPSERT - requires ON conflict clause
users upsert email = "a@e.com", name = "Alice" on email do nothing
users upsert email = "a@e.com", name = "Alice" on email do update set name = excluded.name
```

### 4.3 Safety Mechanisms

| Mechanism | Description |
|-----------|-------------|
| Dry-run default | All mutations show SQL without executing |
| `!` suffix | Execute immediately (requires execMode) |
| `.execute` | Execute last dry-run query |
| Bulk confirmation | UPDATE/DELETE affecting >100 rows requires `!` or confirmation |
| WHERE required | UPDATE/DELETE without WHERE show warning |

### 4.4 New Types

```typescript
// In types.ts
export type MutationType = 'insert' | 'update' | 'delete' | 'upsert';

export interface ParsedMutation {
  type: MutationType;
  table: string;
  columns?: string[];           // For INSERT
  values?: MutationValue[];     // For INSERT
  assignments?: Assignment[];   // For UPDATE, UPSERT
  where?: WhereClause[];        // For UPDATE, DELETE
  onConflict?: OnConflictClause; // For UPSERT
  executeImmediate: boolean;    // ! suffix present
}

export interface Assignment {
  column: string;
  value: MutationValue;
}

export interface MutationValue {
  type: 'string' | 'number' | 'boolean' | 'null' | 'function' | 'json';
  raw: string;              // Original text
  value: unknown;           // Parsed value
}

export interface OnConflictClause {
  columns: string[];        // Conflict target
  action: 'nothing' | 'update';
  updateAssignments?: Assignment[];
}
```

### 4.5 `.explain` Toggle

```typescript
// In types.ts - extend ReplState
export interface ReplState {
  // ... existing fields
  explainMode: boolean;  // NEW: Show EXPLAIN output
}

// Status line indicator
// [natural] [alias:onCollision] [explain:on] [exec:off]
```

### 4.6 Data Model Changes

| Entity | Change | Migration needed |
|--------|--------|------------------|
| ReplState | Add `explainMode: boolean` | No |
| types.ts | Add mutation types | No |
| parser.ts | Add mutation parsers | No |

### 4.7 API Contract (Internal)

| Function | Input | Output |
|----------|-------|--------|
| `parseMutation(input, schema)` | string, ResolvedSchema | ParsedMutation \| ParseError |
| `mutationToSql(mutation, dialect)` | ParsedMutation, DialectMode | { sql, params } |
| `validateMutationColumns(mutation, schema)` | ParsedMutation, ResolvedSchema | ValidationError[] |

## 5. Acceptance Criteria (BDD)

### Scenario Group: INSERT Operations

```gherkin
@priority:high @type:nominal
Scenario: SC-01 Insert single row with key-value syntax
  Given the REPL is in natural mode with schema loaded
  When I enter "users insert name = \"Alice\", email = \"a@e.com\""
  Then I should see SQL: INSERT INTO "users" ("name", "email") VALUES ($1, $2)
  And I should see params: ["Alice", "a@e.com"]
  And the query should NOT be executed (dry-run)

@priority:high @type:nominal
Scenario: SC-02 Insert with JSONB value
  Given the REPL is in natural mode
  When I enter "users insert name = \"Bob\", meta = '{\"role\": \"admin\"}'"
  Then I should see SQL with JSONB parameter bound correctly
  And the JSONB value should be parsed as JSON type

@priority:medium @type:edge
Scenario: SC-03 Insert with execute suffix
  Given the REPL is in exec mode with database connected
  When I enter "users insert name = \"Alice\" !"
  Then the INSERT should be executed immediately
  And I should see the inserted row count
```

### Scenario Group: UPDATE Operations

```gherkin
@priority:high @type:nominal
Scenario: SC-04 Update with WHERE clause
  Given the REPL is in natural mode
  When I enter "users update set active = false where id = 1"
  Then I should see SQL: UPDATE "users" SET "active" = $1 WHERE "id" = $2
  And I should see params: [false, 1]

@priority:high @type:error
Scenario: SC-05 Update without WHERE shows warning
  Given the REPL is in natural mode
  When I enter "users update set active = false"
  Then I should see warning: "⚠️ UPDATE without WHERE affects all rows"
  And I should see the affected row count estimate
  And I should be prompted: "Add ! to execute or .execute to confirm"

@priority:medium @type:edge
Scenario: SC-06 Update multiple columns
  Given the REPL is in natural mode
  When I enter "users update set name = \"Bob\", updated_at = now() where id = 1"
  Then I should see SQL with both columns in SET clause
  And now() should be rendered as function call, not string
```

### Scenario Group: DELETE Operations

```gherkin
@priority:high @type:nominal
Scenario: SC-07 Delete with WHERE clause
  Given the REPL is in natural mode
  When I enter "users delete where id = 1"
  Then I should see SQL: DELETE FROM "users" WHERE "id" = $1
  And I should see params: [1]

@priority:high @type:error
Scenario: SC-08 Delete without WHERE blocked
  Given the REPL is in natural mode
  When I enter "users delete"
  Then I should see error: "DELETE without WHERE is not allowed. Use 'users delete where true !' to delete all."

@priority:high @type:security
Scenario: SC-09 Bulk delete requires confirmation
  Given the REPL is in exec mode
  And the query would affect more than 100 rows
  When I enter "users delete where active = false"
  Then I should see: "⚠️ This will delete ~150 rows. Add ! to confirm."
  And the query should NOT be executed
```

### Scenario Group: UPSERT Operations

```gherkin
@priority:high @type:nominal
Scenario: SC-10 Upsert with DO NOTHING
  Given the REPL is in natural mode
  When I enter "users upsert email = \"a@e.com\", name = \"Alice\" on email do nothing"
  Then I should see SQL: INSERT INTO "users" (...) ON CONFLICT ("email") DO NOTHING

@priority:high @type:nominal
Scenario: SC-11 Upsert with DO UPDATE
  Given the REPL is in natural mode
  When I enter "users upsert email = \"a@e.com\", name = \"Alice\" on email do update set name = excluded.name"
  Then I should see SQL with ON CONFLICT DO UPDATE SET clause
  And excluded.name should reference the conflicting value

@priority:medium @type:edge
Scenario: SC-12 Upsert with composite key
  Given the REPL is in natural mode
  When I enter "orders upsert user_id = 1, product_id = 2, qty = 5 on (user_id, product_id) do update set qty = excluded.qty"
  Then I should see ON CONFLICT with both columns
```

### Scenario Group: Column Validation

```gherkin
@priority:high @type:security
Scenario: SC-13 Unknown column rejected
  Given the REPL has schema with users(id, name, email)
  When I enter "users insert unknown_col = \"value\""
  Then I should see error: "Column \"unknown_col\" does not exist in table \"users\""
  And no SQL should be generated

@priority:medium @type:error
Scenario: SC-14 SQL injection attempt blocked
  Given the REPL is in natural mode
  When I enter "users insert name = \"'; DROP TABLE users; --\""
  Then the value should be bound as parameter
  And no raw SQL should be interpolated
```

### Scenario Group: .explain Toggle

```gherkin
@priority:medium @type:nominal
Scenario: SC-15 Enable explain mode
  Given the REPL is in natural mode with explain off
  When I enter ".explain"
  Then I should see: "EXPLAIN mode: ON"
  And the status line should show [explain:on]

@priority:medium @type:nominal
Scenario: SC-16 Query with explain shows plan
  Given the REPL is in exec mode with explain on
  When I enter "users where active = true"
  Then I should see the SQL result
  And I should see the EXPLAIN ANALYZE output below

@priority:low @type:edge
Scenario: SC-17 Explain toggle persists
  Given I enabled explain mode
  When I run multiple queries
  Then each query should show EXPLAIN output
  Until I enter ".explain" again to toggle off
```

### Scenario Group: Error Handling

```gherkin
@priority:high @type:error
Scenario: SC-18 Parse error with position
  Given the REPL is in natural mode
  When I enter "users insert name = "
  Then I should see: "Parse error at position 20: expected value after ="
  And the error position should be highlighted
```

**Coverage matrix:**

| Scenario | Nominal | Edge | Error | Security |
|----------|---------|------|-------|----------|
| SC-01 | ✓ | | | |
| SC-02 | ✓ | | | |
| SC-03 | | ✓ | | |
| SC-04 | ✓ | | | |
| SC-05 | | | ✓ | |
| SC-06 | | ✓ | | |
| SC-07 | ✓ | | | |
| SC-08 | | | ✓ | |
| SC-09 | | | | ✓ |
| SC-10 | ✓ | | | |
| SC-11 | ✓ | | | |
| SC-12 | | ✓ | | |
| SC-13 | | | | ✓ |
| SC-14 | | | | ✓ |
| SC-15 | ✓ | | | |
| SC-16 | ✓ | | | |
| SC-17 | | ✓ | | |
| SC-18 | | | ✓ | |

## 6. Implementation Plan

### Block 1: Types & Parser Foundation — ~45min

**Type:** Feature slice
**Dependencies:** None
**Files:**
- `packages/cli/src/repl/types.ts` — Add MutationType, ParsedMutation, Assignment, etc.
- `packages/cli/src/repl/parser.ts` — Add tokenizer extensions for `=` operator in assignments
- `packages/cli/src/repl/parser.test.ts` — Unit tests for new types

**Exit criteria:**
- [ ] New types compile without errors
- [ ] Tokenizer handles assignment syntax
- [ ] 5+ unit tests pass

### Block 2: INSERT Parser — ~45min

**Type:** Feature slice
**Dependencies:** Block 1
**Files:**
- `packages/cli/src/repl/parser.ts` — Add `parseInsert()` function
- `packages/cli/src/repl/parser.test.ts` — INSERT parsing tests

**Exit criteria:**
- [ ] `users insert name = "Alice"` parses correctly
- [ ] JSONB values handled as strings
- [ ] Column validation works
- [ ] 8+ unit tests pass (SC-01, SC-02, SC-03)

### Block 3: UPDATE & DELETE Parsers — ~45min

**Type:** Feature slice
**Dependencies:** Block 1
**Files:**
- `packages/cli/src/repl/parser.ts` — Add `parseUpdate()`, `parseDelete()` functions
- `packages/cli/src/repl/parser.test.ts` — UPDATE/DELETE parsing tests

**Exit criteria:**
- [ ] UPDATE with SET and WHERE parses correctly
- [ ] DELETE with WHERE parses correctly
- [ ] Missing WHERE generates warning
- [ ] 10+ unit tests pass (SC-04 to SC-09)

### Block 4: UPSERT Parser & Explain Toggle — ~45min

**Type:** Feature slice
**Dependencies:** Block 1
**Files:**
- `packages/cli/src/repl/parser.ts` — Add `parseUpsert()` function
- `packages/cli/src/repl/types.ts` — Add `explainMode` to ReplState
- `packages/cli/src/repl/batch.ts` — Add `.explain` dot command handler
- `packages/cli/src/repl/index.tsx` — Integrate explain toggle in status line

**Exit criteria:**
- [ ] UPSERT with ON conflict parses correctly
- [ ] `.explain` toggles explainMode
- [ ] Status line shows explain state
- [ ] 8+ unit tests pass (SC-10 to SC-12, SC-15 to SC-17)

### Block 5: Query Executor Integration — ~60min

**Type:** Feature slice
**Dependencies:** Blocks 2-4
**Files:**
- `packages/cli/src/repl/query-executor.ts` — Add mutation execution path
- `packages/cli/src/repl/query-executor.test.ts` — Integration tests
- `packages/cli/src/repl/index.tsx` — Handle mutation results display

**Exit criteria:**
- [ ] Mutations use orm.insert/update/delete/upsert builders
- [ ] Dry-run shows SQL + params
- [ ] `!` suffix triggers execution
- [ ] Bulk operations require confirmation
- [ ] EXPLAIN output shown when enabled
- [ ] 10+ integration tests pass (SC-13, SC-14, SC-18)

## 7. Test Strategy

### Test pyramid:

| Level | Count | Focus |
|-------|-------|-------|
| Unit | ~25 | Parser functions, type validation |
| Integration | ~15 | Query executor, ORM builder integration |
| E2E | ~5 | Full REPL flow with database |

### Test data requirements:

**Fixtures:**
- `users` table with id, name, email, active, meta (jsonb)
- `orders` table with composite key (user_id, product_id)
- Pre-seeded test data for UPDATE/DELETE tests

**Mocks:**
- Schema mock (already exists)
- Database connection mock for executor tests

### Test file mapping:

| Scenarios | Test File |
|-----------|-----------|
| SC-01 to SC-03 | parser.test.ts (INSERT) |
| SC-04 to SC-06 | parser.test.ts (UPDATE) |
| SC-07 to SC-09 | parser.test.ts (DELETE) |
| SC-10 to SC-12 | parser.test.ts (UPSERT) |
| SC-13, SC-14 | parser.test.ts (validation) |
| SC-15 to SC-17 | batch.test.ts (explain toggle) |
| SC-18 | parser.test.ts (errors) |

## 8. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| SQL injection via malformed input | HIGH | LOW | Column validation + parameterized queries |
| Accidental bulk DELETE | HIGH | MEDIUM | WHERE required + confirmation for >100 rows |
| JSONB syntax confusion | MEDIUM | MEDIUM | Document that JSONB uses quoted strings |
| Parser complexity growth | MEDIUM | MEDIUM | Keep parsers modular, one per mutation type |
| Dialect differences in UPSERT | MEDIUM | LOW | PostgreSQL-first, document dialect limits |

## 9. Definition of Done

- [ ] All 5 blocks implemented
- [ ] All 18 BDD scenarios have passing tests
- [ ] All tests pass (unit + integration)
- [ ] Lint/typecheck pass
- [ ] `.explain` toggle works and persists
- [ ] Status line updated with explain indicator
- [ ] Column validation prevents unknown columns
- [ ] Bulk operations require confirmation
- [ ] /review clean (no blocking findings)

## 10. Out of Scope (Deferred)

| Feature | Reason | Track In |
|---------|--------|----------|
| `.load <table> <file>` bulk import | Separate feature, complex edge cases | TODO_CLI.md |
| RETURNING clause | Nice-to-have, not core | TODO_CLI.md |
| Multi-row INSERT syntax | Single row sufficient for REPL use case | - |
| Transaction support | Requires session state management | TODO_CLI.md |
