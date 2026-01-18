# Quickstart Guide

Get up and running with db-semantic-planner in minutes.

## Prerequisites

```bash
# Clone the repo
git clone https://github.com/your-org/db-semantic-planner
cd db-semantic-planner

# Install dependencies
pnpm install
```

## Example Schemas

| File | Description | Complexity |
|------|-------------|------------|
| `minimal.schema.ts` | Users + Posts | Beginner |
| `blog.schema.ts` | Authors, Posts, Comments, Tags | Intermediate |
| `ecommerce.schema.ts` | Products, Categories, Orders | Advanced |
| `pimdam.schema.ts` | PIM/DAM: Products, Assets, Variants, Localization | Advanced |
| `scheduling.schema.ts` | Rooms, Bookings, Events (range types) | Advanced |

---

## 1. Explore with REPL (No Database Required)

The REPL lets you test queries without a database connection.

### Start the REPL

```bash
# Minimal schema
pnpm dbsp repl --schema ./examples/minimal.schema.ts

# Blog schema
pnpm dbsp repl --schema ./examples/blog.schema.ts

# E-commerce schema
pnpm dbsp repl --schema ./examples/ecommerce.schema.ts

# PIM/DAM schema (Product Information Management / Digital Asset Management)
pnpm dbsp repl --schema ./examples/pimdam.schema.ts

# Scheduling schema (range types)
pnpm dbsp repl --schema ./examples/scheduling.schema.ts
```

### Try These Queries

```
# List all tables
> .tables

# Show schema for a table
> .schema users
> .schema posts

# Show relations for a table
> .relations posts

# Simple select
> users
> posts

# With filter
> users where id = 1
> posts where published = true

# With relation include
> posts include author
> users include posts

# Multiple conditions
> posts where published = true and authorId = 1

# With limit/offset
> posts limit 10
> posts limit 10 offset 20

# Help
> .help

# Exit
> .quit
```

### Aggregate Queries (CLI-016)

The REPL supports SQL-like aggregate functions:

```
# Count all rows
> posts select count(*)

# Count with alias
> posts select count(*) as total_posts

# Multiple aggregates
> posts select sum(views) as total_views avg(views) as average

# Group by with aggregate
> posts select count(*) as post_count group by authorId

# Having clause
> posts select count(*) group by authorId having count > 5

# Min/Max
> orders select min(amount) as min_order max(amount) as max_order

# Select distinct
> posts select distinct

# Count distinct
> posts select count(distinct authorId) as unique_authors
```

### Expected Output (Aggregates)

```
dbsp> posts select count(*) as total_posts

SQL:
select count(*) as "total_posts" from "posts" as "t0"

Plan:
  Strategy: aggregate
  Tables: posts
```

```
dbsp> posts select count(*) as post_count group by authorId

SQL:
select "t0"."authorId", count(*) as "post_count"
from "posts" as "t0"
group by "t0"."authorId"

Plan:
  Strategy: aggregate, group-by
  Tables: posts
```

```
dbsp> posts select sum(views) as total_views avg(views) as avg_views

SQL:
select sum("t0"."views") as "total_views", avg("t0"."views") as "avg_views"
from "posts" as "t0"

Plan:
  Strategy: aggregate
  Tables: posts
```

```
dbsp> posts select count(distinct authorId) as unique_authors

SQL:
select count(distinct "t0"."authorId") as "unique_authors"
from "posts" as "t0"

Plan:
  Strategy: aggregate
  Tables: posts
```

### Recursive Includes (CLI-017)

For self-referential tables (like hierarchical categories), use `include all` for recursive traversal:

```
# Get category with all descendants (children, grandchildren, etc.)
> categories where id = 1 include all children

# Get category with all ancestors (parent, grandparent, etc.)
> categories where id = 5 include all parent

# Regular (non-recursive) includes - one level only
> categories include children
> categories include parent
```

#### Depth Options (CLI-018)

Control recursion depth and track hierarchy level:

```
# Limit recursion to 10 levels deep
> categories include all children depth 10

# Alternative syntax for max depth
> categories include all children max 5

# Include a depth column showing hierarchy level (0 for root, 1 for children, etc.)
> categories include all children with depth

# Combine both options
> categories include all children depth 10 with depth
```

