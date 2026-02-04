# NQL Reference

Complete reference for the Natural Query Language — a pipe-based syntax for database queries.

**Related guides:** [ORM API](./orm-api.md) | [README](../../README.md) | [CLI Usage](../CLI_USAGE.md)

---

## 1. What is NQL?

NQL (Natural Query Language) is a pipe-based query language that compiles to the same IntentAST as the ORM API. It's designed for:
- **CLI/REPL** interactive exploration (`dbsp repl`)
- **`.dbsp` files** for batch queries and test assertions
- **Template literals** in TypeScript via `orm.nql`

```nql
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
```nql
# comments start with #
posts | where published = true | select title
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT posts.title

  FROM posts

  WHERE
  posts.published = $1
```

**Parameters:** `[true]`

**Why NQL?** Filter values are automatically parameter-bound (`$1`, `$2`, ...) — never interpolated into the SQL string. The planner also qualifies column names with table aliases, so you never need to worry about ambiguous references.

</details>






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
```nql
authors
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT authors.*

  FROM authors
```

**Parameters:** _none_

**Why NQL?** Even the simplest query benefits from the planner: table names are double-quoted (safe for reserved words), aliases are generated, and the result is a fully parameterized query ready for `pg.Pool.query()`.

</details>






**ecommerce:**
```nql
products
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT products.*

  FROM products
```

**Parameters:** _none_

**Why NQL?** Even the simplest query benefits from the planner: table names are double-quoted (safe for reserved words), aliases are generated, and the result is a fully parameterized query ready for `pg.Pool.query()`.

</details>






Returns all rows and columns from the table.

### Pipe Operators

Chain clauses with `|`:

**ecommerce:**
```nql
products | where active = true | select id, name | order by name | limit 10
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT
  products.id,
  products.name

  FROM products

  WHERE
  products.active = $1

  ORDER BY
  products.name ASC

  LIMIT 10
```

**Parameters:** `[true]`

**Why NQL?** NQL's pipe syntax reads like a sentence: "start from table, filter, sort, take N." The equivalent SQL requires WHERE, ORDER BY, and LIMIT clauses in specific positions. All values are automatically parameter-bound (`$1`, `$2`, ...) for safety.

</details>






**blog:**
```nql
posts | where published = true | select title, slug | order by createdAt desc | limit 10
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT
  posts.title,
  posts.slug

  FROM posts

  WHERE
  posts.published = $1

  ORDER BY
  posts."createdAt" DESC

  LIMIT 10
```

**Parameters:** `[true]`

**Why NQL?** NQL's pipe syntax reads like a sentence: "start from table, filter, sort, take N." The equivalent SQL requires WHERE, ORDER BY, and LIMIT clauses in specific positions. All values are automatically parameter-bound (`$1`, `$2`, ...) for safety.

</details>






### Comments

Comments start with `#` and extend to end of line:

```nql
# Full-line comment (ignored by REPL and .dbsp files)
products | where active = true   # Inline comment
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT products.*

  FROM products

  WHERE
  products.active = $1
```

**Parameters:** `[true]`

**Why NQL?** Filter values are automatically parameter-bound (`$1`, `$2`, ...) — never interpolated into the SQL string. The planner also qualifies column names with table aliases, so you never need to worry about ambiguous references.

</details>






---

## 3. WHERE (Filtering)

### Comparison Operators

**blog:**
```nql
authors | where name = 'Alice'
authors | where name != 'John'
posts | where published = true
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT posts.*

  FROM posts

  WHERE
  posts.published = $1
```

**Parameters:** `[true]`

**Why NQL?** Filter values are automatically parameter-bound (`$1`, `$2`, ...) — never interpolated into the SQL string. The planner also qualifies column names with table aliases, so you never need to worry about ambiguous references.

</details>






**ecommerce:**
```nql
products | where price > 100
products | where price >= 100
products | where stock < 50
orders | where total <= 10
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT orders.*

  FROM orders

  WHERE
  orders.total <= $1
```

**Parameters:** `[10]`

**Why NQL?** Filter values are automatically parameter-bound (`$1`, `$2`, ...) — never interpolated into the SQL string. The planner also qualifies column names with table aliases, so you never need to worry about ambiguous references.

</details>






### Pattern Matching

**blog:**
```nql
authors | where name like 'A%'
authors | where email like '%@example.com'
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT authors.*

  FROM authors

  WHERE
  authors.email LIKE $1
```

**Parameters:** `["%@example.com"]`

**Why NQL?** Filter values are automatically parameter-bound (`$1`, `$2`, ...) — never interpolated into the SQL string. The planner also qualifies column names with table aliases, so you never need to worry about ambiguous references.

</details>






**ecommerce:**
```nql
products | where name like '%Phone%'
customers | where email like '%@gmail.com'
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT customers.*

  FROM customers

  WHERE
  customers.email LIKE $1
```

**Parameters:** `["%@gmail.com"]`

**Why NQL?** Filter values are automatically parameter-bound (`$1`, `$2`, ...) — never interpolated into the SQL string. The planner also qualifies column names with table aliases, so you never need to worry about ambiguous references.

</details>






### BETWEEN

**ecommerce:**
```nql
products | where price between 10 and 500
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT products.*

  FROM products

  WHERE
  products.price BETWEEN $1 AND $2
```

**Parameters:** `[10, 500]`

