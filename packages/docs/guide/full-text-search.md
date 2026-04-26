---
title: Full-Text Search
---

# How to Use Full-Text Search (ParadeDB BM25)

`fullTextSearch()` and `textScore()` provide a high-level API for BM25 relevance search across one or more text columns, powered by the ParadeDB `pg_search` extension. Use this guide when you need to search user-supplied queries across multiple fields with per-field boost weights and rank results by relevance score.

## When

Use `fullTextSearch()` and `textScore()` when you need BM25 relevance search across
one or more text columns of a table, with optional per-field boost weights.

- Searching with a user-supplied query string across multiple fields (name, body, description)
- Ranking results by BM25 relevance score
- Combining relevance filtering with `ORDER BY` score `DESC`
- Any use case that requires the ParadeDB `pg_search` extension

**Prerequisite:** A BM25 index must exist on the target table (see DDL section below).

---

## API

### `fullTextSearch(options)` — import from `@dbsp/core`

Produces a `WHERE` filter using the ParadeDB `@@@` operator with per-field boost weights.

```typescript
// doctest: skip — API signature reference (TypeScript function signature, not executable code)
import { fullTextSearch } from '@dbsp/core';

fullTextSearch({
  query: string | unknown,   // query string — bound as a $N parameter per field
  fields: FullTextSearchField[],  // columns to search
  tableAlias: string,        // table name as it appears in the FROM clause
}): ExpressionRef
```

`FullTextSearchField`:

```typescript
type FullTextSearchField = {
  name: string;   // column name in the BM25 index
  boost: number;  // multiplier (higher = more weight). Use 1.0 as baseline.
};
```

**Generated SQL:**

```sql
"tableAlias" @@@ paradedb.boolean(
  should => ARRAY[
    paradedb.boost(3, paradedb.parse(field => 'name', query_string => $1)),
    paradedb.boost(1, paradedb.parse(field => 'doc', query_string => $2)),
    ...
  ]
)
```

Each field gets its own `$N` parameter slot, all bound to the same query value.

---

### `textScore(keyField?)` — import from `@dbsp/core`

Produces `paradedb.score("keyField")` for use in `.columns()` and `.orderBy()`.

```typescript
// doctest: skip — API signature reference (TypeScript function signature, not executable code)
import { textScore } from '@dbsp/core';

textScore(keyField?: string): ExpressionRef
// keyField defaults to 'id'
```

**Generated SQL:**

```sql
paradedb.score(id)          -- textScore()
paradedb.score(symbol_id)   -- textScore('symbol_id')
```

Binds no parameters — the key field is a column reference, not a value.

---

## Examples

### Basic Full-Text Search

```typescript
import { schema, createOrm, fullTextSearch } from '@dbsp/core';
import { createPgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const __ftsArticlesDb = schema({
  articles: {
    id: 'uuid',
    title: 'string',
    body: 'text',
    status: 'string',
    searchVector: { type: 'tsvector', nullable: true },
  },
} as const);
const __ftsArticlesOrm = createOrm({ schema: __ftsArticlesDb, adapter: createPgsqlCompileOnlyAdapter() });

const results = await __ftsArticlesOrm
  .select('articles')
  .where(fullTextSearch({
    query: searchTerm,
    tableAlias: 'articles',
    fields: [
      { name: 'title', boost: 1.0 },
      { name: 'body', boost: 1.0 },
    ],
  }))
  .dump();

// SQL:
//   SELECT * FROM "articles"
//   WHERE articles @@@ paradedb.boolean(
//     should => ARRAY[
//       paradedb.boost(1, paradedb.parse(field => 'title', query_string => $1)),
//       paradedb.boost(1, paradedb.parse(field => 'body', query_string => $2))
//     ]
//   )
// params: [searchTerm, searchTerm]
```

---

### Field Boosting (name: 3.0, description: 1.0)

Boost makes matches in high-priority fields score higher than matches in
lower-priority fields.