> **Note:** Recursive includes generate CTEs (`WITH RECURSIVE`) at execution time.
> In REPL compile-only mode, the main query is shown without the CTE.
> Use actual database execution to see the full recursive behavior.

### Range Operators (PostgreSQL)

Query PostgreSQL range types (daterange, tstzrange, int4range) with specialized operators:

```
# Range overlaps - find bookings that overlap a date range
> room_bookings where booking_period overlaps [2024-01-15,2024-01-20)

# Shorthand range syntax (inclusive both sides)
> events where time_slot overlaps 2024-01-01..2024-01-31

# Range contains element - find price tier for quantity 25
> price_tiers where quantity_range contains 25

# Range contains date - find bookings containing Jan 18
> room_bookings where booking_period contains 2024-01-18

# Range contained by - find bookings fully within January
> room_bookings where booking_period containedBy [2024-01-01,2024-02-01)

# Combine with relations
> rooms include bookings where booking_period overlaps [2024-01-15,2024-01-20)
```

#### Range Syntax

| Format | Meaning | Example |
|--------|---------|---------|
| `[a,b)` | Inclusive lower, exclusive upper | `[2024-01-01,2024-02-01)` |
| `[a,b]` | Both inclusive | `[1,100]` |
| `(a,b)` | Both exclusive | `(0,100)` |
| `a..b` | Shorthand for `[a,b]` (inclusive) | `10..50` |

#### Operators

| Operator | SQL | Description |
|----------|-----|-------------|
| `overlaps` | `&&` | Ranges share common points |
| `contains` | `@>` | Range contains element or range |
| `containedBy` | `<@` | Range is contained by another |

> **Note:** Range types require PostgreSQL 9.2+ and appropriate column types
> (daterange, tstzrange, int4range, etc.) in your database schema.

### Expected Output (Relations)

```
dbsp> posts where published = true include author

SQL:
SELECT "t0"."id", "t0"."title", "t0"."slug", "t0"."content", "t0"."published",
       "t0"."authorId", "t0"."createdAt", "t0"."updatedAt",
       "author"."id" AS "author.id", "author"."name" AS "author.name",
       "author"."email" AS "author.email", "author"."bio" AS "author.bio",
       "author"."createdAt" AS "author.createdAt"
FROM "posts" AS "t0"
LEFT JOIN "authors" AS "author" ON "t0"."authorId" = "author"."id"
WHERE "t0"."published" = $1

Parameters: [true]

Plan:
  Strategy: filter-strategy: comparison, include-strategy: join
  Tables: posts, author
```

> **Note:** Column aliases like `"author.id"` are added for disambiguation when
> JOINing tables. This ensures columns from different tables with the same name
> (e.g., `id`, `createdAt`) are uniquely identifiable in the result set.

---

## 2. Live Database Examples (PostgreSQL)

Connect the REPL to a real PostgreSQL database to execute queries and see actual results.

### Prerequisites

- PostgreSQL 9.2+ (15+ recommended for range types)
- A database to use (e.g., `dbsp_examples`)

```bash
# Create a database for examples
createdb dbsp_examples
```

---

### 2.1 Minimal Schema (Beginner)

**Tables:** `users`, `posts`

#### Setup

```bash
# Load DDL schema
psql -d dbsp_examples -f examples/minimal.ddl.sql

# Seed sample data
psql -d dbsp_examples -f examples/minimal.seed.sql
```

#### Launch REPL with Database Connection

```bash
pnpm dbsp repl \
  --schema ./examples/minimal.schema.ts \
  --db postgres://localhost/dbsp_examples
```

#### Try These Queries

```
# Compile mode (default) - shows SQL without executing
> users
> posts

# Enable execution mode
> .exec on

# Now queries return actual data
> users
│ id  │ name       │ email              │
├───────────────────────────────────────────┤
│ 1   │ Alice      │ alice@example.com  │
│ 2   │ Bob        │ bob@example.com    │
2 rows (5ms)

# Filter queries
> posts where user_id = 1
> users where name = 'Alice' include posts

# Raw SQL (prefix with !)
> !SELECT COUNT(*) FROM users

# Toggle back to compile mode
> .exec off
```

---

### 2.2 Blog Schema (Intermediate)

**Tables:** `authors`, `posts`, `comments`, `tags`, `post_tags`

#### Setup

