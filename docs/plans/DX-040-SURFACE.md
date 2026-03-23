---
doc-meta:
  status: draft
  scope: core
  type: specification
  target_project: /mnt/wsl/shared/dev/db-semantic-planner
  created: 2026-03-23
  updated: 2026-03-23
  complexity: SIMPLE
  time-budget: 60min
---

# Specification: DX-040-SURFACE — Typed ORM Public API

## 0. Quick Reference

| Item | Value |
|------|-------|
| Scope | core (OrmInstance, createOrm) |
| Complexity | SIMPLE |
| Time budget | ~60 min |
| Blocks | 3 |
| BDD scenarios | 8 |
| Risk level | LOW |
| Breaking | YES (v0.x, single consumer — accepted) |

## 1. Problem Statement

dbsp's public API uses string literals (`orm.select('users')`, `eq('id', 1)`) which prevents IDE autocomplete and compile-time validation. The typed infrastructure (TableRef, ColumnRef, schema.tables) already exists but isn't surfaced on OrmInstance. This spec bridges the gap.

## 2. User Stories

### US-1: Typed Entry Point
AS A dbsp consumer
I WANT `orm.from(users)` instead of `orm.select('users')`
SO THAT table names are validated at compile time and I get LSP autocomplete

ACCEPTANCE: `orm.from(users).where(eq(users.id, 1)).all()` compiles and executes correctly

### US-2: Table Discovery
AS A dbsp consumer
I WANT `const { users, posts } = orm.tables`
SO THAT I can discover available tables via destructuring + autocomplete

ACCEPTANCE: `orm.tables.users.id` returns `ColumnRef<'users', 'id', number>`

## 3. Business Rules

### 3.1 Invariants
- INV-01: `orm.from(table)` produces identical SQL to internal `select(tableName)`
- INV-02: `orm.tables` is a zero-cost accessor (no computation, returns pre-built proxy)
- INV-03: All existing QueryBuilder features work after `from()` (include, union, groupBy, etc.)

### 3.2 Preconditions
- PRE-01: Schema must be provided to `createOrm()` (already required)
- PRE-02: TableRef obtained via `orm.tables` destructuring (not constructed manually)

### 3.3 Effects
- EFF-01: `orm.from(tableRef)` returns `QueryBuilder<InferColumns<TTable>>`
- EFF-02: `orm.tables` returns the same `InferTables<T>` that `schema.tables` provides
- EFF-03: `orm.select(string)` removed from public `OrmInstance` type (internal-only)

### 3.4 Error Handling
- ERR-01: `orm.from(invalidRef)` → TypeScript compile error (type mismatch)
- ERR-02: Column typo `eq(users.typo, 1)` → TypeScript compile error

## 4. Technical Design

### 4.1 Architecture Decision

**Reuse QueryBuilder, not FromBuilder.** `orm.from(tableRef)` extracts the table name from the TableRef and delegates to the internal `select(tableName)`. This way ALL existing features (include, union, groupBy, having, etc.) work immediately. FromBuilder remains available for future use but is not the primary path.

**Why not FromBuilder?** FromBuilder has a different method surface (`.pick()` instead of `.columns()`, different chaining). Reusing QueryBuilder means zero feature gap and zero code duplication.

### 4.2 Key Types

```typescript
// TableRef already has TABLE_META symbol carrying the table name
// Extract table name: type ExtractTableName<T> = T extends TableRef<infer N, any, any> ? N : never;

// OrmInstance gains:
interface OrmInstance<DB> {
  // NEW: typed entry point
  tables: InferTables<SchemaDefinition>;
  from<TTable extends TableRef<any, any, any>>(
    table: TTable
  ): QueryBuilder<InferColumnsFromTableRef<TTable>>;

  // REMOVED from public type: select(from: string)
  // (still exists at runtime for internal use by NQL, planner, etc.)

  // Mutations stay string-based for now (Phase 2)
  insert(table: string): InsertBuilder;
  update(table: string): UpdateBuilder;
  delete(table: string): DeleteBuilder;
  upsert(table: string): UpsertBuilder;

  // Other methods unchanged
  raw<T>(sql: string, params?: unknown[]): Promise<T[]>;
  withSchema(schema: string): OrmInstance<DB>;
  withCte(name: string): CteBuilder;
  // ...
}
```

### 4.3 Runtime Implementation

```typescript
// In createOrm():
const tablesProxy = createTablesProxy(schema); // ← already exists!

return {
  tables: tablesProxy,
  from(tableRef) {
    const tableName = tableRef[TABLE_META]; // Symbol-based name extraction
    return internalSelect(tableName);       // delegates to existing select()
  },
  // ... rest unchanged
};
```

## 5. Acceptance Criteria (BDD)

### Scenario Group: Table Discovery

```gherkin
@priority:high @type:nominal
Scenario: SC-01 — Destructure tables from ORM
  Given a schema with tables 'users' and 'posts'
  And an ORM created with that schema
  When I destructure `const { users, posts } = orm.tables`
  Then `users` is a TableRef with column accessors
  And `users.id` returns a ColumnRef

@priority:high @type:nominal
Scenario: SC-02 — Column autocomplete via ColumnRef
  Given `const { users } = orm.tables`
  When I access `users.name`
  Then it returns ColumnRef<'users', 'name', string>
  And TypeScript validates the column exists
```

