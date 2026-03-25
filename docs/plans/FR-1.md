---
doc-meta:
  status: draft
  scope: types, core, adapter-pgsql
  type: spec
  story: FR-1
  created: 2026-03-25
  adversarial_applied: true
---

# FR-1 — DDL Helpers: Table-Scoped API

## Problem Statement

astix has 10 `orm.raw()` calls for DDL operations (TRUNCATE, DROP INDEX, CREATE INDEX, ALTER COLUMN, VACUUM). These bypass identifier quoting, schema scoping, and type safety. A table-scoped DDL API eliminates these raw calls.

## API Design

### Table-scoped operations

```typescript
const { embeddings, symbols } = orm.tables;

// Table maintenance
await embeddings.truncate();                                    // TRUNCATE "embeddings"
await embeddings.truncate({ cascade: true });                   // TRUNCATE "embeddings" CASCADE
await embeddings.vacuum();                                      // VACUUM "embeddings"
await embeddings.vacuum({ full: true });                        // VACUUM FULL "embeddings"
await embeddings.vacuum({ analyze: true });                     // VACUUM ANALYZE "embeddings"

// Column alteration
await embeddings.alterColumn('vector', { type: 'vector(384)' }); // ALTER TABLE "embeddings" ALTER COLUMN "vector" TYPE vector(384)

// Index management
await embeddings.indexes.create({
  name: 'idx_embeddings_vector',
  columns: ['vector'],
  method: 'hnsw',
  opclass: { vector: 'vector_cosine_ops' },
  with: { m: 16, ef_construction: 64 },
});
// CREATE INDEX "idx_embeddings_vector" ON "embeddings" USING hnsw ("vector" vector_cosine_ops) WITH (m = 16, ef_construction = 64)

await embeddings.indexes.drop('idx_embeddings_vector', { ifExists: true });
// DROP INDEX IF EXISTS "idx_embeddings_vector"

await embeddings.indexes.list();
// SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'embeddings' AND schemaname = $1
```

### Schema-scoped

```typescript
const scoped = orm.withSchema('tenant_42');
await scoped.tables.embeddings.truncate();
// TRUNCATE "tenant_42"."embeddings"

await scoped.tables.embeddings.indexes.create({ name: 'idx_foo', columns: ['bar'] });
// CREATE INDEX "idx_foo" ON "tenant_42"."embeddings" ("bar")
```

### Global DDL shortcuts

```typescript
// When table context is not needed
await orm.ddl.dropIndex('idx_name', { ifExists: true });
// DROP INDEX IF EXISTS "idx_name"

await orm.ddl.dropIndex('idx_name', { ifExists: true, schema: 'tenant_42' });
// DROP INDEX IF EXISTS "tenant_42"."idx_name"
```

## Type Definitions

### CreateIndexOptions

```typescript
type IndexMethod = 'btree' | 'hash' | 'gist' | 'gin' | 'brin' | 'hnsw' | 'ivfflat' | 'bm25';

type IndexColumnDef = string | {
  expression: string;                 // raw SQL expression (e.g., 'lower(email)')
  opclass?: string;                   // operator class for this column
};

type CreateIndexOptions = {
  name: string;
  columns: IndexColumnDef[];          // column names or expression definitions
  method?: IndexMethod;               // default: 'btree'
  opclass?: Record<string, string>;   // column → operator class (shorthand for simple cases)
  include?: string[];                 // covering index columns (INCLUDE clause)
  with?: Record<string, unknown>;     // storage parameters
  where?: string;                     // partial index predicate (raw SQL — escape hatch)
  unique?: boolean;
  ifNotExists?: boolean;
  concurrently?: boolean;
};
```

### DropIndexOptions

```typescript
type DropIndexOptions = {
  ifExists?: boolean;
  cascade?: boolean;
  concurrently?: boolean;
  schema?: string;                    // for global orm.ddl.dropIndex
};
```

### VacuumOptions

```typescript
type VacuumOptions = {
  full?: boolean;
  analyze?: boolean;
};
```

### TruncateOptions

