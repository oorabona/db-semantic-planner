# ORM API Guide

Complete reference for the `@dbsp/core` TypeScript API. Progressive examples from basic queries to advanced features.

**Related guides:** [NQL Reference](./nql-reference.md) | [README](../../README.md) | [CLI Usage](../CLI_USAGE.md)

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
| `'number'` | `NUMERIC` | `number` |
| `'bigint'` | `BIGINT` | `bigint` |
| `'decimal'` | `DECIMAL` | `number` |
| `'boolean'` | `BOOLEAN` | `boolean` |
| `'date'` | `DATE` | `Date` |
| `'time'` | `TIME` | `string` |
| `'datetime'` | `TIMESTAMP` | `Date` |
| `'timestamp'` | `TIMESTAMP` | `Date` |
| `'json'` | `JSON` | `unknown` |
| `'jsonb'` | `JSONB` | `unknown` |
| `'uuid'` | `UUID` | `string` |
| `'daterange'` | `DATERANGE` | `[Date, Date]` |
| `'tsrange'` | `TSRANGE` | `[Date, Date]` |
| `'tstzrange'` | `TSTZRANGE` | `[Date, Date]` |
| `'int4range'` | `INT4RANGE` | `[number, number]` |
| `'int8range'` | `INT8RANGE` | `[number, number]` |
| `'numrange'` | `NUMRANGE` | `[number, number]` |

### Column Options

Shorthand (type only) or object with options:

```typescript
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
ref(targetTable: string, options?: RefOptions)
```

Relations are auto-inferred from `ref()` calls. The planner detects:
- **belongsTo** (N:1) — the table with the FK
- **hasMany** (1:N) — the target table
- **M:N** — via junction table with two FKs

```typescript
const db = schema({
  posts: {
    authorId: ref('users'),                              // basic FK
    editorId: ref('users', { nullable: true }),          // optional relation
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
  { orderItems: { orderId: ref('orders'), productId: ref('products'), quantity: 'integer' } },
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
const users = await tenantOrm.select('users').all();
// SQL: SELECT * FROM "tenant_123"."users"
```

### Transactions

```typescript
const result = await orm.transaction(async (tx) => {
  await tx.insert('orders').values({ customerId: 1, total: 99 }).execute();
  await tx.insert('orderItems').values({ orderId: 1, productId: 5 }).execute();
  return tx.select('orders').where(eq('customerId', 1)).all();
});
// Auto-commit on success, auto-rollback on error
```

---

## 3. Querying (QueryBuilder)

All query builder methods return a new immutable instance. Safe to branch and reuse.

### `select()` — Start a Query

```typescript
const users = await orm.select('users').all();
```

### `columns()` — Select Specific Columns

```typescript
const names = await orm.select('users').columns(['id', 'name']).all();
// SQL: SELECT "id", "name" FROM "users"
```

### `distinct()` — Remove Duplicates

```typescript
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
| `and(...conditions)` | `AND` | `and(eq('a', 1), gt('b', 2))` |
| `or(...conditions)` | `OR` | `or(eq('x', 1), eq('x', 2))` |
| `not(condition)` | `NOT` | `not(eq('deleted', true))` |

### Relation Filters

Filter by related records without loading them:

```typescript
import { exists, notExists, some, every, none } from '@dbsp/core';

// Users who have at least one post
orm.select('users').where(exists('posts'))

// Users who have no posts
orm.select('users').where(notExists('posts'))

// Users who have at least one published post
orm.select('users').where(some('posts', eq('published', true)))

// Users where ALL posts are published
orm.select('users').where(every('posts', eq('published', true)))

// Users where NO post is a draft
orm.select('users').where(none('posts', eq('draft', true)))
```

### Range Operators (PostgreSQL)

```typescript
import { rangeOverlaps, rangeContains, rangeContainedBy } from '@dbsp/core';

// Bookings that overlap a date range
orm.select('bookings').where(rangeOverlaps('period', ['2024-01-01', '2024-01-31']))

// Events that contain a specific date
orm.select('events').where(rangeContains('dateRange', ['2024-06-15', '2024-06-15']))

// Events within a year
orm.select('events').where(rangeContainedBy('dateRange', ['2024-01-01', '2024-12-31']))
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
orm.select('orders')
  .groupBy(['status'])
  .count('id', 'orderCount')
  .having(gt('orderCount', 10))
  .all()
