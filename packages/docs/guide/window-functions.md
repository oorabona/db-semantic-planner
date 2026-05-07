---
title: Window Functions
description: Compute rankings, running totals, and lag/lead comparisons across result sets with @dbsp/core window function helpers.
---

# Window Functions

A window function computes a value for each row using a "window" of related rows — but unlike `GROUP BY`, it does not collapse the rows. You still get one output row per input row, enriched with a calculated column such as a rank, a running total, or the previous row's value.

## Why this matters

The common misconception is "I can do this with a self-join." Self-joins for ranking or running totals work, but they are expensive (O(n²) in naïve cases), hard to read, and can produce duplicate rows if not de-duplicated carefully. Window functions express the same intent in a single pass and compile to a plan PostgreSQL can execute efficiently with a single sort step.

---

## The mental model

Every window function call follows the pattern:

```
function() OVER (PARTITION BY <grouping columns> ORDER BY <sort columns>)
```

- **PARTITION BY** divides rows into independent groups before the function runs. Without it, the entire result set is one partition.
- **ORDER BY** determines row order inside each partition. Required for ranking and offset functions; optional for aggregates.

In `@dbsp/core`, the builder chain maps directly:

```typescript
// doctest: skip — window function helpers (rowNumber, rank, etc.) are not in the doctest preamble
import { schema, createOrm, rowNumber } from '@dbsp/core';
import { createPgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const db = schema({
  sales: { id: 'integer', region: 'string', amount: 'decimal', date: 'date' },
} as const);
const orm = createOrm({ schema: db, adapter: createPgsqlCompileOnlyAdapter() });

orm.select('sales')
  .columns(['id', 'region', rowNumber().partitionBy('region').orderBy('amount', 'desc').as('rn')])
  .dump();
// SQL: SELECT "id", "region", ROW_NUMBER() OVER (PARTITION BY "region" ORDER BY "amount" DESC) AS "rn"
// FROM "sales"
```

All window builders are finalized with `.as(alias)` which returns an `ExpressionSpec` for use in `.columns([...])`. Source: `packages/core/src/dx/window-functions.ts:165`.

---

## Function reference

All helpers are exported from `@dbsp/core`. Source: `packages/core/src/dx/window-functions.ts`.

| Helper | Kind | Signature | SQL emitted |
|--------|------|-----------|-------------|
| `rowNumber()` | Ranking | `rowNumber()` | `ROW_NUMBER() OVER (...)` |
| `rank()` | Ranking | `rank()` | `RANK() OVER (...)` — ties share a rank, next rank has a gap |
| `denseRank()` | Ranking | `denseRank()` | `DENSE_RANK() OVER (...)` — ties share a rank, no gap |
| `wSum(field)` | Aggregate | `wSum('col')` | `SUM("col") OVER (...)` |
| `wAvg(field)` | Aggregate | `wAvg('col')` | `AVG("col") OVER (...)` |
| `wCount(field?)` | Aggregate | `wCount()` or `wCount('col')` | `COUNT(*) OVER (...)` or `COUNT("col") OVER (...)` |
| `wMin(field)` | Aggregate | `wMin('col')` | `MIN("col") OVER (...)` |
| `wMax(field)` | Aggregate | `wMax('col')` | `MAX("col") OVER (...)` |
| `lag(field)` | Offset | `lag('col')` | `LAG("col") OVER (...)` — previous row's value |
| `lead(field)` | Offset | `lead('col')` | `LEAD("col") OVER (...)` — next row's value |

Builder methods available on all of the above:

| Method | Effect |
|--------|--------|
| `.partitionBy('col')` | Adds a PARTITION BY column (chainable, appends) |
| `.orderBy('col', 'asc'\|'desc')` | Adds an ORDER BY column (chainable, appends) |
| `.as('alias')` | Finalizes — returns `ExpressionSpec` for `.columns([...])` |

> **Note:** `firstValue()` and `lastValue()` are not yet exposed as helpers. Use `fn('first_value', exprRef('col'))` via [Expression Primitives](./expression-primitives) for those functions. (`ref` from `@dbsp/core` is the schema FK helper and is not valid in expression position — use `exprRef` instead. `op()` is a binary operator and requires three arguments — it cannot be used for function calls.)

---

## Pattern: top-N per group

Retrieve the top 3 sales records per region, ranked by amount descending.

```typescript
// doctest: skip — window function helpers not in doctest preamble
import { schema, createOrm, rank, gt } from '@dbsp/core';
import { createPgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const db = schema({
  sales: { id: 'integer', region: 'string', amount: 'decimal', repName: 'string' },
} as const);
const orm = createOrm({ schema: db, adapter: createPgsqlCompileOnlyAdapter() });

// Step 1: add rank column
const ranked = orm.select('sales').columns([
  'id', 'region', 'repName', 'amount',
  rank().partitionBy('region').orderBy('amount', 'desc').as('rnk'),
]);

// Step 2: filter rows where rank <= 3
// In PostgreSQL you'd wrap in a CTE or subquery; with dbsp use a CTE:
ranked.dump();
// SQL: SELECT "id", "region", "repName", "amount",
//   RANK() OVER (PARTITION BY "region" ORDER BY "amount" DESC) AS "rnk"
// FROM "sales"
```