```typescript
type TruncateOptions = {
  cascade?: boolean;
  restartIdentity?: boolean;
};
```

### AlterColumnOptions

```typescript
type AlterColumnOptions = {
  type?: string;                      // new column type (raw PG type name)
  using?: string;                     // USING expression for type conversion
  setNotNull?: boolean;               // SET NOT NULL (true) or DROP NOT NULL (false)
  setDefault?: unknown;               // SET DEFAULT value
  dropDefault?: boolean;              // DROP DEFAULT
};
```

### IndexInfo (return type of indexes.list)

```typescript
type IndexInfo = {
  name: string;
  definition: string;                 // full CREATE INDEX statement
  unique: boolean;
  method: string;
};
```

## Architecture

### TableDDL class

```
TableRef (existing)
  └── .truncate(), .vacuum(), .alterColumn()  ← NEW methods
  └── .indexes                                ← NEW sub-object
        └── .create(), .drop(), .list()
```

`TableRef` currently holds `tableName` and `TABLE_META`. It needs access to the adapter for execution. Two options:

**Option A: Inject adapter into TableRef** — TableRef gains an `adapter` reference at creation time (via `orm.tables` proxy).

**Option B: Return DDL builder that needs .execute(adapter)** — TableRef methods return a DDL intent, execution is separate.

**Recommended: Option A** — cleaner DX (`await embeddings.truncate()` vs `await embeddings.truncate().execute(adapter)`). The adapter is already available in the ORM instance that creates the tables proxy.

### SQL Generation

DDL SQL is generated in `adapter-pgsql` (not core). Core defines the interface, adapter implements.

```
core: TableDDL interface (truncate, vacuum, etc.)
adapter-pgsql: PgsqlTableDDL implements TableDDL (generates PostgreSQL DDL SQL)
```

The DDL methods delegate to the adapter's DDL generator which:
1. Quotes all identifiers
2. Applies schema prefix if `withSchema()` was used
3. Parameterizes values where possible (index names are identifiers, not params)
4. Executes via `adapter.execute(sql)`

### Security

- Table/column/index names: identifier quoting via `quoteIdentifier()`
- Schema names: identifier quoting
- `where` in CreateIndexOptions: raw SQL string — documented escape hatch, user responsibility
- `type` in AlterColumnOptions: validated via `validateDbTypeName()` (existing)
- `using` in AlterColumnOptions: raw SQL — documented escape hatch

## BDD Scenarios

### Table operations

```gherkin
Scenario: truncate generates correct SQL
  Given orm.tables.embeddings.truncate()
  Then SQL is: TRUNCATE "embeddings"
  And no parameters

Scenario: truncate with cascade
  Given orm.tables.embeddings.truncate({ cascade: true })
  Then SQL is: TRUNCATE "embeddings" CASCADE

Scenario: truncate with schema scope
  Given orm.withSchema('tenant').tables.embeddings.truncate()
  Then SQL is: TRUNCATE "tenant"."embeddings"

Scenario: vacuum full
  Given orm.tables.embeddings.vacuum({ full: true })
  Then SQL is: VACUUM FULL "embeddings"

Scenario: vacuum analyze
  Given orm.tables.embeddings.vacuum({ analyze: true })
  Then SQL is: VACUUM ANALYZE "embeddings"

Scenario: alter column type
  Given orm.tables.embeddings.alterColumn('vector', { type: 'vector(384)' })
  Then SQL is: ALTER TABLE "embeddings" ALTER COLUMN "vector" TYPE vector(384)

Scenario: alter column type with USING
  Given orm.tables.embeddings.alterColumn('vector', { type: 'vector(384)', using: 'vector::vector(384)' })
  Then SQL is: ALTER TABLE "embeddings" ALTER COLUMN "vector" TYPE vector(384) USING vector::vector(384)
```

### Index operations

