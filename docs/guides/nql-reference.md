# NQL Reference

Complete reference for the Natural Query Language — a pipe-based syntax for database queries.

**Related guides:** [ORM API](./orm-api.md) | [README](../../README.md) | [CLI Usage](../CLI_USAGE.md)

---

## 1. What is NQL?

NQL (Natural Query Language) is a pipe-based query language that compiles to the same IntentAST as the ORM API. It's designed for:
- **CLI/REPL** interactive exploration (`dbsp repl`)
- **`.dbsp` files** for batch queries and test assertions
- **Template literals** in TypeScript via `orm.nql`

```
table | operator | operator | ...
```

Every NQL query compiles through the same semantic planner as the ORM API, producing identical SQL output.

### Setup

Your schema file imports from `@dbsp/core`, so it must be resolvable from your project directory.

**Option 1 — Install from registry (published package):**
```bash
mkdir my-project && cd my-project
pnpm init
pnpm add @dbsp/core @dbsp/adapter-pgsql
pnpm add -D @dbsp/cli
```

**Option 2 — Link local packages (development):**
```bash
mkdir my-project && cd my-project
pnpm init
pnpm link /path/to/db-semantic-planner/packages/core
pnpm link /path/to/db-semantic-planner/packages/cli
```

> Both options require the packages to be **built** (`pnpm build` in the monorepo root).

### Using NQL

**In the REPL:**
```bash
pnpm dbsp repl --schema ./schema.ts
> products | where active = true | select id, name
```

**In `.dbsp` files:**
```
# comments start with #
products | where active = true | select id, name
```

**In TypeScript:**
```typescript
const products = await orm.nql<Product[]>`products | where active = true`.all();
```

### Example Schemas

The examples below use tables from schemas shipped with the project:

- [`examples/blog.schema.ts`](../../examples/blog.schema.ts) — `authors`, `posts`, `comments`, `tags`, `postTags`
- [`examples/ecommerce.schema.ts`](../../examples/ecommerce.schema.ts) — `products`, `orders`, `orderItems`, `customers`, `categories`, `variants`, `addresses`
- [`examples/hierarchy.schema.ts`](../../examples/hierarchy.schema.ts) — `employees`, `departments`, `projects`

Examples freely mix tables from all three schemas — each query uses whichever table best illustrates the feature. All table and column names match the schemas above.

Here's a consolidated view of the key tables referenced in this guide:

```typescript
import { schema, ref } from '@dbsp/core';

// === Blog schema ===
export default schema({
  authors: {
    id: { type: 'integer', primaryKey: true, autoIncrement: true },
    name: 'string',
    email: { type: 'string', unique: true },
    bio: { type: 'text', nullable: true },
    createdAt: { type: 'timestamp', default: 'now()' },
  },
  posts: {
    id: { type: 'integer', primaryKey: true, autoIncrement: true },
    title: 'string',
    slug: { type: 'string', unique: true },
    content: { type: 'text', nullable: true },
    published: { type: 'boolean', default: 'false' },
    authorId: ref('authors', { onDelete: 'CASCADE', inverse: 'posts' }),
    createdAt: { type: 'timestamp', default: 'now()' },
    updatedAt: { type: 'timestamp', nullable: true },
  },
  comments: {
    id: { type: 'integer', primaryKey: true, autoIncrement: true },
    postId: ref('posts', { onDelete: 'CASCADE', inverse: 'comments' }),
    authorName: 'string',
    authorEmail: { type: 'string', nullable: true },
    content: 'text',
    approved: { type: 'boolean', default: 'false' },
    createdAt: { type: 'timestamp', default: 'now()' },
  },
  tags: {
    id: { type: 'integer', primaryKey: true, autoIncrement: true },
    name: { type: 'string', unique: true },
    slug: { type: 'string', unique: true },
  },
  postTags: {
    postId: ref('posts', { onDelete: 'CASCADE' }),
    tagId: ref('tags', { onDelete: 'CASCADE' }),
  },
});

// === Ecommerce schema (key tables) ===
export default schema({
  products: {
    id: { type: 'integer', primaryKey: true, autoIncrement: true },
    sku: { type: 'string', unique: true },
    name: 'string',
    price: 'decimal',
    stock: { type: 'integer', default: '0' },
    categoryId: ref('categories', { onDelete: 'RESTRICT', inverse: 'products' }),
    active: { type: 'boolean', default: 'true' },
    createdAt: { type: 'timestamp', default: 'now()' },
  },
  orders: {
    id: { type: 'integer', primaryKey: true, autoIncrement: true },
    orderNumber: { type: 'string', unique: true },
    customerId: ref('customers', { onDelete: 'RESTRICT', inverse: 'orders' }),
    status: { type: 'string', default: "'pending'" },
    total: 'decimal',
    createdAt: { type: 'timestamp', default: 'now()' },
  },
  orderItems: {
    id: { type: 'integer', primaryKey: true, autoIncrement: true },
    orderId: ref('orders', { onDelete: 'CASCADE' }),
    productId: ref('products', { onDelete: 'RESTRICT' }),
    quantity: 'integer',
    unitPrice: 'decimal',
    totalPrice: 'decimal',
  },
  customers: {
    id: { type: 'integer', primaryKey: true, autoIncrement: true },
    email: { type: 'string', unique: true },
    firstName: 'string',
    lastName: 'string',
    createdAt: { type: 'timestamp', default: 'now()' },
  },
  categories: {
    id: { type: 'integer', primaryKey: true, autoIncrement: true },
    name: 'string',
    slug: { type: 'string', unique: true },
    parentId: ref('categories', { nullable: true, roles: { parent: 'parent', children: 'children' } }),
  },
});

// === Hierarchy schema ===
export default schema({
  employees: {
    id: { type: 'integer', primaryKey: true, autoIncrement: true },
    name: 'string',
    title: 'string',
    salary: 'decimal',
    managerId: ref('employees', {
      nullable: true,
      roles: {
        parent: 'manager',
        children: 'directReports',
        ancestors: 'managementChain',
        descendants: 'allReports',
      },
    }),
  },
});
```

