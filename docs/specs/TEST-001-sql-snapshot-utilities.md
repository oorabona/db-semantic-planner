---
doc-meta:
  status: canonical
  scope: testing
  type: specification
  created: 2026-01-07
  updated: 2026-01-07
---

# Specification: TEST-001 SQL Snapshot Testing Utilities

## 1. User Story

```
AS A developer working on db-semantic-planner
I WANT SQL snapshot testing utilities
SO THAT I can easily detect SQL generation regressions and maintain a reference of optimal queries
```

## 2. Business Rules

### BR-1: Snapshot Storage
- Snapshots stored as `.sql` files in `__snapshots__/` directory adjacent to test file
- Filename: `<test-file>.<test-name>.sql` (sanitized)
- UTF-8 encoding

### BR-2: SQL Normalization
- Collapse multiple whitespace to single space
- Trim leading/trailing whitespace per line
- Normalize line endings to `\n`
- Lowercase SQL keywords for comparison (but preserve original in snapshot)
- Keep parameter placeholders as-is ($1, $2, etc.)

### BR-3: Snapshot Lifecycle
- First run: Create snapshot file if missing
- Subsequent runs: Compare against existing snapshot
- Update mode: `UPDATE_SNAPSHOTS=true` env var overwrites existing

### BR-4: Failure Output
- Show diff between expected and actual SQL
- Include file path to snapshot for easy editing

## 3. Technical Design

### API

```typescript
// Custom Vitest matcher
expect(sql).toMatchSqlSnapshot(snapshotName?: string);

// Utility functions
function normalizeSql(sql: string): string;
function createSqlSnapshot(testPath: string, testName: string, sql: string): void;
function readSqlSnapshot(testPath: string, testName: string): string | null;
function compareSql(expected: string, actual: string): { match: boolean; diff?: string };
```

### File Structure

```
packages/adapter-kysely/
├── src/
│   └── test-utils/
│       ├── sql-snapshot.ts      # Core utilities
│       └── sql-snapshot.test.ts # Self-tests
└── __snapshots__/
    └── compiler.test/
        └── select-with-exists.sql
```

## 4. Acceptance Criteria

```gherkin
Scenario: Create new snapshot
  Given a test using toMatchSqlSnapshot()
  And no snapshot file exists
  When the test runs
  Then a .sql file is created with the SQL content
  And the test passes

Scenario: Match existing snapshot
  Given a test using toMatchSqlSnapshot()
  And a snapshot file exists with matching SQL
  When the test runs
  Then the test passes

Scenario: Detect SQL regression
  Given a test using toMatchSqlSnapshot()
  And a snapshot file exists
  And the generated SQL differs (after normalization)
  When the test runs
  Then the test fails with a diff

Scenario: Update snapshot
  Given UPDATE_SNAPSHOTS=true environment variable
  And the generated SQL differs from snapshot
  When the test runs
  Then the snapshot file is updated
  And the test passes

Scenario: Normalize whitespace differences
  Given SQL with different whitespace formatting
  And a snapshot with normalized SQL
  When comparing after normalization
  Then they match (whitespace ignored)
```

## 5. Implementation Plan

### Block 1: Core Utilities
- `normalizeSql()` function
- `readSqlSnapshot()` / `writeSqlSnapshot()` functions
- `compareSql()` with diff output

### Block 2: Vitest Matcher
- `toMatchSqlSnapshot()` custom matcher
- Vitest setup extension
- Export from index

### Block 3: Tests & Documentation
- Self-tests for utilities
- Example usage in existing tests
- Export from package

## 6. Test Strategy

| Scenario | Type |
|----------|------|
| Normalize whitespace | Unit |
| Create snapshot | Unit |
| Read snapshot | Unit |
| Compare match | Unit |
| Compare diff | Unit |
| Vitest integration | Integration |

---

## Definition of Done

- [ ] All blocks implemented
- [ ] All acceptance criteria have passing tests
- [ ] Exported from package index
- [ ] All tests pass
- [ ] Lint/typecheck pass
