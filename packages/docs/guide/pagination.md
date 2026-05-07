---
title: Pagination
description: Four patterns for paginating queries with @dbsp/core — offset, cursor, streaming, and manual builder loops.
---

# Pagination

`@dbsp/core` query builders are **immutable**: every method call (`.where()`, `.limit()`, `.offset()`, etc.) returns a new builder instance. Awaiting `.all()` returns a plain `TResult[]` array — not a builder — so you cannot chain further methods on the result.

This single design constraint leads to four idiomatic pagination patterns. Understanding which to pick matters, because the wrong choice can cause correctness issues (skipped or duplicated rows) or severe performance degradation on large tables.

## Why immutability changes how you paginate

```typescript
// doctest: skip — illustrates the wrong mental model; result is an array, not a builder
import { eq } from '@dbsp/core';

const result = await orm.select('users').where(eq('active', true)).limit(10).all();
// TypeError: result.offset is not a function
result.offset(10).all();
```

The correct mental model: keep a **base builder** and derive page-specific builders from it.

---

## Pattern matrix

| Use case | Pattern | Method |
|---|---|---|
| UI with `?page=N` URL and total/totalPages for a page navigator | B | `.paginate({ page, perPage })` |
| Infinite scroll, public API, large dataset | C | `.cursorPaginate({ cursor, limit })` |
| ETL / background export over an entire table | D | `.stream({ chunkSize })` |
| Ad-hoc loop with custom batch logic | A | Base builder + `.offset()` derivative |

---

## Pattern A: Derivable builder loop (manual offset)

Every builder is a value. Calling `.offset(n)` on a builder returns a new builder with that offset applied — the original is unchanged. This lets you define a reusable base query once and derive each page from it:

```typescript
// doctest: skip — requires a real PostgreSQL connection
import { eq } from '@dbsp/core';

const baseQuery = orm
  .select('users')
  .where(eq('active', true))
  .orderBy('createdAt', 'desc')
  .limit(100);

for (let page = 0; ; page++) {
  const batch = await baseQuery.offset(page * 100).all();
  if (batch.length === 0) break;
  for (const user of batch) {
    // process user
  }
}
```

