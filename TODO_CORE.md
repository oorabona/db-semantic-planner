# Core Scope Backlog (`packages/core`)

**Package:** `packages/core`
**Status:** ✅ Complete (Schema, Intent, Planner, DX layer)
**Dependencies:** None (DB-agnostic)

## Architecture Constraint

```
⚠️  MUST NOT import from adapter packages
⚠️  Zero database-specific code
⚠️  DX layer (core/src/dx/) is now part of this package (ARCH-001)
```

---

## Completed - Architecture

### ARCH-001: Dialect-Agnostic Recursive CTE - Core Changes ✅ (2026-01-08)

**Spec:** [docs/specs/ARCH-001-dialect-agnostic-recursive.md](docs/specs/ARCH-001-dialect-agnostic-recursive.md)

- [x] ✅ Block 1: Extend `RecursiveTrackOptions.path` with `separator?: string` (2026-01-08)
  - Added `separator` option to intent-ast.ts
  - TypeScript compilation verified
  - Backward compatible (existing code unchanged)

---

## Completed - P3 (Advanced Features)

**ADR:** [ADR-001: Typed Intents for Advanced Features](docs/adrs/ADR-001-typed-intents-for-advanced-features.md)

### P3-A: WindowIntent ✅ (2026-01-09)

- [x] ✅ `WindowIntent` type in intent-ast.ts
  - function: row_number, rank, dense_rank, sum, avg, count, min, max, lag, lead
  - over: partitionBy, orderBy, frame
  - alias: string
- [x] ✅ `WindowFunction` union type
- [x] ✅ `isWindowIntent` type guard
- [x] ✅ 8 unit tests for WindowIntent

---

## Pending - P3 (Advanced Features)

### P3-B: FTSIntent (PostgreSQL Full-Text Search)

- [ ] `FTSIntent` type in intent-ast.ts
  - field, query, config (language)
  - operator: match, phrase, prefix, negation
  - ranking options (weights, normalization)
- [ ] `isFTSIntent` type guard
- [ ] Planner support for FTS in WHERE clause

### P3-C: RangeIntent (PostgreSQL Range Types)

- [ ] `RangeIntent` type in intent-ast.ts
  - type: daterange, tsrange, tstzrange, int4range, int8range, numrange
  - operator: overlaps, contains, contained_by, adjacent, left_of, right_of
  - value: { lower, upper, bounds }
- [ ] `isRangeIntent` type guard

---

## Pending - DX Layer (core/src/dx/)

*Migrated from TODO_DX.md after ARCH-001 merge (2026-01-10)*

### DX-026: Upsert Support ✅ (2026-01-10)

**Priority:** HIGH | **Effort:** M | **Commit:** dde5d71

Support `INSERT ... ON CONFLICT` (PostgreSQL) / `INSERT OR REPLACE` (SQLite).

**API:**
```typescript
orm.upsert('users')
   .values({ id: 1, name: 'John', email: 'john@example.com' })
   .onConflict('id')
   .doUpdate(['name', 'email'])
   .execute()

// Avec RETURNING (PostgreSQL)
const user = await orm.upsert('users')
   .values({ id: 1, name: 'John' })
   .onConflict('id')
   .doUpdate(['name'])
   .returning(['id', 'name', 'updated_at'])
   .execute()
```

**Tasks:**
- [x] ✅ Core: `UpsertIntent` type (2026-01-10)
- [x] ✅ Adapter: `compileUpsert()` avec support PostgreSQL (2026-01-10)
- [x] ✅ DX: `UpsertBuilder` avec `.values()`, `.onConflict()`, `.doUpdate()`, `.doNothing()`, `.returning()`, `.execute()`, `.dump()` (2026-01-10)
- [x] ✅ Multi-tenant: schema prefix support (2026-01-10)
- [x] ✅ Tests: single key, composite key, doUpdate, doNothing, returning (2026-01-10)
- [x] ✅ DialectCapabilities: `supportsUpsert`, `supportsReturning` (2026-01-10)

---

### DX-027: Raw SQL Escape Hatch ✅ (2026-01-10)

**Priority:** HIGH | **Effort:** S | **Commit:** 1dae226

Permettre du SQL brut pour les cas non couverts par l'ORM.

**API:**
```typescript
// Query complète raw
const users = await orm.raw<User[]>`
  SELECT * FROM users
  WHERE jsonb_data @> '{"role": "admin"}'
