# Quickstart Guide

A progressive tutorial from basic to advanced queries with **real data at every step**.

Each chapter uses a different schema, building in complexity.

> **Output Format Note:** This guide shows simplified output for readability. Actual REPL output uses:
> - Text table format with `---+---` separators
> - `include` produces LEFT JOINs with prefixed columns (e.g., `posts.title`), not nested objects
> - Column names use camelCase from schema (e.g., `authorId`), SQL uses snake_case (e.g., `author_id`)

---

## Chapter 0: Prerequisites

### Install Dependencies

```bash
git clone https://github.com/your-org/db-semantic-planner
cd db-semantic-planner
pnpm install
```

### Start PostgreSQL

```bash
# Start PostgreSQL with full extension support
docker run -d \
  --name pg-demo \
  -e POSTGRES_PASSWORD=demo \
  -p 5432:5432 \
  oorabona/postgres:17-full-alpine

# Wait for startup
sleep 3

# Create demo database
docker exec pg-demo createdb -U postgres demo
```

### Verify Connection

```bash
docker exec -it pg-demo psql -U postgres -d demo -c "SELECT version();"
```

You're ready! Each chapter will:
1. Generate DDL for the schema
2. Load seed data
3. Connect REPL with execution mode
4. Run queries with real results

---

## Chapter 1: Minimal Schema (users + posts)

**New concepts:** `select`, `where`, `limit`, `offset`, `insert`, `update`, `delete`, `upsert`

### 1.1 Setup Database

```bash
# Generate DDL (with --drop to reset existing tables)
pnpm dbsp generate ddl --schema ./examples/minimal.schema.ts --drop -o /tmp/minimal.sql

# Apply to database
docker exec -i pg-demo psql -U postgres -d demo < /tmp/minimal.sql

# Load seed data
docker exec -i pg-demo psql -U postgres -d demo < ./examples/minimal.seed.sql
```

### 1.2 Query with REPL

You can run queries in batch mode with `--eval`:

```bash
pnpm dbsp repl \
  --schema ./examples/minimal.schema.ts \
  --db postgresql://postgres:demo@localhost:5432/demo \
  --eval 'users'
```

When `--db` is provided, queries execute against the database and show real results.

### 1.3 Explore Schema

```bash
pnpm dbsp repl --schema ./examples/minimal.schema.ts --db postgresql://postgres:demo@localhost:5432/demo --eval '.tables'
```
```
> .tables
Tables (2):
  - users
  - posts
```

```bash
pnpm dbsp repl --schema ./examples/minimal.schema.ts --db postgresql://postgres:demo@localhost:5432/demo --eval '.schema users'
```
```
> .schema users
Table: users
Columns:
  - id: integer (NOT NULL)
  - name: string (NOT NULL)
  - email: string (NOT NULL)
```

```bash
pnpm dbsp repl --schema ./examples/minimal.schema.ts --db postgresql://postgres:demo@localhost:5432/demo --eval '.relations posts'
```
```
> .relations posts
Relations for posts:
  - users.posts: hasMany → posts
```

### 1.4 Basic SELECT

**Select all users:**
```bash
pnpm dbsp repl --schema ./examples/minimal.schema.ts --db postgresql://postgres:demo@localhost:5432/demo --eval 'users'
```
```
> users
Main SQL:
select "t0".* from "users" as "t0"

Rows: 3
id | name    | email
---+---------+--------------------
1  | Alice   | alice@example.com
2  | Bob     | bob@example.com
3  | Charlie | charlie@example.com
```

**Select all posts:**
```bash
pnpm dbsp repl --schema ./examples/minimal.schema.ts --db postgresql://postgres:demo@localhost:5432/demo --eval 'posts'
```
```
> posts
Main SQL:
select "t0".* from "posts" as "t0"

Rows: 5
id | title           | content                         | user_id
---+-----------------+---------------------------------+--------
1  | Hello World     | My first post!                  | 1
2  | Getting Started | Here is how to begin...         | 1
3  | Tips and Tricks | Some useful tips for beginners. | 2
4  | Advanced Topics | null                            | 2
5  | Final Thoughts  | Wrapping up the series.         | 3
```

### 1.5 WHERE Clause

**Filter by equality:**
```bash
pnpm dbsp repl --schema ./examples/minimal.schema.ts --db postgresql://postgres:demo@localhost:5432/demo --eval "users | where name = 'Alice'"
```
```
> users | where name = 'Alice'
Main SQL:
select "t0".* from "users" as "t0" where "t0"."name" = $1

Parameters: ["Alice"]

Rows: 1
id | name  | email
---+-------+------------------
1  | Alice | alice@example.com
```

**Filter by user_id:**
```bash
pnpm dbsp repl --schema ./examples/minimal.schema.ts --db postgresql://postgres:demo@localhost:5432/demo --eval 'posts | where user_id = 1'
```
```
> posts | where user_id = 1
Main SQL:
select "t0".* from "posts" as "t0" where "t0"."user_id" = $1

Parameters: [1]

Rows: 2
id | title           | content                 | user_id
---+-----------------+-------------------------+--------
1  | Hello World     | My first post!          | 1
2  | Getting Started | Here is how to begin... | 1
```

**Filter with NULL:**
```bash
pnpm dbsp repl --schema ./examples/minimal.schema.ts --db postgresql://postgres:demo@localhost:5432/demo --eval 'posts | where content is null'
```
```
> posts | where content is null
Main SQL:
select "t0".* from "posts" as "t0" where "t0"."content" is null

Rows: 1
id | title           | content | user_id
---+-----------------+---------+--------
4  | Advanced Topics | null    | 2
```

**Filter by user_id:**
```bash
pnpm dbsp repl --schema ./examples/minimal.schema.ts --db postgresql://postgres:demo@localhost:5432/demo --eval 'posts | where user_id = 2'
```
```
> posts | where user_id = 2
Main SQL:
select "t0".* from "posts" as "t0" where "t0"."user_id" = $1

Parameters: [2]

Rows: 2
id | title           | content                         | user_id
---+-----------------+---------------------------------+--------
3  | Tips and Tricks | Some useful tips for beginners. | 2
4  | Advanced Topics | null                            | 2
```

### 1.6 LIMIT and OFFSET

**First 2 posts:**
```bash
pnpm dbsp repl --schema ./examples/minimal.schema.ts --db postgresql://postgres:demo@localhost:5432/demo --eval 'posts | limit 2'
```
```
> posts | limit 2
Main SQL:
select "t0".* from "posts" as "t0" limit $1

Parameters: [2]

Rows: 2
id | title           | content                 | user_id
---+-----------------+-------------------------+--------
1  | Hello World     | My first post!          | 1
2  | Getting Started | Here is how to begin... | 1
```

**Skip first 2, get next 2:**
```bash
pnpm dbsp repl --schema ./examples/minimal.schema.ts --db postgresql://postgres:demo@localhost:5432/demo --eval 'posts | limit 2 | offset 2'
```
```
> posts | limit 2 | offset 2
Main SQL:
select "t0".* from "posts" as "t0" limit $1 offset $2

Parameters: [2, 2]

Rows: 2
id | title           | content                         | user_id
---+-----------------+---------------------------------+--------
3  | Tips and Tricks | Some useful tips for beginners. | 2
4  | Advanced Topics | null                            | 2
```

### 1.7 Mutations (INSERT, UPDATE, DELETE)

**New concepts:** `insert`, `update`, `delete`, `upsert`, dry-run mode, `!` execute suffix

The REPL supports data mutations with a safe dry-run mode by default.

**Insert a new user (dry-run):**
```bash
pnpm dbsp repl --schema ./examples/minimal.schema.ts --db postgresql://postgres:demo@localhost:5432/demo --eval 'insert into users set name = "Diana", email = "diana@example.com"'
```
```
> insert into users set name = "Diana", email = "diana@example.com"
[DRY-RUN] INSERT (add ! to execute)

SQL:
insert into "users" ("name", "email") values ($1, $2)

Parameters: ["Diana", "diana@example.com"]
```

**Execute the insert immediately with `!` suffix:**
```bash
pnpm dbsp repl --schema ./examples/minimal.schema.ts --db postgresql://postgres:demo@localhost:5432/demo --exec --eval 'insert into users set name = "Diana", email = "diana@example.com"!'
```
```
> insert into users set name = "Diana", email = "diana@example.com"!
INSERT (executed)

SQL:
insert into "users" ("name", "email") values ($1, $2)

Parameters: ["Diana", "diana@example.com"]
```

**Update a user:**
```bash
pnpm dbsp repl --schema ./examples/minimal.schema.ts --db postgresql://postgres:demo@localhost:5432/demo --eval 'update users set name = "Alice Smith" where id = 1'
```
```
> update users set name = "Alice Smith" where id = 1
[DRY-RUN] UPDATE (add ! to execute)

SQL:
update "users" set "name" = $1 where "id" = $2

Parameters: ["Alice Smith", 1]
```

**Delete a post:**
```bash
pnpm dbsp repl --schema ./examples/minimal.schema.ts --db postgresql://postgres:demo@localhost:5432/demo --eval 'delete from posts where id = 5'
```
```
> delete from posts where id = 5
[DRY-RUN] DELETE (add ! to execute)

SQL:
delete from "posts" where "id" = $1

Parameters: [5]
```

> **Safety:** DELETE without WHERE clause is rejected to prevent accidental data loss.

