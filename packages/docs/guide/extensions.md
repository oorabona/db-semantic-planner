---
title: Extensions (pgvector + ParadeDB)
---

# How to Use Extensions (pgvector + ParadeDB)

This guide shows how to use the pgvector and ParadeDB extension helpers that ship with `@dbsp/adapter-pgsql`. Use it when you need vector similarity search (ANN/cosine/L2), BM25 full-text relevance ranking, or when you want to write your own extension wrappers on top of the expression primitive system.

## When

Use extensions when you need PostgreSQL-native capabilities beyond standard SQL:

- **pgvector** — nearest-neighbour / similarity search on embedding vectors
- **ParadeDB** — BM25 relevance primitives (`score`, `parse`, `boost`, `booleanSearch`); multi-field search is core's `fullTextSearch`

Both extensions are implemented as thin wrappers over expression primitives and are
imported from `@dbsp/adapter-pgsql`.

## Available Extensions

| Package | Extension | Import |
|---------|-----------|--------|
| `@dbsp/adapter-pgsql` | pgvector | `cosineDistance`, `rawDistance`, `l2Distance`, `innerProduct` |
| `@dbsp/adapter-pgsql` | ParadeDB | `score`, `parse`, `boost`, `booleanSearch` (multi-field search: core's `fullTextSearch`) |

### How arguments are read

Each helper reads its arguments with the same rule as the core helpers (ADR 0011):

| Argument | Kind | A plain value | An expression (`literal()`, `exprRef()`, a `ColumnRef`, a subquery, a query builder) |
|----------|------|---------------|-----------------------------------------------------------------------------------|
| the vector of `cosineDistance`, `rawDistance`, `l2Distance`, `innerProduct` | value | bound as `CAST($N AS vector)`; an array of finite numbers is sent as pgvector's text form `'[a,b,…]'`, an empty array or other elements are refused | compiled inside `CAST(… AS vector)` |
| the query of `parse` | value | bound as `$N` | compiled as the query |
| the column of the distances and of `vectorDims`, the key field of `score`, the expression of `boost`, each element of `booleanSearch` | reference | a string is a column; a finite number or boolean is inlined | compiled (a `ColumnRef` gives its qualified column) |
| the field of `parse` | name | a string only | refused |

`param(v)` always binds `v`. An argument a helper cannot use (`null` or `undefined` in a reference position, a plain
object there, a `sql()` marker, an unfinished `caseWhen()`) is refused with an `InvalidOperationError` naming the
helper.

---

## pgvector

### Full Example

```typescript
import { schema, createOrm, ref } from '@dbsp/core';
import { createPgCompileOnlyAdapter, cosineDistance, rawDistance } from '@dbsp/adapter-pgsql';

const db = schema({
  embeddings: {
    id: { type: 'integer', autoIncrement: true, primaryKey: true },
    vector: { type: 'text', dbType: 'vector(768)' },
    symbolId: ref('symbols'),
  },
  symbols: {
    id: { type: 'integer', primaryKey: true },
    name: 'text',
    signature: 'text',
  },
} as const);
const orm = createOrm({ schema: db, adapter: createPgCompileOnlyAdapter() });

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
//   SELECT embeddings.*, 1 - (vector <=> CAST($1 AS vector)) AS score, ...
//   FROM embeddings
//   JOIN symbols AS symbol ON embeddings."symbolId" = symbol.id
//   WHERE (1 - (embeddings.vector <=> CAST($2 AS vector))) >= $3
//   ORDER BY vector <=> CAST($4 AS vector) ASC
//   LIMIT 20
```

### Distance Functions

| Function | Operator | Direction | Use case |
|----------|----------|-----------|----------|
| `cosineDistance(col, vec)` | `1 - (col <=> vec)` | Higher = more similar | Semantic similarity score in SELECT |
| `rawDistance(col, vec)` | `col <=> vec` | Lower = closer | ORDER BY (index-friendly ANN) |
| `l2Distance(col, vec)` | `col <-> vec` | Lower = closer | Euclidean ORDER BY |
| `innerProduct(col, vec)` | `col <#> vec` | Lower = more similar (negative) | Maximum inner product search |

**Important:** Use `cosineDistance` in SELECT for a human-readable similarity score in [-1, 1] (1 = same direction).
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
import { schema, createOrm, fullTextSearch } from '@dbsp/core';
import { createPgCompileOnlyAdapter, score } from '@dbsp/adapter-pgsql';

const db = schema({
  symbols: {
    id: { type: 'integer', autoIncrement: true, primaryKey: true },
    name: 'text',
    signature: 'text',
    doc_comment: 'text',
  },
} as const);
const orm = createOrm({ schema: db, adapter: createPgCompileOnlyAdapter() });

const searchTerm = 'semantic query planner';

const results = orm
  .select('symbols')
  .columns([score('id').as('score')])                        // BM25 relevance score
  .where(fullTextSearch({
    query: searchTerm,
    tableAlias: 'symbols',
    fields: [
      { name: 'name', boost: 3.0 },          // 3x weight on name column
      { name: 'signature', boost: 1.5 },     // 1.5x weight on signature
      { name: 'doc_comment', boost: 1.0 },   // 1x weight on doc comments
    ],
  }))
  .orderBy(score('id'), 'desc')                              // sort by relevance
  .limit(50)
  .dump();
// SQL:
//   SELECT paradedb.score(id) AS score
//   FROM symbols
//   WHERE symbols @@@ paradedb.boolean(should => ARRAY[
//     paradedb.boost(3, paradedb.parse(field => 'name', query_string => $1)),
//     paradedb.boost(1.5, paradedb.parse(field => 'signature', query_string => $2)),
//     paradedb.boost(1, paradedb.parse(field => 'doc_comment', query_string => $3))
//   ])
//   ORDER BY paradedb.score(id) DESC
//   LIMIT 50
```

### ParadeDB Functions

| Function | SQL output | Use case |
|----------|------------|----------|
| `score(keyField)` | `paradedb.score(keyField)` | Relevance score in SELECT / ORDER BY |
| `parse(field, query)` | `paradedb.parse(field => '...', query_string => $N)` | Single-field query sub-expression |
| `boost(factor, expr)` | `paradedb.boost(factor, expr)` | Apply weight multiplier to sub-expression |
| `booleanSearch(exprs[])` | `paradedb.boolean(should => ARRAY[expr1, expr2, ...])` | Combine sub-expressions with OR logic |

For a multi-field search with per-field weights, use core's [`fullTextSearch()`](./full-text-search) as above: it
binds a plain query once per field (`$1`, `$2`, … all equal) and compiles an expression query in every field. For
different query strings per field, compose `parse()` / `boost()` / `booleanSearch()` under
`op('@@@', exprRef('<table>'), …)`.

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
import { schema, createOrm, ref } from '@dbsp/core';
import { createPgCompileOnlyAdapter, cosineDistance, rawDistance } from '@dbsp/adapter-pgsql';

const db = schema({
  embeddings: {
    id: { type: 'integer', autoIncrement: true, primaryKey: true },
    vector: { type: 'text', dbType: 'vector(768)' },
    symbolId: ref('symbols'),
  },
  symbols: {
    id: { type: 'integer', primaryKey: true },
    name: 'text',
  },
} as const);
const orm = createOrm({ schema: db, adapter: createPgCompileOnlyAdapter() });

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

