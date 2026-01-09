# DX (Developer Experience) Scope Backlog (`packages/dx`)

**Package:** `packages/dx`
**Phase:** P1 (after MVP)
**Dependencies:** `packages/core`, `packages/adapter-kysely`

## Architecture Constraint

```
Imports from: packages/core, packages/adapter-kysely
This is a LEAF package (nothing depends on it)
```

---

## In Progress

(none)

---

## Pending - P2

(none)

---

## Completed

### DX-010: Mutations (insert/update/delete) ✅ (2026-01-09)

**Spec:** [docs/specs/DX-010-mutations.md](docs/specs/DX-010-mutations.md)

Full mutation support for insert/update/delete with safety guards and observability.

- [x] ✅ Block 1: Core Intent Types (InsertIntent, UpdateIntent, DeleteIntent)
  - 13 new tests in core
- [x] ✅ Block 2: Adapter Mutation Compiler
  - `compileInsert()`, `compileUpdate()`, `compileDelete()` in adapter-kysely
  - Safety guards: WHERE required unless allowAll=true
  - Multi-tenant schema prefix support
  - 17 new tests in adapter-kysely
- [x] ✅ Block 3: DX Insert Builder
  - `InsertBuilder` with `values()`, `dump()`, `execute()`
  - Immutable builder pattern
  - `InvalidOperationError` for empty values
- [x] ✅ Block 4: DX Update Builder
  - `UpdateBuilder` with `set()`, `where()`, `dump()`, `execute()`
  - Safety guard: `UnsafeOperationError` without WHERE
  - `orm.updateAll()` factory for explicit full-table updates
- [x] ✅ Block 5: DX Delete Builder
  - `DeleteBuilder` with `where()`, `cascade()`, `dump()`, `execute()`
  - Safety guard: `UnsafeOperationError` without WHERE
  - `orm.deleteAll()` factory for explicit full-table deletes
- [x] ✅ Block 6: Multi-tenant Mutations
  - Schema prefix in INSERT/UPDATE/DELETE via `forTenant()`
  - `MutationDump.meta.tenant` for observability
- [x] ✅ 34 new tests in dx (mutation-builders.test.ts)

**Effort:** L

---

### DX-009: RecursiveBuilder Integration + Renaming ✅ (2026-01-09)

Intégrer RecursiveQueryBuilder directement dans l'ORM avec API plus intuitive.

- [x] ✅ Intuitive alias methods on RecursiveQueryBuilder:
  - `startingFrom(column)` - alias for nodeId()
  - `following(table, options)` - alias for traverseVia()
  - `upToDepth(depth)` - alias for maxDepth()
- [x] ✅ Hierarchy shortcuts on ORM instance:
  - `orm.ancestors(table, nodeIdValue, options)` - ancestor traversal
  - `orm.descendants(table, nodeIdValue, options)` - descendant traversal
  - `orm.subtree(table, nodeIdValue, options)` - subtree traversal
- [x] ✅ HierarchyOptions interface with parentId, nodeId, cteName
- [x] ✅ Multi-tenant support for hierarchy shortcuts (forTenant)
- [x] ✅ Updated dump() to return intent for debugging
- [x] ✅ 12 hierarchy-shortcuts tests + 4 alias tests (26 total recursive-query-builder tests)

**Effort:** M

---

### DX-008: API Shortcuts (byId, dot notation include) ✅ (2026-01-09)

Raccourcis pour les cas d'usage fréquents.

- [x] ✅ `byId(value)` - raccourci pour `where(eq('id', value)).findFirst()`
  - Support PK simple: `byId(42)`
  - Support PK composite: `byId({ orderId: 1, productId: 42 })`
- [x] ✅ `byIdOrThrow(value)` - throws NotFoundError if not found
- [x] ✅ `byIds(values)` - raccourci pour `where(inArray('id', values)).findMany()`
  - Handles empty array gracefully (returns [])
