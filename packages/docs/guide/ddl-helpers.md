---
title: DDL Helpers
---

# How to Use DDL Helpers

The DDL helpers give you a type-safe API for table maintenance and index management operations directly from your ORM instance, without writing raw SQL. Use this guide when you need to truncate tables, create or drop indexes, alter columns, or check table storage size — especially in multi-tenant setups where schema scoping matters.

## When

When you need to run DDL operations (TRUNCATE, VACUUM, CREATE/DROP INDEX, ALTER COLUMN) or check
table storage size without writing raw SQL. All helpers are available via `orm.tables.<name>` and
respect `orm.withSchema()` for multi-tenant isolation.

## API

### Table Maintenance

```typescript
// doctest: skip — mixed API reference + exec-only example; storageSize() requires a real PostgreSQL connection
// TRUNCATE TABLE — remove all rows
orm.tables.users.truncate(options?)
// options: { cascade?: boolean; restartIdentity?: boolean }

// VACUUM — reclaim storage, update statistics
orm.tables.users.vacuum(options?)
// options: { full?: boolean; analyze?: boolean }

// Storage size — total bytes (table + indexes + TOAST)
const bytes = await orm.tables.users.storageSize()
```

### Column Alteration

```typescript
// doctest: skip — API signature reference; not executable code
orm.tables.users.alterColumn(column, options)
// column: string
// options: AlterColumnOptions {
//   type?: string         — new column type expression (e.g. 'text', 'integer')
//   using?: string        — USING clause for type conversion (raw SQL expression)
//   setNotNull?: boolean  — add or drop NOT NULL constraint
//   setDefault?: unknown  — set DEFAULT value
//   dropDefault?: boolean — drop DEFAULT
// }
// returns: Promise<void>
```

### Index Management

```typescript
// doctest: skip — API signature reference; not executable code
// Create an index
orm.tables.users.indexes.create(options)   // options: CreateIndexOptions → Promise<void>

// Drop an index
orm.tables.users.indexes.drop(name, options)  // name: string, options?: DropIndexOptions → Promise<void>

// List indexes on the table
orm.tables.users.indexes.list(options)
// options?: { namePattern?: string } → Promise<IndexInfo[]>
// IndexInfo: { name: string; definition: string; unique: boolean; method: string }
// namePattern supports SQL LIKE wildcards: % and _

// Check if an index exists
orm.tables.users.indexes.exists(name)  // name: string → Promise<boolean>
```

**`CreateIndexOptions`** fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | yes | Index name |
| `columns` | `IndexColumnDef[]` | yes | Columns to index |
| `method` | `IndexMethod` | no | Access method: `btree` (default), `hash`, `gist`, `gin`, `brin`, `spgist`, `bloom`, `hnsw`, `ivfflat`, `bm25` |
| `opclass` | `Record<string, string>` | no | Per-column operator class (e.g. `{ vector: 'vector_cosine_ops' }`) |
| `include` | `string[]` | no | Covering index columns (INCLUDE) |
| `with` | `Record<string, unknown>` | no | Storage parameters (e.g. `{ m: 16, ef_construction: 64 }`) |
| `where` | `string` | no | Partial index predicate (raw SQL — see Gotchas) |
| `unique` | `boolean` | no | Unique index |
| `nullsNotDistinct` | `boolean` | no | PG15+ `NULLS NOT DISTINCT`; valid only on unique indexes and fails loudly on non-unique indexes |
| `ifNotExists` | `boolean` | no | Skip if already exists |
| `concurrently` | `boolean` | no | Non-blocking CREATE INDEX CONCURRENTLY |

**`DropIndexOptions`** fields: `{ ifExists?, cascade?, concurrently? }`

### Global Shortcuts

```typescript
// doctest: skip — API signature reference; not executable code
// Drop an index when you don't have a table reference
orm.ddl.dropIndex(name, options)  // name: string, options?: DropIndexOptions → Promise<void>
```

### Schema Scoping

All DDL methods are schema-scoped. Scope DDL with `orm.withSchema('public')` or
a tenant schema; there is no bare schema-scoped DDL that relies on PostgreSQL
`search_path`. If you do not scope an ORM explicitly, DDL uses `public`.

```typescript
// doctest: skip — exec-only DDL operation; requires a real PostgreSQL connection and table bootstrap
const tenantOrm = orm.withSchema('tenant_42')
tenantOrm.tables.users.truncate()
// SQL: TRUNCATE "tenant_42"."users"
```

## Examples

### 1. Truncate with cascade and identity reset

```typescript
// doctest: skip — exec-only DDL operation; requires a real PostgreSQL connection and table bootstrap
import { schema, createOrm } from '@dbsp/core';
import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';
const __db = schema({ orders: { id: 'integer', total: 'integer' } });
const __orm = createOrm({ schema: __db, adapter: createPgsqlAdapter(pool) });

// Clear orders and all dependent rows, reset auto-increment sequences
await __orm.tables.orders.truncate({ cascade: true, restartIdentity: true })
```

Generated SQL:
```sql
TRUNCATE "public"."orders" CASCADE RESTART IDENTITY
```

### 2. VACUUM FULL with ANALYZE

```typescript
// doctest: skip — exec-only DDL operation; requires a real PostgreSQL connection and table bootstrap
import { schema, createOrm } from '@dbsp/core';
import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';
const __db = schema({ events: { id: 'integer', type: 'string', occurredAt: 'timestamp' } });
const __orm = createOrm({ schema: __db, adapter: createPgsqlAdapter(pool) });

// Reclaim storage and update planner statistics (locks table)
await __orm.tables.events.vacuum({ full: true, analyze: true })
```

