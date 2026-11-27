---
title: Queries
---

# Querying Data

`@dbsp/core` provides a fluent, immutable query builder that compiles your intent into optimized PostgreSQL SQL. Every method returns a new builder instance — you can safely branch and reuse partial queries.

---

## Basic Select

DBSP has two first-class SELECT entry points:

- `orm.select('users')` is the shorter table-name form. It is typed by table name when your ORM has a typed schema.
- `orm.from(orm.tables.users)` is the stricter TableRef form. It carries column-level types from `orm.tables.users` into filters and other query clauses.

The same query can be written either way:

```typescript
const activeUsersQuery = await orm
  .select('users')
  .where(eq('active', true))
  .dump();

const { users } = orm.tables;
const activeUsersFromRefQuery = await orm
  .from(users)
  .where(eq(users.active, true))
  .dump();
```

```typescript
// Assumes `db` from `schema({...})` and `orm` from `createOrm({ schema: db, adapter })` are in scope.
import { createOrm, eq } from '@dbsp/core';

const someId = 1;

// Fetch all rows
const users = await orm.select('users').dump();

// First row or undefined
const user1 = await orm.select('users').dump();

// First row or throws NotFoundError
const user2 = await orm.select('users')
  .where(eq('id', someId))
  .dump();
```

`all()` returns `Promise<T[]>`. `first()` returns `Promise<T | undefined>`. `firstOrThrow()` throws `NotFoundError` when no row matches.

---

## Filtering

Import filter helpers from `@dbsp/core`:

```typescript
import { eq, neq, gt, gte, lt, lte, like, inArray, isNull, isNotNull, and, or, not } from '@dbsp/core';

// Single condition
orm.select('users').where(eq('active', true))
orm.select('posts').where(gt('id', 100))
orm.select('users').where(like('email', '%@example.com'))
orm.select('users').where(inArray('status', ['active', 'pending']))
orm.select('users').where(isNull('deletedAt'))

// Compound
orm.select('users').where(and(eq('active', true), gt('age', 18)))
orm.select('users').where(or(eq('role', 'admin'), eq('role', 'moderator')))
orm.select('users').where(not(eq('deleted', true)))
```

An empty `or()` matches no row, and an empty `and()` matches every row.

`eq(col, null)` and `neq(col, null)` compile to `IS NULL` and `IS NOT NULL` without binding null, while `eq(col, param(null))` keeps `= $n` with a bound null value. Literal null is refused for `gt`, `gte`, `lt`, `lte`, `like`, and `ilike`; `isDistinctFrom(col, null)` compiles to `IS DISTINCT FROM NULL` without a parameter in every comparison position. A bare `undefined` right comparison operand is refused; use `isNull` or an explicit `param(...)`. Parameter wrappers bind their inner value, including in expression and JSON comparisons.

| Helper | SQL | Helper | SQL |
|--------|-----|--------|-----|
| `eq` | `=` | `neq` | `!=` |
| `gt` | `>` | `gte` | `>=` |
| `lt` | `<` | `lte` | `<=` |
| `like` | `LIKE` | `inArray` | `IN` |
| `isNull` | `IS NULL` | `isNotNull` | `IS NOT NULL` |
| `and` | `AND` | `or` | `OR` |
| `not` | `NOT` | | |

### Operands

