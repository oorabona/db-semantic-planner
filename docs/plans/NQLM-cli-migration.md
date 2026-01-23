---
doc-meta:
  status: draft
  scope: cli
  type: specification
  created: 2026-01-23
  updated: 2026-01-23
  complexity: ENTERPRISE
  time-budget: 20h
---

# Specification: NQLM - NQL CLI Migration

## 0. Quick Reference (ALWAYS VISIBLE)

| Item | Value |
|------|-------|
| Scope | cli, examples, docs |
| Complexity | ENTERPRISE |
| Time budget | ~20h |
| Blocks | 6 |
| BDD scenarios | 18 |
| Risk level | MEDIUM |

## 1. Problem Statement

Le CLI REPL utilise un parser legacy de 9760 lignes avec une syntaxe sans pipe (`users where x`). Le nouveau package `@dbsp/nql` offre une syntaxe moderne avec pipe (`users | where x`), 167 tests, et compile vers IntentAST. Cette migration unifie le parsing, supprime la dette technique, et aligne la syntaxe sur les standards modernes (PowerShell, Unix pipes).

## 2. User Stories

### US-1: Developer using REPL
```
AS A developer using the CLI REPL
I WANT to write queries with pipe syntax
SO THAT I have a consistent, composable query language
```
**ACCEPTANCE:** `users | where active = true | limit 10` returns correct results

### US-2: Documentation reader
```
AS A developer reading QUICKSTART.md
I WANT every example query to work exactly as shown
SO THAT I can learn by copy-pasting examples
```
**ACCEPTANCE:** 100% of QUICKSTART examples execute successfully

### US-3: Maintainer
```
AS A codebase maintainer
I WANT a single parser implementation
SO THAT I don't maintain duplicate parsing logic
```
**ACCEPTANCE:** Legacy parser files deleted, only @dbsp/nql remains

## 3. Business Rules

### 3.1 Invariants (always true)
- INV-01: All NQL queries MUST use pipe syntax (`table | clause | clause`)
- INV-02: IntentAST output MUST be identical for equivalent queries
- INV-03: SQL output MUST preserve existing semantics

### 3.2 Preconditions (required before action)
- PRE-01: @dbsp/nql package MUST be built and passing tests
- PRE-02: Schema MUST be loaded before query execution

### 3.3 Effects (what changes)
- EFF-01: All .dbsp files use pipe syntax
- EFF-02: QUICKSTART.md examples use pipe syntax
- EFF-03: Legacy parser.ts and query-executor.ts deleted
- EFF-04: CLI uses @dbsp/nql for all NQL parsing

### 3.4 Error Handling
- ERR-01: Parse error → Display line/column with helpful message
- ERR-02: Schema validation error → Show which table/column is invalid
- ERR-03: Execution error → Show SQL and error from database

## 4. Technical Design

### 4.1 Architecture Decision

**Chosen:** Replace legacy parser with @dbsp/nql, keep Kysely adapter for SQL compilation.

**Flow:**
```
NQL string → @dbsp/nql parse() → NQL AST → compile() → IntentAST → adapter → SQL
```

**Why:**
- Single source of truth for NQL parsing
- @dbsp/nql already has 167 tests
- IntentAST is the contract between parser and adapter

### 4.2 Files to Delete (Legacy)

| File | Lines | Reason |
|------|-------|--------|
| `packages/cli/src/repl/parser.ts` | 2900 | Replaced by @dbsp/nql |
| `packages/cli/src/repl/parser.test.ts` | 4055 | Tests for deleted code |
| `packages/cli/src/repl/query-executor.ts` | 1151 | Replaced by nql-executor.ts |
| `packages/cli/src/repl/query-executor.test.ts` | 1654 | Tests for deleted code |
| **Total** | **9760** | |

### 4.3 Files to Create

