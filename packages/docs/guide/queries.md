---
title: Queries
---

# Querying Data

`@dbsp/core` provides a fluent, immutable query builder that compiles your intent into optimized PostgreSQL SQL. Every method returns a new builder instance — you can safely branch and reuse partial queries.

---

## Basic Select

```typescript
import { createOrm } from '@dbsp/core';

// Fetch all rows
const users = await orm.select('users').all();

// First row or undefined
const user = await orm.select('users').first();

// First row or throws NotFoundError
const user = await orm.select('users')
  .where(eq('id', someId))
  .firstOrThrow();
```

`all()` returns `Promise<T[]>`. `first()` returns `Promise<T | undefined>`. `firstOrThrow()` throws `NotFoundError` when no row matches.

---

## Filtering

Import filter helpers from `@dbsp/core`:

```typescript
import { eq, neq, gt, gte, lt, lte, like, inArray, isNull, isNotNull, and, or, not } from '@dbsp/core';

// Single condition
orm.select('users').where(eq('active', true))
orm.select('orders').where(gt('total', 100))
orm.select('users').where(like('email', '%@example.com'))
orm.select('users').where(inArray('status', ['active', 'pending']))
orm.select('users').where(isNull('deletedAt'))

// Compound
orm.select('users').where(and(eq('active', true), gt('age', 18)))
orm.select('users').where(or(eq('role', 'admin'), eq('role', 'moderator')))
orm.select('users').where(not(eq('deleted', true)))
```

| Helper | SQL | Helper | SQL |
|--------|-----|--------|-----|
| `eq` | `=` | `neq` | `!=` |
| `gt` | `>` | `gte` | `>=` |
| `lt` | `<` | `lte` | `<=` |
| `like` | `LIKE` | `inArray` | `IN` |
| `isNull` | `IS NULL` | `isNotNull` | `IS NOT NULL` |
| `and` | `AND` | `or` | `OR` |
| `not` | `NOT` | | |

---

## Column Selection

By default, all columns are selected. Use `.columns()` to select a subset:

```typescript
const names = await orm.select('users').columns(['id', 'name']).all();
// SQL: SELECT "id", "name" FROM "users"
```

---

## Ordering

```typescript
// Single column, ascending (default)
orm.select('users').orderBy('name')

// With explicit direction
orm.select('posts').orderBy('createdAt', 'desc')

// Multiple columns
orm.select('users').orderBy({ createdAt: 'desc', name: 'asc' })

// Advanced: nulls positioning
orm.select('users').orderBy([
  { column: 'createdAt', direction: 'desc', nulls: 'last' }
])
```

---

## Limiting and Offsetting

```typescript
// First 10 rows starting at position 20
const page = await orm.select('posts')
  .orderBy('createdAt', 'desc')
  .limit(10)
  .offset(20)
  .all();
```

For pagination use cases, prefer `.paginate()` or `.cursorPaginate()` — see [Getting Started](./getting-started).

---

## Distinct

```typescript
// DISTINCT — remove duplicate rows
const departments = await orm.select('users')
  .columns(['department'])
  .distinct()
  .all();
// SQL: SELECT DISTINCT "department" FROM "users"

// DISTINCT ON — PostgreSQL-specific
const latest = await orm.select('posts')
  .distinctOn('authorId')
  .orderBy('authorId')
  .orderBy('createdAt', 'desc')
  .all();
// SQL: SELECT DISTINCT ON ("author_id") * FROM "posts" ORDER BY "author_id", "created_at" DESC
```

---

## Type-Safe `from()`

Use `orm.tables` references for compile-time table name safety:

```typescript
const users = await orm.from(orm.tables.users).all();
```

This is equivalent to `orm.select('users')` but avoids string literals in code.

---

## Aggregation

```typescript
// COUNT — total rows
const total = await orm.select('users').count();

// COUNT with alias
const result = await orm.select('orders').count('id', 'totalOrders').all();

// SUM, AVG, MIN, MAX
orm.select('orders').sum('amount', 'totalRevenue')
orm.select('orders').avg('amount', 'averageOrder')
orm.select('products').min('price', 'cheapest')
orm.select('products').max('price', 'mostExpensive')
```

### GROUP BY and HAVING

```typescript
import { gt } from '@dbsp/core';

const summary = await orm.select('orders')
  .groupBy(['status'])
  .count('id', 'orderCount')
  .having(gt('orderCount', 10))
  .all();
// SQL: SELECT "status", COUNT("id") AS "orderCount"
//      FROM "orders"
//      GROUP BY "status"
//      HAVING "orderCount" > $1
```
