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

(No tasks in progress)

---

## Completed (Recent)

### DX-023: Lightweight ModelIR (Kysely Type Inference) ✅ (2026-01-09)

**Priority:** MEDIUM | **Effort:** L
**Spec:** [docs/plans/DX-023-lightweight-modelir.md](docs/plans/DX-023-lightweight-modelir.md)

Simplify model definition with shorthand relations syntax and FK inference.

**New API:**
```typescript
const model = defineModel<Database>({
  relations: {
    'users.posts': '1:N',                    // FK inferred: user_id
    'users.profile': ['1:1', 'profiles'],    // FK inferred: user_id
    'posts.author': ['N:1', 'users'],        // Explicit target
    'orders.items': { cardinality: '1:N', fk: 'order_uuid' }  // Exotic case
  }
});
```

**Features:**
- Cardinality shorthand: `'1:N'`, `'N:1'`, `'1:1'`, `'M:N'`
- Three definition forms: simple, tuple, object
- FK inference via `{singular_table}_id` convention
- Singularization: users→user, categories→category, irregular plurals
- M:N requires `through` option
- Self-referential relations supported
- Type-safe RelationKey<DB> for autocomplete

**Blocks:**
- [x] ✅ Block 1: Types and Parser (CardinalityShorthand, RelationObjectDef, etc.)
- [x] ✅ Block 2: FK Inference (singularize, inferForeignKey)
- [x] ✅ Block 3: defineModel Function (LightweightModelIR)
- [x] ✅ Block 4: Type-Level Safety (RelationKey<DB>, expectTypeOf tests)
- [x] ✅ Block 5: Integration Tests

**Tests:** 66 new tests (lightweight-model.test.ts)
**Exports:** defineModel, singularize, inferForeignKey, InvalidRelationDefinitionError, type guards

### DX-022: Recursive via include() Option ✅ (2026-01-09)

**Priority:** HIGH | **Effort:** L | **BREAKING CHANGE**
**Spec:** [docs/plans/DX-022-recursive-include.md](docs/plans/DX-022-recursive-include.md)

Integrate recursive queries into `include()` instead of a separate function.

**New API:**
```typescript
// Nested (default) - ancestors attached in nested structure
const category = await orm.select('categories')
   .where(eq('id', 5))
   .include('parent', { recursive: true, direction: 'ancestors' })
   .first();

// Flat - ancestors as array with depth
const category = await orm.select('categories')
   .where(eq('id', 5))
   .include('parent', { recursive: true, direction: 'ancestors', flat: true })
   .first();

// Shortcuts
const ancestors = await orm.listAncestors('categories', 5, { parentId: 'parentId' });
const descendants = await orm.listDescendants('categories', 1, { parentId: 'parentId' });
```

**Old API (removed):**
- `createRecursiveQuery()` - removed
- `RecursiveQueryBuilder` - now internal-only
- `orm.recursive()` - removed
- `orm.ancestors()` - replaced by `orm.listAncestors()`
- `orm.descendants()` - replaced by `orm.listDescendants()`
- `orm.subtree()` - removed (use `listDescendants`)

**Blocks:**
- [x] ✅ Block 1: RecursiveIncludeOptions type
- [x] ✅ Block 2: Self-referential detection
- [x] ✅ Block 3: Recursive include processing (flat + nested)
- [x] ✅ Block 4: listAncestors/listDescendants shortcuts
- [x] ✅ Block 5: Remove old API (BREAKING)
- [x] ✅ Block 6: Documentation & migration guide

**Tests:** 12 new tests (hierarchy-shortcuts.test.ts)
**Exports:** `ListHierarchyOptions`, `RecursiveIncludeOptions`

### DX-021: Window Functions Builder Pattern ✅ (2026-01-09)

**Priority:** MEDIUM | **Effort:** M | **BREAKING CHANGE**
**Spec:** [docs/plans/DX-021-window-builder.md](docs/plans/DX-021-window-builder.md)

Replace verbose object API with fluent builder pattern.

**Old API (removed):**
```typescript
.window('running_balance', { function: 'sum', field: 'amount', partitionBy: [...], orderBy: [...] })
```

**New API:**
```typescript
.columns([
  'sku',
  rowNumber().orderBy('created_at', 'desc').as('rn'),
  rank().partitionBy('category_id').orderBy('price').as('price_rank'),
  wSum('amount').partitionBy('user_id').as('running_total')
])
```

