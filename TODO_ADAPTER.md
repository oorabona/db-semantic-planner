# Adapter Scope Backlog (`packages/adapter-kysely`)

**Package:** `packages/adapter-kysely`
**Phase:** MVP ✅ Complete, P1 (enhancements), P2 (multi-dialect)
**Dependencies:** `packages/core`, `kysely` (peer)

## Architecture Constraint

```
Imports from: packages/core (ModelIR, IntentAST, PlanReport)
MUST NOT import from: packages/dx
```

---

## In Progress

(none)

## Pending - P1

(none)

---

## Pending - P2

### Multi-dialect Capabilities

- [ ] DialectCapabilities interface
  - supportsCTE, supportsExplain, supportsWithSchema
  - supportsLateralJson, supportsTransactionalDdl
  - supportsReturning, supportsNullsFirstLast
- [ ] PostgreSQL capability profile (baseline)
  - All capabilities: true
- [ ] MySQL capability profile
  - supportsWithSchema: false (uses database switching)
  - supportsLateralJson: false
- [ ] SQLite capability profile
  - supportsWithSchema: false
  - supportsReturning: false (until 3.35)
- [ ] Capability-gated strategy selection
  - if (caps.supportsLateralJson) use lateral-json-agg
  - else use separate-queries
- [ ] Cross-dialect acceptance test suite

---

## Completed - MVP ✅

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