```typescript
import { schema, createOrm, fullTextSearch } from '@dbsp/core';
import { createPgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const __ftsSymbolsDb = schema({
  symbols: {
    id: 'uuid',
    name: 'string',
    signature: 'string',
    doc_comment: { type: 'text', nullable: true },
  },
} as const);
const __ftsSymbolsOrm = createOrm({ schema: __ftsSymbolsDb, adapter: createPgsqlCompileOnlyAdapter() });

const results = await __ftsSymbolsOrm
  .select('symbols')
  .where(fullTextSearch({
    query: searchTerm,
    tableAlias: 'symbols',
    fields: [
      { name: 'name', boost: 3.0 },        // exact name match is most important
      { name: 'signature', boost: 1.5 },    // type signature — medium weight
      { name: 'doc_comment', boost: 1.0 },  // doc text — baseline weight
    ],
  }))
  .dump();

// SQL:
//   WHERE symbols @@@ paradedb.boolean(
//     should => ARRAY[
//       paradedb.boost(3, paradedb.parse(field => 'name', query_string => $1)),
//       paradedb.boost(1.5, paradedb.parse(field => 'signature', query_string => $2)),
//       paradedb.boost(1, paradedb.parse(field => 'doc_comment', query_string => $3))
//     ]
//   )
// params: [searchTerm, searchTerm, searchTerm]
```

---

### Combined with ORDER BY Score

Use `textScore()` in both `.columns()` (to surface the score) and `.orderBy()` (to rank).

```typescript
import { schema, createOrm, fullTextSearch, textScore } from '@dbsp/core';
import { createPgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const __ftsSymbolsScoreDb = schema({
  symbols: {
    id: 'uuid',
    name: 'string',
    doc_comment: { type: 'text', nullable: true },
  },
} as const);
const __ftsSymbolsScoreOrm = createOrm({ schema: __ftsSymbolsScoreDb, adapter: createPgsqlCompileOnlyAdapter() });

const results = await __ftsSymbolsScoreOrm
  .select('symbols')
  .columns(['*', textScore().as('score')])            // include score in results
  .where(fullTextSearch({
    query: searchTerm,
    tableAlias: 'symbols',
    fields: [
      { name: 'name', boost: 3.0 },
      { name: 'doc_comment', boost: 1.0 },
    ],
  }))
  .orderBy(textScore(), 'desc')                       // rank by relevance
  .limit(20)
  .dump();

// SQL:
//   SELECT *, paradedb.score(id) AS "score"
//   FROM "symbols"
//   WHERE symbols @@@ paradedb.boolean(
//     should => ARRAY[
//       paradedb.boost(3, paradedb.parse(field => 'name', query_string => $1)),
//       paradedb.boost(1, paradedb.parse(field => 'doc_comment', query_string => $2))
//     ]
//   )
//   ORDER BY paradedb.score(id) DESC
//   LIMIT 20
// params: [searchTerm, searchTerm]
```

---

### Combining with Existing WHERE Conditions

Chain `fullTextSearch()` alongside other filter helpers using `.where()`. Multiple
`.where()` calls are combined with `AND`.

```typescript
import { schema, createOrm, fullTextSearch, eq } from '@dbsp/core';
import { createPgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const __ftsArticlesWhereDb = schema({
  articles: {
    id: 'uuid',
    title: 'string',
    body: 'text',
    status: 'string',
  },
} as const);
const __ftsArticlesWhereOrm = createOrm({ schema: __ftsArticlesWhereDb, adapter: createPgsqlCompileOnlyAdapter() });

const results = await __ftsArticlesWhereOrm
  .select('articles')
  .where(eq('status', 'published'))           // standard equality filter
  .where(fullTextSearch({
    query: searchTerm,
    tableAlias: 'articles',
    fields: [
      { name: 'title', boost: 2.0 },
      { name: 'body', boost: 1.0 },
    ],
  }))
  .dump();

// SQL:
//   SELECT * FROM "articles"
//   WHERE "articles"."status" = $1
//   AND articles @@@ paradedb.boolean(
//     should => ARRAY[
//       paradedb.boost(2, paradedb.parse(field => 'title', query_string => $2)),
//       paradedb.boost(1, paradedb.parse(field => 'body', query_string => $3))
//     ]
//   )
// params: ['published', searchTerm, searchTerm]
```

