# DEMO-E2E: Assertion System for .dbsp Files

## Overview

Enable automated validation of REPL queries by comparing actual output against expected results.

## Usage

```bash
# Run queries with assertions
pnpm dbsp repl --schema ./examples/blog.schema.ts \
  --input ./examples/test-blog.dbsp \
  --assert ./examples/test-blog.assert.dbsp \
  --format json
```

## Format: .dbsp File (Queries)

```
# Comments start with #
.tables
.schema posts
posts
posts where published = true
posts include author
posts select count(*) as total_posts
```

## Format: .assert.dbsp File (Assertions)

Each assertion block starts with `---` followed by the query index or query text.

```yaml
--- query: 0
# First query: .tables
output.contains: Tables (5)
output.contains: authors
output.contains: posts

--- query: 1
# Second query: .schema posts
output.contains: Table: posts
output.contains: id: integer

--- query: 3
# Fourth query: posts where published = true
sql.equals: select "t0".* from "posts" as "t0" where "t0"."published" = $1
params.equals: [true]

--- query: 4
# posts include author
sql.contains: left join "authors"
sql.contains: "author.id"
plan.contains: include-strategy: join

--- query: 5
# posts select count(*) as total_posts
sql.equals: select count(*) as "total_posts" from "posts" as "t0"
params.length: 0
```

## Assertion Types

| Assertion | Description |
|-----------|-------------|
| `output.contains: <text>` | Full output contains text |
| `output.equals: <text>` | Full output equals text (exact) |
| `output.matches: <regex>` | Full output matches regex |
| `sql.contains: <text>` | Generated SQL contains text |
| `sql.equals: <text>` | Generated SQL equals text (exact) |
| `sql.matches: <regex>` | Generated SQL matches regex |
| `params.equals: [...]` | Parameters match exactly (JSON) |
| `params.length: <n>` | Parameter count |
| `plan.contains: <text>` | Plan output contains text |
| `success: true/false` | Query should succeed/fail |
| `error.contains: <text>` | Error message contains text |

## Matching by Query Text

Can also match by query text instead of index:

```yaml
--- match: posts where published = true
sql.contains: where "t0"."published" = $1
params.equals: [true]

--- match: posts include author
sql.contains: left join "authors"
```

## Implementation

### 1. Parse .assert.dbsp

```typescript
interface QueryAssertion {
  queryIndex?: number;
  queryMatch?: string;
  assertions: Assertion[];
}

interface Assertion {
  type: 'output' | 'sql' | 'params' | 'plan' | 'success' | 'error';
  operator: 'contains' | 'equals' | 'matches' | 'length';
  value: string | number | boolean | unknown[];
}
```

### 2. Run Assertions

```typescript
function runAssertions(results: BatchResult[], assertions: QueryAssertion[]): AssertionResult[] {
  // Match each assertion to a query result
  // Run all assertions
  // Return pass/fail with details
}
```

### 3. Exit Code

- 0: All assertions pass
- 1: Any assertion fails (details in output)

## Example Output (JSON)

```json
{
  "summary": {
    "total": 6,
    "passed": 5,
    "failed": 1
  },
  "results": [
    {
      "query": "posts where published = true",
      "passed": true,
      "assertions": [
        { "type": "sql.contains", "expected": "where", "passed": true }
      ]
    },
    {
      "query": "posts include author",
      "passed": false,
      "assertions": [
        { "type": "sql.equals", "expected": "...", "actual": "...", "passed": false }
      ]
    }
  ]
}
```

## Rationale

1. **Separate files**: Queries remain clean, assertions are optional
2. **Multiple assertion types**: Flexible validation (exact, partial, regex)
3. **Index or text matching**: Query order can change, text match is more stable
4. **JSON output**: CI-friendly, parseable
5. **Backward compatible**: `--assert` is optional