// SQL: SELECT "status", COUNT("id") AS "orderCount" FROM "orders"
//      GROUP BY "status" HAVING "orderCount" > $1
```

### Window Functions

```typescript
import {
  rowNumber, rank, denseRank,
  wSum, wAvg, wCount, wMin, wMax,
  lag, lead
} from '@dbsp/core';

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

---

## 4. Includes (Eager Loading)

### Simple Include

```typescript
const usersWithPosts = await orm.select('users').include('posts').all();
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
  .all()
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
  .all()

// Descendants (down the tree) — flat output
orm.select('categories')
  .where(eq('id', 1))
  .include('children', {
    recursive: true,
    direction: 'descendants',
    flat: true,
    maxDepth: 10
  })
  .all()
```

---

## 5. Mutations

### Insert

```typescript
// Basic insert
await orm.insert('users')
  .values({ name: 'Alice', email: 'alice@example.com' })
  .execute();

// Bulk insert
await orm.insert('users')
  .values([
    { name: 'Alice', email: 'alice@example.com' },
    { name: 'Bob', email: 'bob@example.com' },
  ])
  .execute();

// With RETURNING
const [newUser] = await orm.insert('users')
  .values({ name: 'Alice', email: 'alice@example.com' })
  .returning(['id', 'name', 'createdAt'])
  .execute();
```

### Update

```typescript
// Update with WHERE (required)
await orm.update('users')
  .set({ name: 'Alice Smith' })
  .where(eq('id', 1))
  .execute();

// Update all rows (explicit intent)
await orm.updateAll('users')
  .set({ active: false })
  .execute();

// With RETURNING
const updated = await orm.update('users')
  .set({ active: true })
  .where(eq('email', 'alice@example.com'))
  .returning(['id', 'name', 'active'])
  .execute();
```

### Delete

```typescript
// Delete with WHERE (required)
await orm.delete('users')
  .where(eq('id', 1))
  .execute();

// Delete all rows (explicit intent)
await orm.deleteAll('users').execute();

// With cascade
await orm.delete('users')
  .where(eq('id', 1))
  .cascade()           // cascade to all relations
  .execute();

// With RETURNING
const deleted = await orm.delete('posts')
  .where(eq('published', false))
  .returning(['id', 'title'])
  .execute();
```

### Upsert (Insert or Update on Conflict)

```typescript
// On conflict by columns — auto-update non-conflict fields
await orm.upsert('users')
  .values({ name: 'Alice', email: 'alice@example.com', active: true })
  .onConflict(['email'])
  .doUpdate()
  .execute();

// On conflict — update specific fields
await orm.upsert('users')
  .values({ name: 'Alice', email: 'alice@example.com', active: true })
  .onConflict(['email'])
  .doUpdate({ name: 'Alice Updated', active: true })
  .execute();

// On conflict by constraint name
await orm.upsert('users')
  .values({ name: 'Alice', email: 'alice@example.com' })
  .onConflictConstraint('users_email_unique')
  .doNothing()
  .execute();

// With RETURNING
const result = await orm.upsert('users')
  .values({ name: 'Alice', email: 'alice@example.com' })
  .onConflict(['email'])
  .doUpdate()
  .returning(['id', 'name'])
  .execute();
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

```typescript
// Standard execution
const users = await orm.select('users').all();
const user = await orm.select('users').where(eq('id', 1)).first();
const user = await orm.select('users').where(eq('id', 1)).firstOrThrow();

// Primary key shortcuts
const user = await orm.select('users').byId(1);
const user = await orm.select('users').byIdOrThrow(1);
const users = await orm.select('users').byIds([1, 2, 3]);
```

### Streaming

```typescript
const stream = orm.select('users').stream();

for await (const user of stream) {
  console.log(user.name);
  if (shouldStop) break;  // early break releases connection
}
```

### Pagination

#### Offset-Based

```typescript
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
const users = await orm.nql<User[]>`users | where active = true | limit 10`.all();
const dump = orm.nql`posts | where published = true | select title, author.*`.dump();
```

See the [NQL Reference](./nql-reference.md) for full syntax.

### Hierarchy Shortcuts

```typescript
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
const results = await orm.raw<{ count: number }>(
  'SELECT COUNT(*) as count FROM "users" WHERE "active" = $1',
  [true]
);
```

> **Warning:** `raw()` bypasses the planner and type safety. Use only when the ORM API is insufficient.