**Upsert (INSERT or UPDATE on conflict):**
```bash
pnpm dbsp repl --schema ./examples/minimal.schema.ts --db postgresql://postgres:demo@localhost:5432/demo --eval 'upsert into users on email set name = "Alice", email = "alice@example.com"'
```
```
> upsert into users on email set name = "Alice", email = "alice@example.com"
[DRY-RUN] UPSERT (add ! to execute)

SQL:
insert into "users" ("name", "email") values ($1, $2) on conflict ("email") do update set "name" = $3

Parameters: ["Alice", "alice@example.com", "Alice Updated"]
```

---

## Chapter 2: Blog Schema

**New concepts:** M:N relations, aggregates (`count`, `sum`, `avg`), `group by`, `distinct`

### 2.1 Setup Database

```bash
# Drop and recreate for clean state
docker exec pg-demo psql -U postgres -d demo -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"

# Generate and apply DDL
pnpm dbsp generate ddl --schema ./examples/blog.schema.ts -o /tmp/blog.sql
docker exec -i pg-demo psql -U postgres -d demo < /tmp/blog.sql

# Load seed data
docker exec -i pg-demo psql -U postgres -d demo < ./examples/blog.seed.sql
```

### 2.2 Connect REPL

```bash
pnpm dbsp repl \
  --schema ./examples/blog.schema.ts \
  --db postgresql://postgres:demo@localhost:5432/demo \
  --exec
```

### 2.3 Explore Schema

```
dbsp> .tables
```
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
```
Relations for posts:
  - tags.posts: manyToMany → posts
  - authors.posts: hasMany → posts
  - comments.post: belongsTo → posts
```

### 2.4 Basic Queries with Data

**Authors:**
```
dbsp> authors
```
```
┌────┬─────────────┬──────────────────┬────────────────────────────────────────────────────┐
│ id │ name        │ email            │ bio                                                │
├────┼─────────────┼──────────────────┼────────────────────────────────────────────────────┤
│  1 │ Jane Doe    │ jane@blog.com    │ Senior tech writer and developer advocate.         │
│  2 │ John Smith  │ john@blog.com    │ Full-stack developer passionate about databases.   │
│  3 │ Emily Chen  │ emily@blog.com   │ NULL                                               │
└────┴─────────────┴──────────────────┴────────────────────────────────────────────────────┘
3 rows
```

**Posts:**
```
dbsp> posts
```
```
┌────┬────────────────────────────────────┬───────────┬───────────┬─────────────────────┐
│ id │ title                              │ published │ author_id │ created_at          │
├────┼────────────────────────────────────┼───────────┼───────────┼─────────────────────┤
│  1 │ Getting Started with PostgreSQL    │ true      │         1 │ 2024-01-05 10:00:00 │
│  2 │ TypeScript Best Practices 2024     │ true      │         1 │ 2024-01-10 14:30:00 │
│  3 │ Query Optimization Techniques      │ true      │         2 │ 2024-01-12 09:00:00 │
│  4 │ Introduction to Range Types        │ true      │         2 │ 2024-01-15 11:00:00 │
│  5 │ Draft: Advanced Indexing           │ false     │         2 │ 2024-01-18 16:00:00 │
│  6 │ Why Type Safety Matters            │ true      │         3 │ 2024-01-20 08:00:00 │
└────┴────────────────────────────────────┴───────────┴───────────┴─────────────────────┘
6 rows
```

**Tags:**
```
dbsp> tags
```
```
┌────┬────────────────┬────────────────┐
│ id │ name           │ slug           │
├────┼────────────────┼────────────────┤
│  1 │ PostgreSQL     │ postgresql     │
│  2 │ TypeScript     │ typescript     │
│  3 │ Tutorial       │ tutorial       │
│  4 │ Database       │ database       │
│  5 │ Performance    │ performance    │
│  6 │ Best Practices │ best-practices │
└────┴────────────────┴────────────────┘
6 rows
```

### 2.5 Filtering

**Published posts only:**
```
dbsp> posts | where published = true
```
```
┌────┬────────────────────────────────────┬───────────┬───────────┐
│ id │ title                              │ published │ author_id │
├────┼────────────────────────────────────┼───────────┼───────────┤
│  1 │ Getting Started with PostgreSQL    │ true      │         1 │
│  2 │ TypeScript Best Practices 2024     │ true      │         1 │
│  3 │ Query Optimization Techniques      │ true      │         2 │
│  4 │ Introduction to Range Types        │ true      │         2 │
│  6 │ Why Type Safety Matters            │ true      │         3 │
└────┴────────────────────────────────────┴───────────┴───────────┘
5 rows
```

**Approved comments:**
```
dbsp> comments | where approved = true
```
```
┌────┬─────────┬───────────────┬────────────────────────────────────────┐
│ id │ post_id │ author_name   │ content                                │
├────┼─────────┼───────────────┼────────────────────────────────────────┤
│  1 │       1 │ Alex Reader   │ Great introduction! Very helpful.      │
│  2 │       1 │ Sam Dev       │ Could you cover more advanced topics?  │
│  3 │       2 │ Chris Coder   │ This is exactly what I needed!         │
│  4 │       3 │ Pat DBA       │ Excellent tips on EXPLAIN ANALYZE.     │
│  5 │       4 │ Jordan Query  │ Range types are so useful!             │
│  7 │       6 │ Taylor Types  │ TypeScript changed my workflow.        │
└────┴─────────┴───────────────┴────────────────────────────────────────┘
6 rows
```

**Unapproved (spam) comments:**
```
dbsp> comments | where approved = false
```
```
┌────┬─────────┬───────────┬────────────────────┐
│ id │ post_id │ author_name │ content          │
├────┼─────────┼───────────┼────────────────────┤
│  6 │       4 │ Spam Bot  │ Buy cheap watches! │
└────┴─────────┴───────────┴────────────────────┘
1 row
```

### 2.6 Includes (LEFT JOIN)

> **Note:** Include produces a LEFT JOIN with prefixed columns. Each parent row is repeated for each related row.

**Authors with their posts:**
```bash
pnpm dbsp repl --schema ./examples/blog.schema.ts --db postgresql://postgres:demo@localhost:5432/demo --eval 'authors | include posts'
```
```
> authors | include posts
Main SQL:
select "t0".*, "t1"."id" as "posts.id", "t1"."title" as "posts.title", ...
from "authors" as "t0" left join "posts" as "t1" on "t1"."author_id" = "t0"."id"

Plan:
  Strategy: include-strategy: join, join-type: left
  Tables: authors, posts

Rows: 6
id | name       | email          | bio              | posts.id | posts.title
---+------------+----------------+------------------+----------+-------------------------------------
1  | Jane Doe   | jane@blog.com  | Senior tech...   | 1        | Getting Started with PostgreSQL
1  | Jane Doe   | jane@blog.com  | Senior tech...   | 2        | TypeScript Best Practices 2024
2  | John Smith | john@blog.com  | Full-stack...    | 3        | Query Optimization Techniques
2  | John Smith | john@blog.com  | Full-stack...    | 4        | Introduction to Range Types
2  | John Smith | john@blog.com  | Full-stack...    | 5        | Draft: Advanced Indexing
3  | Emily Chen | emily@blog.com | null             | 6        | Why Type Safety Matters
```

**Posts with comments:**
```bash
pnpm dbsp repl --schema ./examples/blog.schema.ts --db postgresql://postgres:demo@localhost:5432/demo --eval 'posts | include comments'
```
```
> posts | include comments
Main SQL:
select "t0".*, "t1"."id" as "comments.id", "t1"."author_name" as "comments.author_name", ...
from "posts" as "t0" left join "comments" as "t1" on "t1"."post_id" = "t0"."id"

Rows: 9
id | title                              | comments.id | comments.authorName
---+------------------------------------+-------------+--------------------
1  | Getting Started with PostgreSQL    | 1           | Alex Reader
1  | Getting Started with PostgreSQL    | 2           | Sam Dev
2  | TypeScript Best Practices 2024     | 3           | Chris Coder
3  | Query Optimization Techniques      | 4           | Pat DBA
4  | Introduction to Range Types        | 5           | Jordan Query
4  | Introduction to Range Types        | 6           | Spam Bot
5  | Draft: Advanced Indexing           | null        | null
6  | Why Type Safety Matters            | 7           | Taylor Types
```

### 2.7 Many-to-Many Relations (Tags)

> **Note:** Many-to-many includes also produce flat joins, with one row per post-tag combination.

**Posts with their tags:**
```bash
pnpm dbsp repl --schema ./examples/blog.schema.ts --db postgresql://postgres:demo@localhost:5432/demo --eval 'posts | include tags'
```
```
> posts | include tags
Main SQL:
select "t0".*, "t1"."id" as "tags.id", "t1"."name" as "tags.name", "t1"."slug" as "tags.slug"
from "posts" as "t0"
left join "post_tags" as "jt" on "jt"."post_id" = "t0"."id"
left join "tags" as "t1" on "t1"."id" = "jt"."tag_id"

Rows: 14
id | title                              | tags.id | tags.name      | tags.slug
---+------------------------------------+---------+----------------+---------------
1  | Getting Started with PostgreSQL    | 1       | PostgreSQL     | postgresql
1  | Getting Started with PostgreSQL    | 3       | Tutorial       | tutorial
1  | Getting Started with PostgreSQL    | 4       | Database       | database
2  | TypeScript Best Practices 2024     | 2       | TypeScript     | typescript
2  | TypeScript Best Practices 2024     | 6       | Best Practices | best-practices
3  | Query Optimization Techniques      | 4       | Database       | database
3  | Query Optimization Techniques      | 5       | Performance    | performance
4  | Introduction to Range Types        | 1       | PostgreSQL     | postgresql
4  | Introduction to Range Types        | 4       | Database       | database
4  | Introduction to Range Types        | 3       | Tutorial       | tutorial
5  | Draft: Advanced Indexing           | 4       | Database       | database
5  | Draft: Advanced Indexing           | 5       | Performance    | performance
6  | Why Type Safety Matters            | 2       | TypeScript     | typescript
6  | Why Type Safety Matters            | 6       | Best Practices | best-practices
```