- [x] ✅ Dot notation pour include nested: `.include('posts.comments.author')`
  - Options applied to deepest level
- [x] ✅ Fluent chaining alternatif: `.include('posts').include('posts.comments')`
- [x] ✅ 13 unit tests

**Effort:** S

---

### DX-007: Actionable Error Messages ✅ (2026-01-09)

Améliorer les messages d'erreur pour guider l'utilisateur vers la solution.

- [x] ✅ `ExecutionError` avec operation, reason, fix
- [x] ✅ `NotFoundError` avec hint optionnel
- [x] ✅ `AmbiguousRelationError` avec exemples de code pour fix
- [x] ✅ `RelationNotFoundError` (NEW) avec:
  - Liste des relations disponibles
  - Suggestion "Did you mean 'X'?" (fuzzy match Levenshtein)
- [x] ✅ 21 tests (9 nouveaux pour RelationNotFoundError)

**Effort:** S

---

### DX-006: Zero-Config ORM ✅ (2026-01-08)

Make `model` optional in `createOrm()` - auto-introspect from database when missing.

- [x] ✅ Update `OrmOptions` to make `model` optional
- [x] ✅ Add `OrmOptionsWithModel` and `OrmOptionsWithDb` types
- [x] ✅ Function overloads: sync with model, async without (Promise)
- [x] ✅ Import and call `introspect(db)` when model missing
- [x] ✅ 11 unit tests for zero-config path
- [x] ✅ Export new types from index.ts

### DX-005: Recursive Query Builder ✅ (2026-01-08)

**Spec:** [docs/specs/DX-005-recursive-query-builder.md](docs/specs/DX-005-recursive-query-builder.md)

Fluent builder API for recursive CTE queries with composition support.

- [x] ✅ Block 1: Core AST Extension (EmitJoinClause, RecursiveEmitOptions)
- [x] ✅ Block 2: Compiler Join Support (compileEmitJoins)
- [x] ✅ Block 3: RecursiveQueryBuilder Core (from, nodeId, traverseVia, maxDepth)
- [x] ✅ Block 4: Builder Composition Methods (join, leftJoin, select, distinct, emitFilter)
- [x] ✅ Block 5: Builder Execution (execute, dump, buildIntent)
- [x] ✅ Block 6: Unit Tests - 22 tests covering all BDD scenarios

### STREAMING-001: QueryBuilder.stream() - 10 dx tests ✅ (2026-01-07)

**Spec:** [docs/specs/STREAMING-001-cursor-support.md](docs/specs/STREAMING-001-cursor-support.md)

- [x] ✅ `stream(options?)` method on QueryBuilder
  - Returns AsyncIterableIterator<unknown>
  - Throws ExecutionError if db not configured
- [x] ✅ `StreamOptions` interface
  - chunkSize?: number
  - onStart?: (dump: Dump) => void
- [x] ✅ Multi-tenant streaming support
- [x] ✅ Works with where(), select() builder chain
- [x] ✅ Re-exports MissingDependencyError, UnsupportedOperationError

### DX-004: Aggregate API ✅ (2026-01-07)

- [x] ✅ `count(options?)` - COUNT(*) or COUNT(field)
- [x] ✅ `sum(field, as?)` - SUM aggregate
- [x] ✅ `avg(field, as?)` - AVG aggregate
- [x] ✅ `min(field, as?)` - MIN aggregate
- [x] ✅ `max(field, as?)` - MAX aggregate
- [x] ✅ `groupBy(fields)` - GROUP BY support
- [x] ✅ `AggregateOptions` interface
- [x] ✅ Integrated with QueryBuilder immutable pattern

### DX-003: Compat Layer ✅ (2026-01-07)

**Spec:** [docs/specs/DX-003-compat-layer.md](docs/specs/DX-003-compat-layer.md)

#### Filter Helpers (14 functions)

