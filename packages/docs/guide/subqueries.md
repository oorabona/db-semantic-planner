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
import { createPgCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const db = schema({
  users: { id: 'integer', name: 'string', active: 'boolean' },
  blacklist: { userId: 'integer' },
} as const);
const orm = createOrm({ schema: db, adapter: createPgCompileOnlyAdapter() });

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

Embed an aggregate from another table as a column in the outer SELECT:

```typescript
import { schema, createOrm, subquery } from '@dbsp/core';
import { createPgCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const db = schema({
  symbols: { id: 'integer', name: 'string' },
  calls: { id: 'integer', symbolId: 'integer' },
} as const);
const orm = createOrm({ schema: db, adapter: createPgCompileOnlyAdapter() });

orm.select('symbols')
  .columns([
    'id',
    'name',
    subquery('calls')
      .count()
      .asExpr('callCount'),
  ])
  .dump();
// SQL: SELECT "id", "name",
//   (SELECT COUNT(*) FROM "calls") AS "callCount"
// FROM "symbols"
```

`.asExpr('alias')` wraps the `SubqueryExpression` as an `ExpressionSpec` for use in `.columns([...])`. Source: `packages/core/src/dx/subquery-builder.ts:175`.

`outerRef()` inside a SELECT-expression subquery is refused at compile time.

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
import { schema, createOrm, subquery, outerRef, eq } from '@dbsp/core';
import { createPgCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const db = schema({
  products: { id: 'integer', categoryId: 'integer', price: 'decimal' },
} as const);
const orm = createOrm({ schema: db, adapter: createPgCompileOnlyAdapter() });

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

Query WHERE scalar comparisons and `inSubquery()` compile the body with its own alias and resolve unqualified `outerRef()` to the immediately enclosing query and qualified references to the nearest matching enclosing table or alias. `rawExists()` and `rawNotExists()` use the same body compiler in WHERE, aggregate FILTER and recursive `start.where` anchors. All levels share one parameter sequence. Legacy `compilePlan()` and SELECT expression subqueries retain their existing correlation restrictions.

---

## Common pitfalls

### Nested aliases and correlation

Predicate subqueries allocate distinct aliases at every nesting depth and across siblings, including repeated queries on the same table. Unqualified `outerRef()` binds to the immediately enclosing query; qualified `outerRef('posts.id')` binds to the nearest enclosing query whose table or alias is `posts`; all levels share one parameter sequence. Duplicate explicit aliases in one scope are rejected.

```typescript
import { schema, createOrm, and, eq, inSubquery, outerRef, subquery } from '@dbsp/core';
import { createPgCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const db = schema({ users: { id: 'integer' }, posts: { id: 'integer', score: 'integer' } } as const);
const orm = createOrm({ schema: db, adapter: createPgCompileOnlyAdapter({ model: db.model }) });
const deepest = subquery('posts').select('id').where(and(eq('score', 3), eq('id', outerRef('id'))));
const middle = subquery('posts').select('id').where(and(eq('score', 2), eq('id', outerRef('id')), inSubquery('id', deepest)));
orm.select('users').where(inSubquery('id', subquery('posts').select('id').where(and(eq('score', 1), eq('id', outerRef('id')), inSubquery('id', middle))))).dump();
// params: [1, 2, 3]
```

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