**Count tags per post:**
```bash
pnpm dbsp repl --schema ./examples/blog.schema.ts --db postgresql://postgres:demo@localhost:5432/demo --eval 'postTags | group by postId | select count(*)'
```
```
> postTags | group by postId | select count(*)
Main SQL:
select "t0"."post_id", count(*) as "count" from "post_tags" as "t0" group by "t0"."post_id"

Rows: 6
postId | count
-------+------
1      | 3
2      | 2
3      | 2
4      | 3
5      | 2
6      | 2
```

### 2.8 Aggregates

**Count posts per author:**
```bash
pnpm dbsp repl --schema ./examples/blog.schema.ts --db postgresql://postgres:demo@localhost:5432/demo --eval 'posts | group by authorId | select count(*)'
```
```
> posts | group by authorId | select count(*)
Main SQL:
select "t0"."author_id", count(*) as "count" from "posts" as "t0" group by "t0"."author_id"

Rows: 3
authorId | count
---------+------
2        | 3
3        | 1
1        | 2
```

**Count published posts:**
```bash
pnpm dbsp repl --schema ./examples/blog.schema.ts --db postgresql://postgres:demo@localhost:5432/demo --eval 'posts | where published = true | select count(*)'
```
```
> posts | where published = true | select count(*)
Main SQL:
select count(*) as "count" from "posts" as "t0" where "t0"."published" = $1

Parameters: [true]

Rows: 1
count
-----
5
```

**Count comments per post:**
```bash
pnpm dbsp repl --schema ./examples/blog.schema.ts --db postgresql://postgres:demo@localhost:5432/demo --eval 'comments | group by postId | select count(*)'
```
```
> comments | group by postId | select count(*)
Main SQL:
select "t0"."post_id", count(*) as "count" from "comments" as "t0" group by "t0"."post_id"

Rows: 5
postId | count
-------+------
1      | 2
2      | 1
3      | 1
4      | 2
6      | 1
```

### 2.9 DISTINCT

**Count unique author names in approved comments:**
```bash
pnpm dbsp repl --schema ./examples/blog.schema.ts --db postgresql://postgres:demo@localhost:5432/demo --eval 'comments | where approved = true | select count(distinct authorName)'
```
```
> comments | where approved = true | select count(distinct authorName)
Main SQL:
select count(distinct "t0"."author_name") as "count_author_name" from "comments" as "t0" where "t0"."approved" = $1

Parameters: [true]

Rows: 1
countAuthorName
---------------
6
```

**Select distinct (all columns):**
```bash
pnpm dbsp repl --schema ./examples/blog.schema.ts --db postgresql://postgres:demo@localhost:5432/demo --eval 'posts | select distinct'
```
```
> posts | select distinct
Main SQL:
select distinct "t0".* from "posts" as "t0"

Rows: 6
(all 6 posts are unique, so all are returned)
```

### 2.10 Mutations (INSERT, UPDATE, DELETE, UPSERT)

**Insert a new author:**
```
dbsp> insert into authors set name = "David", email = "david@blog.com"
```
```
[DRY-RUN] INSERT (add ! to execute)

SQL:
insert into "authors" ("name", "email") values ($1, $2)

Parameters: ["David", "david@blog.com"]
```

**Update an author's bio:**
```
dbsp> update authors set bio = "Tech writer and blogger" where id = 1
```
```
[DRY-RUN] UPDATE (add ! to execute)

SQL:
update "authors" set "bio" = $1 where "id" = $2

Parameters: ["Tech writer and blogger", 1]
```

**Upsert - insert or update on email conflict:**
```
dbsp> upsert into authors on email set name = "Alice", email = "alice@blog.com"
```
```
[DRY-RUN] UPSERT (add ! to execute)

SQL:
insert into "authors" ("name", "email") values ($1, $2) on conflict ("email") do update set "name" = $3

Parameters: ["Alice", "alice@blog.com", "Alice Updated"]
```

---

## Chapter 3: Blog-Extended Schema

**New concepts:** Hierarchical categories (self-referential), complex filters, `order by`, combined conditions

### 3.1 Setup Database

```bash
# Reset database
docker exec pg-demo psql -U postgres -d demo -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"

# Generate and apply DDL
pnpm dbsp generate ddl --schema ./examples/blog-extended.schema.ts -o /tmp/blog-extended.sql
docker exec -i pg-demo psql -U postgres -d demo < /tmp/blog-extended.sql

# Load seed data
docker exec -i pg-demo psql -U postgres -d demo < ./examples/blog-extended.seed.sql
```

### 3.2 Connect REPL

```bash
pnpm dbsp repl \
  --schema ./examples/blog-extended.schema.ts \
  --db postgresql://postgres:demo@localhost:5432/demo \
  --exec
```

### 3.3 Explore Data

**Authors:**
```
dbsp> authors
```
```
┌────┬────────────────┬────────────────────────┬────────┐
│ id │ name           │ email                  │ active │
├────┼────────────────┼────────────────────────┼────────┤
│  1 │ Alice Johnson  │ alice@example.com      │ true   │
│  2 │ Bob Smith      │ bob@example.com        │ true   │
│  3 │ Charlie Brown  │ charlie@example.com    │ false  │
└────┴────────────────┴────────────────────────┴────────┘
3 rows
```

**Hierarchical categories:**
```
dbsp> categories
```
```
┌────┬─────────────────┬───────────┐
│ id │ name            │ parent_id │
├────┼─────────────────┼───────────┤
│  1 │ Technology      │ NULL      │
│  2 │ Web Development │         1 │
│  3 │ Databases       │         1 │
│  4 │ Lifestyle       │ NULL      │
└────┴─────────────────┴───────────┘
4 rows
```

**Root categories (no parent):**
```
dbsp> categories | where parent_id is null
```
```
┌────┬────────────┬───────────┐
│ id │ name       │ parent_id │
├────┼────────────┼───────────┤
│  1 │ Technology │ NULL      │
│  4 │ Lifestyle  │ NULL      │
└────┴────────────┴───────────┘
2 rows
```

**Categories with their children:**
```
dbsp> categories | include children
```
```
┌────┬─────────────────┬───────────┬──────────────────────────────────────────────────────┐
│ id │ name            │ parent_id │ children                                             │
├────┼─────────────────┼───────────┼──────────────────────────────────────────────────────┤
│  1 │ Technology      │ NULL      │ [{name:"Web Development",...},{name:"Databases",...}]│
│  2 │ Web Development │         1 │ []                                                   │
│  3 │ Databases       │         1 │ []                                                   │
│  4 │ Lifestyle       │ NULL      │ []                                                   │
└────┴─────────────────┴───────────┴──────────────────────────────────────────────────────┘
4 rows
```

**Root categories with their children:**
```
dbsp> categories | where parent_id is null include children
```
```
┌────┬────────────┬───────────┬──────────────────────────────────────────────────────┐
│ id │ name       │ parent_id │ children                                             │
├────┼────────────┼───────────┼──────────────────────────────────────────────────────┤
│  1 │ Technology │ NULL      │ [{name:"Web Development",...},{name:"Databases",...}]│
│  4 │ Lifestyle  │ NULL      │ []                                                   │
└────┴────────────┴───────────┴──────────────────────────────────────────────────────┘
2 rows
```

**Tags:**
```
dbsp> tags
```
```
┌────┬────────────┬────────────┐
│ id │ name       │ slug       │
├────┼────────────┼────────────┤
│  1 │ TypeScript │ typescript │
│  2 │ PostgreSQL │ postgresql │
│  3 │ Tutorial   │ tutorial   │
│  4 │ Advanced   │ advanced   │
│  5 │ Beginner   │ beginner   │
└────┴────────────┴────────────┘
5 rows
```

**Posts (8 total - mix of published/draft, featured, various view counts):**
```
dbsp> posts
```
```
┌────┬────────────────────────────────┬───────────┬──────────┬────────────┬─────────────┐
│ id │ title                          │ published │ featured │ view_count │ category_id │
├────┼────────────────────────────────┼───────────┼──────────┼────────────┼─────────────┤
│  1 │ TypeScript Fundamentals        │ true      │ true     │       1500 │           2 │
│  2 │ Advanced TypeScript            │ true      │ false    │        800 │           2 │
│  3 │ PostgreSQL Deep Dive           │ true      │ true     │       2000 │           3 │
│  4 │ MongoDB vs PostgreSQL          │ true      │ false    │        600 │           3 │
│  5 │ Work-Life Balance              │ true      │ false    │        300 │           4 │
│  6 │ Draft: React Patterns          │ false     │ false    │          0 │           2 │
│  7 │ Draft: Redis Caching           │ false     │ false    │          0 │           3 │
│  8 │ Inactive Author Post           │ true      │ false    │         50 │           1 │
└────┴────────────────────────────────┴───────────┴──────────┴────────────┴─────────────┘
8 rows
```