**Why NQL?** Filter values are automatically parameter-bound (`$1`, `$2`, ...) — never interpolated into the SQL string. The planner also qualifies column names with table aliases, so you never need to worry about ambiguous references.

</details>






**hierarchy:**
```nql
employees | where salary between 50000 and 100000
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT employees.*

  FROM employees

  WHERE
  employees.salary BETWEEN $1 AND $2
```

**Parameters:** `[50000, 100000]`

**Why NQL?** Filter values are automatically parameter-bound (`$1`, `$2`, ...) — never interpolated into the SQL string. The planner also qualifies column names with table aliases, so you never need to worry about ambiguous references.

</details>






### IN (Value List)

**ecommerce:**
```nql
orders | where status in ('pending', 'shipped', 'delivered')
products | where id in (1, 2, 3)
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT products.*

  FROM products

  WHERE
  products.id = ANY ($1)
```

**Parameters:** `[[1,2,3]]`

**Why NQL?** Filter values are automatically parameter-bound (`$1`, `$2`, ...) — never interpolated into the SQL string. The planner also qualifies column names with table aliases, so you never need to worry about ambiguous references.

</details>






### IN (Subquery)

**ecommerce:**
```nql
customers | where id in (orders | select customerId | where status = 'delivered')

# With limit and order by inside the subquery
customers | where id in (orders | select customerId | order by total desc | limit 10)
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT customers.*

  FROM customers

  WHERE
  customers.id = ANY (SELECT orders_subq_0."customerId"

  FROM orders AS orders_subq_0

  WHERE
  orders_subq_0.status = $1)
  AND EXISTS (SELECT 1

  FROM orders AS orders_exists_1

  WHERE
  customers.id = orders_exists_1."customerId")
```

**Parameters:** `["delivered"]`

**Planner decisions:**
| Decision | Context | Choice | Reasoning |
|----------|---------|--------|-----------|
| filter-strategy | customers → orders | exists | Relation customers.orders has cardinality "many" - using EXISTS to avoid row explosion |

**Why NQL?** Subqueries in NQL compose naturally — the inner query is just another NQL pipe expression inside parentheses. The planner compiles it as a correlated or uncorrelated subquery depending on context, handling aliasing and parameter numbering automatically.

</details>






