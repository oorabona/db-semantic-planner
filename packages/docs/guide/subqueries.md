---
title: Subqueries
description: IN subqueries, scalar subqueries in SELECT, and correlated EXISTS patterns with @dbsp/core subquery builders.
---

# Subqueries

A subquery is a query nested inside another query. `@dbsp/core` provides three ways to embed subqueries: as an `IN` list via `inSubquery()`, as a scalar expression in SELECT via `.asExpr()`, and as an existence check via `exists()` / `rawExists()`. Knowing which to pick avoids both correctness bugs and unnecessary performance costs.

## Why this matters

The common misconception is "a JOIN always replaces a subquery." JOINs and subqueries are semantically different: a correlated subquery re-evaluates per outer row; a JOIN produces the cross-product before filtering. PostgreSQL's planner often rewrites IN subqueries to semi-joins automatically, but understanding the intent helps you write the right construct from the start.

---

## The mental model

`subquery('table')` builds a sub-builder that accumulates `.select()`, `.where()`, and aggregate methods, but **never executes on its own**. It produces a `SubqueryBuilder` or `SubqueryExpression` that you pass to a parent query.

Source: `packages/core/src/dx/subquery-builder.ts:33` — `SubqueryBuilder` and `SubqueryExpression`.

---

## Pattern: IN subquery

Filter rows where a column's value exists in the result of another query:

```typescript
import { schema, createOrm, inSubquery, subquery } from '@dbsp/core';
import { createPgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const db = schema({
  users: { id: 'integer', name: 'string', active: 'boolean' },
  blacklist: { userId: 'integer' },
} as const);
const orm = createOrm({ schema: db, adapter: createPgsqlCompileOnlyAdapter() });

orm.select('users')
  .where(inSubquery('id', subquery('blacklist').select('userId')))
  .dump();
// SQL: SELECT ... FROM "users"
// WHERE "id" = ANY (SELECT "user_id" FROM "blacklist")
// params: []
```

`inSubquery()` is exported from `packages/core/src/dx/filters.ts:290`. It compiles to PostgreSQL's `= ANY (SELECT ...)` syntax, which the planner can convert to a semi-join.

---

## Pattern: scalar subquery in SELECT

Embed an aggregate from a related table as a column in the outer SELECT:

```typescript
import { schema, createOrm, subquery, outerRef, eq } from '@dbsp/core';
import { createPgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const db = schema({
  symbols: { id: 'integer', name: 'string' },
  calls: { id: 'integer', symbolId: 'integer' },
} as const);
const orm = createOrm({ schema: db, adapter: createPgsqlCompileOnlyAdapter() });

orm.select('symbols')
  .columns([
    'id',
    'name',
    subquery('calls')
      .where(eq('symbolId', outerRef('id')))
      .count()
      .asExpr('callCount'),
  ])
  .dump();
// SQL: SELECT "id", "name",
//   (SELECT COUNT(*) FROM "calls" WHERE "symbolId" = "symbols"."id") AS "callCount"
// FROM "symbols"
```

`.asExpr('alias')` wraps the `SubqueryExpression` as an `ExpressionSpec` for use in `.columns([...])`. Source: `packages/core/src/dx/subquery-builder.ts:175`.

Aggregate methods available on `SubqueryBuilder`:

| Method | SQL |
|--------|-----|
| `.count(field?)` | `COUNT(*)` or `COUNT("field")` |
| `.sum(field)` | `SUM("field")` |
| `.avg(field)` | `AVG("field")` |
| `.min(field)` | `MIN("field")` |
| `.max(field)` | `MAX("field")` |

---

## Pattern: EXISTS with the `exists()` builder

Use `exists()` for an existence check correlated to the outer query via FK:

```typescript
// doctest: skip — exists() is documented in detail in the exists-vs-rawexists guide
import { schema, createOrm, exists, eq } from '@dbsp/core';

// Find all users who have at least one published post
orm.select('users')
  .where(exists('posts', { where: eq('published', true) }))
  .dump();
// SQL: SELECT ... FROM "users" WHERE EXISTS (
//   SELECT 1 FROM "posts" WHERE "author_id" = "users"."id" AND "published" = $1
// )
```

The correlation predicate (`author_id = users.id`) is resolved automatically from the FK defined in the schema. See [exists() vs rawExists()](./exists-vs-rawexists) for the full decision tree.

---

## Pattern: correlated subqueries with `outerRef()`

`outerRef(column)` creates a reference to a column in the outer query for use in a subquery's WHERE condition:

```typescript
// doctest: skip — correlated outerRef() is not yet supported (see warning below); shown as the intended future syntax
import { schema, createOrm, subquery, outerRef, eq } from '@dbsp/core';
import { createPgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const db = schema({
  products: { id: 'integer', categoryId: 'integer', price: 'decimal' },
} as const);
const orm = createOrm({ schema: db, adapter: createPgsqlCompileOnlyAdapter() });

// Find products priced above the average in their category
orm.select('products')
  .where({
    price: {
      $gt: subquery('products')
        .where(eq('categoryId', outerRef('categoryId')))
        .avg('price'),
    },
  })
  .dump();
```

Source: `packages/core/src/dx/subquery-builder.ts:288` — `outerRef(column)` returns a `SubqueryRefIntent`.

::: warning Correlated subqueries with `outerRef()` are not yet supported
Wiring `outerRef()` through the correlation pipeline is not yet implemented for **either** a scalar subquery (as in the example above) **or** `rawExists()`. Passing `outerRef()` inside either is detected at compile time and throws a clear error (e.g. `"scalar subquery with correlated outerRef() is not yet supported"` / `"rawExists: correlated subqueries (outerRef inside the inner WHERE) are not yet supported"`). The example above shows the intended future syntax. Today, use the `exists('relation', { where })` builder (FK-correlated) or expression-primitive `op()` patterns instead. Tracked as a known limitation.
:::

---

## Common pitfalls

### Alias collisions in scalar subqueries

If you reference the same table in both the outer query and the subquery, PostgreSQL may alias them identically. The planner handles table-level aliasing in the outer query, but the subquery compiles to bare table references. Disambiguate by ensuring the two SELECT targets are different tables or by using a CTE.

### Performance: subquery vs JOIN

An uncorrelated `IN` subquery is typically rewritten to a hash semi-join by PostgreSQL and performs similarly to an explicit JOIN. A correlated subquery (one that re-references an outer column) re-evaluates the inner query for each outer row inside the database — it is still a single SQL statement with no extra client/server round-trips, but the database cost can multiply if the planner cannot rewrite the correlated scan (nested-loop semantics). For large datasets with a correlated scalar subquery, consider a lateral join or a CTE materialisation.

### Subquery builders do not execute alone

A `SubqueryBuilder` or `SubqueryExpression` has no `.all()` or `.execute()` method — it is only valid as an argument to a parent query builder. Attempting to call it directly produces a TypeScript compile error.

---

## See also

- [exists() vs rawExists()](./exists-vs-rawexists) — detailed guide on correlated existence checks
- [Set Operations](./set-operations) — UNION, INTERSECT, EXCEPT
- [Joins](./joins) — explicit JOIN alternatives to subqueries
- [Expression Primitives](./expression-primitives) — raw operator composition for unsupported subquery patterns