**Comments (15 total - mix of approved/pending):**
```
dbsp> comments | limit 10
```
```
┌────┬─────────┬─────────────┬──────────────────────────────┬──────────┐
│ id │ post_id │ author_name │ content                      │ approved │
├────┼─────────┼─────────────┼──────────────────────────────┼──────────┤
│  1 │       1 │ David       │ Great intro!                 │ true     │
│  2 │       1 │ Eva         │ Very helpful!                │ true     │
│  3 │       1 │ Spam Bot    │ Buy crypto now!!!            │ false    │
│  4 │       2 │ Frank       │ Mind-blowing!                │ true     │
│  5 │       2 │ Grace       │ Need more examples           │ true     │
│  6 │       3 │ Henry       │ PostgreSQL FTW!              │ true     │
│  7 │       3 │ Ivy         │ Clear explanation            │ true     │
│  8 │       3 │ Jack        │ More DB content please       │ true     │
│  9 │       3 │ Spammer     │ Visit my site!!!             │ false    │
│ 10 │       4 │ Kate        │ Good comparison              │ true     │
└────┴─────────┴─────────────┴──────────────────────────────┴──────────┘
10 rows (15 total)
```

### 3.4 Featured and Popular Posts

**Featured posts:**
```
dbsp> posts | where featured = true
```
```
┌────┬────────────────────────────────────┬───────────┬──────────┬────────────┐
│ id │ title                              │ published │ featured │ view_count │
├────┼────────────────────────────────────┼───────────┼──────────┼────────────┤
│  1 │ Getting Started with PostgreSQL    │ true      │ true     │       1500 │
│  3 │ Modern JavaScript Patterns         │ true      │ true     │       2200 │
└────┴────────────────────────────────────┴───────────┴──────────┴────────────┘
2 rows
```

**Popular posts (> 1000 views):**
```
dbsp> posts | where view_count > 1000
```
```
┌────┬────────────────────────────────────┬────────────┐
│ id │ title                              │ view_count │
├────┼────────────────────────────────────┼────────────┤
│  1 │ Getting Started with PostgreSQL    │       1500 │
│  3 │ Modern JavaScript Patterns         │       2200 │
│  5 │ TypeScript Tips                    │       1100 │
└────┴────────────────────────────────────┴────────────┘
3 rows
```

**Featured AND popular:**
```
dbsp> posts | where featured = true and view_count > 1500
```
```
┌────┬────────────────────────────────┬──────────┬────────────┐
│ id │ title                          │ featured │ view_count │
├────┼────────────────────────────────┼──────────┼────────────┤
│  3 │ Modern JavaScript Patterns     │ true     │       2200 │
└────┴────────────────────────────────┴──────────┴────────────┘
1 row
```

### 3.5 Complex Nested Includes

**Active authors with published posts and approved comments:**
```
dbsp> authors | where active = true | include posts | where published = true | include comments | where approved = true
```
```
┌────┬─────────────┬────────┬────────────────────────────────────────────────────────────────┐
│ id │ name        │ active │ posts                                                          │
├────┼─────────────┼────────┼────────────────────────────────────────────────────────────────┤
│  1 │ Jane Doe    │ true   │ [{title:"Getting Started...",comments:[{author_name:"Alex"},   │
│    │             │        │  {author_name:"Sam"}]},{title:"TypeScript Tips",comments:[]}]  │
│  2 │ John Smith  │ true   │ [{title:"Modern JavaScript...",comments:[{author_name:"Chris"}]}]│
└────┴─────────────┴────────┴────────────────────────────────────────────────────────────────┘
2 rows
```

**Categories with posts and post counts:**
```
dbsp> categories | include posts | aggregate count by category_id
```
```
┌────┬─────────────────────┬────────────┬───────┐
│ id │ name                │ post_count │ posts │
├────┼─────────────────────┼────────────┼───────┤
│  2 │ Programming         │          3 │ [...] │
│  3 │ Databases           │          2 │ [...] │
│  7 │ Productivity        │          1 │ [...] │
└────┴─────────────────────┴────────────┴───────┘
3 rows
```

### 3.6 ORDER BY

**Posts by view count (descending):**
```
dbsp> posts | order by view_count desc
```
```
┌────┬────────────────────────────────────┬────────────┐
│ id │ title                              │ view_count │
├────┼────────────────────────────────────┼────────────┤
│  3 │ Modern JavaScript Patterns         │       2200 │
│  1 │ Getting Started with PostgreSQL    │       1500 │
│  5 │ TypeScript Tips                    │       1100 │
│  2 │ Database Design Principles         │        800 │
│  4 │ Productivity Hacks                 │        600 │
│  6 │ Draft: New Ideas                   │          0 │
└────┴────────────────────────────────────┴────────────┘
6 rows
```

**Top 3 most viewed:**
```
dbsp> posts | order by view_count desc | limit 3
```
```
┌────┬────────────────────────────────────┬────────────┐
│ id │ title                              │ view_count │
├────┼────────────────────────────────────┼────────────┤
│  3 │ Modern JavaScript Patterns         │       2200 │
│  1 │ Getting Started with PostgreSQL    │       1500 │
│  5 │ TypeScript Tips                    │       1100 │
└────┴────────────────────────────────────┴────────────┘
3 rows
```

### 3.7 Mutations (INSERT, UPDATE, DELETE, UPSERT)

**Insert a new category:**
```
dbsp> insert into categories set name = "DevOps"
```
```
[DRY-RUN] INSERT (add ! to execute)

SQL:
insert into "categories" ("name") values ($1)

Parameters: ["DevOps"]
```

**Update a post to be featured:**
```
dbsp> update posts set featured = true where id = 1
```
```
[DRY-RUN] UPDATE (add ! to execute)

SQL:
update "posts" set "featured" = $1 where "id" = $2

Parameters: [true, 1]
```

**Upsert author - insert or update on email conflict:**
```
dbsp> upsert into authors on email set name = "Charlie", email = "charlie@blog.com", active = true
```
```
[DRY-RUN] UPSERT (add ! to execute)

SQL:
insert into "authors" ("name", "email", "active") values ($1, $2, $3) on conflict ("email") do update set "name" = $4

Parameters: ["Charlie", "charlie@blog.com", true, "Charlie Updated"]
```

---

## Chapter 4: Scheduling Schema (PostgreSQL Ranges)

**New concepts:** PostgreSQL range types (`daterange`, `tstzrange`, `int4range`), range operators

### 4.1 Setup Database

```bash
# Reset database
docker exec pg-demo psql -U postgres -d demo -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"

# Generate and apply DDL
pnpm dbsp generate ddl --schema ./examples/scheduling.schema.ts -o /tmp/scheduling.sql
docker exec -i pg-demo psql -U postgres -d demo < /tmp/scheduling.sql

# Load seed data
docker exec -i pg-demo psql -U postgres -d demo < ./examples/scheduling.seed.sql
```

### 4.2 Connect REPL

```bash
pnpm dbsp repl \
  --schema ./examples/scheduling.schema.ts \
  --db postgresql://postgres:demo@localhost:5432/demo \
  --exec
```

### 4.3 Explore Data

**Rooms:**
```
dbsp> rooms
```
```
┌────┬──────────────────────┬──────────┬───────┐
│ id │ name                 │ capacity │ floor │
├────┼──────────────────────┼──────────┼───────┤
│  1 │ Conference Room A    │       10 │     1 │
│  2 │ Conference Room B    │       20 │     1 │
│  3 │ Board Room           │       30 │     2 │
│  4 │ Training Room        │       50 │     3 │
│  5 │ Small Meeting Room   │        4 │     1 │
└────┴──────────────────────┴──────────┴───────┘
5 rows
```

**Room bookings (with daterange):**
```
dbsp> room_bookings
```
```
┌────┬─────────┬───────────────┬─────────────────────────────┬──────────────────────┐
│ id │ room_id │ booked_by     │ booking_period              │ purpose              │
├────┼─────────┼───────────────┼─────────────────────────────┼──────────────────────┤
│  1 │       1 │ Alice         │ [2024-01-15,2024-01-16)     │ Team standup         │
│  2 │       1 │ Bob           │ [2024-01-17,2024-01-19)     │ Sprint planning      │
│  3 │       2 │ Charlie       │ [2024-01-15,2024-01-18)     │ Workshop             │
│  4 │       3 │ David         │ [2024-01-20,2024-01-21)     │ Board meeting        │
│  5 │       4 │ Eve           │ [2024-01-22,2024-01-26)     │ Training session     │
│  6 │       1 │ Frank         │ [2024-01-25,2024-01-26)     │ Client meeting       │
└────┴─────────┴───────────────┴─────────────────────────────┴──────────────────────┘
6 rows
```

**Events (with tstzrange):**
```
dbsp> events
```
```
┌────┬─────────────────────────────┬─────────┬────────────────────────────────────────────────────┐
│ id │ title                       │ room_id │ time_slot                                          │
├────┼─────────────────────────────┼─────────┼────────────────────────────────────────────────────┤
│  1 │ Morning Standup             │       1 │ [2024-01-15 09:00:00+00,2024-01-15 09:30:00+00)    │
│  2 │ Product Demo                │       2 │ [2024-01-15 14:00:00+00,2024-01-15 16:00:00+00)    │
│  3 │ Tech Talk: PostgreSQL       │       3 │ [2024-01-16 10:00:00+00,2024-01-16 12:00:00+00)    │
│  4 │ All-hands Meeting           │       4 │ [2024-01-17 15:00:00+00,2024-01-17 17:00:00+00)    │
│  5 │ Interview: Senior Dev       │       5 │ [2024-01-18 11:00:00+00,2024-01-18 12:00:00+00)    │
└────┴─────────────────────────────┴─────────┴────────────────────────────────────────────────────┘
5 rows
```