| File | Purpose |
|------|---------|
| `packages/cli/src/repl/nql-executor.ts` | Execute NQL via @dbsp/nql + adapter |
| `packages/cli/src/repl/nql-executor.test.ts` | Tests for nql-executor |

### 4.4 Files to Modify

| File | Change |
|------|--------|
| `packages/cli/package.json` | Add @dbsp/nql dependency |
| `packages/cli/src/repl/batch.ts` | Use nql-executor instead of query-executor |
| `packages/cli/src/repl/types.ts` | Remove legacy ParsedQuery types |
| `examples/*.dbsp` (10 files) | Migrate to pipe syntax |
| `examples/QUICKSTART.md` | Update all examples |

### 4.5 Syntax Migration

```diff
# Queries
- users where name = 'Alice'
+ users | where name = 'Alice'

- posts select title, content where published = true limit 10
+ posts | select title, content | where published = true | limit 10

- orders group by status select status, count(*) as cnt
+ orders | group by status | select status, count(*) as cnt

# Mutations (unchanged structure, but with pipe for reads)
INSERT INTO users (name, email) VALUES ('Bob', 'bob@example.com')
UPDATE users SET active = false WHERE id = 5
DELETE FROM users WHERE id = 10
```

## 5. Acceptance Criteria (BDD)

### Scenario Group: Query Execution

```gherkin
@priority:high @type:nominal
Scenario: SC-01 Simple SELECT with pipe
  Given a schema with table "users" having columns (id, name, active)
  And the table contains rows
  When I execute "users | where active = true | limit 5"
  Then I receive up to 5 rows where active is true
  And the SQL uses proper WHERE and LIMIT clauses

@priority:high @type:nominal
Scenario: SC-02 SELECT with aggregation
  Given a schema with table "orders" having columns (id, status, total)
  When I execute "orders | group by status | select status, count(*) as cnt"
  Then I receive aggregated counts per status
  And the SQL uses GROUP BY

@priority:high @type:nominal
Scenario: SC-03 SELECT with join via include
  Given a schema with "posts" related to "users" via user_id
  When I execute "posts | include author"
  Then I receive posts with nested author objects

@priority:medium @type:edge
Scenario: SC-04 Quoted identifier for reserved word
  Given a schema with table "order" (reserved SQL word)
  When I execute '"order" | limit 10'
  Then the query executes successfully
  And the SQL properly quotes the table name

@priority:medium @type:edge
Scenario: SC-05 String with escaped quote
  Given a schema with table "users"
  When I execute "users | where name = 'O''Brien'"
  Then I receive users with name "O'Brien"

@priority:high @type:error
Scenario: SC-06 Parse error shows helpful message
  Given a schema with table "users"
  When I execute "users | where = 'bad syntax'"
  Then I receive a parse error
  And the error indicates the problematic token location
```

### Scenario Group: Mutations

```gherkin
@priority:high @type:nominal
Scenario: SC-07 INSERT execution
  Given a schema with table "users" having columns (id, name, email)
  When I execute "INSERT INTO users (name, email) VALUES ('Test', 'test@x.com')"
  Then a new row is inserted
  And I receive the inserted row data

@priority:high @type:nominal
Scenario: SC-08 UPDATE execution
  Given a schema with table "users" with existing rows
  When I execute "UPDATE users SET active = false WHERE id = 1"
  Then the row is updated
  And I receive the count of affected rows

@priority:high @type:nominal
Scenario: SC-09 DELETE execution
  Given a schema with table "users" with existing rows
  When I execute "DELETE FROM users WHERE id = 999"
  Then the row is deleted (if exists)
  And I receive the count of affected rows
```

### Scenario Group: REPL Integration