**When to use:** ad-hoc scripts where you need full control over retry logic, error handling, or conditional branching between batches. Not recommended for tables larger than ~10k rows — see [Pattern C](#pattern-c-cursorpaginate-recommended-for-large-datasets) for the performant alternative.

---

## Pattern B: `paginate()` — offset with metadata

`.paginate()` executes two queries internally: one for the page of data, one `COUNT(*)` for the total. The result carries all metadata needed to render a page navigator.

```typescript
// doctest: skip — requires a real PostgreSQL connection
import { eq } from '@dbsp/core';

let page = 1;
while (true) {
  const result = await orm
    .select('users')
    .where(eq('active', true))
    .orderBy('createdAt', 'desc')
    .paginate({ page, perPage: 20 });

  // result.data                        — User[]
  // result.pagination.page             — current page number (1-indexed)
  // result.pagination.perPage          — items per page
  // result.pagination.total            — total row count (only when withCount: true)
  // result.pagination.totalPages       — total page count (only when withCount: true)
  // result.pagination.hasNextPage      — boolean
  // result.pagination.hasPrevPage      — boolean

  for (const user of result.data) {
    // process user
  }

  if (!result.pagination.hasNextPage) break;
  page++;
}
```

**Options** (`PaginateOptions` — `pagination-types.ts:35`):

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `page` | `number` | `1` | Page number (1-indexed) |
| `perPage` | `number` | `20` | Rows per page |
| `withCount` | `boolean` | `true` | Run the extra `COUNT(*)` query |

**Result** (`PaginatedResult<T>` — `pagination-types.ts:59`):

| Field | Type | Note |
|-------|------|------|
| `data` | `T[]` | Current page rows |
| `pagination.page` | `number` | |
| `pagination.perPage` | `number` | |
| `pagination.total` | `number \| undefined` | Only present when `withCount: true` |
| `pagination.totalPages` | `number \| undefined` | Only present when `withCount: true` |
| `pagination.hasNextPage` | `boolean` | |
| `pagination.hasPrevPage` | `boolean` | |

::: tip Skip the COUNT for better performance
The `COUNT(*)` can dominate query time on large tables. If your UI only needs hasNextPage/hasPrevPage (e.g. "load more" buttons rather than a numbered page navigator), pass `withCount: false`:

```typescript
// doctest: skip — requires a real PostgreSQL connection
const result = await orm.select('users').paginate({ page: 1, perPage: 20, withCount: false });
// result.pagination.total and result.pagination.totalPages are undefined
```
:::

**When to use:** REST APIs exposing `?page=N&perPage=M` where the client needs total/totalPages to render a page navigator. Switch to cursor pagination if the table grows past ~10–50k rows.

---

## Pattern C: `cursorPaginate()` — recommended for large datasets

Cursor-based pagination avoids `OFFSET` entirely. Instead of asking PostgreSQL to scan and discard N rows, it uses the last row's value as a bookmark to resume from.

```typescript
// doctest: skip — requires a real PostgreSQL connection
import { eq } from '@dbsp/core';

let cursor: string | null = null;
while (true) {
  const result = await orm
    .select('users')
    .where(eq('active', true))
    .orderBy('createdAt', 'desc')  // the orderBy column is the cursor key
    .cursorPaginate({ cursor, limit: 20 });

  // result.data        — User[]
  // result.nextCursor  — opaque string | null
  // result.prevCursor  — opaque string | null
  // result.hasNextPage — boolean
  // result.hasPrevPage — boolean

  for (const user of result.data) {
    // process user
  }

  if (!result.hasNextPage) break;
  cursor = result.nextCursor;
}
```

**Options** (`CursorPaginateOptions` — `pagination-types.ts:88`):

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `cursor` | `string \| null` | `null` | Cursor from previous page; `null` fetches the first page |
| `limit` | `number` | `20` | Rows per page |
| `direction` | `'forward' \| 'backward'` | `'forward'` | Pagination direction |

**Result** (`CursorPaginatedResult<T>` — `pagination-types.ts:113`):

| Field | Type | Note |
|-------|------|------|
| `data` | `T[]` | Current page rows |
| `nextCursor` | `string \| null` | Pass as `cursor` on the next call; `null` means no more pages |
| `prevCursor` | `string \| null` | Pass as `cursor` with `direction: 'backward'` |
| `hasNextPage` | `boolean` | |
| `hasPrevPage` | `boolean` | |

**Why prefer over offset pagination:**

- **No OFFSET cost** — `OFFSET 100000` forces PostgreSQL to scan and discard 100,000 rows before returning any results. Cursor pagination never does this.
- **Stable under concurrent writes** — rows inserted between pages are never skipped or duplicated. Offset pagination silently shifts pages when rows are inserted.
- **Opaque cursor** — the encoded bookmark is not a raw row ID exposed in URLs.

::: warning Cursor requires a stable, unique-enough orderBy
Duplicate values in the orderBy column can cause rows to be skipped at page boundaries. If `createdAt` has duplicates, add a unique tie-breaker:

```typescript
// doctest: skip — requires a real PostgreSQL connection
// Composite orderBy — tie-break by id to guarantee stable cursor position
orm.select('users').orderBy('createdAt', 'desc').orderBy('id', 'desc').cursorPaginate({ limit: 20 });
```
:::

**When to use:** infinite scroll, public APIs, feeds, or any pagination over tables with more than ~10k rows.

---

## Pattern D: `stream()` — ETL and large exports

`.stream()` opens a server-side cursor on PostgreSQL and yields rows one at a time via an async iterator. The full result set is never materialized in memory, making this safe for tables with millions of rows.

```typescript
// doctest: skip — requires a real PostgreSQL connection with pg-cursor configured
import { eq } from '@dbsp/core';

const stream = orm
  .select('users')
  .where(eq('active', true))
  .orderBy('createdAt', 'desc')
  .stream({ chunkSize: 500 });

let count = 0;
for await (const user of stream) {
  await processUser(user);
  count++;
  if (count % 10_000 === 0) {
    console.log(`Processed ${count} rows`);
  }
}
```

**Options** (`StreamOptions` — `pagination-types.ts:17`):

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `chunkSize` | `number` | `100` | Rows fetched per cursor batch from PostgreSQL |
| `onStart` | `(dump: Dump) => void` | — | Called once before the first row; receives SQL, params, and plan for observability |

`chunkSize` controls server-side batching — the iterator still yields one row at a time to your loop. Larger values reduce round-trips but increase per-batch memory.

An `onStart` callback is useful for logging or distributed tracing:

```typescript
// doctest: skip — requires a real PostgreSQL connection
const stream = orm.select('users').stream({
  chunkSize: 100,
  onStart(dump) {
    logger.info({ sql: dump.sql, correlationId: dump.meta?.correlationId }, 'stream started');
  },
});
for await (const user of stream) { /* ... */ }
```

**When to use:** background jobs, CSV/Parquet exports, ETL pipelines — anywhere the full dataset cannot fit in Node.js heap. For operational considerations (transactions, connection lifecycle, error handling), see [Production § Streaming Large Results](./production#streaming-large-results).

---

## Common pitfalls

### 1. Chaining on an awaited result

```typescript
// doctest: skip — illustrative error path
const rows = await orm.select('users').all();
rows.offset(10);  // TypeError: rows.offset is not a function
```

`await query.all()` returns `T[]`, not a builder. Hold on to the builder if you need to derive more queries.

### 2. Offset pagination beyond ~10k rows

`OFFSET N` is linear: PostgreSQL scans and discards N rows on every page. For large tables this dominates query time. Switch to `.cursorPaginate()` once the table grows past the point where `EXPLAIN ANALYZE` shows a costly `Rows Removed by Filter` or `Limit` with a high offset.

### 3. `withCount: true` is the default

`.paginate()` runs a `COUNT(*)` query on every call unless you pass `withCount: false`. On a 10M-row table, the count query can be the bottleneck. Disable it when the client does not need total/totalPages.

### 4. Cursor pagination requires a stable orderBy

Duplicate values in the cursor column produce unstable page boundaries — rows can be skipped or re-fetched. Always add a unique tie-breaker (typically `id`) when the primary sort column is not unique.

### 5. Streaming inside a transaction

`stream()` opens a PostgreSQL server-side cursor. This requires an active connection for the duration of the loop. If you wrap a stream in a transaction, the connection is held open until `for await` exits. See [Production § Streaming Large Results](./production#streaming-large-results) for connection-pool implications.

---

## See also

- [Getting Started § Step 9](./getting-started#step-9-pagination) — quick first-encounter intro
- [Queries § Limiting and Offsetting](./queries#limiting-and-offsetting) — basic `LIMIT`/`OFFSET` without pagination wrappers
- [Production § Streaming Large Results](./production#streaming-large-results) — operational concerns for `stream()`
- [API Reference § Pagination](../api/orm-api#pagination) — full method signatures