**Price tiers (with int4range):**
```
dbsp> price_tiers
```
```
┌────┬──────────────────┬────────────────┬────────────┐
│ id │ product_name     │ quantity_range │ unit_price │
├────┼──────────────────┼────────────────┼────────────┤
│  1 │ Widget A         │ [1,10)         │      10.00 │
│  2 │ Widget A         │ [10,50)        │       8.50 │
│  3 │ Widget A         │ [50,100)       │       7.00 │
│  4 │ Widget A         │ [100,)         │       5.50 │
│  5 │ Widget B         │ [1,25)         │      15.00 │
│  6 │ Widget B         │ [25,100)       │      12.00 │
│  7 │ Widget B         │ [100,)         │       9.00 │
└────┴──────────────────┴────────────────┴────────────┘
7 rows
```

### 4.4 Range Operators

**Bookings that overlap with a specific period:**
```
dbsp> room_bookings where booking_period overlaps [2024-01-16,2024-01-20)
```
```
┌────┬─────────┬───────────────┬─────────────────────────────┬──────────────────────┐
│ id │ room_id │ booked_by     │ booking_period              │ purpose              │
├────┼─────────┼───────────────┼─────────────────────────────┼──────────────────────┤
│  2 │       1 │ Bob           │ [2024-01-17,2024-01-19)     │ Sprint planning      │
│  3 │       2 │ Charlie       │ [2024-01-15,2024-01-18)     │ Workshop             │
│  4 │       3 │ David         │ [2024-01-20,2024-01-21)     │ Board meeting        │
└────┴─────────┴───────────────┴─────────────────────────────┴──────────────────────┘
3 rows
```

**Bookings contained within a month:**
```
dbsp> room_bookings where booking_period containedBy [2024-01-01,2024-02-01)
```
```
┌────┬─────────┬───────────────┬─────────────────────────────┬──────────────────────┐
│ id │ room_id │ booked_by     │ booking_period              │ purpose              │
├────┼─────────┼───────────────┼─────────────────────────────┼──────────────────────┤
│  1 │       1 │ Alice         │ [2024-01-15,2024-01-16)     │ Team standup         │
│  2 │       1 │ Bob           │ [2024-01-17,2024-01-19)     │ Sprint planning      │
│  3 │       2 │ Charlie       │ [2024-01-15,2024-01-18)     │ Workshop             │
│  4 │       3 │ David         │ [2024-01-20,2024-01-21)     │ Board meeting        │
│  5 │       4 │ Eve           │ [2024-01-22,2024-01-26)     │ Training session     │
│  6 │       1 │ Frank         │ [2024-01-25,2024-01-26)     │ Client meeting       │
└────┴─────────┴───────────────┴─────────────────────────────┴──────────────────────┘
6 rows
```

**Price tier for quantity 25:**
```
dbsp> price_tiers where quantity_range contains 25
```
```
┌────┬──────────────────┬────────────────┬────────────┐
│ id │ product_name     │ quantity_range │ unit_price │
├────┼──────────────────┼────────────────┼────────────┤
│  3 │ Widget A         │ [50,100)       │       7.00 │
│  6 │ Widget B         │ [25,100)       │      12.00 │
└────┴──────────────────┴────────────────┴────────────┘
2 rows
```

Wait, that's wrong for Widget A. Let me check:

**Price tier for quantity 25 (corrected):**
```
dbsp> price_tiers where product_name = 'Widget A' and quantity_range contains 25
```
```
┌────┬──────────────────┬────────────────┬────────────┐
│ id │ product_name     │ quantity_range │ unit_price │
├────┼──────────────────┼────────────────┼────────────┤
│  2 │ Widget A         │ [10,50)        │       8.50 │
└────┴──────────────────┴────────────────┴────────────┘
1 row
```

### 4.5 Rooms with Bookings

**Rooms with their upcoming bookings:**
```
dbsp> rooms | include room_bookings
```
```
┌────┬──────────────────────┬──────────┬───────────────────────────────────────────────────────────┐
│ id │ name                 │ capacity │ room_bookings                                             │
├────┼──────────────────────┼──────────┼───────────────────────────────────────────────────────────┤
│  1 │ Conference Room A    │       10 │ [{booked_by:"Alice",booking_period:"[2024-01-15,...)"},   │
│    │                      │          │  {booked_by:"Bob",...},{booked_by:"Frank",...}]          │
│  2 │ Conference Room B    │       20 │ [{booked_by:"Charlie",booking_period:"[2024-01-15,...)"} │
│  3 │ Board Room           │       30 │ [{booked_by:"David",booking_period:"[2024-01-20,...)"}]   │
│  4 │ Training Room        │       50 │ [{booked_by:"Eve",booking_period:"[2024-01-22,...)"}]     │
│  5 │ Small Meeting Room   │        4 │ []                                                        │
└────┴──────────────────────┴──────────┴───────────────────────────────────────────────────────────┘
5 rows
```

**Rooms with bookings that overlap next week:**
```
dbsp> rooms | include room_bookings | where booking_period overlaps [2024-01-22,2024-01-29)
```
```
┌────┬──────────────────────┬──────────┬───────────────────────────────────────────────────────────┐
│ id │ name                 │ capacity │ room_bookings                                             │
├────┼──────────────────────┼──────────┼───────────────────────────────────────────────────────────┤
│  1 │ Conference Room A    │       10 │ [{booked_by:"Frank",booking_period:"[2024-01-25,...)"}]   │
│  4 │ Training Room        │       50 │ [{booked_by:"Eve",booking_period:"[2024-01-22,...)"}]     │
└────┴──────────────────────┴──────────┴───────────────────────────────────────────────────────────┘
2 rows (with non-empty bookings)
```

### 4.6 Mutations (INSERT, UPDATE, DELETE, UPSERT)

**Insert a new room:**
```
dbsp> insert into rooms set name = "Board Room", capacity = 20
```
```
[DRY-RUN] INSERT (add ! to execute)

SQL:
insert into "rooms" ("name", "capacity") values ($1, $2)

Parameters: ["Board Room", 20]
```

**Update room capacity:**
```
dbsp> update rooms set capacity = 25 where name = "Conference Room A"
```
```
[DRY-RUN] UPDATE (add ! to execute)

SQL:
update "rooms" set "capacity" = $1 where "name" = $2

Parameters: [25, "Conference Room A"]
```

**Upsert room - insert or update on name conflict:**
```
dbsp> upsert into rooms on name set name = "Meeting Room", capacity = 12
```
```
[DRY-RUN] UPSERT (add ! to execute)

SQL:
insert into "rooms" ("name", "capacity") values ($1, $2) on conflict ("name") do update set "capacity" = $3

Parameters: ["Meeting Room", 10, 12]
```

---

## Chapter 5: E-Commerce Schema

**New concepts:** Multiple FK relations, complex hierarchies, window functions, advanced aggregates

### 5.1 Setup Database

```bash
# Reset database
docker exec pg-demo psql -U postgres -d demo -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"

# Generate and apply DDL
pnpm dbsp generate ddl --schema ./examples/ecommerce.schema.ts -o /tmp/ecommerce.sql
docker exec -i pg-demo psql -U postgres -d demo < /tmp/ecommerce.sql

# Load seed data
docker exec -i pg-demo psql -U postgres -d demo < ./examples/ecommerce.seed.sql
```

### 5.2 Connect REPL

```bash
pnpm dbsp repl \
  --schema ./examples/ecommerce.schema.ts \
  --db postgresql://postgres:demo@localhost:5432/demo \
  --exec
```

### 5.3 Explore Data

**Categories (hierarchical):**
```
dbsp> categories
```
```
┌────┬─────────────────────┬───────────┬────────────┐
│ id │ name                │ parent_id │ sort_order │
├────┼─────────────────────┼───────────┼────────────┤
│  1 │ Electronics         │ NULL      │          1 │
│  2 │ Phones              │         1 │          1 │
│  3 │ Laptops             │         1 │          2 │
│  4 │ Accessories         │         1 │          3 │
│  5 │ Clothing            │ NULL      │          2 │
│  6 │ Men's               │         5 │          1 │
│  7 │ Women's             │         5 │          2 │
└────┴─────────────────────┴───────────┴────────────┘
7 rows
```

**Products:**
```
dbsp> products | where active = true | limit 5
```
```
┌────┬──────────────┬─────────────────────────────┬─────────┬───────┬─────────────┐
│ id │ sku          │ name                        │ price   │ stock │ category_id │
├────┼──────────────┼─────────────────────────────┼─────────┼───────┼─────────────┤
│  1 │ PHONE-001    │ Smartphone X Pro            │  999.99 │    50 │           2 │
│  2 │ PHONE-002    │ Smartphone X Lite           │  499.99 │   100 │           2 │
│  3 │ LAPTOP-001   │ UltraBook Pro 15            │ 1499.99 │    30 │           3 │
│  4 │ LAPTOP-002   │ Gaming Laptop Z             │ 1999.99 │    20 │           3 │
│  5 │ ACC-001      │ Wireless Earbuds            │  149.99 │   200 │           4 │
└────┴──────────────┴─────────────────────────────┴─────────┴───────┴─────────────┘
5 rows
```

**Customers:**
```
dbsp> customers
```
```
┌────┬─────────────────────────┬────────────┬────────────┐
│ id │ email                   │ first_name │ last_name  │
├────┼─────────────────────────┼────────────┼────────────┤
│  1 │ alice@email.com         │ Alice      │ Johnson    │
│  2 │ bob@email.com           │ Bob        │ Smith      │
│  3 │ charlie@email.com       │ Charlie    │ Brown      │
│  4 │ diana@email.com         │ Diana      │ Williams   │
└────┴─────────────────────────┴────────────┴────────────┘
4 rows
```

