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

**In the REPL** (load one schema at a time):
```bash
pnpm dbsp repl -s examples/blog.schema.ts
> posts | where published = true | select title, author.name
```

**In `.dbsp` files:**
```
# comments start with #
posts | where published = true | select title
```

**In TypeScript:**
```typescript
const posts = await orm.nql<Post[]>`posts | where published = true`.all();
```

### Example Schemas

Examples in this guide use three schemas shipped with the project. Each is a **separate file** — you load one at a time with `dbsp repl -s`. Every code block below is labeled with its schema so you can copy-paste directly.

#### Blog — `examples/blog.schema.ts`

```bash
pnpm dbsp repl -s examples/blog.schema.ts
```

Tables: `authors`, `posts`, `comments`, `tags`, `postTags`

```typescript
schema({
  authors:  { id, name, email, bio?, createdAt },
  posts:    { id, title, slug, content?, published, authorId → authors, createdAt, updatedAt? },
  comments: { id, postId → posts, authorName, authorEmail?, content, approved, createdAt },
  tags:     { id, name, slug },
  postTags: { postId → posts, tagId → tags },  // M:N junction
});
```

#### Ecommerce — `examples/ecommerce.schema.ts`

```bash
pnpm dbsp repl -s examples/ecommerce.schema.ts
```

Tables: `categories`, `products`, `variants`, `customers`, `addresses`, `orders`, `orderItems`

```typescript
schema({
  categories: { id, name, slug, parentId? → categories (self-ref: parent/children/ancestors/descendants), sortOrder },
  products:   { id, sku, name, description?, price, stock, categoryId → categories, active, createdAt },
  variants:   { id, productId → products, sku, name, priceModifier, stock },
  customers:  { id, email, firstName, lastName, phone?, createdAt },
  addresses:  { id, customerId → customers, type, street, city, postalCode, country, isDefault },
  orders:     { id, orderNumber, customerId → customers, status, total, shippingAddressId → addresses,
                billingAddressId → addresses, createdAt, updatedAt? },
  orderItems: { id, orderId → orders, productId → products, variantId? → variants, quantity, unitPrice, totalPrice },
});
```

#### Hierarchy — `examples/hierarchy.schema.ts`

```bash
pnpm dbsp repl -s examples/hierarchy.schema.ts
```

Tables: `departments`, `employees`, `projects`

```typescript
schema({
  departments: { id, name, budget? },
  employees:   { id, name, email, title, departmentId → departments, managerId? → employees
                 (self-ref: manager/directReports/managementChain/allReports), hireDate, salary },
  projects:    { id, name, leadId → employees, departmentId → departments, status },
});
```

---

## 2. Basic Syntax

### Table Scan

**blog:**
```
authors
```

**ecommerce:**
```
products
```

Returns all rows and columns from the table.

### Pipe Operators

Chain clauses with `|`:

**ecommerce:**
```
products | where active = true | select id, name | order by name | limit 10
```

**blog:**
```
posts | where published = true | select title, slug | order by createdAt desc | limit 10
```

### Comments

Comments start with `#` and extend to end of line:

```
# Full-line comment (ignored by REPL and .dbsp files)
products | where active = true   # Inline comment
```

---

## 3. WHERE (Filtering)

### Comparison Operators

**blog:**
```
authors | where name = 'Alice'
authors | where name != 'John'
posts | where published = true
```

**ecommerce:**
```
products | where price > 100
products | where price >= 100
products | where stock < 50
orders | where total <= 10
```

### Pattern Matching

**blog:**
```
authors | where name like 'A%'
authors | where email like '%@example.com'
```

**ecommerce:**
```
products | where name like '%Phone%'
customers | where email like '%@gmail.com'
```

### BETWEEN

**ecommerce:**
```
products | where price between 10 and 500
```

**hierarchy:**
```
employees | where salary between 50000 and 100000
```

### IN (Value List)

**ecommerce:**
```
orders | where status in ('pending', 'shipped', 'delivered')
products | where id in (1, 2, 3)
```

### IN (Subquery)

**ecommerce:**
```
customers | where id in (orders | select customerId | where status = 'delivered')

# With limit and order by inside the subquery
customers | where id in (orders | select customerId | order by total desc | limit 10)
```

