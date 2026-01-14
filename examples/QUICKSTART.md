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

## 2. Generate Kysely Types

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

## 3. Generate Manifest (JSON)

Generate a JSON manifest of your schema (useful for tooling).

```bash
pnpm dbsp generate manifest --schema ./examples/blog.schema.ts
pnpm dbsp generate manifest --schema ./examples/blog.schema.ts --output ./schema.json
```

---

## 4. Verify Against Database (Optional)

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

## 5. Use in Your Application

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

1. **Create your own schema** - Copy `minimal.schema.ts` and modify
2. **Read the API docs** - See `README.md` for full API reference
3. **Run E2E tests** - `pnpm test:e2e` to see real PostgreSQL examples
4. **Explore aggregate functions** - COUNT, SUM, AVG, MIN, MAX with GROUP BY and HAVING
5. **Try nested includes** - `posts include author include posts`
6. **Explore advanced features** - Window functions, recursive queries, multi-tenant