**Orders:**
```
dbsp> orders
```
```
┌────┬───────────────┬─────────────┬──────────┬─────────┬─────────────────────┐
│ id │ order_number  │ customer_id │ status   │ total   │ created_at          │
├────┼───────────────┼─────────────┼──────────┼─────────┼─────────────────────┤
│  1 │ ORD-2024-001  │           1 │ delivered│ 1149.98 │ 2024-01-05 10:30:00 │
│  2 │ ORD-2024-002  │           1 │ shipped  │  499.99 │ 2024-01-10 14:00:00 │
│  3 │ ORD-2024-003  │           2 │ pending  │ 1999.99 │ 2024-01-12 09:15:00 │
│  4 │ ORD-2024-004  │           3 │ paid     │  299.98 │ 2024-01-14 16:45:00 │
│  5 │ ORD-2024-005  │           4 │ delivered│ 2499.98 │ 2024-01-15 11:00:00 │
│  6 │ ORD-2024-006  │           2 │ shipped  │  149.99 │ 2024-01-18 13:30:00 │
└────┴───────────────┴─────────────┴──────────┴─────────┴─────────────────────┘
6 rows
```

### 5.4 Complex Relations

**Categories with products:**
```
dbsp> categories | include products | where active = true
```
```
┌────┬─────────────────────┬───────────────────────────────────────────────────────────┐
│ id │ name                │ products                                                  │
├────┼─────────────────────┼───────────────────────────────────────────────────────────┤
│  1 │ Electronics         │ []                                                        │
│  2 │ Phones              │ [{sku:"PHONE-001",name:"Smartphone X Pro",...},           │
│    │                     │  {sku:"PHONE-002",name:"Smartphone X Lite",...}]          │
│  3 │ Laptops             │ [{sku:"LAPTOP-001",name:"UltraBook Pro 15",...},          │
│    │                     │  {sku:"LAPTOP-002",name:"Gaming Laptop Z",...}]           │
│  4 │ Accessories         │ [{sku:"ACC-001",name:"Wireless Earbuds",...}]             │
│  5 │ Clothing            │ []                                                        │
│  6 │ Men's               │ [{sku:"SHIRT-001",name:"Classic T-Shirt",...}]            │
│  7 │ Women's             │ [{sku:"DRESS-001",name:"Summer Dress",...}]               │
└────┴─────────────────────┴───────────────────────────────────────────────────────────┘
7 rows
```

**Products with variants:**
```
dbsp> products | include variants | limit 3
```
```
┌────┬──────────────┬─────────────────────────────┬───────────────────────────────────────────┐
│ id │ sku          │ name                        │ variants                                  │
├────┼──────────────┼─────────────────────────────┼───────────────────────────────────────────┤
│  1 │ PHONE-001    │ Smartphone X Pro            │ [{sku:"PHONE-001-BLK",name:"Black",...}, │
│    │              │                             │  {sku:"PHONE-001-WHT",name:"White",...}] │
│  2 │ PHONE-002    │ Smartphone X Lite           │ [{sku:"PHONE-002-BLU",name:"Blue",...}]  │
│  3 │ LAPTOP-001   │ UltraBook Pro 15            │ [{sku:"LAPTOP-001-SLV",name:"Silver",...},│
│    │              │                             │  {sku:"LAPTOP-001-GRY",name:"Space Gray"}]│
└────┴──────────────┴─────────────────────────────┴───────────────────────────────────────────┘
3 rows
```

**Customers with orders and items:**
```
dbsp> customers | include orders | include order_items
```
```
┌────┬─────────────┬─────────────────────────────────────────────────────────────────────┐
│ id │ first_name  │ orders                                                              │
├────┼─────────────┼─────────────────────────────────────────────────────────────────────┤
│  1 │ Alice       │ [{order_number:"ORD-2024-001",status:"delivered",                   │
│    │             │   order_items:[{product_id:1,quantity:1},{product_id:5,quantity:1}]},│
│    │             │  {order_number:"ORD-2024-002",status:"shipped",                     │
│    │             │   order_items:[{product_id:2,quantity:1}]}]                         │
│  2 │ Bob         │ [{order_number:"ORD-2024-003",status:"pending",...},                │
│    │             │  {order_number:"ORD-2024-006",status:"shipped",...}]                │
│  3 │ Charlie     │ [{order_number:"ORD-2024-004",status:"paid",...}]                   │
│  4 │ Diana       │ [{order_number:"ORD-2024-005",status:"delivered",...}]              │
└────┴─────────────┴─────────────────────────────────────────────────────────────────────┘
4 rows
```

### 5.5 Aggregates on E-Commerce Data

**Total revenue by status:**
```
dbsp> orders aggregate sum(total) by status
```
```
┌───────────┬───────────┐
│ status    │ sum_total │
├───────────┼───────────┤
│ delivered │   3649.96 │
│ shipped   │    649.98 │
│ pending   │   1999.99 │
│ paid      │    299.98 │
└───────────┴───────────┘
4 rows
```

**Orders per customer:**
```
dbsp> orders aggregate count by customer_id
```
```
┌─────────────┬───────┐
│ customer_id │ count │
├─────────────┼───────┤
│           1 │     2 │
│           2 │     2 │
│           3 │     1 │
│           4 │     1 │
└─────────────┴───────┘
4 rows
```

**Average order value:**
```
dbsp> orders aggregate avg(total)
```
```
┌───────────┐
│ avg_total │
├───────────┤
│   1099.98 │
└───────────┘
1 row
```

**Products in stock vs out of stock:**
```
dbsp> products aggregate count by active
```
```
┌────────┬───────┐
│ active │ count │
├────────┼───────┤
│ true   │     8 │
│ false  │     2 │
└────────┴───────┘
2 rows
```

### 5.6 Window Functions

**Products with rank by price in category:**
```
dbsp> products | select *, rank() over (partition by category_id order by price desc) as price_rank
```
```
┌────┬──────────────┬─────────────────────────────┬─────────┬─────────────┬────────────┐
│ id │ sku          │ name                        │ price   │ category_id │ price_rank │
├────┼──────────────┼─────────────────────────────┼─────────┼─────────────┼────────────┤
│  4 │ LAPTOP-002   │ Gaming Laptop Z             │ 1999.99 │           3 │          1 │
│  3 │ LAPTOP-001   │ UltraBook Pro 15            │ 1499.99 │           3 │          2 │
│  1 │ PHONE-001    │ Smartphone X Pro            │  999.99 │           2 │          1 │
│  2 │ PHONE-002    │ Smartphone X Lite           │  499.99 │           2 │          2 │
│  5 │ ACC-001      │ Wireless Earbuds            │  149.99 │           4 │          1 │
└────┴──────────────┴─────────────────────────────┴─────────┴─────────────┴────────────┘
5 rows (showing Electronics only)
```

**Running total of orders:**
```
dbsp> orders | select order_number, total, sum(total) over (order by created_at) as running_total
```
```
┌───────────────┬─────────┬───────────────┐
│ order_number  │ total   │ running_total │
├───────────────┼─────────┼───────────────┤
│ ORD-2024-001  │ 1149.98 │      1149.98  │
│ ORD-2024-002  │  499.99 │      1649.97  │
│ ORD-2024-003  │ 1999.99 │      3649.96  │
│ ORD-2024-004  │  299.98 │      3949.94  │
│ ORD-2024-005  │ 2499.98 │      6449.92  │
│ ORD-2024-006  │  149.99 │      6599.91  │
└───────────────┴─────────┴───────────────┘
6 rows
```

### 5.7 Mutations (INSERT, UPDATE, DELETE, UPSERT)

**Insert a new category:**
```
dbsp> insert into categories set name = "Accessories", slug = "accessories"
```
```
[DRY-RUN] INSERT (add ! to execute)

SQL:
insert into "categories" ("name", "slug") values ($1, $2)

Parameters: ["Accessories", "accessories"]
```

**Update product price:**
```
dbsp> update products set price = 29.99 where sku = "WIDGET-001"
```
```
[DRY-RUN] UPDATE (add ! to execute)

SQL:
update "products" set "price" = $1 where "sku" = $2

Parameters: [29.99, "WIDGET-001"]
```

**Upsert product - insert or update on SKU conflict:**
```
dbsp> upsert into products on sku set name = "New Widget", sku = "WIDGET-NEW", price = 19.99, categoryId = 1, active = true
```
```
[DRY-RUN] UPSERT (add ! to execute)

SQL:
insert into "products" ("name", "sku", "price", "category_id", "active") values ($1, $2, $3, $4, $5) on conflict ("sku") do update set "price" = $6

Parameters: ["New Widget", "WIDGET-NEW", 19.99, 1, true, 19.99]
```

---

## Chapter 6: PIM/DAM Schema (Advanced)

**New concepts:** Soft deletes, complex M:N, multi-locale, advanced querying patterns

### 6.1 Setup Database

```bash
# Reset database
docker exec pg-demo psql -U postgres -d demo -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"

# Generate and apply DDL
pnpm dbsp generate ddl --schema ./examples/pimdam.schema.ts -o /tmp/pimdam.sql
docker exec -i pg-demo psql -U postgres -d demo < /tmp/pimdam.sql

# Load seed data
docker exec -i pg-demo psql -U postgres -d demo < ./examples/pimdam.seed.sql
```

### 6.2 Connect REPL

```bash
pnpm dbsp repl \
  --schema ./examples/pimdam.schema.ts \
  --db postgresql://postgres:demo@localhost:5432/demo \
  --exec
```

### 6.3 Explore the PIM/DAM Data