---

## 2. Basic Syntax

### Table Scan

```
authors
```

Returns all rows and columns from the table.

### Pipe Operators

Chain clauses with `|`:

```
products | where active = true | select id, name | order by name | limit 10
```

### Comments

```
# This is a comment
products | where active = true   # Inline comment
```

---

## 3. WHERE (Filtering)

### Comparison Operators

```
authors | where name = 'Alice'
authors | where name != 'John'
products | where price > 100
products | where price >= 100
products | where stock < 50
orders | where total <= 10
```

### Pattern Matching

```
authors | where name like 'A%'
authors | where email like '%@example.com'
```

### BETWEEN

```
products | where price between 10 and 500
```

### IN (Value List)

```
orders | where status in ('pending', 'shipped', 'delivered')
products | where id in (1, 2, 3)
```

### IN (Subquery)

```
customers | where id in (orders | select customerId | where status = 'delivered')
```

### NULL Checks

```
authors | where bio is null
posts | where updatedAt is not null
```

### Logical Operators

```
# AND
products | where active = true and price > 50

# OR
orders | where status = 'pending' or status = 'shipped'

# NOT
comments | where not (approved = true)

# Parentheses for grouping
products | where (stock < 10 or stock > 1000) and active = true
```

### Relation Filters

Filter by related records using quantifiers:

```
# SOME — at least one related record matches
authors | where some(posts).published = true

# NONE — no related record matches
authors | where none(posts).published = false

# EVERY — all related records match
authors | where every(posts).published = true

# With aliases for complex conditions
authors | where some(posts as p, p.published = true and p.title like '%Guide%')
customers | where none(orders as o, o.status = 'cancelled' and o.total > 100)
```

### EXISTS Subquery

```
customers | where exists (orders | where customerId = customers.id)
```

---

## 4. SELECT (Projection)

### All Columns

```
authors | select *
authors                    # implicit select *
```

### Specific Columns

```
authors | select id, name, email
```

### Aliases

```
products | select name as productName, price as cost
products | select price * 1.1 as priceWithTax
```

### DISTINCT

```
orders | select distinct status
comments | select count(distinct authorName)
```

### Arithmetic Expressions

```
orderItems | select unitPrice + 5 as shippingTotal
orderItems | select quantity * unitPrice as lineTotal
products | select price - 10 as discountedPrice
orderItems | select totalPrice / quantity as effectiveUnitPrice
orderItems | select quantity % 3 as remainder
```

Standard operator precedence: `*`, `/`, `%` bind tighter than `+`, `-`.

---

## 5. Includes (Relations)