**Blocks:**
- [x] ✅ Block 1: Core Type Updates - Add WindowIntent to ExpressionIntent union
- [x] ✅ Block 2: WindowBuilder class with partitionBy(), orderBy(), as()
- [x] ✅ Block 3: Factory functions - rowNumber(), rank(), denseRank(), wSum(), wAvg(), wCount(), wMin(), wMax(), lag(), lead()
- [x] ✅ Block 4: Remove old .window() method (BREAKING)
- [x] ✅ Block 5: Integration with columns() API verification

**Tests:** 35 new tests (21 unit + 14 integration)
**Functions:** rowNumber, rank, denseRank, wSum, wAvg, wCount, wMin, wMax, lag, lead

### DX-020: Unified columns() API ✅ (2026-01-09)

**BREAKING CHANGE:** Removed `columnsWithExpressions()`, unified into `columns()`.

- [x] ✅ Create `ExpressionSpec` type with `__expr: true` marker
- [x] ✅ Create `ColumnSpec = string | ExpressionSpec` union type
- [x] ✅ Create `isExpressionSpec()` type guard function
- [x] ✅ Modify `columns()` to accept `ColumnSpec[]`
- [x] ✅ Update `coalesce()` helper to return `ExpressionSpec`
- [x] ✅ Update `raw()` helper to return `ExpressionSpec`
- [x] ✅ Remove `columnsWithExpressions()` from types.ts
- [x] ✅ Remove `columnsWithExpressions()` from orm.ts
- [x] ✅ Update E2E tests to use new `columns()` API
- [x] ✅ All 887 tests passing

**New API:**
```typescript
.columns(['sku', coalesce(['name_fr', 'name_en'], 'display_name')])
```

**Effort:** M

### DX-012: API Ergonomics ✅ (2026-01-09)

**Spec:** [docs/specs/DX-012-api-ergonomics.md](docs/specs/DX-012-api-ergonomics.md)

Improve API ergonomics with object filter syntax, typed generics, and subquery builder.

- [x] ✅ Block 1: Object Filter Syntax
  - `where({ status: 'active' })` shorthand for `where(eq('status', 'active'))`
  - Operators via `$` prefix: `{ age: { $gt: 18 } }`
  - Support: $eq, $neq, $gt, $gte, $lt, $lte, $in, $like, $ilike, null, $notNull
  - Backward compatible with WhereIntent
  - 28 tests in object-filter.test.ts
- [x] ✅ Block 2: Typed Schema Generics (Kysely-like)
  - `createOrm<DB>()` with DB interface for autocomplete
  - `query('users')` autocomplete on table names
  - `where({ name: 'x' })` autocomplete on field names
  - Compatible with existing Kysely Database types
  - 13 tests in typed-schema.test.ts
- [x] ✅ Block 3: Subquery Builder
  - `subquery('table').select('field').where(...)`
  - Aggregate methods: `.count()`, `.sum()`, `.avg()`, `.min()`, `.max()`
  - `ref('column')` helper for parent column references
  - Integration with object filter syntax: `{ price: { $eq: subquery(...) } }`
  - WhereSubqueryIntent, ScalarSubqueryIntent, SubqueryRefIntent in core
  - Compiler support in adapter-kysely (compileSubquery)
  - 38 tests in subquery-builder.test.ts

**Tests:** 79 new tests across 3 test files
**Effort:** L

### DX-011: API Improvements (Type Inference, where AND, include) ✅ (2026-01-09)

Ergonomic improvements to QueryBuilder API for better DX.

- [x] ✅ Block 1: where() AND chaining
  - Multiple `.where()` calls produce implicit AND
  - Single where → direct WhereIntent
  - Multiple where → wrapped in WhereAndIntent
  - 4 tests covering nominal/edge cases
- [x] ✅ Block 2: include('relationName') direct syntax
  - `.include('posts')` as shorthand for `.include({ relation: 'posts' })`
  - `.include('posts', { select: [...] })` for options
  - Existing object syntax still works
  - 4 tests for string/options/object forms
- [x] ✅ Block 3: Type inference on select/execute
  - `orm.query<User>('users')` returns `QueryBuilder<User>`
  - All builder methods preserve `TResult` generic
  - Execution methods return typed: `Promise<User[]>`, `Promise<User | undefined>`
  - 6 type-level tests using `expectTypeOf`

**Tests:** 14 new tests in `dx-011-api-improvements.test.ts`
**Effort:** M

---

## Completed (Recent)

### P3-A: Window Functions DX API ✅ (2026-01-09)

**Spec:** [docs/specs/P3-A-window-functions.md](docs/specs/P3-A-window-functions.md)

Window function support across core, adapter, and dx packages.