```bash
# Load DDL schema
psql -d dbsp_examples -f examples/blog.ddl.sql

# Seed sample data
psql -d dbsp_examples -f examples/blog.seed.sql
```

#### Launch REPL

```bash
pnpm dbsp repl \
  --schema ./examples/blog.schema.ts \
  --db postgres://localhost/dbsp_examples
```

#### Try These Queries

```
> .exec on

# List published posts
> posts where published = true

# Posts with author details
> posts include author

# Aggregate: count posts per author
> posts select count(*) as post_count group by author_id

# Find posts with comments
> posts where id = 1 include comments

# Filter comments
> comments where approved = true include post

# Raw SQL for complex queries
> !SELECT a.name, COUNT(p.id) as posts
>  FROM authors a LEFT JOIN posts p ON a.id = p.author_id
>  GROUP BY a.name ORDER BY posts DESC

# Check schema
> .schema posts
> .relations posts
```

---

### 2.3 E-Commerce Schema (Advanced)

**Tables:** `categories`, `products`, `variants`, `customers`, `addresses`, `orders`, `order_items`

#### Setup

```bash
# Load DDL schema
psql -d dbsp_examples -f examples/ecommerce.ddl.sql

# Seed sample data
psql -d dbsp_examples -f examples/ecommerce.seed.sql
```

#### Launch REPL

```bash
pnpm dbsp repl \
  --schema ./examples/ecommerce.schema.ts \
  --db postgres://localhost/dbsp_examples
```

#### Try These Queries

```
> .exec on

# Active products with stock
> products where active = true and stock > 0

# Products with variants
> products include variants

# Recursive category tree (all descendants)
> categories where id = 1 include all children

# Categories with depth tracking
> categories include all children with depth

# Customer orders
> customers where id = 1 include orders

# Order details with items
> orders include items include product

# Aggregates: total revenue per customer
> orders select sum(total) as revenue group by customer_id

# Raw SQL: top selling products
> !SELECT p.name, SUM(oi.quantity) as sold
>  FROM products p
>  JOIN order_items oi ON p.id = oi.product_id
>  GROUP BY p.name ORDER BY sold DESC LIMIT 10
```

---

### 2.4 Scheduling Schema (Range Types)

**Tables:** `rooms`, `room_bookings`, `events`, `price_tiers`

> **Note:** This schema uses PostgreSQL range types (`daterange`, `tstzrange`, `int4range`).
> Requires PostgreSQL 9.2+.

#### Setup

```bash
# Load DDL schema (includes EXCLUDE constraints for overlaps)
psql -d dbsp_examples -f examples/scheduling.ddl.sql

# Seed sample data
psql -d dbsp_examples -f examples/scheduling.seed.sql
```

#### Launch REPL

```bash
pnpm dbsp repl \
  --schema ./examples/scheduling.schema.ts \
  --db postgres://localhost/dbsp_examples
```

#### Try These Queries

```
> .exec on

# All rooms
> rooms

# Room bookings
> room_bookings include room

# Range: find bookings overlapping a date range
> room_bookings where booking_period overlaps [2024-01-15,2024-01-20)

# Range: find bookings containing a specific date
> room_bookings where booking_period contains 2024-01-18

# Find available rooms (not booked in date range)
> !SELECT r.* FROM rooms r
>  WHERE NOT EXISTS (
>    SELECT 1 FROM room_bookings rb
>    WHERE rb.room_id = r.id
>    AND rb.booking_period && '[2024-01-15,2024-01-20)'::daterange
>  )

# Events in a time window (timestamp ranges)
> events where time_slot overlaps 2024-01-15T09:00:00Z..2024-01-15T17:00:00Z

# Price tiers: find tier for quantity 25
> price_tiers where quantity_range contains 25

# Shorthand range syntax (inclusive both sides)
> room_bookings where booking_period overlaps 2024-01-01..2024-01-31
```

---

### 2.5 PIM/DAM Schema (Product Information Management)

**Tables:** `categories`, `products`, `assets`, `productImages`, `variants`

A real-world Product Information Management / Digital Asset Management schema demonstrating:
- **Hierarchical categories** (self-referential)
- **Digital assets** with metadata (images, videos, documents)
- **Localized content** (product images per locale)
- **Approval workflow** (pending, approved, rejected status)
- **Soft deletes** (deletedAt timestamps)

