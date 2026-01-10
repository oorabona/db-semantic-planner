# db-semantic-planner Backlog

## Epics

| Epic | Scope | Status |
|------|-------|--------|
| ModelIR (Schema) | core | ✅ Complete |
| IntentAST (Query) | core | ✅ Complete |
| Semantic Planner | core | ✅ Complete |
| SQL Compiler | adapter | ✅ Complete |
| Kysely Engine | adapter | ✅ Complete |
| Multi-tenant (forTenant) | adapter | ✅ Complete |
| Observability (dump) | adapter | ✅ Complete |
| Enhanced Observability | adapter | ✅ Complete |
| Golden Tests (Q1, Q2, Q3) | testing | ✅ Complete |
| Strict Mode | core/dx | ✅ Complete |
| Compat Layer | core/dx | ✅ Complete |
| E2E PostgreSQL Validation | testing | ✅ Complete |
| Multi-dialect Capabilities | adapter | ✅ Complete |
| DX Layer in Core (ARCH-001) | core | ✅ Complete |
| One Ring Codegen-First (ARCH-002) | schema, cli, core | ✅ Complete |

## In Progress

(No tasks in progress)

---

## ✅ Completed: ARCH-002 v2 "One Ring" Codegen-First Architecture (2026-01-11)

**Brief:** [docs/briefs/ARCH-002-one-ring.md](docs/briefs/ARCH-002-one-ring.md)  
**Spec:** [docs/specs/ARCH-002-one-ring.md](docs/specs/ARCH-002-one-ring.md)  
**Priority:** HIGH | **Effort:** L | **Breaking:** Yes (new package structure)

Transform db-semantic-planner into a **codegen-first schema platform**:
- `dbsp.schema.ts` = Source of Truth (SoT)
- CLI generates typed adapters (Kysely, Drizzle, etc.)
- Zero runtime introspection in production
- Core becomes internal (private: true)

### MVP Blocks

| # | Block | Effort | Status |
|---|-------|--------|--------|
| 1 | Schema DSL (`defineSchema`) | M | ✅ Done (2026-01-10) |
| 2 | Convention Inference (FK + M:N detection) | S | ✅ Done (2026-01-10) |
| 3 | CLI Scaffold (`dbsp` binary) | S | ✅ Done (2026-01-10) |
| 4 | `dbsp generate manifest` | M | ✅ Done (2026-01-10) |
| 5 | `dbsp generate kysely` | M | ✅ Done (2026-01-10) |
| 6 | Schema Bridge (GeneratedSchema → ModelIR) | M | ✅ Done (2026-01-11) |
| 7 | `dbsp verify` (drift detection) | M | ✅ Done (2026-01-11) |
| 8 | Run all tests (1186 passing) | L | ✅ Done (2026-01-11) |

### Completed Implementation Details

**Block 1+2: packages/schema (54 tests)**
- `defineSchema()` with tables, relations, hints, conventions
- Discriminated union for relations: `kind: 'belongsTo' | 'hasMany' | 'manyToMany'`
- FK detection with explicit `references` priority over conventions
- M:N auto-detection for pure junction tables
- Type guards: `isBelongsTo()`, `isHasMany()`, `isManyToMany()`

**Block 3+4+5: packages/cli (35 tests)**
- `dbsp generate manifest` — generates JSON-serializable schema
- `dbsp generate kysely` — generates DB interface + table types
- Kysely idioms: `Generated<T>`, `ColumnType<S,I,U>`
- Schema loader with tsx support for .ts files

**Block 6: Schema Bridge (packages/core - 18 tests)**
- `buildModelFromSchema()` — converts GeneratedSchema to ModelIR
- Primary key inference: `id` column or explicit `.primaryKey()` hint
- Foreign key extraction from relations with `belongsTo` kind
- Type mapping: `serial`, `bigserial`, `uuid` → appropriate types

**Block 7: `dbsp verify` (drift detection)**
- Schema vs database drift detection
- Compares tables, columns, types
- JSON output option for CI/CD integration