```gherkin
@priority:high @type:nominal
Scenario: SC-10 REPL commands preserved
  Given the REPL is started with a schema
  When I execute ".tables"
  Then I see the list of tables
  And this is NOT parsed as NQL

@priority:high @type:nominal
Scenario: SC-11 Raw SQL preserved
  Given the REPL is started
  When I execute "!SELECT 1+1"
  Then the raw SQL is executed directly
  And this is NOT parsed as NQL

@priority:medium @type:nominal
Scenario: SC-12 Multiline query
  Given the REPL is started
  When I execute a query spanning multiple lines:
    """
    users
    | where active = true
    | limit 10
    """
  Then the query executes successfully
```

### Scenario Group: .dbsp File Execution

```gherkin
@priority:high @type:nominal
Scenario: SC-13 Execute migrated .dbsp file
  Given "examples/minimal.dbsp" is migrated to pipe syntax
  When I run "dbsp repl --input examples/minimal.dbsp"
  Then all queries in the file execute successfully
  And results match expected outputs

@priority:high @type:nominal
Scenario: SC-14 All .dbsp files pass
  Given all 10 .dbsp files are migrated to pipe syntax
  When I run each file through the REPL
  Then 0 parse errors occur
  And 0 execution errors occur
```

### Scenario Group: Documentation

```gherkin
@priority:high @type:nominal
Scenario: SC-15 QUICKSTART examples work
  Given QUICKSTART.md is updated with pipe syntax
  When I extract and execute each NQL query example
  Then 100% of queries execute without error
  And results match documented expectations

@priority:medium @type:edge
Scenario: SC-16 No legacy syntax in docs
  Given QUICKSTART.md is updated
  When I search for legacy syntax patterns (no pipe between table and clause)
  Then 0 matches are found
```

### Scenario Group: Cleanup

```gherkin
@priority:high @type:nominal
Scenario: SC-17 Legacy files deleted
  Given migration is complete
  When I check for legacy files
  Then parser.ts does not exist
  And query-executor.ts does not exist
  And their test files do not exist

@priority:high @type:nominal
Scenario: SC-18 Tests pass after cleanup
  Given legacy files are deleted
  When I run "pnpm test"
  Then all tests pass
  And no import errors occur
```

**Coverage matrix:**

| Scenario | Nominal | Edge | Error | Security |
|----------|---------|------|-------|----------|
| SC-01 | ✓ | | | |
| SC-02 | ✓ | | | |
| SC-03 | ✓ | | | |
| SC-04 | | ✓ | | |
| SC-05 | | ✓ | | |
| SC-06 | | | ✓ | |
| SC-07 | ✓ | | | |
| SC-08 | ✓ | | | |
| SC-09 | ✓ | | | |
| SC-10 | ✓ | | | |
| SC-11 | ✓ | | | |
| SC-12 | | ✓ | | |
| SC-13 | ✓ | | | |
| SC-14 | ✓ | | | |
| SC-15 | ✓ | | | |
| SC-16 | | ✓ | | |
| SC-17 | ✓ | | | |
| SC-18 | ✓ | | | |

## 6. Implementation Plan

### Block 1: CLI Dependency Setup — 30min
**Type:** Infra
**Dependencies:** None
**Files:**
- `packages/cli/package.json` — Add `"@dbsp/nql": "workspace:*"`

**Exit criteria:**
- [ ] `pnpm install` succeeds
- [ ] `import { parse, compile } from '@dbsp/nql'` works

---

### Block 2: Create nql-executor.ts — 2h
**Type:** Feature slice
**Dependencies:** Block 1
**Files:**
- `packages/cli/src/repl/nql-executor.ts` — New file
- `packages/cli/src/repl/nql-executor.test.ts` — Tests

**Exit criteria:**
- [ ] `executeNql()` handles SELECT queries (SC-01, SC-02, SC-03)
- [ ] `executeNql()` handles mutations (SC-07, SC-08, SC-09)
- [ ] Parse errors return structured error (SC-06)
- [ ] Tests pass

---

### Block 3: Integrate into REPL — 2h
**Type:** Feature slice
**Dependencies:** Block 2
**Files:**
- `packages/cli/src/repl/batch.ts` — Use nql-executor
- `packages/cli/src/repl/types.ts` — Update types if needed

