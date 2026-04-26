---
title: Extensions (pgvector + ParadeDB)
---

# How to Use Extensions (pgvector + ParadeDB)

This guide shows how to use the pgvector and ParadeDB extension helpers that ship with `@dbsp/adapter-pgsql`. Use it when you need vector similarity search (ANN/cosine/L2), BM25 full-text relevance ranking, or when you want to write your own extension wrappers on top of the expression primitive system.

## When

Use extensions when you need PostgreSQL-native capabilities beyond standard SQL:

- **pgvector** — nearest-neighbour / similarity search on embedding vectors
- **ParadeDB** — full-text BM25 search with per-field boost weights

Both extensions are implemented as thin wrappers over expression primitives and are
imported from `@dbsp/adapter-pgsql`.

## Available Extensions

| Package | Extension | Import |
|---------|-----------|--------|
| `@dbsp/adapter-pgsql` | pgvector | `cosineDistance`, `rawDistance`, `l2Distance`, `innerProduct` |
| `@dbsp/adapter-pgsql` | ParadeDB | `score`, `parse`, `boost`, `booleanSearch`, `bm25Search` |

---

## pgvector

### Full Example

```typescript
import { schema, createOrm } from '@dbsp/core';
import { createPgsqlCompileOnlyAdapter, cosineDistance, rawDistance } from '@dbsp/adapter-pgsql';

const db = schema({
  embeddings: {
    id: { type: 'integer', autoIncrement: true, primaryKey: true },
    vector: { type: 'text', dbType: 'vector(768)' },
    symbolId: 'integer',
  },
  symbols: {
    id: { type: 'integer', primaryKey: true },
    name: 'text',
    signature: 'text',
  },
} as const);
const orm = createOrm({ schema: db, adapter: createPgsqlCompileOnlyAdapter() });

const qv = [0.1, 0.2, 0.3]; // query vector (same dimension as stored vectors)

const results = orm
  .select('embeddings')
  .include('symbols', { join: 'inner' })        // INNER JOIN — filter root rows
  .columns(['*', cosineDistance('vector', qv).as('score')])  // similarity score in SELECT
  .where(cosineDistance('vector', qv).gte(0.5))      // threshold filter
  .orderBy(rawDistance('vector', qv), 'asc')         // ANN index-friendly ORDER BY
  .limit(20)
  .dump();
// SQL:
//   SELECT 1 - ("embeddings"."vector" <=> $1::vector) AS "score", ...
//   FROM "embeddings"
//   INNER JOIN "symbols" ON ...
//   WHERE 1 - ("embeddings"."vector" <=> $2::vector) >= $3
//   ORDER BY "embeddings"."vector" <=> $4::vector ASC
//   LIMIT 20
```

### Distance Functions

| Function | Operator | Direction | Use case |
|----------|----------|-----------|----------|
| `cosineDistance(col, vec)` | `1 - (col <=> vec)` | Higher = more similar | Semantic similarity score in SELECT |
| `rawDistance(col, vec)` | `col <=> vec` | Lower = closer | ORDER BY (index-friendly ANN) |
| `l2Distance(col, vec)` | `col <-> vec` | Lower = closer | Euclidean ORDER BY |
| `innerProduct(col, vec)` | `col <#> vec` | Lower = more similar (negative) | Maximum inner product search |

**Important:** Use `cosineDistance` in SELECT for a human-readable score [0, 1].
Use `rawDistance` in ORDER BY — it maps directly to the index operator and avoids
a full-table recompute.

### DDL: HNSW Vector Index

```typescript
import { schema } from '@dbsp/core';

const db = schema(
  {
    embeddings: {
      id: { type: 'integer', autoIncrement: true, primaryKey: true },
      vector: { type: 'text', dbType: 'vector(768)' },
      symbolId: 'integer',
    },
  },
  {
    embeddings: {
      indexes: [
        {
          columns: ['vector'],
          method: 'hnsw',
          opclass: { vector: 'vector_cosine_ops' },
          with: { m: '16', ef_construction: '64' },
        },
      ],
    },
  },
);
// Generates:
//   CREATE INDEX IF NOT EXISTS ... ON "embeddings" USING hnsw ("vector" vector_cosine_ops)
//   WITH (m = 16, ef_construction = 64)
```

---

## ParadeDB

### Full Example

