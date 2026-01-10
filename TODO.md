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
| Multi-dialect Capabilities | adapter | P2 | ✅ Complete |

## In Progress

(none)

## Recently Completed

### CORE-002-B: M:N Through Table Support ✅ (2026-01-10)

**Scope:** core, adapter-kysely
**Spec:** [docs/plans/CORE-002-B-mn-through-table.md](docs/plans/CORE-002-B-mn-through-table.md)

Implemented M:N (many-to-many) relation support via junction tables:

- [x] ✅ Block 1: Add otherKey to RelationIR (2026-01-10)
- [x] ✅ Block 2: M:N filter with JOIN - two INNER JOINs pattern (2026-01-10)
- [x] ✅ Block 3: M:N filter with EXISTS - EXISTS with junction JOIN (2026-01-10)
- [x] ✅ Block 4: M:N include with JOIN - two LEFT JOINs pattern (2026-01-10)
- [x] ✅ Block 5: Q7 golden tests (6 tests) (2026-01-10)

**Key features:**
- `belongsToMany('target', { through, foreignKey, otherKey })`
- Two-JOIN pattern: `source → junction → target`
- FK inference: `{source}Id` and `{target}Id` defaults
- Multi-tenant schema prefix on all 3 tables
- Custom FK names support

**Files changed:** 6 (core: 3, adapter: 2, spec: 1)
**Tests:** 1010 passing (7 new tests: 6 Q7 + 1 core)

### CORE-002: Relation Resolution Correctness ✅ (2026-01-09)

**Scope:** adapter-kysely
**Spec:** [docs/plans/CORE-002-relation-resolution-correctness.md](docs/plans/CORE-002-relation-resolution-correctness.md)

Fixed FK direction in `applyJoinFilters` and `compileExists` for belongsTo relations:

- [x] ✅ Block 1: Fix applyJoinFilters FK direction (2026-01-09)
- [x] ✅ Block 2: Fix compileExists FK direction (2026-01-09)
- [x] ✅ Block 3: Add Q6 FK direction verification tests (2026-01-09)
- [x] ✅ Block 4: Regression tests pass (2026-01-09)

**Key fixes:**
- belongsTo: `source.foreignKey = target.primaryKey` (e.g., `posts.authorId = users.id`)
- hasMany: `target.foreignKey = source.primaryKey` (e.g., `posts.userId = users.id`)
- 6 new Q6 tests verifying FK direction for JOIN, EXISTS, and include

**Tests:** 402 tests passing (6 new Q6 tests + 396 existing)

### CORE-001: Planner → Compiler Contract Enforcement ✅ (2026-01-09)

**Scope:** core, adapter-kysely
**Spec:** [docs/plans/CORE-001-planner-compiler-contract.md](docs/plans/CORE-001-planner-compiler-contract.md)

Ensures compiler respects planner's strategy decisions:

- [x] ✅ Block 1: JOIN filter implementation (compileJoinFilter) (2026-01-09)
- [x] ✅ Block 2: Integration tests for filter-strategy contract (2026-01-09)
- [x] ✅ Block 3: Include JOIN implementation (compileIncludeJoin) (2026-01-09)
- [x] ✅ Block 4: Include separate implementation (separateIncludes API) (2026-01-09)
- [x] ✅ Block 5: Golden tests Q4/Q5 + E2E updates (2026-01-09)

**Key deliverables:**
- `filter-strategy: 'join'` → SQL with JOIN (belongsTo default)
- `filter-strategy: 'exists'` → SQL with EXISTS (hasMany default)
- `include-strategy: 'join'` → LEFT JOIN with column selection
- `include-strategy: 'separate'` → `compileWithIncludes()` returns `{ main, separateIncludes }`
- 7 BDD scenarios with passing tests

### API-001: API Rename for SQL Verb Consistency ✅ (2026-01-09)

**Scope:** dx, adapter-kysely, core, e2e
**Breaking change:** Yes (required before v1.0)

Renamed API methods for SQL verb consistency:
- [x] ✅ `query()` → `select()` (ORM entry point)
- [x] ✅ `.select()` → `.columns()` (column selection)
- [x] ✅ `findMany()` → `all()`
- [x] ✅ `findFirst()` → `first()`
- [x] ✅ `findFirstOrThrow()` → `firstOrThrow()`
- [x] ✅ `selectWithExpressions()` → `columnsWithExpressions()`

**Files changed:** 36 (21 source + 15 E2E tests)
**Tests:** 887 unit + 212 E2E all passing

### P3-A: Window Functions ✅ (2026-01-09)

**Spec:** [docs/specs/P3-A-window-functions.md](docs/specs/P3-A-window-functions.md)
**Backlog:** [TODO_DX.md](TODO_DX.md)

Window function support across all packages for analytics queries.

- [x] ✅ Core: WindowIntent type, WindowFunction union, isWindowIntent guard
- [x] ✅ Adapter: DialectCapabilities.supportsWindowFunctions, compileWindowSelect()
- [x] ✅ DX: window() method on QueryBuilder with immutable chaining
- [x] ✅ 40 tests (8 core + 17 adapter + 15 dx)

