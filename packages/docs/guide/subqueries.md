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

`.asExpr('alias')` wraps the `SubqueryExpression` as an `ExpressionSpec` for use in `.columns([...])`. Source: `packages/core/src/dx/subquery-builder.ts:175`. An ORM query builder has the same method: `orm.select('calls').where(eq('symbolId', outerRef('id'))).count({ as: 'n' }).asExpr('callCount')` is a named subquery column that keeps that builder's filter policy. A builder in `.columns([...])` without `.asExpr()` is refused, as a bare `SubqueryExpression` is.

SELECT-expression subqueries, including those nested in `op(...)`, support `outerRef()` in their WHERE and HAVING. Unqualified references bind the immediately enclosing query; qualified references search enclosing queries nearest first: in each query, a written include key wins, then an exact emitted qualifier, otherwise the logical table must have exactly one range. Ambiguous logical tables are refused. A FROM-less `selectExpression()` can correlate nested subqueries to their enclosing subquery, but has no row of its own. An unqualified `outerRef()` in its immediate subquery body reads that missing row and is refused with `selectExpression() cannot read column '<name>'; a FROM-less SELECT has no row. …`; a qualified one names a range no enclosing query has and is refused with `outerRef qualifier '<q>' is not visible in an enclosing query.` Neither binds the subquery's own range.

In a root query, an `outerRef()` in HAVING, a CASE WHEN condition or an aggregate FILTER has no enclosing range and is refused with `outerRef() requires an enclosing query range.`, as in WHERE, a subquery over a CTE or an NQL binding beside it included. This holds for reads planned with a model (the ORM, NQL and `plan()`).

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
scalar positions (`.asExpr()`, a comparison operand); `inSubquery` takes a field only and refuses it.

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

Query WHERE scalar comparisons and `inSubquery()` compile the body with its own alias and resolve unqualified `outerRef()` to the immediately enclosing query and qualified references by searching enclosing queries nearest first: in each query, a written include key wins, then an exact emitted qualifier; otherwise a logical table must have exactly one range in that query, with multiple ranges refused as ambiguous and their aliases named. `rawExists()` and `rawNotExists()` use the same body compiler; correlated bodies compile in query WHERE, recursive `start.where` anchors, CASE WHEN and aggregate FILTER. Root WHERE bodies, including those combined with dotted relation paths, resolve during `plan()`; see [WHERE qualifiers](./joins#where-qualifiers-and-planning). Join include `where` resolves during `plan()` with the include as its current range and its immediate source followed by ancestor scopes for outer references. All levels share one parameter sequence. SELECT-expression subquery bodies use this canonical route too, with their own emitted alias.

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

Bodies reached from the root WHERE carry their own resolved ranges and share the query's allocator. Options a body cannot carry yet throw `NotYetSupportedError` at `plan()`, naming the first such option in its `construct` field and issue #1087 (#1030, #1031 or #1039 for a flat include, a `batchValuesSource` or a join in a scalar-comparison body): GROUP BY, HAVING, OFFSET, DISTINCT, DISTINCT ON, joins, `existsWrap`, a lock, a `batchValuesSource`, an expression ORDER BY, an aggregate or expressions projection whatever its length (more than one aggregate in a scalar-comparison body; a single aggregate there compiles), any include in a `rawExists()` / `rawNotExists()` body and a flat include elsewhere, and ORDER BY and LIMIT in a `rawExists()` / `rawNotExists()` body. Scalar-comparison and IN bodies retain supported field ordering and LIMIT. A plain error, by body: in an IN body, a fields projection that is missing, `*`, empty, of several fields or with a non-string entry; in a scalar-comparison body, a fields projection of several fields; in either, an include with an entry that is not flat. A `rawExists()` body has no projection refusal. Under `existsWrap` none of these plain errors applies: the body throws the `NotYetSupportedError` for `existsWrap`, or for an option listed before it.

### Scalar subqueries used as expressions

With a model, a scalar subquery used as a value — in `.columns()`, `.orderBy()`, a HAVING operand, a WHERE expression, or inside `fn`, `op`, CASE or FILTER — is planned as a nested select by the same resolver as a root query, inside its enclosing query:

- Its GROUP BY, HAVING, DISTINCT, DISTINCT ON, ORDER BY, LIMIT, OFFSET, expression projections and lock compile as they do at the root, and its SQL is the root SQL of the same query apart from its alias and the `outerRef()` correlation.
- Its default filter applies once, first in its WHERE, as at the root. A query builder passed directly, or its `.asExpr(alias)`, keeps its own filter policy: `orm.select(...)` carries its ORM's default filters, `orm.withoutDefaultFilters().select(...)` carries none, whatever the enclosing query uses. A `subquery(table)` builder has no policy of its own and reads the filters in force where it is planned; in a mutation WHERE, a body without its own policy is not filtered. The same holds for `inSubquery()`, `rawExists()` and `rawNotExists()`, which take `orm.select(...)`, `subquery(table)` or a `SubqueryExpression` and refuse any other builder.
- A builder body is compiled under the enclosing query's schema scope, whatever ORM or `withSchema()` context issued it (#1078).
- Its alias is its table name when no range of the statement uses that name, otherwise `<table>_1`, `<table>_2`…, skipping every name a FROM can read: a model table, an NQL binding or a CTE (cut to 63 bytes).
- Its plan warnings, raw SQL included, follow the enclosing query's own warnings in that query's `PlanReport.warnings`. A body in a mutation WHERE or in a recursive `start.where` has no such report, so its warnings are not surfaced.
- A body that projects more than one column is refused: `scalar subquery body projects <n> columns; a scalar subquery yields one value.` The count reads the columns the body's SQL selects: a star, which an absent or empty projection selects, counts as every column of the body's model table; duplicate columns count once. A star over an NQL binding or a CTE is not counted at compile time (#1123): PostgreSQL refuses such a body when it returns more than one column (`subquery must return only one column`).
- An `include()` that hydrates nested objects is refused: `include('<relation>') in a scalar subquery body hydrates nested objects; a scalar subquery yields one value.`
- A flat include (#1030), a `batchValuesSource` (#1031) and a join (#1039) are not supported yet: they throw `NotYetSupportedError`, whose `issue` field names the issue. The same three issues apply to a scalar-comparison body in a condition.
- A body whose FROM names an NQL binding or a CTE (an NQL `bind` or `with`, `orm.withCte()`, `orm.recursive()`, the source of an insert-from) is planned the same way, with every body below it. Its columns are the source's projection: where that projection is known (an NQL binding or `with`, `orm.withCte()`, `orm.recursive()`), a column outside it is refused with `Local relation '<name>' does not project expression column '<column>'.`; the source of an insert-from or upsert-from has no known projection, and PostgreSQL checks its columns at execution. A table's default filter never applies to a read of such a source, even one named like that table, while a table read below the body keeps its own filter. A body on the same source as its enclosing query reads its own rows under its alias (`recent AS recent_1`).

Compilation follows [Authored intent and execution authority](./observability.md#authored-intent-and-execution-authority).
