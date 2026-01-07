---
doc-meta:
  status: canonical
  scope: adapter
  type: specification
  created: 2026-01-07
  updated: 2026-01-07
---

# Specification: ADAPTER-004 Enhanced Observability

## 1. User Stories

### US1: Query Plan Analysis
**AS A** developer debugging slow queries
**I WANT** to run EXPLAIN/ANALYZE on my queries
**SO THAT** I can understand PostgreSQL's execution plan and optimize performance

**ACCEPTANCE:** `explain()` returns structured PostgreSQL EXPLAIN output

### US2: Log Aggregation
**AS A** DevOps engineer
**I WANT** structured JSON logs with correlation IDs
**SO THAT** I can aggregate and search query logs in Datadog/ELK/etc.

**ACCEPTANCE:** `formatDumpJson()` returns parseable JSON with all relevant fields

### US3: Safe Logging
**AS A** security-conscious developer
**I WANT** parameter values redacted in logs
**SO THAT** sensitive data (passwords, PII) isn't exposed in log files

**ACCEPTANCE:** `redactParams()` replaces sensitive values with `[REDACTED]`

---

## 2. Business Rules

### EXPLAIN Support
- **BR1:** `explain()` MUST NOT execute the query (no side effects)
- **BR2:** `explain({ analyze: true })` MUST execute query and return actual timings
- **BR3:** `explain({ format: 'json' })` MUST request JSON format from PostgreSQL
- **BR4:** EXPLAIN options are PostgreSQL-specific (defer dialect abstraction to P2)

### Structured Logging
- **BR5:** `formatDumpJson()` MUST return valid JSON parseable by `JSON.parse()`
- **BR6:** JSON output MUST include: sql, params, meta (if present), decisions (summary)
- **BR7:** Correlation ID MUST propagate from CompileOptions through all output

### Parameter Redaction
- **BR8:** Redaction MUST replace value with literal string `[REDACTED]`
- **BR9:** Default redaction patterns: `password`, `secret`, `token`, `key`, `auth`, `credential`
- **BR10:** Redaction is based on field name hints, not value inspection
- **BR11:** Redaction MUST NOT modify original params array (return new array)

---

## 3. Technical Impact

| Layer | Changes | Validation |
|-------|---------|------------|
| packages/adapter-kysely/src/types.ts | Add ExplainOptions, ExplainResult, RedactionOptions | Type safety |
| packages/adapter-kysely/src/explain.ts | NEW - explain() function | Unit tests |
| packages/adapter-kysely/src/redact.ts | NEW - redactParams() function | Unit tests |
| packages/adapter-kysely/src/dump.ts | Add formatDumpJson(), update DumpMeta | Unit + integration |
| packages/adapter-kysely/src/index.ts | Export new functions and types | Import verification |

---

## 4. Acceptance Criteria (BDD Scenarios)

### Feature 1: EXPLAIN Support

#### Scenario 1.1: Basic EXPLAIN returns plan
```gherkin
Given a valid CompiledQuery for SELECT
When explain(compiled, db) is called
Then it returns ExplainResult with plan property
And query was NOT executed (no side effects)
```

#### Scenario 1.2: EXPLAIN ANALYZE returns execution stats
```gherkin
Given a valid CompiledQuery for SELECT
When explain(compiled, db, { analyze: true }) is called
Then it returns ExplainResult with plan and executionTime
And query WAS executed
```

#### Scenario 1.3: EXPLAIN with JSON format
```gherkin
Given a valid CompiledQuery
When explain(compiled, db, { format: 'json' }) is called
Then it returns ExplainResult with jsonPlan as parsed JSON
```

#### Scenario 1.4: EXPLAIN on invalid query throws
```gherkin
Given an invalid CompiledQuery (syntax error)
When explain(compiled, db) is called
Then it throws the PostgreSQL error
```

### Feature 2: Structured Logging

#### Scenario 2.1: formatDumpJson returns valid JSON
```gherkin
Given a Dump with plan, sql, params, meta
When formatDumpJson(dump) is called
Then result is valid JSON string
And JSON.parse(result) succeeds
```

#### Scenario 2.2: JSON includes all fields
```gherkin
Given a Dump with correlationId in meta
When formatDumpJson(dump) is called
Then JSON contains sql, params, correlationId, queryName, decisions
```

#### Scenario 2.3: JSON decisions are summarized
```gherkin
Given a Dump with 3 plan decisions
When formatDumpJson(dump) is called
Then JSON.decisions is array of {type, choice} objects
And full reasoning is NOT included (summary only)
```

#### Scenario 2.4: formatDumpJson with redaction option
```gherkin
Given a Dump with sensitive params
When formatDumpJson(dump, { redact: true }) is called
Then JSON.params contains redacted values
```