**Functions supported:** row_number, rank, dense_rank, sum, avg, count, min, max, lag, lead

### DIALECT-001: Multi-dialect Capabilities ✅ (2026-01-07)

**Spec:** [docs/specs/DIALECT-001-multi-dialect-capabilities.md](docs/specs/DIALECT-001-multi-dialect-capabilities.md)
**Backlog:** [TODO_ADAPTER.md](TODO_ADAPTER.md)

- [x] ✅ Block 1: DialectCapabilities interface and detection (42 tests)
- [x] ✅ Block 2: Multi-tenant capability guard (14 tests)
- [x] ✅ Block 3: EXPLAIN dialect adaptation (10 tests)
- [x] ✅ Block 4: Streaming capability guard (12 tests)
- [x] ✅ Block 5: Test helpers (12 tests)

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

## Pending - MVP (P0) — BLOCKING before v1.0

### CORE-002: Relation Resolution Correctness ✅ (2026-01-09)

**See:** Recently Completed section above.

**Completed in CORE-002-B:**
- [x] ✅ M:N via through table support (2026-01-10)

---

### CORE-003: Edge Cases & Plan Coherence 🟡

**Priority:** P1 HIGH | **Effort:** S | **Scope:** core, adapter-kysely

**Problèmes identifiés :**
- [ ] CTE naming : garantir unicité des noms
- [ ] IN/AND/OR vides : comportement défini (erreur ou no-op ?)
- [ ] Path separator : cohérence dans les chemins de relation
- [ ] Metadata d'ambiguïté : exposer dans le plan
- [ ] Side-effects : supprimer console.warn (pollution tests)

---

### Testing Setup

- [x] ✅ Vitest configuration (already configured)
- [x] ✅ Test fixtures (Product, Category, User, Post models)
- [x] ✅ SQL snapshot testing utilities (2026-01-07) — TEST-001
  - `normalizeSql()` for whitespace-insensitive comparison
  - `toMatchSqlSnapshot()` custom Vitest matcher
  - `toMatchSql()` for inline SQL comparison
  - Snapshot storage in `__snapshots__/*.sql` files
  - 37 new tests

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

### Documentation (DX critical)

- [ ] **DOCS-001**: User documentation (Getting Started, API Guide)
  - Getting Started guide (installation, first query)
  - API reference (select, insert, update, delete, recursive, window)
  - Migration guide from Prisma/Drizzle
  - Multi-tenant setup guide
  - Best practices and patterns
- [ ] **DOCS-002**: Interactive examples (playground or REPL)

### API Refinement (Breaking changes - do before v1.0)

- [x] ✅ **API-001**: Rename query() → select() for SQL verb consistency (2026-01-09)
  - Rename `.select()` → `.columns()` to avoid collision
  - Rename `findFirst()` → `first()`
  - Rename `findMany()` → `all()`
  - Rename `findFirstOrThrow()` → `firstOrThrow()`
  - Rename `selectWithExpressions()` → `columnsWithExpressions()`

### DX API Improvements (P2) — See TODO_DX.md for details

| ID | Feature | Priority | Effort | Breaking |
|----|---------|----------|--------|----------|
| DX-020 | ✅ Unified `columns()` API (2026-01-09) | HIGH | M | Yes |
| DX-021 | Window functions builder pattern | MEDIUM | M | Yes |
| DX-022 | Recursive via `include({ recursive: true })` | HIGH | L | Yes |
| DX-023 | Lightweight ModelIR (relations-only) | MEDIUM | L | No |
| DX-024 | ✅ `orderBy()` shorthand (polymorphic) (2026-01-09) | HIGH | S | No |
| DX-025 | `orm.transaction()` wrapper (passthrough) | HIGH | M | No |
| DX-026 | `upsert()` + `returning()` support | HIGH | M | No |
| DX-027 | Raw SQL escape hatch (`raw`, `orm.raw`) | HIGH | S | No |
| DX-028 | Pagination helpers (offset + cursor) | MEDIUM | S | No |

**Breaking changes summary:**
- ✅ DX-020: Remove `columnsWithExpressions()`, use `columns()` unified (DONE 2026-01-09)
- DX-021: Remove `.window([...])` object syntax, use builder pattern
- DX-022: Remove `createRecursiveQuery()`, use `include({ recursive: true })`

**Architecture principle:**
- Passthrough, pas réimplémentation : on expose ce que l'adapter supporte
- Si Kysely/Drizzle ne supporte pas → erreur de l'adapter, pas de hack

### Multi-dialect Support (`packages/adapter-kysely`)

See **DIALECT-001** in "In Progress" section above.

### Additional Adapters

- [ ] Drizzle adapter - TBD (uses same Typed Intents, different compilation)
- [ ] Prisma adapter - TBD (uses same Typed Intents, different compilation)
- [x] ⏭️ Direct pg adapter - **SUPERSEDED** by ADR-001 (Typed Intents use each ORM's raw escape hatch)

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
