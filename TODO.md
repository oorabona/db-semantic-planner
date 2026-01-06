# db-semantic-planner Backlog

## Epics

| Epic | Scope | Phase | Status |
|------|-------|-------|--------|
| ModelIR (Schema) | core | MVP | :red_circle: Not started |
| IntentAST (Query) | core | MVP | :red_circle: Not started |
| Semantic Planner | core | MVP | :red_circle: Not started |
| SQL Compiler | adapter | MVP | :red_circle: Not started |
| Kysely Engine | adapter | MVP | :red_circle: Not started |
| Multi-tenant (forTenant) | adapter | MVP | :red_circle: Not started |
| Observability (dump) | adapter | MVP | :red_circle: Not started |
| Golden Tests (Q1, Q2, Q3) | testing | MVP | :red_circle: Not started |
| Strict Mode | dx | P1 | :red_circle: Not started |
| Compat Layer | dx | P1 | :red_circle: Not started |
| Multi-dialect Capabilities | adapter | P2 | :red_circle: Not started |

## In Progress

(none)

## Pending - MVP (P0)

### Core Package (`packages/core`)

- [ ] :red_circle: [HIGH] **CORE-001**: Implement ModelIR types ([spec](docs/specs/CORE-001-model-ir.md))
  - TableIR, ColumnIR, ForeignKeyIR, RelationIR
  - Planning hints: cardinality, optionality, includeStrategy, filterStrategy, joinDefault
- [ ] :red_circle: [HIGH] **CORE-002**: Implement IntentAST types
  - QueryIntent, SelectIntent, IncludeIntent, WhereIntent
  - exists() filter for Q1 golden test
- [ ] :red_circle: [HIGH] **CORE-003**: Implement Semantic Planner
  - EXISTS vs JOIN decision engine (default: EXISTS for to-many)
  - LEFT vs INNER join inference
  - CTE extraction for Q2 golden test
  - PlanReport with decisions + warnings

### Adapter Package (`packages/adapter-kysely`)

- [ ] :red_circle: [HIGH] **ADAPTER-001**: Implement compile/dump/execute ([spec](docs/specs/ADAPTER-001-kysely-dump-compile-execute.md))
  - Dump type: { plan, sql, params, meta }
  - Uses Kysely .compile() for SQL + params
  - Deterministic aliasing (t0, t1, t2...)
- [ ] :red_circle: [HIGH] **ADAPTER-002**: Implement multi-tenant
  - orm.forTenant(schemaName) API
  - Schema name validation (identifier allow-list)
  - Uses Kysely db.withSchema()
- [ ] **ADAPTER-003**: Implement SQL compilation
  - PlanReport → Kysely query builder
  - Parameter binding
  - PostgreSQL dialect (MVP)

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

(none)

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