**Exit criteria:**
- [ ] REPL commands (.tables, .schema) still work (SC-10)
- [ ] Raw SQL (!sql) still works (SC-11)
- [ ] NQL queries use new executor
- [ ] Multiline works (SC-12)

---

### Block 4: Migrate .dbsp files — 3h
**Type:** Content migration
**Dependencies:** Block 3
**Files (10):**
- `examples/minimal.dbsp`
- `examples/blog.dbsp`
- `examples/blog-extended.dbsp`
- `examples/ecommerce.dbsp`
- `examples/scheduling.dbsp`
- `examples/pimdam.dbsp`
- `examples/test-blog.dbsp`
- `examples/test-blog.assert.dbsp`
- `examples/test-minimal.dbsp`
- `examples/test-minimal.assert.dbsp`

**Exit criteria:**
- [ ] All files use pipe syntax
- [ ] All files execute without errors (SC-13, SC-14)
- [ ] Assertions pass

---

### Block 5: Update QUICKSTART.md — 4h
**Type:** Documentation
**Dependencies:** Block 3
**Files:**
- `examples/QUICKSTART.md` (96KB)

**Exit criteria:**
- [ ] All NQL examples use pipe syntax
- [ ] Every example tested and verified (SC-15)
- [ ] No legacy syntax remains (SC-16)
- [ ] Expected outputs documented

---

### Block 6: Delete Legacy + Final Validation — 2h
**Type:** Cleanup
**Dependencies:** Block 4, Block 5
**Files to delete:**
- `packages/cli/src/repl/parser.ts`
- `packages/cli/src/repl/parser.test.ts`
- `packages/cli/src/repl/query-executor.ts`
- `packages/cli/src/repl/query-executor.test.ts`

**Files to update:**
- Any remaining imports of deleted files

**Exit criteria:**
- [ ] Legacy files deleted (SC-17)
- [ ] `pnpm test` passes (SC-18)
- [ ] `pnpm build` succeeds
- [ ] No import errors

## 7. Test Strategy

### Test pyramid:

| Level | Count | Focus |
|-------|-------|-------|
| Unit | ~20 | nql-executor parsing and compilation |
| Integration | ~10 | REPL batch processing |
| E2E | ~50+ | Every QUICKSTART query |

### Test data requirements:
- **Fixtures:** Use existing `examples/*.schema.ts` and `examples/*.seed.sql`
- **Mocks:** `createCompileOnlyAdapter` for SQL-only tests
- **Real DB:** PostgreSQL for E2E validation

### E2E Validation Process (QUICKSTART):

```bash
# For each example in QUICKSTART.md:
# 1. Extract query
# 2. Execute against test database
# 3. Verify output matches documentation
# 4. Record pass/fail
```

## 8. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| @dbsp/nql missing feature | HIGH | LOW | Audit grammar vs .dbsp files first |
| QUICKSTART too large (96KB) | MEDIUM | HIGH | Process section by section |
| Breaking change in SQL output | HIGH | LOW | Compare SQL before/after |
| Test database setup issues | MEDIUM | MEDIUM | Use existing E2E infrastructure |

## 9. Known Limitations (from Adversarial Review)

| Limitation | Workaround | Tracked In |
|------------|------------|------------|
| CTEs (`let x = ...`) not compiled | Don't use CTEs, use subqueries | TODO_NQL.md (v2.1) |

## 10. Definition of Done

- [ ] All 6 blocks implemented
- [ ] All 18 BDD scenarios have passing tests
- [ ] All tests pass (unit + integration + e2e)
- [ ] Lint/typecheck pass
- [ ] 9760 lines of legacy code deleted
- [ ] QUICKSTART.md 100% tested
- [ ] All .dbsp files migrated and passing
- [ ] /review clean (no blocking findings)