**Block 8: Full test suite validation**
- All 1186 tests passing across 4 packages:
  - schema: 54 tests
  - core: 494 tests
  - adapter-kysely: 603 tests (5 skipped)
  - cli: 35 tests

### Future Blocks (Post-MVP)

| # | Block | Description |
|---|-------|-------------|
| 9 | `dbsp import drizzle` | Import Drizzle schema to SoT |
| 10 | `dbsp import prisma` | Import Prisma schema to SoT |
| 11 | `dbsp import db` | Introspect DB to bootstrap SoT |
| 12 | `dbsp generate drizzle` | Generate Drizzle schema from SoT |
| 13 | Prisma adapter | Compile to `$queryRaw(Prisma.sql)` |

### Future Native Adapters (Long-term)

- [ ] `db-semantic-planner/pgsql` — Native PostgreSQL (information_schema)
- [ ] `db-semantic-planner/mysql` — Native MySQL
- [ ] `db-semantic-planner/sqlite` — Native SQLite

## Recently Completed

### ARCH-001: Merge dx + core for Adapter-Agnostic Architecture ✅ (2026-01-10)

**Scope:** core, dx, adapter-kysely
**ADR:** [docs/adrs/ADR-002-merge-dx-into-core.md](docs/adrs/ADR-002-merge-dx-into-core.md)
**Spec:** [docs/plans/ARCH-001-merge-dx-core.md](docs/plans/ARCH-001-merge-dx-core.md)

Merged `packages/dx` into `packages/core` to enable true multi-adapter support:

- [x] ✅ Block 1: Create AdapterInterface in core (2026-01-10)
- [x] ✅ Block 2: Move dx source files to core/src/dx/ (2026-01-10)
- [x] ✅ Block 3: Move dx test files to core/src/dx/ (2026-01-10)
- [x] ✅ Block 4: Refactor createOrm for adapter injection (2026-01-10)
- [x] ✅ Block 5: Implement KyselyAdapter in adapter-kysely (2026-01-10)
- [x] ✅ Block 6: Update core exports (index.ts) (2026-01-10)
- [x] ✅ Block 7: Delete dx package entirely (2026-01-10)
- [x] ✅ Block 8: Run all tests and verify (2026-01-10)

**Key deliverables:**
- `packages/core/src/adapter.ts`: Adapter interface with capabilities
- `packages/core/src/dx/`: All DX layer code moved from dx package
- `packages/adapter-kysely/src/kysely-adapter.ts`: KyselyAdapter implementation
- API change: `createOrm({ model, db })` → `createOrm({ model, adapter: createKyselyAdapter(db) })`

**Files changed:** 60+ (core: 30+, adapter-kysely: 15+, e2e: 15+)
**Tests:** 1005 passing (449 core + 556 adapter-kysely)

### DX-025: Transaction Wrapper ✅ (2026-01-10)

**Scope:** dx

Implemented `orm.transaction()` as a passthrough to Kysely's transaction API:

- [x] ✅ Add `transaction()` method signature to OrmInstance interface (2026-01-10)
- [x] ✅ Implement `transaction()` in createOrmInstance (2026-01-10)
- [x] ✅ Multi-tenant support: `forTenant().transaction()` (2026-01-10)
- [x] ✅ Write tests for commit/rollback (7 tests) (2026-01-10)

**Key features:**
- Auto-commit on success, auto-rollback on exception
- Transaction callback receives scoped OrmInstance
- Multi-tenant context preserved in transaction
- All ORM operations available within transaction (select, insert, update, delete, includes)

**API:**
```typescript
// Basic transaction
await orm.transaction(async (tx) => {
  await tx.insert('orders').values({ userId: 1, total: 100 }).execute();
  await tx.update('users').set({ balance: 0 }).where(eq('id', 1)).execute();
});

// Multi-tenant transaction
await orm.forTenant('tenant_123').transaction(async (tx) => {
  await tx.insert('events').values({ type: 'order_created' }).execute();
});
```