Generated SQL:
```sql
VACUUM FULL ANALYZE "public"."events"
```

### 3. HNSW vector index

```typescript
// doctest: skip — exec-only DDL operation; requires a real PostgreSQL connection and table bootstrap
import { schema, createOrm } from '@dbsp/core';
import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';
const __db = schema({ embeddings: { id: 'integer', vector: { type: 'text', dbType: 'vector(384)', nullable: true } } });
const __orm = createOrm({ schema: __db, adapter: createPgsqlAdapter(pool) });

await __orm.tables.embeddings.indexes.create({
  name: 'idx_embeddings_vector_hnsw',
  columns: ['vector'],
  method: 'hnsw',
  opclass: { vector: 'vector_cosine_ops' },
  with: { m: 16, ef_construction: 64 },
  ifNotExists: true,
})
```

Generated SQL:
```sql
CREATE INDEX IF NOT EXISTS "idx_embeddings_vector_hnsw"
  ON "public"."embeddings" USING hnsw ("vector" vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
```

### 4. Expression index (partial)

```typescript
// doctest: real-db-only — requires a live PostgreSQL connection
await orm.tables.users.indexes.create({
  name: 'idx_users_email_lower',
  columns: ['email'],
  where: '"active" = true',
})
```

Generated SQL:
```sql
CREATE INDEX "idx_users_email_lower"
  ON "public"."users" ("email")
  WHERE "active" = true
```

### 5. ALTER COLUMN type with USING

```typescript
// doctest: skip — exec-only DDL operation; requires a real PostgreSQL connection and table bootstrap
import { schema, createOrm } from '@dbsp/core';
import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';
const __db = schema({ products: { id: 'integer', name: 'string', price_cents: 'string' } });
const __orm = createOrm({ schema: __db, adapter: createPgsqlAdapter(pool) });

// Convert a text column to integer, with explicit cast
await __orm.tables.products.alterColumn('price_cents', {
  type: 'integer',
  using: '"price_cents"::integer',
})
```

Generated SQL:
```sql
ALTER TABLE "public"."products"
  ALTER COLUMN "price_cents" TYPE integer USING "price_cents"::integer
```

### 6. Index existence check before operation

```typescript
// doctest: real-db-only — requires a live PostgreSQL connection
const exists = await orm.tables.users.indexes.exists('idx_users_email')
if (!exists) {
  await orm.tables.users.indexes.create({
    name: 'idx_users_email',
    columns: ['email'],
    unique: true,
  })
}
```

### 7. List indexes and check storage

```typescript
// doctest: skip — exec-only DDL operation; requires a real PostgreSQL connection and table bootstrap
import { schema, createOrm } from '@dbsp/core';
import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';
const __db = schema({ embeddings: { id: 'integer', vector: { type: 'text', dbType: 'vector(384)', nullable: true } } });
const __orm = createOrm({ schema: __db, adapter: createPgsqlAdapter(pool) });

// List indexes matching a pattern
const vecIndexes = await __orm.tables.embeddings.indexes.list({
  namePattern: 'idx_embeddings_%',
})

// Check table storage (bytes)
const size = await __orm.tables.embeddings.storageSize()
console.log(`embeddings table: ${(size / 1024 / 1024).toFixed(1)} MB`)
```

## Key Files

- **Option types:** `packages/types/src/adapter.ts` — `TruncateOptions`, `VacuumOptions`, `AlterColumnOptions`, `CreateIndexOptions`, `DropIndexOptions`, `IndexInfo`, `IndexMethod`
- **TableDDL / TableIndexes types:** `packages/core/src/dx/table-ddl-types.ts` — public interface
- **Core delegation:** `packages/core/src/dx/orm-instance.ts` — `buildTableDDL()`, delegates all SQL generation to adapter
- **Adapter SQL (tables):** `packages/adapter-pgsql/src/pgsql-adapter.ts` — `generateTruncate()`, `generateVacuum()`, `generateAlterColumn()`
- **Adapter SQL (indexes):** `packages/adapter-pgsql/src/ddl/index-operations.ts` — `generateCreateIndexSQL()`, `generateDropIndexSQL()`

## Gotchas

- **VACUUM cannot run inside a transaction** — calling `vacuum()` will throw if called within a transaction block. The adapter executes it outside any transaction automatically, but if you wrap it manually you'll get a PostgreSQL error.
- **CREATE INDEX CONCURRENTLY cannot run inside a transaction** — same constraint. Use `concurrently: true` only outside explicit transaction blocks.
- **`where` in `CreateIndexOptions` is raw SQL** — it is not parameterized. Never interpolate untrusted user input into this field. Use hard-coded SQL expressions only (e.g. `'"active" = true'`).
- **`storageSize()` uses `pg_total_relation_size`** — this includes the table heap, indexes, and TOAST storage. For heap-only size use `pg_relation_size`.
- **Core generates zero SQL** — all DDL SQL is delegated to the adapter. If you use `createPgsqlCompileOnlyAdapter()`, DDL methods that require a live connection (truncate, vacuum, storageSize) will throw.
- **`alterColumn` with `setNotNull: true`** triggers a full table scan in PostgreSQL to validate the constraint. On large tables, prefer adding a CHECK constraint first and then promoting it.