- [x] ✅ Block 1: Core WindowIntent types (WindowFunction, WindowIntent, isWindowIntent)
- [x] ✅ Block 2: Adapter DialectCapabilities.supportsWindowFunctions
- [x] ✅ Block 3: Adapter compileWindowSelect() function
- [x] ✅ Block 4: DX window() method on QueryBuilder
  - `window('running_balance', { function: 'sum', field: 'amount', partitionBy: [...], orderBy: [...] })`
  - Immutable builder pattern with chaining support
  - Integration with dump(), select(), where()

**Tests:** 40 window-specific tests (8 core + 17 adapter + 15 dx)
**Functions:** row_number, rank, dense_rank, sum, avg, count, min, max, lag, lead
**Effort:** M

---

## Pending - P3

**ADR:** [ADR-001: Typed Intents for Advanced Features](docs/adrs/ADR-001-typed-intents-for-advanced-features.md)

### P3-B: Full-Text Search DX API

- [ ] `fts(field, query, options?)` helper function
- [ ] `ftsRank(field, query)` for ordering by relevance
- [ ] FTSOptions: config, operator, ranking
- [ ] Integration with where() clause

### P3-C: Range Types DX API

- [ ] `rangeOverlaps(field, value)` helper
- [ ] `rangeContains(field, value)` helper
- [ ] `rangeContainedBy(field, value)` helper
- [ ] RangeValue type: { lower, upper, bounds? }

---

## Pending - P2

### ✅ DX-024: orderBy() Shorthand (2026-01-09)

**Priority:** HIGH | **Effort:** S

API polymorphe pour `orderBy()` avec raccourcis.

**Nouveau :**
```typescript
// Simple - défaut ASC
.orderBy('created_at')

// Avec direction
.orderBy('created_at', 'desc')

// Multiple colonnes (objet)
.orderBy({ created_at: 'desc', name: 'asc' })

// Cas avancés (garde syntaxe actuelle)
.orderBy([{ column: 'created_at', direction: 'desc', nulls: 'last' }])
```

**Tâches :**
- [x] ✅ Overloads TypeScript pour les 4 signatures (2026-01-09)
- [x] ✅ Normaliser vers format interne `OrderByIntent[]` (2026-01-09)
- [x] ✅ Tests pour chaque variante (2026-01-09)
- [x] ✅ Backward compatible (syntaxe tableau existante fonctionne) (2026-01-09)

---

### DX-025: Transaction Wrapper

**Priority:** HIGH | **Effort:** M

API `orm.transaction()` pour transactions avec abstraction adapter.

**Philosophie : Passthrough, pas réimplémentation**
```
┌─────────────────────────────────────────────────────────────────┐
│  On expose ce que l'adapter supporte, on n'invente rien         │
│  Nested transactions, savepoints, readOnly → si Kysely le fait  │
│  Sinon → erreur de l'adapter (pas notre responsabilité)         │
└─────────────────────────────────────────────────────────────────┘
```

**API :**
```typescript
await orm.transaction(async (tx) => {
  const user = await tx.select('users').where(eq('id', 1)).first();
  await tx.insert('posts').values({ user_id: user.id, title: 'New' }).execute();
  // Commit automatique si pas d'erreur
  // Rollback automatique si erreur (géré par Kysely)
});

// Multi-tenant
await orm.forTenant('acme').transaction(async (tx) => {
  // tx est scopé au tenant
});
```

**Architecture :**
```typescript
// Interface adapter (packages/adapter-kysely)
interface DatabaseAdapter {
  transaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T>;
}

// TransactionContext = ORM instance scopée à la transaction
// Wraps Kysely's transaction, rien de plus
```

**Tâches :**
- [ ] Définir `TransactionContext` interface
- [ ] Implémenter dans adapter-kysely (wraps `db.transaction()`)
- [ ] Ajouter `orm.transaction()` dans dx
- [ ] Multi-tenant : `forTenant().transaction()`
- [ ] Tests: commit, rollback
- [ ] Documenter : "Ce qui est supporté dépend de l'adapter sous-jacent"

---

### DX-026: Upsert Support

**Priority:** HIGH | **Effort:** M

Support `INSERT ... ON CONFLICT` (PostgreSQL) / `INSERT OR REPLACE` (SQLite).

**Philosophie : Passthrough vers l'adapter**
- RETURNING → si Kysely/PostgreSQL le supporte, on l'expose
- Syntaxe SQLite différente → géré par DialectCapabilities