**Files changed:** 3 (types.ts, orm.ts, transaction.test.ts)
**Tests:** 1017 passing (7 new transaction tests)

### CORE-003: Edge Cases & Plan Coherence ✅ (2026-01-10)

**Scope:** core, adapter-kysely

Fixed edge cases and removed side-effects that polluted tests:

- [x] ✅ CTE naming uniqueness: `cte_<table>_<relation>` pattern (2026-01-10)
- [x] ✅ Empty IN/AND/OR edge cases: proper SQL semantics (2026-01-10)
- [x] ✅ Path separator: verified consistent (`.` for relation paths, `/` for tree traversal)
- [x] ✅ Ambiguity metadata: already exposed via `isAmbiguous`/`ambiguousOptions`
- [x] ✅ console.warn removal: test pollution fixed (2026-01-10)

**Key changes:**
- Empty IN → `false`, Empty AND → `true`, Empty OR → `false`
- CTE names now include source table for uniqueness
- No more console.warn during test runs

**Files changed:** 4 (core: 2, adapter: 2)
**Tests:** 1010 passing

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

### Golden Tests - ✅ COMPLETE

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

## Completed - Foundation

### CORE-002: Relation Resolution Correctness ✅ (2026-01-09)

**See:** Recently Completed section above.

**Completed in CORE-002-B:**
- [x] ✅ M:N via through table support (2026-01-10)

---

### CORE-003: Edge Cases & Plan Coherence ✅ (2026-01-10)

**See:** Recently Completed section above.

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

## ✅ Completed: DX-029 Better Error Messages with Suggestions (2026-01-11)

**Priority:** HIGH | **Effort:** S (~8h) | **Breaking:** No

Improved error messages to guide users with available options and fuzzy matching suggestions:

- [x] ✅ `RelationNotFoundError` now shows available relations (already implemented, now used in orm.ts)
- [x] ✅ `TableNotFoundError` added with fuzzy matching and available tables list
- [x] ✅ `ColumnNotFoundError` added with fuzzy matching and available columns list
- [x] ✅ `findClosestMatch()` exported for reuse (Levenshtein distance + prefix priority)
- [x] ✅ 24 new tests added for error classes and fuzzy matching

**Example output:**
```
TableNotFoundError: Table 'usrs' not found in schema.
Available tables: users, posts, comments

Did you mean 'users'?
```

**Files changed:**
- `packages/core/src/dx/errors.ts` - Added TableNotFoundError, ColumnNotFoundError, exported findClosestMatch
- `packages/core/src/dx/index.ts` - Added new exports
- `packages/core/src/dx/orm.ts` - Now uses RelationNotFoundError with available relations
- `packages/core/src/dx/errors.test.ts` - 24 new tests (45 total)

**Tests:** All 1210 passing (schema: 54, core: 518, cli: 35, adapter-kysely: 603)

---

## Pending - P1 (High Value DX)

### DX-030-SPIKE: Évaluer Ink vs vue-termui pour REPL

**Priority:** HIGH | **Effort:** XS (~2h) | **Breaking:** No

POC minimal pour comparer les deux frameworks avant implémentation complète :

- [ ] Ink POC: input + box + table output + basic styling
- [ ] vue-termui POC: même fonctionnalités
- [ ] Comparer: lignes de code, ergonomie, bugs rencontrés, écosystème
- [ ] Documenter décision dans ADR

**Critères d'évaluation:**
| Critère | Poids |
|---------|-------|
| Facilité d'implémentation | 30% |
| Qualité des composants (tables, inputs) | 25% |
| Stabilité / bugs rencontrés | 25% |
| Taille bundle / dépendances | 10% |
| Familiarité équipe | 10% |

**Output:** `docs/adrs/ADR-003-cli-repl-framework.md`

---

### DX-030: CLI REPL Interactive Playground

**Priority:** HIGH | **Effort:** M (~17h) | **Breaking:** No
**Dépend de:** DX-030-SPIKE, DX-031

REPL interactif pour tester des requêtes sans setup complet :

