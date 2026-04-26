---
title: ORM API Reference
---

# ORM API Guide

This is the complete reference for the `@dbsp/core` TypeScript API. It covers schema definition, ORM setup, query building, mutations, and observability — with progressive examples from a minimal first query to advanced patterns like set operations, CTEs, and streaming. Use it as your primary reference when building applications with `@dbsp/core`.

**Related guides:** [NQL Reference](../nql/) | [README](https://github.com/oorabona/db-semantic-planner)

---

## Quick Start

Go from zero to your first typed query in 3 steps.

### Install

```bash
npm install @dbsp/core @dbsp/adapter-pgsql pg
# or
pnpm add @dbsp/core @dbsp/adapter-pgsql pg
```

### Define Your Schema

```typescript
import { schema, ref } from '@dbsp/core';

const db = schema({
  users: {
    id: { type: 'uuid', primaryKey: true },
    email: { type: 'text', unique: true },
    name: 'string',
    active: 'boolean',
  },
  posts: {
    id: { type: 'uuid', primaryKey: true },
    title: 'string',
    content: { type: 'text', nullable: true },
    published: 'boolean',
    authorId: ref('users'),
  },
});
```

### Query with Full Type Safety

```typescript
// doctest: skip — exec-only operation; requires a real PostgreSQL connection
import { createOrm, eq } from '@dbsp/core';
import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = createPgsqlAdapter(pool, { dbCasing: 'snake_case' });
const orm = createOrm({ schema: db, adapter });

// Type-safe queries — table names and columns are autocompleted
const activeUsers = await orm.select('users')
  .where(eq('active', true))
  .include('posts')
  .all();
// activeUsers: Array<{ id: string; email: string; name: string; active: boolean; posts: Array<...> }>

// Inspect what the planner decided
const dump = orm.select('users').include('posts').dump();
console.log(dump.sql);       // Compiled SQL with $N parameters
console.log(dump.params);    // Bound parameter values
console.log(dump.plan);      // PlanReport: decisions, warnings, strategies
```

### Type Inference Flow

Types flow automatically from your schema definition through the entire query pipeline:

```
schema({ users: { id: 'uuid', name: 'string' } })
  │
  ▼
Schema<T>  →  createOrm({ schema })  →  OrmInstance<DB>
                                            │
                                            ▼
                              orm.select('users')  →  QueryBuilder<{ id: string; name: string }>
                                                          │
                                                          ▼
                                                .all()  →  Promise<Array<{ id: string; name: string }>>
```

Column types map to TypeScript types:

| Schema Type | TypeScript Type | Notes |
|-------------|----------------|-------|
| `'string'`, `'text'`, `'uuid'` | `string` | |
| `'integer'`, `'decimal'` | `number` | |
| `'bigint'` | `bigint` | |
| `'boolean'` | `boolean` | |
| `'date'`, `'timestamp'` | `Date` | |
| `'time'` | `string` | |
| `'json'`, `'jsonb'` | `unknown` | |
| `{ type: T, nullable: true }` | `T \| null` | |

### Without a Database (Compile-Only)

For testing, CLI tooling, or SQL preview — no `pg.Pool` needed:

```typescript
import { createOrm, eq } from '@dbsp/core';
import { createPgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const adapter = createPgsqlCompileOnlyAdapter();
const orm = createOrm({ schema: db, adapter }); // db from schema() above

const dump = orm.select('users').where(eq('active', true)).dump();
console.log(dump.sql);    // SELECT "t0".* FROM "users" AS "t0" WHERE "t0"."active" = $1
console.log(dump.params); // [true]
```

---

## 1. Schema Definition

### `schema()` — Define Your Database

```typescript
import { schema, ref } from '@dbsp/core';

const db = schema({
  users: {
    id: { type: 'uuid', primaryKey: true },
    name: 'string',
    email: { type: 'string', unique: true },
    bio: { type: 'text', nullable: true },
    active: { type: 'boolean', default: 'true' },
    createdAt: { type: 'timestamp', default: 'now()' },
  },
  posts: {
    id: { type: 'integer', primaryKey: true, autoIncrement: true },
    title: 'string',
    content: { type: 'text', nullable: true },
    published: { type: 'boolean', default: 'false', index: true },
    authorId: ref('users', { onDelete: 'CASCADE', inverse: 'posts' }),
  },
});
```

### Column Types

| Type | PostgreSQL | TypeScript |
|------|-----------|------------|
| `'string'` | `VARCHAR` | `string` |
| `'text'` | `TEXT` | `string` |
| `'integer'` | `INTEGER` | `number` |
| `'bigint'` | `BIGINT` | `bigint` |
| `'decimal'` | `DECIMAL` | `number` |
| `'boolean'` | `BOOLEAN` | `boolean` |
| `'date'` | `DATE` | `Date` |
| `'time'` | `TIME` | `string` |
| `'timestamp'` | `TIMESTAMP WITH TIME ZONE` | `Date` |
| `'json'` | `JSON` | `unknown` |
| `'jsonb'` | `JSONB` | `unknown` |
| `'uuid'` | `UUID` | `string` |
| `'daterange'` | `DATERANGE` | `[Date, Date]` |
| `'tstzrange'` | `TSTZRANGE` | `[Date, Date]` |
| `'int4range'` | `INT4RANGE` | `[number, number]` |

### Column Options

Shorthand (type only) or object with options:

```typescript
// doctest: skip — illustrative data/type literal fragment (not executable code)
{
  name: 'string',                                        // shorthand
  email: { type: 'string', unique: true },               // with options
  bio: { type: 'text', nullable: true },                 // nullable
  id: { type: 'integer', primaryKey: true, autoIncrement: true },
  status: { type: 'string', default: 'active', index: true },
}
```

| Option | Type | Description |
|--------|------|-------------|
| `type` | `ColumnType` | Column data type (required in object form) |
| `primaryKey` | `boolean` | Mark as primary key |
| `autoIncrement` | `boolean` | Auto-increment (serial) |
| `nullable` | `boolean` | Allow NULL values |
| `unique` | `boolean` | Unique constraint |
| `index` | `boolean` | Create index |
| `default` | `string` | Default value expression |

### Relations with `ref()`

```typescript
// doctest: skip — API signature reference (TypeScript function signature, not executable code)
ref(targetTable: string, options?: RefOptions)
```

Relations are auto-inferred from `ref()` calls. The planner detects:
- **belongsTo** (N:1) — the table with the FK
- **hasMany** (1:N) — the target table
- **M:N** — via junction table with two FKs

```typescript
const db = schema({
  users: { id: 'uuid', name: 'string', email: 'string', active: 'boolean', createdAt: 'timestamp' },
  categories: { id: 'uuid', name: 'string' },
  posts: {
    authorId: ref('users', { as: 'author', inverse: 'authoredPosts' }),  // basic FK
    editorId: ref('users', { as: 'editor', inverse: 'editedPosts', nullable: true }),  // optional relation
    categoryId: ref('categories', {
      onDelete: 'CASCADE',
      as: 'category',          // local relation name
      inverse: 'posts',        // reverse relation name on target
    }),
  },
});
```

#### `ref()` Options

| Option | Type | Description |
|--------|------|-------------|
| `nullable` | `boolean` | Optional relation (LEFT JOIN) |
| `unique` | `boolean` | Makes it 1:1 instead of 1:N |
| `onDelete` | `'CASCADE' \| 'SET NULL' \| 'RESTRICT' \| 'NO ACTION'` | Delete action |
| `onUpdate` | `'CASCADE' \| 'SET NULL' \| 'RESTRICT' \| 'NO ACTION'` | Update action |
| `as` | `string` | Local relation name override |
| `inverse` | `string` | Reverse relation name on target table |
| `roles` | `SelfRefRoles` | Role names for self-referential relations |
| `columns` | `string[]` | Source columns (composite FK) |
| `references` | `string[]` | Target columns (defaults to PK) |

### Self-Referential Relations

For trees/hierarchies, use `roles` to name the traversal paths:

```typescript
const db = schema({
  employees: {
    id: { type: 'integer', primaryKey: true, autoIncrement: true },
    name: 'string',
    managerId: ref('employees', {
      nullable: true,
      roles: {
        parent: 'manager',            // direct parent
        children: 'directReports',    // direct children
        ancestors: 'managementChain', // recursive upward (CTE)
        descendants: 'allReports',    // recursive downward (CTE)
      },
    }),
  },
});
```

### Many-to-Many (Junction Tables)

```typescript
const db = schema({
  posts: { id: { type: 'integer', primaryKey: true, autoIncrement: true }, title: 'string' },
  tags: { id: { type: 'integer', primaryKey: true, autoIncrement: true }, name: 'string' },
  postTags: {
    postId: ref('posts', { onDelete: 'CASCADE' }),
    tagId: ref('tags', { onDelete: 'CASCADE' }),
  },
});
```

### Schema Options (`dbCasing`)

Control how column names map between JS and database:

```typescript
const db = schema({
  users: {
    firstName: 'string',  // JS: camelCase
    lastName: 'string',
  },
}, undefined, { dbCasing: 'snake_case' });
// DB columns: first_name, last_name
// JS properties: firstName, lastName
```

| Value | DB Columns | JS Properties | Transform |
|-------|-----------|---------------|-----------|
| `'snake_case'` | `first_name` | `firstName` | Auto camelCase <-> snake_case |
| `'camelCase'` | `firstName` | `firstName` | No transform |
| `'preserve'` | as-is | as-is | No transform |

### Schema Constraints

Add composite indexes and foreign keys via the constraints parameter:

```typescript
const db = schema(
  {
    orders: { id: 'uuid', total: 'integer' },
    products: { id: 'uuid', name: 'string' },
    orderItems: { orderId: ref('orders'), productId: ref('products'), quantity: 'integer' },
  },
  { orderItems: { indexes: [{ columns: ['orderId', 'productId'], unique: true }] } }
);
```

---

## 2. Creating the ORM

### `createOrm()` — ORM Instance

```typescript
import { createOrm } from '@dbsp/core';
import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';
import { Pool } from 'pg';

const orm = createOrm({
  schema: db,
  adapter: createPgsqlAdapter(new Pool({ connectionString: process.env.DATABASE_URL })),
});
```

#### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `schema` | `Schema` | - | From `schema()` (preferred) |
| `model` | `ModelIR` | - | Direct ModelIR (alternative to schema) |
| `adapter` | `Adapter` | - | Database adapter (optional for compile-only) |
| `strictMode` | `boolean` | `false` | Throw on ambiguous relations |
| `maxDepth` | `number` | `10` | Max recursive depth |
| `maxTableHops` | `number` | `5` | Max relation hops |

### Compile-Only Mode (No Database)

For tooling, testing, or SQL preview without a database connection:

```typescript
import { createPgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const orm = createOrm({
  schema: db,
  adapter: createPgsqlCompileOnlyAdapter(),
});

// dump() works — returns SQL + params
const { sql, params } = orm.select('users').where(eq('active', true)).dump();

// execute() throws ExecutionError
```

### Schema Scoping (Multi-Tenant)

```typescript
const tenantOrm = orm.withSchema('tenant_123');
const users = await tenantOrm.select('users').dump();
// SQL: SELECT * FROM "tenant_123"."users"
```

### Transactions

```typescript
// doctest: skip — exec-only operation; requires a real PostgreSQL connection
const result = await orm.transaction(async (tx) => {
  await tx.insert('orders').values({ customerId: 1, total: 99 }).dump();
  await tx.insert('orderItems').values({ orderId: 1, productId: 5 }).dump();
  return tx.select('orders').where(eq('customerId', 1)).dump();
});
// Auto-commit on success, auto-rollback on error
```

The callback receives a transaction-scoped ORM instance (`tx`) with the full ORM API. The transaction result is the return value of your callback:

```typescript
// doctest: skip — exec-only operation; requires a real PostgreSQL connection
// Typed return value
const order = await orm.transaction(async (tx) => {
  const [created] = await tx.insert('orders')
    .values({ customerId: 1, total: 99 })
    .returning(['id', 'total'])
    .dump();
  return created; // { id: 42, total: 99 }
});
console.log(order.id); // 42

// Schema-scoped transactions (multi-tenant)
orm.withSchema('tenant_42').transaction(async (tx) => {
  // tx is scoped to 'tenant_42' schema
  await tx.insert('events').values({ type: 'signup' }).dump();
});
```

**Nested transactions** reuse the outer transaction context — no savepoints, no additional BEGIN/COMMIT:

```typescript
// doctest: skip — exec-only operation; requires a real PostgreSQL connection
orm.transaction(async (outer) => {
  await outer.insert('users').values({ name: 'Alice' }).dump();

  await outer.transaction(async (inner) => {
    // inner reuses the same connection and transaction
    await inner.insert('logs').values({ action: 'user_created' }).dump();
  });
});
```

| Behavior | Detail |
|----------|--------|
| Success | `COMMIT` after callback returns |
| Error thrown | `ROLLBACK`, error re-thrown |
| Nested call | Reuses parent transaction (no savepoints) |
| Connection | Dedicated client, released on completion |

---

## 3. Querying (QueryBuilder)

All query builder methods return a new immutable instance. Safe to branch and reuse.

### `select()` — Start a Query

```typescript
const users = await orm.select('users').dump();
```

### `columns()` — Select Specific Columns

```typescript
const names = await orm.select('users').columns(['id', 'name']).dump();
// SQL: SELECT "id", "name" FROM "users"
```

### `distinct()` — Remove Duplicates

```typescript
// doctest: skip — exec-only operation; requires a real PostgreSQL connection
const departments = await orm.select('users').columns(['department']).distinct().all();
// SQL: SELECT DISTINCT "department" FROM "users"
```

### `where()` — Filter Rows

Uses filter helpers (see full list below):

```typescript
import { eq, gt, and, or, not, like, inArray, isNull, isNotNull } from '@dbsp/core';

// Simple equality
orm.select('users').where(eq('active', true))

// Multiple conditions
orm.select('users').where(and(
  eq('active', true),
  gt('age', 18),
  like('email', '%@example.com')
))

// OR conditions
orm.select('users').where(or(
  eq('role', 'admin'),
  eq('role', 'superadmin')
))

// NOT
orm.select('users').where(not(eq('deleted', true)))

// IN array
orm.select('users').where(inArray('status', ['active', 'pending']))

// NULL checks
orm.select('users').where(isNull('deletedAt'))
orm.select('users').where(isNotNull('email'))
```

### Filter Helpers — Complete List

| Helper | SQL | Example |
|--------|-----|---------|
| `eq(field, value)` | `=` | `eq('status', 'active')` |
| `neq(field, value)` | `!=` | `neq('role', 'guest')` |
| `gt(field, value)` | `>` | `gt('age', 18)` |
| `gte(field, value)` | `>=` | `gte('price', 100)` |
| `lt(field, value)` | `<` | `lt('stock', 10)` |
| `lte(field, value)` | `<=` | `lte('rating', 5)` |
| `like(field, pattern)` | `LIKE` | `like('name', 'A%')` |
| `inArray(field, values)` | `IN` | `inArray('id', [1, 2, 3])` |
| `isNull(field)` | `IS NULL` | `isNull('deletedAt')` |
| `isNotNull(field)` | `IS NOT NULL` | `isNotNull('email')` |
| `isDistinctFrom(field, value)` | `IS DISTINCT FROM` | `isDistinctFrom('status', 'active')` |
| `and(...conditions)` | `AND` | `and(eq('a', 1), gt('b', 2))` |
| `or(...conditions)` | `OR` | `or(eq('x', 1), eq('x', 2))` |
| `not(condition)` | `NOT` | `not(eq('deleted', true))` |

### `isDistinctFrom()` — Null-safe Inequality

Unlike `neq()`, returns `true` when one side is NULL and the other is not. Standard SQL (SQL:2003).

```typescript
// doctest: skip — block uses an isDistinctFrom WHERE handler not registered in the doctest adapter (compile-time, not exec-time)
import { isDistinctFrom } from '@dbsp/core';

// Find rows where status changed (NULL-safe)
const changed = await orm.select('users')
  .where(isDistinctFrom('status', 'active'))
  .dump();
// SQL: WHERE status IS DISTINCT FROM $1
```

### Relation Filters

Filter by related records without loading them:

```typescript
import { Pool } from 'pg';
import { schema, ref, createOrm, eq, exists, notExists, some, every, none } from '@dbsp/core';
import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';

const __db = schema({
  users: { id: 'integer', name: 'string' },
  posts: { id: 'integer', userId: ref('users'), published: 'boolean' },
} as const);
const __pool = new Pool({ connectionString: process.env.DATABASE_URL });
const __orm = createOrm({ schema: __db, adapter: createPgsqlAdapter(__pool) });

// Users who have at least one post
__orm.select('users').where(exists('posts'))

// Users who have no posts
__orm.select('users').where(notExists('posts'))

// Users who have at least one published post — some() requires a RelationRef
__orm.select('users').where(some(__db.tables.users.posts, (p) => eq(p.published, true)))

// Users where ALL posts are published
__orm.select('users').where(every(__db.tables.users.posts, (p) => eq(p.published, true)))

// Users where NO post is a draft (false = not draft)
__orm.select('users').where(none(__db.tables.users.posts, (p) => eq(p.published, false)))
```

### Range Operators (PostgreSQL)

```typescript
import { schema, createOrm, rangeOverlaps, rangeContains, rangeContainedBy } from '@dbsp/core';
import { createPgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const __rangeDb = schema({
  bookings: { id: 'integer', period: 'daterange' },
  events: { id: 'integer', dateRange: 'daterange' },
} as const);
const __rangeOrm = createOrm({ schema: __rangeDb, adapter: createPgsqlCompileOnlyAdapter() });

// Bookings that overlap a date range
__rangeOrm.select('bookings').where(rangeOverlaps('period', ['2024-01-01', '2024-01-31'])).dump();

// Events that contain a specific date
__rangeOrm.select('events').where(rangeContains('dateRange', ['2024-06-15', '2024-06-15'])).dump();

// Events within a year
__rangeOrm.select('events').where(rangeContainedBy('dateRange', ['2024-01-01', '2024-12-31'])).dump();
```

### `orderBy()` — Sort Results

```typescript
// Single field (ascending by default)
orm.select('users').orderBy('name')

// With direction
orm.select('users').orderBy('createdAt', 'desc')

// Multiple fields (object syntax)
orm.select('users').orderBy({ createdAt: 'desc', name: 'asc' })

// Advanced: nulls positioning
orm.select('users').orderBy([
  { column: 'createdAt', direction: 'desc', nulls: 'last' }
])
```

### `limit()` + `offset()` — Pagination Primitives

```typescript
orm.select('posts').orderBy('createdAt', 'desc').limit(10).offset(20)
```

### Aggregates

```typescript
// doctest: skip — illustrative fragment (distinct() helper not in doctest preamble; uses orders/products tables not in default preamble)
import { distinct } from '@dbsp/core';

// COUNT
orm.select('users').count()
orm.select('orders').count('id', 'totalOrders')
orm.select('orders').count(distinct('customerId'), 'uniqueCustomers')

// SUM, AVG, MIN, MAX
orm.select('orders').sum('amount', 'totalRevenue')
orm.select('orders').avg('amount', 'averageOrder')
orm.select('products').min('price', 'cheapest')
orm.select('products').max('price', 'mostExpensive')
```

### `groupBy()` + `having()`

```typescript
orm.select('posts')
  .groupBy(['published'])
  .count('id', 'postCount')
  .having(gt('postCount', 10))
  .dump()
// SQL: SELECT "published", COUNT("id") AS "postCount" FROM "posts"
//      GROUP BY "published" HAVING "postCount" > $1
```

### Window Functions

```typescript
// doctest: skip — illustrative fragment (window function helpers rowNumber/rank/denseRank/wSum/wAvg/wCount/wMin/wMax/lag/lead not in doctest preamble)
import { rowNumber, rank, denseRank, wSum, wAvg, wCount, wMin, wMax, lag, lead } from '@dbsp/core';

// Row numbering
orm.select('posts').columns([
  'title', 'authorId',
  rowNumber().orderBy('createdAt', 'desc').as('rn')
])

// Ranking within partitions
orm.select('products').columns([
  'name', 'category', 'price',
  rank().partitionBy('category').orderBy('price').as('priceRank')
])

// Dense rank (no gaps)
orm.select('employees').columns([
  'name', 'department', 'salary',
  denseRank().partitionBy('department').orderBy('salary', 'desc').as('salaryRank')
])

// Running total
orm.select('orders').columns([
  'date', 'amount',
  wSum('amount').orderBy('date').as('runningTotal')
])

// Previous/next row values
orm.select('prices').columns([
  'date', 'price',
  lag('price').orderBy('date').as('prevPrice'),
  lead('price').orderBy('date').as('nextPrice')
])

// Aggregate windows
orm.select('sales').columns([
  'customerId', 'amount',
  wAvg('amount').partitionBy('customerId').as('avgPerCustomer'),
  wCount('id').partitionBy('customerId').as('ordersPerCustomer'),
  wMin('amount').partitionBy('customerId').as('minOrder'),
  wMax('amount').partitionBy('customerId').as('maxOrder')
])
```

### Expressions

```typescript
// doctest: skip — illustrative fragment (coalesce/raw/col/relationColumn helpers not in doctest preamble)
import { coalesce, raw, col, relationColumn } from '@dbsp/core';

// COALESCE — first non-null value
orm.select('users').columns([
  'id',
  coalesce(['nickname', 'name'], 'displayName')
])
// SQL: SELECT "id", COALESCE("nickname", "name") AS "displayName"

// raw() — SQL escape hatch
orm.select('users').columns([
  'id',
  raw('EXTRACT(YEAR FROM "created_at")', 'joinYear')
])

// col() — aliased column
orm.select('users').columns([col('firstName', 'first')])

// relationColumn() — column from joined relation
orm.select('posts').columns([
  'title',
  relationColumn('author', 'name', 'authorName')
])
```

### Subqueries

```typescript
// doctest: skip — exec-only operation; requires a real PostgreSQL connection (products table not in default preamble schema)
import { subquery, outerRef } from '@dbsp/core';

// Correlated subquery: products with above-average price in their category
orm.select('products')
  .where(gt('price',
    subquery('products')
      .select('avgPrice')
      .where(eq('categoryId', outerRef('categoryId')))
      .avg('price')
  ))
  .all()
```

### `inSubquery()` — WHERE IN (Subquery)

Filter rows where a column value exists in the result of a subquery.

```typescript
import { inSubquery, subquery, eq } from '@dbsp/core';

// Users who have published posts
const authors = await orm.select('users')
  .where(inSubquery('id', subquery('posts').select('authorId').where(eq('published', true))))
  .dump();
// SQL: WHERE id = ANY(SELECT author_id FROM posts WHERE published = $1)
```

### Scalar Subquery in SELECT — `.asExpr()`

Use a subquery as a computed column in SELECT.

```typescript
// doctest: skip — exec-only operation; scalar subquery .count().where() chain and .asExpr() not yet available on SubqueryBuilder
import { subquery, eq } from '@dbsp/core';

// Count posts per user as a computed column
const users = await orm.select('users')
  .columns([
    'id',
    'name',
    subquery('posts').count().where(eq('authorId', outerRef('id'))).asExpr('post_count')
  ])
  .all();
// SQL: SELECT id, name, (SELECT count(*) FROM posts WHERE author_id = users.id) AS post_count FROM users
```

### Set Operations

Combine query results with UNION, INTERSECT, or EXCEPT. All variants support the `All` suffix (e.g., `.unionAll()`) to preserve duplicates.

```typescript
const q1 = orm.select('users').where(eq('role', 'admin'));
const q2 = orm.select('users').where(eq('role', 'moderator'));
const q3 = orm.select('users').where(eq('active', true));

// UNION (deduplicated)
const staff = q1.union(q2).dump();

// UNION ALL (with duplicates)
const allStaff = q1.unionAll(q2).dump();

// INTERSECT
const both = q1.intersect(q2).dump();

// EXCEPT
const adminsOnly = q1.except(q2).dump();

// Chaining
const result = q1.union(q2).except(q3).dump();

// Dump for SQL preview
const dump = q1.union(q2).dump();
console.log(dump.sql); // (SELECT ...) UNION (SELECT ...)
```

Returns a `SetOperationBuilder` with `.all()`, `.first()`, and `.dump()` methods.

---

## 4. Includes (Eager Loading)

### Simple Include

```typescript
const usersWithPosts = await orm.select('users').include('posts').dump();
// [{ id: 1, name: 'Alice', posts: [{ id: 1, title: '...' }, ...] }]
```

### Dot Notation (Deep Nesting)

```typescript
orm.select('users').include('posts.comments')
orm.select('users').include('posts.comments.author')
```

### Multiple Includes

```typescript
orm.select('users')
  .include('posts')
  .include('profile')
  .include('posts.comments')
  .dump()
```

### Include Options

```typescript
orm.select('users').include('posts', {
  where: eq('published', true),                          // filter related records
  select: { type: 'fields', fields: ['title', 'slug'] }, // select specific columns
  via: 'authoredPosts',                                  // disambiguate relation
})
```

| Option | Type | Description |
|--------|------|-------------|
| `where` | `WhereIntent` | Filter conditions on related records |
| `select` | `SelectSpec` | Select specific columns |
| `via` | `string` | Disambiguate multiple relations to same table |
| `recursive` | `boolean` | Enable recursive CTE traversal |
| `direction` | `'ancestors' \| 'descendants'` | Traversal direction (required when recursive) |
| `flat` | `boolean` | Flat array output with depth field |
| `maxDepth` | `number` | Maximum traversal depth (default: 100) |

### Recursive Includes (Hierarchies)

```typescript
// Ancestors (up the tree)
orm.select('categories')
  .where(eq('id', 5))
  .include('parent', { recursive: true, direction: 'ancestors' })
  .dump()

// Descendants (down the tree) — flat output
orm.select('categories')
  .where(eq('id', 1))
  .include('children', {
    recursive: true,
    direction: 'descendants',
    flat: true,
    maxDepth: 10
  })
  .dump()
```

---

## 5. Mutations

### Insert

```typescript
// Basic insert
orm.insert('users')
  .values({ name: 'Alice', email: 'alice@example.com' })
  .dump();

// Bulk insert
orm.insert('users')
  .values([
    { name: 'Alice', email: 'alice@example.com' },
    { name: 'Bob', email: 'bob@example.com' },
  ])
  .dump();

// With RETURNING
const { sql: newUserSql } = orm.insert('users')
  .values({ name: 'Alice', email: 'alice@example.com' })
  .returning(['id', 'name', 'createdAt'])
  .dump();
```

### Update

```typescript
// Update with WHERE (required)
orm.update('users')
  .set({ name: 'Alice Smith' })
  .where(eq('id', 1))
  .dump();

// Update all rows (explicit intent)
orm.updateAll('users')
  .set({ active: false })
  .dump();

// With RETURNING
const updated = await orm.update('users')
  .set({ active: true })
  .where(eq('email', 'alice@example.com'))
  .returning(['id', 'name', 'active'])
  .dump();
```

### Delete

```typescript
// Delete with WHERE (required)
orm.delete('users')
  .where(eq('id', 1))
  .dump();

// Delete all rows (explicit intent)
orm.deleteAll('users').dump();

// With cascade
orm.delete('users')
  .where(eq('id', 1))
  .cascade()           // cascade to all relations
  .dump();

// With RETURNING
const deleted = await orm.delete('posts')
  .where(eq('published', false))
  .returning(['id', 'title'])
  .dump();
```

### Upsert (Insert or Update on Conflict)

```typescript
// On conflict by columns — auto-update non-conflict fields
orm.upsert('users')
  .values({ name: 'Alice', email: 'alice@example.com', active: true })
  .onConflict(['email'])
  .doUpdate()
  .dump();

// On conflict — update specific fields
orm.upsert('users')
  .values({ name: 'Alice', email: 'alice@example.com', active: true })
  .onConflict(['email'])
  .doUpdate({ name: 'Alice Updated', active: true })
  .dump();

// On conflict by constraint name
orm.upsert('users')
  .values({ name: 'Alice', email: 'alice@example.com' })
  .onConflictConstraint('users_email_unique')
  .doNothing()
  .dump();

// With RETURNING
const result = await orm.upsert('users')
  .values({ name: 'Alice', email: 'alice@example.com' })
  .onConflict(['email'])
  .doUpdate()
  .returning(['id', 'name'])
  .dump();
```

### Mutation Observability

All mutation builders support `dump()`:

```typescript
const { sql, params } = orm.insert('users')
  .values({ name: 'Alice', email: 'alice@example.com' })
  .dump();

console.log(sql);    // INSERT INTO "users" ("name", "email") VALUES ($1, $2)
console.log(params); // ['Alice', 'alice@example.com']
```

---

## 6. Execution

### Result Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `all()` | `Promise<T[]>` | All matching rows |
| `execute()` | `Promise<T[]>` | Alias for `all()` |
| `first()` | `Promise<T \| undefined>` | First row or `undefined` |
| `firstOrThrow()` | `Promise<T>` | First row or throws `NotFoundError` |
| `byId(value)` | `Promise<T \| undefined>` | Find by primary key |
| `byIdOrThrow(value)` | `Promise<T>` | Find by PK or throws `NotFoundError` |
| `byIds(values)` | `Promise<T[]>` | Find multiple by PKs |
| `exists()` | `Promise<boolean>` | Check if any rows match (optimized) |

```typescript
// Standard execution
const dump1 = orm.select('users').dump();
const dump2 = orm.select('users').where(eq('id', 1)).dump();

// Primary key shortcuts — these require real DB connection
// const user = await orm.select('users').byId(1);
// const user = await orm.select('users').byIdOrThrow(1);
// const users = await orm.select('users').byIds([1, 2, 3]);
```

### Existence Check

The `exists()` method provides an optimized way to check if any rows match a query.
Unlike `first() !== undefined`, it generates efficient `SELECT EXISTS(...)` SQL:

```typescript
// doctest: skip — exec-only operation; requires a real PostgreSQL connection
// Check if any active users exist
const hasActiveUsers = await orm.select('users').where(eq('active', true)).exists();

// More efficient than:
// const hasActiveUsers = (await orm.select('users').where(eq('active', true)).dump()) !== undefined;
```

**Generated SQL:**
```sql
SELECT EXISTS(SELECT 1 FROM users WHERE users.active = $1) AS "exists"
```

**Key behaviors:**
- Returns `true` if at least one row matches, `false` otherwise
- Strips `orderBy` (irrelevant for existence)
- Strips `include` (related data not needed)
- Preserves `where`, `groupBy`, `having`, `offset`
- Sets internal `limit: 1` for optimization

**Debugging:** Use `existsDump()` to inspect the generated intent without executing:

```typescript
const dump = orm.select('users').where(eq('active', true)).existsDump();
console.log(dump.sql);     // SELECT EXISTS(...) AS "exists"
console.log(dump.params);  // [true]
console.log(dump.plan);    // PlanReport with existsWrap: true
```

### Streaming

```typescript
// doctest: skip — exec-only operation; requires a real PostgreSQL connection
const stream = orm.select('users').stream();

for await (const user of stream) {
  console.log(user.name);
  if (shouldStop) break;  // early break releases connection
}
```

#### Stream Options

```typescript
// doctest: skip — exec-only operation; requires a real PostgreSQL connection
const stream = orm.select('users').stream({
  chunkSize: 100,  // rows fetched per cursor batch (default: framework-defined)

  onStart(dump) {
    // Called once on first next() — lazy initialization
    console.log('SQL:', dump.sql);
    console.log('Params:', dump.params);
    console.log('Plan:', dump.plan);
  },
});

for await (const user of stream) {
  process.stdout.write(`${user.name}\n`);
}
```

| Option | Type | Description |
|--------|------|-------------|
| `chunkSize` | `number` | Rows per cursor fetch batch |
| `onStart` | `(dump: Dump) => void` | Callback invoked once before first row; receives full query dump (SQL, params, plan) |

### Pagination

#### Offset-Based

```typescript
// doctest: skip — exec-only operation; requires a real PostgreSQL connection
const page = await orm.select('users')
  .orderBy('name')
  .paginate({ page: 2, perPage: 25 });

// page.data          — User[]
// page.pagination.page        — 2
// page.pagination.perPage     — 25
// page.pagination.total       — 150
// page.pagination.totalPages  — 6
// page.pagination.hasNextPage — true
// page.pagination.hasPrevPage — true
```

#### Cursor-Based

```typescript
// doctest: skip — exec-only operation; requires a real PostgreSQL connection
const page = await orm.select('users')
  .orderBy('createdAt', 'desc')
  .cursorPaginate({ first: 25 });

// page.data       — User[]
// page.nextCursor — 'eyJ...' (opaque cursor string)
// page.hasNextPage — true

// Next page:
const next = await orm.select('users')
  .orderBy('createdAt', 'desc')
  .cursorPaginate({ first: 25, after: page.nextCursor });
```

### Observability

```typescript
// Execution plan (no database call)
const plan = orm.select('users').include('posts').plan();
console.log(plan.decisions);  // [{ type: 'include-strategy', choice: 'json_agg', ... }]
console.log(plan.warnings);   // [{ type: 'performance', message: '...' }]

// Full dump: plan + SQL + params
const dump = orm.select('users').where(eq('active', true)).dump();
console.log(dump.sql);      // SELECT * FROM "users" WHERE "active" = $1
console.log(dump.params);   // [true]
console.log(dump.plan);     // PlanReport
console.log(dump.meta);     // { schema?: string, queryName?: string }
```

---

## 7. Error Handling

All errors have a `code` property for programmatic handling and a `name` property for type checking.

| Error | Code | When |
|-------|------|------|
| `ExecutionError` | `DBSP_E001` | Executing without adapter configured |
| `NotFoundError` | `DBSP_E002` | `firstOrThrow()` / `byIdOrThrow()` finds nothing |
| `AmbiguousRelationError` | `DBSP_E003` | Strict mode + ambiguous relation |
| `RelationNotFoundError` | `DBSP_E004` | Requested relation doesn't exist |
| `InvalidOperationError` | `DBSP_E005` | Malformed operation |
| `UnsafeOperationError` | `DBSP_E006` | `update()`/`delete()` without WHERE |
| `TableNotFoundError` | `DBSP_E007` | Table not in schema |
| `ColumnNotFoundError` | `DBSP_E008` | Column not on table |

```typescript
// doctest: skip — illustrative fragment (Errors namespace not in doctest preamble; block also uses .firstOrThrow() which requires a real PostgreSQL connection)
import { Errors } from '@dbsp/core';

try {
  await orm.select('users').firstOrThrow();
} catch (error) {
  if (Errors.isNotFound(error)) {
    console.log(`Table: ${error.table}`);  // 'users'
  }
  if (Errors.isTableNotFound(error)) {
    console.log(`Available: ${error.available}`);
    console.log(`Did you mean: ${error.suggestion}`);
  }
}
```

### Strict Mode

Strict mode throws `AmbiguousRelationError` when a relation is ambiguous (e.g., two FKs to the same table):

```typescript
const orm = createOrm({ schema: db, adapter, strictMode: true });

// Throws AmbiguousRelationError — use withRelationHint() to disambiguate
orm.select('posts').include('users')

// Fix: specify which relation
orm.select('posts').include('users', { via: 'author' })
// Or per-query strict mode:
orm.select('posts').withStrictMode(false).include('users')
```

---

## 8. Advanced

### NQL Template Literals

Use the pipe-based Natural Query Language directly from TypeScript:

```typescript
const users = await orm.nql<User[]>`users | where active = true | limit 10`.dump();
const dump = orm.nql`posts | where published = true | select title, author.*`.dump();
```

See the [NQL Reference](../nql/) for full syntax.

### Hierarchy Shortcuts

```typescript
// doctest: skip — exec-only operation; listAncestors/listDescendants require a real PostgreSQL connection and an employees table not in default preamble
// List all ancestors of node (flat array)
const ancestors = await orm.listAncestors('employees', 42, {
  parentId: 'managerId',
  nodeId: 'id',
  maxDepth: 10,
});

// List all descendants of node (flat array)
const descendants = await orm.listDescendants('employees', 1, {
  parentId: 'managerId',
  nodeId: 'id',
});
```

### Query Configuration

```typescript
// Override strict mode per query
orm.select('posts').withStrictMode(true)

// Disambiguate relation
orm.select('posts').withRelationHint('users', 'author')

// Override plan options
orm.select('users').withPlanOptions({ preferredStrategy: 'json_agg' })
```

### Raw SQL (Escape Hatch)

```typescript
// doctest: skip — exec-only operation; requires a real PostgreSQL connection
const results = await orm.raw<{ count: number }>(
  'SELECT COUNT(*) as count FROM "users" WHERE "active" = $1',
  [true]
);
```

> **Warning:** `raw()` bypasses the planner and type safety. Use only when the ORM API is insufficient.

### PostgreSQL Built-in Helpers

Available from `@dbsp/adapter-pgsql`:

```typescript
import { generateSeries, nextval } from '@dbsp/adapter-pgsql';

// Generate a series of values
generateSeries(1, 100)       // generate_series(1, 100)
generateSeries(0, 50, 5)     // generate_series(0, 50, 5) — with step

// Get next sequence value
nextval('order_id_seq')      // nextval('order_id_seq')
```

### Automatic Parameter Type Casting

When the adapter has access to ModelIR column types (via `originalDbType` from introspection), it automatically adds explicit type casts to query parameters:

```sql
-- Without casting (ambiguous for nullable columns)
WHERE enclosing_symbol_id = $1

-- With casting (explicit, no type inference errors)
WHERE enclosing_symbol_id = CAST($1 AS integer)
```

This is transparent — no code changes needed. The adapter resolves types from the schema and applies casts where needed.

## 9. Naming Conventions

The adapter automatically derives foreign key column names from table names using a `singularize(tableName) + "_" + pkColumn` convention. For example, the `posts` table with PK `id` produces FK column `post_id`.

Both the primary key convention and the FK derivation function are configurable.

### Adapter Options

```typescript
import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';

const adapter = createPgsqlAdapter(pool, {
  // Default PK column name (default: 'id')
  defaultPkColumnName: 'uuid',

  // Custom FK derivation (default: singularize(table) + '_' + pk)
  deriveFkColumnName: (tableName, pkColumnName) =>
    `fk_${singularize(tableName)}_${pkColumnName}`,
});
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `defaultPkColumnName` | `string` | `'id'` | Convention fallback when schema metadata doesn't provide an explicit PK column |
| `deriveFkColumnName` | `(table: string, pk: string) => string` | `singularize(table)_pk` | Derives FK column names from the referenced table and its PK |

### NamingPlugin — Column Name Transformation

When your database uses `snake_case` columns but your TypeScript models use `camelCase`, the `NamingPlugin` handles bidirectional transformation automatically:

```typescript
import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';

// Built-in: CamelCaseNamingPlugin (camelCase ↔ snake_case)
const adapter = createPgsqlAdapter(pool, {
  dbCasing: 'snake_case',  // enables CamelCaseNamingPlugin
});

// Query results: snake_case DB columns → camelCase JS properties
// Query compilation: camelCase JS properties → snake_case SQL columns
```

Two built-in plugins:

| Plugin | `dbCasing` | Effect |
|--------|-----------|--------|
| `IdentityNamingPlugin` | `'preserve'` (default) | No transformation — columns pass through unchanged |
| `CamelCaseNamingPlugin` | `'snake_case'` | `createdAt` ↔ `created_at`, `userProfileImage` ↔ `user_profile_image` |

The `CamelCaseNamingPlugin` handles edge cases: acronyms (`parseJSON` → `parse_json`), numbers (`field1Name` → `field1_name`), leading underscores (`_privateField` → `_private_field`).

### `singularize()` and `pluralize()` — Importable Helpers

These are optional utility functions, exported from `@dbsp/core`, useful for building custom FK derivation or other naming logic:

```typescript
// doctest: skip — illustrative fragment (singularize/pluralize/IRREGULAR_PLURALS not in doctest preamble)
import { singularize, pluralize, IRREGULAR_PLURALS } from '@dbsp/core';

singularize('posts');       // → 'post'
singularize('categories');  // → 'category'
singularize('people');      // → 'person' (built-in irregular)

pluralize('post');          // → 'posts'
pluralize('category');      // → 'categories'
pluralize('person');        // → 'people' (built-in irregular)
```

#### Custom Overrides

Pass a `Record<string, string>` to `singularize()` for domain-specific plurals not covered by the built-in rules:

```typescript
// doctest: skip — illustrative fragment (singularize/pluralize/IRREGULAR_PLURALS not in doctest preamble)
const domainOverrides = {
  matrices: 'matrix',
  alumni: 'alumnus',
  indices: 'index',
};

singularize('matrices', domainOverrides); // → 'matrix'
singularize('users', domainOverrides);    // → 'user' (falls through to built-in rules)
```

Overrides take priority over built-in irregular plurals:

```typescript
// doctest: skip — illustrative fragment (singularize/pluralize/IRREGULAR_PLURALS not in doctest preamble)
singularize('people', { people: 'individual' }); // → 'individual' (overrides built-in 'person')
```

#### `IRREGULAR_PLURALS` — Built-in Map

The `IRREGULAR_PLURALS` constant is exported for inspection or extension:

```typescript
import { IRREGULAR_PLURALS } from '@dbsp/core';

// Built-in: people→person, children→child, men→man, women→woman,
//           teeth→tooth, feet→foot, geese→goose, mice→mouse,
//           data→datum, media→medium, criteria→criterion, phenomena→phenomenon
```

#### Putting It Together

A fully custom FK naming strategy using a Map of overrides:

```typescript
import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';
import { singularize } from '@dbsp/core';

const myPlurals: Record<string, string> = {
  matrices: 'matrix',
  alumni: 'alumnus',
};

const adapter = createPgsqlAdapter(pool, {
  deriveFkColumnName: (tableName, pkColumnName) =>
    `${singularize(tableName, myPlurals)}_${pkColumnName}`,
});
```

---

## 10. Adapter Logging

The adapter accepts an optional `AdapterLogger` for query observability. All methods are optional — implement only what you need:

```typescript
import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';

const adapter = createPgsqlAdapter(pool, {
  logger: {
    debug(message, ...args) {
      console.debug(`[dbsp] ${message}`, ...args);
    },
    warn(message, ...args) {
      console.warn(`[dbsp] ${message}`, ...args);
    },
    error(message, ...args) {
      console.error(`[dbsp] ${message}`, ...args);
    },
  },
});
```

| Method | When called |
|--------|-------------|
| `debug?(message, ...args)` | Query compilation details, plan decisions |
| `warn?(message, ...args)` | Potential performance issues, deprecations |
| `error?(message, ...args)` | Query failures, connection errors |

The `AdapterLogger` interface is exported from `@dbsp/core` — use any logger that matches the shape (Winston, Pino, console, custom).

> **Note:** The PostgreSQL adapter currently logs sparingly (cleanup errors during streaming transactions). The interface is designed for future expansion — additional log points will be added as the adapter matures.
