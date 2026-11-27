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
// SQL: SELECT symbols.id, symbols.name,
//   (SELECT count(*) FROM calls) AS "callCount"
// FROM symbols
```

`.asExpr('alias')` wraps the `SubqueryExpression` as an `ExpressionSpec` for use in `.columns([...])`. Source: `packages/core/src/dx/subquery-builder.ts:175`.

SELECT-expression subqueries, including those nested in `op(...)`, support `outerRef()` in their WHERE and HAVING. Unqualified references bind the immediately enclosing query; qualified references search enclosing queries nearest first: in each query, a written include key wins, then an exact emitted qualifier, otherwise the logical table must have exactly one range. Ambiguous logical tables are refused. A FROM-less `compileSelectExpression()` can correlate nested subqueries to their enclosing subquery, but has no outer table of its own. An `outerRef()` (qualified or unqualified) in its immediate subquery body is refused with `outerRef() requires an enclosing query range.`; it never binds that subquery's own range.

In a root query, an `outerRef()` in HAVING, a CASE WHEN condition or an aggregate FILTER has no enclosing range and is refused with `outerRef() requires an enclosing query range.`, as in WHERE, unless that condition sits inside or holds a subquery over a CTE or an NQL binding and no aggregate alias, relation predicate or dotted field in it already makes core resolve it. This holds for reads planned with a model (the ORM, NQL and `plan()`); hand-built `compilePlan` decisions and reads compiled without a model keep their route.

Aggregate methods available on `SubqueryBuilder`:

| Method | SQL |
|--------|-----|
| `.count(field?)` | `COUNT(*)` or `COUNT("field")` |
| `.sum(field)` | `SUM("field")` |
| `.avg(field)` | `AVG("field")` |
| `.min(field)` | `MIN("field")` |
| `.max(field)` | `MAX("field")` |

Each aggregate field is a column name or a `ColumnRef` (`subquery('posts').max(orm.tables.posts.score)`); an
expression there is refused as not yet supported (#1072), and `count(null)` is refused.

`.select(x)` takes a column name or a `ColumnRef` of the subquery's table as a field, and any other leaf as an
expression column: `subquery('posts').select(fn('lower', exprRef('title')))` gives `(SELECT lower(title) FROM
posts …)`, `.select(orm.tables.users.name)` reads the enclosing query's column. An expression column serves the
scalar positions (`.asExpr()`, a comparison operand); `inSubquery` takes a field only and refuses it, and so does a
scalar subquery over a CTE or binding source.

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

`outerRef(column)` creates a reference to a column in the outer query for use in a subquery's WHERE condition. Successive `subquery(...).where()` calls combine with AND, so a correlation set by one call is kept by the next:

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

Query WHERE scalar comparisons and `inSubquery()` compile the body with its own alias and resolve unqualified `outerRef()` to the immediately enclosing query and qualified references by searching enclosing queries nearest first: in each query, a written include key wins, then an exact emitted qualifier; otherwise a logical table must have exactly one range in that query, with multiple ranges refused as ambiguous and their aliases named. `rawExists()` and `rawNotExists()` use the same body compiler; correlated bodies compile in query WHERE, recursive `start.where` anchors, CASE WHEN and aggregate FILTER. Root WHERE bodies, including those combined with dotted relation paths, resolve during `plan()`; see [WHERE qualifiers](./joins#where-qualifiers-and-planning). Join include `where` resolves during `plan()` with the include as its current range and its immediate source followed by ancestor scopes for outer references. All levels share one parameter sequence. SELECT-expression subquery bodies use this canonical route too, with their own emitted alias. Legacy `compilePlan()` (from `@dbsp/adapter-pgsql/internal`) retains its existing correlation restrictions.

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

Bodies reached from the root WHERE carry their own resolved ranges and share the query's allocator. Unsupported options refuse at `plan()` with the existing compilation message. `rawExists()` / `rawNotExists()` reject ORDER BY and LIMIT; scalar-comparison bodies retain supported field ordering and LIMIT. Legacy direct scalar bodies outside this route retain their ORDER BY/LIMIT refusals. IN bodies require one named projected column and reject aggregate SELECT, GROUP BY, HAVING, OFFSET, DISTINCT ON, locks and other unsupported structural modifiers.

### Scalar subqueries used as expressions

With a model, a scalar subquery used as a value — in `.columns()`, `.orderBy()`, a HAVING operand, a WHERE expression, or inside `fn`, `op`, CASE or FILTER — is planned as a nested select by the same resolver as a root query, inside its enclosing query:

- Its GROUP BY, HAVING, DISTINCT, DISTINCT ON, ORDER BY, LIMIT, OFFSET, expression projections and lock compile as they do at the root, and its SQL is the root SQL of the same query apart from its alias and the `outerRef()` correlation.
- Its default filter applies once, first in its WHERE, as at the root. A body built with its own policy (`buildSubqueryIntent()`, `withoutDefaultFilters()`) keeps it; in a mutation WHERE, a body without its own policy is not filtered.
- Its alias is its table name when no range of the statement uses that name, otherwise `<table>_1`, `<table>_2`… (cut to 63 bytes).
- Its plan warnings, raw SQL included, follow the enclosing query's own warnings in that query's `PlanReport.warnings`. A body in a mutation WHERE or in a recursive `start.where` has no such report, so its warnings are not surfaced.
- A body that projects more than one column is refused: `scalar subquery body projects <n> columns; a scalar subquery yields one value.` The count reads the columns the body's SQL selects: a star, which an absent or empty projection selects, counts as every column of the body's table; duplicate columns count once.
- An `include()` that hydrates nested objects is refused: `include('<relation>') in a scalar subquery body hydrates nested objects; a scalar subquery yields one value.`
- A flat include (#1030), a `batchValuesSource` (#1031) and a join (#1039) are not supported yet: they throw `NotYetSupportedError`, whose `issue` field names the issue.
- A body whose FROM names an NQL binding or a CTE keeps the adapter's route, with every body below it. Such a subtree that scans a table with a default filter, or carries a builder policy, throws `NotYetSupportedError` (#1040).
- Inside a body planned as a nested select, such a body in a column, ORDER BY or HAVING expression throws `NotYetSupportedError` when it, or a body below it, holds a qualified `outerRef()`: `a qualified outerRef() in a local-source subquery body is not supported yet (#1040).` An unqualified `outerRef()` there binds the immediately enclosing query. In a WHERE, or in a condition holding an `outerRef()` of its own or naming a HAVING aggregate alias, core binds both forms.

Without a model, the adapter compiles a scalar subquery body from its intent, and the rules above do not apply.

Compilation follows [Authored intent and execution authority](./observability.md#authored-intent-and-execution-authority).
