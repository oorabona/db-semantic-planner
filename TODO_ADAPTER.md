# Adapter Scope Backlog (`packages/adapter-kysely`)

**Package:** `packages/adapter-kysely`
**Phase:** MVP ✅ Complete, P1 ✅ Complete, P2 ✅ Complete
**Dependencies:** `packages/core`, `kysely` (peer)

## Architecture Constraint

```
Imports from: packages/core (ModelIR, IntentAST, PlanReport)
MUST NOT import from: packages/dx
```

---

## In Progress

### RFC-001: Recursive CTE Support - MVP ✅ (2026-01-08)

**RFC:** [RFC-001-recursive-cte.md](docs/rfcs/RFC-001-recursive-cte.md)
**Use case:** IAM/RBAC role hierarchy, category trees, org charts

- [x] ✅ Block 3: Compiler using Kysely native `withRecursive()` + CTE orchestration (2026-01-08)
  - `compileRecursive()` function in compiler.ts
  - Handles UNION vs UNION ALL based on bidirectional-edges decision
  - `buildRecursiveBaseCase()` for anchor query with depth=0, path array
  - `buildAdjacencyRecursiveStep()` for self-referential traversal
  - `buildEdgeTableRecursiveStep()` for edge-table traversal
  - Native Kysely expressions for arithmetic (`eb(left, '+', eb.lit(1))`)
  - Dedupe:'final' with DISTINCT ON
  - Emit filters (where, orderBy) support
- [x] ✅ Block 4: Unit tests for recursive CTE compilation (2026-01-08) - 9 tests

**Deferred to P2:**
- [ ] Block 5: DX API (`orm.query().withRecursive()`)
- [ ] Block 6: E2E tests with real PostgreSQL

**Test Gaps (NON-BLOCKING, deferred):**
- [ ] F-004: Add test for `dedupe: 'global'` strategy (M)
- [ ] F-005: Add test for `ancestors` direction (M)

---

## Pending - P3 (Advanced PostgreSQL Features)

**Study:** [STUDY-001-advanced-postgresql-features.md](docs/studies/STUDY-001-advanced-postgresql-features.md)

### Future P3 Features (pending RFCs)

- [ ] Window Functions (FinTech running balance) - `OverIntent`
- [ ] Range Types (Booking/Scheduling) - PostgreSQL-specific
- [ ] FOR UPDATE SKIP LOCKED (Job Queue) - `LockIntent`
- [ ] Full-text Search (tsvector) - PostgreSQL-specific

---

## Completed - MVP ✅

### DIALECT-001: Multi-dialect Capabilities - 90 new tests ✅ (2026-01-07)

**Spec:** [docs/specs/DIALECT-001-multi-dialect-capabilities.md](docs/specs/DIALECT-001-multi-dialect-capabilities.md)

- [x] ✅ Block 1: DialectCapabilities interface and detection
  - DialectCapabilities interface
  - DialectName type
  - detectDialect(), getCapabilities() functions
  - Predefined profiles (PostgreSQL, MySQL, SQLite, MSSQL, Unknown)
  - 42 tests
- [x] ✅ Block 2: Multi-tenant capability guard
  - assertCapability() helper function
  - UnsupportedOperationError with capability/dialect context
  - Default guidance messages per capability/dialect
  - 14 new tests
- [x] ✅ Block 3: EXPLAIN dialect adaptation
  - PostgreSQL: EXPLAIN (FORMAT JSON)
  - MySQL: EXPLAIN FORMAT=JSON syntax
  - SQLite: EXPLAIN QUERY PLAN
  - 10 new tests
- [x] ✅ Block 4: Streaming capability guard
  - supportsStreaming() uses dialect capabilities
  - assertStreamingSupported() function
  - Dialect-specific guidance (MySQL, SQLite, MSSQL, unknown)
  - 12 new tests
- [x] ✅ Block 5: Test helpers
  - getDialectName() for display in tests
  - skipIfMissingCapability() for conditional test skipping
  - withMockedCapabilities() for mock db creation
  - 12 new tests

### STREAMING-001: Cursor/Streaming Support - 20 adapter tests ✅ (2026-01-07)

**Spec:** [docs/specs/STREAMING-001-cursor-support.md](docs/specs/STREAMING-001-cursor-support.md)

- [x] ✅ `streamQuery()` function for row-by-row iteration
  - AsyncIterableIterator return type
  - onStart callback for observability
  - chunkSize option (for future cursor support)
