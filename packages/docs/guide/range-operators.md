---
title: Range Operators
---

# How to Use Range Operators (PostgreSQL)

`rangeOverlaps()`, `rangeContains()`, and `rangeContainedBy()` give you direct, type-safe access to PostgreSQL's range type operators (`&&`, `@>`, `<@`) with all six built-in range constructors. Use this guide whenever you store a period, an interval, or a numeric span as a single column and need to query rows by intersection or containment.

## When

Use range operators when your data uses a PostgreSQL range type (`daterange`, `tsrange`, `tstzrange`, `int4range`, `int8range`, `numrange`) and you need to filter rows by:

- **Overlap** — two periods share at least one point (e.g. "find bookings that conflict with the requested window").
- **Contains** — a stored period covers a target point or sub-range (e.g. "which pricing tier applies to today's date?").
- **Contained by** — a stored period falls inside a parent window (e.g. "list all events scheduled within Q1").

These map directly onto the PostgreSQL operators `&&`, `@>`, and `<@`, and they work with PostgreSQL's GiST and SP-GiST range indexes — no application-side period-math required.

**Distinctive vs. column comparisons:** the helpers exist because comparing two ranges with plain `>`/`<` does not capture intersection semantics. `[a,b] && [c,d]` is true when *any* point overlaps; you cannot express that with column-level scalar predicates.

---

## API

All three helpers share the same shape. Both the tuple form (returns an `ExpressionRef` for `.where()`) and the object form (returns a `WhereRangeIntent` for backward-compatible planner path) are supported.

### `rangeOverlaps(column, [lower, upper], rangeType?)`

```typescript
// doctest: skip — API signature reference
import { rangeOverlaps } from '@dbsp/core';

rangeOverlaps(
  column: string,                       // column name on the table being queried
  range: readonly [unknown, unknown],   // [lower, upper] tuple
  rangeType?: RangeType,                // defaults to 'daterange'
): ExpressionRef
```

Compiles to `"column" && rangeType($1, $2)`.

### `rangeContains(column, [lower, upper], rangeType?)`

Compiles to `"column" @> rangeType($1, $2)`. Use when the *stored* range must enclose the test range.

### `rangeContainedBy(column, [lower, upper], rangeType?)`

Compiles to `"column" <@ rangeType($1, $2)`. Use when the test range must enclose the *stored* one.

---

## Range types

`rangeType` controls the PostgreSQL constructor function emitted in SQL. It must match the column's declared type.

| `rangeType` | SQL function | Column type | Bound type |
|-------------|--------------|-------------|------------|
| `'daterange'` *(default)* | `daterange($1, $2)` | `daterange` | `date` |
| `'tsrange'` | `tsrange($1, $2)` | `tsrange` | `timestamp` |
| `'tstzrange'` | `tstzrange($1, $2)` | `tstzrange` | `timestamptz` |
| `'int4range'` | `int4range($1, $2)` | `int4range` | `integer` |
| `'int8range'` | `int8range($1, $2)` | `int8range` | `bigint` |
| `'numrange'` | `numrange($1, $2)` | `numrange` | `numeric` |

Mismatched types fail at the database, not at compile time — pass `rangeType` explicitly when your column is anything other than `daterange`.

---

## Examples

### Booking conflict detection

A reservation system stores room availability as `daterange` periods. To find conflicts for a candidate booking, search for any existing booking whose period overlaps the candidate.

```typescript
import { schema, createOrm, rangeOverlaps } from '@dbsp/core';
import { createPgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const __db = schema({
  bookings: {
    id: 'integer',
    roomId: 'integer',
    period: 'daterange',
  },
} as const);
const __orm = createOrm({ schema: __db, adapter: createPgsqlCompileOnlyAdapter() });

// "Does any booking conflict with 2024-06-10..2024-06-15?"
__orm
  .select('bookings')
  .where(rangeOverlaps('period', ['2024-06-10', '2024-06-15']))
  .dump();
// SQL: SELECT ... FROM "bookings" WHERE "period" && daterange($1, $2)
// params: ['2024-06-10', '2024-06-15']
```

