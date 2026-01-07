# db-semantic-planner Backlog

## Epics

| Epic | Scope | Phase | Status |
|------|-------|-------|--------|
| ModelIR (Schema) | core | MVP | ✅ Complete |
| IntentAST (Query) | core | MVP | ✅ Complete |
| Semantic Planner | core | MVP | ✅ Complete |
| SQL Compiler | adapter | MVP | ✅ Complete |
| Kysely Engine | adapter | MVP | ✅ Complete |
| Multi-tenant (forTenant) | adapter | MVP | ✅ Complete |
| Observability (dump) | adapter | MVP | ✅ Complete |
| Enhanced Observability | adapter | P1 | ✅ Complete |
| Golden Tests (Q1, Q2, Q3) | testing | MVP | ✅ Complete |
| Strict Mode | dx | P1 | ✅ Complete |
| Compat Layer | dx | P1 | ✅ Complete |
| E2E PostgreSQL Validation | testing | P1 | ✅ Complete |
| Multi-dialect Capabilities | adapter | P2 | 🟡 In Progress |

## In Progress

### DIALECT-001: Multi-dialect Capabilities 🟡

**Spec:** [docs/specs/DIALECT-001-multi-dialect-capabilities.md](docs/specs/DIALECT-001-multi-dialect-capabilities.md)
**Backlog:** [TODO_ADAPTER.md](TODO_ADAPTER.md)

- [ ] 🟡 Block 1: DialectCapabilities interface and detection
- [ ] Block 2: Multi-tenant capability guard
- [ ] Block 3: EXPLAIN dialect adaptation
- [ ] Block 4: Streaming capability guard
- [ ] Block 5: Test helpers

### Golden Tests (MVP Contract) - ✅ COMPLETE

- [x] ✅ **Q1**: Filter to-many → EXISTS - 6 tests
  - Products with main image FR approved
  - Validates: filter-strategy = exists
  - SQL snapshot: SELECT ... WHERE EXISTS (...)
- [x] ✅ **Q2**: Coverage by category → CTE + ratio - 5 tests
  - Category coverage percentage
  - Validates: cte-extraction for alias reuse
  - SQL snapshot: WITH ... SELECT ... (CTE extraction)
- [x] ✅ **Q3**: Strict mode ambiguity - 7 tests
  - Include "posts" when multiple relations exist
  - Validates: AmbiguousPlanError thrown with options
  - Disambiguation via `via` hint and `disambiguate` option

## Pending - MVP (P0)

### Testing Setup

- [x] ✅ Vitest configuration (already configured)
- [x] ✅ Test fixtures (Product, Category, User, Post models)
- [ ] SQL snapshot testing utilities (optional enhancement)

## Pending - P1

### DX Package (`packages/dx`)

- [x] ✅ **DX-001**: Strict mode implementation (2026-01-07)
  - strictMode: true option
  - AmbiguousRelationError with options array
  - include({ via }) for disambiguation
  - 33 tests passing
- [x] ✅ **DX-002**: Override API (2026-01-07)
  - Per-query strictMode override: `query.withStrictMode(true)`
  - withRelationHint('target', 'relationName')
  - Global relation hints in OrmOptions
  - 21 tests passing
- [x] ✅ **DX-003**: Compat layer helpers (2026-01-07)
  - 14 filter helpers: eq, neq, gt, gte, lt, lte, like, isNull, isNotNull, inArray, and, or, not, exists, notExists
  - Execution: findMany(), findFirst(), findFirstOrThrow()
  - Multi-tenant: forTenant() for schema scoping
  - 106 tests passing

### Adapter Enhancements (P1)

- [x] ✅ **ADAPTER-004**: Enhanced Observability (2026-01-07)
  - explain() hook for EXPLAIN/ANALYZE
  - Structured logging with correlation IDs (formatDumpJson)
  - Parameter redaction for logs (redactParams)

## Pending - P2

### Multi-dialect Support (`packages/adapter-kysely`)

See **DIALECT-001** in "In Progress" section above.

### Additional Adapters

- [ ] Direct pg adapter (no Kysely) - TBD
- [ ] Drizzle adapter - TBD

### Query Features (P2)

- [x] ✅ NOT EXISTS filter strategy (2026-01-07) — Already implemented in DX-003 as `notExists()` helper
- [x] ✅ Aggregations support (COUNT, SUM, AVG, MIN, MAX) (2026-01-07)
  - Core: AggregateFunction, AggregateIntent, SelectAggregateIntent types, isSelectAggregate guard
  - Adapter: buildAggregateSelect, addAggregateExpression in compiler
  - DX: count(), sum(), avg(), min(), max() methods on QueryBuilder
  - 27 new tests across packages
