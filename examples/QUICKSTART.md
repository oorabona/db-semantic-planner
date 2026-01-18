# Quickstart Guide

A progressive tutorial to learn db-semantic-planner from basic to advanced queries.

---

## Prerequisites

```bash
# Clone the repo
git clone https://github.com/your-org/db-semantic-planner
cd db-semantic-planner

# Install dependencies
pnpm install
```

---

## Part 1: First Steps (5 min)

Let's start with the simplest possible queries using the **minimal schema** (users + posts).

### Start the REPL

```bash
pnpm dbsp repl --schema ./examples/minimal.schema.ts
```

You'll see:
```
db-semantic-planner REPL
Schema: ./examples/minimal.schema.ts
Mode: compile (use .exec to enable execution)

dbsp>
```

### Explore the Schema

**List all tables:**
```
dbsp> .tables
```
Output:
```
Tables (2):
  - users
  - posts
```

**Show table columns:**
```
dbsp> .schema users
```
Output:
```
Table: users
Columns:
  - id: integer (NOT NULL)
  - name: string (NOT NULL)
  - email: string (NOT NULL)
```

**Show relations:**
```
dbsp> .relations posts
```
Output:
```
Relations for posts:
  - users.posts: hasMany → posts
```

### Your First Query

Simply type a table name to select all rows:

```
dbsp> users
```
Output:
```
Main SQL:
select "t0".* from "users" as "t0"
```

The REPL shows the generated SQL without executing it. This is **planning mode** - perfect for understanding what SQL will be generated.

**Try `posts`:**
```
dbsp> posts
```
Output:
```
Main SQL:
select "t0".* from "posts" as "t0"
```

### Get Help

```
dbsp> .help
```

### Exit

```
dbsp> .quit
```

---

## Part 2: Filtering with WHERE (10 min)

Now let's add conditions to our queries.

### Simple Equality

```
dbsp> posts where published = true
```
Output:
```
Main SQL:
select "t0".* from "posts" as "t0" where "t0"."published" = $1

Parameters: [true]
```

Notice the **parameterized query** - values are bound safely, preventing SQL injection.

### Multiple Conditions

Use `and` / `or` to combine conditions:

```
dbsp> posts where published = true and authorId = 1
```
Output:
```
Main SQL:
select "t0".* from "posts" as "t0" where "t0"."published" = $1 and "t0"."authorId" = $2

Parameters: [true, 1]
```

### Comparison Operators

| Operator | Meaning |
|----------|---------|
| `=` | Equals |
| `!=` | Not equals |
| `>`, `<` | Greater/less than |
| `>=`, `<=` | Greater/less or equal |

```
dbsp> users where id > 5
```
Output:
```
Main SQL:
select "t0".* from "users" as "t0" where "t0"."id" > $1

Parameters: [5]
```

### Limit and Offset

```
dbsp> posts limit 10
```
Output:
```
Main SQL:
select "t0".* from "posts" as "t0" limit $1

Parameters: [10]
```

```
dbsp> posts limit 10 offset 20
```
Output:
```
Main SQL:
select "t0".* from "posts" as "t0" limit $1 offset $2

Parameters: [10, 20]
```

---

## Part 3: Relations and Includes (15 min)

Let's switch to the **blog schema** which has richer relations.

```bash
pnpm dbsp repl --schema ./examples/blog.schema.ts
```

### Explore Blog Schema

```
dbsp> .tables
```
Output:
```
Tables (5):
  - authors
  - posts
  - comments
  - tags
  - postTags
```

```
dbsp> .relations posts
```
Output:
```
Relations for posts:
  - tags.posts: manyToMany → posts
  - authors.posts: hasMany → posts
  - comments.post: belongsTo → posts
```

### Include Related Data

Instead of writing JOINs, use `include`:

```
dbsp> posts include author
```
Output:
```
Main SQL:
select "t0".*, "t1"."id" as "author.id", "t1"."name" as "author.name",
       "t1"."email" as "author.email", "t1"."bio" as "author.bio",
       "t1"."createdAt" as "author.createdAt"
from "posts" as "t0"
left join "authors" as "t1" on "t0"."authorId" = "t1"."id"

Plan:
  Strategy: include-strategy: join, join-type: left
  Tables: posts, author
```