### Pricing tier lookup

A pricing table stores tiers as `daterange` periods. To resolve "what tier applies on a given date", check which stored range contains that date (encode the date as a single-day range).

```typescript
import { schema, createOrm, rangeContains } from '@dbsp/core';
import { createPgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const __db = schema({
  pricingTiers: {
    id: 'integer',
    name: 'text',
    validity: 'daterange',
  },
} as const);
const __orm = createOrm({ schema: __db, adapter: createPgsqlCompileOnlyAdapter() });

// "Which tier covers 2024-06-15?"
__orm
  .select('pricingTiers')
  .where(rangeContains('validity', ['2024-06-15', '2024-06-15']))
  .dump();
// SQL: SELECT ... FROM "pricingTiers" WHERE "validity" @> daterange($1, $2)
```

### Quarterly events

Events are stored as `tstzrange` periods. To list every event scheduled inside Q1 2024 — i.e. whose stored window is *contained* by `[2024-01-01, 2024-04-01)` — use `rangeContainedBy` and pass an explicit `rangeType`.

```typescript
import { schema, createOrm, rangeContainedBy } from '@dbsp/core';
import { createPgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const __db = schema({
  events: {
    id: 'integer',
    name: 'text',
    occursAt: 'tstzrange',
  },
} as const);
const __orm = createOrm({ schema: __db, adapter: createPgsqlCompileOnlyAdapter() });

__orm
  .select('events')
  .where(
    rangeContainedBy(
      'occursAt',
      ['2024-01-01T00:00:00Z', '2024-04-01T00:00:00Z'],
      'tstzrange',
    ),
  )
  .dump();
// SQL: SELECT ... FROM "events" WHERE "occursAt" <@ tstzrange($1, $2)
```

### Numeric range — pricing band

The same operators work for numeric ranges. A product catalog might store discount tiers as `int4range` price bands.

```typescript
import { schema, createOrm, rangeOverlaps } from '@dbsp/core';
import { createPgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const __db = schema({
  discounts: {
    id: 'integer',
    band: 'int4range',
  },
} as const);
const __orm = createOrm({ schema: __db, adapter: createPgsqlCompileOnlyAdapter() });

// "Which discount bands include any price between 50 and 200?"
__orm
  .select('discounts')
  .where(rangeOverlaps('band', [50, 200], 'int4range'))
  .dump();
// SQL: SELECT ... FROM "discounts" WHERE "band" && int4range($1, $2)
```

---

## DDL — index for performance

Range operators benefit substantially from a GiST index on the range column. The DDL helpers wire this up with the `gist` index method:

```typescript
// doctest: skip — exec-only DDL example; requires a live PostgreSQL connection
await orm.tables.bookings.indexes.create({
  name: 'bookings_period_gist',
  columns: ['period'],
  method: 'gist',
});
```

Without a GiST index, range queries fall back to a sequential scan; with one, the planner uses index-only `&&`/`@>` lookups. See the [DDL Helpers guide](./ddl-helpers.md) for the full index API.

---

## Validation

The tuple form requires exactly two elements; passing a 0-, 1-, or 3+-element array throws synchronously with an actionable message:

```typescript
// doctest: skip — illustrative error path
rangeOverlaps('period', ['2024-01-01']);
// Error: range tuple must have exactly 2 elements (got 1); use [lower, upper] or pass a RangeValue object
```

This catches schema/usage drift at compile time of the query rather than producing malformed SQL the database rejects later.

---

## Related

- [Expression Primitives](./expression-primitives.md) — `op()`, `fn()`, `ref()` if you need a custom operator that range helpers don't cover (e.g. `&<` strict-left, `-|-` adjacent).
- [DDL Helpers](./ddl-helpers.md) — create the GiST index that makes these queries fast.
- [Joins](./joins.md) — combine range overlap checks with relation hydration.
