---
doc-meta:
  status: hardened
  scope: cli
  type: specification
  created: 2026-01-18
  updated: 2026-01-18
  complexity: COMPLEX
  time-budget: 2-3h
  adversarial-review: 2026-01-18
---

# Specification: DEMO-E2E Assertion System

## 0. Quick Reference (ALWAYS VISIBLE)

| Item | Value |
|------|-------|
| Scope | cli (packages/cli) |
| Complexity | COMPLEX |
| Time budget | 2-3h |
| Blocks | 5 |
| BDD scenarios | 14 |
| Risk level | MEDIUM (new file format, CI integration) |
| Adversarial review | ✅ 2026-01-18 (5/5 perspectives) |

## 1. Problem Statement

Users following QUICKSTART.md need a way to verify that documented examples produce the expected SQL output. Currently, there's no automated way to validate that:
1. REPL queries generate correct SQL
2. Documentation examples match actual behavior
3. Changes don't break expected output

This makes documentation maintenance error-prone and reduces confidence in examples.

## 2. User Stories

### US-1: Documentation Maintainer
AS A documentation maintainer
I WANT to run assertions against REPL query output
SO THAT I can verify QUICKSTART.md examples are correct

ACCEPTANCE: Running `--assert` flag validates SQL output against expected values

### US-2: CI/CD Integration
AS A CI pipeline
I WANT automated validation of example queries
SO THAT documentation stays in sync with implementation

ACCEPTANCE: Non-zero exit code when assertions fail, JSON output for parsing

### US-3: Developer Debugging
AS A developer making changes
I WANT to see exactly what assertion failed
SO THAT I can fix the issue quickly

ACCEPTANCE: Clear error messages showing expected vs actual

## 3. Business Rules

### 3.1 Invariants (always true)
- INV-01: Assertion file is optional (backward compatible)
- INV-02: Query file (.dbsp) and assertion file (.assert.dbsp) are separate
- INV-03: Each assertion block maps to exactly one query
- INV-04: Exit code 0 = all pass, exit code 1 = any fail

### 3.2 Preconditions (required before action)
- PRE-01: `--assert` requires `--input` (cannot use with `--eval` alone)
- PRE-02: Assertion file must be parseable YAML-like format
- PRE-03: Query indices in assertion file must exist in query results

### 3.3 Effects (what changes)
- EFF-01: BatchResult includes assertion results when `--assert` provided
- EFF-02: JSON output includes assertion summary and details
- EFF-03: Text output shows assertion pass/fail per query

### 3.4 Error Handling
- ERR-01: Missing assertion file → error with helpful message
- ERR-02: Invalid assertion syntax → error with line number
- ERR-03: Query index out of bounds → error listing available indices
- ERR-04: Assertion type unknown → error listing valid types
- ERR-05: Assertion on failed query → shows both query error and assertion failure
- ERR-06: Ambiguous match → "Ambiguous match: 'X' matches queries 0, 2. Use query index instead."

## 4. Technical Design

### 4.1 Architecture Decision
**Approach:** Extend existing batch.ts with assertion parsing and validation

**Why:**
- Minimal new files (just assertion-parser.ts)
- Reuses existing BatchResult structure
- No changes to core packages

### 4.2 File Format: .assert.dbsp

```yaml
# Assertion blocks start with --- followed by query reference
--- query: 0
output.contains: Tables (5)

--- query: 3
sql.contains: where "t0"."published" = $1
params.equals: [true]
success: true

--- match: posts include author
sql.contains: left join
plan.contains: include-strategy: join
```

### 4.3 Data Model Changes

| Entity | Change | Migration needed |
|--------|--------|------------------|
| ReplOptions | Add `assert?: string` | No |
| BatchModeOptions | Add `assertFile?: string` | No |
| BatchResult | No change (already has all needed fields) | No |
| New: AssertionResult | New interface for assertion outcomes | No |

### 4.4 API Contract

**CLI:**
```bash
pnpm dbsp repl --schema <schema> --input <queries.dbsp> --assert <assertions.assert.dbsp> [--format json]
```

**Output (JSON format):**
```json
{
  "queries": [...],
  "assertions": {
    "total": 5,
    "passed": 4,
    "failed": 1,
    "results": [
      {
        "queryIndex": 0,
        "query": ".tables",
        "assertions": [
          { "type": "output.contains", "expected": "Tables (5)", "passed": true }
        ],
        "passed": true
      }
    ]
  }
}
```

## 5. Acceptance Criteria (BDD)

### Scenario Group: Basic Assertions