### Nested JSON (Default)

Select columns from related tables to auto-include them:

```
# Include all post columns as nested JSON array
authors | select *, posts.*

# Include specific columns from relation
orders | select id, customer.firstName, customer.email

# Deep nesting
orderItems | select id, product.name, product.category.name
```

Result shape (nested):
```json
[
  { "id": 1, "name": "Alice", "posts": [{ "id": 1, "title": "..." }, ...] }
]
```

### Flat Mode

Use `| flat` to force JOIN strategy (flat rows instead of nested JSON):

```
authors | select *, posts.* | flat
```

Result shape (flat):
```json
[
  { "id": 1, "name": "Alice", "posts_id": 1, "posts_title": "..." },
  { "id": 1, "name": "Alice", "posts_id": 2, "posts_title": "..." }
]
```

### Many-to-Many Relations

```
posts | select *, tags.*
```

The planner automatically resolves junction tables.

---

## 6. Aggregates & GROUP BY

### Aggregate Functions

```
posts | select count(*)
orders | select sum(total)
orders | select avg(total)
products | select min(price), max(price)
```

### COUNT DISTINCT

```
orders | select count(distinct customerId) as uniqueCustomers
```

### GROUP BY

```
orders | group by status | select status, count(*) as total
posts | group by authorId | select authorId, count(*)
```

### WHERE vs HAVING

Position relative to `group by` determines behavior:

```
# WHERE — filters individual rows (before grouping)
orders | where total > 100 | group by status | select status, count(*)

# HAVING — filters aggregated groups (after grouping)
orders | group by status | where count(*) > 10 | select status, count(*)
```

---

## 7. ORDER BY, LIMIT, OFFSET

### Sorting

```
authors | order by name
posts | order by createdAt desc
customers | order by lastName asc, firstName asc
```

### Pagination

```
posts | order by createdAt desc | limit 10
posts | order by createdAt desc | limit 10 | offset 20
```

---

## 8. Window Functions

### Syntax

```
function() over ([partition by expr] [order by expr [asc|desc]])
```

### Row Numbering

```
products | select name, row_number() over (order by price) as rn
products | select name, rank() over (partition by categoryId order by price desc) as priceRank
products | select name, dense_rank() over (order by price) as dr
```

### Lag / Lead (Previous / Next Row)

```
orders | select orderNumber, total, lag(total) over (order by createdAt) as prevTotal
orders | select orderNumber, total, lead(total) over (order by createdAt) as nextTotal
```

### Aggregate Windows

```
orders | select orderNumber, total, sum(total) over (order by createdAt) as runningTotal
orderItems | select orderId, totalPrice, sum(totalPrice) over (partition by orderId) as orderTotal
```

### Empty OVER

```
products | select name, count(*) over () as totalProducts
```

---

## 9. CASE Expressions

```
# Simple
products | select case when price > 100 then 'expensive' end

# Multiple conditions with ELSE
products | select case
  when price > 100 then 'high'
  when price > 50 then 'medium'
  else 'low'
end as tier

# Mixed with other columns
products | select name, price, case when price > 100 then 'high' else 'low' end as tier
```

---

## 10. Hierarchy / Recursive Traversal

Requires a schema with self-referential `ref()` and `roles` configured.

### Single-Hop Traversal

```
# Direct parent
employees | select name, title, manager.name

# Chained: grandparent
employees | select name, manager.name, manager.manager.name
```

### Recursive Ancestors

```
# Full ancestor chain as JSON array
employees | select name, managementChain.*

# Specific columns from ancestors
employees | select name, managementChain.name, managementChain.title
```

### Recursive Descendants

```
# Full descendant chain
employees | select name, allReports.*

# Specific columns
employees | select name, allReports.name
```

> The role names (`manager`, `managementChain`, `allReports`) come from the schema's `roles` option on the self-referential `ref()`.

---

## 11. Mutations

### INSERT

```
insert into products set sku = 'IPH-15', name = 'iPhone', price = 999, categoryId = 1

# With RETURNING (pipe to select)
insert into products set sku = 'IPH-15', name = 'iPhone', price = 999, categoryId = 1 | select id, name
```

### INSERT FROM (Bulk Copy)

```
# Copy rows from a filtered query
insert into orderItems from orderItems | where orderId = 1

# With filter
insert into addresses from addresses | where customerId = 5

# With limit
insert into orderItems from orderItems | where orderId = 1 | limit 10

# With RETURNING
insert into addresses from addresses | where customerId = 5 | select id
```