### Nested Includes

Include multiple levels of relations:

```
dbsp> posts include author include comments
```
Output:
```
Main SQL:
select "t0".*, "t1"."id" as "author.id", "t1"."name" as "author.name", ...
from "posts" as "t0"
left join "authors" as "t1" on "t0"."authorId" = "t1"."id"

Separate Query (comments):
select "t1".* from "comments" as "t1" where "t1"."postId" in (...)
```

### Filter with Includes

Combine filtering and includes:

```
dbsp> posts where published = true include author
```
Output:
```
Main SQL:
select "t0".*, "t1"."id" as "author.id", ...
from "posts" as "t0"
left join "authors" as "t1" on "t0"."authorId" = "t1"."id"
where "t0"."published" = $1

Parameters: [true]
```

---

## Part 4: Aggregates and Grouping (15 min)

Aggregate functions let you summarize data.

### Count

```
dbsp> posts select count(*) as total
```
Output:
```
Main SQL:
select count(*) as "total" from "posts" as "t0"

Plan:
  Strategy: aggregate
  Tables: posts
```

### Multiple Aggregates

```
dbsp> posts select count(*) as total, sum(views) as total_views
```
Output:
```
Main SQL:
select count(*) as "total", sum("t0"."views") as "total_views"
from "posts" as "t0"
```

### Group By

```
dbsp> posts select count(*) as post_count group by authorId
```
Output:
```
Main SQL:
select "t0"."authorId", count(*) as "post_count"
from "posts" as "t0"
group by "t0"."authorId"

Plan:
  Strategy: aggregate, group-by
  Tables: posts
```

### Having Clause

```
dbsp> posts select count(*) as post_count group by authorId having count(*) > 5
```
Output:
```
Main SQL:
select "t0"."authorId", count(*) as "post_count"
from "posts" as "t0"
group by "t0"."authorId"
having count(*) > $1

Parameters: [5]
```

### Distinct

```
dbsp> posts select distinct authorId
```
Output:
```
Main SQL:
select distinct "t0"."authorId" from "posts" as "t0"
```

```
dbsp> posts select count(distinct authorId) as unique_authors
```
Output:
```
Main SQL:
select count(distinct "t0"."authorId") as "unique_authors" from "posts" as "t0"
```

---

## Part 5: Advanced Features (20 min)

### 5.1 Recursive Includes (Hierarchical Data)

Switch to the **e-commerce schema** which has hierarchical categories:

```bash
pnpm dbsp repl --schema ./examples/ecommerce.schema.ts
```

**Check the schema:**
```
dbsp> .tables
```
Output:
```
Tables (6):
  - categories
  - products
  - productVariants
  - customers
  - orders
  - orderItems
```

```
dbsp> .schema categories
```
Output:
```
Table: categories
Columns:
  - id: integer (NOT NULL)
  - name: string (NOT NULL)
  - slug: string (NOT NULL)
  - parentId: integer
  - sortOrder: integer (NOT NULL)
```

**Recursive include - get all descendants:**

```
dbsp> categories where id = 1 include all children
```
Output:
```
Main SQL:
with recursive "cte_categories_children" as (
  select * from "categories" where "parentId" is null
  union all
  select "t".* from "categories" as "t"
  inner join "cte_categories_children" as "c" on "t"."parentId" = "c"."id"
)
select "t0".*, "t1"."id" as "children.id", "t1"."name" as "children.name", ...
from "categories" as "t0"
left join "cte_categories_children" as "t1" on "t1"."parentId" = "t0"."id"
where "t0"."id" = $1

Parameters: [1]

Plan:
  Strategy: include-strategy: cte
  Tables: categories, children
```

**Recursive include - get all ancestors:**