> Subquery `limit` and `order by` are propagated to SQL. See
> [Three Forms of LIMIT](#three-forms-of-limit) for the difference between
> subquery limit, outer limit, and per-include limit.

### NULL Checks

**blog:**
```nql
authors | where bio is null
posts | where updatedAt is not null
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT posts.*

  FROM posts

  WHERE
  posts."updatedAt" IS NOT NULL
```

**Parameters:** _none_

**Why NQL?** Filter values are automatically parameter-bound (`$1`, `$2`, ...) — never interpolated into the SQL string. The planner also qualifies column names with table aliases, so you never need to worry about ambiguous references.

</details>






**ecommerce:**
```nql
products | where description is null
customers | where phone is not null
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT customers.*

  FROM customers

  WHERE
  customers.phone IS NOT NULL
```

**Parameters:** _none_

**Why NQL?** Filter values are automatically parameter-bound (`$1`, `$2`, ...) — never interpolated into the SQL string. The planner also qualifies column names with table aliases, so you never need to worry about ambiguous references.

</details>






### Logical Operators

**ecommerce:**
```nql
# AND
products | where active = true and price > 50

# OR
orders | where status = 'pending' or status = 'shipped'

# Parentheses for grouping
products | where (stock < 10 or stock > 1000) and active = true
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT products.*

  FROM products

  WHERE
  products.active = $1
  AND products.price > $2
```

**Parameters:** `[true, 50]`

**Why NQL?** Filter values are automatically parameter-bound (`$1`, `$2`, ...) — never interpolated into the SQL string. The planner also qualifies column names with table aliases, so you never need to worry about ambiguous references.

</details>






**blog:**
```nql
# NOT
comments | where not (approved = true)

# Combined
posts | where published = true and (title like '%Guide%' or title like '%Tutorial%')
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT comments.*

  FROM comments

  WHERE
  NOT (comments.approved = $1)
```

**Parameters:** `[true]`

**Why NQL?** Filter values are automatically parameter-bound (`$1`, `$2`, ...) — never interpolated into the SQL string. The planner also qualifies column names with table aliases, so you never need to worry about ambiguous references.

</details>






### Relation Filters

Filter by related records using quantifiers:

**blog:**
```nql
# SOME — at least one related record matches
authors | where some(posts).published = true

# NONE — no related record matches
authors | where none(posts).published = false

# EVERY — all related records match
authors | where every(posts).published = true

# With aliases for complex conditions
authors | where some(posts as p, p.published = true and p.title like '%Guide%')
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT authors.*

  FROM authors

  WHERE
  EXISTS (SELECT 1

  FROM posts AS posts_exists_0

  WHERE
  authors.id = posts_exists_0."authorId"
  AND posts_exists_0.published = $1)
```

**Parameters:** `[true]`

**Planner decisions:**
| Decision | Context | Choice | Reasoning |
|----------|---------|--------|-----------|
| filter-strategy | authors → posts | exists | Relation authors.posts has cardinality "many" (mode: some) - using EXISTS to avoid row explosion |

**Why NQL?** Filter values are automatically parameter-bound (`$1`, `$2`, ...) — never interpolated into the SQL string. The planner also qualifies column names with table aliases, so you never need to worry about ambiguous references.

</details>






**ecommerce:**
```nql
customers | where none(orders as o, o.status = 'cancelled' and o.total > 100)
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT customers.*

  FROM customers

  WHERE
  NOT (EXISTS (SELECT 1

  FROM orders AS orders_exists_0

  WHERE
  customers.id = orders_exists_0."customerId"
  AND (orders_exists_0.status = $1
  AND orders_exists_0.total > $2)))
```

**Parameters:** `["cancelled", 100]`

**Planner decisions:**
| Decision | Context | Choice | Reasoning |
|----------|---------|--------|-----------|
| filter-strategy | customers → orders | exists | Relation customers.orders has cardinality "many" (mode: none) - using EXISTS to avoid row explosion |

**Why NQL?** Filter values are automatically parameter-bound (`$1`, `$2`, ...) — never interpolated into the SQL string. The planner also qualifies column names with table aliases, so you never need to worry about ambiguous references.

</details>






### EXISTS Subquery

**ecommerce:**
```nql
customers | where exists (orders | where customerId = customers.id)
```

---

## 4. SELECT (Projection)

### All Columns

**blog:**
```nql
authors | select *
authors                    # implicit select *
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT authors.*

  FROM authors
```

**Parameters:** _none_

**Why NQL?** Even the simplest query benefits from the planner: table names are double-quoted (safe for reserved words), aliases are generated, and the result is a fully parameterized query ready for `pg.Pool.query()`.

</details>






### Specific Columns

**blog:**
```nql
authors | select id, name, email
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT
  authors.id,
  authors.name,
  authors.email

  FROM authors
```

**Parameters:** _none_

**Why NQL?** This 32-character NQL expression compiles to 65 characters of SQL (2.0× expansion). The planner handles identifier quoting, table aliasing, parameter binding, and column qualification automatically.

</details>






**ecommerce:**
```nql
products | select sku, name, price
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT
  products.sku,
  products.name,
  products.price

  FROM products
```

**Parameters:** _none_

**Why NQL?** This 34-character NQL expression compiles to 70 characters of SQL (2.1× expansion). The planner handles identifier quoting, table aliasing, parameter binding, and column qualification automatically.

</details>






### Aliases

**ecommerce:**
```nql
products | select name as productName, price as cost
products | select price * 1.1 as priceWithTax
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT
  products.price * $1 AS "priceWithTax"

  FROM products
```

**Parameters:** `[1.1]`

**Why NQL?** This 98-character NQL expression compiles to 60 characters of SQL (0.6× expansion). The planner handles identifier quoting, table aliasing, parameter binding, and column qualification automatically.

</details>






### DISTINCT

**ecommerce:**
```nql
orders | select distinct status
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT DISTINCT orders.status

  FROM orders
```

**Parameters:** _none_

**Why NQL?** This 31-character NQL expression compiles to 41 characters of SQL (1.3× expansion). The planner handles identifier quoting, table aliasing, parameter binding, and column qualification automatically.

</details>






**blog:**
```nql
comments | select count(distinct authorName)
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT count(DISTINCT comments."authorName")

  FROM comments
```

**Parameters:** _none_

**Why NQL?** This 44-character NQL expression compiles to 58 characters of SQL (1.3× expansion). The planner handles identifier quoting, table aliasing, parameter binding, and column qualification automatically.

</details>






### Arithmetic Expressions

**ecommerce:**
```nql
orderItems | select unitPrice + 5 as shippingTotal
orderItems | select quantity * unitPrice as lineTotal
products | select price - 10 as discountedPrice
orderItems | select totalPrice / quantity as effectiveUnitPrice
orderItems | select quantity % 3 as remainder
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT
  "orderItems".quantity % $1 AS remainder

  FROM "orderItems"
```

**Parameters:** `[3]`

**Why NQL?** This 262-character NQL expression compiles to 66 characters of SQL (0.3× expansion). The planner handles identifier quoting, table aliasing, parameter binding, and column qualification automatically.

</details>






Standard operator precedence: `*`, `/`, `%` bind tighter than `+`, `-`.

---

## 5. Includes (Relations)

### Nested JSON (Default)

Select columns from related tables to auto-include them. The planner uses
`json_agg` to aggregate children into a single JSON array per parent row:

**blog:**
```nql
# Include all post columns as nested JSON array
authors | select *, posts.*
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT
  authors.*,
  COALESCE((SELECT json_agg(to_jsonb(__t__))
  
  FROM posts AS __t__
  
  WHERE
    __t__."authorId" = authors.id), '[]'::json) AS posts_json

  FROM authors
```

**Parameters:** _none_

**Planner decisions:**
| Decision | Context | Choice | Reasoning |
|----------|---------|--------|-----------|
| include-strategy | authors → posts | json_agg | Relation authors.posts (hasMany, cardinality: many) - using JSON aggregation to avoid row explosion |

**Why NQL?** Even the simplest query benefits from the planner: table names are double-quoted (safe for reserved words), aliases are generated, and the result is a fully parameterized query ready for `pg.Pool.query()`.

</details>






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
```nql
# Include specific columns from relation (column projection)
orders | select id, customer.firstName, customer.email

# Deep nesting
orderItems | select id, product.name, product.category.name
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT
  orders.id,
COALESCE((SELECT json_agg(jsonb_build_object('firstName', __t__."firstName", 'email', __t__.email))

  FROM customers AS __t__

  WHERE
  __t__.id = orders."customerId"), '[]'::json) AS customer_json

  FROM orders
```

**Parameters:** _none_

**Planner decisions:**
| Decision | Context | Choice | Reasoning |
|----------|---------|--------|-----------|
| include-strategy | orders → customers | json_agg | Relation orders.customer (belongsTo, cardinality: one) - using JSON aggregation to avoid row explosion |

**Why NQL?** This 54-character NQL expression compiles to 225 characters of SQL (4.2× expansion). The planner handles identifier quoting, table aliasing, parameter binding, and column qualification automatically.

</details>






When you select specific relation columns (not `relation.*`), the planner
projects only those columns inside the JSON aggregate:

```sql
-- orders | select id, customer.firstName, customer.email
SELECT orders.id,
  COALESCE((SELECT json_agg(jsonb_build_object('first_name', __t__.first_name, 'email', __t__.email))
    FROM customers AS __t__ WHERE __t__.id = orders.customer_id), '[]'::json) AS customer_json
FROM orders
```

Compare with `relation.*` which uses the full row:

```sql
-- orders | select id, customer.*
SELECT orders.id,
  COALESCE((SELECT json_agg(to_jsonb(__t__))
    FROM customers AS __t__ WHERE __t__.id = orders.customer_id), '[]'::json) AS customer_json
FROM orders
```

### Flat Mode

Use `| flat` to get flat rows instead of nested JSON. The planner picks the
best SQL strategy automatically:

**LEFT JOIN** — default for `| flat` (simple, well-optimized by PostgreSQL):
```nql
# All columns → LEFT JOIN
authors | select *, posts.* | flat

# Specific columns → LEFT JOIN with column projection
authors | select id, posts.title, posts.createdAt | flat
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT
  authors.*,
  posts.*

  FROM authors

  LEFT JOIN posts AS posts ON authors.id = posts."authorId"
```

**Parameters:** _none_

**Planner decisions:**
| Decision | Context | Choice | Reasoning |
|----------|---------|--------|-----------|
| include-strategy | authors → posts | join | Relation authors.posts (hasMany, cardinality: many) - using JOIN for efficient single-query fetch |
| join-type | authors → posts | left | Relation authors.posts is optional without filter - using LEFT JOIN to preserve parent rows without matches |

**Why NQL?** This 34-character NQL expression compiles to 100 characters of SQL (2.9× expansion). The planner handles identifier quoting, table aliasing, parameter binding, and column qualification automatically.

</details>






```sql
-- Produced SQL (LEFT JOIN):
SELECT authors.*, posts."title", posts."createdAt"
FROM authors LEFT JOIN posts ON authors.id = posts.author_id
```

**LATERAL JOIN** — used when a per-include LIMIT caps children per parent:
```nql
# Top 3 posts per author → LATERAL subquery
authors | select *, posts.* | limit posts 3 | flat

# Without explicit | flat — per-include limit implies flat automatically
authors | select *, posts.* | limit posts 3
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT
  authors.*,
  posts_lat_0.*

  FROM authors

  LEFT JOIN 
  LATERAL ( SELECT posts_inner_0.*

  FROM posts AS posts_inner_0

  WHERE
  posts_inner_0."authorId" = authors.id

  LIMIT 3 ) AS posts_lat_0 ON true
```

**Parameters:** _none_

**Planner decisions:**
| Decision | Context | Choice | Reasoning |
|----------|---------|--------|-----------|
| include-strategy | authors → posts | lateral | Relation authors.posts (hasMany, cardinality: many) - using LATERAL JOIN for per-row correlated subquery (LIMIT per parent) |

**Why NQL?** This 50-character NQL expression compiles to 198 characters of SQL (4.0× expansion). The planner handles identifier quoting, table aliasing, parameter binding, and column qualification automatically.

</details>






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
```nql
posts | select *, tags.*
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT
  posts.*,
  tags.* AS "tags.*"

  FROM posts
```

**Parameters:** _none_

**Why NQL?** Even the simplest query benefits from the planner: table names are double-quoted (safe for reserved words), aliases are generated, and the result is a fully parameterized query ready for `pg.Pool.query()`.

</details>






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
```nql
posts | select count(*)
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT count(*)

  FROM posts
```

**Parameters:** _none_

**Why NQL?** Even the simplest query benefits from the planner: table names are double-quoted (safe for reserved words), aliases are generated, and the result is a fully parameterized query ready for `pg.Pool.query()`.

</details>






**ecommerce:**
```nql
orders | select sum(total)
orders | select avg(total)
products | select min(price), max(price)
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT
  min(products.price),
  max(products.price)

  FROM products
```

**Parameters:** _none_

**Why NQL?** This 94-character NQL expression compiles to 65 characters of SQL (0.7× expansion). The planner handles identifier quoting, table aliasing, parameter binding, and column qualification automatically.

</details>






### COUNT DISTINCT

**ecommerce:**
```nql
orders | select count(distinct customerId) as uniqueCustomers
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT count(DISTINCT orders."customerId") AS "uniqueCustomers"

  FROM orders
```

**Parameters:** _none_

**Why NQL?** This 61-character NQL expression compiles to 75 characters of SQL (1.2× expansion). The planner handles identifier quoting, table aliasing, parameter binding, and column qualification automatically.

</details>






### GROUP BY

**ecommerce:**
```nql
orders | group by status | select status, count(*) as total
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT
  orders.status,
  count(*) AS total

  FROM orders

  GROUP BY
  orders.status
```

**Parameters:** _none_

**Why NQL?** The planner automatically validates that all non-aggregate columns appear in the GROUP BY clause — a common SQL error. NQL's pipe syntax keeps the grouping, filtering, and aggregation steps visually separated, making the query intent clear at a glance.

</details>






**blog:**
```nql
posts | group by authorId | select authorId, count(*)
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT
  posts."authorId",
  count(*)

  FROM posts

  GROUP BY
  posts."authorId"
```

**Parameters:** _none_

**Why NQL?** The planner automatically validates that all non-aggregate columns appear in the GROUP BY clause — a common SQL error. NQL's pipe syntax keeps the grouping, filtering, and aggregation steps visually separated, making the query intent clear at a glance.

</details>






### WHERE vs HAVING

Position relative to `group by` determines behavior:

**ecommerce:**
```nql
# WHERE — filters individual rows (before grouping)
orders | where total > 100 | group by status | select status, count(*)

# HAVING — filters aggregated groups (after grouping)
orders | group by status | where count(*) > 10 | select status, count(*)
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT
  orders.status,
  count(*)

  FROM orders

  WHERE
  orders.total > $1

  GROUP BY
  orders.status
```

**Parameters:** `[100]`

**Why NQL?** The planner automatically validates that all non-aggregate columns appear in the GROUP BY clause — a common SQL error. NQL's pipe syntax keeps the grouping, filtering, and aggregation steps visually separated, making the query intent clear at a glance.

</details>






---

## 7. ORDER BY, LIMIT, OFFSET

### Sorting

**blog:**
```nql
authors | order by name
posts | order by createdAt desc
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT posts.*

  FROM posts

  ORDER BY
  posts."createdAt" DESC
```

**Parameters:** _none_

**Why NQL?** This 55-character NQL expression compiles to 59 characters of SQL (1.1× expansion). The planner handles identifier quoting, table aliasing, parameter binding, and column qualification automatically.

</details>






**ecommerce:**
```nql
customers | order by lastName asc, firstName asc
products | order by price desc
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT products.*

  FROM products

  ORDER BY
  products.price DESC
```

**Parameters:** _none_

**Why NQL?** This 79-character NQL expression compiles to 62 characters of SQL (0.8× expansion). The planner handles identifier quoting, table aliasing, parameter binding, and column qualification automatically.

</details>






### Pagination

**blog:**
```nql
posts | order by createdAt desc | limit 10
posts | order by createdAt desc | limit 10 | offset 20
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT posts.*

  FROM posts

  ORDER BY
  posts."createdAt" DESC

  LIMIT 10
OFFSET 20
```

**Parameters:** _none_

**Why NQL?** This 97-character NQL expression compiles to 78 characters of SQL (0.8× expansion). The planner handles identifier quoting, table aliasing, parameter binding, and column qualification automatically.

</details>






### Three Forms of LIMIT

NQL has three distinct uses of LIMIT. They look similar but have very different semantics:

#### 1. Outer Limit — `| limit N`

Caps the total number of rows returned by the query:

**blog:**
```nql
# Return at most 10 posts
posts | order by createdAt desc | limit 10
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT posts.*

  FROM posts

  ORDER BY
  posts."createdAt" DESC

  LIMIT 10
```

**Parameters:** _none_

**Why NQL?** This 42-character NQL expression compiles to 68 characters of SQL (1.6× expansion). The planner handles identifier quoting, table aliasing, parameter binding, and column qualification automatically.

</details>






```sql
SELECT * FROM posts ORDER BY created_at DESC LIMIT 10
```

#### 2. Per-Include Limit — `| limit <relation> N`

Caps child rows **per parent** using a LATERAL JOIN:

**blog:**
```nql
# Top 3 posts PER author
authors | select id, name, posts.* | limit posts 3
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT
  authors.id,
  authors.name,
  posts_lat_0.*

  FROM authors

  LEFT JOIN 
  LATERAL ( SELECT posts_inner_0.*

  FROM posts AS posts_inner_0

  WHERE
  posts_inner_0."authorId" = authors.id

  LIMIT 3 ) AS posts_lat_0 ON true
```

**Parameters:** _none_

**Planner decisions:**
| Decision | Context | Choice | Reasoning |
|----------|---------|--------|-----------|
| include-strategy | authors → posts | lateral | Relation authors.posts (hasMany, cardinality: many) - using LATERAL JOIN for per-row correlated subquery (LIMIT per parent) |

**Why NQL?** This 50-character NQL expression compiles to 215 characters of SQL (4.3× expansion). The planner handles identifier quoting, table aliasing, parameter binding, and column qualification automatically.

</details>






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
```nql
# Customers whose ID appears in the first 5 delivered orders
customers | where id in (orders | select customerId | where status = 'delivered' | limit 5)
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT customers.*

  FROM customers

  WHERE
  customers.id = ANY (SELECT orders_subq_0."customerId"

  FROM orders AS orders_subq_0

  WHERE
  orders_subq_0.status = $1

  LIMIT 5)
  AND EXISTS (SELECT 1

  FROM orders AS orders_exists_1

  WHERE
  customers.id = orders_exists_1."customerId")
```

**Parameters:** `["delivered"]`

**Planner decisions:**
| Decision | Context | Choice | Reasoning |
|----------|---------|--------|-----------|
| filter-strategy | customers → orders | exists | Relation customers.orders has cardinality "many" - using EXISTS to avoid row explosion |

**Why NQL?** Subqueries in NQL compose naturally — the inner query is just another NQL pipe expression inside parentheses. The planner compiles it as a correlated or uncorrelated subquery depending on context, handling aliasing and parameter numbering automatically.

</details>






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
```nql
# Top 5 order items per order
orders | select id, orderNumber, orderItems.* | limit orderItems 5

# Multiple per-include limits on different relations
customers | select id, orders.*, addresses.* | limit orders 3 | limit addresses 2

# Combined: 3 orders per customer, max 10 customers
customers | select id, orders.* | limit orders 3 | limit 10
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT
  orders.id,
  orders."orderNumber",
  "orderItems".* AS "orderItems.*",
  "orderItems_lat_0".*

  FROM orders

  LEFT JOIN 
  LATERAL ( SELECT "orderItems_inner_0".*

  FROM "orderItems" AS "orderItems_inner_0"

  WHERE
  "orderItems_inner_0"."orderId" = orders.id

  LIMIT 5 ) AS "orderItems_lat_0" ON true
```

**Parameters:** _none_

**Planner decisions:**
| Decision | Context | Choice | Reasoning |
|----------|---------|--------|-----------|
| include-strategy | orders → orderItems | lateral | Relation orders.order_orderItems (hasMany, cardinality: many) - using LATERAL JOIN for per-row correlated subquery (LIMIT per parent) |

**Why NQL?** This 66-character NQL expression compiles to 297 characters of SQL (4.5× expansion). The planner handles identifier quoting, table aliasing, parameter binding, and column qualification automatically.

</details>






**hierarchy:**
```nql
# Top 2 employees per department
departments | select id, name, employees.* | limit employees 2

# Combined: 2 employees per department, max 5 departments
departments | select id, name, employees.* | limit employees 2 | limit 5
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT
  departments.id,
  departments.name,
  employees_lat_0.*

  FROM departments

  LEFT JOIN 
  LATERAL ( SELECT employees_inner_0.*

  FROM employees AS employees_inner_0

  WHERE
  employees_inner_0."departmentId" = departments.id

  LIMIT 2 ) AS employees_lat_0 ON true
```

**Parameters:** _none_

**Planner decisions:**
| Decision | Context | Choice | Reasoning |
|----------|---------|--------|-----------|
| include-strategy | departments → employees | lateral | Relation departments.employees (hasMany, cardinality: many) - using LATERAL JOIN for per-row correlated subquery (LIMIT per parent) |

**Why NQL?** This 62-character NQL expression compiles to 259 characters of SQL (4.2× expansion). The planner handles identifier quoting, table aliasing, parameter binding, and column qualification automatically.

</details>






**dotted-path (deep nesting):**
```nql
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

```nql
function() over ([partition by expr] [order by expr [asc|desc]])
```

### Row Numbering

**ecommerce:**
```nql
products | select name, row_number() over (order by price) as rn
products | select name, rank() over (partition by categoryId order by price desc) as priceRank
products | select name, dense_rank() over (order by price) as dr
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT
  products.name,
  dense_rank() OVER (
  ORDER BY products.price ASC) AS dr

  FROM products
```

**Parameters:** _none_

**Why NQL?** Window functions in raw SQL require the full `OVER (PARTITION BY ... ORDER BY ...)` clause on each expression. NQL's pipe syntax makes the window definition read naturally as part of the select list, and the planner validates partition/order columns exist.

</details>






### Lag / Lead (Previous / Next Row)

**ecommerce:**
```nql
orders | select orderNumber, total, lag(total) over (order by createdAt) as prevTotal
orders | select orderNumber, total, lead(total) over (order by createdAt) as nextTotal
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT
  orders."orderNumber",
  orders.total,
  lead(orders.total) OVER (
  ORDER BY orders."createdAt" ASC) AS "nextTotal"

  FROM orders
```

**Parameters:** _none_

**Why NQL?** This 172-character NQL expression compiles to 133 characters of SQL (0.8× expansion). The planner handles identifier quoting, table aliasing, parameter binding, and column qualification automatically.

</details>






### Aggregate Windows

**ecommerce:**
```nql
orders | select orderNumber, total, sum(total) over (order by createdAt) as runningTotal
orderItems | select orderId, totalPrice, sum(totalPrice) over (partition by orderId) as orderTotal
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT
  "orderItems"."orderId",
  "orderItems"."totalPrice",
  sum("orderItems"."totalPrice") OVER (PARTITION BY "orderItems"."orderId") AS "orderTotal"

  FROM "orderItems"
```

**Parameters:** _none_

**Why NQL?** This 187-character NQL expression compiles to 171 characters of SQL (0.9× expansion). The planner handles identifier quoting, table aliasing, parameter binding, and column qualification automatically.

</details>






### Empty OVER

**ecommerce:**
```nql
products | select name, count(*) over () as totalProducts
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT
  products.name,
  count(*) OVER () AS "totalProducts"

  FROM products
```

**Parameters:** _none_

**Why NQL?** This 57-character NQL expression compiles to 75 characters of SQL (1.3× expansion). The planner handles identifier quoting, table aliasing, parameter binding, and column qualification automatically.

</details>






---

## 9. CASE Expressions

**ecommerce:**
```nql
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

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT
  CASE 
    WHEN products.price > $1 THEN $2 
  END

  FROM products
```

**Parameters:** `[100, "expensive"]`

**Why NQL?** CASE expressions in the SELECT list let you compute derived columns inline. The planner ensures the expression is well-formed and parameter binds any literal values, preventing SQL injection even in conditional logic.

</details>






**hierarchy:**
```nql
employees | select name, case
  when salary > 100000 then 'senior'
  when salary > 60000 then 'mid'
  else 'junior'
end as level
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT
  employees.name,
  CASE 
    WHEN employees.salary > $1 THEN $2 
    WHEN employees.salary > $3 THEN $4 
    ELSE $5 
  END AS level

  FROM employees
```

**Parameters:** `[100000, "senior", 60000, "mid", "junior"]`

**Why NQL?** CASE expressions in the SELECT list let you compute derived columns inline. The planner ensures the expression is well-formed and parameter binds any literal values, preventing SQL injection even in conditional logic.

</details>






---

## 10. Hierarchy / Recursive Traversal

> Load: `pnpm dbsp repl -s examples/hierarchy.schema.ts`

Requires a schema with self-referential `ref()` and `roles` configured.

### Single-Hop Traversal

**hierarchy:**
```nql
# Direct parent
employees | select name, title, manager.name

# Chained: grandparent
employees | select name, manager.name, manager.manager.name
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
SELECT
  employees.name,
  employees.title,
COALESCE((SELECT json_agg(jsonb_build_object('name', __t__.name))

  FROM employees AS __t__

  WHERE
  __t__.id = employees."managerId"), '[]'::json) AS manager_json

  FROM employees
```

**Parameters:** _none_

**Planner decisions:**
| Decision | Context | Choice | Reasoning |
|----------|---------|--------|-----------|
| include-strategy | employees → employees | json_agg | Relation employees.manager (belongsTo, cardinality: one) - using JSON aggregation to avoid row explosion |

**Why NQL?** This 44-character NQL expression compiles to 219 characters of SQL (5.0× expansion). The planner handles identifier quoting, table aliasing, parameter binding, and column qualification automatically.

</details>






### Recursive Ancestors

**hierarchy:**
```nql
# Full ancestor chain as JSON array
employees | select name, managementChain.*

# Specific columns from ancestors
employees | select name, managementChain.name, managementChain.title
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
WITH
   
  managementChain_cte AS (SELECT employees_inner_0.*
  
  FROM employees AS employees_inner_0)
SELECT employees.name

  FROM employees

  LEFT JOIN "managementChain_cte" AS "managementChain_ref_0" ON employees.id = "managementChain_ref_0"."managerId"
```

**Parameters:** _none_

**Planner decisions:**
| Decision | Context | Choice | Reasoning |
|----------|---------|--------|-----------|
| include-strategy | employees → employees | cte | Recursive include on self-referential relation "managementChain" → forced CTE strategy |

**Why NQL?** This 42-character NQL expression compiles to 247 characters of SQL (5.9× expansion). The planner handles identifier quoting, table aliasing, parameter binding, and column qualification automatically.

</details>






### Recursive Descendants

**hierarchy:**
```nql
# Full descendant chain
employees | select name, allReports.*

# Specific columns
employees | select name, allReports.name
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
WITH
   
  allReports_cte AS (SELECT employees_inner_0.*
  
  FROM employees AS employees_inner_0)
SELECT employees.name

  FROM employees

  LEFT JOIN "allReports_cte" AS "allReports_ref_0" ON employees.id = "allReports_ref_0"."managerId"
```

**Parameters:** _none_

**Planner decisions:**
| Decision | Context | Choice | Reasoning |
|----------|---------|--------|-----------|
| include-strategy | employees → employees | cte | Recursive include on self-referential relation "allReports" → forced CTE strategy |

**Why NQL?** This 37-character NQL expression compiles to 227 characters of SQL (6.1× expansion). The planner handles identifier quoting, table aliasing, parameter binding, and column qualification automatically.

</details>






> The role names (`manager`, `managementChain`, `allReports`) come from the schema's `roles` option on the self-referential `ref()`.

---

## 11. Mutations

### INSERT

**ecommerce:**
```nql
insert into products set sku = 'IPH-15', name = 'iPhone', price = 999, categoryId = 1

# With RETURNING (pipe to select)
insert into products set sku = 'IPH-15', name = 'iPhone', price = 999, categoryId = 1 | select id, name
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
INSERT INTO products (
  sku,
  name,
  price,
  "categoryId"
) VALUES
  (
    $1,
    $2,
    $3,
    $4
  )
```

**Parameters:** `["IPH-15", "iPhone", 999, 1]`

**Why NQL?** `INSERT` mutations are automatically parameterized — every value becomes a `$N` placeholder, preventing SQL injection. Column names are validated against the schema and double-quoted in the output SQL.

</details>






**blog:**
```nql
insert into authors set name = 'Alice', email = 'alice@example.com'
insert into posts set title = 'Hello', slug = 'hello', authorId = 1 | select id, title
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
INSERT INTO posts (
  title,
  slug,
  "authorId"
) VALUES
  (
    $1,
    $2,
    $3
  ) 
  RETURNING posts.id AS id, posts.title AS title
```

**Parameters:** `["Hello", "hello", 1]`

**Why NQL?** `INSERT` mutations are automatically parameterized — every value becomes a `$N` placeholder, preventing SQL injection. Column names are validated against the schema and double-quoted in the output SQL.

</details>






### INSERT FROM (Bulk Copy)

**ecommerce:**
```nql
# Copy rows from a filtered query
insert into orderItems from orderItems | where orderId = 1

# With limit
insert into orderItems from orderItems | where orderId = 1 | limit 10

# With RETURNING
insert into addresses from addresses | where customerId = 5 | select id
```

### UPDATE

**ecommerce:**
```nql
update products set price = 899 where id = 1

# With RETURNING
update orders set status = 'shipped' where id = 1 | select id, status
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
UPDATE products SET price = $1 
  WHERE products.id = $2
```

**Parameters:** `[899, 1]`

**Why NQL?** `UPDATE` mutations are automatically parameterized — every value becomes a `$N` placeholder, preventing SQL injection. Column names are validated against the schema and double-quoted in the output SQL.

</details>






**blog:**
```nql
update posts set published = true where authorId = 1
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
UPDATE posts SET published = $1 
  WHERE posts."authorId" = $2
```

**Parameters:** `[true, 1]`

**Why NQL?** `UPDATE` mutations are automatically parameterized — every value becomes a `$N` placeholder, preventing SQL injection. Column names are validated against the schema and double-quoted in the output SQL.

</details>






### DELETE

**ecommerce:**
```nql
delete from products where id = 1
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
DELETE 
  FROM products 
  WHERE products.id = $1
```

**Parameters:** `[1]`

**Why NQL?** `DELETE` mutations are automatically parameterized — every value becomes a `$N` placeholder, preventing SQL injection. Column names are validated against the schema and double-quoted in the output SQL.

</details>






**blog:**
```nql
delete from comments where approved = false
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
DELETE 
  FROM comments 
  WHERE comments.approved = $1
```

**Parameters:** `[false]`

**Why NQL?** `DELETE` mutations are automatically parameterized — every value becomes a `$N` placeholder, preventing SQL injection. Column names are validated against the schema and double-quoted in the output SQL.

</details>






### UPSERT (ON CONFLICT)

Insert a row, or update it if a conflict occurs on the specified column(s).

**Syntax:**
```nql
upsert into <table> on <column> set <col> = <val>, ...
upsert into <table> on (<col1>, <col2>) set <col> = <val>, ...
```

**ecommerce:**
```nql
# Single conflict column
upsert into customers on email set firstName = 'Alice', lastName = 'Smith', email = 'alice@example.com'

# Multiple conflict columns
upsert into orderItems on (orderId, productId) set quantity = 2, unitPrice = 29.99, totalPrice = 59.98
```

<details>
<summary>Compiled SQL & Plan</summary>

**SQL:**
```sql
INSERT INTO customers (
  "firstName",
  "lastName",
  email
) VALUES
  (
    $1,
    $2,
    $3
  ) 
  ON CONFLICT (email) DO UPDATE SET 
  "firstName" = excluded."firstName",
  "lastName" = excluded."lastName",
  email = excluded.email
```

**Parameters:** `["Alice", "Smith", "alice@example.com"]`

**Why NQL?** `UPSERT` compiles to `INSERT ... ON CONFLICT DO UPDATE` — PostgreSQL's atomic "insert-or-update" operation. NQL makes the conflict resolution readable in one line instead of the multi-clause SQL pattern.

</details>






**Generated SQL (single conflict column):**
```sql
INSERT INTO customers (first_name, last_name, email)
VALUES ($1, $2, $3)
ON CONFLICT (email)
DO UPDATE SET
  first_name = EXCLUDED.first_name,
  last_name  = EXCLUDED.last_name,
  email      = EXCLUDED.email
```

**Generated SQL (composite conflict columns):**
```sql
INSERT INTO order_items (quantity, unit_price, total_price, order_id, product_id)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (order_id, product_id)
DO UPDATE SET
  quantity    = EXCLUDED.quantity,
  unit_price  = EXCLUDED.unit_price,
  total_price = EXCLUDED.total_price
```

- The `on` clause specifies the unique constraint column(s) for conflict detection
- `DO UPDATE SET` automatically uses `EXCLUDED.<column>` references to update with the new values
- All values are parameterized (`$1`, `$2`, ...) — no SQL injection risk

### Mutation Chaining with BIND

Chain mutations where the second uses results from the first:

**ecommerce:**
```nql
insert into orders set customerId = 1, orderNumber = 'ORD-100', total = 59.99, shippingAddressId = 1, billingAddressId = 1 | bind order
insert into orderItems set orderId = order.id, productId = 5, quantity = 2, unitPrice = 29.99, totalPrice = 59.98
```

---

## 12. Advanced Features

### Bind (CTEs)

Capture a query result as a named CTE for use in subsequent statements:

**ecommerce:**
```text
products | where active = true | bind activeProducts
insert into featuredProducts from activeProducts
```

**blog:**
```text
posts | where published = true | order by createdAt desc | limit 10 | bind recentPosts
insert into highlights from recentPosts
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

```text
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

**Query:** `select`, `where`, `flat`, `via`, `bind`, `group`, `by`, `order`, `limit`, `offset`, `distinct`

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