### Feature 3: Parameter Redaction

#### Scenario 3.1: redactParams with field hints
```gherkin
Given params = ['john@example.com', 'secret123', 42]
And fieldHints = ['email', 'password', 'userId']
When redactParams(params, fieldHints) is called
Then result = ['john@example.com', '[REDACTED]', 42]
And original params array is unchanged
```

#### Scenario 3.2: Default patterns auto-redact
```gherkin
Given params = ['value1', 'mytoken', 'value3']
And fieldHints = ['field1', 'api_token', 'field3']
When redactParams(params, fieldHints) is called with defaults
Then result = ['value1', '[REDACTED]', 'value3']
```

#### Scenario 3.3: Custom redaction patterns
```gherkin
Given params = ['sensitive']
And fieldHints = ['ssn']
And options = { patterns: ['ssn', 'dob'] }
When redactParams(params, fieldHints, options) is called
Then result = ['[REDACTED]']
```

#### Scenario 3.4: Empty params returns empty array
```gherkin
Given params = []
When redactParams(params, []) is called
Then result = []
```

#### Scenario 3.5: Case-insensitive pattern matching
```gherkin
Given params = ['secret']
And fieldHints = ['PASSWORD']
When redactParams(params, fieldHints) is called
Then result = ['[REDACTED]']
```

---

## 5. Implementation Plan

### Block 1: Types and Interfaces

**Package:** packages/adapter-kysely

**Files:**
- UPDATE `src/types.ts` - Add ExplainOptions, ExplainResult, RedactionOptions, JsonDump

**Tests:**
- Type-only, verified by TypeScript compilation

**Acceptance criteria covered:** Type definitions for all features

**Complexity:** S

### Block 2: Parameter Redaction

**Package:** packages/adapter-kysely

**Files:**
- CREATE `src/redact.ts` - redactParams() function
- UPDATE `src/index.ts` - Export redactParams

**Tests:**
- CREATE `src/redact.test.ts` - Scenarios 3.1-3.5

**Acceptance criteria covered:** 3.1, 3.2, 3.3, 3.4, 3.5

**Complexity:** S

### Block 3: Structured JSON Logging

**Package:** packages/adapter-kysely

**Files:**
- UPDATE `src/dump.ts` - Add formatDumpJson() function
- UPDATE `src/types.ts` - Add JsonDump interface (already in Block 1)
- UPDATE `src/index.ts` - Export formatDumpJson

**Tests:**
- UPDATE `src/dump.test.ts` - Scenarios 2.1-2.4

**Acceptance criteria covered:** 2.1, 2.2, 2.3, 2.4

**Complexity:** S

**Dependencies:** Block 2 (redaction)

### Block 4: EXPLAIN Support

**Package:** packages/adapter-kysely

**Files:**
- CREATE `src/explain.ts` - explain() function
- UPDATE `src/index.ts` - Export explain, ExplainOptions, ExplainResult

**Tests:**
- CREATE `src/explain.test.ts` - Scenarios 1.1-1.4

**Acceptance criteria covered:** 1.1, 1.2, 1.3, 1.4

**Complexity:** M (requires Kysely raw SQL, PostgreSQL-specific)

**Dependencies:** Block 1 (types)

---

## 6. Test Strategy

### Test Matrix

| Scenario | Unit | Integration |
|----------|------|-------------|
| 1.1 Basic EXPLAIN | Yes | Yes (needs DB) |
| 1.2 EXPLAIN ANALYZE | - | Yes (needs DB) |
| 1.3 EXPLAIN JSON format | - | Yes (needs DB) |
| 1.4 EXPLAIN error | Yes (mock) | Yes |
| 2.1 formatDumpJson valid | Yes | - |
| 2.2 JSON all fields | Yes | - |
| 2.3 JSON decisions | Yes | - |
| 2.4 JSON with redaction | Yes | - |
| 3.1-3.5 Redaction | Yes | - |

### Test Data Strategy

**Unit tests:** Mock Kysely db for explain, use fixture Dumps for JSON formatting

**Integration tests:** Use in-memory SQLite or test PostgreSQL for actual EXPLAIN execution. Note: SQLite EXPLAIN syntax differs, may need to skip or mock.

**Recommendation:** Unit tests with mocked Kysely for explain scenarios, pure unit tests for redaction and JSON formatting.

---

## Definition of Done

- [ ] All 4 blocks implemented
- [ ] All 13 BDD scenarios have passing tests
- [ ] All tests pass (target: ~72 adapter tests = 59 existing + 13 new)
- [ ] Lint/typecheck pass
- [ ] Exports added to index.ts
- [ ] TODO_ADAPTER.md updated