#### Setup

```bash
# Load DDL schema
psql -d dbsp_examples -f examples/pimdam.ddl.sql

# Seed sample data (12 categories, 15 products, 20 assets, 25 images, 22 variants)
psql -d dbsp_examples -f examples/pimdam.seed.sql

# Or use the REPL .import command:
pnpm dbsp repl --schema ./examples/pimdam.schema.ts --db postgres://localhost/dbsp_examples
> .import examples/pimdam.ddl.sql
> .import examples/pimdam.seed.sql
```

#### Launch REPL

```bash
pnpm dbsp repl \
  --schema ./examples/pimdam.schema.ts \
  --db postgres://localhost/dbsp_examples
```

#### Try These Queries

```
> .exec on

# List all product categories (hierarchical)
> categories

# Find root categories (no parent)
> categories where parentId = null

# Products with their category
> products include category

# Active products only
> products where active = true

# Products with approved images for a locale
> products include images where status = 'approved' and locale = 'en'

# Products with variants (pricing and inventory)
> products include variants where stock > 0

# Digital assets by type
> assets where kind = 'image'

# Find products with main image in French locale
> productImages where locale = 'fr' and isMain = true include product

# Aggregates: count products per category
> products count by categoryId

# Aggregates: average price per product
> variants avg(priceCents) by productId

# Category hierarchy: get children of "Electronics"
> categories include children where parentId = 1
```

#### PIM/DAM Use Cases

| Use Case | Query |
|----------|-------|
| Products without images | `products where id not in (select productId from productImages)` |
| Pending image approvals | `productImages where status = 'pending'` |
| Low stock variants | `variants where stock < 10` |
| Products by brand | `products where brand = 'Apple'` |
| Category tree | `categories include children include products` |

---

### 2.6 Importing SQL Files (.import)

The `.import` command executes SQL files directly against the connected database. This is useful for:
- Loading DDL schemas
- Seeding data
- Running migrations
- Executing arbitrary SQL scripts

#### Usage

```
> .import <file.sql>
```

#### Examples

```bash
# Start REPL with database connection
pnpm dbsp repl --schema ./examples/pimdam.schema.ts --db postgresql://localhost/mydb

# In REPL:
> .import examples/pimdam.ddl.sql
✅ SQL file executed successfully: examples/pimdam.ddl.sql
   Rows affected: 5

> .import examples/pimdam.seed.sql
✅ SQL file executed successfully: examples/pimdam.seed.sql
   Rows affected: 94
```

#### Workflow: Schema → DDL → Seed → Query

```bash
# 1. Start REPL with schema and database
pnpm dbsp repl --schema ./examples/pimdam.schema.ts --db $DATABASE_URL --exec

# 2. Create tables
> .import examples/pimdam.ddl.sql

# 3. Load sample data
> .import examples/pimdam.seed.sql

# 4. Query your data
> products include variants include images
```

> **Note:** `.import` requires a database connection (`--db`). The file path is relative to your current working directory.

---

### 2.7 Mode Reference

#### Input Modes

| Mode | Command | Default Input | `!` Escape |
|------|---------|---------------|------------|
| Natural | `.natural` (default) | Natural query syntax | Raw SQL |
| SQL | `.sql` | Raw SQL | Natural query |

The `!` prefix acts as a **mode escape**: it does the opposite of the current mode.

```
# In natural mode (default)
> users where active = true     # Parsed as natural query
> !SELECT * FROM users          # Executed as raw SQL

# In SQL mode (.sql)
> SELECT * FROM users           # Executed as raw SQL
> !users where active = true    # Parsed as natural query
```

#### Execution Mode

| Setting | Command | Behavior |
|---------|---------|----------|
| Compile only | `.exec off` (default) | Shows SQL without executing |
| Execute | `.exec on` | Compiles AND executes queries |

> **Note:** Execution requires a database connection (`--db` option).

#### Schema Scoping (Multi-Tenant)

PostgreSQL schemas allow isolating data per tenant. The REPL supports schema-scoped queries via `.use`.

##### Setup: Create Schemas and Load DDL