```gherkin
Scenario: create basic index
  Given orm.tables.embeddings.indexes.create({ name: 'idx_model', columns: ['model'] })
  Then SQL is: CREATE INDEX "idx_model" ON "embeddings" ("model")

Scenario: create HNSW index with opclass and storage params
  Given orm.tables.embeddings.indexes.create({
    name: 'idx_vec', columns: ['vector'], method: 'hnsw',
    opclass: { vector: 'vector_cosine_ops' }, with: { m: 16, ef_construction: 64 }
  })
  Then SQL is: CREATE INDEX "idx_vec" ON "embeddings" USING hnsw ("vector" vector_cosine_ops) WITH (m = 16, ef_construction = 64)

Scenario: create unique index
  Given orm.tables.embeddings.indexes.create({ name: 'idx_uniq', columns: ['model', 'symbol_id'], unique: true })
  Then SQL is: CREATE UNIQUE INDEX "idx_uniq" ON "embeddings" ("model", "symbol_id")

Scenario: create partial index
  Given orm.tables.embeddings.indexes.create({ name: 'idx_active', columns: ['status'], where: "status = 'active'" })
  Then SQL is: CREATE INDEX "idx_active" ON "embeddings" ("status") WHERE status = 'active'

Scenario: create index concurrently
  Given orm.tables.embeddings.indexes.create({ name: 'idx_conc', columns: ['model'], concurrently: true })
  Then SQL is: CREATE INDEX CONCURRENTLY "idx_conc" ON "embeddings" ("model")

Scenario: create index if not exists
  Given orm.tables.embeddings.indexes.create({ name: 'idx_safe', columns: ['model'], ifNotExists: true })
  Then SQL is: CREATE INDEX IF NOT EXISTS "idx_safe" ON "embeddings" ("model")

Scenario: create index with schema scope
  Given orm.withSchema('tenant').tables.embeddings.indexes.create({ name: 'idx_t', columns: ['model'] })
  Then SQL is: CREATE INDEX "idx_t" ON "tenant"."embeddings" ("model")

Scenario: drop index if exists
  Given orm.tables.embeddings.indexes.drop('idx_vec', { ifExists: true })
  Then SQL is: DROP INDEX IF EXISTS "idx_vec"

Scenario: drop index with cascade
  Given orm.tables.embeddings.indexes.drop('idx_vec', { cascade: true })
  Then SQL is: DROP INDEX "idx_vec" CASCADE

Scenario: list indexes
  Given orm.tables.embeddings.indexes.list()
  Then query pg_indexes WHERE tablename = 'embeddings'
  And returns IndexInfo[]

Scenario: global drop index
  Given orm.ddl.dropIndex('idx_name', { ifExists: true })
  Then SQL is: DROP INDEX IF EXISTS "idx_name"
```

### Edge cases (from /adversarial)

```gherkin
Scenario: CREATE INDEX CONCURRENTLY cannot be in a transaction
  Given adapter is in a transaction
  When embeddings.indexes.create({ name: 'idx', columns: ['x'], concurrently: true })
  Then adapter executes OUTSIDE the current transaction (or throws if not possible)

Scenario: VACUUM FULL acquires exclusive lock
  Given orm.tables.embeddings.vacuum({ full: true })
  Then SQL is: VACUUM FULL "embeddings"
  And JSDoc warns about exclusive table lock

Scenario: multi-column index with per-column opclass
  Given orm.tables.embeddings.indexes.create({
    name: 'idx_multi', columns: ['a', 'b'],
    opclass: { a: 'text_pattern_ops', b: 'varchar_ops' }
  })
  Then SQL is: CREATE INDEX "idx_multi" ON "embeddings" ("a" text_pattern_ops, "b" varchar_ops)
```

### Index features (from /llm consensus)

