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

## Completed - Architecture

### ARCH-001: Dialect-Agnostic Recursive CTE - Adapter Changes ✅ (2026-01-08)

**Spec:** [docs/specs/ARCH-001-dialect-agnostic-recursive.md](docs/specs/ARCH-001-dialect-agnostic-recursive.md)
**Depends on:** ARCH-001 Core Block 1 ✅

- [x] ✅ Block 2: Add `supportsArrayType` capability to DialectCapabilities (2026-01-08)
  - Updated `dialect.ts` interface
  - Updated dialect profiles (PostgreSQL: true, others: false)
  - Added capability detection tests
- [x] ✅ Block 3: Implement PathTrackingCompiler with strategy selection (2026-01-08)
  - `resolvePathStrategy()` - infers strategy from capabilities
  - `compilePathTrackingBaseCase()` - ARRAY[] for PostgreSQL, CAST(x AS text) for others
  - `compilePathTrackingRecursive()` - array concat or string concat with separator
  - UnsupportedOperationError guard for array on non-PostgreSQL
- [x] ✅ Block 4: Integration tests for path tracking strategies (2026-01-08)
  - Array strategy on PostgreSQL (with PostgresKysely test factory)
  - String strategy on any dialect
  - Custom separator tests
  - Custom path alias tests
  - Edge-table traversal with path tracking
  - Backward compatibility (all existing tests pass)

**Results:**
- 6 new tests for path tracking strategies
- 282 total tests passing in adapter-kysely
- Path tracking now works on MySQL, SQLite, and MSSQL via string strategy

**Bug Fix (2026-01-09):**
- Fixed string strategy to use `sql.lit()` for inline separator literals (was using parameterized `?`)
- Moved PostgreSQL array test to E2E (`tests/e2e/iam.recursive.test.ts`) - SQLite doesn't support ARRAY[]
- 343 total tests in adapter-kysely (1 todo for PostgreSQL array test documented in E2E)

---

## Completed - P2 Features

### ADAPTER-006: Schema Introspection ✅ (2026-01-08)

**Spec:** [docs/specs/ADAPTER-006-schema-introspection.md](docs/specs/ADAPTER-006-schema-introspection.md)

Auto-infer ModelIR from database via Kysely introspection with automatic hierarchy detection.

- [x] ✅ Block 1: Core Introspection (2026-01-08)
  - `introspect(db, options?)` function
  - TableMetadata → TableIR mapping
  - Column type mapping (varchar→string, int→number, etc.)
  - Primary key detection (auto-increment columns)
  - Table filtering (exclude/include glob patterns)
- [x] ✅ Block 2: Relation Inference (2026-01-08)
  - FK → belongsTo relation (owner → target)
  - FK → hasMany relation (target → owner)
  - camelCase/snake_case naming options
  - Composite FK support
- [x] ✅ Block 3: Hierarchy Detection (2026-01-08)
  - Adjacency pattern (self-referential FK)
  - Edge-table pattern (2 FKs to same target)
  - DetectedHierarchy metadata
- [x] ✅ Block 4: Integration & Export (2026-01-08)
  - IntrospectedModelIR interface (extends ModelIR)
  - hierarchies, introspectedAt, warnings properties
  - Export from index.ts

**Results:**
- 49 new tests in introspection.test.ts
- 336 total tests passing in adapter-kysely
- PostgreSQL information_schema FK query
- `_foreignKeysForTesting` option for dependency injection

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

## Completed - Tech Debt

### REFACTOR-001: Replace raw SQL with Kysely Expression Builder ✅ (2026-01-08)

**Priority:** HIGH (architectural debt)
**Discovered:** 2026-01-08 (Security Audit)
**Scope:** `packages/adapter-kysely/src/compiler.ts`

**Problem:** Recursive CTE used `sql` template tag (raw SQL) instead of Kysely's type-safe expression builder API.

**Remaining raw SQL (irreducible):**
```typescript
// compiler.ts:289 - ARRAY literal (no Kysely equivalent)
sql`ARRAY[${sql.ref('col')}]`

// compiler.ts:794 - Raw expression kind (intentional escape hatch)
sql`${sql.raw(expr.sql)}`
```

**Refactored to Kysely API:**
```typescript
// Array concat - now uses eb() binary expression (compiler.ts:405, 507)
eb(eb.ref('prev.path'), '||', eb.ref('node.${traversal.nodeId}')).as('path')
```

**Tasks:**
- [x] ✅ Refactor array concatenation to use `eb(a, '||', b)` (2026-01-08)
- [x] ⏭️ ANY check: Not needed (never implemented, deferred to future cycle detection)
- [x] ✅ Document that ARRAY literal still requires sql template (2026-01-08)

**Results:**
- Raw SQL reduced from 3 operations to 2 (ARRAY literal + raw escape hatch)
- Array concatenation now uses type-safe Kysely expression builder
- All 553 tests pass - behavior unchanged
- Typecheck and lint pass

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