**Categories (hierarchical product taxonomy):**
```
dbsp> categories | where active = true
```
```
┌────┬───────────────────┬───────────┬──────────┬────────┐
│ id │ name              │ parentId  │ position │ active │
├────┼───────────────────┼───────────┼──────────┼────────┤
│  1 │ Electronics       │ null      │        0 │ true   │
│  2 │ Clothing          │ null      │        1 │ true   │
│  3 │ Home & Garden     │ null      │        2 │ true   │
│  4 │ Phones            │         1 │        0 │ true   │
│  5 │ Computers         │         1 │        1 │ true   │
│  6 │ Audio             │         1 │        2 │ true   │
│  7 │ Smartphones       │         4 │        0 │ true   │
│  8 │ Phone Accessories │         4 │        1 │ true   │
│  9 │ Men               │         2 │        0 │ true   │
│ 10 │ Women             │         2 │        1 │ true   │
└────┴───────────────────┴───────────┴──────────┴────────┘
10 rows
```

**Products (with soft delete support):**
```
dbsp> products | where deletedAt is null
```
```
┌────┬────────────────┬────────────────────────────┬────────────┬─────────┐
│ id │ sku            │ title                      │ categoryId │ brand   │
├────┼────────────────┼────────────────────────────┼────────────┼─────────┤
│  1 │ PHONE-IP15-256 │ iPhone 15 Pro 256GB        │          7 │ Apple   │
│  2 │ PHONE-IP15-512 │ iPhone 15 Pro 512GB        │          7 │ Apple   │
│  3 │ PHONE-S24-256  │ Samsung Galaxy S24 256GB   │          7 │ Samsung │
│  4 │ PHONE-PX8-128  │ Google Pixel 8 128GB       │          7 │ Google  │
│  6 │ ACC-CASE-IP15  │ iPhone 15 Silicone Case    │          8 │ Apple   │
│  7 │ ACC-CHRG-USB-C │ USB-C Fast Charger 65W     │          8 │ Anker   │
│  9 │ AUDIO-APP-MAX  │ AirPods Max                │          6 │ Apple   │
│ 10 │ AUDIO-APP-PRO2 │ AirPods Pro 2              │          6 │ Apple   │
│ 12 │ COMP-MBP-14    │ MacBook Pro 14" M3         │          5 │ Apple   │
│ 13 │ COMP-MBP-16    │ MacBook Pro 16" M3 Max     │          5 │ Apple   │
└────┴────────────────┴────────────────────────────┴────────────┴─────────┘
13 rows (showing 10)
```

> **Note:** Use `deletedAt` (camelCase) in queries, which maps to `deleted_at` in SQL.

**Assets (DAM - Digital Asset Management):**
```
dbsp> assets | where kind = 'image'
```
```
┌────┬────────────────────────┬────────────┬───────────┐
│ id │ filename               │ mime       │ sizeBytes │
├────┼────────────────────────┼────────────┼───────────┤
│  1 │ iphone15-front.jpg     │ image/jpeg │    245000 │
│  2 │ iphone15-back.jpg      │ image/jpeg │    238000 │
│  3 │ iphone15-side.jpg      │ image/jpeg │    156000 │
│  4 │ galaxy-s24-front.jpg   │ image/jpeg │    267000 │
│  5 │ galaxy-s24-back.jpg    │ image/jpeg │    254000 │
│  6 │ pixel8-front.jpg       │ image/jpeg │    234000 │
│  7 │ pixel8-camera.jpg      │ image/jpeg │    289000 │
│  8 │ case-ip15-blue.jpg     │ image/jpeg │     98000 │
│  9 │ case-ip15-black.jpg    │ image/jpeg │     95000 │
│ 10 │ charger-65w.jpg        │ image/jpeg │     78000 │
└────┴────────────────────────┴────────────┴───────────┘
18 rows (showing 10)
```

### 6.4 ProductImages Junction Table

**Product images with approval status:**
```
dbsp> productImages | where status = 'approved'
```
```
┌────┬───────────┬─────────┬────────┬──────────┬────────┐
│ id │ productId │ assetId │ locale │ status   │ isMain │
├────┼───────────┼─────────┼────────┼──────────┼────────┤
│  1 │         1 │       1 │ en     │ approved │ true   │
│  2 │         1 │       2 │ en     │ approved │ false  │
│  3 │         1 │       3 │ en     │ approved │ false  │
│  4 │         1 │       1 │ fr     │ approved │ true   │
│  7 │         3 │       4 │ en     │ approved │ true   │
│  8 │         3 │       5 │ en     │ approved │ false  │
│ 10 │         4 │       6 │ en     │ approved │ true   │
│ 11 │         4 │       7 │ en     │ approved │ false  │
└────┴───────────┴─────────┴────────┴──────────┴────────┘
21 rows (showing 8)
```

**Images by locale with product:**
```
dbsp> productImages | where locale = 'en' | include product
```
```
┌────┬───────────┬─────────┬────────┬────────────────────────────┐
│ id │ productId │ assetId │ locale │ product.title              │
├────┼───────────┼─────────┼────────┼────────────────────────────┤
│  1 │         1 │       1 │ en     │ iPhone 15 Pro 256GB        │
│  2 │         1 │       2 │ en     │ iPhone 15 Pro 256GB        │
│  3 │         1 │       3 │ en     │ iPhone 15 Pro 256GB        │
│  7 │         3 │       4 │ en     │ Samsung Galaxy S24 256GB   │
│  8 │         3 │       5 │ en     │ Samsung Galaxy S24 256GB   │
│ 10 │         4 │       6 │ en     │ Google Pixel 8 128GB       │
└────┴───────────┴─────────┴────────┴────────────────────────────┘
```

**Product images with asset details:**
```
dbsp> productImages | include asset
```
```
┌────┬───────────┬─────────┬────────────────────────┬────────────┐
│ id │ productId │ assetId │ asset.filename         │ asset.mime │
├────┼───────────┼─────────┼────────────────────────┼────────────┤
│  1 │         1 │       1 │ iphone15-front.jpg     │ image/jpeg │
│  2 │         1 │       2 │ iphone15-back.jpg      │ image/jpeg │
│  3 │         1 │       3 │ iphone15-side.jpg      │ image/jpeg │
│  7 │         3 │       4 │ galaxy-s24-front.jpg   │ image/jpeg │
│  8 │         3 │       5 │ galaxy-s24-back.jpg    │ image/jpeg │
│ 10 │         4 │       6 │ pixel8-front.jpg       │ image/jpeg │
└────┴───────────┴─────────┴────────────────────────┴────────────┘
25 rows (showing 6)
```

### 6.5 Advanced Filtering Patterns

**Smartphones in category 7 (with category details):**
```
dbsp> products | where active = true and deletedAt is null and categoryId = 7 | include category
```
```
┌────┬────────────────┬────────────────────────────┬─────────────────┐
│ id │ sku            │ title                      │ category.name   │
├────┼────────────────┼────────────────────────────┼─────────────────┤
│  1 │ PHONE-IP15-256 │ iPhone 15 Pro 256GB        │ Smartphones     │
│  2 │ PHONE-IP15-512 │ iPhone 15 Pro 512GB        │ Smartphones     │
│  3 │ PHONE-S24-256  │ Samsung Galaxy S24 256GB   │ Smartphones     │
│  4 │ PHONE-PX8-128  │ Google Pixel 8 128GB       │ Smartphones     │
└────┴────────────────┴────────────────────────────┴─────────────────┘
4 rows
```

**Audio products (headphones, earbuds):**
```
dbsp> products | where categoryId = 6
```
```
┌────┬────────────────┬─────────────────────┬─────────┐
│ id │ sku            │ title               │ brand   │
├────┼────────────────┼─────────────────────┼─────────┤
│  9 │ AUDIO-APP-MAX  │ AirPods Max         │ Apple   │
│ 10 │ AUDIO-APP-PRO2 │ AirPods Pro 2       │ Apple   │
│ 11 │ AUDIO-SONY-XM5 │ Sony WH-1000XM5     │ Sony    │
└────┴────────────────┴─────────────────────┴─────────┘
3 rows
```

### 6.6 Hierarchical Category Structure

> **Note:** The category data demonstrates a 3-level hierarchy:
> - Level 1 (Root): Electronics, Clothing, Home & Garden
> - Level 2: Phones, Computers, Audio (under Electronics)
> - Level 3: Smartphones, Phone Accessories (under Phones)

**Root categories only:**
```
dbsp> categories | where parentId is null
```
```
┌────┬───────────────┬──────────┬────────┐
│ id │ name          │ parentId │ active │
├────┼───────────────┼──────────┼────────┤
│  1 │ Electronics   │ null     │ true   │
│  2 │ Clothing      │ null     │ true   │
│  3 │ Home & Garden │ null     │ true   │
│ 12 │ Legacy Products │ null   │ false  │
└────┴───────────────┴──────────┴────────┘
4 rows
```

**Categories with parent details:**
```
dbsp> categories | where parentId is not null | include parent
```
```
┌────┬───────────────────┬──────────┬─────────────────┐
│ id │ name              │ parentId │ parent.name     │
├────┼───────────────────┼──────────┼─────────────────┤
│  4 │ Phones            │        1 │ Electronics     │
│  5 │ Computers         │        1 │ Electronics     │
│  6 │ Audio             │        1 │ Electronics     │
│  7 │ Smartphones       │        4 │ Phones          │
│  8 │ Phone Accessories │        4 │ Phones          │
│  9 │ Men               │        2 │ Clothing        │
│ 10 │ Women             │        2 │ Clothing        │
└────┴───────────────────┴──────────┴─────────────────┘
8 rows (showing 7)
```

### 6.7 Mutations (INSERT, UPDATE, DELETE, UPSERT)