- [x] ✅ `streamRawQuery()` helper function
- [x] ✅ `supportsStreaming()` capability check
- [x] ✅ Error classes:
  - MissingDependencyError (for pg-cursor)
  - UnsupportedOperationError (for unsupported dialects)
- [x] ✅ Export from index.ts

### ADAPTER-005: Aggregates and GROUP BY - 14 new tests ✅ (2026-01-07)

- [x] ✅ Aggregate SELECT expressions (COUNT, SUM, AVG, MIN, MAX)
  - COUNT(*) and COUNT(field) support
  - Automatic alias generation (e.g., count_email)
  - Custom alias via `as` parameter
- [x] ✅ GROUP BY clause generation
  - Single and multiple field grouping
  - Proper alias prefix (t0.field)
  - Schema prefix support for multi-tenant

### ADAPTER-004: Enhanced Observability - 40 tests ✅ (2026-01-07)

**Spec:** [docs/specs/ADAPTER-004-enhanced-observability.md](docs/specs/ADAPTER-004-enhanced-observability.md)

- [x] ✅ `explain()` method for EXPLAIN/ANALYZE (PostgreSQL)
  - ExplainOptions: analyze, format, costs, buffers, timing
  - ExplainResult: plan, jsonPlan?, executionTime?
- [x] ✅ `formatDumpJson()` for structured JSON logging
  - Correlation ID propagation
  - Datadog/ELK-ready format
- [x] ✅ `toJsonDump()` for programmatic JSON access
- [x] ✅ `redactParams()` for safe logging
  - DEFAULT_REDACTION_PATTERNS: password, secret, token, key, auth, credential, api_key, apikey, private
  - additionalPatterns, whitelist options
  - Case-insensitive matching

### ADAPTER-001: Compile/Dump API - 59 tests

- [x] ✅ Dump interface
  - plan: PlanReport
  - sql: string (from Kysely CompiledQuery.sql)
  - params: readonly unknown[] (from Kysely CompiledQuery.parameters)
  - meta?: DumpMeta
- [x] ✅ DumpMeta interface
  - tenant?, queryName?, correlationId?, compiledAt?
- [x] ✅ compile() function
  - PlanReport → Kysely CompiledQuery
- [x] ✅ createDump() function
  - QueryIntent → Dump (plan + sql + params)
- [x] ✅ createDumpFromPlan() function
- [x] ✅ formatDump() function
- [x] ✅ Deterministic output
  - Stable SQL (same intent → same SQL)
  - Consistent aliasing: t0, t1, t2...

### ADAPTER-002: Multi-tenant

- [x] ✅ Schema prefix support via `tenant` option
- [x] ✅ All tables prefixed with schema name
- [x] ✅ EXISTS subqueries include schema prefix

### ADAPTER-003: SQL Compilation

- [x] ✅ PlanReport → Kysely query builder
- [x] ✅ SELECT clause generation (all fields, specific fields)
- [x] ✅ FROM clause with alias (t0)
- [x] ✅ WHERE clause from WhereIntent
  - comparison (eq, neq, gt, gte, lt, lte)
  - like, in, null (isNull, isNotNull)
  - and, or, not
  - EXISTS subquery generation
  - relationFilter (some, every, none)
- [x] ✅ CTE generation (WITH clause)
  - buildCTEs() before main query
  - Schema prefix in CTE target tables
- [x] ✅ ORDER BY generation
- [x] ✅ LIMIT/OFFSET generation

### Golden Tests

- [x] ✅ Q1: EXISTS subquery - 6 tests
- [x] ✅ Q2: CTE extraction - 5 tests
- [x] ✅ Q3: Ambiguity detection - 7 tests (shared with core)

---

## Blocked / Deferred

- [x] ✅ QueryBuilder.execute() → Moved to DX package (DX-003)
- [x] ✅ Streaming/cursor support → STREAMING-001 (2026-01-07)

---

## Golden Tests Owned by Adapter

| Test | Component | Status | Tests |
|------|-----------|--------|-------|
| Q1 | EXISTS subquery | ✅ | 6 |
| Q2 | CTE + WITH clause | ✅ | 5 |
| Q3 | Ambiguity (shared) | ✅ | 7 |

## Kysely Plugin Gotcha

If implementing plugins with state:

```typescript
// BAD: Memory leak
const stateMap = new Map<string, State>();

// GOOD: Auto-cleanup
const stateMap = new WeakMap<object, State>();
```

## Open Questions

- [x] Transaction boundary handling? → **Defer to Kysely (user manages)**
- [x] Connection pooling? → **Defer to Kysely**
- [x] Streaming/cursor support? → **STREAMING-001 ✅ (2026-01-07)**