The left operand of `eq`, `neq`, `gt`, `gte`, `lt`, `lte` and `isDistinctFrom` is a column name, a
`ColumnRef`, or any expression the [argument rule](./expression-primitives#argument-rule) accepts. An expression
is compared as an expression:

```typescript
import { schema, createOrm, eq, gt, fn, exprRef, subquery } from '@dbsp/core';
import { createPgCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const db = schema({ posts: { id: { type: 'integer', primaryKey: true }, title: 'text' } } as const);
const orm = createOrm({ schema: db, adapter: createPgCompileOnlyAdapter({ model: db.model }) });

orm.select('posts').where(eq(fn('upper', exprRef('title')), 'X')).dump();
// WHERE upper(posts.title) = $1
orm.select('posts').groupBy(['id']).having(gt(subquery('posts').count(), 1)).dump();
// HAVING (SELECT count(*) FROM posts AS posts_1) > $1
```

The right operand, and an object filter's value, is a value. Strings, numbers, booleans, `bigint`, arrays,
`Date` and plain objects are bound as parameters. An expression is compiled into the SQL instead:

| Right operand | Becomes |
|---|---|
| `exprRef()`, `fn()`, `literal()`, a `caseWhen(...).else(...)`, an `.asExpr()` spec, schema `ref()` | the expression, inlined |
| table `ColumnRef` (`orm.tables.posts.title`) | its qualified column, `posts.title` |
| `SubqueryExpression` (`subquery('t').count()`, `.build()`) | a scalar subquery |
| `outerRef(col)` inside a subquery body | the column of the enclosing query |
| `param(v)` | `v`, bound as given |

A `ColumnRef` value resolves like `exprRef('table.column')`. Inside a subquery over its own table it names the
subquery's row, not the outer one: write `outerRef('column')` to compare with the enclosing row. A table the
query cannot see is refused when the query is planned.

A plain object shaped like a parameter, `{ kind: 'param', value }`, binds `value`. To bind such an object as data,
wrap it in `param()`.

A query builder (`orm.select(...)`, `subquery('t').select('col')`) is a scalar subquery: `eq('id', builder)`,
`{ id: builder }` and `{ id: { $gt: builder } }` compare with `(SELECT …)`, the object-filter operators compiling as
the matching filter helpers do. See [Subqueries](./subqueries#scalar-subqueries-used-as-expressions) for the filter
policy the subquery keeps.

These are refused with an error naming the input: any other builder (a set operation, `withCte()`,
`orm.recursive()`, `orm.nql`, a mutation builder), a `sql()` marker, an unfinished `caseWhen()` without `.else()`,
and a `ColumnRef` reached through a relation or taken from a `some()`/`every()`/`none()` callback.

Two value positions cannot hold an expression yet and refuse one with `NotYetSupportedError`:

- a `like()` pattern, or `$like`/`$ilike` (#1066). Strings and `param()` are bound;
- an element of `inArray()`, `any()` or `$in` (#1064). `param(v)` elements bind `v`.

### Object filters and a `kind` column

`where()` reads an object as a condition built by a helper only when its `kind` names a condition kind and it
carries that kind's member (`field`, `conditions`, `condition`, `relation`, `subquery` or `expr`). An object
filter over a column named `kind` therefore filters that column:

```typescript
import { schema, createOrm } from '@dbsp/core';
import { createPgCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const db = schema({ symbols: { id: { type: 'integer', primaryKey: true }, kind: 'text' } } as const);
const orm = createOrm({ schema: db, adapter: createPgCompileOnlyAdapter({ model: db.model }) });

orm.select('symbols').where({ kind: 'function' }).dump();
// WHERE symbols.kind = $1
```

A filter that also names that kind's member column (`{ kind: 'comparison', field: 'x' }`) is read as a condition;
write the operator form instead: `{ kind: { $eq: 'comparison' }, field: 'x' }`.

---

## Column Selection

By default, all columns are selected. Use `.columns()` to select a subset:

```typescript
const names = await orm.select('users').columns(['id', 'name']).dump();
// SQL: SELECT "id", "name" FROM "users"
```

A `.columns()` entry can also be a `ColumnRef` from `orm.tables`, an aliased one, or an expression. An unaliased
`ColumnRef` of the queried table is the same column as its name; a `ColumnRef` of another table needs that table in
the query, through a join:

```typescript
const { posts } = orm.tables;

orm.select('posts').columns(['id', posts.title, posts.createdAt.as('created')]).dump();
// SQL: SELECT posts.id, posts.title, posts."createdAt" AS created FROM posts
```

A constant (`1`, `true`, a `Date`, an array) and a bare `subquery(...)` need a name, so `.columns()` refuses them with
an `InvalidOperationError`: write `literal(value).as(alias)`, `param(value).as(alias)` or `subquery(...).asExpr(alias)`.
A `ColumnRef` reached through a relation (`posts.author.name`) or taken from a `some()` / `every()` / `none()`
callback parameter is refused with a `NotYetSupportedError` (#1052), aliased or not.

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

`.orderBy()` and a `{ column }` entry also take a `ColumnRef`, an expression, a scalar subquery, or a positive
integer naming a selected column by position:

```typescript
import { subquery } from '@dbsp/core';

const { posts } = orm.tables;

orm.select('posts').orderBy(posts.createdAt, 'desc').dump();
// SQL: SELECT posts.* FROM posts ORDER BY posts."createdAt" DESC

// A relation ColumnRef orders by the joined relation
orm.select('posts').join('author').orderBy(posts.author.name).dump();
// SQL: SELECT posts.* FROM posts JOIN users AS author ON posts."authorId" = author.id ORDER BY author.name ASC

orm.select('users').orderBy(subquery('posts').count(), 'desc').dump();
// SQL: SELECT users.* FROM users ORDER BY (SELECT count(*) FROM posts) DESC

orm.select('posts').columns(['title', 'createdAt']).orderBy(2, 'desc').dump();
// SQL: SELECT posts.title, posts."createdAt" FROM posts ORDER BY 2 DESC
```

A `ColumnRef` stays qualified in `ORDER BY`, so a selected alias with the same name does not capture it. An ordering
that names no column — a `Date`, a boolean, a `bigint`, `0`, a fraction — is refused with an `InvalidOperationError`,
and so is a list element that is not a `{ column, direction?, nulls? }` object. `.cursorPaginate()` reads each
ordered column back from the row by its output name, so it refuses a qualified ordering (`orderBy(posts.id)`,
`orderBy('posts.id')`): order by the column name instead (#1074).

---

## Limiting and Offsetting

```typescript
// First 10 rows starting at position 20
const page = await orm.select('posts')
  .orderBy('createdAt', 'desc')
  .limit(10)
  .offset(20)
  .dump();
```

For pagination use cases, prefer `.paginate()` or `.cursorPaginate()` — see [Pagination](./pagination) for the full pattern guide.

---

## Distinct

```typescript
// DISTINCT — remove duplicate rows
const departments = await orm.select('users')
  .columns(['department'])
  .distinct()
  .dump();
// SQL: SELECT DISTINCT "department" FROM "users"

// DISTINCT ON — PostgreSQL-specific
const latest = await orm.select('posts')
  .distinctOn('authorId')
  .orderBy('authorId')
  .orderBy('createdAt', 'desc')
  .dump();
// SQL: SELECT DISTINCT ON ("author_id") * FROM "posts" ORDER BY "author_id", "created_at" DESC

// DISTINCT ON a ColumnRef — the column stays qualified
const { posts } = orm.tables;
orm.select('posts')
  .distinctOn(posts.authorId)
  .orderBy(posts.authorId)
  .orderBy(posts.createdAt, 'desc')
  .dump();
// SQL: SELECT DISTINCT ON (posts."authorId") posts.* FROM posts ORDER BY posts."authorId" ASC, posts."createdAt" DESC

// DISTINCT ON a joined relation column — compile-only inspection
const latestPostPerAuthorEmail = orm.select('posts')
  .include('author', { join: 'inner' })
  .distinctOn('author.email')
  .columns(['id', 'title'])
  .dump();

if (
  !latestPostPerAuthorEmail.sql.includes('DISTINCT ON (author.email)') ||
  !latestPostPerAuthorEmail.sql.includes('JOIN users AS author') ||
  latestPostPerAuthorEmail.params.length !== 0
) {
  throw new Error('relation-column distinctOn() did not compile as expected');
}
```

---

## Table-Ref `from()`

Use `orm.from()` when you want to start from an `orm.tables` reference and keep column refs available for typed filters:

```typescript
const { users } = orm.tables;

const result = await orm
  .from(users)
  .where(eq(users.email, 'alice@example.com'))
  .columns(['id', 'name'])
  .dump();
```

It returns the same query builder surface as `orm.select('users')`, including `.columns()`, `.include()`, `.withPlanOptions()`, `.dump()`, and execution methods.

---

## Aggregation

```typescript
import { distinct } from '@dbsp/core';

orm.select('users').count().dump();
// SQL: SELECT count(*) FROM users

orm.select('posts').count({ as: 'postCount' }).dump();
// SQL: SELECT count(*) AS "postCount" FROM posts

orm.select('posts').count(distinct('authorId'), 'authors').dump();
// SQL: SELECT count(DISTINCT posts."authorId") AS authors FROM posts

// sum(), avg(), min() and max() take a field and an optional alias
orm.select('users').max('createdAt', 'latestSignup').dump();
// SQL: SELECT max(users."createdAt") AS "latestSignup" FROM users
```

### GROUP BY and HAVING

```typescript
import { gt } from '@dbsp/core';

orm.select('posts')
  .groupBy(['published'])
  .count('id', 'postCount')
  .having(gt('postCount', 10))
  .dump();
// SQL: SELECT posts.published, count(posts.id) AS "postCount" FROM posts
//      GROUP BY posts.published HAVING count(posts.id) > CAST($1 AS bigint)
```

Without `.columns()`, the `groupBy` fields are projected before the aggregates. With string `.columns()`,
those columns are projected instead:

```typescript
orm.select('posts')
  .groupBy(['authorId', 'published'])
  .columns(['authorId'])
  .count({ as: 'postCount' })
  .dump();
// SQL: SELECT posts."authorId", count(*) AS "postCount" FROM posts GROUP BY posts."authorId", posts.published
```

`groupBy()` fields, `distinctOn()` columns and the field of `count()`, `sum()`, `avg()`, `min()`, `max()` and
`distinct()` each name a column: a column name or a `ColumnRef`, and an alias on the ref is ignored. In `groupBy()`
and the aggregate methods, a `ColumnRef` of the queried table is used as its bare column name; `distinctOn()` and
`distinct()` keep it qualified:

```typescript
import { distinct } from '@dbsp/core';

const { posts } = orm.tables;

orm.select('posts').groupBy([posts.published]).count(posts.id, 'postCount').dump();
// SQL: SELECT posts.published, count(posts.id) AS "postCount" FROM posts GROUP BY posts.published

orm.select('posts').count(distinct(posts.authorId), 'authors').dump();
// SQL: SELECT count(DISTINCT posts."authorId") AS authors FROM posts
```

An expression in these positions is refused with a `NotYetSupportedError` (#1072). `null`, `undefined`, a plain
object and `sql()` are refused with an `InvalidOperationError`, except that `count()` reads a plain object as its
`{ field?, as? }` options. `min()` and `max()` take no `distinct()`, and `count({ field, distinct: true })` with a
`ColumnRef` field is refused: write `count(distinct(field))`.

`count()`, `sum()`, `avg()`, `min()` and `max()` throw an `InvalidOperationError` beside an expression
projection from `.columns()` or `.coalesce()`. Put the aggregate in `.columns()` instead:

```typescript
import { exprRef, fn, star } from '@dbsp/core';

orm.select('posts')
  .columns([exprRef('authorId').as('author'), fn('count', star()).as('postCount')])
  .groupBy(['authorId'])
  .dump();
// SQL: SELECT "authorId" AS author, count(*) AS "postCount" FROM posts GROUP BY posts."authorId"
```