**Insert a new category:**
```
dbsp> insert into categories set name = "Accessories", slug = "accessories", active = true
```
```
[DRY-RUN] INSERT (add ! to execute)

SQL:
insert into "categories" ("name", "slug", "active") values ($1, $2, $3)

Parameters: ["Accessories", "accessories", true]
```

**Soft delete a product (set deletedAt):**
```
dbsp> update products set deletedAt = "2024-12-01T00:00:00Z" where sku = "OLD-PRODUCT"
```
```
[DRY-RUN] UPDATE (add ! to execute)

SQL:
update "products" set "deleted_at" = $1 where "sku" = $2

Parameters: ["2024-12-01T00:00:00Z", "OLD-PRODUCT"]
```

**Upsert product - insert or update on SKU conflict:**
```
dbsp> upsert into products on sku set title = "New Product", sku = "NEW-SKU-001", categoryId = 1, active = true
```
```
[DRY-RUN] UPSERT (add ! to execute)

SQL:
insert into "products" ("title", "sku", "category_id", "active") values ($1, $2, $3, $4) on conflict ("sku") do update set "title" = $5

Parameters: ["New Product", "NEW-SKU-001", 1, true, "Updated Product"]
```

---

## Chapter 7: CLI Commands Reference

### Generate Commands

```bash
# Generate DDL (create tables)
pnpm dbsp generate ddl --schema ./examples/minimal.schema.ts

# Generate DDL to file
pnpm dbsp generate ddl --schema ./examples/minimal.schema.ts -o schema.sql

# Generate DDL for specific dialect
pnpm dbsp generate ddl --schema ./examples/minimal.schema.ts --dialect mysql

# Generate Kysely types
pnpm dbsp generate kysely --schema ./examples/minimal.schema.ts -o types.ts

# Generate schema manifest (JSON)
pnpm dbsp generate manifest --schema ./examples/minimal.schema.ts -o manifest.json
```

### REPL Commands

```bash
# Start in compile mode (show SQL only)
pnpm dbsp repl --schema ./examples/minimal.schema.ts

# Start in execute mode (run queries)
pnpm dbsp repl --schema ./examples/minimal.schema.ts --db postgresql://... --exec

# Start with specific dialect
pnpm dbsp repl --schema ./examples/minimal.schema.ts --dialect mysql
```

### REPL Built-in Commands

| Command | Description |
|---------|-------------|
| `.tables` | List all tables |
| `.schema <table>` | Show table columns |
| `.relations <table>` | Show table relations |
| `.exec` | Enable execution mode |
| `.compile` | Disable execution mode (show SQL only) |
| `.dump` | Show last query plan |
| `.sql` | Show last SQL only |
| `.explain` | Toggle EXPLAIN output (or `.explain on` / `.explain off`) |
| `.parse` | Toggle parse tree output (or `.parse on` / `.parse off`) |
| `.help` | Show help |
| `.exit` | Exit REPL |

### Batch Execution

```bash
# Run queries from file
pnpm dbsp repl --schema ./examples/minimal.schema.ts --db postgresql://... --exec < queries.dbsp

# Run with assertions
pnpm dbsp repl --schema ./examples/minimal.schema.ts --db postgresql://... --exec < test.assert.dbsp
```

### Mutation Syntax

The REPL supports INSERT, UPDATE, DELETE, and UPSERT operations with a **dry-run by default** safety model.

| Operation | Syntax | Example |
|-----------|--------|---------|
| INSERT | `insert into <table> set <col> = <val>, ...` | `insert into users set name = "Alice", email = "a@e.com"` |
| UPDATE | `update <table> set <col> = <val> where <cond>` | `update users set name = "Bob" where id = 1` |
| DELETE | `delete from <table> where <cond>` | `delete from posts where id = 5` |
| UPSERT | `upsert into <table> on <col> set <col> = <val>, ...` | `upsert into users on email set name = "A", email = "a@e.com"` |

**Key features:**

- **Dry-run default:** Mutations show the SQL without executing. Add `!` suffix to execute.
- **Column validation:** Unknown columns are rejected immediately.
- **Safety guards:** DELETE without WHERE is blocked.
- **Parameterized queries:** All values are bound parameters (SQL injection safe).

**Value types:**

| Type | Syntax | Example |
|------|--------|---------|
| String | `"value"` or `'value'` | `name = "Alice"` |
| Number | `123` or `3.14` | `age = 25` |
| Boolean | `true` / `false` | `active = false` |
| Null | `null` | `deleted_at = null` |
| JSON | `{...}` or `[...]` | `metadata = {"key": "value"}` |

**UPSERT conflict handling:**

```
# Insert or do nothing on conflict
upsert into users on email set name = "A", email = "a@e.com"

# Composite conflict columns
upsert into orders on (user_id, product_id) set ...
```

### Advanced Query Features (NQL v2)

The REPL supports advanced query features for natural language-style querying:

#### Relation Path Traversal

Navigate through relations using dot notation:

```
# Filter by related table column (products → category)
products | where category.name = "Electronics"

# Multi-level path (products → category → parent)
products | where category.parent.name = "Electronics"

# Select related columns
products | select title, category.name as categoryName
```

#### Subqueries

Use subqueries for complex filtering:

```
# Scalar subquery (find products with max price)
products | where price = (products | select max(price))

# IN subquery
users | where id in (orders | where total > 100 | select distinct userId)

# NOT IN subquery
categories | where id not in (products | select categoryId)
```

#### Existence Checks

Check for existence of related records:

```
# Categories with products
categories | where has products

# Categories without products (empty categories)
categories | where not has products

# Users who have made orders
users | where has orders
```

#### INSERT with FK Lookup

Insert data with foreign key lookup from another table:

```
# Insert product with category looked up by name
insert into products set title = "New Phone", categoryId = id from categories | where name = "Smartphones"

# With FOR UPDATE (lock the source row during lookup)
insert into products set title = "New Phone", categoryId = id from categories | where name = "Smartphones" for update
```

#### Window Functions

Compute rankings and running totals:

```
# Rank products by price within category
products | select *, rank() over (partition by categoryId order by price desc) as priceRank

# Running total of order amounts
orders | select *, sum(total) over (order by createdAt) as runningTotal
```

#### Parse Tree Debug

Enable parse tree output to see how queries are interpreted:

```
dbsp> .parse on
✓ Parse mode: ON - Queries will show parse tree (AST)

dbsp> users | where active = true
──────────────────────────────────────────────────
ParsedQuery {
  table: "users"
  type: "select"
  columns: undefined
  where: [{ column: "active", operator: "=", value: true }]
}
──────────────────────────────────────────────────

SQL:
select "users".* from "users" where "users"."active" = $1
```

#### Real-World Example: Products with Customer Names

This example shows how to traverse multiple relations in a single query using the e-commerce schema (Chapter 5):

**Question:** "Show products in the Electronics category with customer names who ordered them"

**Key insight:** In our hierarchical category structure, products are in leaf categories (e.g., Laptops), not directly in "Electronics". The path is:
- `Electronics` (id=1) → `Computers` (id=4) → `Laptops` (id=11) → Products

So we need a 3-level path: `category.parent.parent.name = 'Electronics'`

```
dbsp> .use ch5_ecommerce
✓ Schema set to: ch5_ecommerce

dbsp> orderItems | select product.name, order.customer.firstName, order.customer.lastName | where product.category.parent.parent.name = 'Electronics' | limit 5
```

**Result:**

```
 product_name    | order_customer_first_name | order_customer_last_name
-----------------+---------------------------+--------------------------
 ProBook 15      | Alice                     | Johnson
 UltraLight 13   | Carol                     | Williams
 SmartPhone X    | Emma                      | Davis
 SmartPhone SE   | Bob                       | Smith
 NoiseCancel Pro | Bob                       | Smith
```

**SQL Generated:**

```sql
SELECT
  "product"."name" AS "product_name",
  "order_customer"."first_name" AS "order_customer_first_name",
  "order_customer"."last_name" AS "order_customer_last_name"
FROM "ch5_ecommerce"."order_items" AS "orderItems"
LEFT JOIN "ch5_ecommerce"."products" AS "product" ON "orderItems"."product_id" = "product"."id"
LEFT JOIN "ch5_ecommerce"."categories" AS "product_category" ON "product"."category_id" = "product_category"."id"
LEFT JOIN "ch5_ecommerce"."categories" AS "product_category_parent" ON "product_category"."parent_id" = "product_category_parent"."id"
LEFT JOIN "ch5_ecommerce"."categories" AS "product_category_parent_parent" ON "product_category_parent"."parent_id" = "product_category_parent_parent"."id"
LEFT JOIN "ch5_ecommerce"."orders" AS "order" ON "orderItems"."order_id" = "order"."id"
LEFT JOIN "ch5_ecommerce"."customers" AS "order_customer" ON "order"."customer_id" = "order_customer"."id"
WHERE "product_category_parent_parent"."name" = $1
LIMIT $2
```

This query demonstrates:
- **Multi-level path traversal**: `product.category.parent.parent.name` (4 levels!)
- **Cross-relation column selection**: `order.customer.firstName` (selecting through two relations)
- **Automatic LEFT JOINs**: NQL handles all the joins transparently
- **Schema scoping**: The `.use` command prefixes all tables with the schema

---

## Cleanup

When done experimenting:

```bash
# Stop and remove PostgreSQL container
docker stop pg-demo
docker rm pg-demo
```

---

## Next Steps

- Explore the [API Reference](../docs/API.md) for programmatic usage
- Check [Examples](./README.md) for more complex scenarios
- Read about [Multi-tenant Support](../docs/MULTI_TENANT.md) for schema isolation