### UPDATE

```
update products set price = 899 where id = 1

# With RETURNING
update orders set status = 'shipped' where id = 1 | select id, status
```

### DELETE

```
delete from products where id = 1
```

### UPSERT

```
# Single conflict column
upsert into customers on email set firstName = 'Alice', lastName = 'Smith', email = 'alice@example.com'

# Multiple conflict columns
upsert into orderItems on (orderId, productId) set quantity = 2, unitPrice = 29.99, totalPrice = 59.98
```

### Mutation Chaining with BIND

Chain mutations where the second uses results from the first:

```
insert into orders set customerId = 1, orderNumber = 'ORD-100', total = 59.99, shippingAddressId = 1, billingAddressId = 1 | bind order
insert into orderItems set orderId = order.id, productId = 5, quantity = 2, unitPrice = 29.99, totalPrice = 59.98
```

---

## 12. Advanced Features

### LET Bindings (CTEs)

Define reusable query fragments:

```
let activeProducts = products | where active = true
activeProducts | select name, price | order by price
```

### Raw SQL Escape Hatch

Prefix with `!` for raw SQL:

```
!CREATE SCHEMA IF NOT EXISTS tenant_123
!SELECT pg_advisory_lock(12345)
```

### Literals

| Type | Syntax | Example |
|------|--------|---------|
| String | Single quotes | `'hello'`, `'O''Brien'` |
| Integer | Digits | `42` |
| Decimal | Digits with dot | `3.14` |
| Boolean | Keywords | `true`, `false` |
| Null | Keyword | `null` |
| Range | Brackets | `[2024-01-01,2024-12-31]` |

### Identifiers

```
authors            # unquoted (standard)
"order"            # quoted (reserved keyword)
"order-items"      # quoted (special characters)
"Order Details"    # quoted (spaces)
```

### REPL Dot Commands

In the interactive REPL, dot commands provide schema introspection:

```
.tables              # List all tables
.schema authors      # Show table columns
.relations posts     # Show table relations
.use tenant_123      # Set schema context
.import file.sql     # Execute SQL file
.help                # Show all commands
```

---

## 13. Quick Reference

### Operator Precedence

| Priority | Operators |
|----------|-----------|
| Highest | `*`, `/`, `%` |
| | `+`, `-` |
| | `=`, `!=`, `<`, `>`, `<=`, `>=`, `like`, `in`, `between` |
| | `not` |
| | `and` |
| Lowest | `or` |

### Reserved Keywords

**Query:** `select`, `where`, `flat`, `via`, `let`, `bind`, `group`, `by`, `order`, `limit`, `offset`, `distinct`

**Boolean:** `and`, `or`, `not`, `all`, `some`, `none`, `every`

**Functions:** `case`, `when`, `then`, `else`, `end`, `over`, `partition`, `row_number`, `rank`, `dense_rank`, `lag`, `lead`

**Mutations:** `insert`, `into`, `update`, `delete`, `from`, `set`, `upsert`, `on`

**Comparisons:** `between`, `in`, `like`, `is`, `exists`, `overlaps`, `contains`, `containedBy`

**Literals:** `true`, `false`, `null`

### NQL vs ORM API

| NQL | ORM API |
|-----|---------|
| `authors` | `orm.select('authors').all()` |
| `products \| where active = true` | `orm.select('products').where(eq('active', true))` |
| `authors \| select id, name` | `orm.select('authors').columns(['id', 'name'])` |
| `authors \| select *, posts.*` | `orm.select('authors').include('posts')` |
| `authors \| order by name desc` | `orm.select('authors').orderBy('name', 'desc')` |
| `posts \| limit 10` | `orm.select('posts').limit(10)` |
| `posts \| group by authorId \| select count(*)` | `orm.select('posts').groupBy(['authorId']).count()` |
| `insert into authors set name = 'A', email = 'a@b.c'` | `orm.insert('authors').values({ name: 'A', email: 'a@b.c' }).execute()` |
| `update orders set status = 'shipped' where id = 1` | `orm.update('orders').set({ status: 'shipped' }).where(eq('id', 1)).execute()` |
| `delete from comments where id = 1` | `orm.delete('comments').where(eq('id', 1)).execute()` |