```gherkin
Scenario: create covering index with INCLUDE
  Given orm.tables.embeddings.indexes.create({
    name: 'idx_cover', columns: ['model'], include: ['symbol_id', 'vector']
  })
  Then SQL is: CREATE INDEX "idx_cover" ON "embeddings" ("model") INCLUDE ("symbol_id", "vector")

Scenario: create expression index
  Given orm.tables.embeddings.indexes.create({
    name: 'idx_lower', columns: [{ expression: 'lower(name)' }]
  })
  Then SQL is: CREATE INDEX "idx_lower" ON "embeddings" (lower(name))

Scenario: alter column SET NOT NULL
  Given orm.tables.embeddings.alterColumn('model', { setNotNull: true })
  Then SQL is: ALTER TABLE "embeddings" ALTER COLUMN "model" SET NOT NULL

Scenario: alter column DROP DEFAULT
  Given orm.tables.embeddings.alterColumn('model', { dropDefault: true })
  Then SQL is: ALTER TABLE "embeddings" ALTER COLUMN "model" DROP DEFAULT
```

### Transaction safety (from /llm consensus)

```gherkin
Scenario: VACUUM inside transaction throws
  Given adapter is inside a transaction
  When orm.tables.embeddings.vacuum()
  Then throws "VACUUM cannot run inside a transaction"

Scenario: CREATE INDEX CONCURRENTLY inside transaction throws
  Given adapter is inside a transaction
  When orm.tables.embeddings.indexes.create({ name: 'x', columns: ['y'], concurrently: true })
  Then throws "CREATE INDEX CONCURRENTLY cannot run inside a transaction"
```

### Error handling

```gherkin
Scenario: truncate on compile-only adapter throws
  Given createPgsqlCompileOnlyAdapter()
  When orm.tables.embeddings.truncate()
  Then throws "Cannot execute DDL on compile-only adapter"

Scenario: invalid index method rejected
  Given orm.tables.embeddings.indexes.create({ name: 'x', columns: ['y'], method: 'invalid' as any })
  Then throws with method validation error
```

## Implementation Blocks

### Block 1: Types + Core interfaces

**Files:**
- MODIFY `packages/types/src/adapter.ts` — add optional DDL methods to Adapter interface
- CREATE `packages/core/src/dx/table-ddl.ts` — TableDDL interface + types (CreateIndexOptions, etc.)
- MODIFY `packages/core/src/dx/orm-instance.ts` — extend tables proxy to inject adapter, add DDL methods to TableRef
- MODIFY `packages/core/src/dx/index.ts` — export new types

**Exit criteria:**
- `orm.tables.X.truncate()` compiles (types only, no runtime)
- `orm.tables.X.indexes.create({...})` compiles
- `orm.ddl.dropIndex()` compiles
- TSC clean

### Block 2: Adapter DDL implementation

**Files:**
- CREATE `packages/adapter-pgsql/src/ddl/table-operations.ts` — SQL generation for truncate, vacuum, alterColumn
- CREATE `packages/adapter-pgsql/src/ddl/index-operations.ts` — SQL generation for createIndex, dropIndex, listIndexes
- MODIFY `packages/adapter-pgsql/src/pgsql-adapter.ts` — implement DDL methods from Adapter interface

**Exit criteria:**
- All BDD scenarios produce correct SQL
- Identifier quoting verified
- Schema scoping verified
- 20+ tests pass

### Block 3: Integration tests + documentation

**Files:**
- CREATE `packages/adapter-pgsql/src/__tests__/ddl-table-ops.test.ts`
- MODIFY docs (CLAUDE.md DDL section)

**Exit criteria:**
- All BDD scenarios have tests with exact SQL matching (toEqual, not toContain)
- Compile-only adapter throws on execute
- Schema-scoped tests pass
- All existing tests still pass

## Risk Analysis

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| TableRef coupling to adapter | LOW | MEDIUM | Clean interface, adapter injected at proxy level |
| Breaking existing TableRef API | LOW | HIGH | Additive only, no existing method changes |
| SQL injection via `where` param | MEDIUM | HIGH | Document as escape hatch, validate in adapter |
| VACUUM/TRUNCATE outside transaction | LOW | LOW | Document that these are DDL, not transactional |

## Out of Scope

- DDL migration tracking (already exists in `ddl/migration-tracker.ts`)
- Schema diffing (already exists in `compareSchemata`)
- Table creation/drop (too broad, defer)
- Multi-table TRUNCATE (single table for now)
- FR-2 system catalog beyond `indexes.list()`
