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
| Golden Tests (Q1, Q2, Q3) | testing | MVP | ✅ Complete |
| Strict Mode | dx | P1 | ✅ Complete |
| Compat Layer | dx | P1 | :red_circle: Not started |
| Multi-dialect Capabilities | adapter | P2 | :red_circle: Not started |

## In Progress

(none)

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
- [ ] **DX-003**: Compat layer helpers
  - eq(), and(), or(), gt(), lt(), like(), isNull(), inArray()
  - findMany(), findFirst(), findFirstOrThrow()

### Adapter Enhancements (P1)

- [ ] explain() hook for EXPLAIN/ANALYZE
- [ ] Structured logging with correlation IDs
- [ ] Parameter redaction for logs (dump.meta.redactedParams)

## Pending - P2

### Multi-dialect Support (`packages/adapter-kysely`)

- [ ] DialectCapabilities interface
- [ ] PostgreSQL capability profile (baseline)
- [ ] MySQL capability profile
- [ ] SQLite capability profile
- [ ] Capability-gated strategy selection
- [ ] Cross-dialect acceptance test suite

### Additional Adapters

- [ ] Direct pg adapter (no Kysely) - TBD
- [ ] Drizzle adapter - TBD

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

## Blocked / Deferred

(none)

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