```bash
# 1. Create schemas for each tenant
psql $DATABASE_URL -c "CREATE SCHEMA IF NOT EXISTS tenant_acme;"
psql $DATABASE_URL -c "CREATE SCHEMA IF NOT EXISTS tenant_globex;"

# 2. Load DDL into each schema (use search_path)
psql $DATABASE_URL -c "SET search_path TO tenant_acme;" -f examples/blog.ddl.sql
psql $DATABASE_URL -c "SET search_path TO tenant_globex;" -f examples/blog.ddl.sql

# 3. Seed data per tenant
psql $DATABASE_URL -c "SET search_path TO tenant_acme;" -f examples/blog.seed.sql
psql $DATABASE_URL -c "SET search_path TO tenant_globex;" -f examples/blog.seed.sql
```

Or in a single script:

```bash
#!/bin/bash
# setup-tenants.sh
DATABASE_URL=${DATABASE_URL:-"postgresql://localhost/dbsp_examples"}
DDL_FILE=${1:-"examples/blog.ddl.sql"}
SEED_FILE=${2:-"examples/blog.seed.sql"}

for TENANT in tenant_acme tenant_globex tenant_initech; do
  echo "Setting up schema: $TENANT"
  psql "$DATABASE_URL" <<EOF
    CREATE SCHEMA IF NOT EXISTS $TENANT;
    SET search_path TO $TENANT;
    \i $DDL_FILE
    \i $SEED_FILE
EOF
done
echo "Done! Created 3 tenant schemas."
```

##### REPL: Switch Between Schemas

Use `.use <schema>` to scope all queries to a specific PostgreSQL schema:

```
> .use tenant_acme
Using schema: tenant_acme
All queries will be scoped to this schema. .use to clear.

> users                              # Queries tenant_acme.users
SELECT "id", "name", "email" FROM "tenant_acme"."users"

> .use tenant_globex                 # Switch to another tenant
Using schema: tenant_globex

> users                              # Now queries tenant_globex.users
SELECT "id", "name", "email" FROM "tenant_globex"."users"

> .use                               # Clear schema
Cleared schema. Queries now use default schema.
```

##### Programmatic Usage

```typescript
import { createOrm } from '@dbsp/core';
import { createKyselyAdapter } from '@dbsp/adapter-kysely';

const orm = createOrm({ model: schema, adapter: createKyselyAdapter(db) });

// Scope queries to a tenant schema
const acmeOrm = orm.withSchema('tenant_acme');
const acmeUsers = await acmeOrm.select('users').all();

// Each tenant is isolated
const globexOrm = orm.withSchema('tenant_globex');
const globexUsers = await globexOrm.select('users').all();

// dump() shows schema in meta
const dump = acmeOrm.select('users').dump();
console.log(dump.meta?.schema); // 'tenant_acme'
console.log(dump.sql);          // SELECT ... FROM "tenant_acme"."users"
```

This pattern is useful for multi-tenant SaaS applications where each tenant has isolated data.

### 2.8 Status Indicator

The REPL header shows current settings:

```
┌─────────────────────────────────────────────────────────────────────────┐
│ 🔍 db-semantic-planner REPL | .help for commands | Ctrl+C to exit      │
│ Schema: ./examples/blog.schema.ts (5 tables, 6 relations)              │
│ Mode: natural | Schema: tenant_123 | Dialect: PG | Strategy: auto      │
│ DB: dbsp_examples | ▶ EXEC                                             │
└─────────────────────────────────────────────────────────────────────────┘
```

| Indicator | Values | Meaning |
|-----------|--------|---------|
| Mode | `natural` (green) / `sql` (yellow) | Input parsing mode |
| DB | Database name | Connected database |
| ▶ EXEC / ◼ COMPILE | Green / Yellow | Execution enabled or compile-only |

---

## 3. Generate DDL from Schema

Generate SQL DDL (CREATE TABLE statements) from your TypeScript schema definition. This is useful for:
- Creating database tables from your schema
- Generating migration scripts
- Documentation and schema sharing

### Basic Usage

```bash
# Generate DDL to stdout
pnpm dbsp generate ddl --schema ./examples/blog.schema.ts

# Generate DDL to file
pnpm dbsp generate ddl --schema ./examples/blog.schema.ts --output ./schema.ddl.sql

# Specify dialect (default: postgresql)
pnpm dbsp generate ddl --schema ./examples/pimdam.schema.ts --dialect postgresql
```

### Supported Dialects

