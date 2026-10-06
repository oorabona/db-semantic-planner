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
//   (SELECT COUNT(*) FROM "calls" AS "calls") AS "callCount"
// FROM "symbols"
```

`.asExpr('alias')` wraps the `SubqueryExpression` as an `ExpressionSpec` for use in `.columns([...])`. Source: `packages/core/src/dx/subquery-builder.ts:175`.

SELECT-expression subqueries, including those nested in `op(...)`, support `outerRef()` in their WHERE body. Unqualified references bind the immediately enclosing query; qualified references search enclosing queries nearest first: in each query, a written include key wins, then an exact emitted qualifier, otherwise the logical table must have exactly one range. Ambiguous logical tables are refused. A FROM-less `compileSelectExpression()` can correlate nested subqueries to their enclosing subquery, but has no outer table of its own. An `outerRef()` (qualified or unqualified) in its immediate subquery body is refused with `outerRef() requires an enclosing query range.`; it never binds that subquery's own range.

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

Query WHERE scalar comparisons and `inSubquery()` compile the body with its own alias and resolve unqualified `outerRef()` to the immediately enclosing query and qualified references by searching enclosing queries nearest first: in each query, a written include key wins, then an exact emitted qualifier; otherwise a logical table must have exactly one range in that query, with multiple ranges refused as ambiguous and their aliases named. `rawExists()` and `rawNotExists()` use the same body compiler; correlated bodies compile in query WHERE and are refused in aggregate FILTER and recursive `start.where` anchors. Root WHERE bodies, including those combined with dotted relation paths, resolve during `plan()`; see [WHERE qualifiers](./joins#where-qualifiers-and-planning). Join include `where` resolves during `plan()` with the include as its current range and its immediate source followed by ancestor scopes for outer references. All levels share one parameter sequence. SELECT-expression subquery bodies use this canonical route too, with their own emitted alias. Legacy `compilePlan()` (from `@dbsp/adapter-pgsql/internal`) retains its existing correlation restrictions.

---

## Common pitfalls

### Nested aliases and correlation

Predicate subqueries allocate distinct aliases at every nesting depth and across siblings, including repeated queries on the same table. Unqualified `outerRef()` binds to the immediately enclosing query; qualified `outerRef('posts.id')` searches enclosing queries nearest first. In each query, a written include key wins, then an exact emitted qualifier; otherwise a logical-table match requires exactly one range of that table in that query. Multiple ranges are refused as ambiguous, naming their aliases; no match in any enclosing query is refused as not visible. Root ranges, manual joins (with explicit or implicit aliases) and join includes are visible under their emitted qualifiers and logical tables. All levels share one parameter sequence. A manual `.join()` qualifier repeating an emitted range (root, implicit or explicit alias) is refused; the root logical name is also reserved. Generated subquery aliases are reallocated.

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

## Planning refusals

Bodies reached from the root WHERE carry their own resolved ranges and share the query's allocator. Unsupported options refuse at `plan()` with the existing compilation message. `rawExists()` / `rawNotExists()` reject ORDER BY and LIMIT; scalar-comparison bodies retain supported field ordering and LIMIT. Legacy direct scalar bodies outside this route retain their ORDER BY/LIMIT refusals. IN bodies require one named projected column and reject aggregate SELECT, GROUP BY, HAVING, OFFSET, DISTINCT ON, locks and other unsupported structural modifiers. Scalar subqueries used as expressions keep their supported projection, ordering and limit options.

Compilation follows [Authored intent and execution authority](./observability.md#authored-intent-and-execution-authority).