`;

// Raw dans un where (expression)
orm.select('users')
   .where(raw`age > 18 AND jsonb_field @> '{"active": true}'`)
   .all()

// Raw avec paramètres (sécurisé)
orm.select('products')
   .where(raw`price BETWEEN ${minPrice} AND ${maxPrice}`)
   .all()
```

**Tasks:**
- [x] ✅ Helper `raw` pour expressions (tagged template literal) (2026-01-10)
- [x] ✅ `orm.raw<T>()` pour queries complètes (2026-01-10)
- [x] ✅ Binding automatique des paramètres (sécurité injection SQL) (2026-01-10)
- [x] ✅ Intégration avec `where()`, `columns()` (2026-01-10)
- [x] ✅ Multi-tenant : schema prefix dans raw queries (2026-01-10)
- [x] ✅ Tests: expressions, full queries, paramètres (2026-01-10)

---

### DX-028: Pagination Helpers ✅ (2026-01-10)

**Priority:** MEDIUM | **Effort:** S

Helpers pour pagination offset-based et cursor-based.

**API Offset-based:**
```typescript
const page = await orm.select('users')
   .where(eq('active', true))
   .orderBy('created_at', 'desc')
   .paginate({ page: 2, perPage: 20 })
// → { data: User[], pagination: { page, perPage, total, totalPages, hasNextPage, hasPrevPage } }
```

**API Cursor-based:**
```typescript
const page = await orm.select('users')
   .orderBy('id')
   .cursorPaginate({ cursor: 'eyJpZCI6MTAwfQ==', limit: 20 })
// → { data: User[], nextCursor, prevCursor, hasNextPage, hasPrevPage }
```

**Tasks:**
- [x] ✅ `paginate({ page, perPage })` method (2026-01-10)
- [x] ✅ `PaginatedResult<T>` type with metadata (2026-01-10)
- [x] ✅ COUNT query optimized (option `withCount: false`) (2026-01-10)
- [x] ✅ `cursorPaginate({ cursor, limit })` method (2026-01-10)
- [x] ✅ Cursor encode/decode (base64 JSON of orderBy values) (2026-01-10)
- [x] ✅ Tests: first page, middle, last, empty (27 tests) (2026-01-10)

---

### P3-B: Full-Text Search DX API

**Priority:** LOW | **Effort:** M

- [ ] `fts(field, query, options?)` helper function
- [ ] `ftsRank(field, query)` for ordering by relevance
- [ ] FTSOptions: config, operator, ranking
- [ ] Integration with where() clause

---

### P3-C: Range Types DX API

**Priority:** LOW | **Effort:** S

- [ ] `rangeOverlaps(field, value)` helper
- [ ] `rangeContains(field, value)` helper
- [ ] `rangeContainedBy(field, value)` helper
- [ ] RangeValue type: { lower, upper, bounds? }

---

## Completed - DX Layer (Migrated from TODO_DX.md)

All DX features completed before ARCH-001 merge are documented below for reference.
See original TODO_DX.md commit history for full details.

| ID | Feature | Date |
|----|---------|------|
| DX-025 | Transaction Wrapper | 2026-01-10 |
| DX-024 | orderBy() Shorthand | 2026-01-09 |
| DX-023 | Lightweight ModelIR | 2026-01-09 |
| DX-022 | Recursive via include() | 2026-01-09 |
| DX-021 | Window Functions Builder | 2026-01-09 |
| DX-020 | Unified columns() API | 2026-01-09 |
| DX-012 | API Ergonomics | 2026-01-09 |
| DX-011 | API Improvements | 2026-01-09 |
| DX-010 | Mutations | 2026-01-09 |
| DX-009 | RecursiveBuilder Integration | 2026-01-09 |
| DX-008 | API Shortcuts | 2026-01-09 |
| DX-007 | Actionable Error Messages | 2026-01-09 |
| DX-006 | Zero-Config ORM | 2026-01-08 |
| DX-005 | Recursive Query Builder | 2026-01-08 |
| DX-004 | Aggregate API | 2026-01-07 |
| DX-003 | Compat Layer | 2026-01-07 |
| DX-002 | Override API | 2026-01-07 |
| DX-001 | Strict Mode | 2026-01-07 |
| P3-A | Window Functions DX API | 2026-01-09 |
| STREAMING-001 | QueryBuilder.stream() | 2026-01-07 |

---

## Completed - Schema, Intent, Planner

### RFC-001: Recursive CTE Support ✅ (2026-01-08)

**RFC:** [docs/rfcs/RFC-001-recursive-cte.md](docs/rfcs/RFC-001-recursive-cte.md)