> Subquery `limit` and `order by` are propagated to SQL. See
> [Three Forms of LIMIT](#three-forms-of-limit) for the difference between
> subquery limit, outer limit, and per-include limit.

### NULL Checks

**blog:**
```
authors | where bio is null
posts | where updatedAt is not null
```

**ecommerce:**
```
products | where description is null
customers | where phone is not null
```

### Logical Operators

**ecommerce:**
```
# AND
products | where active = true and price > 50

# OR
orders | where status = 'pending' or status = 'shipped'

# Parentheses for grouping
products | where (stock < 10 or stock > 1000) and active = true
```

**blog:**
```
# NOT
comments | where not (approved = true)

# Combined
posts | where published = true and (title like '%Guide%' or title like '%Tutorial%')
```

### Relation Filters

Filter by related records using quantifiers:

**blog:**
```
# SOME — at least one related record matches
authors | where some(posts).published = true

# NONE — no related record matches
authors | where none(posts).published = false

# EVERY — all related records match
authors | where every(posts).published = true

# With aliases for complex conditions
authors | where some(posts as p, p.published = true and p.title like '%Guide%')
```

**ecommerce:**
```
customers | where none(orders as o, o.status = 'cancelled' and o.total > 100)
```

### EXISTS Subquery

**ecommerce:**
```
customers | where exists (orders | where customerId = customers.id)
```

---

## 4. SELECT (Projection)

### All Columns

**blog:**
```
authors | select *
authors                    # implicit select *
```

### Specific Columns

**blog:**
```
authors | select id, name, email
```

**ecommerce:**
```
products | select sku, name, price
```

### Aliases

**ecommerce:**
```
products | select name as productName, price as cost
products | select price * 1.1 as priceWithTax
```

### DISTINCT

**ecommerce:**
```
orders | select distinct status
```

**blog:**
```
comments | select count(distinct authorName)
```

### Arithmetic Expressions

**ecommerce:**
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

Select columns from related tables to auto-include them. The planner uses
`json_agg` to aggregate children into a single JSON array per parent row:

**blog:**
```
# Include all post columns as nested JSON array
authors | select *, posts.*
```

```sql
-- Produced SQL (json_agg):
SELECT authors.*, json_agg(posts.*) AS posts
FROM authors LEFT JOIN posts ON authors.id = posts.author_id
GROUP BY authors.id
```

Result shape (nested):
```json
[
  { "id": 1, "name": "Alice", "posts": [{ "id": 1, "title": "..." }, ...] }
]
```

**ecommerce:**
```
# Include specific columns from relation
orders | select id, customer.firstName, customer.email

# Deep nesting
orderItems | select id, product.name, product.category.name
```

### Flat Mode

Use `| flat` to get flat rows instead of nested JSON. The planner picks the
best SQL strategy automatically:

**LEFT JOIN** — default for `| flat` (simple, well-optimized by PostgreSQL):
```
# All columns → LEFT JOIN
authors | select *, posts.* | flat

# Specific columns → LEFT JOIN with column projection
authors | select id, posts.title, posts.createdAt | flat
```

```sql
-- Produced SQL (LEFT JOIN):
SELECT authors.*, posts."title", posts."createdAt"
FROM authors LEFT JOIN posts ON authors.id = posts.author_id
```

**LATERAL JOIN** — used when a per-include LIMIT caps children per parent:
```
# Top 3 posts per author → LATERAL subquery
authors | select *, posts.* | limit posts 3 | flat

# Without explicit | flat — per-include limit implies flat automatically
authors | select *, posts.* | limit posts 3
```

```sql
-- Produced SQL (LATERAL):
SELECT authors.*, posts_lat_0.*
FROM authors LEFT JOIN LATERAL (
  SELECT * FROM posts WHERE author_id = authors.id LIMIT 3
) AS posts_lat_0 ON true
```

> **When is LATERAL used?** Only when `| limit <relation> N` is set. Without a
> per-include limit, a standard LEFT JOIN is simpler and faster. The planner
> chooses automatically.

Result shape (flat):
```json
[
  { "id": 1, "name": "Alice", "posts_id": 1, "posts_title": "..." },
  { "id": 1, "name": "Alice", "posts_id": 2, "posts_title": "..." }
]
```

### Many-to-Many Relations

**blog:**
```
posts | select *, tags.*
```

The planner automatically resolves junction tables.

### Include Strategy Summary

| NQL | SQL Strategy | When |
|-----|-------------|------|
| `select *, relation.*` | `json_agg` | Default — nested JSON array, no row explosion |
| `select *, relation.* \| flat` | `LEFT JOIN` | Flat rows, simple and fast |
| `select *, relation.* \| limit relation N` | `LEFT JOIN LATERAL` | Flat rows with per-parent LIMIT (implicit flat) |
| `select name, ancestors.*` | `CTE` | Recursive/hierarchical relations |

The planner picks the optimal strategy automatically. You control the
output shape (`| flat`) and per-include constraints (`| limit <relation> N`).

---

## 6. Aggregates & GROUP BY

### Aggregate Functions

**blog:**
```
posts | select count(*)
```

**ecommerce:**
```
orders | select sum(total)
orders | select avg(total)
products | select min(price), max(price)
```

### COUNT DISTINCT

**ecommerce:**
```
orders | select count(distinct customerId) as uniqueCustomers
```

### GROUP BY

**ecommerce:**
```
orders | group by status | select status, count(*) as total
```

**blog:**
```
posts | group by authorId | select authorId, count(*)
```

### WHERE vs HAVING

Position relative to `group by` determines behavior:

**ecommerce:**
```
# WHERE — filters individual rows (before grouping)
orders | where total > 100 | group by status | select status, count(*)

# HAVING — filters aggregated groups (after grouping)
orders | group by status | where count(*) > 10 | select status, count(*)
```

---

## 7. ORDER BY, LIMIT, OFFSET

### Sorting

**blog:**
```
authors | order by name
posts | order by createdAt desc
```

**ecommerce:**
```
customers | order by lastName asc, firstName asc
products | order by price desc
```

### Pagination

**blog:**
```
posts | order by createdAt desc | limit 10
posts | order by createdAt desc | limit 10 | offset 20
```

### Three Forms of LIMIT

NQL has three distinct uses of LIMIT. They look similar but have very different semantics:

#### 1. Outer Limit — `| limit N`

Caps the total number of rows returned by the query:

**blog:**
```
# Return at most 10 posts
posts | order by createdAt desc | limit 10
```

```sql
SELECT * FROM posts ORDER BY created_at DESC LIMIT 10
```

#### 2. Per-Include Limit — `| limit <relation> N`

Caps child rows **per parent** using a LATERAL JOIN:

**blog:**
```
# Top 3 posts PER author
authors | select id, name, posts.* | limit posts 3
```

```sql
SELECT authors.id, authors.name, posts_lat_0.*
FROM authors LEFT JOIN LATERAL (
  SELECT * FROM posts WHERE author_id = authors.id LIMIT 3
) AS posts_lat_0 ON true
```

Every author gets at most 3 posts. If there are 100 authors, you get up to 300 rows.

#### 3. Subquery Limit — `| limit N` inside `in (...)`

Caps the total rows of the subquery used as a WHERE filter:

**ecommerce:**
```
# Customers whose ID appears in the first 5 delivered orders
customers | where id in (orders | select customerId | where status = 'delivered' | limit 5)
```

```sql
SELECT * FROM customers
WHERE id IN (SELECT customer_id FROM orders WHERE status = $1 LIMIT 5)
```

This filters **which parents** are returned, not how many children each parent gets.

#### Comparison

Given 50 customers, each with 10 orders:

| Form | NQL | Effect | Rows returned |
|------|-----|--------|---------------|
| Outer limit | `customers \| limit 5` | First 5 customers | 5 |
| Per-include limit | `customers \| select *, orders.* \| limit orders 3` | All 50 customers × max 3 orders each | Up to 150 |
| Subquery limit | `customers \| where id in (orders \| select customerId \| limit 5)` | Customers matching the first 5 order rows (1-5 customers) | 1–5 |
| Combined | `customers \| select *, orders.* \| limit orders 3 \| limit 10` | First 10 customers × max 3 orders each | Up to 30 |

#### Per-Include Limit — Additional Examples

**ecommerce:**
```
# Top 5 order items per order
orders | select id, orderNumber, orderItems.* | limit orderItems 5

# Multiple per-include limits on different relations
customers | select id, orders.*, addresses.* | limit orders 3 | limit addresses 2

# Combined: 3 orders per customer, max 10 customers
customers | select id, orders.* | limit orders 3 | limit 10
```

**hierarchy:**
```
# Top 2 employees per department
departments | select id, name, employees.* | limit employees 2

# Combined: 2 employees per department, max 5 departments
departments | select id, name, employees.* | limit employees 2 | limit 5
```

**dotted-path (deep nesting):**
```
# Top 3 employees per department, across all companies
companies | select id, departments.employees.* | limit departments.employees 3
```

> Dotted paths work for deep nesting: `limit departments.employees 3` applies the
> limit to the `employees` level while forcing all ancestor includes (`departments`)
> to use LATERAL cascade.

> **How it works:** `| limit <relation> N` forces `strategy: 'flat'` on that
> include (LATERAL JOIN required — `json_agg` cannot honor per-parent limits).
> `| flat` is implicit and can be omitted.

---

## 8. Window Functions

### Syntax

```
function() over ([partition by expr] [order by expr [asc|desc]])
```

### Row Numbering

**ecommerce:**
```
products | select name, row_number() over (order by price) as rn
products | select name, rank() over (partition by categoryId order by price desc) as priceRank
products | select name, dense_rank() over (order by price) as dr
```

### Lag / Lead (Previous / Next Row)

**ecommerce:**
```
orders | select orderNumber, total, lag(total) over (order by createdAt) as prevTotal
orders | select orderNumber, total, lead(total) over (order by createdAt) as nextTotal
```

### Aggregate Windows

**ecommerce:**
```
orders | select orderNumber, total, sum(total) over (order by createdAt) as runningTotal
orderItems | select orderId, totalPrice, sum(totalPrice) over (partition by orderId) as orderTotal
```

### Empty OVER

**ecommerce:**
```
products | select name, count(*) over () as totalProducts
```

---

## 9. CASE Expressions

**ecommerce:**
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

**hierarchy:**
```
employees | select name, case
  when salary > 100000 then 'senior'
  when salary > 60000 then 'mid'
  else 'junior'
end as level
```

---

## 10. Hierarchy / Recursive Traversal

> Load: `pnpm dbsp repl -s examples/hierarchy.schema.ts`

Requires a schema with self-referential `ref()` and `roles` configured.

### Single-Hop Traversal

**hierarchy:**
```
# Direct parent
employees | select name, title, manager.name

# Chained: grandparent
employees | select name, manager.name, manager.manager.name
```

### Recursive Ancestors

**hierarchy:**
```
# Full ancestor chain as JSON array
employees | select name, managementChain.*

# Specific columns from ancestors
employees | select name, managementChain.name, managementChain.title
```

### Recursive Descendants

**hierarchy:**
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

**ecommerce:**
```
insert into products set sku = 'IPH-15', name = 'iPhone', price = 999, categoryId = 1

# With RETURNING (pipe to select)
insert into products set sku = 'IPH-15', name = 'iPhone', price = 999, categoryId = 1 | select id, name
```

**blog:**
```
insert into authors set name = 'Alice', email = 'alice@example.com'
insert into posts set title = 'Hello', slug = 'hello', authorId = 1 | select id, title
```

### INSERT FROM (Bulk Copy)

**ecommerce:**
```
# Copy rows from a filtered query
insert into orderItems from orderItems | where orderId = 1

# With limit
insert into orderItems from orderItems | where orderId = 1 | limit 10

# With RETURNING
insert into addresses from addresses | where customerId = 5 | select id
```

### UPDATE

**ecommerce:**
```
update products set price = 899 where id = 1

# With RETURNING
update orders set status = 'shipped' where id = 1 | select id, status
```

**blog:**
```
update posts set published = true where authorId = 1
```

### DELETE

**ecommerce:**
```
delete from products where id = 1
```

**blog:**
```
delete from comments where approved = false
```

### UPSERT

**ecommerce:**
```
# Single conflict column
upsert into customers on email set firstName = 'Alice', lastName = 'Smith', email = 'alice@example.com'

# Multiple conflict columns
upsert into orderItems on (orderId, productId) set quantity = 2, unitPrice = 29.99, totalPrice = 59.98
```

### Mutation Chaining with BIND

Chain mutations where the second uses results from the first:

**ecommerce:**
```
insert into orders set customerId = 1, orderNumber = 'ORD-100', total = 59.99, shippingAddressId = 1, billingAddressId = 1 | bind order
insert into orderItems set orderId = order.id, productId = 5, quantity = 2, unitPrice = 29.99, totalPrice = 59.98
```

---

## 12. Advanced Features

### LET Bindings (CTEs)

Define reusable query fragments:

**ecommerce:**
```
let activeProducts = products | where active = true
activeProducts | select name, price | order by price
```

**blog:**
```
let recentPosts = posts | where published = true | order by createdAt desc | limit 10
recentPosts | select title, author.name
```

### Raw SQL Escape Hatch

Prefix with `!` for raw SQL (works with any schema):

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
.schema authors      # Show table columns (blog)
.schema products     # Show table columns (ecommerce)
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

**blog:**

| NQL | ORM API |
|-----|---------|
| `authors` | `orm.select('authors').all()` |
| `authors \| select id, name` | `orm.select('authors').columns(['id', 'name'])` |
| `authors \| select *, posts.*` | `orm.select('authors').include('posts')` |
| `authors \| order by name desc` | `orm.select('authors').orderBy('name', 'desc')` |
| `posts \| limit 10` | `orm.select('posts').limit(10)` |
| `posts \| group by authorId \| select count(*)` | `orm.select('posts').groupBy(['authorId']).count()` |
| `insert into authors set name = 'A', email = 'a@b.c'` | `orm.insert('authors').values({ name: 'A', email: 'a@b.c' }).execute()` |
| `delete from comments where id = 1` | `orm.delete('comments').where(eq('id', 1)).execute()` |

**ecommerce:**

| NQL | ORM API |
|-----|---------|
| `products \| where active = true` | `orm.select('products').where(eq('active', true))` |
| `orders \| select distinct status` | `orm.select('orders').columns(['status']).distinct()` |
| `update orders set status = 'shipped' where id = 1` | `orm.update('orders').set({ status: 'shipped' }).where(eq('id', 1)).execute()` |