**API :**
```typescript
// Update colonnes spécifiques
orm.upsert('users')
   .values({ id: 1, name: 'John', email: 'john@example.com' })
   .onConflict('id')
   .doUpdate(['name', 'email'])
   .execute()

// Update avec valeurs custom
orm.upsert('users')
   .values({ id: 1, name: 'John' })
   .onConflict('id')
   .doUpdate({ name: 'John Updated', updated_at: new Date() })
   .execute()

// Composite key
orm.upsert('order_items')
   .values({ order_id: 1, product_id: 42, qty: 5 })
   .onConflict(['order_id', 'product_id'])
   .doUpdate(['qty'])
   .execute()

// Do nothing (INSERT ... ON CONFLICT DO NOTHING)
orm.upsert('users')
   .values({ id: 1, name: 'John' })
   .onConflict('id')
   .doNothing()
   .execute()

// Avec RETURNING (PostgreSQL) - passthrough vers Kysely
const user = await orm.upsert('users')
   .values({ id: 1, name: 'John' })
   .onConflict('id')
   .doUpdate(['name'])
   .returning(['id', 'name', 'updated_at'])
   .execute()
// → { id: 1, name: 'John', updated_at: Date }
```

**Tâches :**
- [ ] Core: `UpsertIntent` type
- [ ] Adapter: `compileUpsert()` avec support PostgreSQL
- [ ] DX: `UpsertBuilder` avec `.values()`, `.onConflict()`, `.doUpdate()`, `.doNothing()`, `.returning()`, `.execute()`, `.dump()`
- [ ] Multi-tenant: schema prefix support
- [ ] Tests: single key, composite key, doUpdate, doNothing, returning
- [ ] DialectCapabilities: `supportsUpsert`, `supportsReturning`

---

### DX-027: Raw SQL Escape Hatch

**Priority:** HIGH | **Effort:** S

Permettre du SQL brut pour les cas non couverts par l'ORM.

**API :**
```typescript
// Query complète raw
const users = await orm.raw<User[]>`
  SELECT * FROM users
  WHERE jsonb_data @> '{"role": "admin"}'
`;

// Raw dans un where (expression)
import { raw } from '@db-semantic-planner/dx';

orm.select('users')
   .where(raw`age > 18 AND jsonb_field @> '{"active": true}'`)
   .all()

// Raw avec paramètres (sécurisé)
orm.select('products')
   .where(raw`price BETWEEN ${minPrice} AND ${maxPrice}`)
   .all()

// Raw pour colonnes calculées
orm.select('orders')
   .columns(['id', raw`total * 1.2 AS total_with_tax`])
   .all()
```

**Sécurité :**
- Template literals avec paramètres → binding automatique (pas d'injection)
- `orm.raw` pour queries complètes
- `raw` helper pour expressions dans where/columns

**Tâches :**
- [ ] Helper `raw` pour expressions (tagged template literal)
- [ ] `orm.raw<T>()` pour queries complètes
- [ ] Binding automatique des paramètres (sécurité injection SQL)
- [ ] Intégration avec `where()`, `columns()`
- [ ] Multi-tenant : schema prefix dans raw queries ?
- [ ] Tests: expressions, full queries, paramètres

---

### DX-028: Pagination Helpers

**Priority:** MEDIUM | **Effort:** S

Helpers pour pagination offset-based et cursor-based.

**API Offset-based :**
```typescript
const page = await orm.select('users')
   .where(eq('active', true))
   .orderBy('created_at', 'desc')
   .paginate({ page: 2, perPage: 20 })
   .execute()

// → {
//   data: User[],
//   pagination: {
//     page: 2,
//     perPage: 20,
//     total: 156,
//     totalPages: 8,
//     hasNextPage: true,
//     hasPrevPage: true
//   }
// }
```

**API Cursor-based (pour gros datasets) :**
```typescript
const page = await orm.select('users')
   .orderBy('id')
   .cursorPaginate({ cursor: 'eyJpZCI6MTAwfQ==', limit: 20 })
   .execute()

// → {
//   data: User[],
//   nextCursor: 'eyJpZCI6MTIwfQ==' | null,
//   prevCursor: 'eyJpZCI6MTAxfQ==' | null
// }
```

**Implémentation :**
- Offset-based : `LIMIT` + `OFFSET` + COUNT query séparée
- Cursor-based : Encode/decode cursor (base64 JSON), `WHERE id > cursor LIMIT n+1`

**Tâches :**
- [ ] `paginate({ page, perPage })` méthode
- [ ] `PaginatedResult<T>` type avec metadata
- [ ] COUNT query optimisée (ou option `withCount: false`)
- [ ] `cursorPaginate({ cursor, limit })` méthode
- [ ] Cursor encode/decode (base64 JSON du dernier ID)
- [ ] Tests: première page, milieu, dernière, empty

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
