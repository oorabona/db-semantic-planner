---
title: NQL Reference
---

# NQL Reference

NQL (Natural Query Language) is a pipe-based query language that compiles to parameterized SQL. It lets you express queries in a readable, composable syntax without writing SQL directly. Use this reference when you want to explore data interactively in the REPL, write query scripts in `.dbsp` files, or learn the full NQL syntax before embedding queries in your application via the TypeScript API.

> Every example in this document is validated against a live PostgreSQL 17 database
> using the schemas in `examples/`.

## Table of Contents

- [Getting Started](#getting-started)
- [Basic Queries](#basic-queries)
- [Named Parameters and Template Binding](#named-parameters-and-template-binding)
- [Filtering (WHERE)](#filtering-where)
- [Sorting and Pagination](#sorting-and-pagination)
- [Relations and Includes](#relations-and-includes)
- [Aggregates](#aggregates)
- [Window Functions](#window-functions)
- [CASE Expressions](#case-expressions)
- [JSONB Operators](#jsonb-operators)
- [Subqueries](#subqueries)
- [Set Operations](#set-operations)
- [Common Table Expressions (WITH)](#common-table-expressions-with)
- [Hierarchy (Recursive CTE)](#hierarchy-recursive-cte)
- [Range Types](#range-types)
- [Mutations](#mutations)
- [Advanced Features](#advanced-features)
- [REPL Commands](#repl-commands)
- [Quick Reference](#quick-reference)

---

## Getting Started

### Prerequisites

```bash
# Start PostgreSQL container
podman run -d --name pg-demo -p 5432:5432 -e POSTGRES_PASSWORD=demo postgres:17

# Database URL used in all examples
export DB_URL=postgresql://postgres:demo@localhost:5432/demo
```

### Running Examples

NQL queries are executed via the REPL CLI:

```bash
# Interactive REPL
pnpm dbsp repl --schema ./examples/ecommerce.schema.ts --db $DB_URL --exec --casing snake

# Batch mode (execute .dbsp file)
pnpm dbsp repl --schema ./examples/ecommerce.schema.ts --db $DB_URL \
  --input ./examples/ecommerce.dbsp --exec --casing snake

# Validate assertions
pnpm dbsp repl --schema ./examples/ecommerce.schema.ts --db $DB_URL \
  --input ./examples/ecommerce.dbsp --assert ./examples/ecommerce.assert.dbsp \
  --exec --casing snake

# Compile-only (no database needed)
pnpm dbsp repl --schema ./examples/ecommerce.schema.ts \
  --input ./examples/ecommerce.dbsp
```

### Pipe Syntax

NQL uses pipes (`|`) to chain operators, left to right:

```
table | where condition | select columns | order by col | limit N
```

Each operator transforms the query progressively. The final result compiles to a single SQL statement.

### Available Schemas

| Schema | Tables | Key Features |
|--------|--------|--------------|
| `minimal` | users, posts | Simple 1:N, basics |
| `blog` | authors, posts, tags, comments, postTags | M:N, aggregates |
| `blog-extended` | authors, posts, categories, tags, postTags | Hierarchy, ORDER BY |
| `ecommerce` | categories, products, variants, customers, addresses, orders, orderItems | Window functions, complex FKs |
| `hierarchy` | employees | Self-ref, recursive CTE |
| `scheduling` | rooms, events, roomBookings, priceTiers | PostgreSQL range types |
| `pimdam` | categories, products, assets, productImages | Soft-delete, multi-locale |
| `iam` | users, roles, permissions, userRoles, rolePermissions, roleEdges, sodRules, resources, auditLog | JSONB, junction tables, edge hierarchy |
| `test-strategies` | departments, employees, projects, assignments, tasks | All include strategies |

---

## Basic Queries

*Schema: ecommerce*

### Table Scan

The simplest query: just name a table. NQL returns all columns and all rows — the equivalent of `SELECT * FROM table`.

```nql
categories
```

<details><summary>SQL</summary>

```sql
SELECT categories.* FROM ch5_ecommerce.categories
```
</details>

| id | name            | slug            | parent_id | sort_order |
|----|-----------------|-----------------|-----------|------------|
| 1  | Electronics     | electronics     | NULL      | 1          |
| 2  | Clothing        | clothing        | NULL      | 2          |
| 3  | Books           | books           | NULL      | 3          |
| 4  | Computers       | computers       | 1         | 1          |
| 5  | Phones          | phones          | 1         | 2          |
| ...| ...             | ...             | ...       | ...        |

*(20 rows)*

### Select Specific Columns

Without a `| select` pipe, NQL defaults to `SELECT *`. Adding `| select` lets you cherry-pick the columns you need.

```nql
customers
```

<details><summary>SQL</summary>

```sql
SELECT customers.* FROM ch5_ecommerce.customers
```
</details>

| id | email             | first_name | last_name | phone       | created_at               |
|----|-------------------|------------|-----------|-------------|--------------------------|
| 1  | alice@example.com | Alice      | Johnson   | +1-555-0101 | 2024-01-01T09:00:00.000Z |
| 2  | bob@example.com   | Bob        | Smith     | +1-555-0102 | 2024-01-01T09:00:00.000Z |
| 3  | carol@example.com | Carol      | Williams  | NULL        | 2024-01-02T10:00:00.000Z |
| 4  | david@example.com | David      | Brown     | +1-555-0104 | 2024-01-03T11:00:00.000Z |
| 5  | emma@example.com  | Emma       | Davis     | +1-555-0105 | 2024-01-04T12:00:00.000Z |

---

## Named Parameters and Template Binding

NQL supports named value parameters in expression positions. A named parameter is written as `:name` in the query text and resolved from the compiler `params` map. Use it for values only: comparison right-hand sides, `IN` lists, function arguments, `BETWEEN`, `CASE` results, JSON/range value operands, and `limit`/`offset`. Identifiers, table names, column names, directions, lock modes, and traversal hints remain query structure.

```typescript
// doctest: skip — illustrative direct compiler params example
import { createPgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';
import { compile } from '@dbsp/nql';

const compiled = compile('users | where id = :id and active = :active', db.model, undefined, {
  params: { id: 42, active: true },
});

if (!compiled.success || !compiled.ast?.query) {
  throw new Error(compiled.errors.map((e) => e.message).join(', '));
}

const adapter = createPgsqlCompileOnlyAdapter();
const query = adapter.compile(compiled.ast, { model: db.model });
```

Resolution uses own properties on the params object. `{ p: null }` binds SQL `NULL`; a missing `p` fails compilation; `{ p: undefined }`, `NaN`, and `Infinity` are rejected. `Date` and `BigInt` values are passed through to the adapter. Parameter names `__proto__`, `constructor`, and `prototype` are rejected.

When using the TypeScript `orm.nql` template tag, every non-raw interpolation is converted to an internal generated parameter named `:__p0`, `:__p1`, and so on. Numbering counts bound interpolations only, in template order. `nqlRaw()` fragments do not allocate a generated parameter and do not shift the mapping.

```typescript
// doctest: skip — illustrative ORM tag params example
import { nqlRaw } from '@dbsp/core';

const ids = [1, 2, 3];
const rows = await orm.nql<PostRow>`posts
  | where id = ANY(${ids})
  | ${nqlRaw('order by createdAt desc')}
  | limit ${10}
`.all();
```

The `__p` namespace is reserved for the tag implementation. User-authored `:__p0` source, `params` keys beginning with `__p`, or raw fragments that contain `:__p0` are rejected. Use your own names, such as `:id` or `:status`, for direct compiler parameters.

`nqlRaw(fragment)` is a trusted-fragment escape hatch. It splices the fragment verbatim into NQL source before parsing, so never pass untrusted input to it. Plain strings are always bound as values; they never become query structure.

Migration from earlier tag interpolation is behavior-compatible for strings, numbers, booleans, and `null`, but values now appear in `dump().params` instead of being escaped into NQL source. Arrays are newly supported for patterns such as `ANY(${ids})`; `limit ${n}` and `offset ${n}` continue to work through integer validation.

---

## Filtering (WHERE)

### Equality

*Schema: ecommerce*

Filter rows by exact match. Values are always parameterized (`$1`, `$2`, ...) — never interpolated into SQL.

```nql
products | where active = true | limit 5
```

<details><summary>SQL</summary>

```sql
SELECT products.*
FROM ch5_ecommerce.products
WHERE products.active = $1
LIMIT 5
-- params: [true]
```
</details>

| id | sku           | name            | description                               | price   | stock | category_id | active | created_at               |
|----|---------------|-----------------|-------------------------------------------|---------|-------|-------------|--------|--------------------------|
| 1  | LAPTOP-001    | ProBook 15      | High-performance laptop for professionals | 1299.99 | 50    | 11          | true   | 2024-01-01T08:00:00.000Z |
| 2  | LAPTOP-002    | UltraLight 13   | Lightweight laptop for travel             | 999.99  | 30    | 11          | true   | 2024-01-01T08:00:00.000Z |
| 3  | PHONE-001     | SmartPhone X    | Latest flagship smartphone                | 899.99  | 100   | 13          | true   | 2024-01-01T08:00:00.000Z |
| 4  | PHONE-002     | SmartPhone SE   | Budget-friendly smartphone                | 449.99  | 200   | 13          | true   | 2024-01-01T08:00:00.000Z |
| 5  | HEADPHONE-001 | NoiseCancel Pro | Premium noise-canceling headphones        | 349.99  | 75    | 14          | true   | 2024-01-01T08:00:00.000Z |

### NULL Checks

*Schema: iam*

In a resource tree, root entries have no parent. NQL uses `is null` / `is not null` — compiled to SQL's `IS NULL`, never `= NULL`.

```nql
resources | where parentId is null
```

<details><summary>SQL</summary>

```sql
SELECT resources.*
FROM iam_example.resources
WHERE resources.parent_id IS NULL
```
</details>

| id | name | type   | parent_id |
|----|------|--------|-----------|
| 1  | Root | folder | NULL      |

*(1 row)*

### Comparison Operators

*Schema: blog-extended*

All standard comparison operators are supported: `>`, `<`, `>=`, `<=`, `!=`. NQL compiles them directly to their SQL equivalents.

```nql
posts | where viewCount > 1000
```

<details><summary>SQL</summary>

```sql
SELECT posts.*
FROM ch3_blog_extended.posts
WHERE posts.view_count > $1
-- params: [1000]
```
</details>

| id | title                  | featured | view_count | published |
|----|------------------------|----------|------------|-----------|
| 1  | TypeScript Fundamentals| True     | 1500       | True      |
| 3  | PostgreSQL Deep Dive   | True     | 2000       | True      |

*(2 rows)*

### AND / OR

Combine multiple conditions with `and` / `or`. NQL preserves operator precedence and compiles to standard SQL boolean logic.

```nql
posts | where featured = true and viewCount > 1500
```

<details><summary>SQL</summary>

```sql
SELECT posts.*
FROM ch3_blog_extended.posts
WHERE posts.featured = $1 AND posts.view_count > $2
-- params: [true, 1500]
```
</details>

| id | title                | featured | view_count |
|----|----------------------|----------|------------|
| 3  | PostgreSQL Deep Dive | True     | 2000       |

*(1 row)*

### BETWEEN

*Schema: test-strategies*

Range filtering made readable. `BETWEEN` is inclusive on both ends — equivalent to `>= AND <=`.

```nql
employees | where salary between 50000 and 100000
```

<details><summary>SQL</summary>

```sql
SELECT employees.*
FROM test_strategies.employees
WHERE employees.salary BETWEEN $1 AND $2
-- params: [50000, 100000]
```
</details>

| id | name  | salary | department_id | active |
|----|-------|--------|---------------|--------|
| 2  | Bob   | 85000  | 1             | True   |
| 3  | Carol | 95000  | 2             | True   |
| 5  | Eve   | 60000  | 3             | True   |

*(3 rows)*

### LIKE

Pattern matching with `%` (any characters) and `_` (single character). The pattern is parameterized — no SQL injection risk.

```nql
employees | where name like 'A%'
```

<details><summary>SQL</summary>

```sql
SELECT employees.*
FROM test_strategies.employees
WHERE employees.name LIKE $1
-- params: ["A%"]
```
</details>

| id | name  | salary | department_id | active |
|----|-------|--------|---------------|--------|
| 1  | Alice | 120000 | 1             | True   |

*(1 row)*

### IN (Value List)

Check membership against a list of values. Each value becomes a separate parameter.

```nql
employees | where departmentId in (1, 2, 3)
```

<details><summary>SQL</summary>

```sql
SELECT employees.*
FROM test_strategies.employees
WHERE employees.department_id IN ($1, $2, $3)
-- params: [1, 2, 3]
```
</details>

| id | name  | salary | department_id | active |
|----|-------|--------|---------------|--------|
| 1  | Alice | 120000 | 1             | True   |
| 2  | Bob   | 85000  | 1             | True   |
| 3  | Carol | 95000  | 2             | True   |
| 4  | Dave  | 45000  | 2             | True   |
| 5  | Eve   | 60000  | 3             | True   |
| 6  | Frank | 30000  | 3             | False  |

*(6 rows)*

### NOT IN

Exclusion filter — returns rows whose value is not in the given list.

```nql
employees | where departmentId not in (4, 5)
```

<details><summary>SQL</summary>

```sql
SELECT employees.*
FROM test_strategies.employees
WHERE employees.department_id NOT IN ($1, $2)
-- params: [4, 5]
```
</details>

| id | name  | salary | department_id | active |
|----|-------|--------|---------------|--------|
| 1  | Alice | 120000 | 1             | True   |
| 2  | Bob   | 85000  | 1             | True   |
| 3  | Carol | 95000  | 2             | True   |
| 4  | Dave  | 45000  | 2             | True   |
| 5  | Eve   | 60000  | 3             | True   |
| 6  | Frank | 30000  | 3             | False  |

*(6 rows)*

---

## Sorting and Pagination

*Schema: blog-extended*

### ORDER BY

Sort results by any column. Defaults to `asc`; specify `desc` for descending order.

```nql
posts | order by viewCount desc
```

<details><summary>SQL</summary>

```sql
SELECT posts.*
FROM ch3_blog_extended.posts
ORDER BY posts.view_count DESC
```
</details>

| id | title                   | view_count | published |
|----|-------------------------|------------|-----------|
| 3  | PostgreSQL Deep Dive    | 2000       | True      |
| 1  | TypeScript Fundamentals | 1500       | True      |
| 2  | Advanced TypeScript     | 800        | True      |
| 4  | MongoDB vs PostgreSQL   | 600        | True      |
| 5  | Work-Life Balance       | 300        | True      |
| 8  | Inactive Author Post    | 50         | True      |
| 6  | Draft: React Patterns   | 0          | False     |
| 7  | Draft: Redis Caching    | 0          | False     |

*(8 rows)*

### ORDER BY with LIMIT

Combine sorting and pagination for "top-N" queries. Pipe chaining makes the intent clear: sort first, then take the top 3.

```nql
posts | order by viewCount desc | limit 3
```

<details><summary>SQL</summary>

```sql
SELECT posts.*
FROM ch3_blog_extended.posts
ORDER BY posts.view_count DESC
LIMIT 3
```
</details>

| id | title                   | view_count |
|----|-------------------------|------------|
| 3  | PostgreSQL Deep Dive    | 2000       |
| 1  | TypeScript Fundamentals | 1500       |
| 2  | Advanced TypeScript     | 800        |

*(3 rows)*

### LIMIT and OFFSET

*Schema: minimal*

Standard pagination: `limit N` restricts the result set, `offset N` skips rows. Combine both for cursor-based paging.

```nql
posts | limit 10
posts | limit 10 | offset 20
```

<details><summary>SQL</summary>

```sql
SELECT posts.* FROM posts LIMIT 10
SELECT posts.* FROM posts LIMIT 10 OFFSET 20
```
</details>

---

## Relations and Includes

NQL supports three include strategies, automatically chosen by the planner.

### json_agg (Default — Nested JSON)

*Schema: ecommerce*

Including related data is NQL's strongest feature. Just use dotted syntax: `relation.*`. The planner uses `json_agg` by default, embedding related rows as a JSON array — one parent row = one result row, no duplication.

If you prefer flat, denormalized rows (one row per parent-child combination), append `| flat` to switch to a LEFT JOIN strategy instead. See the [flat (LEFT JOIN)](#flat-left-join) section below.

```nql
customers | select *, orders.*
```

<details><summary>SQL</summary>

```sql
SELECT customers.*,
  COALESCE(
    (SELECT json_agg(to_jsonb(__t__))
     FROM ch5_ecommerce.orders AS __t__
     WHERE __t__.customer_id = customers.id),
    '[]'::json
  ) AS orders_json
FROM ch5_ecommerce.customers
```
</details>

Each customer row contains an `orders_json` array with all their orders as nested JSON.

| id | email             | first_name | last_name | orders_json |
|----|-------------------|------------|-----------|-------------|
| 1  | alice@example.com | Alice      | Johnson   | [{"id":1,"total":1499.98,"status":"delivered",...},{"id":3,...}] |
| 2  | bob@example.com   | Bob        | Smith     | [{"id":2,"total":349.99,"status":"shipped",...},{"id":7,...}] |
| 3  | carol@example.com | Carol      | Williams  | [{"id":4,"total":999.99,"status":"pending",...}] |
| 4  | david@example.com | David      | Brown     | [{"id":5,"total":179.97,"status":"delivered",...}] |
| 5  | emma@example.com  | Emma       | Davis     | [{"id":6,"total":1099.98,"status":"shipped",...}] |

### flat (LEFT JOIN)

When you need denormalized rows (for CSV export, spreadsheets, or tools that don't handle nested JSON), append `| flat`. The planner switches from `json_agg` to a standard LEFT JOIN — one row per parent-child combination.

```nql
categories | select *, products.* | flat
```

<details><summary>SQL</summary>

```sql
SELECT categories.*, products.*
FROM ch5_ecommerce.categories
LEFT JOIN ch5_ecommerce.products AS products
  ON categories.id = products.category_id
```
</details>

| id | name          | slug          | parent_id | sku         | price   | category_id |
|----|---------------|---------------|-----------|-------------|---------|-------------|
| 11 | Laptops       | laptops       | 4         | LAPTOP-001  | 1299.99 | 11          |
| 11 | Laptops       | laptops       | 4         | LAPTOP-002  | 999.99  | 11          |
| 13 | Smartphones   | smartphones   | 5         | PHONE-001   | 899.99  | 13          |
| 13 | Smartphones   | smartphones   | 5         | PHONE-002   | 449.99  | 13          |
| ...| ...           | ...           | ...       | ...         | ...     | ...         |

*(24 rows)*

### Per-Include LIMIT (LATERAL)

*Schema: iam*

To limit the number of related rows *per parent*, use `| limit relation N`. This forces a LATERAL subquery — PostgreSQL's way of saying "for each parent row, run this subquery with a LIMIT".

```nql
users | select *, userRoles.* | limit userRoles 2
```

<details><summary>SQL</summary>

```sql
SELECT users.*, user_roles_lat_0.*
FROM iam_example.users
LEFT JOIN LATERAL (
  SELECT user_roles_inner_0.*
  FROM iam_example.user_roles AS user_roles_inner_0
  WHERE user_roles_inner_0.user_id = users.id
  LIMIT 2
) AS user_roles_lat_0 ON true
```
</details>

| id | username | email              | active | user_id | role_id | granted_at               |
|----|----------|--------------------|--------|---------|---------|--------------------------|
| 1  | alice    | alice@example.com  | True   | 1       | 1       | 2025-01-01T00:00:00.000Z |
| 2  | bob      | bob@example.com    | True   | 2       | 2       | 2025-01-15T00:00:00.000Z |
| 3  | carol    | carol@example.com  | True   | 3       | 3       | 2025-02-01T00:00:00.000Z |
| 3  | carol    | carol@example.com  | True   | 3       | 6       | 2025-02-01T00:00:00.000Z |
| 4  | dave     | dave@example.com   | True   | 4       | 4       | 2025-03-01T00:00:00.000Z |
| 5  | eve      | eve@example.com    | True   | 5       | 5       | 2025-03-15T00:00:00.000Z |
| 6  | frank    | frank@example.com  | False  | 6       | 8       | 2025-04-01T00:00:00.000Z |
| 6  | frank    | frank@example.com  | False  | 6       | 9       | 2025-04-01T00:00:00.000Z |

*(8 rows — each user has at most 2 role assignments)*

### Deep Nesting (Multi-Level Traversal)

*Schema: iam*

Use dotted paths to traverse multiple levels of relations in a single query. The planner resolves the full chain and nests the results as JSON arrays.

```nql
users | where active = true \
  | select *, userRoles.roleId, userRoles.role.rolePermissions.permission.*
```

<details><summary>SQL</summary>

```sql
SELECT users.*,
  COALESCE((SELECT json_agg(to_jsonb(__t__))
    FROM iam_example.user_roles AS __t__
    WHERE __t__.user_id = users.id), '[]'::json) AS user_roles_json
FROM iam_example.users
WHERE users.active = $1
-- params: [true]
```
</details>

| id | username | email              | active | userRoles_json                                         |
|----|----------|--------------------|--------|--------------------------------------------------------|
| 1  | alice    | alice@example.com  | True   | [{"id":1,"role":[{"id":1,"name":"super_admin",...}]}]  |
| 2  | bob      | bob@example.com    | True   | [{"id":2,"role":[{"id":2,"name":"admin",...}]}]        |
| 3  | carol    | carol@example.com  | True   | [{"id":3,"role":[{"id":3,"name":"manager",...}]},...]  |
| 4  | dave     | dave@example.com   | True   | [{"id":5,"role":[{"id":4,"name":"editor",...}]}]       |
| 5  | eve      | eve@example.com    | True   | [{"id":6,"role":[{"id":5,"name":"viewer",...}]}]       |

*(5 rows — the planner traverses: users → userRoles → roles → rolePermissions → permissions)*

### M:N Relations (Junction Tables)

*Schema: blog*

Many-to-many relations work with the same `relation.*` syntax. The planner detects the junction table automatically and generates the correct JOIN path (posts → postTags → tags).

```nql
posts | select *, tags.*
```

<details><summary>SQL</summary>

```sql
SELECT posts.*,
  COALESCE(
    (SELECT json_agg(to_jsonb(__t__))
     FROM ch2_blog.tags AS __t__
     INNER JOIN ch2_blog.post_tags ON __t__.id = post_tags.tag_id
     WHERE post_tags.post_id = posts.id),
    '[]'::json
  ) AS tags_json
FROM ch2_blog.posts
```
</details>

| id | title                           | published | tags_json                           |
|----|---------------------------------|-----------|-------------------------------------|
| 1  | Getting Started with PostgreSQL | True      | [{"id":1,"name":"postgresql"},...]  |
| 2  | TypeScript Best Practices 2024  | True      | [{"id":2,"name":"typescript"},...]  |
| 3  | Query Optimization Techniques   | True      | [{"id":1,"name":"postgresql"},...]  |
| 4  | Introduction to Range Types     | True      | [{"id":1,"name":"postgresql"},...]  |
| 5  | Draft: Advanced Indexing        | False     | [{"id":1,"name":"postgresql"},...]  |
| 6  | Why Type Safety Matters         | True      | [{"id":2,"name":"typescript"},...]  |

*(6 rows)*

### Edge Tables (Dual-FK)

*Schema: iam*

When a table has two foreign keys pointing to the same target (like a role hierarchy edge table), the schema disambiguates via named references. NQL resolves each FK independently.

```nql
roleEdges | select *, parentRole.*, childRole.*
```

<details><summary>SQL</summary>

```sql
SELECT role_edges.*,
  COALESCE((SELECT json_agg(to_jsonb(__t__)) FROM iam_example.roles AS __t__
    WHERE __t__.id = role_edges.parent_role_id), '[]'::json) AS parent_role_json,
  COALESCE((SELECT json_agg(to_jsonb(__t__)) FROM iam_example.roles AS __t__
    WHERE __t__.id = role_edges.child_role_id), '[]'::json) AS child_role_json
FROM iam_example.role_edges
```
</details>

| id | parent_role_id | child_role_id | parentRole_json                  | childRole_json                  |
|----|---------------|---------------|----------------------------------|---------------------------------|
| 1  | 1             | 2             | [{"name":"super_admin",...}]     | [{"name":"admin",...}]          |
| 2  | 2             | 3             | [{"name":"admin",...}]           | [{"name":"manager",...}]        |
| 3  | 3             | 4             | [{"name":"manager",...}]         | [{"name":"editor",...}]         |
| 4  | 4             | 5             | [{"name":"editor",...}]          | [{"name":"viewer",...}]         |
| 5  | 2             | 6             | [{"name":"admin",...}]           | [{"name":"auditor",...}]        |
| 6  | 1             | 7             | [{"name":"super_admin",...}]     | [{"name":"support_admin",...}]  |
| 7  | 8             | 9             | [{"name":"approver",...}]        | [{"name":"requester",...}]      |

*(7 rows)*

---

## Aggregates

### GROUP BY with COUNT

*Schema: ecommerce*

Aggregate functions combine with `group by` for per-group statistics. Here we count orders per customer.

```nql
orders | group by customerId | select count(*)
```

<details><summary>SQL</summary>

```sql
SELECT count(*)
FROM ch5_ecommerce.orders
GROUP BY orders.customer_id
```
</details>

| count |
|-------|
| 1     |
| 2     |
| 1     |
| 2     |
| 1     |

### SUM

Revenue breakdown by order status. All standard aggregate functions (`sum`, `avg`, `min`, `max`, `count`) work identically.

```nql
orders | group by status | select sum(total)
```

<details><summary>SQL</summary>

```sql
SELECT sum(orders.total)
FROM ch5_ecommerce.orders
GROUP BY orders.status
```
</details>

| sum     |
|---------|
| 999.99  |
| 1679.95 |
| 449.99  |
| 94.98   |
| 1449.97 |

### AVG

Without `group by`, the aggregate runs over all rows — here, the average order total across the entire table.

```nql
orders | select avg(total)
```

<details><summary>SQL</summary>

```sql
SELECT avg(orders.total) FROM ch5_ecommerce.orders
```
</details>

| avg                  |
|----------------------|
| 667.8400000000000000 |

### Named Aggregate Columns

*Schema: iam*

Use `as alias` to name aggregate columns. NQL applies the project's naming convention (here, camelCase → snake_case) to the alias automatically.

```nql
userRoles | group by roleId | select roleId, count(*) as userCount
```

<details><summary>SQL</summary>

```sql
SELECT user_roles.role_id, count(*) AS user_count
FROM iam_example.user_roles
GROUP BY user_roles.role_id
```
</details>

| role_id | user_count |
|---------|------------|
| 1       | 1          |
| 2       | 1          |
| 3       | 1          |
| 4       | 1          |
| 5       | 1          |
| 6       | 1          |
| 8       | 1          |
| 9       | 1          |

*(8 rows)*

### DISTINCT

*Schema: blog*

Deduplicate rows with `select distinct *`, or count unique values with `count(distinct col)`. Both compile to their SQL equivalents.

```nql
posts | select distinct *
comments | where approved = true | select count(distinct authorName)
```

<details><summary>SQL</summary>

```sql
SELECT DISTINCT posts.* FROM ch2_blog.posts
SELECT count(DISTINCT comments.author_name)
  FROM ch2_blog.comments WHERE comments.approved = $1
```
</details>

`posts | select distinct *` returns all 6 posts (already unique by primary key).

`count(distinct authorName)`:

| count |
|-------|
| 6     |

*(1 row)*

---

## Window Functions

*Schema: ecommerce*

### RANK with PARTITION BY

Rank products by price within each category. `PARTITION BY` creates independent ranking groups — NQL mirrors the SQL window function syntax exactly.

```nql
products | select *, rank() over (partition by categoryId order by price desc) as priceRank
```

<details><summary>SQL</summary>

```sql
SELECT products.*,
  rank() OVER (PARTITION BY products.category_id ORDER BY products.price DESC) AS price_rank
FROM ch5_ecommerce.products
```
</details>

| id | sku        | name          | price   | category_id | price_rank |
|----|------------|---------------|---------|-------------|------------|
| 1  | LAPTOP-001 | ProBook 15    | 1299.99 | 11          | 1          |
| 2  | LAPTOP-002 | UltraLight 13 | 999.99  | 11          | 2          |
| 13 | DESKTOP-001| PowerStation  | 2499.99 | 12          | 1          |
| 14 | PHONE-003  | SmartPhone Max| 1099.99 | 13          | 1          |
| 3  | PHONE-001  | SmartPhone X  | 899.99  | 13          | 2          |
| ...| ...        | ...           | ...     | ...         | ...        |

### Running Total (SUM OVER)

A cumulative sum across ordered rows. The `OVER` clause without `PARTITION BY` treats the entire result set as one window, accumulating the total chronologically.

```nql
orders | select orderNumber, total, sum(total) over (order by createdAt) as runningTotal
```

<details><summary>SQL</summary>

```sql
SELECT orders.order_number, orders.total,
  sum(orders.total) OVER (ORDER BY orders.created_at) AS running_total
FROM ch5_ecommerce.orders
```
</details>

| order_number | total   | running_total |
|--------------|---------|---------------|
| ORD-2024-001 | 1499.98 | 1499.98       |
| ORD-2024-005 | 179.97  | 1679.95       |
| ORD-2024-002 | 349.99  | 2029.94       |
| ORD-2024-003 | 94.98   | 2124.92       |
| ORD-2024-004 | 999.99  | 3124.91       |
| ORD-2024-006 | 1099.98 | 4224.89       |
| ORD-2024-007 | 449.99  | 4674.88       |

### Available Window Functions

| Function | Description |
|----------|-------------|
| `rank()` | Rank with gaps for ties |
| `dense_rank()` | Rank without gaps |
| `row_number()` | Sequential numbering |
| `lag(col [, offset [, default]])` | Previous row value |
| `lead(col [, offset [, default]])` | Next row value |
| `sum(col) over (...)` | Running sum |
| `count(col) over (...)` | Running count |
| `avg(col) over (...)` | Running average |

---

## CASE Expressions

*Schema: test-strategies*

### Searched CASE

Classify employees by salary band. CASE WHEN evaluates conditions top-down and returns the first match — WHEN clauses support the full WHERE operator set (AND, OR, IN, BETWEEN, IS NULL...).

```nql
employees | select name, \
  case when salary > 80000 then 'senior' \
       when salary > 50000 then 'mid' \
       else 'junior' end as level
```

<details><summary>SQL</summary>

```sql
SELECT employees.name,
  CASE WHEN employees.salary > $1 THEN $2
       WHEN employees.salary > $3 THEN $4
       ELSE $5
  END AS level
FROM test_strategies.employees
-- params: [80000, "senior", 50000, "mid", "junior"]
```
</details>

| name  | level  |
| ---   | ---    |
| Alice | senior |
| Bob   | senior |
| Carol | senior |
| Dave  | junior |
| Eve   | mid    |
| Frank | junior |

### Simple CASE

Map a column's values to labels. Simple CASE (`case col when val`) is a shorthand — NQL normalizes it to searched CASE during compilation.

```nql
employees | select name, \
  case departmentId when 1 then 'Engineering' \
                    when 2 then 'Marketing' \
                    else 'Other' end as dept
```

Simple CASE is normalized to searched CASE during compilation.

| name  | dept        |
| ---   | ---         |
| Alice | Engineering |
| Bob   | Engineering |
| Carol | Marketing   |
| Dave  | Marketing   |
| Eve   | Other       |
| Frank | Other       |
| Jane  | Engineering |

> **Note:** 7 rows — Jane was inserted by a prior upsert in the test-strategies batch.

---

## JSONB Operators

*Schema: iam* — The `audit_log.details` column is JSONB.

### Text Extraction (`->>`)

Filter on a specific field inside a JSONB column. The `->>` operator extracts the value as text, so it can be compared with `=`.

```nql
auditLog | where details ->> 'ip' = '10.0.0.1'
```

<details><summary>SQL</summary>

```sql
SELECT audit_log.*
FROM iam_example.audit_log
WHERE (audit_log.details ->> $1) = $2
-- params: ["ip", "10.0.0.1"]
```
</details>

| id | user_id | action | resource | timestamp                | details            |
|----|---------|--------|----------|--------------------------|--------------------|
| 1  | 1       | login  | system   | 2025-06-01T08:00:00.000Z | {"ip": "10.0.0.1"} |

*(1 row)*

### JSON Field Access (`->`)

Unlike `->>` which returns text, `->` preserves the JSON type — useful when the extracted value is itself an object or array, or when you need JSON-typed output.

```nql
auditLog | where action = 'login' | select id, action, details -> 'ip' as ipJson
```

<details><summary>SQL</summary>

```sql
SELECT audit_log.id, audit_log.action,
  audit_log.details -> $1 AS ip_json
FROM iam_example.audit_log
WHERE audit_log.action = $2
-- params: ["ip", "login"]
```
</details>

| id | action | ip_json    |
|----|--------|------------|
| 1  | login  | "10.0.0.1" |
| 2  | login  | "10.0.0.2" |
| 5  | login  | "10.0.0.3" |
| 8  | login  | "10.0.0.5" |

### Containment (`@>`)

Check if a JSONB column contains a given structure. This is GIN-index friendly and ideal for filtering on nested JSON without extracting individual fields.

```nql
auditLog | where details @> '{"ip": "10.0.0.1"}'
```

<details><summary>SQL</summary>

```sql
SELECT audit_log.*
FROM iam_example.audit_log
WHERE audit_log.details @> $1
-- params: ["{\"ip\": \"10.0.0.1\"}"]
```
</details>

| id | user_id | action | resource | timestamp                | details            |
|----|---------|--------|----------|--------------------------|--------------------|
| 1  | 1       | login  | system   | 2025-06-01T08:00:00.000Z | {"ip": "10.0.0.1"} |

*(1 row)*

### Key Existence (`?`)

Check whether a key exists in the JSONB object — without caring about its value. Useful for schema-flexible columns where not all rows have the same keys.

```nql
auditLog | where details ? 'ip'
```

<details><summary>SQL</summary>

```sql
SELECT audit_log.*
FROM iam_example.audit_log
WHERE audit_log.details ? $1
-- params: ["ip"]
```
</details>

| id | user_id | action | resource | timestamp                | details            |
|----|---------|--------|----------|--------------------------|--------------------|
| 1  | 1       | login  | system   | 2025-06-01T08:00:00.000Z | {"ip": "10.0.0.1"} |
| 2  | 2       | login  | system   | 2025-06-01T08:30:00.000Z | {"ip": "10.0.0.2"} |
| 5  | 3       | login  | system   | 2025-06-01T10:00:00.000Z | {"ip": "10.0.0.3"} |
| 8  | 5       | login  | system   | 2025-06-01T11:30:00.000Z | {"ip": "10.0.0.5"} |

*(4 rows — only login entries have an `ip` key in their details)*

### All JSONB Operators

| Operator | Description | Example |
|----------|-------------|---------|
| `->` | Get JSON field (returns JSON) | `details -> 'key'` |
| `->>` | Get JSON field (returns text) | `details ->> 'key'` |
| `@>` | Contains | `details @> '{"k":"v"}'` |
| `<@` | Contained by | `details <@ '{"k":"v"}'` |
| `?` | Key exists | `details ? 'key'` |
| `#>` | Path access (returns JSON) | `details #> '["a","b"]'` |
| `#>>` | Path access (returns text) | `details #>> '["a","b"]'` |

---

## Subqueries

### IN Subquery

*Schema: iam*

Use a subquery to filter dynamically. Here, we find roles assigned to user 1 by first selecting their role IDs from the junction table. NQL compiles the inner pipe to a subquery using `= ANY(...)`.

```nql
roles | where id in (userRoles | where userId = 1 | select roleId)
```

<details><summary>SQL</summary>

```sql
SELECT roles.*
FROM iam_example.roles
WHERE roles.id = ANY (
  SELECT user_roles_subq_0.role_id
  FROM iam_example.user_roles AS user_roles_subq_0
  WHERE user_roles_subq_0.user_id = $1
)
-- params: [1]
```
</details>

| id | name        | description                        | active |
|----|-------------|------------------------------------|--------|
| 1  | super_admin | Super administrator with all access| True   |

*(1 row)*

### Relation Filter (Implicit EXISTS)

*Schema: test-strategies*

Filter a parent table based on a condition on its children — NQL detects the cross-table reference and generates an `EXISTS` subquery automatically. No explicit subquery syntax needed.

```nql
departments | where employees.active = true
```

<details><summary>SQL</summary>

```sql
SELECT departments.*
FROM test_strategies.departments
WHERE EXISTS (
  SELECT 1 FROM test_strategies.employees AS employees_exists_0
  WHERE departments.id = employees_exists_0.department_id
    AND employees_exists_0.active = $1
)
-- params: [true]
```
</details>

| id | name     | org_id | budget |
|----|----------|--------|--------|
| 1  | Backend  | 2      | 500000 |
| 2  | Frontend | 2      | 300000 |
| 3  | Outbound | 3      | 200000 |

*(3 rows — only departments that have at least one active employee)*

---

## Set Operations

*Schema: iam*

Combine the results of two queries with `union`, `intersect`, `except`, or `union all`. Both sides must select the same columns. The right-hand query is wrapped in parentheses.

### UNION (Deduplicated)

Merge two result sets, removing duplicates:

```nql
users | where active = true | select id, username \
  | union (users | where active = false | select id, username)
```

<details><summary>SQL</summary>

```sql
(SELECT users.id, users.username
 FROM iam_example.users
 WHERE users.active = $1)
UNION
(SELECT users.id, users.username
 FROM iam_example.users
 WHERE users.active = $2)
-- params: [true, false]
```
</details>

| id | username |
|----|----------|
| 1  | alice    |
| 2  | bob      |
| 3  | carol    |
| 4  | dave     |
| 5  | eve      |
| 6  | frank    |

*(6 rows — all users from both sets, duplicates removed)*

### INTERSECT

Keep only rows that appear in *both* result sets:

```nql
users | where active = true | select id, username \
  | intersect (users | select id, username)
```

<details><summary>SQL</summary>

```sql
(SELECT users.id, users.username
 FROM iam_example.users
 WHERE users.active = $1)
INTERSECT
(SELECT users.id, users.username
 FROM iam_example.users)
-- params: [true]
```
</details>

| id | username |
|----|----------|
| 1  | alice    |
| 2  | bob      |
| 3  | carol    |
| 4  | dave     |
| 5  | eve      |

*(5 rows — active users that exist in the full users table)*

### EXCEPT

Rows from the left set that do *not* appear in the right set:

```nql
users | where active = true | select id, username \
  | except (users | where active = false | select id, username)
```

<details><summary>SQL</summary>

```sql
(SELECT users.id, users.username
 FROM iam_example.users
 WHERE users.active = $1)
EXCEPT
(SELECT users.id, users.username
 FROM iam_example.users
 WHERE users.active = $2)
-- params: [true, false]
```
</details>

| id | username |
|----|----------|
| 1  | alice    |
| 2  | bob      |
| 3  | carol    |
| 4  | dave     |
| 5  | eve      |

*(5 rows — active users minus inactive users)*

### UNION ALL (Preserve Duplicates)

Like `UNION` but keeps duplicate rows:

```nql
userRoles | where roleId = 1 | select userId, roleId \
  | union all (userRoles | where roleId = 2 | select userId, roleId)
```

<details><summary>SQL</summary>

```sql
(SELECT user_roles.user_id, user_roles.role_id
 FROM iam_example.user_roles
 WHERE user_roles.role_id = $1)
UNION ALL
(SELECT user_roles.user_id, user_roles.role_id
 FROM iam_example.user_roles
 WHERE user_roles.role_id = $2)
-- params: [1, 2]
```
</details>

| user_id | role_id |
|---------|---------|
| 1       | 1       |
| 2       | 2       |

*(2 rows — all assignments for roles 1 and 2, duplicates preserved)*

**Notes:**
- Both sides must `select` the same number of columns with compatible types
- Set operations can be chained: `a | union (b) | except (c)`
- `UNION` deduplicates; `UNION ALL` keeps all rows (faster for large result sets)

---
---

## Common Table Expressions (WITH)

The `with` keyword defines named subqueries (CTEs) that can be referenced in the main query.

```
with name as (query) mainQuery
```

### Single CTE

```nql
with active_users as (users | where active = true | select id, username)
active_users | select *
```

### Multiple CTEs

```nql
with
  active_users as (users | where active = true),
  granted_roles as (userRoles | where grantedAt > '2026-01-01')
granted_roles | where userId in (active_users | select id)
```

### CTE with pipe clauses

CTE bodies support all standard pipe clauses: `where`, `select`, `order by`, `limit`, `offset`:

```nql
with recent_users as (users | where active = true | order by createdAt desc | limit 5)
recent_users | select username, createdAt
```

### Notes

- CTE names are reserved: they act as table references in the outer query
- Duplicate CTE names are a semantic error
- Set operations (`| union`, `| intersect`, `| except`) inside CTE bodies are not supported in v1
- `with` is now a **reserved keyword** — identifiers named `with` require quoting

## Hierarchy (Recursive CTE)

*Schema: hierarchy*

The `employees` table has a self-referencing `managerId` column. The schema defines
pseudo-columns for traversal: `manager` (parent), `managementChain` (ancestors),
`allReports` (descendants).

### Single-Level Traversal

Navigate one level up the hierarchy with the `manager` pseudo-column.

> **Known limitation:** Pseudo-column traversal (`manager.name`) is not yet compiled to SQL by NQL — only direct columns are returned. The auto-emitted LEFT JOIN self-join is planned.
>
> **Workaround (today):** use the ORM with `.include('manager')` to hydrate the parent row, or write the self-join explicitly via the raw SQL escape hatch:
>
> ```typescript
> // doctest: skip — illustrative ORM workaround for pseudo-column traversal
> const employees = await orm.select('employees')
>   .columns(['name', 'title'])
>   .include('manager', { columns: ['name'] })  // hydrates row.manager.name
>   .all();
> ```

```nql
employees | select name, title, manager.name
```

<details><summary>SQL (current — traversal columns omitted)</summary>

```sql
SELECT employees.name, employees.title
FROM hierarchy.employees
```
</details>

| name  | title                |
| ---   | ---                  |
| Alice | CEO                  |
| Bob   | VP Engineering       |
| Carol | VP Product           |
| Dave  | Engineering Director |
| Eve   | Product Director     |
| Frank | Senior Engineer      |
| Grace | Engineer             |
| Heidi | Designer             |

### Multi-Level Traversal (Skip-Level)

Chain the pseudo-column to jump multiple levels: `manager.manager` goes two levels up. The planner generates two sequential self-JOINs.

```nql
employees | select name, manager.name, manager.manager.name
```

### Recursive Ancestors (CTE)

The `managementChain` pseudo-column walks all the way up to the root. NQL compiles this to a `WITH RECURSIVE` CTE — no manual recursion needed.

```nql
employees | select name, managementChain.*
```

<details><summary>SQL</summary>

```sql
WITH RECURSIVE management_chain_cte AS (
  SELECT employees.id, employees.name, employees.title,
    employees.manager_id, 1 AS depth
  FROM hierarchy_example.employees
  WHERE employees.id IN (SELECT manager_id FROM hierarchy_example.employees)
  UNION ALL
  SELECT e.id, e.name, e.title, e.manager_id, mc.depth + 1
  FROM hierarchy_example.employees e
  INNER JOIN management_chain_cte mc ON e.id = mc.manager_id
)
SELECT employees.name,
  COALESCE(
    (SELECT json_agg(to_jsonb(mc))
     FROM management_chain_cte mc
     WHERE mc.id = employees.manager_id),
    '[]'::json
  ) AS management_chain_json
FROM hierarchy_example.employees
```
</details>

### Recursive Descendants (CTE)

The inverse of `managementChain`: `allReports` walks *down* the tree, collecting all direct and indirect reports via a recursive CTE.

```nql
employees | select name, allReports.*
employees | select name, allReports.name
```

---

## Range Types

*Schema: scheduling*

PostgreSQL range types (`daterange`, `tstzrange`, `int4range`) are supported natively. NQL uses readable operator names instead of PostgreSQL's symbolic operators.

### Overlaps

Find all room bookings whose period has any overlap with a given date window. NQL's `overlaps` compiles to PostgreSQL's `&&` (range overlap) operator.

```nql
roomBookings | where bookingPeriod overlaps [2024-01-16,2024-01-20)
```

<details><summary>SQL</summary>

```sql
SELECT room_bookings.*
FROM ch4_scheduling.room_bookings
WHERE room_bookings.booking_period && CAST($1 AS daterange)
-- params: ["[2024-01-16,2024-01-20)"]
```
</details>

| id | room_id | booked_by     | booking_period          | purpose            |
|----|---------|---------------|-------------------------|--------------------|
| 1  | 1       | Alice Johnson | [2024-01-15,2024-01-17) | Product planning   |
| 5  | 2       | Eve Davis     | [2024-01-18,2024-01-19) | Code review        |
| 10 | 4       | Jack Taylor   | [2024-01-15,2024-01-20) | Technical training |
| 12 | 7       | CEO Office    | [2024-01-01,2024-01-31) | Executive reserved |

*(4 rows)*

### Contained By

Find bookings entirely within a month. `containedBy` compiles to `<@` — the booking's full range must fit inside the given bounds.

```nql
roomBookings | where bookingPeriod containedBy [2024-01-01,2024-02-01)
```

<details><summary>SQL</summary>

```sql
SELECT room_bookings.*
FROM ch4_scheduling.room_bookings
WHERE room_bookings.booking_period <@ CAST($1 AS daterange)
-- params: ["[2024-01-01,2024-02-01)"]
```
</details>

| id | room_id | booked_by     | booking_period          | purpose               |
|----|---------|---------------|-------------------------|-----------------------|
| 1  | 1       | Alice Johnson | [2024-01-15,2024-01-17) | Product planning      |
| 2  | 1       | Bob Smith     | [2024-01-20,2024-01-21) | Client meeting        |
| 3  | 1       | Carol White   | [2024-01-25,2024-01-28) | Team workshop         |
| 4  | 2       | David Brown   | [2024-01-10,2024-01-12) | Interview sessions    |
| 5  | 2       | Eve Davis     | [2024-01-18,2024-01-19) | Code review           |
| ...| ...     | ...           | ...                     | ...                   |

*(12 rows)*

### Contains

Find which pricing tier applies to a given quantity. `contains` checks if the range includes a scalar value — compiles to `@>`.

```nql
priceTiers | where quantityRange contains 25
```

<details><summary>SQL</summary>

```sql
SELECT price_tiers.*
FROM scheduling.price_tiers
WHERE price_tiers.quantity_range @> $1
-- params: [25]
```
</details>

| id | product_name | quantity_range | unit_price |
|----|-------------|----------------|------------|
| 2  | Widget Pro   | [10,50)        | 89.99      |
| 8  | Gadget Basic | [25,100)       | 19.99      |
| 10 | API Calls    | [1,1000)       | 0.01       |
| 16 | Team License | [20,100)       | 99.00      |

*(4 rows)*

### Range Literal Syntax

| Syntax | Meaning |
|--------|---------|
| `[a,b]` | Inclusive both ends |
| `[a,b)` | Inclusive start, exclusive end |
| `(a,b]` | Exclusive start, inclusive end |
| `(a,b)` | Exclusive both ends |

### Date Literals in Range Values

Range bound values that look like dates or times are recognised by the NQL lexer as `RangeValue` tokens. The supported patterns are:

| Format | Examples | Notes |
|--------|----------|-------|
| Full ISO date | `2024-01-15` | Preferred — always unambiguous |
| ISO datetime | `2024-01-15T14:00` | Separates date and time with `T` |
| ISO time | `14:00`, `14:00:30` | Time only (no date component) |

> **MM-DD format not supported.** Bare month-day notation (`05-20`) is **not** a
> recognised date literal in NQL range bounds. Use a full ISO date (`2024-05-20`)
> instead. This format was removed to avoid ambiguity with numeric ranges that
> happen to match the two-digit pattern. If you need `HH:MM`, that is supported as
> a time-only literal.

---

## Mutations

### INSERT

*Schema: ecommerce*

Insert a row using `set col = val` syntax. All values are parameterized. The trailing `!` is a safety guard required for mutations without a WHERE clause — it prevents accidental execution.

```nql
insert into categories set name = 'Accessories', slug = 'accessories'!
```

<details><summary>SQL</summary>

```sql
INSERT INTO ch5_ecommerce.categories (name, slug)
VALUES ($1, $2)
-- params: ["Accessories", "accessories"]
```
</details>

### UPDATE

Update rows matching a condition. The WHERE clause targets specific rows; `set` specifies the new values.

```nql
update products set price = 29.99 where sku = 'WIDGET-001'!
```

<details><summary>SQL</summary>

```sql
UPDATE ch5_ecommerce.products
SET price = $1
WHERE products.sku = $2
-- params: [29.99, "WIDGET-001"]
```
</details>

### DELETE

Remove rows matching a condition. Like all mutations, the `!` suffix is required as a confirmation guard.

```nql
delete from orders where status = 'cancelled'!
```

<details><summary>SQL</summary>

```sql
DELETE FROM ch5_ecommerce.orders
WHERE orders.status = $1
-- params: ["cancelled"]
```
</details>

### UPSERT (INSERT ... ON CONFLICT)

Insert or update based on a unique constraint. The `on sku` clause specifies the conflict column — if a row with that SKU already exists, it gets updated instead.

```nql
upsert into products on sku \
  set name = 'New Widget', sku = 'WIDGET-NEW', price = 19.99, \
      categoryId = 1, active = true!
```

<details><summary>SQL</summary>

```sql
INSERT INTO ch5_ecommerce.products (name, sku, price, category_id, active)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (sku) DO UPDATE
SET name = excluded.name, sku = excluded.sku,
    price = excluded.price, category_id = excluded.category_id,
    active = excluded.active
-- params: ["New Widget", "WIDGET-NEW", 19.99, 1, true]
```
</details>

Add a `where` clause to make the conflict update conditional. The predicate is emitted after `DO UPDATE SET`, so it checks the existing conflicting row; when it is false, PostgreSQL leaves that row unchanged.

```nql
upsert into products on sku \
  set name = 'New Widget', sku = 'WIDGET-NEW', price = 19.99, \
      categoryId = 1, active = true \
  where active = true!
```

<details><summary>SQL</summary>

```sql
INSERT INTO ch5_ecommerce.products (name, sku, price, category_id, active)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (sku) DO UPDATE
SET name = excluded.name, sku = excluded.sku,
    price = excluded.price, category_id = excluded.category_id,
    active = excluded.active
WHERE products.active = $6
-- params: ["New Widget", "WIDGET-NEW", 19.99, 1, true, true]
```
</details>

### Multi-Row INSERT

Insert multiple rows in a single statement. Two syntaxes are available:

**Inline values syntax:**

```nql
insert into categories values \
  (name = 'Toys', slug = 'toys'), \
  (name = 'Sports', slug = 'sports')!
```

**Pipe continuation syntax:**

```nql
insert into categories set name = 'Toys', slug = 'toys' \
  | set name = 'Sports', slug = 'sports'!
```

Both produce a single `INSERT ... VALUES (...), (...)` statement. If rows have different columns, missing ones are normalized to NULL.

### TypeScript Tag Mutations

When NQL is used through the TypeScript `orm.nql` tag, final mutation statements use the same mutation compiler and hook pipeline as the fluent mutation builders.

| Method | Mutation behavior |
|--------|-------------------|
| `.dump()` | Compiles only. Returns mutation SQL, `parameters`, intent, and metadata; it does not execute and does not run hooks. |
| `.run()` | Executes the query or mutation and discards returned rows. Mutation hooks run. |
| `.all()` | Executes the query or mutation. For mutations with `| select ...`, returned rows flow through `afterMutation` hooks; mutations without `RETURNING` return no rows from PostgreSQL. |

Use `.dump()` when you want SQL and parameters without touching the database:

```typescript
const created = orm.nql<unknown>`
  insert into users set name = ${'Alice'}, email = ${'alice@example.com'}
`.dump() as {
  sql: string;
  parameters: readonly unknown[];
};

console.log(created.sql);
console.log(created.parameters);
```

Read-only `| bind` pipelines can feed a final mutation. The bound query is compiled as a CTE and all tag interpolations share one generated params map across the whole template:

```typescript
const archivedDrafts = orm.nql<unknown>`posts
  | where published = ${false}
  | select id, title, authorId, published, createdAt
  | bind draft_posts
insert into posts from draft_posts`
  .dump() as {
  sql: string;
  parameters: readonly unknown[];
};

console.log(archivedDrafts.sql);
console.log(archivedDrafts.parameters);
```

A tag program can also contain ordered mutations. A non-final mutation may end with `| bind <name>` when it includes a `| select ...` returning projection. During execution, each mutation runs in source order inside one adapter transaction; each mutation fires its own `beforeMutation` and `afterMutation` hooks. Rows returned by a bound mutation feed later statements as a standard SQL CTE, for example `WITH "created_user" ("id") as (SELECT "id" FROM "users" WHERE false UNION ALL VALUES (...))`. This is not a PostgreSQL writable CTE; NQL executes the mutation first, then materializes its returned rows for subsequent statements.

Use `.dump()` to inspect the compile-only statement sequence. Since `.dump()` does not execute the bound mutation, each empty runtime binding is emitted as a table-derived empty relation such as `WITH "created_user" ("id") as (SELECT "id" FROM "users" WHERE false)`:

```typescript
const mutationBindingDb = schema({
  users: {
    id: { type: 'uuid', primaryKey: true, dbType: 'uuid' },
    name: 'string',
    email: 'string',
    active: 'boolean',
  },
} as const);
const mutationBindingOrm = createOrm({
  schema: mutationBindingDb,
  adapter: createPgsqlCompileOnlyAdapter({ model: mutationBindingDb.model }),
});

const orderedMutationProgram = mutationBindingOrm.nql<unknown>`
insert into users set name = ${'Alice'}, email = ${'alice@example.com'} | select id | bind created_user
update users set active = ${true} where id in (created_user) | select id | bind activated_user
update users set active = ${false} where id in (activated_user) | select id
`.dump() as {
  sql: string;
  parameters: readonly unknown[];
  sequence?: ReadonlyArray<{
    kind: string;
    bindName?: string;
    sql: string;
    params: readonly unknown[];
  }>;
};

if (
  orderedMutationProgram.sequence?.length !== 3 ||
  orderedMutationProgram.sequence[0]?.bindName !== 'created_user' ||
  orderedMutationProgram.sequence[1]?.bindName !== 'activated_user'
) {
  throw new Error('expected ordered mutation sequence');
}

const updateSql = orderedMutationProgram.sequence[1]?.sql ?? '';
const finalSql = orderedMutationProgram.sequence[2]?.sql ?? '';
const emptyUserIdRelation = 'SELECT "id" FROM "users" WHERE false';
const writableMutationCte = /WITH "(?:created_user|activated_user)"\s+\("id"\)\s+as\s+\(\s*insert/i;

if (
  !updateSql.includes('WITH "created_user" ("id") as (') ||
  !updateSql.includes(emptyUserIdRelation) ||
  !finalSql.includes('"activated_user" ("id") as (') ||
  !finalSql.includes(emptyUserIdRelation) ||
  writableMutationCte.test(updateSql) ||
  writableMutationCte.test(finalSql)
) {
  throw new Error('expected mutation bindings to materialize through table-derived empty CTEs');
}
```

Mutation hooks run for tag mutations during execution:

```typescript
const { createHookManager } = await import('@dbsp/core');

const adapterWithExecute = createPgsqlCompileOnlyAdapter() as ReturnType<
  typeof createPgsqlCompileOnlyAdapter
> & {
  execute: () => Promise<Array<{ id: string }>>;
};
adapterWithExecute.execute = async () => [{ id: 'user-1' }];

const events: string[] = [];
const hooks = createHookManager()
  .beforeMutation((ctx) => {
    events.push(`before:${ctx.operation}:${ctx.table}`);
    return ctx;
  })
  .afterMutation((ctx, rows) => {
    events.push(`after:${ctx.operation}:${ctx.table}:${rows.length}`);
    return rows;
  });

const hookedOrm = createOrm({ schema: db, adapter: adapterWithExecute, hooks });
const rows = await hookedOrm.nql<{ id: string }>`
  insert into users set name = ${'Alice'}, email = ${'alice@example.com'} | select id
`.all();

if (rows.length !== 1 || events.join(',') !== 'before:insert:users,after:insert:users:1') {
  throw new Error('NQL mutation hooks did not run as expected');
}
```

The tag path fails loudly instead of dropping statements or silently accepting unusable bindings:

```typescript
const mutationBindingFailureDb = schema({
  users: {
    id: { type: 'uuid', primaryKey: true, dbType: 'uuid' },
    name: 'string',
    email: 'string',
    active: 'boolean',
  },
  posts: {
    id: { type: 'uuid', primaryKey: true, dbType: 'uuid' },
    title: 'string',
    authorId: ref('users'),
  },
} as const);
const mutationBindingFailureOrm = createOrm({
  schema: mutationBindingFailureDb,
  adapter: createPgsqlCompileOnlyAdapter({ model: mutationBindingFailureDb.model }),
});

let missingBind = '';
try {
  mutationBindingFailureOrm.nql`users | where active = ${true}
posts | select id`.dump();
} catch (error) {
  missingBind = error instanceof Error ? error.message : String(error);
}

if (!missingBind.includes('Multiple statements require explicit binding')) {
  throw new Error(missingBind || 'expected missing bind failure');
}

let missingReturning = '';
try {
  mutationBindingFailureOrm.nql`
insert into users set name = ${'Alice'}, email = ${'alice@example.com'} | bind created_user
users | where id in (created_user)`.dump();
} catch (error) {
  missingReturning = error instanceof Error ? error.message : String(error);
}

if (!missingReturning.includes('must include a `returning` clause')) {
  throw new Error(missingReturning || 'expected missing RETURNING failure');
}

let duplicateBind = '';
try {
  mutationBindingFailureOrm.nql`
insert into users set name = ${'Alice'}, email = ${'alice@example.com'} | select id | bind created_user
insert into users set name = ${'Bob'}, email = ${'bob@example.com'} | select id | bind created_user
users | where id in (created_user)`.dump();
} catch (error) {
  duplicateBind = error instanceof Error ? error.message : String(error);
}

if (!duplicateBind.includes("NQL binding name 'created_user' is used more than once")) {
  throw new Error(duplicateBind || 'expected duplicate bind failure');
}

let nonProjectedColumn = '';
try {
  mutationBindingFailureOrm.nql`
insert into users set name = ${'Alice'}, email = ${'alice@example.com'} | select id | bind created_user
created_user | select email`.dump();
} catch (error) {
  nonProjectedColumn = error instanceof Error ? error.message : String(error);
}

if (!nonProjectedColumn.includes("Column 'email' is not projected by NQL binding 'created_user'")) {
  throw new Error(nonProjectedColumn || 'expected non-projected column failure');
}
```

Constraints to rely on:

- Every non-final statement in a multi-statement tag template must end with `| bind <name>`.
- Binding names must be unique within one NQL program.
- A bound mutation must include `| select ...` / `RETURNING` so it produces a referenceable result.
- Later statements may reference only columns projected by the bound query or mutation.
- Bound mutation rows are materialized for later statements as standard SQL CTEs: runtime rows use `SELECT <projected columns> FROM <source table> WHERE false UNION ALL VALUES (...)`, while compile-only empty bindings use only the `SELECT <projected columns> FROM <source table> WHERE false` branch. PostgreSQL derives binding column types from the real table. They are not PostgreSQL writable CTEs.
- Where-less NQL `update` and `delete` fail unless the compiler is explicitly configured with `allowUnfilteredMutations`.

---

## Advanced Features

### Bind (Named CTE)

*Schema: iam*

Capture a query result and name it for reuse in subsequent statements. This is NQL's equivalent of a CTE — the bound name can be referenced in later queries within the same `.dbsp` file.

```nql
users | where active = true | select id | bind activeUsers
```

<details><summary>SQL</summary>

```sql
SELECT users.id
FROM iam_example.users
WHERE users.active = $1
-- params: [true]
```
</details>

| id |
|----|
| 1  |
| 2  |
| 3  |
| 4  |
| 5  |

*(5 rows — the bound result `activeUsers` can be used in subsequent queries, e.g. `where userId in activeUsers`)*

**Follow-up usage** — reference the bound name in a later query:

```nql
roles | where id in (userRoles | where userId = 1 | select roleId)
```

<details><summary>SQL</summary>

```sql
SELECT roles.*
FROM iam_example.roles
WHERE roles.id = ANY (
  SELECT user_roles_subq_0.role_id
  FROM iam_example.user_roles AS user_roles_subq_0
  WHERE user_roles_subq_0.user_id = $1
)
AND EXISTS (
  SELECT 1
  FROM iam_example.user_roles AS user_roles_exists_1
  WHERE roles.id = user_roles_exists_1.role_id
)
-- params: [1]
```
</details>

| id | name        | description                         | active |
|----|-------------|-------------------------------------|--------|
| 1  | super_admin | Super administrator with all access | True   |

*(1 row — roles assigned to user 1 via the junction table)*

### Per-Include LIMIT

Limit the number of related rows *per parent row*. This forces the LATERAL strategy (see [Per-Include LIMIT (LATERAL)](#per-include-limit-lateral) above).

```nql
users | select *, userRoles.* | limit userRoles 2
```

<details><summary>SQL</summary>

```sql
SELECT users.*, user_roles_lat_0.*
FROM iam_example.users
LEFT JOIN LATERAL (
  SELECT user_roles_inner_0.*
  FROM iam_example.user_roles AS user_roles_inner_0
  WHERE user_roles_inner_0.user_id = users.id
  LIMIT 2
) AS user_roles_lat_0 ON true
```
</details>

Supports dotted paths for nested relations — all ancestors in the path are automatically switched to LATERAL:

```nql
users | select *, userRoles.* | limit userRoles.role 1
```

*Schema: test-locking*

### Row-Level Locking (FOR UPDATE / FOR SHARE)

Row-level locks are used in transaction contexts to prevent concurrent modifications. The classic use case is the **job queue pattern**: claim a pending row atomically.

**Lock strengths:**

```nql
jobs | for update                 # Exclusive lock
jobs | for share                  # Shared lock
jobs | for no key update          # Exclusive (non-key columns only)
jobs | for key share              # Shared (key columns only)
```

**Wait policies:**

```nql
jobs | for update skip locked     # Skip already-locked rows
jobs | for update nowait          # Error immediately if locked
```

**Job queue pattern** — select + lock + skip in one query:

```nql
jobs | where status = 'pending' | order by priority desc | limit 1 | for update skip locked
```

<details><summary>SQL</summary>

```sql
SELECT jobs.*
FROM test_locking.jobs
WHERE jobs.status = $1
ORDER BY jobs.priority DESC
LIMIT 1
FOR UPDATE SKIP LOCKED
-- params: ["pending"]
```
</details>

**Notes:**
- Lock clauses are only effective within a transaction — a warning is emitted if used outside one
- `FOR UPDATE/SHARE` is incompatible with `GROUP BY` (SQL standard restriction)
- When the query includes JOINs, the lock is automatically scoped to the root table via `FOR UPDATE OF`

### Raw SQL Escape Hatch

For DDL or administrative commands not covered by NQL, prefix with `!` to pass raw SQL directly to the database:

```
!CREATE INDEX idx_users_email ON users (email);
!VACUUM ANALYZE users;
```

### Multiline Queries

*Schema: test-strategies*

Long queries can be split across lines using `\` at the end of each continued line. The REPL joins them before parsing:

```nql
employees | select name, salary, \
  case when salary > 80000 then 'senior' \
       when salary > 50000 then 'mid' \
       else 'junior' end as level
```

---

## REPL Commands

Dot commands control the REPL environment (schema switching, file import, output format). They do not compile to SQL.

| Command | Description |
|---------|-------------|
| `.tables` | List all tables in the schema |
| `.schema <table>` | Show columns for a table |
| `.relations <table>` | Show relations for a table |
| `.use <schema>` | Set PostgreSQL schema context |
| `.import <file.sql>` | Execute a SQL file |
| `.output json\|table\|csv` | Change output format |
| `.help` | Show available commands |

### Schema Setup Pattern

Every `.dbsp` file follows this pattern to create a clean, isolated database context before running queries:

```
# Drop and recreate schema for clean state
!DROP SCHEMA IF EXISTS my_schema CASCADE;
!CREATE SCHEMA IF NOT EXISTS my_schema;

# Set schema context
.use my_schema

# Import DDL and seed data
.import examples/my.ddl.sql
.import examples/my.seed.sql
```

---

## Quick Reference

### Query Operators

```
table                              -- table scan
  | where <condition>              -- filter rows
  | select <columns>               -- project columns
  | select *, relation.*           -- include related data
  | flat                           -- force LEFT JOIN (no json_agg)
  | group by <columns>             -- aggregate grouping
  | order by <col> [asc|desc]      -- sort results
  | limit N                        -- top-N rows
  | offset N                       -- skip rows
  | limit <relation> N             -- per-include limit (LATERAL)
  | select distinct                -- deduplicate rows
  | bind <name>                    -- capture result as CTE
  | for update [skip locked|nowait] -- row-level lock (E15)
  | for share [skip locked|nowait]  -- shared row lock
  | for no key update               -- non-key exclusive lock
  | for key share                   -- key-only shared lock
  | union (right_query)             -- deduplicated union
  | union all (right_query)         -- union with duplicates
  | intersect (right_query)         -- rows in both sets
  | except (right_query)            -- rows in left but not right
```

### WHERE Conditions

| Condition | Example |
|-----------|---------|
| Equality | `where id = 1` |
| Comparison | `where price > 100` |
| NULL check | `where email is null` / `is not null` |
| Boolean | `where active = true` |
| AND / OR | `where a = 1 and b = 2` |
| NOT | `where not active = true` |
| BETWEEN | `where salary between 50000 and 100000` |
| LIKE | `where name like 'A%'` |
| IN (list) | `where id in (1, 2, 3)` |
| IN (subquery) | `where id in (table \| select col)` |
| NOT IN | `where id not in (4, 5)` |
| Range overlaps | `where bookingPeriod overlaps [a,b)` |
| Range contains | `where quantityRange contains 25` |
| Range containedBy | `where bookingPeriod containedBy [a,b)` |
| JSONB ->> | `where col ->> 'key' = 'val'` |
| JSONB @> | `where col @> '{"k":"v"}'` |
| JSONB ? | `where col ? 'key'` |
| Relation filter | `where relation.col = val` (implicit EXISTS) |

### Aggregate Functions

| Function | Example |
|----------|---------|
| `count(*)` | `select count(*)` |
| `count(distinct col)` | `select count(distinct name)` |
| `sum(col)` | `select sum(total)` |
| `avg(col)` | `select avg(price)` |
| `min(col)` | `select min(created_at)` |
| `max(col)` | `select max(salary)` |

### Mutations

| Operation | Syntax |
|-----------|--------|
| INSERT | `insert into table set col = val!` |
| Multi-row INSERT | `insert into table values (a=1), (b=2)!` |
| UPDATE | `update table set col = val where condition!` |
| DELETE | `delete from table where condition!` |
| UPSERT | `upsert into table on conflictCol set col = val!` |
| Tag mutation dump | ``orm.nql`insert into table set col = ${value}`.dump()`` |
| Bound pipeline mutation | ``query-or-returning-mutation \| bind source`` then `insert into table from source` |

### Include Strategies

| Strategy | Trigger | SQL Pattern |
|----------|---------|-------------|
| json_agg | `select *, rel.*` (default) | Correlated subquery with `json_agg` |
| flat | `\| flat` | LEFT JOIN |
| LATERAL | `\| limit rel N` | LEFT JOIN LATERAL with LIMIT |
| CTE | Recursive pseudo-columns | WITH RECURSIVE |

### Hierarchy Pseudo-Columns

Requires a self-referencing FK with roles defined in the schema:

| Pseudo-Column | Description |
|---------------|-------------|
| `manager` | Direct parent (single level) |
| `manager.manager` | Skip-level (2 levels up) |
| `managementChain` | All ancestors (recursive CTE) |
| `allReports` | All descendants (recursive CTE) |