```
dbsp> categories where id = 5 include all parent
```
Output:
```
Main SQL:
with recursive "cte_categories_parent" as (
  select * from "categories" where "id" = $1
  union all
  select "t".* from "categories" as "t"
  inner join "cte_categories_parent" as "c" on "t"."id" = "c"."parentId"
)
select "t0".*, "t1"."id" as "parent.id", "t1"."name" as "parent.name", ...
from "categories" as "t0"
left join "cte_categories_parent" as "t1" on "t0"."parentId" = "t1"."id"
where "t0"."id" = $2

Parameters: [5, 5]

Plan:
  Strategy: include-strategy: cte
  Tables: categories, parent
```

**Depth control:**

```
# Limit recursion to 10 levels
dbsp> categories include all children depth 10

# Include a depth column
dbsp> categories include all children with depth

# Combine both
dbsp> categories include all children depth 10 with depth
```

### 5.2 Range Operators (PostgreSQL)

PostgreSQL **range types** let you store and query intervals:
- `daterange` — date intervals (e.g., booking periods)
- `tstzrange` — timestamp intervals (e.g., event time slots)
- `int4range` — integer intervals (e.g., price tiers by quantity)

Ranges are powerful for:
- **Scheduling**: Check if bookings overlap
- **Pricing**: Find which tier applies for a quantity
- **Availability**: Test if a time slot is within a period

> **Note:** In the schema, range columns use `type: 'string'` because PostgreSQL handles range syntax internally. The planner recognizes range operators and compiles them to PostgreSQL's native range functions (`&&`, `@>`, `<@`).

Switch to the **scheduling schema** which demonstrates range types:

```bash
pnpm dbsp repl --schema ./examples/scheduling.schema.ts
```

**Find bookings overlapping a date range:**
```
dbsp> room_bookings where booking_period overlaps [2024-01-15,2024-01-20)
```

**Shorthand range syntax:**
```
dbsp> events where time_slot overlaps 2024-01-01..2024-01-31
```

**Range contains element:**
```
dbsp> price_tiers where quantity_range contains 25
```

**Range operators reference:**

| Operator | Description | Example |
|----------|-------------|---------|
| `overlaps` | Ranges overlap | `where period overlaps [start,end)` |
| `contains` | Range contains element | `where range contains 25` |
| `containedBy` | Range within another | `where range containedBy [start,end]` |

---

## Part 6: Live Database Execution (20 min)

So far, we've been in **planning mode** (showing SQL without executing). Now let's run queries against a real database.

### Prerequisites

```bash
# Start PostgreSQL (Docker)
docker run -d --name pg-demo -e POSTGRES_PASSWORD=demo -p 5432:5432 oorabona/postgres:17-full-alpine

# Create database
createdb -h localhost -U postgres demo
```

### Setup with Minimal Schema

```bash
# Generate DDL from schema
pnpm dbsp generate ddl --schema ./examples/minimal.schema.ts > /tmp/minimal.sql

# Apply to database
psql -h localhost -U postgres -d demo -f /tmp/minimal.sql

# (Optional) Seed sample data
psql -h localhost -U postgres -d demo -f ./examples/seed/minimal.seed.sql
```

### Connect REPL to Database

```bash
pnpm dbsp repl \
  --schema ./examples/minimal.schema.ts \
  --db postgresql://postgres:demo@localhost:5432/demo
```

### Planning Mode (Default)

Queries show SQL without executing:

```
dbsp> users
```
Output:
```
Main SQL:
select "t0".* from "users" as "t0"
```

### Enable Execution Mode

```
dbsp> .exec
```
Output:
```
Execution mode: ENABLED
Queries will now execute against the database.
```

**Now queries return real data:**

```
dbsp> users
```
Output:
```
┌────┬────────────┬─────────────────────┐
│ id │ name       │ email               │
├────┼────────────┼─────────────────────┤
│  1 │ Alice      │ alice@example.com   │
│  2 │ Bob        │ bob@example.com     │
│  3 │ Charlie    │ charlie@example.com │
└────┴────────────┴─────────────────────┘
3 rows (12ms)
```

**Filter with real results:**