```gherkin
@priority:high @type:nominal
Scenario: SC-01 Assert output.contains passes when text found
  Given a query file with ".tables"
  And an assertion file with "--- query: 0\noutput.contains: Tables"
  When I run dbsp repl with --input and --assert
  Then the assertion passes
  And exit code is 0

@priority:high @type:nominal
Scenario: SC-02 Assert output.contains fails when text not found
  Given a query file with ".tables"
  And an assertion file with "--- query: 0\noutput.contains: NotFound"
  When I run dbsp repl with --input and --assert
  Then the assertion fails
  And exit code is 1
  And output shows expected vs actual

@priority:high @type:nominal
Scenario: SC-03 Assert sql.equals validates exact SQL match
  Given a query file with "posts"
  And an assertion file with "--- query: 0\nsql.equals: select \"t0\".* from \"posts\" as \"t0\""
  When I run dbsp repl with --input and --assert
  Then the assertion passes

@priority:high @type:nominal
Scenario: SC-04 Assert params.equals validates parameters
  Given a query file with "posts where published = true"
  And an assertion file with "--- query: 0\nparams.equals: [true]"
  When I run dbsp repl with --input and --assert
  Then the assertion passes
```

### Scenario Group: Query Matching

```gherkin
@priority:medium @type:nominal
Scenario: SC-05 Match by query text instead of index
  Given a query file with "posts\nposts where id = 1"
  And an assertion file with "--- match: posts where id = 1\nparams.equals: [1]"
  When I run dbsp repl with --input and --assert
  Then the assertion matches the correct query
  And the assertion passes

@priority:medium @type:edge
Scenario: SC-06 Query index out of bounds
  Given a query file with 3 queries
  And an assertion file with "--- query: 10\noutput.contains: test"
  When I run dbsp repl with --input and --assert
  Then error shows "Query index 10 out of bounds (0-2)"
  And exit code is 1
```

### Scenario Group: Multiple Assertions

```gherkin
@priority:high @type:nominal
Scenario: SC-07 Multiple assertions on single query
  Given a query file with "posts include author"
  And an assertion file with:
    """
    --- query: 0
    sql.contains: left join
    sql.contains: "author.id"
    plan.contains: include-strategy
    """
  When I run dbsp repl with --input and --assert
  Then all 3 assertions pass
  And summary shows 3/3 passed

@priority:high @type:nominal
Scenario: SC-08 Multiple query blocks in assertion file
  Given a query file with 5 queries
  And an assertion file with assertions for queries 0, 2, and 4
  When I run dbsp repl with --input and --assert
  Then only queries 0, 2, 4 have assertions validated
  And queries 1, 3 have no assertions (pass by default)
```

### Scenario Group: Error Handling

```gherkin
@priority:medium @type:error
Scenario: SC-09 Invalid assertion syntax
  Given an assertion file with invalid YAML
  When I run dbsp repl with --input and --assert
  Then error shows "Invalid assertion syntax at line X"
  And exit code is 1

@priority:medium @type:error
Scenario: SC-10 Unknown assertion type
  Given an assertion file with "--- query: 0\nfoo.bar: test"
  When I run dbsp repl with --input and --assert
  Then error shows "Unknown assertion type: foo.bar"
  And lists valid types

@priority:medium @type:error
Scenario: SC-11 Missing --input with --assert
  Given only --assert is provided (no --input)
  When I run dbsp repl
  Then error shows "--assert requires --input"
```

### Scenario Group: Output Formats

```gherkin
@priority:high @type:nominal
Scenario: SC-12 JSON format includes assertion results
  Given assertions that pass and fail
  When I run dbsp repl with --format json and --assert
  Then JSON output includes "assertions" object
  And assertions.total equals number of assertion blocks
  And assertions.passed and assertions.failed are correct
```

### Scenario Group: SQL Normalization

```gherkin
@priority:medium @type:nominal
Scenario: SC-13 SQL whitespace normalization for comparison
  Given a query that produces SQL with varying whitespace
  And an assertion file with "--- query: 0\nsql.equals: select * from users"
  When I run dbsp repl with --input and --assert
  Then whitespace is normalized before comparison
  And the assertion passes despite formatting differences
```

### Scenario Group: Ambiguity Handling

```gherkin
@priority:medium @type:error
Scenario: SC-14 Ambiguous match error with helpful message
  Given a query file with "posts\nposts where id = 1\nposts"
  And an assertion file with "--- match: posts\noutput.contains: test"
  When I run dbsp repl with --input and --assert
  Then error shows "Ambiguous match: 'posts' matches queries 0, 2. Use query index instead."
  And exit code is 1
```

**Coverage matrix:**