- [x] ✅ eq(field, value): WhereComparisonIntent
- [x] ✅ neq(field, value): WhereComparisonIntent
- [x] ✅ gt(field, value): WhereComparisonIntent
- [x] ✅ gte(field, value): WhereComparisonIntent
- [x] ✅ lt(field, value): WhereComparisonIntent
- [x] ✅ lte(field, value): WhereComparisonIntent
- [x] ✅ like(field, pattern, caseInsensitive?): WhereLikeIntent
- [x] ✅ isNull(field): WhereNullIntent
- [x] ✅ isNotNull(field): WhereNullIntent
- [x] ✅ inArray(field, values): WhereInIntent
- [x] ✅ and(...conditions): WhereAndIntent
- [x] ✅ or(...conditions): WhereOrIntent
- [x] ✅ not(condition): WhereNotIntent
- [x] ✅ exists(relation, { where? }): WhereExistsIntent
- [x] ✅ notExists(relation, { where? }): WhereNotExistsIntent

#### Query Execution Methods

- [x] ✅ findMany(): Promise<unknown[]>
- [x] ✅ findFirst(): Promise<unknown | undefined>
- [x] ✅ findFirstOrThrow(): Promise<unknown>
- [x] ✅ `db` option in `OrmOptions` for Kysely instance

#### Multi-tenant Execution

- [x] ✅ forTenant(schemaName): OrmInstance - scoped to tenant schema

#### Error Classes

- [x] ✅ ExecutionError - thrown when db not configured
- [x] ✅ NotFoundError - thrown by findFirstOrThrow() when no results

#### Tests

- [x] ✅ 117 tests passing (30 filters + 12 errors + 27 strict-mode + 21 override + 27 execution)

### DX-002: Override API ✅ (2026-01-07)

- [x] ✅ Per-query `strictMode` override: `query.withStrictMode(true)`
- [x] ✅ include(relation, { via: 'relationName' }) - Already existed from DX-001
- [x] ✅ withRelationHint(targetTable, relationName)
  - Per-query default for a target
- [x] ✅ Global `relationHints` in `OrmOptions`
- [x] ✅ Integration with planner
  - Hints applied to includes before planning
  - Explicit via takes precedence over hints
  - Nested includes supported
- [x] ✅ 21 tests passing (override-api.test.ts)

### DX-001: Strict Mode ✅ (2026-01-07)

**Spec:** [docs/specs/DX-001-strict-mode.md](docs/specs/DX-001-strict-mode.md)

#### Delivered

- [x] ✅ `strictMode` option in `createOrm()` (default: false)
- [x] ✅ `AmbiguousRelationError` class with:
  - `sourceTable`, `targetTable`, `options` properties
  - Proper `instanceof` support
  - Disambiguation hint in message
- [x] ✅ Behavior matrix:
  | Scenario | strictMode: true | strictMode: false |
  |----------|------------------|-------------------|
  | Ambiguous | Throws `AmbiguousRelationError` | Warn + use first |
  | With via | Works | Works |
  | Unambiguous | Works | Works |
- [x] ✅ `include({ via })` syntax for disambiguation
- [x] ✅ 33 passing tests (9 BDD scenarios + additional edge cases)
- [x] ✅ Integration verified: `pnpm -r test` and `pnpm -r typecheck` pass

## Blocked / Deferred

(none)

---

## Golden Test Owned by DX

| Test | Component | Validation |
|------|-----------|------------|
| Q3 | Strict mode | Throws AmbiguousRelationError with options |

## Non-Goals

- No migrations (use Kysely/Prisma/Drizzle migrations)
- No change tracking / Unit of Work pattern
- No automatic cascade (always explicit via .cascade())
- No runtime type validation

## Open Questions

- [x] Should compat layer be a separate package? → **No, part of packages/dx**
- [x] Strict mode: warn vs error? → **error in strict mode, warning in plan.warnings otherwise**
- [x] Console.warn for lenient mode? → **No, use existing PlanReport.warnings**
- [x] Which Drizzle helpers to prioritize? → ✅ Implemented all 14 in DX-003