```
dbsp> posts where published = true
```
Output:
```
┌────┬──────────────────┬───────────┬──────────┐
│ id │ title            │ published │ authorId │
├────┼──────────────────┼───────────┼──────────┤
│  1 │ Hello World      │ true      │        1 │
│  3 │ Getting Started  │ true      │        2 │
└────┴──────────────────┴───────────┴──────────┘
2 rows (8ms)
```

### Toggle Back to Planning Mode

```
dbsp> .compile
```
Output:
```
Execution mode: DISABLED
Queries will show SQL only.
```

### Raw SQL Escape Hatch

Prefix with `!` to execute raw SQL:

```
dbsp> !SELECT version()
```
Output:
```
┌──────────────────────────────────────────────────┐
│ version                                          │
├──────────────────────────────────────────────────┤
│ PostgreSQL 16.1 on x86_64-pc-linux-gnu, ...      │
└──────────────────────────────────────────────────┘
```

---

## Part 7: CLI Commands Reference

### Generate DDL

```bash
# Generate DDL to stdout
pnpm dbsp generate ddl --schema ./examples/minimal.schema.ts

# Generate DDL to file
pnpm dbsp generate ddl --schema ./examples/minimal.schema.ts -o schema.sql

# Specify dialect (default: postgresql)
pnpm dbsp generate ddl --schema ./examples/minimal.schema.ts --dialect mysql
```

**Supported dialects:** `postgresql`, `mysql`, `sqlite`

### Introspect Database

```bash
# Introspect and output to stdout
pnpm dbsp introspect --db postgresql://user:pass@localhost:5432/mydb

# Introspect and save to file
pnpm dbsp introspect --db postgresql://... -o schema.ts

# Introspect specific PostgreSQL schema
pnpm dbsp introspect --db postgresql://... --schema-name tenant_123
```

### Generate Kysely Types

```bash
# Generate TypeScript types
pnpm dbsp generate kysely --schema ./examples/minimal.schema.ts -o types.d.ts
```

### Generate Manifest (JSON)

```bash
pnpm dbsp generate manifest --schema ./examples/minimal.schema.ts -o manifest.json
```

### Verify Schema Against Database

```bash
# Basic verification
pnpm dbsp verify \
  --schema ./examples/minimal.schema.ts \
  --db postgresql://...

# JSON output for CI
pnpm dbsp verify --schema ... --db ... --output json
```

---

## Part 8: REPL Commands Reference

| Command | Description |
|---------|-------------|
| `.tables` | List all tables |
| `.schema <table>` | Show table columns |
| `.relations <table>` | Show table relations |
| `.exec` | Enable execution mode |
| `.compile` | Disable execution (planning only) |
| `.use <schema>` | Set PostgreSQL schema (multi-tenant) |
| `.use` | Clear schema scope |
| `.import <file.sql>` | Execute SQL file |
| `.help` | Show help |
| `.quit` | Exit REPL |

---

## Part 9: Example Schemas Reference

| Schema | File | Description | Best For |
|--------|------|-------------|----------|
| Minimal | `minimal.schema.ts` | Users + Posts | Learning basics |
| Blog | `blog.schema.ts` | Authors, Posts, Comments, Tags | Relations, aggregates |
| E-commerce | `ecommerce.schema.ts` | Products, Categories, Orders | Recursive includes |
| PIM/DAM | `pimdam.schema.ts` | Products, Assets, Variants | Advanced relations |
| Scheduling | `scheduling.schema.ts` | Rooms, Bookings, Events | Range types |

---

## Common Issues

### "tsx: command not found"

```bash
pnpm install  # Re-install dependencies
```

### "Cannot find module '@dbsp/schema'"

```bash
pnpm build    # Build all packages first
```

### REPL shows "No schema file found"

Make sure to pass the `--schema` flag:
```bash
pnpm dbsp repl --schema ./examples/minimal.schema.ts
```

---

## Next Steps

1. **Create your own schema** - See `examples/*.schema.ts` for patterns
2. **Connect to your database** - Use `--db` flag with connection string
3. **Generate types** - Use `generate kysely` for TypeScript integration
4. **Read the API docs** - See `docs/` for detailed documentation