---

### Custom Key Field for textScore()

When the BM25 index uses a key field other than `id`, pass the field name explicitly.

```typescript
import { textScore } from '@dbsp/core';

orm.select('users')
  .columns(['*', textScore('id').as('relevance')])
  .orderBy(textScore('id'), 'desc')
  .dump();

// SQL:
//   SELECT *, paradedb.score(id) AS "relevance"
//   FROM "users"
//   ORDER BY paradedb.score(id) DESC
```

---

## DDL: Creating a BM25 Index

A BM25 index must be created before using `fullTextSearch()`. Declare it via the
schema DDL API:

```typescript
import { schema } from '@dbsp/core';

const db = schema(
  {
    articles: {
      id: { type: 'integer', autoIncrement: true, primaryKey: true },
      title: 'text',
      body: 'text',
      status: 'text',
    },
  },
  {
    articles: {
      indexes: [
        {
          columns: ['id', 'title', 'body'],
          method: 'bm25',
          with: { key_field: 'id' },
        },
      ],
    },
  },
);

// Generates:
//   CREATE INDEX IF NOT EXISTS ... ON "articles" USING bm25 ("id", "title", "body")
//   WITH (key_field = 'id')
```

Only columns listed in the BM25 index can be passed as fields to `fullTextSearch()`.
The `key_field` option must match the `keyField` argument to `textScore()`.

---

## Key Files

- `packages/core/src/dx/full-text-search.ts` — `fullTextSearch()`, `textScore()`, type definitions
- `packages/adapter-pgsql/src/__tests__/full-text-search.test.ts` — test suite with SQL snapshots
- `packages/adapter-pgsql/src/extensions/paradedb.ts` — lower-level `score()`, `parse()`, `boost()`, `bm25Search()` primitives
- [guide](https://oorabona.github.io/db-semantic-planner/guide/extensions) — pgvector + lower-level ParadeDB primitives

---

## Gotchas

### Requires ParadeDB `pg_search` extension

`fullTextSearch()` and `textScore()` use `paradedb.*` functions. The extension must
be installed: `CREATE EXTENSION IF NOT EXISTS pg_search`.

### `tableAlias` must match the FROM clause exactly

In the standard ORM pipeline, the root table has no alias — pass the actual table
name (e.g., `'articles'`). If you use an explicit SQL alias in a subquery or CTE,
pass that alias instead. There is no default.

```typescript
// doctest: skip — `fields` variable is illustrative only; requires a concrete FullTextSearchField[] array
// Assumes `searchTerm` (string) and `query` (string) are in scope as preamble globals.
import { fullTextSearch } from '@dbsp/core';

const searchTerm = 'hello world';
const query = searchTerm;

// Correct for a root table named 'symbols':
fullTextSearch({ query, tableAlias: 'symbols', fields })

// Wrong — 't0' is not assigned by the ORM by default:
fullTextSearch({ query, tableAlias: 't0', fields })
```

### One parameter slot per field, not one shared slot

Each field in `fields` gets its own `$N` slot. A 3-field search produces `$1`, `$2`,
`$3` — all bound to the same query value. This is how the generated SQL is structured
and is expected behavior.

### Only indexed columns can be searched

Passing a column name that is not part of the BM25 index to `fullTextSearch()` will
not produce a compile-time error, but will fail at query execution time with a
ParadeDB runtime error.

### `textScore()` requires a BM25 index with a matching `key_field`

Calling `textScore('id')` on a table without a BM25 index (or with a different
`key_field`) will fail at query execution time.

### `fullTextSearch` vs. lower-level `bm25Search`

`fullTextSearch` (from `@dbsp/core`) is the recommended high-level helper with named
field structs and explicit boost values. The older `bm25Search` (from
`@dbsp/adapter-pgsql`) accepts an object of `{ field: weight }` pairs and is
suitable for simpler cases. Prefer `fullTextSearch` for new code — it is
adapter-agnostic and lives in core.

