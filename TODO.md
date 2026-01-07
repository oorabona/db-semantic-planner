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
| Golden Tests (Q1, Q2, Q3) | testing | MVP | :red_circle: Not started |
| Strict Mode | dx | P1 | :red_circle: Not started |
| Compat Layer | dx | P1 | :red_circle: Not started |
| Multi-dialect Capabilities | adapter | P2 | :red_circle: Not started |

## In Progress

(none)

## Pending - MVP (P0)

### Golden Tests (MVP Contract)

- [ ] :red_circle: [HIGH] **Q1**: Filter to-many → EXISTS
  - Products with main image FR approved
  - Validates: filter-strategy = exists
  - SQL snapshot: SELECT ... WHERE EXISTS (...)
- [ ] :red_circle: [HIGH] **Q2**: Coverage by category → CTE + ratio
  - Category coverage percentage
  - Validates: cte-extraction for alias reuse
  - SQL snapshot: WITH ... SELECT ... COUNT(DISTINCT ...) / NULLIF(...)
- [ ] :red_circle: [HIGH] **Q3**: Strict mode ambiguity
  - Include "posts" when multiple relations exist
  - Validates: AmbiguousRelationError thrown with options

### Testing Setup

- [ ] Vitest configuration
- [ ] Test fixtures (Product, Category, User, Post models)
- [ ] SQL snapshot testing utilities

## Pending - P1

### DX Package (`packages/dx`)

- [ ] **DX-001**: Strict mode implementation
  - strictMode: true option
  - AmbiguousRelationError with options array
  - Q3 golden test validation
- [ ] **DX-002**: Override API
  - include('x', { via: 'relationName' })
  - withRelationHint('Target', 'relationName')
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

- [x] ✅ **ADAPTER-001**: SQL Compiler + Dump API - 39 tests
  - `compile()`: PlanReport → Kysely CompiledQuery
  - `createDump()`: Intent → Dump (plan + sql + params + meta)
  - Deterministic aliasing (t0, t1, t2...)
  - EXISTS subquery for relation filters
  - Multi-tenant schema prefix support
  - Full WHERE clause compilation (comparison, like, in, null, and, or, not)
  - ORDER BY, LIMIT, OFFSET support

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