- [x] ✅ Block 1: Add `RecursiveIntent` + traversal types to intent-ast.ts (2026-01-08)
- [x] ✅ Block 2: Add shape validation + `recursive-cte` decision type to planner (2026-01-08)
- [x] ✅ Unit tests for recursive intent creation and planning (2026-01-08) - 13 tests

---


### CORE-001: ModelIR Types ([spec](docs/specs/CORE-001-model-ir.md))

- [x] ✅ TableIR interface
  - name, columns, primaryKey, foreignKeys
- [x] ✅ ColumnIR interface
  - name, type, nullable, default
- [x] ✅ ForeignKeyIR interface
  - columns, references, onDelete
- [x] ✅ RelationIR interface
  - name, type, source, target, through
  - Planning hints: cardinality, optionality
  - Strategy hints: includeStrategy, filterStrategy, joinDefault
- [x] ✅ ModelIR interface
  - tables Map, relations Map
  - Helper methods: getTable, getRelation, getRelationsFrom, getRelationsTo, isAmbiguous

### Schema Builder API

- [x] ✅ defineSchema() function (thenable pattern)
- [x] ✅ .relations() chain
- [x] ✅ hasOne, hasMany, belongsTo, belongsToMany helpers
- [x] ✅ .build() to produce ModelIR (immutable after build)

### CORE-002: IntentAST Types

- [x] ✅ QueryIntent interface
  - type: 'select', from, select, where, include, orderBy, limit, offset, groupBy
- [x] ✅ SelectIntent interface
  - type: 'all' | 'fields' | 'aggregate', fields array
  - AggregateFunction: count, sum, avg, min, max
  - AggregateIntent: function, field?, as?
  - SelectAggregateIntent: aggregates array + optional fields
  - isSelectAggregate type guard
- [x] ✅ IncludeIntent interface
  - relation, select, where, include (nested), via (disambiguation)
- [x] ✅ WhereIntent union type
  - Comparison: eq, neq, gt, gte, lt, lte
  - String: like
  - Array: in
  - Null: isNull, isNotNull
  - Logical: and, or, not
  - **Relation: exists, notExists, relationFilter** (critical for Q1)
- [x] ✅ OrderByIntent interface
  - field, direction, nulls
- [x] ✅ Type guards for all WhereIntent kinds
- [x] ✅ 35 unit tests

### CORE-003: Semantic Planner ([spec](docs/specs/CORE-003-semantic-planner.md))

- [x] ✅ PlanReport interface
  - rootTable, decisions, warnings, ctes, intent, metadata
- [x] ✅ PlanDecision interface
  - id, type, context, choice, reasoning, alternatives
- [x] ✅ PlanWarning interface
  - code (AMBIGUOUS_RELATION, POTENTIAL_ROW_EXPLOSION, CIRCULAR_INCLUDE, DEEP_NESTING), message, suggestion
- [x] ✅ CTEDefinition interface
  - name, purpose, referencedBy, sourceIntent
- [x] ✅ PlanOptions interface
  - forceFilterStrategy, forceJoinType, enableCTEs, cteThreshold, maxIncludeDepth, disambiguate
- [x] ✅ EXISTS vs JOIN decision engine
  - Default to EXISTS for to-many (avoids row explosion)
  - Enables Q1 golden test
- [x] ✅ LEFT vs INNER join inference
  - Based on cardinality + optionality + filters
- [x] ✅ Include strategy (JOIN vs separate query)
  - JOIN for to-one, separate for to-many
- [x] ✅ CTE extraction logic
  - Detect relation reuse (same relation accessed multiple times)
  - Extract to CTE with threshold control
  - Enables Q2 golden test
- [x] ✅ Ambiguity detection
  - Multiple relations to same target
  - AmbiguousPlanError with options array
  - Via hint and disambiguate option support
  - Enables Q3 golden test
- [x] ✅ 29 unit tests covering Q1, Q2, Q3 scenarios

## Blocked / Deferred

(none)

---

## Golden Tests Enabled by Core

| Test | Core Component | Validation |
|------|----------------|------------|
| Q1 | WhereIntent.exists + Planner | filter-strategy = exists |
| Q2 | CTEDefinition + Planner | cte-extraction for ratios |
| Q3 | Planner ambiguity detection | Returns options array |

## Open Questions

- [x] Should schema be immutable after construction? → **Yes, immutable after .build()**
- [x] How to handle circular relation definitions? → **Detected at build time, logs warning (not an error)**
- [x] Custom planning hints/overrides API? → **RelationIR strategy hints + per-query via**