| Scenario | Nominal | Edge | Error | Security |
|----------|---------|------|-------|----------|
| SC-01 | ✓ | | | |
| SC-02 | ✓ | | | |
| SC-03 | ✓ | | | |
| SC-04 | ✓ | | | |
| SC-05 | ✓ | | | |
| SC-06 | | ✓ | | |
| SC-07 | ✓ | | | |
| SC-08 | ✓ | | | |
| SC-09 | | | ✓ | |
| SC-10 | | | ✓ | |
| SC-11 | | | ✓ | |
| SC-12 | ✓ | | | |
| SC-13 | ✓ | | | |
| SC-14 | | | ✓ | |

## 6. Implementation Plan

### Block 1: Assertion Parser — 45 min
**Type:** Feature slice
**Dependencies:** None
**Files:**
- `packages/cli/src/repl/assertion-parser.ts` — new file

**Tasks:**
1. Define AssertionBlock interface
2. Parse YAML-like .assert.dbsp format
3. Handle "query: N" and "match: text" references
4. Validate assertion types

**Exit criteria:**
- [ ] Parser handles all assertion types
- [ ] Error messages include line numbers
- [ ] Unit tests pass

### Block 2: Assertion Runner — 45 min
**Type:** Feature slice
**Dependencies:** Block 1
**Files:**
- `packages/cli/src/repl/assertion-runner.ts` — new file

**Tasks:**
1. Match assertion blocks to query results
2. Run each assertion (contains, equals, matches, length)
3. Collect pass/fail results

**Exit criteria:**
- [ ] All assertion types implemented
- [ ] Unit tests for each type pass

### Block 3: CLI Integration — 30 min
**Type:** Feature slice
**Dependencies:** Block 1, Block 2
**Files:**
- `packages/cli/src/commands/repl.ts` — add --assert option
- `packages/cli/src/repl/batch.ts` — integrate assertion runner

**Tasks:**
1. Add --assert option
2. Validate --assert requires --input
3. Run assertions after queries
4. Format output (text and JSON)

**Exit criteria:**
- [ ] CLI help shows new option
- [ ] JSON output includes assertion results
- [ ] Exit code reflects assertion status

### Block 4: Example Assertions — 30 min
**Type:** Feature slice
**Dependencies:** Block 3
**Files:**
- `examples/test-blog.assert.dbsp` — new file
- `examples/test-minimal.assert.dbsp` — new file

**Tasks:**
1. Create assertions for existing .dbsp files
2. Verify against current REPL output
3. Document format in QUICKSTART.md

**Exit criteria:**
- [ ] Both assertion files pass
- [ ] Examples match QUICKSTART.md expected output

### Block 5: E2E Test & QUICKSTART Validation — 30 min
**Type:** Validation slice
**Dependencies:** Block 3, Block 4
**Files:**
- `tests/e2e/quickstart-examples.test.ts` — new file

**Tasks:**
1. Create E2E test that runs all example .dbsp files with their assertions
2. Validate QUICKSTART.md examples work as documented
3. Test multi-schema scenario (tenant isolation)

**Exit criteria:**
- [ ] E2E test passes in CI
- [ ] QUICKSTART.md examples validated
- [ ] Multi-schema assertions work

## 7. Test Strategy

### Test pyramid:

| Level | Count | Focus |
|-------|-------|-------|
| Unit | 12 | Parser, runner logic, normalization |
| Integration | 6 | CLI with files, error handling |
| E2E | 3 | Full workflow, multi-schema, QUICKSTART |

### Test data requirements:
- Fixtures: test-blog.dbsp (existing), test-blog.assert.dbsp (new)
- Mocks: None needed (uses real batch.ts)

### Test file location:
- `packages/cli/src/repl/assertion-parser.test.ts`
- `packages/cli/src/repl/assertion-runner.test.ts`
- `tests/e2e/quickstart-examples.test.ts`

## 8. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| YAML parsing complexity | M | L | Use simple line-based parsing, not full YAML |
| SQL normalization (whitespace) | M | M | Normalize whitespace in sql.equals comparisons |
| Breaking existing batch.ts | H | L | Add assertions as optional layer, don't modify existing code paths |
| Ambiguous query matching | M | L | Detect duplicates, require index when ambiguous (ERR-06) |

## 9. Definition of Done

- [ ] All blocks implemented (5 blocks)
- [ ] All BDD scenarios have passing tests (14 scenarios)
- [ ] All tests pass (unit + integration + e2e)
- [ ] Lint/typecheck pass
- [ ] examples/*.assert.dbsp files created and pass
- [ ] tests/e2e/quickstart-examples.test.ts passes
- [ ] QUICKSTART.md examples validated
- [ ] /review clean (no blocking findings)