```typescript
import { schema, createOrm } from '@dbsp/core';
import { createPgsqlCompileOnlyAdapter, score, bm25Search } from '@dbsp/adapter-pgsql';

const db = schema({
  symbols: {
    id: { type: 'integer', autoIncrement: true, primaryKey: true },
    name: 'text',
    signature: 'text',
    doc_comment: 'text',
  },
} as const);
const orm = createOrm({ schema: db, adapter: createPgsqlCompileOnlyAdapter() });

const searchTerm = 'semantic query planner';

const results = orm
  .select('symbols')
  .columns([score('id').as('score')])                        // BM25 relevance score
  .where(bm25Search('symbols', searchTerm, {
    name: 3.0,          // 3x weight on name column
    signature: 1.5,     // 1.5x weight on signature
    doc_comment: 1.0,   // 1x weight on doc comments
  }))
  .orderBy(score('id'), 'desc')                              // sort by relevance
  .limit(50)
  .dump();
// SQL:
//   SELECT paradedb.score("id") AS "score", ...
//   FROM "symbols"
//   WHERE "symbols" @@@ paradedb.boolean(
//     paradedb.boost(3.0, paradedb.parse('name', $1)),
//     paradedb.boost(1.5, paradedb.parse('signature', $1)),
//     paradedb.boost(1.0, paradedb.parse('doc_comment', $1))
//   )
//   ORDER BY paradedb.score("id") DESC
//   LIMIT 50
```

### ParadeDB Functions

| Function | SQL output | Use case |
|----------|------------|----------|
| `score(keyField)` | `paradedb.score("keyField")` | Relevance score in SELECT / ORDER BY |
| `bm25Search(table, query, fieldBoosts)` | `table @@@ paradedb.boolean(...)` | Multi-field BM25 with per-field weights |
| `parse(field, query)` | `paradedb.parse(field => '...', query_string => $N)` | Single-field query sub-expression |
| `boost(factor, expr)` | `paradedb.boost(factor, expr)` | Apply weight multiplier to sub-expression |
| `booleanSearch(exprs[])` | `paradedb.boolean(expr1, expr2, ...)` | Combine sub-expressions with OR logic |

**`bm25Search` query parameter sharing:** All `parse()` calls inside `bm25Search`
reference the same `$N` slot. If you need different query strings per field, compose
`parse()` / `boost()` / `booleanSearch()` manually.

### DDL: BM25 Index

```typescript
import { schema } from '@dbsp/core';

const db = schema(
  {
    symbols: {
      id: { type: 'integer', autoIncrement: true, primaryKey: true },
      name: 'text',
      signature: 'text',
      doc_comment: 'text',
    },
  },
  {
    symbols: {
      indexes: [
        {
          columns: ['id', 'name', 'signature', 'doc_comment'],
          method: 'bm25',
          with: { key_field: 'id' },
        },
      ],
    },
  },
);
// Generates:
//   CREATE INDEX IF NOT EXISTS ... ON "symbols" USING bm25 ("id", "name", "signature", "doc_comment")
//   WITH (key_field = 'id')
```

---

## INNER JOIN via `include()`

By default `include()` uses LEFT JOIN. Pass `{ join: 'inner' }` to filter out root
rows that have no matching related record:

```typescript
import { schema, createOrm } from '@dbsp/core';
import { createPgsqlCompileOnlyAdapter, cosineDistance, rawDistance } from '@dbsp/adapter-pgsql';

const db = schema({
  embeddings: {
    id: { type: 'integer', autoIncrement: true, primaryKey: true },
    vector: { type: 'text', dbType: 'vector(768)' },
    symbolId: 'integer',
  },
  symbols: {
    id: { type: 'integer', primaryKey: true },
    name: 'text',
  },
} as const);
const orm = createOrm({ schema: db, adapter: createPgsqlCompileOnlyAdapter() });

const qv = [0.1, 0.2, 0.3];

orm.select('embeddings')
  .include('symbols', { join: 'inner' })   // INNER JOIN — drops embeddings with no symbol
  .columns(['*', cosineDistance('vector', qv).as('score')])
  .orderBy(rawDistance('vector', qv), 'asc')
  .dump();
```

This is the standard pattern for vector search when you want the joined data
(e.g., symbol metadata) and must guarantee the join succeeds.

---

## Writing Your Own Extension

See `packages/adapter-pgsql/src/extensions/README.md` for the authoring guide.

The convention is:
1. Build your helpers from `op()`, `fn()`, `ref()`, `param()`, `cast()`, `literal()`
   imported from `@dbsp/core`.
2. Return `ExpressionRef` from every public function.
3. Export from `packages/adapter-pgsql/src/extensions/index.ts`.

## Key Files

- `packages/adapter-pgsql/src/extensions/pgvector.ts` — pgvector helpers
- `packages/adapter-pgsql/src/extensions/paradedb.ts` — ParadeDB helpers
- `packages/adapter-pgsql/src/extensions/index.ts` — public re-exports
- `packages/core/src/dx/expressions.ts` — underlying expression primitives
- `packages/core/src/dx/schema.ts` — `SchemaIndexOptions` (method, opclass, with)
- [guide](https://oorabona.github.io/db-semantic-planner/guide/expression-primitives) — full primitive reference

