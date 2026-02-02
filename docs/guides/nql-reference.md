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
> users | where active = true | select id, name
```

**In `.dbsp` files:**
```
# comments start with #
users | where active = true | select id, name
```

**In TypeScript:**
```typescript
const users = await orm.nql<User[]>`users | where active = true`.all();
```

### Example Schemas

The examples below use tables from three schemas shipped with the project:

- [`examples/minimal.schema.ts`](../../examples/minimal.schema.ts) — `users`, `posts`
- [`examples/blog.schema.ts`](../../examples/blog.schema.ts) — `authors`, `posts`, `comments`, `tags`, `postTags`
- [`examples/hierarchy.schema.ts`](../../examples/hierarchy.schema.ts) — `employees`, `departments`, `projects`

Here's a consolidated view of the key tables referenced in this guide:

```typescript
import { schema, ref } from '@dbsp/core';

export default schema({
  // — minimal —
  users: {
    id: { type: 'integer', primaryKey: true, autoIncrement: true },
    name: 'string',
    email: { type: 'string', unique: true },
    active: { type: 'boolean', default: 'true' },
    age: 'integer',
    role: 'string',
    department: 'string',
    deletedAt: { type: 'timestamp', nullable: true },
  },
  posts: {
    id: { type: 'integer', primaryKey: true, autoIncrement: true },
    title: 'string',
    content: { type: 'text', nullable: true },
    published: { type: 'boolean', default: 'false' },
    views: { type: 'integer', default: '0' },
    authorId: ref('users', { onDelete: 'CASCADE', inverse: 'posts' }),
    createdAt: { type: 'timestamp', default: 'now()' },
  },
  // — blog (extends minimal with richer relations) —
  comments: {
    id: { type: 'integer', primaryKey: true, autoIncrement: true },
    postId: ref('posts', { onDelete: 'CASCADE', inverse: 'comments' }),
    authorName: 'string',
    content: 'text',
    approved: { type: 'boolean', default: 'false' },
  },
  tags: {
    id: { type: 'integer', primaryKey: true, autoIncrement: true },
    name: { type: 'string', unique: true },
  },
  postTags: {
    postId: ref('posts', { onDelete: 'CASCADE' }),
    tagId: ref('tags', { onDelete: 'CASCADE' }),
  },
  // — hierarchy (self-referential) —
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

Some examples also reference generic tables (`products`, `orders`, `sales`, `prices`, `bookings`, `events`) to illustrate specific features — their columns are self-explanatory from context.

---

## 2. Basic Syntax

### Table Scan

```
users
```

Returns all rows and columns from the table.

### Pipe Operators

Chain clauses with `|`:

```
users | where active = true | select id, name | order by name | limit 10
```

### Comments

```
# This is a comment
users | where active = true   # Inline comment
```

---

## 3. WHERE (Filtering)

### Comparison Operators

```
users | where age = 21
users | where name != 'John'
users | where price > 100
users | where price >= 100
users | where stock < 50
users | where remaining <= 10
```

### Pattern Matching

```
users | where name like 'A%'
users | where email like '%@example.com'
```

### BETWEEN

```
products | where price between 100 and 500
```

### IN (Value List)

```
users | where status in ('active', 'pending', 'approved')
users | where id in (1, 2, 3)
```

### IN (Subquery)

```
users | where id in (orders | select userId | where status = 'completed')
```

### NULL Checks

```
users | where email is null
users | where name is not null
```

### Logical Operators

```
# AND
users | where active = true and age > 18

# OR
users | where role = 'admin' or role = 'super'

# NOT
users | where not (deleted = true)

# Parentheses for grouping
users | where (role = 'admin' or role = 'editor') and active = true
```

### Relation Filters

Filter by related records using quantifiers:

```
# SOME — at least one related record matches
users | where some(posts).published = true

# NONE — no related record matches
users | where none(posts).draft = true

# EVERY — all related records match
users | where every(posts).published = true

# With aliases for complex conditions
users | where some(posts as p, p.featured = true and p.published = true)
users | where none(orders as o, o.status = 'cancelled' and o.total > 100)
```

### EXISTS Subquery

```
customers | where exists (orders | where customerId = customers.id)
```

### Range Operators (PostgreSQL)

```
# Overlap
bookings | where period overlaps [2024-01-01,2024-01-31]

# Contains
events | where dateRange contains [2024-06-15,2024-06-15]

# Contained by
events | where dateRange containedBy [2024-01-01,2024-12-31]
```

---

## 4. SELECT (Projection)

### All Columns

```
users | select *
users                    # implicit select *
```

### Specific Columns

```
users | select id, name, email
```

### Aliases

```
products | select name as productName, price as cost
products | select price * 1.1 as priceWithTax
```

### DISTINCT

```
users | select distinct department
comments | select count(distinct authorName)
```

### Arithmetic Expressions

```
products | select price + tax as total
products | select quantity * price as lineTotal
products | select price - discount as finalPrice
products | select total / count as average
products | select amount % 100 as remainder
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
orders | select id, customer.name, customer.email

# Deep nesting
posts | select title, author.name, author.company.industry
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
users | select count(*)
orders | select sum(amount)
orders | select avg(amount)
products | select min(price), max(price)
```

### COUNT DISTINCT

```
orders | select count(distinct customerId) as uniqueCustomers
```

### GROUP BY

```
orders | group by status | select status, count(*) as total
posts | group by authorId | select authorId, count(*), sum(views)
```

### WHERE vs HAVING

Position relative to `group by` determines behavior:

```
# WHERE — filters individual rows (before grouping)
orders | where amount > 100 | group by status | select status, count(*)

# HAVING — filters aggregated groups (after grouping)
orders | group by status | where count(*) > 10 | select status, count(*)
```

---

## 7. ORDER BY, LIMIT, OFFSET

### Sorting

```
users | order by name
users | order by createdAt desc
users | order by lastName asc, firstName asc
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
products | select name, rank() over (partition by category order by price desc) as priceRank
products | select name, dense_rank() over (order by price) as dr
```

### Lag / Lead (Previous / Next Row)

```
prices | select date, price, lag(price) over (order by date) as prevPrice
prices | select date, price, lead(price) over (order by date) as nextPrice
```

### Aggregate Windows

```
sales | select date, amount, sum(amount) over (order by date) as runningTotal
sales | select customerId, sum(amount) over (partition by customerId) as customerTotal
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
insert into products set name = 'iPhone', price = 999

# With RETURNING (pipe to select)
insert into products set name = 'iPhone', price = 999 | select id, name
```

### INSERT FROM (Bulk Copy)

```
# Copy all rows
insert into archivedUsers from users

# With filter
insert into archivedUsers from users where active = false

# With limit
insert into archivedUsers from users limit 100

# With RETURNING
insert into archivedUsers from users where active = false | select id
```

### UPDATE

```
update products set price = 899 where id = 1

# With RETURNING
update users set active = true where id = 1 | select id, active
```

### DELETE

```
delete from products where id = 1
```

### UPSERT

```
# Single conflict column
upsert into users on email set name = 'Alice', email = 'alice@example.com'

# Multiple conflict columns
upsert into events on (userId, eventType) set count = 1
```

### Mutation Chaining with BIND

Chain mutations where the second uses results from the first:

```
insert into orders set customerId = 1 | bind order
insert into orderItems set orderId = order.id, productId = 5
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
users              # unquoted (standard)
"order"            # quoted (reserved keyword)
"user-id"          # quoted (special characters)
"Order Details"    # quoted (spaces)
```

### REPL Dot Commands

In the interactive REPL, dot commands provide schema introspection:

```
.tables              # List all tables
.schema users        # Show table columns
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
| `users` | `orm.select('users').all()` |
| `users \| where active = true` | `orm.select('users').where(eq('active', true))` |
| `users \| select id, name` | `orm.select('users').columns(['id', 'name'])` |
| `users \| select *, posts.*` | `orm.select('users').include('posts')` |
| `users \| order by name desc` | `orm.select('users').orderBy('name', 'desc')` |
| `users \| limit 10` | `orm.select('users').limit(10)` |
| `posts \| group by authorId \| select count(*)` | `orm.select('posts').groupBy(['authorId']).count()` |
| `insert into users set name = 'A'` | `orm.insert('users').values({ name: 'A' }).execute()` |
| `update users set x = 1 where id = 1` | `orm.update('users').set({ x: 1 }).where(eq('id', 1)).execute()` |
| `delete from users where id = 1` | `orm.delete('users').where(eq('id', 1)).execute()` |