- [x] ✅ GROUP BY support (2026-01-07)
  - Core: groupBy field on QueryIntent
  - Adapter: GROUP BY clause generation in compiler
  - DX: groupBy() method on QueryBuilder
  - 5 new tests
- [x] ✅ Streaming/cursor support (2026-01-07) — STREAMING-001
  - Adapter: streamQuery(), streamRawQuery(), supportsStreaming()
  - DX: stream() method on QueryBuilder with onStart callback
  - E2E: 14 streaming tests
  - Error classes: MissingDependencyError, UnsupportedOperationError

## Completed

### Core Package (`packages/core`)

- [x] ✅ **CORE-001**: ModelIR types ([spec](docs/specs/CORE-001-model-ir.md)) - 29 tests
- [x] ✅ **CORE-002**: IntentAST types - 35 tests
- [x] ✅ **CORE-003**: Semantic Planner ([spec](docs/specs/CORE-003-semantic-planner.md)) - 29 tests
  - EXISTS vs JOIN decision engine
  - CTE extraction logic
  - Ambiguity detection

### Adapter Package (`packages/adapter-kysely`)

- [x] ✅ **ADAPTER-001**: SQL Compiler + Dump API - 39 tests (now 59 with Q2)
  - `compile()`: PlanReport → Kysely CompiledQuery
  - `createDump()`: Intent → Dump (plan + sql + params + meta)
  - Deterministic aliasing (t0, t1, t2...)
  - EXISTS subquery for relation filters
  - Multi-tenant schema prefix support
  - Full WHERE clause compilation (comparison, like, in, null, and, or, not)
  - ORDER BY, LIMIT, OFFSET support
- [x] ✅ **ADAPTER-002**: Multi-tenant support (forTenant)
  - Schema prefix for all tables
  - Included in ADAPTER-001 implementation
- [x] ✅ **ADAPTER-003**: Observability (dump API)
  - `createDump()`, `createDumpFromPlan()`, `formatDump()`
  - Meta: tenant, queryName, correlationId, compiledAt
  - Included in ADAPTER-001 implementation
- [x] ✅ **ADAPTER-004**: Enhanced Observability (2026-01-07) - 40 tests
  - `explain()`: EXPLAIN/ANALYZE support (PostgreSQL)
  - `formatDumpJson()`, `toJsonDump()`: Structured JSON logging
  - `redactParams()`: Safe logging with sensitive data redaction

### Golden Tests (`packages/adapter-kysely`)

- [x] ✅ **GOLDEN-Q1**: Filter to-many → EXISTS - 6 tests
  - Products with FR main image approved
  - Validates EXISTS subquery generation
  - Tests schema prefix, cardinality detection
- [x] ✅ **GOLDEN-Q2**: CTE extraction → WITH clause - 5 tests
  - Categories with products (CTE extraction)
  - Validates WITH clause generation
  - Tests dump API with CTE options, schema prefix
- [x] ✅ **GOLDEN-Q3**: Strict mode ambiguity - 7 tests
  - AmbiguousPlanError with options array
  - Disambiguation via `via` hint
  - Disambiguation via PlanOptions.disambiguate

### E2E Testing (`tests/e2e/`)

- [x] ✅ **E2E-001**: Real-world PostgreSQL Validation (2026-01-07)
  - DX-004: dump()/execute() API on QueryBuilder
  - Testcontainers infrastructure with global setup/teardown
  - PIM/DAM schema + seed (acme, globex tenants)
  - Blog schema + seed
  - Q1-E2E: EXISTS filter validation - 7 tests (all pass)
  - Q2-E2E: CTE extraction validation - 8 tests (all pass)
  - Q4: Multi-tenant isolation - 9 tests
  - Q5: Blog scenario - 12 tests (all pass)
  - EXPLAIN integration - 12 tests
  - Performance benchmarks - 8 tests
  - Total: 73 passing (all .todo() tests enabled 2026-01-07)

## Fixed Issues

### ✅ EXISTS Schema Prefix (2026-01-07)

- **Issue:** EXISTS subqueries didn't include schema prefix in multi-tenant context
- **Impact:** Q1 tests now all pass (7/7)
- **Fix:** Modified compiler to pass `schemaName` through `compileWhere` → `compileExists` → `compileRelationFilter`

---

## Quick Reference

### Package Dependencies (STRICT)

```
packages/core          → (nothing)
packages/adapter-kysely → packages/core
packages/dx            → packages/core + packages/adapter-kysely
```

### MVP Non-Goals

- No cost-based optimization
- No join reordering
- No runtime schema introspection
- No NL-to-SQL
- No multi-dialect correctness (PostgreSQL only)
- No change tracking / dirty checking
