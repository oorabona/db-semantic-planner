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
const names = await orm.select('users').columns(['id', 'name']).dump();
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
// COUNT — total rows
const { sql: totalSql } = orm.select('users').dump();

// COUNT with alias
const { sql: resultSql } = orm.select('posts').dump();

// SUM, AVG, MIN, MAX (use dump() to inspect compiled SQL)
orm.select('posts').dump()
orm.select('posts').dump()
orm.select('users').dump()
orm.select('users').dump()
```

### GROUP BY and HAVING

```typescript
import { gt } from '@dbsp/core';

const summary = await orm.select('posts')
  .groupBy(['published'])
  .dump();
// SQL: SELECT "status", COUNT("id") AS "orderCount"
//      FROM "posts"
//      GROUP BY "status"
//      HAVING "orderCount" > $1
```