**When to use `rank()` vs `denseRank()`:** use `rank()` when gaps in rank numbers are acceptable (e.g. "position 1, 2, 2, 4" for tied entries). Use `denseRank()` when you need consecutive rank numbers (e.g. "position 1, 2, 2, 3").

---

## Pattern: running total

Compute a cumulative order total per user, ordered by date.

```typescript
// doctest: skip — window function helpers not in doctest preamble
import { schema, createOrm, wSum } from '@dbsp/core';
import { createPgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const db = schema({
  orders: { id: 'integer', userId: 'integer', total: 'decimal', createdAt: 'timestamp' },
} as const);
const orm = createOrm({ schema: db, adapter: createPgsqlCompileOnlyAdapter() });

orm.select('orders')
  .columns([
    'id', 'userId', 'total', 'createdAt',
    wSum('total').partitionBy('userId').orderBy('createdAt').as('runningTotal'),
  ])
  .dump();
// SQL: SELECT "id", "userId", "total", "createdAt",
//   SUM("total") OVER (PARTITION BY "userId" ORDER BY "createdAt" ASC) AS "runningTotal"
// FROM "orders"
```

Without `.partitionBy()`, the running total accumulates across all users in the ORDER BY sequence.

---

## Pattern: gap detection with `lag()`

Detect a gap between an event's `startedAt` and the previous event's `endedAt` for the same session:

```typescript
// doctest: skip — window function helpers not in doctest preamble
import { schema, createOrm, lag } from '@dbsp/core';
import { createPgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const db = schema({
  events: { id: 'integer', sessionId: 'integer', startedAt: 'timestamp', endedAt: 'timestamp' },
} as const);
const orm = createOrm({ schema: db, adapter: createPgsqlCompileOnlyAdapter() });

orm.select('events')
  .columns([
    'id', 'sessionId', 'startedAt', 'endedAt',
    lag('endedAt').partitionBy('sessionId').orderBy('startedAt').as('prevEndedAt'),
  ])
  .dump();
// SQL: SELECT "id", "sessionId", "startedAt", "endedAt",
//   LAG("endedAt") OVER (PARTITION BY "sessionId" ORDER BY "startedAt" ASC) AS "prevEndedAt"
// FROM "events"
```

For the first row in each partition, `LAG` returns `NULL`. Filter post-query or in a CTE to find rows where `startedAt > prevEndedAt`.

---

## Pattern: pagination via `rowNumber()`

An alternative to `OFFSET` pagination that avoids the "skipped rows on concurrent insert" problem:

```typescript
// doctest: skip — window function helpers not in doctest preamble
import { schema, createOrm, rowNumber } from '@dbsp/core';
import { createPgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const db = schema({
  products: { id: 'integer', name: 'string', price: 'decimal' },
} as const);
const orm = createOrm({ schema: db, adapter: createPgsqlCompileOnlyAdapter() });

orm.select('products')
  .columns([
    'id', 'name', 'price',
    rowNumber().orderBy('id').as('rn'),
  ])
  .dump();
// SQL: SELECT "id", "name", "price",
//   ROW_NUMBER() OVER (ORDER BY "id" ASC) AS "rn"
// FROM "products"
// Wrap in a CTE and filter WHERE rn BETWEEN 21 AND 40 for page 2
```

See [Pagination](./pagination) for cursor-based alternatives when you do not need the full row number.

---

## Common pitfalls

### ORDER BY required for ranking and offset functions

`rowNumber()`, `rank()`, `denseRank()`, `lag()`, and `lead()` require an `.orderBy()` to produce deterministic results. Without it PostgreSQL may return any ordering:

```typescript
// doctest: skip — illustrates the wrong pattern
rowNumber().as('rn')        // non-deterministic: ORDER BY missing
rowNumber().orderBy('id').as('rn')  // correct
```

### Aggregate window functions and GROUP BY

Window functions are applied by PostgreSQL **after** aggregation, so you can mix them with `GROUP BY` in the same query — `SUM(SUM(amount)) OVER ()` (a window over a grouped aggregate) is valid PostgreSQL SQL.

The actual restrictions are:

- Window function calls cannot appear inside a `GROUP BY` or `WHERE` clause.
- Window function calls cannot appear inside another aggregate call.
- When you need window functions over both pre-aggregated and per-row data you may need to layer the operations: compute the grouping result in a CTE or subquery, then apply window functions in the outer SELECT.

```typescript
// doctest: skip — illustrates CTE layering for pre-aggregation windows
// Step 1 (CTE): aggregate per region
// Step 2 (outer): apply window over aggregated rows
// Use orm.with(...) to build the CTE layer.
```

### NULL ordering in `lag()` / `lead()`

For the boundary rows of each partition, `lag()` on the first row and `lead()` on the last row return `NULL`. Handle this with `COALESCE` in a downstream filter if a zero/default is required.

---

## See also

- [Pagination](./pagination) — cursor-based and offset pagination patterns
- [Expression Primitives](./expression-primitives) — raw SQL expressions for `first_value`, `nth_value`, and frame clauses
- [Set Operations](./set-operations) — UNION, INTERSECT, EXCEPT