- [ ] `dbsp repl --schema ./dbsp.schema.ts`
- [ ] Évaluation de requêtes avec affichage SQL + Plan
- [ ] Dot commands (`.schema`, `.tables`, `.relations`, `.help`)
- [ ] Pretty printing (tables, syntax highlighting)
- [ ] Autocomplétion des noms de tables/relations
- [ ] Split view optionnel (schema | query | result)

**Tech:** Décision après DX-030-SPIKE

### DX-031: MockAdapter (compile-only)

**Priority:** MEDIUM | **Effort:** S (~2h) | **Breaking:** No

Adapter qui compile sans exécuter (pour REPL et tests) :

- [ ] `createMockAdapter()` qui retourne SQL sans connexion DB
- [ ] Utile pour tests unitaires sans DB
- [ ] Prérequis pour DX-030 (REPL)

---

## Pending - P2

### Documentation (DX critical)

- [ ] **DOCS-001**: User documentation (Getting Started, API Guide)
  - [ ] Getting Started guide (installation, first query) - **~4h**
  - [ ] API reference (select, insert, update, delete, recursive, window)
  - [ ] Best practices and patterns
- [ ] **DOCS-002**: Migration guides
  - [ ] `from-prisma.md` - side-by-side comparisons - **~4h**
  - [ ] `from-drizzle.md` - **~4h**
  - [ ] `from-kysely.md` - **~2h**
- [ ] **DOCS-003**: Pattern guides
  - [ ] Multi-tenant setup guide
  - [ ] Recursive queries (category trees, BOM)
  - [ ] Window functions for analytics

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
| DX-021 | ✅ Window functions builder pattern (2026-01-10) | MEDIUM | M | Yes |
| DX-022 | ✅ Recursive via `include({ recursive: true })` (2026-01-10) | HIGH | L | Yes |
| DX-023 | Lightweight ModelIR (relations-only) | MEDIUM | L | No |
| DX-024 | ✅ `orderBy()` shorthand (polymorphic) (2026-01-09) | HIGH | S | No |
| DX-025 | ✅ `orm.transaction()` wrapper (passthrough) (2026-01-10) | HIGH | M | No |
| DX-026 | ✅ `upsert()` + `returning()` support (2026-01-10) | HIGH | M | No |
| DX-027 | ✅ Raw SQL escape hatch (`raw`, `orm.raw`) (2026-01-10) | HIGH | S | No |
| DX-028 | ✅ Pagination helpers (offset + cursor) (2026-01-10) | MEDIUM | S | No |

**Breaking changes summary:**
- ✅ DX-020: Remove `columnsWithExpressions()`, use `columns()` unified (DONE 2026-01-09)
- ✅ DX-021: Remove `.window([...])` object syntax, use builder pattern (DONE 2026-01-10)
- ✅ DX-022: Remove `createRecursiveQuery()`, use `include({ recursive: true })` (DONE 2026-01-10)

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
packages/core           → (nothing)
packages/adapter-kysely → packages/core
```

Note: `packages/dx` was merged into `packages/core` in ARCH-001 (2026-01-10).

### Potential Future Features (P4+)

These features may be considered for future versions:

| Feature | Priority | Notes |
|---------|----------|-------|
| **Multi-dialect full correctness** | LOW | Extend beyond PostgreSQL focus, full test coverage for MySQL/SQLite/MSSQL |
| **Cost-based optimization** | LOW | Query cost estimation based on table statistics |
| **Join reordering** | LOW | Automatic join order optimization (requires cost estimation) |

### Out of Scope (Design Decisions)

These features are intentionally excluded from the library's scope:

| Feature | Reason |
|---------|--------|
| **NL-to-SQL / AI generation** | Separate concern, would be a different library/layer |
| **Change tracking / dirty checking** | Not an ORM - this is a query planner |
| **Migrations** | Use dedicated tools (Kysely migrations, Prisma, etc.) |
| **Connection pooling** | Delegated to underlying adapter (Kysely) |