### Scenario Group: Typed Queries

```gherkin
@priority:high @type:nominal
Scenario: SC-03 — Basic from() query
  Given `const { users } = orm.tables`
  When I execute `orm.from(users).where(eq(users.id, 1)).all()`
  Then SQL equals `SELECT * FROM "users" WHERE "id" = $1`
  And params equals [1]

@priority:high @type:nominal
Scenario: SC-04 — from() with columns
  Given `const { users } = orm.tables`
  When I execute `orm.from(users).columns(['id', 'name']).all()`
  Then SQL equals `SELECT "id", "name" FROM "users"`

@priority:high @type:nominal
Scenario: SC-05 — from() with include (string, Phase 1)
  Given `const { users } = orm.tables`
  When I execute `orm.from(users).include('posts').all()`
  Then SQL includes JOIN or subquery for posts relation

@priority:high @type:edge
Scenario: SC-06 — from() preserves set operations
  Given `const { users } = orm.tables`
  When I execute `orm.from(users).where(eq(users.active, true)).union(orm.from(users).where(eq(users.role, 'admin'))).all()`
  Then SQL contains UNION

@priority:high @type:error
Scenario: SC-07 — Column typo → compile error
  Given `const { users } = orm.tables`
  When I write `eq(users.typoColumn, 1)`
  Then TypeScript reports a compile error (property does not exist)

@priority:medium @type:edge
Scenario: SC-08 — select(string) removed from public type
  Given an ORM instance
  When I write `orm.select('users')`
  Then TypeScript reports an error (property 'select' does not exist on type OrmInstance)
  But internal code can still call the runtime select() method
```

**Coverage matrix:**

| Scenario | Nominal | Edge | Error |
|----------|:--:|:--:|:--:|
| SC-01 | ✓ | | |
| SC-02 | ✓ | | |
| SC-03 | ✓ | | |
| SC-04 | ✓ | | |
| SC-05 | ✓ | | |
| SC-06 | | ✓ | |
| SC-07 | | | ✓ |
| SC-08 | | ✓ | |

## 6. Implementation Plan

### Block 1: Add `orm.tables` + `orm.from()` — 30min
**Type:** Feature slice
**Dependencies:** None
**Files:**
- `packages/core/src/dx/orm-instance-types.ts` — Add `tables` and `from()` to OrmInstance interface, remove `select()` from public type
- `packages/core/src/dx/orm.ts` — Expose `tablesProxy` as `tables`, implement `from()` extracting table name via `TABLE_META` symbol
- `packages/core/src/dx/table-ref.ts` — Verify `TABLE_META` export, add `InferColumnsFromTableRef` utility type if missing

**Exit criteria:**
- [ ] `orm.tables.users` returns TableRef at runtime
- [ ] `orm.from(users)` returns QueryBuilder
- [ ] `orm.select('users')` is TypeScript error on public type
- [ ] TypeScript compiles clean

### Block 2: Tests — 20min
**Type:** Test coverage
**Dependencies:** Block 1
**Files:**
- `packages/core/src/dx/__tests__/typed-orm.test.ts` — NEW: runtime tests for from(), tables, SQL output
- `packages/core/src/dx/__tests__/typed-orm.typetest.ts` — NEW: compile-time type assertions (expectType patterns)

**Exit criteria:**
- [ ] SC-01 through SC-06 have passing tests
- [ ] SC-07 and SC-08 verified via type-level tests
- [ ] All existing tests still pass (from() delegates to same select() internals)

### Block 3: Docs + migration — 10min
**Type:** Documentation
**Dependencies:** Block 2
**Files:**
- `docs/guides/orm-api.md` — Update "Getting Started" to use `from()` pattern
- `CLAUDE.md` — Update API Pattern section
- `README.md` — Update Quick Start example

**Exit criteria:**
- [ ] All code examples use `orm.from()` pattern
- [ ] Legacy `select(string)` mentioned as internal-only

## 7. Test Strategy

| Level | Count | Focus |
|-------|:--:|-------|
| Unit (runtime) | 6 | from() SQL output, tables property, include/union compat |
| Type-level | 2 | Column typo error, select removed from public type |

No integration/E2E needed — `from()` delegates to existing `select()` which is already fully tested.

## 8. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|:--:|:--:|------------|
| Existing tests use `orm.select()` | M | HIGH | Keep runtime select() — only remove from TYPE, not implementation |
| InferColumnsFromTableRef complex | L | LOW | TableRef generics already carry column info |
| NQL/CLI internally use select() | M | MEDIUM | Internal code uses runtime object, not type — unaffected |

## 9. Definition of Done

- [ ] `orm.tables` returns typed TableRef objects
- [ ] `orm.from(tableRef)` returns QueryBuilder with correct TResult
- [ ] `orm.select(string)` is TS error on public OrmInstance type
- [ ] 8 BDD scenarios covered (6 runtime + 2 type-level)
- [ ] All existing 7000+ tests still pass
- [ ] Documentation updated (orm-api.md, CLAUDE.md, README.md)
- [ ] /review clean