| Dialect | Flag | Notes |
|---------|------|-------|
| PostgreSQL | `--dialect postgresql` (default) | Full feature support |
| MySQL | `--dialect mysql` | Basic support |
| SQLite | `--dialect sqlite` | Basic support |
| DuckDB | `--dialect duckdb` | Analytical queries |
| MS SQL | `--dialect mssql` | Basic support |

### Example Output (PostgreSQL)

```sql
-- Generated from: ./examples/blog.schema.ts
-- Dialect: postgresql

CREATE TABLE "authors" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(255) NOT NULL,
  "email" VARCHAR(255) NOT NULL UNIQUE,
  "bio" TEXT,
  "created_at" TIMESTAMP DEFAULT NOW()
);

CREATE TABLE "posts" (
  "id" SERIAL PRIMARY KEY,
  "title" VARCHAR(500) NOT NULL,
  "slug" VARCHAR(255) NOT NULL UNIQUE,
  "content" TEXT,
  "published" BOOLEAN DEFAULT FALSE,
  "author_id" INTEGER NOT NULL REFERENCES "authors"("id"),
  "created_at" TIMESTAMP DEFAULT NOW(),
  "updated_at" TIMESTAMP
);

-- ... more tables
```

### Workflow: Schema → DDL → Database

```bash
# 1. Generate DDL from schema
pnpm dbsp generate ddl --schema ./examples/pimdam.schema.ts --output ./pimdam.ddl.sql

# 2. Apply to database
psql $DATABASE_URL -f ./pimdam.ddl.sql

# 3. (Optional) Load seed data
psql $DATABASE_URL -f ./examples/pimdam.seed.sql
```

Or use the REPL for interactive setup:

```bash
# Start REPL and use .import
pnpm dbsp repl --schema ./examples/pimdam.schema.ts --db $DATABASE_URL --exec
> .import ./pimdam.ddl.sql
> .import ./examples/pimdam.seed.sql
```

---

## 4. Introspect Database Schema

Reverse-engineer a TypeScript schema definition from an existing database. This is useful for:
- Onboarding existing databases to db-semantic-planner
- Generating initial schema from legacy databases
- Keeping schema in sync with database changes

### Basic Usage

```bash
# Introspect and output to stdout
pnpm dbsp introspect --db postgresql://localhost/mydb

# Introspect and save to file
pnpm dbsp introspect --db postgresql://localhost/mydb --output ./schema.ts

# Introspect specific PostgreSQL schema
pnpm dbsp introspect --db postgresql://localhost/mydb --schema-name public
```

### Example Output

```typescript
// Generated by dbsp introspect
// Source: postgresql://localhost/mydb
// Schema: public
// Generated at: 2025-01-18T10:30:00Z

import { defineSchema } from '@dbsp/schema';

export default defineSchema({
  authors: {
    id: { type: 'integer', primaryKey: true },
    name: { type: 'string', nullable: false },
    email: { type: 'string', nullable: false },
    bio: { type: 'string', nullable: true },
    createdAt: { type: 'timestamp', defaultNow: true },
  },
  posts: {
    id: { type: 'integer', primaryKey: true },
    title: { type: 'string', nullable: false },
    slug: { type: 'string', nullable: false },
    content: { type: 'string', nullable: true },
    published: { type: 'boolean', default: false },
    authorId: { type: 'integer', nullable: false, references: { table: 'authors' } },
    createdAt: { type: 'timestamp', defaultNow: true },
    updatedAt: { type: 'timestamp', nullable: true },
  },
  // ... more tables
});
```

### Workflow: Database → Schema → Types

```bash
# 1. Introspect existing database
pnpm dbsp introspect --db $DATABASE_URL --output ./src/schema.ts

# 2. Generate Kysely types from schema
pnpm dbsp generate kysely --schema ./src/schema.ts --output ./src/db.types.ts

# 3. Use in your application
```

### Options

| Option | Description |
|--------|-------------|
| `--db <url>` | Database connection URL (required) |
| `--output <file>` | Output file path (default: stdout) |
| `--schema-name <name>` | PostgreSQL schema to introspect (default: public) |
| `--include-views` | Include database views (default: false) |

---

## 5. Generate Kysely Types

Generate TypeScript types for use with Kysely.

```bash
# Generate to stdout
pnpm dbsp generate kysely --schema ./examples/blog.schema.ts

# Generate to file
pnpm dbsp generate kysely --schema ./examples/blog.schema.ts --output ./src/db.generated.ts
```

### Expected Output

```typescript
import type { Generated, ColumnType } from 'kysely';

export interface AuthorsTable {
  id: Generated<number>;
  name: string;
  email: string;
  bio: string | null;
  createdAt: Generated<Date>;
}

export interface PostsTable {
  id: Generated<number>;
  title: string;
  slug: string;
  content: string | null;
  published: Generated<boolean>;
  authorId: number;
  createdAt: Generated<Date>;
  updatedAt: Date | null;
}

// ... more tables

export interface DB {
  authors: AuthorsTable;
  posts: PostsTable;
  comments: CommentsTable;
  tags: TagsTable;
  postTags: PostTagsTable;
}
```

---

## 6. Generate Manifest (JSON)

Generate a JSON manifest of your schema (useful for tooling).

```bash
pnpm dbsp generate manifest --schema ./examples/blog.schema.ts
pnpm dbsp generate manifest --schema ./examples/blog.schema.ts --output ./schema.json
```

---

## 7. Verify Against Database (Optional)

Compare your schema against a real PostgreSQL database.

```bash
# Basic verification
pnpm dbsp verify \
  --schema ./examples/blog.schema.ts \
  --db postgres://user:password@localhost:5432/mydb

# With specific schema name
pnpm dbsp verify \
  --schema ./examples/blog.schema.ts \
  --db postgres://user:password@localhost:5432/mydb \
  --schema-name public

# JSON output (for CI)
pnpm dbsp verify \
  --schema ./examples/blog.schema.ts \
  --db postgres://user:password@localhost:5432/mydb \
  --json
```

### Expected Output (Success)

```
🔍 Verifying schema: ./examples/blog.schema.ts
   Database: postgres://user:***@localhost:5432/mydb

✅ Schema is valid - no drift detected

Tables: 5 matched
Columns: 23 matched
```

### Expected Output (Drift Detected)

```
🔍 Verifying schema: ./examples/blog.schema.ts
   Database: postgres://user:***@localhost:5432/mydb

❌ Schema drift detected

Missing tables:
  - tags
  - postTags

Column mismatches in 'posts':
  - 'slug' missing in database
  - 'content' type mismatch: expected 'text', got 'varchar'
```

---

## 8. Use in Your Application

Once you've generated types, use them with the ORM:

```typescript
import { createOrm, eq } from '@db-semantic-planner/core';
import { createKyselyAdapter } from '@db-semantic-planner/adapter-kysely';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { DB } from './db.generated';

// Import your schema
import schema from './examples/blog.schema';

// Create Kysely instance
const db = new Kysely<DB>({
  dialect: new PostgresDialect({
    pool: new Pool({ connectionString: process.env.DATABASE_URL }),
  }),
});

// Create ORM with schema (codegen-first approach)
const orm = createOrm({
  schema,  // Schema from @db-semantic-planner/schema
  adapter: createKyselyAdapter(db),
});

// Query!
const publishedPosts = await orm
  .select('posts')
  .where(eq('published', true))
  .include('author')
  .all();

console.log(publishedPosts);
```

---

## Common Issues

### "tsx: command not found"

Make sure you've installed dependencies:

```bash
pnpm install
```

### "Cannot find module '@db-semantic-planner/schema'"

The packages need to be built first:

```bash
pnpm build
```

### REPL shows "No schema file found"

Specify the schema path explicitly:

```bash
pnpm dbsp repl --schema ./examples/minimal.schema.ts
```

---

## Next Steps

1. **Try live database examples** - Follow Section 2 to connect REPL to PostgreSQL
2. **Create your own schema** - Copy `minimal.schema.ts` and modify
3. **Read the API docs** - See `README.md` for full API reference
4. **Run E2E tests** - `pnpm test:e2e` to see real PostgreSQL examples
5. **Explore aggregate functions** - COUNT, SUM, AVG, MIN, MAX with GROUP BY and HAVING
6. **Try nested includes** - `posts include author include posts`
7. **Try recursive includes** - `include all children` for hierarchical data
8. **Explore range types** - See Section 2.4 for PostgreSQL range queries
9. **Explore advanced features** - Window functions, multi-tenant
